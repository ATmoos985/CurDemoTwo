package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.SchedulingStudioService;
import com.example.cutdemotwo.business.model.DemandTemplate;
import com.example.cutdemotwo.business.model.SchedulingScheme;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
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

    private <T> T post(String path, Object body, Class<T> responseType) throws Exception {
        String payload = body == null ? "{}" : json.writeValueAsString(body);
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(payload))
                        .build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertEquals(200, res.statusCode(), () -> "POST " + path + " failed: " + res.body());
        return json.readValue(res.body(), responseType);
    }

    private <T> T get(String path, Class<T> responseType) throws Exception {
        HttpResponse<String> res = http.send(
                HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString()
        );
        assertEquals(200, res.statusCode(), () -> "GET " + path + " failed: " + res.body());
        return json.readValue(res.body(), responseType);
    }

    @Test
    @SuppressWarnings("unchecked")
    void demandTemplatePersistsAndExpandsIntoDemandPool() throws Exception {
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

        // Create a Demand Family and merge additional lines into it
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
    }

    @Test
    @SuppressWarnings("unchecked")
    void virtualMotherRollSchemeDeductsOpenDemandBindsRealRollCompletesAndUpdatesSpatialMap() throws Exception {
        // 1. Create a Contour 2D Demand Family with 4 pieces
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

        // 2. Confirm a 2-piece scheme on default VIRTUAL_ROLL (preserving exact coordinates + 180° half-turn!)
        SchedulingScheme.Layout2DPayload layout = new SchedulingScheme.Layout2DPayload(
                List.of(
                        new SchedulingScheme.PlacementItem(1, 1, "120码·前片", 12.5, 10.0, 600, 800, 0, false, poly),
                        new SchedulingScheme.PlacementItem(2, 1, "120码·前片", 640.0, 10.0, 600, 800, 180, false, rotated180)
                ),
                List.of(),
                List.of()
        );
        Map<String, Object> confirmed = post("/api/v2/schemes/confirm", new SchedulingStudioService.ConfirmSchemeCommand(
                "IDEM-VIRTUAL-01", "Deepnest NFP+GA 选定方案", "CONTOUR_2D", "SHORTEN", "DEEPNEST_NFP_GA", "Deepnest NFP+GA",
                taskId, null, null, "VIRTUAL_ROLL", null, null, "DXF-1226-面布",
                1650, 1200, null, 810, 0, 0, 56.12, 0.92, false, null, layout, null
        ), Map.class);

        Map<String, Object> schemeMap = (Map<String, Object>) confirmed.get("scheme");
        String schemeId = (String) schemeMap.get("id");
        assertEquals("AWAITING_ROLL", schemeMap.get("state"));

        // Verify openQty immediately dropped from 4 to 2 (plannedQty = 2)!
        Map<String, Object> poolAfterConfirm = (Map<String, Object>) confirmed.get("demandFamily");
        assertEquals(2, ((Number) poolAfterConfirm.get("plannedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterConfirm.get("openTotal")).intValue());

        // 3. Auto-create & bind a real mother roll in Results Management
        String newRollId = "ROLL-1226-" + UUID.randomUUID().toString().substring(0, 4).toUpperCase();
        Map<String, Object> bound = post("/api/v2/schemes/" + schemeId + "/bind-roll",
                new SchedulingStudioService.BindRollCommand(newRollId, true, 15000.0, "1号裁床线边库", null),
                Map.class);
        Map<String, Object> boundScheme = (Map<String, Object>) bound.get("scheme");
        assertEquals("READY_TO_CUT", boundScheme.get("state"));
        assertEquals(newRollId, boundScheme.get("rollId"));

        // Verify spatial map before cutting shows PLANNED_ZONE at [0, 810]
        Map<String, Object> spatialBefore = get("/api/rolls/" + newRollId + "/spatial-map", Map.class);
        assertEquals(1, ((List<?>) spatialBefore.get("plannedZones")).size());
        assertEquals(0, ((List<?>) spatialBefore.get("cutZones")).size());

        // Verify exact coordinates were preserved (NOT overwritten by re-solving!)
        List<?> plannedPieces = (List<?>) ((Map<?, ?>) ((List<?>) spatialBefore.get("plannedZones")).get(0)).get("pieces");
        assertEquals(2, plannedPieces.size());
        assertEquals(12.5, ((Number) ((Map<?, ?>) plannedPieces.get(0)).get("x")).doubleValue(), 0.01);
        assertEquals(640.0, ((Number) ((Map<?, ?>) plannedPieces.get(1)).get("x")).doubleValue(), 0.01);

        // 4. One-click completion accounting
        Map<String, Object> completed = post("/api/v2/schemes/" + schemeId + "/complete",
                new SchedulingStudioService.CompleteSchemeCommand(null, List.of(), true, "余料架A", "张工"),
                Map.class);
        assertEquals("COMPLETED", ((Map<?, ?>) completed.get("scheme")).get("state"));
        Map<String, Object> poolAfterComplete = (Map<String, Object>) completed.get("demandFamily");
        assertEquals(0, ((Number) poolAfterComplete.get("plannedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterComplete.get("completedTotal")).intValue());
        assertEquals(2, ((Number) poolAfterComplete.get("openTotal")).intValue());

        // 5. Verify Mother Roll Spatial Map now shows CUT_ZONE and clean remaining span, and ledger is BALANCED!
        Map<String, Object> spatialAfter = get("/api/rolls/" + newRollId + "/spatial-map", Map.class);
        assertEquals(0, ((List<?>) spatialAfter.get("plannedZones")).size());
        assertEquals(1, ((List<?>) spatialAfter.get("cutZones")).size());
        assertFalse(((List<?>) spatialAfter.get("cleanSpans")).isEmpty());
        assertEquals("BALANCED", inventory.reconcileInventory().get("status"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void cancelSchemeRestoresOpenDemandAndMesLoopHandlesSlittingAndScrap() throws Exception {
        // 1. Push 1D slitting work order from MES
        Map<String, Object> mesFam = post("/api/v2/mes/orders", new SchedulingStudioService.MesOrderSyncCommand(
                "MES-WO-20261118-01", "光学膜分条工单", "光学膜-4600", "SLITTING_1D", 4600.0,
                List.of(
                        new SchedulingStudioService.DemandLineInput(1, "客户A·1100mm", 1100, 2000, 4, false, null, null, null, "默认", null),
                        new SchedulingStudioService.DemandLineInput(2, "客户B·1050mm", 1050, 2000, 4, false, null, null, null, "默认", null)
                )
        ), Map.class);
        String taskId = (String) mesFam.get("id");
        assertEquals("SLITTING_1D", mesFam.get("dimension"));

        // 2. Confirm a 1D scheme on virtual roll, then cancel it -> openTotal returns to 8
        SchedulingScheme.Slitting1DPayload slitPayload = new SchedulingScheme.Slitting1DPayload(
                100, 100, 4000, 4400, 10, 10, 2000, 2, 0, 0,
                List.of(new SchedulingScheme.SlittingPatternItem(
                        "PAT-1", 2000, 2, 4300, 100,
                        List.of(
                                new SchedulingScheme.StationItem(1100, 2),
                                new SchedulingScheme.StationItem(1050, 2)
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

        // 3. Re-confirm, dispatch to MES, register scanned roll, and send MES execution feedback with 1 rejected strip!
        String slitRollId = "ROLL-FILM-4600";
        post("/api/rolls", new com.example.cutdemotwo.business.model.MotherRollInfo(
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

        Map<String, Object> feedback = post("/api/v2/mes/execution-feedback",
                new SchedulingStudioService.MesFeedbackCommand(mesSchemeId, "MES-REP-01", slitRollId, null, List.of(1), true, "分切余料区"),
                Map.class);
        assertEquals("COMPLETED", ((Map<?, ?>) feedback.get("scheme")).get("state"));
        // 2 cars × 4 strips = 8 strips; strip #1 rejected in each car (2 cars) -> 6 qualified, 2 open for replenishment!
        Map<String, Object> famAfterMes = (Map<String, Object>) feedback.get("demandFamily");
        assertEquals(6, ((Number) famAfterMes.get("completedTotal")).intValue());
        assertEquals(2, ((Number) famAfterMes.get("openTotal")).intValue());
        assertEquals("BALANCED", inventory.reconcileInventory().get("status"));
    }

    @Test
    void jdbcFlywayV9PersistsTemplatesAndSchemesCleanly() {
        JdbcDataSource h2 = new JdbcDataSource();
        h2.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        Flyway.configure().dataSource(h2).load().migrate();
        var store = new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2);
        var remSvc = new com.example.cutdemotwo.business.cutting.RemnantService(store, true);
        var studio = new SchedulingStudioService(remSvc, new com.example.cutdemotwo.algorithm.nesting.SolverFactory(
                List.of(new com.example.cutdemotwo.algorithm.nesting.JavaGuillotineSolverEngine())
        ));
        studio.saveTemplate(new DemandTemplate(
                "TPL-JDBC-1", "JDBC1", "JDBC测试模板", "BOARD_2D", "RECT_2D", "desc",
                1220, 2440, "定制板材-1220", List.of("标准"), Map.of("标准", 1), true,
                List.of(new DemandTemplate.PieceSpec("侧板", null, 2, false, "FREE_90", Map.of("标准", new DemandTemplate.SizeGeometry(600, 500, null)))),
                null
        ));
        var reopened = new SchedulingStudioService(
                new com.example.cutdemotwo.business.cutting.RemnantService(new com.example.cutdemotwo.persistence.JdbcInventoryStore(h2), false),
                new com.example.cutdemotwo.algorithm.nesting.SolverFactory(List.of())
        );
        assertEquals(1, reopened.listTemplates().size());
        assertEquals("TPL-JDBC-1", reopened.listTemplates().get(0).id());
    }
}
