import test from 'node:test';
import assert from 'node:assert/strict';
import {SHOWCASE_CASES, showcaseRequest, showcaseScene} from '../../../frontend/src/lib/model/showcase.js';

test('all examples have independent inputs and fit the shared canvas without business state', () => {
    assert.equal(new Set(SHOWCASE_CASES.map(c => c.id)).size, SHOWCASE_CASES.length);
    for (const c of SHOWCASE_CASES) {
        const first = showcaseRequest(c.id), before = structuredClone(first), scene = showcaseScene(first);
        assert.ok(first.clientRequestId.length > 0 && first.clientRequestId.length <= 128);
        assert.ok(scene.roll.width > 0 && scene.roll.total > 0, c.id);
        assert.equal(scene.segments[0].pieces.length, 0);
        assert.equal(scene.window.readOnly, true);
        assert.deepEqual(first, before);
        first.problem.unit = 'changed';
        assert.equal(showcaseRequest(c.id).problem.unit, 'mm');
    }
});

test('slitting preserves exact millimetres for 2440 mm boards and metre-based roll orders', () => {
    assert.equal(showcaseRequest('film').problem.orders[0].lengthMm, 6000000);
    assert.equal(showcaseRequest('curtain').problem.orders[0].lengthMm, 50000);
    assert.equal(showcaseRequest('board').problem.orders[0].lengthMm, 2440);
    assert.equal(SHOWCASE_CASES.find(c => c.id === 'board').expectedError, undefined);
    assert.equal(showcaseRequest('board-2m').problem.orders[0].lengthMm, 2000);
    assert.equal(showcaseRequest('film','QUALITY').problem.profile, 'QUALITY');
});

test('same dimensions compare rotation rules without changing requested shapes', () => {
    const off = showcaseRequest('rotation-off'), on = showcaseRequest('rotation-on');
    assert.deepEqual(off.problem.parts[0].shape, on.problem.parts[0].shape);
    assert.equal(off.problem.parts[0].allowRotation, false);
    assert.equal(on.problem.parts[0].allowRotation, true);
    assert.equal(showcaseRequest('gap').problem.process.pieceGap, 10);
});

test('slitting shows one finite default-length crosscut with true strip widths, leaving source lengths unchanged', () => {
    const r = showcaseRequest('curtain');
    const result = {slitting: {patterns: [{lengthMm: 50000, repetitions: 8, stations: [{widthMm: 900, countPerRepetition: 3}]}]}};
    const sc = showcaseScene(r, result);
    assert.equal(sc.segments[0].pieces.length, 3);
    assert.equal(sc.roll.total, 5000);
    assert.equal(sc.window.len, 5000);
    assert.equal(result.slitting.patterns[0].lengthMm, 50000);
    assert.equal(showcaseScene(showcaseRequest('board')).roll.total, 2440);
    assert.deepEqual(sc.segments[0].pieces.map(p => [p.v,p.du,p.dv]), [[20,5000,900],[920,5000,900],[1820,5000,900]]);
});

test('garment marker ends at its occupied length and retains the trial window for unverified or incomplete geometry', () => {
    const request = showcaseRequest('marker-GARMENT_SHIRT');
    const shape = {type:'RECTANGLE', width:1950, height:1257.5};
    const placement = {id:'sleeve', x:200, y:702, shape:{type:'RECTANGLE', width:230, height:500}};
    const result = {meetsRequirement:true, layout:{schemaVersion:'1', unit:'mm', coordinateSystem:'source-local-top-left',
        materialId:request.problem.material.id, processingRegion:shape, status:'FEASIBLE', placements:[placement]}};
    const occupied = {occupiedLengthMm:1202};
    const marker = showcaseScene(request, result, 0, occupied);
    assert.deepEqual([marker.roll.total, marker.roll.shape.height, marker.window.len, marker.segments[0].len,
        marker.segments[0].bedLength, marker.segments[0].totalArea], [1202,1202,1202,1202,1202,1950*1202]);
    assert.equal(marker.segments[0].pieces[0].u + marker.segments[0].pieces[0].du, 1202);
    assert.equal(shape.height, 1257.5);
    assert.equal(showcaseScene(request, result).window.len, 1257.5);
    assert.equal(showcaseScene(request, {...result,meetsRequirement:false}, 0, occupied).window.len, 1257.5);
    assert.equal(showcaseScene(request, result, 0, {occupiedLengthMm:1201}).window.len, 1257.5);
});

test('verified fill pieces keep their contour and coordinates and add their net area once', () => {
    const request = showcaseRequest('marker-GARMENT_SHIRT');
    const sleeve = {id:1, demandId:3, name:'M码 · 袖片', x:500, y:702, shape:{type:'RECTANGLE', width:220, height:500}};
    const result = {meetsRequirement:true, layout:{schemaVersion:'1', unit:'mm', coordinateSystem:'source-local-top-left',
        materialId:request.problem.material.id, processingRegion:{type:'RECTANGLE',width:1950,height:1257.5},
        status:'FEASIBLE', placements:[sleeve]}};
    const collar = {id:1, demandId:4, name:'M码 · 领片', x:0, y:1123, rotationDegrees:180, shape:{
        type:'POLYGON', width:340, height:70, vertices:[{x:0,y:0},{x:340,y:0},{x:330,y:70},{x:10,y:70}]}};
    const before = structuredClone(result);
    const required = showcaseScene(request, result, 0, {occupiedLengthMm:1202}).segments[0];
    const options = {occupiedLengthMm:1202, gapFillPlacements:[collar]};
    const filled = showcaseScene(request, result, 0, options).segments[0];
    assert.deepEqual(filled.pieces.slice(0,1), required.pieces);
    assert.equal(filled.pieces.length, 2);
    const added = filled.pieces[1];
    assert.notEqual(added.id, sleeve.id);
    assert.equal(added.label, '补 · M码 · 领片');
    assert.equal(added.title, added.label);
    assert.deepEqual([added.v,added.u,added.shape], [collar.x,collar.y,collar.shape]);
    assert.equal(filled.pieceArea, required.pieceArea + (340+320)*70/2);
    assert.deepEqual([filled.len, filled.totalArea], [required.len, required.totalArea]);
    assert.deepEqual(result, before);
    assert.equal(showcaseScene(request, {...result,meetsRequirement:false}, 0, options).segments[0].pieces.length, 1);
    const beyondTail = {...options, gapFillPlacements:[{...collar, y:1165}]};
    assert.equal(showcaseScene(request, result, 0, beyondTail).segments[0].len, 1257.5);
});

test('workflow templates supply matching material and valid tasks with enough demand for multiple stations', async () => {
    const {WORKFLOW_TEMPLATES, workflowTemplate} = await import('../../../frontend/src/lib/model/showcase.js');
    const {SLITTING, slittingProblems} = await import('../../../frontend/src/lib/model/slitting.js');
    for (const t of WORKFLOW_TEMPLATES) {
        const fixture = workflowTemplate(t.id);
        assert.ok(fixture.task.name.trim().length > 0, t.id);
        assert.ok(fixture.task.materialModel.trim().length > 0, t.id);
        assert.ok(fixture.task.demands.length > 0 && fixture.task.demands.length <= 200, t.id);
        for (const d of fixture.task.demands) {
            assert.ok(d.width > 0 && d.length > 0 && Number.isInteger(d.quantity) && d.quantity > 0, `${t.id}:${d.name}`);
        }
        if (fixture.task.problemType === SLITTING) {
            assert.equal(slittingProblems(fixture.task.slitting, fixture.task.demands), null, t.id);
        }
        assert.equal(fixture.material.rollModel,fixture.task.materialModel);
        assert.ok(fixture.material.length * 1000 > fixture.task.process.bedLength * 2);
        fixture.task.demands[0].quantity = 0;
        assert.ok(workflowTemplate(t.id).task.demands[0].quantity > 0);
    }
});

// 需求数量和面积足以支持密排；实际密度由真实求解浏览器验收，不伪造布局。
test('garment batches and remnant examples provide enough varied pieces to fill the region', () => {
    for (const id of ['GARMENT_SHIRT', 'GARMENT_PANTS']) {
        const p = showcaseRequest(id).problem;
        assert.ok(p.parts.length >= 10);
        assert.ok(p.parts.reduce((n, part) => n + part.quantity, 0) >= 30);
    }
    const p = showcaseRequest('3').problem;
    assert.ok(p.parts.reduce((n, part) => n + part.shape.width * part.shape.height * part.quantity, 0) > p.material.shape.width * p.material.shape.height * .9);
    assert.ok(showcaseRequest('GUILLOTINE').problem.parts.some(p => p.name.includes('长条') && p.shape.width === 2000));
});
