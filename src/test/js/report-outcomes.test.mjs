import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReport,reportRecoveryCandidates,applyReportReceipt} from '../../main/resources/static/js/plugins/solver/report-outcomes.js';

const pieces=[1,2,3].map((id,i)=>({id,demandId:id===3?9:7,name:'同尺寸',x:0,y:i*1000,w:2000,l:1000}));
const results=[{pieceId:1,outcome:'QUALIFIED'},{pieceId:2,outcome:'REJECTED',reason:'破损'},{pieceId:3,outcome:'UNCUT'}];
test('identical dimensions retain per-piece result and demand ownership',()=>{
    const groups=classifyReport(pieces,results);assert.deepEqual(groups.QUALIFIED.map(p=>p.id),[1]);assert.deepEqual(groups.REJECTED.map(p=>p.id),[2]);assert.equal(groups.UNCUT[0].demandId,9);
});
test('raw recovery includes only the separated portion of uncut pieces and never rejected pieces',()=>{
    const candidates=reportRecoveryCandidates({pieces,remnants:[]},results,2500.5);
    assert.equal(candidates.length,1);assert.equal(candidates[0].id,'UNCUT-3');assert.equal(candidates[0].l,500.5);
    assert.equal(reportRecoveryCandidates({pieces,remnants:[]},results,2000).length,0);
});
test('receipt painting removes uncut previews and unrecovered candidates while preserving earlier history',()=>{
    const data={pieces:[{id:99,y:0,l:500,confirmed:true,planId:'past'},...pieces.map(p=>({...p,sourcePieceId:p.id,planId:'new',y:p.y+5000}))],
        remnants:[{id:'past-rem',confirmed:true},{id:'not-recovered'}],cuts:[{pos:8000}]};
    applyReportReceipt(data,{windowStartY:5000,result:{planId:'new',pieces}},{pieceResults:results,recoveredGeometry:[{id:'stock-rem',x:0,y:2000,w:2000,l:500.5,area:1.001}]});
    assert.deepEqual(data.pieces.map(p=>p.id),[99,1,2]);assert.equal(data.pieces[2].outcome,'REJECTED');assert.equal(data.pieces[2].confirmed,true);
    assert.deepEqual(data.remnants.map(r=>r.id),['past-rem','stock-rem']);assert.equal(data.remnants[1].y,7000);assert.equal(data.cuts.length,0);
});
