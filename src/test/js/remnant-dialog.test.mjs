import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedRemnants, motherRollRemnants, taskRemnants} from '../../main/resources/static/js/plugins/remnant/remnant-dialog-model.js';
import {readReportRemnants} from '../../main/resources/static/js/plugins/solver/report-editor.js';

test('expected additions exclude reported and staged historical geometry', () => {
    const current = {id:'current',w:600,l:1000};
    assert.deepEqual(expectedRemnants({remnants:[current,{id:'reported',confirmed:true},{id:'staged',queued:true}]}),[current]);
    assert.deepEqual(expectedRemnants({}),[]);
});

test('task output survives reopening, is scoped to this roll, and excludes reversals and duplicate queues', () => {
    const stock = {id:'STOCK',width:500,length:600,hasDefect:true};
    const reports = [{planId:'done',rollId:'A',derivedRemnants:[stock]},
        {planId:'reversed',rollId:'A',status:'REVERSED',derivedRemnants:[stock]},
        {planId:'other',rollId:'B',derivedRemnants:[stock]}];
    const queued = id => ({pending:{rollId:'A',feedPortType:'roll',request:{}},report:{planId:id,actualRemnants:[{id:'preview',w:500,l:600}]}});
    const rows = taskRemnants({remnants:[{id:'new',w:600,l:800},{id:'small',w:100,l:100},
        {id:'STOCK',confirmed:true}]}, reports, [queued('done'),queued('reversed'),queued('pending')], {rollId:'A'});
    assert.deepEqual(rows.map(r=>[r.id,r.phase]),[['new','expected'],['preview','queued'],['STOCK','reported']]);
    assert.equal(taskRemnants({},reports,[],{rollId:'A'})[0].w,500);
});

test('single-use remnant has no preview or queued recovery but keeps historical roll outputs', () => {
    assert.deepEqual(readReportRemnants({feedPortType:'remnant',reportRecovery:{old:{checked:true}}}),[]);
    const rows = taskRemnants({remnants:[{id:'waste',w:1000,l:1000}]},
        [{rollId:'A',derivedRemnants:[{id:'past',width:500,length:600}]}],
        [{pending:{rollId:'A',feedPortType:'remnant',request:{}},report:{planId:'old-client',actualRemnants:[{id:'waste',w:500,l:600}]}}],
        {rollId:'A',feedPortType:'remnant'});
    assert.deepEqual(rows.map(r=>r.id),['past']);
});

test('inventory belongs to the selected mother roll, including consumed history', () => {
    const own = {id:'own',sourceRollId:'ROLL-A'}, used = {id:'used',sourceRollId:'ROLL-A',status:'CONSUMED'};
    const rows = [own,used,{id:'other',sourceRollId:'ROLL-B'},{id:'unknown'}];
    assert.deepEqual(motherRollRemnants(rows,'ROLL-A'),[own,used]);
    assert.deepEqual(motherRollRemnants(rows,null),[]);
});
