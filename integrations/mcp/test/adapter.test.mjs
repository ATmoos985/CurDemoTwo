import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, openapi, LEDGER_AGGREGATE_TYPES } from '../src/server.mjs';
import { configuration, apiClient, audited, createAuditLogger } from '../src/api.mjs';
import { createMcpHttpServer, startMcpHttpServer } from '../src/http-server.mjs';
import { fileURLToPath } from 'node:url';

export const problem = {
  schemaVersion: '2.0',
  problemType: 'NESTING_2D',
  clientRequestId: 'MCP-test',
  allowFallback: false,
  requireComplete: true,
  problem: {
    schemaVersion: '1',
    unit: 'mm',
    material: {
      id: 'external-material',
      shape: { type: 'RECTANGLE', width: 2000, height: 3000, vertices: [] },
      exclusions: [],
      continuesAfterRegion: false
    },
    parts: [
      {
        id: 1,
        name: '<untrusted order note>',
        shape: { type: 'RECTANGLE', width: 2000, height: 1000, vertices: [] },
        quantity: 3,
        allowRotation: false
      }
    ],
    process: {
      mode: 'CROSSCUT',
      feedMode: 'SHEET',
      startCorner: 'left-top',
      firstStageOrientation: 'horizontal',
      trimStart: 0,
      minReusableWidth: 200,
      minReusableHeight: 300,
      kerf: 0,
      objective: 'INPUT_ORDER',
      pieceGap: 0
    },
    engine: 'auto',
    timeLimitSeconds: 3
  }
};

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  schemaVersion: '2.0',
  clientRequestId: 'MCP-test',
  inputHash: 'hash',
  state: 'SUCCEEDED',
  phase: 'STOPPED',
  createdAt: '2026-10-21T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  timeLimitSeconds: 3,
  resultRef: 'job-1',
  code: null,
  message: null
};

const multiMaterialFixture = {
  materialModel: 'TC-2026',
  totalRequestedPieces: 12,
  placedByRemnants: 4,
  placedByRoll: 8,
  unplacedPieces: 0,
  remnantAllocations: [
    {
      remnantId: 'REM-001',
      widthMm: 1600,
      lengthMm: 1800,
      utilizationPct: 84.5,
      placedCount: 4,
      piecesAreaM2: 2.43,
      allocatedItems: [{ name: '前片', count: 4 }]
    }
  ],
  rollOptions: [
    {
      rollId: 'ROLL-101',
      widthMm: 1800,
      availableLengthMm: 45000,
      estimatedCutLengthMm: 3200,
      utilizationPct: 89.2,
      placedCount: 8,
      feasible: true,
      recommended: true
    }
  ],
  totalSavedAreaM2: 2.88,
  elapsedMs: 42,
  warnings: []
};

const costSummaryFixture = {
  currency: 'CNY',
  defaultUnitPricePerSqm: 25,
  remnantResidualFactor: 0.7,
  summary: {
    totalReports: 3,
    totalConsumedAreaM2: 120,
    netGoodAreaM2: 92,
    recoveredRemnantAreaM2: 10,
    wasteAreaM2: 18,
    totalMaterialCost: 3000,
    recoveredResidualValue: 175,
    netEffectiveCost: 2825,
    wasteCost: 480,
    avgCostPerGoodSqm: 30.71
  },
  byTask: [{ taskId: 'TASK-01', taskName: '卫衣大货', netEffectiveCost: 2825 }],
  byMaterialModel: [{ materialModel: 'TC-2026', netEffectiveCost: 2825 }]
};

const procurementFixture = {
  safetyBufferPct: 15,
  defaultRollLengthM: 50,
  totalModels: 2,
  shortageModels: 1,
  items: [
    {
      materialModel: 'TC-2026',
      demandAreaM2: 180,
      requiredWithBufferAreaM2: 207,
      availableRollAreaM2: 110,
      availableRemnantAreaM2: 12,
      netAvailableAreaM2: 122,
      shortageAreaM2: 85,
      recommendedWidthMm: 1800,
      recommendedLengthM: 50,
      recommendedRolls: 1,
      alertLevel: 'HIGH',
      pendingTaskCount: 2,
      activeBatches: ['BAT-01']
    }
  ]
};

async function connected(config = {}, api = async () => ({}), audit = () => {}) {
  const server = createServer(
    {
      origin: 'http://127.0.0.1:8080',
      compute: false,
      businessRead: false,
      allowDraftScheme: false,
      apiToken: '',
      transport: 'stdio',
      httpHost: '127.0.0.1',
      httpPort: 3080,
      httpToken: '',
      auditLogPath: '',
      ...config
    },
    { api, audit }
  );
  const client = new Client({ name: 'verification-client', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

test('configuration permits only literal loopback origins, explicit grants, and enforces HTTP token', () => {
  assert.equal(configuration({}).compute, false);
  assert.equal(configuration({}).allowDraftScheme, false);
  assert.equal(configuration({ CUTTING_MCP_COMPUTE: 'true' }).compute, true);
  assert.equal(configuration({ CUTTING_MCP_ALLOW_DRAFT_SCHEME: 'true' }).allowDraftScheme, true);
  for (const url of [
    'https://example.com',
    'http://localhost:8080',
    'http://127.0.0.1:8080/path',
    'http://a:b@127.0.0.1',
    'file:///tmp/file',
    'http://127.0.0.1?x=1'
  ]) {
    assert.throws(() => configuration({ CUTTING_API_URL: url }));
  }
  assert.throws(() => configuration({ CUTTING_MCP_COMPUTE: 'yes' }));
  assert.throws(() => configuration({ CUTTING_MCP_ALLOW_DRAFT_SCHEME: '1' }));
  assert.throws(() => configuration({ MCP_TRANSPORT: 'grpc' }));
  assert.throws(() => configuration({ MCP_TRANSPORT: 'http' }), /MCP_API_TOKEN/);
  assert.throws(() => configuration({ MCP_TRANSPORT: 'http', MCP_API_TOKEN: 'short-token' }), /MCP_API_TOKEN/);
  const httpCfg = configuration({
    MCP_TRANSPORT: 'http',
    MCP_API_TOKEN: 'mcp-enterprise-secret-token-2026',
    CUTTING_API_TOKEN: 'backend-bearer-token-2026'
  });
  assert.equal(httpCfg.transport, 'http');
  assert.equal(httpCfg.apiToken, 'backend-bearer-token-2026');
});

test('OpenAPI 阶段四全部新增路径与 $ref 引用均完整有效', () => {
  const expectedPaths = [
    '/api/v2/optimization-jobs/{jobId}/events',
    '/api/v2/planning/multi-material',
    '/api/v2/planning/cut-plan',
    '/api/v2/analytics/cost-summary',
    '/api/v2/analytics/procurement-suggestions'
  ];
  for (const p of expectedPaths) {
    assert.ok(openapi.paths[p], `OpenAPI 缺少路径 ${p}`);
  }
  const refs = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') refs.push(node.$ref);
      Object.values(node).forEach(walk);
    }
  };
  walk(openapi);
  for (const r of refs) {
    assert.ok(r.startsWith('#/components/schemas/'), `不支持的引用格式 ${r}`);
    const schemaName = r.split('/').at(-1);
    assert.ok(openapi.components.schemas[schemaName], `OpenAPI 缺少 Schema 定义 ${schemaName}`);
  }
});

test('tool discovery reflects grants (6 / 13 / 14 tools) and annotations; no stock write tools', async () => {
  const baseSession = await connected({ compute: false, businessRead: false, allowDraftScheme: false });
  try {
    const { tools } = await baseSession.client.listTools();
    assert.equal(tools.length, 6);
    assert.equal(tools.some((t) => t.name === 'submit_optimization_job'), false);
    assert.equal(tools.some((t) => t.name === 'save_draft_scheme'), false);
  } finally {
    await baseSession.close();
  }

  const fullSession = await connected({ compute: true, businessRead: true, allowDraftScheme: true });
  try {
    const { tools } = await fullSession.client.listTools();
    assert.equal(tools.length, 14);
    const names = new Set(tools.map((t) => t.name));
    for (const expected of [
      'get_cutting_capabilities',
      'validate_cutting_problem',
      'get_optimization_job',
      'get_optimization_input',
      'get_optimization_result',
      'compare_cutting_results',
      'submit_optimization_job',
      'cancel_optimization_job',
      'get_cutting_task',
      'get_inventory_ledger',
      'find_material_candidates',
      'get_material_trace',
      'analyze_production_insights',
      'save_draft_scheme'
    ]) {
      assert.ok(names.has(expected), `缺少工具 ${expected}`);
    }
    assert.equal(tools.find((t) => t.name === 'submit_optimization_job').annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'cancel_optimization_job').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'find_material_candidates').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'get_material_trace').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'analyze_production_insights').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'save_draft_scheme').annotations.destructiveHint, false);
    // 禁止出现任何直接写库存/过账报工/移库工具
    assert.ok(
      tools.every(
        (t) =>
          !t.name.includes('confirm_') &&
          !t.name.includes('submit_production') &&
          !t.name.includes('transfer') &&
          !t.name.includes('scrap')
      )
    );
  } finally {
    await fullSession.close();
  }
});

test('get_inventory_ledger 接受全部补齐后的 aggregateType 枚举值', async () => {
  const seenUrls = [];
  const session = await connected({ businessRead: true }, async (path) => {
    seenUrls.push(path);
    return { revision: 1, items: [], nextCursor: 0, hasMore: false };
  });
  try {
    for (const agg of ['COUNT', 'QUALITY_RELEASE', 'RECEIPT_IN', 'MATERIAL_ISSUE', 'ROLL_SCRAP']) {
      assert.ok(LEDGER_AGGREGATE_TYPES.includes(agg));
      const res = await session.client.callTool({
        name: 'get_inventory_ledger',
        arguments: { aggregateType: agg, limit: 10 }
      });
      assert.ok(!res.isError, `aggregateType=${agg} 应被接受：${JSON.stringify(res)}`);
    }
    assert.equal(seenUrls.length, 5);
    assert.ok(seenUrls[0].includes('aggregateType=COUNT'));
    assert.ok(seenUrls[4].includes('aggregateType=ROLL_SCRAP'));
  } finally {
    await session.close();
  }
});

test('新增 4 个企业级工具执行语义准确且 save_draft_scheme 绝不写库存', async () => {
  const calls = [];
  const session = await connected(
    { compute: true, businessRead: true, allowDraftScheme: true },
    async (path, body) => {
      calls.push({ path, method: body === undefined ? 'GET' : 'POST', body });
      if (path === '/api/v2/planning/multi-material') return multiMaterialFixture;
      if (path === '/api/rolls/ROLL-101/spatial-map') {
        return {
          rollId: 'ROLL-101',
          cutZones: [{ planId: 'P-1', startY: 0, lengthMm: 2200 }],
          plannedZones: [],
          cleanSpans: [{ startY: 2200, endY: 50000 }],
          defects: [{ id: 1, x: 100, y: 500 }]
        };
      }
      if (path === '/api/remnants') {
        return [
          { id: 'REM-A', sourceRollId: 'ROLL-101', width: 1600, length: 900, area: 1.44, status: 'AVAILABLE' },
          { id: 'REM-OTHER', sourceRollId: 'ROLL-999', width: 1000, length: 500, area: 0.5, status: 'AVAILABLE' }
        ];
      }
      if (path.startsWith('/api/v2/inventory-ledger?')) {
        return { revision: 3, items: [{ id: 'L-1', sequence: 1, aggregateType: 'ROLL', aggregateId: 'ROLL-101' }], nextCursor: 1, hasMore: false };
      }
      if (path === '/api/v2/inventory-ledger/reconciliation') {
        return { status: 'BALANCED', revision: 3, issues: [], areas: [] };
      }
      if (path.startsWith('/api/v2/analytics/cost-summary?')) return costSummaryFixture;
      if (path.startsWith('/api/v2/analytics/procurement-suggestions?')) return procurementFixture;
      if (path === '/api/v2/demand-pool') return [{ id: 'T-1', openTotal: 20 }];
      if (path === '/api/v2/optimization-results/res-100') {
        return {
          id: 'res-100',
          jobId: 'job-100',
          inputHash: 'abc123',
          schemaVersion: '2.0',
          validationStatus: 'PASSED',
          fulfillmentStatus: 'COMPLETE',
          meetsRequirement: true,
          terminationReason: 'COMPLETED',
          metrics: []
        };
      }
      if (path === '/api/cutting/tasks/TASK-01') {
        return { id: 'TASK-01', status: 'IN_PROGRESS', remainingPieces: 15 };
      }
      return {};
    }
  );

  try {
    // 1. find_material_candidates
    const cand = await session.client.callTool({
      name: 'find_material_candidates',
      arguments: { materialModel: 'TC-2026', preferRemnants: true, maxRemnants: 3 }
    });
    assert.ok(!cand.isError, JSON.stringify(cand));
    assert.equal(cand.structuredContent.data.placedByRemnants, 4);
    assert.equal(cand.structuredContent.data.rollOptions[0].recommended, true);

    // 2. get_material_trace + 路径注入拦截
    const badTrace = await session.client.callTool({
      name: 'get_material_trace',
      arguments: { rollId: '../admin' }
    });
    assert.equal(badTrace.isError, true);

    const trace = await session.client.callTool({
      name: 'get_material_trace',
      arguments: { rollId: 'ROLL-101' }
    });
    assert.ok(!trace.isError, JSON.stringify(trace));
    assert.equal(trace.structuredContent.data.summary.cutZoneCount, 1);
    assert.equal(trace.structuredContent.data.summary.derivedRemnantCount, 1);
    assert.equal(trace.structuredContent.data.derivedRemnants[0].id, 'REM-A');

    // 3. analyze_production_insights
    const insights = await session.client.callTool({
      name: 'analyze_production_insights',
      arguments: { defaultUnitPricePerSqm: 28, safetyBufferPct: 20 }
    });
    assert.ok(!insights.isError, JSON.stringify(insights));
    assert.equal(insights.structuredContent.data.procurement.shortageModels, 1);
    assert.equal(insights.structuredContent.data.pendingDemandSummary.totalOpenPieces, 20);
    assert.ok(insights.structuredContent.data.insights.some((i) => i.category === 'PROCUREMENT'));

    // 4. save_draft_scheme（严禁接受 approved:true 且不发起任何后端 POST 写操作）
    const spoofed = await session.client.callTool({
      name: 'save_draft_scheme',
      arguments: { resultId: 'res-100', approved: true }
    });
    assert.equal(spoofed.isError, true);

    const beforeDraftCallCount = calls.length;
    const draft = await session.client.callTool({
      name: 'save_draft_scheme',
      arguments: { resultId: 'res-100', taskId: 'TASK-01', materialId: 'ROLL-101', note: '请班长核验色号' }
    });
    assert.ok(!draft.isError, JSON.stringify(draft));
    const d = draft.structuredContent.data;
    assert.equal(d.status, 'PENDING_HUMAN_APPROVAL');
    assert.equal(d.requiresHumanConfirmation, true);
    assert.equal(d.inventoryMutated, false);
    assert.match(d.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(d.approvalToken.startsWith('draft_v1.'));
    assert.ok(d.riskChecks.length >= 4);
    const draftCalls = calls.slice(beforeDraftCallCount);
    assert.ok(draftCalls.every((c) => c.method === 'GET'), 'save_draft_scheme 绝不允许向后端发起任何 POST 写入');
  } finally {
    await session.close();
  }
});

test('canonical schemas reject unknown fields and mismatched problem before HTTP', async () => {
  const sent = [];
  const session = await connected({ compute: true }, async (...args) => {
    sent.push(args);
    return job;
  });
  try {
    for (const args of [
      { idempotencyKey: 'test-key', request: { ...problem, tenantId: 'admin' } },
      { idempotencyKey: 'test-key', request: { ...problem, problemType: 'SLITTING_1D' } },
      { idempotencyKey: 'test-key', request: problem, approved: true }
    ]) {
      const result = await session.client.callTool({ name: 'submit_optimization_job', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(sent.length, 0);
    const valid = await session.client.callTool({
      name: 'submit_optimization_job',
      arguments: { idempotencyKey: 'test-key', request: problem }
    });
    assert.ok(!valid.isError, JSON.stringify(valid));
    assert.deepEqual(sent[0], ['/api/v2/optimization-jobs', problem, 'test-key']);
    assert.deepEqual(valid.structuredContent.data, job);
  } finally {
    await session.close();
  }
});

test('path injection and overlarge ledger pages are rejected before HTTP', async () => {
  const sent = [];
  const session = await connected({ businessRead: true }, async (...args) => {
    sent.push(args);
    return {};
  });
  try {
    for (const [name, args] of [
      ['get_optimization_job', { jobId: '../rolls' }],
      ['get_inventory_ledger', { limit: 101 }],
      ['get_inventory_ledger', { after: -1 }]
    ]) {
      const result = await session.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(sent.length, 0);
  } finally {
    await session.close();
  }
});

test('API client bounds requests and responses, attaches Bearer token, and preserves conflict', async () => {
  const seenAuth = [];
  const server = httpServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    if (req.url === '/huge') return res.end('x'.repeat(1000));
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.com' });
      return res.end();
    }
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'IDEMPOTENCY_CONFLICT', message: 'Different input', retryable: false }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const api = apiClient(
      { origin: 'http://127.0.0.1:' + server.address().port, apiToken: 'rest-secret-token' },
      { maxResponseBytes: 200 }
    );
    await assert.rejects(api('/conflict', {}), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
    assert.equal(seenAuth[0], 'Bearer rest-secret-token');
    await assert.rejects(api('/huge'), (e) => e.code === 'RESPONSE_TOO_LARGE');
    await assert.rejects(api('/redirect'), (e) => e.code === 'SERVICE_UNAVAILABLE');
    await assert.rejects(api('/too-big', { value: 'x'.repeat(262144) }), (e) => e.code === 'PAYLOAD_TOO_LARGE');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('audit logs summaries only and persists sanitized JSONL without leaking sensitive payloads', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mcp-audit-'));
  const auditFile = join(tempDir, 'audit.jsonl');
  const stderrLines = [];
  try {
    const logger = createAuditLogger({
      auditLogPath: auditFile,
      transport: 'streamable-http',
      stderrWrite: (line) => stderrLines.push(line)
    });
    const call = audited(
      'validate_cutting_problem',
      async () => {
        throw Error('secret-internal-path');
      },
      logger
    );
    const response = await call({ secret: 'private-order-polygon-vertices-999' });
    assert.equal(response.isError, true);
    assert.ok(!JSON.stringify(response).includes('secret-internal-path'));

    const persisted = readFileSync(auditFile, 'utf8').trim();
    assert.ok(persisted.length > 0);
    assert.ok(!persisted.includes('private-order-polygon-vertices-999'));
    assert.ok(!persisted.includes('secret-internal-path'));
    const entry = JSON.parse(persisted);
    assert.equal(entry.traceId, JSON.parse(response.content[0].text).traceId);
    assert.equal(entry.tool, 'validate_cutting_problem');
    assert.equal(entry.status, 'FAILED');
    assert.equal(entry.transport, 'streamable-http');
    assert.match(entry.inputHash, /^[a-f0-9]{64}$/);
    assert.equal(stderrLines.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Streamable HTTP 强制鉴权（无 token 拒绝启动 / 401 拦截 / 200 发现全部 14 工具并透传后端凭据与脱敏审计）', async () => {
  // 未配置 MCP_API_TOKEN 直接拒绝启动
  assert.throws(
    () => createMcpHttpServer({ origin: 'http://127.0.0.1:8080', httpToken: '' }),
    /MCP_API_TOKEN/
  );

  const tempDir = mkdtempSync(join(tmpdir(), 'mcp-http-audit-'));
  const auditFile = join(tempDir, 'http-audit.jsonl');
  const backendAuthHeaders = [];
  const backend = httpServer((req, res) => {
    backendAuthHeaders.push(req.headers.authorization || '');
    if (req.url === '/api/v2/planning/multi-material' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(multiMaterialFixture));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));

  const mcpToken = 'mcp-http-bearer-secret-token-2026';
  const backendToken = 'cutting-rest-bearer-token-2026';
  const httpMcp = await startMcpHttpServer(
    {
      origin: `http://127.0.0.1:${backend.address().port}`,
      compute: true,
      businessRead: true,
      allowDraftScheme: true,
      apiToken: backendToken,
      transport: 'http',
      httpHost: '127.0.0.1',
      httpPort: 0,
      httpToken: mcpToken,
      auditLogPath: auditFile
    },
    { audit: createAuditLogger({ auditLogPath: auditFile, transport: 'streamable-http', stderrWrite: () => {} }) }
  );

  try {
    // 1. 无 Authorization 返回 401
    const unauth = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauth.status, 401);

    // 2. 错误 Bearer Token 返回 401
    const wrongAuth = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token-value-123456' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    assert.equal(wrongAuth.status, 401);

    // 3. 正确 Bearer Token 返回 200 并列出全部 14 个工具
    const listed = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.result.tools.length, 14);
    assert.ok(listed.headers.get('mcp-session-id'));

    // 4. 调用业务工具，验证 CUTTING_API_TOKEN 透传给后端且脱敏审计落盘不泄露明文与 token
    const called = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mcpToken}`,
        'Mcp-Session-Id': listed.headers.get('mcp-session-id')
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'find_material_candidates',
          arguments: {
            materialModel: 'TC-2026',
            demands: [{ name: 'SENSITIVE-CUSTOMER-PATTERN-XYZ', width: 500, length: 600, quantity: 2 }]
          }
        }
      })
    });
    assert.equal(called.status, 200);
    const callBody = await called.json();
    assert.equal(callBody.result.isError, undefined);
    assert.equal(callBody.result.structuredContent.data.totalSavedAreaM2, 2.88);
    assert.equal(backendAuthHeaders[0], `Bearer ${backendToken}`);

    const auditContent = readFileSync(auditFile, 'utf8');
    assert.ok(auditContent.includes('find_material_candidates'));
    assert.ok(!auditContent.includes('SENSITIVE-CUSTOMER-PATTERN-XYZ'));
    assert.ok(!auditContent.includes(mcpToken));
    assert.ok(!auditContent.includes(backendToken));
  } finally {
    await httpMcp.close();
    await new Promise((r) => backend.close(r));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('result summary omits geometry and preserves metric definitions', async () => {
  const data = {
    id: 'result-1',
    jobId: 'job-1',
    inputHash: 'hash',
    schemaVersion: '2.0',
    validationStatus: 'PASSED',
    fulfillmentStatus: 'COMPLETE',
    meetsRequirement: true,
    terminationReason: 'COMPLETED',
    metrics: [
      {
        name: 'utilization',
        value: 80,
        unit: '%',
        numerator: 8,
        denominator: 10,
        basis: 'net-area / consumed',
        version: '1'
      }
    ],
    layout: { placements: [] }
  };
  const session = await connected({}, async () => data);
  try {
    const result = await session.client.callTool({
      name: 'get_optimization_result',
      arguments: { resultId: 'result-1' }
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.structuredContent.data.layout, undefined);
    assert.deepEqual(result.structuredContent.data.metrics, data.metrics);
  } finally {
    await session.close();
  }
});

test('stdio SDK handshake tool discovery and canonical resource work without HTTP', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
    stderr: 'pipe',
    env: { CUTTING_API_URL: 'http://127.0.0.1:1' }
  });
  const client = new Client({ name: 'stdio-verifier', version: '1' });
  let diagnostics = '';
  transport.stderr.on('data', (chunk) => (diagnostics += chunk));
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
    const resource = await client.readResource({ uri: 'cutting://contracts/openapi' });
    assert.deepEqual(JSON.parse(resource.contents[0].text), openapi);
    const failed = await client.callTool({ name: 'get_optimization_job', arguments: { jobId: 'job-1' } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).code, 'SERVICE_UNAVAILABLE');
  } finally {
    await client.close();
  }
  assert.ok(diagnostics.includes('get_optimization_job'));
});
