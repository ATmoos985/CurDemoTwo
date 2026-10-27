import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toScreen, toWorld, fitCamera, zoomAt, panBy, ratioOf, scaleForRatio, parseRatio, formatRatio, rulerStep} from '../../main/resources/static/app/js/canvas/camera.js';
import {snapPosition, tickStep} from '../../main/resources/static/app/js/canvas/roll-navigator.js';
import {buildRollScene, planSegment, plansOnRoll, rollsOfPlans, reportedPlans, segmentStatus, cutEnd, sceneMetrics, demandIndex} from '../../main/resources/static/app/js/model/roll-scene.js';

const appRoot = fileURLToPath(new URL('../../main/resources/static/app/', import.meta.url));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('camera maps world to screen and back in both orientations', () => {
    const cam = {s: 0.5, a: 10, c: 20};
    for (const vertical of [false, true]) {
        const [x, y] = toScreen(cam, vertical, 1000, 400);
        const [u, v] = toWorld(cam, vertical, x, y);
        close(u, 1000); close(v, 400);
    }
    assert.deepEqual(toScreen(cam, false, 100, 40), [60, 40]);
    assert.deepEqual(toScreen(cam, true, 100, 40), [40, 60], '竖向时卷长沿 y 方向');
});

test('fitCamera centres the requested range and respects padding', () => {
    const cam = fitCamera({u0: 0, u1: 6000, v0: 0, v1: 2800}, {width: 1000, height: 600}, false, {start: 50, end: 50, near: 20, far: 20});
    close(cam.s, Math.min(900 / 6000, 560 / 2800));
    const [x0] = toScreen(cam, false, 0, 0), [x1] = toScreen(cam, false, 6000, 0);
    close((x0 + x1) / 2, 50 + 900 / 2);
});

test('zoomAt keeps the point under the cursor fixed and clamps the scale', () => {
    const cam = {s: 0.2, a: 30, c: 40};
    for (const vertical of [false, true]) {
        const before = toWorld(cam, vertical, 300, 200);
        const z = zoomAt(cam, vertical, 300, 200, 2.5);
        const after = toWorld(z, vertical, 300, 200);
        close(before[0], after[0]); close(before[1], after[1]);
    }
    assert.equal(zoomAt(cam, false, 0, 0, 1000, 0, 8).s, 8);
    const p = panBy(cam, true, 5, 7);
    assert.deepEqual([p.a, p.c], [37, 45], '竖向平移：dy 沿卷长');
});

test('ratio conversion round-trips and parses user input', () => {
    close(ratioOf(scaleForRatio(20)), 20);
    close(ratioOf(scaleForRatio(50, 0.2), 0.2), 50);
    assert.equal(parseRatio('1:20'), 20);
    assert.equal(parseRatio('1：12.5'), 12.5);
    assert.equal(parseRatio('100'), 100);
    assert.equal(parseRatio('abc'), null);
    assert.equal(parseRatio('1:0'), null);
    assert.equal(formatRatio(19.6), '1:20');
    assert.equal(formatRatio(2.345), '1:2.3');
    assert.throws(() => scaleForRatio(0));
});

test('ruler and navigator ticks pick 1/2/5 steps with minimum spacing', () => {
    for (const s of [0.001, 0.05, 0.3, 2, 7]) {
        const step = rulerStep(s, 70);
        assert.ok(step * s >= 70, `step ${step} at ${s}`);
        assert.ok([1, 2, 5].includes(Number((step / 10 ** Math.floor(Math.log10(step))).toFixed(6))));
    }
    assert.equal(tickStep(100000, 1000), 10000);
});

test('navigator snaps to segment starts within the threshold, otherwise to 100 mm', () => {
    assert.equal(snapPosition(4980, [0, 5000, 9000], 50), 5000);
    assert.equal(snapPosition(4930, [0, 5000, 9000], 50), 4900);
    assert.equal(snapPosition(7049, [], 50), 7000);
});

const plan = (id, status, start, len, extra = {}) => ({
    id, status, version: 1,
    request: {rollId: 'R1', windowStartY: start, rollL: 5000, rollW: 2800, demands: [{id: 7, name: '订单 7'}], ...extra},
    result: {deductLen: len, pieceArea: 6, totalArea: 10, fulfillment: [{demandId: 7, unplaced: 1}],
        pieces: [{id: 1, demandId: 7, x: 100, y: 200, w: 900, l: 1400, name: '订单 7'}],
        cuts: [{type: '横切', startX: 2800, startY: 1600, endX: 0, endY: 1600}]}
});

test('plan segments use window-relative coordinates and report-based cut status', () => {
    const seg = planSegment(plan('a', 'CONFIRMED', 3000, 4200), new Map([[7, '#123456']]), 0, new Set(['a']));
    assert.equal(seg.status, 'cut');
    assert.deepEqual([seg.start, seg.len], [3000, 4200]);
    assert.deepEqual(seg.pieces[0], {...seg.pieces[0], u: 3200, v: 100, du: 1400, dv: 900, color: '#123456'});
    assert.deepEqual(seg.cuts[0], {u1: 4600, v1: 2800, u2: 4600, v2: 0, type: '横切', step: undefined});
    assert.equal(segmentStatus({id: 'b', status: 'CONFIRMED'}), 'confirmed', '确认未报工不是已切');
    assert.equal(segmentStatus({id: 'c', status: 'PENDING'}), 'pending');
    assert.deepEqual([...reportedPlans([{planId: 'a', status: 'CONFIRMED'}, {planId: 'b', status: 'REVERSED'}])], ['a']);
});

test('roll scene orders plans, skips cancelled and remnant-fed plans, and locks cut length', () => {
    const plans = [plan('p2', 'PENDING', 9000, 3000), plan('p1', 'CONFIRMED', 4000, 5000), plan('x', 'CANCELLED', 0, 100),
        plan('r', 'CONFIRMED', 0, 1000, {feedPortType: 'remnant'}), plan('o', 'CONFIRMED', 0, 1000, {rollId: 'R2'})];
    assert.deepEqual(plansOnRoll(plans, 'R1').map(p => p.id), ['p1', 'p2']);
    assert.deepEqual(rollsOfPlans(plans), ['R2', 'R1']);
    const roll = {width: 2800, totalLength: 60000, usedLength: 4000, defects: [{id: 1, x: 10, y: 5000, w: 20, h: 30, margin: 5, typeName: '破洞'}]};
    const sc = buildRollScene({roll, plans, reports: [{planId: 'p1', status: 'CONFIRMED'}], rollId: 'R1', demands: [], process: {bedLength: 5000}});
    assert.deepEqual(sc.segments.map(s => [s.id, s.status]), [['p1', 'cut'], ['p2', 'pending']]);
    assert.equal(sc.lock, 9000);
    assert.equal(sc.currentId, 'p2', '默认对准第一个未切段');
    assert.deepEqual(sc.window, {start: 9000, len: 3000});
    assert.equal(sc.defects[0].u, 5000);
    assert.equal(cutEnd(sc.segments), 9000);
    const moved = buildRollScene({roll, plans, reports: [], rollId: 'R1', demands: [], selectedId: 'p2', window: {start: 9500, len: 3000}});
    assert.equal(moved.window.adjusted, true);
    const m = sceneMetrics(sc);
    assert.deepEqual([m.spreads, m.cut, m.pending], [2, 1, 1]);
    close(m.utilization, 60);
});

test('demand names merge task and plan demands with task taking precedence', () => {
    const idx = demandIndex([{id: 1, name: '任务需求'}], [{request: {demands: [{id: 1, name: '旧名'}, {id: 2, name: '方案需求'}]}}]);
    assert.equal(idx.get(1).name, '任务需求');
    assert.equal(idx.get(2).name, '方案需求');
    assert.notEqual(idx.get(1).color, idx.get(2).color);
});

async function files(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []))).flat();
}
const refs = code => [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)].map(m => m[2]);

test('new app canvas imports only its own canvas modules and never loads business data', async () => {
    const dir = path.join(appRoot, 'js', 'canvas'), all = await files(dir);
    assert.ok(all.length >= 3);
    for (const file of all) {
        const code = await readFile(file, 'utf8');
        for (const ref of refs(code)) {
            const rel = path.relative(dir, path.resolve(path.dirname(file), ref));
            assert.ok(ref.startsWith('.') && !rel.startsWith('..'), `${file} -> ${ref}`);
        }
        assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\/api\//, file);
    }
});

test('scene adapter stays pure: no transport, storage or DOM access', async () => {
    const code = await readFile(path.join(appRoot, 'js', 'model', 'roll-scene.js'), 'utf8');
    assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\b(document|window)\.|\/api\//);
    assert.equal(refs(code).length, 0);
});

test('every new app module resolves its relative imports', async () => {
    const all = await files(path.join(appRoot, 'js'));
    for (const file of all) for (const ref of refs(await readFile(file, 'utf8')))
        if (ref.startsWith('.')) await assert.doesNotReject(access(path.resolve(path.dirname(file), ref)), `${path.relative(appRoot, file)} -> ${ref}`);
    const html = await readFile(path.join(appRoot, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)) await assert.doesNotReject(access(path.join(appRoot, m[1])), m[1]);
});
