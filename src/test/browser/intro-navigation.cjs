// Use a disposable service: opening the existing 1D workbench creates an empty task.
async function verifyIntro(page, base = 'http://localhost:18090') {
    if (new URL(base).port === '8080') throw new Error('Use an isolated service outside port 8080.');
    const passed = [], errors = [], writes = [];
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
    await page.emulateMedia({reducedMotion: 'no-preference'});
    await page.setViewportSize({width:1366,height:768});
    await page.goto(base + '/');
    await page.locator('#intro-stats').filter({hasText:'行业场景'}).waitFor();
    check(await page.locator('h1').innerText() === '不同订单，\n一起切。', 'root page must show the new introduction');
    check(await page.locator('.intro-section[open]').count() === 0, 'details start collapsed');
    passed.push('首页与渐进展开');
    await page.locator('[data-cut-mode="strip"]').click();
    check(await page.locator('#cutting-showcase').getAttribute('data-mode') === 'strip', '1D scene selected');
    check(await page.locator('#cutting-caption').innerText() === '不同幅宽，共用一卷', '1D explanation changes');
    await page.locator('[data-cut-mode="sheet"]').click();
    await page.locator('#motion-toggle').click();
    check(await page.locator('.cut-piece').first().evaluate(el => getComputedStyle(el).animationPlayState) === 'paused', 'pause actually stops animation');
    await page.locator('#motion-toggle').click();
    check(await page.locator('.cut-piece').first().evaluate(el => getComputedStyle(el).animationPlayState) === 'running', 'resume actually plays animation');
    const before = await page.locator('.cut-trace').first().evaluate(el=>getComputedStyle(el).strokeDashoffset);
    await page.waitForFunction(value => getComputedStyle(document.querySelector('.cut-trace')).strokeDashoffset !== value, before, {timeout:15000});
    passed.push('两种切割演示、暂停与实际动画变化');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.waitForFunction(() => document.getElementById('motion-toggle').disabled);
    check(await page.locator('#motion-toggle').isDisabled(), 'reduced motion should disable playback');
    check(await page.locator('.cut-piece').first().evaluate(el => getComputedStyle(el).animationName) === 'none', 'reduced motion must be static');
    passed.push('系统减少动态效果');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.waitForFunction(() => !document.getElementById('motion-toggle').disabled);
    const menu = page.locator('.product-nav summary').filter({hasText:'二维裁切'});
    await menu.focus(); await page.keyboard.press('Enter');
    await page.locator('.nav-dropdown a[href="/index.html"]').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    check(await page.locator('.nav-group[open]').count() === 0, 'Escape closes menu');
    check(await menu.evaluate(el=>el===document.activeElement), 'Escape returns focus');
    await menu.click(); await page.locator('.product-nav summary').filter({hasText:'一维分切'}).click();
    check(await page.locator('.nav-group[open]').count() === 1, 'only one menu opens');
    await page.locator('h1').click();
    check(await page.locator('.nav-group[open]').count() === 0, 'outside click closes menu');
    passed.push('导航键盘、互斥与外部关闭');
    await page.goto(base + '/intro.html#industry-garment');
    check(await page.locator('#industries').getAttribute('open') !== null, 'industry deep link opens details');
    check(await page.locator('#tab-garment').getAttribute('aria-selected') === 'true', 'deep link selects industry');
    await page.locator('#tab-garment').focus(); await page.keyboard.press('ArrowRight');
    check(await page.locator('#tab-garment').getAttribute('aria-selected') === 'false', 'industry keyboard navigation retained');
    await page.goto(base + '/intro.html#limits');
    check(await page.locator('#limits').getAttribute('open') !== null, 'boundary deep link opens details');
    passed.push('行业与能力边界深链接');
    for (const width of [1920,1366,390,320]) {
        await page.setViewportSize({width,height:900});
        await page.goto(base + '/intro.html');
        await page.locator('.product-nav summary').first().click();
        const fit=await page.evaluate(()=>{const b=document.querySelector('.nav-dropdown').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth && b.left>=0 && b.right<=innerWidth;});
        check(fit, 'page and menu overflow at ' + width);
        await page.keyboard.press('Escape');
    }
    passed.push('四种屏宽与下拉菜单边界');
    check(writes.length===0, 'introduction must not write business data');
    for (const [path,id] of [['/index.html','workbench'],['/nesting.html','lab'],['/linear.html','linear'],['/linear-demo.html','compare'],['/inspection.html','inspection'],['/inventory.html','inventory']]) {
        await page.setViewportSize({width:1366,height:768}); await page.goto(base+path);
        await page.locator('[data-product-nav="'+id+'"] .product-nav').waitFor();
        check(await page.locator('.product-nav [aria-current="page"]').count()===1, 'one active page on '+path);
        const links=await page.locator('.product-nav a:not([aria-current])').evaluateAll(els=>els.map(a=>({target:a.target,rel:a.rel})));
        check(links.every(a=>a.target==='_blank' && a.rel.includes('noopener')), 'preserve work in new tabs: '+path);
        const group=page.locator('.nav-group').first();await group.locator('summary').click();
        await group.locator('.nav-dropdown').waitFor({state:'visible'});
    }
    passed.push('六个业务页面的共用导航与保留作业行为');
    check(errors.length===0, 'page errors: '+errors.join(';'));
    check(writes.every(request=>request==='POST '+base+'/api/linear/tasks') && writes.length<=1, 'unexpected business mutations: '+writes.join(';'));
    passed.push('浏览器无脚本错误、介绍页无业务写入');
    await page.goto(base+'/intro.html');
    return {discovered:8,executed:passed.length,passed:passed.length,failed:0,skipped:0,checks:passed};
}

module.exports = verifyIntro;
if (require.main === module) {
    const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    (async () => {
        const browser = await chromium.launch({headless:true, executablePath:process.env.CHROME_PATH});
        try { console.log(JSON.stringify(await verifyIntro(await browser.newPage(), process.env.BASE_URL || 'http://localhost:18090'), null, 2)); }
        finally { await browser.close(); }
    })().catch(error => { console.error(error); process.exitCode=1; });
}
