// Constructed rectangular layout, real adjustment and execution APIs; isolated inventory only.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080');
const api = async (path, body, headers = {}) => {
    const r = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)} : {});
    const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value;
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
(async () => {
    const id = 'R1-MENU-' + randomUUID(), results = [];
    await api('/api/rolls', {rollId: id, rollModel: id, width: 1500, totalLength: 12000, usedLength: 0});
    const roll = await api('/api/rolls/' + id);
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
        demands: [{id: 1, name: '菜单验收矩形', width: 300, length: 200, quantity: 3, allowRotation: true}],
        process: {bedLength: 1000, trimStart: 0, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: true, allowLongitudinal: true, pieceGap: 10}});
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start: 2000, len: 1000}, settings: {timeLimitSeconds: 2}}));
    assert.equal(result.success, true, result.message); assert.equal(result.pieces.length, 3);
    let plan = await api('/api/cutting/plans/' + result.planId + '/adjust', {adjustmentId: randomUUID(),
        pieces: result.pieces.map((p, i) => ({id: p.id, x: 100 + 400 * i, y: 100, rotated: false}))});
    const original = structuredClone(plan), before = await api('/api/rolls/' + id);
    const [first, second, third] = plan.result.pieces.map(p => p.id);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push({url: r.url(), body: r.postData()}); });
    const nodes = () => page.evaluate(() => Konva.stages[0].find('.roll-piece').map(n => ({id: n.getAttr('pieceId'), x: n.x(), y: n.y(), w: n.width(), l: n.height()})));
    const point = pieceId => page.evaluate(id => {
        const s = Konva.stages[0], n = s.find('.roll-piece').find(n => n.getAttr('pieceId') === id), box = s.container().getBoundingClientRect();
        const p = n.getAbsoluteTransform().point({x: 30, y: 30}); return {x: p.x + box.x, y: p.y + box.y};
    }, pieceId);
    const context = async pieceId => { await frames(page); const p = await point(pieceId); await page.mouse.click(p.x, p.y, {button: 'right'}); await page.locator('.canvas-menu').waitFor(); };
    const action = async name => { await page.locator('[data-canvas-action="' + name + '"]').click(); await frames(page); };
    const pick = async pieceId => { const p = await point(pieceId); await page.mouse.click(p.x, p.y); await frames(page); };
    const reset = async () => { await page.locator('#adj-reset').click(); await frames(page); };
    const goto = async () => { await page.goto(base + '/app/#/workbench/' + task.id + '/' + plan.id); await page.locator('#z-fit').waitFor(); await frames(page); };
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    try {
        await goto();
        await check('an empty new station has a view menu without accessing a nonexistent plan draft', async () => {
            await page.locator('#seg-next').click(); await frames(page);
            try {
                const point = await page.evaluate(y => {
                    const s = Konva.stages[0], box = s.container().getBoundingClientRect();
                    const p = s.getLayers()[0].getChildren()[0].getAbsoluteTransform().point({x: 750, y});
                    return {x: p.x + box.x, y: p.y + box.y};
                }, 2000 + plan.result.deductLen + 500);
                await page.mouse.click(point.x, point.y, {button: 'right'}); await page.locator('.canvas-menu').waitFor();
                assert.ok(await page.locator('[data-canvas-action="adjust"]').isDisabled());
                await action('fit'); assert.deepEqual(writes, []);
            } finally { await page.locator('#seg-prev').click(); await frames(page); }
        });
        await check('right-click rotation opens a draft using the selected saved piece without writing production data', async () => {
            await context(first); assert.match(await page.locator('.canvas-menu').innerText(), new RegExp('裁片 #' + first));
            assert.match(await page.locator('.canvas-menu-detail').innerText(), /Y 2,100/);
            await action('rotate');
            assert.equal(await page.evaluate(() => document.activeElement.id), 'rc', 'newly mounted adjustment canvas receives keyboard focus');
            assert.deepEqual((await nodes()).find(p => p.id === first), {id: first, x: 100, y: 2100, w: 200, l: 300});
            assert.ok(await page.locator('#adj-save').isEnabled()); assert.deepEqual(writes, []);
        });
        await check('menu removal, undo and redo share one draft history and leave the saved version intact', async () => {
            await context(second); await action('remove'); assert.equal((await nodes()).length, 2);
            await page.locator('#rc').focus(); await page.keyboard.press('Control+z'); await frames(page); assert.equal((await nodes()).length, 3);
            await page.keyboard.press('Control+y'); await frames(page); assert.equal((await nodes()).length, 2);
            assert.match(await page.locator('#adjust').innerText(), /移除 1 件/);
            assert.deepEqual((await api('/api/cutting/plans/' + original.id)).result.pieces, original.result.pieces);
            assert.deepEqual(writes, []);
        });
        await check('the final piece cannot be removed by the panel or shortcut, and reset restores all pieces', async () => {
            await context(first); await action('remove'); await pick(third);
            assert.ok(await page.locator('#adj-remove').isDisabled()); await page.locator('#rc').focus();
            await page.keyboard.press('Delete'); await frames(page); assert.equal((await nodes()).length, 1);
            await reset(); assert.equal((await nodes()).length, 3); assert.ok(await page.locator('#adj-save').isDisabled());
        });
        await check('menu keyboard focus, escape and viewport bounds work on desktop and narrow entry', async () => {
            for (const [width, height] of [[1366, 768], [1920, 1080], [640, 768]]) {
                await page.setViewportSize({width, height}); await page.locator('#z-fit').click(); await frames(page);
                await pick(first); await page.locator('#adj-menu').click();
                const box = await page.locator('.canvas-menu').boundingBox();
                assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
                await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.canvasAction), 'locate');
                await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => document.activeElement.dataset.canvasAction), 'select');
                await page.keyboard.press('Escape'); assert.equal(await page.locator('.canvas-menu').count(), 0);
                assert.equal(await page.evaluate(() => document.activeElement.id), 'rc');
            }
            await page.setViewportSize({width: 1366, height: 768}); await page.locator('#z-fit').click(); await frames(page);
        });
        await check('a removed rectangle frees its geometry and an unknown save response retries one unchanged version', async () => {
            await context(second); await action('remove'); await pick(first);
            await page.locator('#adj-x').fill('500'); await page.locator('#adj-position').click(); await frames(page);
            assert.equal(await page.locator('#adj-problem').count(), 0); assert.equal((await nodes()).find(p => p.id === first).x, 500);
            const path = '**/api/cutting/plans/' + plan.id + '/adjust';
            await page.route(path, async route => {
                const response = await route.fetch(); assert.ok(response.ok());
                await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({message: '模拟移除保存后响应丢失'})});
            }, {times: 1});
            await page.locator('#adj-save').click(); await page.getByText(/模拟移除保存后响应丢失/).waitFor();
            const body = writes.at(-1).body;
            const response = page.waitForResponse(r => r.url().endsWith('/plans/' + plan.id + '/adjust') && r.request().method() === 'POST');
            await page.locator('#adj-save').click(); const saved = await response; assert.ok(saved.ok()); plan = await saved.json();
            await page.locator('#adjust-open').waitFor(); assert.equal(writes.at(-1).body, body);
            assert.deepEqual(plan.result.pieces.map(p => p.id), [first, third]); assert.equal(plan.version, original.version + 1);
            assert.deepEqual(await api('/api/rolls/' + id), before);
            assert.deepEqual((await api('/api/cutting/tasks/' + task.id)).reports, []);
            assert.equal((await api('/api/cutting/tasks/' + task.id + '/plans')).length, 3);
        });
        await check('a report draft cannot be displaced by a context-menu edit', async () => {
            await page.locator('#report-open').click(); await frames(page); await context(first);
            assert.ok(await page.locator('[data-canvas-action="select"]').isDisabled());
            assert.match(await page.locator('.canvas-menu').innerText(), /先结束报工或复检/);
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#report').count(), 1);
            assert.equal(await page.locator('#adjust').count(), 0); assert.equal(writes.length, 2);
            await page.locator('#report-close').click(); await frames(page);
        });
        await check('released execution locks disable context mutations and keyboard deletion', async () => {
            const execution = await api('/api/v2/execution-orders', {planId: plan.id, station: '菜单验收工位'}, {'Idempotency-Key': randomUUID()});
            await api('/api/v2/execution-orders/' + execution.id + '/release', {operationId: randomUUID(), expectedVersion: execution.version, reservationSeconds: 1800, reason: ''});
            await goto(); await context(first);
            for (const name of ['select', 'rotate', 'remove']) assert.ok(await page.locator('[data-canvas-action="' + name + '"]').isDisabled());
            assert.match(await page.locator('.canvas-menu').innerText(), /已锁定/); await page.keyboard.press('Escape');
            await page.keyboard.press('Delete'); await frames(page); assert.equal((await nodes()).length, 2);
            assert.equal(await page.locator('#adjust-open').count(), 0); assert.equal(writes.length, 2);
        });
        await check('outside gestures, hidden document and route disposal close the owned menu without leaving handlers', async () => {
            await context(first); await page.locator('.wb-head h1').click(); assert.equal(await page.locator('.canvas-menu').count(), 0);
            await context(first);
            await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
            assert.equal(await page.locator('.canvas-menu').count(), 0); await page.evaluate(() => { delete document.hidden; });
            await context(first); await page.evaluate(() => { location.hash = '#/tasks'; });
            await page.waitForFunction(() => !document.querySelector('#rc')); assert.equal(await page.locator('.canvas-menu').count(), 0);
            await goto(); await context(first); assert.equal(await page.locator('.canvas-menu').count(), 1);
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
            await page.keyboard.press('Escape');
        });
        await check('saved source and consumed material remain unchanged and the browser has no errors', async () => {
            assert.deepEqual((await api('/api/cutting/plans/' + original.id)).result.pieces, original.result.pieces);
            assert.equal((await api('/api/rolls/' + id)).usedLength, before.usedLength);
            assert.deepEqual((await api('/api/cutting/tasks/' + task.id)).completed, {});
            assert.equal(writes.length, 2); assert.ok(writes.every(w => w.url.endsWith('/adjust'))); assert.deepEqual(errors, []);
        });
    } finally {
        await browser.close(); const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
