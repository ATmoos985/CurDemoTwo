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

const apiToken = String(process.env.CUTTING_API_TOKEN || '').trim();
const agentToken = String(process.env.CUTTING_AGENT_TOKEN || '').trim();
const mcpToken = agentToken || apiToken;
const revokeAgentId = String(process.env.CUTTING_TEST_REVOKE_AGENT_ID || '').trim();

const authHeaders = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const requestRaw = async (method, path, { body, token = apiToken } = {}) => {
  const res = await fetch(config.origin + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(token)
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, text, data };
};

const fetchJson = async (path, token = apiToken) => {
  const res = await requestRaw('GET', path, { token });
  assert.ok(res.ok, `GET ${path} 失败 HTTP ${res.status}: ${res.text}`);
  return res.data;
};
const postJson = async (path, body, token = apiToken) => {
  const res = await requestRaw('POST', path, { body, token });
  assert.ok(res.ok, `POST ${path} 失败 HTTP ${res.status}: ${res.text}`);
  return res.data;
};
const reconSnapshot = () => fetchJson('/api/v2/inventory-ledger/reconciliation');
const physicalStockSnapshot = async () => {
  const [rolls, remnants, recon] = await Promise.all([
    fetchJson('/api/v2/rolls'),
    fetchJson('/api/v2/remnants'),
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

const mcpMe = mcpToken ? await fetchJson('/api/v2/auth/me', mcpToken) : await fetchJson('/api/v2/auth/me', '');
const isRestrictedAgent =
  mcpMe?.enabled === true && mcpMe?.authenticated === true && mcpMe?.actorType === 'AGENT';
const agentCanWriteDemand =
  isRestrictedAgent && Array.isArray(mcpMe.scopes) && mcpMe.scopes.includes('DEMAND_WRITE');

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
    CUTTING_MCP_ALLOW_DEMAND_WRITE: 'true',
    ...(apiToken ? { CUTTING_API_TOKEN: apiToken } : {}),
    ...(agentToken ? { CUTTING_AGENT_TOKEN: agentToken } : {})
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

  // 1. 协议发现：25 工具 + 2 Resources + 3 Prompts
  const listedTools = (await client.listTools()).tools;
  assert.equal(listedTools.length, 25, `MCP 工具总数应为 25，实际: ${listedTools.length}`);
  const toolNames = new Set(listedTools.map((t) => t.name));
  for (const requiredTool of ['list_draft_schemes', 'plan_multi_material_drafts', 'discard_draft_scheme']) {
    assert.ok(toolNames.has(requiredTool), `缺少阶段二工具: ${requiredTool}`);
  }
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

  // 4. 建任务（隔离服务写需求池，不扣任何实物库存；受限 Agent 无 DEMAND_WRITE 时实测 403 后改由控制面建任务）
  const taskPayload = {
    name: 'MCP隔离烟测任务-' + randomUUID().slice(0, 6),
    materialModel: 'SMOKE-TC',
    dimension: 'RECT_2D',
    priority: 'HIGH',
    demands: [
      { name: '大身前片', width: 900, length: 1000, quantity: 2, allowRotation: false },
      { name: '大身后片', width: 900, length: 800, quantity: 2, allowRotation: true }
    ]
  };
  let createdTask;
  if (isRestrictedAgent && !agentCanWriteDemand) {
    assert.ok(apiToken, '受限 Agent 缺少 DEMAND_WRITE 时，必须传入 CUTTING_API_TOKEN 作为控制面令牌建任务');
    const deniedCreate = await client.callTool({
      name: 'create_demand_task',
      arguments: taskPayload
    });
    assert.equal(deniedCreate.isError, true, '受限 Agent 无 DEMAND_WRITE 时调用 create_demand_task 必须返回 isError=true');
    assert.match(JSON.stringify(deniedCreate), /FORBIDDEN|403|权限/);
    const createdViaControl = await postJson('/api/v2/demand-pool', taskPayload, apiToken);
    assert.ok(createdViaControl.id, '控制面建任务未返回有效 id');
    createdTask = {
      ...createdViaControl,
      inventoryMutated: false,
      workbenchUrl: `${config.origin}/app/#/workbench?taskId=${encodeURIComponent(createdViaControl.id)}`
    };
  } else {
    createdTask = await call('create_demand_task', taskPayload);
  }
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
    processMode: 'GUILLOTINE',
    objective: 'MAXIMIZE_PIECE_AREA',
    timeLimitSeconds: 3,
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
    objective: 'MAXIMIZE_PIECE_AREA',
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
  assert.equal(taskCmp.sameConstraints, true);
  assert.ok(taskCmp.lengthComparison && taskCmp.lengthComparison.status === 'COMPARABLE');
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
  assert.equal(draft.status, 'PENDING_CONFIRMATION');
  assert.equal(draft.requiresHumanConfirmation, true);
  assert.equal(draft.inventoryMutated, false);
  assert.ok(draft.workbenchUrl.startsWith(config.origin + '/app/#/workbench'));
  passed++;

  // 9. 流水只读与阶段一库存零污染断言
  await call('get_inventory_ledger', { limit: 1 });
  assert.deepEqual(await reconSnapshot(), afterDemandRecon, '试排、对比、预览与草案不得修改库存对账或递增 revision');
  assert.deepEqual(await physicalStockSnapshot(), beforePhysical, '阶段一全链路实物母卷/料头库存必须保持零变动');
  passed++;

  // 10. MCP-S2-01: list_draft_schemes 查询任务待审批草案
  const listedDrafts = await call('list_draft_schemes', {
    taskId: createdTask.id,
    status: 'PENDING_CONFIRMATION',
    page: 0,
    size: 20
  });
  assert.ok(Array.isArray(listedDrafts.items), 'list_draft_schemes 必须返回 items 数组');
  assert.ok(listedDrafts.pendingCount >= 1, `pendingCount 应 >= 1，实际: ${listedDrafts.pendingCount}`);
  const matchedSaved = listedDrafts.items.find((it) => it.draftId === draft.draftId);
  assert.ok(matchedSaved, `list_draft_schemes 结果应包含 ${draft.draftId}`);
  assert.ok(
    matchedSaved.workbenchUrl.startsWith(config.origin + '/app/#/workbench'),
    `workbenchUrl 必须指向隔离 origin: ${matchedSaved.workbenchUrl}`
  );
  passed++;

  // 11. MCP-S2-02: 隔离构造多料头+多短母卷，执行 plan_multi_material_drafts + PNG 预览
  const multiTag = randomUUID().slice(0, 6).toUpperCase();
  const multiModel = `SMOKE-MULTI-${multiTag}`;
  await postJson('/api/v2/remnants/register', {
    id: `REM-MCP-${multiTag}`,
    width: 1000,
    length: 1200,
    location: `MCP-R-${multiTag}`,
    materialBatch: multiModel,
    status: 'AVAILABLE',
    qualityGrade: 'GRADE_A',
    hasDefect: false
  });
  for (const idx of [1, 2]) {
    const rollId = `ROLL-MCP-${multiTag}-${idx}`;
    await postJson('/api/v2/rolls', {
      rollId,
      rollModel: multiModel,
      width: 1500,
      totalLength: 2200,
      usedLength: 0,
      storageLocation: `MCP-A${idx}-${multiTag}`,
      inspectionStatus: 'PENDING'
    });
    await postJson(`/api/v2/quality/rolls/${encodeURIComponent(rollId)}/inspect-complete`, {
      status: 'PASSED',
      inspector: 'MCP烟测验布员',
      remarks: 'MCP阶段二多料联排夹具放行'
    });
  }
  const afterSetupRecon = await reconSnapshot();
  const afterSetupPhysical = await physicalStockSnapshot();

  const multiRaw = await callRaw('plan_multi_material_drafts', {
    materialModel: multiModel,
    demands: [{ name: '联排主片', width: 700, length: 900, quantity: 6, allowRotation: true }],
    continueAcrossRolls: true,
    includePreview: true,
    previewMaxCount: 3,
    ttlSeconds: 600,
    note: `MCP多料联排-${multiTag}`
  });
  const multiBatch = multiRaw.structuredContent.data;
  assert.ok(multiBatch.batchGroupId, 'batchGroupId 不能为空');
  assert.equal(multiBatch.inventoryMutated, false);
  assert.equal(multiBatch.requiresHumanConfirmation, true);
  assert.ok(multiBatch.draftCount >= 2, `draftCount 应 >= 2，实际: ${multiBatch.draftCount}`);
  assert.equal(multiBatch.previewIncluded, true);
  assert.ok(Array.isArray(multiBatch.previewedDraftIds) && multiBatch.previewedDraftIds.length >= 1);
  const multiPngBytes = assertPngImageContent(multiRaw, 'plan_multi_material_drafts');
  for (let i = 0; i < multiBatch.drafts.length; i++) {
    const d = multiBatch.drafts[i];
    assert.equal(d.batchIndex, i + 1);
    assert.ok(
      d.workbenchUrl && d.workbenchUrl.startsWith(config.origin + '/app/#/workbench'),
      `批量草案 workbenchUrl 必须指向隔离 origin: ${d.workbenchUrl}`
    );
  }
  passed++;

  // 12. MCP-S2-03: list_draft_schemes 按 batchGroupId 过滤
  const batchFiltered = await call('list_draft_schemes', {
    batchGroupId: multiBatch.batchGroupId,
    status: 'ALL',
    page: 0,
    size: 50
  });
  assert.equal(batchFiltered.total, multiBatch.draftCount, '按批组过滤总数应等于 draftCount');
  assert.equal(batchFiltered.items.length, multiBatch.draftCount);
  for (const item of batchFiltered.items) {
    assert.equal(item.batchGroupId, multiBatch.batchGroupId);
  }
  passed++;

  // 13. MCP-S2-04: discard_draft_scheme 正向作废与二次作废 409 冲突透传
  const discardTargetId = multiBatch.drafts[0].draftId;
  const discardReason = 'MCP live-smoke 模拟作废';
  const discarded = await call('discard_draft_scheme', {
    draftId: discardTargetId,
    reason: discardReason
  });
  assert.equal(discarded.draftId, discardTargetId);
  assert.equal(discarded.status, 'DISCARDED');
  assert.equal(discarded.inventoryMutated, false);
  assert.equal(discarded.discardReason, discardReason);

  const duplicateDiscard = await client.callTool({
    name: 'discard_draft_scheme',
    arguments: { draftId: discardTargetId, reason: '重复作废应返回409冲突' }
  });
  assert.equal(duplicateDiscard.isError, true, '二次作废已作废草案必须返回 isError=true，不得静默吞错');
  const errText = JSON.stringify(duplicateDiscard);
  assert.match(errText, /409|DRAFT_ALREADY_DISCARDED|已作废/);
  passed++;

  // 14. 阶段二全链路实物库存与对账零变动校验
  assert.deepEqual(await reconSnapshot(), afterSetupRecon, '多料批量草案与作废不得修改库存对账或递增 revision');
  assert.deepEqual(await physicalStockSnapshot(), afterSetupPhysical, '多料批量草案与作废不得修改任何实物母卷或料头');
  passed++;

  // 15. 认证模式下受限 Agent 越权 403 拦截与可选吊销 401 验证
  let agentForbiddenChecked = false;
  let agentRevokedChecked = false;
  if (isRestrictedAgent) {
    const confirmDraftRes = await requestRaw(
      'POST',
      `/api/v2/workbench/drafts/${encodeURIComponent(draft.draftId)}/confirm`,
      { body: {}, token: mcpToken }
    );
    assert.equal(confirmDraftRes.status, 403, `Agent 越权确认草案应返回 403，实际: ${confirmDraftRes.status} ${confirmDraftRes.text}`);
    assert.equal(confirmDraftRes.data?.code, 'FORBIDDEN');

    const confirmSchemeRes = await requestRaw('POST', '/api/v2/schemes/confirm', {
      body: { schemeId: 'NON-EXISTENT-SCHEME' },
      token: mcpToken
    });
    assert.equal(confirmSchemeRes.status, 403, `Agent 越权确认方案应返回 403，实际: ${confirmSchemeRes.status} ${confirmSchemeRes.text}`);
    assert.equal(confirmSchemeRes.data?.code, 'FORBIDDEN');

    const createUserRes = await requestRaw('POST', '/api/v2/users', {
      body: { username: 'e2e_forbidden_probe', role: 'OPERATOR', password: 'Password#1' },
      token: mcpToken
    });
    assert.equal(createUserRes.status, 403, `Agent 越权创建用户应返回 403，实际: ${createUserRes.status} ${createUserRes.text}`);
    assert.equal(createUserRes.data?.code, 'FORBIDDEN');

    assert.deepEqual(await reconSnapshot(), afterSetupRecon, '越权拦截后对账不得发生变化');
    assert.deepEqual(await physicalStockSnapshot(), afterSetupPhysical, '越权拦截后实物库存不得发生变化');
    agentForbiddenChecked = true;

    if (revokeAgentId) {
      assert.ok(apiToken, '吊销 Agent 验证需要 CUTTING_API_TOKEN');
      const revoked = await postJson(
        `/api/v2/agents/${encodeURIComponent(revokeAgentId)}/revoke`,
        { reason: 'MCP live-smoke 吊销后 401 验证' },
        apiToken
      );
      assert.equal(revoked.enabled, false);
      assert.ok(revoked.revokedAt, '吊销响应必须包含 revokedAt');

      const revokedMcpCall = await client.callTool({
        name: 'list_demand_pool',
        arguments: { onlyOpen: false, limit: 5 }
      });
      assert.equal(revokedMcpCall.isError, true, 'Agent 凭证吊销后调用 MCP 工具必须返回 isError=true');
      assert.match(JSON.stringify(revokedMcpCall), /UNAUTHORIZED|401/);

      const revokedRestRes = await requestRaw('GET', '/api/v2/demand-pool', { token: mcpToken });
      assert.equal(revokedRestRes.status, 401, `Agent 吊销后 REST 请求应返回 401，实际: ${revokedRestRes.status}`);
      agentRevokedChecked = true;
    }
    passed++;
  }

  console.log(
    JSON.stringify({
      executed: passed,
      passed,
      failed: 0,
      skipped: 0,
      authMode: mcpMe?.enabled === true,
      actorType: mcpMe?.actorType || 'LOCAL',
      agentForbiddenChecked,
      agentRevokedChecked,
      taskId: createdTask.id,
      resultId: plan1.id,
      draftId: draft.draftId,
      batchGroupId: multiBatch.batchGroupId,
      multiDraftCount: multiBatch.draftCount,
      discardedDraftId: discardTargetId,
      plan1PngBytes,
      previewPngBytes,
      multiPngBytes,
      workbenchUrl: draft.workbenchUrl,
      inventoryUnchanged: true
    })
  );
} finally {
  await client.close();
}
