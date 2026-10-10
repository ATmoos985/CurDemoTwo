package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ManualPlanAdjustmentTests {
    @TempDir Path temp;
    private NestingProblem problem(boolean longitudinal, List<PieceDemand> demands, List<Defect> defects) {
        SolveRequest r = new SolveRequest(); r.setRollW(2000); r.setRollL(3000); r.setAllowLongitudinal(longitudinal);
        r.setDemands(demands); r.setDefects(defects); r.setFirstStageOrientation("horizontal");
        return FabricSolveAdapter.toProblem(r);
    }
    private NestingProblem rectangle() { return problem(true,List.of(new PieceDemand(7,"矩形",800,1000,2,true)),List.of()); }

    @Test void keepsFractionalPlacementAndBuildsNonOverlappingRecoveredRegions() {
        var pieces = List.of(new PlacedPiece(1,"矩形",0,0,800,1000,false,7),new PlacedPiece(2,"矩形",1100.1,1300.2,800,1000,false,7));
        var result = ManualLayoutValidator.validate(rectangle(),pieces);
        assertEquals(1100.1,result.getPieces().get(1).getX()); assertEquals(1300.2,result.getPieces().get(1).getY());
        assertFalse(result.getCuts().isEmpty());
        assertTrue(result.getSuggestedFeedLength() >= 2300.2);
        // Every cut is a complete partition of an existing rectangular region, never through a part.
        var regions = new ArrayList<double[]>(); regions.add(new double[]{0,0,2000,3000});
        for (var cut : result.getCuts()) {
            boolean h = "横切".equals(cut.getType());
            int index = -1;
            for (int i=0;i<regions.size();i++) {
                var r=regions.get(i); double start=h?r[0]:r[1], end=start+(h?r[2]:r[3]), a=h?r[1]:r[0], b=a+(h?r[3]:r[2]);
                if (Math.abs(start-cut.getStart())<.001 && Math.abs(end-cut.getEnd())<.001 && cut.getPos()>a+.001 && cut.getPos()<b-.001) {index=i;break;}
            }
            assertTrue(index>=0,"cut must span one parent region"); var r=regions.remove(index); double pos=cut.getPos();
            regions.add(h?new double[]{r[0],r[1],r[2],pos-r[1]}:new double[]{r[0],r[1],pos-r[0],r[3]});
            regions.add(h?new double[]{r[0],pos,r[2],r[1]+r[3]-pos}:new double[]{pos,r[1],r[0]+r[2]-pos,r[3]});
        }
    }
    @Test void rejectsOverlapBoundsDefectsPrecisionAndForbiddenRotation() {
        var p=rectangle();
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(p,List.of(new PlacedPiece(1,"",0,0,800,1000,false,7),new PlacedPiece(2,"",10,10,800,1000,false,7))));
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(p,List.of(new PlacedPiece(1,"",1300,0,800,1000,false,7))));
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(p,List.of(new PlacedPiece(1,"",.01,0,800,1000,false,7))));
        var blocked=problem(true,List.of(new PieceDemand(7,"",800,1000,1,false)),List.of(new Defect(1,790,500,30,30,20)));
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(blocked,List.of(new PlacedPiece(1,"",0,0,800,1000,false,7))));
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(blocked,List.of(new PlacedPiece(1,"",0,1000,1000,800,true,7))));
    }
    @Test void allowsPermittedRotationButNeverResizesPartsOrAddsDemand() {
        var result=ManualLayoutValidator.validate(rectangle(),List.of(new PlacedPiece(1,"",0,0,1000,800,true,7)));
        assertEquals(1000,result.getPieces().get(0).getW());
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(rectangle(),List.of(new PlacedPiece(1,"",0,0,900,800,true,7))));
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(rectangle(),List.of(new PlacedPiece(1,"",0,0,800,1000,false,99))));
    }
    @Test void refusesNonGuillotinePinwheelEvenWithoutOverlap() {
        var shapes=List.of(new PieceDemand(1,"上",1200,800,1,false),new PieceDemand(2,"右",800,1200,1,false),
                new PieceDemand(3,"下",1200,800,1,false),new PieceDemand(4,"左",800,1200,1,false),new PieceDemand(5,"中",400,400,1,false));
        var p=problem(true,shapes,List.of());
        var pieces=List.of(new PlacedPiece(1,"",0,0,1200,800,false,1),new PlacedPiece(2,"",1200,0,800,1200,false,2),
                new PlacedPiece(3,"",800,1200,1200,800,false,3),new PlacedPiece(4,"",0,800,800,1200,false,4),new PlacedPiece(5,"",800,800,400,400,false,5));
        assertTrue(assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(p,pieces)).getMessage().contains("贯通"));
    }
    @Test void crosscutKeepsWholeWidthTailOnRollAndRespectsTrim() {
        var p=problem(false,List.of(new PieceDemand(1,"",2000,1000,1,false)),List.of());
        var result=ManualLayoutValidator.validate(p,List.of(new PlacedPiece(1,"",0,400,2000,1000,false,1)));
        assertEquals(1400,result.getSuggestedFeedLength());
        assertTrue(result.getCuts().stream().allMatch(c->c.getType().equals("横切")));
        assertTrue(result.getRemnants().stream().allMatch(r->r.getY()+r.getL()<=1400));
        var trimmed=new NestingProblem(p.schemaVersion(),p.unit(),p.material(),p.parts(),new NestingProblem.Process("CROSSCUT","CONTINUOUS","right-bottom","horizontal",500,200,300,0,"INPUT_ORDER"),p.engine(),p.timeLimitSeconds());
        assertThrows(IllegalArgumentException.class,()->ManualLayoutValidator.validate(trimmed,List.of(new PlacedPiece(1,"",0,400,2000,1000,false,1))));
    }
    private SolveRequest request() {
        SolveRequest r=new SolveRequest();r.setRollW(2000);r.setRollL(3000);r.setAllowLongitudinal(false);
        r.setDemands(List.of(new PieceDemand(1,"主帘",2000,1000,2,false)));return r;
    }
    private PlanAdjustment adjustment(SolveResponse result) {
        return new PlanAdjustment(UUID.randomUUID().toString(),result.getPieces().stream()
                .map(p->new PlanAdjustment.Position(p.getId(),p.getX(),p.getY()+200,p.isRotated())).toList());
    }
    @Test void adjustmentIsAtomicIdempotentVersionedAndReportUsesTheNewLayout() {
        Path file=temp.resolve("plans.json");var inventory=new RemnantService(file.toString());
        var workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory);
        double stock=inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        var original=workflow.solve(request());var input=adjustment(original);
        var changed=workflow.adjust(original.getPlanId(),input);
        assertEquals(2,changed.version());assertEquals(original.getPlanId(),changed.parentPlanId());
        assertEquals("CANCELLED",inventory.getPlan(original.getPlanId()).status());
        assertEquals(stock,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(changed.id(),workflow.adjust(original.getPlanId(),input).id());
        assertThrows(IllegalArgumentException.class,()->workflow.confirm(new CutReport(original.getPlanId(),2200,2,List.of(),"A")));
        var reopened=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),new RemnantService(file.toString()));
        assertEquals(2,reopened.getPlan(changed.id()).get("version"));
        var receipt=reopened.confirm(new CutReport(changed.id(),2200,2,changed.result().getRemnants(),"A"));
        assertEquals(2,receipt.get("finishedPieceCount"));
        assertEquals(receipt,reopened.confirm(new CutReport(changed.id(),2200,2,List.of(),"A")));
    }
    @Test void rejectedAdjustmentLeavesOriginalPlanAndStockUnchanged() {
        var inventory=new RemnantService(temp.resolve("reject.json").toString());
        var workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory);
        var original=workflow.solve(request());
        var bad=new PlanAdjustment(UUID.randomUUID().toString(),List.of(new PlanAdjustment.Position(999,0.0,0.0,false)));
        assertThrows(IllegalArgumentException.class,()->workflow.adjust(original.getPlanId(),bad));
        assertEquals("PENDING",inventory.getPlan(original.getPlanId()).status());
        inventory.addDefectToRoll("ROLL-2026-0920",new Defect(99,10,10,10,10,0));
        assertThrows(IllegalArgumentException.class,()->workflow.adjust(original.getPlanId(),adjustment(original)));
        assertEquals("PENDING",inventory.getPlan(original.getPlanId()).status());
    }

    @Test void toolpathOnlyVersionSurvivesReloadAndRestoreWithoutChangingLayoutOrStock() {
        Path file=temp.resolve("toolpaths.json");var inventory=new RemnantService(file.toString());
        var workflow=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),inventory);
        var original=workflow.solve(request());
        var json=tools.jackson.databind.json.JsonMapper.builder().build();
        String baseline=json.writeValueAsString(original);
        double stock=inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        var reversed=original.getCuts().stream().map(c->{
            var copy=json.convertValue(c,CutStep.class);copy.setStartX(c.getEndX());copy.setStartY(c.getEndY());
            copy.setEndX(c.getStartX());copy.setEndY(c.getStartY());return copy;
        }).toList();
        var input=new PlanAdjustment(UUID.randomUUID().toString(),null,reversed);
        var changed=workflow.adjust(original.getPlanId(),input);
        assertEquals(2,changed.version());assertEquals(baseline,json.writeValueAsString(original));
        assertEquals(json.writeValueAsString(original.getPieces()),json.writeValueAsString(changed.result().getPieces()));
        assertEquals(json.writeValueAsString(original.getRemnants()),json.writeValueAsString(changed.result().getRemnants()));
        assertEquals(stock,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(changed.id(),workflow.adjust(original.getPlanId(),input).id());
        var reopened=new RemnantService(file.toString());
        assertEquals(json.writeValueAsString(changed.result().getCuts()),json.writeValueAsString(reopened.getPlan(changed.id()).result().getCuts()));
        var restored=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),reopened)
                .adjust(changed.id(),new PlanAdjustment(UUID.randomUUID().toString(),null,original.getCuts()));
        assertEquals(3,restored.version());assertEquals(original.getCuts().get(0).getStartX(),restored.result().getCuts().get(0).getStartX());
        var receipt=new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),reopened)
                .confirm(new CutReport(restored.id(),original.getDeductLen(),2,restored.result().getRemnants(),"A"));
        assertEquals(2,receipt.get("finishedPieceCount"));
    }
}
