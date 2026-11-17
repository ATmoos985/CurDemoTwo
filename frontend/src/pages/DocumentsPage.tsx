import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, fmtTime, shortId } from '@static/app/js/util.js';

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

export const DocumentsPage: React.FC = () => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'ledger' | 'transfer' | 'count'>('ledger');
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
            ...(i.sourceReportIds || [])
          ].some((v) => String(v || '').toLowerCase().includes(q)))
    );
  }, [items, showOpening, filterEvent, filterAgg, searchQuery]);

  return (
    <div className="react-page">
      <div className="ph">
        <h1>库存单据</h1>
        <span className="crumb">移库单、盘点单与变更流水</span>
        <div className="hub-tabs" role="navigation" aria-label="材料与台账视图">
          <a href="#/inventory">实物库存</a>
          <a href="#/inspection">跑布验疵</a>
          <a className="on" href="#/documents">
            移库与盘点单
          </a>
          <a href="#/analysis">产出对账</a>
        </div>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={loadData}>
          刷新单据
        </button>
        <a className="btn" href="#/inventory">
          去库存勾选材料移库 / 盘点
        </a>
      </div>

      <div className="toolbar">
        <div className="seg">
          <button
            type="button"
            className={tab === 'ledger' ? 'on' : ''}
            onClick={() => setTab('ledger')}
          >
            库存流水
          </button>
          <button
            type="button"
            className={tab === 'transfer' ? 'on' : ''}
            onClick={() => setTab('transfer')}
          >
            移库 {transfers.length}
          </button>
          <button
            type="button"
            className={tab === 'count' ? 'on' : ''}
            onClick={() => setTab('count')}
          >
            盘点 {counts.length}
          </button>
        </div>

        {tab === 'ledger' && (
          <>
            <span className="vsep" />
            <select
              className="field"
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
              className="field"
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
            <label
              className="muted"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12.5
              }}
            >
              <input
                type="checkbox"
                checked={showOpening}
                onChange={(e) => setShowOpening(e.target.checked)}
              />
              显示期初迁移（{openingCount}）
            </label>
            <span className="sp" />
            <input
              className="field"
              placeholder="对象编号 / 报工单 / 操作者"
              style={{ width: 220 }}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </>
        )}
      </div>

      <div className="body">
        {error ? (
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="loading">正在读取库存单据与不可变流水…</div>
        ) : tab === 'ledger' ? (
          filteredLedger.length > 0 ? (
            <>
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
                        <td>{EVENT_LABELS[i.eventType] || i.eventType}</td>
                        <td>{AGG_LABELS[i.aggregateType] || i.aggregateType}</td>
                        <td className="num" title={i.aggregateId}>
                          {String(i.aggregateId || '').length > 24
                            ? shortId(i.aggregateId)
                            : i.aggregateId}
                        </td>
                        <td className="num">
                          {(i.sourceReportIds || []).map(shortId).join(', ') || '—'}
                        </td>
                        <td>{i.actor || '—'}</td>
                        <td className="r num">
                          {i.beforeVersion} → {i.afterVersion}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <div className="pager">
                <span>
                  显示 {filteredLedger.length} / 共 {items.length} 条
                </span>
                <span>
                  完整面积核对与 CSV 导出请见 <a href="#/analysis">产出对账</a>
                </span>
              </div>
            </>
          ) : (
            <div className="empty">没有符合条件的流水</div>
          )
        ) : tab === 'transfer' ? (
          transfers.length > 0 ? (
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
                {transfers
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
                        <td className="num">{shortId(r.id || r.documentId)}</td>
                        <td className="num">
                          {fmtTime(r.postedAt || r.createdAt || r.at)}
                        </td>
                        <td>
                          <span className="tag ok">{r.destination || '—'}</span>
                        </td>
                        <td className="r num">{mats.length}</td>
                        <td className="wrap num">{summary || '—'}</td>
                        <td className="wrap">{r.reason || '—'}</td>
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
          ) : (
            <div className="empty">暂无移库单据</div>
          )
        ) : counts.length > 0 ? (
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
              {counts
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
                      <td className="num">{shortId(r.id || r.documentId)}</td>
                      <td className="num">
                        {fmtTime(r.postedAt || r.createdAt || r.at)}
                      </td>
                      <td className="r num">{mats.length}</td>
                      <td className="wrap num">{summary || '—'}</td>
                      <td className="wrap">{r.reason || '—'}</td>
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
        ) : (
          <div className="empty">暂无盘点单据</div>
        )}
      </div>
    </div>
  );
};
