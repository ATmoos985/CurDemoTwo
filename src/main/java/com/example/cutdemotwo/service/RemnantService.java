package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.MotherRollInfo;
import com.example.cutdemotwo.model.RemnantStock;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

/**
 * 工业母卷与料头全生命周期档案服务 (Master Roll & Remnant Inventory Service)
 * 维护母卷物理规格、多道工序验布疵点、现场料头库存货架与代际派生血统
 */
@Service
public class RemnantService {

    private final Map<String, RemnantStock> remnantPool = new ConcurrentHashMap<>();
    private final Map<String, MotherRollInfo> motherRolls = new LinkedHashMap<>();
    private final AtomicInteger remnantSeq = new AtomicInteger(10);
    private final AtomicInteger defectSeq = new AtomicInteger(20);

    public RemnantService() {
        initMotherRolls();
        initSampleRemnants();
    }

    private void initMotherRolls() {
        // 母卷 1: ROLL-2026-0920 (TC涤棉)
        MotherRollInfo roll1 = new MotherRollInfo("ROLL-2026-0920", "TC涤棉-B2026", "BAT-202609-A1",
                "华联高新纺织印染有限公司", "65/35涤棉高密斜纹布", "藏青色 (PANTONE 19-4024)",
                240.0, "65%涤纶, 35%精梳棉", 2000, 60000, "原料立库 R-01-A03");
        roll1.setCurrentRemainingLength(55000);
        roll1.setUsedLength(5000);
        roll1.setInspectionStatus("PASSED");
        roll1.setInspector("AI-SCANNER-01 (视觉验布复核)");
        roll1.setInspectionDate("2026-09-20");

        // 录入 8 处纺织 4 分制标准疵点
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
        motherRolls.put(roll1.getRollId(), roll1);

        // 母卷 2: ROLL-2026-0921 (纯棉斜纹)
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
        motherRolls.put(roll2.getRollId(), roll2);

        // 母卷 3: ROLL-2026-0922 (弹力牛津)
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
        motherRolls.put(roll3.getRollId(), roll3);
    }

    private void initSampleRemnants() {
        // 母卷 ROLL-2026-0920 切下的料头
        RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
        r1.setGeneration(1);
        r1.setQualityGrade("GRADE_A");
        r1.setCreatedAt("2026-09-20 14:30");
        remnantPool.put(r1.getId(), r1);

        RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
        r2.setGeneration(1);
        r2.setQualityGrade("GRADE_A");
        r2.setCreatedAt("2026-09-20 16:15");
        remnantPool.put(r2.getId(), r2);

        RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
        r3.setGeneration(1);
        r3.setQualityGrade("GRADE_DEFECT");
        r3.setCreatedAt("2026-09-20 17:40");
        List<Defect> defs = new ArrayList<>();
        defs.add(new Defect(1, 200, 1500, 150, 600, 30, "HOLE", "破洞残留", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "料头内局部破洞"));
        r3.setDefects(defs);
        remnantPool.put(r3.getId(), r3);

        // 母卷 ROLL-2026-0921 切下的料头
        RemnantStock r4 = new RemnantStock("REM-202609-004", 1800, 1200, "库位 C-01-05", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉完好短料");
        r4.setGeneration(1);
        r4.setQualityGrade("GRADE_A");
        r4.setCreatedAt("2026-09-21 09:00");
        remnantPool.put(r4.getId(), r4);

        RemnantStock r5 = new RemnantStock("REM-202609-005", 400, 3000, "库位 C-02-02", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉分条长料头");
        r5.setGeneration(1);
        r5.setQualityGrade("GRADE_A");
        r5.setCreatedAt("2026-09-21 09:20");
        remnantPool.put(r5.getId(), r5);
    }

    public List<MotherRollInfo> getMotherRolls() {
        List<MotherRollInfo> list = new ArrayList<>();
        for (MotherRollInfo info : motherRolls.values()) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(info.getRollId());
            double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(totalArea);
            list.add(info);
        }
        return list;
    }

    public MotherRollInfo getMotherRoll(String rollId) {
        if (rollId == null) return null;
        MotherRollInfo info = motherRolls.get(rollId);
        if (info != null) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(rollId);
            info.setRemnantCount(rollRemnants.size());
            info.setRemnantTotalArea(rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum());
        }
        return info;
    }

    public MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) {
        if (roll == null || roll.getRollId() == null || roll.getRollId().trim().isEmpty()) {
            throw new IllegalArgumentException("母卷编号 (rollId) 不能为空！");
        }
        MotherRollInfo existing = motherRolls.get(roll.getRollId());
        if (existing != null) {
            existing.setRollModel(roll.getRollModel());
            existing.setBatchNo(roll.getBatchNo());
            existing.setSupplier(roll.getSupplier());
            existing.setMaterialName(roll.getMaterialName());
            existing.setColor(roll.getColor());
            existing.setGrammage(roll.getGrammage());
            existing.setComposition(roll.getComposition());
            existing.setWidth(roll.getWidth());
            existing.setRawWidth(roll.getRawWidth());
            existing.setTotalLength(roll.getTotalLength());
            existing.setCurrentRemainingLength(roll.getCurrentRemainingLength());
            existing.setStorageLocation(roll.getStorageLocation());
            existing.setInspectionStatus(roll.getInspectionStatus());
            if (roll.getDefects() != null && !roll.getDefects().isEmpty()) {
                existing.setDefects(roll.getDefects());
            }
            return existing;
        } else {
            if (roll.getCreatedAt() == null) {
                roll.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            }
            if (roll.getCurrentRemainingLength() <= 0) {
                roll.setCurrentRemainingLength(roll.getTotalLength());
            }
            motherRolls.put(roll.getRollId(), roll);
            return roll;
        }
    }

    public Defect addDefectToRoll(String rollId, Defect defect) {
        MotherRollInfo roll = getMotherRoll(rollId);
        if (roll == null) {
            throw new IllegalArgumentException("未找到母卷: " + rollId);
        }
        if (defect.getId() == 0) {
            defect.setId(defectSeq.incrementAndGet());
        }
        roll.getDefects().add(defect);
        return defect;
    }

    public boolean scrapRemnant(String id, String reason) {
        RemnantStock item = remnantPool.get(id);
        if (item == null) return false;
        item.setStatus("SCRAPPED");
        item.setDefectDesc((item.getDefectDesc() != null ? item.getDefectDesc() + " | " : "") + "已报废: " + reason);
        return true;
    }

    public List<RemnantStock> getAvailableRemnants() {
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public List<RemnantStock> getRemnantsByRollId(String rollId) {
        if (rollId == null || rollId.trim().isEmpty() || "ALL".equalsIgnoreCase(rollId)) {
            return getAvailableRemnants();
        }
        String cleanRollId = rollId.trim();
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> cleanRollId.equalsIgnoreCase(r.getSourceRollId()))
                .sorted(Comparator.comparing(RemnantStock::getId))
                .collect(Collectors.toList());
    }

    public List<RemnantStock> getAllRemnants() {
        return new ArrayList<>(remnantPool.values());
    }

    public RemnantStock scanOrGetById(String id) {
        if (id == null) return null;
        String cleanId = id.trim();
        RemnantStock direct = remnantPool.get(cleanId);
        if (direct != null && "AVAILABLE".equalsIgnoreCase(direct.getStatus())) {
            return direct;
        }
        for (RemnantStock r : remnantPool.values()) {
            if ("AVAILABLE".equalsIgnoreCase(r.getStatus()) &&
                    (r.getId().equalsIgnoreCase(cleanId) || r.getId().endsWith(cleanId))) {
                return r;
            }
        }
        return null;
    }

    public List<RemnantStock> matchRemnants(String rollId, double pieceW, double pieceL, boolean allowRotation) {
        List<RemnantStock> candidates = getRemnantsByRollId(rollId);
        List<RemnantStock> matched = new ArrayList<>();
        for (RemnantStock r : candidates) {
            boolean fitsNormal = (r.getWidth() >= pieceW && r.getLength() >= pieceL);
            boolean fitsRotated = allowRotation && (r.getWidth() >= pieceL && r.getLength() >= pieceW);
            if (fitsNormal || fitsRotated) {
                matched.add(r);
            }
        }
        matched.sort(Comparator.comparingDouble(RemnantStock::getArea));
        return matched;
    }

    public RemnantStock registerRemnant(RemnantStock item) {
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            item.setId("REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet()));
        }
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        remnantPool.put(item.getId(), item);
        return item;
    }

    public RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String newId = "REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet());
        if (parentRemnantId != null && !parentRemnantId.isEmpty()) {
            newId = parentRemnantId + "-SUB" + String.format("%02d", (int)(Math.random() * 90 + 10));
        }
        RemnantStock rs = new RemnantStock(newId, w, l, "现场料头架", rollId, "AVAILABLE", rollId, hasDefect, desc);
        rs.setParentRemnantId(parentRemnantId);
        rs.setGeneration(parentRemnantId != null ? 2 : 1);
        rs.setQualityGrade(hasDefect ? "GRADE_DEFECT" : "GRADE_A");
        rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        remnantPool.put(rs.getId(), rs);
        return rs;
    }

    public boolean consumeRemnant(String id) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus("CONSUMED");
            item.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            return true;
        }
        return false;
    }

    public boolean updateStatus(String id, String status) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus(status);
            return true;
        }
        return false;
    }
}
