import React from 'react';

export interface FeedbackAction {
  label: string;
  onClick: () => void;
  testId?: string;
  primary?: boolean;
  disabled?: boolean;
}

export interface OperationFeedbackCardProps {
  tone: 'err' | 'warn' | 'ok' | 'info';
  title: string;
  message: string;
  traceId?: string;
  testId?: string;
  actions?: FeedbackAction[];
}

const TONE_CLASS: Record<OperationFeedbackCardProps['tone'], string> = {
  err: 'is-err',
  warn: 'is-warn',
  ok: 'is-ok',
  info: ''
};

export const OperationFeedbackCard: React.FC<OperationFeedbackCardProps> = ({
  tone,
  title,
  message,
  traceId,
  testId = 'operation-feedback-card',
  actions
}) => {
  return (
    <section
      className={`sec-feedback ${TONE_CLASS[tone]}`.trim()}
      role={tone === 'err' || tone === 'warn' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>{title}</strong>
        {traceId && (
          <span className="num" style={{ fontSize: 11, color: 'var(--cp-ink-3)' }}>
            traceId: {traceId}
          </span>
        )}
      </div>
      <div>{message}</div>
      {actions && actions.length > 0 && (
        <div className="sec-feedback-actions">
          {actions.map((act, idx) => (
            <button
              key={`${act.label}-${idx}`}
              type="button"
              className={act.primary ? 'btn sm pri' : 'btn sm'}
              data-testid={act.testId}
              disabled={act.disabled}
              onClick={act.onClick}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
};
