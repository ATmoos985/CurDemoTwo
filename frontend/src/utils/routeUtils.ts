export interface ParsedRoute {
  page: string;
  params: string[];
  groupQuery: string;
  taskIdQuery: string;
  resultIdQuery: string;
  draftIdQuery: string;
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
  planning: 'workbench',
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
  resultIdQuery: '',
  draftIdQuery: '',
  appendQuery: '',
  rawKey: 'workbench'
};

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 检查 Hash 是否命中已下线旧兼容路由，命中时返回目标现代路由 Hash（如 `#/demand-library`），
 * 未命中时返回 null。
 *
 * 兼容范围说明：
 * - `#/task/<taskId>`（`<taskId>` 非空且不等于 `new`）→ `#/demands?append=<taskId>`，保留追加目标任务需求族上下文；
 *   `#/task` 与 `#/task/new` → `#/demands`。
 * - `#/execution/<taskId>/<planId>?intent=quality`、`#/execution/<taskId>/<planId>/quality` 或任意 `#/execution?...intent=quality`
 *   → `#/reconciliation`（`ReconciliationPage` 当前不支持 URL 查询参数过滤，优先保留复检业务意图直达复检对账页）。
 * - `#/execution/<taskId>/<planId>`（非 `quality` 意图）→ `#/results?taskId=<taskId>`
 *   （旧 `planId` 与新版 `SchedulingScheme.id` 聚合模型不同，按 `taskId` 过滤方案列表）。
 */
export function resolveLegacyHashRedirect(hash: string): string | null {
  const clean = String(hash || '').replace(/^#\/?/, '');
  if (!clean) return null;
  const [rawPath = '', rawQuery = ''] = clean.split('?');
  const [pageRaw = '', ...rest] = rawPath.split('/').filter(Boolean);
  const targetPage = LEGACY_ROUTE_REDIRECTS[pageRaw];
  if (!targetPage) return null;

  if (pageRaw === 'task') {
    const taskId = rest[0] ? safeDecodeUriComponent(rest[0]) : '';
    if (taskId && taskId !== 'new') {
      return `#/${targetPage}?append=${encodeURIComponent(taskId)}`;
    }
    return `#/${targetPage}`;
  }

  if (pageRaw === 'execution') {
    const sp = new URLSearchParams(rawQuery);
    const intent = sp.get('intent');
    const thirdSegment = rest[2] ? safeDecodeUriComponent(rest[2]) : '';
    if (intent === 'quality' || thirdSegment === 'quality') {
      return '#/reconciliation';
    }
    const taskId = rest[0] ? safeDecodeUriComponent(rest[0]) : '';
    if (taskId) {
      return `#/${targetPage}?taskId=${encodeURIComponent(taskId)}`;
    }
    return `#/${targetPage}`;
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
  const resultIdQuery = sp.get('resultId') || '';
  const draftIdQuery = sp.get('draftId') || '';
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
    resultIdQuery,
    draftIdQuery,
    appendQuery,
    rawKey: clean || 'workbench',
    ...(redirectTo ? { redirectTo } : {})
  };
}
