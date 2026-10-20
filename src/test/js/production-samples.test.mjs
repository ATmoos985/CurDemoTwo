import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {demandSample} from '../../main/resources/static/js/business/cutting/demand-sample.js';
import {importedTask, parseDemandSheet} from '../../main/resources/static/js/business/cutting/demand-import-model.js';
import {scenarioExample, garmentExample} from '../../main/resources/static/js/nesting/scenario-examples.js';
import {createNestingScene, shapeArea} from '../../main/resources/static/js/canvas/nesting-scene.js';

test('9.28 sample preserves valid RH quantities with real order identities and fabric specs', () => {
    const rows = demandSample.groups.flatMap(group => group.demands);
    assert.equal(demandSample.groups.length,26);assert.equal(rows.length,100);
    assert.equal(rows.reduce((sum,row) => sum + row.quantity,0),156);
    assert.deepEqual(demandSample.excludedRows,[78,79,108,109]);
    assert.ok(rows.every(row => Boolean(row.order) && !row.allowRotation && row.name.includes(row.order)));
    const row12 = rows.find(r => r.row === 12);
    assert.equal(row12.order, '579546');
    assert.ok(row12.name.includes('579546'));
    const cream = importedTask(demandSample,demandSample.groups.findIndex(g=>g.materialModel==='2#A3A-Cream'),'9.28 样例');
    assert.equal(cream.demands.length,11);assert.equal(cream.demands.reduce((n,d)=>n+d.quantity,0),23);
    assert.deepEqual([cream.demands[0].width,cream.demands[0].length,cream.demands[0].quantity],[2170,3250,2]);
});
test('built-in sample and demo inventory catalog agree with the original order cells', () => {
    const original = JSON.parse(readFileSync(new URL('../fixtures/9.28-orders.json', import.meta.url)));
    const parsed = parseDemandSheet(original);
    assert.deepEqual(demandSample.groups, parsed.groups);
    assert.deepEqual(demandSample.issues, parsed.issues);
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

test('lab scenario selector provides all 12 presets, grouped by industry, in nesting page', () => {
    const html = readFileSync(new URL('../../main/resources/static/nesting.html', import.meta.url), 'utf8');
    const selectHtml = html.match(/<select id="scenario-select"[\s\S]*?<\/select>/)?.[0] || '';
    assert.ok(selectHtml.length > 0);
    const options = [...selectHtml.matchAll(/<option value="([^"]*)"([^>]*)>(.*?)<\/option>/g)].map(m => ({ value: m[1], label: m[3], selected: m[2].includes('selected') }));
    assert.deepEqual(options.map(o => [o.value, o.label]), [
        ['', '自定义输入'],
        ['CROSSCUT', '整幅横切'],
        ['GUILLOTINE', '二维避疵'],
        ['3', '短料头复用'],
        ['4', '多规格套裁'],
        ['6', '连续送料工位'],
        ['CONTOUR', '异形排料'],
        ['GARMENT_SHIRT', '上衣裁片'],
        ['GARMENT_PANTS', '长裤裁片'],
        ['GARMENT_SKIRT', '半裙裁片'],
        ['GARMENT_FULL', '衣身袖片密排'],
        ['BOARD_GRAIN', '木纹板 · 禁止旋转'],
        ['BOARD_PLAIN', '素色板 · 允许旋转']
    ]);
    assert.deepEqual([...selectHtml.matchAll(/<optgroup label="([^"]+)"/g)].map(m => m[1]), ['窗帘 · 家纺', '服装', '板材']);
    assert.equal(options.find(o => o.value === 'GUILLOTINE')?.selected, true);
});
