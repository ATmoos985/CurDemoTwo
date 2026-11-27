import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthToken, setAuthToken } from '../authClient';
import {
  SecurityApiError,
  buildAuditLogsUrl,
  canAccessAdminSecurity,
  changeOwnPassword,
  issueAgent,
  queryAuditLogs,
  revokeAgent
} from '../securityApi';

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

describe('securityApi 安全接口客户端与管理员权限守卫', () => {
  const originalLocalStorage = (globalThis as any).localStorage;
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    });
    setAuthToken('admin-jwt-123');
  });

  afterEach(() => {
    clearAuthToken();
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true
    });
    vi.restoreAllMocks();
  });

  it('canAccessAdminSecurity 正确放行免登与 ADMIN，拦截非管理员与未登录会话', () => {
    expect(
      canAccessAdminSecurity({
        enabled: false,
        authenticated: false,
        username: 'LOCAL',
        displayName: '本机免登',
        role: 'ADMIN',
        roles: ['ADMIN']
      })
    ).toBe(true);

    expect(
      canAccessAdminSecurity({
        enabled: true,
        authenticated: true,
        username: 'admin',
        displayName: '系统管理员',
        role: 'ADMIN',
        roles: ['ADMIN']
      })
    ).toBe(true);

    expect(
      canAccessAdminSecurity({
        enabled: true,
        authenticated: true,
        username: 'planner',
        displayName: '排程员',
        role: 'PLANNER',
        roles: ['PLANNER']
      })
    ).toBe(false);

    expect(
      canAccessAdminSecurity({
        enabled: true,
        authenticated: false,
        username: '',
        displayName: '未登录',
        role: '',
        roles: []
      })
    ).toBe(false);
  });

  it('buildAuditLogsUrl 过滤空白筛选条件并正确编码分页与时间戳', () => {
    const url = buildAuditLogsUrl({
      actor: ' planner ',
      actorType: 'AGENT',
      targetType: 'DRAFT',
      targetId: 'DRAFT-001',
      outcome: 'DENIED',
      from: 1700000000000,
      to: 1700003600000,
      page: 2,
      size: 50
    });
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/v2/audit-logs');
    expect(parsed.searchParams.get('actor')).toBe('planner');
    expect(parsed.searchParams.get('actorType')).toBe('AGENT');
    expect(parsed.searchParams.get('targetType')).toBe('DRAFT');
    expect(parsed.searchParams.get('targetId')).toBe('DRAFT-001');
    expect(parsed.searchParams.get('outcome')).toBe('DENIED');
    expect(parsed.searchParams.get('from')).toBe('1700000000000');
    expect(parsed.searchParams.get('to')).toBe('1700003600000');
    expect(parsed.searchParams.get('page')).toBe('2');
    expect(parsed.searchParams.get('size')).toBe('50');
    expect(parsed.searchParams.has('action')).toBe(false);
  });

  it('issueAgent 精准发送 name/scopes/description/ttlHours 并返回明文一次性令牌', async () => {
    let sentBody: any = null;
    let sentAuth: string | null = null;
    const result = await issueAgent(
      {
        name: 'AI排产协作',
        scopes: ['DEMAND_READ', 'PLAN_COMPUTE'],
        description: '仅读取需求与试排',
        ttlHours: 240
      },
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body || '{}'));
        sentAuth = new Headers(init?.headers).get('Authorization');
        return new Response(
          JSON.stringify({
            agent: {
              agentId: 'AGT-ABC123',
              name: 'AI排产协作',
              ownerUsername: 'admin',
              scopes: ['DEMAND_READ', 'PLAN_COMPUTE'],
              enabled: true,
              tokenVersion: 1,
              description: '仅读取需求与试排',
              createdAt: 1000,
              updatedAt: 1000,
              expiresAt: 999999,
              revokedAt: null,
              lastUsedAt: null
            },
            token: 'agent-secret-once'
          }),
          { status: 201 }
        );
      }) as any
    );

    expect(sentAuth).toBe('Bearer admin-jwt-123');
    expect(sentBody).toEqual({
      name: 'AI排产协作',
      scopes: ['DEMAND_READ', 'PLAN_COMPUTE'],
      description: '仅读取需求与试排',
      ttlHours: 240
    });
    expect(result.token).toBe('agent-secret-once');
    expect(result.agent.agentId).toBe('AGT-ABC123');
  });

  it('服务端返回 403/400 时抛出携带状态码与 traceId 的 SecurityApiError', async () => {
    await expect(
      queryAuditLogs({}, (async () =>
        new Response(
          JSON.stringify({
            code: 'FORBIDDEN',
            message: '角色 OPERATOR 无权执行该操作',
            traceId: 'trace-403-xyz'
          }),
          { status: 403 }
        )) as any)
    ).rejects.toMatchObject({
      name: 'SecurityApiError',
      status: 403,
      code: 'FORBIDDEN',
      traceId: 'trace-403-xyz'
    });

    await expect(
      changeOwnPassword('old', 'new12345', (async () =>
        new Response(JSON.stringify({ updated: true }), { status: 200 })) as any)
    ).resolves.toEqual({ updated: true });

    await expect(
      revokeAgent('AGT-1', '已停用', (async () =>
        new Response(JSON.stringify({ agentId: 'AGT-1', enabled: false, revokedAt: 2000 }), {
          status: 200
        })) as any)
    ).resolves.toMatchObject({ agentId: 'AGT-1', enabled: false });
  });
});
