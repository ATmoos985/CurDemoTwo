package com.example.cutdemotwo;

import com.example.cutdemotwo.business.cutting.RemnantService;
import com.example.cutdemotwo.business.model.MotherRollInfo;
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

import static org.junit.jupiter.api.Assertions.*;

/**
 * 第三波 4 个冻结 REST 契约端到端 HTTP 集成测试：
 * 验证所有规划与分析接口 JSON 契约、非法输入 400 拦截、单价保存兼容以及全只读零库存写入不变量。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class GlobalPlanningApiTests {

    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("cutdemo.state.path", () -> temp.resolve("api-inventory.json").toString());
        registry.add("cutdemo.seed-demo-data", () -> true);
    }

    @Value("${local.server.port}")
    int port;

    @Autowired
    RemnantService inventory;

    private final JsonMapper json = JsonMapper.builder().build();
    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> get(String path) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET().build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> post(String path, String body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void allFourPlanningAndAnalyticsEndpointsRespectFrozenContractAndStayReadOnly() throws Exception {
        // 先验证给已有演示母卷更新单价字段成功且对账平衡（深拷贝副本提交，避免原地修改库存活对象）
        MotherRollInfo liveRoll = inventory.getMotherRoll("ROLL-2026-0920");
        assertNotNull(liveRoll);
        MotherRollInfo rollCopy = json.readValue(json.writeValueAsString(liveRoll), MotherRollInfo.class);
        rollCopy.setUnitPricePerSqm(32.5);
        rollCopy.setUnitPricePerMeter(65.0);
        var saveRollResp = post("/api/v2/rolls", json.writeValueAsString(rollCopy));
        assertEquals(200, saveRollResp.statusCode(), saveRollResp.body());
        JsonNode savedRollJson = json.readTree(saveRollResp.body());
        assertEquals(32.5, savedRollJson.get("unitPricePerSqm").asDouble(), 0.001);
        assertEquals(65.0, savedRollJson.get("unitPricePerMeter").asDouble(), 0.001);

        Path stateFile = temp.resolve("api-inventory.json");
        byte[] beforeAllReads = Files.readAllBytes(stateFile);

        // 1. POST /api/v2/planning/multi-material
        String multiReq = """
                {
                  "materialModel": "TC涤棉-B2026",
                  "preferRemnants": true,
                  "maxRemnants": 4,
                  "timeBudgetMs": 4000,
                  "pieceGapMm": 0,
                  "trimStartMm": 0,
                  "demands": [
                    { "id": 1, "name": "侧片", "width": 600, "length": 800, "quantity": 6, "allowRotation": true }
                  ]
                }
                """;
        var multiResp = post("/api/v2/planning/multi-material", multiReq);
        assertEquals(200, multiResp.statusCode(), multiResp.body());
        JsonNode multi = json.readTree(multiResp.body());
        assertEquals("TC涤棉-B2026", multi.get("materialModel").asString());
        assertEquals(6, multi.get("totalRequestedPieces").asInt());
        assertEquals(6, multi.get("placedByRemnants").asInt() + multi.get("placedByRoll").asInt() + multi.get("unplacedPieces").asInt());
        assertTrue(multi.get("remnantAllocations").isArray());
        assertTrue(multi.get("rollOptions").isArray());
        assertTrue(multi.has("totalSavedAreaM2"));
        assertTrue(multi.has("elapsedMs"));
        assertTrue(multi.get("warnings").isArray());
        for (JsonNode remAlloc : multi.get("remnantAllocations")) {
            assertTrue(remAlloc.get("placements").isArray(), "料头分配必须返回 placements 数组");
            assertEquals(remAlloc.get("placedCount").asInt(), remAlloc.get("placements").size(), "料头 placements 件数必须与 placedCount 严格一致");
            assertTrue(remAlloc.get("defects").isArray(), "料头分配必须返回 defects 数组");
            for (JsonNode p : remAlloc.get("placements")) {
                assertTrue(p.get("x").asDouble() >= 0.0 && p.get("y").asDouble() >= 0.0);
                assertTrue(p.get("w").asDouble() > 0.0 && p.get("l").asDouble() > 0.0);
                assertTrue(p.has("rotationDegrees") && p.has("rotated"));
            }
        }
        for (JsonNode rollOpt : multi.get("rollOptions")) {
            assertTrue(rollOpt.has("windowStartY") && rollOpt.get("windowStartY").asDouble() >= 0.0);
            assertTrue(rollOpt.has("totalLengthMm") && rollOpt.get("totalLengthMm").asDouble() > 0.0);
            assertTrue(rollOpt.get("placements").isArray(), "母卷方案必须返回 placements 数组");
            assertEquals(rollOpt.get("placedCount").asInt(), rollOpt.get("placements").size(), "母卷 placements 件数必须与 placedCount 严格一致");
            assertTrue(rollOpt.get("defects").isArray(), "母卷方案必须返回 defects 数组");
            for (JsonNode p : rollOpt.get("placements")) {
                assertTrue(p.get("x").asDouble() >= 0.0 && p.get("y").asDouble() >= 0.0);
                assertTrue(p.get("w").asDouble() > 0.0 && p.get("l").asDouble() > 0.0);
                assertTrue(p.get("x").asDouble() + p.get("w").asDouble() <= rollOpt.get("widthMm").asDouble() + 0.11);
                assertTrue(p.get("y").asDouble() + p.get("l").asDouble() <= rollOpt.get("estimatedCutLengthMm").asDouble() + 0.11);
            }
        }

        // 2. POST /api/v2/planning/cut-plan
        String cutPlanReq = """
                {
                  "styleName": "经典夹克-J01",
                  "colorName": "藏青",
                  "fabricWidthMm": 1500,
                  "maxPliesPerLay": 60,
                  "maxGarmentsPerMarker": 6,
                  "maxLayLengthMm": 9000,
                  "endAllowanceMm": 40,
                  "grammageGsm": 240,
                  "sizeQuantities": { "S": 40, "M": 100, "L": 100, "XL": 60 },
                  "defaultUnitAreaM2": 1.45,
                  "targetUtilizationPct": 83.0,
                  "allowOvercutPct": 0.0
                }
                """;
        var cutPlanResp = post("/api/v2/planning/cut-plan", cutPlanReq);
        assertEquals(200, cutPlanResp.statusCode(), cutPlanResp.body());
        JsonNode cutPlan = json.readTree(cutPlanResp.body());
        assertEquals("经典夹克-J01", cutPlan.get("styleName").asString());
        assertEquals("藏青", cutPlan.get("colorName").asString());
        assertEquals(300, cutPlan.get("totalOrderedGarments").asInt());
        assertEquals(300, cutPlan.get("totalPlannedGarments").asInt());
        assertEquals(0, cutPlan.get("overcutGarments").asInt());
        assertTrue(cutPlan.get("layCount").asInt() >= 1);
        assertTrue(cutPlan.get("totalFabricLengthM").asDouble() > 0);
        assertTrue(cutPlan.get("totalFabricAreaM2").asDouble() > 0);
        assertTrue(cutPlan.get("estimatedWeightKg").asDouble() > 0);
        assertTrue(cutPlan.get("averageEfficiencyPct").asDouble() > 70.0);
        assertEquals(4, cutPlan.get("sizeAudit").size());
        for (JsonNode item : cutPlan.get("sizeAudit")) {
            assertEquals(item.get("ordered").asInt(), item.get("planned").asInt());
            assertEquals(0, item.get("delta").asInt());
        }

        // 3. GET /api/v2/analytics/cost-summary
        var costResp = get("/api/v2/analytics/cost-summary?defaultUnitPricePerSqm=28.5&remnantResidualFactor=0.65");
        assertEquals(200, costResp.statusCode(), costResp.body());
        JsonNode cost = json.readTree(costResp.body());
        assertEquals("CNY", cost.get("currency").asString());
        assertEquals(28.5, cost.get("defaultUnitPricePerSqm").asDouble(), 0.001);
        assertEquals(0.65, cost.get("remnantResidualFactor").asDouble(), 0.001);
        assertTrue(cost.get("summary").has("totalReports"));
        assertTrue(cost.get("summary").has("netEffectiveCost"));
        assertTrue(cost.get("summary").has("avgCostPerGoodSqm"));
        assertTrue(cost.get("byTask").isArray());
        assertTrue(cost.get("byMaterialModel").isArray());

        // 4. GET /api/v2/analytics/procurement-suggestions
        var procResp = get("/api/v2/analytics/procurement-suggestions?safetyBufferPct=20&defaultRollLengthM=60");
        assertEquals(200, procResp.statusCode(), procResp.body());
        JsonNode proc = json.readTree(procResp.body());
        assertEquals(20.0, proc.get("safetyBufferPct").asDouble(), 0.001);
        assertEquals(60.0, proc.get("defaultRollLengthM").asDouble(), 0.001);
        assertTrue(proc.get("totalModels").asInt() >= 1);
        assertTrue(proc.get("items").isArray());
        JsonNode firstItem = proc.get("items").get(0);
        assertTrue(firstItem.has("materialModel"));
        assertTrue(firstItem.has("netAvailableAreaM2"));
        assertTrue(firstItem.has("alertLevel"));
        assertTrue(firstItem.has("activeBatches"));

        // 非法参数 400 校验
        assertEquals(400, post("/api/v2/planning/multi-material", "{}").statusCode());
        assertEquals(400, post("/api/v2/planning/cut-plan", "{\"fabricWidthMm\":-100,\"maxPliesPerLay\":10,\"maxGarmentsPerMarker\":4,\"sizeQuantities\":{\"M\":10}}").statusCode());
        assertEquals(400, get("/api/v2/analytics/cost-summary?remnantResidualFactor=1.5").statusCode());
        assertEquals(400, get("/api/v2/analytics/procurement-suggestions?safetyBufferPct=-5").statusCode());

        // 核心不变量：4 个规划/分析接口和异常测试全程绝对零写库
        assertArrayEquals(beforeAllReads, Files.readAllBytes(stateFile));
    }
}
