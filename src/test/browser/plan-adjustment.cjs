// node src/test/browser/plan-adjustment.cjs
// Set PLAYWRIGHT_MODULE and CHROME_PATH when using a bundled browser runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {createServer} = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../main/resources/static');
let tasks, failSave, requests, failAdjustment, adjustmentBodies, reportBodies, savedPlanRequest, solveResult, acceptReport, receipts, stock, solveWait, candidateItems, candidateBodies, failCandidates, failMaterialRead, candidateWait, extraRolls;
const planRequest={taskId:"task-a", taskRevision:1, rollId:"ROLL-2026-0920",rollModel:"TC涤棉-B2026",rollW:2000,rollL:5000,totalRollL:60000,windowStartY:0,feedPortType:"roll",trimStart:0,cutOrigin:"right-bottom",firstStageOrientation:"horizontal",allowRotation:false,allowLongitudinal:false,demands:[{id:7,name:"主帘",width:2000,length:1200,demand:2}],minRemnantWidth:200,minRemnantLength:300};
const planResult={success:true,planId:"original-plan",pieces:[{id:1,demandId:7,name:"主帘",x:0,y:0,w:2000,l:1200,rotated:false},{id:2,demandId:7,name:"主帘",x:0,y:1500,w:2000,l:1200,rotated:false}],remnants:[],cuts:[{step:1,type:"横切",pos:1200,start:0,end:2000,desc:"横切"},{step:2,type:"横切",pos:2700,start:0,end:2000,desc:"横切"}],deductLen:2700,engine:"crosscut"};
const roll = {rollId:'ROLL-2026-0920', rollModel:'TC涤棉-B2026', width:2000, totalLength:60000, usedLength:0, currentRemainingLength:60000, defects:[]};
const secondRoll={...roll,rollId:'ROLL-SECOND',storageLocation:'B-02'};
const remnantStock={id:'REM-CHOICE',sourceRollId:roll.rollId,materialBatch:roll.rollModel,width:2000,length:3000,location:'A-01',defects:[],area:6};
const candidateList=()=>[{type:'remnant',id:remnantStock.id,rollId:roll.rollId,width:2000,length:3000,location:'A-01',fittingLines:1},
{type:'roll',id:secondRoll.rollId,rollId:secondRoll.rollId,width:2000,length:60000,location:'B-02',fittingLines:1},
{type:'roll',id:roll.rollId,rollId:roll.rollId,width:2000,length:60000,location:'B-01',fittingLines:1}];
const initialTask = () => ({id:'task-a', revision:1, name:'已保存需求', materialModel:roll.rollModel, externalRef:'ORDER-A',
    process:{bedLength:5000,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false},
    demands:[{id:7,name:'主帘',width:2000,length:1200,quantity:3,allowRotation:false}]});
const server = createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (value, status=200) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (url.pathname.startsWith('/api/')) {
        requests.push(req.method + ' ' + url.pathname);
        if (url.pathname === '/api/rolls' && req.method === 'GET') return json([stock,...extraRolls]);
        if (url.pathname === '/api/rolls' && req.method === 'POST') {let raw='';for await(const chunk of req)raw+=chunk;const r=JSON.parse(raw);extraRolls.push({...r,usedLength:0,currentRemainingLength:r.totalLength});return json(r);}
        if(url.pathname==='/api/cutting/material-candidates'){let raw='';for await(const chunk of req)raw+=chunk;candidateBodies.push(JSON.parse(raw));await candidateWait;return json(failCandidates?{message:'测试库存读取失败'}:candidateItems,failCandidates?503:200);}
        if(url.pathname==='/api/remnants/scan'){let raw='';for await(const chunk of req)raw+=chunk;const id=JSON.parse(raw).id;return json(failMaterialRead?{message:'测试材料读取失败'}:remnantStock,failMaterialRead?503:200);}
        if(extraRolls.some(r=>url.pathname==='/api/rolls/'+r.rollId))return json(failMaterialRead?{message:'测试材料读取失败'}:extraRolls.find(r=>url.pathname.endsWith('/'+r.rollId)),failMaterialRead?503:200);
        if (url.pathname === '/api/rolls/' + roll.rollId) return json(stock);
        if (url.pathname === '/api/remnants') return json([]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'GET') return json([...tasks.values()]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            if (failSave) return json({message:'测试保存失败'}, 503);
            const body = JSON.parse(raw), id = body.id || 'task-new';
            const task = {...body, id, revision:(tasks.get(id)?.revision || 0)+1}; tasks.set(id,task); return json(task);
        }
        if(url.pathname==='/api/solve'){let raw='';for await(const chunk of req)raw+=chunk;savedPlanRequest=JSON.parse(raw);await solveWait;return json(solveResult);}
        if (url.pathname.endsWith('/adjust')) {
            let raw=''; for await(const chunk of req) raw+=chunk; const body=JSON.parse(raw); adjustmentBodies.push(body);
            if(failAdjustment)return json({message:'当前调整不能完成贯通切割'},400);
            const pieces=body.pieces.map(p=>({...planResult.pieces.find(s=>s.id===p.id),...p}));
            return json({id:body.adjustmentId,version:2,parentPlanId:planResult.planId,request:savedPlanRequest,result:{...planResult,planId:body.adjustmentId,pieces,remnants:[],cuts:pieces.map((p,i)=>({step:i+1,type:'横切',pos:p.y+p.l,start:0,end:2000,desc:'调整版'})),deductLen:Math.max(...pieces.map(p=>p.y+p.l))}});
        }
        if(url.pathname==='/api/cutting/report-confirm'){
            let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);reportBodies.push(body);
            if(!acceptReport)return json({message:'测试仅检查报工绑定，不写库存'},400);
            const pieceResults=body.pieceResults.map(r=>({...planResult.pieces.find(p=>p.id===r.pieceId),...r}));
            const good=pieceResults.filter(r=>r.outcome==='QUALIFIED'),bad=pieceResults.filter(r=>r.outcome==='REJECTED'),uncut=pieceResults.filter(r=>r.outcome==='UNCUT');
            const pieceArea=good.reduce((a,p)=>a+p.w*p.l/1e6,0),remArea=body.actualRemnants.reduce((a,r)=>a+r.w*r.l/1e6,0),usedArea=stock.width*body.actualCutLen/1e6;
            stock.usedLength+=body.actualCutLen;stock.currentRemainingLength-=body.actualCutLen;
            const derivedRemnants=body.actualRemnants.map((r,i)=>({id:'TEST-REC-'+i,width:r.w,length:r.l,location:body.location}));
            const recoveredGeometry=body.actualRemnants.map((r,i)=>({...r,id:derivedRemnants[i].id}));
            const receipt={...body,taskId:'task-a',status:'CONFIRMED',undo:{},rollId:stock.rollId,feedPortType:'roll',windowStartY:0,pieceResults,
                rejectedPieceCount:bad.length,uncutPieceCount:uncut.length,demandQuantities:{7:good.length},pieceArea,remArea,usedArea,wasteArea:usedArea-pieceArea-remArea,
                utilization:pieceArea/usedArea*100,derivedRemnants,recoveredGeometry,remainingLength:stock.currentRemainingLength,confirmedAt:new Date().toISOString()};
            receipts.push(receipt);return json(receipt);
        }
        if(url.pathname.endsWith('/reverse')){const receipt=receipts.find(r=>r.planId===url.pathname.split('/').at(-2));let raw='';for await(const chunk of req)raw+=chunk;
            receipt.status='REVERSED';receipt.reversalReason=JSON.parse(raw).reason;stock.usedLength-=receipt.actualCutLen;stock.currentRemainingLength+=receipt.actualCutLen;return json(receipt);}
        const task = tasks.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        if (task) return json({task,completed:{7:1+receipts.filter(r=>r.status!=='REVERSED').reduce((n,r)=>n+r.finishedPieceCount,0)},reports:receipts});
        return json({message:'unexpected fixture route'},404);
    }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) {res.writeHead(403);return res.end();}
    try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)] || 'application/octet-stream'}); res.end(body);
    } catch {res.writeHead(404);res.end();}
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed=0, failed=0;
    async function run(name, verify) {
        tasks = new Map([['task-a',initialTask()]]); failSave=false; requests=[]; failAdjustment=false; adjustmentBodies=[];reportBodies=[];savedPlanRequest=planRequest;solveResult=planResult;acceptReport=false;receipts=[];stock={...roll};solveWait=undefined;candidateItems=[];candidateBodies=[];failCandidates=false;failMaterialRead=false;candidateWait=undefined;extraRolls=[];
        const context = await browser.newContext({viewport:{width:1366,height:768}}), page = await context.newPage(), errors=[];
        page.on('pageerror',error => errors.push(error.message));
        try {
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await expect(page.locator('body')).not.toHaveAttribute('inert','');
            await verify(page);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(r => !r.startsWith('POST') || ['/adjust','/report-confirm','/solve','/tasks','/reverse','/material-candidates','/scan','/rolls'].some(route=>r.endsWith(route))), 'only isolated fixture task, solve, adjustment and report requests');
            passed++; console.log('PASS ' + name);
        } catch(error) {failed++; console.error('FAIL ' + name + '\n' + error.stack); console.error(JSON.stringify({requests,adjustmentBodies,savedPlanRequest,errors,debug:await page.evaluate(()=>{const s=window.camApp.state;return {pending:s.pendingPlan?.result?.planId,version:s.pendingPlan?.version,geometry:s.pendingPlan?.geometry,pieces:s.getCurrentCaseData().pieces,cuts:s.getCurrentCaseData().cuts,remnants:s.getCurrentCaseData().remnants};})}));}
        finally {await context.close();}
    }
    const loadPlan = async page => {
        await page.getByRole('button',{name:'打开任务',exact:true}).click();await page.locator('[data-task="task-a"]').click();
        await expect(page.locator('#task-picker')).not.toBeVisible();
        await expect(page.locator('body')).not.toHaveAttribute('inert','');
        await expect(page.locator('#task-state')).toContainText('已保存');
        await page.evaluate(async saved => {
            const {restoreSavedPlan}=await import('/js/plugins/solver/solver-client.js');restoreSavedPlan(saved);
            window.camApp.setSelectedPieceId(2);
        },{request:planRequest,result:planResult,version:1});
        await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
    };
    try {
        await run('move invalidates old cuts and report, undo and redo preserve exact geometry',async page=>{
            await loadPlan(page);await page.keyboard.press('ArrowDown');
            await expect(page.locator('#lbl-report-status')).toHaveText('手动调整 · 待校验');
            await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces[1].y),1505);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().cuts.length),0);
            await page.getByRole('button',{name:'打印工单',exact:true}).click();
            await expect(page.locator('#cam-cut-ticket-modal')).toHaveCount(0);
            await page.locator('#btn-undo-plan').click();await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces[1].y),1500);
            await page.locator('#btn-redo-plan').click();await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            await page.keyboard.press('Control+z');await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
            await page.keyboard.press('Control+y');await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            fs.mkdirSync('target/plan-adjustment',{recursive:true});await page.screenshot({path:'target/plan-adjustment/edited-1366.png'});
        });
        await run('server rejection retains edits and exposes persistent recovery with undo',async page=>{
            await loadPlan(page);await page.keyboard.press('ArrowDown');failAdjustment=true;
            await page.locator('#btn-validate-adjustment').click();
            await expect(page.locator('#plan-edit-message')).toContainText('不能完成贯通切割');
            await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces[1].y),1505);
            await page.locator('#btn-undo-plan').click();await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
        });
        await run('accepted adjusted version becomes the only printable and reportable plan',async page=>{
            await loadPlan(page);await page.keyboard.press('ArrowDown');await page.locator('#btn-validate-adjustment').click();
            await expect(page.locator('#plan-edit-message')).toHaveText('方案版本 2 · 已校验');
            await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();await expect(page.locator('#btn-undo-plan')).toBeDisabled();
            assert.equal(adjustmentBodies[0].pieces[1].y,1505);
            await page.getByRole('button',{name:'打印工单',exact:true}).click();await expect(page.locator('#cam-cut-ticket-modal')).toBeVisible();
            await page.evaluate(()=>window.camApp.closeCutTicketModal());
            await page.locator('#btn-confirm-station-cut').click();await expect(page.locator('#report-actual-len')).toHaveValue('2705');
            await page.locator('#report-confirm-button').click();await expect(page.locator('#report-error')).toContainText('测试仅检查报工绑定');
            assert.equal(reportBodies[0].planId,adjustmentBodies[0].adjustmentId);
            assert.notEqual(reportBodies[0].planId,planResult.planId);
            await page.screenshot({path:'target/plan-adjustment/report-version-1366.png'});
        });
        await run('deletion can be undone and cannot mutate the saved source result',async page=>{
            await loadPlan(page);await page.keyboard.press('Delete');
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces.length),1);
            assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.pieces.length),2);
            await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            await page.locator('#btn-undo-plan').click();await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces.length),2);
        });
        await run('next station sends source IDs and local coordinates without historical pieces',async page=>{
            await loadPlan(page);
            await page.evaluate(()=>{
                const state=window.camApp.state,data=state.getCurrentCaseData();state.pendingPlan=null;
                data.pieces.forEach(p=>p.confirmed=true);data.windowStartY=5000;
                document.getElementById('inp-window-start-y').value='5000';
            });
            await page.locator('#btn-trigger-solve-station').click();
            await expect.poll(()=>page.evaluate(()=>window.camApp.state.pendingPlan?.windowStartY)).toBe(5000);
            await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();
            await page.evaluate(()=>window.camApp.setSelectedPieceId(4));await page.keyboard.press('ArrowDown');
            await page.locator('#btn-validate-adjustment').click();await expect(page.locator('#plan-edit-message')).toHaveText('方案版本 2 · 已校验');
            assert.deepEqual(adjustmentBodies[0].pieces.map(p=>p.id),[1,2]);
            assert.equal(adjustmentBodies[0].pieces[1].y,1505);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces[1].y),6505);
        });
        await run('toast and ledger use the same denominator, while report input preserves tenths of a millimetre',async page=>{
            await loadPlan(page);
            solveResult={...planResult,pieces:[{...planResult.pieces[0],y:330,l:4540}],cuts:[{type:'横切',pos:4870,start:0,end:2000,step:1}],deductLen:4870,pieceArea:9.08,totalArea:10};
            await page.locator('#btn-trigger-solve-station').click();
            await expect.poll(()=>page.evaluate(()=>window.camApp.state.pendingPlan?.result.pieceArea)).toBe(9.08);
            await expect(page.locator('#lbl-utilization')).toHaveText('93.2%');
            await expect(page.locator('#lbl-utilization-title')).toHaveText('预计利用率');
            await expect(page.locator('#lbl-processing-utilization')).toHaveText('90.8%');
            await expect(page.locator('.workbench-toast').filter({hasText:'直刀排料计算成功'})).toContainText('产出 1 件，预计利用率 93.2%');
            await page.locator('#btn-confirm-station-cut').click();
            await expect(page.locator('#report-actual-len')).toHaveValue('4870');
            await page.locator('#report-actual-len').fill('4970.1');
            await expect(page.locator('#report-area-preview')).toContainText('91.3%');
            assert.equal(await page.locator('#report-actual-len').evaluate(el=>el.validity.valid),true);
            await page.locator('#report-confirm-button').click();await expect(page.locator('#report-error')).toContainText('测试仅检查报工绑定');
            assert.equal(reportBodies[0].actualCutLen,4970.1);
            await page.screenshot({path:'target/plan-adjustment/accounting-1366.png'});
        });
        await run('mixed qualified and rejected results require a reason, persist to history and reverse together',async page=>{
            await loadPlan(page);acceptReport=true;await page.locator('#btn-confirm-station-cut').click();
            await page.locator('#report-piece-2').selectOption('REJECTED');await page.locator('#report-confirm-button').click();
            await expect(page.locator('#report-error')).toContainText('异常原因');assert.equal(reportBodies.length,0);
            await page.getByRole('textbox',{name:'裁片 2 原因',exact:true}).fill('右边破损');
            await expect(page.locator('#report-piece-count')).toHaveValue('1');
            await page.locator('#report-confirm-button').click();await expect(page.locator('#cut-report-modal')).not.toBeVisible();
            assert.equal(receipts[0].rejectedPieceCount,1);assert.equal(receipts[0].finishedPieceCount,1);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces.find(p=>p.sourcePieceId===2).outcome),'REJECTED');
            await page.getByRole('button',{name:/报工记录/}).click();await expect(page.locator('#task-picker-body')).toContainText('异常 1 件');
            await page.getByText('逐件结果与异常原因',{exact:true}).click();await expect(page.locator('#task-picker-body')).toContainText('右边破损');
            await page.getByRole('button',{name:'撤回报工',exact:true}).click();
            await page.locator('.action-dialog textarea').fill('测试误报');await page.getByRole('button',{name:'确认撤回',exact:true}).click();
            await expect(page.locator('#task-picker-body')).toContainText('已撤回');assert.equal(stock.currentRemainingLength,60000);
            assert.equal(await page.evaluate(()=>window.camApp.state.taskCompleted[7]),1);
        });
        await run('uncut partial rectangle is recovered explicitly and next station starts at actual cut end',async page=>{
            await loadPlan(page);acceptReport=true;await page.locator('#btn-confirm-station-cut').click();
            await page.locator('#report-actual-len').fill('1800.5');await page.locator('#report-mark-tail').click();
            await expect(page.locator('#report-piece-2')).toHaveValue('UNCUT');
            const recover=page.getByRole('checkbox',{name:'回收 UNCUT-2',exact:true});await expect(recover).not.toBeChecked();await recover.check();
            await expect(page.getByRole('spinbutton',{name:'UNCUT-2 实测长度',exact:true})).toHaveValue('300.5');
            await page.screenshot({path:'target/plan-adjustment/partial-report-1366.png'});
            await page.locator('#report-confirm-button').click();await expect(page.locator('#cut-report-modal')).not.toBeVisible();
            assert.equal(reportBodies[0].pieceResults[1].outcome,'UNCUT');assert.equal(reportBodies[0].actualRemnants[0].l,300.5);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().pieces.length),1);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().windowStartY),1800.5);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().remnants[0].id),'TEST-REC-0');
        });
        await run('closing and reopening preserves partial outcome and measured recovery fields',async page=>{
            await loadPlan(page);await page.locator('#btn-confirm-station-cut').click();
            await page.locator('#report-actual-len').fill('1800.5');await page.locator('#report-piece-2').selectOption('UNCUT');
            await page.getByRole('checkbox',{name:'回收 UNCUT-2',exact:true}).check();
            await page.getByRole('spinbutton',{name:'UNCUT-2 实测宽度',exact:true}).fill('1999.5');
            await page.getByRole('button',{name:'暂不报工',exact:true}).click();await page.locator('#btn-confirm-station-cut').click();
            await expect(page.locator('#report-actual-len')).toHaveValue('1800.5');await expect(page.locator('#report-piece-2')).toHaveValue('UNCUT');
            await expect(page.getByRole('checkbox',{name:'回收 UNCUT-2',exact:true})).toBeChecked();
            await expect(page.getByRole('spinbutton',{name:'UNCUT-2 实测宽度',exact:true})).toHaveValue('1999.5');
            await page.locator('#report-confirm-button').click();await expect(page.locator('#report-error')).toContainText('测试仅检查报工绑定');
            await expect(page.locator('#report-piece-2')).toHaveValue('UNCUT');assert.equal(stock.currentRemainingLength,60000);
        });
        await run('all uncut can record separated raw stock without fabricating qualified demand',async page=>{
            await loadPlan(page);acceptReport=true;await page.locator('#btn-confirm-station-cut').click();
            await page.locator('#report-all-uncut').click();await page.locator('#report-actual-len').fill('1000');
            await expect(page.locator('#report-piece-count')).toHaveValue('0');
            await page.getByRole('checkbox',{name:'回收 UNCUT-1',exact:true}).check();
            await page.locator('#report-confirm-button').click();await expect(page.locator('#cut-report-modal')).not.toBeVisible();
            assert.equal(receipts[0].finishedPieceCount,0);assert.equal(receipts[0].derivedRemnants.length,1);
            await expect(page.locator('#demands-container .demand-status')).toHaveText('本方案 0 · 已报工 1 · 剩余 2');
            await expect(page.locator('#material-context-info')).toContainText('59,000 mm');
            assert.equal(await page.evaluate(()=>window.camApp.state.taskCompleted[7]),1);
        });
        await run('empty requirements guide to the missing field, then to adding a demand',async page=>{
            await expect(page.locator('[data-workflow-stage="0"]')).toHaveAttribute('aria-current','step');
            await page.locator('#task-name').fill('');
            await page.locator('#btn-workflow-next').click();await expect(page.locator('#task-name')).toBeFocused();
            await page.locator('#task-name').fill('新切割任务');
            await page.locator('#task-material').selectOption(roll.rollModel);
            await expect(page.locator('#btn-workflow-next')).toHaveText('添加裁片需求');
            await page.locator('#btn-workflow-next').click();await expect(page.locator('#demands-container .item-row')).toHaveCount(1);
            assert.equal(requests.filter(r=>r.startsWith('POST')).length,0);
        });
        await run('stage navigation reveals panels without saving, solving, reporting or moving the window',async page=>{
            await loadPlan(page);const writes=requests.filter(r=>r.startsWith('POST')).length;
            await page.evaluate(()=>{window.camApp.toggleSidebar('left');document.getElementById('card-demands').classList.add('collapsed');});
            await page.locator('[data-workflow-stage="0"]').click();
            await expect(page.locator('#sidebar-left')).not.toHaveClass(/collapsed/);await expect(page.locator('#card-demands')).not.toHaveClass(/collapsed/);
            for(const i of [1,2,3])await page.locator('[data-workflow-stage="'+i+'"]').click();
            await expect(page.locator('#cut-report-modal')).not.toBeVisible();assert.equal(requests.filter(r=>r.startsWith('POST')).length,writes);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().windowStartY),0);
            await expect(page.locator('#right-roll-actions .workflow-primary:visible')).toHaveCount(1);
            await expect(page.locator('#btn-confirm-station-cut')).toHaveClass(/workflow-primary/);
            await expect(page.locator('[data-workflow-stage="3"]')).toHaveAttribute('aria-current','step');
            fs.mkdirSync('target/workflow-guide',{recursive:true});
            for(const width of [1366,1920]){await page.setViewportSize({width,height:width===1366?768:1080});
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
                await expect(page.locator('#btn-confirm-station-cut')).toBeInViewport();
                await page.screenshot({path:'target/workflow-guide/ready-'+width+'.png'});}
        });
        await run('incomplete input immediately changes readiness and blocks direct solve without saving',async page=>{
            await loadPlan(page);await page.locator('[data-workflow-stage="0"]').click();
            await page.locator('.dem-count').fill('1.5');
            await expect(page.locator('#station-action-hint')).toContainText('正整数');
            await expect(page.locator('#btn-trigger-solve-station')).toBeDisabled();await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            const writes=requests.filter(r=>r.startsWith('POST')).length;
            await page.evaluate(()=>window.camApp.triggerSolve());assert.equal(requests.filter(r=>r.startsWith('POST')).length,writes);
            await page.locator('#btn-workflow-next').click();await expect(page.locator('.dem-count')).toBeFocused();
            await page.locator('.dem-count').fill('3');await page.locator('.dem-count').press('Tab');
            await expect(page.locator('#btn-trigger-solve-station')).toBeEnabled();
            await expect(page.locator('#right-roll-actions .workflow-primary:visible')).toHaveCount(1);
        });
        await run('manual changes move the primary action to validation and back to reporting',async page=>{
            await loadPlan(page);await page.keyboard.press('ArrowDown');
            await expect(page.locator('#btn-validate-adjustment')).toHaveClass(/workflow-primary/);
            await expect(page.locator('[data-workflow-stage="2"]')).toHaveAttribute('aria-current','step');
            await expect(page.locator('#right-roll-actions .workflow-primary:visible')).toHaveCount(1);
            await page.locator('#btn-undo-plan').click();await expect(page.locator('#btn-confirm-station-cut')).toHaveClass(/workflow-primary/);
        });
        await run('busy solve disables duplicate actions and completion offers report history',async page=>{
            await loadPlan(page);let release;solveWait=new Promise(resolve=>release=resolve);
            await page.locator('#btn-trigger-solve-station').click();
            try {await expect(page.locator('#workflow-current')).toHaveText('正在生成方案…');await expect(page.locator('#btn-trigger-solve-station')).toBeDisabled();
                await expect.poll(()=>requests.filter(r=>r==='POST /api/solve').length).toBe(1);
                await page.evaluate(()=>window.camApp.triggerSolve());assert.equal(requests.filter(r=>r==='POST /api/solve').length,1);
            }finally{release();}
            await expect(page.locator('#btn-confirm-station-cut')).toBeEnabled();acceptReport=true;
            await page.locator('#btn-confirm-station-cut').click();await page.locator('#report-confirm-button').click();
            await expect(page.locator('#cut-report-modal')).not.toBeVisible();await expect(page.locator('#workflow-current')).toHaveText('本次需求已完成');
            await expect(page.locator('#btn-trigger-solve-station')).toBeHidden();await expect(page.locator('#btn-workflow-next')).toHaveText('查看报工记录');
            const writes=requests.filter(r=>r.startsWith('POST')).length;await page.locator('#btn-workflow-next').click();
            await expect(page.locator('#task-picker-title')).toContainText('报工记录');assert.equal(requests.filter(r=>r.startsWith('POST')).length,writes);
        });
        await run('dense demand lists keep material, results and main action visible at both desktop sizes',async page=>{
            const task=tasks.get('task-a');task.demands=Array.from({length:30},(_,i)=>({id:7+i,name:'批量裁片 '+(i+1),width:2000,length:1200,quantity:3,allowRotation:false}));
            await loadPlan(page);await expect(page.locator('#demands-container .item-row')).toHaveCount(30);
            fs.mkdirSync('target/workbench-layout',{recursive:true});
            for(const width of [1366,1920]){
                await page.setViewportSize({width,height:width===1366?768:1080});
                const before=await page.locator('.material-context').boundingBox();
                await page.locator('#sidebar-left .sidebar-scroll-body').evaluate(e=>e.scrollTop=e.scrollHeight);
                await expect(page.locator('#material-context-id')).toBeInViewport();
                const after=await page.locator('.material-context').boundingBox();assert.equal(before.y,after.y);
                await expect(page.locator('#lbl-utilization')).toBeInViewport();await expect(page.locator('#btn-confirm-station-cut')).toBeInViewport();
                const canvas=await page.locator('.cad-surface').boundingBox();assert.ok(canvas.height>=440);assert.ok(canvas.width>=730);
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
                await page.screenshot({path:'target/workbench-layout/long-list-'+width+'.png'});
            }
            await page.locator('#btn-material-details').click();await expect(page.locator('#card-mother-roll')).not.toHaveClass(/collapsed/);
            await expect(page.locator('#lbl-current-roll-id')).toBeInViewport();
            assert.equal(requests.filter(r=>r.startsWith('POST')).length,0);
        });
        await run('consumed remnant remains visible as history and requires selecting new stock',async page=>{
            await loadPlan(page);
            await page.evaluate(async()=>{
                const stock={id:'REM-LAYOUT',sourceRollId:'ROLL-2026-0920',materialBatch:'TC涤棉-B2026',width:2000,length:3000,defects:[],hasDefect:false,location:'A-01'};
                await window.camApp.switchCutMode('remnant',stock);
                const data=window.camApp.state.getCurrentCaseData();
                data.lastReceipt={feedPortType:'remnant',sourceRemnantId:stock.id,status:'CONFIRMED',finishedPieceCount:1,actualCutLen:0,windowStartY:0};
                const {updateWorkflowControls}=await import('/js/plugins/solver/solver-client.js');updateWorkflowControls();
            });
            await expect(page.locator('#material-context-id')).toHaveText('REM-LAYOUT');
            await expect(page.locator('#material-context-info')).toContainText('已报工核销');
            await expect(page.locator('#btn-trigger-solve-station')).toBeDisabled();await expect(page.locator('#btn-workflow-next')).toHaveText('匹配料头与母卷');
        });
        await run('compact radar still supports mouse, wheel and keyboard and protects pending work',async page=>{
            await page.getByRole('button',{name:'打开任务',exact:true}).click();await page.locator('[data-task="task-a"]').click();
            await expect(page.locator('#task-state')).toContainText('已保存');
            await expect(page.locator('#task-picker')).not.toBeVisible();
            await expect(page.locator('body')).not.toHaveAttribute('inert','');
            await page.evaluate(async()=>{window.camApp.state.getCurrentCaseData().windowStartY=70000;const {updateUIInfo}=await import('/js/plugins/solver/solver-client.js');updateUIInfo();});
            await expect(page.locator('#btn-workflow-next')).toHaveText('定位母卷导航');await page.locator('#btn-workflow-next').click();
            await expect(page.locator('#radar-window')).toBeFocused();await expect(page.locator('#radar-window')).toHaveAttribute('tabindex','0');await page.keyboard.press('Home');
            const track=await page.locator('#radar-track').boundingBox();
            const start=()=>page.evaluate(()=>window.camApp.state.getCurrentCaseData().windowStartY);
            await page.mouse.click(track.x+track.width*.5,track.y+18);assert.ok(await start()>20000);
            await page.locator('#radar-window').focus();await page.keyboard.press('Home');assert.equal(await start(),0);
            await page.keyboard.press('ArrowRight');assert.ok(await start()>0);
            const handle=await page.locator('#radar-window').boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+12);await page.mouse.down();await page.mouse.move(track.x+track.width*.65,handle.y+12,{steps:8});await page.mouse.up();assert.ok(await start()>30000);
            const previous=await start();await page.mouse.move(track.x+track.width*.8,track.y+16);await page.mouse.wheel(0,-100);
            await expect.poll(start).toBeLessThan(previous);
            await loadPlan(page);await page.locator('#radar-window').focus();await page.keyboard.press('ArrowRight');
            await expect(page.locator('#cut-report-modal')).toBeVisible();assert.equal(await start(),0);
            assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.planId),'original-plan');
            assert.equal(reportBodies.length,0);
        });
        await run('demand progress separates preview and completion, links both ways and preserves cutting position',async page=>{
            tasks.get('task-a').demands[0].quantity=4;await loadPlan(page);
            const row=page.locator('#demands-container [data-id="7"]');await expect(row.locator('.demand-status')).toHaveText('本方案 2 · 已报工 1 · 剩余 3');
            await row.locator('.demand-unplaced summary').click();await expect(row.locator('.demand-unplaced p')).toContainText('不能据此判定无法裁切');
            const geometry=await page.evaluate(()=>JSON.stringify(window.camApp.state.getCurrentCaseData().pieces));
            await row.locator('.demand-locate').click();assert.equal(await page.evaluate(()=>window.camApp.getSelectedPieceId()),1);
            await row.locator('.demand-locate').click();assert.equal(await page.evaluate(()=>window.camApp.getSelectedPieceId()),2);
            assert.equal(await page.evaluate(()=>JSON.stringify(window.camApp.state.getCurrentCaseData().pieces)),geometry);
            assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().windowStartY),0);
            await page.getByRole('button',{name:'当前工位',exact:true}).click();
            await page.evaluate(()=>{document.getElementById('card-demands').classList.add('collapsed');});
            const point=await page.evaluate(async()=>{const {stage}=await import('/js/plugins/cad/cad-stage.js');const b=stage.findOne('.piece-entity-1').getClientRect(),r=document.getElementById('konva-container').getBoundingClientRect();return {x:r.x+b.x+b.width/2,y:r.y+b.y+b.height/2};});
            await page.mouse.click(point.x,point.y);
            await expect(row).toHaveClass(/demand-selected/);await expect(page.locator('#card-demands')).not.toHaveClass(/collapsed/);
            await expect(row.locator('.dem-name')).not.toBeFocused();assert.equal(await page.evaluate(()=>window.camApp.getSelectedPieceId()),1);
            await page.keyboard.press('ArrowDown');await expect(page.locator('#demand-progress-summary')).toContainText('手调待校验');
            await page.evaluate(()=>{const data=window.camApp.state.getCurrentCaseData();data.pieces=data.pieces.filter(p=>p.id!==2);window.camApp.bus.emit('plan:edited');});
            await expect(row.locator('.demand-status')).toHaveText('本方案 1 · 已报工 1 · 剩余 3');
            await expect(row.locator('.demand-unplaced p')).toContainText('移除了 1 件');
            await page.locator('#btn-undo-plan').click();await expect(row.locator('.demand-status')).toContainText('本方案 2');
            fs.mkdirSync('target/demand-progress',{recursive:true});await page.screenshot({path:'target/demand-progress/linked-1366.png'});
        });
        await run('equal names and dimensions retain distinct demand identities when locating the drawing',async page=>{
            tasks.get('task-a').demands.push({...tasks.get('task-a').demands[0],id:8,quantity:2});await loadPlan(page);
            await page.evaluate(async saved=>{const {restoreSavedPlan}=await import('/js/plugins/solver/solver-client.js');restoreSavedPlan(saved);},
                {request:{...planRequest,demands:[...planRequest.demands,{...planRequest.demands[0],id:8}]},result:{...planResult,pieces:[planResult.pieces[0],{...planResult.pieces[1],demandId:8}]}});
            const first=page.locator('#demands-container [data-id="7"]'),second=page.locator('#demands-container [data-id="8"]');
            await expect(first.locator('.demand-status')).toHaveText('本方案 1 · 已报工 1 · 剩余 2');
            await expect(second.locator('.demand-status')).toHaveText('本方案 1 · 已报工 0 · 剩余 2');
            await second.locator('.demand-locate').click();assert.equal(await page.evaluate(()=>window.camApp.getSelectedPieceId()),2);
            await expect(second).toHaveClass(/demand-selected/);await expect(first).not.toHaveClass(/demand-selected/);
            await first.locator('.demand-locate').click();assert.equal(await page.evaluate(()=>window.camApp.getSelectedPieceId()),1);
        });
        await run('an empty solution retains per-demand diagnostics until inputs change',async page=>{
            await page.getByRole('button',{name:'打开任务',exact:true}).click();await page.locator('[data-task="task-a"]').click();await expect(page.locator('#task-picker')).not.toBeVisible();await expect(page.locator('body')).not.toHaveAttribute('inert','');
            await page.locator('.dem-l').fill('6000');await page.locator('.dem-l').press('Tab');
            solveResult={success:false,status:'NO_SOLUTION_FOUND',message:'本次没有排入裁片',pieces:[],fulfillment:[{demandId:7,requested:2,placed:0,unplaced:2,reason:'EXCEEDS_PROCESSING_LENGTH'}]};
            await page.locator('#btn-trigger-solve-station').click();await expect(page.locator('#demand-progress-summary')).toContainText('求解反馈');
            const row=page.locator('#demands-container [data-id="7"]');await row.locator('.demand-unplaced summary').click();
            await expect(row.locator('.demand-unplaced p')).toContainText('有效长度');await expect(row.locator('.demand-status')).toHaveText('本方案 0 · 已报工 1 · 剩余 2');
            await expect(row.locator('.demand-locate')).toBeDisabled();await expect(page.locator('#btn-confirm-station-cut')).toBeDisabled();
            await page.locator('.dem-l').fill('1200');await expect(row.locator('.demand-unplaced')).toBeHidden();await expect(page.locator('#demand-progress-summary')).not.toContainText('求解反馈');
        });
        await run('material selection explains all remaining demand and browsing preserves the current plan',async page=>{
            await loadPlan(page);candidateItems=candidateList();extraRolls=[secondRoll];
            const before=await page.evaluate(()=>JSON.stringify(window.camApp.state.getCurrentCaseData()));
            await page.getByRole('button',{name:'选择用料',exact:true}).click();await expect(page.locator('#material-match-count')).toContainText('3 / 3');
            await expect(page.locator('.material-match-scope')).toContainText('1 项 / 2 件');assert.equal(candidateBodies[0].demands[0].demand,2);assert.equal(candidateBodies[0].demands[0].id,7);
            await expect(page.locator('.material-candidate').first()).toContainText('单件尺寸可容纳');
            await page.locator('#material-source-filter').selectOption('roll');await expect(page.locator('.material-candidate')).toHaveCount(2);
            await page.locator('#material-search').fill('B-02');await expect(page.locator('.material-candidate')).toHaveCount(1);
            await page.locator('[name="job-material"]').check();await expect(page.locator('#material-load')).toBeDisabled();
            const bounds=await page.locator('#material-picker').boundingBox();assert.ok(Math.abs(bounds.x-(1366-bounds.width)/2)<2);assert.ok(bounds.y>0);
            await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>JSON.stringify(window.camApp.state.getCurrentCaseData())),before);
            fs.mkdirSync('target/material-selection',{recursive:true});await page.screenshot({path:'target/material-selection/choose-1366.png'});
            await page.setViewportSize({width:1920,height:1080});await page.locator('#material-search').fill('');await page.locator('#material-source-filter').selectOption('all');await page.screenshot({path:'target/material-selection/choose-1920.png'});
            await page.locator('#material-picker [data-close]').click();
            assert.equal(await page.evaluate(()=>JSON.stringify(window.camApp.state.getCurrentCaseData())),before);
            assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.planId),'original-plan');
            assert.equal(requests.filter(r=>r==='POST /api/cutting/tasks').length,0);assert.equal(reportBodies.length,0);
        });
        await run('failed material load preserves preview and confirmed retry switches only the source',async page=>{
            await loadPlan(page);candidateItems=candidateList();extraRolls=[secondRoll];failMaterialRead=true;
            await page.evaluate(()=>window.camApp.matchTaskMaterials({type:'roll',id:'ROLL-SECOND'}));
            await expect(page.locator('#material-load')).toBeDisabled();await page.locator('#material-replace-confirm').check();await page.locator('#material-load').click();
            await expect(page.locator('#material-match-error')).toContainText('测试材料读取失败');
            assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.planId),'original-plan');await expect(page.locator('#material-context-id')).toHaveText(roll.rollId);
            failMaterialRead=false;await page.locator('#material-load').click();await expect(page.locator('#material-picker')).not.toBeVisible();await expect(page.locator('#material-context-id')).toHaveText(secondRoll.rollId);
            await expect(page.locator('.demand-status')).toHaveText('本方案 0 · 已报工 1 · 剩余 2');assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan),null);
            assert.equal(await page.evaluate(()=>window.camApp.state.activeTask.id),'task-a');assert.equal(reportBodies.length,0);
        });
        await run('matching failures retry in place and late responses cannot reopen a closed selector',async page=>{
            await loadPlan(page);failCandidates=true;await page.getByRole('button',{name:'选择用料',exact:true}).click();await expect(page.locator('#material-match-error')).toContainText('测试库存读取失败');
            failCandidates=false;candidateItems=candidateList();await page.locator('#material-refresh').click();await expect(page.locator('.material-candidate')).toHaveCount(3);
            await page.locator('#material-picker [data-close]').click();
            let finish;candidateWait=new Promise(resolve=>finish=resolve);await page.getByRole('button',{name:'选择用料',exact:true}).click();await expect(page.locator('#material-match-count')).toContainText('正在匹配');
            await page.locator('#material-picker [data-close]').click();finish();candidateWait=undefined;await page.waitForTimeout(50);await expect(page.locator('#material-picker')).not.toBeVisible();
            assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.planId),'original-plan');
        });
        await run('legacy remnant entries use the same selector and switching preserves unsaved demand',async page=>{
            await loadPlan(page);candidateItems=candidateList();extraRolls=[secondRoll];
            await page.locator('#task-details').evaluate(el=>el.open=true);await page.locator('#task-name').fill('未保存的现场需求');await page.locator('#task-name').press('Tab');
            await page.evaluate(()=>window.camApp.selectAndMountFromShelf('REM-CHOICE'));await expect(page.locator('#material-picker')).toBeVisible();
            await page.locator('#material-replace-confirm').check();await page.locator('#material-load').click();await expect(page.locator('#material-picker')).not.toBeVisible();await expect(page.locator('#material-context-id')).toHaveText('REM-CHOICE');
            await expect(page.locator('#task-name')).toHaveValue('未保存的现场需求');assert.equal(await page.evaluate(()=>window.camApp.state.currentCutMode),'remnant');
            await page.evaluate(()=>window.camApp.mountRollToStation('ROLL-SECOND'));await expect(page.locator('#material-picker')).toBeVisible();await page.locator('#material-load').click();await expect(page.locator('#material-context-id')).toHaveText('ROLL-SECOND');
            await expect(page.locator('#task-name')).toHaveValue('未保存的现场需求');assert.equal(requests.filter(r=>r==='POST /api/cutting/tasks').length,0);
        });
        await run('expired candidates cannot replace the plan and inventory creation never mounts implicitly',async page=>{
            await loadPlan(page);candidateItems=candidateList();extraRolls=[secondRoll];await page.evaluate(()=>window.camApp.matchTaskMaterials({type:'roll',id:'ROLL-SECOND'}));
            await page.locator('#material-replace-confirm').check();candidateItems=[];await page.locator('#material-load').click();await expect(page.locator('#material-match-error')).toContainText('不再匹配');
            await page.locator('#material-open-inventory').click();await expect(page.locator('#material-manager-modal')).toBeVisible();
            await page.locator('#pane-mat-rolls details').filter({has:page.locator('#new-roll-id')}).evaluate(el=>el.open=true);
            for(const [id,value]of [['new-roll-id','NEW-INVENTORY'],['new-roll-model',roll.rollModel],['new-roll-width','2000'],['new-roll-length','8000'],['new-roll-location','C-01']])await page.locator('#'+id).fill(value);
            await page.getByRole('button',{name:'保存母卷档案',exact:true}).click();await expect(page.locator('#material-roll-detail-panel')).toContainText('NEW-INVENTORY');
            await expect(page.locator('#material-context-id')).toHaveText(roll.rollId);assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan.result.planId),'original-plan');
        });
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({discovered:26,executed:passed+failed,passed,failed,skipped:0}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
