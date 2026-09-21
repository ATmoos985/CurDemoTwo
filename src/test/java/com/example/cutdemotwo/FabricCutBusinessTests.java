package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.PackingSolverService;
import com.example.cutdemotwo.service.ScenarioOneService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

@SpringBootTest
class FabricCutBusinessTests {

    @Autowired
    private ScenarioOneService scenarioOneService;

    @Autowired
    private PackingSolverService packingSolverService;

    @Test
    void testWordTableOneLShapeDecomposition() {
        SolveResponse res = scenarioOneService.getTableOneLShape();
        assertTrue(res.isSuccess());
        assertEquals(1, res.getPieces().size());
        assertEquals(2, res.getRemnants().size());
        assertEquals(4.5, res.getPieceArea(), 0.001);
        assertEquals(3.5, res.getRemArea(), 0.001);
        assertEquals(8.0, res.getTotalArea(), 0.001);

        // 100% Exact area balance
        assertEquals(res.getTotalArea(), res.getPieceArea() + res.getRemArea() + res.getWasteArea(), 0.001);
    }

    @Test
    void testWidthAdaptation() {
        // Allowed longitudinal cut
        SolveResponse okRes = scenarioOneService.getWidthAdaptation(true);
        assertTrue(okRes.isSuccess());
        assertEquals(6.0, okRes.getPieceArea(), 0.001);
        assertEquals(2.0, okRes.getRemArea(), 0.001);
        assertTrue(okRes.getRemnants().get(0).isHasDefect());

        // Forbidden longitudinal cut (safety blockage)
        SolveResponse blockRes = scenarioOneService.getWidthAdaptation(false);
        assertFalse(blockRes.isSuccess());
    }

    @Test
    void testShortRemnantReuse() {
        SolveResponse res = scenarioOneService.getShortRemnantReuse();
        assertTrue(res.isSuccess());
        assertEquals(0.0, res.getDeductLen(), 0.001); // Mother roll 0 deduction
        assertEquals(2.0, res.getPieceArea(), 0.001);
        assertEquals(1.2, res.getRemArea(), 0.001);
    }

    @Test
    void testPackingSolverRealExecutionWithDefects() {
        if (!packingSolverService.isAvailable()) {
            System.out.println("PackingSolver executable not found, skipping real solver test.");
            return;
        }

        SolveRequest req = new SolveRequest();
        req.setRollW(2000.0);
        req.setRollL(5000.0);

        List<PieceDemand> demands = new ArrayList<>();
        demands.add(new PieceDemand(1, "裁片A", 800, 1200, 2, false));
        demands.add(new PieceDemand(2, "裁片B", 600, 1000, 4, false));
        demands.add(new PieceDemand(3, "裁片C", 1000, 800, 2, false));
        req.setDemands(demands);

        List<Defect> defects = new ArrayList<>();
        defects.add(new Defect(1, 500, 1400, 150, 150, 30));
        defects.add(new Defect(2, 1300, 3200, 200, 100, 30));
        req.setDefects(defects);

        SolveResponse res = packingSolverService.solve(req);
        assertTrue(res.isSuccess());
        assertFalse(res.getPieces().isEmpty());
        assertFalse(res.getCuts().isEmpty());
        assertTrue(res.getTotalArea() > 0);

        // Verify defect avoidance
        for (PlacedPiece p : res.getPieces()) {
            System.out.printf("Placed piece: %s at (%.0f, %.0f) size [%.0f x %.0f]\n",
                    p.getName(), p.getX(), p.getY(), p.getW(), p.getL());
            for (Defect d : defects) {
                boolean overlaps = !(p.getX() + p.getW() <= d.getSafeX() || p.getX() >= d.getSafeX() + d.getSafeW() ||
                        p.getY() + p.getL() <= d.getSafeY() || p.getY() >= d.getSafeY() + d.getSafeH());
                if (overlaps) {
                    System.out.printf("OVERLAP DETECTED with Defect %d safe zone [%.0f, %.0f, %.0f, %.0f]!\n",
                            d.getId(), d.getSafeX(), d.getSafeY(), d.getSafeW(), d.getSafeH());
                }
                assertFalse(overlaps, "Piece overlaps with defect safety zone!");
            }
        }
    }

    @Autowired
    private com.example.cutdemotwo.service.RemnantService remnantService;

    @Test
    void testRemnantServiceScanAndMatching() {
        remnantService.updateStatus("REM-202609-001", "AVAILABLE");
        // 1. 条码精确识别
        RemnantStock r1 = remnantService.scanOrGetById("REM-202609-001");
        assertNotNull(r1);
        assertEquals(2000.0, r1.getWidth());
        assertEquals(1600.0, r1.getLength());
        assertEquals("AVAILABLE", r1.getStatus());

        // 2. 智能订单逆向匹配推荐 (指定母卷 ROLL-2026-0920)
        List<RemnantStock> matched = remnantService.matchRemnants("ROLL-2026-0920", 1500, 1000, false);
        assertFalse(matched.isEmpty());
        assertEquals("REM-202609-001", matched.get(0).getId()); // 优先推荐本卷中面积最小且合用的料头
    }

    @Test
    void testRemnantFeedPortZeroRollDeduction() {
        SolveRequest req = new SolveRequest();
        req.setFeedPortType("remnant");
        req.setSourceRemnantId("REM-202609-001");
        req.setRollW(2000.0);
        req.setRollL(1600.0);

        List<PieceDemand> demands = new ArrayList<>();
        demands.add(new PieceDemand(1, "短料成品", 2000, 1000, 1, false));
        req.setDemands(demands);

        SolveResponse res = packingSolverService.solve(req);
        assertTrue(res.isSuccess());
        assertEquals("remnant", res.getFeedPortType());
        assertEquals(0.0, res.getDeductLen(), 0.001); // 严格核算母卷0扣料!
        assertEquals("REM-202609-001", res.getSourceRemnantId());
        assertFalse(res.getDerivedRemnants().isEmpty());
        assertEquals("REM-202609-001", res.getDerivedRemnants().get(0).getParentRemnantId());
    }

    @Test
    void testMotherRollAssociationAndAutoRemnantCreation() {
        // 1. 验证母卷列表与在库料头聚合
        List<MotherRollInfo> rolls = remnantService.getMotherRolls();
        assertFalse(rolls.isEmpty());
        MotherRollInfo roll1 = rolls.stream().filter(r -> "ROLL-2026-0920".equals(r.getRollId())).findFirst().orElse(null);
        assertNotNull(roll1);
        int initialCount = roll1.getRemnantCount();
        assertTrue(initialCount >= 3);

        // 2. 母卷开卷下料产生新料头
        SolveRequest req = new SolveRequest();
        req.setRollId("ROLL-2026-0920");
        req.setFeedPortType("roll");
        req.setRollW(2000.0);
        req.setRollL(5000.0);
        req.setCutOrigin("right-bottom");

        List<PieceDemand> demands = new ArrayList<>();
        demands.add(new PieceDemand(1, "右对齐裁片", 1500, 3000, 1, false));
        req.setDemands(demands);

        SolveResponse res = packingSolverService.solve(req);
        assertTrue(res.isSuccess());
        assertEquals("roll", res.getFeedPortType());
        assertFalse(res.getDerivedRemnants().isEmpty());

        // 验证切出的新料头自动归档至母卷 ROLL-2026-0920
        List<RemnantStock> updatedRemnants = remnantService.getRemnantsByRollId("ROLL-2026-0920");
        assertTrue(updatedRemnants.size() > initialCount, "新切出的料头应自动纳入该母卷料头库");
    }
}
