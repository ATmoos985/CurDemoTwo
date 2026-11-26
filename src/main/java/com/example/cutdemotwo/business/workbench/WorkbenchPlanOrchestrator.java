package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.algorithm.geometry.PolygonGeometry;
import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.DefectWindowSupport;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.model.MotherRollInfo;
import com.example.cutdemotwo.business.model.RemnantStock;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationJob;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.slitting.SlittingProblem;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * 工作台编排试排服务（上层无环编排器）：
 * <ul>
 *   <li>通过 {@link CuttingStatePort#inRead} 原子只读获取任务剩余待排量、材料规格、当前版本及 {@link DefectWindowSupport} 安全避疵窗；</li>
 *   <li>释放读锁后自动装配标准 {@code NESTING_2D} 或 {@code SLITTING_1D} 请求并提交至 {@link OptimizationService} 归档；</li>
 *   <li>绝不在试排阶段写或扣任何实物库存；严格拦截待检/报废/已耗尽材料（422 {@code MATERIAL_NOT_READY}）与无剩余待排任务（422 {@code NO_OPEN_DEMAND}）。</li>
 * </ul>
 */
@Service
public class WorkbenchPlanOrchestrator {
    private static final String IDEMPOTENCY_PATTERN = "[A-Za-z0-9._:-]{8,128}";
    private static final Set<String> VALID_MATERIAL_TYPES = Set.of("STOCK_ROLL", "REMNANT", "FREE_CANVAS");
    private static final Set<String> VALID_START_CORNERS = Set.of("left-top", "right-top", "left-bottom", "right-bottom");
    private static final Set<String> VALID_FIRST_STAGE = Set.of("horizontal", "vertical");

    private final CuttingStatePort cuttingStatePort;
    private final OptimizationService optimizationService;

    public WorkbenchPlanOrchestrator(CuttingStatePort cuttingStatePort, OptimizationService optimizationService) {
        this.cuttingStatePort = Objects.requireNonNull(cuttingStatePort, "cuttingStatePort");
        this.optimizationService = Objects.requireNonNull(optimizationService, "optimizationService");
    }

    public record PlanTaskRequest(
            String materialType,
            String materialId,
            Double widthMm,
            Double windowStartMm,
            Double windowLengthMm,
            String processMode,
            String objective,
            Boolean allowGapFill,
            Double pieceGapMm,
            Double trimStartMm,
            Boolean avoidDefects,
            Integer timeLimitSeconds
    ) {}

    public record PlanJobAccepted(
            OptimizationJob job,
            WorkbenchJobSource source,
            String workbenchUrl
    ) {}

    private record OpenLine(CuttingTask.Line line, int openQty) {}

    private record PreparedSubmission(
            String taskId,
            OptimizationRequest request,
            WorkbenchJobSource source
    ) {}

    /** 按任务剩余待排量与指定材料一键装配并提交标准求解作业（纯计算、零写库）。 */
    public PlanJobAccepted submitPlanJob(String taskId, PlanTaskRequest req, String idempotencyKey, String actor) {
        if (taskId == null || taskId.isBlank()) {
            throw failure("INVALID_INPUT", "需求任务编号不能为空", 400);
        }
        if (req == null || req.materialType() == null || req.materialType().isBlank()) {
            throw failure("INVALID_INPUT", "必须指定投料类型 materialType（STOCK_ROLL | REMNANT | FREE_CANVAS）", 400);
        }
        String materialType = req.materialType().trim().toUpperCase(Locale.ROOT);
        if (!VALID_MATERIAL_TYPES.contains(materialType)) {
            throw failure("INVALID_INPUT", "不支持的投料类型: " + req.materialType() + "（仅支持 STOCK_ROLL、REMNANT、FREE_CANVAS）", 400);
        }
        String cleanTaskId = taskId.trim();
        String cleanActor = (actor == null || actor.isBlank()) ? "LOCAL" : actor.trim();

        String effectiveKey;
        if (idempotencyKey != null && !idempotencyKey.isBlank()) {
            effectiveKey = idempotencyKey.trim();
            if (!effectiveKey.matches(IDEMPOTENCY_PATTERN)) {
                throw failure("INVALID_INPUT", "Idempotency-Key 必须为 8–128 个字母、数字或 . _ : -", 400);
            }
        } else {
            effectiveKey = "wb-" + UUID.randomUUID();
        }
        String clientRequestId = buildClientRequestId(cleanTaskId, effectiveKey);

        validateOptionalNumbers(req);

        // 在单一只读事务内原子读取任务、待排余量、材料状态、避疵窗与版本号；读毕立即释放读锁后再提交计算。
        PreparedSubmission prepared = cuttingStatePort.inRead(tx ->
                prepareSubmission(tx, cleanTaskId, materialType, req, clientRequestId, cleanActor)
        );

        OptimizationJob job = optimizationService.submit(effectiveKey, prepared.request(), prepared.source());
        StoredOptimizationJob stored = optimizationService.findJobWithSource(job.id());
        WorkbenchJobSource effectiveSource = stored != null && stored.workbenchSource() != null
                ? stored.workbenchSource()
                : prepared.source();
        String workbenchUrl = WorkbenchTaskViewSupport.buildWorkbenchUrl(cleanTaskId, job.id(), null);
        return new PlanJobAccepted(job, effectiveSource, workbenchUrl);
    }

    private PreparedSubmission prepareSubmission(
            CuttingStatePort.ReadView tx,
            String taskId,
            String materialType,
            PlanTaskRequest req,
            String clientRequestId,
            String actor
    ) {
        CuttingTask task = tx.findTask(taskId)
                .orElseThrow(() -> failure("NOT_FOUND", "需求任务不存在: " + taskId, 404));

        Map<Integer, Integer> openByLine = WorkbenchTaskViewSupport.openQuantitiesByLineId(tx, task);
        List<OpenLine> openLines = new ArrayList<>();
        for (CuttingTask.Line line : task.demands()) {
            int openQty = openByLine.getOrDefault(line.id(), 0);
            if (openQty > 0) {
                openLines.add(new OpenLine(line, openQty));
            }
        }
        if (openLines.isEmpty()) {
            throw failure("NO_OPEN_DEMAND", "任务 " + taskId + " 当前无剩余待排需求（openQty 均为 0），无需重复试排", 422);
        }

        boolean avoidDefects = !Boolean.FALSE.equals(req.avoidDefects());
        String dimension = WorkbenchTaskViewSupport.inferTaskDimension(task);
        boolean isSlittingTask = task.slittingTask();

        String materialId;
        long materialRevision;
        double physicalWidthMm;
        double windowStartMm;
        double windowLengthMm;
        String materialLabel;
        List<Defect> windowDefects = List.of();

        switch (materialType) {
            case "STOCK_ROLL" -> {
                if (req.materialId() == null || req.materialId().isBlank()) {
                    throw failure("INVALID_INPUT", "实体母卷投料必须指定 materialId", 400);
                }
                String rollId = req.materialId().trim();
                MotherRollInfo roll = tx.findRoll(rollId)
                        .orElseThrow(() -> failure("NOT_FOUND", "母卷不存在: " + rollId, 404));
                validateStockRollReady(roll);

                physicalWidthMm = WorkbenchTaskViewSupport.quantize01(roll.getWidth());
                if (req.widthMm() != null && Math.abs(req.widthMm() - physicalWidthMm) > 0.15) {
                    throw failure("INVALID_INPUT", "请求门幅(" + req.widthMm() + "mm)与母卷实际幅宽(" + physicalWidthMm + "mm)不一致", 422);
                }
                double usedLen = WorkbenchTaskViewSupport.quantize01(Math.max(0.0, roll.getUsedLength()));
                double totalLen = WorkbenchTaskViewSupport.quantize01(roll.getTotalLength());
                windowStartMm = req.windowStartMm() != null
                        ? WorkbenchTaskViewSupport.quantize01(req.windowStartMm())
                        : usedLen;
                if (windowStartMm + 0.05 < usedLen || windowStartMm >= totalLen - 0.1) {
                    throw failure("INVALID_WINDOW", "工位起点 " + windowStartMm + "mm 落入母卷已切割区或超出母卷总长 " + totalLen + "mm", 422);
                }
                double remainingFromStart = WorkbenchTaskViewSupport.quantize01(Math.max(0.0, totalLen - windowStartMm));
                if (req.windowLengthMm() != null) {
                    windowLengthMm = WorkbenchTaskViewSupport.quantize01(req.windowLengthMm());
                    if (windowLengthMm <= 0 || windowStartMm + windowLengthMm > totalLen + 0.05) {
                        throw failure("INVALID_WINDOW", "请求工位窗长 " + windowLengthMm + "mm 超出母卷可用余长 " + remainingFromStart + "mm", 422);
                    }
                } else if (isSlittingTask) {
                    windowLengthMm = remainingFromStart;
                } else {
                    double baseTrim = resolveTrimStart(req, task, false);
                    double baseGap = resolvePieceGap(req, task);
                    double estimated = estimateWindowLength2D(openLines, physicalWidthMm, task, baseGap, baseTrim);
                    windowLengthMm = WorkbenchTaskViewSupport.quantize01(Math.min(remainingFromStart, estimated));
                }
                if (windowLengthMm < 1.0) {
                    throw failure("MATERIAL_NOT_READY", "母卷 " + rollId + " 剩余可排长度不足", 422);
                }
                if (avoidDefects) {
                    windowDefects = DefectWindowSupport.sliceForWindow(roll.getDefects(), windowStartMm, windowLengthMm, physicalWidthMm);
                }
                materialId = roll.getRollId();
                materialRevision = tx.currentRevision();
                materialLabel = roll.getRollId() + " (" + Objects.toString(roll.getRollModel(), "母卷")
                        + " · " + Math.round(physicalWidthMm) + "mm)";
            }
            case "REMNANT" -> {
                if (isSlittingTask) {
                    throw failure("UNSUPPORTED_CONSTRAINT", "一维分切任务不支持在二维料头上排料，请选择母卷或自由画布", 422);
                }
                if (req.materialId() == null || req.materialId().isBlank()) {
                    throw failure("INVALID_INPUT", "料头投料必须指定 materialId", 400);
                }
                String remId = req.materialId().trim();
                RemnantStock remnant = tx.findRemnant(remId)
                        .orElseThrow(() -> failure("NOT_FOUND", "料头不存在: " + remId, 404));
                validateRemnantReady(remnant);

                physicalWidthMm = WorkbenchTaskViewSupport.quantize01(remnant.getWidth());
                if (req.widthMm() != null && Math.abs(req.widthMm() - physicalWidthMm) > 0.15) {
                    throw failure("INVALID_INPUT", "请求门幅(" + req.widthMm() + "mm)与料头实际幅宽(" + physicalWidthMm + "mm)不一致", 422);
                }
                if (req.windowStartMm() != null && Math.abs(req.windowStartMm()) > 0.05) {
                    throw failure("INVALID_WINDOW", "料头排料起点 windowStartMm 必须为 0", 422);
                }
                windowStartMm = 0.0;
                double remLen = WorkbenchTaskViewSupport.quantize01(remnant.getLength());
                windowLengthMm = req.windowLengthMm() != null
                        ? WorkbenchTaskViewSupport.quantize01(req.windowLengthMm())
                        : remLen;
                if (windowLengthMm <= 0 || windowLengthMm > remLen + 0.05) {
                    throw failure("INVALID_WINDOW", "请求窗长 " + windowLengthMm + "mm 超出料头实际长度 " + remLen + "mm", 422);
                }
                if (avoidDefects) {
                    windowDefects = DefectWindowSupport.sliceForWindow(remnant.getDefects(), 0.0, windowLengthMm, physicalWidthMm);
                }
                materialId = remnant.getId();
                materialRevision = tx.currentRevision();
                materialLabel = remnant.getId() + " (料头 " + Math.round(physicalWidthMm) + "×" + Math.round(remLen) + "mm)";
            }
            case "FREE_CANVAS" -> {
                if (req.widthMm() != null && req.widthMm() > 0) {
                    physicalWidthMm = WorkbenchTaskViewSupport.quantize01(req.widthMm());
                } else if (isSlittingTask && task.slitting() != null) {
                    physicalWidthMm = task.slitting().maxWidth() + task.slitting().leftTrim() + task.slitting().rightTrim();
                } else {
                    throw failure("INVALID_INPUT", "自由画布模式（FREE_CANVAS）必须指定正数门幅 widthMm", 400);
                }
                windowStartMm = req.windowStartMm() != null ? WorkbenchTaskViewSupport.quantize01(req.windowStartMm()) : 0.0;
                if (windowStartMm < 0) {
                    throw failure("INVALID_INPUT", "windowStartMm 不能为负数", 400);
                }
                if (req.windowLengthMm() != null && req.windowLengthMm() > 0) {
                    windowLengthMm = WorkbenchTaskViewSupport.quantize01(req.windowLengthMm());
                } else if (isSlittingTask) {
                    double maxLen = openLines.stream().mapToDouble(ol -> ol.line().length()).max().orElse(10000.0);
                    windowLengthMm = WorkbenchTaskViewSupport.quantize01(Math.max(1000.0, maxLen));
                } else {
                    double baseTrim = resolveTrimStart(req, task, false);
                    double baseGap = resolvePieceGap(req, task);
                    windowLengthMm = WorkbenchTaskViewSupport.quantize01(
                            estimateWindowLength2D(openLines, physicalWidthMm, task, baseGap, baseTrim)
                    );
                }
                materialId = (req.materialId() != null && !req.materialId().isBlank())
                        ? req.materialId().trim()
                        : "FREE-" + Math.round(physicalWidthMm) + "x" + Math.round(windowLengthMm);
                materialRevision = 0L;
                materialLabel = "自由画布 (" + Math.round(physicalWidthMm) + "×" + Math.round(windowLengthMm) + "mm)";
            }
            default -> throw failure("INVALID_INPUT", "未知投料类型: " + materialType, 400);
        }

        if (isSlittingTask) {
            return buildSlittingSubmission(
                    task, openLines, materialType, materialId, materialRevision,
                    physicalWidthMm, windowStartMm, windowLengthMm, materialLabel,
                    avoidDefects, req, clientRequestId, actor
            );
        }
        return buildNesting2DSubmission(
                task, dimension, openLines, materialType, materialId, materialRevision,
                physicalWidthMm, windowStartMm, windowLengthMm, materialLabel,
                avoidDefects, windowDefects, req, clientRequestId, actor
        );
    }

    private PreparedSubmission buildSlittingSubmission(
            CuttingTask task,
            List<OpenLine> openLines,
            String materialType,
            String materialId,
            long materialRevision,
            double physicalWidthMm,
            double windowStartMm,
            double windowLengthMm,
            String materialLabel,
            boolean avoidDefects,
            PlanTaskRequest req,
            String clientRequestId,
            String actor
    ) {
        if (req.processMode() != null && !req.processMode().isBlank()
                && !"SLITTING_1D".equalsIgnoreCase(req.processMode().trim())) {
            throw failure("UNSUPPORTED_CONSTRAINT", "一维分切任务不支持指定二维工艺模式: " + req.processMode(), 422);
        }
        String profile = "FAST";
        if (req.objective() != null && !req.objective().isBlank()) {
            String rawObj = req.objective().trim().toUpperCase(Locale.ROOT);
            if ("FAST".equals(rawObj) || "QUALITY".equals(rawObj)) {
                profile = rawObj;
            } else {
                throw failure("INVALID_INPUT", "一维分切目标策略仅支持 FAST 或 QUALITY，当前收到: " + req.objective(), 400);
            }
        }
        int timeLimit = req.timeLimitSeconds() == null ? 10 : req.timeLimitSeconds();
        if (timeLimit < 1 || timeLimit > 180) {
            throw failure("INVALID_INPUT", "一维分切求解时限须在 1–180 秒之间", 400);
        }

        int motherWidthMm = (int) Math.floor(physicalWidthMm);
        CuttingTask.Slitting slit = task.slitting();
        int leftTrim = slit != null ? slit.leftTrim() : 10;
        int rightTrim = slit != null ? slit.rightTrim() : 10;
        int usableWidth = motherWidthMm - leftTrim - rightTrim;
        if (usableWidth <= 0) {
            throw failure("UNSUPPORTED_CONSTRAINT", "母卷幅宽(" + motherWidthMm + "mm)扣除左右切边后无可用宽度", 422);
        }

        int maxOrderWidth = openLines.stream().mapToInt(ol -> (int) Math.rint(ol.line().width())).max().orElse(100);
        if (maxOrderWidth > usableWidth) {
            throw failure("UNSUPPORTED_CONSTRAINT", "最大订单宽幅(" + maxOrderWidth + "mm)超过材料可用幅宽(" + usableWidth + "mm)", 422);
        }
        int configuredMaxW = slit != null ? slit.maxWidth() : usableWidth;
        int effectiveMaxW = Math.max(maxOrderWidth, Math.min(configuredMaxW, usableWidth));
        int configuredMinW = slit != null ? slit.minWidth() : Math.min(maxOrderWidth, (int) Math.floor(effectiveMaxW * 0.8));
        int effectiveMinW = Math.max(1, Math.min(effectiveMaxW, configuredMinW));
        int step = slit != null && slit.widthStep() > 0 ? slit.widthStep() : 10;
        while ((effectiveMaxW - effectiveMinW) / step > 1000) {
            step = Math.max(step + 1, (int) Math.ceil((effectiveMaxW - effectiveMinW) / 900.0));
        }
        int totalOverCap = slit != null ? slit.totalOverCap() : 20;

        List<SlittingProblem.Order> orders = new ArrayList<>(openLines.size());
        Map<Integer, Integer> sourceLines = new LinkedHashMap<>();
        int index = 1;
        for (OpenLine ol : openLines) {
            CuttingTask.Line line = ol.line();
            int orderWidth = (int) Math.rint(line.width());
            long orderLen = Math.max(1L, Math.round(line.length()));
            String surface = (line.surfaceTreatment() == null || line.surfaceTreatment().isBlank())
                    ? "不电晕/不涂布"
                    : line.surfaceTreatment().trim();
            String orderId = String.valueOf(line.id());
            orders.add(new SlittingProblem.Order(orderId, orderWidth, orderLen, ol.openQty(), surface));
            sourceLines.put(index++, line.id());
        }

        SlittingProblem problem = new SlittingProblem(
                "1", "mm", motherWidthMm, leftTrim, rightTrim,
                effectiveMinW, effectiveMaxW, step, totalOverCap,
                profile, orders, timeLimit
        );
        OptimizationRequest request = new OptimizationRequest(
                "2.0", "SLITTING_1D", clientRequestId, problem, false, false, null
        );
        WorkbenchJobSource source = new WorkbenchJobSource(
                task.id(), actor, task.revision(), materialType, materialId, materialRevision,
                physicalWidthMm, windowStartMm, windowLengthMm, 0.0, sourceLines,
                "SLITTING_1D", materialLabel, avoidDefects, 0.0, 0.0
        );
        return new PreparedSubmission(task.id(), request, source);
    }

    private PreparedSubmission buildNesting2DSubmission(
            CuttingTask task,
            String dimension,
            List<OpenLine> openLines,
            String materialType,
            String materialId,
            long materialRevision,
            double physicalWidthMm,
            double windowStartMm,
            double windowLengthMm,
            String materialLabel,
            boolean avoidDefects,
            List<Defect> windowDefects,
            PlanTaskRequest req,
            String clientRequestId,
            String actor
    ) {
        boolean hasContourOrHoles = openLines.stream().anyMatch(ol ->
                ol.line().shape() != null
                        && ("POLYGON".equals(ol.line().shape().type()) || ol.line().shape().hasHoles())
        );
        String mode = resolveProcessMode2D(req.processMode(), hasContourOrHoles);
        boolean isContour = "CONTOUR".equals(mode);
        boolean isCrosscut = "CROSSCUT".equals(mode);

        int timeLimit = req.timeLimitSeconds() == null ? 5 : req.timeLimitSeconds();
        if (timeLimit < 1 || timeLimit > 60) {
            throw failure("INVALID_INPUT", "二维排料求解时限须在 1–60 秒之间", 400);
        }

        double pieceGap = resolvePieceGap(req, task);
        if (isCrosscut && pieceGap > 0) {
            throw failure("UNSUPPORTED_CONSTRAINT", "横切模式（CROSSCUT）暂不支持非零裁片间距 pieceGapMm", 422);
        }
        double rawTrim = resolveTrimStart(req, task, "REMNANT".equals(materialType));
        double effectiveTrim = (rawTrim > 0 && rawTrim < windowLengthMm - 1.0) ? rawTrim : 0.0;

        // 直刀 GUILLOTINE 间距外扩策略与前端 nesting-request-adapter.js 及后端 FabricSolveAdapter 保持完全同口径
        double rectGapPadding = ("GUILLOTINE".equals(mode) && pieceGap > 0) ? pieceGap : 0.0;
        double solverMaterialW = WorkbenchTaskViewSupport.quantize01(physicalWidthMm + rectGapPadding);
        double solverMaterialH = WorkbenchTaskViewSupport.quantize01(windowLengthMm + rectGapPadding);

        List<NestingProblem.Part> parts = new ArrayList<>(openLines.size());
        Map<Integer, Integer> sourceLines = new LinkedHashMap<>();
        boolean allFitWidth = true;

        for (OpenLine ol : openLines) {
            CuttingTask.Line line = ol.line();
            double lineW = Math.max(0.1, WorkbenchTaskViewSupport.quantize01(line.width()));
            double lineL = Math.max(0.1, WorkbenchTaskViewSupport.quantize01(line.length()));
            NestingProblem.Shape shape;
            if (isContour) {
                shape = toContourShape(line, lineW, lineL);
                try {
                    PolygonGeometry.validate(shape);
                } catch (RuntimeException invalidGeo) {
                    throw failure("INVALID_INPUT", "裁片「" + line.name() + "」几何轮廓无效：" + invalidGeo.getMessage(), 400);
                }
            } else {
                double paddedW = WorkbenchTaskViewSupport.quantize01(lineW + rectGapPadding);
                double paddedL = WorkbenchTaskViewSupport.quantize01(lineL + rectGapPadding);
                shape = NestingProblem.Shape.rectangle(paddedW, paddedL);
            }
            boolean allowRot = line.allowRotation();
            Boolean allowHalfTurn = isContour && Boolean.TRUE.equals(line.allowHalfTurn()) ? Boolean.TRUE : null;
            parts.add(new NestingProblem.Part(line.id(), line.name(), shape, ol.openQty(), allowRot, allowHalfTurn));
            sourceLines.put(line.id(), line.id());

            double baseW = isContour ? shape.width() : lineW;
            double baseH = isContour ? shape.height() : lineL;
            if (baseW > physicalWidthMm + 0.05 && !(allowRot && baseH <= physicalWidthMm + 0.05)) {
                allFitWidth = false;
            }
        }

        List<NestingProblem.Exclusion> exclusions = new ArrayList<>();
        if (avoidDefects && windowDefects != null) {
            for (Defect d : windowDefects) {
                if (d == null) continue;
                double x0 = Math.max(0.0, WorkbenchTaskViewSupport.quantize01(d.getX()));
                double y0 = Math.max(0.0, WorkbenchTaskViewSupport.quantize01(d.getY()));
                double x1 = Math.min(physicalWidthMm, WorkbenchTaskViewSupport.quantize01(d.getX() + d.getW()));
                double y1 = Math.min(windowLengthMm, WorkbenchTaskViewSupport.quantize01(d.getY() + d.getH()));
                double ew = WorkbenchTaskViewSupport.quantize01(x1 - x0);
                double eh = WorkbenchTaskViewSupport.quantize01(y1 - y0);
                if (ew >= 0.1 && eh >= 0.1 && x0 < solverMaterialW && y0 < solverMaterialH) {
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1, x0, y0, NestingProblem.Shape.rectangle(ew, eh), 0.0
                    ));
                }
            }
        }
        // 轮廓模式将首端修边转为顶部禁入区，满足 CONTOUR trimStart=0 契约并真实保留修边避让
        if (isContour && effectiveTrim >= 0.1 && exclusions.size() < 128) {
            exclusions.add(new NestingProblem.Exclusion(
                    exclusions.size() + 1, 0.0, 0.0, NestingProblem.Shape.rectangle(solverMaterialW, effectiveTrim), 0.0
            ));
        }
        if (isContour && exclusions.size() > 128) {
            exclusions = new ArrayList<>(exclusions.subList(0, 128));
        }

        boolean shortenObjective = false;
        String processObjective;
        if (isCrosscut) {
            processObjective = "INPUT_ORDER";
        } else if (req.objective() == null || req.objective().isBlank()) {
            processObjective = "MAXIMIZE_PIECE_AREA";
        } else {
            String rawObj = req.objective().trim().toUpperCase(Locale.ROOT);
            if ("MINIMIZE_LENGTH".equals(rawObj) || "SHORTEN_LENGTH".equals(rawObj)) {
                shortenObjective = true;
                processObjective = "MAXIMIZE_PIECE_AREA";
            } else if ("MAXIMIZE_PIECE_AREA".equals(rawObj) || "INPUT_ORDER".equals(rawObj)) {
                processObjective = rawObj;
            } else {
                throw failure("INVALID_INPUT", "不支持的二维优化目标: " + req.objective(), 400);
            }
        }

        String startCorner = isContour
                ? "left-top"
                : validOrDefault(task.process() != null ? task.process().cutOrigin() : null, VALID_START_CORNERS, "left-top");
        String firstStage = isContour
                ? "none"
                : isCrosscut
                ? "horizontal"
                : validOrDefault(task.process() != null ? task.process().firstStageOrientation() : null, VALID_FIRST_STAGE, "horizontal");
        double minRemW = isContour ? 0.0 : 200.0;
        double minRemH = isContour ? 0.0 : 300.0;

        NestingProblem.Material material = new NestingProblem.Material(
                materialId,
                NestingProblem.Shape.rectangle(solverMaterialW, solverMaterialH),
                exclusions,
                false
        );
        NestingProblem.Process process = new NestingProblem.Process(
                mode,
                "SHEET",
                startCorner,
                firstStage,
                isContour ? 0.0 : effectiveTrim,
                minRemW,
                minRemH,
                0.0,
                processObjective,
                isContour ? pieceGap : 0.0
        );
        String engine = isCrosscut ? "crosscut" : "auto";
        NestingProblem problem = new NestingProblem("1", "mm", material, parts, process, engine, timeLimit);

        boolean wantGapFill = Boolean.TRUE.equals(req.allowGapFill());
        OptimizationRequest.Strategy strategy = null;
        boolean requireComplete = false;
        if (isContour && allFitWidth && (wantGapFill || shortenObjective)) {
            Map<Integer, Integer> gapFillLimits = null;
            if (wantGapFill) {
                gapFillLimits = new LinkedHashMap<>();
                int cap = Math.min(80, parts.size());
                for (int i = 0; i < cap; i++) {
                    NestingProblem.Part part = parts.get(i);
                    gapFillLimits.put(part.id(), Math.min(80, Math.max(2, part.quantity())));
                }
            }
            strategy = new OptimizationRequest.Strategy("marker-shortening", "2", 7, gapFillLimits);
            requireComplete = true;
        }

        OptimizationRequest request = new OptimizationRequest(
                "2.0", "NESTING_2D", clientRequestId, problem, true, requireComplete, strategy
        );
        WorkbenchJobSource source = new WorkbenchJobSource(
                task.id(), actor, task.revision(), materialType, materialId, materialRevision,
                physicalWidthMm, windowStartMm, windowLengthMm, rectGapPadding, sourceLines,
                dimension, materialLabel, avoidDefects, effectiveTrim, pieceGap
        );
        return new PreparedSubmission(task.id(), request, source);
    }

    private static void validateOptionalNumbers(PlanTaskRequest req) {
        if (req.widthMm() != null && (!Double.isFinite(req.widthMm()) || req.widthMm() <= 0 || req.widthMm() > 100_000)) {
            throw failure("INVALID_INPUT", "门幅 widthMm 必须为有效正数（<= 100000 mm）", 400);
        }
        if (req.windowStartMm() != null && (!Double.isFinite(req.windowStartMm()) || req.windowStartMm() < 0)) {
            throw failure("INVALID_INPUT", "工位起点 windowStartMm 不能为负数", 400);
        }
        if (req.windowLengthMm() != null && (!Double.isFinite(req.windowLengthMm()) || req.windowLengthMm() <= 0)) {
            throw failure("INVALID_INPUT", "工位窗长 windowLengthMm 必须为正数", 400);
        }
        if (req.trimStartMm() != null && (!Double.isFinite(req.trimStartMm()) || req.trimStartMm() < 0)) {
            throw failure("INVALID_INPUT", "卷头修边 trimStartMm 不能为负数", 400);
        }
        if (req.pieceGapMm() != null) {
            try {
                NestingProblem.Process.validatePieceGap(req.pieceGapMm());
            } catch (IllegalArgumentException invalid) {
                throw failure("INVALID_INPUT", invalid.getMessage(), 400);
            }
        }
    }

    private static void validateStockRollReady(MotherRollInfo roll) {
        String status = roll.getInspectionStatus() == null ? "UNKNOWN" : roll.getInspectionStatus().trim().toUpperCase(Locale.ROOT);
        if (roll.getScrappedAt() != null || "SCRAPPED".equals(status)) {
            throw failure("MATERIAL_NOT_READY", "母卷 " + roll.getRollId() + " 已报废，禁止用于排料", 422);
        }
        if (!"PASSED".equals(status)) {
            throw failure("MATERIAL_NOT_READY", "母卷 " + roll.getRollId() + " 当前质检状态为 " + status + "，未质检合格放行前禁止排料", 422);
        }
        if (roll.getCurrentRemainingLength() <= 0.1 || roll.getUsedLength() >= roll.getTotalLength() - 0.1) {
            throw failure("MATERIAL_NOT_READY", "母卷 " + roll.getRollId() + " 已消耗完毕（剩余长度不足），无法用于排料", 422);
        }
        if (roll.getWidth() <= 0.1 || roll.getTotalLength() <= 0.1) {
            throw failure("MATERIAL_NOT_READY", "母卷 " + roll.getRollId() + " 物理尺寸无效", 422);
        }
    }

    private static void validateRemnantReady(RemnantStock remnant) {
        String status = remnant.getStatus() == null ? "UNKNOWN" : remnant.getStatus().trim().toUpperCase(Locale.ROOT);
        if (!"AVAILABLE".equals(status)) {
            throw failure("MATERIAL_NOT_READY", "料头 " + remnant.getId() + " 当前状态为 " + status + "，仅在库可用（AVAILABLE）料头允许排料", 422);
        }
        if (remnant.getWidth() <= 0.1 || remnant.getLength() <= 0.1) {
            throw failure("MATERIAL_NOT_READY", "料头 " + remnant.getId() + " 物理尺寸无效", 422);
        }
    }

    private static String resolveProcessMode2D(String requestedMode, boolean hasContourOrHoles) {
        if (requestedMode == null || requestedMode.isBlank()) {
            return hasContourOrHoles ? "CONTOUR" : "GUILLOTINE";
        }
        String normalized = requestedMode.trim().toUpperCase(Locale.ROOT);
        if ("SLITTING_1D".equals(normalized)) {
            throw failure("UNSUPPORTED_CONSTRAINT", "二维任务不支持一维分切模式 SLITTING_1D", 422);
        }
        if (!Set.of("GUILLOTINE", "CONTOUR", "CROSSCUT").contains(normalized)) {
            throw failure("INVALID_INPUT", "不支持的二维切割工艺: " + requestedMode, 400);
        }
        if (hasContourOrHoles && !"CONTOUR".equals(normalized)) {
            throw failure("UNSUPPORTED_CONSTRAINT", "任务包含异形轮廓或内孔裁片，必须使用 CONTOUR 轮廓工艺", 422);
        }
        return normalized;
    }

    private static NestingProblem.Shape toContourShape(CuttingTask.Line line, double w, double h) {
        NestingProblem.Shape raw = line.shape();
        if (raw != null && "POLYGON".equals(raw.type()) && raw.vertices() != null && raw.vertices().size() >= 3) {
            return raw;
        }
        List<NestingProblem.Point> rectVerts = List.of(
                new NestingProblem.Point(0, 0),
                new NestingProblem.Point(w, 0),
                new NestingProblem.Point(w, h),
                new NestingProblem.Point(0, h)
        );
        List<List<NestingProblem.Point>> holes = (raw != null && raw.hasHoles()) ? raw.holes() : List.of();
        return new NestingProblem.Shape("POLYGON", w, h, rectVerts, holes);
    }

    private static double resolvePieceGap(PlanTaskRequest req, CuttingTask task) {
        if (req.pieceGapMm() != null) {
            return WorkbenchTaskViewSupport.quantize01(Math.max(0.0, req.pieceGapMm()));
        }
        double fromTask = task.process() != null && task.process().pieceGap() != null ? task.process().pieceGap() : 0.0;
        return WorkbenchTaskViewSupport.quantize01(Math.max(0.0, fromTask));
    }

    private static double resolveTrimStart(PlanTaskRequest req, CuttingTask task, boolean isRemnant) {
        if (req.trimStartMm() != null) {
            return WorkbenchTaskViewSupport.quantize01(Math.max(0.0, req.trimStartMm()));
        }
        if (isRemnant) {
            return 0.0;
        }
        double fromTask = task.process() != null ? task.process().trimStart() : 0.0;
        return WorkbenchTaskViewSupport.quantize01(Math.max(0.0, fromTask));
    }

    private static double estimateWindowLength2D(
            List<OpenLine> openLines,
            double widthMm,
            CuttingTask task,
            double pieceGapMm,
            double trimStartMm
    ) {
        double rowX = 0.0;
        double rowY = trimStartMm;
        double rowH = 0.0;
        for (OpenLine ol : openLines) {
            double pw = Math.max(0.1, ol.line().width());
            double pl = Math.max(0.1, ol.line().length());
            for (int i = 0; i < ol.openQty(); i++) {
                if (rowX + pw > widthMm + 0.01) {
                    rowY += rowH + pieceGapMm;
                    rowX = 0.0;
                    rowH = 0.0;
                }
                rowX += pw + pieceGapMm;
                rowH = Math.max(rowH, pl);
            }
        }
        double taskBed = (task.process() != null && task.process().bedLength() > 0) ? task.process().bedLength() : 2000.0;
        return Math.max(taskBed, Math.ceil(rowY + rowH + 180.0));
    }

    private static String validOrDefault(String value, Set<String> allowed, String fallback) {
        if (value != null && allowed.contains(value)) {
            return value;
        }
        return fallback;
    }

    /** 生成确定性但不回显幂等键明文的 clientRequestId，确保同幂等键重放命中且不泄露 Idempotency-Key。 */
    private static String buildClientRequestId(String taskId, String key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(("workbench-client-req\0" + taskId + "\0" + key).getBytes(StandardCharsets.UTF_8));
            String shortHash = HexFormat.of().formatHex(digest).substring(0, 16);
            String candidate = "wb-" + taskId + "-" + shortHash;
            return candidate.length() <= 128 ? candidate : "wb-" + shortHash;
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static OptimizationFailure failure(String code, String message, int status) {
        return new OptimizationFailure(code, message, status, false);
    }
}
