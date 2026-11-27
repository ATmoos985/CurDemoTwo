import React from 'react';
import { ModalDialog } from '../../components/ModalDialog';

export interface PendingConfirmAction {
  title: string;
  description: string;
  action: () => void;
}

interface WorkbenchSwitchConfirmModalProps {
  pendingConfirm: PendingConfirmAction | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export const WorkbenchSwitchConfirmModal: React.FC<WorkbenchSwitchConfirmModalProps> = ({
  pendingConfirm,
  onCancel,
  onConfirm
}) => (
  <ModalDialog
    open={Boolean(pendingConfirm)}
    title={pendingConfirm?.title || '确认切换操作'}
    onClose={onCancel}
    maxWidth={440}
  >
    <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.6 }}>
      {pendingConfirm?.description}
    </p>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" className="btn" onClick={onCancel}>
        取消
      </button>
      <button type="button" className="btn pri" onClick={onConfirm}>
        确认切换
      </button>
    </div>
  </ModalDialog>
);
