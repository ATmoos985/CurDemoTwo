import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestFeedWindow, autoFeedRequests, buildSolveRequest} from '../../main/resources/static/app/js/model/solve-request.js';
import {buildRollScene} from '../../main/resources/static/app/js/model/roll-scene.js';

const task = {process: {allowLongitudinal: true, allowRotation: false, trimStart: .3}, demands: [
    {id: 1, width: 2220, length: 1620, quantity: 1},
    {id: 2, width: 2640, length: 4470, quantity: 2},
    {id: 3, width: 2220, length: 7000, quantity: 1}
]};
const roll = {width: 2800, totalLength: 100000, usedLength: 49496.9, currentRemainingLength: 50503.1};
const input = {task, roll, win: {start: 49496.9, len: 1698.3}, completed: {1: 1}, reserved: {3: 1}};

test('short station recommends longest unfinished and unreserved piece with fractional trim', () => {
    assert.deepEqual(suggestFeedWindow(input), {length: 4470.3, problem: null});
    assert.equal(suggestFeedWindow({...input, reserved: {}}).length, 7000.3);
});
test('feed suggestion shares rotation, width and full-width crosscut rules', () => {
    assert.equal(suggestFeedWindow({...input, roll: {...roll, width: 5000}, task: {...task, process: {...task.process, allowRotation: true}}}).length, 2640.3);
    assert.match(suggestFeedWindow({...input, task: {...task, process: {allowLongitudinal: false}}}).problem, /幅宽|工艺/);
});
test('auto feed rejects roll tail and ledger shortages without silently shortening demand', () => {
    assert.match(suggestFeedWindow({...input, win: {start: 98000, len: 1000}}).problem, /卷尾/);
    assert.match(suggestFeedWindow({...input, roll: {...roll, currentRemainingLength: 2000}}).problem, /剩余/);
});
test('fixed remnants and fulfilled demand do not allow auto feed', () => {
    assert.match(suggestFeedWindow({...input, roll: {...roll, remnant: {}}}).problem, /整块/);
    const result = suggestFeedWindow({...input, completed: {1: 1, 2: 2, 3: 1}});
    assert.equal(result.length, null); assert.match(result.problem, /没有待排/);
});
test('navigator length bounds follow material and trim instead of a hardcoded six-meter cap', () => {
    const scene = buildRollScene({roll, rollId: 'R', plans: [], process: task.process, window: input.win});
    assert.deepEqual(scene.bed, {min: .4, max: 50503.1});
});

test('main solve expands a short window before the first request and never shrinks a longer window', () => {
    const req = buildSolveRequest(input);
    assert.equal(autoFeedRequests(req, roll)[0].rollL, 4470.3);
    assert.equal(autoFeedRequests({...req, rollL: 6000}, roll)[0].rollL, 6000);
});
test('defect recovery expands from the same origin, includes newly reached defects and respects tail and stock', () => {
    const r = {...roll, currentRemainingLength: 8000, defects: [{id: 1, x: 0, y: 51000, w: 2800, h: 1000, margin: 20},
        {id: 2, x: 100, y: 55000, w: 10, h: 100, margin: 20}]};
    const req = buildSolveRequest({...input, roll: r}), attempts = autoFeedRequests(req, r);
    assert.deepEqual(attempts.map(a => a.rollL), [4470.3, 6993.4]);
    assert.ok(attempts.every(a => a.windowStartY === req.windowStartY && a.rollL <= 8000));
    assert.equal(attempts[0].defects.length, 1); assert.equal(attempts[1].defects.length, 2);
});
test('fixed remnants, incompatible widths and a short roll tail do not create invalid automatic requests', () => {
    const req = buildSolveRequest(input);
    const fixed = {...req, feedPortType: 'remnant'};
    assert.deepEqual(autoFeedRequests(fixed, roll), [fixed]);
    assert.equal(autoFeedRequests({...req, totalRollL: req.windowStartY + 2000}, roll)[0].rollL, req.rollL);
    assert.equal(autoFeedRequests({...req, demands: [{width: 5000, length: 4000, demand: 1}]}, roll).length, 1);
});
