import test from 'node:test';
import assert from 'node:assert/strict';
import {demandProgress,summarizeDemandProgress,latestDemandChange} from '../../main/resources/static/js/plugins/solver/demand-progress-model.js';
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
test('five lines with three satisfied count complete lines separately from partial pieces and previews',()=>{
    const progress=demandProgress([{id:1,quantity:2},{id:2,quantity:4},{id:3,quantity:1},{id:4,quantity:10},{id:5,quantity:3}],{1:2,2:4,3:1,4:6});
    assert.deepEqual(summarizeDemandProgress(progress),{lines:5,satisfied:3,partial:1,completed:13,total:20,remaining:7});
    assert.equal(summarizeDemandProgress(demandProgress([{id:7,quantity:3}],{},{pending,pieces})).satisfied,0);
    assert.equal(summarizeDemandProgress(demandProgress([{id:7,quantity:NaN}],{7:1})).total,null);
});
test('latest report uses qualified quantities by stable ID and excludes other tasks',()=>{
    const r=latestDemandChange([{taskId:'T',planId:'old',confirmedAt:'2026-10-05T10:00',demandQuantities:{7:2}},
        {taskId:'T',planId:'new',confirmedAt:'2026-10-05T11:00',demandQuantities:{8:1},rejectedPieceCount:2,uncutPieceCount:3},
        {taskId:'OTHER',planId:'other',confirmedAt:'2026-10-05T12:00',demandQuantities:{8:9}}],'T');
    assert.deepEqual(r.deltas,{8:1});assert.equal(r.pieces,1);assert.equal(r.rejected,2);assert.equal(r.uncut,3);
    assert.equal(latestDemandChange([],null),null);
});
test('reversing an older report selects its reversal time and explains restored demand',()=>{
    const r=latestDemandChange([{taskId:'T',planId:'old',status:'REVERSED',confirmedAt:'2026-10-05T10:00',reversedAt:'2026-10-05T12:00',demandQuantities:{7:2}},
        {taskId:'T',planId:'new',confirmedAt:'2026-10-05T11:00',demandQuantities:{7:1}}],'T');
    assert.equal(r.planId,'old');assert.equal(r.reversed,true);assert.deepEqual(r.deltas,{7:-2});assert.equal(r.pieces,2);
});
test('legacy per-piece outcomes only count qualified parts; missing evidence never fabricates a delta',()=>{
    const base={taskId:'T',planId:'P',confirmedAt:'2026-10-05T10:00',finishedPieceCount:9};
    assert.equal(latestDemandChange([base],'T').known,false);
    assert.equal(latestDemandChange([{...base,pieceResults:[]}],'T').known,false);
    const r=latestDemandChange([{...base,pieceResults:[{demandId:7,outcome:'QUALIFIED'},{demandId:7,outcome:'REJECTED'},{demandId:8,outcome:'UNCUT'}]}],'T');
    assert.deepEqual(r.deltas,{7:1});assert.equal(r.pieces,1);
});
