package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.solver.SolverFactory;
import com.example.cutdemotwo.contracts.jobs.*;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import com.example.cutdemotwo.persistence.*;
import org.springframework.beans.factory.annotation.*;
import org.springframework.stereotype.Service;
import jakarta.annotation.PreDestroy;
import tools.jackson.databind.json.JsonMapper;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/** Job application layer. File mode is exclusive; shared mode uses transactional leases. No inventory writes. */
@Service
public class OptimizationService implements AutoCloseable {
    public static class Failure extends RuntimeException {
        public final String code; public final int status; public final boolean retryable;
        public Failure(String code, String message, int status, boolean retryable) { super(message);this.code=code;this.status=status;this.retryable=retryable; }
    }
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(OptimizationService.class);
    private final SolverFactory solvers;
    private final OptimizationJobStore store;
    private final LeasedOptimizationJobStore shared;
    private final String owner=UUID.randomUUID().toString();
    private static final long LEASE_MILLIS=15000;
    private static final class LocalLease {
        final LeasedOptimizationJobStore.Lease lease;
        volatile boolean lost;
        LocalLease(LeasedOptimizationJobStore.Lease lease){this.lease=lease;}
    }
    private final Map<String,LocalLease> leases=new HashMap<>();
    private final int workers, queueCapacity, maxStored;
    private final ThreadPoolExecutor executor;
    private final ScheduledExecutorService timer;
    private final Map<String,StoredOptimizationJob> documents = new LinkedHashMap<>();
    private final Map<String,String> keys = new HashMap<>();
    private final Map<String,Runnable> pending = new HashMap<>();
    private final Map<String,Thread> running = new HashMap<>();
    private final JsonMapper json = JsonMapper.builder().build();
    private boolean closing, storageFailed;

    @Autowired
    public OptimizationService(SolverFactory solvers, OptimizationJobStore store,
            @Value("${cutdemo.jobs.workers:2}") int workers,
            @Value("${cutdemo.jobs.queue-capacity:16}") int queueCapacity,
            @Value("${cutdemo.jobs.max-stored:1000}") int maxStored) {
        this.solvers=solvers;this.store=store;this.workers=workers;this.queueCapacity=queueCapacity;this.maxStored=maxStored;
        this.shared=store instanceof LeasedOptimizationJobStore leased?leased:null;
        if (workers<1 || workers>16 || queueCapacity<1 || queueCapacity>1000 || maxStored<1) {
            store.close();throw new IllegalArgumentException("计算作业并发、排队或归档限额配置无效");
        }
        // pending bounds accepted work to workers + queueCapacity. A finishing task releases
        // that permit just before ThreadPoolExecutor releases its worker; reserve handoff slots
        // so an already persisted replacement cannot be rejected during that brief interval.
        executor = new ThreadPoolExecutor(workers,workers,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(workers+queueCapacity),r->{var t=new Thread(r,"optimization-worker");t.setDaemon(true);return t;});
        timer = Executors.newSingleThreadScheduledExecutor(r->{var t=new Thread(r,"optimization-deadline");t.setDaemon(true);return t;});
        try {
            if(shared!=null) {
                shared.configure(workers,queueCapacity,maxStored);
                timer.scheduleWithFixedDelay(this::dispatch,0,200,TimeUnit.MILLISECONDS);
            } else for (var document : store.load()) {
                var job=document.job();
                if (keys.putIfAbsent(document.idempotencyKey(),job.id())!=null || documents.putIfAbsent(job.id(),document)!=null)
                    throw new IllegalStateException("作业存储中存在重复身份或幂等键");
                if (!job.terminal()) persist(transition(document,"FAILED","STOPPED", "PROCESS_RESTARTED","服务重启打断了作业；未自动重算，请使用新的幂等键重试",null));
            }
        } catch(RuntimeException error) {executor.shutdownNow();timer.shutdownNow();store.close();throw error;}
    }

    public Map<String,Object> capabilities() {
        return Map.of("schemaVersion","2.0","problemTypes",List.of("NESTING_2D"),"inputProfile","nesting-v1",
                "engines",solvers.capabilities(),"limits",Map.of("workers",workers,"queueCapacity",queueCapacity,"maxStoredJobs",maxStored,
                        "maxRequestBytes",262144,"maxPieces",10000,"maxContourPieces",200,"maxTimeLimitSeconds",60),
                "features",Map.of("polling",true,"cancellation","cooperative-request","hardPreemption",false,"progress","phase-only",
                        "storage",shared==null?"single-dispatcher-local-files":"jdbc-leases","distributedWorkers",shared!=null,"sse",false,"inventoryWrites",false),
                "units",Map.of("length","mm","area","mm2"),
                "strategies",List.of(Map.of("id","marker-shortening","version","1","maxTrials",12)));
    }

    public SolverFactory.ProblemCheck validate(OptimizationRequest request) {
        if (request == null || request.problem()==null || request.allowFallback()==null || request.requireComplete()==null
                || request.clientRequestId()==null || request.clientRequestId().isBlank() || request.clientRequestId().length()>128)
            throw new Failure("INVALID_INPUT","必须提供问题、明确的降级/齐套选项及 1–128 字调用方请求编号",400,false);
        if (!"2.0".equals(request.schemaVersion()) || !"NESTING_2D".equals(request.problemType()))
            throw new Failure("UNSUPPORTED_CONSTRAINT","当前仅支持 schemaVersion=2.0、NESTING_2D 与 nesting-v1 输入",422,false);
        var check=solvers.validateProblem(request.problem(),request.allowFallback());
        if (!"VALID".equals(check.status())) throw switch(check.status()) {
            case "INVALID_INPUT" -> new Failure("INVALID_INPUT",check.message(),400,false);
            case "UNAVAILABLE" -> new Failure("ENGINE_UNAVAILABLE",check.message(),503,true);
            default -> new Failure("UNSUPPORTED_CONSTRAINT",check.message(),422,false);
        };
        MarkerOptimization.validate(request);
        return check;
    }

    public synchronized OptimizationJob submit(String key, OptimizationRequest input) {
        if (key==null || !key.matches("[A-Za-z0-9._:-]{8,128}")) throw new Failure("INVALID_INPUT","Idempotency-Key 必须为 8–128 个字母、数字或 . _ : -",400,false);
        if (input==null) throw new Failure("INVALID_INPUT","请求不能为空",400,false);
        if(shared!=null) {
            var existing=shared.findByKey(key);
            if(existing!=null) {
                if(!existing.job().inputHash().equals(hash(input)))throw new Failure("IDEMPOTENCY_CONFLICT","同一幂等键已绑定不同请求",409,false);
                return existing.job();
            }
            if(closing)throw new Failure("SERVICE_UNAVAILABLE","作业服务正在关闭",503,true);
            validate(input);
            String id=UUID.randomUUID().toString();
            var job=new OptimizationJob(id,"2.0",input.clientRequestId(),hash(input),"QUEUED","QUEUED",Instant.now().toString(),null,null,
                    input.problem().timeLimitSeconds(),null,null,"已持久化，等待计算");
            return shared.submitOrGet(new StoredOptimizationJob(key,input,job,null)).job();
        }
        String hash=hash(input), existing=keys.get(key);
        if (existing!=null) {
            var old=documents.get(existing);
            if (!old.job().inputHash().equals(hash)) throw new Failure("IDEMPOTENCY_CONFLICT","同一幂等键已绑定不同请求",409,false);
            return old.job();
        }
        if (closing || storageFailed) throw new Failure("SERVICE_UNAVAILABLE","作业服务暂不可受理，请检查服务与持久化状态",503,true);
        validate(input);
        if (pending.size()>=workers+queueCapacity || documents.size()>=maxStored)
            throw new Failure("QUOTA_EXCEEDED","作业并发/排队或归档限额已满；查询已有作业后重试，归档限额需运维扩容",429,true);
        String id=UUID.randomUUID().toString();
        var job=new OptimizationJob(id,"2.0",input.clientRequestId(),hash,"QUEUED","QUEUED",Instant.now().toString(),null,null,input.problem().timeLimitSeconds(),null,null,"已持久化，等待计算");
        persist(new StoredOptimizationJob(key,input,job,null));keys.put(key,id);
        Runnable task=()->execute(id);pending.put(id,task);
        try { executor.execute(task); }
        catch (RejectedExecutionException rejected) {
            pending.remove(id);
            persist(transition(documents.get(id),"FAILED","STOPPED","QUEUE_REJECTED","队列已关闭，请使用新的幂等键重试",null));
        }
        return documents.get(id).job();
    }

    public synchronized OptimizationJob get(String id) {return required(id).job();}
    public synchronized OptimizationRequest input(String id) {return required(id).input();}
    public synchronized OptimizationResult result(String id) {
        var document=required(id);
        if (document.result()==null) throw new Failure("RESULT_NOT_AVAILABLE","作业尚无已归档的验证结果，请查看作业状态",409,!document.job().terminal());
        return document.result();
    }
    private StoredOptimizationJob required(String id) {
        var document=shared==null?documents.get(id):shared.find(id);
        if (document==null) throw new Failure("NOT_FOUND","计算作业或结果不存在",404,false);
        return document;
    }
    public synchronized OptimizationJob cancel(String id) {
        if(shared!=null) {
            var document=shared.cancel(id);
            if(document==null)throw new Failure("NOT_FOUND","计算作业或结果不存在",404,false);
            var thread=running.get(id);if(thread!=null && !document.job().terminal())thread.interrupt();
            return document.job();
        }
        var document=required(id);
        if (document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return document.job();
        boolean started=running.containsKey(id);
        persist(transition(document,started?"CANCEL_REQUESTED":"CANCELLED",started?"STOPPING":"STOPPED","CANCELLED","调用方请求取消",null));
        if (started) running.get(id).interrupt();
        else {var task=pending.remove(id);if(task!=null)executor.remove(task);}
        return documents.get(id).job();
    }
    private synchronized void deadline(String id) {
        var document=documents.get(id);
        if (document==null || document.job().terminal() || "CANCEL_REQUESTED".equals(document.job().state())) return;
        try {persist(transition(document,"CANCEL_REQUESTED","STOPPING","TIMED_OUT","已到求解时限，等待计算退出",null));}
        catch(RuntimeException error){storageFailed=true;log.error("Cannot persist optimization timeout",error);}
        var thread=running.get(id);if(thread!=null)thread.interrupt();
    }
    private void execute(String id) {
        ScheduledFuture<?> timeout=null;
        try {
            StoredOptimizationJob document;
            synchronized(this) {
                document=required(id);
                if (document.job().terminal()) return;
                persist(transition(document,"RUNNING","SOLVING",null,"正在计算并独立校验结果",null));
                running.put(id,Thread.currentThread());
                document=required(id);
                timeout=timer.schedule(()->deadline(id),document.input().problem().timeLimitSeconds(),TimeUnit.SECONDS);
            }
            long start=System.nanoTime();
            var outcome=document.input().strategy()==null
                    ? new MarkerOptimization.Outcome(solvers.solve(document.input().problem(),document.input().allowFallback()),null,null)
                    : MarkerOptimization.solve(document.input(),solvers,message->progress(id,message));
            NestingResult layout=outcome.layout();
            synchronized(this) {
                document=required(id);
                boolean stop="CANCEL_REQUESTED".equals(document.job().state());
                boolean timed="TIMED_OUT".equals(document.job().code()) || (!stop && System.nanoTime()-start>=TimeUnit.SECONDS.toNanos(document.input().problem().timeLimitSeconds()));
                // Interrupts are execution signals, not permission to interrupt the final durable write.
                Thread.interrupted();
                boolean valid=Set.of("FEASIBLE","NO_SOLUTION_FOUND").contains(layout.status());
                String state=timed?"TIMED_OUT":stop?"CANCELLED":valid && outcome.failureCode()==null?"SUCCEEDED":"FAILED";
                var result=valid?result(document,layout,timed?"TIME_LIMIT":stop?"CANCELLED":outcome.failureCode()!=null?"ENGINE_ERROR":"COMPLETED",outcome.marker()):null;
                persist(transition(document,state,"STOPPED",timed?"TIMED_OUT":stop?"CANCELLED":outcome.failureCode()!=null?outcome.failureCode():valid?null:layout.status(),
                        timed?"计算已退出，达到时限":stop?"计算已退出，取消完成":outcome.failureCode()!=null?"后续试排失败；此前已验证结果如有保留，请查看结果与试排记录":valid?"计算结束，履约状态请查看结果":layout.message(),result));
            }
        } catch(Throwable error) {
            synchronized(this) {
                Thread.interrupted();
                var document=documents.get(id);
                if(document!=null && !document.job().terminal()) {
                    var failed=transition(document,"FAILED","STOPPED","EXECUTION_FAILED","作业执行或持久化失败，请检查服务日志",null);
                    try {persist(failed);} catch(RuntimeException storageError) {storageFailed=true;documents.put(id,failed);log.error("Optimization result could not be persisted",storageError);}
                }
                log.error("Optimization job failed: {}",id,error);
            }
        } finally {
            if(timeout!=null)timeout.cancel(false);
            synchronized(this){running.remove(id);pending.remove(id);}
            Thread.interrupted();
        }
    }
    /** One timer services local leases and discovers durable queued work from every submitting node. */
    private synchronized void dispatch() {
        if(closing)return;
        try {
            for(var entry:leases.entrySet()) {
                var local=entry.getValue();
                if(local.lost)continue;
                var current=shared.heartbeat(local.lease,LEASE_MILLIS);
                if(current==null)local.lost=true;
                if(current==null || "CANCEL_REQUESTED".equals(current.job().state())) {
                    var thread=running.get(entry.getKey());if(thread!=null)thread.interrupt();
                }
            }
            while(leases.size()<workers) {
                var lease=shared.claim(owner,LEASE_MILLIS,document->"VALID".equals(
                        solvers.validateProblem(document.input().problem(),document.input().allowFallback()).status()));
                if(lease==null)break;
                var local=new LocalLease(lease);String id=lease.document().job().id();
                leases.put(id,local);
                executor.execute(()->executeShared(local));
            }
        } catch(RuntimeException error) {
            // On uncertain ownership, fail closed locally. DB expiry/recovery decides retry.
            for(var entry:leases.entrySet()) {
                entry.getValue().lost=true;
                var thread=running.get(entry.getKey());if(thread!=null)thread.interrupt();
            }
            log.error("Shared optimization dispatch/heartbeat failed; local owners fenced",error);
        }
    }
    private void executeShared(LocalLease local) {
        String id=local.lease.document().job().id();
        try {
            synchronized(this) {
                if(local.lost || closing)return;
                running.put(id,Thread.currentThread());
            }
            var document=local.lease.document();
            // A retry shares the first attempt's wall-clock deadline; it does not get a new full budget.
            var input=document.input();var p=input.problem();
            int seconds=Math.max(1,(int)Math.ceil(local.lease.remainingMillis()/1000d));
            var bounded=new com.example.cutdemotwo.contracts.nesting.NestingProblem(p.schemaVersion(),p.unit(),p.material(),p.parts(),p.process(),p.engine(),seconds);
            var execution=new OptimizationRequest(input.schemaVersion(),input.problemType(),input.clientRequestId(),bounded,input.allowFallback(),input.requireComplete(),input.strategy());
            var outcome=execution.strategy()==null
                    ?new MarkerOptimization.Outcome(solvers.solve(bounded,input.allowFallback()),null,null)
                    :MarkerOptimization.solve(execution,solvers,message->{
                        if(!local.lost && !shared.update(local.lease,current->withMessage(current,message),false))
                            Thread.currentThread().interrupt();
                    });
            Thread.interrupted();
            if(!local.lost && !shared.update(local.lease,current->finished(current,outcome),true))
                log.info("Discarded result from expired optimization attempt: {} token {}",id,local.lease.token());
        } catch(Throwable error) {
            Thread.interrupted();
            if(!local.lost)try {
                shared.update(local.lease,current->{
                    boolean stopping="CANCEL_REQUESTED".equals(current.job().state());
                    String state=stopping?("TIMED_OUT".equals(current.job().code())?"TIMED_OUT":"CANCELLED"):"FAILED";
                    return transition(current,state,"STOPPED",stopping?state:"EXECUTION_FAILED","执行失败或已停止；详情请查服务日志",null);
                },true);
            } catch(RuntimeException writeError){log.error("Shared optimization final state not persisted; lease recovery will resolve it",writeError);}
            log.error("Shared optimization execution failed: {}",id,error);
        } finally {
            synchronized(this){running.remove(id);leases.remove(id);}
            Thread.interrupted();
        }
    }
    private StoredOptimizationJob finished(StoredOptimizationJob current,MarkerOptimization.Outcome outcome) {
        boolean stop="CANCEL_REQUESTED".equals(current.job().state()),timed=stop && "TIMED_OUT".equals(current.job().code());
        var layout=outcome.layout();
        boolean valid=Set.of("FEASIBLE","NO_SOLUTION_FOUND").contains(layout.status());
        String state=timed?"TIMED_OUT":stop?"CANCELLED":valid && outcome.failureCode()==null?"SUCCEEDED":"FAILED";
        var result=valid?result(current,layout,timed?"TIME_LIMIT":stop?"CANCELLED":outcome.failureCode()!=null?"ENGINE_ERROR":"COMPLETED",outcome.marker()):null;
        return transition(current,state,"STOPPED",timed?"TIMED_OUT":stop?"CANCELLED":outcome.failureCode()!=null?outcome.failureCode():valid?null:layout.status(),
                stop?"计算已退出":outcome.failureCode()!=null?"后续试排失败；此前已验证结果如有保留，请查看试排记录":valid?"计算结束，履约状态请查看结果":layout.message(),result);
    }
    private StoredOptimizationJob withMessage(StoredOptimizationJob document,String message) {
        var j=document.job();
        var job=new OptimizationJob(j.id(),j.schemaVersion(),j.clientRequestId(),j.inputHash(),j.state(),j.phase(),j.createdAt(),
                j.startedAt(),j.finishedAt(),j.timeLimitSeconds(),j.resultRef(),j.code(),message);
        return new StoredOptimizationJob(document.idempotencyKey(),document.input(),job,document.result());
    }
    private synchronized void progress(String id,String message) {
        var document=required(id);
        if (!"RUNNING".equals(document.job().state())) return;
        var j=document.job();
        var job=new OptimizationJob(j.id(),j.schemaVersion(),j.clientRequestId(),j.inputHash(),j.state(),j.phase(),
                j.createdAt(),j.startedAt(),j.finishedAt(),j.timeLimitSeconds(),j.resultRef(),j.code(),message);
        persist(new StoredOptimizationJob(document.idempotencyKey(),document.input(),job,document.result()));
    }
    private OptimizationResult result(StoredOptimizationJob document,NestingResult layout,String termination,OptimizationResult.MarkerReport marker) {
        int requested=layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::requested).sum();
        int placed=layout.fulfillment().stream().mapToInt(NestingResult.Fulfillment::placed).sum();
        boolean complete=requested>0 && requested==placed;
        var m=layout.metrics();
        var metrics=new ArrayList<OptimizationResult.Metric>();
        metrics.add(new OptimizationResult.Metric("processingAreaUtilization",m.processingAreaMm2()>0?m.pieceAreaMm2()/m.processingAreaMm2()*100:0,
                "%",m.pieceAreaMm2(),m.processingAreaMm2(),"piece-net-area / submitted-processing-area; not actual consumed material","1"));
        if(marker!=null && marker.occupiedLengthMm()!=null && complete) {
            double area=layout.processingRegion().width()*marker.occupiedLengthMm();
            metrics.add(new OptimizationResult.Metric("markerAreaUtilization",m.pieceAreaMm2()/area*100,"%",
                    m.pieceAreaMm2(),area,"complete-kit-net-area / (fixed-width * occupied-marker-length); excludes unused tail; planned","1"));
        }
        return new OptimizationResult(document.job().id(),document.job().id(),document.job().inputHash(),"2.0","PASSED",
                complete?"COMPLETE":placed>0?"PARTIAL":"NONE",layout.feasible() && (!document.input().requireComplete() || complete),termination,
                List.copyOf(metrics),layout,marker);
    }
    private StoredOptimizationJob transition(StoredOptimizationJob d,String state,String phase,String code,String message,OptimizationResult result) {
        return d.transition(state,phase,code,message,result,System.currentTimeMillis());
    }
    private void persist(StoredOptimizationJob document) {store.save(document);documents.put(document.job().id(),document);}
    private String hash(OptimizationRequest input) {
        try {return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(input)));}
        catch(java.security.NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}
    }
    @Override @PreDestroy public void close() {
        synchronized(this) {
            if(closing)return;closing=true;
            if(shared!=null) {
                // Stop this process's attempts; leave durable queued jobs for surviving workers.
                for(var entry:leases.entrySet()) {
                    entry.getValue().lost=true;
                    var thread=running.get(entry.getKey());if(thread!=null)thread.interrupt();
                }
            } else for(String id:List.copyOf(pending.keySet())) try {cancel(id);}catch(RuntimeException error){log.error("Cannot persist shutdown cancellation",error);}
            executor.shutdown();timer.shutdownNow();
        }
        try {
            if(executor.awaitTermination(5,TimeUnit.SECONDS))store.close();
            else {var cleanup=new Thread(()->{try {while(!executor.awaitTermination(1,TimeUnit.SECONDS)){}store.close();}catch(InterruptedException e){Thread.currentThread().interrupt();}},"optimization-storage-close");cleanup.setDaemon(true);cleanup.start();}
        } catch(InterruptedException e){Thread.currentThread().interrupt();}
    }
}
