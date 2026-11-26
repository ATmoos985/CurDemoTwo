import type { SavedScheme2D, WorkbenchDraftPayload } from '../studioTypes';
import type { StudioState } from './sliceTypes';

/**
 * 合并新生成的二维候选方案并自动择优：
 * 优先齐套方案，其次按利用率降序；若启用 selectIfBetter 且当前选中方案仍在同批次且更优，则保持原选中。
 */
export function mergeAndSelectBestSchemes2D(
  prevSchemes: SavedScheme2D[],
  prevActiveId: string | null,
  newSchemes: SavedScheme2D[],
  options?: { selectIfBetter?: boolean; batchIds?: ReadonlySet<string> }
): { schemes2D: SavedScheme2D[]; activeSchemeId2D: string | null } | null {
  if (!newSchemes.length) return null;
  const merged = [...newSchemes, ...prevSchemes];
  const completeOnes = newSchemes.filter((x) => x.complete);
  const pool = completeOnes.length ? completeOnes : newSchemes;
  const bestNew = [...pool].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];

  let nextActiveId = bestNew.id;
  if (options?.selectIfBetter && prevActiveId) {
    const cur = prevSchemes.find((s) => s.id === prevActiveId);
    const curInBatch = cur && (!options.batchIds || options.batchIds.has(cur.id));
    if (cur && curInBatch) {
      const curBetter =
        (cur.complete && !bestNew.complete) ||
        (cur.complete === bestNew.complete && cur.utilizationPct >= bestNew.utilizationPct);
      if (curBetter) {
        nextActiveId = cur.id;
      }
    }
  }

  return {
    schemes2D: merged,
    activeSchemeId2D: nextActiveId
  };
}

/** 将本地工作台草稿容错合并为状态补丁（保留非法/空字段的原状态兜底）。 */
export function buildRestoredWorkbenchState(
  st: StudioState,
  draft: WorkbenchDraftPayload
): Partial<StudioState> {
  return {
    activeDimension: draft.activeDimension || st.activeDimension,
    scenario2D: draft.scenario2D || st.scenario2D,
    multiWidthsText2D: draft.multiWidthsText2D ?? st.multiWidthsText2D,
    canvasMode: draft.canvasMode || st.canvasMode,
    canvasWidthMm: Number(draft.canvasWidthMm) > 0 ? draft.canvasWidthMm : st.canvasWidthMm,
    canvasLengthMm: Number(draft.canvasLengthMm) > 0 ? draft.canvasLengthMm : st.canvasLengthMm,
    windowStartY2D: draft.windowStartY2D ?? null,
    pieceGapMm: Number.isFinite(draft.pieceGapMm) ? draft.pieceGapMm : st.pieceGapMm,
    trimStartMm: Number.isFinite(draft.trimStartMm) ? draft.trimStartMm : st.trimStartMm,
    selectedRollId: draft.selectedRollId ?? st.selectedRollId,
    selectedRemnantId: draft.selectedRemnantId ?? st.selectedRemnantId,
    materialModel2D: draft.materialModel2D || st.materialModel2D,
    activeDemands2D:
      Array.isArray(draft.activeDemands2D) && draft.activeDemands2D.length > 0
        ? draft.activeDemands2D
        : st.activeDemands2D,
    schemes2D: Array.isArray(draft.unconfirmedSchemes2D)
      ? draft.unconfirmedSchemes2D
      : st.schemes2D,
    activeSchemeId2D: draft.activeSchemeId2D ?? draft.unconfirmedSchemes2D?.[0]?.id ?? null,
    scenario1D: draft.scenario1D || st.scenario1D,
    slitMaterialMode: draft.slitMaterialMode || st.slitMaterialMode,
    slitWidthMode: draft.slitWidthMode || st.slitWidthMode,
    slitProfile: draft.slitProfile || st.slitProfile,
    slitMotherWidthMm:
      Number(draft.slitMotherWidthMm) > 0 ? draft.slitMotherWidthMm : st.slitMotherWidthMm,
    slitLeftTrimMm: Number.isFinite(draft.slitLeftTrimMm) ? draft.slitLeftTrimMm : st.slitLeftTrimMm,
    slitRightTrimMm: Number.isFinite(draft.slitRightTrimMm)
      ? draft.slitRightTrimMm
      : st.slitRightTrimMm,
    slitMinWidthMm: Number(draft.slitMinWidthMm) > 0 ? draft.slitMinWidthMm : st.slitMinWidthMm,
    slitMaxWidthMm: Number(draft.slitMaxWidthMm) > 0 ? draft.slitMaxWidthMm : st.slitMaxWidthMm,
    slitWidthStepMm:
      Number(draft.slitWidthStepMm) > 0 ? draft.slitWidthStepMm : st.slitWidthStepMm,
    slitOverCap: Number.isFinite(draft.slitOverCap) ? draft.slitOverCap : st.slitOverCap,
    slitFixedLengthMm:
      Number(draft.slitFixedLengthMm) > 0 ? draft.slitFixedLengthMm : st.slitFixedLengthMm,
    slitAvoidDefects:
      typeof draft.slitAvoidDefects === 'boolean' ? draft.slitAvoidDefects : st.slitAvoidDefects,
    slitRollId: draft.slitRollId ?? st.slitRollId,
    slitMaterialModel: draft.slitMaterialModel || st.slitMaterialModel,
    slitOrders:
      Array.isArray(draft.slitOrders) && draft.slitOrders.length > 0
        ? draft.slitOrders
        : st.slitOrders
  };
}
