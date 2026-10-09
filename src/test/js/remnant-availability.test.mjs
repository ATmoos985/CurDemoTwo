import test from 'node:test';
import assert from 'node:assert/strict';
import {remnantAvailability} from '../../main/resources/static/js/plugins/material/remnant-availability.js';

test('new reported stock remains visible in inventory even when no remaining part fits', () => {
    const stocks = [{id:'new-small',materialBatch:'Cream',status:'AVAILABLE'}, {id:'other',materialBatch:'White',status:'AVAILABLE'}];
    const result = remnantAvailability(stocks, [], {rollModel:'Cream',demands:[{demand:3}]});
    assert.equal(result.total,2);assert.equal(result.matching,1);assert.equal(result.fitting,0);
    assert.match(result.message,/尺寸或当前工艺不适合剩余需求/);
});
test('after reporting, recommendations use remaining demand and available stock only', () => {
    const stocks = [{id:'used',materialBatch:'M',status:'CONSUMED'},{id:'new',materialBatch:'M',status:'AVAILABLE'}];
    const candidates = [{id:'used',type:'remnant'},{id:'new',type:'remnant'},{id:'roll',type:'roll'}];
    const request = {rollModel:'M',demands:[{demand:2}]};
    assert.equal(remnantAvailability(stocks,candidates,request).fitting,1);
    assert.match(remnantAvailability(stocks,[],{...request,demands:[]}).message,/没有剩余需求/);
});
