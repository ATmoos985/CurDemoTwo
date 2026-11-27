import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EffectEntry = {
  deps: unknown[] | undefined;
  create: () => void | (() => void);
  cleanup?: (() => void) | void;
};

const hookCtx = {
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  callbacks: [] as { fn: unknown; deps: unknown[] | undefined }[],
  effects: [] as EffectEntry[],
  stateCursor: 0,
  refCursor: 0,
  cbCursor: 0,
  effectCursor: 0,
  renderFn: null as null | (() => unknown),
  latestResult: undefined as unknown,
  pendingEffects: [] as number[],
  renderScheduled: false,
  mounted: false
};

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

function runRender() {
  if (!hookCtx.renderFn) return;
  hookCtx.stateCursor = 0;
  hookCtx.refCursor = 0;
  hookCtx.cbCursor = 0;
  hookCtx.effectCursor = 0;
  hookCtx.pendingEffects = [];
  hookCtx.latestResult = hookCtx.renderFn();
  for (const idx of hookCtx.pendingEffects) {
    const eff = hookCtx.effects[idx];
    if (typeof eff.cleanup === 'function') {
      eff.cleanup();
    }
    eff.cleanup = eff.create();
  }
}

function scheduleRerender() {
  if (!hookCtx.mounted || hookCtx.renderScheduled) return;
  hookCtx.renderScheduled = true;
  queueMicrotask(() => {
    hookCtx.renderScheduled = false;
    if (hookCtx.mounted) {
      runRender();
    }
  });
}

vi.mock('react', () => ({
  useState: <T,>(initial: T | (() => T)) => {
    const idx = hookCtx.stateCursor++;
    if (!(idx in hookCtx.states)) {
      hookCtx.states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    const setState = (updater: T | ((prev: T) => T)) => {
      const prev = hookCtx.states[idx] as T;
      const next = typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;
      if (!Object.is(prev, next)) {
        hookCtx.states[idx] = next;
        scheduleRerender();
      }
    };
    return [hookCtx.states[idx] as T, setState] as const;
  },
  useRef: <T,>(initial: T) => {
    const idx = hookCtx.refCursor++;
    if (!(idx in hookCtx.refs)) {
      hookCtx.refs[idx] = { current: initial };
    }
    return hookCtx.refs[idx] as { current: T };
  },
  useCallback: <T extends Function>(fn: T, deps?: unknown[]) => {
    const idx = hookCtx.cbCursor++;
    const prev = hookCtx.callbacks[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      hookCtx.callbacks[idx] = { fn, deps };
    }
    return hookCtx.callbacks[idx].fn as T;
  },
  useEffect: (create: () => void | (() => void), deps?: unknown[]) => {
    const idx = hookCtx.effectCursor++;
    const prev = hookCtx.effects[idx];
    if (!prev || depsChanged(prev.deps, deps)) {
      hookCtx.effects[idx] = {
        deps,
        create,
        cleanup: prev?.cleanup
      };
      hookCtx.pendingEffects.push(idx);
    }
  }
}));

vi.mock('../../../lib/core/util.js', () => ({
  toast: vi.fn()
}));

import { evaluateActiveDraftBlockedReason, type WorkbenchDraftDto } from '../draftInboxApi';
import { useDraftInbox, type UseDraftInboxOptions } from '../useDraftInbox';

function makeDraft(id: string, status = 'PENDING_CONFIRMATION'): WorkbenchDraftDto {
  return {
    id,
    draftId: id,
    status,
    issuedAt: '2026-11-27T02:00:00Z',
    expiresAt: '2099-11-27T02:30:00Z',
    stale: false,
    staleReasons: [],
    target: { resultId: `RES-${id}`, taskId: 'TASK-01', materialId: 'ROLL-01', materialType: 'STOCK_ROLL' },
    riskChecks: []
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function mountUseDraftInbox(options: UseDraftInboxOptions = {}) {
  hookCtx.states = [];
  hookCtx.refs = [];
  hookCtx.callbacks = [];
  hookCtx.effects = [];
  hookCtx.mounted = true;
  hookCtx.renderFn = () => useDraftInbox(options);
  runRender();
  return () => hookCtx.latestResult as ReturnType<typeof useDraftInbox>;
}

describe('useDraftInbox 单发请求、乱序抛弃与动态过期阻断', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const eff of hookCtx.effects) {
      if (typeof eff.cleanup === 'function') {
        eff.cleanup();
      }
    }
    hookCtx.mounted = false;
    hookCtx.renderFn = null;
    vi.unstubAllGlobals();
  });

  it('切换状态过滤与清除批组过滤严格单发请求，绝不与 useEffect 双发重复请求', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requestedUrls.push(url);
        return new Response(
          JSON.stringify({
            items: [makeDraft('DFT-1')],
            total: 1,
            page: 0,
            size: 40,
            pendingCount: 1
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const getHook = mountUseDraftInbox();
    await flushMicrotasks();
    expect(requestedUrls).toEqual([
      '/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=40'
    ]);

    getHook().changeStatusFilter('ALL');
    await flushMicrotasks();
    expect(requestedUrls).toEqual([
      '/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=40',
      '/api/v2/workbench/drafts?status=ALL&page=0&size=40'
    ]);

    getHook().changeStatusFilter('DISCARDED');
    await flushMicrotasks();
    expect(requestedUrls).toEqual([
      '/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=40',
      '/api/v2/workbench/drafts?status=ALL&page=0&size=40',
      '/api/v2/workbench/drafts?status=DISCARDED&page=0&size=40'
    ]);

    getHook().clearBatchGroupFilter();
    await flushMicrotasks();
    expect(requestedUrls).toHaveLength(4);
  });

  it('慢响应乱序返回时通过 requestSeqRef 与 AbortController 彻底丢弃旧响应，不污染新筛选状态', async () => {
    interface Deferred {
      url: string;
      signal?: AbortSignal;
      resolve: (resp: Response) => void;
      reject: (err: unknown) => void;
    }
    const pending: Deferred[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          pending.push({ url, signal: init?.signal ?? undefined, resolve, reject });
        });
      })
    );

    const getHook = mountUseDraftInbox();
    // 初始请求完成
    expect(pending).toHaveLength(1);
    pending[0].resolve(
      new Response(JSON.stringify({ items: [], total: 0, page: 0, size: 40, pendingCount: 0 }), {
        status: 200
      })
    );
    await flushMicrotasks();

    // 连续切换：第 1 个 ALL 请求慢响应，第 2 个 DISCARDED 请求先返回
    getHook().changeStatusFilter('ALL');
    expect(pending).toHaveLength(2);
    const slowAll = pending[1];
    expect(slowAll.signal?.aborted).toBe(false);

    getHook().changeStatusFilter('DISCARDED');
    expect(pending).toHaveLength(3);
    const fastDiscarded = pending[2];
    // 发起新请求后旧请求的 AbortSignal 已被触发取消
    expect(slowAll.signal?.aborted).toBe(true);
    expect(fastDiscarded.signal?.aborted).toBe(false);

    // 快响应先返回
    fastDiscarded.resolve(
      new Response(
        JSON.stringify({
          items: [makeDraft('DFT-DSC-1', 'DISCARDED')],
          total: 1,
          page: 0,
          size: 40,
          pendingCount: 0
        }),
        { status: 200 }
      )
    );
    await flushMicrotasks();
    expect(getHook().statusFilter).toBe('DISCARDED');
    expect(getHook().drafts.map((d) => d.draftId)).toEqual(['DFT-DSC-1']);
    expect(getHook().total).toBe(1);

    // 即使慢响应随后强行 resolve 带旧数据，也必须被抛弃
    slowAll.resolve(
      new Response(
        JSON.stringify({
          items: [makeDraft('DFT-ALL-1'), makeDraft('DFT-ALL-2')],
          total: 2,
          page: 0,
          size: 40,
          pendingCount: 2
        }),
        { status: 200 }
      )
    );
    await flushMicrotasks();
    expect(getHook().statusFilter).toBe('DISCARDED');
    expect(getHook().drafts.map((d) => d.draftId)).toEqual(['DFT-DSC-1']);
    expect(getHook().total).toBe(1);
    expect(getHook().error).toBeNull();
  });

  it('刷新收件箱命中当前活动草案时回调 onActiveDraftSynced，且支持增量 loadMoreDrafts', async () => {
    const onActiveDraftSynced = vi.fn();
    let callIdx = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callIdx++;
        if (callIdx === 1) {
          return new Response(
            JSON.stringify({
              items: [makeDraft('DFT-ACTIVE-9', 'DISCARDED'), makeDraft('DFT-2')],
              total: 3,
              page: 0,
              size: 40,
              pendingCount: 1
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            items: [makeDraft('DFT-2'), makeDraft('DFT-3')],
            total: 3,
            page: 1,
            size: 40,
            pendingCount: 1
          }),
          { status: 200 }
        );
      })
    );

    const getHook = mountUseDraftInbox({
      activeDraftId: 'DFT-ACTIVE-9',
      onActiveDraftSynced
    });
    await flushMicrotasks();

    expect(onActiveDraftSynced).toHaveBeenCalledTimes(1);
    expect(onActiveDraftSynced.mock.calls[0][0].status).toBe('DISCARDED');

    await getHook().loadMoreDrafts();
    await flushMicrotasks();
    expect(getHook().drafts.map((d) => d.draftId)).toEqual(['DFT-ACTIVE-9', 'DFT-2', 'DFT-3']);
  });

  it('evaluateActiveDraftBlockedReason 动态校验 expiresAt 即使静态 expired=false 也实时阻断', () => {
    const exp = '2026-11-27T10:00:00Z';
    expect(
      evaluateActiveDraftBlockedReason({
        draftId: 'DFT-1',
        banner: { draftId: 'DFT-1', status: 'PENDING_CONFIRMATION', expired: false, expiresAt: exp },
        nowMs: Date.parse('2026-11-27T09:59:59Z')
      })
    ).toBeNull();

    expect(
      evaluateActiveDraftBlockedReason({
        draftId: 'DFT-1',
        banner: { draftId: 'DFT-1', status: 'PENDING_CONFIRMATION', expired: false, expiresAt: exp },
        nowMs: Date.parse('2026-11-27T10:00:01Z')
      })
    ).toContain('已过期');

    expect(
      evaluateActiveDraftBlockedReason({
        draftId: 'DFT-1',
        banner: { draftId: 'DFT-1', status: 'DISCARDED', expired: false, expiresAt: exp },
        nowMs: Date.parse('2026-11-27T09:00:00Z')
      })
    ).toContain('已作废');

    expect(
      evaluateActiveDraftBlockedReason({
        draftId: 'DFT-1',
        confirmedSchemeId: 'SCH-100',
        banner: { draftId: 'DFT-1', status: 'DISCARDED', expired: true, expiresAt: exp },
        nowMs: Date.parse('2026-11-27T12:00:00Z')
      })
    ).toBeNull();
  });

  it('非静默刷新被静默刷新打断并完成后 loading 必须复位为 false，且 loadMoreDrafts 正常工作', async () => {
    interface Deferred {
      url: string;
      signal?: AbortSignal;
      resolve: (resp: Response) => void;
    }
    const pending: Deferred[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        return new Promise<Response>((resolve) => {
          pending.push({ url, signal: init?.signal ?? undefined, resolve });
        });
      })
    );

    const getHook = mountUseDraftInbox();
    // 完成初始挂载时的静默请求
    expect(pending).toHaveLength(1);
    pending[0].resolve(
      new Response(
        JSON.stringify({
          items: [makeDraft('DFT-1'), makeDraft('DFT-2')],
          total: 3,
          page: 0,
          size: 40,
          pendingCount: 2
        }),
        { status: 200 }
      )
    );
    await flushMicrotasks();
    expect(getHook().loading).toBe(false);

    // 1. 打开抽屉触发非静默刷新 -> loading=true
    getHook().openDrawer();
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    expect(getHook().loading).toBe(true);

    // 2. 在非静默请求未决时，静默刷新接管（例如确认回调）并成功返回
    const silentPromise = getHook().refreshDraftInbox({ silent: true });
    expect(pending).toHaveLength(3);
    expect(pending[1].signal?.aborted).toBe(true);

    pending[2].resolve(
      new Response(
        JSON.stringify({
          items: [makeDraft('DFT-1'), makeDraft('DFT-2')],
          total: 3,
          page: 0,
          size: 40,
          pendingCount: 2
        }),
        { status: 200 }
      )
    );
    await silentPromise;
    await flushMicrotasks();

    // 断言 loading 必须安全复位为 false，绝不卡死
    expect(getHook().loading).toBe(false);

    // 3. 紧接着调用 loadMoreDrafts() 必须正常发起第 2 页请求（不返回 null）
    const loadMorePromise = getHook().loadMoreDrafts();
    expect(pending).toHaveLength(4);
    expect(pending[3].url).toContain('page=1');

    pending[3].resolve(
      new Response(
        JSON.stringify({
          items: [makeDraft('DFT-2'), makeDraft('DFT-3')],
          total: 3,
          page: 1,
          size: 40,
          pendingCount: 2
        }),
        { status: 200 }
      )
    );
    const page2 = await loadMorePromise;
    await flushMicrotasks();

    expect(page2).not.toBeNull();
    expect(getHook().loadingMore).toBe(false);
    expect(getHook().drafts.map((d) => d.draftId)).toEqual(['DFT-1', 'DFT-2', 'DFT-3']);
  });
});
