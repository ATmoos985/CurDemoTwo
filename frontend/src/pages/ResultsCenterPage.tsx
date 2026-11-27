import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SegmentedControl, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { gcodeText, dxfText } from '../lib/domain/cam-format.js';
import { requestJSON, idempotentPost, toast, fmtN, loadSheetLib } from '../lib/core/util.js';
import { useStudioSettings } from '../store/selectors';
import { extractCncPostOptions } from '../store/studioSettings';
import { AuthSession, LOCAL_FALLBACK_SESSION, idempotentJsonPost } from '../utils/authClient';
import {
  ExportSlittingFormat,
  downloadSchemeSlittingExport,
  downloadSchemeTicketPdf,
  formatExportError
} from '../utils/exportApiClient';
import { buildCompleteSchemeIdempotencyKey } from './workbench/schemeConfirmUtils';
import {
  buildCutTicketModel,
  buildSlittingCsvText,
  extractWindowDefects,
  matchScannedScheme
} from './results/cutTicketUtils';
import {
  buildReversalRequest,
  evaluateSchemeReversalEligibility,
  validateReversalReason
} from './results/reportReversalUtils';
import {
  MAX_BATCH_ZIP_SCHEMES,
  buildReplayScene2D,
  sanitizeSchemeTitle
} from './results/resultsSceneUtils';
import { ResultsListPane } from './results/ResultsListPane';
import { ResultsDetailPanel } from './results/ResultsDetailPanel';
import { ResultsActionModals } from './results/ResultsActionModals';
import { ResultsCutTicketModal } from './results/ResultsCutTicketModal';
import { ResultsExportModals } from './results/ResultsExportModals';

export const ResultsCenterPage: React.FC<{
  schemeId?: string;
  taskIdQuery?: string;
  auth?: AuthSession;
}> = ({ schemeId, taskIdQuery, auth = LOCAL_FALLBACK_SESSION }) => {
  const settings = useStudioSettings();

  const [entries, setEntries] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [taskOpenMap, setTaskOpenMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [scanInput, setScanInput] = useState('');
  const [selectedId, setSelectedId] = useState<string>(schemeId || '');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [showPath, setShowPath] = useState(true);
  const [vertical, setVertical] = useState<boolean>(settings.vertical);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVertical(settings.vertical);
  }, [settings.vertical]);

  const [bindRollId, setBindRollId] = useState<string>('');
  const [newRollCode, setNewRollCode] = useState<string>('');
  const [pendingCreatedRollId, setPendingCreatedRollId] = useState<string>('');

  const [showQuickCompleteConfirm, setShowQuickCompleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [actualCutLenInput, setActualCutLenInput] = useState<number>(0);
  const [rejectedIds, setRejectedIds] = useState<Set<number>>(new Set());
  const [recoverRems, setRecoverRems] = useState<boolean>(true);
  const [remnantLoc, setRemnantLoc] = useState<string>('裁床余料架 A-01');

  const [showReplenishModal, setShowReplenishModal] = useState(false);
  const [replenishOperator, setReplenishOperator] = useState('排产计划员');
  const [replenishReason, setReplenishReason] = useState('判废/缺口同缸加急补片');
  const [createdReplenishTask, setCreatedReplenishTask] = useState<{ id: string; name?: string } | null>(null);

  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState('');
  const [showTicketModal, setShowTicketModal] = useState(false);

  // 生产级服务端导出弹窗与状态
  const [camModalOpen, setCamModalOpen] = useState(false);
  const [batchZipModalOpen, setBatchZipModalOpen] = useState(false);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [slitExportFormat, setSlitExportFormat] = useState<ExportSlittingFormat>('xlsx');
  const [exportError, setExportError] = useState<{
    title: string;
    message: string;
    status?: number;
    traceId?: string;
  } | null>(null);

  const canvasRef = useRef<any>(null);
  const scanRef = useRef<HTMLInputElement | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const q = taskIdQuery ? `?taskId=${encodeURIComponent(taskIdQuery)}` : '';
      const [list, allRolls, demandPool] = await Promise.all([
        requestJSON('/api/v2/schemes' + q),
        requestJSON('/api/v2/rolls').catch(() => []),
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
    toast(`扫码定位成功：工单 WO-${hit.scheme.id}${hit.scheme.rollId ? ` · 母卷 ${hit.scheme.rollId}` : ''}`);
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
    setExportError(null);
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
    () => (activeScheme && activeScheme.dimension !== 'SLITTING_1D' ? buildReplayScene2D(activeScheme) : null),
    [activeScheme]
  );

  const boundRoll = useMemo(
    () => (activeScheme?.rollId ? rolls.find((r) => r.rollId === activeScheme.rollId) || null : null),
    [rolls, activeScheme?.rollId]
  );

  const ticketModel = useMemo(
    () => (activeScheme ? buildCutTicketModel(activeScheme, { cutOrigin: settings.startCorner, boundRoll }) : null),
    [activeScheme, settings.startCorner, boundRoll]
  );

  const handleBindStockRoll = async (autoCreate: boolean) => {
    if (!activeScheme || busy) return;
    setBusy(true);
    try {
      const updated = await requestJSON(`/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/bind-roll`, autoCreate
        ? { rollId: newRollCode.trim() || undefined, autoCreateRoll: true, storageLocation: '裁床线边备料区' }
        : { rollId: bindRollId, autoCreateRoll: false });
      if (updated?.awaitingInspection || updated?.scheme?.state === 'AWAITING_ROLL') {
        const createdId = updated?.createdRoll?.rollId || updated?.rollInfo?.rollId || newRollCode.trim();
        if (createdId) setPendingCreatedRollId(createdId);
        toast(updated?.message || `已按方案规格新建待检母卷 ${createdId || ''}（PENDING），请先验疵放行`);
      } else {
        setPendingCreatedRollId('');
        toast(
          `已成功锁卷绑定：${updated.scheme.rollId}（区间 Y=${fmtN(updated.scheme.windowStartY)}~${fmtN(
            updated.scheme.windowStartY + updated.scheme.occupiedLengthMm
          )}mm）`
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
        : { recoverRemnants: effRecover, remnantLocation: effRemLoc, operator: '一键完工核销' };
      const idemKey = buildCompleteSchemeIdempotencyKey({
        schemeId: activeScheme.id,
        customMode,
        actualCutLenMm: customMode ? actualCutLenInput : undefined,
        rejectedPieceIds: rejectedList,
        recoverRemnants: effRecover,
        remnantLocation: effRemLoc
      });
      const res = await idempotentPost(`complete-${idemKey}`, `/api/v2/schemes/${encodeURIComponent(activeScheme.id)}/complete`, completeBody);
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
      const pkg = await requestJSON(`/api/v2/mes/schemes/${encodeURIComponent(activeScheme.id)}/dispatch`, {
        mesWorkOrderNo: activeScheme.externalOrderNo || `MES-${activeScheme.id}`
      });
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
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
        { operator: replenishOperator.trim(), reason: replenishReason.trim() }
      );
      const taskId = res?.task?.id || '';
      const taskName = res?.task?.name || '';
      setCreatedReplenishTask(taskId ? { id: taskId, name: taskName } : null);
      setShowReplenishModal(false);
      toast(taskId ? `已生成同缸加急补片任务「${taskName || taskId}」（URGENT · 同缸强约束）` : '同缸加急补片任务已生成');
      await loadAll();
    } catch (err: any) {
      toast('生成同缸加急补片单失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const schemeReversal = useMemo(() => evaluateSchemeReversalEligibility(activeEntry), [activeEntry]);

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
      if (reversedCount > 0) await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const handleExport2DCamLocal = (kind: 'dxf' | 'nc') => {
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
    const data = {
      rollId: activeScheme.rollId || 'VIRTUAL-ROLL',
      rollW: activeScheme.widthMm,
      bedL: activeScheme.occupiedLengthMm,
      windowStartY: activeScheme.windowStartY || 0,
      cutOrigin: settings.startCorner,
      pieces: mappedPieces,
      placements: mappedPieces,
      remnants: activeScheme.layout2D.leftovers || [],
      defects: extractWindowDefects(activeScheme, boundRoll),
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
    const blob = new Blob([content], { type: kind === 'nc' ? 'text/plain;charset=utf-8' : 'application/dxf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${settings.exportPrefix || 'CutPlan'}-${activeScheme.id}-${activeScheme.widthMm}x${Math.round(
      activeScheme.occupiedLengthMm
    )}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleExportSlitLocalCsv = () => {
    if (!activeScheme?.slitting1D?.patterns?.length) return;
    const csv = buildSlittingCsvText(activeScheme);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `分切机PLC排刀配方-${activeScheme.id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleExportExcelLocal = async () => {
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
          ['物料品号', activeScheme.materialModel],
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

  const handleDownloadSlittingServer = async () => {
    if (!activeScheme || busy) return;
    setBusy(true);
    setExportError(null);
    try {
      const res = await downloadSchemeSlittingExport(activeScheme.id, slitExportFormat);
      toast(`已下载服务端分切配方：${res.fileName}`);
    } catch (err) {
      setExportError(formatExportError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadTicketPdfServer = async () => {
    if (!activeScheme || busy) return;
    setBusy(true);
    setExportError(null);
    try {
      const res = await downloadSchemeTicketPdf(activeScheme.id);
      toast(`已下载随工单 PDF：${res.fileName}`);
    } catch (err) {
      setExportError(formatExportError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSchemeCheck = (id: string, checked: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        if (next.size >= MAX_BATCH_ZIP_SCHEMES) {
          toast(`单次批量 ZIP 最多选择 ${MAX_BATCH_ZIP_SCHEMES} 个方案`, true);
          return prev;
        }
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggleSelectAllVisible = () => {
    const capped = filteredEntries.slice(0, MAX_BATCH_ZIP_SCHEMES).map((e) => e.scheme.id);
    const allIn = capped.length > 0 && capped.every((id) => checkedIds.has(id));
    if (allIn) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(capped));
    }
  };

  const countByState = (st: string) =>
    st === 'ALL' ? entries.length : entries.filter((e) => e.scheme?.state === st).length;

  const stateFilterOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部方案', count: entries.length },
      { value: 'AWAITING_ROLL', label: '待绑实卷', count: countByState('AWAITING_ROLL'), accent: 'amber' },
      { value: 'READY_TO_CUT', label: '已锁料待切', count: countByState('READY_TO_CUT'), accent: 'indigo' },
      { value: 'DISPATCHED_MES', label: '已下发 MES', count: countByState('DISPATCHED_MES') },
      { value: 'COMPLETED', label: '已完工记账', count: countByState('COMPLETED'), accent: 'emerald' },
      { value: 'REVERSED', label: '已冲销释放', count: countByState('REVERSED'), accent: 'amber' },
      { value: 'CANCELLED', label: '已作废释放', count: countByState('CANCELLED') }
    ],
    [entries]
  );

  const hasDetailPrimaryCta = Boolean(activeScheme && (activeEntry?.canComplete || activeEntry?.canBindRoll));
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
                <circle cx="7.2" cy="7.2" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="m10.8 10.8 2.8 2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
            <button
              type="button"
              className="mp-ghost-btn"
              data-testid="res-open-summary-export-modal-btn"
              onClick={() => setSummaryModalOpen(true)}
            >
              生产汇总报表 (PDF / XLSX)
            </button>
            <button type="button" className="mp-ghost-btn" onClick={loadAll}>
              刷新列表
            </button>
            <a className="mp-ghost-btn" href="#/reconciliation">
              复检补排与对账
            </a>
            <a className={hasDetailPrimaryCta || entries.length === 0 ? 'btn' : 'btn pri'} href="#/workbench">
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
          <span className="mp-toolbar-count">排程方案沉淀 · 虚拟卷转绑实卷 · 多格式导出与完工过账</span>
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
            <p>请在「搭切工作台」完成并行求解后，点击右侧「选定此方案」，选定后的方案将自动沉淀至此进行多格式导出、绑卷或完工过账。</p>
            <a className="btn pri" href="#/workbench">
              前往搭切工作台 →
            </a>
          </div>
        </div>
      ) : (
        <div className="mp-res-split no-print">
          <ResultsListPane
            filteredEntries={filteredEntries}
            selectedId={activeScheme?.id || selectedId}
            onSelect={setSelectedId}
            checkedIds={checkedIds}
            onToggleCheck={toggleSchemeCheck}
            onToggleSelectAllVisible={handleToggleSelectAllVisible}
            onOpenBatchZipModal={() => setBatchZipModalOpen(true)}
            onResetFilters={() => {
              setStateFilter('ALL');
              setSearch('');
            }}
          />

          <section className="mp-res-detail-pane" aria-label="方案详情与复盘">
            <ResultsDetailPanel
              activeEntry={activeEntry}
              activeScheme={activeScheme}
              busy={busy}
              canGenerateReplenish={canGenerateReplenish}
              schemeReversal={schemeReversal}
              taskOpenMap={taskOpenMap}
              createdReplenishTask={createdReplenishTask}
              matchingPassedRolls={matchingPassedRolls}
              matchingPendingRolls={matchingPendingRolls}
              rolls={rolls}
              bindRollId={bindRollId}
              onSetBindRollId={setBindRollId}
              newRollCode={newRollCode}
              onSetNewRollCode={setNewRollCode}
              pendingCreatedRollId={pendingCreatedRollId}
              onOpenQuickComplete={() => setShowQuickCompleteConfirm(true)}
              onOpenCompleteModal={() => setShowCompleteModal(true)}
              onDispatchMes={handleDispatchMes}
              onOpenReplenishModal={() => setShowReplenishModal(true)}
              onOpenReverseModal={handleOpenReverseModal}
              onOpenCancelConfirm={() => setShowCancelConfirm(true)}
              onBindStockRoll={handleBindStockRoll}
              onExport2DCamLocal={handleExport2DCamLocal}
              onExportSlitLocalCsv={handleExportSlitLocalCsv}
              onExportExcelLocal={handleExportExcelLocal}
              onOpenCamExportModal={() => setCamModalOpen(true)}
              slitExportFormat={slitExportFormat}
              onSetSlitExportFormat={setSlitExportFormat}
              onDownloadSlittingServer={handleDownloadSlittingServer}
              onDownloadTicketPdfServer={handleDownloadTicketPdfServer}
              onOpenTicketModal={() => setShowTicketModal(true)}
              exportError={exportError}
              onDismissExportError={() => setExportError(null)}
              replayScene2D={replayScene2D}
              vertical={vertical}
              onToggleVertical={() => setVertical((v) => !v)}
              showPath={showPath}
              onToggleShowPath={() => setShowPath((s) => !s)}
              canvasRef={canvasRef}
            />
          </section>
        </div>
      )}

      <ResultsActionModals
        activeScheme={activeScheme}
        boundRoll={boundRoll}
        taskOpenMap={taskOpenMap}
        busy={busy}
        showCompleteModal={showCompleteModal}
        onCloseCompleteModal={() => setShowCompleteModal(false)}
        actualCutLenInput={actualCutLenInput}
        setActualCutLenInput={setActualCutLenInput}
        recoverRems={recoverRems}
        setRecoverRems={setRecoverRems}
        remnantLoc={remnantLoc}
        setRemnantLoc={setRemnantLoc}
        rejectedIds={rejectedIds}
        setRejectedIds={setRejectedIds}
        onCompleteScheme={handleCompleteScheme}
        showQuickCompleteConfirm={showQuickCompleteConfirm}
        onCloseQuickCompleteConfirm={() => setShowQuickCompleteConfirm(false)}
        showCancelConfirm={showCancelConfirm}
        onCloseCancelConfirm={() => setShowCancelConfirm(false)}
        onCancelScheme={handleCancelScheme}
        showReplenishModal={showReplenishModal}
        onCloseReplenishModal={() => setShowReplenishModal(false)}
        replenishOperator={replenishOperator}
        setReplenishOperator={setReplenishOperator}
        replenishReason={replenishReason}
        setReplenishReason={setReplenishReason}
        onGenerateReplenishTask={handleGenerateReplenishTask}
        showReverseModal={showReverseModal}
        onCloseReverseModal={() => setShowReverseModal(false)}
        schemeReversal={schemeReversal}
        reverseReason={reverseReason}
        setReverseReason={setReverseReason}
        reverseError={reverseError}
        clearReverseError={() => setReverseError('')}
        onReverseScheme={handleReverseScheme}
      />

      <ResultsCutTicketModal
        open={showTicketModal}
        onClose={() => setShowTicketModal(false)}
        activeScheme={activeScheme}
        ticketModel={ticketModel}
        ticketShowCuts={settings.ticketShowCuts}
      />

      <ResultsExportModals
        auth={auth}
        activeScheme={activeScheme}
        camModalOpen={camModalOpen}
        onCloseCamModal={() => setCamModalOpen(false)}
        batchZipModalOpen={batchZipModalOpen}
        onCloseBatchZipModal={() => setBatchZipModalOpen(false)}
        checkedSchemeIds={[...checkedIds]}
        summaryModalOpen={summaryModalOpen}
        onCloseSummaryModal={() => setSummaryModalOpen(false)}
        defaultTaskId={taskIdQuery}
      />
    </div>
  );
};
