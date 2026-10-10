// Run against an isolated Spring Boot instance with its own cutdemo.state.path.
// BASE_URL must be explicit. Never point this fixture at the user's workbench.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
if (!base || new URL(base).port === '8080') throw new Error('Use an isolated test service on a port other than 8080.');
async function api(path,body) {
    const response = await fetch(base+path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
    const result = await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
(async () => {
    const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0;
    const pass = name => {passed++;console.log('PASS '+name);};
    try {
        const page = await browser.newPage({viewport:{width:1366,height:768}}), errors = [];
        page.on('pageerror',e => errors.push(e.message));
        const suffix=Date.now(), model='连续裁切验证-'+suffix, rollId='FLOW-'+suffix;
        await api('/api/rolls',{rollId,rollModel:model,width:2000,totalLength:12000,storageLocation:'验证库位',defects:[]});
        const task=await api('/api/cutting/tasks',{name:'连续三工位验证',materialModel:model,revision:0,
            demands:[{id:1,name:'验证裁片',width:2000,length:1000,quantity:3,allowRotation:false}],
            process:{bedLength:1500,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false}});
        await page.goto(base);await page.waitForLoadState('networkidle');
        await page.evaluate(async()=>{window.testState=(await import('/js/core/state.js')).state;});
        const load=async()=>assert.equal(await page.evaluate(async id=>(await import('/js/plugins/solver/task-workspace.js')).loadTask(id),task.id),true);
        const snapshot=()=>page.evaluate(async()=>{const {state}=await import('/js/core/state.js');return {pending:state.pendingPlan,queue:state.reportQueue,data:state.getCurrentCaseData(),completed:state.taskCompleted};});
        const solve=async()=>{
            await page.locator('#btn-trigger-solve-station').click();
            await page.waitForFunction(()=>!!window.testState.pendingPlan?.result?.planId && !document.querySelector('#btn-stage-advance').disabled);
            assert.equal(await page.locator('.workflow-primary:visible').count(),1);
        };
        const waitQueue=length=>page.waitForFunction(length=>window.testState.reportQueue.length===length&&!document.body.inert,length);
        await load();await solve();
        const initial=(await snapshot()).pending.result.planId;
        await page.route('**/api/cutting/report-batch?preview=true',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({message:'验证库存冲突'})}));
        await page.locator('#btn-stage-advance').click();await page.waitForFunction(()=>!document.body.inert);
        assert.equal((await snapshot()).pending.result.planId,initial);assert.equal((await snapshot()).queue.length,0);
        await page.unroute('**/api/cutting/report-batch?preview=true');
        pass('server rejection keeps the current station and queue');
        await page.evaluate(()=>{window.savedSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('cutting-report-queue-'))throw new Error('full');return window.savedSetItem.call(this,key,value);};});
        await page.locator('#btn-stage-advance').click();await page.waitForFunction(()=>!document.body.inert);
        assert.equal((await snapshot()).pending.result.planId,initial);assert.equal((await snapshot()).queue.length,0);
        await page.evaluate(()=>{Storage.prototype.setItem=window.savedSetItem;});
        pass('local storage failure keeps the current station');
        for(let index=0;index<2;index++) {

            const before=await snapshot(), plan=before.pending;
            await page.locator('#btn-stage-advance').click();await waitQueue(index+1);
            await page.waitForFunction(()=>!!window.testState.pendingPlan && !document.querySelector('#btn-stage-advance').disabled);
            const after=await snapshot(), row=after.queue.at(-1);
            assert.equal(await page.locator('dialog[open]').count(),0);
            assert.equal(row.report.finishedPieceCount,1);
            assert.ok(row.report.actualRemnants.length>0,'direct recording must include planned remnants');
            assert.equal(after.data.windowStartY,plan.windowStartY+row.report.actualCutLen);
            const pieces=after.data.pieces.filter(p=>p.planId===plan.result.planId);
            assert.ok(pieces.every(p=>p.queued));
            assert.equal(after.pending.windowStartY,after.data.windowStartY);
            assert.deepEqual(pieces.map(p=>({id:p.id,sourcePieceId:p.sourcePieceId,y:p.y})),before.data.pieces.filter(p=>p.planId===plan.result.planId).map(p=>({id:p.id,sourcePieceId:p.sourcePieceId,y:p.y})));
            assert.equal(new Set(after.data.pieces.map(p=>p.id)).size,after.data.pieces.length);
            assert.equal((await api('/api/rolls/'+rollId)).usedLength,0);
            assert.equal((await api('/api/cutting/tasks/'+task.id)).reports.length,0);
        }
        assert.equal(await page.locator('#station-work-orders-list details').count(),2);
        pass('two stations continue without dialogs, preserve global geometry and leave inventory unreported');
        // After two iterations the next station is a preview; queue entries survive a reload.
        await page.reload();await page.waitForLoadState('networkidle');
        await page.evaluate(async()=>{window.testState=(await import('/js/core/state.js')).state;});
        assert.equal((await snapshot()).queue.length,2);
        assert.equal(await page.locator('#station-work-orders-list details').count(),2);
        await page.locator('#station-work-orders-list summary').first().click();
        await page.locator('#station-work-orders-list button').first().click();
        await page.locator('#cam-cut-ticket-modal').waitFor({state:'visible'});
        assert.match(await page.locator('#ticket-no-val').textContent(),/^WO-/);
        await page.locator('#cam-cut-ticket-modal [data-close]').click();
        if(await page.locator('#btn-workflow-next').isVisible())await page.locator('#btn-workflow-next').click();
        pass('refresh restores pending work orders and each station opens its own ticket');
        await solve();
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png','-ready.png')});
        await page.locator('#btn-batch-report').click();await waitQueue(3);
        await page.locator('#batch-report-dialog').waitFor({state:'visible'});
        assert.equal(await page.locator('#cut-report-modal').isVisible(),false);
        assert.equal(await page.locator('#batch-report-dialog article').count(),3);
        assert.equal(await page.locator('#batch-report-dialog [data-confirm-one]').count(),0);
        const queued=(await snapshot()).queue, totalLength=queued.reduce((n,r)=>n+r.report.actualCutLen,0);
        await page.route('**/api/cutting/report-batch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({message:'验证提交失败'})}));
        await page.locator('#batch-report-dialog [data-confirm]').click();await page.waitForFunction(()=>!document.body.inert);
        assert.equal((await snapshot()).queue.length,3);assert.equal((await api('/api/rolls/'+rollId)).usedLength,0);
        await page.unroute('**/api/cutting/report-batch');
        pass('final report includes the current station and failed submission retains every pending work order');
        let commits=0;page.on('request',request=>{if(request.url()===base+'/api/cutting/report-batch'&&request.method()==='POST')commits++;});
        await page.locator('#batch-report-dialog [data-confirm]').click();
        await page.waitForFunction(()=>!document.querySelector('#batch-report-dialog').open&&!document.body.inert);
        const detail=await api('/api/cutting/tasks/'+task.id);
        assert.equal(commits,1);assert.equal(detail.reports.length,3);assert.equal(detail.completed['1'],3);
        assert.equal((await api('/api/rolls/'+rollId)).usedLength,totalLength);
        assert.equal(detail.reports.reduce((n,r)=>n+r.derivedRemnants.length,0),queued.reduce((n,r)=>n+r.report.actualRemnants.length,0));
        assert.equal((await snapshot()).queue.length,0);
        assert.match(await page.locator('#station-work-orders-count').textContent(),/0 待报 · 3 已报/);
        pass('one final batch commits three stations, qualified counts, stock deduction and recovered remnants exactly once');
        for(const width of [920,1366,1920]) {
            await page.setViewportSize({width,height:width===920?678:900});
            assert.equal(await page.locator('.workflow-primary:visible').count(),1);
            assert.equal(await page.getByRole('button',{name:'打印工单',exact:true}).count(),1);
            assert.equal(await page.locator('.header-more > summary').count(),1);
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        }
        pass('one primary action and no duplicate global print/tools buttons at 920, 1366 and 1920 widths');
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});
        const remnant=detail.reports[0].derivedRemnants[0];
        const sheetTask=await api('/api/cutting/tasks',{name:'连续裁切料头验证',materialModel:model,revision:0,
            demands:[{id:1,name:'短片',width:2000,length:250,quantity:1,allowRotation:false}],
            process:{bedLength:500,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false}});
        await page.evaluate(async ({taskId,stockId})=>{
            await (await import('/js/plugins/solver/task-workspace.js')).loadTask(taskId);
            const stock=await fetch('/api/remnants/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:stockId})}).then(r=>r.json());
            await (await import('/js/plugins/remnant/remnant-shelf.js')).switchCutMode('remnant',stock);
        },{taskId:sheetTask.id,stockId:remnant.id});
        await solve();await page.locator('#btn-stage-advance').click();await waitQueue(1);
        assert.equal((await snapshot()).pending,null);
        assert.deepEqual((await snapshot()).queue[0].report.actualRemnants,[]);
        assert.equal(await page.locator('#btn-workflow-next').isVisible(),false);
        assert.equal(await page.locator('.workflow-primary:visible').getAttribute('id'),'btn-batch-report');
        assert.equal(await page.locator('dialog[open]').count(),0);
        await page.locator('#btn-batch-report').click();await page.locator('#batch-report-dialog [data-confirm]').click();
        await page.waitForFunction(()=>!document.querySelector('#batch-report-dialog').open&&!document.body.inert);
        const sheetDetail=await api('/api/cutting/tasks/'+sheetTask.id);
        assert.equal(sheetDetail.completed['1'],1);assert.equal(sheetDetail.reports[0].actualCutLen,0);
        assert.deepEqual(sheetDetail.reports[0].derivedRemnants,[]);
        assert.equal((await api('/api/rolls/'+rollId)).usedLength,totalLength);
        pass('last station offers only one report entry and a used remnant produces no child stock');
        assert.deepEqual(errors,[]);
        console.log('Browser tests: '+passed+' executed, '+passed+' passed, 0 failed, 0 skipped.');
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
