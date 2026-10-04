import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowState} from '../../main/resources/static/js/plugins/solver/workflow-state.js';
const source = () => ({name:'订单', model:'A', demands:[{id:7,name:'主帘',width:2000,length:1200,quantity:4,completed:1}],
    material:{available:true,sheet:false,model:'A',length:5000,used:5000,total:10000},process:{length:5000,start:5000,trim:0}});

test('missing and invalid demand fields identify the field without offering solve', () => {
    for(const [key,value,target] of [['width',0,'w'],['length',NaN,'l'],['quantity',1.5,'count'],['quantity',0,'count'],['name','','name']]) {
        const input=source();input.demands[0][key]=value;const result=workflowState(input);
        assert.equal(result.stage,0);assert.equal(result.canSolve,false);assert.ok(result.target.endsWith('.dem-'+target));
    }
    const input=source();input.demands=[];assert.equal(workflowState(input).action,'add');
    input.model='';assert.equal(workflowState(input).target,'#task-material');
});
test('missing stock and wrong model require explicit material selection', () => {
    for(const change of [{available:false},{length:0},{model:'B'}]) {
        const input=source();Object.assign(input.material,change);assert.equal(workflowState(input).action,'match');assert.equal(workflowState(input).canSolve,false);
    }
});
test('viewing consumed stock and invalid process lengths cannot become solve-ready', () => {
    const input=source();input.process.start=0;assert.equal(workflowState(input).action,'advance');
    input.process.start=5000;input.process.length=6000;assert.equal(workflowState(input).target,'#inp-bed-l');
    input.process.length=4000;input.process.start=7000;assert.equal(workflowState(input).target,'#radar-window');
    input.process.start=5000;input.process.trim=4000;assert.equal(workflowState(input).target,'#inp-trim-start');
});
test('validated output, manual edits and an empty preview have distinct next actions', () => {
    assert.equal(workflowState(source()).action,'solve');
    assert.equal(workflowState({...source(),edited:true}).action,'validate');
    assert.equal(workflowState({...source(),ready:true}).action,'report');
    const sheet=source();Object.assign(sheet.material,{sheet:true,length:700,used:99000,total:0});Object.assign(sheet.process,{length:700,start:0});
    assert.equal(workflowState(sheet).action,'solve');
});
test('only qualified completion finishes demand; no material is required to review a finished task', () => {
    const input=source();input.demands[0].completed=4;input.material.available=false;
    assert.equal(workflowState(input).action,'reports');assert.equal(workflowState(input).done,true);assert.equal(workflowState(input).canSolve,false);
    input.demands[0].quantity=3;assert.equal(workflowState(input).stage,0);assert.equal(workflowState(input).done,false);
});
