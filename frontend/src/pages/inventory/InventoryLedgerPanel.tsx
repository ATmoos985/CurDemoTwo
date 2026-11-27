import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import {
  InventoryActionKind,
  InventoryViewScope,
  PreviewTarget,
  ProductGroup,
  REMNANT_STATUS_MAP,
  ROLL_QUALITY_MAP,
  idOf
} from './inventoryTypes';

export interface InventoryLedgerPanelProps {
  filteredProducts: ProductGroup[];
  activeProduct: ProductGroup | null;
  selectedModel: string;
  onSelectModel: (modelKey: string) => void;
  focusedRollId: string;
  onFocusRollId: (rollId: string) => void;
  viewScope: InventoryViewScope;
  displayedRolls: any[];
  displayedRemnants: any[];
  remnantsByRollId: Map<string, any[]>;
  rollLookup: Map<string, any>;
  picked: Set<string>;
  onTogglePick: (key: string, checked: boolean) => void;
  onSetPicked: (next: Set<string>) => void;
  previewTarget: PreviewTarget;
  scanHitKey: string;
  onInspectRoll: (r: any) => void;
  onInspectRemnant: (rm: any) => void;
  onOpenAction: (kind: InventoryActionKind, extra?: any) => void;
  onUseRemnantInWorkbench: (rm: any) => void;
}

export const InventoryLedgerPanel: React.FC<InventoryLedgerPanelProps> = ({
  filteredProducts,
  activeProduct,
  onSelectModel,
  focusedRollId,
  onFocusRollId,
  viewScope,
  displayedRolls,
  displayedRemnants,
  remnantsByRollId,
  rollLookup,
  picked,
  onTogglePick,
  onSetPicked,
  previewTarget,
  scanHitKey,
  onInspectRoll,
  onInspectRemnant,
  onOpenAction,
  onUseRemnantInWorkbench
}) => {
  return (
    <section className="mp-inv-ledger-card" aria-label="母卷与料头聚合台账">
      <div className="mp-inv-model-bar">
        <span className="mp-inv-model-bar-label">品号</span>
        <div className="mp-inv-model-strip" role="listbox" aria-label="物料品号切换">
          {filteredProducts.length > 0 ? (
            filteredProducts.map((g) => {
              const isActive = activeProduct?.modelKey === g.modelKey;
              return (
                <button
                  key={g.modelKey}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className="mp-inv-model-pill"
                  onClick={() => onSelectModel(g.modelKey)}
                >
                  <span>{g.modelKey}</span>
                  <span className="mp-pill-meta num">
                    {g.rolls.length}卷
                    {g.availableRemnants.length > 0 ? ` · ${g.availableRemnants.length}料` : ''}
                  </span>
                </button>
              );
            })
          ) : (
            <span className="mp-inv-section-hint">没有匹配的物料品号</span>
          )}
        </div>
      </div>

      {activeProduct ? (
        <>
          <div className="mp-inv-product-strip">
            <div className="mp-inv-product-identity">
              <strong>{activeProduct.modelKey}</strong>
              {activeProduct.primaryWidthMm > 0 && (
                <CodeBadge>{fmtN(activeProduct.primaryWidthMm)} mm</CodeBadge>
              )}
              {activeProduct.materialName && (
                <span className="mp-inv-product-meta">{activeProduct.materialName}</span>
              )}
              {(activeProduct.color || activeProduct.composition) && (
                <span className="mp-inv-product-meta">
                  {[activeProduct.color, activeProduct.composition].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>

            <div className="mp-inv-metrics-inline num">
              <div className="mp-inv-metric-item">
                <span>母卷</span>
                <b>{activeProduct.rolls.length}</b>
                <span>卷（合格 {activeProduct.passedRollCount}）</span>
              </div>
              <div className="mp-inv-metric-item">
                <span>总余长</span>
                <b>{fmtN(activeProduct.totalRemainingM, 2)}</b>
                <span>m</span>
              </div>
              <div className="mp-inv-metric-item">
                <span>可用料头</span>
                <b className={activeProduct.availableRemnants.length ? 'is-ok' : ''}>
                  {activeProduct.availableRemnants.length}
                </b>
                <span>块 ({fmtN(activeProduct.availableRemnantAreaM2, 2)} m²)</span>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  onOpenAction('receive', {
                    rollId: '',
                    rollModel: activeProduct.modelKey,
                    width: activeProduct.primaryWidthMm || '',
                    length: ''
                  })
                }
              >
                ＋ 补录同品母卷
              </button>
            </div>
          </div>

          <div className="mp-inv-ledger-body">
            {viewScope !== 'REMNANTS' && (
              <div className="mp-inv-section">
                <div className="mp-inv-section-head">
                  <span>在库母卷（{displayedRolls.length} 卷）</span>
                  <span className="mp-inv-section-hint">
                    点击任意行在右侧预览整卷余量、切割区段与疵点坐标
                  </span>
                </div>
                {displayedRolls.length > 0 ? (
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th style={{ width: 28 }}>
                            <input
                              type="checkbox"
                              aria-label="全选该品母卷"
                              checked={
                                displayedRolls.length > 0 &&
                                displayedRolls.every((r) => picked.has(idOf(true, r)))
                              }
                              onChange={(e) => {
                                const next = new Set(picked);
                                displayedRolls.forEach((r) => {
                                  const k = idOf(true, r);
                                  if (e.target.checked) next.add(k);
                                  else next.delete(k);
                                });
                                onSetPicked(next);
                              }}
                            />
                          </th>
                          <th>母卷编号 / 批号</th>
                          <th className="r" title="门幅 (mm)">门幅</th>
                          <th className="r">剩余 / 整卷</th>
                          <th>派生料头</th>
                          <th className="r">疵点</th>
                          <th>库位</th>
                          <th>检验</th>
                          <th style={{ textAlign: 'right' }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedRolls.map((r) => {
                          const itemKey = idOf(true, r);
                          const isChecked = picked.has(itemKey);
                          const isPreviewed =
                            previewTarget?.kind === 'roll' && previewTarget.id === r.rollId;
                          const remLen =
                            r.currentRemainingLength ?? r.totalLength - (r.usedLength || 0);
                          const [qt, qc] = ROLL_QUALITY_MAP[r.inspectionStatus] || [
                            r.inspectionStatus || '—',
                            ''
                          ];
                          const linkedRems = remnantsByRollId.get(r.rollId) || [];
                          const availRems = linkedRems.filter((rm) => rm.status === 'AVAILABLE');
                          const isScrappedRoll =
                            r.inspectionStatus === 'SCRAPPED' || r.status === 'SCRAPPED';
                          const isScanHit = scanHitKey === itemKey;

                          return (
                            <tr
                              key={r.rollId}
                              data-inv-row={itemKey}
                              className={`click ${isPreviewed ? 'sel' : ''}`}
                              style={
                                isScanHit
                                  ? { outline: '2px solid #0284c7', background: 'rgba(2,132,199,0.08)' }
                                  : isScrappedRoll
                                  ? { opacity: 0.68 }
                                  : undefined
                              }
                              onClick={() => onInspectRoll(r)}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  aria-label={`选择母卷 ${r.rollId}`}
                                  checked={isChecked}
                                  onChange={(e) => onTogglePick(itemKey, e.target.checked)}
                                />
                              </td>
                              <td>
                                <div className="mp-inv-id-cell" style={{ flexWrap: 'wrap', gap: 4 }}>
                                  <strong className="num mp-inv-roll-id" title={r.rollId}>
                                    {r.rollId}
                                  </strong>
                                  {r.batchNo && (
                                    <CodeBadge title={`缸号/批次：${r.batchNo}`}>
                                      缸:{r.batchNo}
                                    </CodeBadge>
                                  )}
                                  {r.color && (
                                    <span
                                      className="tag"
                                      style={{ fontSize: 10.5, padding: '1px 5px' }}
                                      title={`色号：${r.color}`}
                                    >
                                      {r.color}
                                    </span>
                                  )}
                                  {r.shrinkageRate !== undefined &&
                                    r.shrinkageRate !== null &&
                                    Number(r.shrinkageRate) > 0 && (
                                      <span className="mp-inv-sub-meta num">
                                        缩水 {fmtN(r.shrinkageRate, 1)}%
                                      </span>
                                    )}
                                </div>
                              </td>
                              <td className="r num">{fmtN(r.width)}</td>
                              <td className="r num">
                                <div>
                                  <b>{fmtM(remLen)}</b>/{fmtM(r.totalLength)}m
                                </div>
                                {(r.usedLength || 0) > 0 && (
                                  <div className="mp-inv-sub-meta">已切 {fmtM(r.usedLength)}m</div>
                                )}
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                {linkedRems.length > 0 ? (
                                  <button
                                    type="button"
                                    className={`mp-inv-remnant-link num ${
                                      focusedRollId === r.rollId ? 'active' : ''
                                    }`}
                                    title={
                                      activeProduct.rolls.length > 1
                                        ? `可用 ${availRems.length} / 共 ${linkedRems.length} 块，点击仅看此母卷派生的料头`
                                        : `可用 ${availRems.length} / 共 ${linkedRems.length} 块，点击预览第一块派生料头`
                                    }
                                    onClick={() => {
                                      if (activeProduct.rolls.length > 1) {
                                        onFocusRollId(focusedRollId === r.rollId ? '' : r.rollId);
                                      } else if (linkedRems[0]) {
                                        onInspectRemnant(linkedRems[0]);
                                      }
                                    }}
                                  >
                                    {availRems.length}/{linkedRems.length}块
                                  </button>
                                ) : (
                                  <span className="muted">无</span>
                                )}
                              </td>
                              <td className="r num">
                                {r.defectsCount ?? (r.defects || []).length}
                              </td>
                              <td>
                                <span className="mp-inv-loc-cell" title={r.storageLocation || '—'}>
                                  {r.storageLocation || '—'}
                                </span>
                                {(r.issuedMachineId || r.issuedShiftTeam) && (
                                  <div className="mp-inv-sub-meta" style={{ color: '#0284c7' }}>
                                    去向：{[r.issuedMachineId, r.issuedShiftTeam].filter(Boolean).join(' · ')}
                                  </div>
                                )}
                              </td>
                              <td>
                                <span className={`tag ${qc}`}>{qt}</span>
                              </td>
                              <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                <div className="mp-inv-row-actions">
                                  <button
                                    type="button"
                                    className="btn sm soft-accent"
                                    onClick={() => onInspectRoll(r)}
                                    title="查看该母卷已切割区域、预占区段与疵点空间图"
                                  >
                                    看切割区
                                  </button>
                                  <a
                                    className={`btn sm ${
                                      !isScrappedRoll && r.inspectionStatus !== 'PASSED'
                                        ? 'soft-accent'
                                        : ''
                                    }`}
                                    href={`#/inspection/${encodeURIComponent(r.rollId)}`}
                                    title="进入跑布验疵并执行质检放行"
                                  >
                                    {!isScrappedRoll && r.inspectionStatus !== 'PASSED'
                                      ? '去验布放行'
                                      : '跑疵点'}
                                  </a>
                                  {!isScrappedRoll && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      style={{ color: 'var(--err, #b91c1c)' }}
                                      title="执行母卷级受控报废（清零未切余量并留痕）"
                                      onClick={() => onOpenAction('scrapRoll', { scrapRollId: r.rollId })}
                                    >
                                      报废
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mp-empty-inline">当前筛选条件下暂无整卷母卷记录</div>
                )}
              </div>
            )}

            {viewScope !== 'ROLLS' && (
              <div className="mp-inv-section">
                <div className="mp-inv-section-head">
                  <span>关联派生料头（{displayedRemnants.length} 块）</span>
                  {focusedRollId && (
                    <span className="tag run">
                      来源母卷：{focusedRollId}
                      <button
                        type="button"
                        className="inv-clear-chip"
                        onClick={() => onFocusRollId('')}
                      >
                        × 全部
                      </button>
                    </span>
                  )}
                  <span className="mp-inv-section-hint">点击料头行在右侧预览单块实尺与疵点</span>
                </div>

                {displayedRemnants.length > 0 ? (
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th style={{ width: 28 }}>
                            <input
                              type="checkbox"
                              aria-label="全选当前列表料头"
                              checked={
                                displayedRemnants.length > 0 &&
                                displayedRemnants.every((rm) => picked.has(idOf(false, rm)))
                              }
                              onChange={(e) => {
                                const next = new Set(picked);
                                displayedRemnants.forEach((rm) => {
                                  const k = idOf(false, rm);
                                  if (e.target.checked) next.add(k);
                                  else next.delete(k);
                                });
                                onSetPicked(next);
                              }}
                            />
                          </th>
                          <th>料头编号</th>
                          <th>来源母卷 · 谱系</th>
                          <th className="r" title="宽 × 长 (mm)">宽×长 mm</th>
                          <th className="r" title="面积 (m²)">面积 m²</th>
                          <th>疵点</th>
                          <th>状态</th>
                          <th style={{ textAlign: 'right' }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedRemnants.map((rm) => {
                          const itemKey = idOf(false, rm);
                          const isChecked = picked.has(itemKey);
                          const isPreviewed =
                            previewTarget?.kind === 'remnant' && previewTarget.id === rm.id;
                          const [stLabel, stClass] = REMNANT_STATUS_MAP[rm.status] || [rm.status, ''];
                          const parentRoll = rm.sourceRollId ? rollLookup.get(rm.sourceRollId) : null;
                          const remBatch = rm.batchNo || parentRoll?.batchNo || '';
                          const remColor = rm.color || parentRoll?.color || '';
                          const isQuarantined = rm.status === 'QUARANTINED';
                          const isLost = rm.status === 'LOST';
                          const isScanHit = scanHitKey === itemKey;
                          return (
                            <tr
                              key={rm.id}
                              data-inv-row={itemKey}
                              className={`click ${isPreviewed ? 'sel' : ''}`}
                              style={
                                isScanHit
                                  ? { outline: '2px solid #0284c7', background: 'rgba(2,132,199,0.08)' }
                                  : isQuarantined
                                  ? { background: 'rgba(245, 158, 11, 0.08)', boxShadow: 'inset 3px 0 0 #d97706' }
                                  : isLost
                                  ? { background: 'rgba(220, 38, 38, 0.07)', boxShadow: 'inset 3px 0 0 #dc2626' }
                                  : undefined
                              }
                              onClick={() => onInspectRemnant(rm)}
                            >
                              <td onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  aria-label={`选择料头 ${rm.id}`}
                                  checked={isChecked}
                                  onChange={(e) => onTogglePick(itemKey, e.target.checked)}
                                />
                              </td>
                              <td>
                                <CodeBadge className="mp-inv-rem-id" title={rm.id}>
                                  {rm.id}
                                </CodeBadge>
                              </td>
                              <td>
                                <div className="mp-inv-lineage-cell" style={{ flexWrap: 'wrap', gap: 4 }}>
                                  <span className="num muted mp-inv-source-id" title={rm.sourceRollId || '—'}>
                                    {rm.sourceRollId || '—'}
                                  </span>
                                  {rm.generation ? <CodeBadge>G{rm.generation}</CodeBadge> : null}
                                  {remBatch && <CodeBadge title={`继承缸号：${remBatch}`}>缸:{remBatch}</CodeBadge>}
                                  {remColor && (
                                    <span className="tag" style={{ fontSize: 10.5, padding: '1px 5px' }} title={`色号：${remColor}`}>
                                      {remColor}
                                    </span>
                                  )}
                                  {rm.qualityDispositionId && <span className="tag warn">复检回收</span>}
                                </div>
                              </td>
                              <td className="r num">
                                {fmtN(rm.width)}×{fmtN(rm.length)}
                              </td>
                              <td className="r num">{fmtN(rm.area, 2)}</td>
                              <td>
                                {rm.hasDefect ? <span className="tag warn">带疵</span> : <span className="muted">无疵</span>}
                              </td>
                              <td>
                                <span className={`tag ${stClass}`}>{stLabel}</span>
                              </td>
                              <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                                <div className="mp-inv-row-actions">
                                  {rm.status === 'AVAILABLE' && (
                                    <button
                                      type="button"
                                      className="btn sm soft-accent"
                                      onClick={() => onUseRemnantInWorkbench(rm)}
                                    >
                                      排料
                                    </button>
                                  )}
                                  {isQuarantined && (
                                    <button
                                      type="button"
                                      className="btn sm soft-accent"
                                      title="对隔离料头执行质量复验放行或判废"
                                      onClick={() =>
                                        onOpenAction('release', {
                                          releaseRemnantId: rm.id,
                                          decision: 'RELEASE_AVAILABLE'
                                        })
                                      }
                                    >
                                      复验放行
                                    </button>
                                  )}
                                  {(rm.status === 'AVAILABLE' || isQuarantined) && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      onClick={() =>
                                        isQuarantined
                                          ? onOpenAction('release', {
                                              releaseRemnantId: rm.id,
                                              decision: 'SCRAP'
                                            })
                                          : onOpenAction('scrap', { scrapId: rm.id })
                                      }
                                    >
                                      报废
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mp-empty-inline">暂无符合当前筛选条件的料头</div>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="mp-empty-inline" style={{ padding: 44 }}>
          <strong>暂无匹配的物料品号</strong>
          请调整顶部搜索词或切换台账筛选条件，或登记新的在库母卷。
        </div>
      )}
    </section>
  );
};
