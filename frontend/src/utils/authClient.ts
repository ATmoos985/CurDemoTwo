import { createUuid, idempotentPost, pendingWrite } from '@static/app/js/util.js';

export const AUTH_TOKEN_STORAGE_KEY = 'cutplan.auth.token';

export interface AuthSession {
  enabled: boolean;
  authenticated: boolean;
  username: string;
  displayName: string;
  role: string;
  roles: string[];
  expiresAt?: string;
}

export interface LoginResult {
  token: string;
  username: string;
  displayName: string;
  role: string;
  expiresAt?: string;
}

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: '系统管理员',
  PLANNER: '排产计划员',
  OPERATOR: '裁床操作员',
  INSPECTOR: '质检员',
  WAREHOUSE: '仓储管理员'
};

export const LOCAL_FALLBACK_SESSION: AuthSession = {
  enabled: false,
  authenticated: false,
  username: 'LOCAL',
  displayName: '本机免登',
  role: 'ADMIN',
  roles: ['ADMIN']
};

export function roleDisplayName(role?: string): string {
  if (!role) return '操作员';
  return ROLE_LABELS[String(role).toUpperCase()] || role;
}

export function getAuthToken(): string | null {
  try {
    const val = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

export function setAuthToken(token: string): void {
  try {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // 忽略隐私模式或存储配额异常
  }
}

export function clearAuthToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // 忽略异常
  }
}

/** 提取请求目标路径，判断是否为应附带企业认证令牌的同源 /api/ 请求 */
export function resolveRequestPath(input: RequestInfo | URL, baseOrigin?: string): string | null {
  try {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : input.url;
    if (!rawUrl) return null;
    if (rawUrl.startsWith('/')) {
      return rawUrl.split('?')[0];
    }
    const origin = baseOrigin ?? (typeof location !== 'undefined' ? location.origin : 'http://localhost');
    const parsed = new URL(rawUrl, origin);
    if (parsed.origin !== origin) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

export function shouldAttachAuthToken(input: RequestInfo | URL, baseOrigin?: string): boolean {
  const path = resolveRequestPath(input, baseOrigin);
  if (!path || !path.startsWith('/api/')) return false;
  if (path === '/api/v2/auth/login') return false;
  return true;
}

export function buildAuthHeaders(
  headers: HeadersInit | undefined,
  token: string | null
): Headers {
  const next = new Headers(headers || undefined);
  if (token && !next.has('Authorization')) {
    next.set('Authorization', `Bearer ${token}`);
  }
  return next;
}

type FetchFn = typeof fetch;

let installedOriginalFetch: FetchFn | null = null;
let unauthorizedListeners = new Set<() => void>();

/**
 * 非侵入式安装全局 fetch 认证拦截器：
 * - 自动为同源 `/api/` 请求附带 `Authorization: Bearer <token>`（支持既有 static/util.js 中的 requestJSON 与 idempotentPost）
 * - 遇到业务接口 401 时清理失效令牌并通知 UI 弹出登录框
 * - 返回卸载函数，便于单元测试清理
 */
export function installAuthFetchInterceptor(options?: {
  onUnauthorized?: () => void;
  getToken?: () => string | null;
  clearToken?: () => void;
}): () => void {
  const onUnauthorized = options?.onUnauthorized;
  if (onUnauthorized) {
    unauthorizedListeners.add(onUnauthorized);
  }

  const readToken = options?.getToken ?? getAuthToken;
  const resetToken = options?.clearToken ?? clearAuthToken;

  if (!installedOriginalFetch && typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    const rawFetch = originalFetch.bind(globalThis);
    installedOriginalFetch = originalFetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const attach = shouldAttachAuthToken(input);
      const token = attach ? readToken() : null;

      let nextInput = input;
      let nextInit = init;
      if (token) {
        const merged = buildAuthHeaders(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
          token
        );
        if (input instanceof Request && !init) {
          nextInput = new Request(input, { headers: merged });
        } else {
          nextInit = { ...(init || {}), headers: merged };
        }
      }

      const res = await rawFetch(nextInput, nextInit);
      if (res.status === 401) {
        const path = resolveRequestPath(input);
        if (path && path.startsWith('/api/') && path !== '/api/v2/auth/login' && path !== '/api/v2/auth/me') {
          resetToken();
          unauthorizedListeners.forEach((fn) => {
            try {
              fn();
            } catch {
              // 忽略单个监听异常
            }
          });
        }
      }
      return res;
    }) as FetchFn;
  }

  return () => {
    if (onUnauthorized) {
      unauthorizedListeners.delete(onUnauthorized);
    }
    if (unauthorizedListeners.size === 0 && installedOriginalFetch) {
      globalThis.fetch = installedOriginalFetch;
      installedOriginalFetch = null;
    }
  };
}

/** 查询当前认证配置与登录态；当后端未开启或尚无此接口(404)时平滑降级为本机免登 */
export async function fetchAuthMe(fetchImpl: FetchFn = globalThis.fetch): Promise<AuthSession> {
  try {
    const token = getAuthToken();
    const headers = buildAuthHeaders(undefined, token);
    const res = await fetchImpl('/api/v2/auth/me', {
      cache: 'no-store',
      headers
    });
    if (res.status === 404 || res.status === 405) {
      return { ...LOCAL_FALLBACK_SESSION };
    }
    if (!res.ok) {
      return { ...LOCAL_FALLBACK_SESSION };
    }
    const data = await res.json();
    const enabled = Boolean(data?.enabled);
    const role = String(data?.role || 'ADMIN');
    const roles = Array.isArray(data?.roles) && data.roles.length ? data.roles.map(String) : [role];
    return {
      enabled,
      authenticated: Boolean(data?.authenticated),
      username: String(data?.username || (enabled ? '' : 'LOCAL')),
      displayName: String(data?.displayName || data?.username || (enabled ? '未登录' : '本机免登')),
      role,
      roles,
      expiresAt: data?.expiresAt ? String(data.expiresAt) : undefined
    };
  } catch {
    return { ...LOCAL_FALLBACK_SESSION };
  }
}

/** 校验用户名密码换取 Bearer Token 并持久化 */
export async function loginWithCredentials(
  username: string,
  password: string,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<LoginResult> {
  const trimmedUser = username.trim();
  if (!trimmedUser || !password) {
    throw new Error('请输入操作员账号与登录密码');
  }
  const res = await fetchImpl('/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: trimmedUser, password })
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new Error(payload?.message || (res.status === 401 ? '账号或密码错误，请核对后重试' : '登录失败，请稍后重试'));
  }
  const token = String(payload?.token || '').trim();
  if (!token) {
    throw new Error('登录响应缺少有效访问令牌');
  }
  setAuthToken(token);
  return {
    token,
    username: String(payload.username || trimmedUser),
    displayName: String(payload.displayName || payload.username || trimmedUser),
    role: String(payload.role || 'OPERATOR'),
    expiresAt: payload.expiresAt ? String(payload.expiresAt) : undefined
  };
}

export function logoutAuth(): void {
  clearAuthToken();
}

/**
 * 同步在请求体 `idempotencyKey` 与 HTTP Header `Idempotency-Key` 写入同一幂等键的受控提交助手：
 * - 首次提交生成 UUID，并委托 `idempotentPost` 落盘防重；
 * - 若上次同槽位提交结果未确认且载荷语义一致，复用原 `idempotencyKey` 重发，避免产生双重单据。
 */
export async function idempotentJsonPost<T = any>(
  slot: string,
  url: string,
  body: Record<string, any>
): Promise<T> {
  const existing = pendingWrite(slot);
  let reuseKey: string | null = null;
  if (existing?.body && typeof existing.body === 'object') {
    const { idempotencyKey: prevKey, ...prevRest } = existing.body;
    const { idempotencyKey: _ignore, ...nextRest } = body;
    if (prevKey && JSON.stringify(prevRest) === JSON.stringify(nextRest)) {
      reuseKey = String(prevKey);
    }
  }
  const finalKey = String(body.idempotencyKey || reuseKey || createUuid());
  return idempotentPost(slot, url, {
    ...body,
    idempotencyKey: finalKey
  }) as Promise<T>;
}
