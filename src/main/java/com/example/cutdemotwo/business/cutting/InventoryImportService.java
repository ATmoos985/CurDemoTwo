package com.example.cutdemotwo.business.cutting;

import com.example.cutdemotwo.business.cutting.BatchImportValidationException.RowError;
import com.example.cutdemotwo.business.model.InventoryBatchImportDocument;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.persistence.InventoryConflictException;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 原子批量库存导入领域服务：
 * 支持母卷（ROLLS）、料头（REMNANTS）与瑕疵（DEFECTS）的只读预检与单事务原子提交，
 * 严格遵循长度守恒（0.001 mm）、瑕疵 0.1 mm 精度、血统继承、Idempotency-Key 幂等重放与 409 冲突拦截。
 */
@Service
public class InventoryImportService {
    public static final int MAX_ROWS_PER_BATCH = 500;
    public static final String TYPE_ROLLS = "ROLLS";
    public static final String TYPE_REMNANTS = "REMNANTS";
    public static final String TYPE_DEFECTS = "DEFECTS";

    private static final double EPS = 0.001;
    private static final double PRECISION_EPS = 1e-6;
    private static final Set<String> ALLOWED_ROLL_STATUSES = Set.of("PENDING", "PASSED", "QUARANTINED", "SCRAPPED");
    private static final Set<String> ALLOWED_REMNANT_STATUSES = Set.of("AVAILABLE", "QUARANTINED");
    private static final Set<String> ALLOWED_QUALITY_GRADES = Set.of("GRADE_A", "GRADE_B", "GRADE_DEFECT");
    private static final DateTimeFormatter TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter REM_TS_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private final CuttingStatePort statePort;
    private final ObjectMapper json = new ObjectMapper();

    public InventoryImportService(RemnantService remnantService) {
        this.statePort = Objects.requireNonNull(remnantService, "remnantService");
    }

    // ==================== 请求与响应契约 ====================

    public record RollRowInput(
            String rollId, String rollModel, String batchNo, String supplier,
            String materialName, String color, Double grammage, String composition,
            Double shrinkageRate, Double width, Double rawWidth, Double totalLength,
            Double usedLength, Double currentRemainingLength, Double scrappedLengthMm,
            String storageLocation, String inspectionStatus, String inspector,
            String inspectionDate, Double unitPricePerMeter, Double unitPricePerSqm
    ) {}

    public record RemnantRowInput(
            String id, Double width, Double length, String location, String materialBatch,
            String status, String sourceRollId, String parentRemnantId, Integer generation,
            String qualityGrade, Boolean hasDefect, String defectDesc, String batchNo, String color
    ) {}

    public record DefectRowInput(
            String rollId, String captureId, Double x, Double y, Double w, Double h,
            Double margin, String defectType, String typeName, Integer severity,
            Integer points, String detectionSource, String avoidanceStrategy, String description
    ) {}

    public record BatchImportRequest<R>(String idempotencyKey, String operator, List<R> rows) {}

    public record BatchImportResult(
            String importType, boolean dryRun, boolean valid, String idempotencyKey,
            boolean idempotentReplay, String documentId, long revision,
            int totalRows, int validRows, int errorRows, int importedCount, int skippedCount,
            List<RowError> errors, List<String> createdIds
    ) {
        static BatchImportResult fromSummary(InventoryBatchImportDocument.Summary s, boolean replay) {
            return new BatchImportResult(
                    s.importType(), s.dryRun(), s.valid(), s.idempotencyKey(), replay,
                    s.documentId(), s.revision(), s.totalRows(), s.validRows(), s.errorRows(),
                    s.importedCount(), s.skippedCount(), List.of(), s.createdIds()
            );
        }

        InventoryBatchImportDocument.Summary toSummary() {
            return new InventoryBatchImportDocument.Summary(
                    importType, dryRun, valid, idempotencyKey, idempotentReplay, documentId,
                    revision, totalRows, validRows, errorRows, importedCount, skippedCount, createdIds
            );
        }
    }

    // ==================== 1. 母卷批量导入 ====================

    public BatchImportResult previewRolls(BatchImportRequest<RollRowInput> request, String resolvedOperator) {
        List<RollRowInput> rows = validateRequestRows(request);
        String operator = normalizeOperator(request.operator(), resolvedOperator);
        return statePort.inRead(view -> {
            RollValidationOutcome outcome = validateRollRows(view, rows, operator);
            return buildPreviewResult(TYPE_ROLLS, request.idempotencyKey(), rows.size(), outcome.validRows(), outcome.errors());
        });
    }

    public BatchImportResult commitRolls(BatchImportRequest<RollRowInput> request, String idempotencyKey, String resolvedOperator) {
        List<RollRowInput> rows = validateRequestRows(request);
        String key = requireIdempotencyKey(idempotencyKey);
        String operator = normalizeOperator(request.operator(), resolvedOperator);
        String requestHash = computeRequestHash(TYPE_ROLLS, rows);

        return statePort.inWrite(
                "INVENTORY_IMPORT_ROLLS", key, actorTag(operator),
                view -> checkReplay(view, TYPE_ROLLS, key, requestHash),
                tx -> {
                    RollValidationOutcome outcome = validateRollRows(tx, rows, operator);
                    if (!outcome.errors().isEmpty()) {
                        throw new BatchImportValidationException(TYPE_ROLLS,
                                "母卷批量导入存在 " + outcome.errors().size() + " 处校验错误，整批已原子回滚",
                                outcome.errors());
                    }
                    List<String> createdIds = new ArrayList<>(outcome.rolls().size());
                    for (MotherRollInfo roll : outcome.rolls()) {
                        tx.saveRoll(roll);
                        createdIds.add(roll.getRollId());
                    }
                    return recordImportDocument(tx, TYPE_ROLLS, key, requestHash, operator,
                            rows.size(), createdIds.size(), 0, createdIds);
                }
        );
    }

    // ==================== 2. 料头批量导入 ====================

    public BatchImportResult previewRemnants(BatchImportRequest<RemnantRowInput> request, String resolvedOperator) {
        List<RemnantRowInput> rows = validateRequestRows(request);
        return statePort.inRead(view -> {
            RemnantValidationOutcome outcome = validateRemnantRows(view, rows);
            return buildPreviewResult(TYPE_REMNANTS, request.idempotencyKey(), rows.size(), outcome.validRows(), outcome.errors());
        });
    }

    public BatchImportResult commitRemnants(BatchImportRequest<RemnantRowInput> request, String idempotencyKey, String resolvedOperator) {
        List<RemnantRowInput> rows = validateRequestRows(request);
        String key = requireIdempotencyKey(idempotencyKey);
        String operator = normalizeOperator(request.operator(), resolvedOperator);
        String requestHash = computeRequestHash(TYPE_REMNANTS, rows);

        return statePort.inWrite(
                "INVENTORY_IMPORT_REMNANTS", key, actorTag(operator),
                view -> checkReplay(view, TYPE_REMNANTS, key, requestHash),
                tx -> {
                    RemnantValidationOutcome outcome = validateRemnantRows(tx, rows);
                    if (!outcome.errors().isEmpty()) {
                        throw new BatchImportValidationException(TYPE_REMNANTS,
                                "料头批量导入存在 " + outcome.errors().size() + " 处校验错误，整批已原子回滚",
                                outcome.errors());
                    }
                    List<String> createdIds = new ArrayList<>(outcome.remnants().size());
                    for (RemnantStock remnant : outcome.remnants()) {
                        RemnantStock saved = tx.registerRemnant(remnant);
                        createdIds.add(saved.getId());
                    }
                    return recordImportDocument(tx, TYPE_REMNANTS, key, requestHash, operator,
                            rows.size(), createdIds.size(), 0, createdIds);
                }
        );
    }

    // ==================== 3. 瑕疵批量导入 ====================

    public BatchImportResult previewDefects(BatchImportRequest<DefectRowInput> request, String resolvedOperator) {
        List<DefectRowInput> rows = validateRequestRows(request);
        return statePort.inRead(view -> {
            DefectValidationOutcome outcome = validateDefectRows(view, rows);
            return buildPreviewResult(TYPE_DEFECTS, request.idempotencyKey(), rows.size(), outcome.validRows(), outcome.errors());
        });
    }

    public BatchImportResult commitDefects(BatchImportRequest<DefectRowInput> request, String idempotencyKey, String resolvedOperator) {
        List<DefectRowInput> rows = validateRequestRows(request);
        String key = requireIdempotencyKey(idempotencyKey);
        String operator = normalizeOperator(request.operator(), resolvedOperator);
        String requestHash = computeRequestHash(TYPE_DEFECTS, rows);

        return statePort.inWrite(
                "INVENTORY_IMPORT_DEFECTS", key, actorTag(operator),
                view -> checkReplay(view, TYPE_DEFECTS, key, requestHash),
                tx -> {
                    DefectValidationOutcome outcome = validateDefectRows(tx, rows);
                    if (!outcome.errors().isEmpty()) {
                        throw new BatchImportValidationException(TYPE_DEFECTS,
                                "瑕疵批量导入存在 " + outcome.errors().size() + " 处校验错误，整批已原子回滚",
                                outcome.errors());
                    }
                    List<String> createdIds = new ArrayList<>();
                    int skipped = 0;
                    for (PlannedDefectItem item : outcome.items()) {
                        if (item.skipDuplicate()) {
                            skipped++;
                            continue;
                        }
                        Defect added = tx.appendDefectToRoll(item.rollId(), item.defect());
                        createdIds.add(item.rollId() + "#" + added.getId());
                    }
                    return recordImportDocument(tx, TYPE_DEFECTS, key, requestHash, operator,
                            rows.size(), createdIds.size(), skipped, createdIds);
                }
        );
    }

    // ==================== 校验逻辑实现 ====================

    private record RollValidationOutcome(List<MotherRollInfo> rolls, int validRows, List<RowError> errors) {}

    private RollValidationOutcome validateRollRows(CuttingStatePort.ReadView view, List<RollRowInput> rows, String operator) {
        List<MotherRollInfo> result = new ArrayList<>(rows.size());
        List<RowError> errors = new ArrayList<>();
        Set<String> seenIds = new HashSet<>();
        int validRows = 0;
        String nowStr = LocalDateTime.now().format(TS_FMT);

        for (int i = 0; i < rows.size(); i++) {
            RollRowInput r = rows.get(i);
            int beforeErrs = errors.size();
            if (r == null) {
                errors.add(new RowError(i, "row", "EMPTY_ROW", "第 " + (i + 1) + " 行不能为空"));
                continue;
            }
            String rollId = cleanText(r.rollId(), 128, "rollId", i, true, errors);
            if (rollId != null) {
                if (!seenIds.add(rollId)) {
                    errors.add(new RowError(i, "rollId", "DUPLICATE_IN_BATCH", "批次内母卷编号重复：" + rollId));
                } else if (view.findRoll(rollId).isPresent()) {
                    errors.add(new RowError(i, "rollId", "DUPLICATE_ROLL_ID", "母卷编号已存在于库存中：" + rollId));
                }
            }
            String rollModel = cleanText(r.rollModel(), 120, "rollModel", i, true, errors);

            double width = requirePositiveFinite(r.width(), "width", "母卷幅宽", i, errors);
            double totalLength = requirePositiveFinite(r.totalLength(), "totalLength", "母卷总长度", i, errors);
            double usedLength = r.usedLength() == null ? 0.0 : requireNonNegativeFinite(r.usedLength(), "usedLength", "已用长度", i, errors);
            if (Double.isFinite(totalLength) && Double.isFinite(usedLength) && usedLength > totalLength + EPS) {
                errors.add(new RowError(i, "usedLength", "USED_EXCEEDS_TOTAL", "已用长度不能大于总长度"));
            }

            double shrinkage = r.shrinkageRate() == null ? 1.5 : r.shrinkageRate();
            if (!Double.isFinite(shrinkage) || shrinkage < 0.0 || shrinkage > 100.0) {
                errors.add(new RowError(i, "shrinkageRate", "INVALID_SHRINKAGE", "缩水率必须为 0 至 100 之间的有限数值"));
            }
            double grammage = r.grammage() == null ? 240.0 : r.grammage();
            if (!Double.isFinite(grammage) || grammage < 0.0) {
                errors.add(new RowError(i, "grammage", "INVALID_GRAMMAGE", "克重必须为非负有限数值"));
            }
            if (r.unitPricePerMeter() != null && (!Double.isFinite(r.unitPricePerMeter()) || r.unitPricePerMeter() < 0.0)) {
                errors.add(new RowError(i, "unitPricePerMeter", "INVALID_PRICE", "每米采购单价必须为非负有限数值"));
            }
            if (r.unitPricePerSqm() != null && (!Double.isFinite(r.unitPricePerSqm()) || r.unitPricePerSqm() < 0.0)) {
                errors.add(new RowError(i, "unitPricePerSqm", "INVALID_PRICE", "每平米采购单价必须为非负有限数值"));
            }

            String statusRaw = cleanText(r.inspectionStatus(), 32, "inspectionStatus", i, false, errors);
            String status = statusRaw == null ? "PENDING" : statusRaw.toUpperCase(Locale.ROOT);
            if (!ALLOWED_ROLL_STATUSES.contains(status)) {
                errors.add(new RowError(i, "inspectionStatus", "INVALID_INSPECTION_STATUS", "质检状态仅支持 PENDING/PASSED/QUARANTINED/SCRAPPED"));
            }

            boolean isScrapped = "SCRAPPED".equals(status);
            double remaining;
            double scrapped;
            if (isScrapped) {
                remaining = r.currentRemainingLength() == null ? 0.0 : requireNonNegativeFinite(r.currentRemainingLength(), "currentRemainingLength", "剩余长度", i, errors);
                scrapped = r.scrappedLengthMm() == null ? Math.max(0.0, totalLength - usedLength) : requireNonNegativeFinite(r.scrappedLengthMm(), "scrappedLengthMm", "报废长度", i, errors);
                if (remaining > EPS) {
                    errors.add(new RowError(i, "currentRemainingLength", "SCRAPPED_REMAINING_NON_ZERO", "已报废母卷剩余长度必须为 0"));
                }
            } else {
                remaining = r.currentRemainingLength() == null ? Math.max(0.0, totalLength - usedLength) : requireNonNegativeFinite(r.currentRemainingLength(), "currentRemainingLength", "剩余长度", i, errors);
                scrapped = r.scrappedLengthMm() == null ? 0.0 : requireNonNegativeFinite(r.scrappedLengthMm(), "scrappedLengthMm", "报废长度", i, errors);
                if (scrapped > EPS) {
                    errors.add(new RowError(i, "scrappedLengthMm", "NON_SCRAPPED_HAS_SCRAP_LENGTH", "非报废母卷报废长度必须为 0"));
                }
            }

            if (Double.isFinite(totalLength) && Double.isFinite(usedLength) && Double.isFinite(remaining) && Double.isFinite(scrapped)) {
                if (Math.abs(totalLength - usedLength - remaining - scrapped) > EPS) {
                    errors.add(new RowError(i, "currentRemainingLength", "ROLL_LENGTH_MISMATCH",
                            "母卷总长度、已用长度、剩余长度与报废长度不守恒（误差须 <= 0.001 mm）"));
                }
            }

            String batchNo = cleanText(r.batchNo(), 120, "batchNo", i, false, errors);
            String supplier = cleanText(r.supplier(), 200, "supplier", i, false, errors);
            String materialName = cleanText(r.materialName(), 200, "materialName", i, false, errors);
            String color = cleanText(r.color(), 120, "color", i, false, errors);
            String composition = cleanText(r.composition(), 200, "composition", i, false, errors);
            String location = cleanText(r.storageLocation(), 120, "storageLocation", i, false, errors);
            String inspector = cleanText(r.inspector(), 100, "inspector", i, false, errors);
            String inspectionDate = cleanText(r.inspectionDate(), 32, "inspectionDate", i, false, errors);

            if (errors.size() == beforeErrs) {
                validRows++;
                MotherRollInfo roll = new MotherRollInfo();
                roll.setRollId(rollId);
                roll.setRollModel(rollModel);
                if (batchNo != null) roll.setBatchNo(batchNo);
                if (supplier != null) roll.setSupplier(supplier);
                if (materialName != null) roll.setMaterialName(materialName);
                if (color != null) roll.setColor(color);
                roll.setGrammage(grammage);
                if (composition != null) roll.setComposition(composition);
                roll.setShrinkageRate(shrinkage);
                roll.setWidth(width);
                roll.setRawWidth(r.rawWidth() != null && Double.isFinite(r.rawWidth()) && r.rawWidth() >= width ? r.rawWidth() : width + 50.0);
                roll.setTotalLength(totalLength);
                roll.setUsedLength(usedLength);
                roll.setCurrentRemainingLength(remaining);
                roll.setScrappedLengthMm(isScrapped ? scrapped : null);
                if (isScrapped) {
                    roll.setScrappedBy(operator);
                    roll.setScrappedAt(nowStr);
                    roll.setScrapReason("期初/批量导入报废");
                }
                if (location != null) roll.setStorageLocation(location);
                roll.setInspectionStatus(status);
                if ("PASSED".equals(status)) {
                    roll.setInspector(inspector != null ? inspector : operator);
                    roll.setInspectionDate(inspectionDate != null ? inspectionDate : nowStr.substring(0, 10));
                } else if (inspector != null) {
                    roll.setInspector(inspector);
                }
                roll.setCreatedAt(nowStr);
                roll.setUnitPricePerMeter(r.unitPricePerMeter());
                roll.setUnitPricePerSqm(r.unitPricePerSqm());
                result.add(roll);
            }
        }
        return new RollValidationOutcome(result, validRows, errors);
    }

    private record RemnantValidationOutcome(List<RemnantStock> remnants, int validRows, List<RowError> errors) {}

    private RemnantValidationOutcome validateRemnantRows(CuttingStatePort.ReadView view, List<RemnantRowInput> rows) {
        List<RemnantStock> result = new ArrayList<>(rows.size());
        List<RowError> errors = new ArrayList<>();
        Set<String> seenIds = new HashSet<>();
        int validRows = 0;
        String nowStr = LocalDateTime.now().format(REM_TS_FMT);

        for (int i = 0; i < rows.size(); i++) {
            RemnantRowInput r = rows.get(i);
            int beforeErrs = errors.size();
            if (r == null) {
                errors.add(new RowError(i, "row", "EMPTY_ROW", "第 " + (i + 1) + " 行不能为空"));
                continue;
            }
            String id = cleanText(r.id(), 128, "id", i, false, errors);
            if (id != null) {
                if (!seenIds.add(id)) {
                    errors.add(new RowError(i, "id", "DUPLICATE_IN_BATCH", "批次内料头编号重复：" + id));
                } else if (view.findRemnant(id).isPresent()) {
                    errors.add(new RowError(i, "id", "DUPLICATE_REMNANT_ID", "料头编号已存在于库存中：" + id));
                }
            }
            double width = requirePositiveFinite(r.width(), "width", "料头幅宽", i, errors);
            double length = requirePositiveFinite(r.length(), "length", "料头长度", i, errors);

            String sourceRollId = cleanText(r.sourceRollId(), 128, "sourceRollId", i, false, errors);
            MotherRollInfo sourceRoll = null;
            if (sourceRollId != null) {
                sourceRoll = view.findRoll(sourceRollId).orElse(null);
                if (sourceRoll == null) {
                    errors.add(new RowError(i, "sourceRollId", "SOURCE_ROLL_NOT_FOUND", "来源母卷不存在：" + sourceRollId));
                }
            }
            String parentRemnantId = cleanText(r.parentRemnantId(), 128, "parentRemnantId", i, false, errors);
            RemnantStock parentRemnant = null;
            if (parentRemnantId != null) {
                parentRemnant = view.findRemnant(parentRemnantId).orElse(null);
                if (parentRemnant == null) {
                    errors.add(new RowError(i, "parentRemnantId", "PARENT_REMNANT_NOT_FOUND", "父级料头不存在：" + parentRemnantId));
                }
            }

            String materialBatch = cleanText(r.materialBatch(), 120, "materialBatch", i, false, errors);
            if (materialBatch == null && sourceRoll != null) {
                materialBatch = sourceRoll.getRollModel();
            }
            if (materialBatch == null && parentRemnant != null) {
                materialBatch = parentRemnant.getMaterialBatch();
            }
            if (materialBatch == null) {
                errors.add(new RowError(i, "materialBatch", "MISSING_MATERIAL_BATCH", "未指定来源母卷时必须填写物料型号/批次 materialBatch"));
            }

            String statusRaw = cleanText(r.status(), 32, "status", i, false, errors);
            String status = statusRaw == null ? "AVAILABLE" : statusRaw.toUpperCase(Locale.ROOT);
            if (!ALLOWED_REMNANT_STATUSES.contains(status)) {
                errors.add(new RowError(i, "status", "INVALID_REMNANT_STATUS", "批量导入料头状态仅允许 AVAILABLE 或 QUARANTINED"));
            }

            boolean hasDefect = Boolean.TRUE.equals(r.hasDefect());
            String gradeRaw = cleanText(r.qualityGrade(), 32, "qualityGrade", i, false, errors);
            String grade = gradeRaw == null ? (hasDefect ? "GRADE_DEFECT" : "GRADE_A") : gradeRaw.toUpperCase(Locale.ROOT);
            if (!ALLOWED_QUALITY_GRADES.contains(grade)) {
                errors.add(new RowError(i, "qualityGrade", "INVALID_QUALITY_GRADE", "料头质量评级仅支持 GRADE_A/GRADE_B/GRADE_DEFECT"));
            }
            int generation = r.generation() == null ? (parentRemnantId != null ? 2 : 1) : r.generation();
            if (generation < 1 || generation > 99) {
                errors.add(new RowError(i, "generation", "INVALID_GENERATION", "料头代数必须为 1–99 整数"));
            }

            String location = cleanText(r.location(), 120, "location", i, false, errors);
            String defectDesc = cleanText(r.defectDesc(), 300, "defectDesc", i, false, errors);
            String batchNo = cleanText(r.batchNo(), 120, "batchNo", i, false, errors);
            String color = cleanText(r.color(), 120, "color", i, false, errors);

            if (errors.size() == beforeErrs) {
                validRows++;
                RemnantStock rem = new RemnantStock();
                rem.setId(id);
                rem.setWidth(width);
                rem.setLength(length);
                rem.setLocation(location != null ? location : "原料料头区");
                rem.setMaterialBatch(materialBatch);
                rem.setStatus(status);
                rem.setSourceRollId(sourceRollId);
                rem.setParentRemnantId(parentRemnantId);
                rem.setGeneration(generation);
                rem.setHasDefect(hasDefect);
                rem.setQualityGrade(grade);
                rem.setDefectDesc(defectDesc);
                rem.setBatchNo(batchNo);
                rem.setColor(color);
                rem.setCreatedAt(nowStr);
                result.add(rem);
            }
        }
        return new RemnantValidationOutcome(result, validRows, errors);
    }

    private record PlannedDefectItem(String rollId, Defect defect, boolean skipDuplicate) {}

    private record DefectValidationOutcome(List<PlannedDefectItem> items, int validRows, List<RowError> errors) {}

    private DefectValidationOutcome validateDefectRows(CuttingStatePort.ReadView view, List<DefectRowInput> rows) {
        List<PlannedDefectItem> result = new ArrayList<>(rows.size());
        List<RowError> errors = new ArrayList<>();
        Map<String, Defect> batchSeenCaptureIds = new HashMap<>();
        int validRows = 0;

        for (int i = 0; i < rows.size(); i++) {
            DefectRowInput r = rows.get(i);
            int beforeErrs = errors.size();
            if (r == null) {
                errors.add(new RowError(i, "row", "EMPTY_ROW", "第 " + (i + 1) + " 行不能为空"));
                continue;
            }
            String rollId = cleanText(r.rollId(), 128, "rollId", i, true, errors);
            MotherRollInfo roll = rollId != null ? view.findRoll(rollId).orElse(null) : null;
            if (rollId != null && roll == null) {
                errors.add(new RowError(i, "rollId", "ROLL_NOT_FOUND", "母卷不存在：" + rollId));
            } else if (roll != null && "SCRAPPED".equalsIgnoreCase(roll.getInspectionStatus())) {
                errors.add(new RowError(i, "rollId", "ROLL_SCRAPPED", "已报废母卷禁止导入瑕疵：" + rollId));
            }

            double x = requirePrecisionTenth(r.x(), "x", false, i, errors);
            double y = requirePrecisionTenth(r.y(), "y", false, i, errors);
            double w = requirePrecisionTenth(r.w(), "w", true, i, errors);
            double h = requirePrecisionTenth(r.h(), "h", true, i, errors);
            double margin = requirePrecisionTenth(r.margin() == null ? 20.0 : r.margin(), "margin", false, i, errors);

            if (roll != null && Double.isFinite(x) && Double.isFinite(y) && Double.isFinite(w) && Double.isFinite(h)) {
                if (x + w > roll.getWidth() + 1e-6 || y + h > roll.getTotalLength() + 1e-6) {
                    errors.add(new RowError(i, "x", "OUT_OF_ROLL_BOUNDS",
                            "瑕疵坐标与宽高超出母卷尺寸（width=" + roll.getWidth() + ", totalLength=" + roll.getTotalLength() + "）"));
                }
            }

            int severity = r.severity() == null ? 2 : r.severity();
            if (severity < 1 || severity > 4) {
                errors.add(new RowError(i, "severity", "INVALID_SEVERITY", "严重等级 severity 必须为 1–4"));
            }
            int points = r.points() == null ? severity : r.points();
            if (points < 1 || points > 4) {
                errors.add(new RowError(i, "points", "INVALID_POINTS", "四分制扣分 points 必须为 1–4"));
            }

            String defectType = Objects.requireNonNullElse(cleanText(r.defectType(), 40, "defectType", i, false, errors), "STAIN");
            String typeName = Objects.requireNonNullElse(cleanText(r.typeName(), 60, "typeName", i, false, errors), "污渍/斑点");
            String source = Objects.requireNonNullElse(cleanText(r.detectionSource(), 60, "detectionSource", i, false, errors), "BATCH_IMPORT");
            String strategy = Objects.requireNonNullElse(cleanText(r.avoidanceStrategy(), 40, "avoidanceStrategy", i, false, errors), "MUST_AVOID");
            String desc = Objects.requireNonNullElse(cleanText(r.description(), 200, "description", i, false, errors), "批量导入瑕疵");

            String captureId = cleanText(r.captureId(), 80, "captureId", i, false, errors);
            if (captureId != null && !captureId.matches("[a-zA-Z0-9-]{1,80}")) {
                errors.add(new RowError(i, "captureId", "INVALID_CAPTURE_ID", "captureId 仅支持 1–80 位字母、数字或连字符"));
            }

            if (errors.size() == beforeErrs) {
                Defect incoming = new Defect(0, x, y, w, h, margin, defectType, typeName, severity, points, source, strategy, desc);
                if (captureId == null) {
                    captureId = "IMP-" + sha256Hex(rollId + "|" + x + "|" + y + "|" + w + "|" + h + "|" + defectType).substring(0, 16);
                }
                final String finalCaptureId = captureId;
                incoming.setCaptureId(finalCaptureId);

                String batchKey = rollId + "::" + finalCaptureId;
                Defect prevInBatch = batchSeenCaptureIds.putIfAbsent(batchKey, incoming);
                if (prevInBatch != null) {
                    errors.add(new RowError(i, "captureId", "DUPLICATE_CAPTURE_ID", "同一批次内存在重复的瑕疵 captureId：" + finalCaptureId));
                    continue;
                }

                Defect existing = roll.getDefects().stream()
                        .filter(d -> finalCaptureId.equals(d.getCaptureId()))
                        .findFirst()
                        .orElse(null);
                boolean skip = false;
                if (existing != null) {
                    Defect copy = existing.copy();
                    copy.setId(0);
                    if (!copy.equalsContent(incoming)) {
                        errors.add(new RowError(i, "captureId", "CAPTURE_ID_CONFLICT",
                                "母卷 " + rollId + " 已存在同 captureId(" + finalCaptureId + ") 但内容不同的瑕疵"));
                        continue;
                    }
                    skip = true;
                }
                if (!skip && (view.isMaterialReservedByExecution("roll", rollId, null)
                        || view.listSchemes().stream().anyMatch(s -> s.occupiesRoll(rollId)))) {
                    errors.add(new RowError(i, "rollId", "ROLL_RESERVED",
                            "母卷 " + rollId + " 已被执行单或活跃排程方案预约锁定，暂不可导入新瑕疵"));
                    continue;
                }
                validRows++;
                result.add(new PlannedDefectItem(rollId, incoming, skip));
            }
        }
        return new DefectValidationOutcome(result, validRows, errors);
    }

    // ==================== 公共辅助方法 ====================

    private <R> List<R> validateRequestRows(BatchImportRequest<R> request) {
        if (request == null || request.rows() == null || request.rows().isEmpty()) {
            throw new IllegalArgumentException("批量导入请求体 rows 不能为空");
        }
        if (request.rows().size() > MAX_ROWS_PER_BATCH) {
            throw new IllegalArgumentException("单批导入上限为 " + MAX_ROWS_PER_BATCH + " 行，请分批提交");
        }
        return request.rows();
    }

    private BatchImportResult checkReplay(CuttingStatePort.ReadView view, String importType, String key, String requestHash) {
        Optional<InventoryBatchImportDocument> existingOpt = view.findBatchImportByIdempotencyKey(key);
        if (existingOpt.isEmpty()) {
            return null;
        }
        InventoryBatchImportDocument existing = existingOpt.get();
        if (!importType.equals(existing.importType()) || !requestHash.equals(existing.requestHash())) {
            throw new InventoryConflictException("同一幂等键已用于其他批量导入内容或类型");
        }
        return BatchImportResult.fromSummary(existing.summary(), true);
    }

    private BatchImportResult recordImportDocument(
            CuttingStatePort.WriteTx tx, String importType, String key, String requestHash,
            String operator, int totalRows, int importedCount, int skippedCount, List<String> createdIds
    ) {
        String docId = "IMP-" + UUID.randomUUID().toString().substring(0, 12).toUpperCase(Locale.ROOT);
        long nextRevision = tx.currentRevision() + 1;
        BatchImportResult res = new BatchImportResult(
                importType, false, true, key, false, docId, nextRevision,
                totalRows, totalRows, 0, importedCount, skippedCount, List.of(), createdIds
        );
        InventoryBatchImportDocument doc = new InventoryBatchImportDocument(
                docId, importType, key, requestHash, operator, tx.operationTime(), nextRevision, res.toSummary()
        );
        tx.putBatchImport(doc);
        return res;
    }

    private static BatchImportResult buildPreviewResult(
            String importType, String key, int totalRows, int validRows, List<RowError> errors
    ) {
        return new BatchImportResult(
                importType, true, errors.isEmpty(), key, false, "PREVIEW", 0L,
                totalRows, validRows, totalRows - validRows, 0, 0, errors, List.of()
        );
    }

    private String computeRequestHash(String importType, Object rows) {
        return sha256Hex(importType + "|" + json.writeValueAsString(rows));
    }

    private static String sha256Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(Character.forDigit((b >>> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String requireIdempotencyKey(String key) {
        if (key == null || key.isBlank() || key.trim().length() > 128) {
            throw new IllegalArgumentException("正式提交批量导入必须提供 1–128 字符的 Idempotency-Key");
        }
        return key.trim();
    }

    private static String normalizeOperator(String declared, String resolved) {
        String candidate = (declared != null && !declared.isBlank()) ? declared : resolved;
        if (candidate == null || candidate.isBlank()) return "SYSTEM_IMPORT";
        String clean = candidate.replace('\0', ' ').trim();
        return clean.length() > 100 ? clean.substring(0, 100) : clean;
    }

    private static String actorTag(String operator) {
        return "DECLARED:" + operator;
    }

    private static String cleanText(String value, int maxLen, String field, int rowIndex, boolean required, List<RowError> errors) {
        if (value == null) {
            if (required) errors.add(new RowError(rowIndex, field, "REQUIRED_FIELD", "缺少必填字段 " + field));
            return null;
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\0' || (Character.isISOControl(c) && c != '\t' && c != '\n' && c != '\r')) {
                errors.add(new RowError(rowIndex, field, "ILLEGAL_CONTROL_CHAR", "字段 " + field + " 包含非法控制字符"));
                return null;
            }
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            if (required) errors.add(new RowError(rowIndex, field, "REQUIRED_FIELD", "必填字段 " + field + " 不能为空白"));
            return null;
        }
        if (trimmed.length() > maxLen) {
            errors.add(new RowError(rowIndex, field, "MAX_LENGTH_EXCEEDED", "字段 " + field + " 超过最大长度 " + maxLen));
            return null;
        }
        return trimmed;
    }

    private static double requirePositiveFinite(Double value, String field, String label, int rowIndex, List<RowError> errors) {
        if (value == null || !Double.isFinite(value) || value <= 0.0) {
            errors.add(new RowError(rowIndex, field, "INVALID_POSITIVE_NUMBER", label + "必须为大于零的有限数值"));
            return Double.NaN;
        }
        return value;
    }

    private static double requireNonNegativeFinite(Double value, String field, String label, int rowIndex, List<RowError> errors) {
        if (value == null || !Double.isFinite(value) || value < 0.0) {
            errors.add(new RowError(rowIndex, field, "INVALID_NON_NEGATIVE_NUMBER", label + "必须为非负有限数值"));
            return Double.NaN;
        }
        return value;
    }

    private static double requirePrecisionTenth(Double value, String field, boolean positive, int rowIndex, List<RowError> errors) {
        if (value == null || !Double.isFinite(value) || (positive ? value <= 0.0 : value < 0.0)) {
            errors.add(new RowError(rowIndex, field, positive ? "INVALID_POSITIVE_NUMBER" : "INVALID_NON_NEGATIVE_NUMBER",
                    "字段 " + field + (positive ? " 必须大于 0" : " 必须非负")));
            return Double.NaN;
        }
        if (Math.abs(value * 10.0 - Math.rint(value * 10.0)) > PRECISION_EPS) {
            errors.add(new RowError(rowIndex, field, "PRECISION_VIOLATION",
                    "瑕疵位置、尺寸与安全裕量须精确到 0.1 mm：" + field));
            return Double.NaN;
        }
        return value;
    }
}
