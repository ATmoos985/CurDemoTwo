import test from 'node:test';
import assert from 'node:assert/strict';
import {executionWriter,executionForPlan,executionLocksPlan} from '../../main/resources/static/js/business/cutting/execution-client.js';
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};};
test('uncertain create survives reload and retries the exact identity and station',async()=>{
    const local=storage(), calls=[];
    const fail=async(...args)=>{calls.push(structuredClone(args));throw new Error('lost response');};
    const first=executionWriter(local,fail,()=> 'stable-create-id');
    await assert.rejects(first.command('create',{taskId:'t',planId:'p'},{station:'A'}));
    await assert.rejects(first.command('create',{taskId:'t',planId:'p'},{station:'B'}),/原操作/);
    const restored=executionWriter(local,async(...args)=>{calls.push(args);return {id:'e'};});
    await restored.retry(restored.pending('t')[0][0]);
    assert.deepEqual(calls[0],calls[1]);assert.deepEqual(restored.pending('t'),[]);
    assert.equal(calls[0][2]['Idempotency-Key'],'stable-create-id');
});
test('uncertain versioned commands keep old expectedVersion even after the server advanced',async()=>{
    const local=storage(), calls=[];
    const writer=executionWriter(local,async(...args)=>{calls.push(args);if(calls.length===1)throw new Error('network');return {};},()=> 'op-123456');
    await assert.rejects(writer.command('release',{taskId:'t',id:'e',version:1},{reservationSeconds:1800,reason:'下达'}));
    await writer.retry(writer.pending('t')[0][0]);
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1][1].expectedVersion,1);
});
test('definite conflicts allow a fresh command and storage failure never sends a write',async()=>{
    const local=storage();let calls=0;
    const writer=executionWriter(local,async()=>{calls++;throw Object.assign(new Error('conflict'),{httpStatus:409});},()=> 'id-123456');
    await assert.rejects(writer.command('start',{taskId:'t',id:'e',version:1}));assert.equal(writer.pending('t').length,0);
    const blocked=executionWriter({getItem:()=>null,setItem:()=>{throw new Error('quota');}},async()=>calls++,()=> 'id-123456');
    await assert.rejects(blocked.command('create',{taskId:'t',planId:'p'},{station:'A'}));assert.equal(calls,1);
});
test('active reservation takes precedence over expired plan attempts',()=>{
    const old={execution:{planId:'p'},effectiveState:'EXPIRED',reservationActive:false};
    const active={execution:{planId:'p'},effectiveState:'RUNNING',reservationActive:true};
    assert.equal(executionForPlan([active,old],'p'),active);assert.ok(executionLocksPlan([active,old],'p'));
    assert.equal(executionForPlan([active],'other'),undefined);assert.equal(executionLocksPlan([old],'p'),false);
});
