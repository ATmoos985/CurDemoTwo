import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { MAX_BATCH_ZIP_SCHEMES, STATE_BADGE, sanitizeSchemeTitle } from './resultsSceneUtils';

export interface ResultsListPaneProps {
  filteredEntries: any[];
  selectedId: string;
  onSelect: (schemeId: string) => void;
  checkedIds: Set<string>;
  onToggleCheck: (schemeId: string, checked: boolean) => void;
  onToggleSelectAllVisible: () => void;
  onOpenBatchZipModal: () => void;
  onResetFilters: () => void;
}

export const ResultsListPane: React.FC<ResultsListPaneProps> = ({
  filteredEntries,
  selectedId,
  onSelect,
  checkedIds,
  onToggleCheck,
  onToggleSelectAllVisible,
  onOpenBatchZipModal,
  onResetFilters
}) => {
  const allVisibleSelected =
    filteredEntries.length > 0 &&
    filteredEntries.slice(0, MAX_BATCH_ZIP_SCHEMES).every((e) => checkedIds.has(e.scheme.id));

  return (
    <section className="mp-res-list-pane" aria-label="排程方案列表">
      <div className="mp-res-pane-head" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span>排程方案列表</span>
        <span className="mp-toolbar-count num">{filteredEntries.length} 项</span>
        <span className="sp" />
        <button
          type="button"
          className="btn sm"
          data-testid="res-batch-select-all-btn"
          disabled={filteredEntries.length === 0}
          onClick={onToggleSelectAllVisible}
        >
          {allVisibleSelected ? '清空多选' : `全选 (最多${MAX_BATCH_ZIP_SCHEMES})`}
        </button>
        <button
          type="button"
          className="btn sm soft-accent"
          data-testid="res-open-batch-zip-modal-btn"
          disabled={checkedIds.size === 0}
          onClick={onOpenBatchZipModal}
        >
          批量导出 ZIP ({checkedIds.size})
        </button>
      </div>
      <div className="mp-res-list-scroll" role="listbox" aria-label="排程方案">
        {filteredEntries.length === 0 ? (
          <div className="mp-res-list-empty">
            <span>当前筛选条件下暂无匹配方案</span>
            <button type="button" className="btn sm" onClick={onResetFilters}>
              重置筛选条件
            </button>
          </div>
        ) : (
          filteredEntries.map((entry) => {
            const s = entry.scheme;
            const st = STATE_BADGE[s.state] || { label: s.state, cls: '' };
            const isSelected = selectedId === s.id;
            const isChecked = checkedIds.has(s.id);
            return (
              <div
                key={s.id}
                role="option"
                tabIndex={0}
                className="mp-res-item"
                aria-selected={isSelected}
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(s.id);
                  }
                }}
              >
                <div className="mp-res-item-top">
                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'pointer' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`勾选方案 ${s.id}`}
                      data-testid={`res-scheme-checkbox-${s.id}`}
                      checked={isChecked}
                      onChange={(e) => onToggleCheck(s.id, e.target.checked)}
                    />
                    <span className="mp-res-item-title">{sanitizeSchemeTitle(s.title)}</span>
                  </label>
                  <span className={`tag ${st.cls}`}>{st.label}</span>
                </div>
                <div className="mp-res-item-code-row">
                  <CodeBadge>{s.id}</CodeBadge>
                  <span className="mp-res-item-sub">
                    {s.taskName} · {s.materialModel}
                  </span>
                </div>
                <div className="mp-res-item-metrics num">
                  <span className="mp-res-pill ok">利用率 {s.utilizationPct}%</span>
                  <span className="mp-res-pill">
                    {s.dimension === 'SLITTING_1D'
                      ? `${s.slitting1D?.totalCars || 1} 车`
                      : `${s.widthMm}×${fmtN(s.occupiedLengthMm, 0)}mm`}
                  </span>
                  {s.rollId ? (
                    <span className="mp-res-pill run">实卷 {s.rollId}</span>
                  ) : (
                    <span className="mp-res-pill warn">新母卷待绑</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
