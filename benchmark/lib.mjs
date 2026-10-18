// Pure helpers for run.mjs and report.mjs: run order, per-run measurement, summaries and tables. No I/O.
import { expectedEngine } from './problems.mjs';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** "[label=]http://host:port" → { label, base } without a trailing slash. */
export function parseBase(arg, defaultLabel) {
    const match = /^(?:([^=]+)=)?(https?:\/\/.+?)\/*$/.exec(arg);
    if (!match) throw new Error(`服务地址须以 http:// 或 https:// 开头：${arg}`);
    return { label: match[1] ?? defaultLabel, base: match[2] };
}

/**
 * Every round runs every problem once on each service, back to back. With two services the first one goes first in
 * odd rounds and second in even rounds, so slow drift and order effects hit both sides alike.
 */
export function schedule(problems, sides, rounds) {
    const runs = [];
    for (let r = 1; r <= rounds; r++)
        for (const problem of problems)
            for (const side of r % 2 ? sides : [...sides].reverse()) runs.push({ round: r, problem, side });
    return runs;
}

/** One solve's fixed outputs. A run counts only if it is FEASIBLE on the expected engine, without fallback. */
export function measure(body, http, response, wallMs) {
    const placements = response?.placements ?? [], cuts = response?.cuts ?? [], metrics = response?.metrics ?? {};
    const ids = placements.map(p => p.id);
    const requested = body.parts.reduce((sum, p) => sum + p.quantity, 0);
    const expected = expectedEngine(body);
    const issues = [];
    if (http !== 200 || response?.status !== 'FEASIBLE')
        issues.push(`HTTP ${http} ${response?.status ?? '无结果'}${response?.message ? `：${response.message}` : ''}`);
    if (response?.engine && response.engine !== expected) issues.push(`引擎 ${response.engine}，预期 ${expected}`);
    if (response?.fallbackReason) issues.push(`降级：${response.fallbackReason}`);
    if (new Set(ids).size !== ids.length) issues.push('裁片编号重复');
    const elapsedMs = response?.elapsedMs ?? null;
    return { http, status: response?.status ?? null, engine: response?.engine ?? null,
        requestedEngine: response?.requestedEngine ?? null, fallbackReason: response?.fallbackReason ?? null,
        ok: issues.length === 0, issues, requested, placed: ids.length, unplaced: requested - ids.length,
        utilization: metrics.processingAreaMm2 ? round(100 * metrics.pieceAreaMm2 / metrics.processingAreaMm2, 2) : null,
        pieceAreaM2: metrics.pieceAreaMm2 == null ? null : round(metrics.pieceAreaMm2 / 1e6, 2),
        // Continuous feed advances along +Y, so the furthest piece edge is the length this solve consumes.
        usedLengthMm: body.process.feedMode === 'CONTINUOUS' && placements.length
            ? round(placements.reduce((max, p) => Math.max(max, p.y + p.shape.height), 0), 1) : null,
        cuts: cuts.length, airDistanceM: round(cuts.reduce((sum, c) => sum + (c.airDistanceMm ?? 0), 0) / 1000, 2),
        elapsedMs, wallMs, overrunMs: elapsedMs == null ? null : elapsedMs - body.timeLimitSeconds * 1000 };
}

export function stats(values) {
    const list = values.filter(v => v != null);
    if (!list.length) return null;
    return { mean: round(list.reduce((sum, v) => sum + v, 0) / list.length, 2), min: Math.min(...list), max: Math.max(...list) };
}

const METRICS = ['placed', 'utilization', 'pieceAreaM2', 'usedLengthMm', 'cuts', 'airDistanceM', 'elapsedMs', 'overrunMs'];

// n is the smaller side's valid run count: a single run per side has no range to separate.
function compare(a, b, n) {
    if (!a || !b) return null;
    const verdict = a.min === a.max && b.min === b.max && a.min === b.min ? 'same'
        : n < 2 ? 'single' : a.max < b.min || b.max < a.min ? 'separated' : 'overlap';
    return { delta: round(b.mean - a.mean, 2), verdict };
}

/** Mean and range per problem and service over valid runs; with two services, second minus first. */
export function summarize(rows) {
    const problems = [...new Set(rows.map(r => r.problem))], sides = [...new Set(rows.map(r => r.side))].sort();
    const groups = [];
    for (const problem of problems) for (const side of sides) {
        const all = rows.filter(r => r.problem === problem && r.side === side);
        if (!all.length) continue;
        const valid = all.filter(r => r.ok);
        const group = { problem, side, label: all[0].label, n: valid.length, failed: all.length - valid.length,
            engines: [...new Set(all.map(r => r.engine).filter(Boolean))], requested: all[0].requested,
            issues: [...new Set(all.flatMap(r => r.issues))] };
        for (const metric of METRICS) group[metric] = stats(valid.map(r => r[metric]));
        groups.push(group);
    }
    const comparisons = sides.length !== 2 ? [] : problems.flatMap(problem => {
        const [a, b] = sides.map(side => groups.find(g => g.problem === problem && g.side === side));
        if (!a || !b) return [];
        const n = Math.min(a.n, b.n);
        return [{ problem, a: { side: a.side, label: a.label }, b: { side: b.side, label: b.label },
            placed: compare(a.placed, b.placed, n), utilization: compare(a.utilization, b.utilization, n),
            elapsedMs: compare(a.elapsedMs, b.elapsedMs, n) }];
    });
    return { groups, comparisons };
}

const count = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
const percent = v => v.toFixed(2);
const ms = v => String(Math.round(v));
const cell = (stat, format) => !stat ? '—' : stat.min === stat.max ? format(stat.min) : `${format(stat.mean)}（${format(stat.min)}–${format(stat.max)}）`;
const signed = (change, format) => !change ? '—' : change.delta > 0 ? `+${format(change.delta)}` : change.delta < 0 ? `-${format(-change.delta)}` : '0';
const service = ({ side, label }) => label === side ? side : `${side} ${label}`;
const VERDICT = { same: '一致', single: '单次', separated: '区间分离', overlap: '区间重叠' };

/** Markdown tables: one row per problem and service, then the second-minus-first differences. */
export function formatTable({ groups, comparisons }) {
    const lines = ['| 题目 | 服务 | 引擎 | n | 排入/需求 | 利用率 % | 耗时 ms | 越限 ms | 异常 |', '|---|---|---|---|---|---|---|---|---|'];
    for (const g of groups)
        lines.push(`| ${g.problem} | ${service(g)} | ${g.engines.join('/') || '—'} | ${g.n} | ${cell(g.placed, count)}/${g.requested} | ${cell(g.utilization, percent)} | ${cell(g.elapsedMs, ms)} | ${cell(g.overrunMs, ms)} | ${g.failed ? `${g.failed} 次：${g.issues.join('；')}` : ''} |`);
    if (comparisons.length) {
        const { a, b } = comparisons[0];
        lines.push('', `${service(b)} − ${service(a)}（均值之差；区间按利用率判断）：`, '',
            '| 题目 | Δ排入 | Δ利用率 | Δ耗时 ms | 利用率区间 |', '|---|---|---|---|---|');
        for (const c of comparisons)
            lines.push(`| ${c.problem} | ${signed(c.placed, count)} | ${signed(c.utilization, percent)} | ${signed(c.elapsedMs, ms)} | ${c.utilization ? VERDICT[c.utilization.verdict] : '—'} |`);
    }
    return lines.join('\n');
}

/** The catalogue for --list: what each problem asks for and the hash of the exact body it sends. */
export function formatProblems(list) {
    const lines = ['| 题目 | 工艺/送料 | 材料 mm | 规格/件数 | 需求/面积 | 避让 | 限时 s | 预期引擎 | 哈希 | 说明 |', '|---|---|---|---|---|---|---|---|---|---|'];
    for (const p of list)
        lines.push(`| ${p.name} | ${p.mode}/${p.feedMode} | ${p.material} | ${p.parts}/${p.pieces} | ${p.demandRatio} | ${p.exclusions} | ${p.timeLimitSeconds} | ${p.expectedEngine} | ${p.hash} | ${p.title} |`);
    return lines.join('\n');
}

/** Run conditions above the tables: suite checkout, options, host, and each service's engine status. */
export function formatHeader({ suiteCheckout, startedAt, options, host, services }) {
    const checkout = !suiteCheckout?.commit ? '未知' : suiteCheckout.dirty ? `${suiteCheckout.commit}（有未提交改动）` : suiteCheckout.commit;
    const lines = [`# 排料基准 ${startedAt}`, '',
        `- 套件：${checkout} · ${options.rounds} 轮 · 每个引擎预热 ${options.warmup} 次 · 限时 ${options.timeLimitSeconds == null ? '按题目' : `统一 ${options.timeLimitSeconds} s`}`,
        `- 主机：${host.os} · ${host.cpu} · ${host.logicalCpus} 逻辑核 · Node ${host.node}`];
    for (const s of services) {
        const health = Object.entries(s.health ?? {}).filter(([key]) => key.startsWith('packingsolver')).map(([key, value]) => `${key}=${value}`);
        lines.push(`- ${service(s)}：${[s.base, ...health].join(' · ')}`);
    }
    return lines.join('\n');
}

/** One progress line per solve. */
export function formatRun(row) {
    const head = `第 ${row.round} 轮 ${row.problem} ${service(row)}`;
    if (!row.ok) return `${head}：✗ ${row.issues.join('；')}`;
    return `${head}：${row.placed}/${row.requested} · ${row.utilization == null ? '—' : percent(row.utilization)}% · ${row.elapsedMs} ms · ${row.engine}`;
}

/** Header and tables for a results file; an interrupted run is labelled as such. */
export function formatReport(record) {
    const parts = [formatHeader(record)];
    if (!record.complete) parts.push(`> 未完成：${record.abortReason ?? '运行中断'}；以下只统计已完成的 ${record.rows.length} 次。`);
    parts.push(formatTable(summarize(record.rows)));
    return parts.join('\n\n');
}
