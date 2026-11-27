import React from 'react';
import type { WorkbenchDraftPayload } from '../../store/workbenchDraft';
import type {
  BatchGuardWarning,
  SchemeExecutionSummary,
  TaskExecutionProjection
} from './workbenchProjectionUtils';

export const BatchGuardBanner: React.FC<{
  warning: BatchGuardWarning;
  onSelectSuggestedRoll: (roll: any) => void;
}> = ({ warning, onSelectSuggestedRoll }) => (
  <div
    role="alert"
    style={{
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
      padding: '7px 14px',
      fontSize: 12.5,
      borderBottom: `1px solid ${
        warning.blocking ? 'var(--err, #dc2626)' : 'var(--warn, #d97706)'
      }`,
      background: warning.blocking
        ? 'var(--err-bg, rgba(220, 38, 38, 0.12))'
        : 'var(--warn-bg, rgba(245, 158, 11, 0.14))',
      color: warning.blocking ? 'var(--err, #b91c1c)' : 'var(--warn, #92400e)'
    }}
  >
    <strong>{warning.title}：</strong>
    <span>{warning.detail}</span>
    {warning.suggestedRoll && (
      <button
        type="button"
        className="btn sm pri"
        style={{ marginLeft: 'auto' }}
        onClick={() => onSelectSuggestedRoll(warning.suggestedRoll)}
      >
        一键切换至同缸卷 {warning.suggestedRoll.rollId}
      </button>
    )}
  </div>
);

export const TaskExecutionSyncBar: React.FC<{
  projection: TaskExecutionProjection;
  is2D: boolean;
  hasConfirmedActive2D: boolean;
  activeSchemeExecution: SchemeExecutionSummary | null;
}> = ({ projection, is2D, hasConfirmedActive2D, activeSchemeExecution }) => {
  const hasReinspection = projection.reinspectionDisposedTotal > 0;
  const hasRejected = projection.rejectedTotalCount > 0;
  const unitLabel = is2D ? '片' : '卷';
  const activeDisposedCount = activeSchemeExecution?.disposedPieces.size ?? 0;

  return (
    <div
      role="status"
      aria-label="实绩与复检同步条"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 10,
        padding: '7px 14px',
        fontSize: 12.5,
        borderBottom: `1px solid ${
          hasReinspection
            ? 'var(--warn, #d97706)'
            : 'var(--line-2, rgba(148, 163, 184, 0.35))'
        }`,
        borderLeft: `3px solid ${
          hasReinspection
            ? 'var(--err, #dc2626)'
            : hasRejected
            ? 'var(--warn, #d97706)'
            : 'var(--ok, #059669)'
        }`,
        background: hasReinspection
          ? 'var(--warn-bg, rgba(245, 158, 11, 0.12))'
          : 'var(--panel-2, rgba(16, 185, 129, 0.08))'
      }}
    >
      <span className={`tag ${hasReinspection ? 'warn' : 'ok'}`}>
        实绩与复检同步 · {projection.reportCount} 笔报工
      </span>
      <span className="num">
        已实切净合格{' '}
        <b style={{ color: 'var(--ok, #059669)' }}>
          {projection.netQualifiedCount} {unitLabel}
        </b>
      </span>
      <span className="num">
        复检判废扣回{' '}
        <b
          style={{
            color: hasReinspection ? 'var(--err, #dc2626)' : 'var(--cp-ink-2, inherit)'
          }}
        >
          {projection.reinspectionDisposedTotal} {unitLabel}
        </b>
        {projection.reinspectionRemnantCount > 0 && (
          <span className="muted">
            （含转料头 {projection.reinspectionRemnantCount} {unitLabel}）
          </span>
        )}
      </span>
      {projection.rejectedTotalCount > projection.reinspectionDisposedTotal && (
        <span className="num muted">
          报工初始异常{' '}
          {projection.rejectedTotalCount - projection.reinspectionDisposedTotal}{' '}
          {unitLabel}
        </span>
      )}
      <span className="num">
        待补排余量{' '}
        <b
          style={{
            color:
              projection.openRemainingCount > 0
                ? 'var(--warn, #b45309)'
                : 'var(--ok, #059669)'
          }}
        >
          {projection.openRemainingCount} {unitLabel}
        </b>
      </span>
      {is2D && hasConfirmedActive2D && activeDisposedCount > 0 && (
        <span className="tag err num">
          当前方案 {activeDisposedCount} 片已复检判废（画布已标注）
        </span>
      )}
      <span className="sp" />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <a className="btn sm" href="#/reconciliation">
          复检处置 ↗
        </a>
        <a className="btn sm" href="#/reconciliation">
          履约账本 ↗
        </a>
      </div>
    </div>
  );
};

export const LocalDraftRecoveryBanner: React.FC<{
  draft: WorkbenchDraftPayload;
  onRestore: () => void;
  onIgnore: () => void;
}> = ({ draft, onRestore, onIgnore }) => (
  <div className="wb-draft-banner" role="status">
    <span>
      检测到本机未落库工作台草稿（保存于{' '}
      <b className="num">
        {new Date(draft.savedAt).toLocaleString('zh-CN', { hour12: false })}
      </b>
      ，含 {draft.activeDemands2D?.length || 0} 条二维需求 /{' '}
      {draft.unconfirmedSchemes2D?.length || 0} 套未确认手调方案）
    </span>
    <span className="sp" />
    <button type="button" className="btn sm pri" onClick={onRestore}>
      恢复草稿
    </button>
    <button type="button" className="btn sm" onClick={onIgnore}>
      忽略并清除
    </button>
  </div>
);
