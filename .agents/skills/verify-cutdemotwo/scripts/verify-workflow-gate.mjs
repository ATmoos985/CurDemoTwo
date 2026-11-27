#!/usr/bin/env node
/**
 * F01 工作流闭环与工程门禁真机/离线双模验收脚本（纯 Node ESM，零外部依赖）。
 *
 * 用法：
 *   1. 通过 verify-ctl.mjs drive 调用：
 *      BASE_URL=http://127.0.0.1:18091 RESULT_FILE=... node .agents/skills/verify-cutdemotwo/scripts/verify-workflow-gate.mjs
 *   2. 独立命令行调用（离线门禁 + 沙盒正负向 CLI 验证）：
 *      node .agents/skills/verify-cutdemotwo/scripts/verify-workflow-gate.mjs --offline-only
 *   3. 独立命令行调用（在线 + 离线完整 13 项）：
 *      node .agents/skills/verify-cutdemotwo/scripts/verify-workflow-gate.mjs --base-url http://127.0.0.1:18091 [--result-file out.json]
 *
 * 安全红线：
 *   - 仅允许连接 127.0.0.1 或 localhost，且端口严格禁止为 8080（否则退出码 2）；
 *   - 沙盒测试全部在 os.tmpdir() 下创建并在 try/finally 中强制清除，绝不写入正式仓库或 data/。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const AUDIT_CLI = path.join(REPO_ROOT, 'scripts', 'workflow-closure-audit.mjs');
const ARCH_CLI = path.join(REPO_ROOT, 'scripts', 'arch-coupling-audit.mjs');
const PROD_STATE_FILE = path.join(REPO_ROOT, 'data', 'cutdemo-state.json');
const PROD_DRAFTS_DIR = path.join(REPO_ROOT, 'data', 'cutdemo-state.json.drafts');
const LOCAL_OPENAPI_FILE = path.join(REPO_ROOT, 'src', 'main', 'resources', 'static', 'api-v2', 'openapi.json');

const EXPECTED_2026_11_24_ARCHIVED_LOGS = [
  'docs/logs/2026-11-24_一维分切条带改用蓝灰单色阶与联动高亮.md',
  'docs/logs/2026-11-24_修复全站数字输入框编辑回弹缺陷.md',
  'docs/logs/2026-11-24_工作台求解过程极简UI与流式交互升级.md',
  'docs/logs/2026-11-24_重构工作台右侧一维参数面板UI与消除重复配置.md',
  'docs/logs/2026-11-24_隐藏前端界面中的底层开源算法名称.md'
];
const EXPECTED_2026_11_27_LOG = 'docs/logs/2026-11-27_前置P0收口与防遗漏工作流闭环.md';

function getHelpText() {
  return [
    '用法：node .agents/skills/verify-cutdemotwo/scripts/verify-workflow-gate.mjs [选项]',
    '',
    '选项：',
    '  --offline-only          仅执行离线仓库门禁与 os.tmpdir() 沙盒正负向 CLI 验证（11 项）',
    '  --base-url <url>        指定非 8080 的本机隔离服务地址（执行全部 13 项检查，优先级高于 BASE_URL）',
    '  --result-file <path>    将结构化 JSON 结果写入指定路径（优先级高于 RESULT_FILE）',
    '  --auth-token <token>    可选，若目标隔离实例启用了 --auth，提供 Bearer Token 防止 401 误判',
    '  -h, --help              显示本帮助信息并退出'
  ].join('\n');
}

function parseCli(argv) {
  const opts = {
    offlineOnly: false,
    baseUrl: null,
    resultFile: null,
    authToken: null,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      opts.help = true;
    } else if (token === '--offline-only') {
      opts.offlineOnly = true;
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
    } else if (token === '--auth-token') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error('参数 --auth-token 缺少取值');
      }
      opts.authToken = argv[++i];
    } else if (token.startsWith('--auth-token=')) {
      opts.authToken = token.slice('--auth-token='.length);
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  return opts;
}

function validateBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) {
    throw new Error('baseUrl 不能为空');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`非法 URL: ${trimmed}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`仅允许 http/https 协议: ${trimmed}`);
  }
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`严禁连接非本机地址（仅允许 127.0.0.1 或 localhost）: ${trimmed}`);
  }
  if (!parsed.port || parsed.port === '8080') {
    throw new Error(`严禁连接默认或正式 8080 端口，必须显式指定非 8080 隔离端口: ${trimmed}`);
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

function createSandboxBaselineFiles(overrides = {}) {
  const base = {
    'src/test/java/com/example/cutdemotwo/persistence/OptimizationTestDatabase.java': [
      'package com.example.cutdemotwo.persistence;',
      'public final class OptimizationTestDatabase {',
      '  public static Object create() { return "jdbc:h2:mem:helper"; }',
      '}'
    ].join('\n'),
    'src/test/java/com/example/cutdemotwo/SampleJdbcTests.java': [
      'package com.example.cutdemotwo;',
      'import org.junit.jupiter.api.Tag;',
      'import org.junit.jupiter.api.Test;',
      '@Tag("mysql-integration")',
      'class SampleJdbcTests {',
      '  @Test void works() { OptimizationTestDatabase.create(); }',
      '}'
    ].join('\n'),
    '.github/workflows/image.yml': [
      'name: Verify',
      'jobs:',
      '  mysql-integration:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: ./mvnw -B test -Dgroups=mysql-integration',
      '  image:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - run: |',
      '          node --test integrations/inventory/test/sync-worker.test.mjs',
      '          node --test scripts/arch-coupling-audit.test.mjs',
      '          node scripts/arch-coupling-audit.mjs --fail-on-cycle',
      '          node --test scripts/workflow-closure-audit.test.mjs',
      '          node scripts/workflow-closure-audit.mjs --fail'
    ].join('\n'),
    'Dockerfile': [
      'FROM node:22-bookworm-slim AS frontend-tests',
      'RUN node --test integrations/inventory/test/sync-worker.test.mjs \\',
      '    && node --test scripts/arch-coupling-audit.test.mjs \\',
      '    && node scripts/arch-coupling-audit.mjs --fail-on-cycle \\',
      '    && node --test scripts/workflow-closure-audit.test.mjs \\',
      '    && node scripts/workflow-closure-audit.mjs --fail'
    ].join('\n'),
    'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': [
      'package com.example.cutdemotwo.controller;',
      'import org.springframework.web.bind.annotation.*;',
      '@RestController',
      '@RequestMapping("/api/v2")',
      'class SampleV2Controller {',
      '  @GetMapping("/capabilities") public Object caps() { return null; }',
      '  @PostMapping("/orders/{orderId}/items") public Object createItem() { return null; }',
      '}'
    ].join('\n'),
    'src/main/resources/static/api-v2/openapi.json': JSON.stringify(
      {
        openapi: '3.1.0',
        paths: {
          '/api/v2/capabilities': { get: { summary: 'caps' } },
          '/api/v2/orders/{orderId}/items': { post: { summary: 'create' } }
        }
      },
      null,
      2
    ),
    'frontend/tsconfig.json': JSON.stringify({ compilerOptions: {} }),
    'frontend/src/utils/routeUtils.ts': [
      'export const KNOWN_MODERN_ROUTES: readonly string[] = [',
      "  'workbench',",
      "  'inventory'",
      '];'
    ].join('\n'),
    '.agents/skills/verify-cutdemotwo/SKILL.md': [
      '# Verify',
      '| Check | Command |',
      '| :--- | :--- |',
      '| Audit | `node scripts/workflow-closure-audit.mjs --fail` |'
    ].join('\n'),
    'scripts/workflow-closure-audit.mjs': '// placeholder for sandbox SKILL.md reference\n',
    '.agents/skills/verify-cutdemotwo/features/README.md': '# Index\n- #/workbench\n- #/inventory\n',
    '.agents/skills/verify-cutdemotwo/features/core-flow.md': [
      '---',
      'routes:',
      '  - workbench',
      '  - inventory',
      '---',
      '',
      '# Core Flow'
    ].join('\n')
  };

  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) {
      delete base[k];
    } else {
      base[k] = v;
    }
  }
  return base;
}

function withTempSandbox(files, createdSandboxes, fn) {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutdemo-workflow-gate-'));
  createdSandboxes.push(sandboxDir);
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(sandboxDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf8');
    }
    return fn(sandboxDir);
  } finally {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
}

function runAuditCliOnDir(targetDir, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [AUDIT_CLI, '--root', targetDir, '--format', 'json', '--fail', ...extraArgs],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  let parsed = null;
  if (res.stdout && res.stdout.trim().startsWith('{')) {
    parsed = JSON.parse(res.stdout);
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', report: parsed };
}

function parseTapSummary(stdout) {
  const testsMatch = stdout.match(/^# tests (\d+)/m);
  const passMatch = stdout.match(/^# pass (\d+)/m);
  const failMatch = stdout.match(/^# fail (\d+)/m);
  const skippedMatch = stdout.match(/^# skipped (\d+)/m);
  return {
    tests: testsMatch ? Number(testsMatch[1]) : null,
    pass: passMatch ? Number(passMatch[1]) : null,
    fail: failMatch ? Number(failMatch[1]) : null,
    skipped: skippedMatch ? Number(skippedMatch[1]) : null
  };
}

async function fetchUrl(url, headers = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`[verify-workflow-gate] 参数错误: ${err.message}\n${getHelpText()}`);
    process.exit(2);
  }

  if (opts.help) {
    console.log(getHelpText());
    process.exit(0);
  }

  const rawBaseUrl = opts.baseUrl ?? process.env.BASE_URL ?? '';
  if (opts.offlineOnly && opts.baseUrl) {
    console.error('[verify-workflow-gate] 参数冲突: --offline-only 与 --base-url 不能同时指定');
    process.exit(2);
  }

  let mode = opts.offlineOnly ? 'offline-only' : 'isolated-live';
  let baseUrl = null;
  if (!opts.offlineOnly) {
    if (!String(rawBaseUrl).trim()) {
      console.error(`[verify-workflow-gate] 缺少 --base-url / BASE_URL 或未指定 --offline-only\n${getHelpText()}`);
      process.exit(2);
    }
    try {
      baseUrl = validateBaseUrl(rawBaseUrl);
    } catch (err) {
      console.error(`[verify-workflow-gate] 安全红线拦截: ${err.message}`);
      process.exit(2);
    }
  }

  const resultFile = opts.resultFile || process.env.RESULT_FILE || null;
  const authToken = opts.authToken || process.env.AUTH_TOKEN || null;

  const prodStateSha256Before = sha256File(PROD_STATE_FILE);
  const prodDraftsBefore = fingerprintDir(PROD_DRAFTS_DIR);

  const checks = [];
  const createdSandboxes = [];
  let onlineAuthEnabled = false;

  async function runCheck(id, tier, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      checks.push({
        id,
        tier,
        feature: 'F01',
        status: 'PASS',
        durationMs: Date.now() - started,
        detail
      });
    } catch (err) {
      checks.push({
        id,
        tier,
        feature: 'F01',
        status: 'FAIL',
        durationMs: Date.now() - started,
        detail: String(err?.message || err)
      });
    }
  }

  // ==================== Tier 1（离线仓库门禁 4 项） ====================
  await runCheck('F01-T1-01', 'Tier 1', () => {
    const res = runAuditCliOnDir(REPO_ROOT);
    assert.equal(res.status, 0, `workflow-closure-audit --fail 退出码应为 0，实际 ${res.status}: ${res.stderr}`);
    assert.ok(res.report, '应输出可解析的 JSON 报告');
    assert.equal(res.report.summary?.passed, true);
    assert.equal(res.report.summary?.verdict, 'PASS');
    assert.equal(res.report.summary?.violationCount, 0);
    assert.ok(
      res.report.dimensions?.testCoverage?.taggedTestClassCount >= 19,
      `taggedTestClassCount 应 >= 19，实际 ${res.report.dimensions?.testCoverage?.taggedTestClassCount}`
    );
    assert.ok(
      res.report.dimensions?.verifyMap?.knownModernRouteCount >= 14,
      `knownModernRouteCount 应 >= 14，实际 ${res.report.dimensions?.verifyMap?.knownModernRouteCount}`
    );
    assert.equal(res.report.dimensions?.archAndLargeFiles?.totalCycles, 0);
    assert.equal(res.report.dimensions?.archAndLargeFiles?.canvasBoundaryPassed, true);
    return {
      verdict: res.report.summary.verdict,
      violationCount: res.report.summary.violationCount,
      taggedTestClassCount: res.report.dimensions.testCoverage.taggedTestClassCount,
      knownModernRouteCount: res.report.dimensions.verifyMap.knownModernRouteCount,
      totalCycles: res.report.dimensions.archAndLargeFiles.totalCycles
    };
  });

  await runCheck('F01-T1-02', 'Tier 1', () => {
    const res = spawnSync(
      process.execPath,
      [ARCH_CLI, '--fail-on-cycle', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    assert.equal(res.status, 0, `arch-coupling-audit --fail-on-cycle 退出码应为 0，实际 ${res.status}: ${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.summary?.totalCycles, 0, '全仓循环依赖应为 0');
    assert.equal(report.summary?.canvasBoundaryPassed, true, 'WorkbenchBoardCanvas 边界校验应通过');
    return {
      totalCycles: report.summary.totalCycles,
      canvasBoundaryPassed: report.summary.canvasBoundaryPassed,
      largeFileCount: report.summary.largeFileCount ?? null
    };
  });

  await runCheck('F01-T1-03', 'Tier 1', () => {
    const suites = [
      'scripts/workflow-closure-audit.test.mjs',
      'scripts/arch-coupling-audit.test.mjs',
      'integrations/inventory/test/sync-worker.test.mjs'
    ];
    const summary = {};
    for (const rel of suites) {
      const abs = path.join(REPO_ROOT, rel);
      const res = spawnSync(process.execPath, ['--test', abs], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      assert.equal(res.status, 0, `${rel} 测试退出码应为 0，实际 ${res.status}:\n${res.stdout}\n${res.stderr}`);
      const tap = parseTapSummary(res.stdout || '');
      assert.ok(tap.tests && tap.tests > 0, `${rel} 发现/执行测试数必须 > 0，实际: ${JSON.stringify(tap)}`);
      assert.equal(tap.fail, 0, `${rel} # fail 必须为 0`);
      assert.equal(tap.skipped, 0, `${rel} # skipped 必须为 0`);
      assert.equal(tap.pass, tap.tests, `${rel} # pass 必须等于 # tests`);
      summary[rel] = tap;
    }
    return summary;
  });

  await runCheck('F01-T1-04', 'Tier 1', () => {
    for (const rel of EXPECTED_2026_11_24_ARCHIVED_LOGS) {
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(abs), `归档日志不存在: ${rel}`);
      const content = fs.readFileSync(abs, 'utf8');
      assert.ok(content.includes('## 后续演进备注'), `归档日志缺少「## 后续演进备注」: ${rel}`);
    }
    const p0LogAbs = path.join(REPO_ROOT, EXPECTED_2026_11_27_LOG);
    assert.ok(fs.existsSync(p0LogAbs), `缺少收口日志: ${EXPECTED_2026_11_27_LOG}`);
    const p0Content = fs.readFileSync(p0LogAbs, 'utf8').trim();
    assert.ok(p0Content.length > 0, `收口日志内容不得为空: ${EXPECTED_2026_11_27_LOG}`);
    return {
      archived20261124Count: EXPECTED_2026_11_24_ARCHIVED_LOGS.length,
      closureLogPresent: true
    };
  });

  // ==================== Tier 1（在线隔离实例 2 项） ====================
  if (mode === 'isolated-live') {
    await runCheck('F01-T1-05', 'Tier 1', async () => {
      const appRes = await fetchUrl(`${baseUrl}/app/`);
      assert.equal(appRes.status, 200, `GET /app/ 应返回 200，实际 HTTP ${appRes.status}`);

      const healthRes = await fetchUrl(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200, `GET /api/health 应返回 200，实际 HTTP ${healthRes.status}`);
      assert.equal(healthRes.json?.status, 'UP', `health.status 应为 UP，实际 ${JSON.stringify(healthRes.json)}`);
      assert.equal(
        healthRes.json?.storageStatus,
        'UP',
        `health.storageStatus 应为 UP，实际 ${JSON.stringify(healthRes.json)}`
      );

      const authMeRes = await fetchUrl(`${baseUrl}/api/v2/auth/me`);
      if (authMeRes.ok && authMeRes.json?.enabled === true) {
        onlineAuthEnabled = true;
      }

      const remoteOpenApiRes = await fetchUrl(`${baseUrl}/api-v2/openapi.json`);
      assert.equal(
        remoteOpenApiRes.status,
        200,
        `GET /api-v2/openapi.json 应返回 200，实际 HTTP ${remoteOpenApiRes.status}`
      );
      const localOpenApi = JSON.parse(fs.readFileSync(LOCAL_OPENAPI_FILE, 'utf8'));
      const remotePaths = Object.keys(remoteOpenApiRes.json?.paths || {}).sort();
      const localPaths = Object.keys(localOpenApi.paths || {}).sort();
      assert.deepEqual(
        remotePaths,
        localPaths,
        `在线 OpenAPI paths（${remotePaths.length}）与仓库 openapi.json（${localPaths.length}）不一致`
      );

      return {
        appHttpStatus: appRes.status,
        healthStatus: healthRes.json.status,
        storageStatus: healthRes.json.storageStatus,
        authEnabled: onlineAuthEnabled,
        openapiPathCount: remotePaths.length
      };
    });

    await runCheck('F01-T1-06', 'Tier 1', async () => {
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const reconRes = await fetchUrl(`${baseUrl}/api/v2/inventory-ledger/reconciliation`, headers);
      if (reconRes.status === 401 || reconRes.status === 403 || (onlineAuthEnabled && !authToken)) {
        throw new Error(
          `隔离实例已开启 --auth 认证且缺少有效 AUTH_TOKEN（HTTP ${reconRes.status}），严禁以 401/403 假绿通过，请改用免登隔离实例或提供 --auth-token`
        );
      }
      assert.equal(
        reconRes.status,
        200,
        `GET /api/v2/inventory-ledger/reconciliation 应返回 200，实际 HTTP ${reconRes.status}`
      );
      assert.equal(
        reconRes.json?.status,
        'BALANCED',
        `基线总账必须为 BALANCED，实际: ${JSON.stringify(reconRes.json)}`
      );
      assert.ok(
        Array.isArray(reconRes.json?.issues) && reconRes.json.issues.length === 0,
        `基线总账 issues 必须为空数组，实际: ${JSON.stringify(reconRes.json?.issues)}`
      );
      return {
        status: reconRes.json.status,
        entryCount: reconRes.json.entryCount ?? null,
        issueCount: reconRes.json.issues.length
      };
    });
  }

  // ==================== Tier 2（沙盒正负向 CLI + 边界 + 零污染 7 项） ====================
  await runCheck('F01-T2-01', 'Tier 2', () => {
    return withTempSandbox(createSandboxBaselineFiles(), createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(
        res.status,
        0,
        `最小 12 文件健康沙盒 CLI --fail 应返回 0，实际 ${res.status}: ${JSON.stringify(res.report?.violations || res.stderr)}`
      );
      assert.equal(res.report?.summary?.passed, true);
      assert.equal(res.report?.summary?.violationCount, 0);
      return {
        sandboxFileCount: Object.keys(createSandboxBaselineFiles()).length,
        verdict: res.report.summary.verdict,
        violationCount: res.report.summary.violationCount
      };
    });
  });

  await runCheck('F01-T2-02', 'Tier 2', () => {
    const files = createSandboxBaselineFiles({
      'src/test/java/com/example/cutdemotwo/MissingTagProbeTests.java': [
        'package com.example.cutdemotwo;',
        'import org.junit.jupiter.api.Test;',
        'class MissingTagProbeTests {',
        '  @Test void probe() { OptimizationTestDatabase.create(); }',
        '}'
      ].join('\n')
    });
    return withTempSandbox(files, createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(res.status, 1, `缺失 @Tag 沙盒 CLI --fail 应返回 1，实际 ${res.status}`);
      assert.equal(res.report?.summary?.passed, false);
      const hit = res.report?.violations?.find(
        (v) => v.rule === 'missing-mysql-tag' && String(v.file).endsWith('MissingTagProbeTests.java')
      );
      assert.ok(hit, `应捕获 missing-mysql-tag，实际 violations: ${JSON.stringify(res.report?.violations)}`);
      return { capturedRule: hit.rule, file: hit.file };
    });
  });

  await runCheck('F01-T2-03', 'Tier 2', () => {
    const files = createSandboxBaselineFiles({
      'src/test/java/com/example/cutdemotwo/HardcodedH2ProbeTests.java': [
        'package com.example.cutdemotwo;',
        'import org.junit.jupiter.api.Tag;',
        'import org.junit.jupiter.api.Test;',
        '@Tag("mysql-integration")',
        'class HardcodedH2ProbeTests {',
        '  @Test void probe() {',
        '    String url = "jdbc:h2:mem:probe_db;MODE=MySQL";',
        '    Flyway.configure();',
        '  }',
        '}'
      ].join('\n'),
      '.github/workflows/image.yml': [
        'name: Verify',
        'jobs:',
        '  mysql-integration:',
        '    runs-on: ubuntu-24.04',
        '    steps:',
        '      - run: ./mvnw -B test -Dtest="OnlyOne"'
      ].join('\n')
    });
    return withTempSandbox(files, createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(res.status, 1, `H2 硬编码与 CI 白名单退化沙盒应返回 1，实际 ${res.status}`);
      const rules = new Set((res.report?.violations || []).map((v) => v.rule));
      const expectedRules = [
        'hardcoded-h2-jdbc',
        'ci-missing-mysql-groups',
        'ci-static-dtest-whitelist',
        'ci-missing-workflow-closure-audit'
      ];
      for (const r of expectedRules) {
        assert.ok(rules.has(r), `缺少预期违规规则 ${r}，实际规则: ${[...rules].join(', ')}`);
      }
      return { capturedRules: expectedRules };
    });
  });

  await runCheck('F01-T2-04', 'Tier 2', () => {
    const files = createSandboxBaselineFiles({
      'src/main/java/com/example/cutdemotwo/controller/SampleV2Controller.java': [
        'package com.example.cutdemotwo.controller;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        '@RequestMapping("/api/v2")',
        'class SampleV2Controller {',
        '  @GetMapping("/capabilities") public Object caps() { return null; }',
        '  @PostMapping("/orders/{orderId}/items") public Object createItem() { return null; }',
        '  @GetMapping("/workbench/unregistered-probe") public Object probe() { return null; }',
        '}'
      ].join('\n'),
      'src/main/java/com/example/cutdemotwo/controller/BackdoorProbeController.java': [
        'package com.example.cutdemotwo.controller;',
        'import org.springframework.web.bind.annotation.*;',
        '@RestController',
        '@RequestMapping("/api")',
        'class BackdoorProbeController {',
        '  @PostMapping("/legacy-backdoor") public Object backdoor() { return null; }',
        '}'
      ].join('\n')
    });
    return withTempSandbox(files, createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(res.status, 1, `契约漂移沙盒应返回 1，实际 ${res.status}`);
      const rules = new Set((res.report?.violations || []).map((v) => v.rule));
      for (const r of ['v2-missing-in-openapi', 'unregistered-legacy-endpoint']) {
        assert.ok(rules.has(r), `缺少预期违规规则 ${r}，实际规则: ${[...rules].join(', ')}`);
      }
      return { capturedRules: ['v2-missing-in-openapi', 'unregistered-legacy-endpoint'] };
    });
  });

  await runCheck('F01-T2-05', 'Tier 2', () => {
    const files = createSandboxBaselineFiles({
      'frontend/src/utils/routeUtils.ts': [
        'export const KNOWN_MODERN_ROUTES: readonly string[] = [',
        "  'workbench',",
        "  'inventory',",
        "  'ghost-route'",
        '];'
      ].join('\n'),
      '.agents/skills/verify-cutdemotwo/features/README.md':
        '# Index\n- #/workbench\n- #/inventory\n- #/ghost-route\n',
      '.agents/skills/verify-cutdemotwo/SKILL.md': [
        '# Verify',
        '- `node scripts/workflow-closure-audit.mjs --fail`',
        '- `node scripts/missing-probe-gate.mjs`'
      ].join('\n')
    });
    return withTempSandbox(files, createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(res.status, 1, `路由漏记与 SKILL 断链沙盒应返回 1，实际 ${res.status}`);
      const rules = new Set((res.report?.violations || []).map((v) => v.rule));
      for (const r of ['route-missing-verify-feature', 'broken-verify-skill-path']) {
        assert.ok(rules.has(r), `缺少预期违规规则 ${r}，实际规则: ${[...rules].join(', ')}`);
      }
      return { capturedRules: ['route-missing-verify-feature', 'broken-verify-skill-path'] };
    });
  });

  await runCheck('F01-T2-06', 'Tier 2', () => {
    const bigTsx = Array.from({ length: 1005 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    const files = createSandboxBaselineFiles({
      'frontend/src/pages/HugeProbePage.tsx': bigTsx,
      'frontend/src/a.ts': "import { b } from './b'; export const a = () => b();\n",
      'frontend/src/b.ts': "import { a } from './a'; export const b = () => a();\n"
    });
    return withTempSandbox(files, createdSandboxes, (sandboxDir) => {
      const res = runAuditCliOnDir(sandboxDir);
      assert.equal(res.status, 1, `大文件与循环依赖沙盒应返回 1，实际 ${res.status}`);
      const rules = new Set((res.report?.violations || []).map((v) => v.rule));
      for (const r of ['new-large-source-file', 'arch-cycle-detected']) {
        assert.ok(rules.has(r), `缺少预期违规规则 ${r}，实际规则: ${[...rules].join(', ')}`);
      }
      return { capturedRules: ['new-large-source-file', 'arch-cycle-detected'] };
    });
  });

  await runCheck('F01-T2-07', 'Tier 2', async () => {
    const badCliRes = spawnSync(process.execPath, [AUDIT_CLI, '--format', 'xml'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    assert.equal(
      badCliRes.status,
      2,
      `非法 --format xml 参数应返回退出码 2，实际 ${badCliRes.status}`
    );

    let probeDraftStatus = null;
    if (mode === 'isolated-live') {
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const notFoundRes = await fetchUrl(`${baseUrl}/api/v2/workbench/drafts/NON_EXISTENT_PROBE`, headers);
      if (notFoundRes.status === 401 || notFoundRes.status === 403 || (onlineAuthEnabled && !authToken)) {
        throw new Error(
          `隔离实例已开启 --auth 认证且缺少有效 AUTH_TOKEN（HTTP ${notFoundRes.status}），严禁以 401/403 假绿通过`
        );
      }
      assert.equal(
        notFoundRes.status,
        404,
        `GET /api/v2/workbench/drafts/NON_EXISTENT_PROBE 应返回 404，实际 HTTP ${notFoundRes.status}`
      );
      probeDraftStatus = notFoundRes.status;
    }

    const leftoverSandboxes = createdSandboxes.filter((dir) => fs.existsSync(dir));
    assert.equal(
      leftoverSandboxes.length,
      0,
      `存在未清理的临时沙盒目录: ${leftoverSandboxes.join(', ')}`
    );

    const shaNow = sha256File(PROD_STATE_FILE);
    const draftsNow = fingerprintDir(PROD_DRAFTS_DIR);
    assert.equal(shaNow, prodStateSha256Before, '正式 data/cutdemo-state.json SHA-256 不得发生任何变化');
    assert.equal(draftsNow, prodDraftsBefore, '正式 data/cutdemo-state.json.drafts 指纹不得发生任何变化');

    return {
      invalidCliExitCode: badCliRes.status,
      probeDraftStatus,
      sandboxCountCleaned: createdSandboxes.length,
      prodInventoryUntouched: true,
      prodDraftsUntouched: true
    };
  });

  const prodStateSha256After = sha256File(PROD_STATE_FILE);
  const prodDraftsAfter = fingerprintDir(PROD_DRAFTS_DIR);
  const passedCount = checks.filter((c) => c.status === 'PASS').length;
  const failedCount = checks.filter((c) => c.status === 'FAIL').length;

  const summary = {
    script: 'workflow-gate-smoke',
    mode,
    baseUrl,
    executed: checks.length,
    passed: passedCount,
    failed: failedCount,
    skipped: 0,
    prodInventoryUntouched: prodStateSha256After === prodStateSha256Before,
    prodDraftsUntouched: prodDraftsAfter === prodDraftsBefore,
    prodStateSha256Before,
    prodStateSha256After,
    checks
  };

  if (resultFile) {
    fs.mkdirSync(path.dirname(path.resolve(resultFile)), { recursive: true });
    fs.writeFileSync(path.resolve(resultFile), JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));
  if (failedCount > 0 || !summary.prodInventoryUntouched || !summary.prodDraftsUntouched) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[verify-workflow-gate] 未捕获异常: ${err?.stack || err}`);
  process.exit(1);
});
