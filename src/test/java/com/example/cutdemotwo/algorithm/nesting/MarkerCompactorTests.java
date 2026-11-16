package com.example.cutdemotwo.algorithm.nesting;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingProblem.*;
import com.example.cutdemotwo.contracts.nesting.NestingResult.Placement;
import org.junit.jupiter.api.Test;
import java.util.List;
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
}
