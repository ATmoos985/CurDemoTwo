import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudioStore, DemandFamilySummary } from '../store/useStudioStore';
import { StudioSettings } from '../store/studioSettings';
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WorkbenchDraftPayload
} from '../store/workbenchDraft';
import {
  WorkbenchBoardHandle,
  BoardDemandSpec,
  BoardLeftover,
  BoardPlacedPiece,
  BoardDefect,
  BoardCutLine
} from '../components/WorkbenchBoardCanvas';
import { ModalDialog } from '../components/ModalDialog';
import { requestJSON, toast } from '@static/app/js/util.js';
import '../styles/theme-workbench-v2.css';

import {
  DEFAULT_ENABLED_STRATEGIES,
  LEGACY_STRATEGY_ALIAS,
  STRATEGIES_2D
} from './workbench/workbenchTypes';
import {
  computeDefectSchedules1D,
  computeDemandRowsView,
  computeOverviewStats,
  computeSuggestedFeedWindow,
  exportCam2D,
  exportExcel1D
} from './workbench/workbenchUtils';
import { useWorkbenchBoardEdit } from './workbench/useWorkbenchBoardEdit';
import { useWorkbenchSolver } from './workbench/useWorkbenchSolver';
import { WorkbenchTopBar } from './workbench/WorkbenchTopBar';
import { WorkbenchDemandSidebar } from './workbench/WorkbenchDemandSidebar';
import { WorkbenchCenterPanel } from './workbench/WorkbenchCenterPanel';
import { WorkbenchRightPanel } from './workbench/WorkbenchRightPanel';
import { DemandOverviewModal } from './workbench/DemandOverviewModal';

export { SlittingStripBar } from './workbench/SlittingStripBar';

interface PendingConfirmAction {
  title: string;
  description: string;
  action: () => void;
}

export const CuttingWorkbenchPage: React.FC<{
  taskId?: string;
  forceDimension?: '2D' | '1D';
}> = ({ taskId, forceDimension }) => {
  const {
    clusters,
    clusterSelections,
    syncTemplatesFromServer,
    setClusterCount,
    loadClusterInto2D,
    loadClusterInto1D,
    loadDemandFamilyIntoWorkbench,
    syncDemandFamilyProgress,
    syncMergedDemandFamiliesProgress,
    activeDimension,
    setActiveDimension,
    scenario2D,
    setScenario2D,
    multiWidthsText2D,
    setMultiWidthsText2D,
    scenario1D,
    setScenario1D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    selectedRemnantId,
    materialModel2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef,
    activeDemands2D,
    selectedStrategies2D,
    strategyRuns2D,
    schemes2D,
    activeSchemeId2D,
    setCanvasSpec,
    restoreWorkbenchDraft,
    updateDemand2D,
    removeDemand2D,
    addBlankDemand2D,
    setStrategyRuns2D,
    addSchemes2D,
    removeScheme2D,
    clearSchemes2D,
    setActiveScheme2D,
    markSchemeDispatched,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitMaterialModel,
    slitLoadedTaskId,
    slitLoadedTaskName,
    slitOrders,
    slitSchemes,
    activeSlitSchemeId,
    setSlitSpec,
    updateSlitOrder,
    addSlitOrder,
    removeSlitOrder,
    setSlitSchemes,
    setActiveSlitScheme,
    markSlitSchemeDispatched,
    settings,
    updateStudioSettings
  } = useStudioStore();

  const extSettings = settings as StudioSettings & {
    showWorkflowGuide?: boolean;
    enabledStrategies2D?: string[];
  };
  const showWorkflowGuide = Boolean(extSettings.showWorkflowGuide);

  const activeAlgos = useMemo(() => {
    const rawList =
      Array.isArray(extSettings.enabledStrategies2D) && extSettings.enabledStrategies2D.length > 0
        ? extSettings.enabledStrategies2D
        : Array.isArray(selectedStrategies2D) && selectedStrategies2D.length > 0
        ? selectedStrategies2D
        : DEFAULT_ENABLED_STRATEGIES;
    const normalized = new Set(rawList.map((id) => LEGACY_STRATEGY_ALIAS[id] || id));
    const matched = STRATEGIES_2D.filter((s) => normalized.has(s.id));
    return matched.length > 0 ? matched : [STRATEGIES_2D[4]];
  }, [extSettings.enabledStrategies2D, selectedStrategies2D]);

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [poolFamilies, setPoolFamilies] = useState<DemandFamilySummary[]>([]);
  const [taskSchemes, setTaskSchemes] = useState<any[]>([]);
  const [demandSourceTab, setDemandSourceTab] = useState<'POOL' | 'TEMPLATE'>('TEMPLATE');
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');
  const [overviewModalOpen, setOverviewModalOpen] = useState(false);
  const [overviewTab, setOverviewTab] = useState<'progress' | 'edit'>('progress');

  const [showPath, setShowPath] = useState<boolean>(settings.showPath);
  const [showDimensions, setShowDimensions] = useState<boolean>(settings.showDimensions);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoveredDemandKey, setHoveredDemandKey] = useState<string | null>(null);
  const [pinnedDemandKey, setPinnedDemandKey] = useState<string | null>(null);
  const [selectedPieceIndex, setSelectedPieceIndex] = useState<number | null>(null);
  const [selectedLeftoverId, setSelectedLeftoverId] = useState<string | null>(null);

  // 左右侧栏折叠状态（1024px 工业平板可一键折叠腾出最大画布视野）
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false);

  // 按 taskId 隔离的本机草稿恢复提示状态
  const [recoverableDraft, setRecoverableDraft] = useState<WorkbenchDraftPayload | null>(null);
  const draftHydratedKeyRef = useRef<string>('');
  const allowAutoSaveRef = useRef<boolean>(false);

  // 破坏性切换二次确认弹窗（切料 / 重载需求族 / 重载模板）
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);

  useEffect(() => {
    setShowPath(settings.showPath);
    setShowDimensions(settings.showDimensions);
  }, [settings.showPath, settings.showDimensions]);

  const leftPaneRef = useRef<HTMLElement | null>(null);
  const rightPaneRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const boardRef = useRef<WorkbenchBoardHandle | null>(null);

  const reloadReferenceData = async (explicitTaskId?: string | null) => {
    const curTaskId =
      explicitTaskId !== undefined
        ? explicitTaskId
        : activeDimension === '2D'
        ? loadedTaskId
        : slitLoadedTaskId;
    const [rList, remList, famList, schList] = await Promise.all([
      requestJSON('/api/rolls').catch(() => []),
      requestJSON('/api/remnants').catch(() => []),
      requestJSON('/api/v2/demand-pool').catch(() => []),
      curTaskId
        ? requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => [])
        : Promise.resolve([])
    ]);
    setRolls(Array.isArray(rList) ? rList : []);
    setRemnants(Array.isArray(remList) ? remList : []);
    const fams: DemandFamilySummary[] = Array.isArray(famList) ? famList : [];
    setPoolFamilies(fams);
    setTaskSchemes(Array.isArray(schList) ? schList : []);
    if (curTaskId) {
      const matched = fams.find((f) => f.id === curTaskId);
      if (matched) {
        syncDemandFamilyProgress(matched);
      }
      setDemandSourceTab('POOL');
    }
    return fams;
  };

  useEffect(() => {
    if (forceDimension) {
      setActiveDimension(forceDimension);
    }
  }, [forceDimension]);

  useEffect(() => {
    syncTemplatesFromServer();
    reloadReferenceData();
  }, []);

  // Load Demand Family if navigated via #/workbench/:taskId
  useEffect(() => {
    if (!taskId) return;
    requestJSON('/api/v2/demand-pool/' + encodeURIComponent(taskId))
      .then((fam: DemandFamilySummary) => {
        if (fam?.id) {
          loadDemandFamilyIntoWorkbench(fam);
          setDemandSourceTab('POOL');
        }
      })
      .catch((e) => toast('加载需求族失败：' + e.message, true));
  }, [taskId]);

  useEffect(() => {
    const curTaskId = activeDimension === '2D' ? loadedTaskId : slitLoadedTaskId;
    if (!curTaskId) {
      setTaskSchemes([]);
      return;
    }
    requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`)
      .then((list) => setTaskSchemes(Array.isArray(list) ? list : []))
      .catch(() => setTaskSchemes([]));
  }, [activeDimension, loadedTaskId, slitLoadedTaskId]);

  const is2D = activeDimension === '2D';
  const activeDraftTaskKey = (is2D ? loadedTaskId : slitLoadedTaskId) || taskId || 'scratch';

  // 进入工作台或切换 taskId 时检测该 taskId 隔离的本机草稿
  useEffect(() => {
    if (draftHydratedKeyRef.current === activeDraftTaskKey) return;
    draftHydratedKeyRef.current = activeDraftTaskKey;
    allowAutoSaveRef.current = false;
    const found = loadWorkbenchDraft(activeDraftTaskKey);
    if (
      found &&
      ((found.unconfirmedSchemes2D && found.unconfirmedSchemes2D.length > 0) ||
        (found.activeDemands2D && found.activeDemands2D.length > 0) ||
        (found.slitOrders && found.slitOrders.length > 0))
    ) {
      setRecoverableDraft(found);
    } else {
      setRecoverableDraft(null);
      allowAutoSaveRef.current = true;
    }
  }, [activeDraftTaskKey]);

  // 防抖自动保存当前未落库状态至按 taskId 隔离的 localStorage 草稿
  useEffect(() => {
    if (!allowAutoSaveRef.current) return;
    const timer = window.setTimeout(() => {
      saveWorkbenchDraft(activeDraftTaskKey, {
        activeDimension,
        scenario2D,
        multiWidthsText2D,
        canvasMode,
        canvasWidthMm,
        canvasLengthMm,
        windowStartY2D,
        pieceGapMm,
        trimStartMm,
        selectedRollId,
        selectedRemnantId,
        materialModel2D,
        activeDemands2D,
        unconfirmedSchemes2D: schemes2D.filter((s) => !s.confirmedSchemeId),
        activeSchemeId2D,
        scenario1D,
        slitMaterialMode,
        slitWidthMode,
        slitProfile,
        slitMotherWidthMm,
        slitLeftTrimMm,
        slitRightTrimMm,
        slitMinWidthMm,
        slitMaxWidthMm,
        slitWidthStepMm,
        slitOverCap,
        slitFixedLengthMm,
        slitAvoidDefects,
        slitRollId,
        slitMaterialModel,
        slitOrders
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    activeDraftTaskKey,
    activeDimension,
    scenario2D,
    multiWidthsText2D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    selectedRemnantId,
    materialModel2D,
    activeDemands2D,
    schemes2D,
    activeSchemeId2D,
    scenario1D,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitMaterialModel,
    slitOrders
  ]);

  const passedRolls = useMemo(
    () => rolls.filter((r) => r.inspectionStatus === 'PASSED'),
    [rolls]
  );
  const availableRemnants = useMemo(
    () => remnants.filter((rm) => rm.status === 'AVAILABLE'),
    [remnants]
  );

  const currentRoll2D = useMemo(
    () => passedRolls.find((r) => r.rollId === selectedRollId) || passedRolls[0] || null,
    [passedRolls, selectedRollId]
  );
  const currentRemnant2D = useMemo(
    () => availableRemnants.find((rm) => rm.id === selectedRemnantId) || availableRemnants[0] || null,
    [availableRemnants, selectedRemnantId]
  );
  const currentRoll1D = useMemo(
    () => passedRolls.find((r) => r.rollId === slitRollId) || passedRolls[0] || null,
    [passedRolls, slitRollId]
  );

  const activeScheme2D = useMemo(
    () => schemes2D.find((s) => s.id === activeSchemeId2D) || null,
    [schemes2D, activeSchemeId2D]
  );
  const activeScheme1D = useMemo(
    () => slitSchemes.find((s) => s.id === activeSlitSchemeId) || slitSchemes[0] || null,
    [slitSchemes, activeSlitSchemeId]
  );

  useEffect(() => {
    setSelectedPieceIndex(null);
    setSelectedLeftoverId(null);
  }, [activeSchemeId2D]);

  // 实卷连续开卷工位起切点（支持用户调节，受 >= usedLength 且 < totalLength - 100 约束）
  const effectiveWindowStartY = useMemo(() => {
    if (canvasMode !== 'STOCK_ROLL' || !currentRoll2D) return 0;
    const used = Math.max(0, Number(currentRoll2D.usedLength) || 0);
    const total = Math.max(used, Number(currentRoll2D.totalLength) || used);
    if (windowStartY2D == null || !Number.isFinite(windowStartY2D)) return used;
    return Math.max(used, Math.min(Math.max(used, total - 100), windowStartY2D));
  }, [canvasMode, currentRoll2D, windowStartY2D]);

  const effectiveRollWidthMm = useMemo(() => {
    if (activeScheme2D?.widthMm) return activeScheme2D.widthMm;
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return currentRoll2D.width;
    if (canvasMode === 'REMNANT' && currentRemnant2D) return currentRemnant2D.width;
    return canvasWidthMm;
  }, [activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D, canvasWidthMm]);

  const effectiveRollLengthMm = useMemo(() => {
    const baseLen =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
    if (!activeScheme2D) return baseLen;
    return Math.max(
      baseLen,
      Math.ceil(activeScheme2D.occupiedLengthMm || 0),
      Math.ceil(activeScheme2D.canvasLengthMm || 0)
    );
  }, [activeScheme2D, canvasMode, currentRemnant2D, canvasLengthMm]);

  const effectiveRollTitle = useMemo(() => {
    if (activeScheme2D) {
      if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
        return `实卷 ${activeScheme2D.rollId}`;
      }
      if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
        return `料头 ${activeScheme2D.remnantId}`;
      }
      return '虚拟新母卷';
    }
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return `实卷 ${currentRoll2D.rollId}`;
    if (canvasMode === 'REMNANT' && currentRemnant2D) return `料头 ${currentRemnant2D.id}`;
    return '虚拟新母卷';
  }, [activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D]);

  const windowDefects2D: BoardDefect[] = useMemo(() => {
    const startY =
      activeScheme2D?.canvasMode === 'STOCK_ROLL' && activeScheme2D.windowStartY != null
        ? activeScheme2D.windowStartY
        : effectiveWindowStartY;
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
      return (currentRoll2D.defects || [])
        .filter((d: any) => d.y < startY + effectiveRollLengthMm && d.y + d.h > startY)
        .map((d: any, idx: number) => ({
          id: d.id ?? idx + 1,
          x: Number(d.x) || 0,
          y: Math.max(0, (Number(d.y) || 0) - startY),
          w: Number(d.w) || 0,
          h: Number(d.h) || 0,
          margin: d.margin ?? settings.defectMarginMm,
          label: d.typeName || d.defectType || '疵点'
        }));
    }
    if (canvasMode === 'REMNANT' && currentRemnant2D) {
      return (currentRemnant2D.defects || []).map((d: any, idx: number) => ({
        id: d.id ?? idx + 1,
        x: Number(d.x) || 0,
        y: Number(d.y) || 0,
        w: Number(d.w) || 0,
        h: Number(d.h) || 0,
        margin: d.margin ?? settings.defectMarginMm,
        label: d.typeName || d.defectType || '疵点'
      }));
    }
    return [];
  }, [
    activeScheme2D?.canvasMode,
    activeScheme2D?.windowStartY,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    effectiveWindowStartY,
    effectiveRollLengthMm,
    settings.defectMarginMm
  ]);

  const boardPlacedPieces: BoardPlacedPiece[] = useMemo(() => {
    if (!activeScheme2D?.result?.layout) return [];
    const mainList: any[] = activeScheme2D.result.layout.placements || [];
    const gapList: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
    const combined: BoardPlacedPiece[] = [];
    mainList.forEach((p, idx) => {
      combined.push({
        id: p.id ?? `m-${idx + 1}`,
        index: idx,
        demandId: p.demandId,
        demandKey: p.demandId != null ? String(p.demandId) : `p-${idx}`,
        name: p.name || `#${p.demandId ?? idx + 1}`,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        width: Number(p.shape?.width ?? p.w) || 0,
        height: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: false,
        shape: p.shape
      });
    });
    gapList.forEach((p, idx) => {
      const globalIdx = mainList.length + idx;
      combined.push({
        id: p.id ?? `g-${idx + 1}`,
        index: globalIdx,
        demandId: p.demandId,
        demandKey: p.demandId != null ? String(p.demandId) : `g-${idx}`,
        name: p.name || `#${p.demandId ?? idx + 1}`,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        width: Number(p.shape?.width ?? p.w) || 0,
        height: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: p.rotationDegrees || 0,
        gapFill: true,
        shape: p.shape
      });
    });
    return combined;
  }, [activeScheme2D]);

  const boardLeftovers: BoardLeftover[] = useMemo(() => {
    const raw = activeScheme2D?.result?.layout?.leftovers || [];
    return raw
      .map((rm: any, idx: number) => ({
        id: String(rm.id ?? idx + 1),
        x: Number(rm.x) || 0,
        y: Number(rm.y) || 0,
        width: Number(rm.shape?.width ?? rm.w) || 0,
        height: Number(rm.shape?.height ?? rm.l) || 0,
        hasDefect: Boolean(rm.hasDefect),
        shape: rm.shape
      }))
      .filter((rm: BoardLeftover) => rm.width > 0 && rm.height > 0);
  }, [activeScheme2D]);

  const boardCuts: BoardCutLine[] = useMemo(() => {
    const raw = activeScheme2D?.result?.layout?.cuts || [];
    return raw.map((c: any, idx: number) => ({
      sequence: c.sequence ?? idx + 1,
      kind: c.kind,
      startX: Number(c.startX) || 0,
      startY: Number(c.startY) || 0,
      endX: Number(c.endX) || 0,
      endY: Number(c.endY) || 0
    }));
  }, [activeScheme2D]);

  const boardStagingDemands: BoardDemandSpec[] = useMemo(() => {
    const placedByDemand = new Map<number, number>();
    if (activeScheme2D && !activeScheme2D.confirmedSchemeId) {
      for (const p of activeScheme2D.result?.layout?.placements || []) {
        if (p.demandId != null) {
          const did = Number(p.demandId);
          placedByDemand.set(did, (placedByDemand.get(did) || 0) + 1);
        }
      }
    }
    return activeDemands2D.map((d) => {
      const openQty = Math.max(0, Number(d.quantity) || 0);
      const placed = placedByDemand.get(d.id) || 0;
      return {
        key: String(d.id),
        demandId: d.id,
        name: d.name,
        width: d.width,
        length: d.length,
        remainingQty: Math.max(0, openQty - placed),
        totalQty: openQty,
        allowRotation: d.allowRotation,
        allowHalfTurn: d.allowHalfTurn,
        shape: d.shape
      };
    });
  }, [activeDemands2D, activeScheme2D]);

  const {
    runningSolve,
    solveElapsedMs,
    confirmingScheme,
    lastConfirmSummary,
    setLastConfirmSummary,
    handleRunSolve2D,
    handleRunSolve1D,
    handleStopSolve,
    handleConfirmSelectedScheme2D,
    handleConfirmSelectedScheme1D
  } = useWorkbenchSolver({
    activeDemands2D,
    activeAlgos,
    canvasMode,
    scenario2D,
    multiWidthsText2D,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D: effectiveWindowStartY,
    pieceGapMm,
    trimStartMm,
    materialModel2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef,
    currentRoll2D,
    currentRemnant2D,
    activeScheme2D,
    setStrategyRuns2D,
    addSchemes2D,
    markSchemeDispatched,
    slitOrders,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitMaterialModel,
    slitLoadedTaskId,
    slitLoadedTaskName,
    scenario1D,
    currentRoll1D,
    activeScheme1D,
    setSlitSchemes,
    markSlitSchemeDispatched,
    settings,
    reloadReferenceData,
    syncDemandFamilyProgress,
    syncMergedDemandFamiliesProgress
  });

  // 确认方案落库后清除当前任务草稿，防止后续误提示恢复旧草稿
  useEffect(() => {
    if (lastConfirmSummary?.schemeId) {
      clearWorkbenchDraft(activeDraftTaskKey);
      setRecoverableDraft(null);
    }
  }, [lastConfirmSummary?.schemeId, activeDraftTaskKey]);

  const {
    validatingLayout,
    canUndo,
    canRedo,
    canRestoreOriginal,
    handleDropStagingPiece,
    handleMovePlacedPiece,
    handleNudgePlacedPiece,
    handleRotatePlacedPiece,
    handleRemovePlacedPiece,
    handleDiscardLeftover,
    handleUndoBoardEdit,
    handleRedoBoardEdit,
    handleRestoreOriginalPreview,
    handleValidateAndRebuildLayout
  } = useWorkbenchBoardEdit({
    activeScheme2D,
    activeDemands2D,
    canvasMode,
    scenario2D,
    currentRoll2D,
    currentRemnant2D,
    materialModel2D,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    effectiveWindowStartY,
    pieceGapMm,
    trimStartMm,
    windowDefects2D,
    settings,
    removeScheme2D,
    setSelectedPieceIndex,
    setSelectedLeftoverId,
    setLastConfirmSummary
  });

  // 存在未落库候选方案或手排脏修改时，切换母卷来源或重载需求族/模板必须二次确认
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
      defaultDefectMarginMm: settings.defectMarginMm
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

  const filteredClusters = clusters.filter((c) => c.dimension === activeDimension);
  const quickCluster =
    filteredClusters.find((c) => c.id === activeClusterQuickId) || filteredClusters[0];
  const quickCounts =
    (quickCluster && clusterSelections[quickCluster.id]) ||
    quickCluster?.defaultSizeCounts ||
    {};

  const filteredPoolFamilies = poolFamilies.filter((f) =>
    is2D ? f.dimension !== 'SLITTING_1D' : f.dimension === 'SLITTING_1D'
  );

  const totalRolls1D = slitOrders.reduce((s, o) => s + (Number(o.quantity) || 0), 0);

  const demandRowsView = useMemo(
    () =>
      computeDemandRowsView({
        is2D,
        activeDemands2D,
        activeScheme2D,
        slitOrders,
        activeScheme1D,
        slitFixedLengthMm
      }),
    [is2D, activeDemands2D, activeScheme2D, slitOrders, activeScheme1D, slitFixedLengthMm]
  );

  const overviewStats = useMemo(
    () => computeOverviewStats(demandRowsView, is2D),
    [demandRowsView, is2D]
  );

  const hasCandidateResult = is2D
    ? Boolean(activeScheme2D)
    : Boolean(activeScheme1D && activeScheme1D.state === 'SUCCEEDED');
  const currentStage: 1 | 2 | 3 = runningSolve ? 2 : hasCandidateResult ? 3 : 1;

  const bestUtil2D = useMemo(
    () => (schemes2D.length ? Math.max(...schemes2D.map((x) => x.utilizationPct)) : 0),
    [schemes2D]
  );
  const baseline1D = useMemo(
    () => slitSchemes.find((s) => s.strategyId === 'BASELINE') || null,
    [slitSchemes]
  );

  const defectSchedules1D = useMemo(
    () =>
      computeDefectSchedules1D({
        slitAvoidDefects,
        slitMaterialMode,
        currentRoll1D,
        activeScheme1D,
        slitOrders,
        slitFixedLengthMm,
        slitLeftTrimMm
      }),
    [
      slitAvoidDefects,
      slitMaterialMode,
      currentRoll1D,
      activeScheme1D,
      slitOrders,
      slitFixedLengthMm,
      slitLeftTrimMm
    ]
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
    <div className="react-page studio-2d-page wb-v2">
      <WorkbenchTopBar
        is2D={is2D}
        setActiveDimension={setActiveDimension}
        showWorkflowGuide={showWorkflowGuide}
        currentStage={currentStage}
        leftPaneRef={leftPaneRef}
        rightPaneRef={rightPaneRef}
        stripRef={stripRef}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        onToggleLeftPane={() => setLeftCollapsed((v) => !v)}
        onToggleRightPane={() => setRightCollapsed((v) => !v)}
        canvasMode={canvasMode}
        scenario2D={scenario2D}
        multiWidthsText2D={multiWidthsText2D}
        setMultiWidthsText2D={setMultiWidthsText2D}
        canvasWidthMm={canvasWidthMm}
        canvasLengthMm={canvasLengthMm}
        effectiveWindowStartY={effectiveWindowStartY}
        pieceGapMm={pieceGapMm}
        trimStartMm={trimStartMm}
        setCanvasSpec={setCanvasSpec}
        onRequestChangeMaterial2D={handleRequestChangeMaterial2D}
        onSuggestFeedWindow={handleSuggestFeedWindow}
        passedRolls={passedRolls}
        availableRemnants={availableRemnants}
        currentRoll2D={currentRoll2D}
        currentRemnant2D={currentRemnant2D}
        slitMaterialMode={slitMaterialMode}
        slitMotherWidthMm={slitMotherWidthMm}
        slitFixedLengthMm={slitFixedLengthMm}
        slitLeftTrimMm={slitLeftTrimMm}
        slitRightTrimMm={slitRightTrimMm}
        slitWidthMode={slitWidthMode}
        slitMinWidthMm={slitMinWidthMm}
        slitMaxWidthMm={slitMaxWidthMm}
        currentRoll1D={currentRoll1D}
        setSlitSpec={setSlitSpec}
        onRequestChangeMaterial1D={handleRequestChangeMaterial1D}
      />

      {/* 按 taskId 隔离的本机草稿自动恢复提示条 */}
      {recoverableDraft && (
        <div className="wb-draft-banner" role="status">
          <span>
            检测到本机未落库工作台草稿（保存于{' '}
            <b className="num">
              {new Date(recoverableDraft.savedAt).toLocaleString('zh-CN', { hour12: false })}
            </b>
            ，含 {recoverableDraft.activeDemands2D?.length || 0} 条二维需求 /{' '}
            {recoverableDraft.unconfirmedSchemes2D?.length || 0} 套未确认手调方案）
          </span>
          <span className="sp" />
          <button
            type="button"
            className="btn sm pri"
            onClick={() => {
              restoreWorkbenchDraft(recoverableDraft);
              setRecoverableDraft(null);
              allowAutoSaveRef.current = true;
              toast('已恢复本机工作台草稿');
            }}
          >
            恢复草稿
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              clearWorkbenchDraft(activeDraftTaskKey);
              setRecoverableDraft(null);
              allowAutoSaveRef.current = true;
            }}
          >
            忽略并清除
          </button>
        </div>
      )}

      <div className={splitCls}>
        {!leftCollapsed && (
          <WorkbenchDemandSidebar
            leftPaneRef={leftPaneRef}
            is2D={is2D}
            demandSourceTab={demandSourceTab}
            setDemandSourceTab={setDemandSourceTab}
            filteredPoolFamilies={filteredPoolFamilies}
            filteredClusters={filteredClusters}
            loadedTaskId={loadedTaskId}
            loadedTaskName={loadedTaskName}
            slitLoadedTaskId={slitLoadedTaskId}
            slitLoadedTaskName={slitLoadedTaskName}
            loadDemandFamilyIntoWorkbench={handleGuardedLoadFamily}
            onClearConfirmSummary={() => setLastConfirmSummary(null)}
            quickCluster={quickCluster}
            quickCounts={quickCounts}
            setActiveClusterQuickId={setActiveClusterQuickId}
            setClusterCount={setClusterCount}
            loadClusterInto2D={handleGuardedLoadCluster2D}
            loadClusterInto1D={handleGuardedLoadCluster1D}
            overviewStats={overviewStats}
            demandRowsView={demandRowsView}
            activeHighlightKey={activeHighlightKey}
            setHoveredDemandKey={setHoveredDemandKey}
            setPinnedDemandKey={setPinnedDemandKey}
            onOpenOverview={(tab) => {
              setOverviewTab(tab);
              setOverviewModalOpen(true);
            }}
            onAddBlankDemand={() => {
              if (is2D) addBlankDemand2D();
              else addSlitOrder();
              setOverviewTab('edit');
              setOverviewModalOpen(true);
            }}
          />
        )}

        <WorkbenchCenterPanel
          is2D={is2D}
          stripRef={stripRef}
          boardRef={boardRef}
          vertical={settings.vertical}
          onToggleVertical={() =>
            updateStudioSettings({ ...settings, vertical: !settings.vertical })
          }
          startCorner={settings.startCorner}
          showDimensions={showDimensions}
          setShowDimensions={setShowDimensions}
          showPath={showPath}
          setShowPath={setShowPath}
          selectedPieceIndex={selectedPieceIndex}
          setSelectedPieceIndex={setSelectedPieceIndex}
          selectedLeftoverId={selectedLeftoverId}
          setSelectedLeftoverId={setSelectedLeftoverId}
          cursor={cursor}
          setCursor={setCursor}
          activeScheme2D={activeScheme2D}
          schemes2D={schemes2D}
          bestUtil2D={bestUtil2D}
          setActiveScheme2D={setActiveScheme2D}
          removeScheme2D={removeScheme2D}
          clearSchemes2D={clearSchemes2D}
          effectiveRollTitle={effectiveRollTitle}
          effectiveRollWidthMm={effectiveRollWidthMm}
          effectiveRollLengthMm={effectiveRollLengthMm}
          trimStartMm={trimStartMm}
          pieceGapMm={pieceGapMm}
          windowDefects2D={windowDefects2D}
          boardStagingDemands={boardStagingDemands}
          boardPlacedPieces={boardPlacedPieces}
          boardLeftovers={boardLeftovers}
          boardCuts={boardCuts}
          activeHighlightKey={activeHighlightKey}
          setHoveredDemandKey={setHoveredDemandKey}
          canUndo={canUndo}
          canRedo={canRedo}
          canRestoreOriginal={canRestoreOriginal}
          onUndo={handleUndoBoardEdit}
          onRedo={handleRedoBoardEdit}
          onRestoreOriginalPreview={handleRestoreOriginalPreview}
          onDropStagingPiece={handleDropStagingPiece}
          onMovePlacedPiece={handleMovePlacedPiece}
          onNudgePlacedPiece={handleNudgePlacedPiece}
          onRotatePlacedPiece={handleRotatePlacedPiece}
          onRemovePlacedPiece={handleRemovePlacedPiece}
          onDiscardLeftover={handleDiscardLeftover}
          validatingLayout={validatingLayout}
          onValidateAndRebuildLayout={handleValidateAndRebuildLayout}
          slitSchemes={slitSchemes}
          activeScheme1D={activeScheme1D}
          setActiveSlitScheme={setActiveSlitScheme}
          baselineCars1D={baseline1D?.totalCars || 0}
          solveElapsedMs={solveElapsedMs}
          slitMaterialMode={slitMaterialMode}
          slitMotherWidthMm={slitMotherWidthMm}
          slitFixedLengthMm={slitFixedLengthMm}
          currentRoll1D={currentRoll1D}
          slitOrders={slitOrders}
          totalRolls1D={totalRolls1D}
          defectSchedules1D={defectSchedules1D}
          onRunSolve1D={handleRunSolve1D}
          onQuickExportExcel1D={() => exportExcel1D(activeScheme1D)}
        />

        {!rightCollapsed && (
          <WorkbenchRightPanel
            rightPaneRef={rightPaneRef}
            is2D={is2D}
            schemes2D={schemes2D}
            activeScheme2D={activeScheme2D}
            activeScheme1D={activeScheme1D}
            strategyRuns2D={strategyRuns2D}
            runningSolve={runningSolve}
            solveElapsedMs={solveElapsedMs}
            confirmingScheme={confirmingScheme}
            validatingLayout={validatingLayout}
            lastConfirmSummary={lastConfirmSummary}
            onContinueAfterConfirm={() => {
              setLastConfirmSummary(null);
              if (is2D) clearSchemes2D();
              else setSlitSchemes([]);
            }}
            onValidateAndRebuildLayout={handleValidateAndRebuildLayout}
            onConfirmSelectedScheme2D={handleConfirmSelectedScheme2D}
            onConfirmSelectedScheme1D={handleConfirmSelectedScheme1D}
            onQuickExportCam={(kind) => exportCam2D(activeScheme2D, settings, kind, windowDefects2D)}
            onStopSolve={handleStopSolve}
            onRunSolve2D={handleRunSolve2D}
            onRunSolve1D={handleRunSolve1D}
            canvasMode={canvasMode}
            scenario2D={scenario2D}
            setScenario2D={setScenario2D}
            scenario1D={scenario1D}
            setScenario1D={setScenario1D}
            overviewStats={overviewStats}
            effectiveRollWidthMm={effectiveRollWidthMm}
            activeAlgos={activeAlgos}
            slitMaterialMode={slitMaterialMode}
            slitProfile={slitProfile}
            slitWidthMode={slitWidthMode}
            slitMotherWidthMm={slitMotherWidthMm}
            slitLeftTrimMm={slitLeftTrimMm}
            slitRightTrimMm={slitRightTrimMm}
            slitMinWidthMm={slitMinWidthMm}
            slitMaxWidthMm={slitMaxWidthMm}
            slitWidthStepMm={slitWidthStepMm}
            slitOverCap={slitOverCap}
            currentRoll1D={currentRoll1D}
            setSlitSpec={setSlitSpec}
            settings={settings}
            updateStudioSettings={updateStudioSettings}
          />
        )}
      </div>

      {/* 切料 / 重载需求二次防呆确认弹窗 */}
      <ModalDialog
        open={Boolean(pendingConfirm)}
        title={pendingConfirm?.title || '确认切换操作'}
        onClose={() => setPendingConfirm(null)}
        maxWidth={440}
      >
        <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.6 }}>
          {pendingConfirm?.description}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setPendingConfirm(null)}>
            取消
          </button>
          <button
            type="button"
            className="btn pri"
            onClick={() => {
              const fn = pendingConfirm?.action;
              setPendingConfirm(null);
              fn?.();
            }}
          >
            确认切换
          </button>
        </div>
      </ModalDialog>

      <DemandOverviewModal
        open={overviewModalOpen}
        onClose={() => setOverviewModalOpen(false)}
        overviewTab={overviewTab}
        setOverviewTab={setOverviewTab}
        is2D={is2D}
        loadedTaskName={loadedTaskName}
        slitLoadedTaskName={slitLoadedTaskName}
        materialModel2D={materialModel2D}
        slitMaterialModel={slitMaterialModel}
        overviewStats={overviewStats}
        demandRowsView={demandRowsView}
        taskSchemes={taskSchemes}
        activeDemands2D={activeDemands2D}
        updateDemand2D={updateDemand2D}
        removeDemand2D={removeDemand2D}
        addBlankDemand2D={addBlankDemand2D}
        slitOrders={slitOrders}
        updateSlitOrder={updateSlitOrder}
        removeSlitOrder={removeSlitOrder}
        addSlitOrder={addSlitOrder}
      />
    </div>
  );
};
