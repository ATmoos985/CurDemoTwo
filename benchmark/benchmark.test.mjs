import test from 'node:test';
import assert from 'node:assert/strict';
import { SETS, problem, problemNames, expectedEngine, hash, prepare } from './problems.mjs';
import { parseBase, schedule, measure, summarize, formatTable, formatProblems, formatHeader, formatRun, formatReport } from './lib.mjs';

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
    assert.equal(expectedEngine(problem('contour14').body), 'packingsolver-irregular');
    assert.equal(expectedEngine({ ...scenario4, engine: 'javaguillotine' }), 'javaguillotine');
});

test('sets only name catalogue problems and all is demo plus large', () => {
    assert.deepEqual(SETS.all, [...SETS.demo, ...SETS.large]);
    for (const name of Object.values(SETS).flat()) assert.ok(problemNames().includes(name), name);
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
        services: [{ side: 'A', label: 'before', base: 'http://127.0.0.1:18310', health: { packingsolverAvailable: true, packingsolverFallback: null } }] });
    assert.match(text, /abc1234（有未提交改动）/);
    assert.match(text, /4 轮/);
    assert.match(text, /A before：http:\/\/127\.0\.0\.1:18310 · packingsolverAvailable=true · packingsolverFallback=null/);
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
