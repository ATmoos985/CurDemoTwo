import type { DemandFamilySummary } from '../../store/studioTypes';
import type {
  MapDeeplinkPlanOptions,
  MappedWorkbenchDeeplinkPlan,
  WorkbenchResultContextDto,
  WorkbenchSchemeDraftDto
} from './workbenchDeeplinkTypes';
import {
  cleanText,
  computeShapeNetAreaMm2,
  nonNegNum,
  normalizeMaterialType,
  positiveNum,
  resolveRectGapPaddingMm
} from './workbenchDeeplinkGeometry';
import { buildBannerMeta, formatMaterialLabel } from './workbenchDeeplinkBanner';
import { map1DResultContext } from './workbenchDeeplink1DMapper';
import { map2DResultContext } from './workbenchDeeplink2DMapper';

export type {
  WorkbenchJobSourceDto,
  WorkbenchTaskSummaryDto,
  WorkbenchResultContextDto,
  WorkbenchRiskCheckDto,
  WorkbenchSchemeDraftDto,
  ExternalPlanRiskCheck,
  ExternalPlanBannerMeta,
  WorkbenchSlitSpecPatch,
  MappedWorkbenchDeeplinkPlan,
  MapDeeplinkPlanOptions
} from './workbenchDeeplinkTypes';

export { computeShapeNetAreaMm2, resolveRectGapPaddingMm };

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

  if (dimension === '1D') {
    return map1DResultContext({
      context,
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
    });
  }

  return map2DResultContext({
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
  });
}
