package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.nesting.*;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.persistence.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import javax.sql.DataSource;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.example.cutdemotwo.business.optimization.OptimizationServiceTests.*;

@Timeout(15)
class JdbcOptimizationTests {
    DataSource source;
    JdbcTemplate sql;
    JdbcOptimizationJobStore a,b;
    List<OptimizationService> services=new ArrayList<>();
    @BeforeEach void setup() {
        source=OptimizationTestDatabase.create();sql=new JdbcTemplate(source);
        Flyway.configure().dataSource(source).load().migrate();
        a=store();b=store();
    }
    JdbcOptimizationJobStore store() {
        var store=new JdbcOptimizationJobStore(source);store.configure(1,1,100);return store;
    }
    @AfterEach void close(){services.forEach(OptimizationService::close);}
    StoredOptimizationJob document(String key,String hash) {
        var input=request("crosscut",1,60,false);String id=UUID.randomUUID().toString();
        var job=new OptimizationJob(id,"2.0",input.clientRequestId(),hash,"QUEUED","QUEUED",Instant.now().toString(),null,null,60,null,null,"queued");
        return new StoredOptimizationJob(key,input,job,null);
    }
    void expire(String id){sql.update("UPDATE optimization_job SET lease_until=0 WHERE id=?",id);}
    StoredOptimizationJob success(StoredOptimizationJob current) {
        return current.transition("SUCCEEDED","STOPPED",null,"done",result(current),System.currentTimeMillis());
    }
    OptimizationResult result(StoredOptimizationJob d) {
        var layout=new SolverFactory(List.of(new CrossCutSolverService())).solve(d.input().nestingProblem(),false);
        return new OptimizationResult(d.job().id(),d.job().id(),d.job().inputHash(),"2.0","PASSED","COMPLETE",true,"COMPLETED",List.of(),layout);
    }
    <T> List<T> race(Callable<T> first,Callable<T> second)throws Exception {
        var pool=Executors.newFixedThreadPool(2);var go=new CountDownLatch(1);
        try {
            var f=pool.submit(()->{go.await();return first.call();});
            var s=pool.submit(()->{go.await();return second.call();});go.countDown();
            return Arrays.asList(f.get(5,TimeUnit.SECONDS),s.get(5,TimeUnit.SECONDS));
        } finally {pool.shutdownNow();}
    }
    @Test void concurrentIdempotencyAndConflictsAreGlobalAndCaseSensitive()throws Exception {
        var results=race(()->a.submitOrGet(document("same-key","same")),()->b.submitOrGet(document("same-key","same")));
        assertEquals(results.get(0).job().id(),results.get(1).job().id());
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_job",Integer.class));
        assertEquals("IDEMPOTENCY_CONFLICT",assertThrows(OptimizationService.Failure.class,
                ()->b.submitOrGet(document("same-key","different"))).code);
        assertNotEquals(results.get(0).job().id(),b.submitOrGet(document("SAME-key","same")).job().id());
    }
    @Test void competingWorkersClaimOnlyOneAttempt()throws Exception {
        var d=a.submitOrGet(document("claim-key","hash"));
        var leases=race(()->a.claim("a",15000),()->b.claim("b",15000));
        assertEquals(1,leases.stream().filter(Objects::nonNull).count());
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_attempt",Integer.class));
        assertEquals("RUNNING",b.find(d.job().id()).job().state());
    }
    @Test void incompatibleWorkerSkipsUnsupportedHeadWithoutFailingIt() {
        var head=a.submitOrGet(document("incompatible-head","hash"));
        var next=a.submitOrGet(document("compatible-next","hash"));
        var selected=b.claim("selective",15000,d->d.job().id().equals(next.job().id()));
        assertEquals(next.job().id(),selected.document().job().id());
        assertEquals("QUEUED",a.find(head.job().id()).job().state());
        assertTrue(b.update(selected,this::success,true));
        assertNull(b.claim("unsupported",15000,d->false));
        assertEquals(head.job().id(),a.claim("compatible",15000).document().job().id());
    }
    @Test void expiredOwnerCannotRenewProgressOrOverwriteReplacementResult() {
        var d=a.submitOrGet(document("fence-key","hash"));var old=a.claim("old",15000);
        expire(d.job().id());var next=b.claim("new",15000);
        assertEquals(old.token()+1,next.token());assertNull(a.heartbeat(old,15000));
        assertFalse(a.update(old,current->current,false));
        assertFalse(a.update(old,this::success,true));
        assertTrue(b.update(next,this::success,true));
        assertFalse(a.update(old,this::success,true));
        assertEquals("SUCCEEDED",a.find(d.job().id()).job().state());
        assertEquals(next.token(),sql.queryForObject("SELECT token FROM optimization_result WHERE job_id=?",Long.class,d.job().id()));
        assertEquals(List.of("LEASE_EXPIRED","SUCCEEDED"),sql.queryForList("SELECT outcome FROM optimization_attempt ORDER BY token",String.class));
    }
    @Test void cancellationSurvivesLeaseLossAndCannotBeResurrected() {
        var d=a.submitOrGet(document("cancel-key","hash"));var lease=a.claim("a",15000);
        assertEquals("CANCEL_REQUESTED",b.cancel(d.job().id()).job().state());
        assertEquals("CANCEL_REQUESTED",a.heartbeat(lease,15000).job().state());
        assertThrows(IllegalArgumentException.class,()->a.update(lease,this::success,true));
        expire(d.job().id());assertNull(b.claim("b",15000));
        assertEquals("CANCELLED",a.find(d.job().id()).job().state());
        assertEquals(1,sql.queryForObject("SELECT COUNT(*) FROM optimization_attempt",Integer.class));
        assertFalse(a.update(lease,this::success,true));
    }
    @Test void retryKeepsOriginalDeadlineAndStopsAtThreeAttempts() {
        var d=a.submitOrGet(document("retry-key","hash"));var first=a.claim("a",15000);
        long deadline=sql.queryForObject("SELECT deadline_at FROM optimization_job WHERE id=?",Long.class,d.job().id());
        expire(d.job().id());var second=b.claim("b",15000);
        assertTrue(second.remainingMillis()<=first.remainingMillis());
        assertEquals(deadline,sql.queryForObject("SELECT deadline_at FROM optimization_job WHERE id=?",Long.class,d.job().id()));
        expire(d.job().id());assertEquals(3,a.claim("c",15000).token());
        expire(d.job().id());assertNull(b.claim("d",15000));
        assertEquals("ATTEMPTS_EXHAUSTED",a.find(d.job().id()).job().code());
        assertEquals(3,sql.queryForObject("SELECT COUNT(*) FROM optimization_attempt",Integer.class));
    }
    @Test void deadlineRequestsStopAndQueuedRetriesNeverGetFreshBudget() {
        var d=a.submitOrGet(document("deadline-key","hash"));var lease=a.claim("a",15000);
        sql.update("UPDATE optimization_job SET deadline_at=0 WHERE id=?",d.job().id());
        assertEquals("TIMED_OUT",b.heartbeat(lease,15000).job().code());
        assertFalse(a.find(d.job().id()).job().terminal());
        assertTrue(a.update(lease,current->current.transition("TIMED_OUT","STOPPED","TIMED_OUT","stopped",null,System.currentTimeMillis()),true));
        assertNull(b.claim("b",15000));
        var second=a.submitOrGet(document("queued-timeout","hash"));a.claim("a",15000);
        expire(second.job().id());sql.update("UPDATE optimization_job SET deadline_at=0 WHERE id=?",second.job().id());
        assertNull(b.claim("b",15000));assertEquals("TIMED_OUT",b.find(second.job().id()).job().state());
    }
    @Test void resultWriteFailureRollsBackJobAttemptAndResultTogether() {
        var d=a.submitOrGet(document("rollback-key","hash"));var lease=a.claim("a",15000);
        sql.execute("ALTER TABLE optimization_result ADD CONSTRAINT reject_results CHECK(token<0)");
        assertThrows(RuntimeException.class,()->a.update(lease,this::success,true));
        assertEquals("RUNNING",b.find(d.job().id()).job().state());
        assertNull(b.find(d.job().id()).result());
        assertEquals("RUNNING",sql.queryForObject("SELECT outcome FROM optimization_attempt",String.class));
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM optimization_result",Integer.class));
        sql.execute("ALTER TABLE optimization_result DROP CONSTRAINT reject_results");
        assertTrue(b.update(lease,this::success,true));
    }
    @Test void holdingTransactionLockDoesNotLetExpiredAttemptPublish() {
        var d=a.submitOrGet(document("slow-result-key","hash"));var lease=a.claim("a",100);
        assertFalse(a.update(lease,current->{
            try {Thread.sleep(160);}catch(InterruptedException error){Thread.currentThread().interrupt();throw new AssertionError(error);}
            return success(current);
        },true));
        assertNull(a.find(d.job().id()).result());
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM optimization_result",Integer.class));
        assertEquals(2,b.claim("b",15000).token());
    }
    @Test void workersWithDifferentSessionTimeZonesShareTheSameLeaseClock() {
        var west=new JdbcOptimizationJobStore(zoned("-08:00"));
        var east=new JdbcOptimizationJobStore(zoned("+08:00"));
        west.configure(1,1,100);east.configure(1,1,100);
        var d=west.submitOrGet(document("time-zone-key","hash"));
        var lease=west.claim("west",15000);
        assertNotNull(east.heartbeat(lease,15000));
        assertTrue(east.update(lease,this::success,true));
        assertEquals("SUCCEEDED",west.find(d.job().id()).job().state());
    }
    DataSource zoned(String zone) {
        return new org.springframework.jdbc.datasource.AbstractDataSource() {
            @Override public java.sql.Connection getConnection()throws java.sql.SQLException {
                var connection=source.getConnection();
                String command="MySQL".equals(connection.getMetaData().getDatabaseProductName())?"SET time_zone = ?":"SET TIME ZONE ?";
                try(var statement=connection.prepareStatement(command)){statement.setString(1,zone);statement.execute();}
                return connection;
            }
            @Override public java.sql.Connection getConnection(String user,String password)throws java.sql.SQLException{return getConnection();}
        };
    }
    @Test void globalQuotaIsSharedAndQueuedCancellationReleasesCapacity()throws Exception {
        var accepted=race(()->a.submitOrGet(document("quota-key-a","hash")),()->b.submitOrGet(document("quota-key-b","hash")));
        assertEquals("QUOTA_EXCEEDED",assertThrows(OptimizationService.Failure.class,()->a.submitOrGet(document("quota-key-c","hash"))).code);
        assertEquals("CANCELLED",b.cancel(accepted.get(0).job().id()).job().state());
        assertNotNull(a.submitOrGet(document("quota-key-c","hash")));
        assertThrows(IllegalStateException.class,()->new JdbcOptimizationJobStore(source).configure(2,1,100));
    }
    OptimizationService service(ICutSolverEngine engine) {
        var service=new OptimizationService(new SolverFactory(List.of(engine)), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new JdbcOptimizationJobStore(source),1,1,100);
        services.add(service);return service;
    }
    @Test void secondServiceDoesNotFailActiveWorkAndCanQueryAndCancelIt()throws Exception {
        var engine=new GateEngine();var first=service(engine);
        try {
            var job=first.submit("shared-service-key",request("gate",1,10,false));
            assertTrue(engine.entered.await(2,TimeUnit.SECONDS));
            var second=service(engine);
            assertEquals("RUNNING",second.get(job.id()).state());
            assertEquals(job.id(),second.submit("shared-service-key",request("gate",1,10,false)).id());
            assertEquals("CANCEL_REQUESTED",second.cancel(job.id()).state());
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
            while(!engine.interrupted.get()&&System.nanoTime()<until)Thread.sleep(10);
            assertTrue(engine.interrupted.get());engine.release.countDown();
            assertEquals("CANCELLED",finished(second,job.id()).state());
            assertEquals("CANCELLED",first.result(job.id()).terminationReason());
        } finally {engine.release.countDown();}
    }
    @Test void anotherServiceReadsDurableResultAndDuplicateWithoutCurrentEngine()throws Exception {
        var first=service(new CrossCutSolverService());
        var input=request("crosscut",1,3,false);var job=first.submit("durable-service-key",input);
        assertEquals("SUCCEEDED",finished(first,job.id()).state());
        first.close();
        var second=new OptimizationService(new SolverFactory(List.of()), new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),new JdbcOptimizationJobStore(source),1,1,100);services.add(second);
        assertEquals(job.id(),second.submit("durable-service-key",input).id());
        assertEquals("PASSED",second.result(job.id()).validationStatus());
        assertEquals(input,second.input(job.id()));
    }
    @Test void closingOneNodeDoesNotCancelDurableQueuedJobs()throws Exception {
        var engine=new GateEngine();var first=service(engine);
        try {
            var running=first.submit("closing-running",request("gate",1,10,false));assertTrue(engine.entered.await(2,TimeUnit.SECONDS));
            var queued=first.submit("closing-queued",request("gate",1,10,false));
            engine.release.countDown();first.close();
            assertEquals("QUEUED",a.find(queued.id()).job().state());
            assertNotEquals("CANCELLED",a.find(running.id()).job().state());
            var second=service(engine);
            expire(running.id()); // Simulate the dead node's lease reaching database expiry.
            assertEquals("SUCCEEDED",finished(second,queued.id()).state());
        } finally {engine.release.countDown();}
    }
    @Test void archiveLimitEvictsOldestTerminalJobsInForeignKeyOrderAndRejectsWhenAllActive()throws Exception {
        var limitedSource=OptimizationTestDatabase.create();
        var limitedSql=new JdbcTemplate(limitedSource);
        Flyway.configure().dataSource(limitedSource).load().migrate();
        var store=new JdbcOptimizationJobStore(limitedSource,168L);
        store.configure(1,2,2);

        var first=store.submitOrGet(document("jdbc-evict-1","hash-1"));
        var lease1=store.claim("w1",15000);
        assertTrue(store.update(lease1,this::success,true));
        Thread.sleep(15);

        var second=store.submitOrGet(document("jdbc-evict-2","hash-2"));
        var lease2=store.claim("w1",15000);
        assertTrue(store.update(lease2,this::success,true));
        assertEquals(2,limitedSql.queryForObject("SELECT COUNT(*) FROM optimization_job",Integer.class));
        assertEquals(2,limitedSql.queryForObject("SELECT COUNT(*) FROM optimization_result",Integer.class));

        // 达到 archive=2 上限时，提交第 3 个作业应按外键顺序淘汰最旧终态 first
        var third=store.submitOrGet(document("jdbc-evict-3","hash-3"));
        assertNull(store.find(first.job().id()));
        assertNull(store.findByKey("jdbc-evict-1"));
        assertNotNull(store.find(second.job().id()));
        assertNotNull(store.find(third.job().id()));
        assertEquals(2,limitedSql.queryForObject("SELECT COUNT(*) FROM optimization_job",Integer.class));
        assertEquals(0,limitedSql.queryForObject("SELECT COUNT(*) FROM optimization_result WHERE job_id=?",Integer.class,first.job().id()));
        assertEquals(0,limitedSql.queryForObject("SELECT COUNT(*) FROM optimization_attempt WHERE job_id=?",Integer.class,first.job().id()));

        // 再提交第 4 个作业会淘汰 second，此时库中两个作业 third + fourth 均为活跃态
        var fourth=store.submitOrGet(document("jdbc-evict-4","hash-4"));
        assertNull(store.find(second.job().id()));
        assertEquals("QUEUED",store.find(third.job().id()).job().state());
        assertEquals("QUEUED",store.find(fourth.job().id()).job().state());

        // 当全部已存作业均为活跃态达到 archive=2 上限时，必须严格返回 429 QUOTA_EXCEEDED 且不删除活跃作业
        var rejected=assertThrows(OptimizationService.Failure.class,()->store.submitOrGet(document("jdbc-evict-5","hash-5")));
        assertEquals("QUOTA_EXCEEDED",rejected.code);
        assertEquals(429,rejected.status);
        assertNotNull(store.find(third.job().id()));
        assertNotNull(store.find(fourth.job().id()));
    }
    @Test void purgeExpiredTerminalDeletesCompletedAndArchivedEntriesWithoutTouchingActive() {
        var done=a.submitOrGet(document("jdbc-purge-done","hash-done"));
        var lease=a.claim("w1",15000);
        assertTrue(a.update(lease,this::success,true));
        // 模拟存在 archive_entry 外键引用，确保清理顺序能无错删除
        sql.update("INSERT INTO optimization_archive_import(id,source_path,imported_at,job_count) VALUES('imp-1','/tmp',1,1)");
        sql.update("INSERT INTO optimization_archive_entry(import_id,job_id,original_json) VALUES('imp-1',?,'{}')",done.job().id());
        var active=a.submitOrGet(document("jdbc-purge-active","hash-active"));

        assertEquals(1,a.purgeExpiredTerminal(0L));
        assertNull(a.find(done.job().id()));
        assertEquals(0,sql.queryForObject("SELECT COUNT(*) FROM optimization_archive_entry WHERE job_id=?",Integer.class,done.job().id()));
        assertNotNull(a.find(active.job().id()));
    }
}
