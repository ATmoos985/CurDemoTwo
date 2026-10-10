import test from 'node:test';
import assert from 'node:assert/strict';
import {feedLengthLimits, suggestedFeedLength} from '../../main/resources/static/js/plugins/radar/feed-window.js';
import {solveDiagnostics} from '../../main/resources/static/js/plugins/solver/solve-diagnostics.js';

test('length is bounded by the current roll tail, staged use and trim, preserving tenths of a millimeter',()=>{
    assert.deepEqual(feedLengthLimits({totalRollL:10000,windowStartY:6500,stockRemainingLength:8000,trimStart:30.2},500),{min:30.3,max:3500});
    assert.equal(feedLengthLimits({totalRollL:10000,windowStartY:1000,stockRemainingLength:4500},2000).max,2500);
    assert.equal(feedLengthLimits({totalRollL:10000,windowStartY:9999.9,stockRemainingLength:1}).max,.1);
});

test('longest remaining single piece determines the suggestion, not total order length',()=>{
    const request={rollW:2800,trimStart:20,allowLongitudinal:true,demands:[5490,9070,6800,7440].map(length=>({width:2400,length,demand:2}))};
    assert.equal(suggestedFeedLength(request),9090);
    assert.equal(suggestedFeedLength({...request,demands:[{width:2800,length:4000,demand:4}],allowLongitudinal:false}),4020);
    assert.equal(suggestedFeedLength({...request,demands:[{width:2400,length:9000,demand:0}]}),null);
});

test('rotation can shorten a two-dimensional layout but never changes full-width crosscut rules',()=>{
    const request={rollW:4000,allowLongitudinal:true,allowRotation:true,demands:[{width:2000,length:4000,demand:1}]};
    assert.equal(suggestedFeedLength(request),2000);
    assert.equal(suggestedFeedLength({...request,allowLongitudinal:false}),null);
    assert.match(solveDiagnostics({...request,rollL:5000,allowLongitudinal:false}).summary,/仅横切/);
});

test('a length remedy is offered only inside actual stock and roll bounds, never for a fixed remnant',()=>{
    const request={rollW:2000,rollL:2000,totalRollL:10000,windowStartY:5000,remainingLength:5000,allowLongitudinal:false,demands:[{width:2000,length:4000,demand:1}]};
    assert.equal(solveDiagnostics(request).suggestedLength,4000);
    assert.equal(solveDiagnostics({...request,windowStartY:6500}).suggestedLength,null);
    assert.equal(solveDiagnostics({...request,remainingLength:3000}).suggestedLength,null);
    assert.equal(solveDiagnostics({...request,feedPortType:'remnant'}).suggestedLength,null);
});
