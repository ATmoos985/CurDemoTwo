// Uses real stateless nesting only; the isolated browser context never saves business tasks or reports.
const {chromium,expect}=require(process.env.PLAYWRIGHT_MODULE||'playwright/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const base=process.env.BASE_URL||'http://localhost:8080',root=path.resolve(__dirname,'../../main/resources/static');
 const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],writes=[],passed=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))writes.push(new URL(request.url()).pathname);});
 // Preview the current source against the running stateless API before packaging.
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==new URL(base).origin||url.pathname.startsWith('/api/'))return route.continue();
   const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
   if(!file.startsWith(root+path.sep))return route.abort();
   if(!fs.existsSync(file))return route.continue();
   const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
   await route.fulfill({body:fs.readFileSync(file),contentType:mime[path.extname(file)]||'application/octet-stream'});
 });
 try {
   await page.goto(base+'/cutting.html');
   const marker=page.frameLocator('#workspace-marker iframe');
   await expect(page.locator('#mode-marker')).toHaveAttribute('aria-selected','true');
   await expect(page.locator('#workspace-rectangle iframe')).toHaveCount(0);
   await expect(marker.locator('#marker-width')).toHaveValue('1500');
   await expect(marker.locator('#marker-style')).toHaveValue('GARMENT_SHIRT');
   await expect(marker.locator('#marker-style option')).toHaveCount(3);
   passed.push('默认唛架与三款案例，矩形工作台按需加载');
   fs.mkdirSync('target/garment-cases',{recursive:true});
   for(const [style,count] of [['GARMENT_SHIRT',18],['GARMENT_PANTS',18],['GARMENT_SKIRT',14]]) {
     await marker.locator('#marker-style').selectOption(style);
     await expect(marker.locator('#marker-result-export')).toBeDisabled();
     await marker.locator('#marker-run').click();
     await expect(marker.locator('#marker-run')).toBeEnabled({timeout:60000});
     assert.equal(await marker.locator('#marker-error').isVisible(),false,await marker.locator('#marker-error').innerText());
     await expect(marker.locator('#marker-state')).toContainText(`${count} / ${count} 片齐套`);
     await expect(marker.locator('#marker-error')).toBeHidden();
     const download=page.waitForEvent('download');await marker.locator('#marker-input-export').click();
     const input=JSON.parse(fs.readFileSync(await (await download).path(),'utf8'));
     assert.equal(input.material.shape.width,1500);assert.equal(input.parts.reduce((n,p)=>n+p.quantity,0),count);
     assert.ok(input.parts.every(p=>!p.allowRotation));
     await page.screenshot({path:`target/garment-cases/${style}.png`,fullPage:true});
     passed.push(`${style} 真实齐套排料及输入导出`);
     console.log('PASS',style,await marker.locator('#marker-length').innerText(),await marker.locator('#marker-utilization').innerText());
   }
   const length=await marker.locator('#marker-length').innerText();
   await page.locator('#mode-rectangle').click();
   const rectangle=page.frameLocator('#workspace-rectangle iframe');
   await expect(rectangle.locator('body')).not.toHaveAttribute('inert','');
   await rectangle.getByRole('button',{name:'新建任务',exact:true}).click();
   await expect(rectangle.locator('#demand-manager')).toBeVisible();
   await rectangle.locator('#task-name').fill('切换模式保留的演示草稿');
   await expect(rectangle.locator('#demand-manager-garment')).toHaveAttribute('href','/cutting.html');
   await expect(rectangle.locator('#demand-manager-garment')).toHaveAttribute('target','_blank');
   await page.locator('#mode-marker').click();
   await expect(marker.locator('#marker-length')).toHaveText(length);
   await page.locator('#mode-rectangle').click();
   await expect(rectangle.locator('#task-name')).toHaveValue('切换模式保留的演示草稿');
   await page.locator('#mode-rectangle').focus();await page.keyboard.press('ArrowLeft');
   await expect(page.locator('#mode-marker')).toHaveAttribute('aria-selected','true');
   passed.push('模式切换保留结果与草稿，键盘切换有效');
   await marker.locator('#marker-style').selectOption('GARMENT_PANTS');
   await expect(marker.locator('#marker-length')).toHaveText('—');
   await marker.locator('#marker-run').click();await marker.locator('#marker-style').selectOption('GARMENT_SKIRT');
   await expect(marker.locator('#marker-state')).toContainText('待排料');
   await expect(marker.locator('#marker-result-export')).toBeDisabled();
   await marker.locator('#marker-run').click();await marker.locator('#marker-cancel').click();
   await expect(marker.locator('#marker-state')).toContainText('已停止');
   passed.push('切换款式使旧结果失效并取消旧计算');
   for(const width of [1920,1366,390,320]) {
     await page.setViewportSize({width,height:900});
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
     assert.ok(await marker.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   }
   await page.screenshot({path:'target/garment-cases/mobile-320.png',fullPage:true});
   passed.push('桌面与手机宽度无横向溢出');
   assert.deepEqual(errors,[]);assert.ok(writes.every(p=>p==='/api/v1/nesting/solve'),JSON.stringify(writes));
   passed.push('无脚本错误，无库存或报工写入');
   console.log(JSON.stringify({discovered:8,executed:passed.length,passed:passed.length,failed:0,skipped:0,checks:passed},null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
