import test from 'node:test';
import assert from 'node:assert/strict';
import {GARMENT_EXAMPLES, candidateWidths, compactionSavingMm, fabricConsumption, markerRequest, selectMarkerTrial, solveMarkerDirection} from '../../main/resources/static/app/js/model/garment.js';
import {DXF_TRIAL_STYLES, markerExample, markerSizeLabels} from '../../main/resources/static/js/nesting/marker-demo.js';

test('width trials preserve the same single-size or mixed-size bill of pieces, including small parts', () => {
    const style = 'GARMENT_SHIRT', base = markerExample(1500, style);
    for (const sizes of [{M:0,L:3}, {M:2,L:1}, {M:12,L:0}]) {
        const expected = base.parts.map(p => ({...p, quantity:p.quantity * sizes[p.name.charAt(0)]})).filter(p => p.quantity);
        for (const width of [1200, 1850.5, 2000]) {
            const req = markerRequest(style, width, sizes, 'test');
            assert.deepEqual(req.problem.parts, expected);
            assert.equal(req.problem.material.shape.width, width);
            assert.equal(req.requireComplete, true);
            assert.deepEqual(req.strategy, {id:'marker-shortening', version:'2', maxTrials:7});
            assert.equal(req.problem.timeLimitSeconds, 14);
        }
    }
});

test('invalid size counts and out-of-range width candidates are rejected before submission', () => {
    for (const sizes of [{M:0,L:0},{M:-1,L:2},{M:10,L:3},{M:1.2,L:1}])
        assert.throws(() => markerExample(1500, 'GARMENT_SKIRT', sizes));
    for (const input of ['', '1600 900', 'bad', '1600 2001', '1200 1300 1400 1500 1600 1700 1800 1900 2000'])
        assert.throws(() => candidateWidths(input));
    assert.deepEqual(candidateWidths('1600，1850.5、1600 1950'), [1600,1850.5,1950]);
});

test('gap fill requests two spare kits per active size without expanding the order or its allowed angles', () => {
    for (const sizes of [{M:0,L:3}, {M:2,L:1}, {M:12,L:0}]) {
        const [basic, fill] = [false,true].map(on => markerRequest('GARMENT_SHIRT', 1950, sizes, 'test', true, on));
        assert.deepEqual(fill.problem.parts, basic.problem.parts);
        assert.equal(fill.problem.timeLimitSeconds, 15);
        assert.deepEqual(fill.strategy.gapFillLimits, Object.fromEntries(
            basic.problem.parts.map(p => [p.id, 2 * p.quantity / sizes[p.name.charAt(0)]])));
    }
});

test('mass uses total fabric width, occupied length and garment count only for verified complete markers', () => {
    const result = {validationStatus:'PASSED', fulfillmentStatus:'COMPLETE', meetsRequirement:true,
        marker:{occupiedLengthMm:2400}, metrics:[{name:'markerAreaUtilization',value:81.5}]};
    const calculate = override => fabricConsumption({...result,...override}, 1600, 50, 200, 3);
    assert.deepEqual(calculate({}), {length:2400, utilization:81.5, lengthPerGarment:800, gramsPerGarment:264});
    const reported = [{name:'markerAreaUtilizationWithFill',value:86}, ...result.metrics];
    assert.deepEqual(calculate({metrics:reported, marker:{...result.marker, gapFillPlacements:[{id:1},{id:2}]}}),
        {...calculate({}), utilizationWithFill:86, fillCount:2});
    assert.deepEqual(calculate({metrics:reported}), calculate({}));
    assert.deepEqual(calculate({marker:{...result.marker, gapFillPlacements:[]}}), calculate({}));
    assert.equal(calculate({metrics:[{name:'markerAreaUtilizationWithFill',value:81.5}, ...result.metrics],
        marker:{...result.marker, gapFillPlacements:[]}}).fillCount, 0);
    for (const change of [{validationStatus:'FAILED'}, {fulfillmentStatus:'PARTIAL'}, {meetsRequirement:false},
        {marker:{occupiedLengthMm:null}}, {metrics:[]}]) assert.equal(calculate(change), null);
});

test('the four-piece report compares the same sixteen pieces in each direction and caps spares by its actual sizes', () => {
    const example = GARMENT_EXAMPLES.find(e => e.id === 'four-piece-130-140');
    assert.deepEqual(example.widths, [1780]);
    assert.equal(example.gapFill, false);
    assert.equal(example.halfTurn, true);
    assert.equal(GARMENT_EXAMPLES.filter(e => e.benchmark).length, 1);
    assert.equal(example.benchmark.utilization, 83.4);
    assert.equal(example.benchmark.dxfUtilization.toFixed(2), '83.55');
    assert.equal(example.benchmark.length, 1825.1);
    const sizes = {130:example[130], 140:example[140]};
    const fixed = markerRequest(example.style, 1780, sizes, 'fixed');
    const turned = markerRequest(example.style, 1780, sizes, 'turned', true);
    for (const req of [fixed, turned]) {
        for (const size of ['130', '140']) {
            const parts = req.problem.parts.filter(part => part.name.startsWith(size + '码'));
            assert.equal(parts.length, 4);
            assert.deepEqual(parts.map(p => p.quantity), [2, 2, 2, 2]);
            assert.ok(parts.every(p => !p.allowRotation && Boolean(p.allowHalfTurn) === (req === turned)));
        }
        assert.equal(req.problem.parts.length, 8);
        assert.equal(req.strategy.gapFillLimits, undefined);
    }
    const extra = markerRequest(example.style, 1780, {130:0, 140:3}, 'spares', true, true);
    assert.equal(extra.problem.parts.length, 4);
    assert.ok(extra.problem.parts.every(p => p.name.startsWith('140码') && p.quantity === 3));
    assert.deepEqual(extra.strategy.gapFillLimits, Object.fromEntries(extra.problem.parts.map(p => [p.id, 2])));
});

test('missing fabric weight preserves measured utilization and linear consumption without estimating mass', () => {
    const result = {validationStatus:'PASSED', fulfillmentStatus:'COMPLETE', meetsRequirement:true,
        marker:{occupiedLengthMm:2000}, metrics:[{name:'markerAreaUtilization',value:74.5}]};
    const use = fabricConsumption(result, 1780, 0, NaN, 4);
    assert.deepEqual(use, {length:2000, utilization:74.5, lengthPerGarment:500, gramsPerGarment:null});
});

test('DXF presets register every material with real graded sizes and distinct fixed and half-turn trials', () => {
    const presets = GARMENT_EXAMPLES.filter(example => example.source);
    assert.deepEqual(new Set(presets.map(e => e.source)), new Set(['1226','20148D','3129']));
    assert.equal(new Set(GARMENT_EXAMPLES.map(e => e.id)).size, GARMENT_EXAMPLES.length);
    assert.equal(presets.length, DXF_TRIAL_STYLES.length);
    for (const style of DXF_TRIAL_STYLES) {
        const example = presets.find(e => e.id === style.exampleId);
        assert.equal(example.style, style.id);
        assert.ok(example.fabric);
        assert.equal(example.gapFill, false);
        assert.equal(example.halfTurn, true);
        assert.equal(example.gsm, null);
        assert.deepEqual(example.widths, [1780]);
        const counts = Object.fromEntries(markerSizeLabels(style.id).map(size => [size, example[size]]));
        assert.ok(Object.values(counts).every(Number.isInteger));
        const fixed = markerRequest(style.id, 1780, counts, 'fixed');
        const turned = markerRequest(style.id, 1780, counts, 'turned', true);
        assert.deepEqual(fixed.problem.parts, markerExample(1780, style.id).parts);
        assert.equal(fixed.strategy.gapFillLimits, undefined);
        assert.ok(fixed.problem.parts.every(p => !p.allowRotation && !p.allowHalfTurn));
        assert.deepEqual(turned.problem.parts, fixed.problem.parts.map(p => ({...p, allowHalfTurn:true})));
        const filled = markerRequest(style.id, 1780, undefined, 'spares', true, true);
        assert.deepEqual(Object.keys(filled.strategy.gapFillLimits).sort(), fixed.problem.parts.map(p => String(p.id)).sort());
    }
});

test('20148D separates shell and rib requirements for an individual graded size', () => {
    const presets = GARMENT_EXAMPLES.filter(e => e.source === '20148D');
    const count = fabric => {
        const example = presets.find(e => e.fabric === fabric);
        const request = markerRequest(example.style, 1780, {160:1}, '160-only', true, true);
        assert.ok(request.problem.parts.every(p => p.name.startsWith('160码')));
        assert.deepEqual(request.strategy.gapFillLimits, Object.fromEntries(request.problem.parts.map(p => [p.id, 2*p.quantity])));
        return request.problem.parts.reduce((sum, p) => sum + p.quantity, 0);
    };
    assert.equal(count('面布'), 4);
    assert.equal(count('罗纹'), 1);
});

test('compaction savings use the shortest preceding complete occupied length', () => {
    const trials = [
        {complete:true, occupiedLengthMm:1300},
        {complete:false, occupiedLengthMm:800},
        {complete:true, occupiedLengthMm:1110.5, lengthMm:1200}
    ];
    const compact = {phase:'COMPACTION', complete:true, occupiedLengthMm:1100};
    assert.equal(compactionSavingMm([...trials, compact]), 10.5);
    assert.equal(compactionSavingMm(trials), 0);
    assert.equal(compactionSavingMm([compact]), 0);
    assert.equal(compactionSavingMm([trials[1], compact]), 0);
    for (const change of [{complete:false}, {occupiedLengthMm:null}, {occupiedLengthMm:1110.5}, {occupiedLengthMm:1200}])
        assert.equal(compactionSavingMm([...trials, {...compact, ...change}]), 0);
});

test('the allowed direction keeps the verified fixed marker when its normal or timed search falls short', () => {
    const fixed = {request:{id:'fixed'}, result:{id:'fixed'}, use:{length:1200}};
    const worse = {request:{id:'turned'}, result:{id:'turned'}, use:{length:1201}};
    const partial = {...worse, use:null};
    const missing = {...partial, result:null};
    for (const state of ['SUCCEEDED','TIMED_OUT']) {
        for (const trial of [worse, partial, missing]) assert.equal(selectMarkerTrial(state, trial, fixed), fixed);
        for (const length of [1190,1200]) {
            const trial = {...worse, use:{length}};
            assert.equal(selectMarkerTrial(state, trial, fixed), trial);
        }
    }
    for (const state of ['FAILED','CANCELLED']) assert.equal(selectMarkerTrial(state, partial, fixed), partial);
    assert.equal(selectMarkerTrial('SUCCEEDED', worse, {...fixed, use:null}), worse);
});

test('gap fill compares verified occupied area within the fixed length ceiling and breaks ties by length', () => {
    const candidate = (length, utilization, utilizationWithFill) => ({use:{length, utilization, utilizationWithFill}});
    const fixed = candidate(1202, 84, 88);
    for (const trial of [candidate(1203,83,92), candidate(1201,85,87), candidate(1202,84,undefined)])
        assert.equal(selectMarkerTrial('SUCCEEDED', trial, fixed, true), fixed);
    for (const trial of [candidate(1201,85,88), candidate(1202,84,91)])
        assert.equal(selectMarkerTrial('SUCCEEDED', trial, fixed, true), trial);
    const shorter = candidate(1201,85,87);
    assert.equal(selectMarkerTrial('SUCCEEDED', shorter, fixed, false), shorter);
});

test('only a shortened incomplete directional search retries once at the original height', async () => {
    const request = markerRequest('GARMENT_SKIRT', 1500, {M:1,L:1}, 'trial', true);
    const original = request.problem.material.shape.height, fixed = {use:{length:2988.45}};
    const partial = {job:{state:'SUCCEEDED'}, use:null};
    const complete = {job:{state:'SUCCEEDED'}, use:{length:2982.63}};
    async function run(first, retry, active = true, base = fixed) {
        const calls = [];
        let notices = 0;
        const solve = async input => {
            calls.push(input);
            const result = calls.length === 1 ? first : retry;
            if (result instanceof Error) throw result;
            return result;
        };
        const outcome = await solveMarkerDirection(request, base, solve, () => active, () => { notices++; });
        return {...outcome, calls, notices};
    }
    for (const state of ['SUCCEEDED','TIMED_OUT']) {
        const both = await run({...partial, job:{state}}, complete);
        assert.equal(both.trial, complete);
        assert.equal(both.notices, 1);
        assert.deepEqual(both.calls.map(c => c.problem.material.shape.height), [2988.5, original]);
        assert.notEqual(both.calls[0].clientRequestId, both.calls[1].clientRequestId);
        assert.deepEqual(both.calls[1].problem, request.problem);
        assert.match(both.retryNote, /原起长复试/);
    }
    for (const retry of [new Error('HTTP 503'), {job:{state:'FAILED'}}]) {
        const failed = await run(partial, retry);
        assert.equal(failed.calls.length, 2);
        assert.equal(failed.trial, partial);
        assert.match(failed.retryNote, /原起长复试失败/);
        assert.equal(selectMarkerTrial(failed.trial.job.state, failed.trial, fixed), fixed);
    }
    for (const first of [complete, {job:{state:'FAILED'}}, {job:{state:'CANCELLED'}}])
        assert.equal((await run(first, null)).calls.length, 1);
    assert.equal((await run(partial, null, false)).calls.length, 1);
    assert.equal((await run(partial, null, true, {use:{length:original}})).calls.length, 1);
    assert.equal((await run(partial, null, true, null)).calls.length, 1);
    await assert.rejects(run(new Error('HTTP 503'), complete), /HTTP 503/);
});
