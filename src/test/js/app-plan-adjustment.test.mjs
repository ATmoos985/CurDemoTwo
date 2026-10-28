import test from 'node:test';
import assert from 'node:assert/strict';
import {initialPositions, rotatePiece, rotationAllowed, changedPieces, adjustPayload, applyPositions, placementProblem} from '../../main/resources/static/app/js/model/plan-tools.js';

const outline = {type: 'POLYGON', width: 200, height: 200, vertices: [
    {x: 0, y: 0}, {x: 200, y: 0}, {x: 200, y: 100}, {x: 100, y: 100}, {x: 100, y: 200}, {x: 0, y: 200}]};
const fixture = () => ({request: {rollW: 1000, rollL: 800, windowStartY: 5000, trimStart: 0, pieceGap: 10,
    allowLongitudinal: true, allowRotation: true, cutOrigin: 'left-top', defects: [],
    demands: [{id: 1, allowRotation: true, shape: structuredClone(outline)}, {id: 2, allowRotation: false}]},
    result: {pieces: [{id: 1, demandId: 1, x: 0, y: 0, w: 200, l: 200, rotated: false, rotationDegrees: 0, shape: structuredClone(outline)},
        {id: 2, demandId: 2, x: 110, y: 110, w: 80, l: 80, rotated: false}]}});

test('adjustment precheck accepts interlocked concave parts, rejects real overlap and respects exact clearance', () => {
    const plan = fixture(), before = structuredClone(plan), pos = initialPositions(plan);
    assert.equal(placementProblem(pos, plan, 2), null, 'overlapping bounding boxes are not a collision');
    assert.equal(placementProblem({...pos, 2: {...pos[2], x: 109.9}}, plan, 2).code, 'PIECE');
    const problem = placementProblem({...pos, 2: {...pos[2], x: 20, y: 20}}, plan, 2);
    assert.equal(problem.pieceId, 2); assert.equal(problem.related[0].id, 1);
    assert.deepEqual([problem.subject.x, problem.subject.y], [20, 20], 'diagnostics retain attempted local coordinates');
    assert.deepEqual(plan, before, 'precheck never changes the saved plan');
});

test('defect clearance uses the real outline and identifies the conflicting defect', () => {
    const plan = fixture(), pos = initialPositions(plan); plan.result.pieces.pop();
    plan.request.defects = [{id: 9, x: 115, y: 115, w: 50, h: 50, margin: 10}];
    assert.equal(placementProblem(pos, plan, 1), null, 'defect wholly inside the concave opening is safe');
    plan.request.defects[0].x = 105;
    const problem = placementProblem(pos, plan, 1);
    assert.equal(problem.code, 'DEFECT'); assert.equal(problem.related[0].id, 9);
});

test('bounds, coordinate precision and unsupported geometry cannot pass as valid rectangles', () => {
    const plan = fixture(), pos = initialPositions(plan);
    assert.equal(placementProblem({...pos, 1: {...pos[1], x: -1}}, plan, 1).code, 'BOUNDS');
    assert.equal(placementProblem({...pos, 1: {...pos[1], y: 700}}, plan, 1).code, 'BOUNDS');
    assert.equal(placementProblem({...pos, 1: {...pos[1], x: NaN}}, plan, 1).code, 'POSITION');
    assert.equal(placementProblem({...pos, 1: {...pos[1], x: .01}}, plan, 1).code, 'POSITION');
    plan.result.pieces[0].shape.type = 'CIRCLE';
    assert.equal(placementProblem(pos, plan, 1).code, 'SHAPE');
});

test('rectangular clearance uses the existing axis gap while contour clearance uses edge distance', () => {
    const plan = fixture();
    plan.result.pieces = [{id: 1, demandId: 1, x: 0, y: 0, w: 100, l: 100}, {id: 2, demandId: 2, x: 108, y: 108, w: 100, l: 100}];
    let pos = initialPositions(plan);
    assert.equal(placementProblem(pos, plan, 2), null, 'diagonal distance exceeds 10 mm in contour mode');
    delete plan.request.demands[0].shape;
    assert.equal(placementProblem(pos, plan, 2).code, 'PIECE', 'rectangular workflow requires an axis separation of 10 mm');
    pos[2].x = 110;
    assert.equal(placementProblem(pos, plan, 2), null);
});

test('trim follows the existing contour, roll and bottom-origin sheet rules, and crosscut stays full width', () => {
    const plan = fixture(); plan.result.pieces = [plan.result.pieces[0]]; plan.request.trimStart = 20;
    const pos = initialPositions(plan);
    assert.equal(placementProblem(pos, plan, 1).code, 'TRIM');
    delete plan.result.pieces[0].shape; delete plan.request.demands[0].shape;
    Object.assign(plan.request, {feedPortType: 'remnant', cutOrigin: 'right-bottom'});
    assert.equal(placementProblem(pos, plan, 1), null);
    assert.equal(placementProblem({...pos, 1: {...pos[1], y: 600}}, plan, 1).code, 'TRIM');
    plan.request.trimStart = 0; plan.request.allowLongitudinal = false;
    assert.equal(placementProblem(pos, plan, 1).code, 'CROSSCUT');
});

test('rotation obeys per-pattern grain even when global rotation is enabled', () => {
    const plan = fixture(), pos = initialPositions(plan);
    assert.equal(rotationAllowed(plan, plan.result.pieces[0]), true);
    assert.equal(rotationAllowed(plan, plan.result.pieces[1]), false);
    assert.deepEqual(rotatePiece(pos, plan, 2), pos);
    plan.request.demands[0].allowRotation = false;
    assert.deepEqual(rotatePiece(pos, plan, 1), pos);
    assert.equal(placementProblem({...pos, 1: {...pos[1], rotationDegrees: 90, rotated: true}}, plan, 1).code, 'ROTATION');
});

test('half-turns survive payloads and rendering; an already rotated result is transformed only by the edit delta', () => {
    const plan = fixture(), original = structuredClone(plan); let pos = initialPositions(plan);
    pos = rotatePiece(rotatePiece(pos, plan, 1), plan, 1);
    assert.equal(changedPieces(pos, plan), 1, '180 degrees matters even when width and rotated boolean are unchanged');
    assert.equal(adjustPayload(pos, 'test-adjustment').pieces[0].rotationDegrees, 180);
    const seg = {start: 5000, len: 200, cuts: [1], remnants: [{id: 'old-layout'}], pieces: [{id: 1}]};
    const adjusted = applyPositions(seg, plan, pos), piece = adjusted.pieces[0];
    assert.equal(adjusted.len, 800, 'editing uses the original processing region, not the old suggested feed length');
    assert.deepEqual([adjusted.cuts, adjusted.remnants], [[], []], 'old cut and remnant geometry is no longer valid after edits');
    assert.deepEqual(piece.shape.vertices, outline.vertices.map(v => ({x: 200 - v.x, y: 200 - v.y})));
    assert.deepEqual([piece.u, piece.v], [5000, 0]);
    assert.deepEqual(plan, original);
    Object.assign(plan.result.pieces[0], {shape: piece.shape, rotationDegrees: 180});
    const unchanged = applyPositions(seg, plan, initialPositions(plan)).pieces[0];
    assert.deepEqual(unchanged.shape, piece.shape, 'saved result already contains the rotated contour');
    pos = rotatePiece(rotatePiece(pos, original, 1), original, 1);
    assert.equal(changedPieces(pos, original), 0, 'four quarter-turns return to the original');
});
