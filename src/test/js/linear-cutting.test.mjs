import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,sample,validateInput,layout,totals,demandBalance,escapeHtml} from '../../main/resources/static/js/linear/linear-model.js';

test('uses physical width and fixed edges, never repeats transverse widths by roll count',()=>{
    const group={comboExpanded:[2200,1100,1100],rollWidth:4300,usageCount:5};
    assert.deepEqual(layout(group,defaults),{widths:[2200,1100,1100],product:4400,available:4400,remaining:0,wholeRate:4400/4600*100,cuttableRate:100});
    assert.equal(totals([group],defaults).rolls,5);
    assert.equal(totals([group],defaults).product,22000);
});
test('width-weighted cuttable utilization accounts for all repeated rolls',()=>{
    const summary=totals([{comboExpanded:[2100,2100],usageCount:2},{comboExpanded:[2200,2200],usageCount:1}],defaults);
    assert.equal(summary.remaining,400);assert.equal(summary.cuttableRate,12800/13200*100);
});
test('same width in different length/treatment groups cannot hide unmet demand',()=>{
    const rows=demandBalance([{length:1000,surfaceTreatment:'A',width:1100,quantity:2},{length:2000,surfaceTreatment:'B',width:1100,quantity:3}],
        [{length:1000,surfaceTreatment:'A',subRolls:{1100:5},usageCount:1}]);
    assert.deepEqual(rows.map(r=>r.difference),[3,-3]);
});
test('rejects fractional dimensions, overwide orders, and missing data without rounding',()=>{
    assert.equal(validateInput(sample()).orderItems.length,3);
    assert.throws(()=>validateInput({...sample(),leftTrim:0.1}));
    assert.throws(()=>validateInput({...sample(),maxWidth:4600}));
    assert.throws(()=>validateInput({...sample(),orderItems:[]}));
    assert.throws(()=>layout({comboExpanded:[5000]},defaults));
    assert.throws(()=>totals([{comboExpanded:[1000],usageCount:0}],defaults));
});
test('escapes imported order labels before inserting HTML',()=>{
    assert.equal(escapeHtml('<img onerror="x">&'), '&lt;img onerror=&quot;x&quot;&gt;&amp;');
});
