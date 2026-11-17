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

test('the rotation checkbox works with mouse and keyboard and parameter help preserves the selection', async () => {
    const form = page.locator('#garment-form');
    const label = form.getByText('允许 180° 旋转', {exact:true});
    const toggle = form.getByRole('checkbox', {name:'允许 180° 旋转', exact:true});
    const example = form.getByLabel('试算示例');
    const help = page.getByRole('button', {name:'试算条件帮助', exact:true});
    const notes = [/倒顺排/, /1200–2000 mm/, /布头、布尾/].map(text => page.getByText(text));
    await example.selectOption('shirt-three');
    await expect(toggle).toBeInViewport({ratio:1});
    const checkboxBox = await toggle.boundingBox(), exampleBox = await example.boundingBox();
    assert.ok(checkboxBox.y + checkboxBox.height <= exampleBox.y);
    assert.ok(Math.abs(checkboxBox.x - exampleBox.x) <= 5);
    await expect(toggle).not.toBeChecked();
    await expect(form).not.toContainText(/已启用|未启用/);
    for (const note of notes) await expect(note).toBeHidden();

    await label.click();
    await expect(toggle).toBeChecked();
    await help.press('Enter');
    for (const note of notes) await expect(note).toBeVisible();
    await page.keyboard.press('Escape');
    for (const note of notes) await expect(note).toBeHidden();
    await expect(help).toBeFocused();
    await expect(example).toHaveValue('shirt-three');
    await expect(toggle).toBeChecked();
    await toggle.press('Space');
    await expect(toggle).not.toBeChecked();
});

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

test('each named example fills the form without submitting and produces a complete marker', async t => {
    const {GARMENT_EXAMPLES} = await import('../../main/resources/static/app/js/model/garment.js');
    const submissions = [];
    page.on('request', req => {
        if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/v2/optimization-jobs') submissions.push(req.postDataJSON());
    });
    const exampleSelect = page.getByLabel('试算示例');
    for (const example of GARMENT_EXAMPLES) await t.test(example.name, async () => {
        const before = submissions.length;
        await exampleSelect.selectOption(example.id);
        const inputs = await page.locator('#garment-form').evaluate(form => Object.fromEntries(new FormData(form)));
        assert.equal(inputs.style, example.style);
        for (const key of ['M','L','edge','gsm']) assert.equal(Number(inputs[key]), example[key]);
        assert.equal(inputs.widths, example.widths.join(', '));
        assert.equal(await page.locator('tbody tr').count(), 0);
        assert.equal(submissions.length, before);
        await page.getByRole('button', {name:'试算幅宽'}).click();
        await expect(page.getByRole('status').filter({hasText:'试算结束'})).toBeVisible({timeout:90000});
        const rows = page.locator('tbody tr');
        assert.deepEqual(submissions.slice(before).map(req => req.problem.material.shape.width), example.widths);
        assert.equal(await rows.count(), example.widths.length);
        assert.ok(await rows.filter({hasText:'当前最低单耗'}).count() > 0);
        if (example.id === 'gathered-skirt') {
            const fullWidth = rows.filter({has:page.getByRole('cell', {name:'1,400', exact:true})});
            await expect(fullWidth.locator('td').nth(2)).toHaveText('1,360');
            await expect(fullWidth.locator('td').nth(3)).toHaveText('100');
            await fullWidth.getByRole('button').click();
            await expect(page.locator('#garment-view')).toContainText('1,400 mm');
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH});
        }
        console.log(example.name, await rows.locator('td:nth-child(2)').allTextContents());
        await page.getByLabel('克重（g/m²）').fill(String(example.gsm + 1));
        assert.equal(await exampleSelect.inputValue(), '');
        assert.equal(await rows.count(), 0);
    });
});

test('half turns are compared against fixed grain at each width and the best complete marker opens', async () => {
    await page.getByLabel('试算示例').selectOption('shirt-mixed');
    const toggle = page.getByRole('checkbox', {name:'允许 180° 旋转'});
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    const results = [], submissions = [];
    page.on('response', response => {
        const path = new URL(response.url()).pathname, req = response.request();
        if (path.startsWith('/api/v2/optimization-results/')) results.push(response.json());
        if (path === '/api/v2/optimization-jobs' && req.method() === 'POST')
            submissions.push({req:req.postDataJSON(), accepted:response.json()});
    });
    await page.getByRole('button', {name:'试算幅宽'}).click();
    await expect(page.getByRole('status').filter({hasText:'试算结束'})).toBeVisible({timeout:150000});
    const solved = new Map((await Promise.all(results)).map(r => [r.jobId, r]));
    const attempts = await Promise.all(submissions.map(async ({req,accepted}) => {
        const {id} = await accepted;
        const job = await (await page.request.get(base + '/api/v2/optimization-jobs/' + id)).json();
        assert.ok(['SUCCEEDED','TIMED_OUT'].includes(job.state));
        return {req, result:solved.get(id), state:job.state};
    }));
    const rows = page.locator('tbody tr');
    const metrics = [];
    assert.equal(await rows.count(), 6);
    assert.ok(attempts.every(a => [1600,1850,1950].includes(a.req.problem.material.shape.width)));
    for (const [n, width] of [1600,1850,1950].entries()) {
        const group = attempts.filter(a => a.req.problem.material.shape.width === width);
        const [baseRun, firstTurn] = group;
        const original = baseRun.req.problem.material.shape.height, fixed = baseRun.result;
        const tight = fixed?.meetsRequirement ? Math.min(original, Math.ceil(fixed.marker.occupiedLengthMm * 10) / 10) : original;
        assert.equal(firstTurn.req.problem.material.shape.height, tight);
        const retry = tight < original && !firstTurn.result?.meetsRequirement;
        assert.equal(group.length, retry ? 3 : 2);
        const turnRow = rows.nth(n * 2 + 1);
        if (retry) {
            assert.equal(group[2].req.problem.material.shape.height, original);
            await expect(turnRow).toContainText('原起长复试');
        }
        for (const [j, run] of group.entries()) {
            assert.ok(run.req.problem.parts.every(p => !p.allowRotation && Boolean(p.allowHalfTurn) === (j > 0)));
            if (run.result) assert.ok(run.result.layout.placements.every(p => p.rotationDegrees === 0 || (j > 0 && p.rotationDegrees === 180)));
        }
        const rawTurn = group.at(-1).result;
        const retainFixed = fixed?.meetsRequirement && (!rawTurn?.meetsRequirement || fixed.marker.occupiedLengthMm < rawTurn.marker.occupiedLengthMm);
        if (retainFixed) {
            await expect(turnRow).toContainText('沿用固定方向 · 掉头 0 片');
            await expect(turnRow).toContainText(rawTurn?.meetsRequirement ? '掉头原试排' : '掉头试排未齐套');
        }
        for (const [j, chosen] of [fixed, retainFixed ? fixed : rawTurn].entries()) {
            if (!chosen?.meetsRequirement) continue;
            const i = n * 2 + j;
            const actual = chosen.metrics.find(m => m.name === 'markerAreaUtilization').value;
            metrics.push({i, actual, turned:chosen.layout.placements.filter(p => p.rotationDegrees === 180).length});
            assert.ok(Math.abs(Number(await rows.nth(i).locator('td').nth(3).innerText()) - actual) <= 0.0051);
        }
    }
    const best = metrics.reduce((a,b) => a.actual >= b.actual ? a : b);
    await expect(rows.nth(best.i)).toContainText('最高利用率');
    await expect(rows.nth(best.i).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    console.log('上衣同幅宽对照（固定 / 掉头）', JSON.stringify(metrics));
    await toggle.uncheck();
    assert.equal(await rows.count(), 0);
});
