// Run against an isolated Spring Boot instance with its own cutdemo.state.path.
// BASE_URL must be explicit. Never point this fixture at the user's workbench.
const assert = require('node:assert/strict');
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
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
        await load();
        for (const [width,height] of [[920,678],[1366,768],[1878,1244],[1920,1080],[2183,1244]]) {
            await page.setViewportSize({width,height});
            const material=await page.locator('#material-context').boundingBox(), demands=await page.locator('#card-demands').boundingBox();
            assert.ok(material.y+material.height<=demands.y+1);
            const label=await page.locator('.task-context > span').boundingBox(), name=await page.locator('#current-task-name').boundingBox();
            assert.ok(name.x>label.x+label.width && Math.abs(name.y-label.y)<10);
            assert.equal(await page.locator('.canvas-nav-toolbar #station-navigation-group button svg').count(),5);
            assert.equal(await page.locator('.canvas-heading #station-navigation-group').count(),0);
            const feed=await page.locator('.radar-feed-controls').boundingBox(), nav=await page.locator('#station-navigation-group').boundingBox();
            assert.ok(feed.x+feed.width<=nav.x && Math.abs(feed.y+feed.height/2-nav.y-nav.height/2)<2);
            await expect(page.locator('.cad-tools #radar-roll-info')).toContainText('幅宽 2,000 mm');
            assert.equal(await page.locator('#radar-roll-info').evaluate(el=>getComputedStyle(el).whiteSpace),'nowrap');
            assert.equal(await page.locator('#sb-roll-id, #sb-source-label, .status-details, #cad-view-caption').count(),0);
            assert.equal(await page.locator('.workbench-status').evaluate(el=>el.offsetHeight),32);
            const statusRows=await page.locator('.workbench-status > span').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top));
            assert.ok(Math.max(...statusRows)-Math.min(...statusRows)<2);
            await expect(page.locator('#btn-radar-reset')).toBeHidden();
            if(width>960) {
                await expect(page.locator('.workbench-status')).toBeInViewport({ratio:1});
                await expect(page.locator('#material-context')).toBeInViewport({ratio:1});
            }
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        }
        await page.setViewportSize({width:1366,height:768});
        pass('feed controls precede navigation, material statistics use the canvas toolbar, and footer stays one row at five screen sizes');
        await page.locator('#btn-measure-tool').click();
        await expect(page.locator('#radar-roll-info')).toBeHidden();
        await expect(page.locator('#cad-tool-hint')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#radar-roll-info')).toBeVisible();
        await expect(page.locator('#cad-tool-hint')).toBeHidden();
        await page.locator('#btn-station-next').click();
        await expect(page.locator('#radar-window-text')).toContainText('1,500–3,000 mm');
        await page.locator('#btn-station-prev').click();
        await expect(page.locator('#radar-window-text')).toContainText('0–1,500 mm');
        await page.locator('#btn-station-smart').click();
        await expect(page.locator('#radar-window-text')).toContainText('1,500–3,000 mm');
        await page.locator('#btn-station-prev').click();
        await page.locator('#btn-view-roll').click();const fullScale=await page.locator('#sb-scale').textContent();
        await page.locator('#btn-view-station').click();assert.notEqual(await page.locator('#sb-scale').textContent(),fullScale);
        assert.equal((await api('/api/rolls/'+rollId)).usedLength,0);
        for (const [corner,label,x,y] of [['left-top','左上','0','25.5'],['right-top','右上','2,000','25.5'],['left-bottom','左下','0','1,474.5'],['right-bottom','右下','2,000','1,474.5']]) {
            await page.evaluate(async corner=>{const data=window.testState.getCurrentCaseData();data.cutOrigin=corner;data.trimStart=25.5;(await import('/js/plugins/solver/solver-client.js')).updateUIInfo();},corner);
            await expect(page.locator('#sb-origin-lbl')).toHaveText(`切割基准 ${label} · 母卷 X ${x} / Y ${y} mm`);
        }
        await page.evaluate(async()=>{const data=window.testState.getCurrentCaseData();data.trimStart=0;(await import('/js/plugins/solver/solver-client.js')).updateUIInfo();(await import('/js/plugins/cad/cad-renderer.js')).renderScene();});
        pass('navigation keeps stock unchanged and footer origins share the drawing coordinates including fractional trim');
        await page.evaluate(()=>window.showToast('顶部居中提示验证','info',30000));
        const toast=await page.locator('#cad-toast-container').boundingBox();
        assert.ok(toast.y<20 && Math.abs(toast.x+toast.width/2-683)<2);
        await page.locator('#cad-toast-container button').click();
        pass('messages appear at the top center and remain dismissible');
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png','-layout.png')});
        await solve();
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
        const reportWrites=commits;
        await page.locator('[data-workflow-stage="3"]').click();
        await expect(page.locator('#task-picker[data-kind="reports"]')).toBeVisible();
        assert.equal(await page.locator('.report-list-item').count(),3);
        const info=await page.locator('.report-list-info').first().boundingBox(), actions=await page.locator('.report-list-actions').first().boundingBox();
        assert.ok(actions.x>=info.x+info.width && Math.abs(actions.y-info.y)<2);
        assert.ok((await page.locator('#task-picker').boundingBox()).width>=1000);
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png','-reports.png')});
        await page.locator('.report-list-actions').first().getByRole('button',{name:'查看 / 打印工单'}).click();
        await expect(page.locator('#cam-cut-ticket-modal')).toBeVisible();
        await expect(page.locator('#printable-cut-ticket-area')).toContainText('已报工');
        await page.locator('#cam-cut-ticket-modal [data-close]').click();
        await page.locator('.report-list-actions').first().getByRole('button',{name:'撤回报工'}).click();
        await expect(page.getByRole('heading',{name:'撤回本次报工'})).toBeVisible();
        await page.getByRole('button',{name:'取消',exact:true}).click();
        assert.equal(commits,reportWrites);assert.equal((await api('/api/cutting/tasks/'+task.id)).reports.length,3);
        await page.locator('#task-picker .workflow-dialog-heading button').click();
        pass('report stage opens wider history with information left and print/reverse actions right; cancellation keeps receipts');
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
        await expect(page.locator('#sb-origin-lbl')).toContainText('料头 X');
        await expect(page.locator('#radar-window-text')).toContainText('料头区域');
        await expect(page.locator('#radar-roll-info')).toContainText(remnant.id);
        await expect(page.locator('#btn-view-station')).toBeVisible();
        await expect(page.locator('#btn-view-roll')).toBeVisible();
        await expect(page.locator('#btn-station-next')).toBeHidden();
        pass('remnant coordinates are local and sheet view controls stay accessible');
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
        await page.locator('[data-workflow-stage="3"]').click();
        await page.locator('.report-list-actions').getByRole('button',{name:'撤回报工'}).click();
        await page.locator('.action-dialog textarea').fill('验证报工列表撤回入口');
        await page.getByRole('button',{name:'确认撤回',exact:true}).click();
        await expect(page.locator('.report-list-info')).toContainText('已撤回');
        await expect(page.locator('.report-list-actions').getByRole('button',{name:'撤回报工'})).toHaveCount(0);
        assert.equal((await api('/api/cutting/tasks/'+sheetTask.id)).completed['1'] || 0,0);
        pass('right-side reversal still releases completed demand and preserves the historical receipt');
        assert.deepEqual(errors,[]);
        console.log('Browser tests: '+passed+' executed, '+passed+' passed, 0 failed, 0 skipped.');
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
