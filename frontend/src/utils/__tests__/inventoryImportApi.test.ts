import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_TOKEN_STORAGE_KEY, AuthSession } from '../authClient';
import {
  InventoryImportError,
  buildBatchErrorCsvText,
  buildBatchTemplateCsvText,
  canImportDefects,
  canImportRollsOrRemnants,
  commitRollsImport,
  isAlignedTo01Mm,
  parseBatchMatrix,
  previewDefectsImport
} from '../inventoryImportApi';

const originalLocalStorage = (globalThis as any).localStorage;

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as any).localStorage;
  } else {
    (globalThis as any).localStorage = originalLocalStorage;
  }
});

describe('inventoryImportApi', () => {
  it('RBAC 权限判定严格区分 WAREHOUSE / INSPECTOR / ADMIN 与 Agent', () => {
    const wh: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'wh1',
      displayName: '仓管',
      role: 'WAREHOUSE',
      roles: ['WAREHOUSE'],
      actorType: 'USER'
    };
    const insp: AuthSession = { ...wh, username: 'qc1', role: 'INSPECTOR', roles: ['INSPECTOR'] };
    const admin: AuthSession = { ...wh, username: 'adm', role: 'ADMIN', roles: ['ADMIN'] };
    const agent: AuthSession = { ...admin, actorType: 'AGENT' };

    expect(canImportRollsOrRemnants(wh)).toBe(true);
    expect(canImportDefects(wh)).toBe(false);
    expect(canImportRollsOrRemnants(insp)).toBe(false);
    expect(canImportDefects(insp)).toBe(true);
    expect(canImportRollsOrRemnants(admin)).toBe(true);
    expect(canImportDefects(admin)).toBe(true);
    expect(canImportRollsOrRemnants(agent)).toBe(false);
    expect(canImportDefects(agent)).toBe(false);
  });

  it('postInventoryImport 在 commit 时双写 Idempotency-Key 与 Bearer Token，并保留完整 0-based errors[] 与 409', async () => {
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k === AUTH_TOKEN_STORAGE_KEY ? 'tok-wh-99' : null),
      setItem: () => {},
      removeItem: () => {}
    };

    let capturedHeaders: Headers | null = null;
    let capturedBody: any = null;

    const fail400Fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          code: 'BATCH_IMPORT_VALIDATION_FAILED',
          message: '第 1 行母卷长度不守恒',
          traceId: 'tr-400',
          retryable: false,
          errors: [
            { rowIndex: 0, field: 'totalLength', code: 'LENGTH_MISMATCH', message: '总长不等于已用+剩余+报废' }
          ]
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    await expect(
      commitRollsImport(
        {
          operator: 'wh1',
          rows: [{ rollId: 'R1', rollModel: 'M1', width: 2000, totalLength: 50000 }]
        },
        'IMP-KEY-001',
        fail400Fetch
      )
    ).rejects.toMatchObject({
      name: 'InventoryImportError',
      status: 400,
      code: 'BATCH_IMPORT_VALIDATION_FAILED',
      traceId: 'tr-400',
      errors: [{ rowIndex: 0, field: 'totalLength', code: 'LENGTH_MISMATCH', message: '总长不等于已用+剩余+报废' }]
    });

    expect(capturedHeaders!.get('Authorization')).toBe('Bearer tok-wh-99');
    expect(capturedHeaders!.get('Idempotency-Key')).toBe('IMP-KEY-001');
    expect(capturedBody.idempotencyKey).toBe('IMP-KEY-001');

    const fail409Fetch = (async () =>
      new Response(
        JSON.stringify({ code: 'INVENTORY_CONFLICT', message: 'Idempotency-Key 载荷冲突', traceId: 'tr-409' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    await expect(
      commitRollsImport({ rows: [] }, 'IMP-KEY-001', fail409Fetch)
    ).rejects.toBeInstanceOf(InventoryImportError);

    const previewOkFetch = (async () =>
      new Response(
        JSON.stringify({
          importType: 'DEFECTS',
          dryRun: true,
          valid: true,
          idempotentReplay: false,
          revision: 1,
          totalRows: 1,
          validRows: 1,
          errorRows: 0,
          importedCount: 0,
          skippedCount: 0,
          errors: [],
          createdIds: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    const previewRes = await previewDefectsImport(
      { rows: [{ rollId: 'R-1', x: 10.5, y: 20.1, w: 30, h: 40, margin: 5 }] },
      previewOkFetch
    );
    expect(previewRes.dryRun).toBe(true);
    expect(previewRes.valid).toBe(true);
  });

  it('parseBatchMatrix 支持 (m)/(cm) 自动换算 mm、0.1 mm 精度预检、模板与错误 CSV 公式注入防护', () => {
    const parsedRolls = parseBatchMatrix<any>(
      [
        ['母卷号', '材料型号', '有效幅宽(cm)', '整卷总长(m)', '已用长度(mm)', '剩余长度(m)'],
        ['R-X1', 'M-1', 200, 50, 0, 50]
      ],
      'rolls'
    );
    expect(parsedRolls.rows[0]).toMatchObject({
      rollId: 'R-X1',
      rollModel: 'M-1',
      width: 2000,
      totalLength: 50000,
      usedLength: 0,
      currentRemainingLength: 50000
    });
    expect(parsedRolls.sourceRowNumbers).toEqual([2]);
    expect(parsedRolls.localWarnings.some((w) => w.includes('非 mm 单位列'))).toBe(true);

    expect(isAlignedTo01Mm(12.3)).toBe(true);
    expect(isAlignedTo01Mm(12.34)).toBe(false);

    const parsedDefects = parseBatchMatrix<any>(
      [
        ['母卷号', 'x(mm)', 'y(mm)', '宽度(mm)', '高度(mm)'],
        ['R-1', 10.25, 20.0, 30, 40]
      ],
      'defects'
    );
    expect(parsedDefects.localWarnings.some((w) => w.includes('0.1 mm'))).toBe(true);

    const rollTplCsv = buildBatchTemplateCsvText('rolls');
    expect(rollTplCsv).toContain('有效幅宽(mm)');
    expect(rollTplCsv).toContain('整卷总长(mm)');

    const errCsv = buildBatchErrorCsvText(
      [{ rowIndex: 0, field: 'totalLength', code: 'BAD', message: '=SUM(A1:A2)' }],
      [5]
    );
    expect(errCsv).toContain('"0","5","totalLength","BAD","\'=SUM(A1:A2)"');
  });
});
