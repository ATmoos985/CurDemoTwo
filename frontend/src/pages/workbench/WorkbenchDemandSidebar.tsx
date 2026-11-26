import React, { Dispatch, RefObject, SetStateAction } from 'react';
import {
  DemandCluster,
  DemandFamilySummary,
  ShapeGeometry
} from '../../store/useStudioStore';
import { NumberInput } from '../../components/ui/NumberInput';
import { DemandRowView, OverviewStats } from './workbenchTypes';

const DemandShapeThumb: React.FC<{
  width: number;
  length: number;
  shape?: ShapeGeometry;
  done?: boolean;
}> = ({ width, length, shape, done }) => {
  const stroke = done ? '#10b981' : '#5b61f6';
  const fill = done ? 'rgba(16, 185, 129, 0.12)' : 'rgba(91, 97, 246, 0.1)';
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    const sw = Math.max(1, shape.width || width);
    const sh = Math.max(1, shape.height || length);
    const scale = Math.min(16 / sw, 16 / sh);
    const ox = (22 - sw * scale) / 2;
    const oy = (22 - sh * scale) / 2;
    const pts = shape.vertices
      .map((p) => `${(ox + p.x * scale).toFixed(1)},${(oy + p.y * scale).toFixed(1)}`)
      .join(' ');
    return (
      <svg className="wb-row-thumb" viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
        <polygon
          points={pts}
          fill={fill}
          stroke={stroke}
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const w = Math.max(1, width);
  const h = Math.max(1, length);
  const scale = Math.min(15 / w, 15 / h);
  const rw = Math.max(4, w * scale);
  const rh = Math.max(4, h * scale);
  const rx = (22 - rw) / 2;
  const ry = (22 - rh) / 2;
  return (
    <svg className="wb-row-thumb" viewBox="0 0 22 22" width={22} height={22} aria-hidden="true">
      <rect
        x={rx}
        y={ry}
        width={rw}
        height={rh}
        rx={1.5}
        fill={fill}
        stroke={stroke}
        strokeWidth="1.25"
      />
    </svg>
  );
};

export interface WorkbenchDemandSidebarProps {
  leftPaneRef: RefObject<HTMLElement | null>;
  is2D: boolean;
  demandSourceTab: 'POOL' | 'TEMPLATE';
  setDemandSourceTab: (tab: 'POOL' | 'TEMPLATE') => void;
  filteredPoolFamilies: DemandFamilySummary[];
  filteredClusters: DemandCluster[];
  loadedTaskId: string | null;
  loadedTaskName: string;
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string;
  loadDemandFamilyIntoWorkbench: (fam: DemandFamilySummary) => void;
  onClearConfirmSummary: () => void;
  quickCluster: DemandCluster | undefined;
  quickCounts: Record<string, number>;
  setActiveClusterQuickId: (id: string) => void;
  setClusterCount: (clusterId: string, size: string, count: number) => void;
  loadClusterInto2D: (clusterId: string, append: boolean) => void;
  loadClusterInto1D: (clusterId: string, append: boolean) => void;
  overviewStats: OverviewStats;
  demandRowsView: DemandRowView[];
  activeHighlightKey: string | null;
  setHoveredDemandKey: (key: string | null) => void;
  setPinnedDemandKey: Dispatch<SetStateAction<string | null>>;
  onOpenOverview: (tab: 'progress' | 'edit') => void;
  onAddBlankDemand: () => void;
}

export const WorkbenchDemandSidebar: React.FC<WorkbenchDemandSidebarProps> = ({
  leftPaneRef,
  is2D,
  demandSourceTab,
  setDemandSourceTab,
  filteredPoolFamilies,
  filteredClusters,
  loadedTaskId,
  loadedTaskName,
  slitLoadedTaskId,
  slitLoadedTaskName,
  loadDemandFamilyIntoWorkbench,
  onClearConfirmSummary,
  quickCluster,
  quickCounts,
  setActiveClusterQuickId,
  setClusterCount,
  loadClusterInto2D,
  loadClusterInto1D,
  overviewStats,
  demandRowsView,
  activeHighlightKey,
  setHoveredDemandKey,
  setPinnedDemandKey,
  onOpenOverview,
  onAddBlankDemand
}) => {
  return (
    <section ref={leftPaneRef} className="pane studio-left">
      <div className="pane-h">
        <span>需求</span>
        <span className="sp" />
        <a href="#/demands" className="link-btn">
          ＋ 新建
        </a>
        <a href="#/demand-library" className="link-btn">
          需求库
        </a>
      </div>

      <div className="pane-b">
        {/* Source Switcher */}
        <div className="wb-source-box">
          <div className="seg">
            <button
              type="button"
              className={demandSourceTab === 'POOL' ? 'on' : ''}
              onClick={() => setDemandSourceTab('POOL')}
            >
              需求族 ({filteredPoolFamilies.length})
            </button>
            <button
              type="button"
              className={demandSourceTab === 'TEMPLATE' ? 'on' : ''}
              onClick={() => setDemandSourceTab('TEMPLATE')}
            >
              模板 ({filteredClusters.length})
            </button>
          </div>

          {demandSourceTab === 'POOL' ? (
            filteredPoolFamilies.length > 0 ? (
              <>
                <select
                  className="field"
                  style={{ width: '100%' }}
                  value={(is2D ? loadedTaskId : slitLoadedTaskId) || ''}
                  onChange={(e) => {
                    const fam = filteredPoolFamilies.find((f) => f.id === e.target.value);
                    if (fam) {
                      loadDemandFamilyIntoWorkbench(fam);
                      onClearConfirmSummary();
                    }
                  }}
                >
                  <option value="">选择需求族…</option>
                  {filteredPoolFamilies.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · 余 {f.openTotal}/{f.orderedTotal}
                    </option>
                  ))}
                </select>
                {(is2D ? loadedTaskName : slitLoadedTaskName) && (
                  <div className="wb-source-meta">
                    已关联：<b>{is2D ? loadedTaskName : slitLoadedTaskName}</b>
                  </div>
                )}
              </>
            ) : (
              <div className="wb-source-meta">
                暂无需求族，可去 <a href="#/demands">需求池</a> 创建或切换模板
              </div>
            )
          ) : (
            quickCluster && (
              <>
                <select
                  className="field"
                  style={{ width: '100%' }}
                  value={quickCluster.id}
                  onChange={(e) => setActiveClusterQuickId(e.target.value)}
                >
                  {filteredClusters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="cluster-quick-sizes">
                  {quickCluster.availableSizes.map((sz) => (
                    <label key={sz} className={(quickCounts[sz] || 0) > 0 ? 'on' : ''}>
                      <span>{sz}</span>
                      <NumberInput
                        min={0}
                        max={100}
                        fallback={0}
                        integer
                        value={quickCounts[sz] ?? 0}
                        onValueChange={(v) => setClusterCount(quickCluster.id, sz, v)}
                      />
                    </label>
                  ))}
                </div>
                <div className="cluster-quick-btns">
                  <button
                    type="button"
                    className="btn sm soft-accent"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => {
                      onClearConfirmSummary();
                      if (is2D) loadClusterInto2D(quickCluster.id, false);
                      else loadClusterInto1D(quickCluster.id, false);
                    }}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      if (is2D) loadClusterInto2D(quickCluster.id, true);
                      else loadClusterInto1D(quickCluster.id, true);
                    }}
                  >
                    ＋ 追加
                  </button>
                </div>
              </>
            )
          )}
        </div>

        {/* Compact Progress Summary Strip */}
        <div className="wb-summary-strip">
          <div className="wb-summary-top">
            <div className="wb-summary-nums num">
              <span>
                已排 <b>{overviewStats.settled + overviewStats.cand}</b>/{overviewStats.ordered}
              </span>
              {overviewStats.uncut === 0 ? (
                <span className="is-ok">已排齐</span>
              ) : (
                <span>
                  余 {overviewStats.afterCandUncut}
                  {overviewStats.unit}
                </span>
              )}
            </div>
            <button
              type="button"
              className="wb-overview-trigger"
              onClick={() => onOpenOverview('progress')}
            >
              具体需求概览
            </button>
          </div>
          <div className="wb-mini-prog" aria-label={`总体进度 ${overviewStats.pct}%`}>
            <i
              className="seg-done"
              style={{
                width: `${
                  overviewStats.ordered > 0
                    ? Math.min(100, (overviewStats.done / overviewStats.ordered) * 100)
                    : 0
                }%`
              }}
            />
            <i
              className="seg-plan"
              style={{
                width: `${
                  overviewStats.ordered > 0
                    ? Math.min(
                        100 - (overviewStats.done / overviewStats.ordered) * 100,
                        (overviewStats.planned / overviewStats.ordered) * 100
                      )
                    : 0
                }%`
              }}
            />
            {overviewStats.cand > 0 && (
              <i
                className="seg-cand"
                style={{
                  width: `${
                    overviewStats.ordered > 0
                      ? Math.min(
                          100 - (overviewStats.settled / overviewStats.ordered) * 100,
                          (overviewStats.cand / overviewStats.ordered) * 100
                        )
                      : 0
                  }%`
                }}
              />
            )}
          </div>
        </div>

        {/* List Section Header */}
        <div className="wb-list-toolbar">
          <span className="num">规格 · {demandRowsView.length}</span>
          <div className="wb-list-toolbar-actions">
            <button
              type="button"
              className="wb-tiny-ghost"
              onClick={() => onOpenOverview('edit')}
            >
              编辑
            </button>
            <button type="button" className="wb-tiny-ghost" onClick={onAddBlankDemand}>
              ＋ 新增
            </button>
          </div>
        </div>

        {/* Magpie Single-Card Flat Demand List */}
        <div className="wb-demand-list" role="list" aria-label="逐项需求完成进度列表">
          {demandRowsView.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}>
              暂无需求规格
            </div>
          ) : (
            demandRowsView.map((row) => {
              const settledRow = row.done + row.planned;
              const donePct = Math.min(100, (row.done / row.ordered) * 100);
              const planPct = Math.min(100 - donePct, (row.planned / row.ordered) * 100);
              const candPct = Math.min(
                100 - donePct - planPct,
                (row.cand / row.ordered) * 100
              );
              const isFinished = row.uncut === 0;
              const isHighlighted = activeHighlightKey === row.key;
              const displayFilled = settledRow + row.cand;

              return (
                <div
                  key={row.key}
                  role="listitem"
                  className={`wb-demand-prog-row ${
                    isFinished ? 'is-done' : row.cand > 0 ? 'is-cand' : 'is-open'
                  }${isHighlighted ? ' is-highlighted' : ''}`}
                  onMouseEnter={() => setHoveredDemandKey(row.key)}
                  onMouseLeave={() => setHoveredDemandKey(null)}
                  onClick={() => setPinnedDemandKey((cur) => (cur === row.key ? null : row.key))}
                >
                  <div className="wb-row-main">
                    <DemandShapeThumb
                      width={row.width}
                      length={row.length}
                      shape={row.shape}
                      done={isFinished}
                    />
                    <div className="wb-row-info">
                      <span className="wb-row-name" title={row.name}>
                        {row.name}
                      </span>
                      <span className="wb-row-dim num">
                        {row.compactDim}
                        {row.sourceTaskName && (
                          <span
                            className="wb-source-badge"
                            title={`来源需求族：${row.sourceTaskName}${row.sourceLineId != null ? ` (#${row.sourceLineId})` : ''}`}
                          >
                            {row.sourceTaskName}
                            {row.sourceLineId != null ? ` #${row.sourceLineId}` : ''}
                          </span>
                        )}
                      </span>
                    </div>
                    <span
                      className={`wb-row-count num ${
                        isFinished ? 'is-done' : row.cand > 0 ? 'is-cand' : ''
                      }`}
                    >
                      {isFinished && (
                        <svg
                          className="wb-row-check"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 4.8"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                      {displayFilled}/{row.ordered}
                    </span>
                  </div>
                  <div className="wb-mini-prog" aria-hidden="true">
                    <i className="seg-done" style={{ width: `${donePct}%` }} />
                    <i className="seg-plan" style={{ width: `${planPct}%` }} />
                    {candPct > 0 && <i className="seg-cand" style={{ width: `${candPct}%` }} />}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
};
