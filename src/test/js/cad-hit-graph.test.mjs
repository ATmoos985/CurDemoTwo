import test from 'node:test';
import assert from 'node:assert/strict';
import {deferHitGraph} from '../../main/resources/static/js/plugins/cad/cad-hit-graph.js';

test('hit graph refreshes once before picking, including after listening/drag suspension', () => {
    let draws = 0, enabled = true, rendered = 0, geometry = 1;
    const layer = {
        drawHit() { draws++; rendered = geometry; return this; },
        getIntersection() { return enabled ? rendered : null; },
        shouldDrawHit() { return enabled; }
    };
    deferHitGraph(layer);
    layer.drawHit(); layer.drawHit(undefined, undefined);
    assert.equal(draws, 0);
    assert.equal(layer.getIntersection(), 1);
    assert.equal(layer.getIntersection(), 1);
    assert.equal(draws, 1);
    enabled = false; geometry = 2; layer.drawHit();
    assert.equal(layer.getIntersection(), null);
    assert.equal(draws, 1);
    enabled = true;
    assert.equal(layer.getIntersection(), 2);
    assert.equal(draws, 2);
    layer.drawHit({exportCanvas: true});
    assert.equal(draws, 3, 'explicit render targets keep eager drawing');
});
