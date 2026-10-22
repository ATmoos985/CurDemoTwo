import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {createServer,openapi} from '../src/server.mjs';
import {configuration,apiClient,audited} from '../src/api.mjs';
import {fileURLToPath} from 'node:url';

export const problem={schemaVersion:'2.0',problemType:'NESTING_2D',clientRequestId:'MCP-test',allowFallback:false,requireComplete:true,
    problem:{schemaVersion:'1',unit:'mm',material:{id:'external-material',shape:{type:'RECTANGLE',width:2000,height:3000,vertices:[]},exclusions:[],continuesAfterRegion:false},
        parts:[{id:1,name:'<untrusted order note>',shape:{type:'RECTANGLE',width:2000,height:1000,vertices:[]},quantity:3,allowRotation:false}],
        process:{mode:'CROSSCUT',feedMode:'SHEET',startCorner:'left-top',firstStageOrientation:'horizontal',trimStart:0,minReusableWidth:200,minReusableHeight:300,kerf:0,objective:'INPUT_ORDER',pieceGap:0},engine:'auto',timeLimitSeconds:3}};
const job={id:'11111111-1111-4111-8111-111111111111',schemaVersion:'2.0',clientRequestId:'MCP-test',inputHash:'hash',state:'SUCCEEDED',phase:'STOPPED',createdAt:'2026-10-21T00:00:00Z',startedAt:null,finishedAt:null,timeLimitSeconds:3,resultRef:'job-1',code:null,message:null};

async function connected(config={},api=async()=>({}),audit=()=>{}){
    const server=createServer({origin:'http://127.0.0.1:8080',compute:false,businessRead:false,...config},{api,audit});
    const client=new Client({name:'verification-client',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);await client.listTools();
    return {client,close:async()=>{await client.close();await server.close();}};
}
test('configuration permits only literal loopback origins and explicit grants',()=>{
    assert.equal(configuration({}).compute,false);assert.equal(configuration({CUTTING_MCP_COMPUTE:'true'}).compute,true);
    for(const url of ['https://example.com','http://localhost:8080','http://127.0.0.1:8080/path','http://a:b@127.0.0.1','file:///tmp/file','http://127.0.0.1?x=1'])assert.throws(()=>configuration({CUTTING_API_URL:url}));
    assert.throws(()=>configuration({CUTTING_MCP_COMPUTE:'yes'}));
});
test('tool discovery reflects grants and annotations; no stock write tools',async()=>{
    for(const enabled of [false,true]){
        const session=await connected({compute:enabled,businessRead:enabled});
        try{const {tools}=await session.client.listTools();assert.equal(tools.length,enabled?10:6);
            assert.equal(tools.some(t=>t.name==='submit_optimization_job'),enabled);
            if(enabled){assert.equal(tools.find(t=>t.name==='submit_optimization_job').annotations.readOnlyHint,false);assert.equal(tools.find(t=>t.name==='cancel_optimization_job').annotations.destructiveHint,true);}
            assert.ok(tools.every(t=>!t.name.includes('production')&&!t.name.includes('transfer')));
        }finally{await session.close();}
    }
});
test('canonical schemas reject unknown fields and mismatched problem before HTTP',async()=>{
    const sent=[],session=await connected({compute:true},async(...args)=>{sent.push(args);return job;});
    try{
        for(const args of [{idempotencyKey:'test-key',request:{...problem,tenantId:'admin'}},{idempotencyKey:'test-key',request:{...problem,problemType:'SLITTING_1D'}},{idempotencyKey:'test-key',request:problem,approved:true}]){
            const result=await session.client.callTool({name:'submit_optimization_job',arguments:args});assert.equal(result.isError,true);
        }assert.equal(sent.length,0);
        const valid=await session.client.callTool({name:'submit_optimization_job',arguments:{idempotencyKey:'test-key',request:problem}});
        assert.ok(!valid.isError,JSON.stringify(valid));assert.deepEqual(sent[0],['/api/v2/optimization-jobs',problem,'test-key']);
        assert.deepEqual(valid.structuredContent.data,job);
    }finally{await session.close();}
});
test('path injection and overlarge ledger pages are rejected before HTTP',async()=>{
    const sent=[],session=await connected({businessRead:true},async(...args)=>{sent.push(args);return {};});
    try{for(const [name,args]of [['get_optimization_job',{jobId:'../rolls'}],['get_inventory_ledger',{limit:101}],['get_inventory_ledger',{after:-1}]]){
        const result=await session.client.callTool({name,arguments:args});assert.equal(result.isError,true);
    }assert.equal(sent.length,0);}finally{await session.close();}
});
test('API client bounds requests and responses and preserves actionable conflict',async()=>{
    const server=httpServer((req,res)=>{if(req.url==='/huge')return res.end('x'.repeat(1000));if(req.url==='/redirect'){res.writeHead(302,{Location:'http://example.com'});return res.end();}res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'IDEMPOTENCY_CONFLICT',message:'Different input',retryable:false}));});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try{const api=apiClient({origin:'http://127.0.0.1:'+server.address().port},{maxResponseBytes:200});
        await assert.rejects(api('/conflict',{}),e=>e.code==='IDEMPOTENCY_CONFLICT');
        await assert.rejects(api('/huge'),e=>e.code==='RESPONSE_TOO_LARGE');
        await assert.rejects(api('/redirect'),e=>e.code==='SERVICE_UNAVAILABLE');
        await assert.rejects(api('/too-big',{value:'x'.repeat(262144)}),e=>e.code==='PAYLOAD_TOO_LARGE');
    }finally{await new Promise(r=>server.close(r));}
});
test('audit logs summaries only and failure has a trace without raw internal error',async()=>{
    const logs=[];const call=audited('test',async()=>{throw Error('secret-internal-path');},e=>logs.push(e));
    const response=await call({secret:'private-order'});assert.equal(response.isError,true);assert.ok(!JSON.stringify(response).includes('secret-internal-path'));
    assert.ok(!JSON.stringify(logs).includes('private-order'));assert.equal(logs[0].traceId,JSON.parse(response.content[0].text).traceId);
});
test('result summary omits geometry and preserves metric definitions',async()=>{
    const data={id:'result-1',jobId:'job-1',inputHash:'hash',schemaVersion:'2.0',validationStatus:'PASSED',fulfillmentStatus:'COMPLETE',meetsRequirement:true,terminationReason:'COMPLETED',metrics:[{name:'utilization',value:80,unit:'%',numerator:8,denominator:10,basis:'net-area / consumed',version:'1'}],layout:{placements:[]}};
    const session=await connected({},async()=>data);
    try{const result=await session.client.callTool({name:'get_optimization_result',arguments:{resultId:'result-1'}});assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.structuredContent.data.layout,undefined);assert.deepEqual(result.structuredContent.data.metrics,data.metrics);}finally{await session.close();}
});
test('stdio SDK handshake tool discovery and canonical resource work without HTTP',async()=>{
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.mjs',import.meta.url))],stderr:'pipe',env:{CUTTING_API_URL:'http://127.0.0.1:1'}});
    const client=new Client({name:'stdio-verifier',version:'1'});let diagnostics='';transport.stderr.on('data',chunk=>diagnostics+=chunk);
    try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,6);
        const resource=await client.readResource({uri:'cutting://contracts/openapi'});assert.deepEqual(JSON.parse(resource.contents[0].text),openapi);
        const failed=await client.callTool({name:'get_optimization_job',arguments:{jobId:'job-1'}});assert.equal(failed.isError,true);
        assert.equal(JSON.parse(failed.content[0].text).code,'SERVICE_UNAVAILABLE');
    }finally{await client.close();}
    assert.ok(diagnostics.includes('get_optimization_job'));
});
