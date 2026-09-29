package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.Defect;
import com.example.cutdemotwo.model.MotherRollInfo;
import com.example.cutdemotwo.model.RemnantStock;
import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;
import com.example.cutdemotwo.model.CutReport;
import com.example.cutdemotwo.model.RemnantPiece;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
    private final Map<String, Map<String, Object>> receipts = new LinkedHashMap<>();
    private final ObjectMapper json = new ObjectMapper();
    private final Path stateFile;
    @Value("${cutdemo.measurement.tolerance-mm:5}")
    private double measurementToleranceMm = 5;

    public RemnantService(@Value("${cutdemo.state.path:data/cutdemo-state.json}") String statePath) {
        stateFile = Path.of(statePath);
        if (Files.exists(stateFile)) {
            try {
                Snapshot snapshot = json.readValue(stateFile.toFile(), Snapshot.class);
                for (MotherRollInfo roll : snapshot.rolls()) motherRolls.put(roll.getRollId(), roll);
                for (RemnantStock item : snapshot.remnants()) remnantPool.put(item.getId(), item);
                receipts.putAll(snapshot.receipts());
                remnantSeq.set(snapshot.remnantSeq());
                defectSeq.set(snapshot.defectSeq());
                return;
            } catch (Exception e) {
                throw new IllegalStateException("库存文件读取失败，请检查后恢复: " + stateFile, e);
            }
        }
        initMotherRolls();
        initSampleRemnants();
    }

    private record Snapshot(List<MotherRollInfo> rolls, List<RemnantStock> remnants,
                            Map<String, Map<String, Object>> receipts, int remnantSeq, int defectSeq) {}

    private void save() {
        try {
            Path parent = stateFile.toAbsolutePath().getParent();
            Files.createDirectories(parent);
            Path temp = Files.createTempFile(parent, "cutdemo-", ".json");
            try {
                json.writeValue(temp.toFile(), new Snapshot(new ArrayList<>(motherRolls.values()),
                        new ArrayList<>(remnantPool.values()), receipts, remnantSeq.get(), defectSeq.get()));
                try {
                    Files.move(temp, stateFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                    Files.move(temp, stateFile, StandardCopyOption.REPLACE_EXISTING);
                }
            } finally {
                Files.deleteIfExists(temp);
            }
        } catch (IOException e) {
            throw new IllegalStateException("库存保存失败: " + stateFile, e);
        }
    }

    public synchronized Map<String, Object> getReceipt(String planId) { return receipts.get(planId); }

    public synchronized Map<String, Object> confirm(SolveRequest request, SolveResponse plan, CutReport report) {
        Map<String, Object> old = receipts.get(report.planId());
        if (old != null) return old;
        boolean remnantFeed = "remnant".equalsIgnoreCase(request.getFeedPortType());
        MotherRollInfo roll = motherRolls.get(request.getRollId());
        RemnantStock parent = remnantFeed ? remnantPool.get(request.getSourceRemnantId()) : null;
        if (remnantFeed && (parent == null || !"AVAILABLE".equals(parent.getStatus()))) {
            throw new IllegalArgumentException("原料头已不可用，请重新装载");
        }
        if (!remnantFeed && roll == null) throw new IllegalArgumentException("母卷不存在，请先从母卷档案装载");
        if (remnantFeed ? (Math.abs(parent.getWidth() - request.getRollW()) > 0.001 ||
                Math.abs(parent.getLength() - request.getRollL()) > 0.001) :
                Math.abs(roll.getWidth() - request.getRollW()) > 0.001) {
            throw new IllegalArgumentException("母料尺寸与库存档案不一致，请重新装载");
        }
        if (report.finishedPieceCount() != plan.getPieces().size() || report.finishedPieceCount() <= 0) {
            throw new IllegalArgumentException("本版请完成方案中的全部裁片后再确认实切");
        }
        double len = report.actualCutLen();
        if (remnantFeed ? len != 0 : (!Double.isFinite(len) || len <= 0 || len > request.getRollL() || len > roll.getCurrentRemainingLength())) {
            throw new IllegalArgumentException("实切长度无效或超过母卷剩余长度");
        }
        if (!remnantFeed) {
            double start = request.getWindowStartY();
            if (!Double.isFinite(start) || start < 0 || start + len > roll.getTotalLength()) {
                throw new IllegalArgumentException("红框实切区间超出母卷范围");
            }
            for (Map<String, Object> receipt : receipts.values()) {
                if (!request.getRollId().equals(receipt.get("rollId")) || !"roll".equals(receipt.get("feedPortType"))) continue;
                double oldStart = ((Number) receipt.get("windowStartY")).doubleValue();
                double oldEnd = oldStart + ((Number) receipt.get("actualCutLen")).doubleValue();
                if (start < oldEnd && start + len > oldStart) throw new IllegalArgumentException("红框区域已实切确认，请移动到未切区间");
            }
        }
        double maxPieceY = plan.getPieces().stream().mapToDouble(p -> p.getY() + p.getL()).max().orElse(0);
        if (!remnantFeed && len + 0.001 < maxPieceY) throw new IllegalArgumentException("实切长度短于已完成裁片的末端");
        List<RemnantPiece> actual = report.actualRemnants() == null ? List.of() : report.actualRemnants();
        double remArea = 0;
        Set<String> seen = new HashSet<>();
        List<double[]> recoveredBounds = new ArrayList<>();
        double sourceLength = remnantFeed ? parent.getLength() : len;
        double tolerance = Double.isFinite(measurementToleranceMm) ? Math.max(0, measurementToleranceMm) : 0;
        for (RemnantPiece item : actual) {
            if (item == null || item.getId() == null || !seen.add(item.getId())) throw new IllegalArgumentException("料头编号重复或为空");
            RemnantPiece proposed = plan.getRemnants().stream().filter(p -> p.getId().equals(item.getId())).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("料头不属于当前排料方案: " + item.getId()));
            if (!Double.isFinite(item.getW()) || !Double.isFinite(item.getL()) || item.getW() <= 0 || item.getL() <= 0 ||
                    item.getW() > proposed.getW() + tolerance + 0.001 || item.getL() > proposed.getL() + tolerance + 0.001 ||
                    (proposed.isHasDefect() && !item.isHasDefect()) ||
                    proposed.getX() < 0 || proposed.getY() < 0 ||
                    proposed.getX() + item.getW() > request.getRollW() + 0.001 ||
                    proposed.getY() + item.getL() > sourceLength + 0.001) {
                throw new IllegalArgumentException("实测料头超出排料范围: " + item.getId());
            }
            boolean intersectsPiece = plan.getPieces().stream().anyMatch(piece -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    piece.getX(), piece.getY(), piece.getW(), piece.getL()));
            boolean intersectsRemnant = recoveredBounds.stream().anyMatch(bounds -> overlaps(
                    proposed.getX(), proposed.getY(), item.getW(), item.getL(),
                    bounds[0], bounds[1], bounds[2], bounds[3]));
            if (intersectsPiece || intersectsRemnant) {
                throw new IllegalArgumentException("实测料头与成品或其他料头重叠: " + item.getId());
            }
            recoveredBounds.add(new double[]{proposed.getX(), proposed.getY(), item.getW(), item.getL()});
            remArea += item.getW() * item.getL() / 1_000_000.0;
        }
        double sourceArea = (remnantFeed ? parent.getArea() : request.getRollW() * len / 1_000_000.0);
        if (plan.getPieceArea() + remArea > sourceArea + 0.001) throw new IllegalArgumentException("裁片与料头面积超过实切用料面积");

        int previousSeq = remnantSeq.get();
        double previousRemaining = roll == null ? 0 : roll.getCurrentRemainingLength();
        double previousUsed = roll == null ? 0 : roll.getUsedLength();
        String previousParentStatus = parent == null ? null : parent.getStatus();
        String previousParentConsumedAt = parent == null ? null : parent.getConsumedAt();
        if (remnantFeed) {
            parent.setStatus("CONSUMED");
            parent.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        } else {
            roll.setCurrentRemainingLength(roll.getCurrentRemainingLength() - len);
            roll.setUsedLength(roll.getUsedLength() + len);
        }
        List<RemnantStock> children = new ArrayList<>();
        for (RemnantPiece item : actual) {
            if (item.getW() < 200 || item.getL() < 300) continue;
            RemnantPiece proposed = plan.getRemnants().stream().filter(p -> p.getId().equals(item.getId())).findFirst().orElseThrow();
            List<Defect> childDefects = new ArrayList<>();
            for (Defect defect : request.getDefects()) {
                double left = Math.max(proposed.getX(), defect.getSafeX());
                double top = Math.max(proposed.getY(), defect.getSafeY());
                double right = Math.min(proposed.getX() + item.getW(), defect.getSafeX() + defect.getSafeW());
                double bottom = Math.min(proposed.getY() + item.getL(), defect.getSafeY() + defect.getSafeH());
                if (right > left && bottom > top) {
                    childDefects.add(new Defect(defect.getId(), left - proposed.getX(), top - proposed.getY(),
                            right - left, bottom - top, 0, defect.getDefectType(), defect.getTypeName(),
                            defect.getSeverity(), defect.getPoints(), defect.getDetectionSource(),
                            defect.getAvoidanceStrategy(), defect.getDescription()));
                }
            }
            String id = "REM-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM")) + "-" +
                    String.format("%03d", remnantSeq.incrementAndGet());
            RemnantStock child = new RemnantStock(id, item.getW(), item.getL(),
                    report.location() == null || report.location().isBlank() ? "现场料头架" : report.location(),
                    request.getRollModel(), item.isHasDefect() && childDefects.isEmpty() ? "QUARANTINED" : "AVAILABLE",
                    request.getRollId(), item.isHasDefect() || !childDefects.isEmpty(), item.getStatus());
            child.setDefects(childDefects);
            child.setParentRemnantId(remnantFeed ? parent.getId() : null);
            child.setGeneration(remnantFeed ? parent.getGeneration() + 1 : 1);
            child.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            remnantPool.put(id, child);
            children.add(child);
        }
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("planId", report.planId());
        receipt.put("rollId", request.getRollId());
        receipt.put("windowStartY", request.getWindowStartY());
        receipt.put("feedPortType", remnantFeed ? "remnant" : "roll");
        receipt.put("actualCutLen", len);
        receipt.put("remainingLength", roll == null ? null : roll.getCurrentRemainingLength());
        receipt.put("finishedPieceCount", report.finishedPieceCount());
        receipt.put("pieceArea", plan.getPieceArea());
        receipt.put("remArea", remArea);
        receipt.put("utilization", sourceArea == 0 ? 0 : plan.getPieceArea() / sourceArea * 100);
        receipt.put("derivedRemnants", children);
        receipt.put("confirmedAt", LocalDateTime.now().toString());
        receipts.put(report.planId(), receipt);
        try {
            save();
        } catch (RuntimeException error) {
            receipts.remove(report.planId());
            for (RemnantStock child : children) remnantPool.remove(child.getId());
            remnantSeq.set(previousSeq);
            if (roll != null) {
                roll.setCurrentRemainingLength(previousRemaining);
                roll.setUsedLength(previousUsed);
            }
            if (parent != null) {
                parent.setStatus(previousParentStatus);
                parent.setConsumedAt(previousParentConsumedAt);
            }
            throw error;
        }
        return receipt;
    }

    public synchronized boolean resetRoll(String rollId) {
        MotherRollInfo roll = motherRolls.get(rollId);
        if (roll == null) return false;
        roll.setCurrentRemainingLength(roll.getTotalLength());
        roll.setUsedLength(0.0);
        receipts.entrySet().removeIf(e -> rollId.equals(e.getValue().get("rollId")));
        remnantPool.entrySet().removeIf(e -> rollId.equals(e.getValue().getSourceRollId()));
        if ("ROLL-2026-0920".equals(rollId)) {
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
        }
        save();
        return true;
    }

    private static boolean overlaps(double x, double y, double w, double l,
                                    double otherX, double otherY, double otherW, double otherL) {
        return x < otherX + otherW && x + w > otherX && y < otherY + otherL && y + l > otherY;
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

        MotherRollInfo curtain2d = new MotherRollInfo("ROLL-DEMO-2D", "窗帘样布-2D", "DEMO-2D",
                "演示样布", "窗帘矩形样布", "米白色", 220, "演示面料", 2000, 30000, "演示库位");
        curtain2d.setInspectionStatus("PASSED");
        curtain2d.setDefects(new ArrayList<>(List.of(new Defect(21, 200, 1500, 150, 600, 50,
                "HOLE", "带疵改宽区域", 4, 4, "MANUAL_INSPECT", "MUST_AVOID", "二维带疵点演示"))));
        motherRolls.put(curtain2d.getRollId(), curtain2d);

        // 真实布艺母卷 1: ROLL-REAL-893292 (2#A3A-Cream · 100m 卷装)
        MotherRollInfo real893292 = new MotherRollInfo("ROLL-REAL-893292", "2#A3A-Cream", "BAT-REAL-893292",
                "真实布艺供应链 (893292)", "窗帘高密提花雪尼尔 (2#A3A-Cream)", "米色 (Cream)",
                380.0, "100%涤纶高密遮光", 2800, 100000, "布艺成品库 A-08-01");
        real893292.setCurrentRemainingLength(100000);
        real893292.setUsedLength(0);
        real893292.setInspectionStatus("PASSED");
        real893292.setInspector("AI视觉验布机-03 (已复核)");
        real893292.setInspectionDate("2026-09-28");
        List<Defect> defs893292 = new ArrayList<>(List.of(
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
        ));
        real893292.setDefects(defs893292);
        motherRolls.put(real893292.getRollId(), real893292);

        // 真实布艺母卷 2: ROLL-REAL-893153 (2#1A-Off White · 100m 卷装)
        MotherRollInfo real893153 = new MotherRollInfo("ROLL-REAL-893153", "2#1A-Off White", "BAT-REAL-893153",
                "真实布艺供应链 (893153)", "工程高密垂感遮光布 (2#1A-Off White)", "米白 (Off White)",
                360.0, "100%高支密涤纶", 2800, 100000, "布艺成品库 A-08-02");
        real893153.setCurrentRemainingLength(100000);
        real893153.setUsedLength(0);
        real893153.setInspectionStatus("PASSED");
        real893153.setInspector("AI视觉验布机-02 (已复核)");
        real893153.setInspectionDate("2026-09-28");
        List<Defect> defs893153 = new ArrayList<>(List.of(
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
        ));
        real893153.setDefects(defs893153);
        motherRolls.put(real893153.getRollId(), real893153);
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

    public synchronized MotherRollInfo saveOrUpdateMotherRoll(MotherRollInfo roll) {
        if (roll == null || roll.getRollId() == null || roll.getRollId().trim().isEmpty()) {
            throw new IllegalArgumentException("母卷编号 (rollId) 不能为空！");
        }
        if (!Double.isFinite(roll.getWidth()) || !Double.isFinite(roll.getTotalLength()) ||
                roll.getWidth() <= 0 || roll.getTotalLength() <= 0) {
            throw new IllegalArgumentException("母卷幅宽和总长度必须大于零");
        }
        MotherRollInfo existing = motherRolls.get(roll.getRollId());
        if (existing != null) {
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
            existing.setWidth(roll.getWidth());
            existing.setRawWidth(roll.getRawWidth());
            existing.setTotalLength(roll.getTotalLength());
            existing.setStorageLocation(roll.getStorageLocation());
            existing.setInspectionStatus(roll.getInspectionStatus());
            if (roll.getDefects() != null && !roll.getDefects().isEmpty()) {
                existing.setDefects(roll.getDefects());
            }
            save();
            return existing;
        } else {
            if (roll.getCreatedAt() == null) {
                roll.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
            }
            if (roll.getCurrentRemainingLength() <= 0) {
                roll.setCurrentRemainingLength(roll.getTotalLength());
            }
            motherRolls.put(roll.getRollId(), roll);
            save();
            return roll;
        }
    }

    public synchronized Defect addDefectToRoll(String rollId, Defect defect) {
        MotherRollInfo roll = getMotherRoll(rollId);
        if (roll == null) {
            throw new IllegalArgumentException("未找到母卷: " + rollId);
        }
        if (defect == null || !Double.isFinite(defect.getX()) || !Double.isFinite(defect.getY()) ||
                !Double.isFinite(defect.getW()) || !Double.isFinite(defect.getH()) ||
                defect.getX() < 0 || defect.getY() < 0 || defect.getW() <= 0 || defect.getH() <= 0 ||
                defect.getX() + defect.getW() > roll.getWidth() ||
                defect.getY() + defect.getH() > roll.getTotalLength()) {
            throw new IllegalArgumentException("疵点坐标或尺寸超出母卷范围");
        }
        if (defect.getId() == 0) {
            defect.setId(defectSeq.incrementAndGet());
        }
        roll.getDefects().add(defect);
        save();
        return defect;
    }

    public synchronized boolean scrapRemnant(String id, String reason) {
        RemnantStock item = remnantPool.get(id);
        if (item == null) return false;
        item.setStatus("SCRAPPED");
        item.setDefectDesc((item.getDefectDesc() != null ? item.getDefectDesc() + " | " : "") + "已报废: " + reason);
        save();
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
            if (r.isHasDefect()) continue;
            boolean fitsNormal = (r.getWidth() >= pieceW && r.getLength() >= pieceL);
            boolean fitsRotated = allowRotation && (r.getWidth() >= pieceL && r.getLength() >= pieceW);
            if (fitsNormal || fitsRotated) {
                matched.add(r);
            }
        }
        matched.sort(Comparator.comparingDouble(RemnantStock::getArea));
        return matched;
    }

    public synchronized RemnantStock registerRemnant(RemnantStock item) {
        if (item == null || !Double.isFinite(item.getWidth()) || !Double.isFinite(item.getLength()) ||
                item.getWidth() <= 0 || item.getLength() <= 0) throw new IllegalArgumentException("料头宽长必须大于零");
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
            item.setId("REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet()));
        }
        if (remnantPool.containsKey(item.getId())) throw new IllegalArgumentException("料头编号已存在: " + item.getId());
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        remnantPool.put(item.getId(), item);
        save();
        return item;
    }

    public synchronized RemnantStock autoRegisterCutRemnant(String rollId, String parentRemnantId, double w, double l, boolean hasDefect, String desc) {
        String dateStr = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMM"));
        String newId = "REM-" + dateStr + "-" + String.format("%03d", remnantSeq.incrementAndGet());
        if (parentRemnantId != null && !parentRemnantId.isEmpty()) {
            newId = parentRemnantId + "-SUB" + remnantSeq.get();
        }
        RemnantStock rs = new RemnantStock(newId, w, l, "现场料头架", rollId, "AVAILABLE", rollId, hasDefect, desc);
        rs.setParentRemnantId(parentRemnantId);
        rs.setGeneration(parentRemnantId != null ? 2 : 1);
        rs.setQualityGrade(hasDefect ? "GRADE_DEFECT" : "GRADE_A");
        rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        remnantPool.put(rs.getId(), rs);
        save();
        return rs;
    }

    public synchronized boolean consumeRemnant(String id) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus("CONSUMED");
            item.setConsumedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
            save();
            return true;
        }
        return false;
    }

    public synchronized boolean updateStatus(String id, String status) {
        if (id == null) return false;
        RemnantStock item = remnantPool.get(id);
        if (item != null) {
            item.setStatus(status);
            save();
            return true;
        }
        return false;
    }
}
