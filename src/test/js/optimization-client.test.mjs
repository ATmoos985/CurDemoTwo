import test from 'node:test';
import assert from 'node:assert/strict';
import {OptimizationSession} from '../../main/resources/static/js/business/optimization/job-client.js';

const response = value => ({ok:true,json:async()=>value});
test('job transport submits once, polls and reads archived result without invoking a solver endpoint', async () => {
    const calls=[], phases=[];
    const client=new OptimizationSession(async(path,options={})=>{
        calls.push([path,options]);
        if(path.endsWith('/optimization-jobs'))return response({id:'a',state:'QUEUED'});
        if(path.includes('/optimization-results/'))return response({marker:{trials:[1]}});
        return response({id:'a',state:'SUCCEEDED',resultRef:'/api/v2/optimization-results/a'});
    },0);
    const result=await client.solve({strategy:{id:'marker-shortening'}},{onProgress:j=>phases.push(j.state)});
    assert.deepEqual(phases,['QUEUED','SUCCEEDED']);
    assert.deepEqual(result.result.marker.trials,[1]);
    assert.equal(calls.length,3);
    assert.ok(calls[0][1].headers['Idempotency-Key']);
    assert.ok(calls.every(([path])=>path.startsWith('/api/v2/')));
});
test('cancellation before submit returns still cancels the accepted server job', async () => {
    let accept;const calls=[];
    const client=new OptimizationSession(async(path)=>{
        calls.push(path);
        if(path.endsWith('/optimization-jobs'))return new Promise(resolve=>{accept=resolve;});
        return response({id:'late',state:'CANCEL_REQUESTED'});
    },0);
    const pending=client.solve({});const rejected=assert.rejects(pending,{name:'AbortError'});
    await client.cancel();
    accept(response({id:'late',state:'QUEUED'}));
    await rejected;
    assert.deepEqual(calls,['/api/v2/optimization-jobs','/api/v2/optimization-jobs/late/cancellations']);
});
test('failed job is reported without attempting to fetch a nonexistent result', async () => {
    const calls=[];
    const client=new OptimizationSession(async(path)=>{
        calls.push(path);return response({id:'failed',state:'FAILED',message:'引擎失败'});
    },0);
    await assert.rejects(client.solve({}),/引擎失败/);
    assert.equal(calls.length,1);
});
test('result URL is derived from job identity even if a response supplies a remote URL', async () => {
    const calls=[];
    const client=new OptimizationSession(async(path)=>{
        calls.push(path);
        return response(path.endsWith('/optimization-jobs')?{id:'a',state:'TIMED_OUT',resultRef:'https://untrusted.test/result'}:{marker:{}});
    },0);
    await client.solve({});
    assert.deepEqual(calls,['/api/v2/optimization-jobs','/api/v2/optimization-results/a']);
});
test('polling failure cancels accepted work before dropping its handle', async () => {
    const calls=[];
    const client=new OptimizationSession(async(path)=>{
        calls.push(path);
        if(path.endsWith('/optimization-jobs'))return response({id:'network-failure',state:'RUNNING'});
        if(path.endsWith('/cancellations'))return response({state:'CANCEL_REQUESTED'});
        throw new Error('network unavailable');
    },0);
    await assert.rejects(client.solve({}),/network unavailable/);
    await client.cancel();
    assert.deepEqual(calls,['/api/v2/optimization-jobs',
        '/api/v2/optimization-jobs/network-failure','/api/v2/optimization-jobs/network-failure/cancellations']);
});
