import type {
  CanvasMode2D,
  DemandFamilySummary,
  DemandItem,
  MultiMaterialRunSummary,
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingOrderLine,
  SlittingSchemeRun,
  StrategyJobRun
} from '../../store/studioTypes';
import {
  SlittingPhysicalConstraintInput,
  SlittingProfile,
  SlittingSolverOptions,
  SlittingWidthMode,
  StudioSettings,
  buildSlittingPhysicalConstraintFields
} from '../../store/studioSettings';
import { LastConfirmSummary, SolverStrategyDef } from './workbenchTypes';
import {
  buildConfirm1DIdempotencyKey,
  buildConfirm2DIdempotencyKey,
  buildSourceAllocations1D,
  buildSourceAllocations2D
} from './schemeConfirmUtils';

export interface BuildSlittingOptimizationRequestParams {
  profile: SlittingProfile;
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  minWidthMm: number;
  maxWidthMm: number;
  widthStepMm: number;
  totalOverCap: number;
  timeLimitSeconds: number;
  fixedLengthMm: number;
  orders: SlittingOrderLine[];
  advOpts: SlittingSolverOptions;
  physicalConstraints?: SlittingPhysicalConstraintInput | null;
  clientRequestId?: string;
}

/**
 * 构造严格符合 POST /api/v2/optimization-jobs (SLITTING_1D) 契约的请求体：
 * - 物理刀架硬约束默认全 0/留空时不写入 problem，保证历史默认请求体与幂等输入哈希零变更；
 * - 用户显式配置正值或成对细边丝禁区时，严格按 SlittingProblem.java 精确字段名透传。
 */
export function buildSlittingOptimizationRequest(params: BuildSlittingOptimizationRequestParams) {
  const {
    profile,
    motherWidthMm,
    leftTrimMm,
    rightTrimMm,
    minWidthMm,
    maxWidthMm,
    widthStepMm,
    totalOverCap,
    timeLimitSeconds,
    fixedLengthMm,
    orders,
    advOpts,
    physicalConstraints,
    clientRequestId
  } = params;
  const physicalFields = buildSlittingPhysicalConstraintFields(physicalConstraints);

  return {
    schemaVersion: '2.0',
    clientRequestId: clientRequestId || `slit-${profile}-${Date.now()}`,
    problemType: 'SLITTING_1D' as const,
    allowFallback: false,
    requireComplete: false,
    problem: {
      schemaVersion: '1',
      unit: 'mm',
      motherWidthMm,
      leftTrimMm,
      rightTrimMm,
      minWidthMm,
      maxWidthMm,
      widthStepMm,
      totalOverCap,
      profile,
      timeLimitSeconds,
      topK: advOpts.topK,
      maxIterations: advOpts.maxIterations,
      maxPatterns: advOpts.maxPatterns,
      maxDistinctWidths: advOpts.maxDistinctWidths,
      stageTimeLimitMs: advOpts.stageTimeLimitMs,
      useOptimizedAssignment: advOpts.useOptimizedAssignment,
      underPenalty: advOpts.underPenalty,
      seqGroupAlpha: advOpts.seqGroupAlpha,
      seqGroupBeta: advOpts.seqGroupBeta,
      lnsEnabled: advOpts.lnsEnabled,
      ...physicalFields,
      orders: orders.map((o) => ({
        id: o.id,
        widthMm: Math.floor(o.widthMm),
        lengthMm: Math.floor(o.lengthMm > 0 ? o.lengthMm : fixedLengthMm),
        quantity: Math.floor(o.quantity),
        surfaceTreatment: o.surfaceTreatment?.trim() || '不电晕/不涂布'
      }))
    }
  };
}

/** 判定二维方案确认落库时是否需要保留裁片轮廓与内孔几何（兼容 POLYGON 与带 holes 的矩形/多边形）。 */
export function hasContourOrHolesShape(shape?: { type?: string; holes?: unknown[] } | null): boolean {
  return Boolean(shape?.type === 'POLYGON' || (Array.isArray(shape?.holes) && shape.holes.length > 0));
}

export function shouldPersistConfirm2DShape(
  demands: Array<{ shape?: { type?: string; holes?: unknown[] } | null }>,
  placements: Array<{ shape?: { type?: string; holes?: unknown[] } | null }> = []
): boolean {
  return (
    demands.some((d) => hasContourOrHolesShape(d?.shape)) ||
    placements.some((p) => hasContourOrHolesShape(p?.shape))
  );
}

/** 从后端 SlittingResult 提取换刀统计摘要（保留合法 0 值，缺失返回 null）。 */
export function extractSlittingKnifeMetrics(slittingResult: any): {
  estimatedKnifeChanges: number | null;
  knifeChangesSaved: number | null;
} {
  const rawEst = slittingResult?.estimatedKnifeChanges;
  const rawSaved = slittingResult?.knifeChangesSaved;
  return {
    estimatedKnifeChanges:
      typeof rawEst === 'number' && Number.isFinite(rawEst) && rawEst >= 0
        ? Math.round(rawEst)
        : null,
    knifeChangesSaved:
      typeof rawSaved === 'number' && Number.isFinite(rawSaved) && rawSaved >= 0
        ? Math.round(rawSaved)
        : null
  };
}

export interface UseWorkbenchSolverOptions {
  // 2D inputs
  activeDemands2D: DemandItem[];
  activeAlgos: SolverStrategyDef[];
  canvasMode: CanvasMode2D;
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  canvasWidthMm: number;
  canvasLengthMm: number;
  windowStartY2D?: number | null;
  pieceGapMm: number;
  trimStartMm: number;
  materialModel2D: string;
  requiredBatchNo?: string | null;
  requiredColor?: string | null;
  multiPreferRemnants?: boolean;
  multiMaxRemnants?: number;
  multiCandidateRollIds?: string[];
  loadedTaskId: string | null;
  loadedTaskName: string;
  loadedExternalRef: string;
  currentRoll2D: any;
  currentRemnant2D: any;
  activeScheme2D: SavedScheme2D | null;
  setStrategyRuns2D: (
    runs: StrategyJobRun[] | ((prev: StrategyJobRun[]) => StrategyJobRun[])
  ) => void;
  addSchemes2D: (
    schemes: SavedScheme2D[],
    options?: { selectIfBetter?: boolean; batchIds?: ReadonlySet<string> }
  ) => void;
  setSchemes2D?: (schemes: SavedScheme2D[], activeId?: string | null) => void;
  setMultiMaterialSummary?: (summary: MultiMaterialRunSummary | null) => void;
  markSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId: string) => void;

  // 1D inputs
  slitOrders: SlittingOrderLine[];
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitWidthMode: SlittingWidthMode;
  slitProfile: SlittingProfile;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  slitMaxKnives?: number;
  slitMinBladeSpacingMm?: number;
  slitKerfMm?: number;
  slitForbiddenNarrowEdgeMinMm?: number;
  slitForbiddenNarrowEdgeMaxMm?: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitMaterialModel: string;
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string;
  scenario1D: Scenario1DType;
  currentRoll1D: any;
  activeScheme1D: SlittingSchemeRun | null;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  markSlitSchemeDispatched: (
    runId: string,
    taskId: string,
    confirmedSchemeId: string
  ) => void;

  // Shared
  settings: StudioSettings;
  batchGuardWarning?: { blocking: boolean; title: string; detail: string } | null;
  reloadReferenceData: (explicitTaskId?: string | null) => Promise<DemandFamilySummary[]>;
  syncDemandFamilyProgress: (fam: DemandFamilySummary) => void;
  syncMergedDemandFamiliesProgress?: (fams: DemandFamilySummary[]) => void;
  onDraftConfirmed?: (draftId: string, confirmedSchemeId: string) => void;
  onDraftConfirmFailed?: (draftId: string) => void;
}

export function buildConfirm2DPayload(params: {
  activeScheme2D: SavedScheme2D;
  activeDemands2D: DemandItem[];
  trimStartMm: number;
  pieceGapMm: number;
  scenario2D: Scenario2DType;
  loadedTaskId: string | null;
  loadedTaskName: string;
  loadedExternalRef: string;
}) {
  const {
    activeScheme2D,
    activeDemands2D,
    trimStartMm,
    pieceGapMm,
    scenario2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef
  } = params;
  const layout = activeScheme2D.result?.layout;
  const rawMain: any[] = layout?.placements || [];
  const rawGap: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
  const effectiveDemands = activeScheme2D.demands?.length
    ? activeScheme2D.demands
    : activeDemands2D;
  const hasPoly = shouldPersistConfirm2DShape(effectiveDemands, [...rawMain, ...rawGap]);

  const demandById = new Map<number, DemandItem>();
  for (const d of effectiveDemands) {
    demandById.set(Number(d.id), d);
  }
  const placementsPayload = [
    ...rawMain.map((p, idx) => {
      const srcDemand = p.demandId != null ? demandById.get(Number(p.demandId)) : undefined;
      const resolvedSourceTaskId = p.sourceTaskId ?? srcDemand?.sourceTaskId;
      const resolvedSourceLineId = p.sourceLineId ?? srcDemand?.sourceLineId;
      return {
        id: idx + 1,
        demandId: p.demandId,
        name: p.name,
        x: p.x,
        y: p.y,
        w: p.shape?.width || p.w || 0,
        l: p.shape?.height || p.l || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: false,
        shape: hasPoly || hasContourOrHolesShape(p.shape) ? p.shape : undefined,
        ...(resolvedSourceTaskId && resolvedSourceLineId != null
          ? {
              sourceTaskId: resolvedSourceTaskId,
              sourceLineId: Number(resolvedSourceLineId)
            }
          : {})
      };
    }),
    ...rawGap.map((p, idx) => {
      const srcDemand = p.demandId != null ? demandById.get(Number(p.demandId)) : undefined;
      const resolvedSourceTaskId = p.sourceTaskId ?? srcDemand?.sourceTaskId;
      const resolvedSourceLineId = p.sourceLineId ?? srcDemand?.sourceLineId;
      return {
        id: rawMain.length + idx + 1,
        demandId: p.demandId,
        name: p.name,
        x: p.x,
        y: p.y,
        w: p.shape?.width || p.w || 0,
        l: p.shape?.height || p.l || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: true,
        shape: hasPoly || hasContourOrHolesShape(p.shape) ? p.shape : undefined,
        ...(resolvedSourceTaskId && resolvedSourceLineId != null
          ? {
              sourceTaskId: resolvedSourceTaskId,
              sourceLineId: Number(resolvedSourceLineId)
            }
          : {})
      };
    })
  ];

  const effectiveTrimStartMm =
    activeScheme2D.canvasMode === 'REMNANT' ? 0 : trimStartMm;

  const allocSummary = buildSourceAllocations2D(
    placementsPayload,
    effectiveDemands,
    loadedTaskId
  );
  const sourceAllocations = allocSummary.shouldSendSourceAllocations
    ? allocSummary.allocations
    : undefined;
  const idempotencyKey = buildConfirm2DIdempotencyKey({
    scheme: activeScheme2D,
    taskId: allocSummary.resolvedTaskId,
    sourceAllocations,
    trimStartMm: effectiveTrimStartMm,
    pieceGapMm,
    placements: placementsPayload
  });

  const confirmBody = {
    idempotencyKey,
    ...(activeScheme2D.draftId ? { draftId: activeScheme2D.draftId } : {}),
    title: activeScheme2D.title,
    dimension: hasPoly ? 'CONTOUR_2D' : 'RECT_2D',
    scenarioId: activeScheme2D.scenarioId || scenario2D,
    strategyId: activeScheme2D.strategyId || 'AUTO',
    strategyName: activeScheme2D.strategyName,
    taskId: allocSummary.resolvedTaskId,
    taskName: loadedTaskName || `${activeScheme2D.materialModel} · 排料需求族`,
    externalOrderNo: loadedExternalRef || undefined,
    ...(sourceAllocations ? { sourceAllocations } : {}),
    materialMode:
      activeScheme2D.canvasMode === 'FREE_CANVAS'
        ? 'VIRTUAL_ROLL'
        : activeScheme2D.canvasMode,
    rollId: activeScheme2D.rollId,
    remnantId: activeScheme2D.remnantId,
    materialModel: activeScheme2D.materialModel,
    widthMm: activeScheme2D.widthMm,
    canvasLengthMm: activeScheme2D.canvasLengthMm,
    windowStartY: activeScheme2D.windowStartY,
    occupiedLengthMm: activeScheme2D.occupiedLengthMm,
    trimStartMm: effectiveTrimStartMm,
    pieceGapMm,
    utilizationPct: activeScheme2D.utilizationPct,
    pieceAreaM2: activeScheme2D.pieceAreaM2,
    demands: effectiveDemands.map((d) => ({
      id: d.id,
      name: d.name,
      width: d.width,
      length: d.length,
      quantity: Math.max(1, d.orderedQty || d.quantity),
      allowRotation: Boolean(d.allowRotation),
      allowHalfTurn: Boolean(d.allowHalfTurn),
      sizeLabel: d.sizeLabel,
      surfaceTreatment: d.surfaceTreatment,
      shape: d.shape,
      ...(d.sourceTaskId && d.sourceLineId != null
        ? { sourceTaskId: d.sourceTaskId, sourceLineId: Number(d.sourceLineId) }
        : {})
    })),
    layout2D: {
      placements: placementsPayload,
      leftovers: (layout?.leftovers || []).map((rm: any, i: number) => ({
        id: String(rm.id || i + 1),
        x: rm.x,
        y: rm.y,
        w: rm.shape?.width || rm.w || 0,
        l: rm.shape?.height || rm.l || 0,
        hasDefect: Boolean(rm.hasDefect)
      })),
      cuts: (layout?.cuts || []).map((c: any, i: number) => ({
        sequence: c.sequence || i + 1,
        kind: c.kind || 'CONTOUR',
        startX: c.startX,
        startY: c.startY,
        endX: c.endX,
        endY: c.endY
      }))
    }
  };

  return { idempotencyKey, allocSummary, confirmBody };
}

export function buildConfirm1DPayload(params: {
  activeScheme1D: SlittingSchemeRun;
  slitOrders: SlittingOrderLine[];
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string;
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitMaterialModel: string;
  currentRoll1D: any;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  scenario1D: Scenario1DType;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
}) {
  const {
    activeScheme1D,
    slitOrders,
    slitLoadedTaskId,
    slitLoadedTaskName,
    slitMaterialMode,
    slitMaterialModel,
    currentRoll1D,
    slitFixedLengthMm,
    slitAvoidDefects,
    scenario1D,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap
  } = params;

  const allocSummary = buildSourceAllocations1D(
    activeScheme1D.fulfillment || [],
    slitOrders,
    slitLoadedTaskId
  );
  const sourceAllocations = allocSummary.shouldSendSourceAllocations
    ? allocSummary.allocations
    : undefined;
  const boundRollId =
    slitMaterialMode === 'STOCK_ROLL' && currentRoll1D ? currentRoll1D.rollId : undefined;
  const idempotencyKey = buildConfirm1DIdempotencyKey({
    scheme: activeScheme1D,
    taskId: allocSummary.resolvedTaskId,
    sourceAllocations,
    materialMode: slitMaterialMode,
    rollId: boundRollId,
    fixedLengthMm: slitFixedLengthMm,
    avoidDefects: slitAvoidDefects
  });

  const slitOrderById = new Map<string, SlittingOrderLine>();
  for (const o of slitOrders) {
    slitOrderById.set(String(o.id), o);
  }
  const mapSlitOrderId = (rawOrderId: string | number): string => {
    const key = String(rawOrderId);
    const ord = slitOrderById.get(key);
    if (ord?.sourceTaskId && ord.sourceLineId != null) {
      return allocSummary.isMultiFamily
        ? `${ord.sourceTaskId}:${ord.sourceLineId}`
        : String(ord.sourceLineId);
    }
    return key;
  };

  const confirmBody = {
    idempotencyKey,
    ...(activeScheme1D.draftId ? { draftId: activeScheme1D.draftId } : {}),
    title: `${activeScheme1D.strategyName} (${activeScheme1D.motherWidthMm}mm · ${activeScheme1D.totalCars}车)`,
    dimension: 'SLITTING_1D',
    scenarioId: scenario1D,
    strategyId: activeScheme1D.strategyId,
    strategyName: activeScheme1D.strategyName,
    taskId: allocSummary.resolvedTaskId,
    taskName: slitLoadedTaskName || `${slitMaterialModel} · 一维分切需求族`,
    ...(sourceAllocations ? { sourceAllocations } : {}),
    materialMode: slitMaterialMode,
    rollId: boundRollId,
    materialModel:
      slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
        ? currentRoll1D.rollModel
        : slitMaterialModel || `SLIT-${activeScheme1D.motherWidthMm}`,
    widthMm: activeScheme1D.motherWidthMm,
    canvasLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
    occupiedLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
    trimStartMm: 0,
    pieceGapMm: 0,
    utilizationPct: activeScheme1D.avgUtilizationPct,
    pieceAreaM2: Number(
      (
        (activeScheme1D.motherWidthMm *
          activeScheme1D.totalCars *
          slitFixedLengthMm *
          (activeScheme1D.avgUtilizationPct / 100)) /
        1_000_000
      ).toFixed(2)
    ),
    avoidDefects: slitAvoidDefects,
    demands: slitOrders.map((o, idx) => ({
      id: Number(o.id) || idx + 1,
      name: o.name,
      width: o.widthMm,
      length: slitFixedLengthMm,
      quantity: Math.max(1, o.orderedQty || o.quantity),
      allowRotation: false,
      surfaceTreatment: o.surfaceTreatment,
      ...(o.sourceTaskId && o.sourceLineId != null
        ? { sourceTaskId: o.sourceTaskId, sourceLineId: Number(o.sourceLineId) }
        : {})
    })),
    slitting1D: {
      leftTrimMm: activeScheme1D.leftTrimMm,
      rightTrimMm: activeScheme1D.rightTrimMm,
      minWidthMm: slitMinWidthMm,
      maxWidthMm: slitMaxWidthMm,
      widthStepMm: slitWidthStepMm,
      totalOverCap: slitOverCap,
      fixedLengthMm: slitFixedLengthMm,
      totalCars: activeScheme1D.totalCars,
      missingRolls: activeScheme1D.missingRolls,
      overproducedRolls: activeScheme1D.overproducedRolls,
      patterns: activeScheme1D.patterns.map((p) => ({
        id: p.id,
        lengthMm: p.lengthMm,
        repetitions: p.repetitions,
        usedWidthMm: p.usedWidthMm,
        spareWidthMm: p.spareWidthMm,
        stations: p.stations,
        ...(p.surfaceTreatment ? { surfaceTreatment: p.surfaceTreatment } : {}),
        ...(p.allocations && p.allocations.length > 0
          ? {
              allocations: p.allocations.map((a) => ({
                orderId: mapSlitOrderId(a.orderId),
                quantity: Number(a.quantity) || 0
              }))
            }
          : {})
      })),
      fulfillment: activeScheme1D.fulfillment.map((f) => ({
        ...f,
        orderId: mapSlitOrderId(f.orderId)
      }))
    }
  };

  return { idempotencyKey, allocSummary, confirmBody };
}
