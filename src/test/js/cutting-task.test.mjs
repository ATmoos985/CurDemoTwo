import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
let rows = [];
globalThis.document = { getElementById: () => null, querySelectorAll: () => rows };
const { state } = await import('../../main/resources/static/js/core/state.js');
const { updateDemandCompletionFromPieces, getDemandsFromUI } = await import('../../main/resources/static/js/plugins/solver/quota-manager.js');
const { nextCutPosition } = await import('../../main/resources/static/js/plugins/radar/radar-scrubber.js');

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
