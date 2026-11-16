// UI shell smoke checks use an isolated service and do not submit business commands.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080', 'isolated service required');
(async () => {
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {})});
    const page = await browser.newPage({viewport: {width: 1366, height: 768}}), errors = [], writes = [], results = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() !== 'GET') writes.push(r.url()); });
    async function check(name, fn) {
        try { await fn(); results.push({name, success: true}); }
        catch (e) { results.push({name, success: false, error: e.message}); }
    }
    try {
        for (const [route, heading] of [['tasks', '任务'], ['execution', '执行与报工'], ['inventory', '库存'], ['documents', '库存单据'], ['quality', '复检处置'], ['settings', '设置'], ['showcase', '能力展示']]) {
            await check('route loads: ' + route, async () => {
                await page.goto(base + '/app/#/' + route);
                await page.getByRole('heading', {name: heading, exact: true, level: 1}).waitFor();
                assert.deepEqual(errors, []);
                assert.equal(await page.locator('nav [aria-current="page"]').count(), 1);
            });
        }
        await check('task search and filter retain accessible controls and identity', async () => {
            await page.goto(base + '/app/#/tasks'); await page.locator('#task-search').waitFor();
            await page.locator('#task-search').fill('no-match-ui-preview-20261116');
            await page.getByText('没有符合条件的任务', {exact: true}).waitFor();
            await page.locator('#task-search').fill('');
            await page.locator('[data-status="PLAN_PENDING"]').click();
            assert.equal(await page.locator('[data-status="PLAN_PENDING"]').getAttribute('aria-pressed'), 'true');
            await page.locator('[data-status="all"]').click();
            assert.equal(await page.locator('[data-status="all"]').getAttribute('aria-pressed'), 'true');
        });
        await check('empty execution queue provides a working task selection link', async () => {
            await page.route('**/api/v2/execution-orders', r => r.fulfill({contentType: 'application/json', body: '[]'}));
            await page.goto(base + '/app/#/execution');
            await page.getByRole('link', {name: '选择任务方案', exact: true}).click();
            await page.getByRole('heading', {name: '排料工作台', exact: true, level: 1}).waitFor();
            await page.unroute('**/api/v2/execution-orders');
        });
        await check('browsing has no business writes or script errors', async () => { assert.deepEqual(writes, []); assert.deepEqual(errors, []); });
    } finally { await browser.close(); }
    const failed = results.filter(r => !r.success).length;
    console.log(JSON.stringify({executed: results.length, passed: results.length - failed, failed, skipped: 0, results}, null, 2));
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
