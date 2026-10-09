import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedRemnants, motherRollRemnants} from '../../main/resources/static/js/plugins/remnant/remnant-dialog-model.js';

test('expected additions exclude reported and staged historical geometry', () => {
    const current = {id:'current',w:600,l:1000};
    assert.deepEqual(expectedRemnants({remnants:[current,{id:'reported',confirmed:true},{id:'staged',queued:true}]}),[current]);
    assert.deepEqual(expectedRemnants({}),[]);
});

test('inventory belongs to the selected mother roll, including consumed history', () => {
    const own = {id:'own',sourceRollId:'ROLL-A'}, used = {id:'used',sourceRollId:'ROLL-A',status:'CONSUMED'};
    const rows = [own,used,{id:'other',sourceRollId:'ROLL-B'},{id:'unknown'}];
    assert.deepEqual(motherRollRemnants(rows,'ROLL-A'),[own,used]);
    assert.deepEqual(motherRollRemnants(rows,null),[]);
});
