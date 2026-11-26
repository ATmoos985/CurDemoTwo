package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.nesting.EngineCapabilities;

import com.example.cutdemotwo.algorithm.nesting.*;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.*;
import com.example.cutdemotwo.persistence.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;

class OptimizationServiceTests {
    @TempDir Path temp;
    List<OptimizationService> services=new ArrayList<>();
    @AfterEach void close(){services.forEach(OptimizationService::close);}
    static OptimizationRequest request(String engine,int quantity,int seconds,boolean fallback){
        var problem=new NestingProblem("1","mm",new NestingProblem.Material("external-only",NestingProblem.Shape.rectangle(2000,3000),List.of(),false),
                List.of(new NestingProblem.Part(42,"piece",NestingProblem.Shape.rectangle(2000,1000),quantity,false)),
                new NestingProblem.Process("CROSSCUT","SHEET","left-top","horizontal",0,200,300,0,"INPUT_ORDER"),engine,seconds);
        return new OptimizationRequest("2.0","NESTING_2D","client-001",problem,fallback,true);
    }
    OptimizationService service(SolverFactory solvers,OptimizationJobStore store,int queue,int max){
        var service=new OptimizationService(solvers, new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),store,1,queue,max);services.add(service);return service;
    }
    OptimizationService service(ICutSolverEngine engine){return service(new SolverFactory(List.of(engine)),new FileOptimizationJobStore(temp.resolve("jobs")),1,100);}
    static OptimizationJob finished(OptimizationService s,String id)throws Exception{
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(!s.get(id).terminal() && System.nanoTime()<deadline)Thread.sleep(10);
        assertTrue(s.get(id).terminal(),s.get(id).toString());return s.get(id);
    }
    static class GateEngine implements ICutSolverEngine {
        CountDownLatch entered=new CountDownLatch(1), release=new CountDownLatch(1);
        AtomicBoolean interrupted=new AtomicBoolean();
        public String getEngineType(){return "gate";}
        public boolean isAvailable(){return true;}
        public EngineCapabilities capabilities(){return new EngineCapabilities("gate","1",List.of("RECTANGLE"),List.of("CROSSCUT"),List.of("INPUT_ORDER"),.1,true);}
        public EngineResult solve(NestingProblem p){
            entered.countDown();boolean done=false;
            while(!done)try{done=release.await(3,TimeUnit.SECONDS);}catch(InterruptedException e){interrupted.set(true);}
            return new CrossCutSolverService().solve(p);
        }
    }
    @Test void validatedCompleteResultIsDurableAndIdempotentAcrossRestart()throws Exception{
        var s=service(new CrossCutSolverService());var input=request("crosscut",3,3,false);
        var job=s.submit("key-complete",input);assertEquals("SUCCEEDED",finished(s,job.id()).state());
        var result=s.result(job.id());assertEquals("COMPLETE",result.fulfillmentStatus());assertTrue(result.meetsRequirement());
        assertEquals("PASSED",result.validationStatus());assertEquals(100,result.metrics().get(0).value());
        assertEquals(6000000,result.metrics().get(0).denominator());assertEquals(64,result.inputHash().length());
        assertEquals(job.id(),s.submit("key-complete",input).id());s.close();
        var reopened=service(new SolverFactory(List.of(new CrossCutSolverService())),new FileOptimizationJobStore(temp.resolve("jobs")),1,100);
        assertEquals(result,reopened.result(job.id()));assertEquals(job.id(),reopened.submit("key-complete",input).id());assertEquals(input,reopened.input(job.id()));
        assertEquals("IDEMPOTENCY_CONFLICT",assertThrows(OptimizationService.Failure.class,()->reopened.submit("key-complete",request("crosscut",2,3,false))).code);
    }
    @Test void feasiblePartialResultIsNotCompleteAndNoSolutionIsNotProvenInfeasible()throws Exception{
        var s=service(new CrossCutSolverService());var job=s.submit("key-partial",request("crosscut",4,3,false));
        assertEquals("SUCCEEDED",finished(s,job.id()).state());var result=s.result(job.id());
        assertEquals("PARTIAL",result.fulfillmentStatus());assertFalse(result.meetsRequirement());assertEquals("FEASIBLE",result.layout().status());
        var r=request("crosscut",1,3,false);var p=r.nestingProblem();
        var impossible=new NestingProblem(p.schemaVersion(),p.unit(),p.material(),List.of(new NestingProblem.Part(42,"long",NestingProblem.Shape.rectangle(2000,4000),1,false)),p.process(),p.engine(),p.timeLimitSeconds());
        var empty=s.submit("key-no-solution",new OptimizationRequest("2.0","NESTING_2D","client-2",impossible,false,true));
        assertEquals("SUCCEEDED",finished(s,empty.id()).state());assertEquals("NO_SOLUTION_FOUND",s.result(empty.id()).layout().status());assertEquals("NONE",s.result(empty.id()).fulfillmentStatus());
    }
    @Test void queueLimitsRejectBeforeAcceptanceAndCancelledQueuedJobsNeverExecute()throws Exception{
        var engine=new GateEngine();var s=service(engine);
        try {
            var running=s.submit("key-running",request("gate",1,3,false));assertTrue(engine.entered.await(1,TimeUnit.SECONDS));
            var queued=s.submit("key-queued",request("gate",1,3,false));
            assertEquals("QUOTA_EXCEEDED",assertThrows(OptimizationService.Failure.class,()->s.submit("key-overflow",request("gate",1,3,false))).code);
            assertEquals("CANCELLED",s.cancel(queued.id()).state());assertNull(s.get(queued.id()).startedAt());
            assertEquals(s.cancel(queued.id()),s.cancel(queued.id()));
            var replacement=s.submit("key-replacement",request("gate",1,3,false));s.cancel(replacement.id());
            engine.release.countDown();assertEquals("SUCCEEDED",finished(s,running.id()).state());
            assertThrows(OptimizationService.Failure.class,()->s.result(queued.id()));
        }finally{engine.release.countDown();}
    }
    @Test void cancellationWaitsForActualEngineExitAndPreservesValidatedBestResult()throws Exception{
        var engine=new GateEngine();var s=service(engine);
        try {
            var job=s.submit("key-cancel",request("gate",1,3,false));assertTrue(engine.entered.await(1,TimeUnit.SECONDS));
            assertEquals("CANCEL_REQUESTED",s.cancel(job.id()).state());assertFalse(s.get(job.id()).terminal());
            assertEquals("CANCEL_REQUESTED",s.cancel(job.id()).state());
            engine.release.countDown();assertEquals("CANCELLED",finished(s,job.id()).state());assertTrue(engine.interrupted.get());
            assertEquals("CANCELLED",s.result(job.id()).terminationReason());assertEquals("PASSED",s.result(job.id()).validationStatus());
            assertEquals("CANCELLED",s.cancel(job.id()).state());
        }finally{engine.release.countDown();}
    }
    @Test void timeoutRequestsStopWithoutPretendingUninterruptibleEngineAlreadyStopped()throws Exception{
        var engine=new GateEngine();var s=service(engine);
        try {
            var job=s.submit("key-timeout",request("gate",1,1,false));assertTrue(engine.entered.await(1,TimeUnit.SECONDS));
            long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);
            while(!"CANCEL_REQUESTED".equals(s.get(job.id()).state())&&System.nanoTime()<until)Thread.sleep(10);
            assertEquals("CANCEL_REQUESTED",s.get(job.id()).state());assertEquals("TIMED_OUT",s.get(job.id()).code());assertNull(s.get(job.id()).finishedAt());
            engine.release.countDown();assertEquals("TIMED_OUT",finished(s,job.id()).state());assertEquals("TIME_LIMIT",s.result(job.id()).terminationReason());
        }finally{engine.release.countDown();}
    }
    @Test void restartMarksAcceptedUnfinishedWorkFailedInsteadOfLosingOrSilentlyRecomputing(){
        Path dir=temp.resolve("jobs");String id=UUID.randomUUID().toString();
        try(var store=new FileOptimizationJobStore(dir)){
            var job=new OptimizationJob(id,"2.0","client-001","hash","RUNNING","SOLVING",Instant.now().toString(),Instant.now().toString(),null,3,null,null,null);
            store.save(new StoredOptimizationJob("restart-key",request("crosscut",1,3,false),job,null));
        }
        var s=service(new SolverFactory(List.of(new CrossCutSolverService())),new FileOptimizationJobStore(dir),1,100);
        assertEquals("FAILED",s.get(id).state());assertEquals("PROCESS_RESTARTED",s.get(id).code());assertNull(s.get(id).resultRef());
        assertThrows(OptimizationService.Failure.class,()->s.result(id));
    }
    @Test void oneDirectoryCannotBeOwnedByTwoDispatchersAndCorruptionIsNotSilentlyReset()throws Exception{
        Path dir=temp.resolve("jobs");try(var store=new FileOptimizationJobStore(dir)){
            assertThrows(IllegalStateException.class,()->new FileOptimizationJobStore(dir));
        }
        Files.writeString(dir.resolve(UUID.randomUUID()+".json"),"broken");
        assertThrows(IllegalStateException.class,()->service(new SolverFactory(List.of(new CrossCutSolverService())),new FileOptimizationJobStore(dir),1,100));
        try(var files=Files.list(dir)){assertTrue(files.anyMatch(p->p.toString().endsWith(".json")));}
    }
    @Test void failureBeforeAcceptanceLeavesNoPhantomIdempotencyKeyOrJob() {
        var backing=new FileOptimizationJobStore(temp.resolve("jobs"));var failing=new AtomicBoolean(true);
        var store=new OptimizationJobStore(){public List<StoredOptimizationJob> load(){return backing.load();}public void save(StoredOptimizationJob d){if(failing.get())throw new IllegalStateException("disk full");backing.save(d);}public void close(){backing.close();}};
        var s=service(new SolverFactory(List.of(new CrossCutSolverService())),store,1,100);
        assertThrows(IllegalStateException.class,()->s.submit("disk-key-001",request("crosscut",1,3,false)));
        assertTrue(backing.load().isEmpty());failing.set(false);
        assertNotNull(s.submit("disk-key-001",request("crosscut",1,3,false)));
    }
    @Test void failedResultPersistenceNeverPublishesAnUncommittedResult()throws Exception{
        var backing=new FileOptimizationJobStore(temp.resolve("jobs"));
        var store=new OptimizationJobStore(){public List<StoredOptimizationJob> load(){return backing.load();}public void save(StoredOptimizationJob d){if(d.result()!=null)throw new IllegalStateException("result write failed");backing.save(d);}public void close(){backing.close();}};
        var s=service(new SolverFactory(List.of(new CrossCutSolverService())),store,1,100);
        var j=s.submit("result-disk-key",request("crosscut",1,3,false));assertEquals("FAILED",finished(s,j.id()).state());
        assertThrows(OptimizationService.Failure.class,()->s.result(j.id()));assertNull(backing.load().get(0).result());
    }
    @Test void archiveLimitEvictsOldestTerminalJobsAndClearsIdempotencyKeys()throws Exception{
        Path dir=temp.resolve("jobs-evict");
        var s=service(new SolverFactory(List.of(new CrossCutSolverService())),new FileOptimizationJobStore(dir),2,2);
        var input=request("crosscut",1,3,false);
        var j1=s.submit("archive-key-1",input);assertEquals("SUCCEEDED",finished(s,j1.id()).state());
        Thread.sleep(15);
        var j2=s.submit("archive-key-2",input);assertEquals("SUCCEEDED",finished(s,j2.id()).state());
        // 幂等重放命中已有作业，不触发淘汰
        assertEquals(j1.id(),s.submit("archive-key-1",input).id());
        // 达到上限 maxStored=2 时，新提交自动滚动淘汰最旧终态作业 j1，不再返回 429
        var j3=s.submit("archive-key-3",input);assertEquals("SUCCEEDED",finished(s,j3.id()).state());
        assertEquals(404,assertThrows(OptimizationService.Failure.class,()->s.get(j1.id())).status);
        assertFalse(Files.exists(dir.resolve(j1.id()+".json")),"被淘汰终态作业的磁盘文件应一并删除");
        assertEquals("SUCCEEDED",s.get(j2.id()).state());
        assertEquals("SUCCEEDED",s.get(j3.id()).state());
        assertEquals(2,new FileCount(dir).count());
        // 旧幂等键已随淘汰清理，不会留下悬空引用，复用该键可受理新作业
        var j4=s.submit("archive-key-1",input);assertNotEquals(j1.id(),j4.id());
        assertEquals("SUCCEEDED",finished(s,j4.id()).state());
    }
    @Test void archiveLimitRejectsWithQuotaExceededWhenAllStoredJobsAreActive()throws Exception{
        var engine=new GateEngine();
        var s=service(new SolverFactory(List.of(engine)),new FileOptimizationJobStore(temp.resolve("jobs-active-full")),2,2);
        try {
            var j1=s.submit("active-key-1",request("gate",1,5,false));assertTrue(engine.entered.await(2,TimeUnit.SECONDS));
            var j2=s.submit("active-key-2",request("gate",1,5,false));
            var rejected=assertThrows(OptimizationService.Failure.class,()->s.submit("active-key-3",request("gate",1,5,false)));
            assertEquals("QUOTA_EXCEEDED",rejected.code);
            assertEquals(429,rejected.status);
            assertEquals("RUNNING",s.get(j1.id()).state());
            assertEquals("QUEUED",s.get(j2.id()).state());
        } finally {engine.release.countDown();}
    }
    @Test void expiredTerminalJobsArePurgedByCleanupWhileActiveJobsRemain()throws Exception{
        Path dir=temp.resolve("jobs-ttl");
        var engine=new GateEngine();
        var s=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService(),engine)),
                new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),
                new FileOptimizationJobStore(dir),1,2,10,0L,"768m");
        services.add(s);
        try {
            var done=s.submit("ttl-done-key",request("crosscut",1,3,false));
            assertEquals("SUCCEEDED",finished(s,done.id()).state());
            var active=s.submit("ttl-active-key",request("gate",1,5,false));
            assertTrue(engine.entered.await(2,TimeUnit.SECONDS));
            assertEquals(1,s.cleanupExpiredTerminalJobs());
            assertEquals(404,assertThrows(OptimizationService.Failure.class,()->s.get(done.id())).status);
            assertFalse(Files.exists(dir.resolve(done.id()+".json")));
            assertEquals("RUNNING",s.get(active.id()).state());
        } finally {engine.release.countDown();}
    }
    @Test void capabilitiesReportsDynamicSlittingHeapAndSeparateTimeLimits() {
        var s=new OptimizationService(new SolverFactory(List.of(new CrossCutSolverService())),
                new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine("384m"),
                new FileOptimizationJobStore(temp.resolve("jobs-cap-384")),2,8,500,72L,"384m");
        services.add(s);
        var cap=s.capabilities();
        @SuppressWarnings("unchecked") var slitting=(Map<String,Object>)cap.get("slittingEngine");
        @SuppressWarnings("unchecked") var limits=(Map<String,Object>)cap.get("limits");
        assertEquals(384,slitting.get("maxHeapMiB"));
        assertEquals(180,slitting.get("maxTimeLimitSeconds"));
        assertEquals(60,limits.get("maxTimeLimitSeconds"));
        assertEquals(60,limits.get("maxNestingTimeLimitSeconds"));
        assertEquals(180,limits.get("maxSlittingTimeLimitSeconds"));
        assertEquals(72L,limits.get("terminalRetentionHours"));
        assertEquals(1024,OptimizationService.parseHeapMiB("1g"));
        assertEquals(768,OptimizationService.parseHeapMiB("768m"));
    }
    @Test void concurrentRepeatedSubmissionRunsOneJob()throws Exception{
        var engine=new GateEngine();var s=service(engine);var pool=Executors.newFixedThreadPool(6);
        try {
            var futures=new ArrayList<Future<OptimizationJob>>();
            for(int i=0;i<6;i++)futures.add(pool.submit(()->s.submit("parallel-key",request("gate",1,3,false))));
            var ids=new HashSet<String>();for(var future:futures)ids.add(future.get().id());assertEquals(1,ids.size());
            assertEquals(1,new FileCount(temp.resolve("jobs")).count());
            engine.release.countDown();assertEquals("SUCCEEDED",finished(s,ids.iterator().next()).state());
        } finally {engine.release.countDown();pool.shutdownNow();}
    }
    @Test @Timeout(90) void acceptedJobsAreNotRejectedDuringWorkerHandoff() throws Exception {
        final int jobCount = 10_000;
        var completions = new Semaphore(0);
        var store=new OptimizationJobStore(){
            public List<StoredOptimizationJob> load(){return List.of();}
            public void save(StoredOptimizationJob document){
                if (document.job().terminal()) completions.release();
            }
            public void close(){}
        };
        var s=service(new SolverFactory(List.of(new CrossCutSolverService())),store,1,jobCount);
        var ids=new ArrayList<String>();
        int observedCompletions = 0;
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(60);
        while(ids.size()<jobCount && System.nanoTime()<deadline) {
            try {
                var job=s.submit("handoff-"+ids.size(),request("crosscut",1,3,false));
                assertNotEquals("QUEUE_REJECTED",job.code(),"Durably accepted work must not be lost at worker handoff");
                ids.add(job.id());
            } catch(OptimizationService.Failure full) {
                assertEquals("QUOTA_EXCEEDED",full.code);
                // A terminal save can arrive before this wait. Retry submit to check actual capacity.
                assertTrue(completions.tryAcquire(deadline - System.nanoTime(), TimeUnit.NANOSECONDS),
                        () -> "Timed out waiting for a completion after accepting " + ids.size() + " jobs");
                observedCompletions++;
            }
        }
        assertEquals(jobCount,ids.size());
        assertTrue(completions.tryAcquire(jobCount - observedCompletions, 5, TimeUnit.SECONDS),
                "All accepted jobs must reach a terminal state");
        for(String id:ids)assertEquals("SUCCEEDED",s.get(id).state(),id);
    }
    private record FileCount(Path path){long count()throws Exception{try(var files=Files.list(path)){return files.filter(p->p.toString().endsWith(".json")).count();}}}
    @Test void invalidEngineOutputIsFailedWithoutPublishingUnsafeGeometry()throws Exception{
        ICutSolverEngine invalid=new ICutSolverEngine(){
            public String getEngineType(){return "bad";}public boolean isAvailable(){return true;}
            public EngineCapabilities capabilities(){return new EngineCapabilities("bad","1",List.of("RECTANGLE"),List.of("CROSSCUT"),List.of("INPUT_ORDER"),.1,true);}
            public EngineResult solve(NestingProblem p){var r=new CrossCutSolverService().solve(p);r.getPieces().get(0).setX(99999);return r;}
        };
        var s=service(invalid);var j=s.submit("bad-output-key",request("bad",1,3,false));
        var done=finished(s,j.id());assertEquals("FAILED",done.state());assertEquals("INVALID_RESULT",done.code());assertNull(done.resultRef());
        assertThrows(OptimizationService.Failure.class,()->s.result(j.id()));
    }
    @Test void strictFallbackAndValidationDoNotExecuteAnyEngine(){
        var count=new java.util.concurrent.atomic.AtomicInteger();
        ICutSolverEngine unavailable=new ICutSolverEngine(){public String getEngineType(){return "packingsolver";}public boolean isAvailable(){return false;}public EngineCapabilities capabilities(){return new EngineCapabilities("packingsolver","1",List.of("RECTANGLE"),List.of("GUILLOTINE"),List.of("MAXIMIZE_PIECE_AREA"),.1,false);}public EngineResult solve(NestingProblem p){count.incrementAndGet();throw new AssertionError();}};
        var factory=new SolverFactory(List.of(unavailable,new JavaGuillotineSolverEngine()));
        var p=request("packingsolver",1,3,false).nestingProblem();
        p=new NestingProblem("1","mm",p.material(),p.parts(),new NestingProblem.Process("GUILLOTINE","SHEET","left-top","horizontal",0,200,300,0,"MAXIMIZE_PIECE_AREA"),"packingsolver",3);
        assertEquals("UNAVAILABLE",factory.validateProblem(p,false).status());assertEquals("VALID",factory.validateProblem(p,true).status());
        assertEquals("UNAVAILABLE",factory.solve(p,false).status());assertEquals(0,count.get());
    }
}
