// Write fixtures only to an isolated server.
const assert=require('node:assert/strict');
const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base=process.env.BASE_URL;
if(!base || new URL(base).port==='8080')throw new Error('Explicit isolated BASE_URL required');
async function api(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});let passed=0;
 const pass=name=>{passed++;console.log('PASS '+name);};
 try {
  const page=await browser.newPage({viewport:{width:1366,height:768}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
  const suffix=Date.now();
  const roll=await api('/api/rolls',{rollId:'EXEC-UI-'+suffix,rollModel:'执行验证-'+suffix,width:2000,totalLength:12000,inspectionStatus:'PASSED',defects:[]});
  const task=await api('/api/cutting/tasks',{name:'执行工作台验证-'+Date.now(),materialModel:roll.rollModel,revision:0,demands:[{id:1,name:'裁片',width:2000,length:1000,quantity:2,allowRotation:false}],process:{bedLength:1500,trimStart:0,pieceGap:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false}});
  await page.goto(base+'/index.html?taskId='+encodeURIComponent(task.id));await page.waitForLoadState('networkidle');
  await page.evaluate(async({task,roll})=>{await (await import('/js/business/cutting/task-workspace.js')).loadTask(task.id);document.querySelector('#sel-mother-roll-id').value=roll.rollId;await (await import('/js/plugins/remnant/remnant-shelf.js')).switchCutMode('roll');const s=(await import('/js/core/state.js')).state;s.getCurrentCaseData().bedL=1500;(await import('/js/business/cutting/solver-client.js')).updateUIInfo();},{task,roll});
  await page.locator('#btn-trigger-solve-station').click();await expect(page.locator('#btn-workflow-next')).toHaveText('下达当前方案');
  const pending=await page.evaluate(async()=>(await import('/js/core/state.js')).state.pendingPlan);
  await page.locator('#btn-workflow-next').click();await page.locator('#execution-dialog input[name=station]').fill('裁床 A-01');await page.getByRole('button',{name:'创建执行单',exact:true}).click();
  await expect(page.locator('#execution-dialog [data-action=release]')).toBeEnabled();
  const before=await api('/api/rolls/'+roll.rollId);
  const summary=async()=>(await api('/api/cutting/task-summaries')).find(row=>row.task.id===task.id);
  await page.locator('#execution-dialog [data-action=release]').click();await expect(page.locator('#execution-dialog [data-action=start]')).toBeEnabled();
  let views=await api('/api/v2/execution-orders?taskId='+task.id);assert.equal(views[0].effectiveState,'RELEASED');assert.deepEqual(await api('/api/rolls/'+roll.rollId),before);assert.equal((await api('/api/cutting/tasks/'+task.id)).reserved['1'],pending.result.pieces.length);assert.equal((await summary()).status,'EXECUTION_PENDING');assert.equal((await summary()).reserved,pending.result.pieces.length);assert.equal((await summary()).completed,0);pass('下达只预约，不扣料或完成需求');
  await page.locator('#execution-dialog [data-action=start]').click();await expect(page.locator('#execution-dialog [data-action=report]')).toBeEnabled();await expect(page.locator('#execution-dialog [data-action=cancel]')).toHaveCount(0);
  for(const [width,height] of [[1366,768],[1920,1080]]){await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await expect(page.locator('#execution-dialog [data-action=report]')).toBeInViewport();}
  assert.equal((await summary()).status,'REPORT_PENDING');
  pass('开工状态与取消限制、两种屏幕布局');
  await page.keyboard.press('Escape');await page.reload();await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:'执行与预约',exact:true}).click();await page.locator('#execution-dialog [data-view]').click();await expect(page.locator('#execution-dialog')).not.toBeVisible();await expect(page.locator('#btn-workflow-next')).toHaveText('填写实切结果');
  assert.equal(await page.evaluate(async()=>{const {pieceGroup}=await import('/js/plugins/cad/cad-stage.js');return pieceGroup.getChildren().some(n=>n.draggable());}),false);pass('刷新后只读恢复执行中方案，画布不能拖动');
  await page.locator('#btn-workflow-next').click();await page.locator('#execution-dialog [data-action=report]').click();await expect(page.locator('#cut-report-modal')).toBeVisible();await expect(page.locator('#report-stage-button')).toBeHidden();
  await page.locator('#report-confirm-button').click();await expect(page.locator('#cut-report-modal')).not.toBeVisible();
  views=await api('/api/v2/execution-orders?taskId='+task.id);assert.equal(views[0].effectiveState,'REPORTED');const detail=await api('/api/cutting/tasks/'+task.id);assert.equal(detail.reports.length,1);assert.deepEqual(detail.reserved,{});assert.ok((await api('/api/rolls/'+roll.rollId)).usedLength>before.usedLength);assert.equal((await summary()).reserved,0);assert.equal((await summary()).completed,pending.result.pieces.length);pass('通过执行单报工，仅一次库存扣减并释放预约');
  await page.getByRole('button',{name:'执行与预约',exact:true}).click();await page.locator('#execution-dialog [data-view]').click();
  await expect(page.locator('#cam-cut-ticket-modal')).toBeVisible();pass('已报工执行单查看历史工单，不恢复可编辑预览');
  await page.goto(base+'/tasks.html?q='+encodeURIComponent(task.id));await expect(page.locator('#task-rows tr')).toHaveCount(1);await expect(page.locator('#task-rows tr')).toContainText(task.name);pass('真实任务汇总与管理页显示一致');
  assert.deepEqual(errors,[]);pass('浏览器无未捕获错误');
  console.log(JSON.stringify({executed:passed,passed,failed:0,skipped:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
