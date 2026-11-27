// Pure helpers for run.mjs and report.mjs: run order, per-run measurement, summaries and tables. No I/O.
import { expectedEngine, netShapeArea, problemKind } from './problems.mjs';

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

function measure2D(body, http, response, wallMs, expected, extraIssues = [], allowFallback = false) {
    const placements = response?.placements ?? [], cuts = response?.cuts ?? [], metrics = response?.metrics ?? {};
    const ids = placements.map(p => p.id);
    const requested = body.parts.reduce((sum, p) => sum + p.quantity, 0);
    const issues = [...extraIssues];
    if (http !== 200 || response?.status !== 'FEASIBLE')
        issues.push(`HTTP ${http} ${response?.status ?? '无结果'}${response?.message ? `：${response.message}` : ''}`);
    if (!allowFallback) {
        if (response?.engine && response.engine !== expected) issues.push(`引擎 ${response.engine}，预期 ${expected}`);
        if (response?.fallbackReason) issues.push(`降级：${response.fallbackReason}`);
    }
    if (new Set(ids).size !== ids.length) issues.push('裁片编号重复');

    // 带内孔题目核验：若后端返回 pieceAreaMm2 且全部裁片包含内孔或已排满，校验扣孔后净面积口径一致
    const hasHoles = body.parts.some(p => Array.isArray(p.shape?.holes) && p.shape.holes.length > 0);
    if (hasHoles && metrics.pieceAreaMm2 != null && placements.length > 0) {
        const partById = new Map(body.parts.map(p => [p.id, p]));
        let expectedNetSum = null;
        if (placements.every(pl => pl.partId != null && partById.has(pl.partId))) {
            expectedNetSum = placements.reduce((sum, pl) => sum + netShapeArea(partById.get(pl.partId).shape), 0);
        } else if (placements.length === requested) {
            expectedNetSum = body.parts.reduce((sum, p) => sum + p.quantity * netShapeArea(p.shape), 0);
        }
        if (expectedNetSum != null && Math.abs(metrics.pieceAreaMm2 - expectedNetSum) > 5.0) {
            issues.push(`内孔净面积校验异常：返回 ${metrics.pieceAreaMm2}，预期 ${round(expectedNetSum, 2)}`);
        }
    }

    const elapsedMs = response?.elapsedMs ?? null;
    return {
        kind: 'nesting',
        http, status: response?.status ?? null, engine: response?.engine ?? null,
        requestedEngine: response?.requestedEngine ?? null, fallbackReason: response?.fallbackReason ?? null,
        ok: issues.length === 0, issues, requested, placed: ids.length, unplaced: requested - ids.length,
        utilization: metrics.processingAreaMm2 ? round(100 * metrics.pieceAreaMm2 / metrics.processingAreaMm2, 2) : null,
        pieceAreaM2: metrics.pieceAreaMm2 == null ? null : round(metrics.pieceAreaMm2 / 1e6, 2),
        // Continuous feed advances along +Y, so the furthest piece edge is the length this solve consumes.
        usedLengthMm: body.process.feedMode === 'CONTINUOUS' && placements.length
            ? round(placements.reduce((max, p) => Math.max(max, p.y + p.shape.height), 0), 1) : null,
        cuts: cuts.length, airDistanceM: round(cuts.reduce((sum, c) => sum + (c.airDistanceMm ?? 0), 0) / 1000, 2),
        elapsedMs, wallMs, overrunMs: elapsedMs == null ? null : elapsedMs - body.timeLimitSeconds * 1000
    };
}

function measureSlitting(body, http, outcome, wallMs, expected, allowFallback = false) {
    const job = outcome?.job ?? null;
    const result = outcome?.result ?? outcome;
    const slitting = result?.slitting ?? null;
    const p = body.problem;
    const fulfillment = slitting?.fulfillment ?? [];
    const requested = fulfillment.length
        ? fulfillment.reduce((sum, f) => sum + (f.requested ?? 0), 0)
        : p.orders.reduce((sum, o) => sum + o.quantity, 0);
    const placed = fulfillment.reduce((sum, f) => sum + (f.produced ?? 0), 0);
    const overproduced = slitting?.totalOverproduced ?? null;
    const issues = [];

    if (http !== 200 && http !== 202) issues.push(`HTTP ${http}`);
    if (job && job.state !== 'SUCCEEDED') issues.push(`作业状态 ${job.state}${job.message ? `：${job.message}` : ''}`);
    if (!result) issues.push('缺少 OptimizationResult');
    else if (result.validationStatus !== 'PASSED') issues.push(`结果校验未通过：${result.validationStatus}`);
    if (!slitting || slitting.status !== 'FEASIBLE') issues.push(`分切状态 ${slitting?.status ?? '无结果'}`);
    if (!allowFallback && slitting?.engine && expected && slitting.engine !== expected) {
        issues.push(`引擎 ${slitting.engine}，预期 ${expected}`);
    }

    const metricsList = Array.isArray(result?.metrics) ? result.metrics : [];
    const metricVal = name => {
        const m = metricsList.find(item => item.name === name);
        return m && Number.isFinite(m.value) ? round(m.value, 2) : null;
    };
    const utilization = metricVal('motherAreaUtilization')
        ?? (slitting?.motherAreaMm2 > 0 ? round(100 * slitting.pieceAreaMm2 / slitting.motherAreaMm2, 2) : null);
    const usableUtilization = metricVal('usableAreaUtilization')
        ?? (slitting?.usableAreaMm2 > 0 ? round(100 * slitting.pieceAreaMm2 / slitting.usableAreaMm2, 2) : null);

    let elapsedMs = null;
    if (job?.startedAt && job?.finishedAt) {
        const diff = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
        if (Number.isFinite(diff) && diff >= 0) elapsedMs = Math.round(diff);
    }
    if (elapsedMs == null) elapsedMs = wallMs ?? null;

    return {
        kind: 'SLITTING_1D',
        http,
        status: slitting?.status ?? job?.state ?? null,
        engine: slitting?.engine ?? expected ?? 'or-tools',
        requestedEngine: expected ?? 'or-tools',
        fallbackReason: null,
        ok: issues.length === 0,
        issues,
        requested,
        placed,
        unplaced: Math.max(0, requested - placed),
        overproduced,
        patternsCount: slitting?.patterns?.length ?? null,
        estimatedKnifeChanges: slitting?.estimatedKnifeChanges ?? null,
        utilization,
        usableUtilization,
        pieceAreaM2: slitting?.pieceAreaMm2 == null ? null : round(slitting.pieceAreaMm2 / 1e6, 2),
        usedLengthMm: null,
        cuts: 0,
        airDistanceM: 0,
        elapsedMs,
        wallMs,
        overrunMs: elapsedMs == null ? null : elapsedMs - p.timeLimitSeconds * 1000
    };
}

function measureMultiMaterial(body, http, response, wallMs, expected) {
    const requested = response?.totalRequestedPieces ?? body.demands.reduce((sum, d) => sum + d.quantity, 0);
    const placedByRemnants = response?.placedByRemnants ?? 0;
    const placedByRoll = response?.placedByRoll ?? 0;
    const unplacedPieces = response?.unplacedPieces ?? Math.max(0, requested - placedByRemnants - placedByRoll);
    const placed = placedByRemnants + placedByRoll;
    const remnants = response?.remnantAllocations ?? [];
    const rollOptions = response?.rollOptions ?? [];
    const adoptedRolls = rollOptions.filter(r => r.recommended || r.relayOrder != null);

    const issues = [];
    if (http !== 200 || !response) {
        issues.push(`HTTP ${http} ${response?.message ?? '无结果'}`);
    } else {
        if (response.totalRequestedPieces !== placedByRemnants + placedByRoll + response.unplacedPieces) {
            issues.push(`多料排产件数不守恒：${response.totalRequestedPieces} !== ${placedByRemnants}+${placedByRoll}+${response.unplacedPieces}`);
        }
        if (placed <= 0) {
            issues.push('多料联排未排入任何裁片');
        }
    }

    let totalPlacedAreaMm2 = 0;
    let totalConsumedAreaMm2 = 0;
    for (const rem of remnants) {
        totalPlacedAreaMm2 += (rem.piecesAreaM2 ?? 0) * 1e6;
        totalConsumedAreaMm2 += (rem.widthMm ?? 0) * (rem.lengthMm ?? 0);
    }
    for (const roll of adoptedRolls) {
        const rollConsumed = (roll.widthMm ?? 0) * (roll.estimatedCutLengthMm ?? 0);
        totalConsumedAreaMm2 += rollConsumed;
        totalPlacedAreaMm2 += rollConsumed * ((roll.utilizationPct ?? 0) / 100);
    }

    const utilization = totalConsumedAreaMm2 > 0 ? round(100 * totalPlacedAreaMm2 / totalConsumedAreaMm2, 2) : null;
    const elapsedMs = response?.elapsedMs ?? wallMs ?? null;
    const budgetMs = body.timeBudgetMs ?? 6000;

    return {
        kind: 'multi-material',
        http,
        status: http === 200 && placed > 0 ? 'FEASIBLE' : 'FAILED',
        engine: expected ?? 'javaguillotine',
        requestedEngine: expected ?? 'javaguillotine',
        fallbackReason: null,
        ok: issues.length === 0,
        issues,
        requested,
        placed,
        unplaced: unplacedPieces,
        placedByRemnants,
        placedByRoll,
        remnantCount: remnants.length,
        relayRollCount: adoptedRolls.length,
        totalSavedAreaM2: response?.totalSavedAreaM2 == null ? null : round(response.totalSavedAreaM2, 2),
        utilization,
        pieceAreaM2: totalConsumedAreaMm2 > 0 ? round(totalPlacedAreaMm2 / 1e6, 2) : null,
        usedLengthMm: null,
        cuts: 0,
        airDistanceM: 0,
        elapsedMs,
        wallMs,
        overrunMs: elapsedMs == null ? null : elapsedMs - budgetMs
    };
}

/** One solve's fixed outputs. Supports 2D nesting, optimization-job (2D/1D), and multi-material planning. */
export function measure(target, http, outcome, wallMs, options = {}) {
    const body = target?.body ?? target;
    const kind = target?.kind ?? problemKind(body);
    const expected = target?.expectedEngine ?? expectedEngine(body);
    const allowFallback = Boolean(options.allowFallback);

    if (kind === 'optimization-job') {
        if (body.problemType === 'SLITTING_1D') {
            return measureSlitting(body, http, outcome, wallMs, expected, allowFallback);
        }
        const job = outcome?.job ?? null;
        const result = outcome?.result ?? outcome;
        const extraIssues = [];
        if (http !== 200 && http !== 202) extraIssues.push(`HTTP ${http}`);
        if (job && job.state !== 'SUCCEEDED') extraIssues.push(`作业状态 ${job.state}${job.message ? `：${job.message}` : ''}`);
        if (result && result.validationStatus !== 'PASSED') extraIssues.push(`结果校验未通过：${result.validationStatus}`);
        const layout = result?.layout ?? null;
        const measured = measure2D(body.problem, layout ? 200 : http, layout, wallMs, expected, extraIssues, allowFallback);
        if (measured.elapsedMs == null && job?.startedAt && job?.finishedAt) {
            const diff = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
            if (Number.isFinite(diff) && diff >= 0) {
                measured.elapsedMs = Math.round(diff);
                measured.overrunMs = measured.elapsedMs - body.problem.timeLimitSeconds * 1000;
            }
        }
        return { ...measured, kind: 'NESTING_2D_JOB' };
    }
    if (kind === 'multi-material') {
        return measureMultiMaterial(body, http, outcome, wallMs, expected);
    }
    return measure2D(body, http, outcome, wallMs, expected, [], allowFallback);
}

export function stats(values) {
    const list = values.filter(v => v != null);
    if (!list.length) return null;
    return { mean: round(list.reduce((sum, v) => sum + v, 0) / list.length, 2), min: Math.min(...list), max: Math.max(...list) };
}

const METRICS = [
    'placed', 'utilization', 'pieceAreaM2', 'usedLengthMm', 'cuts', 'airDistanceM', 'elapsedMs', 'overrunMs',
    'placedByRemnants', 'remnantCount', 'relayRollCount', 'totalSavedAreaM2', 'usableUtilization', 'overproduced', 'patternsCount'
];

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
        const group = {
            problem,
            kind: all[0].kind ?? 'nesting',
            side,
            label: all[0].label,
            n: valid.length,
            failed: all.length - valid.length,
            fallbackCount: valid.filter(r => r.fallbackReason).length,
            engines: [...new Set(all.map(r => r.engine).filter(Boolean))],
            requested: all[0].requested,
            issues: [...new Set(all.flatMap(r => r.issues))]
        };
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

/** Markdown tables: one row per problem and service, then optional specialized 1D/multi-material & diff tables. */
export function formatTable({ groups, comparisons }) {
    const lines = ['| 题目 | 服务 | 引擎 | n | 排入/需求 | 利用率 % | 耗时 ms | 越限 ms | 异常 |', '|---|---|---|---|---|---|---|---|---|'];
    for (const g of groups) {
        const noteParts = [];
        if (g.failed) noteParts.push(`${g.failed} 次：${g.issues.join('；')}`);
        if (g.fallbackCount) noteParts.push(`含降级 ${g.fallbackCount} 次`);
        lines.push(`| ${g.problem} | ${service(g)} | ${g.engines.join('/') || '—'} | ${g.n} | ${cell(g.placed, count)}/${g.requested} | ${cell(g.utilization, percent)} | ${cell(g.elapsedMs, ms)} | ${cell(g.overrunMs, ms)} | ${noteParts.join('；')} |`);
    }

    const slittingGroups = groups.filter(g => g.kind === 'SLITTING_1D' || g.overproduced != null || g.usableUtilization != null);
    if (slittingGroups.length) {
        lines.push('', '### 1D 分切扩展明细', '',
            '| 题目 | 服务 | 可用幅宽利用率 % | 排刀方案数 | 超产卷数 |', '|---|---|---|---|---|');
        for (const g of slittingGroups) {
            lines.push(`| ${g.problem} | ${service(g)} | ${cell(g.usableUtilization, percent)} | ${cell(g.patternsCount, count)} | ${cell(g.overproduced, count)} |`);
        }
    }

    const relayGroups = groups.filter(g => g.kind === 'multi-material' || g.placedByRemnants != null);
    if (relayGroups.length) {
        lines.push('', '### 多料联排扩展明细', '',
            '| 题目 | 服务 | 料头排入件数 | 命中料头数 | 接力母卷数 | 节省面积 m² |', '|---|---|---|---|---|---|');
        for (const g of relayGroups) {
            lines.push(`| ${g.problem} | ${service(g)} | ${cell(g.placedByRemnants, count)} | ${cell(g.remnantCount, count)} | ${cell(g.relayRollCount, count)} | ${cell(g.totalSavedAreaM2, percent)} |`);
        }
    }

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
        const extras = [];
        if (s.health?.slittingAvailable != null) extras.push(`slittingAvailable=${s.health.slittingAvailable}`);
        else if (s.capabilities?.slittingEngine?.available != null) extras.push(`slittingAvailable=${s.capabilities.slittingEngine.available}`);
        if (s.authStatus) extras.push(s.authStatus);
        lines.push(`- ${service(s)}：${[s.base, ...health, ...extras].join(' · ')}`);
    }
    return lines.join('\n');
}

/** One progress line per solve. */
export function formatRun(row) {
    const head = `第 ${row.round} 轮 ${row.problem} ${service(row)}`;
    if (!row.ok) return `${head}：✗ ${row.issues.join('；')}`;
    const suffix = row.fallbackReason ? `（降级）` : '';
    return `${head}：${row.placed}/${row.requested} · ${row.utilization == null ? '—' : percent(row.utilization)}% · ${row.elapsedMs} ms · ${row.engine}${suffix}`;
}

/** 按题目红线配置核验各分组的利用率、耗时、排入比例与专项（料头/接力/超产）红线。 */
export function evaluateThresholds(summary, thresholds, options = {}) {
    const rules = thresholds?.problems ?? thresholds ?? {};
    const violations = [];
    let checked = 0;

    if (options.requiredProblems?.length) {
        const tested = new Set(summary.groups.map(g => g.problem));
        for (const name of options.requiredProblems) {
            if (rules[name] && !tested.has(name)) {
                checked += 1;
                violations.push({
                    problem: name, side: '—', label: 'missing',
                    metric: 'missingProblem', actual: 0, limit: 1,
                    message: '红线要求题目未在本次结果中执行'
                });
            }
        }
    }

    for (const group of summary.groups) {
        const rule = rules[group.problem];
        if (!rule) continue;
        checked += 1;
        if (group.n === 0) {
            violations.push({
                problem: group.problem, side: group.side, label: group.label,
                metric: 'validRuns', actual: 0, limit: 1,
                message: `无有效运行（失败 ${group.failed} 次）`
            });
            continue;
        }
        if (rule.minUtilization != null) {
            const actual = group.utilization?.mean ?? null;
            if (actual == null || actual < rule.minUtilization) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'utilization', actual, limit: rule.minUtilization,
                    message: `均值利用率 ${actual == null ? '—' : `${percent(actual)}%`} 低于红线 ${percent(rule.minUtilization)}%`
                });
            }
        }
        if (rule.maxElapsedMs != null) {
            const actual = group.elapsedMs?.max ?? null;
            if (actual == null || actual > rule.maxElapsedMs) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'elapsedMs', actual, limit: rule.maxElapsedMs,
                    message: `最大耗时 ${actual == null ? '—' : `${ms(actual)} ms`} 超过红线 ${ms(rule.maxElapsedMs)} ms`
                });
            }
        }
        if (rule.minPlacedRatio != null && group.requested > 0) {
            const actual = group.placed ? round(group.placed.mean / group.requested, 4) : null;
            if (actual == null || actual < rule.minPlacedRatio) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'placedRatio', actual, limit: rule.minPlacedRatio,
                    message: `平均排入率 ${actual == null ? '—' : `${percent(actual * 100)}%`} 低于红线 ${percent(rule.minPlacedRatio * 100)}%`
                });
            }
        }
        if (rule.minRemnantPlaced != null) {
            const actual = group.placedByRemnants?.mean ?? null;
            if (actual == null || actual < rule.minRemnantPlaced) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'minRemnantPlaced', actual, limit: rule.minRemnantPlaced,
                    message: `料头排入件数 ${actual == null ? '—' : count(actual)} 低于红线 ${count(rule.minRemnantPlaced)}`
                });
            }
        }
        if (rule.minRelayRolls != null) {
            const actual = group.relayRollCount?.mean ?? null;
            if (actual == null || actual < rule.minRelayRolls) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'minRelayRolls', actual, limit: rule.minRelayRolls,
                    message: `接力母卷数 ${actual == null ? '—' : count(actual)} 低于红线 ${count(rule.minRelayRolls)}`
                });
            }
        }
        if (rule.maxOverproduced != null) {
            const actual = group.overproduced?.max ?? null;
            if (actual == null || actual > rule.maxOverproduced) {
                violations.push({
                    problem: group.problem, side: group.side, label: group.label,
                    metric: 'maxOverproduced', actual, limit: rule.maxOverproduced,
                    message: `最大超产卷数 ${actual == null ? '—' : count(actual)} 超过红线 ${count(rule.maxOverproduced)}`
                });
            }
        }
    }
    return { passed: violations.length === 0, checked, violations };
}

/** 格式化质量红线校验结论为中文 Markdown。 */
export function formatThresholdReport(evaluation) {
    if (!evaluation || evaluation.checked === 0) return '> 质量红线：本次结果无匹配红线规则的题目。';
    if (evaluation.passed) return `> 质量红线：全部通过（共校验 ${evaluation.checked} 组）。`;
    const lines = [
        `> 质量红线：未通过（共校验 ${evaluation.checked} 组，发现 ${evaluation.violations.length} 项违约）。`,
        '',
        '| 题目 | 服务 | 指标 | 实测 | 红线 | 说明 |',
        '|---|---|---|---|---|---|',
    ];
    for (const v of evaluation.violations) {
        lines.push(`| ${v.problem} | ${service(v)} | ${v.metric} | ${v.actual ?? '—'} | ${v.limit} | ${v.message} |`);
    }
    return lines.join('\n');
}

/** Header and tables for a results file; an interrupted run is labelled as such. */
export function formatReport(record, thresholds = null) {
    const parts = [formatHeader(record)];
    if (!record.complete) parts.push(`> 未完成：${record.abortReason ?? '运行中断'}；以下只统计已完成的 ${record.rows.length} 次。`);
    const summary = summarize(record.rows);
    parts.push(formatTable(summary));
    const evaluation = record.thresholdEvaluation ?? (thresholds ? evaluateThresholds(summary, thresholds) : null);
    if (evaluation) parts.push(formatThresholdReport(evaluation));
    return parts.join('\n\n');
}
