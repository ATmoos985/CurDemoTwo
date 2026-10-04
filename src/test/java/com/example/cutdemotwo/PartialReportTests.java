package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.persistence.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class PartialReportTests {
    @TempDir Path temp;
    RemnantService inventory; CuttingWorkflowService workflow; CuttingTask task; SolveResponse plan;
    @BeforeEach void setup() {
        inventory=new RemnantService(temp.resolve("stock.json").toString());workflow=workflow(inventory);
        task=inventory.saveTask(new CuttingTask(null,"部分报工","TC涤棉-B2026","",0,List.of(
                new CuttingTask.Line(1,"主帘",2000,1000,4,false),new CuttingTask.Line(9,"同尺寸独立行",2000,1000,1,false))));
        plan=workflow.solve(request(task,5000));assertEquals(4,plan.getPieces().size());
    }
    CuttingWorkflowService workflow(RemnantService s){return new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),s);}
    SolveRequest request(CuttingTask t,double start){var r=new SolveRequest();r.setTaskId(t.id());r.setTaskRevision(t.revision());
        r.setAllowLongitudinal(false);r.setRollL(4000);r.setWindowStartY(start);
        r.setDemands(List.of(new PieceDemand(1,"主帘",2000,1000,3,false),new PieceDemand(9,"同尺寸独立行",2000,1000,1,false)));return r;}
    List<CutReport.PieceResult> results(){return List.of(new CutReport.PieceResult(1,"QUALIFIED",""),new CutReport.PieceResult(2,"REJECTED","实切破损"),
            new CutReport.PieceResult(3,"UNCUT",""),new CutReport.PieceResult(4,"UNCUT",""));}
    CutReport report(){return new CutReport(plan.getPlanId(),2500.5,1,List.of(new RemnantPiece("UNCUT-3","未切毛料",0,2000,2000,500.5,1.001,false)),"B-01",results());}

    @Test void qualifiedRejectedAndUncutAreRecordedSeparatelyAndRestoreAfterRestart(){
        var receipt=workflow.confirm(report());assertEquals(1,receipt.get("finishedPieceCount"));assertEquals(1,receipt.get("rejectedPieceCount"));assertEquals(2,receipt.get("uncutPieceCount"));
        assertEquals(Map.of("1",1),inventory.completedQuantities(task.id()));assertEquals(52499.5,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(2.0,receipt.get("pieceArea"));assertEquals(2.0,receipt.get("rejectedArea"));assertEquals(1.001,receipt.get("remArea"));
        assertEquals(2.0,((Number)receipt.get("wasteArea")).doubleValue(),1e-9);
        var child=(RemnantStock)((List<?>)receipt.get("derivedRemnants")).get(0);assertEquals(500.5,child.getLength());
        assertEquals(4,((List<?>)receipt.get("pieceResults")).size());assertEquals(1,((List<?>)receipt.get("recoveredGeometry")).size());
        var reopened=new RemnantService(temp.resolve("stock.json").toString());
        var saved=reopened.getReceipt(plan.getPlanId());assertEquals(4,((List<?>)saved.get("pieceResults")).size());
        assertEquals(saved,workflow(reopened).confirm(report()));assertEquals(Map.of("1",1),reopened.completedQuantities(task.id()));
        assertEquals("CONFIRMED",reopened.getPlan(plan.getPlanId()).status());
    }
    @Test void zeroQualifiedCanReportRejectedOutputWithoutCompletingDemand(){
        var rows=plan.getPieces().stream().map(p->new CutReport.PieceResult(p.getId(),"REJECTED","疵点复检不合格")).toList();
        var receipt=workflow.confirm(new CutReport(plan.getPlanId(),4000,0,List.of(),"A",rows));
        assertEquals(0.0,receipt.get("utilization"));assertEquals(8.0,receipt.get("wasteArea"));assertTrue(inventory.completedQuantities(task.id()).isEmpty());
    }
    @Test void incompleteForeignDuplicateAndUnexplainedResultsAreRejectedBeforeStockChanges(){
        var invalid=new ArrayList<List<CutReport.PieceResult>>();invalid.add(results().subList(0,3));
        for(var replacement:List.of(new CutReport.PieceResult(88,"UNCUT",""),new CutReport.PieceResult(1,"UNCUT",""),
                new CutReport.PieceResult(2,"UNKNOWN",""),new CutReport.PieceResult(2,"REJECTED",""))){var rows=new ArrayList<>(results());rows.set(1,replacement);invalid.add(rows);}
        for(var rows:invalid)assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(plan.getPlanId(),2500.5,1,List.of(),"A",rows)));
        assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(plan.getPlanId(),2500.5,2,List.of(),"A",results())));
        assertEquals(55000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());assertNull(inventory.getReceipt(plan.getPlanId()));
    }
    @Test void lengthMustCoverRejectedPiecesAndRecoveryCannotInventOrOverlapCutPieces(){
        assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(plan.getPlanId(),1500,1,List.of(),"A",results())));
        for(var rem:List.of(new RemnantPiece("UNCUT-2","",0,1000,2000,1000,2,false),new RemnantPiece("UNCUT-3","",0,2000,2000,506,1,false),
                new RemnantPiece("UNCUT-4","",0,3000,2000,1000,2,false)))
            assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(plan.getPlanId(),2500.5,1,List.of(rem),"A",results())));
        assertTrue(inventory.completedQuantities(task.id()).isEmpty());assertEquals("PENDING",inventory.getPlan(plan.getPlanId()).status());
    }
    @Test void partialOutputChecksCurrentRemainingQuantityInsteadOfTheOldRequestedTotal(){
        var competing=workflow.solve(request(task,10000));
        var rows=List.of(new CutReport.PieceResult(1,"QUALIFIED",""),new CutReport.PieceResult(2,"QUALIFIED",""),new CutReport.PieceResult(3,"UNCUT",""),new CutReport.PieceResult(4,"UNCUT",""));
        workflow.confirm(new CutReport(plan.getPlanId(),2000,2,List.of(),"A",rows));
        var excess=new ArrayList<>(rows);excess.set(2,new CutReport.PieceResult(3,"QUALIFIED",""));
        assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(competing.getPlanId(),3000,3,List.of(),"A",excess)));
        var receipt=workflow.confirm(new CutReport(competing.getPlanId(),2000,2,List.of(),"A",rows));
        assertEquals(2,receipt.get("finishedPieceCount"));assertEquals(Map.of("1",4),inventory.completedQuantities(task.id()));
    }
    @Test void staleRevisionStillRejectsPartialReport(){
        inventory.saveTask(new CuttingTask(task.id(),task.name(),task.materialModel(),"updated",task.revision(),task.demands()));
        assertThrows(IllegalArgumentException.class,()->workflow.confirm(report()));assertNull(inventory.getReceipt(plan.getPlanId()));
    }
    @Test void failedWriteRestoresAllStockDemandPlanAndReceiptState(){
        var file=new FileInventoryStore(temp.resolve("stock.json").toString());
        var failing=new RemnantService(new InventoryStore(){public InventorySnapshot load(){return file.load();}public long save(InventorySnapshot s){throw new IllegalStateException("write failed");}},false);
        int count=failing.getAvailableRemnants().size();
        assertThrows(IllegalStateException.class,()->workflow(failing).confirm(report()));
        assertEquals(55000,failing.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());assertEquals(count,failing.getAvailableRemnants().size());
        assertEquals("PENDING",failing.getPlan(plan.getPlanId()).status());assertNull(failing.getReceipt(plan.getPlanId()));assertTrue(failing.completedQuantities(task.id()).isEmpty());
        assertDoesNotThrow(()->workflow.confirm(report()));
    }
    @Test void partialRemnantReportReversesTheParentAndItsRawRecovery(){
        var r=request(task,0);r.setFeedPortType("remnant");r.setSourceRemnantId("REM-202609-001");r.setRollL(1600);
        var sheet=workflow.solve(r);assertEquals(1,sheet.getPieces().size());
        var receipt=workflow.confirm(new CutReport(sheet.getPlanId(),0,0,List.of(new RemnantPiece("UNCUT-1","毛料",0,0,2000,1000,2,false)),"B",List.of(new CutReport.PieceResult(1,"UNCUT",""))));
        assertNull(inventory.scanOrGetById("REM-202609-001"));assertEquals(0,receipt.get("finishedPieceCount"));
        inventory.reverseReport(sheet.getPlanId(),"尚未实际切割");assertNotNull(inventory.scanOrGetById("REM-202609-001"));assertTrue(inventory.completedQuantities(task.id()).isEmpty());
    }
    @Test void recoveredUncutStockMustBeUnwoundBeforeReversingTheSourceReport(){
        var receipt=workflow.confirm(report());var child=(RemnantStock)((List<?>)receipt.get("derivedRemnants")).get(0);
        var t=inventory.saveTask(new CuttingTask(null,"毛料复用",task.materialModel(),"",0,List.of(new CuttingTask.Line(1,"短片",2000,500,1,false))));
        var r=new SolveRequest();r.setTaskId(t.id());r.setTaskRevision(t.revision());r.setFeedPortType("remnant");r.setSourceRemnantId(child.getId());
        r.setAllowLongitudinal(false);r.setRollW(2000);r.setRollL(500.5);r.setDemands(List.of(new PieceDemand(1,"短片",2000,500,1,false)));
        var reuse=workflow.solve(r);workflow.confirm(new CutReport(reuse.getPlanId(),0,1,List.of(),"A"));
        assertThrows(IllegalArgumentException.class,()->inventory.reverseReport(plan.getPlanId(),"误报"));
        inventory.reverseReport(reuse.getPlanId(),"撤回后续");inventory.reverseReport(plan.getPlanId(),"撤回原报工");
        assertTrue(inventory.completedQuantities(task.id()).isEmpty());assertNull(inventory.scanOrGetById(child.getId()));
        assertEquals(55000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals("REVERSED",inventory.reverseReport(plan.getPlanId(),"重试").get("status"));
    }
}
