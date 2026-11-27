import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { AuthSession } from '../../utils/authClient';
import {
  ACTION_TITLES,
  CountRowState,
  InventoryActionKind,
  ProductGroup,
  ReceiveModalMode
} from './inventoryTypes';
import { InventoryBatchImportTab } from './InventoryBatchImportTab';

export interface InventoryActionModalProps {
  action: InventoryActionKind | null;
  receiveMode: ReceiveModalMode;
  onReceiveModeChange: (m: ReceiveModalMode) => void;
  auth?: AuthSession | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (e?: React.FormEvent) => void;
  onSuccessRefresh: () => Promise<void>;
  productGroups: ProductGroup[];
  rolls: any[];
  remnants: any[];
  rollLookup: Map<string, any>;
  opts: any;
  selectedMaterials: Array<{ type: string; id: string; m: any }>;
  blockedMaterials: Array<{ type: string; id: string; m: any }>;
  getCountRow: (key: string) => CountRowState;
  updateCountRow: (key: string, patch: Partial<CountRowState>) => void;
  rollIdInput: string;
  setRollIdInput: (v: string) => void;
  rollModelInput: string;
  setRollModelInput: (v: string) => void;
  widthInput: string | number;
  setWidthInput: (v: string | number) => void;
  lengthInput: string | number;
  setLengthInput: (v: string | number) => void;
  batchNoInput: string;
  setBatchNoInput: (v: string) => void;
  colorInput: string;
  setColorInput: (v: string) => void;
  shrinkageInput: string | number;
  setShrinkageInput: (v: string | number) => void;
  locationInput: string;
  setLocationInput: (v: string) => void;
  editRollTarget: any | null;
  releaseRemnantId: string;
  releaseDecision: 'RELEASE_AVAILABLE' | 'SCRAP';
  setReleaseDecision: (v: 'RELEASE_AVAILABLE' | 'SCRAP') => void;
  releaseInspector: string;
  setReleaseInspector: (v: string) => void;
  scrapRollId: string;
  scrapId: string;
  destination: string;
  setDestination: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  operator: string;
  setOperator: (v: string) => void;
}

export const InventoryActionModal: React.FC<InventoryActionModalProps> = ({
  action,
  receiveMode,
  onReceiveModeChange,
  auth,
  busy,
  onClose,
  onSubmit,
  onSuccessRefresh,
  productGroups,
  rolls,
  remnants,
  rollLookup,
  opts,
  selectedMaterials,
  blockedMaterials,
  getCountRow,
  updateCountRow,
  rollIdInput,
  setRollIdInput,
  rollModelInput,
  setRollModelInput,
  widthInput,
  setWidthInput,
  lengthInput,
  setLengthInput,
  batchNoInput,
  setBatchNoInput,
  colorInput,
  setColorInput,
  shrinkageInput,
  setShrinkageInput,
  locationInput,
  setLocationInput,
  editRollTarget,
  releaseRemnantId,
  releaseDecision,
  setReleaseDecision,
  releaseInspector,
  setReleaseInspector,
  scrapRollId,
  scrapId,
  destination,
  setDestination,
  reason,
  setReason,
  operator,
  setOperator
}) => {
  return (
    <ModalDialog
      open={action !== null}
      title={action ? ACTION_TITLES[action] : '库存业务操作'}
      onClose={() => {
        if (!busy) onClose();
      }}
      maxWidth={action === 'receive' && receiveMode !== 'single' ? 860 : 680}
    >
      {action === 'receive' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            className="seg-ctl sm"
            role="tablist"
            aria-label="入库模式切换"
            data-testid="inv-receive-mode-tabs"
            style={{ alignSelf: 'flex-start' }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'single'}
              className={`seg-btn ${receiveMode === 'single' ? 'active' : ''}`}
              data-testid="inv-receive-tab-single"
              onClick={() => onReceiveModeChange('single')}
            >
              单卷登记
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'batch_rolls'}
              className={`seg-btn ${receiveMode === 'batch_rolls' ? 'active' : ''}`}
              data-testid="inv-receive-tab-batch-rolls"
              onClick={() => onReceiveModeChange('batch_rolls')}
            >
              批量导入母卷 (mm)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={receiveMode === 'batch_remnants'}
              className={`seg-btn ${receiveMode === 'batch_remnants' ? 'active' : ''}`}
              data-testid="inv-receive-tab-batch-remnants"
              onClick={() => onReceiveModeChange('batch_remnants')}
            >
              批量导入料头 (mm)
            </button>
          </div>

          {receiveMode === 'single' ? (
            <form onSubmit={onSubmit}>
              <div className="form" style={{ gridTemplateColumns: '100px 1fr', padding: '4px 0 8px' }}>
                <label htmlFor="inv-rec-rollid">母卷卷号</label>
                <input
                  id="inv-rec-rollid"
                  data-form="rollId"
                  className="field"
                  required
                  placeholder="如 ROLL-2026-1101"
                  value={rollIdInput}
                  onChange={(e) => setRollIdInput(e.target.value)}
                />
                <label htmlFor="inv-rec-model">物料品号</label>
                <input
                  id="inv-rec-model"
                  data-form="rollModel"
                  className="field"
                  required
                  list="inv-models-datalist"
                  value={rollModelInput}
                  onChange={(e) => setRollModelInput(e.target.value)}
                />
                <datalist id="inv-models-datalist">
                  {productGroups.map((g) => (
                    <option key={g.modelKey} value={g.modelKey} />
                  ))}
                </datalist>
                <label htmlFor="inv-rec-width">幅宽 mm</label>
                <input
                  id="inv-rec-width"
                  data-form="width"
                  type="number"
                  step="any"
                  required
                  className="field num"
                  value={widthInput}
                  onChange={(e) => setWidthInput(e.target.value)}
                />
                <label htmlFor="inv-rec-len">整卷长度 m</label>
                <input
                  id="inv-rec-len"
                  data-form="length"
                  type="number"
                  step="any"
                  required
                  className="field num"
                  value={lengthInput}
                  onChange={(e) => setLengthInput(e.target.value)}
                />
                <label htmlFor="inv-rec-batch">缸号 / 批次</label>
                <input
                  id="inv-rec-batch"
                  className="field num"
                  placeholder="如 BAT-202611-A1（防色差校验用）"
                  value={batchNoInput}
                  onChange={(e) => setBatchNoInput(e.target.value)}
                />
                <label htmlFor="inv-rec-color">色号</label>
                <input
                  id="inv-rec-color"
                  className="field"
                  placeholder="如 藏青 / PANTONE 19-4024"
                  value={colorInput}
                  onChange={(e) => setColorInput(e.target.value)}
                />
                <label htmlFor="inv-rec-shrink">预缩水率 %</label>
                <input
                  id="inv-rec-shrink"
                  type="number"
                  step="0.1"
                  min="0"
                  className="field num"
                  placeholder="如 1.5"
                  value={shrinkageInput}
                  onChange={(e) => setShrinkageInput(e.target.value)}
                />
                <label htmlFor="inv-rec-loc">初始库位</label>
                <input
                  id="inv-rec-loc"
                  className="field"
                  placeholder="如 原料库位 R-01-A03"
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                />
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '4px 0 14px' }}>
                新母卷入库后默认处于“待检”状态，确认登记后直接进入跑布验疵定位画布，检验放行后方可投产锁料。
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" disabled={busy} onClick={onClose}>
                  取消
                </button>
                <button id="act-submit" type="submit" className="btn pri" disabled={busy}>
                  登记并去验布 →
                </button>
              </div>
            </form>
          ) : (
            <InventoryBatchImportTab
              key={receiveMode}
              kind={receiveMode === 'batch_rolls' ? 'rolls' : 'remnants'}
              auth={auth}
              onSuccessRefresh={onSuccessRefresh}
              onClose={onClose}
            />
          )}
        </div>
      ) : action === 'editRoll' ? (
        <form onSubmit={onSubmit}>
          {editRollTarget && (
            <>
              <div className="kv" style={{ padding: '4px 0 10px' }}>
                <div>母卷编号</div>
                <div className="num">{editRollTarget.rollId}</div>
                <div>物料品号</div>
                <div className="num">{editRollTarget.rollModel}</div>
                <div>当前领用去向</div>
                <div className="num">
                  {editRollTarget.issuedMachineId || editRollTarget.issuedShiftTeam
                    ? [editRollTarget.issuedMachineId, editRollTarget.issuedShiftTeam].filter(Boolean).join(' · ')
                    : '在库未发料'}
                </div>
              </div>
              <div className="form" style={{ gridTemplateColumns: '100px 1fr', padding: '4px 0 12px' }}>
                <label htmlFor="inv-edit-batch">缸号 / 批次</label>
                <input
                  id="inv-edit-batch"
                  className="field num"
                  value={batchNoInput}
                  onChange={(e) => setBatchNoInput(e.target.value)}
                />
                <label htmlFor="inv-edit-color">色号</label>
                <input
                  id="inv-edit-color"
                  className="field"
                  value={colorInput}
                  onChange={(e) => setColorInput(e.target.value)}
                />
                <label htmlFor="inv-edit-shrink">预缩水率 %</label>
                <input
                  id="inv-edit-shrink"
                  type="number"
                  step="0.1"
                  min="0"
                  className="field num"
                  value={shrinkageInput}
                  onChange={(e) => setShrinkageInput(e.target.value)}
                />
                <label htmlFor="inv-edit-loc">存放库位</label>
                <input
                  id="inv-edit-loc"
                  className="field"
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className="btn" disabled={busy} onClick={onClose}>
                  取消
                </button>
                <button type="submit" className="btn pri" disabled={busy}>
                  保存母卷档案
                </button>
              </div>
            </>
          )}
        </form>
      ) : action === 'release' ? (
        <form onSubmit={onSubmit}>
          {(() => {
            const targetRem = remnants.find((r) => r.id === releaseRemnantId);
            const parentRoll = targetRem?.sourceRollId ? rollLookup.get(targetRem.sourceRollId) : null;
            return (
              <>
                <div className="kv" style={{ padding: '4px 0 10px' }}>
                  <div>隔离料头编号</div>
                  <div className="num">{targetRem?.id || releaseRemnantId}</div>
                  <div>来源母卷 / 缸色</div>
                  <div className="num">
                    {targetRem?.sourceRollId || '—'}
                    {(targetRem?.batchNo || parentRoll?.batchNo) && ` · 缸:${targetRem?.batchNo || parentRoll?.batchNo}`}
                    {(targetRem?.color || parentRoll?.color) && ` · ${targetRem?.color || parentRoll?.color}`}
                  </div>
                  <div>实物尺寸</div>
                  <div className="num">
                    {fmtN(targetRem?.width)} × {fmtN(targetRem?.length)} mm（{fmtN(targetRem?.area, 2)} m²）
                  </div>
                </div>
                <div className="form" style={{ gridTemplateColumns: '100px 1fr', padding: '4px 0 14px' }}>
                  <label htmlFor="inv-rel-decision">复验结论</label>
                  <select
                    id="inv-rel-decision"
                    className="field"
                    value={releaseDecision}
                    onChange={(e) => setReleaseDecision(e.target.value as 'RELEASE_AVAILABLE' | 'SCRAP')}
                  >
                    <option value="RELEASE_AVAILABLE">合格放行（转为 AVAILABLE 可用）</option>
                    <option value="SCRAP">复验判废（转为 SCRAPPED 报废）</option>
                  </select>
                  <label htmlFor="inv-rel-inspector">质检员</label>
                  <input
                    id="inv-rel-inspector"
                    className="field"
                    required
                    placeholder="如：质检员张工"
                    value={releaseInspector}
                    onChange={(e) => setReleaseInspector(e.target.value)}
                  />
                  <label htmlFor="inv-rel-reason">复验说明</label>
                  <input
                    id="inv-rel-reason"
                    className="field"
                    required
                    placeholder="如：二次人工验布确认无暗伤，准予放行排料"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <p className="muted" style={{ fontSize: 12, margin: '0 0 14px' }}>
                  本次放行/判废将生成不可变质量放行单并写入 `QUALITY_RELEASE` 账本流水（支持跨刷新幂等防重）。
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn" disabled={busy} onClick={onClose}>
                    取消
                  </button>
                  <button type="submit" className="btn pri" disabled={busy}>
                    {releaseDecision === 'RELEASE_AVAILABLE' ? '确认放行转可用' : '确认复验判废'}
                  </button>
                </div>
              </>
            );
          })()}
        </form>
      ) : action === 'scrapRoll' ? (
        <form onSubmit={onSubmit}>
          {(() => {
            const targetRoll = rolls.find((r) => r.rollId === scrapRollId);
            const remLen =
              targetRoll?.currentRemainingLength ??
              (targetRoll?.totalLength || 0) - (targetRoll?.usedLength || 0);
            return (
              <>
                <div
                  role="alert"
                  style={{
                    borderLeft: '3px solid var(--err, #dc2626)',
                    background: 'var(--err-bg, rgba(220,38,38,0.08))',
                    padding: '8px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    color: 'var(--err, #991b1b)',
                    marginBottom: 10
                  }}
                >
                  <strong>高风险受控操作：</strong>
                  母卷报废将清零未切余量并标记为 SCRAPPED（保留历史已切消耗与报工记录不篡改）。若存在活跃预约或排程方案将被服务端拦截。
                </div>
                <div className="kv" style={{ padding: '4px 0 10px' }}>
                  <div>母卷编号</div>
                  <div className="num">{targetRoll?.rollId || scrapRollId}</div>
                  <div>物料品号 / 缸号</div>
                  <div className="num">
                    {targetRoll?.rollModel || '—'}
                    {targetRoll?.batchNo ? ` · 缸:${targetRoll.batchNo}` : ''}
                  </div>
                  <div>当前未切余量</div>
                  <div className="num">
                    {fmtM(remLen)} m / 整卷 {fmtM(targetRoll?.totalLength || 0)} m（已切{' '}
                    {fmtM(targetRoll?.usedLength || 0)} m）
                  </div>
                </div>
                <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
                  <label htmlFor="inv-scrap-roll-op">经办人</label>
                  <input
                    id="inv-scrap-roll-op"
                    className="field"
                    required
                    placeholder="如：仓管李工"
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                  />
                  <label htmlFor="inv-scrap-roll-reason">报废原因</label>
                  <input
                    id="inv-scrap-roll-reason"
                    className="field"
                    required
                    autoFocus
                    placeholder="如：受潮霉变无法继续裁切"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn" disabled={busy} onClick={onClose}>
                    取消
                  </button>
                  <button type="submit" className="btn pri" disabled={busy}>
                    二次确认母卷报废
                  </button>
                </div>
              </>
            );
          })()}
        </form>
      ) : action === 'scrap' ? (
        <form onSubmit={onSubmit}>
          {(() => {
            const targetRem = remnants.find((r) => r.id === scrapId);
            return (
              <>
                <div className="kv" style={{ padding: '4px 0 10px' }}>
                  <div>料头编号</div>
                  <div className="num">{targetRem?.id}</div>
                  <div>关联来源母卷</div>
                  <div className="num">{targetRem?.sourceRollId || '—'}</div>
                  <div>实物尺寸</div>
                  <div className="num">
                    {fmtN(targetRem?.width)} × {fmtN(targetRem?.length)} mm（{fmtN(targetRem?.area, 2)} m²）
                  </div>
                </div>
                <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
                  <label htmlFor="inv-scrap-reason">报废原因</label>
                  <input
                    id="inv-scrap-reason"
                    className="field"
                    required
                    autoFocus
                    value={reason}
                    placeholder="如：污损无法复用 / 窄边清理"
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn" disabled={busy} onClick={onClose}>
                    取消
                  </button>
                  <button type="submit" className="btn pri" disabled={busy}>
                    确认报废
                  </button>
                </div>
              </>
            );
          })()}
        </form>
      ) : !opts ? (
        <div className="loading">正在校验已选母卷与料头可操作状态…</div>
      ) : (
        <form onSubmit={onSubmit}>
          <div className="mp-table-scroll" style={{ marginBottom: 12 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>实物编号</th>
                  <th>当前库位</th>
                  {action === 'count' && (
                    <>
                      <th>实物在库</th>
                      <th className="r">实测宽 mm</th>
                      <th className="r">实测长 mm</th>
                    </>
                  )}
                  <th />
                </tr>
              </thead>
              <tbody>
                {selectedMaterials.map(({ type, id, m }) => {
                  const rowKey = `${type}:${id}`;
                  const c = getCountRow(rowKey);
                  return (
                    <tr key={rowKey}>
                      <td>
                        <span className="tag kind">{type === 'roll' ? '母卷' : '料头'}</span>
                      </td>
                      <td className="num">{id}</td>
                      <td>{m?.location || '—'}</td>
                      {action === 'count' && (
                        <>
                          <td>
                            <input
                              type="checkbox"
                              checked={c.present}
                              onChange={(e) => updateCountRow(rowKey, { present: e.target.checked })}
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              className="field num"
                              value={c.width}
                              style={{ width: 72, textAlign: 'right' }}
                              disabled={type === 'roll' || !c.present}
                              onChange={(e) => updateCountRow(rowKey, { width: e.target.value })}
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              className="field num"
                              value={c.length}
                              style={{ width: 82, textAlign: 'right' }}
                              disabled={!c.present}
                              onChange={(e) => updateCountRow(rowKey, { length: e.target.value })}
                            />
                          </td>
                        </>
                      )}
                      <td>
                        {!m?.allowed && (
                          <span className="tag err" title={m?.reason || '不可操作'}>
                            不可操作
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {blockedMaterials.length > 0 && (
            <div className="notice" style={{ marginBottom: 10 }}>
              {blockedMaterials.map((x) => (
                <div key={`${x.type}:${x.id}`}>
                  {x.id}：{x.m?.reason || '当前处于锁定或不可操作状态'}
                </div>
              ))}
            </div>
          )}

          <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
            {action === 'transfer' && (
              <>
                <label htmlFor="inv-dest">目标库位</label>
                <input
                  id="inv-dest"
                  className="field"
                  required
                  value={destination}
                  placeholder="如：裁床待料区 A-02"
                  onChange={(e) => setDestination(e.target.value)}
                />
              </>
            )}
            <label htmlFor="inv-reason">变更原因</label>
            <input
              id="inv-reason"
              className="field"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <label htmlFor="inv-operator">经办人</label>
            <input
              id="inv-operator"
              className="field"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 14px' }}>
            {action === 'count'
              ? '母卷按实测剩余长度核对（幅宽不变）；料头核对实测宽×长；实物不在库请取消勾选。盘点差异独立入账，不计入生产耗用。'
              : '移库仅变更存放库位并生成不可变移库单，不改变数量、质量状态与母卷谱系。'}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="btn pri"
              disabled={busy || blockedMaterials.length > 0 || selectedMaterials.length === 0}
            >
              确认{ACTION_TITLES[action]}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
};
