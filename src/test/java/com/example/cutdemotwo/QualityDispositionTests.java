package com.example.cutdemotwo;

import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.business.cutting.*;
import com.example.cutdemotwo.algorithm.nesting.*;
import com.example.cutdemotwo.controller.FabricCutController;
import com.example.cutdemotwo.persistence.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class QualityDispositionTests {
    @TempDir Path temp;
    RemnantService inventory; CuttingTask task; String planId;
    final tools.jackson.databind.ObjectMapper json = new tools.jackson.databind.ObjectMapper();
    @BeforeEach void setup() {
        inventory = new RemnantService(temp.resolve("stock.json").toString());
        task = inventory.saveTask(new CuttingTask(null,"复检验收","TC涤棉-B2026","",0,
                List.of(new CuttingTask.Line(1,"裁片",2000,1000,10,false))));
        var request = new SolveRequest(); request.setTaskId(task.id()); request.setTaskRevision(task.revision());
        request.setAllowLongitudinal(false); request.setRollL(10000); request.setWindowStartY(5000);
        request.setDemands(List.of(new PieceDemand(1,"裁片",2000,1000,10,false)));
        var workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory, new com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService());
        var result = workflow.solve(request); planId = result.getPlanId(); assertEquals(10,result.getPieces().size());
        workflow.confirm(new CutReport(planId,10000,10,List.of(),"A"));
    }
    QualityDisposition.Command command(int piece, int revision, boolean recover) {
        return new QualityDisposition.Command(UUID.randomUUID().toString(),revision,piece,recover?"REMNANT":"SCRAP","复检发现破损","检验员甲",
                recover ? new QualityDisposition.Recovery(100,100,500,500,"B-01","RECOVERABLE") : null);
    }
    @Test void tenGoodBecomeEightWithOneRemnantOneScrapAndNoChangeInConsumedMaterial() {
        var before = inventory.getReceipt(planId);
        String original = json.writeValueAsString(before.get("pieceResults"));
        double consumed = inventory.getMotherRoll("ROLL-2026-0920").getUsedLength();
        var recovery = inventory.disposeQuality(planId,command(1,0,true));
        inventory.disposeQuality(planId,command(2,1,false));
        var after = inventory.getReceipt(planId);
        assertEquals(10,after.get("finishedPieceCount")); assertEquals(8,after.get("netFinishedPieceCount"));
        assertEquals(Map.of("1",10),after.get("demandQuantities")); assertEquals(Map.of("1",8),inventory.completedQuantities(task.id()));
        assertEquals(2,inventory.taskSummaries().get(0).get("remaining"));
        assertEquals(original,json.writeValueAsString(after.get("pieceResults")));
        assertEquals(consumed,inventory.getMotherRoll("ROLL-2026-0920").getUsedLength());
        assertEquals(16.0,after.get("netPieceArea"));assertEquals(.25,after.get("netRemArea"));assertEquals(3.75,after.get("netWasteArea"));assertEquals(80.0,after.get("netUtilization"));
        var stock = inventory.scanOrGetById(recovery.remnantId());assertNotNull(stock);
        assertEquals(planId,stock.getSourceReportId());assertEquals(1,stock.getSourcePieceId());assertEquals(recovery.id(),stock.getQualityDispositionId());
        assertEquals(250000,recovery.recoveredAreaMm2());assertEquals(1750000,recovery.scrapAreaMm2());
        assertThrows(IllegalArgumentException.class,()->inventory.reverseReport(planId,"不能恢复已裁原卷"));
        assertThrows(IllegalArgumentException.class,()->inventory.resetRoll("ROLL-2026-0920",true));
        var reopened = new RemnantService(temp.resolve("stock.json").toString());
        assertEquals(Map.of("1",8),reopened.completedQuantities(task.id()));assertEquals(2,reopened.qualityReview(planId).get("qualityRevision"));
    }
    @Test void idempotentRetrySurvivesRestartAndRejectsChangedKeyDuplicatePieceAndStaleRevision() {
        var cmd = command(1,0,true); var event = inventory.disposeQuality(planId,cmd);
        inventory = new RemnantService(temp.resolve("stock.json").toString());
        int count = inventory.getAvailableRemnants().size();
        assertEquals(event,inventory.disposeQuality(planId,cmd));assertEquals(count,inventory.getAvailableRemnants().size());
        assertThrows(InventoryConflictException.class,()->inventory.disposeQuality(planId,new QualityDisposition.Command(cmd.operationId(),1,2,"SCRAP","别的内容","乙",null)));
        assertThrows(InventoryConflictException.class,()->inventory.disposeQuality(planId,command(1,1,false)));
        assertThrows(InventoryConflictException.class,()->inventory.disposeQuality(planId,command(2,0,false)));
        assertEquals(Map.of("1",9),inventory.completedQuantities(task.id()));
    }
    @Test void invalidRequestAndReversedReportNeverCreateStock() {
        assertThrows(IllegalArgumentException.class,()->inventory.disposeQuality(planId,command(999,0,true)));
        var c=command(1,0,true);
        assertThrows(IllegalArgumentException.class,()->inventory.disposeQuality(planId,new QualityDisposition.Command(c.operationId(),0,1,"REMNANT","原因","甲",new QualityDisposition.Recovery(1900,0,500,500,"B","RECOVERABLE"))));
        assertEquals(0,inventory.qualityReview(planId).get("qualityRevision"));
        inventory.reverseReport(planId,"误报");assertThrows(IllegalArgumentException.class,()->inventory.disposeQuality(planId,c));
    }
    @Test void writeFailureRollsBackQualityStockAndFulfillmentTogether() {
        var file = new FileInventoryStore(temp.resolve("stock.json").toString());
        var failing = new RemnantService(new InventoryStore() {
            public InventorySnapshot load(){return file.load();}
            public long save(InventorySnapshot s){throw new IllegalStateException("disk full");}
        },false);
        int count=failing.getAvailableRemnants().size();
        assertThrows(IllegalStateException.class,()->failing.disposeQuality(planId,command(1,0,true)));
        assertEquals(count,failing.getAvailableRemnants().size());assertEquals(Map.of("1",10),failing.completedQuantities(task.id()));
        assertEquals(0,failing.qualityReview(planId).get("qualityRevision"));
        assertEquals(0,new RemnantService(temp.resolve("stock.json").toString()).qualityReview(planId).get("qualityRevision"));
    }
    @Test void quarantinedRecoveryHasLineageButCannotBeSelected() {
        var c=command(1,0,true);var event=inventory.disposeQuality(planId,new QualityDisposition.Command(c.operationId(),0,1,"REMNANT","待检","甲",new QualityDisposition.Recovery(0,0,500,500,"隔离区","QUARANTINED")));
        assertNull(inventory.scanOrGetById(event.remnantId()));
        var stock=inventory.getAllRemnants().stream().filter(r->r.getId().equals(event.remnantId())).findFirst().orElseThrow();
        assertEquals("QUARANTINED",stock.getStatus());assertEquals(planId,stock.getSourceReportId());
    }
    @Test void controllerRejectsUnknownMissingFractionalAndCoercedFields() {
        var controller=new FabricCutController(null,null,inventory,null,null);
        String valid=json.writeValueAsString(command(1,0,false));
        for(String invalid:List.of(valid.replace("\"pieceId\":1","\"pieceId\":1.5"),valid.replace("\"expectedRevision\":0,",""),valid.replace("\"pieceId\":1","\"pieceId\":\"1\""),valid.replace("\"pieceId\":1","\"pieceId\":null"),valid.replace("\"recovery\":null","\"recovery\":null,\"unknown\":true"),valid+" {}"))
            assertThrows(IllegalArgumentException.class,()->controller.disposeQuality(planId,invalid),invalid);
        assertEquals(0,inventory.qualityReview(planId).get("qualityRevision"));
        assertNotNull(controller.disposeQuality(planId,valid));
    }
    @Test void alreadyRejectedPieceRecoveryDoesNotSubtractGoodQuantityTwice() {
        inventory.reverseReport(planId,"建立另一份逐件记录");
        var request=inventory.getPlan(planId).request();
        var workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory, new com.example.cutdemotwo.algorithm.toolpath.ToolpathOptimizerService());
        var result=workflow.solve(request);planId=result.getPlanId();
        var rows=result.getPieces().stream().map(p->new CutReport.PieceResult(p.getId(),p.getId()==1?"REJECTED":"QUALIFIED",p.getId()==1?"破损":"")).toList();
        workflow.confirm(new CutReport(planId,10000,9,List.of(),"A",rows));
        inventory.disposeQuality(planId,command(1,0,true));
        assertEquals(Map.of("1",9),inventory.completedQuantities(task.id()));
        var view=inventory.getReceipt(planId);assertEquals(9,view.get("netFinishedPieceCount"));assertEquals(1.75,view.get("netWasteArea"));assertEquals(.25,view.get("netRemArea"));
    }
}
