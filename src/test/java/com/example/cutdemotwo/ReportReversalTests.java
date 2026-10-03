package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.persistence.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ReportReversalTests {
    @TempDir Path temp;
    RemnantService inventory;
    CuttingWorkflowService workflow;
    CuttingTask task;
    @BeforeEach void setup() {
        inventory = new RemnantService(temp.resolve("stock.json").toString());
        workflow = workflow(inventory);
        task = inventory.saveTask(new CuttingTask(null, "任务", "TC涤棉-B2026", "", 0,
                List.of(new CuttingTask.Line(1, "裁片", 2000, 1000, 5, false))));
    }
    CuttingWorkflowService workflow(RemnantService service) {
        return new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), service);
    }
    SolveRequest request(double start) {
        var request = new SolveRequest();
        request.setTaskId(task.id()); request.setTaskRevision(task.revision());
        request.setAllowLongitudinal(false); request.setRollL(3000); request.setWindowStartY(start);
        request.setDemands(List.of(new PieceDemand(1, "裁片", 2000, 1000, 1, false)));
        return request;
    }
    Map<String, Object> confirm(SolveRequest request) {
        var plan = workflow.solve(request);
        return workflow.confirm(new CutReport(plan.getPlanId(), "remnant".equals(request.getFeedPortType()) ? 0 : 3000,
                1, plan.getRemnants(), "A"));
    }
    @Test void reverseRestoresInventoryAndTaskAndRemainsIdempotentAfterRestart() {
        var receipt = confirm(request(5000)); String id = receipt.get("planId").toString();
        assertEquals(1, inventory.completedQuantities(task.id()).get("1"));
        inventory = new RemnantService(temp.resolve("stock.json").toString());
        inventory.reverseReport(id, "误报，现场尚未裁切");
        inventory.reverseReport(id, "重复请求");
        assertEquals(55000, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertTrue(inventory.completedQuantities(task.id()).isEmpty());
        assertEquals("REVERSED", inventory.getPlan(id).status());
        assertEquals(1, inventory.taskReports(task.id()).size());
        assertThrows(IllegalArgumentException.class, () -> workflow(inventory).confirm(new CutReport(id, 3000, 1, List.of(), "A")));
        workflow = workflow(inventory);
        assertDoesNotThrow(() -> confirm(request(5000)), "reversed interval can be planned again");
    }
    @Test void downstreamRemnantMustBeReversedBeforeParent() {
        var receipt = confirm(request(5000)); String id = receipt.get("planId").toString();
        var child = (RemnantStock) ((List<?>)receipt.get("derivedRemnants")).get(0);
        var reuse = request(0); reuse.setFeedPortType("remnant"); reuse.setSourceRemnantId(child.getId());
        reuse.setRollW(child.getWidth()); reuse.setRollL(child.getLength());
        var downstream = confirm(reuse);
        assertThrows(IllegalArgumentException.class, () -> inventory.reverseReport(id, "误报"));
        assertEquals(52000, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        inventory.reverseReport(downstream.get("planId").toString(), "后续误报");
        inventory.reverseReport(id, "原报工误报");
        assertNull(inventory.scanOrGetById(child.getId()));
        assertTrue(inventory.completedQuantities(task.id()).isEmpty());
    }
    @Test void rollReportsUnwindInReverseOrder() {
        String first = confirm(request(5000)).get("planId").toString();
        String second = confirm(request(8000)).get("planId").toString();
        assertThrows(IllegalArgumentException.class, () -> inventory.reverseReport(first, "误报"));
        inventory.reverseReport(second, "后报误报"); inventory.reverseReport(first, "前报误报");
        assertEquals(55000, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
    @Test void cancelledPlanIsPersistedAndCannotReportUntilRestored() {
        var plan = workflow.solve(request(5000)); String id = plan.getPlanId();
        inventory.changePlanStatus(id, false);
        inventory = new RemnantService(temp.resolve("stock.json").toString());
        assertEquals("CANCELLED", inventory.taskPlans(task.id()).get(0).status());
        var report = new CutReport(id, 3000, 1, plan.getRemnants(), "A");
        assertThrows(IllegalArgumentException.class, () -> workflow(inventory).confirm(report));
        inventory.changePlanStatus(id, true);
        assertDoesNotThrow(() -> workflow(inventory).confirm(report));
    }
    @Test void failedReverseSaveRestoresReceiptDemandAndInventory() {
        confirm(request(5000));
        InventoryStore file = new FileInventoryStore(temp.resolve("stock.json").toString());
        var failing = new RemnantService(new InventoryStore() {
            public InventorySnapshot load() { return file.load(); }
            public long save(InventorySnapshot snapshot) { throw new IllegalStateException("write failed"); }
        }, false);
        String id = failing.taskReports(task.id()).get(0).get("planId").toString();
        assertThrows(IllegalStateException.class, () -> failing.reverseReport(id, "误报"));
        assertEquals("CONFIRMED", failing.getReceipt(id).get("status"));
        assertEquals(1, failing.completedQuantities(task.id()).get("1"));
        assertEquals(52000, failing.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
}
