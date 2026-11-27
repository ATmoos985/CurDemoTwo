import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { NumberInput } from '../../components/ui/NumberInput';
import { MAX_REVERSAL_REASON_LENGTH } from './reportReversalUtils';

export interface ResultsActionModalsProps {
  activeScheme: any;
  boundRoll: any;
  taskOpenMap: Record<string, number>;
  busy: boolean;
  showCompleteModal: boolean;
  onCloseCompleteModal: () => void;
  actualCutLenInput: number;
  setActualCutLenInput: (v: number) => void;
  recoverRems: boolean;
  setRecoverRems: (v: boolean) => void;
  remnantLoc: string;
  setRemnantLoc: (v: string) => void;
  rejectedIds: Set<number>;
  setRejectedIds: (s: Set<number>) => void;
  onCompleteScheme: (customMode: boolean) => void;
  showQuickCompleteConfirm: boolean;
  onCloseQuickCompleteConfirm: () => void;
  showCancelConfirm: boolean;
  onCloseCancelConfirm: () => void;
  onCancelScheme: () => void;
  showReplenishModal: boolean;
  onCloseReplenishModal: () => void;
  replenishOperator: string;
  setReplenishOperator: (v: string) => void;
  replenishReason: string;
  setReplenishReason: (v: string) => void;
  onGenerateReplenishTask: (e: React.FormEvent) => void;
  showReverseModal: boolean;
  onCloseReverseModal: () => void;
  schemeReversal: { targetPlanIds: string[] };
  reverseReason: string;
  setReverseReason: (v: string) => void;
  reverseError: string;
  clearReverseError: () => void;
  onReverseScheme: (e: React.FormEvent) => void;
}

export const ResultsActionModals: React.FC<ResultsActionModalsProps> = ({
  activeScheme,
  boundRoll,
  taskOpenMap,
  busy,
  showCompleteModal,
  onCloseCompleteModal,
  actualCutLenInput,
  setActualCutLenInput,
  recoverRems,
  setRecoverRems,
  remnantLoc,
  setRemnantLoc,
  rejectedIds,
  setRejectedIds,
  onCompleteScheme,
  showQuickCompleteConfirm,
  onCloseQuickCompleteConfirm,
  showCancelConfirm,
  onCloseCancelConfirm,
  onCancelScheme,
  showReplenishModal,
  onCloseReplenishModal,
  replenishOperator,
  setReplenishOperator,
  replenishReason,
  setReplenishReason,
  onGenerateReplenishTask,
  showReverseModal,
  onCloseReverseModal,
  schemeReversal,
  reverseReason,
  setReverseReason,
  reverseError,
  clearReverseError,
  onReverseScheme
}) => {
  return (
    <>
      <ModalDialog
        open={showCompleteModal}
        title="实切完工核销登记（支持实切长度微调、异常废片剔除与余料入库）"
        onClose={onCloseCompleteModal}
        maxWidth={680}
      >
        {activeScheme && (
          <div>
            <div className="form" style={{ gridTemplateColumns: '130px 1fr', padding: '4px 0 12px' }}>
              <label>绑定母卷 / 料头</label>
              <div className="num" style={{ fontWeight: 600 }}>
                <CodeBadge>{activeScheme.rollId || activeScheme.remnantId}</CodeBadge>
              </div>
              {activeScheme.dimension !== 'SLITTING_1D' && !activeScheme.remnantId && (
                <>
                  <label>实切耗用长度 mm</label>
                  <NumberInput
                    className="field num"
                    min={0}
                    value={actualCutLenInput}
                    onValueChange={setActualCutLenInput}
                  />
                </>
              )}
              <label>余料自动入库</label>
              <label className="mp-modal-switch-row">
                <input
                  type="checkbox"
                  className="ux-switch"
                  checked={recoverRems}
                  onChange={(e) => setRecoverRems(e.target.checked)}
                />
                <span>将满足最小回收尺寸的预计余料自动登记入库</span>
              </label>
              <label>余料存放库位</label>
              <input className="field" value={remnantLoc} onChange={(e) => setRemnantLoc(e.target.value)} />
            </div>

            {activeScheme.layout2D?.placements?.length > 0 && (
              <>
                <div className="sec" style={{ margin: '0 -16px 8px' }}>
                  逐件质检结果（默认全部合格；若切坏勾选判废，缺口将自动退回需求池补排）
                </div>
                <div className="mp-modal-table-box">
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>件号</th>
                          <th>名称</th>
                          <th className="r">尺寸 mm</th>
                          <th>当场判废</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeScheme.layout2D.placements.map((p: any) => {
                          const isRej = rejectedIds.has(p.id);
                          return (
                            <tr key={p.id}>
                              <td className="num">#{p.id}</td>
                              <td>{p.name}</td>
                              <td className="r num">
                                {fmtN(p.shape?.width || p.w)} × {fmtN(p.shape?.height || p.l)}
                              </td>
                              <td>
                                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                  <input
                                    type="checkbox"
                                    checked={isRej}
                                    onChange={(e) => {
                                      const next = new Set(rejectedIds);
                                      if (e.target.checked) next.add(p.id);
                                      else next.delete(p.id);
                                      setRejectedIds(next);
                                    }}
                                  />
                                  <span style={{ color: isRej ? 'var(--err)' : 'var(--ok)' }}>
                                    {isRej ? '异常报废' : '合格'}
                                  </span>
                                </label>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn" onClick={onCloseCompleteModal}>
                取消
              </button>
              <button type="button" className="btn pri" disabled={busy} onClick={() => onCompleteScheme(true)}>
                确认过账记账
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      <ModalDialog
        open={showQuickCompleteConfirm}
        title="确认一键完工记账"
        onClose={onCloseQuickCompleteConfirm}
        maxWidth={520}
      >
        {activeScheme && (
          <div>
            <p style={{ margin: '0 0 12px', fontSize: 13 }}>
              请核对本次完工过账摘要。确认后将正式扣减材料库存并结转需求族良品完成量：
            </p>
            <div
              className="form num"
              style={{
                gridTemplateColumns: '124px 1fr',
                padding: '10px 12px',
                background: 'var(--panel-2)',
                borderRadius: 8,
                border: '1px solid var(--line-2)',
                marginBottom: 14
              }}
            >
              <label>排程方案号</label>
              <b>{activeScheme.id}</b>
              <label>领用母卷 / 料头</label>
              <b>{activeScheme.remnantId ? `料头 ${activeScheme.remnantId}` : activeScheme.rollId || '未绑定'}</b>
              <label>实切消耗</label>
              <b>
                {activeScheme.remnantId
                  ? `整块料头 (${activeScheme.widthMm} × ${fmtN(activeScheme.occupiedLengthMm, 1)} mm)`
                  : activeScheme.dimension === 'SLITTING_1D' && activeScheme.slitting1D
                  ? `${activeScheme.slitting1D.totalCars} 车 · 共 ${fmtN(activeScheme.occupiedLengthMm, 1)} mm`
                  : `${fmtN(activeScheme.occupiedLengthMm, 1)} mm (Y=${fmtN(activeScheme.windowStartY || 0, 0)}~${fmtN(
                      (activeScheme.windowStartY || 0) + activeScheme.occupiedLengthMm,
                      0
                    )})`}
              </b>
              <label>预计合格产出</label>
              <b>
                {activeScheme.placedCount} {activeScheme.dimension === 'SLITTING_1D' ? '卷' : '件'}
              </b>
              <label>派生余料处理</label>
              <span>自动回收达标余料至「裁床余料架 A-01」</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={onCloseQuickCompleteConfirm}>
                取消
              </button>
              <button type="button" className="btn pri" disabled={busy} onClick={() => onCompleteScheme(false)}>
                {busy ? '过账中…' : '确认一键完工记账'}
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      <ModalDialog open={showCancelConfirm} title="确认作废排程方案" onClose={onCloseCancelConfirm} maxWidth={460}>
        {activeScheme && (
          <div>
            <p style={{ margin: '0 0 14px', fontSize: 13 }}>
              确认作废方案「<b>{activeScheme.id}</b>」并将预占需求退回待排需求池吗？作废后将释放关联母卷或料头的预占区段。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={onCloseCancelConfirm}>
                取消
              </button>
              <button type="button" className="btn pri" disabled={busy} onClick={onCancelScheme}>
                {busy ? '处理中…' : '确认作废'}
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      <ModalDialog
        open={showReplenishModal}
        title="一键生成同缸加急补片单（防色差）"
        onClose={() => {
          if (!busy) onCloseReplenishModal();
        }}
        maxWidth={520}
      >
        {activeScheme && (
          <form onSubmit={onGenerateReplenishTask}>
            <p style={{ margin: '0 0 10px', fontSize: 12.5 }}>
              系统将按源方案的缺口/判废明细自动新建一张 <b>URGENT 加急</b> 且启用 <b>同单同缸强约束</b>{' '}
              的补片需求任务，自动继承原母卷品号与缸色属性：
            </p>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>源方案号</div>
              <div>{activeScheme.id}</div>
              <div>原实卷 / 缸号色号</div>
              <div>
                {activeScheme.rollId || '未绑定实卷'}
                {boundRoll?.batchNo ? ` · 缸:${boundRoll.batchNo}` : ''}
                {boundRoll?.color ? ` · ${boundRoll.color}` : ''}
              </div>
              <div>待补缺口提示</div>
              <div>
                方案产出 {activeScheme.placedCount}/{activeScheme.requestedCount} · 需求族剩余待排{' '}
                {taskOpenMap[activeScheme.taskId] ?? 0}
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
              <label htmlFor="rep-operator">经办人</label>
              <input
                id="rep-operator"
                className="field"
                required
                value={replenishOperator}
                onChange={(e) => setReplenishOperator(e.target.value)}
              />
              <label htmlFor="rep-reason">补片原因</label>
              <input
                id="rep-reason"
                className="field"
                required
                value={replenishReason}
                onChange={(e) => setReplenishReason(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={onCloseReplenishModal}>
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在生成…' : '确认生成同缸补片单'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      <ModalDialog
        open={showReverseModal}
        title="冲销完工报工（回滚母卷消耗与订单完成量）"
        onClose={() => {
          if (!busy) {
            onCloseReverseModal();
            clearReverseError();
          }
        }}
        maxWidth={540}
      >
        {activeScheme && (
          <form onSubmit={onReverseScheme}>
            <div
              role="alert"
              style={{
                borderLeft: '3px solid var(--err, #dc2626)',
                background: 'rgba(220, 38, 38, 0.08)',
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                color: 'var(--err, #991b1b)',
                marginBottom: 10
              }}
            >
              <strong>冲销边界说明：</strong>
              冲销后将恢复本次报工消耗的母卷/料头用量、作废本次派生余料、回滚对应订单完成量，并将方案状态置为{' '}
              <b>已冲销释放（REVERSED）</b>
              。若报工已存在复检处置、材料已有后续盘点/后续报工，或派生料头已流转，服务端将拒绝冲销。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>排程方案号</div>
              <div>{activeScheme.id}</div>
              <div>关联报工单号</div>
              <div>{schemeReversal.targetPlanIds.join('、') || '—'}</div>
              <div>领用母卷 / 料头</div>
              <div>{activeScheme.remnantId ? `料头 ${activeScheme.remnantId}` : activeScheme.rollId || '—'}</div>
              <div>已报产出</div>
              <div>
                {activeScheme.placedCount} {activeScheme.dimension === 'SLITTING_1D' ? '卷' : '件'} · 占长{' '}
                {fmtN(activeScheme.occupiedLengthMm, 1)} mm
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
              <label htmlFor="scheme-reverse-reason">冲销原因</label>
              <div>
                <textarea
                  id="scheme-reverse-reason"
                  className="field"
                  rows={3}
                  required
                  maxLength={MAX_REVERSAL_REASON_LENGTH}
                  placeholder="必填（1–500字），如：录入实切长度有误或错绑母卷需回滚重报"
                  value={reverseReason}
                  onChange={(e) => {
                    setReverseReason(e.target.value);
                    if (reverseError) clearReverseError();
                  }}
                  style={{ width: '100%', resize: 'vertical', minHeight: 68 }}
                />
                <div className="muted num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
                  <span>冲销操作将写入不可变过账流水（REPORT_REVERSE）</span>
                  <span>
                    {reverseReason.trim().length} / {MAX_REVERSAL_REASON_LENGTH}
                  </span>
                </div>
              </div>
            </div>
            {reverseError && (
              <div
                role="alert"
                style={{
                  marginBottom: 10,
                  padding: '6px 10px',
                  borderRadius: 4,
                  fontSize: 12,
                  background: 'rgba(220, 38, 38, 0.08)',
                  color: 'var(--err, #b91c1c)'
                }}
              >
                {reverseError}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  onCloseReverseModal();
                  clearReverseError();
                }}
              >
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在冲销…' : '确认冲销报工'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </>
  );
};
