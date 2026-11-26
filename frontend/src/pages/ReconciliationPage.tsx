import React, { useEffect, useMemo, useState } from 'react';
import {
  requestJSON,
  idempotentPost,
  pendingWrite,
  retryWrite,
  dropWrite,
  shortId,
  fmtN,
  toast,
  createUuid
} from '../lib/core/util.js';
import {
  reviewablePieces,
  effectivePieceResults,
  emptyQualityForm,
  qualityProblems,
  buildQualityCommand,
  receiptSummary,
  DISPOSITIONS
} from '../lib/model/quality.js';
import { ModalDialog } from '../components/ModalDialog';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { useStudioStore, DemandFamilySummary } from '../store/useStudioStore';
import { idempotentJsonPost } from '../utils/authClient';
import {
  NormalizedReconciliationReportRow,
  buildLedgerCsvText,
  isDispositionRevoked,
  normalizeReconciliationReportItem,
  readDispositionFields
} from './results/reconciliationUtils';
import {
  MAX_REVERSAL_REASON_LENGTH,
  buildReversalRequest,
  evaluateReportReversalEligibility,
  validateReversalReason
} from './results/reportReversalUtils';

const REPORT_PAGE_SIZE = 50;
const LEDGER_PAGE_SIZE = 100;

type PendingReconSlot = 'quality-disposition' | 'quality-revoke';
const PENDING_RECON_LABELS: Record<PendingReconSlot, string> = {
  'quality-disposition': '裁后复检处置',
  'quality-revoke': '复检处置撤销'
};

interface RevokeDraft {
  reportId: string;
  taskName: string;
  dispositionId: string;
  pieceId?: number | string;
  dispositionLabel: string;
  inspector?: string;
  origReason?: string;
  operator: string;
  reason: string;
}

interface ReverseReportDraft {
  reportId: string;
  taskName: string;
  materialLabel: string;
  actualCutLen: number;
  qualifiedCount: number;
  reason: string;
  error: string;
}

export const ReconciliationPage: React.FC = () => {
  const loadDemandFamilyIntoWorkbench = useStudioStore((s) => s.loadDemandFamilyIntoWorkbench);

  const [tab, setTab] = useState<'quality' | 'reconcile'>('quality');
  const [search, setSearch] = useState('');

  // 聚合报工分页状态（彻底消灭 N+1 请求风暴）
  const [reports, setReports] = useState<NormalizedReconciliationReportRow[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportOffset, setReportOffset] = useState(0);
  const [reportHasMore, setReportHasMore] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);

  // 对账快照与游标分页不可变流水
  const [recon, setRecon] = useState<any>(null);
  const [ledgerItems, setLedgerItems] = useState<any[]>([]);
  const [ledgerNextCursor, setLedgerNextCursor] = useState<number | string | null>(null);
  const [ledgerHasMore, setLedgerHasMore] = useState(false);
  const [loadingMoreLedger, setLoadingMoreLedger] = useState(false);

  const [loading, setLoading] = useState(true);
  const [qualityDraft, setQualityDraft] = useState<any>(null);
  const [revokeDraft, setRevokeDraft] = useState<RevokeDraft | null>(null);
  const [reverseDraft, setReverseDraft] = useState<ReverseReportDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  const loadReportsPage = async (offset: number) => {
    const page = await requestJSON(
      `/api/v2/reconciliation/reports?limit=${REPORT_PAGE_SIZE}&offset=${offset}`
    );
    const rawItems: any[] = Array.isArray(page?.items)
      ? page.items
      : Array.isArray(page)
      ? page
      : [];
    const normalized = rawItems
      .map(normalizeReconciliationReportItem)
      .filter((x): x is NormalizedReconciliationReportRow => Boolean(x))
      .filter((x) => x.report.status !== 'REVERSED');
    setReports(normalized);
    setReportTotal(typeof page?.total === 'number' ? page.total : normalized.length);
    setReportOffset(typeof page?.offset === 'number' ? page.offset : offset);
    setReportHasMore(Boolean(page?.hasMore));
  };

  const loadData = async (targetOffset = reportOffset) => {
    setLoading(true);
    try {
      const [, reconData, ledPage] = await Promise.all([
        loadReportsPage(targetOffset),
        requestJSON('/api/v2/inventory-ledger/reconciliation').catch(() => null),
        requestJSON(`/api/v2/inventory-ledger?limit=${LEDGER_PAGE_SIZE}&after=0`).catch(() => ({
          items: [],
          hasMore: false
        }))
      ]);
      const items: any[] = Array.isArray(ledPage?.items) ? ledPage.items : [];
      setRecon(reconData);
      setLedgerItems(items);
      const lastSeq = items.length ? items[items.length - 1]?.sequence : null;
      setLedgerNextCursor(ledPage?.nextCursor ?? lastSeq);
      setLedgerHasMore(Boolean(ledPage?.hasMore));
    } catch (err: any) {
      toast('读取复检与对账数据失败：' + err.message, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(0);
  }, []);

  const handlePageChange = async (nextOffset: number) => {
    if (nextOffset < 0 || loading) return;
    setLoading(true);
    try {
      await loadReportsPage(nextOffset);
    } catch (err: any) {
      toast('切换报工分页失败：' + err.message, true);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadMoreLedger = async () => {
    if (loadingMoreLedger || !ledgerHasMore || ledgerNextCursor === null || ledgerNextCursor === undefined) {
      return;
    }
    setLoadingMoreLedger(true);
    try {
      const ledPage = await requestJSON(
        `/api/v2/inventory-ledger?limit=${LEDGER_PAGE_SIZE}&after=${encodeURIComponent(
          String(ledgerNextCursor)
        )}`
      );
      const nextItems: any[] = Array.isArray(ledPage?.items) ? ledPage.items : [];
      setLedgerItems((prev) => {
        const seen = new Set(prev.map((x) => x.id ?? x.sequence));
        const merged = [...prev];
        for (const it of nextItems) {
          const key = it.id ?? it.sequence;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(it);
          }
        }
        return merged;
      });
      const tailSeq = nextItems.length ? nextItems[nextItems.length - 1]?.sequence : ledgerNextCursor;
      setLedgerNextCursor(ledPage?.nextCursor ?? tailSeq);
      setLedgerHasMore(Boolean(ledPage?.hasMore) && nextItems.length > 0);
    } catch (err: any) {
      toast('加载更多流水失败：' + err.message, true);
    } finally {
      setLoadingMoreLedger(false);
    }
  };

  const pendingSlots = useMemo(() => {
    void pendingTick;
    return (['quality-disposition', 'quality-revoke'] as const)
      .map((s) => [s, pendingWrite(s)] as const)
      .filter(([, v]) => Boolean(v));
  }, [pendingTick, busy]);

  const handleRetryPending = async (slot: PendingReconSlot) => {
    setBusy(true);
    try {
      await retryWrite(slot);
      toast(`${PENDING_RECON_LABELS[slot]}已确认过账`);
      await loadData(reportOffset);
    } catch (err: any) {
      toast('重试失败：' + (err.message || '未知错误'), true);
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleDropPending = (slot: PendingReconSlot) => {
    dropWrite(slot);
    toast('已放弃待确认操作，请刷新核对当前过账状态');
    setPendingTick((t) => t + 1);
  };

  const handleOpenQualityReview = (report: any) => {
    const revPieces = reviewablePieces(report);
    if (!revPieces.length) {
      toast('该报工单已无剩余可复检合格件', true);
      return;
    }
    setQualityDraft({
      ...emptyQualityForm(report, revPieces[0].pieceId),
      operationId: createUuid()
    });
  };

  const handleSubmitQuality = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qualityDraft || busy) return;
    const revPieces = reviewablePieces(qualityDraft.report);
    const piece = revPieces.find((p: any) => p.pieceId === Number(qualityDraft.pieceId));
    const probs = qualityProblems(qualityDraft, piece);
    if (probs.length > 0) {
      toast(probs[0], true);
      return;
    }
    const opId = qualityDraft.operationId || createUuid();
    const cmd = buildQualityCommand(qualityDraft, opId);
    setBusy(true);
    try {
      await idempotentPost(
        'quality-disposition',
        '/api/cutting/reports/' +
          encodeURIComponent(qualityDraft.report.planId) +
          '/quality-dispositions',
        cmd
      );
      toast('复检处置已过账！原母卷耗用保持不变，不良件已扣回良品量并退回需求池待补排');
      setQualityDraft(null);
      await loadData(reportOffset);
    } catch (err: any) {
      toast('复检处置失败：' + err.message, true);
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleSubmitRevoke = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revokeDraft || busy) return;
    if (!revokeDraft.operator.trim() || !revokeDraft.reason.trim()) {
      toast('请填写撤销经办人与撤销原因', true);
      return;
    }
    setBusy(true);
    try {
      await idempotentJsonPost(
        'quality-revoke',
        `/api/cutting/reports/${encodeURIComponent(
          revokeDraft.reportId
        )}/dispositions/${encodeURIComponent(revokeDraft.dispositionId)}/revoke`,
        {
          operator: revokeDraft.operator.trim(),
          reason: revokeDraft.reason.trim()
        }
      );
      toast('复检处置已受控撤销：原良品完成量已恢复，派生料头已作废，母卷消耗保持不变');
      setRevokeDraft(null);
      await loadData(reportOffset);
    } catch (err: any) {
      toast('撤销复检处置失败：' + err.message, true);
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleSubmitReverseReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reverseDraft || busy) return;
    const validation = validateReversalReason(reverseDraft.reason);
    if (!validation.valid) {
      const msg = validation.error || '请填写冲销原因';
      setReverseDraft((prev) => (prev ? { ...prev, error: msg } : null));
      toast(msg, true);
      return;
    }
    setBusy(true);
    setReverseDraft((prev) => (prev ? { ...prev, error: '' } : null));
    try {
      const req = buildReversalRequest(reverseDraft.reportId, validation.trimmed);
      await requestJSON(req.url, req.body);
      toast('报工已冲销：母卷/料头消耗与订单完成量已回滚，关联排程方案已置为已冲销释放');
      setReverseDraft(null);
      const nextOffset =
        reports.length <= 1 && reportOffset > 0
          ? Math.max(0, reportOffset - REPORT_PAGE_SIZE)
          : reportOffset;
      await loadData(nextOffset);
    } catch (err: any) {
      const msg = err?.message || '冲销报工请求失败';
      setReverseDraft((prev) => (prev ? { ...prev, error: msg } : null));
      toast('冲销报工失败：' + msg, true);
    } finally {
      setBusy(false);
    }
  };

  const handleReplenishTask = async (taskId: string) => {
    try {
      const fam: DemandFamilySummary = await requestJSON(
        '/api/v2/demand-pool/' + encodeURIComponent(taskId)
      );
      loadDemandFamilyIntoWorkbench(fam);
      toast(`已将缺口需求族「${fam.name}」（待补排 ${fam.openTotal} 件）带入搭切工作台`);
      location.hash = '#/workbench';
    } catch (err: any) {
      toast('读取缺口需求失败：' + err.message, true);
    }
  };

  const handleExportLedgerCsv = () => {
    if (!ledgerItems.length) return;
    const { csv, rangeLabel } = buildLedgerCsvText(ledgerItems, { hasMore: ledgerHasMore });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `库存与需求过账流水-${ledgerItems.length}条.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出流水 CSV（${rangeLabel}）`);
  };

  const areaStats = useMemo(() => {
    const areas: any[] = recon?.areas || [];
    const consumed = areas.reduce((s, a) => s + (Number(a.consumed) || 0), 0);
    const qualified = areas.reduce((s, a) => s + (Number(a.qualified) || 0), 0);
    const recovered = areas.reduce((s, a) => s + (Number(a.recovered) || 0), 0);
    const waste = areas.reduce(
      (s, a) => s + (Number(a.rejected) || 0) + (Number(a.otherWasteAndLoss) || 0),
      0
    );
    return {
      consumed,
      qualified,
      recovered,
      waste,
      netRate: consumed > 0 ? ((qualified / consumed) * 100).toFixed(2) : null
    };
  }, [recon]);

  const gapReportCount = useMemo(
    () =>
      reports.filter(({ report, dispositions }) => {
        const s = receiptSummary(report, effectivePieceResults);
        const activeDisps = dispositions.filter((d) => !isDispositionRevoked(d)).length;
        return activeDisps > 0 || s.rejected > 0;
      }).length,
    [reports]
  );

  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter((row) =>
      `${row.reportId} ${row.taskName} ${row.materialModel} ${row.batchNo} ${row.report.rollId || ''} ${row.report.sourceRemnantId || ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [reports, search]);

  const filteredLedger = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ledgerItems;
    return ledgerItems.filter((it) =>
      `${it.sequence ?? ''} ${it.eventType || ''} ${it.aggregateType || ''} ${it.aggregateId || ''} ${it.actor || ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [ledgerItems, search]);

  const tabOptions: SegmentedOption<'quality' | 'reconcile'>[] = useMemo(
    () => [
      {
        value: 'quality',
        label: '裁后复检与缺口补排',
        count: reportTotal || reports.length,
        accent: gapReportCount > 0 ? 'amber' : 'default'
      },
      {
        value: 'reconcile',
        label: '用料对账与不可变流水',
        count: ledgerItems.length
      }
    ],
    [reportTotal, reports.length, gapReportCount, ledgerItems.length]
  );

  const visibleCount = tab === 'quality' ? filteredReports.length : filteredLedger.length;
  const totalCount = tab === 'quality' ? reports.length : ledgerItems.length;

  const pageStart = reportTotal > 0 ? reportOffset + 1 : 0;
  const pageEnd = Math.min(reportTotal, reportOffset + reports.length);

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>复检补排与对账</h1>
            <span className="mp-page-summary num">
              {reportTotal || reports.length} 笔报工回执（当前页 {reports.length} 笔）· 本页{' '}
              {gapReportCount} 项含复检缺口 · 账实
              {recon?.status === 'BALANCED'
                ? '平衡'
                : recon?.status === 'MISMATCH'
                ? '发现差异'
                : '待首次记账'}
            </span>
          </div>
        </div>

        {pendingSlots.length > 0 && (
          <div className="mp-inv-notice" style={{ marginBottom: 10 }}>
            {pendingSlots.map(([slot]) => (
              <span key={slot} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>{PENDING_RECON_LABELS[slot]}提交结果未确认（已启用幂等保护）</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => handleRetryPending(slot)}
                >
                  重试原提交
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => handleDropPending(slot)}
                >
                  放弃
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mp-filter-toolbar">
          <SegmentedControl
            options={tabOptions}
            value={tab}
            onChange={(next) => {
              setTab(next);
              setSearch('');
            }}
            ariaLabel="对账子视图"
          />

          <div className="mp-search-wrap">
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
              aria-label={tab === 'quality' ? '搜索报工回执' : '搜索对账流水'}
              placeholder={
                tab === 'quality'
                  ? '筛选报工单号、需求族、缸号或母卷/料头号'
                  : '筛选事件类型、对象编号或操作方'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {visibleCount} / {totalCount}
          </span>

          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={() => loadData(reportOffset)}>
              刷新
            </button>
            <a className="mp-ghost-btn" href="#/results">
              结果管理
            </a>
            {tab === 'reconcile' ? (
              <button
                type="button"
                className="btn pri"
                disabled={!ledgerItems.length}
                title={`仅导出当前已加载的 ${ledgerItems.length} 条流水${ledgerHasMore ? '（可先点下方“加载更多”再导出）' : ''}`}
                onClick={handleExportLedgerCsv}
              >
                导出已加载流水 CSV ({ledgerItems.length}条)
              </button>
            ) : (
              <a className="btn pri" href="#/workbench">
                前往搭切补排 →
              </a>
            )}
          </div>
        </div>

        {loading ? (
          <div className="mp-empty-card">
            <div className="loading">正在读取聚合报工回执与账实对账快照…</div>
          </div>
        ) : tab === 'quality' ? (
          <>
            <div className="mp-rec-note">
              <span>
                裁后质量重分类与撤销均保留原母卷消耗不篡改，仅受控调整良品履约量与派生余料状态（支持跨刷新幂等恢复）。
              </span>
              <span className="mp-toolbar-count num">
                {reportTotal > 0 ? `第 ${pageStart}-${pageEnd} / 共 ${reportTotal} 笔` : '共 0 笔'}
              </span>
            </div>

            {reports.length === 0 ? (
              <div className="mp-empty-card">
                <strong>暂无已完工报工记录</strong>
                <p>
                  排程方案在「结果管理」完成完工过账（或由 MES 回传报工）后，即可在此执行裁后复检判废、剪裁转料头或受控撤销。
                </p>
                <a className="btn" href="#/results">
                  前往结果管理查看方案 →
                </a>
              </div>
            ) : filteredReports.length === 0 ? (
              <div className="mp-empty-card">
                <strong>未找到匹配的报工回执</strong>
                <p>请调整搜索关键词或翻页查看其他报工记录。</p>
                <button type="button" className="btn" onClick={() => setSearch('')}>
                  清空搜索
                </button>
              </div>
            ) : (
              <div className="mp-rec-table-card">
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>报工单号</th>
                        <th>所属需求族 / 品号缸号</th>
                        <th>消耗母卷 / 料头</th>
                        <th className="r">实切长 mm</th>
                        <th className="r">净合格件</th>
                        <th className="r">异常 / 判废</th>
                        <th className="r">净利用率</th>
                        <th style={{ textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReports.map((row) => {
                        const { report, dispositions } = row;
                        const s = receiptSummary(report, effectivePieceResults);
                        const revCount = reviewablePieces(report).length;
                        const defectCount = Number(s.rejected) || 0;
                        const activeDispCount = dispositions.filter(
                          (d) => !isDispositionRevoked(d)
                        ).length;
                        const hasGap = activeDispCount > 0 || defectCount > 0;
                        const isExpanded = expandedReportId === row.reportId;
                        const reversalCheck = evaluateReportReversalEligibility({
                          reportId: row.reportId,
                          status: report.status,
                          dispositions,
                          report
                        });

                        return (
                          <React.Fragment key={row.reportId}>
                            <tr>
                              <td>
                                <CodeBadge title={row.reportId}>{shortId(row.reportId)}</CodeBadge>
                              </td>
                              <td className="mp-rec-name-cell">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <strong>{row.taskName}</strong>
                                  {row.materialModel && (
                                    <span className="muted num" style={{ fontSize: 11.5 }}>
                                      {row.materialModel}
                                    </span>
                                  )}
                                  {row.batchNo && <CodeBadge>缸:{row.batchNo}</CodeBadge>}
                                </div>
                                {report.confirmedAt && (
                                  <span className="mp-rec-name-sub num">
                                    完工于{' '}
                                    {String(report.confirmedAt).replace('T', ' ').slice(0, 19)}
                                  </span>
                                )}
                              </td>
                              <td>
                                <CodeBadge>{report.sourceRemnantId || report.rollId || '—'}</CodeBadge>
                              </td>
                              <td className="r num">{fmtN(report.actualCutLen, 1)}</td>
                              <td className="r num" style={{ color: '#059669', fontWeight: 600 }}>
                                {s.qualified}
                              </td>
                              <td
                                className="r num"
                                style={{
                                  color: defectCount > 0 ? '#e11d48' : 'var(--cp-ink-3)',
                                  fontWeight: defectCount > 0 ? 600 : 400
                                }}
                              >
                                {defectCount}
                              </td>
                              <td className="r num">{fmtN(report.netUtilization, 2)}%</td>
                              <td style={{ textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                  {dispositions.length > 0 && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      onClick={() =>
                                        setExpandedReportId(isExpanded ? null : row.reportId)
                                      }
                                    >
                                      {isExpanded ? '收起处置' : `复检记录 (${dispositions.length})`}
                                    </button>
                                  )}
                                  {revCount > 0 && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      onClick={() => handleOpenQualityReview(report)}
                                    >
                                      复检处置 ({revCount})
                                    </button>
                                  )}
                                  {hasGap && row.taskId && (
                                    <button
                                      type="button"
                                      className="btn sm soft-accent"
                                      onClick={() => handleReplenishTask(row.taskId)}
                                    >
                                      带缺口去补排 →
                                    </button>
                                  )}
                                  {report.status !== 'REVERSED' && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      style={
                                        reversalCheck.eligible
                                          ? { color: 'var(--err, #b91c1c)' }
                                          : undefined
                                      }
                                      disabled={busy || !reversalCheck.eligible}
                                      title={
                                        reversalCheck.eligible
                                          ? '冲销该笔报工，恢复母卷/料头消耗并回滚完成量'
                                          : reversalCheck.reason
                                      }
                                      onClick={() =>
                                        setReverseDraft({
                                          reportId: row.reportId,
                                          taskName: row.taskName,
                                          materialLabel:
                                            report.sourceRemnantId || report.rollId || '—',
                                          actualCutLen: Number(report.actualCutLen) || 0,
                                          qualifiedCount: Number(s.qualified) || 0,
                                          reason: '',
                                          error: ''
                                        })
                                      }
                                    >
                                      冲销报工
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>

                            {isExpanded && dispositions.length > 0 && (
                              <tr>
                                <td
                                  colSpan={8}
                                  style={{
                                    background: 'var(--panel-2, #f8fafc)',
                                    padding: '10px 14px'
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 12,
                                      fontWeight: 600,
                                      marginBottom: 6,
                                      color: 'var(--cp-ink-2)'
                                    }}
                                  >
                                    历史复检处置记录（保留不可变审计痕迹，未撤销处置可执行受控撤销）
                                  </div>
                                  <table className="t">
                                    <thead>
                                      <tr>
                                        <th>处置编号</th>
                                        <th>裁片</th>
                                        <th>方式</th>
                                        <th>检验人</th>
                                        <th>原因</th>
                                        <th>派生料头</th>
                                        <th>状态</th>
                                        <th style={{ textAlign: 'right' }}>受控操作</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {dispositions.map((d: any, idx: number) => {
                                        const info = readDispositionFields(d, idx);
                                        const dispId = info.id;
                                        const revoked = info.revoked;
                                        const dispLabel =
                                          (DISPOSITIONS as Record<string, string>)[info.disposition] ||
                                          info.disposition ||
                                          '复检处置';
                                        return (
                                          <tr
                                            key={dispId}
                                            style={
                                              revoked
                                                ? { opacity: 0.65, textDecoration: 'line-through' }
                                                : undefined
                                            }
                                          >
                                            <td>
                                              <CodeBadge title={dispId}>{shortId(dispId)}</CodeBadge>
                                            </td>
                                            <td className="num">#{info.pieceId ?? '—'}</td>
                                            <td>
                                              <span className="tag warn">{dispLabel}</span>
                                            </td>
                                            <td>{info.inspector || '—'}</td>
                                            <td>{info.reason || '—'}</td>
                                            <td className="num">{info.remnantId || '—'}</td>
                                            <td>
                                              <span className={`tag ${revoked ? '' : 'ok'}`}>
                                                {revoked ? '已撤销' : '生效中'}
                                              </span>
                                            </td>
                                            <td style={{ textAlign: 'right' }}>
                                              {!revoked && (d.id || d.dispositionId) ? (
                                                <button
                                                  type="button"
                                                  className="btn sm"
                                                  style={{ color: 'var(--err, #b91c1c)' }}
                                                  onClick={() =>
                                                    setRevokeDraft({
                                                      reportId: row.reportId,
                                                      taskName: row.taskName,
                                                      dispositionId: String(d.id || d.dispositionId),
                                                      pieceId: info.pieceId,
                                                      dispositionLabel: dispLabel,
                                                      inspector: info.inspector,
                                                      origReason: info.reason,
                                                      operator: '',
                                                      reason: ''
                                                    })
                                                  }
                                                >
                                                  撤销处置
                                                </button>
                                              ) : (
                                                <span className="muted" style={{ fontSize: 11.5 }}>
                                                  {info.revokedReason
                                                    ? `${info.revokedBy ? `${info.revokedBy} · ` : ''}${info.revokedReason}`
                                                    : '—'}
                                                </span>
                                              )}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* 聚合报工分页控件 */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderTop: '1px solid var(--line-2, #e2e8f0)',
                    fontSize: 12
                  }}
                >
                  <span className="muted num">
                    每页 {REPORT_PAGE_SIZE} 笔 · 当前第 {pageStart}~{pageEnd} / 共 {reportTotal}{' '}
                    笔
                  </span>
                  <div style={{ display: 'inline-flex', gap: 6 }}>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={reportOffset <= 0 || loading}
                      onClick={() =>
                        handlePageChange(Math.max(0, reportOffset - REPORT_PAGE_SIZE))
                      }
                    >
                      ← 上一页
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!reportHasMore || loading}
                      onClick={() => handlePageChange(reportOffset + REPORT_PAGE_SIZE)}
                    >
                      下一页 →
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="mp-rec-kpi-grid">
              <div className="mp-rec-kpi-card">
                <small>账实流水平衡状态</small>
                <b
                  className={`mp-rec-kpi-val ${
                    recon?.status === 'BALANCED'
                      ? 'ok'
                      : recon?.status === 'MISMATCH'
                      ? 'err'
                      : ''
                  }`}
                >
                  {recon?.status === 'BALANCED'
                    ? 'BALANCED 平衡'
                    : recon?.status === 'MISMATCH'
                    ? '发现差异'
                    : '待首次记账'}
                </b>
                <div className="mp-rec-kpi-sub num">版本 v{recon?.revision ?? 0}</div>
              </div>
              <div className="mp-rec-kpi-card">
                <small>累计实耗原料面积</small>
                <b className="mp-rec-kpi-val num">{fmtN(areaStats.consumed, 3)} m²</b>
                <div className="mp-rec-kpi-sub">含已切母卷与领用料头</div>
              </div>
              <div className="mp-rec-kpi-card">
                <small>扣除复检净良品面积</small>
                <b className="mp-rec-kpi-val ok num">{fmtN(areaStats.qualified, 3)} m²</b>
                <div className="mp-rec-kpi-sub">仅合格成品计入履约</div>
              </div>
              <div className="mp-rec-kpi-card">
                <small>实际净良品产出率</small>
                <b className="mp-rec-kpi-val num">
                  {areaStats.netRate ? `${areaStats.netRate}%` : '暂无实切'}
                </b>
                <div className="mp-rec-kpi-sub">净良品面积 ÷ 实耗总面积</div>
              </div>
              <div className="mp-rec-kpi-card">
                <small>回收可用余料面积</small>
                <b className="mp-rec-kpi-val num">{fmtN(areaStats.recovered, 3)} m²</b>
                <div className="mp-rec-kpi-sub">独立入账 · 不虚增利用率</div>
              </div>
            </div>

            <div className="mp-rec-table-card">
              <div className="mp-rec-card-head">
                <strong>不可变库存与需求过账流水</strong>
                <span className="mp-toolbar-count num">
                  当前显示 {filteredLedger.length} / 已加载 {ledgerItems.length} 笔
                  {ledgerHasMore ? '（支持下方游标加载更多）' : '（已加载全部）'}
                </span>
              </div>
              {filteredLedger.length === 0 ? (
                <div style={{ padding: '28px 16px', textAlign: 'center', color: 'var(--cp-ink-3)' }}>
                  暂无匹配的过账流水记录
                </div>
              ) : (
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>序号</th>
                        <th>事件类型</th>
                        <th>账本对象</th>
                        <th>对象编号</th>
                        <th>操作方</th>
                        <th className="r">过账时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLedger.map((it) => (
                        <tr key={it.id ?? it.sequence}>
                          <td className="num">#{it.sequence}</td>
                          <td>
                            <span className="tag kind">{it.eventType}</span>
                          </td>
                          <td>{it.aggregateType}</td>
                          <td>
                            <CodeBadge>{it.aggregateId}</CodeBadge>
                          </td>
                          <td>{it.actor}</td>
                          <td className="r num" style={{ color: 'var(--cp-ink-3)' }}>
                            {it.occurredAt
                              ? String(it.occurredAt).replace('T', ' ').slice(0, 19)
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderTop: '1px solid var(--line-2, #e2e8f0)',
                  fontSize: 12
                }}
              >
                <span className="muted num">
                  已加载 {ledgerItems.length} 条流水 · CSV 导出仅包含当前已加载范围（含防公式注入转义）
                </span>
                {ledgerHasMore ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={loadingMoreLedger}
                    onClick={handleLoadMoreLedger}
                  >
                    {loadingMoreLedger ? '正在加载下一批…' : `加载更多流水 (+${LEDGER_PAGE_SIZE})`}
                  </button>
                ) : (
                  <span className="muted">已全部加载完成</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Quality Disposition Modal */}
      <ModalDialog
        open={qualityDraft !== null}
        title="裁后质量复检重分类（保持原母卷耗用不变，扣回良品完成量）"
        onClose={() => {
          if (!busy) setQualityDraft(null);
        }}
        maxWidth={560}
      >
        {qualityDraft && (
          <form onSubmit={handleSubmitQuality}>
            <div className="form" style={{ gridTemplateColumns: '110px 1fr', padding: '4px 0 12px' }}>
              <label>选择复检裁片</label>
              <select
                className="field"
                value={qualityDraft.pieceId}
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, pieceId: Number(e.target.value) })
                }
              >
                {reviewablePieces(qualityDraft.report).map((p: any) => (
                  <option key={p.pieceId} value={p.pieceId}>
                    #{p.pieceId} {p.name} ({fmtN(p.w)}×{fmtN(p.l)} mm)
                  </option>
                ))}
              </select>
              <label>处置方式</label>
              <select
                className="field"
                value={qualityDraft.disposition}
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, disposition: e.target.value })
                }
              >
                {Object.entries(DISPOSITIONS as Record<string, string>).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <label>检验人</label>
              <input
                className="field"
                required
                value={qualityDraft.inspector}
                placeholder="如：质检员王工"
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, inspector: e.target.value })
                }
              />
              <label>判定原因</label>
              <input
                className="field"
                required
                value={qualityDraft.reason}
                placeholder="如：缝制前发现局部暗伤"
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, reason: e.target.value })
                }
              />
              {qualityDraft.disposition === 'REMNANT' && (
                <>
                  <label>回收宽×长 mm</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      className="field num"
                      placeholder="宽"
                      value={qualityDraft.width}
                      onChange={(e) =>
                        setQualityDraft({ ...qualityDraft, width: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      className="field num"
                      placeholder="长"
                      value={qualityDraft.length}
                      onChange={(e) =>
                        setQualityDraft({ ...qualityDraft, length: e.target.value })
                      }
                    />
                  </div>
                  <label>入库位置</label>
                  <input
                    className="field"
                    value={qualityDraft.location}
                    placeholder="如：复检回收架 Q-01"
                    onChange={(e) =>
                      setQualityDraft({ ...qualityDraft, location: e.target.value })
                    }
                  />
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setQualityDraft(null)}
              >
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '过账中…' : '确认复检处置'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      {/* 受控复检处置撤销弹窗 */}
      <ModalDialog
        open={revokeDraft !== null}
        title="受控撤销复检处置（保留审计留痕，恢复良品量）"
        onClose={() => {
          if (!busy) setRevokeDraft(null);
        }}
        maxWidth={540}
      >
        {revokeDraft && (
          <form onSubmit={handleSubmitRevoke}>
            <div
              role="alert"
              style={{
                borderLeft: '3px solid var(--warn, #d97706)',
                background: 'var(--warn-bg, rgba(245, 158, 11, 0.1))',
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                color: 'var(--warn, #92400e)',
                marginBottom: 10
              }}
            >
              <strong>撤销边界说明：</strong>撤销后将保留原复检记录并追加反向流水，恢复对应裁片的良品完成量、并将未使用的派生料头置为作废/撤销；原母卷消耗保持不变。若派生料头已被领用/移库将被服务端拦截。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>报工单号</div>
              <div>{revokeDraft.reportId}</div>
              <div>处置单号 / 裁片</div>
              <div>
                {revokeDraft.dispositionId} · 裁片 #{revokeDraft.pieceId ?? '—'}（
                {revokeDraft.dispositionLabel}）
              </div>
              <div>原检验人 / 原因</div>
              <div>
                {revokeDraft.inspector || '—'} · {revokeDraft.origReason || '—'}
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
              <label htmlFor="rev-operator">撤销经办人</label>
              <input
                id="rev-operator"
                className="field"
                required
                placeholder="如：质检主管刘工"
                value={revokeDraft.operator}
                onChange={(e) => setRevokeDraft({ ...revokeDraft, operator: e.target.value })}
              />
              <label htmlFor="rev-reason">撤销原因</label>
              <input
                id="rev-reason"
                className="field"
                required
                autoFocus
                placeholder="如：二次复核确认为可擦除粉尘印，误判撤回"
                value={revokeDraft.reason}
                onChange={(e) => setRevokeDraft({ ...revokeDraft, reason: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setRevokeDraft(null)}
              >
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在撤销…' : '确认受控撤销'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      {/* 报工冲销弹窗 */}
      <ModalDialog
        open={reverseDraft !== null}
        title="冲销报工回执（恢复母卷/料头消耗与订单完成量）"
        onClose={() => {
          if (!busy) setReverseDraft(null);
        }}
        maxWidth={540}
      >
        {reverseDraft && (
          <form onSubmit={handleSubmitReverseReport}>
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
              冲销后将恢复本次报工消耗的母卷/料头用量、作废本次派生余料、回滚订单完成量，并将关联排程方案状态同步回滚为{' '}
              <b>已冲销释放（REVERSED）</b>
              。已有复检处置、后续盘点、后续报工或已流转派生料头的记录将被服务端拦截。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>报工单号</div>
              <div>{reverseDraft.reportId}</div>
              <div>所属需求族</div>
              <div>{reverseDraft.taskName}</div>
              <div>消耗母卷 / 料头</div>
              <div>{reverseDraft.materialLabel}</div>
              <div>实切长 / 净合格</div>
              <div>
                {fmtN(reverseDraft.actualCutLen, 1)} mm · 净合格 {reverseDraft.qualifiedCount} 件
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
              <label htmlFor="recon-reverse-reason">冲销原因</label>
              <div>
                <textarea
                  id="recon-reverse-reason"
                  className="field"
                  rows={3}
                  required
                  autoFocus
                  maxLength={MAX_REVERSAL_REASON_LENGTH}
                  placeholder="必填（1–500字），如：录入实切长度有误或错报母卷需撤回重报"
                  value={reverseDraft.reason}
                  onChange={(e) =>
                    setReverseDraft((prev) =>
                      prev ? { ...prev, reason: e.target.value, error: '' } : null
                    )
                  }
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
                  <span>冲销将写入不可变流水（REPORT_REVERSE）</span>
                  <span>
                    {reverseDraft.reason.trim().length} / {MAX_REVERSAL_REASON_LENGTH}
                  </span>
                </div>
              </div>
            </div>
            {reverseDraft.error && (
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
                {reverseDraft.error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setReverseDraft(null)}
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
