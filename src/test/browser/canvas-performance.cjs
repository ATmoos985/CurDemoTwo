// Canvas frame cost with ~2000 synthetic pieces on a long roll. Client-side only: every API write is aborted.
// BASE_URL=http://127.0.0.1:18091 [BASELINE_URL=http://127.0.0.1:18090] [SNAPSHOT_DIR=...] node src/test/browser/canvas-performance.cjs
// With BASELINE_URL the same views are captured on both services and compared pixel by pixel. Both open /index.html, since / is the intro page.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL || 'http://127.0.0.1:18191';
const PIECES = Number(process.env.PIECES || 2000);
const VIEWPORT = {width: 1600, height: 1000};

/** Runs in the page: deterministic curtain rows; history is confirmed, the last bed is the editable plan. */
async function loadScene(count) {
    const {state} = await import('/js/core/state.js');
    const renderer = await import('/js/plugins/cad/cad-renderer.js');
    let seed = 20261017;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = list => list[Math.floor(rand() * list.length)];
    const rollW = 2800, bedL = 5000, rows = [];
    let y = 0, id = 1, total = 0;
    while (total < count) {
        const l = pick([400, 500, 600, 800, 1000]), row = {y, l, pieces: []};
        for (let x = 0; total < count;) {
            const w = pick([300, 450, 600, 700, 900, 1200]);
            if (x + w > rollW) break;
            row.pieces.push({id, demandId: 1 + id % 40, name: `窗帘裁片 ${String(id).padStart(4, '0')}`, x, y, w, l});
            id++; total++; x += w;
        }
        rows.push(row); y += l;
    }
    let windowStartY = 0;
    for (const row of rows) if (row.y <= y - bedL) windowStartY = row.y;
    const pieces = [], remnants = [], cuts = [];
    for (const [index, row] of rows.entries()) {
        const history = row.y + row.l <= windowStartY;
        const used = row.pieces.reduce((sum, p) => sum + p.w, 0);
        for (const p of row.pieces) pieces.push({...p, confirmed: history, outcome: history && p.id % 19 === 0 ? 'REJECTED' : undefined});
        if (rollW - used >= 100) remnants.push({id: `REM-${index}`, x: used, y: row.y, w: rollW - used, l: row.l,
            hasDefect: index % 7 === 0, confirmed: history, area: (rollW - used) * row.l / 1e6});
        if (history) continue;
        cuts.push({step: cuts.length + 1, type: '横切', pos: row.y + row.l, start: 0, end: rollW});
        let x = 0;
        for (const p of row.pieces) { x += p.w; cuts.push({step: cuts.length + 1, type: '纵切', pos: x, start: row.y, end: row.y + row.l}); }
    }
    const defects = Array.from({length: 40}, (_, i) => ({id: i + 1, x: 100 + (i * 677) % 2500, y: 3000 + i * Math.floor(y / 42),
        w: 40, h: 30, margin: 20, desc: '布疵'}));
    const data = state.getCurrentCaseData();
    Object.assign(data, {rollId: 'PERF-ROLL', rollW, bedL, totalRollL: Math.ceil((y + 20000) / 1000) * 1000, windowStartY,
        cutOrigin: 'right-bottom', trimStart: 0, materialAvailable: true, pieces, remnants, cuts,
        globalDefects: defects, defects, lastReceipt: null, stockUsedLength: windowStartY});
    document.body.dataset.material = 'ready';
    renderer.renderScene();
    renderer.resetToBedView();
    const active = pieces.filter(p => !p.confirmed);
    return {pieces: pieces.length, remnants: remnants.length, cuts: cuts.length, active: active.length,
        totalRollL: data.totalRollL, windowStartY, dragId: active[Math.floor(active.length / 2)].id};
}

const frames = page => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));

async function openWorkbench(browser, url) {
    assert.notEqual(new URL(url).port, '8080', 'performance scenarios must use an isolated test service, never 8080');
    const page = await browser.newPage({viewport: VIEWPORT}), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/api/**', route => {
        if (route.request().method() === 'GET') return route.continue();
        writes.push(route.request().url());
        return route.abort();
    });
    await page.goto(new URL('/index.html', url).href);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.body.inert);
    const scene = await page.evaluate(loadScene, PIECES);
    await page.evaluate(async () => {
        window.perf = {
            renderer: await import('/js/plugins/cad/cad-renderer.js'),
            stage: await import('/js/plugins/cad/cad-stage.js'),
            nesting: await import('/js/plugins/cad/cad-interactive-nesting.js'),
            remnants: await import('/js/plugins/cad/cad-remnant-highlight.js'),
            settings: await import('/js/plugins/settings/settings.js'),
            state: (await import('/js/core/state.js')).state
        };
    });
    await frames(page);
    return {page, errors, writes, scene};
}

/** Screen point of a world coordinate in page pixels. */
const screenPoint = (page, world) => page.evaluate(({x, y}) => {
    const stage = window.perf.stage.stage, box = stage.container().getBoundingClientRect();
    return {x: box.x + stage.x() + x * stage.scaleX(), y: box.y + stage.y() + y * stage.scaleY()};
}, world);

async function measure(page, cdp, name, prepare, steps, step) {
    await prepare();
    await frames(page);
    await page.evaluate(name => performance.mark(`${name}:start`), name);
    const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    await page.evaluate(() => {
        window.perfFrames = []; window.perfRecording = true;
        const loop = time => { window.perfFrames.push(time); if (window.perfRecording) requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    });
    const before = await read();
    for (let i = 0; i < steps; i++) { await step(i); await frames(page); }
    const after = await read();
    await page.evaluate(name => performance.mark(`${name}:end`), name);
    const stamps = await page.evaluate(() => { window.perfRecording = false; return window.perfFrames; });
    const intervals = stamps.slice(1).map((time, i) => time - stamps[i]).sort((a, b) => a - b);
    const at = q => intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))] || 0;
    return {name, steps, busyMs: (after.TaskDuration - before.TaskDuration) * 1000 / steps,
        scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000 / steps,
        frameP50: at(.5), frameP95: at(.95), frameMax: intervals.at(-1) || 0};
}

async function benchmark(page, scene) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const results = [];
    const station = () => page.evaluate(() => window.perf.renderer.resetToBedView());
    const center = async () => {
        const box = await page.locator('#konva-container').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    };
    results.push(await measure(page, cdp, '工位视图滚轮缩放', async () => { await station(); await center(); }, 32,
        i => page.mouse.wheel(0, i < 8 || i >= 24 ? 100 : -100)));
    // Keep the same pan input on both versions; wheel recovery is asserted separately.
    let start;
    results.push(await measure(page, cdp, '全卷视图平移', async () => {
        await page.evaluate(() => window.perf.renderer.viewFullRoll());
        const box = await page.locator('#konva-container').boundingBox();
        start = {x: box.x + 120, y: box.y + box.height / 2};
        await page.mouse.move(start.x, start.y); await page.mouse.down();
    }, 24, i => page.mouse.move(start.x + (i + 1) * 4, start.y + (i + 1) * 3)));
    await page.mouse.up();
    results.push(await measure(page, cdp, '平移画布', async () => {
        await station();
        const box = await page.locator('#konva-container').boundingBox();
        start = {x: box.x + 120, y: box.y + box.height / 2};
        await page.mouse.move(start.x, start.y); await page.mouse.down();
    }, 40, i => page.mouse.move(start.x + (i + 1) * 4, start.y + (i + 1) * 3)));
    await page.mouse.up();
    results.push(await measure(page, cdp, '拖拽裁片', async () => {
        await station();
        const piece = scene.piecesById[scene.dragId];
        start = await screenPoint(page, {x: piece.x + piece.w / 2, y: piece.y + piece.l / 2});
        await page.mouse.move(start.x, start.y); await page.mouse.down();
    }, 40, i => page.mouse.move(start.x + (i + 1) * 3, start.y + (i + 1) * 2)));
    await page.mouse.up();
    await page.keyboard.press('Escape');
    // Invalid drops animate back for 150 ms; do not charge that tween to the next hover scenario.
    await page.waitForTimeout(200);
    // Overlay-only changes on the full roll, where every entity is on screen.
    results.push(await measure(page, cdp, '料头悬停（全卷）', () => page.evaluate(() => window.perf.renderer.viewFullRoll()), 24,
        i => page.evaluate(i => {
            const remnants = window.perf.state.getCurrentCaseData().remnants;
            window.perf.remnants.hoverRemnant(remnants[(i >> 1) % remnants.length].id, i % 2 === 0);
        }, i)));
    results.push(await measure(page, cdp, '测量预览（全卷）', async () => {
        await page.evaluate(async () => {
            window.perf.renderer.viewFullRoll();
            (await import('/js/plugins/cad/cad-measure.js')).toggleMeasureTool(true);
        });
        const box = await page.locator('#konva-container').boundingBox();
        start = {x: box.x + 200, y: box.y + 200};
        await page.mouse.click(start.x, start.y);
    }, 24, i => page.mouse.move(start.x + (i + 1) * 5, start.y + (i + 1) * 4)));
    await page.evaluate(async () => {
        const measure = await import('/js/plugins/cad/cad-measure.js');
        measure.toggleMeasureTool(false); measure.clearAllMeasurements();
    });
    // Drive the real continuous-simulation callback with a deterministic clock.
    // Only the simulator's rAF is captured; Konva and browser paint still run normally.
    results.push(await measure(page, cdp, '走刀逐刀完成', async () => {
        await station();
        await page.evaluate(async () => {
            const sim = await import('/js/plugins/cut-player/cut-animator.js');
            sim.resetContinuousSim();
            window.perf.sim = sim;
            window.perf.nativeRaf = window.requestAnimationFrame;
            window.perf.simClock = performance.now();
            window.perf.cutCompletionMs = [];
            window.requestAnimationFrame = callback => {
                if (callback.name !== 'simAnimationLoop') return window.perf.nativeRaf.call(window, callback);
                window.perf.simFrame = callback;
                return -1;
            };
            sim.startContinuousSim();
        });
    }, 12, () => page.evaluate(() => {
        const before = window.perf.state.currentCutStepLimit;
        for (let i = 0; i < 1000; i++) {
            const callback = window.perf.simFrame;
            window.perf.simFrame = null;
            if (!callback) throw new Error('simulation stopped before next cut');
            window.perf.simClock += 100;
            const t = performance.now();
            callback(window.perf.simClock);
            if (window.perf.state.currentCutStepLimit !== before) {
                window.perf.cutCompletionMs.push(performance.now() - t);
                return;
            }
        }
        throw new Error('simulation did not complete a cut');
    })));
    const cutCompletionMs = await page.evaluate(() => {
        window.perf.sim.pauseContinuousSim();
        window.requestAnimationFrame = window.perf.nativeRaf;
        window.perf.sim.stepCut(999);
        return window.perf.cutCompletionMs;
    });
    await station();
    const direct = await page.evaluate(() => {
        const {renderer, stage} = window.perf;
        const time = (runs, run) => { const t = performance.now(); for (let i = 0; i < runs; i++) run(); return (performance.now() - t) / runs; };
        const update = time(20, () => renderer.updateCanvasAnnotations());
        const draw = time(20, () => stage.annotationLayer.draw());
        const main = time(5, () => stage.mainLayer.draw());
        const all = time(5, () => stage.stage.draw());
        renderer.viewFullRoll();
        const fullMain = time(5, () => stage.mainLayer.draw());
        const fullAll = time(5, () => stage.stage.draw());
        renderer.resetToBedView();
        const render = time(5, () => renderer.renderScene());
        const rebuild = time(5, () => { renderer.renderScene(); stage.stage.draw(); });
        // Include picking separately: deferred hit drawing moves this cost to the first real query.
        renderer.viewFullRoll();
        const fullDrawAndPick = time(5, () => { stage.mainLayer.draw(); stage.mainLayer.getIntersection({x:1,y:1}); });
        return {update, draw, main, all, fullMain, fullAll, render, rebuild, fullDrawAndPick};
    });
    direct.cutCompletion = cutCompletionMs.reduce((a,b) => a+b,0) / cutCompletionMs.length;
    return {results, direct};
}

/** Identical, deterministic view states for pixel comparison between two builds. */
const SNAPSHOTS = {
    station: async () => {},
    selected: async scene => { window.perf.nesting.setSelectedPieceId(scene.dragId); },
    zoomed: async scene => {
        const piece = scene.piecesById[scene.dragId];
        window.perf.renderer.zoomCanvas(2.6);
        window.perf.stage.stage.position({x: 760 - (piece.x + piece.w / 2) * window.perf.stage.stage.scaleX(),
            y: 480 - (piece.y + piece.l / 2) * window.perf.stage.stage.scaleY()});
    },
    flow: async () => { window.perf.renderer.resetToFlowView(); },
    full: async () => { window.perf.renderer.viewFullRoll(); },
    fullPan: async () => {
        const {stage,renderer}=window.perf;
        renderer.viewFullRoll(); stage.stage.draw();
        stage.stage.fire('dragstart',{target:stage.stage});
        stage.stage.position({x:stage.stage.x()+64,y:stage.stage.y()+48});
    },
    fullPanFractional: async () => {
        const {stage,renderer}=window.perf;
        renderer.viewFullRoll(); stage.stage.draw();
        stage.stage.fire('dragstart',{target:stage.stage});
        stage.stage.position({x:stage.stage.x()+64.25,y:stage.stage.y()+48.25});
    },
    fullPanChanged: async () => {
        const {stage,renderer}=window.perf;
        renderer.viewFullRoll(); stage.stage.draw();
        stage.stage.fire('dragstart',{target:stage.stage});
        stage.stage.position({x:stage.stage.x()+64,y:stage.stage.y()+48});
        const sim=await import('/js/plugins/cut-player/cut-animator.js');
        sim.stepCut(-999);
    },
    history: async scene => {
        window.perf.stage.stage.position({x: window.perf.stage.stage.x(), y: window.perf.stage.stage.y() + 4200 * window.perf.stage.stage.scaleY()});
    },
    remnant: async () => {
        const data = window.perf.state.getCurrentCaseData(), remnant = data.remnants.find(r => !r.confirmed) || data.remnants.at(-1);
        window.perf.remnants.selectRemnant(remnant.id, {switchTab: false, showToastMsg: false});
        await new Promise(resolve => setTimeout(resolve, 500));
    },
    optimized: async () => { window.perf.state.isToolpathOptimized = true; window.perf.renderer.renderScene(); },
    cutMiddle: async () => {
        const sim = await import('/js/plugins/cut-player/cut-animator.js');
        sim.stepCut(-999); for (let i=0;i<9;i++) sim.stepCut(1);
    },
    cutOptimized: async () => {
        window.perf.state.isToolpathOptimized = true; window.perf.renderer.renderScene();
        const sim = await import('/js/plugins/cut-player/cut-animator.js');
        sim.stepCut(-999); for (let i=0;i<9;i++) sim.stepCut(1);
    },
    cutReset: async () => {
        const sim = await import('/js/plugins/cut-player/cut-animator.js');
        sim.stepCut(-999);
    },
    noDimensions: async () => { window.perf.renderer.setCanvasLayer('dimensions', false); },
    dark: async scene => { window.perf.settings.setTheme('dark'); window.perf.nesting.setSelectedPieceId(scene.dragId); },
    // Mid-drag: the entity has moved and its labels follow on the next frame.
    dragging: async scene => {
        const {nesting, stage} = window.perf, {bus} = await import('/js/core/event-bus.js'), piece = scene.piecesById[scene.dragId];
        nesting.setSelectedPieceId(scene.dragId);
        stage.pieceGroup.findOne(`.piece-entity-${scene.dragId}`).position({x: piece.x + 37, y: piece.y - 23});
        bus.emit('piece:dragging');
    },
    // Dropped far from its indexed cell, then the view pans there: the labels must follow the entity.
    dragAway: async scene => {
        const {nesting, stage, state} = window.perf, {bus} = await import('/js/core/event-bus.js');
        const piece = state.getCurrentCaseData().pieces.find(p => p.id === scene.dragId), y = piece.y + 20000;
        nesting.setSelectedPieceId(scene.dragId);
        stage.pieceGroup.findOne(`.piece-entity-${scene.dragId}`).y(y);
        bus.emit('piece:dragging');
        piece.y = y;
        bus.emit('piece:moved', {pieceId: piece.id, x: piece.x, y});
        stage.stage.y(stage.stage.y() - 20000 * stage.stage.scaleY());
    },
    // Overlays drawn above the entities: a table-hover preview, then a finished and a live measurement.
    hover: async () => {
        const data = window.perf.state.getCurrentCaseData(), remnant = data.remnants.find(r => !r.confirmed) || data.remnants.at(-1);
        window.perf.remnants.hoverRemnant(remnant.id, true);
    },
    measure: async () => {
        const {stage} = window.perf.stage, box = stage.container().getBoundingClientRect();
        (await import('/js/plugins/cad/cad-measure.js')).toggleMeasureTool(true);
        const at = (type, x, y) => { stage.setPointersPositions({clientX: box.x + x, clientY: box.y + y}); stage.fire(type, {evt: {}}); };
        at('click', 420, 300); at('click', 980, 620);
        at('click', 600, 700); at('mousemove', 900, 760);
    }
};

async function snapshots(browser, url) {
    const shots = {};
    for (const [name, apply] of Object.entries(SNAPSHOTS)) {
        const {page, errors, writes, scene} = await openWorkbench(browser, url);
        scene.piecesById = await page.evaluate(() => Object.fromEntries(window.perf.state.getCurrentCaseData().pieces.map(p => [p.id, p])));
        await page.evaluate(`(${apply.toString()})(${JSON.stringify(scene)})`);
        await frames(page); await frames(page);
        shots[name] = await page.locator('.cad-surface').screenshot({animations:'disabled'});
        assert.deepEqual(errors, [], `${url} ${name}: ${errors.join('; ')}`);
        assert.deepEqual(writes, []);
        await page.close();
    }
    return shots;
}

async function compare(browser, left, right) {
    const page = await browser.newPage();
    const result = await page.evaluate(async ([a, b]) => {
        const load = async data => createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
        const [x, y] = await Promise.all([load(a), load(b)]);
        const canvas = new OffscreenCanvas(x.width, x.height), ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.drawImage(x, 0, 0); const p = ctx.getImageData(0, 0, x.width, x.height);
        ctx.clearRect(0, 0, x.width, x.height); ctx.drawImage(y, 0, 0); const q = ctx.getImageData(0, 0, x.width, x.height);
        let changed = 0;
        const diff = ctx.createImageData(x.width, x.height);
        for (let i = 0; i < p.data.length; i += 4) {
            const delta = Math.max(...[0,1,2,3].map(k => Math.abs(p.data[i+k] - q.data[i+k])));
            const hit = delta > 0;
            changed += hit;
            diff.data.set(hit ? [220, 30, 30, 255] : [p.data[i], p.data[i + 1], p.data[i + 2], 50], i);
        }
        ctx.putImageData(diff, 0, 0);
        const blob = await canvas.convertToBlob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
        return {changed, total: x.width * x.height, sameSize: x.width === y.width && x.height === y.height, diff: btoa(binary)};
    }, [left.toString('base64'), right.toString('base64')]);
    await page.close();
    return result;
}

module.exports = {openWorkbench, frames, screenPoint, benchmark, snapshots, compare};

if (require.main === module) (async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    try {
        const {page, errors, writes, scene} = await openWorkbench(browser, base);
        scene.piecesById = await page.evaluate(() => Object.fromEntries(window.perf.state.getCurrentCaseData().pieces.map(p => [p.id, p])));
        console.log(`场景：${scene.pieces} 件裁片 · ${scene.remnants} 块料头 · 当前工位 ${scene.active} 件 / ${scene.cuts} 刀 · 卷长 ${scene.totalRollL} mm`);
        const {results, direct} = await benchmark(page, scene);
        if (process.env.RESULT_FILE) fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({results, direct}, null, 2));
        console.log('交互（每步 = 一次输入 + 后续帧，busy 为主线程任务耗时）');
        for (const r of results) console.log(`  ${r.name.padEnd(9, '　')} busy ${r.busyMs.toFixed(1).padStart(7)} ms/步 · script ${r.scriptMs.toFixed(1).padStart(7)} ms/步 · 帧间隔 p50 ${r.frameP50.toFixed(1)} / p95 ${r.frameP95.toFixed(1)} / max ${r.frameMax.toFixed(1)} ms`);
        console.log(`直接调用：updateCanvasAnnotations ${direct.update.toFixed(2)} ms · 标注层绘制 ${direct.draw.toFixed(2)} ms · renderScene ${direct.render.toFixed(1)} ms · renderScene + 全部图层绘制 ${direct.rebuild.toFixed(1)} ms`);
        console.log(`  工位视图：主图层绘制 ${direct.main.toFixed(1)} ms · 全部图层绘制 ${direct.all.toFixed(1)} ms`);
        console.log(`  全卷视图：主图层绘制 ${direct.fullMain.toFixed(1)} ms · 全部图层绘制 ${direct.fullAll.toFixed(1)} ms · 主层绘制并拾取 ${direct.fullDrawAndPick.toFixed(1)} ms`);
        console.log(`  连续仿真完成一刀的回调：${direct.cutCompletion.toFixed(2)} ms`);
        assert.deepEqual(errors, [], errors.join('; '));
        assert.deepEqual(writes, [], 'benchmark must never write business data');
        await page.close();
        if (process.env.BASELINE_URL) {
            const dir = process.env.SNAPSHOT_DIR;
            if (dir) fs.mkdirSync(dir, {recursive: true});
            const [current, baseline] = [await snapshots(browser, base), await snapshots(browser, process.env.BASELINE_URL)];
            let failed = 0;
            for (const name of Object.keys(SNAPSHOTS)) {
                const result = await compare(browser, baseline[name], current[name]);
                const ratio = result.changed / result.total;
                console.log(`像素对比 ${name.padEnd(12)} 差异 ${result.changed} px (${(ratio * 100).toFixed(3)}%)`);
                if (dir) {
                    fs.writeFileSync(path.join(dir, `${name}-baseline.png`), baseline[name]);
                    fs.writeFileSync(path.join(dir, `${name}-current.png`), current[name]);
                    fs.writeFileSync(path.join(dir, `${name}-diff.png`), Buffer.from(result.diff, 'base64'));
                }
                if (!result.sameSize || ratio > Number(process.env.PIXEL_TOLERANCE || 0)) failed++;
            }
            assert.equal(failed, 0, `${failed} 个视图与基线不一致`);
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
