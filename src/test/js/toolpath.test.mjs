import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createPlanHistory, planScene} from '../../main/resources/static/js/plugins/solver/plan-editing.js';

const root = new URL('../../main/resources/static/js/', import.meta.url);
const source = fs.readFileSync(new URL('plugins/toolpath/toolpath-optimizer.js', root), 'utf8');
const app = fs.readFileSync(new URL('app.js', root), 'utf8');
const cuts = () => [
    {step:1, type:'横切', pos:100, start:0, end:200, desc:'调整版贯通分割'},
    {step:2, type:'纵切', pos:150, start:100, end:200, desc:'调整版贯通分割'}
];
function harness() {
    const data = {rollW:200, bedL:200, cutOrigin:'right-bottom', pieces:[], remnants:[], cuts:cuts()};
    const listeners = new Map();
    const ctx = {
        state:{pendingPlan:{result:{planId:'saved-plan'}}, getCurrentCaseData:() => data},
        document:{getElementById:() => null}, console, saves:0, messages:[],
        renderScene(){}, renderCutTable(){}, resetContinuousSim(){}, updateUIInfo(){},
        canUseCurrentPlan:() => true,
        showToast(message){ctx.messages.push(message);}, alert(message){ctx.messages.push(message);},
        recordPlanEdit(){ctx.state.isToolpathOptimized=false;ctx.state.originalCutsBackup=null;},
        bus:{on:(event, handler) => listeners.set(event, handler), emit:event => listeners.get(event)?.()},
        async saveToolpathAdjustment(next){ctx.saves++;data.cuts=JSON.parse(JSON.stringify(next));return true;}
    };
    vm.createContext(ctx);
    vm.runInContext(source.replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/export /g, ''), ctx);
    vm.runInContext(app.slice(app.indexOf("bus.on('toolpath:optimized'"), app.indexOf("bus.on('piece:moved'")), ctx);
    ctx.fetch = async () => ({ok:true, json:async () => ctx.solveLocalSegmentTSP(data.cuts,200,200,true)});
    return {ctx, data};
}

test('saved toolpath optimization and restore keep their state after app events', async () => {
    const {ctx,data}=harness(), original=JSON.stringify(data.cuts);
    await ctx.optimizeCurrentToolpath();
    assert.equal(ctx.saves,1);assert.equal(ctx.state.isToolpathOptimized,true);
    assert.equal(JSON.stringify(ctx.state.originalCutsBackup),original);
    await ctx.restoreOriginalToolpath();
    assert.equal(ctx.saves,2);assert.equal(ctx.state.isToolpathOptimized,false);
    assert.equal(JSON.stringify(data.cuts),original);
});
test('failed saving keeps the previous usable scene and optimization state', async () => {
    const {ctx,data}=harness(), original=JSON.stringify(data);
    ctx.saveToolpathAdjustment=async()=>{throw Error('save failed');};
    await ctx.optimizeCurrentToolpath();
    assert.equal(JSON.stringify(data),original);assert.notEqual(ctx.state.isToolpathOptimized,true);
    assert.ok(ctx.messages.some(m=>m.includes('save failed')));
});
test('a delayed optimizer response cannot overwrite a different plan', async () => {
    const {ctx,data}=harness(), original=JSON.stringify(data.cuts);
    let reply;ctx.fetch=()=>new Promise(resolve=>reply=resolve);
    const pending=ctx.optimizeCurrentToolpath();ctx.state.pendingPlan={result:{planId:'another-plan'}};
    reply({ok:true,json:async()=>ctx.solveLocalSegmentTSP(data.cuts,200,200,true)});
    await pending;assert.equal(ctx.saves,0);assert.equal(JSON.stringify(data.cuts),original);
});
test('unknown dependencies retain parent-before-child even when the child is nearer', () => {
    const {ctx}=harness(), result=ctx.solveLocalSegmentTSP(cuts(),200,200,true);
    assert.equal(result.optimizedCuts[0].type,'横切');
});
test('a legal good route is never replaced by a longer greedy route', () => {
    const {ctx}=harness();
    const input=[[600,2900,2600],[800,2300,2000],[400,2200,1700],[200,1200,300],[1000,900,1400],[1200,2000,2700],[1400,2700,2400]]
        .map(([x,a,b],i)=>({step:i+1,type:'纵切',pos:x,start:Math.min(a,b),end:Math.max(a,b),startX:x,startY:a,endX:x,endY:b,stage:1}));
    const result=ctx.solveLocalSegmentTSP(input,2000,5000,true);
    assert.ok(result.optimizedAirDistance<=result.originalAirDistance);
    assert.equal(result.optimizedCuts.length,input.length);
});
test('home honors all four selected corners and station offsets', () => {
    const {ctx}=harness();
    for(const [origin,x,y] of [['left-top',0,5000],['right-top',2000,5000],['left-bottom',0,10000],['right-bottom',2000,10000]]) {
        const home=ctx.getHomeCoordinates({rollW:2000,bedL:5000,windowStartY:5000,cutOrigin:origin});
        assert.equal(home.x,x);assert.equal(home.y,y);
    }
});

function savedPlanHarness() {
    const data={pieces:[{id:1,planId:'history',confirmed:true},{id:2,planId:'parent'}],remnants:[],cuts:[
        {step:1,type:'横切',pos:5100,start:0,end:200,startX:0,startY:5100,endX:200,endY:5100,stage:1}
    ]};
    const ctx={state:{getCurrentCaseData:()=>data},document:{body:{inert:false}},createPlanHistory,planScene,
        solveContext:()=>'context',crypto:{randomUUID:()=>'toolpath-operation-0001'},updateUIInfo(){}};
    vm.createContext(ctx);vm.runInContext('let validatingAdjustment=false;',ctx);
    const solver=fs.readFileSync(new URL('plugins/solver/solver-client.js',root),'utf8');
    for(const name of ['planGeometry','offsetCuts','saveToolpathAdjustment']) {
        const fn=solver.match(new RegExp('(?:export )?(?:async )?function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
        assert.ok(fn,name);vm.runInContext(fn[0].replace(/export /,''),ctx);
    }
    ctx.state.pendingPlan={result:{planId:'parent'},windowStartY:5000,context:'context',geometry:ctx.planGeometry(),version:1};
    ctx.canUseCurrentPlan=()=>ctx.state.pendingPlan.geometry===ctx.planGeometry();
    return {ctx,data};
}
test('saving uses local station coordinates and keeps historical pieces and a usable new version',async()=>{
    const {ctx,data}=savedPlanHarness();
    ctx.requestJSON=async(url,body)=>{
        assert.equal(url,'/api/cutting/plans/parent/adjust');assert.equal(body.cuts[0].pos,100);
        assert.equal(body.cuts[0].startY,100);assert.equal(body.cuts[0].stage,1);
        return {id:body.adjustmentId,version:2,result:{planId:body.adjustmentId,cuts:body.cuts}};
    };
    assert.equal(await ctx.saveToolpathAdjustment(data.cuts),true);
    assert.equal(ctx.canUseCurrentPlan(),true);assert.equal(ctx.state.pendingPlan.version,2);
    assert.equal(data.cuts[0].pos,5100);assert.equal(data.pieces[0].planId,'history');
    assert.equal(data.pieces[1].planId,'toolpath-operation-0001');assert.equal(ctx.document.body.inert,false);
});
test('lost save responses retain the same operation ID and the original scene for retry',async()=>{
    const {ctx,data}=savedPlanHarness(),scene=JSON.stringify(data);let operation;
    ctx.requestJSON=async(url,body)=>{operation=body.adjustmentId;throw Error('connection lost');};
    await assert.rejects(ctx.saveToolpathAdjustment(data.cuts),/connection lost/);
    assert.equal(JSON.stringify(data),scene);assert.equal(ctx.canUseCurrentPlan(),true);assert.equal(ctx.document.body.inert,false);
    ctx.requestJSON=async(url,body)=>{assert.equal(body.adjustmentId,operation);return {id:operation,version:2,result:{planId:operation,cuts:body.cuts}};};
    assert.equal(await ctx.saveToolpathAdjustment(data.cuts),true);
});
