import test from 'node:test';
import assert from 'node:assert/strict';
import {demandSample} from '../../main/resources/static/js/plugins/solver/demand-sample.js';
import {importedTask} from '../../main/resources/static/js/plugins/solver/demand-import-model.js';
import {scenarioExample} from '../../main/resources/static/js/nesting/scenario-examples.js';
import {createNestingScene} from '../../main/resources/static/js/nesting/nesting-scene.js';

test('9.28 sample preserves valid RH quantities without invented auxiliary demand or order identities', () => {
    const rows = demandSample.groups.flatMap(group => group.demands);
    assert.equal(demandSample.groups.length,26);assert.equal(rows.length,100);
    assert.equal(rows.reduce((sum,row) => sum + row.quantity,0),156);
    assert.deepEqual(demandSample.excludedRows,[78,79,108,109]);
    assert.ok(rows.every(row => !row.order && !row.allowRotation && /^9\.28 第 \d+ 行$/.test(row.name)));
    const cream = importedTask(demandSample,demandSample.groups.findIndex(g=>g.materialModel==='2#A3A-Cream'),'9.28 样例');
    assert.equal(cream.demands.length,11);assert.equal(cream.demands.reduce((n,d)=>n+d.quantity,0),23);
    assert.deepEqual([cream.demands[0].width,cream.demands[0].length,cream.demands[0].quantity],[2170,3250,2]);
});
test('lab scenarios are standalone preview inputs, with clipped defect avoidance and no business inventory IDs', () => {
    for (const id of [3,4,6]) {
        const input = scenarioExample(id), scene = createNestingScene(input);
        assert.equal(input.material.id,`DEMO-${id}`);assert.ok(scene.parts.length > 0);
        assert.equal(input.process.feedMode,id===3?'SHEET':'CONTINUOUS');
        for (const d of input.material.exclusions) {
            assert.ok(d.x >= 0 && d.y >= 0 && d.x+d.shape.width <= input.material.shape.width && d.y+d.shape.height <= input.material.shape.height);
        }
        assert.equal(input.taskId,undefined);assert.equal(input.rollId,undefined);
    }
});
