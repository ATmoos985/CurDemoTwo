// Run against an isolated server and inventory; this test confirms real reports.
const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE||'playwright/test');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base=process.env.BASE_URL;
if(!base || !process.env.CUT_TEST_ISOLATED || new URL(base).port==='8080')throw Error('Use a separate test server and CUT_TEST_ISOLATED=1; never the user inventory on 8080.');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const errors=[],passed=[];let page;
 fs.mkdirSync('target/garment-workflow',{recursive:true});
 try{
  for(const [style,count] of [['GARMENT_SHIRT',18],['GARMENT_PANTS',18],['GARMENT_SKIRT',14]]){
   const context=await browser.newContext({viewport:{width:1366,height:768}});page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   const rollId='TEST-'+style+'-'+Date.now(),model='服装流程验证-'+rollId;
   const roll=await page.request.post(base+'/api/rolls',{data:{rollId,rollModel:model,width:1500,rawWidth:1500,totalLength:30000,currentRemainingLength:30000,usedLength:0,inspectionStatus:'QUALIFIED',defects:[],storageLocation:'隔离测试库'}});
   assert.ok(roll.ok(),await roll.text());
   await page.goto(base+'/cutting.html');await expect(page).toHaveURL(/index.html$/);
   await expect(page.locator('iframe')).toHaveCount(0);
   await page.getByRole('button',{name:'新建任务',exact:true}).click();
   await expect(page.locator('#demand-manager')).toBeVisible();
   await page.selectOption('#garment-style',style);await page.click('#demand-manager-garment');
   await expect(page.locator('#demands-container .item-row')).not.toHaveCount(0);
   await page.selectOption('#task-material',model);
   await page.click('#demand-editor-save');
   await page.locator('#material-candidates input').first().check();await page.click('#material-load');
   const response=page.waitForResponse(r=>r.url().endsWith('/api/solve')&&r.request().method()==='POST',{timeout:120000});
   await page.click('#btn-trigger-solve-station');const solved=await (await response).json();
   assert.ok(solved.success,JSON.stringify(solved));assert.equal(solved.pieces.length,count);assert.ok(solved.planId);
   assert.ok(solved.pieces.every(p=>p.shape&&p.rotationDegrees===0));
   assert.equal(solved.cuts.length,solved.pieces.reduce((n,p)=>n+(p.shape.vertices?.length||4),0));
   assert.ok(solved.cuts.some(c=>c.startX!==c.endX&&c.startY!==c.endY),'oblique edges are real cuts');
   const before=await (await page.request.get(base+'/api/rolls/'+rollId)).json();assert.equal(before.currentRemainingLength,30000);
   const saved=await (await page.request.get(base+'/api/cutting/plans/'+solved.planId)).json();
   assert.equal(saved.request.demands.reduce((n,d)=>n+d.demand,0),count);assert.ok(saved.request.demands.every(d=>d.shape));
   await page.screenshot({path:'target/garment-workflow/'+style+'.png'});
   const canvas=await page.evaluate(async()=>{const {mainLayer}=await import('/js/plugins/cad/cad-stage.js');return mainLayer.find('Line').filter(n=>n.closed()).length;});
   assert.ok(canvas>=count,'workbench draws true closed polygons');
   const marks=await page.evaluate(async()=>{const {annotationLayer}=await import('/js/plugins/cad/cad-stage.js');return {badges:annotationLayer.find('Circle').filter(n=>n.radius()===9).length,text:annotationLayer.find('Text').map(n=>n.text()).join(' ')};});
   assert.ok(marks.badges<=1,'contour edge numbers do not cover the marker');assert.ok(!/\d\.\d{6}/.test(marks.text),'dimensions hide floating-point tails');
   const preview=await page.evaluate(async()=>{
    const {state}=await import('/js/core/state.js');
    const player=await import('/js/plugins/cut-player/cut-animator.js');
    const exporter=await import('/js/plugins/export/nc-dxf-exporter.js');
    player.stepCut(-999);const reset=state.currentCutStepLimit;
    player.stepCut(1);const first=state.currentCutStepLimit;
    player.stepCut(999);const all=state.currentCutStepLimit;
    const dxf=exporter.generateDXF(),nc=exporter.generateGCode();
    player.startContinuousSim();
    return {reset,first,all,dxfEdges:(dxf.match(/0\nLINE\n8\n1_PIECES\n/g)||[]).length,ncEdges:(nc.match(/G01 X/g)||[]).length};
   });
   assert.deepEqual(preview,{reset:0,first:1,all:solved.cuts.length,dxfEdges:solved.cuts.length,ncEdges:solved.cuts.length});
   await page.waitForFunction(async()=>{const {state}=await import('/js/core/state.js');return state.currentCutStepLimit>0;});
   await page.evaluate(async()=>{const p=await import('/js/plugins/cut-player/cut-animator.js');p.pauseContinuousSim();p.stepCut(999);});
   assert.equal((await (await page.request.get(base+'/api/rolls/'+rollId)).json()).currentRemainingLength,30000);
   if(style==='GARMENT_SHIRT'){await page.setViewportSize({width:1920,height:1080});await page.screenshot({path:'target/garment-workflow/shirt-desktop.png'});}
   await page.click('#btn-stage-advance');
   await expect(page.locator('#btn-batch-report')).toBeVisible({timeout:15000});
   await page.click('#btn-batch-report');await expect(page.locator('#batch-report-dialog')).toBeVisible();
   await page.locator('#batch-report-dialog [data-confirm]').click();
   await expect(page.locator('#batch-report-dialog')).not.toBeVisible({timeout:15000});
   const detail=await (await page.request.get(base+'/api/cutting/plans/'+solved.planId)).json();
   assert.equal(detail.status,'CONFIRMED');assert.equal(detail.receipt.finishedPieceCount,count);
   assert.ok(Math.abs(detail.receipt.pieceArea-solved.pieceArea)<1e-8);
   assert.ok(detail.receipt.pieceResults.every(p=>p.shape));
   const after=await (await page.request.get(base+'/api/rolls/'+rollId)).json();
   assert.ok(Math.abs(after.currentRemainingLength-(30000-detail.receipt.actualCutLen))<.001);
   await page.reload();await expect(page.locator('#task-report-count')).toHaveText('1');
   const restored=await page.evaluate(async()=>{const {state}=await import('/js/core/state.js');return state.getCurrentCaseData().pieces.filter(p=>p.confirmed);});
   assert.equal(restored.length,count);assert.ok(restored.every(p=>p.shape));
   passed.push(style+': demand → material → real nesting → closed cuts → batch report → reload');
   await context.close();
  }
  assert.deepEqual(errors,[]);passed.push('no browser script errors');
  console.log(JSON.stringify({tests:passed.length,passed:passed.length,failed:0,skipped:0,checks:passed},null,2));
 }catch(error){if(page&&!page.isClosed()){await page.screenshot({path:'target/garment-workflow/failure.png'});console.error((await page.locator('body').innerText()).slice(-5000));}throw error;}
 finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
