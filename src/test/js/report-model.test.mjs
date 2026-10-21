import test from 'node:test';
import assert from 'node:assert/strict';
import {reportTotals,csvCell} from '../../main/resources/static/js/business/analysis/report-model.js';
const row=(consumed,qualified,recovered=0)=>({unit:'m2',consumed,qualified,recovered,rejected:0,otherWasteAndLoss:consumed-qualified-recovered});
test('actual yield is area-weighted and recoverable output stays separate',()=>{
 const result=reportTotals({status:'BALANCED',areas:[row(10,5,2),row(100,90,3)]});
 assert.equal(result.consumed,110);assert.equal(result.qualified,95);assert.equal(result.goodRate,95/110);assert.equal(result.recoveryRate,5/110);assert.notEqual(result.goodRate,.7);
});
test('uninitialized, inconsistent, missing and zero-denominator data never show invented percentages',()=>{
 for(const status of ['NOT_INITIALIZED','MISMATCH','UNKNOWN'])assert.equal(reportTotals({status,areas:[row(10,8)]}),null);
 for(const areas of [[],[{...row(1,1),qualified:NaN}],[{...row(1,1),unit:'mm2'}],[{...row(1,1),rejected:undefined}]])assert.equal(reportTotals({status:'BALANCED',areas}),null);
 assert.equal(reportTotals({status:'BALANCED',areas:[row(0,0)]}).goodRate,null);
});
test('CSV quotes records and neutralizes spreadsheet formula prefixes',()=>{
 assert.equal(csvCell('a,"b"\nc'),'"a,""b""\nc"');
 for(const text of ['=1+1','@SUM(A1)',' +x','-2'])assert.ok(csvCell(text).startsWith('"\''));
 assert.equal(csvCell(1.25),'"1.25"');
});
