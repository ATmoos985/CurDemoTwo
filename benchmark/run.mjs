#!/usr/bin/env node
// Solves the benchmark problems on one or two running services, interleaved and repeated, and prints mean and range
// per problem and service. The results file is rewritten after every solve, so an interrupted run keeps what it has.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETS, prepare, problemNames } from './problems.mjs';
import { parseBase, schedule, measure, formatRun, formatReport, formatProblems } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `用法：node benchmark/run.mjs [选项] <A 服务> [B 服务]
  服务写作 [标签=]http://主机:端口，例如 30e3d4b=http://127.0.0.1:18310；给两个服务时输出 B − A。

  --set <题集>        ${Object.keys(SETS).join('、')}（默认 demo）
  --problems <列表>   逗号分隔的题目名，覆盖 --set；也接受 scenario<N>、synthetic<N>、distinct<N>
  --rounds <n>        轮数，默认 4。两个服务时奇数轮 A 先、偶数轮 B 先，取偶数先后才平衡
  --warmup <n>        每个服务、每个引擎先以 1 s 限时预热几次，不计入结果（默认 1）
  --time-limit <s>    统一改写各题限时；请求体随之改变，哈希不再与默认题目相同
  --out <文件>        结果 JSON（默认 benchmark/results/<开始时间>.json）
  --smoke             冒烟：--set smoke --rounds 1 --warmup 0 --time-limit 2，可再用上面的选项覆盖
  --list              列出题目、预期引擎与请求体哈希后退出（可配合 --set、--problems、--time-limit）
  -h, --help          显示本说明

退出码：0 全部有效；1 有无效运行（非 FEASIBLE、引擎不符、降级或裁片编号重复）；2 参数错误、服务不可用或请求中断。`;

class Abort extends Error {}
const log = message => process.stderr.write(`${message}\n`);
const service = ({ side, label }) => label === side ? side : `${side} ${label}`;

function integer(name, value, min) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) throw new Abort(`--${name} 须为不小于 ${min} 的整数：${value}`);
    return n;
}

function readOptions() {
    let parsed;
    try {
        parsed = parseArgs({ allowPositionals: true, options: {
            set: { type: 'string' }, problems: { type: 'string' }, rounds: { type: 'string' }, warmup: { type: 'string' },
            'time-limit': { type: 'string' }, out: { type: 'string' }, smoke: { type: 'boolean' }, list: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' } } });
    } catch (error) {
        throw new Abort(`${error.message}\n\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    const defaults = values.smoke ? { set: 'smoke', rounds: 1, warmup: 0, timeLimit: 2 } : { set: 'demo', rounds: 4, warmup: 1, timeLimit: null };
    const set = values.set ?? defaults.set;
    if (!values.problems && !SETS[set]) throw new Abort(`未知题集 ${set}；可用：${Object.keys(SETS).join('、')}`);
    // --list on its own shows every named problem rather than the default set.
    const names = values.problems ? values.problems.split(',').map(s => s.trim()).filter(Boolean)
        : values.list && !values.set && !values.smoke ? problemNames() : SETS[set];
    return { help: values.help, list: values.list, set: values.problems ? null : set, names,
        rounds: values.rounds == null ? defaults.rounds : integer('rounds', values.rounds, 1),
        warmup: values.warmup == null ? defaults.warmup : integer('warmup', values.warmup, 0),
        timeLimitSeconds: values['time-limit'] == null ? defaults.timeLimit : integer('time-limit', values['time-limit'], 1),
        out: values.out, bases: positionals };
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

async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/** Health and engine list of each service; stops before solving if an engine the problems need is not ready. */
async function preflight(services, engines) {
    for (const s of services) {
        try {
            s.health = await getJson(`${s.base}/api/health`);
            s.engines = await getJson(`${s.base}/api/v1/nesting/engines`);
        } catch (error) {
            throw new Abort(`${service(s)} ${s.base} 无法访问：${error.cause?.message ?? error.message}`);
        }
        for (const id of engines) {
            const engine = s.engines.find(e => e.id === id);
            if (!engine?.available)
                throw new Abort(`${service(s)} ${s.base}：引擎 ${id} ${engine ? '未就绪' : '不存在'}，检查 --packingsolver.*.executable.path`);
        }
    }
}

async function solve(s, body) {
    const payload = JSON.stringify(body), started = performance.now();
    let http, text;
    try {
        const response = await fetch(`${s.base}/api/v1/nesting/solve`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: payload, signal: AbortSignal.timeout((body.timeLimitSeconds + 60) * 1000) });
        http = response.status;
        text = await response.text();
    } catch (error) {
        throw new Abort(`请求 ${service(s)} ${s.base} 失败：${error.cause?.message ?? error.message}`);
    }
    const wallMs = Math.round(performance.now() - started);
    let response;
    try {
        response = JSON.parse(text);
    } catch {
        response = { status: '非 JSON 响应', message: text.slice(0, 200) };
    }
    return { http, response, wallMs };
}

async function main() {
    const options = readOptions();
    if (options.help) return void console.log(USAGE);
    const problems = prepareAll(options.names, options.timeLimitSeconds);
    if (options.list) return void console.log(formatProblems(problems));
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
    const engines = [...new Set(problems.map(p => p.expectedEngine))];
    await preflight(services, engines);
    const startedAt = new Date().toISOString();
    const out = path.resolve(options.out ?? path.join(HERE, 'results', `${startedAt.replace(/[:.]/g, '-')}.json`));
    mkdirSync(path.dirname(out), { recursive: true });
    const record = { schema: 1, startedAt, finishedAt: null, complete: false, abortReason: null, suiteCheckout: suiteCheckout(),
        host: { os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model.trim() ?? '未知', logicalCpus: os.availableParallelism(), node: process.version },
        options: { set: options.set, problems: options.names, rounds: options.rounds, warmup: options.warmup, timeLimitSeconds: options.timeLimitSeconds },
        services, problems: problems.map(({ body, ...p }) => p), warmups: [], rows: [] };
    const save = () => writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

    save();
    log(`结果写入 ${out}`);
    try {
        for (const id of engines) {
            const first = problems.find(p => p.expectedEngine === id), body = { ...first.body, timeLimitSeconds: 1 };
            for (let i = 0; i < options.warmup; i++) for (const s of services) {
                const { http, response, wallMs } = await solve(s, body);
                record.warmups.push({ expectedEngine: id, engine: response.engine ?? null, problem: first.name, side: s.side, http, status: response.status, wallMs });
                save();
                log(`预热 ${id} ${service(s)}：HTTP ${http} ${response.status} · ${wallMs} ms`);
                if (http !== 200) throw new Abort(`预热 ${id} 在 ${service(s)} 上失败：HTTP ${http} ${response.status} ${response.message ?? ''}`);
            }
        }
        const byName = Object.fromEntries(problems.map(p => [p.name, p])), bySide = Object.fromEntries(services.map(s => [s.side, s]));
        const runs = schedule(problems.map(p => p.name), services.map(s => s.side), options.rounds);
        const width = String(runs.length).length;
        for (const [i, run] of runs.entries()) {
            const p = byName[run.problem], s = bySide[run.side];
            const { http, response, wallMs } = await solve(s, p.body);
            const row = { round: run.round, problem: p.name, side: s.side, label: s.label, hash: p.hash, ...measure(p.body, http, response, wallMs) };
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
        record.finishedAt = new Date().toISOString();
        save();
    }
    console.log(formatReport(record));
    log(`结果：${out}`);
    return record.complete ? (record.rows.every(r => r.ok) ? 0 : 1) : 2;
}

main().then(code => { process.exitCode = code ?? 0; }, error => {
    log(error instanceof Abort ? error.message : error.stack);
    process.exitCode = 2;
});
