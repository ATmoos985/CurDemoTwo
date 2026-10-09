import {state} from '../../core/state.js';
import {getDemandsFromUI} from '../solver/quota-manager.js';
import {readWorkflowState, navigateWorkflowStage} from '../solver/workflow-guide.js';
import {escapeText} from '../solver/task-workspace.js';
import {switchCutMode} from '../remnant/remnant-shelf.js';
import {solverSettings} from '../settings/settings.js';
import {recommendationMarkup, stockSignature} from './remnant-recommendation.js';
import {showToast} from '../../core/toast.js';

const el = id => document.getElementById(id);
let generation = 0;
const key = candidate => candidate.type + ':' + candidate.id;
const currentKey = () => state.currentCutMode === 'remnant' ? 'remnant:' + state.loadedRemnant?.id : 'roll:' + state.getCurrentCaseData().rollId;
function requestFromUI() {
    return {...solverSettings(), taskId:state.activeTask?.id || null,taskRevision:state.activeTask?.revision || 0,
        rollModel:el('task-material').value,trimStart:Number(el('inp-trim-start').value),
        cutOrigin:el('sel-cut-origin').value,firstStageOrientation:el('sel-first-stage').value,
        demands:getDemandsFromUI().filter(d=>d.demand>0).map(d=>({id:d.id,name:d.name,width:d.width,length:d.length,demand:d.demand,allowRotation:d.allowRotation})),
        allowRotation:el('sel-allow-rotation').value==='1',allowLongitudinal:el('sel-allow-longitudinal').value==='1'};
}
const context = () => JSON.stringify([state.activeTask?.id,state.activeTask?.revision,state.taskCompleted,requestFromUI()]);
async function read(url, body) {
    const response=await fetch(url,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {cache:'no-store'});
    const result=await response.json();if(!response.ok)throw new Error(result.message || '读取库存失败，请重试');return result;
}

/** One job-wide selector; opening and matching never save a task or change inventory. */
export async function openMaterialSelection(preferred = {}) {
    const flow=readWorkflowState();
    if(flow.stage===0 || flow.done) {showToast(flow.hint,'warning');navigateWorkflowStage(flow.done?3:0,flow.target);return;}
    el('material-picker')?.remove();
    const dialog=document.createElement('dialog');dialog.id='material-picker';dialog.className='action-dialog material-picker';
    const request=requestFromUI(), snapshot=context(), token=++generation;
    let candidates=[],selected='',busy=false,analysis=null;
    const completedBaseline=structuredClone(state.taskCompleted || {});
    const hasPreview=!!state.pendingPlan || (state.getCurrentCaseData().pieces || []).some(p=>!p.confirmed);
    dialog.setAttribute('aria-labelledby','material-picker-title');
    dialog.addEventListener('keydown',event=>event.stopPropagation());
    dialog.innerHTML=`<div class="material-picker-heading"><h2 id="material-picker-title">选择本次用料</h2><button class="tool-btn" data-close>关闭</button></div>
        <div class="material-picker-body"><p class="material-match-scope"><strong>${escapeText(request.rollModel)}</strong> · 全部剩余需求 ${request.demands.length} 项 / ${request.demands.reduce((n,d)=>n+d.demand,0)} 件</p>
        <details class="detail-disclosure"><summary>匹配范围与规则</summary><p>只列同型号、库存尺寸可容纳至少一项剩余需求的材料。料头优先列出；每次选择一个来源，不做多材料联合分配。件数、机台加工区、修边、疵点及工艺限制仍需排料验证。</p>
        <ul>${request.demands.map(d=>`<li>${escapeText(d.name)} · ${d.width} × ${d.length} mm · 剩余 ${d.demand} 件</li>`).join('')}</ul></details>
        <section class="remnant-recommendations"><div class="recommendation-heading"><strong>先用料头切一部分</strong><button class="tool-btn active" id="material-recommend">计算料头推荐</button></div>
        <details class="detail-disclosure"><summary>推荐规则与范围</summary><p>按当前工艺、修边、旋转和库存疵点试排；优先消化需求面积，其次整块料头利用率，再按刀数少排序。先评估面积较小的最多 8 块料头，每块搜索 1 秒，不保证全局最优。</p><p>每次选用一块，合格报工后再匹配剩余需求。此处不保存方案、不预占或扣库存；正式方案以装载后重新求解为准。加工区按整块料头计算，请核对实际机台能否容纳。</p></details>
        <p id="material-recommend-status" role="status" hidden></p><div id="material-recommend-results" hidden></div></section>
        <div class="material-picker-filters"><label>来源<select id="material-source-filter" class="prop-input"><option value="all">全部材料</option><option value="remnant">仅料头</option><option value="roll">仅母卷</option></select></label>
        <label>查找<input id="material-search" class="prop-input" type="search" placeholder="编号、库位或扫描条码"></label><button class="tool-btn" id="material-refresh">刷新库存</button></div>
        <p id="material-match-count" class="muted" role="status"></p><div id="material-candidates"></div>
        <p id="material-match-error" role="alert" hidden></p>
        </div><div class="material-picker-footer"><p id="material-selected-summary">选择材料后核对，再装载到当前任务。</p>
        <label id="material-replace-warning" hidden><input id="material-replace-confirm" type="checkbox">切换并清除当前未报工预览。已保存方案留在方案记录中；尚未校验的手调位置将丢失。</label>
        <div class="dialog-actions"><button class="tool-btn" id="material-open-inventory">管理库存档案 ↗</button><button class="tool-btn active" id="material-load" disabled>确认装载</button></div>
        <small class="muted">装载不扣库存、不保存需求；实切后确认报工才记账。</small></div>`;
    document.body.append(dialog);dialog.showModal();
    if(preferred.type==='remnant')el('material-picker-title').textContent='当前需求 · 料头推荐';
    const valid=()=>dialog.open && generation===token;
    const fail=message=>{el('material-match-error').textContent=message;el('material-match-error').hidden=!message;};
    const update=()=>{
        const item=candidates.find(c=>key(c)===selected), replacing=hasPreview && item && key(item)!==currentKey();
        el('material-replace-warning').hidden=!replacing;
        el('material-load').disabled=busy || !item || (replacing && !el('material-replace-confirm').checked);
        el('material-load').textContent=busy?'正在核对库存…':item && key(item)===currentKey()?'保留当前用料':'确认装载';
        el('material-selected-summary').textContent=item?`${item.type==='remnant'?'料头':'母卷'} ${item.id} · ${item.width} × ${item.length} mm · ${item.location || '库位未登记'}`:'选择材料后核对，再装载到当前任务。';
        el('material-refresh').disabled=busy;el('material-recommend').disabled=busy;
        el('material-recommend').textContent=analysis?'重新计算推荐':'计算料头推荐';
        el('material-recommend-results').querySelectorAll('button').forEach(button=>button.disabled=busy);
        el('material-replace-confirm').disabled=busy;el('material-open-inventory').disabled=busy;
        el('material-source-filter').disabled=busy;el('material-search').disabled=busy;
        el('material-candidates').querySelectorAll('input').forEach(input=>input.disabled=busy);
    };
    function render() {
        const words=el('material-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean),type=el('material-source-filter').value;
        const visible=candidates.filter(c=>(type==='all'||c.type===type) && words.every(w=>`${c.id} ${c.location || ''}`.toLowerCase().includes(w)));
        if(!visible.some(c=>key(c)===selected))selected='';
        el('material-match-count').textContent=`显示 ${visible.length} / ${candidates.length} 个匹配来源`;
        el('material-candidates').innerHTML=visible.length?visible.map(c=>`<label class="material-candidate${key(c)===currentKey()?' material-current':''}"><input type="radio" name="job-material" value="${escapeText(key(c))}" ${key(c)===selected?'checked':''} ${busy?'disabled':''}><span><strong>${c.type==='remnant'?'料头':'母卷'} · ${escapeText(c.id)}${key(c)===currentKey()?' · 当前':''}</strong><span>${c.width} × ${c.length} mm · ${escapeText(c.location || '库位未登记')}${c.hasDefect?' · 需避疵':''}</span><small>${c.fittingLines} / ${request.demands.length} 项需求的单件尺寸可容纳；不代表全部数量可排入</small></span></label>`).join(''):'<p class="inventory-empty">暂无匹配材料。可调整筛选，或到库存档案录入材料后刷新。</p>';
        el('material-candidates').querySelectorAll('input').forEach(input=>input.onchange=()=>{selected=input.value;el('material-replace-confirm').checked=false;fail('');update();});update();
    }
    async function refresh() {
        analysis=null;el('material-recommend-results').hidden=true;el('material-recommend-status').hidden=true;
        busy=true;update();fail('');el('material-match-count').textContent='正在匹配库存…';
        try {
            const list=await read('/api/cutting/material-candidates',request);if(!valid())return;
            if(context()!==snapshot)throw new Error('需求已变化，请关闭窗口后重新匹配。');
            candidates=list;selected=preferred.id && candidates.some(c=>key(c)===key(preferred))?key(preferred):'';
            if(preferred.id && !selected)fail(`材料 ${preferred.id} 不在本次匹配范围内，可能已用完、型号或尺寸不符合。请选择其他材料。`);
        } catch(error) {if(!valid())return;candidates=[];selected='';fail(error.message);}
        finally {if(valid()){busy=false;render();}}
    }
    async function recommend() {
        if(busy)return;
        if(context()!==snapshot)return fail('需求或工艺已变化，请关闭窗口后重新匹配。');
        analysis=null;el('material-recommend-results').hidden=true;busy=true;update();fail('');
        const status=el('material-recommend-status');status.hidden=false;status.textContent='正在逐块试排料头，通常需要数秒…';
        try {
            const result=await read('/api/cutting/remnant-recommendations',{input:request,completedBaseline});if(!valid())return;
            if(context()!==snapshot)throw new Error('需求、已报工数量或工艺已变化，请关闭窗口后重新匹配。');
            analysis=result;status.textContent=result.recommendations.length?'推荐已更新；选择一块核对后装载。':'暂无可用推荐，请查看原因或选择母卷。';
            const panel=el('material-recommend-results');panel.innerHTML=recommendationMarkup(result);panel.hidden=false;
            panel.querySelectorAll('[data-recommend-stock]').forEach(button=>button.onclick=()=>{
                const stock=result.recommendations.find(r=>r.stock.id===button.dataset.recommendStock).stock;
                // The trial reads a newer inventory snapshot than the initial dimensions-only list.
                candidates=candidates.filter(c=>c.type!=='remnant' || c.id!==stock.id);candidates.push({type:'remnant',id:stock.id,rollId:stock.sourceRollId,width:stock.width,length:stock.length,location:stock.location,hasDefect:stock.hasDefect,fittingLines:result.recommendations.find(r=>r.stock.id===stock.id).lines.filter(l=>l.placed>0).length});
                selected='remnant:'+stock.id;el('material-source-filter').value='remnant';el('material-search').value='';
                el('material-replace-confirm').checked=false;fail('');render();el('material-selected-summary').scrollIntoView({block:'nearest'});
            });
        } catch(error){if(valid()){analysis=null;status.textContent='推荐未完成，可重试；当前用料和预览保留。';fail(error.message);}}
        finally {if(valid()){busy=false;update();}}
    }
    el('material-recommend').onclick=recommend;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{if(generation===token)generation++;});
    el('material-source-filter').value=preferred.type || 'all';
    el('material-source-filter').onchange=()=>{render();if(el('material-source-filter').value==='remnant' && !analysis)recommend();};el('material-search').oninput=render;
    el('material-replace-confirm').onchange=update;el('material-refresh').onclick=async()=>{await refresh();if(valid() && el('material-source-filter').value==='remnant')await recommend();};
    el('material-open-inventory').onclick=()=>{dialog.close();window.camApp.openMaterialModal(preferred.type==='remnant'?'remnants':'rolls');};
    el('material-load').onclick=async()=>{
        if(busy)return;const item=candidates.find(c=>key(c)===selected);if(!item)return;
        if(context()!==snapshot)return fail('需求已变化，请关闭窗口后重新匹配。');
        if(key(item)===currentKey()){dialog.close();return;}
        if(hasPreview && !el('material-replace-confirm').checked)return;
        busy=true;render();fail('');
        try {
            const fresh=await read('/api/cutting/material-candidates',request);if(!valid())return;
            if(!fresh.some(c=>key(c)===selected))throw new Error('材料已不可用或不再匹配，当前预览保留。请刷新库存重新选择。');
            const stock=await read(item.type==='remnant'?'/api/remnants/scan':'/api/rolls/'+encodeURIComponent(item.id),item.type==='remnant'?{id:item.id}:undefined);
            if(!valid())return;
            if(context()!==snapshot)throw new Error('需求已变化，当前用料保留。请重新匹配。');
            if(!stock || (item.type==='remnant'?stock.id!==item.id || stock.materialBatch!==request.rollModel:stock.rollId!==item.id || stock.rollModel!==request.rollModel || stock.currentRemainingLength<=0))throw new Error('库存已变化，请刷新后重新选择。');
            const recommended=analysis?.recommendations.find(r=>r.stock.id===item.id);
            if(item.type==='remnant' && recommended && stockSignature(stock)!==stockSignature(recommended.stock))throw new Error('料头尺寸、状态或疵点已变化，推荐已过期。请刷新库存并重新计算。');
            if(item.type==='remnant')await switchCutMode('remnant',stock);
            else {const selector=el('sel-mother-roll-id');if(![...selector.options].some(o=>o.value===item.id))selector.add(new Option(item.id,item.id));selector.value=item.id;await switchCutMode('roll',null,null,stock);}
            dialog.close();showToast(`已装载 ${item.id}，需求保持不变，请生成方案核对产出。`,'success');
        } catch(error) {if(valid())fail(error.message);}
        finally {if(valid()){busy=false;render();}}
    };
    await refresh();
    if(valid() && (preferred.type==='remnant' || preferred.recommend))await recommend();
}
