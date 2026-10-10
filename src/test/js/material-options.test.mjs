import test from 'node:test';
import assert from 'node:assert/strict';
import { syncMaterialOptions } from '../../main/resources/static/js/plugins/material/material-options.js';

globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; } };
const select = () => ({options:[], value:'', disabled:false, replaceChildren(...items) {this.options = items; this.value = items[0]?.value || '';}});
const rolls = [{rollId:'actual-stock', rollModel:'real-model', width:2000}];
function controls(staleId = '') {
    const selector = select(), materials = select();
    selector.value = staleId;
    globalThis.document = {getElementById:id => ({'sel-mother-roll-id':selector,'task-material':materials})[id]};
    return {selector, materials};
}

test('empty inventory removes stale sample identifiers and cannot appear loaded', () => {
    const {selector} = controls('ROLL-REAL-893153');
    syncMaterialOptions([]);
    assert.equal(selector.value, '');
    assert.equal(selector.disabled, true);
    assert.deepEqual(selector.options.map(option => option.value), ['']);
});

test('a missing preset material does not add fake stock or select a different roll', () => {
    const {selector, materials} = controls();
    syncMaterialOptions(rolls, {rollId:'missing-demo-roll', model:'demo-model', fallback:false});
    assert.equal(selector.value, '');
    assert.deepEqual(selector.options.map(option => option.value), ['', 'actual-stock']);
    assert.equal(materials.value, 'demo-model', 'sample demand model remains available without pretending stock exists');
});

test('a newly registered real roll becomes selectable after an empty inventory', () => {
    const {selector, materials} = controls();
    syncMaterialOptions([]);
    syncMaterialOptions(rolls, {model:''});
    assert.equal(selector.disabled, false);
    assert.equal(selector.value, 'actual-stock');
    assert.equal(materials.value, 'real-model');
});

test('refreshing stock retains the task model and an existing selected roll', () => {
    const {selector, materials} = controls('actual-stock');
    materials.value = 'saved-task-model';
    syncMaterialOptions(rolls);
    assert.equal(selector.value, 'actual-stock');
    assert.equal(materials.value, 'saved-task-model');
});

test('a new task leaves material unselected until an import or explicit choice', () => {
    const {selector, materials} = controls('actual-stock');
    syncMaterialOptions(rolls, {model:'', rollId:'', fallback:false});
    assert.equal(selector.value, '');
    assert.equal(materials.value, '');
    assert.deepEqual(materials.options.map(option => option.value), ['', 'real-model']);
});
