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

    @Test void legacyInventoryWithoutRevisionLoadsWithoutRewritingSource() throws Exception {
        Path path = temp.resolve("legacy.json");
        var source = new RemnantService(path.toString());
        source.scrapRemnant("REM-202609-001", "legacy");
        var mapper = new tools.jackson.databind.ObjectMapper();
        var document = (tools.jackson.databind.node.ObjectNode) mapper.readTree(path.toFile());
        document.remove("revision"); document.remove("plans");
        mapper.writeValue(path.toFile(), document);
        byte[] before = Files.readAllBytes(path);
        var restored = new RemnantService(path.toString());
        assertNull(restored.scanOrGetById("REM-202609-001"));
        assertFalse(restored.getMotherRolls().isEmpty());
        assertArrayEquals(before, Files.readAllBytes(path));
    }

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

    @Test void configuredRecoveryThresholdIsUsedForPlanningAndPersistedReport() {
        var inventory = new RemnantService(temp.resolve("settings.json").toString());
        var workflow = workflow(inventory);
        var request = request(); request.setMinRemnantWidth(50); request.setMinRemnantLength(50);
        request.setTimeLimitSeconds(7);
        var plan = workflow.solve(request);
        var stored = inventory.getPlan(plan.getPlanId());
        assertEquals(7, stored.request().getTimeLimitSeconds());
        RemnantPiece proposed = plan.getRemnants().get(0);
        var measured = new RemnantPiece(proposed.getId(), proposed.getStatus(), proposed.getX(), proposed.getY(),
                100, 1000, .1, proposed.isHasDefect());
        var receipt = workflow.confirm(new CutReport(plan.getPlanId(), 2000, 1, List.of(measured), "A"));
        assertEquals(.1, ((Number) receipt.get("remArea")).doubleValue(), .0001);
        assertEquals(1, ((List<?>) receipt.get("derivedRemnants")).size());
        var strict = request(); strict.setRollL(1500); strict.setWindowStartY(7000); strict.setMinRemnantLength(600);
        assertTrue(workflow.solve(strict).getRemnants().isEmpty(), "500 mm tail is below configured 600 mm minimum");
        var invalid = request(); invalid.setTimeLimitSeconds(0);
        assertThrows(IllegalArgumentException.class, () -> workflow.solve(invalid));
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
