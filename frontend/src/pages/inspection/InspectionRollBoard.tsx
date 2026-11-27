import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { ROLL_STATUS_LABEL, RollFilterScope } from './inspectionTypes';

export interface InspectionRollBoardProps {
  rollFilter: RollFilterScope;
  onSetRollFilter: (f: RollFilterScope) => void;
  rollStats: {
    pending: number;
    pendingLength: number;
    passed: number;
    blocked: number;
    defects: number;
    withDefects: number;
  };
  rollQuery: string;
  onSetRollQuery: (q: string) => void;
  boardRolls: any[];
  totalRollsCount: number;
}

export const InspectionRollBoard: React.FC<InspectionRollBoardProps> = ({
  rollFilter,
  onSetRollFilter,
  rollStats,
  rollQuery,
  onSetRollQuery,
  boardRolls,
  totalRollsCount
}) => {
  return (
    <div className="mp-insp-empty-wrap">
      <div className="mp-insp-board">
        <div className="mp-kpi-row" role="group" aria-label="母卷验布概况">
          <button
            type="button"
            className={`mp-kpi ${rollFilter === 'PENDING' ? 'on' : ''}`}
            onClick={() => onSetRollFilter('PENDING')}
            title="筛选未通过验布的母卷"
          >
            <span className="mp-kpi-label">待验布</span>
            <span className="mp-kpi-value num">
              {rollStats.pending}
              <small>卷</small>
            </span>
            <span className="mp-kpi-sub num">待检余长 {fmtM(rollStats.pendingLength)} m</span>
          </button>
          <button
            type="button"
            className={`mp-kpi ${rollFilter === 'PASSED' ? 'on' : ''}`}
            onClick={() => onSetRollFilter('PASSED')}
            title="筛选验布合格母卷"
          >
            <span className="mp-kpi-label">验布合格</span>
            <span className="mp-kpi-value num">
              {rollStats.passed}
              <small>卷</small>
            </span>
            <span className="mp-kpi-sub">可进入排料与报工</span>
          </button>
          <div className="mp-kpi" data-tone={rollStats.blocked ? 'err' : undefined}>
            <span className="mp-kpi-label">不合格 / 隔离</span>
            <span className="mp-kpi-value num">
              {rollStats.blocked}
              <small>卷</small>
            </span>
            <span className="mp-kpi-sub">不参与排料</span>
          </div>
          <div className="mp-kpi">
            <span className="mp-kpi-label">已登记疵点</span>
            <span className="mp-kpi-value num">
              {rollStats.defects}
              <small>处</small>
            </span>
            <span className="mp-kpi-sub num">分布在 {rollStats.withDefects} 卷</span>
          </div>
        </div>

        <div className="mp-insp-board-card">
          <div className="mp-insp-board-head">
            <div>
              <h2>选择一卷母卷开始跑布验疵</h2>
              <p>
                疵点按距卷头的绝对物理坐标（mm）记录；本机草稿自动暂存，点右上角「保存到母卷」才正式入档。
              </p>
            </div>
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
                aria-label="搜索母卷"
                placeholder="搜卷号、品号、批次、库位"
                value={rollQuery}
                onChange={(e) => onSetRollQuery(e.target.value)}
              />
            </div>
          </div>
          {boardRolls.length > 0 ? (
            <div className="mp-table-scroll">
              <table className="t mp-insp-board-table">
                <thead>
                  <tr>
                    <th>卷号</th>
                    <th>验布状态</th>
                    <th>品号 / 材料</th>
                    <th>批次</th>
                    <th className="r">幅宽 mm</th>
                    <th className="r">总长 m</th>
                    <th className="r">已切 m</th>
                    <th className="r">余长 m</th>
                    <th className="r">疵点</th>
                    <th>库位</th>
                    <th>验布记录</th>
                    <th className="r">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {boardRolls.map((x) => {
                    const [stTxt, stCls] = ROLL_STATUS_LABEL[x.inspectionStatus] || [
                      x.inspectionStatus || '待检',
                      'warn'
                    ];
                    const used = x.usedLength || 0;
                    const remain = x.currentRemainingLength ?? Math.max(0, (x.totalLength || 0) - used);
                    const dc = x.defectsCount ?? (x.defects || []).length;
                    const href = `#/inspection/${encodeURIComponent(x.rollId)}`;
                    return (
                      <tr
                        key={x.rollId}
                        className="mp-row-link"
                        onClick={() => {
                          location.hash = href;
                        }}
                      >
                        <td>
                          <strong className="num">{x.rollId}</strong>
                        </td>
                        <td>
                          <span className={`tag ${stCls}`}>{stTxt}</span>
                        </td>
                        <td>{x.rollModel || x.materialName || '未分类品号'}</td>
                        <td className="num muted">{x.batchNo || '—'}</td>
                        <td className="r num">{fmtN(x.width)}</td>
                        <td className="r num">{fmtM(x.totalLength)}</td>
                        <td className="r num">{used > 0 ? fmtM(used) : '—'}</td>
                        <td className="r num">{fmtM(remain)}</td>
                        <td className="r num">
                          {dc > 0 ? <span className="tag warn">{dc} 处</span> : <span className="muted">0</span>}
                        </td>
                        <td className="muted">{x.storageLocation || '—'}</td>
                        <td className="muted num">
                          {x.inspectionDate ? `${x.inspectionDate} · ${x.inspector || '—'}` : '未验布'}
                        </td>
                        <td className="r">
                          <a
                            className={x.inspectionStatus === 'PASSED' ? 'mp-ghost-btn' : 'mp-ghost-btn mp-ghost-strong'}
                            href={href}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {x.inspectionStatus === 'PASSED' ? '复验' : '开始验布'}
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mp-empty-inline" style={{ padding: 36 }}>
              当前条件下暂无母卷，可清空搜索词、切换上方筛选器或先登记新母卷。
            </div>
          )}
          <div className="mp-doc-foot">
            <span className="num">
              显示 {boardRolls.length} / 共 {totalRollsCount} 卷 · 未通过验布的母卷排在最前
            </span>
            <a href="#/inventory/receive">登记新母卷 →</a>
          </div>
        </div>
      </div>
    </div>
  );
};
