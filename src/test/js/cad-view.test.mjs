// node --test src/test/js/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBounds, stationOrigin, stationCoordinates, rulerOrigin, rulerStep, labelDetail, defectFromCenter } from '../../main/resources/static/js/plugins/cad/cad-view.js';

test('framing reserves screen-space dimensions for small remnants and 100m rolls', () => {
    for (const [width, height] of [[280, 320], [600, 480], [1440, 900]]) {
        for (const bounds of [
            { x: 0, y: 0, width: 800, height: 600 },
            { x: 0, y: 55000, width: 2000, height: 5000 },
            { x: 0, y: 0, width: 2800, height: 100000 }
        ]) {
            const before = structuredClone(bounds);
            const fit = fitBounds(width, height, bounds);
            const x = fit.x + bounds.x * fit.scale, y = fit.y + bounds.y * fit.scale;
            assert.ok(fit.scale > 0 && Number.isFinite(fit.scale));
            assert.ok(x - 44 >= 28, 'vertical dimension stays beyond the ruler');
            assert.ok(y - 48 >= 28, 'width label stays below the ruler');
            assert.ok(x + bounds.width * fit.scale <= width - 29);
            assert.ok(y + bounds.height * fit.scale <= height - 87, 'caption clears playback controls');
            assert.deepEqual(bounds, before, 'view fitting never changes physical geometry');
        }
    }
});

test('all four origins agree with ruler and cursor, including trim and a moved station', () => {
    for (const cutOrigin of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
        const data = { rollW: 2000, bedL: 5000, windowStartY: 15000, trimStart: 20, cutOrigin };
        const origin = stationOrigin(data);
        assert.deepEqual(rulerOrigin(data, false), origin);
        assert.deepEqual(rulerOrigin(data, true), { x: 0, y: 0, dx: 1, dy: 1 });
        assert.equal(origin.x, cutOrigin.startsWith('right') ? 2000 : 0);
        assert.equal(origin.y, cutOrigin.endsWith('bottom') ? 19980 : 15020);
        const local = stationCoordinates(origin.x + origin.dx * 120, origin.y + origin.dy * 350, data);
        assert.deepEqual(local, { x: 120, y: 350 });
        assert.equal(Math.abs(stationCoordinates(origin.x, origin.y, data).y), 0);
    }
});

test('marked centers retain physical coordinates and fractional extents for every station origin', () => {
    for (const cutOrigin of ['left-top', 'right-top', 'left-bottom', 'right-bottom']) {
        const data = {rollW:2000, bedL:5000, totalRollL:30000, windowStartY:15000, trimStart:25.5, cutOrigin};
        const origin = stationOrigin(data);
        const point = {x:origin.x + origin.dx * 375.4, y:origin.y + origin.dy * 800.6};
        const defect = defectFromCenter(point, 100.1, 200.1, 0, data);
        assert.ok(Math.abs(defect.x + defect.w/2 - point.x)<1e-8);
        assert.ok(Math.abs(defect.y + defect.h/2 - point.y)<1e-8);
        assert.equal(defect.margin,0);
        const local = stationCoordinates(point.x,point.y,data);
        assert.ok(Math.abs(local.x-375.4)<1e-8 && Math.abs(local.y-800.6)<1e-8);
    }
});

test('defect extents reject invalid dimensions and all four material boundaries without moving the marker', () => {
    const data = {rollW:2000,totalRollL:30000};
    for (const point of [{x:10,y:1000},{x:1990,y:1000},{x:1000,y:10},{x:1000,y:29990}])
        assert.throws(()=>defectFromCenter(point,100,100,20,data),/超出母卷/);
    for (const values of [[0,100,20],[-10,100,20],[100,NaN,20],[100,100,-1],[100,100,Infinity]])
        assert.throws(()=>defectFromCenter({x:1000,y:20000},...values,data),/有效/);
    assert.deepEqual(defectFromCenter({x:50,y:50},100,100,20,data),{x:0,y:0,w:100,h:100,margin:20});
});

test('adaptive ruler keeps major labels apart at overview and close-up scales', () => {
    for (const scale of [.002, .009, .05, .25, 1, 3]) {
        const pixels = rulerStep(scale) * scale;
        assert.ok(pixels >= 80 && pixels <= 200, `${scale}: ${pixels}`);
    }
});

test('detail is disclosed only when labels fit, and never in full-roll overview', () => {
    assert.equal(labelDetail(2000, 1200, .009), 0);
    assert.equal(labelDetail(800, 400, .1), 1);
    assert.equal(labelDetail(2000, 1200, .1), 2);
    assert.equal(labelDetail(2000, 1200, .5, true), 0);
    assert.equal(labelDetail(2000, 10, 1), 0, 'narrow strips do not carry overlapping text');
});
