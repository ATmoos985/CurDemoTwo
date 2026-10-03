package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class InventoryConsistencyTests {
    @TempDir Path temp;

    @Test void failedStockWriteRestoresMemoryAndAllowsRetry() throws Exception {
        Path blocked = temp.resolve("blocked");
        RemnantService inventory = new RemnantService(blocked.resolve("state.json").toString());
        Files.writeString(blocked, "not a directory");
        assertThrows(IllegalStateException.class, () -> inventory.scrapRemnant("REM-202609-001", "damaged"));
        assertNotNull(inventory.scanOrGetById("REM-202609-001"));
        assertFalse(inventory.scanOrGetById("REM-202609-001").getDefectDesc().contains("damaged"));
        Files.delete(blocked);
        assertTrue(inventory.scrapRemnant("REM-202609-001", "damaged"));
        assertNull(new RemnantService(blocked.resolve("state.json").toString()).scanOrGetById("REM-202609-001"));
    }

    @Test void failedDefectWriteRestoresDefectsAndSequence() throws Exception {
        Path blocked = temp.resolve("blocked");
        RemnantService inventory = new RemnantService(blocked.resolve("state.json").toString());
        int before = inventory.getMotherRoll("ROLL-2026-0920").getDefects().size();
        Files.writeString(blocked, "not a directory");
        assertThrows(IllegalStateException.class, () -> inventory.addDefectToRoll("ROLL-2026-0920", new Defect(0, 0, 5000, 100, 100, 0)));
        assertEquals(before, inventory.getMotherRoll("ROLL-2026-0920").getDefects().size());
    }

    @Test void changedDefectsInvalidatePlanBeforeAnyStockWrite() {
        RemnantService inventory = new RemnantService(temp.resolve("stock.json").toString());
        CuttingWorkflowService workflow = workflow(inventory);
        SolveResponse plan = workflow.solve(request());
        double before = inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength();
        inventory.addDefectToRoll("ROLL-2026-0920", new Defect(0, 0, 5000, 2000, 1000, 0));
        assertThrows(IllegalArgumentException.class, () -> workflow.confirm(new CutReport(plan.getPlanId(), 1000, 1, List.of(), "A")));
        assertEquals(before, inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertNull(inventory.getReceipt(plan.getPlanId()));
    }

    @Test void undersizedRecoveryIsWasteAndNotStockArea() {
        RemnantService inventory = new RemnantService(temp.resolve("stock.json").toString());
        CuttingWorkflowService workflow = workflow(inventory);
        SolveResponse plan = workflow.solve(request());
        RemnantPiece proposed = plan.getRemnants().get(0);
        RemnantPiece measured = new RemnantPiece(proposed.getId(), proposed.getStatus(), proposed.getX(), proposed.getY(), 100, 1000, .1, proposed.isHasDefect());
        Map<String, Object> receipt = workflow.confirm(new CutReport(plan.getPlanId(), 2000, 1, List.of(measured), "A"));
        assertEquals(0.0, ((Number) receipt.get("remArea")).doubleValue());
        assertTrue(((List<?>) receipt.get("derivedRemnants")).isEmpty());
        assertEquals(2.0, ((Number) receipt.get("wasteArea")).doubleValue());
    }

    private CuttingWorkflowService workflow(RemnantService inventory) {
        return new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory);
    }
    private SolveRequest request() {
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false); request.setRollL(3000); request.setWindowStartY(5000);
        request.setDemands(List.of(new PieceDemand(7, "piece", 2000, 1000, 1, false)));
        return request;
    }
}
