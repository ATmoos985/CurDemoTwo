// Both pages use the real service; only the nesting preview endpoint may receive writes.
const assert = require('node:assert/strict');
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL || 'http://localhost:8080';

(async () => {
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0;
    try {
        const page = await browser.newPage({viewport:{width:1366,height:768}}), errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
        const move = async (x,y,click = false) => {
            const point = await page.evaluate(async ({x,y}) => {
                const {stage} = await import('/js/plugins/cad/cad-stage.js'), box = stage.container().getBoundingClientRect();
                return {x:box.x+stage.x()+x*stage.scaleX(),y:box.y+stage.y()+y*stage.scaleY()};
            }, {x,y});
            await page.mouse.move(point.x,point.y);
            if (click) await page.mouse.click(point.x,point.y);
        };
        const measurements = () => page.evaluate(async () => {
            const {stage} = await import('/js/plugins/cad/cad-stage.js');
            return stage.find('Text').filter(n => n.text().includes('ΔX')).map(n => n.text());
        });
        for (const path of ['/index.html', '/nesting.html']) {
            await page.goto(base+path); await page.waitForLoadState('networkidle');
            const info = await page.evaluate(async () => {
                const {stage,getCanvasData} = await import('/js/plugins/cad/cad-stage.js');
                const canvas = document.getElementById('cad-ruler-canvas');
                const painted = canvas.getContext('2d').getImageData(0,0,28,28).data.some(value => value > 0);
                return {container:stage.container().id,width:canvas.width,expected:Math.round(stage.width()*devicePixelRatio),painted,data:getCanvasData()};
            });
            assert.equal(info.container,path === '/index.html' ? 'konva-container' : 'nesting-canvas');
            assert.equal(info.width,info.expected); assert.ok(info.painted);
            if (path === '/index.html') assert.equal(await page.evaluate(async () => {
                const {getCanvasData} = await import('/js/plugins/cad/cad-stage.js');
                const {state} = await import('/js/core/state.js');
                return getCanvasData() === state.getCurrentCaseData();
            }),true);
            passed++;
            if (path === '/index.html') {
                // Supply only an in-memory material so the empty-workbench guard does not hide the canvas.
                await page.evaluate(async () => {
                    const {state}=await import('/js/core/state.js');
                    Object.assign(state.getCurrentCaseData(),{rollW:1500,bedL:2000,totalRollL:2000,materialAvailable:true});
                    for (const node of document.querySelectorAll('[data-material="empty"]')) node.dataset.material='loaded';
                    const renderer=await import('/js/plugins/cad/cad-renderer.js');
                    renderer.renderScene(); renderer.resetToBedView();
                });
                await page.locator('#btn-measure-tool').click();
                const box=await page.locator('#konva-container').boundingBox();
                await page.mouse.click(box.x+100,box.y+100); await page.mouse.click(box.x+160,box.y+180);
                assert.equal((await measurements()).length,1);
                await page.getByRole('button',{name:'放大画布',exact:true}).click();
                await page.keyboard.press('Escape');
                await expect(page.locator('#btn-measure-tool')).toHaveAttribute('aria-pressed','false');
                passed++;
            }
        }
        // A point inside the lab's material is reported relative to its right-bottom cutting origin.
        await move(500,1000);
        const cursor = await page.evaluate(async () => {
            const {stage,getCanvasData} = await import('/js/plugins/cad/cad-stage.js');
            const {stationCoordinates} = await import('/js/plugins/cad/cad-view.js');
            const p=stage.getPointerPosition(), s=stage.scaleX();
            return stationCoordinates(Math.round((p.x-stage.x())/s),Math.round((p.y-stage.y())/s),getCanvasData());
        });
        await expect(page.locator('#sb-cursor-pos')).toContainText(`指针 X ${cursor.x} · Y ${cursor.y} mm`);
        passed++;
        await page.locator('#btn-measure-tool').click();
        await move(400,500,true); await move(700,900,true);
        let labels=await measurements(); assert.equal(labels.length,1);
        const values=labels[0].match(/([\d.]+) mm.*ΔX (\d+) \/ ΔY (\d+)/);
        assert.ok(values); assert.ok(Math.abs(Number(values[1])-Math.hypot(Number(values[2]),Number(values[3]))) <= .1);
        await page.locator('#zoom-in').click();
        await expect.poll(measurements).toEqual(labels);
        await page.keyboard.press('Escape');
        await expect(page.locator('#btn-measure-tool')).toHaveAttribute('aria-pressed','false');
        assert.deepEqual(await page.evaluate(async () => { const {stage,mainLayer}=await import('/js/plugins/cad/cad-stage.js');return [stage.draggable(),mainLayer.listening()]; }),[true,true]);
        passed++;
        await page.locator('#scenario-select').selectOption('GARMENT_SHIRT');
        assert.deepEqual(await measurements(),[]);
        const solved=page.waitForResponse(r=>r.url().endsWith('/api/v1/nesting/solve') && r.request().method()==='POST');
        await page.locator('#solve-button').click(); const result=await (await solved).json();
        await expect(page.locator('#solve-status')).toContainText('已排入');
        const p=result.placements[0];
        await move(p.x+p.shape.width*.5,p.y+p.shape.height*.7,true);
        await expect(page.locator('#selected-piece')).toBeVisible();
        await expect(page.locator('#piece-description')).toContainText(p.name);
        await page.getByText('显示',{exact:true}).click();
        await page.locator('#show-paths').uncheck();
        assert.equal(await page.evaluate(async ()=>(await import('/js/plugins/cad/cad-stage.js')).cutGroup.visible()),false);
        await page.locator('#show-paths').check();
        await page.getByText('显示',{exact:true}).click();
        passed++;
        const before=await page.evaluate(async()=>{const {stage}=await import('/js/plugins/cad/cad-stage.js');return stage.position();});
        const box=await page.locator('#nesting-canvas').boundingBox();
        await page.mouse.move(box.x+80,box.y+80); await page.mouse.down(); await page.mouse.move(box.x+110,box.y+100,{steps:5}); await page.mouse.up();
        assert.notDeepEqual(await page.evaluate(async()=>(await import('/js/plugins/cad/cad-stage.js')).stage.position()),before);
        await page.locator('#nesting-canvas').focus(); await page.keyboard.press('0');
        await page.setViewportSize({width:1920,height:1080});
        await expect.poll(()=>page.evaluate(async()=>{const {stage}=await import('/js/plugins/cad/cad-stage.js');return document.getElementById('cad-ruler-canvas').width===Math.round(stage.width()*devicePixelRatio);})).toBe(true);
        assert.deepEqual(errors,[]);
        assert.ok(writes.length > 0 && writes.every(url=>url.endsWith('/api/v1/nesting/solve')));
        passed++;
        console.log(JSON.stringify({discovered:7,executed:7,passed,failed:0,skipped:0}));
    } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
