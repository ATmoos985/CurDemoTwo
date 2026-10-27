import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toScreen, toWorld, fitCamera, zoomAt, panBy, ratioOf, scaleForRatio, parseRatio, formatRatio, rulerStep} from '../../main/resources/static/app/js/canvas/camera.js';
import {snapPosition, tickStep} from '../../main/resources/static/app/js/canvas/roll-navigator.js';
import {buildRollScene, planSegment, plansOnRoll, rollsOfPlans, reportedPlans, segmentStatus, cutEnd, sceneMetrics, demandIndex, NEW_STATION, remnantAsRoll} from '../../main/resources/static/app/js/model/roll-scene.js';
import {buildSolveRequest, remainingDemands, windowProblem, usablePlan} from '../../main/resources/static/app/js/model/solve-request.js';
import {defaultReport, applyBulk, recoveryCandidates, reportSummary, reportProblems, buildCutReport} from '../../main/resources/static/app/js/model/report.js';
import {reviewablePieces, effectivePieceResults, emptyQualityForm, qualityProblems, buildQualityCommand, receiptSummary} from '../../main/resources/static/app/js/model/quality.js';
import {camData, localHome, worldHome, initialPositions, movePiece, rotatePiece, changedPieces, adjustPayload, applyPositions, sizeOf} from '../../main/resources/static/app/js/model/plan-tools.js';
import {gcodeText} from '../../main/resources/static/js/plugins/export/cam-format.js';
import {emptyTask, fromTask, addDemand, mergeImport, taskProblems, lineLock, toPayload, demandTemplateCsv} from '../../main/resources/static/app/js/model/task-form.js';

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

test('solve request uses remaining quantities, task process and window-clipped defects', () => {
    const task = {id: 't', revision: 3, demands: [{id: 1, name: 'A', width: 900, length: 1400, quantity: 5}, {id: 2, name: 'B', width: 800, length: 1200, quantity: 2}],
        process: {trimStart: 10, pieceGap: 2, cutOrigin: 'right-bottom', allowLongitudinal: true}};
    assert.deepEqual(remainingDemands(task, {1: 2}, {'1': 1, 2: 2}).map(d => [d.id, d.demand]), [[1, 2]], '扣除已完成与已预约');
    const roll = {rollId: 'R1', rollModel: 'M', width: 2800, totalLength: 60000, usedLength: 3000, currentRemainingLength: 57000,
        defects: [{id: 9, x: 100, y: 7000, w: 200, h: 300, margin: 20}, {id: 10, x: 0, y: 30000, w: 10, h: 10, margin: 0}]};
    const req = buildSolveRequest({task, roll, win: {start: 5000, len: 4000}, completed: {}, reserved: {}, settings: {timeLimitSeconds: 5}});
    assert.equal(req.taskRevision, 3);
    assert.deepEqual([req.rollW, req.rollL, req.windowStartY, req.totalRollL, req.feedPortType], [2800, 4000, 5000, 60000, 'roll']);
    assert.deepEqual([req.trimStart, req.pieceGap, req.cutOrigin, req.timeLimitSeconds], [10, 2, 'right-bottom', 5]);
    assert.equal(req.defects.length, 1, '只带入与工位重叠的疵点');
    assert.deepEqual(req.defects[0], {id: 9, x: 80, y: 1980, w: 240, h: 340, margin: 0}, '疵点换算为工位坐标并外扩安全距离');
    assert.equal(windowProblem(roll, {start: 2000, len: 1000}) !== null, true, '不能早于已用长度');
    assert.equal(windowProblem(roll, {start: 58000, len: 3000}) !== null, true, '不能超出卷尾');
    assert.equal(windowProblem(roll, {start: 5000, len: 4000}), null);
    assert.equal(usablePlan({success: true, planId: 'p', pieces: [{}], cuts: [], remnants: []}), true);
    assert.equal(usablePlan({success: true, planId: 'p', pieces: [], cuts: [], remnants: []}), false);
});

test('demand names merge task and plan demands with task taking precedence', () => {
    const idx = demandIndex([{id: 1, name: '任务需求'}], [{request: {demands: [{id: 1, name: '旧名'}, {id: 2, name: '方案需求'}]}}]);
    assert.equal(idx.get(1).name, '任务需求');
    assert.equal(idx.get(2).name, '方案需求');
    assert.notEqual(idx.get(1).color, idx.get(2).color);
});

test('report draft follows backend rules: per-piece outcome, cut length and recoverable remnants', () => {
    // 工位起点 1000；件 1 在 0–1400，件 2 在 1500–3000（相对工位）
    const seg = {id: 'p', start: 1000, len: 3200, remnants: [{id: 'R1', x: 0, y: 3000, w: 2800, l: 200, hasDefect: true}],
        pieces: [{id: 1, demandId: 7, u: 1000, v: 0, du: 1400, dv: 900}, {id: 2, demandId: 8, u: 2500, v: 900, du: 1500, dv: 800}]};
    let r = defaultReport(seg);
    assert.equal(r.len, 3200);
    assert.deepEqual(reportProblems(seg, r), []);
    assert.deepEqual(reportSummary(seg, r), {qualified: 2, rejected: 0, uncut: 0, cutEnd: 3000});
    r = {...r, len: 2000};
    assert.match(reportProblems(seg, r).join(), /短于已切裁片末端/);
    r = applyBulk(r, 'beyond-uncut', seg);
    assert.equal(r.rows[2].outcome, 'UNCUT', '末端超出实切长度的件标为未切');
    assert.equal(r.rows[1].outcome, 'QUALIFIED');
    const cands = recoveryCandidates(seg, r);
    assert.deepEqual(cands.find(c => c.id === 'UNCUT-2'), {id: 'UNCUT-2', x: 900, y: 1500, w: 800, l: 500, hasDefect: false, source: '未切区域'}, '未切区域只取实切长度以内');
    r = {...r, rows: {...r.rows, 1: {outcome: 'REJECTED', reason: ''}}};
    assert.match(reportProblems(seg, r).join(), /须填写原因/);
    r = {...r, rows: {...r.rows, 1: {outcome: 'REJECTED', reason: '污渍'}}, rem: {...r.rem, R1: {use: true, w: 2900, l: 200}}};
    assert.match(reportProblems(seg, r).join(), /不能大于/);
    r = {...r, rem: {R1: {use: true, w: 2800, l: 150}, 'UNCUT-2': {use: true, w: 800, l: 500}}};
    assert.deepEqual(reportProblems(seg, r), []);
    const payload = buildCutReport(seg, r);
    assert.deepEqual([payload.planId, payload.actualCutLen, payload.finishedPieceCount], ['p', 2000, 0]);
    assert.deepEqual(payload.pieceResults, [{pieceId: 1, outcome: 'REJECTED', reason: '污渍'}, {pieceId: 2, outcome: 'UNCUT', reason: ''}]);
    assert.deepEqual(payload.actualRemnants.map(x => [x.id, x.w, x.l, x.hasDefect]), [['R1', 2800, 150, true], ['UNCUT-2', 800, 500, false]], '带疵料头保留带疵标记');
});

test('task form mirrors backend save rules and protects reported demand lines', () => {
    let f = emptyTask();
    assert.deepEqual(taskProblems(f).slice(0, 3), ['请填写任务名称', '请填写材料型号', '需求需为 1 至 200 项']);
    f = {...f, name: '窗帘', materialModel: 'M1'};
    f = addDemand(addDemand(f, {name: 'A', width: 900, length: 1400, quantity: 2}), {name: 'B', width: 0, length: 1200, quantity: 20000});
    assert.deepEqual(f.demands.map(d => d.id), [1, 2]);
    assert.deepEqual(taskProblems(f), ['第 2 行：宽度、长度须大于 0', '第 2 行：件数须为 1–10000 的整数']);
    const original = {id: 't', revision: 4, name: '窗帘', materialModel: 'M1', demands: [{id: 1, name: 'A', width: 900, length: 1400, quantity: 2}]};
    const edit = fromTask(original);
    assert.equal(edit.process.bedLength, 5000, '缺省工艺补默认值');
    const completed = {1: 2};
    assert.deepEqual(lineLock(edit.demands[0], completed), {locked: true, minQuantity: 2});
    assert.match(taskProblems({...edit, demands: []}, {original, completed}).join(), /不能删除/);
    assert.match(taskProblems({...edit, demands: [{...edit.demands[0], width: 901}]}, {original, completed}).join(), /不能改名或改尺寸/);
    assert.match(taskProblems({...edit, demands: [{...edit.demands[0], quantity: 1}]}, {original, completed}).join(), /不得小于已报工/);
    assert.match(taskProblems({...edit, materialModel: 'M2'}, {original, completed}).join(), /不能更改材料型号/);
    const merged = mergeImport(edit, {name: 'x', materialModel: 'M1', externalRef: 'f.xlsx', demands: [{name: 'C', width: 800, length: 1200, quantity: 3}]}, {replace: true, completed});
    assert.deepEqual(merged.demands.map(d => [d.id, d.name]), [[1, 'A'], [2, 'C']], '替换导入保留已报工项，新项续号');
    const payload = toPayload(merged);
    assert.deepEqual([payload.id, payload.revision, payload.demands.length], ['t', 4, 2]);
    assert.match(demandTemplateCsv(), /材料型号,裁片名称,宽度\(mm\),长度\(mm\),数量/);
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

test('remnant feed: whole-piece window, remnant plans only, solve and report follow remnant rules', () => {
    const stock = {id: 'REM-1', status: 'AVAILABLE', materialBatch: 'M1', sourceRollId: 'R1', width: 2000, length: 1500, area: 3,
        defects: [{id: 1, x: 100, y: 200, w: 50, h: 60, margin: 10}]};
    const r = remnantAsRoll(stock);
    const plans = [plan('rp', 'PENDING', 0, 1500, {feedPortType: 'remnant', sourceRemnantId: 'REM-1'}), plan('p', 'PENDING', 0, 3000)];
    const sc = buildRollScene({roll: r, plans, rollId: 'REM-1', demands: [], process: {bedLength: 5000}});
    assert.deepEqual(sc.segments.map(s => s.id), ['rp'], '料头模式只显示该料头的方案');
    assert.deepEqual([sc.window.start, sc.window.len, sc.fixed, sc.bed], [0, 1500, true, null]);
    const moved = buildRollScene({roll: r, plans, rollId: 'REM-1', demands: [], window: {start: 200, len: 800}});
    assert.deepEqual([moved.window.start, moved.window.len], [0, 1500], '料头工位不可移动');
    assert.equal(windowProblem(r, {start: 0, len: 1500}), null);
    assert.match(windowProblem({...r, remnant: {...stock, status: 'CONSUMED'}}, {start: 0, len: 1500}), /不可用/);
    const task = {id: 't', revision: 1, demands: [{id: 1, name: 'A', width: 900, length: 1400, quantity: 1}], process: {}};
    const req = buildSolveRequest({task, roll: r, win: {start: 0, len: 1500}, completed: {}, reserved: {}});
    assert.deepEqual([req.feedPortType, req.sourceRemnantId, req.rollId, req.rollModel, req.rollW, req.rollL, req.totalRollL, req.windowStartY],
        ['remnant', 'REM-1', 'R1', 'M1', 2000, 1500, 1500, 0]);
    assert.deepEqual(req.defects[0], {id: 1, x: 90, y: 190, w: 70, h: 80, margin: 0});
    const seg = {id: 'rp', start: 0, len: 1500, remnants: [{id: 'X', x: 0, y: 0, w: 10, l: 10}], pieces: [{id: 1, u: 0, v: 0, du: 1400, dv: 900}]};
    const rep = defaultReport(seg, {remnant: true});
    assert.deepEqual([rep.len, rep.rem], [0, {}]);
    assert.deepEqual(reportProblems(seg, rep), [], '料头报工不校验实切长度');
    assert.deepEqual(recoveryCandidates(seg, rep), []);
    const payload = buildCutReport(seg, rep);
    assert.deepEqual([payload.actualCutLen, payload.actualRemnants], [0, []]);
});

test('plan tools: local CAM origin, clamped piece moves, rotation and adjustment payload', () => {
    const p = {id: 'pl', version: 2, request: {rollId: 'R1', rollW: 2800, rollL: 4000, windowStartY: 9000, cutOrigin: 'right-bottom', feedPortType: 'roll', defects: []},
        result: {cuts: [{step: 1, type: '横切', startX: 2800, startY: 1400, endX: 0, endY: 1400}], remnants: [],
            pieces: [{id: 1, x: 0, y: 0, w: 900, l: 1400, rotated: false, name: 'A'}, {id: 2, x: 900, y: 0, w: 500, l: 700, rotated: true, name: 'B'}]}};
    assert.deepEqual(localHome(p), {x: 2800, y: 4000}, '原点为工位局部坐标，不叠加工位起点');
    const {data, home} = camData(p);
    assert.equal(data.windowStartY, 9000);
    assert.match(gcodeText(data, {home}), /G00 X2800\.000 Y4000\.000 Z50\.000/);
    assert.deepEqual(worldHome(p, 9000), {u: 13000, v: 2800});
    let pos = initialPositions(p);
    pos = movePiece(pos, p, 1, 100.04, 50, pos);
    assert.deepEqual(pos[1], {x: 50, y: 100, rotated: false});
    pos = movePiece(pos, p, 1, 99999, -99999, pos);
    assert.deepEqual([pos[1].x, pos[1].y], [0, 2600], '限制在工位内');
    pos = rotatePiece(pos, p, 2);
    assert.deepEqual(sizeOf(p.result.pieces[1], pos[2].rotated), {w: 700, l: 500}, '旋转后宽长互换');
    assert.equal(changedPieces(pos, p), 2);
    assert.deepEqual(adjustPayload(pos, 'op-1234567890abcdef').pieces[1], {id: 2, x: 900, y: 0, rotated: false});
    const seg = applyPositions({id: 'pl', start: 9000, cuts: [1], pieces: [{id: 1, u: 9000, v: 0, du: 1400, dv: 900}, {id: 2, u: 9000, v: 900, du: 700, dv: 500}]}, p, pos);
    assert.deepEqual([seg.pieces[0].u, seg.pieces[0].v, seg.pieces[1].du, seg.pieces[1].dv, seg.cuts.length], [11600, 0, 500, 700, 0], '调整中刀序失效、件按新位置显示');
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
