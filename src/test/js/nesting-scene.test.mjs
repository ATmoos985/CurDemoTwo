import test from 'node:test';
import assert from 'node:assert/strict';
import { createNestingScene, rectangle, sceneOrigin } from '../../main/resources/static/js/nesting/nesting-scene.js';
import { createWorkspaceScene } from '../../main/resources/static/js/plugins/cad/workspace-scene.js';
import { NestingSession } from '../../main/resources/static/js/nesting/nesting-client.js';
import { renderNestingGeometry } from '../../main/resources/static/js/nesting/nesting-renderer.js';

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

test('workflow adapter preserves full-material geometry and applies no second station offset', () => {
    const data = { rollId: 'ROLL', rollW: 2000, totalRollL: 12000, bedL: 5000, windowStartY: 5000,
        cutOrigin: 'right-top', trimStart: 10,
        pieces: [{ id: 1, x: 0, y: 0, w: 2000, l: 4500, confirmed: true }, { id: 2, x: 200, y: 5100, w: 800, l: 1200 }],
        remnants: [{ id: 'REM', x: 1200, y: 5000, w: 800, l: 3000 }],
        globalDefects: [{ id: 1, x: 10, y: 6000, w: 100, h: 50, margin: 0 }],
        lastReceipt: { windowStartY: 0, actualCutLen: 5000 },
        cuts: [{ step: 1, type: '横切', pos: 6200, start: 0, end: 2000, startY: 6200, endY: 6200 },
            { step: 2, type: '纵切', pos: 1000, start: 5000, end: 6500 },
            { step: 3, type: '横切', pos: 2000, start: 0, end: 2000 }] };
    const before = JSON.stringify(data), { scene, overlay } = createWorkspaceScene(data);
    assert.equal(scene.material.shape.height, 12000); assert.equal(scene.region.y, 5000);
    assert.equal(scene.placements[1].y, 5100); assert.equal(scene.leftovers[0].y, 5000);
    assert.equal(scene.exclusions[0].y, 6000); assert.equal(scene.exclusions[0].clearance, 0);
    assert.equal(scene.cuts.length, 2); assert.equal(scene.cuts[0].startY, 6200); assert.equal(scene.cuts[1].startY, 5000);
    assert.equal(overlay.completedLength, 5000); assert.deepEqual([...overlay.completedIds], [1]);
    assert.ok(!('confirmed' in scene.placements[0]));
    assert.deepEqual(sceneOrigin(scene), { x: 2000, y: 5010 });
    assert.equal(JSON.stringify(data), before);
});

test('a remnant display uses its own extent and has no implicit completed strip', () => {
    const { scene, overlay } = createWorkspaceScene({ rollW: 500, totalRollL: 1600, bedL: 1600, windowStartY: 0, pieces: [] });
    assert.deepEqual(scene.region.shape, rectangle(500, 1600)); assert.equal(overlay.completedLength, 0);
});

class Node {
    constructor(attrs = {}) { this.attrs = attrs; this.children = []; }
    add(child) { this.children.push(child); }
    destroyChildren() { this.children = []; }
    visible(value) { this.attrs.visible = value; }
    position(value) { Object.assign(this.attrs, value); }
    listening(value) { this.attrs.listening = value; }
}
test('shared renderer honors overlays, explicit cut endpoints and callbacks without moving geometry', () => {
    const scene = createNestingScene(input, result());
    const before = JSON.stringify(scene), groups = Object.fromEntries(['background', 'exclusions', 'leftovers', 'placements', 'cuts', 'boundary'].map(k => [k, new Node()]));
    let selected;
    const badges = renderNestingGeometry({ Rect: Node, Line: Node, Group: Node }, groups, scene,
        { overlay: { completedIds: new Set([1]) }, showPaths: false, onPlacement: (node, p) => { selected = p.id; } });
    assert.equal(groups.placements.children[0].children[0].attrs.width, 1200);
    assert.deepEqual(groups.placements.children[0].children[0].attrs.dash, [5, 4]);
    assert.deepEqual(groups.cuts.children[0].attrs.points, [0, 2000, 2000, 2000]);
    assert.equal(groups.cuts.attrs.visible, false); assert.equal(badges[0].step, 1); assert.equal(selected, 1);
    assert.equal(JSON.stringify(scene), before);
});

test('late successful and failed responses are discarded after input changes', async () => {
    for (const shouldFail of [false, true]) {
        let complete, signal;
        const session = new NestingSession((url, options) => { signal = options.signal; return new Promise((resolve, reject) => { complete = () => shouldFail ? reject(new Error('old failure')) : resolve({ ok: true, json: async () => result() }); }); });
        session.setProblem(input); const pending = session.solve();
        session.setProblem({ ...input, material: { ...input.material, id: 'NEW' } }); complete();
        assert.equal(await pending, null); assert.equal(session.result, null); assert.equal(signal.aborted, true);
    }
});

test('same-input repeated solves accept only the latest response', async () => {
    const pending = [];
    const session = new NestingSession(() => new Promise(resolve => pending.push(resolve)));
    session.setProblem(input); const old = session.solve(), latest = session.solve();
    pending[1]({ ok: true, json: async () => result() }); assert.equal((await latest).placements.length, 1);
    pending[0]({ ok: true, json: async () => ({ ...result(), placements: [] }) });
    assert.equal(await old, null); assert.equal(session.result.placements.length, 1);
});

test('transport sends imported constraints unchanged and propagates structured errors', async () => {
    let request;
    const session = new NestingSession(async (url, options) => { assert.equal(url, '/api/v1/nesting/solve'); request = JSON.parse(options.body);
        return { ok: false, status: 422, json: async () => ({ status: 'UNSUPPORTED', message: '不支持刀缝' }) }; });
    session.setProblem({ ...input, process: { ...input.process, kerf: 2 }, extraConstraint: 'preserve' });
    await assert.rejects(session.solve(), /不支持刀缝/);
    assert.equal(request.process.kerf, 2); assert.equal(request.extraConstraint, 'preserve'); assert.equal(session.result, null);
});

test('invalidating an edited input clears the exportable result', async () => {
    const session = new NestingSession(async () => ({ ok: true, json: async () => result() }));
    session.setProblem(input); await session.solve(); assert.ok(session.result);
    session.invalidate(); assert.equal(session.result, null);
});
