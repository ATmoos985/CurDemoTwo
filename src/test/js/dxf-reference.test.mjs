import test from 'node:test';
import assert from 'node:assert/strict';
import {fourPieceReference} from '../../main/resources/static/js/nesting/dxf-reference.js';
import {pieceVertices, outlinesConflict} from '../../main/resources/static/js/canvas/outline-geometry.js';
import {shapeArea} from '../../main/resources/static/js/canvas/nesting-scene.js';
import {fabricConsumption} from '../../main/resources/static/app/js/model/garment.js';
import {showcaseScene} from '../../main/resources/static/app/js/model/showcase.js';

test('1226 report reconstruction draws the sixteen original graded parts and reports their occupied length', () => {
    const {request, result, verified} = fourPieceReference();
    const {placements} = result.layout;
    assert.equal(placements.length, 16);
    assert.equal(placements.filter(p => p.rotationDegrees === 180).length, 4);
    assert.equal(request.problem.parts.length, 8);
    for (const part of request.problem.parts) {
        const copies = placements.filter(p => p.demandId === part.id);
        assert.equal(part.quantity, 2);
        assert.equal(copies.length, part.quantity);
        for (const p of copies) assert.ok(Math.abs(shapeArea(p.shape) - shapeArea(part.shape)) < 1e-6);
    }
    const scene = showcaseScene(request, result);
    const use = fabricConsumption(result, 1780, 0, null, 4);
    assert.equal(scene.segments[0].pieces.length, verified.pieceCount);
    assert.equal(verified.rotatedCount, 4);
    assert.equal(scene.roll.width, 1780);
    assert.ok(Math.abs(scene.roll.total - 1848.5244) < 1e-6);
    assert.equal(use.length, scene.roll.total);
    assert.ok(Math.abs(verified.cuttingAreaMm2 - 2714185.2567) < 0.01);
    assert.ok(Math.abs(use.utilization - 82.488669) < 0.00001);
});

test('all stock bounds and 120 pair clearances use the rotated, displayed DXF outlines', () => {
    const {request, result, verified} = fourPieceReference();
    const {width, height} = request.problem.material.shape;
    assert.equal(request.problem.process.pieceGap, 0);
    const placements = result.layout.placements;
    const rings = placements.map(p => pieceVertices(p));
    for (const ring of rings) {
        assert.ok(ring.every(v => v.x >= 0 && v.y >= 0 && v.x <= width + 1e-8 && v.y <= height + 1e-8));
    }
    let pairs = 0, closestFound = false;
    for (let i = 0; i < rings.length; i++) for (let j = 0; j < i; j++) {
        pairs++;
        const a = placements[i], b = placements[j];
        // Prune only pairs whose bounding boxes are farther apart than the expected clearance.
        const gapX = Math.max(a.x - b.x - b.shape.width, b.x - a.x - a.shape.width, 0);
        const gapY = Math.max(a.y - b.y - b.shape.height, b.y - a.y - a.shape.height, 0);
        if (Math.hypot(gapX, gapY) > 0.1) continue;
        // outlinesConflict permits one micron of measuring tolerance.
        assert.equal(outlinesConflict(rings[i], rings[j], verified.minGapMm), false, `pieces ${i} and ${j}`);
        if (outlinesConflict(rings[i], rings[j], verified.minGapMm + 0.002)) closestFound = true;
    }
    assert.equal(pairs, 120);
    assert.ok(closestFound);
});
