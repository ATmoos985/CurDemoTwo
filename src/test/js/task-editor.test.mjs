import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {workflowState} from '../../main/resources/static/js/plugins/solver/workflow-state.js';

const root = new URL('../../main/resources/static/js/plugins/solver/', import.meta.url);
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
