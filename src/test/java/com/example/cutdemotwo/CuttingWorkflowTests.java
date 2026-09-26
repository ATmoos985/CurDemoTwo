package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.CrossCutSolverService;
import com.example.cutdemotwo.service.CuttingWorkflowService;
import com.example.cutdemotwo.service.RemnantService;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class CuttingWorkflowTests {
    @TempDir Path temp;

    @Test
    void crosscutAvoidsDefectAndNeverMakesLongitudinalCut() {
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false);
        request.setRollW(2000);
        request.setRollL(4000);
        request.setDemands(List.of(new PieceDemand(1, "窗帘矩形", 2000, 1000, 2, false)));
        request.setDefects(List.of(new Defect(1, 200, 1200, 200, 200, 20)));
        SolveResponse result = new SolverFactory(List.of(new CrossCutSolverService())).solve(request);
        assertTrue(result.isSuccess());
        assertEquals(2, result.getPieces().size());
        assertTrue(result.getCuts().stream().allMatch(c -> "横切".equals(c.getType())));
        assertTrue(result.getPieces().get(1).getY() >= 1420);
    }

    @Test
    void previewDoesNotChangeInventoryAndConfirmedReportPersistsOnce() {
        Path state = temp.resolve("inventory.json");
        RemnantService inventory = new RemnantService(state.toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(
                new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false);
        request.setRollW(2000);
        request.setRollL(1600);
        request.setDemands(List.of(new PieceDemand(1, "窗帘矩形", 2000, 1000, 1, false)));
        request.setDefects(List.of(new Defect(1, 200, 1200, 100, 100, 20)));
        double before = inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength();
        int remnantsBefore = inventory.getRemnantsByRollId(request.getRollId()).size();
        SolveResponse plan = workflow.solve(request);
        assertNotNull(plan.getPlanId());
        assertEquals(before, inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        assertEquals(remnantsBefore, inventory.getRemnantsByRollId(request.getRollId()).size());
        CutReport report = new CutReport(plan.getPlanId(), 1600, 1, plan.getRemnants(), "测试库位");
        Map<String, Object> receipt = workflow.confirm(report);
        assertEquals(receipt, workflow.confirm(report));
        SolveResponse overlappingPlan = workflow.solve(request);
        assertThrows(IllegalArgumentException.class, () -> workflow.confirm(new CutReport(
                overlappingPlan.getPlanId(), 1600, 1, overlappingPlan.getRemnants(), "测试库位")));
        RemnantService reopened = new RemnantService(state.toString());
        assertEquals(before - 1600, reopened.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        assertEquals(remnantsBefore + 1, reopened.getRemnantsByRollId(request.getRollId()).size());
        assertEquals(receipt.get("planId"), reopened.getReceipt(plan.getPlanId()).get("planId"));
        RemnantStock child = ((List<RemnantStock>) receipt.get("derivedRemnants")).get(0);
        assertEquals("AVAILABLE", reopened.scanOrGetById(child.getId()).getStatus());
        assertFalse(reopened.scanOrGetById(child.getId()).getDefects().isEmpty());
    }

    @Test
    void remnantCanBeCutIntoAnotherReusableRemnantWithoutDeductingRoll() {
        RemnantService inventory = new RemnantService(temp.resolve("remnant.json").toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(
                new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        double before = inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        String parentId = "REM-202609-001";
        for (int generation = 2; generation <= 3; generation++) {
            RemnantStock parent = inventory.scanOrGetById(parentId);
            SolveRequest request = new SolveRequest();
            request.setAllowLongitudinal(false);
            request.setFeedPortType("remnant");
            request.setSourceRemnantId(parentId);
            request.setRollW(parent.getWidth());
            request.setRollL(parent.getLength());
            request.setDemands(List.of(new PieceDemand(1, "补单", 2000, generation == 2 ? 1000 : 300, 1, false)));
            SolveResponse plan = workflow.solve(request);
            assertTrue(plan.isSuccess());
            assertNotNull(inventory.scanOrGetById(parentId), "预览不得核销原料头");
            Map<String, Object> receipt = workflow.confirm(new CutReport(plan.getPlanId(), 0, 1, plan.getRemnants(), "测试料头架"));
            assertNull(inventory.scanOrGetById(parentId), "确认后原料头应核销");
            RemnantStock child = ((List<RemnantStock>) receipt.get("derivedRemnants")).get(0);
            assertEquals(generation, child.getGeneration());
            assertEquals(parentId, child.getParentRemnantId());
            parentId = child.getId();
        }
        assertEquals(before, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
}
