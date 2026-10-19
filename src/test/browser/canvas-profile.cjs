// Optional diagnostic trace; never use instrumented numbers as the final benchmark.
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {openWorkbench, benchmark} = require('./canvas-performance.cjs');
(async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const {page, scene, errors, writes} = await openWorkbench(browser, process.env.BASE_URL);
        scene.piecesById = await page.evaluate(() => Object.fromEntries(window.perf.state.getCurrentCaseData().pieces.map(p => [p.id, p])));
        await page.evaluate(async () => {
            const {bus} = await import('/js/core/event-bus.js');
            window.perf.subscribers = [];
            for (const event of ['stage:zoomed','stage:transformed']) {
                const handlers = bus.listeners.get(event);
                for (const fn of [...handlers || []]) {
                    const entry = {event,handler:fn.toString().slice(0,180),calls:0,ms:0};
                    window.perf.subscribers.push(entry);
                    handlers.delete(fn);
                    handlers.add(payload => { const t=performance.now(); try { return fn(payload); }
                        finally { entry.calls++; entry.ms+=performance.now()-t; } });
                }
            }
        });
        const cdp = await page.context().newCDPSession(page), events = [];
        cdp.on('Tracing.dataCollected', e => events.push(...e.value));
        await cdp.send('Tracing.start', {categories: 'devtools.timeline,v8,blink.user_timing,cc,gpu,disabled-by-default-skia,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', transferMode: 'ReportEvents'});
        const result = await benchmark(page, scene);
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end'); await complete;
        fs.writeFileSync(process.env.TRACE_FILE, JSON.stringify({traceEvents: events}));
        const summaries = result.results.map(r => {
            const start = events.find(e => e.name === `${r.name}:start`), end = events.find(e => e.name === `${r.name}:end`);
            const totals = {};
            for (const e of events) if (e.ph === 'X' && e.pid === start.pid && e.tid === start.tid && e.ts >= start.ts && e.ts < end.ts)
                totals[e.name] = (totals[e.name] || 0) + (e.dur || 0) / 1000 / r.steps;
            return {name: r.name, steps: r.steps, eventsMsPerStep: Object.fromEntries(Object.entries(totals).sort((a,b) => b[1]-a[1]).slice(0, 25))};
        });
        const drawing = await page.evaluate(() => {
            const {stage, renderer} = window.perf;
            renderer.viewFullRoll(); stage.mainLayer.draw();
            const time = fn => { const t = performance.now(); for (let i=0;i<12;i++) fn(); return (performance.now()-t)/12; };
            const shapes = stage.mainLayer.find('Shape');
            const scene = time(() => stage.mainLayer.drawScene()), hit = time(() => stage.mainLayer.drawHit(null));
            const strokes = shapes.map(s => s.strokeEnabled());
            shapes.forEach(s => s.strokeEnabled(false));
            const noStroke = time(() => stage.mainLayer.drawScene());
            shapes.forEach((s,i) => s.strokeEnabled(strokes[i]));
            const dashes = shapes.map(s => s.dashEnabled());
            shapes.forEach(s => s.dashEnabled(false));
            const noDash = time(() => stage.mainLayer.drawScene());
            shapes.forEach((s,i) => s.dashEnabled(dashes[i]));
            return {scene, hit, noStroke, noDash, textCount: stage.mainLayer.find('Text').length};
        });
        const subscribers = await page.evaluate(() => window.perf.subscribers);
        console.log(JSON.stringify({summaries, drawing, subscribers, errors, writes}, null, 2));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
