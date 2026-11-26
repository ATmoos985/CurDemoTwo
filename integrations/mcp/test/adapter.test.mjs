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
import { configuration, apiClient, audited, createAuditLogger, ToolFailure } from '../src/api.mjs';
import { createMcpHttpServer, startMcpHttpServer } from '../src/http-server.mjs';
import { fileURLToPath } from 'node:url';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assertValidPngBase64(b64, expectedW, expectedH) {
  assert.equal(typeof b64, 'string');
  const buf = Buffer.from(b64, 'base64');
  assert.ok(buf.length > 33, 'PNG 字节长度应大于文件头');
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC, 'PNG 魔数校验失败');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (expectedW !== undefined) assert.equal(width, expectedW);
  if (expectedH !== undefined) assert.equal(height, expectedH);
  return { buf, width, height };
}

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

const sampleResult2D = {
  id: 'res-2d-01',
  jobId: 'res-2d-01',
  inputHash: 'abc123',
  schemaVersion: '2.0',
  validationStatus: 'PASSED',
  fulfillmentStatus: 'COMPLETE',
  meetsRequirement: true,
  terminationReason: 'COMPLETED',
  metrics: [
    {
      name: 'utilization',
      value: 84.2,
      unit: '%',
      numerator: 5052000,
      denominator: 6000000,
      basis: 'net-area / consumed',
      version: '1'
    }
  ],
  layout: {
    schemaVersion: '1',
    unit: 'mm',
    coordinateSystem: 'source-local-top-left',
    status: 'FEASIBLE',
    message: null,
    engine: 'packingsolver',
    engineVersion: '1.0',
    elapsedMs: 120,
    materialId: 'ROLL-101',
    processingRegion: { type: 'RECTANGLE', width: 2000, height: 3000 },
    placements: [
      { id: 1, demandId: 1, name: '前片', x: 0, y: 0, shape: { type: 'RECTANGLE', width: 1000, height: 1000 }, rotationDegrees: 0 },
      { id: 2, demandId: 1, name: '前片', x: 1000, y: 0, shape: { type: 'RECTANGLE', width: 1000, height: 1000 }, rotationDegrees: 0 }
    ],
    leftovers: [
      { id: 'L-1', x: 0, y: 1000, shape: { type: 'RECTANGLE', width: 2000, height: 2000 }, hasDefect: false }
    ],
    cuts: [],
    fulfillment: [{ demandId: 1, requested: 2, placed: 2, unplaced: 0, reason: null }],
    metrics: {
      processingAreaMm2: 6_000_000,
      pieceAreaMm2: 2_000_000,
      reusableAreaMm2: 4_000_000,
      unassignedAreaMm2: 0,
      suggestedFeedLengthMm: 1000
    },
    contours: [],
    requestedEngine: 'auto',
    fallbackReason: null
  }
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

const cutPlanResponseFixture = {
  styleName: 'ST-2026-HOODIE',
  colorName: '藏青',
  totalOrderedGarments: 120,
  totalPlannedGarments: 120,
  overcutGarments: 0,
  layCount: 2,
  totalPlies: 40,
  totalFabricLengthM: 180.5,
  totalFabricAreaM2: 324.9,
  estimatedWeightKg: 78.0,
  averageEfficiencyPct: 86.2,
  lays: [
    {
      layNo: 1,
      plies: 25,
      ratio: { M: 1, L: 2 },
      garmentsPerMarker: 3,
      layGarments: 75,
      estimatedMarkerLengthMm: 4500,
      fabricLengthM: 112.5,
      fabricAreaM2: 202.5
    }
  ],
  sizeAudit: [{ size: 'M', ordered: 40, planned: 40, delta: 0 }]
};

async function connected(config = {}, api = async () => ({}), audit = () => {}, serverOptions = {}) {
  const server = createServer(
    {
      origin: 'http://127.0.0.1:8080',
      compute: false,
      businessRead: false,
      allowDraftScheme: false,
      allowDemandWrite: false,
      apiToken: '',
      transport: 'stdio',
      httpHost: '127.0.0.1',
      httpPort: 3080,
      httpToken: '',
      auditLogPath: '',
      ...config
    },
    { api, audit, pollIntervalMs: 0, ...serverOptions }
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

test('configuration permits only literal loopback origins, explicit grants (including ALLOW_DEMAND_WRITE), and enforces HTTP token', () => {
  assert.equal(configuration({}).compute, false);
  assert.equal(configuration({}).businessRead, false);
  assert.equal(configuration({}).allowDraftScheme, false);
  assert.equal(configuration({}).allowDemandWrite, false);
  assert.equal(configuration({ CUTTING_MCP_COMPUTE: 'true' }).compute, true);
  assert.equal(configuration({ CUTTING_MCP_ALLOW_DRAFT_SCHEME: 'true' }).allowDraftScheme, true);
  assert.equal(configuration({ CUTTING_MCP_ALLOW_DEMAND_WRITE: 'true' }).allowDemandWrite, true);
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
  assert.throws(() => configuration({ CUTTING_MCP_ALLOW_DEMAND_WRITE: 'yes' }));
  assert.throws(() => configuration({ MCP_TRANSPORT: 'grpc' }));
  assert.throws(() => configuration({ MCP_TRANSPORT: 'http' }), /MCP_API_TOKEN/);
  assert.throws(() => configuration({ MCP_TRANSPORT: 'http', MCP_API_TOKEN: 'short-token' }), /MCP_API_TOKEN/);
  const httpCfg = configuration({
    MCP_TRANSPORT: 'http',
    MCP_API_TOKEN: 'mcp-enterprise-secret-token-2026',
    CUTTING_API_TOKEN: 'backend-bearer-token-2026',
    CUTTING_MCP_ALLOW_DEMAND_WRITE: 'true'
  });
  assert.equal(httpCfg.transport, 'http');
  assert.equal(httpCfg.apiToken, 'backend-bearer-token-2026');
  assert.equal(httpCfg.allowDemandWrite, true);
});

test('OpenAPI 阶段四与阶段一工作台编排全部新增路径与 $ref 引用均完整有效', () => {
  const expectedPaths = [
    '/api/v2/optimization-jobs/{jobId}/events',
    '/api/v2/planning/multi-material',
    '/api/v2/planning/cut-plan',
    '/api/v2/analytics/cost-summary',
    '/api/v2/analytics/procurement-suggestions',
    '/api/v2/workbench/tasks/{taskId}/plan-jobs',
    '/api/v2/workbench/tasks/{taskId}/result-comparison',
    '/api/v2/workbench/results/{resultId}/context',
    '/api/v2/workbench/drafts',
    '/api/v2/workbench/drafts/{draftId}'
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

test('tool discovery strictly enforces grant matrix (7 / 9 / 17 / 20 / 21 / 22 tools) and blocks stock mutation tools', async () => {
  const checks = [
    [{ compute: false, businessRead: false, allowDraftScheme: false, allowDemandWrite: false }, 7],
    [{ compute: true, businessRead: false, allowDraftScheme: false, allowDemandWrite: false }, 9],
    [{ compute: false, businessRead: true, allowDraftScheme: false, allowDemandWrite: false }, 17],
    [{ compute: true, businessRead: true, allowDraftScheme: false, allowDemandWrite: false }, 20],
    [{ compute: true, businessRead: true, allowDraftScheme: true, allowDemandWrite: false }, 21],
    [{ compute: true, businessRead: true, allowDraftScheme: true, allowDemandWrite: true }, 22]
  ];

  for (const [cfg, expectedCount] of checks) {
    const session = await connected(cfg);
    try {
      const { tools } = await session.client.listTools();
      assert.equal(tools.length, expectedCount, `开关 ${JSON.stringify(cfg)} 应注册 ${expectedCount} 个工具`);
      if (!cfg.allowDemandWrite) {
        assert.equal(tools.some((t) => t.name === 'create_demand_task'), false);
        await assert.rejects(
          session.client.callTool({
            name: 'create_demand_task',
            arguments: { name: '非法写入', demands: [{ name: 'A', width: 100, length: 100, quantity: 1 }] }
          })
        );
      }
      if (!(cfg.compute && cfg.businessRead)) {
        assert.equal(tools.some((t) => t.name === 'plan_task_on_material'), false);
      }
      if (!cfg.allowDraftScheme) {
        assert.equal(tools.some((t) => t.name === 'save_draft_scheme'), false);
      }
    } finally {
      await session.close();
    }
  }

  const fullSession = await connected({
    compute: true,
    businessRead: true,
    allowDraftScheme: true,
    allowDemandWrite: true
  });
  try {
    const { tools } = await fullSession.client.listTools();
    assert.equal(tools.length, 22);
    const names = new Set(tools.map((t) => t.name));
    const expectedAll22 = [
      'get_cutting_capabilities',
      'validate_cutting_problem',
      'get_optimization_job',
      'get_optimization_input',
      'get_optimization_result',
      'compare_cutting_results',
      'render_cutting_preview',
      'submit_optimization_job',
      'cancel_optimization_job',
      'get_cutting_task',
      'get_inventory_ledger',
      'find_material_candidates',
      'get_material_trace',
      'analyze_production_insights',
      'list_demand_pool',
      'list_available_materials',
      'list_demand_templates',
      'generate_cut_plan',
      'compare_task_results',
      'plan_task_on_material',
      'create_demand_task',
      'save_draft_scheme'
    ];
    for (const expected of expectedAll22) {
      assert.ok(names.has(expected), `缺少工具 ${expected}`);
    }
    assert.equal(tools.find((t) => t.name === 'render_cutting_preview').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'submit_optimization_job').annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'cancel_optimization_job').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'plan_task_on_material').annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'plan_task_on_material').annotations.destructiveHint, false);
    assert.equal(tools.find((t) => t.name === 'create_demand_task').annotations.readOnlyHint, false);
    assert.equal(tools.find((t) => t.name === 'create_demand_task').annotations.destructiveHint, false);
    assert.equal(tools.find((t) => t.name === 'save_draft_scheme').annotations.destructiveHint, false);
    // 禁止出现任何直接写库存/过账报工/移库/报废工具
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

test('MCP Resources（含 cutting://guides/operations）与 3 个标准 Prompts 可发现并正确渲染', async () => {
  const session = await connected({});
  try {
    const { resources } = await session.client.listResources();
    const uris = new Set(resources.map((r) => r.uri));
    assert.ok(uris.has('cutting://contracts/openapi'));
    assert.ok(uris.has('cutting://guides/operations'));

    const guide = await session.client.readResource({ uri: 'cutting://guides/operations' });
    assert.equal(guide.contents[0].mimeType, 'text/markdown');
    const md = guide.contents[0].text;
    assert.ok(md.includes('mm'));
    assert.ok(md.includes('FIXED'));
    assert.ok(md.includes('ROTATE_90'));
    assert.ok(md.includes('HALF_180'));
    assert.ok(md.includes('PENDING'));

    const { prompts } = await session.client.listPrompts();
    const promptNames = new Set(prompts.map((p) => p.name));
    assert.equal(prompts.length, 3);
    assert.ok(promptNames.has('import-order-to-demand'));
    assert.ok(promptNames.has('plan-afternoon-schedule'));
    assert.ok(promptNames.has('compare-cutting-plans'));

    const p1 = await session.client.getPrompt({
      name: 'import-order-to-demand',
      arguments: { orderText: '前片 800x600 x 10件，TC-2026', materialModel: 'TC-2026' }
    });
    assert.equal(p1.messages.length, 1);
    assert.ok(p1.messages[0].content.text.includes('create_demand_task'));
    assert.ok(p1.messages[0].content.text.includes('前片 800x600'));

    const p2 = await session.client.getPrompt({
      name: 'plan-afternoon-schedule',
      arguments: { taskId: 'TASK-01' }
    });
    assert.ok(p2.messages[0].content.text.includes('plan_task_on_material'));
    assert.ok(p2.messages[0].content.text.includes('TASK-01'));

    const p3 = await session.client.getPrompt({
      name: 'compare-cutting-plans',
      arguments: { taskId: 'TASK-01', leftResultId: 'RES-A', rightResultId: 'RES-B' }
    });
    assert.ok(p3.messages[0].content.text.includes('compare_task_results'));
    assert.ok(p3.messages[0].content.text.includes('RES-A'));
    assert.ok(p3.messages[0].content.text.includes('RES-B'));
  } finally {
    await session.close();
  }
});

test('彻底修复静默吞错：get_material_trace / analyze_production_insights 记录 partialErrors，list_available_materials 报错绝不伪装空库', async () => {
  const session = await connected({ businessRead: true }, async (path) => {
    if (path === '/api/rolls/ROLL-101/spatial-map') {
      return { rollId: 'ROLL-101', cutZones: [], plannedZones: [], cleanSpans: [], defects: [] };
    }
    if (path === '/api/remnants') {
      throw new ToolFailure('HTTP_503', '料头存储暂不可用', true, 503);
    }
    if (path.startsWith('/api/v2/inventory-ledger?')) {
      throw new ToolFailure('SERVICE_UNAVAILABLE', '台账服务连接中断', true, 503);
    }
    if (path === '/api/v2/inventory-ledger/reconciliation') {
      return { status: 'BALANCED', revision: 1, issues: [], areas: [] };
    }
    if (path.startsWith('/api/v2/analytics/cost-summary?')) return costSummaryFixture;
    if (path.startsWith('/api/v2/analytics/procurement-suggestions?')) return procurementFixture;
    if (path === '/api/v2/demand-pool') {
      throw new ToolFailure('HTTP_500', '需求池查询超时', true, 500);
    }
    if (path === '/api/rolls') {
      return [{ rollId: 'ROLL-101', width: 1800, currentRemainingLength: 10000, inspectionStatus: 'PASSED' }];
    }
    return {};
  });

  try {
    // 1. get_material_trace 不再吞掉 /api/remnants 与 /api/v2/inventory-ledger 的失败
    const trace = await session.client.callTool({
      name: 'get_material_trace',
      arguments: { rollId: 'ROLL-101' }
    });
    assert.ok(!trace.isError, JSON.stringify(trace));
    const traceData = trace.structuredContent.data;
    assert.equal(traceData.degraded, true);
    assert.equal(traceData.partialErrors.length, 2);
    assert.deepEqual(
      traceData.partialErrors.map((e) => e.source).sort(),
      ['inventory-ledger', 'remnants']
    );
    assert.equal(traceData.partialErrors.find((e) => e.source === 'remnants').code, 'HTTP_503');

    // 2. analyze_production_insights 不再把 /api/v2/demand-pool 报错伪装成 0 待排
    const insights = await session.client.callTool({
      name: 'analyze_production_insights',
      arguments: {}
    });
    assert.ok(!insights.isError, JSON.stringify(insights));
    const insData = insights.structuredContent.data;
    assert.equal(insData.degraded, true);
    assert.equal(insData.pendingDemandSummary.dataAvailable, false);
    assert.equal(insData.partialErrors.length, 1);
    assert.equal(insData.partialErrors[0].source, 'demand-pool');
    assert.equal(insData.partialErrors[0].code, 'HTTP_500');
    assert.ok(insData.insights.some((i) => i.category === 'DATA_QUALITY'));

    // 3. list_available_materials 绝不吞掉 /api/remnants 报错
    const mats = await session.client.callTool({
      name: 'list_available_materials',
      arguments: { type: 'ALL' }
    });
    assert.equal(mats.isError, true);
    assert.equal(JSON.parse(mats.content[0].text).code, 'HTTP_503');
  } finally {
    await session.close();
  }
});

test('render_cutting_preview 返回合法 PNG image 块 + 工作台深链，并支持 context 404 回退', async () => {
  let calledPaths = [];
  const session = await connected({}, async (path) => {
    calledPaths.push(path);
    if (path === '/api/v2/workbench/results/res-ctx/context') {
      return {
        resultId: 'res-ctx',
        result: sampleResult2D,
        input: problem,
        source: { taskId: 'TASK-88', materialType: 'STOCK_ROLL', materialId: 'ROLL-101' },
        taskSummary: { id: 'TASK-88', materialModel: 'TC-2026' },
        workbenchUrl: '/app/#/workbench?taskId=TASK-88&resultId=res-ctx'
      };
    }
    if (path === '/api/v2/workbench/results/res-fallback/context') {
      throw new ToolFailure('NOT_FOUND', 'context not found', false, 404);
    }
    if (path === '/api/v2/optimization-results/res-fallback') {
      return sampleResult2D;
    }
    if (path.endsWith('/input')) {
      return problem;
    }
    throw new ToolFailure('NOT_FOUND', 'unknown ' + path, false, 404);
  });

  try {
    // 1. 优先命中 workbench context
    const res1 = await session.client.callTool({
      name: 'render_cutting_preview',
      arguments: { resultId: 'res-ctx', widthPx: 640, heightPx: 360 }
    });
    assert.ok(!res1.isError, JSON.stringify(res1));
    assert.equal(res1.content.length, 2);
    assert.equal(res1.content[0].type, 'text');
    assert.equal(res1.content[1].type, 'image');
    assert.equal(res1.content[1].mimeType, 'image/png');
    assertValidPngBase64(res1.content[1].data, 640, 360);
    const d1 = res1.structuredContent.data;
    assert.equal(d1.fallbackUsed, false);
    assert.equal(d1.mode, 'NESTING_2D');
    assert.equal(d1.taskId, 'TASK-88');
    assert.equal(d1.workbenchUrl, 'http://127.0.0.1:8080/app/#/workbench?taskId=TASK-88&resultId=res-ctx');

    // 2. context 404 时自动回退 /api/v2/optimization-results/{id}
    const res2 = await session.client.callTool({
      name: 'render_cutting_preview',
      arguments: { resultId: 'res-fallback', widthPx: 500, heightPx: 300 }
    });
    assert.ok(!res2.isError, JSON.stringify(res2));
    assert.equal(res2.content[1].type, 'image');
    assertValidPngBase64(res2.content[1].data, 500, 300);
    const d2 = res2.structuredContent.data;
    assert.equal(d2.fallbackUsed, true);
    assert.equal(d2.workbenchUrl, 'http://127.0.0.1:8080/app/#/workbench?resultId=res-fallback');
  } finally {
    await session.close();
  }
});

test('新增业务只读 5 工具（demand-pool / materials / templates / cut-plan / compare_task_results）语义完整准确', async () => {
  const calls = [];
  const session = await connected({ businessRead: true }, async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/v2/demand-pool') {
      return [
        {
          id: 'TASK-OPEN',
          name: '秋冬大货前片',
          dimension: 'RECT_2D',
          materialModel: 'TC-2026',
          status: 'OPEN',
          orderedTotal: 20,
          plannedTotal: 0,
          completedTotal: 0,
          openTotal: 20,
          dueDate: '2026-12-01',
          priority: 'URGENT',
          lines: [{ id: 1 }, { id: 2 }]
        },
        {
          id: 'TASK-DONE',
          name: '已完工订单',
          dimension: 'SLITTING_1D',
          materialModel: 'TC-2026',
          status: 'COMPLETED',
          orderedTotal: 10,
          plannedTotal: 0,
          completedTotal: 10,
          openTotal: 0,
          priority: 'NORMAL',
          lines: [{ id: 1 }]
        }
      ];
    }
    if (path === '/api/rolls') {
      return [
        {
          rollId: 'ROLL-PASS',
          rollModel: 'TC-2026',
          batchNo: 'BAT-A1',
          color: '藏青',
          width: 2000,
          totalLength: 50000,
          currentRemainingLength: 42000,
          inspectionStatus: 'PASSED',
          defects: [{ id: 1 }],
          storageLocation: 'R-01'
        },
        {
          rollId: 'ROLL-PEND',
          rollModel: 'TC-2026',
          batchNo: 'BAT-A1',
          color: '藏青',
          width: 2000,
          totalLength: 50000,
          currentRemainingLength: 50000,
          inspectionStatus: 'PENDING',
          defects: [],
          storageLocation: 'R-02'
        }
      ];
    }
    if (path === '/api/remnants') {
      return [
        {
          id: 'REM-01',
          width: 1800,
          length: 2200,
          area: 3.96,
          location: 'A-01',
          materialBatch: 'TC-2026',
          batchNo: 'BAT-A1',
          status: 'AVAILABLE',
          qualityGrade: 'GRADE_A',
          hasDefect: false,
          sourceRollId: 'ROLL-PASS'
        }
      ];
    }
    if (path === '/api/v2/demand-templates') {
      return [
        {
          id: 'TPL-1',
          code: 'HOODIE-STD',
          name: '标准连帽卫衣纸样',
          dimension: 'CONTOUR_2D',
          materialModel: 'TC-2026',
          defaultWidthMm: 1800,
          availableSizes: ['S', 'M', 'L'],
          pieces: [{ name: '前片' }, { name: '后片' }, { name: '袖片' }]
        },
        {
          id: 'TPL-2',
          code: 'SLIT-BASE',
          name: '一维分条标准模板',
          dimension: 'SLITTING_1D',
          materialModel: 'FILM-01',
          defaultWidthMm: 2200,
          availableSizes: ['标准'],
          pieces: [{ name: '条带A' }]
        }
      ];
    }
    if (path === '/api/v2/planning/cut-plan') {
      return cutPlanResponseFixture;
    }
    if (path.startsWith('/api/v2/workbench/tasks/TASK-OPEN/result-comparison?')) {
      return {
        taskId: 'TASK-OPEN',
        left: { resultId: 'R1', fulfillmentStatus: 'COMPLETE', occupiedLengthMm: 2400, shortages: [] },
        right: { resultId: 'R2', fulfillmentStatus: 'COMPLETE', occupiedLengthMm: 2150, shortages: [] },
        sameConstraints: true,
        constraintDifferences: [],
        metricDeltas: [{ name: 'utilization', rightMinusLeft: 3.4 }],
        lengthComparison: { comparable: true, savedLengthMm: 250, reason: null }
      };
    }
    return {};
  });

  try {
    // 1. list_demand_pool（默认 onlyOpen=true）
    const pool = await session.client.callTool({
      name: 'list_demand_pool',
      arguments: { dimension: '2D', priority: 'URGENT' }
    });
    assert.ok(!pool.isError, JSON.stringify(pool));
    assert.equal(pool.structuredContent.data.items.length, 1);
    assert.equal(pool.structuredContent.data.items[0].id, 'TASK-OPEN');
    assert.equal(
      pool.structuredContent.data.items[0].workbenchUrl,
      'http://127.0.0.1:8080/app/#/workbench?taskId=TASK-OPEN'
    );

    // 2. list_available_materials（默认排除 PENDING，includePending=true 时明确标出禁领）
    const matsDefault = await session.client.callTool({
      name: 'list_available_materials',
      arguments: { materialModel: 'TC-2026', batchNo: 'BAT-A1', minWidthMm: 1800 }
    });
    assert.ok(!matsDefault.isError, JSON.stringify(matsDefault));
    assert.equal(matsDefault.structuredContent.data.summary.availableRollCount, 1);
    assert.equal(matsDefault.structuredContent.data.summary.pendingRollCount, 1);
    assert.equal(matsDefault.structuredContent.data.rolls.length, 1);
    assert.equal(matsDefault.structuredContent.data.rolls[0].rollId, 'ROLL-PASS');
    assert.equal(matsDefault.structuredContent.data.rolls[0].eligibleForPlanning, true);
    assert.equal(matsDefault.structuredContent.data.remnants.length, 1);

    const matsWithPending = await session.client.callTool({
      name: 'list_available_materials',
      arguments: { type: 'ROLL', includePending: true }
    });
    assert.ok(!matsWithPending.isError, JSON.stringify(matsWithPending));
    assert.equal(matsWithPending.structuredContent.data.rolls.length, 2);
    const pend = matsWithPending.structuredContent.data.rolls.find((r) => r.rollId === 'ROLL-PEND');
    assert.equal(pend.inspectionStatus, 'PENDING');
    assert.equal(pend.eligibleForPlanning, false);

    // 3. list_demand_templates
    const tpls = await session.client.callTool({
      name: 'list_demand_templates',
      arguments: { dimension: '2D', keyword: '卫衣' }
    });
    assert.ok(!tpls.isError, JSON.stringify(tpls));
    assert.equal(tpls.structuredContent.data.items.length, 1);
    assert.equal(tpls.structuredContent.data.items[0].pieceCount, 3);

    // 4. generate_cut_plan
    const cutPlan = await session.client.callTool({
      name: 'generate_cut_plan',
      arguments: {
        styleName: 'ST-2026-HOODIE',
        colorName: '藏青',
        fabricWidthMm: 1800,
        maxPliesPerLay: 30,
        maxGarmentsPerMarker: 4,
        sizeQuantities: { M: 40, L: 80 }
      }
    });
    assert.ok(!cutPlan.isError, JSON.stringify(cutPlan));
    assert.equal(cutPlan.structuredContent.data.layCount, 2);

    // 5. compare_task_results
    const cmp = await session.client.callTool({
      name: 'compare_task_results',
      arguments: { taskId: 'TASK-OPEN', leftId: 'R1', rightId: 'R2' }
    });
    assert.ok(!cmp.isError, JSON.stringify(cmp));
    assert.equal(cmp.structuredContent.data.sameConstraints, true);
    assert.equal(cmp.structuredContent.data.lengthComparison.savedLengthMm, 250);
  } finally {
    await session.close();
  }
});

test('plan_task_on_material 完成提单→轮询终态→附带 PNG 预览图与深链，并拦截非法投料参数', async () => {
  let pollCount = 0;
  let capturedSubmit = null;
  const session = await connected(
    { compute: true, businessRead: true },
    async (path, body, key) => {
      if (path === '/api/v2/workbench/tasks/TASK-01/plan-jobs') {
        capturedSubmit = { body, key };
        return {
          job: { ...job, id: 'job-plan-1', state: 'QUEUED', resultRef: null },
          source: { taskId: 'TASK-01', materialType: body.materialType, materialId: body.materialId || null },
          workbenchUrl: '/app/#/workbench?taskId=TASK-01&resultId=job-plan-1'
        };
      }
      if (path === '/api/v2/optimization-jobs/job-plan-1') {
        pollCount++;
        return {
          ...job,
          id: 'job-plan-1',
          state: pollCount >= 2 ? 'SUCCEEDED' : 'RUNNING',
          resultRef: pollCount >= 2 ? '/api/v2/optimization-results/job-plan-1' : null
        };
      }
      if (path === '/api/v2/workbench/results/job-plan-1/context') {
        return {
          resultId: 'job-plan-1',
          result: { ...sampleResult2D, id: 'job-plan-1', jobId: 'job-plan-1' },
          input: problem,
          source: { taskId: 'TASK-01', materialType: 'STOCK_ROLL', materialId: 'ROLL-101' },
          taskSummary: { id: 'TASK-01', materialModel: 'TC-2026' },
          workbenchUrl: '/app/#/workbench?taskId=TASK-01&resultId=job-plan-1'
        };
      }
      throw new ToolFailure('NOT_FOUND', 'unexpected ' + path, false, 404);
    }
  );

  try {
    // 参数拦截：STOCK_ROLL 缺 materialId
    const badRoll = await session.client.callTool({
      name: 'plan_task_on_material',
      arguments: { taskId: 'TASK-01', materialType: 'STOCK_ROLL' }
    });
    assert.equal(badRoll.isError, true);
    assert.equal(JSON.parse(badRoll.content[0].text).code, 'INVALID_INPUT');

    // 参数拦截：FREE_CANVAS 缺 widthMm
    const badFree = await session.client.callTool({
      name: 'plan_task_on_material',
      arguments: { taskId: 'TASK-01', materialType: 'FREE_CANVAS' }
    });
    assert.equal(badFree.isError, true);

    // 正常闭环：提交 + 轮询终态 + 附带 PNG
    const ok = await session.client.callTool({
      name: 'plan_task_on_material',
      arguments: {
        taskId: 'TASK-01',
        idempotencyKey: 'idem-plan-001',
        materialType: 'STOCK_ROLL',
        materialId: 'ROLL-101',
        processMode: 'CROSSCUT',
        avoidDefects: true,
        waitForResult: true,
        includePreview: true,
        previewWidthPx: 600,
        previewHeightPx: 320
      }
    });
    assert.ok(!ok.isError, JSON.stringify(ok));
    assert.equal(capturedSubmit.key, 'idem-plan-001');
    assert.equal(capturedSubmit.body.materialType, 'STOCK_ROLL');
    assert.equal(capturedSubmit.body.materialId, 'ROLL-101');
    assert.equal(capturedSubmit.body.waitForResult, undefined, '控制参数不应透传至后端请求体');
    assert.equal(pollCount, 2);

    const data = ok.structuredContent.data;
    assert.equal(data.job.state, 'SUCCEEDED');
    assert.equal(data.inventoryMutated, false);
    assert.equal(data.previewIncluded, true);
    assert.equal(data.resultSummary.placedCount, 2);
    assert.equal(data.workbenchUrl, 'http://127.0.0.1:8080/app/#/workbench?taskId=TASK-01&resultId=job-plan-1');
    assert.equal(ok.content.length, 2);
    assert.equal(ok.content[1].type, 'image');
    assertValidPngBase64(ok.content[1].data, 600, 320);
  } finally {
    await session.close();
  }
});

test('create_demand_task 与升级后 save_draft_scheme 严格调用真实持久化接口且绝不扣减实物库存', async () => {
  const calls = [];
  const hash64 = 'a'.repeat(64);
  const session = await connected(
    { allowDemandWrite: true, allowDraftScheme: true },
    async (path, body) => {
      calls.push({ path, method: body === undefined ? 'GET' : 'POST', body });
      if (path === '/api/v2/demand-pool') {
        return {
          id: body.mergeIntoTaskId || 'TASK-NEW-01',
          name: body.name || '已合并任务',
          dimension: body.dimension || 'CONTOUR_2D',
          materialModel: body.materialModel || 'TC-2026',
          status: 'OPEN',
          orderedTotal: 5,
          plannedTotal: 0,
          completedTotal: 0,
          openTotal: 5,
          dueDate: body.dueDate || null,
          priority: body.priority || 'HIGH',
          lines: body.demands
        };
      }
      if (path === '/api/v2/workbench/drafts') {
        return {
          id: 'DRAFT-REAL-001',
          draftId: 'DRAFT-REAL-001',
          status: 'PENDING_CONFIRMATION',
          approvalToken: 'wbd_real_token_001',
          contentHash: hash64,
          issuedAt: '2026-11-26T15:00:00Z',
          expiresAt: '2026-11-26T15:15:00Z',
          ttlSeconds: body.ttlSeconds || 900,
          requiresHumanConfirmation: true,
          inventoryMutated: false,
          stale: false,
          staleReasons: [],
          target: {
            resultId: body.resultId,
            taskId: body.taskId || null,
            materialId: body.materialId || null,
            materialType: body.materialType || 'STOCK_ROLL'
          },
          riskChecks: [{ code: 'RESULT_VALIDATION', passed: true, message: 'PASSED' }],
          workbenchUrl: `/app/#/workbench?taskId=${body.taskId}&resultId=${body.resultId}&draftId=DRAFT-REAL-001`,
          nextStep: '请在工作台核对画布后人工点击选定此方案。'
        };
      }
      return {};
    }
  );

  try {
    // 1. create_demand_task 支持 2D 异形带内孔
    const created = await session.client.callTool({
      name: 'create_demand_task',
      arguments: {
        name: '带孔异形测试单',
        materialModel: 'TC-2026',
        dimension: 'CONTOUR_2D',
        priority: 'HIGH',
        demands: [
          {
            name: '带孔门板',
            quantity: 5,
            allowHalfTurn: true,
            shape: {
              type: 'POLYGON',
              width: 800,
              height: 600,
              vertices: [
                { x: 0, y: 0 },
                { x: 800, y: 0 },
                { x: 800, y: 600 },
                { x: 0, y: 600 }
              ],
              holes: [
                [
                  { x: 200, y: 150 },
                  { x: 500, y: 150 },
                  { x: 500, y: 400 },
                  { x: 200, y: 400 }
                ]
              ]
            }
          }
        ]
      }
    });
    assert.ok(!created.isError, JSON.stringify(created));
    assert.equal(created.structuredContent.data.id, 'TASK-NEW-01');
    assert.equal(created.structuredContent.data.inventoryMutated, false);
    assert.equal(
      created.structuredContent.data.workbenchUrl,
      'http://127.0.0.1:8080/app/#/workbench?taskId=TASK-NEW-01'
    );
    // 自动根据 shape 补全 width/length
    assert.equal(calls[0].body.demands[0].width, 800);
    assert.equal(calls[0].body.demands[0].length, 600);

    // 2. save_draft_scheme 拒绝伪造 approved:true
    const spoofed = await session.client.callTool({
      name: 'save_draft_scheme',
      arguments: { resultId: 'res-100', approved: true }
    });
    assert.equal(spoofed.isError, true);

    // 3. save_draft_scheme 调用真实后端 POST /api/v2/workbench/drafts 并自动补全 origin 前缀
    const draft = await session.client.callTool({
      name: 'save_draft_scheme',
      arguments: {
        resultId: 'res-100',
        taskId: 'TASK-NEW-01',
        materialId: 'ROLL-101',
        materialType: 'ROLL',
        note: '请班长核验色号'
      }
    });
    assert.ok(!draft.isError, JSON.stringify(draft));
    const draftCall = calls.find((c) => c.path === '/api/v2/workbench/drafts');
    assert.ok(draftCall, 'save_draft_scheme 必须调用后端真实持久化端点 POST /api/v2/workbench/drafts');
    assert.equal(draftCall.method, 'POST');
    assert.equal(draftCall.body.materialType, 'STOCK_ROLL');
    const d = draft.structuredContent.data;
    assert.equal(d.draftId, 'DRAFT-REAL-001');
    assert.equal(d.approvalToken, 'wbd_real_token_001');
    assert.equal(d.inventoryMutated, false);
    assert.equal(d.requiresHumanConfirmation, true);
    assert.equal(
      d.workbenchUrl,
      'http://127.0.0.1:8080/app/#/workbench?taskId=TASK-NEW-01&resultId=res-100&draftId=DRAFT-REAL-001'
    );
  } finally {
    await session.close();
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
      ['render_cutting_preview', { resultId: '../admin' }],
      ['get_material_trace', { rollId: '../admin' }],
      ['compare_task_results', { taskId: '../bad', leftId: 'a', rightId: 'b' }],
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

test('API client bounds requests and responses, attaches Bearer token, supports custom method/timeout, and preserves status/conflict', async () => {
  const seen = [];
  const server = httpServer((req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization || '', url: req.url });
    if (req.url === '/huge') return res.end('x'.repeat(1000));
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.com' });
      return res.end();
    }
    if (req.url === '/custom-method') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, method: req.method }));
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
    await assert.rejects(api('/conflict', {}), (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.status === 409);
    assert.equal(seen[0].auth, 'Bearer rest-secret-token');
    const custom = await api('/custom-method', undefined, undefined, { method: 'DELETE', timeoutMs: 5000 });
    assert.equal(custom.method, 'DELETE');
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

test('Streamable HTTP 强制鉴权（无 token 拒绝启动 / 401 拦截 / 200 发现全部 22 工具并透传后端凭据与脱敏审计）', async () => {
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
      allowDemandWrite: true,
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
    const unauth = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.equal(unauth.status, 401);

    const wrongAuth = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token-value-123456' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    assert.equal(wrongAuth.status, 401);

    const listed = await fetch(httpMcp.endpointUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    });
    assert.equal(listed.status, 200);
    const listBody = await listed.json();
    assert.equal(listBody.result.tools.length, 22);
    assert.ok(listed.headers.get('mcp-session-id'));

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

test('stdio SDK handshake discovers default 7 tools, 2 resources and 3 prompts without HTTP', async () => {
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
    assert.equal((await client.listTools()).tools.length, 7);
    const { resources } = await client.listResources();
    assert.equal(resources.length, 2);
    const contract = await client.readResource({ uri: 'cutting://contracts/openapi' });
    assert.deepEqual(JSON.parse(contract.contents[0].text), openapi);
    const guide = await client.readResource({ uri: 'cutting://guides/operations' });
    assert.ok(guide.contents[0].text.includes('mm') && guide.contents[0].text.includes('FIXED'));
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 3);
    const failed = await client.callTool({ name: 'get_optimization_job', arguments: { jobId: 'job-1' } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).code, 'SERVICE_UNAVAILABLE');
  } finally {
    await client.close();
  }
  assert.ok(diagnostics.includes('get_optimization_job'));
});
