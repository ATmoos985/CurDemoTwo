import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateWidths, fabricConsumption, markerRequest} from '../../main/resources/static/app/js/model/garment.js';
import {markerExample} from '../../main/resources/static/js/nesting/marker-demo.js';

test('width trials preserve the same single-size or mixed-size bill of pieces, including small parts', () => {
    const style = 'GARMENT_SHIRT', base = markerExample(1500, style);
    for (const sizes of [{M:0,L:3}, {M:2,L:1}, {M:12,L:0}]) {
        const expected = base.parts.map(p => ({...p, quantity:p.quantity * sizes[p.name.charAt(0)]})).filter(p => p.quantity);
        for (const width of [1200, 1850.5, 2000]) {
            const req = markerRequest(style, width, sizes, 'test');
            assert.deepEqual(req.problem.parts, expected);
            assert.equal(req.problem.material.shape.width, width);
            assert.equal(req.requireComplete, true);
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

test('mass uses total fabric width, occupied length and garment count only for verified complete markers', () => {
    const result = {validationStatus:'PASSED', fulfillmentStatus:'COMPLETE', meetsRequirement:true,
        marker:{occupiedLengthMm:2400}, metrics:[{name:'markerAreaUtilization',value:81.5}]};
    const calculate = override => fabricConsumption({...result,...override}, 1600, 50, 200, 3);
    assert.deepEqual(calculate({}), {length:2400, utilization:81.5, lengthPerGarment:800, gramsPerGarment:264});
    for (const change of [{validationStatus:'FAILED'}, {fulfillmentStatus:'PARTIAL'}, {meetsRequirement:false},
        {marker:{occupiedLengthMm:null}}, {metrics:[]}]) assert.equal(calculate(change), null);
});
