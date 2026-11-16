// Writes only to an explicit isolated service; synthetic responses cover failure/race cases.
const assert = require('node:assert/strict');
const {readFileSync, existsSync} = require('node:fs');
const {randomUUID, createHash} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'isolated inventory required');
const api = async path => { const r = await fetch(base + path); assert.ok(r.ok); return r.json(); };
const hash = () => process.env.STATE_PATH && existsSync(process.env.STATE_PATH) ? createHash('sha256').update(readFileSync(process.env.STATE_PATH)).digest('hex') : null;
const waitText = (page, selector, text) => page.waitForFunction(({selector, text}) => document.querySelector(selector)?.textContent.includes(text), {selector, text});
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const results = [], rollId = 'ROUTE-' + randomUUID();
    async function check(name, fn, writable = false) {
        const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [];
        page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
        const before = hash();
        try { await fn(page, writes); assert.deepEqual(errors, []); if (!writable) { assert.deepEqual(writes, []); assert.equal(hash(), before); }
            results.push({name, success: true}); console.log('PASS', name);
        } catch (e) { results.push({name, success: false, error: e.message}); console.error('FAIL', name, e.stack); }
        finally { await page.close(); }
    }
    const go = async (page, route) => { await page.goto(base + '/app/#/' + route); await page.locator('.page-host .ph').waitFor(); };
    try {
        await check('inspection receipt stays in the new app and returns to the registered roll', async (page, writes) => {
            await go(page, 'inspection'); await page.getByRole('link', {name: '新建母卷', exact: true}).click();
            await page.locator('[data-form="rollId"]').fill(rollId); assert.equal(new URL(page.url()).pathname, '/app/');
            assert.equal(writes.length, 0);
            for (const [key, value] of Object.entries({rollModel: 'ROUTING-TEST', width: '1500', length: '12.5'})) await page.locator(`[data-form="${key}"]`).fill(value);
            await page.locator('#act-submit').click(); await page.waitForURL('**/#/inspection/' + rollId); await page.locator('#isvg canvas').first().waitFor();
            const roll = await api('/api/rolls/' + rollId); assert.equal(roll.totalLength, 12500); assert.equal(roll.width, 1500);
            assert.equal(roll.inspectionStatus, 'PENDING'); assert.deepEqual(writes, [base + '/api/inspection/rolls']);
            assert.equal((await api('/api/rolls')).filter(r => r.rollId === rollId).length, 1);
        }, true);
        await check('settings persist validated solver preferences used by the next solve request only', async page => {
            await go(page, 'settings'); await page.locator('#s-width').fill('250'); await page.locator('#s-length').fill('450'); await page.locator('#s-time').fill('0');
            await page.locator('#solver-form button').click(); assert.equal(await page.evaluate(() => localStorage.getItem('cam_timeout')), null);
            await page.locator('#s-time').fill('7'); await page.locator('#solver-form button').click(); await page.reload(); await page.locator('#s-time').waitFor();
            assert.equal(await page.locator('#s-time').inputValue(), '7');
            const values = await page.evaluate(async () => {
                const {solverSettings} = await import('/app/js/util.js'), {buildSolveRequest} = await import('/app/js/model/solve-request.js');
                const r = buildSolveRequest({task: {id:'test', revision:1, demands:[]}, roll:{rollId:'test',width:1500,totalLength:10000}, win:{start:0,len:2000}, settings:solverSettings()});
                return [r.minRemnantWidth,r.minRemnantLength,r.timeLimitSeconds];
            }); assert.deepEqual(values, [250,450,7]);
            await page.getByText('查看现有行业模板', {exact:true}).click();
            assert.ok(await page.getByText('窗帘 · 家纺', {exact:true}).isVisible());
            await page.getByText('运行能力与接口接入', {exact:true}).click();
            assert.ok(await page.getByRole('heading', {name:'AI 接入',exact:true}).isVisible());
            await page.getByRole('link', {name: '选择任务修改工艺'}).click(); await page.waitForURL('**/#/tasks');
        });
        await check('capability errors can retry and late responses cannot replace the next page', async page => {
            await page.route('**/api/v2/capabilities', r => r.fulfill({status:503, json:{message:'验收读取失败'}}), {times:1});
            await go(page, 'settings'); await page.getByText('运行能力与接口接入', {exact:true}).click();
            await waitText(page, '#capabilities-error', '读取失败'); await page.locator('#refresh-capabilities').click(); await waitText(page, '#engine-rows', '可用');
            let release, entered; const held = new Promise(r => {release=r;}), started = new Promise(r => {entered=r;});
            await page.route('**/api/v2/capabilities', async r => {entered(); await held; await r.fulfill({json:{schemaVersion:'late', engines:[], limits:{}}});}, {times:1});
            await page.locator('#refresh-capabilities').click(); await started;
            await page.locator('#nav a[href="#/tasks"]').click(); await page.waitForURL('**/#/tasks'); release();
            await page.waitForTimeout(100); assert.equal(await page.locator('#engine-rows').count(), 0); assert.equal(await page.locator('h1').innerText(), '任务');
        });
        await check('new analysis reads real ledger evidence and exports the loaded filtered rows', async page => {
            await go(page, 'analysis'); await waitText(page, '#analysis-status', '库存版本');
            await page.locator('#ledger-type').selectOption('ROLL'); await page.locator('#ledger-id').fill(rollId);
            await page.getByRole('button', {name:'查询流水',exact:true}).click(); await waitText(page, '#ledger-rows', rollId);
            const rows = await api('/api/v2/inventory-ledger?aggregateType=ROLL&aggregateId=' + rollId);
            assert.equal(await page.locator('#ledger-rows tr').count(), rows.items.length);
            await page.locator('#ledger-rows summary').first().click(); assert.ok((await page.locator('#ledger-rows pre').first().innerText()).includes(rollId));
            const download = page.waitForEvent('download'); await page.locator('#export-ledger').click();
            const csv = readFileSync(await (await download).path(), 'utf8'); assert.ok(csv.includes(rollId));
            for (const [width,height] of [[1366,768],[1920,1080],[640,800]]) {
                await page.setViewportSize({width,height}); assert.ok(await page.locator('#export-ledger').isVisible());
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            }
        });
        await check('analysis pagination, retry, CSV escaping and mismatch presentation remain safe', async page => {
            const entries = [1,2].map(sequence => ({sequence,id:String(sequence),occurredAt:1792571006000,eventType:'CUT_REPORT',aggregateType:'ROLL',aggregateId:'=formula',businessId:'report',sourceReportIds:[],afterJson:'{"name":"<img src=x onerror=alert(1)>"}'}));
            let fail = false;
            await page.route('**/api/v2/inventory-ledger?*', r => {
                const next = Number(new URL(r.request().url()).searchParams.get('after'));
                return r.fulfill(fail ? {status:503,json:{message:'分页失败'}} : {json:{items:[entries[next]],nextCursor:next+1,hasMore:next===0,revision:4}});
            });
            await page.route('**/api/v2/inventory-ledger/reconciliation', r => r.fulfill({json:{status:'MISMATCH',revision:4,issues:[{code:'TEST',reportId:'evidence'}],areas:[]}}));
            await go(page, 'analysis'); await waitText(page, '#analysis-issues', 'evidence'); await waitText(page, '#ledger-status', '已载入 1');
            assert.ok(!(await page.locator('#actual-metrics').innerText()).includes('%'));
            fail=true; await page.locator('#load-ledger').click(); await waitText(page, '#ledger-error', '分页失败');
            fail=false; await page.locator('#load-ledger').click(); await waitText(page, '#ledger-status', '已载入 2');
            assert.equal(await page.locator('#ledger-rows img').count(),0);
            const download=page.waitForEvent('download'); await page.locator('#export-ledger').click();
            assert.ok(readFileSync(await (await download).path(),'utf8').includes("'=formula"));
        });
        await check('filter changes and route disposal ignore stale ledger responses', async page => {
            await go(page,'analysis'); await waitText(page,'#ledger-status','已载入');
            let release, entered; const held=new Promise(r=>{release=r;}), started=new Promise(r=>{entered=r;});
            await page.route('**/api/v2/inventory-ledger?*',async r=>{
                if(new URL(r.request().url()).searchParams.get('aggregateId')!=='slow') return r.continue();
                entered(); await held; await r.fulfill({json:{items:[],nextCursor:0,hasMore:false,revision:999999}});
            });
            await page.locator('#ledger-id').fill('slow'); await page.getByRole('button',{name:'查询流水',exact:true}).click(); await started;
            await page.locator('#ledger-id').fill(rollId); await page.getByRole('button',{name:'查询流水',exact:true}).click(); await waitText(page,'#ledger-rows',rollId);
            release(); await page.waitForTimeout(100); assert.ok(!(await page.locator('#ledger-status').innerText()).includes('999999'));
            let finish, received; const pending=new Promise(r=>{finish=r;}), requested=new Promise(r=>{received=r;});
            await page.route('**/api/v2/inventory-ledger?*',async r=>{received();await pending;await r.fulfill({json:{items:[],nextCursor:0,hasMore:false,revision:999999}});},{times:1});
            await page.getByRole('button',{name:'查询流水',exact:true}).click();await requested;
            await page.locator('#nav a[href="#/settings"]').click(); await page.waitForURL('**/#/settings');finish();
            await page.waitForTimeout(100);assert.equal(await page.locator('#ledger-rows').count(),0);assert.equal(await page.locator('h1').innerText(),'设置');
        });
        await check('daily production pages contain no classic-page exits and demo entries are explicit', async page => {
            for (const route of ['tasks','inventory','inspection','analysis','settings']) {
                await go(page,route);
                assert.deepEqual(await page.locator('.page-host a[href$=".html"]').evaluateAll(a=>a.map(x=>x.getAttribute('href'))), []);
            }
            await go(page,'showcase'); assert.equal(await page.locator('a[href="/linear.html"]').count(),0);
            assert.ok((await page.locator('.page-host').innerText()).includes('计算演示不扣库存')); assert.equal(await page.locator('.topbar a[href="/workspace.html"]').count(),1);
        });
    } finally { await browser.close(); }
    const failed=results.filter(r=>!r.success).length; console.log(JSON.stringify({executed:results.length,passed:results.length-failed,failed,skipped:0,results},null,2)); if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
