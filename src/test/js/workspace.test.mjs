// Run with: node --test src/test/js/workspace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitBounds } from '../../../frontend/src/lib/canvas/cad-view.js';
import { getInitialScenarios } from '../../../frontend/src/lib/nesting/scenarios.js';

test('current-station framing stays centered in both narrow and wide viewports', () => {
    const data = getInitialScenarios()[1];
    for (const [width, height] of [[280, 320], [620, 490], [1100, 720]]) {
        const { scale, x, y } = fitBounds(width, height, {
            x: 0, y: data.windowStartY || 0, width: data.rollW, height: data.bedL
        });
        const top = y + (data.windowStartY || 0) * scale;
        assert.ok(scale > 0);
        assert.ok(x >= 28 && x + data.rollW * scale <= width);
        assert.ok(top >= 28 && top + data.bedL * scale <= height);
        assert.ok(Math.abs(x + data.rollW * scale / 2 - width / 2) < width * .12);
    }
});
