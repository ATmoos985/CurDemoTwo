import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore } from '../store/useStudioStore';
import type { StudioSettings } from '../store/studioSettings';
import type { WorkbenchBoardHandle } from '../components/canvas/canvasTypes';
import '../styles/theme-workbench-v2.css';
import './workbench/multiMaterialWorkbench.css';
import './workbench/draftInbox.css';

import {
  DEFAULT_ENABLED_STRATEGIES,
  LEGACY_STRATEGY_ALIAS,
  STRATEGIES_2D
} from './workbench/workbenchTypes';
import {
  computeDefectSchedules1D,
  computeDemandRowsView,
  computeOverviewStats,
  exportCam2D,
  exportExcel1D
} from './workbench/workbenchUtils';
import {
  buildMultiMaterialCandidateRollOptions,
  exportMultiMaterialCsv
} from './workbench/multiMaterialWorkbenchUtils';
import { useWorkbenchBoardEdit } from './workbench/useWorkbenchBoardEdit';
import { useWorkbenchSolver } from './workbench/useWorkbenchSolver';
import { fetchWorkbenchDraft } from './workbench/draftInboxApi';
import {
  buildBoardCuts,
  buildBoardLeftovers,
  buildBoardPlacedPieces,
  buildBoardStagingDemands,
  computeBatchGuardWarning,
  computeEffectiveRollLengthMm,
  computeEffectiveRollTitle,
  computeEffectiveRollWidthMm,
  computeEffectiveWindowStartY,
  computeTaskExecutionProjection,
  computeWindowDefects2D
} from './workbench/workbenchProjectionUtils';
import { useWorkbenchLocalDraft } from './workbench/useWorkbenchLocalDraft';
import { useWorkbenchDataAndDeeplink } from './workbench/useWorkbenchDataAndDeeplink';
import { useWorkbenchGuardActions } from './workbench/useWorkbenchGuardActions';
import { WorkbenchWorkspaceView } from './workbench/WorkbenchWorkspaceView';

export { SlittingStripBar } from './workbench/SlittingStripBar';
export {
  computeTaskExecutionProjection,
  annotateBoardPiecesWithReinspection,
  type ReinspectedPieceTag,
  type SchemeExecutionSummary,
  type TaskExecutionProjection
} from './workbench/workbenchProjectionUtils';

export const CuttingWorkbenchPage: React.FC<{
  taskId?: string;
  resultId?: string;
  draftId?: string;
  forceDimension?: '2D' | '1D';
}> = ({ taskId, resultId, draftId, forceDimension }) => {
  const s = useStudioStore();
  const extSettings = s.settings as StudioSettings & {
    showWorkflowGuide?: boolean;
    enabledStrategies2D?: string[];
  };
  const showWorkflowGuide = Boolean(extSettings.showWorkflowGuide);

  const activeAlgos = useMemo(() => {
    const rawList =
      Array.isArray(extSettings.enabledStrategies2D) && extSettings.enabledStrategies2D.length > 0
        ? extSettings.enabledStrategies2D
        : Array.isArray(s.selectedStrategies2D) && s.selectedStrategies2D.length > 0
        ? s.selectedStrategies2D
        : DEFAULT_ENABLED_STRATEGIES;
    const normalized = new Set(rawList.map((id) => LEGACY_STRATEGY_ALIAS[id] || id));
    const matched = STRATEGIES_2D.filter((item) => normalized.has(item.id));
    return matched.length > 0 ? matched : [STRATEGIES_2D[4]];
  }, [extSettings.enabledStrategies2D, s.selectedStrategies2D]);

  const [demandSourceTab, setDemandSourceTab] = useState<'POOL' | 'TEMPLATE'>('TEMPLATE');
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');
  const [overviewModalOpen, setOverviewModalOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<'progress' | 'edit'>('progress');

  const [showPath, setShowPath] = useState<boolean>(s.settings.showPath);
  const [showDimensions, setShowDimensions] = useState<boolean>(s.settings.showDimensions);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoveredDemandKey, setHoveredDemandKey] = useState<string | null>(null);
  const [pinnedDemandKey, setPinnedDemandKey] = useState<string | null>(null);
  const [selectedPieceIndex, setSelectedPieceIndex] = useState<number | null>(null);
  const [selectedLeftoverId, setSelectedLeftoverId] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth <= 1120
  );

  useEffect(() => {
    setShowPath(s.settings.showPath);
    setShowDimensions(s.settings.showDimensions);
  }, [s.settings.showPath, s.settings.showDimensions]);

  useEffect(() => {
    if (forceDimension) s.setActiveDimension(forceDimension);
  }, [forceDimension]);

  const leftPaneRef = useRef<HTMLElement | null>(null);
  const rightPaneRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<WorkbenchBoardHandle | null>(null);

  const is2D = s.activeDimension === '2D';
  const activeDraftTaskKey = (is2D ? s.loadedTaskId : s.slitLoadedTaskId) || taskId || 'scratch';

  const activeScheme2D = useMemo(
    () => s.schemes2D.find((item) => item.id === s.activeSchemeId2D) || null,
    [s.schemes2D, s.activeSchemeId2D]
  );
  const activeScheme1D = useMemo(
    () => s.slitSchemes.find((item) => item.id === s.activeSlitSchemeId) || s.slitSchemes[0] || null,
    [s.slitSchemes, s.activeSlitSchemeId]
  );

  useEffect(() => {
    setSelectedPieceIndex(null);
    setSelectedLeftoverId(null);
  }, [s.activeSchemeId2D]);

  const {
    recoverableDraft,
    markDraftHydratedClean,
    clearLocalDraftForTask,
    handleRestoreLocalDraft,
    handleIgnoreLocalDraft
  } = useWorkbenchLocalDraft({
    activeDraftTaskKey,
    activeDimension: s.activeDimension,
    scenario2D: s.scenario2D,
    multiWidthsText2D: s.multiWidthsText2D,
    canvasMode: s.canvasMode,
    canvasWidthMm: s.canvasWidthMm,
    canvasLengthMm: s.canvasLengthMm,
    windowStartY2D: s.windowStartY2D,
    pieceGapMm: s.pieceGapMm,
    trimStartMm: s.trimStartMm,
    selectedRollId: s.selectedRollId,
    selectedRemnantId: s.selectedRemnantId,
    materialModel2D: s.materialModel2D,
    activeDemands2D: s.activeDemands2D,
    schemes2D: s.schemes2D,
    activeSchemeId2D: s.activeSchemeId2D,
    scenario1D: s.scenario1D,
    slitMaterialMode: s.slitMaterialMode,
    slitWidthMode: s.slitWidthMode,
    slitProfile: s.slitProfile,
    slitMotherWidthMm: s.slitMotherWidthMm,
    slitLeftTrimMm: s.slitLeftTrimMm,
    slitRightTrimMm: s.slitRightTrimMm,
    slitMinWidthMm: s.slitMinWidthMm,
    slitMaxWidthMm: s.slitMaxWidthMm,
    slitWidthStepMm: s.slitWidthStepMm,
    slitOverCap: s.slitOverCap,
    slitFixedLengthMm: s.slitFixedLengthMm,
    slitAvoidDefects: s.slitAvoidDefects,
    slitRollId: s.slitRollId,
    slitMaterialModel: s.slitMaterialModel,
    slitOrders: s.slitOrders,
    restoreWorkbenchDraft: s.restoreWorkbenchDraft
  });

  const {
    rolls,
    remnants,
    poolFamilies,
    taskSchemes,
    taskReports,
    reloadReferenceData,
    externalPlanLoading,
    externalPlanError,
    setExternalPlanError,
    externalPlanBanner,
    setExternalPlanBanner,
    externalPlanDismissed,
    setExternalPlanDismissed,
    siblingDrafts,
    draftInbox,
    activeDraftBlockedReason,
    syncExternalPlanBannerWithDraft
  } = useWorkbenchDataAndDeeplink({
    taskId,
    resultId,
    draftId,
    activeDimension: s.activeDimension,
    loadedTaskId: s.loadedTaskId,
    slitLoadedTaskId: s.slitLoadedTaskId,
    activeScheme2D,
    activeScheme1D,
    syncTemplatesFromServer: s.syncTemplatesFromServer,
    syncDemandFamilyProgress: s.syncDemandFamilyProgress,
    loadDemandFamilyIntoWorkbench: s.loadDemandFamilyIntoWorkbench,
    setActiveDimension: s.setActiveDimension,
    setCanvasSpec: s.setCanvasSpec,
    setActiveDemands2D: s.setActiveDemands2D,
    setSchemes2D: s.setSchemes2D,
    setSlitSpec: s.setSlitSpec,
    setSlitSchemes: s.setSlitSchemes,
    setActiveSlitScheme: s.setActiveSlitScheme,
    getSchemes2D: () => useStudioStore.getState().schemes2D,
    getSlitSchemes: () => useStudioStore.getState().slitSchemes,
    onDeeplinkHydratedDraft: markDraftHydratedClean,
    onDemandPoolLoaded: () => setDemandSourceTab('POOL')
  });

  const passedRolls = useMemo(() => rolls.filter((r) => r.inspectionStatus === 'PASSED'), [rolls]);
  const availableRemnants = useMemo(() => remnants.filter((rm) => rm.status === 'AVAILABLE'), [remnants]);
  const currentRoll2D = useMemo(
    () => passedRolls.find((r) => r.rollId === s.selectedRollId) || passedRolls[0] || null,
    [passedRolls, s.selectedRollId]
  );
  const currentRemnant2D = useMemo(
    () => availableRemnants.find((rm) => rm.id === s.selectedRemnantId) || availableRemnants[0] || null,
    [availableRemnants, s.selectedRemnantId]
  );
  const currentRoll1D = useMemo(
    () => passedRolls.find((r) => r.rollId === s.slitRollId) || passedRolls[0] || null,
    [passedRolls, s.slitRollId]
  );

  const activeTaskId = is2D ? s.loadedTaskId : s.slitLoadedTaskId;
  const activePoolFamily = useMemo(
    () => (activeTaskId ? poolFamilies.find((f) => f.id === activeTaskId) || null : null),
    [activeTaskId, poolFamilies]
  );

  const multiFilterContext = useMemo(
    () => ({
      materialModel: activePoolFamily?.materialModel || s.materialModel2D || undefined,
      requiredBatchNo: activePoolFamily?.requiredBatchNo || undefined,
      requiredColor: activePoolFamily?.requiredColor || undefined,
      strictBatchMatch: Boolean(activePoolFamily?.strictBatchMatch)
    }),
    [activePoolFamily, s.materialModel2D]
  );
  const multiCandidateRollOptions = useMemo(
    () => buildMultiMaterialCandidateRollOptions(passedRolls, multiFilterContext),
    [passedRolls, multiFilterContext]
  );

  const effectiveWindowStartY = useMemo(
    () =>
      computeEffectiveWindowStartY({
        canvasMode: s.canvasMode,
        currentRoll2D,
        windowStartY2D: s.windowStartY2D
      }),
    [s.canvasMode, currentRoll2D, s.windowStartY2D]
  );
  const effectiveRollWidthMm = useMemo(
    () =>
      computeEffectiveRollWidthMm({
        activeScheme2D,
        canvasMode: s.canvasMode,
        currentRoll2D,
        currentRemnant2D,
        multiCandidateRollOptions,
        canvasWidthMm: s.canvasWidthMm
      }),
    [activeScheme2D, s.canvasMode, currentRoll2D, currentRemnant2D, multiCandidateRollOptions, s.canvasWidthMm]
  );
  const effectiveRollLengthMm = useMemo(
    () =>
      computeEffectiveRollLengthMm({
        activeScheme2D,
        canvasMode: s.canvasMode,
        currentRemnant2D,
        canvasLengthMm: s.canvasLengthMm
      }),
    [activeScheme2D, s.canvasMode, currentRemnant2D, s.canvasLengthMm]
  );
  const effectiveTrimStartMm = useMemo(
    () => ((activeScheme2D ? activeScheme2D.canvasMode : s.canvasMode) === 'REMNANT' ? 0 : s.trimStartMm),
    [activeScheme2D, s.canvasMode, s.trimStartMm]
  );
  const effectiveRollTitle = useMemo(
    () =>
      computeEffectiveRollTitle({
        activeScheme2D,
        canvasMode: s.canvasMode,
        currentRoll2D,
        currentRemnant2D
      }),
    [activeScheme2D, s.canvasMode, currentRoll2D, currentRemnant2D]
  );
  const windowDefects2D = useMemo(
    () =>
      computeWindowDefects2D({
        activeScheme2D,
        canvasMode: s.canvasMode,
        rolls,
        remnants,
        currentRoll2D,
        currentRemnant2D,
        effectiveWindowStartY,
        effectiveRollWidthMm,
        effectiveRollLengthMm,
        defectMarginMm: s.settings.defectMarginMm
      }),
    [
      activeScheme2D,
      s.canvasMode,
      rolls,
      remnants,
      currentRoll2D,
      currentRemnant2D,
      effectiveWindowStartY,
      effectiveRollWidthMm,
      effectiveRollLengthMm,
      s.settings.defectMarginMm
    ]
  );

  const activeOpenRemainingFallback = useMemo(() => {
    if (activePoolFamily && Number.isFinite(Number(activePoolFamily.openTotal))) {
      return Math.max(0, Number(activePoolFamily.openTotal));
    }
    return is2D
      ? s.activeDemands2D.reduce((sum, d) => sum + Math.max(0, Number(d.quantity) || 0), 0)
      : s.slitOrders.reduce((sum, o) => sum + Math.max(0, Number(o.quantity) || 0), 0);
  }, [activePoolFamily, is2D, s.activeDemands2D, s.slitOrders]);

  const taskExecutionProjection = useMemo(
    () =>
      computeTaskExecutionProjection({
        taskId: activeTaskId,
        rawReports: taskReports,
        taskSchemes,
        openRemainingCount: activeOpenRemainingFallback
      }),
    [activeTaskId, taskReports, taskSchemes, activeOpenRemainingFallback]
  );
  const activeSchemeExecution = useMemo(() => {
    const confirmedId = activeScheme2D?.confirmedSchemeId;
    if (!confirmedId || !taskExecutionProjection) return null;
    return taskExecutionProjection.bySchemeId.get(confirmedId) || null;
  }, [activeScheme2D?.confirmedSchemeId, taskExecutionProjection]);

  const boardPlacedPieces = useMemo(
    () => buildBoardPlacedPieces(activeScheme2D, activeSchemeExecution),
    [activeScheme2D, activeSchemeExecution]
  );
  const boardLeftovers = useMemo(() => buildBoardLeftovers(activeScheme2D), [activeScheme2D]);
  const boardCuts = useMemo(() => buildBoardCuts(activeScheme2D), [activeScheme2D]);
  const boardStagingDemands = useMemo(
    () => buildBoardStagingDemands(s.activeDemands2D, activeScheme2D),
    [s.activeDemands2D, activeScheme2D]
  );

  const batchGuardWarning = useMemo(
    () =>
      computeBatchGuardWarning({
        activePoolFamily,
        is2D,
        canvasMode: s.canvasMode,
        currentRoll2D,
        currentRemnant2D,
        multiCandidateRollIds: s.multiCandidateRollIds,
        slitMaterialMode: s.slitMaterialMode,
        currentRoll1D,
        passedRolls
      }),
    [
      activePoolFamily,
      is2D,
      s.canvasMode,
      currentRoll2D,
      currentRemnant2D,
      s.multiCandidateRollIds,
      s.slitMaterialMode,
      currentRoll1D,
      passedRolls
    ]
  );

  const solver = useWorkbenchSolver({
    activeDemands2D: s.activeDemands2D,
    activeAlgos,
    canvasMode: s.canvasMode,
    scenario2D: s.scenario2D,
    multiWidthsText2D: s.multiWidthsText2D,
    canvasWidthMm: s.canvasWidthMm,
    canvasLengthMm: s.canvasLengthMm,
    windowStartY2D: effectiveWindowStartY,
    pieceGapMm: s.pieceGapMm,
    trimStartMm: s.trimStartMm,
    materialModel2D: s.materialModel2D,
    requiredBatchNo: activePoolFamily?.requiredBatchNo || null,
    requiredColor: activePoolFamily?.requiredColor || null,
    multiPreferRemnants: s.multiPreferRemnants,
    multiMaxRemnants: s.multiMaxRemnants,
    multiCandidateRollIds: s.multiCandidateRollIds,
    loadedTaskId: s.loadedTaskId,
    loadedTaskName: s.loadedTaskName || '',
    loadedExternalRef: s.loadedExternalRef || '',
    currentRoll2D,
    currentRemnant2D,
    activeScheme2D,
    setStrategyRuns2D: s.setStrategyRuns2D,
    addSchemes2D: s.addSchemes2D,
    setSchemes2D: s.setSchemes2D,
    setMultiMaterialSummary: s.setMultiMaterialSummary,
    markSchemeDispatched: s.markSchemeDispatched,
    slitOrders: s.slitOrders,
    slitMaterialMode: s.slitMaterialMode,
    slitWidthMode: s.slitWidthMode,
    slitProfile: s.slitProfile,
    slitMotherWidthMm: s.slitMotherWidthMm,
    slitLeftTrimMm: s.slitLeftTrimMm,
    slitRightTrimMm: s.slitRightTrimMm,
    slitMinWidthMm: s.slitMinWidthMm,
    slitMaxWidthMm: s.slitMaxWidthMm,
    slitWidthStepMm: s.slitWidthStepMm,
    slitOverCap: s.slitOverCap,
    slitMaxKnives: s.slitMaxKnives,
    slitMinBladeSpacingMm: s.slitMinBladeSpacingMm,
    slitKerfMm: s.slitKerfMm,
    slitForbiddenNarrowEdgeMinMm: s.slitForbiddenNarrowEdgeMinMm,
    slitForbiddenNarrowEdgeMaxMm: s.slitForbiddenNarrowEdgeMaxMm,
    slitFixedLengthMm: s.slitFixedLengthMm,
    slitAvoidDefects: s.slitAvoidDefects,
    slitMaterialModel: s.slitMaterialModel,
    slitLoadedTaskId: s.slitLoadedTaskId,
    slitLoadedTaskName: s.slitLoadedTaskName,
    scenario1D: s.scenario1D,
    currentRoll1D,
    activeScheme1D,
    setSlitSchemes: s.setSlitSchemes,
    markSlitSchemeDispatched: s.markSlitSchemeDispatched,
    settings: s.settings,
    batchGuardWarning,
    reloadReferenceData,
    syncDemandFamilyProgress: s.syncDemandFamilyProgress,
    syncMergedDemandFamiliesProgress: s.syncMergedDemandFamiliesProgress,
    onDraftConfirmed: (confirmedDraftId, schemeId) => {
      draftInbox.refreshDraftInbox({ silent: true }).catch(() => {});
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === confirmedDraftId
          ? { ...prev, status: 'CONFIRMED', confirmedSchemeId: schemeId, expired: false, stale: false, staleReasons: [] }
          : prev
      );
    },
    onDraftConfirmFailed: (failedDraftId) => {
      draftInbox.refreshDraftInbox({ silent: true }).catch(() => {});
      fetchWorkbenchDraft(failedDraftId).then(syncExternalPlanBannerWithDraft).catch(() => {});
    }
  });

  useEffect(() => {
    if (solver.lastConfirmSummary?.schemeId) clearLocalDraftForTask();
  }, [solver.lastConfirmSummary?.schemeId, clearLocalDraftForTask]);

  const boardEdit = useWorkbenchBoardEdit({
    activeScheme2D,
    activeDemands2D: s.activeDemands2D,
    canvasMode: s.canvasMode,
    scenario2D: s.scenario2D,
    currentRoll2D,
    currentRemnant2D,
    materialModel2D: s.materialModel2D,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    effectiveWindowStartY,
    pieceGapMm: s.pieceGapMm,
    trimStartMm: effectiveTrimStartMm,
    windowDefects2D,
    settings: s.settings,
    removeScheme2D: s.removeScheme2D,
    setSelectedPieceIndex,
    setSelectedLeftoverId,
    setLastConfirmSummary: solver.setLastConfirmSummary
  });

  const guards = useWorkbenchGuardActions({
    is2D,
    schemes2D: s.schemes2D,
    activeScheme2D,
    slitSchemes: s.slitSchemes,
    canvasMode: s.canvasMode,
    currentRoll2D,
    activeDemands2D: s.activeDemands2D,
    effectiveWindowStartY,
    trimStartMm: s.trimStartMm,
    pieceGapMm: s.pieceGapMm,
    defectMarginMm: s.settings.defectMarginMm,
    loadedTaskId: s.loadedTaskId,
    materialModel2D: s.materialModel2D,
    activePoolFamily,
    multiPreferRemnants: s.multiPreferRemnants,
    multiMaxRemnants: s.multiMaxRemnants,
    multiCandidateRollIds: s.multiCandidateRollIds,
    clearSchemes2D: s.clearSchemes2D,
    setLastConfirmSummary: solver.setLastConfirmSummary,
    setCanvasSpec: s.setCanvasSpec,
    setSlitSchemes: s.setSlitSchemes,
    setSlitSpec: s.setSlitSpec,
    loadDemandFamilyIntoWorkbench: s.loadDemandFamilyIntoWorkbench,
    loadClusterInto2D: s.loadClusterInto2D,
    loadClusterInto1D: s.loadClusterInto1D,
    triggerMultiMaterialDraftBatch: draftInbox.triggerMultiMaterialDraftBatch
  });

  const filteredClusters = s.clusters.filter((c) => c.dimension === s.activeDimension);
  const quickCluster = filteredClusters.find((c) => c.id === activeClusterQuickId) || filteredClusters[0];
  const quickCounts =
    (quickCluster && s.clusterSelections[quickCluster.id]) || quickCluster?.defaultSizeCounts || {};
  const filteredPoolFamilies = poolFamilies.filter((f) =>
    is2D ? f.dimension !== 'SLITTING_1D' : f.dimension === 'SLITTING_1D'
  );
  const totalRolls1D = s.slitOrders.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
  const demandRowsView = useMemo(
    () =>
      computeDemandRowsView({
        is2D,
        activeDemands2D: s.activeDemands2D,
        activeScheme2D,
        slitOrders: s.slitOrders,
        activeScheme1D,
        slitFixedLengthMm: s.slitFixedLengthMm
      }),
    [is2D, s.activeDemands2D, activeScheme2D, s.slitOrders, activeScheme1D, s.slitFixedLengthMm]
  );
  const overviewStats = useMemo(() => computeOverviewStats(demandRowsView, is2D), [demandRowsView, is2D]);
  const hasCandidateResult = is2D
    ? Boolean(activeScheme2D)
    : Boolean(activeScheme1D && activeScheme1D.state === 'SUCCEEDED');
  const currentStage: 1 | 2 | 3 = solver.runningSolve ? 2 : hasCandidateResult ? 3 : 1;
  const bestUtil2D = useMemo(
    () => (s.schemes2D.length ? Math.max(...s.schemes2D.map((x) => x.utilizationPct)) : 0),
    [s.schemes2D]
  );
  const baseline1D = useMemo(
    () => s.slitSchemes.find((item) => item.strategyId === 'BASELINE') || null,
    [s.slitSchemes]
  );
  const defectSchedules1D = useMemo(
    () =>
      computeDefectSchedules1D({
        slitAvoidDefects: s.slitAvoidDefects,
        slitMaterialMode: s.slitMaterialMode,
        currentRoll1D,
        activeScheme1D,
        slitOrders: s.slitOrders,
        slitFixedLengthMm: s.slitFixedLengthMm,
        slitLeftTrimMm: s.slitLeftTrimMm
      }),
    [s.slitAvoidDefects, s.slitMaterialMode, currentRoll1D, activeScheme1D, s.slitOrders, s.slitFixedLengthMm, s.slitLeftTrimMm]
  );

  const activeHighlightKey = hoveredDemandKey || pinnedDemandKey;
  const splitCls = [
    'studio-split',
    leftCollapsed ? 'is-left-collapsed' : '',
    rightCollapsed ? 'is-right-collapsed' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <WorkbenchWorkspaceView
      splitCls={splitCls}
      leftCollapsed={leftCollapsed}
      rightCollapsed={rightCollapsed}
      is2D={is2D}
      activeScheme2D={activeScheme2D}
      activeScheme1D={activeScheme1D}
      setCanvasSpec={s.setCanvasSpec}
      setSlitSpec={s.setSlitSpec}
      externalPlanLoading={externalPlanLoading}
      externalPlanError={externalPlanError}
      setExternalPlanError={setExternalPlanError}
      externalPlanBanner={externalPlanBanner}
      externalPlanDismissed={externalPlanDismissed}
      setExternalPlanDismissed={setExternalPlanDismissed}
      siblingDrafts={siblingDrafts}
      draftInbox={draftInbox}
      batchGuardWarning={batchGuardWarning}
      taskExecutionProjection={taskExecutionProjection}
      activeSchemeExecution={activeSchemeExecution}
      recoverableDraft={recoverableDraft}
      onRestoreLocalDraft={handleRestoreLocalDraft}
      onIgnoreLocalDraft={handleIgnoreLocalDraft}
      pendingConfirm={guards.pendingConfirm}
      onClearPendingConfirm={() => guards.setPendingConfirm(null)}
      topBarProps={{
        is2D,
        setActiveDimension: s.setActiveDimension,
        showWorkflowGuide,
        currentStage,
        leftPaneRef,
        rightPaneRef,
        stripRef,
        leftCollapsed,
        rightCollapsed,
        onToggleLeftPane: () => setLeftCollapsed((v) => !v),
        onToggleRightPane: () => setRightCollapsed((v) => !v),
        pendingDraftCount: draftInbox.pendingCount,
        onOpenDraftInbox: draftInbox.openDrawer,
        canvasMode: s.canvasMode,
        scenario2D: s.scenario2D,
        multiWidthsText2D: s.multiWidthsText2D,
        setMultiWidthsText2D: s.setMultiWidthsText2D,
        canvasWidthMm: s.canvasWidthMm,
        canvasLengthMm: s.canvasLengthMm,
        effectiveWindowStartY,
        pieceGapMm: s.pieceGapMm,
        trimStartMm: s.trimStartMm,
        setCanvasSpec: s.setCanvasSpec,
        onRequestChangeMaterial2D: guards.handleRequestChangeMaterial2D,
        onSuggestFeedWindow: guards.handleSuggestFeedWindow,
        passedRolls,
        availableRemnants,
        currentRoll2D,
        currentRemnant2D,
        multiPreferRemnants: s.multiPreferRemnants,
        multiMaxRemnants: s.multiMaxRemnants,
        multiCandidateRollIds: s.multiCandidateRollIds,
        multiCandidateRollOptions,
        multiFilterContext,
        slitMaterialMode: s.slitMaterialMode,
        slitMotherWidthMm: s.slitMotherWidthMm,
        slitFixedLengthMm: s.slitFixedLengthMm,
        slitLeftTrimMm: s.slitLeftTrimMm,
        slitRightTrimMm: s.slitRightTrimMm,
        slitWidthMode: s.slitWidthMode,
        slitMinWidthMm: s.slitMinWidthMm,
        slitMaxWidthMm: s.slitMaxWidthMm,
        currentRoll1D,
        setSlitSpec: s.setSlitSpec,
        onRequestChangeMaterial1D: guards.handleRequestChangeMaterial1D
      }}
      sidebarProps={{
        leftPaneRef,
        is2D,
        demandSourceTab,
        setDemandSourceTab,
        filteredPoolFamilies,
        filteredClusters,
        loadedTaskId: s.loadedTaskId,
        loadedTaskName: s.loadedTaskName,
        slitLoadedTaskId: s.slitLoadedTaskId,
        slitLoadedTaskName: s.slitLoadedTaskName,
        loadDemandFamilyIntoWorkbench: guards.handleGuardedLoadFamily,
        onClearConfirmSummary: () => solver.setLastConfirmSummary(null),
        quickCluster,
        quickCounts,
        setActiveClusterQuickId,
        setClusterCount: s.setClusterCount,
        loadClusterInto2D: guards.handleGuardedLoadCluster2D,
        loadClusterInto1D: guards.handleGuardedLoadCluster1D,
        overviewStats,
        demandRowsView,
        activeHighlightKey,
        setHoveredDemandKey,
        setPinnedDemandKey,
        onOpenOverview: (tab) => {
          setOverviewTab(tab);
          setOverviewModalOpen(true);
        },
        onAddBlankDemand: () => {
          if (is2D) s.addBlankDemand2D();
          else s.addSlitOrder();
          setOverviewTab('edit');
          setOverviewModalOpen(true);
        }
      }}
      centerProps={{
        is2D,
        stripRef,
        boardRef,
        vertical: s.settings.vertical,
        onToggleVertical: () => s.updateStudioSettings({ ...s.settings, vertical: !s.settings.vertical }),
        startCorner: s.settings.startCorner,
        showDimensions,
        setShowDimensions,
        showPath,
        setShowPath,
        selectedPieceIndex,
        setSelectedPieceIndex,
        selectedLeftoverId,
        setSelectedLeftoverId,
        cursor,
        setCursor,
        activeScheme2D,
        schemes2D: s.schemes2D,
        bestUtil2D,
        setActiveScheme2D: s.setActiveScheme2D,
        removeScheme2D: s.removeScheme2D,
        clearSchemes2D: s.clearSchemes2D,
        effectiveRollTitle,
        effectiveRollWidthMm,
        effectiveRollLengthMm,
        trimStartMm: effectiveTrimStartMm,
        pieceGapMm: s.pieceGapMm,
        windowDefects2D,
        boardStagingDemands,
        boardPlacedPieces,
        boardLeftovers,
        boardCuts,
        activeHighlightKey,
        setHoveredDemandKey,
        canUndo: boardEdit.canUndo,
        canRedo: boardEdit.canRedo,
        canRestoreOriginal: boardEdit.canRestoreOriginal,
        onUndo: boardEdit.handleUndoBoardEdit,
        onRedo: boardEdit.handleRedoBoardEdit,
        onRestoreOriginalPreview: boardEdit.handleRestoreOriginalPreview,
        onDropStagingPiece: boardEdit.handleDropStagingPiece,
        onMovePlacedPiece: boardEdit.handleMovePlacedPiece,
        onNudgePlacedPiece: boardEdit.handleNudgePlacedPiece,
        onRotatePlacedPiece: boardEdit.handleRotatePlacedPiece,
        onRemovePlacedPiece: boardEdit.handleRemovePlacedPiece,
        onDiscardLeftover: boardEdit.handleDiscardLeftover,
        validatingLayout: boardEdit.validatingLayout,
        onValidateAndRebuildLayout: boardEdit.handleValidateAndRebuildLayout,
        slitSchemes: s.slitSchemes,
        activeScheme1D,
        setActiveSlitScheme: s.setActiveSlitScheme,
        baselineCars1D: baseline1D?.totalCars || 0,
        solveElapsedMs: solver.solveElapsedMs,
        slitMaterialMode: s.slitMaterialMode,
        slitMotherWidthMm: s.slitMotherWidthMm,
        slitFixedLengthMm: s.slitFixedLengthMm,
        currentRoll1D,
        slitOrders: s.slitOrders,
        totalRolls1D,
        defectSchedules1D,
        onRunSolve1D: solver.handleRunSolve1D,
        onQuickExportExcel1D: () => exportExcel1D(activeScheme1D)
      }}
      rightProps={{
        rightPaneRef,
        is2D,
        schemes2D: s.schemes2D,
        activeScheme2D,
        activeScheme1D,
        setActiveScheme2D: s.setActiveScheme2D,
        strategyRuns2D: s.strategyRuns2D,
        runningSolve: solver.runningSolve,
        solveElapsedMs: solver.solveElapsedMs,
        confirmingScheme: solver.confirmingScheme,
        validatingLayout: boardEdit.validatingLayout,
        lastConfirmSummary: solver.lastConfirmSummary,
        onContinueAfterConfirm: () => {
          solver.setLastConfirmSummary(null);
          if (is2D) s.clearSchemes2D();
          else s.setSlitSchemes([]);
        },
        onValidateAndRebuildLayout: boardEdit.handleValidateAndRebuildLayout,
        onConfirmSelectedScheme2D: solver.handleConfirmSelectedScheme2D,
        onConfirmSelectedScheme1D: solver.handleConfirmSelectedScheme1D,
        onQuickExportCam: (kind) => exportCam2D(activeScheme2D, s.settings, kind, windowDefects2D),
        onExportMultiMaterialCsv: () => exportMultiMaterialCsv(s.multiMaterialSummary?.rawResponse),
        onGenerateMultiMaterialDrafts: guards.handleGenerateMultiMaterialDrafts,
        generatingMultiMaterialDrafts: draftInbox.generatingBatch,
        activeDraftBlockedReason,
        onStopSolve: solver.handleStopSolve,
        onRunSolve2D: solver.handleRunSolve2D,
        onRunSolve1D: solver.handleRunSolve1D,
        canvasMode: s.canvasMode,
        multiPreferRemnants: s.multiPreferRemnants,
        multiMaxRemnants: s.multiMaxRemnants,
        multiCandidateRollCount: s.multiCandidateRollIds.length,
        multiMaterialSummary: s.multiMaterialSummary,
        scenario2D: s.scenario2D,
        setScenario2D: s.setScenario2D,
        scenario1D: s.scenario1D,
        setScenario1D: s.setScenario1D,
        overviewStats,
        effectiveRollWidthMm,
        activeAlgos,
        slitMaterialMode: s.slitMaterialMode,
        slitProfile: s.slitProfile,
        slitWidthMode: s.slitWidthMode,
        slitMotherWidthMm: s.slitMotherWidthMm,
        slitLeftTrimMm: s.slitLeftTrimMm,
        slitRightTrimMm: s.slitRightTrimMm,
        slitMinWidthMm: s.slitMinWidthMm,
        slitMaxWidthMm: s.slitMaxWidthMm,
        slitWidthStepMm: s.slitWidthStepMm,
        slitOverCap: s.slitOverCap,
        slitMaxKnives: s.slitMaxKnives,
        slitMinBladeSpacingMm: s.slitMinBladeSpacingMm,
        slitKerfMm: s.slitKerfMm,
        slitForbiddenNarrowEdgeMinMm: s.slitForbiddenNarrowEdgeMinMm,
        slitForbiddenNarrowEdgeMaxMm: s.slitForbiddenNarrowEdgeMaxMm,
        currentRoll1D,
        setSlitSpec: s.setSlitSpec,
        settings: s.settings,
        updateStudioSettings: s.updateStudioSettings,
        activeSchemeExecutionSummary: activeSchemeExecution
      }}
      overviewModalProps={{
        open: overviewModalOpen,
        onClose: () => setOverviewModalOpen(false),
        overviewTab,
        setOverviewTab,
        is2D,
        loadedTaskName: s.loadedTaskName,
        slitLoadedTaskName: s.slitLoadedTaskName,
        materialModel2D: s.materialModel2D,
        slitMaterialModel: s.slitMaterialModel,
        overviewStats,
        demandRowsView,
        taskSchemes,
        activeDemands2D: s.activeDemands2D,
        updateDemand2D: s.updateDemand2D,
        removeDemand2D: s.removeDemand2D,
        addBlankDemand2D: s.addBlankDemand2D,
        slitOrders: s.slitOrders,
        updateSlitOrder: s.updateSlitOrder,
        removeSlitOrder: s.removeSlitOrder,
        addSlitOrder: s.addSlitOrder
      }}
    />
  );
};
