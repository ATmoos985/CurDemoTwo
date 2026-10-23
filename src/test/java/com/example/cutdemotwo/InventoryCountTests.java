package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class InventoryCountTests {
    @TempDir Path temp;
    FileInventoryStore store;RemnantService service;
    final JsonMapper json=JsonMapper.builder().build();
    @BeforeEach void setup(){
        store=new FileInventoryStore(temp.resolve("stock.json").toString());service=new RemnantService(store,true);
        service.saveOrUpdateMotherRoll(json.convertValue(service.getMotherRoll("ROLL-2026-0920"),MotherRollInfo.class));
    }
    InventoryCount.Observation roll(double length){return new InventoryCount.Observation("roll","ROLL-2026-0920",length>0,2000,length);}
    InventoryCount.Observation remnant(boolean present,double width,double length){return new InventoryCount.Observation("remnant","REM-202609-001",present,width,length);}
    InventoryCount.Command command(RemnantService s,InventoryCount.Observation... observations){
        return new InventoryCount.Command(((Number)s.countOptions().get("revision")).longValue(),"实物复核差异","盘点人",List.of(observations));
    }
    @Test void measuredBalancePostsAtomicDocumentAndDoesNotInventProduction() {
        var before=store.load();var input=command(service,roll(54000),remnant(true,1900,1550));
        var doc=service.countInventory("count-mixed-001",input);var after=store.load();
        var r=service.getMotherRoll("ROLL-2026-0920");assertEquals(5000,r.getUsedLength());assertEquals(59000,r.getTotalLength());assertEquals(54000,r.getCurrentRemainingLength());
        assertEquals(-2,doc.lines().get(0).differenceAreaM2(),1e-9);
        assertEquals(before.receipts(),after.receipts());assertEquals(before.tasks(),after.tasks());
        var changed=after.ledger().stream().filter(e->"INVENTORY_COUNT".equals(e.eventType())).toList();
        assertEquals(3,changed.size());assertEquals(1,changed.stream().map(InventoryLedgerEntry::transactionId).distinct().count());
        assertTrue(changed.stream().allMatch(e->doc.id().equals(e.businessId())));
        assertEquals(1,after.outbox().size());assertEquals(3,after.outbox().get(0).changes().size());
        assertEquals("BALANCED",service.reconcileInventory().get("status"));
        var restarted=new RemnantService(store,false);assertEquals(doc,restarted.countInventory("count-mixed-001",input));
        assertEquals(after.ledger(),store.load().ledger());assertEquals(after.outbox(),store.load().outbox());
        assertEquals(after.revision(),store.load().revision(),"重放回执不能推进库存版本");
        assertThrows(InventoryConflictException.class,()->restarted.countInventory("count-mixed-001",command(restarted,roll(55000))));
    }
    @Test void missingAndRecoveredMaterialRetainsGeometryLineageAndStaysQuarantined() {
        var before=json.valueToTree(service.scanOrGetById("REM-202609-001"));
        var missing=service.countInventory("count-missing-01",command(service,remnant(false,2000,0)));
        assertEquals(-3.2,missing.lines().get(0).differenceAreaM2(),1e-9);
        var lost=store.load().remnants().stream().filter(r->"REM-202609-001".equals(r.getId())).findFirst().orElseThrow();
        assertEquals(1600,lost.getLength());assertEquals("LOST",lost.getStatus());
        assertFalse(service.getAvailableRemnants().stream().anyMatch(r->lost.getId().equals(r.getId())));
        assertThrows(InventoryConflictException.class,()->service.scrapRemnant(lost.getId(),"误报废"));
        assertThrows(InventoryConflictException.class,()->service.consumeRemnant(lost.getId()));
        assertThrows(InventoryConflictException.class,()->service.updateStatus(lost.getId(),"AVAILABLE"));
        var found=service.countInventory("count-found-0001",command(service,remnant(true,2000,1600)));
        assertEquals(3.2,found.lines().get(0).differenceAreaM2(),1e-9);
        var recovered=json.valueToTree(store.load().remnants().stream().filter(r->lost.getId().equals(r.getId())).findFirst().orElseThrow());
        ((tools.jackson.databind.node.ObjectNode)before).put("status","QUARANTINED");assertEquals(before,recovered);
        var snapshot=json.valueToTree(store.load());
        assertThrows(InventoryConflictException.class,()->service.consumeRemnant(lost.getId()));
        assertThrows(InventoryConflictException.class,()->service.updateStatus(lost.getId(),"AVAILABLE"));
        assertEquals(snapshot,json.valueToTree(store.load()));
        assertEquals("BALANCED",service.reconcileInventory().get("status"));
    }
    @Test void observationsAreReadonlyAndInvalidBatchesLeaveNoPartialDocument()throws Exception {
        byte[] before=Files.readAllBytes(temp.resolve("stock.json"));service.countOptions();service.inventoryCounts();
        for(var input:List.of(command(service,roll(54000),new InventoryCount.Observation("remnant","missing",true,1,1)),
                command(service,roll(54000),roll(54000)),command(service,remnant(true,2000,0)),
                command(service,roll(Double.NaN)),command(service,remnant(false,1900,0)))) {
            assertThrows(RuntimeException.class,()->service.countInventory(UUID.randomUUID().toString(),input));
            assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
        }
        assertThrows(InventoryConflictException.class,()->service.countInventory("count-defect-001",command(service,roll(40000))));
        assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
    @Test void countHistoryCannotBeDeletedOrHiddenByDemoReset() {
        service.countInventory("count-no-delta-01",command(service,remnant(true,2000,1600)));
        var before=store.load();assertEquals(1,before.counts().size());assertEquals(1,before.outbox().size());
        assertThrows(InventoryConflictException.class,()->service.resetRoll("ROLL-2026-0920",true));
        assertThrows(IllegalStateException.class,()->store.save(new InventorySnapshot(before.rolls(),before.remnants(),before.receipts(),before.remnantSeq(),before.defectSeq(),before.tasks(),before.plans(),before.revision(),before.executions(),before.ledger(),before.transfers(),before.outbox())));
        assertEquals(before.counts(),store.load().counts());
    }
    @Test void reservationsBlockCountsAndRoundTripMeasurementNeverRevivesAnOldPlan() {
        var f=new ExecutionOrderTests();f.task=f.createTask(service,3);var p=f.plan(service,false,1);
        var e=f.change(service,f.draft(service,p),"release",300);
        assertThrows(InventoryConflictException.class,()->service.countInventory("count-reserved-01",command(service,roll(54000))));
        f.change(service,e,"cancel",0);
        service.countInventory("count-out-000001",command(service,roll(54000)));
        service.countInventory("count-back-00001",command(service,roll(55000)));
        assertThrows(RuntimeException.class,()->f.workflow(service).confirm(f.report(p,1)));
        assertTrue(store.load().receipts().isEmpty());
    }
    @Test void countAfterReportBlocksUndoEvenWhenTheMeasuredBalanceIsUnchanged() {
        var f=new ExecutionOrderTests();f.task=f.createTask(service,3);var p=f.plan(service,false,1);f.workflow(service).confirm(f.report(p,1));
        var receipts=json.valueToTree(store.load().receipts());var areas=service.reconcileInventory().get("areas");
        service.countInventory("count-after-cut1",command(service,roll(52000)));
        assertThrows(InventoryConflictException.class,()->service.reverseReport(p.getPlanId(),"不能覆盖盘点"));
        assertEquals(receipts,json.valueToTree(store.load().receipts()));assertEquals(areas,service.reconcileInventory().get("areas"));
    }
    @Test void newReportAfterCountCanReverseWithoutErasingCountedBalance() {
        service.countInventory("count-before-cut",command(service,roll(54000)));
        var f=new ExecutionOrderTests();f.task=f.createTask(service,3);var p=f.plan(service,false,1);f.workflow(service).confirm(f.report(p,1));
        service.reverseReport(p.getPlanId(),"更正报工");
        assertEquals(54000,service.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertEquals(59000,service.getMotherRoll("ROLL-2026-0920").getTotalLength());
        assertEquals(1,service.inventoryCounts().size());assertEquals("BALANCED",service.reconcileInventory().get("status"));
    }
    @Test void jdbcFailureRollsBackBalancesDocumentLedgerAndOutboxAndStaleInstanceCannotOverwrite() {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var db=new JdbcInventoryStore(ds);var first=new RemnantService(db,true);var second=new RemnantService(new JdbcInventoryStore(ds),false);
        var before=json.valueToTree(db.load());var input=command(first,roll(54000));var sql=new org.springframework.jdbc.core.JdbcTemplate(ds);
        sql.execute("ALTER TABLE inventory_count ADD CONSTRAINT refuse_count CHECK (inventory_revision < 0)");
        assertThrows(org.springframework.dao.DataAccessException.class,()->first.countInventory("count-jdbc-0001",input));
        assertEquals(before,json.valueToTree(db.load()));
        sql.execute("ALTER TABLE inventory_count DROP CONSTRAINT refuse_count");
        var doc=first.countInventory("count-jdbc-0001",input);
        assertThrows(InventoryConflictException.class,()->second.countInventory("count-jdbc-0002",input));
        var afterReplay=json.valueToTree(db.load());
        assertEquals(doc,second.countInventory("count-jdbc-0001",input));
        assertEquals(afterReplay,json.valueToTree(db.load()));
        assertEquals("BALANCED",second.reconcileInventory().get("status"));
    }
}
