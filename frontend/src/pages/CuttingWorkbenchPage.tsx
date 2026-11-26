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
import { requestJSON, toast } from '../lib/core/util.js';
import {
  DISPOSITIONS,
  effectivePieceResults,
  receiptSummary,
  reviewablePieces
} from '../lib/model/quality.js';
import {
  normalizeReconciliationReportItem,
  readDispositionFields,
  type NormalizedReconciliationReportRow
} from './results/reconciliationUtils';
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
import { projectWindowDefectsForBoard } from './workbench/defectWindowUtils';
import { useWorkbenchBoardEdit } from './workbench/useWorkbenchBoardEdit';
import { useWorkbenchSolver } from './workbench/useWorkbenchSolver';
import { WorkbenchTopBar } from './workbench/WorkbenchTopBar';
import { WorkbenchDemandSidebar } from './workbench/WorkbenchDemandSidebar';
import { WorkbenchCenterPanel } from './workbench/WorkbenchCenterPanel';
import { WorkbenchRightPanel } from './workbench/WorkbenchRightPanel';
import { DemandOverviewModal } from './workbench/DemandOverviewModal';

export { SlittingStripBar } from './workbench/SlittingStripBar';

export interface ReinspectedPieceTag {
  pieceId: number;
  disposition: string;
  dispositionLabel: string;
  reason: string;
}

export interface SchemeExecutionSummary {
  schemeId: string;
  reportCount: number;
  netQualifiedCount: number;
  reinspectedCount: number;
  rejectedTotalCount: number;
  disposedPieces: Map<number, ReinspectedPieceTag>;
}

export interface TaskExecutionProjection {
  taskId: string;
  reportCount: number;
  netQualifiedCount: number;
  rejectedTotalCount: number;
  reinspectionDisposedTotal: number;
  reinspectionScrapCount: number;
  reinspectionRemnantCount: number;
  reviewableCount: number;
  openRemainingCount: number;
  bySchemeId: Map<string, SchemeExecutionSummary>;
}

/**
 * 复用质检页与履约账本同一套 receiptSummary / effectivePieceResults 口径，
 * 计算当前需求池任务的实切净合格数、复检判废扣回数、待补排余量与各已确认方案的逐片判废映射。
 */
export function computeTaskExecutionProjection(params: {
  taskId: string | null;
  rawReports: any[];
  taskSchemes?: any[];
  openRemainingCount: number;
}): TaskExecutionProjection | null {
  const { taskId, rawReports, taskSchemes = [], openRemainingCount } = params;
  if (!taskId || !Array.isArray(rawReports) || rawReports.length === 0) return null;

  const planIdToSchemeId = new Map<string, string>();
  for (const sc of taskSchemes || []) {
    const sid = sc?.id ? String(sc.id) : '';
    if (!sid) continue;
    const linked: any[] = Array.isArray(sc.linkedPlanIds) ? sc.linkedPlanIds : [];
    for (const pid of linked) {
      if (pid != null && String(pid).trim()) {
        planIdToSchemeId.set(String(pid), sid);
      }
    }
  }

  let reportCount = 0;
  let netQualifiedCount = 0;
  let rejectedTotalCount = 0;
  let reinspectionDisposedTotal = 0;
  let reinspectionScrapCount = 0;
  let reinspectionRemnantCount = 0;
  let reviewableCount = 0;
  const bySchemeId = new Map<string, SchemeExecutionSummary>();

  for (const rawItem of rawReports) {
    const row: NormalizedReconciliationReportRow | null =
      normalizeReconciliationReportItem(rawItem);
    if (!row) continue;
    if (String(row.report.status || '').toUpperCase() === 'REVERSED') continue;

    reportCount += 1;
    const summary = receiptSummary(row.report, effectivePieceResults);
    netQualifiedCount += Number(summary.qualified) || 0;
    rejectedTotalCount += Number(summary.rejected) || 0;
    reinspectionDisposedTotal += Number(summary.dispositions) || 0;
    reviewableCount += reviewablePieces(row.report).length;

    const resolvedSchemeId = String(
      rawItem?.schemeId ||
        row.report.schemeId ||
        planIdToSchemeId.get(row.reportId) ||
        ''
    ).trim();

    let schemeBucket: SchemeExecutionSummary | null = null;
    if (resolvedSchemeId) {
      schemeBucket = bySchemeId.get(resolvedSchemeId) || {
        schemeId: resolvedSchemeId,
        reportCount: 0,
        netQualifiedCount: 0,
        reinspectedCount: 0,
        rejectedTotalCount: 0,
        disposedPieces: new Map<number, ReinspectedPieceTag>()
      };
      schemeBucket.reportCount += 1;
      schemeBucket.netQualifiedCount += Number(summary.qualified) || 0;
      schemeBucket.reinspectedCount += Number(summary.dispositions) || 0;
      schemeBucket.rejectedTotalCount += Number(summary.rejected) || 0;
      bySchemeId.set(resolvedSchemeId, schemeBucket);
    }

    row.dispositions.forEach((disp: any, idx: number) => {
      const info = readDispositionFields(disp, idx);
      if (info.revoked) return;
      if (info.disposition === 'REMNANT') {
        reinspectionRemnantCount += 1;
      } else {
        reinspectionScrapCount += 1;
      }
      if (schemeBucket && info.pieceId != null && Number.isFinite(Number(info.pieceId))) {
        const pid = Number(info.pieceId);
        const dispLabel =
          (DISPOSITIONS as Record<string, string>)[info.disposition] ||
          info.disposition ||
          '判废';
        schemeBucket.disposedPieces.set(pid, {
          pieceId: pid,
          disposition: info.disposition,
          dispositionLabel: dispLabel,
          reason: info.reason
        });
      }
    });
  }

  if (reportCount === 0) return null;

  return {
    taskId,
    reportCount,
    netQualifiedCount,
    rejectedTotalCount,
    reinspectionDisposedTotal,
    reinspectionScrapCount,
    reinspectionRemnantCount,
    reviewableCount,
    openRemainingCount: Math.max(0, Math.round(Number(openRemainingCount) || 0)),
    bySchemeId
  };
}

/**
 * 为已确认且存在复检判废记录的画布裁片注入「复检判废」清晰标签（并刷新稳定签名 ID 以触发 Konva 即时重绘）。
 */
export function annotateBoardPiecesWithReinspection(
  pieces: BoardPlacedPiece[],
  schemeExecution: SchemeExecutionSummary | null | undefined
): BoardPlacedPiece[] {
  if (!schemeExecution || schemeExecution.disposedPieces.size === 0) {
    return pieces;
  }
  return pieces.map((pc) => {
    const rawNumericId = Number(pc.id);
    const hit =
      (Number.isInteger(rawNumericId) && rawNumericId > 0
        ? schemeExecution.disposedPieces.get(rawNumericId)
        : undefined) || schemeExecution.disposedPieces.get(pc.index + 1);
    if (!hit) return pc;
    const prefix = hit.disposition === 'REMNANT' ? '[复检判废·转料头]' : '[复检判废]';
    return {
      ...pc,
      id: `${pc.id}-REINSPECTED`,
      name: `${prefix} ${pc.name}`
    };
  });
}

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
    slitMaxKnives,
    slitMinBladeSpacingMm,
    slitKerfMm,
    slitForbiddenNarrowEdgeMinMm,
    slitForbiddenNarrowEdgeMaxMm,
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
  const [taskReports, setTaskReports] = useState<any[]>([]);
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

  // 左右侧栏折叠状态（1024px 工业平板默认自动折叠右侧方案栏，腾出充足画布视野）
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth <= 1120
  );

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
    const [rList, remList, famList, schList, repPage] = await Promise.all([
      requestJSON('/api/rolls').catch(() => []),
      requestJSON('/api/remnants').catch(() => []),
      requestJSON('/api/v2/demand-pool').catch(() => []),
      curTaskId
        ? requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => [])
        : Promise.resolve([]),
      curTaskId
        ? requestJSON(
            `/api/v2/reconciliation/reports?limit=200&offset=0&taskId=${encodeURIComponent(
              curTaskId
            )}`
          ).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] })
    ]);
    setRolls(Array.isArray(rList) ? rList : []);
    setRemnants(Array.isArray(remList) ? remList : []);
    const fams: DemandFamilySummary[] = Array.isArray(famList) ? famList : [];
    setPoolFamilies(fams);
    setTaskSchemes(Array.isArray(schList) ? schList : []);
    const repItems = Array.isArray(repPage?.items)
      ? repPage.items
      : Array.isArray(repPage)
      ? repPage
      : [];
    setTaskReports(repItems);
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
      setTaskReports([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => []),
      requestJSON(
        `/api/v2/reconciliation/reports?limit=200&offset=0&taskId=${encodeURIComponent(curTaskId)}`
      ).catch(() => ({ items: [] }))
    ]).then(([schList, repPage]) => {
      if (cancelled) return;
      setTaskSchemes(Array.isArray(schList) ? schList : []);
      const repItems = Array.isArray(repPage?.items)
        ? repPage.items
        : Array.isArray(repPage)
        ? repPage
        : [];
      setTaskReports(repItems);
    });
    return () => {
      cancelled = true;
    };
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
      return projectWindowDefectsForBoard(
        currentRoll2D.defects,
        startY,
        effectiveRollLengthMm,
        Number(currentRoll2D.width) || effectiveRollWidthMm,
        settings.defectMarginMm
      );
    }
    if (canvasMode === 'REMNANT' && currentRemnant2D) {
      return projectWindowDefectsForBoard(
        currentRemnant2D.defects,
        0,
        effectiveRollLengthMm,
        Number(currentRemnant2D.width) || effectiveRollWidthMm,
        settings.defectMarginMm
      );
    }
    return [];
  }, [
    activeScheme2D?.canvasMode,
    activeScheme2D?.windowStartY,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    effectiveWindowStartY,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    settings.defectMarginMm
  ]);

  // 当前载入需求族的同缸/色号防色差校验 & 报工复检实绩投影
  const activeTaskId = is2D ? loadedTaskId : slitLoadedTaskId;
  const activePoolFamily = useMemo(() => {
    if (!activeTaskId) return null;
    return poolFamilies.find((f) => f.id === activeTaskId) || null;
  }, [activeTaskId, poolFamilies]);

  const activeOpenRemainingFallback = useMemo(() => {
    if (activePoolFamily && Number.isFinite(Number(activePoolFamily.openTotal))) {
      return Math.max(0, Number(activePoolFamily.openTotal));
    }
    return is2D
      ? activeDemands2D.reduce((s, d) => s + Math.max(0, Number(d.quantity) || 0), 0)
      : slitOrders.reduce((s, o) => s + Math.max(0, Number(o.quantity) || 0), 0);
  }, [activePoolFamily, is2D, activeDemands2D, slitOrders]);

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
    return annotateBoardPiecesWithReinspection(combined, activeSchemeExecution);
  }, [activeScheme2D, activeSchemeExecution]);

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

  const batchGuardWarning = useMemo(() => {
    if (!activePoolFamily) return null;
    const reqBatch = String(activePoolFamily.requiredBatchNo || '').trim();
    const reqColor = String(activePoolFamily.requiredColor || '').trim();
    const strict = Boolean(activePoolFamily.strictBatchMatch);
    if (!reqBatch && !reqColor && !strict) return null;

    let matLabel = '';
    let matBatch = '';
    let matColor = '';
    if (is2D) {
      if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
        matLabel = `母卷 ${currentRoll2D.rollId}`;
        matBatch = String(currentRoll2D.batchNo || '').trim();
        matColor = String(currentRoll2D.color || '').trim();
      } else if (canvasMode === 'REMNANT' && currentRemnant2D) {
        matLabel = `料头 ${currentRemnant2D.id}`;
        matBatch = String(currentRemnant2D.batchNo || currentRemnant2D.materialBatch || '').trim();
        matColor = String(currentRemnant2D.color || '').trim();
      } else {
        return null;
      }
    } else if (slitMaterialMode === 'STOCK_ROLL' && currentRoll1D) {
      matLabel = `母卷 ${currentRoll1D.rollId}`;
      matBatch = String(currentRoll1D.batchNo || '').trim();
      matColor = String(currentRoll1D.color || '').trim();
    } else {
      return null;
    }

    const matchingRoll = passedRolls.find((r) => {
      if (reqBatch && String(r.batchNo || '').trim().toLowerCase() !== reqBatch.toLowerCase()) {
        return false;
      }
      if (reqColor && r.color && String(r.color).trim().toLowerCase() !== reqColor.toLowerCase()) {
        return false;
      }
      if (strict && !String(r.batchNo || '').trim()) return false;
      return true;
    });

    if (reqBatch && (!matBatch || matBatch.toLowerCase() !== reqBatch.toLowerCase())) {
      return {
        blocking: strict,
        title: strict ? '防色差同缸强约束拦截' : '跨缸号预警提示',
        detail: `需求族「${activePoolFamily.name}」指定缸号 ${reqBatch}，当前所选 ${matLabel} 缸号为「${
          matBatch || '未登记'
        }」${strict ? '，已开启同单同缸强约束，禁止直接排版落库。' : '，请注意核对色差风险。'}`,
        suggestedRoll: matchingRoll || null
      };
    }
    if (strict && !matBatch) {
      return {
        blocking: true,
        title: '防色差同缸强约束拦截',
        detail: `需求族「${activePoolFamily.name}」已开启同单同缸强约束，但当前所选 ${matLabel} 未登记缸号，无法通过同缸校验。`,
        suggestedRoll: matchingRoll || null
      };
    }
    if (reqColor && matColor && matColor.toLowerCase() !== reqColor.toLowerCase()) {
      return {
        blocking: strict,
        title: strict ? '色号不匹配拦截' : '色号差异预警',
        detail: `需求族「${activePoolFamily.name}」指定色号「${reqColor}」，当前所选 ${matLabel} 色号为「${matColor}」。`,
        suggestedRoll: matchingRoll || null
      };
    }
    return null;
  }, [
    activePoolFamily,
    is2D,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    slitMaterialMode,
    currentRoll1D,
    passedRolls
  ]);

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
    slitMaxKnives,
    slitMinBladeSpacingMm,
    slitKerfMm,
    slitForbiddenNarrowEdgeMinMm,
    slitForbiddenNarrowEdgeMaxMm,
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
    batchGuardWarning,
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

      {/* 同缸/色号防色差前置预警与拦截横幅 */}
      {batchGuardWarning && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            padding: '7px 14px',
            fontSize: 12.5,
            borderBottom: `1px solid ${
              batchGuardWarning.blocking ? 'var(--err, #dc2626)' : 'var(--warn, #d97706)'
            }`,
            background: batchGuardWarning.blocking
              ? 'var(--err-bg, rgba(220, 38, 38, 0.12))'
              : 'var(--warn-bg, rgba(245, 158, 11, 0.14))',
            color: batchGuardWarning.blocking ? 'var(--err, #b91c1c)' : 'var(--warn, #92400e)'
          }}
        >
          <strong>{batchGuardWarning.title}：</strong>
          <span>{batchGuardWarning.detail}</span>
          {batchGuardWarning.suggestedRoll && (
            <button
              type="button"
              className="btn sm pri"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                const sr = batchGuardWarning.suggestedRoll;
                if (is2D) {
                  setCanvasSpec({
                    canvasMode: 'STOCK_ROLL',
                    selectedRollId: sr.rollId,
                    canvasWidthMm: sr.width,
                    materialModel2D: sr.rollModel,
                    windowStartY2D: null
                  });
                } else {
                  setSlitSpec({
                    slitMaterialMode: 'STOCK_ROLL',
                    selectedRollId: sr.rollId,
                    slitMotherWidthMm: sr.width,
                    slitMaterialModel: sr.rollModel
                  });
                }
                toast(`已切换至同缸匹配母卷 ${sr.rollId}（缸号 ${sr.batchNo}）`);
              }}
            >
              一键切换至同缸卷 {batchGuardWarning.suggestedRoll.rollId}
            </button>
          )}
        </div>
      )}

      {/* 实绩与复检同步条：复用质检页/履约账本同一 receiptSummary 口径，确保净良品与补排缺口三处一致 */}
      {taskExecutionProjection &&
        (taskExecutionProjection.reportCount > 0 ||
          taskExecutionProjection.reinspectionDisposedTotal > 0) && (() => {
          const hasReinspection = taskExecutionProjection.reinspectionDisposedTotal > 0;
          const hasRejected = taskExecutionProjection.rejectedTotalCount > 0;
          const unitLabel = is2D ? '片' : '卷';
          const activeDisposedCount = activeSchemeExecution?.disposedPieces.size ?? 0;
          return (
            <div
              role="status"
              aria-label="实绩与复检同步条"
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
                padding: '7px 14px',
                fontSize: 12.5,
                borderBottom: `1px solid ${
                  hasReinspection
                    ? 'var(--warn, #d97706)'
                    : 'var(--line-2, rgba(148, 163, 184, 0.35))'
                }`,
                borderLeft: `3px solid ${
                  hasReinspection
                    ? 'var(--err, #dc2626)'
                    : hasRejected
                    ? 'var(--warn, #d97706)'
                    : 'var(--ok, #059669)'
                }`,
                background: hasReinspection
                  ? 'var(--warn-bg, rgba(245, 158, 11, 0.12))'
                  : 'var(--panel-2, rgba(16, 185, 129, 0.08))'
              }}
            >
              <span className={`tag ${hasReinspection ? 'warn' : 'ok'}`}>
                实绩与复检同步 · {taskExecutionProjection.reportCount} 笔报工
              </span>
              <span className="num">
                已实切净合格{' '}
                <b style={{ color: 'var(--ok, #059669)' }}>
                  {taskExecutionProjection.netQualifiedCount} {unitLabel}
                </b>
              </span>
              <span className="num">
                复检判废扣回{' '}
                <b
                  style={{
                    color: hasReinspection ? 'var(--err, #dc2626)' : 'var(--cp-ink-2, inherit)'
                  }}
                >
                  {taskExecutionProjection.reinspectionDisposedTotal} {unitLabel}
                </b>
                {taskExecutionProjection.reinspectionRemnantCount > 0 && (
                  <span className="muted">
                    （含转料头 {taskExecutionProjection.reinspectionRemnantCount} {unitLabel}）
                  </span>
                )}
              </span>
              {taskExecutionProjection.rejectedTotalCount >
                taskExecutionProjection.reinspectionDisposedTotal && (
                <span className="num muted">
                  报工初始异常{' '}
                  {taskExecutionProjection.rejectedTotalCount -
                    taskExecutionProjection.reinspectionDisposedTotal}{' '}
                  {unitLabel}
                </span>
              )}
              <span className="num">
                待补排余量{' '}
                <b
                  style={{
                    color:
                      taskExecutionProjection.openRemainingCount > 0
                        ? 'var(--warn, #b45309)'
                        : 'var(--ok, #059669)'
                  }}
                >
                  {taskExecutionProjection.openRemainingCount} {unitLabel}
                </b>
              </span>
              {is2D && activeScheme2D?.confirmedSchemeId && activeDisposedCount > 0 && (
                <span className="tag err num">
                  当前方案 {activeDisposedCount} 片已复检判废（画布已标注）
                </span>
              )}
              <span className="sp" />
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <a className="btn sm" href="#/reconciliation">
                  复检处置 ↗
                </a>
                <a className="btn sm" href="#/reconciliation">
                  履约账本 ↗
                </a>
              </div>
            </div>
          );
        })()}

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
          taskId={activeTaskId || undefined}
          strategyRuns2D={strategyRuns2D}
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
            slitMaxKnives={slitMaxKnives}
            slitMinBladeSpacingMm={slitMinBladeSpacingMm}
            slitKerfMm={slitKerfMm}
            slitForbiddenNarrowEdgeMinMm={slitForbiddenNarrowEdgeMinMm}
            slitForbiddenNarrowEdgeMaxMm={slitForbiddenNarrowEdgeMaxMm}
            currentRoll1D={currentRoll1D}
            setSlitSpec={setSlitSpec}
            settings={settings}
            updateStudioSettings={updateStudioSettings}
            activeSchemeExecutionSummary={activeSchemeExecution}
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
