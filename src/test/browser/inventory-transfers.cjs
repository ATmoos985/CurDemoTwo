const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE||'playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../main/resources/static');
let posts=[],history=[],mode='ok',revision=2;
const materials=()=>[{type:'roll',id:'ROLL-1',location:history.length?'B':'A',materialModel:'<img src=x onerror=alert(1)>',allowed:true,reason:''},{type:'remnant',id:'REM-1',location:'隔离区',materialModel:'布',allowed:false,reason:'正在加工'}];
const server=require('node:http').createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(url.pathname.startsWith('/api/')){
  if(req.method==='GET'){if(mode==='read-fail')return send({message:'读取故障'},503);return send(url.pathname.endsWith('/options')?{revision,materials:materials()}:history);}
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const input=JSON.parse(body),key=req.headers['idempotency-key'];posts.push({body:input,key});if(mode==='conflict')return send({code:'INVENTORY_CONFLICT',message:'库存版本已变化'},409);
   let doc=history.find(x=>x.idempotencyKey===key);if(!doc){doc={id:'单据'+(history.length+1),idempotencyKey:key,command:input,postedAt:Date.now(),inventoryRevision:++revision,lines:input.materials.map(m=>({...m,fromLocation:'A',toLocation:input.destination}))};history.unshift(doc);}
   if(mode==='drop'){req.socket.destroy();return;}send(doc);});return;
 }
 const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{const body=fs.readFileSync(file);res.writeHead(200,{'Content-Type':({'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'text/plain'});res.end(body);}catch{res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});let passed=0,failed=0;
 async function run(name,test){posts=[];history=[];mode='ok';revision=2;const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(5000);
 try{await page.goto(base+'/transfers.html');await expect(page.locator('#post-transfer')).toBeEnabled();await test(page);assert.deepEqual(errors,[]);passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}finally{await context.close();}}
 async function fill(page){await page.locator('#transfer-destination').fill('B');await page.locator('#transfer-reason').fill('待料调拨');await page.locator('#transfer-operator').fill('仓管');await page.getByRole('checkbox',{name:'选择 ROLL-1',exact:true}).check();await page.evaluate(()=>navigator.locks.request('cutdemo.inventory-transfer.v1',()=>{}));}
 try{
 await run('draft recovery, blocked selection, safe rendering and successful posting',async page=>{
  await expect(page.getByRole('checkbox',{name:'选择 REM-1',exact:true})).toBeDisabled();await expect(page.locator('#transfer-materials img')).toHaveCount(0);await fill(page);await page.reload();await expect(page.locator('#transfer-destination')).toHaveValue('B');await expect(page.getByRole('checkbox',{name:'选择 ROLL-1',exact:true})).toBeChecked();
  await page.locator('#post-transfer').click();await expect(page.locator('#transfer-history')).toContainText('1 项');assert.equal(posts.length,1);await expect(page.locator('#transfer-pending')).toBeHidden();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  fs.mkdirSync('/tmp/cutdemo-transfer-browser',{recursive:true});await page.screenshot({path:'/tmp/cutdemo-transfer-browser/posted.png'});
 });
 await run('lost response survives reload and replays identical key and payload',async page=>{
  mode='drop';await fill(page);await page.locator('#post-transfer').click();await expect(page.locator('#transfer-error')).toContainText('不要另建');await expect(page.locator('#post-transfer')).toBeDisabled();assert.equal(history.length,1);await page.reload();await expect(page.locator('#retry-transfer')).toBeEnabled();mode='ok';await page.locator('#retry-transfer').click();await expect(page.locator('#transfer-pending')).toBeHidden();assert.ok(posts.length>=2);for(const post of posts)assert.deepEqual(post,posts[0]);assert.equal(history.length,1);
 });
 await run('conflict preserves editable draft and refresh cannot post',async page=>{
  mode='conflict';await fill(page);await page.locator('#post-transfer').click();await expect(page.locator('#transfer-error')).toContainText('库存版本');await expect(page.locator('#post-transfer')).toBeEnabled();await expect(page.locator('#transfer-destination')).toHaveValue('B');assert.equal(history.length,0);await page.locator('#refresh-transfers').click();await expect(page.locator('#post-transfer')).toBeEnabled();assert.equal(posts.length,1);
 });
 await run('failed refresh blocks submission until recovered',async page=>{
  await fill(page);mode='read-fail';await page.locator('#refresh-transfers').click();await expect(page.locator('#transfer-error')).toContainText('禁止提交');await expect(page.locator('#post-transfer')).toBeDisabled();mode='ok';await page.locator('#refresh-transfers').click();await expect(page.locator('#post-transfer')).toBeEnabled();assert.equal(posts.length,0);
 });
 await run('storage failure prevents any write request',async page=>{
  await fill(page);await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('quota');};});await page.locator('#post-transfer').click();await expect(page.locator('#transfer-error')).toContainText('无法保存');await expect(page.locator('#post-transfer')).toBeDisabled();assert.equal(posts.length,0);
 });
 await run('two pages coordinate posting and preserve unresolved intent',async page=>{
  await fill(page);const other=await page.context().newPage();await other.goto(base+'/transfers.html');await expect(other.locator('#post-transfer')).toBeEnabled();mode='drop';
  await Promise.all([page.evaluate(()=>document.getElementById('transfer-form').requestSubmit()),other.evaluate(()=>document.getElementById('transfer-form').requestSubmit())]);
  await expect(page.locator('#retry-transfer')).toBeEnabled();await expect(other.locator('#post-transfer')).toBeDisabled();assert.equal(history.length,1);assert.equal(new Set(posts.map(p=>p.key)).size,1);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('cutdemo.inventory-transfer.v1')).pending);assert.equal(saved.key,posts[0].key);
  await other.reload();await expect(other.locator('#retry-transfer')).toBeEnabled();mode='ok';await other.locator('#retry-transfer').click();await expect(other.locator('#transfer-pending')).toBeHidden();await expect(page.locator('#transfer-pending')).toBeHidden();assert.equal(history.length,1);await other.close();
 });
 await run('late rejection never clears the newer request from another page',async page=>{
  const held=[];await page.context().route(base+'/api/v2/inventory-transfers',route=>{
   if(route.request().method()!=='POST')return route.continue();held.push(route);
  });
  await fill(page);const other=await page.context().newPage();await other.goto(base+'/transfers.html');await expect(other.locator('#post-transfer')).toBeEnabled();
  await page.locator('#post-transfer').click();await expect.poll(()=>held.length).toBe(1);await expect(other.locator('#retry-transfer')).toBeEnabled();await other.locator('#retry-transfer').click();await expect.poll(()=>held.length).toBe(2);
  await held[1].fulfill({status:409,json:{code:'INVENTORY_CONFLICT',message:'版本冲突'}});await expect(other.locator('#post-transfer')).toBeEnabled();await other.locator('#post-transfer').click();await expect.poll(()=>held.length).toBe(3);
  const newer=held[2].request().headers()['idempotency-key'];assert.notEqual(newer,held[0].request().headers()['idempotency-key']);
  await page.waitForFunction(key=>JSON.parse(localStorage.getItem('cutdemo.inventory-transfer.v1')).pending?.key===key,newer);
  await held[0].fulfill({status:409,json:{code:'INVENTORY_CONFLICT',message:'旧请求版本冲突'}});await expect(page.locator('#refresh-transfers')).toBeEnabled();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cutdemo.inventory-transfer.v1')).pending?.key),newer);
  await held[2].abort('failed');await other.close();
 });
 }finally{await browser.close();await new Promise(r=>server.close(r));}
 console.log(JSON.stringify({executed:passed+failed,passed,failed,skipped:0}));if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
