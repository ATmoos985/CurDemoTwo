import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {parseDemandSheet} from '../../../frontend/src/lib/domain/demand-import-model.js';
import {scenarioExample, garmentExample} from '../../../frontend/src/lib/nesting/scenario-examples.js';
import {createNestingScene, shapeArea} from '../../../frontend/src/lib/canvas/nesting-scene.js';

test('demo inventory catalog agrees with the original order cells', () => {
    const original = JSON.parse(readFileSync(new URL('../fixtures/9.28-orders.json', import.meta.url)));
    const parsed = parseDemandSheet(original);
    const materials = JSON.parse(readFileSync(new URL('../../main/resources/demo/order-materials.json', import.meta.url)));
    assert.equal(materials.length, 27);
    for (const group of parsed.groups) {
        const stock = materials.find(m => m.fabricCode === group.fabricCode);
        assert.equal(stock.materialModel, group.materialModel);
        assert.ok(group.demands.every(d => d.width <= stock.width && d.width <= stock.sampleWidth && d.length <= stock.sampleLength));
    }
});
test('lab scenarios are standalone preview inputs, with clipped defect avoidance and no business inventory IDs', () => {
    for (const id of [3,4,6]) {
        const input = scenarioExample(id), scene = createNestingScene(input);
        assert.equal(input.material.id,`DEMO-${id}`);assert.ok(scene.parts.length > 0);
        assert.equal(input.process.feedMode,id===3?'SHEET':'CONTINUOUS');
        for (const d of input.material.exclusions) {
            assert.ok(d.x >= 0 && d.y >= 0 && d.x+d.shape.width <= input.material.shape.width && d.y+d.shape.height <= input.material.shape.height);
        }
        assert.equal(input.taskId,undefined);assert.equal(input.rollId,undefined);
    }
});

test('garment samples preserve irregular outlines, quantities and fabric direction without inventory writes', () => {
    for (const [id, quantity] of [['GARMENT_SHIRT',4], ['GARMENT_PANTS',6], ['GARMENT_SKIRT',6], ['GARMENT_FULL',26]]) {
        const input = garmentExample(id), scene = createNestingScene(input);
        assert.equal(scene.process.mode, 'CONTOUR');
        assert.equal(input.material.id, `DEMO-${id}`);
        assert.equal(input.parts.reduce((sum,p) => sum+p.quantity,0), quantity);
        for (const part of scene.parts) {
            assert.equal(part.allowRotation, false);
            assert.equal(part.shape.type, 'POLYGON');
            assert.ok(shapeArea(part.shape) > 0 && shapeArea(part.shape) < part.shape.width * part.shape.height);
            assert.ok(part.shape.width <= scene.material.shape.width && part.shape.height <= scene.material.shape.height);
        }
        assert.equal(input.taskId, undefined); assert.equal(input.rollId, undefined);
        input.parts[0].shape.vertices[0].x = -100;
        assert.ok(garmentExample(id).parts[0].shape.vertices[0].x >= 0);
    }
    assert.throws(() => garmentExample('unknown'), /示例不存在/);
});

test('dense garment sample reuses original outlines and supplies enough pieces to fill the cloth', () => {
    const input = garmentExample('GARMENT_FULL');
    const originals = [...garmentExample('GARMENT_SHIRT').parts, garmentExample('GARMENT_SKIRT').parts[1]];
    assert.deepEqual(input.material.shape, {type:'RECTANGLE',width:1500,height:2000});
    assert.deepEqual(input.parts.map(p => p.shape), originals.map(p => p.shape));
    assert.deepEqual(input.parts.map(p => p.quantity), [3,3,8,12]);
    assert.ok(input.parts.reduce((sum,p) => sum + p.quantity * shapeArea(p.shape), 0) > shapeArea(input.material.shape));
    assert.equal(input.timeLimitSeconds, 10);
});
