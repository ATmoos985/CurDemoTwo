package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.geometry.Defect;
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
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 工作台编排试排、同口径双方案对比、结果上下文与持久化待确认草案全链路测试：
 * 覆盖 2D 矩形（含直刀外扩与避疵）/ 2D 异形带孔 / 1D 分切、422 状态与无待排拦截、
 * 同口径比较与不可比原因、草案 SHA-256 持久化/TTL 过期/库存与任务版本漂移探测，以及 File + JDBC H2 双存储兼容性。
 */
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
    void fileAndJdbcH2StoresPersistDraftsAndBackwardCompatibleOptimizationJobs() throws Exception {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl("jdbc:h2:mem:wb_orch_" + UUID.randomUUID().toString().replace("-", "") + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        cfg.setUsername("sa");
        cfg.setPassword("");

        try (HikariDataSource ds = new HikariDataSource(cfg)) {
            Flyway.configure().dataSource(ds).load().migrate();

            // 1. 验证 JDBC H2 + File 双草案存储读写一致
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

            // 2. 验证 StoredOptimizationJob 带 workbenchSource 与历史 4 字段 JSON 双向兼容（File + JDBC H2）
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
    }
}
