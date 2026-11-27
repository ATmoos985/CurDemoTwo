import React from 'react';
import { fmtTime, shortId, fmtM } from '../../lib/core/util.js';
import { SegmentedControl, CodeBadge } from '../../components/ui/MagpiePrimitives';

interface DocumentOrdersTabViewsProps {
  tab: 'receipt' | 'issue' | 'transfer' | 'count';
  searchQuery: string;
  onChangeSearchQuery: (q: string) => void;
  receipts: any[];
  filteredReceipts: any[];
  rolls: any[];
  lastReceiptRolls: { rollId: string; materialModel: string; inspectionStatus: string }[];
  onClearLastReceiptRolls: () => void;
  onOpenReceiptModal: () => void;
  issues: any[];
  filteredIssues: any[];
  issueDirFilter: 'ALL' | 'ISSUE' | 'RETURN';
  onChangeIssueDirFilter: (next: 'ALL' | 'ISSUE' | 'RETURN') => void;
  onOpenIssueModal: () => void;
  transfers: any[];
  filteredTransfers: any[];
  counts: any[];
  filteredCounts: any[];
}

export const DocumentOrdersTabViews: React.FC<DocumentOrdersTabViewsProps> = ({
  tab,
  searchQuery,
  onChangeSearchQuery,
  receipts,
  filteredReceipts,
  rolls,
  lastReceiptRolls,
  onClearLastReceiptRolls,
  onOpenReceiptModal,
  issues,
  filteredIssues,
  issueDirFilter,
  onChangeIssueDirFilter,
  onOpenIssueModal,
  transfers,
  filteredTransfers,
  counts,
  filteredCounts
}) => {
  if (tab === 'receipt') {
    return (
      <div className="mp-doc-card">
        <div className="mp-filter-toolbar" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-2, #e2e8f0)' }}>
          <div className="mp-search-wrap">
            <input
              type="search"
              className="mp-search-input"
              aria-label="搜索采购入库单"
              placeholder="搜入库单号、供应商、送货单号、母卷号或缸号"
              value={searchQuery}
              onChange={(e) => onChangeSearchQuery(e.target.value)}
            />
          </div>
          <span className="mp-toolbar-count num">
            显示 {filteredReceipts.length} / 共 {receipts.length} 张采购入库单
          </span>
          <div className="mp-toolbar-actions">
            <button type="button" className="btn sm pri" onClick={onOpenReceiptModal}>
              ＋ 新建采购入库单
            </button>
          </div>
        </div>
        {lastReceiptRolls.length > 0 && (
          <div
            role="status"
            style={{
              margin: '10px 14px 0',
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--ok, #059669)',
              background: 'var(--ok-bg, rgba(16, 185, 129, 0.1))',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8
            }}
          >
            <strong style={{ fontSize: 12.5 }}>
              采购入库已过账（共 {lastReceiptRolls.length} 卷）
            </strong>
            {lastReceiptRolls.map((cr) => (
              <a
                key={cr.rollId}
                className={`btn sm ${cr.inspectionStatus !== 'PASSED' ? 'pri' : ''}`}
                href={`#/inspection/${encodeURIComponent(cr.rollId)}`}
              >
                {cr.rollId}
                {cr.inspectionStatus !== 'PASSED' ? ' · 去跑布验疵放行 →' : ' · 查看验布 →'}
              </a>
            ))}
            <button
              type="button"
              className="mp-ghost-btn"
              style={{ marginLeft: 'auto' }}
              onClick={onClearLastReceiptRolls}
            >
              关闭提示
            </button>
          </div>
        )}
        {filteredReceipts.length > 0 ? (
          <div className="mp-table-scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>入库单号</th>
                  <th>入库时间</th>
                  <th>供应商</th>
                  <th>送货单号</th>
                  <th className="r">母卷数</th>
                  <th>入库母卷与缸号明细</th>
                  <th>经办人</th>
                  <th className="r">版本</th>
                </tr>
              </thead>
              <tbody>
                {filteredReceipts
                  .slice()
                  .sort((a, b) => Number(b.inventoryRevision ?? b.postedAt ?? 0) - Number(a.inventoryRevision ?? a.postedAt ?? 0))
                  .map((r, idx) => {
                    const rls = r.lines || r.rolls || r.items || [];
                    const detail = rls
                      .map((x: any) => {
                        const rid = x.rollId || x.id || '—';
                        const model = x.materialModel || x.rollModel || '';
                        const batch = x.batchNo ? `缸:${x.batchNo}` : '';
                        const dim =
                          x.widthMm && x.totalLengthMm
                            ? `${x.widthMm}×${fmtM(x.totalLengthMm)}m`
                            : '';
                        return [rid, model, batch, dim].filter(Boolean).join(' ');
                      })
                      .join('；');
                    return (
                      <tr key={r.id || r.documentId || idx}>
                        <td>
                          <CodeBadge title={r.id || r.documentId}>
                            {shortId(r.id || r.documentId)}
                          </CodeBadge>
                        </td>
                        <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                        <td style={{ fontWeight: 600 }}>{r.supplierName || '—'}</td>
                        <td className="num">{r.deliveryNoteNo || '—'}</td>
                        <td className="r num">{rls.length}</td>
                        <td className="mp-doc-detail-cell num" title={detail}>
                          <div>
                            {detail || '—'}
                            {r.remarks ? ` · 备注：${r.remarks}` : ''}
                          </div>
                          {rls.length > 0 && (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                              {rls.slice(0, 6).map((x: any, li: number) => {
                                const rid = String(x.rollId || x.id || '');
                                if (!rid) return null;
                                const liveRoll = rolls.find((lr) => lr.rollId === rid);
                                const pendingQc =
                                  liveRoll && liveRoll.inspectionStatus !== 'PASSED' && liveRoll.inspectionStatus !== 'SCRAPPED';
                                return (
                                  <a
                                    key={`${rid}-${li}`}
                                    className={`btn sm ${pendingQc ? 'soft-accent' : ''}`}
                                    style={{ height: 22, padding: '0 7px', fontSize: 11 }}
                                    href={`#/inspection/${encodeURIComponent(rid)}`}
                                  >
                                    {rid} {pendingQc ? '待检·去验布 →' : '去验布 →'}
                                  </a>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td>{r.operator || '—'}</td>
                        <td className="r num">
                          {r.beforeRevision != null && r.afterRevision != null
                            ? `${r.beforeRevision} → ${r.afterRevision}`
                            : r.inventoryRevision ?? r.revision ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mp-empty-inline" style={{ padding: 36 }}>
            <strong>暂无采购批量入库单据</strong>
            点击右上角「＋ 新建采购入库单」一次原子录入供应商送货单与多卷新母卷（含缸号、色号、缩水率与库位）。
          </div>
        )}
      </div>
    );
  }

  if (tab === 'issue') {
    return (
      <div className="mp-doc-card">
        <div className="mp-filter-toolbar" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-2, #e2e8f0)' }}>
          <SegmentedControl
            options={[
              { value: 'ALL', label: '全部', count: issues.length },
              {
                value: 'ISSUE',
                label: '车间领料',
                count: issues.filter((x) => x.direction === 'ISSUE').length,
                accent: 'amber'
              },
              {
                value: 'RETURN',
                label: '车间退料',
                count: issues.filter((x) => x.direction === 'RETURN').length,
                accent: 'emerald'
              }
            ]}
            value={issueDirFilter}
            onChange={onChangeIssueDirFilter}
            ariaLabel="按领退料方向筛选"
            size="sm"
          />
          <div className="mp-search-wrap">
            <input
              type="search"
              className="mp-search-input"
              aria-label="搜索车间领退料单"
              placeholder="搜单号、母卷号、机台、班组、库位或经办人"
              value={searchQuery}
              onChange={(e) => onChangeSearchQuery(e.target.value)}
            />
          </div>
          <div className="mp-toolbar-actions">
            <button type="button" className="btn sm pri" onClick={onOpenIssueModal}>
              ＋ 新建领/退料单
            </button>
          </div>
        </div>
        {filteredIssues.length > 0 ? (
          <div className="mp-table-scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>单据号</th>
                  <th>时间</th>
                  <th>方向</th>
                  <th>母卷编号</th>
                  <th>机台 / 班组</th>
                  <th>目标库位</th>
                  <th>原因说明</th>
                  <th>经办人</th>
                  <th className="r">版本</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues
                  .slice()
                  .sort((a, b) => Number(b.inventoryRevision ?? b.postedAt ?? 0) - Number(a.inventoryRevision ?? a.postedAt ?? 0))
                  .map((r, idx) => {
                    const isIssue = r.direction === 'ISSUE';
                    return (
                      <tr key={r.id || r.documentId || idx}>
                        <td>
                          <CodeBadge title={r.id || r.documentId}>
                            {shortId(r.id || r.documentId)}
                          </CodeBadge>
                        </td>
                        <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                        <td>
                          <span className={`tag ${isIssue ? 'warn' : 'ok'}`}>
                            {isIssue ? '领料出库' : '退料入库'}
                          </span>
                        </td>
                        <td>
                          <a
                            href={`#/inventory?roll=${encodeURIComponent(r.rollId || '')}`}
                            className="mp-link-btn num"
                          >
                            {r.rollId || '—'}
                          </a>
                        </td>
                        <td className="num">
                          {[r.machineId, r.shiftTeam].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td>
                          <span className="tag kind">{r.toLocation || r.targetLocation || '—'}</span>
                        </td>
                        <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                        <td>{r.operator || '—'}</td>
                        <td className="r num">
                          {r.beforeRevision != null && r.afterRevision != null
                            ? `${r.beforeRevision} → ${r.afterRevision}`
                            : r.inventoryRevision ?? r.revision ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mp-empty-inline" style={{ padding: 36 }}>
            <strong>暂无车间领/退料单据</strong>
            点击「＋ 新建领/退料单」登记母卷发往裁床机台/班组，或将完工余卷退回原料仓库位。
          </div>
        )}
      </div>
    );
  }

  if (tab === 'transfer') {
    return (
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
                              m.fromLocation ? ` (${m.fromLocation}→${r.destination || m.toLocation || ''})` : ''
                            }`
                        )
                        .join('、');
                      return (
                        <tr key={r.id || r.documentId || idx}>
                          <td>
                            <CodeBadge title={r.id || r.documentId}>{shortId(r.id || r.documentId)}</CodeBadge>
                          </td>
                          <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
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
            </div>
          </>
        ) : (
          <div className="mp-empty-inline" style={{ padding: 36 }}>
            <strong>暂无移库单据</strong>
            可在「母卷与料头台账」勾选在库材料后发起批量移库。
          </div>
        )}
      </div>
    );
  }

  return (
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
                              : `${m.actualWidth ?? m.width ?? '—'}×${m.actualLength ?? m.length ?? '—'} mm`
                          }`
                      )
                      .join('；');
                    return (
                      <tr key={r.id || r.documentId || idx}>
                        <td>
                          <CodeBadge title={r.id || r.documentId}>{shortId(r.id || r.documentId)}</CodeBadge>
                        </td>
                        <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
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
          </div>
        </>
      ) : (
        <div className="mp-empty-inline" style={{ padding: 36 }}>
          <strong>暂无盘点单据</strong>
          可在「母卷与料头台账」勾选在库材料后发起实物库存盘点。
        </div>
      )}
    </div>
  );
};
