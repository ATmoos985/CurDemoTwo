import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../../lib/core/util.js';
import {
  buildDraftDeeplinkHash,
  discardWorkbenchDraft,
  fetchWorkbenchDrafts,
  generateMultiMaterialDraftBatch,
  type DraftStatusFilter,
  type WorkbenchDraftDto
} from './draftInboxApi';

const PAGE_SIZE = 40;

export interface UseDraftInboxOptions {
  activeDraftId?: string | null;
  onForceReloadDeeplink?: () => void;
  onDraftStateChanged?: (draft: WorkbenchDraftDto) => void;
  onActiveDraftSynced?: (draft: WorkbenchDraftDto) => void;
}

export function useDraftInbox(options: UseDraftInboxOptions = {}) {
  const { activeDraftId, onForceReloadDeeplink, onDraftStateChanged, onActiveDraftSynced } = options;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DraftStatusFilter>('PENDING_CONFIRMATION');
  const [batchGroupFilter, setBatchGroupFilter] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<WorkbenchDraftDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [discardTarget, setDiscardTarget] = useState<WorkbenchDraftDto | null>(null);
  const [discardSubmitting, setDiscardSubmitting] = useState(false);
  const [generatingBatch, setGeneratingBatch] = useState(false);

  const statusFilterRef = useRef<DraftStatusFilter>(statusFilter);
  const batchGroupFilterRef = useRef<string | null>(batchGroupFilter);
  const activeDraftIdRef = useRef<string | null | undefined>(activeDraftId);
  const onActiveDraftSyncedRef = useRef(onActiveDraftSynced);
  const pageRef = useRef<number>(0);
  const totalRef = useRef<number>(0);
  const draftsLengthRef = useRef<number>(0);
  const loadingRef = useRef<boolean>(false);
  const loadingMoreRef = useRef<boolean>(false);
  const requestSeqRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  statusFilterRef.current = statusFilter;
  batchGroupFilterRef.current = batchGroupFilter;
  activeDraftIdRef.current = activeDraftId;
  onActiveDraftSyncedRef.current = onActiveDraftSynced;
  totalRef.current = total;
  draftsLengthRef.current = drafts.length;

  const syncMatchedActiveDraft = useCallback((items: WorkbenchDraftDto[]) => {
    const targetId = activeDraftIdRef.current;
    if (!targetId || !Array.isArray(items) || items.length === 0) return;
    const matched = items.find((d) => (d.draftId || d.id) === targetId);
    if (matched) {
      onActiveDraftSyncedRef.current?.(matched);
    }
  }, []);

  const refreshDraftInbox = useCallback(
    async (overrides?: {
      status?: DraftStatusFilter;
      batchGroupId?: string | null;
      silent?: boolean;
    }) => {
      const targetStatus = overrides?.status ?? statusFilterRef.current;
      const targetGroup =
        overrides && 'batchGroupId' in overrides ? overrides.batchGroupId : batchGroupFilterRef.current;
      if (overrides?.status !== undefined) {
        statusFilterRef.current = overrides.status;
      }
      if (overrides && 'batchGroupId' in overrides) {
        batchGroupFilterRef.current = overrides.batchGroupId ?? null;
      }

      const seq = ++requestSeqRef.current;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (!overrides?.silent) {
        loadingRef.current = true;
        setLoading(true);
      }
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setError(null);

      try {
        const page = await fetchWorkbenchDrafts(
          {
            status: targetStatus,
            batchGroupId: targetGroup || undefined,
            page: 0,
            size: PAGE_SIZE
          },
          { signal: controller.signal }
        );
        if (seq !== requestSeqRef.current || controller.signal.aborted) {
          return null;
        }
        pageRef.current = page.page ?? 0;
        totalRef.current = page.total;
        draftsLengthRef.current = page.items.length;
        setDrafts(page.items);
        setTotal(page.total);
        setPendingCount(page.pendingCount);
        syncMatchedActiveDraft(page.items);
        return page;
      } catch (err: any) {
        if (seq !== requestSeqRef.current || controller.signal.aborted || err?.name === 'AbortError') {
          return null;
        }
        const msg = err?.message || '加载待确认草案列表失败';
        setError(msg);
        return null;
      } finally {
        if (seq === requestSeqRef.current) {
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [syncMatchedActiveDraft]
  );

  const loadMoreDrafts = useCallback(async () => {
    if (loadingRef.current || loadingMoreRef.current) return null;
    if (draftsLengthRef.current >= totalRef.current) return null;

    const seq = ++requestSeqRef.current;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const nextPage = pageRef.current + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchWorkbenchDrafts(
        {
          status: statusFilterRef.current,
          batchGroupId: batchGroupFilterRef.current || undefined,
          page: nextPage,
          size: PAGE_SIZE
        },
        { signal: controller.signal }
      );
      if (seq !== requestSeqRef.current || controller.signal.aborted) {
        return null;
      }
      pageRef.current = page.page ?? nextPage;
      totalRef.current = page.total;
      setTotal(page.total);
      setPendingCount(page.pendingCount);
      setDrafts((prev) => {
        const seen = new Set(prev.map((d) => d.draftId || d.id));
        const appended = page.items.filter((d) => !seen.has(d.draftId || d.id));
        const merged = [...prev, ...appended];
        draftsLengthRef.current = merged.length;
        return merged;
      });
      syncMatchedActiveDraft(page.items);
      return page;
    } catch (err: any) {
      if (seq !== requestSeqRef.current || controller.signal.aborted || err?.name === 'AbortError') {
        return null;
      }
      setError(err?.message || '加载更多草案失败');
      return null;
    } finally {
      if (seq === requestSeqRef.current) {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [syncMatchedActiveDraft]);

  useEffect(() => {
    refreshDraftInbox({ silent: true }).catch(() => {});
    return () => {
      requestSeqRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [refreshDraftInbox]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
    refreshDraftInbox().catch(() => {});
  }, [refreshDraftInbox]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const changeStatusFilter = useCallback(
    (next: DraftStatusFilter) => {
      statusFilterRef.current = next;
      setStatusFilter(next);
      refreshDraftInbox({ status: next }).catch(() => {});
    },
    [refreshDraftInbox]
  );

  const clearBatchGroupFilter = useCallback(() => {
    batchGroupFilterRef.current = null;
    setBatchGroupFilter(null);
    refreshDraftInbox({ batchGroupId: null }).catch(() => {});
  }, [refreshDraftInbox]);

  const previewDraft = useCallback(
    (draft: WorkbenchDraftDto) => {
      const targetHash = buildDraftDeeplinkHash(draft);
      if (window.location.hash === targetHash) {
        onForceReloadDeeplink?.();
      } else {
        window.location.hash = targetHash;
      }
      setDrawerOpen(false);
    },
    [onForceReloadDeeplink]
  );

  const openDiscardDialog = useCallback((draft: WorkbenchDraftDto) => {
    setDiscardTarget(draft);
  }, []);

  const closeDiscardDialog = useCallback(() => {
    if (!discardSubmitting) {
      setDiscardTarget(null);
    }
  }, [discardSubmitting]);

  const submitDiscard = useCallback(
    async (reason: string) => {
      if (!discardTarget || discardSubmitting) return;
      const targetId = discardTarget.draftId || discardTarget.id;
      setDiscardSubmitting(true);
      try {
        const updated = await discardWorkbenchDraft(targetId, {
          reason: reason.trim() || '人工工作台作废'
        });
        setDiscardTarget(null);
        toast(`已作废草案 ${targetId}（未影响任何实物库存）`);
        onDraftStateChanged?.(updated);
        await refreshDraftInbox();
      } catch (err: any) {
        toast('作废草案失败：' + (err?.message || '状态冲突或服务异常'), true);
        await refreshDraftInbox({ silent: true });
      } finally {
        setDiscardSubmitting(false);
      }
    },
    [discardTarget, discardSubmitting, onDraftStateChanged, refreshDraftInbox]
  );

  const triggerMultiMaterialDraftBatch = useCallback(
    async (payload: Record<string, any>) => {
      if (generatingBatch) return null;
      setGeneratingBatch(true);
      try {
        const resp = await generateMultiMaterialDraftBatch(payload);
        const count = Number(resp?.draftCount ?? resp?.drafts?.length ?? 0);
        const groupId = resp?.batchGroupId || '';
        toast(`已生成 ${count} 份多料联排待确认草案（批组 ${groupId}，未锁扣库存）`);
        statusFilterRef.current = 'PENDING_CONFIRMATION';
        batchGroupFilterRef.current = groupId || null;
        setStatusFilter('PENDING_CONFIRMATION');
        setBatchGroupFilter(groupId || null);
        setDrawerOpen(true);
        await refreshDraftInbox({
          status: 'PENDING_CONFIRMATION',
          batchGroupId: groupId || null
        });
        return resp;
      } catch (err: any) {
        toast('生成联排草案组失败：' + (err?.message || '请检查需求与可用材料'), true);
        return null;
      } finally {
        setGeneratingBatch(false);
      }
    },
    [generatingBatch, refreshDraftInbox]
  );

  return {
    drawerOpen,
    statusFilter,
    batchGroupFilter,
    drafts,
    total,
    pendingCount,
    loading,
    loadingMore,
    error,
    activeDraftId: activeDraftId || null,
    discardTarget,
    discardSubmitting,
    generatingBatch,
    openDrawer,
    closeDrawer,
    refreshDraftInbox,
    loadMoreDrafts,
    changeStatusFilter,
    clearBatchGroupFilter,
    previewDraft,
    openDiscardDialog,
    closeDiscardDialog,
    submitDiscard,
    triggerMultiMaterialDraftBatch
  };
}
