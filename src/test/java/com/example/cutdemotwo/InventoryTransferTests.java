package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class InventoryTransferTests {
    @TempDir Path temp;
    FileInventoryStore store;
    RemnantService service;
    final JsonMapper json=JsonMapper.builder().build();
    final InventoryTransfer.Material roll=new InventoryTransfer.Material("roll","ROLL-2026-0920");
    final InventoryTransfer.Material remnant=new InventoryTransfer.Material("remnant","REM-202609-001");
    @BeforeEach void setup(){store=new FileInventoryStore(temp.resolve("stock.json").toString());service=new RemnantService(store,true);new ExecutionOrderTests().createTask(service,3);}
    InventoryTransfer.Command command(RemnantService s,String destination,InventoryTransfer.Material... materials){
        return new InventoryTransfer.Command(((Number)s.transferOptions().get("revision")).longValue(),destination,"转至待料区","仓管员",List.of(materials));
    }
    @Test void mixedTransferChangesOnlyLocationsAndPostsOneAtomicJournalTransaction() {
        var before=store.load();var input=command(service,"B-02",roll,remnant);
        var document=service.transferInventory("mixed-transfer-1",input);
        var after=store.load();
        assertEquals(before.revision()+1,document.inventoryRevision());
        assertEquals("B-02",service.getMotherRoll(roll.id()).getStorageLocation());
        assertEquals("B-02",service.scanOrGetById(remnant.id()).getLocation());
        before.rolls().stream().filter(r->r.getRollId().equals(roll.id())).findFirst().orElseThrow().setStorageLocation("B-02");
        before.remnants().stream().filter(r->r.getId().equals(remnant.id())).findFirst().orElseThrow().setLocation("B-02");
        assertEquals(json.valueToTree(before.rolls()),json.valueToTree(after.rolls()));
        assertEquals(json.valueToTree(before.remnants()),json.valueToTree(after.remnants()));
        assertEquals(before.receipts(),after.receipts());assertEquals(before.tasks(),after.tasks());
        var movements=after.ledger().stream().filter(e->e.eventType().equals("INVENTORY_TRANSFER")).toList();
        assertEquals(3,movements.size());assertEquals(1,movements.stream().map(e->e.transactionId()).distinct().count());
        assertTrue(movements.stream().allMatch(e->document.id().equals(e.businessId())));
        assertEquals("BALANCED",service.reconcileInventory().get("status"));
        var restarted=new RemnantService(store,false);
        assertEquals(document,restarted.transferInventory("mixed-transfer-1",input));
        assertEquals(after.ledger(),store.load().ledger());assertEquals(List.of(document),restarted.inventoryTransfers());
        assertThrows(InventoryConflictException.class,()->restarted.transferInventory("mixed-transfer-1",command(restarted,"C",roll)));
    }
    @Test void queriesAreReadOnlyAndEveryInvalidBatchRollsBack() throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        service.transferOptions();service.inventoryTransfers();
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
        var missing=new InventoryTransfer.Material("remnant","missing");
        for(var materials:List.of(List.of(roll,missing),List.of(roll,roll),List.<InventoryTransfer.Material>of())) {
            var input=new InventoryTransfer.Command(store.load().revision(),"C","原因","仓管",materials);
            assertThrows(RuntimeException.class,()->service.transferInventory(UUID.randomUUID().toString(),input));
            assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
        }
        assertThrows(IllegalArgumentException.class,()->service.transferInventory("same-location",command(service,service.getMotherRoll(roll.id()).getStorageLocation(),roll)));
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
    @Test void staleSelectionCannotMoveMaterialAndPostedDocumentsCannotBeDeleted() {
        var stale=command(service,"C",roll);
        service.transferInventory("first-movement",command(service,"B",remnant));
        assertThrows(InventoryConflictException.class,()->service.transferInventory("stale-movement",stale));
        var before=store.load();
        var withoutDocuments=new InventorySnapshot(before.rolls(),before.remnants(),before.receipts(),before.remnantSeq(),before.defectSeq(),before.tasks(),before.plans(),before.revision(),before.executions(),before.ledger());
        assertThrows(IllegalStateException.class,()->store.save(withoutDocuments));
        assertEquals(before.transfers(),store.load().transfers());
    }
    @Test void reservationsAndScrapBlockMovementButQuarantineRemainsQuarantined() {
        var fixture=new ExecutionOrderTests();fixture.inventory=service;fixture.task=fixture.createTask(service,3);
        var execution=fixture.change(service,fixture.draft(service,fixture.plan(service,false,1)),"release",300);
        assertThrows(InventoryConflictException.class,()->service.transferInventory("reserved-move",command(service,"B",roll)));
        fixture.change(service,execution,"cancel",0);
        service.updateStatus(remnant.id(),"QUARANTINED");
        service.transferInventory("quarantine-move",command(service,"隔离库",remnant));
        assertEquals("QUARANTINED",store.load().remnants().stream().filter(r->r.getId().equals(remnant.id())).findFirst().orElseThrow().getStatus());
        service.scrapRemnant(remnant.id(),"损坏");
        assertThrows(InventoryConflictException.class,()->service.transferInventory("scrapped-move",command(service,"C",remnant)));
    }
    @Test void legacyRollUpdateCannotBypassTransferDocument() {
        var rollCopy=json.convertValue(service.getMotherRoll(roll.id()),com.example.cutdemotwo.business.model.MotherRollInfo.class);
        rollCopy.setStorageLocation("绕过移库");
        var before=json.valueToTree(store.load());
        assertThrows(IllegalArgumentException.class,()->service.saveOrUpdateMotherRoll(rollCopy));
        assertEquals(before,json.valueToTree(store.load()));
    }
    @Test void demoResetCannotUndoPostedRemnantOrRollTransfers() {
        service.transferInventory("remnant-reset-guard",command(service,"B",remnant));
        var before=json.valueToTree(store.load());
        assertThrows(InventoryConflictException.class,()->service.resetRoll(roll.id(),true));
        assertEquals(before,json.valueToTree(store.load()));
    }
    @Test void jdbcFailureAfterMaterialUpdatesRollsBackEverythingAndRestartReplays() {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var jdbcStore=new JdbcInventoryStore(ds);var first=new RemnantService(jdbcStore,true);
        var second=new RemnantService(new JdbcInventoryStore(ds),false);
        var stale=command(second,"C",roll);var input=command(first,"B",roll,remnant);
        var before=json.valueToTree(jdbcStore.load());
        var sql=new org.springframework.jdbc.core.JdbcTemplate(ds);
        sql.execute("ALTER TABLE inventory_transfer ADD CONSTRAINT refuse_transfer CHECK (inventory_revision < 0)");
        assertThrows(org.springframework.dao.DataAccessException.class,()->first.transferInventory("jdbc-transfer",input));
        assertEquals(before,json.valueToTree(jdbcStore.load()));
        sql.execute("ALTER TABLE inventory_transfer DROP CONSTRAINT refuse_transfer");
        var doc=first.transferInventory("jdbc-transfer",input);
        assertThrows(InventoryConflictException.class,()->second.transferInventory("jdbc-stale",stale));
        assertEquals(doc,second.transferInventory("jdbc-transfer",input));
        assertEquals("BALANCED",second.reconcileInventory().get("status"));
        var after=jdbcStore.load();
        assertThrows(IllegalStateException.class,()->jdbcStore.save(new InventorySnapshot(after.rolls(),after.remnants(),after.receipts(),after.remnantSeq(),after.defectSeq(),after.tasks(),after.plans(),after.revision(),after.executions(),after.ledger())));
        assertEquals(after.revision(),jdbcStore.load().revision());
    }
}
