// Real navigator hosts with constructed roll data; no business requests.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080');
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), results = [], errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    const begin = async (id, resize = false) => {
        const box = await page.locator('#' + id + (resize ? ' .rn-handle' : ' .rn-win')).boundingBox();
        const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
        await page.mouse.move(point.x, point.y); await page.mouse.down(); return point;
    };
    try {
        await page.route('**/__navigator_test', r => r.fulfill({contentType: 'text/html', body: '<link rel="stylesheet" href="/app/app.css"><style>body{display:block;padding:20px}#a,#b{width:600px;height:70px;margin:20px;background:#292e34}</style><div id="a"></div><div id="b"></div>'}));
        await page.goto(base + '/__navigator_test');
        await page.evaluate(async () => {
            const {createRollNavigator} = await import('/app/js/canvas/roll-navigator.js');
            window.initial = {roll: {id: 'N1', total: 12000, width: 1500, used: 1000}, lock: 1000, currentId: 'P1',
                window: {start: 10000, len: 1500}, bed: {min: 500, max: 6000}, defects: [],
                segments: [{id: 'P1', start: 10600, len: 1000, status: 'pending', label: '构造候选', tint: '#5588aa'}]};
            window.scenes = {a: structuredClone(initial), b: structuredClone(initial)};
            window.events = {a: {moves: [], ends: 0}, b: {moves: [], ends: 0}};
            window.views = {};
            window.make = id => createRollNavigator(document.getElementById(id), {
                onWindow: w => { events[id].moves.push(w); scenes[id] = {...scenes[id], window: w}; views[id].setScene(scenes[id]); },
                onWindowEnd: () => events[id].ends++
            });
            window.reset = id => { scenes[id] = structuredClone(initial); views[id].setScene(scenes[id]); events[id] = {moves: [], ends: 0}; };
            views.a = make('a'); views.b = make('b'); reset('a'); reset('b');
        }); await frames(page);
        await check('snapping at the roll tail stays within the available material and isolates the other instance', async () => {
            const p = await begin('a'); await page.mouse.move(p.x + 100, p.y); await page.mouse.up();
            const state = await page.evaluate(() => ({a: scenes.a.window, b: scenes.b.window, events}));
            assert.deepEqual(state.a, {start: 10500, len: 1500}); assert.deepEqual(state.b, {start: 10000, len: 1500});
            assert.equal(state.events.a.ends, 1); assert.equal(state.events.b.moves.length, 0);
        });
        await check('resizing cannot cross the roll end even when the bed maximum is larger', async () => {
            await page.evaluate(() => reset('a')); const p = await begin('a', true);
            await page.mouse.move(p.x + 100, p.y); await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => scenes.a.window), {start: 10000, len: 2000});
        });
        await check('destroy during dragging removes global listeners and late events cannot call the old host', async () => {
            await page.evaluate(() => reset('a')); const p = await begin('a');
            await page.mouse.move(p.x - 20, p.y);
            const counts = await page.evaluate(() => { views.a.destroy(); views.a.destroy(); return structuredClone(events.a); });
            await page.mouse.move(p.x - 40, p.y); await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => events.a), counts);
            assert.equal(await page.locator('#a').innerHTML(), '');
            assert.equal(await page.locator('#a').evaluate(e => e.classList.contains('rn-host')), false);
        });
        await check('remount accepts one drag and one release without resurrecting the old instance', async () => {
            await page.evaluate(() => { views.a = make('a'); reset('a'); }); const p = await begin('a');
            await page.mouse.move(p.x - 40, p.y); await page.mouse.up();
            assert.equal(await page.evaluate(() => events.a.ends), 1);
            const saved = await page.evaluate(() => scenes.a.window);
            await page.mouse.move(p.x - 60, p.y); assert.deepEqual(await page.evaluate(() => scenes.a.window), saved);
        });
        await check('changing rolls cancels a drag instead of applying the old roll dimensions', async () => {
            await page.evaluate(() => reset('a')); const p = await begin('a');
            await page.evaluate(() => { scenes.a = {...initial, roll: {...initial.roll, id: 'N2'}, window: {start: 2000, len: 1000}}; views.a.setScene(scenes.a); });
            await page.mouse.move(p.x - 50, p.y); await page.mouse.up();
            assert.deepEqual(await page.evaluate(() => scenes.a.window), {start: 2000, len: 1000});
            assert.equal(await page.evaluate(() => events.a.ends), 0);
        });
        await check('hidden documents cancel active drag listeners and fixed material cannot start a drag', async () => {
            await page.evaluate(() => reset('a')); const p = await begin('a');
            await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
            await page.mouse.move(p.x - 50, p.y); await page.mouse.up();
            assert.equal(await page.evaluate(() => events.a.moves.length), 0);
            await page.evaluate(() => { delete document.hidden; scenes.a = {...initial, fixed: true}; views.a.setScene(scenes.a); });
            const q = await begin('a'); await page.mouse.move(q.x - 30, q.y); await page.mouse.up();
            assert.equal(await page.evaluate(() => events.a.moves.length), 0);
        });
        await check('a host read-only update cancels the current drag without calling it completed', async () => {
            await page.evaluate(() => reset('a')); const p = await begin('a');
            await page.evaluate(() => { scenes.a = {...initial, window: {...initial.window, readOnly: true}}; views.a.setScene(scenes.a); });
            await page.mouse.move(p.x - 50, p.y); await page.mouse.up();
            assert.equal(await page.evaluate(() => events.a.moves.length), 0); assert.equal(await page.evaluate(() => events.a.ends), 0);
            assert.equal(await page.locator('#a .rn-handle').count(), 0); assert.match(await page.locator('#a .rn-wl').innerText(), /范围固定/);
        });
        await check('navigator gestures have no business writes or browser errors', async () => {
            assert.deepEqual(writes, []); assert.deepEqual(errors, []);
            await page.evaluate(() => { views.a.destroy(); views.b.destroy(); });
        });
    } finally {
        await browser.close(); const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
