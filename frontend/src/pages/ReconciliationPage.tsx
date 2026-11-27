import React, { useEffect, useMemo, useState } from 'react';
import {
  requestJSON,
  idempotentPost,
  pendingWrite,
  retryWrite,
  dropWrite,
  toast,
  createUuid
} from '../lib/core/util.js';
import {
  reviewablePieces,
  effectivePieceResults,
  emptyQualityForm,
  qualityProblems,
  buildQualityCommand,
  receiptSummary
} from '../lib/model/quality.js';
import { SegmentedControl, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { OperationFeedbackCard } from '../components/OperationFeedbackCard';
import { useDemandPoolStore } from '../store/selectors';
import type { DemandFamilySummary } from '../store/studioTypes';
import { AuthSession, LOCAL_FALLBACK_SESSION, idempotentJsonPost } from '../utils/authClient';
import { downloadProductionSummary, formatExportError } from '../utils/exportApiClient';
import {
  NormalizedReconciliationReportRow,
  buildLedgerCsvText,
  isDispositionRevoked,
  normalizeReconciliationReportItem
} from './results/reconciliationUtils';
import { buildReversalRequest, validateReversalReason } from './results/reportReversalUtils';
import {
  ReconciliationQualityTab,
  ReverseReportDraft,
  RevokeDraft
} from './reconciliation/ReconciliationQualityTab';
import { ReconciliationLedgerTab } from './reconciliation/ReconciliationLedgerTab';
import { ReconciliationModals } from './reconciliation/ReconciliationModals';

const REPORT_PAGE_SIZE = 50;
const LEDGER_PAGE_SIZE = 100;

type PendingReconSlot = 'quality-disposition' | 'quality-revoke';
const PENDING_RECON_LABELS: Record<PendingReconSlot, string> = {
  'quality-disposition': '裁后复检处置',
  'quality-revoke': '复检处置撤销'
};

export const ReconciliationPage: React.FC<{ auth?: AuthSession }> = ({
  auth: _auth = LOCAL_FALLBACK_SESSION
}) => {
  const { loadDemandFamilyIntoWorkbench } = useDemandPoolStore();

  const [tab, setTab] = useState<'quality' | 'reconcile'>('quality');
  const [search, setSearch] = useState('');

  const [reports, setReports] = useState<NormalizedReconciliationReportRow[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportOffset, setReportOffset] = useState(0);
  const [reportHasMore, setReportHasMore] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);

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
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<{
    title: string;
    message: string;
    status?: number;
    traceId?: string;
  } | null>(null);

  const loadReportsPage = async (offset: number) => {
    const page = await requestJSON(`/api/v2/reconciliation/reports?limit=${REPORT_PAGE_SIZE}&offset=${offset}`);
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
    if (loadingMoreLedger || !ledgerHasMore || ledgerNextCursor === null || ledgerNextCursor === undefined) return;
    setLoadingMoreLedger(true);
    try {
      const ledPage = await requestJSON(
        `/api/v2/inventory-ledger?limit=${LEDGER_PAGE_SIZE}&after=${encodeURIComponent(String(ledgerNextCursor))}`
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
    try {
      return (['quality-disposition', 'quality-revoke'] as const)
        .map((s) => [s, pendingWrite(s)] as const)
        .filter(([, v]) => Boolean(v));
    } catch {
      return [];
    }
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
    setQualityDraft({ ...emptyQualityForm(report, revPieces[0].pieceId), operationId: createUuid() });
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
        '/api/v2/cutting/reports/' + encodeURIComponent(qualityDraft.report.planId) + '/quality-dispositions',
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
        `/api/v2/cutting/reports/${encodeURIComponent(revokeDraft.reportId)}/dispositions/${encodeURIComponent(
          revokeDraft.dispositionId
        )}/revoke`,
        { operator: revokeDraft.operator.trim(), reason: revokeDraft.reason.trim() }
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
      const nextOffset = reports.length <= 1 && reportOffset > 0 ? Math.max(0, reportOffset - REPORT_PAGE_SIZE) : reportOffset;
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
      const fam: DemandFamilySummary = await requestJSON('/api/v2/demand-pool/' + encodeURIComponent(taskId));
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

  const handleDownloadSummary = async (format: 'pdf' | 'xlsx') => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const res = await downloadProductionSummary(format);
      toast(`已下载汇总报表：${res.fileName}`);
    } catch (err) {
      setExportError(formatExportError(err));
    } finally {
      setExportBusy(false);
    }
  };

  const areaStats = useMemo(() => {
    const areas: any[] = recon?.areas || [];
    const consumed = areas.reduce((s, a) => s + (Number(a.consumed) || 0), 0);
    const qualified = areas.reduce((s, a) => s + (Number(a.qualified) || 0), 0);
    const recovered = areas.reduce((s, a) => s + (Number(a.recovered) || 0), 0);
    const waste = areas.reduce((s, a) => s + (Number(a.rejected) || 0) + (Number(a.otherWasteAndLoss) || 0), 0);
    return { consumed, qualified, recovered, waste, netRate: consumed > 0 ? ((qualified / consumed) * 100).toFixed(2) : null };
  }, [recon]);

  const gapReportCount = useMemo(
    () =>
      reports.filter(({ report, dispositions }) => {
        const s = receiptSummary(report, effectivePieceResults);
        return dispositions.filter((d) => !isDispositionRevoked(d)).length > 0 || s.rejected > 0;
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
      { value: 'quality', label: '裁后复检与缺口补排', count: reportTotal || reports.length, accent: gapReportCount > 0 ? 'amber' : 'default' },
      { value: 'reconcile', label: '用料对账与不可变流水', count: ledgerItems.length }
    ],
    [reportTotal, reports.length, gapReportCount, ledgerItems.length]
  );

  const visibleCount = tab === 'quality' ? filteredReports.length : filteredLedger.length;
  const totalCount = tab === 'quality' ? reports.length : ledgerItems.length;

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>复检补排与对账</h1>
            <span className="mp-page-summary num">
              {reportTotal || reports.length} 笔报工回执（当前页 {reports.length} 笔）· 本页 {gapReportCount} 项含复检缺口 · 账实
              {recon?.status === 'BALANCED' ? '平衡' : recon?.status === 'MISMATCH' ? '发现差异' : '待首次记账'}
            </span>
          </div>
          <div className="mp-toolbar-actions">
            <button
              type="button"
              className="mp-ghost-btn"
              data-testid="recon-export-summary-pdf-btn"
              disabled={exportBusy}
              onClick={() => handleDownloadSummary('pdf')}
            >
              生产汇总 PDF
            </button>
            <button
              type="button"
              className="mp-ghost-btn"
              data-testid="recon-export-summary-xlsx-btn"
              disabled={exportBusy}
              onClick={() => handleDownloadSummary('xlsx')}
            >
              多维汇总 Excel
            </button>
          </div>
        </div>

        {exportError && (
          <div style={{ marginBottom: 10 }}>
            <OperationFeedbackCard
              tone="err"
              testId="export-error-banner"
              title={exportError.title}
              message={exportError.message}
              traceId={exportError.traceId}
              actions={[{ label: '关闭提示', onClick: () => setExportError(null) }]}
            />
          </div>
        )}

        {pendingSlots.length > 0 && (
          <div className="mp-inv-notice" style={{ marginBottom: 10 }}>
            {pendingSlots.map(([slot]) => (
              <span key={slot} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>{PENDING_RECON_LABELS[slot]}提交结果未确认（已启用幂等保护）</span>
                <button type="button" className="btn sm" disabled={busy} onClick={() => handleRetryPending(slot)}>
                  重试原提交
                </button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => handleDropPending(slot)}>
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
                <circle cx="7.2" cy="7.2" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="m10.8 10.8 2.8 2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
            <input
              type="search"
              className="mp-search-input"
              aria-label={tab === 'quality' ? '搜索报工回执' : '搜索对账流水'}
              placeholder={tab === 'quality' ? '筛选报工单号、需求族、缸号或母卷/料头号' : '筛选事件类型、对象编号或操作方'}
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
                data-testid="recon-ledger-csv-btn"
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
          <ReconciliationQualityTab
            reports={reports}
            filteredReports={filteredReports}
            reportTotal={reportTotal}
            reportOffset={reportOffset}
            reportPageSize={REPORT_PAGE_SIZE}
            reportHasMore={reportHasMore}
            loading={loading}
            busy={busy}
            expandedReportId={expandedReportId}
            onToggleExpand={setExpandedReportId}
            onOpenQualityReview={handleOpenQualityReview}
            onReplenishTask={handleReplenishTask}
            onOpenReverseDraft={setReverseDraft}
            onOpenRevokeDraft={setRevokeDraft}
            onPageChange={handlePageChange}
            onClearSearch={() => setSearch('')}
          />
        ) : (
          <ReconciliationLedgerTab
            recon={recon}
            areaStats={areaStats}
            ledgerItems={ledgerItems}
            filteredLedger={filteredLedger}
            ledgerHasMore={ledgerHasMore}
            loadingMoreLedger={loadingMoreLedger}
            ledgerPageSize={LEDGER_PAGE_SIZE}
            onLoadMoreLedger={handleLoadMoreLedger}
          />
        )}
      </div>

      <ReconciliationModals
        busy={busy}
        qualityDraft={qualityDraft}
        setQualityDraft={setQualityDraft}
        onSubmitQuality={handleSubmitQuality}
        revokeDraft={revokeDraft}
        setRevokeDraft={setRevokeDraft}
        onSubmitRevoke={handleSubmitRevoke}
        reverseDraft={reverseDraft}
        setReverseDraft={setReverseDraft}
        onSubmitReverseReport={handleSubmitReverseReport}
      />
    </div>
  );
};
