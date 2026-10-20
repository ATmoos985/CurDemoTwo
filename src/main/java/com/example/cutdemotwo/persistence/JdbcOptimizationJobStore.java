package com.example.cutdemotwo.persistence;

import com.example.cutdemotwo.business.optimization.OptimizationService.Failure;
import com.example.cutdemotwo.business.optimization.StoredOptimizationJob;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;
import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.*;

/**
 * The dispatch row serializes short state transactions, never solver execution.
 * Database time, lease ownership and increasing attempt tokens guard every worker write.
 */
public final class JdbcOptimizationJobStore implements LeasedOptimizationJobStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JsonMapper json=JsonMapper.builder().build();
    private final boolean mysql;
    private int workers, queue, archive;
    private record Row(StoredOptimizationJob document, long token, String owner, Long lease, Long deadline) {}

    public JdbcOptimizationJobStore(DataSource source) {
        jdbc=new JdbcTemplate(source);
        String product=jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<String>)connection->connection.getMetaData().getDatabaseProductName());
        mysql="MySQL".equals(product);
        if(!mysql && !"H2".equals(product))throw new IllegalArgumentException("计算作业存储仅支持 MySQL，H2 仅用于兼容测试");
        transaction=new TransactionTemplate(new DataSourceTransactionManager(source));
        transaction.setTimeout(5);
    }
    private <T> T locked(Supplier<T> operation) {
        return transaction.execute(status -> {
            jdbc.queryForObject("SELECT id FROM optimization_dispatch WHERE id=1 FOR UPDATE",Integer.class);
            return operation.get();
        });
    }
    private long now() {
        // MySQL DATETIME has no offset: ask the server for epoch time instead of interpreting
        // its wall clock in each worker connection's possibly different time zone.
        if(mysql)return Objects.requireNonNull(jdbc.queryForObject("SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000",Long.class));
        return Objects.requireNonNull(jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(3)",java.sql.Timestamp.class)).getTime();
    }
    @Override public void configure(int workers,int queue,int archive) {
        locked(()->{
            var config=jdbc.queryForMap("SELECT worker_limit,queue_limit,archive_limit FROM optimization_dispatch WHERE id=1");
            if(config.get("worker_limit")==null)
                jdbc.update("UPDATE optimization_dispatch SET worker_limit=?,queue_limit=?,archive_limit=? WHERE id=1",workers,queue,archive);
            else if(((Number)config.get("worker_limit")).intValue()!=workers
                    || ((Number)config.get("queue_limit")).intValue()!=queue
                    || ((Number)config.get("archive_limit")).intValue()!=archive)
                throw new IllegalStateException("共享计算服务的全局并发、队列与归档限额必须一致");
            this.workers=workers;this.queue=queue;this.archive=archive;
            return null;
        });
    }
    @Override public StoredOptimizationJob submitOrGet(StoredOptimizationJob document) {
        if(workers<1)throw new IllegalStateException("作业存储尚未配置");
        return locked(()->{
            String digest=digest(document.idempotencyKey());
            var old=jdbc.query("SELECT id FROM optimization_job WHERE key_digest=?",(rs,n)->rs.getString(1),digest);
            if(!old.isEmpty()) {
                var found=find(old.get(0));
                if(!found.job().inputHash().equals(document.job().inputHash()))
                    throw new Failure("IDEMPOTENCY_CONFLICT","同一幂等键已绑定不同请求",409,false);
                return found;
            }
            long active=jdbc.queryForObject("SELECT COUNT(*) FROM optimization_job WHERE state IN ('QUEUED','RUNNING','CANCEL_REQUESTED')",Long.class);
            long stored=jdbc.queryForObject("SELECT COUNT(*) FROM optimization_job",Long.class);
            if(active>=workers+queue || stored>=archive)throw new Failure("QUOTA_EXCEEDED","共享作业并发/排队或归档限额已满",429,true);
            jdbc.update("INSERT INTO optimization_job(id,key_digest,state,created_at,token,document_json) VALUES(?,?,?,?,0,?)",
                    document.job().id(),digest,"QUEUED",now(),json.writeValueAsString(document));
            return document;
        });
    }
    private Row row(String id) {
        var rows=jdbc.query("SELECT document_json,token,owner_id,lease_until,deadline_at FROM optimization_job WHERE id=?",
                (rs,n)->new Row(json.readValue(rs.getString(1),StoredOptimizationJob.class),rs.getLong(2),
                        rs.getString(3),rs.getObject(4,Long.class),rs.getObject(5,Long.class)),id);
        return rows.isEmpty()?null:rows.get(0);
    }
    @Override public StoredOptimizationJob find(String id) {
        var row=row(id);return row==null?null:row.document();
    }
    @Override public StoredOptimizationJob findByKey(String key) {
        var found=jdbc.query("SELECT document_json FROM optimization_job WHERE key_digest=?",
                (rs,n)->json.readValue(rs.getString(1),StoredOptimizationJob.class),digest(key));
        return found.isEmpty()?null:found.get(0);
    }
    @Override public List<StoredOptimizationJob> load() {
        return jdbc.query("SELECT document_json FROM optimization_job ORDER BY created_at,id",
                (rs,n)->json.readValue(rs.getString(1),StoredOptimizationJob.class));
    }
    @Override public void save(StoredOptimizationJob document) {
        throw new UnsupportedOperationException("共享作业必须通过事务与租约操作，禁止无条件覆盖");
    }
    private void write(StoredOptimizationJob d) {
        if(jdbc.update("UPDATE optimization_job SET state=?,document_json=? WHERE id=?",
                d.job().state(),json.writeValueAsString(d),d.job().id())!=1)
            throw new IllegalStateException("计算作业写入丢失");
    }
    private void recover(long now) {
        var ids=jdbc.query("SELECT id FROM optimization_job WHERE state IN ('RUNNING','CANCEL_REQUESTED') AND lease_until<=?",
                (rs,n)->rs.getString(1),now);
        for(String id:ids) {
            var r=row(id);var d=r.document();
            String state="QUEUED",code="LEASE_EXPIRED",message="执行租约过期，等待剩余预算内重试";
            if("CANCEL_REQUESTED".equals(d.job().state())) {
                state="TIMED_OUT".equals(d.job().code())?"TIMED_OUT":"CANCELLED";code=state;message="执行租约过期，取消意图保留";
            } else if(r.deadline()<=now) {
                state="TIMED_OUT";code=state;message="租约过期且总计算预算已耗尽";
            } else if(r.token()>=3) {
                state="FAILED";code="ATTEMPTS_EXHAUSTED";message="执行租约连续失效，已达到三次尝试上限";
            }
            jdbc.update("UPDATE optimization_attempt SET finished_at=?,outcome='LEASE_EXPIRED' WHERE job_id=? AND token=? AND finished_at IS NULL",now,id,r.token());
            write(d.transition(state,"QUEUED".equals(state)?"QUEUED":"LEASE_LOST",code,message,null,now));
            jdbc.update("UPDATE optimization_job SET owner_id=NULL,lease_until=NULL WHERE id=?",id);
        }
        // A retriable job can exhaust its original budget while waiting for a worker.
        var queued=jdbc.query("SELECT id FROM optimization_job WHERE state='QUEUED' AND deadline_at<=?",(rs,n)->rs.getString(1),now);
        for(String id:queued)write(find(id).transition("TIMED_OUT","STOPPED","TIMED_OUT","重试等待期间总计算预算已耗尽",null,now));
    }
    @Override public Lease claim(String owner,long leaseMillis,Predicate<StoredOptimizationJob> executable) {
        if(owner==null || owner.isBlank() || owner.length()>64 || leaseMillis<1)throw new IllegalArgumentException("无效的 worker 或租约");
        return locked(()->{
            long time=now();recover(time);
            long active=jdbc.queryForObject("SELECT COUNT(*) FROM optimization_job WHERE state IN ('RUNNING','CANCEL_REQUESTED')",Long.class);
            if(active>=workers)return null;
            var ids=jdbc.query("SELECT id FROM optimization_job WHERE state='QUEUED' ORDER BY created_at,id",(rs,n)->rs.getString(1));
            if(ids.isEmpty())return null;
            Row r=null;
            for(String id:ids) {var candidate=row(id);if(executable.test(candidate.document())){r=candidate;break;}}
            if(r==null)return null;
            // Capability checks may take time. Lease and budget start after them, not before them.
            time=now();
            var d=r.document();long token=r.token()+1;
            if(r.deadline()!=null && r.deadline()<=time)return null;
            long deadline=r.deadline()==null?time+d.job().timeLimitSeconds()*1000L:r.deadline();
            var running=d.transition("RUNNING","SOLVING",null,"正在计算并独立校验结果",null,time);
            write(running);
            jdbc.update("UPDATE optimization_job SET token=?,owner_id=?,lease_until=?,deadline_at=? WHERE id=?",
                    token,owner,time+leaseMillis,deadline,d.job().id());
            jdbc.update("INSERT INTO optimization_attempt(job_id,token,owner_id,started_at,outcome) VALUES(?,?,?,?,'RUNNING')",d.job().id(),token,owner,time);
            return new Lease(running,owner,token,deadline-time);
        });
    }
    private boolean owns(Row r,Lease lease,long now) {
        return r!=null && !r.document().job().terminal() && r.token()==lease.token()
                && lease.owner().equals(r.owner()) && r.lease()!=null && r.lease()>now;
    }
    private StoredOptimizationJob timeout(Row r,long now) {
        var d=r.document();
        if(r.deadline()<=now && !"CANCEL_REQUESTED".equals(d.job().state())) {
            d=d.transition("CANCEL_REQUESTED","STOPPING","TIMED_OUT","总计算预算耗尽，等待执行退出",null,now);write(d);
        }
        return d;
    }
    @Override public StoredOptimizationJob heartbeat(Lease lease,long leaseMillis) {
        return locked(()->{
            long time=now();var r=row(lease.document().job().id());
            if(!owns(r,lease,time))return null;
            var d=timeout(r,time);
            jdbc.update("UPDATE optimization_job SET lease_until=? WHERE id=?",time+leaseMillis,d.job().id());
            return d;
        });
    }
    @Override public StoredOptimizationJob cancel(String id) {
        return locked(()->{
            var d=find(id);if(d==null || d.job().terminal() || "CANCEL_REQUESTED".equals(d.job().state()))return d;
            boolean queued="QUEUED".equals(d.job().state());
            var next=d.transition(queued?"CANCELLED":"CANCEL_REQUESTED",queued?"STOPPED":"STOPPING","CANCELLED","调用方请求取消",null,now());
            write(next);return next;
        });
    }
    @Override public boolean update(Lease lease,UnaryOperator<StoredOptimizationJob> change,boolean terminal) {
        return locked(()->{
            long time=now();var r=row(lease.document().job().id());
            if(!owns(r,lease,time))return false;
            var current=timeout(r,time);var next=change.apply(current);
            // Application-side result wrapping must not extend a lease merely by holding the lock.
            long completedAt=now();
            if(r.lease()<=completedAt)return false;
            if(r.deadline()<=completedAt && !"CANCEL_REQUESTED".equals(current.job().state())) {
                current=timeout(r,completedAt);
                next=change.apply(current);
                completedAt=now();
                if(r.lease()<=completedAt)return false;
            }
            if(next.job().terminal()!=terminal || !next.job().id().equals(current.job().id())
                    || !next.input().equals(current.input()) || !next.idempotencyKey().equals(current.idempotencyKey()))
                throw new IllegalArgumentException("作业事务不能改写输入、身份或预期终态");
            if(!terminal && !"RUNNING".equals(current.job().state()))return false;
            if(terminal) {
                String required="TIMED_OUT".equals(current.job().code())?"TIMED_OUT":"CANCELLED";
                if("CANCEL_REQUESTED".equals(current.job().state()) && !required.equals(next.job().state()))
                    throw new IllegalArgumentException("最终写入不能丢弃已持久化取消意图");
                if(next.result()!=null)jdbc.update("INSERT INTO optimization_result(job_id,token,result_json) VALUES(?,?,?)",
                        next.job().id(),lease.token(),json.writeValueAsString(next.result()));
                jdbc.update("UPDATE optimization_attempt SET finished_at=?,outcome=? WHERE job_id=? AND token=?",
                        completedAt,next.job().state(),next.job().id(),lease.token());
                jdbc.update("UPDATE optimization_job SET owner_id=NULL,lease_until=NULL WHERE id=?",next.job().id());
            }
            write(next);return true;
        });
    }
    private static String digest(String key) {
        try {return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(("local\0submit-optimization\0"+key).getBytes(StandardCharsets.UTF_8)));}
        catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}
    }
    @Override public void close() {} // Shared DataSource lifecycle belongs to Spring.
}
