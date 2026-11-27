import type {
  DemandFamilySummary,
  SavedSchemeCanvasMode2D,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/studioTypes';
import type {
  MappedWorkbenchDeeplinkPlan,
  WorkbenchJobSourceDto,
  WorkbenchResultContextDto,
  WorkbenchSchemeDraftDto,
  WorkbenchSlitSpecPatch,
  WorkbenchTaskSummaryDto
} from './workbenchDeeplinkTypes';
import { cleanText, nonNegNum, positiveNum, round2 } from './workbenchDeeplinkGeometry';
import { buildBannerMeta, formatMaterialLabel } from './workbenchDeeplinkBanner';

export interface Map1DResultContextParams {
  context: WorkbenchResultContextDto;
  draft?: WorkbenchSchemeDraftDto | null;
  loadedFamily?: DemandFamilySummary | null;
  source: WorkbenchJobSourceDto | null;
  taskSummary: WorkbenchTaskSummaryDto | null;
  input: WorkbenchResultContextDto['input'];
  job: WorkbenchResultContextDto['job'];
  rawResult: any;
  resultId: string;
  draftId: string | null;
  taskId: string | null;
  taskName: string | null;
  jobState: string;
  canvasMode: SavedSchemeCanvasMode2D;
  materialId: string;
  nowMs: number;
}

export function map1DResultContext(params: Map1DResultContextParams): MappedWorkbenchDeeplinkPlan {
  const {
    draft,
    loadedFamily,
    source,
    taskSummary,
    input,
    job,
    rawResult,
    resultId,
    draftId,
    taskId,
    taskName,
    jobState,
    canvasMode,
    materialId,
    nowMs
  } = params;

  const slitting = rawResult.slitting;
  if (!slitting || !Array.isArray(slitting.patterns)) {
    const materialLabel = formatMaterialLabel({
      dimension: '1D',
      canvasMode,
      materialId,
      widthMm: positiveNum(source?.physicalWidthMm ?? source?.widthMm ?? input?.problem?.motherWidthMm, 0),
      lengthMm: 0,
      windowStartY: 0
    });
    return {
      dimension: '1D',
      taskId,
      resultId,
      draftId,
      rectGapPaddingMm: 0,
      scheme2D: null,
      canvasPatch2D: null,
      demands2D: [],
      scheme1D: null,
      slitPatch1D: null,
      slitOrders1D: [],
      banner: buildBannerMeta({
        dimension: '1D',
        resultId,
        taskId,
        taskName,
        materialLabel,
        fulfillmentStatus: cleanText(rawResult.fulfillmentStatus) || 'UNKNOWN',
        jobState: jobState || 'SUCCEEDED',
        draft,
        nowMs
      }),
      error: `一维分切结果 ${resultId} 缺少有效车次（slitting.patterns）数据。`
    };
  }

  const problem = input?.problem || {};
  const motherWidthMm = Math.max(
    1,
    Math.round(
      positiveNum(
        problem.motherWidthMm ??
          source?.physicalWidthMm ??
          source?.widthMm ??
          slitting.patterns[0]?.motherWidthMm ??
          slitting.patterns[0]?.rollWidthMm,
        4600
      )
    )
  );
  const leftTrimMm = Math.round(nonNegNum(problem.leftTrimMm, 0));
  const rightTrimMm = Math.round(nonNegNum(problem.rightTrimMm, 0));
  const usableWidthMm = Math.max(1, motherWidthMm - leftTrimMm - rightTrimMm);

  const familyLineById = new Map<string, DemandFamilySummary['lines'][number]>();
  for (const ln of loadedFamily?.lines || []) {
    familyLineById.set(String(ln.id), ln);
  }
  const problemOrders: any[] = Array.isArray(problem.orders) ? problem.orders : [];
  const orderById = new Map<string, any>();
  for (const o of problemOrders) {
    orderById.set(String(o.id), o);
  }

  const slitOrders1D: SlittingOrderLine[] = problemOrders.map((o, idx) => {
    const idStr = cleanText(o.id) || String(idx + 1);
    const famLine = familyLineById.get(idStr);
    const qty = Math.max(0, Math.floor(Number(o.quantity) || 0));
    return {
      id: idStr,
      name: famLine?.name || cleanText(o.name) || `分条 #${idStr}`,
      widthMm: positiveNum(o.widthMm ?? famLine?.width, 0),
      lengthMm: positiveNum(o.lengthMm ?? famLine?.length, 2000),
      quantity: qty,
      orderedQty: famLine?.orderedQty ?? qty,
      plannedQty: famLine?.plannedQty ?? 0,
      completedQty: famLine?.completedQty ?? 0,
      sourceTaskId: taskId || undefined,
      sourceTaskName: taskName || undefined,
      sourceLineId: famLine?.id ?? (Number.isInteger(Number(idStr)) ? Number(idStr) : undefined),
      surfaceTreatment: cleanText(o.surfaceTreatment || famLine?.surfaceTreatment) || undefined
    };
  });

  const totalCars = slitting.patterns.reduce(
    (sum: number, p: any) => sum + Math.max(0, Math.floor(Number(p.repetitions) || 0)),
    0
  );
  const rawFulfillment: any[] = Array.isArray(slitting.fulfillment) ? slitting.fulfillment : [];
  const missingRolls = rawFulfillment.reduce(
    (sum: number, f: any) => sum + Math.max(0, Math.floor(Number(f.missing) || 0)),
    0
  );
  const overproducedRolls = rawFulfillment.reduce(
    (sum: number, f: any) => sum + Math.max(0, Math.floor(Number(f.overproduced) || 0)),
    0
  );

  const metricUtil = Array.isArray(rawResult.metrics)
    ? rawResult.metrics.find((m: any) => m?.name === 'motherAreaUtilization')?.value
    : undefined;
  const computedUtil =
    Number(slitting.motherAreaMm2) > 0
      ? (Number(slitting.pieceAreaMm2 || 0) / Number(slitting.motherAreaMm2)) * 100
      : 0;
  const avgUtilizationPct = round2(
    typeof metricUtil === 'number' && Number.isFinite(metricUtil) ? metricUtil : computedUtil
  );

  const rawEstKnives = slitting.estimatedKnifeChanges;
  const rawSavedKnives = slitting.knifeChangesSaved;
  const estimatedKnifeChanges =
    typeof rawEstKnives === 'number' && Number.isFinite(rawEstKnives) && rawEstKnives >= 0
      ? Math.round(rawEstKnives)
      : null;
  const knifeChangesSaved =
    typeof rawSavedKnives === 'number' && Number.isFinite(rawSavedKnives) && rawSavedKnives >= 0
      ? Math.round(rawSavedKnives)
      : null;

  const rawProfile = cleanText(problem.profile || source?.strategyId).toUpperCase();
  const strategyId: 'FAST' | 'QUALITY' = rawProfile === 'FAST' ? 'FAST' : 'QUALITY';
  const strategyName =
    cleanText(source?.strategyName) ||
    (strategyId === 'FAST' ? '外部试排·快捷解' : '外部试排·精确解');

  const scheme1D: SlittingSchemeRun = {
    id: `EXT-1D-${resultId}`,
    strategyId,
    strategyName,
    state: 'SUCCEEDED',
    motherWidthMm,
    leftTrimMm,
    rightTrimMm,
    totalCars,
    missingRolls,
    overproducedRolls,
    avgUtilizationPct,
    estimatedKnifeChanges,
    knifeChangesSaved,
    elapsedMs:
      typeof job?.elapsedMs === 'number' && Number.isFinite(job.elapsedMs)
        ? Math.round(job.elapsedMs)
        : undefined,
    patterns: slitting.patterns.map((p: any, idx: number) => {
      const usedWidthMm = nonNegNum(p.patternWidthMm, 0);
      const stations = Array.isArray(p.stations)
        ? p.stations.map((st: any) => ({
            widthMm: positiveNum(st.widthMm, 0),
            countPerRepetition: Math.max(0, Math.floor(Number(st.countPerRepetition) || 0))
          }))
        : [];
      return {
        id: cleanText(p.id) || `P-${idx + 1}`,
        lengthMm: positiveNum(p.lengthMm, positiveNum(slitOrders1D[0]?.lengthMm, 2000)),
        repetitions: Math.max(1, Math.floor(Number(p.repetitions) || 1)),
        stations,
        usedWidthMm,
        spareWidthMm: Math.max(0, usableWidthMm - usedWidthMm),
        ...(p.surfaceTreatment ? { surfaceTreatment: String(p.surfaceTreatment) } : {}),
        ...(Array.isArray(p.allocations) && p.allocations.length > 0
          ? {
              allocations: p.allocations.map((a: any) => ({
                orderId: String(a.orderId),
                quantity: Math.max(0, Math.floor(Number(a.quantity ?? a.count) || 0))
              }))
            }
          : {})
      };
    }),
    fulfillment: rawFulfillment.map((f: any) => {
      const oid = String(f.orderId);
      const ord = orderById.get(oid);
      const famLine = familyLineById.get(oid);
      return {
        orderId: oid,
        name: famLine?.name || cleanText(ord?.name) || oid,
        widthMm: positiveNum(ord?.widthMm ?? famLine?.width, 0),
        requested: Math.max(0, Math.floor(Number(f.requested) || 0)),
        produced: Math.max(0, Math.floor(Number(f.produced) || 0)),
        missing: Math.max(0, Math.floor(Number(f.missing) || 0)),
        overproduced: Math.max(0, Math.floor(Number(f.overproduced) || 0))
      };
    }),
    rawResult,
    ...(draftId ? { draftId } : {}),
    ...(cleanText(draft?.batchGroupId) ? { draftBatchGroupId: cleanText(draft?.batchGroupId) } : {}),
    ...(cleanText(draft?.confirmedSchemeId) ? { confirmedSchemeId: cleanText(draft?.confirmedSchemeId) } : {})
  };

  const slitMinW = positiveNum(problem.minWidthMm, 0);
  const slitMaxW = positiveNum(problem.maxWidthMm, 0);
  const slitFixedLen = positiveNum(
    slitting.patterns[0]?.lengthMm ?? problemOrders[0]?.lengthMm,
    0
  );
  const slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL' =
    canvasMode === 'STOCK_ROLL' ? 'STOCK_ROLL' : 'VIRTUAL_ROLL';

  const slitPatch1D: WorkbenchSlitSpecPatch = {
    slitMaterialMode,
    ...(slitMaterialMode === 'STOCK_ROLL' && materialId ? { slitRollId: materialId } : {}),
    slitMotherWidthMm: motherWidthMm,
    slitLeftTrimMm: leftTrimMm,
    slitRightTrimMm: rightTrimMm,
    ...(slitMinW > 0 ? { slitMinWidthMm: slitMinW } : {}),
    ...(slitMaxW > 0 ? { slitMaxWidthMm: slitMaxW } : {}),
    ...(slitMinW > 0 && slitMaxW > 0
      ? { slitWidthMode: slitMinW === slitMaxW ? 'FIXED' : 'FLEXIBLE' }
      : {}),
    ...(positiveNum(problem.widthStepMm, 0) > 0
      ? { slitWidthStepMm: Math.round(Number(problem.widthStepMm)) }
      : {}),
    ...(Number.isFinite(Number(problem.totalOverCap))
      ? { slitOverCap: Math.max(0, Math.round(Number(problem.totalOverCap))) }
      : {}),
    ...(slitFixedLen > 0 ? { slitFixedLengthMm: Math.round(slitFixedLen) } : {}),
    slitProfile: strategyId,
    ...(cleanText(source?.materialModel || taskSummary?.materialModel)
      ? { slitMaterialModel: cleanText(source?.materialModel || taskSummary?.materialModel) }
      : {}),
    slitAvoidDefects:
      typeof source?.avoidDefects === 'boolean'
        ? source.avoidDefects
        : slitMaterialMode === 'STOCK_ROLL',
    ...(problem.maxKnives != null ? { slitMaxKnives: nonNegNum(problem.maxKnives, 0) } : {}),
    ...(problem.minBladeSpacingMm != null
      ? { slitMinBladeSpacingMm: nonNegNum(problem.minBladeSpacingMm, 0) }
      : {}),
    ...(problem.kerfMm != null ? { slitKerfMm: nonNegNum(problem.kerfMm, 0) } : {}),
    ...(problem.forbiddenNarrowEdgeMinMm != null
      ? { slitForbiddenNarrowEdgeMinMm: nonNegNum(problem.forbiddenNarrowEdgeMinMm, 0) }
      : {}),
    ...(problem.forbiddenNarrowEdgeMaxMm != null
      ? { slitForbiddenNarrowEdgeMaxMm: nonNegNum(problem.forbiddenNarrowEdgeMaxMm, 0) }
      : {})
  };

  const derivedFulfillmentStatus =
    cleanText(rawResult.fulfillmentStatus) ||
    (missingRolls === 0 && totalCars > 0 ? 'COMPLETE' : totalCars > 0 ? 'PARTIAL' : 'INFEASIBLE');
  const materialLabel = formatMaterialLabel({
    dimension: '1D',
    canvasMode,
    materialId,
    widthMm: motherWidthMm,
    lengthMm: slitFixedLen,
    windowStartY: 0
  });

  return {
    dimension: '1D',
    taskId,
    resultId,
    draftId,
    rectGapPaddingMm: 0,
    scheme2D: null,
    canvasPatch2D: null,
    demands2D: [],
    scheme1D,
    slitPatch1D,
    slitOrders1D,
    banner: buildBannerMeta({
      dimension: '1D',
      resultId,
      taskId,
      taskName,
      materialLabel,
      fulfillmentStatus: derivedFulfillmentStatus,
      jobState: jobState || 'SUCCEEDED',
      draft,
      nowMs
    }),
    error: null
  };
}
