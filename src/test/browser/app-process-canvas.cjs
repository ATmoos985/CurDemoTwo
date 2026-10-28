// Four corners on rolls and remnant sheets, with real native results and explicit isolated stock.
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
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), results = [], errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    try {
        for (const feedPortType of ['roll', 'remnant']) for (const cutOrigin of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
            await check(`${feedPortType}/${cutOrigin}: native result, datum, trim and orientation preserve world coordinates and stock`, async () => {
                const id = 'R1-ORIGIN-' + randomUUID(), roll = {rollId: id, rollModel: id, width: 2000, totalLength: 16000, usedLength: 0};
                await api('/api/rolls', roll);
                const stock = feedPortType === 'remnant' ? await api('/api/remnants/register', {id: id + '-SHEET', materialBatch: id,
                    sourceRollId: id, width: 2000, length: 4000, location: 'isolated datum test', status: 'AVAILABLE'}) : null;
                const start = stock ? 0 : 5000;
                const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
                    demands: [{id: 1, name: '四角构造裁片', width: 300, length: 400, quantity: 2, allowRotation: false}],
                    process: {bedLength: 4000, trimStart: 25.5, cutOrigin, firstStageOrientation: 'horizontal', allowRotation: false, allowLongitudinal: true, pieceGap: 0}});
                const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start, len: 4000}, settings: {timeLimitSeconds: 1},
                    feed: stock ? {feedPortType, sourceRemnantId: stock.id, totalRollL: stock.length} : undefined}));
                assert.equal(result.success, true, result.message); assert.equal(result.engine, 'packingsolver'); assert.ok(!result.fallbackReason);
                assert.equal(result.pieces.length, 2);
                if (!stock) assert.ok(result.deductLen < 4000, 'exercise a short consumed span within the original bed');
                const before = await api('/api/cutting/tasks/' + task.id);
                await page.goto(base + '/app/#/workbench/' + task.id + '/' + result.planId);
                await page.waitForFunction(() => globalThis.Konva?.stages.some(s => s.container().id === 'rc' && s.find('.roll-piece').length === 2));
                await frames(page);
                const datum = {x: cutOrigin.startsWith('right') ? 2000 : 0, y: start + (cutOrigin.endsWith('bottom') ? 3974.5 : 25.5)};
                const label = `${cutOrigin.startsWith('right') ? '右' : '左'}${cutOrigin.endsWith('bottom') ? '下' : '上'}`;
                for (let orientation = 0; orientation < 2; orientation++) {
                    const drawn = await page.evaluate(datum => {
                        const s = Konva.stages.find(s => s.container().id === 'rc'), pieces = s.find('.roll-piece'), world = pieces[0].getParent().getParent();
                        const o = s.findOne('.roll-origin'), b = s.container().getBoundingClientRect(), p = pieces[0];
                        const target = p.getAbsoluteTransform().point({x: p.width() / 2, y: p.height() / 2});
                        return {datum: o && {x: o.x(), y: o.y()}, expected: world.getAbsoluteTransform().point(datum), width: s.width(), height: s.height(),
                            pieces: pieces.map(n => ({id: n.getAttr('pieceId'), x: n.x(), y: n.y(), w: n.width(), l: n.height()})),
                            cursor: {x: b.x + target.x, y: b.y + target.y}, grid: s.find('.roll-grid').length, paths: s.find('.roll-path').length};
                    }, datum);
                    assert.ok(drawn.datum); assert.ok(Math.abs(drawn.datum.x - drawn.expected.x) < 1e-6); assert.ok(Math.abs(drawn.datum.y - drawn.expected.y) < 1e-6);
                    assert.ok(drawn.datum.x > 22 && drawn.datum.x < drawn.width && drawn.datum.y > 22 && drawn.datum.y < drawn.height, 'fit keeps the original bed datum reachable');
                    for (const p of result.pieces) assert.deepEqual(drawn.pieces.find(n => n.id === p.id), {id: p.id, x: p.x, y: p.y + start, w: p.w, l: p.l});
                    assert.ok(drawn.grid > 0); assert.equal(drawn.paths, 0);
                    await page.mouse.move(drawn.cursor.x, drawn.cursor.y); await frames(page);
                    const status = await page.locator('#statusbar').innerText();
                    assert.ok(status.includes(`距${label}基准`)); assert.match(status, /基准\s+X [-\d,.]+ · Y [-\d,.]+ mm/);
                    await page.locator('#orient').click(); await frames(page);
                }
                await page.locator('#path-toggle').click(); await frames(page);
                assert.deepEqual(await page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').find('.roll-cut').map(n => n.points())),
                    result.cuts.map(c => [c.startX, start + c.startY, c.endX, start + c.endY]));
                await page.locator('#path-toggle').click(); await frames(page);
                assert.equal((await api('/api/rolls/' + id)).usedLength, 0);
                if (stock) assert.deepEqual((await api('/api/remnants')).find(r => r.id === stock.id), stock);
                assert.deepEqual(await api('/api/cutting/tasks/' + task.id), before);
            });
        }
        await check('view-only operations make no business requests or console errors', async () => {
            assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        });
    } finally { await browser.close(); }
    const failed = results.filter(r => !r.success).length;
    console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
