package com.example.cutdemotwo.business.workbench;

import com.example.cutdemotwo.business.cutting.CuttingStatePort;
import com.example.cutdemotwo.business.cutting.DefectWindowSupport;
import com.example.cutdemotwo.business.cutting.GlobalPlanningService;
import com.example.cutdemotwo.business.model.CuttingTask;
import com.example.cutdemotwo.business.optimization.OptimizationService;
import com.example.cutdemotwo.contracts.geometry.Defect;
import com.example.cutdemotwo.contracts.jobs.OptimizationFailure;
import com.example.cutdemotwo.contracts.jobs.OptimizationRequest;
import com.example.cutdemotwo.contracts.jobs.StoredOptimizationJob;
import com.example.cutdemotwo.contracts.jobs.WorkbenchJobSource;
import com.example.cutdemotwo.contracts.jobs.WorkbenchSchemeDraft;
import com.example.cutdemotwo.contracts.nesting.NestingProblem;
import com.example.cutdemotwo.contracts.nesting.NestingResult;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 多料头接力 + 多母卷连续接力批量草案编排服务（纯规划，绝不锁定或扣减实物库存）：
 * <ol>
 *   <li>调用 {@link GlobalPlanningService#planMultiMaterial} 执行料头迭代接力与多母卷连续接力；</li>
 *   <li>为每块被采纳的料头与每卷被采纳的接力母卷同步归档生成 {@code resultId}；</li>
 *   <li>生成共享同一 {@code batchGroupId} 的一组持久化 {@link WorkbenchSchemeDraft}。</li>
 * </ol>
 */
@Service
public class MultiMaterialDraftOrchestrationService {

    private final CuttingStatePort cuttingStatePort;
    private final GlobalPlanningService globalPlanningService;
    private final OptimizationService optimizationService;
    private final WorkbenchDraftService workbenchDraftService;
    private final JsonMapper jsonMapper = JsonMapper.builder().build();
    private final ConcurrentHashMap<String, IdempotencyLockEntry> idempotencyLocks = new ConcurrentHashMap<>();
    private final Map<String, CachedIdempotentBatch> idempotencyCache = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedIdempotentBatch> eldest) {
                    return size() > 256;
                }
            }
    );

    private static final class IdempotencyLockEntry {
        final ReentrantLock lock = new ReentrantLock();
        int refs = 0;
    }

    private record CachedIdempotentBatch(
            String batchGroupId,
            String requestFingerprint,
            GlobalPlanningService.MultiMaterialPlanResult planResult,
            List<String> warnings
    ) {}

    private record CanonicalBatchRequest(
            String taskId,
            String materialModel,
            String requiredBatchNo,
            String requiredColor,
            Boolean preferRemnants,
            Integer maxRemnants,
            List<String> candidateRollIds,
            Long timeBudgetMs,
            Double pieceGapMm,
            Double trimStartMm,
            List<GlobalPlanningService.DemandItem> demands,
            boolean continueAcrossRolls,
            String note,
            long ttlSeconds
    ) {}

    public MultiMaterialDraftOrchestrationService(
            CuttingStatePort cuttingStatePort,
            GlobalPlanningService globalPlanningService,
            OptimizationService optimizationService,
            WorkbenchDraftService workbenchDraftService
    ) {
        this.cuttingStatePort = Objects.requireNonNull(cuttingStatePort, "cuttingStatePort");
        this.globalPlanningService = Objects.requireNonNull(globalPlanningService, "globalPlanningService");
        this.optimizationService = Objects.requireNonNull(optimizationService, "optimizationService");
        this.workbenchDraftService = Objects.requireNonNull(workbenchDraftService, "workbenchDraftService");
    }

    public record MultiMaterialDraftBatchRequest(
            String taskId,
            String materialModel,
            String requiredBatchNo,
            String requiredColor,
            Boolean preferRemnants,
            Integer maxRemnants,
            List<String> candidateRollIds,
            Long timeBudgetMs,
            Double pieceGapMm,
            Double trimStartMm,
            List<GlobalPlanningService.DemandItem> demands,
            Boolean continueAcrossRolls,
            String note,
            Long ttlSeconds
    ) {}

    public record MultiMaterialDraftBatchResponse(
            String batchGroupId,
            boolean inventoryMutated,
            boolean requiresHumanConfirmation,
            int draftCount,
            List<WorkbenchSchemeDraft> drafts,
            GlobalPlanningService.MultiMaterialPlanResult planResult,
            List<String> warnings
    ) {}

    private record DemandSpec(
            int id,
            String name,
            double width,
            double length,
            boolean allowRotation,
            Boolean allowHalfTurn,
            NestingProblem.Shape shape,
            Integer sourceLineId
    ) {}

    private record ContextSnapshot(
            String taskId,
            long taskRevision,
            long materialRevision,
            double pieceGapMm,
            double trimStartMm,
            Map<Integer, DemandSpec> demandSpecs
    ) {}

    public MultiMaterialDraftBatchResponse createMultiMaterialDrafts(
            MultiMaterialDraftBatchRequest req,
            String idempotencyKey,
            String actor
    ) {
        if (req == null) {
            throw failure("INVALID_INPUT", "多料批量草案请求不能为空", 400);
        }
        String cleanTaskId = blankToNull(req.taskId());
        String cleanModel = blankToNull(req.materialModel());
        boolean hasDemands = req.demands() != null && !req.demands().isEmpty();
        if (cleanTaskId == null && cleanModel == null && !hasDemands) {
            throw failure("INVALID_INPUT", "请至少提供 taskId、materialModel 或非空 demands 之一", 400);
        }
        long ttlSeconds = req.ttlSeconds() == null ? WorkbenchDraftService.DEFAULT_TTL_SECONDS : req.ttlSeconds();
        if (ttlSeconds < WorkbenchDraftService.MIN_TTL_SECONDS || ttlSeconds > WorkbenchDraftService.MAX_TTL_SECONDS) {
            throw failure("INVALID_INPUT", "草案有效期 ttlSeconds 须在 1–86400 秒之间", 400);
        }
        String cleanNote = blankToNull(req.note());
        if (cleanNote != null && cleanNote.length() > 500) {
            throw failure("INVALID_INPUT", "草案备注长度不能超过 500 字符", 400);
        }

        String cleanIdemKey = blankToNull(idempotencyKey);
        if (cleanIdemKey != null) {
            return withIdempotencyLock(cleanIdemKey, () ->
                    createMultiMaterialDraftsInternal(req, cleanTaskId, cleanModel, cleanNote, ttlSeconds, cleanIdemKey, actor)
            );
        }
        return createMultiMaterialDraftsInternal(req, cleanTaskId, cleanModel, cleanNote, ttlSeconds, null, actor);
    }

    private MultiMaterialDraftBatchResponse createMultiMaterialDraftsInternal(
            MultiMaterialDraftBatchRequest req,
            String cleanTaskId,
            String cleanModel,
            String cleanNote,
            long ttlSeconds,
            String cleanIdemKey,
            String actor
    ) {
        boolean continueAcrossRolls = !Boolean.FALSE.equals(req.continueAcrossRolls());
        String requestFingerprint = computeRequestFingerprint(
                req, cleanTaskId, cleanModel, cleanNote, ttlSeconds, continueAcrossRolls
        );
        String batchGroupId = cleanIdemKey != null
                ? deriveBatchGroupId(cleanIdemKey)
                : ("MMB-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase(Locale.ROOT));
        String keySeed = cleanIdemKey != null ? cleanIdemKey : batchGroupId;

        if (cleanIdemKey != null) {
            WorkbenchDraftService.DraftListPage existingPage = workbenchDraftService.listDrafts(
                    "ALL", null, batchGroupId, 0, 100
            );
            if (!existingPage.items().isEmpty()) {
                List<WorkbenchSchemeDraft> existingDrafts = existingPage.items().stream()
                        .sorted(Comparator.comparingInt((WorkbenchSchemeDraft d) ->
                                        d.batchIndex() != null ? d.batchIndex() : Integer.MAX_VALUE)
                                .thenComparing(WorkbenchSchemeDraft::draftId))
                        .toList();
                CachedIdempotentBatch cached = idempotencyCache.get(cleanIdemKey);
                assertBatchIdempotencyMatch(cleanIdemKey, batchGroupId, requestFingerprint, existingDrafts, cached);

                GlobalPlanningService.MultiMaterialPlanResult replayPlanResult;
                List<String> replayWarnings;
                if (cached != null && cached.planResult() != null) {
                    replayPlanResult = cached.planResult();
                    replayWarnings = cached.warnings();
                } else {
                    replayPlanResult = MultiMaterialReplaySupport.rebuildPlanResultFromArchived(
                            cleanTaskId, cleanModel, req.requiredBatchNo(), req.requiredColor(),
                            req.demands(), continueAcrossRolls, existingDrafts, optimizationService
                    );
                    replayWarnings = replayPlanResult.warnings();
                    idempotencyCache.put(cleanIdemKey, new CachedIdempotentBatch(
                            batchGroupId, requestFingerprint, replayPlanResult, replayWarnings
                    ));
                }
                return new MultiMaterialDraftBatchResponse(
                        batchGroupId,
                        false,
                        true,
                        existingDrafts.size(),
                        existingDrafts,
                        replayPlanResult,
                        replayWarnings
                );
            }
        }

        ContextSnapshot snapshot = loadContextSnapshot(cleanTaskId, req);

        GlobalPlanningService.MultiMaterialPlanRequest planRequest = buildPlanRequest(
                req, cleanTaskId, cleanModel, continueAcrossRolls
        );

        GlobalPlanningService.MultiMaterialPlanResult planResult;
        try {
            planResult = globalPlanningService.planMultiMaterial(planRequest);
        } catch (IllegalArgumentException invalid) {
            throw failure("INVALID_INPUT", invalid.getMessage(), 400);
        }

        String cleanActor = blankToNull(actor) != null ? actor.trim() : "LOCAL";
        String fingerprintTag = cleanIdemKey != null ? requestFingerprint.substring(0, 16) : null;

        List<WorkbenchDraftService.CreateDraftRequest> draftRequests = new ArrayList<>();
        int segmentSeq = 1;

        for (GlobalPlanningService.RemnantAllocation rem : planResult.remnantAllocations()) {
            if (rem.placedCount() <= 0 || rem.placements() == null || rem.placements().isEmpty()) {
                continue;
            }
            StoredOptimizationJob archived = archiveSegment(
                    batchGroupId,
                    segmentSeq,
                    keySeed,
                    fingerprintTag,
                    snapshot,
                    cleanActor,
                    "REMNANT",
                    rem.remnantId(),
                    rem.widthMm(),
                    rem.lengthMm(),
                    0.0,
                    0.0,
                    rem.remnantId() + " (料头 " + Math.round(rem.widthMm()) + "×" + Math.round(rem.lengthMm()) + "mm)",
                    rem.placements(),
                    rem.defects()
            );
            String segNote = buildSegmentNote(cleanNote, "料头接力 #" + segmentSeq + " · " + rem.remnantId(), rem.placedCount());
            draftRequests.add(new WorkbenchDraftService.CreateDraftRequest(
                    archived.job().id(),
                    snapshot.taskId(),
                    rem.remnantId(),
                    "REMNANT",
                    segNote,
                    ttlSeconds
            ));
            segmentSeq++;
        }

        for (GlobalPlanningService.RollOption roll : planResult.rollOptions()) {
            if (!roll.recommended() || roll.placedCount() <= 0 || roll.placements() == null || roll.placements().isEmpty()) {
                continue;
            }
            double windowStart = roll.windowStartY() == null ? 0.0 : roll.windowStartY();
            double maxEndY = 0.0;
            for (GlobalPlanningService.PlacementSnapshot p : roll.placements()) {
                maxEndY = Math.max(maxEndY, p.y() + p.l());
            }
            double windowLength = Math.max(Math.max(100.0, roll.estimatedCutLengthMm()), maxEndY);
            if (roll.availableLengthMm() > 0 && windowLength <= roll.availableLengthMm()) {
                windowLength = Math.max(windowLength, Math.min(roll.availableLengthMm(), Math.max(roll.estimatedCutLengthMm(), maxEndY)));
            }
            String relayTag = roll.relayOrder() != null ? ("接力母卷 #" + roll.relayOrder()) : "推荐母卷";
            StoredOptimizationJob archived = archiveSegment(
                    batchGroupId,
                    segmentSeq,
                    keySeed,
                    fingerprintTag,
                    snapshot,
                    cleanActor,
                    "STOCK_ROLL",
                    roll.rollId(),
                    roll.widthMm(),
                    windowLength,
                    windowStart,
                    snapshot.trimStartMm(),
                    roll.rollId() + " (" + relayTag + " · " + Math.round(roll.widthMm()) + "mm)",
                    roll.placements(),
                    roll.defects()
            );
            String segNote = buildSegmentNote(cleanNote, relayTag + " · " + roll.rollId(), roll.placedCount());
            draftRequests.add(new WorkbenchDraftService.CreateDraftRequest(
                    archived.job().id(),
                    snapshot.taskId(),
                    roll.rollId(),
                    "STOCK_ROLL",
                    segNote,
                    ttlSeconds
            ));
            segmentSeq++;
        }

        if (draftRequests.isEmpty()) {
            String warnSummary = planResult.warnings().isEmpty()
                    ? "当前在库可用料头与母卷均未能排入任何有效裁片，未生成草案"
                    : String.join("；", planResult.warnings());
            throw failure("NO_FEASIBLE_LAYOUT", warnSummary, 422);
        }

        List<WorkbenchSchemeDraft> drafts = workbenchDraftService.createBatchDrafts(batchGroupId, draftRequests);
        if (cleanIdemKey != null) {
            idempotencyCache.put(cleanIdemKey, new CachedIdempotentBatch(
                    batchGroupId, requestFingerprint, planResult, planResult.warnings()
            ));
        }
        return new MultiMaterialDraftBatchResponse(
                batchGroupId,
                false,
                true,
                drafts.size(),
                drafts,
                planResult,
                planResult.warnings()
        );
    }

    private static GlobalPlanningService.MultiMaterialPlanRequest buildPlanRequest(
            MultiMaterialDraftBatchRequest req,
            String cleanTaskId,
            String cleanModel,
            boolean continueAcrossRolls
    ) {
        return new GlobalPlanningService.MultiMaterialPlanRequest(
                cleanTaskId,
                cleanModel,
                blankToNull(req.requiredBatchNo()),
                blankToNull(req.requiredColor()),
                req.preferRemnants(),
                req.maxRemnants(),
                req.candidateRollIds(),
                req.timeBudgetMs(),
                req.pieceGapMm(),
                req.trimStartMm(),
                req.demands(),
                continueAcrossRolls
        );
    }

    private void assertBatchIdempotencyMatch(
            String cleanIdemKey,
            String batchGroupId,
            String requestFingerprint,
            List<WorkbenchSchemeDraft> existingDrafts,
            CachedIdempotentBatch cached
    ) {
        if (cached != null) {
            if (!Objects.equals(cached.requestFingerprint(), requestFingerprint)) {
                throw failure("IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 已绑定不同多料联排草案请求参数", 409);
            }
            return;
        }
        String firstResultId = existingDrafts.get(0).target() == null ? null : existingDrafts.get(0).target().resultId();
        StoredOptimizationJob doc = firstResultId == null ? null : optimizationService.findJobWithSource(firstResultId);
        String expectedClientReqId = buildClientRequestId(batchGroupId, 1, requestFingerprint.substring(0, 16));
        if (doc == null || doc.input() == null || !Objects.equals(doc.input().clientRequestId(), expectedClientReqId)) {
            throw failure("IDEMPOTENCY_CONFLICT", "同一 Idempotency-Key 已绑定不同多料联排草案请求参数", 409);
        }
    }

    private String computeRequestFingerprint(
            MultiMaterialDraftBatchRequest req,
            String cleanTaskId,
            String cleanModel,
            String cleanNote,
            long ttlSeconds,
            boolean continueAcrossRolls
    ) {
        CanonicalBatchRequest canonical = new CanonicalBatchRequest(
                cleanTaskId,
                cleanModel,
                blankToNull(req.requiredBatchNo()),
                blankToNull(req.requiredColor()),
                req.preferRemnants(),
                req.maxRemnants(),
                req.candidateRollIds(),
                req.timeBudgetMs(),
                req.pieceGapMm(),
                req.trimStartMm(),
                req.demands(),
                continueAcrossRolls,
                cleanNote,
                ttlSeconds
        );
        return sha256HexBytes(jsonMapper.writeValueAsBytes(canonical));
    }

    private <T> T withIdempotencyLock(String cleanIdemKey, Supplier<T> action) {
        IdempotencyLockEntry entry = idempotencyLocks.compute(cleanIdemKey, (k, existing) -> {
            IdempotencyLockEntry target = existing == null ? new IdempotencyLockEntry() : existing;
            target.refs++;
            return target;
        });
        entry.lock.lock();
        try {
            return action.get();
        } finally {
            entry.lock.unlock();
            idempotencyLocks.computeIfPresent(cleanIdemKey, (k, existing) -> {
                if (existing == entry) {
                    existing.refs--;
                    if (existing.refs <= 0) {
                        return null;
                    }
                }
                return existing;
            });
        }
    }

    private ContextSnapshot loadContextSnapshot(String taskId, MultiMaterialDraftBatchRequest req) {
        return cuttingStatePort.inRead(tx -> {
            CuttingTask task = null;
            if (taskId != null) {
                task = tx.findTask(taskId).orElseThrow(() -> failure("NOT_FOUND", "需求任务不存在: " + taskId, 404));
                if (task.slittingTask()) {
                    throw failure("UNSUPPORTED_CONSTRAINT", "任务「" + task.name() + "」为一维分切任务，不支持二维多料联排", 422);
                }
            }
            long taskRev = task != null ? task.revision() : 0L;
            long matRev = tx.currentRevision();
            double gap = req.pieceGapMm() != null
                    ? req.pieceGapMm()
                    : (task != null && task.process() != null && task.process().pieceGap() != null ? task.process().pieceGap() : 0.0);
            double trim = req.trimStartMm() != null
                    ? req.trimStartMm()
                    : (task != null && task.process() != null ? task.process().trimStart() : 0.0);

            Map<Integer, DemandSpec> specs = new LinkedHashMap<>();
            if (req.demands() != null && !req.demands().isEmpty()) {
                int autoId = 1;
                for (GlobalPlanningService.DemandItem d : req.demands()) {
                    if (d == null) continue;
                    int id = (d.id() != null && d.id() > 0) ? d.id() : autoId++;
                    while (specs.containsKey(id)) id = autoId++;
                    double w = d.shape() != null ? d.shape().width() : d.width();
                    double l = d.shape() != null ? d.shape().height() : d.length();
                    specs.put(id, new DemandSpec(
                            id,
                            blankToNull(d.name()) != null ? d.name().trim() : ("裁片 #" + id),
                            w,
                            l,
                            Boolean.TRUE.equals(d.allowRotation()),
                            Boolean.TRUE.equals(d.allowHalfTurn()) ? Boolean.TRUE : null,
                            d.shape(),
                            d.sourceLineId()
                    ));
                }
            } else if (task != null) {
                for (CuttingTask.Line line : task.demands()) {
                    specs.put(line.id(), new DemandSpec(
                            line.id(),
                            line.name(),
                            line.width(),
                            line.length(),
                            line.allowRotation(),
                            line.allowHalfTurn(),
                            line.shape(),
                            line.id()
                    ));
                }
            }

            return new ContextSnapshot(taskId, taskRev, matRev, Math.max(0.0, gap), Math.max(0.0, trim), specs);
        });
    }

    private StoredOptimizationJob archiveSegment(
            String batchGroupId,
            int segmentSeq,
            String keySeed,
            String fingerprintTag,
            ContextSnapshot snapshot,
            String actor,
            String materialType,
            String materialId,
            double widthMm,
            double windowLengthMm,
            double windowStartMm,
            double trimStartMm,
            String materialLabel,
            List<GlobalPlanningService.PlacementSnapshot> placements,
            List<Defect> defects
    ) {
        boolean isContour = placements.stream().anyMatch(p ->
                (p.polygon() != null && !p.polygon().isEmpty()) || (p.holes() != null && !p.holes().isEmpty()));

        double maxEndX = widthMm;
        double maxEndY = windowLengthMm;
        Map<Integer, Integer> countsByDemand = new LinkedHashMap<>();
        Map<Integer, GlobalPlanningService.PlacementSnapshot> sampleByDemand = new LinkedHashMap<>();
        for (GlobalPlanningService.PlacementSnapshot p : placements) {
            maxEndX = Math.max(maxEndX, p.x() + p.w());
            maxEndY = Math.max(maxEndY, p.y() + p.l());
            countsByDemand.merge(p.demandId(), 1, Integer::sum);
            sampleByDemand.putIfAbsent(p.demandId(), p);
        }
        double matW = Math.max(0.1, round1(maxEndX));
        double matL = Math.max(0.1, round1(maxEndY));
        double effectiveTrim = ("REMNANT".equals(materialType) || isContour || trimStartMm >= matL - 1.0)
                ? 0.0
                : Math.max(0.0, round1(trimStartMm));

        List<NestingProblem.Part> parts = new ArrayList<>(countsByDemand.size());
        Map<Integer, Integer> sourceLines = new LinkedHashMap<>();
        for (Map.Entry<Integer, Integer> entry : countsByDemand.entrySet()) {
            int did = entry.getKey();
            int qty = entry.getValue();
            DemandSpec spec = snapshot.demandSpecs().get(did);
            GlobalPlanningService.PlacementSnapshot sample = sampleByDemand.get(did);
            String name = spec != null ? spec.name() : (sample != null && sample.name() != null ? sample.name() : ("裁片 #" + did));
            NestingProblem.Shape partShape;
            boolean allowRotation;
            Boolean allowHalfTurn;
            if (spec != null && spec.shape() != null && "POLYGON".equals(spec.shape().type())) {
                partShape = spec.shape();
                allowRotation = spec.allowRotation();
                allowHalfTurn = spec.allowHalfTurn();
            } else if (isContour && sample != null && sample.polygon() != null && sample.polygon().size() >= 3) {
                partShape = new NestingProblem.Shape("POLYGON", sample.w(), sample.l(), sample.polygon(),
                        sample.holes() != null ? sample.holes() : List.of());
                allowRotation = spec != null && spec.allowRotation();
                allowHalfTurn = spec != null ? spec.allowHalfTurn() : null;
            } else {
                double baseW = spec != null ? spec.width() : (sample != null ? (sample.rotated() ? sample.l() : sample.w()) : 100.0);
                double baseL = spec != null ? spec.length() : (sample != null ? (sample.rotated() ? sample.w() : sample.l()) : 100.0);
                if (isContour) {
                    List<NestingProblem.Point> verts = List.of(
                            new NestingProblem.Point(0, 0),
                            new NestingProblem.Point(baseW, 0),
                            new NestingProblem.Point(baseW, baseL),
                            new NestingProblem.Point(0, baseL)
                    );
                    partShape = new NestingProblem.Shape("POLYGON", baseW, baseL, verts, List.of());
                } else {
                    partShape = NestingProblem.Shape.rectangle(Math.max(0.1, round1(baseW)), Math.max(0.1, round1(baseL)));
                }
                allowRotation = spec != null ? spec.allowRotation() : true;
                allowHalfTurn = isContour && spec != null ? spec.allowHalfTurn() : null;
            }
            parts.add(new NestingProblem.Part(did, name, partShape, qty, allowRotation, allowHalfTurn));
            Integer lineId = spec != null && spec.sourceLineId() != null
                    ? spec.sourceLineId()
                    : (sample != null ? sample.sourceLineId() : null);
            if (lineId != null) {
                sourceLines.put(did, lineId);
            }
        }

        List<NestingProblem.Exclusion> exclusions = new ArrayList<>();
        if (defects != null && !defects.isEmpty()) {
            // 与 WorkbenchPlanOrchestrator / DefectWindowSupport 对齐：料头原始缺陷必须外扩安全边距 margin
            List<Defect> normalizedDefects = DefectWindowSupport.sliceForWindow(defects, 0.0, matL, matW);
            for (Defect d : normalizedDefects) {
                if (d == null) continue;
                double x0 = Math.max(0.0, round1(d.getX()));
                double y0 = Math.max(0.0, round1(d.getY()));
                double x1 = Math.min(matW, round1(d.getX() + d.getW()));
                double y1 = Math.min(matL, round1(d.getY() + d.getH()));
                double ew = round1(x1 - x0);
                double eh = round1(y1 - y0);
                if (ew >= 0.1 && eh >= 0.1 && x0 < matW && y0 < matL) {
                    if (isContour && exclusions.size() >= 128) break;
                    exclusions.add(new NestingProblem.Exclusion(
                            exclusions.size() + 1,
                            x0,
                            y0,
                            NestingProblem.Shape.rectangle(ew, eh),
                            0.0,
                            d.getSeverity(),
                            d.getAvoidanceStrategy()
                    ));
                }
            }
        }

        NestingProblem.Material material = new NestingProblem.Material(
                materialId,
                NestingProblem.Shape.rectangle(matW, matL),
                exclusions,
                false
        );
        NestingProblem.Process process = isContour
                ? new NestingProblem.Process("CONTOUR", "SHEET", "left-top", "none", 0.0, 0.0, 0.0, 0.0,
                "MAXIMIZE_PIECE_AREA", snapshot.pieceGapMm())
                : new NestingProblem.Process("GUILLOTINE", "SHEET", "left-top", "horizontal", effectiveTrim,
                200.0, 300.0, 0.0, "MAXIMIZE_PIECE_AREA", 0.0);

        String clientReqId = buildClientRequestId(batchGroupId, segmentSeq, fingerprintTag);
        NestingProblem problem = new NestingProblem("1", "mm", material, parts, process, "auto", 5);
        OptimizationRequest optReq = new OptimizationRequest("2.0", "NESTING_2D", clientReqId, problem, true, false, null);

        List<NestingResult.Placement> resultPlacements = new ArrayList<>(placements.size());
        for (int i = 0; i < placements.size(); i++) {
            GlobalPlanningService.PlacementSnapshot p = placements.get(i);
            NestingProblem.Shape placedShape;
            if (isContour && p.polygon() != null && p.polygon().size() >= 3) {
                placedShape = new NestingProblem.Shape(
                        "POLYGON",
                        Math.max(0.1, round1(p.w())),
                        Math.max(0.1, round1(p.l())),
                        p.polygon(),
                        p.holes() != null ? p.holes() : List.of()
                );
            } else {
                placedShape = NestingProblem.Shape.rectangle(
                        Math.max(0.1, round1(p.w())),
                        Math.max(0.1, round1(p.l()))
                );
            }
            resultPlacements.add(new NestingResult.Placement(
                    i + 1,
                    p.demandId(),
                    p.name(),
                    round1(p.x()),
                    round1(p.y()),
                    placedShape,
                    p.rotationDegrees()
            ));
        }

        NestingResult layout = new NestingResult(
                "1",
                "mm",
                "source-local-top-left",
                "FEASIBLE",
                "多料联排协同方案归档",
                "multi-material-planner",
                "2.0",
                0L,
                materialId,
                NestingProblem.Shape.rectangle(matW, matL),
                List.copyOf(resultPlacements),
                List.of(),
                List.of(),
                List.of(),
                null,
                List.of(),
                "auto",
                null
        );

        WorkbenchJobSource source = new WorkbenchJobSource(
                snapshot.taskId(),
                actor,
                snapshot.taskRevision(),
                materialType,
                materialId,
                snapshot.materialRevision(),
                matW,
                windowStartMm,
                matL,
                0.0,
                sourceLines,
                isContour ? "CONTOUR_2D" : "RECT_2D",
                materialLabel,
                true,
                effectiveTrim,
                snapshot.pieceGapMm()
        );

        String segIdemKey = buildSegmentKey(keySeed, segmentSeq, materialId);
        return optimizationService.archiveCompleted2DResult(segIdemKey, optReq, layout, source);
    }

    private static String buildSegmentNote(String userNote, String segLabel, int placedCount) {
        String base = segLabel + "（排入 " + placedCount + " 件）";
        String combined = userNote == null ? base : (base + " | " + userNote);
        return combined.length() > 500 ? combined.substring(0, 500) : combined;
    }

    private static String deriveBatchGroupId(String cleanIdemKey) {
        return "MMB-" + sha256HexBytes(("mmb-group\0" + cleanIdemKey).getBytes(StandardCharsets.UTF_8))
                .substring(0, 12)
                .toUpperCase(Locale.ROOT);
    }

    private static String buildClientRequestId(String batchGroupId, int segmentSeq, String fingerprintTag) {
        if (fingerprintTag != null && !fingerprintTag.isBlank()) {
            return batchGroupId + "-" + segmentSeq + "-" + fingerprintTag;
        }
        return batchGroupId + "-" + segmentSeq;
    }

    private static String buildSegmentKey(String keySeed, int segmentSeq, String materialId) {
        return "mmb-" + sha256HexBytes(("mmb\0" + keySeed + "\0" + segmentSeq + "\0" + materialId).getBytes(StandardCharsets.UTF_8))
                .substring(0, 24);
    }

    private static String sha256HexBytes(byte[] bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            return HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static double round1(double v) {
        if (!Double.isFinite(v)) return 0.0;
        double q = Math.rint(v * 10.0) / 10.0;
        return q == 0.0 ? 0.0 : q;
    }

    private static String blankToNull(String s) {
        return (s == null || s.isBlank()) ? null : s.trim();
    }

    private static OptimizationFailure failure(String code, String message, int status) {
        return new OptimizationFailure(code, message, status, false);
    }
}
