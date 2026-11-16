import test from 'node:test';
import assert from 'node:assert/strict';
import {SHOWCASE_CASES, showcaseRequest, showcaseScene} from '../../main/resources/static/app/js/model/showcase.js';
import {showcaseTarget} from '../../main/resources/static/js/showcase-redirect.js';

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

test('historical demo links retain scenario and style in new routes without iframes', () => {
    const base = 'http://localhost:8080';
    for (const [path,target] of [['/demos.html','#/showcase'],['/nesting.html?scenario=4','#/showcase/4'],['/demos.html#linear','#/showcase/film'],['/linear-demo.html?scenario=board','#/showcase/board'],['/marker-demo.html?style=GARMENT_PANTS','#/showcase/marker-GARMENT_PANTS'],['/cloth_cad_nesting.html','#/showcase/GUILLOTINE']])
        assert.equal(showcaseTarget(base+path), '/app/'+target);
    assert.equal(showcaseTarget(base+'/nesting.html?classic=1'),null);
    assert.equal(showcaseTarget(base+'/app/'),null);
});

test('workflow templates supply matching material and valid tasks with enough demand for multiple stations', async () => {
    const {WORKFLOW_TEMPLATES, workflowTemplate} = await import('../../main/resources/static/app/js/model/showcase.js');
    const {fromTask, taskProblems} = await import('../../main/resources/static/app/js/model/task-form.js');
    for (const t of WORKFLOW_TEMPLATES) {
        const fixture = workflowTemplate(t.id);
        assert.deepEqual(taskProblems(fromTask(fixture.task)), [], t.id);
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
