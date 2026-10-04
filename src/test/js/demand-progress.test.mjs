import test from 'node:test';
import assert from 'node:assert/strict';
import {demandProgress} from '../../main/resources/static/js/plugins/solver/demand-progress-model.js';
const pieces=[{id:1,demandId:7,planId:'P'},{id:2,demandId:7,planId:'P'},
    {id:3,demandId:8,planId:'old',confirmed:true},{id:4,demandId:7,planId:'old'}];
const pending={result:{planId:'P',pieces:pieces.slice(0,2),fulfillment:[{demandId:7,requested:3,placed:2,unplaced:1,reason:'NOT_PLACED_IN_THIS_SOLUTION'}]}};
test('preview, qualified completion and remaining are separate and match by demand ID',()=>{
    const result=demandProgress([{id:7,quantity:4},{id:8,quantity:4}],{7:1,8:2},{pending,pieces});
    assert.deepEqual(result.map(r=>[r.planned,r.completed,r.remaining,r.unplaced]),[[2,1,3,1],[0,2,2,2]]);
    assert.match(result[0].reason,/不能据此判定无法裁切/);
});
test('cleared or stale plans cannot count leftover canvas previews',()=>{
    const [r]=demandProgress([{id:7,quantity:4}],{7:1},{pieces});assert.equal(r.planned,0);assert.equal(r.reason,'');
});
test('manual deletion uses current geometry and explains the removed quantity',()=>{
    const [r]=demandProgress([{id:7,quantity:4}],{7:1},{pending,pieces:pieces.slice(0,1),edited:true});
    assert.equal(r.planned,1);assert.equal(r.remaining,3);assert.match(r.reason,/移除了 1 件/);
});
test('unknown or incomplete quantity does not fabricate remaining demand',()=>{
    for(const quantity of [NaN,1.5,0]){const [r]=demandProgress([{id:7,quantity}],{},{pending,pieces});assert.equal(r.remaining,null);assert.equal(r.unplaced,null);}
});
test('empty solver results keep reasons, and engine failures are distinct from infeasibility',()=>{
    const [r]=demandProgress([{id:7,quantity:1}],{}, {attempt:{result:{status:'NO_SOLUTION_FOUND',fulfillment:[{demandId:7,unplaced:1,reason:'EXCEEDS_PROCESSING_LENGTH'}]}}});
    assert.match(r.reason,/有效长度/);assert.equal(r.planned,0);
    const [failed]=demandProgress([{id:7,quantity:1}],{}, {attempt:{result:{status:'UNAVAILABLE'}}});assert.match(failed.reason,/未生成有效方案/);
});
