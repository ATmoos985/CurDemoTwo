import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendationMarkup,stockSignature} from '../../main/resources/static/js/plugins/material/remnant-recommendation.js';

test('recommendations show stable demand identities, partial output and honest evaluation coverage',()=>{
    const html=recommendationMarkup({candidateCount:10,evaluatedCount:8,deferredCount:2,unavailable:[],recommendations:[{
        stock:{id:'R<1>',width:600,length:1000,location:'A&B'},pieceCount:2,pieceArea:.6,utilization:100,cutCount:1,
        lines:[{demandId:7,name:'<帘>',width:600,length:500,requested:3,placed:2,remaining:1}]}]});
    assert.match(html,/建议先用/);assert.match(html,/2 块尚未评估/);assert.match(html,/结果不能相加/);assert.match(html,/&lt;帘&gt;/);assert.match(html,/\(7\)/);assert.match(html,/整块料头利用率 100.0%/);assert.doesNotMatch(html,/<帘>/);
});
test('stock checks include dimensions, source and defect margin but ignore display-only metadata',()=>{
    const stock={id:'R',sourceRollId:'ROLL',materialBatch:'M',width:600,length:1000,status:'AVAILABLE',defects:[{id:1,x:0,y:0,w:10,h:10,margin:20}]};
    assert.equal(stockSignature(stock),stockSignature({...stock,location:'New shelf',area:.6}));
    for(const changed of [{length:900},{status:'CONSUMED'},{materialBatch:'N'},{sourceRollId:'OTHER'},{defects:[{...stock.defects[0],margin:25}]}])assert.notEqual(stockSignature(stock),stockSignature({...stock,...changed}));
});
test('empty recommendations preserve unavailable reasons instead of claiming infeasibility',()=>{
    const html=recommendationMarkup({candidateCount:1,evaluatedCount:1,deferredCount:0,recommendations:[],unavailable:[{id:'R',status:'UNAVAILABLE',message:'引擎未就绪'}]});
    assert.match(html,/未得到可用推荐/);assert.match(html,/不表示已证明无解/);assert.match(html,/引擎未就绪/);
});
