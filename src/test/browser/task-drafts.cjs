// node src/test/browser/task-drafts.cjs
// Set PLAYWRIGHT_MODULE and CHROME_PATH when using a bundled browser runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {createServer} = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../main/resources/static');
let tasks, failSave, requests;
const roll = {rollId:'ROLL-2026-0920', rollModel:'TC涤棉-B2026', width:2000, totalLength:60000, usedLength:0, currentRemainingLength:60000, defects:[]};
const initialTask = () => ({id:'task-a', revision:1, name:'已保存需求', materialModel:roll.rollModel, externalRef:'ORDER-A',
    process:{bedLength:5000,trimStart:0,cutOrigin:'right-bottom',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:false},
    demands:[{id:7,name:'主帘',width:2000,length:1200,quantity:3,allowRotation:false}]});
const server = createServer(async (req,res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (value, status=200) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if (url.pathname.startsWith('/api/')) {
        requests.push(req.method + ' ' + url.pathname);
        if (url.pathname === '/api/rolls') return json([roll]);
        if (url.pathname === '/api/rolls/' + roll.rollId) return json(roll);
        if (url.pathname === '/api/remnants') return json([]);
        if(url.pathname==='/api/cutting/task-summaries')return json([...tasks.values()].map(task=>({task,total:task.demands.reduce((n,d)=>n+d.quantity,0),completed:1,remaining:task.demands.reduce((n,d)=>n+d.quantity,0)-1,pendingCount:0,reportCount:0})));
        if (url.pathname === '/api/cutting/tasks' && req.method === 'GET') return json([...tasks.values()]);
        if (url.pathname === '/api/cutting/tasks' && req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            if (failSave) return json({message:'测试保存失败'}, 503);
            const body = JSON.parse(raw), id = body.id || 'task-new';
            const task = {...body, id, revision:(tasks.get(id)?.revision || 0)+1}; tasks.set(id,task); return json(task);
        }
        const task = tasks.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        if (task) return json({task,completed:{7:1},reports:[]});
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
        tasks = new Map([['task-a',initialTask()]]); failSave=false; requests=[];
        const context = await browser.newContext({viewport:{width:1366,height:768}}), page = await context.newPage(), errors=[];
        page.on('pageerror',error => errors.push(error.message));
        try {
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await expect(page.locator('body')).not.toHaveAttribute('inert','');
            await verify(page);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(r => !r.startsWith('POST') || r === 'POST /api/cutting/tasks'), 'no inventory or report writes');
            passed++; console.log('PASS ' + name);
        } catch(error) {failed++; console.error('FAIL ' + name + '\n' + error.stack);}
        finally {await context.close();}
    }
    const edit = async page => {
        await page.getByRole('button',{name:'+ 增裁片',exact:true}).click();
        await page.locator('.dem-name').fill('草稿主帘'); await page.locator('.dem-w').fill('1234.5');
        await expect(page.locator('#task-state')).toContainText('本机草稿');
    };
    const openTask = async page => {
        await page.getByRole('button',{name:'打开任务',exact:true}).click();
        await page.locator('[data-task="task-a"]').click();
    };
    try {
        await run('typing without blur survives reload, including an incomplete numeric field', async page => {
            await edit(page); await page.locator('.dem-l').fill('');
            await page.reload(); await expect(page.locator('.dem-w')).toHaveValue('1234.5');
            await expect(page.locator('.dem-l')).toHaveValue('');
            await expect(page.locator('#task-state')).toContainText('未保存到服务器');
        });
        await run('new task can cancel, retain and restore a separate draft', async page => {
            await edit(page); await page.getByRole('button',{name:'新建任务',exact:true}).click();
            fs.mkdirSync('target/task-drafts', {recursive:true});
            await page.screenshot({path:'target/task-drafts/switch-1366.png'});
            const dialogBox = await page.locator('.draft-switch-dialog').boundingBox();
            assert.ok(Math.abs(dialogBox.x + dialogBox.width/2 - 683) < 2);
            await page.getByRole('button',{name:'继续编辑',exact:true}).click();
            await expect(page.locator('.dem-w')).toHaveValue('1234.5');
            await page.getByRole('button',{name:'新建任务',exact:true}).click();
            await page.getByRole('button',{name:'保留草稿并继续',exact:true}).click();
            await expect(page.locator('#demands-container .item-row')).toHaveCount(0);
            await page.locator('#btn-local-drafts').click(); await page.locator('[data-draft]').click();
            await expect(page.locator('.dem-name')).toHaveValue('草稿主帘');
        });
        await run('save and continue persists once and removes the corresponding local draft', async page => {
            await edit(page); await page.getByRole('button',{name:'新建任务',exact:true}).click();
            await page.getByRole('button',{name:'保存并继续',exact:true}).click();
            await expect(page.locator('#demands-container .item-row')).toHaveCount(0);
            await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 0');
            assert.equal(tasks.get('task-new').demands[0].width,1234.5);
            assert.equal(requests.filter(r=>r.startsWith('POST')).length,1);
        });
        await run('failed server save keeps the current workspace and recoverable draft', async page => {
            await edit(page); failSave=true;
            await page.getByRole('button',{name:'新建任务',exact:true}).click();
            await page.getByRole('button',{name:'保存并继续',exact:true}).click();
            await expect(page.locator('#task-state')).toContainText('服务器保存失败');
            await expect(page.locator('.dem-w')).toHaveValue('1234.5');
            await page.reload(); await expect(page.locator('.dem-w')).toHaveValue('1234.5');
        });
        await run('opening a saved task can discard only the active draft', async page => {
            await edit(page); await openTask(page);
            await page.getByRole('button',{name:'放弃修改',exact:true}).click();
            await expect(page.locator('.dem-name')).toHaveValue('主帘');
            await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 0');
            assert.equal(tasks.get('task-a').revision,1);
        });
        await run('preset replacement protects the old draft and retains the new example separately', async page => {
            await edit(page); await page.locator('#btn-preset-trigger').click(); await page.locator('#btn-case-1').click();
            await page.getByRole('button',{name:'继续编辑',exact:true}).click();
            await expect(page.locator('.dem-name')).toHaveValue('草稿主帘');
            await page.locator('#btn-preset-trigger').click(); await page.locator('#btn-case-1').click(); await page.getByRole('button',{name:'保留草稿并继续',exact:true}).click();
            await expect(page.locator('#task-name')).toHaveValue('整幅横切');
            await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 2');
        });
        await run('deleting a demand can be undone without losing its ID or values', async page => {
            await openTask(page); await expect(page.locator('.dem-name')).toHaveValue('主帘');
            await page.locator('.dem-w').fill('1987.6'); await page.locator('#demands-container .del-btn').click();
            await expect(page.locator('#demands-container .item-row')).toHaveCount(0);
            await page.getByRole('button',{name:'撤销删除',exact:true}).click();
            await expect(page.locator('.item-row[data-id="7"] .dem-w')).toHaveValue('1987.6');
            await page.reload(); await expect(page.locator('.item-row[data-id="7"] .dem-w')).toHaveValue('1987.6');
        });
        await run('changed server revision restores a separate copy and fresh stock instead of overwriting', async page => {
            await openTask(page); await expect(page.locator('.dem-name')).toHaveValue('主帘');
            await page.locator('.dem-w').fill('1987'); tasks.set('task-a',{...initialTask(),revision:2});
            await page.reload(); await expect(page.locator('#task-name')).toHaveValue('已保存需求（草稿副本）');
            await expect(page.locator('.dem-w')).toHaveValue('1987');
            assert.equal(await page.evaluate(()=>window.camApp.state.activeTask),null);
            assert.equal(tasks.get('task-a').revision,2);
        });
        await run('local storage failure cannot silently retain and abandon unsaved input', async page => {
            await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('cutting-demand-draft'))throw new DOMException('full','QuotaExceededError');return original.call(this,key,value);};});
            await page.getByRole('button',{name:'+ 增裁片',exact:true}).click(); await page.locator('.dem-w').fill('1888');
            await expect(page.locator('#task-state')).toContainText('草稿保存失败');
            await page.getByRole('button',{name:'新建任务',exact:true}).click();
            await page.getByRole('button',{name:'保留草稿并继续',exact:true}).click();
            await expect(page.locator('.dem-w')).toHaveValue('1888');
            await expect(page.locator('.workbench-toast').last()).toContainText('本机草稿保存失败');
        });
        await run('saved-task draft recovery keeps current completion counts and live stock', async page => {
            await openTask(page); await expect(page.locator('.dem-name')).toHaveValue('主帘');
            await page.locator('.dem-w').fill('1990');
            roll.usedLength=5000; roll.currentRemainingLength=55000;
            try {
                await page.reload(); await expect(page.locator('.dem-w')).toHaveValue('1990');
                assert.equal(await page.evaluate(()=>window.camApp.state.taskCompleted[7]),1);
                assert.equal(await page.evaluate(()=>window.camApp.state.getCurrentCaseData().stockRemainingLength),55000);
                assert.equal(await page.evaluate(()=>window.camApp.state.pendingPlan),null);
            } finally {roll.usedLength=0;roll.currentRemainingLength=60000;}
        });
        await run('new row after deletion does not reuse an existing demand ID', async page => {
            await edit(page); await page.getByRole('button',{name:'+ 增裁片',exact:true}).click();
            await page.locator('#demands-container .del-btn').first().click();
            await page.getByRole('button',{name:'+ 增裁片',exact:true}).click();
            const ids = await page.locator('#demands-container .item-row').evaluateAll(rows=>rows.map(r=>r.dataset.id));
            assert.equal(new Set(ids).size,ids.length);
            await page.getByRole('button',{name:'撤销删除',exact:true}).click();
            await expect(page.locator('#demands-container .item-row')).toHaveCount(3);
        });
        await run('order template replacement respects cancellation and never auto-saves or solves', async page => {
            await edit(page);
            await page.evaluate(()=>{window.templateOperation=window.camApp.loadCurtainOrderTemplate('real_893292_cream');});
            await page.getByRole('button',{name:'继续编辑',exact:true}).click();
            await page.evaluate(()=>window.templateOperation);
            await expect(page.locator('.dem-name')).toHaveValue('草稿主帘');
            await page.evaluate(()=>{window.templateOperation=window.camApp.loadCurtainOrderTemplate('real_893292_cream');});
            await page.getByRole('button',{name:'保留草稿并继续',exact:true}).click();
            await page.evaluate(()=>window.templateOperation);
            await expect(page.locator('#demands-container .item-row')).toHaveCount(14);
            await expect(page.locator('#btn-local-drafts')).toHaveText('本机草稿 2');
            assert.equal(requests.filter(r=>r.startsWith('POST')).length,0);
        });
    } finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
    console.log(JSON.stringify({discovered:12,executed:passed+failed,passed,failed,skipped:0}));
    if(failed)process.exitCode=1;
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
