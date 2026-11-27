#!/usr/bin/env node
/**
 * CurDemoTwo 项目级真机隔离验收控制脚本（零外部依赖，跨平台）。
 *
 * 子命令：
 *   launch  [--port 18091] [--run-id <id>] [--jar <path>] [--evidence-dir <dir>]
 *           [--jvm-opts "<opts>"] [--auth] [--auth-secret <secret>] [--auth-users <users>] [--timeout-sec 45]
 *   doctor  --session <session.json> [--auth-user <user>] [--auth-pass <pass>] [--auth-token <token>]
 *   drive   --session <session.json> --script <ui-preview|unified-workflow|closure-perf|garment-width|mcp-live-smoke|deeplink-and-cutplan|workflow-gate-smoke|drafts-inbox-and-relay|inspection-and-slitting|auth-rbac-agent-audit|import-export-and-benchmark>
 *           [--perf-budget-ms 120] [--api-token <token>] [--agent-token <token>] [--revoke-agent-id <id>]
 *   cleanup --session <session.json>
 *
 * 安全红线：
 *   1. 严禁连接或启停 8080 端口；
 *   2. 状态、作业、Outbox 与工作台草案目录全量显式隔离于临时目录，绝不写入正式 data/；
 *   3. 清理仅按会话 PID 精准停服并删除临时目录，绝不按进程名误杀，且绝不删除证据目录。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PROD_STATE_FILE = path.join(REPO_ROOT, 'data', 'cutdemo-state.json');
const PROD_DRAFTS_DIR = path.join(REPO_ROOT, 'data', 'cutdemo-state.json.drafts');
const DEFAULT_JAR = path.join(REPO_ROOT, 'target', 'CutDemoTwo-0.0.1-SNAPSHOT.jar');
const VERIFY_BASE_TMP = path.join(os.tmpdir(), 'cutdemo-verify');
const require = createRequire(import.meta.url);

const SCRIPTS = {
  'ui-preview': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-ui-preview.cjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false
  },
  'unified-workflow': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-unified-workflow.cjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false
  },
  'closure-perf': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-react-closure-and-perf.cjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false,
    supportsResultFile: true
  },
  'garment-width': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'garment-width.cjs'),
    runner: 'node-test',
    needsBrowser: true,
    needsTestRunner: true
  },
  'mcp-live-smoke': {
    file: path.join(REPO_ROOT, 'integrations', 'mcp', 'test', 'live-smoke.mjs'),
    runner: 'node',
    needsBrowser: false,
    needsTestRunner: false,
    mcpSmokeEnv: true
  },
  'deeplink-and-cutplan': {
    file: path.join(__dirname, 'verify-deeplink-and-cutplan.mjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false
  },
  'workflow-gate-smoke': {
    file: path.join(__dirname, 'verify-workflow-gate.mjs'),
    runner: 'node',
    needsBrowser: false,
    needsTestRunner: false,
    supportsResultFile: true
  },
  'drafts-inbox-and-relay': {
    file: path.join(__dirname, 'verify-drafts-inbox-and-relay.mjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false,
    supportsResultFile: true
  },
  'inspection-and-slitting': {
    file: path.join(__dirname, 'verify-inspection-and-slitting.mjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false,
    supportsResultFile: true
  },
  'auth-rbac-agent-audit': {
    file: path.join(__dirname, 'verify-auth-rbac-agent-audit.mjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false,
    supportsResultFile: true,
    passAuthEnv: true
  },
  'import-export-and-benchmark': {
    file: path.join(__dirname, 'verify-import-export-and-benchmark.mjs'),
    runner: 'node',
    needsBrowser: true,
    needsTestRunner: false,
    supportsResultFile: true,
    passAuthEnv: true
  }
};

const FORBIDDEN_JVM_PROP_PREFIXES = [
  '-Dserver.port',
  '-Dserver.address',
  '-Dcutdemo.state.path',
  '-Dcutdemo.jobs.path',
  '-Dcutdemo.integration.path',
  '-Dcutdemo.workbench.drafts.path',
  '-Dcutdemo.auth',
  '-Dcutdemo.seed-demo-data'
];

const ALLOWED_JVM_OPT_RE =
  /^-(X(ms|mx|ss|mn)[0-9]+[kmgKMG]?|X(log|share|showSettings)(:.*)?|XX:[+-]?[A-Za-z0-9_]+(=.*)?|D[A-Za-z0-9_.-]+(=.*)?|server|ea|da|esa|dsa)$/;

function parseJvmOpts(raw) {
  if (raw === undefined || raw === null) return [];
  const text = String(raw).trim();
  if (!text) return [];
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error(`--jvm-opts 引号未闭合: ${raw}`);
  }
  if (current) {
    tokens.push(current);
  }
  for (const opt of tokens) {
    if (!opt.startsWith('-')) {
      throw new Error(`--jvm-opts 每个参数必须以 '-' 开头: ${opt}`);
    }
    const baseFlag = opt.split('=')[0].toLowerCase();
    if (['-jar', '-cp', '-classpath', '-p', '--module-path', '-m', '--module'].includes(baseFlag)) {
      throw new Error(`--jvm-opts 禁止指定启动/类路径参数: ${opt}`);
    }
    const lower = opt.toLowerCase();
    for (const prefix of FORBIDDEN_JVM_PROP_PREFIXES) {
      const pLower = prefix.toLowerCase();
      if (lower === pLower || lower.startsWith(`${pLower}=`) || lower.startsWith(`${pLower}.`)) {
        throw new Error(`--jvm-opts 禁止覆盖隔离路径或认证开关: ${opt}`);
      }
    }
    if (!ALLOWED_JVM_OPT_RE.test(opt)) {
      throw new Error(`--jvm-opts 包含不在白名单内的 JVM 参数: ${opt}`);
    }
  }
  return tokens;
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的位置参数: ${token}`);
    }
    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      const key = token.slice(2, eqIdx);
      const val = token.slice(eqIdx + 1);
      if (!key) {
        throw new Error(`无效参数: ${token}`);
      }
      if (key === 'auth') {
        flags.auth = val !== 'false' && val !== '0';
      } else {
        flags[key] = val;
      }
      continue;
    }
    const key = token.slice(2);
    if (key === 'auth') {
      flags.auth = true;
      continue;
    }
    const val = rest[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error(`参数 --${key} 缺少取值`);
    }
    flags[key] = val;
    i++;
  }
  return { command, flags };
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
    return;
  }
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

function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function fetchJsonOrText(url, timeoutMs = 4000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function postJsonOrText(url, body, timeoutMs = 4000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, status: 0, text: '', json: null, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
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

function resolvePlaywrightModule(needsTestRunner) {
  if (process.env.PLAYWRIGHT_MODULE) {
    return process.env.PLAYWRIGHT_MODULE;
  }
  const home = os.homedir();
  const directNames = needsTestRunner
    ? ['playwright/test', '@playwright/test']
    : ['playwright', 'playwright-core'];
  for (const name of directNames) {
    try {
      return require.resolve(name, { paths: [REPO_ROOT, path.join(REPO_ROOT, 'frontend')] });
    } catch {}
  }

  const extraCandidates = [];
  if (needsTestRunner) {
    extraCandidates.push(
      path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'test.js'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@playwright', 'test', 'index.js'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright', 'test.js')
    );
  } else {
    extraCandidates.push(
      path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
      path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright-core'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'openclaw', 'node_modules', 'playwright-core'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
      path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright-core')
    );
  }

  for (const cand of extraCandidates) {
    if (fs.existsSync(cand)) {
      try {
        return require.resolve(cand);
      } catch {
        return cand;
      }
    }
  }
  return null;
}

function readSession(sessionPath) {
  if (!sessionPath) throw new Error('必须提供 --session <session.json>');
  const resolved = path.resolve(sessionPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到验收会话文件: ${resolved}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!data.port || Number(data.port) === 8080) {
    throw new Error(`非法端口配置（严禁 8080）: ${data.port}`);
  }
  return { resolved, data };
}

async function cmdLaunch(flags) {
  const port = Number(flags.port || 18091);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`无效端口: ${flags.port}`);
  }
  if (port === 8080) {
    throw new Error('严禁使用正式服务端口 8080，请指定独立隔离端口（如 18091）');
  }
  const jarPath = path.resolve(flags.jar || DEFAULT_JAR);
  if (!fs.existsSync(jarPath)) {
    throw new Error(`未找到可执行 JAR: ${jarPath}，请先运行 .\\mvnw.cmd -DskipTests package`);
  }
  const free = await checkPortFree(port);
  if (!free) {
    throw new Error(`端口 ${port} 已被占用，请更换隔离端口或先清理已有测试实例`);
  }

  const runId =
    flags['run-id'] ||
    `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(3).toString('hex')}`;
  const tmpDir = path.join(VERIFY_BASE_TMP, `run-${runId}`);
  const evidenceDir = path.resolve(
    flags['evidence-dir'] || path.join(VERIFY_BASE_TMP, `evidence-${runId}`)
  );
  if (evidenceDir === tmpDir || evidenceDir.startsWith(tmpDir + path.sep)) {
    throw new Error('证据目录不得位于临时运行目录内，否则 cleanup 会误删证据');
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const statePath = path.join(tmpDir, 'cutdemo-state.json');
  const logFile = path.join(tmpDir, 'server.log');
  const sessionFile = path.join(VERIFY_BASE_TMP, `${runId}.session.json`);
  const jarStat = fs.statSync(jarPath);
  const prodHashBefore = sha256File(PROD_STATE_FILE);
  const prodDraftsBefore = fingerprintDir(PROD_DRAFTS_DIR);

  const jvmOpts = parseJvmOpts(flags['jvm-opts']);

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
    '--cutdemo.seed-demo-data=true'
  ];
  if (flags.auth) {
    javaArgs.push('--cutdemo.auth.enabled=true');
    const secret = flags['auth-secret'] || 'verify-cutdemotwo-isolated-secret-32bytes-min';
    javaArgs.push(`--cutdemo.auth.secret=${secret}`);
    if (flags['auth-users']) {
      javaArgs.push(`--cutdemo.auth.users=${flags['auth-users']}`);
    }
  } else {
    javaArgs.push('--cutdemo.auth.enabled=false');
  }

  const outFd = fs.openSync(logFile, 'w');
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

  const baseUrl = `http://127.0.0.1:${port}`;
  const timeoutSec = Number(flags['timeout-sec'] || 45);
  const deadline = Date.now() + timeoutSec * 1000;
  let readyInfo = null;

  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid)) {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`隔离服务进程提前退出（pid=${child.pid}）。日志尾部:\n${tail}`);
    }
    const appRes = await fetchJsonOrText(`${baseUrl}/app/`, 2000);
    if (flags.auth) {
      const meRes = await fetchJsonOrText(`${baseUrl}/api/v2/auth/me`, 2000);
      if (appRes.status === 200 && meRes.ok && meRes.json?.enabled === true) {
        readyInfo = { mode: 'auth', authMe: meRes.json };
        break;
      }
    } else {
      const healthRes = await fetchJsonOrText(`${baseUrl}/api/health`, 2000);
      if (
        appRes.status === 200 &&
        healthRes.ok &&
        healthRes.json?.status === 'UP' &&
        healthRes.json?.storageStatus === 'UP'
      ) {
        readyInfo = { mode: 'local', health: healthRes.json };
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!readyInfo) {
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : '';
    killPidTree(child.pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`隔离服务在 ${timeoutSec}s 内未达到就绪状态（已自动清理进程与临时目录）。日志尾部:\n${tail}`);
  }

  const session = {
    runId,
    pid: child.pid,
    port,
    baseUrl,
    authEnabled: Boolean(flags.auth),
    jvmOpts,
    jarPath,
    jarMtimeMs: jarStat.mtimeMs,
    jarSize: jarStat.size,
    tmpDir,
    statePath,
    logFile,
    evidenceDir,
    prodStateFile: PROD_STATE_FILE,
    prodStateSha256Before: prodHashBefore,
    prodDraftsDir: PROD_DRAFTS_DIR,
    prodDraftsFingerprintBefore: prodDraftsBefore,
    startedAt: new Date().toISOString()
  };
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        status: 'READY',
        sessionFile,
        pid: session.pid,
        baseUrl: session.baseUrl,
        authEnabled: session.authEnabled,
        jvmOpts: session.jvmOpts,
        evidenceDir: session.evidenceDir,
        prodStateSha256Before: session.prodStateSha256Before,
        readyInfo
      },
      null,
      2
    )
  );
}

async function cmdDoctor(flags) {
  const { resolved, data: s } = readSession(flags.session);
  const checks = [];
  let healthy = true;

  const pidAlive = isPidAlive(s.pid);
  checks.push({ name: 'process_alive', pass: pidAlive, detail: `pid=${s.pid}` });
  if (!pidAlive) healthy = false;

  const jarCurrentStat = fs.existsSync(s.jarPath) ? fs.statSync(s.jarPath) : null;
  const jarFresh = Boolean(
    jarCurrentStat && jarCurrentStat.mtimeMs === s.jarMtimeMs && jarCurrentStat.size === s.jarSize
  );
  checks.push({
    name: 'jar_matches_running_instance',
    pass: jarFresh,
    detail: jarFresh ? 'JAR 与启动时一致' : '磁盘 JAR 已更新，请重启隔离实例'
  });
  if (!jarFresh) healthy = false;

  const appRes = await fetchJsonOrText(`${s.baseUrl}/app/`, 3000);
  checks.push({ name: 'app_entry_http_200', pass: appRes.status === 200, detail: `HTTP ${appRes.status}` });
  if (appRes.status !== 200) healthy = false;

  let authHeaders = {};
  if (s.authEnabled) {
    const meRes = await fetchJsonOrText(`${s.baseUrl}/api/v2/auth/me`, 3000);
    const ok = meRes.ok && meRes.json?.enabled === true;
    checks.push({ name: 'auth_endpoint_enabled', pass: ok, detail: JSON.stringify(meRes.json || meRes.status) });
    if (!ok) healthy = false;

    let bearerToken = flags['auth-token'] ? String(flags['auth-token']).trim() : '';
    if (bearerToken) {
      const tokenMeRes = await fetchJsonOrText(`${s.baseUrl}/api/v2/auth/me`, 3000, {
        Authorization: `Bearer ${bearerToken}`
      });
      const tokenOk = tokenMeRes.ok && tokenMeRes.json?.authenticated === true;
      checks.push({
        name: 'auth_doctor_login',
        pass: tokenOk,
        detail: tokenOk
          ? `token(${tokenMeRes.json.username || ''}, role=${tokenMeRes.json.role || ''})`
          : `HTTP ${tokenMeRes.status}`
      });
      if (!tokenOk) {
        healthy = false;
        bearerToken = '';
      }
    } else {
      const authUser = flags['auth-user'] || 'admin';
      const authPass = flags['auth-pass'] || 'admin123';
      const loginRes = await postJsonOrText(
        `${s.baseUrl}/api/v2/auth/login`,
        { username: authUser, password: authPass },
        3000
      );
      const loginOk = loginRes.ok && Boolean(loginRes.json?.token);
      checks.push({
        name: 'auth_doctor_login',
        pass: loginOk,
        detail: loginOk
          ? `user=${loginRes.json.username || authUser}, role=${loginRes.json.role || ''}`
          : `HTTP ${loginRes.status}: ${loginRes.text || loginRes.error || ''}`
      });
      if (loginOk) {
        bearerToken = loginRes.json.token;
      } else {
        healthy = false;
      }
    }
    if (bearerToken) {
      authHeaders = { Authorization: `Bearer ${bearerToken}` };
    }
  }

  const healthRes = await fetchJsonOrText(`${s.baseUrl}/api/health`, 3000, authHeaders);
  const hOk = healthRes.ok && healthRes.json?.status === 'UP' && healthRes.json?.storageStatus === 'UP';
  checks.push({
    name: 'api_health_up',
    pass: hOk,
    detail: hOk
      ? `revision=${healthRes.json.revision}, remnants=${healthRes.json.remnantsInStock}`
      : `HTTP ${healthRes.status}`
  });
  if (!hOk) healthy = false;

  const reconRes = await fetchJsonOrText(`${s.baseUrl}/api/v2/inventory-ledger/reconciliation`, 3000, authHeaders);
  const rOk = reconRes.ok && (reconRes.json?.status === 'BALANCED' || reconRes.json?.balanced === true);
  const reconSummary = reconRes.ok
    ? JSON.stringify({
        status: reconRes.json?.status,
        revision: reconRes.json?.revision,
        entryCount: reconRes.json?.entryCount,
        issueCount: Array.isArray(reconRes.json?.issues) ? reconRes.json.issues.length : null,
        issues: Array.isArray(reconRes.json?.issues) ? reconRes.json.issues.slice(0, 5) : reconRes.json?.issues
      })
    : `HTTP ${reconRes.status}`;
  checks.push({
    name: 'ledger_reconciliation_balanced',
    pass: rOk,
    detail: reconSummary
  });
  if (!rOk) healthy = false;

  const prodHashNow = sha256File(s.prodStateFile);
  const prodUntouched = prodHashNow === s.prodStateSha256Before;
  checks.push({
    name: 'prod_inventory_untouched',
    pass: prodUntouched,
    detail: prodUntouched ? 'SHA-256 零变动' : `变更: ${s.prodStateSha256Before} -> ${prodHashNow}`
  });
  if (!prodUntouched) healthy = false;

  const prodDraftsNow = fingerprintDir(s.prodDraftsDir || PROD_DRAFTS_DIR);
  const prodDraftsUntouched =
    s.prodDraftsFingerprintBefore === undefined || prodDraftsNow === s.prodDraftsFingerprintBefore;
  checks.push({
    name: 'prod_drafts_untouched',
    pass: prodDraftsUntouched,
    detail: prodDraftsUntouched ? '正式草案目录零变动' : `变更: ${s.prodDraftsFingerprintBefore} -> ${prodDraftsNow}`
  });
  if (!prodDraftsUntouched) healthy = false;

  const browserPath = resolveBrowserExecutable();
  const pwModule = resolvePlaywrightModule(false);
  const pwTestModule = resolvePlaywrightModule(true);
  const report = {
    status: healthy ? 'HEALTHY' : 'UNHEALTHY',
    sessionFile: resolved,
    baseUrl: s.baseUrl,
    evidenceDir: s.evidenceDir,
    environment: {
      browserExecutable: browserPath,
      playwrightModule: pwModule,
      playwrightTestModule: pwTestModule
    },
    checks
  };
  console.log(JSON.stringify(report, null, 2));
  if (!healthy) process.exitCode = 1;
}

async function cmdDrive(flags) {
  const { data: s } = readSession(flags.session);
  const key = flags.script;
  const spec = SCRIPTS[key];
  if (!spec) {
    throw new Error(`未知脚本名 --script ${key}，可选值: ${Object.keys(SCRIPTS).join(', ')}`);
  }
  if (!fs.existsSync(spec.file)) {
    throw new Error(`验收脚本不存在: ${spec.file}`);
  }
  if (!isPidAlive(s.pid)) {
    throw new Error(`隔离实例进程（pid=${s.pid}）已退出，请先重新 launch 或执行 doctor`);
  }

  let pwModule = null;
  let browserExe = null;
  if (spec.needsBrowser) {
    pwModule = resolvePlaywrightModule(spec.needsTestRunner);
    if (!pwModule) {
      throw new Error(
        `未探测到 ${spec.needsTestRunner ? 'playwright/test' : 'playwright / playwright-core'} 模块，请设置环境变量 PLAYWRIGHT_MODULE`
      );
    }
    browserExe = resolveBrowserExecutable();
  }
  const env = {
    ...process.env,
    BASE_URL: s.baseUrl,
    ...(spec.passAuthEnv
      ? {
          JAR_PATH: s.jarPath,
          AUTH_ADMIN_USER: flags['auth-user'] || 'admin',
          AUTH_ADMIN_PASS: flags['auth-pass'] || 'admin123'
        }
      : {}),
    ...(pwModule ? { PLAYWRIGHT_MODULE: pwModule } : {}),
    ...(browserExe ? { CHROME_PATH: browserExe } : {})
  };
  if (spec.mcpSmokeEnv) {
    env.CUTTING_TEST_API_URL = s.baseUrl;
    const effectiveApiToken = flags['api-token'] || (s.authEnabled ? process.env.CUTTING_API_TOKEN : '');
    const effectiveAgentToken = flags['agent-token'] || (s.authEnabled ? process.env.CUTTING_AGENT_TOKEN : '');
    const effectiveRevokeAgentId =
      flags['revoke-agent-id'] || (s.authEnabled ? process.env.CUTTING_TEST_REVOKE_AGENT_ID : '');
    if (effectiveApiToken) {
      env.CUTTING_API_TOKEN = effectiveApiToken;
    } else {
      delete env.CUTTING_API_TOKEN;
    }
    if (effectiveAgentToken) {
      env.CUTTING_AGENT_TOKEN = effectiveAgentToken;
    } else {
      delete env.CUTTING_AGENT_TOKEN;
    }
    if (effectiveRevokeAgentId) {
      env.CUTTING_TEST_REVOKE_AGENT_ID = effectiveRevokeAgentId;
    } else {
      delete env.CUTTING_TEST_REVOKE_AGENT_ID;
    }
  }

  fs.mkdirSync(s.evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logEvidencePath = path.join(s.evidenceDir, `${key}-${stamp}.log`);
  let resultFilePath = null;
  if (spec.supportsResultFile) {
    resultFilePath = path.join(s.evidenceDir, `${key}-${stamp}.result.json`);
    env.RESULT_FILE = resultFilePath;
    if (flags['perf-budget-ms']) {
      env.PERF_P95_BUDGET_MS = String(flags['perf-budget-ms']);
    }
  }

  const nodeArgs = spec.runner === 'node-test' ? ['--test', spec.file] : [spec.file];
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  const durationMs = Date.now() - startedAt;

  const combinedLog = [
    `# Drive Evidence: ${key}`,
    `# Timestamp: ${new Date().toISOString()}`,
    `# BaseURL: ${s.baseUrl}`,
    `# Script: ${path.relative(REPO_ROOT, spec.file)}`,
    `# Playwright: ${pwModule || '(not required)'}`,
    `# Browser: ${spec.needsBrowser ? browserExe || '(playwright bundled)' : '(not required)'}`,
    `# ExitCode: ${res.status}`,
    `# DurationMs: ${durationMs}`,
    '',
    '=== STDOUT ===',
    res.stdout || '',
    '=== STDERR ===',
    res.stderr || ''
  ].join('\n');
  fs.writeFileSync(logEvidencePath, combinedLog, 'utf8');

  console.log(
    JSON.stringify(
      {
        script: key,
        exitCode: res.status,
        durationMs,
        logEvidencePath,
        resultFilePath: resultFilePath && fs.existsSync(resultFilePath) ? resultFilePath : null,
        stdoutTail: (res.stdout || '').trim().split(/\r?\n/).slice(-20).join('\n'),
        stderrTail: (res.stderr || '').trim().split(/\r?\n/).slice(-10).join('\n')
      },
      null,
      2
    )
  );
  if (res.status !== 0) process.exitCode = res.status || 1;
}

async function cmdCleanup(flags) {
  const { resolved, data: s } = readSession(flags.session);
  const wasAlive = isPidAlive(s.pid);
  if (wasAlive) {
    killPidTree(s.pid);
  }

  // 等待进程退出并释放文件句柄（Windows 上删除临时目录前尤为关键）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && isPidAlive(s.pid)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const stillAlive = isPidAlive(s.pid);

  let tmpRemoved = false;
  if (s.tmpDir && fs.existsSync(s.tmpDir)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(s.tmpDir, { recursive: true, force: true });
        tmpRemoved = !fs.existsSync(s.tmpDir);
        if (tmpRemoved) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    tmpRemoved = true;
  }

  const evidenceExists = Boolean(s.evidenceDir && fs.existsSync(s.evidenceDir));
  const evidenceFiles = evidenceExists ? fs.readdirSync(s.evidenceDir).sort() : [];
  const prodHashAfter = sha256File(s.prodStateFile);
  const prodUntouched = prodHashAfter === s.prodStateSha256Before;
  const prodDraftsAfter = fingerprintDir(s.prodDraftsDir || PROD_DRAFTS_DIR);
  const prodDraftsUntouched =
    s.prodDraftsFingerprintBefore === undefined || prodDraftsAfter === s.prodDraftsFingerprintBefore;
  const portFree = await checkPortFree(s.port);

  if (fs.existsSync(resolved) && !stillAlive) {
    fs.rmSync(resolved, { force: true });
  }

  const ok = !stillAlive && tmpRemoved && evidenceExists && prodUntouched && prodDraftsUntouched && portFree;
  console.log(
    JSON.stringify(
      {
        status: ok ? 'CLEANED' : 'CLEANUP_INCOMPLETE',
        pidKilled: wasAlive && !stillAlive,
        stillAlive,
        portReleased: portFree,
        tmpDirRemoved: tmpRemoved,
        evidencePreserved: evidenceExists,
        evidenceDir: s.evidenceDir,
        evidenceFiles,
        prodInventoryUntouched: prodUntouched,
        prodDraftsUntouched,
        prodStateSha256Before: s.prodStateSha256Before,
        prodStateSha256After: prodHashAfter
      },
      null,
      2
    )
  );
  if (!ok) process.exitCode = 1;
}

async function main() {
  const { command, flags } = parseCli(process.argv.slice(2));
  if (command === 'launch') return cmdLaunch(flags);
  if (command === 'doctor') return cmdDoctor(flags);
  if (command === 'drive') return cmdDrive(flags);
  if (command === 'cleanup') return cmdCleanup(flags);
  throw new Error(
    '用法: node .agents/skills/verify-cutdemotwo/scripts/verify-ctl.mjs <launch|doctor|drive|cleanup> [options]'
  );
}

main().catch((err) => {
  console.error(`[verify-ctl] 失败: ${err?.message || err}`);
  process.exit(2);
});
