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

@Service
public class RemnantService {

    private final Map<String, RemnantStock> remnantPool = new ConcurrentHashMap<>();
    private final Map<String, MotherRollInfo> motherRolls = new LinkedHashMap<>();
    private final AtomicInteger remnantSeq = new AtomicInteger(10);

    public RemnantService() {
        initMotherRolls();
        initSampleRemnants();
    }

    private void initMotherRolls() {
        motherRolls.put("ROLL-2026-0920", new MotherRollInfo("ROLL-2026-0920", "TC涤棉-B2026", 2000, 60000, 0, 0));
        motherRolls.put("ROLL-2026-0921", new MotherRollInfo("ROLL-2026-0921", "纯棉斜纹-C2026", 1800, 50000, 0, 0));
        motherRolls.put("ROLL-2026-0922", new MotherRollInfo("ROLL-2026-0922", "弹力牛津-O2026", 2200, 80000, 0, 0));
    }

    private void initSampleRemnants() {
        // 母卷 ROLL-2026-0920 切下的料头
        RemnantStock r1 = new RemnantStock("REM-202609-001", 2000, 1600, "库位 A-01-03", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "完好可用短料 (Word 表1算例)");
        r1.setCreatedAt("2026-09-20 14:30");
        remnantPool.put(r1.getId(), r1);

        RemnantStock r2 = new RemnantStock("REM-202609-002", 500, 4000, "库位 B-02-08", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", false, "右侧纵切可用长料头");
        r2.setCreatedAt("2026-09-20 16:15");
        remnantPool.put(r2.getId(), r2);

        RemnantStock r3 = new RemnantStock("REM-202609-003", 500, 4000, "库位 D-DEF-01", "TC涤棉-B2026",
                "AVAILABLE", "ROLL-2026-0920", true, "左侧带疵料头 (内部含瑕疵需避让)");
        r3.setCreatedAt("2026-09-20 17:40");
        List<Defect> defs = new ArrayList<>();
        defs.add(new Defect(1, 200, 1500, 150, 600, 30));
        r3.setDefects(defs);
        remnantPool.put(r3.getId(), r3);

        // 母卷 ROLL-2026-0921 切下的料头
        RemnantStock r4 = new RemnantStock("REM-202609-004", 1800, 1200, "库位 C-01-05", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉完好短料");
        r4.setCreatedAt("2026-09-21 09:00");
        remnantPool.put(r4.getId(), r4);

        RemnantStock r5 = new RemnantStock("REM-202609-005", 400, 3000, "库位 C-02-02", "纯棉斜纹-C2026",
                "AVAILABLE", "ROLL-2026-0921", false, "纯棉分条长料头");
        r5.setCreatedAt("2026-09-21 09:20");
        remnantPool.put(r5.getId(), r5);
    }

    public List<MotherRollInfo> getMotherRolls() {
        List<MotherRollInfo> list = new ArrayList<>();
        for (MotherRollInfo info : motherRolls.values()) {
            List<RemnantStock> rollRemnants = getRemnantsByRollId(info.getRollId());
            double totalArea = rollRemnants.stream().mapToDouble(RemnantStock::getArea).sum();
            list.add(new MotherRollInfo(info.getRollId(), info.getRollModel(), info.getWidth(),
                    info.getTotalLength(), rollRemnants.size(), totalArea));
        }
        return list;
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
        String cleanId = id.trim().toUpperCase();
        return remnantPool.get(cleanId);
    }

    public RemnantStock registerRemnant(RemnantStock item) {
        if (item.getId() == null || item.getId().trim().isEmpty()) {
            item.setId(String.format("REM-202609-%03d", remnantSeq.incrementAndGet()));
        }
        if (item.getStatus() == null) {
            item.setStatus("AVAILABLE");
        }
        if (item.getCreatedAt() == null) {
            item.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        }
        remnantPool.put(item.getId(), item);
        return item;
    }

    public RemnantStock autoRegisterCutRemnant(String sourceRollId, String parentRemnantId,
                                              double width, double length,
                                              boolean hasDefect, String defectDesc) {
        String newId = String.format("REM-202609-%03d", remnantSeq.incrementAndGet());
        String batch = "现场裁切批次";
        MotherRollInfo rollInfo = motherRolls.get(sourceRollId);
        if (rollInfo != null) {
            batch = rollInfo.getRollModel();
        }
        String location = "库位 " + (hasDefect ? "DEF-" : "REC-") + (remnantSeq.get() % 20 + 1);
        RemnantStock rs = new RemnantStock(newId, width, length, location, batch, "AVAILABLE",
                sourceRollId, hasDefect, defectDesc);
        rs.setParentRemnantId(parentRemnantId);
        rs.setCreatedAt(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")));
        remnantPool.put(newId, rs);
        return rs;
    }

    public void consumeRemnant(String id) {
        if (id == null) return;
        RemnantStock r = remnantPool.get(id.trim().toUpperCase());
        if (r != null) {
            r.setStatus("CONSUMED");
        }
    }

    public List<RemnantStock> matchRemnants(double targetW, double targetL, boolean allowRotation) {
        return matchRemnants(null, targetW, targetL, allowRotation);
    }

    /**
     * 根据订单成品长宽智能逆向匹配合适的可用料头 (优先推荐属于同一母卷或同材质、且面积最接近的可用料头)
     */
    public List<RemnantStock> matchRemnants(String rollId, double targetW, double targetL, boolean allowRotation) {
        return remnantPool.values().stream()
                .filter(r -> "AVAILABLE".equalsIgnoreCase(r.getStatus()))
                .filter(r -> {
                    if (rollId != null && !rollId.trim().isEmpty() && !"ALL".equalsIgnoreCase(rollId)) {
                        return rollId.equalsIgnoreCase(r.getSourceRollId());
                    }
                    return true;
                })
                .filter(r -> {
                    boolean direct = (r.getWidth() >= targetW && r.getLength() >= targetL);
                    boolean rotated = allowRotation && (r.getWidth() >= targetL && r.getLength() >= targetW);
                    return direct || rotated;
                })
                .sorted(Comparator.comparingDouble(RemnantStock::getArea)) // 优先推荐面积最贴近的，避免浪费大料
                .collect(Collectors.toList());
    }

    public void updateStatus(String id, String status) {
        RemnantStock r = remnantPool.get(id);
        if (r != null) {
            r.setStatus(status);
        }
    }
}
