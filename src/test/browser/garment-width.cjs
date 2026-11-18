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
    await page.getByRole('link', {name:/唛架幅宽试算|多门幅工艺对比/}).click();
});
after(async () => { await browser?.close(); });

test('the rotation checkbox works with mouse and keyboard and parameter help preserves the selection', async () => {
    const form = page.locator('#garment-form');
    const label = form.getByText('允许 180° 旋转', {exact:true});
    const toggle = form.getByRole('checkbox', {name:'允许 180° 旋转', exact:true});
    const fill = form.getByRole('checkbox', {name:'同款裁片补空', exact:true});
    const example = form.getByLabel('试算示例');
    const help = page.getByRole('button', {name:'试算条件帮助', exact:true});
    const notes = [/倒顺排/, /每个已选尺码/, /1200–2000 mm/, /布头、布尾/].map(text => page.getByText(text));
    await example.selectOption('shirt-three');
    await expect(toggle).toBeInViewport({ratio:1});
    const checkboxBox = await toggle.boundingBox(), exampleBox = await example.boundingBox();
    assert.ok(checkboxBox.y + checkboxBox.height <= exampleBox.y);
    assert.ok(Math.abs(checkboxBox.x - exampleBox.x) <= 5);
    await expect(toggle).not.toBeChecked();
    await expect(fill).toBeChecked();
    await fill.uncheck();
    await expect(page.getByRole('columnheader', {name:'含补片利用率 %'})).toHaveCount(0);
    await expect(example).toHaveValue('shirt-three');
    await fill.press('Space');
    await expect(fill).toBeChecked();
    await expect(page.getByRole('columnheader', {name:'含补片利用率 %'})).toBeVisible();
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
    await page.getByRole('checkbox', {name:'同款裁片补空'}).uncheck();
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
    await page.getByRole('checkbox', {name:'同款裁片补空'}).check();
    assert.equal(await page.locator('tbody tr').count(), 0);
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
    const {markerSizeLabels} = await import('../../main/resources/static/js/nesting/marker-demo.js');
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
        for (const key of [...markerSizeLabels(example.style), 'edge']) assert.equal(Number(inputs[key]), example[key]);
        assert.equal(inputs.gsm, example.gsm == null ? '' : String(example.gsm));
        assert.equal(inputs.widths, example.widths.join(', '));
        assert.equal(await page.locator('tbody tr').count(), 0);
        assert.equal(submissions.length, before);
        await page.getByRole('checkbox', {name:'允许 180° 旋转'}).uncheck();
        await page.getByRole('button', {name:'试算幅宽'}).click();
        await expect(page.getByRole('status').filter({hasText:'试算结束'})).toBeVisible({timeout:90000});
        const rows = page.locator('tbody tr');
        assert.deepEqual(submissions.slice(before).map(req => req.problem.material.shape.width), example.widths);
        assert.equal(await rows.count(), example.widths.length);
        for (const row of await rows.all()) await expect(row.locator('td').nth(1)).toHaveText(/^齐套/);
        if (example.gsm != null) assert.ok(await rows.filter({hasText:'当前最低单耗'}).count() > 0);
        if (example.id === 'gathered-skirt') {
            const fullWidth = rows.filter({has:page.getByRole('cell', {name:'1,400', exact:true})});
            await expect(fullWidth.locator('td').nth(2)).toHaveText('1,360');
            await expect(fullWidth.locator('td').nth(3)).toHaveText('100');
            await fullWidth.getByRole('button').click();
            await expect(page.locator('#garment-view')).toContainText('1,400 mm');
            if (process.env.SCREENSHOT_PATH) await page.screenshot({path:process.env.SCREENSHOT_PATH});
        }
        console.log(example.name, await rows.locator('td:nth-child(2)').allTextContents());
        await page.getByLabel('克重（g/m²）').fill(String((example.gsm ?? 200) + 1));
        assert.equal(await exampleSelect.inputValue(), '');
        assert.equal(await rows.count(), 0);
    });
});

test('half turns are compared against fixed grain at each width and the best complete marker opens', async () => {
    await page.getByLabel('试算示例').selectOption('shirt-mixed');
    const toggle = page.getByRole('checkbox', {name:'允许 180° 旋转'});
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.getByRole('checkbox', {name:'同款裁片补空'}).check();
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
            assert.deepEqual(run.req.strategy.gapFillLimits, Object.fromEntries(run.req.problem.parts.map(p => [p.id,2*p.quantity])));
            assert.ok(run.req.problem.parts.every(p => !p.allowRotation && Boolean(p.allowHalfTurn) === (j > 0)));
            if (run.result) assert.ok(run.result.layout.placements.every(p => p.rotationDegrees === 0 || (j > 0 && p.rotationDegrees === 180)));
        }
        const rawTurn = group.at(-1).result;
        const rate = (result, metric) => result?.metrics.find(m => m.name === metric)?.value;
        const effective = result => rate(result,'markerAreaUtilizationWithFill') ?? rate(result,'markerAreaUtilization');
        const retainFixed = fixed?.meetsRequirement && (!rawTurn?.meetsRequirement || fixed.marker.occupiedLengthMm < rawTurn.marker.occupiedLengthMm
            || effective(fixed) > effective(rawTurn));
        if (retainFixed) {
            await expect(turnRow).toContainText('沿用固定方向 · 掉头 0 片');
            await expect(turnRow).toContainText(rawTurn?.meetsRequirement ? '掉头原试排' : '掉头试排未齐套');
        }
        for (const [j, chosen] of [fixed, retainFixed ? fixed : rawTurn].entries()) {
            if (!chosen?.meetsRequirement) continue;
            const i = n * 2 + j;
            const actual = rate(chosen, 'markerAreaUtilization');
            const fill = rate(chosen, 'markerAreaUtilizationWithFill');
            const extras = chosen.marker.gapFillPlacements;
            const cells = rows.nth(i).locator('td');
            const number = async col => Number((await cells.nth(col).innerText()).split('\n')[0].replaceAll(',', ''));
            const length = chosen.marker.occupiedLengthMm;
            assert.ok(Math.abs(await number(3) - actual) <= .0051);
            assert.ok(Math.abs(await number(4) - length / 2) <= .0051);
            assert.ok(Math.abs(await number(5) - width * (length / 2) * 200 / 1e6) <= .0051);
            if (fill == null) {
                await expect(cells.nth(6)).toHaveText('—');
            } else {
                assert.ok(fill >= actual && fill <= 100.000001);
                assert.ok(Math.abs(await number(6) - fill) <= .0051);
                await expect(cells.nth(6)).toContainText(`实补 ${extras.length} 片`);
            }
            metrics.push({i, actual:effective(chosen), extras:extras?.length ?? 0, fill});
        }
    }
    assert.ok(metrics.some(m => m.extras > 0), 'at least one default shirt layout fits a real spare part');
    const best = metrics.reduce((a,b) => a.actual >= b.actual ? a : b);
    await expect(rows.nth(best.i)).toContainText(best.fill != null ? '最高含补片利用率' : '最高齐套利用率');
    await expect(rows.nth(best.i).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    console.log('上衣同幅宽对照（固定 / 掉头）', JSON.stringify(metrics));
    await toggle.uncheck();
    assert.equal(await rows.count(), 0);
});

test('四大件直链直接展示十六片优化排料，可切换按图复排且不提交', async () => {
    const submissions = [];
    const capture = req => {
        if (req.method() === 'POST' && req.url().endsWith('/api/v2/optimization-jobs')) submissions.push(req);
    };
    page.on('request', capture);
    try {
        await page.goto(base + '/app/#/garment/four-piece-130-140');
        await expect(page.getByLabel('试算示例')).toHaveValue('four-piece-130-140');
        await expect(page.locator('#garment-benchmark')).toContainText('原报告 83.40% · DXF 同版长换算 83.55%');
        await expect(page.locator('#garment-benchmark')).toContainText('1780 × 1825.1 mm');
        const optimized = page.getByRole('button', {name:/优化排料/}), replay = page.getByRole('button', {name:/按图复排/});
        await expect(optimized).toContainText('1806.90 mm · 84.39%');
        await expect(optimized).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#garment-view')).toContainText('优化排料 · 16 片');
        await expect(replay).toHaveAttribute('aria-pressed', 'false');
        await replay.click();
        await expect(page.locator('#garment-view')).toContainText('按图复排 · 16 片');
        await expect(optimized).toHaveAttribute('aria-pressed', 'false');
        await optimized.click();
        await expect(page.locator('#garment-view')).toContainText('优化排料 · 16 片');
        await expect(page.locator('#garment-canvas canvas').first()).toBeVisible();
        await expect(page.locator('tbody tr')).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveText('待试算');
        const styles = await page.getByLabel('试算示例').locator('option').allTextContents();
        assert.ok(styles.some(text => text.includes('20148D')));
        assert.ok(styles.some(text => text.includes('3129')));
        console.log('原报告、同长换算和独立复排', await page.locator('#garment-reference').innerText());
        if (process.env.REFERENCE_SCREENSHOT_PATH) await page.screenshot({path:process.env.REFERENCE_SCREENSHOT_PATH});
        await page.getByLabel('试算示例').selectOption('dxf-20148d-shell');
        await expect(page.locator('#garment-reference')).toBeHidden();
        await expect(page.locator('#garment-canvas canvas')).toHaveCount(0);
        assert.equal(submissions.length, 0);
    } finally {
        page.off('request', capture);
    }
});

test('四大件按 130、140 配码实算 16 片，展示固定与掉头方案及独立的报告参考值', async () => {
    const problems = [], results = [];
    const capture = response => {
        const path = new URL(response.url()).pathname;
        if (path === '/api/v2/optimization-jobs' && response.request().method() === 'POST') {
            problems.push({request:response.request().postDataJSON(), accepted:response.json()});
        }
        if (path.startsWith('/api/v2/optimization-results/')) results.push(response.json());
    };
    page.on('response', capture);
    try {
        await page.goto('about:blank');
        await page.goto(base + '/app/#/garment/four-piece-130-140');
        await expect(page.getByLabel('试算示例')).toHaveValue('four-piece-130-140');
        for (const size of ['130','140']) await expect(page.getByLabel(size + ' 码（件/版）')).toHaveValue('2');
        await expect(page.getByLabel('有效幅宽（mm）')).toHaveValue('1780');
        await expect(page.getByLabel('克重（g/m²）')).toHaveValue('');
        await expect(page.getByLabel('允许 180° 旋转')).toBeChecked();
        await expect(page.getByLabel('同款裁片补空')).not.toBeChecked();
        const replay = page.getByRole('button', {name:/按图复排/});
        assert.equal(problems.length, 0);
        await expect(page.locator('tbody tr')).toHaveCount(0);
        await page.getByRole('button', {name:'试算幅宽'}).click();
        await expect(page.getByRole('status').filter({hasText:'试算结束'})).toBeVisible({timeout:120000});

        assert.ok(problems.length === 2 || problems.length === 3);
        const solved = new Map((await Promise.all(results)).map(result => [result.jobId,result]));
        for (const [i,{request}] of problems.entries()) {
            assert.equal(request.problem.material.shape.width, 1780);
            assert.equal(request.strategy.gapFillLimits, undefined);
            assert.equal(request.problem.parts.reduce((n,p) => n + p.quantity, 0), 16);
            for (const size of ['130','140']) {
                const pieces = request.problem.parts.filter(p => p.name.startsWith(size));
                assert.equal(pieces.reduce((n,p) => n + p.quantity, 0), 8);
            }
            assert.ok(request.problem.parts.every(p => p.shape.type === 'POLYGON' && !p.allowRotation && !!p.allowHalfTurn === (i > 0)));
        }
        const fixed = solved.get((await problems[0].accepted).id);
        const turned = solved.get((await problems.at(-1).accepted).id);
        console.log('四大件试算状态', await page.locator('tbody tr td:nth-child(2)').allTextContents());
        const seed = turned?.marker?.trials?.find(trial => trial.phase === 'SEED');
        assert.equal(seed?.placed, 16);
        assert.ok(turned.marker.occupiedLengthMm <= seed.occupiedLengthMm + 1e-6);
        const compacted = turned.marker.trials.find(trial => trial.phase === 'COMPACTION');
        console.log('允许掉头后端初排与压紧', {seed, compacted, occupiedLengthMm:turned.marker.occupiedLengthMm,
            utilization:turned.metrics.find(metric => metric.name === 'markerAreaUtilization')?.value});
        const {shapeArea} = await import('../../main/resources/static/js/canvas/nesting-scene.js');
        const area = problems[0].request.problem.parts.reduce((sum,p) => sum + p.quantity * shapeArea(p.shape), 0);
        const rows = page.locator('tbody tr');
        await expect(rows).toHaveCount(2);
        const numbers = [];
        for (const i of [0,1]) {
            const row = rows.nth(i);
            await expect(row).toContainText(i ? '允许掉头' : '固定方向');
            await expect(row).toContainText('较按图复排');
            const usesFixed = i === 0 || (await row.textContent()).includes('沿用固定方向');
            const chosen = usesFixed ? fixed : turned;
            assert.equal(chosen?.validationStatus, 'PASSED');
            assert.equal(chosen.fulfillmentStatus, 'COMPLETE');
            assert.equal(chosen.layout.placements.length, 16);
            assert.ok(chosen.layout.placements.every(p => p.rotationDegrees === 0 || (!usesFixed && p.rotationDegrees === 180)));
            const length = chosen.marker.occupiedLengthMm;
            const utilization = chosen.metrics.find(m => m.name === 'markerAreaUtilization').value;
            assert.ok(utilization > 0 && utilization <= 100);
            assert.ok(Math.abs(utilization - area / (1780 * length) * 100) < .001);
            const numbersInRow = (await row.locator('td.num').allTextContents()).map(text => Number(text.replaceAll(',', '')));
            assert.ok(Math.abs(numbersInRow[1] - length) <= .0051);
            assert.ok(Math.abs(numbersInRow[2] - utilization) <= .0051);
            assert.ok(Math.abs(numbersInRow[3] - length / 4) <= .0051);
            await expect(row.locator('td').nth(5)).toHaveText('—');
            await row.getByRole('button').click();
            await expect(page.locator('#garment-view')).toContainText('1,780 mm');
            assert.ok(await page.locator('#garment-canvas canvas').count() > 0);
            numbers.push({direction:i ? '允许180°' : '固定',lengthMm:length,utilization,usedFixed:usesFixed,
                rotated:chosen.layout.placements.filter(p => p.rotationDegrees === 180).length});
        }
        assert.ok(numbers[1].utilization >= numbers[0].utilization);
        assert.ok(numbers[1].utilization >= 84.39);
        if (!numbers[1].usedFixed)
            await expect(rows.nth(1)).toContainText(seed.occupiedLengthMm - turned.marker.occupiedLengthMm > .005 ? '较初排缩短' : '沿用已验初排');
        if (process.env.FOUR_PIECE_SCREENSHOT_PATH) await page.screenshot({path:process.env.FOUR_PIECE_SCREENSHOT_PATH});
        await expect(replay).toHaveAttribute('aria-pressed', 'false');
        await replay.click();
        await expect(replay).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#garment-view')).toContainText('按图复排 · 16 片');
        await expect(rows.getByRole('button', {pressed:true})).toHaveCount(0);
        console.log('四大件 1780 mm（原报告 1825.1 mm / 83.4%）', JSON.stringify(numbers));
    } finally {
        page.off('response', capture);
    }
});

test('manual DXF style selection shows its graded sizes and submits only the selected fabric and size', async () => {
    const {GARMENT_EXAMPLES, markerRequest} = await import('../../main/resources/static/app/js/model/garment.js');
    const shell = GARMENT_EXAMPLES.find(e => e.source === '20148D' && e.fabric === '面布');
    const rib = GARMENT_EXAMPLES.find(e => e.source === '20148D' && e.fabric === '罗纹');
    await page.goto(base + '/app/#/garment/' + shell.id);
    const form = page.locator('#garment-form');
    await expect(form.getByLabel('试算示例')).toHaveValue(shell.id);
    await expect(page.locator('#garment-reference')).toBeHidden();
    const sizeInputs = form.locator('#garment-sizes input');
    assert.deepEqual(await sizeInputs.evaluateAll(inputs => inputs.map(i => i.name)), ['130','140','110','120','150','160']);
    await form.getByLabel('内置样板').selectOption(rib.style);
    await expect(form.getByLabel('试算示例')).toHaveValue('');
    await expect(form.getByLabel('克重（g/m²）')).toHaveJSProperty('required', false);
    await form.getByLabel('130 码（件/版）').fill('0');
    await form.getByLabel('140 码（件/版）').fill('0');
    await form.getByLabel('160 码（件/版）').fill('1');
    await form.getByLabel('允许 180° 旋转').uncheck();
    const submission = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/v2/optimization-jobs'));
    await page.getByRole('button', {name:'试算幅宽'}).click();
    const actual = (await submission).postDataJSON();
    assert.deepEqual(actual.problem.parts, markerRequest(rib.style, 1780, {160:1}, 'expected').problem.parts);
    await expect(page.getByRole('status')).toContainText('1 / 1 个幅宽齐套', {timeout:90000});
    await expect(page.locator('tbody tr td').nth(5)).toHaveText('—');
    await form.getByLabel('内置样板').selectOption('GARMENT_SKIRT');
    assert.deepEqual(await sizeInputs.evaluateAll(inputs => inputs.map(i => i.name)), ['M','L']);
    await expect(form.getByLabel('克重（g/m²）')).toHaveJSProperty('required', true);
});
