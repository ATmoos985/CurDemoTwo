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
  computeSuggestedFeedWindow,
  exportCam2D,
  exportExcel1D
} from './workbench/workbenchUtils';
import { projectWindowDefectsForBoard } from './workbench/defectWindowUtils';
import {
  buildMultiMaterialCandidateRollOptions,
  buildMultiMaterialWorkbenchRequest,
  exportMultiMaterialCsv,
  toBoardDefectsFromSchemeSnapshot
} from './workbench/multiMaterialWorkbenchUtils';
import { useWorkbenchBoardEdit } from './workbench/useWorkbenchBoardEdit';
import { useWorkbenchSolver } from './workbench/useWorkbenchSolver';
import { WorkbenchTopBar } from './workbench/WorkbenchTopBar';
import { WorkbenchDemandSidebar } from './workbench/WorkbenchDemandSidebar';
import { WorkbenchCenterPanel } from './workbench/WorkbenchCenterPanel';
import { WorkbenchRightPanel } from './workbench/WorkbenchRightPanel';
import { DemandOverviewModal } from './workbench/DemandOverviewModal';
import { ExternalPlanBanner } from './workbench/ExternalPlanBanner';
import { DraftInboxDrawer } from './workbench/DraftInboxDrawer';
import { DraftDiscardDialog } from './workbench/DraftDiscardDialog';
import { useDraftInbox } from './workbench/useDraftInbox';
import {
  evaluateActiveDraftBlockedReason,
  fetchWorkbenchDraft,
  fetchWorkbenchDrafts,
  type WorkbenchDraftDto
} from './workbench/draftInboxApi';
import {
  mapResultContextToWorkbenchPlan,
  type ExternalPlanBannerMeta,
  type WorkbenchResultContextDto,
  type WorkbenchSchemeDraftDto
} from './workbench/workbenchDeeplinkUtils';

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
  resultId?: string;
  draftId?: string;
  forceDimension?: '2D' | '1D';
}> = ({ taskId, resultId, draftId, forceDimension }) => {
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
    multiPreferRemnants,
    multiMaxRemnants,
    multiCandidateRollIds,
    multiMaterialSummary,
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
    setActiveDemands2D,
    restoreWorkbenchDraft,
    updateDemand2D,
    removeDemand2D,
    addBlankDemand2D,
    setStrategyRuns2D,
    addSchemes2D,
    setSchemes2D,
    setMultiMaterialSummary,
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

  // URL 深链一键接管外部试排方案 / 草案预检状态（按三元组防重复拉取）
  const [externalPlanLoading, setExternalPlanLoading] = useState<boolean>(false);
  const [externalPlanError, setExternalPlanError] = useState<string | null>(null);
  const [externalPlanBanner, setExternalPlanBanner] = useState<ExternalPlanBannerMeta | null>(null);
  const [externalPlanDismissed, setExternalPlanDismissed] = useState<boolean>(false);
  const [deeplinkNonce, setDeeplinkNonce] = useState<number>(0);
  const [siblingDrafts, setSiblingDrafts] = useState<WorkbenchDraftDto[]>([]);
  const [draftClockTick, setDraftClockTick] = useState<number>(0);
  const deeplinkLoadedKeyRef = useRef<string>('');

  const syncExternalPlanBannerWithDraft = React.useCallback((updated: WorkbenchDraftDto) => {
    const updatedId = updated.draftId || updated.id;
    const upperStatus = String(updated.status || '').toUpperCase();
    const expMs = updated.expiresAt ? Date.parse(updated.expiresAt) : NaN;
    const isExpiredNow =
      upperStatus === 'EXPIRED' ||
      (upperStatus === 'PENDING_CONFIRMATION' && Number.isFinite(expMs) && expMs < Date.now());
    const nextStatus = isExpiredNow && upperStatus === 'PENDING_CONFIRMATION' ? 'EXPIRED' : updated.status;
    setExternalPlanBanner((prev) => {
      if (!prev || prev.draftId !== updatedId) return prev;
      if (
        prev.status === nextStatus &&
        prev.expired === isExpiredNow &&
        prev.stale === Boolean(updated.stale) &&
        (prev.confirmedSchemeId || null) === (updated.confirmedSchemeId || null) &&
        (prev.discardReason || null) === (updated.discardReason || null) &&
        (prev.expiresAt || null) === (updated.expiresAt || null)
      ) {
        return prev;
      }
      return {
        ...prev,
        status: nextStatus,
        expired: isExpiredNow,
        stale: Boolean(updated.stale),
        staleReasons: Array.isArray(updated.staleReasons) ? updated.staleReasons : prev.staleReasons,
        confirmedSchemeId: updated.confirmedSchemeId ?? prev.confirmedSchemeId,
        discardReason: updated.discardReason ?? prev.discardReason,
        expiresAt: updated.expiresAt ?? prev.expiresAt
      };
    });
  }, []);

  const draftInbox = useDraftInbox({
    activeDraftId: externalPlanBanner?.draftId || draftId || null,
    onForceReloadDeeplink: () => setDeeplinkNonce((n) => n + 1),
    onDraftStateChanged: (updated) => {
      const updatedId = updated.draftId || updated.id;
      syncExternalPlanBannerWithDraft(updated);
      if (externalPlanBanner?.draftId === updatedId) {
        setDeeplinkNonce((n) => n + 1);
      }
    },
    onActiveDraftSynced: syncExternalPlanBannerWithDraft
  });

  // 实时监测当前活动草案的 expiresAt 到期时间，到期瞬间自动切换横幅与确认按钮阻断状态
  useEffect(() => {
    if (!externalPlanBanner || externalPlanBanner.status !== 'PENDING_CONFIRMATION' || externalPlanBanner.expired) {
      return;
    }
    if (!externalPlanBanner.expiresAt) return;
    const expMs = Date.parse(externalPlanBanner.expiresAt);
    if (!Number.isFinite(expMs)) return;
    const delayMs = expMs - Date.now() + 100;
    if (delayMs <= 0) {
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === externalPlanBanner.draftId && prev.status === 'PENDING_CONFIRMATION'
          ? { ...prev, status: 'EXPIRED', expired: true }
          : prev
      );
      setDraftClockTick(Date.now());
      return;
    }
    if (delayMs > 86_400_000) return;
    const timer = window.setTimeout(() => {
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === externalPlanBanner.draftId && prev.status === 'PENDING_CONFIRMATION'
          ? { ...prev, status: 'EXPIRED', expired: true }
          : prev
      );
      setDraftClockTick(Date.now());
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [externalPlanBanner]);

  useEffect(() => {
    const groupId = externalPlanBanner?.batchGroupId;
    if (!groupId) {
      setSiblingDrafts([]);
      return;
    }
    let cancelled = false;
    fetchWorkbenchDrafts({ status: 'ALL', batchGroupId: groupId, page: 0, size: 50 })
      .then((res) => {
        if (!cancelled) {
          setSiblingDrafts(res.items || []);
        }
      })
      .catch(() => {
        if (!cancelled) setSiblingDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [externalPlanBanner?.batchGroupId, externalPlanBanner?.status, deeplinkNonce]);

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

  // URL 深链统一载入：支持 #/workbench/:taskId、#/workbench?taskId=...&resultId=... 与 #/workbench?taskId=...&draftId=...
  useEffect(() => {
    const cleanTaskId = (taskId || '').trim();
    const cleanResultId = (resultId || '').trim();
    const cleanDraftId = (draftId || '').trim();
    const deeplinkKey = `${cleanTaskId}|${cleanResultId}|${cleanDraftId}|${deeplinkNonce}`;

    if (!cleanTaskId && !cleanResultId && !cleanDraftId) {
      deeplinkLoadedKeyRef.current = '';
      return;
    }
    if (deeplinkLoadedKeyRef.current === deeplinkKey) {
      return;
    }
    deeplinkLoadedKeyRef.current = deeplinkKey;

    const hasExternalPlan = Boolean(cleanResultId || cleanDraftId);
    let cancelled = false;
    let finished = false;

    const hydrateFromDeeplink = async () => {
      let draft: WorkbenchSchemeDraftDto | null = null;
      let loadedFamily: DemandFamilySummary | null = null;

      if (hasExternalPlan) {
        setExternalPlanLoading(true);
        setExternalPlanError(null);
        setExternalPlanBanner(null);
        setExternalPlanDismissed(false);
      }

      try {
        // a) 若携带 draftId，先读取持久化草案拿到 target.taskId / target.resultId 与预检告警
        if (cleanDraftId) {
          draft = await requestJSON(
            '/api/v2/workbench/drafts/' + encodeURIComponent(cleanDraftId)
          );
          if (cancelled) return;
        }

        const effectiveTaskId = cleanTaskId || String(draft?.target?.taskId || '').trim();
        const effectiveResultId = cleanResultId || String(draft?.target?.resultId || '').trim();

        // b) 若有 taskId，先通过既有需求池逻辑加载该任务并切换至对应维度（2D/1D）
        if (effectiveTaskId) {
          try {
            const fam: DemandFamilySummary = await requestJSON(
              '/api/v2/demand-pool/' + encodeURIComponent(effectiveTaskId)
            );
            if (cancelled) return;
            if (fam?.id) {
              loadedFamily = fam;
              loadDemandFamilyIntoWorkbench(fam);
              setDemandSourceTab('POOL');
            }
          } catch (famErr: any) {
            if (cancelled) return;
            if (!effectiveResultId && !cleanDraftId) {
              toast('加载需求族失败：' + (famErr?.message || '请求异常'), true);
              return;
            }
          }
        }

        // 纯 taskId 深链不触发外部试排横幅与结果拉取
        if (!hasExternalPlan) {
          return;
        }

        if (!effectiveResultId) {
          const fallbackPlan = mapResultContextToWorkbenchPlan(null, draft, loadedFamily);
          const msg = '草案缺少关联的试排结果编号（resultId），无法渲染排料画布。';
          setExternalPlanBanner(fallbackPlan.banner);
          setExternalPlanError(msg);
          toast(msg, true);
          return;
        }

        // c) 拉取外部试排结果完整上下文并映射为工作台可交互候选方案
        const context: WorkbenchResultContextDto = await requestJSON(
          '/api/v2/workbench/results/' + encodeURIComponent(effectiveResultId) + '/context'
        );
        if (cancelled) return;

        // 若 URL 与草案未给 taskId 但结果来源关联了任务，补充载入左侧需求池任务
        const inferredTaskId =
          effectiveTaskId ||
          String(
            context?.source?.taskId ||
              context?.taskSummary?.id ||
              context?.taskSummary?.taskId ||
              ''
          ).trim();
        if (!loadedFamily && inferredTaskId) {
          try {
            const fam: DemandFamilySummary = await requestJSON(
              '/api/v2/demand-pool/' + encodeURIComponent(inferredTaskId)
            );
            if (cancelled) return;
            if (fam?.id) {
              loadedFamily = fam;
              loadDemandFamilyIntoWorkbench(fam);
              setDemandSourceTab('POOL');
            }
          } catch {
            // 需求族拉取失败时仍继续渲染试排画布，避免阻断人工核对
          }
        }

        const mapped = mapResultContextToWorkbenchPlan(context, draft, loadedFamily);
        if (cancelled) return;

        if (mapped.error) {
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(mapped.error);
          toast(mapped.error, true);
          return;
        }

        if (mapped.dimension === '2D' && mapped.scheme2D) {
          setActiveDimension('2D');
          if (mapped.canvasPatch2D) {
            setCanvasSpec(mapped.canvasPatch2D);
          }
          if (!loadedFamily && mapped.demands2D.length > 0) {
            setActiveDemands2D(mapped.demands2D);
          }
          const prevSchemes = useStudioStore.getState().schemes2D;
          const nextSchemes = [
            mapped.scheme2D,
            ...prevSchemes.filter((s) => s.id !== mapped.scheme2D!.id)
          ];
          setSchemes2D(nextSchemes, mapped.scheme2D.id);
          draftHydratedKeyRef.current = mapped.taskId || inferredTaskId || 'scratch';
          setRecoverableDraft(null);
          allowAutoSaveRef.current = true;
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(null);
        } else if (mapped.dimension === '1D' && mapped.scheme1D) {
          setActiveDimension('1D');
          if (mapped.slitPatch1D) {
            setSlitSpec({
              ...mapped.slitPatch1D,
              ...(!loadedFamily && mapped.slitOrders1D.length > 0
                ? { slitOrders: mapped.slitOrders1D }
                : {})
            });
          }
          const prevSlit = useStudioStore.getState().slitSchemes;
          const nextSlit = [
            mapped.scheme1D,
            ...prevSlit.filter((s) => s.id !== mapped.scheme1D!.id)
          ];
          setSlitSchemes(nextSlit);
          setActiveSlitScheme(mapped.scheme1D.id);
          draftHydratedKeyRef.current = mapped.taskId || inferredTaskId || 'scratch';
          setRecoverableDraft(null);
          allowAutoSaveRef.current = true;
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(null);
        }

        reloadReferenceData(mapped.taskId || inferredTaskId || null).catch(() => {});
      } catch (err: any) {
        if (cancelled) return;
        const msg = '加载外部试排方案失败：' + (err?.message || '请确认链接有效或服务已就绪');
        if (draft) {
          setExternalPlanBanner(mapResultContextToWorkbenchPlan(null, draft, loadedFamily).banner);
        }
        setExternalPlanError(msg);
        toast(msg, true);
      } finally {
        finished = true;
        if (!cancelled && hasExternalPlan) {
          setExternalPlanLoading(false);
        }
      }
    };

    hydrateFromDeeplink();

    return () => {
      cancelled = true;
      if (!finished && deeplinkLoadedKeyRef.current === deeplinkKey) {
        deeplinkLoadedKeyRef.current = '';
      }
    };
  }, [taskId, resultId, draftId, deeplinkNonce]);

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
        canvasMode: canvasMode === 'MULTI_MATERIAL' ? 'FREE_CANVAS' : canvasMode,
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

  // 当前载入需求族的同缸/色号防色差校验 & 多料联排候选母卷联动
  const activeTaskId = is2D ? loadedTaskId : slitLoadedTaskId;
  const activePoolFamily = useMemo(() => {
    if (!activeTaskId) return null;
    return poolFamilies.find((f) => f.id === activeTaskId) || null;
  }, [activeTaskId, poolFamilies]);

  const multiFilterContext = useMemo(
    () => ({
      materialModel: activePoolFamily?.materialModel || materialModel2D || undefined,
      requiredBatchNo: activePoolFamily?.requiredBatchNo || undefined,
      requiredColor: activePoolFamily?.requiredColor || undefined,
      strictBatchMatch: Boolean(activePoolFamily?.strictBatchMatch)
    }),
    [activePoolFamily, materialModel2D]
  );

  const multiCandidateRollOptions = useMemo(
    () => buildMultiMaterialCandidateRollOptions(passedRolls, multiFilterContext),
    [passedRolls, multiFilterContext]
  );

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
    if (canvasMode === 'MULTI_MATERIAL') {
      const firstEligible =
        multiCandidateRollOptions.find((r) => r.eligible) || multiCandidateRollOptions[0];
      if (firstEligible && firstEligible.width > 0) return firstEligible.width;
    }
    return canvasWidthMm;
  }, [
    activeScheme2D,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    multiCandidateRollOptions,
    canvasWidthMm
  ]);

  const effectiveRollLengthMm = useMemo(() => {
    const baseLen =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
    if (!activeScheme2D) return baseLen;
    if (activeScheme2D.canvasMode === 'REMNANT' || Boolean(activeScheme2D.multiMaterialRole)) {
      return Math.max(
        100,
        Math.ceil(activeScheme2D.canvasLengthMm || 0),
        Math.ceil(activeScheme2D.occupiedLengthMm || 0)
      );
    }
    return Math.max(
      baseLen,
      Math.ceil(activeScheme2D.occupiedLengthMm || 0),
      Math.ceil(activeScheme2D.canvasLengthMm || 0)
    );
  }, [activeScheme2D, canvasMode, currentRemnant2D, canvasLengthMm]);

  const effectiveTrimStartMm = useMemo(() => {
    if (activeScheme2D) {
      return activeScheme2D.canvasMode === 'REMNANT' ? 0 : trimStartMm;
    }
    return canvasMode === 'REMNANT' ? 0 : trimStartMm;
  }, [activeScheme2D, canvasMode, trimStartMm]);

  const effectiveRollTitle = useMemo(() => {
    if (activeScheme2D) {
      if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
        const y0 = Math.round(Number(activeScheme2D.windowStartY) || 0);
        return y0 > 0
          ? `实卷 ${activeScheme2D.rollId} (Y=${y0}mm)`
          : `实卷 ${activeScheme2D.rollId}`;
      }
      if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
        return `料头 ${activeScheme2D.remnantId}`;
      }
      return '虚拟新母卷';
    }
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return `实卷 ${currentRoll2D.rollId}`;
    if (canvasMode === 'REMNANT' && currentRemnant2D) return `料头 ${currentRemnant2D.id}`;
    if (canvasMode === 'MULTI_MATERIAL') return '多料联排（待求解）';
    return '虚拟新母卷';
  }, [activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D]);

  const windowDefects2D: BoardDefect[] = useMemo(() => {
    if (activeScheme2D) {
      if (Array.isArray(activeScheme2D.defects) && activeScheme2D.defects.length > 0) {
        const alreadyAligned = activeScheme2D.defects.some((d) => d.windowAligned);
        if (alreadyAligned) {
          return toBoardDefectsFromSchemeSnapshot(activeScheme2D.defects);
        }
        return projectWindowDefectsForBoard(
          activeScheme2D.defects,
          0,
          effectiveRollLengthMm,
          effectiveRollWidthMm,
          settings.defectMarginMm
        );
      }
      if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
        const matchedRoll =
          rolls.find((r) => r.rollId === activeScheme2D.rollId) || currentRoll2D;
        if (matchedRoll) {
          const startY =
            activeScheme2D.windowStartY != null
              ? activeScheme2D.windowStartY
              : effectiveWindowStartY;
          return projectWindowDefectsForBoard(
            matchedRoll.defects,
            startY,
            effectiveRollLengthMm,
            Number(matchedRoll.width) || effectiveRollWidthMm,
            settings.defectMarginMm
          );
        }
      }
      if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
        const matchedRem =
          remnants.find((rm) => rm.id === activeScheme2D.remnantId) || currentRemnant2D;
        if (matchedRem) {
          return projectWindowDefectsForBoard(
            matchedRem.defects,
            0,
            effectiveRollLengthMm,
            Number(matchedRem.width) || effectiveRollWidthMm,
            settings.defectMarginMm
          );
        }
      }
      if (activeScheme2D.canvasMode === 'FREE_CANVAS') {
        return [];
      }
    }

    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
      return projectWindowDefectsForBoard(
        currentRoll2D.defects,
        effectiveWindowStartY,
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
    activeScheme2D,
    canvasMode,
    rolls,
    remnants,
    currentRoll2D,
    currentRemnant2D,
    effectiveWindowStartY,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    settings.defectMarginMm
  ]);

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
      } else if (canvasMode === 'MULTI_MATERIAL' && multiCandidateRollIds.length > 0) {
        const offending = multiCandidateRollIds
          .map((rid) => passedRolls.find((r) => r.rollId === rid))
          .find((r) => {
            if (!r) return false;
            const rb = String(r.batchNo || '').trim();
            const rc = String(r.color || '').trim();
            if (reqBatch && (!rb || rb.toLowerCase() !== reqBatch.toLowerCase())) return true;
            if (strict && !rb) return true;
            if (reqColor && rc && rc.toLowerCase() !== reqColor.toLowerCase()) return true;
            return false;
          });
        if (!offending) return null;
        matLabel = `已选候选母卷 ${offending.rollId}`;
        matBatch = String(offending.batchNo || '').trim();
        matColor = String(offending.color || '').trim();
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
    multiCandidateRollIds,
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
    requiredBatchNo: activePoolFamily?.requiredBatchNo || null,
    requiredColor: activePoolFamily?.requiredColor || null,
    multiPreferRemnants,
    multiMaxRemnants,
    multiCandidateRollIds,
    loadedTaskId,
    loadedTaskName: loadedTaskName || '',
    loadedExternalRef: loadedExternalRef || '',
    currentRoll2D,
    currentRemnant2D,
    activeScheme2D,
    setStrategyRuns2D,
    addSchemes2D,
    setSchemes2D,
    setMultiMaterialSummary,
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
    syncMergedDemandFamiliesProgress,
    onDraftConfirmed: (confirmedDraftId, schemeId) => {
      draftInbox.refreshDraftInbox({ silent: true }).catch(() => {});
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === confirmedDraftId
          ? {
              ...prev,
              status: 'CONFIRMED',
              confirmedSchemeId: schemeId,
              expired: false,
              stale: false,
              staleReasons: []
            }
          : prev
      );
    },
    onDraftConfirmFailed: (failedDraftId) => {
      draftInbox.refreshDraftInbox({ silent: true }).catch(() => {});
      fetchWorkbenchDraft(failedDraftId)
        .then((latest) => {
          syncExternalPlanBannerWithDraft(latest);
        })
        .catch(() => {});
    }
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
    trimStartMm: effectiveTrimStartMm,
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

  const activeSchemeDraftId = is2D ? activeScheme2D?.draftId : activeScheme1D?.draftId;
  const activeSchemeConfirmedId = is2D
    ? activeScheme2D?.confirmedSchemeId
    : activeScheme1D?.confirmedSchemeId;

  // 若从本机草稿恢复的方案仍携带 draftId 且尚无对应外部草案横幅，自动同步一次实时草案状态以防越过过期/作废阻断
  useEffect(() => {
    if (!activeSchemeDraftId || activeSchemeConfirmedId || externalPlanLoading) return;
    if (externalPlanBanner && externalPlanBanner.draftId === activeSchemeDraftId) return;
    let cancelled = false;
    fetchWorkbenchDraft(activeSchemeDraftId)
      .then((latest) => {
        if (cancelled) return;
        const mapped = mapResultContextToWorkbenchPlan(null, latest as WorkbenchSchemeDraftDto, null);
        setExternalPlanBanner(mapped.banner);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSchemeDraftId, activeSchemeConfirmedId, externalPlanLoading, externalPlanBanner?.draftId]);

  const activeDraftBlockedReason = useMemo(() => {
    return evaluateActiveDraftBlockedReason({
      draftId: activeSchemeDraftId,
      confirmedSchemeId: activeSchemeConfirmedId,
      banner: externalPlanBanner,
      nowMs: Date.now()
    });
  }, [activeSchemeDraftId, activeSchemeConfirmedId, externalPlanBanner, draftClockTick]);

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
    draftInbox.triggerMultiMaterialDraftBatch({
      ...reqRes.payload,
      continueAcrossRolls: true,
      ttlSeconds: 1800
    });
  };

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
        pendingDraftCount={draftInbox.pendingCount}
        onOpenDraftInbox={draftInbox.openDrawer}
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
        multiPreferRemnants={multiPreferRemnants}
        multiMaxRemnants={multiMaxRemnants}
        multiCandidateRollIds={multiCandidateRollIds}
        multiCandidateRollOptions={multiCandidateRollOptions}
        multiFilterContext={multiFilterContext}
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

      {/* 外部深链试排方案与草案预检顶部提示条 */}
      {!externalPlanDismissed && (externalPlanLoading || externalPlanError || externalPlanBanner) && (
        <ExternalPlanBanner
          loading={externalPlanLoading}
          error={externalPlanError}
          banner={externalPlanBanner}
          confirmedSchemeId={
            externalPlanBanner
              ? is2D
                ? activeScheme2D?.id === `EXT-2D-${externalPlanBanner.resultId}`
                  ? activeScheme2D.confirmedSchemeId || null
                  : null
                : activeScheme1D?.id === `EXT-1D-${externalPlanBanner.resultId}`
                ? activeScheme1D.confirmedSchemeId || null
                : null
              : null
          }
          siblingDrafts={siblingDrafts}
          onSelectDraft={draftInbox.previewDraft}
          onDiscardDraft={(targetDraftId) => {
            const matched =
              siblingDrafts.find((d) => (d.draftId || d.id) === targetDraftId) ||
              draftInbox.drafts.find((d) => (d.draftId || d.id) === targetDraftId);
            if (matched) {
              draftInbox.openDiscardDialog(matched);
            } else if (externalPlanBanner) {
              draftInbox.openDiscardDialog({
                id: targetDraftId,
                draftId: targetDraftId,
                status: externalPlanBanner.status,
                issuedAt: '',
                expiresAt: externalPlanBanner.expiresAt || '',
                stale: externalPlanBanner.stale,
                staleReasons: externalPlanBanner.staleReasons,
                target: {
                  resultId: externalPlanBanner.resultId,
                  taskId: externalPlanBanner.taskId
                },
                riskChecks: externalPlanBanner.riskChecks
              });
            }
          }}
          onDismiss={() => {
            setExternalPlanDismissed(true);
            setExternalPlanError(null);
          }}
        />
      )}

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
          trimStartMm={effectiveTrimStartMm}
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
            setActiveScheme2D={setActiveScheme2D}
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
            onExportMultiMaterialCsv={() =>
              exportMultiMaterialCsv(multiMaterialSummary?.rawResponse)
            }
            onGenerateMultiMaterialDrafts={handleGenerateMultiMaterialDrafts}
            generatingMultiMaterialDrafts={draftInbox.generatingBatch}
            activeDraftBlockedReason={activeDraftBlockedReason}
            onStopSolve={handleStopSolve}
            onRunSolve2D={handleRunSolve2D}
            onRunSolve1D={handleRunSolve1D}
            canvasMode={canvasMode}
            multiPreferRemnants={multiPreferRemnants}
            multiMaxRemnants={multiMaxRemnants}
            multiCandidateRollCount={multiCandidateRollIds.length}
            multiMaterialSummary={multiMaterialSummary}
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

      <DraftInboxDrawer
        open={draftInbox.drawerOpen}
        drafts={draftInbox.drafts}
        total={draftInbox.total}
        pendingCount={draftInbox.pendingCount}
        statusFilter={draftInbox.statusFilter}
        batchGroupFilter={draftInbox.batchGroupFilter}
        activeDraftId={draftInbox.activeDraftId}
        loading={draftInbox.loading}
        loadingMore={draftInbox.loadingMore}
        error={draftInbox.error}
        onClose={draftInbox.closeDrawer}
        onRefresh={() => draftInbox.refreshDraftInbox()}
        onLoadMore={draftInbox.loadMoreDrafts}
        onChangeStatusFilter={draftInbox.changeStatusFilter}
        onClearBatchGroupFilter={draftInbox.clearBatchGroupFilter}
        onPreviewDraft={draftInbox.previewDraft}
        onDiscardDraft={draftInbox.openDiscardDialog}
      />

      <DraftDiscardDialog
        draft={draftInbox.discardTarget}
        submitting={draftInbox.discardSubmitting}
        onClose={draftInbox.closeDiscardDialog}
        onConfirmDiscard={draftInbox.submitDiscard}
      />
    </div>
  );
};
