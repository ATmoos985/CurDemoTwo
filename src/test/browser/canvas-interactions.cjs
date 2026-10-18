// Focused wheel, deferred-picking and playback regressions on isolated services.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright/test');
const {openWorkbench, frames, screenPoint} = require('./canvas-performance.cjs');
(async () => {
    const browser = await chromium.launch({headless:true});
    let passed = 0;
    const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
    try {
        const {page, scene, errors, writes} = await openWorkbench(browser, process.env.BASE_URL);
        await page.evaluate(() => window.perf.renderer.viewFullRoll()); await frames(page);
        const box = await page.locator('#konva-container').boundingBox();
        await page.mouse.move(box.x+box.width/2, box.y+box.height/2);
        const fit = await page.evaluate(() => window.perf.stage.stage.scaleX());
        await page.mouse.wheel(0,-100); await frames(page);
        const enlarged = await page.evaluate(() => window.perf.stage.stage.scaleX());
        await page.mouse.wheel(0,100); await frames(page);
        const reduced = await page.evaluate(() => window.perf.stage.stage.scaleX());
        check('380m overview zooms in and back out below .002', () => {
            assert.ok(fit < .0018); assert.ok(enlarged > fit); assert.ok(reduced < enlarged); assert.ok(Math.abs(reduced-fit)<1e-12);
        });
        const notifications = await page.evaluate(async () => {
            const {bus} = await import('/js/core/event-bus.js');
            let n=0; const off=bus.on('stage:transformed',()=>n++);
            const stage=window.perf.stage.stage;
            stage.fire('wheel',{evt:{preventDefault(){},deltaY:-100}});
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            off(); return n;
        });
        check('wheel sends one transform notification',()=>assert.equal(notifications,1));
        await page.evaluate(() => window.perf.renderer.resetToBedView()); await frames(page);
        const piece = await page.evaluate(id=>window.perf.state.getCurrentCaseData().pieces.find(p=>p.id===id),scene.dragId);
        const point = await screenPoint(page,{x:piece.x+piece.w/2,y:piece.y+piece.l/2});
        await page.mouse.click(point.x,point.y); await frames(page);
        const selected = await page.evaluate(()=>window.perf.nesting.getSelectedPieceId());
        check('piece click still selects after zoom/refit',()=>assert.equal(selected,scene.dragId));
        await page.mouse.click(point.x,point.y,{button:'right'});
        assert.equal(await page.locator('#cad-context-menu').isVisible(),true); passed++; console.log('PASS piece context menu');
        await page.keyboard.press('Escape');
        // Compare actual Konva picking against the original build, including tiny historical entities.
        const sample = async p => p.evaluate(async () => {
            const {stage,renderer,state}=window.perf;
            const picked=[];
            for(const mode of ['full','station','pan']) {
                if(mode==='full') renderer.viewFullRoll();
                else if(mode==='station') renderer.resetToBedView();
                else stage.stage.position({x:stage.stage.x()+31,y:stage.stage.y()-27});
                stage.stage.draw();
                const data=state.getCurrentCaseData();
                const items=[...data.pieces.filter((_,i)=>i%17===0),...data.remnants.filter((_,i)=>i%13===0)];
                for(const p of items) {
                    const at={x:stage.stage.x()+(p.x+p.w/2)*stage.stage.scaleX(),y:stage.stage.y()+(p.y+p.l/2)*stage.stage.scaleY()};
                    if(at.x<0||at.y<0||at.x>=stage.stage.width()||at.y>=stage.stage.height()) continue;
                    let node=stage.stage.getIntersection(at);
                    while(node&&!node.name()?.includes('entity-')) node=node.parent;
                    picked.push([mode,p.id,node?.name()||null]);
                }
            }
            return picked;
        });
        // Fresh pages remove click/hover styling and selection from the previous checks.
        const current = await openWorkbench(browser,process.env.BASE_URL);
        const baseline = await openWorkbench(browser,process.env.BASELINE_URL);
        const [a,b] = [await sample(current.page),await sample(baseline.page)];
        check(`overview/station/pan picking matches baseline (${a.length} probes)`,()=>assert.deepEqual(a,b));
        const lifecycle = await current.page.evaluate(async () => {
            const {stage,state,renderer}=window.perf;
            renderer.resetToBedView();
            const piece=stage.pieceGroup.children[0];
            const sim=await import('/js/plugins/cut-player/cut-animator.js');
            sim.stepCut(-999); sim.stepCut(1);
            const progressed=state.currentCutStepLimit===1&&stage.pieceGroup.children[0]===piece;
            sim.stepCut(-1); stage.stage.draw();
            renderer.viewFullRoll(); stage.stage.draw();
            const hidden=stage.cutGroup.children.filter(n=>n.getAttr('cutSequence')!==undefined).every(n=>!n.children[0].visible());
            sim.stepCut(999);
            const restored=stage.cutGroup.children.filter(n=>n.getAttr('cutSequence')!==undefined).every(n=>n.children[0].visible());
            return {progressed,hidden,restored};
        });
        check('playback retains pieces; reset survives culling; show-all restores cuts',()=>assert.deepEqual(lifecycle,{progressed:true,hidden:true,restored:true}));
        for(const w of [current,baseline]) { assert.deepEqual(w.errors,[]); assert.deepEqual(w.writes,[]); }
        check('no browser errors or business writes',()=>{assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);});
        console.log(`Executed ${passed}; passed ${passed}; failed 0; skipped 0`);
    } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
