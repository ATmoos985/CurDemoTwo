import test from 'node:test';
import assert from 'node:assert/strict';
import {DXF_TRIAL_STYLES, MARKER_STYLES, markerExample, markerSummary} from '../../main/resources/static/js/nesting/marker-demo.js';
import {dxfParts} from '../../main/resources/static/js/nesting/dxf-patterns.js';
import {DXF_GARMENT_STYLES, buildDxfStyleParts, parseDxfGarmentText} from '../../main/resources/static/js/nesting/dxf-garment-samples.js';
import {shapeArea} from '../../main/resources/static/js/canvas/nesting-scene.js';
import {cuttingFrame, CUT_PATHS} from '../../main/resources/static/js/intro/cutting-timeline.js';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const sceneFor = (problem, length, complete = true) => ({status:'FEASIBLE', placements:problem.parts.flatMap(part =>
    Array.from({length:part.quantity}, () => ({demandId:part.id, y:length-part.shape.height, shape:part.shape}))).slice(0, complete ? undefined : -1)});
test('marker includes two complete size sets and preserves fixed grain and width', () => {
    const p=markerExample(1400);
    assert.equal(p.material.shape.width,1400);
    assert.equal(p.parts.reduce((n,part)=>n+part.quantity,0),18);
    assert.ok(p.parts.every(part=>!part.allowRotation));
    for (const size of ['M','L']) assert.equal(p.parts.filter(part=>part.name.startsWith(size)).length,6);
    assert.throws(()=>markerExample(0));
});
test('four-piece outlines keep their scale and demand IDs across widths and single-size markers', () => {
    const style = 'GARMENT_FOUR_PIECE', reference = markerExample(1780, style).parts;
    assert.equal(reference.length, 8);
    assert.ok(reference.every(p => p.shape.type === 'POLYGON' && p.quantity === 2));
    for (const size of ['130','140']) {
        const counts = {'130':0, '140':0, [size]:1};
        const expected = reference.filter(p => p.name.startsWith(size + '码')).map(p => ({...p, quantity:1}));
        assert.equal(expected.length, 4);
        assert.deepEqual(markerExample(1500, style, counts).parts, expected);
    }
    assert.throws(() => markerExample(1780, style, {M:2,L:2}));
});
test('one missing piece or substituting another size cannot qualify as a complete marker', () => {
    const p=markerExample(), partial=sceneFor(p,2000,false);
    assert.equal(markerSummary(p,partial).complete,false);
    assert.equal(markerSummary(p,partial).utilization,null);
    partial.placements.push({...partial.placements[0]});
    assert.equal(markerSummary(p,partial).complete,false);
});

test('all DXF grades and handed pieces fit the solver coordinate resolution and retain measured area', () => {
    for (const style of DXF_TRIAL_STYLES) {
        const counts = Object.fromEntries(style.sizes.map(size => [size,1]));
        const original = dxfParts(style, counts, false);
        const parts = markerExample(1780, style.id, counts).parts;
        for (const [i, part] of parts.entries()) {
            const {width,height,vertices} = part.shape;
            const coordinates = [width,height,...vertices.flatMap(({x,y}) => [x,y])];
            assert.ok(coordinates.every(n => Math.abs(n*10 - Math.round(n*10)) < 1e-8), part.name);
            assert.equal(new Set(vertices.map(({x,y}) => x + ',' + y)).size, vertices.length, part.name);
            assert.ok(Math.abs(shapeArea(part.shape)/shapeArea(original[i].shape) - 1) < 0.0015, part.name);
        }
    }
});
test('all garment cases include both sizes and small parts within the fixed fabric width', () => {
    const counts = {GARMENT_SHIRT:18, GARMENT_PANTS:18, GARMENT_SKIRT:14, GARMENT_TANK:10, GARMENT_SHORTS:14,
        GARMENT_APRON:10, GARMENT_GORED_SKIRT:16, GARMENT_GATHERED_SKIRT:8};
    for (const style of MARKER_STYLES) for (const width of [1200,1500,2000]) {
        const p=markerExample(width,style.id);
        assert.equal(p.parts.reduce((sum,part)=>sum+part.quantity,0),counts[style.id]);
        assert.equal(p.material.shape.width,width);
        assert.ok(p.parts.every(part=>!part.allowRotation && part.shape.width<=width));
        for (const size of ['M','L']) assert.ok(p.parts.some(part=>part.name.startsWith(size)));
        assert.equal(markerSummary(p,sceneFor(p,2000,false)).complete,false);
    }
    assert.throws(()=>markerExample(1500,'unknown'));
});
test('utilization uses actual occupied marker length instead of trial material length', () => {
    const p=markerExample(), result=markerSummary(p,sceneFor(p,1800));
    assert.equal(result.complete,true);assert.equal(result.length,1800);
    const longer=structuredClone(p);longer.material.shape.height+=1000;
    assert.equal(markerSummary(longer,sceneFor(longer,1800)).utilization,result.utilization);
});
test('tail accounting preserves decimal lengths and never labels an incomplete kit as finished', () => {
    const p=markerExample(), summary=markerSummary(p,sceneFor(p,1831.5));
    assert.equal(summary.trialLength,2492);
    assert.equal(summary.unusedTail,660.5);
    assert.equal(summary.length+summary.unusedTail,summary.trialLength);
    assert.equal(markerSummary(p,sceneFor(p,2492)).unusedTail,0);
    assert.equal(markerSummary(p,sceneFor(p,1831.5,false)).unusedTail,null);
    assert.equal(markerSummary(p,null).unusedTail,null);
});
test('every separating animation frame comes after all 2D or 1D cuts', () => {
    for(const mode of Object.keys(CUT_PATHS)) {
        for(let t=0;t<13000;t+=10){const frame=cuttingFrame(t,mode);
            if(frame.phase==='裁片分离')assert.equal(frame.complete,CUT_PATHS[mode].length);
            if(frame.phase==='切割')assert.equal(frame.offset,0);
        }
        assert.equal(cuttingFrame(2800,mode).phase,'裁片分离');
    }
});

test('2D crosscut finishes before all remaining edges advance together', () => {
    assert.deepEqual(cuttingFrame(1200,'sheet').progress,[.5,0,0,0,0,0]);
    assert.deepEqual(cuttingFrame(2100,'sheet').progress,[1,.5,.5,.5,.5,.5]);
    assert.equal(cuttingFrame(2100,'sheet').complete,1);
    assert.equal(cuttingFrame(2600,'sheet').complete,6);
    assert.deepEqual(cuttingFrame(1700,'strip').progress,[.5,.5,.5,.5]);
});

test('DXF garment styles preserve 6 sizes (110-160), left-right mirrored pairs, and valid AAMA DXF parsing', () => {
    for (const id of ['DXF_1226', 'DXF_20148D', 'DXF_3129']) {
        const style = DXF_GARMENT_STYLES[id];
        assert.ok(style, id);
        assert.deepEqual(style.sizes, ['110', '120', '130', '140', '150', '160']);
        const parts = buildDxfStyleParts(id, {sizeCounts: {M: 1, L: 1}, fabricFilter: '面布', splitMirrorPairs: true});
        assert.ok(parts.length >= 8, id);
        assert.ok(parts.some(p => p.name.includes('(左)')) && parts.some(p => p.name.includes('(右)')), id);
        const dxfPath = fileURLToPath(new URL('../../main/resources/static/examples/dxf/' + style.file, import.meta.url));
        const buf = fs.readFileSync(dxfPath);
        const text = new TextDecoder('gb18030').decode(buf);
        const parsed = parseDxfGarmentText(text, style.file);
        assert.ok(parsed.groups.length >= 6, style.file);
        assert.ok(parsed.groups[0].demands.every(d => d.shape?.type === 'POLYGON' && d.width > 0 && d.length > 0));
    }
});
