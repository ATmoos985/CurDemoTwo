package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.persistence.JdbcOptimizationJobStore;
import com.example.cutdemotwo.persistence.LeasedOptimizationJobStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import javax.sql.DataSource;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.example.cutdemotwo.business.optimization.OptimizationServiceTests.request;
import static org.junit.jupiter.api.Assertions.*;

/**
 * JDBC 调度存储锁外校验防雪崩与多节点水平扩容专项测试。
 */
@Timeout(15)
class JdbcOptimizationScalingAndLockTests {

    private DataSource source;
    private JdbcOptimizationJobStore nodeA;
    private JdbcOptimizationJobStore nodeB;
    private JdbcOptimizationJobStore nodeC;

    @BeforeEach
    void setup() {
        source = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(source).load().migrate();
        nodeA = new JdbcOptimizationJobStore(source);
        nodeB = new JdbcOptimizationJobStore(source);
        nodeC = new JdbcOptimizationJobStore(source);
        // 每节点 workers=1，全局队列容量 queue=4（共允许 5 个未完结作业在途）
        nodeA.configure(1, 4, 100);
        nodeB.configure(1, 4, 100);
        nodeC.configure(1, 4, 100);
    }

    private static StoredOptimizationJob newQueuedDoc(String key) {
        var input = request("crosscut", 1, 60, false);
        String id = UUID.randomUUID().toString();
        var job = new OptimizationJob(id, "2.0", input.clientRequestId(), StoredOptimizationJob.inputHash(input),
                "QUEUED", "QUEUED", Instant.now().toString(), null, null, 60, null, null, "queued");
        return new StoredOptimizationJob(key, input, job, null);
    }

    @Test
    void slowExecutableValidationRunsOutsideDispatchLockWithoutBlockingHeartbeatsOrSubmits() throws Exception {
        var j1 = nodeA.submitOrGet(newQueuedDoc("lock-test-job-1"));
        var j2 = nodeA.submitOrGet(newQueuedDoc("lock-test-job-2"));

        // nodeA 领取 j1 进入运行态
        var leaseA = nodeA.claim("node-A", 15_000);
        assertNotNull(leaseA);
        assertEquals(j1.job().id(), leaseA.document().job().id());

        // nodeB 领取 j2，但在 executable.test 中故意长时间阻塞（模拟耗时多边形校验）
        CountDownLatch enteredCheck = new CountDownLatch(1);
        CountDownLatch releaseCheck = new CountDownLatch(1);
        var pool = Executors.newSingleThreadExecutor();
        try {
            Future<LeasedOptimizationJobStore.Lease> claimFuture = pool.submit(() ->
                    nodeB.claim("node-B", 15_000, candidate -> {
                        enteredCheck.countDown();
                        try {
                            releaseCheck.await(10, TimeUnit.SECONDS);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        return true;
                    }));

            assertTrue(enteredCheck.await(3, TimeUnit.SECONDS), "应已进入锁外 executable.test 校验");

            // 在慢校验挂起期间，nodeA 续租心跳、新作业提交、作业查询均必须瞬时成功，绝不被 FOR UPDATE 锁死！
            long t0 = System.nanoTime();
            var beat = nodeA.heartbeat(leaseA, 15_000);
            assertNotNull(beat, "慢校验期间其他节点续租心跳不得被阻塞或失租");
            var j3 = nodeA.submitOrGet(newQueuedDoc("lock-test-job-3"));
            assertNotNull(j3);
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
            assertTrue(elapsedMs < 1_000L, "心跳与提交应在锁外校验期间瞬时完成，实际耗时=" + elapsedMs + "ms");

            // 放行慢校验，nodeB 短锁原子领取 j2 成功
            releaseCheck.countDown();
            var leaseB = claimFuture.get(5, TimeUnit.SECONDS);
            assertNotNull(leaseB);
            assertEquals(j2.job().id(), leaseB.document().job().id());
        } finally {
            releaseCheck.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void clusterNodesScaleHorizontallyByIndependentOwnerSlotsWhileEnforcingPerNodeLimit() {
        var j1 = nodeA.submitOrGet(newQueuedDoc("scale-job-1"));
        var j2 = nodeA.submitOrGet(newQueuedDoc("scale-job-2"));
        var j3 = nodeA.submitOrGet(newQueuedDoc("scale-job-3"));

        // 1. nodeA 配置 workers=1，最多领取 1 个作业
        var leaseA1 = nodeA.claim("node-A", 15_000);
        assertNotNull(leaseA1);
        assertEquals(j1.job().id(), leaseA1.document().job().id());
        assertNull(nodeA.claim("node-A", 15_000), "单节点超出自身 workers=1 上限时不可继续领取");

        // 2. nodeB 作为第二个集群节点，独立拥有自己的 workers=1 槽位，立即并发领取 j2！
        var leaseB1 = nodeB.claim("node-B", 15_000);
        assertNotNull(leaseB1, "集群扩容节点 node-B 应独立按自身 workers 容量并发领取作业");
        assertEquals(j2.job().id(), leaseB1.document().job().id());
        assertNull(nodeB.claim("node-B", 15_000));

        // 3. nodeC 作为第三个集群节点，立即并发领取 j3，全集群并发吞吐随节点数线性扩展！
        var leaseC1 = nodeC.claim("node-C", 15_000);
        assertNotNull(leaseC1, "集群扩容节点 node-C 应独立按自身 workers 容量并发领取作业");
        assertEquals(j3.job().id(), leaseC1.document().job().id());
    }
}
