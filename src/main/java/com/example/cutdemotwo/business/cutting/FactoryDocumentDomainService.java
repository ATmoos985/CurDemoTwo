package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.model.InventoryCount;
import com.example.cutdemotwo.business.model.InventoryReceiptDocument;
import com.example.cutdemotwo.business.model.InventoryTransfer;
import com.example.cutdemotwo.business.model.MaterialIssueDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.QualityReleaseDocument;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.InventoryConflictException;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * 工厂仓储与质量单据垂直领域服务：
 * 仅依赖 InventoryStateKernel，负责移库单、盘点单、隔离料头放行单、采购批量入库单与车间领退料单。
 */
final class FactoryDocumentDomainService {

    private final InventoryStateKernel kernel;

    FactoryDocumentDomainService(InventoryStateKernel kernel) {
        this.kernel = kernel;
    }

    record ReceiptRollLineInput(
            String id,
            String materialModel,
            String materialType,
            String color,
            String batchNo,
            double widthMm,
            double totalLengthMm,
            Double grammage,
            Double shrinkageRate,
            String storageLocation,
            String inspectionStatus,
            String inspector
    ) {}

    // ==================== 移库单 ====================

    Map<String, Object> transferOptions() {
        return kernel.read(() -> {
            var materials = new ArrayList<Map<String, Object>>();
            for (var roll : kernel.motherRolls.values())
                materials.add(transferOption("roll", roll.getRollId(), roll.getStorageLocation(), roll.getRollModel()));
            for (var remnant : kernel.remnantPool.values())
                materials.add(transferOption("remnant", remnant.getId(), remnant.getLocation(), remnant.getMaterialBatch()));
            materials.sort(Comparator.comparing(row -> row.get("type") + "/" + row.get("id")));
            return Map.of("revision", kernel.revision, "materials", materials);
        });
    }

    private Map<String, Object> transferOption(String type, String id, String location, String model) {
        String reason = transferBlock(type, id);
        return Map.of("type", type, "id", id, "location", Objects.toString(location, ""), "materialModel", Objects.toString(model, ""),
                "allowed", reason.isEmpty(), "reason", reason);
    }

    private String transferBlock(String type, String id) {
        if ("roll".equals(type)) {
            var roll = kernel.motherRolls.get(id);
            if (roll == null) return "母卷不存在";
            if ("SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) return "母卷已报废";
            if (roll.getCurrentRemainingLength() <= 0) return "母卷已用尽";
        } else if ("remnant".equals(type)) {
            var remnant = kernel.remnantPool.get(id);
            if (remnant == null) return "料头不存在";
            if (!Set.of("AVAILABLE", "QUARANTINED").contains(remnant.getStatus())) return "料头已不在库";
        } else return "材料类型必须为 roll 或 remnant";
        if (kernel.executions.values().stream().anyMatch(e -> e.materialType().equals(type) && e.materialId().equals(id) && e.reserves(kernel.currentOperationTime())))
            return "材料已被执行单预约或正在加工";
        if (kernel.isMaterialReservedByScheme(type, id, null))
            return "材料已被活跃排程方案预约或下发";
        return "";
    }

    List<InventoryTransfer> inventoryTransfers() {
        return kernel.read(() -> kernel.transfers.values().stream()
                .sorted(Comparator.comparingLong(InventoryTransfer::inventoryRevision).reversed()).toList());
    }

    InventoryTransfer transferInventory(String key, InventoryTransfer.Command command) {
        if (key == null || key.isBlank() || key.length() > 128 || command == null || command.expectedRevision() < 0
                || command.destination() == null || command.destination().isBlank() || command.destination().length() > 120
                || command.reason() == null || command.reason().isBlank() || command.reason().length() > 500
                || command.operator() == null || command.operator().isBlank() || command.operator().length() > 100
                || command.materials() == null || command.materials().isEmpty() || command.materials().size() > 100)
            throw new IllegalArgumentException("请填写有效库存版本、目标库位、移库原因、经办人和 1–100 项材料");
        String documentId = UUID.randomUUID().toString();
        return kernel.mutate("INVENTORY_TRANSFER", documentId, "DECLARED:" + command.operator(), () -> {
            for (var previous : kernel.transfers.values()) {
                if (previous.idempotencyKey().equals(key)) {
                    if (!previous.command().equals(command)) throw new InventoryConflictException("同一幂等键已用于其他移库内容");
                    return previous;
                }
            }
            if (command.expectedRevision() != kernel.revision) throw new InventoryConflictException("库存版本已变化，请刷新材料后重新核对移库单");
            var identities = new HashSet<String>();
            var lines = new ArrayList<InventoryTransfer.Line>();
            for (var material : command.materials()) {
                if (material == null || material.id() == null || material.id().isBlank() || material.type() == null)
                    throw new IllegalArgumentException("材料类型和编号不能为空");
                if (!identities.add(material.type() + "/" + material.id())) throw new IllegalArgumentException("同一材料不能重复移库");
                String blocked = transferBlock(material.type(), material.id());
                if (!blocked.isEmpty()) throw new InventoryConflictException(material.id() + "：" + blocked);
                String old = "roll".equals(material.type()) ? kernel.motherRolls.get(material.id()).getStorageLocation() : kernel.remnantPool.get(material.id()).getLocation();
                if (command.destination().equals(Objects.toString(old, ""))) throw new IllegalArgumentException("目标库位与当前库位相同：" + material.id());
                lines.add(new InventoryTransfer.Line(material.type(), material.id(), Objects.toString(old, ""), command.destination()));
            }
            for (var line : lines) {
                if ("roll".equals(line.type())) kernel.motherRolls.get(line.id()).setStorageLocation(line.toLocation());
                else kernel.remnantPool.get(line.id()).setLocation(line.toLocation());
            }
            var document = new InventoryTransfer(documentId, key, command, kernel.currentOperationTime(), kernel.revision + 1, lines);
            kernel.transfers.put(document.id(), document);
            return document;
        });
    }

    // ==================== 盘点单 ====================

    List<InventoryCount> inventoryCounts() {
        return kernel.read(() -> kernel.counts.values().stream()
                .sorted(Comparator.comparingLong(InventoryCount::inventoryRevision).reversed()).toList());
    }

    private String countBlock(String type, String id) {
        if ("roll".equals(type)) {
            var r = kernel.motherRolls.get(id);
            if (r == null) return "母卷不存在";
            if ("SCRAPPED".equalsIgnoreCase(r.getInspectionStatus())) return "母卷已报废，不能盘点";
        } else if ("remnant".equals(type)) {
            var r = kernel.remnantPool.get(id);
            if (r == null) return "料头不存在";
            if (!Set.of("AVAILABLE", "QUARANTINED", "LOST").contains(r.getStatus())) return "仅在库、隔离或盘亏料头可盘点";
        } else return "材料类型必须为 roll 或 remnant";
        if (kernel.executions.values().stream().anyMatch(e -> e.materialType().equals(type) && e.materialId().equals(id) && e.reserves(kernel.currentOperationTime())))
            return "材料已被执行单预约或正在加工";
        if (kernel.isMaterialReservedByScheme(type, id, null))
            return "材料已被活跃排程方案预约或下发";
        return "";
    }

    Map<String, Object> countOptions() {
        return kernel.read(() -> {
            var materials = new ArrayList<Map<String, Object>>();
            for (var r : kernel.motherRolls.values())
                materials.add(countOption("roll", r.getRollId(), r.getWidth(), r.getCurrentRemainingLength(),
                        r.getInspectionStatus(), r.getStorageLocation(), r.getRollModel()));
            for (var r : kernel.remnantPool.values())
                materials.add(countOption("remnant", r.getId(), r.getWidth(), r.getLength(), r.getStatus(), r.getLocation(), r.getMaterialBatch()));
            materials.sort(Comparator.comparing(row -> row.get("type") + "/" + row.get("id")));
            return Map.of("revision", kernel.revision, "materials", materials);
        });
    }

    private Map<String, Object> countOption(String type, String id, double width, double length, String status, String location, String model) {
        String reason = countBlock(type, id);
        return Map.of("type", type, "id", id, "width", width, "length", length, "status", Objects.toString(status, ""),
                "location", Objects.toString(location, ""), "materialModel", Objects.toString(model, ""), "allowed", reason.isEmpty(), "reason", reason);
    }

    InventoryCount countInventory(String key, InventoryCount.Command command) {
        if (key == null || !key.matches("[A-Za-z0-9._:-]{8,128}") || command == null || command.expectedRevision() < 0
                || command.reason() == null || command.reason().isBlank() || command.reason().length() > 500
                || command.operator() == null || command.operator().isBlank() || command.operator().length() > 100
                || command.materials() == null || command.materials().isEmpty() || command.materials().size() > 100)
            throw new IllegalArgumentException("请填写有效版本、原因、经办人和 1–100 项实测材料");
        String id = UUID.randomUUID().toString();
        return kernel.mutate("INVENTORY_COUNT", id, "DECLARED:" + command.operator(), () -> {
            for (var previous : kernel.counts.values()) {
                if (previous.idempotencyKey().equals(key)) {
                    if (!previous.command().equals(command)) throw new InventoryConflictException("同一幂等键不能修改盘点内容");
                    return previous;
                }
            }
            return null;
        }, () -> {
            if (command.expectedRevision() != kernel.revision) throw new InventoryConflictException("库存版本已变化，请重新核对账面值与实测值");
            var identities = new HashSet<String>();
            var lines = new ArrayList<InventoryCount.Line>();
            for (var observation : command.materials()) {
                if (observation == null || observation.type() == null || !Set.of("roll", "remnant").contains(observation.type())
                        || observation.id() == null || observation.id().isBlank()
                        || !identities.add(observation.type() + "/" + observation.id())) throw new IllegalArgumentException("材料身份缺失或重复");
                String blocked = countBlock(observation.type(), observation.id());
                if (!blocked.isEmpty()) throw new InventoryConflictException(observation.id() + "：" + blocked);
                double w = observation.width(), l = observation.length();
                if (!Double.isFinite(w) || !Double.isFinite(l) || w <= 0 || w > 1e9 || l < 0 || l > 1e9
                        || (observation.present() ? l <= 0 : l != 0))
                    throw new IllegalArgumentException("实测宽度必须为正数，在场长度为正数，未见实物长度为零；尺寸不超过 10 亿 mm");
                if ("roll".equals(observation.type())) {
                    var r = kernel.motherRolls.get(observation.id());
                    double total = r.getUsedLength() + l;
                    if (w != r.getWidth()) throw new IllegalArgumentException("母卷盘点只校正未切余长，不能更改幅宽");
                    if (!Double.isFinite(total) || total > 1e9 || r.getUsedLength() < 0) throw new IllegalArgumentException("母卷累计长度无效");
                    for (var report : kernel.receipts.values())
                        if (!"REVERSED".equals(report.get("status")) && "roll".equals(report.get("feedPortType")) && r.getRollId().equals(report.get("rollId"))
                                && report.get("windowStartY") instanceof Number start && report.get("actualCutLen") instanceof Number used
                                && start.doubleValue() + used.doubleValue() > total + .001)
                            throw new InventoryConflictException("实测边界覆盖历史已切区域，请先核查跳段报工与材料坐标");
                    if (observation.present()) checkCountDefects(r.getDefects(), w, total);
                    lines.add(new InventoryCount.Line("roll", r.getRollId(), w, r.getCurrentRemainingLength(), r.getInspectionStatus(), w, l,
                            r.getInspectionStatus(), w * (l - r.getCurrentRemainingLength()) / 1e6, r.getUsedLength(), r.getTotalLength(), total));
                } else {
                    var r = kernel.remnantPool.get(observation.id());
                    if (observation.present()) checkCountDefects(r.getDefects(), w, l);
                    else if (w != r.getWidth()) throw new IllegalArgumentException("未见实物时保留原幅宽，不能凭空修改几何");
                    String next = !observation.present() ? "LOST" : "LOST".equals(r.getStatus()) ? "QUARANTINED" : r.getStatus();
                    double oldArea = "LOST".equals(r.getStatus()) ? 0 : r.getArea();
                    lines.add(new InventoryCount.Line("remnant", r.getId(), r.getWidth(), r.getLength(), r.getStatus(), w, l, next,
                            (observation.present() ? w * l / 1e6 : 0) - oldArea, 0, 0, 0));
                }
            }
            for (var line : lines) {
                if ("roll".equals(line.type())) {
                    var r = kernel.motherRolls.get(line.id());
                    r.setCurrentRemainingLength(line.measuredLength());
                    r.setTotalLength(line.afterTotalLength());
                } else {
                    var r = kernel.remnantPool.get(line.id());
                    if (!"LOST".equals(line.afterStatus())) {
                        r.setWidth(line.measuredWidth());
                        r.setLength(line.measuredLength());
                    }
                    r.setStatus(line.afterStatus());
                }
            }
            var document = new InventoryCount(id, key, command, kernel.currentOperationTime(), kernel.revision + 1, lines);
            kernel.counts.put(id, document);
            return document;
        });
    }

    private void checkCountDefects(List<Defect> defects, double width, double length) {
        if (defects != null && defects.stream().anyMatch(d -> d.getX() + d.getW() > width + .001 || d.getY() + d.getH() > length + .001))
            throw new InventoryConflictException("实测边界小于已登记疵点范围，请核查测量与疵点坐标；盘点不会截掉疵点历史");
    }

    // ==================== 隔离料头质量放行单 ====================

    List<QualityReleaseDocument> listQualityReleases() {
        return kernel.read(() -> kernel.qualityReleases.values().stream()
                .sorted(Comparator.comparingLong(QualityReleaseDocument::inventoryRevision).reversed()
                        .thenComparing(QualityReleaseDocument::id))
                .toList());
    }

    Map<String, Object> releaseQuarantinedRemnant(String remnantId, String idempotencyKey, String decisionInput,
                                                  String inspectorInput, String reasonInput) {
        if (remnantId == null || remnantId.isBlank()) throw new IllegalArgumentException("请指定待放行料头编号");
        String key = InventoryStateKernel.requireIdempotencyKey(idempotencyKey);
        String decision = decisionInput == null ? "" : decisionInput.trim().toUpperCase(Locale.ROOT);
        if (!Set.of(QualityReleaseDocument.DECISION_RELEASE_AVAILABLE, QualityReleaseDocument.DECISION_SCRAP).contains(decision)) {
            throw new IllegalArgumentException("复验决策仅支持 RELEASE_AVAILABLE 或 SCRAP");
        }
        String inspector = InventoryStateKernel.requireText(inspectorInput, 80, "请填写 1–80 字检验员姓名");
        String reason = InventoryStateKernel.requireText(reasonInput, 500, "请填写 1–500 字放行或报废原因");
        String targetRemnantId = remnantId.trim();
        String docId = "QREL-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);

        QualityReleaseDocument doc = kernel.mutate("QUALITY_RELEASE", docId, "DECLARED:" + inspector, () -> {
            for (QualityReleaseDocument prev : kernel.qualityReleases.values()) {
                if (prev.idempotencyKey().equals(key)) {
                    if (!prev.remnantId().equals(targetRemnantId) || !prev.decision().equals(decision)
                            || !prev.inspector().equals(inspector) || !prev.reason().equals(reason)) {
                        throw new InventoryConflictException("同一幂等键已用于其他质量放行内容");
                    }
                    return prev;
                }
            }
            return null;
        }, () -> {
            RemnantStock stock = kernel.remnantPool.get(targetRemnantId);
            if (stock == null) throw new IllegalArgumentException("料头不存在: " + targetRemnantId);
            if (!"QUARANTINED".equals(stock.getStatus())) {
                throw new InventoryConflictException("仅处于隔离状态(QUARANTINED)的料头可执行复验放行，当前状态：" + stock.getStatus());
            }
            kernel.ensureMaterialNotReserved("remnant", targetRemnantId, null);
            String fromStatus = stock.getStatus();
            String toStatus = QualityReleaseDocument.DECISION_RELEASE_AVAILABLE.equals(decision) ? "AVAILABLE" : "SCRAPPED";
            stock.setStatus(toStatus);
            if ("AVAILABLE".equals(toStatus)) {
                if (stock.getDefects() == null || stock.getDefects().isEmpty()) {
                    stock.setHasDefect(false);
                    stock.setQualityGrade("GRADE_A");
                }
                stock.setDefectDesc((InventoryStateKernel.blankToNull(stock.getDefectDesc()) != null ? stock.getDefectDesc() + " | " : "")
                        + "复验放行(" + inspector + "): " + reason);
            } else {
                stock.setDefectDesc((InventoryStateKernel.blankToNull(stock.getDefectDesc()) != null ? stock.getDefectDesc() + " | " : "")
                        + "复验判废(" + inspector + "): " + reason);
            }
            QualityReleaseDocument created = new QualityReleaseDocument(
                    docId, key, targetRemnantId, decision, fromStatus, toStatus, inspector, reason,
                    kernel.currentOperationTime(), kernel.revision + 1
            );
            kernel.qualityReleases.put(created.id(), created);
            return created;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("document", doc);
        out.put("remnant", kernel.read(() -> kernel.remnantPool.get(doc.remnantId())));
        out.put("revision", kernel.revision);
        return out;
    }

    // ==================== 采购批量入库单 ====================

    List<InventoryReceiptDocument> listInventoryReceipts() {
        return kernel.read(() -> kernel.inventoryReceipts.values().stream()
                .sorted(Comparator.comparingLong(InventoryReceiptDocument::inventoryRevision).reversed()
                        .thenComparing(InventoryReceiptDocument::id))
                .toList());
    }

    Map<String, Object> receiveInventoryBatch(
            String idempotencyKey, String supplierName, String deliveryNoteNo, String operatorInput,
            String remarksInput, String defaultInspectorInput, List<ReceiptRollLineInput> rolls
    ) {
        String key = InventoryStateKernel.requireIdempotencyKey(idempotencyKey);
        String supplier = InventoryStateKernel.requireText(supplierName, 120, "请填写 1–120 字供应商名称");
        String deliveryNo = InventoryStateKernel.requireText(deliveryNoteNo, 120, "请填写 1–120 字送货单号");
        String operator = InventoryStateKernel.requireText(operatorInput, 100, "请填写 1–100 字收货经办人");
        String remarks = remarksInput == null ? "" : remarksInput.trim();
        if (remarks.length() > 500) throw new IllegalArgumentException("入库备注不能超过 500 字");
        if (rolls == null || rolls.isEmpty() || rolls.size() > 100) {
            throw new IllegalArgumentException("采购入库单必须包含 1 至 100 卷母卷明细");
        }

        List<InventoryReceiptDocument.Line> normalizedLines = new ArrayList<>(rolls.size());
        Set<String> explicitIds = new HashSet<>();
        String defaultInspector = InventoryStateKernel.blankToNull(defaultInspectorInput);
        for (int i = 0; i < rolls.size(); i++) {
            ReceiptRollLineInput in = rolls.get(i);
            if (in == null) throw new IllegalArgumentException("第 " + (i + 1) + " 行母卷明细不能为空");
            String rollId = InventoryStateKernel.blankToNull(in.id());
            if (rollId != null && !explicitIds.add(rollId)) {
                throw new IllegalArgumentException("同一入库单内存在重复母卷编号: " + rollId);
            }
            String model = InventoryStateKernel.requireText(in.materialModel(), 120, "第 " + (i + 1) + " 行缺少材料型号 materialModel");
            String matType = InventoryStateKernel.blankToNull(in.materialType()) != null ? in.materialType().trim() : model;
            String color = InventoryStateKernel.blankToNull(in.color()) != null ? in.color().trim() : "标准色";
            String batchNo = InventoryStateKernel.blankToNull(in.batchNo()) != null ? in.batchNo().trim()
                    : "BAT-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
            if (!Double.isFinite(in.widthMm()) || in.widthMm() <= 0 || in.widthMm() > 1e9
                    || !Double.isFinite(in.totalLengthMm()) || in.totalLengthMm() <= 0 || in.totalLengthMm() > 1e9) {
                throw new IllegalArgumentException("第 " + (i + 1) + " 行母卷门幅与总长必须为有效正数");
            }
            double grammage = in.grammage() == null ? 220.0 : in.grammage();
            if (!Double.isFinite(grammage) || grammage < 0 || grammage > 100000) {
                throw new IllegalArgumentException("第 " + (i + 1) + " 行克重数值无效");
            }
            double shrinkage = in.shrinkageRate() == null ? 0.0 : in.shrinkageRate();
            if (!Double.isFinite(shrinkage) || shrinkage < 0 || shrinkage > 100) {
                throw new IllegalArgumentException("第 " + (i + 1) + " 行缩水率必须为 0 至 100 之间");
            }
            String location = InventoryStateKernel.blankToNull(in.storageLocation()) != null ? in.storageLocation().trim() : "原料收货区 R-IN";
            String inspStatus = InventoryStateKernel.blankToNull(in.inspectionStatus()) == null ? "PENDING" : in.inspectionStatus().trim().toUpperCase(Locale.ROOT);
            if (!Set.of("PENDING", "PASSED", "QUARANTINED").contains(inspStatus)) {
                throw new IllegalArgumentException("第 " + (i + 1) + " 行验布状态仅支持 PENDING、PASSED 或 QUARANTINED");
            }
            String lineInspector = InventoryStateKernel.blankToNull(in.inspector()) != null ? in.inspector().trim() : defaultInspector;
            if ("PASSED".equals(inspStatus) && lineInspector == null) {
                throw new IllegalArgumentException("第 " + (i + 1) + " 行入库直通合格(PASSED)必须填写检验员 inspector");
            }
            normalizedLines.add(new InventoryReceiptDocument.Line(
                    rollId, model, matType, color, batchNo, in.widthMm(), in.totalLengthMm(),
                    grammage, shrinkage, location, inspStatus, "PASSED".equals(inspStatus) ? lineInspector : null
            ));
        }

        String docId = "RCV-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);
        InventoryReceiptDocument doc = kernel.mutate("RECEIPT_IN", docId, "DECLARED:" + operator, () -> {
            for (InventoryReceiptDocument prev : kernel.inventoryReceipts.values()) {
                if (prev.idempotencyKey().equals(key)) {
                    if (!matchesReceiptDocument(prev, supplier, deliveryNo, operator, remarks, normalizedLines)) {
                        throw new InventoryConflictException("同一幂等键已用于其他采购入库单内容");
                    }
                    return prev;
                }
            }
            return null;
        }, () -> {
            List<InventoryReceiptDocument.Line> finalLines = new ArrayList<>(normalizedLines.size());
            String nowTs = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));
            String today = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd"));
            Set<String> batchIds = new HashSet<>();
            for (InventoryReceiptDocument.Line line : normalizedLines) {
                String rollId = line.rollId();
                if (rollId == null) {
                    String prefix = "ROLL-RCV-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd")) + "-";
                    do {
                        rollId = prefix + UUID.randomUUID().toString().substring(0, 4).toUpperCase(Locale.ROOT);
                    } while (kernel.motherRolls.containsKey(rollId) || !batchIds.add(rollId));
                } else {
                    if (kernel.motherRolls.containsKey(rollId)) {
                        throw new InventoryConflictException("母卷编号已存在，不能重复入库: " + rollId);
                    }
                    if (!batchIds.add(rollId)) {
                        throw new IllegalArgumentException("同一入库单内存在重复母卷编号: " + rollId);
                    }
                }
                finalLines.add(new InventoryReceiptDocument.Line(
                        rollId, line.materialModel(), line.materialType(), line.color(), line.batchNo(),
                        line.widthMm(), line.totalLengthMm(), line.grammage(), line.shrinkageRate(),
                        line.storageLocation(), line.inspectionStatus(), line.inspector()
                ));
            }
            for (InventoryReceiptDocument.Line line : finalLines) {
                MotherRollInfo fresh = new MotherRollInfo(
                        line.rollId(), line.materialModel(), line.batchNo(), supplier, line.materialType(),
                        line.color(), line.grammage(), line.materialType(), line.widthMm(), line.totalLengthMm(),
                        line.storageLocation()
                );
                fresh.setShrinkageRate(line.shrinkageRate());
                fresh.setInspectionStatus(line.inspectionStatus());
                if ("PASSED".equals(line.inspectionStatus())) {
                    fresh.setInspector(line.inspector());
                    fresh.setInspectionDate(today);
                } else {
                    fresh.setInspector("");
                    fresh.setInspectionDate(null);
                }
                fresh.setCreatedAt(nowTs);
                kernel.motherRolls.put(fresh.getRollId(), fresh);
            }
            InventoryReceiptDocument created = new InventoryReceiptDocument(
                    docId, key, supplier, deliveryNo, operator, remarks,
                    kernel.currentOperationTime(), kernel.revision + 1, finalLines
            );
            kernel.inventoryReceipts.put(created.id(), created);
            return created;
        });

        List<MotherRollInfo> createdRolls = kernel.read(() -> doc.lines().stream()
                .map(l -> kernel.getMotherRollInternal(l.rollId()))
                .filter(Objects::nonNull)
                .toList());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("document", doc);
        out.put("createdRolls", createdRolls);
        out.put("revision", kernel.revision);
        return out;
    }

    private static boolean matchesReceiptDocument(
            InventoryReceiptDocument prev, String supplier, String deliveryNo, String operator,
            String remarks, List<InventoryReceiptDocument.Line> incoming
    ) {
        if (!Objects.equals(prev.supplierName(), supplier) || !Objects.equals(prev.deliveryNoteNo(), deliveryNo)
                || !Objects.equals(prev.operator(), operator) || !Objects.equals(prev.remarks(), remarks)
                || prev.lines().size() != incoming.size()) {
            return false;
        }
        for (int i = 0; i < incoming.size(); i++) {
            InventoryReceiptDocument.Line a = prev.lines().get(i);
            InventoryReceiptDocument.Line b = incoming.get(i);
            if (b.rollId() != null && !Objects.equals(a.rollId(), b.rollId())) return false;
            if (!Objects.equals(a.materialModel(), b.materialModel()) || !Objects.equals(a.materialType(), b.materialType())
                    || !Objects.equals(a.color(), b.color()) || !Objects.equals(a.batchNo(), b.batchNo())
                    || Math.abs(a.widthMm() - b.widthMm()) > 0.001 || Math.abs(a.totalLengthMm() - b.totalLengthMm()) > 0.001
                    || Math.abs(a.grammage() - b.grammage()) > 0.001 || Math.abs(a.shrinkageRate() - b.shrinkageRate()) > 0.001
                    || !Objects.equals(a.storageLocation(), b.storageLocation())
                    || !Objects.equals(a.inspectionStatus(), b.inspectionStatus())
                    || !Objects.equals(a.inspector(), b.inspector())) {
                return false;
            }
        }
        return true;
    }

    // ==================== 车间领退料单 ====================

    List<MaterialIssueDocument> listMaterialIssues() {
        return kernel.read(() -> kernel.materialIssues.values().stream()
                .sorted(Comparator.comparingLong(MaterialIssueDocument::inventoryRevision).reversed()
                        .thenComparing(MaterialIssueDocument::id))
                .toList());
    }

    Map<String, Object> postMaterialIssue(
            String idempotencyKey, String directionInput, String rollIdInput, String machineIdInput,
            String shiftTeamInput, String operatorInput, String targetLocationInput, String reasonInput
    ) {
        String key = InventoryStateKernel.requireIdempotencyKey(idempotencyKey);
        String direction = directionInput == null ? "" : directionInput.trim().toUpperCase(Locale.ROOT);
        if (!Set.of(MaterialIssueDocument.DIRECTION_ISSUE, MaterialIssueDocument.DIRECTION_RETURN).contains(direction)) {
            throw new IllegalArgumentException("领退料方向仅支持 ISSUE 或 RETURN");
        }
        String rollId = InventoryStateKernel.requireText(rollIdInput, 128, "请指定母卷编号 rollId");
        String operator = InventoryStateKernel.requireText(operatorInput, 100, "请填写 1–100 字经办人");
        String reason = InventoryStateKernel.requireText(reasonInput, 500, "请填写 1–500 字领料或退料原因");
        String machineId = InventoryStateKernel.blankToNull(machineIdInput);
        String shiftTeam = InventoryStateKernel.blankToNull(shiftTeamInput);
        String targetLocation = InventoryStateKernel.blankToNull(targetLocationInput);
        if (MaterialIssueDocument.DIRECTION_ISSUE.equals(direction)) {
            if (machineId == null || machineId.length() > 80) {
                throw new IllegalArgumentException("车间领料必须填写 1–80 字领用机台 machineId");
            }
            if (targetLocation == null) targetLocation = "车间:" + machineId;
        } else {
            if (targetLocation == null || targetLocation.length() > 120) {
                throw new IllegalArgumentException("车间退料必须填写 1–120 字退回仓库目标库位 targetLocation");
            }
        }
        if (shiftTeam != null && shiftTeam.length() > 80) {
            throw new IllegalArgumentException("班组名称不能超过 80 字");
        }

        String finalTargetLocation = targetLocation;
        String eventType = MaterialIssueDocument.DIRECTION_ISSUE.equals(direction) ? "MATERIAL_ISSUE" : "MATERIAL_RETURN";
        String docId = (MaterialIssueDocument.DIRECTION_ISSUE.equals(direction) ? "ISS-" : "RET-")
                + UUID.randomUUID().toString().substring(0, 8).toUpperCase(Locale.ROOT);

        MaterialIssueDocument doc = kernel.mutate(eventType, docId, "DECLARED:" + operator, () -> {
            for (MaterialIssueDocument prev : kernel.materialIssues.values()) {
                if (prev.idempotencyKey().equals(key)) {
                    boolean sameMachine = machineId == null || Objects.equals(prev.machineId(), machineId);
                    boolean sameShift = shiftTeam == null || Objects.equals(prev.shiftTeam(), shiftTeam);
                    if (!prev.direction().equals(direction) || !prev.rollId().equals(rollId)
                            || !prev.operator().equals(operator) || !prev.toLocation().equals(finalTargetLocation)
                            || !prev.reason().equals(reason) || !sameMachine || !sameShift) {
                        throw new InventoryConflictException("同一幂等键已用于其他领退料单内容");
                    }
                    return prev;
                }
            }
            return null;
        }, () -> {
            MotherRollInfo roll = kernel.motherRolls.get(rollId);
            if (roll == null) throw new IllegalArgumentException("母卷不存在: " + rollId);
            if ("SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) {
                throw new InventoryConflictException("母卷 " + rollId + " 已报废，禁止办理领退料");
            }
            String fromLocation = Objects.toString(roll.getStorageLocation(), "");
            String recordedMachine;
            String recordedShift;
            if (MaterialIssueDocument.DIRECTION_ISSUE.equals(direction)) {
                if (!"PASSED".equalsIgnoreCase(roll.getInspectionStatus())) {
                    throw new InventoryConflictException("母卷 " + rollId + " 尚未通过质检放行（当前状态："
                            + Objects.toString(roll.getInspectionStatus(), "PENDING") + "），禁止领料出库至机台");
                }
                if (roll.getCurrentRemainingLength() <= 0.001) {
                    throw new InventoryConflictException("母卷 " + rollId + " 已用尽，禁止发料出库");
                }
                if (InventoryStateKernel.blankToNull(roll.getIssuedMachineId()) != null) {
                    throw new InventoryConflictException("母卷 " + rollId + " 当前已发料至机台「" + roll.getIssuedMachineId() + "」，请先办理退料");
                }
                roll.setIssuedMachineId(machineId);
                roll.setIssuedShiftTeam(shiftTeam);
                roll.setStorageLocation(finalTargetLocation);
                recordedMachine = machineId;
                recordedShift = shiftTeam;
            } else {
                if (InventoryStateKernel.blankToNull(roll.getIssuedMachineId()) == null) {
                    throw new InventoryConflictException("母卷 " + rollId + " 当前未处于车间领用状态，无需办理退料");
                }
                kernel.ensureMaterialNotReserved("roll", rollId, null);
                recordedMachine = machineId != null ? machineId : roll.getIssuedMachineId();
                recordedShift = shiftTeam != null ? shiftTeam : roll.getIssuedShiftTeam();
                roll.setIssuedMachineId(null);
                roll.setIssuedShiftTeam(null);
                roll.setStorageLocation(finalTargetLocation);
            }
            MaterialIssueDocument created = new MaterialIssueDocument(
                    docId, key, direction, roll.getRollId(), roll.getRollModel(), roll.getBatchNo(),
                    recordedMachine, recordedShift, operator, fromLocation, finalTargetLocation,
                    roll.getCurrentRemainingLength(), reason, kernel.currentOperationTime(), kernel.revision + 1
            );
            kernel.materialIssues.put(created.id(), created);
            return created;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("document", doc);
        out.put("roll", kernel.read(() -> kernel.getMotherRollInternal(doc.rollId())));
        out.put("revision", kernel.revision);
        return out;
    }
}
