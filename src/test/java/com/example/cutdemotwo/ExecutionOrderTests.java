package com.example.cutdemotwo;

import com.example.cutdemotwo.algorithm.solver.*;
import com.example.cutdemotwo.business.cutting.*;
import com.example.cutdemotwo.business.model.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class ExecutionOrderTests {
    @TempDir Path temp;
    RemnantService inventory;
    CuttingTask task;
    @BeforeEach void setup() {
        inventory=new RemnantService(temp.resolve("inventory.json").toString());
        task=createTask(inventory,3);
    }
    CuttingTask createTask(RemnantService service,int quantity) {
        return service.saveTask(new CuttingTask(null,"执行任务","TC涤棉-B2026","",0,
                List.of(new CuttingTask.Line(1,"裁片",2000,1000,quantity,false))));
    }
    CuttingWorkflowService workflow(RemnantService service) {
        return new CuttingWorkflowService(new SolverFactory(List.of(new CrossCutSolverService())),service);
    }
    SolveResponse plan(RemnantService service,boolean remnant,int quantity) {
        var request=new SolveRequest();
        request.setTaskId(task.id());request.setTaskRevision(task.revision());
        request.setAllowLongitudinal(false);request.setRollL(remnant?1600:3000);
        request.setWindowStartY(remnant?0:5000);request.setFeedPortType(remnant?"remnant":"roll");
        request.setSourceRemnantId(remnant?"REM-202609-001":null);
        request.setDemands(List.of(new PieceDemand(1,"裁片",2000,1000,quantity,false)));
        var result=workflow(service).solve(request);
        assertFalse(result.getPieces().isEmpty());
        return result;
    }
    ExecutionOrder draft(RemnantService service,SolveResponse plan) {
        return service.createExecution(UUID.randomUUID().toString(),new ExecutionOrder.Create(plan.getPlanId(),"裁床 A"));
    }
    ExecutionOrder change(RemnantService service,ExecutionOrder e,String action,int seconds) {
        return service.changeExecution(e.id(),action,new ExecutionOrder.Command(UUID.randomUUID().toString(),e.version(),seconds,"测试"));
    }
    ExecutionOrder state(RemnantService service,String id) {
        return (ExecutionOrder)service.executionOrder(id).get("execution");
    }
    CutReport report(SolveResponse plan,int good) {
        return new CutReport(plan.getPlanId(),3000,good,plan.getRemnants(),"A");
    }
    @Test void releaseStartReportAndReplaySurviveRestart() {
        var p=plan(inventory,false,2);var e=draft(inventory,p);
        var command=new ExecutionOrder.Command("release-operation",1,300,"下达");
        e=inventory.changeExecution(e.id(),"release",command);
        assertEquals(e,inventory.changeExecution(e.id(),"release",command));
        String id=e.id();
        assertThrows(InventoryConflictException.class,()->inventory.changeExecution(id,"release",
                new ExecutionOrder.Command("release-operation",1,301,"下达")));
        e=change(inventory,e,"start",0);
        final var running=e;
        assertThrows(InventoryConflictException.class,()->change(inventory,running,"cancel",0));
        var receipt=inventory.reportExecution(id,report(p,2));
        assertEquals("REPORTED",state(inventory,id).state());
        assertEquals(false,inventory.executionOrder(id).get("reservationActive"));
        inventory=new RemnantService(temp.resolve("inventory.json").toString());
        var json=new tools.jackson.databind.ObjectMapper();
        assertEquals(json.valueToTree(receipt),json.valueToTree(inventory.reportExecution(id,report(p,2))));
        assertThrows(InventoryConflictException.class,()->inventory.reportExecution(id,
                new CutReport(p.getPlanId(),3000,2,p.getRemnants(),"different")));
        assertEquals(2,inventory.completedQuantities(task.id()).get("1"));
        assertEquals(52000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
    @Test void wholeMaterialReservationBlocksOtherPlansAndLegacyWrites() {
        var p=plan(inventory,false,1);var other=plan(inventory,false,1);
        var e=change(inventory,draft(inventory,p),"release",300);
        var competing=draft(inventory,other);
        assertThrows(InventoryConflictException.class,()->change(inventory,competing,"release",300));
        assertThrows(InventoryConflictException.class,()->workflow(inventory).confirm(report(other,1)));
        assertThrows(InventoryConflictException.class,()->workflow(inventory).confirm(report(p,1)));
        assertThrows(InventoryConflictException.class,()->inventory.resetRoll("ROLL-2026-0920",true));
        assertThrows(InventoryConflictException.class,()->inventory.changePlanStatus(p.getPlanId(),false));
        assertThrows(InventoryConflictException.class,()->inventory.saveTask(new CuttingTask(task.id(),task.name(),
                task.materialModel(),"changed",task.revision(),task.demands())));
        change(inventory,e,"cancel",0);
        assertEquals("RELEASED",change(inventory,competing,"release",300).state());
    }
    @Test void demandReservationProtectsDifferentMaterialAndLegacyReport() {
        task=createTask(inventory,1);
        var p=plan(inventory,false,1);var other=plan(inventory,true,1);
        var e=change(inventory,draft(inventory,p),"release",300);
        assertThrows(IllegalArgumentException.class,()->workflow(inventory).confirm(
                new CutReport(other.getPlanId(),0,1,List.of(),"A")));
        var competing=draft(inventory,other);
        assertThrows(InventoryConflictException.class,()->change(inventory,competing,"release",300));
        change(inventory,e,"cancel",0);
        assertEquals("RELEASED",change(inventory,competing,"release",300).state());
    }
    @Test void expiredReservationUsesStoreClockAndCannotBeResurrectedAlongsideReplacement() {
        var file=new FileInventoryStore(temp.resolve("inventory.json").toString());
        var clock=new java.util.concurrent.atomic.AtomicLong(10_000);
        inventory=new RemnantService(new InventoryStore() {
            public InventorySnapshot load(){return file.load();}
            public long save(InventorySnapshot snapshot){return file.save(snapshot);}
            public long now(){return clock.get();}
        },false);
        var p=plan(inventory,false,1);var old=change(inventory,draft(inventory,p),"release",1);
        assertEquals(11_000,old.expiresAt());
        clock.set(11_000);
        assertEquals("EXPIRED",inventory.executionOrder(old.id()).get("effectiveState"));
        assertThrows(InventoryConflictException.class,()->change(inventory,old,"start",0));
        var replacement=change(inventory,draft(inventory,p),"release",300);
        assertThrows(InventoryConflictException.class,()->change(inventory,old,"release",300));
        change(inventory,replacement,"start",0);
        inventory.reportExecution(replacement.id(),report(p,1));
        assertEquals("REPORTED",state(inventory,replacement.id()).state());
    }
    @Test void failedReportSaveRollsBackStockDemandExecutionAndReceipt() {
        var p=plan(inventory,false,1);
        var e=change(inventory,change(inventory,draft(inventory,p),"release",300),"start",0);
        var file=new FileInventoryStore(temp.resolve("inventory.json").toString());
        var failing=new RemnantService(new InventoryStore() {
            public InventorySnapshot load(){return file.load();}
            public long save(InventorySnapshot snapshot){throw new IllegalStateException("disk failed");}
        },false);
        assertThrows(IllegalStateException.class,()->failing.reportExecution(e.id(),report(p,1)));
        assertEquals("RUNNING",state(failing,e.id()).state());
        assertEquals(55000,failing.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
        assertTrue(failing.completedQuantities(task.id()).isEmpty());
        assertTrue(failing.taskReports(task.id()).isEmpty());
        assertEquals("RUNNING",state(new RemnantService(file,false),e.id()).state());
    }
    @Test void legacyUppercaseFeedTypeCannotConsumeReservedRemnant() {
        var p=plan(inventory,true,1);
        change(inventory,draft(inventory,p),"release",300);
        var request=new SolveRequest();
        request.setFeedPortType("REMNANT");request.setSourceRemnantId("REM-202609-001");
        request.setRollL(1600);request.setWindowStartY(0);request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"旧入口",2000,1000,1,false)));
        var legacy=workflow(inventory).solve(request);
        assertThrows(InventoryConflictException.class,()->workflow(inventory).confirm(
                new CutReport(legacy.getPlanId(),0,1,List.of(),"A")));
        assertEquals("AVAILABLE",inventory.scanOrGetById("REM-202609-001").getStatus());
    }
    @Test void reservedDerivedRemnantProtectsItsParentReportAndRollReset() {
        var p=plan(inventory,false,1);
        var receipt=workflow(inventory).confirm(report(p,1));
        var child=(RemnantStock)((List<?>)receipt.get("derivedRemnants")).get(0);
        var request=new SolveRequest();
        request.setTaskId(task.id());request.setTaskRevision(task.revision());
        request.setFeedPortType("remnant");request.setSourceRemnantId(child.getId());
        request.setRollW(child.getWidth());request.setRollL(child.getLength());request.setWindowStartY(0);
        request.setAllowLongitudinal(false);
        request.setDemands(List.of(new PieceDemand(1,"裁片",2000,1000,1,false)));
        var reuse=workflow(inventory).solve(request);
        change(inventory,draft(inventory,reuse),"release",300);
        assertThrows(InventoryConflictException.class,()->inventory.reverseReport(p.getPlanId(),"误报"));
        assertThrows(InventoryConflictException.class,()->inventory.resetRoll("ROLL-2026-0920",true));
        assertNotNull(inventory.scanOrGetById(child.getId()));
        assertEquals(52000,inventory.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
    }
    @Test void independentJdbcInstancesCannotReserveSameMaterialConcurrently() throws Exception {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var first=new RemnantService(new JdbcInventoryStore(ds),true);
        task=createTask(first,3);
        var a=draft(first,plan(first,false,1));var b=draft(first,plan(first,false,1));
        var second=new RemnantService(new JdbcInventoryStore(ds),false);
        var pool=Executors.newFixedThreadPool(2);
        try {
            var start=new CountDownLatch(1);
            var one=pool.submit(()->{start.await();return change(first,a,"release",300);});
            var two=pool.submit(()->{start.await();return change(second,b,"release",300);});
            start.countDown();int successes=0;
            for(var future:List.of(one,two))try {assertEquals("RELEASED",future.get().state());successes++;}
            catch(ExecutionException error){assertInstanceOf(InventoryConflictException.class,error.getCause());}
            assertEquals(1,successes);
        } finally {pool.shutdownNow();}
        var restored=new RemnantService(new JdbcInventoryStore(ds),false);
        assertEquals(1,restored.executionOrders(task.id()).stream().filter(v->Boolean.TRUE.equals(v.get("reservationActive"))).count());
    }
    @Test void jdbcReportFailureRollsBackEveryAggregateAfterEarlierTableUpdates() {
        var ds=OptimizationTestDatabase.create();Flyway.configure().dataSource(ds).load().migrate();
        var first=new RemnantService(new JdbcInventoryStore(ds),true);
        task=createTask(first,3);
        var p=plan(first,false,1);
        var e=change(first,change(first,draft(first,p),"release",300),"start",0);
        var store=new JdbcInventoryStore(ds);long revision=store.load().revision();
        new org.springframework.jdbc.core.JdbcTemplate(ds).execute(
                "ALTER TABLE execution_order ADD CONSTRAINT reject_report CHECK (state <> 'REPORTED')");
        assertThrows(org.springframework.dao.DataAccessException.class,()->first.reportExecution(e.id(),report(p,1)));
        for(var service:List.of(first,new RemnantService(new JdbcInventoryStore(ds),false))) {
            assertEquals("RUNNING",state(service,e.id()).state());
            assertEquals(55000,service.getMotherRoll("ROLL-2026-0920").getCurrentRemainingLength());
            assertTrue(service.completedQuantities(task.id()).isEmpty());
            assertTrue(service.taskReports(task.id()).isEmpty());
        }
        assertEquals(revision,store.load().revision());
    }
}
