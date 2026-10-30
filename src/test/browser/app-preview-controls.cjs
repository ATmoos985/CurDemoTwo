// Synthetic tasks with real native contours, on explicit isolated inventory only.
const assert = require('node:assert/strict');
const {randomUUID, createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'explicit isolated service required');
const api = async (path, body, headers = {}) => {
    const r = await fetch(base + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)} : {});
    const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value;
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const stateHash = () => process.env.STATE_PATH ? createHash('sha256').update(readFileSync(process.env.STATE_PATH)).digest('hex') : null;
const shape = {type: 'POLYGON', width: 300, height: 400, vertices: [
    {x: 0, y: 0}, {x: 300, y: 0}, {x: 300, y: 150}, {x: 100, y: 150}, {x: 100, y: 400}, {x: 0, y: 400}]};

(async () => {
    const {buildSolveRequest} = await import('../../main/resources/static/app/js/model/solve-request.js');
    const {remnantAsRoll} = await import('../../main/resources/static/app/js/model/roll-scene.js');
    const fixture = async (remnant, polygon = true) => {
        const id = 'R1-PREVIEW-' + randomUUID();
        let roll = await api('/api/rolls', {rollId: id, rollModel: id, width: 1500, totalLength: 12000, usedLength: 0});
        roll = await api('/api/rolls/' + id);
        const stock = remnant ? await api('/api/remnants/register', {id: id + '-SHEET', materialBatch: id, sourceRollId: id,
            width: 1500, length: 2000, location: 'isolated preview', status: 'AVAILABLE'}) : null;
        const task = await api('/api/cutting/tasks', {name: id, materialModel: id, revision: 0,
            demands: [{id: 1, name: polygon ? '预览验收凹多边形' : '预览验收矩形', width: 300, length: 400, quantity: 6, allowRotation: true, ...(polygon ? {shape} : {})}],
            process: {bedLength: 2000, trimStart: 0, cutOrigin: 'left-top', firstStageOrientation: 'horizontal', allowRotation: true, allowLongitudinal: true, pieceGap: 5}});
        const solve = async start => {
            const detail = await api('/api/cutting/tasks/' + task.id);
            const result = await api('/api/solve', buildSolveRequest({task, roll: stock ? remnantAsRoll(stock) : roll,
                win: {start, len: 2000}, completed: detail.completed, reserved: detail.reserved, settings: {timeLimitSeconds: 1}}));
            assert.equal(result.success, true, result.message); assert.equal(result.engine, polygon ? 'packingsolver-irregular' : 'packingsolver'); assert.ok(!result.fallbackReason);
            return await api('/api/cutting/plans/' + result.planId);
        };
        let reported = null, other = null;
        if (!stock) {
            reported = await solve(0);
            await api('/api/cutting/report-confirm', {planId: reported.id, actualCutLen: reported.result.deductLen, finishedPieceCount: 1,
                location: 'isolated preview', pieceResults: reported.result.pieces.map((p, i) => ({pieceId: p.id, outcome: i ? 'UNCUT' : 'QUALIFIED', reason: ''})), actualRemnants: []});
            roll = await api('/api/rolls/' + id);
            roll = await api('/api/rolls/' + id + '/inspection-defects', {width: 1500, totalLength: 12000,
                defects: [{x: 1000, y: 8500, w: 30, h: 30, margin: 5, defectType: 'MANUAL_MARK', typeName: '验收疵点', captureId: randomUUID()}]});
            other = await solve(6000);
        }
        return {task, roll, stock, reported, other, plan: await solve(stock ? 0 : 2500)};
    };
    const rollCase = await fixture(false), remCase = await fixture(true);
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), results = [], errors = [], writes = [], downloads = [];
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message)); page.on('download', d => downloads.push(d.suggestedFilename()));
    page.on('request', r => { if (r.method() !== 'GET') writes.push({url: r.url(), body: r.postData()}); });
    // Observe the host's public canvas input; also inspect actual Konva geometry below.
    await page.route('**/app/js/canvas/roll-canvas.js', route => route.fulfill({contentType: 'text/javascript', body: `
        import {createRollCanvas as create} from '../../../js/canvas/roll-canvas.js';
        export function createRollCanvas(...args) { const c = create(...args), set = c.setScene;
            c.setScene = (scene, options) => { globalThis.previewScene = structuredClone(scene); return set(scene, options); }; return c; }`}));
    const scene = () => page.evaluate(() => previewScene);
    const current = async () => { const sc = await scene(); return sc.segments.find(s => s.id === sc.currentId); };
    const goto = async f => {
        // Same-hash navigation does not remount the SPA or fetch updated executions.
        await page.goto('about:blank'); await page.goto(base + '/app/#/workbench/' + f.task.id + '/' + f.plan.id);
        await page.waitForSelector('#rc canvas'); await frames(page);
    };
    const clear = async () => { await page.locator('#preview-clear').click(); await page.locator('#preview-notice').waitFor(); await frames(page); };
    const restore = async () => { await page.locator('#preview-restore').click(); await page.waitForFunction(() => !document.querySelector('#preview-notice')); await frames(page); };
    const geometry = () => page.evaluate(() => {
        const s = Konva.stages.find(s => s.container().id === 'rc');
        const rows = name => s.find(name).map(n => ({segment: n.getAttr('segmentId'), id: n.getAttr('pieceId') ?? n.getAttr('remnantId'),
            x: n.x(), y: n.y(), points: typeof n.points === 'function' ? n.points() : null, width: n.width(), height: n.height()}));
        return {pieces: rows('.roll-piece'), cuts: rows('.roll-cut'), remnants: rows('.roll-remnant')};
    });
    const context = async () => {
        await frames(page);
        const point = async () => page.evaluate(() => {
            const s = Konva.stages.find(s => s.container().id === 'rc'), b = s.container().getBoundingClientRect();
            // Native fixtures leave a free strip at the right edge, inside the material's hit area.
            const w = previewScene.window, x = previewScene.roll.width - 10;
            const point = s.getLayers()[0].getChildren()[0].getAbsoluteTransform().point({x, y: w.start + w.len / 2});
            return {x: b.x + point.x, y: b.y + point.y};
        });
        let p = await point();
        await page.locator('#main').evaluate((el, x) => { if (x < 24 || x > innerWidth - 24) el.scrollLeft += x - innerWidth / 2; }, p.x);
        await frames(page); p = await point();
        await page.mouse.click(p.x, p.y, {button: 'right'});
        try { await page.locator('.canvas-menu').waitFor(); }
        catch (e) { console.error('context point', p, await page.evaluate(() => ({width: innerWidth, height: innerHeight, scene: previewScene.window}))); throw e; }
    };
    const archive = async f => ({roll: await api('/api/rolls/' + f.roll.rollId), stocks: await api('/api/remnants'),
        detail: await api('/api/cutting/tasks/' + f.task.id), plans: await api('/api/cutting/tasks/' + f.task.id + '/plans'),
        executions: await api('/api/v2/execution-orders?taskId=' + f.task.id), hash: stateHash()});
    async function check(name, fn) {
        try { await fn(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); throw e; }
    }
    async function readOnly(f, fn) {
        const before = await archive(f), count = writes.length;
        await fn(); assert.equal(writes.length, count, 'preview makes zero write requests'); assert.deepEqual(await archive(f), before);
    }
    try {
        await check('roll clear/restore preserves exact native contours, ordered cuts, remnants, defects and other stations', async () => {
            await goto(rollCase); await page.locator('#path-toggle').click(); await page.locator('[data-view="full"]').click();
            await frames(page);
            const before = await scene(), drawn = await geometry(); assert.ok(before.defects.length); assert.ok(drawn.cuts.length);
            assert.ok(before.segments.find(s => s.id === rollCase.plan.id).pieces.every(p => p.shape.type === 'POLYGON'));
            await readOnly(rollCase, async () => {
                await clear(); const sc = await scene(), hidden = await current();
                assert.deepEqual(hidden.pieces, []); assert.deepEqual(hidden.cuts, []); assert.deepEqual(hidden.remnants, []);
                assert.deepEqual(sc.roll, before.roll); assert.deepEqual(sc.defects, before.defects);
                assert.deepEqual(sc.segments.filter(s => s.id !== hidden.id), before.segments.filter(s => s.id !== hidden.id));
                assert.ok(!(await geometry()).pieces.some(p => p.segment === hidden.id));
                assert.ok(await page.locator('#report-open').isDisabled()); assert.ok(await page.locator('#exec-create').isDisabled());
                for (const selector of ['[data-export="nc"]', '[data-export="dxf"]', '#ticket-print']) assert.ok(await page.locator(selector).isDisabled());
                assert.equal(await page.locator('#adjust-open, #tp-save, #tp-optimize').count(), 0);
                // Function guards still apply to detached controls retained by external handlers.
                await page.locator('[data-export="nc"]').evaluate(b => { b.disabled = false; b.click(); });
                await page.locator('#report-open').evaluate(b => { b.disabled = false; b.click(); });
                await page.locator('#exec-create').evaluate(b => { b.disabled = false; b.click(); });
                assert.equal(await page.locator('#report').count(), 0); assert.deepEqual(downloads, []);
                await restore(); assert.deepEqual(await scene(), before); assert.deepEqual(await geometry(), drawn);
                assert.ok(await page.locator('#report-open').isEnabled());
            });
        });
        await check('remnant clear/restore preserves native contours and the archived rectangular entire-sheet feed', async () => {
            await goto(remCase); await page.locator('#path-toggle').click(); await frames(page);
            const before = await scene(), drawn = await geometry();
            assert.equal(before.roll.width, remCase.stock.width); assert.equal(before.roll.total, remCase.stock.length);
            assert.ok((await current()).pieces.every(p => p.shape.type === 'POLYGON'));
            await readOnly(remCase, async () => { await clear(); await restore(); assert.deepEqual(await scene(), before); assert.deepEqual(await geometry(), drawn); });
            assert.equal((await scene()).window.len, remCase.stock.length); assert.ok(await page.locator('#bed-len').isDisabled());
        });
        await check('preview actions are reachable from the owned menu with a folded sidebar and three viewport sizes', async () => {
            await goto(remCase);
            await readOnly(remCase, async () => {
                for (const [width, height] of [[1366, 768], [1920, 1080], [640, 768]]) {
                    await page.setViewportSize({width, height}); await page.locator('#side-toggle').click(); await page.locator('#z-fit').click(); await frames(page);
                    await context(); await page.locator('[data-canvas-action="clear-preview"]').click(); await frames(page);
                    assert.equal((await current()).pieces.length, 0); await context();
                    const box = await page.locator('.canvas-menu').boundingBox(); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
                    await page.locator('[data-canvas-action="restore-preview"]').focus(); await page.keyboard.press('Enter');
                    await page.waitForFunction(() => previewScene.segments.find(s => s.id === previewScene.currentId).pieces.length > 0);
                    await page.locator('#side-toggle').click(); await frames(page);
                }
            });
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
            await page.setViewportSize({width: 1366, height: 768});
        });
        await check('active and persisted report drafts and manual edits cannot be cleared or reloaded', async () => {
            await goto(remCase);
            await readOnly(remCase, async () => {
                await page.locator('#report-open').click(); await page.locator('[data-r="location"]').fill('保留这张报工草稿'); await page.locator('[data-r="location"]').press('Tab');
                await context(); assert.ok(await page.locator('[data-canvas-action="clear-preview"]').isDisabled()); assert.ok(await page.locator('[data-canvas-action="reload-remnant"]').isDisabled());
                await page.keyboard.press('Escape'); assert.equal(await page.locator('[data-r="location"]').inputValue(), '保留这张报工草稿');
                await page.locator('#report-close').click(); assert.ok(await page.locator('#preview-clear').isDisabled()); assert.ok(await page.locator('#remnant-reload').isDisabled());
                await page.locator('#report-open').click(); assert.equal(await page.locator('[data-r="location"]').inputValue(), '保留这张报工草稿');
                await page.locator('#report-reset').click(); await page.locator('#report-close').click();
                await page.locator('#adjust-open').click(); await context(); assert.ok(await page.locator('[data-canvas-action="clear-preview"]').isDisabled());
                assert.ok(await page.locator('[data-canvas-action="reload-remnant"]').isDisabled()); await page.keyboard.press('Escape'); await page.locator('#adjust-close').click();
            });
        });
        await check('reloading a remnant reads its archive, clears only its preview, retains demands and supports restore', async () => {
            await goto(remCase); const before = await scene();
            await readOnly(remCase, async () => {
                const fetched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/remnants');
                await page.locator('#remnant-reload').click(); await fetched; await page.locator('#preview-notice').waitFor(); await frames(page);
                assert.equal((await current()).pieces.length, 0); assert.equal((await scene()).window.start, 0); assert.equal((await scene()).window.len, remCase.stock.length);
                await restore(); assert.deepEqual(await scene(), before);
            });
        });
        await check('failed permission reads keep a cleared preview and can be retried without writes', async () => {
            await goto(remCase);
            await readOnly(remCase, async () => {
                await clear(); const path = '**/api/cutting/tasks/' + remCase.task.id + '/plan-checks';
                await page.route(path, route => route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({message: '验收读取失败'})}), {times: 1});
                await page.locator('#preview-restore').click(); await page.getByText(/恢复预览未完成：验收读取失败/).waitFor();
                assert.equal((await current()).pieces.length, 0); assert.ok(await page.locator('#report-open').isDisabled()); await restore();
            });
        });
        await check('refresh, route disposal and material switches discard memory-only preview flags', async () => {
            await goto(remCase);
            await readOnly(remCase, async () => {
                await clear(); await page.reload(); await page.waitForSelector('#preview-clear'); await frames(page); assert.ok((await current()).pieces.length);
                await clear(); await page.evaluate(() => { location.hash = '#/tasks'; }); await page.waitForFunction(() => !document.querySelector('#rc')); await goto(remCase);
                assert.equal(await page.locator('#preview-notice').count(), 0);
                await clear(); await page.locator('[data-pop="material"]').click(); await page.locator('#change-material').click();
                await page.locator('[data-roll="' + remCase.roll.rollId + '"]').click(); await page.waitForSelector('#rc canvas');
                await page.locator('[data-pop="material"]').click(); await page.locator('#change-material').click();
                await page.locator('[data-remnant="' + remCase.stock.id + '"]').click(); await page.waitForSelector('#preview-clear'); await frames(page);
                assert.ok((await current()).pieces.length); assert.equal(await page.locator('#preview-notice').count(), 0);
            });
        });
        await check('late remnant reads cannot remount a disposed page or leak preview state', async () => {
            await goto(remCase);
            await readOnly(remCase, async () => {
                let unblock, entered; const held = new Promise(resolve => { unblock = resolve; }), started = new Promise(resolve => { entered = resolve; });
                await page.route('**/api/remnants', async route => { const response = await route.fetch(); entered(); await held; await route.fulfill({response}); }, {times: 1});
                await page.locator('#remnant-reload').click(); await started;
                await page.evaluate(() => { location.hash = '#/tasks'; }); await page.waitForFunction(() => !document.querySelector('#rc'));
                const received = page.waitForResponse(r => new URL(r.url()).pathname === '/api/remnants'); unblock(); await received; await frames(page);
                assert.equal(await page.evaluate(() => Konva.stages.length), 0); await goto(remCase); assert.equal(await page.locator('#preview-notice').count(), 0);
            });
        });
        await check('draft execution release is blocked while cleared and returns after restoring', async () => {
            const execution = await api('/api/v2/execution-orders', {planId: remCase.plan.id, station: '预览验收'}, {'Idempotency-Key': randomUUID()});
            await goto(remCase);
            await readOnly(remCase, async () => {
                assert.ok(await page.locator('[data-exec="release"]').isEnabled()); await clear(); assert.ok(await page.locator('[data-exec="release"]').isDisabled());
                await page.locator('[data-exec="release"]').evaluate(b => { b.disabled = false; b.click(); }); await restore(); assert.ok(await page.locator('[data-exec="release"]').isEnabled());
            });
            await api('/api/v2/execution-orders/' + execution.id + '/release', {operationId: randomUUID(), expectedVersion: execution.version, reservationSeconds: 1800, reason: ''});
            await goto(remCase);
            await readOnly(remCase, async () => {
                assert.ok(await page.locator('#preview-clear').isDisabled()); assert.ok(await page.locator('#remnant-reload').isDisabled());
                await context(); assert.ok(await page.locator('[data-canvas-action="clear-preview"]').isDisabled()); await page.keyboard.press('Escape');
            });
            const view = (await api('/api/v2/execution-orders?taskId=' + remCase.task.id)).find(v => v.execution.id === execution.id);
            await api('/api/v2/execution-orders/' + execution.id + '/cancel', {operationId: randomUUID(), expectedVersion: view.execution.version, reservationSeconds: 0, reason: '隔离验收结束'});
        });
        await check('failed recompute keeps the original candidate hidden and blocks overlapping preview operations', async () => {
            await goto(rollCase); await clear(); const before = await archive(rollCase), count = writes.length;
            let unblock, entered; const held = new Promise(resolve => { unblock = resolve; }), started = new Promise(resolve => { entered = resolve; });
            await page.route('**/api/solve', async route => { entered(); await held; await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({message: '验收重算失败'})}); }, {times: 1});
            await page.locator('#solve').click(); await started;
            assert.ok(await page.locator('#preview-restore').isDisabled()); await context(); assert.ok(await page.locator('[data-canvas-action="restore-preview"]').isDisabled()); await page.keyboard.press('Escape');
            unblock(); await page.getByText('验收重算失败', {exact: false}).waitFor(); await frames(page);
            assert.equal((await current()).pieces.length, 0); assert.deepEqual(await archive(rollCase), before); assert.equal(writes.length, count + 1);
            assert.ok(writes.at(-1).url.endsWith('/api/solve')); assert.ok(await page.locator('#preview-restore').isEnabled());
        });
        await check('successful recompute replaces the candidate through the existing solve/cancel flow only', async () => {
            const before = await api('/api/cutting/tasks/' + rollCase.task.id), stock = await api('/api/rolls/' + rollCase.roll.rollId), count = writes.length;
            await page.locator('#solve').click(); await page.waitForFunction(id => previewScene.currentId !== id && !!previewScene.currentId && !document.querySelector('#preview-notice'), rollCase.plan.id);
            await frames(page); const id = (await current()).id;
            assert.equal((await api('/api/cutting/plans/' + rollCase.plan.id)).status, 'CANCELLED'); assert.equal((await api('/api/cutting/plans/' + id)).status, 'PENDING');
            assert.deepEqual(await api('/api/rolls/' + rollCase.roll.rollId), stock); assert.deepEqual((await api('/api/cutting/tasks/' + rollCase.task.id)).reports, before.reports);
            assert.deepEqual(writes.slice(count).map(w => new URL(w.url).pathname), ['/api/solve', '/api/cutting/plans/' + rollCase.plan.id + '/cancel']);
        });
        await check('a changed plan version is read afresh and never restored from the old hidden snapshot', async () => {
            await goto(remCase); await clear();
            const saved = await api('/api/cutting/plans/' + remCase.plan.id + '/adjust', {adjustmentId: randomUUID(), pieces: remCase.plan.result.pieces.map(p => ({id: p.id, x: p.x, y: p.y, rotated: p.rotated, rotationDegrees: p.rotationDegrees}))});
            await readOnly(remCase, async () => { await restore(); assert.equal((await current()).id, saved.id); assert.equal((await current()).version, saved.version); assert.ok((await current()).pieces.length); });
            remCase.plan = saved;
        });
        await check('changed task validity clears the preview flag but keeps reporting and release disabled', async () => {
            await goto(remCase); await clear();
            remCase.task = await api('/api/cutting/tasks', {...remCase.task, name: remCase.task.name + '-改版'});
            await readOnly(remCase, async () => {
                await restore(); assert.ok((await current()).invalid); assert.ok(await page.locator('#report-open').isDisabled()); assert.ok(await page.locator('#preview-clear').isDisabled());
                assert.equal(await page.locator('#adjust-open').count(), 0);
            });
        });
        await check('a remnant consumed elsewhere cannot be reloaded as available stock or lose its actual outputs', async () => {
            const f = await fixture(true); await goto(f);
            await api('/api/cutting/report-confirm', {planId: f.plan.id, actualCutLen: f.plan.result.deductLen, finishedPieceCount: f.plan.result.pieces.length,
                location: 'isolated preview', pieceResults: f.plan.result.pieces.map(p => ({pieceId: p.id, outcome: 'QUALIFIED', reason: ''})), actualRemnants: []});
            await readOnly(f, async () => {
                await page.locator('#remnant-reload').click(); await page.getByText(/重新装载未完成：该料头已不可用/).waitFor(); await frames(page);
                assert.equal((await current()).status, 'cut'); assert.ok((await current()).pieces.length); assert.ok(await page.locator('#remnant-reload').isDisabled());
                assert.equal(await page.locator('#preview-restore').count(), 0); assert.equal(await page.locator('#report-open').count(), 0);
            });
        });
        for (const remnant of [false, true]) await check(`${remnant ? 'remnant' : 'roll'} rectangular plans restore nonempty remnants and exact ordered cuts`, async () => {
            const f = await fixture(remnant, false); await goto(f); await page.locator('#path-toggle').click(); await frames(page);
            const before = await scene(), drawn = await geometry(), seg = await current();
            assert.ok(seg.remnants.length > 0); assert.ok(drawn.remnants.length > 0); assert.ok(drawn.cuts.length > 0);
            await readOnly(f, async () => {
                await clear(); assert.equal((await current()).remnants.length, 0);
                assert.ok(!(await geometry()).remnants.some(r => r.segment === f.plan.id));
                await restore(); assert.deepEqual(await scene(), before); assert.deepEqual(await geometry(), drawn);
            });
        });
        await check('a report awaiting its response cannot be cleared or reloaded and a failure retains its draft', async () => {
            const f = await fixture(true); await goto(f); const before = await archive(f), count = writes.length;
            await page.locator('#report-open').click();
            let unblock, entered; const held = new Promise(resolve => { unblock = resolve; }), started = new Promise(resolve => { entered = resolve; });
            await page.route('**/api/cutting/report-confirm', async route => {
                entered(); await held; await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({message: '验收报工响应失败'})});
            }, {times: 1});
            await page.locator('#report-submit').click(); await started;
            await context();
            assert.ok(await page.locator('[data-canvas-action="clear-preview"]').isDisabled());
            assert.ok(await page.locator('[data-canvas-action="reload-remnant"]').isDisabled()); await page.keyboard.press('Escape');
            unblock(); await page.getByText(/验收报工响应失败/).waitFor();
            assert.equal(await page.locator('#report').count(), 1); assert.equal(writes.length, count + 1);
            assert.deepEqual(await archive(f), before);
            assert.ok(await page.evaluate(id => localStorage.getItem('cutplan.app.report.' + id), f.plan.id));
        });
        await check('browser operations have no page errors or unexpected downloads', async () => { assert.deepEqual(errors, []); assert.deepEqual(downloads, []); });
    } finally {
        await browser.close(); const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
