import type {
  CanvasSpecPatch,
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D,
  SavedSchemeCanvasMode2D,
  SchemeDefectSnapshot,
  ShapeGeometry,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/studioTypes';
import type { SlittingProfile } from '../../store/studioSettings';
import { quantize01, unpadGuillotineResult } from '../../lib/domain/nesting-request-adapter.js';
import { rectangle } from '../../lib/canvas/nesting-scene.js';

export interface WorkbenchJobSourceDto {
  taskId?: string | null;
  taskName?: string | null;
  actor?: string | null;
  dimension?: string | null;
  materialType?: string | null;
  materialId?: string | null;
  materialModel?: string | null;
  materialLabel?: string | null;
  materialRevision?: number | null;
  physicalWidthMm?: number | null;
  widthMm?: number | null;
  windowStartMm?: number | null;
  windowStartY?: number | null;
  windowLengthMm?: number | null;
  canvasLengthMm?: number | null;
  pieceGapMm?: number | null;
  rectGapPaddingMm?: number | null;
  trimStartMm?: number | null;
  processMode?: string | null;
  objective?: string | null;
  allowGapFill?: boolean | null;
  avoidDefects?: boolean | null;
  rollRevision?: number | null;
  taskRevision?: number | null;
  inventoryRevision?: number | null;
  strategyName?: string | null;
  strategyId?: string | null;
  scenarioId?: string | null;
  batchNo?: string | null;
  color?: string | null;
  [key: string]: unknown;
}

export interface WorkbenchTaskSummaryDto {
  id?: string | null;
  taskId?: string | null;
  name?: string | null;
  dimension?: string | null;
  materialModel?: string | null;
  externalRef?: string | null;
  orderedTotal?: number | null;
  plannedTotal?: number | null;
  completedTotal?: number | null;
  openTotal?: number | null;
  revision?: number | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface WorkbenchResultContextDto {
  resultId?: string | null;
  job?: {
    id?: string | null;
    state?: string | null;
    status?: string | null;
    phase?: string | null;
    createdAt?: string | null;
    finishedAt?: string | null;
    completedAt?: string | null;
    elapsedMs?: number | null;
    code?: string | null;
    message?: string | null;
    [key: string]: unknown;
  } | null;
  input?: {
    schemaVersion?: string | null;
    problemType?: string | null;
    clientRequestId?: string | null;
    problem?: any;
    strategy?: any;
    [key: string]: unknown;
  } | null;
  result?: any;
  source?: WorkbenchJobSourceDto | null;
  taskSummary?: WorkbenchTaskSummaryDto | null;
  workbenchUrl?: string | null;
}

export interface WorkbenchRiskCheckDto {
  code?: string | null;
  passed?: boolean | null;
  message?: string | null;
}

export interface WorkbenchSchemeDraftDto {
  id?: string | null;
  draftId?: string | null;
  status?: string | null;
  approvalToken?: string | null;
  contentHash?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  ttlSeconds?: number | null;
  requiresHumanConfirmation?: boolean | null;
  inventoryMutated?: boolean | null;
  stale?: boolean | null;
  staleReasons?: string[] | null;
  note?: string | null;
  target?: {
    resultId?: string | null;
    taskId?: string | null;
    materialId?: string | null;
    materialType?: string | null;
  } | null;
  riskChecks?: WorkbenchRiskCheckDto[] | null;
  workbenchUrl?: string | null;
  nextStep?: string | null;
  batchGroupId?: string | null;
  batchIndex?: number | null;
  batchTotal?: number | null;
  confirmedSchemeId?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  discardedBy?: string | null;
  discardedAt?: string | null;
  discardReason?: string | null;
}

export interface ExternalPlanRiskCheck {
  code: string;
  passed: boolean;
  message: string;
}

export interface ExternalPlanBannerMeta {
  dimension: '2D' | '1D';
  resultId: string;
  draftId: string | null;
  taskId: string | null;
  taskName: string | null;
  status: string;
  expired: boolean;
  stale: boolean;
  staleReasons: string[];
  riskChecks: ExternalPlanRiskCheck[];
  failedRiskChecks: ExternalPlanRiskCheck[];
  note: string | null;
  materialLabel: string;
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  expiresAt: string | null;
  nextStep: string | null;
  batchGroupId: string | null;
  batchIndex: number | null;
  batchTotal: number | null;
  confirmedSchemeId: string | null;
  confirmedAt: string | null;
  discardedAt: string | null;
  discardReason: string | null;
}

export interface WorkbenchSlitSpecPatch {
  slitMaterialMode?: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitRollId?: string;
  slitMotherWidthMm?: number;
  slitLeftTrimMm?: number;
  slitRightTrimMm?: number;
  slitMinWidthMm?: number;
  slitMaxWidthMm?: number;
  slitWidthStepMm?: number;
  slitWidthMode?: 'FIXED' | 'FLEXIBLE';
  slitOverCap?: number;
  slitFixedLengthMm?: number;
  slitProfile?: SlittingProfile;
  slitMaterialModel?: string;
  slitAvoidDefects?: boolean;
  slitMaxKnives?: number;
  slitMinBladeSpacingMm?: number;
  slitKerfMm?: number;
  slitForbiddenNarrowEdgeMinMm?: number;
  slitForbiddenNarrowEdgeMaxMm?: number;
  slitOrders?: SlittingOrderLine[];
}

export interface MappedWorkbenchDeeplinkPlan {
  dimension: '2D' | '1D';
  taskId: string | null;
  resultId: string;
  draftId: string | null;
  rectGapPaddingMm: number;
  scheme2D: SavedScheme2D | null;
  canvasPatch2D: CanvasSpecPatch | null;
  demands2D: DemandItem[];
  scheme1D: SlittingSchemeRun | null;
  slitPatch1D: WorkbenchSlitSpecPatch | null;
  slitOrders1D: SlittingOrderLine[];
  banner: ExternalPlanBannerMeta;
  error: string | null;
}

export interface MapDeeplinkPlanOptions {
  nowMs?: number;
  createdAtLabel?: string;
}

function positiveNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value != null ? String(value).trim() : '';
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function round3(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function polygonRingAreaMm2(points: Array<{ x?: number; y?: number }> | undefined | null): number {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ax = Number(a?.x) || 0;
    const ay = Number(a?.y) || 0;
    const bx = Number(b?.x) || 0;
    const by = Number(b?.y) || 0;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

/** 计算矩形、异形多边形及带内孔轮廓的净实体面积（mm²）。 */
export function computeShapeNetAreaMm2(shape: any): number {
  if (!shape) return 0;
  const isPolygon =
    shape.type === 'POLYGON' && Array.isArray(shape.vertices) && shape.vertices.length >= 3;
  const outer = isPolygon
    ? polygonRingAreaMm2(shape.vertices)
    : Math.max(0, Number(shape.width) || 0) * Math.max(0, Number(shape.height) || 0);
  if (!Array.isArray(shape.holes) || shape.holes.length === 0) {
    return outer;
  }
  let holesArea = 0;
  for (const ring of shape.holes) {
    holesArea += polygonRingAreaMm2(ring);
  }
  return Math.max(0, outer - holesArea);
}

function normalizeMaterialType(raw: unknown): SavedSchemeCanvasMode2D {
  const upper = cleanText(raw).toUpperCase();
  if (upper === 'STOCK_ROLL' || upper === 'ROLL') return 'STOCK_ROLL';
  if (upper === 'REMNANT') return 'REMNANT';
  return 'FREE_CANVAS';
}

function hasPolygonOrHoleParts(problem: any, result: any): boolean {
  const checkShape = (s: any): boolean =>
    Boolean(
      s &&
        (s.type === 'POLYGON' ||
          (Array.isArray(s.vertices) && s.vertices.length >= 3) ||
          (Array.isArray(s.holes) && s.holes.length > 0))
    );
  const parts: any[] = Array.isArray(problem?.parts) ? problem.parts : [];
  if (parts.some((p) => checkShape(p?.shape))) return true;
  const placements: any[] = Array.isArray(result?.layout?.placements)
    ? result.layout.placements
    : [];
  return placements.some((p) => checkShape(p?.shape));
}

/**
 * 判定后端二维直刀方案是否使用了外扩间隙求解（rectGapPaddingMm），与前端
 * buildSafeNestingRequest2D / unpadGuillotineResult 保持完全一致的还原口径。
 */
export function resolveRectGapPaddingMm(context: WorkbenchResultContextDto | null | undefined): number {
  if (!context) return 0;
  const problem = context.input?.problem;
  const source = context.source;
  const mode = cleanText(problem?.process?.mode || source?.processMode).toUpperCase();
  if (mode === 'CONTOUR' || hasPolygonOrHoleParts(problem, context.result)) {
    return 0;
  }
  if (source && source.rectGapPaddingMm !== undefined && source.rectGapPaddingMm !== null) {
    const explicit = Number(source.rectGapPaddingMm);
    return Number.isFinite(explicit) && explicit > 0 ? quantize01(explicit, 0) : 0;
  }
  // 兼容仅传 pieceGapMm 而直刀 problem.process.pieceGap=0 的外扩请求
  const sourceGap = positiveNum(source?.pieceGapMm, 0);
  const processGap = nonNegNum(problem?.process?.pieceGap, 0);
  if (sourceGap <= 0 || processGap > 0) return 0;
  if (mode && mode !== 'GUILLOTINE') return 0;

  const solverW = positiveNum(problem?.material?.shape?.width, 0);
  const origW = positiveNum(source?.physicalWidthMm ?? source?.widthMm, 0);
  if (solverW > 0 && origW > 0) {
    const diff = solverW - origW;
    if (Math.abs(diff - sourceGap) <= 0.25) {
      return quantize01(sourceGap, 0);
    }
    return diff > 0.05 ? quantize01(diff, 0) : 0;
  }
  return mode === 'GUILLOTINE' ? quantize01(sourceGap, 0) : 0;
}

function unpadGapFillPlacements(
  rawGapFills: any[],
  rectGapPadding: number,
  partMap: Map<number, any>,
  origWidthMm: number,
  origHeightMm: number
): any[] {
  if (!Array.isArray(rawGapFills) || rawGapFills.length === 0) return [];
  if (!rectGapPadding || rectGapPadding <= 0) return rawGapFills;
  return rawGapFills.map((pl) => {
    const orig = partMap.get(Number(pl.demandId));
    const rotated = Number(pl.rotationDegrees) % 180 !== 0;
    const w = orig
      ? rotated
        ? orig.shape.height
        : orig.shape.width
      : Math.max(0.1, quantize01((pl.shape?.width || 0) - rectGapPadding));
    const h = orig
      ? rotated
        ? orig.shape.width
        : orig.shape.height
      : Math.max(0.1, quantize01((pl.shape?.height || 0) - rectGapPadding));
    return {
      ...pl,
      x: Math.max(0, Math.min(Math.max(0, origWidthMm - w), quantize01(pl.x))),
      y: Math.max(0, Math.min(Math.max(0, origHeightMm - h), quantize01(pl.y))),
      shape: rectangle(w, h)
    };
  });
}

function normalizeShapeGeometry(rawShape: any, fallbackW: number, fallbackH: number): ShapeGeometry {
  const w = positiveNum(rawShape?.width, fallbackW);
  const h = positiveNum(rawShape?.height, fallbackH);
  const isPoly =
    rawShape?.type === 'POLYGON' &&
    Array.isArray(rawShape.vertices) &&
    rawShape.vertices.length >= 3;
  const holes =
    Array.isArray(rawShape?.holes) && rawShape.holes.length > 0
      ? rawShape.holes
          .filter((ring: any) => Array.isArray(ring) && ring.length >= 3)
          .map((ring: any[]) =>
            ring.map((pt) => ({
              x: nonNegNum(pt?.x, 0),
              y: nonNegNum(pt?.y, 0)
            }))
          )
      : undefined;
  if (isPoly) {
    return {
      type: 'POLYGON',
      width: w,
      height: h,
      vertices: rawShape.vertices.map((pt: any) => ({
        x: nonNegNum(pt?.x, 0),
        y: nonNegNum(pt?.y, 0)
      })),
      ...(holes && holes.length > 0 ? { holes } : {})
    };
  }
  return {
    type: 'RECTANGLE',
    width: w,
    height: h,
    ...(holes && holes.length > 0 ? { holes } : {})
  };
}

function extractWindowDefectsFromProblem(
  problem: any,
  origWidthMm: number,
  trimStartMm: number,
  isContour: boolean
): SchemeDefectSnapshot[] | undefined {
  const exclusions: any[] = Array.isArray(problem?.material?.exclusions)
    ? problem.material.exclusions
    : [];
  if (exclusions.length === 0) return undefined;

  const list: SchemeDefectSnapshot[] = [];
  for (let i = 0; i < exclusions.length; i++) {
    const ex = exclusions[i];
    if (!ex) continue;
    const x = nonNegNum(ex.x, 0);
    const y = nonNegNum(ex.y, 0);
    const w = positiveNum(ex.shape?.width ?? ex.w, 0);
    const h = positiveNum(ex.shape?.height ?? ex.h, 0);
    if (w <= 0 || h <= 0) continue;

    // 过滤 CONTOUR 模式下为兼容 trimStart=0 契约而自动注入的首端修边顶部禁入条
    const isSyntheticTrimStrip =
      isContour &&
      trimStartMm > 0 &&
      x <= 0.1 &&
      y <= 0.1 &&
      w >= Math.max(1, origWidthMm - 0.5) &&
      Math.abs(h - trimStartMm) <= 0.5;
    if (isSyntheticTrimStrip) continue;

    list.push({
      id: ex.id ?? `ex-${i + 1}`,
      x,
      y,
      w,
      h,
      margin: 0,
      label: ex.avoidancePolicy ? `禁区(${ex.avoidancePolicy})` : '避疵禁区',
      windowAligned: true
    });
  }
  return list.length > 0 ? list : undefined;
}

function buildFulfillmentLabel(status: string): string {
  switch (status.toUpperCase()) {
    case 'COMPLETE':
      return '齐套可排齐';
    case 'PARTIAL':
      return '部分排入（存在缺件）';
    case 'INFEASIBLE':
    case 'EMPTY':
    case 'UNPLACED':
      return '未排齐 / 不可行';
    default:
      return '待核对';
  }
}

function formatMaterialLabel(params: {
  dimension: '2D' | '1D';
  canvasMode: SavedSchemeCanvasMode2D;
  materialId: string;
  widthMm: number;
  lengthMm: number;
  windowStartY: number;
}): string {
  const { dimension, canvasMode, materialId, widthMm, lengthMm, windowStartY } = params;
  const wText = widthMm > 0 ? `W${Math.round(widthMm)}mm` : '';
  if (canvasMode === 'STOCK_ROLL') {
    const idPart = materialId ? `实卷 ${materialId}` : '库存实卷';
    const startPart = windowStartY > 0 ? ` · 起切 Y=${Math.round(windowStartY)}mm` : '';
    const specPart = wText ? ` · ${wText}` : '';
    return `${idPart}${specPart}${startPart}`;
  }
  if (canvasMode === 'REMNANT') {
    const idPart = materialId ? `料头 ${materialId}` : '库存料头';
    const dimPart =
      widthMm > 0 && lengthMm > 0 ? ` · ${Math.round(widthMm)}×${Math.round(lengthMm)}mm` : '';
    return `${idPart}${dimPart}`;
  }
  if (dimension === '1D') {
    return widthMm > 0 ? `虚拟新母卷 · ${wText}` : '虚拟新母卷';
  }
  return widthMm > 0 && lengthMm > 0
    ? `自由新母卷 · ${Math.round(widthMm)}×${Math.round(lengthMm)}mm`
    : wText
    ? `自由新母卷 · ${wText}`
    : '自由新母卷';
}

function normalizeRiskChecks(draft: WorkbenchSchemeDraftDto | null | undefined): ExternalPlanRiskCheck[] {
  const raw = Array.isArray(draft?.riskChecks) ? draft.riskChecks : [];
  return raw
    .filter((item): item is WorkbenchRiskCheckDto => Boolean(item))
    .map((item, idx) => ({
      code: cleanText(item.code) || `CHECK_${idx + 1}`,
      passed: Boolean(item.passed),
      message: cleanText(item.message) || (item.passed ? '预检通过' : '存在风险提示')
    }));
}

function buildBannerMeta(params: {
  dimension: '2D' | '1D';
  resultId: string;
  taskId: string | null;
  taskName: string | null;
  materialLabel: string;
  fulfillmentStatus: string;
  jobState: string;
  draft?: WorkbenchSchemeDraftDto | null;
  nowMs: number;
}): ExternalPlanBannerMeta {
  const {
    dimension,
    resultId,
    taskId,
    taskName,
    materialLabel,
    fulfillmentStatus,
    jobState,
    draft,
    nowMs
  } = params;
  const draftId = cleanText(draft?.draftId || draft?.id) || null;
  const rawDraftStatus = cleanText(draft?.status).toUpperCase();
  const isFinalized = rawDraftStatus === 'CONFIRMED' || rawDraftStatus === 'DISCARDED';
  const expiresAt = cleanText(draft?.expiresAt) || null;
  const parsedExpireMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const expiredByClock = !isFinalized && Number.isFinite(parsedExpireMs) && parsedExpireMs < nowMs;
  const expired = !isFinalized && (rawDraftStatus === 'EXPIRED' || expiredByClock);
  const stale = isFinalized ? false : Boolean(draft?.stale);
  const staleReasons = isFinalized
    ? []
    : Array.isArray(draft?.staleReasons)
    ? draft.staleReasons.map((s) => cleanText(s)).filter(Boolean)
    : [];
  const riskChecks = normalizeRiskChecks(draft);
  const failedRiskChecks = riskChecks.filter((c) => !c.passed);
  const status = isFinalized
    ? rawDraftStatus
    : expired
    ? 'EXPIRED'
    : rawDraftStatus || (jobState ? jobState.toUpperCase() : 'PREVIEW');
  const normFulfillment = cleanText(fulfillmentStatus).toUpperCase() || 'UNKNOWN';

  return {
    dimension,
    resultId,
    draftId,
    taskId,
    taskName,
    status,
    expired,
    stale,
    staleReasons,
    riskChecks,
    failedRiskChecks,
    note: cleanText(draft?.note) || null,
    materialLabel,
    fulfillmentStatus: normFulfillment,
    fulfillmentLabel: buildFulfillmentLabel(normFulfillment),
    expiresAt,
    nextStep: cleanText(draft?.nextStep) || null,
    batchGroupId: cleanText(draft?.batchGroupId) || null,
    batchIndex: typeof draft?.batchIndex === 'number' ? draft.batchIndex : null,
    batchTotal: typeof draft?.batchTotal === 'number' ? draft.batchTotal : null,
    confirmedSchemeId: cleanText(draft?.confirmedSchemeId) || null,
    confirmedAt: cleanText(draft?.confirmedAt) || null,
    discardedAt: cleanText(draft?.discardedAt) || null,
    discardReason: cleanText(draft?.discardReason) || null
  };
}

/**
 * 将后端 `GET /api/v2/workbench/results/{resultId}/context` 与可选的持久化草案
 * `GET /api/v2/workbench/drafts/{draftId}` 映射为工作台可直接展示、微调和确认落库的
 * `SavedScheme2D`（含直刀外扩 `rectGapPaddingMm` 还原、异形带孔与避疵禁区）或 `SlittingSchemeRun`。
 */
export function mapResultContextToWorkbenchPlan(
  context: WorkbenchResultContextDto | null | undefined,
  draft?: WorkbenchSchemeDraftDto | null,
  loadedFamily?: DemandFamilySummary | null,
  options?: MapDeeplinkPlanOptions
): MappedWorkbenchDeeplinkPlan {
  const nowMs = options?.nowMs ?? Date.now();
  const createdAtLabel =
    options?.createdAtLabel ??
    new Date(nowMs).toLocaleTimeString('zh-CN', { hour12: false });

  const source = context?.source ?? null;
  const taskSummary = context?.taskSummary ?? null;
  const input = context?.input ?? null;
  const job = context?.job ?? null;
  const rawResult = context?.result ?? null;

  const resultId =
    cleanText(context?.resultId || job?.id || rawResult?.id || draft?.target?.resultId) ||
    'EXTERNAL';
  const draftId = cleanText(draft?.draftId || draft?.id) || null;
  const taskId =
    cleanText(
      source?.taskId ||
        taskSummary?.id ||
        taskSummary?.taskId ||
        draft?.target?.taskId ||
        loadedFamily?.id
    ) || null;
  const taskName = cleanText(source?.taskName || taskSummary?.name || loadedFamily?.name) || null;
  const jobState = cleanText(job?.state || job?.status).toUpperCase();

  const problemType = cleanText(input?.problemType).toUpperCase();
  const is1D =
    problemType === 'SLITTING_1D' ||
    Boolean(rawResult?.slitting) ||
    cleanText(source?.dimension || source?.processMode).toUpperCase() === 'SLITTING_1D' ||
    cleanText(taskSummary?.dimension || loadedFamily?.dimension).toUpperCase() === 'SLITTING_1D';
  const dimension: '2D' | '1D' = is1D ? '1D' : '2D';

  const canvasMode = normalizeMaterialType(source?.materialType || draft?.target?.materialType);
  const materialId = cleanText(source?.materialId || draft?.target?.materialId);

  if (!context || !rawResult) {
    const materialLabel = formatMaterialLabel({
      dimension,
      canvasMode,
      materialId,
      widthMm: positiveNum(source?.physicalWidthMm ?? source?.widthMm, 0),
      lengthMm: positiveNum(source?.windowLengthMm ?? source?.canvasLengthMm, 0),
      windowStartY: nonNegNum(source?.windowStartMm ?? source?.windowStartY, 0)
    });
    const reason =
      jobState && jobState !== 'SUCCEEDED'
        ? `试排作业 ${resultId} 当前状态为 ${jobState}${
            job?.message ? `（${job.message}）` : ''
          }，暂无可展示的排料结果。`
        : `未获取到试排结果 ${resultId} 的排布数据，请确认结果号是否有效。`;
    return {
      dimension,
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
        dimension,
        resultId,
        taskId,
        taskName,
        materialLabel,
        fulfillmentStatus: 'UNKNOWN',
        jobState,
        draft,
        nowMs
      }),
      error: reason
    };
  }

  // ==================== 1D 一维分切方案映射 ====================
  if (dimension === '1D') {
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

  // ==================== 2D 二维排料方案映射 ====================
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

  // 直刀外扩还原后必须按净裁片最大 y+height 作为物理占长，避免沿用外扩前的 marker 占长产生尺寸偏移
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
