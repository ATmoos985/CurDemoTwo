#!/usr/bin/env node
/**
 * 技能自有真机补充驱动：覆盖服装第二 Tab 订单自动分床（GARM-06）与转需求池联动（GARM-07）
 * 以及工作台 URL 深链（resultId 只读预览、draftId 风险预检、任务变更触发 stale 红框告警、
 * 有效草案点击「选定此方案」联动 CONFIRMED + 409 冲突阻断，DEEP-01..04）。
 * 严禁连接正式 8080 端口。
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
const baseUrl = String(cli['base-url'] || process.env.BASE_URL || '').trim().replace(/\/$/, '');
if (!baseUrl) throw new Error('必须提供非 8080 隔离实例环境变量 BASE_URL 或参数 --base-url');
const parsed = new URL(baseUrl);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.port === '8080' || parsed.port === '') {
  throw new Error(`严禁连接正式服务或非本机地址: ${baseUrl}`);
}
const resultFile = String(cli['result-file'] || process.env.RESULT_FILE || '').trim();

function resolvePlaywrightModule() {
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

function resolveChromePath() {
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

const { chromium } = require(resolvePlaywrightModule());
const executablePath = resolveChromePath();

async function apiJson(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, ok: res.ok, data };
}

async function waitJobSucceeded(jobId) {
  for (let i = 0; i < 80; i++) {
    const r = await apiJson(`/api/v2/optimization-jobs/${encodeURIComponent(jobId)}`);
    if (r.ok && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.data?.state)) {
      return r.data;
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`作业超时未完成: ${jobId}`);
}

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {})
});

const results = [];
const pageErrors = [];
const nativeDialogs = [];

async function runStep(name, fn) {
  const started = Date.now();
  const detail = await fn();
  results.push({ name, success: true, durationMs: Date.now() - started, detail });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => {
    nativeDialogs.push(d.message());
    await d.dismiss();
  });

  // 1. GARM-06: 服装唛架第二 Tab 订单自动分床与切回第一 Tab 零回归
  await runStep('GARM-06: 服装第二 Tab 订单自动分床零超裁守恒与切回第一 Tab 零回归', async () => {
    await page.goto(`${baseUrl}/app/#/garment`, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1');
    const styleSelect = page.locator('select').first();
    await styleSelect.selectOption('shirt-three');
    const toggle = page.locator('[aria-label="服装唛架功能切换"]');
    await toggle.getByRole('button', { name: /订单自动分床/ }).click();
    await page.getByRole('button', { name: /生成分床方案/ }).click();
    const auditBar = page.locator('[aria-label="尺码守恒核对条"]');
    await auditBar.waitFor({ state: 'visible', timeout: 15000 });
    const auditText = await auditBar.innerText();
    assert.match(auditText, /全部尺码精准守恒/);
    await toggle.getByRole('button', { name: /多门幅唛架对比/ }).click();
    const keptStyle = await page.locator('select').first().inputValue();
    assert.equal(keptStyle, 'shirt-three', '切回第一 Tab 必须保留原已选服装示例');
    return { keptStyle, auditText: auditText.slice(0, 80) };
  });

  // 1.5 GARM-07: 服装分床点击「生成待排需求族并转工作台 →」写需求池并跳转工作台
  await runStep('GARM-07: 服装自动分床生成待排需求族写库并跳转工作台加载', async () => {
    const toggle = page.locator('[aria-label="服装唛架功能切换"]');
    await toggle.getByRole('button', { name: /订单自动分床/ }).click();
    const sendBtn = page.getByRole('button', { name: /生成待排需求族并转工作台/ });
    await sendBtn.waitFor({ state: 'visible', timeout: 10000 });

    const [demandRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/v2/demand-pool') &&
          res.request().method() === 'POST'
      ),
      sendBtn.click()
    ]);
    assert.equal(demandRes.status(), 200, '点击转工作台必须成功调用 POST /api/v2/demand-pool 返回 200');
    const createdFamily = await demandRes.json();
    assert.ok(createdFamily?.id, '创建的需求族必须包含 id');
    assert.ok(Array.isArray(createdFamily?.lines) && createdFamily.lines.length > 0, '创建的需求族必须包含有效裁片明细 lines');

    await page.waitForFunction(() => window.location.hash.startsWith('#/workbench'), null, { timeout: 15000 });
    await page.waitForSelector('h1', { timeout: 15000 });
    const wbBody = await page.locator('body').innerText();
    assert.ok(
      wbBody.includes(createdFamily.name) || wbBody.includes(createdFamily.id),
      `工作台应加载新生成的服装需求族: ${createdFamily.name} (${createdFamily.id})`
    );
    return { createdTaskId: createdFamily.id, name: createdFamily.name, lineCount: createdFamily.lines.length, orderedTotal: createdFamily.orderedTotal };
  });

  // 准备隔离 2D 需求任务 + 后端编排试排 + 持久化草案
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const created = await apiJson('/api/v2/demand-pool', {
    method: 'POST',
    body: JSON.stringify({
      name: `深链巡检-${tag}`,
      materialModel: `MOD-DEEP-${tag}`,
      dimension: 'RECT_2D',
      bedLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 10,
      demands: [
        { id: 1, name: '主门幅片', width: 900, length: 1200, quantity: 2, allowRotation: true },
        { id: 2, name: '配片', width: 500, length: 700, quantity: 2, allowRotation: true }
      ]
    })
  });
  assert.equal(created.status, 200, '创建隔离深链测试任务必须成功');
  const taskId = created.data.id;

  const submitted = await apiJson(`/api/v2/workbench/tasks/${encodeURIComponent(taskId)}/plan-jobs`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `deeplink-verify-${tag}` },
    body: JSON.stringify({
      materialType: 'FREE_CANVAS',
      widthMm: 2000,
      windowLengthMm: 4000,
      processMode: 'GUILLOTINE',
      objective: 'MAXIMIZE_PIECE_AREA',
      pieceGapMm: 10,
      timeLimitSeconds: 5
    })
  });
  assert.equal(submitted.status, 202, `提交编排试排作业必须返回 202，实际: ${JSON.stringify(submitted.data)}`);
  const job = await waitJobSucceeded(submitted.data.job.id);
  assert.equal(job.state, 'SUCCEEDED', `试排作业未成功: ${JSON.stringify(job)}`);
  const resultId = String(job.resultRef || job.id).replace(/^\/api\/v2\/optimization-results\//, '');

  const draftRes = await apiJson('/api/v2/workbench/drafts', {
    method: 'POST',
    body: JSON.stringify({
      resultId,
      taskId,
      materialType: 'FREE_CANVAS',
      note: '巡检持久化草案预检',
      ttlSeconds: 600
    })
  });
  assert.equal(draftRes.status, 201, '创建持久化草案必须返回 201');
  const draftId = draftRes.data.draftId;

  // 2. DEEP-01: resultId 只读深链预览（零写库）
  await runStep('DEEP-01: resultId 只读深链打开工作台蓝图与顶部横幅（零写库）', async () => {
    const writes = [];
    const listener = (req) => {
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method()) && req.url().includes('/api/')) {
        writes.push(`${req.method()} ${req.url()}`);
      }
    };
    page.on('request', listener);
    try {
      await page.goto(
        `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskId)}&resultId=${encodeURIComponent(resultId)}`,
        { waitUntil: 'networkidle' }
      );
      const banner = page.locator('[data-testid="external-plan-banner"]');
      await banner.waitFor({ state: 'visible', timeout: 15000 });
      const text = await banner.innerText();
      assert.match(text, /外部试排方案预览/);
      assert.match(text, /尚未锁库/);
      assert.equal(writes.length, 0, `只读深链预览不得触发业务写接口: ${writes.join(', ')}`);
      const canvasCount = await page.locator('canvas').count();
      assert.ok(canvasCount >= 1, '工作台 Konva 蓝图画布应已渲染');
      return { resultId, canvasCount, bannerSnippet: text.slice(0, 90) };
    } finally {
      page.off('request', listener);
    }
  });

  // 3. DEEP-02: draftId 持久化草案深链与风险预检展示
  await runStep('DEEP-02: draftId 持久化草案深链展示草案号与风险预检清单', async () => {
    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskId)}&draftId=${encodeURIComponent(draftId)}`,
      { waitUntil: 'networkidle' }
    );
    const banner = page.locator('[data-testid="external-plan-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 15000 });
    const text = await banner.innerText();
    assert.ok(text.includes(draftId), `横幅应包含草案号 ${draftId}`);
    assert.match(text, /待人工确认草案|风险预检/);
    return { draftId, bannerSnippet: text.slice(0, 100) };
  });

  // 4. DEEP-03: 任务 revision 变更后触发 stale 红框告警
  await runStep('DEEP-03: 需求任务变更触发版本漂移 stale 醒目告警条', async () => {
    const mutated = await apiJson('/api/v2/demand-pool', {
      method: 'POST',
      body: JSON.stringify({
        mergeIntoTaskId: taskId,
        demands: [{ name: '追加补片', width: 400, length: 500, quantity: 1, allowRotation: true }]
      })
    });
    assert.equal(mutated.status, 200, '追加需求行更新任务 revision 必须成功');

    const liveDraft = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(draftId)}`);
    assert.equal(liveDraft.status, 200, '复查持久化草案应返回 200');
    assert.equal(liveDraft.data?.stale, true, `任务变更后后端草案必须标记 stale=true，实际: ${JSON.stringify(liveDraft.data)}`);

    await page.reload({ waitUntil: 'networkidle' });
    const staleAlert = page.locator('[data-testid="external-plan-stale-alert"]');
    await staleAlert.waitFor({ state: 'visible', timeout: 15000 });
    const alertText = await staleAlert.innerText();
    assert.match(alertText, /版本已变化|重新试排|变更/);
    return { draftId, staleReasons: liveDraft.data.staleReasons, staleAlert: alertText.slice(0, 100) };
  });

  // 5. DEEP-04: 有效草案深链在工作台点击「选定此方案」联动回写 CONFIRMED + 二次作废 409
  await runStep('DEEP-04: 有效草案深链选定此方案联动回写 CONFIRMED 与二次作废 409 冲突', async () => {
    const created2 = await apiJson('/api/v2/demand-pool', {
      method: 'POST',
      body: JSON.stringify({
        name: `深链确认闭环-${tag}`,
        materialModel: `MOD-DEEP2-${tag}`,
        dimension: 'RECT_2D',
        bedLengthMm: 3000,
        trimStartMm: 0,
        pieceGapMm: 10,
        demands: [
          { id: 1, name: '主片', width: 800, length: 1000, quantity: 2, allowRotation: true }
        ]
      })
    });
    assert.equal(created2.status, 200, '创建 DEEP-04 独立任务必须成功');
    const taskId2 = created2.data.id;

    const sub2 = await apiJson(`/api/v2/workbench/tasks/${encodeURIComponent(taskId2)}/plan-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `deeplink-confirm-${tag}` },
      body: JSON.stringify({
        materialType: 'FREE_CANVAS',
        widthMm: 2000,
        windowLengthMm: 3500,
        processMode: 'GUILLOTINE',
        objective: 'MAXIMIZE_PIECE_AREA',
        pieceGapMm: 10,
        timeLimitSeconds: 5
      })
    });
    assert.equal(sub2.status, 202, '提交 DEEP-04 试排作业必须返回 202');
    const job2 = await waitJobSucceeded(sub2.data.job.id);
    assert.equal(job2.state, 'SUCCEEDED', `DEEP-04 试排未成功: ${JSON.stringify(job2)}`);
    const resultId2 = String(job2.resultRef || job2.id).replace(/^\/api\/v2\/optimization-results\//, '');

    const draft2Res = await apiJson('/api/v2/workbench/drafts', {
      method: 'POST',
      body: JSON.stringify({
        resultId: resultId2,
        taskId: taskId2,
        materialType: 'FREE_CANVAS',
        note: 'DEEP-04 正式确认联动验证',
        ttlSeconds: 600
      })
    });
    assert.equal(draft2Res.status, 201, '创建 DEEP-04 持久化草案必须返回 201');
    const draftConfirmId = draft2Res.data.draftId;

    await page.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(taskId2)}&draftId=${encodeURIComponent(draftConfirmId)}`,
      { waitUntil: 'networkidle' }
    );
    const banner = page.locator('[data-testid="external-plan-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(
      await page.locator('[data-testid="external-plan-stale-alert"]').count(),
      0,
      '有效未修改任务草案不得显示 stale 告警'
    );

    const ctaBtn = page.locator('button.value-primary-cta');
    await ctaBtn.waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await ctaBtn.isDisabled(), false, '有效草案选定此方案按钮必须可用');

    const [confirmReq, confirmResp] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes('/api/v2/schemes/confirm') && req.method() === 'POST'
      ),
      page.waitForResponse(
        (res) => res.url().includes('/api/v2/schemes/confirm') && res.request().method() === 'POST'
      ),
      ctaBtn.click()
    ]);

    const reqBody = confirmReq.postDataJSON();
    assert.equal(reqBody?.draftId, draftConfirmId, 'confirm 请求体必须携带 draftId');
    assert.equal(confirmResp.status(), 200, 'confirm 必须返回 200');
    const respJson = await confirmResp.json();
    const schemeId = respJson?.scheme?.id;
    assert.ok(schemeId, 'confirm 必须返回 scheme.id');
    assert.equal(respJson?.draft?.status, 'CONFIRMED', '响应 draft.status 必须为 CONFIRMED');
    assert.equal(respJson?.draft?.confirmedSchemeId, schemeId, 'draft.confirmedSchemeId 必须等于 scheme.id');

    await page.waitForFunction(
      (sid) => {
        const b = document.querySelector('[data-testid="external-plan-banner"]');
        const btn = document.querySelector('button.value-primary-cta');
        return (
          b &&
          b.textContent?.includes('外部试排方案已正式落库') &&
          btn &&
          btn.textContent?.includes(`查看结果 · ${sid}`)
        );
      },
      schemeId,
      { timeout: 15000 }
    );

    const liveDraft = await apiJson(`/api/v2/workbench/drafts/${encodeURIComponent(draftConfirmId)}`);
    assert.equal(liveDraft.status, 200);
    assert.equal(liveDraft.data?.status, 'CONFIRMED');
    assert.equal(liveDraft.data?.confirmedSchemeId, schemeId);

    const discardAfterConfirm = await apiJson(
      `/api/v2/workbench/drafts/${encodeURIComponent(draftConfirmId)}/discard`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '已确认草案禁止作废验证' })
      }
    );
    assert.equal(discardAfterConfirm.status, 409, '对已 CONFIRMED 草案作废必须返回 409');
    assert.equal(discardAfterConfirm.data?.code, 'DRAFT_ALREADY_CONFIRMED');

    return { taskId2, draftConfirmId, confirmedSchemeId: schemeId, discardConflictCode: discardAfterConfirm.data?.code };
  });

  assert.equal(pageErrors.length, 0, `页面出现未捕获脚本异常: ${pageErrors.join(' | ')}`);
  assert.equal(nativeDialogs.length, 0, `页面触发原生弹窗: ${nativeDialogs.join(' | ')}`);

  const summary = {
    executed: results.length,
    passed: results.length,
    failed: 0,
    skipped: 0,
    results
  };
  if (resultFile) {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
