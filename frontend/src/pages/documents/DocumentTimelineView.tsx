import React from 'react';
import { fmtTime, shortId, fmtN } from '../../lib/core/util.js';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../../components/ui/MagpiePrimitives';
import {
  AGG_LABELS,
  CATEGORY_LABELS,
  Category,
  DailyBucketResult,
  EVENT_LABELS,
  Focus,
  LedgerKpis,
  TopObjectItem,
  Txn,
  ViewKey,
  actorText,
  diffLine,
  eventTagClass,
  fmtObjId,
  fmtVal,
  objectHref
} from './documentLedgerUtils';

interface DocumentTimelineViewProps {
  day: string;
  onSelectDay: (d: string) => void;
  category: Category | '';
  onSelectCategory: (c: Category | '') => void;
  filterAgg: string;
  onSelectFilterAgg: (agg: string) => void;
  view: ViewKey;
  onChangeView: (v: ViewKey) => void;
  showOpening: boolean;
  onToggleShowOpening: (checked: boolean) => void;
  searchQuery: string;
  onChangeSearchQuery: (q: string) => void;
  focus: Focus;
  onChangeFocus: (f: Focus) => void;
  kpis: LedgerKpis;
  daily: DailyBucketResult;
  topObjects: TopObjectItem[];
  aggs: string[];
  openingCount: number;
  filteredLedger: any[];
  txns: Txn[];
  focusLines: any[];
  transfersCount: number;
  countsCount: number;
}

export const DocumentTimelineView: React.FC<DocumentTimelineViewProps> = ({
  day,
  onSelectDay,
  category,
  onSelectCategory,
  filterAgg,
  onSelectFilterAgg,
  view,
  onChangeView,
  showOpening,
  onToggleShowOpening,
  searchQuery,
  onChangeSearchQuery,
  focus,
  onChangeFocus,
  kpis,
  daily,
  topObjects,
  aggs,
  openingCount,
  filteredLedger,
  txns,
  focusLines,
  transfersCount,
  countsCount
}) => {
  const toggleCategory = (c: Category) => onSelectCategory(category === c ? '' : c);
  const traceObj = (type: string, id: string) => onChangeFocus({ kind: 'obj', type, id });

  const viewOptions: SegmentedOption<ViewKey>[] = [
    { value: 'txn', label: '按业务事务', count: txns.length, title: '一次报工 / 入库 / 调整合并为一行' },
    { value: 'line', label: '按变动明细', count: filteredLedger.length, title: '每个对象的每次版本变动一行' }
  ];

  const activeChips: { key: string; text: string; clear: () => void }[] = [];
  if (day) activeChips.push({ key: 'day', text: `日期 ${day}`, clear: () => onSelectDay('') });
  if (category) activeChips.push({ key: 'cat', text: CATEGORY_LABELS[category], clear: () => onSelectCategory('') });
  if (filterAgg) activeChips.push({ key: 'agg', text: `对象 ${AGG_LABELS[filterAgg] || filterAgg}`, clear: () => onSelectFilterAgg('') });
  if (searchQuery.trim()) activeChips.push({ key: 'q', text: `搜索「${searchQuery.trim()}」`, clear: () => onChangeSearchQuery('') });

  const kpiCard = (
    c: Category | '',
    label: string,
    value: number,
    unit: string,
    sub: React.ReactNode,
    tone?: 'err'
  ) => (
    <button
      type="button"
      key={c || 'all'}
      className={`mp-kpi ${category === c ? 'on' : ''}`}
      data-tone={tone && value > 0 ? tone : undefined}
      onClick={() => (c ? toggleCategory(c) : onSelectCategory(''))}
      aria-pressed={category === c}
      title={c ? `只看「${CATEGORY_LABELS[c]}」，再次点击取消` : '查看全部业务'}
    >
      <span className="mp-kpi-label">{label}</span>
      <span className="mp-kpi-value num">
        {value}
        <small>{unit}</small>
      </span>
      <span className="mp-kpi-sub num">{sub}</span>
    </button>
  );

  const renderChanges = (line: any) => {
    const changes = diffLine(line);
    if (!changes.length) return <span className="muted">无字段变化</span>;
    const creation = !line.beforeJson;
    return (
      <ul className="mp-diff-list">
        {changes.slice(0, 8).map((c) => (
          <li key={c.key}>
            <span className="mp-diff-key">{c.label}</span>
            {creation ? (
              <span className="num">{fmtVal(c.after, c.unit)}</span>
            ) : (
              <span className="num">
                <span className="mp-diff-before">{fmtVal(c.before, c.unit)}</span>
                <span className="mp-diff-arrow">→</span>
                <b>{fmtVal(c.after, c.unit)}</b>
              </span>
            )}
          </li>
        ))}
        {changes.length > 8 && <li className="muted">另有 {changes.length - 8} 项字段变化</li>}
      </ul>
    );
  };

  const renderFocus = () => {
    if (!focus) return null;
    const sorted = focusLines.slice().sort((a, b) => a.sequence - b.sequence);
    const title =
      focus.kind === 'txn'
        ? '业务事务明细'
        : focus.kind === 'obj'
        ? `对象追溯 · ${AGG_LABELS[focus.type] || focus.type || '对象'}`
        : '报工单追溯';
    const href = focus.kind === 'obj' ? objectHref(focus.type, focus.id) : null;
    return (
      <aside className="mp-doc-drawer" aria-label={title}>
        <div className="mp-doc-drawer-head">
          <div>
            <span className="mp-doc-drawer-kicker">{title}</span>
            <strong className="num" title={focus.id}>
              {focus.kind === 'txn' ? shortId(focus.id) : focus.id}
            </strong>
            <span className="mp-doc-drawer-meta num">
              共 {sorted.length} 条变动
              {sorted.length > 0 && ` · ${fmtTime(sorted[0].occurredAt)} 起`}
            </span>
          </div>
          <div className="mp-doc-drawer-actions">
            {href && (
              <a className="mp-ghost-btn" href={href}>
                去台账
              </a>
            )}
            {focus.kind === 'obj' && focus.type === 'ROLL' && (
              <a className="mp-ghost-btn" href={`#/inspection/${encodeURIComponent(focus.id)}`}>
                验布
              </a>
            )}
            <button type="button" className="mp-ghost-btn" onClick={() => onChangeFocus(null)} aria-label="关闭追溯面板">
              关闭
            </button>
          </div>
        </div>
        <ol className="mp-trace-list">
          {sorted.map((l) => (
            <li key={l.id || l.sequence} className="mp-trace-item">
              <div className="mp-trace-top">
                <span className={`tag ${eventTagClass(l.eventType)}`}>{EVENT_LABELS[l.eventType] || l.eventType}</span>
                {focus.kind !== 'obj' ? (
                  <button
                    type="button"
                    className="mp-link-btn num"
                    onClick={() => traceObj(l.aggregateType, l.aggregateId)}
                    title="追溯该对象全部历史"
                  >
                    {AGG_LABELS[l.aggregateType] || l.aggregateType} {fmtObjId(l.aggregateId)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mp-link-btn num"
                    onClick={() => onChangeFocus({ kind: 'txn', id: l.transactionId || l.id })}
                    title="查看同一事务内的全部变动"
                  >
                    事务 {shortId(l.transactionId)}
                  </button>
                )}
                <span className="mp-trace-time num">
                  #{l.sequence} · {fmtTime(l.occurredAt)}
                </span>
              </div>
              {renderChanges(l)}
              <div className="mp-trace-foot num">
                {actorText(l.actor)} · 版本 {l.beforeVersion} → {l.afterVersion}
                {(l.sourceReportIds || []).map((rid: string) => (
                  <button
                    key={rid}
                    type="button"
                    className="mp-link-btn"
                    onClick={() => onChangeFocus({ kind: 'report', id: rid })}
                    title={rid}
                  >
                    报工 {shortId(rid)}
                  </button>
                ))}
              </div>
            </li>
          ))}
          {sorted.length === 0 && <li className="mp-empty-inline">未找到该对象的库存流水。</li>}
        </ol>
      </aside>
    );
  };

  const objButton = (type: string, id: string) => (
    <button
      type="button"
      className="mp-link-btn num"
      title={`追溯 ${id} 的全部历史`}
      onClick={(e) => {
        e.stopPropagation();
        traceObj(type, id);
      }}
    >
      {fmtObjId(id)}
    </button>
  );

  const emptyLedger = (
    <div className="mp-empty-inline" style={{ padding: 36 }}>
      <strong>当前条件下没有库存流水</strong>
      可放宽时间范围（如切到「全部」）、取消上方业务卡片筛选或清空搜索词。
    </div>
  );

  const renderLedger = () => {
    if (view === 'txn') {
      if (!txns.length) return emptyLedger;
      return (
        <div className="mp-table-scroll">
          <table className="t mp-doc-txn-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>业务</th>
                <th>业务单号</th>
                <th>主对象</th>
                <th>影响范围</th>
                <th>关键变化</th>
                <th>经办</th>
                <th className="r">版本</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr
                  key={t.id}
                  className={`mp-row-link ${focus?.kind === 'txn' && focus.id === t.id ? 'sel' : ''}`}
                  onClick={() => onChangeFocus({ kind: 'txn', id: t.id })}
                >
                  <td className="num">{fmtTime(t.occurredAt)}</td>
                  <td>
                    <span className={`tag ${eventTagClass(t.eventType)}`}>{EVENT_LABELS[t.eventType] || t.eventType}</span>
                  </td>
                  <td>
                    {t.businessId ? <CodeBadge title={t.businessId}>{t.businessId.length > 24 ? shortId(t.businessId) : t.businessId}</CodeBadge> : <span className="muted">—</span>}
                  </td>
                  <td>{t.primary ? objButton(t.primary.type, t.primary.id) : '—'}</td>
                  <td className="mp-doc-agg-cell">
                    {t.aggCounts.map(([type, n]) => (
                      <span key={type} className="mp-agg-chip num">
                        {AGG_LABELS[type] || type} {n}
                      </span>
                    ))}
                  </td>
                  <td className="mp-doc-detail-cell num">
                    {t.facts.length ? t.facts.join('；') : <span className="muted">{t.lines.length} 条变动</span>}
                  </td>
                  <td>{actorText(t.actor)}</td>
                  <td className="r num">
                    {t.beforeVersion} → {t.afterVersion}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (!filteredLedger.length) return emptyLedger;
    return (
      <div className="mp-table-scroll">
        <table className="t">
          <thead>
            <tr>
              <th className="r">序号</th>
              <th>时间</th>
              <th>事件</th>
              <th>对象</th>
              <th>对象编号</th>
              <th>字段变化</th>
              <th>关联报工</th>
              <th>经办</th>
              <th className="r">版本</th>
            </tr>
          </thead>
          <tbody>
            {filteredLedger
              .slice()
              .reverse()
              .map((i) => {
                const changes = diffLine(i);
                return (
                  <tr
                    key={i.sequence}
                    className={`mp-row-link ${focus?.kind === 'obj' && focus.id === i.aggregateId ? 'sel' : ''}`}
                    onClick={() => traceObj(i.aggregateType, i.aggregateId)}
                  >
                    <td className="r num">{i.sequence}</td>
                    <td className="num">{fmtTime(i.occurredAt)}</td>
                    <td>
                      <span className={`tag ${eventTagClass(i.eventType)}`}>{EVENT_LABELS[i.eventType] || i.eventType}</span>
                    </td>
                    <td>
                      <span className="tag kind">{AGG_LABELS[i.aggregateType] || i.aggregateType}</span>
                    </td>
                    <td>{objButton(i.aggregateType, i.aggregateId)}</td>
                    <td className="mp-doc-detail-cell num">
                      {changes.length
                        ? changes
                            .slice(0, 3)
                            .map((c) =>
                              i.beforeJson
                                ? `${c.label} ${fmtVal(c.before, c.unit)}→${fmtVal(c.after, c.unit)}`
                                : `${c.label} ${fmtVal(c.after, c.unit)}`
                            )
                            .join('；') + (changes.length > 3 ? ` 等 ${changes.length} 项` : '')
                        : '—'}
                    </td>
                    <td className="num">
                      {(i.sourceReportIds || []).length > 0 ? (
                        <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {(i.sourceReportIds || []).map((rid: string) => (
                            <button
                              key={rid}
                              type="button"
                              className="mp-link-btn"
                              title={rid}
                              onClick={(e) => {
                                e.stopPropagation();
                                onChangeFocus({ kind: 'report', id: rid });
                              }}
                            >
                              {shortId(rid)}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{actorText(i.actor)}</td>
                    <td className="r num">
                      {i.beforeVersion} → {i.afterVersion}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <div className="mp-kpi-row" role="group" aria-label="库存业务概况，点击卡片筛选">
        {kpiCard('', day ? `${day} 业务事务` : '业务事务', kpis.total, '笔', `${kpis.lines} 条对象变动`)}
        {kpiCard('receipt', '母卷入库', kpis.receipt, '卷', `合计 ${fmtN(kpis.receiptLen / 1000, 1)} m`)}
        {kpiCard('report', '报工记账', kpis.report, '单', `耗用母卷 ${fmtN(kpis.consumed / 1000, 1)} m · 新增料头 ${kpis.newRem} 块`)}
        {kpiCard('remnant', '料头流转', kpis.remnant, '次', `领用 ${kpis.remIssue} · 报废 ${kpis.remScrap}`)}
        {kpiCard('demand', '需求调整', kpis.demand, '笔', `涉及需求行 ${kpis.demandRows}`)}
        {kpiCard('quality', '验布 / 盘点 / 移库', kpis.quality, '笔', `移库单 ${transfersCount} · 盘点单 ${countsCount}`)}
        {kpiCard('reverse', '冲销 / 作废', kpis.reverse, '笔', kpis.reverse ? '需关注原因' : '无异常冲销', 'err')}
      </div>

      <div className="mp-doc-insight">
        <section className="mp-doc-panel" aria-label="近 14 天业务量">
          <div className="mp-doc-panel-head">
            <strong>近 14 天业务量</strong>
            <span className="muted">按事务计 · 点柱子筛选当天</span>
          </div>
          <div className="mp-day-chart">
            {daily.rows.map((r) => (
              <button
                type="button"
                key={r.key}
                className={`mp-day-col ${day === r.key ? 'on' : ''}`}
                onClick={() => onSelectDay(day === r.key ? '' : r.key)}
                title={`${r.key}：${r.count} 笔事务`}
                disabled={r.count === 0}
              >
                <span className="mp-day-count num">{r.count || ''}</span>
                <span className="mp-day-bar" style={{ height: `${(r.count / daily.max) * 100}%` }} />
                <span className="mp-day-label num">{r.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="mp-doc-panel" aria-label="变动最频繁的对象">
          <div className="mp-doc-panel-head">
            <strong>变动最频繁的对象</strong>
            <span className="muted">点击追溯全部历史</span>
          </div>
          {topObjects.length ? (
            <ul className="mp-top-list">
              {topObjects.map((o) => (
                <li key={o.type + o.id}>
                  <button type="button" className="mp-top-item" onClick={() => traceObj(o.type, o.id)}>
                    <span className="tag kind">{AGG_LABELS[o.type] || o.type}</span>
                    <span className="num mp-top-id" title={o.id}>
                      {fmtObjId(o.id)}
                    </span>
                    <span className="num muted">{o.count} 次</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mp-empty-inline">当前时间范围内没有对象变动。</div>
          )}
        </section>
      </div>

      <div className="mp-filter-toolbar">
        <SegmentedControl options={viewOptions} value={view} onChange={onChangeView} ariaLabel="流水展示粒度" size="sm" />
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
            aria-label="搜索库存流水"
            placeholder="搜卷号、料头号、业务单号、报工单"
            value={searchQuery}
            onChange={(e) => onChangeSearchQuery(e.target.value)}
          />
        </div>
        <select
          className="field mp-doc-select"
          aria-label="按对象类型筛选"
          value={filterAgg}
          onChange={(e) => onSelectFilterAgg(e.target.value)}
        >
          <option value="">全部对象</option>
          {aggs.map((a) => (
            <option key={a} value={a}>
              {AGG_LABELS[a] || a}
            </option>
          ))}
        </select>
        <label className="mp-doc-switch-label">
          <input type="checkbox" className="ux-switch" checked={showOpening} onChange={(e) => onToggleShowOpening(e.target.checked)} />
          <span>含期初迁移（{openingCount}）</span>
        </label>
        {activeChips.length > 0 && (
          <div className="mp-chip-row">
            {activeChips.map((c) => (
              <button key={c.key} type="button" className="mp-filter-chip" onClick={c.clear} title="移除该筛选">
                {c.text} ×
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`mp-doc-main ${focus ? 'has-drawer' : ''}`}>
        <div className="mp-doc-card">
          {renderLedger()}
          <div className="mp-doc-foot">
            <span className="num">
              {view === 'txn'
                ? `${txns.length} 笔事务 · ${filteredLedger.length} 条变动`
                : `显示 ${filteredLedger.length} 条变动`}
              {' · 点击行查看明细与追溯'}
            </span>
            <span>
              面积核对与 CSV 导出见 <a href="#/reconciliation">产出对账 →</a>
            </span>
          </div>
        </div>
        {renderFocus()}
      </div>
    </>
  );
};
