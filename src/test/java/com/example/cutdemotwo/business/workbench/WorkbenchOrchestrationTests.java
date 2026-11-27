package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.algorithm.api.NestingSolver;
import com.example.cutdemotwo.business.cutting.GlobalPlanningService;
import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchComparison;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.FileOptimizationJobStore;
import com.example.cutdemotwo.persistence.FileWorkbenchDraftStore;
import com.example.cutdemotwo.persistence.JdbcOptimizationJobStore;
import com.example.cutdemotwo.persistence.JdbcWorkbenchDraftStore;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import javax.sql.DataSource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 工作台编排试排、同口径双方案对比、结果上下文与持久化待确认草案全链路测试：
 * 覆盖 2D 矩形（含直刀外扩与避疵）/ 2D 异形带孔 / 1D 分切、422 状态与无待排拦截、
 * 同口径比较与不可比原因、草案 SHA-256 持久化/TTL 过期/库存与任务版本漂移探测，以及 File + JDBC(H2/MySQL) 双存储兼容性。
 */
@Tag("mysql-integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WorkbenchOrchestrationTests {
    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry r) {
        r.add("cutdemo.state.path", () -> temp.resolve("inventory.json").toString());
        r.add("cutdemo.seed-demo-data", () -> false);
    }

    @Value("${local.server.port}")
    int port;

    @Autowired
    RemnantService inventory;

    @Autowired
    SchedulingStudioService studioService;

    @Autowired
    OptimizationService optimizationService;

    @Autowired
    GlobalPlanningService globalPlanningService;

    @Autowired
    WorkbenchDraftService workbenchDraftService;

    @Autowired
    NestingSolver nestingSolver;

    private final JsonMapper json = JsonMapper.builder().build();
    private final HttpClient http = HttpClient.newHttpClient();

    private static final class MutableClock extends Clock {
        private Instant current;

        MutableClock(Instant initial) {
            this.current = initial;
        }

        void advanceSeconds(long seconds) {
            this.current = this.current.plusSeconds(seconds);
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return current;
        }
    }

    private HttpResponse<String> get(String path) throws Exception {
        var req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String path, Object body, String idempotencyKey) throws Exception {
        String payload = body instanceof String s ? s : json.writeValueAsString(body);
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload));
        if (idempotencyKey != null) {
            builder.header("Idempotency-Key", idempotencyKey);
        }
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private OptimizationJob waitTerminal(String jobId) throws Exception {
        for (int i = 0; i < 200; i++) {
            var res = get("/api/v2/optimization-jobs/" + jobId);
            assertEquals(200, res.statusCode(), res.body());
            var job = json.readValue(res.body(), OptimizationJob.class);
            if (job.terminal()) {
                return job;
            }
            Thread.sleep(30);
        }
        throw new AssertionError("作业在超时前未到达终态: " + jobId);
    }

    private long currentInventoryRevision() {
        return inventory.inRead(v -> v.currentRevision());
    }

    private MotherRollInfo savePassedRoll(String rollId, double width, double length, List<Defect> defects) {
        MotherRollInfo roll = new MotherRollInfo(rollId, "TC-2026", width, length, 0, 0);
        roll.setInspectionStatus("PASSED");
        if (defects != null) {
            roll.setDefects(new java.util.ArrayList<>(defects));
        }
        return inventory.saveOrUpdateMotherRoll(roll);
    }

    @Test
    void rect2DWithPieceGapDefectsAndIdempotencyWorksWithoutMutatingInventory() throws Exception {
        MotherRollInfo roll = savePassedRoll(
                "ROLL-WB-2D-" + UUID.randomUUID().toString().substring(0, 6),
                2000,
                10000,
                List.of(new Defect(1, 900, 100, 120, 120, 20))
        );
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "工作台矩形试排任务", "TC-2026", null, 0,
                List.of(
                        new CuttingTask.Line(1, "前片", 600, 800, 2, true),
                        new CuttingTask.Line(2, "后片", 500, 700, 2, false)
                ),
                new CuttingTask.Process(3000, 20, "left-top", "horizontal", true, true, 10.0)
        ));

        long revBefore = currentInventoryRevision();
        String key = "wb-rect-idem-" + UUID.randomUUID();
        Map<String, Object> body = Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 3000,
                "pieceGapMm", 10.0,
                "trimStartMm", 20.0,
                "avoidDefects", true,
                "timeLimitSeconds", 4
        );

        var acceptedRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", body, key);
        assertEquals(202, acceptedRes.statusCode(), acceptedRes.body());
        assertFalse(acceptedRes.body().contains(key), "公开响应不得泄露幂等键");

        JsonNode accepted = json.readTree(acceptedRes.body());
        String jobId = accepted.get("job").get("id").asString();
        assertEquals("/app/#/workbench?taskId=" + task.id() + "&resultId=" + jobId, accepted.get("workbenchUrl").asString());
        assertEquals(10.0, accepted.get("source").get("rectGapPaddingMm").asDouble(), 0.001);
        assertEquals(roll.getRollId(), accepted.get("source").get("materialId").asString());
        assertEquals(revBefore, accepted.get("source").get("materialRevision").asLong());

        // 同幂等键重试返回同一作业 ID
        var replayRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", body, key);
        assertEquals(202, replayRes.statusCode(), replayRes.body());
        assertEquals(jobId, json.readTree(replayRes.body()).get("job").get("id").asString());

        // 同幂等键改窗长触发 409 冲突
        var conflictRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2500,
                "pieceGapMm", 10.0,
                "trimStartMm", 20.0,
                "avoidDefects", true,
                "timeLimitSeconds", 4
        ), key);
        assertEquals(409, conflictRes.statusCode(), conflictRes.body());
        assertEquals("IDEMPOTENCY_CONFLICT", json.readTree(conflictRes.body()).get("code").asString());

        OptimizationJob finished = waitTerminal(jobId);
        assertEquals("SUCCEEDED", finished.state(), finished.toString());

        // 验证上下文接口返回完整结构且不泄露幂等键
        var ctxRes = get("/api/v2/workbench/results/" + jobId + "/context");
        assertEquals(200, ctxRes.statusCode(), ctxRes.body());
        assertFalse(ctxRes.body().contains(key));
        JsonNode ctx = json.readTree(ctxRes.body());
        assertEquals(jobId, ctx.get("resultId").asString());
        assertEquals("COMPLETE", ctx.get("result").get("fulfillmentStatus").asString());
        assertEquals(task.id(), ctx.get("taskSummary").get("id").asString());
        assertEquals(4, ctx.get("taskSummary").get("openTotal").asInt());
        assertFalse(ctx.get("input").get("problem").get("material").get("exclusions").isEmpty(), "开启避疵应自动注入安全避疵窗");
        assertEquals(revBefore, currentInventoryRevision(), "纯试排与查上下文不得改动库存 revision");
    }

    @Test
    void contour2DWithHolesAndGapFillSolvesCleanly() throws Exception {
        NestingProblem.Shape holedPoly = new NestingProblem.Shape(
                "POLYGON", 500, 400,
                List.of(
                        new NestingProblem.Point(0, 0),
                        new NestingProblem.Point(500, 0),
                        new NestingProblem.Point(500, 400),
                        new NestingProblem.Point(0, 400)
                ),
                List.of(List.of(
                        new NestingProblem.Point(150, 120),
                        new NestingProblem.Point(350, 120),
                        new NestingProblem.Point(350, 280),
                        new NestingProblem.Point(150, 280)
                ))
        );
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "异形带孔裁片任务", "TC-CONTOUR", null, 0,
                List.of(
                        new CuttingTask.Line(1, "带孔饰板", 500, 400, 2, false, holedPoly, Boolean.TRUE, "M", null, null),
                        new CuttingTask.Line(2, "配套小片", 120, 100, 2, true, null, null, "S", null, null)
                ),
                new CuttingTask.Process(1800, 30, "left-top", "horizontal", false, true, 5.0)
        ));

        var acceptedRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "widthMm", 1500,
                "windowLengthMm", 1800,
                "pieceGapMm", 5.0,
                "trimStartMm", 30.0,
                "allowGapFill", true,
                "timeLimitSeconds", 4
        ), "wb-contour-" + UUID.randomUUID());
        assertEquals(202, acceptedRes.statusCode(), acceptedRes.body());
        JsonNode accepted = json.readTree(acceptedRes.body());
        String jobId = accepted.get("job").get("id").asString();
        assertEquals("CONTOUR_2D", accepted.get("source").get("dimension").asString());
        assertEquals(0.0, accepted.get("source").get("rectGapPaddingMm").asDouble(), 0.001);

        OptimizationJob finished = waitTerminal(jobId);
        assertEquals("SUCCEEDED", finished.state(), finished.toString());

        var ctxRes = get("/api/v2/workbench/results/" + jobId + "/context");
        assertEquals(200, ctxRes.statusCode(), ctxRes.body());
        JsonNode ctx = json.readTree(ctxRes.body());
        assertEquals("CONTOUR", ctx.get("input").get("problem").get("process").get("mode").asString());
        assertEquals(1, ctx.get("input").get("problem").get("parts").get(0).get("shape").get("holes").size(), "异形内孔应无损透传");
        assertEquals("COMPLETE", ctx.get("result").get("fulfillmentStatus").asString());
    }

    @Test
    void slitting1DOrchestrationAndComparisonWorks() throws Exception {
        MotherRollInfo roll = savePassedRoll("ROLL-WB-1D-" + UUID.randomUUID().toString().substring(0, 6), 2400, 20000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "一维分切任务", "FILM-2400", null, 0,
                List.of(
                        new CuttingTask.Line(1, "500条", 500, 1000, 4, false, null, null, null, null, "单面电晕"),
                        new CuttingTask.Line(2, "600条", 600, 1000, 2, false, null, null, null, null, "单面电晕")
                ),
                new CuttingTask.Process(2000, 0, "left-top", "vertical", false, true, 0.0),
                CuttingTask.SLITTING_1D,
                new CuttingTask.Slitting(10, 10, 1000, 2380, 10, 10)
        ));

        var fastRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "objective", "FAST",
                "timeLimitSeconds", 10
        ), "wb-slit-fast-" + UUID.randomUUID());
        assertEquals(202, fastRes.statusCode(), fastRes.body());
        String fastId = json.readTree(fastRes.body()).get("job").get("id").asString();

        var qualityRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "objective", "QUALITY",
                "timeLimitSeconds", 10
        ), "wb-slit-qual-" + UUID.randomUUID());
        assertEquals(202, qualityRes.statusCode(), qualityRes.body());
        String qualityId = json.readTree(qualityRes.body()).get("job").get("id").asString();

        assertEquals("SUCCEEDED", waitTerminal(fastId).state());
        assertEquals("SUCCEEDED", waitTerminal(qualityId).state());

        var cmpRes = get("/api/v2/workbench/tasks/" + task.id() + "/result-comparison?leftId=" + fastId + "&rightId=" + qualityId);
        assertEquals(200, cmpRes.statusCode(), cmpRes.body());
        WorkbenchComparison cmp = json.readValue(cmpRes.body(), WorkbenchComparison.class);
        assertTrue(cmp.sameConstraints(), "同上下文仅切换 FAST/QUALITY 应视为同硬约束可比: " + cmp.constraintDifferences());
        assertEquals("COMPARABLE", cmp.lengthComparison().status());
        assertNotNull(cmp.lengthComparison().savedLengthMm());
        assertEquals(6, cmp.left().requested());
        assertEquals(0, cmp.left().unplaced());
    }

    @Test
    void rejectsPendingScrappedExhaustedMaterialsAndZeroOpenDemandWith422() throws Exception {
        // 1. 待检母卷 PENDING -> 422 MATERIAL_NOT_READY
        MotherRollInfo pendingRoll = new MotherRollInfo("ROLL-PENDING-" + UUID.randomUUID().toString().substring(0, 6), "TC-2026", 1800, 5000, 0, 0);
        pendingRoll.setInspectionStatus("PENDING");
        inventory.saveOrUpdateMotherRoll(pendingRoll);

        // 2. 已报废母卷 SCRAPPED -> 422 MATERIAL_NOT_READY
        MotherRollInfo scrappedRoll = new MotherRollInfo("ROLL-SCRAP-" + UUID.randomUUID().toString().substring(0, 6), "TC-2026", 1800, 5000, 0, 0);
        scrappedRoll.setInspectionStatus("SCRAPPED");
        inventory.saveOrUpdateMotherRoll(scrappedRoll);

        // 3. 已耗尽母卷 -> 422 MATERIAL_NOT_READY
        MotherRollInfo exhaustedRoll = new MotherRollInfo("ROLL-EMPTY-" + UUID.randomUUID().toString().substring(0, 6), "TC-2026", 1800, 5000, 0, 0);
        exhaustedRoll.setInspectionStatus("PASSED");
        exhaustedRoll.setUsedLength(5000);
        exhaustedRoll.setCurrentRemainingLength(0);
        inventory.saveOrUpdateMotherRoll(exhaustedRoll);

        // 4. 已消耗料头 CONSUMED -> 422 MATERIAL_NOT_READY
        RemnantStock consumedRem = new RemnantStock(
                "REM-USED-" + UUID.randomUUID().toString().substring(0, 6),
                1200, 1500, "A-01", "TC-2026", "CONSUMED", pendingRoll.getRollId(), false, ""
        );
        inventory.registerRemnant(consumedRem);

        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "拦截校验任务", "TC-2026", null, 0,
                List.of(new CuttingTask.Line(1, "常规片", 500, 500, 2, true))
        ));

        for (Map<String, Object> badReq : List.of(
                Map.<String, Object>of("materialType", "STOCK_ROLL", "materialId", pendingRoll.getRollId()),
                Map.<String, Object>of("materialType", "STOCK_ROLL", "materialId", scrappedRoll.getRollId()),
                Map.<String, Object>of("materialType", "STOCK_ROLL", "materialId", exhaustedRoll.getRollId()),
                Map.<String, Object>of("materialType", "REMNANT", "materialId", consumedRem.getId())
        )) {
            var res = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", badReq, null);
            assertEquals(422, res.statusCode(), res.body());
            assertEquals("MATERIAL_NOT_READY", json.readTree(res.body()).get("code").asString());
        }

        // 5. 需求已全部被活跃方案预占（openQty == 0）-> 422 NO_OPEN_DEMAND
        studioService.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "cfm-zero-" + UUID.randomUUID(),
                "已满排方案",
                "RECT_2D",
                "SHORTEN_KIT",
                "TEST_STRAT",
                "测试策略",
                task.id(),
                task.name(),
                null,
                "VIRTUAL_ROLL",
                null,
                null,
                "TC-2026",
                1500.0,
                1000.0,
                0.0,
                1000.0,
                0.0,
                0.0,
                33.33,
                0.5,
                true,
                List.of(new SchedulingStudioService.DemandLineInput(
                        1, "常规片", 500, 500, 2, true, null, null, null, null, null)),
                new com.example.cutdemotwo.business.model.SchedulingScheme.Layout2DPayload(
                        List.of(
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(1, 1, "常规片", 0, 0, 500, 500, 0, false, null),
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(2, 1, "常规片", 500, 0, 500, 500, 0, false, null)
                        ),
                        List.of(),
                        List.of()
                ),
                null
        ));

        var zeroDemandRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "widthMm", 1500,
                "windowLengthMm", 2000
        ), null);
        assertEquals(422, zeroDemandRes.statusCode(), zeroDemandRes.body());
        assertEquals("NO_OPEN_DEMAND", json.readTree(zeroDemandRes.body()).get("code").asString());
    }

    @Test
    void comparisonDetectsSameContextComparableDifferentContextAndIncomplete() throws Exception {
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "双方案同口径对比任务", "TC-CMP", null, 0,
                List.of(
                        new CuttingTask.Line(1, "大裁片", 700, 900, 2, true),
                        new CuttingTask.Line(2, "小裁片", 400, 500, 2, true)
                ),
                new CuttingTask.Process(2500, 0, "left-top", "horizontal", true, true, 10.0)
        ));

        // 案 A 与 案 B：同自由画布、同直刀间距外扩 10mm、均齐套 -> COMPARABLE
        var resA = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "materialId", "CMP-CANVAS-1",
                "widthMm", 1600,
                "windowLengthMm", 2500,
                "pieceGapMm", 10.0,
                "timeLimitSeconds", 3
        ), "wb-cmp-a-" + UUID.randomUUID());
        assertEquals(202, resA.statusCode(), resA.body());
        String idA = json.readTree(resA.body()).get("job").get("id").asString();

        var resB = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "materialId", "CMP-CANVAS-1",
                "widthMm", 1600,
                "windowLengthMm", 2500,
                "pieceGapMm", 10.0,
                "timeLimitSeconds", 4
        ), "wb-cmp-b-" + UUID.randomUUID());
        assertEquals(202, resB.statusCode(), resB.body());
        String idB = json.readTree(resB.body()).get("job").get("id").asString();

        // 案 C：不同门幅（不同上下文） -> DIFFERENT_CONTEXT
        var resC = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "materialId", "CMP-CANVAS-2",
                "widthMm", 1800,
                "windowLengthMm", 2500,
                "pieceGapMm", 10.0,
                "timeLimitSeconds", 3
        ), "wb-cmp-c-" + UUID.randomUUID());
        assertEquals(202, resC.statusCode(), resC.body());
        String idC = json.readTree(resC.body()).get("job").get("id").asString();

        // 案 D：极短窗长导致无法齐套（PARTIAL） -> INCOMPLETE
        var resD = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "materialId", "CMP-CANVAS-1",
                "widthMm", 1600,
                "windowLengthMm", 950,
                "pieceGapMm", 10.0,
                "timeLimitSeconds", 3
        ), "wb-cmp-d-" + UUID.randomUUID());
        assertEquals(202, resD.statusCode(), resD.body());
        String idD = json.readTree(resD.body()).get("job").get("id").asString();

        assertEquals("SUCCEEDED", waitTerminal(idA).state());
        assertEquals("SUCCEEDED", waitTerminal(idB).state());
        assertEquals("SUCCEEDED", waitTerminal(idC).state());
        assertEquals("SUCCEEDED", waitTerminal(idD).state());

        // 1. A vs B 同上下文同约束双齐套，并还原 rectGapPaddingMm
        var cmpABRes = get("/api/v2/workbench/tasks/" + task.id() + "/result-comparison?leftId=" + idA + "&rightId=" + idB);
        assertEquals(200, cmpABRes.statusCode(), cmpABRes.body());
        WorkbenchComparison cmpAB = json.readValue(cmpABRes.body(), WorkbenchComparison.class);
        assertTrue(cmpAB.sameConstraints());
        assertEquals("COMPARABLE", cmpAB.lengthComparison().status());
        assertEquals(0.0, cmpAB.lengthComparison().savedLengthMm(), 0.01);
        assertEquals(10.0, cmpAB.left().rectGapPaddingMm(), 0.001);
        assertNotNull(cmpAB.left().occupiedLengthMm());
        assertTrue(cmpAB.left().metrics().stream().anyMatch(m -> "workbench-physical-1".equals(m.version())),
                "存在直刀外扩时应还原物理面积口径指标");

        // 2. A vs C 不同上下文，禁止计算 savedLengthMm
        var cmpACRes = get("/api/v2/workbench/tasks/" + task.id() + "/result-comparison?leftId=" + idA + "&rightId=" + idC);
        assertEquals(200, cmpACRes.statusCode(), cmpACRes.body());
        WorkbenchComparison cmpAC = json.readValue(cmpACRes.body(), WorkbenchComparison.class);
        assertFalse(cmpAC.sameConstraints());
        assertEquals("DIFFERENT_CONTEXT", cmpAC.lengthComparison().status());
        assertNull(cmpAC.lengthComparison().savedLengthMm());

        // 3. D vs D2（相同极短窗长，但未齐套） -> INCOMPLETE
        var resD2 = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "FREE_CANVAS",
                "materialId", "CMP-CANVAS-1",
                "widthMm", 1600,
                "windowLengthMm", 950,
                "pieceGapMm", 10.0,
                "timeLimitSeconds", 4
        ), "wb-cmp-d2-" + UUID.randomUUID());
        String idD2 = json.readTree(resD2.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(idD2).state());
        var cmpDD2Res = get("/api/v2/workbench/tasks/" + task.id() + "/result-comparison?leftId=" + idD + "&rightId=" + idD2);
        assertEquals(200, cmpDD2Res.statusCode(), cmpDD2Res.body());
        WorkbenchComparison cmpDD2 = json.readValue(cmpDD2Res.body(), WorkbenchComparison.class);
        assertTrue(cmpDD2.sameConstraints());
        assertEquals("INCOMPLETE", cmpDD2.lengthComparison().status());
        assertNull(cmpDD2.lengthComparison().savedLengthMm());
        assertTrue(cmpDD2.left().unplaced() > 0);
    }

    @Test
    void draftPersistenceZeroInventoryMutationStaleDetectionAndExpiryWork() throws Exception {
        MotherRollInfo roll = savePassedRoll("ROLL-DFT-" + UUID.randomUUID().toString().substring(0, 6), 1800, 8000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "草案漂移测试任务", "TC-2026", null, 0,
                List.of(new CuttingTask.Line(1, "门板", 600, 800, 2, true))
        ));

        var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-dft-" + UUID.randomUUID());
        assertEquals(202, planRes.statusCode(), planRes.body());
        String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(resultId).state());

        long revBeforeDraft = currentInventoryRevision();
        var createRes = post("/api/v2/workbench/drafts", Map.of(
                "resultId", resultId,
                "note", "请班长核对避疵后确认",
                "ttlSeconds", 1200
        ), null);
        assertEquals(201, createRes.statusCode(), createRes.body());
        assertEquals(revBeforeDraft, currentInventoryRevision(), "创建持久化草案严禁修改库存 revision");

        WorkbenchSchemeDraft created = json.readValue(createRes.body(), WorkbenchSchemeDraft.class);
        assertEquals(created.id(), created.draftId());
        assertEquals("PENDING_CONFIRMATION", created.status());
        assertTrue(created.requiresHumanConfirmation());
        assertFalse(created.inventoryMutated());
        assertFalse(created.stale());
        assertEquals(64, created.contentHash().length());
        assertTrue(created.approvalToken().startsWith("APR-"));
        assertEquals(task.id(), created.target().taskId());
        assertEquals(roll.getRollId(), created.target().materialId());
        assertEquals("STOCK_ROLL", created.target().materialType());
        assertTrue(created.workbenchUrl().contains("taskId=" + task.id()));
        assertTrue(created.workbenchUrl().contains("resultId=" + resultId));
        assertTrue(created.workbenchUrl().contains("draftId=" + created.draftId()));
        assertFalse(created.riskChecks().isEmpty());
        assertTrue(Files.exists(temp.resolve("inventory.json.drafts").resolve(created.draftId() + ".json")),
                "草案应写入独立 *.drafts 目录");

        // 模拟外部库存与任务版本变更（给母卷新增一处疵点，触发库存 revision 递增）
        inventory.addDefectToRoll(roll.getRollId(), new Defect(10, 300, 400, 80, 80, 20));
        assertTrue(currentInventoryRevision() > revBeforeDraft);

        var staleRes = get("/api/v2/workbench/drafts/" + created.draftId());
        assertEquals(200, staleRes.statusCode(), staleRes.body());
        WorkbenchSchemeDraft staleDraft = json.readValue(staleRes.body(), WorkbenchSchemeDraft.class);
        assertEquals("PENDING_CONFIRMATION", staleDraft.status());
        assertTrue(staleDraft.stale(), "库存 revision 变化后应动态标记 stale=true");
        assertFalse(staleDraft.staleReasons().isEmpty());

        // 使用可控时钟验证 TTL 过期动态判定 EXPIRED
        MutableClock clock = new MutableClock(Instant.parse("2026-11-26T00:00:00Z"));
        Path isolatedDraftDir = temp.resolve("clock-drafts-" + UUID.randomUUID());
        try (var isolatedStore = new FileWorkbenchDraftStore(isolatedDraftDir)) {
            WorkbenchDraftService timedService = new WorkbenchDraftService(inventory, optimizationService, isolatedStore, clock);
            WorkbenchSchemeDraft shortDraft = timedService.createDraft(
                    new WorkbenchDraftService.CreateDraftRequest(resultId, null, null, null, "短时草案", 60L)
            );
            assertEquals("PENDING_CONFIRMATION", timedService.getDraft(shortDraft.draftId()).status());
            clock.advanceSeconds(61);
            assertEquals("EXPIRED", timedService.getDraft(shortDraft.draftId()).status());
        }
    }

    @Test
    void fileAndJdbcStoresPersistDraftsAndBackwardCompatibleOptimizationJobs() throws Exception {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();

        // 1. 验证 JDBC(H2/MySQL) + File 双草案存储读写一致
        WorkbenchSchemeDraft sample = new WorkbenchSchemeDraft(
                "DFT-STORAGE-01",
                "DFT-STORAGE-01",
                WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION,
                "APR-1234567890ABCDEF",
                "0".repeat(64),
                "2026-11-26T01:00:00Z",
                "2026-11-26T01:30:00Z",
                1800L,
                true,
                false,
                false,
                List.of(),
                new WorkbenchSchemeDraft.Target("RES-1", "TASK-1", "ROLL-1", "STOCK_ROLL"),
                List.of(new WorkbenchSchemeDraft.RiskCheck("RESULT_VALIDATED", true, "已通过校验")),
                "/app/#/workbench?taskId=TASK-1&resultId=RES-1&draftId=DFT-STORAGE-01",
                "请人工确认",
                "双存储测试",
                1L,
                5L
        );

        JdbcWorkbenchDraftStore jdbcDraftStore = new JdbcWorkbenchDraftStore(ds);
        jdbcDraftStore.save(sample);
        var loadedJdbc = jdbcDraftStore.find(sample.draftId()).orElseThrow();
        assertEquals(sample, loadedJdbc);
        assertEquals(1, jdbcDraftStore.listByTask("TASK-1").size());

        Path fileDraftDir = temp.resolve("unit-drafts-" + UUID.randomUUID());
        try (var fileDraftStore = new FileWorkbenchDraftStore(fileDraftDir)) {
            fileDraftStore.save(sample);
            assertEquals(sample, fileDraftStore.find(sample.draftId()).orElseThrow());
            assertEquals(1, fileDraftStore.listByTask("TASK-1").size());
        }

        // 2. 验证 StoredOptimizationJob 带 workbenchSource 与历史 4 字段 JSON 双向兼容（File + JDBC）
        OptimizationRequest req = new OptimizationRequest(
                "2.0", "NESTING_2D", "COMPAT-001",
                new NestingProblem("1", "mm",
                        new NestingProblem.Material("M1", NestingProblem.Shape.rectangle(1000, 1000), List.of(), false),
                        List.of(new NestingProblem.Part(1, "P1", NestingProblem.Shape.rectangle(500, 500), 1, false)),
                        new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", 0, 200, 300, 0, "MAXIMIZE_PIECE_AREA"),
                        "auto", 3),
                true, false
        );
        String legacyJobId = UUID.randomUUID().toString();
        OptimizationJob legacyJob = new OptimizationJob(
                legacyJobId, "2.0", "COMPAT-001", StoredOptimizationJob.inputHash(req),
                "SUCCEEDED", "STOPPED", "2026-11-26T00:00:00Z", "2026-11-26T00:00:01Z",
                "2026-11-26T00:00:02Z", 3, null, null, "ok"
        );
        String legacyJson = json.writeValueAsString(Map.of(
                "idempotencyKey", "legacy-key-001",
                "input", req,
                "job", legacyJob
        ));

        Path jobDir = temp.resolve("compat-jobs-" + UUID.randomUUID());
        Files.createDirectories(jobDir);
        Files.writeString(jobDir.resolve(legacyJobId + ".json"), legacyJson);
        try (var fileJobStore = new FileOptimizationJobStore(jobDir)) {
            List<StoredOptimizationJob> loaded = fileJobStore.load();
            assertEquals(1, loaded.size());
            assertNull(loaded.get(0).workbenchSource(), "旧 4 字段 JSON 应平滑反序列化且 workbenchSource 为 null");

            String sourcedJobId = UUID.randomUUID().toString();
            OptimizationJob sourcedJob = new OptimizationJob(
                    sourcedJobId, "2.0", "COMPAT-002", StoredOptimizationJob.inputHash(req),
                    "QUEUED", "QUEUED", "2026-11-26T00:00:00Z", null, null, 3, null, null, "queued"
            );
            WorkbenchJobSource src = new WorkbenchJobSource(
                    "TASK-9", "planner", 2L, "STOCK_ROLL", "ROLL-9", 7L,
                    1000, 0, 1000, 5.0, Map.of(1, 1), "RECT_2D", "ROLL-9", true, 0.0, 5.0
            );
            StoredOptimizationJob withSource = new StoredOptimizationJob("sourced-key-001", req, sourcedJob, null, src);
            fileJobStore.save(withSource);
            StoredOptimizationJob reloaded = fileJobStore.load().stream()
                    .filter(d -> sourcedJobId.equals(d.job().id())).findFirst().orElseThrow();
            assertEquals(src, reloaded.workbenchSource());

            JdbcOptimizationJobStore jdbcJobStore = new JdbcOptimizationJobStore(ds);
            jdbcJobStore.configure(1, 4, 100);
            jdbcJobStore.submitOrGet(withSource);
            assertEquals(src, jdbcJobStore.find(sourcedJobId).workbenchSource());
        }
    }

    @Test
    void draftLifecycleListConfirmDiscardAndScheduledCleanupWorkAcrossFileAndJdbcStores() throws Exception {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();

        MotherRollInfo roll = savePassedRoll("ROLL-LIFE-" + UUID.randomUUID().toString().substring(0, 6), 1600, 6000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "草案阶段二生命周期任务", "TC-LIFE", null, 0,
                List.of(new CuttingTask.Line(1, "门片", 500, 600, 2, true))
        ));

        var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-life-" + UUID.randomUUID());
        assertEquals(202, planRes.statusCode(), planRes.body());
        String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(resultId).state());

        long revBefore = currentInventoryRevision();

        // 创建 2 份待确认草案用于验证列表、confirm 与 discard 端点
        var d1Res = post("/api/v2/workbench/drafts", Map.of(
                "resultId", resultId,
                "note", "草案一-用于作废",
                "ttlSeconds", 1200
        ), null);
        assertEquals(201, d1Res.statusCode(), d1Res.body());
        String d1Id = json.readValue(d1Res.body(), WorkbenchSchemeDraft.class).draftId();

        var d2Res = post("/api/v2/workbench/drafts", Map.of(
                "resultId", resultId,
                "note", "草案二-用于确认",
                "ttlSeconds", 1200
        ), null);
        assertEquals(201, d2Res.statusCode(), d2Res.body());
        String d2Id = json.readValue(d2Res.body(), WorkbenchSchemeDraft.class).draftId();

        // 1. GET /api/v2/workbench/drafts 分页与过滤
        var listRes = get("/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&taskId=" + task.id() + "&page=0&size=10");
        assertEquals(200, listRes.statusCode(), listRes.body());
        JsonNode listJson = json.readTree(listRes.body());
        assertTrue(listJson.get("total").asLong() >= 2);
        assertTrue(listJson.get("pendingCount").asLong() >= 2);

        // 2. 作废 d1 并验证重复作废/确认均返回 409
        var discardRes = post("/api/v2/workbench/drafts/" + d1Id + "/discard", Map.of(
                "reason", "现场改用其他门幅",
                "operator", "planner-a"
        ), null);
        assertEquals(200, discardRes.statusCode(), discardRes.body());
        WorkbenchSchemeDraft discarded = json.readValue(discardRes.body(), WorkbenchSchemeDraft.class);
        assertEquals(WorkbenchSchemeDraft.STATUS_DISCARDED, discarded.status());
        assertEquals("现场改用其他门幅", discarded.discardReason());
        assertEquals("planner-a", discarded.discardedBy());
        assertNotNull(discarded.discardedAt());

        assertEquals(409, post("/api/v2/workbench/drafts/" + d1Id + "/discard", Map.of("reason", "dup"), null).statusCode());
        assertEquals(409, post("/api/v2/workbench/drafts/" + d1Id + "/confirm", Map.of("schemeId", "SCH-X"), null).statusCode());
        assertEquals(404, post("/api/v2/workbench/drafts/DFT-MISSING-999/discard", Map.of("reason", "x"), null).statusCode());

        // 3. 确认 d2 并验证重复确认/作废返回 409
        var confirmRes = post("/api/v2/workbench/drafts/" + d2Id + "/confirm", Map.of(
                "schemeId", "SCH-DIRECT-02",
                "operator", "planner-b"
        ), null);
        assertEquals(200, confirmRes.statusCode(), confirmRes.body());
        WorkbenchSchemeDraft confirmed = json.readValue(confirmRes.body(), WorkbenchSchemeDraft.class);
        assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, confirmed.status());
        assertEquals("SCH-DIRECT-02", confirmed.confirmedSchemeId());
        assertEquals("planner-b", confirmed.confirmedBy());
        assertEquals(409, post("/api/v2/workbench/drafts/" + d2Id + "/confirm", Map.of(), null).statusCode());
        assertEquals(409, post("/api/v2/workbench/drafts/" + d2Id + "/discard", Map.of("reason", "too late"), null).statusCode());

        assertEquals(revBefore, currentInventoryRevision(), "草案查询、确认状态标定与作废均绝不修改实物库存");

        // 4. 使用 MutableClock 验证 JDBC(V12) + File 双存储的 saveAll/query/CAS/expireAndPurge 滚动清理一致
        MutableClock clock = new MutableClock(Instant.parse("2026-11-27T00:00:00Z"));
        JdbcWorkbenchDraftStore jdbcStore = new JdbcWorkbenchDraftStore(ds);
        Path cleanDir = temp.resolve("cleanup-drafts-" + UUID.randomUUID());
        try (var fileStore = new FileWorkbenchDraftStore(cleanDir)) {
            for (var store : List.of(jdbcStore, fileStore)) {
                WorkbenchDraftService svc = new WorkbenchDraftService(inventory, optimizationService, store, clock);
                List<WorkbenchSchemeDraft> batch = svc.createBatchDrafts("MMB-CLEAN-01", List.of(
                        new WorkbenchDraftService.CreateDraftRequest(resultId, null, null, null, "批组-1", 60L),
                        new WorkbenchDraftService.CreateDraftRequest(resultId, null, null, null, "批组-2", 60L)
                ));
                assertEquals(2, batch.size());
                assertEquals("MMB-CLEAN-01", batch.get(0).batchGroupId());
                assertEquals(1, batch.get(0).batchIndex());
                assertEquals(2, batch.get(1).batchIndex());

                // 先确认第 1 条
                svc.confirmDraft(batch.get(0).draftId(), new WorkbenchDraftService.ConfirmDraftRequest("SCH-C1", "op1"), "op1");
                // 推进 65 秒，第 2 条过期，第 1 条已确认终态绝不被覆盖为 EXPIRED
                clock.advanceSeconds(65);
                assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, svc.getDraft(batch.get(0).draftId()).status());
                assertEquals(WorkbenchSchemeDraft.STATUS_EXPIRED, svc.getDraft(batch.get(1).draftId()).status());

                // retentionHours = 24 时标态为 EXPIRED 但不物理删除
                svc.cleanupExpiredDrafts(24);
                assertTrue(store.find(batch.get(1).draftId()).isPresent());
                assertEquals(WorkbenchSchemeDraft.STATUS_EXPIRED, store.find(batch.get(1).draftId()).orElseThrow().status());

                // 再推进 25 小时后执行滚动清理，两条记录均被物理清除
                clock.advanceSeconds(25 * 3600L);
                int purged = svc.cleanupExpiredDrafts(24);
                assertTrue(purged >= 2);
                assertTrue(store.find(batch.get(1).draftId()).isEmpty());
                assertTrue(store.find(batch.get(0).draftId()).isEmpty());
                // 重置时钟给下一个 store
                clock.advanceSeconds(-25 * 3600L - 65);
            }
        }
    }

    @Test
    void confirmSchemeWithDraftIdLinksDraftAndRejectsExpiredOrDiscardedWithZeroInventoryMutation() throws Exception {
        MotherRollInfo roll = savePassedRoll("ROLL-LINK-" + UUID.randomUUID().toString().substring(0, 6), 1600, 6000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "方案确认联动草案任务", "TC-LINK", null, 0,
                List.of(new CuttingTask.Line(1, "常规片", 500, 500, 2, true))
        ));

        var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-link-" + UUID.randomUUID());
        assertEquals(202, planRes.statusCode(), planRes.body());
        String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(resultId).state());

        // 创建一条待作废草案与一条待确认草案
        String discardedId = json.readValue(
                post("/api/v2/workbench/drafts", Map.of("resultId", resultId, "ttlSeconds", 1200), null).body(),
                WorkbenchSchemeDraft.class
        ).draftId();
        assertEquals(200, post("/api/v2/workbench/drafts/" + discardedId + "/discard", Map.of("reason", "测试拦截"), null).statusCode());

        String activeDraftId = json.readValue(
                post("/api/v2/workbench/drafts", Map.of("resultId", resultId, "ttlSeconds", 1200), null).body(),
                WorkbenchSchemeDraft.class
        ).draftId();

        long revBeforeRejected = currentInventoryRevision();
        SchedulingStudioService.ConfirmSchemeCommand discardedCmd = buildSampleConfirmCmd(
                "cfm-discarded-" + UUID.randomUUID(), task, discardedId
        );
        var rejectedRes = post("/api/v2/schemes/confirm", discardedCmd, null);
        assertEquals(409, rejectedRes.statusCode(), rejectedRes.body());
        assertEquals("DRAFT_DISCARDED", json.readTree(rejectedRes.body()).get("code").asString());
        assertEquals(revBeforeRejected, currentInventoryRevision(), "已作废草案拦截必须发生在锁库之前");

        var missingRes = post("/api/v2/schemes/confirm",
                buildSampleConfirmCmd("cfm-missing-" + UUID.randomUUID(), task, "DFT-NOT-EXIST-1"), null);
        assertEquals(404, missingRes.statusCode(), missingRes.body());
        assertEquals(revBeforeRejected, currentInventoryRevision());

        // 有效 draftId 确认落库并联动回写 CONFIRMED
        String idemKey = "cfm-valid-" + UUID.randomUUID();
        SchedulingStudioService.ConfirmSchemeCommand validCmd = buildSampleConfirmCmd(idemKey, task, activeDraftId);
        var okRes = post("/api/v2/schemes/confirm", validCmd, null);
        assertEquals(200, okRes.statusCode(), okRes.body());
        JsonNode okJson = json.readTree(okRes.body());
        String schemeId = okJson.get("scheme").get("id").asString();
        assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, okJson.get("draft").get("status").asString());
        assertEquals(schemeId, okJson.get("draft").get("confirmedSchemeId").asString());

        WorkbenchSchemeDraft reloaded = json.readValue(get("/api/v2/workbench/drafts/" + activeDraftId).body(), WorkbenchSchemeDraft.class);
        assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, reloaded.status());
        assertEquals(schemeId, reloaded.confirmedSchemeId());

        // 同幂等键重放应幂等放行；不同幂等键再次绑定同草案返回 409
        var replayRes = post("/api/v2/schemes/confirm", validCmd, null);
        assertEquals(200, replayRes.statusCode(), replayRes.body());
        assertEquals(schemeId, json.readTree(replayRes.body()).get("scheme").get("id").asString());

        var conflictRes = post("/api/v2/schemes/confirm",
                buildSampleConfirmCmd("cfm-other-" + UUID.randomUUID(), task, activeDraftId), null);
        assertEquals(409, conflictRes.statusCode(), conflictRes.body());
        assertEquals("DRAFT_ALREADY_CONFIRMED", json.readTree(conflictRes.body()).get("code").asString());
    }

    @Test
    void multiMaterialDraftsRelayAcrossRollsArchivesResultsAndMutatesZeroInventory() throws Exception {
        String model = "RELAY-M-" + UUID.randomUUID().toString().substring(0, 6);
        RemnantStock rem = new RemnantStock(
                "REM-RLY-" + UUID.randomUUID().toString().substring(0, 6),
                1500, 1000, "A-01", model, "AVAILABLE", null, false, ""
        );
        inventory.registerRemnant(rem);

        // 两卷同门幅母卷（各 2200mm，每次最多放约 4 件 500×500 裁片；8 件任务需要料头 + 两卷连续接力）
        MotherRollInfo rollA = new MotherRollInfo("ROLL-RLY-A-" + UUID.randomUUID().toString().substring(0, 5), model, 1100, 2200, 0, 0);
        rollA.setInspectionStatus("PASSED");
        inventory.saveOrUpdateMotherRoll(rollA);
        MotherRollInfo rollB = new MotherRollInfo("ROLL-RLY-B-" + UUID.randomUUID().toString().substring(0, 5), model, 1100, 2200, 0, 0);
        rollB.setInspectionStatus("PASSED");
        inventory.saveOrUpdateMotherRoll(rollB);

        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "多料跨卷连续接力任务", model, null, 0,
                List.of(new CuttingTask.Line(1, "小方片", 500, 500, 8, false))
        ));

        long revBefore = currentInventoryRevision();

        // 1. 先验证 continueAcrossRolls=false 保持单卷推荐零回归，continueAcrossRolls=true 激活两卷接力
        var singleRes = globalPlanningService.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                task.id(), model, null, null, true, 4, null, 5000L, 0.0, 0.0, null, false
        ));
        long singleRecommendedCount = singleRes.rollOptions().stream().filter(GlobalPlanningService.RollOption::recommended).count();
        assertTrue(singleRecommendedCount <= 1, "默认非跨卷模式最多推荐 1 卷");

        var relayRes = globalPlanningService.planMultiMaterial(new GlobalPlanningService.MultiMaterialPlanRequest(
                task.id(), model, null, null, true, 4, null, 5000L, 0.0, 0.0, null, true
        ));
        assertEquals(8, relayRes.totalRequestedPieces());
        assertEquals(relayRes.totalRequestedPieces(),
                relayRes.placedByRemnants() + relayRes.placedByRoll() + relayRes.unplacedPieces());
        assertTrue(relayRes.placedByRemnants() > 0);
        assertTrue(relayRes.placedByRoll() > 0);
        List<GlobalPlanningService.RollOption> relayRecommended = relayRes.rollOptions().stream()
                .filter(GlobalPlanningService.RollOption::recommended)
                .toList();
        assertTrue(relayRecommended.size() >= 1);
        assertNotNull(relayRecommended.get(0).relayOrder());
        assertNotNull(relayRecommended.get(0).allocatedItems());

        // 校验 continueAcrossRolls=true 序列化 JSON 全部属性均在 openapi.json 声明
        var openApiRoot = json.readTree(Files.readString(Path.of("src/main/resources/static/api-v2/openapi.json")));
        var schemas = openApiRoot.get("components").get("schemas");
        JsonNode relayTree = json.readTree(json.writeValueAsString(relayRes));
        var rollProps = schemas.get("MultiMaterialRollOption").get("properties");
        for (var opt : relayTree.get("rollOptions")) {
            opt.propertyNames().forEach(k -> assertTrue(rollProps.has(k), "MultiMaterialRollOption 未在 OpenAPI 声明: " + k));
        }

        // 2. 调用 POST /api/v2/workbench/multi-material-drafts 批量归档 resultId 与生成同 batchGroupId 草案组
        var batchHttpRes = post("/api/v2/workbench/multi-material-drafts", Map.of(
                "taskId", task.id(),
                "materialModel", model,
                "preferRemnants", true,
                "maxRemnants", 4,
                "continueAcrossRolls", true,
                "note", "多母卷接力试排",
                "ttlSeconds", 1800
        ), "mmb-test-" + UUID.randomUUID());
        assertEquals(201, batchHttpRes.statusCode(), batchHttpRes.body());
        assertEquals(revBefore, currentInventoryRevision(), "批量生成联排草案组严禁锁定或扣减任何实物库存");

        JsonNode batchJson = json.readTree(batchHttpRes.body());
        String batchGroupId = batchJson.get("batchGroupId").asString();
        assertFalse(batchGroupId.isBlank());
        assertFalse(batchJson.get("inventoryMutated").asBoolean());
        assertTrue(batchJson.get("requiresHumanConfirmation").asBoolean());
        int draftCount = batchJson.get("draftCount").asInt();
        assertTrue(draftCount >= 2, "料头+母卷接力应至少生成 2 份草案: " + batchHttpRes.body());

        // 验证批组查询返回全部同组草案，且每个 resultId 均可被工作台上下文接口读取
        var groupListRes = get("/api/v2/workbench/drafts?batchGroupId=" + batchGroupId);
        assertEquals(200, groupListRes.statusCode());
        assertEquals(draftCount, json.readTree(groupListRes.body()).get("total").asInt());

        JsonNode firstDraft = batchJson.get("drafts").get(0);
        String firstDraftId = firstDraft.get("draftId").asString();
        for (JsonNode d : batchJson.get("drafts")) {
            assertEquals(batchGroupId, d.get("batchGroupId").asString());
            String rid = d.get("target").get("resultId").asString();
            var ctxRes = get("/api/v2/workbench/results/" + rid + "/context");
            assertEquals(200, ctxRes.statusCode(), "归档 resultId 必须可被工作台深链读取: " + ctxRes.body());
        }

        // 3. 选定批组第 1 份草案正式落库，验证联动标为 CONFIRMED
        var confirmFirstRes = post("/api/v2/schemes/confirm",
                buildSampleConfirmCmd("cfm-batch-" + UUID.randomUUID(), task, firstDraftId), null);
        assertEquals(200, confirmFirstRes.statusCode(), confirmFirstRes.body());
        assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED,
                json.readTree(confirmFirstRes.body()).get("draft").get("status").asString());
    }

    @Test
    void concurrentConfirmSchemeWithDraftAndDiscardOrDistinctKeysNeverSplitsState() throws Exception {
        MotherRollInfo roll = savePassedRoll("ROLL-CONC-" + UUID.randomUUID().toString().substring(0, 6), 1600, 6000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "并发对抗账实一致性任务", "TC-CONC", null, 0,
                List.of(new CuttingTask.Line(1, "常规片", 500, 500, 10, true))
        ));

        var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-conc-" + UUID.randomUUID());
        assertEquals(202, planRes.statusCode(), planRes.body());
        String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(resultId).state());

        // 1. 决定性 CountDownLatch 对抗：confirmSchemeWithDraft 落库后、CAS 回写前，并发线程触发 discardDraft 必须被锁阻塞并抛 409
        Path concDraftDir = temp.resolve("conc-drafts-" + UUID.randomUUID());
        try (var fileStore = new FileWorkbenchDraftStore(concDraftDir)) {
            WorkbenchDraftService isolatedDraftSvc = new WorkbenchDraftService(inventory, optimizationService, fileStore);
            String raceDraftId = isolatedDraftSvc.createDraft(
                    new WorkbenchDraftService.CreateDraftRequest(resultId, task.id(), roll.getRollId(), "STOCK_ROLL", "竞态测试", 1200L)
            ).draftId();

            CountDownLatch enteredConfirmScheme = new CountDownLatch(1);
            CountDownLatch discardAttempted = new CountDownLatch(1);
            SchedulingStudioService delayedStudioService = new SchedulingStudioService(inventory, nestingSolver) {
                @Override
                public Map<String, Object> confirmScheme(ConfirmSchemeCommand cmd) {
                    Map<String, Object> confirmed = super.confirmScheme(cmd);
                    enteredConfirmScheme.countDown();
                    try {
                        discardAttempted.await(150, TimeUnit.MILLISECONDS);
                        Thread.sleep(60);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                    }
                    return confirmed;
                }
            };

            ExecutorService pool = Executors.newFixedThreadPool(2);
            try {
                Future<Map<String, Object>> confirmFuture = pool.submit(() ->
                        isolatedDraftSvc.confirmSchemeWithDraft(
                                buildSampleConfirmCmd("conc-lock-" + UUID.randomUUID(), task, raceDraftId),
                                delayedStudioService,
                                "planner-a"
                        )
                );
                assertTrue(enteredConfirmScheme.await(5, TimeUnit.SECONDS));
                Future<WorkbenchSchemeDraft> discardFuture = pool.submit(() -> {
                    discardAttempted.countDown();
                    return isolatedDraftSvc.discardDraft(
                            raceDraftId,
                            new WorkbenchDraftService.DiscardDraftRequest("抢先作废攻击", "planner-b"),
                            "planner-b"
                    );
                });

                Map<String, Object> confirmOut = confirmFuture.get(10, TimeUnit.SECONDS);
                WorkbenchSchemeDraft confirmedDraft = (WorkbenchSchemeDraft) confirmOut.get("draft");
                assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, confirmedDraft.status());

                ExecutionException discardEx = assertThrows(ExecutionException.class, () -> discardFuture.get(10, TimeUnit.SECONDS));
                assertInstanceOf(OptimizationFailure.class, discardEx.getCause());
                assertEquals(409, ((OptimizationFailure) discardEx.getCause()).status);
                assertEquals("DRAFT_ALREADY_CONFIRMED", ((OptimizationFailure) discardEx.getCause()).code);
                assertEquals(1, studioService.listSchemes(null, task.id(), true).size());
            } finally {
                pool.shutdownNow();
            }
        }

        // 2. HTTP 并发对抗 A：多轮同时发起 confirmSchemeWithDraft + discardDraft，绝不允许“HTTP 409 但正式方案已落库”
        for (int round = 0; round < 5; round++) {
            CuttingTask raceTask = inventory.saveTask(new CuttingTask(
                    null, "HTTP并发对抗-" + round, "TC-CONC", null, 0,
                    List.of(new CuttingTask.Line(1, "常规片", 500, 500, 4, true))
            ));
            String raceDraftId = json.readValue(
                    post("/api/v2/workbench/drafts", Map.of("resultId", resultId, "ttlSeconds", 1200), null).body(),
                    WorkbenchSchemeDraft.class
            ).draftId();
            // 重新绑定一个指向 raceTask 的同构 result 以便 confirmScheme 扣减 raceTask
            var taskPlanRes = post("/api/v2/workbench/tasks/" + raceTask.id() + "/plan-jobs", Map.of(
                    "materialType", "STOCK_ROLL",
                    "materialId", roll.getRollId(),
                    "windowStartMm", 0,
                    "windowLengthMm", 2000,
                    "timeLimitSeconds", 3
            ), "wb-race-" + round + "-" + UUID.randomUUID());
            assertEquals(202, taskPlanRes.statusCode());
            String taskResultId = json.readTree(taskPlanRes.body()).get("job").get("id").asString();
            assertEquals("SUCCEEDED", waitTerminal(taskResultId).state());
            String targetDraftId = json.readValue(
                    post("/api/v2/workbench/drafts", Map.of("resultId", taskResultId, "ttlSeconds", 1200), null).body(),
                    WorkbenchSchemeDraft.class
            ).draftId();
            assertFalse(raceDraftId.equals(targetDraftId));

            final int roundIdx = round;
            CountDownLatch startGate = new CountDownLatch(1);
            ExecutorService httpPool = Executors.newFixedThreadPool(2);
            try {
                Future<HttpResponse<String>> cfmFut = httpPool.submit(() -> {
                    startGate.await(5, TimeUnit.SECONDS);
                    return post("/api/v2/schemes/confirm",
                            buildSampleConfirmCmd("http-race-cfm-" + roundIdx + "-" + UUID.randomUUID(), raceTask, targetDraftId),
                            null);
                });
                Future<HttpResponse<String>> dscFut = httpPool.submit(() -> {
                    startGate.await(5, TimeUnit.SECONDS);
                    return post("/api/v2/workbench/drafts/" + targetDraftId + "/discard",
                            Map.of("reason", "并发作废-" + roundIdx), null);
                });
                startGate.countDown();
                HttpResponse<String> cfmResp = cfmFut.get(10, TimeUnit.SECONDS);
                HttpResponse<String> dscResp = dscFut.get(10, TimeUnit.SECONDS);

                int schemesCount = studioService.listSchemes(null, raceTask.id(), true).size();
                if (cfmResp.statusCode() == 200) {
                    assertEquals(409, dscResp.statusCode(), dscResp.body());
                    assertEquals(1, schemesCount);
                } else {
                    assertEquals(409, cfmResp.statusCode(), cfmResp.body());
                    assertEquals(200, dscResp.statusCode(), dscResp.body());
                    assertEquals(0, schemesCount, "确认返回 409 时绝不允许正式方案落库或扣减库存");
                }
            } finally {
                httpPool.shutdownNow();
            }
        }

        // 3. HTTP 并发对抗 B：同一 draftId 携带两个不同 idempotencyKey 并发确认，有且仅有一方成功 200，另一方 409，方案总数恰好 1
        CuttingTask dupTask = inventory.saveTask(new CuttingTask(
                null, "异键并发确认对抗", "TC-CONC", null, 0,
                List.of(new CuttingTask.Line(1, "常规片", 500, 500, 6, true))
        ));
        var dupPlanRes = post("/api/v2/workbench/tasks/" + dupTask.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-dup-" + UUID.randomUUID());
        assertEquals(202, dupPlanRes.statusCode());
        String dupResultId = json.readTree(dupPlanRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(dupResultId).state());
        String dupDraftId = json.readValue(
                post("/api/v2/workbench/drafts", Map.of("resultId", dupResultId, "ttlSeconds", 1200), null).body(),
                WorkbenchSchemeDraft.class
        ).draftId();

        CountDownLatch dupGate = new CountDownLatch(1);
        ExecutorService dupPool = Executors.newFixedThreadPool(2);
        try {
            Future<HttpResponse<String>> f1 = dupPool.submit(() -> {
                dupGate.await(5, TimeUnit.SECONDS);
                return post("/api/v2/schemes/confirm",
                        buildSampleConfirmCmd("distinct-key-A-" + UUID.randomUUID(), dupTask, dupDraftId), null);
            });
            Future<HttpResponse<String>> f2 = dupPool.submit(() -> {
                dupGate.await(5, TimeUnit.SECONDS);
                return post("/api/v2/schemes/confirm",
                        buildSampleConfirmCmd("distinct-key-B-" + UUID.randomUUID(), dupTask, dupDraftId), null);
            });
            dupGate.countDown();
            HttpResponse<String> r1 = f1.get(10, TimeUnit.SECONDS);
            HttpResponse<String> r2 = f2.get(10, TimeUnit.SECONDS);
            List<Integer> codes = List.of(r1.statusCode(), r2.statusCode());
            assertTrue(codes.contains(200) && codes.contains(409), "异键并发确认应恰有 1 个 200 与 1 个 409: " + codes);
            assertEquals(1, studioService.listSchemes(null, dupTask.id(), true).size(), "同一草案至多成功确认一次");
        } finally {
            dupPool.shutdownNow();
        }
    }

    @Test
    void multiMaterialDraftsIdempotencyKeyReplayAndConflictWork() throws Exception {
        String model = "MMB-IDEM-" + UUID.randomUUID().toString().substring(0, 6);
        MotherRollInfo roll = new MotherRollInfo("ROLL-IDEM-" + UUID.randomUUID().toString().substring(0, 6), model, 1200, 3000, 0, 0);
        roll.setInspectionStatus("PASSED");
        inventory.saveOrUpdateMotherRoll(roll);

        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "多料幂等重放验证任务", model, null, 0,
                List.of(new CuttingTask.Line(1, "方块", 400, 400, 4, true))
        ));

        String idemKey = "retry-mmb-" + UUID.randomUUID();
        Map<String, Object> body = Map.of(
                "taskId", task.id(),
                "materialModel", model,
                "preferRemnants", true,
                "continueAcrossRolls", true,
                "note", "弱网重试幂等测试",
                "ttlSeconds", 1800
        );

        var firstRes = post("/api/v2/workbench/multi-material-drafts", body, idemKey);
        assertEquals(201, firstRes.statusCode(), firstRes.body());
        JsonNode firstJson = json.readTree(firstRes.body());
        String firstGroupId = firstJson.get("batchGroupId").asString();
        List<String> firstDraftIds = new ArrayList<>();
        List<String> firstResultIds = new ArrayList<>();
        for (JsonNode d : firstJson.get("drafts")) {
            firstDraftIds.add(d.get("draftId").asString());
            firstResultIds.add(d.get("target").get("resultId").asString());
        }

        // 1. 携带相同 Idempotency-Key 与相同请求体连续重试，必须幂等返回原批次，零重复写入
        var secondRes = post("/api/v2/workbench/multi-material-drafts", body, idemKey);
        assertEquals(201, secondRes.statusCode(), secondRes.body());
        JsonNode secondJson = json.readTree(secondRes.body());
        assertEquals(firstGroupId, secondJson.get("batchGroupId").asString());
        assertEquals(firstDraftIds.size(), secondJson.get("draftCount").asInt());
        List<String> secondDraftIds = new ArrayList<>();
        List<String> secondResultIds = new ArrayList<>();
        for (JsonNode d : secondJson.get("drafts")) {
            secondDraftIds.add(d.get("draftId").asString());
            secondResultIds.add(d.get("target").get("resultId").asString());
        }
        assertEquals(firstDraftIds, secondDraftIds);
        assertEquals(firstResultIds, secondResultIds);

        var listRes = get("/api/v2/workbench/drafts?status=ALL&batchGroupId=" + firstGroupId);
        assertEquals(200, listRes.statusCode());
        assertEquals(firstDraftIds.size(), json.readTree(listRes.body()).get("total").asInt());

        // 2. 携带相同 Idempotency-Key 但更改请求参数，必须返回 409 IDEMPOTENCY_CONFLICT
        Map<String, Object> modifiedBody = Map.of(
                "taskId", task.id(),
                "materialModel", model,
                "preferRemnants", true,
                "continueAcrossRolls", true,
                "note", "被篡改的请求备注",
                "ttlSeconds", 1800
        );
        var conflictRes = post("/api/v2/workbench/multi-material-drafts", modifiedBody, idemKey);
        assertEquals(409, conflictRes.statusCode(), conflictRes.body());
        assertEquals("IDEMPOTENCY_CONFLICT", json.readTree(conflictRes.body()).get("code").asString());

        // 3. 模拟服务重启（全新实例无内存缓存）+ 后续任务需求已被其它方案全部消耗清零 + 禁止触发实时重算：依然由归档快照确定性重放
        var fulfillCmd = new SchedulingStudioService.ConfirmSchemeCommand(
                "consume-all-" + UUID.randomUUID(), "消耗任务需求", "RECT_2D", "SHORTEN_KIT", "TEST", "测试",
                task.id(), task.name(), null, "VIRTUAL_ROLL", null, null, model,
                1600.0, 1000.0, 0.0, 1000.0, 0.0, 0.0, 40.0, 0.64, true,
                List.of(new SchedulingStudioService.DemandLineInput(1, "方块", 400, 400, 4, true, null, null, null, null, null)),
                new com.example.cutdemotwo.business.model.SchedulingScheme.Layout2DPayload(
                        List.of(
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(1, 1, "方块", 0, 0, 400, 400, 0, false, null),
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(2, 1, "方块", 400, 0, 400, 400, 0, false, null),
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(3, 1, "方块", 800, 0, 400, 400, 0, false, null),
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(4, 1, "方块", 1200, 0, 400, 400, 0, false, null)
                        ),
                        List.of(),
                        List.of()
                ),
                null, null, null
        );
        studioService.confirmScheme(fulfillCmd);
        GlobalPlanningService forbidReplanService = new GlobalPlanningService(inventory, nestingSolver) {
            @Override
            public MultiMaterialPlanResult planMultiMaterial(MultiMaterialPlanRequest request) {
                throw new AssertionError("冷重启幂等重放绝不允许重新调用实时规划 planMultiMaterial");
            }
        };
        MultiMaterialDraftOrchestrationService coldInstance = new MultiMaterialDraftOrchestrationService(
                inventory, forbidReplanService, optimizationService, workbenchDraftService
        );
        var reqObj = new MultiMaterialDraftOrchestrationService.MultiMaterialDraftBatchRequest(
                task.id(), model, null, null, true, null, null, null, null, null, null, true, "弱网重试幂等测试", 1800L
        );
        var coldReplay = coldInstance.createMultiMaterialDrafts(reqObj, idemKey, "tester");
        assertEquals(firstGroupId, coldReplay.batchGroupId());
        assertEquals(firstDraftIds, coldReplay.drafts().stream().map(WorkbenchSchemeDraft::draftId).toList());
        assertNotNull(coldReplay.planResult(), "冷重启幂等重放必须返回非空 planResult");
        assertEquals(firstJson.get("planResult").get("placedByRoll").asInt(), coldReplay.planResult().placedByRoll());
        assertEquals(firstJson.get("planResult").get("totalRequestedPieces").asInt(),
                coldReplay.planResult().totalRequestedPieces());
        assertFalse(coldReplay.planResult().rollOptions().isEmpty(), "冷重启重建 rollOptions 不应受后续任务需求清零影响");

        var conflictReqObj = new MultiMaterialDraftOrchestrationService.MultiMaterialDraftBatchRequest(
                task.id(), model, null, null, true, null, null, null, null, null, null, true, "另一备注", 900L
        );
        OptimizationFailure coldConflict = assertThrows(OptimizationFailure.class,
                () -> coldInstance.createMultiMaterialDrafts(conflictReqObj, idemKey, "tester"));
        assertEquals(409, coldConflict.status);
        assertEquals("IDEMPOTENCY_CONFLICT", coldConflict.code);
    }

    @Test
    void expireAndPurgeBehavesEquivalentlyAcrossFileAndJdbcStores() throws Exception {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();

        MotherRollInfo roll = savePassedRoll("ROLL-PURGE-" + UUID.randomUUID().toString().substring(0, 6), 1600, 6000, List.of());
        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "双存储过期首轮清理一致性任务", "TC-PURGE", null, 0,
                List.of(new CuttingTask.Line(1, "门片", 500, 600, 2, true))
        ));
        var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                "materialType", "STOCK_ROLL",
                "materialId", roll.getRollId(),
                "windowStartMm", 0,
                "windowLengthMm", 2000,
                "timeLimitSeconds", 3
        ), "wb-purge-" + UUID.randomUUID());
        assertEquals(202, planRes.statusCode());
        String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
        assertEquals("SUCCEEDED", waitTerminal(resultId).state());

        Instant t0 = Instant.parse("2026-11-27T10:00:00Z");
        JdbcWorkbenchDraftStore jdbcStore = new JdbcWorkbenchDraftStore(ds);
        Path dir = temp.resolve("purge-eq-" + UUID.randomUUID());
        try (var fileStore = new FileWorkbenchDraftStore(dir)) {
            for (var store : List.of(jdbcStore, fileStore)) {
                MutableClock clock = new MutableClock(t0.minusSeconds(60));
                WorkbenchDraftService svc = new WorkbenchDraftService(inventory, optimizationService, store, clock);
                // 创建 expiresAt = T0 的 PENDING_CONFIRMATION 草案
                WorkbenchSchemeDraft draft = svc.createDraft(
                        new WorkbenchDraftService.CreateDraftRequest(resultId, task.id(), roll.getRollId(), "STOCK_ROLL", "首轮即删校验", 60L)
                );
                assertEquals(t0.toString(), draft.expiresAt());

                long nowMs = t0.plusSeconds(30 * 3600L).toEpochMilli();
                long purgeBeforeMs = t0.plusSeconds(6 * 3600L).toEpochMilli();
                int affected = store.expireAndPurge(nowMs, purgeBeforeMs);
                assertTrue(affected >= 2, "过期标态与当场物理删除应在首轮一次完成");
                assertTrue(store.find(draft.draftId()).isEmpty(), "PENDING_CONFIRMATION 过期超保留期应在首轮被物理删除: " + store.getClass().getSimpleName());
            }

            // 校验 listByTask 对不同小数秒精度 ISO 字符串排序一致性
            String olderId = "DFT-ISO-OLD-" + UUID.randomUUID().toString().substring(0, 6);
            String newerId = "DFT-ISO-NEW-" + UUID.randomUUID().toString().substring(0, 6);
            WorkbenchSchemeDraft older = new WorkbenchSchemeDraft(
                    olderId, olderId, WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION, "APR-1", "H1",
                    "2026-11-27T10:00:00.900Z", "2099-11-27T10:30:00Z", 1800L, true, false, false, List.of(),
                    new WorkbenchSchemeDraft.Target(resultId, task.id(), roll.getRollId(), "STOCK_ROLL"),
                    List.of(), "#/workbench", "next", null, 0L, 0L
            );
            WorkbenchSchemeDraft newer = new WorkbenchSchemeDraft(
                    newerId, newerId, WorkbenchSchemeDraft.STATUS_PENDING_CONFIRMATION, "APR-2", "H2",
                    "2026-11-27T10:00:01Z", "2099-11-27T10:30:00Z", 1800L, true, false, false, List.of(),
                    new WorkbenchSchemeDraft.Target(resultId, task.id(), roll.getRollId(), "STOCK_ROLL"),
                    List.of(), "#/workbench", "next", null, 0L, 0L
            );
            for (var store : List.of(jdbcStore, fileStore)) {
                store.saveAll(List.of(older, newer));
                List<String> ordered = store.listByTask(task.id()).stream().map(WorkbenchSchemeDraft::draftId).toList();
                assertTrue(ordered.indexOf(newerId) < ordered.indexOf(olderId),
                        "listByTask 应按 epoch 毫秒倒序排列（10:00:01Z 应排在 10:00:00.900Z 前）: " + store.getClass().getSimpleName());
            }
        }
    }

    @Test
    void multiMaterialDraftsPreserveRemnantDefectMarginInArchivedExclusions() throws Exception {
        String model = "REM-MARGIN-" + UUID.randomUUID().toString().substring(0, 6);
        Defect remnantDefect = new Defect(
                1, 200.0, 200.0, 40.0, 30.0, 20.0,
                "HOLE", "破洞", 3, 4, "MANUAL", "MUST_AVOID", "带 20mm 安全边距"
        );
        RemnantStock rem = new RemnantStock(
                "REM-MRG-" + UUID.randomUUID().toString().substring(0, 6),
                1200, 1000, "B-02", model, "AVAILABLE", null, true, "带 20mm 安全边距"
        );
        rem.setDefects(List.of(remnantDefect));
        inventory.registerRemnant(rem);

        CuttingTask task = inventory.saveTask(new CuttingTask(
                null, "料头避疵边距保留测试", model, null, 0,
                List.of(new CuttingTask.Line(1, "小片", 300, 300, 2, true))
        ));

        var batchRes = post("/api/v2/workbench/multi-material-drafts", Map.of(
                "taskId", task.id(),
                "materialModel", model,
                "preferRemnants", true,
                "maxRemnants", 2,
                "continueAcrossRolls", false,
                "ttlSeconds", 1800
        ), "mmb-rem-margin-" + UUID.randomUUID());
        assertEquals(201, batchRes.statusCode(), batchRes.body());

        JsonNode batchJson = json.readTree(batchRes.body());
        String remResultId = null;
        for (JsonNode d : batchJson.get("drafts")) {
            if ("REMNANT".equals(d.get("target").get("materialType").asString())) {
                remResultId = d.get("target").get("resultId").asString();
                break;
            }
        }
        assertNotNull(remResultId, "应生成料头段草案: " + batchRes.body());

        var ctxRes = get("/api/v2/workbench/results/" + remResultId + "/context");
        assertEquals(200, ctxRes.statusCode(), ctxRes.body());
        JsonNode exclusions = json.readTree(ctxRes.body()).get("input").get("problem").get("material").get("exclusions");
        assertEquals(1, exclusions.size(), ctxRes.body());
        JsonNode ex0 = exclusions.get(0);
        // 原始 [200, 200, 40x30] + margin 20 -> [180, 180, 80x70]
        assertEquals(180.0, ex0.get("x").asDouble(), 0.2);
        assertEquals(180.0, ex0.get("y").asDouble(), 0.2);
        assertEquals(80.0, ex0.get("shape").get("width").asDouble(), 0.2);
        assertEquals(70.0, ex0.get("shape").get("height").asDouble(), 0.2);
        assertEquals(3, ex0.get("severity").asInt());
        assertEquals("MUST_AVOID", ex0.get("avoidancePolicy").asString());
    }

    @Test
    void confirmSchemeWithDraftBoundaryExpiryConcurrentCleanupDoesNotSplitState() throws Exception {
        DataSource ds = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(ds).load().migrate();
        JdbcWorkbenchDraftStore jdbcStore = new JdbcWorkbenchDraftStore(ds);
        Path dir = temp.resolve("boundary-expiry-" + UUID.randomUUID());

        try (var fileStore = new FileWorkbenchDraftStore(dir)) {
            int storeIdx = 0;
            for (var store : List.of(jdbcStore, fileStore)) {
                storeIdx++;
                MotherRollInfo roll = savePassedRoll("ROLL-BEXP-" + storeIdx + "-" + UUID.randomUUID().toString().substring(0, 6),
                        1600, 6000, List.of());
                CuttingTask task = inventory.saveTask(new CuttingTask(
                        null, "临界过期并发清理对抗-" + storeIdx, "TC-BEXP", null, 0,
                        List.of(new CuttingTask.Line(1, "常规片", 500, 500, 6, true))
                ));
                var planRes = post("/api/v2/workbench/tasks/" + task.id() + "/plan-jobs", Map.of(
                        "materialType", "STOCK_ROLL",
                        "materialId", roll.getRollId(),
                        "windowStartMm", 0,
                        "windowLengthMm", 2000,
                        "timeLimitSeconds", 3
                ), "wb-bexp-" + storeIdx + "-" + UUID.randomUUID());
                assertEquals(202, planRes.statusCode(), planRes.body());
                String resultId = json.readTree(planRes.body()).get("job").get("id").asString();
                assertEquals("SUCCEEDED", waitTerminal(resultId).state());

                // 使用可控时钟构造距 expiresAt 仅剩极短余量的待确认草案，并确保在 confirmScheme 落库期间时钟跨过 expiresAt
                MutableClock clock = new MutableClock(Instant.parse("2026-11-27T11:00:00Z"));
                WorkbenchDraftService isolatedDraftSvc = new WorkbenchDraftService(
                        inventory, optimizationService, store, clock
                );
                WorkbenchSchemeDraft shortLived = isolatedDraftSvc.createDraft(
                        new WorkbenchDraftService.CreateDraftRequest(resultId, task.id(), roll.getRollId(), "STOCK_ROLL", "临界过期测试", 60L)
                );
                clock.advanceSeconds(59);

                CountDownLatch committed = new CountDownLatch(1);
                CountDownLatch cleanupCompleted = new CountDownLatch(1);
                SchedulingStudioService delayedStudio = new SchedulingStudioService(inventory, nestingSolver) {
                    @Override
                    public Map<String, Object> confirmScheme(ConfirmSchemeCommand cmd) {
                        Map<String, Object> res = super.confirmScheme(cmd);
                        try {
                            // 模拟确认落库耗时跨越 expiresAt（从 +59s 推进至 +65s）
                            clock.advanceSeconds(6);
                            committed.countDown();
                            cleanupCompleted.await(2, TimeUnit.SECONDS);
                            // 同步重入触发清理，验证同线程与跨线程均不篡改正在确认中的草案
                            isolatedDraftSvc.cleanupExpiredDrafts(0L);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                        }
                        return res;
                    }
                };

                ExecutorService pool = Executors.newSingleThreadExecutor();
                try {
                    Future<Integer> cleanupFuture = pool.submit(() -> {
                        assertTrue(committed.await(5, TimeUnit.SECONDS));
                        int affected = isolatedDraftSvc.cleanupExpiredDrafts(0L);
                        cleanupCompleted.countDown();
                        return affected;
                    });

                    Map<String, Object> out = isolatedDraftSvc.confirmSchemeWithDraft(
                            buildSampleConfirmCmd("bexp-" + storeIdx + "-" + UUID.randomUUID(), task, shortLived.draftId()),
                            delayedStudio,
                            "planner-boundary"
                    );
                    assertEquals(0, cleanupFuture.get(5, TimeUnit.SECONDS), "正在持锁确认中的草案不得被清理线程标为 EXPIRED 或删除");
                    WorkbenchSchemeDraft confirmed = (WorkbenchSchemeDraft) out.get("draft");
                    assertNotNull(confirmed);
                    assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED, confirmed.status());
                    assertEquals(WorkbenchSchemeDraft.STATUS_CONFIRMED,
                            store.find(shortLived.draftId()).orElseThrow().status());
                    assertEquals(1, studioService.listSchemes(null, task.id(), true).size(),
                            "草案确认与正式方案落库必须保持严格一致");
                } finally {
                    pool.shutdownNow();
                }
            }
        }
    }

    private static SchedulingStudioService.ConfirmSchemeCommand buildSampleConfirmCmd(
            String idempotencyKey,
            CuttingTask task,
            String draftId
    ) {
        return new SchedulingStudioService.ConfirmSchemeCommand(
                idempotencyKey,
                "联动草案方案",
                "RECT_2D",
                "SHORTEN_KIT",
                "TEST_STRAT",
                "测试策略",
                task.id(),
                task.name(),
                null,
                "VIRTUAL_ROLL",
                null,
                null,
                task.materialModel(),
                1500.0,
                1000.0,
                0.0,
                1000.0,
                0.0,
                0.0,
                33.33,
                0.5,
                true,
                List.of(new SchedulingStudioService.DemandLineInput(
                        1, "常规片", 500, 500, 2, true, null, null, null, null, null)),
                new com.example.cutdemotwo.business.model.SchedulingScheme.Layout2DPayload(
                        List.of(
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(1, 1, "常规片", 0, 0, 500, 500, 0, false, null),
                                new com.example.cutdemotwo.business.model.SchedulingScheme.PlacementItem(2, 1, "常规片", 500, 0, 500, 500, 0, false, null)
                        ),
                        List.of(),
                        List.of()
                ),
                null,
                null,
                draftId
        );
    }
}
