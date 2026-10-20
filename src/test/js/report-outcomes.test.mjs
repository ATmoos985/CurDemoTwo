import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReport,reportRecoveryCandidates,applyReportReceipt,restoreRecordedGeometry} from '../../main/resources/static/js/business/cutting/report-outcomes.js';

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

const queuedStation=(planId,offset=5000)=>({pending:{rollId:'ROLL',feedPortType:'roll',windowStartY:offset,
    request:{minRemnantWidth:200,minRemnantLength:300},result:{pieces}},
    report:{planId,pieceResults:results,actualRemnants:[{id:'tail',x:0,y:2000,w:2000,l:400.5,hasDefect:true}]}});

test('recorded geometry restores missing past leftovers at global coordinates with unique stable IDs',()=>{
    const queue=[queuedStation('A'),queuedStation('B',8000)];
    const data={rollId:'ROLL',pieces:[{...pieces[0],id:99,sourcePieceId:1,planId:'A',queued:true,y:5000}],remnants:[]};
    restoreRecordedGeometry(data,[],queue);
    assert.equal(data.pieces.length,4);assert.equal(data.pieces[0].id,99);
    assert.equal(new Set(data.pieces.map(p=>p.id)).size,4);
    assert.deepEqual(data.remnants.map(r=>r.y),[7000,10000]);
    assert.equal(new Set(data.remnants.map(r=>r.id)).size,2);
    assert.ok(data.remnants.every(r=>r.queued && !r.confirmed && r.hasDefect));
    const before=structuredClone(data);restoreRecordedGeometry(data,[],queue);assert.deepEqual(data,before);
});

test('history restores reported geometry without double painting stale queue entries or reversed reports',()=>{
    const receipt={planId:'A',rollId:'ROLL',feedPortType:'roll',windowStartY:5000,status:'CONFIRMED',
        pieceResults:pieces.map(p=>({...p,pieceId:p.id,...results.find(r=>r.pieceId===p.id)})),
        recoveredGeometry:[{id:'STOCK-A',x:0,y:2000,w:2000,l:400}]};
    const data={rollId:'ROLL',pieces:[{...pieces[0],id:10,planId:'preview'}],remnants:[{id:'preview',planId:'preview'}]};
    restoreRecordedGeometry(data,[receipt,{...receipt,planId:'reversed',status:'REVERSED'}],[queuedStation('A'),queuedStation('B',8000)]);
    assert.equal(data.pieces.length,5);assert.equal(data.remnants.length,3);
    assert.equal(data.remnants.find(r=>r.id==='STOCK-A').y,7000);
    assert.ok(data.pieces.filter(p=>p.planId==='A').every(p=>p.confirmed && !p.queued));
    assert.ok(!data.pieces.some(p=>p.planId==='reversed'));
    assert.equal(data.remnants.filter(r=>r.planId==='A').length,1);
});

test('restoring a source excludes other rolls and sheet children, and respects edited recovery sizes',()=>{
    const row=queuedStation('A'),other=queuedStation('other');other.pending.rollId='OTHER';
    row.report.actualRemnants.push({id:'too-small',x:0,y:2400.5,w:100,l:400});
    const data={rollId:'ROLL',pieces:[],remnants:[]};
    restoreRecordedGeometry(data,[],[row,other]);
    assert.equal(data.remnants.length,1);assert.equal(data.remnants[0].l,400.5);
    row.pending.feedPortType='remnant';row.pending.sourceRemnantId='SHEET';row.pending.windowStartY=0;
    restoreRecordedGeometry(data,[],[row,other],'remnant','SHEET');
    assert.equal(data.remnants.length,0);assert.equal(data.pieces.length,2);assert.equal(data.pieces[0].y,0);
    restoreRecordedGeometry(data,[],[row],'remnant','ANOTHER-SHEET');assert.equal(data.pieces.length,0);
});
