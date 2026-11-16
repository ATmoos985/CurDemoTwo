const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL;
assert.ok(base&&['localhost','127.0.0.1'].includes(new URL(base).hostname)&&new URL(base).port&&new URL(base).port!=='8080');
const api=async(path,body,headers={})=>{const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}:{});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),page=await browser.newPage({viewport:{width:1366,height:768}}),results=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 const check=async(name,fn)=>{try{await fn();results.push({name,success:true});console.log('PASS',name);}catch(e){results.push({name,success:false,error:e.stack});console.error('FAIL',name,e.message);}};
 try{
  await check('templates prefill matching material and task without writing or replacing an ordinary draft',async()=>{
   const before=await api('/api/cutting/tasks'),rolls=await api('/api/rolls');
   await page.goto(base+'/app/#/task/new');await page.locator('[data-f="name"]').fill('保留正式草稿');await page.locator('[data-f="name"]').blur();
   for(const id of ['continuous','slitting','quality']){
    await page.goto(base+'/app/#/task/new/'+id);await page.locator('#save').waitFor();assert.ok(await page.locator('#save').isEnabled());
    const model=await page.locator('[data-f="materialModel"]').inputValue();
    await page.goto(base+'/app/#/inventory/receive/'+id);await page.locator('[data-form="rollModel"]').waitFor();assert.equal(await page.locator('[data-form="rollModel"]').inputValue(),model);
   }
   await page.goto(base+'/app/#/task/new');assert.equal(await page.locator('[data-f="name"]').inputValue(),'保留正式草稿');
   assert.deepEqual(await api('/api/cutting/tasks'),before);assert.deepEqual(await api('/api/rolls'),rolls);
  });
  const {workflowTemplate}=await import('../../main/resources/static/app/js/model/showcase.js');
  const fixture=workflowTemplate('slitting'),key='FLOW-'+randomUUID();
  fixture.task.demands.forEach(d=>{d.length=2440;});fixture.task.process.bedLength=2490;
  const roll={rollId:key,rollModel:key,width:2000,totalLength:30000,usedLength:0,inspectionStatus:'PASSED',defects:[]};await api('/api/rolls',roll);
  const task=await api('/api/cutting/tasks',{...fixture.task,materialModel:key});
  const plans=()=>api('/api/cutting/tasks/'+task.id+'/plans');
  await check('new workbench computes exact 2440 mm combinations and places two nonoverlapping cars without stock consumption',async()=>{
   await page.goto(base+'/app/#/workbench/'+task.id);await page.locator('[data-roll="'+key+'"]').click();await page.locator('#slit-solve').click();
   await page.locator('[data-car]').first().waitFor({timeout:40000});await page.locator('[data-car]').first().click();
   await page.locator('#report-open').waitFor();await page.locator('[data-seg="__new__"]').click();
   await page.locator('[data-car]').first().click();await page.locator('#report-open').waitFor();
   const rows=await plans();assert.equal(rows.length,2);
   assert.ok(rows.every(p=>p.request.rollL===2490 && p.result.pieces.every(v=>v.l===2440)));const sorted=rows.sort((a,b)=>a.request.windowStartY-b.request.windowStartY);
   assert.ok(sorted[1].request.windowStartY>=sorted[0].request.windowStartY+sorted[0].request.rollL);
   assert.equal((await api('/api/rolls/'+key)).usedLength,0);
  });
  await check('released demand is not subtracted again on the next station',async()=>{
   const rows=await plans(),first=rows.sort((a,b)=>a.request.windowStartY-b.request.windowStartY)[0];
   const created=await api('/api/v2/execution-orders',{planId:first.id,station:'DEMO'},{'Idempotency-Key':randomUUID()});
   const e=created.execution||created;
   await api('/api/v2/execution-orders/'+e.id+'/release',{operationId:randomUUID(),expectedVersion:e.version,reservationSeconds:1800,reason:''});
   await page.reload();await page.locator('[data-seg="__new__"]').click();
   const pending=rows.flatMap(p=>p.result.pieces).length,expected=task.demands.reduce((n,d)=>n+d.quantity,0)-pending;
   assert.match(await page.locator('.split > .pane:last-child').innerText(),new RegExp('2 项 · '+expected+' 卷'));
   assert.equal((await api('/api/rolls/'+key)).usedLength,0);
  });
  await check('browser has no uncaught errors',async()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 const failed=results.filter(r=>!r.success).length;console.log(JSON.stringify({executed:results.length,passed:results.length-failed,failed,skipped:0,results},null,2));if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
