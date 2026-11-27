import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildTxns,
  categoryOf,
  computeDailyBuckets,
  computeLedgerKpis,
  computeTopObjects,
  createEmptyReceiptRoll,
  diffLine,
  eventTagClass,
  filterCounts,
  filterIssues,
  filterLedgerLines,
  filterReceipts,
  filterTransfers,
  flatten,
  txnFacts,
  validateAndBuildIssuePayload,
  validateAndBuildReceiptPayload
} from '../../DocumentsPage';
import { DocumentReceiptModal } from '../DocumentReceiptModal';
import { DocumentIssueModal } from '../DocumentIssueModal';
import { DocumentTimelineView } from '../DocumentTimelineView';

describe('DocumentsPage 流水字典、Diff 与事务聚合', () => {
  it('categoryOf 与 eventTagClass 正确分类业务事件及特例', () => {
    expect(categoryOf('RECEIPT_IN')).toBe('receipt');
    expect(eventTagClass('RECEIPT_IN')).toBe('ok');
    expect(categoryOf('CUT_REPORT')).toBe('report');
    expect(eventTagClass('CUT_REPORT')).toBe('run');
    expect(categoryOf('MATERIAL_ISSUE')).toBe('remnant');
    expect(eventTagClass('MATERIAL_ISSUE')).toBe('run');
    expect(categoryOf('DEMAND_ADJUSTMENT')).toBe('demand');
    expect(categoryOf('INSPECTION')).toBe('quality');
    expect(eventTagClass('INSPECTION')).toBe('warn');
    expect(categoryOf('REPORT_REVERSE')).toBe('reverse');
    expect(eventTagClass('REPORT_REVERSE')).toBe('err');
    expect(categoryOf('REMNANT_SCRAP')).toBe('remnant');
    expect(eventTagClass('REMNANT_SCRAP')).toBe('run');
    expect(eventTagClass('UNKNOWN_EVENT')).toBe('kind');
  });

  it('flatten 与 diffLine 过滤噪点字段、展平一层嵌套并区分创建与变更', () => {
    const flat = flatten({
      id: 'skip-id',
      createdAt: 123,
      payloadJson: '{}',
      width: 1650,
      items: [1, 2, 3],
      meta: { color: '藏青', updatedAt: 999, deep: { ignored: true } }
    });
    expect(flat).toEqual({
      width: 1650,
      items: '3 项',
      'meta.color': '藏青'
    });

    const creationDiff = diffLine({
      beforeJson: null,
      afterJson: JSON.stringify({ width: 1650, totalLength: 60000, undocumentedField: 'x' })
    });
    expect(creationDiff.map((d) => d.key)).toEqual(['width', 'totalLength']);

    const updateDiff = diffLine({
      beforeJson: JSON.stringify({ currentRemainingLength: 50000, status: 'IN_STOCK', customField: 'a' }),
      afterJson: JSON.stringify({ currentRemainingLength: 42000, status: 'IN_STOCK', customField: 'b' })
    });
    expect(updateDiff.map((d) => d.key)).toEqual(['currentRemainingLength', 'customField']);
    expect(updateDiff[0].before).toBe(50000);
    expect(updateDiff[0].after).toBe(42000);
  });

  it('txnFacts 与 buildTxns 聚合同一事务多条流水并按 maxSeq 降序输出', () => {
    const now = Date.now();
    const lines = [
      {
        id: 'L1',
        transactionId: 'TXN-1',
        sequence: 10,
        occurredAt: now - 5000,
        eventType: 'CUT_REPORT',
        aggregateType: 'ROLL',
        aggregateId: 'R-001',
        actor: '王工',
        beforeVersion: 1,
        afterVersion: 2,
        beforeJson: JSON.stringify({ currentRemainingLength: 50000, usedLength: 10000, totalLength: 60000 }),
        afterJson: JSON.stringify({ currentRemainingLength: 45000, usedLength: 15000, totalLength: 60000 })
      },
      {
        id: 'L2',
        transactionId: 'TXN-1',
        sequence: 11,
        occurredAt: now - 4000,
        eventType: 'CUT_REPORT',
        aggregateType: 'REMNANT',
        aggregateId: 'REM-9',
        actor: '王工',
        beforeVersion: 0,
        afterVersion: 1,
        beforeJson: null,
        afterJson: JSON.stringify({ area: 1.25 })
      },
      {
        id: 'L3',
        transactionId: 'TXN-1',
        sequence: 12,
        occurredAt: now - 3000,
        eventType: 'CUT_REPORT',
        aggregateType: 'DEMAND',
        aggregateId: 'D-1',
        actor: '王工',
        beforeVersion: 1,
        afterVersion: 2,
        beforeJson: JSON.stringify({ completed: 2 }),
        afterJson: JSON.stringify({ completed: 6 })
      },
      {
        id: 'L4',
        transactionId: 'TXN-2',
        sequence: 20,
        occurredAt: now,
        eventType: 'RECEIPT_IN',
        aggregateType: 'ROLL',
        aggregateId: 'R-002',
        actor: '仓管',
        beforeVersion: 0,
        afterVersion: 1,
        beforeJson: null,
        afterJson: JSON.stringify({ width: 1650, totalLength: 60000 })
      }
    ];

    const facts1 = txnFacts(lines.slice(0, 3));
    expect(facts1.join('|')).toContain('R-001 余长 50 → 45 m');
    expect(facts1.join('|')).toContain('新增料头 1 块 · 1.25 m²');
    expect(facts1.join('|')).toContain('需求完成 +4 件');

    const txns = buildTxns(lines);
    expect(txns).toHaveLength(2);
    expect(txns[0].id).toBe('TXN-2');
    expect(txns[1].maxSeq).toBe(12);
    expect(txns[1].aggCounts).toEqual([['ROLL', 1], ['REMNANT', 1], ['DEMAND', 1]]);
  });

  it('computeLedgerKpis / computeDailyBuckets / computeTopObjects 与过滤函数口径准确', () => {
    const now = Date.now();
    const lines = [
      {
        transactionId: 'T-OPEN',
        eventType: 'MIGRATION_OPENING',
        aggregateType: 'ROLL',
        aggregateId: 'R-OLD',
        occurredAt: now
      },
      {
        transactionId: 'T-REC',
        eventType: 'RECEIPT_IN',
        aggregateType: 'ROLL',
        aggregateId: 'R-100',
        occurredAt: now,
        beforeJson: null,
        afterJson: JSON.stringify({ totalLength: 60000 })
      },
      {
        transactionId: 'T-REP',
        eventType: 'CUT_REPORT',
        aggregateType: 'ROLL',
        aggregateId: 'R-100',
        occurredAt: now,
        beforeJson: JSON.stringify({ usedLength: 0 }),
        afterJson: JSON.stringify({ usedLength: 12000 })
      },
      {
        transactionId: 'T-CHK',
        eventType: 'SYSTEM_UPDATE',
        aggregateType: 'CHECKPOINT',
        aggregateId: 'CP-1',
        occurredAt: now
      }
    ];

    const rangeLines = lines.filter((l) => l.eventType !== 'MIGRATION_OPENING');
    const kpis = computeLedgerKpis(rangeLines);
    expect(kpis.receipt).toBe(1);
    expect(kpis.receiptLen).toBe(60000);
    expect(kpis.consumed).toBe(12000);
    expect(kpis.report).toBe(1);

    const daily = computeDailyBuckets(lines, now);
    expect(daily.rows).toHaveLength(14);
    expect(daily.rows[13].count).toBe(3); // T-OPEN excluded

    const top = computeTopObjects(rangeLines);
    expect(top.some((o) => o.type === 'CHECKPOINT')).toBe(false);
    expect(top[0]).toMatchObject({ type: 'ROLL', id: 'R-100', count: 2 });

    expect(
      filterLedgerLines(lines, rangeLines, {
        showOpening: false,
        category: '',
        filterAgg: '',
        searchQuery: ''
      })
    ).toHaveLength(3);
    expect(
      filterLedgerLines(lines, rangeLines, {
        showOpening: true,
        category: '',
        filterAgg: '',
        searchQuery: ''
      })
    ).toHaveLength(4);

    const issues = [
      { id: 'I1', direction: 'ISSUE', rollId: 'R-1', machineId: '裁床-01' },
      { id: 'I2', direction: 'RETURN', rollId: 'R-2', targetLocation: 'R-02' }
    ];
    expect(filterIssues(issues, 'ISSUE', '')).toHaveLength(1);
    expect(filterIssues(issues, 'ALL', 'R-02')).toHaveLength(1);
    expect(filterTransfers([{ id: 'TR1', destination: 'A区', items: [] }], 'A区')).toHaveLength(1);
    expect(filterCounts([{ id: 'CT1', reason: '月度盘点', items: [] }], '月度')).toHaveLength(1);
    expect(filterReceipts([{ id: 'RC1', supplierName: '华联', lines: [] }], '华联')).toHaveLength(1);
  });

  it('validateAndBuildReceiptPayload 与 validateAndBuildIssuePayload 拦截必填缺口并组装合法载荷', () => {
    const roll = createEmptyReceiptRoll();
    const badHeader = validateAndBuildReceiptPayload({
      supplierName: '',
      deliveryNoteNo: 'DN-1',
      operator: '王工',
      inspector: '',
      remarks: '',
      rolls: [roll]
    });
    expect(badHeader.ok).toBe(false);

    const badInspector = validateAndBuildReceiptPayload({
      supplierName: '华联',
      deliveryNoteNo: 'DN-1',
      operator: '王工',
      inspector: '',
      remarks: '',
      rolls: [{ ...roll, inspectionStatus: 'PASSED' }]
    });
    expect(badInspector.ok).toBe(false);
    expect(badInspector.error).toContain('质检员');

    const okReceipt = validateAndBuildReceiptPayload({
      supplierName: '华联',
      deliveryNoteNo: 'DN-1',
      operator: '王工',
      inspector: '李检',
      remarks: '首批',
      rolls: [{ ...roll, inspectionStatus: 'PASSED', batchNo: 'B-01' }]
    });
    expect(okReceipt.ok).toBe(true);
    if (okReceipt.ok) {
      expect(okReceipt.payload.rolls).toHaveLength(1);
      expect(okReceipt.payload.inspector).toBe('李检');
    }

    const badIssue = validateAndBuildIssuePayload({
      direction: 'ISSUE',
      rollId: 'R-1',
      machineId: '',
      shiftTeam: '',
      operator: '陈工',
      targetLocation: '',
      reason: ''
    });
    expect(badIssue.ok).toBe(false);

    const okIssue = validateAndBuildIssuePayload({
      direction: 'ISSUE',
      rollId: 'R-1',
      machineId: '裁床-01',
      shiftTeam: '甲班',
      operator: '陈工',
      targetLocation: '',
      reason: ''
    });
    expect(okIssue.ok).toBe(true);
    if (okIssue.ok) {
      expect(okIssue.payload.targetLocation).toBe('车间:裁床-01');
      expect(okIssue.payload.reason).toBe('车间领料投产');
    }
  });

  it('弹窗与流水视图 SSR 渲染保留全部 #rec-* / #iss-* E2E 选择器契约', () => {
    const passedRoll = { ...createEmptyReceiptRoll(), inspectionStatus: 'PASSED' as const };
    const receiptHtml = renderToStaticMarkup(
      React.createElement(DocumentReceiptModal, {
        open: true,
        submitting: false,
        supplierName: '华联',
        onChangeSupplierName: () => {},
        deliveryNoteNo: 'DN-01',
        onChangeDeliveryNoteNo: () => {},
        receiptOperator: '王工',
        onChangeReceiptOperator: () => {},
        receiptInspector: '李检',
        onChangeReceiptInspector: () => {},
        receiptRemarks: '',
        onChangeReceiptRemarks: () => {},
        receiptRolls: [passedRoll],
        onChangeReceiptRolls: () => {},
        onSubmit: () => {},
        onClose: () => {}
      })
    );
    for (const id of [
      'id="rec-supplier"',
      'id="rec-delivery"',
      'id="rec-operator"',
      'id="rec-remarks"',
      'id="rec-inspector"'
    ]) {
      expect(receiptHtml).toContain(id);
    }

    const issueHtml = renderToStaticMarkup(
      React.createElement(DocumentIssueModal, {
        open: true,
        submitting: false,
        rolls: [
          { rollId: 'R-OK', rollModel: 'M1', inspectionStatus: 'PASSED', totalLength: 50000 },
          { rollId: 'R-WAIT', rollModel: 'M1', inspectionStatus: 'PENDING', totalLength: 50000 }
        ],
        issueDirection: 'ISSUE',
        onChangeDirection: () => {},
        issueRollId: 'R-OK',
        onChangeRollId: () => {},
        issueMachineId: '裁床-01',
        onChangeMachineId: () => {},
        issueShiftTeam: '',
        onChangeShiftTeam: () => {},
        issueTargetLoc: '车间:裁床-01',
        onChangeTargetLoc: () => {},
        issueOperator: '陈工',
        onChangeOperator: () => {},
        issueReason: '',
        onChangeReason: () => {},
        onSubmit: () => {},
        onClose: () => {}
      })
    );
    for (const id of [
      'id="iss-roll"',
      'id="iss-machine"',
      'id="iss-shift"',
      'id="iss-loc"',
      'id="iss-operator"',
      'id="iss-reason"',
      '未验布放行，禁领'
    ]) {
      expect(issueHtml).toContain(id);
    }

    const timelineHtml = renderToStaticMarkup(
      React.createElement(DocumentTimelineView, {
        day: '',
        onSelectDay: () => {},
        category: '',
        onSelectCategory: () => {},
        filterAgg: '',
        onSelectFilterAgg: () => {},
        view: 'txn',
        onChangeView: () => {},
        showOpening: false,
        onToggleShowOpening: () => {},
        searchQuery: '',
        onChangeSearchQuery: () => {},
        focus: null,
        onChangeFocus: () => {},
        kpis: computeLedgerKpis([]),
        daily: computeDailyBuckets([]),
        topObjects: [],
        aggs: [],
        openingCount: 0,
        filteredLedger: [],
        txns: [],
        focusLines: [],
        transfersCount: 0,
        countsCount: 0
      })
    );
    expect(timelineHtml).toContain('近 14 天业务量');
    expect(timelineHtml).toContain('变动最频繁的对象');
  });
});
