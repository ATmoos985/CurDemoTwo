// node src/test/browser/plan-adjustment.cjs
// Set PLAYWRIGHT_MODULE and CHROME_PATH when using a bundled browser runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {createServer} = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../main/resources/static');
let tasks, failSave, requests, failAdjustment, adjustmentBodies, reportBodies, savedPlanRequest, solveResult, acceptReport, receipts, stock;
const planRequest={taskId:"task-a", taskRevision:1, rollId:"ROLL-2026-0920",rollModel:"TC涤棉-B2026",rollW:2000,rollL:5000,totalRollL:60000,windowStartY:0,feedPortType:"roll",trimStart:0,cutOrigin:"right-bottom",firstStageOrientation:"horizontal",allowRotation:false,allowLongitudinal:false,demands:[{id:7,name:"主帘",width:2000,length:1200,demand:2}],minRemnantWidth:200,minRemnantLength:300};
const planResult={success:true,planId:"original-plan",pieces:[{id:1,demandId:7,name:"主帘",x:0,y:0,w:2000,l:1200,rotated:false},{id:2,demandId:7,name:"主帘",x:0,y:1500,w:2000,l:1200,rotated:false}],remnants:[],cuts:[{step:1,type:"横切",pos:1200,start:0,end:2000,desc:"横切"},{step:2,type:"横切",pos:2700,start:0,end:2000,desc:"横切"}],deductLen:2700,engine:"crosscut"};
const roll = {rollId:'ROLL-2026-0920', rollModel:'TC涤棉-B2026', width:2000, totalLength:60000, usedLength:0, currentRemainingLength:60000, defects:[]};
const initialTask = () => ({id:'task-a', revision:1, name:'已保存需求', materialModel:roll.rollModel, externalRef:'ORDER-A',
    process:{bedLength:5000,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false},
    demands:[{id:7,name:'主帘',width:2000,length:1200,quantity:3,allowRotation:false}]});
const server = createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (value, status=200) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (url.pathname.startsWith('/api/')) {
        requests.push(req.method + ' ' + url.pathname);
        if (url.pathname === '/api/rolls') return json([stock]);
        if (url.pathname === '/api/rolls/' + roll.rollId) return json(stock);
        if (url.pathname === '/api/remnants') return json([]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'GET') return json([...tasks.values()]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            if (failSave) return json({message:'测试保存失败'}, 503);
            const body = JSON.parse(raw), id = body.id || 'task-new';
            const task = {...body, id, revision:(tasks.get(id)?.revision || 0)+1}; tasks.set(id,task); return json(task);
        }
        if(url.pathname==='/api/solve'){let raw='';for await(const chunk of req)raw+=chunk;savedPlanRequest=JSON.parse(raw);return json(solveResult);}
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
        tasks = new Map([['task-a',initialTask()]]); failSave=false; requests=[]; failAdjustment=false; adjustmentBodies=[];reportBodies=[];savedPlanRequest=planRequest;solveResult=planResult;acceptReport=false;receipts=[];stock={...roll};
        const context = await browser.newContext({viewport:{width:1366,height:768}}), page = await context.newPage(), errors=[];
        page.on('pageerror',error => errors.push(error.message));
        try {
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await expect(page.locator('body')).not.toHaveAttribute('inert','');
            await verify(page);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(r => !r.startsWith('POST') || ['/adjust','/report-confirm','/solve','/tasks','/reverse'].some(route=>r.endsWith(route))), 'only isolated fixture task, solve, adjustment and report requests');
            passed++; console.log('PASS ' + name);
        } catch(error) {failed++; console.error('FAIL ' + name + '\n' + error.stack); console.error(JSON.stringify({requests,adjustmentBodies,savedPlanRequest,errors,debug:await page.evaluate(()=>{const s=window.camApp.state;return {pending:s.pendingPlan?.result?.planId,version:s.pendingPlan?.version,geometry:s.pendingPlan?.geometry,pieces:s.getCurrentCaseData().pieces,cuts:s.getCurrentCaseData().cuts,remnants:s.getCurrentCaseData().remnants};})}));}
        finally {await context.close();}
    }
    const loadPlan = async page => {
        await page.getByRole('button',{name:'打开任务',exact:true}).click();await page.locator('[data-task="task-a"]').click();
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
            assert.equal(await page.evaluate(()=>window.camApp.state.taskCompleted[7]),1);
        });
    } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({discovered:10,executed:passed+failed,passed,failed,skipped:0}));if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
