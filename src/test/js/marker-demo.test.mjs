import test from 'node:test';
import assert from 'node:assert/strict';
import {MARKER_STYLES, markerExample, markerSummary, searchMarker} from '../../main/resources/static/js/nesting/marker-demo.js';
import {cuttingFrame, CUT_PATHS} from '../../main/resources/static/js/intro/cutting-timeline.js';

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
test('one missing piece or substituting another size cannot qualify as a complete marker', () => {
    const p=markerExample(), partial=sceneFor(p,2000,false);
    assert.equal(markerSummary(p,partial).complete,false);
    assert.equal(markerSummary(p,partial).utilization,null);
    partial.placements.push({...partial.placements[0]});
    assert.equal(markerSummary(p,partial).complete,false);
});
test('all garment cases include both sizes and small parts within the fixed fabric width', () => {
    const counts = {GARMENT_SHIRT:18, GARMENT_PANTS:18, GARMENT_SKIRT:14};
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
test('length search keeps the best complete result when shorter attempts miss a piece', async () => {
    const p=markerExample();let calls=0;
    const output=await searchMarker(p, async candidate=>{
        assert.equal(candidate.material.shape.width,p.material.shape.width);calls++;
        return {scene:sceneFor(candidate,calls===1?2200:1900,calls<=2),result:{attempt:calls}};
    });
    assert.equal(output.best.result.attempt,2);assert.equal(output.best.summary.length,1900);
    assert.equal(output.first.summary.length,2200);assert.ok(calls<=5);
    assert.equal(output.history[0].length,p.material.shape.height);
    assert.equal(output.history[0].occupiedLength,2200);
    assert.equal(output.history[1].occupiedLength,1900);
    assert.equal(output.history[2].occupiedLength,null);
});
test('no initial complete kit produces no successful result and cancellation stops more trials', async () => {
    const p=markerExample();
    const output=await searchMarker(p,async candidate=>({scene:sceneFor(candidate,2000,false)}));
    assert.equal(output.best,null);assert.equal(output.history.length,1);
    const controller=new AbortController();let calls=0;
    await assert.rejects(searchMarker(p,async candidate=>{calls++;controller.abort();return {scene:sceneFor(candidate,2000)};},{signal:controller.signal}),{name:'AbortError'});
    assert.equal(calls,1);
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
