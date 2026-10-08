package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class CuttingTaskTests {
    @TempDir Path temp;

    private CuttingTask create(RemnantService inventory) {
        return inventory.saveTask(new CuttingTask(null, "订单 A", "TC涤棉-B2026", "MES-001", 0,
                List.of(new CuttingTask.Line(7, "主片", 2000, 1000, 3, false),
                        new CuttingTask.Line(9, "同尺寸独立需求", 2000, 1000, 1, false)),
                new CuttingTask.Process(3000, 0, "right-bottom", "horizontal", false, false)));
    }

    private SolveRequest request(CuttingTask task, boolean remnant, int count) {
        SolveRequest request = new SolveRequest();
        request.setTaskId(task.id()); request.setTaskRevision(task.revision());
        request.setAllowLongitudinal(false);
        request.setRollL(remnant ? 1600 : 3000);
        request.setWindowStartY(remnant ? 0 : 5000);
        request.setFeedPortType(remnant ? "remnant" : "roll");
        request.setSourceRemnantId(remnant ? "REM-202609-001" : null);
        request.setDemands(List.of(new PieceDemand(7, "主片", 2000, 1000, count, false)));
        return request;
    }

    @Test void taskContinuesFromRemnantToRollAndRestoresAfterRestart() {
        Path path = temp.resolve("workflow.json");
        RemnantService inventory = new RemnantService(path.toString());
        CuttingWorkflowService workflow = new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory);
        CuttingTask task = create(inventory);
        double before = inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        SolveResponse first = workflow.solve(request(task, true, 3));
        assertEquals(1, first.getPieces().size());
        assertTrue(inventory.completedQuantities(task.id()).isEmpty(), "preview must not complete demand");
        CutReport report = new CutReport(first.getPlanId(), 0, 1, first.getRemnants(), "A-01");
        var receipt = workflow.confirm(report);
        assertEquals(receipt, workflow.confirm(report), "idempotent retry");
        assertEquals(before, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(1, inventory.completedQuantities(task.id()).get("7"));
        assertFalse(inventory.completedQuantities(task.id()).containsKey("9"), "same dimensions are distinct demand lines");
        SolveResponse second = workflow.solve(request(task, false, 2));
        SolveResponse stale = workflow.solve(request(task, false, 2));
        workflow.confirm(new CutReport(second.getPlanId(), 3000, 2, second.getRemnants(), "A-01"));
        assertThrows(IllegalArgumentException.class, () -> workflow.confirm(new CutReport(stale.getPlanId(), 3000, 2, stale.getRemnants(), "A-01")));
        RemnantService restored = new RemnantService(path.toString());
        assertEquals(3, restored.completedQuantities(task.id()).get("7"));
        assertEquals(2, restored.taskReports(task.id()).size());
        assertEquals(task.process(), restored.listTasks().get(0).process());
        assertThrows(IllegalArgumentException.class, () -> restored.saveTask(new CuttingTask(task.id(), task.name(), task.materialModel(), task.externalRef(), task.revision(),
                List.of(new CuttingTask.Line(7, "主片", 1900, 1000, 3, false)))));
        assertEquals(before - 3000, restored.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertThrows(IllegalArgumentException.class, () -> restored.resetRoll("ROLL-2026-0920"));
        assertTrue(restored.resetRoll("ROLL-2026-0920", true));
        assertEquals(restored.getMotherRoll("ROLL-2026-0920").getTotalLength(), restored.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(0.0, restored.getMotherRoll("ROLL-2026-0920").getUsedLength());
    }

    @Test void rejectsChangedRevisionWrongMaterialAndInvalidDemand() {
        RemnantService inventory = new RemnantService(temp.resolve("guards.json").toString());
        CuttingTask task = create(inventory);
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(task.id(), task.name(), task.materialModel(), "", 0, task.demands())));
        SolveRequest wrong = request(task, false, 2); wrong.setRollId("ROLL-2026-0921"); wrong.setRollW(1800);
        assertThrows(IllegalArgumentException.class, () -> inventory.prepareTaskSolve(wrong));
        SolveRequest excess = request(task, false, 4);
        assertThrows(IllegalArgumentException.class, () -> inventory.prepareTaskSolve(excess));
        assertThrows(IllegalArgumentException.class, () -> inventory.saveTask(new CuttingTask(null, "订单", "TC涤棉-B2026", "", 0,
                List.of(new CuttingTask.Line(1, "错误尺寸", Double.NaN, 1, 1, false)))));
    }

    @Test void candidatesKeepMaterialBoundaryAndRemnantPriority() {
        RemnantService inventory = new RemnantService(temp.resolve("candidates.json").toString());
        SolveRequest req = new SolveRequest();
        req.setAllowLongitudinal(false);
        req.setDemands(List.of(new PieceDemand(1, "主片", 2000, 1000, 3, false)));
        var candidates = inventory.materialCandidates(req);
        assertEquals("remnant", candidates.get(0).get("type"));
        assertEquals("REM-202609-001", candidates.get(0).get("id"));
        assertTrue(candidates.stream().anyMatch(c -> "roll".equals(c.get("type"))));
        assertFalse(candidates.stream().anyMatch(c -> "ROLL-2026-0921".equals(c.get("id"))));
        assertEquals(55000, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
}
