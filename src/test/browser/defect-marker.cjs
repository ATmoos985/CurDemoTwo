// Use an isolated service: this fixture writes test mother-roll defects.
const assert = require('node:assert/strict');
const {chromium,expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL;
if (!base || new URL(base).port === '8080') throw new Error('Use an isolated test service, not port 8080.');
async function api(path,body) {
    const response = await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    const result = await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
(async()=>{
    const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    let passed=0;const pass=name=>{passed++;console.log('PASS '+name);};
    try {
        const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        const id='MARK-'+Date.now();
        await api('/api/rolls',{rollId:id,rollModel:id,width:2000,totalLength:30000,defects:[]});
        const task=await api('/api/cutting/tasks',{name:'画布疵点验证',materialModel:id,revision:0,
            demands:[{id:1,name:'验证裁片',width:2000,length:1000,quantity:3,allowRotation:false}],
            process:{bedLength:4000,trimStart:25.5,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false}});
        await page.goto(base);await page.waitForLoadState('networkidle');
        await page.evaluate(async id=>{
            window.testState=(await import('/js/core/state.js')).state;
            window.testStage=await import('/js/plugins/cad/cad-stage.js');
            await(await import('/js/plugins/solver/task-workspace.js')).loadTask(id);
        },task.id);
        const move=async point=>{
            const screen=await page.evaluate(point=>{const s=window.testStage.stage,r=s.container().getBoundingClientRect();return{x:r.x+s.x()+point.x*s.scaleX(),y:r.y+s.y()+point.y*s.scaleY()};},point);
            await page.mouse.move(screen.x,screen.y);
            return page.evaluate(async()=>{
                const s=window.testStage.stage,p=s.getPointerPosition();
                const point={x:Number(((p.x-s.x())/s.scaleX()).toFixed(1)),y:Number(((p.y-s.y())/s.scaleY()).toFixed(1))};
                const local=(await import('/js/plugins/cad/cad-view.js')).stationCoordinates(point.x,point.y,window.testState.getCurrentCaseData());
                return {point,local};
            });
        };
        for(const cutOrigin of ['left-top','right-top','left-bottom','right-bottom']) {
            const point=await page.evaluate(async cutOrigin=>{
                const data=window.testState.getCurrentCaseData();Object.assign(data,{cutOrigin,windowStartY:10000});
                const renderer=await import('/js/plugins/cad/cad-renderer.js');
                (await import('/js/plugins/solver/solver-client.js')).updateUIInfo();
                renderer.renderScene();renderer.resetToBedView();
                const origin=(await import('/js/plugins/cad/cad-view.js')).stationOrigin(data);
                return {x:origin.x+origin.dx*375.4,y:origin.y+origin.dy*800.6};
            },cutOrigin);
            await page.locator('#btn-defect-tool').click();
            let moved;
            for (const target of [point, {x:point.x+(cutOrigin.startsWith('right')?-70:70), y:point.y+(cutOrigin.endsWith('bottom')?-120:120)}]) {
                moved=await move(target);
                await expect(page.locator('#cad-defect-distance-x')).toHaveText(`距${cutOrigin.startsWith('right')?'右':'左'} ${moved.local.x.toFixed(1)} mm`);
                await expect(page.locator('#cad-defect-distance-y')).toHaveText(`距${cutOrigin.endsWith('bottom')?'下':'上'} ${moved.local.y.toFixed(1)} mm`);
                const geometry=await page.evaluate(async()=>{
                    const stage=window.testStage.stage;
                    return {x:stage.findOne('.defect-distance-x').points(),y:stage.findOne('.defect-distance-y').points(),
                        origin:(await import('/js/plugins/cad/cad-view.js')).stationOrigin(window.testState.getCurrentCaseData())};
                });
                assert.deepEqual(geometry.x,[moved.point.x,moved.point.y,geometry.origin.x,moved.point.y]);
                assert.deepEqual(geometry.y,[moved.point.x,moved.point.y,moved.point.x,geometry.origin.y]);
                for (const label of ['x','y']) {
                    const box=await page.locator('#cad-defect-distance-'+label).boundingBox();
                    assert.ok(box.x>=0 && box.x+box.width<=1366 && box.height<=24);
                }
            }
            const {local}=moved;
            await page.mouse.down();await page.mouse.up();
            await expect(page.locator('#cad-defect-dialog')).toBeVisible();
            await expect(page.locator('#cad-defect-position')).toContainText(`横向 X ${local.x.toFixed(1)} mm`);
            await page.locator('#cad-defect-dialog [data-cancel]').click();
        }
        assert.equal((await api('/api/rolls/'+id)).defects.length,0);
        pass('four origins and a moved station show accurate center distances; cancelling never saves');
        await page.locator('#btn-defect-tool').click();
        await move({x:1000,y:12000});
        await page.locator('[aria-label="放大画布"]').click();
        const zoomed=await move({x:1000,y:12000});
        await expect(page.locator('#cad-defect-distance-x')).toHaveText(`距右 ${zoomed.local.x.toFixed(1)} mm`);
        await page.locator('#btn-measure-tool').click();
        await expect(page.locator('#btn-defect-tool')).toHaveAttribute('aria-pressed','false');
        await expect(page.locator('#cad-defect-distance-x')).toBeHidden();
        await expect(page.locator('#cad-defect-distance-y')).toBeHidden();
        await page.locator('#btn-defect-tool').click();
        await expect(page.locator('#btn-measure-tool')).toHaveAttribute('aria-pressed','false');
        await page.keyboard.press('Escape');
        assert.deepEqual(await page.evaluate(()=>[window.testStage.stage.draggable(),window.testStage.mainLayer.listening()]),[true,true]);
        pass('zoom keeps coordinates correct; measurement and marking exclude each other; Escape restores interaction');
        const previousGeometry=await page.evaluate(()=>{
            const data=window.testState.getCurrentCaseData();
            const previous=Object.fromEntries(['rollW','totalRollL','bedL','windowStartY','trimStart'].map(key=>[key,data[key]]));
            Object.assign(data,{rollW:2800,totalRollL:100000,bedL:10630,windowStartY:17130,trimStart:0});
            return previous;
        });
        for (const viewport of [{width:1366,height:768},{width:1920,height:1080}]) {
            await page.setViewportSize(viewport);
            await page.evaluate(async()=>{const r=await import('/js/plugins/cad/cad-renderer.js');r.renderScene();r.resetToBedView();});
            await page.locator('#btn-defect-tool').click();
            for (const point of [{x:1286.3,y:23612.6},{x:2795,y:27755}]) {
                const moved=await move(point);
                await expect(page.locator('#cad-defect-distance-x')).toHaveText(`距右 ${moved.local.x.toFixed(1)} mm`);
                await expect(page.locator('#cad-defect-distance-y')).toHaveText(`距下 ${moved.local.y.toFixed(1)} mm`);
                const h=await page.locator('#cad-defect-distance-x').boundingBox(),v=await page.locator('#cad-defect-distance-y').boundingBox();
                assert.ok(h.x+h.width<=v.x || v.x+v.width<=h.x || h.y+h.height<=v.y || v.y+v.height<=h.y,'dimension labels must not overlap');
                const canvas=await page.locator('#konva-container').boundingBox();
                for (const box of [h,v]) assert.ok(box.x>=canvas.x+28 && box.y>=canvas.y+28 && box.x+box.width<=canvas.x+canvas.width && box.y+box.height<=canvas.y+canvas.height);
                if (process.env.SCREENSHOT_PATH && point.x===1286.3)
                    await page.screenshot({path:process.env.SCREENSHOT_PATH.replace('.png',`-narrow-${viewport.width}.png`)});
            }
            await page.keyboard.press('Escape');
        }
        await page.evaluate(previous=>Object.assign(window.testState.getCurrentCaseData(),previous),previousGeometry);
        await page.setViewportSize({width:1366,height:900});
        await page.evaluate(async()=>{const r=await import('/js/plugins/cad/cad-renderer.js');r.renderScene();r.resetToBedView();});
        pass('long narrow rolls have readable, separate dimension labels at normal and near-zero distances in both desktop sizes');
        await page.locator('#btn-defect-tool').click();
        await move({x:-40,y:12000});await page.mouse.down();await page.mouse.up();
        await expect(page.locator('#cad-defect-dialog')).toBeHidden();
        await move({x:10,y:12000});await page.mouse.down();await page.mouse.up();
        await page.locator('#cad-defect-form [type=submit]').click();
        await expect(page.locator('#cad-defect-error')).toContainText('超出母卷');
        assert.equal((await api('/api/rolls/'+id)).defects.length,0);
        await page.keyboard.press('Escape');
        pass('blank canvas and out-of-bounds defect extents never write inventory');
        await page.locator('#btn-trigger-solve-station').click();
        await page.waitForFunction(()=>!!window.testState.pendingPlan?.result?.planId && !document.body.inert);
        const oldPlan=await page.evaluate(()=>window.testState.pendingPlan.result.planId);
        await page.locator('#btn-defect-tool').click();
        const marked=await move({x:1000.4,y:12000.6});
        if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});
        await page.mouse.down();await page.mouse.up();
        await page.locator('#cad-defect-form [name=width]').fill('120.2');
        await page.locator('#cad-defect-form [name=height]').fill('80.2');
        await page.locator('#cad-defect-form [name=margin]').fill('0');
        await page.route('**/api/rolls/*/defects',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'验证保存失败'})}));
        await page.locator('#cad-defect-form [type=submit]').click();
        await expect(page.locator('#cad-defect-error')).toHaveText('验证保存失败');
        assert.equal(await page.evaluate(()=>window.testState.pendingPlan.result.planId),oldPlan);
        assert.equal((await api('/api/rolls/'+id)).defects.length,0);
        await page.unroute('**/api/rolls/*/defects');
        pass('save rejection retains the form, preview and inventory');
        await page.locator('#cad-defect-form [type=submit]').click();
        await expect(page.locator('#cad-defect-dialog')).toBeHidden();
        const roll=await api('/api/rolls/'+id),defect=roll.defects[0];
        assert.equal(roll.defects.length,1);assert.equal(roll.usedLength,0);
        assert.ok(Math.abs(defect.x+defect.w/2-marked.point.x)<.001);
        assert.ok(Math.abs(defect.y+defect.h/2-marked.point.y)<.001);
        assert.equal(defect.margin,0);assert.equal(defect.detectionSource,'MANUAL_INSPECT');
        assert.equal(await page.evaluate(()=>window.testState.pendingPlan),null);
        await expect(page.locator('#defects-container')).toContainText('120.2 × 80.2 mm');
        await expect(page.locator('#radar-roll-info')).toContainText('疵点 1 处');
        pass('saving persists one centered defect with zero margin, updates the canvas, and invalidates the old preview');
        await page.locator('#btn-trigger-solve-station').click();
        await page.waitForFunction(()=>!!window.testState.pendingPlan?.result?.planId && !document.body.inert);
        const plan=await page.evaluate(()=>window.testState.pendingPlan);
        assert.ok(plan.request.defects.some(d=>d.id===defect.id));
        for(const p of plan.result.pieces) {
            const globalY=p.y+plan.windowStartY;
            assert.ok(p.x+p.w<=defect.x || p.x>=defect.x+defect.w || globalY+p.l<=defect.y || globalY>=defect.y+defect.h);
        }
        await page.reload();await page.waitForLoadState('networkidle');
        await expect(page.locator('#radar-roll-info')).toContainText('疵点 1 处');
        assert.equal((await api('/api/cutting/tasks/'+task.id)).reports.length,0);
        pass('replanning avoids the saved defect and reloading retains it without reporting any work');
        await page.evaluate(async()=>{window.testState=(await import('/js/core/state.js')).state;});
        await page.locator('#btn-trigger-solve-station').click();
        await page.waitForFunction(()=>!!window.testState.pendingPlan?.result?.planId && !document.body.inert);
        await page.locator('#btn-stage-advance').click();
        await page.waitForFunction(()=>window.testState.reportQueue.length===1 && !document.body.inert);
        const queued=await page.evaluate(()=>structuredClone(window.testState.reportQueue));
        await page.getByRole('button',{name:'库存档案',exact:true}).click();
        await page.locator('[data-roll]').filter({hasText:id}).click();
        await page.locator('#add-defect-form-box').evaluate(el=>{el.parentElement.open=true;el.open=true;});
        await page.locator('#inp-new-defect-x').fill('400');
        await page.locator('#inp-new-defect-y').fill('22000');
        await page.locator('#inp-new-defect-m').fill('0');
        await page.locator('[data-defect-form] [type=submit]').click();
        await expect.poll(async()=>(await api('/api/rolls/'+id)).defects.length).toBe(2);
        await page.locator('#material-manager-modal [data-close]').click();
        assert.deepEqual(await page.evaluate(()=>window.testState.reportQueue),queued);
        assert.equal((await api('/api/rolls/'+id)).usedLength,0);
        assert.equal((await api('/api/rolls/'+id)).defects[1].margin,0);
        pass('existing inventory form shares defect saving and preserves pending work orders with zero margin');
        assert.deepEqual(errors,[]);
        console.log(`Browser tests: ${passed} executed, ${passed} passed, 0 failed, 0 skipped.`);
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
