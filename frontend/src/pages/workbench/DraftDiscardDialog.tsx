import React, { useEffect, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { formatDraftMaterialType, type WorkbenchDraftDto } from './draftInboxApi';

const QUICK_DISCARD_REASONS = [
  '现场改用其他母卷/料头',
  '订单规格或交期已变更',
  '疵点位置需人工调整重排'
];

export interface DraftDiscardDialogProps {
  draft: WorkbenchDraftDto | null;
  submitting: boolean;
  onClose: () => void;
  onConfirmDiscard: (reason: string) => void;
}

/**
 * 原生 HTML5 <dialog> 作废草案确认弹窗：
 * 遵循工业防呆原则，明确提示“仅作废 AI 试排建议，不影响任何实物库存”。
 */
export const DraftDiscardDialog: React.FC<DraftDiscardDialogProps> = ({
  draft,
  submitting,
  onClose,
  onConfirmDiscard
}) => {
  const [reason, setReason] = useState('');
  const [validationMsg, setValidationMsg] = useState<string | null>(null);

  useEffect(() => {
    if (draft) {
      setReason('');
      setValidationMsg(null);
    }
  }, [draft]);

  const draftId = draft?.draftId || draft?.id || '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = reason.trim();
    if (!clean) {
      setValidationMsg('请填写或点选作废原因，便于后续排产追溯');
      return;
    }
    setValidationMsg(null);
    onConfirmDiscard(clean);
  };

  return (
    <ModalDialog
      open={Boolean(draft)}
      title="作废待确认草案"
      onClose={onClose}
      maxWidth={460}
    >
      {draft && (
        <form className="wb-discard-dialog-body" onSubmit={handleSubmit}>
          <div className="wb-discard-notice" role="status">
            <strong>安全提示：</strong>
            <span>作废仅关闭该 AI 试排建议，绝不扣减、锁定或恢复任何实物母卷与料头库存。</span>
          </div>

          <div className="wb-discard-meta num">
            <div>
              <span>草案编号</span>
              <b>{draftId}</b>
            </div>
            <div>
              <span>材料来源</span>
              <b>
                {formatDraftMaterialType(draft.target?.materialType)} ·{' '}
                {draft.target?.materialId || '自由画布'}
              </b>
            </div>
            {draft.target?.taskId && (
              <div>
                <span>关联任务</span>
                <b>{draft.target.taskId}</b>
              </div>
            )}
          </div>

          <div className="wb-discard-chips" role="group" aria-label="常用作废原因">
            {QUICK_DISCARD_REASONS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn sm ${reason.trim() === preset ? 'pri' : ''}`}
                onClick={() => {
                  setReason(preset);
                  setValidationMsg(null);
                }}
              >
                {preset}
              </button>
            ))}
          </div>

          <label className="wb-discard-field">
            <span>作废原因（必填，最多 500 字）</span>
            <textarea
              className="field"
              rows={3}
              maxLength={500}
              placeholder="例如：现场改用同缸更窄门幅卷 / 客户改码需要重排"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (validationMsg) setValidationMsg(null);
              }}
              data-testid="discard-reason-input"
            />
          </label>

          {validationMsg && (
            <div className="wb-discard-error" role="alert">
              {validationMsg}
            </div>
          )}

          <div className="wb-discard-actions">
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn err"
              disabled={submitting}
              data-testid="confirm-discard-btn"
            >
              {submitting ? '作废中…' : '确认作废'}
            </button>
          </div>
        </form>
      )}
    </ModalDialog>
  );
};
