import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CadCanvasView } from '../components/CadCanvasView';
import { SlittingStripBar } from './CuttingWorkbenchPage';
import { ModalDialog } from '../components/ModalDialog';
import { BarcodeSvg } from '../components/BarcodeSvg';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { NumberInput } from '../components/ui/NumberInput';
import { showcaseScene } from '../lib/model/showcase.js';
import { rectangle } from '../lib/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '../lib/domain/cam-format.js';
import { requestJSON, idempotentPost, toast, fmtN, fmtM, loadSheetLib } from '../lib/core/util.js';
import { useStudioStore } from '../store/useStudioStore';
import { extractCncPostOptions } from '../store/studioSettings';
import { idempotentJsonPost } from '../utils/authClient';
import { buildCompleteSchemeIdempotencyKey } from './workbench/schemeConfirmUtils';
import {
  buildCutTicketModel,
  buildSlittingCsvText,
  extractWindowDefects,
  matchScannedScheme
} from './results/cutTicketUtils';
import {
  MAX_REVERSAL_REASON_LENGTH,
  buildReversalRequest,
  evaluateSchemeReversalEligibility,
  validateReversalReason
} from './results/reportReversalUtils';

const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  AWAITING_ROLL: { label: '待绑实卷 (虚拟母卷)', cls: 'warn' },
  READY_TO_CUT: { label: '已锁实卷待切', cls: 'run' },
  DISPATCHED_MES: { label: '已下发 MES', cls: 'kind' },
  COMPLETED: { label: '已完工记账', cls: 'ok' },
  CANCELLED: { label: '已作废释放', cls: '' },
  REVERSED: { label: '已冲销释放', cls: 'warn' }
};

function sanitizeSchemeTitle(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/OR-?Tools\s*/gi, '')
    .replace(/Deepnest\s*(NFP\+GA\s*)?/gi, '异形')
    .replace(/PackingSolver\s*/gi, '')
    .replace(/NewSolver\s*/gi, '')
    .replace(/Java\s*天际线\/直刀/gi, '')
    .replace(/\s*\((FAST|QUALITY)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildReplayScene2D(scheme: any) {
  if (!scheme?.layout2D?.placements?.length) return null;
  try {
    const hasPoly = scheme.dimension === 'CONTOUR_2D';
    const matId = scheme.rollId || 'VIRTUAL-ROLL';
    const allPlacements = scheme.layout2D.placements || [];
    const leftovers = scheme.layout2D.leftovers || [];
    const cuts = scheme.layout2D.cuts || [];

    const maxPieceY = allPlacements.reduce(
      (m: number, p: any) => m > (p.y || 0) + (p.shape?.height || p.l || 0) ? m : (p.y || 0) + (p.shape?.height || p.l || 0),
      0
    );
    const maxRemY = leftovers.reduce(
      (m: number, r: any) => Math.max(m, (r.y || 0) + (r.l || 0)),
      0
    );
    const maxCutY = cuts.reduce(
      (m: number, c: any) => Math.max(m, c.startY || 0, c.endY || 0),
      0
    );
    const matLen = Math.max(
      100,
      Number(scheme.occupiedLengthMm) || 0,
      maxPieceY,
      maxRemY,
      maxCutY
    );
    const matWidth = Math.max(100, Number(scheme.widthMm) || 1600);
    const matShape = rectangle(matWidth, matLen);

    const req = {
      schemaVersion: '2.0',
      problemType: 'NESTING_2D',
      problem: {
        schemaVersion: '1',
        unit: 'mm',
        material: {
          id: matId,
          shape: matShape,
          exclusions: []
        },
        parts: [],
        process: {
          mode: hasPoly ? 'CONTOUR' : 'GUILLOTINE',
          startCorner: 'left-top',
          trimStart: scheme.trimStartMm || 0
        }
      }
    };
    const gapFillPlacements = allPlacements
      .filter((p: any) => p.gapFill)
      .map((p: any) => ({
        id: p.id,
        demandId: p.demandId,
        name: p.name,
        x: p.x,
        y: p.y,
        rotationDegrees: p.rotationDegrees || 0,
        shape: p.shape || rectangle(Math.max(1, p.w), Math.max(1, p.l))
      }));

    const res = {
      meetsRequirement: Boolean(scheme.complete),
      fulfillmentStatus: scheme.complete ? 'COMPLETE' : 'PARTIAL',
      layout: {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        materialId: matId,
        processingRegion: matShape,
        placements: allPlacements
          .filter((p: any) => !p.gapFill)
          .map((p: any) => ({
            id: p.id,
            demandId: p.demandId,
            name: p.name,
            x: p.x,
            y: p.y,
            rotationDegrees: p.rotationDegrees || 0,
            shape: p.shape || rectangle(Math.max(1, p.w), Math.max(1, p.l))
          })),
        leftovers: leftovers
          .filter((rm: any) => rm.w > 0 && rm.l > 0)
          .map((rm: any, i: number) => ({
            id: rm.id || i + 1,
            x: rm.x,
            y: rm.y,
            shape: rectangle(rm.w, rm.l),
            hasDefect: Boolean(rm.hasDefect)
          })),
        cuts: cuts.map((c: any) => ({
          sequence: c.sequence,
          kind: c.kind,
          startX: c.startX,
          startY: c.startY,
          endX: c.endX,
          endY: c.endY
        }))
      },
      marker: {
        occupiedLengthMm: matLen,
        gapFillPlacements
      }
    };
    const sc = (showcaseScene as any)(req, res, 0, {
      occupiedLengthMm: matLen,
      gapFillPlacements
    });
    if (sc && sc.roll) {
      sc.roll = {
        ...sc.roll,
        id: scheme.rollId || '虚拟新母卷',
        width: matWidth,
        total: matLen
      };
      if (Array.isArray(sc.segments) && sc.segments[0]) {
        sc.segments[0] = {
          ...sc.segments[0],
          label: sanitizeSchemeTitle(scheme.title) || scheme.id || '排程方案复盘'
        };
      }
    }
    return sc;
  } catch (err) {
    console.warn('buildReplayScene2D fallback:', err);
    return null;
  }
}

export const ResultsCenterPage: React.FC<{
  schemeId?: string;
  taskIdQuery?: string;
}> = ({ schemeId, taskIdQuery }) => {
  const settings = useStudioStore((s) => s.settings);

  const [entries, setEntries] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [taskOpenMap, setTaskOpenMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [selectedId, setSelectedId] = useState<string>(schemeId || '');
  const [showPath, setShowPath] = useState(true);
  const [vertical, setVertical] = useState<boolean>(settings.vertical);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVertical(settings.vertical);
  }, [settings.vertical]);

  // Bind Roll Form State
  const [bindRollId, setBindRollId] = useState<string>('');
  const [newRollCode, setNewRollCode] = useState<string>('');
  const [pendingCreatedRollId, setPendingCreatedRollId] = useState<string>('');

  // Custom Settlement Modal State
  const [showQuickCompleteConfirm, setShowQuickCompleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [actualCutLenInput, setActualCutLenInput] = useState<number>(0);
  const [rejectedIds, setRejectedIds] = useState<Set<number>>(new Set());
  const [recoverRems, setRecoverRems] = useState<boolean>(true);
  const [remnantLoc, setRemnantLoc] = useState<string>('裁床余料架 A-01');

  // 同缸加急补片单弹窗状态
  const [showReplenishModal, setShowReplenishModal] = useState(false);
  const [replenishOperator, setReplenishOperator] = useState('排产计划员');
  const [replenishReason, setReplenishReason] = useState('判废/缺口同缸加急补片');
  const [createdReplenishTask, setCreatedReplenishTask] = useState<{ id: string; name?: string } | null>(null);

  // 报工冲销弹窗状态
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState('');

  // Print Ticket Modal State
  const [showTicketModal, setShowTicketModal] = useState(false);

  const canvasRef = useRef<any>(null);
  const scanRef = useRef<HTMLInputElement | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const q = taskIdQuery ? `?taskId=${encodeURIComponent(taskIdQuery)}` : '';
      const [list, allRolls, demandPool] = await Promise.all([
        requestJSON('/api/v2/schemes' + q),
        requestJSON('/api/rolls').catch(() => []),
        requestJSON('/api/v2/demand-pool').catch(() => [])
      ]);
      const arr = Array.isArray(list) ? list : [];
      setEntries(arr);
      setRolls(Array.isArray(allRolls) ? allRolls : []);
      const openMap: Record<string, number> = {};
      if (Array.isArray(demandPool)) {
        for (const fam of demandPool) {
          if (fam?.id) openMap[fam.id] = Number(fam.openTotal) || 0;
        }
      }
      setTaskOpenMap(openMap);
      if (schemeId && arr.some((x) => x.scheme?.id === schemeId)) {
        setSelectedId(schemeId);
      } else if (!selectedId && arr.length > 0) {
        setSelectedId(arr[0].scheme.id);
      }
    } catch (err: any) {
      toast('读取结果管理列表失败：' + err.message, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        scanRef.current?.focus();
        scanRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleScanWorkOrder = (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = scanInput.trim();
    if (!raw) return;
    const hit = matchScannedScheme(entries, raw);
    if (!hit) {
      toast(`未找到与「${raw}」匹配的工单号、方案号或母卷号`, true);
      return;
    }
    setStateFilter('ALL');
    setSearch('');
    setSelectedId(hit.scheme.id);
    toast(
      `扫码定位成功：工单 WO-${hit.scheme.id}${hit.scheme.rollId ? ` · 母卷 ${hit.scheme.rollId}` : ''}`
    );
    setScanInput('');
  };

  useEffect(() => {
    loadAll();
  }, [schemeId, taskIdQuery]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (stateFilter !== 'ALL' && e.scheme?.state !== stateFilter) return false;
      if (!q) return true;
      const s = e.scheme || {};
      return `${s.id || ''} ${s.title || ''} ${s.taskName || ''} ${s.materialModel || ''} ${s.rollId || ''} ${s.externalOrderNo || ''}`
        .toLowerCase()
        .includes(q);
    });
  }, [entries, stateFilter, search]);

  const activeEntry = useMemo(
    () =>
      filteredEntries.find((e) => e.scheme?.id === selectedId) ||
      entries.find((e) => e.scheme?.id === selectedId) ||
      filteredEntries[0] ||
      null,
    [filteredEntries, entries, selectedId]
  );

  const activeScheme = activeEntry?.scheme || null;

  // Sync matching rolls when activeScheme changes
  const matchingPassedRolls = useMemo(() => {
    if (!activeScheme) return [];
    return rolls.filter(
      (r) =>
        r.inspectionStatus === 'PASSED' &&
        Math.abs(r.width - activeScheme.widthMm) <= 1.0 &&
        (r.currentRemainingLength ?? r.totalLength) >= activeScheme.occupiedLengthMm
    );
  }, [rolls, activeScheme]);

  const matchingPendingRolls = useMemo(() => {
    if (!activeScheme) return [];
    return rolls.filter(
      (r) =>
        r.inspectionStatus === 'PENDING' &&
        Math.abs(r.width - activeScheme.widthMm) <= 1.0 &&
        (r.currentRemainingLength ?? r.totalLength) >= activeScheme.occupiedLengthMm
    );
  }, [rolls, activeScheme]);

  useEffect(() => {
    setPendingCreatedRollId('');
    setShowReverseModal(false);
    setReverseReason('');
    setReverseError('');
  }, [activeScheme?.id]);

  useEffect(() => {
    if (matchingPassedRolls.length > 0) {
      setBindRollId((prev) =>
        matchingPassedRolls.some((r) => r.rollId === prev) ? prev : matchingPassedRolls[0].rollId
      );
    } else {
      setBindRollId('');
    }
    if (activeScheme) {
      setActualCutLenInput(activeScheme.occupiedLengthMm || 1000);
      setRejectedIds(new Set());
    }
  }, [activeScheme?.id, matchingPassedRolls.length]);

  const replayScene2D = useMemo(
    () =>
      activeScheme && activeScheme.dimension !== 'SLITTING_1D'
        ? buildReplayScene2D(activeScheme)
        : null,
    [activeScheme]
  );

  const boundRoll = useMemo(
    () => (activeScheme?.rollId ? rolls.find((r) => r.rollId === activeScheme.rollId) || null : null),
    [rolls, activeScheme?.rollId]
  );

  const ticketModel = useMemo(
    () =>
      activeScheme
        ? buildCutTicketModel(activeScheme, {
            cutOrigin: settings.startCorner,
            boundRoll
          })
        : null,
    [activeScheme, settings.startCorner, boundRoll]
  );

  // ==================== Actions: Bind Roll / Complete / Dispatch MES / Cancel ====================

  const handleBindStockRoll = async (autoCreate: boolean) => {
    if (!activeScheme || busy) return;
    setBusy(true);
    try {
      const updated = await requestJSON(
        `/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/bind-roll`,
        autoCreate
          ? {
              rollId: newRollCode.trim() || undefined,
              autoCreateRoll: true,
              storageLocation: '裁床线边备料区'
            }
          : {
              rollId: bindRollId,
              autoCreateRoll: false
            }
      );
      if (updated?.awaitingInspection || updated?.scheme?.state === 'AWAITING_ROLL') {
        const createdId =
          updated?.createdRoll?.rollId ||
          updated?.rollInfo?.rollId ||
          newRollCode.trim();
        if (createdId) setPendingCreatedRollId(createdId);
        toast(
          updated?.message ||
            `已按方案规格新建待检母卷 ${createdId || ''}（PENDING），请完成跑布验疵并质检放行后再执行锁卷绑定`
        );
      } else {
        setPendingCreatedRollId('');
        toast(
          `已成功锁卷绑定：${updated.scheme.rollId}（区间 Y=${fmtN(updated.scheme.windowStartY)}~${fmtN(updated.scheme.windowStartY + updated.scheme.occupiedLengthMm)}mm）`
        );
      }
      setNewRollCode('');
      await loadAll();
    } catch (err: any) {
      toast('绑定实卷失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteScheme = async (customMode = false) => {
    if (!activeScheme || busy) return;
    setBusy(true);
    try {
      const rejectedList = customMode ? [...rejectedIds] : [];
      const effRecover = customMode ? recoverRems : true;
      const effRemLoc = customMode ? remnantLoc : '裁床余料架 A-01';
      const completeBody = customMode
        ? {
            actualCutLenMm: actualCutLenInput,
            rejectedPieceIds: rejectedList,
            recoverRemnants: effRecover,
            remnantLocation: effRemLoc,
            operator: '现场排料员'
          }
        : {
            recoverRemnants: effRecover,
            remnantLocation: effRemLoc,
            operator: '一键完工核销'
          };
      const idemKey = buildCompleteSchemeIdempotencyKey({
        schemeId: activeScheme.id,
        customMode,
        actualCutLenMm: customMode ? actualCutLenInput : undefined,
        rejectedPieceIds: rejectedList,
        recoverRemnants: effRecover,
        remnantLocation: effRemLoc
      });
      const res = await idempotentPost(
        `complete-${idemKey}`,
        `/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/complete`,
        completeBody
      );
      setShowCompleteModal(false);
      setShowQuickCompleteConfirm(false);
      const openRem = res.demandFamily?.openTotal ?? 0;
      toast(
        openRem > 0
          ? `完工已记账！库存与良品量已更新（产生异常缺口 ${openRem} 件已退回需求池待补排）`
          : '完工已记账！母卷切割区段、派生余料与订单良品履约已全部过账'
      );
      await loadAll();
    } catch (err: any) {
      toast('完工记账失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleCancelScheme = async () => {
    if (!activeScheme || busy) return;
    setBusy(true);
    try {
      await requestJSON(`/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/cancel`, {
        reason: '结果管理手动取消重排'
      });
      setShowCancelConfirm(false);
      toast('方案已作废，母卷预占已释放，待排需求量已恢复');
      await loadAll();
    } catch (err: any) {
      toast('作废失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchMes = async () => {
    if (!activeScheme || busy) return;
    setBusy(true);
    try {
      const pkg = await requestJSON(
        `/api/v2/mes/schemes/${encodeURIComponent(activeScheme.id)}/dispatch`,
        { mesWorkOrderNo: activeScheme.externalOrderNo || `MES-${activeScheme.id}` }
      );
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: 'application/json;charset=utf-8'
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `MES派工指令包-${activeScheme.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`已下发 MES 工单「${pkg.mesWorkOrderNo}」并导出标准派工载荷 JSON`);
      await loadAll();
    } catch (err: any) {
      toast('下发 MES 失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateReplenishTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeScheme || busy) return;
    if (!replenishOperator.trim() || !replenishReason.trim()) {
      toast('请填写经办人与补片原因', true);
      return;
    }
    setBusy(true);
    try {
      const res = await idempotentJsonPost(
        `replenish-${activeScheme.id}`,
        `/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/replenish-task`,
        {
          operator: replenishOperator.trim(),
          reason: replenishReason.trim()
        }
      );
      const taskId = res?.task?.id || '';
      const taskName = res?.task?.name || '';
      setCreatedReplenishTask(taskId ? { id: taskId, name: taskName } : null);
      setShowReplenishModal(false);
      toast(
        taskId
          ? `已生成同缸加急补片任务「${taskName || taskId}」（URGENT · 同缸强约束）`
          : '同缸加急补片任务已生成'
      );
      await loadAll();
    } catch (err: any) {
      toast('生成同缸加急补片单失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const schemeReversal = useMemo(
    () => evaluateSchemeReversalEligibility(activeEntry),
    [activeEntry]
  );

  const handleOpenReverseModal = () => {
    if (!schemeReversal.eligible) {
      toast(schemeReversal.reason || '当前方案不支持报工冲销', true);
      return;
    }
    setReverseReason('');
    setReverseError('');
    setShowReverseModal(true);
  };

  const handleReverseScheme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeScheme || busy) return;
    if (!schemeReversal.eligible || schemeReversal.targetPlanIds.length === 0) {
      const msg = schemeReversal.reason || '当前方案不存在可冲销的报工回执';
      setReverseError(msg);
      toast(msg, true);
      return;
    }
    const validation = validateReversalReason(reverseReason);
    if (!validation.valid) {
      setReverseError(validation.error || '请填写有效的冲销原因');
      toast(validation.error || '请填写冲销原因', true);
      return;
    }
    setBusy(true);
    setReverseError('');
    let reversedCount = 0;
    try {
      for (const planId of schemeReversal.targetPlanIds) {
        const req = buildReversalRequest(planId, validation.trimmed);
        await requestJSON(req.url, req.body);
        reversedCount += 1;
      }
      setShowReverseModal(false);
      setReverseReason('');
      toast(
        reversedCount > 1
          ? `已按逆序冲销 ${reversedCount} 笔完工报工：母卷消耗与订单完成量已回滚，方案已置为已冲销释放`
          : '报工已冲销：母卷/料头消耗与订单完成量已回滚，方案状态已置为已冲销释放'
      );
      await loadAll();
    } catch (err: any) {
      const msg = err?.message || '冲销报工请求失败';
      setReverseError(msg);
      toast('冲销报工失败：' + msg, true);
      if (reversedCount > 0) {
        await loadAll();
      }
    } finally {
      setBusy(false);
    }
  };

  // ==================== Exports: DXF / G-Code / Slitting CSV / Excel / A4 Ticket ====================

  const handleExport2DCam = (kind: 'dxf' | 'nc') => {
    if (!activeScheme?.layout2D?.placements?.length) return;
    const mappedPieces = activeScheme.layout2D.placements.map((p: any) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      w: p.shape?.width || p.w,
      l: p.shape?.height || p.l,
      shape: p.shape
    }));
    const windowDefects = extractWindowDefects(activeScheme, boundRoll);
    const data = {
      rollId: activeScheme.rollId || 'VIRTUAL-ROLL',
      rollW: activeScheme.widthMm,
      bedL: activeScheme.occupiedLengthMm,
      windowStartY: activeScheme.windowStartY || 0,
      cutOrigin: settings.startCorner,
      pieces: mappedPieces,
      placements: mappedPieces,
      remnants: activeScheme.layout2D.leftovers || [],
      defects: windowDefects,
      cuts: (activeScheme.layout2D.cuts || []).map((c: any) => ({
        step: c.sequence,
        type: c.kind === 'HORIZONTAL' ? '横切' : '纵切',
        startX: c.startX,
        startY: c.startY,
        endX: c.endX,
        endY: c.endY
      }))
    };
    const content = kind === 'nc' ? gcodeText(data, extractCncPostOptions(settings)) : dxfText(data);
    const blob = new Blob([content], {
      type: kind === 'nc' ? 'text/plain;charset=utf-8' : 'application/dxf'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${settings.exportPrefix || 'CutPlan'}-${activeScheme.id}-${activeScheme.widthMm}x${Math.round(activeScheme.occupiedLengthMm)}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleExportSlitCsv = () => {
    if (!activeScheme?.slitting1D?.patterns?.length) return;
    const csv = buildSlittingCsvText(activeScheme);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `分切机PLC排刀配方-${activeScheme.id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleExportExcelReport = async () => {
    if (!activeScheme) return;
    try {
      const XLSX = await loadSheetLib();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['排程方案号', activeScheme.id],
          ['方案标题', sanitizeSchemeTitle(activeScheme.title)],
          ['所属需求族', activeScheme.taskName],
          ['关联外部/MES单号', activeScheme.externalOrderNo || '—'],
          ['物料品号', activeScheme.materialModel],
          ['母卷投料状态', activeScheme.rollId ? `已锁实卷 ${activeScheme.rollId}` : `待备新母卷 (建议 W${activeScheme.widthMm}×L${activeScheme.suggestedRoll?.minLengthMm || activeScheme.occupiedLengthMm}mm)`],
          ['门幅 (mm)', activeScheme.widthMm],
          ['实占总长 (mm)', activeScheme.occupiedLengthMm],
          ['净材料利用率 (%)', activeScheme.utilizationPct],
          ['排入产出数', `${activeScheme.placedCount} / ${activeScheme.requestedCount}`]
        ]),
        '方案与备料总览'
      );

      if (activeScheme.dimension === 'SLITTING_1D' && activeScheme.slitting1D) {
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.aoa_to_sheet([
            ['组号', '卷长 mm', '车数', '排刀组合', '已用宽 mm', '余宽 mm'],
            ...activeScheme.slitting1D.patterns.map((p: any, i: number) => [
              i + 1,
              p.lengthMm,
              p.repetitions,
              p.stations.map((s: any) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
              p.usedWidthMm,
              p.spareWidthMm
            ])
          ]),
          '分切排刀明细'
        );
      } else if (activeScheme.layout2D?.placements) {
        XLSX.utils.book_append_sheet(
          book,
          XLSX.utils.aoa_to_sheet([
            ['件号', '部件名称', 'X坐标 mm', 'Y坐标 mm', '宽 mm', '长 mm', '旋转角°', '是否补片'],
            ...activeScheme.layout2D.placements.map((p: any) => [
              p.id,
              p.name,
              p.x,
              p.y,
              p.shape?.width || p.w,
              p.shape?.height || p.l,
              p.rotationDegrees || 0,
              p.gapFill ? '同款备片' : '正单件'
            ])
          ]),
          '裁片坐标清单'
        );
      }
      XLSX.writeFile(book, `排程结果报表-${activeScheme.id}.xlsx`);
    } catch (err: any) {
      toast('导出 Excel 失败：' + err.message, true);
    }
  };

  const countByState = (st: string) =>
    st === 'ALL' ? entries.length : entries.filter((e) => e.scheme?.state === st).length;

  const stateFilterOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部方案', count: entries.length },
      {
        value: 'AWAITING_ROLL',
        label: '待绑实卷',
        count: countByState('AWAITING_ROLL'),
        accent: 'amber'
      },
      {
        value: 'READY_TO_CUT',
        label: '已锁料待切',
        count: countByState('READY_TO_CUT'),
        accent: 'indigo'
      },
      {
        value: 'DISPATCHED_MES',
        label: '已下发 MES',
        count: countByState('DISPATCHED_MES')
      },
      {
        value: 'COMPLETED',
        label: '已完工记账',
        count: countByState('COMPLETED'),
        accent: 'emerald'
      },
      {
        value: 'REVERSED',
        label: '已冲销释放',
        count: countByState('REVERSED'),
        accent: 'amber'
      },
      {
        value: 'CANCELLED',
        label: '已作废释放',
        count: countByState('CANCELLED')
      }
    ],
    [entries]
  );

  const hasDetailPrimaryCta = Boolean(
    activeScheme && (activeEntry?.canComplete || activeEntry?.canBindRoll)
  );

  const canGenerateReplenish = Boolean(
    activeScheme &&
      activeScheme.state === 'COMPLETED' &&
      (!activeScheme.complete ||
        (activeScheme.placedCount ?? 0) < (activeScheme.requestedCount ?? 0) ||
        Number(activeScheme.rejectedCount || activeEntry?.rejectedCount || 0) > 0 ||
        Number(taskOpenMap[activeScheme.taskId] || 0) > 0 ||
        Boolean(activeEntry?.canReplenish))
  );

  return (
    <div className="react-page mp-res-page">
      <div className="mp-res-top no-print">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>结果管理</h1>
            <span className="mp-page-summary num">
              {entries.length} 个方案 · {countByState('AWAITING_ROLL')} 待绑实卷 ·{' '}
              {countByState('READY_TO_CUT')} 待切 · {countByState('COMPLETED')} 已完工
            </span>
          </div>
        </div>

        <div className="mp-filter-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <form
            onSubmit={handleScanWorkOrder}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 1 250px', minWidth: 190 }}
          >
            <input
              ref={scanRef}
              type="text"
              className="field num"
              style={{ height: 30, fontSize: 12, flex: 1, minWidth: 140 }}
              aria-label="扫码定位工单或母卷"
              placeholder="扫工单号 WO-xxx/母卷号 (Alt+S)"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
            />
            <button type="submit" className="btn sm" style={{ flex: 'none' }}>
              定位
            </button>
          </form>

          <div className="mp-search-wrap" style={{ minWidth: 160 }}>
            <span className="mp-search-ico" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <circle
                  cx="7.2"
                  cy="7.2"
                  r="4.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="m10.8 10.8 2.8 2.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <input
              type="search"
              className="mp-search-input"
              aria-label="搜索排程方案"
              placeholder="筛选方案号、标题、需求族、品号或实卷号"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {filteredEntries.length} / {entries.length}
          </span>

          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={loadAll}>
              刷新列表
            </button>
            <a className="mp-ghost-btn" href="#/reconciliation">
              复检补排与对账
            </a>
            <a
              className={hasDetailPrimaryCta || entries.length === 0 ? 'btn' : 'btn pri'}
              href="#/workbench"
            >
              返回搭切工作台
            </a>
          </div>
        </div>

        <div className="mp-res-seg-row">
          <SegmentedControl
            options={stateFilterOptions}
            value={stateFilter}
            onChange={(next) => setStateFilter(next)}
            ariaLabel="按方案状态筛选"
          />
          <span className="mp-toolbar-count">
            排程方案沉淀 · 虚拟卷转绑实卷 · 多格式导出与完工过账
          </span>
        </div>
      </div>

      {loading ? (
        <div className="mp-res-body-pad no-print">
          <div className="mp-empty-card">
            <div className="loading">正在读取排程结果台账…</div>
          </div>
        </div>
      ) : entries.length === 0 ? (
        <div className="mp-res-body-pad no-print">
          <div className="mp-empty-card">
            <strong>尚无已选定确认的排程结果</strong>
            <p>
              请在「搭切工作台」完成并行求解后，点击右侧「选定此方案」，选定后的方案将自动沉淀至此进行多格式导出、绑卷或完工过账。
            </p>
            <a className="btn pri" href="#/workbench">
              前往搭切工作台 →
            </a>
          </div>
        </div>
      ) : (
        <div className="mp-res-split no-print">
          {/* Left: Scheme Registry List Card */}
          <section className="mp-res-list-pane" aria-label="排程方案列表">
            <div className="mp-res-pane-head">
              <span>排程方案列表</span>
              <span className="mp-toolbar-count num">{filteredEntries.length} 项</span>
            </div>
            <div className="mp-res-list-scroll">
              {filteredEntries.length === 0 ? (
                <div className="mp-res-list-empty">
                  <span>当前筛选条件下暂无匹配方案</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setStateFilter('ALL');
                      setSearch('');
                    }}
                  >
                    重置筛选条件
                  </button>
                </div>
              ) : (
                filteredEntries.map((entry) => {
                  const s = entry.scheme;
                  const st = STATE_BADGE[s.state] || { label: s.state, cls: '' };
                  const isSelected = activeScheme?.id === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className="mp-res-item"
                      aria-selected={isSelected}
                      onClick={() => setSelectedId(s.id)}
                    >
                      <div className="mp-res-item-top">
                        <span className="mp-res-item-title">{sanitizeSchemeTitle(s.title)}</span>
                        <span className={`tag ${st.cls}`}>{st.label}</span>
                      </div>
                      <div className="mp-res-item-code-row">
                        <CodeBadge>{s.id}</CodeBadge>
                        <span className="mp-res-item-sub">
                          {s.taskName} · {s.materialModel}
                        </span>
                      </div>
                      <div className="mp-res-item-metrics num">
                        <span className="mp-res-pill ok">利用率 {s.utilizationPct}%</span>
                        <span className="mp-res-pill">
                          {s.dimension === 'SLITTING_1D'
                            ? `${s.slitting1D?.totalCars || 1} 车`
                            : `${s.widthMm}×${fmtN(s.occupiedLengthMm, 0)}mm`}
                        </span>
                        {s.rollId ? (
                          <span className="mp-res-pill run">实卷 {s.rollId}</span>
                        ) : (
                          <span className="mp-res-pill warn">新母卷待绑</span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Right: Active Scheme Detail + Roll Binding + Visual Replay */}
          <section className="mp-res-detail-pane" aria-label="方案详情与复盘">
            {activeScheme ? (
              <>
                {/* Header Summary + Lifecycle & Export Actions Card */}
                <div className="mp-res-detail-card">
                  <div className="mp-res-detail-head">
                    <div className="mp-res-detail-identity">
                      <div className="mp-res-detail-title-row">
                        <h2 className="mp-res-detail-title">{sanitizeSchemeTitle(activeScheme.title)}</h2>
                        <CodeBadge>{activeScheme.id}</CodeBadge>
                        <span
                          className={`tag ${STATE_BADGE[activeScheme.state]?.cls || ''}`}
                        >
                          {STATE_BADGE[activeScheme.state]?.label || activeScheme.state}
                        </span>
                        <span className="tag kind">
                          {activeScheme.dimension === 'SLITTING_1D'
                            ? '一维定长分切'
                            : activeScheme.dimension === 'CONTOUR_2D'
                            ? '二维异形排料'
                            : '二维矩形开料'}
                        </span>
                      </div>
                      <div className="mp-res-detail-subtitle num">
                        关联需求族「{activeScheme.taskName}」 · 创建于 {activeScheme.createdAt}
                      </div>
                    </div>

                    {/* Execution & Lifecycle Actions (Single Primary CTA) */}
                    <div className="mp-res-detail-actions">
                      {activeEntry.canComplete && (
                        <>
                          <button
                            type="button"
                            className="btn pri"
                            disabled={busy}
                            onClick={() => setShowQuickCompleteConfirm(true)}
                          >
                            一键完工记账
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={() => setShowCompleteModal(true)}
                          >
                            明细核销 (登记异常/余料)
                          </button>
                        </>
                      )}
                      {(activeScheme.state === 'READY_TO_CUT' ||
                        activeScheme.state === 'DISPATCHED_MES') && (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={handleDispatchMes}
                        >
                          {activeScheme.state === 'DISPATCHED_MES'
                            ? '重新导出 MES 派工包'
                            : '下发 MES 派工单'}
                        </button>
                      )}
                      {canGenerateReplenish && (
                        <button
                          type="button"
                          className="btn soft-accent"
                          disabled={busy}
                          onClick={() => setShowReplenishModal(true)}
                          title="按源方案母卷缸号/色号一键创建高优同缸加急补片任务"
                        >
                          一键生成同缸加急补片单
                        </button>
                      )}
                      {schemeReversal.showAction && (
                        <button
                          type="button"
                          className="mp-ghost-btn mp-btn-danger-ghost"
                          disabled={busy || !schemeReversal.eligible}
                          onClick={handleOpenReverseModal}
                          title={
                            schemeReversal.eligible
                              ? '冲销已完工报工，恢复母卷/料头消耗并回滚订单完成量'
                              : schemeReversal.reason
                          }
                        >
                          冲销报工
                        </button>
                      )}
                      {activeEntry.canCancel && (
                        <button
                          type="button"
                          className="mp-ghost-btn mp-btn-danger-ghost"
                          disabled={busy}
                          onClick={() => setShowCancelConfirm(true)}
                        >
                          作废并退回需求
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Tabular Spec Summary Strip */}
                  <div className="mp-res-spec-grid num">
                    <div className="mp-res-spec-cell">
                      <small>物料品号</small>
                      <b title={activeScheme.materialModel}>{activeScheme.materialModel}</b>
                    </div>
                    <div className="mp-res-spec-cell">
                      <small>门幅 × 实占总长</small>
                      <b>
                        {activeScheme.widthMm} × {fmtN(activeScheme.occupiedLengthMm, 1)} mm
                      </b>
                    </div>
                    <div className="mp-res-spec-cell">
                      <small>净材料利用率</small>
                      <b className="is-ok">{activeScheme.utilizationPct}%</b>
                    </div>
                    <div className="mp-res-spec-cell">
                      <small>排入产出</small>
                      <b>
                        {activeScheme.placedCount} / {activeScheme.requestedCount}
                      </b>
                    </div>
                    <div className="mp-res-spec-cell">
                      <small>母卷绑定状态</small>
                      {activeScheme.rollId ? (
                        <b
                          className="is-accent"
                          title={`实卷 ${activeScheme.rollId} (Y=${fmtN(activeScheme.windowStartY)}~${fmtN(activeScheme.windowStartY + activeScheme.occupiedLengthMm)} mm)`}
                        >
                          {activeScheme.rollId} · Y{fmtN(activeScheme.windowStartY, 0)}~
                          {fmtN(activeScheme.windowStartY + activeScheme.occupiedLengthMm, 0)}
                        </b>
                      ) : (
                        <b>待绑实卷</b>
                      )}
                    </div>
                  </div>

                  {/* Export Matrix Bar */}
                  <div className="mp-res-export-bar">
                    <span className="mp-res-export-label">结果交付与导出</span>
                    {activeScheme.dimension !== 'SLITTING_1D' ? (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => handleExport2DCam('dxf')}
                        >
                          导出 CAD DXF
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => handleExport2DCam('nc')}
                        >
                          导出 CNC G-Code (.nc)
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn sm" onClick={handleExportSlitCsv}>
                        导出分切机排刀配方 (.csv)
                      </button>
                    )}
                    <button type="button" className="btn sm" onClick={handleExportExcelReport}>
                      导出 Excel 用料与排程表
                    </button>
                    <button
                      type="button"
                      className="btn sm soft-accent"
                      onClick={() => setShowTicketModal(true)}
                    >
                      打印 A4 车间派工裁切单
                    </button>
                    {activeScheme.rollId && (
                      <a
                        className="mp-ghost-btn mp-ghost-sm"
                        href={`#/inventory?roll=${encodeURIComponent(activeScheme.rollId)}`}
                      >
                        在库存查看母卷切割区
                      </a>
                    )}
                  </div>
                  {createdReplenishTask && (
                    <div
                      style={{
                        marginTop: 8,
                        padding: '8px 10px',
                        borderRadius: 6,
                        background: 'rgba(16, 185, 129, 0.1)',
                        border: '1px solid rgba(5, 150, 105, 0.35)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        fontSize: 12
                      }}
                    >
                      <span>
                        <span className="tag ok" style={{ marginRight: 6 }}>补片单已生成</span>
                        同缸加急补片任务 <b className="num">{createdReplenishTask.name || createdReplenishTask.id}</b> 已加入需求池（URGENT · 同缸强约束）。
                      </span>
                      <a className="btn sm soft-accent" href="#/demand-library">
                        前往需求库排补片 →
                      </a>
                    </div>
                  )}
                </div>

                {/* Virtual Mother Roll -> Bind Real Stock Roll Card */}
                {activeEntry.canBindRoll && (
                  <div className="mp-res-bind-card">
                    <div className="mp-res-bind-head">
                      <span className="tag warn">待备料绑卷</span>
                      <span>
                        <strong>虚拟新母卷方案</strong> · 建议备料品号{' '}
                        <b className="num">{activeScheme.materialModel}</b>、净门幅{' '}
                        <b className="num">{activeScheme.widthMm} mm</b>、最小可用长度{' '}
                        <b className="num">
                          {fmtN(
                            activeScheme.suggestedRoll?.minLengthMm ||
                              activeScheme.occupiedLengthMm
                          )}{' '}
                          mm
                        </b>
                        。绑定真实母卷后即可一键完工核销或校验实卷疵点。
                      </span>
                    </div>
                    <div className="mp-res-bind-controls">
                      {matchingPassedRolls.length > 0 ? (
                        <>
                          <select
                            className="field mp-res-bind-select"
                            aria-label="选择在库合格母卷"
                            value={bindRollId}
                            onChange={(e) => setBindRollId(e.target.value)}
                          >
                            {matchingPassedRolls.map((r) => (
                              <option key={r.rollId} value={r.rollId}>
                                在库合格卷：{r.rollId} · {r.rollModel} (余{fmtM(r.currentRemainingLength)}m · 疵{(r.defects || []).length}处)
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn sm pri"
                            disabled={busy || !bindRollId}
                            onClick={() => handleBindStockRoll(false)}
                          >
                            绑定所选在库母卷并校验疵点
                          </button>
                          <span className="mp-toolbar-count">或</span>
                        </>
                      ) : (
                        <span className="mp-toolbar-count">
                          当前暂无同幅宽 ({activeScheme.widthMm}mm) 合格母卷，可直接按建议规格建档入库：
                        </span>
                      )}
                      <input
                        className="field num mp-res-bind-input"
                        style={{ height: 28 }}
                        placeholder="新母卷条码 (可留空自动生成)"
                        value={newRollCode}
                        onChange={(e) => setNewRollCode(e.target.value)}
                      />
                      <button
                        type="button"
                        className={`btn sm ${matchingPassedRolls.length > 0 ? 'soft-accent' : 'pri'}`}
                        disabled={busy}
                        onClick={() => handleBindStockRoll(true)}
                      >
                        ＋ 按方案规格新建待检母卷
                      </button>
                    </div>
                    {(pendingCreatedRollId || matchingPendingRolls.length > 0) && (() => {
                      const focusPendingId =
                        pendingCreatedRollId &&
                        rolls.some(
                          (r) => r.rollId === pendingCreatedRollId && r.inspectionStatus === 'PENDING'
                        )
                          ? pendingCreatedRollId
                          : matchingPendingRolls[0]?.rollId || pendingCreatedRollId;
                      if (!focusPendingId) return null;
                      return (
                        <div
                          className="mp-res-pending-roll-hint"
                          data-pending-roll-id={focusPendingId}
                          style={{
                            marginTop: 8,
                            padding: '8px 10px',
                            borderRadius: 6,
                            background: 'rgba(245, 158, 11, 0.1)',
                            border: '1px solid rgba(245, 158, 11, 0.35)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            flexWrap: 'wrap',
                            fontSize: 12
                          }}
                        >
                          <span>
                            <span className="tag warn" style={{ marginRight: 6 }}>待质检放行</span>
                            母卷 <b className="num">{focusPendingId}</b> 已按方案规格入库（状态 PENDING），须完成跑布验疵并质检放行后，再刷新并选择该合格卷执行锁卷绑定。
                          </span>
                          <a
                            className="mp-ghost-btn mp-ghost-sm"
                            href={`#/inspection/${encodeURIComponent(focusPendingId)}`}
                          >
                            前往跑布验疵放行 →
                          </a>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Visual Diagram Replay (2D Dark Charcoal CAD Viewport or 1D Strip Bars Card) */}
                {activeScheme.dimension !== 'SLITTING_1D' && replayScene2D ? (
                  <div className="mp-res-cad-card">
                    <div className="ctool">
                      <span style={{ fontSize: 12, fontWeight: 600 }}>1:1 排料图纸与走刀复盘</span>
                      <span className="div" />
                      <button type="button" onClick={() => canvasRef.current?.fit()}>
                        居中适配
                      </button>
                      <button
                        type="button"
                        aria-pressed={!vertical}
                        onClick={() => setVertical((v) => !v)}
                      >
                        {vertical ? '竖排' : '横排'}
                      </button>
                      <button
                        type="button"
                        aria-pressed={showPath}
                        onClick={() => setShowPath((s) => !s)}
                      >
                        切割刀路
                      </button>
                      <span className="sp" />
                      <span className="num ctool-readout">
                        排入 {activeScheme.placedCount} 件 · 净面积 {activeScheme.pieceAreaM2} m²
                      </span>
                    </div>
                    <div className="mp-res-cad-viewport">
                      <CadCanvasView
                        scene={replayScene2D}
                        vertical={vertical}
                        showPath={showPath}
                        showDimensions={true}
                        canvasRefOut={canvasRef}
                      />
                    </div>
                  </div>
                ) : activeScheme.slitting1D ? (
                  <div className="mp-res-slit-card">
                    <div className="mp-res-pane-head">
                      <span>一维分切刀组与订单履约明细</span>
                      <span className="mp-toolbar-count num">
                        共 {activeScheme.slitting1D.totalCars} 车
                      </span>
                    </div>
                    <div className="slit-patterns-list">
                      {(() => {
                        const allWidths: number[] = [];
                        for (const pat of activeScheme.slitting1D.patterns || []) {
                          for (const st of pat.stations || []) {
                            if (st.widthMm > 0) allWidths.push(st.widthMm);
                          }
                        }
                        const minW = allWidths.length ? Math.min(...allWidths) : 0;
                        const maxW = allWidths.length ? Math.max(...allWidths) : 0;
                        return activeScheme.slitting1D.patterns.map((p: any, idx: number) => (
                          <div key={p.id || idx} className="slit-pattern-row">
                            <div className="slit-pattern-meta">
                              <span className="tag kind">组 {idx + 1}</span>
                              <b className="num">{p.repetitions} 车</b>
                              <span className="num">
                                {p.stations
                                  .map((s: any) => `${s.widthMm}×${s.countPerRepetition}`)
                                  .join(' + ')}
                              </span>
                              <span className="sp" />
                              <span className="num muted">
                                已切 {p.usedWidthMm} mm · 余 {p.spareWidthMm} mm
                              </span>
                            </div>
                            <SlittingStripBar
                              motherWidthMm={activeScheme.widthMm}
                              leftTrimMm={activeScheme.slitting1D.leftTrimMm}
                              rightTrimMm={activeScheme.slitting1D.rightTrimMm}
                              stations={p.stations}
                              minWidthMm={minW}
                              maxWidthMm={maxW}
                            />
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      )}

      {/* Detailed Completion & Scrap Modal */}
      <ModalDialog
        open={showCompleteModal}
        title="实切完工核销登记（支持实切长度微调、异常废片剔除与余料入库）"
        onClose={() => setShowCompleteModal(false)}
        maxWidth={680}
      >
        {activeScheme && (
          <div>
            <div className="form" style={{ gridTemplateColumns: '130px 1fr', padding: '4px 0 12px' }}>
              <label>绑定母卷 / 料头</label>
              <div className="num" style={{ fontWeight: 600 }}>
                <CodeBadge>{activeScheme.rollId || activeScheme.remnantId}</CodeBadge>
              </div>
              {activeScheme.dimension !== 'SLITTING_1D' && !activeScheme.remnantId && (
                <>
                  <label>实切耗用长度 mm</label>
                  <NumberInput
                    className="field num"
                    min={0}
                    value={actualCutLenInput}
                    onValueChange={setActualCutLenInput}
                  />
                </>
              )}
              <label>余料自动入库</label>
              <label className="mp-modal-switch-row">
                <input
                  type="checkbox"
                  className="ux-switch"
                  checked={recoverRems}
                  onChange={(e) => setRecoverRems(e.target.checked)}
                />
                <span>将满足最小回收尺寸的预计余料自动登记入库</span>
              </label>
              <label>余料存放库位</label>
              <input
                className="field"
                value={remnantLoc}
                onChange={(e) => setRemnantLoc(e.target.value)}
              />
            </div>

            {activeScheme.layout2D?.placements?.length > 0 && (
              <>
                <div className="sec" style={{ margin: '0 -16px 8px' }}>
                  逐件质检结果（默认全部合格；若切坏勾选判废，缺口将自动退回需求池补排）
                </div>
                <div className="mp-modal-table-box">
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>件号</th>
                          <th>名称</th>
                          <th className="r">尺寸 mm</th>
                          <th>当场判废</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeScheme.layout2D.placements.map((p: any) => {
                          const isRej = rejectedIds.has(p.id);
                          return (
                            <tr key={p.id}>
                              <td className="num">#{p.id}</td>
                              <td>{p.name}</td>
                              <td className="r num">
                                {fmtN(p.shape?.width || p.w)} × {fmtN(p.shape?.height || p.l)}
                              </td>
                              <td>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                  <input
                                    type="checkbox"
                                    checked={isRej}
                                    onChange={(e) => {
                                      const next = new Set(rejectedIds);
                                      if (e.target.checked) next.add(p.id);
                                      else next.delete(p.id);
                                      setRejectedIds(next);
                                    }}
                                  />
                                  <span style={{ color: isRej ? 'var(--err)' : 'var(--ok)' }}>
                                    {isRej ? '异常报废' : '合格'}
                                  </span>
                                </label>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn" onClick={() => setShowCompleteModal(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn pri"
                disabled={busy}
                onClick={() => handleCompleteScheme(true)}
              >
                确认过账记账
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* One-Click Completion Summary Confirmation Modal */}
      <ModalDialog
        open={showQuickCompleteConfirm}
        title="确认一键完工记账"
        onClose={() => setShowQuickCompleteConfirm(false)}
        maxWidth={520}
      >
        {activeScheme && (
          <div>
            <p style={{ margin: '0 0 12px', fontSize: 13 }}>
              请核对本次完工过账摘要。确认后将正式扣减材料库存并结转需求族良品完成量：
            </p>
            <div
              className="form num"
              style={{
                gridTemplateColumns: '124px 1fr',
                padding: '10px 12px',
                background: 'var(--panel-2)',
                borderRadius: 8,
                border: '1px solid var(--line-2)',
                marginBottom: 14
              }}
            >
              <label>排程方案号</label>
              <b>{activeScheme.id}</b>
              <label>领用母卷 / 料头</label>
              <b>{activeScheme.remnantId ? `料头 ${activeScheme.remnantId}` : activeScheme.rollId || '未绑定'}</b>
              <label>实切消耗</label>
              <b>
                {activeScheme.remnantId
                  ? `整块料头 (${activeScheme.widthMm} × ${fmtN(activeScheme.occupiedLengthMm, 1)} mm)`
                  : activeScheme.dimension === 'SLITTING_1D' && activeScheme.slitting1D
                  ? `${activeScheme.slitting1D.totalCars} 车 · 共 ${fmtN(activeScheme.occupiedLengthMm, 1)} mm`
                  : `${fmtN(activeScheme.occupiedLengthMm, 1)} mm (Y=${fmtN(activeScheme.windowStartY || 0, 0)}~${fmtN((activeScheme.windowStartY || 0) + activeScheme.occupiedLengthMm, 0)})`}
              </b>
              <label>预计合格产出</label>
              <b>
                {activeScheme.placedCount}{' '}
                {activeScheme.dimension === 'SLITTING_1D' ? '卷' : '件'}
              </b>
              <label>派生余料处理</label>
              <span>自动回收达标余料至「裁床余料架 A-01」</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setShowQuickCompleteConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn pri"
                disabled={busy}
                onClick={() => handleCompleteScheme(false)}
              >
                {busy ? '过账中…' : '确认一键完工记账'}
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Cancel Scheme Confirmation Modal */}
      <ModalDialog
        open={showCancelConfirm}
        title="确认作废排程方案"
        onClose={() => setShowCancelConfirm(false)}
        maxWidth={460}
      >
        {activeScheme && (
          <div>
            <p style={{ margin: '0 0 14px', fontSize: 13 }}>
              确认作废方案「<b>{activeScheme.id}</b>」并将预占需求退回待排需求池吗？作废后将释放关联母卷或料头的预占区段。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setShowCancelConfirm(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn pri"
                disabled={busy}
                onClick={handleCancelScheme}
              >
                {busy ? '处理中…' : '确认作废'}
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Clean A4 Shop-Floor Cut Ticket Modal & Print Surface */}
      <ModalDialog
        open={showTicketModal}
        title="车间 A4 随工派工裁切单预览"
        onClose={() => setShowTicketModal(false)}
        maxWidth={820}
      >
        {activeScheme && ticketModel && (
          <div className="print-ticket-sheet">
            <header
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 12,
                borderBottom: '2px solid #0f172a',
                paddingBottom: 10,
                marginBottom: 10
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>CutPlan 车间生产裁切派工单</h2>
                <div className="muted" style={{ fontSize: 12 }}>
                  需求族：{activeScheme.taskName} · 外部单号：{activeScheme.externalOrderNo || '内部排产'}
                </div>
                <div style={{ fontSize: 11.5, marginTop: 4 }} className="num">
                  工单号：<b>{ticketModel.workOrderNo}</b> · 方案号：{activeScheme.id} · 打印时间：
                  {new Date().toLocaleString('zh-CN')}
                </div>
              </div>
              <div
                className="ticket-barcode-bar"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  flexShrink: 0
                }}
              >
                <BarcodeSvg
                  value={ticketModel.workOrderNo}
                  label="派工单号"
                  height={36}
                  moduleWidth={1.15}
                />
                {activeScheme.rollId && (
                  <BarcodeSvg
                    value={activeScheme.rollId}
                    label="领用母卷"
                    height={36}
                    moduleWidth={1.15}
                  />
                )}
              </div>
            </header>

            <div
              className="ticket-meta num"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8,
                padding: '8px 10px',
                border: '1px solid #cbd5e1',
                marginBottom: 12,
                fontSize: 12
              }}
            >
              <div>
                物料品号：<b>{activeScheme.materialModel}</b>
              </div>
              <div>
                领用母卷：<b>{activeScheme.rollId || '按建议新母卷领料'}</b>
              </div>
              <div>
                幅宽×用长：<b>{activeScheme.widthMm} × {fmtN(activeScheme.occupiedLengthMm, 1)} mm</b>
              </div>
              <div>
                预计利用率：<b>{activeScheme.utilizationPct}%</b>
              </div>
            </div>

            {ticketModel.placements.length > 0 && (
              <div className="ticket-diagram" style={{ marginBottom: 12 }}>
                <svg
                  viewBox={ticketModel.viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={`排料示意图 ${ticketModel.workOrderNo}`}
                  style={{
                    width: '100%',
                    height: 'auto',
                    maxHeight: 280,
                    border: '1px solid #94a3b8',
                    background: '#f8fafc',
                    display: 'block'
                  }}
                >
                  <text
                    x={0}
                    y={ticketModel.headerY}
                    fontSize={ticketModel.headerFontSize}
                    fontWeight="700"
                    fill="#0f172a"
                  >
                    {ticketModel.workOrderNo} · {ticketModel.widthMm}×{fmtN(ticketModel.occupiedLengthMm, 1)}mm · 共 {ticketModel.placements.length} 件
                  </text>
                  <rect
                    x={0}
                    y={0}
                    width={ticketModel.widthMm}
                    height={ticketModel.occupiedLengthMm}
                    fill="#ffffff"
                    stroke="#0f172a"
                    strokeWidth={ticketModel.borderStroke}
                  />

                  {/* 疵点禁入区标示 */}
                  {ticketModel.defects.map((d) => (
                    <g key={`def-${d.id}`}>
                      <rect
                        x={Math.max(0, d.x - d.margin)}
                        y={Math.max(0, d.y - d.margin)}
                        width={d.w + d.margin * 2}
                        height={d.h + d.margin * 2}
                        fill="rgba(239,68,68,0.14)"
                        stroke="#dc2626"
                        strokeWidth={ticketModel.pieceStroke}
                        strokeDasharray={`${ticketModel.borderStroke * 3} ${ticketModel.borderStroke * 2}`}
                      />
                      <text
                        x={d.x + d.w / 2}
                        y={d.y + d.h / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={Math.max(16, ticketModel.cutBadgeFontSize)}
                        fontWeight="700"
                        fill="#b91c1c"
                      >
                        疵#{d.id}
                      </text>
                    </g>
                  ))}

                  {/* 裁片轮廓 + 件号 + 尺寸标注 */}
                  {ticketModel.placements.map((p) => (
                    <g key={`p-${p.id}`}>
                      {p.pointsAttr ? (
                        <polygon
                          points={p.pointsAttr}
                          fill="rgba(2,132,199,0.14)"
                          stroke="#0284c7"
                          strokeWidth={ticketModel.pieceStroke}
                        />
                      ) : (
                        <rect
                          x={p.x}
                          y={p.y}
                          width={p.w}
                          height={p.h}
                          fill="rgba(2,132,199,0.14)"
                          stroke="#0284c7"
                          strokeWidth={ticketModel.pieceStroke}
                        />
                      )}
                      <text
                        x={p.cx}
                        y={p.showDimLabel ? p.cy - p.fontSize * 0.52 : p.cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={p.fontSize}
                        fontWeight="700"
                        fill="#0f172a"
                      >
                        {p.pieceLabel}
                      </text>
                      {p.showDimLabel && (
                        <text
                          x={p.cx}
                          y={p.cy + p.fontSize * 0.62}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={Math.max(12, Math.round(p.fontSize * 0.78))}
                          fill="#334155"
                        >
                          {p.dimLabel}
                        </text>
                      )}
                    </g>
                  ))}

                  {/* 贯通直刀刀路与刀序圆标 */}
                  {ticketModel.cuts.map((c, idx) => (
                    <g key={`cut-${idx}`}>
                      <line
                        x1={c.startX}
                        y1={c.startY}
                        x2={c.endX}
                        y2={c.endY}
                        stroke="#d97706"
                        strokeWidth={ticketModel.cutStroke}
                        strokeDasharray={`${ticketModel.borderStroke * 4} ${ticketModel.borderStroke * 2}`}
                      />
                      <circle
                        cx={c.labelX}
                        cy={c.labelY}
                        r={ticketModel.cutBadgeRadius}
                        fill="#ffffff"
                        stroke="#d97706"
                        strokeWidth={ticketModel.pieceStroke}
                      />
                      <text
                        x={c.labelX}
                        y={c.labelY}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fontSize={ticketModel.cutBadgeFontSize}
                        fontWeight="700"
                        fill="#b45309"
                      >
                        {c.sequence}
                      </text>
                    </g>
                  ))}

                  {/* 切割起点基准标示 */}
                  <g>
                    <circle
                      cx={ticketModel.originPoint.x}
                      cy={ticketModel.originPoint.y}
                      r={ticketModel.cutBadgeRadius * 0.85}
                      fill="#dc2626"
                      stroke="#ffffff"
                      strokeWidth={ticketModel.pieceStroke}
                    />
                    <text
                      x={
                        ticketModel.originPoint.x === 0
                          ? ticketModel.cutBadgeRadius * 1.3
                          : ticketModel.widthMm - ticketModel.cutBadgeRadius * 1.3
                      }
                      y={
                        ticketModel.originPoint.y === 0
                          ? ticketModel.cutBadgeRadius * 1.4
                          : ticketModel.occupiedLengthMm - ticketModel.cutBadgeRadius * 1.1
                      }
                      textAnchor={ticketModel.originPoint.x === 0 ? 'start' : 'end'}
                      fontSize={ticketModel.cutBadgeFontSize}
                      fontWeight="700"
                      fill="#dc2626"
                    >
                      {ticketModel.originPoint.label}
                    </text>
                  </g>
                </svg>
              </div>
            )}

            <div className="mp-table-scroll" style={{ marginBottom: 16 }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>部件 / 分条规格</th>
                    <th className="r">尺寸规格 mm</th>
                    <th className="r">计划产出</th>
                    <th>实切合格登记</th>
                    <th>异常/备注</th>
                  </tr>
                </thead>
                <tbody>
                  {activeScheme.dimension === 'SLITTING_1D' && activeScheme.slitting1D
                    ? activeScheme.slitting1D.fulfillment.map((f: any, i: number) => (
                        <tr key={i}>
                          <td className="num">{i + 1}</td>
                          <td>{f.name}</td>
                          <td className="r num">
                            {f.widthMm} × {activeScheme.slitting1D.fixedLengthMm}
                          </td>
                          <td className="r num">{f.produced} 卷</td>
                          <td>________</td>
                          <td>________</td>
                        </tr>
                      ))
                    : ticketModel.placements.map((p, i) => (
                        <tr key={`${p.id}-${i}`}>
                          <td className="num">{p.pieceLabel}</td>
                          <td>{p.name}</td>
                          <td className="r num">
                            {fmtN(p.w, 0)} × {fmtN(p.h, 0)}
                          </td>
                          <td className="r num">1 件</td>
                          <td>□ 合格</td>
                          <td />
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>

            {settings.ticketShowCuts && ticketModel.cuts.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
                  贯通直刀下刀顺序明细（共 {ticketModel.cuts.length} 刀）
                </div>
                <table className="t">
                  <thead>
                    <tr>
                      <th>刀序</th>
                      <th>方向</th>
                      <th className="r">起点坐标 (X, Y mm)</th>
                      <th className="r">终点坐标 (X, Y mm)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ticketModel.cuts.map((c, idx) => (
                      <tr key={idx}>
                        <td className="num">第 {c.sequence} 刀</td>
                        <td>{c.directionLabel}</td>
                        <td className="r num">
                          ({fmtN(c.startX, 1)}, {fmtN(c.startY, 1)})
                        </td>
                        <td className="r num">
                          ({fmtN(c.endX, 1)}, {fmtN(c.endY, 1)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div
              className="ticket-sign-row"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 16,
                paddingTop: 12,
                borderTop: '1px dashed #94a3b8',
                fontSize: 12
              }}
            >
              <div>领料确认签字：______________</div>
              <div>机台操作员签字：____________</div>
              <div>质检复核签字：______________</div>
            </div>

            <div
              className="no-print"
              style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}
            >
              <button type="button" className="btn" onClick={() => setShowTicketModal(false)}>
                关闭
              </button>
              <button type="button" className="btn pri" onClick={() => window.print()}>
                立即调用系统打印 / 导出 PDF
              </button>
            </div>
          </div>
        )}
      </ModalDialog>
      {/* 一键生成同缸加急补片单弹窗 */}
      <ModalDialog
        open={showReplenishModal}
        title="一键生成同缸加急补片单（防色差）"
        onClose={() => {
          if (!busy) setShowReplenishModal(false);
        }}
        maxWidth={520}
      >
        {activeScheme && (
          <form onSubmit={handleGenerateReplenishTask}>
            <p style={{ margin: '0 0 10px', fontSize: 12.5 }}>
              系统将按源方案的缺口/判废明细自动新建一张 <b>URGENT 加急</b> 且启用{' '}
              <b>同单同缸强约束</b> 的补片需求任务，自动继承原母卷品号与缸色属性：
            </p>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>源方案号</div>
              <div>{activeScheme.id}</div>
              <div>原实卷 / 缸号色号</div>
              <div>
                {activeScheme.rollId || '未绑定实卷'}
                {boundRoll?.batchNo ? ` · 缸:${boundRoll.batchNo}` : ''}
                {boundRoll?.color ? ` · ${boundRoll.color}` : ''}
              </div>
              <div>待补缺口提示</div>
              <div>
                方案产出 {activeScheme.placedCount}/{activeScheme.requestedCount} · 需求族剩余待排{' '}
                {taskOpenMap[activeScheme.taskId] ?? 0}
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
              <label htmlFor="rep-operator">经办人</label>
              <input
                id="rep-operator"
                className="field"
                required
                value={replenishOperator}
                onChange={(e) => setReplenishOperator(e.target.value)}
              />
              <label htmlFor="rep-reason">补片原因</label>
              <input
                id="rep-reason"
                className="field"
                required
                value={replenishReason}
                onChange={(e) => setReplenishReason(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setShowReplenishModal(false)}
              >
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在生成…' : '确认生成同缸补片单'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
      {/* 冲销完工报工弹窗 */}
      <ModalDialog
        open={showReverseModal}
        title="冲销完工报工（回滚母卷消耗与订单完成量）"
        onClose={() => {
          if (!busy) {
            setShowReverseModal(false);
            setReverseError('');
          }
        }}
        maxWidth={540}
      >
        {activeScheme && (
          <form onSubmit={handleReverseScheme}>
            <div
              role="alert"
              style={{
                borderLeft: '3px solid var(--err, #dc2626)',
                background: 'rgba(220, 38, 38, 0.08)',
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                color: 'var(--err, #991b1b)',
                marginBottom: 10
              }}
            >
              <strong>冲销边界说明：</strong>
              冲销后将恢复本次报工消耗的母卷/料头用量、作废本次派生余料、回滚对应订单完成量，并将方案状态置为{' '}
              <b>已冲销释放（REVERSED）</b>
              。若报工已存在复检处置、材料已有后续盘点/后续报工，或派生料头已流转，服务端将拒绝冲销。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>排程方案号</div>
              <div>{activeScheme.id}</div>
              <div>关联报工单号</div>
              <div>{schemeReversal.targetPlanIds.join('、') || '—'}</div>
              <div>领用母卷 / 料头</div>
              <div>
                {activeScheme.remnantId
                  ? `料头 ${activeScheme.remnantId}`
                  : activeScheme.rollId || '—'}
              </div>
              <div>已报产出</div>
              <div>
                {activeScheme.placedCount}{' '}
                {activeScheme.dimension === 'SLITTING_1D' ? '卷' : '件'} · 占长{' '}
                {fmtN(activeScheme.occupiedLengthMm, 1)} mm
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
              <label htmlFor="scheme-reverse-reason">冲销原因</label>
              <div>
                <textarea
                  id="scheme-reverse-reason"
                  className="field"
                  rows={3}
                  required
                  maxLength={MAX_REVERSAL_REASON_LENGTH}
                  placeholder="必填（1–500字），如：录入实切长度有误或错绑母卷需回滚重报"
                  value={reverseReason}
                  onChange={(e) => {
                    setReverseReason(e.target.value);
                    if (reverseError) setReverseError('');
                  }}
                  style={{ width: '100%', resize: 'vertical', minHeight: 68 }}
                />
                <div
                  className="muted num"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    marginTop: 4
                  }}
                >
                  <span>冲销操作将写入不可变过账流水（REPORT_REVERSE）</span>
                  <span>
                    {reverseReason.trim().length} / {MAX_REVERSAL_REASON_LENGTH}
                  </span>
                </div>
              </div>
            </div>
            {reverseError && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  padding: '6px 10px',
                  borderRadius: 4,
                  fontSize: 12,
                  background: 'rgba(220, 38, 38, 0.08)',
                  color: 'var(--err, #b91c1c)'
                }}
              >
                {reverseError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setShowReverseModal(false);
                  setReverseError('');
                }}
              >
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在冲销…' : '确认冲销报工'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </div>
  );
};
