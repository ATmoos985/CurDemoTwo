// Real packaged-service checks. Run only against an explicit isolated localhost BASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, expect} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const base = process.env.BASE_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname) || new URL(base).port === '8080') {
    throw Error('Explicit isolated localhost BASE_URL outside port 8080 required.');
}
const menuNames = ['任务操作', '业务记录', '工具与设置'];
const summary = (page, name) => page.locator('.task-bar summary').filter({hasText:name});
const output = process.env.SCREENSHOT_DIR || path.resolve(__dirname, '../../../target/task-toolbar');
fs.mkdirSync(output, {recursive:true});

(async () => {
    const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
    let passed = 0, failed = 0;
    async function run(name, verify, width = 1366) {
        const context = await browser.newContext({viewport:{width, height:900}});
        const page = await context.newPage(), errors = [], writes = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
            if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + new URL(request.url()).pathname);
        });
        try {
            await verify(page, context);
            assert.deepEqual(errors, [], 'no page exceptions');
            assert.deepEqual(writes, [], 'toolbar navigation must not invoke business writes or computation');
            passed++; console.log('PASS ' + name);
        } catch (error) {
            failed++; console.error('FAIL ' + name + '\n' + error.stack);
        } finally { await context.close(); }
    }
    async function ready(page) {
        await page.goto(base + '/index.html');
        await expect.poll(() => page.evaluate(() => !!window.camApp && !document.body.inert && !!window.Konva?.stages[0])).toBe(true);
        await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
        await expect(summary(page, '任务操作')).toBeVisible();
    }
    try {
        await run('task menus are mutually exclusive and Escape returns focus', async page => {
            await ready(page);
            for (const name of menuNames) {
                await summary(page, name).click();
                await expect(page.locator('.task-bar details[open]')).toHaveCount(1);
                await expect(page.locator('.task-bar details[open] > summary')).toHaveText(name);
            }
            await page.keyboard.press('Escape');
            await expect(page.locator('.task-bar details[open]')).toHaveCount(0);
            await expect(summary(page, '工具与设置')).toBeFocused();
        });
        await run('Escape closes the menu without stopping an active canvas measurement', async page => {
            await ready(page);
            await page.locator('#btn-measure-tool').click();
            await expect(page.locator('#btn-measure-tool')).toHaveAttribute('aria-pressed', 'true');
            await summary(page, '任务操作').click();
            await page.keyboard.press('Escape');
            await expect(page.locator('.task-bar details[open]')).toHaveCount(0);
            await expect(page.locator('#btn-measure-tool')).toHaveAttribute('aria-pressed', 'true');
            assert.equal(await page.evaluate(() => Konva.stages[0].draggable()), false);
        });
        await run('clicking outside closes the task menu and preserves the canvas instance', async page => {
            await ready(page);
            await page.evaluate(() => { window.__toolbarStage = Konva.stages[0]; });
            await summary(page, '业务记录').click();
            await page.locator('.task-identity').click({position:{x:5,y:5}});
            await expect(page.locator('.task-bar details[open]')).toHaveCount(0);
            assert.equal(await page.evaluate(() => window.__toolbarStage === Konva.stages[0]), true);
        });
        await run('opening a task dialog closes its menu without stealing dialog focus', async page => {
            await ready(page);
            await summary(page, '任务操作').click();
            await page.getByRole('button', {name:'打开任务', exact:true}).click();
            await expect(page.locator('#task-picker')).toBeVisible();
            await expect(page.locator('.task-bar details[open]')).toHaveCount(0);
            assert.equal(await page.evaluate(() => document.querySelector('#task-picker').contains(document.activeElement)), true);
            await page.keyboard.press('Escape');
            await expect(page.locator('#task-picker')).toBeHidden();
        });
        for (const width of [1920, 1366, 390]) {
            await run('long task identity and menu bounds remain usable at ' + width + 'px', async page => {
                await ready(page);
                await page.locator('#current-task-name').click();
                const name = '长任务名称用于验证工具栏不会挤掉保存入口及业务菜单'.repeat(8).slice(0, 120);
                await page.locator('#task-name').fill(name);
                await page.locator('#demand-manager .workbench-dialog-heading [data-close]').click();
                await expect(page.locator('#current-task-name')).toHaveText(name);
                const bounds = await page.locator('.task-bar').evaluate(bar => {
                    const r = bar.getBoundingClientRect();
                    const nodes = ['.task-identity', '.task-primary-actions', '.workflow-stages', '.task-record-actions'].map(selector => {
                        const b = bar.querySelector(selector).getBoundingClientRect();
                        return {left:b.left, right:b.right, top:b.top, bottom:b.bottom};
                    });
                    return {left:r.left, right:r.right, bottom:r.bottom, width:innerWidth, height:innerHeight, nodes};
                });
                assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom < bounds.height / 2, JSON.stringify(bounds));
                for (const node of bounds.nodes) assert.ok(node.left >= bounds.left - 1 && node.right <= bounds.right + 1, JSON.stringify(bounds));
                for (let i = 0; i < bounds.nodes.length; i++) for (let j = i + 1; j < bounds.nodes.length; j++) {
                    const a = bounds.nodes[i], b = bounds.nodes[j];
                    assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, 'toolbar sections overlap: ' + JSON.stringify(bounds));
                }
                await expect(page.getByRole('button', {name:'保存需求', exact:true})).toBeVisible();
                await expect(page.locator('#task-state')).toBeVisible();
                for (const name of menuNames) {
                    await summary(page, name).click();
                    const menu = await page.locator('.task-bar details[open] .header-more-menu').boundingBox();
                    assert.ok(menu.x >= -1 && menu.x + menu.width <= width + 1 && menu.y >= 0 && menu.y + menu.height <= 900, JSON.stringify({name, width, menu}));
                    await page.keyboard.press('Escape');
                }
                await page.screenshot({path:path.join(output, 'toolbar-' + width + '.png')});
            }, width);
        }
        await run('task-management menu navigation retains the workspace canvas and creates no browser tab', async (page, context) => {
            await page.goto(base + '/workspace.html#' + encodeURIComponent('/index.html'));
            await expect.poll(() => !!page.frames().find(frame => new URL(frame.url()).pathname === '/index.html')).toBe(true);
            const frame = page.frames().find(frame => new URL(frame.url()).pathname === '/index.html');
            await expect.poll(() => frame.evaluate(() => !!window.camApp && !document.body.inert && !!window.Konva?.stages[0])).toBe(true);
            await frame.evaluate(() => {
                document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
                window.__toolbarDocument = document; window.__toolbarStage = Konva.stages[0];
                window.__toolbarCanvas = document.querySelector('#konva-container canvas');
                Konva.stages[0].scale({x:.37,y:.37}); Konva.stages[0].position({x:71,y:93}); window.camApp.bus.emit('stage:panned');
            });
            await summary(frame, '任务操作').click();
            await frame.getByRole('link', {name:'任务管理', exact:true}).click();
            await expect(page.locator('#workspace-tab-tasks')).toHaveAttribute('aria-selected', 'true');
            await expect(frame.locator('.task-bar details[open]')).toHaveCount(0);
            assert.equal(context.pages().length, 1);
            await page.locator('#workspace-tab-workbench').click();
            await expect(page.locator('#workspace-tab-workbench')).toHaveAttribute('aria-selected', 'true');
            assert.deepEqual(await frame.evaluate(() => ({same:document === window.__toolbarDocument && Konva.stages[0] === window.__toolbarStage && document.querySelector('#konva-container canvas') === window.__toolbarCanvas, x:Konva.stages[0].x(), y:Konva.stages[0].y(), scale:Konva.stages[0].scaleX()})), {same:true,x:71,y:93,scale:.37});
        });
        await run('garment demo belongs to help and returns to the retained two-dimensional workbench', async (page, context) => {
            await page.goto(base + '/workspace.html#' + encodeURIComponent('/index.html'));
            await expect.poll(() => !!page.frames().find(frame => new URL(frame.url()).pathname === '/index.html')).toBe(true);
            const frame = page.frames().find(frame => new URL(frame.url()).pathname === '/index.html');
            await expect.poll(() => frame.evaluate(() => !!window.camApp && !document.body.inert && !!window.Konva?.stages[0])).toBe(true);
            await frame.evaluate(() => {
                document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
                window.__toolbarDocument = document; window.__toolbarStage = Konva.stages[0];
            });
            const help = page.locator('#workspace-menu details').filter({has:page.locator('[data-page="marker"]')});
            await expect(help.locator('summary')).toHaveText('演示与帮助');
            await expect(page.locator('#workspace-menu [data-page="marker"]')).toBeHidden();
            await help.locator('summary').click();
            await page.locator('#workspace-menu [data-page="marker"]').click();
            await expect(page.locator('#workspace-tab-marker')).toHaveAttribute('aria-selected', 'true');
            await expect.poll(() => !!page.frames().find(frame => new URL(frame.url()).pathname === '/marker-demo.html')).toBe(true);
            const marker = page.frames().find(frame => new URL(frame.url()).pathname === '/marker-demo.html');
            await expect(marker.locator('.marker-formula').first()).toContainText('搜索策略尚未接入生产任务');
            await marker.getByRole('link', {name:'二维排料与切割',exact:true}).click();
            await expect(page.locator('#workspace-tab-workbench')).toHaveAttribute('aria-selected', 'true');
            assert.equal(context.pages().length, 1);
            assert.equal(page.frames().filter(frame => new URL(frame.url()).pathname === '/index.html').length, 1);
            assert.equal(await frame.evaluate(() => document === window.__toolbarDocument && Konva.stages[0] === window.__toolbarStage), true);
            await page.screenshot({path:path.join(output, 'workspace-return.png')});
        });
    } finally { await browser.close(); }
    console.log(JSON.stringify({discovered:9, executed:passed + failed, passed, failed, skipped:0}));
    if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
