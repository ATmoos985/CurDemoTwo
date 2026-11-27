import React, { useEffect, useMemo, useState } from 'react';
import {
  formatDraftMaterialType,
  getDraftStatusMeta,
  groupDraftsByBatch,
  type DraftStatusFilter,
  type WorkbenchDraftDto
} from './draftInboxApi';

const STATUS_TABS: { key: DraftStatusFilter; label: string }[] = [
  { key: 'PENDING_CONFIRMATION', label: '待确认' },
  { key: 'CONFIRMED', label: '已确认' },
  { key: 'DISCARDED', label: '已作废' },
  { key: 'EXPIRED', label: '已过期' },
  { key: 'ALL', label: '全部' }
];

export interface DraftInboxDrawerProps {
  open: boolean;
  drafts: WorkbenchDraftDto[];
  total: number;
  pendingCount: number;
  statusFilter: DraftStatusFilter;
  batchGroupFilter: string | null;
  activeDraftId: string | null;
  loading: boolean;
  loadingMore?: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onChangeStatusFilter: (next: DraftStatusFilter) => void;
  onClearBatchGroupFilter: () => void;
  onPreviewDraft: (draft: WorkbenchDraftDto) => void;
  onDiscardDraft: (draft: WorkbenchDraftDto) => void;
}

function fmtShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

export const DraftInboxDrawer: React.FC<DraftInboxDrawerProps> = ({
  open,
  drafts,
  total,
  pendingCount,
  statusFilter,
  batchGroupFilter,
  activeDraftId,
  loading,
  loadingMore = false,
  error,
  onClose,
  onRefresh,
  onLoadMore,
  onChangeStatusFilter,
  onClearBatchGroupFilter,
  onPreviewDraft,
  onDiscardDraft
}) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const groups = useMemo(() => groupDraftsByBatch(drafts), [drafts]);

  if (!open) return null;

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      className="wb-draft-drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="wb-draft-drawer"
        role="dialog"
        aria-label="待确认草案收件箱"
        data-testid="draft-inbox-drawer"
      >
        <div className="wb-draft-drawer-head">
          <div>
            <h2>待确认草案收件箱</h2>
            <p className="wb-draft-drawer-sub">
              仅预览与人工核对，未锁扣任何实物库存（共 <b className="num">{total}</b> 条）
            </p>
          </div>
          <div className="wb-draft-drawer-head-actions">
            <button type="button" className="btn sm" onClick={onRefresh} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
            <button type="button" className="btn sm" onClick={onClose} aria-label="关闭收件箱">
              关闭
            </button>
          </div>
        </div>

        <div className="wb-draft-filter-bar" role="tablist" aria-label="草案状态过滤">
          {STATUS_TABS.map((tab) => {
            const active = statusFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                className={`btn sm ${active ? 'pri' : ''}`}
                onClick={() => onChangeStatusFilter(tab.key)}
                data-testid={`draft-filter-${tab.key}`}
              >
                {tab.label}
                {tab.key === 'PENDING_CONFIRMATION' && pendingCount > 0 && (
                  <span className="wb-draft-tab-count num">{pendingCount}</span>
                )}
              </button>
            );
          })}
        </div>

        {batchGroupFilter && (
          <div className="wb-draft-batch-filter-chip">
            <span className="num">批组筛选：{batchGroupFilter}</span>
            <button type="button" className="btn sm" onClick={onClearBatchGroupFilter}>
              查看全部批组 ×
            </button>
          </div>
        )}

        <div className="wb-draft-drawer-body">
          {error && (
            <div className="wb-draft-error-box" role="alert">
              <span>{error}</span>
              <button type="button" className="btn sm" onClick={onRefresh}>
                重试
              </button>
            </div>
          )}

          {!loading && groups.length === 0 && !error && (
            <div className="wb-draft-empty">
              <b>暂无符合条件的排料草案</b>
              <p>
                可由 AI 排产助手通过 MCP 创建草案，或在「多料联排」试排后点击「生成联排草案组」。
              </p>
            </div>
          )}

          {groups.map((group) => {
            const collapsed = Boolean(collapsedGroups[group.key]);
            return (
              <section
                key={group.key}
                className={`wb-draft-group ${group.isBatchGroup ? 'is-batch' : ''}`}
                data-testid={group.batchGroupId ? `draft-batch-${group.batchGroupId}` : undefined}
              >
                {group.isBatchGroup && (
                  <header className="wb-draft-group-head">
                    <div className="wb-draft-group-title">
                      <span className="tag run">多料联排批组</span>
                      <b className="num">{group.batchGroupId}</b>
                    </div>
                    <div className="wb-draft-group-meta num">
                      <span>
                        共 {group.drafts.length} 份（{group.remnantCount} 料头 + {group.rollCount} 母卷）
                      </span>
                      {group.pendingCount > 0 && (
                        <span className="tag kind">待确认 {group.pendingCount}</span>
                      )}
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => toggleGroup(group.key)}
                      >
                        {collapsed ? '展开' : '收起'}
                      </button>
                    </div>
                  </header>
                )}

                {!collapsed && (
                  <div className="wb-draft-list">
                    {group.drafts.map((draft) => {
                      const draftId = draft.draftId || draft.id;
                      const statusMeta = getDraftStatusMeta(draft.status, draft.stale);
                      const isCurrent = Boolean(activeDraftId && activeDraftId === draftId);
                      const isPending = draft.status === 'PENDING_CONFIRMATION';
                      return (
                        <article
                          key={draftId}
                          className={`wb-draft-card ${isCurrent ? 'is-active' : ''}`}
                          data-testid={`draft-card-${draftId}`}
                        >
                          <div className="wb-draft-card-top">
                            <span className={`tag ${statusMeta.tagClass}`}>{statusMeta.label}</span>
                            {draft.stale && isPending && (
                              <span className="tag err">版本已漂移</span>
                            )}
                            <b className="num wb-draft-id">{draftId}</b>
                            {draft.batchIndex != null && draft.batchTotal != null && (
                              <span className="tag kind num">
                                {draft.batchIndex}/{draft.batchTotal}
                              </span>
                            )}
                            <span className="sp" />
                            <span className="num wb-draft-time">
                              {fmtShortTime(draft.issuedAt)}
                            </span>
                          </div>

                          <div className="wb-draft-card-meta num">
                            <span>
                              材料：
                              <b>
                                {formatDraftMaterialType(draft.target?.materialType)} ·{' '}
                                {draft.target?.materialId || '自由画布'}
                              </b>
                            </span>
                            {draft.target?.taskId && (
                              <span>
                                任务：<b>{draft.target.taskId}</b>
                              </span>
                            )}
                            {isPending && (
                              <span>截止：{fmtShortTime(draft.expiresAt)}</span>
                            )}
                          </div>

                          {draft.note && <div className="wb-draft-note">{draft.note}</div>}

                          {draft.stale && isPending && draft.staleReasons?.length > 0 && (
                            <div className="wb-draft-stale-msg">
                              {draft.staleReasons.slice(0, 2).join('；')}
                            </div>
                          )}

                          {draft.status === 'CONFIRMED' && draft.confirmedSchemeId && (
                            <div className="wb-draft-result-link num">
                              已落库方案：
                              <a href={`#/results/${encodeURIComponent(draft.confirmedSchemeId)}`}>
                                {draft.confirmedSchemeId} ↗
                              </a>
                            </div>
                          )}

                          {draft.status === 'DISCARDED' && (
                            <div className="wb-draft-discard-msg">
                              作废原因：{draft.discardReason || '人工确认作废'}
                            </div>
                          )}

                          <div className="wb-draft-card-actions">
                            <button
                              type="button"
                              className={`btn sm ${isCurrent ? '' : 'pri'}`}
                              onClick={() => onPreviewDraft(draft)}
                              data-testid={`preview-draft-${draftId}`}
                            >
                              {isCurrent ? '当前画布预览中' : '工作台预览'}
                            </button>
                            {isPending && (
                              <button
                                type="button"
                                className="btn sm err"
                                onClick={() => onDiscardDraft(draft)}
                                data-testid={`discard-draft-${draftId}`}
                              >
                                作废
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}

          {drafts.length > 0 && drafts.length < total && (
            <div className="wb-draft-load-more">
              <span className="num">
                已展示 {drafts.length} / {total} 条
              </span>
              {onLoadMore && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={onLoadMore}
                  disabled={loading || loadingMore}
                  data-testid="draft-inbox-load-more"
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
