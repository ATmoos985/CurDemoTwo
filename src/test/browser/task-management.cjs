// node src/test/browser/task-management.cjs
// Set PLAYWRIGHT_MODULE and CHROME_PATH when using a bundled browser runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {createServer} = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../main/resources/static');
let tasks, failSave, requests, failRead=false;
const roll = {rollId:'ROLL-2026-0920', rollModel:'TC涤棉-B2026', width:2000, totalLength:60000, usedLength:0, currentRemainingLength:60000, defects:[]};
const initialTask = () => ({id:'task-a', revision:1, name:'已保存需求', materialModel:roll.rollModel, externalRef:'ORDER-A',
    process:{bedLength:5000,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false},
    demands:[{id:7,name:'主帘',width:2000,length:1200,quantity:3,allowRotation:false}]});
const server = createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (value, status=200) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (url.pathname.startsWith('/api/')) {
        requests.push(req.method + ' ' + url.pathname);
        if(failRead)return json({message:'服务暂不可用'},503);
        if (url.pathname === '/api/rolls') return json([roll]);
        if (url.pathname === '/api/rolls/' + roll.rollId) return json(roll);
        if (url.pathname === '/api/remnants' || url.pathname.endsWith('/plans') || url.pathname==='/api/v2/execution-orders') return json([]);
        if(url.pathname==='/api/cutting/task-summaries')return json([...tasks.values()].map(task=>({task,total:task.demands.reduce((n,d)=>n+d.quantity,0),completed:1,remaining:task.demands.reduce((n,d)=>n+d.quantity,0)-1,pendingCount:0,reportCount:0,reserved:1,availableToPlan:1,status:'REPORT_PENDING',nextAction:'workspace',materialReservations:[{materialId:roll.rollId,station:'裁床 A'}]})));
        if (url.pathname === '/api/cutting/tasks' && req.method === 'GET') return json([...tasks.values()]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            if (failSave) return json({message:'测试保存失败'}, 503);
            const body = JSON.parse(raw), id = body.id || 'task-new';
            const task = {...body, id, revision:(tasks.get(id)?.revision || 0)+1}; tasks.set(id,task); return json(task);
        }
        const task = tasks.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        if (task) return json({task,completed:{7:1},reports:[]});
        return json({message:'unexpected fixture route'},404);
    }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
    try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)] || 'application/octet-stream'}); res.end(body);
    } catch {res.writeHead(404);res.end();}
});

(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});let passed=0,failed=0;
 async function run(name,verify){
  tasks=new Map([['task-a',initialTask()],['task-b',{...initialTask(),id:'task-b',name:'另一任务 <img src=x onerror=alert(1)>'}]]);requests=[];failSave=false;failRead=false;
  const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(6000);
  try{await verify(page);assert.deepEqual(errors,[]);assert.equal(requests.filter(r=>r.startsWith('POST')).length,0);passed++;console.log('PASS '+name);}
  catch(error){failed++;console.error('FAIL '+name+'\n'+error.stack);}
  finally{await context.close();}
 }
 const ready=async(page,url)=>{await page.goto(base+url);await expect(page.locator('body')).not.toHaveAttribute('inert','');await expect(page.locator('#task-state')).not.toHaveText('未保存');};
 const draft=async page=>{
  await ready(page,'/index.html');await page.evaluate(()=>window.camApp.openDemandManager());
  await page.getByRole('button',{name:'＋ 添加需求',exact:true}).click();
  await page.locator('.dem-name').fill('本机草稿');await page.locator('.dem-w').fill('1234.5');
  await expect(page.locator('#task-state')).toContainText('本机草稿');
  return page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('cutting-demand-draft:')).map(([k,v])=>{const {updatedAt,...draft}=JSON.parse(v);return [k,draft];})));
 };
 try{
  await run('task list filters, escaped text, quantities and desktop layouts',async page=>{
   await page.goto(base+'/tasks.html');await expect(page.locator('#task-rows tr')).toHaveCount(2);
   await expect(page.locator('#task-rows img')).toHaveCount(0);await expect(page.locator('#task-rows tr').first()).toContainText('1 / 1 件');
   await page.locator('#task-status').selectOption('PLAN_PENDING');await expect(page.locator('#task-rows tr')).toHaveCount(0);
   await page.locator('#task-status').selectOption('REPORT_PENDING');await page.locator('#task-search').fill('task-b');await expect(page.locator('#task-rows tr')).toHaveCount(1);
   await page.reload();await expect(page.locator('#task-rows tr')).toHaveCount(1);
   for(const [width,height]of[[1366,768],[1920,1080]]){await page.setViewportSize({width,height});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));fs.mkdirSync('target/task-management',{recursive:true});await page.screenshot({path:`target/task-management/list-${width}.png`});}
   await page.locator('#task-rows a').click();await expect(page.locator('#task-name')).toHaveValue(tasks.get('task-b').name);
  });
  await run('direct task URL keeps the other local draft intact',async page=>{
   const before=await draft(page);await ready(page,'/index.html?taskId=task-a');await expect(page.locator('#task-name')).toHaveValue(initialTask().name);
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('cutting-demand-draft:')).map(([k,v])=>{const {updatedAt,...draft}=JSON.parse(v);return [k,draft];}))),before);
   await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 1');
  });
  await run('invalid target has a blocking error without changing the draft pointer',async page=>{
   await draft(page);const active=await page.evaluate(()=>localStorage.getItem('cutting-demand-draft-active'));
   await page.goto(base+'/index.html?taskId=missing');await expect(page.locator('#task-route-error')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#task-route-error')).toBeVisible();
   assert.equal(await page.evaluate(()=>localStorage.getItem('cutting-demand-draft-active')),active);
  });
  await run('new-task URL retains existing draft without server writes',async page=>{
   const before=await draft(page);await ready(page,'/index.html?newTask=1');await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 1');
   assert.equal(await page.evaluate(async()=>(await import('/js/core/state.js')).state.activeTask),null);
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('cutting-demand-draft:')).map(([k,v])=>{const {updatedAt,...draft}=JSON.parse(v);return [k,draft];}))),before);
  });
  await run('successful in-page task switch updates direct URL and reload identity',async page=>{
   await page.goto(base+'/tasks.html');await ready(page,'/index.html?taskId=task-a');await page.locator('.header-more > summary').filter({hasText:'任务操作'}).click();await page.getByRole('button',{name:'打开任务',exact:true}).click();await page.locator('[data-task=task-b]').click();
   await expect(page).toHaveURL(/taskId=task-b/);await page.reload();await expect(page.locator('#task-name')).toHaveValue(tasks.get('task-b').name);
   await page.goBack();await expect(page).toHaveURL(base+'/tasks.html');await page.goForward();await expect(page.locator('#task-name')).toHaveValue(tasks.get('task-b').name);
  });
  await run('failed initial read cannot silently load last task or discard draft',async page=>{
   const before=await draft(page);failRead=true;await page.goto(base+'/index.html?taskId=task-a');await expect(page.locator('#task-route-error')).toBeVisible();
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('cutting-demand-draft:')).map(([k,v])=>{const {updatedAt,...draft}=JSON.parse(v);return [k,draft];}))),before);
  });
  await run('read views open after initialization and perform no commands',async page=>{
   for(const view of ['executions','reports','plans']){
    await page.goto(base+'/index.html?taskId=task-a&view='+view);
    await expect(page.locator(view==='executions'?'#execution-dialog':'#task-picker')).toBeVisible();
    await expect(page.locator('#task-name')).toHaveValue(initialTask().name);
   }
  });
  await run('failed list refresh preserves visible records with explicit stale warning',async page=>{
   await page.goto(base+'/tasks.html');await expect(page.locator('#task-rows tr')).toHaveCount(2);failRead=true;
   await page.locator('#refresh-tasks').click();await expect(page.locator('#task-list-error')).toContainText('旧列表仅供参考');
   await expect(page.locator('#task-rows tr')).toHaveCount(2);failRead=false;await page.locator('#refresh-tasks').click();await expect(page.locator('#task-list-error')).toBeHidden();
  });
  await run('saving task process persists a recoverable draft and reload restores it',async page=>{
   await ready(page,'/index.html');await page.evaluate(async()=>{await (await import('/js/business/cutting/task-workspace.js')).loadTask('task-a');window.camApp.openSettingsModal();window.camApp.switchSettingsTab('craft');});
   await page.locator('#cfg-trim-start').fill('50');await page.evaluate(()=>window.camApp.saveSettings());
   await expect(page.locator('#task-state')).toContainText('本机草稿');await page.reload();await expect(page.locator('#inp-trim-start')).toHaveValue('50');
  });
  await run('settings deep link preserves draft and active reservations block process changes',async page=>{
   const before=await draft(page);await page.goto(base+'/index.html?settings=craft');await expect(page.locator('#settings-modal')).toBeVisible();
   await expect(page.locator('#pane-craft')).toBeVisible();await page.evaluate(()=>{window.camApp.state.taskExecutions=[{reservationActive:true}];});
   await page.locator('#cfg-trim-start').fill('9');await page.evaluate(()=>window.camApp.saveSettings());await expect(page.locator('#settings-modal')).toBeVisible();
   assert.deepEqual(await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('cutting-demand-draft:')).map(([k,v])=>{const {updatedAt,...draft}=JSON.parse(v);return [k,draft];}))),before);
  });
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
 console.log(JSON.stringify({discovered:10,executed:passed+failed,passed,failed,skipped:0}));if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
