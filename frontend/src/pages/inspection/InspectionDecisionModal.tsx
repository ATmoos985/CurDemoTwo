import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';

export interface InspectionDecisionModalProps {
  open: boolean;
  action: 'PASSED' | 'FAILED' | null;
  roll: any;
  pendingCount: number;
  inspectorName: string;
  onSetInspectorName: (v: string) => void;
  inspectRemarks: string;
  onSetInspectRemarks: (v: string) => void;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export const InspectionDecisionModal: React.FC<InspectionDecisionModalProps> = ({
  open,
  action,
  roll,
  pendingCount,
  inspectorName,
  onSetInspectorName,
  inspectRemarks,
  onSetInspectRemarks,
  submitting,
  onClose,
  onSubmit
}) => {
  return (
    <ModalDialog
      open={open}
      title={
        action === 'PASSED'
          ? `确认质检合格放行 · ${roll?.rollId || ''}`
          : `确认判定母卷不合格 · ${roll?.rollId || ''}`
      }
      onClose={onClose}
      maxWidth={480}
    >
      <form onSubmit={onSubmit}>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 10 }}>
          <div>
            母卷：<b className="num">{roll?.rollId}</b> · 品号{' '}
            <b className="num">{roll?.rollModel || '—'}</b> ·{' '}
            <span className="num">
              {roll ? `${fmtN(roll.width)}mm × ${fmtM(roll.totalLength)}m` : ''}
            </span>
          </div>
          <div>
            已入档疵点 <b className="num">{(roll?.defects || []).length}</b> 处
            {pendingCount > 0 && (
              <>
                ，另有 <b className="num">{pendingCount}</b> 处待存草稿将在提交时自动入档
              </>
            )}
            。
          </div>
        </div>
        <div className="form" style={{ gridTemplateColumns: '88px 1fr', padding: '4px 0 12px' }}>
          <label htmlFor="qc-inspector">质检员</label>
          <input
            id="qc-inspector"
            className="field"
            placeholder="如：质检李工（认证模式下自动取当前登录人）"
            value={inspectorName}
            onChange={(e) => onSetInspectorName(e.target.value)}
          />
          <label htmlFor="qc-remarks">检验备注</label>
          <input
            id="qc-remarks"
            className="field"
            placeholder={
              action === 'PASSED'
                ? '选填：门幅、克重与疵点复核合格'
                : '必填或说明：色差/破损超标原因'
            }
            required={action === 'FAILED'}
            value={inspectRemarks}
            onChange={(e) => onSetInspectRemarks(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn pri"
            style={
              action === 'FAILED'
                ? { background: 'var(--err, #dc2626)', borderColor: 'var(--err, #dc2626)' }
                : undefined
            }
            disabled={submitting}
          >
            {submitting
              ? '提交中…'
              : action === 'PASSED'
              ? '确认放行 (PASSED)'
              : '确认判不合格 (FAILED)'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
};
