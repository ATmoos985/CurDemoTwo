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

class InventoryOutboxTests {
    @TempDir Path temp;
    final JsonMapper json=JsonMapper.builder().build();
    FileInventoryStore file;RemnantService inventory;ExecutionOrderTests fixture;
    @BeforeEach void setup(){
        file=new FileInventoryStore(temp.resolve("stock.json").toString());inventory=new RemnantService(file,true);
        fixture=new ExecutionOrderTests();fixture.inventory=inventory;fixture.task=fixture.createTask(inventory,3);
    }
    @Test void migrationAndDemoAreNotReplayedAsNewExternalConsumption()throws Exception {
        var old=file.load();var path=temp.resolve("legacy.json");
        var document=json.valueToTree(old);((tools.jackson.databind.node.ObjectNode)document).remove("outbox");
        json.writeValue(path.toFile(),document);
        var service=new RemnantService(path.toString());assertTrue(service.integrationEvents().isEmpty());
        byte[] before=Files.readAllBytes(path);service.integrationEvents();assertArrayEquals(before,Files.readAllBytes(path));
        service.prepareOrderDemoInventory();assertTrue(service.integrationEvents().isEmpty());
        service.scrapRemnant("REM-202609-001","现场报废");
        assertEquals(1,service.integrationEvents().size());var event=service.integrationEvents().get(0);
        assertEquals("REMNANT_SCRAP",event.action());assertEquals(1,event.sequence());
        assertTrue(event.changes().stream().noneMatch(e->"MIGRATION_OPENING".equals(e.eventType())));
    }
    @Test void reportQualityAndReversalKeepStableTransactionIdentitiesAndNoDuplicateConsumption(){
        var plan=fixture.plan(inventory,false,2);var report=fixture.report(plan,2);fixture.workflow(inventory).confirm(report);
        var posted=inventory.integrationEvents();var event=posted.get(posted.size()-1);
        assertEquals("CUT_REPORT",event.action());assertTrue(event.changes().stream().allMatch(e->e.transactionId().equals(event.id())));
        fixture.workflow(inventory).confirm(report);assertEquals(posted,inventory.integrationEvents());
        var quality=new QualityDisposition.Command("outbox-quality-0001",0,1,"REMNANT","破损","验收员",
                new QualityDisposition.Recovery(0,0,500,500,"B","RECOVERABLE"));
        inventory.disposeQuality(plan.getPlanId(),quality);var changed=inventory.integrationEvents();
        assertEquals(posted.size()+1,changed.size());var qualityEvent=changed.get(changed.size()-1);
        assertTrue(qualityEvent.changes().stream().noneMatch(e->e.aggregateType().equals("ROLL")));
        inventory.disposeQuality(plan.getPlanId(),quality);assertEquals(changed,inventory.integrationEvents());
        assertEquals(changed,new RemnantService(file,false).integrationEvents());
    }
    @Test void reversalAddsNewFactsAndPreservesOriginalEvent(){
        var plan=fixture.plan(inventory,false,1);fixture.workflow(inventory).confirm(fixture.report(plan,1));
        var before=inventory.integrationEvents();inventory.reverseReport(plan.getPlanId(),"错误报工");
        var after=inventory.integrationEvents();assertEquals(before,after.subList(0,before.size()));
        assertEquals("REPORT_REVERSE",after.get(after.size()-1).action());
        assertTrue(after.get(after.size()-1).changes().stream().allMatch(e->!e.reverses().isEmpty()));
    }
    @Test void fileRejectsEventDeletionWithoutChangingInventory()throws Exception {
        var s=file.load();byte[] before=Files.readAllBytes(temp.resolve("stock.json"));
        var truncated=new InventorySnapshot(s.rolls(),s.remnants(),s.receipts(),s.remnantSeq(),s.defectSeq(),s.tasks(),s.plans(),
                s.revision(),s.executions(),s.ledger(),s.transfers(),List.of());
        assertThrows(IllegalStateException.class,()->file.save(truncated));assertArrayEquals(before,Files.readAllBytes(temp.resolve("stock.json")));
    }
    @Test void jdbcEventInsertFailureRollsBackEveryBusinessChange(){
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var store=new JdbcInventoryStore(ds);var service=new RemnantService(store,true);fixture.task=fixture.createTask(service,3);
        var plan=fixture.plan(service,false,1);var before=json.writeValueAsString(store.load());
        new org.springframework.jdbc.core.JdbcTemplate(ds).execute("ALTER TABLE inventory_outbox ADD CONSTRAINT refuse_new CHECK (event_sequence < 2)");
        assertThrows(org.springframework.dao.DataAccessException.class,()->fixture.workflow(service).confirm(fixture.report(plan,1)));
        assertEquals(json.readTree(before),json.readTree(json.writeValueAsString(store.load())));assertNull(service.getReceipt(plan.getPlanId()));
        assertEquals(store.load().outbox(),service.integrationEvents());assertEquals("BALANCED",service.reconcileInventory().get("status"));
    }
    @Test void successfulJdbcCommitSurvivesReopenWithTheSameEvent(){
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var store=new JdbcInventoryStore(ds);var service=new RemnantService(store,true);service.scrapRemnant("REM-202609-001","损坏");
        assertEquals(1,service.integrationEvents().size());assertEquals(service.integrationEvents(),new RemnantService(new JdbcInventoryStore(ds),false).integrationEvents());
    }
}
