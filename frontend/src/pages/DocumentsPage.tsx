import React, { useEffect, useMemo, useState } from 'react';
import {
  requestJSON,
  toast,
  pendingWrite,
  retryWrite,
  dropWrite
} from '../lib/core/util.js';
import { SegmentedControl, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { idempotentJsonPost } from '../utils/authClient';
import {
  Category,
  DOC_PENDING_LABELS,
  DocPendingSlot,
  DocTab,
  Focus,
  RangeKey,
  ReceiptRollDraft,
  ViewKey,
  asList,
  buildTxns,
  computeDailyBuckets,
  computeLedgerKpis,
  computeTopObjects,
  createEmptyReceiptRoll,
  filterCounts,
  filterIssues,
  filterLedgerLines,
  filterRangeLines,
  filterReceipts,
  filterTransfers,
  loadAllLedgerItems,
  validateAndBuildIssuePayload,
  validateAndBuildReceiptPayload
} from './documents/documentLedgerUtils';
import { DocumentTimelineView } from './documents/DocumentTimelineView';
import { DocumentOrdersTabViews } from './documents/DocumentOrdersTabViews';
import { DocumentReceiptModal } from './documents/DocumentReceiptModal';
import { DocumentIssueModal } from './documents/DocumentIssueModal';

export type {
  Category,
  FieldChange,
  Txn,
  DocTab,
  RangeKey,
  ViewKey,
  Focus,
  ReceiptRollDraft,
  DocPendingSlot,
  LedgerKpis,
  DailyBucketResult,
  TopObjectItem
} from './documents/documentLedgerUtils';
export {
  categoryOf,
  eventTagClass,
  flatten,
  diffLine,
  txnFacts,
  buildTxns,
  createEmptyReceiptRoll,
  filterRangeLines,
  computeLedgerKpis,
  computeDailyBuckets,
  computeTopObjects,
  filterLedgerLines,
  filterTransfers,
  filterCounts,
  filterReceipts,
  filterIssues,
  validateAndBuildReceiptPayload,
  validateAndBuildIssuePayload
} from './documents/documentLedgerUtils';

export const DocumentsPage: React.FC = () => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<DocTab>('ledger');
  const [range, setRange] = useState<RangeKey>('7d');
  const [day, setDay] = useState<string>('');
  const [category, setCategory] = useState<Category | ''>('');
  const [filterAgg, setFilterAgg] = useState<string>('');
  const [view, setView] = useState<ViewKey>('txn');
  const [showOpening, setShowOpening] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [issueDirFilter, setIssueDirFilter] = useState<'ALL' | 'ISSUE' | 'RETURN'>('ALL');
  const [focus, setFocus] = useState<Focus>(null);

  // 新建单据弹窗与表单状态
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [deliveryNoteNo, setDeliveryNoteNo] = useState('');
  const [receiptOperator, setReceiptOperator] = useState('');
  const [receiptInspector, setReceiptInspector] = useState('');
  const [receiptRemarks, setReceiptRemarks] = useState('');
  const [receiptRolls, setReceiptRolls] = useState<ReceiptRollDraft[]>(() => [
    createEmptyReceiptRoll()
  ]);
  const [lastReceiptRolls, setLastReceiptRolls] = useState<
    { rollId: string; materialModel: string; inspectionStatus: string }[]
  >([]);

  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueDirection, setIssueDirection] = useState<'ISSUE' | 'RETURN'>('ISSUE');
  const [issueRollId, setIssueRollId] = useState('');
  const [issueMachineId, setIssueMachineId] = useState('');
  const [issueShiftTeam, setIssueShiftTeam] = useState('');
  const [issueOperator, setIssueOperator] = useState('');
  const [issueTargetLoc, setIssueTargetLoc] = useState('');
  const [issueReason, setIssueReason] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, ct, rec, iss, rollList, led] = await Promise.all([
        requestJSON('/api/v2/inventory-transfers'),
        requestJSON('/api/v2/inventory-counts'),
        requestJSON('/api/v2/inventory-receipts').catch(() => []),
        requestJSON('/api/v2/material-issues').catch(() => []),
        requestJSON('/api/v2/rolls').catch(() => []),
        loadAllLedgerItems()
      ]);
      setTransfers(asList(tr));
      setCounts(asList(ct));
      setReceipts(asList(rec));
      setIssues(asList(iss));
      const rArr = asList(rollList);
      setRolls(rArr);
      if (rArr.length && !issueRollId) {
        const firstPassed = rArr.find(
          (r: any) =>
            r.inspectionStatus === 'PASSED' &&
            r.status !== 'SCRAPPED' &&
            (r.currentRemainingLength ?? r.totalLength) > 0
        );
        const firstActive =
          firstPassed ||
          rArr.find(
            (r: any) =>
              r.inspectionStatus !== 'SCRAPPED' &&
              r.status !== 'SCRAPPED' &&
              (r.currentRemainingLength ?? r.totalLength) > 0
          );
        if (firstActive) setIssueRollId(firstActive.rollId);
      }
      setItems(led);
    } catch (e: any) {
      setError(e.message || '读取库存单据与流水失败');
    } finally {
      setLoading(false);
    }
  };

  const pendingSlots = useMemo(() => {
    void pendingTick;
    return (['inventory-receipt', 'material-issue'] as const)
      .map((s) => [s, pendingWrite(s)] as const)
      .filter(([, v]) => Boolean(v));
  }, [pendingTick, submitting]);

  const handleRetryDoc = async (slot: DocPendingSlot) => {
    try {
      await retryWrite(slot);
      toast(`${DOC_PENDING_LABELS[slot]}已确认过账`);
      await loadData();
    } catch (err: any) {
      toast(err.message || '重试失败', true);
    } finally {
      setPendingTick((t) => t + 1);
    }
  };

  const handleDropDoc = (slot: DocPendingSlot) => {
    dropWrite(slot);
    toast('已放弃未确认草稿，请核对单据列表是否已入账');
    setPendingTick((t) => t + 1);
  };

  const handleSubmitReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const built = validateAndBuildReceiptPayload({
      supplierName,
      deliveryNoteNo,
      operator: receiptOperator,
      inspector: receiptInspector,
      remarks: receiptRemarks,
      rolls: receiptRolls
    });
    if (!built.ok || !built.payload) {
      toast(built.error || '请检查入库单必填信息', true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await idempotentJsonPost('inventory-receipt', '/api/v2/inventory-receipts', built.payload);
      const createdList = Array.isArray(res?.createdRolls) ? res.createdRolls : [];
      const createdCount = createdList.length || built.payload.rolls.length;
      setLastReceiptRolls(
        createdList.map((r: any) => ({
          rollId: String(r.rollId || r.id || ''),
          materialModel: String(r.rollModel || r.materialModel || ''),
          inspectionStatus: String(r.inspectionStatus || 'PENDING')
        }))
      );
      toast(`采购入库单已过账！原子创建 ${createdCount} 卷母卷并写入不可变流水`);
      setReceiptModalOpen(false);
      setSupplierName('');
      setDeliveryNoteNo('');
      setReceiptInspector('');
      setReceiptRemarks('');
      setReceiptRolls([createEmptyReceiptRoll()]);
      await loadData();
    } catch (err: any) {
      toast('提交采购入库单失败：' + (err.message || '未知错误'), true);
    } finally {
      setSubmitting(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleSubmitIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const built = validateAndBuildIssuePayload({
      direction: issueDirection,
      rollId: issueRollId,
      machineId: issueMachineId,
      shiftTeam: issueShiftTeam,
      operator: issueOperator,
      targetLocation: issueTargetLoc,
      reason: issueReason
    });
    if (!built.ok || !built.payload) {
      toast(built.error || '请检查领退料单必填信息', true);
      return;
    }
    setSubmitting(true);
    try {
      await idempotentJsonPost('material-issue', '/api/v2/material-issues', built.payload);
      toast(
        issueDirection === 'ISSUE'
          ? `母卷 ${built.payload.rollId} 发料单已过账（机台 ${built.payload.machineId}）`
          : `母卷 ${built.payload.rollId} 退料入库单已过账（目标库位 ${built.payload.targetLocation}）`
      );
      setIssueModalOpen(false);
      setIssueReason('');
      await loadData();
    } catch (err: any) {
      toast('提交车间领/退料单失败：' + (err.message || '未知错误'), true);
    } finally {
      setSubmitting(false);
      setPendingTick((t) => t + 1);
    }
  };

  useEffect(() => {
    loadData();
    const sp = new URLSearchParams(location.hash.split('?')[1] || '');
    const trace = sp.get('trace');
    if (trace) {
      setFocus({ kind: 'obj', type: sp.get('type') || '', id: trace });
      setRange('all');
    }
  }, []);

  const rangeLines = useMemo(() => filterRangeLines(items, range, day), [items, range, day]);
  const kpis = useMemo(() => computeLedgerKpis(rangeLines), [rangeLines]);
  const daily = useMemo(() => computeDailyBuckets(items), [items]);
  const topObjects = useMemo(() => computeTopObjects(rangeLines), [rangeLines]);
  const aggs = useMemo(
    () => [...new Set(items.map((i) => i.aggregateType).filter(Boolean))],
    [items]
  );
  const openingCount = useMemo(
    () => items.filter((i) => i.eventType === 'MIGRATION_OPENING').length,
    [items]
  );
  const filteredLedger = useMemo(
    () => filterLedgerLines(items, rangeLines, { showOpening, category, filterAgg, searchQuery }),
    [items, rangeLines, showOpening, category, filterAgg, searchQuery]
  );
  const txns = useMemo(() => buildTxns(filteredLedger), [filteredLedger]);
  const focusLines = useMemo(() => {
    if (!focus) return [];
    if (focus.kind === 'txn') return items.filter((i) => (i.transactionId || i.id) === focus.id);
    if (focus.kind === 'obj')
      return items.filter(
        (i) => i.aggregateId === focus.id && (!focus.type || i.aggregateType === focus.type)
      );
    return items.filter((i) => (i.sourceReportIds || []).includes(focus.id) || i.aggregateId === focus.id);
  }, [focus, items]);

  const filteredTransfers = useMemo(() => filterTransfers(transfers, searchQuery), [transfers, searchQuery]);
  const filteredCounts = useMemo(() => filterCounts(counts, searchQuery), [counts, searchQuery]);
  const filteredReceipts = useMemo(() => filterReceipts(receipts, searchQuery), [receipts, searchQuery]);
  const filteredIssues = useMemo(
    () => filterIssues(issues, issueDirFilter, searchQuery),
    [issues, issueDirFilter, searchQuery]
  );

  const tabOptions: SegmentedOption<DocTab>[] = useMemo(
    () => [
      { value: 'ledger', label: '库存流水', count: items.length - openingCount, accent: 'indigo' },
      { value: 'receipt', label: '采购入库单', count: receipts.length, accent: 'emerald' },
      { value: 'issue', label: '车间领/退料单', count: issues.length, accent: 'amber' },
      { value: 'transfer', label: '移库单', count: transfers.length },
      { value: 'count', label: '盘点单', count: counts.length }
    ],
    [items.length, openingCount, receipts.length, issues.length, transfers.length, counts.length]
  );

  const rangeOptions: SegmentedOption<RangeKey>[] = [
    { value: 'today', label: '今日' },
    { value: '7d', label: '近 7 天' },
    { value: '30d', label: '近 30 天' },
    { value: 'all', label: '全部' }
  ];

  return (
    <div className="react-page">
      <div className="mp-page-shell mp-doc-page">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>库存单据</h1>
            <span className="mp-page-summary num">
              不可变流水 {items.length - openingCount} 条 · 采购入库 {receipts.length} · 领退料 {issues.length} · 移库 {transfers.length} · 盘点 {counts.length}
            </span>
          </div>
          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={loadData}>
              刷新
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTab('issue');
                setIssueModalOpen(true);
              }}
            >
              ＋ 车间领/退料
            </button>
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                setTab('receipt');
                setReceiptModalOpen(true);
              }}
            >
              ＋ 采购入库单
            </button>
            <a className="mp-ghost-btn" href="#/inventory">
              库存台账
            </a>
          </div>
        </div>

        {pendingSlots.length > 0 && (
          <div className="mp-inv-notice" style={{ marginBottom: 10 }}>
            {pendingSlots.map(([slot]) => (
              <span key={slot} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>{DOC_PENDING_LABELS[slot]}提交结果未确认（幂等保护已落盘）</span>
                <button type="button" className="btn sm" onClick={() => handleRetryDoc(slot)}>
                  重试原提交
                </button>
                <button type="button" className="btn sm" onClick={() => handleDropDoc(slot)}>
                  放弃
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mp-doc-subbar">
          <SegmentedControl options={tabOptions} value={tab} onChange={(next) => setTab(next)} ariaLabel="切换单据与流水类型" />
          {tab === 'ledger' && (
            <SegmentedControl
              options={rangeOptions}
              value={range}
              onChange={(next) => {
                setRange(next);
                setDay('');
              }}
              ariaLabel="统计时间范围"
              size="sm"
            />
          )}
        </div>

        {error ? (
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="mp-doc-card">
            <div className="loading">正在读取库存单据与不可变流水…</div>
          </div>
        ) : tab === 'ledger' ? (
          <DocumentTimelineView
            day={day}
            onSelectDay={setDay}
            category={category}
            onSelectCategory={setCategory}
            filterAgg={filterAgg}
            onSelectFilterAgg={setFilterAgg}
            view={view}
            onChangeView={setView}
            showOpening={showOpening}
            onToggleShowOpening={setShowOpening}
            searchQuery={searchQuery}
            onChangeSearchQuery={setSearchQuery}
            focus={focus}
            onChangeFocus={setFocus}
            kpis={kpis}
            daily={daily}
            topObjects={topObjects}
            aggs={aggs}
            openingCount={openingCount}
            filteredLedger={filteredLedger}
            txns={txns}
            focusLines={focusLines}
            transfersCount={transfers.length}
            countsCount={counts.length}
          />
        ) : (
          <DocumentOrdersTabViews
            tab={tab}
            searchQuery={searchQuery}
            onChangeSearchQuery={setSearchQuery}
            receipts={receipts}
            filteredReceipts={filteredReceipts}
            rolls={rolls}
            lastReceiptRolls={lastReceiptRolls}
            onClearLastReceiptRolls={() => setLastReceiptRolls([])}
            onOpenReceiptModal={() => setReceiptModalOpen(true)}
            issues={issues}
            filteredIssues={filteredIssues}
            issueDirFilter={issueDirFilter}
            onChangeIssueDirFilter={setIssueDirFilter}
            onOpenIssueModal={() => setIssueModalOpen(true)}
            transfers={transfers}
            filteredTransfers={filteredTransfers}
            counts={counts}
            filteredCounts={filteredCounts}
          />
        )}
      </div>

      <DocumentReceiptModal
        open={receiptModalOpen}
        submitting={submitting}
        supplierName={supplierName}
        onChangeSupplierName={setSupplierName}
        deliveryNoteNo={deliveryNoteNo}
        onChangeDeliveryNoteNo={setDeliveryNoteNo}
        receiptOperator={receiptOperator}
        onChangeReceiptOperator={setReceiptOperator}
        receiptInspector={receiptInspector}
        onChangeReceiptInspector={setReceiptInspector}
        receiptRemarks={receiptRemarks}
        onChangeReceiptRemarks={setReceiptRemarks}
        receiptRolls={receiptRolls}
        onChangeReceiptRolls={setReceiptRolls}
        onSubmit={handleSubmitReceipt}
        onClose={() => setReceiptModalOpen(false)}
      />

      <DocumentIssueModal
        open={issueModalOpen}
        submitting={submitting}
        rolls={rolls}
        issueDirection={issueDirection}
        onChangeDirection={(next) => {
          setIssueDirection(next);
          if (next === 'ISSUE') {
            const cur = rolls.find((r) => r.rollId === issueRollId);
            if (cur && cur.inspectionStatus !== 'PASSED') {
              const fallback = rolls.find(
                (r) =>
                  r.inspectionStatus === 'PASSED' &&
                  r.status !== 'SCRAPPED' &&
                  (r.currentRemainingLength ?? r.totalLength) > 0
              );
              setIssueRollId(fallback ? fallback.rollId : '');
            }
          }
          if (next === 'RETURN' && issueTargetLoc.startsWith('车间:')) {
            setIssueTargetLoc('原料库位 R-01');
          }
        }}
        issueRollId={issueRollId}
        onChangeRollId={setIssueRollId}
        issueMachineId={issueMachineId}
        onChangeMachineId={(v) => {
          setIssueMachineId(v);
          if (issueDirection === 'ISSUE' && (!issueTargetLoc || issueTargetLoc.startsWith('车间:'))) {
            setIssueTargetLoc(v.trim() ? `车间:${v.trim()}` : '');
          }
        }}
        issueShiftTeam={issueShiftTeam}
        onChangeShiftTeam={setIssueShiftTeam}
        issueTargetLoc={issueTargetLoc}
        onChangeTargetLoc={setIssueTargetLoc}
        issueOperator={issueOperator}
        onChangeOperator={setIssueOperator}
        issueReason={issueReason}
        onChangeReason={setIssueReason}
        onSubmit={handleSubmitIssue}
        onClose={() => setIssueModalOpen(false)}
      />
    </div>
  );
};
