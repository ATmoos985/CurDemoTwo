#!/usr/bin/env node
// Solves the benchmark problems on one or two running services, interleaved and repeated, and prints mean and range
// per problem and service. The results file is rewritten after every solve, so an interrupted run keeps what it has.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, prepare, problemNames } from './problems.mjs';
import { parseBase, schedule, measure, summarize, evaluateThresholds, formatRun, formatReport, formatProblems } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_THRESHOLDS = path.join(HERE, 'thresholds.json');
const FALLBACK_ENGINE = { packingsolver: 'javaguillotine', 'packingsolver-irregular': 'deepnest' };

export const USAGE = `用法：node benchmark/run.mjs [选项] <A 服务> [B 服务]
  服务写作 [标签=]http://主机:端口，例如 30e3d4b=http://127.0.0.1:18310；给两个服务时输出 B − A。

  --set <题集>        ${Object.keys(SETS).join('、')}（默认 demo）
  --problems <列表>   逗号分隔的题目名，覆盖 --set；也接受 scenario<N>、synthetic<N>、distinct<N>
  --rounds <n>        轮数，默认 4。两个服务时奇数轮 A 先、偶数轮 B 先，取偶数先后才平衡
  --warmup <n>        每个服务、每个引擎先以 1 s 限时预热几次，不计入结果（默认 1）
  --time-limit <s>    统一改写各题限时；请求体随之改变，哈希不再与默认题目相同
  --auth              启用企业认证登录（默认读取 --username/--password 或 --token）
  --username <用户>   登录用户名（默认 CUTDEMO_BENCH_USER 或 admin）
  --password <密码>   登录密码（默认 CUTDEMO_BENCH_PASS 或 admin123；严禁落盘）
  --token <令牌>      直接传入 Bearer Token（默认读取 CUTDEMO_BENCH_TOKEN；严禁落盘）
  --allow-fallback    允许原生 C++ 引擎不可用时回退至自主引擎（默认严格禁止）
  --check-thresholds  启用质量红线校验（默认读取 benchmark/thresholds.json）
  --thresholds <文件> 指定质量红线 JSON 文件并启用红线校验
  --out <文件>        结果 JSON（默认 benchmark/results/<开始时间>.json）
  --smoke             冒烟：--set smoke --rounds 1 --warmup 0 --time-limit 2，可再用上面的选项覆盖
  --list              列出题目、预期引擎与请求体哈希后退出（可配合 --set、--problems、--time-limit）
  -h, --help          显示本说明

退出码：0 全部有效且红线通过；1 有无效运行或质量红线未通过；2 参数错误、服务不可用或请求中断。`;

export class Abort extends Error {}
const log = message => process.stderr.write(`${message}\n`);
const serviceLabel = ({ side, label }) => label === side ? side : `${side} ${label}`;

function integer(name, value, min) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Abort(`--${name} 须为不小于 ${min} 的整数：${value}`);
    return n;
}

export function buildAuthHeaders(token) {
    if (!token) return {};
    const raw = String(token).trim().replace(/^Bearer\s+/i, '');
    return raw ? { authorization: `Bearer ${raw}` } : {};
}

export function parseRunArgs(argv = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                set: { type: 'string' },
                problems: { type: 'string' },
                rounds: { type: 'string' },
                warmup: { type: 'string' },
                'time-limit': { type: 'string' },
                auth: { type: 'boolean' },
                username: { type: 'string' },
                password: { type: 'string' },
                token: { type: 'string' },
                'allow-fallback': { type: 'boolean' },
                'check-thresholds': { type: 'boolean' },
                thresholds: { type: 'string' },
                out: { type: 'string' },
                smoke: { type: 'boolean' },
                list: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' }
            }
        });
    } catch (error) {
        throw new Abort(`${error.message}\n\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    const defaults = values.smoke
        ? { set: 'smoke', rounds: 1, warmup: 0, timeLimit: 2 }
        : { set: 'demo', rounds: 4, warmup: 1, timeLimit: null };
    const set = values.set ?? defaults.set;
    if (!values.problems && !SETS[set]) throw new Abort(`未知题集 ${set}；可用：${Object.keys(SETS).join('、')}`);
    const names = values.problems
        ? values.problems.split(',').map(s => s.trim()).filter(Boolean)
        : values.list && !values.set && !values.smoke ? problemNames() : SETS[set];
    const thresholdsPath = values.thresholds ? path.resolve(values.thresholds) : values['check-thresholds'] ? DEFAULT_THRESHOLDS : null;
    const token = values.token ?? process.env.CUTDEMO_BENCH_TOKEN ?? null;
    const auth = Boolean(values.auth || token);
    return {
        help: values.help,
        list: values.list,
        set: values.problems ? null : set,
        names,
        rounds: values.rounds == null ? defaults.rounds : integer('rounds', values.rounds, 1),
        warmup: values.warmup == null ? defaults.warmup : integer('warmup', values.warmup, 0),
        timeLimitSeconds: values['time-limit'] == null ? defaults.timeLimit : integer('time-limit', values['time-limit'], 1),
        auth,
        username: values.username ?? process.env.CUTDEMO_BENCH_USER ?? 'admin',
        password: values.password ?? process.env.CUTDEMO_BENCH_PASS ?? 'admin123',
        token,
        allowFallback: Boolean(values['allow-fallback']),
        thresholdsPath,
        out: values.out,
        bases: positionals
    };
}

function prepareAll(names, timeLimitSeconds) {
    try {
        return names.map(name => prepare(name, timeLimitSeconds));
    } catch (error) {
        throw new Abort(error.message);
    }
}

function suiteCheckout() {
    const git = (...args) => execFileSync('git', ['-C', HERE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        return { commit: git('rev-parse', '--short', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
    } catch {
        return { commit: null, dirty: null };
    }
}

async function requestJson(s, apiPath, init = {}, timeoutMs = 10_000) {
    const headers = { ...buildAuthHeaders(s._authToken), ...(init.headers ?? {}) };
    const response = await fetch(`${s.base}${apiPath}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { status: '非 JSON 响应', message: text.slice(0, 200) };
    }
    return { http: response.status, ok: response.ok, data };
}

async function authenticateService(s, options) {
    if (options.token) {
        s._authToken = String(options.token).trim().replace(/^Bearer\s+/i, '');
        s.authStatus = 'auth=token';
        return;
    }
    if (!options.auth) {
        s.authStatus = 'auth=disabled';
        return;
    }
    let res;
    try {
        res = await requestJson(s, '/api/v2/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: options.username, password: options.password })
        }, 10_000);
    } catch (error) {
        throw new Abort(`${serviceLabel(s)} ${s.base} 登录失败：${error.cause?.message ?? error.message}`);
    }
    if (!res.ok || !res.data?.token) {
        throw new Abort(`${serviceLabel(s)} ${s.base} 登录失败：HTTP ${res.http} ${res.data?.message ?? ''}`);
    }
    s._authToken = res.data.token;
    s.authStatus = `auth=enabled(${res.data.username ?? options.username})`;
}

/** Health, auth state, capabilities, and engine list of each service. */
async function preflight(services, problems, options) {
    for (const s of services) {
        await authenticateService(s, options);
        try {
            const meRes = await requestJson(s, '/api/v2/auth/me');
            if (meRes.ok && meRes.data?.enabled && !meRes.data?.authenticated) {
                throw new Abort(`${serviceLabel(s)} ${s.base} 已开启企业认证，请传入 --auth 或 --token`);
            }
            if (meRes.ok && meRes.data?.enabled && meRes.data?.authenticated && !s.authStatus?.startsWith('auth=enabled')) {
                s.authStatus = `auth=enabled(${meRes.data.username ?? meRes.data.agentId ?? 'token'})`;
            }

            const healthRes = await requestJson(s, '/api/v2/health');
            if (!healthRes.ok) throw new Error(`health HTTP ${healthRes.http}`);
            s.health = healthRes.data;

            const enginesRes = await requestJson(s, '/api/v2/nesting/engines');
            if (!enginesRes.ok) throw new Error(`nesting/engines HTTP ${enginesRes.http}`);
            s.engines = enginesRes.data;

            const capRes = await requestJson(s, '/api/v2/capabilities');
            if (!capRes.ok) throw new Error(`capabilities HTTP ${capRes.http}`);
            s.capabilities = capRes.data;
        } catch (error) {
            if (error instanceof Abort) throw error;
            throw new Abort(`${serviceLabel(s)} ${s.base} 无法访问：${error.cause?.message ?? error.message}`);
        }

        for (const p of problems) {
            if (p.kind === 'optimization-job' && p.body.problemType === 'SLITTING_1D') {
                if (!s.capabilities?.slittingEngine?.available) {
                    throw new Abort(`${serviceLabel(s)} ${s.base}：1D 分切引擎 (or-tools) 未就绪`);
                }
                continue;
            }
            if (p.kind === 'multi-material') {
                for (const requiredId of ['javaguillotine', 'deepnest']) {
                    const eng = s.engines.find(e => e.id === requiredId);
                    if (!eng?.available) {
                        throw new Abort(`${serviceLabel(s)} ${s.base}：多料联排所需引擎 ${requiredId} 未就绪`);
                    }
                }
                continue;
            }
            const id = p.expectedEngine;
            const engine = s.engines.find(e => e.id === id);
            if (engine?.available) continue;
            if (options.allowFallback && FALLBACK_ENGINE[id]) {
                const fbId = FALLBACK_ENGINE[id];
                const fb = s.engines.find(e => e.id === fbId);
                if (fb?.available) {
                    log(`提示：${serviceLabel(s)} 引擎 ${id} 未就绪，已开启 --allow-fallback，将回退至 ${fbId}`);
                    continue;
                }
            }
            throw new Abort(`${serviceLabel(s)} ${s.base}：引擎 ${id} ${engine ? '未就绪' : '不存在'}，检查 --packingsolver.*.executable.path 或显式传 --allow-fallback`);
        }
    }
}

async function solveNesting(s, body) {
    const started = performance.now();
    try {
        const res = await requestJson(s, '/api/v2/nesting/solve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        }, (body.timeLimitSeconds + 60) * 1000);
        return { http: res.http, response: res.data, wallMs: Math.round(performance.now() - started) };
    } catch (error) {
        throw new Abort(`请求 ${serviceLabel(s)} ${s.base} 失败：${error.cause?.message ?? error.message}`);
    }
}

const TERMINAL_JOB_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function solveOptimizationJob(s, problem, runTag, roundIndex, bodyOverride = null) {
    const body = bodyOverride ?? problem.body;
    const timeLimitSec = body.problem?.timeLimitSeconds ?? 10;
    const timeoutMs = (timeLimitSec + 60) * 1000;
    const started = performance.now();
    const idempKey = `bench-${runTag}-${s.side}-${problem.name}-r${roundIndex}-${randomUUID().slice(0, 8)}`
        .replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);

    let submitRes;
    try {
        submitRes = await requestJson(s, '/api/v2/optimization-jobs', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'Idempotency-Key': idempKey
            },
            body: JSON.stringify(body)
        }, timeoutMs);
    } catch (error) {
        throw new Abort(`提交作业 ${serviceLabel(s)} ${s.base} 失败：${error.cause?.message ?? error.message}`);
    }

    if (submitRes.http !== 200 && submitRes.http !== 202 || !submitRes.data?.id) {
        return {
            http: submitRes.http,
            outcome: { job: submitRes.data, result: null },
            wallMs: Math.round(performance.now() - started)
        };
    }

    const jobId = submitRes.data.id;
    let job = submitRes.data;
    const deadline = Date.now() + timeoutMs;
    while (!TERMINAL_JOB_STATES.has(job.state)) {
        if (Date.now() > deadline) {
            throw new Abort(`轮询作业 ${jobId} 超时（>${timeoutMs} ms）`);
        }
        await sleep(150);
        const pollRes = await requestJson(s, `/api/v2/optimization-jobs/${encodeURIComponent(jobId)}`, {}, 10_000);
        if (!pollRes.ok) {
            throw new Abort(`轮询作业 ${jobId} 失败：HTTP ${pollRes.http}`);
        }
        job = pollRes.data;
    }

    let result = null;
    if (job.state === 'SUCCEEDED') {
        const refPath = job.resultRef && job.resultRef.startsWith('/')
            ? job.resultRef
            : `/api/v2/optimization-results/${encodeURIComponent(jobId)}`;
        const resultRes = await requestJson(s, refPath, {}, 15_000);
        if (!resultRes.ok) {
            throw new Abort(`读取作业结果 ${refPath} 失败：HTTP ${resultRes.http}`);
        }
        result = resultRes.data;
    }
    return {
        http: submitRes.http,
        outcome: { job, result },
        wallMs: Math.round(performance.now() - started)
    };
}

async function solveMultiMaterial(s, body) {
    const budgetSec = Math.ceil((body.timeBudgetMs ?? 6000) / 1000);
    const started = performance.now();
    try {
        const res = await requestJson(s, '/api/v2/planning/multi-material', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        }, (budgetSec + 30) * 1000);
        return { http: res.http, response: res.data, wallMs: Math.round(performance.now() - started) };
    } catch (error) {
        throw new Abort(`请求 ${serviceLabel(s)} ${s.base} 多料规划失败：${error.cause?.message ?? error.message}`);
    }
}

async function executeWarmup(s, p, runTag) {
    if (p.kind === 'nesting') {
        const body = { ...p.body, timeLimitSeconds: 1 };
        const { http, response, wallMs } = await solveNesting(s, body);
        return { expectedEngine: p.expectedEngine, engine: response?.engine ?? null, problem: p.name, side: s.side, http, status: response?.status ?? null, wallMs };
    }
    if (p.kind === 'optimization-job') {
        const warmupLimit = p.body.problemType === 'SLITTING_1D'
            ? Math.max(3, Math.min(p.body.problem.timeLimitSeconds, 5))
            : 1;
        const body = { ...p.body, clientRequestId: `${p.body.clientRequestId}-warmup`, problem: { ...p.body.problem, timeLimitSeconds: warmupLimit } };
        const { http, outcome, wallMs } = await solveOptimizationJob(s, p, runTag, 0, body);
        return { expectedEngine: p.expectedEngine, engine: outcome.result?.slitting?.engine ?? outcome.result?.layout?.engine ?? null, problem: p.name, side: s.side, http, status: outcome.job?.state ?? null, wallMs };
    }
    const body = { ...p.body, timeBudgetMs: 1000 };
    const { http, response, wallMs } = await solveMultiMaterial(s, body);
    return { expectedEngine: p.expectedEngine, engine: 'javaguillotine', problem: p.name, side: s.side, http, status: http === 200 ? 'FEASIBLE' : 'FAILED', wallMs };
}

function sanitizeServicesForRecord(services) {
    return services.map(({ _authToken, ...rest }) => rest);
}

export async function executeBenchmark(options) {
    if (options.help) {
        console.log(USAGE);
        return { exitCode: 0, record: null };
    }
    const problems = prepareAll(options.names, options.timeLimitSeconds);
    if (options.list) {
        console.log(formatProblems(problems));
        return { exitCode: 0, record: null };
    }
    if (options.bases.length < 1 || options.bases.length > 2) throw new Abort(`需要一个或两个服务地址\n\n${USAGE}`);
    if (!problems.length) throw new Abort('没有选中任何题目');

    const services = options.bases.map((arg, i) => {
        try {
            return { side: 'AB'[i], ...parseBase(arg, 'AB'[i]) };
        } catch (error) {
            throw new Abort(error.message);
        }
    });
    if (services.length === 2 && options.rounds % 2) log(`提示：${options.rounds} 轮为奇数，A 先跑的轮次多一轮`);

    await preflight(services, problems, options);
    const startedAt = new Date().toISOString();
    const runTag = startedAt.replace(/[^0-9A-Za-z]/g, '').slice(0, 14);
    const out = path.resolve(options.out ?? path.join(HERE, 'results', `${startedAt.replace(/[:.]/g, '-')}.json`));
    mkdirSync(path.dirname(out), { recursive: true });

    const record = {
        schema: 2,
        startedAt,
        finishedAt: null,
        complete: false,
        abortReason: null,
        suiteCheckout: suiteCheckout(),
        host: { os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model.trim() ?? '未知', logicalCpus: os.availableParallelism(), node: process.version },
        options: {
            set: options.set,
            problems: options.names,
            rounds: options.rounds,
            warmup: options.warmup,
            timeLimitSeconds: options.timeLimitSeconds,
            auth: Boolean(options.auth),
            allowFallback: Boolean(options.allowFallback)
        },
        services: sanitizeServicesForRecord(services),
        problems: problems.map(({ body, ...p }) => p),
        warmups: [],
        rows: []
    };
    const save = () => {
        record.services = sanitizeServicesForRecord(services);
        writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    };

    save();
    log(`结果写入 ${out}`);
    const thresholds = options.thresholdsPath ? JSON.parse(readFileSync(options.thresholdsPath, 'utf8')) : null;
    const engines = [...new Set(problems.map(p => p.expectedEngine))];

    try {
        for (const id of engines) {
            const first = problems.find(p => p.expectedEngine === id);
            for (let i = 0; i < options.warmup; i++) {
                for (const s of services) {
                    const warmupRow = await executeWarmup(s, first, runTag);
                    record.warmups.push(warmupRow);
                    save();
                    log(`预热 ${id} ${serviceLabel(s)}：HTTP ${warmupRow.http} ${warmupRow.status} · ${warmupRow.wallMs} ms`);
                    if (warmupRow.http !== 200 && warmupRow.http !== 202) {
                        throw new Abort(`预热 ${id} 在 ${serviceLabel(s)} 上失败：HTTP ${warmupRow.http} ${warmupRow.status ?? ''}`);
                    }
                }
            }
        }

        const byName = Object.fromEntries(problems.map(p => [p.name, p]));
        const bySide = Object.fromEntries(services.map(s => [s.side, s]));
        const runs = schedule(problems.map(p => p.name), services.map(s => s.side), options.rounds);
        const width = String(runs.length).length;

        for (const [i, run] of runs.entries()) {
            const p = byName[run.problem], s = bySide[run.side];
            let measured;
            if (p.kind === 'optimization-job') {
                const { http, outcome, wallMs } = await solveOptimizationJob(s, p, runTag, run.round);
                measured = measure(p, http, outcome, wallMs, { allowFallback: options.allowFallback });
            } else if (p.kind === 'multi-material') {
                const { http, response, wallMs } = await solveMultiMaterial(s, p.body);
                measured = measure(p, http, response, wallMs, { allowFallback: options.allowFallback });
            } else {
                const { http, response, wallMs } = await solveNesting(s, p.body);
                measured = measure(p, http, response, wallMs, { allowFallback: options.allowFallback });
            }
            const row = { round: run.round, problem: p.name, side: s.side, label: s.label, hash: p.hash, ...measured };
            record.rows.push(row);
            save();
            log(`[${String(i + 1).padStart(width)}/${runs.length}] ${formatRun(row)}`);
        }
        record.complete = true;
    } catch (error) {
        if (!(error instanceof Abort)) throw error;
        record.abortReason = error.message;
        log(error.message);
    } finally {
        if (thresholds) {
            record.thresholdEvaluation = evaluateThresholds(summarize(record.rows), thresholds, {
                requiredProblems: options.names
            });
        }
        record.finishedAt = new Date().toISOString();
        save();
    }

    console.log(formatReport(record, thresholds));
    log(`结果：${out}`);
    const thresholdOk = !record.thresholdEvaluation || record.thresholdEvaluation.passed;
    const exitCode = record.complete ? (record.rows.every(r => r.ok) && thresholdOk ? 0 : 1) : 2;
    return { exitCode, record, out };
}

function isMainModule() {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
    Promise.resolve()
        .then(() => executeBenchmark(parseRunArgs()))
        .then(
            res => { process.exitCode = res?.exitCode ?? 0; },
            error => {
                log(error instanceof Abort ? error.message : error.stack);
                process.exitCode = 2;
            }
        );
}
