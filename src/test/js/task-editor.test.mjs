import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {workflowState} from '../../main/resources/static/js/business/cutting/workflow-state.js';

const root = new URL('../../main/resources/static/js/business/cutting/', import.meta.url);
function load(file, values) {
    const context = vm.createContext(values);
    const source = fs.readFileSync(new URL(file, root), 'utf8');
    vm.runInContext(source.replace(/^(?:import .*|export \{.*\} from .*);\r?\n/gm, '').replace(/export /g, ''), context);
    return context;
}
const valid = () => ({name:'现场订单',model:'A',demands:[{id:1,name:'裁片',width:600,length:800,quantity:2,completed:0}]});

test('every save entry rejects incomplete demands before any server request or busy state', async () => {
    let requests = 0;
    const input = valid();
    const document = {body:{inert:false},getElementById:() => {throw new Error('unexpected form mutation');}};
    const context = load('task-workspace.js', {document,readWorkflowState:() => workflowState(input),requestJSON:() => {requests++;}});
    for (const edit of [
        () => {input.name='';},
        () => {Object.assign(input,valid(),{model:''});},
        () => {Object.assign(input,valid(),{demands:[]});},
        () => {Object.assign(input,valid());input.demands[0].width=0;},
        () => {Object.assign(input,valid());input.demands[0].quantity=1.5;},
        () => {Object.assign(input,valid());input.demands[0].completed=3;}
    ]) {
        edit();
        await assert.rejects(context.saveCurrentTask(), error => !!error.target && !!error.message);
        assert.equal(document.body.inert,false);
    }
    assert.equal(requests,0);
});

test('valid demand can be saved before stock selection, including fully reported tasks', async () => {
    const input = valid();
    const context = load('task-workspace.js', {document:{body:{inert:false}},readWorkflowState:() => workflowState(input)});
    vm.runInContext('saveTaskSnapshot = async () => ({id:"saved"});', context);
    assert.equal((await context.saveCurrentTask()).id,'saved');
    input.demands[0].completed=2;
    assert.equal((await context.saveCurrentTask()).id,'saved');
    assert.equal(context.document.body.inert,false);
});

test('queued stations accept equal demand content regardless of server JSON key order, but reject edits', async () => {
    const shape = {type:'POLYGON',width:600,height:800,vertices:[{x:0,y:0},{x:600,y:0},{x:0,y:800}]};
    const line = {id:1,name:'裁片',width:600,length:800,quantity:3,allowRotation:false,shape};
    const current = {id:'task-1',name:'连续工位',materialModel:'A',externalRef:'',demands:[line]};
    const reversed = value => Array.isArray(value) ? value.map(reversed)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reversed(v)])) : value;
    let payload = reversed(current), writes = 0;
    const data = {};
    const context = load('task-workspace.js', {
        state:{activeTask:current,getCurrentCaseData:()=>data},
        queuedReports:()=>[{report:{planId:'pending-1'}}],getDemandsFromUI:()=>[],
        requestJSON:()=>{writes++;throw Error('must not change task revision');},
        readPayload:()=>payload
    });
    vm.runInContext('taskPayload = () => readPayload();', context);
    assert.equal(await context.saveTaskSnapshot(),current);
    for (const edit of [
        p=>{p.demands[0].quantity++;},p=>{p.demands[0].width++;},
        p=>{p.demands[0].shape.vertices[1].x--;},p=>{p.demands[0].allowRotation=true;},
        p=>{p.name='修改任务';}
    ]) {
        payload=reversed(current);edit(payload);
        await assert.rejects(context.saveTaskSnapshot(), /请先完成集中报工/);
    }
    assert.equal(writes,0);
});

test('new task opens one editor only after the draft guard succeeds and ignores double clicks', async () => {
    let finish, calls=0, opens=0, selects=0;
    const context = load('task-creation.js', {
        newCuttingTask:() => {calls++;return new Promise(resolve => {finish=resolve;});},
        openDemandManager:() => {opens++;},
        document:{getElementById:() => ({select:() => {selects++;}})}
    });
    const canceled = context.openNewTask();
    await context.openNewTask();
    assert.equal(calls,1);
    finish(false);await canceled;
    assert.equal(opens,0);
    const accepted = context.openNewTask();finish(true);await accepted;
    assert.equal(opens,1);assert.equal(selects,1);
});
