#!/usr/bin/env node
/**
 * CurDemoTwo 项目级真机隔离验收控制脚本（零外部依赖，跨平台）。
 *
 * 子命令：
 *   launch  [--port 18091] [--run-id <id>] [--jar <path>] [--evidence-dir <dir>]
 *           [--auth] [--auth-secret <secret>] [--auth-users <users>] [--timeout-sec 45]
 *   doctor  --session <session.json>
 *   drive   --session <session.json> --script <ui-preview|unified-workflow|closure-perf|garment-width>
 *           [--perf-budget-ms 120]
 *   cleanup --session <session.json>
 *
 * 安全红线：
 *   1. 严禁连接或启停 8080 端口；
 *   2. 数据、作业与 Outbox 全量隔离于临时目录，绝不写入正式 data/cutdemo-state.json；
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
const DEFAULT_JAR = path.join(REPO_ROOT, 'target', 'CutDemoTwo-0.0.1-SNAPSHOT.jar');
const VERIFY_BASE_TMP = path.join(os.tmpdir(), 'cutdemo-verify');
const require = createRequire(import.meta.url);

const SCRIPTS = {
  'ui-preview': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-ui-preview.cjs'),
    runner: 'node',
    needsTestRunner: false
  },
  'unified-workflow': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-unified-workflow.cjs'),
    runner: 'node',
    needsTestRunner: false
  },
  'closure-perf': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'app-react-closure-and-perf.cjs'),
    runner: 'node',
    needsTestRunner: false,
    supportsResultFile: true
  },
  'garment-width': {
    file: path.join(REPO_ROOT, 'src', 'test', 'browser', 'garment-width.cjs'),
    runner: 'node-test',
    needsTestRunner: true
  }
};

function parseCli(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new Error(`无法识别的位置参数: ${token}`);
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

async function fetchJsonOrText(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
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

  const javaArgs = [
    '-jar',
    jarPath,
    `--server.port=${port}`,
    '--server.address=127.0.0.1',
    `--cutdemo.state.path=${statePath}`,
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
    jarPath,
    jarMtimeMs: jarStat.mtimeMs,
    jarSize: jarStat.size,
    tmpDir,
    statePath,
    logFile,
    evidenceDir,
    prodStateFile: PROD_STATE_FILE,
    prodStateSha256Before: prodHashBefore,
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

  if (s.authEnabled) {
    const meRes = await fetchJsonOrText(`${s.baseUrl}/api/v2/auth/me`, 3000);
    const ok = meRes.ok && meRes.json?.enabled === true;
    checks.push({ name: 'auth_endpoint_enabled', pass: ok, detail: JSON.stringify(meRes.json || meRes.status) });
    if (!ok) healthy = false;
  } else {
    const healthRes = await fetchJsonOrText(`${s.baseUrl}/api/health`, 3000);
    const hOk = healthRes.ok && healthRes.json?.status === 'UP' && healthRes.json?.storageStatus === 'UP';
    checks.push({
      name: 'api_health_up',
      pass: hOk,
      detail: hOk
        ? `revision=${healthRes.json.revision}, remnants=${healthRes.json.remnantsInStock}`
        : `HTTP ${healthRes.status}`
    });
    if (!hOk) healthy = false;

    const reconRes = await fetchJsonOrText(`${s.baseUrl}/api/v2/inventory-ledger/reconciliation`, 3000);
    const rOk = reconRes.ok && (reconRes.json?.status === 'BALANCED' || reconRes.json?.balanced === true);
    checks.push({
      name: 'ledger_reconciliation_balanced',
      pass: rOk,
      detail: reconRes.ok ? JSON.stringify(reconRes.json).slice(0, 160) : `HTTP ${reconRes.status}`
    });
    if (!rOk) healthy = false;
  }

  const prodHashNow = sha256File(s.prodStateFile);
  const prodUntouched = prodHashNow === s.prodStateSha256Before;
  checks.push({
    name: 'prod_inventory_untouched',
    pass: prodUntouched,
    detail: prodUntouched ? 'SHA-256 零变动' : `变更: ${s.prodStateSha256Before} -> ${prodHashNow}`
  });
  if (!prodUntouched) healthy = false;

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

  const pwModule = resolvePlaywrightModule(spec.needsTestRunner);
  if (!pwModule) {
    throw new Error(
      `未探测到 ${spec.needsTestRunner ? 'playwright/test' : 'playwright / playwright-core'} 模块，请设置环境变量 PLAYWRIGHT_MODULE`
    );
  }
  const browserExe = resolveBrowserExecutable();
  const env = {
    ...process.env,
    BASE_URL: s.baseUrl,
    PLAYWRIGHT_MODULE: pwModule,
    ...(browserExe ? { CHROME_PATH: browserExe } : {})
  };

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
    `# Playwright: ${pwModule}`,
    `# Browser: ${browserExe || '(playwright bundled)'}`,
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
  const portFree = await checkPortFree(s.port);

  if (fs.existsSync(resolved) && !stillAlive) {
    fs.rmSync(resolved, { force: true });
  }

  const ok = !stillAlive && tmpRemoved && evidenceExists && prodUntouched && portFree;
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
