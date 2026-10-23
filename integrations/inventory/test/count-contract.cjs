// Validate real isolated-service count responses against the published OpenAPI schemas.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fromJsonSchema}=require('../../mcp/node_modules/@modelcontextprotocol/server');
const base=process.env.BASE_URL;
if(!base||!['127.0.0.1','localhost'].includes(new URL(base).hostname)||new URL(base).port==='8080')throw Error('Explicit isolated BASE_URL required');
const contract=JSON.parse(fs.readFileSync(new URL('../../../src/main/resources/static/api-v2/openapi.json','file://'+__filename),'utf8'));
function resolve(value){if(Array.isArray(value))return value.map(resolve);if(value&&typeof value==='object'){if(value.$ref)return resolve(contract.components.schemas[value.$ref.split('/').at(-1)]);return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)]));}return value;}
(async()=>{
 let passed=0;const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200);return r.json();};
 const records=await get('/api/v2/inventory-counts');assert.ok(records.length>0,'Run the real browser workflow first; empty records do not validate a receipt');
 const options=await get('/api/v2/inventory-counts/options');
 for(const [name,value] of [['CountOptions',options],['InventoryCount',records[0]],['CountCommand',records[0].command]]){
  const result=await fromJsonSchema(resolve(contract.components.schemas[name]))['~standard'].validate(value);assert.ok(!result.issues,JSON.stringify(result.issues));passed++;
 }
 for(const record of records){const result=await fromJsonSchema(resolve(contract.components.schemas.InventoryCount))['~standard'].validate(record);assert.ok(!result.issues,JSON.stringify(result.issues));}passed++;
 const bad={...records[0].command,unexpected:true};assert.ok((await fromJsonSchema(resolve(contract.components.schemas.CountCommand))['~standard'].validate(bad)).issues);passed++;
 const invalid={...options,revision:'123'};assert.ok((await fromJsonSchema(resolve(contract.components.schemas.CountOptions))['~standard'].validate(invalid)).issues);passed++;
 console.log(JSON.stringify({executed:passed,passed,failed:0,skipped:0,receiptsValidated:records.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
