import type { DemandFamilySummary } from '../../store/studioTypes';
import {
  buildConfirm1DPayload,
  buildConfirm2DPayload,
  type UseWorkbenchSolverOptions
} from './solverRequestBuilders';
import { idempotentPost, toast } from '../../lib/core/util.js';
import type { LastConfirmSummary } from './workbenchTypes';

export async function executeConfirmScheme2D(
  opts: UseWorkbenchSolverOptions,
  confirmingScheme: boolean,
  callbacks: {
    setConfirmingScheme: (confirming: boolean) => void;
    setLastConfirmSummary: (summary: LastConfirmSummary | null) => void;
  }
) {
  const {
    activeScheme2D,
    activeDemands2D,
    trimStartMm,
    pieceGapMm,
    scenario2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef,
    markSchemeDispatched,
    reloadReferenceData,
    syncDemandFamilyProgress,
    syncMergedDemandFamiliesProgress,
    onDraftConfirmed,
    onDraftConfirmFailed
  } = opts;
  const { setConfirmingScheme, setLastConfirmSummary } = callbacks;

  if (!activeScheme2D || confirmingScheme) return;
  if (activeScheme2D.confirmedSchemeId) {
    location.hash = `#/results/${encodeURIComponent(activeScheme2D.confirmedSchemeId)}`;
    return;
  }
  if (activeScheme2D.layoutDirty) {
    toast('已手调，请先点击「校验并重建刀路」通过后再选定方案', true);
    return;
  }
  setConfirmingScheme(true);
  try {
    const { idempotencyKey, allocSummary, confirmBody } = buildConfirm2DPayload({
      activeScheme2D,
      activeDemands2D,
      trimStartMm,
      pieceGapMm,
      scenario2D,
      loadedTaskId,
      loadedTaskName,
      loadedExternalRef
    });

    const res = await idempotentPost(
      `confirm-2d-${idempotencyKey}`,
      '/api/v2/schemes/confirm',
      confirmBody
    );

    const savedScheme = res.scheme;
    const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
    markSchemeDispatched(activeScheme2D.id, savedScheme.taskId, savedScheme.id);
    if (activeScheme2D.draftId) {
      onDraftConfirmed?.(activeScheme2D.draftId, savedScheme.id);
    }

    const refreshedFamilies = await reloadReferenceData(
      allocSummary.isMultiFamily ? null : savedScheme.taskId
    );
    if (allocSummary.isMultiFamily) {
      syncMergedDemandFamiliesProgress?.(refreshedFamilies);
      const remainingAcrossMerged = refreshedFamilies
        .filter((f) => allocSummary.uniqueTaskIds.includes(f.id))
        .reduce((sum, f) => sum + (Number(f.openTotal) || 0), 0);
      setLastConfirmSummary({
        schemeId: savedScheme.id,
        openRemaining: remainingAcrossMerged,
        state: savedScheme.state
      });
    } else if (updatedFamily) {
      syncDemandFamilyProgress(updatedFamily);
      setLastConfirmSummary({
        schemeId: savedScheme.id,
        openRemaining: updatedFamily.openTotal,
        state: savedScheme.state
      });
    }

    toast(`已确认 ${savedScheme.id}`);
  } catch (err: any) {
    if (activeScheme2D.draftId) {
      onDraftConfirmFailed?.(activeScheme2D.draftId);
    }
    toast('确认失败：' + err.message, true);
  } finally {
    setConfirmingScheme(false);
  }
}

export async function executeConfirmScheme1D(
  opts: UseWorkbenchSolverOptions,
  confirmingScheme: boolean,
  callbacks: {
    setConfirmingScheme: (confirming: boolean) => void;
    setLastConfirmSummary: (summary: LastConfirmSummary | null) => void;
  }
) {
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
    slitOverCap,
    markSlitSchemeDispatched,
    reloadReferenceData,
    syncDemandFamilyProgress,
    syncMergedDemandFamiliesProgress,
    onDraftConfirmed,
    onDraftConfirmFailed
  } = opts;
  const { setConfirmingScheme, setLastConfirmSummary } = callbacks;

  if (!activeScheme1D || activeScheme1D.state !== 'SUCCEEDED' || confirmingScheme) return;
  if (activeScheme1D.confirmedSchemeId) {
    location.hash = `#/results/${encodeURIComponent(activeScheme1D.confirmedSchemeId)}`;
    return;
  }
  setConfirmingScheme(true);
  try {
    const { idempotencyKey, allocSummary, confirmBody } = buildConfirm1DPayload({
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
    });

    const res = await idempotentPost(
      `confirm-1d-${idempotencyKey}`,
      '/api/v2/schemes/confirm',
      confirmBody
    );

    const savedScheme = res.scheme;
    const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
    markSlitSchemeDispatched(activeScheme1D.id, savedScheme.taskId, savedScheme.id);
    if (activeScheme1D.draftId) {
      onDraftConfirmed?.(activeScheme1D.draftId, savedScheme.id);
    }
    const refreshedFamilies = await reloadReferenceData(
      allocSummary.isMultiFamily ? null : savedScheme.taskId
    );
    if (allocSummary.isMultiFamily) {
      syncMergedDemandFamiliesProgress?.(refreshedFamilies);
      const remainingAcrossMerged = refreshedFamilies
        .filter((f) => allocSummary.uniqueTaskIds.includes(f.id))
        .reduce((sum, f) => sum + (Number(f.openTotal) || 0), 0);
      setLastConfirmSummary({
        schemeId: savedScheme.id,
        openRemaining: remainingAcrossMerged,
        state: savedScheme.state
      });
    } else if (updatedFamily) {
      syncDemandFamilyProgress(updatedFamily);
      setLastConfirmSummary({
        schemeId: savedScheme.id,
        openRemaining: updatedFamily.openTotal,
        state: savedScheme.state
      });
    }
    toast(`已确认 ${savedScheme.id}`);
  } catch (err: any) {
    if (activeScheme1D.draftId) {
      onDraftConfirmFailed?.(activeScheme1D.draftId);
    }
    toast('确认失败：' + err.message, true);
  } finally {
    setConfirmingScheme(false);
  }
}
