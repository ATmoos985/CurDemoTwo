import type { ParsedRoute } from './routeUtils';

export interface WorkspaceTabItem {
  id: string;
  label: string;
  href: string;
  pinned?: boolean;
}

export interface WorkspaceTabMeta {
  id: string;
  label: string;
  defaultHref: string;
  pinned?: boolean;
  adminOnly?: boolean;
}

export const WORKSPACE_TABS_STORAGE_KEY = 'cutplan.workspace.tabs.v1';

export const TAB_PAGE_META: Record<string, WorkspaceTabMeta> = {
  workbench: {
    id: 'workbench',
    label: '搭切工作台',
    defaultHref: '#/workbench',
    pinned: true
  },
  demands: {
    id: 'demands',
    label: '新建订单',
    defaultHref: '#/demands'
  },
  'demand-library': {
    id: 'demand-library',
    label: '待排订单',
    defaultHref: '#/demand-library'
  },
  clusters: {
    id: 'clusters',
    label: '纸样模板',
    defaultHref: '#/clusters'
  },
  results: {
    id: 'results',
    label: '方案与工单',
    defaultHref: '#/results'
  },
  reconciliation: {
    id: 'reconciliation',
    label: '复检与对账',
    defaultHref: '#/reconciliation'
  },
  'cost-analytics': {
    id: 'cost-analytics',
    label: '成本与备料',
    defaultHref: '#/cost-analytics'
  },
  inventory: {
    id: 'inventory',
    label: '卷料台账',
    defaultHref: '#/inventory'
  },
  inspection: {
    id: 'inspection',
    label: '验布打标',
    defaultHref: '#/inspection'
  },
  documents: {
    id: 'documents',
    label: '出入库单',
    defaultHref: '#/documents'
  },
  garment: {
    id: 'garment',
    label: '服装唛架',
    defaultHref: '#/garment'
  },
  showcase: {
    id: 'showcase',
    label: '示例沙盒',
    defaultHref: '#/showcase'
  },
  users: {
    id: 'users',
    label: '用户与 Agent',
    defaultHref: '#/users',
    adminOnly: true
  },
  'audit-logs': {
    id: 'audit-logs',
    label: '操作审计',
    defaultHref: '#/audit-logs',
    adminOnly: true
  }
};

const NON_TAB_PAGES = new Set(['login', 'settings', 'profile']);

export function normalizeTabPageId(page: string): string {
  if (page === 'slitting') return 'workbench';
  return page;
}

function getDefaultPinnedTab(): WorkspaceTabItem {
  const meta = TAB_PAGE_META.workbench;
  return {
    id: meta.id,
    label: meta.label,
    href: meta.defaultHref,
    pinned: true
  };
}

function normalizeHref(rawHash: string | undefined, fallbackHref: string): string {
  const trimmed = String(rawHash || '').trim();
  if (!trimmed) return fallbackHref;
  if (trimmed.startsWith('#/')) return trimmed;
  if (trimmed.startsWith('/')) return `#${trimmed}`;
  return `#/${trimmed.replace(/^#?/, '')}`;
}

export function pruneUnauthorizedTabs(
  tabs: WorkspaceTabItem[],
  isAdminVisible: boolean
): WorkspaceTabItem[] {
  const filtered = tabs.filter((tab) => {
    const meta = TAB_PAGE_META[tab.id];
    if (!meta) return false;
    if (meta.adminOnly && !isAdminVisible) return false;
    return true;
  });
  return ensurePinnedWorkbenchFirst(filtered);
}

function ensurePinnedWorkbenchFirst(tabs: WorkspaceTabItem[]): WorkspaceTabItem[] {
  const seen = new Set<string>();
  let workbenchTab: WorkspaceTabItem | null = null;
  const others: WorkspaceTabItem[] = [];

  for (const item of tabs) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue;
    const meta = TAB_PAGE_META[item.id];
    if (!meta) continue;
    seen.add(item.id);
    if (item.id === 'workbench') {
      workbenchTab = {
        id: 'workbench',
        label: meta.label,
        href: item.href || meta.defaultHref,
        pinned: true
      };
    } else {
      others.push({
        id: item.id,
        label: meta.label,
        href: item.href || meta.defaultHref
      });
    }
  }

  return [workbenchTab || getDefaultPinnedTab(), ...others];
}

export function syncTabsWithRoute(
  tabs: WorkspaceTabItem[],
  route: ParsedRoute,
  rawHash: string,
  isAdminVisible: boolean
): WorkspaceTabItem[] {
  const base = pruneUnauthorizedTabs(tabs, isAdminVisible);
  if (NON_TAB_PAGES.has(route.page)) {
    return base;
  }
  const tabId = normalizeTabPageId(route.page);
  const meta = TAB_PAGE_META[tabId];
  if (!meta) return base;
  if (meta.adminOnly && !isAdminVisible) return base;

  const nextHref = normalizeHref(rawHash, meta.defaultHref);
  const existingIdx = base.findIndex((t) => t.id === tabId);
  if (existingIdx >= 0) {
    const existing = base[existingIdx];
    if (existing.href === nextHref && existing.label === meta.label) {
      return base;
    }
    const next = [...base];
    next[existingIdx] = {
      ...existing,
      label: meta.label,
      href: nextHref,
      ...(meta.pinned ? { pinned: true } : {})
    };
    return next;
  }

  return [
    ...base,
    {
      id: meta.id,
      label: meta.label,
      href: nextHref,
      ...(meta.pinned ? { pinned: true } : {})
    }
  ];
}

export function closeWorkspaceTab(
  tabs: WorkspaceTabItem[],
  targetId: string,
  activePageId: string
): { nextTabs: WorkspaceTabItem[]; nextHref: string | null } {
  const idx = tabs.findIndex((t) => t.id === targetId);
  if (idx < 0) return { nextTabs: tabs, nextHref: null };
  const target = tabs[idx];
  if (target.pinned || TAB_PAGE_META[target.id]?.pinned) {
    return { nextTabs: tabs, nextHref: null };
  }

  const nextTabs = tabs.filter((t) => t.id !== targetId);
  const normalizedActive = normalizeTabPageId(activePageId);
  if (normalizedActive !== targetId) {
    return { nextTabs, nextHref: null };
  }

  const fallback = nextTabs[Math.max(0, idx - 1)] || nextTabs[0] || getDefaultPinnedTab();
  return {
    nextTabs,
    nextHref: fallback.href
  };
}

export function closeOtherWorkspaceTabs(
  tabs: WorkspaceTabItem[],
  keepId: string
): WorkspaceTabItem[] {
  const normalizedKeep = normalizeTabPageId(keepId);
  const kept = tabs.filter((t) => t.pinned || t.id === 'workbench' || t.id === normalizedKeep);
  return ensurePinnedWorkbenchFirst(kept);
}

export function closeAllClosableTabs(tabs: WorkspaceTabItem[]): WorkspaceTabItem[] {
  const pinnedOnly = tabs.filter((t) => t.pinned || t.id === 'workbench');
  return ensurePinnedWorkbenchFirst(pinnedOnly);
}

export function loadInitialWorkspaceTabs(
  initialRoute: ParsedRoute,
  isAdminVisible: boolean,
  rawHash?: string
): WorkspaceTabItem[] {
  let restored: WorkspaceTabItem[] = [getDefaultPinnedTab()];
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          restored = parsed.filter(
            (it): it is WorkspaceTabItem =>
              Boolean(it) && typeof it.id === 'string' && typeof it.href === 'string'
          );
        }
      }
    }
  } catch {
    restored = [getDefaultPinnedTab()];
  }

  const sanitized = pruneUnauthorizedTabs(restored, isAdminVisible);
  const hashToSync =
    rawHash ??
    (initialRoute.rawKey ? `#/${initialRoute.rawKey}` : `#/${initialRoute.page}`);
  return syncTabsWithRoute(sanitized, initialRoute, hashToSync, isAdminVisible);
}

export function saveWorkspaceTabs(tabs: WorkspaceTabItem[]): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(tabs));
    }
  } catch {
    // 忽略隐私模式或存储配额异常
  }
}
