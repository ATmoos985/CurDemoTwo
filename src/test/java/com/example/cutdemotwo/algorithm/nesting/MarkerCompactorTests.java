package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.*;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class MarkerCompactorTests {
    private static NestingProblem marker(double width, List<Part> parts, List<Exclusion> defects) {
        return new NestingProblem("1", "mm", new Material("cloth", Shape.rectangle(width, 50), defects, false),
                parts, new NestingProblem.Process("CONTOUR","SHEET","left-top","none",0,0,0,0,"MAXIMIZE_PIECE_AREA"), "auto", 10);
    }
    private static List<Placement> compact(NestingProblem problem, List<Placement> incumbent) {
        var placements = MarkerCompactor.compact(problem, incumbent, System.nanoTime() + 1_000_000_000L);
        var engine = new EngineResult();
        engine.setPlacements(placements);
        assertNull(PolygonResultValidator.validate(problem, engine));
        return placements;
    }
    private static double length(List<Placement> layout) {
        return layout.stream().mapToDouble(p -> p.y() + p.shape().height()).max().orElseThrow();
    }
    @Test void complementarySlopingEdgesAllowHalfTurnWithoutQuarterTurn() {
        var shape = new Shape("POLYGON",10,10,List.of(new Point(0,0),new Point(10,0),new Point(8,10),new Point(2,10)));
        var seed = List.of(new Placement(1,1,"panel",0,0,shape,0), new Placement(2,1,"panel",0,10,shape,0));
        assertEquals(20, length(compact(marker(18,List.of(new Part(1,"panel",shape,2,false)),List.of()), seed)), .00001);
        var result = compact(marker(18,List.of(new Part(1,"panel",shape,2,false,true)),List.of()),seed);
        assertEquals(10, length(result), .00001);
        assertEquals(1, result.stream().filter(p -> p.rotationDegrees() == 180).count());
    }
    @Test void smallPieceFitsInsideConcaveOpeningAndStillAvoidsDefects() {
        var shell = new Shape("POLYGON",10,10,List.of(new Point(0,0),new Point(2,0),new Point(2,6),
                new Point(8,6),new Point(8,0),new Point(10,0),new Point(10,10),new Point(0,10)));
        var pocket = Shape.rectangle(4,4);
        var parts = List.of(new Part(1,"outer",shell,1,false),new Part(2,"pocket",pocket,1,false));
        var seed = List.of(new Placement(1,1,"outer",0,0,shell,0), new Placement(2,2,"pocket",0,12,pocket,0));
        assertEquals(10, length(compact(marker(10,parts,List.of()),seed)), .00001);
        var blocked = marker(10,parts,List.of(new Exclusion(1,2,0,Shape.rectangle(6,6),0)));
        assertEquals(14, length(compact(blocked,seed)), .00001);
    }
    @Test void expiredBudgetLeavesTheOriginalValidatedCandidateAvailable() {
        var rectangle = Shape.rectangle(5,5);
        var seed = List.of(new Placement(1,1,"panel",0,1,rectangle,0));
        assertSame(seed, MarkerCompactor.compact(marker(5,List.of(new Part(1,"panel",rectangle,1,false)),List.of()),
                seed, System.nanoTime() - 1));
    }

    @Test void denseContoursMoveTogetherAndKeepTheirExactOutlines() {
        var vertices = new java.util.ArrayList<Point>();
        for (int i = 0; i <= 24; i++) vertices.add(new Point(i,0));
        for (int i = 24; i >= 0; i--) vertices.add(new Point(i,10));
        var shape = new Shape("POLYGON",24,10,vertices);
        var trial = marker(24, List.of(new Part(1,"panel",shape,3,false)), List.of());
        var seed = List.of(new Placement(1,1,"panel",0,5,shape,0),
                new Placement(2,1,"panel",0,15,shape,0),new Placement(3,1,"panel",0,28,shape,0));
        assertTrue(MarkerCompactor.supports(trial,seed));
        assertFalse(MarkerCompactor.supportsGapSearch(trial));
        var output = compact(trial,seed);
        assertEquals(30, length(output), 1e-6);
        assertEquals(List.of(0d,10d,20d), output.stream().map(Placement::y).toList());
        assertTrue(output.stream().allMatch(p -> p.shape().equals(shape)));
    }

    private static List<Placement> fill(NestingProblem problem, List<Placement> fixed, Map<Integer,Integer> limits) {
        var fulfillment = problem.parts().stream().map(part -> {
            int count = (int) fixed.stream().filter(p -> p.demandId() == part.id()).count();
            return new NestingResult.Fulfillment(part.id(), part.quantity(), count, part.quantity() - count, null);
        }).toList();
        var seed = new NestingResult("1","mm","source-local-top-left","FEASIBLE",null,"test","1",0,
                "cloth",problem.material().shape(),fixed,List.of(),List.of(),fulfillment,null,List.of(),"test",null);
        return new SolverFactory(List.of()).fillMarkerGaps(problem, seed, limits, System.nanoTime() + 1_000_000_000L);
    }

    @Test void addsOnlyRequestedSparesWithoutMovingPiecesOrExtendingTheMarker() {
        var panel = Shape.rectangle(20,10);
        var trim = Shape.rectangle(3,10);
        var problem = marker(35,List.of(new Part(1,"panel",panel,1,false),new Part(2,"trim",trim,1,false)),List.of());
        var fixed = List.of(new Placement(1,1,"panel",0,0,panel,0),new Placement(3,2,"trim",20,0,trim,0));
        var extras = fill(problem,fixed,Map.of(2,2));
        assertEquals(2, extras.size());
        assertEquals(2, extras.stream().map(Placement::id).distinct().count());
        for (var p : extras) {
            assertEquals(2,p.demandId());
            assertNotEquals(1,p.id());
            assertNotEquals(3,p.id());
            assertTrue(p.x() >= 23 && p.x() + 3 <= 35);
            assertEquals(0,p.y(),.000001);
        }
        assertEquals(4,fill(problem,fixed,Map.of(2,20)).size());
        assertTrue(fill(problem,List.of(fixed.get(0)),Map.of(2,1)).isEmpty());
        assertTrue(fill(problem,fixed,Map.of(2,0,99,2)).isEmpty());
    }

    @Test void triangularOpeningRequiresThePermittedHalfTurnAndStopsAtFullCoverage() {
        var triangle = new Shape("POLYGON",10,10,List.of(new Point(0,0),new Point(10,0),new Point(0,10)));
        var fixed = List.of(new Placement(1,1,"triangle",0,0,triangle,0));
        var limits = Map.of(1,5);
        assertTrue(fill(marker(10,List.of(new Part(1,"triangle",triangle,1,false)),List.of()),fixed,limits).isEmpty());
        var extras = fill(marker(10,List.of(new Part(1,"triangle",triangle,1,false,true)),List.of()),fixed,limits);
        assertEquals(1,extras.size());
        assertEquals(180,extras.get(0).rotationDegrees());
        assertEquals(100,triangle.areaMm2() + extras.get(0).shape().areaMm2(),.000001);
    }

    @Test void sparePiecesRespectDefectsAndNeverUseTheUnusedTailOrAnInvalidSeed() {
        var square = Shape.rectangle(10,10);
        var fixed = List.of(new Placement(1,1,"panel",0,0,square,0));
        var part = new Part(1,"panel",square,1,false);
        var defect = new Exclusion(1,11,1,Shape.rectangle(8,8),1);
        assertTrue(fill(marker(20,List.of(part),List.of(defect)),fixed,Map.of(1,1)).isEmpty());
        assertTrue(fill(marker(10,List.of(part),List.of()),fixed,Map.of(1,1)).isEmpty());
        var invalid = List.of(fixed.get(0),new Placement(2,1,"panel",0,0,square,0));
        assertTrue(fill(marker(40,List.of(new Part(1,"panel",square,2,false)),List.of()),invalid,Map.of(1,1)).isEmpty());
    }

    @Test void fixedPiecesAboveTheCompactionLimitCanStillReceiveSpares() {
        var square = Shape.rectangle(1,1);
        var fixed = java.util.stream.IntStream.range(0,81).mapToObj(i -> new Placement(i+1,1,"tab",i,0,square,0)).toList();
        var problem = marker(82,List.of(new Part(1,"tab",square,81,false)),List.of());
        var extras = fill(problem,fixed,Map.of(1,5));
        assertEquals(1,extras.size());
        assertEquals(81,extras.get(0).x());
        var separated = new NestingProblem(problem.schemaVersion(),problem.unit(),problem.material(),problem.parts(),
                new NestingProblem.Process("CONTOUR","SHEET","left-top","none",0,0,0,0,"MAXIMIZE_PIECE_AREA",1),
                problem.engine(),problem.timeLimitSeconds());
        assertTrue(fill(separated,fixed,Map.of(1,5)).isEmpty());
    }
}
