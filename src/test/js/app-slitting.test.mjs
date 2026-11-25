import test from 'node:test';
import assert from 'node:assert/strict';
import {slittingProblems, pendingCounts, openDemands, slittingJob, patternStrips, compositionText, assignCar, usefulCars, carStart, patternRows}
    from '../../../frontend/src/lib/model/slitting.js';

const params = {leftTrim: 10, rightTrim: 10, minWidth: 1800, maxWidth: 1980, widthStep: 10, totalOverCap: 2};
const task = {id: 't1', revision: 3, name: '分切', materialModel: 'M1', problemType: 'SLITTING_1D', slitting: params,
    process: {trimStart: 50, cutOrigin: 'right-bottom'},
    demands: [{id: 1, name: 'A', width: 600, length: 2000, quantity: 4}, {id: 2, name: 'B', width: 700, length: 2000, quantity: 2}]};
const pattern = {id: 'p1', rollWidthMm: 2000, patternWidthMm: 1900, lengthMm: 2000, repetitions: 2,
    stations: [{widthMm: 600, countPerRepetition: 2}, {widthMm: 700, countPerRepetition: 1}],
    allocations: [{orderId: '1', quantity: 4}, {orderId: '2', quantity: 2}]};

test('slitting parameters mirror backend rules, including exact millimetre roll lengths', () => {
    assert.equal(slittingProblems(params, task.demands), null);
    assert.match(slittingProblems({...params, maxWidth: 1700}), /下限/);
    assert.match(slittingProblems({...params, widthStep: 0}), /步长/);
    assert.match(slittingProblems({...params, leftTrim: 1.5}), /整数/);
    assert.equal(slittingProblems(params, [{id: 1, name: 'A', width: 600, length: 2440}]), null);
    assert.match(slittingProblems(params, [{id: 1, name: 'A', width: 600, length: 2440.5}]), /整数/);
    assert.match(slittingProblems(params, [{id: 1, name: 'A', width: 2100, length: 2000}]), /组合上限/);
});

test('open demands subtract strips already in pending cars; job uses the selected roll width', () => {
    const plans = [{status: 'PENDING', result: {pieces: [{demandId: 1}, {demandId: 1}, {demandId: 2}]}}, {status: 'CONFIRMED', result: {pieces: [{demandId: 1}]}}];
    assert.deepEqual(pendingCounts(plans), {1: 2, 2: 1});
    const open = openDemands([{id: 1, width: 600, length: 2000, demand: 4}, {id: 2, width: 700, length: 2000, demand: 1}], plans);
    assert.deepEqual(open.map(d => [d.id, d.demand]), [[1, 2]]);
    const job = slittingJob(task, 2000.6, open);
    assert.equal(job.problemType, 'SLITTING_1D');
    assert.equal(job.problem.motherWidthMm, 2000);
    assert.deepEqual(job.problem.orders, [{id: '1', widthMm: 600, lengthMm: 2000, quantity: 2, surfaceTreatment: 'M1'}]);
    assert.equal(job.problem.leftTrimMm, 10);
});

test('a car assigns strips left to right from the left trim and skips strips without demand', () => {
    assert.deepEqual(patternStrips(pattern), [600, 600, 700]);
    assert.equal(compositionText(pattern), '600×2 + 700×1');
    const open = [{id: 1, width: 600, length: 2000, demand: 4}, {id: 2, width: 700, length: 2000, demand: 2}];
    assert.deepEqual(assignCar(pattern, open, 10), {strips: [{x: 10, width: 600, demandId: 1}, {x: 610, width: 600, demandId: 1}, {x: 1210, width: 700, demandId: 2}], skipped: 0});
    const short = assignCar(pattern, [{id: 1, width: 600, length: 2000, demand: 1}], 10);
    assert.equal(short.strips.length, 1);
    assert.equal(short.skipped, 2);
    assert.equal(usefulCars(pattern, open), 2);
    assert.equal(usefulCars(pattern, [{id: 2, width: 700, length: 2000, demand: 1}]), 1);
    assert.equal(usefulCars(pattern, [{id: 3, width: 500, length: 2000, demand: 5}]), 0);
});

test('released car demand is deducted once, while unreserved candidates remain occupied', () => {
    const plans = [
        {id: 'released', status: 'PENDING', result: {pieces: [{demandId: 1}, {demandId: 1}]}},
        {id: 'draft', status: 'PENDING', result: {pieces: [{demandId: 1}]} }
    ];
    const views = [{reservationActive: true, execution: {planId: 'released'}}];
    const afterReserved = [{id: 1, width: 600, length: 2000, demand: 2}, {id: 2, width: 700, length: 2000, demand: 2}];
    const fullRemaining = [{id: 1, width: 600, length: 2000, demand: 4}, {id: 2, width: 700, length: 2000, demand: 2}];
    assert.equal(openDemands(afterReserved, plans, views).find(d => d.id === 1).demand, 1);
    assert.equal(openDemands(fullRemaining, plans, [{...views[0], reservationActive: false}]).find(d => d.id === 1).demand, 1);
});

test('repeated cars advance beyond pending cars on this roll, then avoid defects and the roll end', () => {
    const roll = {rollId: 'R1', usedLength: 1000, totalLength: 8000, defects: [{x: 0, y: 3100, w: 600, h: 100, margin: 20}]};
    const plans = [
        {status: 'PENDING', request: {rollId: 'R1', windowStartY: 1000, rollL: 2050}},
        {status: 'CANCELLED', request: {rollId: 'R1', windowStartY: 5000, rollL: 2050}},
        {status: 'PENDING', request: {rollId: 'OTHER', windowStartY: 10000, rollL: 2050}}
    ];
    const strips = [{x: 10, width: 600}];
    assert.equal(carStart(roll, 1000, 2050, strips, plans), 3220);
    assert.equal(carStart({...roll, defects: []}, 0, 2050, strips, []), 1000);
    assert.equal(carStart({...roll, totalLength: 5000}, 1000, 2050, strips, plans), null);
});

test('car start steps past defects that touch the strips, and returns null at the roll end', () => {
    const strips = [{x: 10, width: 600}, {x: 610, width: 600}];
    const roll = {width: 2000, totalLength: 20000, defects: [{x: 300, y: 3000, w: 100, h: 100, margin: 20}, {x: 1500, y: 6000, w: 100, h: 100, margin: 20}]};
    assert.equal(carStart(roll, 1000, 2050, strips), 3120, '第一处疵点在条上，向后避让到疵点边距之后');
    assert.equal(carStart(roll, 5000, 2050, strips), 5000, '第二处疵点在余宽区，不影响本车');
    assert.equal(carStart(roll, 18000, 2050, strips), null);
});

test('patternRows summarizes slitting pattern widths, spare trim and order allocations', () => {
    const rows = patternRows({patterns: [pattern]}, new Map([[1, {name: 'A'}], [2, {name: 'B'}]]), 2000, params);
    assert.deepEqual(rows[0], {no: 1, id: 'p1', length: 2000, composition: '600×2 + 700×1', patternWidth: 1900, comboWidth: 2000, motherWidth: 2000, spare: 80, repetitions: 2, allocations: 'A: 4；B: 2'});
});
