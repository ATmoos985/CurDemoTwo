#!/usr/bin/env node
// 一键真机隔离 Benchmark 门禁：启动非 8080 端口独立实例（隔离 state/jobs/drafts/security/audit）、
// 执行 benchmark/run.mjs 并校验阈值红线，结束后精确回收子进程、清理临时目录并核验正式库存 SHA-256 零污染。
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THRESHOLDS, executeBenchmark, Abort as RunAbort } from './run.mjs';
import { SETS } from './problems.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_JAR = path.join(REPO_ROOT, 'target', 'CutDemoTwo-0.0.1-SNAPSHOT.jar');
const DEFAULT_PORT = 18391;

export const GATE_USAGE = `用法：node benchmark/gate.mjs [选项]
  自动在非 8080 隔离端口启动 CutDemoTwo（独立临时状态目录，不动正式 data/），跑完即停并校验阈值与库存零污染。

  --set <题集>        ${Object.keys(SETS).join('、')}（默认 v2-gate）
  --problems <列表>   逗号分隔题目名，覆盖 --set
  --rounds <n>        轮数（默认 1）
  --warmup <n>        每引擎预热次数（默认 0）
  --auth              开启企业认证模式（注入 --cutdemo.auth.enabled=true 并自动登录）
  --username <用户>   认证用户名（默认 CUTDEMO_BENCH_USER 或 admin）
  --password <密码>   认证密码（默认 CUTDEMO_BENCH_PASS 或 admin123）
  --token <令牌>      直接传入 Bearer Token（默认 CUTDEMO_BENCH_TOKEN）
  --port <端口>       隔离服务端口（默认 ${DEFAULT_PORT}，严禁 8080）
  --jar <文件>        指定打包 JAR（默认 target/CutDemoTwo-0.0.1-SNAPSHOT.jar）
  --base <地址>       连接已启动的非 8080 服务（跳过启动与停止 JAR）
  --allow-8080        显式豁免 8080 保护（默认禁止，不建议开启）
  --allow-fallback    允许原生 C++ 引擎缺失时回退至自主引擎（默认 false）
  --thresholds <文件> 质量红线文件（默认 benchmark/thresholds.json）
  --skip-thresholds   仅采数对比，跳过红线阻断（门禁场景请勿使用）
  --out <文件>        结果 JSON 输出路径（默认写入临时目录或 --out 指定位置）
  --timeout-sec <秒>  服务启动就绪等待超时（默认 45）
  -h, --help          显示本说明

退出码：0 求解全部有效、红线通过且正式库存零污染；1 存在无效运行、红线违约或库存污染；2 参数、环境或启动异常。`;

export class GateAbort extends Error {}
const log = msg => process.stderr.write(`[bench-gate] ${msg}\n`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseIntArg(name, value, min, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new GateAbort(`--${name} 须为 ${min}..${max} 的整数：${value}`);
    }
    return n;
}

export function assertSafePort(port, allow8080 = false) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new GateAbort(`无效端口号：${port}`);
    }
    if (port === 8080 && !allow8080) {
        throw new GateAbort('安全护栏：benchmark/gate.mjs 严禁使用 8080 端口（避免触碰日常预览服务）');
    }
    return port;
}

export function parseGateArgs(argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: false,
            options: {
                set: { type: 'string' },
                problems: { type: 'string' },
                rounds: { type: 'string' },
                warmup: { type: 'string' },
                auth: { type: 'boolean' },
                username: { type: 'string' },
                password: { type: 'string' },
                token: { type: 'string' },
                port: { type: 'string' },
                jar: { type: 'string' },
                base: { type: 'string' },
                'allow-8080': { type: 'boolean' },
                'allow-fallback': { type: 'boolean' },
                thresholds: { type: 'string' },
                'skip-thresholds': { type: 'boolean' },
                out: { type: 'string' },
                'timeout-sec': { type: 'string' },
                help: { type: 'boolean', short: 'h' }
            }
        });
    } catch (error) {
        throw new GateAbort(`${error.message}\n\n${GATE_USAGE}`);
    }
    const { values } = parsed;
    if (values.help) return { help: true };

    const allow8080 = Boolean(values['allow-8080']);
    const port = values.port == null ? DEFAULT_PORT : parseIntArg('port', values.port, 1, 65535);
    let base = values.base ?? null;
    if (base) {
        let u;
        try {
            u = new URL(base);
        } catch {
            throw new GateAbort(`无效 --base 地址：${base}`);
        }
        const parsedPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
        assertSafePort(parsedPort, allow8080);
        base = base.replace(/\/+$/, '');
    } else {
        assertSafePort(port, allow8080);
    }

    const set = values.problems ? null : (values.set ?? 'v2-gate');
    if (set && !SETS[set]) {
        throw new GateAbort(`未知题集 ${set}；可用：${Object.keys(SETS).join('、')}`);
    }
    const names = values.problems
        ? values.problems.split(',').map(s => s.trim()).filter(Boolean)
        : SETS[set];

    const token = values.token ?? process.env.CUTDEMO_BENCH_TOKEN ?? null;
    return {
        help: false,
        set,
        names,
        rounds: values.rounds == null ? 1 : parseIntArg('rounds', values.rounds, 1),
        warmup: values.warmup == null ? 0 : parseIntArg('warmup', values.warmup, 0),
        auth: Boolean(values.auth || token),
        username: values.username ?? process.env.CUTDEMO_BENCH_USER ?? 'admin',
        password: values.password ?? process.env.CUTDEMO_BENCH_PASS ?? 'admin123',
        token,
        port,
        jarPath: path.resolve(values.jar ?? DEFAULT_JAR),
        base,
        allow8080,
        allowFallback: Boolean(values['allow-fallback']),
        thresholdsPath: values['skip-thresholds'] ? null : path.resolve(values.thresholds ?? DEFAULT_THRESHOLDS),
        out: values.out ? path.resolve(values.out) : null,
        timeoutSec: values['timeout-sec'] == null ? 45 : parseIntArg('timeout-sec', values['timeout-sec'], 5, 300)
    };
}

export function buildJavaArgs({
    jarPath,
    port,
    statePath,
    auth = false,
    authSecret = 'cutdemo-bench-gate-secret-32bytes-minimum',
    allowFallback = false,
    rectSolverPath = null,
    irregularSolverPath = null
}) {
    const args = [
        '-jar', jarPath,
        `--server.port=${port}`,
        '--server.address=127.0.0.1',
        `--cutdemo.state.path=${statePath}`,
        `--cutdemo.jobs.path=${statePath}.jobs`,
        `--cutdemo.integration.path=${statePath}.integrations`,
        `--cutdemo.workbench.drafts.path=${statePath}.drafts`,
        `--cutdemo.security.path=${statePath}.security`,
        `--cutdemo.audit.path=${statePath}.audit`,
        '--cutdemo.seed-demo-data=true',
        `--packingsolver.fallback.enabled=${allowFallback ? 'true' : 'false'}`
    ];
    if (rectSolverPath) args.push(`--packingsolver.executable.path=${rectSolverPath}`);
    if (irregularSolverPath) args.push(`--packingsolver.irregular.executable.path=${irregularSolverPath}`);
    if (auth) {
        args.push(
            '--cutdemo.auth.enabled=true',
            `--cutdemo.auth.secret=${authSecret}`
        );
    } else {
        args.push('--cutdemo.auth.enabled=false');
    }
    return args;
}

const LOCK_ERR_CODES = new Set(['EBUSY', 'EACCES', 'EPERM']);

export function sha256File(filePath, st = null, readFile = readFileSync) {
    try {
        return createHash('sha256').update(readFile(filePath)).digest('hex');
    } catch (error) {
        if (error?.code === 'ENOENT') return 'MISSING';
        if (LOCK_ERR_CODES.has(error?.code)) {
            const meta = st ?? (existsSync(filePath) ? statSync(filePath) : null);
            return meta ? `LOCKED:${meta.size}:${Math.round(meta.mtimeMs)}` : 'MISSING';
        }
        throw error;
    }
}

export function directoryFingerprint(dirPath, options = {}) {
    if (!existsSync(dirPath)) return 'MISSING';
    const readFile = options.readFile ?? readFileSync;
    const items = [];
    const walk = cur => {
        const entries = readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(cur, entry.name);
            const rel = path.relative(dirPath, full).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                items.push(`D:${rel}`);
                walk(full);
            } else if (entry.name.toLowerCase().endsWith('.lock')) {
                const st = statSync(full);
                items.push(`L:${rel}:${st.size}`);
            } else {
                const st = statSync(full);
                items.push(`F:${rel}:${st.size}:${sha256File(full, st, readFile)}`);
            }
        }
    };
    walk(dirPath);
    return createHash('sha256').update(items.join('\n')).digest('hex');
}

export function captureDataFingerprint(rootDir = REPO_ROOT, options = {}) {
    const readFile = options.readFile ?? readFileSync;
    const stateFile = path.join(rootDir, 'data', 'cutdemo-state.json');
    return {
        stateSha256: sha256File(stateFile, null, readFile),
        draftsFingerprint: directoryFingerprint(`${stateFile}.drafts`, { readFile }),
        jobsFingerprint: directoryFingerprint(`${stateFile}.jobs`, { readFile }),
        securityFingerprint: directoryFingerprint(`${stateFile}.security`, { readFile }),
        auditFingerprint: directoryFingerprint(`${stateFile}.audit`, { readFile })
    };
}

export function verifyDataFingerprint(before, after) {
    const mismatches = [];
    for (const key of Object.keys(before)) {
        if (before[key] !== after[key]) {
            mismatches.push(`${key}: ${before[key]} -> ${after[key]}`);
        }
    }
    return { clean: mismatches.length === 0, mismatches };
}

function checkPortFree(port) {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', err => reject(new GateAbort(`隔离端口 127.0.0.1:${port} 已被占用：${err.message}`)));
        srv.listen(port, '127.0.0.1', () => {
            srv.close(() => resolve());
        });
    });
}

function detectNativeSolvers(rootDir = REPO_ROOT) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const rect = path.join(rootDir, 'data', 'solver', `packingsolver_rectangleguillotine${ext}`);
    const irregular = path.join(rootDir, 'data', 'solver', `packingsolver_irregular${ext}`);
    return {
        rectSolverPath: existsSync(rect) ? rect : null,
        irregularSolverPath: existsSync(irregular) ? irregular : null
    };
}

async function waitForReady(base, child, expectAuth, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        if (child.exitCode != null) {
            throw new GateAbort(`Java 服务启动失败提前退出（exit=${child.exitCode}）`);
        }
        try {
            const hRes = await fetch(`${base}/api/v2/health`, { signal: AbortSignal.timeout(2000) });
            if (hRes.ok) {
                const hData = await hRes.json();
                if (hData?.status === 'UP' && hData?.storageStatus === 'UP') {
                    if (!expectAuth) return;
                    const meRes = await fetch(`${base}/api/v2/auth/me`, { signal: AbortSignal.timeout(2000) });
                    if (meRes.ok) {
                        const meData = await meRes.json();
                        if (meData?.enabled === true) return;
                    }
                }
            }
        } catch {
            // 服务仍在启动中
        }
        await sleep(500);
    }
    throw new GateAbort(`等待服务就绪超时（>${timeoutSec} s）：${base}`);
}

async function stopProcessTree(child) {
    if (!child || child.exitCode != null) return;
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && child.exitCode == null) {
        await sleep(200);
    }
    if (child.exitCode == null) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // 已退出
        }
    }
}

async function removeTempDir(dirPath) {
    if (!dirPath || !existsSync(dirPath)) return;
    for (let i = 0; i < 6; i++) {
        try {
            rmSync(dirPath, { recursive: true, force: true });
            return;
        } catch {
            await sleep(250);
        }
    }
}

export async function runGate(options) {
    if (options.help) {
        console.log(GATE_USAGE);
        return 0;
    }

    const beforeFp = captureDataFingerprint(REPO_ROOT);
    let child = null;
    let tmpDir = null;
    let targetBase = options.base;
    let exitCode = 2;

    try {
        if (!targetBase) {
            if (!existsSync(options.jarPath)) {
                throw new GateAbort(`未找到服务 JAR：${options.jarPath}（请先运行 .\\mvnw.cmd -DskipTests package）`);
            }
            await checkPortFree(options.port);
            const runId = `${Date.now()}-${process.pid}`;
            tmpDir = path.join(os.tmpdir(), 'cutdemo-bench-gate', `run-${runId}`);
            mkdirSync(tmpDir, { recursive: true });
            const statePath = path.join(tmpDir, 'cutdemo-state.json');
            const solvers = detectNativeSolvers(REPO_ROOT);
            const javaArgs = buildJavaArgs({
                jarPath: options.jarPath,
                port: options.port,
                statePath,
                auth: options.auth,
                allowFallback: options.allowFallback,
                ...solvers
            });
            targetBase = `http://127.0.0.1:${options.port}`;
            log(`启动隔离服务：${targetBase}（状态目录：${tmpDir}，auth=${options.auth}）`);
            child = spawn('java', javaArgs, {
                cwd: REPO_ROOT,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });
            const tail = [];
            const pushLog = chunk => {
                for (const line of chunk.toString('utf8').split(/\r?\n/)) {
                    if (line) {
                        tail.push(line);
                        if (tail.length > 40) tail.shift();
                    }
                }
            };
            child.stdout?.on('data', pushLog);
            child.stderr?.on('data', pushLog);

            try {
                await waitForReady(targetBase, child, options.auth, options.timeoutSec);
            } catch (err) {
                if (tail.length) log(`服务末段日志：\n${tail.slice(-12).join('\n')}`);
                throw err;
            }
            log(`隔离服务就绪（PID=${child.pid}）`);
        } else {
            log(`连接已运行服务：${targetBase}`);
        }

        const outPath = options.out ?? (tmpDir ? path.join(tmpDir, 'gate-result.json') : undefined);
        const result = await executeBenchmark({
            help: false,
            list: false,
            set: options.set,
            names: options.names,
            rounds: options.rounds,
            warmup: options.warmup,
            timeLimitSeconds: null,
            auth: options.auth,
            username: options.username,
            password: options.password,
            token: options.token,
            allowFallback: options.allowFallback,
            thresholdsPath: options.thresholdsPath,
            out: outPath,
            bases: [`gate=${targetBase}`]
        });
        exitCode = result.exitCode;
    } catch (error) {
        if (error instanceof GateAbort || error instanceof RunAbort) {
            log(error.message);
            exitCode = 2;
        } else {
            log(error.stack ?? String(error));
            exitCode = 2;
        }
    } finally {
        if (child) {
            log(`回收隔离 Java 进程（PID=${child.pid}）`);
            await stopProcessTree(child);
        }
        if (tmpDir) {
            await removeTempDir(tmpDir);
        }
        const afterFp = captureDataFingerprint(REPO_ROOT);
        const fpCheck = verifyDataFingerprint(beforeFp, afterFp);
        if (!fpCheck.clean) {
            log(`严重告警：正式库存目录发生非预期变更！\n  ${fpCheck.mismatches.join('\n  ')}`);
            exitCode = 1;
        } else {
            log(`正式库存零污染复核 PASS（data/cutdemo-state.json SHA-256=${afterFp.stateSha256.slice(0, 16)}... 零变动）`);
        }
    }
    return exitCode;
}

function isMainModule() {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
    Promise.resolve()
        .then(() => runGate(parseGateArgs()))
        .then(
            code => { process.exitCode = code ?? 0; },
            error => {
                log(error instanceof GateAbort ? error.message : error.stack ?? String(error));
                process.exitCode = 2;
            }
        );
}
