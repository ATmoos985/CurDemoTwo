import type {
  CanvasSpecPatch,
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D,
  SavedSchemeCanvasMode2D
} from '../../store/studioTypes';
import type {
  MappedWorkbenchDeeplinkPlan,
  WorkbenchJobSourceDto,
  WorkbenchResultContextDto,
  WorkbenchSchemeDraftDto,
  WorkbenchTaskSummaryDto
} from './workbenchDeeplinkTypes';
import {
  cleanText,
  computeShapeNetAreaMm2,
  extractWindowDefectsFromProblem,
  hasPolygonOrHoleParts,
  nonNegNum,
  normalizeShapeGeometry,
  positiveNum,
  resolveRectGapPaddingMm,
  round1,
  round2,
  round3,
  unpadGapFillPlacements
} from './workbenchDeeplinkGeometry';
import { buildBannerMeta, formatMaterialLabel } from './workbenchDeeplinkBanner';
import { quantize01, unpadGuillotineResult } from '../../lib/domain/nesting-request-adapter.js';
import { rectangle } from '../../lib/canvas/nesting-scene.js';

export interface Map2DResultContextParams {
  context: WorkbenchResultContextDto;
  draft?: WorkbenchSchemeDraftDto | null;
  loadedFamily?: DemandFamilySummary | null;
  source: WorkbenchJobSourceDto | null;
  taskSummary: WorkbenchTaskSummaryDto | null;
  input: WorkbenchResultContextDto['input'];
  rawResult: any;
  resultId: string;
  draftId: string | null;
  taskId: string | null;
  taskName: string | null;
  jobState: string;
  canvasMode: SavedSchemeCanvasMode2D;
  materialId: string;
  nowMs: number;
  createdAtLabel: string;
}

export function map2DResultContext(params: Map2DResultContextParams): MappedWorkbenchDeeplinkPlan {
  const {
    context,
    draft,
    loadedFamily,
    source,
    taskSummary,
    input,
    rawResult,
    resultId,
    draftId,
    taskId,
    taskName,
    jobState,
    canvasMode,
    materialId,
    nowMs,
    createdAtLabel
  } = params;

  const problem = input?.problem || {};
  const rectGapPaddingMm = resolveRectGapPaddingMm(context);
  const solverMaterialW = positiveNum(
    problem?.material?.shape?.width ?? rawResult?.layout?.processingRegion?.width,
    1500
  );
  const solverMaterialH = positiveNum(
    problem?.material?.shape?.height ?? rawResult?.layout?.processingRegion?.height,
    2400
  );

  const origWidthMm =
    rectGapPaddingMm > 0
      ? positiveNum(
          source?.physicalWidthMm ?? source?.widthMm,
          Math.max(1, quantize01(solverMaterialW - rectGapPaddingMm))
        )
      : positiveNum(source?.physicalWidthMm ?? source?.widthMm, quantize01(solverMaterialW));
  const origHeightMm =
    rectGapPaddingMm > 0
      ? positiveNum(
          source?.windowLengthMm ?? source?.canvasLengthMm,
          Math.max(1, quantize01(solverMaterialH - rectGapPaddingMm))
        )
      : positiveNum(
          source?.windowLengthMm ?? source?.canvasLengthMm,
          quantize01(solverMaterialH)
        );

  const rawParts: any[] = Array.isArray(problem?.parts) ? problem.parts : [];
  const origParts = rawParts.map((p, idx) => {
    const id = Number.isInteger(Number(p.id)) && Number(p.id) > 0 ? Number(p.id) : idx + 1;
    const rawW = positiveNum(p?.shape?.width ?? p?.width, 100);
    const rawH = positiveNum(p?.shape?.height ?? p?.height, 100);
    if (rectGapPaddingMm > 0) {
      const netW = Math.max(0.1, quantize01(rawW - rectGapPaddingMm));
      const netH = Math.max(0.1, quantize01(rawH - rectGapPaddingMm));
      return {
        ...p,
        id,
        shape: rectangle(netW, netH)
      };
    }
    return {
      ...p,
      id,
      shape: normalizeShapeGeometry(p?.shape, rawW, rawH)
    };
  });

  const unpaddedBase =
    rectGapPaddingMm > 0
      ? unpadGuillotineResult(rawResult, {
          rectGapPadding: rectGapPaddingMm,
          origParts,
          origWidthMm,
          origHeightMm
        })
      : rawResult;

  const origPartMap = new Map<number, any>(origParts.map((p) => [Number(p.id), p]));
  const unpaddedGapFills = unpadGapFillPlacements(
    unpaddedBase?.marker?.gapFillPlacements || [],
    rectGapPaddingMm,
    origPartMap,
    origWidthMm,
    origHeightMm
  );

  const normalizedResult =
    rectGapPaddingMm > 0 && unpaddedBase?.marker
      ? {
          ...unpaddedBase,
          marker: {
            ...unpaddedBase.marker,
            gapFillPlacements: unpaddedGapFills
          }
        }
      : unpaddedBase;

  const layout = normalizedResult?.layout;
  const placements: any[] = Array.isArray(layout?.placements) ? layout.placements : [];
  const gapFills: any[] = Array.isArray(normalizedResult?.marker?.gapFillPlacements)
    ? normalizedResult.marker.gapFillPlacements
    : [];

  const windowStartY =
    canvasMode === 'STOCK_ROLL'
      ? nonNegNum(source?.windowStartMm ?? source?.windowStartY, 0)
      : 0;
  const pieceGapMm = nonNegNum(
    source?.pieceGapMm ?? (rectGapPaddingMm > 0 ? rectGapPaddingMm : problem?.process?.pieceGap),
    0
  );
  const trimStartMm =
    canvasMode === 'REMNANT'
      ? 0
      : nonNegNum(source?.trimStartMm ?? problem?.process?.trimStart, 0);
  const isContour =
    cleanText(problem?.process?.mode || source?.processMode).toUpperCase() === 'CONTOUR' ||
    hasPolygonOrHoleParts(problem, normalizedResult);

  if (!layout || placements.length === 0) {
    const materialLabel = formatMaterialLabel({
      dimension: '2D',
      canvasMode,
      materialId,
      widthMm: origWidthMm,
      lengthMm: origHeightMm,
      windowStartY
    });
    return {
      dimension: '2D',
      taskId,
      resultId,
      draftId,
      rectGapPaddingMm,
      scheme2D: null,
      canvasPatch2D: null,
      demands2D: [],
      scheme1D: null,
      slitPatch1D: null,
      slitOrders1D: [],
      banner: buildBannerMeta({
        dimension: '2D',
        resultId,
        taskId,
        taskName,
        materialLabel,
        fulfillmentStatus: cleanText(normalizedResult?.fulfillmentStatus) || 'INFEASIBLE',
        jobState: jobState || 'SUCCEEDED',
        draft,
        nowMs
      }),
      error:
        cleanText(layout?.message) ||
        `试排结果 ${resultId} 未排入任何裁片，请检查门幅、版长或避疵设置后重新试排。`
    };
  }

  const allPlaced = [...placements, ...gapFills];
  const maxPlacedY = allPlaced.reduce((maxVal: number, p: any) => {
    const py = nonNegNum(p?.y, 0);
    const ph = positiveNum(p?.shape?.height ?? p?.l, 0);
    return Math.max(maxVal, py + ph);
  }, 0);

  const rawMarkerOccupied = positiveNum(normalizedResult?.marker?.occupiedLengthMm, 0);
  const occupiedLengthMm =
    rectGapPaddingMm > 0
      ? round1(maxPlacedY > 0 ? maxPlacedY : origHeightMm)
      : round1(rawMarkerOccupied > 0 ? rawMarkerOccupied : maxPlacedY > 0 ? maxPlacedY : origHeightMm);

  const finalResult =
    rectGapPaddingMm > 0 && normalizedResult?.marker
      ? {
          ...normalizedResult,
          marker: {
            ...normalizedResult.marker,
            occupiedLengthMm
          }
        }
      : normalizedResult;

  const netAreaMm2 = allPlaced.reduce(
    (sum: number, p: any) => sum + computeShapeNetAreaMm2(p?.shape),
    0
  );
  const denomAreaMm2 = Math.max(1, origWidthMm * Math.max(1, occupiedLengthMm));
  const utilizationPct = round2((netAreaMm2 / denomAreaMm2) * 100);
  const pieceAreaM2 = round3(netAreaMm2 / 1_000_000);

  const familyLineById = new Map<number, DemandFamilySummary['lines'][number]>();
  for (const ln of loadedFamily?.lines || []) {
    familyLineById.set(Number(ln.id), ln);
  }

  const demands2D: DemandItem[] = origParts.map((p) => {
    const famLine = familyLineById.get(Number(p.id));
    const qty = Math.max(1, Math.floor(Number(p.quantity) || 1));
    return {
      id: Number(p.id),
      name: famLine?.name || cleanText(p.name) || `裁片 #${p.id}`,
      width: round1(positiveNum(p.shape?.width, famLine?.width || 100)),
      length: round1(positiveNum(p.shape?.height, famLine?.length || 100)),
      quantity: famLine ? Math.max(0, Number(famLine.openQty) || 0) : qty,
      orderedQty: famLine?.orderedQty ?? qty,
      plannedQty: famLine?.plannedQty ?? 0,
      completedQty: famLine?.completedQty ?? 0,
      allowRotation: Boolean(p.allowRotation ?? famLine?.allowRotation),
      allowHalfTurn: Boolean(p.allowHalfTurn ?? famLine?.allowHalfTurn),
      shape: p.shape,
      clusterName: taskName || undefined,
      sourceTaskId: taskId || undefined,
      sourceTaskName: taskName || undefined,
      sourceLineId: famLine?.id ?? Number(p.id),
      sizeLabel: famLine?.sizeLabel
    };
  });

  const requestedFromParts = origParts.reduce(
    (sum, p) => sum + Math.max(0, Math.floor(Number(p.quantity) || 0)),
    0
  );
  const requestedFromFulfillment = Array.isArray(layout.fulfillment)
    ? layout.fulfillment.reduce(
        (sum: number, f: any) => sum + Math.max(0, Math.floor(Number(f.requested) || 0)),
        0
      )
    : 0;
  const requestedCount = requestedFromParts || requestedFromFulfillment || placements.length;
  const fulfillmentStatus =
    cleanText(finalResult?.fulfillmentStatus).toUpperCase() ||
    (placements.length >= requestedCount ? 'COMPLETE' : 'PARTIAL');
  const complete = fulfillmentStatus === 'COMPLETE';

  const defects = extractWindowDefectsFromProblem(problem, origWidthMm, trimStartMm, isContour);
  const materialModel =
    cleanText(source?.materialModel || taskSummary?.materialModel || loadedFamily?.materialModel) ||
    `VIRTUAL-${Math.round(origWidthMm)}`;
  const strategyName =
    cleanText(source?.strategyName) || (isContour ? '外部异形试排' : '外部直刀试排');
  const strategyId = cleanText(source?.strategyId) || (isContour ? 'EXT_CONTOUR' : 'EXT_RECT');
  const scenarioId =
    cleanText(source?.scenarioId) ||
    (source?.allowGapFill ? 'SHORTEN_GAP_FILL' : 'SHORTEN_KIT');

  const scheme2D: SavedScheme2D = {
    id: `EXT-2D-${resultId}`,
    title: `${strategyName} (${Math.round(origWidthMm)}×${Math.round(occupiedLengthMm)}mm)`,
    strategyId,
    strategyName,
    scenarioId,
    createdAt: createdAtLabel,
    canvasMode,
    ...(canvasMode === 'STOCK_ROLL' && materialId ? { rollId: materialId } : {}),
    ...(canvasMode === 'REMNANT' && materialId ? { remnantId: materialId } : {}),
    windowStartY,
    materialModel,
    widthMm: round1(origWidthMm),
    canvasLengthMm: round1(Math.max(origHeightMm, occupiedLengthMm)),
    occupiedLengthMm,
    utilizationPct,
    pieceAreaM2,
    placedCount: placements.length + gapFills.length,
    requestedCount,
    gapFillCount: gapFills.length,
    complete,
    demands: demands2D,
    request: input,
    result: finalResult,
    ...(defects ? { defects } : {}),
    ...(cleanText(source?.batchNo) ? { batchNo: cleanText(source?.batchNo) } : {}),
    ...(cleanText(source?.color) ? { color: cleanText(source?.color) } : {}),
    ...(draftId ? { draftId } : {}),
    ...(cleanText(draft?.batchGroupId) ? { draftBatchGroupId: cleanText(draft?.batchGroupId) } : {}),
    ...(cleanText(draft?.confirmedSchemeId) ? { confirmedSchemeId: cleanText(draft?.confirmedSchemeId) } : {})
  };

  const canvasPatch2D: CanvasSpecPatch = {
    activeDimension: '2D',
    canvasMode,
    canvasWidthMm: round1(origWidthMm),
    canvasLengthMm: round1(origHeightMm),
    windowStartY2D: canvasMode === 'STOCK_ROLL' ? windowStartY : null,
    pieceGapMm: round1(pieceGapMm),
    trimStartMm: round1(trimStartMm),
    materialModel2D: materialModel,
    ...(canvasMode === 'STOCK_ROLL' && materialId ? { selectedRollId: materialId } : {}),
    ...(canvasMode === 'REMNANT' && materialId ? { selectedRemnantId: materialId } : {})
  };

  const materialLabel = formatMaterialLabel({
    dimension: '2D',
    canvasMode,
    materialId,
    widthMm: origWidthMm,
    lengthMm: origHeightMm,
    windowStartY
  });

  return {
    dimension: '2D',
    taskId,
    resultId,
    draftId,
    rectGapPaddingMm,
    scheme2D,
    canvasPatch2D,
    demands2D,
    scheme1D: null,
    slitPatch1D: null,
    slitOrders1D: [],
    banner: buildBannerMeta({
      dimension: '2D',
      resultId,
      taskId,
      taskName,
      materialLabel,
      fulfillmentStatus,
      jobState: jobState || 'SUCCEEDED',
      draft,
      nowMs
    }),
    error: null
  };
}
