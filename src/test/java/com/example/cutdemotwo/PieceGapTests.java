package com.example.cutdemotwo;

import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.PieceDemand;
import com.example.cutdemotwo.business.model.SolveRequest;
import com.example.cutdemotwo.business.model.SolveResponse;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.geometry.PlacedPiece;
import com.example.cutdemotwo.algorithm.solver.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.solver.PackingSolverService;
import com.example.cutdemotwo.business.cutting.FabricSolveAdapter;
import com.example.cutdemotwo.algorithm.solver.JavaGuillotineSolverEngine;
import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PieceGapTests {
    private SolverFactory factory() {
        var nativeEngine = new PackingSolverService();
        ReflectionTestUtils.setField(nativeEngine, "solverPath", System.getenv().getOrDefault("PACKINGSOLVER_PATH", "data/solver/packingsolver_rectangleguillotine.exe"));
        return new SolverFactory(List.of(nativeEngine, new JavaGuillotineSolverEngine(), new CrossCutSolverService()));
    }
    private SolveRequest request() {
        var r = new SolveRequest(); r.setRollW(1000); r.setRollL(2000); r.setTotalRollL(10000);
        r.setCutOrigin("left-top"); r.setPieceGap(10.5); r.setTimeLimitSeconds(1);
        r.setDemands(List.of(new PieceDemand(1,"裁片",490,600,4,false)));
        return r;
    }
    private void check(SolveRequest r, SolveResponse result) {
        assertTrue(result.isSuccess(),result.getMessage()); assertFalse(result.getPieces().isEmpty());
        var pieces=result.getPieces();
        for (int i=0;i<pieces.size();i++) {
            var a=pieces.get(i);
            assertTrue(a.getX()>=-.001 && a.getY()>=-.001);
            assertTrue(a.getX()+a.getW()<=r.getRollW()+.001 && a.getY()+a.getL()<=r.getRollL()+.001);
            for(int j=i+1;j<pieces.size();j++) {
                var b=pieces.get(j); double g=r.getPieceGap()-.001;
                assertTrue(a.getX()+a.getW()+g<=b.getX() || b.getX()+b.getW()+g<=a.getX()
                        || a.getY()+a.getL()+g<=b.getY() || b.getY()+b.getL()+g<=a.getY());
            }
        }
        assertEquals(r.getRollW()*r.getRollL()/1e6,result.getTotalArea(),.000001);
        assertEquals(pieces.stream().mapToDouble(p->p.getW()*p.getL()/1e6).sum(),result.getPieceArea(),.000001);
        assertTrue(result.getDeductLen()<=r.getRollL()+.001);
    }
    @Test void nativeAndJavaKeepDimensionsAndGapAtAllFourOrigins() {
        var factory=factory();
        for(String engine:List.of("packingsolver","javaguillotine")) for(String origin:List.of("left-top","left-bottom","right-top","right-bottom")) {
            var r=request(); r.setSolver(engine);r.setCutOrigin(origin);
            var result=FabricSolveAdapter.solve(factory,r);check(r,result);
            assertEquals(4,result.getPieces().size());
            assertTrue(result.getPieces().stream().allMatch(p->p.getW()==490 && p.getL()==600));
        }
    }
    @Test void fullWidthCrosscutStillFitsEdgesAndConsumesTheInterPieceGap() {
        var r=request();r.setAllowLongitudinal(false);r.setRollL(1210.5);
        r.setDemands(List.of(new PieceDemand(1,"整幅",1000,600,2,false)));
        var result=FabricSolveAdapter.solve(factory(),r);check(r,result);
        assertEquals(2,result.getPieces().size());assertEquals(1210.5,result.getDeductLen(),.001);
        assertEquals(0,result.getRemArea(),.000001);
        assertEquals(.0105,result.getWasteArea(),.000001);
        r.setRollL(1200);assertEquals(1,FabricSolveAdapter.solve(factory(),r).getPieces().size());
    }
    @Test void sheetRotationAndDefectsRemainValidWithGap() {
        var r=request();r.setFeedPortType("remnant");r.setSourceRemnantId("sheet");r.setRollW(600);r.setRollL(1300);
        r.setDemands(List.of(new PieceDemand(1,"旋转",650,300,2,true)));
        r.setCutOrigin("right-bottom");r.setTrimStart(25.5);
        r.setDefects(List.of(new Defect(1,0,0,100,100,10)));
        var result=FabricSolveAdapter.solve(factory(),r);check(r,result);
        assertTrue(result.getPieces().stream().allMatch(p->p.isRotated() && p.getW()==300 && p.getL()==650));
        assertTrue(result.getPieces().stream().allMatch(p->p.getX()>=110 || p.getY()>=110));
        assertTrue(result.getPieces().stream().allMatch(p->p.getY()+p.getL()<=1274.5+.001));
    }
    @Test void manualAdjustmentCannotRemoveTheReservedGap() {
        var r=request();
        var pieces=List.of(new PlacedPiece(1,"裁片",0,0,490,600,false,1),new PlacedPiece(2,"裁片",490,0,490,600,false,1));
        assertTrue(assertThrows(IllegalArgumentException.class,()->FabricSolveAdapter.adjust(factory(),r,pieces)).getMessage().contains("间距"));
    }
    @Test void gapRejectsInvalidAndSubResolutionValues() {
        for(double value:new double[]{-1,101,Double.NaN,Double.POSITIVE_INFINITY,.15}) {
            var r=request();r.setPieceGap(value);assertThrows(IllegalArgumentException.class,r::validateSettings);
        }
        var r=request();r.setPieceGap(0);r.validateSettings();
    }
    @Test void historicalTaskProcessWithoutGapLoadsAsZero() {
        var json=new tools.jackson.databind.ObjectMapper();
        String old="{\"bedLength\":5000,\"trimStart\":0,\"cutOrigin\":\"right-bottom\",\"firstStageOrientation\":\"horizontal\",\"allowRotation\":false,\"allowLongitudinal\":true}";
        assertEquals(0.0,json.readValue(old,CuttingTask.Process.class).pieceGap());
        assertEquals(10.5,json.readValue(old.replace("5000","5000,\"pieceGap\":10.5"),CuttingTask.Process.class).pieceGap());
    }
}
