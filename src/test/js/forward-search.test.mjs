import test from 'node:test';
import assert from 'node:assert/strict';
import {windowDefects, forwardWindows, findForwardPlan} from '../../main/resources/static/js/plugins/solver/forward-search.js';
const request={feedPortType:'roll',windowStartY:0,totalRollL:12000,rollW:2000,rollL:4000,trimStart:0,allowLongitudinal:false,demands:[{id:1,width:2000,length:4000,demand:1}]};
test('defect clearance crossing either edge remains blocked without extending its original end',()=>{
    assert.deepEqual(windowDefects([{id:1,x:10,y:990,w:10,h:20,margin:20}],1000,4000,2000),[{id:1,x:0,y:0,w:40,h:30,margin:0}]);
    assert.equal(windowDefects([{id:1,x:100,y:3990,w:10,h:10,margin:20}],0,3980,2000)[0].h,10);
});
test('search covers later defect boundaries in order, respects rotation, trim and tail',()=>{
    const defects=[{id:1,x:0,y:1000,w:2000,h:200,margin:20},{id:2,x:0,y:6000,w:2000,h:100,margin:20}];
    assert.deepEqual(forwardWindows(request,defects).map(w=>w.windowStartY),[1220,6120]);
    assert.equal(forwardWindows({...request,feedPortType:'remnant'},defects).length,0);
    assert.equal(forwardWindows({...request,rollW:1500},defects).length,0);
    assert.equal(forwardWindows({...request,totalRollL:5000},defects).length,0);
});
test('a blocked window continues to a solver-validated later result without changing its input',async()=>{
    const defects=[{id:1,x:0,y:1000,w:2000,h:200,margin:20}];let calls=0;
    const found=await findForwardPlan(request,defects,async r=>{calls++;return {success:true,status:'FEASIBLE',pieces:[{id:1}],cuts:[],remnants:[],planId:'P'};});
    assert.equal(calls,1);assert.equal(found.request.windowStartY,1220);assert.equal(request.windowStartY,0);
    assert.equal(found.search.found,true);
});
test('engine errors or changed input stop search and are never labelled a material failure',async()=>{
    const defects=[{id:1,x:0,y:1000,w:2000,h:200,margin:20},{id:2,x:0,y:6000,w:2000,h:100,margin:20}];let calls=0;
    const failure=await findForwardPlan(request,defects,async()=>{calls++;return {success:false,status:'UNAVAILABLE'};});
    assert.equal(calls,1);assert.equal(failure.result.status,'UNAVAILABLE');assert.equal(failure.search.exhausted,false);
    const stale=await findForwardPlan(request,defects,async()=>{calls++;},{isCurrent:()=>false});assert.equal(stale,null);assert.equal(calls,1);
});

test('malformed success stops search while clean no-solution results exhaust candidates',async()=>{
    const defects=[{id:1,x:0,y:1000,w:2000,h:200,margin:20}];
    const invalid=await findForwardPlan(request,defects,async()=>({success:true,pieces:[{}]}));
    assert.equal(invalid.result.status,'INVALID_RESULT');assert.equal(invalid.search.exhausted,false);
    const empty=await findForwardPlan(request,defects,async()=>({success:false,status:'NO_SOLUTION_FOUND'}));
    assert.equal(empty.search.exhausted,true);assert.equal(empty.search.attempts,1);
});
