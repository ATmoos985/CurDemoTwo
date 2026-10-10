import test from 'node:test';
import assert from 'node:assert/strict';
import {loadReportQueue, saveReportQueue, queuedQuantities, queuedRollEnd, queuedStockLength, queuedReports} from '../../main/resources/static/js/plugins/solver/report-queue.js';
import {state} from '../../main/resources/static/js/core/state.js';
import {workflowState} from '../../main/resources/static/js/plugins/solver/workflow-state.js';
const entry=(id,start=0)=>({pending:{taskId:'T',rollId:'R',feedPortType:'roll',windowStartY:start,result:{pieces:[{id:1,demandId:9},{id:2,demandId:9},{id:3,demandId:9}]}},report:{planId:id,actualCutLen:1000,pieceResults:[{pieceId:1,outcome:'QUALIFIED'},{pieceId:2,outcome:'REJECTED'},{pieceId:3,outcome:'UNCUT'}]}});
test('queued quality reserves only qualified demand, stock is not counted as reported',()=>{
    const rows=[entry('A'),entry('B',1000)];
    assert.deepEqual(queuedQuantities(rows),{9:2});assert.equal(queuedRollEnd('R',rows),2000);assert.equal(queuedStockLength('R',rows),2000);
    state.activeTask={id:'T'};state.reportQueue=rows;state.taskReports=[{planId:'A'}];state.taskCompleted={9:1};
    assert.deepEqual(queuedReports(),[rows[1]]);assert.deepEqual(state.taskCompleted,{9:1});
});
test('local staged reports round-trip, corrupt records and write failure never erase a previous queue',()=>{
    let value;const storage={getItem:()=>value,setItem:(_,v)=>{value=v;}};
    saveReportQueue('T',[entry('A')],storage);assert.deepEqual(loadReportQueue('T',storage),[entry('A')]);
    assert.throws(()=>saveReportQueue('T',[],{setItem(){throw Error('full');}}));assert.equal(loadReportQueue('T',storage).length,1);
    value='{}';assert.throws(()=>loadReportQueue('T',storage));
});
test('all staged demand remains unfinished until server confirmation',()=>{
    const flow=workflowState({name:'任务',model:'布',queued:2,demands:[{id:9,name:'片',width:2000,length:1000,quantity:2,completed:0,queued:2}]});
    assert.equal(flow.done,false);assert.equal(flow.action,'batch');assert.equal(flow.canSolve,false);
});
