#!/usr/bin/env node
/**
 * F06（#/inspection 跑布验疵、INV-01~03 库存流转与总账平衡）
 * 与 F07（#/slitting 1D 线性分条排产、刀架物理约束与配方 CSV 导出）真机黑盒端到端验收脚本。
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:18095 RESULT_FILE=... node .agents/skills/verify-cutdemotwo/scripts/verify-inspection-and-slitting.mjs
 *   node .agents/skills/verify-cutdemotwo/scripts/verify-inspection-and-slitting.mjs --base-url http://127.0.0.1:18095 [--result-file out.json]
 *
 * 安全红线：
 *   - 仅允许连接 127.0.0.1 或 localhost，严禁连接默认或正式 8080 端口；
 *   - 监听 pageerror 与原生 dialog（零原生弹窗）；
 *   - 全程校验正式 data/cutdemo-state.json SHA-256 与 .drafts 指纹零变动。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROD_STATE_FILE = path.join(REPO_ROOT, 'data', 'cutdemo-state.json');
const PROD_DRAFTS_DIR = path.join(REPO_ROOT, 'data', 'cutdemo-state.json.drafts');
const require = createRequire(import.meta.url);

function getHelpText() {
  return [
    '用法：node .agents/skills/verify-cutdemotwo/scripts/verify-inspection-and-slitting.mjs [选项]',
    '',
    '选项：',
    '  --base-url <url>        指定非 8080 的本机隔离服务地址（优先级高于 BASE_URL）',
    '  --result-file <path>    将结构化 JSON 结果写入指定路径（优先级高于 RESULT_FILE）',
    '  -h, --help              显示本帮助信息并退出'
  ].join('\n');
}

function parseCli(argv) {
  const opts = { baseUrl: null, resultFile: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      opts.help = true;
    } else if (token === '--base-url') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error('参数 --base-url 缺少取值');
      }
      opts.baseUrl = argv[++i];
    } else if (token.startsWith('--base-url=')) {
      opts.baseUrl = token.slice('--base-url='.length);
    } else if (token === '--result-file') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error('参数 --result-file 缺少取值');
      }
      opts.resultFile = argv[++i];
    } else if (token.startsWith('--result-file=')) {
      opts.resultFile = token.slice('--result-file='.length);
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  return opts;
}

function validateBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    throw new Error('必须提供非 8080 隔离实例 BASE_URL 或 --base-url');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`非法 BASE_URL: ${trimmed}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`仅允许 http/https 协议: ${trimmed}`);
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`严禁连接非本机地址（仅允许 127.0.0.1 或 localhost）: ${trimmed}`);
  }
  if (!parsed.port || parsed.port === '8080') {
    throw new Error(`严禁连接默认或正式 8080 端口，必须指定非 8080 隔离端口: ${trimmed}`);
  }
  return trimmed;
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fingerprintDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return 'ABSENT';
  const hash = createHash('sha256');
  const entries = fs.readdirSync(dirPath).sort();
  for (const name of entries) {
    const full = path.join(dirPath, name);
    const stat = fs.statSync(full);
    hash.update(`${name}|${stat.isDirectory() ? 'D' : 'F'}|${stat.size}|${Math.round(stat.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

function resolvePlaywrightModule() {
  if (process.env.PLAYWRIGHT_MODULE) {
    return process.env.PLAYWRIGHT_MODULE;
  }
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require.resolve(name, { paths: [REPO_ROOT, path.join(REPO_ROOT, 'frontend')] });
    } catch {}
  }
  const home = os.homedir();
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
  throw new Error('未探测到 playwright / playwright-core 模块，请设置环境变量 PLAYWRIGHT_MODULE');
}

function resolveBrowserExecutable() {
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
  return null;
}

async function apiJson(baseUrl, apiPath, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const autoIdem =
    method === 'POST' && apiPath.includes('/api/v2/optimization-jobs')
      ? { 'Idempotency-Key': `e2e-idem-${randomUUID().slice(0, 12)}` }
      : {};
  const res = await fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...autoIdem,
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
  return { status: res.status, ok: res.ok, data, text };
}

async function setNumberInputValue(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.click();
  await locator.fill(String(value));
  await locator.press('Enter');
  await locator.evaluate((el) => el.blur());
}

function buildSlittingApiProblem(overrides = {}) {
  return {
    schemaVersion: '2.0',
    clientRequestId: `slit-neg-${randomUUID().slice(0, 8)}`,
    problemType: 'SLITTING_1D',
    allowFallback: false,
    requireComplete: false,
    problem: {
      schemaVersion: '1',
      unit: 'mm',
      motherWidthMm: 2000,
      leftTrimMm: 20,
      rightTrimMm: 20,
      minWidthMm: 200,
      maxWidthMm: 1960,
      widthStepMm: 10,
      totalOverCap: 0,
      profile: 'FAST',
      timeLimitSeconds: 5,
      orders: [
        { id: 'O1', widthMm: 600, lengthMm: 2000, quantity: 3, surfaceTreatment: '不电晕/不涂布' },
        { id: 'O2', widthMm: 400, lengthMm: 2000, quantity: 4, surfaceTreatment: '不电晕/不涂布' }
      ],
      ...overrides
    }
  };
}

function parseCsvFirstRow(csvText) {
  const clean = String(csvText || '').replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  return lines.map(parseLine);
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(getHelpText());
    return;
  }

  const baseUrl = validateBaseUrl(cli.baseUrl || process.env.BASE_URL);
  const resultFile = cli.resultFile || process.env.RESULT_FILE || null;

  const prodStateSha256Before = sha256File(PROD_STATE_FILE);
  const prodDraftsBefore = fingerprintDir(PROD_DRAFTS_DIR);

  const pwMod = resolvePlaywrightModule();
  const { chromium } = require(pwMod);
  const chromeExe = resolveBrowserExecutable();

  const browser = await chromium.launch({
    headless: true,
    ...(chromeExe ? { executablePath: chromeExe } : {})
  });

  const checks = [];
  const pageErrors = [];
  const nativeDialogs = [];
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const materialModel1D = `TC-F06-${tag}`;

  const ctx = {
    rollId1: null,
    rollId2: `ROLL-FAIL-${tag}`,
    slitTaskId: null,
    slitSchemeId: null
  };

  async function runCheck(id, tier, feature, name, page, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({
        id,
        tier,
        feature,
        name,
        status: 'PASS',
        durationMs: Date.now() - started,
        detail
      });
    } catch (err) {
      let screenshotPath = null;
      if (page && resultFile) {
        try {
          const dir = path.dirname(path.resolve(resultFile));
          fs.mkdirSync(dir, { recursive: true });
          screenshotPath = path.join(dir, `fail-${id}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
        } catch {}
      }
      checks.push({
        id,
        tier,
        feature,
        name,
        status: 'FAIL',
        durationMs: Date.now() - started,
        detail: { error: err?.message || String(err), ...(screenshotPath ? { screenshotPath } : {}) }
      });
    }
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => {
    nativeDialogs.push(d.message());
    await d.dismiss();
  });

  try {
    // =========================================================================
    // F06: 库存流转、质检放行、单据过账与总账平衡（INV-01~03）
    // =========================================================================

    await runCheck(
      'F06-T1-01',
      'Tier 1',
      'F06',
      '采购入库新建 PENDING 待检卷并在车间领料弹窗中禁用（INV-01）',
      page,
      async () => {
        await page.goto(`${baseUrl}/app/#/documents`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '库存单据', exact: true, level: 1 }).waitFor();

        await page.getByRole('button', { name: '＋ 采购入库单' }).click();
        const receiptDialog = page.locator('dialog[open]').filter({ hasText: '新建采购批量入库单' });
        await receiptDialog.waitFor({ state: 'visible', timeout: 10000 });

        await receiptDialog.locator('#rec-supplier').fill('华联高新纺织印染');
        await receiptDialog.locator('#rec-delivery').fill(`DN-${tag}-01`);
        await receiptDialog.locator('#rec-operator').fill('仓管王工');
        await receiptDialog.locator('#rec-remarks').fill(`F06黑盒来料-${tag}`);

        const firstRow = receiptDialog.locator('tbody tr').first();
        await firstRow.locator('td').nth(1).locator('input').fill(materialModel1D);
        await firstRow.locator('td').nth(5).locator('input').fill('2000');
        await firstRow.locator('td').nth(6).locator('input').fill('60000');
        assert.equal(await firstRow.locator('td').nth(10).locator('select').inputValue(), 'PENDING');

        const [resp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v2/inventory-receipts') && r.request().method() === 'POST'
          ),
          receiptDialog.getByRole('button', { name: /确认采购入库/ }).click()
        ]);
        assert.equal(resp.status(), 200, '采购入库单过账应返回 HTTP 200');
        const payload = await resp.json();
        assert.ok(Array.isArray(payload.createdRolls) && payload.createdRolls.length === 1, '应创建 1 卷母卷');
        ctx.rollId1 = payload.createdRolls[0].rollId;
        assert.equal(payload.createdRolls[0].inspectionStatus, 'PENDING', '新入库母卷默认应为 PENDING');
        await receiptDialog.waitFor({ state: 'hidden', timeout: 10000 });

        // 验证车间领料弹窗中该待检卷选项禁用
        await page.getByRole('button', { name: '＋ 车间领/退料' }).click();
        const issueDialog = page.locator('dialog[open]').filter({ hasText: '新建车间领 / 退料单' });
        await issueDialog.waitFor({ state: 'visible', timeout: 10000 });
        await issueDialog.locator('[aria-label="选择领料或退料方向"]').getByRole('button', { name: /ISSUE/ }).click();

        const opt = issueDialog.locator(`#iss-roll option[value="${ctx.rollId1}"]`);
        await opt.waitFor({ state: 'attached', timeout: 10000 });
        const optDisabled = await opt.isDisabled();
        const optText = await opt.innerText();
        assert.equal(optDisabled, true, `PENDING 卷 ${ctx.rollId1} 在领料下拉框中必须 disabled`);
        assert.match(optText, /未验布放行，禁领/);

        await issueDialog.getByRole('button', { name: '取消', exact: true }).click();
        await issueDialog.waitFor({ state: 'hidden', timeout: 10000 });
        return { rollId1: ctx.rollId1, optDisabled, optText };
      }
    );

    await runCheck(
      'F06-T2-01',
      'Tier 2',
      'F06',
      'PENDING 待检卷后端发起车间领料强制返回 409 INVENTORY_CONFLICT',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        const r = await apiJson(baseUrl, '/api/v2/material-issues', {
          method: 'POST',
          headers: { 'Idempotency-Key': `f06-pending-issue-${tag}` },
          body: JSON.stringify({
            direction: 'ISSUE',
            rollId: ctx.rollId1,
            machineId: '裁床-01',
            shiftTeam: '甲班',
            operator: '黑盒校验员',
            targetLocation: '车间:裁床-01',
            reason: '待检卷领料负向校验'
          })
        });
        assert.equal(r.status, 409, `PENDING 卷领料必须返回 409，实际 HTTP ${r.status}: ${r.text}`);
        assert.equal(r.data?.code, 'INVENTORY_CONFLICT');
        return { rollId1: ctx.rollId1, status: r.status, code: r.data?.code };
      }
    );

    await runCheck(
      'F06-T1-02',
      'Tier 1',
      'F06',
      '#/inspection 跑布验疵录入疵点、刷新恢复草稿并保存入档（INV-02）',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        await page.goto(`${baseUrl}/app/#/inspection/${encodeURIComponent(ctx.rollId1)}`, {
          waitUntil: 'networkidle'
        });
        await page.getByRole('heading', { name: '跑布验疵', exact: true, level: 1 }).waitFor();

        // 步进前进并校验位置推进
        const posBefore = Number(await page.locator('#pos').inputValue());
        await page.locator('#advance').click();
        await page.waitForFunction(
          (before) => Number(document.querySelector('#pos')?.value || 0) > before,
          posBefore,
          { timeout: 5000 }
        );
        const posAfter = Number(await page.locator('#pos').inputValue());
        assert.ok(posAfter > posBefore, `点击前进后位置应递增: ${posBefore} -> ${posAfter}`);

        // 精确录入疵点坐标
        await page.locator('input[data-f="right"]').fill('100');
        await page.locator('input[data-f="y"]').fill('500');
        await page.locator('input[data-f="w"]').fill('60');
        await page.locator('input[data-f="h"]').fill('80');
        await page.locator('select[data-f="type"]').selectOption('HOLE');
        await page.locator('input[data-f="margin"]').fill('20');
        await page.locator('#apply').click();

        await page.locator('.mp-insp-side-card .tag.warn', { hasText: '待保存' }).waitFor({ state: 'visible' });
        const draftRaw = await page.evaluate((id) => localStorage.getItem(`cutplan.app.inspection.${id}`), ctx.rollId1);
        assert.ok(draftRaw && draftRaw.includes('HOLE'), 'localStorage 应暂存本机验布草稿');

        // 刷新页面确认草稿恢复
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('.mp-insp-side-card .tag.warn', { hasText: '待保存' }).waitFor({ state: 'visible' });

        // 保存入档
        const [saveResp] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes(`/api/v2/rolls/${encodeURIComponent(ctx.rollId1)}/inspection-defects`) &&
              r.request().method() === 'POST'
          ),
          page.locator('#save').click()
        ]);
        assert.equal(saveResp.status(), 200, '保存疵点到母卷应返回 200');

        await page.locator('.mp-insp-side-card .tag', { hasText: '已入档' }).waitFor({ state: 'visible' });
        const pendingCount = await page.locator('.mp-insp-side-card .tag.warn', { hasText: '待保存' }).count();
        assert.equal(pendingCount, 0, '入档后不应残留待保存标签');
        return { rollId1: ctx.rollId1, posBefore, posAfter, defectsSaved: true };
      }
    );

    await runCheck(
      'F06-T2-02',
      'Tier 2',
      'F06',
      '非法质检判定枚举 REJECTED 返回 HTTP 400 INVALID_INPUT',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        const r = await apiJson(baseUrl, `/api/v2/quality/rolls/${encodeURIComponent(ctx.rollId1)}/inspect-complete`, {
          method: 'POST',
          body: JSON.stringify({ status: 'REJECTED', inspector: '黑盒校验员' })
        });
        assert.equal(r.status, 400, `非法 status=REJECTED 应返回 400，实际 HTTP ${r.status}`);
        assert.equal(r.data?.code, 'INVALID_INPUT');
        return { status: r.status, code: r.data?.code, message: r.data?.message };
      }
    );

    await runCheck(
      'F06-T2-03',
      'Tier 2',
      'F06',
      '质检完检缺少有效质检员返回 HTTP 400 INVALID_INPUT',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        const r = await apiJson(baseUrl, `/api/v2/quality/rolls/${encodeURIComponent(ctx.rollId1)}/inspect-complete`, {
          method: 'POST',
          body: JSON.stringify({ status: 'PASSED', inspector: '   ' })
        });
        assert.equal(r.status, 400, `空白 inspector 应返回 400，实际 HTTP ${r.status}`);
        assert.equal(r.data?.code, 'INVALID_INPUT');
        return { status: r.status, code: r.data?.code, message: r.data?.message };
      }
    );

    await runCheck(
      'F06-T1-03',
      'Tier 1',
      'F06',
      '#/inspection 质检放行 PASSED 解禁车间领料与退料流转',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        await page.locator('#inspect-pass-btn').click();
        const passDialog = page.locator('dialog[open]').filter({ hasText: '确认质检合格放行' });
        await passDialog.waitFor({ state: 'visible', timeout: 10000 });
        await passDialog.locator('#qc-inspector').fill('质检李工');
        await passDialog.locator('#qc-remarks').fill('门幅克重及疵点位置核对合格');

        const [passResp] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes(`/api/v2/quality/rolls/${encodeURIComponent(ctx.rollId1)}/inspect-complete`) &&
              r.request().method() === 'POST'
          ),
          passDialog.getByRole('button', { name: '确认放行 (PASSED)' }).click()
        ]);
        assert.equal(passResp.status(), 200, '质检放行 PASSED 应返回 HTTP 200');
        await passDialog.waitFor({ state: 'hidden', timeout: 10000 });

        await page.locator('.mp-insp-head .tag.ok', { hasText: '合格' }).waitFor({ state: 'visible' });
        await page.getByRole('link', { name: '去搭切排料 →' }).waitFor({ state: 'visible' });

        // 回到单据页面办理领料出库 ISSUE
        await page.goto(`${baseUrl}/app/#/documents`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '＋ 车间领/退料' }).click();
        const issueDialog = page.locator('dialog[open]').filter({ hasText: '新建车间领 / 退料单' });
        await issueDialog.waitFor({ state: 'visible', timeout: 10000 });
        await issueDialog.locator('[aria-label="选择领料或退料方向"]').getByRole('button', { name: /ISSUE/ }).click();

        const opt = issueDialog.locator(`#iss-roll option[value="${ctx.rollId1}"]`);
        await opt.waitFor({ state: 'attached', timeout: 10000 });
        assert.equal(await opt.isDisabled(), false, '放行 PASSED 后在领料下拉框中必须可选');

        await issueDialog.locator('#iss-roll').selectOption(ctx.rollId1);
        await issueDialog.locator('#iss-machine').fill('SLIT-01');
        await issueDialog.locator('#iss-shift').fill('甲班');
        await issueDialog.locator('#iss-loc').fill('车间:SLIT-01');
        await issueDialog.locator('#iss-operator').fill('领料员陈工');
        await issueDialog.locator('#iss-reason').fill(`F06放行领料-${tag}`);

        const [issueResp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v2/material-issues') && r.request().method() === 'POST'
          ),
          issueDialog.getByRole('button', { name: '确认发料出库' }).click()
        ]);
        assert.equal(issueResp.status(), 200, '放行后车间领料出库应返回 200');
        await issueDialog.waitFor({ state: 'hidden', timeout: 10000 });

        // 办理车间退料 RETURN 归回库位，确保闭环并恢复在库状态供后续 F07 选卷
        await page.getByRole('button', { name: '＋ 车间领/退料' }).click();
        const returnDialog = page.locator('dialog[open]').filter({ hasText: '新建车间领 / 退料单' });
        await returnDialog.waitFor({ state: 'visible', timeout: 10000 });
        await returnDialog.locator('[aria-label="选择领料或退料方向"]').getByRole('button', { name: /RETURN/ }).click();
        await returnDialog.locator('#iss-roll').selectOption(ctx.rollId1);
        await returnDialog.locator('#iss-loc').fill('原料库位 R-01');
        await returnDialog.locator('#iss-operator').fill('领料员陈工');
        await returnDialog.locator('#iss-reason').fill(`F06退料归位-${tag}`);

        const [retResp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v2/material-issues') && r.request().method() === 'POST'
          ),
          returnDialog.getByRole('button', { name: '确认退料入库' }).click()
        ]);
        assert.equal(retResp.status(), 200, '车间余卷退库应返回 200');
        await returnDialog.waitFor({ state: 'hidden', timeout: 10000 });

        return { rollId1: ctx.rollId1, passedAndIssuedReturned: true };
      }
    );

    await runCheck(
      'F06-T1-04',
      'Tier 1',
      'F06',
      '#/inventory 快速登记母卷并判不合格 FAILED，领料弹窗保持禁领',
      page,
      async () => {
        await page.goto(`${baseUrl}/app/#/inventory`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '库存', exact: true, level: 1 }).waitFor();
        await page.getByRole('button', { name: '＋ 登记母卷' }).click();

        const recDialog = page.locator('dialog[open]').filter({ hasText: '母卷入库登记' });
        await recDialog.waitFor({ state: 'visible', timeout: 10000 });
        await recDialog.locator('#inv-rec-rollid').fill(ctx.rollId2);
        await recDialog.locator('#inv-rec-model').fill(`TC-FAIL-${tag}`);
        await recDialog.locator('#inv-rec-width').fill('1600');
        await recDialog.locator('#inv-rec-len').fill('30');

        const [createResp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v2/inspection/rolls') && r.request().method() === 'POST'
          ),
          recDialog.locator('#act-submit').click()
        ]);
        assert.equal(createResp.status(), 200, '台账快速登记母卷应返回 200');
        await page.waitForFunction(
          (target) => location.hash.includes(encodeURIComponent(target)),
          ctx.rollId2
        );
        await page.locator('#inspect-fail-btn').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#inspect-fail-btn').click();

        const failDialog = page.locator('dialog[open]').filter({ hasText: '确认判定母卷不合格' });
        await failDialog.waitFor({ state: 'visible', timeout: 10000 });
        await failDialog.locator('#qc-inspector').fill('质检李工');
        await failDialog.locator('#qc-remarks').fill('大面积色差及纬斜超标判不合格');

        const [failResp] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().includes(`/api/v2/quality/rolls/${encodeURIComponent(ctx.rollId2)}/inspect-complete`) &&
              r.request().method() === 'POST'
          ),
          failDialog.getByRole('button', { name: '确认判不合格 (FAILED)' }).click()
        ]);
        assert.equal(failResp.status(), 200, '判不合格 FAILED 应返回 200');
        await failDialog.waitFor({ state: 'hidden', timeout: 10000 });
        await page.locator('.mp-insp-head .tag', { hasText: '不合格' }).waitFor({ state: 'visible' });

        // 校验领料下拉框仍禁用该不合格卷
        await page.goto(`${baseUrl}/app/#/documents`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '＋ 车间领/退料' }).click();
        const issueDialog = page.locator('dialog[open]').filter({ hasText: '新建车间领 / 退料单' });
        await issueDialog.waitFor({ state: 'visible', timeout: 10000 });
        await issueDialog.locator('[aria-label="选择领料或退料方向"]').getByRole('button', { name: /ISSUE/ }).click();

        const opt = issueDialog.locator(`#iss-roll option[value="${ctx.rollId2}"]`);
        await opt.waitFor({ state: 'attached', timeout: 10000 });
        assert.equal(await opt.isDisabled(), true, 'FAILED 母卷在领料弹窗中必须禁用');
        const optText = await opt.innerText();
        assert.match(optText, /未验布放行，禁领/);

        await issueDialog.getByRole('button', { name: '取消', exact: true }).click();
        await issueDialog.waitFor({ state: 'hidden', timeout: 10000 });
        return { rollId2: ctx.rollId2, failedBlockedInUi: true };
      }
    );

    await runCheck(
      'F06-T2-04',
      'Tier 2',
      'F06',
      'FAILED 不合格母卷直接调用领料接口返回 409 INVENTORY_CONFLICT',
      page,
      async () => {
        const r = await apiJson(baseUrl, '/api/v2/material-issues', {
          method: 'POST',
          headers: { 'Idempotency-Key': `f06-fail-issue-${tag}` },
          body: JSON.stringify({
            direction: 'ISSUE',
            rollId: ctx.rollId2,
            machineId: '裁床-01',
            operator: '黑盒校验员',
            targetLocation: '车间:裁床-01',
            reason: 'FAILED卷领料拦截校验'
          })
        });
        assert.equal(r.status, 409, `FAILED 卷领料必须返回 409，实际 HTTP ${r.status}`);
        assert.equal(r.data?.code, 'INVENTORY_CONFLICT');
        return { rollId2: ctx.rollId2, status: r.status, code: r.data?.code };
      }
    );

    await runCheck(
      'F06-T2-05',
      'Tier 2',
      'F06',
      '未在机台母卷重复退料拦截 409 与非法料头放行决策返回 400',
      page,
      async () => {
        const dupReturn = await apiJson(baseUrl, '/api/v2/material-issues', {
          method: 'POST',
          headers: { 'Idempotency-Key': `f06-dup-ret-${tag}` },
          body: JSON.stringify({
            direction: 'RETURN',
            rollId: ctx.rollId1,
            operator: '黑盒校验员',
            targetLocation: '原料库位 R-01',
            reason: '未领出母卷非法退料拦截校验'
          })
        });
        assert.equal(dupReturn.status, 409, `未在机台母卷退料应返回 409，实际 HTTP ${dupReturn.status}`);
        assert.equal(dupReturn.data?.code, 'INVENTORY_CONFLICT');

        const badRelease = await apiJson(baseUrl, '/api/v2/quality/remnants/NON_EXISTENT_REM/release', {
          method: 'POST',
          body: JSON.stringify({
            decision: 'INVALID_DECISION',
            inspector: '黑盒校验员',
            reason: '非法决策枚举检验'
          })
        });
        assert.equal(badRelease.status, 400, `非法料头放行决策应返回 400，实际 HTTP ${badRelease.status}`);
        assert.equal(badRelease.data?.code, 'INVALID_INPUT');
        return { dupReturnStatus: dupReturn.status, badReleaseStatus: badRelease.status };
      }
    );

    await runCheck(
      'F06-T1-05',
      'Tier 1',
      'F06',
      '全套出入库与质检流转后总账对账保持 BALANCED（INV-03）',
      page,
      async () => {
        const recon = await apiJson(baseUrl, '/api/v2/inventory-ledger/reconciliation');
        assert.equal(recon.status, 200, '总账对账接口应返回 HTTP 200');
        assert.equal(recon.data?.status, 'BALANCED', `总账必须为 BALANCED，实际: ${JSON.stringify(recon.data)}`);
        assert.ok(
          Array.isArray(recon.data?.issues) && recon.data.issues.length === 0,
          `总账不应存在异常项: ${JSON.stringify(recon.data?.issues)}`
        );
        return {
          status: recon.data?.status,
          revision: recon.data?.revision,
          entryCount: recon.data?.entryCount
        };
      }
    );

    // =========================================================================
    // F07: 1D 线性分条排产、物理约束边界与配方导出闭环（#/slitting）
    // =========================================================================

    await runCheck(
      'F07-T1-01',
      'Tier 1',
      'F07',
      '#/slitting 路由壳层、一维分切激活态与只读零写库校验',
      page,
      async () => {
        const writes = [];
        const listener = (req) => {
          if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method()) && req.url().includes('/api/')) {
            writes.push(`${req.method()} ${req.url()}`);
          }
        };
        page.on('request', listener);
        try {
          await page.goto(`${baseUrl}/app/#/slitting`, { waitUntil: 'networkidle' });
          await page.getByRole('heading', { name: '搭切工作台', exact: true, level: 1 }).waitFor();
          const activeDimText = await page
            .locator('[aria-label="裁切维度"] button[aria-pressed="true"]')
            .innerText();
          assert.match(activeDimText, /一维分切/);
          const activeNavCount = await page.locator('nav [aria-current="page"]').count();
          assert.equal(activeNavCount, 1);
          const activeNavText = await page.locator('nav [aria-current="page"]').innerText();
          assert.match(activeNavText, /搭切工作台/);
          assert.equal(writes.length, 0, `只读进入 #/slitting 不应触发写接口: ${writes.join(', ')}`);
          return { activeDimText, activeNavText };
        } finally {
          page.off('request', listener);
        }
      }
    );

    await runCheck(
      'F07-T1-02',
      'Tier 1',
      'F07',
      '#/slitting 需求弹窗新增 1D 规格明细并加载隔离 SLITTING_1D 需求族',
      page,
      async () => {
        // 先验证 DemandOverviewModal 编辑 1D 规格明细
        await page.locator('.wb-list-toolbar-actions').getByRole('button', { name: '编辑', exact: true }).click();
        const modal = page.locator('dialog[open]').filter({ hasText: '本次具体需求概览' });
        await modal.waitFor({ state: 'visible', timeout: 10000 });
        const rowsBefore = await modal.locator('tbody tr').count();
        await modal.getByRole('button', { name: '＋ 新增一维分条规格' }).click();
        const rowsAfter = await modal.locator('tbody tr').count();
        assert.equal(rowsAfter, rowsBefore + 1, '点击新增一维分条规格应增加 1 行');
        await page.keyboard.press('Escape');
        await modal.waitFor({ state: 'hidden', timeout: 10000 });

        // 创建隔离 SLITTING_1D 需求族并在工作台左侧选定
        const created = await apiJson(baseUrl, '/api/v2/demand-pool', {
          method: 'POST',
          body: JSON.stringify({
            name: `1D分条测试-${tag}`,
            materialModel: materialModel1D,
            dimension: 'SLITTING_1D',
            bedLengthMm: 2000,
            slitting: {
              leftTrimMm: 20,
              rightTrimMm: 20,
              minWidthMm: 100,
              maxWidthMm: 1960,
              widthStepMm: 10,
              totalOverCap: 0
            },
            demands: [
              { id: 1, name: '600宽条', width: 600, length: 2000, quantity: 3, allowRotation: false },
              { id: 2, name: '400宽条', width: 400, length: 2000, quantity: 4, allowRotation: false }
            ]
          })
        });
        assert.equal(created.status, 200, `创建 1D 需求族应返回 200，实际: ${created.text}`);
        ctx.slitTaskId = created.data.id;

        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('[aria-label="裁切维度"] button[aria-pressed="true"]', { hasText: '一维分切' }).waitFor();

        await page.locator('.wb-source-box .seg button', { hasText: /需求族/ }).click();
        const familySelect = page.locator('.wb-source-box select').first();
        await familySelect.locator(`option[value="${ctx.slitTaskId}"]`).waitFor({ state: 'attached', timeout: 10000 });
        await familySelect.selectOption(ctx.slitTaskId);

        const rowCount = await page.locator('.wb-demand-list [role="listitem"]').count();
        assert.equal(rowCount, 2, '加载隔离 1D 需求族后左侧应显示 2 条需求规格');
        return { slitTaskId: ctx.slitTaskId, rowsBefore, rowsAfter, rowCount };
      }
    );

    await runCheck(
      'F07-T1-03',
      'Tier 1',
      'F07',
      '虚拟新卷 VIRTUAL_ROLL 执行 1D 分切求解并渲染条带排刀方案',
      page,
      async () => {
        await page.locator('[aria-label="一维母卷来源"]').getByRole('button', { name: '默认新母卷' }).click();
        const topInputs = page.locator('.studio-canvas-inputs');
        await setNumberInputValue(topInputs.locator('label', { hasText: '母卷幅宽' }).locator('input'), 2000);
        await setNumberInputValue(topInputs.locator('label', { hasText: '定长' }).locator('input'), 2000);

        const paramsCard = page.locator('#wb-slitting-params');
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '左切边' }).locator('input'), 20);
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '右切边' }).locator('input'), 20);

        await page.locator('[aria-label="一维求解档位"]').getByRole('radio', { name: '快捷' }).click();
        await page.locator('[aria-label="一维求解目标"]').getByRole('radio', { name: '最少车数' }).click();

        await page.locator('.studio-right-foot button.studio-solve-btn').click();

        // 等待快捷解卡片收敛为 SUCCEEDED（不再处于 is-running 且出现车数）
        const fastCard = page.locator('.slit-scheme-card', { hasText: '快捷解' });
        await fastCard.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForFunction(
          () => {
            const cards = Array.from(document.querySelectorAll('.slit-scheme-card'));
            const fast = cards.find((c) => c.textContent?.includes('快捷解'));
            return Boolean(fast && !fast.classList.contains('is-running') && fast.textContent?.includes('车'));
          },
          null,
          { timeout: 25000 }
        );
        await fastCard.click();

        const baselineCard = page.locator('.slit-scheme-card', { hasText: '独立分切' });
        await baselineCard.waitFor({ state: 'visible', timeout: 10000 });

        await page.locator('.pane-h', { hasText: '刀组排布' }).waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('.slit-pattern-row').first().waitFor({ state: 'visible', timeout: 10000 });
        const patternRows = await page.locator('.slit-pattern-row').count();
        assert.ok(patternRows >= 1, `虚拟卷 1D 求解应至少渲染 1 条 .slit-pattern-row，实际 ${patternRows}`);
        return { patternRows, cardText: (await fastCard.innerText()).replace(/\s+/g, ' ').slice(0, 80) };
      }
    );

    await runCheck(
      'F07-T2-01',
      'Tier 2',
      'F07',
      'UI 1D 左右切边之和超母卷幅宽前置拦截且不发求解请求',
      page,
      async () => {
        const paramsCard = page.locator('#wb-slitting-params');
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '左切边' }).locator('input'), 1500);
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '右切边' }).locator('input'), 600);

        const jobPosts = [];
        const onReq = (req) => {
          if (req.url().includes('/api/v2/optimization-jobs') && req.method() === 'POST') {
            jobPosts.push(req.url());
          }
        };
        page.on('request', onReq);
        try {
          await page.locator('.studio-right-foot button.studio-solve-btn').click();
          const toast = page.locator('#toast');
          await toast.waitFor({ state: 'visible', timeout: 5000 });
          const toastText = await toast.innerText();
          assert.match(toastText, /扣边后可用幅宽须 > 0 mm|超出/);
          assert.equal(jobPosts.length, 0, '切边越界应被前端拦截，不得发送求解请求');
          return { toastText };
        } finally {
          page.off('request', onReq);
        }
      }
    );

    await runCheck(
      'F07-T2-02',
      'Tier 2',
      'F07',
      'UI 1D 最小物理刀距大于订单宽幅前置拦截且不发求解请求',
      page,
      async () => {
        const paramsCard = page.locator('#wb-slitting-params');
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '左切边' }).locator('input'), 20);
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '右切边' }).locator('input'), 20);
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '最大宽' }).locator('input'), 1960);
        await setNumberInputValue(paramsCard.locator('label.wb-field', { hasText: '最小宽' }).locator('input'), 100);

        const knifeFold = paramsCard.locator('details.wb-param-fold', { hasText: '刀架物理约束' });
        const isOpen = await knifeFold.evaluate((el) => el.hasAttribute('open'));
        if (!isOpen) {
          await knifeFold.locator('summary').click();
        }
        await setNumberInputValue(knifeFold.locator('label.wb-field', { hasText: '最小刀距' }).locator('input'), 9999);

        const jobPosts = [];
        const onReq = (req) => {
          if (req.url().includes('/api/v2/optimization-jobs') && req.method() === 'POST') {
            jobPosts.push(req.url());
          }
        };
        page.on('request', onReq);
        try {
          await page.locator('.studio-right-foot button.studio-solve-btn').click();
          const toast = page.locator('#toast');
          await toast.waitFor({ state: 'visible', timeout: 5000 });
          const toastText = await toast.innerText();
          assert.match(toastText, /小于机台最小物理刀距/);
          assert.equal(jobPosts.length, 0, '最小物理刀距越界应被前端拦截，不得发送求解请求');
          return { toastText };
        } finally {
          page.off('request', onReq);
        }
      }
    );

    await runCheck(
      'F07-T2-03',
      'Tier 2',
      'F07',
      'UI 1D 危险细边丝禁区仅填下限缺上限前置拦截且不发求解请求',
      page,
      async () => {
        const paramsCard = page.locator('#wb-slitting-params');
        const knifeFold = paramsCard.locator('details.wb-param-fold', { hasText: '刀架物理约束' });
        await setNumberInputValue(knifeFold.locator('label.wb-field', { hasText: '最小刀距' }).locator('input'), 0);
        await setNumberInputValue(knifeFold.locator('label.wb-field', { hasText: '禁区边丝下限' }).locator('input'), 10);
        await setNumberInputValue(knifeFold.locator('label.wb-field', { hasText: '禁区边丝上限' }).locator('input'), 0);

        const jobPosts = [];
        const onReq = (req) => {
          if (req.url().includes('/api/v2/optimization-jobs') && req.method() === 'POST') {
            jobPosts.push(req.url());
          }
        };
        page.on('request', onReq);
        try {
          await page.locator('.studio-right-foot button.studio-solve-btn').click();
          const toast = page.locator('#toast');
          await toast.waitFor({ state: 'visible', timeout: 5000 });
          const toastText = await toast.innerText();
          assert.match(toastText, /启用危险细边丝禁区时须填写大于 0 的上限/);
          assert.equal(jobPosts.length, 0, '禁区缺少上限应被前端拦截，不得发送求解请求');
          return { toastText };
        } finally {
          page.off('request', onReq);
          // 重置禁区边丝下限恢复合法态
          await setNumberInputValue(knifeFold.locator('label.wb-field', { hasText: '禁区边丝下限' }).locator('input'), 0);
        }
      }
    );

    await runCheck(
      'F07-T2-04',
      'Tier 2',
      'F07',
      'API 1D 切边超母卷幅宽请求返回 HTTP 400 INVALID_INPUT',
      page,
      async () => {
        const r = await apiJson(baseUrl, '/api/v2/optimization-jobs', {
          method: 'POST',
          body: JSON.stringify(
            buildSlittingApiProblem({
              motherWidthMm: 2000,
              leftTrimMm: 1200,
              rightTrimMm: 900
            })
          )
        });
        assert.equal(r.status, 400, `1D 切边越界应返回 HTTP 400，实际 HTTP ${r.status}: ${r.text}`);
        assert.equal(r.data?.code, 'INVALID_INPUT');
        assert.match(String(r.data?.message || ''), /可用幅宽|切边|母卷幅宽/);
        return { status: r.status, code: r.data?.code, message: r.data?.message };
      }
    );

    await runCheck(
      'F07-T2-05',
      'Tier 2',
      'F07',
      'API 1D 非法物理约束（单边禁区与超产超限）返回 HTTP 400 INVALID_INPUT',
      page,
      async () => {
        const r1 = await apiJson(baseUrl, '/api/v2/optimization-jobs', {
          method: 'POST',
          body: JSON.stringify(
            buildSlittingApiProblem({
              forbiddenNarrowEdgeMinMm: 10
            })
          )
        });
        assert.equal(r1.status, 400, `单边禁区下限应返回 HTTP 400，实际 HTTP ${r1.status}: ${r1.text}`);
        assert.equal(r1.data?.code, 'INVALID_INPUT');
        assert.match(String(r1.data?.message || ''), /禁区|下限|上限/);

        const r2 = await apiJson(baseUrl, '/api/v2/optimization-jobs', {
          method: 'POST',
          body: JSON.stringify(
            buildSlittingApiProblem({
              totalOverCap: 10001
            })
          )
        });
        assert.equal(r2.status, 400, `超产上限 > 10000 应返回 HTTP 400，实际 HTTP ${r2.status}: ${r2.text}`);
        assert.equal(r2.data?.code, 'INVALID_INPUT');
        assert.match(String(r2.data?.message || ''), /超产上限/);
        return {
          singleEdgeStatus: r1.status,
          singleEdgeCode: r1.data?.code,
          overCapStatus: r2.status,
          overCapCode: r2.data?.code
        };
      }
    );

    await runCheck(
      'F07-T1-04',
      'Tier 1',
      'F07',
      '1D 切换实卷（PASSED 含 HOLE 疵点）求解避疵并选定方案落库扣减待排',
      page,
      async () => {
        assert.ok(ctx.rollId1, '前置步骤未生成 rollId1');
        assert.ok(ctx.slitTaskId, '前置步骤未生成 slitTaskId');

        await page.locator('[aria-label="一维母卷来源"]').getByRole('button', { name: /现有母卷/ }).click();
        const switchConfirm = page.locator('dialog[open]').filter({ hasText: '确认一维母卷切换' });
        try {
          await switchConfirm.waitFor({ state: 'visible', timeout: 1500 });
          await switchConfirm.getByRole('button', { name: '确认切换' }).click();
          await switchConfirm.waitFor({ state: 'hidden', timeout: 10000 });
        } catch {}
        const stockInputs = page.locator('.studio-canvas-inputs');
        const rollSelect = stockInputs.locator('label', { hasText: '实卷' }).locator('select');
        await rollSelect.locator(`option[value="${ctx.rollId1}"]`).waitFor({ state: 'attached', timeout: 10000 });
        await rollSelect.selectOption(ctx.rollId1);
        await setNumberInputValue(stockInputs.locator('label', { hasText: '定长' }).locator('input'), 2000);

        await page.locator('.studio-right-foot button.studio-solve-btn').click();
        const fastCard = page.locator('.slit-scheme-card', { hasText: '快捷解' });
        await page.waitForFunction(
          () => {
            const cards = Array.from(document.querySelectorAll('.slit-scheme-card'));
            const fast = cards.find((c) => c.textContent?.includes('快捷解'));
            return Boolean(fast && !fast.classList.contains('is-running') && fast.textContent?.includes('车'));
          },
          null,
          { timeout: 25000 }
        );
        await fastCard.click();

        const [confirmResp] = await Promise.all([
          page.waitForResponse(
            (r) => r.url().includes('/api/v2/schemes/confirm') && r.request().method() === 'POST'
          ),
          page.locator('.value-actions button.value-primary-cta').click()
        ]);
        assert.equal(confirmResp.status(), 200, '选定 1D 分切方案落库应返回 HTTP 200');
        const confirmed = await confirmResp.json();
        ctx.slitSchemeId = confirmed?.scheme?.id || confirmed?.id;

        const banner = page.locator('.wb-confirm-banner');
        await banner.waitFor({ state: 'visible', timeout: 10000 });
        const bannerText = await banner.innerText();
        assert.match(bannerText, /已落库/);

        if (!ctx.slitSchemeId) {
          const href = await banner.getByRole('link', { name: '查看结果' }).getAttribute('href');
          ctx.slitSchemeId = decodeURIComponent(String(href || '').split('/results/')[1] || '');
        }
        assert.ok(ctx.slitSchemeId, '应获取确认落库的 schemeId');

        // 交叉核对需求池任务扣减 openTotal -> plannedTotal
        const poolRes = await apiJson(baseUrl, '/api/v2/demand-pool');
        assert.equal(poolRes.status, 200);
        const task = (poolRes.data || []).find((t) => t.id === ctx.slitTaskId);
        assert.ok(task, '应能查询到 1D 测试任务');
        assert.equal(task.openTotal, 0, `确认方案后 openTotal 应归零，实际 ${task.openTotal}`);
        assert.ok(task.plannedTotal > 0, `确认方案后 plannedTotal 应大于 0，实际 ${task.plannedTotal}`);

        return {
          rollId1: ctx.rollId1,
          slitSchemeId: ctx.slitSchemeId,
          openTotal: task.openTotal,
          plannedTotal: task.plannedTotal
        };
      }
    );

    await runCheck(
      'F07-T1-05',
      'Tier 1',
      'F07',
      '#/results/<schemeId> 导出分切机排刀配方 CSV 并校验表头与排刀数据行',
      page,
      async () => {
        assert.ok(ctx.slitSchemeId, '前置步骤未生成 slitSchemeId');
        await page.locator('.wb-confirm-banner').getByRole('link', { name: '查看结果' }).click();
        await page.waitForFunction(
          (sid) => location.hash.includes(`#/results/${encodeURIComponent(sid)}`) || location.hash.includes(sid),
          ctx.slitSchemeId
        );

        const exportBtn = page.getByRole('button', { name: '导出分切机排刀配方 (.csv)' });
        await exportBtn.waitFor({ state: 'visible', timeout: 10000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          exportBtn.click()
        ]);
        const suggestedFilename = download.suggestedFilename();
        assert.match(suggestedFilename, /^分切机PLC排刀配方-.*\.csv$/);

        const tempCsv = await download.path();
        assert.ok(tempCsv, '下载的 CSV 临时文件路径应存在');
        const rawBuf = fs.readFileSync(tempCsv);
        // UTF-8 BOM: EF BB BF
        assert.equal(rawBuf[0], 0xef);
        assert.equal(rawBuf[1], 0xbb);
        assert.equal(rawBuf[2], 0xbf);

        const csvText = rawBuf.toString('utf8');
        const rows = parseCsvFirstRow(csvText);
        assert.ok(rows.length >= 2, `CSV 应至少包含表头与 1 行配方数据，实际 ${rows.length} 行`);
        assert.deepEqual(rows[0], [
          '方案号',
          '刀组序号',
          '单车卷长(mm)',
          '执行车数',
          '左切边(mm)',
          '右切边(mm)',
          '排刀条宽组合',
          '已用幅宽(mm)',
          '余宽(mm)'
        ]);
        assert.equal(rows[1][0], ctx.slitSchemeId, '数据行方案号应与落库 schemeId 一致');
        assert.match(rows[1][6], /\d+\*\d+/, '排刀条宽组合应包含 width*count 格式');
        return {
          suggestedFilename,
          rowCount: rows.length,
          firstDataRow: rows[1]
        };
      }
    );
  } finally {
    await browser.close();
  }

  assert.equal(pageErrors.length, 0, `页面存在未捕获脚本异常: ${pageErrors.join(' | ')}`);
  assert.equal(nativeDialogs.length, 0, `页面触发原生弹窗: ${nativeDialogs.join(' | ')}`);

  const prodStateSha256After = sha256File(PROD_STATE_FILE);
  const prodDraftsAfter = fingerprintDir(PROD_DRAFTS_DIR);
  const prodInventoryUntouched = prodStateSha256After === prodStateSha256Before;
  const prodDraftsUntouched = prodDraftsAfter === prodDraftsBefore;

  const passedCount = checks.filter((c) => c.status === 'PASS').length;
  const failedCount = checks.filter((c) => c.status === 'FAIL').length;

  const summary = {
    script: 'inspection-and-slitting',
    baseUrl,
    executed: checks.length,
    passed: passedCount,
    failed: failedCount,
    skipped: 0,
    pageErrorsCount: pageErrors.length,
    nativeDialogsCount: nativeDialogs.length,
    prodInventoryUntouched,
    prodDraftsUntouched,
    prodStateSha256Before,
    prodStateSha256After,
    checks
  };

  if (resultFile) {
    fs.mkdirSync(path.dirname(path.resolve(resultFile)), { recursive: true });
    fs.writeFileSync(path.resolve(resultFile), JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));

  if (failedCount > 0 || !prodInventoryUntouched || !prodDraftsUntouched) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[verify-inspection-and-slitting] 未捕获异常: ${err?.stack || err}`);
  process.exit(1);
});
