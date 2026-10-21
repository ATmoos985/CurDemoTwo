// Writes fixtures only to an explicitly isolated server.
const assert = require('node:assert/strict');
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL;
if (!base || new URL(base).port === '8080') throw new Error('Explicit isolated BASE_URL required; port 8080 is forbidden.');
async function api(path, body, headers = {}) {
    const response = await fetch(base + path, body === undefined ? {} : {method:'POST', headers:{'Content-Type':'application/json', ...headers}, body:JSON.stringify(body)});
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
}
(async () => {
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0;
    try {
        const suffix = Date.now(), model = '迟到响应验证-' + suffix, rollId = 'STALE-' + suffix;
        await api('/api/rolls', {rollId, rollModel:model, width:2000, totalLength:12000, inspectionStatus:'PASSED', defects:[]});
        const makeTask = name => api('/api/cutting/tasks', {name, materialModel:model, revision:0, demands:[{id:1,name:'P',width:2000,length:1000,quantity:3,allowRotation:false}]});
        const task = await makeTask('迟到响应 A'), other = await makeTask('切换目标 B');
        const plan = await api('/api/solve', {taskId:task.id, taskRevision:task.revision, rollId, rollW:2000, rollL:3000, windowStartY:0, allowLongitudinal:false, demands:[{id:1,name:'P',width:2000,length:1000,demand:1,allowRotation:false}]});
        await api('/api/v2/execution-orders', {planId:plan.planId, station:'迟到响应验证'}, {'Idempotency-Key':'stale-' + suffix});
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(base + '/index.html'); await page.waitForLoadState('networkidle');
        for (const [label, path] of [['方案 GET', '/api/cutting/plans/' + plan.planId], ['装载母卷 GET', '/api/rolls/' + rollId]]) {
            await page.evaluate(async id => (await import('/js/business/cutting/task-workspace.js')).loadTask(id), task.id);
            await page.evaluate(async () => (await import('/js/business/cutting/execution-panel.js')).openTaskExecutions());
            let release, entered;
            const gate = new Promise(resolve => { release = resolve; });
            const hit = new Promise(resolve => { entered = resolve; });
            const pattern = '**' + path;
            await page.route(pattern, async route => { entered(); await gate; await route.continue(); });
            await page.locator('#execution-dialog [data-view]').click();
            await Promise.race([hit, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' was not requested')), 10000))]);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#execution-dialog').evaluate(dialog => dialog.open), false);
            try {
                await page.evaluate(async id => (await import('/js/business/cutting/task-workspace.js')).loadTask(id), other.id);
            } finally { release(); }
            // run() clears inert only after the delayed view/mount operation has settled.
            await expect.poll(() => page.locator('#execution-dialog').evaluate(dialog => dialog.inert)).toBe(false);
            const state = await page.evaluate(async () => { const {state} = await import('/js/core/state.js'); return {taskId:state.activeTask.id, planId:state.pendingPlan?.result?.planId}; });
            assert.equal(state.taskId, other.id, label + ' overwrote the new task');
            assert.notEqual(state.planId, plan.planId, label + ' restored a stale plan');
            await page.unroute(pattern);
            passed++; console.log('PASS ' + label + '：关闭弹窗并切换任务后，迟到响应不覆盖当前工作台');
        }
        assert.deepEqual(errors, []); passed++; console.log('PASS 浏览器无未捕获错误');
        console.log(JSON.stringify({executed:passed,passed,failed:0,skipped:0}));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
