// 构造场景只存在于隔离测试页面；使用仓库真实 Konva、相机、场景适配及画布模块。
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:18191';
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
    assert.notEqual(new URL(base).port, '8080', 'use an isolated test server');
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [], results = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    async function check(name, action) {
        try { await action(); results.push({name, success: true}); console.log('PASS', name); }
        catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
    }
    try {
        await page.route('**/__roll_canvas_test', route => route.fulfill({contentType: 'text/html', body: `<!doctype html><html><meta charset="utf-8">
          <script src="/konva.min.js"></script><style>body{margin:0;display:flex;background:#23282d}.host{position:relative;width:600px;height:700px;border:1px solid #777}.rc-host{touch-action:none}</style>
          <div id="a" class="host"></div><div id="b" class="host"></div></html>`}));
        await page.goto(base + '/__roll_canvas_test');
        await page.evaluate(async () => {
            const {createRollCanvas} = await import('/js/canvas/roll-canvas.js');
            const {planSegment} = await import('/app/js/model/roll-scene.js');
            const shape = {type: 'POLYGON', width: 600, height: 900, vertices: [
                {x: 0, y: 0}, {x: 600, y: 0}, {x: 600, y: 300}, {x: 200, y: 300}, {x: 200, y: 900}, {x: 0, y: 900}]};
            const plan = {id: 'p', status: 'PENDING', request: {windowStartY: 2000, rollL: 1500}, result: {
                pieces: [{id: 1, x: 100, y: 100, w: 600, l: 900, shape, rotated: true, rotationDegrees: 90}],
                cuts: [{step: 1, startX: 100, startY: 100, endX: 700, endY: 100}],
                remnants: [{id: 'r', x: 800, y: 100, w: 200, l: 900, shape: {type: 'POLYGON', width: 200, height: 900,
                    vertices: [{x: 0, y: 0}, {x: 200, y: 0}, {x: 200, y: 300}, {x: 100, y: 300}, {x: 100, y: 900}, {x: 0, y: 900}]}}]}};
            const seg = planSegment(plan); seg.home = {u: 2000, v: 0};
            window.sc = {roll: {id: 'ROLL-TEST', width: 1500, total: 10000, used: 1000}, currentId: 'p', segments: [seg],
                defects: [{u: 3500, v: 50, du: 100, dv: 80, margin: 20}], window: {start: 2000, len: 1500}};
            window.events = {a: {selected: [], moved: [], defects: [], cursor: [], camera: [], commands: [], contexts: []}, b: {selected: [], moved: [], defects: [], cursor: [], camera: [], commands: [], contexts: []}};
            window.make = id => createRollCanvas(document.getElementById(id), {
                onPieceSelect: x => events[id].selected.push(x), onPieceMove: (...x) => events[id].moved.push(x),
                onDefectDraw: x => events[id].defects.push(x), onCursor: x => events[id].cursor.push(x), onCamera: x => events[id].camera.push(x),
                onEditCommand: x => events[id].commands.push(x), onContextMenu: x => events[id].contexts.push(x)
            });
            window.views = {a: make('a'), b: make('b')};
            views.a.setScene(sc); views.b.setOptions({vertical: false}); views.b.setScene(sc);
            window.stageFor = id => Konva.stages.find(s => s.container().id === id);
            window.point = (id, u, v) => {
                const cam = views[id].getCamera(), host = document.getElementById(id), box = host.getBoundingClientRect();
                const x = box.x + host.clientLeft, y = box.y + host.clientTop;
                return id === 'a' ? {x: x + cam.c + v * cam.s, y: y + cam.a + u * cam.s}
                    : {x: x + cam.a + u * cam.s, y: y + cam.c + v * cam.s};
            };
        });
        await frames(page);
        const point = (id, u, v) => page.evaluate(([id, u, v]) => window.point(id, u, v), [id, u, v]);
        const drag = async (id, u, v, du, dv) => {
            const a = await point(id, u, v), b = await point(id, u + du, v + dv);
            await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 5}); await page.mouse.up(); await frames(page);
        };
        await check('material reference grid uses global millimetres across orientations, tiles and nonrectangular material', async () => {
            const grids = await page.evaluate(() => ['a', 'b'].map(id => stageFor(id).find('.roll-grid').map(n => n.points())));
            for (const grid of grids) {
                assert.ok(grid.some(p => p[1] === 2000)); assert.ok(grid.some(p => p[1] === 3000));
                for (const p of grid) assert.deepEqual(p, [0, p[1], 1500, p[1]]);
            }
            await page.evaluate(() => views.a.setOptions({view: 'full', fullMode: 'tile'})); await frames(page);
            assert.deepEqual(await page.evaluate(() => stageFor('a').find('.roll-grid').map(n => n.points()[1]).sort((a, b) => a - b)),
                [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
            await page.evaluate(() => {
                views.a.setOptions({view: 'station'});
                views.a.setScene({...sc, roll: {...sc.roll, shape: {type: 'POLYGON', width: 1500, height: 10000,
                    vertices: [{x: 0, y: 0}, {x: 1500, y: 0}, {x: 700, y: 10000}, {x: 0, y: 10000}]}}});
            }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-grid').length), 0);
            assert.ok(await page.evaluate(() => stageFor('b').find('.roll-grid').length) > 0);
            await page.evaluate(() => views.a.setScene(sc)); await frames(page);
        });
        await check('four process datums stay independent of path visibility and transform only their display axes', async () => {
            for (const corner of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
                await page.evaluate(corner => {
                    const origin = {u: corner.endsWith('bottom') ? 3474.5 : 2025.5, v: corner.startsWith('right') ? 1500 : 0,
                        du: corner.endsWith('bottom') ? -1 : 1, dv: corner.startsWith('right') ? -1 : 1};
                    for (const v of Object.values(views)) { v.setOptions({showPath: false}); v.setScene({...sc, origin}); }
                }, corner); await frames(page);
                for (const id of ['a', 'b']) {
                    const actual = await page.evaluate(id => {
                        const s = stageFor(id), o = s.findOne('.roll-origin'), piece = s.findOne('.roll-piece');
                        return {origin: o && [o.x(), o.y()], x: s.findOne('.roll-origin-x')?.points(), y: s.findOne('.roll-origin-y')?.points(),
                            path: s.find('.roll-path').length, camera: views[id].getCamera(), piece: [piece.x(), piece.y(), piece.points()]};
                    }, id);
                    const u = corner.endsWith('bottom') ? 3474.5 : 2025.5, v = corner.startsWith('right') ? 1500 : 0;
                    const du = corner.endsWith('bottom') ? -1 : 1, dv = corner.startsWith('right') ? -1 : 1, c = actual.camera;
                    const p = id === 'a' ? [c.c + v * c.s, c.a + u * c.s] : [c.a + u * c.s, c.c + v * c.s];
                    assert.ok(actual.origin, 'process datum is drawn without paths');
                    actual.origin.forEach((n, i) => assert.ok(Math.abs(n - p[i]) < 1e-6));
                    const xp = id === 'a' ? [p[0] + dv * 38, p[1]] : [p[0], p[1] + dv * 38];
                    const yp = id === 'a' ? [p[0], p[1] + du * 38] : [p[0] + du * 38, p[1]];
                    actual.x.forEach((n, i) => assert.ok(Math.abs(n - [...p, ...xp][i]) < 1e-6));
                    actual.y.forEach((n, i) => assert.ok(Math.abs(n - [...p, ...yp][i]) < 1e-6));
                    assert.equal(actual.path, 0); assert.deepEqual(actual.piece, [100, 2100, [0, 0, 600, 0, 600, 300, 200, 300, 200, 900, 0, 900]]);
                }
            }
            await page.evaluate(() => views.a.setScene({...sc, window: {start: 2000, len: 500}, origin: {u: 6974.5, v: 1500, du: -1, dv: -1}}, {refit: true})); await frames(page);
            const fitted = await page.evaluate(() => {
                const s = stageFor('a'), o = s.findOne('.roll-origin'); return {y: o?.y(), h: s.height()};
            });
            assert.ok(fitted.y > 22 && fitted.y < fitted.h, 'fit includes the original bed datum when planned consumption is shorter');
            await page.evaluate(() => { views.a.setOptions({view: 'full'}); views.b.setScene(sc); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-origin').length), 0);
            assert.equal(await page.evaluate(() => stageFor('b').find('.roll-origin').length), 0);
            await page.evaluate(() => { views.a.setOptions({view: 'station'}); views.a.setScene(sc); }); await frames(page);
        });
        await check('both instances render the exact rotated concave polygon', async () => {
            const shapes = await page.evaluate(() => ['a', 'b'].map(id => {
                const p = stageFor(id).findOne('.roll-piece');
                return {kind: p.getClassName(), points: p.points(), count: stageFor(id).find('.roll-piece').length};
            }));
            for (const p of shapes) { assert.equal(p.kind, 'Line'); assert.equal(p.count, 1); assert.deepEqual(p.points, [0, 0, 600, 0, 600, 300, 200, 300, 200, 900, 0, 900]); }
        });
        await check('horizontal transform swaps display axes without rotating source geometry twice', async () => {
            const vertices = await page.evaluate(() => ['a', 'b'].map(id => {
                const node = stageFor(id).findOne('.roll-piece'), m = node.getAbsoluteTransform();
                const host = document.getElementById(id), box = host.getBoundingClientRect();
                return {p: m.point({x: 200, y: 900}), expected: point(id, 3000, 300), box: {x: box.x + host.clientLeft, y: box.y + host.clientTop}};
            }));
            for (const v of vertices) { assert.ok(Math.abs(v.p.x + v.box.x - v.expected.x) < .01); assert.ok(Math.abs(v.p.y + v.box.y - v.expected.y) < .01); }
        });
        await check('concave gap does not select or move a piece', async () => {
            await page.evaluate(() => views.a.setTool('move'));
            const p = await point('a', 2700, 600); await page.mouse.click(p.x, p.y);
            assert.equal(await page.evaluate(() => events.a.selected.at(-1)), null);
            assert.equal(await page.evaluate(() => events.a.moved.length), 0);
        });
        await check('moving a real polygon emits world deltas only to its owner', async () => {
            await drag('a', 2600, 150, 120, 30);
            const e = await page.evaluate(() => ({a: events.a.moved.at(-1), b: events.b.moved.length, original: sc.segments[0].pieces[0].u}));
            assert.equal(e.a[0], 1); assert.ok(Math.abs(e.a[1] - 120) < .1); assert.ok(Math.abs(e.a[2] - 30) < .1); assert.equal(e.a[3], true);
            assert.equal(e.b, 0); assert.equal(e.original, 2100);
        });
        await check('context picking respects concave gaps, remnant outlines and instance isolation in both orientations', async () => {
            for (const id of ['a', 'b']) {
                for (const [u, v, kind, entityId] of [[2700, 600, 'station', undefined], [2600, 150, 'piece', 1], [2500, 850, 'remnant', 'r'], [2700, 950, 'station', undefined]]) {
                    const p = await point(id, u, v); await page.mouse.click(p.x, p.y, {button: 'right'});
                    const hit = await page.evaluate(id => events[id].contexts.at(-1), id);
                    assert.equal(hit.kind, kind); assert.equal(hit.segmentId, 'p'); assert.equal(hit.entityId, entityId);
                    // Native contextmenu MouseEvent rounds client coordinates to CSS pixels; verify its exact inverse.
                    const screen = await point(id, hit.u, hit.v);
                    assert.ok(Math.abs(screen.x - hit.clientX) < .01 && Math.abs(screen.y - hit.clientY) < .01);
                    assert.ok(Math.abs(screen.x - p.x) < 1 && Math.abs(screen.y - p.y) < 1);
                }
                assert.equal(await page.evaluate(id => events[id].contexts.length, id), 4);
            }
        });
        await check('locked and invalid scenes cannot emit placement changes', async () => {
            const before = await page.evaluate(() => events.a.moved.length);
            for (const attrs of [{status: 'cut'}, {invalid: '材料已变化'}]) {
                await page.evaluate(attrs => views.a.setScene({...sc, segments: sc.segments.map(s => ({...s, ...attrs}))}), attrs);
                await drag('a', 2600, 150, 100, 20);
                assert.equal(await page.evaluate(() => events.a.moved.length), before);
            }
            await page.evaluate(() => { views.a.setScene(sc); views.a.setOptions({editable: false}); });
            await drag('a', 2600, 150, 100, 20);
            assert.equal(await page.evaluate(() => events.a.moved.length), before);
            await page.evaluate(() => views.a.setOptions({editable: true}));
            await page.evaluate(() => views.a.setScene(sc));
        });
        await check('retained geometry updates positions, contours and styles even when the caller reuses scene objects', async () => {
            await frames(page);
            const other = await page.evaluate(() => {
                window.kept = stageFor('a').findOne('.roll-piece'); window.changed = structuredClone(sc);
                Object.assign(changed.segments[0].pieces[0], {u: 2140, v: 120, color: '#aa5500', opacity: .6, dash: [3, 2]});
                changed.segments[0].pieces[0].shape.vertices[2].x = 500;
                views.a.setScene(changed);
                return stageFor('b').findOne('.roll-piece').points();
            }); await frames(page);
            const state = await page.evaluate(() => {
                const n = stageFor('a').findOne('.roll-piece');
                return {same: n === kept, x: n.x(), y: n.y(), fill: n.fill(), opacity: n.opacity(), dash: n.dash(), points: n.points()};
            });
            assert.deepEqual(state, {same: true, x: 120, y: 2140, fill: '#aa5500', opacity: .6, dash: [3, 2], points: [0, 0, 600, 0, 500, 300, 200, 300, 200, 900, 0, 900]});
            await page.evaluate(() => {
                const p = changed.segments[0].pieces[0]; p.shape.vertices[2].x = 450; p.dash = []; p.color = '#0055aa';
                views.a.setScene(changed);
            }); await frames(page);
            assert.deepEqual(await page.evaluate(() => ({same: stageFor('a').findOne('.roll-piece') === kept, x: kept.points()[4], dash: kept.dash(), fill: kept.fill()})),
                {same: true, x: 450, dash: [], fill: '#0055aa'});
            assert.deepEqual(await page.evaluate(() => stageFor('b').findOne('.roll-piece').points()), other);
            await page.evaluate(() => { views.a.setScene(sc); views.a.fit(); }); await frames(page);
        });
        await check('shape type, piece removal and defect changes invalidate the retained geometry correctly', async () => {
            await page.evaluate(() => {
                window.changed = structuredClone(sc); changed.segments[0].pieces[0].shape = {type: 'RECTANGLE', width: 600, height: 900};
                views.a.setScene(changed);
            }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').findOne('.roll-piece').getClassName()), 'Rect');
            await page.evaluate(() => { changed.segments[0].pieces = []; views.a.setScene(changed); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-piece').length), 0);
            await page.evaluate(() => { changed.defects[0].u = 2500; views.a.setScene(changed); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').findOne('.roll-defect').y()), 2500);
            await page.evaluate(() => { views.a.setScene(null); views.a.setScene(sc); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').findOne('.roll-piece').getClassName()), 'Line');
            assert.equal(await page.evaluate(() => stageFor('a').findOne('.roll-defect').y()), 3500);
        });
        await check('path and dimension switches hide their geometry and remain instance-local', async () => {
            await page.evaluate(() => { views.a.setOptions({showPath: true}); views.b.setOptions({showPath: true}); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-cut').length), 1);
            assert.ok(await page.evaluate(() => stageFor('a').find('.roll-path').length > 0));
            await page.evaluate(() => views.a.setOptions({showPath: false, showDimensions: false})); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-cut').length + stageFor('a').find('.roll-path').length + stageFor('a').find('.roll-dimension').length), 0);
            assert.equal(await page.evaluate(() => stageFor('b').find('.roll-cut').length), 1);
            assert.ok(await page.evaluate(() => stageFor('b').find('.roll-dimension').length > 0));
            await page.evaluate(() => { views.a.setOptions({showDimensions: true}); views.b.setOptions({showPath: false}); }); await frames(page);
            assert.ok(await page.evaluate(() => stageFor('a').find('.roll-dimension').length > 0));
        });
        await check('keyboard edit intents require canvas focus and preserve screen direction in either orientation', async () => {
            await page.evaluate(() => { views.a.setTool('move'); views.a.setSelection(1); document.getElementById('a').focus(); });
            await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('r');
            await page.keyboard.press('Control+z'); await page.keyboard.press('Control+Shift+z');
            assert.deepEqual(await page.evaluate(() => events.a.commands), [
                {type: 'nudge', pieceId: 1, du: 0, dv: 5}, {type: 'nudge', pieceId: 1, du: 20, dv: 0},
                {type: 'rotate', pieceId: 1}, {type: 'undo'}, {type: 'redo'}
            ]);
            assert.deepEqual(await page.evaluate(() => events.b.commands), []);
            await page.evaluate(() => { views.b.setTool('move'); views.b.setSelection(1); document.getElementById('b').focus(); });
            await page.keyboard.press('ArrowRight');
            assert.deepEqual(await page.evaluate(() => events.b.commands.at(-1)), {type: 'nudge', pieceId: 1, du: 5, dv: 0});
            const before = await page.evaluate(() => events.a.commands.length);
            for (const attrs of [{status: 'cut'}, {invalid: '材料变化'}]) {
                await page.evaluate(attrs => { views.a.setScene({...sc, selectedPiece: 1, segments: sc.segments.map(s => ({...s, ...attrs}))}); document.getElementById('a').focus(); }, attrs);
                await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+z');
            }
            await page.evaluate(() => { views.a.setScene({...sc, selectedPiece: 1}); views.a.setOptions({editable: false}); });
            await page.keyboard.press('r');
            await page.evaluate(() => { views.a.setOptions({editable: true}); views.a.setVisible(false); });
            await page.keyboard.press('ArrowRight');
            await page.evaluate(() => { views.a.setVisible(true); const input = document.createElement('input'); input.id = 'keyboard-field'; document.body.append(input); input.focus(); });
            await page.keyboard.type('r'); await page.keyboard.press('Control+z');
            assert.equal(await page.evaluate(() => events.a.commands.length), before);
            await page.evaluate(() => { document.getElementById('keyboard-field').remove(); views.a.setScene(sc); views.b.setScene(sc); views.b.setTool('pan'); });
        });
        await check('fit selected contour changes only its owner viewport and Escape clears selection', async () => {
            const before = await page.evaluate(() => { views.a.setSelection(1); document.getElementById('a').focus(); return {a: views.a.getView(), b: views.b.getView()}; });
            await page.keyboard.press('f'); await frames(page);
            const fitted = await page.evaluate(() => views.a.getView()); assert.ok(fitted.s > before.a.s);
            for (const [u, v] of [[2100, 100], [3000, 700]]) {
                const p = await point('a', u, v); assert.ok(p.x >= 20 && p.x <= 580 && p.y >= 20 && p.y <= 680);
            }
            assert.deepEqual(await page.evaluate(() => views.b.getView()), before.b);
            await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => events.a.selected.at(-1)), null);
            await page.evaluate(c => { views.a.setScene(sc); views.a.setView(c); }, before.a); await frames(page);
        });
        await check('panning beyond the retained viewport restores every newly visible contour', async () => {
            await page.evaluate(() => {
                const far = structuredClone(sc.segments[0]); far.id = 'far'; far.start += 50000;
                far.pieces = far.pieces.map(p => ({...p, id: 'far-piece', u: p.u + 50000}));
                views.a.setScene({...sc, roll: {...sc.roll, total: 100000}, segments: [...sc.segments, far]}, {refit: true});
                const c = views.a.getView(); views.a.setView({...c, a: c.a - 50000 * c.s});
            }); await frames(page);
            assert.ok(await page.evaluate(() => stageFor('a').find('.roll-piece').some(p => p.getAttr('pieceId') === 'far-piece' && p.isVisible())));
            await page.evaluate(() => views.a.setOptions({view: 'full'})); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-piece').length), 2);
            await page.evaluate(() => { views.a.setOptions({view: 'station'}); views.a.setScene(sc, {refit: true}); }); await frames(page);
        });
        await check('measurement persists through zoom and remains isolated', async () => {
            await page.evaluate(() => views.a.setTool('measure')); await drag('a', 2500, 300, 300, 400);
            const textBefore = await page.evaluate(() => stageFor('a').findOne('.roll-measure').text());
            assert.match(textBefore, /^500 mm/);
            await page.evaluate(() => views.a.zoom(1.15)); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').findOne('.roll-measure').text()), textBefore);
            assert.equal(await page.evaluate(() => views.b.hasMeasure()), false);
        });
        await check('tool switch cancels measurement and defect gestures do not pan', async () => {
            const camera = await page.evaluate(() => { views.a.setTool('defect'); return views.a.getCamera(); });
            await drag('a', 2500, 300, 100, 80);
            const e = await page.evaluate(() => ({m: views.a.hasMeasure(), camera: views.a.getCamera(), defect: events.a.defects.at(-1)}));
            assert.equal(e.m, false); assert.deepEqual(e.camera, camera); assert.deepEqual(e.defect, {u: 2500, v: 300, du: 100, dv: 80});
        });
        await check('cursor anchored wheel zoom does not affect the other instance', async () => {
            await page.evaluate(() => views.a.setTool('pan'));
            const before = await page.evaluate(() => ({a: views.a.getCamera(), b: views.b.getCamera()}));
            const p = {x: 240, y: 350};
            const anchor = await page.evaluate(p => {
                const host = document.getElementById('a'), r = host.getBoundingClientRect(), c = views.a.getCamera();
                return {u: (p.y - r.y - host.clientTop - c.a) / c.s, v: (p.x - r.x - host.clientLeft - c.c) / c.s};
            }, p);
            await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -100);
            await page.waitForFunction(s => views.a.getCamera().s > s, before.a.s); await frames(page);
            const next = await point('a', anchor.u, anchor.v);
            assert.ok(Math.abs(p.x - next.x) < .01 && Math.abs(p.y - next.y) < .01);
            assert.deepEqual(await page.evaluate(() => views.b.getCamera()), before.b);
        });
        await check('exact ratio and view snapshot restore retain scale and offsets', async () => {
            const value = await page.evaluate(() => { const saved = views.a.getView(); views.a.setRatio(20); const scaled = views.a.getView(); views.a.setView(saved); return {saved, scaled, restored: views.a.getView()}; });
            assert.ok(Math.abs(value.scaled.s - 96 / 25.4 / 20) < 1e-9); assert.deepEqual(value.saved, value.restored);
        });
        await check('tiled whole roll clips each column and exposes physical global coordinates', async () => {
            await page.evaluate(() => { views.a.setOptions({view: 'full', fullMode: 'tile'}); }); await frames(page);
            const value = await page.evaluate(() => { const c = views.a.getCamera(); return {rows: c.rows, clips: stageFor('a').find('Group').filter(g => g.clipHeight()).length}; });
            assert.ok(value.rows.n > 1); assert.equal(value.clips, value.rows.n * 2);
            const p = await page.evaluate(() => {
                const c = views.a.getCamera(), r = c.rows;
                return point('a', r.rowLen / 2, sc.roll.width + r.gap + 200);
            });
            await page.mouse.move(p.x, p.y);
            const cursor = await page.evaluate(() => events.a.cursor.at(-1));
            assert.ok(Math.abs(cursor.u - value.rows.rowLen * 1.5) < .1); assert.ok(Math.abs(cursor.v - 200) < .1);
            await page.evaluate(() => views.a.setOptions({view: 'station'})); await frames(page);
        });
        await check('diagnostic overlays and focused bounds belong to only their canvas instance', async () => {
            const other = await page.evaluate(() => {
                const camera = views.b.getView();
                views.a.setScene({...sc, diagnostics: [{message: '裁片 #1 与疵点 #9 干涉', shapes: [{u: 2200, v: 100, du: 900, dv: 600, shape: sc.segments[0].pieces[0].shape}]}]});
                views.a.fitBounds({u0: 2200, u1: 3100, v0: 100, v1: 700}); return camera;
            }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-diagnostic').length), 1);
            assert.equal(await page.evaluate(() => stageFor('b').find('.roll-diagnostic').length), 0);
            assert.deepEqual(await page.evaluate(() => views.b.getView()), other);
            assert.equal(await page.evaluate(() => views.a.fitBounds({u0: NaN, u1: 10, v0: 0, v1: 10})), false);
            await page.evaluate(() => { views.a.setScene(sc); views.a.fit(); }); await frames(page);
            assert.equal(await page.evaluate(() => stageFor('a').find('.roll-diagnostic').length), 0);
        });
        await check('hide and restore preserve camera without consuming hidden gestures', async () => {
            const saved = await page.evaluate(() => { const c = views.a.getView(); views.a.setVisible(false); return c; });
            await page.mouse.move(250, 400); await page.mouse.wheel(0, -100);
            await page.evaluate(() => views.a.setVisible(true)); await frames(page);
            assert.deepEqual(await page.evaluate(() => views.a.getView()), saved);
        });
        await check('destroy is idempotent and remount does not duplicate event handlers', async () => {
            const before = await page.evaluate(() => { const c = views.b.getCamera(); views.a.destroy(); views.a.destroy(); return c; });
            assert.equal(await page.evaluate(() => Konva.stages.length), 1);
            const count = await page.evaluate(() => events.a.contexts.length);
            await page.locator('#a').dispatchEvent('contextmenu', {clientX: 200, clientY: 300});
            assert.equal(await page.evaluate(() => events.a.contexts.length), count);
            await page.evaluate(() => { views.a = make('a'); views.a.setScene(sc); }); await frames(page);
            const p = await point('a', 2600, 150); await page.mouse.click(p.x, p.y, {button: 'right'});
            assert.equal(await page.evaluate(() => events.a.contexts.length), count + 1);
            const n = await page.evaluate(() => { views.a.setTool('defect'); return events.a.defects.length; });
            await drag('a', 2500, 300, 100, 80);
            assert.equal(await page.evaluate(() => events.a.defects.length), n + 1);
            assert.deepEqual(await page.evaluate(() => views.b.getCamera()), before);
        });
        await check('resize at both desktop sizes and narrow entry preserves the manual view', async () => {
            const before = await page.evaluate(() => views.a.getView());
            for (const width of [1920, 390, 1366]) {
                await page.setViewportSize({width, height: 768});
                await page.evaluate(w => document.getElementById('a').style.width = Math.min(600, w - 2) + 'px', width);
                await frames(page); assert.deepEqual(await page.evaluate(() => views.a.getView()), before);
            }
        });
        await check('device pixel ratios 1, 1.25 and 2 preserve physical picking and backing resolution', async () => {
            const scene = await page.evaluate(() => sc);
            let firstScale;
            for (const dpr of [1, 1.25, 2]) {
                const p = await browser.newPage({viewport: {width: 1366, height: 768}, deviceScaleFactor: dpr});
                try {
                    await p.route('**/__roll_dpr', r => r.fulfill({contentType: 'text/html', body: '<script src="/konva.min.js"></script><style>body{margin:0}#host{width:600px;height:700px}</style><div id="host"></div>'}));
                    await p.goto(base + '/__roll_dpr');
                    await p.evaluate(async scene => {
                        const {createRollCanvas} = await import('/js/canvas/roll-canvas.js');
                        window.view = createRollCanvas(document.getElementById('host'), {onPieceSelect: id => window.picked = id});
                        view.setScene(scene); view.setTool('move');
                    }, scene); await frames(p);
                    const point = await p.evaluate(() => {
                        const stage = Konva.stages[0], n = stage.findOne('.roll-piece'), q = n.getAbsoluteTransform().point({x: 30, y: 30});
                        return {...q, backingWidth: stage.getLayers()[0].getCanvas()._canvas.width, ratio: devicePixelRatio};
                    });
                    assert.equal(point.ratio, dpr); assert.equal(point.backingWidth, 600 * dpr);
                    await p.mouse.click(point.x, point.y); assert.equal(await p.evaluate(() => picked), 1);
                    const scale = await p.evaluate(() => view.getCamera().s); firstScale ??= scale;
                    assert.equal(scale, firstScale, 'DPR changes backing resolution, not the physical viewport');
                    await p.evaluate(() => view.destroy()); assert.equal(await p.evaluate(() => Konva.stages.length), 0);
                } finally { await p.close(); }
            }
        });
        await check('all view gestures produce no business requests or browser errors', async () => {
            assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        });
        if (process.env.SCREENSHOT_PATH) await page.screenshot({path: process.env.SCREENSHOT_PATH});
    } finally {
        await browser.close();
        const failed = results.filter(r => !r.success).length;
        console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
        if (failed) process.exitCode = 1;
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
