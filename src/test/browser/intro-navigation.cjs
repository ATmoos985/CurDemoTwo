// Uses a disposable service: 1D examples create temporary solver tasks.
async function verifyIntro(page, base='http://localhost:18090') {
    if(new URL(base).port==='8080') throw new Error('Use an isolated service outside port 8080.');
    const passed=[],errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))requests.push(r.method()+' '+new URL(r.url()).pathname);});
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.setViewportSize({width:1366,height:900});await page.goto(base+'/intro.html');
    await page.locator('#demo-groups a').first().waitFor();
    check(JSON.stringify(await page.locator('.product-nav a').allTextContents())===JSON.stringify(['介绍','二维裁切','一维裁切','功能演示','跑布验疵']),'five direct destinations');
    check(await page.locator('[data-capabilities],.intro-section').count()===0,'old capability dialog and text accordions removed');
    check(await page.locator('.story-visual svg').count()===3,'three visual product demonstrations');passed.push('五入口导航与图解首页');
    for(const mode of ['sheet','strip']) {
        await page.locator(`[data-cut-mode="${mode}"]`).click();
        await page.waitForFunction(()=>document.getElementById('cutting-showcase').dataset.phase==='裁片分离',null,{timeout:20000});
        check(await page.locator('#cutting-showcase').getAttribute('data-completed-cuts')===(mode==='sheet'?'6':'4'),'all cuts before separation');
        await page.locator('#motion-toggle').click();
        const before=await page.locator(`.${mode}-scene .cut-piece`).first().getAttribute('transform');
        await page.waitForTimeout(150);
        check(before===await page.locator(`.${mode}-scene .cut-piece`).first().getAttribute('transform'),'paused frame remains still');
        await page.locator('#motion-toggle').click();
    }
    passed.push('二维六刀与一维四刀完成后才分离，暂停有效');
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.getElementById('motion-toggle').disabled);
    check(await page.locator('#cutting-showcase').getAttribute('data-phase')==='刀路完成','reduced motion renders completed static cuts');passed.push('减少动态效果');
    for(const width of [1920,1366,390,320]) {
        await page.setViewportSize({width,height:900});
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'intro overflow '+width);
    }
    check(requests.length===0,'intro must not make business writes');passed.push('四种屏宽与介绍页零业务写入');
    await page.setViewportSize({width:1366,height:900});await page.goto(base+'/demos.html#marker');
    const marker=page.frameLocator('#panel-marker iframe');await marker.locator('.marker-check').first().waitFor();
    await marker.locator('#marker-run').click();await marker.locator('#marker-run:enabled').waitFor({timeout:45000});
    check((await marker.locator('#marker-state').innerText()).includes('18 / 18 片齐套'),'real solve must place all 18 pieces');
    check(await marker.locator('.marker-check.complete').count()===12,'all size/part lines fulfilled');
    for(const width of [390,320]) {
        await page.setViewportSize({width,height:900});
        await page.waitForTimeout(250);
        check(await marker.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),'marker iframe overflow '+width);
    }
    await page.setViewportSize({width:1366,height:900});
    check(!await marker.locator('#marker-result-export').isDisabled(),'complete output export enabled');
    const value=await marker.locator('#marker-length').innerText();
    const download=page.waitForEvent('download');await marker.locator('#marker-result-export').click();
    check((await download).suggestedFilename()==='marker-result.json','result export');
    passed.push('服装真实齐套计算、逐码逐片核对与结果导出');
    await page.locator('#tab-sheet').click();const sheet=page.frameLocator('#panel-sheet iframe');
    await sheet.locator('#part-rows .lab-row').first().waitFor();
    await sheet.locator('#scenario-select').selectOption('GARMENT_SHIRT');
    await sheet.locator('#protocol-details summary').click();
    await sheet.locator('#export-input').click();
    await page.locator('#panel-sheet').evaluate(el=>el.scrollIntoView({block:'start'}));
    await sheet.locator('#open-json').click();
    const original=await sheet.locator('#json-input').inputValue();check(JSON.parse(original).process.mode==='CONTOUR','standard input export/edit');
    await sheet.locator('#apply-json').click();
    check(await sheet.locator('#process-mode').inputValue()==='CONTOUR','import preserves contour process');
    await page.locator('#tab-marker').click();check(await marker.locator('#marker-length').innerText()===value,'tab switching retains marker result');
    await page.locator('#tab-sheet').click();check(await sheet.locator('#process-mode').inputValue()==='CONTOUR','tab switching retains edited sheet input');
    passed.push('二维标准输入应用、导出与跨演示状态保留');
    await page.locator('#tab-linear').click();const linear=page.frameLocator('#panel-linear iframe');
    await linear.locator('#compare-rows').waitFor();
    check(await linear.locator('.compare-header').isHidden(),'embedded navigation removed');
    await linear.locator('#compare-rows .solver-row').first().waitFor({timeout:45000});
    check(await linear.locator('#pattern-list .pattern-card .strip').count()>0,'actual solved cutting patterns visible');
    check((await linear.locator('#compare-rows').innerText()).includes('逐单独立分切'),'baseline comparison retained');
    check(await linear.locator('body').evaluate(()=>new URLSearchParams(location.search).get('embed'))==='1','scenario URL retains embed flag');
    passed.push('一维真实搭切计算与嵌入导航');
    await page.locator('#tab-marker').focus();await page.keyboard.press('ArrowLeft');
    check(await page.locator('#tab-sheet').getAttribute('aria-selected')==='true','keyboard tabs');
    await page.locator('#tab-marker').click();
    await marker.locator('#marker-width').fill('1400');
    check(await marker.locator('#marker-length').innerText()==='—' && await marker.locator('#marker-result-export').isDisabled(),'editing invalidates stale marker output');
    await marker.locator('#marker-run').click();await marker.locator('#marker-cancel').click();
    check((await marker.locator('#marker-state').innerText()).includes('已停止'),'cancellation');
    await page.waitForTimeout(500);check(await marker.locator('#marker-result-export').isDisabled(),'late result after cancel not accepted');
    passed.push('键盘切换、输入变更失效与取消计算');
    check(errors.length===0,'browser errors: '+errors.join(';'));
    check(requests.every(r=>r.startsWith('POST /api/v1/nesting/solve')||r.includes('/api/linear/tasks')),'unexpected business writes '+requests.join(';'));
    passed.push('浏览器无脚本异常、无库存和报工写入');
    return {discovered:9,executed:passed.length,passed:passed.length,failed:0,skipped:0,checks:passed};
}
module.exports=verifyIntro;
if(require.main===module){const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});try{console.log(JSON.stringify(await verifyIntro(await browser.newPage(),process.env.BASE_URL||'http://localhost:18090'),null,2));}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});}
