// Run against the packaged app; set PLAYWRIGHT_MODULE / CHROME_PATH for a bundled runtime.
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const assert = require('node:assert/strict');

(async () => {
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0;
    try {
        const page = await browser.newPage({viewport:{width:920,height:678}}), errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
        await page.goto((process.env.BASE_URL || 'http://localhost:8080') + '/nesting.html');
        await expect(page.locator('#scenario-select')).toHaveValue('GUILLOTINE');
        for (const [key, material, mode] of [
            ['CROSSCUT','MATERIAL-1','CROSSCUT'], ['GUILLOTINE','MATERIAL-1','GUILLOTINE'],
            ['3','DEMO-3','GUILLOTINE'], ['4','DEMO-4','GUILLOTINE'],
            ['6','DEMO-6','GUILLOTINE'], ['CONTOUR','POLYGON-1','CONTOUR']
        ]) {
            // Real select interaction dispatches input before change, reproducing the original failure.
            await page.locator('#scenario-select').selectOption(key);
            await expect(page.locator('#scenario-select')).toHaveValue(key);
            await expect(page.locator('#material-id')).toHaveValue(material);
            await expect(page.locator('#process-mode')).toHaveValue(mode);
            await expect(page.locator('#solve-error')).toBeHidden();
            assert.ok(await page.locator('#part-rows .lab-row').count() > 0);
            passed++;
        }
        await page.locator('#scenario-select').focus(); await page.keyboard.press('Home');
        await expect(page.locator('#scenario-select')).toHaveValue('CROSSCUT');
        await expect(page.locator('#material-height')).toHaveValue('3000');
        await page.locator('#material-width').fill('2100');
        await expect(page.locator('#scenario-select')).toHaveValue('');
        await expect(page.locator('#material-width')).toHaveValue('2100');
        await page.locator('#scenario-select').selectOption('CROSSCUT');
        await expect(page.locator('#material-width')).toHaveValue('2000');
        passed++;
        await page.locator('#solve-button').click();
        await expect(page.locator('#solve-status')).toContainText('已排入', {timeout:15000});
        await expect(page.locator('#export-result')).toBeEnabled();
        await page.locator('#scenario-select').selectOption('GUILLOTINE');
        await expect(page.locator('#material-height')).toHaveValue('4000');
        await expect(page.locator('#area-pieces')).toHaveText('—');
        await expect(page.locator('#export-result')).toBeDisabled();
        assert.deepEqual(errors, []);
        assert.ok(writes.length === 1 && writes[0].endsWith('/api/v1/nesting/solve'));
        passed++;
        console.log(JSON.stringify({discovered:8,executed:8,passed,failed:0,skipped:0}));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
