import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMetrics, materialSummary} from '../../main/resources/static/js/plugins/solver/material-accounting.js';

test('estimated utilization excludes the uncut tail while processing occupancy includes it', () => {
    const data = {rollW:2000, bedL:5000, pieces:[{x:0,y:330,w:2000,l:4540}], cuts:[{type:'横切',pos:4870}]};
    const m = layoutMetrics(data), view = materialSummary(m);
    assert.equal(m.deductLen,4870); assert.equal(m.totalArea,9.74); assert.equal(m.processingArea,10);
    assert.equal(view.utilization.toFixed(1),'93.2'); assert.equal(view.processingUtilization.toFixed(1),'90.8');
    assert.equal(m.wasteArea.toFixed(2),'0.66');
});
test('fractional station coordinates and cut endpoints are preserved without whole-mm rounding', () => {
    const data = {rollW:2000,bedL:5000,windowStartY:5000.2,pieces:[{x:0,y:5000.2,w:2000,l:1200.5}]};
    const m=layoutMetrics(data);assert.equal(m.deductLen,1200.5);assert.equal(m.totalArea,2.401);
    assert.equal(layoutMetrics({...data,cuts:[{type:'纵切',pos:900,start:5000.2,end:7700.8}]}).deductLen,2700.6);
    assert.equal(layoutMetrics({...data,cuts:[{type:'纵切',startX:900,endX:900,startY:5000.2,endY:7700.8}]}).deductLen,2700.6);
});
test('recovered rectangles and vertical tail cuts are included in estimated consumed material', () => {
    const data = {rollW:2000,bedL:5000,pieces:[{x:0,y:0,w:800,l:1000}],remnants:[{x:0,y:1000,w:800,l:2000,area:999}]};
    assert.equal(layoutMetrics(data).deductLen,3000);assert.equal(layoutMetrics(data).remArea,1.6);
    assert.equal(layoutMetrics({...data,cuts:[{type:'纵切',pos:800,start:0,end:5000}]}).totalArea,10);
});
test('sheet use consumes the full sheet with zero mother-roll length, and empty stock has no estimate', () => {
    const data={rollW:2000,bedL:1600,pieces:[{x:0,y:0,w:800,l:1000}]};
    const m=layoutMetrics(data,{sheet:true});assert.equal(m.deductLen,0);assert.equal(m.totalArea,3.2);
    assert.equal(materialSummary(m,true).utilization,25);
    assert.equal(layoutMetrics({...data,pieces:[]},{sheet:true}).totalArea,0);
});
test('actual metrics use the receipt, not the proposed remnants, and do not leak into the next station', () => {
    const data={windowStartY:0,rollW:2000,bedL:5000,pieceArea:8,remArea:2,wasteArea:0,totalArea:10,processingArea:10,
        lastReceipt:{feedPortType:'roll',windowStartY:0,actualCutLen:4500,usedArea:9,pieceArea:8,remArea:.5,wasteArea:.5,processingArea:10}};
    const actual=materialSummary(data);assert.equal(actual.actual,true);assert.equal(actual.totalArea,9);assert.equal(actual.remArea,.5);
    assert.equal(actual.utilization.toFixed(1),'88.9');
    assert.equal(materialSummary({...data,windowStartY:4500}).actual,false);
    assert.equal(materialSummary({...data,lastReceipt:{...data.lastReceipt,status:'REVERSED'}}).actual,false);
});
test('old receipts retain an explicit actual denominator reconstructed from the area ledger', () => {
    const m=materialSummary({windowStartY:0,rollW:2000,bedL:5000,lastReceipt:{feedPortType:'roll',windowStartY:0,actualCutLen:4500,pieceArea:8,remArea:.5,wasteArea:.5}});
    assert.equal(m.totalArea,9);assert.equal(m.utilization.toFixed(1),'88.9');
});
