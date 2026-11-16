// All computation and temporary fixtures target an isolated service, never port 8080.
const assert = require('node:assert/strict');
const {readFileSync, writeFileSync} = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL;
assert.ok(base && ['localhost','127.0.0.1'].includes(new URL(base).hostname) && new URL(base).port && new URL(base).port !== '8080');
(async () => {
    const {SHOWCASE_CASES} = await import('../../main/resources/static/app/js/model/showcase.js');
    const browser = await chromium.launch({headless: true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})}), page = await browser.newPage({viewport: {width:1366,height:768}});
    const results = [], errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {if(r.method() !== 'GET') writes.push(new URL(r.url()).pathname);});
    page.setDefaultTimeout(10000);
    async function resizeAndFit(width, height) {
        await page.setViewportSize({width,height});
        await page.waitForFunction(({width,height}) => {
            const host=document.querySelector('#demo-canvas'),stage=Konva.stages[0];
            return innerWidth===width && innerHeight===height && stage.width()===host.clientWidth && stage.height()===host.clientHeight;
        }, {width,height});
        await page.locator('#demo-fit').click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.waitForFunction(() => {
            const stage=Konva.stages[0];
            return stage.find('.roll-piece').every(n => {
                const r=n.getClientRect();
                return r.x>=21 && r.y>=21 && r.x+r.width<=stage.width()+1 && r.y+r.height<=stage.height()+1;
            });
        });
    }
    async function check(name, fn) {
        try {await fn();results.push({name,success:true});console.log('PASS',name);}
        catch(e) {results.push({name,success:false,error:e.stack});console.error('FAIL',name,e.message);}
    }
    const api = async path => {const r=await fetch(base+path); assert.ok(r.ok);return r.json();};
    const before = {rolls:await api('/api/rolls'),tasks:await api('/api/cutting/tasks'),remnants:await api('/api/remnants')};
    try {
        await check('root, catalogue search and business guides use the new application',async()=>{
            await page.goto(base+'/');await page.waitForURL('**/app/#/tasks');
            await page.locator('#nav a[href="#/showcase"]').click(); await page.locator('#case-search').waitFor();
            assert.equal(await page.locator('[data-case]').count(),SHOWCASE_CASES.length);
            await page.locator('#case-search').fill('旋转');assert.equal(await page.locator('[data-case]:visible').count(),4);
            assert.equal(await page.locator('iframe').count(),0);
            assert.equal(await page.locator('.page-host a[href$=".html"]').count(),0);
        });
        for(const item of SHOWCASE_CASES) await check('real computation: '+item.id,async()=>{
            await page.goto(base+'/app/#/showcase/'+item.id);await page.locator('#demo-run').click();
            await page.waitForFunction(()=>!document.querySelector('#demo-run')?.disabled,null,{timeout:90000});
            const state=await page.locator('#demo-state').innerText();
            assert.match(state,/计算完成|计算结束/,await page.locator('#demo-result').innerText());
            assert.ok(await page.locator('#demo-result-export').isEnabled());
            assert.equal(await page.evaluate(()=>Konva.stages.length),1);
            if(item.id==='rotation-off') assert.equal(await page.evaluate(()=>Konva.stages[0].find('.roll-piece').length),0);
            if(item.id==='rotation-on') assert.equal(await page.evaluate(()=>Konva.stages[0].find('.roll-piece').length),1);
            if(['GARMENT_SHIRT','GARMENT_PANTS','GUILLOTINE','3','film','board'].includes(item.id)) {
                const download=page.waitForEvent('download');await page.locator('#demo-result-export').click();
                const result=JSON.parse(readFileSync(await (await download).path(),'utf8'));
                if(result.layout) {
                    const min={GARMENT_SHIRT:80,GARMENT_PANTS:70,GUILLOTINE:80,'3':80}[item.id];
                    assert.ok(result.metrics.find(m=>m.name==='processingAreaUtilization').value>=min,JSON.stringify(result.metrics));
                    if(item.id.startsWith('GARMENT')) assert.ok(result.layout.placements.length>=20);
                    if(item.id==='GUILLOTINE') {
                        const long=result.layout.placements.find(p=>p.demandId===2),main=result.layout.placements.find(p=>p.demandId===1);
                        assert.ok(long && main);assert.ok(long.y+long.shape.height<=main.y+.01,'long strip belongs above the main panel');
                    }
                } else {
                    const length=item.id==='film'?6000000:2440,display=Math.min(length,5000);
                    assert.ok(result.slitting.patterns.every(p=>p.lengthMm===length));
                    assert.equal(result.fulfillmentStatus,'COMPLETE');
                    const heights=await page.evaluate(()=>Konva.stages[0].find('.roll-piece').map(n=>n.height()));
                    assert.ok(heights.length>0 && heights.every(h=>h===display));
                    assert.match(await page.locator('#demo-input').innerText(),new RegExp('图示段长 '+display.toLocaleString('en-US')+' mm'));
                }
                if(process.env.SCREENSHOT_DIR) {
                    writeFileSync(process.env.SCREENSHOT_DIR+'/result-'+item.id+'.json',JSON.stringify(result,null,2));
                    for(const [width,height] of [[1366,768],[1920,1080]]) {
                        await resizeAndFit(width,height);
                        await page.screenshot({path:process.env.SCREENSHOT_DIR+'/'+item.id+'-'+width+'.png'});
                    }
                }
            }
            if(item.id==='GUILLOTINE') {await page.locator('#demo-path').click();await page.waitForFunction(()=>Konva.stages[0].find('.roll-path').length>0);}
            if(item.id==='4') for(const [w,h] of [[1366,768],[1920,1080]]) {
                await resizeAndFit(w,h);
                const button=await page.locator('#demo-run').boundingBox();assert.ok(button.y+button.height<=h);
                if(process.env.SCREENSHOT_DIR) await page.screenshot({path:process.env.SCREENSHOT_DIR+'/showcase-'+w+'.png'});
            }
            if(item.id==='curtain') {await page.locator('#demo-quality').click();await page.waitForFunction(()=>!document.querySelector('#demo-quality').disabled,null,{timeout:60000});assert.match(await page.locator('#demo-compare').innerText(),/快速搭切[\s\S]*精细优化/);}
        });
        await check('legacy routes preserve scenario and never mount an old demo or submit an old job',async()=>{
            for(const [url,hash] of [['/nesting.html?scenario=4','4'],['/demos.html#linear','film'],['/marker-demo.html?style=GARMENT_PANTS','marker-GARMENT_PANTS'],['/linear-demo.html?scenario=curtain','curtain'],['/cloth_cad_nesting.html','GUILLOTINE']]){
                await page.goto(base+url);await page.waitForURL('**/app/#/showcase/'+hash);await page.locator('#demo-run').waitFor();assert.equal(await page.locator('iframe').count(),0);
            }
            assert.ok(writes.every(p=>p.startsWith('/api/v2/optimization-jobs')),JSON.stringify(writes));
        });
        await check('cancel and route cleanup discard late results and all canvas instances',async()=>{
            await page.goto(base+'/app/#/showcase/marker-GARMENT_SHIRT'); await page.locator('#demo-run').click();
            await page.locator('#demo-cancel').click();assert.ok(await page.locator('#demo-run').isEnabled());
            assert.ok(await page.locator('#demo-result-export').isDisabled());
            await page.locator('#nav a[href="#/tasks"]').click();await page.waitForFunction(()=>Konva.stages.length===0);
            assert.equal(await page.locator('#demo-canvas').count(),0);
        });
        await check('all demonstrations leave inventory and business tasks unchanged with no browser errors',async()=>{
            assert.deepEqual({rolls:await api('/api/rolls'),tasks:await api('/api/cutting/tasks'),remnants:await api('/api/remnants')},before);
            assert.deepEqual(errors,[]);
        });
    } finally {await browser.close();}
    const failed=results.filter(r=>!r.success).length;
    console.log(JSON.stringify({executed:results.length,passed:results.length-failed,failed,skipped:0,results},null,2));if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
