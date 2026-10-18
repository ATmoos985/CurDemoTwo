import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,validateInput,totals,independentBaseline,planSummary} from '../../main/resources/static/js/linear/linear-model.js';
import {LINEAR_SCENARIOS} from '../../main/resources/static/js/linear/linear-scenarios.js';
import {industry} from '../../main/resources/static/js/industry/industry-profiles.js';

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} ≠ ${expected}`);
const order=(messageText,width,quantity,length=100,surfaceTreatment='X')=>({messageText,width,quantity,length,surfaceTreatment});
const request=orderItems=>({...defaults,minWidth:4200,maxWidth:4400,orderItems});

test('baseline merges identical specs and never mixes widths on one roll',()=>{
    const input=request([order('A',1000,3),order('B',1000,4),order('C',1500,2)]);
    const plan=independentBaseline(input);
    assert.deepEqual(plan.map(row=>[row.comboExpanded,row.usageCount]),[[[1000,1000,1000,1000],1],[[1000,1000,1000],1],[[1500,1500],1]]);
    const summary=planSummary(plan,input);
    assert.deepEqual([summary.rolls,summary.groups,summary.surplus,summary.shortage],[3,3,0,0]);
    near(summary.rate,10000/(3*4600)*100);
    assert.equal(totals(plan,input).rolls,3);
});

test('baseline keeps different roll length or surface treatment apart even at equal width',()=>{
    const plan=independentBaseline(request([order('A',1000,2,100,'X'),order('B',1000,2,100,'Y'),order('C',1000,2,200,'X')]));
    assert.equal(plan.length,3);
});

test('baseline refuses a strip wider than the cuttable zone instead of dividing by zero',()=>{
    assert.throws(()=>independentBaseline(request([order('A',4500,1)])),/超过可切区/);
});

test('summary counts surplus and shortage per spec and leaves surplus out of the yield',()=>{
    const input=request([order('甲',1250,18,6000),order('乙',1520,14,6000),order('丙',1630,10,6000),order('丁',1380,12,6000)]);
    const solved=[{comboExpanded:[1250,1380,1630],usageCount:10,length:6000,surfaceTreatment:'X'},
        {comboExpanded:[1380,1380,1520],usageCount:1,length:6000,surfaceTreatment:'X'},
        {comboExpanded:[1250,1520,1520],usageCount:8,length:6000,surfaceTreatment:'X'}];
    const summary=planSummary(solved,input);
    assert.deepEqual([summary.rolls,summary.groups,summary.surplus,summary.shortage],[19,3,3,0]);
    near(summary.rate,76640/(19*4600)*100);
    const partial=planSummary(solved.slice(0,2),input);
    assert.deepEqual([partial.surplus,partial.shortage],[0,21]);
});

test('scenario inputs are valid and their baselines match the figures checked against the real solver',()=>{
    const expected={film:[22,'75.73'],curtain:[35,'74.69'],board:[33,'82.07']};
    for(const [key,[rolls,rate]] of Object.entries(expected)){
        const {input}=LINEAR_SCENARIOS[key];
        validateInput(input);
        const plan=independentBaseline(input),summary=planSummary(plan,input);
        assert.equal(summary.rolls,rolls,key);
        assert.equal(summary.rate.toFixed(2),rate,key);
        assert.deepEqual([summary.surplus,summary.shortage],[0,0],key);
        assert.equal(totals(plan,input).rolls,rolls,key);
    }
});

test('scenario keys match the one-dimensional scenarios listed in the roll industry profile',()=>{
    assert.deepEqual(Object.keys(LINEAR_SCENARIOS).sort(),industry('roll').scenarios.map(item=>item.key).sort());
});
