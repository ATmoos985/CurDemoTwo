package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.model.VoidedDefect;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 母卷与料头物理档案垂直领域服务：
 * 仅依赖 InventoryStateKernel，负责母卷建档/验疵/质检判定/报废/演示数据初始化及料头登记/扫描/匹配/领用/状态管理。
 */
final class RollAndRemnantDomainService {

    private final InventoryStateKernel kernel;

    RollAndRemnantDomainService(InventoryStateKernel kernel) {
        this.kernel = kernel;
    }

    // ==================== 演示库存初始化 ====================

    private record DemoMaterial(String fabricCode, String materialModel, double width, double sampleWidth, double sampleLength) {}

    Map<String, Integer> initializeDemoInventory() {
        return kernel.mutate("DEMO_RECEIPT", null, "SYSTEM_DEMO", () -> {
            if (!kernel.motherRolls.isEmpty() || !kernel.remnantPool.isEmpty() || !kernel.tasks.isEmpty()
                    || !kernel.plans.isEmpty() || !kernel.receipts.isEmpty() || !kernel.executions.isEmpty()
                    || !kernel.transfers.isEmpty() || !kernel.counts.isEmpty()
                    || !kernel.templates.isEmpty() || !kernel.schemes.isEmpty()
                    || (kernel.store.supportsHotColdLoading() && (kernel.revision > 0 || kernel.store.countLedgerEntries() > 0))
                    || (kernel.store.supportsIndependentTemplates() && !kernel.store.loadTemplates().isEmpty())
                    || !kernel.qualityReleases.isEmpty() || !kernel.inventoryReceipts.isEmpty() || !kernel.materialIssues.isEmpty()) {
                throw new IllegalArgumentException("当前库已有业务数据，不能创建整套示例材料；请使用已有库存或单独准备演示库");
            }
            initMotherRolls();
            initSampleRemnants();
            appendOrderDemoInventory(orderDemoMaterials());
            kernel.motherRolls.values().forEach(roll -> roll.setStorageLocation("示例材料（非实物）"));
            kernel.remnantPool.values().forEach(remnant -> remnant.setLocation("示例料头（非实物）"));
            return Map.of("rolls", kernel.motherRolls.size(), "remnants", kernel.remnantPool.size());
        });
    }

    private DemoMaterial[] orderDemoMaterials() {
        try (var input = new org.springframework.core.io.ClassPathResource("demo/order-materials.json").getInputStream()) {
            return kernel.json.readValue(input, DemoMaterial[].class);
        } catch (java.io.IOException error) {
            throw new java.io.UncheckedIOException("读取订单演示材料失败", error);
        }
    }

    Map<String, Integer> prepareOrderDemoInventory() {
        var materials = orderDemoMaterials();
        return kernel.mutate("DEMO_RECEIPT", null, "SYSTEM_DEMO", () -> appendOrderDemoInventory(materials));
    }

    private Map<String, Integer> appendOrderDemoInventory(DemoMaterial[] materials) {
        int rollsBefore = kernel.motherRolls.size(), remnantsBefore = kernel.remnantPool.size();
        var examples = new LinkedHashMap<String, double[]>();
        for (var material : materials) {
            String id = Set.of("893153", "893292").contains(material.fabricCode())
                    ? "ROLL-REAL-" + material.fabricCode() : "ROLL-DEMO-928-" + material.fabricCode();
            if (!kernel.motherRolls.containsKey(id)) {
                var roll = new MotherRollInfo(id, material.materialModel(), "DEMO-928-" + material.fabricCode(),
                        "9.28 订单演示", "布料 " + material.fabricCode(), "演示未标定", 0, "演示未标定",
                        material.width(), 100000, "9.28 演示预置（非实物）");
                roll.setInspector("演示预置");
                roll.setShrinkageRate(0);
                kernel.motherRolls.put(id, roll);
            }
            if (material.materialModel().equals(kernel.motherRolls.get(id).getRollModel()))
                examples.put(id, new double[]{material.sampleWidth(), material.sampleLength()});
        }
        for (String id : List.of("ROLL-2026-0920", "ROLL-2026-0921", "ROLL-2026-0922", "ROLL-DEMO-2D")) {
            var roll = kernel.motherRolls.get(id);
            if (roll != null) examples.put(id, new double[]{roll.getWidth(), 1200});
        }
        for (var entry : examples.entrySet()) {
            var roll = kernel.motherRolls.get(entry.getKey());
            double width = Math.min(roll.getWidth(), entry.getValue()[0] + 40), length = entry.getValue()[1] + 60;
            for (int variant = 1; variant <= 3; variant++) {
                String id = "DEMO-REM-" + roll.getRollId() + "-" + variant;
                if (kernel.remnantPool.containsKey(id)) continue;
                boolean defect = variant == 2;
                double w = variant == 3 ? Math.max(100, Math.floor(width / 3)) : variant == 2 ? roll.getWidth() : width;
                double l = variant == 2 ? length * 2 + 300 : length;
                var remnant = new RemnantStock(id, w, l, "演示预置料头（非实物）", roll.getRollModel(),
                        "AVAILABLE", roll.getRollId(), defect,
                        variant == 1 ? "演示预置：整片复用" : defect ? "演示预置：局部带疵，需避让" : "演示预置：窄条，展示规格不匹配");
                remnant.setQualityGrade(defect ? "GRADE_DEFECT" : "GRADE_A");
                remnant.setGeneration(1);
                if (defect) remnant.setDefects(new ArrayList<>(List.of(new Defect(1, 40, l - 180, 120, 120,
                        20, "STAIN", "演示污斑", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "演示预置疵点"))));
                kernel.remnantPool.put(id, remnant);
            }
        }
        return Map.of("rolls", kernel.motherRolls.size() - rollsBefore, "remnants", kernel.remnantPool.size() - remnantsBefore);
    }

    void seedDefaultDemoData() {
        initMotherRolls();
        initSampleRemnants();
    }

    private void initMotherRolls() {
        MotherRollInfo roll1 = new MotherRollInfo("ROLL-2026-0920", "TC涤棉-B2026", "BAT-202609-A1",
                "华联高新纺织印染有限公司", "65/35涤棉高密斜纹布", "藏青色 (PANTONE 19-4024)",
                240.0, "65%涤纶, 35%精梳棉", 2000, 60000, "原料立库 R-01-A03");
        roll1.setCurrentRemainingLength(55000);
        roll1.setUsedLength(5000);
        roll1.setInspectionStatus("PASSED");
        roll1.setInspector("AI-SCANNER-01 (视觉验布复核)");
        roll1.setInspectionDate("2026-09-20");

        List<Defect> defs1 = new ArrayList<>();
        defs1.add(new Defect(1, 400, 1400, 200, 150, 20, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，4分制重疵，切断隔离"));
        defs1.add(new Defect(2, 1100, 3200, 160, 100, 20, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，影响受力，强制避让"));
        defs1.add(new Defect(3, 200, 8500, 300, 200, 20, "STAIN", "油污渍斑", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "印染滴油污渍，避开合格裁片"));
        defs1.add(new Defect(4, 1500, 14200, 150, 400, 25, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "织机断纬"));
        defs1.add(new Defect(5, 700, 22100, 100, 80, 15, "SLUB", "粗节结头", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "轻微粗节，允许落入带疵料头"));
        defs1.add(new Defect(6, 1200, 31500, 250, 180, 25, "HOLE", "撕裂破洞", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "落布撕破，必须切除隔离"));
        defs1.add(new Defect(7, 500, 45000, 400, 300, 20, "WEFT_DEFECT", "稀密档", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "纬密不匀条斑"));
        defs1.add(new Defect(8, 1600, 54200, 300, 150, 20, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色左中右色差"));
        roll1.setDefects(defs1);
        kernel.motherRolls.put(roll1.getRollId(), roll1);

        MotherRollInfo roll2 = new MotherRollInfo("ROLL-2026-0921", "纯棉斜纹-C2026", "BAT-202609-B2",
                "魏桥纺织股份有限公司", "100%精梳纯棉斜纹", "米白色 (PANTONE 11-0601)",
                210.0, "100%精梳棉", 1800, 50000, "原料立库 R-02-B01");
        roll2.setCurrentRemainingLength(48000);
        roll2.setUsedLength(2000);
        roll2.setInspectionStatus("PASSED");
        roll2.setInspector("李师傅 (人工验布标定)");
        roll2.setInspectionDate("2026-09-21");

        List<Defect> defs2 = new ArrayList<>();
        defs2.add(new Defect(9, 300, 2500, 180, 120, 20, "STAIN", "黄斑水渍", 2, 2, "MANUAL_INSPECT", "MUST_AVOID", "水渍泛黄"));
        defs2.add(new Defect(10, 1200, 16800, 140, 200, 20, "HOLE", "织孔破损", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织针损伤破洞"));
        defs2.add(new Defect(11, 800, 33000, 200, 100, 15, "SLUB", "棉结死棉", 1, 1, "AI_VISION_SCANNER", "PENETRABLE", "棉结"));
        roll2.setDefects(defs2);
        kernel.motherRolls.put(roll2.getRollId(), roll2);

        MotherRollInfo roll3 = new MotherRollInfo("ROLL-2026-0922", "弹力牛津-O2026", "BAT-202609-C3",
                "盛泽东方丝绸纺织", "锦棉弹力牛津纺", "墨绿色 (PANTONE 19-5513)",
                280.0, "70%锦纶, 25%棉, 5%氨纶", 2200, 80000, "原料立库 R-03-C05");
        roll3.setCurrentRemainingLength(80000);
        roll3.setUsedLength(0);
        roll3.setInspectionStatus("PENDING");
        roll3.setInspector("待视觉上线");
        roll3.setInspectionDate("2026-09-21");

        List<Defect> defs3 = new ArrayList<>();
        defs3.add(new Defect(12, 1000, 12000, 250, 180, 20, "WEFT_DEFECT", "氨纶断丝", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "弹力氨纶丝断"));
        roll3.setDefects(defs3);
        kernel.motherRolls.put(roll3.getRollId(), roll3);

        MotherRollInfo curtain2d = new MotherRollInfo("ROLL-DEMO-2D", "窗帘样布-2D", "DEMO-2D",
                "演示样布", "窗帘矩形样布", "米白色", 220, "演示面料", 2000, 30000, "演示库位");
        curtain2d.setInspectionStatus("PASSED");
        curtain2d.setDefects(new ArrayList<>(List.of(new Defect(21, 200, 1500, 150, 600, 50,
                "HOLE", "带疵改宽区域", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "二维带疵点演示"))));
        kernel.motherRolls.put(curtain2d.getRollId(), curtain2d);

        MotherRollInfo real893292 = new MotherRollInfo("ROLL-REAL-893292", "2#A3A-Cream", "BAT-REAL-893292",
                "真实布艺供应链 (893292)", "窗帘高密提花雪尼尔 (2#A3A-Cream)", "米色 (Cream)",
                380.0, "100%涤纶高密遮光", 2800, 100000, "布艺成品库 A-08-01");
        real893292.setCurrentRemainingLength(100000);
        real893292.setUsedLength(0);
        real893292.setInspectionStatus("PASSED");
        real893292.setInspector("AI视觉验布机-03 (已复核)");
        real893292.setInspectionDate("2026-09-28");
        real893292.setDefects(new ArrayList<>(List.of(
                new Defect(1, 2118.8, 3630.6, 144.1, 180.2, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(2, 1084.7, 9729.0, 251.8, 107.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(3, 914.7, 10595.8, 131.1, 242.7, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(4, 918.1, 11466.1, 176.0, 141.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(5, 1357.6, 14244.5, 261.4, 204.1, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(6, 1674.6, 23417.1, 115.8, 129.8, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱，避让"),
                new Defect(7, 163.9, 24621.8, 215.5, 199.8, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开"),
                new Defect(8, 2141.6, 54218.6, 254.6, 247.5, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(9, 2155.3, 55782.6, 176.0, 157.1, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(10, 724.4, 58663.5, 174.0, 115.6, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "纱支抽纱，强制避让"),
                new Defect(11, 472.8, 59798.8, 229.6, 183.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(12, 738.6, 69580.5, 149.0, 158.6, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(13, 848.5, 71027.9, 237.6, 117.3, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "染色色差，不可做正面裁片"),
                new Defect(14, 855.7, 73455.8, 145.8, 85.5, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞，切断隔离"),
                new Defect(15, 1517.2, 73542.7, 113.2, 235.2, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污，必须避开")
        )));
        kernel.motherRolls.put(real893292.getRollId(), real893292);

        MotherRollInfo real893153 = new MotherRollInfo("ROLL-REAL-893153", "2#1A-Off White", "BAT-REAL-893153",
                "真实布艺供应链 (893153)", "工程高密垂感遮光布 (2#1A-Off White)", "米白 (Off White)",
                360.0, "100%高支密涤纶", 2800, 100000, "布艺成品库 A-08-02");
        real893153.setCurrentRemainingLength(100000);
        real893153.setUsedLength(0);
        real893153.setInspectionStatus("PASSED");
        real893153.setInspector("AI视觉验布机-02 (已复核)");
        real893153.setInspectionDate("2026-09-28");
        real893153.setDefects(new ArrayList<>(List.of(
                new Defect(1, 1200.0, 4200.0, 180.0, 150.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "断纬跳纱避让"),
                new Defect(2, 600.0, 11500.0, 200.0, 120.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "切断隔离破洞"),
                new Defect(3, 1800.0, 18200.0, 150.0, 220.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污避开"),
                new Defect(4, 900.0, 27800.0, 160.0, 140.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱瑕疵"),
                new Defect(5, 2100.0, 35400.0, 220.0, 180.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差瑕疵"),
                new Defect(6, 400.0, 44200.0, 130.0, 160.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "破损点隔离"),
                new Defect(7, 1500.0, 52000.0, 190.0, 130.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "油污斑块"),
                new Defect(8, 800.0, 61500.0, 240.0, 170.0, 20.0, "WEFT_DEFECT", "纬向抽纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "抽纱疵点"),
                new Defect(9, 1700.0, 71200.0, 150.0, 190.0, 20.0, "SHADING", "边中色差", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "色差条斑"),
                new Defect(10, 500.0, 80400.0, 180.0, 140.0, 20.0, "HOLE", "经向破洞", 4, 4, "AI_VISION_SCANNER", "MUST_AVOID", "织造破洞"),
                new Defect(11, 1300.0, 88900.0, 210.0, 160.0, 20.0, "WEFT_DEFECT", "断纬跳纱", 3, 3, "AI_VISION_SCANNER", "MUST_AVOID", "跳纱瑕疵"),
                new Defect(12, 1900.0, 96500.0, 160.0, 200.0, 20.0, "STAIN", "油污渍斑", 2, 2, "AI_VISION_SCANNER", "MUST_AVOID", "印染油污")
        )));
        kernel.motherRolls.put(real893153.getRollId(), real893153);
    }

    private void initSampleRemnants() {
        RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
        r1.setGeneration(1);
        r1.setQualityGrade("GRADE_A");
        r1.setCreatedAt("2026-09-20 14:30");
        kernel.remnantPool.put(r1.getId(), r1);

        RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
        r2.setGeneration(1);
        r2.setQualityGrade("GRADE_A");
        r2.setCreatedAt("2026-09-20 16:15");
        kernel.remnantPool.put(r2.getId(), r2);

        RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
        r3.setGeneration(1);
        r3.setQualityGrade("GRADE_DEFECT");
        r3.setCreatedAt("2026-09-20 17:40");
        List<Defect> defs = new ArrayList<>();
        defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
        r3.setDefects(defs);
        kernel.remnantPool.put(r3.getId(), r3);

        RemnantStock r4 = new RemnantStock("REM-202609-004", 1800, 1200, "库位 C-01-05", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉完好短料");
        r4.setGeneration(1);
        r4.setQualityGrade("GRADE_A");
        r4.setCreatedAt("2026-09-21 09:00");
        kernel.remnantPool.put(r4.getId(), r4);

        RemnantStock r5 = new RemnantStock("REM-202609-005", 400, 3000, "库位 C-02-02", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉分条长料头");
        r5.setGeneration(1);
        r5.setQualityGrade("GRADE_A");
        r5.setCreatedAt("2026-09-21 09:20");
        kernel.remnantPool.put(r5.getId(), r5);
    }

    // ==================== 母卷建档、重置、验疵、放行与报废 ====================

    boolean resetRoll(String rollId) {
        return kernel.mutate("DEMO_RESET", rollId, "UNAUTHENTICATED_LOCAL", () -> resetRollInternal(rollId));
    }

    private boolean resetRollInternal(String rollId) {
        kernel.ensureMaterialNotReserved("roll", rollId, null);
        List<RemnantStock> derivedRemnants = kernel.store.supportsHotColdLoading()
                ? kernel.store.listRemnantsBySourceRoll(rollId)
                : kernel.remnantPool.values().stream().filter(rm -> rollId.equals(rm.getSourceRollId())).toList();
        if (derivedRemnants.stream().anyMatch(rm -> kernel.isMaterialReservedByExecution("remnant", rm.getId(), null)
                || kernel.isMaterialReservedByScheme("remnant", rm.getId(), null)))
            throw new InventoryConflictException("母卷派生料头已被执行单或排程方案占用，禁止演示重置");
        if (kernel.countRevision("roll", rollId) > 0 || derivedRemnants.stream().anyMatch(rm -> kernel.countRevision("remnant", rm.getId()) > 0))
            throw new InventoryConflictException("材料已有盘点单追溯，禁止演示重置；请新建盘点单更正");
        boolean hasTransfer = kernel.store.supportsHotColdLoading()
                ? (kernel.store.hasTransferForMaterial("roll", rollId)
                    || derivedRemnants.stream().anyMatch(rm -> kernel.store.hasTransferForMaterial("remnant", rm.getId())))
                : kernel.transfers.values().stream().flatMap(t -> t.lines().stream()).anyMatch(line ->
                    "roll".equals(line.type()) && rollId.equals(line.id()) || "remnant".equals(line.type())
                    && kernel.remnantPool.containsKey(line.id()) && rollId.equals(kernel.remnantPool.get(line.id()).getSourceRollId()));
        if (hasTransfer)
            throw new InventoryConflictException("材料已有移库单追溯，禁止演示重置；请新建移库单更正库位");
        if (kernel.executions.values().stream().anyMatch(e -> Objects.equals(e.materialId(), rollId)
                || kernel.plans.containsKey(e.planId()) && Objects.equals(kernel.plans.get(e.planId()).request().getRollId(), rollId)))
            throw new InventoryConflictException("材料已有执行单追溯，禁止演示重置");
        if (kernel.schemes.values().stream().anyMatch(s -> rollId.equals(s.rollId())))
            throw new InventoryConflictException("材料已有排程方案追溯，禁止演示重置");
        boolean hasQualityRelease = kernel.store.supportsHotColdLoading()
                ? derivedRemnants.stream().anyMatch(rm -> kernel.store.hasQualityReleaseForRemnant(rm.getId()))
                : kernel.qualityReleases.values().stream().anyMatch(q -> kernel.remnantPool.containsKey(q.remnantId())
                    && rollId.equals(kernel.remnantPool.get(q.remnantId()).getSourceRollId()));
        if (hasQualityRelease)
            throw new InventoryConflictException("材料已有质量放行单追溯，禁止演示重置");
        boolean hasReceiptIn = kernel.store.supportsHotColdLoading()
                ? kernel.store.hasInventoryReceiptForRoll(rollId)
                : kernel.inventoryReceipts.values().stream().flatMap(r -> r.lines().stream()).anyMatch(l -> rollId.equals(l.rollId()));
        if (hasReceiptIn)
            throw new InventoryConflictException("母卷已有采购入库单追溯，禁止演示重置");
        boolean hasIssue = kernel.store.supportsHotColdLoading()
                ? kernel.store.hasMaterialIssueForRoll(rollId)
                : kernel.materialIssues.values().stream().anyMatch(m -> rollId.equals(m.rollId()));
        if (hasIssue)
            throw new InventoryConflictException("母卷已有车间领退料单追溯，禁止演示重置");
        MotherRollInfo roll = kernel.findOrLoadRoll(rollId);
        if (roll == null) return false;
        Collection<Map<String, Object>> rollReports = kernel.store.supportsHotColdLoading()
                ? kernel.store.findCutReportsByRollId(rollId)
                : kernel.receipts.values().stream().filter(r -> rollId.equals(r.get("rollId"))).toList();
        if (rollReports.stream().anyMatch(r -> !kernel.qualityEvents(r).isEmpty()))
            throw new IllegalArgumentException("母卷已有复检处置，不能通过演示重置清除产出追溯");
        if (!rollReports.isEmpty())
            throw new IllegalArgumentException("该母卷已有报工记录，不能通过演示重置清除；请保留原记录并按实际情况冲销");
        roll.setCurrentRemainingLength(roll.getTotalLength());
        roll.setUsedLength(0.0);
        kernel.remnantPool.entrySet().removeIf(e -> rollId.equals(e.getValue().getSourceRollId()));
        if ("ROLL-2026-0920".equals(rollId)) {
            RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
            r1.setGeneration(1);
            r1.setQualityGrade("GRADE_A");
            r1.setCreatedAt("2026-09-20 14:30");
            kernel.remnantPool.put(r1.getId(), r1);

            RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
            r2.setGeneration(1);
            r2.setQualityGrade("GRADE_A");
            r2.setCreatedAt("2026-09-20 16:15");
            kernel.remnantPool.put(r2.getId(), r2);

            RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                    "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
            r3.setGeneration(1);
            r3.setQualityGrade("GRADE_DEFECT");
            r3.setCreatedAt("2026-09-20 17:40");
            List<Defect> defs = new ArrayList<>();
            defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
            r3.setDefects(defs);
            kernel.remnantPool.put(r3.getId(), r3);
        }
        return true;
    }

    List<MotherRollInfo> getMotherRolls() {
        return kernel.read(() -> {
            List<MotherRollInfo> sourceRolls = kernel.store.supportsHotColdLoading()
                    ? kernel.store.listAllMotherRolls()
                    : new ArrayList<>(kernel.motherRolls.values());
            List<MotherRollInfo> list = new ArrayList<>(sourceRolls.size());
            if (kernel.store.supportsHotColdLoading()) {
                Map<String, List<RemnantStock>> byRoll = new HashMap<>();
                for (RemnantStock rm : kernel.remnantPool.values()) {
                    if ("AVAILABLE".equalsIgnoreCase(rm.getStatus()) && rm.getSourceRollId() != null) {
                        byRoll.computeIfAbsent(rm.getSourceRollId(), k -> new ArrayList<>()).add(rm);
                    }
                }
                for (MotherRollInfo info : sourceRolls) {
                    List<RemnantStock> rollRemnants = byRoll.getOrDefault(info.getRollId(), List.of());
                    double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
                    list.add(info.copyWithRemnantStats(rollRemnants.size(), totalArea));
                }
            } else {
                for (MotherRollInfo info : sourceRolls) {
                    List<RemnantStock> rollRemnants = kernel.getRemnantsByRollIdInternal(info.getRollId());
                    double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
                    list.add(info.copyWithRemnantStats(rollRemnants.size(), totalArea));
                }
            }
            return list;
        });
    }

    MotherRollInfo getMotherRoll(String rollId) {
        return kernel.read(() -> kernel.getMotherRollInternal(rollId));
    }

    MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) {
        return kernel.mutate("ROLL_RECEIPT_OR_UPDATE", roll == null ? null : roll.getRollId(), "UNAUTHENTICATED_LOCAL",
                () -> saveOrUpdateMotherRollInternal(roll));
    }

    MotherRollInfo saveOrUpdateMotherRollInternal(MotherRollInfo roll) {
        if (roll == null || roll.getRollId() == null || roll.getRollId().trim().isEmpty()) {
            throw new IllegalArgumentException("母卷编号 (rollId) 不能为空！");
        }
        if (!Double.isFinite(roll.getWidth()) || !Double.isFinite(roll.getTotalLength()) ||
                roll.getWidth() <= 0 || roll.getTotalLength() <= 0) {
            throw new IllegalArgumentException("母卷幅宽和总长度必须大于零");
        }
        if (!Double.isFinite(roll.getShrinkageRate()) || roll.getShrinkageRate() < 0 || roll.getShrinkageRate() > 100) {
            throw new IllegalArgumentException("母卷缩水率必须为 0 至 100 之间的有限数值");
        }
        if (roll.getUnitPricePerMeter() != null && (!Double.isFinite(roll.getUnitPricePerMeter()) || roll.getUnitPricePerMeter() < 0)) {
            throw new IllegalArgumentException("母卷每米采购单价必须为非负有限数值");
        }
        if (roll.getUnitPricePerSqm() != null && (!Double.isFinite(roll.getUnitPricePerSqm()) || roll.getUnitPricePerSqm() < 0)) {
            throw new IllegalArgumentException("母卷每平方米采购单价必须为非负有限数值");
        }
        kernel.ensureMaterialNotReserved("roll", roll.getRollId(), null);
        MotherRollInfo existing = kernel.findOrLoadRoll(roll.getRollId());
        if (existing != null) {
            if ("SCRAPPED".equalsIgnoreCase(existing.getInspectionStatus())) {
                throw new InventoryConflictException("已报废母卷不可修改档案");
            }
            if (Math.abs(existing.getWidth() - roll.getWidth()) > 0.001 ||
                    Math.abs(existing.getTotalLength() - roll.getTotalLength()) > 0.001) {
                throw new IllegalArgumentException("已登记母卷的物理尺寸不可直接覆盖");
            }
            existing.setRollModel(roll.getRollModel());
            existing.setBatchNo(roll.getBatchNo());
            existing.setSupplier(roll.getSupplier());
            existing.setMaterialName(roll.getMaterialName());
            existing.setColor(roll.getColor());
            existing.setGrammage(roll.getGrammage());
            existing.setComposition(roll.getComposition());
            existing.setShrinkageRate(roll.getShrinkageRate());
            existing.setUnitPricePerMeter(roll.getUnitPricePerMeter());
            existing.setUnitPricePerSqm(roll.getUnitPricePerSqm());
            existing.setWidth(roll.getWidth());
            existing.setRawWidth(roll.getRawWidth());
            existing.setTotalLength(roll.getTotalLength());
            if (!Objects.equals(Objects.toString(existing.getStorageLocation(), ""), Objects.toString(roll.getStorageLocation(), "")))
                throw new IllegalArgumentException("已登记材料请通过移库单变更库位");
            String requestedStatus = roll.getInspectionStatus() == null ? null : roll.getInspectionStatus().trim();
            if ("SCRAPPED".equalsIgnoreCase(requestedStatus)) {
                throw new IllegalArgumentException("在库母卷请通过专用报废接口办理报废，禁止直接将质检状态修改为 SCRAPPED");
            }
            existing.setInspectionStatus(roll.getInspectionStatus());
            if (roll.getDefects() != null && !roll.getDefects().isEmpty()
                    && !kernel.json.writeValueAsString(roll.getDefects()).equals(kernel.json.writeValueAsString(existing.getDefects())))
                throw new IllegalArgumentException("已登记母卷的疵点请在跑布验疵中追加或作废（留痕），档案保存不能覆盖疵点");
            return existing;
        } else {
            if (!Double.isFinite(roll.getUsedLength()) || roll.getUsedLength() < 0) {
                throw new IllegalArgumentException("母卷已用长度必须为非负有限数值");
            }
            if (!Double.isFinite(roll.getCurrentRemainingLength()) || roll.getCurrentRemainingLength() < 0) {
                throw new IllegalArgumentException("母卷剩余长度必须为非负有限数值");
            }
            if (roll.getUsedLength() > roll.getTotalLength() + 0.001) {
                throw new IllegalArgumentException("母卷已用长度不能大于入库总长度");
            }
            if (roll.getCreatedAt() == null) {
                roll.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            }
            String requestedStatus = roll.getInspectionStatus() == null ? "" : roll.getInspectionStatus().trim();
            boolean isScrapped = "SCRAPPED".equalsIgnoreCase(requestedStatus);
            if (!isScrapped && roll.getCurrentRemainingLength() <= 0) {
                double computedRemaining = Math.max(0.0, roll.getTotalLength() - roll.getUsedLength());
                roll.setCurrentRemainingLength(computedRemaining);
            }
            if (isScrapped) {
                roll.setInspectionStatus("SCRAPPED");
            }
            double scrapped = roll.getScrappedLengthMm() != null ? roll.getScrappedLengthMm() : 0.0;
            if (!Double.isFinite(scrapped) || scrapped < 0
                    || (isScrapped && roll.getCurrentRemainingLength() > 0.001)
                    || (!isScrapped && scrapped > 0.001)) {
                throw new IllegalArgumentException("母卷质检状态与剩余/报废长度不守恒：报废母卷剩余长度必须为 0，非报废母卷报废长度必须为 0");
            }
            if (Math.abs(roll.getTotalLength() - roll.getUsedLength() - roll.getCurrentRemainingLength() - scrapped) > 0.001) {
                throw new IllegalArgumentException("母卷总长度、已用长度与剩余长度不守恒，请核对输入");
            }
            kernel.motherRolls.put(roll.getRollId(), roll);
            return roll;
        }
    }

    Defect addDefectToRoll(String rollId, Defect defect) {
        return kernel.mutate("INSPECTION", rollId, "UNAUTHENTICATED_LOCAL", () -> addDefectToRollInternal(rollId, defect));
    }

    MotherRollInfo voidDefect(String rollId, int defectId, String reason) {
        return kernel.mutate("DEFECT_VOID", rollId, "UNAUTHENTICATED_LOCAL", () -> {
            MotherRollInfo roll = kernel.findOrLoadRoll(rollId);
            if (roll == null) throw new IllegalArgumentException("未找到母卷，请重新选择");
            String why = reason == null ? "" : reason.trim();
            if (why.isEmpty() || why.length() > 200) throw new IllegalArgumentException("请填写作废原因（200 字以内）");
            var defect = roll.getDefects().stream().filter(d -> d.getId() == defectId).findFirst().orElse(null);
            if (defect == null) {
                if (roll.getVoidedDefects().stream().anyMatch(v -> v.defect() != null && v.defect().getId() == defectId))
                    return roll;
                throw new IllegalArgumentException("疵点不存在，请刷新后核对");
            }
            if (defect.getY() + defect.getH() <= roll.getUsedLength())
                throw new IllegalArgumentException("疵点位于已切区域，属于历史记录，不能作废");
            kernel.ensureMaterialNotReserved("roll", rollId, null);
            roll.getDefects().remove(defect);
            roll.getVoidedDefects().add(new VoidedDefect(defect, why, LocalDateTime.now().toString(), "UNAUTHENTICATED_LOCAL"));
            return roll;
        });
    }

    MotherRollInfo createInspectionRoll(MotherRollInfo input) {
        return kernel.mutate("ROLL_RECEIPT", input == null ? null : input.getRollId(), "UNAUTHENTICATED_LOCAL", () -> {
            if (input == null || input.getRollId() == null || input.getRollId().isBlank())
                throw new IllegalArgumentException("请输入母卷编号");
            if (kernel.findOrLoadRoll(input.getRollId()) != null) throw new IllegalArgumentException("此母卷编号已存在，请选择已有母卷");
            var roll = new MotherRollInfo();
            roll.setRollId(input.getRollId());
            roll.setRollModel(input.getRollModel());
            roll.setWidth(input.getWidth());
            roll.setRawWidth(input.getWidth());
            roll.setTotalLength(input.getTotalLength());
            roll.setInspectionStatus("PENDING");
            roll.setInspector("人工验布");
            roll.setInspectionDate(null);
            roll.setCreatedAt(LocalDateTime.now().toString());
            return saveOrUpdateMotherRollInternal(roll);
        });
    }

    MotherRollInfo saveInspection(String rollId, double inputWidth, double inputTotalLength, List<Defect> inputDefects) {
        return kernel.mutate("INSPECTION", rollId, "UNAUTHENTICATED_LOCAL", () -> {
            var roll = kernel.findOrLoadRoll(rollId);
            if (roll == null) throw new IllegalArgumentException("未找到母卷，请重新选择");
            if (inputWidth != roll.getWidth() || inputTotalLength != roll.getTotalLength())
                throw new IllegalArgumentException("母卷尺寸已变化，请重新载入后核对标记");
            if (inputDefects == null || inputDefects.isEmpty() || inputDefects.size() > 5000)
                throw new IllegalArgumentException("每次请保存 1–5000 处疵点");
            var keys = new HashSet<String>();
            for (var incoming : inputDefects) {
                if (incoming == null || incoming.getCaptureId() == null || !incoming.getCaptureId().matches("[a-zA-Z0-9-]{1,80}")
                        || !keys.add(incoming.getCaptureId())) throw new IllegalArgumentException("疵点记录标识无效或重复");
                var defect = kernel.json.readValue(kernel.json.writeValueAsBytes(incoming), Defect.class);
                defect.setId(0);
                defect.setDetectionSource("MANUAL_INSPECT");
                defect.setAvoidanceStrategy("MUST_AVOID");
                var existing = roll.getDefects().stream().filter(d -> incoming.getCaptureId().equals(d.getCaptureId())).findFirst();
                if (existing.isPresent()) {
                    var copy = kernel.json.readValue(kernel.json.writeValueAsBytes(existing.get()), Defect.class);
                    copy.setId(0);
                    if (!kernel.json.writeValueAsString(copy).equals(kernel.json.writeValueAsString(defect)))
                        throw new IllegalArgumentException("此疵点已保存，内容与本地记录不同，请重新载入核对");
                    continue;
                }
                for (double n : new double[]{defect.getX(), defect.getY(), defect.getW(), defect.getH(), defect.getMargin()})
                    if (!Double.isFinite(n) || Math.abs(n * 10 - Math.rint(n * 10)) > .000001)
                        throw new IllegalArgumentException("疵点位置和尺寸须精确到 0.1 mm");
                addDefectToRollInternal(rollId, defect);
            }
            return roll;
        });
    }

    Defect addDefectToRollInternal(String rollId, Defect defect) {
        kernel.ensureMaterialNotReserved("roll", rollId, null);
        MotherRollInfo roll = kernel.findOrLoadRoll(rollId);
        if (roll == null) {
            throw new IllegalArgumentException("未找到母卷: " + rollId);
        }
        if (defect == null || !Double.isFinite(defect.getX()) || !Double.isFinite(defect.getY()) ||
                !Double.isFinite(defect.getW()) || !Double.isFinite(defect.getH()) ||
                defect.getX() < 0 || defect.getY() < 0 || defect.getW() <= 0 || defect.getH() <= 0 ||
                defect.getX() + defect.getW() > roll.getWidth() + 1e-6 ||
                defect.getY() + defect.getH() > roll.getTotalLength() + 1e-6) {
            throw new IllegalArgumentException("疵点坐标或尺寸超出母卷范围");
        }
        if (!Double.isFinite(defect.getMargin()) || defect.getMargin() < 0)
            throw new IllegalArgumentException("疵点避让间距必须是非负数");
        if (defect.getId() == 0) {
            kernel.defectSeq.accumulateAndGet(roll.getDefects().stream().mapToInt(Defect::getId).max().orElse(0), Math::max);
            defect.setId(kernel.defectSeq.incrementAndGet());
        }
        roll.getDefects().add(defect);
        return defect;
    }

    Map<String, Object> scrapMotherRoll(String rollId, String idempotencyKey, String operatorInput, String reasonInput) {
        if (rollId == null || rollId.isBlank()) throw new IllegalArgumentException("请指定母卷编号 rollId");
        String key = InventoryStateKernel.requireIdempotencyKey(idempotencyKey);
        String operator = InventoryStateKernel.requireText(operatorInput, 100, "请填写 1–100 字操作人");
        String reason = InventoryStateKernel.requireText(reasonInput, 500, "请填写 1–500 字报废原因");
        String targetRollId = rollId.trim();

        MotherRollInfo scrapped = kernel.mutate("ROLL_SCRAP", targetRollId, "DECLARED:" + operator, () -> {
            MotherRollInfo existing = kernel.motherRolls.values().stream()
                    .filter(r -> key.equals(r.getScrapIdempotencyKey())).findFirst()
                    .orElseGet(() -> kernel.store.supportsHotColdLoading()
                            ? kernel.store.findMotherRollByScrapKey(key).orElse(null) : null);
            if (existing != null) {
                if (!targetRollId.equals(existing.getRollId())
                        || !operator.equals(existing.getScrappedBy())
                        || !reason.equals(existing.getScrapReason())) {
                    throw new InventoryConflictException("同一幂等键已用于其他母卷报废内容");
                }
                return existing;
            }
            return null;
        }, () -> {
            MotherRollInfo roll = kernel.findOrLoadRoll(targetRollId);
            if (roll == null) throw new IllegalArgumentException("母卷不存在: " + targetRollId);
            if ("SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) {
                throw new InventoryConflictException("母卷 " + targetRollId + " 已报废，不能重复报废");
            }
            kernel.ensureMaterialNotReserved("roll", targetRollId, null);
            double remainingToScrap = Math.max(0.0, roll.getCurrentRemainingLength());
            roll.setCurrentRemainingLength(0.0);
            roll.setScrappedLengthMm(remainingToScrap);
            roll.setInspectionStatus("SCRAPPED");
            roll.setScrapReason(reason);
            roll.setScrappedBy(operator);
            roll.setScrappedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            roll.setScrapIdempotencyKey(key);
            roll.setIssuedMachineId(null);
            roll.setIssuedShiftTeam(null);
            return roll;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("roll", kernel.read(() -> kernel.getMotherRollInternal(scrapped.getRollId())));
        out.put("revision", kernel.revision);
        return out;
    }

    Map<String, Object> completeMotherRollInspection(String rollId, String statusInput, String inspectorInput) {
        if (rollId == null || rollId.isBlank()) throw new IllegalArgumentException("请指定母卷编号 rollId");
        String targetRollId = rollId.trim();
        String status = statusInput == null ? "" : statusInput.trim().toUpperCase(Locale.ROOT);
        if (!Set.of("PASSED", "FAILED").contains(status)) {
            throw new IllegalArgumentException("质检判定状态仅支持 PASSED（合格放行）或 FAILED（不合格留置）");
        }
        String inspector = InventoryStateKernel.requireText(inspectorInput, 100, "请填写 1–100 字质检员姓名");
        String eventType = "PASSED".equals(status) ? "ROLL_INSPECTION_PASS" : "ROLL_INSPECTION_FAIL";

        MotherRollInfo updated = kernel.mutate(eventType, targetRollId, "DECLARED:" + inspector, () -> {
            MotherRollInfo roll = kernel.findOrLoadRoll(targetRollId);
            if (roll == null) throw new IllegalArgumentException("母卷不存在: " + targetRollId);
            if ("SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) {
                throw new InventoryConflictException("母卷 " + targetRollId + " 已报废，不能执行质检判定");
            }
            if ("FAILED".equals(status)) {
                kernel.ensureMaterialNotReserved("roll", targetRollId, null);
            }
            roll.setInspectionStatus(status);
            roll.setInspector(inspector);
            roll.setInspectionDate(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            return roll;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("roll", kernel.read(() -> kernel.getMotherRollInternal(updated.getRollId())));
        out.put("status", status);
        out.put("revision", kernel.revision);
        return out;
    }

    // ==================== 料头全生命周期 ====================

    boolean scrapRemnant(String id, String reason) {
        return kernel.mutate("REMNANT_SCRAP", id, "UNAUTHENTICATED_LOCAL", () -> scrapRemnantInternal(id, reason));
    }

    private boolean scrapRemnantInternal(String id, String reason) {
        kernel.ensureMaterialNotReserved("remnant", id, null);
        RemnantStock item = kernel.findOrLoadRemnant(id);
        if (item == null) return false;
        if ("LOST".equals(item.getStatus())) throw new InventoryConflictException("盘亏料头未见实物，不能报废；找回请登记盘点单");
        item.setStatus("SCRAPPED");
        item.setDefectDesc((item.getDefectDesc() != null ? item.getDefectDesc() + " | " : "") + "已报废: " + reason);
        return true;
    }

    List<RemnantStock> getAvailableRemnants() {
        return kernel.read(kernel::getAvailableRemnantsInternal);
    }

    List<RemnantStock> getRemnantsByRollId(String rollId) {
        return kernel.read(() -> kernel.getRemnantsByRollIdInternal(rollId));
    }

    List<RemnantStock> getAllRemnants() {
        return kernel.read(() -> kernel.store.supportsHotColdLoading()
                ? kernel.store.listAllRemnants()
                : new ArrayList<>(kernel.remnantPool.values()));
    }

    RemnantStock scanOrGetById(String id) {
        return kernel.read(() -> scanOrGetByIdInternal(id));
    }

    private RemnantStock scanOrGetByIdInternal(String id) {
        if (id == null) return null;
        String cleanId = id.trim();
        RemnantStock direct = kernel.remnantPool.get(cleanId);
        if (direct != null && "AVAILABLE".equalsIgnoreCase(direct.getStatus())) {
            return direct;
        }
        for (RemnantStock r : kernel.remnantPool.values()) {
            if ("AVAILABLE".equalsIgnoreCase(r.getStatus()) &&
                    (r.getId().equalsIgnoreCase(cleanId) || r.getId().endsWith(cleanId))) {
                return r;
            }
        }
        return null;
    }

    List<RemnantStock> matchRemnants(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        return kernel.read(() -> {
            List<RemnantStock> candidates = kernel.getRemnantsByRollIdInternal(rollId);
            List<RemnantStock> matched = new ArrayList<>();
            for (RemnantStock r : candidates) {
                if (r.isHasDefect()) continue;
                boolean fitsNormal = (r.getWidth() >= pieceW && r.getLength() >= pieceL);
                boolean fitsRotated = allowRotation && (r.getWidth() >= pieceL && r.getLength() >= pieceW);
                if (fitsNormal || fitsRotated) {
                    matched.add(r);
                }
            }
            matched.sort(Comparator.comparingDouble(RemnantStock::getArea));
            return matched;
        });
    }

    RemnantStock registerRemnant(RemnantStock item) {
        return kernel.mutate("REMNANT_RECEIPT", item == null ? null : item.getId(), "UNAUTHENTICATED_LOCAL",
                () -> registerRemnantInternal(item));
    }

    RemnantStock registerRemnantInternal(RemnantStock item) {
        if (item == null || !Double.isFinite(item.getWidth()) || !Double.isFinite(item.getLength()) ||
                item.getWidth() <= 0 || item.getLength() <= 0) throw new IllegalArgumentException("料头宽长必须大于零");
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            item.setId("REM-" + dateStr + "-" + String.format("%03d", kernel.remnantSeq.incrementAndGet()));
        }
        if (kernel.findOrLoadRemnant(item.getId()) != null) throw new IllegalArgumentException("料头编号已存在: " + item.getId());
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        kernel.inheritLineageMetadata(item, item.getSourceRollId() != null ? kernel.findOrLoadRoll(item.getSourceRollId()) : null,
                item.getParentRemnantId() != null ? kernel.findOrLoadRemnant(item.getParentRemnantId()) : null);
        kernel.remnantPool.put(item.getId(), item);
        return item;
    }

    RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        return kernel.mutate("REMNANT_RECEIPT", rollId, "UNAUTHENTICATED_LOCAL", () -> {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            String newId = "REM-" + dateStr + "-" + String.format("%03d", kernel.remnantSeq.incrementAndGet());
            if (parentRemnantId != null && !parentRemnantId.isEmpty()) {
                newId = parentRemnantId + "-SUB" + kernel.remnantSeq.get();
            }
            RemnantStock rs = new RemnantStock(newId, w, l, "现场料头架", rollId, "AVAILABLE", rollId, hasDefect, desc);
            rs.setParentRemnantId(parentRemnantId);
            rs.setGeneration(parentRemnantId != null ? 2 : 1);
            rs.setQualityGrade(hasDefect ? "GRADE_DEFECT" : "GRADE_A");
            kernel.inheritLineageMetadata(rs, rollId != null ? kernel.findOrLoadRoll(rollId) : null,
                    parentRemnantId != null ? kernel.findOrLoadRemnant(parentRemnantId) : null);
            rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            kernel.remnantPool.put(rs.getId(), rs);
            return rs;
        });
    }

    boolean consumeRemnant(String id) {
        return kernel.mutate("REMNANT_ISSUE", id, "UNAUTHENTICATED_LOCAL", () -> {
            kernel.ensureMaterialNotReserved("remnant", id, null);
            if (id == null) return false;
            RemnantStock item = kernel.findOrLoadRemnant(id);
            if (item != null) {
                if ("CONSUMED".equals(item.getStatus())) return true;
                if (!"AVAILABLE".equals(item.getStatus())) throw new InventoryConflictException("只有可用料头可以领用；盘亏找回后须先完成质量检验");
                item.setStatus("CONSUMED");
                item.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
                return true;
            }
            return false;
        });
    }

    boolean updateStatus(String id, String status) {
        return kernel.mutate("REMNANT_STATUS_ADJUSTMENT", id, "UNAUTHENTICATED_LOCAL", () -> {
            kernel.ensureMaterialNotReserved("remnant", id, null);
            if (id == null) return false;
            RemnantStock item = kernel.findOrLoadRemnant(id);
            if (item != null) {
                if ("LOST".equals(item.getStatus()) || "LOST".equals(status)) throw new InventoryConflictException("盘亏与找回必须通过盘点单登记");
                if (status == null || !Set.of("AVAILABLE", "QUARANTINED", "SCRAPPED").contains(status))
                    throw new IllegalArgumentException("状态调整仅支持可用、隔离或报废");
                if (!Objects.equals(item.getStatus(), status) && (Set.of("CONSUMED", "SCRAPPED").contains(item.getStatus())
                        || ("QUARANTINED".equals(item.getStatus()) && "AVAILABLE".equals(status))))
                    throw new InventoryConflictException("不能通过状态调整恢复已耗用、报废或待检料头");
                item.setStatus(status);
                return true;
            }
            return false;
        });
    }
}
