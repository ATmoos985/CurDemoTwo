package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.algorithm.api.ISlittingSolverEngine;
import com.example.cutdemotwo.algorithm.nesting.CrossCutSolverService;
import com.example.cutdemotwo.algorithm.nesting.SolverFactory;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingResult;
import com.example.cutdemotwo.persistence.FileOptimizationJobStore;
import com.example.cutdemotwo.persistence.JdbcOptimizationJobStore;
import com.example.cutdemotwo.persistence.OptimizationJobStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static com.example.cutdemotwo.business.optimization.OptimizationServiceTests.finished;
import static com.example.cutdemotwo.business.optimization.OptimizationServiceTests.request;
import static org.junit.jupiter.api.Assertions.*;

/**
 * 2D/1D 独立算力隔离线程池、细粒度锁与 SSE 监听器生命周期无泄漏专项测试。
 */
@Timeout(25)
class OptimizationIsolationAndSseTests {

    @TempDir Path temp;
    private final List<OptimizationService> services = new ArrayList<>();

    @AfterEach
    void tearDown() {
        services.forEach(OptimizationService::close);
        services.clear();
    }

    private OptimizationJobStore createStore(boolean jdbc, String name) {
        if (!jdbc) {
            return new FileOptimizationJobStore(temp.resolve(name));
        }
        var source = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(source).load().migrate();
        return new JdbcOptimizationJobStore(source);
    }

    private static OptimizationRequest slittingRequest(String clientId) {
        var problem = new SlittingProblem("1", "mm", 1200, 10, 10, 1000, 1180, 10, 10, "QUALITY",
                List.of(new SlittingProblem.Order("O1", 500, 3000L, 2, "素色")), 15);
        return new OptimizationRequest("2.0", "SLITTING_1D", clientId, problem, false, true);
    }

    private static SlittingResult fakeSlittingResult() {
        var pat = new SlittingResult.Pattern("PAT-1", 1000, 1000, 3000L, "素色", 1,
                List.of(new SlittingResult.Station(500, 2)),
                List.of(new SlittingResult.Allocation("O1", 2)));
        return new SlittingResult("1", "mm", "blocking-1d", "test", "FEASIBLE", false,
                List.of(pat), List.of(new SlittingResult.Fulfillment("O1", 2, 2, 0, 0)),
                1000L * 3000, 1200L * 3000, 1180L * 3000, 0, 0, 0);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void slow1DSlittingJobsNeverBlock2DRealtimeNestingInEitherFileOrJdbcMode(boolean jdbc) throws Exception {
        CountDownLatch twoSlittingStarted = new CountDownLatch(2);
        CountDownLatch releaseSlitting = new CountDownLatch(1);
        AtomicInteger concurrentSlitting = new AtomicInteger();
        AtomicInteger maxObservedSlitting = new AtomicInteger();

        ISlittingSolverEngine blockingSlitting = new ISlittingSolverEngine() {
            @Override public String getEngineType() { return "blocking-1d"; }
            @Override public boolean isAvailable() { return true; }
            @Override public SlittingResult solve(SlittingProblem problem) {
                int cur = concurrentSlitting.incrementAndGet();
                maxObservedSlitting.accumulateAndGet(cur, Math::max);
                twoSlittingStarted.countDown();
                try {
                    releaseSlitting.await(15, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    concurrentSlitting.decrementAndGet();
                }
                return fakeSlittingResult();
            }
        };

        // workers=2（2D 池 2 线程）, slittingWorkers=2（1D 隔离池 2 线程）, queueCapacity=8
        var service = new OptimizationService(
                new SolverFactory(List.of(new CrossCutSolverService())),
                blockingSlitting,
                createStore(jdbc, "isolation-" + jdbc),
                2, 8, 100, 168L, "768m", 2);
        services.add(service);

        try {
            // 先提交 3 个长耗时 1D 作业占满全部 1D 独立线程池（2 个运行中 + 1 个排队）
            var s1 = service.submit("slow-1d-job-1", slittingRequest("1d-1"));
            var s2 = service.submit("slow-1d-job-2", slittingRequest("1d-2"));
            var s3 = service.submit("slow-1d-job-3", slittingRequest("1d-3"));
            assertTrue(twoSlittingStarted.await(5, TimeUnit.SECONDS), "应有 2 个 1D 作业并发占满 1D 隔离执行池");

            // 在 1D 池完全满载阻塞期间，提交 2 个 2D 实时排样作业，必须立即被 2D 独立池完成！
            long t0 = System.nanoTime();
            var n1 = service.submit("fast-2d-job-1", request("crosscut", 2, 5, false));
            var n2 = service.submit("fast-2d-job-2", request("crosscut", 2, 5, false));

            OptimizationJob n1Done = finished(service, n1.id());
            OptimizationJob n2Done = finished(service, n2.id());
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);

            assertEquals("SUCCEEDED", n1Done.state());
            assertEquals("SUCCEEDED", n2Done.state());
            assertTrue(elapsedMs < 3_000L, "2D 实时排样不得被长耗时 1D 阻塞，实际耗时=" + elapsedMs + "ms");
            List<String> slittingStates = List.of(
                    service.get(s1.id()).state(),
                    service.get(s2.id()).state(),
                    service.get(s3.id()).state());
            assertEquals(2, slittingStates.stream().filter("RUNNING"::equals).count(),
                    "1D 隔离池满载时应恰好有 2 个 1D 作业处于 RUNNING，实际状态=" + slittingStates);
            assertEquals(1, slittingStates.stream().filter("QUEUED"::equals).count(),
                    "第 3 个 1D 作业应处于排队中，实际状态=" + slittingStates);
            assertTrue(maxObservedSlitting.get() <= 2, "1D 隔离池并发度必须严格受限于 slittingWorkers=2");

            // 放行 1D 作业，全部收尾成功
            releaseSlitting.countDown();
            assertEquals("SUCCEEDED", finished(service, s1.id()).state());
            assertEquals("SUCCEEDED", finished(service, s2.id()).state());
            assertEquals("SUCCEEDED", finished(service, s3.id()).state());
        } finally {
            releaseSlitting.countDown();
        }
    }

    @Test
    void capabilitiesAdvertisesSseAndIsolatedWorkerLimits() {
        var service = new OptimizationService(
                new SolverFactory(List.of(new CrossCutSolverService())),
                new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),
                createStore(false, "caps"),
                4, 16, 200, 168L, "768m", 2);
        services.add(service);

        var cap = service.capabilities();
        @SuppressWarnings("unchecked") var features = (Map<String, Object>) cap.get("features");
        @SuppressWarnings("unchecked") var limits = (Map<String, Object>) cap.get("limits");

        assertEquals(Boolean.TRUE, features.get("sse"));
        assertEquals("sse-and-poll", features.get("progress"));
        assertEquals(4, limits.get("workers"));
        assertEquals(4, limits.get("nestingWorkers"));
        assertEquals(2, limits.get("slittingWorkers"));
    }

    @Test
    void sseSubscriptionTracksActiveListenersAndReleasesOnTerminalAndCloseWithoutLeak() throws Exception {
        var gate = new OptimizationServiceTests.GateEngine();
        var service = new OptimizationService(
                new SolverFactory(List.of(gate)),
                new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),
                createStore(false, "sse-lifecycle"),
                1, 4, 100);
        services.add(service);

        // 1. 不存在的作业抛 404 NOT_FOUND
        var missing = assertThrows(OptimizationService.Failure.class, () -> service.subscribeEvents("non-existent-id"));
        assertEquals(404, missing.status);
        assertEquals("NOT_FOUND", missing.code);
        assertEquals(0, service.activeEventSubscriberCount());

        try {
            // 2. 订阅运行中作业 -> 注册活跃监听器
            var job = service.submit("sse-active-key", request("gate", 1, 10, false));
            assertTrue(gate.entered.await(3, TimeUnit.SECONDS));

            var emitter1 = service.subscribeEvents(job.id());
            var emitter2 = service.subscribeEvents(job.id());
            assertNotNull(emitter1);
            assertNotNull(emitter2);
            assertEquals(2, service.activeEventSubscriberCount());

            // 3. 作业结束进入终态 -> 锁外异步推送 done 并注销全部监听器，零内存泄漏
            gate.release.countDown();
            assertEquals("SUCCEEDED", finished(service, job.id()).state());
            long sseDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (service.activeEventSubscriberCount() > 0 && System.nanoTime() < sseDeadline) {
                Thread.sleep(10);
            }
            assertEquals(0, service.activeEventSubscriberCount(), "作业进入终态后必须彻底注销所有 SSE 监听器");

            // 4. 订阅已终态作业 -> 直接完结且不残留任何监听器
            var terminalEmitter = service.subscribeEvents(job.id());
            assertNotNull(terminalEmitter);
            assertEquals(0, service.activeEventSubscriberCount(), "终态作业订阅不得驻留任何监听器");
        } finally {
            gate.release.countDown();
        }
    }

    @Test
    void fineGrainedLocksAllowConcurrentReadsWhileAnotherJobValidationIsSlow() throws Exception {
        CountDownLatch validationEntered = new CountDownLatch(1);
        CountDownLatch releaseValidation = new CountDownLatch(1);

        var fastEngine = new CrossCutSolverService();
        var slowValidateEngine = new com.example.cutdemotwo.algorithm.nesting.ICutSolverEngine() {
            @Override public String getEngineType() { return "slow-validate"; }
            @Override public boolean isAvailable() { return true; }
            @Override public com.example.cutdemotwo.contracts.nesting.EngineCapabilities capabilities() {
                return new com.example.cutdemotwo.contracts.nesting.EngineCapabilities(
                        "slow-validate", "1", List.of("RECTANGLE"), List.of("CROSSCUT"), List.of("INPUT_ORDER"), 0.1, true);
            }
            @Override public com.example.cutdemotwo.algorithm.nesting.EngineResult solve(com.example.cutdemotwo.contracts.nesting.NestingProblem p) {
                return fastEngine.solve(p);
            }
        };

        var service = new OptimizationService(
                new SolverFactory(List.of(fastEngine, slowValidateEngine)) {
                    @Override
                    public com.example.cutdemotwo.contracts.jobs.ProblemCheck validateProblem(
                            com.example.cutdemotwo.contracts.nesting.NestingProblem problem, boolean allowFallback) {
                        if ("slow-validate".equals(problem.engine())) {
                            validationEntered.countDown();
                            try {
                                releaseValidation.await(10, TimeUnit.SECONDS);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                        }
                        return super.validateProblem(problem, allowFallback);
                    }
                },
                new com.example.cutdemotwo.algorithm.slitting.LinearSlittingSolverEngine(),
                createStore(false, "fine-locks"),
                2, 4, 100);
        services.add(service);

        var fastJob = service.submit("fast-read-baseline", request("crosscut", 1, 5, false));
        assertEquals("SUCCEEDED", finished(service, fastJob.id()).state());

        Thread slowSubmitter = new Thread(() -> service.submit("slow-validate-key", request("slow-validate", 1, 5, false)));
        slowSubmitter.start();
        try {
            assertTrue(validationEntered.await(3, TimeUnit.SECONDS));

            // 在慢几何校验阻塞期间，读状态/读结果/提交其他作业必须瞬时完成，绝不被 synchronized(this) 挡死！
            long t0 = System.nanoTime();
            assertEquals("SUCCEEDED", service.get(fastJob.id()).state());
            assertNotNull(service.result(fastJob.id()));
            var secondFast = service.submit("fast-while-validating", request("crosscut", 1, 5, false));
            assertEquals("SUCCEEDED", finished(service, secondFast.id()).state());
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
            assertTrue(elapsedMs < 2_000L, "锁外校验期间其他作业读写与提交不得被阻塞，实际耗时=" + elapsedMs + "ms");
        } finally {
            releaseValidation.countDown();
            slowSubmitter.join(5_000L);
        }
    }
}
