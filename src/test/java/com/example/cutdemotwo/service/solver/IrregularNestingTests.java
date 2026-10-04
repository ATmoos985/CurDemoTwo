package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.nesting.NestingProblem;
import com.example.cutdemotwo.model.nesting.NestingResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.example.cutdemotwo.model.nesting.NestingProblem.*;

@SpringBootTest
class IrregularNestingTests {
    @TempDir static Path temp;
    @DynamicPropertySource static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("state.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
    }
    @Autowired SolverFactory kernel;
    @Autowired IrregularPackingSolverService nativeEngine;
    static Shape polygon(double... xy) {
        var points = new ArrayList<Point>();
        for (int i = 0; i < xy.length; i += 2) points.add(new Point(xy[i], xy[i+1]));
        return new Shape("POLYGON", points.stream().mapToDouble(Point::x).max().orElseThrow(), points.stream().mapToDouble(Point::y).max().orElseThrow(), points);
    }
    static Shape lShape() { return polygon(0,0, 200,0, 200,100, 100,100, 100,200, 0,200); }
    static NestingProblem problem(Shape material, List<Part> parts, List<Exclusion> exclusions) {
        return new NestingProblem("1", "mm", new Material("sheet", material, exclusions, false), parts,
                new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0, 0, 0, 0, "MAXIMIZE_PIECE_AREA"), "auto", 2);
    }
    static NestingProblem sample() { return problem(Shape.rectangle(600,600), List.of(new Part(42,"L",lShape(),3,true)),List.of()); }
    static EngineResult candidate(NestingResult.Placement... pieces) {
        var result = new EngineResult(); result.setSuccess(true); result.setPlacements(List.of(pieces)); return result;
    }
    static NestingResult.Placement placed(int id, double x, double y, Shape shape, int angle) {
        return new NestingResult.Placement(id,42,"L",x,y,shape,angle);
    }

    @Test void areaUsesActualConcaveRegionAndAcceptsBothWindings() {
        var l = lShape(); PolygonGeometry.validate(l); assertEquals(30000, PolygonGeometry.area(l));
        var reverse = new ArrayList<>(l.vertices()); Collections.reverse(reverse);
        var clockwise = new Shape("POLYGON",200,200,reverse); PolygonGeometry.validate(clockwise);
        assertEquals(30000, PolygonGeometry.area(clockwise));
        var ring = PolygonGeometry.region(Shape.rectangle(300,300),0,0);
        ring.subtract(PolygonGeometry.region(Shape.rectangle(100,100),100,100));
        assertEquals(80000, PolygonGeometry.area(ring));
    }
    @Test void invalidPolygonGeometryIsRejectedBeforeNativeInvocation() {
        for (Shape bad : List.of(polygon(0,0, 200,200, 0,200, 200,0), polygon(0,0, 100,0, 100,100, 0,0),
                polygon(10,10, 100,10, 100,100), polygon(0,0, 200,0, 100,0, 100,100, 0,100))) {
            assertEquals("INVALID_INPUT", kernel.solve(problem(bad, sample().parts(), List.of())).status());
        }
    }
    @Test void resultCannotOccupyMissingConcaveCornerOrInflatePartToBoundingBox() {
        var input = problem(lShape(),List.of(new Part(42,"square",Shape.rectangle(80,80),1,false)),List.of());
        assertTrue(PolygonResultValidator.validate(input,candidate(placed(1,110,110,Shape.rectangle(80,80),0))).contains("实际轮廓"));
        assertTrue(PolygonResultValidator.validate(sample(),candidate(placed(1,0,0,Shape.rectangle(200,200),0))).contains("改变"));
    }
    @Test void concavePackingMayOverlapBoundingBoxesButNotActualParts() {
        var a = lShape(); var b = PolygonGeometry.rotate(a,180);
        assertNull(PolygonResultValidator.validate(sample(), candidate(placed(1,0,0,a,0),placed(2,100,100,b,180))));
        assertTrue(PolygonResultValidator.validate(sample(),candidate(placed(1,0,0,a,0),placed(2,20,20,a,0))).contains("重叠"));
    }
    @Test void exclusionInEmptyCornerIsAllowedButIntersectionIsRejected() {
        var good = problem(Shape.rectangle(600,600), sample().parts(), List.of(new Exclusion(1,120,120,Shape.rectangle(30,30),0)));
        assertNull(PolygonResultValidator.validate(good,candidate(placed(1,0,0,lShape(),0))));
        var bad = problem(good.material().shape(),good.parts(),List.of(new Exclusion(1,20,20,Shape.rectangle(30,30),0)));
        assertTrue(PolygonResultValidator.validate(bad,candidate(placed(1,0,0,lShape(),0))).contains("禁入"));
    }
    @Test void quantityRotationAndUnknownDemandAreIndependentlyChecked() {
        var p = problem(Shape.rectangle(600,600), List.of(new Part(42,"L",lShape(),1,false)),List.of());
        assertNotNull(PolygonResultValidator.validate(p,candidate(placed(1,0,0,lShape(),0),placed(2,300,0,lShape(),0))));
        assertNotNull(PolygonResultValidator.validate(p,candidate(placed(1,0,0,PolygonGeometry.rotate(lShape(),90),90))));
        assertNotNull(PolygonResultValidator.validate(p,candidate(new NestingResult.Placement(1,99,"x",0,0,lShape(),0))));
    }
    @Test void unsupportedClearancePrecisionAndProcessNeverSilentlyDisappear() {
        var p = sample();
        assertEquals("UNSUPPORTED", kernel.solve(problem(p.material().shape(),p.parts(),List.of(new Exclusion(1,0,0,lShape(),2)))).status());
        assertEquals("UNSUPPORTED", kernel.solve(problem(polygon(0,0, 600,0, 600,599.95, 0,600),p.parts(),List.of())).status());
        var c = new NestingProblem.Process("CONTOUR","CONTINUOUS","left-top","none",0,0,0,0,"MAXIMIZE_PIECE_AREA");
        assertEquals("UNSUPPORTED",kernel.solve(new NestingProblem("1","mm",p.material(),p.parts(),c,"auto",2)).status());
    }
    @Test void malformedNativeCertificateCannotBecomeSuccessfulEmptyResult() {
        var json = new JsonMapper();
        for (String bad : List.of("{}", "{\"bins\":[{\"id\":1,\"copies\":1,\"items\":[]}]}", "{\"bins\":[{\"id\":0,\"copies\":2,\"items\":[]}]}"))
            assertThrows(IllegalArgumentException.class, () -> IrregularPackingSolverService.parseCertificate(json.readTree(bad),sample()));
        assertTrue(IrregularPackingSolverService.parseCertificate(json.readTree("null"), sample()).getPlacements().isEmpty());
    }
    @Test void nativeConcaveMaterialAvoidsDefectsAndReportsActualAreaWithoutInventingRemnants() {
        assertTrue(nativeEngine.isAvailable(), "Install the irregular native engine; this test must execute, not skip");
        var material = polygon(0,0, 600,0, 600,300, 300,300, 300,600, 0,600);
        var input = problem(material,sample().parts(),List.of(new Exclusion(1,200,100,Shape.rectangle(50,50),10)));
        var result = kernel.solve(input);
        assertEquals("FEASIBLE",result.status(),result.message()); assertEquals(3,result.placements().size());
        assertEquals(270000,result.metrics().processingAreaMm2()); assertEquals(90000,result.metrics().pieceAreaMm2(),.001);
        assertEquals(0,result.metrics().reusableAreaMm2()); assertEquals(180000,result.metrics().unassignedAreaMm2(),.001);
        assertTrue(result.leftovers().isEmpty()); assertTrue(result.cuts().isEmpty()); assertEquals(3,result.contours().size());
        assertEquals(0,result.metrics().suggestedFeedLengthMm());
        assertFalse(java.nio.file.Files.exists(temp.resolve("state.json")), "stateless solving must not write inventory");
    }
    @Test void nativeDiscreteRotationIsNecessaryAndForbiddenRotationLeavesDemandUnmet() {
        var source = polygon(0,0, 200,0, 200,50, 100,50, 100,100, 0,100);
        var material = PolygonGeometry.rotate(source,90);
        var p = problem(material,List.of(new Part(42,"L",source,1,true)),List.of());
        var result = kernel.solve(p); assertEquals("FEASIBLE",result.status(), result.message());
        assertEquals(90,result.placements().get(0).rotationDegrees());
        var blocked = kernel.solve(problem(material,List.of(new Part(42,"L",source,1,false)),List.of()));
        assertEquals("NO_SOLUTION_FOUND",blocked.status(), blocked.message()); assertEquals(1,blocked.fulfillment().get(0).unplaced());
    }
    @Test void nativePolygonExclusionUsesItsTriangleInsteadOfItsBoundingBox() {
        var triangle = polygon(0,0,200,0,0,200);
        var p = problem(Shape.rectangle(200,200),List.of(new Part(42,"triangle",triangle,1,true)),List.of(new Exclusion(1,0,0,triangle,0)));
        var result = kernel.solve(p); assertEquals("FEASIBLE",result.status(),result.message());
        assertEquals(20000,result.metrics().pieceAreaMm2(),.001); assertEquals(1,result.placements().size());
    }
    @Test void exclusionOutsideActualMaterialAndForgedEngineGeometryAreRejected() {
        assertEquals("INVALID_INPUT",kernel.solve(problem(lShape(),sample().parts(),List.of(new Exclusion(1,150,150,Shape.rectangle(20,20),0)))).status());
        var forged = new ICutSolverEngine() {
            public String getEngineType() { return "packingsolver-irregular"; }
            public boolean isAvailable() { return true; }
            public EngineCapabilities capabilities() { return nativeEngine.capabilities(); }
            public EngineResult solve(NestingProblem p) { return candidate(placed(1,0,0,Shape.rectangle(200,200),0)); }
        };
        var result = new SolverFactory(List.of(forged)).solve(sample());
        assertEquals("INVALID_RESULT",result.status()); assertTrue(result.placements().isEmpty()); assertTrue(result.contours().isEmpty());
    }
}
