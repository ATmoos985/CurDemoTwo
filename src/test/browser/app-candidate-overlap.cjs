// Independent candidate plans may cover the same material range; viewing never books or cancels them.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.BASE_URL;
assert.ok(base && ['localhost','127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port!=='8080','isolated inventory required');
const api=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
const frames=p=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
(async()=>{
 const id='OVERLAP-'+randomUUID(),roll=await api('/api/rolls',{rollId:id,rollModel:id,width:1500,totalLength:12000,usedLength:0});
 const shape={type:'POLYGON',width:300,height:400,vertices:[{x:0,y:0},{x:300,y:0},{x:300,y:150},{x:100,y:150},{x:100,y:400},{x:0,y:400}]};
 const task=await api('/api/cutting/tasks',{name:id,materialModel:id,revision:0,demands:[{id:1,name:'凹形重叠候选',width:300,length:400,quantity:2,allowRotation:true,shape}],process:{bedLength:1000,trimStart:0,firstStageOrientation:'horizontal',pieceGap:5,cutOrigin:'left-top',allowRotation:true,allowLongitudinal:true}});
 const {buildSolveRequest}=await import('../../main/resources/static/app/js/model/solve-request.js');
 const solve=async len=>{const r=await api('/api/solve',buildSolveRequest({task,roll,win:{start:2000,len},settings:{timeLimitSeconds:1}}));assert.equal(r.engine,'packingsolver-irregular');assert.ok(r.success && r.planId && !r.fallbackReason);return r;};
 const a=await solve(1000),b=await solve(900);assert.notEqual(a.planId,b.planId);
 const archive=async()=>({plans:await api('/api/cutting/tasks/'+task.id+'/plans'),task:await api('/api/cutting/tasks/'+task.id),roll:await api('/api/rolls/'+id),stocks:await api('/api/remnants')});
 const before=await archive(),browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const page=await browser.newPage({viewport:{width:800,height:885}}),writes=[],errors=[],results=[];
 page.setDefaultTimeout(8000);page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});page.on('pageerror',e=>errors.push(e.message));
 const goto=async plan=>{await page.goto('about:blank');await page.goto(base+'/app/#/workbench/'+task.id+'/'+plan);await page.locator('#rc canvas').first().waitFor();await frames(page);};
 const nodes=()=>page.evaluate(()=>Konva.stages.find(s=>s.container().id==='rc').find('.roll-piece').map(p=>({segment:p.getAttr('segmentId'),id:p.getAttr('pieceId'),x:p.x(),y:p.y(),points:p.points()})));
 const selected=async result=>{const n=await nodes();assert.deepEqual([...new Set(n.map(p=>p.segment))],[result.planId]);for(const p of result.pieces){const found=n.find(n=>n.id===p.id);assert.ok(found);assert.equal(found.x,p.x);assert.equal(found.y,p.y+2000);assert.deepEqual(found.points,p.shape.vertices.flatMap(v=>[v.x,v.y]));}};
 async function check(name,fn){try{await fn();results.push({name,success:true});console.log('PASS',name);}catch(e){results.push({name,success:false,error:e.message});console.error('FAIL',name,e.stack);}}
 try{
  await check('800px station view draws only the selected candidate with its exact native contour',async()=>{await goto(a.planId);await selected(a);assert.ok(await page.locator('#candidate-overlap-notice').isVisible());if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH});});
  await check('full strip and tiled orientation switches never blend alternative candidates',async()=>{await goto(a.planId);for(const mode of ['strip','tile']){await page.locator('[data-view="full"]').click();await page.locator('[data-full="'+mode+'"]').click();for(let i=0;i<2;i++){await page.locator('#orient').click();await frames(page);await selected(a);}}});
  await check('switching plans changes geometry and context selection; empty station stays deterministic',async()=>{await goto(a.planId);await page.locator('#seg-next').click();await frames(page);await selected(b);
   await page.setViewportSize({width:1366,height:768});await page.locator('[data-view="station"]').click();await frames(page);
   const pt=await page.evaluate(()=>{const s=Konva.stages.find(s=>s.container().id==='rc'),n=s.findOne('.roll-piece'),r=s.container().getBoundingClientRect(),p=n.getAbsoluteTransform().point({x:20,y:20});return{x:p.x+r.x,y:p.y+r.y};});
   await page.mouse.click(pt.x,pt.y,{button:'right'});await page.locator('[data-canvas-action="select"]').click();assert.equal(await page.locator('#adjust').count(),1);await page.locator('#adjust-close').click();await frames(page);await selected(b);
   await page.locator('#seg-next').click();await frames(page);await page.locator('[data-view="full"]').click();await page.locator('[data-full="strip"]').click();await frames(page);await selected(a);await page.locator('#seg-prev').click();await frames(page);await selected(b);
  });
  await check('candidate buttons switch exact geometry and scoped metrics with keyboard access',async()=>{
   await goto(a.planId);
   assert.equal(await page.locator('[data-candidate]').count(),2);
   await page.locator('[data-candidate="'+b.planId+'"]').focus();
   await page.keyboard.press('Enter');await frames(page);await selected(b);
   assert.equal(await page.locator('[data-candidate="'+b.planId+'"]').getAttribute('aria-pressed'),'true');
   assert.ok((await page.locator('.metric').innerText()).includes('预计用布'));
   for(const width of [1366,1920]){
    await page.setViewportSize({width,height:768});await frames(page);
    const layout=await page.evaluate(()=>{const h=document.querySelector('.wb-head h1'),a=document.querySelector('.wb-actions'),c=document.querySelector('.canvas-wrap');return{titleFits:h.scrollWidth<=h.clientWidth,actionBottom:a.getBoundingClientRect().bottom,height:innerHeight,canvasHeight:c.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.ok(layout.titleFits);assert.ok(layout.actionBottom<=layout.height);assert.ok(layout.canvasHeight>200);assert.equal(layout.overflow,false);
   }
  });
  await check('invalid candidate presents recalculation as primary and blocks reporting',async()=>{
   const pattern='**/api/cutting/tasks/'+task.id+'/plan-checks';
   await page.route(pattern,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({[a.planId]:'材料或疵点已更新，请重新计算'})}));
   await goto(a.planId);
   assert.ok((await page.locator('.wb-head').innerText()).includes('需重算'));
   assert.ok((await page.locator('.stage.on').innerText()).includes('需重算'));
   assert.ok(await page.locator('#report-open').isDisabled());
   assert.equal(await page.locator('.wb-actions .pri').getAttribute('id'),'solve');
   await page.unroute(pattern);await goto(a.planId);
  });
  await check('candidate viewing neither cancels plans nor changes material or reports',async()=>{assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);assert.deepEqual(await archive(),before);assert.equal(before.plans.filter(p=>p.status==='PENDING').length,2);});
 }finally{await browser.close();}
 const failed=results.filter(r=>!r.success).length;console.log(JSON.stringify({executed:results.length,passed:results.length-failed,failed,skipped:0,results},null,2));if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
