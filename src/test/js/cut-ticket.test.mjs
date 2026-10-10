import test from 'node:test';
import assert from 'node:assert/strict';
import {ticketNumber,ticketModel,ticketHTML,ticketBlueprint} from '../../main/resources/static/js/plugins/export/cut-ticket-model.js';
const plan=()=>({id:'plan-a',version:2,parentPlanId:'plan-parent',createdAt:'2026-10-04T12:00:00',status:'PENDING',
    request:{taskId:'task-a',taskRevision:3,rollId:'roll-a',rollModel:'棉',rollW:2000,rollL:5000,windowStartY:2700,cutOrigin:'left-top',feedPortType:'roll'},
    result:{planId:'plan-a',pieces:[{id:1,demandId:7,name:'主帘',x:0,y:100,w:2000,l:1000},{id:2,demandId:7,name:'主帘',x:0,y:1100,w:2000,l:1000}],cuts:[],remnants:[{id:'candidate',x:0,y:2100,w:2000,l:2900}]}});
test('ticket identity is stable and uniquely includes the full saved plan and version',()=>{
    assert.equal(ticketNumber(plan()),'WO-plan-a-V2');assert.equal(ticketNumber(plan()),ticketNumber(structuredClone(plan())));
    assert.notEqual(ticketNumber(plan()),ticketNumber({...plan(),id:'plan-b'}));
    const m=ticketModel(plan());assert.equal(m.taskRevision,3);assert.equal(m.parentPlanId,'plan-parent');
});
test('planned output and remnants are explicitly unreported with no invented metrics',()=>{
    const html=ticketHTML(ticketModel(plan()));assert.match(html,/待报工方案/);assert.match(html,/计划裁片 · 待现场核对/);assert.match(html,/报工后才生成入库凭证/);
    assert.doesNotMatch(html,/合格成品|6\.18|65\.2|CUT-STATION-01/);
});

test('single-use remnant ticket excludes planned leftovers but preserves historical receipts',()=>{
    const p=plan();p.request.feedPortType='remnant';
    assert.deepEqual(ticketModel(p).remnants,[]);
    assert.match(ticketHTML(ticketModel(p)),/余料不再回收/);
    p.status='CONFIRMED';p.receipt={planId:p.id,derivedRemnants:[{id:'historical',width:500,length:500}]};
    assert.equal(ticketModel(p).remnants[0].id,'historical');
});
test('partial report binds exact piece outcomes and actual inventory instead of candidate remnants',()=>{
    const p=plan();p.status='CONFIRMED';p.receipt={planId:p.id,confirmedAt:'2026-10-04',actualCutLen:2100,finishedPieceCount:0,rejectedPieceCount:1,uncutPieceCount:1,
        pieceResults:[{pieceId:1,outcome:'REJECTED',reason:'破损'},{pieceId:2,outcome:'UNCUT'}],derivedRemnants:[{id:'stock-real',width:2000,length:900,location:'A-02'}],recoveredGeometry:[]};
    const m=ticketModel(p),html=ticketHTML(m);assert.deepEqual(m.pieces.map(p=>p.outcome),['REJECTED','UNCUT']);assert.equal(m.remnants[0].id,'stock-real');assert.match(html,/破损/);assert.match(html,/A-02/);assert.doesNotMatch(html,/candidate/);
    p.status='REVERSED';p.receipt.status='REVERSED';assert.match(ticketHTML(ticketModel(p)),/不计入当前产出和库存/);
});
test('later windows use immutable local geometry and equal scale instead of applying global Y twice',()=>{
    const p=plan(),m=ticketModel(p),svg=ticketBlueprint(m);assert.equal(m.pieces[0].y,100);assert.match(ticketHTML(m),/2,700–7,700 mm/);
    const rect=svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#e0f2fe"/);
    assert.ok(rect);assert.ok(Math.abs(Number(rect[2])-6.6)<1e-9);assert.equal(Number(rect[3])/Number(rect[4]),2);assert.deepEqual(p,plan());
});
test('legacy receipts do not invent individual quality and unmatched receipts cannot print',()=>{
    const p=plan();p.receipt={planId:p.id};assert.ok(ticketModel(p).pieces.every(p=>p.outcome==='UNRECORDED'));
    p.receipt.planId='other';assert.throws(()=>ticketModel(p),/不一致/);
});
test('historical preview is not an execution instruction and user content is escaped',()=>{
    const p=plan();p.result.pieces[0].name='<img src=x onerror=alert(1)>';p.request.rollModel='<script>';
    const html=ticketHTML(ticketModel(p,true));assert.match(html,/执行前须恢复并重新校验/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script/);
});
