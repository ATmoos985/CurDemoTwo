import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { DISPOSITIONS, reviewablePieces } from '../../lib/model/quality.js';
import { ModalDialog } from '../../components/ModalDialog';
import { MAX_REVERSAL_REASON_LENGTH } from '../results/reportReversalUtils';
import type { ReverseReportDraft, RevokeDraft } from './ReconciliationQualityTab';

export interface ReconciliationModalsProps {
  busy: boolean;
  qualityDraft: any;
  setQualityDraft: (d: any) => void;
  onSubmitQuality: (e: React.FormEvent) => void;
  revokeDraft: RevokeDraft | null;
  setRevokeDraft: (d: RevokeDraft | null) => void;
  onSubmitRevoke: (e: React.FormEvent) => void;
  reverseDraft: ReverseReportDraft | null;
  setReverseDraft: React.Dispatch<React.SetStateAction<ReverseReportDraft | null>>;
  onSubmitReverseReport: (e: React.FormEvent) => void;
}

export const ReconciliationModals: React.FC<ReconciliationModalsProps> = ({
  busy,
  qualityDraft,
  setQualityDraft,
  onSubmitQuality,
  revokeDraft,
  setRevokeDraft,
  onSubmitRevoke,
  reverseDraft,
  setReverseDraft,
  onSubmitReverseReport
}) => {
  return (
    <>
      <ModalDialog
        open={qualityDraft !== null}
        title="裁后质量复检重分类（保持原母卷耗用不变，扣回良品完成量）"
        onClose={() => {
          if (!busy) setQualityDraft(null);
        }}
        maxWidth={560}
      >
        {qualityDraft && (
          <form onSubmit={onSubmitQuality}>
            <div className="form" style={{ gridTemplateColumns: '110px 1fr', padding: '4px 0 12px' }}>
              <label>选择复检裁片</label>
              <select
                className="field"
                value={qualityDraft.pieceId}
                onChange={(e) => setQualityDraft({ ...qualityDraft, pieceId: Number(e.target.value) })}
              >
                {reviewablePieces(qualityDraft.report).map((p: any) => (
                  <option key={p.pieceId} value={p.pieceId}>
                    #{p.pieceId} {p.name} ({fmtN(p.w)}×{fmtN(p.l)} mm)
                  </option>
                ))}
              </select>
              <label>处置方式</label>
              <select
                className="field"
                value={qualityDraft.disposition}
                onChange={(e) => setQualityDraft({ ...qualityDraft, disposition: e.target.value })}
              >
                {Object.entries(DISPOSITIONS as Record<string, string>).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <label>检验人</label>
              <input
                className="field"
                required
                value={qualityDraft.inspector}
                placeholder="如：质检员王工"
                onChange={(e) => setQualityDraft({ ...qualityDraft, inspector: e.target.value })}
              />
              <label>判定原因</label>
              <input
                className="field"
                required
                value={qualityDraft.reason}
                placeholder="如：缝制前发现局部暗伤"
                onChange={(e) => setQualityDraft({ ...qualityDraft, reason: e.target.value })}
              />
              {qualityDraft.disposition === 'REMNANT' && (
                <>
                  <label>回收宽×长 mm</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      className="field num"
                      placeholder="宽"
                      value={qualityDraft.width}
                      onChange={(e) => setQualityDraft({ ...qualityDraft, width: e.target.value })}
                    />
                    <input
                      type="number"
                      className="field num"
                      placeholder="长"
                      value={qualityDraft.length}
                      onChange={(e) => setQualityDraft({ ...qualityDraft, length: e.target.value })}
                    />
                  </div>
                  <label>入库位置</label>
                  <input
                    className="field"
                    value={qualityDraft.location}
                    placeholder="如：复检回收架 Q-01"
                    onChange={(e) => setQualityDraft({ ...qualityDraft, location: e.target.value })}
                  />
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setQualityDraft(null)}>
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '过账中…' : '确认复检处置'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      <ModalDialog
        open={revokeDraft !== null}
        title="受控撤销复检处置（保留审计留痕，恢复良品量）"
        onClose={() => {
          if (!busy) setRevokeDraft(null);
        }}
        maxWidth={540}
      >
        {revokeDraft && (
          <form onSubmit={onSubmitRevoke}>
            <div
              role="alert"
              style={{
                borderLeft: '3px solid var(--warn, #d97706)',
                background: 'var(--warn-bg, rgba(245, 158, 11, 0.1))',
                padding: '8px 10px',
                borderRadius: 4,
                fontSize: 12,
                color: 'var(--warn, #92400e)',
                marginBottom: 10
              }}
            >
              <strong>撤销边界说明：</strong>
              撤销后将保留原复检记录并追加反向流水，恢复对应裁片的良品完成量、并将未使用的派生料头置为作废/撤销；原母卷消耗保持不变。若派生料头已被领用/移库将被服务端拦截。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>报工单号</div>
              <div>{revokeDraft.reportId}</div>
              <div>处置单号 / 裁片</div>
              <div>
                {revokeDraft.dispositionId} · 裁片 #{revokeDraft.pieceId ?? '—'}（{revokeDraft.dispositionLabel}）
              </div>
              <div>原检验人 / 原因</div>
              <div>
                {revokeDraft.inspector || '—'} · {revokeDraft.origReason || '—'}
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}>
              <label htmlFor="rev-operator">撤销经办人</label>
              <input
                id="rev-operator"
                className="field"
                required
                placeholder="如：质检主管刘工"
                value={revokeDraft.operator}
                onChange={(e) => setRevokeDraft({ ...revokeDraft, operator: e.target.value })}
              />
              <label htmlFor="rev-reason">撤销原因</label>
              <input
                id="rev-reason"
                className="field"
                required
                autoFocus
                placeholder="如：二次复核确认为可擦除粉尘印，误判撤回"
                value={revokeDraft.reason}
                onChange={(e) => setRevokeDraft({ ...revokeDraft, reason: e.target.value })}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setRevokeDraft(null)}>
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                {busy ? '正在撤销…' : '确认受控撤销'}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>

      <ModalDialog
        open={reverseDraft !== null}
        title="冲销报工回执（恢复母卷/料头消耗与订单完成量）"
        onClose={() => {
          if (!busy) setReverseDraft(null);
        }}
        maxWidth={540}
      >
        {reverseDraft && (
          <form onSubmit={onSubmitReverseReport}>
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
              冲销后将恢复本次报工消耗的母卷/料头用量、作废本次派生余料、回滚订单完成量，并将关联排程方案状态同步回滚为{' '}
              <b>已冲销释放（REVERSED）</b>
              。已有复检处置、后续盘点、后续报工或已流转派生料头的记录将被服务端拦截。
            </div>
            <div className="kv num" style={{ padding: '4px 0 10px' }}>
              <div>报工单号</div>
              <div>{reverseDraft.reportId}</div>
              <div>所属需求族</div>
              <div>{reverseDraft.taskName}</div>
              <div>消耗母卷 / 料头</div>
              <div>{reverseDraft.materialLabel}</div>
              <div>实切长 / 净合格</div>
              <div>
                {fmtN(reverseDraft.actualCutLen, 1)} mm · 净合格 {reverseDraft.qualifiedCount} 件
              </div>
            </div>
            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
              <label htmlFor="recon-reverse-reason">冲销原因</label>
              <div>
                <textarea
                  id="recon-reverse-reason"
                  className="field"
                  rows={3}
                  required
                  autoFocus
                  maxLength={MAX_REVERSAL_REASON_LENGTH}
                  placeholder="必填（1–500字），如：录入实切长度有误或错报母卷需撤回重报"
                  value={reverseDraft.reason}
                  onChange={(e) =>
                    setReverseDraft((prev) => (prev ? { ...prev, reason: e.target.value, error: '' } : null))
                  }
                  style={{ width: '100%', resize: 'vertical', minHeight: 68 }}
                />
                <div className="muted num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4 }}>
                  <span>冲销将写入不可变流水（REPORT_REVERSE）</span>
                  <span>
                    {reverseDraft.reason.trim().length} / {MAX_REVERSAL_REASON_LENGTH}
                  </span>
                </div>
              </div>
            </div>
            {reverseDraft.error && (
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
                {reverseDraft.error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setReverseDraft(null)}>
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
