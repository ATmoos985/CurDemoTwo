export interface ParsedRoute {
  page: string;
  params: string[];
  groupQuery: string;
  taskIdQuery: string;
  appendQuery: string;
  rawKey: string;
  redirectTo?: string;
}

/**
 * 已下线旧兼容路由到现代主路由的轻量自动重定向映射。
 * 不再挂载或按需加载任何旧兼容页面 chunk。
 */
export const LEGACY_ROUTE_REDIRECTS: Record<string, string> = {
  tasks: 'demand-library',
  task: 'demands',
  execution: 'results',
  quality: 'reconciliation',
  analysis: 'cost-analytics'
};

export const KNOWN_MODERN_ROUTES: readonly string[] = [
  'demands',
  'demand-library',
  'clusters',
  'workbench',
  'slitting',
  'planning',
  'results',
  'reconciliation',
  'cost-analytics',
  'inventory',
  'inspection',
  'documents',
  'garment',
  'showcase',
  'settings'
];

export const WORKBENCH_DEFAULT_ROUTE: ParsedRoute = {
  page: 'workbench',
  params: [],
  groupQuery: '',
  taskIdQuery: '',
  appendQuery: '',
  rawKey: 'workbench'
};

/**
 * 检查 Hash 是否命中已下线旧兼容路由，命中时返回目标现代路由 Hash（如 `#/demand-library`），
 * 未命中时返回 null。
 */
export function resolveLegacyHashRedirect(hash: string): string | null {
  const clean = String(hash || '').replace(/^#\/?/, '');
  if (!clean) return null;
  const [rawPath = ''] = clean.split('?');
  const [pageRaw = '', ...rest] = rawPath.split('/').filter(Boolean);
  const targetPage = LEGACY_ROUTE_REDIRECTS[pageRaw];
  if (!targetPage) return null;

  if (pageRaw === 'execution' && rest[0]) {
    const taskId = decodeURIComponent(rest[0]);
    if (taskId) {
      return `#/${targetPage}?taskId=${encodeURIComponent(taskId)}`;
    }
  }
  return `#/${targetPage}`;
}

export function parseHashRoute(hash: string): ParsedRoute {
  const redirectTo = resolveLegacyHashRedirect(hash);
  const effectiveHash = redirectTo || hash;
  const clean = String(effectiveHash || '').replace(/^#\/?/, '');
  const [rawPath = '', query = ''] = clean.split('?');
  const [pageRaw = 'workbench', ...rest] = rawPath.split('/').filter(Boolean);
  const params = rest.map(decodeURIComponent);
  const sp = new URLSearchParams(query);
  const intent = sp.get('intent');
  const groupQuery = sp.get('group') || '';
  const taskIdQuery = sp.get('taskId') || '';
  const appendQuery = sp.get('append') || '';
  const rollQuery = sp.get('roll') || '';
  if (intent && params.length < 3) {
    while (params.length < 2) params.push('');
    params.push(intent);
  }
  if (pageRaw === 'inventory' && rollQuery && params.length === 0) {
    params.push(rollQuery);
  }
  const page = KNOWN_MODERN_ROUTES.includes(pageRaw) ? pageRaw : 'workbench';
  return {
    page,
    params,
    groupQuery,
    taskIdQuery,
    appendQuery,
    rawKey: clean || 'workbench',
    ...(redirectTo ? { redirectTo } : {})
  };
}
