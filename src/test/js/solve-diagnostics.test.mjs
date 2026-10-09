import test from 'node:test';
import assert from 'node:assert/strict';
import {solveDiagnostics} from '../../main/resources/static/js/plugins/solver/solve-diagnostics.js';
const base={rollW:2800,rollL:5000,remainingLength:97300,allowLongitudinal:true,demands:[{name:'订单',width:2413,length:5490,demand:1}]};
test('actual 9.28 failure identifies workstation length, not mother roll width or stock',()=>{
    const d=solveDiagnostics(base,{status:'NO_SOLUTION_FOUND'});
    assert.equal(d.summary,'超过本次拉布长度');assert.equal(d.lines[0].reason,d.summary);
    assert.equal(d.suggestedLength,5490);
    assert.ok(!d.facts.some(f=>f.includes('无法用这一卷')));
});
test('rotation and longitudinal-cut rules are respected without claiming defects prove infeasibility',()=>{
    assert.equal(solveDiagnostics({...base,rollW:6000,allowRotation:true}).lines[0].reason,'');
    assert.match(solveDiagnostics({...base,demands:[{width:1200,length:800,demand:1}],allowLongitudinal:false}).summary,/仅横切/);
    const d=solveDiagnostics({...base,rollL:10000,defects:[{x:1,y:2}]});assert.equal(d.lines[0].reason,'');assert.ok(d.possible[0].includes('可能'));
});

test('validated later position is distinguished from searched candidates with no result',()=>{
    const request={...base,rollL:9070,windowStartY:25880,totalRollL:100000};
    const forward={search:{found:true,attempts:1},request:{windowStartY:52150,rollL:9070},result:{pieces:[{}]}};
    const found=solveDiagnostics(request,{status:'NO_SOLUTION_FOUND'},forward);
    assert.equal(found.title,'已找到后续可裁位置');
    assert.ok(found.facts.some(f=>f.includes('52.15–61.22')));
    assert.ok(found.facts.some(f=>f.includes('26.27') && f.includes('尚未裁切')));
    assert.deepEqual(found.possible,[]);
    const exhausted=solveDiagnostics(request,{status:'NO_SOLUTION_FOUND'},{search:{exhausted:true,attempts:2}});
    assert.ok(exhausted.facts.some(f=>f.includes('实际求解 2 处') && f.includes('不代表数学证明无解')));
});
