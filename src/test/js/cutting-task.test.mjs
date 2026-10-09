import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
let rows = [];
globalThis.document = { getElementById: () => null, querySelectorAll: () => rows };
const { state } = await import('../../main/resources/static/js/core/state.js');
const { updateDemandCompletionFromPieces, getDemandsFromUI } = await import('../../main/resources/static/js/plugins/solver/quota-manager.js');
const { nextCutPosition, getSnappableNextStation, getSnapThresholdMm, updateFabricScrollPosition, advanceBed, smartAdvanceBed, radarTickStep, setupRadarInteraction, resizeFeedWindow } = await import('../../main/resources/static/js/plugins/radar/radar-scrubber.js');
const { requiredReportLength } = await import('../../main/resources/static/js/plugins/solver/solver-client.js');
const { bus } = await import('../../main/resources/static/js/core/event-bus.js');

test('preview and same-sized pieces never masquerade as reported demand completion', () => {
    state.taskCompleted = {7: 1};
    const data = {demands:[{id:7, count:3}, {id:9, count:2}], pieces:[{demandId:7}, {demandId:9, confirmed:true}]};
    updateDemandCompletionFromPieces(data);
    assert.deepEqual(data.demands.map(d => [d.id, d.completed, d.remaining]), [[7,1,2],[9,0,2]]);
    const before = state.getCurrentCaseData();
    state.setCutMode('remnant');
    assert.equal(state.getCurrentCaseData(), before, 'changing feed source keeps the same workspace and task');
    state.setCutMode('roll');
});

test('deleting another row preserves demand IDs, total and remaining counts', () => {
    rows = [{dataset:{id:'9', rotation:'true'}, getAttribute:()=>'1', querySelector:selector=>({value:({'.dem-name':'保留需求','.dem-w':'2000','.dem-l':'1000','.dem-count':'3'})[selector]})}];
    const demand = getDemandsFromUI()[0];
    assert.equal(demand.id, 9);
    assert.equal(demand.count, 3);
    assert.equal(demand.demand, 2);
    assert.equal(demand.allowRotation, true);
});

test('next station starts after reported stock, including recovered tail beyond finished pieces', () => {
    const data = {stockUsedLength:5000, pieces:[{y:5000,l:2000}], cuts:[], lastReceipt:{feedPortType:'roll',windowStartY:5000,actualCutLen:5000}};
    assert.equal(nextCutPosition(data), 10000);
    assert.equal(nextCutPosition({stockUsedLength:10000, pieces:[], cuts:[]}), 10000);
});

test('all station navigation preserves an unreported plan and requests report confirmation', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:0, totalRollL:100000, bedL:5000, pieces:[{y:0,l:4870}], cuts:[{type:'横切',pos:4870}]});
    const pending = {result:{planId:'unreported'}, windowStartY:0};
    state.pendingPlan = pending;
    let requested = 0;
    const unsubscribe = bus.on('report:requested', () => requested++);
    try {
        for (const move of [() => updateFabricScrollPosition(5000), () => advanceBed(1), () => smartAdvanceBed()]) {
            move();
            assert.equal(data.windowStartY, 0, 'navigation must not abandon the unreported station');
            assert.equal(state.pendingPlan, pending);
            assert.equal(data.cuts.length, 1);
        }
        assert.equal(requested, 3);
    } finally { unsubscribe(); state.pendingPlan = null; }
});

test('report length includes selected recovered tail and radar ticks remain readable', () => {
    assert.equal(requiredReportLength([{y:0,l:4870}], [{y:4870,l:330}]), 5200);
    assert.equal(requiredReportLength([{y:0,l:4870}], []), 4870);
    for (const [length, width] of [[2000,300],[60000,600],[100000,320],[100000,800]]) {
        const step = radarTickStep(length, width);
        assert.ok(step / length * width >= 70, 'major ticks must not overlap');
        assert.ok(Number.isFinite(step) && step > 0);
    }
});

test('resizing uses one length for navigation and reporting, without booking stock or discarding a pending plan',()=>{
    const data=state.getCurrentCaseData();
    Object.assign(data,{materialAvailable:true,rollId:'resize-test',windowStartY:1000,totalRollL:10000,stockRemainingLength:9000,stockUsedLength:1000,bedL:2000,trimStart:0,pieces:[],remnants:[],cuts:[]});
    state.setCutMode('roll');state.pendingPlan=null;
    let changed=0,requested=0;
    const off=bus.on('feed:resized',()=>changed++),offReport=bus.on('report:requested',()=>requested++);
    try{
        assert.equal(resizeFeedWindow(4000.1),true);
        assert.equal(data.bedL,4000.1);assert.equal(data.windowStartY,1000);
        assert.equal(data.stockRemainingLength,9000);assert.equal(changed,1);
        assert.equal(resizeFeedWindow(9000.1),false);assert.equal(data.bedL,4000.1);
        const pending=state.pendingPlan={result:{planId:'keep'}};
        assert.equal(resizeFeedWindow(5000),false);assert.equal(state.pendingPlan,pending);assert.equal(requested,1);
        state.pendingPlan=null;state.setCutMode('remnant');
        assert.equal(resizeFeedWindow(5000),false);assert.equal(data.bedL,4000.1);
    }finally{off();offReport();state.pendingPlan=null;state.setCutMode('roll');}
});

test('the overview handle supports direct drag, track clicks, wheel and keyboard without discarding a pending report', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:0, totalRollL:100000, bedL:5000, pieces:[], remnants:[], cuts:[{type:'横切',pos:5000}]});
    const events = {}, attributes = {};
    let captured = false;
    const classes = new Set();
    const handle = {style:{},
        classList:{
            add(c){ classes.add(c); },
            remove(c){ classes.delete(c); },
            toggle(c, force){
                const val = force !== undefined ? !!force : !classes.has(c);
                val ? classes.add(c) : classes.delete(c);
                return val;
            },
            contains(c){ return classes.has(c); }
        },
        contains:el=>el===handle, focus(){},
        getBoundingClientRect:()=>({left:100+data.windowStartY/100,width:50}),
        setAttribute:(key,value)=>attributes[key]=value, addEventListener:(name,fn)=>events[name]=fn};
    const track = {dataset:{}, querySelectorAll:()=>[], getBoundingClientRect:()=>({left:100,width:1000}),
        setPointerCapture:()=>captured=true, hasPointerCapture:()=>captured, releasePointerCapture:()=>captured=false,
        addEventListener:(name,fn)=>events[name]=fn};
    const originalGet = document.getElementById;
    document.getElementById = id => ({'radar-track':track,'radar-window':handle})[id] || null;
    const fire = (name, args={}) => events[name]({button:0,pointerId:1,target:handle,preventDefault(){},...args});
    let requested = 0;
    const unsubscribe = bus.on('report:requested', () => requested++);
    try {
        setupRadarInteraction();
        fire('pointerdown', {clientX:110});
        assert.equal(data.windowStartY, 0, 'grabbing the handle must not jump');
        fire('pointermove', {clientX:214});
        assert.equal(data.windowStartY, 10400, 'drag preserves the grab offset');
        fire('pointerup');
        assert.equal(data.windowStartY, 10000, 'release snaps to the station');
        assert.equal(data.cuts.length, 0, 'old cuts clear even after a live drag update');
        assert.equal(captured, false);
        fire('pointerdown', {target:track,clientX:625});
        fire('pointerup');
        assert.equal(data.windowStartY, 50000, 'track click centers the handle');
        fire('wheel', {deltaY:1});
        assert.equal(data.windowStartY, 51000);
        fire('keydown', {key:'ArrowLeft'});
        assert.equal(data.windowStartY, 50500);
        fire('keydown', {key:'End'});
        fire('wheel', {deltaY:1});
        assert.equal(data.windowStartY, 95000, 'navigation stays within the mother roll');
        assert.equal(attributes['aria-valuenow'], 95000);
        const pending = state.pendingPlan = {result:{planId:'pending'}};
        fire('pointerdown', {clientX:1060});
        fire('wheel', {deltaY:-1});
        fire('keydown', {key:'Home'});
        assert.equal(requested, 3);
        assert.equal(data.windowStartY, 95000);
        assert.equal(state.pendingPlan, pending);
        assert.equal(captured, false);

        state.pendingPlan = null;
        data.stockUsedLength = 5000;
        // 允许自由回看卷头
        fire('keydown', {key:'Home'});
        assert.equal(data.windowStartY, 0, 'Home allows browsing back to roll origin');
        // 拖拽靠近下一个搭切工位 (5000mm) 时自动吸附
        fire('pointerdown', {clientX:125});
        fire('pointermove', {clientX:170});
        assert.equal(data.windowStartY, 5000, 'dragging near next cut station automatically snaps to it');
        assert.equal(classes.has('snapped'), true, 'snapped state is visually reflected');
        // 超出吸附阈值后可自由左右滑动查看历史
        fire('pointermove', {clientX:125});
        assert.equal(data.windowStartY, 0, 'dragging beyond snap threshold allows free browsing of roll history');
        assert.equal(classes.has('snapped'), false, 'snapped state clears when moving away');
        fire('pointerup');
        assert.equal(data.stockUsedLength, 5000, 'browsing roll history never mutates inventory stock');
    } finally {
        document.getElementById = originalGet;
        state.pendingPlan = null;
        data.stockUsedLength = 0;
        unsubscribe();
    }
});

test('previous station allows free browsing while smartAdvance returns to exact stock boundary', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:5370, stockUsedLength:5370, totalRollL:60000, bedL:5000, pieces:[], cuts:[]});
    state.setCutMode('roll');
    advanceBed(-1);
    assert.equal(data.windowStartY, 370, 'previous station allows browsing earlier fabric');
    smartAdvanceBed();
    assert.equal(data.windowStartY, 5370, 'smart advance returns exactly to the unconsumed cut station');
    updateFabricScrollPosition(100000);
    assert.equal(data.windowStartY, 55000);
    Object.assign(data, {windowStartY:59000, stockUsedLength:59000, bedL:1000});
    advanceBed(-1);
    assert.equal(data.windowStartY, 58000, 'the last partial station navigates smoothly');
    smartAdvanceBed();
    assert.equal(data.windowStartY, 59000, 'smart advance re-aligns to the tail boundary');
    assert.equal(data.stockUsedLength, 59000, 'navigation does not change inventory');
});

test('remnant navigation uses its own zero origin even when its source roll was consumed', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:5000, stockUsedLength:5000, totalRollL:1600, bedL:1600, pieces:[], cuts:[]});
    state.setCutMode('remnant');
    updateFabricScrollPosition(0);
    assert.equal(data.windowStartY, 0);
    state.setCutMode('roll');
    data.stockUsedLength = 0;
});

test('radar magnetic snapping snaps to next station in vicinity while allowing full free scrolling', () => {
    const data = state.getCurrentCaseData();
    Object.assign(data, {windowStartY:37070, stockUsedLength:37070, totalRollL:60000, bedL:5000, pieces:[], cuts:[]});
    state.setCutMode('roll');

    // 1. 下一个可搭切工位起始点
    const snapTarget = getSnappableNextStation(data);
    assert.equal(snapTarget, 37070);

    // 2. 磁吸阈值处于合理范围 (600~1500mm)
    const threshold = getSnapThresholdMm(1000, 60000);
    assert.ok(threshold >= 600 && threshold <= 1500);

    // 3. 自由滑动到卷头 0mm 看卷
    updateFabricScrollPosition(0);
    assert.equal(data.windowStartY, 0, 'can freely view roll head');

    // 4. 自由滑动到卷尾 55000mm 看卷
    updateFabricScrollPosition(55000);
    assert.equal(data.windowStartY, 55000, 'can freely view roll tail');

    // 5. 自由滑动到 18500mm 历史区间看卷
    updateFabricScrollPosition(18500);
    assert.equal(data.windowStartY, 18500, 'can freely view mid-history roll');

    // 6. smartAdvanceBed 自动吸附回到待切工位 37070mm
    smartAdvanceBed();
    assert.equal(data.windowStartY, 37070, 'smart advance aligns to next cut station');

    data.stockUsedLength = 0;
});
