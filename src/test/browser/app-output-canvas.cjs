// 用真实报工/复检回执验证新版产出画面，仅写显式隔离服务。
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
    const results = [], id = 'OUTPUT-R1-' + randomUUID();
    const roll = {rollId: id, rollModel: id, width: 2000, totalLength: 20000, usedLength: 0};
    await api('/api/rolls', roll);
    const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
        demands: [{id: 1, name: 'R1 构造报工样本', width: 2000, length: 1000, quantity: 4, allowRotation: false}],
        process: {bedLength: 4000, trimStart: 0, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: false, allowLongitudinal: false, pieceGap: 0}});
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const result = await api('/api/solve', buildSolveRequest({task, roll, win: {start: 2000, len: 4000}}));
    assert.equal(result.success, true, result.message); assert.equal(result.pieces.length, 4);
    const ordered = [...result.pieces].sort((a, b) => a.y - b.y), [good, recover, rejected, uncut] = ordered;
    assert.deepEqual(ordered.map(p => p.y), [0, 1000, 2000, 3000]);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [];
    page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    const url = base + '/app/#/workbench/' + task.id + '/' + result.planId;
    const nodes = () => page.evaluate(() => Konva.stages.find(s => s.container().id === 'rc').find('.roll-piece')
        .map(p => ({id: p.getAttr('pieceId'), x: p.x(), y: p.y(), fill: p.fill()})));
    const waitCanvas = count => page.waitForFunction(count => Konva.stages.find(s => s.container().id === 'rc')?.find('.roll-piece').length === count, count);
    const reload = async count => { await page.goto(url); await page.reload(); await waitCanvas(count); await frames(page); };
    const field = async (name, value) => { const input = page.locator(`[data-q="${name}"]`); await input.fill(String(value)); await input.dispatchEvent('change'); };
    async function check(name, fn) {
        try { await fn(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); throw e; }
    }
    let receipt, bookedRoll, review;
    try {
        await reload(4);
        await check('candidate and report draft remain previews without booking stock', async () => {
            await page.locator('#report-open').click(); await frames(page);
            assert.ok(await page.evaluate(() => Konva.stages[0].find('Text').some(t => t.text().includes('草稿合格'))));
            await page.locator('#report-close').click(); assert.deepEqual(writes, []);
            assert.equal((await api('/api/rolls/' + id)).usedLength, 0);
        });
        receipt = await api('/api/cutting/report-confirm', {planId: result.planId, actualCutLen: 3500, finishedPieceCount: 2, location: 'R1 验证库位',
            pieceResults: ordered.map(p => ({pieceId: p.id, outcome: p.id === uncut.id ? 'UNCUT' : p.id === rejected.id ? 'REJECTED' : 'QUALIFIED', reason: p.id === rejected.id ? '破损' : ''})),
            actualRemnants: [{id: 'UNCUT-' + uncut.id, x: uncut.x, y: uncut.y, w: 2000, l: 500, area: 1, hasDefect: false}]});
        bookedRoll = await api('/api/rolls/' + id);
        await reload(3);
        await check('partial report shows only actual outputs, actual recovered material and actual cut length', async () => {
            assert.deepEqual((await nodes()).map(p => p.id).sort(), [good.id, recover.id, rejected.id].sort());
            assert.equal((await nodes()).find(p => p.id === rejected.id).fill, '#c0392b');
            assert.equal((await nodes()).find(p => p.id === good.id).fill, '#4c956c');
            const rem = await page.evaluate(() => Konva.stages[0].find('.roll-remnant').map(p => ({id: p.getAttr('remnantId'), x: p.x(), y: p.y(), w: p.width(), l: p.height()})));
            assert.deepEqual(rem, [{id: receipt.recoveredGeometry[0].id, x: 0, y: 5000, w: 2000, l: 500}]);
            assert.equal(await page.locator('#bed-len').inputValue(), '3500');
            assert.match(await page.locator('.pane').last().innerText(), /合格 2 · 异常 1 · 未切 1/);
            assert.equal(bookedRoll.usedLength, 5500, 'skipped lead and actual cut length remain booked');
        });
        const quality = '/api/cutting/reports/' + result.planId + '/quality-dispositions';
        await check('quality scrap updates the canvas through the normal workbench command', async () => {
            await page.locator('#quality-open').click(); await page.locator('[data-q="pieceId"]').selectOption(String(good.id));
            await field('inspector', 'R1 验证员'); await field('reason', '复检报废验证');
            await page.locator('#quality-submit').click(); await page.locator('#quality-open').waitFor(); await frames(page);
            assert.equal((await nodes()).find(p => p.id === good.id).fill, '#a4504a');
            assert.ok(await page.evaluate(() => Konva.stages[0].find('Text').some(t => t.text().includes('复检报废'))));
        });
        await check('quality recovery is overlaid at piece-local coordinates and retains isolation status', async () => {
            await page.locator('#quality-open').click(); await page.locator('[data-q="pieceId"]').selectOption(String(recover.id));
            await page.locator('[data-q="disposition"]').selectOption('REMNANT');
            for (const [k, v] of Object.entries({inspector: 'R1 验证员', reason: '局部回收验证', x: 100, y: 100, width: 500, length: 500, location: 'R1 待检架'})) await field(k, v);
            await page.locator('#quality-submit').click(); await page.locator('#quality-open').waitFor(); await frames(page);
            review = await api(quality); const event = review.qualityDispositions[1];
            const rem = await page.evaluate(id => {
                const n = Konva.stages[0].find('.roll-remnant').find(n => n.getAttr('remnantId') === id);
                return {x: n.x(), y: n.y(), w: n.width(), l: n.height(), z: n.zIndex()};
            }, event.remnantId);
            assert.deepEqual([rem.x, rem.y, rem.w, rem.l], [recover.x + 100, recover.y + 2100, 500, 500]);
            assert.ok(rem.z > await page.evaluate(id => Konva.stages[0].find('.roll-piece').find(n => n.getAttr('pieceId') === id).zIndex(), recover.id));
            assert.equal((await nodes()).find(p => p.id === recover.id).fill, '#bd9454');
            assert.equal((await api('/api/remnants?includeQuarantined=true')).find(r => r.id === event.remnantId).status, 'QUARANTINED');
        });
        await check('reload, orientation and whole-roll navigation preserve current production without additional writes', async () => {
            const beforeWrites = writes.length;
            await reload(3); await page.locator('#orient').click();
            await page.locator('[data-view="full"]').click(); await page.locator('[data-full="tile"]').click(); await frames(page);
            await page.locator('[data-view="station"]').click(); await frames(page);
            assert.equal((await nodes()).find(p => p.id === recover.id).fill, '#bd9454');
            assert.equal(writes.length, beforeWrites); assert.equal(writes.length, 2);
            assert.deepEqual(await api('/api/rolls/' + id), bookedRoll);
            const after = await api(quality); assert.deepEqual(after.pieceResults, receipt.pieceResults);
            assert.equal(after.netFinishedPieceCount, 0); assert.equal(after.qualityRevision, 2);
            assert.deepEqual(errors, []);
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
        });
        await check('reported native irregular outline survives without another rotation', async () => {
            const polyId = id + '-POLY', polyRoll = {...roll, rollId: polyId, rollModel: polyId}; await api('/api/rolls', polyRoll);
            const shape = {type: 'POLYGON', width: 300, height: 400, vertices: [{x: 0, y: 0}, {x: 300, y: 0}, {x: 300, y: 150}, {x: 100, y: 150}, {x: 100, y: 400}, {x: 0, y: 400}]};
            const t = await api('/api/cutting/tasks', {...task, id: undefined, name: polyId, materialModel: polyId, revision: 0,
                demands: [{id: 1, name: '构造凹轮廓', width: 300, length: 400, quantity: 1, shape, allowRotation: true}], process: {...task.process, allowRotation: true, allowLongitudinal: true}});
            const p = await api('/api/solve', buildSolveRequest({task: t, roll: polyRoll, win: {start: 1000, len: 1000}}));
            assert.equal(p.engine, 'packingsolver-irregular'); assert.ok(!p.fallbackReason); assert.equal(p.pieces.length, 1);
            const r = await api('/api/cutting/report-confirm', {planId: p.planId, actualCutLen: 1000, finishedPieceCount: 1, actualRemnants: []});
            await page.goto(base + '/app/#/workbench/' + t.id + '/' + p.planId); await waitCanvas(1);
            const node = await page.evaluate(() => { const n = Konva.stages[0].findOne('.roll-piece'); return {points: n.points(), x: n.x(), y: n.y()}; });
            assert.deepEqual(node.points, r.pieceResults[0].shape.vertices.flatMap(v => [v.x, v.y]));
            assert.deepEqual([node.x, node.y], [r.pieceResults[0].x, 1000 + r.pieceResults[0].y]);
        });
    } finally {
        await browser.close(); const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
