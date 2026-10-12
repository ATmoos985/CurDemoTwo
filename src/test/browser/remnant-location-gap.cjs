// Use an isolated service and disposable fixtures, never the user's workbench.
const assert=require('node:assert/strict');
const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base=process.env.BASE_URL;
if(!base || new URL(base).port==='8080')throw Error('Use an isolated service outside port 8080.');
async function api(path,body) {
    const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;
}
(async()=>{
    const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
    let passed=0;const pass=text=>{passed++;console.log('PASS '+text);};
    try {
        const page=await browser.newPage({viewport:{width:1366,height:768}}), errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        const suffix=Date.now(),rollId='GAP-'+suffix,model='间距验证-'+suffix;
        await api('/api/rolls',{rollId,rollModel:model,width:1400,totalLength:10000,storageLocation:'验证',defects:[]});
        const task=await api('/api/cutting/tasks',{name:'料头定位与间距验证',materialModel:model,revision:0,
            demands:[{id:1,name:'保留原规格',width:490,length:600,quantity:8,allowRotation:false}],
            process:{bedLength:1220,trimStart:0,pieceGap:10.5,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:true}});
        await page.goto(base);await page.waitForLoadState('networkidle');
        await page.evaluate(async id=>{window.s=(await import('/js/core/state.js')).state;return (await import('/js/plugins/solver/task-workspace.js')).loadTask(id);},task.id);
        await expect(page.locator('#inp-piece-gap')).toHaveValue('10.5');
        await page.locator('#card-bed-origin .section-toggle').click();
        await page.locator('#inp-piece-gap').fill('100.5');await page.locator('#inp-piece-gap').press('Tab');
        await expect(page.locator('#workflow-current')).toHaveText('核对裁片间距');
        await page.locator('#inp-piece-gap').fill('10.5');await page.locator('#inp-piece-gap').press('Tab');
        await page.locator('#btn-trigger-solve-station').click();
        await page.waitForFunction(()=>!!window.s.pendingPlan?.result?.planId);
        const before=await page.evaluate(()=>({pending:s.pendingPlan,queue:s.reportQueue,data:s.getCurrentCaseData()}));
        assert.equal(before.pending.request.pieceGap,10.5);assert.equal(before.pending.result.pieces.length,4);
        assert.ok(before.pending.result.pieces.every(p=>p.w===490 && p.l===600));
        assert.equal((await api('/api/cutting/tasks/'+task.id)).task.process.pieceGap,10.5);
        pass('gap input validates, persists on the task and reaches the solver without changing finished dimensions');
        const locate=async phase=>{
            await page.locator('#btn-open-remnants').click();await page.locator('#remnant-modal').waitFor({state:'visible'});
            const target=await page.evaluate(phase=>s.getCurrentCaseData().remnants.find(r=>phase==='queued'?r.queued:phase==='reported'?r.confirmed:!r.queued&&!r.confirmed),phase);
            assert.ok(target,phase+' remnant must exist');
            const snapshot=await page.evaluate(()=>JSON.stringify([s.pendingPlan,s.reportQueue,s.getCurrentCaseData().windowStartY]));
            const row=page.locator('#remnant-table-body tr').filter({has:page.locator('[data-locate]')});
            const ids=await row.evaluateAll(rows=>rows.map(r=>r.dataset.remnantId));
            const index=ids.indexOf(target.id);assert.ok(index>=0);
            if(phase==='reported')await row.nth(index).locator('button').press('Enter');
            else await row.nth(index).locator('td').first().click();
            await expect(page.locator('#remnant-modal')).not.toBeVisible();
            await page.waitForFunction(async id=>{const {stage}=await import('/js/plugins/cad/cad-stage.js');const r=s.getCurrentCaseData().remnants.find(r=>r.id===id);const k=stage.scaleX();return s.selectedRemnantId===id && r.x*k+stage.x()>=50 && (r.x+r.w)*k+stage.x()<=stage.width()-50 && r.y*k+stage.y()>=60 && (r.y+r.l)*k+stage.y()<=stage.height()-60;},target.id);
            assert.equal(await page.evaluate(()=>JSON.stringify([s.pendingPlan,s.reportQueue,s.getCurrentCaseData().windowStartY])),snapshot);
            assert.equal(await page.evaluate(async()=>{const {remnantHighlightGroup}=await import('/js/plugins/cad/cad-stage.js');return remnantHighlightGroup.getChildren().length;}),1);
        };
        await locate('expected');pass('clicking a preview row closes the modal and fits the complete remnant without changing the cutting station');
        await page.locator('#btn-stage-advance').click();
        await page.waitForFunction(()=>s.reportQueue.length===1&&!!s.pendingPlan&&!document.body.inert);
        await locate('queued');pass('queued remnant rows locate their station-specific canvas geometry');
        await page.locator('#btn-batch-report').click();await page.locator('#batch-report-dialog').waitFor({state:'visible'});
        await page.locator('#batch-report-dialog [data-confirm]').click();
        await page.waitForFunction(()=>!document.querySelector('#batch-report-dialog').open&&!document.body.inert);
        assert.equal((await api('/api/cutting/tasks/'+task.id)).completed['1'],8);
        await page.reload();await page.waitForLoadState('networkidle');await page.evaluate(async()=>window.s=(await import('/js/core/state.js')).state);
        await expect(page.locator('#inp-piece-gap')).toHaveValue('10.5');
        await locate('reported');pass('confirmed output remains keyboard-locatable after reload and reports eight original-size pieces');
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});
        assert.deepEqual(errors,[]);pass('no browser errors');
        console.log(`Browser tests: ${passed} executed, ${passed} passed, 0 failed, 0 skipped.`);
    } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
