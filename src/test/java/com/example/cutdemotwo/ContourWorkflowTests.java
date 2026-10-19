package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ContourWorkflowTests {
    @TempDir Path temp;
    static final NestingProblem.Shape SHAPE = new NestingProblem.Shape("POLYGON",200,200,List.of(
            new NestingProblem.Point(0,0),new NestingProblem.Point(200,0),new NestingProblem.Point(0,200)));
    final ICutSolverEngine engine = new ICutSolverEngine() {
        public String getEngineType(){return "packingsolver-irregular";}
        public boolean isAvailable(){return true;}
        public EngineCapabilities capabilities(){return new EngineCapabilities(getEngineType(),"1",List.of("RECTANGLE","POLYGON"),List.of("CONTOUR"),List.of("MAXIMIZE_PIECE_AREA"),.1,true);}
        public EngineResult solve(NestingProblem p){
            var result=new EngineResult();result.setSuccess(true);
            if(p.height()>=220)for(var d:p.parts())for(int i=0;i<d.quantity();i++)
                result.getPlacements().add(new NestingResult.Placement(i+1,d.id(),d.name(),10+i*220,20,d.shape(),0));
            return result;
        }
    };
    SolverFactory factory(){return new SolverFactory(List.of(engine));}
    SolveRequest request(){
        var request=new SolveRequest();request.setRollL(500);request.setWindowStartY(5000);request.setPieceGap(5);
        var d=new PieceDemand(1,"衣片 M",200,200,2,false);d.setShape(SHAPE);request.setDemands(List.of(d));return request;
    }
    CuttingTask task(RemnantService inventory){return inventory.saveTask(new CuttingTask(null,"服装任务","TC涤棉-B2026","",0,
            List.of(new CuttingTask.Line(1,"衣片 M",200,200,2,false,SHAPE))));}
    SolveRequest request(CuttingTask t){var r=request();r.setTaskId(t.id());r.setTaskRevision(t.revision());return r;}

    @Test void completeContoursBecomeSavedCutsAndReportNetAreaSurvivesReload(){
        var file=temp.resolve("inventory.json");var inventory=new RemnantService(file.toString());
        var workflow=new CuttingWorkflowService(factory(),inventory);var task=task(inventory);
        double before=inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        var result=workflow.solve(request(task));
        assertTrue(result.isSuccess());assertNotNull(result.getPlanId());assertEquals(2,result.getPieces().size());
        assertEquals(6,result.getCuts().size());assertEquals(.04,result.getPieceArea(),1e-9);
        assertEquals(220,result.getDeductLen());assertTrue(result.getRemnants().isEmpty());
        for(int i=0;i<6;i+=3){var first=result.getCuts().get(i);var last=result.getCuts().get(i+2);
            assertEquals(first.getStartX(),last.getEndX());assertEquals(first.getStartY(),last.getEndY());}
        assertEquals(before,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertTrue(inventory.completedQuantities(task.id()).isEmpty());
        var report=new CutReport(result.getPlanId(),220,2,List.of(),"A");
        var receipt=workflow.confirm(report);assertEquals(.04,(double)receipt.get("pieceArea"),1e-9);
        assertEquals(receipt,workflow.confirm(report));
        var restored=new RemnantService(file.toString());
        assertEquals(SHAPE,restored.listTasks().get(0).demands().get(0).shape());
        assertEquals(SHAPE,restored.getPlan(result.getPlanId()).result().getPieces().get(0).getShape());
        assertEquals(2,restored.completedQuantities(task.id()).get("1"));
        assertEquals(before-220,restored.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertTrue(restored.getReceipt(result.getPlanId()).get("pieceResults").toString().contains("POLYGON"));
    }
    @Test void insufficientRegionCannotSaveOrReportAPartialMarker(){
        var inventory=new RemnantService(temp.resolve("partial.json").toString());var workflow=new CuttingWorkflowService(factory(),inventory);
        var r=request(task(inventory));r.setRollL(100);var result=workflow.solve(r);
        assertFalse(result.isSuccess());assertNull(result.getPlanId());assertTrue(result.getPieces().isEmpty());
    }
    @Test void savedTaskCannotLoseOrChangeItsContour(){
        var inventory=new RemnantService(temp.resolve("identity.json").toString());var t=task(inventory);var r=request(t);
        r.getDemands().get(0).setShape(null);assertThrows(IllegalArgumentException.class,()->inventory.prepareTaskSolve(r));
        var invalid=new NestingProblem.Shape("POLYGON",200,200,List.of(new NestingProblem.Point(0,0),new NestingProblem.Point(200,200),new NestingProblem.Point(0,200),new NestingProblem.Point(200,0)));
        assertThrows(IllegalArgumentException.class,()->inventory.saveTask(new CuttingTask(null,"无效","TC涤棉-B2026","",0,List.of(new CuttingTask.Line(1,"衣片",200,200,1,false,invalid)))));
    }
    @Test void manualMovesKeepContoursAndRejectOverlapGrainViolationAndMissingParts(){
        var r=request();var result=FabricSolveAdapter.solve(factory(),r);
        var pieces=result.getPieces();pieces.get(0).setY(30);
        assertTrue(FabricSolveAdapter.adjust(factory(),r,pieces).isSuccess());
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces.subList(0,1)));
        pieces.get(0).setX(pieces.get(1).getX());pieces.get(0).setY(pieces.get(1).getY());
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces));
        pieces.get(0).setX(10);pieces.get(0).setRotationDegrees(90);pieces.get(0).setShape(PolygonGeometry.rotate(SHAPE,90));
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces));
    }
    @Test void savedAdjustmentsPreserveHalfTurnsAndRejectInconsistentRotation(){
        var inventory=new RemnantService(temp.resolve("rotation.json").toString());
        var workflow=new CuttingWorkflowService(factory(),inventory);
        var t=inventory.saveTask(new CuttingTask(null,"可旋转衣片","TC涤棉-B2026","",0,
                List.of(new CuttingTask.Line(1,"衣片 M",200,200,2,true,SHAPE))));
        var r=request(t);r.getDemands().get(0).setAllowRotation(true);
        var result=workflow.solve(r);
        var positions=result.getPieces().stream().map(p->new PlanAdjustment.Position(p.getId(),p.getX(),p.getY(),false,180)).toList();
        var changed=workflow.adjust(result.getPlanId(),new PlanAdjustment("rotation-adjustment-180",positions,null));
        assertEquals(180,changed.result().getPieces().get(0).getRotationDegrees());
        assertEquals(PolygonGeometry.rotate(SHAPE,180),changed.result().getPieces().get(0).getShape());
        var bad=List.of(new PlanAdjustment.Position(1,10.0,20.0,false,90));
        assertThrows(IllegalArgumentException.class,()->workflow.adjust(changed.id(),new PlanAdjustment("rotation-adjustment-bad",bad,null)));
    }
    @Test void contourGapAndDefectsUseRealGeometry(){
        var r=request();var pieces=FabricSolveAdapter.solve(factory(),r).getPieces();
        pieces.get(1).setX(211); // 1 mm between nearest vertices, required 5 mm.
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces));
        pieces.get(1).setX(230);r.setDefects(List.of(new Defect(1,10,20,20,20,0)));
        assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces));
    }
    @Test void toolpathAdjustmentPreservesEveryObliqueEdge(){
        var cuts=FabricSolveAdapter.solve(factory(),request()).getCuts();
        var optimizer=new com.example.cutdemotwo.service.toolpath.ToolpathOptimizerService();
        var result=optimizer.optimizeAndChain(cuts,0,0,true);
        assertEquals(cuts.size(),optimizer.validateReorderedCuts(cuts,result,0,0,true).size());
        assertThrows(IllegalArgumentException.class,()->optimizer.validateReorderedCuts(cuts,result.subList(0,5),0,0,true));
    }
}
