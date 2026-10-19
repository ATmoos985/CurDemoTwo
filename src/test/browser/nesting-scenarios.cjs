// Run against the packaged app; set PLAYWRIGHT_MODULE / CHROME_PATH for a bundled runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const assert = require('node:assert/strict');

(async () => {
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0;
    try {
        const page = await browser.newPage({viewport:{width:920,height:678}}), errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
        const url = (process.env.BASE_URL || 'http://localhost:8080') + '/nesting.html';
        for (const [width, height] of [[2183,1244], [1920,1080], [1366,768], [920,678]]) {
            await page.setViewportSize({width, height});
            await page.goto(url);
            // Check before click auto-scroll can conceal an inaccessible primary action.
            await expect(page.locator('#solve-button')).toBeInViewport({ratio:1});
            await expect(page.locator('#solve-button')).toHaveText('开始裁切预览');
            await expect(page.locator('#problem-form button[type=submit]')).toHaveCount(1);
            await page.locator('#protocol-details > summary').click();
            await page.locator('#export-input').scrollIntoViewIfNeeded();
            assert.ok(await page.locator('.lab-form-body').evaluate(node => node.scrollTop > 0));
            await expect(page.locator('#solve-button')).toBeInViewport({ratio:1});
            passed++;
        }
        await expect(page.locator('#scenario-select')).toHaveValue('GUILLOTINE');
        for (const [key, material, mode] of [
            ['CROSSCUT','MATERIAL-1','CROSSCUT'], ['GUILLOTINE','MATERIAL-1','GUILLOTINE'],
            ['3','DEMO-3','GUILLOTINE'], ['4','DEMO-4','GUILLOTINE'],
            ['6','DEMO-6','GUILLOTINE'], ['CONTOUR','POLYGON-1','CONTOUR'],
            ['GARMENT_SHIRT','DEMO-GARMENT_SHIRT','CONTOUR'],
            ['GARMENT_PANTS','DEMO-GARMENT_PANTS','CONTOUR'],
            ['GARMENT_SKIRT','DEMO-GARMENT_SKIRT','CONTOUR'],
            ['GARMENT_FULL','DEMO-GARMENT_FULL','CONTOUR'],
            ['BOARD_GRAIN','DEMO-BOARD_GRAIN','GUILLOTINE'], ['BOARD_PLAIN','DEMO-BOARD_PLAIN','GUILLOTINE']
        ]) {
            // Real select interaction dispatches input before change, reproducing the original failure.
            await page.locator('#scenario-select').selectOption(key);
            await expect(page.locator('#scenario-select')).toHaveValue(key);
            await expect(page.locator('#material-id')).toHaveValue(material);
            await expect(page.locator('#process-mode')).toHaveValue(mode);
            await expect(page.locator('#solve-error')).toBeHidden();
            assert.ok(await page.locator('#part-rows .lab-row').count() > 0);
            await expect(page.locator('#solve-button')).toBeInViewport({ratio:1});
            const solved = page.waitForResponse(response => response.url().endsWith('/api/v1/nesting/solve') && response.request().method() === 'POST');
            await page.locator('#solve-button').click();
            const result = await (await solved).json();
            await expect(page.locator('#solve-status')).toContainText('已排入', {timeout:20000});
            if (key.startsWith('GARMENT_')) {
                assert.equal(result.status, 'FEASIBLE');
                assert.equal(result.contours.length, result.placements.length);
                for (const item of result.fulfillment) assert.ok(item.placed > 0, `未展示裁片 ${item.demandId}`);
                assert.ok(result.placements.every(p => p.shape.type === 'POLYGON' && p.rotationDegrees === 0));
                await expect(page.locator('#contour-note')).toBeVisible();
                if (key === 'GARMENT_FULL') {
                    const utilization = result.metrics.pieceAreaMm2 / result.metrics.processingAreaMm2;
                    assert.ok(utilization >= 0.8 && utilization < 1, `密排利用率 ${utilization}`);
                    assert.ok(result.placements.length >= 15);
                    assert.ok(result.fulfillment.some(item => item.unplaced > 0));
                    assert.ok(result.metrics.unassignedAreaMm2 > 0);
                    await expect(page.locator('#area-pieces')).toContainText(`${(utilization * 100).toFixed(1)}%`);
                }
                if (process.env.SCREENSHOT_DIR) await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/${key}.png`,fullPage:true});
            }
            await expect(page.locator('#export-result')).toBeEnabled();
            await expect(page.locator('#solve-button')).toHaveText('开始裁切预览');
            passed++;
        }
        // Native select Home-key behavior differs on macOS; dispatch the real selection events.
        await page.locator('#scenario-select').selectOption('CROSSCUT');
        await expect(page.locator('#scenario-select')).toHaveValue('CROSSCUT');
        await expect(page.locator('#material-height')).toHaveValue('3000');
        await page.locator('#material-width').fill('2100');
        await expect(page.locator('#scenario-select')).toHaveValue('');
        await expect(page.locator('#material-width')).toHaveValue('2100');
        await page.locator('#scenario-select').selectOption('CROSSCUT');
        await expect(page.locator('#material-width')).toHaveValue('2000');
        passed++;
        await page.locator('#solve-button').click();
        await expect(page.locator('#solve-status')).toContainText('已排入', {timeout:15000});
        await expect(page.locator('#export-result')).toBeEnabled();
        await page.locator('#scenario-select').selectOption('GUILLOTINE');
        await expect(page.locator('#material-height')).toHaveValue('4000');
        await expect(page.locator('#area-pieces')).toHaveText('—');
        await expect(page.locator('#export-result')).toBeDisabled();
        assert.deepEqual(errors, []);
        assert.equal(writes.length, 13);
        assert.ok(writes.every(url => url.endsWith('/api/v1/nesting/solve')));
        passed++;
        for (const [style,width,height,count] of [
            ['GARMENT_SHIRT',1920,1080,18], ['GARMENT_PANTS',1366,768,18], ['GARMENT_SKIRT',390,844,14]
        ]) {
            await page.setViewportSize({width,height});
            await page.goto((process.env.BASE_URL || 'http://localhost:8080') + '/marker-demo.html');
            await page.selectOption('#marker-style',style);
            await expect(page.locator('#marker-length-note')).toBeHidden();
            await page.click('#marker-run');
            await expect(page.locator('#marker-state')).toContainText(`${count} / ${count} 片齐套`,{timeout:30000});
            await expect(page.locator('#marker-error')).toBeHidden();
            await expect(page.locator('#marker-length-note')).toContainText('尾料不计入');
            await expect(page.locator('#marker-trials li').first()).toContainText('实际占用');
            const overlay = await page.evaluate(() => {
                const stage=Konva.stages.find(s=>s?.container().id==='marker-canvas');
                const line=stage.findOne('.marker-end-line'), tail=stage.findOne('.marker-unused-tail');
                const label=stage.findOne('.marker-end-label').getClientRect();
                return {end:line.points()[1],tailY:tail.y(),tail:tail.height(),labelRight:label.x+label.width,
                    canvasWidth:stage.width(),actual:parseFloat(document.getElementById('marker-length').textContent)};
            });
            assert.equal(overlay.end,overlay.actual);
            assert.equal(overlay.tailY,overlay.actual);
            assert.ok(overlay.tail>=0);
            assert.ok(overlay.labelRight<=overlay.canvasWidth, 'marker annotation must fit the canvas');
            await page.locator('#marker-canvas').focus();await page.keyboard.press('+');
            await page.click('#marker-fit');
            if(process.env.SCREENSHOT_DIR)await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/marker-${style}.png`,fullPage:true});
            await page.selectOption('#marker-style',style==='GARMENT_SHIRT'?'GARMENT_PANTS':'GARMENT_SHIRT');
            await expect(page.locator('#marker-length-note')).toBeHidden();
            assert.equal(await page.evaluate(()=>Konva.stages.find(s=>s?.container().id==='marker-canvas').find('.marker-end-line').length),0);
            passed++;
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({discovered:21,executed:21,passed,failed:0,skipped:0}));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
