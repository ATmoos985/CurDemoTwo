// Same host precheck and projection for both renderers. Measures CPU frame work, not pointer-to-display latency.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const base=process.env.BASE_URL;
assert.ok(base && ['localhost','127.0.0.1'].includes(new URL(base).hostname));
assert.ok(new URL(base).port && new URL(base).port !== '8080');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const page=await browser.newPage({viewport:{width:1366,height:768}}), errors=[], writes=[];
 page.on('pageerror', e=>errors.push(e.message)); page.on('request', r=>{if(r.method()!=='GET')writes.push(r.url());});
 try {
  await page.route('**/__edit_perf',r=>r.fulfill({contentType:'text/html',body:'<script src="/konva.min.js"></script><style>body{margin:0}#host{position:relative;width:1100px;height:700px}</style><div id="host"></div>'}));
  for(const name of ['roll-canvas.js','camera.js'])await page.route('**/baseline/'+name,r=>r.fulfill({contentType:'text/javascript',body:execFileSync('git',['show','61b62f5:src/main/resources/static/app/js/canvas/'+name],{encoding:'utf8'})}));
  await page.goto(base+'/__edit_perf');
  await page.evaluate(async()=>{
   const {applyPositions,placementProblem,initialPositions}=await import('/app/js/model/plan-tools.js');
   window.factories={baseline:(await import('/baseline/roll-canvas.js')).createRollCanvas,current:(await import('/js/canvas/roll-canvas.js')).createRollCanvas};
   const pieces=Array.from({length:2000},(_,id)=>({id,demandId:1,x:100+id%40*50,y:100+Math.floor(id/40)*50,w:40,l:40,rotated:false}));
   window.plan={request:{rollW:2200,rollL:3000,allowLongitudinal:true,pieceGap:5,demands:[{id:1,allowRotation:true}]},result:{pieces}};
   window.positions=initialPositions(plan);
   const seg={id:'large',start:0,len:3000,status:'pending',pieces:pieces.map(p=>({id:p.id,u:p.y,v:p.x,du:p.l,dv:p.w,color:'#5f87b0',label:'P'+p.id})),cuts:[],remnants:[]};
   window.scene={roll:{id:'construct-large-edit',width:2200,total:5000,used:0},segments:[seg],defects:[],currentId:'large',selectedPiece:0,window:{start:0,len:3000}};
   window.frames=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   window.mountView=async kind=>{window.view?.destroy();document.getElementById('host').replaceChildren();window.view=factories[kind](document.getElementById('host'));view.setOptions({tool:'move'});view.setScene(scene);await frames();};
   window.step=async i=>{const next={...positions,0:{...positions[0],x:100+i%2}};if(placementProblem(next,plan,0))throw new Error('invalid edit fixture');view.setScene({...scene,segments:[applyPositions(seg,plan,next)]});await frames();};
  });
  const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const results=[];
  for(let round=0;round<3;round++)for(const kind of round%2?['current','baseline']:['baseline','current']){
   await page.evaluate(k=>mountView(k),kind);
   await page.evaluate(async()=>{for(let i=0;i<6;i++)await step(i);});
   const before=await metric();await page.evaluate(async()=>{for(let i=0;i<20;i++)await step(i);});const after=await metric();
   results.push({kind,round,busyMs:(after.TaskDuration-before.TaskDuration)*1000/20});
  }
  const median=kind=>results.filter(r=>r.kind===kind).map(r=>r.busyMs).sort((a,b)=>a-b)[1];
  const report={scene:'constructed, 2000 rectangle pieces in one station, identical host precheck and edit projection',browser:browser.version(),rounds:3,steps:20,results,baselineMs:median('baseline'),currentMs:median('current'),ratio:median('current')/median('baseline')};
  console.log(JSON.stringify(report,null,2));
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  assert.ok(report.ratio <= 1.2, '2000-piece edit projection and drawing regressed beyond 20%');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
