// Constructed contour layout, real native solve and saved adjustment API; isolated inventory only.
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
    const id = 'R1-ADJUST-' + randomUUID(), results = [];
    await api('/api/rolls', {rollId: id, rollModel: id, width: 1800, totalLength: 12000, usedLength: 0,
        defects: [{id: 71, x: 1300, y: 2300, w: 100, h: 100, margin: 20}]});
    const roll = await api('/api/rolls/' + id);
    const shape = {type: 'POLYGON', width: 300, height: 400, vertices: [
        {x: 0, y: 0}, {x: 300, y: 0}, {x: 300, y: 150}, {x: 100, y: 150}, {x: 100, y: 400}, {x: 0, y: 400}]};
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
        demands: [{id: 1, name: '构造可旋转凹轮廓', width: 300, length: 400, quantity: 2, allowRotation: true, shape},
            {id: 2, name: '构造固定纱向', width: 200, length: 200, quantity: 1, allowRotation: false, shape: {type: 'RECTANGLE', width: 200, height: 200}}],
        process: {bedLength: 1000, trimStart: 20, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: true, allowLongitudinal: true, pieceGap: 20}});
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start: 2000, len: 1000}, settings: {timeLimitSeconds: 2}}));
    assert.equal(result.success, true, result.message); assert.equal(result.engine, 'packingsolver-irregular');
    const polygons = result.pieces.filter(p => p.demandId === 1), fixed = result.pieces.find(p => p.demandId === 2);
    const first = polygons[0].id, second = polygons[1].id;
    let plan = await api('/api/cutting/plans/' + result.planId + '/adjust', {adjustmentId: randomUUID(), pieces: [
        {id: first, x: 100, y: 100, rotated: false, rotationDegrees: 0},
        {id: second, x: 650, y: 100, rotated: false, rotationDegrees: 0},
        {id: fixed.id, x: 1000, y: 100, rotated: false, rotationDegrees: 0}]});
    const original = structuredClone(plan), before = await api('/api/rolls/' + id);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push({url: r.url(), body: r.postData()}); });
    const node = pieceId => page.evaluate(id => {
        const n = Konva.stages[0].find('.roll-piece').find(n => n.getAttr('pieceId') === id);
        return {x: n.x(), y: n.y(), points: n.getClassName() === 'Line' ? n.points() : null};
    }, pieceId);
    const point = (pieceId, x = 20, y = 20) => page.evaluate(([id, x, y]) => {
        const stage = Konva.stages[0], n = stage.find('.roll-piece').find(n => n.getAttr('pieceId') === id), b = stage.container().getBoundingClientRect();
        const q = n.getAbsoluteTransform().point({x, y}); return {x: q.x + b.x, y: q.y + b.y};
    }, [pieceId, x, y]);
    const pick = async (id, x, y) => {
        const p = await point(id, x, y); await page.mouse.click(p.x, p.y); await frames(page);
        assert.match(await page.locator('#adjust .kv').innerText(), new RegExp('选中\\s*#' + id + ' ·'));
    };
    const position = async (x, y) => {
        await page.locator('#adj-x').fill(String(x)); await page.locator('#adj-y').fill(String(y));
        await page.locator('#adj-position').click(); await frames(page);
    };
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    try {
        await page.goto(base + '/app/#/workbench/' + task.id + '/' + plan.id);
        await page.locator('#adjust-open').click(); await frames(page);
        await check('invalid drag shows real outlines, returns to the original and adds no history or write', async () => {
            const start = await point(first), end = await point(first, 570, 20);
            await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, {steps: 4}); await frames(page);
            assert.equal(await page.evaluate(() => Konva.stages[0].find('.roll-diagnostic').length), 2);
            await page.mouse.up(); await frames(page);
            assert.deepEqual(await node(first), {x: 100, y: 2100, points: shape.vertices.flatMap(v => [v.x, v.y])});
            assert.match(await page.locator('#adj-problem').innerText(), new RegExp('裁片 #' + second));
            assert.ok(await page.locator('#adj-undo').isDisabled()); assert.ok(await page.locator('#adj-save').isDisabled());
            assert.deepEqual(writes, []);
        });
        await check('numeric and keyboard moves share gap checks; diagnostic focus is reachable on both desktop sizes', async () => {
            await position(330, 100); assert.ok(await page.locator('#adj-save').isEnabled());
            const prior = await node(first); await page.locator('#rc').focus();
            // Horizontal view maps ArrowDown to +X; vertical view maps ArrowRight to +X.
            const horizontal = await page.evaluate(() => Konva.stages[0].findOne('.roll-piece').getParent().getParent().rotation() === 90);
            await page.keyboard.press(horizontal ? 'ArrowDown' : 'ArrowRight'); await frames(page);
            assert.deepEqual(await node(first), prior); assert.match(await page.locator('#adj-problem').innerText(), /20 mm/);
            for (const [width, height] of [[1366, 768], [1920, 1080]]) {
                await page.setViewportSize({width, height}); await page.locator('#adj-problem-fit').click(); await frames(page);
                const fits = await page.evaluate(() => {
                    const stage = Konva.stages[0]; return stage.find('.roll-diagnostic').every(n => {
                        const r = n.getClientRect(); return r.x >= 20 && r.y >= 20 && r.x + r.width <= stage.width() && r.y + r.height <= stage.height();
                    });
                }); assert.ok(fits);
                const overflow = await page.locator('#adjust').evaluate(e => e.scrollWidth > e.clientWidth + 1); assert.equal(overflow, false);
            }
            await page.locator('#adj-undo').click(); await frames(page); assert.equal((await node(first)).x, 100);
        });
        await check('defect, trim, boundary and invalid numeric diagnostics reject edits without changing the plan', async () => {
            await position(1300, 300); assert.match(await page.locator('#adj-problem').innerText(), /疵点 #71/);
            await page.locator('#adj-problem-fit').click(); await frames(page);
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
            await position(100, 0); assert.match(await page.locator('#adj-problem').innerText(), /修齐/);
            await position(100, 800); assert.match(await page.locator('#adj-problem').innerText(), /边界/);
            await position('', 100); assert.match(await page.locator('#adj-problem').innerText(), /有效数字/);
            await position('100.01', 100); assert.match(await page.locator('#adj-problem').innerText(), /0.1 mm/);
            const saved = await api('/api/cutting/plans/' + plan.id);
            assert.deepEqual(saved.result.pieces, original.result.pieces); assert.equal(saved.status, 'PENDING');
            assert.equal((await node(first)).x, 100); assert.equal((await node(first)).y, 2100); assert.deepEqual(writes, []);
        });
        await check('grain permission blocks fixed pieces, while two quarter-turns save a real 180-degree contour', async () => {
            await page.locator('#z-fit').click(); await frames(page); await pick(fixed.id);
            assert.ok(await page.locator('#adj-rotate').isDisabled()); const unchanged = await node(fixed.id);
            await page.keyboard.press('r'); await frames(page); assert.deepEqual(await node(fixed.id), unchanged);
            await pick(first); await page.keyboard.press('r'); await frames(page); await page.keyboard.press('r'); await frames(page);
            const points = shape.vertices.flatMap(v => [300 - v.x, 400 - v.y]);
            assert.deepEqual((await node(first)).points, points); assert.ok(await page.locator('#adj-save').isEnabled());
            await page.locator('#adj-undo').click(); await page.locator('#adj-redo').click(); await frames(page);
            assert.deepEqual((await node(first)).points, points);
            const response = page.waitForResponse(r => r.url().endsWith('/plans/' + plan.id + '/adjust') && r.request().method() === 'POST');
            await page.locator('#adj-save').click(); const saved = await response; assert.ok(saved.ok()); plan = await saved.json();
            await page.locator('#adjust-open').waitFor();
            const actual = plan.result.pieces.find(p => p.id === first);
            assert.equal(actual.rotationDegrees, 180); assert.deepEqual(actual.shape.vertices.flatMap(v => [v.x, v.y]), points);
            assert.equal(plan.version, original.version + 1);
            assert.deepEqual(await api('/api/rolls/' + id), before);
        });
        await check('server still rejects a direct overlapping adjustment and keeps the valid candidate intact', async () => {
            const positions = plan.result.pieces.map(p => ({id: p.id, x: p.id === first ? 650 : p.x, y: p.y, rotated: p.rotated, rotationDegrees: p.rotationDegrees}));
            const r = await fetch(base + '/api/cutting/plans/' + plan.id + '/adjust', {method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({adjustmentId: randomUUID(), pieces: positions})});
            assert.equal(r.status, 400); assert.equal((await api('/api/cutting/plans/' + plan.id)).status, 'PENDING');
            assert.deepEqual(await api('/api/rolls/' + id), before);
        });
        await check('lost adjustment response retries the identical command and creates only one version', async () => {
            await page.locator('#adjust-open').click(); await frames(page);
            // The lower-right interior remains inside the L after its half-turn.
            await pick(first, 280, 380); await position(100, 550);
            const prior = plan, path = '**/api/cutting/plans/' + plan.id + '/adjust';
            await page.route(path, async route => {
                const response = await route.fetch(); assert.ok(response.ok());
                await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({message: '模拟保存成功后响应丢失'})});
            }, {times: 1});
            await page.locator('#adj-save').click(); await page.getByText(/模拟保存成功后响应丢失/).waitFor();
            const firstBody = writes.at(-1).body;
            const response = page.waitForResponse(r => r.url().endsWith('/plans/' + prior.id + '/adjust') && r.request().method() === 'POST');
            await page.locator('#adj-save').click(); const saved = await response; assert.ok(saved.ok()); plan = await saved.json();
            await page.locator('#adjust-open').waitFor(); assert.equal(writes.at(-1).body, firstBody);
            assert.equal(plan.version, prior.version + 1);
            const plans = await api('/api/cutting/tasks/' + task.id + '/plans');
            assert.equal(plans.filter(p => p.status === 'PENDING').length, 1);
            assert.equal(plans.length, 4, 'native result, fixture layout, half-turn and one retried move');
        });
        await check('all saved edits preserve source geometry, reports and production inventory', async () => {
            const savedOriginal = await api('/api/cutting/plans/' + original.id);
            assert.deepEqual(savedOriginal.result.pieces, original.result.pieces);
            assert.deepEqual(await api('/api/rolls/' + id), before);
            assert.deepEqual((await api('/api/cutting/tasks/' + task.id)).reports, []);
            assert.equal(writes.length, 3); assert.ok(writes.every(w => w.url.endsWith('/adjust'))); assert.deepEqual(errors, []);
        });
    } finally {
        await browser.close();
        const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
