package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.cutting.InventoryImportService.BatchImportRequest;
import com.example.cutdemotwo.business.cutting.InventoryImportService.DefectRowInput;
import com.example.cutdemotwo.business.cutting.InventoryImportService.RemnantRowInput;
import com.example.cutdemotwo.business.cutting.InventoryImportService.RollRowInput;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.persistence.FileInventoryStore;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * M4-2 原子批量库存导入领域服务单元测试（File 模式）：
 * 验证长度守恒、SCRAPPED 互斥、料头血统继承、瑕疵 0.1 mm 精度与边界、整批全回滚及幂等重放/409 冲突。
 */
class InventoryImportServiceTests {

    @TempDir
    Path tempDir;

    private InventoryImportService createService(String fileName, RemnantService[] holder) {
        RemnantService svc = new RemnantService(new FileInventoryStore(tempDir.resolve(fileName).toString()), false);
        if (holder != null && holder.length > 0) holder[0] = svc;
        return new InventoryImportService(svc);
    }

    private static RollRowInput validRoll(String id, double totalLen, double usedLen, Double remLen, Double scrapLen, String status) {
        return new RollRowInput(id, "TC-2026", "BAT-01", "华联织造", "斜纹布", "藏青",
                240.0, "65/35", 1.5, 2000.0, 2050.0, totalLen, usedLen, remLen, scrapLen,
                "R-01", status, "QA-1", "2026-11-27", 25.0, 12.5);
    }

    @Test
    void rollsImportEnforcesLengthConservationAtomicRollbackAndIdempotency() {
        RemnantService[] holder = new RemnantService[1];
        InventoryImportService svc = createService("import-rolls.json", holder);

        // 1. Preview 收集全量错误且零落库
        var badPreview = svc.previewRolls(new BatchImportRequest<>(null, "warehouse", List.of(
                validRoll("R-OK-1", 50000, 10000, 40000.0, 0.0, "PASSED"),
                validRoll("R-BAD-LEN", 50000, 10000, 30000.0, 0.0, "PASSED"), // 不守恒
                validRoll("R-BAD-SCRAP", 50000, 10000, 100.0, 39900.0, "SCRAPPED") // SCRAPPED 剩余非零
        )), "warehouse");
        assertTrue(badPreview.dryRun());
        assertFalse(badPreview.valid());
        assertEquals(1, badPreview.validRows());
        assertEquals(2, badPreview.errorRows());
        assertEquals("ROLL_LENGTH_MISMATCH", badPreview.errors().get(0).code());
        assertEquals("SCRAPPED_REMAINING_NON_ZERO", badPreview.errors().get(1).code());
        assertTrue(holder[0].getMotherRolls().isEmpty(), "Preview 不得落库任何母卷");

        // 2. Commit 含坏行必须整批回滚（第 0 行也不得半落库）
        BatchImportValidationException ex = assertThrows(BatchImportValidationException.class, () ->
                svc.commitRolls(new BatchImportRequest<>("key-roll-rollback", "warehouse", List.of(
                        validRoll("R-OK-1", 50000, 10000, 40000.0, 0.0, "PASSED"),
                        validRoll("R-BAD-LEN", 50000, 10000, 35000.0, 0.0, "PASSED")
                )), "key-roll-rollback", "warehouse"));
        assertEquals(1, ex.getErrors().size());
        assertEquals("ROLL_LENGTH_MISMATCH", ex.getErrors().get(0).code());
        assertNull(holder[0].getMotherRoll("R-OK-1"), "整批原子回滚后第 0 行 R-OK-1 绝不能残留");

        // 3. 合法提交 + 幂等重放 + 同键异载荷 409
        var commitReq = new BatchImportRequest<>("key-roll-ok", "warehouse", List.of(
                validRoll("R-OK-1", 50000, 10000, null, 0.0, "PASSED"),
                validRoll("R-SCRAP-1", 30000, 5000, 0.0, 25000.0, "SCRAPPED")
        ));
        var committed = svc.commitRolls(commitReq, "key-roll-ok", "warehouse");
        assertTrue(committed.valid());
        assertFalse(committed.idempotentReplay());
        assertEquals(2, committed.importedCount());
        assertEquals(40000.0, holder[0].getMotherRoll("R-OK-1").getCurrentRemainingLength(), 0.001);
        assertEquals("SCRAPPED", holder[0].getMotherRoll("R-SCRAP-1").getInspectionStatus());
        assertEquals("BALANCED", holder[0].reconcileInventory().get("status"));

        var replay = svc.commitRolls(commitReq, "key-roll-ok", "warehouse");
        assertTrue(replay.idempotentReplay());
        assertEquals(committed.documentId(), replay.documentId());

        var conflictReq = new BatchImportRequest<>("key-roll-ok", "warehouse", List.of(
                validRoll("R-OK-2", 40000, 0, 40000.0, 0.0, "PENDING")
        ));
        assertThrows(InventoryConflictException.class, () -> svc.commitRolls(conflictReq, "key-roll-ok", "warehouse"));
    }

    @Test
    void remnantsImportValidatesSourceRollAndInheritsLineage() {
        RemnantService[] holder = new RemnantService[1];
        InventoryImportService svc = createService("import-remnants.json", holder);
        MotherRollInfo src = new MotherRollInfo("ROLL-SRC-1", "LINEN-99", 1800.0, 40000.0, 0, 0.0);
        src.setBatchNo("BAT-LINEN-88");
        src.setColor("米白");
        holder[0].saveOrUpdateMotherRoll(src);

        // 来源母卷不存在报错
        var badPreview = svc.previewRemnants(new BatchImportRequest<>(null, "warehouse", List.of(
                new RemnantRowInput("REM-IMP-BAD", 500.0, 800.0, "A-1", null, "AVAILABLE", "ROLL-MISSING", null, 1, null, false, null, null, null)
        )), "warehouse");
        assertFalse(badPreview.valid());
        assertTrue(badPreview.errors().stream().anyMatch(e -> "SOURCE_ROLL_NOT_FOUND".equals(e.code())));

        // 合法导入并验证继承母卷缸号/色号/型号
        var res = svc.commitRemnants(new BatchImportRequest<>("key-rem-1", "warehouse", List.of(
                new RemnantRowInput("REM-IMP-1", 600.0, 1200.0, "A-02", null, "AVAILABLE", "ROLL-SRC-1", null, 1, "GRADE_A", false, null, null, null)
        )), "key-rem-1", "warehouse");
        assertEquals(1, res.importedCount());
        var saved = holder[0].scanOrGetById("REM-IMP-1");
        assertEquals("LINEN-99", saved.getMaterialBatch());
        assertEquals("BAT-LINEN-88", saved.getBatchNo());
        assertEquals("米白", saved.getColor());
    }

    @Test
    void defectsImportEnforcesPrecisionBoundsAndCaptureIdIdempotency() {
        RemnantService[] holder = new RemnantService[1];
        InventoryImportService svc = createService("import-defects.json", holder);
        holder[0].saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-DEF-1", "TC-1", 2000.0, 10000.0, 0, 0.0));

        // 1. 0.1 mm 精度与越界校验
        var badPreview = svc.previewDefects(new BatchImportRequest<>(null, "inspector", List.of(
                new DefectRowInput("ROLL-DEF-1", "CAP-1", 10.05, 20.0, 30.0, 40.0, 20.0, "STAIN", "污渍", 2, 2, null, null, null),
                new DefectRowInput("ROLL-DEF-1", "CAP-2", 1950.0, 20.0, 100.0, 40.0, 20.0, "HOLE", "破洞", 3, 3, null, null, null)
        )), "inspector");
        assertFalse(badPreview.valid());
        assertTrue(badPreview.errors().stream().anyMatch(e -> "PRECISION_VIOLATION".equals(e.code())));
        assertTrue(badPreview.errors().stream().anyMatch(e -> "OUT_OF_ROLL_BOUNDS".equals(e.code())));

        // 2. 首次提交成功
        var first = svc.commitDefects(new BatchImportRequest<>("key-def-1", "inspector", List.of(
                new DefectRowInput("ROLL-DEF-1", "CAP-OK-1", 100.5, 200.0, 50.0, 30.0, 20.0, "STAIN", "污渍", 2, 2, null, null, "边缘油渍")
        )), "key-def-1", "inspector");
        assertEquals(1, first.importedCount());
        assertEquals(0, first.skippedCount());

        // 3. 换新幂等键重复传完全一致的 captureId 应幂等跳过
        var dupSkip = svc.commitDefects(new BatchImportRequest<>("key-def-2", "inspector", List.of(
                new DefectRowInput("ROLL-DEF-1", "CAP-OK-1", 100.5, 200.0, 50.0, 30.0, 20.0, "STAIN", "污渍", 2, 2, null, null, "边缘油渍"),
                new DefectRowInput("ROLL-DEF-1", "CAP-OK-2", 300.0, 400.0, 20.0, 20.0, 20.0, "HOLE", "破洞", 3, 3, null, null, "针洞")
        )), "key-def-2", "inspector");
        assertEquals(1, dupSkip.importedCount());
        assertEquals(1, dupSkip.skippedCount());
        assertEquals(2, holder[0].getMotherRoll("ROLL-DEF-1").getDefects().size());

        // 4. 同 captureId 篡改坐标必须报 CAPTURE_ID_CONFLICT 且整批回滚
        BatchImportValidationException conflict = assertThrows(BatchImportValidationException.class, () ->
                svc.commitDefects(new BatchImportRequest<>("key-def-3", "inspector", List.of(
                        new DefectRowInput("ROLL-DEF-1", "CAP-OK-3", 500.0, 500.0, 10.0, 10.0, 20.0, "STAIN", "污渍", 2, 2, null, null, "新"),
                        new DefectRowInput("ROLL-DEF-1", "CAP-OK-1", 101.0, 200.0, 50.0, 30.0, 20.0, "STAIN", "污渍", 2, 2, null, null, "篡改")
                )), "key-def-3", "inspector"));
        assertTrue(conflict.getErrors().stream().anyMatch(e -> "CAPTURE_ID_CONFLICT".equals(e.code())));
        assertEquals(2, holder[0].getMotherRoll("ROLL-DEF-1").getDefects().size(), "回滚后 CAP-OK-3 不得落库");

        // 5. 超过 500 行限制
        List<RollRowInput> overLimit = new ArrayList<>();
        for (int i = 0; i < 501; i++) {
            overLimit.add(validRoll("R-" + i, 1000, 0, 1000.0, 0.0, "PENDING"));
        }
        assertThrows(IllegalArgumentException.class, () -> svc.previewRolls(new BatchImportRequest<>(null, "w", overLimit), "w"));

        // 6. IEEE-754 0.1 + 0.2 > 0.3 浮点边界：previewDefects 与 commitDefects 容差必须完全一致通过
        holder[0].saveOrUpdateMotherRoll(new MotherRollInfo("ROLL-FLT-03", "TC-1", 0.3, 1.0, 0, 0.0));
        var floatPreview = svc.previewDefects(new BatchImportRequest<>(null, "inspector", List.of(
                new DefectRowInput("ROLL-FLT-03", "CAP-FLT-1", 0.1, 0.2, 0.2, 0.8, 0.0, "STAIN", "污渍", 2, 2, null, null, "边界浮点精度")
        )), "inspector");
        assertTrue(floatPreview.valid(), "0.1 + 0.2 <= 0.3 合法边界预览必须通过: " + floatPreview.errors());
        var floatCommit = svc.commitDefects(new BatchImportRequest<>("key-def-float", "inspector", List.of(
                new DefectRowInput("ROLL-FLT-03", "CAP-FLT-1", 0.1, 0.2, 0.2, 0.8, 0.0, "STAIN", "污渍", 2, 2, null, null, "边界浮点精度")
        )), "key-def-float", "inspector");
        assertTrue(floatCommit.valid());
        assertEquals(1, floatCommit.importedCount());
    }
}
