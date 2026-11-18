import test from 'node:test';
import assert from 'node:assert/strict';
import {TASK_PACK_GROUPS, taskPackForm} from '../../main/resources/static/app/js/model/task-packs.js';
import {emptyTask, taskProblems, toPayload} from '../../main/resources/static/app/js/model/task-form.js';
import {workflowTemplate} from '../../main/resources/static/app/js/model/showcase.js';
import {DXF_TRIAL_STYLES, markerExample} from '../../main/resources/static/js/nesting/marker-demo.js';

test('garment task packs preserve M/L contours, quantities and process in the save payload', () => {
    for (const {id} of TASK_PACK_GROUPS[0].packs) {
        const form = taskPackForm(id);
        assert.deepEqual(taskProblems(form), [], id);
        const payload = toPayload(form);
        assert.equal(payload.materialModel, 'TC涤棉-B2026');
        assert.equal(payload.process.pieceGap, 5);
        assert.deepEqual(payload.demands, markerExample(1500, id).parts.map(part => ({
            ...part, width: part.shape.width, length: part.shape.height
        })));
        assert.ok(payload.demands.some(d => d.name.startsWith('M码')));
        assert.ok(payload.demands.some(d => d.name.startsWith('L码')));
    }
});

test('general task packs use seeded stock and retain order dimensions and slitting parameters', () => {
    for (const {id} of TASK_PACK_GROUPS.find(group => group.name === '通用业务').packs) {
        const form = taskPackForm(id);
        const template = workflowTemplate(id);
        assert.deepEqual(taskProblems(form), [], id);
        const payload = toPayload(form);
        assert.equal(payload.materialModel, id === 'continuous' ? '窗帘样布-2D' : 'TC涤棉-B2026');
        assert.notEqual(payload.materialModel, template.material.rollModel);
        assert.deepEqual(payload.demands, template.task.demands);
        assert.equal(payload.problemType, template.task.problemType);
        assert.deepEqual(payload.slitting, template.task.slitting);
    }
});

test('DXF task packs retain the source file, fabric, handed contours, and size quantities of the trial', () => {
    assert.ok(DXF_TRIAL_STYLES.length > 0);
    const packs = TASK_PACK_GROUPS.find(group => group.name === '服装 · DXF 纸样').packs;
    assert.deepEqual(packs.map(pack => pack.id), DXF_TRIAL_STYLES.map(style => style.id));
    for (const {id, source, fabric, defaultCounts} of packs) {
        const form = taskPackForm(id);
        assert.deepEqual(taskProblems(form), [], id);
        const payload = toPayload(form);
        assert.equal(payload.materialModel, fabric);
        assert.equal(payload.externalRef, source + '.dxf');
        const expected = markerExample(1780, id, defaultCounts).parts;
        assert.deepEqual(payload.demands, expected.map(({id, name, shape, quantity}) => ({
            id, name, width: shape.width, length: shape.height, quantity, allowRotation: false, shape
        })));
    }
});

test('blank entry remains available and modifying one draft cannot leak into a fresh pack', () => {
    assert.deepEqual(taskPackForm(''), emptyTask());
    const form = taskPackForm('GARMENT_SHIRT');
    const polygon = form.demands.find(d => d.shape.type === 'POLYGON');
    polygon.quantity = 999;
    polygon.shape.vertices[0].x = -42;
    const fresh = taskPackForm('GARMENT_SHIRT').demands.find(d => d.id === polygon.id);
    assert.notEqual(fresh.quantity, polygon.quantity);
    assert.notEqual(fresh.shape.vertices[0].x, -42);
});
