import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, fmtTime, shortId } from '@static/app/js/util.js';
import {
  SegmentedControl,
  CodeBadge,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';

const EVENT_LABELS: Record<string, string> = {
  MIGRATION_OPENING: '期初迁移',
  CUT_REPORT: '报工记账',
  CUT_REPORT_BATCH: '批量报工',
  REPORT_REVERSE: '报工冲销',
  DEMAND_ADJUSTMENT: '需求调整',
  INSPECTION: '验布入档',
  INVENTORY_COUNT: '盘点',
  INVENTORY_TRANSFER: '移库',
  QUALITY_DISPOSITION: '复检处置',
  REMNANT_ISSUE: '料头领用',
  REMNANT_RECEIPT: '料头入库',
  REMNANT_SCRAP: '料头报废',
  REMNANT_STATUS_ADJUSTMENT: '料头状态调整',
  ROLL_RECEIPT: '母卷入库',
  ROLL_RECEIPT_OR_UPDATE: '母卷入库 / 更新',
  DEMO_RECEIPT: '演示入库',
  DEMO_RESET: '演示重置',
  SYSTEM_UPDATE: '系统更新',
  DEFECT_VOID: '疵点作废'
};

const AGG_LABELS: Record<string, string> = {
  DEMAND: '需求',
  ROLL: '母卷',
  MOTHER_ROLL: '母卷',
  REMNANT: '料头',
  REPORT: '报工单',
  TASK: '任务',
  PLAN: '方案',
  EXECUTION: '执行单',
  CHECKPOINT: '检查点',
  TRANSFER: '移库单',
  COUNT: '盘点单',
  QUALITY: '复检'
};

function eventTagClass(eventType: string): string {
  switch (eventType) {
    case 'ROLL_RECEIPT':
    case 'ROLL_RECEIPT_OR_UPDATE':
    case 'REMNANT_RECEIPT':
    case 'INSPECTION':
      return 'ok';
    case 'CUT_REPORT':
    case 'CUT_REPORT_BATCH':
    case 'INVENTORY_TRANSFER':
    case 'REMNANT_ISSUE':
      return 'run';
    case 'INVENTORY_COUNT':
    case 'QUALITY_DISPOSITION':
    case 'DEMAND_ADJUSTMENT':
    case 'REMNANT_STATUS_ADJUSTMENT':
      return 'warn';
    case 'REPORT_REVERSE':
    case 'REMNANT_SCRAP':
    case 'DEFECT_VOID':
      return 'err';
    default:
      return 'kind';
  }
}

async function loadAllLedgerItems(): Promise<any[]> {
  let items: any[] = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await requestJSON('/api/v2/inventory-ledger?limit=500&after=' + after);
    items = items.concat(page.items || []);
    if (!page.hasMore || !(page.items || []).length) break;
    after = page.nextCursor ?? items[items.length - 1].sequence;
  }
  return items;
}

const asList = (x: any): any[] =>
  Array.isArray(x) ? x : (Object.values(x || {}).find(Array.isArray) as any[]) || [];

type DocTab = 'ledger' | 'transfer' | 'count';

export const DocumentsPage: React.FC = () => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<DocTab>('ledger');
  const [filterEvent, setFilterEvent] = useState<string>('');
  const [filterAgg, setFilterAgg] = useState<string>('');
  const [showOpening, setShowOpening] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, ct, led] = await Promise.all([
        requestJSON('/api/v2/inventory-transfers'),
        requestJSON('/api/v2/inventory-counts'),
        loadAllLedgerItems()
      ]);
      setTransfers(asList(tr));
      setCounts(asList(ct));
      setItems(led);
    } catch (e: any) {
      setError(e.message || '读取库存单据与流水失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const events = useMemo(
    () => [...new Set(items.map((i) => i.eventType).filter(Boolean))],
    [items]
  );
  const aggs = useMemo(
    () => [...new Set(items.map((i) => i.aggregateType).filter(Boolean))],
    [items]
  );
  const openingCount = useMemo(
    () => items.filter((i) => i.eventType === 'MIGRATION_OPENING').length,
    [items]
  );

  const filteredLedger = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter(
      (i) =>
        (showOpening || i.eventType !== 'MIGRATION_OPENING') &&
        (!filterEvent || i.eventType === filterEvent) &&
        (!filterAgg || i.aggregateType === filterAgg) &&
        (!q ||
          [
            i.aggregateId,
            i.businessId,
            i.actor,
            i.transactionId,
            i.eventType,
            EVENT_LABELS[i.eventType],
            ...(i.sourceReportIds || [])
          ].some((v) => String(v || '').toLowerCase().includes(q)))
    );
  }, [items, showOpening, filterEvent, filterAgg, searchQuery]);

  const filteredTransfers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return transfers;
    return transfers.filter((r) => {
      const mats = r.items || r.materials || [];
      return [
        r.id,
        r.documentId,
        r.destination,
        r.reason,
        r.operator,
        ...mats.map((m: any) => `${m.id || m.materialId || ''} ${m.fromLocation || ''}`)
      ].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [transfers, searchQuery]);

  const filteredCounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return counts;
    return counts.filter((r) => {
      const mats = r.items || r.materials || [];
      return [
        r.id,
        r.documentId,
        r.reason,
        r.operator,
        ...mats.map((m: any) => m.id || m.materialId || '')
      ].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [counts, searchQuery]);

  const tabOptions: SegmentedOption<DocTab>[] = useMemo(
    () => [
      { value: 'ledger', label: '库存流水', count: items.length, accent: 'indigo' },
      { value: 'transfer', label: '移库单', count: transfers.length },
      { value: 'count', label: '盘点单', count: counts.length }
    ],
    [items.length, transfers.length, counts.length]
  );

  const shownCount =
    tab === 'ledger'
      ? filteredLedger.length
      : tab === 'transfer'
      ? filteredTransfers.length
      : filteredCounts.length;

  const totalCount =
    tab === 'ledger' ? items.length : tab === 'transfer' ? transfers.length : counts.length;

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>库存单据</h1>
            <span className="mp-page-summary num">
              {items.length} 条流水 · {transfers.length} 张移库单 · {counts.length} 张盘点单
            </span>
          </div>
        </div>

        <div className="mp-filter-toolbar">
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
              aria-label="搜索单据与流水"
              placeholder="搜单号、对象编号、库位、报工单或经办人"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {shownCount} / {totalCount}
          </span>

          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={loadData}>
              刷新单据
            </button>
            <a className="mp-ghost-btn" href="#/reconciliation">
              产出对账
            </a>
            <a className="btn pri" href="#/inventory">
              去库存移库 / 盘点 →
            </a>
          </div>
        </div>

        <div className="mp-doc-subbar">
          <SegmentedControl
            options={tabOptions}
            value={tab}
            onChange={(next) => setTab(next)}
            ariaLabel="切换单据与流水类型"
          />

          {tab === 'ledger' && (
            <div className="mp-doc-ledger-filters">
              <select
                className="field mp-doc-select"
                aria-label="按事件类型筛选"
                value={filterEvent}
                onChange={(e) => setFilterEvent(e.target.value)}
              >
                <option value="">全部事件</option>
                {events.map((e) => (
                  <option key={e} value={e}>
                    {EVENT_LABELS[e] || e}
                  </option>
                ))}
              </select>
              <select
                className="field mp-doc-select"
                aria-label="按对象类型筛选"
                value={filterAgg}
                onChange={(e) => setFilterAgg(e.target.value)}
              >
                <option value="">全部对象</option>
                {aggs.map((a) => (
                  <option key={a} value={a}>
                    {AGG_LABELS[a] || a}
                  </option>
                ))}
              </select>
              <label className="mp-doc-switch-label">
                <input
                  type="checkbox"
                  className="ux-switch"
                  checked={showOpening}
                  onChange={(e) => setShowOpening(e.target.checked)}
                />
                <span>显示期初迁移（{openingCount}）</span>
              </label>
            </div>
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
          <div className="mp-doc-card">
            {filteredLedger.length > 0 ? (
              <>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th className="r">序号</th>
                        <th>时间</th>
                        <th>事件</th>
                        <th>对象</th>
                        <th>对象编号</th>
                        <th>关联报工</th>
                        <th>操作者</th>
                        <th className="r">版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLedger
                        .slice()
                        .reverse()
                        .map((i) => (
                          <tr key={i.sequence}>
                            <td className="r num">{i.sequence}</td>
                            <td className="num">{fmtTime(i.occurredAt)}</td>
                            <td>
                              <span className={`tag ${eventTagClass(i.eventType)}`}>
                                {EVENT_LABELS[i.eventType] || i.eventType}
                              </span>
                            </td>
                            <td>
                              <span className="tag kind">
                                {AGG_LABELS[i.aggregateType] || i.aggregateType}
                              </span>
                            </td>
                            <td>
                              <CodeBadge title={i.aggregateId}>
                                {String(i.aggregateId || '').length > 24
                                  ? shortId(i.aggregateId)
                                  : i.aggregateId}
                              </CodeBadge>
                            </td>
                            <td className="num">
                              {(i.sourceReportIds || []).length > 0 ? (
                                <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                                  {(i.sourceReportIds || []).map((rid: string) => (
                                    <CodeBadge key={rid} title={rid}>
                                      {shortId(rid)}
                                    </CodeBadge>
                                  ))}
                                </div>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                            <td>{i.actor || '—'}</td>
                            <td className="r num">
                              {i.beforeVersion} → {i.afterVersion}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <div className="mp-doc-foot">
                  <span className="num">
                    显示 {filteredLedger.length} / 共 {items.length} 条流水
                  </span>
                  <span>
                    完整面积核对与 CSV 导出请见{' '}
                    <a href="#/reconciliation">产出对账 →</a>
                  </span>
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>没有符合条件的库存流水</strong>
                可尝试清空搜索词、调整事件/对象筛选或开启「显示期初迁移」。
              </div>
            )}
          </div>
        ) : tab === 'transfer' ? (
          <div className="mp-doc-card">
            {filteredTransfers.length > 0 ? (
              <>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>移库单号</th>
                        <th>过账时间</th>
                        <th>目标库位</th>
                        <th className="r">项数</th>
                        <th>移库材料明细</th>
                        <th>原因</th>
                        <th>经办人</th>
                        <th className="r">版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTransfers
                        .slice()
                        .reverse()
                        .map((r, idx) => {
                          const mats = r.items || r.materials || [];
                          const summary = mats
                            .map(
                              (m: any) =>
                                `${m.id || m.materialId || '—'}${
                                  m.fromLocation
                                    ? ` (${m.fromLocation}→${
                                        r.destination || m.toLocation || ''
                                      })`
                                    : ''
                                }`
                            )
                            .join('、');
                          return (
                            <tr key={r.id || r.documentId || idx}>
                              <td>
                                <CodeBadge title={r.id || r.documentId}>
                                  {shortId(r.id || r.documentId)}
                                </CodeBadge>
                              </td>
                              <td className="num">
                                {fmtTime(r.postedAt || r.createdAt || r.at)}
                              </td>
                              <td>
                                <span className="tag ok">{r.destination || '—'}</span>
                              </td>
                              <td className="r num">{mats.length}</td>
                              <td className="mp-doc-detail-cell num">{summary || '—'}</td>
                              <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                              <td>{r.operator || '—'}</td>
                              <td className="r num">
                                {r.beforeRevision != null && r.afterRevision != null
                                  ? `${r.beforeRevision} → ${r.afterRevision}`
                                  : r.revision ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="mp-doc-foot">
                  <span className="num">
                    显示 {filteredTransfers.length} / 共 {transfers.length} 张移库单
                  </span>
                  <span>
                    完整面积核对与 CSV 导出请见{' '}
                    <a href="#/reconciliation">产出对账 →</a>
                  </span>
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无移库单据</strong>
                可在「母卷与料头台账」勾选在库材料后发起批量移库。
              </div>
            )}
          </div>
        ) : (
          <div className="mp-doc-card">
            {filteredCounts.length > 0 ? (
              <>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>盘点单号</th>
                        <th>过账时间</th>
                        <th className="r">盘点项数</th>
                        <th>实测与差异明细</th>
                        <th>盘点原因</th>
                        <th>经办人</th>
                        <th className="r">版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCounts
                        .slice()
                        .reverse()
                        .map((r, idx) => {
                          const mats = r.items || r.materials || [];
                          const summary = mats
                            .map(
                              (m: any) =>
                                `${m.id || m.materialId || '—'}: ${
                                  m.present === false
                                    ? '未见实物'
                                    : `${m.actualWidth ?? m.width ?? '—'}×${
                                        m.actualLength ?? m.length ?? '—'
                                      } mm`
                                }`
                            )
                            .join('；');
                          return (
                            <tr key={r.id || r.documentId || idx}>
                              <td>
                                <CodeBadge title={r.id || r.documentId}>
                                  {shortId(r.id || r.documentId)}
                                </CodeBadge>
                              </td>
                              <td className="num">
                                {fmtTime(r.postedAt || r.createdAt || r.at)}
                              </td>
                              <td className="r num">{mats.length}</td>
                              <td className="mp-doc-detail-cell num">{summary || '—'}</td>
                              <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                              <td>{r.operator || '—'}</td>
                              <td className="r num">
                                {r.beforeRevision != null && r.afterRevision != null
                                  ? `${r.beforeRevision} → ${r.afterRevision}`
                                  : r.revision ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="mp-doc-foot">
                  <span className="num">
                    显示 {filteredCounts.length} / 共 {counts.length} 张盘点单
                  </span>
                  <span>
                    完整面积核对与 CSV 导出请见{' '}
                    <a href="#/reconciliation">产出对账 →</a>
                  </span>
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无盘点单据</strong>
                可在「母卷与料头台账」勾选在库材料后发起实物库存盘点。
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
