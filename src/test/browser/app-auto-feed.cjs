// 正式数据只读；所有任务、试算和候选写入仅允许显式隔离服务。
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'isolated service required');
const api = async (path, body) => {
    const response = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
(async () => {
    const id = 'FEED-' + randomUUID(), results = [], errors = [], writes = [];
    const roll = {rollId: id, rollModel: id, width: 2800, totalLength: 100000, usedLength: 49496.9};
    await api('/api/rolls', roll);
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
        demands: [{id: 1, name: '长片', width: 2640, length: 4470, quantity: 2, allowRotation: false}],
        process: {bedLength: 1698.3, trimStart: .3, cutOrigin: 'right-bottom', firstStageOrientation: 'horizontal', allowRotation: false, allowLongitudinal: true, pieceGap: 0}});
    const before = await api('/api/rolls/' + id);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}});
    page.setDefaultTimeout(12000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {if (r.method() !== 'GET') writes.push({url: r.url(), body: r.postDataJSON()});});
    const check = async (name, fn) => {
        try {await fn(); results.push({name, success: true}); console.log('PASS', name);}
        catch (e) {results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.message);}
    };
    let result;
    try {
        await page.goto(base + '/app/#/workbench/' + task.id);
        await page.locator('[data-roll="' + id + '"]').click();
        await check('navigator offers exact demand length and keyboard activation only changes the preview', async () => {
            assert.match(await page.locator('#feed-fit').innerText(), /4,470.3/);
            const start = await page.locator('#rn .rn-win').evaluate(e => e.style.left);
            await page.locator('#feed-fit').focus(); await page.keyboard.press('Enter');
            assert.equal(await page.locator('#bed-len').inputValue(), '4470.3');
            assert.equal(await page.locator('#rn .rn-win').evaluate(e => e.style.left), start);
            assert.deepEqual(writes, []);
        });
        await check('calculate button automatically expands a short window and produces a native candidate without a second click', async () => {
            await page.locator('#bed-len').fill('1698.3'); await page.locator('#bed-len').press('Enter');
            const response = page.waitForResponse(r => r.url().endsWith('/api/solve') && r.request().method() === 'POST');
            await page.locator('#solve').click(); result = await (await response).json();
            assert.equal(result.success, true, result.message); assert.ok(result.planId); assert.ok(result.pieces.length);
            assert.ok(result.engine.startsWith('packingsolver')); assert.ok(!result.fallbackReason);
            await page.locator('#report-open').waitFor();
            assert.equal(writes.at(-1).body.rollL, 4470.3);
            assert.equal(writes.at(-1).body.windowStartY, 49496.9);
        });
        await check('auto feed is disabled while a report form is active', async () => {
            await page.locator('#report-open').click();
            assert.ok(await page.locator('#feed-fit').isDisabled());
            await page.reload(); await page.locator('#feed-fit').waitFor();
        });
        await check('failed automatic solve retains the original candidate and blocks duplicate recovery while solving', async () => {
            // Clear the report draft through its normal reset path if the report test created one.
            await page.evaluate(id => localStorage.removeItem('cutplan.app.report.' + id), result.planId);
            await page.reload(); await page.locator('#feed-fit').waitFor();
            let release;
            await page.route('**/api/solve', async route => {
                await new Promise(resolve => {release = resolve;});
                await route.fulfill({json: {success: false, status: 'NO_SOLUTION_FOUND', message: '隔离失败场景'}});
            });
            await page.locator('#bed-len').fill('1698.3'); await page.locator('#bed-len').press('Enter');
            await page.locator('#solve').click();
            assert.ok(await page.locator('#feed-fit').isDisabled());
            for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
            assert.ok(release, 'solve request started');
            release(); await page.locator('#solve:not(:disabled)').waitFor();
            await page.unroute('**/api/solve');
            const plans = await api('/api/cutting/tasks/' + task.id + '/plans');
            assert.equal(plans.find(p => p.id === result.planId).status, 'PENDING');
            assert.ok(!writes.some(r => r.url.includes('/cancel')));
        });
        await check('calculate automatically extends past a blocking defect without skipping the original start', async () => {
            const defectId = id + '-DEFECT';
            await api('/api/rolls', {rollId: defectId, rollModel: defectId, width: 2800, totalLength: 20000, usedLength: 0,
                defects: [{id: 1, x: 0, y: 1000, w: 2800, h: 1000, margin: 20, defectType: 'HOLE'}]});
            const defectTask = await api('/api/cutting/tasks', {...task, id: undefined, materialModel: defectId, revision: 0});
            await page.goto(base + '/app/#/workbench/' + defectTask.id);
            await page.locator('[data-roll="' + defectId + '"]').click();
            const count = writes.length, stock = await api('/api/rolls/' + defectId);
            await page.locator('#solve').click(); await page.locator('#report-open').waitFor();
            const attempts = writes.slice(count).filter(r => r.url.endsWith('/api/solve')).map(r => r.body);
            assert.deepEqual(attempts.map(r => r.rollL), [4470.3, 6490.3]);
            assert.ok(attempts.every(r => r.windowStartY === 0));
            assert.deepEqual(await api('/api/rolls/' + defectId), stock);
        });
        await check('roll tail blocks the recommendation rather than truncating required length', async () => {
            const tailId = id + '-TAIL';
            await api('/api/rolls', {rollId: tailId, rollModel: id, width: 2800, totalLength: 100000, usedLength: 98000});
            const tailTask = await api('/api/cutting/tasks', {...task, id: undefined, name: id + '-tail', revision: 0});
            await page.goto(base + '/app/#/workbench/' + tailTask.id);
            await page.locator('[data-roll="' + tailId + '"]').click();
            assert.ok(await page.locator('#feed-fit').isDisabled());
            assert.match(await page.locator('#feed-fit').getAttribute('title'), /卷尾/);
        });
        await check('1366px and 1920px layouts retain visible navigation, auto feed and calculate action', async () => {
            for (const [width, height] of [[1366, 768], [1920, 1080]]) {
                await page.setViewportSize({width, height});
                for (const selector of ['#feed-fit', '#rn', '#solve']) {
                    const box = await page.locator(selector).boundingBox();
                    assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height, selector);
                }
            }
        });
        await check('preview and failed retries leave material, fulfillment and process defaults unchanged', async () => {
            assert.deepEqual(await api('/api/rolls/' + id), before);
            const detail = await api('/api/cutting/tasks/' + task.id);
            assert.deepEqual(detail.completed, {}); assert.equal(detail.reports.length, 0);
            assert.equal(detail.task.process.bedLength, 1698.3);
            assert.ok(writes.every(r => r.url.endsWith('/api/solve'))); assert.deepEqual(errors, []);
        });
    } finally {
        await browser.close(); const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({discovered: 8, executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed || results.length !== 8) process.exitCode = 1;
    }
})().catch(e => {console.error(e); process.exitCode = 1;});
