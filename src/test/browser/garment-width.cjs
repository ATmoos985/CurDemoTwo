// Runs pure optimization jobs; does not create orders or write inventory.
const {before, after, test} = require('node:test');
const assert = require('node:assert/strict');
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL || 'http://localhost:8080';
let browser, page;

before(async () => {
    browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH});
    page = await browser.newPage({viewport:{width:1366,height:768}});
    await page.goto(base + '/app/#/tasks');
    await page.getByRole('link', {name:'唛架幅宽试算'}).click();
});
after(async () => { await browser?.close(); });

test('invalid per-marker garment count blocks submission', async () => {
    await expect(page.getByRole('button', {name:'停止', exact:true})).toHaveCount(0);
    await page.getByLabel('M 码（件/版）').fill('0');
    await page.getByLabel('L 码（件/版）').fill('0');
    await page.getByRole('button', {name:'试算幅宽'}).click();
    assert.equal(await page.locator('#garment-l').evaluate(input => input.validity.customError), true);
    assert.equal(await page.locator('tbody tr').count(), 0);
});

test('two real jobs return complete markers with selectable drawings and comparable units', async () => {
    await page.getByLabel('内置样板').selectOption('GARMENT_SKIRT');
    await page.getByLabel('M 码（件/版）').fill('1');
    await page.getByLabel('L 码（件/版）').fill('0');
    await page.getByLabel('有效幅宽（mm）').fill('1600，1850');
    await page.getByLabel('两侧布边合计（mm）').fill('50');
    await page.getByRole('button', {name:'试算幅宽'}).click();
    await expect(page.getByRole('status').filter({hasText:'2 / 2 个幅宽齐套'})).toBeVisible({timeout:90000});
    await expect(page.getByRole('button', {name:'停止', exact:true})).toHaveCount(0);
    const rows = await page.locator('tbody tr').all();
    assert.equal(rows.length, 2);
    const values = [];
    for (const row of rows) {
        const [width, state, length, utilization, perLength, perMass] = await row.locator('td').allTextContents();
        const num = text => Number(text.replaceAll(',', ''));
        assert.equal(num(perLength), num(length));
        assert.ok(num(utilization) > 0 && num(utilization) <= 100);
        assert.ok(Math.abs(num(perMass) - (num(width) + 50) * num(length) * 200 / 1e6) < .02);
        values.push({state, grams:num(perMass)});
        await row.getByRole('button').click();
        await expect(page.locator('#garment-view')).toContainText(width);
        assert.ok(await page.locator('#garment-canvas canvas').count() > 0);
    }
    assert.match(values.sort((a,b) => a.grams - b.grams)[0].state, /当前最低单耗/);
    console.log('齐套候选', JSON.stringify(await page.locator('tbody tr').allTextContents()));
});

test('editing clears results, stopping prevents later widths from being submitted', async () => {
    await page.getByLabel('有效幅宽（mm）').fill('1500,1600,1700');
    assert.equal(await page.locator('tbody tr').count(), 0);
    const submitted = [];
    page.on('request', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v2/optimization-jobs') submitted.push(req.postDataJSON());
    });
    const first = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/v2/optimization-jobs'));
    await page.getByRole('button', {name:'试算幅宽'}).click();
    await first;
    const cancelled = page.waitForResponse(res => res.url().endsWith('/cancellations'));
    await page.getByRole('button', {name:'停止', exact:true}).click();
    assert.ok((await cancelled).ok());
    await expect(page.locator('tbody tr').filter({hasText:'已停止'})).toHaveCount(3);
    assert.equal(submitted.length, 1);
});

test('a failed width stays visible while the next real width can still qualify', async () => {
    await page.setViewportSize({width:1920,height:1080});
    await page.getByLabel('有效幅宽（mm）').fill('1550,1650');
    await page.route('**/api/v2/optimization-jobs', route => route.fulfill({
        status:503, contentType:'application/json', body:JSON.stringify({message:'测试服务暂时不可用'})
    }), {times:1});
    await page.getByRole('button', {name:'试算幅宽'}).click();
    await expect(page.getByRole('status').filter({hasText:'1 / 2 个幅宽齐套'})).toBeVisible({timeout:90000});
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toContainText('试算失败');
    assert.equal(await rows.first().locator('td').nth(5).textContent(), '—');
    await expect(rows.last()).toContainText('当前最低单耗');
});
