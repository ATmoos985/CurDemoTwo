import React from 'react';
import { SegmentedControl, SegmentedOption } from '../../components/ui/MagpiePrimitives';
import {
  ACTION_TITLES,
  InventoryActionKind,
  InventoryStatusScope,
  InventoryViewScope,
  PENDING_SLOT_LABELS,
  PendingSlotKey,
  ProductGroup
} from './inventoryTypes';

export interface InventoryToolbarProps {
  productGroups: ProductGroup[];
  filteredProducts: ProductGroup[];
  rollsCount: number;
  passedRollTotal: number;
  availableRemnantTotal: number;
  previewOpen: boolean;
  onExpandPreview: () => void;
  pickedCount: number;
  onClearPicked: () => void;
  onOpenAction: (kind: InventoryActionKind, extra?: any) => void;
  onOpenBatchImport: () => void;
  activeProduct: ProductGroup | null;
  scanInputRef: React.RefObject<HTMLInputElement | null>;
  scanCode: string;
  onScanCodeChange: (v: string) => void;
  onScanLocate: (e?: React.FormEvent) => void;
  searchQuery: string;
  onSearchQueryChange: (v: string) => void;
  includeQuarantined: boolean;
  onToggleQuarantined: (v: boolean) => void;
  viewOptions: SegmentedOption<InventoryViewScope>[];
  viewScope: InventoryViewScope;
  onViewScopeChange: (v: InventoryViewScope) => void;
  statusOptions: SegmentedOption<InventoryStatusScope>[];
  statusScope: InventoryStatusScope;
  onStatusScopeChange: (v: InventoryStatusScope) => void;
  pendings: ReadonlyArray<readonly [PendingSlotKey, any]>;
  onRetryWrite: (slot: PendingSlotKey) => void;
  onDropWrite: (slot: PendingSlotKey) => void;
}

export const InventoryToolbar: React.FC<InventoryToolbarProps> = ({
  productGroups,
  filteredProducts,
  rollsCount,
  passedRollTotal,
  availableRemnantTotal,
  previewOpen,
  onExpandPreview,
  pickedCount,
  onClearPicked,
  onOpenAction,
  onOpenBatchImport,
  activeProduct,
  scanInputRef,
  scanCode,
  onScanCodeChange,
  onScanLocate,
  searchQuery,
  onSearchQueryChange,
  includeQuarantined,
  onToggleQuarantined,
  viewOptions,
  viewScope,
  onViewScopeChange,
  statusOptions,
  statusScope,
  onStatusScopeChange,
  pendings,
  onRetryWrite,
  onDropWrite
}) => {
  return (
    <>
      <div className="mp-inv-header">
        <div className="mp-inv-head-row">
          <div className="mp-page-title-block">
            <h1>库存</h1>
            <span className="mp-page-summary num">
              {productGroups.length} 个品号 · {rollsCount} 卷母卷（合格 {passedRollTotal}）·{' '}
              {availableRemnantTotal} 块可用料头
            </span>
          </div>

          <div className="mp-toolbar-actions">
            {!previewOpen && (
              <button type="button" className="mp-ghost-btn" onClick={onExpandPreview}>
                展开实物预览
              </button>
            )}
            {pickedCount > 0 && (
              <button type="button" className="mp-ghost-btn" onClick={onClearPicked}>
                清空勾选 ({pickedCount})
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={pickedCount === 0}
              title={pickedCount === 0 ? '先勾选母卷或料头' : undefined}
              onClick={() => onOpenAction('transfer')}
            >
              移库{pickedCount ? ` (${pickedCount})` : ''}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pickedCount === 0}
              title={pickedCount === 0 ? '先勾选母卷或料头' : undefined}
              onClick={() => onOpenAction('count')}
            >
              盘点{pickedCount ? ` (${pickedCount})` : ''}
            </button>
            <button
              type="button"
              className="mp-ghost-btn"
              data-testid="inv-open-batch-import-btn"
              onClick={onOpenBatchImport}
            >
              批量导入母卷/料头
            </button>
            <button
              type="button"
              className="btn pri"
              onClick={() =>
                onOpenAction('receive', {
                  rollId: '',
                  rollModel: activeProduct?.modelKey || '',
                  width: activeProduct?.primaryWidthMm || '',
                  length: ''
                })
              }
            >
              ＋ 登记母卷
            </button>
          </div>
        </div>

        <div className="mp-filter-toolbar mp-inv-filter-row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <form
            onSubmit={onScanLocate}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 1 236px', minWidth: 180 }}
          >
            <input
              ref={scanInputRef}
              type="text"
              className="field num"
              style={{ height: 30, fontSize: 12, flex: 1, minWidth: 130 }}
              aria-label="扫码枪快速定位母卷或料头"
              placeholder="扫码定位卷号/料头 (Alt+S)"
              value={scanCode}
              onChange={(e) => onScanCodeChange(e.target.value)}
            />
            <button type="submit" className="btn sm" style={{ flex: 'none' }}>
              定位
            </button>
          </form>

          <div className="mp-search-wrap" style={{ minWidth: 160 }}>
            <span className="mp-search-ico" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <circle cx="7.2" cy="7.2" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
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
              aria-label="搜索物料品号、母卷或料头"
              placeholder="搜品号、卷号、缸号、库位或料头号"
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
            />
          </div>

          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
            title="开启后从服务端加载并高亮展示 QUARANTINED（隔离）与 LOST（盘亏）料头"
          >
            <input
              type="checkbox"
              className="ux-switch"
              checked={includeQuarantined}
              onChange={(e) => onToggleQuarantined(e.target.checked)}
            />
            <span>显示隔离/盘亏料头</span>
          </label>

          <span className="mp-toolbar-count num">
            显示 {filteredProducts.length} / {productGroups.length} 品号
          </span>

          <div className="mp-inv-filter-controls">
            <SegmentedControl
              options={viewOptions}
              value={viewScope}
              onChange={onViewScopeChange}
              ariaLabel="按台账类别筛选"
              size="sm"
            />
            <SegmentedControl
              options={statusOptions}
              value={statusScope}
              onChange={onStatusScopeChange}
              ariaLabel="按库存状态筛选"
              size="sm"
            />
          </div>
        </div>
      </div>

      {pendings.length > 0 && (
        <div className="mp-inv-notice">
          {pendings.map(([s]) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>{PENDING_SLOT_LABELS[s] || ACTION_TITLES[s]}提交结果未确认</span>
              <button type="button" className="btn sm" onClick={() => onRetryWrite(s)}>
                重试原操作
              </button>
              <button type="button" className="btn sm" onClick={() => onDropWrite(s)}>
                放弃
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
};
