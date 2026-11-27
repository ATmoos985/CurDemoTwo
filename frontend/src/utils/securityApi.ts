import { AuthSession, buildAuthHeaders, getAuthToken } from './authClient';

export interface UserAccountView {
  username: string;
  displayName: string;
  role: string;
  enabled: boolean;
  tokenVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  passwordUpdatedAt: number | null;
}

export interface AgentCredentialView {
  agentId: string;
  name: string;
  ownerUsername: string;
  scopes: string[];
  enabled: boolean;
  tokenVersion: number;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface IssueAgentResult {
  agent: AgentCredentialView;
  token: string;
}

export interface AuditRecord {
  id: string;
  occurredAt: number;
  actor: string;
  actorType: string;
  actorRole: string | null;
  agentId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  httpMethod: string | null;
  requestPath: string | null;
  outcome: string;
  httpStatus: number | null;
  traceId: string | null;
  clientIp: string | null;
  detailJson: string | null;
}

export interface AuditPage {
  items: AuditRecord[];
  total: number;
  page: number;
  size: number;
}

export interface AuditQueryParams {
  actor?: string;
  actorType?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  outcome?: string;
  from?: number;
  to?: number;
  page?: number;
  size?: number;
}

export const ROLE_OPTIONS: ReadonlyArray<{ value: string; label: string; summary: string }> = [
  { value: 'ADMIN', label: '系统管理员 (ADMIN)', summary: '全站业务、账户、AI Agent 与审计管理' },
  { value: 'PLANNER', label: '排产计划员 (PLANNER)', summary: '需求池、模板、工作台试排、方案确认与冲销' },
  { value: 'OPERATOR', label: '裁床操作员 (OPERATOR)', summary: '执行单开工、车间报工与完工提交' },
  { value: 'INSPECTOR', label: '质检员 (INSPECTOR)', summary: '验布打标、来料放行与成品复检处置' },
  { value: 'WAREHOUSE', label: '仓储管理员 (WAREHOUSE)', summary: '采购入库、领退料、移库、盘点与废料核销' }
];

export const AGENT_SCOPE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: 'DEMAND_READ', label: '读取需求 (DEMAND_READ)', description: '查询需求池、纸样模板与裁切任务摘要' },
  { value: 'DEMAND_WRITE', label: '创建需求 (DEMAND_WRITE)', description: '向需求池写入待排裁切任务（不可删改他人已确认单据）' },
  { value: 'INVENTORY_READ', label: '读取库存 (INVENTORY_READ)', description: '查询母卷/料头台账、对账、成本与执行单状态' },
  { value: 'PLAN_COMPUTE', label: '试排算力 (PLAN_COMPUTE)', description: '发起纯计算试排、校验布局与多料联排分析（零库存扣减）' },
  { value: 'DRAFT_WRITE', label: '草案协同 (DRAFT_WRITE)', description: '生成、列表与作废待确认草案（严禁确认落库与扣料）' }
];

export class SecurityApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, code?: string, traceId?: string) {
    super(message);
    this.name = 'SecurityApiError';
    this.status = status;
    this.code = code;
    this.traceId = traceId;
  }
}

export function canAccessAdminSecurity(auth: AuthSession): boolean {
  if (!auth.enabled) return true;
  return auth.authenticated && String(auth.role || '').toUpperCase() === 'ADMIN';
}

type FetchFn = typeof fetch;

async function requestSecurityJson<T>(
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchFn = globalThis.fetch
): Promise<T> {
  const token = getAuthToken();
  const headers = buildAuthHeaders(init.headers, token);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetchImpl(url, {
    ...init,
    cache: 'no-store',
    headers
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const fallback =
      res.status === 403
        ? '当前账号无权访问该安全管理资源（403）'
        : res.status === 401
        ? '身份认证已失效，请重新登录（401）'
        : `请求失败（HTTP ${res.status}）`;
    throw new SecurityApiError(
      String(payload?.message || fallback),
      res.status,
      payload?.code ? String(payload.code) : undefined,
      payload?.traceId ? String(payload.traceId) : undefined
    );
  }
  return payload as T;
}

export async function changeOwnPassword(
  currentPassword: string,
  newPassword: string,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<{ updated: boolean }> {
  return requestSecurityJson<{ updated: boolean }>(
    '/api/v2/auth/password',
    {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword })
    },
    fetchImpl
  );
}

export async function listUsers(fetchImpl: FetchFn = globalThis.fetch): Promise<UserAccountView[]> {
  const data = await requestSecurityJson<{ items?: UserAccountView[] }>('/api/v2/users', {}, fetchImpl);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function createUser(
  input: { username: string; displayName: string; role: string; password: string },
  fetchImpl: FetchFn = globalThis.fetch
): Promise<UserAccountView> {
  return requestSecurityJson<UserAccountView>(
    '/api/v2/users',
    {
      method: 'POST',
      body: JSON.stringify(input)
    },
    fetchImpl
  );
}

export async function updateUser(
  username: string,
  input: { displayName: string; role: string },
  fetchImpl: FetchFn = globalThis.fetch
): Promise<UserAccountView> {
  return requestSecurityJson<UserAccountView>(
    `/api/v2/users/${encodeURIComponent(username)}`,
    {
      method: 'PUT',
      body: JSON.stringify(input)
    },
    fetchImpl
  );
}

export async function updateUserStatus(
  username: string,
  enabled: boolean,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<UserAccountView> {
  return requestSecurityJson<UserAccountView>(
    `/api/v2/users/${encodeURIComponent(username)}/status`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled })
    },
    fetchImpl
  );
}

export async function resetUserPassword(
  username: string,
  newPassword: string,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<{ updated: boolean; tokenVersion: number }> {
  return requestSecurityJson<{ updated: boolean; tokenVersion: number }>(
    `/api/v2/users/${encodeURIComponent(username)}/reset-password`,
    {
      method: 'POST',
      body: JSON.stringify({ newPassword })
    },
    fetchImpl
  );
}

export async function listAgents(fetchImpl: FetchFn = globalThis.fetch): Promise<AgentCredentialView[]> {
  const data = await requestSecurityJson<{ items?: AgentCredentialView[] }>('/api/v2/agents', {}, fetchImpl);
  return Array.isArray(data?.items) ? data.items : [];
}

export async function issueAgent(
  input: { name: string; scopes: string[]; description?: string; ttlHours?: number },
  fetchImpl: FetchFn = globalThis.fetch
): Promise<IssueAgentResult> {
  return requestSecurityJson<IssueAgentResult>(
    '/api/v2/agents',
    {
      method: 'POST',
      body: JSON.stringify(input)
    },
    fetchImpl
  );
}

export async function revokeAgent(
  agentId: string,
  reason?: string,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<AgentCredentialView> {
  return requestSecurityJson<AgentCredentialView>(
    `/api/v2/agents/${encodeURIComponent(agentId)}/revoke`,
    {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {})
    },
    fetchImpl
  );
}

export function buildAuditLogsUrl(params: AuditQueryParams = {}): string {
  const sp = new URLSearchParams();
  if (params.actor?.trim()) sp.set('actor', params.actor.trim());
  if (params.actorType?.trim()) sp.set('actorType', params.actorType.trim());
  if (params.action?.trim()) sp.set('action', params.action.trim());
  if (params.targetType?.trim()) sp.set('targetType', params.targetType.trim());
  if (params.targetId?.trim()) sp.set('targetId', params.targetId.trim());
  if (params.outcome?.trim()) sp.set('outcome', params.outcome.trim());
  if (typeof params.from === 'number' && Number.isFinite(params.from)) {
    sp.set('from', String(Math.trunc(params.from)));
  }
  if (typeof params.to === 'number' && Number.isFinite(params.to)) {
    sp.set('to', String(Math.trunc(params.to)));
  }
  sp.set('page', String(Math.max(0, params.page ?? 0)));
  sp.set('size', String(Math.max(1, params.size ?? 20)));
  return `/api/v2/audit-logs?${sp.toString()}`;
}

export async function queryAuditLogs(
  params: AuditQueryParams = {},
  fetchImpl: FetchFn = globalThis.fetch
): Promise<AuditPage> {
  return requestSecurityJson<AuditPage>(buildAuditLogsUrl(params), {}, fetchImpl);
}
