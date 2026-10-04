import test from 'node:test';
import assert from 'node:assert/strict';
import {requestJSON,failurePresentation,ApiError} from '../../main/resources/static/js/core/api-request.js';
const original=globalThis.fetch;
test('HTTP rejection retains status and server message instead of treating it as infeasibility',async()=>{
    try {for(const [status,code]of [[400,'INVALID_INPUT'],[409,'CONFLICT'],[422,'UNSUPPORTED'],[503,'UNAVAILABLE'],[401,'AUTH'],[500,'SERVICE']]){
        globalThis.fetch=async()=>new Response(JSON.stringify({message:'服务器原因'}),{status});
        await assert.rejects(requestJSON('/test',{}),error=>error.code===code && error.httpStatus===status && error.message==='服务器原因');
    }}finally{globalThis.fetch=original;}
});
test('connection loss and non-JSON proxy replies never leak HTML or pretend to have a result',async()=>{
    try{globalThis.fetch=async()=>{throw new TypeError('offline');};await assert.rejects(requestJSON('/test'),e=>e.code==='NETWORK');
        globalThis.fetch=async()=>new Response('<html>proxy error</html>',{status:502});await assert.rejects(requestJSON('/test'),e=>e.code==='INVALID_RESPONSE' && !e.message.includes('html'));
    }finally{globalThis.fetch=original;}
});
test('empty search, unsupported input and stale preview have distinct recovery guidance',()=>{
    assert.match(failurePresentation({status:'NO_SOLUTION_FOUND'}).hint,/不表示已证明无解/);
    assert.match(failurePresentation({status:'UNSUPPORTED'}).hint,/精度/);
    assert.match(failurePresentation(new ApiError('changed','STALE_INPUT')).hint,/未应用/);
});
test('valid payloads preserve result fields and sends explicit JSON only for writes',async()=>{
    const calls=[];try{globalThis.fetch=async(...args)=>{calls.push(args);return new Response(JSON.stringify({status:'FEASIBLE',planId:'p'}));};
        assert.equal((await requestJSON('/test',{id:7})).planId,'p');await requestJSON('/read');assert.equal(calls[0][1].body,'{"id":7}');assert.equal(calls[1][1].method,undefined);
    }finally{globalThis.fetch=original;}
});
