// node --test src/test/js/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBounds, stationOrigin, stationCoordinates, rulerOrigin, rulerStep, labelDetail } from '../../main/resources/static/js/plugins/cad/cad-view.js';

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
