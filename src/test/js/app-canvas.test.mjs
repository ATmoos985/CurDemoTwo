import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildRollScene, buildInspectionScene, planSegment, plansOnRoll, rollsOfPlans, reportedPlans, segmentStatus, cutEnd, sceneMetrics, demandIndex, NEW_STATION, remnantAsRoll, canvasScene} from '../../../frontend/src/lib/model/roll-scene.js';
import {reviewablePieces, effectivePieceResults, emptyQualityForm, qualityProblems, buildQualityCommand, receiptSummary} from '../../../frontend/src/lib/model/quality.js';

const libRoot = fileURLToPath(new URL('../../../frontend/src/lib/', import.meta.url));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('inspection adapts saved and draft defects to global millimetres without changing the archive', () => {
    const roll = {rollId: 'I-1', width: 2000, totalLength: 80000, usedLength: 1000,
        defects: [{id: 7, x: 100.1, y: 5050.2, w: 30.3, h: 40.4, margin: 20, typeName: '破洞'}]};
    const pending = [{captureId: 'new-mark', x: 800, y: 5010, w: 50, h: 70, margin: 10}];
    const original = JSON.stringify({roll, pending});
    const scene = buildInspectionScene(roll, pending, 5075, 'new-mark');
    assert.deepEqual(scene.defects.map(d => [d.id, d.u, d.v, d.du, d.dv, d.editable]),
        [['saved-7', 5050.2, 100.1, 40.4, 30.3, false], ['new-mark', 5010, 800, 70, 50, true]]);
    assert.deepEqual(scene.feed, {u: 5075, fromRight: true});
    assert.equal(scene.selectedDefect, 'new-mark'); assert.deepEqual(scene.segments, []);
    scene.defects[0].u = 1;
    assert.equal(JSON.stringify({roll, pending}), original);
});

test('roll scene preserves the already rotated polygon instead of its bounding box', () => {
    const shape = {type: 'POLYGON', width: 600, height: 900, vertices: [
        {x: 0, y: 0}, {x: 600, y: 0}, {x: 600, y: 300}, {x: 200, y: 300}, {x: 200, y: 900}, {x: 0, y: 900}
    ]};
    const plan = {id: 'contour', status: 'PENDING', request: {windowStartY: 4000, rollL: 2000},
        result: {pieces: [{id: 7, x: 30, y: 40, w: 600, l: 900, rotated: true, rotationDegrees: 90, shape}]}};
    const before = JSON.stringify(plan);
    const seg = planSegment(plan);
    assert.deepEqual(seg.pieces[0].shape, shape);
    assert.deepEqual([seg.pieces[0].u, seg.pieces[0].v], [4040, 30]);
    assert.equal(JSON.stringify(plan), before);
});

test('all four process datums preserve request length, trim and world offset without transforming result geometry', () => {
    for (const cutOrigin of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
        const plan = {id: 'p', status: 'PENDING', request: {rollId: 'R', rollW: 2000, rollL: 5000, windowStartY: 15000, trimStart: 25.5, cutOrigin},
            result: {deductLen: 1200, pieces: [{id: 1, x: 200, y: 100, w: 300, l: 400}]}};
        const before = JSON.stringify(plan), scene = buildRollScene({roll: {width: 2000, totalLength: 30000}, rollId: 'R', plans: [plan],
            process: {cutOrigin: 'left-top', trimStart: 0, bedLength: 500}, selectedId: 'p'});
        assert.deepEqual(scene.origin, {u: cutOrigin.endsWith('bottom') ? 19974.5 : 15025.5, v: cutOrigin.startsWith('right') ? 2000 : 0,
            du: cutOrigin.endsWith('bottom') ? -1 : 1, dv: cutOrigin.startsWith('right') ? -1 : 1,
            label: `${cutOrigin.startsWith('right') ? '右' : '左'}${cutOrigin.endsWith('bottom') ? '下' : '上'}`});
        assert.deepEqual([scene.segments[0].pieces[0].u, scene.segments[0].pieces[0].v], [15100, 200]);
        assert.equal(JSON.stringify(plan), before);
    }
});

test('new stations and remnant material use their own process datum extent', () => {
    const process = {cutOrigin: 'right-bottom', trimStart: 20, bedLength: 5000};
    const fresh = buildRollScene({roll: {width: 2000, totalLength: 30000}, rollId: 'R', plans: [], process, window: {start: 12000, len: 3000}});
    assert.deepEqual(fresh.origin, {u: 14980, v: 2000, du: -1, dv: -1, label: '右下'});
    const remnant = buildRollScene({roll: remnantAsRoll({id: 'rem', width: 800, length: 600, status: 'AVAILABLE'}), plans: [], process});
    assert.deepEqual(remnant.origin, {u: 580, v: 800, du: -1, dv: -1, label: '右下'});
    assert.equal(buildInspectionScene({width: 2000, totalLength: 30000}, [], 1000).origin, undefined);
});

test('navigator length bounds follow material and trim instead of a hardcoded six-meter cap', () => {
    const roll = {width: 2800, totalLength: 100000, usedLength: 49496.9, currentRemainingLength: 50503.1};
    const scene = buildRollScene({roll, rollId: 'R', plans: [], process: {allowLongitudinal: true, allowRotation: false, trimStart: .3}, window: {start: 49496.9, len: 1698.3}});
    assert.deepEqual(scene.bed, {min: .4, max: 50503.1});
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
    assert.equal(segmentStatus({id: 'b', status: 'CONFIRMED'}), 'stale', '无报工的 CONFIRMED 是重置遗留，不是已切');
    assert.equal(segmentStatus({id: 'c', status: 'PENDING'}), 'pending');
    assert.deepEqual([...reportedPlans([{planId: 'a', status: 'CONFIRMED'}, {planId: 'b', status: 'REVERSED'}])], ['a']);
});

test('roll scene orders plans, skips cancelled/reversed/remnant plans, and locks cut length', () => {
    const plans = [plan('p2', 'PENDING', 9000, 3000), plan('p1', 'CONFIRMED', 4000, 5000), plan('x', 'CANCELLED', 0, 100), plan('v', 'REVERSED', 0, 100),
        plan('s', 'CONFIRMED', 20000, 4000), plan('r', 'CONFIRMED', 0, 1000, {feedPortType: 'remnant'}), plan('o', 'CONFIRMED', 0, 1000, {rollId: 'R2'})];
    assert.deepEqual(plansOnRoll(plans, 'R1').map(p => p.id), ['p1', 'p2', 's']);
    assert.deepEqual(rollsOfPlans(plans), ['R2', 'R1']);
    const roll = {width: 2800, totalLength: 60000, usedLength: 4000, defects: [{id: 1, x: 10, y: 5000, w: 20, h: 30, margin: 5, typeName: '破洞'}]};
    const sc = buildRollScene({roll, plans, reports: [{planId: 'p1', status: 'CONFIRMED'}], rollId: 'R1', demands: [], process: {bedLength: 5000}});
    assert.deepEqual(sc.segments.map(s => [s.id, s.status]), [['p1', 'cut'], ['p2', 'pending'], ['s', 'stale']]);
    assert.equal(sc.lock, 9000, '已失效段不计入锁定');
    assert.equal(sc.currentId, 'p2', '默认对准候选段');
    assert.deepEqual([sc.window.start, sc.window.len, sc.window.isNew, sc.window.adjusted], [9000, 3000, false, false]);
    assert.equal(sc.defects[0].u, 5000);
    assert.equal(cutEnd(sc.segments), 9000);
    const moved = buildRollScene({roll, plans, reports: [], rollId: 'R1', demands: [], selectedId: 'p2', window: {start: 9500, len: 3000}});
    assert.equal(moved.window.adjusted, true);
    const m = sceneMetrics(sc);
    assert.deepEqual([m.spreads, m.cut, m.pending, m.stale], [2, 1, 1, 1]);
    close(m.utilization, 60);
});

test('new station starts after the last live spread and never before the used length', () => {
    const roll = {width: 2800, totalLength: 20000, usedLength: 4000, defects: []};
    const plans = [plan('p1', 'PENDING', 4000, 5000), plan('s', 'CONFIRMED', 15000, 3000)];
    const sc = buildRollScene({roll, plans, rollId: 'R1', demands: [], process: {bedLength: 6000}, selectedId: NEW_STATION});
    assert.equal(sc.currentId, null);
    assert.deepEqual([sc.window.start, sc.window.len, sc.window.isNew], [9000, 6000, true], '已失效段不阻挡新工位');
    const tail = buildRollScene({roll: {...roll, usedLength: 18000}, plans: [], rollId: 'R1', demands: [], process: {bedLength: 6000}});
    assert.deepEqual([tail.window.start, tail.window.len], [18000, 2000], '新工位长度受卷尾限制');
});

const outputScene = (receipt, savedPlan = plan('output', 'CONFIRMED', 4000, 5000)) => buildRollScene({
    roll: {width: 2800, totalLength: 20000, usedLength: 6000}, rollId: 'R1', plans: [savedPlan], reports: [receipt], selectedId: 'output'
});
const outputReceipt = () => ({planId: 'output', status: 'CONFIRMED', windowStartY: 4000, actualCutLen: 2000,
    pieceArea: .4, usedArea: 5.6, recoveredGeometry: [], pieceResults: [
        {pieceId: 1, demandId: 7, name: '实际裁片', x: 30, y: 50, w: 600, l: 900, outcome: 'QUALIFIED', reason: '', rotationDegrees: 90,
            shape: {type: 'POLYGON', width: 600, height: 900, vertices: [{x: 0, y: 0}, {x: 600, y: 0}, {x: 0, y: 900}]}},
        {pieceId: 2, demandId: 7, x: 700, y: 50, w: 300, l: 500, outcome: 'REJECTED', reason: '破损'},
        {pieceId: 3, demandId: 7, x: 0, y: 2500, w: 1000, l: 1000, outcome: 'UNCUT', reason: ''}
    ]});

test('recorded canvas uses actual length, contour and outcomes; uncut pieces and planned remnants are not outputs', () => {
    const receipt = outputReceipt(), p = plan('output', 'CONFIRMED', 4000, 5000);
    p.result.remnants = [{id: 'planned', x: 0, y: 4000, w: 2800, l: 1000}];
    const original = JSON.stringify({receipt, p}), scene = outputScene(receipt, p), s = scene.segments[0];
    assert.deepEqual([s.start, s.len, scene.lock, scene.window.len], [4000, 2000, 6000, 2000]);
    assert.deepEqual(s.pieces.map(p => [p.id, p.u, p.v, p.outcome]), [[1, 4050, 30, 'QUALIFIED'], [2, 4050, 700, 'REJECTED']]);
    assert.deepEqual(s.pieces[0].shape, receipt.pieceResults[0].shape);
    assert.match(s.pieces[0].label, /合格/); assert.match(s.pieces[1].title, /破损/);
    assert.deepEqual(s.remnants, []); assert.deepEqual(s.cuts, [], 'planned toolpaths are not recorded execution');
    close(sceneMetrics(scene).utilization, .4 / 5.6 * 100);
    s.pieces[0].shape.vertices[0].x = 100;
    assert.equal(JSON.stringify({receipt, p}), original, 'projection must not rewrite production facts or candidate geometry');
});

test('quality projection preserves original results and places recovery relative to the produced contour', () => {
    const receipt = outputReceipt();
    receipt.netPieceArea = 0;
    receipt.recoveredGeometry = [{id: 'booked', x: 1100, y: 20, w: 200, l: 300, hasDefect: true}];
    receipt.qualityDispositions = [
        {remnantId: 'quality-remnant', command: {pieceId: 1, disposition: 'REMNANT', reason: '局部回收',
            recovery: {x: 20, y: 30, width: 200, length: 300, quality: 'QUARANTINED'}}},
        {command: {pieceId: 2, disposition: 'SCRAP', reason: '无法复用'}}
    ];
    const before = JSON.stringify(receipt), s = outputScene(receipt).segments[0];
    assert.deepEqual(s.pieces.map(p => [p.originalOutcome, p.outcome, p.disposition]), [['QUALIFIED', 'REJECTED', 'REMNANT'], ['REJECTED', 'REJECTED', 'SCRAP']]);
    assert.match(s.pieces[0].label, /复检转料头/); assert.match(s.pieces[1].label, /复检报废/);
    assert.deepEqual(s.remnants.map(r => [r.id, r.x, r.y, r.w, r.l]), [['booked', 1100, 20, 200, 300], ['quality-remnant', 50, 80, 200, 300]]);
    assert.match(s.remnants[1].label, /待检/); assert.equal(s.pieceArea, 0); assert.equal(s.len, 2000);
    assert.equal(JSON.stringify(receipt), before);
});

test('legacy reports identify planned geometry and reversed reports do not create actual output', () => {
    const legacy = outputScene({planId: 'output', status: 'CONFIRMED', actualCutLen: 1800}).segments[0];
    assert.match(legacy.outputNote, /缺少逐件/); assert.match(legacy.pieces[0].label, /计划/);
    assert.deepEqual(legacy.remnants, []); assert.equal(legacy.len, 1800);
    const reversed = outputScene({...outputReceipt(), status: 'REVERSED'}, plan('output', 'PENDING', 4000, 5000)).segments[0];
    assert.equal(reversed.status, 'pending'); assert.equal(reversed.len, 5000);
    assert.equal(reversed.pieces[0].outcome, undefined); assert.equal(reversed.pieces[0].u, 4200);
});

test('incomplete historical piece locations are disclosed instead of fabricated from the plan', () => {
    const receipt = outputReceipt(); receipt.pieceResults[0].x = undefined;
    const s = outputScene(receipt).segments[0];
    assert.deepEqual(s.pieces.map(p => p.id), [2]); assert.match(s.outputNote, /1.*缺少.*未绘制/);
});

test('demand names merge task and plan demands with task taking precedence', () => {
    const idx = demandIndex([{id: 1, name: '任务需求'}], [{request: {demands: [{id: 1, name: '旧名'}, {id: 2, name: '方案需求'}]}}]);
    assert.equal(idx.get(1).name, '任务需求');
    assert.equal(idx.get(2).name, '方案需求');
    assert.notEqual(idx.get(1).color, idx.get(2).color);
});

test('quality disposition form validates recovery rectangle and builds an immutable command', () => {
    const report = {planId: 'p', status: 'CONFIRMED', qualityRevision: 2, qualityDispositions: [{command: {pieceId: 3, disposition: 'SCRAP', reason: '污'}}],
        pieceResults: [{pieceId: 1, outcome: 'QUALIFIED', w: 900, l: 1400, name: 'A'}, {pieceId: 2, outcome: 'UNCUT', w: 1, l: 1}, {pieceId: 3, outcome: 'QUALIFIED', w: 5, l: 5}]};
    assert.deepEqual(reviewablePieces(report).map(p => p.pieceId), [1], '未切与已处置的件不可再复检');
    assert.deepEqual(receiptSummary(report, effectivePieceResults), {qualified: 1, rejected: 1, uncut: 1, dispositions: 1}, '复检后原良品按异常统计');
    let f = emptyQualityForm(report, 1);
    assert.deepEqual(qualityProblems(f, reviewablePieces(report)[0]), ['请填写检验人', '请填写复检原因']);
    f = {...f, inspector: '王', reason: '边缘破损', disposition: 'REMNANT', width: 950, length: 100, location: ''};
    assert.match(qualityProblems(f, reviewablePieces(report)[0]).join(), /超出裁片 900×1400.*库位/s);
    f = {...f, width: 900, location: '料头架 1'};
    assert.deepEqual(qualityProblems(f, reviewablePieces(report)[0]), []);
    const cmd = buildQualityCommand(f, 'op-1');
    assert.deepEqual(cmd, {operationId: 'op-1', expectedRevision: 2, pieceId: 1, disposition: 'REMNANT', inspector: '王', reason: '边缘破损',
        recovery: {x: 0, y: 0, width: 900, length: 100, location: '料头架 1', quality: 'QUARANTINED'}});
    assert.equal(buildQualityCommand({...f, disposition: 'SCRAP'}, 'op-2').recovery, null);
});

test('remnant feed: whole-piece window and remnant-only plan filtering', () => {
    const stock = {id: 'REM-1', status: 'AVAILABLE', materialBatch: 'M1', sourceRollId: 'R1', width: 2000, length: 1500, area: 3,
        defects: [{id: 1, x: 100, y: 200, w: 50, h: 60, margin: 10}]};
    const r = remnantAsRoll(stock);
    const plans = [plan('rp', 'PENDING', 0, 1500, {feedPortType: 'remnant', sourceRemnantId: 'REM-1'}), plan('p', 'PENDING', 0, 3000)];
    const sc = buildRollScene({roll: r, plans, rollId: 'REM-1', demands: [], process: {bedLength: 5000}});
    assert.deepEqual(sc.segments.map(s => s.id), ['rp'], '料头模式只显示该料头的方案');
    assert.deepEqual([sc.window.start, sc.window.len, sc.fixed, sc.bed], [0, 1500, true, null]);
    const moved = buildRollScene({roll: r, plans, rollId: 'REM-1', demands: [], window: {start: 200, len: 800}});
    assert.deepEqual([moved.window.start, moved.window.len], [0, 1500], '料头工位不可移动');
});

async function files(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []))).flat();
}
const refs = code => [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/g)].map(m => m[2]);

test('scene adapter and its transitive dependencies stay pure: no transport, storage or DOM access', async () => {
    const seen = new Set();
    async function visit(file) {
        if (seen.has(file)) return;
        seen.add(file);
        const code = await readFile(file, 'utf8');
        assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|localStorage|sessionStorage)\b|\b(document|window)\.|\/api\//, file);
        for (const ref of refs(code)) {
            assert.ok(ref.startsWith('.'), `uninspected dependency: ${file} -> ${ref}`);
            await visit(path.resolve(path.dirname(file), ref));
        }
    }
    await visit(path.join(libRoot, 'model', 'roll-scene.js'));
});

test('every model module resolves its relative imports', async () => {
    const all = await files(path.join(libRoot, 'model'));
    assert.ok(all.length > 0);
    for (const file of all) for (const ref of refs(await readFile(file, 'utf8')))
        if (ref.startsWith('.')) await assert.doesNotReject(access(path.resolve(path.dirname(file), ref)), `${path.relative(libRoot, file)} -> ${ref}`);
});

test('overlapping candidates display separately while every plan remains available to navigation', () => {
    const segments = [
        {id:'cut',status:'cut',start:0,len:1000},
        {id:'a',status:'pending',start:2000,len:1752},
        {id:'b',status:'pending',start:2000,len:1588.9},
        {id:'next',status:'pending',start:3752,len:1000}
    ];
    const scene = {segments,currentId:'a',window:{start:2000,len:1752}}, before=structuredClone(scene);
    assert.deepEqual(canvasScene(scene).segments.map(s=>s.id), ['cut','a','next']);
    assert.deepEqual(canvasScene({...scene,currentId:'b'}).segments.map(s=>s.id), ['cut','b','next']);
    assert.deepEqual(canvasScene({...scene,currentId:null}).segments.map(s=>s.id), ['cut','a','next']);
    assert.deepEqual(scene,before);
});
