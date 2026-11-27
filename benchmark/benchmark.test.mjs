import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETS, problem, problemNames, expectedEngine, hash, prepare, polygonWithHoles, netShapeArea } from './problems.mjs';
import {
    parseBase, schedule, measure, summarize, evaluateThresholds,
    formatTable, formatProblems, formatHeader, formatRun, formatThresholdReport, formatReport
} from './lib.mjs';
import { buildAuthHeaders, parseRunArgs } from './run.mjs';
import { assertSafePort, parseGateArgs, buildJavaArgs, captureDataFingerprint, verifyDataFingerprint } from './gate.mjs';

// Hashes of the exact request bodies sent in the earlier ad-hoc runs (02 and 05 notes), so results stay comparable.
test('synthetic problems reproduce the request bodies of the earlier COPIES and -e runs', () => {
    assert.equal(hash(problem('synthetic2000').body), 'e6227b8cb038');
    assert.equal(hash(problem('synthetic10000').body), '1869b4e841ef');
});

test('guillotine reproduces the nesting lab default request body', () => {
    assert.equal(hash(problem('guillotine').body), '949eca11ca5d');
});

test('distinct sizes come from a seeded mulberry32 generator and reproduce the 10000-type worst case', () => {
    const body = problem('distinct10000').body;
    assert.equal(hash(body), '1f76c4f8e32b');
    assert.equal(new Set(body.parts.map(p => `${p.shape.width}x${p.shape.height}`)).size, 10000);
    assert.deepEqual(problem('distinct2000').body, problem('distinct2000').body);
});

test('parametric problem families reject sizes outside the request cap', () => {
    assert.throws(() => problem('synthetic2005'), /10 的倍数/);
    assert.throws(() => problem('synthetic20000'), /10000/);
    assert.throws(() => problem('distinct0'), /10000/);
    assert.throws(() => problem('nope'), /synthetic2000/);
});

test('presets come from the front-end scenario data and keep their engine', () => {
    const scenario4 = problem('scenario4').body;
    assert.equal(scenario4.parts.reduce((sum, p) => sum + p.quantity, 0), 74);
    assert.equal(expectedEngine(scenario4), 'packingsolver');
    assert.equal(expectedEngine(problem('scenario1').body), 'crosscut');
    assert.equal(expectedEngine(problem('contour14').body), 'deepnest');
    assert.equal(expectedEngine(problem('contour14-native').body), 'packingsolver-irregular');
    assert.equal(expectedEngine(problem('guillotine-java').body), 'javaguillotine');
    assert.equal(expectedEngine(problem('scenario4-java').body), 'javaguillotine');
    assert.equal(expectedEngine({ ...scenario4, engine: 'javaguillotine' }), 'javaguillotine');
    assert.equal(expectedEngine(problem('slitting-basic').body), 'ortools-1d');
    assert.equal(expectedEngine(problem('nesting-2d-job').body), 'javaguillotine');
    assert.equal(expectedEngine(problem('multi-material-relay').body), 'javaguillotine');
});

test('sets only name catalogue problems and all is demo plus large', () => {
    assert.deepEqual(SETS.all, [...SETS.demo, ...SETS.large]);
    for (const name of Object.values(SETS).flat()) assert.ok(problemNames().includes(name), name);
    assert.equal(SETS['v2-gate'].length, 8);
});

test('base arguments accept an optional label', () => {
    assert.deepEqual(parseBase('before=http://127.0.0.1:18310/', 'A'), { label: 'before', base: 'http://127.0.0.1:18310' });
    assert.deepEqual(parseBase('http://127.0.0.1:18311', 'B'), { label: 'B', base: 'http://127.0.0.1:18311' });
    assert.throws(() => parseBase('18310', 'A'), /http/);
});

test('two services alternate which runs first by round and every round covers every problem', () => {
    const runs = schedule(['p', 'q'], ['A', 'B'], 4);
    assert.equal(runs.length, 16);
    assert.deepEqual(runs.slice(0, 8).map(r => `${r.round}${r.problem}${r.side}`),
        ['1pA', '1pB', '1qA', '1qB', '2pB', '2pA', '2qB', '2qA']);
    for (const name of ['p', 'q']) {
        const first = runs.filter((r, i) => r.problem === name && (i === 0 || runs[i - 1].problem !== name || runs[i - 1].round !== r.round));
        assert.equal(first.filter(r => r.side === 'A').length, 2);
        assert.equal(first.filter(r => r.side === 'B').length, 2);
    }
    assert.deepEqual(schedule(['p', 'q'], ['A'], 2).map(r => `${r.round}${r.problem}${r.side}`), ['1pA', '1qA', '2pA', '2qA']);
});

const continuous = { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 20,
    material: { id: 'M', shape: { type: 'RECTANGLE', width: 2000, height: 10000 }, continuesAfterRegion: true, exclusions: [] },
    parts: [{ id: 1, name: 'a', shape: { type: 'RECTANGLE', width: 1000, height: 500 }, quantity: 3, allowRotation: false }],
    process: { mode: 'GUILLOTINE', feedMode: 'CONTINUOUS' } };
const result = (extra = {}) => ({ status: 'FEASIBLE', engine: 'packingsolver', requestedEngine: 'packingsolver', fallbackReason: null,
    elapsedMs: 20150, placements: [{ id: 1, x: 0, y: 0, shape: { width: 1000, height: 500 } }, { id: 2, x: 0, y: 500, shape: { width: 1000, height: 500 } }],
    cuts: [{ airDistanceMm: 1500 }, { airDistanceMm: 250 }], metrics: { processingAreaMm2: 2e7, pieceAreaMm2: 1e6 }, ...extra });

test('a run records placed, utilization, elapsed and the engine that actually ran', () => {
    const row = measure(continuous, 200, result(), 20190);
    assert.equal(row.ok, true);
    assert.deepEqual(row.issues, []);
    assert.equal(row.engine, 'packingsolver');
    assert.equal(row.requested, 3);
    assert.equal(row.placed, 2);
    assert.equal(row.unplaced, 1);
    assert.equal(row.utilization, 5);
    assert.equal(row.pieceAreaM2, 1);
    assert.equal(row.usedLengthMm, 1000);
    assert.equal(row.cuts, 2);
    assert.equal(row.airDistanceM, 1.75);
    assert.equal(row.elapsedMs, 20150);
    assert.equal(row.overrunMs, 150);
    assert.equal(row.wallMs, 20190);
});

test('fallback, an unexpected engine, duplicate ids and failed requests are not counted as valid runs', () => {
    assert.match(measure(continuous, 200, result({ engine: 'javaguillotine', fallbackReason: '缺失' }), 1).issues.join(), /javaguillotine.*降级/);
    const duplicate = result({ placements: [{ id: 1, x: 0, y: 0, shape: { width: 1, height: 1 } }, { id: 1, x: 0, y: 1, shape: { width: 1, height: 1 } }] });
    assert.match(measure(continuous, 200, duplicate, 1).issues.join(), /编号重复/);
    const failed = measure(continuous, 503, { status: 'UNAVAILABLE', message: '原生直刀引擎可执行文件缺失', engine: 'packingsolver' }, 5);
    assert.equal(failed.ok, false);
    assert.equal(failed.placed, 0);
    assert.match(failed.issues.join(), /HTTP 503.*UNAVAILABLE/);
    assert.equal(measure({ ...continuous, process: { mode: 'GUILLOTINE', feedMode: 'SHEET' } }, 200, result(), 1).usedLengthMm, null);
    const allowedFallback = measure(continuous, 200, result({ engine: 'javaguillotine', fallbackReason: '原生缺失' }), 1, { allowFallback: true });
    assert.equal(allowedFallback.ok, true);
    assert.equal(allowedFallback.fallbackReason, '原生缺失');
});

const row = (side, placed, utilization, elapsedMs, ok = true) =>
    ({ problem: 'synthetic2000', side, label: side === 'A' ? 'before' : 'after', ok, issues: ok ? [] : ['HTTP 500'], engine: 'packingsolver',
        requested: 2000, placed, utilization, elapsedMs, overrunMs: elapsedMs - 20000, pieceAreaM2: null, usedLengthMm: null, cuts: 0, airDistanceM: 0 });

test('summary reports mean and range per problem and side over valid runs only', () => {
    const summary = summarize([row('A', 506, 64.1, 20150), row('B', 1106, 99.33, 20300), row('B', 1106, 99.33, 20440),
        row('A', 1062, 94.93, 20870), row('A', 0, 0, 25000, false)]);
    const [a, b] = summary.groups;
    assert.equal(a.side, 'A');
    assert.equal(a.n, 2);
    assert.equal(a.failed, 1);
    assert.deepEqual(a.placed, { mean: 784, min: 506, max: 1062 });
    assert.deepEqual(a.engines, ['packingsolver']);
    assert.deepEqual(b.utilization, { mean: 99.33, min: 99.33, max: 99.33 });
    assert.deepEqual(b.elapsedMs, { mean: 20370, min: 20300, max: 20440 });
    const [compare] = summary.comparisons;
    assert.equal(compare.placed.delta, 322);
    assert.equal(compare.utilization.verdict, 'separated');
    assert.equal(compare.elapsedMs.verdict, 'overlap');
});

test('identical results on both services are reported as the same', () => {
    const summary = summarize([row('A', 34, 96.75, 3131), row('B', 34, 96.75, 3171), row('B', 34, 96.75, 3204), row('A', 34, 96.75, 3180)]);
    assert.equal(summary.comparisons[0].utilization.verdict, 'same');
    assert.equal(summary.comparisons[0].placed.delta, 0);
});

test('the table shows mean with range, collapsing constant values', () => {
    const text = formatTable(summarize([row('A', 506, 64.1, 20150), row('A', 1062, 94.94, 20870), row('B', 1106, 99.33, 20300), row('B', 1106, 99.33, 20440)]));
    assert.match(text, /\| synthetic2000 \| A before \| packingsolver \| 2 \| 784（506–1062）\/2000 \| 79.52（64.10–94.94） \| 20510（20150–20870） \|/);
    assert.match(text, /\| synthetic2000 \| B after \| packingsolver \| 2 \| 1106\/2000 \| 99.33 \| 20370（20300–20440） \|/);
    assert.match(text, /\| synthetic2000 \| \+322 \| \+19.81 \| -140 \| 区间分离 \|/);
});

test('the problem list shows each body hash and the engine it should run on', () => {
    const text = formatProblems([{ name: 'synthetic2000', title: '合成', hash: 'e6227b8cb038', expectedEngine: 'packingsolver', mode: 'GUILLOTINE',
        feedMode: 'CONTINUOUS', material: '2000×60000', parts: 10, pieces: 2000, demandRatio: 1.75, exclusions: 2, timeLimitSeconds: 20 }]);
    assert.match(text, /\| synthetic2000 \| GUILLOTINE\/CONTINUOUS \| 2000×60000 \| 10\/2000 \| 1.75 \| 2 \| 20 \| packingsolver \| e6227b8cb038 \| 合成 \|/);
});

test('the header names each service, its engine status and the suite checkout', () => {
    const text = formatHeader({ suiteCheckout: { commit: 'abc1234', dirty: true }, startedAt: '2026-10-18T06:00:00.000Z',
        options: { rounds: 4, warmup: 1, timeLimitSeconds: null }, host: { os: 'win32 10.0.26200', cpu: 'i9', logicalCpus: 20, node: 'v24.15.0' },
        services: [{ side: 'A', label: 'before', base: 'http://127.0.0.1:18310',
            health: { packingsolverAvailable: true, packingsolverFallback: null, slittingAvailable: true }, authStatus: 'auth=enabled(admin)' }] });
    assert.match(text, /abc1234（有未提交改动）/);
    assert.match(text, /4 轮/);
    assert.match(text, /A before：http:\/\/127\.0\.0\.1:18310 · packingsolverAvailable=true · packingsolverFallback=null · slittingAvailable=true · auth=enabled\(admin\)/);
});

test('a prepared problem hashes the body it sends, including a time-limit override', () => {
    const canonical = prepare('synthetic2000');
    assert.equal(canonical.hash, 'e6227b8cb038');
    assert.equal(canonical.expectedEngine, 'packingsolver');
    assert.equal(canonical.pieces, 2000);
    const smoke = prepare('synthetic2000', 2);
    assert.equal(smoke.body.timeLimitSeconds, 2);
    assert.equal(smoke.timeLimitSeconds, 2);
    assert.notEqual(smoke.hash, canonical.hash);
    assert.equal(problem('synthetic2000').body.timeLimitSeconds, 20);
});

test('each solve prints one progress line with its outcome or its issues', () => {
    assert.equal(formatRun({ ...row('B', 1106, 99.33, 20370), round: 2 }), '第 2 轮 synthetic2000 B after：1106/2000 · 99.33% · 20370 ms · packingsolver');
    assert.equal(formatRun({ ...row('A', 0, null, null, false), round: 1, issues: ['HTTP 503 UNAVAILABLE'] }), '第 1 轮 synthetic2000 A before：✗ HTTP 503 UNAVAILABLE');
});

test('a report of an interrupted run says so and how many solves it covers', () => {
    const record = { suiteCheckout: { commit: 'abc1234', dirty: false }, startedAt: 'T', options: { rounds: 4, warmup: 1, timeLimitSeconds: null },
        host: { os: 'o', cpu: 'c', logicalCpus: 1, node: 'n' }, services: [], complete: false, abortReason: '请求 B 失败：ECONNREFUSED',
        rows: [row('A', 506, 64.1, 20150)] };
    const text = formatReport(record);
    assert.match(text, /未完成：请求 B 失败：ECONNREFUSED；以下只统计已完成的 1 次/);
    assert.match(text, /\| synthetic2000 \| A before \|/);
    assert.doesNotMatch(formatReport({ ...record, complete: true }), /未完成/);
});

test('one run per side is not reported as separated ranges', () => {
    const summary = summarize([row('A', 252, 33.36, 2331), row('B', 785, 93.62, 2337)]);
    assert.equal(summary.comparisons[0].utilization.verdict, 'single');
    assert.match(formatTable(summary), /\| synthetic2000 \| \+533 \| \+60.26 \| \+6 \| 单次 \|/);
    const same = summarize([row('A', 34, 96.75, 2149), row('B', 34, 96.75, 2162)]);
    assert.equal(same.comparisons[0].utilization.verdict, 'same');
});

test('thresholds.json 覆盖 demo 全 10 题与 v2-gate 全 8 题并具备合法红线字段', () => {
    const config = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
    assert.equal(config.schemaVersion, 1);
    const catalogue = new Set(problemNames());
    const entries = Object.entries(config.problems);
    assert.ok(entries.length >= 20);
    for (const name of [...SETS.demo, ...SETS['v2-gate']]) {
        assert.ok(config.problems[name], `thresholds.json 缺少必测题目：${name}`);
    }
    for (const [name, rule] of entries) {
        assert.ok(catalogue.has(name), `未知红线题目：${name}`);
        assert.ok(typeof rule.minUtilization === 'number' && rule.minUtilization > 0 && rule.minUtilization <= 100);
        assert.ok(typeof rule.maxElapsedMs === 'number' && rule.maxElapsedMs > 0);
        if (rule.minPlacedRatio != null) {
            assert.ok(typeof rule.minPlacedRatio === 'number' && rule.minPlacedRatio > 0 && rule.minPlacedRatio <= 1);
        }
        if (rule.minRemnantPlaced != null) assert.ok(rule.minRemnantPlaced >= 1);
        if (rule.minRelayRolls != null) assert.ok(rule.minRelayRolls >= 1);
        if (rule.maxOverproduced != null) assert.ok(rule.maxOverproduced >= 0);
    }
});

test('evaluateThresholds 校验利用率、耗时、排入比例与无有效运行违约并输出中文报告', () => {
    const config = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
    const okSummary = summarize([
        row('A', 1106, 92.5, 20300),
        { ...row('A', 1, 56.25, 450), problem: 'guillotine-java', requested: 1, engine: 'javaguillotine' },
        { ...row('A', 14, 82.24, 300), problem: 'contour14', requested: 14, engine: 'deepnest' },
        { ...row('A', 2000, 90.0, 12000), problem: 'distinct2000', requested: 2000, engine: 'packingsolver' },
    ]);
    const passed = evaluateThresholds(okSummary, config);
    assert.equal(passed.passed, true);
    assert.equal(passed.checked, 3);
    assert.deepEqual(passed.violations, []);
    assert.match(formatThresholdReport(passed), /全部通过（共校验 3 组）/);

    const failSummary = summarize([
        row('A', 500, 62.0, 26500),
        { ...row('A', 0, 0, 500, false), problem: 'contour14-native', requested: 14, engine: 'packingsolver-irregular' },
        { ...row('A', 0, 55.0, 400), problem: 'guillotine-java', requested: 1, engine: 'javaguillotine' },
    ]);
    const failed = evaluateThresholds(failSummary, config);
    assert.equal(failed.passed, false);
    assert.equal(failed.checked, 3);
    assert.deepEqual(failed.violations.map(v => `${v.problem}:${v.metric}`), [
        'synthetic2000:utilization',
        'synthetic2000:elapsedMs',
        'contour14-native:validRuns',
        'guillotine-java:placedRatio',
    ]);
    const text = formatThresholdReport(failed);
    assert.match(text, /未通过（共校验 3 组，发现 4 项违约）/);
    assert.match(text, /synthetic2000/);
    assert.match(text, /contour14-native/);

    const reportText = formatReport({
        suiteCheckout: { commit: 'abc1234', dirty: false }, startedAt: 'T',
        options: { rounds: 1, warmup: 0, timeLimitSeconds: null },
        host: { os: 'o', cpu: 'c', logicalCpus: 1, node: 'n' }, services: [], complete: true,
        rows: [row('A', 1106, 92.5, 20300)],
    }, config);
    assert.match(reportText, /质量红线：全部通过/);
});

test('polygonWithHoles 与 netShapeArea 精确扣除内孔面积且 contour-holes-16 覆盖完整', () => {
    const holePoly = polygonWithHoles(
        [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 400 }, { x: 0, y: 400 }],
        [[{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]]
    );
    assert.equal(netShapeArea(holePoly), 400 * 400 - 200 * 200);
    const p = prepare('contour-holes-16');
    assert.equal(p.pieces, 16);
    assert.equal(p.expectedEngine, 'deepnest');
    assert.equal(p.demandRatio, 0.43);

    // 模拟内孔净面积校验拦截未扣孔虚高结果
    const badHoles = measure(p, 200, {
        status: 'FEASIBLE',
        engine: 'deepnest',
        elapsedMs: 300,
        placements: Array.from({ length: 16 }, (_, idx) => ({ id: idx + 1, x: 0, y: 0, shape: { width: 100, height: 100 } })),
        cuts: [],
        metrics: { processingAreaMm2: 5280000, pieceAreaMm2: 3000000 }
    }, 310);
    assert.equal(badHoles.ok, false);
    assert.match(badHoles.issues.join(), /内孔净面积校验异常/);
});

test('measure 准确度量 SLITTING_1D、NESTING_2D 异步作业与 multi-material 接力结果', () => {
    const slit = prepare('slitting-basic');
    const slitMeasured = measure(slit, 202, {
        job: { state: 'SUCCEEDED', startedAt: '2026-11-27T16:00:00.000Z', finishedAt: '2026-11-27T16:00:00.250Z' },
        result: {
            validationStatus: 'PASSED',
            metrics: [
                { name: 'motherAreaUtilization', value: 91.65 },
                { name: 'usableAreaUtilization', value: 92.81 }
            ],
            slitting: {
                status: 'FEASIBLE',
                engine: 'ortools-1d',
                patterns: [{}, {}, {}],
                fulfillment: [{ requested: 34, produced: 38 }],
                pieceAreaMm2: 110e6,
                motherAreaMm2: 120e6,
                usableAreaMm2: 118.5e6,
                totalOverproduced: 4,
                estimatedKnifeChanges: 6
            }
        }
    }, 300);
    assert.equal(slitMeasured.ok, true);
    assert.equal(slitMeasured.kind, 'SLITTING_1D');
    assert.equal(slitMeasured.placed, 38);
    assert.equal(slitMeasured.requested, 34);
    assert.equal(slitMeasured.overproduced, 4);
    assert.equal(slitMeasured.patternsCount, 3);
    assert.equal(slitMeasured.utilization, 91.65);
    assert.equal(slitMeasured.usableUtilization, 92.81);
    assert.equal(slitMeasured.elapsedMs, 250);

    const slitBad = measure(slit, 202, {
        job: { state: 'FAILED', message: '子进程超时' },
        result: null
    }, 5100);
    assert.equal(slitBad.ok, false);
    assert.match(slitBad.issues.join(), /FAILED/);

    const job2d = prepare('nesting-2d-job');
    const job2dMeasured = measure(job2d, 202, {
        job: { state: 'SUCCEEDED', startedAt: '2026-11-27T16:00:00.000Z', finishedAt: '2026-11-27T16:00:00.020Z' },
        result: {
            validationStatus: 'PASSED',
            layout: {
                status: 'FEASIBLE',
                engine: 'javaguillotine',
                elapsedMs: 5,
                placements: [{ id: 1, x: 0, y: 0, shape: { width: 1500, height: 3000 } }],
                cuts: [{ airDistanceMm: 500 }],
                metrics: { processingAreaMm2: 8e6, pieceAreaMm2: 4.5e6 }
            }
        }
    }, 40);
    assert.equal(job2dMeasured.ok, true);
    assert.equal(job2dMeasured.kind, 'NESTING_2D_JOB');
    assert.equal(job2dMeasured.utilization, 56.25);

    const relay = prepare('multi-material-relay');
    const relayMeasured = measure(relay, 200, {
        totalRequestedPieces: 29,
        placedByRemnants: 7,
        placedByRoll: 22,
        unplacedPieces: 0,
        remnantAllocations: [{ widthMm: 2000, lengthMm: 1600, piecesAreaM2: 2.5 }],
        rollOptions: [
            { rollId: 'R1', widthMm: 2000, estimatedCutLengthMm: 50000, utilizationPct: 80, recommended: true, relayOrder: 1 },
            { rollId: 'R2', widthMm: 1800, estimatedCutLengthMm: 10000, utilizationPct: 70, recommended: false, relayOrder: 2 }
        ],
        totalSavedAreaM2: 5.22,
        elapsedMs: 66
    }, 80);
    assert.equal(relayMeasured.ok, true);
    assert.equal(relayMeasured.placedByRemnants, 7);
    assert.equal(relayMeasured.relayRollCount, 2);
    assert.equal(relayMeasured.totalSavedAreaM2, 5.22);

    const relayBad = measure(relay, 200, {
        totalRequestedPieces: 29,
        placedByRemnants: 0,
        placedByRoll: 10,
        unplacedPieces: 10,
        remnantAllocations: [],
        rollOptions: []
    }, 50);
    assert.equal(relayBad.ok, false);
    assert.match(relayBad.issues.join(), /件数不守恒/);
});

test('evaluateThresholds 校验 1D 超产上限、多料料头/接力红线、漏题拦截与扩展表渲染', () => {
    const config = JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
    const summary = summarize([
        {
            problem: 'slitting-basic', kind: 'SLITTING_1D', side: 'A', label: 'gate', ok: true, issues: [],
            engine: 'ortools-1d', requested: 34, placed: 38, overproduced: 8, patternsCount: 3,
            utilization: 91.65, usableUtilization: 92.81, elapsedMs: 250, overrunMs: -4750
        },
        {
            problem: 'multi-material-relay', kind: 'multi-material', side: 'A', label: 'gate', ok: true, issues: [],
            engine: 'javaguillotine', requested: 29, placed: 29, placedByRemnants: 2, remnantCount: 1,
            relayRollCount: 1, totalSavedAreaM2: 2.1, utilization: 78.0, elapsedMs: 80, overrunMs: -11920
        }
    ]);
    const tableText = formatTable(summary);
    assert.match(tableText, /1D 分切扩展明细/);
    assert.match(tableText, /多料联排扩展明细/);

    const evalRes = evaluateThresholds(summary, config, {
        requiredProblems: ['slitting-basic', 'multi-material-relay', 'guillotine-java']
    });
    assert.equal(evalRes.passed, false);
    assert.deepEqual(evalRes.violations.map(v => `${v.problem}:${v.metric}`), [
        'guillotine-java:missingProblem',
        'slitting-basic:maxOverproduced',
        'multi-material-relay:minRemnantPlaced',
        'multi-material-relay:minRelayRolls'
    ]);
});

test('run.mjs 鉴权参数解析、Bearer 头构建与 gate.mjs 隔离护栏及指纹校验', () => {
    assert.deepEqual(buildAuthHeaders('Bearer abc.def'), { authorization: 'Bearer abc.def' });
    assert.deepEqual(buildAuthHeaders('xyz'), { authorization: 'Bearer xyz' });
    assert.deepEqual(buildAuthHeaders(null), {});

    const runOpts = parseRunArgs(['--set', 'v2-gate', '--auth', '--username', 'planner', '--password', 'secret', '--allow-fallback', 'http://127.0.0.1:18391']);
    assert.equal(runOpts.auth, true);
    assert.equal(runOpts.username, 'planner');
    assert.equal(runOpts.allowFallback, true);
    assert.equal(runOpts.set, 'v2-gate');

    assert.throws(() => assertSafePort(8080, false), /8080/);
    assert.equal(assertSafePort(8080, true), 8080);
    assert.throws(() => parseGateArgs(['--port', '8080']), /8080/);
    assert.throws(() => parseGateArgs(['--base', 'http://127.0.0.1:8080']), /8080/);

    const gateOpts = parseGateArgs(['--auth', '--port', '18399']);
    assert.equal(gateOpts.set, 'v2-gate');
    assert.equal(gateOpts.auth, true);
    assert.equal(gateOpts.port, 18399);

    const javaArgs = buildJavaArgs({
        jarPath: 'app.jar',
        port: 18399,
        statePath: '/tmp/cutdemo-state.json',
        auth: true,
        allowFallback: false
    });
    assert.ok(javaArgs.includes('--server.port=18399'));
    assert.ok(javaArgs.includes('--cutdemo.state.path=/tmp/cutdemo-state.json'));
    assert.ok(javaArgs.includes('--cutdemo.security.path=/tmp/cutdemo-state.json.security'));
    assert.ok(javaArgs.includes('--cutdemo.audit.path=/tmp/cutdemo-state.json.audit'));
    assert.ok(javaArgs.includes('--cutdemo.seed-demo-data=true'));
    assert.ok(javaArgs.includes('--cutdemo.auth.enabled=true'));
    assert.ok(javaArgs.includes('--packingsolver.fallback.enabled=false'));

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'bench-fp-test-'));
    try {
        mkdirSync(path.join(tmp, 'data', 'cutdemo-state.json.drafts'), { recursive: true });
        writeFileSync(path.join(tmp, 'data', 'cutdemo-state.json'), '{"rolls":[]}');
        const before = captureDataFingerprint(tmp);
        assert.equal(verifyDataFingerprint(before, captureDataFingerprint(tmp)).clean, true);
        writeFileSync(path.join(tmp, 'data', 'cutdemo-state.json'), '{"rolls":[1]}');
        const after = verifyDataFingerprint(before, captureDataFingerprint(tmp));
        assert.equal(after.clean, false);
        assert.match(after.mismatches[0], /stateSha256/);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});
