import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';

export interface ReconciliationLedgerTabProps {
  recon: any;
  areaStats: {
    consumed: number;
    qualified: number;
    recovered: number;
    waste: number;
    netRate: string | null;
  };
  ledgerItems: any[];
  filteredLedger: any[];
  ledgerHasMore: boolean;
  loadingMoreLedger: boolean;
  ledgerPageSize: number;
  onLoadMoreLedger: () => void;
}

export const ReconciliationLedgerTab: React.FC<ReconciliationLedgerTabProps> = ({
  recon,
  areaStats,
  ledgerItems,
  filteredLedger,
  ledgerHasMore,
  loadingMoreLedger,
  ledgerPageSize,
  onLoadMoreLedger
}) => {
  return (
    <>
      <div className="mp-rec-kpi-grid">
        <div className="mp-rec-kpi-card">
          <small>账实流水平衡状态</small>
          <b
            className={`mp-rec-kpi-val ${
              recon?.status === 'BALANCED' ? 'ok' : recon?.status === 'MISMATCH' ? 'err' : ''
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
                      {it.occurredAt ? String(it.occurredAt).replace('T', ' ').slice(0, 19) : '—'}
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
              onClick={onLoadMoreLedger}
            >
              {loadingMoreLedger ? '正在加载下一批…' : `加载更多流水 (+${ledgerPageSize})`}
            </button>
          ) : (
            <span className="muted">已全部加载完成</span>
          )}
        </div>
      </div>
    </>
  );
};
