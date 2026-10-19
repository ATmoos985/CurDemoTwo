package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingProblem.*;
import com.example.cutdemotwo.model.nesting.NestingResult;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class JavaIrregularSolverEngineTests {
    private JavaIrregularSolverEngine engine;
    private SolverFactory solverFactory;

    @BeforeEach
    void setup() {
        engine = new JavaIrregularSolverEngine();
        solverFactory = new SolverFactory(List.of(new IrregularPackingSolverService(), engine));
    }

    private static Shape polygon(double... xy) {
        List<Point> points = new ArrayList<>();
        for (int i = 0; i < xy.length; i += 2) points.add(new Point(xy[i], xy[i + 1]));
        double maxX = points.stream().mapToDouble(Point::x).max().orElseThrow();
        double maxY = points.stream().mapToDouble(Point::y).max().orElseThrow();
        return new Shape("POLYGON", maxX, maxY, points);
    }

    private static Shape lShape() {
        return polygon(0, 0, 200, 0, 200, 100, 100, 100, 100, 200, 0, 200);
    }

    @Test
    void testBasicLShapePackingAndValidation() {
        Shape mat = Shape.rectangle(600, 600);
        List<Part> parts = List.of(new Part(1, "L-Part", lShape(), 4, false));
        NestingProblem problem = new NestingProblem(
                "1", "mm", new Material("mat-1", mat, List.of(), false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 0),
                "javairregular", 2
        );

        EngineResult result = engine.solve(problem);
        assertTrue(result.isSuccess());
        assertEquals(4, result.getPlacements().size());

        String validationError = PolygonResultValidator.validate(problem, result);
        assertNull(validationError, "PolygonResultValidator validation should pass: " + validationError);
    }

    @Test
    void testDefectAvoidanceWithClearance() {
        Shape mat = Shape.rectangle(800, 800);
        List<Part> parts = List.of(new Part(1, "L-Part", lShape(), 3, false));
        // Defect in the center
        List<Exclusion> defects = List.of(new Exclusion(1, 150, 150, Shape.rectangle(100, 100), 20));
        NestingProblem problem = new NestingProblem(
                "1", "mm", new Material("mat-defect", mat, defects, false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 0),
                "javairregular", 2
        );

        EngineResult result = engine.solve(problem);
        assertTrue(result.isSuccess());
        assertFalse(result.getPlacements().isEmpty());

        String validationError = PolygonResultValidator.validate(problem, result);
        assertNull(validationError, "Should strictly avoid defect: " + validationError);
    }

    @Test
    void testPieceGapRequirement() {
        Shape mat = Shape.rectangle(600, 600);
        List<Part> parts = List.of(new Part(1, "Rect-Part", Shape.rectangle(150, 150), 4, false));
        double pieceGap = 10.0;
        NestingProblem problem = new NestingProblem(
                "1", "mm", new Material("mat-gap", mat, List.of(), false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", pieceGap),
                "javairregular", 2
        );

        EngineResult result = engine.solve(problem);
        assertTrue(result.isSuccess());
        assertEquals(4, result.getPlacements().size());

        String validationError = PolygonResultValidator.validate(problem, result);
        assertNull(validationError, "Should satisfy piece gap of " + pieceGap + " mm: " + validationError);
    }

    @Test
    void testGarmentShirtKitMarkerPacking() {
        // Mock garment shirt parts (front, back, sleeves, collar, welt, pocket) for M & L sizes (total 18 parts)
        Shape front = polygon(0,640, 20,380, 0,220, 45,205, 70,170, 85,120, 90,55, 180,0, 195,35, 220,65, 250,75, 280,65, 305,35, 320,0, 410,55, 415,120, 430,170, 455,205, 500,220, 480,380, 500,640);
        Shape back = polygon(0,650, 20,380, 0,220, 45,205, 70,170, 85,120, 90,55, 180,0, 210,20, 250,28, 290,20, 320,0, 410,55, 415,120, 430,170, 455,205, 500,220, 480,380, 500,650);
        Shape sleeve = polygon(0,150, 25,100, 65,55, 110,18, 160,0, 210,18, 255,55, 295,100, 320,150, 280,500, 40,500);
        Shape collar = polygon(0,0, 340,0, 320,70, 20,70);
        Shape welt = Shape.rectangle(55, 400);
        Shape pocket = polygon(0,0, 150,0, 150,140, 75,180, 0,140);

        List<Part> parts = List.of(
                new Part(1, "M-前片", front, 1, false),
                new Part(2, "M-后片", back, 1, false),
                new Part(3, "M-袖片", sleeve, 2, false),
                new Part(4, "M-领片", collar, 1, false),
                new Part(5, "M-贴边", welt, 2, false),
                new Part(6, "M-袋布", pocket, 2, false),
                new Part(7, "L-前片", front, 1, false),
                new Part(8, "L-后片", back, 1, false),
                new Part(9, "L-袖片", sleeve, 2, false),
                new Part(10, "L-领片", collar, 1, false),
                new Part(11, "L-贴边", welt, 2, false),
                new Part(12, "L-袋布", pocket, 2, false)
        );
        int totalExpectedPieces = 18;

        // Standard marker width: 1500 mm, length: 2500 mm
        Shape markerMaterial = Shape.rectangle(1500, 2500);
        NestingProblem problem = new NestingProblem(
                "1", "mm", new Material("marker-mat", markerMaterial, List.of(), false),
                parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA", 5.0),
                "auto", 3
        );

        // Solve via solverFactory (verifies automatic fallback from packingsolver-irregular -> javairregular)
        NestingResult result = solverFactory.solve(problem);
        assertEquals("FEASIBLE", result.status());
        assertEquals("javairregular", result.engine());
        assertEquals("packingsolver-irregular", result.requestedEngine());
        assertNotNull(result.fallbackReason());
        assertTrue(result.fallbackReason().contains("javairregular"));

        assertEquals(totalExpectedPieces, result.placements().size(), "All 18 pieces must be placed (complete kit)");
    }
}
