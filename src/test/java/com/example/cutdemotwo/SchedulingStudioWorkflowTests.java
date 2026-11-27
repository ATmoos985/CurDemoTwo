package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.persistence.OptimizationTestDatabase;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

@Tag("mysql-integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SchedulingStudioWorkflowTests {
    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path", () -> temp.resolve("studio-workflow.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> true);
    }

    @org.springframework.beans.factory.annotation.Value("${local.server.port}")
    int port;

    @Autowired
    private com.example.cutdemotwo.business.cutting.RemnantService inventory;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private HttpResponse<String> send(String method, String path, Object body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
        if ("POST".equals(method)) {
            String payload = body == null ? "{}" : json.writeValueAsString(body);
            builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(payload));
        } else if ("DELETE".equals(method)) {
            builder.DELETE();
        } else {
            builder.GET();
        }
        return http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private <T> T post(String path, Object body, Class<T> responseType) throws Exception {
        HttpResponse<String> res = send("POST", path, body);
        assertEquals(200, res.statusCode(), () -> "POST " + path + " failed: " + res.body());
        return json.readValue(res.body(), responseType);
    }

    private <T> T get(String path, Class<T> responseType) throws Exception {
        HttpResponse<String> res = send("GET", path, null);
        assertEquals(200, res.statusCode(), () -> "GET " + path + " failed: " + res.body());
        return json.readValue(res.body(), responseType);
    }

    @Test
    @SuppressWarnings("unchecked")
    void demandTemplatePersistsDeletesAndExpandsIntoDemandPool() throws Exception {
        DemandTemplate tpl = new DemandTemplate(
                "TPL-CURTAIN-01",
                "CURT-01",
                "标准遮光帘模板",
                "CURTAIN_2D",
                "RECT_2D",
                "主帘+绑带",
                2000,
                3000,
                "TC涤棉-B2026",
                List.of("2.6m高", "3.2m高"),
                Map.of("2.6m高", 2, "3.2m高", 0),
                true,
                List.of(new DemandTemplate.PieceSpec(
                        "客厅主帘", "面布", 2, false, "STRICT_0",
                        Map.of("2.6m高", new DemandTemplate.SizeGeometry(900, 1500, null))
                )),
                null
        );
        DemandTemplate saved = post("/api/v2/demand-templates", tpl, DemandTemplate.class);
        assertEquals("TPL-CURTAIN-01", saved.id());

        List<?> all = get("/api/v2/demand-templates", List.class);
        assertTrue(all.stream().anyMatch(x -> "TPL-CURTAIN-01".equals(((Map<?, ?>) x).get("id"))));

        // 验证 DELETE /api/v2/demand-templates/{id}
        HttpResponse<String> delRes = send("DELETE", "/api/v2/demand-templates/TPL-CURTAIN-01", null);
        assertEquals(200, delRes.statusCode(), delRes.body());
        Map<String, Object> delMap = json.readValue(delRes.body(), Map.class);
        assertEquals(Boolean.TRUE, delMap.get("deleted"));

        // 创建需求族并合并加单，同时验证 GET /api/v2/demand-pool 与 GET /api/v2/demand-pool/{id}
        var fam = post("/api/v2/demand-pool", new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "遮光帘排程需求族", "TC涤棉-B2026", "ORD-2026-001", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(
                        1, "客厅主帘", 900, 1500, 4, false, null, "2.6m高", "TPL-CURTAIN-01", null, null
                ))
        ), Map.class);
        String familyId = (String) fam.get("id");
        assertEquals(4, ((Number) fam.get("openTotal")).intValue());

        var merged = post("/api/v2/demand-pool", new SchedulingStudioService.SaveDemandFamilyCommand(
                null, familyId, null, "TC涤棉-B2026", null, "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(
                        null, "客厅主帘", 900, 1500, 2, false, null, "2.6m高", "TPL-CURTAIN-01", null, null
                ))
        ), Map.class);
        assertEquals(6, ((Number) merged.get("orderedTotal")).intValue());
        assertEquals(6, ((Number) merged.get("openTotal")).intValue());

        List<?> poolList = get("/api/v2/demand-pool", List.class);
        assertTrue(poolList.stream().anyMatch(x -> familyId.equals(((Map<?, ?>) x).get("id"))));
        Map<String, Object> detail = get("/api/v2/demand-pool/" + familyId, Map.class);
        assertEquals(6, ((Number) detail.get("orderedTotal")).intValue());
    }

    @Test
    @SuppressWarnings("unchecked")
    void demandTemplatePreservesAndValidatesHolesRoundTripWithLegacyCompatibility() throws Exception {
        // 1. 含合法 CCW 外环 + CW 内孔的模板通过 HTTP API 持久化与查询往返保留 holes
        List<List<Double>> outer = List.of(
                List.of(0.0, 0.0), List.of(400.0, 0.0), List.of(400.0, 300.0), List.of(0.0, 300.0)
        );
        List<List<List<Double>>> holes = List.of(List.of(
                List.of(60.0, 60.0), List.of(60.0, 140.0), List.of(140.0, 140.0), List.of(140.0, 60.0)
        ));
        DemandTemplate withHole = new DemandTemplate(
                "TPL-HOLE-01",
                "HOLE-01",
                "带内孔纸样模板",
                "DXF_GARMENT",
                "CONTOUR_2D",
                "含 1 个内孔",
                1650,
                2000,
                "DXF-HOLE",
                List.of("M"),
                Map.of("M", 1),
                true,
                List.of(new DemandTemplate.PieceSpec(
                        "带孔前片", "面布", 2, true, "STRICT_0",
                        Map.of("M", new DemandTemplate.SizeGeometry(400.0, 300.0, outer, holes))
                )),
                null
        );
        DemandTemplate saved = post("/api/v2/demand-templates", withHole, DemandTemplate.class);
        assertEquals("TPL-HOLE-01", saved.id());
        DemandTemplate.SizeGeometry savedGeom = saved.pieces().get(0).sizes().get("M");
        assertNotNull(savedGeom.holes());
        assertEquals(1, savedGeom.holes().size());
        assertEquals(4, savedGeom.holes().get(0).size());

        List<Map<String, Object>> listed = get("/api/v2/demand-templates", List.class);
        Map<String, Object> fetched = listed.stream()
                .map(x -> (Map<String, Object>) x)
                .filter(x -> "TPL-HOLE-01".equals(x.get("id")))
                .findFirst()
                .orElseThrow();
        List<Map<String, Object>> fetchedPieces = (List<Map<String, Object>>) fetched.get("pieces");
        Map<String, Object> fetchedSizes = (Map<String, Object>) fetchedPieces.get(0).get("sizes");
        Map<String, Object> fetchedM = (Map<String, Object>) fetchedSizes.get("M");
        assertEquals(1, ((List<?>) fetchedM.get("holes")).size());

        // 2. 穿刺外轮廓的非法 holes 在保存模板阶段被明确拒绝 (400)
        DemandTemplate piercingHole = new DemandTemplate(
                "TPL-HOLE-BAD",
                "HOLE-BAD",
                "穿刺非法模板",
                "DXF_GARMENT",
                "CONTOUR_2D",
                "非法穿刺孔",
                1650,
                2000,
                "DXF-HOLE",
                List.of("M"),
                Map.of("M", 1),
                true,
                List.of(new DemandTemplate.PieceSpec(
                        "穿刺前片", "面布", 1, false, "STRICT_0",
                        Map.of("M", new DemandTemplate.SizeGeometry(
                                400.0, 300.0, outer,
                                List.of(List.of(
                                        List.of(350.0, 60.0), List.of(350.0, 140.0),
                                        List.of(450.0, 140.0), List.of(450.0, 60.0)
                                ))
                        ))
                )),
                null
        );
        HttpResponse<String> badRes = send("POST", "/api/v2/demand-templates", piercingHole);
        assertEquals(400, badRes.statusCode(), badRes.body());

        // 3. JDBC Flyway V9 持久化往返保留 holes + 老无孔模板 JSON 反序列化兼容
        var h2 = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(h2).load().migrate();
        var store = new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2);
        var svc = new SchedulingStudioService(new com.example.cutdemotwo.business.cutting.RemnantService(store, true), null);
        svc.saveTemplate(withHole);
        var reopenedSvc = new SchedulingStudioService(
                new com.example.cutdemotwo.business.cutting.RemnantService(new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2), false),
                null
        );
        DemandTemplate jdbcRestored = reopenedSvc.listTemplates().stream()
                .filter(t -> "TPL-HOLE-01".equals(t.id()))
                .findFirst()
                .orElseThrow();
        assertEquals(1, jdbcRestored.pieces().get(0).sizes().get("M").holes().size());

        String legacyJson = "{\"w\":500.0,\"h\":400.0,\"v\":[[0.0,0.0],[500.0,0.0],[500.0,400.0],[0.0,400.0]]}";
        DemandTemplate.SizeGeometry legacy = json.readValue(legacyJson, DemandTemplate.SizeGeometry.class);
        assertNull(legacy.holes());
        assertFalse(json.writeValueAsString(legacy).contains("\"holes\""));

        send("DELETE", "/api/v2/demand-templates/TPL-HOLE-01", null);
    }

    @Test
    @SuppressWarnings("unchecked")
    void virtualMotherRollSchemeAutoCreatesPendingRollRequiresInspectionThenBindsCompletesAndReverses() throws Exception {
        // 1. 创建异形 2D 需求族（4 件，显式允许 180° 掉头）
        NestingProblem.Shape poly = new NestingProblem.Shape("POLYGON", 600, 800, List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(600, 0),
                new NestingProblem.Point(560, 800),
                new NestingProblem.Point(40, 800)
        ));
        NestingProblem.Shape rotated180 = com.example.cutdemotwo.algorithm.geometry.PolygonGeometry.rotate(poly, 180);

        Map<String, Object> fam = post("/api/v2/demand-pool", new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "1226卫衣异形需求族", "DXF-1226-面布", "SO-1226", "CONTOUR_2D",
                2000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(
                        1, "120码·前片", 600, 800, 4, false, true, "120", "DXF_1226", null, poly
                ))
        ), Map.class);
        String taskId = (String) fam.get("id");

        // 2. 在虚拟母卷上确认 2 件方案，并验证同幂等键重放返回原方案
        SchedulingScheme.Layout2DPayload layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "120码·前片", 12.5, 10.0, 600, 800, 0, false, poly),
                        new SchedulingScheme.PlacementItem(2, 1, "120码·前片", 640.0, 10.0, 600, 800, 180, false, rotated180)
                ),
                List.of(),
                List.of()
        );
        var confirmCmd = new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-VIRTUAL-01", "Deepnest NFP+GA 选定方案", "CONTOUR_2D", "SHORTEN", "DEEPNEST_NFP_GA", "Deepnest NFP+GA",
                taskId, null, null, "VIRTUAL_ROLL", null, null, "DXF-1226-面布",
                1650, 1200, null, 810, 0, 0, 56.12, 0.92, false, null, layout, null
        );
        Map<String, Object> confirmed = post("/api/v2/schemes/confirm", confirmCmd, Map.class);
        Map<String, Object> schemeMap = (Map<String, Object>) confirmed.get("scheme");
        String schemeId = (String) schemeMap.get("id");
        assertEquals("AWAITING_ROLL", schemeMap.get("state"));

        // 幂等重放：返回同一 schemeId
        Map<String, Object> replayed = post("/api/v2/schemes/confirm", confirmCmd, Map.class);
        assertEquals(schemeId, ((Map<?, ?>) replayed.get("scheme")).get("id"));

        // 验证 GET /api/v2/schemes 与 GET /api/v2/schemes/{id}
        List<?> filteredSchemes = get("/api/v2/schemes?state=AWAITING_ROLL&taskId=" + taskId, List.class);
        assertEquals(1, filteredSchemes.size());
        Map<String, Object> schemeDetail = get("/api/v2/schemes/" + schemeId, Map.class);
        assertEquals(schemeId, ((Map<?, ?>) schemeDetail.get("scheme")).get("id"));

        // openQty 由 4 扣减为 2（plannedQty = 2）
        Map<String, Object> poolAfterConfirm = (Map<String, Object>) confirmed.get("demandFamily");
        assertEquals(2, ((Number) poolAfterConfirm.get("plannedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterConfirm.get("openTotal")).intValue());

        // 3a. P0-8 新语义：自动建卷默认 inspectionStatus="PENDING"、inspector=""，不得硬编码直通 PASSED
        String newRollId = "ROLL-1226-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
        Map<String, Object> autoCreatedRes = post("/api/v2/schemes/" + schemeId + "/bind-roll",
                new SchedulingStudioService.BindRollCommand(newRollId, true, 15000.0, "1号裁床线边库", null),
                Map.class);
        assertEquals(Boolean.TRUE, autoCreatedRes.get("awaitingInspection"));
        assertEquals("AWAITING_ROLL", ((Map<?, ?>) autoCreatedRes.get("scheme")).get("state"));
        MotherRollInfo createdRoll = inventory.getMotherRoll(newRollId);
        assertNotNull(createdRoll);
        assertEquals("PENDING", createdRoll.getInspectionStatus());
        assertEquals("", createdRoll.getInspector());

        // 未质检放行前直接绑该卷应拒绝（400）
        HttpResponse<String> rejectUninspected = send("POST", "/api/v2/schemes/" + schemeId + "/bind-roll",
                new SchedulingStudioService.BindRollCommand(newRollId, false, null, null, null));
        assertEquals(400, rejectUninspected.statusCode(), rejectUninspected.body());

        // 3b. 通过正常质检流程放行母卷后再绑卷 -> 进入 READY_TO_CUT
        createdRoll.setInspectionStatus("PASSED");
        createdRoll.setInspector("验布员-李四");
        post("/api/v2/rolls", createdRoll, Object.class);

        Map<String, Object> bound = post("/api/v2/schemes/" + schemeId + "/bind-roll",
                new SchedulingStudioService.BindRollCommand(newRollId, false, null, null, null),
                Map.class);
        Map<String, Object> boundScheme = (Map<String, Object>) bound.get("scheme");
        assertEquals("READY_TO_CUT", boundScheme.get("state"));
        assertEquals(newRollId, boundScheme.get("rollId"));

        // 校验空间图显示 PLANNED_ZONE 且精确坐标保留
        Map<String, Object> spatialBefore = get("/api/v2/rolls/" + newRollId + "/spatial-map", Map.class);
        assertEquals(1, ((List<?>) spatialBefore.get("plannedZones")).size());
        assertEquals(0, ((List<?>) spatialBefore.get("cutZones")).size());
        List<?> plannedPieces = (List<?>) ((Map<?, ?>) ((List<?>) spatialBefore.get("plannedZones")).get(0)).get("pieces");
        assertEquals(2, plannedPieces.size());
        assertEquals(12.5, ((Number) ((Map<?, ?>) plannedPieces.get(0)).get("x")).doubleValue(), 0.01);
        assertEquals(640.0, ((Number) ((Map<?, ?>) plannedPieces.get(1)).get("x")).doubleValue(), 0.01);

        // 4. 一键完工过账，并验证 P0-5 操作人真实透传至审计流水（DECLARED:张工）
        Map<String, Object> completed = post("/api/v2/schemes/" + schemeId + "/complete",
                new SchedulingStudioService.CompleteSchemeCommand(null, List.of(), true, "余料架A", "张工"),
                Map.class);
        assertEquals("COMPLETED", ((Map<?, ?>) completed.get("scheme")).get("state"));
        Map<String, Object> poolAfterComplete = (Map<String, Object>) completed.get("demandFamily");
        assertEquals(0, ((Number) poolAfterComplete.get("plannedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterComplete.get("completedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterComplete.get("openTotal")).intValue());

        // 已完工方案不能直接作废 -> 409 Conflict
        HttpResponse<String> cancelCompleted = send("POST", "/api/v2/schemes/" + schemeId + "/cancel", Map.of("reason", "测试拦截"));
        assertEquals(409, cancelCompleted.statusCode(), cancelCompleted.body());

        // 校验审计流水中真实记录了操作人 DECLARED:张工
        Map<String, Object> ledgerPage = inventory.inventoryLedger(null, null, 0, 500);
        List<?> ledgerItems = (List<?>) ledgerPage.get("items");
        assertTrue(ledgerItems.stream().anyMatch(e -> "DECLARED:张工".equals(((com.example.cutdemotwo.business.model.InventoryLedgerEntry) e).actor())));

        // 校验母卷空间图与账本对账 BALANCED
        Map<String, Object> spatialAfter = get("/api/v2/rolls/" + newRollId + "/spatial-map", Map.class);
        assertEquals(0, ((List<?>) spatialAfter.get("plannedZones")).size());
        assertEquals(1, ((List<?>) spatialAfter.get("cutZones")).size());
        assertFalse(((List<?>) spatialAfter.get("cleanSpans")).isEmpty());
        assertEquals("BALANCED", inventory.reconcileInventory().get("status"));

        // 5. P0-6 冲销报工联动：冲销后方案自动回滚为 REVERSED，需求完整释回 openTotal=4
        List<String> linkedPlanIds = (List<String>) ((Map<?, ?>) completed.get("scheme")).get("linkedPlanIds");
        assertEquals(1, linkedPlanIds.size());
        post("/api/v2/cutting/reports/" + linkedPlanIds.get(0) + "/reverse", Map.of("reason", "误报冲销验证"), Map.class);

        Map<String, Object> afterReverseScheme = get("/api/v2/schemes/" + schemeId, Map.class);
        assertEquals("REVERSED", ((Map<?, ?>) afterReverseScheme.get("scheme")).get("state"));
        Map<String, Object> afterReversePool = get("/api/v2/demand-pool/" + taskId, Map.class);
        assertEquals(0, ((Number) afterReversePool.get("completedTotal")).intValue());
        assertEquals(0, ((Number) afterReversePool.get("plannedTotal")).intValue());
        assertEquals(4, ((Number) afterReversePool.get("openTotal")).intValue());
        assertEquals("BALANCED", inventory.reconcileInventory().get("status"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void cancelSchemeRestoresOpenDemandAndMesLoopHandlesSlittingGlobalPieceSeqAndIdempotency() throws Exception {
        // 1. MES 下推 1D 分切工单（并验证原子查重幂等重放）
        var mesOrderCmd = new SchedulingStudioService.MesOrderSyncCommand(
                "MES-WO-20261118-01", "光学膜分条工单", "光学膜-4600", "SLITTING_1D", 4600.0,
                List.of(
                        new SchedulingStudioService.DemandLineInput(1, "客户A·1100mm", 1100, 2000, 4, false, null, null, null, "默认", null),
                        new SchedulingStudioService.DemandLineInput(2, "客户B·1050mm", 1050, 2000, 4, false, null, null, null, "默认", null)
                )
        );
        Map<String, Object> mesFam = post("/api/v2/mes/orders", mesOrderCmd, Map.class);
        String taskId = (String) mesFam.get("id");
        assertEquals("SLITTING_1D", mesFam.get("dimension"));
        Map<String, Object> mesFamReplay = post("/api/v2/mes/orders", mesOrderCmd, Map.class);
        assertEquals(taskId, mesFamReplay.get("id"));

        // 2. 确认 1D 虚拟卷方案后作废 -> openTotal 恢复为 8，已作废方案禁止完工（409）
        SchedulingScheme.Slitting1DPayload slitPayload = new SchedulingScheme.Slitting1DPayload(
                100, 100, 4000, 4400, 10, 10, 2000, 2, 0, 0,
                List.of(new SchedulingScheme.SlittingPatternItem(
                        "PAT-1", 2000, 2, 4300, 100,
                        List.of(
                                new SchedulingScheme.StationItem(1100, 2),
                                new SchedulingScheme.StationItem(1050, 2)
                        ),
                        "默认",
                        List.of(
                                new SchedulingScheme.SlittingAllocationItem("1", 4),
                                new SchedulingScheme.SlittingAllocationItem("2", 4)
                        )
                )),
                List.of(
                        new SchedulingScheme.SlittingFulfillmentItem("1", "客户A·1100mm", 1100, 4, 4, 0, 0),
                        new SchedulingScheme.SlittingFulfillmentItem("2", "客户B·1050mm", 1050, 4, 4, 0, 0)
                )
        );
        Map<String, Object> firstRes = post("/api/v2/schemes/confirm", new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-SLIT-CANCEL", "分切初版方案", "SLITTING_1D", "MIN_CARS", "QUALITY", "OR-Tools QUALITY",
                taskId, null, "MES-WO-20261118-01", "VIRTUAL_ROLL", null, null, "光学膜-4600",
                4600, 4000, null, 4000, 0, 0, 93.48, 34.4, false, null, null, slitPayload
        ), Map.class);
        String cancelId = (String) ((Map<?, ?>) firstRes.get("scheme")).get("id");
        assertEquals(0, ((Number) ((Map<?, ?>) firstRes.get("demandFamily")).get("openTotal")).intValue());

        Map<String, Object> cancelled = post("/api/v2/schemes/" + cancelId + "/cancel", Map.of("reason", "重选更优刀组"), Map.class);
        assertEquals(8, ((Number) ((Map<?, ?>) cancelled.get("demandFamily")).get("openTotal")).intValue());
        HttpResponse<String> completeCancelled = send("POST", "/api/v2/schemes/" + cancelId + "/complete", Map.of());
        assertEquals(409, completeCancelled.statusCode(), completeCancelled.body());

        // 3. 重新确认、下发 MES、查询 GET /api/v2/mes/dispatch-packages/{id}、MES 单事务绑卷+完工回传
        String slitRollId = "ROLL-FILM-4600";
        post("/api/v2/rolls", new MotherRollInfo(
                slitRollId, "光学膜-4600", "BAT-FILM", "光学膜厂", "PET光学膜", "透明", 120, "PET", 4600, 20000, "分切库位 S-01"
        ), Object.class);

        Map<String, Object> secondRes = post("/api/v2/schemes/confirm", new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-SLIT-MES", "分切正式方案", "SLITTING_1D", "MIN_CARS", "QUALITY", "OR-Tools QUALITY",
                taskId, null, "MES-WO-20261118-01", "VIRTUAL_ROLL", null, null, "光学膜-4600",
                4600, 4000, null, 4000, 0, 0, 93.48, 34.4, false, null, null, slitPayload
        ), Map.class);
        String mesSchemeId = (String) ((Map<?, ?>) secondRes.get("scheme")).get("id");

        Map<String, Object> pkg = post("/api/v2/mes/schemes/" + mesSchemeId + "/dispatch",
                Map.of("mesWorkOrderNo", "MES-WO-20261118-01"), Map.class);
        assertEquals("DISPATCHED_MES", pkg.get("state"));

        // 验证 GET /api/v2/mes/dispatch-packages/{id}
        Map<String, Object> fetchedPkg = get("/api/v2/mes/dispatch-packages/" + mesSchemeId, Map.class);
        assertEquals(mesSchemeId, fetchedPkg.get("schemeId"));
        assertEquals("MES-WO-20261118-01", fetchedPkg.get("mesWorkOrderNo"));

        // P0-8 新语义：2 车 × 4 条 = 8 条，pieceSeq 全局递增 1..4 与 5..8；判废 [1] 仅废第 1 车 1 号条，绝不误伤第 2 车！
        var fbCmd = new SchedulingStudioService.MesFeedbackCommand(mesSchemeId, "MES-REP-01", slitRollId, null, List.of(1), true, "分切余料区");
        Map<String, Object> feedback = post("/api/v2/mes/execution-feedback", fbCmd, Map.class);
        assertEquals("COMPLETED", ((Map<?, ?>) feedback.get("scheme")).get("state"));
        assertEquals("MES-REP-01", ((Map<?, ?>) feedback.get("scheme")).get("mesReceiptNo"));
        Map<String, Object> famAfterMes = (Map<String, Object>) feedback.get("demandFamily");
        assertEquals(7, ((Number) famAfterMes.get("completedTotal")).intValue());
        assertEquals(1, ((Number) famAfterMes.get("openTotal")).intValue());
        assertEquals("BALANCED", inventory.reconcileInventory().get("status"));

        // 同 mesReceiptNo 幂等重放成功且不重复扣库
        Map<String, Object> feedbackReplay = post("/api/v2/mes/execution-feedback", fbCmd, Map.class);
        assertEquals("COMPLETED", ((Map<?, ?>) feedbackReplay.get("scheme")).get("state"));
        // 不同 mesReceiptNo 提交至已完工方案 -> 409 Conflict
        HttpResponse<String> conflictReceipt = send("POST", "/api/v2/mes/execution-feedback",
                new SchedulingStudioService.MesFeedbackCommand(mesSchemeId, "MES-REP-DIFFERENT", slitRollId, null, List.of(), true, "分切余料区"));
        assertEquals(409, conflictReceipt.statusCode(), conflictReceipt.body());
    }

    @Test
    @SuppressWarnings("unchecked")
    void validateLayoutEndpointChecksGeometryWithoutSideEffects() throws Exception {
        long revBefore = ((Number) inventory.healthStatus().get("revision")).longValue();

        // 1. 合法矩形直刀手调：重建 cuts 与 leftovers
        var validReq = new SchedulingStudioService.ValidateLayoutRequest(
                2000, 2000, 50, 10, true, null, null, 0.0, List.of(),
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "左片", 0, 50, 900, 1000, 0, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "右片", 920, 50, 900, 1000, 0, false, null)
                ),
                List.of(new SchedulingStudioService.DemandLineInput(1, "窗帘主片", 900, 1000, 2, false, null, null, null, null, null))
        );
        Map<String, Object> validRes = post("/api/v2/schemes/validate-layout", validReq, Map.class);
        assertEquals(Boolean.TRUE, validRes.get("feasible"), () -> "预期合法: " + validRes);
        assertTrue(((List<?>) validRes.get("errors")).isEmpty());
        assertFalse(((List<?>) validRes.get("cuts")).isEmpty());

        // 2. 非法手调：越权 90° 旋转 + 重叠 + 侵入 trimStartMm -> feasible=false + 错误清单
        var invalidReq = new SchedulingStudioService.ValidateLayoutRequest(
                2000, 2000, 50, 10, true, null, null, 0.0, List.of(),
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "越权片", 0, 20, 1000, 900, 90, false, null),
                        new SchedulingScheme.PlacementItem(2, 1, "重叠片", 100, 60, 900, 1000, 0, false, null)
                ),
                List.of(new SchedulingStudioService.DemandLineInput(1, "窗帘主片", 900, 1000, 2, false, null, null, null, null, null))
        );
        Map<String, Object> invalidRes = post("/api/v2/schemes/validate-layout", invalidReq, Map.class);
        assertEquals(Boolean.FALSE, invalidRes.get("feasible"));
        List<String> errs = (List<String>) invalidRes.get("errors");
        assertTrue(errs.size() >= 2, () -> "应同时报告修边侵入、重叠或越权旋转: " + errs);

        // 确认纯只读校验绝不递增库存 revision
        long revAfter = ((Number) inventory.healthStatus().get("revision")).longValue();
        assertEquals(revBefore, revAfter, "手调校验接口绝不能产生库存写入副作用");
    }

    @Test
    @SuppressWarnings("unchecked")
    void jdbcFlywayV9PersistsTemplatesAndSchemesIncludingMultiTaskAllocationsCleanly() {
        var h2 = OptimizationTestDatabase.create();
        Flyway.configure().dataSource(h2).load().migrate();
        var store = new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2);
        var remSvc = new com.example.cutdemotwo.business.cutting.RemnantService(store, true);
        var solver = new com.example.cutdemotwo.algorithm.nesting.SolverFactory(
                List.of(new com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine())
        );
        var studio = new SchedulingStudioService(remSvc, solver);

        // 1. 持久化 demand_template
        studio.saveTemplate(new DemandTemplate(
                "TPL-JDBC-1", "JDBC1", "JDBC测试模板", "BOARD_2D", "RECT_2D", "desc",
                1220, 2440, "定制板材-1220", List.of("标准"), Map.of("标准", 1), true,
                List.of(new DemandTemplate.PieceSpec("侧板", null, 2, false, "FREE_90", Map.of("标准", new DemandTemplate.SizeGeometry(600, 500, null)))),
                null
        ));

        // 2. 持久化 scheduling_scheme（含跨任务 sourceAllocations 与绑定在库母卷）
        Map<String, Object> famA = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "JDBC需求族A", "TC涤棉-B2026", "EXT-A", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "A件", 800, 900, 2, false, null, null, null, null, null))
        ));
        Map<String, Object> famB = studio.saveOrMergeDemandFamily(new SchedulingStudioService.SaveDemandFamilyCommand(
                null, null, "JDBC需求族B", "TC涤棉-B2026", "EXT-B", "RECT_2D",
                3000.0, 0.0, 0.0, null, null, null, null, null, null,
                List.of(new SchedulingStudioService.DemandLineInput(1, "B件", 900, 900, 1, false, null, null, null, null, null))
        ));
        String taskA = (String) famA.get("id");
        String taskB = (String) famB.get("id");

        SchedulingScheme.Layout2DPayload layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "A件", 0, 0, 800, 900, 0, false, null, taskA, 1),
                        new SchedulingScheme.PlacementItem(2, 2, "B件", 800, 0, 900, 900, 0, false, null, taskB, 1)
                ),
                List.of(),
                List.of()
        );
        Map<String, Object> confirmed = studio.confirmScheme(new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-JDBC-SCHEME-1", "JDBC合排方案", "RECT_2D", "DEFAULT", "JAVA_FAST", "Java 直刀",
                null, null, null, "STOCK_ROLL", "ROLL-2026-0920", null, "TC涤棉-B2026",
                2000, 1000, 5000.0, 900, 0, 0, 85.0, 1.53, true, null, layout, null,
                List.of(
                        new SchedulingScheme.TaskDemandAllocation(taskA, 1, 1),
                        new SchedulingScheme.TaskDemandAllocation(taskB, 1, 1)
                )
        ));
        String schemeId = ((SchedulingScheme) confirmed.get("scheme")).id();
        long revAfterConfirm = store.currentRevision();
        assertTrue(revAfterConfirm > 0);

        // 3. 重新实例化新 JdbcInventoryStore + RemnantService 验证 Flyway V9 完整还原模板与方案
        var reopenedStore = new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2);
        assertEquals(revAfterConfirm, reopenedStore.currentRevision());
        assertNull(reopenedStore.healthCheckError());
        var reopened = new SchedulingStudioService(
                new com.example.cutdemotwo.business.cutting.RemnantService(reopenedStore, false),
                solver
        );
        assertEquals(1, reopened.listTemplates().size());
        assertEquals("TPL-JDBC-1", reopened.listTemplates().get(0).id());

        SchedulingScheme restoredScheme = (SchedulingScheme) reopened.getSchemeDetail(schemeId).get("scheme");
        assertEquals("READY_TO_CUT", restoredScheme.state());
        assertEquals("ROLL-2026-0920", restoredScheme.rollId());
        assertEquals(2, restoredScheme.sourceAllocations().size());
        assertEquals(1, reopened.listSchemes(null, taskB).size());
        assertEquals(1, ((Number) reopened.getDemandFamily(taskA).get("plannedTotal")).intValue());
        assertEquals(1, ((Number) reopened.getDemandFamily(taskB).get("plannedTotal")).intValue());
    }
}
