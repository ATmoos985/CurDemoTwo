import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_TOKEN_STORAGE_KEY,
  buildAuthHeaders,
  clearAuthToken,
  fetchAuthMe,
  getAuthToken,
  idempotentJsonPost,
  installAuthFetchInterceptor,
  loginWithCredentials,
  logoutServer,
  setAuthToken,
  shouldAttachAuthToken
} from '../authClient';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear()
  };
}

describe('authClient 企业认证助手与双通道幂等提交', () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = (globalThis as any).localStorage;
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true
    });
    vi.restoreAllMocks();
  });

  it('仅对同源 /api/ 且非登录接口附加 Bearer 认证令牌，避免外域泄露', () => {
    expect(shouldAttachAuthToken('/api/rolls', 'http://localhost:8080')).toBe(true);
    expect(shouldAttachAuthToken('http://localhost:8080/api/v2/schemes?limit=20', 'http://localhost:8080')).toBe(true);
    expect(shouldAttachAuthToken('/api/v2/auth/login', 'http://localhost:8080')).toBe(false);
    expect(shouldAttachAuthToken('https://other-host.example/api/rolls', 'http://localhost:8080')).toBe(false);
    expect(shouldAttachAuthToken('/app/index.html', 'http://localhost:8080')).toBe(false);

    const h1 = buildAuthHeaders({ 'X-Test': '1' }, 'tok-abc');
    expect(h1.get('Authorization')).toBe('Bearer tok-abc');
    expect(h1.get('X-Test')).toBe('1');

    // 不覆盖调用方已显式提供的专用 Authorization（如 MES Token）
    const h2 = buildAuthHeaders({ Authorization: 'Bearer mes-special' }, 'tok-abc');
    expect(h2.get('Authorization')).toBe('Bearer mes-special');
  });

  it('全局拦截器自动附加 Bearer Token，并在业务 401 时清令牌回调 onUnauthorized', async () => {
    setAuthToken('jwt-demo-token');
    const seenAuth: (string | null)[] = [];
    const mockBaseFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get('Authorization'));
      const url = String(input);
      if (url.includes('/api/v2/restricted')) {
        return new Response(JSON.stringify({ message: '未登录' }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = mockBaseFetch as any;

    const onUnauthorized = vi.fn();
    const uninstall = installAuthFetchInterceptor({ onUnauthorized });

    try {
      await globalThis.fetch('/api/rolls');
      expect(seenAuth[0]).toBe('Bearer jwt-demo-token');
      expect(onUnauthorized).not.toHaveBeenCalled();

      await globalThis.fetch('/api/v2/restricted');
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(getAuthToken()).toBeNull();
    } finally {
      uninstall();
    }

    expect(globalThis.fetch).toBe(mockBaseFetch);
  });

  it('fetchAuthMe 在 404/未开启时静默降级为本机免登，开启时完整解析用户信息', async () => {
    const me404 = await fetchAuthMe((async () => new Response('', { status: 404 })) as any);
    expect(me404.enabled).toBe(false);
    expect(me404.role).toBe('ADMIN');

    const meEnabled = await fetchAuthMe((async () =>
      new Response(
        JSON.stringify({
          enabled: true,
          authenticated: true,
          username: 'agent:AGT-001',
          displayName: '排产助手',
          role: 'AGENT',
          roles: ['AGENT'],
          actorType: 'AGENT',
          agentId: 'AGT-001',
          scopes: ['DEMAND_READ', 'PLAN_COMPUTE'],
          expiresAt: '2026-11-28T00:00:00Z'
        }),
        { status: 200 }
      )) as any);
    expect(meEnabled.enabled).toBe(true);
    expect(meEnabled.authenticated).toBe(true);
    expect(meEnabled.displayName).toBe('排产助手');
    expect(meEnabled.role).toBe('AGENT');
    expect(meEnabled.actorType).toBe('AGENT');
    expect(meEnabled.agentId).toBe('AGT-001');
    expect(meEnabled.scopes).toEqual(['DEMAND_READ', 'PLAN_COMPUTE']);
    expect(meEnabled.expiresAt).toBe('2026-11-28T00:00:00Z');
  });

  it('logoutServer 调用 /api/v2/auth/logout 吊销服务端令牌并在异常时仍清空本地存储', async () => {
    setAuthToken('tok-to-revoke');
    const calls: { url: string; method?: string; auth?: string | null }[] = [];
    await logoutServer((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        auth: new Headers(init?.headers).get('Authorization')
      });
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    }) as any);
    expect(calls).toEqual([
      { url: '/api/v2/auth/logout', method: 'POST', auth: 'Bearer tok-to-revoke' }
    ]);
    expect(getAuthToken()).toBeNull();

    setAuthToken('tok-net-fail');
    await logoutServer((async () => {
      throw new Error('network offline');
    }) as any);
    expect(getAuthToken()).toBeNull();
  });

  it('loginWithCredentials 成功后落盘令牌，失败抛出清晰中文错误', async () => {
    clearAuthToken();
    const okRes = await loginWithCredentials(
      'admin',
      'secret',
      (async () =>
        new Response(
          JSON.stringify({
            token: 'hmac-token-123',
            username: 'admin',
            displayName: '管理员',
            role: 'ADMIN',
            expiresAt: '2026-11-26T00:00:00Z'
          }),
          { status: 200 }
        )) as any
    );
    expect(okRes.token).toBe('hmac-token-123');
    expect(storage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('hmac-token-123');

    await expect(
      loginWithCredentials(
        'admin',
        'wrong',
        (async () => new Response(JSON.stringify({ message: '密码错误' }), { status: 401 })) as any
      )
    ).rejects.toThrow('密码错误');
  });

  it('idempotentJsonPost 同步将幂等键写入请求体与 Header，网络故障重试复用同一 idempotencyKey', async () => {
    const capturedBodies: any[] = [];
    const capturedHeaders: (string | null)[] = [];
    let attempt = 0;

    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempt += 1;
      const body = JSON.parse(String(init?.body || '{}'));
      capturedBodies.push(body);
      capturedHeaders.push(new Headers(init?.headers).get('Idempotency-Key'));
      if (attempt === 1) {
        throw new Error('simulated network drop');
      }
      return new Response(JSON.stringify({ revision: 9, ok: true }), { status: 200 });
    }) as any;

    await expect(
      idempotentJsonPost('test-receipt', '/api/v2/inventory-receipts', {
        supplierName: '华联纺织',
        operator: '王工'
      })
    ).rejects.toThrow();

    const res = await idempotentJsonPost('test-receipt', '/api/v2/inventory-receipts', {
      supplierName: '华联纺织',
      operator: '王工'
    });
    expect(res).toEqual({ revision: 9, ok: true });
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].idempotencyKey).toBeTruthy();
    expect(capturedBodies[1].idempotencyKey).toBe(capturedBodies[0].idempotencyKey);
    expect(capturedHeaders[0]).toBeTruthy();
    expect(capturedHeaders[1]).toBe(capturedHeaders[0]);
  });
});
