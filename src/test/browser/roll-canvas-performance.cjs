// 同一浏览器交替测量 61b62f5 SVG 基线与实例 Konva；场景为既有性能用例同种子/规格的 2000 件构造长卷。
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:18191';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname)); assert.notEqual(new URL(base).port, '8080');
const baseline = file => execFileSync('git', ['show', '61b62f5:src/main/resources/static/app/js/canvas/' + file], {encoding: 'utf8'});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [], results = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    try {
        await page.route('**/__roll_perf', r => r.fulfill({contentType: 'text/html', body: '<script src="/konva.min.js"></script><style>body{margin:0}#host{position:relative;width:1100px;height:700px}</style><div id="host"></div>'}));
        await page.route('**/baseline/roll-canvas.js', r => r.fulfill({contentType: 'text/javascript', body: baseline('roll-canvas.js')}));
        await page.route('**/baseline/camera.js', r => r.fulfill({contentType: 'text/javascript', body: baseline('camera.js')}));
        await page.goto(base + '/__roll_perf');
        await page.evaluate(async () => {
            window.factories = {baseline: (await import('/baseline/roll-canvas.js')).createRollCanvas, current: (await import('/js/canvas/roll-canvas.js')).createRollCanvas};
            let seed = 20261017, y = 0, id = 1; const segments = [];
            const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
            const pick = list => list[Math.floor(rand() * list.length)];
            while (id <= 2000) {
                const len = pick([400, 500, 600, 800, 1000]), pieces = [];
                for (let x = 0; id <= 2000;) {
                    const width = pick([300, 450, 600, 700, 900, 1200]); if (x + width > 2800) break;
                    pieces.push({id, u: y, v: x, du: len, dv: width, label: '构造裁片 ' + id, color: '#5f87b0'}); id++; x += width;
                }
                segments.push({id: 'row-' + segments.length, start: y, len, status: 'pending', pieces, cuts: [], remnants: []}); y += len;
            }
            window.scene = {roll: {id: 'PERF', width: 2800, total: y + 20000, used: y - 5000}, segments, defects: [],
                currentId: segments.at(-1).id, window: {start: y - 5000, len: 5000}};
            window.frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            window.mountView = async kind => { window.view?.destroy(); document.getElementById('host').replaceChildren(); window.view = factories[kind](document.getElementById('host')); view.setScene(scene); await frames(); };
        });
        const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
        const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
        for (let round = 0; round < 3; round++) for (const kind of round % 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
            await page.evaluate(kind => mountView(kind), kind);
            for (const full of [false, true]) {
                await page.evaluate(async full => { view.setOptions({view: full ? 'full' : 'station'}); await frames(); }, full);
                await page.evaluate(async () => { for (let i = 0; i < 6; i++) { view.zoom(i % 2 ? 1 / 1.01 : 1.01); await frames(); } });
                const before = await metric();
                await page.evaluate(async () => { for (let i = 0; i < 40; i++) { view.zoom(i % 2 ? 1 / 1.01 : 1.01); await frames(); } });
                const after = await metric();
                results.push({round, kind, mode: full ? 'full' : 'station', busyMs: (after.TaskDuration - before.TaskDuration) * 1000 / 40});
            }
        }
        const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const comparison = ['station', 'full'].map(mode => {
            const cost = kind => median(results.filter(r => r.mode === mode && r.kind === kind).map(r => r.busyMs));
            return {mode, baselineMs: cost('baseline'), currentMs: cost('current'), ratio: cost('current') / cost('baseline')};
        });
        console.log(JSON.stringify({scene: 'constructed; 2000 pieces; seed 20261017', browser: browser.version(), viewport: {width: 1366, height: 768}, rounds: 3, steps: 40, results, comparison}, null, 2));
        assert.deepEqual(errors, []); assert.deepEqual(writes, []);
        for (const c of comparison) assert.ok(c.ratio <= 1.2, c.mode + ' interaction regressed beyond 20%');
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
