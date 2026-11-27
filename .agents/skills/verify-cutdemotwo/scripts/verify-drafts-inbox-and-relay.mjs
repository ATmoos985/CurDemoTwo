#!/usr/bin/env node
/**
 * E2E-M2 路线 A（F08 + F09）黑盒端到端验收脚本：
 * 覆盖：
 *  - F08：待确认草案收件箱（角标、40条分页加载更多、状态筛选、深链预览零写库、原生 <dialog> 作废、
 *         「选定此方案」联动 CONFIRMED、TTL=1s 过期阻断、终态冲突 409、空原因/超长 400/不存在 404、
 *         分页/状态参数越界 400、任务版本漂移 stale 告警）
 *  - F09：多料头接力 + 多母卷连续接力批量草案（continueAcrossRolls 对比、batchGroupId 批量生成与幂等重放、
 *         工作台 UI 多料联排→生成联排草案组→同批组切换、按批组检索与单条预览隔离、全链路未确认前零扣库、
 *         幂等冲突 409、无可用材料 422/200、不存在任务 404/1D任务 422、不跨卷拆分、TTL/note 越界 400）
 *  - Tier 3 (T3-F08×F09-01)：多料联排同批组分流审批闭环（草案 #1 作废 DISCARDED，草案 #2 确认 CONFIRMED，互不串扰）
 *
 * 严禁连接正式 8080 端口或修改正式 data/cutdemo-state.json。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const require = createRequire(import.meta.url);

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const val = argv[i + 1];
    if (val !== undefined && !val.startsWith('--')) {
      out[key] = val;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const cli = parseCliArgs(process.argv.slice(2));
const baseUrl = String(cli['base-url'] || process.env.BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
if (!baseUrl) {
  throw new Error('必须提供非 8080 隔离实例环境变量 BASE_URL 或参数 --base-url');
}
const parsedUrl = new URL(baseUrl);
if (
  !['127.0.0.1', 'localhost'].includes(parsedUrl.hostname) ||
  parsedUrl.port === '8080' ||
  parsedUrl.port === ''
) {
  throw new Error(`严禁连接正式服务 8080 或非本机地址: ${baseUrl}`);
}

const resultFile = String(cli['result-file'] || process.env.RESULT_FILE || '').trim();

function resolvePlaywrightPath() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
  const home = os.homedir();
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require.resolve(name, { paths: [REPO_ROOT, path.join(REPO_ROOT, 'frontend')] });
    } catch {}
  }
  const candidates = [
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright-core'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'node_modules', 'playwright-core'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright-core')
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      try {
        return require.resolve(cand);
      } catch {
        return cand;
      }
    }
  }
  return 'playwright';
}

function resolveBrowserPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const { chromium } = require(resolvePlaywrightPath());
const executablePath = resolveBrowserPath();

async function apiJson(reqPath, init = {}) {
  const res = await fetch(`${baseUrl}${reqPath}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data, raw: text };
}

function assertWorkbenchError(res, expectedStatus, expectedCode, label) {
  assert.equal(
    res.status,
    expectedStatus,
    `${label} 期望 HTTP ${expectedStatus}，实际 ${res.status}: ${res.raw}`
  );
  assert.ok(res.data && typeof res.data === 'object', `${label} 响应体应为 JSON 对象`);
  assert.equal(res.data.code, expectedCode, `${label} 期望错误码 ${expectedCode}，实际: ${res.raw}`);
  assert.ok(typeof res.data.message === 'string' && res.data.message.length > 0, `${label} 缺少 message`);
  assert.ok('traceId' in res.data, `${label} 缺少 traceId`);
  assert.equal(typeof res.data.retryable, 'boolean', `${label} 缺少布尔 retryable`);
}

async function waitJobSucceeded(jobId) {
  for (let i = 0; i < 120; i++) {
    const r = await apiJson(`/api/v2/optimization-jobs/${encodeURIComponent(jobId)}`);
    if (r.ok && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.data?.state)) {
      return r.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`作业超时未完成: ${jobId}`);
}

async function snapshotPhysicalStock() {
  const [rollsRes, remnantsRes, reconRes] = await Promise.all([
    apiJson('/api/v2/rolls'),
    apiJson('/api/v2/remnants'),
    apiJson('/api/v2/inventory-ledger/reconciliation')
  ]);
  assert.equal(rollsRes.status, 200, '读取 /api/v2/rolls 必须成功');
  assert.equal(remnantsRes.status, 200, '读取 /api/v2/remnants 必须成功');
  assert.equal(reconRes.status, 200, '读取 /api/v2/inventory-ledger/reconciliation 必须成功');
  return {
    rolls: rollsRes.data,
    remnants: remnantsRes.data,
    reconStatus: reconRes.data?.status,
    revision: reconRes.data?.revision,
    entryCount: reconRes.data?.entryCount
  };
}

async function createPassedRoll({ rollId, rollModel, width, totalLength, location }) {
  const createRes = await apiJson('/api/v2/rolls', {
    method: 'POST',
    body: JSON.stringify({
      rollId,
      rollModel,
      width,
      totalLength,
      usedLength: 0,
      storageLocation: location,
      inspectionStatus: 'PENDING'
    })
  });
  assert.equal(createRes.status, 200, `创建母卷 ${rollId} 必须成功: ${createRes.raw}`);
  const passRes = await apiJson(`/api/v2/quality/rolls/${encodeURIComponent(rollId)}/inspect-complete`, {
    method: 'POST',
    body: JSON.stringify({
      status: 'PASSED',
      inspector: 'E2E验布员',
      remarks: 'E2E自动化验收放行'
    })
  });
  assert.equal(passRes.status, 200, `母卷 ${rollId} 质检放行必须成功: ${passRes.raw}`);
  return passRes.data;
}

const checks = [];
const pageErrors = [];
const nativeDialogs = [];

async function runCheck(id, tier, feature, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({
      id,
      tier,
      feature,
      status: 'PASS',
      durationMs: Date.now() - started,
      detail
    });
  } catch (err) {
    checks.push({
      id,
      tier,
      feature,
      status: 'FAIL',
      durationMs: Date.now() - started,
      detail: String(err?.stack || err)
    });
    throw err;
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {})
});

let failedError = null;
let failureScreenshot = null;
const tag = randomUUID().slice(0, 8).toUpperCase();
const model = `MOD-E2E-${tag}`;
const remAId = `REM-E2E-${tag}`;
const roll1Id = `ROLL1-E2E-${tag}`;
const roll2Id = `ROLL2-E2E-${tag}`;

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => {
    nativeDialogs.push(d.message());
    await d.dismiss();
  });

  // ==================== 构造隔离测试夹具 ====================
  // 1. 料头 REM_A (1000×1200mm) + 母卷 ROLL_1 (1500×2200mm) + 母卷 ROLL_2 (1500×2200mm)
  const remCreate = await apiJson('/api/v2/remnants/register', {
    method: 'POST',
    body: JSON.stringify({
      id: remAId,
      width: 1000,
      length: 1200,
      location: `E2E-REM-${tag}`,
      materialBatch: model,
      status: 'AVAILABLE',
      qualityGrade: 'GRADE_A',
      hasDefect: false
    })
  });
  assert.equal(remCreate.status, 200, `创建料头 ${remAId} 必须成功: ${remCreate.raw}`);

  await createPassedRoll({
    rollId: roll1Id,
    rollModel: model,
    width: 1500,
    totalLength: 2200,
    location: `E2E-A1-${tag}`
  });
  await createPassedRoll({
    rollId: roll2Id,
    rollModel: model,
    width: 1500,
    totalLength: 2200,
    location: `E2E-A2-${tag}`
  });

  // 2. 创建 2D 多料联排任务 TASK_RELAY（6 件 700×900，触发 REM_A(1) + ROLL_1(4) + ROLL_2(1) 跨料跨卷接力）
  const taskRelayRes = await apiJson('/api/v2/demand-pool', {
    method: 'POST',
    body: JSON.stringify({
      name: `多料联排夹具-${tag}`,
      materialModel: model,
      dimension: 'RECT_2D',
      bedLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 10,
      demands: [
        { id: 1, name: '联排主片', width: 700, length: 900, quantity: 6, allowRotation: true }
      ]
    })
  });
  assert.equal(taskRelayRes.status, 200, `创建 TASK_RELAY 必须成功: ${taskRelayRes.raw}`);
  const taskRelayId = taskRelayRes.data.id;

  // 3. 创建 1D 分切任务 TASK_1D（用于 T2-F09-03 422 UNSUPPORTED_CONSTRAINT）
  const task1dRes = await apiJson('/api/v2/demand-pool', {
    method: 'POST',
    body: JSON.stringify({
      name: `一维分切拦截夹具-${tag}`,
      materialModel: model,
      dimension: 'SLITTING_1D',
      demands: [{ id: 1, name: '分条带', width: 300, length: 1000, quantity: 2, allowRotation: false }]
    })
  });
  assert.equal(task1dRes.status, 200, `创建 TASK_1D 必须成功: ${task1dRes.raw}`);
  const task1dId = task1dRes.data.id;

  // 4. 创建 F08 独立任务 TASK_F08（避免与 TASK_RELAY 互相干扰），并提交自由画布试排拿到 resultId
  const taskF08Res = await apiJson('/api/v2/demand-pool', {
    method: 'POST',
    body: JSON.stringify({
      name: `收件箱独立任务-${tag}`,
      materialModel: `MOD-F08-${tag}`,
      dimension: 'RECT_2D',
      bedLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 10,
      demands: [
        { id: 1, name: '门幅A片', width: 800, length: 1000, quantity: 2, allowRotation: true }
      ]
    })
  });
  assert.equal(taskF08Res.status, 200, '创建 TASK_F08 必须成功');
  const taskF08Id = taskF08Res.data.id;

  const jobSubmit = await apiJson(`/api/v2/workbench/tasks/${encodeURIComponent(taskF08Id)}/plan-jobs`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `f08-job-${tag}` },
    body: JSON.stringify({
      materialType: 'FREE_CANVAS',
      widthMm: 2000,
      windowLengthMm: 3000,
      processMode: 'GUILLOTINE',
      objective: 'MAXIMIZE_PIECE_AREA',
      pieceGapMm: 10,
      timeLimitSeconds: 5
    })
  });
  assert.equal(jobSubmit.status, 202, `F08 试排提交必须 202: ${jobSubmit.raw}`);
  const jobF08 = await waitJobSucceeded(jobSubmit.data.job.id);
  assert.equal(jobF08.state, 'SUCCEEDED', `F08 试排必须成功: ${JSON.stringify(jobF08)}`);
  const resultF08Id = String(jobF08.resultRef || jobF08.id).replace(/^\/api\/v2\/optimization-results\//, '');

  // 记录夹具建立后的物理库存基线
  const fixtureBaselineStock = await snapshotPhysicalStock();

  // ==================== Tier 1: F08 (5 项) ====================
  let primaryDraftId = null;
  let discardTargetId = null;
  let confirmTargetId = null;

  await runCheck('T1-F08-01', 'Tier1', 'F08', async () => {
    const createDraft = await apiJson('/api/v2/workbench/drafts', {
      method: 'POST',
      body: JSON.stringify({
        resultId: resultF08Id,
        taskId: taskF08Id,
        materialType: 'FREE_CANVAS',
        note: `T1-F08-01 单草案-${tag}`,
        ttlSeconds: 1800
      })
    });
    assert.equal(createDraft.status, 201, `创建单条草案应返回 201: ${createDraft.raw}`);
    primaryDraftId = createDraft.data.draftId;
    assert.equal(createDraft.data.status, 'PENDING_CONFIRMATION');
    assert.equal(createDraft.data.inventoryMutated, false);

    await page.goto(`${baseUrl}/app/#/workbench`, { waitUntil: 'networkidle' });
    const trigger = page.locator('[data-testid="draft-inbox-trigger"]');
    await trigger.waitFor({ state: 'visible', timeout: 15000 });
    const badge = trigger.locator('.wb-draft-count-badge');
    const badgeCount = Number((await badge.innerText()).trim());
    assert.ok(badgeCount >= 1, `待审角标应 >= 1，实际: ${badgeCount}`);

    await trigger.click();
    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 10000 });
    const card = drawer.locator(`[data-testid="draft-card-${primaryDraftId}"]`);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    const cardText = await card.innerText();
    assert.match(cardText, /待确认/);

    return { primaryDraftId, badgeCount };
  });

  await runCheck('T1-F08-02', 'Tier1', 'F08', async () => {
    // 保证待确认草案总数 >= 42 以触发 PAGE_SIZE=40 分页
    const currentList = await apiJson('/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=1');
    assert.equal(currentList.status, 200);
    const existingPending = Number(currentList.data?.total || 0);
    const needCreate = Math.max(0, 42 - existingPending);
    const bulkIds = [];
    for (let i = 0; i < needCreate; i++) {
      const r = await apiJson('/api/v2/workbench/drafts', {
        method: 'POST',
        body: JSON.stringify({
          resultId: resultF08Id,
          taskId: taskF08Id,
          materialType: 'FREE_CANVAS',
          note: `分页样本-${tag}-${i + 1}`,
          ttlSeconds: 1800
        })
      });
      assert.equal(r.status, 201, `批量造草案第 ${i + 1} 条失败: ${r.raw}`);
      bulkIds.push(r.data.draftId);
    }
    // 选定其中最新一条作为后续作废目标（一定在第 1 页）
    discardTargetId = bulkIds[bulkIds.length - 1] || primaryDraftId;

    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.getByRole('button', { name: '刷新' }).click();
    await page.waitForSelector('[data-testid="draft-inbox-load-more"]', { timeout: 15000 });

    const page0Cards = await drawer.locator('[data-testid^="draft-card-"]').count();
    assert.equal(page0Cards, 40, `首页应展示 40 条草案，实际: ${page0Cards}`);

    const loadMoreBtn = drawer.locator('[data-testid="draft-inbox-load-more"]');
    const loadMoreReqPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/v2/workbench/drafts') &&
        res.url().includes('page=1') &&
        res.url().includes('size=40') &&
        res.status() === 200
    );
    await loadMoreBtn.click();
    await loadMoreReqPromise;
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="draft-inbox-drawer"] [data-testid^="draft-card-"]').length >= 41,
      null,
      { timeout: 15000 }
    );

    const allTestIds = await drawer
      .locator('[data-testid^="draft-card-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    const uniqueIds = new Set(allTestIds);
    assert.ok(allTestIds.length >= 41, `加载更多后卡片数量应 >= 41，实际 ${allTestIds.length}`);
    assert.equal(uniqueIds.size, allTestIds.length, '分页拼接后不得出现重复 draftId');

    return { createdForPaging: needCreate, page0Cards, totalRendered: allTestIds.length };
  });

  await runCheck('T1-F08-03', 'Tier1', 'F08', async () => {
    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.locator('[data-testid="draft-filter-ALL"]').click();
    await page.waitForTimeout(250);
    await drawer.locator('[data-testid="draft-filter-PENDING_CONFIRMATION"]').click();
    await drawer.locator(`[data-testid="draft-card-${discardTargetId}"]`).waitFor({ state: 'visible', timeout: 15000 });

    const writeRequests = [];
    const reqListener = (req) => {
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method()) && req.url().includes('/api/')) {
        writeRequests.push(`${req.method()} ${req.url()}`);
      }
    };
    page.on('request', reqListener);
    try {
      await drawer.locator(`[data-testid="preview-draft-${discardTargetId}"]`).click();
      await drawer.waitFor({ state: 'hidden', timeout: 10000 });
      const banner = page.locator('[data-testid="external-plan-banner"]');
      await banner.waitFor({ state: 'visible', timeout: 15000 });
      const currentUrl = page.url();
      assert.ok(
        currentUrl.includes(`draftId=${encodeURIComponent(discardTargetId)}`),
        `URL hash 应包含 draftId=${discardTargetId}，实际: ${currentUrl}`
      );
      const bannerText = await banner.innerText();
      assert.ok(bannerText.includes(discardTargetId), `横幅应显示草案号 ${discardTargetId}`);
      assert.match(bannerText, /风险预检|待人工确认草案/);
      assert.equal(writeRequests.length, 0, `只读预览不得产生业务写请求: ${writeRequests.join(', ')}`);
      return { previewedDraftId: discardTargetId, url: currentUrl };
    } finally {
      page.off('request', reqListener);
    }
  });

  await runCheck('T1-F08-04', 'Tier1', 'F08', async () => {
    await page.locator('[data-testid="draft-inbox-trigger"]').click();
    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 10000 });
    await drawer.locator(`[data-testid="discard-draft-${discardTargetId}"]`).click();

    const dialog = page.locator('dialog.native-modal-dialog[open]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    const dialogText = await dialog.innerText();
    assert.match(dialogText, /绝不扣减、锁定或恢复任何实物母卷与料头库存/);

    await dialog.getByRole('button', { name: '现场改用其他母卷/料头' }).click();
    const discardRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v2/workbench/drafts/${encodeURIComponent(discardTargetId)}/discard`) &&
        res.request().method() === 'POST'
    );
    await dialog.locator('[data-testid="confirm-discard-btn"]').click();
    const discardResp = await discardRespPromise;
    assert.equal(discardResp.status(), 200, '作废草案接口应返回 200');
    const discardBody = await discardResp.json();
    assert.equal(discardBody.status, 'DISCARDED');
    assert.equal(discardBody.inventoryMutated, false);

    await drawer.locator('[data-testid="draft-filter-DISCARDED"]').click();
    const discardedCard = drawer.locator(`[data-testid="draft-card-${discardTargetId}"]`);
    await discardedCard.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await discardedCard.innerText(), /现场改用其他母卷\/料头/);
    await drawer.locator('[aria-label="关闭收件箱"]').click();
    await drawer.waitFor({ state: 'hidden', timeout: 10000 });

    const stockAfterDiscard = await snapshotPhysicalStock();
    assert.deepEqual(stockAfterDiscard, fixtureBaselineStock, '作废草案后物理库存与对账 revision 必须零变动');
    return { discardTargetId, status: discardBody.status };
  });

  // ==================== Tier 1: F09 (5 项，全部在任何正式 confirm 前验证零扣库) ====================
  const f09BaselineStock = await snapshotPhysicalStock();
  let apiBatchGroupId = null;
  let apiBatchDraftIds = [];
  let apiIdemKey = `idem-f09-${tag}`;
  let uiBatchGroupId = null;
  let uiBatchDrafts = [];

  await runCheck('T1-F09-01', 'Tier1', 'F09', async () => {
    const singleRollRes = await apiJson('/api/v2/planning/multi-material', {
      method: 'POST',
      body: JSON.stringify({
        taskId: taskRelayId,
        preferRemnants: true,
        continueAcrossRolls: false,
        timeBudgetMs: 6000
      })
    });
    assert.equal(singleRollRes.status, 200, `单卷比选必须返回 200: ${singleRollRes.raw}`);
    const singleRec = (singleRollRes.data.rollOptions || []).filter((r) => r.recommended);
    assert.ok(singleRec.length <= 1, `continueAcrossRolls=false 最多推荐 1 卷，实际: ${singleRec.length}`);

    const relayRes = await apiJson('/api/v2/planning/multi-material', {
      method: 'POST',
      body: JSON.stringify({
        taskId: taskRelayId,
        preferRemnants: true,
        continueAcrossRolls: true,
        timeBudgetMs: 8000
      })
    });
    assert.equal(relayRes.status, 200, `跨卷接力试排必须返回 200: ${relayRes.raw}`);
    const relayData = relayRes.data;
    const relayRec = (relayData.rollOptions || []).filter((r) => r.recommended);
    assert.ok(relayRec.length >= 2, `continueAcrossRolls=true 应跨至少 2 卷接力，实际推荐卷数: ${relayRec.length}`);
    const orders = relayRec.map((r) => r.relayOrder);
    for (let i = 0; i < orders.length; i++) {
      assert.equal(orders[i], i + 1, `relayOrder 应从 1 严格递增，实际: ${JSON.stringify(orders)}`);
    }
    const singleTotal = Number(singleRollRes.data.placedByRemnants || 0) + Number(singleRollRes.data.placedByRoll || 0);
    const relayTotal = Number(relayData.placedByRemnants || 0) + Number(relayData.placedByRoll || 0);
    assert.ok(relayTotal > singleTotal, `跨卷接力总排入 (${relayTotal}) 应高于单卷 (${singleTotal})`);
    assert.deepEqual(await snapshotPhysicalStock(), f09BaselineStock, 'T1-F09-01 纯规划不得变动实物库存');
    return { singleTotal, relayTotal, relayOrders: orders };
  });

  await runCheck('T1-F09-02', 'Tier1', 'F09', async () => {
    const reqBody = {
      taskId: taskRelayId,
      preferRemnants: true,
      continueAcrossRolls: true,
      note: `API批量草案-${tag}`,
      ttlSeconds: 1800
    };
    const first = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      headers: { 'Idempotency-Key': apiIdemKey },
      body: JSON.stringify(reqBody)
    });
    assert.equal(first.status, 201, `批量生成草案应返回 201: ${first.raw}`);
    const loc = first.headers.get('location') || '';
    assert.ok(loc.includes('batchGroupId='), `Location 响应头应包含 batchGroupId=，实际: ${loc}`);
    assert.ok(first.data.batchGroupId, 'batchGroupId 不能为空');
    assert.equal(first.data.inventoryMutated, false);
    assert.equal(first.data.requiresHumanConfirmation, true);
    assert.ok(first.data.draftCount >= 2, `draftCount 应 >= 2，实际: ${first.data.draftCount}`);
    assert.equal(first.data.drafts.length, first.data.draftCount);

    for (let i = 0; i < first.data.drafts.length; i++) {
      const d = first.data.drafts[i];
      assert.equal(d.batchIndex, i + 1);
      assert.equal(d.batchTotal, first.data.draftCount);
      assert.ok(d.target?.resultId, `草案 ${d.draftId} 缺少 resultId`);
      const ctxCheck = await apiJson(`/api/v2/workbench/results/${encodeURIComponent(d.target.resultId)}/context`);
      assert.equal(ctxCheck.status, 200, `草案结果上下文 ${d.target.resultId} 必须可查`);
    }

    apiBatchGroupId = first.data.batchGroupId;
    apiBatchDraftIds = first.data.drafts.map((d) => d.draftId);

    // 相同 Idempotency-Key + 相同参数重放
    const replay = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      headers: { 'Idempotency-Key': apiIdemKey },
      body: JSON.stringify(reqBody)
    });
    assert.equal(replay.status, 201, `幂等重放应返回 201: ${replay.raw}`);
    assert.equal(replay.data.batchGroupId, apiBatchGroupId);
    assert.deepEqual(
      replay.data.drafts.map((d) => d.draftId),
      apiBatchDraftIds
    );
    return { apiBatchGroupId, draftCount: first.data.draftCount, apiBatchDraftIds };
  });

  await runCheck('T1-F09-03', 'Tier1', 'F09', async () => {
    await page.goto(`${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskRelayId)}`, {
      waitUntil: 'networkidle'
    });
    await page.waitForSelector('h1', { timeout: 15000 });
    await page.getByRole('button', { name: '多料联排', exact: true }).click();
    const solveBtn = page.locator('button.studio-solve-btn');
    await solveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await solveBtn.click();

    const summaryRegion = page.locator('[role="region"][aria-label="多料联排总览"]');
    await summaryRegion.waitFor({ state: 'visible', timeout: 30000 });

    const genBtn = page.locator('[data-testid="generate-multi-drafts-btn"]');
    await genBtn.waitFor({ state: 'visible', timeout: 10000 });
    const batchRespPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/v2/workbench/multi-material-drafts') &&
        res.request().method() === 'POST'
    );
    await genBtn.click();
    const batchResp = await batchRespPromise;
    assert.equal(batchResp.status(), 201, 'UI 点击生成联排草案组应返回 201');
    const batchData = await batchResp.json();
    uiBatchGroupId = batchData.batchGroupId;
    uiBatchDrafts = batchData.drafts || [];
    assert.ok(uiBatchDrafts.length >= 2, `UI 联排草案组至少 2 份，实际: ${uiBatchDrafts.length}`);

    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 15000 });
    const batchSection = drawer.locator(`[data-testid="draft-batch-${uiBatchGroupId}"]`);
    await batchSection.waitFor({ state: 'visible', timeout: 15000 });

    const firstUiDraftId = uiBatchDrafts[0].draftId;
    await batchSection.locator(`[data-testid="preview-draft-${firstUiDraftId}"]`).click();
    await drawer.waitFor({ state: 'hidden', timeout: 10000 });

    const siblingBar = page.locator('[aria-label="同批联排草案切换"]');
    await siblingBar.waitFor({ state: 'visible', timeout: 15000 });
    const siblingCount = await siblingBar.locator('[data-testid^="banner-sibling-"]').count();
    assert.equal(siblingCount, uiBatchDrafts.length, '同批切换条按钮数应与草案组一致');

    return { uiBatchGroupId, siblingCount };
  });

  await runCheck('T1-F09-04', 'Tier1', 'F09', async () => {
    const listRes = await apiJson(
      `/api/v2/workbench/drafts?status=ALL&batchGroupId=${encodeURIComponent(uiBatchGroupId)}&page=0&size=50`
    );
    assert.equal(listRes.status, 200, `按 batchGroupId 过滤应返回 200: ${listRes.raw}`);
    const items = listRes.data.items || [];
    assert.equal(items.length, uiBatchDrafts.length);
    const matTypes = new Set(items.map((it) => it.target?.materialType));
    assert.ok(matTypes.has('REMNANT'), `批组应包含 REMNANT 草案，实际: ${JSON.stringify([...matTypes])}`);
    assert.ok(matTypes.has('STOCK_ROLL'), `批组应包含 STOCK_ROLL 草案，实际: ${JSON.stringify([...matTypes])}`);
    for (const it of items) {
      assert.ok(it.workbenchUrl && it.workbenchUrl.includes(`draftId=${encodeURIComponent(it.draftId)}`));
    }

    const secondDraft = items.find((it) => it.draftId !== uiBatchDrafts[0].draftId) || items[1];
    const writes = [];
    const reqListener = (req) => {
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method()) && req.url().includes('/api/')) {
        writes.push(`${req.method()} ${req.url()}`);
      }
    };
    page.on('request', reqListener);
    try {
      await page.locator(`[data-testid="banner-sibling-${secondDraft.draftId}"]`).click();
      await page.waitForFunction(
        ({ encodedId, rawId }) => {
          const banner = document.querySelector('[data-testid="external-plan-banner"]');
          return (
            window.location.hash.includes(encodedId) &&
            banner &&
            banner.textContent &&
            banner.textContent.includes(rawId)
          );
        },
        { encodedId: encodeURIComponent(secondDraft.draftId), rawId: secondDraft.draftId },
        { timeout: 15000 }
      );
      const bannerText = await page.locator('[data-testid="external-plan-banner"]').innerText();
      assert.ok(bannerText.includes(secondDraft.draftId), '横幅应切换到第二条草案');
      assert.equal(writes.length, 0, `切换批组草案预览不得发业务写请求: ${writes.join(', ')}`);
      return { uiBatchGroupId, materialTypes: [...matTypes], previewedSecond: secondDraft.draftId };
    } finally {
      page.off('request', reqListener);
    }
  });

  await runCheck('T1-F09-05', 'Tier1', 'F09', async () => {
    const stockNow = await snapshotPhysicalStock();
    assert.deepEqual(stockNow, f09BaselineStock, 'T1-F09-01~04 全链路未确认前物理库存与对账 revision 必须零变动');
    return { revision: stockNow.revision, status: stockNow.reconStatus };
  });

  // ==================== T1-F08-05（选定此方案联动 CONFIRMED） ====================
  await runCheck('T1-F08-05', 'Tier1', 'F08', async () => {
    const createForConfirm = await apiJson('/api/v2/workbench/drafts', {
      method: 'POST',
      body: JSON.stringify({
        resultId: resultF08Id,
        taskId: taskF08Id,
        materialType: 'FREE_CANVAS',
        note: `T1-F08-05 落库验证-${tag}`,
        ttlSeconds: 1800
      })
    });
    assert.equal(createForConfirm.status, 201);
    confirmTargetId = createForConfirm.data.draftId;

    const beforeList = await apiJson('/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=1');
    const pendingBefore = Number(beforeList.data.pendingCount);

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskF08Id)}&draftId=${encodeURIComponent(confirmTargetId)}`,
      { waitUntil: 'networkidle' }
    );
    await page.locator('[data-testid="external-plan-banner"]').waitFor({ state: 'visible', timeout: 15000 });
    const ctaBtn = page.locator('button.value-primary-cta');
    await ctaBtn.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await ctaBtn.isDisabled(), false, '有效待确认草案的选定此方案按钮必须可点击');

    const confirmReqPromise = page.waitForRequest(
      (req) => req.url().includes('/api/v2/schemes/confirm') && req.method() === 'POST'
    );
    const confirmRespPromise = page.waitForResponse(
      (res) => res.url().includes('/api/v2/schemes/confirm') && res.request().method() === 'POST'
    );
    await ctaBtn.click();
    const confirmReq = await confirmReqPromise;
    const confirmReqJson = confirmReq.postDataJSON();
    assert.equal(confirmReqJson.draftId, confirmTargetId, 'schemes/confirm 请求体必须携带 draftId');

    const confirmResp = await confirmRespPromise;
    assert.equal(confirmResp.status(), 200, 'schemes/confirm 必须返回 200');
    const confirmRespBody = await confirmResp.json();
    assert.equal(confirmRespBody.draft?.status, 'CONFIRMED');
    assert.equal(confirmRespBody.draft?.confirmedSchemeId, confirmRespBody.scheme?.id);

    await page.waitForFunction(
      (sid) => {
        const el = document.querySelector('button.value-primary-cta');
        return el && el.textContent && el.textContent.includes(sid);
      },
      confirmRespBody.scheme.id,
      { timeout: 15000 }
    );

    await page.locator('[data-testid="draft-inbox-trigger"]').click();
    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 10000 });
    const clearGroupBtn = drawer.getByRole('button', { name: '查看全部批组 ×' });
    if (await clearGroupBtn.isVisible().catch(() => false)) {
      await clearGroupBtn.click();
    }
    await drawer.locator('[data-testid="draft-filter-CONFIRMED"]').click();
    const confirmedCard = drawer.locator(`[data-testid="draft-card-${confirmTargetId}"]`);
    await confirmedCard.waitFor({ state: 'visible', timeout: 15000 });
    assert.ok((await confirmedCard.innerText()).includes(confirmRespBody.scheme.id));
    await drawer.locator('[aria-label="关闭收件箱"]').click();
    await drawer.waitFor({ state: 'hidden', timeout: 10000 });

    const afterList = await apiJson('/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=1');
    assert.equal(Number(afterList.data.pendingCount), pendingBefore - 1, '确认后 pendingCount 必须减 1');

    return { confirmTargetId, confirmedSchemeId: confirmRespBody.scheme.id };
  });

  // ==================== Tier 2: F08 (5 项) ====================
  await runCheck('T2-F08-01', 'Tier2', 'F08', async () => {
    const shortRes = await apiJson('/api/v2/workbench/drafts', {
      method: 'POST',
      body: JSON.stringify({
        resultId: resultF08Id,
        taskId: taskF08Id,
        materialType: 'FREE_CANVAS',
        note: `短TTL过期-${tag}`,
        ttlSeconds: 1
      })
    });
    assert.equal(shortRes.status, 201, `创建 ttlSeconds=1 草案应 201: ${shortRes.raw}`);
    const expiredDraftId = shortRes.data.draftId;
    await new Promise((r) => setTimeout(r, 1600));

    const getExpired = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(expiredDraftId)}`);
    assert.equal(getExpired.status, 200);
    assert.equal(getExpired.data.status, 'EXPIRED', '超过 TTL 后实时投影应为 EXPIRED');

    const confirmExpired = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(expiredDraftId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ operator: 'e2e-tester' })
    });
    assertWorkbenchError(confirmExpired, 409, 'DRAFT_EXPIRED', '过期草案 confirm');

    const discardExpired = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(expiredDraftId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ reason: '过期测试' })
    });
    assertWorkbenchError(discardExpired, 409, 'DRAFT_EXPIRED', '过期草案 discard');

    const schemeConfirmExpired = await apiJson('/api/v2/schemes/confirm', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `confirm-expired-${tag}`,
        taskId: taskF08Id,
        materialMode: 'FREE_CANVAS',
        width: 2000,
        plannedLength: 1000,
        pieceGap: 10,
        trimStart: 0,
        draftId: expiredDraftId,
        placements: [{ id: 1, demandId: 1, name: '门幅A片', x: 0, y: 0, w: 800, l: 1000, rotationDegrees: 0 }]
      })
    });
    assert.equal(schemeConfirmExpired.status, 409, `schemes/confirm 携带过期 draftId 应返回 409: ${schemeConfirmExpired.raw}`);
    assert.equal(schemeConfirmExpired.data?.code, 'DRAFT_EXPIRED');

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskF08Id)}&draftId=${encodeURIComponent(expiredDraftId)}`,
      { waitUntil: 'networkidle' }
    );
    await page.locator('[data-testid="external-plan-stale-alert"]').waitFor({ state: 'visible', timeout: 15000 });
    const ctaBtn = page.locator('button.value-primary-cta');
    await ctaBtn.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await ctaBtn.isDisabled(), true, '过期草案必须禁用选定此方案按钮');
    assert.equal(
      await page.locator('[data-testid="external-plan-banner"]').getByRole('button', { name: '作废草案' }).count(),
      0,
      '过期草案横幅应隐藏作废草案按钮'
    );
    return { expiredDraftId };
  });

  await runCheck('T2-F08-02', 'Tier2', 'F08', async () => {
    const confirmConfirmed = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(confirmTargetId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ operator: 'e2e' })
    });
    assertWorkbenchError(confirmConfirmed, 409, 'DRAFT_ALREADY_CONFIRMED', '已确认草案二次 confirm');

    const discardConfirmed = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(confirmTargetId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ reason: '已确认尝试作废' })
    });
    assertWorkbenchError(discardConfirmed, 409, 'DRAFT_ALREADY_CONFIRMED', '已确认草案 discard');

    const confirmDiscarded = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(discardTargetId)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ operator: 'e2e' })
    });
    assertWorkbenchError(confirmDiscarded, 409, 'DRAFT_ALREADY_DISCARDED', '已作废草案 confirm');

    const discardDiscarded = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(discardTargetId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ reason: '二次作废' })
    });
    assertWorkbenchError(discardDiscarded, 409, 'DRAFT_ALREADY_DISCARDED', '已作废草案二次 discard');

    const schemeConfirmDiscarded = await apiJson('/api/v2/schemes/confirm', {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: `confirm-discarded-${tag}`,
        taskId: taskF08Id,
        materialMode: 'FREE_CANVAS',
        width: 2000,
        plannedLength: 1000,
        pieceGap: 10,
        trimStart: 0,
        draftId: discardTargetId,
        placements: [{ id: 1, demandId: 1, name: '门幅A片', x: 0, y: 0, w: 800, l: 1000, rotationDegrees: 0 }]
      })
    });
    assert.equal(schemeConfirmDiscarded.status, 409);
    assert.equal(schemeConfirmDiscarded.data?.code, 'DRAFT_DISCARDED');

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskF08Id)}&draftId=${encodeURIComponent(discardTargetId)}`,
      { waitUntil: 'networkidle' }
    );
    await page.locator('[data-testid="external-plan-discarded-alert"]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('button.value-primary-cta').isDisabled(), true, '已作废草案必须禁用选定此方案');
    return { confirmTargetId, discardTargetId };
  });

  await runCheck('T2-F08-03', 'Tier2', 'F08', async () => {
    const latestPendingRes = await apiJson('/api/v2/workbench/drafts?status=PENDING_CONFIRMATION&page=0&size=5');
    assert.equal(latestPendingRes.status, 200);
    const dialogDraftId = latestPendingRes.data?.items?.[0]?.draftId || primaryDraftId;

    await page.goto(`${baseUrl}/app/#/workbench`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="draft-inbox-trigger"]').click();
    const drawer = page.locator('[data-testid="draft-inbox-drawer"]');
    await drawer.waitFor({ state: 'visible', timeout: 10000 });
    const clearGroupBtn = drawer.getByRole('button', { name: '查看全部批组 ×' });
    if (await clearGroupBtn.isVisible().catch(() => false)) {
      await clearGroupBtn.click();
    }
    await drawer.locator('[data-testid="draft-filter-PENDING_CONFIRMATION"]').click();
    await drawer.locator(`[data-testid="draft-card-${dialogDraftId}"]`).waitFor({ state: 'visible', timeout: 10000 });
    await drawer.locator(`[data-testid="discard-draft-${dialogDraftId}"]`).click();

    const dialog = page.locator('dialog.native-modal-dialog[open]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });

    const discardApiCalls = [];
    const reqListener = (req) => {
      if (req.url().includes('/discard')) discardApiCalls.push(req.url());
    };
    page.on('request', reqListener);
    try {
      await dialog.locator('[data-testid="discard-reason-input"]').fill('   ');
      await dialog.locator('[data-testid="confirm-discard-btn"]').click();
      const alertBox = dialog.locator('[role="alert"]');
      await alertBox.waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await alertBox.innerText(), /请填写或点选作废原因，便于后续排产追溯/);
      assert.equal(discardApiCalls.length, 0, '空原因提交不得发起 /discard 网络请求');
    } finally {
      page.off('request', reqListener);
    }
    await dialog.getByRole('button', { name: '取消' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await drawer.locator('[aria-label="关闭收件箱"]').click();

    const longReasonRes = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(primaryDraftId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ reason: '长'.repeat(501) })
    });
    assertWorkbenchError(longReasonRes, 400, 'INVALID_INPUT', '超长 501 字符 reason');

    const missingId = `DRAFT-MISSING-${tag}`;
    const getMissing = await apiJson(`/api/v2/workbench/drafts/${missingId}`);
    assertWorkbenchError(getMissing, 404, 'NOT_FOUND', '不存在 draftId GET');
    const confirmMissing = await apiJson(`/api/v2/workbench/drafts/${missingId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    assertWorkbenchError(confirmMissing, 404, 'NOT_FOUND', '不存在 draftId confirm');
    const discardMissing = await apiJson(`/api/v2/workbench/drafts/${missingId}/discard`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'not found' })
    });
    assertWorkbenchError(discardMissing, 404, 'NOT_FOUND', '不存在 draftId discard');
    return { emptyReasonBlocked: true, longReasonStatus: 400, missingStatus: 404 };
  });

  await runCheck('T2-F08-04', 'Tier2', 'F08', async () => {
    const badQueries = [
      '/api/v2/workbench/drafts?page=-1',
      '/api/v2/workbench/drafts?size=0',
      '/api/v2/workbench/drafts?size=101',
      '/api/v2/workbench/drafts?status=BOGUS'
    ];
    for (const q of badQueries) {
      const r = await apiJson(q);
      assertWorkbenchError(r, 400, 'INVALID_INPUT', `越界查询 ${q}`);
    }
    return { checkedQueries: badQueries.length };
  });

  await runCheck('T2-F08-05', 'Tier2', 'F08', async () => {
    const staleTaskRes = await apiJson('/api/v2/demand-pool', {
      method: 'POST',
      body: JSON.stringify({
        name: `漂移测试任务-${tag}`,
        materialModel: `MOD-STALE-${tag}`,
        dimension: 'RECT_2D',
        bedLengthMm: 3000,
        trimStartMm: 0,
        pieceGapMm: 10,
        demands: [{ id: 1, name: '主片', width: 600, length: 800, quantity: 2, allowRotation: true }]
      })
    });
    assert.equal(staleTaskRes.status, 200);
    const staleTaskId = staleTaskRes.data.id;

    const staleJobSub = await apiJson(`/api/v2/workbench/tasks/${encodeURIComponent(staleTaskId)}/plan-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `stale-job-${tag}` },
      body: JSON.stringify({
        materialType: 'FREE_CANVAS',
        widthMm: 1800,
        windowLengthMm: 3000,
        processMode: 'GUILLOTINE',
        objective: 'MAXIMIZE_PIECE_AREA',
        pieceGapMm: 10,
        timeLimitSeconds: 4
      })
    });
    assert.equal(staleJobSub.status, 202);
    const staleJob = await waitJobSucceeded(staleJobSub.data.job.id);
    assert.equal(staleJob.state, 'SUCCEEDED');
    const staleResultId = String(staleJob.resultRef || staleJob.id).replace(/^\/api\/v2\/optimization-results\//, '');

    const staleDraftRes = await apiJson('/api/v2/workbench/drafts', {
      method: 'POST',
      body: JSON.stringify({
        resultId: staleResultId,
        taskId: staleTaskId,
        materialType: 'FREE_CANVAS',
        note: `漂移检测-${tag}`,
        ttlSeconds: 1800
      })
    });
    assert.equal(staleDraftRes.status, 201);
    const staleDraftId = staleDraftRes.data.draftId;

    const mergeRes = await apiJson('/api/v2/demand-pool', {
      method: 'POST',
      body: JSON.stringify({
        mergeIntoTaskId: staleTaskId,
        demands: [{ name: '新增补片', width: 400, length: 500, quantity: 1, allowRotation: true }]
      })
    });
    assert.equal(mergeRes.status, 200);

    const liveDraft = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(staleDraftId)}`);
    assert.equal(liveDraft.status, 200);
    assert.equal(liveDraft.data.stale, true);
    assert.ok(Array.isArray(liveDraft.data.staleReasons) && liveDraft.data.staleReasons.length > 0);

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(staleTaskId)}&draftId=${encodeURIComponent(staleDraftId)}`,
      { waitUntil: 'networkidle' }
    );
    const alert = page.locator('[data-testid="external-plan-stale-alert"]');
    await alert.waitFor({ state: 'visible', timeout: 15000 });
    return { staleDraftId, staleReasons: liveDraft.data.staleReasons };
  });

  // ==================== Tier 2: F09 (5 项) ====================
  await runCheck('T2-F09-01', 'Tier2', 'F09', async () => {
    const conflict = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      headers: { 'Idempotency-Key': apiIdemKey },
      body: JSON.stringify({
        taskId: taskRelayId,
        preferRemnants: true,
        continueAcrossRolls: true,
        note: `篡改参数冲突-${tag}`,
        ttlSeconds: 900
      })
    });
    assertWorkbenchError(conflict, 409, 'IDEMPOTENCY_CONFLICT', '同 Idempotency-Key 不同参数指纹');
    return { apiIdemKey, code: conflict.data.code };
  });

  await runCheck('T2-F09-02', 'Tier2', 'F09', async () => {
    const nonExistModel = `MOD-NONEXIST-${tag}`;
    const payload = {
      materialModel: nonExistModel,
      demands: [{ id: 1, name: '不可排片', width: 600, length: 800, quantity: 2, allowRotation: true }]
    };
    const batchFail = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    assertWorkbenchError(batchFail, 422, 'NO_FEASIBLE_LAYOUT', '全库无可用材料批量草案');

    const planEmpty = await apiJson('/api/v2/planning/multi-material', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    assert.equal(planEmpty.status, 200, `纯规划无可用材料应返回 200: ${planEmpty.raw}`);
    assert.equal(planEmpty.data.placedByRemnants, 0);
    assert.equal(planEmpty.data.placedByRoll, 0);
    assert.ok(Array.isArray(planEmpty.data.warnings) && planEmpty.data.warnings.length > 0);
    return { nonExistModel, warnings: planEmpty.data.warnings };
  });

  await runCheck('T2-F09-03', 'Tier2', 'F09', async () => {
    const notFoundTask = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      body: JSON.stringify({ taskId: `TASK-MISSING-${tag}` })
    });
    assertWorkbenchError(notFoundTask, 404, 'NOT_FOUND', '不存在 taskId');

    const slittingFail = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      body: JSON.stringify({ taskId: task1dId })
    });
    assertWorkbenchError(slittingFail, 422, 'UNSUPPORTED_CONSTRAINT', '1D 分切任务调用多料批量草案');

    const missingAll = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      body: JSON.stringify({})
    });
    assertWorkbenchError(missingAll, 400, 'INVALID_INPUT', '全缺 taskId/materialModel/demands');
    return { checked: ['404 NOT_FOUND', '422 UNSUPPORTED_CONSTRAINT', '400 INVALID_INPUT'] };
  });

  await runCheck('T2-F09-04', 'Tier2', 'F09', async () => {
    const noRelayRes = await apiJson('/api/v2/workbench/multi-material-drafts', {
      method: 'POST',
      body: JSON.stringify({
        taskId: taskRelayId,
        preferRemnants: false,
        continueAcrossRolls: false,
        ttlSeconds: 600
      })
    });
    assert.equal(noRelayRes.status, 201, `continueAcrossRolls=false 应生成单卷最优草案: ${noRelayRes.raw}`);
    const stockRollDrafts = (noRelayRes.data.drafts || []).filter(
      (d) => d.target?.materialType === 'STOCK_ROLL'
    );
    assert.ok(
      stockRollDrafts.length <= 1,
      `continueAcrossRolls=false 不得跨多卷拆分，实际 STOCK_ROLL 草案数: ${stockRollDrafts.length}`
    );
    return { draftCount: noRelayRes.data.draftCount, stockRollDrafts: stockRollDrafts.length };
  });

  await runCheck('T2-F09-05', 'Tier2', 'F09', async () => {
    const badPayloads = [
      { taskId: taskRelayId, ttlSeconds: 0 },
      { taskId: taskRelayId, ttlSeconds: 86401 },
      { taskId: taskRelayId, note: '超'.repeat(501) }
    ];
    for (const body of badPayloads) {
      const r = await apiJson('/api/v2/workbench/multi-material-drafts', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      assertWorkbenchError(r, 400, 'INVALID_INPUT', `越界参数 ${JSON.stringify(body).slice(0, 60)}`);
    }
    return { testedInvalidPayloads: badPayloads.length };
  });

  // ==================== Tier 3: T3-F08×F09-01 ====================
  await runCheck('T3-F08×F09-01', 'Tier3', 'F08×F09', async () => {
    assert.ok(uiBatchDrafts.length >= 2, '需要至少 2 条 UI 同批组草案');
    const draft1 = uiBatchDrafts[0];
    const draft2 = uiBatchDrafts[1];

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskRelayId)}&draftId=${encodeURIComponent(draft1.draftId)}`,
      { waitUntil: 'networkidle' }
    );
    const banner = page.locator('[data-testid="external-plan-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 15000 });
    const siblingBar = page.locator('[aria-label="同批联排草案切换"]');
    await siblingBar.waitFor({ state: 'visible', timeout: 15000 });

    // 1. 横幅作废草案 #1
    await banner.getByRole('button', { name: '作废草案' }).click();
    const dialog = page.locator('dialog.native-modal-dialog[open]');
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await dialog.getByRole('button', { name: '现场改用其他母卷/料头' }).click();
    const discardP = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/v2/workbench/drafts/${encodeURIComponent(draft1.draftId)}/discard`) &&
        res.request().method() === 'POST'
    );
    await dialog.locator('[data-testid="confirm-discard-btn"]').click();
    const discardRes = await discardP;
    assert.equal(discardRes.status(), 200);
    await page.locator('[data-testid="external-plan-discarded-alert"]').waitFor({ state: 'visible', timeout: 10000 });

    // 2. 切换至同批组草案 #2 并点击「选定此方案」联动 CONFIRMED
    await page.locator(`[data-testid="banner-sibling-${draft2.draftId}"]`).click();
    await page.waitForFunction(
      ({ encodedId, rawId }) => {
        const banner = document.querySelector('[data-testid="external-plan-banner"]');
        return (
          window.location.hash.includes(encodedId) &&
          banner &&
          banner.textContent &&
          banner.textContent.includes(rawId)
        );
      },
      { encodedId: encodeURIComponent(draft2.draftId), rawId: draft2.draftId },
      { timeout: 15000 }
    );
    const ctaBtn = page.locator('button.value-primary-cta');
    await ctaBtn.waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('button.value-primary-cta');
        return el && !el.hasAttribute('disabled') && el.textContent?.includes('选定此方案');
      },
      null,
      { timeout: 15000 }
    );

    const confirmP = page.waitForResponse(
      (res) => res.url().includes('/api/v2/schemes/confirm') && res.request().method() === 'POST'
    );
    await ctaBtn.click();
    const confirmResp = await confirmP;
    assert.equal(confirmResp.status(), 200, '同批组草案 #2 确认落库必须返回 200');
    const confirmBody = await confirmResp.json();
    assert.equal(confirmBody.draft?.status, 'CONFIRMED');
    const scheme2Id = confirmBody.scheme?.id;
    assert.ok(scheme2Id);

    // 3. 核对批组全部草案终态互不串扰 + 作废材料未受扣减
    const groupAfter = await apiJson(
      `/api/v2/workbench/drafts?status=ALL&batchGroupId=${encodeURIComponent(uiBatchGroupId)}&page=0&size=50`
    );
    assert.equal(groupAfter.status, 200);
    const byId = new Map((groupAfter.data.items || []).map((d) => [d.draftId, d]));
    assert.equal(byId.get(draft1.draftId)?.status, 'DISCARDED', '草案 #1 应保持 DISCARDED');
    assert.equal(byId.get(draft2.draftId)?.status, 'CONFIRMED', '草案 #2 应为 CONFIRMED');
    assert.equal(byId.get(draft2.draftId)?.confirmedSchemeId, scheme2Id);
    for (const d of uiBatchDrafts.slice(2)) {
      assert.equal(
        byId.get(d.draftId)?.status,
        'PENDING_CONFIRMATION',
        `同批第 ${d.batchIndex} 条草案应维持 PENDING_CONFIRMATION 互不串扰`
      );
    }

    // 草案 #1 是 REMNANT (remAId)，作废后物理状态必须仍为 AVAILABLE
    const remAfter = await apiJson('/api/v2/remnants');
    const remItem = (remAfter.data || []).find((r) => r.id === remAId);
    assert.ok(remItem, `料头 ${remAId} 应仍在库`);
    assert.equal(remItem.status, 'AVAILABLE', `被作废草案 #1 对应的料头 ${remAId} 必须保持 AVAILABLE`);

    return {
      uiBatchGroupId,
      discardedDraftId: draft1.draftId,
      confirmedDraftId: draft2.draftId,
      confirmedSchemeId: scheme2Id,
      remnantStatus: remItem.status
    };
  });

  assert.equal(pageErrors.length, 0, `页面存在未捕获 JS 异常: ${pageErrors.join(' | ')}`);
  assert.equal(nativeDialogs.length, 0, `页面触发了原生 alert/confirm/prompt: ${nativeDialogs.join(' | ')}`);
} catch (err) {
  failedError = err;
  try {
    const pages = browser.contexts()[0]?.pages() || [];
    if (pages[0]) {
      const shotDir = resultFile ? path.dirname(resultFile) : os.tmpdir();
      fs.mkdirSync(shotDir, { recursive: true });
      failureScreenshot = path.join(shotDir, `drafts-inbox-and-relay-failure-${tag}.png`);
      await pages[0].screenshot({ path: failureScreenshot, fullPage: true });
    }
  } catch {}
} finally {
  await browser.close();
}

const passedCount = checks.filter((c) => c.status === 'PASS').length;
const failedCount = checks.filter((c) => c.status === 'FAIL').length;
const summary = {
  script: 'drafts-inbox-and-relay',
  baseUrl,
  executed: checks.length,
  passed: passedCount,
  failed: failedCount,
  skipped: 0,
  pageErrors,
  nativeDialogs,
  failureScreenshot,
  checks
};

if (resultFile) {
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2), 'utf8');
}

console.log(JSON.stringify(summary, null, 2));

if (failedError || failedCount > 0) {
  if (failedError) console.error(failedError);
  process.exit(1);
}
