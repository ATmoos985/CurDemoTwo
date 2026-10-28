// 构造验疵母卷，仅在显式隔离库存上验收；页面使用真实共享 Konva 实例与既有保存接口。
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'explicit isolated service required');
const api = async (path, body) => {
    const r = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    const data = await r.json(); assert.ok(r.ok, JSON.stringify(data)); return data;
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
(async () => {
    const id = 'INSPECT-R1-' + randomUUID(), results = [], errors = [], writes = [];
    await api('/api/rolls', {rollId: id, rollModel: id, width: 2000, totalLength: 100000, usedLength: 0,
        defects: [{id: 1, x: 100, y: 5000, w: 150, h: 180, margin: 20, defectType: 'HOLE', typeName: '破洞'}]});
    const before = await api('/api/rolls/' + id), key = 'cutplan.app.inspection.' + id;
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}});
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push({url: r.url(), body: r.postData()}); });
    const draft = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    const point = (v, u) => page.evaluate(([v, u]) => {
        const s = Konva.stages.find(s => s.container().id === 'isvg'), group = s.findOne('.roll-defect').getParent();
        const p = group.getAbsoluteTransform().point({x: v, y: u}), box = s.container().getBoundingClientRect();
        return {x: Math.round(p.x + box.x), y: Math.round(p.y + box.y)};
    }, [v, u]);
    const drag = async (a, b) => { await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 6}); await page.mouse.up(); await frames(page); };
    const locate = async pos => { await page.locator('#pos').fill(String(pos)); await page.locator('#locate').click(); await frames(page); };
    async function check(name, fn) {
        try { await fn(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    try {
        await page.goto(base + '/app/#/inspection/' + id);
        await page.waitForFunction(() => Konva.stages.find(s => s.container().id === 'isvg')?.find('.roll-defect').length === 1);
        await locate(5);
        const originalStage = await page.evaluate(() => Konva.stages[0]._id);
        await check('inspection uses one shared stage and keeps physical saved coordinates', async () => {
            assert.equal(await page.locator('#isvg svg').count(), 0);
            const d = await page.evaluate(() => { const n = Konva.stages[0].findOne('.roll-defect'); return {x: n.x(), y: n.y(), width: n.width(), height: n.height()}; });
            assert.deepEqual(d, {x: 100, y: 5000, width: 150, height: 180});
            const line = await page.evaluate(() => Konva.stages[0].findOne('.roll-feed-line').points());
            assert.ok(Math.abs(line[1] - await page.locator('#isvg').evaluate(e => e.clientHeight * .62)) < 1);
        });
        await check('reverse drag records whole-roll marks and re-render retains the instance', async () => {
            await drag(await point(650, 5100), await point(350, 4800));
            const d = await draft(); assert.equal(d.pending.length, 1);
            for (const [field, expected] of Object.entries({x: 350, y: 4800, w: 300, h: 300})) assert.ok(Math.abs(d.pending[0][field] - expected) < 5, field);
            assert.ok(d.pending[0].captureId); assert.equal(await page.evaluate(() => Konva.stages[0]._id), originalStage);
        });
        await check('draft can move and resize while saved defects remain read-only', async () => {
            await page.locator('[data-tool="select"]').click(); await frames(page);
            const d = (await draft()).pending[0], a = await point(d.x + d.w / 2, d.y + d.h / 2);
            await drag(a, {x: a.x + 30, y: a.y + 15});
            const moved = (await draft()).pending[0]; assert.ok(moved.x > d.x); assert.ok(moved.y > d.y);
            const corner = await page.evaluate(() => {
                const s = Konva.stages[0], n = s.find('.roll-defect-handle')[3], b = s.container().getBoundingClientRect();
                return {x: n.x() + 4 + b.x, y: n.y() + 4 + b.y};
            });
            await drag(corner, {x: corner.x + 25, y: corner.y + 30});
            const resized = (await draft()).pending[0]; assert.ok(resized.w > moved.w); assert.ok(resized.h > moved.h);
            const saved = await point(175, 5090); await drag(saved, {x: saved.x + 40, y: saved.y + 20});
            assert.deepEqual((await draft()).pending, [resized]);
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-defect').find(n => n.getAttr('defectId') === 'saved-1').x()), 100);
        });
        await check('undo and Ctrl+Z restore edits and deletion, not just the last created mark', async () => {
            const before = (await draft()).pending[0], a = await point(before.x + 30, before.y + 30);
            await drag(a, {x: a.x + 20, y: a.y + 10});
            assert.notDeepEqual((await draft()).pending[0], before);
            await page.locator('#undo').click(); assert.deepEqual((await draft()).pending[0], before);
            const p = await point(before.x + 30, before.y + 30); await page.mouse.click(p.x, p.y);
            await page.keyboard.press('Delete'); assert.equal((await draft()).pending.length, 0);
            await page.keyboard.press('Control+z'); assert.deepEqual((await draft()).pending[0], before);
        });
        await check('Escape discards an in-flight move and tool change clears measurement', async () => {
            const beforeMove = (await draft()).pending[0], a = await point(beforeMove.x + 30, beforeMove.y + 30);
            await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 40, a.y + 15);
            await page.keyboard.press('Escape'); await page.mouse.up(); await frames(page);
            assert.deepEqual((await draft()).pending[0], beforeMove);
            await page.locator('[data-tool="measure"]').click();
            await drag(await point(950, 4900), await point(1250, 5100));
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-measure').length), 1);
            await page.locator('[data-tool="mark"]').click(); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-measure').length), 0);
        });
        await check('zoomed drawing retains valid defects smaller than five millimetres', async () => {
            await locate(5); const before = (await draft()).pending.length;
            const anchor = await point(1000, 5000); await page.mouse.move(anchor.x, anchor.y);
            for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -100); await frames(page); }
            await drag(await point(1000, 5000), await point(1002, 5003));
            const pending = (await draft()).pending; assert.equal(pending.length, before + 1);
            const tiny = pending.at(-1); assert.ok(tiny.w >= .1 && tiny.w < 5); assert.ok(tiny.h >= .1 && tiny.h < 5);
            assert.ok(Math.abs(tiny.w - 2) <= .2 && Math.abs(tiny.h - 3) <= .2);
            await page.locator('#undo').click(); assert.equal((await draft()).pending.length, before);
            await page.locator('#follow').click(); await frames(page);
        });
        await check('automatic feed follows elapsed time, pauses, and updates the roll navigator', async () => {
            await locate(5); await page.locator('#speed').fill('60'); await page.locator('#speed').dispatchEvent('change');
            await page.locator('#run').click();
            await page.waitForFunction(() => Number(document.querySelector('#pos').value) > 5.15);
            await page.locator('#run').click(); const paused = (await draft()).pos;
            await page.waitForTimeout(250); assert.equal((await draft()).pos, paused);
            const progress = await page.locator('#vtrack b').evaluate(e => parseFloat(e.style.height));
            assert.ok(Math.abs(progress - paused / 100000 * 100) < .01);
            assert.equal(await page.evaluate(() => Konva.stages[0]._id), originalStage);
        });
        await check('full roll and follow restore a usable viewport at desktop and narrow widths', async () => {
            for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
                await page.setViewportSize({width, height}); await page.locator('#overview').click(); await page.locator('#follow').click(); await frames(page);
                assert.ok(await page.locator('#isvg').evaluate(e => e.clientWidth > 200 && e.clientHeight > 150));
            }
            await page.setViewportSize({width: 1366, height: 768}); await frames(page);
            const width = await page.locator('#isvg').evaluate(e => e.clientWidth);
            await page.locator('#toggle-panel').click(); await frames(page);
            assert.ok(await page.locator('#isvg').evaluate(e => e.clientWidth) > width + 300);
            await page.locator('#toggle-panel').click(); await frames(page);
            assert.equal(await page.locator('#isvg').evaluate(e => e.clientWidth), width);
        });
        await check('hiding pauses feed and restores the same stage without resuming animation', async () => {
            await page.locator('#run').click();
            await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
            const paused = await draft();
            assert.equal(await page.evaluate(() => Konva.stages[0].visible()), false);
            await page.waitForTimeout(250); assert.deepEqual(await draft(), paused);
            await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages[0].visible()), true);
            assert.ok((await page.locator('#run').textContent()).includes('自动跑布'));
            assert.equal(await page.evaluate(() => Konva.stages[0]._id), originalStage);
        });
        await check('route exit stops feed, releases the stage, and preserves local marks', async () => {
            await page.locator('#run').click(); await page.locator('#nav a[href="#/tasks"]').click();
            await page.waitForFunction(() => Konva.stages.length === 0);
            const stopped = await draft(); await page.waitForTimeout(250); assert.deepEqual(await draft(), stopped);
            await page.evaluate(id => location.hash = '#/inspection/' + id, id);
            await page.waitForFunction(() => Konva.stages.length === 1 && document.querySelector('#run')?.textContent.includes('自动跑布'));
            assert.equal((await draft()).pending.length, 1);
        });
        await check('viewing and draft interactions never write inventory', async () => {
            assert.deepEqual(writes, []); assert.deepEqual(await api('/api/rolls/' + id), before); assert.deepEqual(errors, []);
        });
        await check('lost save response keeps the original draft and retry does not duplicate a defect', async () => {
            const submitted = (await draft()).pending;
            const path = '**/api/rolls/' + id + '/inspection-defects';
            await page.route(path, async route => { await route.fetch(); await route.abort('failed'); }, {times: 1});
            await page.locator('#save').click(); await page.waitForFunction(() => !document.querySelector('#save').disabled);
            assert.deepEqual((await draft()).pending, submitted);
            assert.equal((await api('/api/rolls/' + id)).defects.length, 2);
            await page.locator('#save').click(); await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).pending.length === 0, key);
            assert.equal(writes.length, 2); assert.equal(writes[0].body, writes[1].body);
            const saved = await api('/api/rolls/' + id); assert.equal(saved.defects.length, 2); assert.equal(saved.usedLength, 0);
            assert.deepEqual(errors, []);
        });
        await check('an inspection load finishing after navigation cannot replace the active page or leak a stage', async () => {
            await page.locator('#nav a[href="#/tasks"]').click(); await page.waitForFunction(() => Konva.stages.length === 0);
            let release, arrived;
            const waiting = new Promise(resolve => { arrived = resolve; });
            await page.route('**/api/rolls', route => { release = () => route.continue(); arrived(); }, {times: 1});
            await page.evaluate(id => location.hash = '#/inspection/' + id, id); await waiting;
            await page.locator('#nav a[href="#/tasks"]').click(); await page.locator('h1').filter({hasText: '任务'}).waitFor();
            await release(); await page.waitForTimeout(600);
            assert.ok((await page.locator('h1').textContent()).includes('任务'));
            assert.equal(await page.evaluate(() => Konva.stages.length), 0);
            assert.ok(!(await page.locator('#statusbar').textContent()).includes(id));
        });
        if (process.env.SCREENSHOT_PATH) {
            await page.evaluate(id => location.hash = '#/inspection/' + id, id);
            await page.waitForFunction(() => Konva.stages.length === 1); await locate(5);
            await page.screenshot({path: process.env.SCREENSHOT_PATH});
        }
    } finally {
        await browser.close();
        const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
