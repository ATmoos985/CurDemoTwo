// Writes only to an explicitly isolated test service.
const assert = require('node:assert/strict');
const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base=process.env.BASE_URL;
if (!base || new URL(base).port==='8080') throw new Error('Use an isolated test service, never port 8080.');
async function api(path,body,status=200){const res=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const json=await res.json();assert.equal(res.status,status,JSON.stringify(json));return json;}
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});let passed=0;
 const pass=name=>{passed++;console.log('PASS '+name);};
 try {
  const page=await browser.newPage({viewport:{width:1366,height:768}}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR:',e.message);});
  const stamp=Date.now(),rollId='QUALITY-'+stamp,model='复检材料-'+stamp;
  await api('/api/rolls',{rollId,rollModel:model,width:2000,totalLength:20000,storageLocation:'验证库位',defects:[]});
  const task=await api('/api/cutting/tasks',{name:'良品复检验证',materialModel:model,revision:0,demands:[{id:1,name:'裁片',width:2000,length:1000,quantity:10,allowRotation:false}],process:{bedLength:10000,trimStart:0,pieceGap:0,cutOrigin:'left-top',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false}});
  const plan=await api('/api/solve',{taskId:task.id,taskRevision:task.revision,rollId,rollModel:model,rollW:2000,rollL:10000,windowStartY:0,allowLongitudinal:false,cutOrigin:'left-top',demands:[{id:1,name:'裁片',width:2000,length:1000,demand:10,allowRotation:false}]});
  assert.equal(plan.pieces.length,10);
  const receipt=await api('/api/cutting/report-confirm',{planId:plan.planId,actualCutLen:10000,finishedPieceCount:10,actualRemnants:[],location:'A'});
  const original=JSON.stringify(receipt.pieceResults),path='/api/cutting/reports/'+plan.planId+'/quality-dispositions';
  await page.goto(base+'/index.html');await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(async id=>(await import('/js/business/cutting/task-workspace.js')).loadTask(id),task.id),true);
  const reports=async()=>page.evaluate(async()=>{await (await import('/js/business/cutting/task-workspace.js')).openTaskReports();});
  await reports();await page.getByRole('button',{name:'复检处置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'复检处置',exact:true});await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox',{name:/^裁片/}).selectOption('1');await dialog.getByLabel('检验人',{exact:true}).fill('甲');await dialog.getByLabel('复检原因',{exact:true}).fill('破损报废');
  const box=await dialog.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=768);
  await dialog.getByRole('button',{name:'确认处置',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('#task-picker-body')).toContainText('净良品 9 件（原报 10 件）');
  pass('report dialog scraps a good piece and exposes net vs original counts');
  await page.getByRole('button',{name:'复检处置',exact:true}).click();
  await dialog.getByRole('combobox',{name:/^裁片/}).selectOption('2');await dialog.getByLabel('处置方式').selectOption('REMNANT');
  await dialog.getByLabel('检验人',{exact:true}).fill('乙');await dialog.getByLabel('复检原因',{exact:true}).fill('局部破损回收');
  await dialog.getByLabel('宽度 / mm',{exact:true}).fill('500');await dialog.getByLabel('长度 / mm',{exact:true}).fill('500');await dialog.getByLabel('库位',{exact:true}).fill('隔离 B-01');
  await dialog.getByRole('button',{name:'确认处置',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('#task-picker-body')).toContainText('净良品 8 件（原报 10 件）');
  let review=await api(path),detail=await api('/api/cutting/tasks/'+task.id);
  assert.equal(detail.completed['1'],8);assert.equal(review.netFinishedPieceCount,8);assert.equal(review.netUtilization,80);assert.equal(JSON.stringify(review.pieceResults),original);
  const roll=(await api('/api/rolls')).find(r=>r.rollId===rollId);assert.equal(roll.currentRemainingLength,10000);assert.equal(roll.usedLength,10000);
  const event=review.qualityDispositions[1];assert.equal(event.recoveredAreaMm2,250000);assert.equal(review.netRemArea,.25);
  assert.equal((await api('/api/remnants')).filter(r=>r.id===event.remnantId).length,0);
  assert.equal((await api('/api/remnants?includeQuarantined=true')).find(r=>r.id===event.remnantId).status,'QUARANTINED');
  pass('ten good become eight; recovered stock is isolated, consumed material stays fixed');
  assert.deepEqual(await api(path,event.command),event);
  await api(path,{...event.command,reason:'换内容'},409);
  await api(path,{...event.command,operationId:crypto.randomUUID(),expectedRevision:2},409);
  await api(path,{...event.command,operationId:crypto.randomUUID(),pieceId:3,expectedRevision:0},409);
  await api('/api/cutting/reports/'+plan.planId+'/reverse',{reason:'错误撤回'},400);
  await api(path,{...event.command,pieceId:1.5},400);
  await expect(page.getByRole('button',{name:'撤回报工',exact:true})).toBeDisabled();
  pass('HTTP idempotency, stale versions, strict input and reversal protection');
  // Simulate response loss AFTER the server commits. Retry must reuse the same command.
  await page.getByRole('button',{name:'复检处置',exact:true}).click();
  await dialog.getByRole('combobox',{name:/^裁片/}).selectOption('3');await dialog.getByLabel('检验人',{exact:true}).fill('丙');await dialog.getByLabel('复检原因',{exact:true}).fill('响应丢失验证');
  let intercepted;
  await page.route('**'+path,async route=>{intercepted=route.request().postDataJSON();await api(path,intercepted);await route.abort('failed');},{times:1});
  await dialog.getByRole('button',{name:'确认处置',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'重试同一处置',exact:true})).toBeEnabled();
  await expect(dialog.getByLabel('复检原因',{exact:true})).toBeDisabled();await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'重试同一处置',exact:true}).click();await expect(dialog).toHaveCount(0);
  review=await api(path);assert.equal(review.qualityRevision,3);assert.equal(review.netFinishedPieceCount,7);assert.equal(review.qualityDispositions[2].command.operationId,intercepted.operationId);
  pass('lost response retries exactly once without double stock or demand deduction');
  await page.locator('#task-picker').getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();await page.waitForLoadState('networkidle');await reports();await expect(page.locator('#task-picker-body')).toContainText('净良品 7 件（原报 10 件）');
  const printed=await page.evaluate(async id=>{const plan=await (await fetch('/api/cutting/plans/'+id)).json();const m=await import('/js/plugins/export/cut-ticket-model.js');return m.ticketHTML(m.ticketModel(plan,true));},plan.planId);
  assert.match(printed,/当前净良品 7 件/);assert.match(printed,/原始报工结果/);assert.match(printed,/响应丢失验证/);
  pass('reload and printable work order preserve original results with quality trail');
  // Screenshots cover the actual modal at both workshop sizes.
  await page.getByRole('button',{name:'复检处置',exact:true}).click();await dialog.getByLabel('处置方式').selectOption('REMNANT');
  for(const [w,h] of [[1366,768],[1920,1080]]){await page.setViewportSize({width:w,height:h});const b=await dialog.boundingBox();assert.ok(b.y>=0&&b.y+b.height<=h);await dialog.getByRole('button',{name:'确认处置',exact:true}).scrollIntoViewIfNeeded();await expect(dialog.getByRole('button',{name:'确认处置',exact:true})).toBeInViewport();await page.screenshot({path:`/tmp/cutdemo-quality-${w}.png`});}
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);pass('keyboard dismissal and recovery form fit 1366 and 1920 layouts');
  await page.goto(base+'/inventory.html#remnants');await page.waitForLoadState('networkidle');
  await page.locator('[data-remnant="'+event.remnantId+'"]').click();await expect(page.locator('#material-remnant-detail-panel')).toContainText('待检隔离（不能选料）');
  await page.locator('#material-remnant-detail-panel').getByText('来源与流转',{exact:true}).click();await expect(page.locator('#material-remnant-detail-panel')).toContainText(plan.planId);
  await expect(page.locator('#material-remnant-detail-panel')).toContainText(event.id);assert.equal(errors.length,0,errors.join('\n'));
  pass('inventory exposes isolated stock and piece/report lineage without page errors');
  console.log(`Executed ${passed}; passed ${passed}; failed 0`);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
