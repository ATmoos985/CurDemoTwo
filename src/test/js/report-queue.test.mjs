import test from 'node:test';
import assert from 'node:assert/strict';
import {loadReportQueue, saveReportQueue, queuedQuantities, queuedRollEnd, queuedStockLength, queuedReports, stationReport} from '../../main/resources/static/js/plugins/solver/report-queue.js';
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

const pendingStation = () => ({result:{planId:'P',deductLen:1000,pieces:[{id:1,demandId:9,x:0,y:0,w:2000,l:1000}],remnants:[{id:'tail',x:0,y:1000,w:2000,l:500}],cuts:[]},
    request:{rollW:2000,minRemnantWidth:200,minRemnantLength:300},feedPortType:'roll',bedL:1500});
test('direct station recording needs no report dialog and includes recoverable material in the length',()=>{
    const report=stationReport(pendingStation());
    assert.equal(report.actualCutLen,1500);assert.equal(report.finishedPieceCount,1);
    assert.deepEqual(report.pieceResults,[{pieceId:1,outcome:'QUALIFIED',reason:''}]);
    assert.equal(report.actualRemnants[0].id,'tail');assert.equal(report.actualRemnants[0].l,500);
});
test('direct station recording retains edited outcomes, dimensions, deselections and location',()=>{
    const pending=pendingStation();
    Object.assign(pending,{reportActualCutLen:1400,reportLocation:'B-02',reportPieceResults:[{pieceId:1,outcome:'REJECTED',reason:'划伤'}],reportRecovery:{tail:{checked:true,w:1900,l:400}}});
    const report=stationReport(pending);
    assert.equal(report.actualCutLen,1400);assert.equal(report.finishedPieceCount,0);assert.equal(report.location,'B-02');
    assert.deepEqual(report.pieceResults,pending.reportPieceResults);assert.equal(report.actualRemnants[0].w,1900);assert.equal(report.actualRemnants[0].l,400);
    pending.reportRecovery.tail.checked=false;assert.deepEqual(stationReport(pending).actualRemnants,[]);
    pending.reportPieceResults[0].outcome='UNCUT';assert.deepEqual(stationReport(pending).actualRemnants,[]);
});
test('direct remnant recording always uses the sheet once without recovering children or deducting mother roll',()=>{
    const pending=pendingStation();pending.feedPortType='remnant';pending.reportActualCutLen=1500;pending.reportRecovery={tail:{checked:true}};
    const report=stationReport(pending);assert.equal(report.actualCutLen,0);assert.deepEqual(report.actualRemnants,[]);
});
