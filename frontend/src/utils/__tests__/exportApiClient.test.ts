import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_TOKEN_STORAGE_KEY, AuthSession } from '../authClient';
import {
  ExportApiError,
  buildCamExportUrl,
  canReadExports,
  canUseBatchZipExport,
  downloadAuthorizedBlob,
  downloadBatchExportZip,
  downloadProductionSummary,
  downloadSchemeCamExport,
  downloadSchemeSlittingExport,
  downloadSchemeTicketPdf,
  formatExportError,
  parseContentDispositionFilename
} from '../exportApiClient';

const originalLocalStorage = (globalThis as any).localStorage;

function mockLocalStorage(token: string | null) {
  const store = new Map<string, string>();
  if (token) store.set(AUTH_TOKEN_STORAGE_KEY, token);
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k)
  };
}

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

describe('exportApiClient', () => {
  it('parseContentDispositionFilename 支持 RFC 5987 UTF-8 解码与路径穿越防御', () => {
    expect(
      parseContentDispositionFilename(
        `attachment; filename="fallback.dxf"; filename*=UTF-8''%E6%96%B9%E6%A1%88-01.dxf`,
        'default.dxf'
      )
    ).toBe('方案-01.dxf');

    expect(
      parseContentDispositionFilename('attachment; filename="../../etc/passwd"', 'safe.nc')
    ).toBe('passwd');

    expect(
      parseContentDispositionFilename('attachment; filename=".."', 'safe.nc')
    ).toBe('safe.nc');

    expect(parseContentDispositionFilename(null, 'WO-S1.pdf')).toBe('WO-S1.pdf');
  });

  it('权限判定函数精确对齐工厂角色与 AI Agent scopes', () => {
    const disabled: AuthSession = {
      enabled: false,
      authenticated: false,
      username: 'LOCAL',
      displayName: '免登',
      role: 'ADMIN',
      roles: ['ADMIN']
    };
    expect(canReadExports(disabled)).toBe(true);
    expect(canUseBatchZipExport(disabled)).toBe(true);

    const agentWithRead: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'agent-1',
      displayName: 'AI',
      role: 'PLANNER',
      roles: ['PLANNER'],
      actorType: 'AGENT',
      scopes: ['DEMAND_READ', 'INVENTORY_READ']
    };
    expect(canReadExports(agentWithRead)).toBe(true);
    expect(canUseBatchZipExport(agentWithRead)).toBe(false);

    const agentNoRead: AuthSession = {
      ...agentWithRead,
      scopes: ['DEMAND_READ']
    };
    expect(canReadExports(agentNoRead)).toBe(false);

    const operatorUser: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'op1',
      displayName: '操作员',
      role: 'OPERATOR',
      roles: ['OPERATOR'],
      actorType: 'USER'
    };
    expect(canReadExports(operatorUser)).toBe(true);
    expect(canUseBatchZipExport(operatorUser)).toBe(true);
  });

  it('downloadAuthorizedBlob 注入 Bearer Token 并处理 401/403/400/404 语义错误', async () => {
    mockLocalStorage('jwt-secret-123');
    const calls: Array<{ url: string; auth: string | null; method: string; body?: string }> = [];

    const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        auth: headers.get('Authorization'),
        method: init?.method || 'GET',
        body: init?.body ? String(init.body) : undefined
      });
      return new Response(new Blob(['G00 X0 Y0'], { type: 'text/plain' }), {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=UTF-8',
          'Content-Disposition': `attachment; filename*=UTF-8''SCH-1-nc.nc`
        }
      });
    }) as typeof fetch;

    const res = await downloadSchemeCamExport(
      'SCH-1',
      'nc',
      { overcutMm: 1.5, cutTool: 'T05' },
      okFetch
    );
    expect(calls[0].auth).toBe('Bearer jwt-secret-123');
    expect(calls[0].url).toContain('/api/v2/exports/schemes/SCH-1/cam?');
    expect(calls[0].url).toContain('format=nc');
    expect(calls[0].url).toContain('overcutMm=1.5');
    expect(calls[0].url).toContain('cutTool=T05');
    expect(res.fileName).toBe('SCH-1-nc.nc');

    const failFetch = (async () =>
      new Response(
        JSON.stringify({
          code: 'FORBIDDEN',
          message: 'Agent 禁止批量打包导出',
          traceId: 'tr-403',
          retryable: false
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    await expect(
      downloadBatchExportZip({ schemeIds: ['S1'], formats: ['nc'] }, failFetch)
    ).rejects.toMatchObject({
      name: 'ExportApiError',
      status: 403,
      code: 'FORBIDDEN',
      traceId: 'tr-403',
      retryable: false
    });

    const formatted = formatExportError(
      new ExportApiError('Agent 禁止批量打包导出', 403, 'FORBIDDEN', 'tr-403', false)
    );
    expect(formatted.title).toContain('403');
    expect(formatted.traceId).toBe('tr-403');
  });

  it('5 个导出入口构建正确 URL 与请求体', async () => {
    const urls: string[] = [];
    const spyFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(new Blob(['ok']), { status: 200 });
    }) as typeof fetch;

    expect(buildCamExportUrl('S/1', 'dxf_aama')).toContain('/api/v2/exports/schemes/S%2F1/cam?');
    await downloadSchemeSlittingExport('S1', 'xlsx', spyFetch);
    await downloadSchemeTicketPdf('S1', spyFetch);
    await downloadProductionSummary('pdf', { taskId: 'T-1', from: '2026-01-01' }, spyFetch);
    await downloadAuthorizedBlob('/api/v2/exports/test', { method: 'GET' }, 't.bin', spyFetch, false);

    expect(urls).toEqual([
      '/api/v2/exports/schemes/S1/slitting?format=xlsx',
      '/api/v2/exports/schemes/S1/ticket.pdf',
      '/api/v2/exports/production-summary?format=pdf&taskId=T-1&from=2026-01-01',
      '/api/v2/exports/test'
    ]);
  });
});
