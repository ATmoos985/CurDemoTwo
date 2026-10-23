import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDraft,observationFor,commandFor,differences,readDraft,fingerprint,validateSnapshot} from '../../main/resources/static/js/business/inventory/count-model.js';
const material=(change={})=>({type:'roll',id:'R1',width:1500,length:2000,status:'INSPECTED',location:'A',materialModel:'M',allowed:true,reason:'',...change});
const draft=(items=[material()])=>({...emptyDraft(),editing:true,snapshot:{revision:12,materials:items},observations:items.map(observationFor),operator:'张三',reason:'月末实盘'});
test('roll observations measure uncut length and preserve exact snapshot revision',()=>{
    const d=draft();d.observations[0].length='1800';const command=commandFor(d);
    assert.equal(command.expectedRevision,12);assert.deepEqual(command.materials,[{type:'roll',id:'R1',present:true,width:1500,length:1800}]);
    assert.ok(Math.abs(differences(d.snapshot,command)[0].differenceAreaM2+.3)<1e-12);
    d.observations[0].width='1499';assert.throws(()=>commandFor(d),/保留账面幅宽/);
});
test('missing remnant preserves width and records zero; recovered LOST enters quarantine',()=>{
    const d=draft([material({type:'remnant',status:'AVAILABLE'})]);d.observations[0].present=false;d.observations[0].length='0';
    let rows=differences(d.snapshot,commandFor(d));assert.equal(rows[0].afterStatus,'LOST');assert.equal(rows[0].differenceAreaM2,-3);
    d.observations[0].width='1499';assert.throws(()=>commandFor(d),/保留账面幅宽/);
    const found=draft([material({type:'remnant',status:'LOST'})]);found.observations[0]={...found.observations[0],present:true,width:'1000',length:'1200'};
    rows=differences(found.snapshot,commandFor(found));assert.equal(rows[0].afterStatus,'QUARANTINED');assert.equal(rows[0].differenceAreaM2,1.2);
});
test('blank, nonfinite, out of bounds, and invalid presence measurements never build commands',()=>{
    for(const value of ['', ' ', 'NaN', 'Infinity', '-1', '0', '1000000001']){const d=draft();d.observations[0].length=value;assert.throws(()=>commandFor(d),undefined,value);}
    const missing=draft();missing.observations[0].present=false;assert.throws(()=>commandFor(missing));
    const d=draft();d.observations[0].length='1000000000';assert.equal(commandFor(d).materials[0].length,1e9);
});
test('blocked, missing and duplicate materials cannot pass review',()=>{
    const blocked=draft([material({allowed:false,reason:'已被执行单预约'})]);assert.throws(()=>commandFor(blocked),/预约/);
    const missing=draft();missing.snapshot.materials=[];assert.throws(()=>commandFor(missing),/不存在/);
    const repeated=draft();repeated.observations.push({...repeated.observations[0]});assert.throws(()=>commandFor(repeated),/重复/);
});
test('requiresRefresh blocks resubmission, explicit snapshot replacement retains measurement',()=>{
    const d=draft();d.observations[0].length='1700';d.requiresRefresh=true;assert.throws(()=>commandFor(d),/更新账面/);
    d.snapshot={revision:13,materials:[material({length:1800})]};d.requiresRefresh=false;
    assert.equal(commandFor(d).materials[0].length,1700);assert.equal(commandFor(d).expectedRevision,13);
    assert.ok(Math.abs(differences(d.snapshot,commandFor(d))[0].differenceAreaM2+.15)<1e-12);
});
test('zero difference is a valid physical observation',()=>{
    const d=draft();assert.equal(differences(d.snapshot,commandFor(d))[0].differenceAreaM2,0);
});
test('pending key and body survive reload; changed pending payload or snapshot is rejected',()=>{
    const d=draft();d.pending={key:'count-original-001',body:commandFor(d)};
    const recovered=readDraft(JSON.stringify(d));assert.deepEqual(recovered.pending,d.pending);assert.equal(recovered.snapshot.revision,12);
    d.pending.body.expectedRevision=13;assert.throws(()=>readDraft(JSON.stringify(d)),/不一致/);
    assert.throws(()=>readDraft('{broken'));assert.throws(()=>readDraft(JSON.stringify({...draft(),pending:{key:'short',body:{}}})));
});
test('corrupt snapshots and credentials fail closed',()=>{
    assert.throws(()=>validateSnapshot({revision:1.5,materials:[]}));
    assert.throws(()=>validateSnapshot({revision:1,materials:[material(),material()]}));
    assert.throws(()=>readDraft(JSON.stringify({...draft(),snapshot:null})));
    assert.throws(()=>readDraft(JSON.stringify({...draft(),receipt:{id:'bad'}})));
    assert.deepEqual(readDraft(null),emptyDraft());
});
test('review fingerprints ignore object key order but detect changes in facts',()=>{
    const command=commandFor(draft());assert.equal(fingerprint(command),fingerprint({materials:command.materials,operator:command.operator,reason:command.reason,expectedRevision:command.expectedRevision}));
    assert.notEqual(fingerprint(command),fingerprint({...command,reason:'更正'}));
});
test('observations limited to 1–100 with required bounded reason and declared operator',()=>{
    const d=draft();d.reason=' ';assert.throws(()=>commandFor(d));d.reason='x'.repeat(501);assert.throws(()=>commandFor(d));d.reason='盘点';d.operator='x'.repeat(101);assert.throws(()=>commandFor(d));
    const none=draft([]);assert.throws(()=>commandFor(none));
    const many=draft(Array.from({length:101},(_,i)=>material({id:`R${i}`})));assert.throws(()=>commandFor(many));
});
