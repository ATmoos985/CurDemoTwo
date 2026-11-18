import test from 'node:test';
import assert from 'node:assert/strict';
import {fourPieceReference} from '../../main/resources/static/js/nesting/dxf-reference.js';
import {fourPieceOptimized} from '../../main/resources/static/js/nesting/four-piece-seed.js';
import {pieceVertices, outlinesConflict} from '../../main/resources/static/js/canvas/outline-geometry.js';
import {shapeArea} from '../../main/resources/static/js/canvas/nesting-scene.js';
import {fabricConsumption} from '../../main/resources/static/app/js/model/garment.js';
import {showcaseScene} from '../../main/resources/static/app/js/model/showcase.js';
import {markerRequest, solveMarkerDirection} from '../../main/resources/static/app/js/model/garment.js';

test('the optimized kit is feasible, beats the reference, and seeds only matching solve requests', async () => {
    const {result, verified} = fourPieceOptimized();
    assert.equal(verified.pieceCount, 16);
    assert.equal(verified.rotatedCount, 8);
    assert.equal(verified.occupiedLengthMm, 1806.9);
    assert.ok(verified.utilizationPercent > fourPieceReference().verified.utilizationPercent);
    const rows = result.layout.placements;
    const rings = rows.map(row => pieceVertices(row));
    for (const [i, ring] of rings.entries()) {
        assert.ok(ring.every(p => p.x >= 0 && p.x <= 1780 && p.y >= 0 && p.y <= verified.occupiedLengthMm + 1e-8));
        for (const other of rings.slice(0, i)) assert.equal(outlinesConflict(ring, other, verified.minGapMm), false);
    }
    const request = (w,counts,turn) => markerRequest('GARMENT_FOUR_PIECE', w, counts, 'test', turn);
    const seeded = request(1780,{'130':2,'140':2},true);
    assert.deepEqual(seeded.strategy.initialPlacements,rows.map(({demandId,x,y,rotationDegrees}) => ({demandId,x,y,rotationDegrees})));
    assert.equal(request(1780,{'130':2,'140':2},false).strategy.initialPlacements,undefined);
    assert.equal(request(1780,{'130':1,'140':3},true).strategy.initialPlacements,undefined);
    assert.equal(request(1600,{'130':2,'140':2},true).strategy.initialPlacements,undefined);
    await solveMarkerDirection(seeded, {use:{length:1800}}, async trial => {
        assert.equal(trial.strategy.initialPlacements, undefined);
        return {use:{length:1790}};
    }, () => true);
    assert.equal(seeded.strategy.initialPlacements.length, 16);
});

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
