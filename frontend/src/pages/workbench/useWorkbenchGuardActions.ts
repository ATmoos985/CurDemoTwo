import { useMemo, useState } from 'react';
import type {
  CanvasMode2D,
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D,
  SlittingSchemeRun
} from '../../store/studioTypes';
import { toast } from '../../lib/core/util.js';
import { computeSuggestedFeedWindow } from './workbenchUtils';
import { buildMultiMaterialWorkbenchRequest } from './multiMaterialWorkbenchUtils';
import type { PendingConfirmAction } from './WorkbenchSwitchConfirmModal';

export interface UseWorkbenchGuardActionsParams {
  is2D: boolean;
  schemes2D: SavedScheme2D[];
  activeScheme2D: SavedScheme2D | null;
  slitSchemes: SlittingSchemeRun[];
  canvasMode: CanvasMode2D;
  currentRoll2D: any | null;
  activeDemands2D: DemandItem[];
  effectiveWindowStartY: number;
  trimStartMm: number;
  pieceGapMm: number;
  defectMarginMm: number;
  loadedTaskId: string | null;
  materialModel2D: string;
  activePoolFamily: DemandFamilySummary | null;
  multiPreferRemnants: boolean;
  multiMaxRemnants: number;
  multiCandidateRollIds: string[];
  clearSchemes2D: () => void;
  setLastConfirmSummary: (v: any) => void;
  setCanvasSpec: (spec: Record<string, any>) => void;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  setSlitSpec: (spec: Record<string, any>) => void;
  loadDemandFamilyIntoWorkbench: (fam: DemandFamilySummary) => void;
  loadClusterInto2D: (clusterId: string, append: boolean) => void;
  loadClusterInto1D: (clusterId: string, append: boolean) => void;
  triggerMultiMaterialDraftBatch: (payload: any) => void;
}

export function useWorkbenchGuardActions(params: UseWorkbenchGuardActionsParams) {
  const {
    is2D,
    schemes2D,
    activeScheme2D,
    slitSchemes,
    canvasMode,
    currentRoll2D,
    activeDemands2D,
    effectiveWindowStartY,
    trimStartMm,
    pieceGapMm,
    defectMarginMm,
    loadedTaskId,
    materialModel2D,
    activePoolFamily,
    multiPreferRemnants,
    multiMaxRemnants,
    multiCandidateRollIds,
    clearSchemes2D,
    setLastConfirmSummary,
    setCanvasSpec,
    setSlitSchemes,
    setSlitSpec,
    loadDemandFamilyIntoWorkbench,
    loadClusterInto2D,
    loadClusterInto1D,
    triggerMultiMaterialDraftBatch
  } = params;

  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);

  const hasUnsavedPreviewWork = useMemo(() => {
    if (is2D) {
      return schemes2D.some((s) => !s.confirmedSchemeId) || Boolean(activeScheme2D?.layoutDirty);
    }
    return slitSchemes.some(
      (s) => s.state === 'SUCCEEDED' && !s.confirmedSchemeId && s.strategyId !== 'BASELINE'
    );
  }, [is2D, schemes2D, activeScheme2D?.layoutDirty, slitSchemes]);

  const guardDestructiveSwitch = (title: string, description: string, action: () => void) => {
    if (!hasUnsavedPreviewWork) {
      action();
      return;
    }
    setPendingConfirm({ title, description, action });
  };

  const handleRequestChangeMaterial2D = (spec: Record<string, any>, label: string) => {
    guardDestructiveSwitch(
      `确认${label}？`,
      '当前工作台存在未选定落库的候选方案或手调排布修改。切换母卷/料头来源后将清空当前未确认预览方案，是否继续？',
      () => {
        clearSchemes2D();
        setLastConfirmSummary(null);
        setCanvasSpec(spec);
      }
    );
  };

  const handleRequestChangeMaterial1D = (spec: Record<string, any>, label: string) => {
    guardDestructiveSwitch(
      `确认${label}？`,
      '当前存在未落库的一维分切候选方案。切换母卷来源后将清空当前候选方案，是否继续？',
      () => {
        setSlitSchemes([]);
        setLastConfirmSummary(null);
        setSlitSpec(spec);
      }
    );
  };

  const handleSuggestFeedWindow = () => {
    if (canvasMode !== 'STOCK_ROLL' || !currentRoll2D) return;
    const suggestion = computeSuggestedFeedWindow({
      roll: currentRoll2D,
      demands: activeDemands2D,
      windowStartY: effectiveWindowStartY,
      trimStartMm,
      defaultDefectMarginMm: defectMarginMm
    });
    setCanvasSpec({
      canvasLengthMm: suggestion.suggestedLengthMm,
      windowStartY2D: suggestion.suggestedStartY
    });
    toast(suggestion.reason);
  };

  const handleGuardedLoadFamily = (fam: DemandFamilySummary) => {
    guardDestructiveSwitch(
      `确认载入需求族「${fam.name}」？`,
      '当前工作台存在未落库的候选方案或手排修改。切换需求族将替换当前需求列表并清空未确认预览，是否继续？',
      () => {
        setLastConfirmSummary(null);
        loadDemandFamilyIntoWorkbench(fam);
      }
    );
  };

  const handleGuardedLoadCluster2D = (clusterId: string, append: boolean) => {
    if (append) {
      loadClusterInto2D(clusterId, true);
      return;
    }
    guardDestructiveSwitch(
      '确认重载需求模板？',
      '当前工作台存在未落库的候选方案或手排修改。重新载入模板将清空当前候选预览并替换需求清单，是否继续？',
      () => {
        setLastConfirmSummary(null);
        loadClusterInto2D(clusterId, false);
      }
    );
  };

  const handleGuardedLoadCluster1D = (clusterId: string, append: boolean) => {
    if (append) {
      loadClusterInto1D(clusterId, true);
      return;
    }
    guardDestructiveSwitch(
      '确认重载一维分切模板？',
      '当前存在未落库的一维分切候选方案。重新载入模板将清空当前候选方案，是否继续？',
      () => {
        setLastConfirmSummary(null);
        loadClusterInto1D(clusterId, false);
      }
    );
  };

  const handleGenerateMultiMaterialDrafts = () => {
    const reqRes = buildMultiMaterialWorkbenchRequest({
      demands: activeDemands2D,
      taskId: loadedTaskId,
      materialModel: materialModel2D,
      requiredBatchNo: activePoolFamily?.requiredBatchNo || null,
      requiredColor: activePoolFamily?.requiredColor || null,
      preferRemnants: multiPreferRemnants,
      maxRemnants: multiMaxRemnants,
      candidateRollIds: multiCandidateRollIds,
      pieceGapMm,
      trimStartMm
    });
    if ('error' in reqRes) {
      toast(reqRes.error, true);
      return;
    }
    triggerMultiMaterialDraftBatch({
      ...reqRes.payload,
      continueAcrossRolls: true,
      ttlSeconds: 1800
    });
  };

  return {
    pendingConfirm,
    setPendingConfirm,
    handleRequestChangeMaterial2D,
    handleRequestChangeMaterial1D,
    handleSuggestFeedWindow,
    handleGuardedLoadFamily,
    handleGuardedLoadCluster2D,
    handleGuardedLoadCluster1D,
    handleGenerateMultiMaterialDrafts
  };
}
