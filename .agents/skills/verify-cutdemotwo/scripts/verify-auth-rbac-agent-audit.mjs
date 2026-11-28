#!/usr/bin/env node
/**
 * E2E-M3 路线 B（F10 认证/用户管理 + F11 RBAC/Agent/审计 + F12 热冷数据分离与 -Xmx256m）真机端到端黑盒验收脚本。
 *
 * 覆盖全部 35 项真实黑盒校验（skipped = 0）：
 *  - F10（5 正 + 5 负）：#/login 重定向与开放重定向防御、#/profile 信息与自主改密、#/users 新建/编辑/重置/启停、
 *    401 统一防枚举、改密校验拦截、登出/改密/禁用后旧 Token 立即 401、最后 ADMIN 防禁用 409、非 ADMIN 403 双层拦截；
 *  - F11（5 正 + 5 负）：5 角色各自职责写放行、#/users 签发受限 Agent 凭证（[data-testid="agent-once-token"]）、
 *    受限 Agent REST + 真实 MCP stdio 通道读写/草案生成、Bearer SSE 200 text/event-stream、#/audit-logs 多维检索与脱敏详情、
 *    无/篡改 Token 401、4 角色跨职能越权 + 矩阵参数/编码路径绕过 403、Agent 越权确认/建单/出入库/质检/用户管理 REST+MCP 403、
 *    吊销 Agent 后 REST/SSE/MCP 立即 401、普通角色直访 #/audit-logs 403 与 ACCESS_DENIED 审计留痕；
 *  - F12（5 正 + 5 负）：独立临时目录 + 动态空闲端口构造批量历史单据与 >=2,500 条审计记录后以 -Xms64m -Xmx256m -XX:+ExitOnOutOfMemoryError
 *    冷启动就绪 <=30s、总账 BALANCED、多页低延迟遍历、12 路并发读写无 OOM、/actuator/prometheus 核实堆上限 <= 268435456、
 *    恶意 size/limit=100000 截断/400、高页码/高偏移/负游标边界、空筛选 UI/API、非 ADMIN/未登录访问 /actuator/prometheus 403/401、
 *    优雅重启前后持久化与 BALANCED 一致性；
 *  - Tier 3（4 组）：T3-F10×F11-01、T3-F11×F08-01、T3-F12×F11-01、T3-F10×F02-01（12 vs 14 导航数）。
 *
 * 严禁连接正式 8080 端口或修改正式 data/cutdemo-state.json。
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROD_STATE_FILE = path.join(REPO_ROOT, 'data', 'cutdemo-state.json');
const PROD_DRAFTS_DIR = path.join(REPO_ROOT, 'data', 'cutdemo-state.json.drafts');
const DEFAULT_JAR = path.join(REPO_ROOT, 'target', 'CutDemoTwo-0.0.1-SNAPSHOT.jar');
const MCP_INDEX_PATH = path.join(REPO_ROOT, 'integrations', 'mcp', 'src', 'index.mjs');
const MCP_CLIENT_PKG = path.join(
  REPO_ROOT,
  'integrations',
  'mcp',
  'node_modules',
  '@modelcontextprotocol',
  'client',
  'dist'
);
const FIXTURE_JSON = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'mcp', 'test', 'fixture.json'), 'utf8')
);
const require = createRequire(import.meta.url);

function parseCliArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      out[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function validateBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    throw new Error('必须提供非 8080 隔离实例 --base-url 或环境变量 BASE_URL');
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
    throw new Error(`严禁连接默认或正式 8080 端口: ${trimmed}`);
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

function resolvePlaywrightPath() {
  if (process.env.PLAYWRIGHT_MODULE) return process.env.PLAYWRIGHT_MODULE;
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
  return undefined;
}

async function apiJsonOn(targetBaseUrl, reqPath, init = {}, token = null) {
  const method = (init.method || 'GET').toUpperCase();
  const autoIdem =
    method === 'POST' &&
    (reqPath.includes('/api/v2/optimization-jobs') ||
      reqPath.includes('/api/v2/inventory-receipts') ||
      reqPath.includes('/api/v2/workbench/multi-material-drafts') ||
      reqPath.includes('/api/v2/schemes/confirm'))
      ? { 'Idempotency-Key': `e2e-m3-${randomUUID().slice(0, 12)}` }
      : {};
  const headers = {
    Accept: 'application/json',
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...autoIdem,
    ...(init.headers || {})
  };
  const res = await fetch(`${targetBaseUrl}${reqPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data, raw: text };
}

async function loginAs(targetBaseUrl, username, password) {
  const res = await apiJsonOn(targetBaseUrl, '/api/v2/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
  assert.equal(res.status, 200, `登录 ${username} 必须成功: ${res.raw}`);
  assert.ok(res.data?.token, `登录 ${username} 未返回 token`);
  return res.data;
}

async function waitJobSucceeded(targetBaseUrl, jobId, token) {
  for (let i = 0; i < 120; i += 1) {
    const r = await apiJsonOn(targetBaseUrl, `/api/v2/optimization-jobs/${encodeURIComponent(jobId)}`, {}, token);
    if (r.ok && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.data?.state)) {
      return r.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`作业超时未完成: ${jobId}`);
}

function isPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function killPidTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isPidAlive(pid)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

async function findFreeLoopbackPort(forbiddenSet) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const chosen = typeof addr === 'object' && addr ? addr.port : 0;
        server.close((err) => (err ? reject(err) : resolve(chosen)));
      });
    });
    if (port > 1024 && !forbiddenSet.has(port)) {
      return port;
    }
  }
  throw new Error('未能探测到可用的非冲突回环端口');
}

async function startIsolatedJava({ jarPath, port, statePath, logFile, jvmOpts = [], extraArgs = [] }) {
  const javaArgs = [
    ...jvmOpts,
    '-jar',
    jarPath,
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    `--cutdemo.state.path=${statePath}`,
    `--cutdemo.jobs.path=${statePath}.jobs`,
    `--cutdemo.integration.path=${statePath}.integrations`,
    `--cutdemo.workbench.drafts.path=${statePath}.drafts`,
    '--cutdemo.seed-demo-data=true',
    '--cutdemo.auth.enabled=true',
    '--cutdemo.auth.secret=verify-f12-isolated-secret-32bytes-min',
    ...extraArgs
  ];
  const outFd = fs.openSync(logFile, 'w');
  const startMs = Date.now();
  let child;
  try {
    child = spawn('java', javaArgs, {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(outFd);
  }
  child.unref();

  const childBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = startMs + 45000;
  let readyMs = 0;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
      throw new Error(`F12 隔离进程提前退出（pid=${child.pid}）。日志尾部:\n${tail}`);
    }
    try {
      const [healthRes, meRes] = await Promise.all([
        fetch(`${childBaseUrl}/api/health`),
        fetch(`${childBaseUrl}/api/v2/auth/me`)
      ]);
      if (healthRes.ok && meRes.ok) {
        const health = await healthRes.json();
        const me = await meRes.json();
        if (health?.status === 'UP' && health?.storageStatus === 'UP' && me?.enabled === true) {
          readyMs = Date.now() - startMs;
          return { pid: child.pid, baseUrl: childBaseUrl, readyMs };
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
  killPidTree(child.pid);
  throw new Error(`F12 隔离进程 45s 内未就绪。日志尾部:\n${tail}`);
}

async function stopIsolatedJava(pid) {
  if (!pid) return;
  killPidTree(pid);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

function parsePrometheusHeapBytes(promText) {
  let maxSum = 0;
  let usedSum = 0;
  for (const line of String(promText || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('jvm_memory_max_bytes{') && line.includes('area="heap"')) {
      const val = Number(line.trim().split(/\s+/).pop());
      if (Number.isFinite(val) && val > 0) maxSum += val;
    } else if (line.startsWith('jvm_memory_used_bytes{') && line.includes('area="heap"')) {
      const val = Number(line.trim().split(/\s+/).pop());
      if (Number.isFinite(val) && val >= 0) usedSum += val;
    }
  }
  return { maxSum, usedSum };
}

const cli = parseCliArgs(process.argv.slice(2));
const baseUrl = validateBaseUrl(cli['base-url'] || process.env.BASE_URL);
const resultFile = String(cli['result-file'] || process.env.RESULT_FILE || '').trim();
const authAdminUser = String(process.env.AUTH_ADMIN_USER || 'admin').trim();
const authAdminPass = String(process.env.AUTH_ADMIN_PASS || 'admin123');
const jarPath = path.resolve(process.env.JAR_PATH || DEFAULT_JAR);

if (!fs.existsSync(jarPath)) {
  throw new Error(`未找到用于 F12 冷启动校验的可执行 JAR: ${jarPath}`);
}

const prodStateBefore = sha256File(PROD_STATE_FILE);
const prodDraftsBefore = fingerprintDir(PROD_DRAFTS_DIR);

const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(path.join(MCP_CLIENT_PKG, 'index.mjs')).href),
  import(pathToFileURL(path.join(MCP_CLIENT_PKG, 'stdio.mjs')).href)
]);
const { chromium } = require(resolvePlaywrightPath());
const executablePath = resolveBrowserExecutable();

const checks = [];
const pageErrors = [];
const nativeDialogs = [];
const contextsToClose = [];
const mcpClientsToClose = [];

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

async function createTrackedContext(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contextsToClose.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => {
    nativeDialogs.push(d.message());
    await d.dismiss();
  });
  return { ctx, page };
}

async function loginInBrowser(page, targetBaseUrl, username, password, initialPath = '/app/#/login') {
  await page.goto(`${targetBaseUrl}${initialPath}`, { waitUntil: 'networkidle' });
  const hasExistingSession = await page.evaluate(() => Boolean(localStorage.getItem('cutplan.auth.token')));
  const hasLoginInput = (await page.locator('#login-username').count()) > 0;
  if (hasExistingSession || !hasLoginInput) {
    await page.evaluate(() => localStorage.removeItem('cutplan.auth.token'));
    await page.reload({ waitUntil: 'networkidle' });
  }
  await page.locator('#login-username').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: '登录并进入系统', exact: true }).click();
  await page.locator('[data-testid="account-menu-trigger"]').waitFor({ state: 'visible', timeout: 15000 });
}

async function openMcpClient(targetBaseUrl, agentToken) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_INDEX_PATH],
    stderr: 'pipe',
    env: {
      CUTTING_API_URL: targetBaseUrl,
      CUTTING_AGENT_TOKEN: agentToken,
      CUTTING_MCP_COMPUTE: 'true',
      CUTTING_MCP_BUSINESS_READ: 'true',
      CUTTING_MCP_ALLOW_DRAFT_SCHEME: 'true',
      CUTTING_MCP_ALLOW_DEMAND_WRITE: 'true'
    }
  });
  const client = new Client({ name: 'm3-auth-rbac-verifier', version: '1.0.0' });
  await client.connect(transport);
  mcpClientsToClose.push({ client, transport });
  return { client, transport };
}

const tag = randomUUID().slice(0, 8).toLowerCase();
const tagUpper = tag.toUpperCase();
const apiJson = (reqPath, init = {}, token = null) => apiJsonOn(baseUrl, reqPath, init, token);

// 前置强校验：严禁免登假绿
const preMe = await apiJson('/api/v2/auth/me');
assert.equal(preMe.status, 200, `/api/v2/auth/me 不可用: ${preMe.raw}`);
assert.equal(preMe.data?.enabled, true, `必须开启 --auth 才可执行本脚本（当前 enabled=${preMe.data?.enabled}）`);

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {})
});

let failedError = null;
let failureScreenshot = null;
let f12ChildPid = null;
let f12TmpDir = null;

try {
  const { page: adminPage } = await createTrackedContext(browser);
  const { page: userPage } = await createTrackedContext(browser);
  const { page: plannerPage } = await createTrackedContext(browser);
  const { page: operatorPage } = await createTrackedContext(browser);

  const testUser = `e2e_user_${tag}`;
  const adminSession = await loginAs(baseUrl, authAdminUser, authAdminPass);
  const adminToken = adminSession.token;

  // ==================== Tier 1: F10 (5 项) ====================
  await runCheck('T1-F10-01', 'Tier1', 'F10', async () => {
    await adminPage.goto(`${baseUrl}/app/#/results`, { waitUntil: 'networkidle' });
    await adminPage.waitForFunction(() => window.location.hash.startsWith('#/login'), null, { timeout: 15000 });
    const redirectHash = await adminPage.evaluate(() => window.location.hash);
    assert.ok(
      redirectHash.includes('redirect=%23%2Fresults'),
      `未登录访问 #/results 应跳转带 redirect，实际: ${redirectHash}`
    );
    assert.equal(await adminPage.locator('nav').count(), 0, '#/login 不得渲染侧栏 nav');

    // 验证开放重定向清洗
    await adminPage.goto(`${baseUrl}/app/#/login?redirect=${encodeURIComponent('https://evil.example')}`, {
      waitUntil: 'networkidle'
    });
    await adminPage.getByText('登录成功后将自动跳转：#/workbench').waitFor({ state: 'visible', timeout: 10000 });

    // 回到带有效 redirect 的登录页并登录
    await adminPage.goto(`${baseUrl}/app/#/login?redirect=${encodeURIComponent('#/results')}`, {
      waitUntil: 'networkidle'
    });
    await adminPage.locator('#login-username').fill(authAdminUser);
    await adminPage.locator('#login-password').fill(authAdminPass);
    await adminPage.getByRole('button', { name: '登录并进入系统', exact: true }).click();

    await adminPage.waitForFunction(() => window.location.hash === '#/results', null, { timeout: 15000 });
    await adminPage.getByRole('heading', { name: '结果管理', level: 1 }).waitFor({ state: 'visible', timeout: 15000 });
    await adminPage.locator('[data-testid="account-menu-trigger"]').waitFor({ state: 'visible', timeout: 10000 });
    const navGroups = await adminPage.locator('nav .nav-group').count();
    const navItems = await adminPage.locator('nav .nav-main a[href^="#/"]').count();
    assert.equal(navGroups, 6, `ADMIN 侧栏应有 6 组导航，实际: ${navGroups}`);
    assert.equal(navItems, 14, `ADMIN 侧栏应有 14 项导航，实际: ${navItems}`);
    return { redirectHash, navGroups, navItems };
  });

  await runCheck('T1-F10-02', 'Tier1', 'F10', async () => {
    await adminPage.locator('[data-testid="account-menu-trigger"]').click();
    await adminPage.locator('[data-testid="account-open-profile"]').click();
    await adminPage.waitForFunction(() => window.location.hash === '#/profile', null, { timeout: 10000 });
    await adminPage.getByRole('heading', { name: '个人中心', exact: true, level: 1 }).waitFor({
      state: 'visible',
      timeout: 10000
    });
    const infoCard = adminPage.locator('section[aria-labelledby="profile-info-title"]');
    await infoCard.waitFor({ state: 'visible', timeout: 10000 });
    const text = await infoCard.innerText();
    assert.ok(text.includes(authAdminUser), '个人中心应展示用户名');
    assert.ok(text.includes('USER（人工操作员）'), '个人中心应展示主体类型');
    assert.ok(text.includes('系统管理员') && text.includes('ADMIN'), '个人中心应展示角色摘要');
    assert.ok(!text.includes('无过期限制'), '企业认证下应展示具体令牌过期时间');
    await adminPage.getByRole('button', { name: '关闭个人中心', exact: true }).click();
    await adminPage.waitForFunction(() => window.location.hash === '#/results', null, { timeout: 10000 });
    return { profileVerified: true };
  });

  await runCheck('T1-F10-03', 'Tier1', 'F10', async () => {
    await adminPage.locator('nav .nav-main a[href="#/users"]').click();
    await adminPage.waitForFunction(() => window.location.hash === '#/users', null, { timeout: 10000 });
    await adminPage.getByRole('heading', { name: '用户与 AI Agent 管理', exact: true, level: 1 }).waitFor({
      state: 'visible',
      timeout: 10000
    });

    await adminPage.getByRole('button', { name: '+ 新建操作员', exact: true }).click();
    const dlg = adminPage.locator('dialog[open]').filter({ hasText: '新建操作员账户' });
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    await dlg.locator('#create-user-name').fill(testUser);
    await dlg.locator('#create-user-display').fill('E2E测试员');
    await dlg.locator('#create-user-role').selectOption('INSPECTOR');
    await dlg.locator('#create-user-pwd').fill('InitPass#1');
    await dlg.getByRole('button', { name: '创建用户', exact: true }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 10000 });

    const row = adminPage.locator('tbody tr').filter({ hasText: testUser });
    await row.waitFor({ state: 'visible', timeout: 10000 });
    const rowText = await row.innerText();
    assert.ok(rowText.includes('启用中') && rowText.includes('INSPECTOR'), `新用户行内容异常: ${rowText}`);

    const loginCheck = await loginAs(baseUrl, testUser, 'InitPass#1');
    assert.equal(loginCheck.role, 'INSPECTOR');
    return { testUser, role: loginCheck.role };
  });

  await runCheck('T1-F10-04', 'Tier1', 'F10', async () => {
    await loginInBrowser(userPage, baseUrl, testUser, 'InitPass#1');
    await userPage.locator('[data-testid="account-menu-trigger"]').click();
    await userPage.locator('[data-testid="account-open-profile"]').click();
    await userPage.waitForFunction(() => window.location.hash === '#/profile', null, { timeout: 10000 });

    await userPage.locator('#profile-cur-pwd').fill('InitPass#1');
    await userPage.locator('#profile-new-pwd').fill('NewPass#2');
    await userPage.locator('#profile-confirm-pwd').fill('NewPass#2');
    await userPage.getByRole('button', { name: '确认修改密码并重登', exact: true }).click();

    await userPage.waitForFunction(() => window.location.hash.startsWith('#/login'), null, { timeout: 15000 });
    const tokenInStorage = await userPage.evaluate(() => localStorage.getItem('cutplan.auth.token'));
    assert.equal(tokenInStorage, null, '改密重登后本地 token 必须被清空');
    await userPage.getByText('您已退出当前企业账号，请重新登录').waitFor({ state: 'visible', timeout: 10000 });

    await userPage.locator('#login-username').fill(testUser);
    await userPage.locator('#login-password').fill('NewPass#2');
    await userPage.getByRole('button', { name: '登录并进入系统', exact: true }).click();
    await userPage.locator('[data-testid="account-menu-trigger"]').waitFor({ state: 'visible', timeout: 15000 });
    return { passwordChangedAndRelogged: true };
  });

  await runCheck('T1-F10-05', 'Tier1', 'F10', async () => {
    const row = adminPage.locator('tbody tr').filter({ hasText: testUser });
    const beforeRowText = await row.innerText();
    const beforeVerMatch = beforeRowText.match(/\bv(\d+)\b/);
    const beforeVer = beforeVerMatch ? Number(beforeVerMatch[1]) : 1;

    await row.getByRole('button', { name: '编辑', exact: true }).click();
    const editDlg = adminPage.locator('dialog[open]').filter({ hasText: `编辑账户：${testUser}` });
    await editDlg.waitFor({ state: 'visible', timeout: 10000 });
    await editDlg.locator('#edit-user-display').fill('E2E操作员');
    await editDlg.locator('#edit-user-role').selectOption('OPERATOR');
    await editDlg.getByRole('button', { name: '保存变更', exact: true }).click();
    await editDlg.waitFor({ state: 'hidden', timeout: 10000 });

    await row.getByRole('button', { name: '重置密码', exact: true }).click();
    const resetDlg = adminPage.locator('dialog[open]').filter({ hasText: `重置密码：${testUser}` });
    await resetDlg.waitFor({ state: 'visible', timeout: 10000 });
    await resetDlg.locator('#reset-user-pwd').fill('ResetPass#3');
    await resetDlg.getByRole('button', { name: '确认重置密码', exact: true }).click();
    await resetDlg.waitFor({ state: 'hidden', timeout: 10000 });

    const afterRowText = await row.innerText();
    const afterVerMatch = afterRowText.match(/\bv(\d+)\b/);
    const afterVer = afterVerMatch ? Number(afterVerMatch[1]) : 0;
    assert.ok(afterRowText.includes('OPERATOR') && afterRowText.includes('E2E操作员'), `编辑未生效: ${afterRowText}`);
    assert.ok(afterVer > beforeVer, `tokenVersion 应递增: ${beforeVer} -> ${afterVer}`);

    const newLogin = await loginAs(baseUrl, testUser, 'ResetPass#3');
    assert.equal(newLogin.role, 'OPERATOR');
    const oldLogin = await apiJson('/api/v2/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: testUser, password: 'NewPass#2' })
    });
    assert.equal(oldLogin.status, 401, '重置后旧密码必须返回 401');
    return { beforeVer, afterVer, newRole: newLogin.role };
  });

  // ==================== Tier 2: F10 (5 项) ====================
  await runCheck('T2-F10-01', 'Tier2', 'F10', async () => {
    const { ctx: anonCtx, page: anonPage } = await createTrackedContext(browser);
    try {
      await anonPage.goto(`${baseUrl}/app/#/login`, { waitUntil: 'networkidle' });
      await anonPage.locator('#login-username').fill(authAdminUser);
      await anonPage.locator('#login-password').fill('WrongPass999');
      const [r1] = await Promise.all([
        anonPage.waitForResponse((r) => r.url().includes('/api/v2/auth/login') && r.request().method() === 'POST'),
        anonPage.getByRole('button', { name: '登录并进入系统', exact: true }).click()
      ]);
      assert.equal(r1.status(), 401);
      const alert1 = anonPage.locator('div.sec-feedback.is-err[role="alert"]');
      await alert1.waitFor({ state: 'visible', timeout: 10000 });
      const msg1 = await alert1.innerText();

      await anonPage.locator('#login-username').fill(`no_such_user_${tag}`);
      await anonPage.locator('#login-password').fill('WrongPass999');
      const [r2] = await Promise.all([
        anonPage.waitForResponse((r) => r.url().includes('/api/v2/auth/login') && r.request().method() === 'POST'),
        anonPage.getByRole('button', { name: '登录并进入系统', exact: true }).click()
      ]);
      assert.equal(r2.status(), 401);
      const msg2 = await alert1.innerText();
      assert.equal(msg1, msg2, '错密码与不存在账号错误提示必须一致，严禁用户枚举泄露');
      return { status: 401, unifiedMessage: msg1 };
    } finally {
      await anonCtx.close();
    }
  });

  await runCheck('T2-F10-02', 'Tier2', 'F10', async () => {
    // userPage 此前的令牌因管理员重置密码已失效，需用新密码重登进入 #/profile
    await loginInBrowser(userPage, baseUrl, testUser, 'ResetPass#3');
    await userPage.goto(`${baseUrl}/app/#/profile`, { waitUntil: 'networkidle' });
    await userPage.locator('#profile-cur-pwd').waitFor({ state: 'visible', timeout: 10000 });

    // 1) 短密码拦截（HTML5 minLength=6）
    await userPage.locator('#profile-cur-pwd').fill('ResetPass#3');
    await userPage.locator('#profile-new-pwd').fill('123');
    await userPage.locator('#profile-confirm-pwd').fill('123');
    const tooShort = await userPage.locator('#profile-new-pwd').evaluate((el) => el.validity.tooShort);
    assert.equal(tooShort, true, '低于 6 位的新密码应触发 tooShort 拦截');

    // 2) 两次密码不一致前端拦截（不发请求）
    let pwdPutCount = 0;
    const reqListener = (req) => {
      if (req.url().includes('/api/v2/auth/password') && req.method() === 'PUT') {
        pwdPutCount += 1;
      }
    };
    userPage.on('request', reqListener);
    try {
      await userPage.locator('#profile-new-pwd').fill('ValidPass#1');
      await userPage.locator('#profile-confirm-pwd').fill('ValidPass#2');
      await userPage.getByRole('button', { name: '确认修改密码并重登', exact: true }).click();
      const alertBox = userPage.locator('div.sec-feedback.is-err[role="alert"]');
      await alertBox.waitFor({ state: 'visible', timeout: 5000 });
      assert.ok((await alertBox.innerText()).includes('不一致'));
      assert.equal(pwdPutCount, 0, '两次不一致时不得发出 PUT 请求');
    } finally {
      userPage.off('request', reqListener);
    }

    // 3) 旧密码错误服务端返回 400
    await userPage.locator('#profile-cur-pwd').fill('WrongOld1');
    await userPage.locator('#profile-new-pwd').fill('ValidPass#9');
    await userPage.locator('#profile-confirm-pwd').fill('ValidPass#9');
    const [badResp] = await Promise.all([
      userPage.waitForResponse((r) => r.url().includes('/api/v2/auth/password') && r.request().method() === 'PUT'),
      userPage.getByRole('button', { name: '确认修改密码并重登', exact: true }).click()
    ]);
    assert.equal(badResp.status(), 400, '旧密码错误应返回 400');
    const errText = await userPage.locator('div.sec-feedback.is-err[role="alert"]').innerText();
    assert.ok(errText.length > 0);
    return { tooShortBlocked: true, mismatchBlocked: true, wrongOldStatus: badResp.status() };
  });

  await runCheck('T2-F10-03', 'Tier2', 'F10', async () => {
    const tokA = (await loginAs(baseUrl, testUser, 'ResetPass#3')).token;
    const logoutRes = await apiJson('/api/v2/auth/logout', { method: 'POST' }, tokA);
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.data?.revoked, true);
    const afterLogout = await apiJson('/api/v2/rolls', {}, tokA);
    assert.equal(afterLogout.status, 401, '主动登出后原 Token 必须立即 401');

    const tokB = (await loginAs(baseUrl, testUser, 'ResetPass#3')).token;
    const chgRes = await apiJson(
      '/api/v2/auth/password',
      {
        method: 'PUT',
        body: JSON.stringify({ currentPassword: 'ResetPass#3', newPassword: 'TempPass#4' })
      },
      tokB
    );
    assert.equal(chgRes.status, 200);
    assert.equal(chgRes.data?.updated, true);
    const afterPwdChange = await apiJson('/api/v2/rolls', {}, tokB);
    assert.equal(afterPwdChange.status, 401, '改密后原 Token 必须立即 401');

    // 验证 userPage 当前携带的旧 token 在触发业务请求时触发前端 401 拦截器跳转 #/login
    await userPage.goto(`${baseUrl}/app/#/inventory`, { waitUntil: 'networkidle' });
    await userPage.waitForFunction(() => window.location.hash.startsWith('#/login'), null, { timeout: 15000 });
    const cleared = await userPage.evaluate(() => localStorage.getItem('cutplan.auth.token'));
    assert.equal(cleared, null, '前端拦截 401 后必须清空本地 Token');
    return { logoutRevoked401: true, pwdChangeRevoked401: true, uiInterceptorRedirected: true };
  });

  await runCheck('T2-F10-04', 'Tier2', 'F10', async () => {
    const tokC = (await loginAs(baseUrl, testUser, 'TempPass#4')).token;
    const row = adminPage.locator('tbody tr').filter({ hasText: testUser });
    await row.getByRole('button', { name: '禁用', exact: true }).click();
    await row.locator('.tag.err', { hasText: '已禁用' }).waitFor({ state: 'visible', timeout: 10000 });

    const afterDisable = await apiJson('/api/v2/rolls', {}, tokC);
    assert.equal(afterDisable.status, 401, '禁用账号后存量 Token 必须立即 401');

    const loginDisabled = await apiJson('/api/v2/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: testUser, password: 'TempPass#4' })
    });
    assert.equal(loginDisabled.status, 401, '已禁用账号再次登录必须返回 401');

    const disableLastAdmin = await apiJson(
      `/api/v2/users/${encodeURIComponent(authAdminUser)}/status`,
      { method: 'POST', body: JSON.stringify({ enabled: false }) },
      adminToken
    );
    assert.equal(disableLastAdmin.status, 409, `禁止禁用最后一个活跃管理员: ${disableLastAdmin.raw}`);
    return { tokenInvalidated401: true, disabledLogin401: true, lastAdminConflict409: true };
  });

  await runCheck('T2-F10-05', 'Tier2', 'F10', async () => {
    await loginInBrowser(plannerPage, baseUrl, 'planner', 'planner123');
    const navLinks = await plannerPage.locator('nav .nav-main a[href^="#/"]').count();
    assert.equal(await plannerPage.locator('nav .nav-main a[href="#/users"]').count(), 0);
    assert.equal(await plannerPage.locator('nav .nav-main a[href="#/audit-logs"]').count(), 0);
    assert.equal(navLinks, 13, `PLANNER 导航链接应为 13 项，实际: ${navLinks}`);

    await plannerPage.goto(`${baseUrl}/app/#/users`, { waitUntil: 'networkidle' });
    const forbidden = plannerPage.locator('section.sec-forbidden-card[role="alert"]');
    await forbidden.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await forbidden.innerText()).includes('403 权限不足'));

    const plannerTok = (await loginAs(baseUrl, 'planner', 'planner123')).token;
    const rGet = await apiJson('/api/v2/users', {}, plannerTok);
    const rPost = await apiJson(
      '/api/v2/users',
      { method: 'POST', body: JSON.stringify({ username: 'x', role: 'OPERATOR', password: 'Password1' }) },
      plannerTok
    );
    assert.equal(rGet.status, 403);
    assert.equal(rPost.status, 403);
    return { navLinks, uiForbidden403: true, apiGet403: true, apiPost403: true };
  });

  // ==================== Tier 1: F11 (5 项) ====================
  const plannerToken = (await loginAs(baseUrl, 'planner', 'planner123')).token;
  const operatorToken = (await loginAs(baseUrl, 'operator', 'operator123')).token;
  const inspectorToken = (await loginAs(baseUrl, 'inspector', 'inspector123')).token;
  const warehouseToken = (await loginAs(baseUrl, 'warehouse', 'warehouse123')).token;

  const rollRbacId = `M3-RBAC-ROLL-${tagUpper}`;
  const modelRbac = `MOD-M3-RBAC-${tagUpper}`;
  let taskRbacId = null;
  let resultRbacId = null;
  let draftRbacId = null;
  let schemeRbacId = null;

  await runCheck('T1-F11-01', 'Tier1', 'F11', async () => {
    // 1) WAREHOUSE 采购入库待检卷
    const receiptRes = await apiJson(
      '/api/v2/inventory-receipts',
      {
        method: 'POST',
        body: JSON.stringify({
          supplierName: 'M3-RBAC供应商',
          deliveryNoteNo: `DN-RBAC-${tagUpper}`,
          operator: 'warehouse',
          remarks: 'RBAC 仓管放行验证',
          rolls: [
            {
              id: rollRbacId,
              materialModel: modelRbac,
              materialType: 'CANVAS',
              color: '本白',
              batchNo: `B-${tagUpper}`,
              widthMm: 1600,
              totalLengthMm: 10000,
              storageLocation: 'A-01',
              inspectionStatus: 'PENDING'
            }
          ]
        })
      },
      warehouseToken
    );
    assert.equal(receiptRes.status, 200, `WAREHOUSE 采购入库应成功: ${receiptRes.raw}`);

    // 2) INSPECTOR 质检放行
    const inspectRes = await apiJson(
      `/api/v2/quality/rolls/${encodeURIComponent(rollRbacId)}/inspect-complete`,
      {
        method: 'POST',
        body: JSON.stringify({ status: 'PASSED', inspector: 'inspector', remarks: 'M3 RBAC 质检合格放行' })
      },
      inspectorToken
    );
    assert.equal(inspectRes.status, 200, `INSPECTOR 质检放行应成功: ${inspectRes.raw}`);

    // 3) PLANNER 建需求任务 + 试排 + 保存草案 + 确认方案（绑定刚放行的 rollRbacId）
    const taskRes = await apiJson(
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `RBAC任务-${tagUpper}`,
          materialModel: modelRbac,
          dimension: 'RECT_2D',
          bedLengthMm: 3000,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [{ id: 1, name: '主片', width: 500, length: 600, quantity: 2, allowRotation: false }]
        })
      },
      plannerToken
    );
    assert.equal(taskRes.status, 200, `PLANNER 建单应成功: ${taskRes.raw}`);
    taskRbacId = taskRes.data.id;

    const jobRes = await apiJson(
      `/api/v2/workbench/tasks/${encodeURIComponent(taskRbacId)}/plan-jobs`,
      {
        method: 'POST',
        body: JSON.stringify({
          materialType: 'STOCK_ROLL',
          materialId: rollRbacId,
          widthMm: 1600,
          windowLengthMm: 3000,
          processMode: 'GUILLOTINE',
          objective: 'MAXIMIZE_PIECE_AREA',
          pieceGapMm: 0,
          timeLimitSeconds: 5
        })
      },
      plannerToken
    );
    assert.equal(jobRes.status, 202, `PLANNER 试排提交应 202: ${jobRes.raw}`);
    const jobDone = await waitJobSucceeded(baseUrl, jobRes.data.job.id, plannerToken);
    assert.equal(jobDone.state, 'SUCCEEDED', `试排应成功: ${JSON.stringify(jobDone)}`);
    resultRbacId = String(jobDone.resultRef || jobDone.id).replace(/^\/api\/v2\/optimization-results\//, '');

    const draftRes = await apiJson(
      '/api/v2/workbench/drafts',
      {
        method: 'POST',
        body: JSON.stringify({
          resultId: resultRbacId,
          taskId: taskRbacId,
          materialType: 'STOCK_ROLL',
          materialId: rollRbacId,
          note: `RBAC草案-${tagUpper}`,
          ttlSeconds: 1800
        })
      },
      plannerToken
    );
    assert.equal(draftRes.status, 201, `PLANNER 保存草案应 201: ${draftRes.raw}`);
    draftRbacId = draftRes.data.draftId;

    const confirmRes = await apiJson(
      '/api/v2/schemes/confirm',
      {
        method: 'POST',
        body: JSON.stringify({
          title: `RBAC确认方案-${tagUpper}`,
          dimension: 'RECT_2D',
          scenarioId: 'SHORTEN_KIT',
          strategyId: 'JAVA_FAST',
          strategyName: '快速基线',
          taskId: taskRbacId,
          taskName: `RBAC任务-${tagUpper}`,
          materialMode: 'STOCK_ROLL',
          rollId: rollRbacId,
          materialModel: modelRbac,
          widthMm: 1600,
          canvasLengthMm: 1000,
          windowStartY: 0,
          occupiedLengthMm: 600,
          trimStartMm: 0,
          pieceGapMm: 0,
          utilizationPct: 37.5,
          pieceAreaM2: 0.6,
          demands: [
            {
              id: 1,
              name: '主片',
              width: 500,
              length: 600,
              quantity: 2,
              allowRotation: false,
              sourceTaskId: taskRbacId,
              sourceLineId: 1
            }
          ],
          sourceAllocations: [{ taskId: taskRbacId, lineId: 1, quantity: 2 }],
          layout2D: {
            placements: [
              { id: 1, demandId: 1, name: '主片', x: 0, y: 0, w: 500, l: 600, rotationDegrees: 0 },
              { id: 2, demandId: 1, name: '主片', x: 500, y: 0, w: 500, l: 600, rotationDegrees: 0 }
            ],
            leftovers: [],
            cuts: []
          }
        })
      },
      plannerToken
    );
    assert.equal(confirmRes.status, 200, `PLANNER 确认方案应 200: ${confirmRes.raw}`);
    schemeRbacId = confirmRes.data.scheme.id;

    // 4) OPERATOR 执行完工报工
    const completeRes = await apiJson(
      `/api/v2/schemes/${encodeURIComponent(schemeRbacId)}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ actualCutLenMm: 600, operator: 'operator', note: 'RBAC操作员完工报工' })
      },
      operatorToken
    );
    assert.equal(completeRes.status, 200, `OPERATOR 报工应 200: ${completeRes.raw}`);

    // 5) ADMIN 查询操作审计
    const auditRes = await apiJson('/api/v2/audit-logs?page=0&size=10', {}, adminToken);
    assert.equal(auditRes.status, 200, `ADMIN 查审计应 200: ${auditRes.raw}`);
    return { rollRbacId, taskRbacId, draftRbacId, schemeRbacId, auditTotal: auditRes.data.total };
  });

  let agentId = null;
  let agentToken = null;

  await runCheck('T1-F11-02', 'Tier1', 'F11', async () => {
    await adminPage.goto(`${baseUrl}/app/#/users`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('button', { name: /AI Agent 凭证/ }).click();
    await adminPage.getByRole('button', { name: '+ 签发 Agent 凭证', exact: true }).click();
    const issueDlg = adminPage.locator('dialog[open]').filter({ hasText: '签发 AI Agent 受限凭证' });
    await issueDlg.waitFor({ state: 'visible', timeout: 10000 });
    await issueDlg.locator('#agent-name').fill(`e2e-planner-agent-${tag}`);
    await issueDlg.locator('#agent-ttl').fill('24');
    // 确认默认勾选 4 项且未勾选 DEMAND_WRITE
    const demandWriteCheckbox = issueDlg
      .locator('label.sec-scope-option', { hasText: 'DEMAND_WRITE' })
      .locator('input[type="checkbox"]');
    assert.equal(await demandWriteCheckbox.isChecked(), false, '默认不应勾选 DEMAND_WRITE');
    await issueDlg.getByRole('button', { name: '签发并展示一次性令牌', exact: true }).click();
    await issueDlg.waitFor({ state: 'hidden', timeout: 10000 });

    const revealCard = adminPage.locator('div.sec-token-reveal[role="status"]');
    await revealCard.waitFor({ state: 'visible', timeout: 10000 });
    const revealText = await revealCard.innerText();
    const idMatch = revealText.match(/AGT-[A-Za-z0-9-]+/);
    assert.ok(idMatch, `未能在展示卡找到 Agent ID: ${revealText}`);
    agentId = idMatch[0];

    agentToken = (await revealCard.locator('[data-testid="agent-once-token"]').innerText()).trim();
    assert.ok(agentToken.split('.').length === 3, `一次性令牌格式异常: ${agentToken}`);

    await revealCard.getByRole('button', { name: '我已保存并关闭', exact: true }).click();
    await revealCard.waitFor({ state: 'hidden', timeout: 10000 });

    const agentsList = await apiJson('/api/v2/agents', {}, adminToken);
    assert.equal(agentsList.status, 200);
    assert.ok(!agentsList.raw.includes(agentToken), 'GET /api/v2/agents 绝不能返回明文 token');
    assert.ok(agentsList.data.items.some((a) => a.agentId === agentId));
    return { agentId, tokenLength: agentToken.length };
  });

  let mcpHandle = null;
  await runCheck('T1-F11-03', 'Tier1', 'F11', async () => {
    const meRes = await apiJson('/api/v2/auth/me', {}, agentToken);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.actorType, 'AGENT');
    assert.equal(meRes.data.agentId, agentId);
    assert.ok(!meRes.data.scopes.includes('DEMAND_WRITE'));

    const poolRes = await apiJson('/api/v2/demand-pool?limit=5', {}, agentToken);
    assert.equal(poolRes.status, 200);

    const agentDraftRes = await apiJson(
      '/api/v2/workbench/drafts',
      {
        method: 'POST',
        body: JSON.stringify({
          resultId: resultRbacId,
          taskId: taskRbacId,
          materialType: 'STOCK_ROLL',
          materialId: rollRbacId,
          note: `Agent-REST草案-${tagUpper}`,
          ttlSeconds: 900
        })
      },
      agentToken
    );
    assert.equal(agentDraftRes.status, 201, `Agent REST 保存草案应 201: ${agentDraftRes.raw}`);
    assert.equal(agentDraftRes.data.inventoryMutated, false);

    mcpHandle = await openMcpClient(baseUrl, agentToken);
    const listPoolTool = await mcpHandle.client.callTool({
      name: 'list_demand_pool',
      arguments: { onlyOpen: false, limit: 10 }
    });
    assert.ok(!listPoolTool.isError, `MCP list_demand_pool 失败: ${JSON.stringify(listPoolTool)}`);

    // 为 Agent 试排准备一个仍有 openQty 的独立待排任务
    const openTaskRes = await apiJson(
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `Agent试排待排任务-${tagUpper}`,
          materialModel: modelRbac,
          dimension: 'RECT_2D',
          bedLengthMm: 3000,
          trimStartMm: 0,
          pieceGapMm: 0,
          demands: [{ id: 1, name: '待排件', width: 500, length: 600, quantity: 2, allowRotation: false }]
        })
      },
      plannerToken
    );
    assert.equal(openTaskRes.status, 200, `创建 Agent 试排任务失败: ${openTaskRes.raw}`);
    const openTaskId = openTaskRes.data.id;

    const planTool = await mcpHandle.client.callTool({
      name: 'plan_task_on_material',
      arguments: {
        taskId: openTaskId,
        materialType: 'FREE_CANVAS',
        widthMm: 2000,
        windowLengthMm: 4000,
        processMode: 'GUILLOTINE',
        objective: 'MAXIMIZE_PIECE_AREA',
        timeLimitSeconds: 3,
        waitForResult: true,
        includePreview: false
      }
    });
    assert.ok(!planTool.isError, `MCP plan_task_on_material 失败: ${JSON.stringify(planTool)}`);
    assert.equal(planTool.structuredContent?.data?.inventoryMutated, false);
    return { agentId, restDraftId: agentDraftRes.data.draftId, mcpPlanId: planTool.structuredContent?.data?.id };
  });

  let sseJobId = null;
  await runCheck('T1-F11-04', 'Tier1', 'F11', async () => {
    const subRes = await apiJson(
      '/api/v2/optimization-jobs',
      { method: 'POST', body: JSON.stringify(FIXTURE_JSON) },
      plannerToken
    );
    assert.equal(subRes.status, 202, `提交求解作业应 202: ${subRes.raw}`);
    sseJobId = subRes.data.id;

    for (const [label, tok] of [
      ['PLANNER', plannerToken],
      ['AGENT', agentToken]
    ]) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      try {
        const res = await fetch(`${baseUrl}/api/v2/optimization-jobs/${encodeURIComponent(sseJobId)}/events`, {
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${tok}` },
          signal: ac.signal
        });
        assert.equal(res.status, 200, `${label} SSE 必须返回 200`);
        const ct = res.headers.get('content-type') || '';
        assert.ok(ct.includes('text/event-stream'), `${label} Content-Type 应为 text/event-stream，实际: ${ct}`);
        const reader = res.body.getReader();
        const { value } = await reader.read();
        const chunk = value ? new TextDecoder().decode(value) : '';
        assert.ok(chunk.includes('data:') || chunk.includes('event:'), `${label} SSE 应输出事件包: ${chunk}`);
        await reader.cancel().catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    }
    return { sseJobId, plannerSse200: true, agentSse200: true };
  });

  await runCheck('T1-F11-05', 'Tier1', 'F11', async () => {
    await adminPage.goto(`${baseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('heading', { name: '全站操作审计', exact: true, level: 1 }).waitFor({
      state: 'visible',
      timeout: 10000
    });
    await adminPage.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
    const pagerText = await adminPage.locator('.pager').innerText();
    assert.match(pagerText, /第 1 \/ \d+ 页 · 共 [1-9]\d* 条/);

    await adminPage.locator('#audit-target-id').fill(rollRbacId);
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();
    const rollAuditRow = adminPage.locator('tbody tr').filter({ hasText: 'QUALITY_ROLL_INSPECT_COMPLETE' }).first();
    await rollAuditRow.waitFor({ state: 'visible', timeout: 10000 });

    await adminPage.getByRole('button', { name: '重置', exact: true }).click();
    await adminPage.locator('#audit-actor').fill(authAdminUser);
    await adminPage.locator('#audit-action').fill('AUTH_LOGIN');
    await adminPage.locator('#audit-outcome').selectOption('SUCCESS');
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();

    const loginRow = adminPage.locator('tbody tr').filter({ hasText: 'AUTH_LOGIN' }).first();
    await loginRow.waitFor({ state: 'visible', timeout: 10000 });
    await loginRow.getByRole('button', { name: '详情', exact: true }).click();

    const detailDlg = adminPage.locator('dialog[open]').filter({ hasText: '审计记录详情：AUTH_LOGIN' });
    await detailDlg.waitFor({ state: 'visible', timeout: 10000 });
    const preText = await detailDlg.locator('pre.sec-audit-detail-pre').innerText();
    const parsedDetail = JSON.parse(preText);
    assert.ok(!preText.includes(authAdminPass) && !preText.includes(adminToken), '审计详情不得泄露密码或令牌');
    await detailDlg.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await detailDlg.waitFor({ state: 'hidden', timeout: 10000 });
    return { pagerText: pagerText.replace(/\s+/g, ' ').trim(), detailKeys: Object.keys(parsedDetail) };
  });

  // ==================== Tier 2: F11 (5 项) ====================
  await runCheck('T2-F11-01', 'Tier2', 'F11', async () => {
    const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sig = plannerToken.split('.')[2];
    const midPos = Math.floor(sig.length / 2);
    const sigStart = plannerToken.length - sig.length;
    const midTampered =
      plannerToken.slice(0, sigStart + midPos) +
      (sig[midPos] === 'A' ? 'B' : 'A') +
      plannerToken.slice(sigStart + midPos + 1);
    const lastIdx = B64URL.indexOf(sig.slice(-1));
    assert.ok(lastIdx >= 0, '签名末位应属于 Base64URL 字符集');
    const groupBase = lastIdx & ~3;
    const paddingVariants = [0, 1, 2, 3]
      .map((offset) => groupBase + offset)
      .filter((i) => i !== lastIdx)
      .map((i) => plannerToken.slice(0, -1) + B64URL[i]);

    for (const badToken of [null, 'not.a.jwt', midTampered, ...paddingVariants]) {
      const r1 = await apiJson('/api/v2/rolls', {}, badToken);
      const r2 = await apiJson('/api/v2/demand-pool', {}, badToken);
      const r3 = await apiJson(`/api/v2/optimization-jobs/${encodeURIComponent(sseJobId)}/events`, {}, badToken);
      assert.equal(r1.status, 401, `badToken=${badToken} GET /api/v2/rolls 应 401`);
      assert.equal(r2.status, 401, `badToken=${badToken} GET /api/v2/demand-pool 应 401`);
      assert.equal(r3.status, 401, `badToken=${badToken} GET SSE 应 401`);
    }
    return { unauthenticatedAndTampered401: true, paddingVariantsChecked: paddingVariants.length };
  });

  await runCheck('T2-F11-02', 'Tier2', 'F11', async () => {
    assert.equal(
      (await apiJson('/api/v2/workbench/drafts', { method: 'POST', body: '{}' }, operatorToken)).status,
      403
    );
    assert.equal(
      (
        await apiJson(
          `/api/v2/quality/rolls/${encodeURIComponent(rollRbacId)}/inspect-complete`,
          { method: 'POST', body: JSON.stringify({ status: 'PASSED' }) },
          warehouseToken
        )
      ).status,
      403
    );
    assert.equal(
      (await apiJson('/api/v2/inventory-receipts', { method: 'POST', body: '{}' }, inspectorToken)).status,
      403
    );
    assert.equal(
      (await apiJson('/api/v2/material-issues', { method: 'POST', body: '{}' }, plannerToken)).status,
      403
    );
    assert.equal((await apiJson('/api/v2/audit-logs', {}, plannerToken)).status, 403);

    for (const bypassPath of ['/api/v2/Users;foo=bar', '/api/v2/%75sers', '/api/v2/audit-logs;x=1']) {
      const res = await apiJson(bypassPath, {}, plannerToken);
      assert.equal(res.status, 403, `路径绕过 ${bypassPath} 必须返回 403，实际 ${res.status}`);
    }
    return { crossRole403: true, bypassPaths403: 3 };
  });

  await runCheck('T2-F11-03', 'Tier2', 'F11', async () => {
    const restDeniedPaths = [
      ['/api/v2/schemes/confirm', 'POST', {}],
      [`/api/v2/workbench/drafts/${encodeURIComponent(draftRbacId)}/confirm`, 'POST', {}],
      ['/api/v2/demand-pool', 'POST', { name: '越权建单' }],
      ['/api/v2/inventory-receipts', 'POST', {}],
      [`/api/v2/quality/rolls/${encodeURIComponent(rollRbacId)}/inspect-complete`, 'POST', { status: 'PASSED' }],
      ['/api/v2/users', 'GET', undefined],
      ['/api/v2/auth/logout', 'POST', undefined]
    ];
    for (const [p, m, body] of restDeniedPaths) {
      const r = await apiJson(
        p,
        { method: m, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
        agentToken
      );
      assert.equal(r.status, 403, `Agent 调用 ${m} ${p} 必须 403，实际 ${r.status}: ${r.raw}`);
    }

    const mcpDenied = await mcpHandle.client.callTool({
      name: 'create_demand_task',
      arguments: {
        name: 'Agent越权建单',
        materialModel: modelRbac,
        dimension: 'RECT_2D',
        demands: [{ name: 'A', width: 500, length: 500, quantity: 1, allowRotation: false }]
      }
    });
    assert.equal(mcpDenied.isError, true, 'Agent 缺 DEMAND_WRITE 调 create_demand_task 必须返回 isError=true');
    const mcpErrText = JSON.stringify(mcpDenied);
    assert.ok(
      mcpErrText.includes('403') || mcpErrText.includes('FORBIDDEN'),
      `MCP 错误文案应体现 403/FORBIDDEN: ${mcpErrText}`
    );
    return { rest403Count: restDeniedPaths.length, mcp403Blocked: true };
  });

  await runCheck('T2-F11-04', 'Tier2', 'F11', async () => {
    await adminPage.goto(`${baseUrl}/app/#/users`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('button', { name: /AI Agent 凭证/ }).click();
    const row = adminPage.locator('tbody tr').filter({ hasText: agentId });
    await row.waitFor({ state: 'visible', timeout: 10000 });
    await row.getByRole('button', { name: '吊销', exact: true }).click();

    const revokeDlg = adminPage.locator('dialog[open]').filter({ hasText: `吊销 Agent 凭证：${agentId}` });
    await revokeDlg.waitFor({ state: 'visible', timeout: 10000 });
    await revokeDlg.locator('#agent-revoke-reason').fill('E2E吊销测试');
    await revokeDlg.getByRole('button', { name: '确认立即吊销', exact: true }).click();
    await revokeDlg.waitFor({ state: 'hidden', timeout: 10000 });
    await row.locator('.tag.err', { hasText: '已吊销' }).waitFor({ state: 'visible', timeout: 10000 });

    const restAfter = await apiJson('/api/v2/demand-pool', {}, agentToken);
    const sseAfter = await apiJson(`/api/v2/optimization-jobs/${encodeURIComponent(sseJobId)}/events`, {}, agentToken);
    assert.equal(restAfter.status, 401, '吊销 Agent 后 REST 必须立即 401');
    assert.equal(sseAfter.status, 401, '吊销 Agent 后 SSE 必须立即 401');

    const mcpAfter = await mcpHandle.client.callTool({
      name: 'list_demand_pool',
      arguments: { onlyOpen: false, limit: 5 }
    });
    assert.equal(mcpAfter.isError, true, '吊销 Agent 后 MCP 调用必须返回 isError=true');
    const mcpAfterText = JSON.stringify(mcpAfter);
    assert.ok(
      mcpAfterText.includes('401') || mcpAfterText.includes('UNAUTHORIZED'),
      `吊销后 MCP 应返回 401/UNAUTHORIZED: ${mcpAfterText}`
    );
    await mcpHandle.transport.close().catch(() => {});
    return { agentId, rest401: true, sse401: true, mcp401: true };
  });

  await runCheck('T2-F11-05', 'Tier2', 'F11', async () => {
    await loginInBrowser(operatorPage, baseUrl, 'operator', 'operator123');
    await operatorPage.goto(`${baseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
    const forbiddenCard = operatorPage.locator('section.sec-forbidden-card[role="alert"]');
    await forbiddenCard.waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await forbiddenCard.innerText()).includes('403 权限不足'));

    await adminPage.goto(`${baseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
    await adminPage.locator('#audit-action').fill('ACCESS_DENIED');
    await adminPage.locator('#audit-outcome').selectOption('DENIED');
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();
    await adminPage.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

    const deniedPage = await apiJson(
      '/api/v2/audit-logs?action=ACCESS_DENIED&outcome=DENIED&page=0&size=50',
      {},
      adminToken
    );
    assert.equal(deniedPage.status, 200);
    const items = deniedPage.data.items || [];
    const agentDenied = items.find((it) => it.agentId === agentId && it.httpStatus === 403);
    const userDenied = items.find((it) => it.actorType === 'USER' && it.httpStatus === 403);
    assert.ok(agentDenied && agentDenied.requestPath, '审计日志必须记录 Agent 越权路径与 403');
    assert.ok(userDenied && userDenied.requestPath, '审计日志必须记录普通角色越权路径与 403');
    return { deniedTotal: deniedPage.data.total, agentDeniedPath: agentDenied.requestPath };
  });

  await runCheck('T2-F11-06', 'Tier2', 'F11', async () => {
    // 1. 当前 auth.enabled=true 默认未开 mesToken 实例：匿名请求 /api/v2/mes/* 全部返回 401
    const mesOrderPayload = {
      mesWorkOrderNo: `MES-E2E-WO-${tagUpper}`,
      taskName: `MES鉴权回归-${tagUpper}`,
      materialModel: modelRbac,
      dimension: 'RECT_2D',
      bedLengthMm: 2000,
      demands: [{ id: 1, name: '面板', width: 400, length: 500, quantity: 2 }]
    };
    for (const [m, p, b] of [
      ['POST', '/api/v2/mes/orders', mesOrderPayload],
      ['POST', '/api/v2/mes/execution-feedback', { schemeId: schemeRbacId, mesReceiptNo: 'REC-ANON' }],
      ['POST', `/api/v2/mes/schemes/${encodeURIComponent(schemeRbacId)}/dispatch`, { mesWorkOrderNo: 'ANON' }],
      ['GET', `/api/v2/mes/dispatch-packages/${encodeURIComponent(schemeRbacId)}`, null]
    ]) {
      const r = await apiJson(p, { method: m, ...(b ? { body: JSON.stringify(b) } : {}) });
      assert.equal(r.status, 401, `匿名请求 ${m} ${p} 必须返回 401，实际: ${r.status}`);
    }

    // 2. 仅 DEMAND_READ 的 Agent 调用 dispatch / dispatch-packages 必须返回 403；WAREHOUSE 调用 dispatch 返回 403
    const mesAgentIssue = await apiJson(
      '/api/v2/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `mes-demand-only-${tag}`,
          scopes: ['DEMAND_READ'],
          description: '验证 MES 403 隔离'
        })
      },
      adminToken
    );
    assert.equal(mesAgentIssue.status, 201);
    const mesAgentId = mesAgentIssue.data.agent.agentId;
    const mesAgentTok = mesAgentIssue.data.token;
    try {
      const agDispatch = await apiJson(
        `/api/v2/mes/schemes/${encodeURIComponent(schemeRbacId)}/dispatch`,
        { method: 'POST', body: JSON.stringify({ mesWorkOrderNo: 'AG-FAIL' }) },
        mesAgentTok
      );
      assert.equal(agDispatch.status, 403, `DEMAND_READ Agent 调 dispatch 必须返回 403，实际: ${agDispatch.status}`);
      const agPkg = await apiJson(
        `/api/v2/mes/dispatch-packages/${encodeURIComponent(schemeRbacId)}`,
        {},
        mesAgentTok
      );
      assert.equal(agPkg.status, 403, `DEMAND_READ Agent 调 dispatch-packages 必须返回 403，实际: ${agPkg.status}`);
    } finally {
      await apiJson(`/api/v2/agents/${encodeURIComponent(mesAgentId)}/revoke`, { method: 'POST', body: '{}' }, adminToken);
    }

    const whDispatch = await apiJson(
      `/api/v2/mes/schemes/${encodeURIComponent(schemeRbacId)}/dispatch`,
      { method: 'POST', body: JSON.stringify({ mesWorkOrderNo: 'WH-FAIL' }) },
      warehouseToken
    );
    assert.equal(whDispatch.status, 403, `WAREHOUSE 调 dispatch 必须返回 403，实际: ${whDispatch.status}`);

    // 3. 隔离双认证实例（cutdemo.auth.enabled=true + cutdemo.mes.auth-required=true + cutdemo.mes.token）
    const mesPort = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, Number(new URL(baseUrl).port)]));
    const mesTmpDir = path.join(os.tmpdir(), 'cutdemo-verify', `mes-dual-${tag}`);
    fs.mkdirSync(mesTmpDir, { recursive: true });
    const mesTokenSecret = 'e2e-mes-secret-2026';
    let mesPid = null;
    try {
      const mesProc = await startIsolatedJava({
        jarPath,
        port: mesPort,
        statePath: path.join(mesTmpDir, 'cutdemo-state.json'),
        logFile: path.join(mesTmpDir, 'mes-dual.log'),
        jvmOpts: ['-Xms64m', '-Xmx256m'],
        extraArgs: ['--cutdemo.mes.auth-required=true', `--cutdemo.mes.token=${mesTokenSecret}`]
      });
      mesPid = mesProc.pid;
      const mesBase = mesProc.baseUrl;

      const badTokRes = await apiJsonOn(
        mesBase,
        '/api/v2/mes/orders',
        { method: 'POST', body: JSON.stringify(mesOrderPayload) },
        'wrong-mes-token'
      );
      assert.equal(badTokRes.status, 401, `错误 mesToken 必须返回 401，实际: ${badTokRes.status}`);

      const okTokRes = await apiJsonOn(
        mesBase,
        '/api/v2/mes/orders',
        { method: 'POST', body: JSON.stringify(mesOrderPayload) },
        mesTokenSecret
      );
      assert.equal(okTokRes.status, 200, `正确 mesToken 应返回 200: ${okTokRes.raw}`);
      const dualTaskId = okTokRes.data.id;

      const dualPlannerTok = (await loginAs(mesBase, 'planner', 'planner123')).token;
      const dualConfirm = await apiJsonOn(
        mesBase,
        '/api/v2/schemes/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            idempotencyKey: `IDEM-MES-DUAL-${tagUpper}`,
            title: '双认证派工方案',
            dimension: 'RECT_2D',
            strategyId: 'SHORTEN',
            strategyName: '测试',
            taskId: dualTaskId,
            materialMode: 'VIRTUAL_ROLL',
            materialModel: modelRbac,
            widthMm: 1500,
            canvasLengthMm: 1000,
            occupiedLengthMm: 520,
            utilizationPct: 40,
            pieceAreaM2: 0.4,
            placedCount: 2,
            requestedCount: 2,
            complete: true,
            layout2D: {
              placements: [
                { id: 1, demandId: 1, name: '面板', x: 0, y: 0, w: 400, l: 500, rotationDegrees: 0 },
                { id: 2, demandId: 1, name: '面板', x: 410, y: 0, w: 400, l: 500, rotationDegrees: 0 }
              ],
              remnants: [],
              cuts: []
            }
          })
        },
        dualPlannerTok
      );
      assert.equal(dualConfirm.status, 200, `双认证确认方案失败: ${dualConfirm.raw}`);
      const dualSchemeId = dualConfirm.data.scheme.id;

      const plannerDispatch = await apiJsonOn(
        mesBase,
        `/api/v2/mes/schemes/${encodeURIComponent(dualSchemeId)}/dispatch`,
        { method: 'POST', body: JSON.stringify({ mesWorkOrderNo: `DUAL-WO-${tagUpper}` }) },
        dualPlannerTok
      );
      assert.equal(plannerDispatch.status, 200, `双认证下已登录 PLANNER 必须可成功派发 MES: ${plannerDispatch.raw}`);
      assert.equal(plannerDispatch.data.state, 'DISPATCHED_MES');
      return { anonBlocked401: true, agentBlocked403: true, dualAuthPlanner200: true, mesToken200: true };
    } finally {
      if (mesPid) await stopIsolatedJava(mesPid);
      if (fs.existsSync(mesTmpDir)) fs.rmSync(mesTmpDir, { recursive: true, force: true });
    }
  });

  // ==================== F12 独立 -Xmx256m 热冷分离隔离验证（10 项 + T3-F12×F11-01） ====================
  const f12Port = await findFreeLoopbackPort(new Set([8080, 18094, 18095, 18096, Number(new URL(baseUrl).port)]));
  f12TmpDir = path.join(os.tmpdir(), 'cutdemo-verify', `f12-scale-${tag}`);
  fs.mkdirSync(f12TmpDir, { recursive: true });
  const f12StatePath = path.join(f12TmpDir, 'cutdemo-state.json');
  const f12LogFile = path.join(f12TmpDir, 'f12-server.log');
  const f12BaseUrl = `http://127.0.0.1:${f12Port}`;

  // 先预热造数（通过真实 HTTP API 批量写入 100 卷母卷、20 个需求任务与多笔报工流水，再补充历史只增审计记录至 >=2,500 条）
  const seedProc = await startIsolatedJava({
    jarPath,
    port: f12Port,
    statePath: f12StatePath,
    logFile: f12LogFile,
    jvmOpts: ['-Xms64m', '-Xmx256m', '-XX:+ExitOnOutOfMemoryError']
  });
  f12ChildPid = seedProc.pid;
  try {
    const f12AdminTok = (await loginAs(f12BaseUrl, 'admin', 'admin123')).token;
    const f12WhTok = (await loginAs(f12BaseUrl, 'warehouse', 'warehouse123')).token;
    const f12InspTok = (await loginAs(f12BaseUrl, 'inspector', 'inspector123')).token;
    const f12PlanTok = (await loginAs(f12BaseUrl, 'planner', 'planner123')).token;

    // 批量入库 10 批 × 10 卷 = 100 卷母卷（通过真实 HTTP API，避免写限流）
    for (let b = 0; b < 10; b += 1) {
      const rolls = [];
      for (let r = 0; r < 10; r += 1) {
        rolls.push({
          id: `F12-ROLL-${b}-${r}`,
          materialModel: `F12-MOD-${b % 3}`,
          materialType: 'CANVAS',
          color: '深灰',
          batchNo: `B-${b}`,
          widthMm: 1600,
          totalLengthMm: 20000,
          storageLocation: `Z-${b}`,
          inspectionStatus: 'PENDING'
        });
      }
      const rec = await apiJsonOn(
        f12BaseUrl,
        '/api/v2/inventory-receipts',
        {
          method: 'POST',
          body: JSON.stringify({
            supplierName: 'F12压测织造',
            deliveryNoteNo: `F12-DN-${b}`,
            operator: 'warehouse',
            rolls
          })
        },
        f12WhTok
      );
      assert.equal(rec.status, 200, `F12 造卷失败: ${rec.raw}`);
    }

    // 放行前 5 卷并创建 20 个需求任务
    for (let i = 0; i < 5; i += 1) {
      const p = await apiJsonOn(
        f12BaseUrl,
        `/api/v2/quality/rolls/${encodeURIComponent(`F12-ROLL-0-${i}`)}/inspect-complete`,
        { method: 'POST', body: JSON.stringify({ status: 'PASSED', inspector: 'inspector' }) },
        f12InspTok
      );
      assert.equal(p.status, 200);
    }
    for (let t = 0; t < 20; t += 1) {
      const tr = await apiJsonOn(
        f12BaseUrl,
        '/api/v2/demand-pool',
        {
          method: 'POST',
          body: JSON.stringify({
            name: `F12历史任务-${t}`,
            materialModel: `F12-MOD-${t % 3}`,
            dimension: 'RECT_2D',
            bedLengthMm: 3000,
            demands: [{ id: 1, name: '主件', width: 500, length: 600, quantity: 2, allowRotation: true }]
          })
        },
        f12PlanTok
      );
      assert.equal(tr.status, 200);
    }

    // 确认并完成 2 笔方案，产生真实台账流水与对账报工记录
    for (let k = 0; k < 2; k += 1) {
      const cRes = await apiJsonOn(
        f12BaseUrl,
        '/api/v2/schemes/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            title: `F12历史方案-${k}`,
            dimension: 'RECT_2D',
            scenarioId: 'SHORTEN_KIT',
            strategyId: 'JAVA_FAST',
            strategyName: '快速基线',
            taskName: `F12历史任务-${k}`,
            materialMode: 'STOCK_ROLL',
            rollId: `F12-ROLL-0-${k}`,
            materialModel: 'F12-MOD-0',
            widthMm: 1600,
            canvasLengthMm: 1000,
            windowStartY: 0,
            occupiedLengthMm: 600,
            trimStartMm: 0,
            pieceGapMm: 0,
            utilizationPct: 37.5,
            pieceAreaM2: 0.6,
            demands: [{ id: 1, name: '主件', width: 500, length: 600, quantity: 2, allowRotation: false }],
            layout2D: {
              placements: [
                { id: 1, demandId: 1, name: '主件', x: 0, y: 0, w: 500, l: 600, rotationDegrees: 0 },
                { id: 2, demandId: 1, name: '主件', x: 500, y: 0, w: 500, l: 600, rotationDegrees: 0 }
              ],
              leftovers: [],
              cuts: []
            }
          })
        },
        f12AdminTok
      );
      assert.equal(cRes.status, 200);
      const compRes = await apiJsonOn(
        f12BaseUrl,
        `/api/v2/schemes/${encodeURIComponent(cRes.data.scheme.id)}/complete`,
        { method: 'POST', body: JSON.stringify({ actualCutLenMm: 600, operator: 'operator' }) },
        f12AdminTok
      );
      assert.equal(compRes.status, 200);
    }
  } finally {
    await stopIsolatedJava(f12ChildPid);
    f12ChildPid = null;
  }

  // 在离线状态向独立临时审计文件追加 2,500 条合法历史审计 JSONL 记录（模拟大规模历史只增审计流水）
  const f12AuditFile = path.join(`${f12StatePath}.audit`, 'events.jsonl');
  fs.mkdirSync(path.dirname(f12AuditFile), { recursive: true });
  const baseTs = Date.now() - 86400_000;
  const histLines = [];
  for (let i = 0; i < 2500; i += 1) {
    histLines.push(
      JSON.stringify({
        id: `AUD-F12HIST-${String(i).padStart(6, '0')}`,
        occurredAt: baseTs + i * 10,
        actor: i % 2 === 0 ? 'planner' : 'warehouse',
        actorType: 'USER',
        actorRole: i % 2 === 0 ? 'PLANNER' : 'WAREHOUSE',
        agentId: null,
        action: i % 2 === 0 ? 'DRAFT_CREATE' : 'INVENTORY_RECEIPT',
        targetType: i % 2 === 0 ? 'WORKBENCH_DRAFT' : 'INVENTORY_RECEIPT',
        targetId: `HIST-DOC-${i}`,
        httpMethod: 'POST',
        requestPath: i % 2 === 0 ? '/api/v2/workbench/drafts' : '/api/v2/inventory-receipts',
        outcome: 'SUCCESS',
        httpStatus: 200,
        traceId: `f12-trace-${i}`,
        clientIp: '127.0.0.1',
        detailJson: JSON.stringify({ seq: i, batch: 'F12-COLD-SEED' })
      })
    );
  }
  fs.appendFileSync(f12AuditFile, `${histLines.join('\n')}\n`, 'utf8');

  let f12AdminToken = null;
  let f12PlannerToken = null;
  let f12WhToken = null;
  let f12InspToken = null;

  await runCheck('T1-F12-01', 'Tier1', 'F12', async () => {
    const coldProc = await startIsolatedJava({
      jarPath,
      port: f12Port,
      statePath: f12StatePath,
      logFile: path.join(f12TmpDir, 'f12-cold.log'),
      jvmOpts: ['-Xms64m', '-Xmx256m', '-XX:+ExitOnOutOfMemoryError']
    });
    f12ChildPid = coldProc.pid;
    assert.ok(coldProc.readyMs <= 30000, `-Xmx256m 冷启动超时: ${coldProc.readyMs}ms`);
    assert.equal(isPidAlive(f12ChildPid), true);
    f12AdminToken = (await loginAs(f12BaseUrl, 'admin', 'admin123')).token;
    f12PlannerToken = (await loginAs(f12BaseUrl, 'planner', 'planner123')).token;
    f12WhToken = (await loginAs(f12BaseUrl, 'warehouse', 'warehouse123')).token;
    f12InspToken = (await loginAs(f12BaseUrl, 'inspector', 'inspector123')).token;
    return { f12Port, readyMs: coldProc.readyMs };
  });

  await runCheck('T1-F12-02', 'Tier1', 'F12', async () => {
    const recon = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger/reconciliation', {}, f12AdminToken);
    assert.equal(recon.status, 200);
    assert.equal(recon.data?.status, 'BALANCED');
    assert.equal((recon.data?.issues || []).length, 0);
    return { status: recon.data.status, entryCount: recon.data.entryCount };
  });

  await runCheck('T1-F12-03', 'Tier1', 'F12', async () => {
    const seenIds = new Set();
    let totalAudit = 0;
    const pageTimings = [];
    for (let p = 0; p < 5; p += 1) {
      const t0 = Date.now();
      const res = await apiJsonOn(f12BaseUrl, `/api/v2/audit-logs?page=${p}&size=50`, {}, f12AdminToken);
      const dt = Date.now() - t0;
      pageTimings.push(dt);
      assert.equal(res.status, 200);
      assert.ok(dt < 2000, `审计第 ${p} 页响应过慢: ${dt}ms`);
      totalAudit = res.data.total;
      assert.equal(res.data.items.length, 50);
      for (const it of res.data.items) {
        assert.equal(seenIds.has(it.id), false, `审计分页出现重复 ID: ${it.id}`);
        seenIds.add(it.id);
      }
    }
    assert.ok(totalAudit >= 2500, `审计总条数应 >= 2500，实际: ${totalAudit}`);

    const ledgerRes = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger?after=0&limit=50', {}, f12AdminToken);
    assert.equal(ledgerRes.status, 200);
    assert.ok(Array.isArray(ledgerRes.data.items));

    const reportsRes = await apiJsonOn(f12BaseUrl, '/api/v2/reconciliation/reports?limit=20&offset=0', {}, f12AdminToken);
    assert.equal(reportsRes.status, 200);
    assert.ok(Array.isArray(reportsRes.data.items) && reportsRes.data.total >= 2);

    const rollsRes = await apiJsonOn(f12BaseUrl, '/api/v2/rolls?limit=20&offset=0', {}, f12AdminToken);
    assert.equal(rollsRes.status, 200);
    assert.equal(rollsRes.data.length, 20);
    return { totalAudit, uniqueAuditSampled: seenIds.size, maxPageMs: Math.max(...pageTimings) };
  });

  await runCheck('T1-F12-04', 'Tier1', 'F12', async () => {
    const readTasks = [];
    for (let i = 0; i < 12; i += 1) {
      const endpoint =
        i % 3 === 0
          ? `/api/v2/audit-logs?page=${i % 4}&size=50`
          : i % 3 === 1
            ? '/api/v2/inventory-ledger?after=0&limit=50'
            : '/api/v2/reconciliation/reports?limit=20&offset=0';
      readTasks.push(apiJsonOn(f12BaseUrl, endpoint, {}, f12AdminToken));
    }
    const writeTasks = [];
    for (let w = 0; w < 5; w += 1) {
      writeTasks.push(
        apiJsonOn(
          f12BaseUrl,
          '/api/v2/demand-pool',
          {
            method: 'POST',
            body: JSON.stringify({
              name: `F12并发任务-${w}-${tagUpper}`,
              materialModel: 'F12-MOD-0',
              dimension: 'RECT_2D',
              bedLengthMm: 3000,
              demands: [{ id: 1, name: '并发件', width: 400, length: 500, quantity: 1, allowRotation: true }]
            })
          },
          f12PlannerToken
        )
      );
    }
    const allRes = await Promise.all([...readTasks, ...writeTasks]);
    for (const r of allRes) {
      assert.equal(r.status, 200, `并发读写不得出现异常状态: ${r.status} ${r.raw}`);
    }
    const recon = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger/reconciliation', {}, f12AdminToken);
    assert.equal(recon.data?.status, 'BALANCED');
    return { concurrentReads: 12, concurrentWrites: 5, balanced: true };
  });

  await runCheck('T1-F12-05', 'Tier1', 'F12', async () => {
    const promRes = await fetch(`${f12BaseUrl}/actuator/prometheus`, {
      headers: { Authorization: `Bearer ${f12AdminToken}` }
    });
    assert.equal(promRes.status, 200, `ADMIN 访问 /actuator/prometheus 应 200，实际: ${promRes.status}`);
    const promText = await promRes.text();
    const { maxSum, usedSum } = parsePrometheusHeapBytes(promText);
    assert.ok(maxSum > 0 && maxSum <= 268435456, `JVM Heap Max 必须 <= 256MB (268435456B)，实际: ${maxSum}`);
    assert.ok(usedSum > 0 && usedSum < maxSum, `JVM Heap Used 应健康低于上限: used=${usedSum}, max=${maxSum}`);
    return { heapMaxBytes: maxSum, heapUsedBytes: usedSum };
  });

  await runCheck('T2-F12-01', 'Tier2', 'F12', async () => {
    const auditClamp = await apiJsonOn(f12BaseUrl, '/api/v2/audit-logs?page=0&size=100000', {}, f12AdminToken);
    assert.equal(auditClamp.status, 200);
    assert.equal(auditClamp.data.size, 200, 'audit-logs size=100000 必须截断为 200');
    assert.ok(auditClamp.data.items.length <= 200);

    for (const [badPath, expectCode] of [
      ['/api/v2/reconciliation/reports?limit=10000', true],
      ['/api/v2/inventory-ledger?limit=5000', true],
      ['/api/v2/rolls?limit=5000', false]
    ]) {
      const r = await apiJsonOn(f12BaseUrl, badPath, {}, f12AdminToken);
      assert.equal(r.status, 400, `${badPath} 必须返回 400，实际 ${r.status}`);
      if (expectCode) {
        assert.equal(r.data?.code, 'INVALID_INPUT');
      } else {
        assert.ok(typeof r.data?.message === 'string' && r.data.message.length > 0);
      }
    }
    return { auditClampedTo200: true, limitOverflow400Count: 3 };
  });

  await runCheck('T2-F12-02', 'Tier2', 'F12', async () => {
    const highAudit = await apiJsonOn(f12BaseUrl, '/api/v2/audit-logs?page=99999&size=20', {}, f12AdminToken);
    assert.equal(highAudit.status, 200);
    assert.deepEqual(highAudit.data.items, []);
    assert.ok(highAudit.data.total >= 2500);

    const highReports = await apiJsonOn(
      f12BaseUrl,
      '/api/v2/reconciliation/reports?limit=20&offset=99999',
      {},
      f12AdminToken
    );
    assert.equal(highReports.status, 200);
    assert.deepEqual(highReports.data.items, []);

    const negCursor = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger?after=-1&limit=20', {}, f12AdminToken);
    assert.equal(negCursor.status, 400);
    assert.equal(negCursor.data?.code, 'INVALID_INPUT');
    return { highPageEmpty: true, highOffsetEmpty: true, negCursor400: true };
  });

  await runCheck('T2-F12-03', 'Tier2', 'F12', async () => {
    const emptyApi = await apiJsonOn(
      f12BaseUrl,
      '/api/v2/audit-logs?targetId=NON-EXISTENT-99999&page=0&size=20',
      {},
      f12AdminToken
    );
    assert.equal(emptyApi.status, 200);
    assert.deepEqual(emptyApi.data, { items: [], total: 0, page: 0, size: 20 });

    await adminPage.goto(`${baseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('button', { name: '重置', exact: true }).click();
    await adminPage.locator('#audit-target-id').fill('NON-EXISTENT-99999');
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();
    await adminPage.getByText('未匹配到符合条件的操作审计记录').waitFor({ state: 'visible', timeout: 10000 });
    return { apiEmptyPage: true, uiEmptyStateRendered: true };
  });

  await runCheck('T2-F12-04', 'Tier2', 'F12', async () => {
    const unauthProm = await fetch(`${f12BaseUrl}/actuator/prometheus`);
    assert.equal(unauthProm.status, 401, '未登录访问 /actuator/prometheus 必须 401');
    const plannerProm = await fetch(`${f12BaseUrl}/actuator/prometheus`, {
      headers: { Authorization: `Bearer ${f12PlannerToken}` }
    });
    assert.equal(plannerProm.status, 403, 'PLANNER 访问 /actuator/prometheus 必须 403');
    return { unauth401: true, planner403: true };
  });

  await runCheck('T3-F12×F11-01', 'Tier3', 'F12×F11', async () => {
    const collabRollId = `F12-COLLAB-${tagUpper}`;
    const rec = await apiJsonOn(
      f12BaseUrl,
      '/api/v2/inventory-receipts',
      {
        method: 'POST',
        body: JSON.stringify({
          supplierName: 'F12协同织造',
          deliveryNoteNo: `DN-COLLAB-${tagUpper}`,
          operator: 'warehouse',
          rolls: [
            {
              id: collabRollId,
              materialModel: 'F12-MOD-0',
              materialType: 'CANVAS',
              color: '米白',
              batchNo: 'B-COL',
              widthMm: 1600,
              totalLengthMm: 15000,
              storageLocation: 'Z-9',
              inspectionStatus: 'PENDING'
            }
          ]
        })
      },
      f12WhToken
    );
    assert.equal(rec.status, 200);
    const insp = await apiJsonOn(
      f12BaseUrl,
      `/api/v2/quality/rolls/${encodeURIComponent(collabRollId)}/inspect-complete`,
      { method: 'POST', body: JSON.stringify({ status: 'PASSED', inspector: 'inspector' }) },
      f12InspToken
    );
    assert.equal(insp.status, 200);

    // 通过 F12 UI 或 API 定位最新审计事件（并用 Playwright 浏览器登录 F12 UI 检索确认）
    const { ctx: f12UiCtx, page: f12UiPage } = await createTrackedContext(browser);
    try {
      await loginInBrowser(f12UiPage, f12BaseUrl, 'admin', 'admin123');
      await f12UiPage.goto(`${f12BaseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
      await f12UiPage.locator('#audit-target-id').fill(collabRollId);
      await f12UiPage.getByRole('button', { name: '检索', exact: true }).click();
      await f12UiPage
        .locator('tbody tr')
        .filter({ hasText: 'QUALITY_ROLL_INSPECT_COMPLETE' })
        .first()
        .waitFor({ state: 'visible', timeout: 10000 });
    } finally {
      await f12UiCtx.close();
    }

    const recon = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger/reconciliation', {}, f12AdminToken);
    assert.equal(recon.data?.status, 'BALANCED');
    const promText = await (
      await fetch(`${f12BaseUrl}/actuator/prometheus`, { headers: { Authorization: `Bearer ${f12AdminToken}` } })
    ).text();
    const { maxSum, usedSum } = parsePrometheusHeapBytes(promText);
    assert.ok(usedSum < maxSum);
    return { collabRollId, auditFoundInUi: true, balanced: true, heapUsedBytes: usedSum };
  });

  await runCheck('T2-F12-05', 'Tier2', 'F12', async () => {
    const persistRollId = `F12-PERSIST-${tagUpper}`;
    const saveRes = await apiJsonOn(
      f12BaseUrl,
      '/api/v2/rolls',
      {
        method: 'POST',
        body: JSON.stringify({
          rollId: persistRollId,
          rollModel: 'F12-MOD-0',
          width: 1600,
          totalLength: 10000,
          usedLength: 0,
          currentRemainingLength: 10000,
          inspectionStatus: 'PASSED'
        })
      },
      f12WhToken
    );
    assert.equal(saveRes.status, 200);

    const beforeRecon = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger/reconciliation', {}, f12AdminToken);
    const beforeAudit = await apiJsonOn(f12BaseUrl, '/api/v2/audit-logs?page=0&size=1', {}, f12AdminToken);
    const entryBefore = beforeRecon.data.entryCount;
    const auditBefore = beforeAudit.data.total;

    await stopIsolatedJava(f12ChildPid);
    f12ChildPid = null;

    const restarted = await startIsolatedJava({
      jarPath,
      port: f12Port,
      statePath: f12StatePath,
      logFile: path.join(f12TmpDir, 'f12-restart.log'),
      jvmOpts: ['-Xms64m', '-Xmx256m', '-XX:+ExitOnOutOfMemoryError']
    });
    f12ChildPid = restarted.pid;
    const restartedAdminTok = (await loginAs(f12BaseUrl, 'admin', 'admin123')).token;

    const afterRecon = await apiJsonOn(f12BaseUrl, '/api/v2/inventory-ledger/reconciliation', {}, restartedAdminTok);
    const afterAudit = await apiJsonOn(f12BaseUrl, '/api/v2/audit-logs?page=0&size=1', {}, restartedAdminTok);
    const rollLookup = await apiJsonOn(
      f12BaseUrl,
      `/api/v2/audit-logs?targetId=${encodeURIComponent(persistRollId)}&action=ROLL_SAVE`,
      {},
      restartedAdminTok
    );
    assert.equal(afterRecon.data.status, 'BALANCED');
    assert.equal(afterRecon.data.entryCount, entryBefore);
    assert.ok(afterAudit.data.total >= auditBefore);
    assert.ok(rollLookup.data.total >= 1, '重启后新写入母卷与审计记录必须持久化存在');
    return { entryCount: afterRecon.data.entryCount, auditTotalAfter: afterAudit.data.total, restartMs: restarted.readyMs };
  });

  // 结束 F12 子进程与临时目录，释放资源供后续浏览器用例流畅运行
  await stopIsolatedJava(f12ChildPid);
  f12ChildPid = null;
  fs.rmSync(f12TmpDir, { recursive: true, force: true });
  f12TmpDir = null;

  // ==================== Tier 3 剩余 3 组跨特性组合 ====================
  await runCheck('T3-F10×F11-01', 'Tier3', 'F10×F11', async () => {
    const pairUser = `e2e_pair_${tag}`;
    const createPairRes = await apiJson(
      '/api/v2/users',
      {
        method: 'POST',
        body: JSON.stringify({
          username: pairUser,
          displayName: '组合测试计划员',
          role: 'PLANNER',
          password: 'PairPass#1'
        })
      },
      adminToken
    );
    assert.equal(createPairRes.status, 201);

    const { ctx: pairCtx, page: pairPage } = await createTrackedContext(browser);
    try {
      await loginInBrowser(pairPage, baseUrl, pairUser, 'PairPass#1');
      await pairPage.goto(`${baseUrl}/app/#/workbench`, { waitUntil: 'networkidle' });
      await pairPage.locator('[data-testid="draft-inbox-trigger"]').waitFor({ state: 'visible', timeout: 15000 });

      // 保持页面不刷新，后台管理员禁用该账号
      const disableRes = await apiJson(
        `/api/v2/users/${encodeURIComponent(pairUser)}/status`,
        { method: 'POST', body: JSON.stringify({ enabled: false }) },
        adminToken
      );
      assert.equal(disableRes.status, 200);

      // 页面点击触发一次业务 API 请求（打开待审草案收件箱发起 GET /api/v2/workbench/drafts）
      await pairPage.locator('[data-testid="draft-inbox-trigger"]').click();
      await pairPage.waitForFunction(
        () => window.location.hash.startsWith('#/login?redirect=%23%2Fworkbench'),
        null,
        { timeout: 15000 }
      );
      const tokenAfter = await pairPage.evaluate(() => localStorage.getItem('cutplan.auth.token'));
      assert.equal(tokenAfter, null, '遭遇 401 后本地 Token 必须清空');
      await pairPage.getByText('会话令牌已失效或已过期，请重新登录').waitFor({ state: 'visible', timeout: 10000 });

      const statusAudit = await apiJson(
        `/api/v2/audit-logs?action=USER_STATUS_CHANGE&targetId=${encodeURIComponent(pairUser)}`,
        {},
        adminToken
      );
      assert.equal(statusAudit.status, 200);
      assert.ok(statusAudit.data.total >= 1, '审计表必须记录 USER_STATUS_CHANGE');
      return { pairUser, redirectedToLoginWithNotice: true, auditCount: statusAudit.data.total };
    } finally {
      await pairCtx.close();
    }
  });

  await runCheck('T3-F11×F08-01', 'Tier3', 'F11×F08/F09', async () => {
    // 1) ADMIN 签发新受限 Agent（不含确认落库权限）
    const issueRes = await apiJson(
      '/api/v2/agents',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `pair-collab-agent-${tag}`,
          scopes: ['DEMAND_READ', 'INVENTORY_READ', 'PLAN_COMPUTE', 'DRAFT_WRITE'],
          ttlHours: 12
        })
      },
      adminToken
    );
    assert.equal(issueRes.status, 201);
    const pairAgentId = issueRes.data.agent.agentId;
    const pairAgentTok = issueRes.data.token;

    // 2) WAREHOUSE + INSPECTOR + PLANNER 准备多料联排夹具与任务
    const pairModel = `MOD-PAIR-${tagUpper}`;
    const pairRollId = `ROLL-PAIR-${tagUpper}`;
    const pairRemId = `REM-PAIR-${tagUpper}`;
    await apiJson(
      '/api/v2/remnants/register',
      {
        method: 'POST',
        body: JSON.stringify({
          id: pairRemId,
          width: 1000,
          length: 1200,
          location: `P-REM-${tagUpper}`,
          materialBatch: pairModel,
          status: 'AVAILABLE',
          qualityGrade: 'GRADE_A',
          hasDefect: false
        })
      },
      warehouseToken
    );
    const recRes = await apiJson(
      '/api/v2/inventory-receipts',
      {
        method: 'POST',
        body: JSON.stringify({
          supplierName: '协同测试厂',
          deliveryNoteNo: `DN-PAIR-${tagUpper}`,
          operator: 'warehouse',
          rolls: [
            {
              id: pairRollId,
              materialModel: pairModel,
              materialType: 'CANVAS',
              color: '本白',
              batchNo: 'BP-1',
              widthMm: 1500,
              totalLengthMm: 3000,
              storageLocation: 'B-02',
              inspectionStatus: 'PENDING'
            }
          ]
        })
      },
      warehouseToken
    );
    assert.equal(recRes.status, 200);
    const passRes = await apiJson(
      `/api/v2/quality/rolls/${encodeURIComponent(pairRollId)}/inspect-complete`,
      { method: 'POST', body: JSON.stringify({ status: 'PASSED', inspector: 'inspector' }) },
      inspectorToken
    );
    assert.equal(passRes.status, 200);

    const taskRes = await apiJson(
      '/api/v2/demand-pool',
      {
        method: 'POST',
        body: JSON.stringify({
          name: `协同联排-${tagUpper}`,
          materialModel: pairModel,
          dimension: 'RECT_2D',
          bedLengthMm: 3000,
          trimStartMm: 0,
          pieceGapMm: 10,
          demands: [{ id: 1, name: '协同主片', width: 700, length: 900, quantity: 4, allowRotation: true }]
        })
      },
      plannerToken
    );
    assert.equal(taskRes.status, 200);
    const pairTaskId = taskRes.data.id;

    // 3) Agent 通过真实 MCP stdio 调 plan_multi_material_drafts 生成批量草案组
    const pairMcp = await openMcpClient(baseUrl, pairAgentTok);
    let targetDraftId = null;
    try {
      const batchRes = await pairMcp.client.callTool({
        name: 'plan_multi_material_drafts',
        arguments: {
          taskId: pairTaskId,
          continueAcrossRolls: true,
          includePreview: false,
          ttlSeconds: 900,
          note: `T3协同草案-${tagUpper}`
        }
      });
      assert.ok(!batchRes.isError, `MCP plan_multi_material_drafts 失败: ${JSON.stringify(batchRes)}`);
      const batchData = batchRes.structuredContent?.data;
      assert.equal(batchData?.inventoryMutated, false);
      assert.ok(Array.isArray(batchData?.drafts) && batchData.drafts.length >= 1);
      targetDraftId = batchData.drafts[0].draftId;
    } finally {
      await pairMcp.transport.close().catch(() => {});
    }

    // 4) Agent 越权直接 confirm 吃 403
    const deniedConfirm = await apiJson(
      `/api/v2/workbench/drafts/${encodeURIComponent(targetDraftId)}/confirm`,
      { method: 'POST', body: '{}' },
      pairAgentTok
    );
    assert.equal(deniedConfirm.status, 403, 'Agent 严禁确认草案落库');

    // 5) 人类 PLANNER 登录工作台打开深链点击「选定此方案」落库 CONFIRMED
    await plannerPage.goto(
      `${baseUrl}/app/#/workbench?taskId=${encodeURIComponent(pairTaskId)}&draftId=${encodeURIComponent(targetDraftId)}`,
      { waitUntil: 'networkidle' }
    );
    await plannerPage.locator('[data-testid="external-plan-banner"]').waitFor({ state: 'visible', timeout: 15000 });
    const ctaBtn = plannerPage.locator('button.value-primary-cta');
    await ctaBtn.waitFor({ state: 'visible', timeout: 15000 });
    const [confirmResp] = await Promise.all([
      plannerPage.waitForResponse(
        (r) => r.url().includes('/api/v2/schemes/confirm') && r.request().method() === 'POST'
      ),
      ctaBtn.click()
    ]);
    assert.equal(confirmResp.status(), 200);
    const confirmBody = await confirmResp.json();
    assert.equal(confirmBody.draft?.status, 'CONFIRMED');
    const confirmedSchemeId = confirmBody.scheme.id;

    // 6) ADMIN 在 #/audit-logs 验证 Agent 越权 403 与 PLANNER 成功确认完整责任链
    await adminPage.goto(`${baseUrl}/app/#/audit-logs`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('button', { name: '重置', exact: true }).click();
    await adminPage.locator('#audit-target-id').fill(`/api/v2/workbench/drafts/${targetDraftId}/confirm`);
    await adminPage.locator('#audit-outcome').selectOption('DENIED');
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();
    await adminPage
      .locator('tbody tr')
      .filter({ hasText: pairAgentId })
      .first()
      .waitFor({ state: 'visible', timeout: 10000 });

    await adminPage.getByRole('button', { name: '重置', exact: true }).click();
    await adminPage.locator('#audit-target-id').fill(confirmedSchemeId);
    await adminPage.locator('#audit-actor').fill('planner');
    await adminPage.getByRole('button', { name: '检索', exact: true }).click();
    await adminPage
      .locator('tbody tr')
      .filter({ hasText: 'SCHEME_CONFIRM' })
      .first()
      .waitFor({ state: 'visible', timeout: 10000 });

    return { pairAgentId, targetDraftId, confirmedSchemeId, chainVerifiedInUi: true };
  });

  await runCheck('T3-F10×F02-01', 'Tier3', 'F10×F02', async () => {
    await plannerPage.goto(`${baseUrl}/app/#/workbench`, { waitUntil: 'networkidle' });
    const plannerGroupCount = await plannerPage.locator('nav .nav-group').count();
    const plannerNavCount = await plannerPage.locator('nav .nav-main a[href^="#/"]').count();
    assert.equal(plannerGroupCount, 5, `PLANNER 分组应为 5，实际 ${plannerGroupCount}`);
    assert.equal(plannerNavCount, 12, `PLANNER 导航数应为 12，实际 ${plannerNavCount}`);
    assert.equal(await plannerPage.locator('nav .nav-main a[href="#/profile"]').count(), 0);
    assert.equal(await plannerPage.locator('nav .nav-main a[href="#/users"]').count(), 0);
    assert.equal(await plannerPage.locator('nav .nav-main a[href="#/audit-logs"]').count(), 0);

    await plannerPage.locator('[data-testid="account-menu-trigger"]').click();
    await plannerPage.locator('[data-testid="account-logout-btn"]').click();
    await plannerPage.waitForFunction(() => window.location.hash.startsWith('#/login'), null, { timeout: 15000 });

    await plannerPage.locator('#login-username').fill(authAdminUser);
    await plannerPage.locator('#login-password').fill(authAdminPass);
    await plannerPage.getByRole('button', { name: '登录并进入系统', exact: true }).click();
    await plannerPage.locator('[data-testid="account-menu-trigger"]').waitFor({ state: 'visible', timeout: 15000 });

    const adminNavCount = await plannerPage.locator('nav .nav-main a[href^="#/"]').count();
    const adminGroupCount = await plannerPage.locator('nav .nav-group').count();
    assert.equal(adminGroupCount, 6, `ADMIN 分组应为 6，实际 ${adminGroupCount}`);
    assert.equal(adminNavCount, 14, `ADMIN 导航数应为 14，实际 ${adminNavCount}`);
    return { plannerGroupCount, plannerNavCount, adminNavCount, adminGroupCount };
  });
} catch (err) {
  failedError = err;
  try {
    const firstCtx = contextsToClose[0];
    const firstPage = firstCtx?.pages?.()[0];
    if (firstPage && !firstPage.isClosed()) {
      const ssPath = resultFile
        ? resultFile.replace(/\.result\.json$/i, '.fail.png')
        : path.join(os.tmpdir(), `auth-rbac-fail-${tag}.png`);
      await firstPage.screenshot({ path: ssPath, fullPage: true });
      failureScreenshot = ssPath;
    }
  } catch {}
} finally {
  for (const { transport } of mcpClientsToClose) {
    await transport.close().catch(() => {});
  }
  for (const ctx of contextsToClose) {
    await ctx.close().catch(() => {});
  }
  await browser.close().catch(() => {});
  if (f12ChildPid) {
    await stopIsolatedJava(f12ChildPid);
  }
  if (f12TmpDir && fs.existsSync(f12TmpDir)) {
    fs.rmSync(f12TmpDir, { recursive: true, force: true });
  }
}

const prodStateAfter = sha256File(PROD_STATE_FILE);
const prodDraftsAfter = fingerprintDir(PROD_DRAFTS_DIR);
const prodInventoryUntouched = prodStateAfter === prodStateBefore;
const prodDraftsUntouched = prodDraftsAfter === prodDraftsBefore;

assert.equal(pageErrors.length, 0, `发生未捕获前端 pageerror: ${pageErrors.join(' | ')}`);
assert.equal(nativeDialogs.length, 0, `禁止使用原生 alert/confirm/prompt: ${nativeDialogs.join(' | ')}`);
assert.equal(prodInventoryUntouched, true, '正式 data/cutdemo-state.json SHA-256 发生变更！');
assert.equal(prodDraftsUntouched, true, '正式 data/cutdemo-state.json.drafts 指纹发生变更！');

const passedCount = checks.filter((c) => c.status === 'PASS').length;
const failedCount = checks.filter((c) => c.status === 'FAIL').length;

const summary = {
  script: 'auth-rbac-agent-audit',
  baseUrl,
  executed: checks.length,
  passed: passedCount,
  failed: failedCount,
  skipped: 0,
  checks,
  pageErrors,
  nativeDialogs,
  failureScreenshot,
  prodInventoryUntouched,
  prodDraftsUntouched
};

if (resultFile) {
  fs.mkdirSync(path.dirname(path.resolve(resultFile)), { recursive: true });
  fs.writeFileSync(path.resolve(resultFile), JSON.stringify(summary, null, 2), 'utf8');
}

console.log(JSON.stringify(summary, null, 2));

if (failedError || failedCount > 0 || checks.length !== 35) {
  if (failedError) {
    console.error(failedError);
  }
  process.exitCode = 1;
}
