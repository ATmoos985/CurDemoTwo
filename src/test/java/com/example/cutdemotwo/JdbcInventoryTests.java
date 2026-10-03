package com.example.cutdemotwo;

import com.example.cutdemotwo.model.*;
import com.example.cutdemotwo.persistence.*;
import com.example.cutdemotwo.service.*;
import com.example.cutdemotwo.service.solver.SolverFactory;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.*;
import javax.sql.DataSource;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class JdbcInventoryTests {
    @org.junit.jupiter.api.io.TempDir java.nio.file.Path temp;
    private DataSource dataSource;
    private JdbcInventoryStore store;
    @BeforeEach void database() {
        JdbcDataSource h2 = new JdbcDataSource();
        h2.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        dataSource = h2;
        Flyway.configure().dataSource(dataSource).load().migrate();
        store = new JdbcInventoryStore(dataSource);
    }
    @Test void initializedEmptyDatabaseNeverSeedsProductionAndRepeatedMigrationsKeepData() {
        assertTrue(new RemnantService(store, false).getMotherRolls().isEmpty());
        RemnantService seeded = new RemnantService(store, true);
        seeded.scrapRemnant("REM-202609-001", "test");
        Flyway.configure().dataSource(dataSource).load().migrate();
        RemnantService reopened = new RemnantService(new JdbcInventoryStore(dataSource), false);
        assertFalse(reopened.getMotherRolls().isEmpty());
        assertNull(reopened.scanOrGetById("REM-202609-001"));
    }
    @Test void transactionRollsBackAllTablesAndRevisionWhenLaterRowFails() {
        RemnantService inventory = new RemnantService(store, true);
        inventory.scrapRemnant("REM-202609-001", "test");
        InventorySnapshot before = store.load();
        double length = before.rolls().get(0).getCurrentRemainingLength();
        before.rolls().get(0).setCurrentRemainingLength(1);
        before.remnants().get(0).setStatus(null);
        assertThrows(RuntimeException.class, () -> store.save(before));
        InventorySnapshot restored = store.load();
        assertEquals(before.revision(), restored.revision());
        assertEquals(length, restored.rolls().get(0).getCurrentRemainingLength());
        assertNotNull(restored.remnants().get(0).getStatus());
    }
    @Test void staleWriterCannotOverwriteAnotherInstance() {
        RemnantService inventory = new RemnantService(store, true);
        inventory.scrapRemnant("REM-202609-001", "test");
        InventorySnapshot stale = store.load();
        inventory.scrapRemnant("REM-202609-002", "test");
        assertThrows(InventoryConflictException.class, () -> new JdbcInventoryStore(dataSource).save(stale));
        assertNull(new RemnantService(store, false).scanOrGetById("REM-202609-002"));
    }
    @Test void explicitImportPreservesSourceAndRejectsPopulatedTarget() throws Exception {
        var path = temp.resolve("inventory.json");
        var source = new RemnantService(path.toString());
        source.scrapRemnant("REM-202609-001", "import-test");
        byte[] before = java.nio.file.Files.readAllBytes(path);
        var importer = new InventoryImport(store, path.toString());
        importer.run(null);
        assertArrayEquals(before, java.nio.file.Files.readAllBytes(path));
        assertNull(new RemnantService(store, false).scanOrGetById("REM-202609-001"));
        assertThrows(IllegalStateException.class, () -> importer.run(null));
        assertThrows(IllegalStateException.class, () -> new InventoryImport(new FileInventoryStore(path.toString()), path.toString()).run(null));
    }
    @Test void persistedPlanAndIdempotentReportWorkAcrossIndependentInstances() throws Exception {
        RemnantService first = new RemnantService(store, true);
        CuttingWorkflowService workflow = workflow(first);
        SolveRequest request = new SolveRequest();
        request.setAllowLongitudinal(false); request.setRollL(3000); request.setWindowStartY(5000);
        request.setDemands(List.of(new PieceDemand(1, "piece", 2000, 1000, 1, false)));
        SolveResponse plan = workflow.solve(request);
        CuttingWorkflowService second = workflow(new RemnantService(new JdbcInventoryStore(dataSource), false));
        assertEquals("PENDING", second.getPlan(plan.getPlanId()).get("status"));
        CutReport report = new CutReport(plan.getPlanId(), 1000, 1, List.of(), "A");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            CountDownLatch start = new CountDownLatch(1);
            var a = pool.submit(() -> { start.await(); return workflow.confirm(report); });
            var b = pool.submit(() -> { start.await(); return second.confirm(report); });
            start.countDown();
            for (var result : List.of(a, b)) {
                try { assertEquals(plan.getPlanId(), result.get().get("planId")); }
                catch (ExecutionException e) { assertInstanceOf(InventoryConflictException.class, e.getCause()); }
            }
            assertEquals(plan.getPlanId(), second.confirm(report).get("planId"));
        } finally { pool.shutdownNow(); }
        assertEquals(54000, first.getMotherRoll(request.getRollId()).getCurrentRemainingLength());
        assertEquals("CONFIRMED", first.getPlan(plan.getPlanId()).status());
    }
    private CuttingWorkflowService workflow(RemnantService inventory) {
        return new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())), inventory);
    }
}
