import type { SavedSchemeCanvasMode2D } from '../../store/studioTypes';
import type {
  ExternalPlanBannerMeta,
  ExternalPlanRiskCheck,
  WorkbenchRiskCheckDto,
  WorkbenchSchemeDraftDto
} from './workbenchDeeplinkTypes';
import { cleanText } from './workbenchDeeplinkGeometry';

export function buildFulfillmentLabel(status: string): string {
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

export function formatMaterialLabel(params: {
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

export function buildBannerMeta(params: {
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
