// 只对显式隔离服务建立测试任务；用真实原生求解结果验证新版工作台，不写正式库存。
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'explicit isolated service required');
const api = async (path, body) => {
    const r = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value;
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
(async () => {
    const id = 'R1-TEST-' + randomUUID(), results = [];
    const roll = {rollId: id, rollModel: id, width: 1500, totalLength: 12000, usedLength: 0};
    await api('/api/rolls', roll);
    const shape = {type: 'POLYGON', width: 300, height: 400, vertices: [
        {x: 0, y: 0}, {x: 300, y: 0}, {x: 300, y: 150}, {x: 100, y: 150}, {x: 100, y: 400}, {x: 0, y: 400}]};
    const demands = [{id: 1, name: 'R1 构造凹多边形', width: 300, length: 400, quantity: 2, allowRotation: true, shape}];
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, externalRef: 'R1 isolated acceptance', revision: 0, demands,
        process: {bedLength: 1000, trimStart: 0, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: true, allowLongitudinal: true, pieceGap: 5}});
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start: 2000, len: 1000}, settings: {timeLimitSeconds: 2}}));
    assert.equal(result.success, true, result.message); assert.ok(result.planId); assert.equal(result.pieces.length, 2);
    assert.equal(result.engine, 'packingsolver-irregular'); assert.ok(!result.fallbackReason);
    const before = await api('/api/rolls/' + id);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    async function check(name, fn) {
        try { await fn(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.message); }
    }
    try {
        await page.goto(base + '/app/#/workbench/' + task.id + '/' + result.planId);
        await page.waitForFunction(() => Konva.stages.find(s => s.container().id === 'rc')?.find('.roll-piece').length === 2);
        await check('native result contours and station offsets reach the workbench unchanged', async () => {
            const nodes = await page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').find('.roll-piece')
                .map(p => ({id: p.getAttr('pieceId'), x: p.x(), y: p.y(), points: p.points()})));
            for (const p of result.pieces) {
                const node = nodes.find(n => n.id === p.id); assert.ok(node);
                assert.equal(node.x, p.x); assert.equal(node.y, p.y + 2000);
                assert.deepEqual(node.points, p.shape.vertices.flatMap(v => [v.x, v.y]));
            }
        });
        await check('orientation, whole roll, tiled view and station navigation keep one stage', async () => {
            await page.locator('#orient').click(); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').findOne('.roll-piece').getParent().getParent().rotation()), 90);
            await page.locator('[data-view="full"]').click(); await page.locator('[data-full="tile"]').click(); await frames(page);
            assert.ok(await page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').find('Group').some(g => g.clipHeight() > 0)));
            await page.locator('[data-view="station"]').click(); await page.locator('#seg-next').click(); await frames(page);
            await page.locator('#seg-prev').click(); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages.length), 1);
        });
        await check('manual editing preserves a polygon and undo restores it without saving', async () => {
            await page.locator('#adjust-open').click(); await frames(page);
            const stagePoint = await page.evaluate(() => {
                const s = Konva.stages.find(s => s.container().id === 'rc'), p = s.findOne('.roll-piece');
                const point = p.getAbsoluteTransform().point({x: 20, y: 20}), box = s.container().getBoundingClientRect();
                const end = p.getAbsoluteTransform().point({x: 20, y: 520});
                return {x: point.x + box.x, y: point.y + box.y, endX: end.x + box.x, endY: end.y + box.y};
            });
            await page.mouse.move(stagePoint.x, stagePoint.y); await page.mouse.down();
            // The native packing is tight: move into the known empty tail, not into the neighbouring piece.
            await page.mouse.move(stagePoint.endX, stagePoint.endY, {steps: 5}); await page.mouse.up(); await frames(page);
            assert.ok(await page.locator('#adj-save').isEnabled());
            await page.locator('#adj-undo').click(); await frames(page);
            assert.ok(await page.locator('#adj-save').isDisabled());
            await page.locator('#adjust-close').click();
        });
        await check('workbench view switches and keyboard edits use the shared canvas and existing history', async () => {
            await page.locator('#path-toggle').click(); await frames(page);
            assert.ok(await page.evaluate(() => Konva.stages[0].find('.roll-cut').length > 0));
            await page.locator('#path-toggle').click(); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-cut').length + Konva.stages[0].find('.roll-path').length), 0);
            await page.locator('#dimensions-toggle').click(); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-dimension').length), 0);
            await page.locator('#dimensions-toggle').click();
            await page.locator('#adjust-open').click(); await frames(page);
            const selected = await page.evaluate(() => {
                const s = Konva.stages[0], n = s.findOne('.roll-piece'), p = n.getAbsoluteTransform().point({x: 20, y: 20}), b = s.container().getBoundingClientRect();
                return {id: n.getAttr('pieceId'), x: n.x(), y: n.y(), sx: p.x + b.x, sy: p.y + b.y, horizontal: n.getParent().getParent().rotation() === 90};
            });
            await page.mouse.click(selected.sx, selected.sy);
            await page.locator('#adj-x').fill('100'); await page.locator('#adj-y').fill('500');
            await page.locator('#adj-position').click(); await frames(page);
            selected.x = 100; selected.y = 2500;
            await page.locator('#rc').focus();
            const position = () => page.evaluate(id => { const n = Konva.stages[0].find('.roll-piece').find(p => p.getAttr('pieceId') === id); return {x: n.x(), y: n.y()}; }, selected.id);
            await page.keyboard.press('ArrowRight'); await frames(page);
            assert.deepEqual(await position(), {x: selected.x + (selected.horizontal ? 0 : 5), y: selected.y + (selected.horizontal ? 5 : 0)});
            await page.keyboard.press('Control+z'); await frames(page); assert.deepEqual(await position(), {x: selected.x, y: selected.y});
            await page.keyboard.press('Control+Shift+z'); await frames(page); assert.ok(await page.locator('#adj-save').isEnabled());
            const points = () => page.evaluate(id => Konva.stages[0].find('.roll-piece').find(p => p.getAttr('pieceId') === id).points(), selected.id);
            const prior = await points(); await page.keyboard.press('r'); await frames(page);
            assert.notDeepEqual(await points(), prior, 'permitted contour rotation uses the saved adjustment contract');
            await page.keyboard.press('f'); await frames(page); await page.keyboard.press('Escape');
            assert.ok(await page.locator('#adj-fit').isDisabled());
            await page.locator('#adjust-close').click();
        });
        await check('1366 and 1920 desktop toolbar actions remain reachable', async () => {
            for (const [width, height] of [[1366, 768], [1920, 1080]]) {
                await page.setViewportSize({width, height}); await frames(page);
                for (const selector of ['#z-fit', '#orient', '[data-tool="measure"]']) await page.locator(selector).click();
                assert.ok(await page.locator('#rc').isVisible());
            }
        });
        await check('narrow screen can reach task navigation and reopen the workbench', async () => {
            await page.setViewportSize({width: 390, height: 844});
            await page.locator('#nav a[href="#/tasks"]').click(); await page.locator('a.btn[href="#/workbench/' + task.id + '"]').click();
            await page.waitForFunction(() => Konva.stages.length === 1);
            assert.ok(await page.locator('#rc').isVisible());
        });
        await check('route cleanup removes all stages and return mounts exactly once', async () => {
            await page.locator('#nav a[href="#/tasks"]').click(); await page.waitForFunction(() => Konva.stages.length === 0);
            await page.setViewportSize({width: 1366, height: 768});
            await page.locator('a.btn[href="#/workbench/' + task.id + '"]').click(); await page.waitForFunction(() => Konva.stages.length === 1);
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
        });
        await check('view operations do not issue writes or consume material', async () => {
            assert.deepEqual(writes, []); assert.deepEqual(errors, []);
            assert.deepEqual(await api('/api/rolls/' + id), before);
            assert.equal(before.usedLength, 0);
        });
        await check('interrupted navigator dragging refreshes the right panel and cursor status to the retained position', async () => {
            for (const event of ['blur', 'hidden']) {
                await page.goto(base + '/app/#/workbench/' + task.id + '/' + result.planId); await page.waitForSelector('#rn .rn-win');
                const start = await page.locator('#rn .rn-win').boundingBox(), p = {x: start.x + start.width / 2, y: start.y + start.height / 2};
                await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 60, p.y);
                const position = await page.locator('#rn .rn-wl').innerText();
                const expectedStart = await page.locator('#rn .rn-win').evaluate((e, total) =>
                    (parseFloat(e.style.left) * total / 100000).toLocaleString('zh-CN', {maximumFractionDigits: 2}), roll.totalLength);
                await page.evaluate(event => {
                    if (event === 'blur') window.dispatchEvent(new Event('blur'));
                    else { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); }
                }, event);
                try {
                    assert.match(await page.locator('.split > .pane:last-child').innerText(), /工位已调整/);
                    assert.ok(await page.locator('#report-open').isDisabled());
                    await page.mouse.up(); assert.equal(await page.locator('#rn .rn-wl').innerText(), position);
                    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
                    await page.locator('#rc').hover();
                    assert.ok((await page.locator('#statusbar').innerText()).replace(/\s/g, '').includes('工位' + expectedStart + '–'));
                    assert.deepEqual(writes, []); assert.deepEqual(await api('/api/rolls/' + id), before);
                } finally { await page.mouse.up(); await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }); }
            }
        });
    } finally {
        await browser.close();
        const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
