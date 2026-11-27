import test from 'node:test';
import assert from 'node:assert/strict';
import { createNestingScene, rectangle, polygon, shapeArea } from '../../../frontend/src/lib/canvas/nesting-scene.js';

const input = { schemaVersion: '1', unit: 'mm', engine: 'crosscut', timeLimitSeconds: 3,
    material: { id: 'sheet-A', shape: rectangle(2000, 3000), exclusions: [], continuesAfterRegion: false },
    parts: [{ id: 1, name: '裁片', shape: rectangle(2000, 1200), quantity: 3, allowRotation: false }],
    process: { mode: 'CROSSCUT', feedMode: 'SHEET', startCorner: 'right-bottom', trimStart: 0 } };
function result(problem = input) {
    return { schemaVersion: '1', unit: 'mm', coordinateSystem: 'source-local-top-left', status: 'FEASIBLE',
        materialId: problem.material.id, processingRegion: structuredClone(problem.material.shape),
        placements: [{ id: 1, demandId: 1, name: '裁片', x: 0, y: 0, shape: rectangle(1200, 2000), rotationDegrees: 90 }],
        leftovers: [], cuts: [{ sequence: 1, kind: 'HORIZONTAL', startX: 0, startY: 2000, endX: 2000, endY: 2000 }],
        fulfillment: [{ demandId: 1, requested: 3, placed: 1, unplaced: 2 }], metrics: { processingAreaMm2: 6000000, pieceAreaMm2: 2400000 } };
}

test('standard scene preserves placed dimensions and local coordinates without a second rotation', () => {
    const response = result(), before = JSON.stringify([input, response]);
    const scene = createNestingScene(input, response);
    assert.deepEqual(scene.region, { x: 0, y: 0, shape: rectangle(2000, 3000) });
    assert.equal(scene.placements[0].shape.width, 1200);
    assert.equal(scene.placements[0].shape.height, 2000);
    assert.equal(scene.fulfillment[0].unplaced, 2);
    assert.equal(scene.metrics.processingAreaMm2, 6000000);
    scene.placements[0].shape.width = 900;
    assert.equal(JSON.stringify([input, response]), before, 'view edits cannot change input or server result');
});

test('foreign units, coordinate systems, materials and failed results are not painted as a valid plan', () => {
    for (const patch of [{ unit: 'm' }, { coordinateSystem: 'global' }, { materialId: 'other' },
        { processingRegion: rectangle(2000, 6000) }, { status: 'INVALID_RESULT', message: '越界' }])
        assert.throws(() => createNestingScene(input, { ...result(), ...patch }));
    assert.throws(() => createNestingScene({ ...input, unit: 'cm' }));
    assert.throws(() => createNestingScene({ ...input, material: { ...input.material, shape: { type: 'POLYGON', vertices: [] } } }));
});

test('input-only and no-solution scenes retain the submitted processing region and unmet demand', () => {
    const empty = createNestingScene(input);
    assert.equal(empty.placements.length, 0); assert.equal(empty.status, 'INPUT');
    const scene = createNestingScene(input, { ...result(), status: 'NO_SOLUTION_FOUND', placements: [], cuts: [],
        fulfillment: [{ demandId: 1, requested: 3, placed: 0, unplaced: 3 }] });
    assert.equal(scene.fulfillment[0].unplaced, 3); assert.equal(scene.material.shape.height, 3000);
});

const lShape = () => polygon([{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:100,y:100},{x:100,y:200},{x:0,y:200}]);
test('polygon scene retains actual area and independently clones every boundary', () => {
    const p = structuredClone(input); p.material.shape = lShape(); p.parts[0].shape = lShape();
    const output = result(p); output.placements[0].shape = lShape(); output.contours = [{ placementId: 1, closed: true, vertices: lShape().vertices }];
    const scene = createNestingScene(p, output);
    assert.equal(shapeArea(scene.region.shape), 30000);
    assert.equal(shapeArea(rectangle(200,200)), 40000);
    assert.equal(scene.placements[0].rotationDegrees, 90);
    assert.deepEqual(scene.placements[0].shape.vertices, output.placements[0].shape.vertices, 'no second rotation');
    scene.region.shape.vertices[0].x = 9; scene.placements[0].shape.vertices[0].x = 9; scene.contours[0].vertices[0].x = 9;
    assert.equal(p.material.shape.vertices[0].x, 0); assert.equal(output.placements[0].shape.vertices[0].x, 0); assert.equal(output.contours[0].vertices[0].x, 0);
});
test('same bounding box does not make a foreign material outline acceptable', () => {
    const p = structuredClone(input); p.material.shape = lShape();
    const output = result(p); output.processingRegion = rectangle(200,200);
    assert.throws(() => createNestingScene(p,output), /不匹配/);
    output.processingRegion = polygon([{x:0,y:0},{x:200,y:0},{x:0,y:200}]);
    assert.throws(() => createNestingScene(p,output), /不匹配/);
});

test('polygon holes are preserved, deep-cloned, and subtracted from shapeArea', () => {
    const outer = [{x:0,y:0},{x:400,y:0},{x:400,y:300},{x:0,y:300}];
    const hole = [{x:50,y:50},{x:50,y:150},{x:150,y:150},{x:150,y:50}];
    const withHole = polygon(outer, [hole]);
    assert.equal(withHole.holes.length, 1);
    assert.equal(shapeArea(withHole), 400 * 300 - 100 * 100);

    const p = structuredClone(input);
    p.parts[0].shape = withHole;
    const scene = createNestingScene(p);
    assert.equal(scene.parts[0].shape.holes.length, 1);
    assert.equal(shapeArea(scene.parts[0].shape), 110000);
    scene.parts[0].shape.holes[0][0].x = 99;
    assert.equal(p.parts[0].shape.holes[0][0].x, 50);
});
