import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../src/api.mjs';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// 强制指向隔离临时数据服务，严禁向用户 8080 正式服务写入任何验证数据
if (!process.env.CUTTING_TEST_API_URL) {
  throw Error('Set CUTTING_TEST_API_URL to an isolated temporary-data server.');
}
const config = configuration({ CUTTING_API_URL: process.env.CUTTING_TEST_API_URL });
if (new URL(config.origin).port === '8080') {
  throw Error('Use an isolated server port for the smoke test.');
}

const fetchJson = (path) => fetch(config.origin + path).then((r) => r.json());
const reconSnapshot = () => fetchJson('/api/v2/inventory-ledger/reconciliation');
const physicalStockSnapshot = async () => {
  const [rolls, remnants, recon] = await Promise.all([
    fetchJson('/api/rolls'),
    fetchJson('/api/remnants'),
    reconSnapshot()
  ]);
  return {
    rolls,
    remnants,
    status: recon.status,
    issues: recon.issues,
    areas: recon.areas
  };
};

const beforePhysical = await physicalStockSnapshot();
const request = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))],
  stderr: 'pipe',
  env: {
    CUTTING_API_URL: config.origin,
    CUTTING_MCP_COMPUTE: 'true',
    CUTTING_MCP_BUSINESS_READ: 'true',
    CUTTING_MCP_ALLOW_DRAFT_SCHEME: 'true',
    CUTTING_MCP_ALLOW_DEMAND_WRITE: 'true'
  }
});

const client = new Client({ name: 'cutting-real-service-verifier', version: '1.0.0' });
let passed = 0;
const results = {};

async function callRaw(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name} 失败: ${JSON.stringify(res)}`);
  return res;
}

async function call(name, args = {}) {
  return (await callRaw(name, args)).structuredContent.data;
}

function assertPngImageContent(res, label) {
  const img = res.content.find((c) => c.type === 'image');
  assert.ok(img, `${label} 缺少 image 内容块`);
  assert.equal(img.mimeType, 'image/png');
  const buf = Buffer.from(img.data, 'base64');
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC, `${label} PNG 魔数不合法`);
  return buf.length;
}

try {
  await client.connect(transport);

  // 1. 协议发现：22 工具 + 2 Resources + 3 Prompts
  assert.equal((await client.listTools()).tools.length, 22);
  assert.equal((await client.listResources()).resources.length, 2);
  const guide = await client.readResource({ uri: 'cutting://guides/operations' });
  assert.ok(guide.contents[0].text.includes('mm'));
  assert.equal((await client.listPrompts()).prompts.length, 3);
  passed++;

  // 2. 既有纯计算链路
  results.capabilities = await call('get_cutting_capabilities');
  assert.ok(results.capabilities.problemTypes.includes('NESTING_2D'));
  passed++;

  assert.equal((await call('validate_cutting_problem', { request })).status, 'VALID');
  passed++;

  const idempotencyKey = randomUUID();
  const job = await call('submit_optimization_job', { request, idempotencyKey });
  assert.ok(job.id);
  passed++;

  assert.equal((await call('submit_optimization_job', { request, idempotencyKey })).id, job.id);
  passed++;

  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = await call('get_optimization_job', { jobId: job.id });
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(terminal.state)) break;
    await delay(100);
  }
  assert.equal(terminal.state, 'SUCCEEDED');
  passed++;

  results.result = await call('get_optimization_result', { resultId: job.id });
  assert.equal(results.result.fulfillmentStatus, 'COMPLETE');
  assert.equal(results.result.layout, undefined);
  passed++;

  results.full = await call('get_optimization_result', { resultId: job.id, detail: 'full' });
  assert.ok(results.full.layout);
  assert.deepEqual(await call('get_optimization_input', { jobId: job.id }), request);
  passed++;

  results.comparison = await call('compare_cutting_results', { leftId: job.id, rightId: job.id });
  assert.equal(results.comparison.sameHardConstraints, true);
  assert.ok(results.comparison.metrics.every((m) => m.rightMinusLeft === 0));
  passed++;

  assert.equal((await call('cancel_optimization_job', { jobId: job.id })).state, 'SUCCEEDED');
  passed++;

  // 3. 查全景（需求池 / 可用材料 / 需求模板 / 运营归因）
  const demandPool = await call('list_demand_pool', { onlyOpen: false, limit: 20 });
  assert.ok(Array.isArray(demandPool.items));
  const materials = await call('list_available_materials', { type: 'ALL', includePending: true });
  assert.ok(Array.isArray(materials.rolls) && Array.isArray(materials.remnants));
  const templates = await call('list_demand_templates', { limit: 20 });
  assert.ok(Array.isArray(templates.items));
  const insights = await call('analyze_production_insights', {});
  assert.equal(insights.degraded, false);
  passed++;

  // 4. 建任务（隔离服务写需求池，不扣任何实物库存）
  const createdTask = await call('create_demand_task', {
    name: 'MCP隔离烟测任务-' + randomUUID().slice(0, 6),
    materialModel: 'SMOKE-TC',
    dimension: 'RECT_2D',
    priority: 'HIGH',
    demands: [
      { name: '大身前片', width: 900, length: 1000, quantity: 2, allowRotation: false },
      { name: '大身后片', width: 900, length: 800, quantity: 2, allowRotation: true }
    ]
  });
  assert.ok(createdTask.id);
  assert.equal(createdTask.inventoryMutated, false);
  assert.ok(createdTask.workbenchUrl.includes('taskId=' + encodeURIComponent(createdTask.id)));
  passed++;

  // 建任务后锁定对账基线，验证后续试排/对比/预览/持久化草案零 revision 变动
  const afterDemandRecon = await reconSnapshot();
  assert.deepEqual(await physicalStockSnapshot(), beforePhysical, 'create_demand_task 不得修改任何实物母卷或料头库存');

  // 5. 一键试排（含自动轮询与 PNG 预览图）
  const plan1Raw = await callRaw('plan_task_on_material', {
    taskId: createdTask.id,
    materialType: 'FREE_CANVAS',
    widthMm: 2000,
    windowLengthMm: 4000,
    processMode: 'CROSSCUT',
    timeLimitSeconds: 5,
    waitForResult: true,
    includePreview: true
  });
  const plan1 = plan1Raw.structuredContent.data;
  assert.equal(plan1.job.state, 'SUCCEEDED');
  assert.equal(plan1.inventoryMutated, false);
  assert.equal(plan1.previewIncluded, true);
  assert.ok(plan1.workbenchUrl.includes('resultId=' + encodeURIComponent(plan1.id)));
  const plan1PngBytes = assertPngImageContent(plan1Raw, 'plan_task_on_material');
  passed++;

  // 6. 二次试排 + 同口径双方案对比
  const plan2 = await call('plan_task_on_material', {
    taskId: createdTask.id,
    materialType: 'FREE_CANVAS',
    widthMm: 2000,
    windowLengthMm: 4000,
    processMode: 'GUILLOTINE',
    timeLimitSeconds: 5,
    waitForResult: true,
    includePreview: false
  });
  assert.equal(plan2.job.state, 'SUCCEEDED');
  const taskCmp = await call('compare_task_results', {
    taskId: createdTask.id,
    leftId: plan1.id,
    rightId: plan2.id
  });
  assert.equal(taskCmp.taskId, createdTask.id);
  assert.ok(taskCmp.lengthComparison && typeof taskCmp.lengthComparison === 'object');
  passed++;

  // 7. 独立 PNG 排料预览工具
  const previewRaw = await callRaw('render_cutting_preview', {
    resultId: plan1.id,
    widthPx: 800,
    heightPx: 420
  });
  const previewData = previewRaw.structuredContent.data;
  assert.equal(previewData.mode, 'NESTING_2D');
  assert.ok(previewData.workbenchUrl.includes('resultId=' + encodeURIComponent(plan1.id)));
  const previewPngBytes = assertPngImageContent(previewRaw, 'render_cutting_preview');
  passed++;

  // 8. 持久化待审批草案
  const draft = await call('save_draft_scheme', {
    resultId: plan1.id,
    taskId: createdTask.id,
    materialType: 'FREE_CANVAS',
    note: 'MCP live-smoke 自动验证草案',
    ttlSeconds: 600
  });
  assert.ok(draft.draftId);
  assert.equal(draft.requiresHumanConfirmation, true);
  assert.equal(draft.inventoryMutated, false);
  assert.ok(draft.workbenchUrl.startsWith(config.origin + '/app/#/workbench'));
  passed++;

  // 9. 流水只读与库存零污染断言
  await call('get_inventory_ledger', { limit: 1 });
  assert.deepEqual(await reconSnapshot(), afterDemandRecon, '试排、对比、预览与草案不得修改库存对账或递增 revision');
  assert.deepEqual(await physicalStockSnapshot(), beforePhysical, '全链路实物母卷/料头库存必须保持零变动');
  passed++;

  console.log(
    JSON.stringify({
      executed: passed,
      passed,
      failed: 0,
      skipped: 0,
      taskId: createdTask.id,
      resultId: plan1.id,
      draftId: draft.draftId,
      plan1PngBytes,
      previewPngBytes,
      workbenchUrl: draft.workbenchUrl,
      inventoryUnchanged: true
    })
  );
} finally {
  await client.close();
}
