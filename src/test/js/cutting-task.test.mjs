import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
let rows = [];
globalThis.document = { getElementById: () => null, querySelectorAll: () => rows };
const { state } = await import('../../main/resources/static/js/core/state.js');
const { updateDemandCompletionFromPieces, getDemandsFromUI } = await import('../../main/resources/static/js/plugins/solver/quota-manager.js');
const { nextCutPosition, updateFabricScrollPosition, advanceBed, smartAdvanceBed, radarTickStep } = await import('../../main/resources/static/js/plugins/radar/radar-scrubber.js');
const { requiredReportLength } = await import('../../main/resources/static/js/plugins/solver/solver-client.js');
const { bus } = await import('../../main/resources/static/js/core/event-bus.js');

test('preview and same-sized pieces never masquerade as reported demand completion', () => {
    state.taskCompleted = {7: 1};
    const data = {demands:[{id:7, count:3}, {id:9, count:2}], pieces:[{demandId:7}, {demandId:9, confirmed:true}]};
    updateDemandCompletionFromPieces(data);
    assert.deepEqual(data.demands.map(d => [d.id, d.completed, d.remaining]), [[7,1,2],[9,0,2]]);
    const before = state.getCurrentCaseData();
    state.setCutMode('remnant');
    assert.equal(state.getCurrentCaseData(), before, 'changing feed source keeps the same workspace and task');
    state.setCutMode('roll');
});

test('deleting another row preserves demand IDs, total and remaining counts', () => {
    rows = [{dataset:{id:'9', rotation:'true'}, getAttribute:()=>'1', querySelector:selector=>({value:({'.dem-name':'保留需求','.dem-w':'2000','.dem-l':'1000','.dem-count':'3'})[selector]})}];
    const demand = getDemandsFromUI()[0];
    assert.equal(demand.id, 9);
    assert.equal(demand.count, 3);
    assert.equal(demand.demand, 2);
    assert.equal(demand.allowRotation, true);
});

test('next station starts after reported stock, including recovered tail beyond finished pieces', () => {
    const data = {stockUsedLength:5000, pieces:[{y:5000,l:2000}], cuts:[], lastReceipt:{feedPortType:'roll',windowStartY:5000,actualCutLen:5000}};
    assert.equal(nextCutPosition(data), 10000);
    assert.equal(nextCutPosition({stockUsedLength:10000, pieces:[], cuts:[]}), 10000);
});

test('all station navigation preserves an unreported plan and requests report confirmation', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:0, totalRollL:100000, bedL:5000, pieces:[{y:0,l:4870}], cuts:[{type:'横切',pos:4870}]});
    const pending = {result:{planId:'unreported'}, windowStartY:0};
    state.pendingPlan = pending;
    let requested = 0;
    const unsubscribe = bus.on('report:requested', () => requested++);
    try {
        for (const move of [() => updateFabricScrollPosition(5000), () => advanceBed(1), () => smartAdvanceBed()]) {
            move();
            assert.equal(data.windowStartY, 0, 'navigation must not abandon the unreported station');
            assert.equal(state.pendingPlan, pending);
            assert.equal(data.cuts.length, 1);
        }
        assert.equal(requested, 3);
    } finally { unsubscribe(); state.pendingPlan = null; }
});

test('report length includes selected recovered tail and radar ticks remain readable', () => {
    assert.equal(requiredReportLength([{y:0,l:4870}], [{y:4870,l:330}]), 5200);
    assert.equal(requiredReportLength([{y:0,l:4870}], []), 4870);
    for (const [length, width] of [[2000,300],[60000,600],[100000,320],[100000,800]]) {
        const step = radarTickStep(length, width);
        assert.ok(step / length * width >= 70, 'major ticks must not overlap');
        assert.ok(Number.isFinite(step) && step > 0);
    }
});
