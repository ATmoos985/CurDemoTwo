import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {configuration} from '../src/api.mjs';

// Explicit isolated endpoint required: never create verification jobs in the user's 8080 service.
if(!process.env.CUTTING_TEST_API_URL)throw Error('Set CUTTING_TEST_API_URL to an isolated temporary-data server.');
const config=configuration({CUTTING_API_URL:process.env.CUTTING_TEST_API_URL});
if(new URL(config.origin).port==='8080')throw Error('Use an isolated server port for the smoke test.');
const snapshot=()=>fetch(config.origin+'/api/v2/inventory-ledger/reconciliation').then(r=>r.json());
const before=await snapshot(),request=JSON.parse(readFileSync(new URL('./fixture.json',import.meta.url)));
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.mjs',import.meta.url))],stderr:'pipe',env:{CUTTING_API_URL:config.origin,CUTTING_MCP_COMPUTE:'true',CUTTING_MCP_BUSINESS_READ:'true'}});
const client=new Client({name:'cutting-real-service-verifier',version:'1'});let passed=0;const results={};
async function call(name,args={}){const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent.data;}
try{
    await client.connect(transport);assert.equal((await client.listTools()).tools.length,10);passed++;
    results.capabilities=await call('get_cutting_capabilities');assert.ok(results.capabilities.problemTypes.includes('NESTING_2D'));passed++;
    assert.equal((await call('validate_cutting_problem',{request})).status,'VALID');passed++;
    const idempotencyKey=randomUUID(),job=await call('submit_optimization_job',{request,idempotencyKey});assert.ok(job.id);passed++;
    assert.equal((await call('submit_optimization_job',{request,idempotencyKey})).id,job.id);passed++;
    let terminal;for(let i=0;i<100;i++){terminal=await call('get_optimization_job',{jobId:job.id});if(['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED'].includes(terminal.state))break;await delay(100);}
    assert.equal(terminal.state,'SUCCEEDED');passed++;
    results.result=await call('get_optimization_result',{resultId:job.id});assert.equal(results.result.fulfillmentStatus,'COMPLETE');assert.equal(results.result.layout,undefined);passed++;
    results.full=await call('get_optimization_result',{resultId:job.id,detail:'full'});assert.ok(results.full.layout);assert.deepEqual(await call('get_optimization_input',{jobId:job.id}),request);passed++;
    results.comparison=await call('compare_cutting_results',{leftId:job.id,rightId:job.id});assert.equal(results.comparison.sameHardConstraints,true);assert.ok(results.comparison.metrics.every(m=>m.rightMinusLeft===0));passed++;
    assert.equal((await call('cancel_optimization_job',{jobId:job.id})).state,'SUCCEEDED');passed++;
    await call('get_inventory_ledger',{limit:1});assert.deepEqual(await snapshot(),before);passed++;
    console.log(JSON.stringify({executed:passed,passed,failed:0,skipped:0,resultId:job.id,metrics:results.result.metrics,inventoryUnchanged:true}));
}finally{await client.close();}
