import { describe, expect, it, beforeEach } from 'vitest';
import { parseHashRoute } from '../routeUtils';
import {
  WORKSPACE_TABS_STORAGE_KEY,
  closeAllClosableTabs,
  closeOtherWorkspaceTabs,
  closeWorkspaceTab,
  loadInitialWorkspaceTabs,
  pruneUnauthorizedTabs,
  saveWorkspaceTabs,
  syncTabsWithRoute
} from '../workspaceTabs';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    }
  };
}

describe('workspaceTabs 多页面工作页签纯函数模型', () => {
  beforeEach(() => {
    (globalThis as any).sessionStorage = createMemoryStorage();
  });

  it('初始化始终将固定搭切工作台置于首位，并同步当前非工作台业务路由', () => {
    const route = parseHashRoute('#/demand-library');
    const tabs = loadInitialWorkspaceTabs(route, true, '#/demand-library');
    expect(tabs.map((t) => t.id)).toEqual(['workbench', 'demand-library']);
    expect(tabs[0].pinned).toBe(true);
    expect(tabs[1].pinned).toBeUndefined();
  });

  it('重复访问带不同查询参数的同一页面时原地更新 href 而不重复建页签', () => {
    let tabs = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), true, '#/workbench');
    tabs = syncTabsWithRoute(
      tabs,
      parseHashRoute('#/results?taskId=T-100'),
      '#/results?taskId=T-100',
      true
    );
    tabs = syncTabsWithRoute(
      tabs,
      parseHashRoute('#/results?taskId=T-200'),
      '#/results?taskId=T-200',
      true
    );

    expect(tabs.map((t) => t.id)).toEqual(['workbench', 'results']);
    expect(tabs[1].href).toBe('#/results?taskId=T-200');
  });

  it('slitting 归一化映射到 workbench 页签并保留其最新路由', () => {
    const initial = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), true, '#/workbench');
    const next = syncTabsWithRoute(initial, parseHashRoute('#/slitting'), '#/slitting', true);
    expect(next.map((t) => t.id)).toEqual(['workbench']);
    expect(next[0].href).toBe('#/slitting');
    expect(next[0].pinned).toBe(true);
  });

  it('profile、settings、login 不会产生多余工作页签', () => {
    let tabs = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), true, '#/workbench');
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/profile'), '#/profile', true);
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/settings/engines'), '#/settings/engines', true);
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/login'), '#/login', true);
    expect(tabs.map((t) => t.id)).toEqual(['workbench']);
  });

  it('关闭当前激活页签时自动聚焦左侧相邻页签，固定工作台不可关闭', () => {
    let tabs = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), true, '#/workbench');
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/demands'), '#/demands', true);
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/inventory'), '#/inventory', true);

    const closedPinned = closeWorkspaceTab(tabs, 'workbench', 'inventory');
    expect(closedPinned.nextTabs).toEqual(tabs);
    expect(closedPinned.nextHref).toBeNull();

    const closedActive = closeWorkspaceTab(tabs, 'inventory', 'inventory');
    expect(closedActive.nextTabs.map((t) => t.id)).toEqual(['workbench', 'demands']);
    expect(closedActive.nextHref).toBe('#/demands');

    const closedInactive = closeWorkspaceTab(tabs, 'demands', 'inventory');
    expect(closedInactive.nextTabs.map((t) => t.id)).toEqual(['workbench', 'inventory']);
    expect(closedInactive.nextHref).toBeNull();
  });

  it('非管理员模式自动剔除 users 与 audit-logs 权限页签', () => {
    const adminTabs = [
      { id: 'workbench', label: '搭切工作台', href: '#/workbench', pinned: true },
      { id: 'users', label: '用户与 Agent', href: '#/users' },
      { id: 'audit-logs', label: '操作审计', href: '#/audit-logs' },
      { id: 'inventory', label: '卷料台账', href: '#/inventory' }
    ];
    saveWorkspaceTabs(adminTabs);
    expect(sessionStorage.getItem(WORKSPACE_TABS_STORAGE_KEY)).toBeTruthy();

    const pruned = pruneUnauthorizedTabs(adminTabs, false);
    expect(pruned.map((t) => t.id)).toEqual(['workbench', 'inventory']);

    const restoredAsPlanner = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), false, '#/workbench');
    expect(restoredAsPlanner.map((t) => t.id)).toEqual(['workbench', 'inventory']);
  });

  it('支持关闭其他与关闭全部可关闭页签', () => {
    let tabs = loadInitialWorkspaceTabs(parseHashRoute('#/workbench'), true, '#/workbench');
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/demands'), '#/demands', true);
    tabs = syncTabsWithRoute(tabs, parseHashRoute('#/results'), '#/results', true);

    const others = closeOtherWorkspaceTabs(tabs, 'results');
    expect(others.map((t) => t.id)).toEqual(['workbench', 'results']);

    const onlyPinned = closeAllClosableTabs(tabs);
    expect(onlyPinned.map((t) => t.id)).toEqual(['workbench']);
  });
});
