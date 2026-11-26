package com.example.cutdemotwo;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
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
import java.nio.file.Path;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 工厂生产闭环 HTTP REST 契约全覆盖集成测试：
 * 验证 8 组冻结路由（隔离料头放行、复检撤销、采购入库、领退料、母卷报废、同缸补片、可选分页与 summary 瘦身、聚合报工分页消 N+1）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class FactoryDocumentApiTests {
    @TempDir
    static Path temp;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry properties) {
        properties.add("cutdemo.state.path", () -> temp.resolve("stock.json").toString());
        properties.add("cutdemo.jobs.path", () -> temp.resolve("jobs").toString());
        properties.add("cutdemo.seed-demo-data", () -> true);
        properties.add("cutdemo.integration.enabled", () -> false);
    }

    @Value("${local.server.port}")
    int port;

    final JsonMapper json = JsonMapper.builder().build();
    final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    HttpResponse<String> get(String path) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10)).GET().build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    HttpResponse<String> post(String path, String body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return http.send(req, HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void fullFactoryDocumentAndReconciliationRestContractsWorkEndToEnd() throws Exception {
        // 1. 采购批量入库（2 卷：1 卷 PENDING，1 卷 PASSED 带检验员）
        String receiptReq = """
                {
                  "idempotencyKey": "HTTP-RCV-001",
                  "supplierName": "东方印染厂",
                  "deliveryNoteNo": "DN-API-889",
                  "operator": "仓库员林涛",
                  "remarks": "API批量入库验收",
                  "rolls": [
                    {
                      "id": "ROLL-API-001",
                      "materialModel": "API高密斜纹",
                      "materialType": "全棉斜纹",
                      "color": "深海蓝",
                      "batchNo": "DYE-2026-A8",
                      "widthMm": 2000,
                      "totalLengthMm": 30000,
                      "grammage": 250,
                      "shrinkageRate": 1.8,
                      "storageLocation": "原料区 R-A1",
                      "inspectionStatus": "PASSED",
                      "inspector": "质检员刘梅"
                    },
                    {
                      "id": "ROLL-API-002",
                      "materialModel": "API高密斜纹",
                      "materialType": "全棉斜纹",
                      "color": "深海蓝",
                      "batchNo": "DYE-2026-A8",
                      "widthMm": 2000,
                      "totalLengthMm": 25000,
                      "grammage": 250,
                      "shrinkageRate": 1.8,
                      "storageLocation": "原料区 R-A2"
                    }
                  ]
                }
                """;
        var rcvResp = post("/api/v2/inventory-receipts", receiptReq);
        assertEquals(200, rcvResp.statusCode(), rcvResp.body());
        JsonNode rcvJson = json.readTree(rcvResp.body());
        assertEquals(2, rcvJson.path("createdRolls").size());
        assertTrue(rcvJson.path("revision").asLong() > 0);
        assertEquals("PASSED", rcvJson.path("createdRolls").get(0).path("inspectionStatus").asString());
        assertEquals("PENDING", rcvJson.path("createdRolls").get(1).path("inspectionStatus").asString());

        // 幂等重放 + 分页查询入库单
        var rcvReplay = post("/api/v2/inventory-receipts", receiptReq);
        assertEquals(200, rcvReplay.statusCode());
        assertEquals(rcvJson.path("document").path("id").asString(), json.readTree(rcvReplay.body()).path("document").path("id").asString());
        var rcvList = get("/api/v2/inventory-receipts?limit=1&offset=0");
        assertEquals(200, rcvList.statusCode());
        assertEquals(1, json.readTree(rcvList.body()).size());

        // 2. 车间领料 ISSUE & 退料 RETURN
        String issueReq = """
                {
                  "idempotencyKey": "HTTP-ISS-001",
                  "direction": "ISSUE",
                  "rollId": "ROLL-API-001",
                  "machineId": "CUT-M03",
                  "shiftTeam": "白班一队",
                  "operator": "领料员周明",
                  "reason": "三号自动裁床上机"
                }
                """;
        var issResp = post("/api/v2/material-issues", issueReq);
        assertEquals(200, issResp.statusCode(), issResp.body());
        JsonNode issJson = json.readTree(issResp.body());
        assertEquals("CUT-M03", issJson.path("roll").path("issuedMachineId").asString());
        assertEquals("车间:CUT-M03", issJson.path("roll").path("storageLocation").asString());

        String retReq = """
                {
                  "idempotencyKey": "HTTP-RET-001",
                  "direction": "RETURN",
                  "rollId": "ROLL-API-001",
                  "operator": "领料员周明",
                  "targetLocation": "原料区 R-A1",
                  "reason": "换单退回原料库"
                }
                """;
        var retResp = post("/api/v2/material-issues", retReq);
        assertEquals(200, retResp.statusCode(), retResp.body());
        assertEquals("原料区 R-A1", json.readTree(retResp.body()).path("roll").path("storageLocation").asString());
        assertEquals(2, json.readTree(get("/api/v2/material-issues").body()).size());
        assertEquals(1, json.readTree(get("/api/v2/material-issues?limit=1&offset=1").body()).size());

        // 3. 新建需求族（带交期/优先级/同缸强约束）-> 确认方案 -> 完工（判废1件）
        String demandReq = """
                {
                  "name": "API同缸测试单",
                  "materialModel": "API高密斜纹",
                  "dimension": "RECT_2D",
                  "dueDate": "2026-12-10",
                  "priority": "HIGH",
                  "customerName": "华庭布艺",
                  "kittingGroup": "KIT-99",
                  "requiredBatchNo": "DYE-2026-A8",
                  "requiredColor": "深海蓝",
                  "strictBatchMatch": true,
                  "machineId": "CUT-M03",
                  "shiftTeam": "白班一队",
                  "demands": [
                    { "id": 1, "name": "主片A", "width": 800, "length": 1000, "quantity": 2, "allowRotation": false }
                  ]
                }
                """;
        var famResp = post("/api/v2/demand-pool", demandReq);
        assertEquals(200, famResp.statusCode(), famResp.body());
        JsonNode famJson = json.readTree(famResp.body());
        String taskId = famJson.path("id").asString();
        assertEquals("HIGH", famJson.path("priority").asString());
        assertTrue(famJson.path("strictBatchMatch").asBoolean());

        String confirmReq = """
                {
                  "idempotencyKey": "HTTP-SCH-001",
                  "title": "API同缸方案",
                  "dimension": "RECT_2D",
                  "scenarioId": "DEFAULT",
                  "strategyId": "JAVA_FAST",
                  "strategyName": "直刀",
                  "taskId": "%s",
                  "materialMode": "STOCK_ROLL",
                  "rollId": "ROLL-API-001",
                  "materialModel": "API高密斜纹",
                  "widthMm": 2000,
                  "canvasLengthMm": 1000,
                  "windowStartY": 0,
                  "occupiedLengthMm": 1000,
                  "trimStartMm": 0,
                  "pieceGapMm": 0,
                  "utilizationPct": 80.0,
                  "pieceAreaM2": 1.6,
                  "avoidDefects": false,
                  "layout2D": {
                    "placements": [
                      { "id": 1, "demandId": 1, "name": "主片A", "x": 0, "y": 0, "w": 800, "l": 1000, "rotationDegrees": 0, "gapFill": false },
                      { "id": 2, "demandId": 1, "name": "主片A", "x": 800, "y": 0, "w": 800, "l": 1000, "rotationDegrees": 0, "gapFill": false }
                    ],
                    "leftovers": [],
                    "cuts": []
                  }
                }
                """.formatted(taskId);
        var schResp = post("/api/v2/schemes/confirm", confirmReq);
        assertEquals(200, schResp.statusCode(), schResp.body());
        String schemeId = json.readTree(schResp.body()).path("scheme").path("id").asString();
        String planId = json.readTree(schResp.body()).path("scheme").path("linkedPlanIds").get(0).asString();

        // 验证 /api/v2/schemes?summary=true 与 /api/cutting/tasks/{id}/plans?summary=true 省略大体积坐标数组
        var schFull = json.readTree(get("/api/v2/schemes?taskId=" + taskId).body());
        assertEquals(2, schFull.get(0).path("scheme").path("layout2D").path("placements").size());
        var schSlim = json.readTree(get("/api/v2/schemes?taskId=" + taskId + "&summary=true&limit=1&offset=0").body());
        assertEquals(1, schSlim.size());
        assertTrue(schSlim.get(0).path("scheme").path("layout2D").isMissingNode() || schSlim.get(0).path("scheme").path("layout2D").isNull());

        var plansSlim = json.readTree(get("/api/cutting/tasks/" + taskId + "/plans?summary=true").body());
        assertEquals(1, plansSlim.size());
        assertEquals(0, plansSlim.get(0).path("result").path("cuts").size());
        assertEquals(0, plansSlim.get(0).path("result").path("pieces").size());

        // 完工方案（2 片均合格）
        var compResp = post("/api/v2/schemes/" + schemeId + "/complete", "{\"actualCutLenMm\":1000,\"rejectedPieceIds\":[],\"recoverRemnants\":false,\"operator\":\"操作员甲\"}");
        assertEquals(200, compResp.statusCode(), compResp.body());

        // 4. 对裁片 #1 发起复检转隔离料头 -> 查聚合报工分页端点 -> 放行隔离料头 -> 查历史放行单
        String dispReq = """
                {
                  "operationId": "api-quality-disp-0001",
                  "expectedRevision": 0,
                  "pieceId": 1,
                  "disposition": "REMNANT",
                  "reason": "边角脏污转隔离料头",
                  "inspector": "质检员王芳",
                  "recovery": { "x": 0, "y": 0, "width": 400, "length": 400, "location": "隔离架 Q-01", "quality": "QUARANTINED" }
                }
                """;
        var dispResp = post("/api/cutting/reports/" + planId + "/quality-dispositions", dispReq);
        assertEquals(200, dispResp.statusCode(), dispResp.body());
        JsonNode dispJson = json.readTree(dispResp.body());
        String dispositionId1 = dispJson.path("id").asString();
        String quarantinedRemId = dispJson.path("remnantId").asString();

        // 对裁片 #2 发起复检报废（用于随后测试撤销）
        String dispReq2 = """
                {
                  "operationId": "api-quality-disp-0002",
                  "expectedRevision": 1,
                  "pieceId": 2,
                  "disposition": "SCRAP",
                  "reason": "误判破损待撤销",
                  "inspector": "质检员王芳",
                  "recovery": null
                }
                """;
        var dispResp2 = post("/api/cutting/reports/" + planId + "/quality-dispositions", dispReq2);
        assertEquals(200, dispResp2.statusCode(), dispResp2.body());
        String dispositionId2 = json.readTree(dispResp2.body()).path("id").asString();

        // 验证聚合报工分页端点（消 N+1）：含 taskName / materialModel / batchNo / dispositions / reinspectionRemainingCount
        var reconResp = get("/api/v2/reconciliation/reports?limit=50&offset=0");
        assertEquals(200, reconResp.statusCode(), reconResp.body());
        JsonNode reconJson = json.readTree(reconResp.body());
        assertEquals(1, reconJson.path("total").asInt());
        assertFalse(reconJson.path("hasMore").asBoolean());
        JsonNode firstReport = reconJson.path("items").get(0);
        assertEquals(planId, firstReport.path("planId").asString());
        assertEquals("API同缸测试单", firstReport.path("taskName").asString());
        assertEquals("API高密斜纹", firstReport.path("materialModel").asString());
        assertEquals("DYE-2026-A8", firstReport.path("batchNo").asString());
        assertEquals(2, firstReport.path("dispositions").size());
        assertEquals(0, firstReport.path("reinspectionRemainingCount").asInt());

        // 5. 撤销裁片 #2 的复检报废 -> 合格完成量从 0 恢复到 1，可复检余量变为 1
        String revokeReq = """
                { "idempotencyKey": "HTTP-REVOKE-002", "operator": "主管张强", "reason": "复核合格撤销误判" }
                """;
        var revokeResp = post("/api/cutting/reports/" + planId + "/dispositions/" + dispositionId2 + "/revoke", revokeReq);
        assertEquals(200, revokeResp.statusCode(), revokeResp.body());
        JsonNode revokeJson = json.readTree(revokeResp.body());
        assertEquals(1, revokeJson.path("report").path("netFinishedPieceCount").asInt());
        assertEquals(1, revokeJson.path("task").path("completedTotal").asInt());
        assertEquals(1, json.readTree(get("/api/v2/reconciliation/reports?limit=50&offset=0").body())
                .path("items").get(0).path("reinspectionRemainingCount").asInt());

        // 6. 隔离料头质量放行 -> 转 AVAILABLE，历史放行单可查；同时已放行的派生料头不再允许撤销原复检处置（409）
        String releaseReq = """
                { "idempotencyKey": "HTTP-QREL-001", "decision": "RELEASE_AVAILABLE", "inspector": "质检主管陈", "reason": "清洗烘干复检合格" }
                """;
        var relResp = post("/api/v2/quality/remnants/" + quarantinedRemId + "/release", releaseReq);
        assertEquals(200, relResp.statusCode(), relResp.body());
        assertEquals("AVAILABLE", json.readTree(relResp.body()).path("remnant").path("status").asString());
        assertEquals(1, json.readTree(get("/api/v2/quality/releases").body()).size());

        var blockedRevoke = post("/api/cutting/reports/" + planId + "/dispositions/" + dispositionId1 + "/revoke",
                "{\"idempotencyKey\":\"HTTP-REVOKE-BLOCKED\",\"operator\":\"主管\",\"reason\":\"尝试撤销已放行料头\"}");
        assertEquals(409, blockedRevoke.statusCode(), blockedRevoke.body());

        // 7. 一键创建同缸加急补片任务（源方案因裁片 #1 复检淘汰存在 1 件缺口）
        String replenishReq = """
                { "idempotencyKey": "HTTP-REPL-001", "operator": "排产员李", "reason": "复检转料头后缺1片补切" }
                """;
        var replResp = post("/api/v2/schemes/" + schemeId + "/replenish-task", replenishReq);
        assertEquals(200, replResp.statusCode(), replResp.body());
        JsonNode replJson = json.readTree(replResp.body());
        assertEquals(schemeId, replJson.path("sourceSchemeId").asString());
        assertEquals("URGENT", replJson.path("task").path("priority").asString());
        assertEquals("DYE-2026-A8", replJson.path("task").path("requiredBatchNo").asString());
        assertEquals("深海蓝", replJson.path("task").path("requiredColor").asString());
        assertTrue(replJson.path("task").path("strictBatchMatch").asBoolean());

        // 8. 母卷级报废单（对 ROLL-API-002 报废）+ 分页查询 rolls/remnants/demand-pool
        String scrapReq = """
                { "idempotencyKey": "HTTP-SCRAP-ROLL-002", "operator": "品质经理", "reason": "外包装破损水浸整卷报废" }
                """;
        var scrapResp = post("/api/v2/rolls/ROLL-API-002/scrap", scrapReq);
        assertEquals(200, scrapResp.statusCode(), scrapResp.body());
        assertEquals("SCRAPPED", json.readTree(scrapResp.body()).path("roll").path("inspectionStatus").asString());
        assertEquals(0.0, json.readTree(scrapResp.body()).path("roll").path("currentRemainingLength").asDouble(), 1e-6);

        assertEquals(2, json.readTree(get("/api/rolls?limit=2&offset=0").body()).size());
        assertEquals(2, json.readTree(get("/api/remnants?limit=2&offset=0").body()).size());
        assertEquals(1, json.readTree(get("/api/v2/demand-pool?limit=1&offset=0").body()).size());

        // 最终账本全局对账必须 100% BALANCED！
        var ledgerRecon = get("/api/v2/inventory-ledger/reconciliation");
        assertEquals(200, ledgerRecon.statusCode(), ledgerRecon.body());
        assertEquals("BALANCED", json.readTree(ledgerRecon.body()).path("status").asString(), ledgerRecon.body());
    }
}
