package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.toolpath.*;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class ToolpathSafetyTests {
    private final ToolpathOptimizerService optimizer = new ToolpathOptimizerService();

    @Test void legalInputNeverRegressesAndKeepsItsGeometry() {
        double[][] points = {{600,2900,2600},{800,2300,2000},{400,2200,1700},{200,1200,300},
                {1000,900,1400},{1200,2000,2700},{1400,2700,2400}};
        var cuts = new java.util.ArrayList<CutStep>();
        for (double[] p : points) {
            var c = new CutStep(cuts.size()+1,"纵切",p[0],Math.min(p[1],p[2]),Math.max(p[1],p[2]),"同阶段");
            c.setStage(1);c.setStartY(p[1]);c.setEndY(p[2]);cuts.add(c);
        }
        var r = optimizer.optimizeToolpath(cuts,2000,5000,true);
        assertTrue(r.getOptimizedAirDistance() <= r.getOriginalAirDistance());
        assertEquals(7, optimizer.validateReorderedCuts(cuts,r.getOptimizedCuts(),2000,5000,true).size());
        assertTrue(r.getOptimizedCuts().stream().allMatch(c -> c.getStage() == 1));
    }

    @Test void savedCutValidationRejectsMissingGeometryAndBrokenPrecedenceButAllowsReversing() {
        var parent = new CutStep(1,"横切",100,0,200,"第 99 阶段：文字不决定顺序");parent.setStage(1);
        var child = new CutStep(2,"纵切",150,100,200,"第 1 阶段：文字不决定顺序");child.setStage(2);
        var saved = List.of(parent,child);
        assertEquals("横切",optimizer.optimizeToolpath(saved,200,200,true).getOptimizedCuts().get(0).getType());
        assertThrows(IllegalArgumentException.class,()->optimizer.validateReorderedCuts(saved,List.of(child,parent),200,200,true));
        assertThrows(IllegalArgumentException.class,()->optimizer.validateReorderedCuts(saved,List.of(parent),200,200,true));
        var changed = new CutStep(1,"横切",100,0,199,"changed");
        assertThrows(IllegalArgumentException.class,()->optimizer.validateReorderedCuts(saved,List.of(changed,child),200,200,true));
        var reverse = new CutStep(1,"横切",100,0,200,"untrusted");reverse.setStartX(200.0);reverse.setEndX(0.0);reverse.setStage(20);
        var accepted = optimizer.validateReorderedCuts(saved,List.of(reverse,child),200,200,true);
        assertEquals(200,accepted.get(0).getStartX());assertEquals(1,accepted.get(0).getStage());
        assertEquals(parent.getDesc(),accepted.get(0).getDesc());
        child.setStartX(Double.NaN);
        assertThrows(IllegalArgumentException.class,()->optimizer.optimizeToolpath(saved,200,200,true));
    }

    @Test void collinearCutsFromDifferentStagesAreNeverMerged() {
        var first = new CutStep(1,"横切",100,0,50,"父区域");first.setStage(1);
        var later = new CutStep(2,"横切",100,50,100,"子区域");later.setStage(3);
        var result = new CutBoundaryCompletionService().ensureCompleteSeparation(List.of(),List.of(),List.of(first,later),200,200,true);
        assertEquals(2,result.size());assertEquals(1,result.get(0).getStage());assertEquals(3,result.get(1).getStage());
        first.setStage(null);later.setStage(null);
        var between = new CutStep(2,"纵切",50,0,100,"中间分割");
        var legacy = new CutBoundaryCompletionService().ensureCompleteSeparation(List.of(),List.of(),List.of(first,between,later),200,200,true);
        assertEquals(List.of("横切","纵切","横切"),legacy.stream().map(CutStep::getType).toList());
        assertEquals(50,legacy.get(0).getEnd());assertEquals(50,legacy.get(2).getStart());
    }

    @Test void unknownDependenciesKeepTheParentCutBeforeItsChild() {
        var parent = new CutStep(1, "横切", 100, 0, 200, "调整版贯通分割");
        var child = new CutStep(2, "纵切", 150, 100, 200, "调整版贯通分割");
        var result = optimizer.optimizeToolpath(List.of(parent, child), 200, 200, true);
        assertEquals("横切", result.getOptimizedCuts().get(0).getType());
        assertEquals("纵切", result.getOptimizedCuts().get(1).getType());
        assertNull(parent.getAirDistance(), "optimization must not mutate the saved input");
    }

    @Test void completesFourMillimeterAndSubMillimeterBoundaryGaps() {
        for (double gap : new double[]{4, .1}) {
            var cuts = new CutBoundaryCompletionService().ensureCompleteSeparation(
                    List.of(new PlacedPiece(1, "裁片", 0, 0, 100, 100, false)), List.of(),
                    List.of(new CutStep(1, "横切", 100, 0, 100-gap, "边界")), 200, 200, true);
            assertTrue(cuts.stream().filter(c -> "横切".equals(c.getType()) && c.getPos() == 100)
                    .anyMatch(c -> c.getEnd() >= 100), "unseparated gap: " + gap);
            assertEquals(100, cuts.stream().filter(c -> "横切".equals(c.getType()) && c.getPos() == 100)
                    .mapToDouble(c -> Math.abs(c.getEnd()-c.getStart())).sum(), .000001);
        }
    }

    @Test void adjacentCoverageDoesNotPretendAnUncutGapIsAlreadySeparated() {
        var cuts = new CutBoundaryCompletionService().ensureCompleteSeparation(
                List.of(new PlacedPiece(1, "裁片", 0, 0, 100, 100, false)), List.of(),
                List.of(new CutStep(1, "横切", 100, 0, 49.9, "左段"),
                        new CutStep(2, "横切", 100, 50.1, 100, "右段")), 200, 200, true);
        assertEquals(100, cuts.stream().filter(c -> "横切".equals(c.getType()) && c.getPos() == 100)
                .mapToDouble(c -> Math.abs(c.getEnd()-c.getStart())).sum(), .000001);
    }
}
