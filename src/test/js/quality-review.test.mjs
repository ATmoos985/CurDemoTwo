import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewablePieces,effectivePieceResults} from '../../main/resources/static/js/business/cutting/quality-review.js';
import {restoreRecordedGeometry} from '../../main/resources/static/js/business/cutting/report-outcomes.js';
const report={planId:'p',status:'CONFIRMED',rollId:'r',feedPortType:'roll',windowStartY:100,
    pieceResults:[{pieceId:1,name:'A',outcome:'QUALIFIED',x:0,y:0,w:100,l:100},{pieceId:2,outcome:'REJECTED'},{pieceId:3,outcome:'UNCUT'}],
    qualityDispositions:[{command:{pieceId:1,disposition:'REMNANT',reason:'破损'}}]};
test('only cut, untreated pieces can be reviewed; reversal disables all',()=>{
    assert.deepEqual(reviewablePieces(report).map(p=>p.pieceId),[2]);assert.deepEqual(reviewablePieces({...report,status:'REVERSED'}),[]);
    assert.deepEqual(reviewablePieces({...report,qualityDispositions:[]}).map(p=>p.pieceId),[1,2]);
});
test('effective quality overlays current results without rewriting original evidence',()=>{
    const before=structuredClone(report),results=effectivePieceResults(report);
    assert.equal(results[0].outcome,'REJECTED');assert.equal(results[0].reason,'复检转料头：破损');assert.deepEqual(report,before);
    const data={rollId:'r',pieces:[],remnants:[]};restoreRecordedGeometry(data,[report],[]);
    assert.equal(data.pieces[0].outcome,'REJECTED');assert.equal(data.pieces[0].sourcePieceId,1);assert.equal(data.pieces[0].y,100);
    assert.deepEqual(report,before);
});
test('latest demand explanation follows quality event instead of earlier original completion',async()=>{
    const {latestDemandChange}=await import('../../main/resources/static/js/business/cutting/demand-progress-model.js');
    const report={planId:'p',taskId:'t',confirmedAt:'2026-10-19',demandQuantities:{1:10},qualityDispositions:[{id:'q',createdAt:'2026-10-20',demandId:1,originalOutcome:'QUALIFIED'}]};
    const latest=latestDemandChange([report],'t');assert.equal(latest.quality,true);assert.deepEqual(latest.deltas,{'1':-1});assert.equal(latest.pieces,1);
    assert.equal(latestDemandChange([report,{taskId:'t',planId:'new',confirmedAt:'2026-10-21',demandQuantities:{1:1}}],'t').planId,'new');
});
