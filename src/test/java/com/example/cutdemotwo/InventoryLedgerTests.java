package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.*;
import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class InventoryLedgerTests {
    @TempDir Path temp;
    final JsonMapper json=JsonMapper.builder().build();
    ExecutionOrderTests fixture;
    RemnantService inventory;
    FileInventoryStore file;
    @BeforeEach void setup() {
        fixture=new ExecutionOrderTests();
        file=new FileInventoryStore(temp.resolve("inventory.json").toString());
        inventory=new RemnantService(file,true);fixture.inventory=inventory;
        fixture.task=fixture.createTask(inventory,3);
    }
    List<InventoryLedgerEntry> entries() {return file.load().ledger();}
    @Test void legacyOpeningDoesNotFabricateReportsAndRepeatedWritesDoNotDuplicateHistory()throws Exception {
        var old=file.load();
        var legacy=new InventorySnapshot(old.rolls(),old.remnants(),old.receipts(),old.remnantSeq(),old.defectSeq(),
                old.tasks(),old.plans(),old.revision());
        var migrated=temp.resolve("old.json");json.writeValue(migrated.toFile(),legacy);
        var service=new RemnantService(migrated.toString());
        byte[] before=Files.readAllBytes(migrated);
        assertEquals("NOT_INITIALIZED",service.reconcileInventory().get("status"));
        assertArrayEquals(before,Files.readAllBytes(migrated),"query must not migrate or write");
        service.scrapRemnant("REM-202609-001","盘点发现损坏");
        var migratedStore=new FileInventoryStore(migrated.toString());var history=migratedStore.load().ledger();
        assertTrue(history.stream().anyMatch(e->"MIGRATION_OPENING".equals(e.eventType())));
        assertTrue(history.stream().anyMatch(e->"REMNANT_SCRAP".equals(e.eventType())));
        assertFalse(history.stream().anyMatch(e->"CUT_REPORT".equals(e.eventType())));
        assertEquals("BALANCED",service.reconcileInventory().get("status"));
        int count=history.size();service.updateStatus("REM-202609-001","SCRAPPED");
        assertEquals(count,migratedStore.load().ledger().size());
    }
    @Test void reportReplayAndReversalKeepOriginalLedgerAndBalances() {
        var p=fixture.plan(inventory,false,1);var report=fixture.report(p,1);
        fixture.workflow(inventory).confirm(report);
        var booked=entries();
        var changes=booked.stream().filter(e->"CUT_REPORT".equals(e.eventType())).toList();
        assertEquals(Set.of("ROLL","REMNANT","DEMAND","REPORT"),
                changes.stream().map(InventoryLedgerEntry::aggregateType).collect(java.util.stream.Collectors.toSet()));
        assertEquals(1,changes.stream().map(InventoryLedgerEntry::transactionId).distinct().count());
        fixture.workflow(inventory).confirm(report);assertEquals(booked,entries());
        assertEquals("BALANCED",inventory.reconcileInventory().get("status"));
        inventory.reverseReport(p.getPlanId(),"误报，实物未加工");
        var reversed=entries();
        assertEquals(booked,reversed.subList(0,booked.size()));
        assertTrue(reversed.stream().filter(e->"REPORT_REVERSE".equals(e.eventType())).allMatch(e->!e.reverses().isEmpty()));
        assertEquals("BALANCED",inventory.reconcileInventory().get("status"));
        assertEquals(55000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals("BALANCED",new RemnantService(file,false).reconcileInventory().get("status"));
    }
    @Test void qualityReclassificationChangesDemandAndOutputButNeverChargesMotherAgain() {
        var p=fixture.plan(inventory,false,2);
        fixture.workflow(inventory).confirm(fixture.report(p,2));
        long rollChanges=entries().stream().filter(e->"ROLL".equals(e.aggregateType())).count();
        var cmd=new QualityDisposition.Command("quality-ledger-01",0,1,"REMNANT","破损","验收员",
                new QualityDisposition.Recovery(0,0,500,500,"B","RECOVERABLE"));
        inventory.disposeQuality(p.getPlanId(),cmd);
        assertEquals(rollChanges,entries().stream().filter(e->"ROLL".equals(e.aggregateType())).count());
        assertEquals(1,inventory.completedQuantities(fixture.task.id()).get("1"));
        assertEquals(52000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        var reconciled=inventory.reconcileInventory();
        assertEquals("BALANCED",reconciled.get("status"),reconciled.toString());
        var current=entries();inventory.disposeQuality(p.getPlanId(),cmd);assertEquals(current,entries());
    }
    @Test void appendOnlyFileRejectsTruncationAndDoesNotChangeDisk()throws Exception {
        var before=file.load();byte[] bytes=Files.readAllBytes(temp.resolve("inventory.json"));
        var shortened=new InventorySnapshot(before.rolls(),before.remnants(),before.receipts(),before.remnantSeq(),
                before.defectSeq(),before.tasks(),before.plans(),before.revision(),before.executions(),List.of());
        assertThrows(IllegalStateException.class,()->file.save(shortened));
        assertArrayEquals(bytes,Files.readAllBytes(temp.resolve("inventory.json")));
    }
    @Test void outOfBandBalanceEditIsReportedAndCannotBeLaunderedIntoNewLedger() {
        var before=file.load();before.rolls().get(0).setStorageLocation("绕过业务修改");
        file.save(before);
        var changed=new RemnantService(file,false);
        assertEquals("MISMATCH",changed.reconcileInventory().get("status"));
        assertThrows(IllegalStateException.class,()->changed.scrapRemnant("REM-202609-001","试图覆盖差异"));
        assertEquals("AVAILABLE",changed.scanOrGetById("REM-202609-001").getStatus());
    }
    @Test void jdbcLedgerFailureRollsBackInventoryReportDemandAndSequence() {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var store=new JdbcInventoryStore(ds);var service=new RemnantService(store,true);
        fixture.task=fixture.createTask(service,3);
        var p=fixture.plan(service,false,1);
        var before=store.load();
        new org.springframework.jdbc.core.JdbcTemplate(ds).execute(
                "ALTER TABLE inventory_ledger ADD CONSTRAINT refuse_cut CHECK (event_type <> 'CUT_REPORT')");
        assertThrows(org.springframework.dao.DataAccessException.class,()->fixture.workflow(service).confirm(fixture.report(p,1)));
        assertEquals(before.ledger(),store.load().ledger());
        assertEquals(before.revision(),store.load().revision());
        assertEquals(55000,service.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertNull(service.getReceipt(p.getPlanId()));
        assertEquals("BALANCED",service.reconcileInventory().get("status"));
    }
    @Test void jdbcRefusesToRewriteOrDeletePreviouslyBookedEntries() {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var store=new JdbcInventoryStore(ds);var service=new RemnantService(store,true);
        fixture.createTask(service,3);
        var before=store.load();
        var rewritten=new ArrayList<>(before.ledger());var e=rewritten.get(0);
        rewritten.set(0,new InventoryLedgerEntry(e.id(),e.sequence(),e.transactionId(),"FAKE",e.aggregateType(),
                e.aggregateId(),e.businessId(),e.sourceReportIds(),e.actor(),e.occurredAt(),e.beforeVersion(),
                e.afterVersion(),e.reverses(),e.beforeJson(),e.afterJson()));
        var bad=new InventorySnapshot(before.rolls(),before.remnants(),before.receipts(),before.remnantSeq(),before.defectSeq(),
                before.tasks(),before.plans(),before.revision(),before.executions(),rewritten);
        assertThrows(IllegalStateException.class,()->store.save(bad));
        assertEquals(before.ledger(),store.load().ledger());
        assertEquals(before.revision(),store.load().revision());
    }
    @Test void batchPreviewAndFailedBatchNeverAppendLedger()throws Exception {
        var batchFixture=new BatchReportTests();batchFixture.temp=temp.resolve("batch");Files.createDirectories(batchFixture.temp);
        batchFixture.setup();
        var a=batchFixture.report(5000,1);var b=batchFixture.report(6000,1);
        var batchStore=new FileInventoryStore(batchFixture.temp.resolve("stock.json").toString());
        var before=batchStore.load().ledger();
        batchFixture.stock.reportBatch(List.of(a,b),true);
        assertEquals(before,batchStore.load().ledger());
        assertThrows(IllegalArgumentException.class,()->batchFixture.stock.reportBatch(List.of(a,
                new CutReport(b.planId(),0,1,List.of(),"A")),false));
        assertEquals(before,batchStore.load().ledger());
        assertNull(batchFixture.stock.getReceipt(a.planId()));
        batchFixture.stock.reportBatch(List.of(a,b),false);
        var booked=batchStore.load().ledger();
        var events=booked.subList(before.size(),booked.size());
        assertFalse(events.isEmpty());
        assertTrue(events.stream().allMatch(e->"CUT_REPORT_BATCH".equals(e.eventType())));
        assertEquals(1,events.stream().map(InventoryLedgerEntry::transactionId).distinct().count());
        assertEquals(Set.of(a.planId(),b.planId()),new HashSet<>(events.get(0).sourceReportIds()));
        batchFixture.stock.reportBatch(List.of(a,b),false);assertEquals(booked,batchStore.load().ledger());
        assertEquals("BALANCED",batchFixture.stock.reconcileInventory().get("status"));
        batchFixture.stock.reverseReport(b.planId(),"末工位误报");
        var afterReverse=batchStore.load().ledger();
        String untouchedReportEntry=events.stream().filter(e->e.aggregateType().equals("REPORT")
                && e.aggregateId().equals(a.planId())).findFirst().orElseThrow().id();
        assertTrue(afterReverse.subList(booked.size(),afterReverse.size()).stream()
                .noneMatch(e->e.reverses().contains(untouchedReportEntry)));
        assertEquals(Map.of("1",1),batchFixture.stock.completedQuantities(batchFixture.task.id()));
        assertEquals("BALANCED",batchFixture.stock.reconcileInventory().get("status"));
    }
    @Test void failedOpeningAndStockChangeLeaveLegacyFileUntouched()throws Exception {
        var old=file.load();
        var legacy=new InventorySnapshot(old.rolls(),old.remnants(),old.receipts(),old.remnantSeq(),old.defectSeq(),
                old.tasks(),old.plans(),old.revision());
        var path=temp.resolve("legacy-failure.json");json.writeValue(path.toFile(),legacy);
        var legacyStore=new FileInventoryStore(path.toString());
        byte[] before=Files.readAllBytes(path);
        var failing=new RemnantService(new InventoryStore() {
            public InventorySnapshot load(){return legacyStore.load();}
            public long save(InventorySnapshot snapshot){throw new IllegalStateException("disk failed");}
        },false);
        assertThrows(IllegalStateException.class,()->failing.scrapRemnant("REM-202609-001","损坏"));
        assertArrayEquals(before,Files.readAllBytes(path));
        assertEquals("NOT_INITIALIZED",failing.reconcileInventory().get("status"));
        assertNotNull(failing.scanOrGetById("REM-202609-001"));
    }
    @Test void standaloneReportCannotBeDeletedByDemoReset() {
        var request=new SolveRequest();request.setRollL(1000);request.setWindowStartY(5000);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"独立裁片",2000,1000,1,false)));
        var p=fixture.workflow(inventory).solve(request);
        fixture.workflow(inventory).confirm(new CutReport(p.getPlanId(),1000,1,List.of(),"A"));
        var before=entries();
        assertThrows(IllegalArgumentException.class,()->inventory.resetRoll("ROLL-2026-0920",true));
        assertEquals(before,entries());assertNotNull(inventory.getReceipt(p.getPlanId()));
        assertEquals(54000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
}
