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
    void expandingFeedWindowCutsOneLongWholePieceAndReportsOnlyActualLength() {
        RemnantService inventory = new RemnantService(temp.resolve("dynamic-feed.json").toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        CuttingTask task = inventory.saveTask(new CuttingTask(null, "动态拉布", "TC涤棉-B2026", "", 0,
                List.of(new CuttingTask.Line(1, "四米整幅", 2000, 4000, 1, false)),
                new CuttingTask.Process(2000, 0, "right-bottom", "horizontal", false, false)));
        SolveRequest request = new SolveRequest();
        request.setTaskId(task.id());
        request.setTaskRevision(task.revision());
        request.setAllowLongitudinal(false);
        request.setRollW(2000);
        request.setWindowStartY(5000);
        request.setRollL(2000);
        request.setDemands(List.of(new PieceDemand(1, "四米整幅", 2000, 4000, 1, false)));
        double before = inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength();
        assertFalse(workflow.solve(request).isSuccess());
        request.setRollL(4500);
        SolveResponse plan = workflow.solve(request);
        assertTrue(plan.isSuccess());
        assertEquals(1, plan.getPieces().size());
        assertEquals(4000, plan.getPieces().get(0).getL());
        assertTrue(plan.getCuts().stream().allMatch(c -> "横切".equals(c.getType())));
        assertEquals(before, inventory.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        var receipt = workflow.confirm(new CutReport(plan.getPlanId(), 4000, 1, List.of(), "测试库位"));
        assertEquals(before - 4000, receipt.get("remainingLength"));
        assertEquals(4500, ((SolveRequest) workflow.getPlan(plan.getPlanId()).get("request")).getRollL());
    }

    @Test
    void crosscutAvoidsDefectAndNeverMakesLongitudinalCut() {
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false);
        request.setRollW(2000);
        request.setRollL(4000);
        request.setDemands(List.of(new PieceDemand(1, "窗帘矩形", 2000, 1000, 2, false)));
        request.setDefects(List.of(new Defect(1, 200, 1200, 200, 200, 20)));
        SolveResponse result = com.example.cutdemotwo.service.FabricSolveAdapter.solve(new SolverFactory(List.of(new CrossCutSolverService())), request);
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
    void remnantIsConsumedOnceAndCannotCreateChildrenOrDeductMotherRoll() {
        Path file = temp.resolve("remnant.json");
        RemnantService inventory = new RemnantService(file.toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        double before = inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        String parentId = "REM-202609-001";
        RemnantStock parent = inventory.scanOrGetById(parentId);
        int count = inventory.getAvailableRemnants().size();
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false); request.setFeedPortType("remnant"); request.setSourceRemnantId(parentId);
        var task = inventory.saveTask(new CuttingTask(null, "料头单次使用", parent.getMaterialBatch(), "", 0, List.of(new CuttingTask.Line(1, "补单", 2000, 1000, 2, false))));
        request.setTaskId(task.id()); request.setTaskRevision(task.revision());
        request.setRollW(parent.getWidth()); request.setRollL(parent.getLength());
        request.setDemands(List.of(new PieceDemand(1, "补单", 2000, 1000, 1, false)));
        SolveResponse plan = workflow.solve(request);
        assertTrue(plan.isSuccess()); assertFalse(plan.getRemnants().isEmpty());
        var error = assertThrows(IllegalArgumentException.class, () -> workflow.confirm(new CutReport(plan.getPlanId(), 0, 1, plan.getRemnants(), "A")));
        assertTrue(error.getMessage().contains("料头只使用一次"));
        assertNotNull(inventory.scanOrGetById(parentId)); assertNull(inventory.getReceipt(plan.getPlanId()));
        var report = new CutReport(plan.getPlanId(), 0, 1, List.of(), "A");
        var receipt = workflow.confirm(report);
        assertEquals(receipt, workflow.confirm(report));
        assertNull(inventory.scanOrGetById(parentId)); assertEquals(count - 1, inventory.getAvailableRemnants().size());
        assertTrue(((List<?>)receipt.get("derivedRemnants")).isEmpty());
        assertEquals(0.0, receipt.get("remArea"));
        assertEquals(parent.getArea() - 2.0, (double)receipt.get("wasteArea"), 1e-9);
        assertEquals(before, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        RemnantService reopened = new RemnantService(file.toString());
        assertNull(reopened.scanOrGetById(parentId));
        assertThrows(IllegalArgumentException.class, () -> new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), reopened).solve(request));
        reopened.reverseReport(plan.getPlanId(), "误报撤回");
        assertNotNull(reopened.scanOrGetById(parentId));
    }

    @Test
    void unreportedPlansRemainRecoverableAfterMoreThanOneHundredPreviewsAndRestart() {
        RemnantService inventory = new RemnantService(temp.resolve("bounded.json").toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(
                new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false);
        request.setRollW(2000);
        request.setRollL(1600);
        request.setDemands(List.of(new PieceDemand(1, "窗帘", 2000, 1000, 1, false)));
        SolveResponse first = workflow.solve(request);
        SolveResponse latest = first;
        for (int i = 0; i < 100; i++) latest = workflow.solve(request);
        CuttingWorkflowService reopened = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),
                new RemnantService(temp.resolve("bounded.json").toString()));
        assertNotNull(reopened.getPlan(first.getPlanId()));
        assertNotNull(reopened.getPlan(latest.getPlanId()));
        assertEquals(1, reopened.confirm(new CutReport(first.getPlanId(), 1600, 1,
                first.getRemnants(), "测试库位")).get("finishedPieceCount"));
    }

    @Test
    void measuredRemnantMayGrowFiveMillimetersOnlyWhenGeometryIsFree() {
        SolveRequest request = new SolveRequest();
        request.setRollW(2000);
        request.setRollL(500);
        SolveResponse plan = new SolveResponse();
        plan.setPieces(List.of(new PlacedPiece(1, "成品", 1000, 0, 500, 500, false)));
        plan.setPieceArea(0.25);
        plan.setRemnants(List.of(new RemnantPiece("R", "可用料头", 0, 0, 400, 500, 0.2, false)));
        RemnantService inventory = new RemnantService(temp.resolve("measured.json").toString());
        RemnantPiece tooLarge = new RemnantPiece("R", "可用料头", 0, 0, 406, 490, 0, false);
        assertThrows(IllegalArgumentException.class, () -> inventory.confirm(request, plan,
                new CutReport("too-large", 500, 1, List.of(tooLarge), "测试库位")));
        RemnantPiece measured = new RemnantPiece("R", "可用料头", 0, 0, 405, 490, 0, false);
        Map<String, Object> receipt = inventory.confirm(request, plan,
                new CutReport("allowed", 500, 1, List.of(measured), "测试库位"));
        RemnantStock child = ((List<RemnantStock>) receipt.get("derivedRemnants")).get(0);
        assertEquals(405, child.getWidth());
        assertEquals(490, child.getLength());

        RemnantService crowded = new RemnantService(temp.resolve("crowded.json").toString());
        plan.setPieces(List.of(new PlacedPiece(1, "成品", 404, 0, 500, 500, false)));
        assertThrows(IllegalArgumentException.class, () -> crowded.confirm(request, plan,
                new CutReport("overlap", 500, 1, List.of(measured), "测试库位")));
    }
}
