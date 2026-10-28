// Real candidate and report data, isolated service only; selection itself never writes business state.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080');
const api = async (path, body) => {
    const response = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
(async () => {
    const id = 'R1-REMNANT-' + randomUUID(), roll = {rollId: id, rollModel: id, width: 2000, totalLength: 12000, usedLength: 0};
    await api('/api/rolls', roll);
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
        demands: [{id: 1, name: '余料属性构造件', width: 500, length: 600, quantity: 1, allowRotation: false}],
        process: {bedLength: 2000, trimStart: 0, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: false, allowLongitudinal: true, pieceGap: 0}});
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start: 2000, len: 2000},
        settings: {timeLimitSeconds: 1, minRemnantWidth: 100, minRemnantLength: 100}}));
    assert.equal(result.success, true); assert.equal(result.engine, 'packingsolver');
    assert.ok(result.remnants.every(r => typeof r.id === 'string'), 'published remnant IDs are strings');
    const remnant = result.remnants.find(r => r.y + r.l <= result.deductLen + .001); assert.ok(remnant);
    const saved = await api('/api/cutting/plans/' + result.planId), initialStock = await api('/api/rolls/' + id);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), results = [], errors = [], writes = [];
    // Spy on the public scene adapter in this test page, without changing production exports.
    await page.route('**/app/js/model/roll-scene.js', async route => {
        const response = await route.fetch(), source = await response.text();
        assert.ok(source.includes('export function buildRollScene('));
        await route.fulfill({response, body: source.replace('export function buildRollScene(', 'function trackedBuildRollScene(')
            + '\nexport function buildRollScene(...args) { globalThis.__sceneBuilds = (globalThis.__sceneBuilds || 0) + 1; return trackedBuildRollScene(...args); }\n'});
    });
    page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    const url = base + '/app/#/workbench/' + task.id + '/' + result.planId;
    const goto = async () => { await page.goto(url); await page.waitForSelector('#rc canvas'); await frames(page); };
    const point = () => page.evaluate(id => {
        const s = Konva.stages.find(s => s.container().id === 'rc'), n = s.find('.roll-remnant').find(n => n.getAttr('remnantId') === id), b = s.container().getBoundingClientRect();
        const p = n.getAbsoluteTransform().point({x: n.width() / 2, y: n.height() / 2}); return {x: p.x + b.x, y: p.y + b.y};
    }, remnant.id);
    const select = async () => { const p = await point(); await page.mouse.click(p.x, p.y); await frames(page); };
    const highlighted = () => page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').find('.roll-remnant-selection').length);
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); throw e; }
    }
    try {
        await goto();
        await check('an empty click with no remnant selected does not rebuild the scene', async () => {
            const blank = await page.evaluate(() => {
                const s = Konva.stages[0], b = s.container().getBoundingClientRect(), p = s.getLayers()[0].getChildren()[0].getAbsoluteTransform().point({x: 1000, y: 1950});
                globalThis.__sceneBuilds = 0; return {x: b.x + p.x, y: b.y + p.y};
            });
            await page.mouse.click(blank.x, blank.y); await frames(page);
            assert.equal(await page.evaluate(() => globalThis.__sceneBuilds), 0); assert.equal(await highlighted(), 0);
        });
        await check('table and canvas selection share a read-only property card without remounting the stage', async () => {
            await page.evaluate(() => { window.originalStage = Konva.stages[0]; globalThis.__sceneBuilds = 0; });
            const button = page.locator('[data-remnant-select]').filter({hasText: '查看'}).first(); await button.click(); await frames(page);
            assert.equal(await page.evaluate(() => globalThis.__sceneBuilds), 1, 'selection builds exactly one scene');
            assert.equal(await button.getAttribute('aria-pressed'), 'true'); assert.equal(await highlighted(), 1);
            assert.match(await page.locator('#remnant-details').innerText(), /尚未入库/);
            await page.locator('#remnant-close').click(); await frames(page); assert.equal(await highlighted(), 0);
            await select(); assert.ok((await page.locator('#remnant-details').innerText()).includes(remnant.id));
            assert.ok(Math.abs(Number((await page.locator('#remnant-details').innerText()).match(/轮廓面积\s+([\d,.]+)/)[1].replaceAll(',', '')) - remnant.w * remnant.l / 1e6) < .00051);
            assert.equal(await page.evaluate(() => Konva.stages[0] === originalStage), true);
            await page.locator('#rc').focus(); await page.keyboard.press('Escape'); await frames(page);
            assert.equal(await page.locator('#remnant-details').count(), 0); assert.equal(await highlighted(), 0);
            assert.deepEqual(writes, []);
        });
        await check('context properties, folded sidebar and tiled focus remain reachable and clear on station change', async () => {
            const p = await point(); await page.mouse.click(p.x, p.y, {button: 'right'}); await page.locator('[data-canvas-action="properties"]').click(); await frames(page);
            assert.equal(await highlighted(), 1); await page.locator('#remnant-close').click();
            await page.locator('#side-toggle').click(); await frames(page); await select();
            assert.equal(await page.locator('#remnant-details').count(), 1);
            await page.locator('[data-view="full"]').click(); await page.locator('[data-full="tile"]').click(); await frames(page);
            assert.ok(await highlighted() > 0); await page.locator('#remnant-fit').click(); await frames(page);
            assert.ok((await page.locator('[data-view="station"]').getAttribute('class')).includes('on'));
            await page.locator('#seg-next').click(); await frames(page);
            assert.equal(await page.locator('#remnant-details').count(), 0); assert.equal(await highlighted(), 0);
            await page.locator('#seg-prev').click(); await page.locator('#z-fit').click(); await frames(page);
            assert.deepEqual(writes, []);
        });
        await check('property actions are reachable by keyboard on wide and narrow layouts', async () => {
            for (const width of [1920, 640]) {
                await page.setViewportSize({width, height: 768});
                const button = page.locator('[data-remnant-select]').first(); await button.scrollIntoViewIfNeeded(); await button.focus(); await page.keyboard.press('Enter'); await frames(page);
                const card = page.locator('#remnant-details'); await card.scrollIntoViewIfNeeded();
                const box = await card.boundingBox(); assert.ok(box.x < width && box.x + box.width > 0);
                assert.equal(await highlighted(), 1); await page.locator('#remnant-close').click(); await frames(page);
                assert.equal(await page.locator('#remnant-details').count(), 0);
            }
            await page.setViewportSize({width: 1366, height: 768}); await page.locator('#z-fit').click(); await frames(page);
        });
        await check('selection during report entry preserves form values and scroll position without booking inventory', async () => {
            await page.setViewportSize({width: 1366, height: 480});
            await page.locator('#report-open').click(); await frames(page);
            const field = page.locator('[data-r="location"]'); await field.fill('未提交的料头库位'); await field.dispatchEvent('change'); await frames(page);
            await page.locator('#z-fit').click(); await frames(page);
            const beforeScroll = await page.evaluate(() => {
                const b = document.querySelector('#report .pane-b'); b.scrollTop = 150;
                return {top: b.querySelector('[data-r="location"]').getBoundingClientRect().top, scroll: b.scrollTop};
            });
            assert.ok(beforeScroll.scroll > 20, 'exercise a scrolled form');
            await select(); assert.equal(await field.inputValue(), '未提交的料头库位');
            assert.equal(await page.locator('#report').count(), 1); assert.equal(await page.locator('#remnant-details').count(), 1);
            assert.ok(Math.abs((await field.boundingBox()).y - beforeScroll.top) < 1, 'inserting details preserves the visible form position');
            await page.locator('#rc').focus(); await page.keyboard.press('Escape'); await frames(page);
            assert.ok(Math.abs((await field.boundingBox()).y - beforeScroll.top) < 1, 'clearing details preserves the visible form position');
            assert.equal(await field.inputValue(), '未提交的料头库位');
            await page.locator('#report-close').click();
            await page.setViewportSize({width: 1366, height: 768}); await page.locator('#z-fit').click(); await frames(page);
            assert.deepEqual(await api('/api/cutting/plans/' + result.planId), saved); assert.deepEqual(await api('/api/rolls/' + id), initialStock);
            assert.deepEqual(writes, []);
        });
        await check('a constructed concave remnant uses contour area and excludes its empty bounding-box corner', async () => {
            const w = remnant.w, h = remnant.l, shape = {type: 'POLYGON', width: w, height: h, vertices: [
                {x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h / 2}, {x: w / 2, y: h / 2}, {x: w / 2, y: h}, {x: 0, y: h}]};
            const route = '**/api/cutting/tasks/' + task.id + '/plans';
            await page.route(route, async intercepted => {
                const response = await intercepted.fetch(), plans = await response.json();
                plans.find(p => p.id === result.planId).result.remnants.find(r => r.id === remnant.id).shape = shape;
                await intercepted.fulfill({response, json: plans});
            });
            try {
                await page.reload(); await page.waitForSelector('[data-remnant-select]');
                await page.locator('[data-remnant-select="' + remnant.id + '"]').click(); await frames(page);
                const text = await page.locator('#remnant-details').innerText(); assert.match(text, /异形/);
                assert.ok(Math.abs(Number(text.match(/轮廓面积\s+([\d,.]+)/)[1].replaceAll(',', '')) - w * h * .75 / 1e6) < .00051);
                assert.deepEqual(await page.evaluate(() => Konva.stages[0].findOne('.roll-remnant-selection').points()), shape.vertices.flatMap(p => [p.x, p.y]));
                const gap = await page.evaluate(({id, w, h}) => {
                    const s = Konva.stages[0], n = s.find('.roll-remnant').find(n => n.getAttr('remnantId') === id), b = s.container().getBoundingClientRect();
                    const p = n.getAbsoluteTransform().point({x: w * .75, y: h * .75}); return {x: p.x + b.x, y: p.y + b.y};
                }, {id: remnant.id, w, h});
                await page.mouse.click(gap.x, gap.y); await frames(page); assert.equal(await highlighted(), 0);
                assert.deepEqual(await api('/api/cutting/plans/' + result.planId), saved);
            } finally { await page.unroute(route); await page.reload(); await page.waitForSelector('#rc canvas'); await frames(page); }
        });
        await check('reported recovery shows actual measured geometry and registration status without claiming current stock availability', async () => {
            const actual = {id: remnant.id, x: remnant.x, y: remnant.y, w: remnant.w / 2, l: remnant.l,
                area: remnant.w / 2 * remnant.l / 1e6, hasDefect: remnant.hasDefect};
            await api('/api/cutting/report-confirm', {planId: result.planId, actualCutLen: result.deductLen, finishedPieceCount: result.pieces.length,
                location: 'isolated recovery', pieceResults: result.pieces.map(p => ({pieceId: p.id, outcome: 'QUALIFIED', reason: ''})), actualRemnants: [actual]});
            const booked = await api('/api/rolls/' + id), archive = await api('/api/cutting/tasks/' + task.id);
            await page.reload(); await page.waitForSelector('[data-remnant-select]'); await page.locator('[data-remnant-select]').first().click(); await frames(page);
            const text = await page.locator('#remnant-details').innerText();
            assert.match(text, /实际回收登记/); assert.match(text, /当前可用性请以库存档案为准/);
            assert.ok(Math.abs(Number(text.match(/轮廓面积\s+([\d,.]+)/)[1].replaceAll(',', '')) - actual.area) < .00051);
            await page.locator('#remnant-fit').click(); await page.locator('#orient').click(); await frames(page); assert.equal(await highlighted(), 1);
            assert.deepEqual(await api('/api/rolls/' + id), booked); assert.deepEqual(await api('/api/cutting/tasks/' + task.id), archive);
            await page.locator('#remnant-close').click(); await frames(page); assert.equal(await highlighted(), 0);
            await page.evaluate(() => { location.hash = '/tasks'; }); await page.waitForFunction(() => Konva.stages.length === 0);
            assert.equal(await page.locator('#remnant-details').count(), 0);
            await goto(); assert.equal(await page.locator('#remnant-details').count(), 0); assert.equal(await highlighted(), 0);
            assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        });
    } finally {
        await browser.close();
        const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
