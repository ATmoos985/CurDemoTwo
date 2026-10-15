import {defaults,sample,validateInput,layout,totals,demandBalance,groupKey,escapeHtml as esc} from './linear-model.js';
const $=id=>document.getElementById(id), fields=['motherWidth','leftTrim','rightTrim','minWidth','maxWidth','step','totalOverCap','profile'];
const state={orders:[],taskId:null,snapshot:null,selected:null,checked:new Set(),busy:false,dirty:false,epoch:0};
const draftKey='cutdemo.linear.draft.v1', taskKey='cutdemo.linear.task.v1';
const fmt=(number,digits=0)=>Number.isFinite(number)?number.toLocaleString('zh-CN',{maximumFractionDigits:digits,minimumFractionDigits:digits}):'—';
function feedback(message,error=false){$('feedback').hidden=!message;$('feedback').textContent=message;$('feedback').dataset.error=String(error);}
function input(){return {...Object.fromEntries(fields.map(id=>[id,id==='profile'?$(id).value:Number($(id).value)])),orderItems:state.orders.map(o=>({...o}))};}
function store(){try{sessionStorage.setItem(draftKey,JSON.stringify({...input(),draftDirty:state.dirty}));$('draft-status').textContent='本页需求已保留';}catch{$('draft-status').textContent='草稿保存失败，请导出或保留本页';}}
function setInput(value){for(const id of fields)$(id).value=value[id]??defaults[id];state.orders=(value.orderItems||[]).map(o=>({...o}));renderOrders();updateAvailable();}
function updateAvailable(){$('available-width').textContent=`${fmt(Number($('motherWidth').value)-Number($('leftTrim').value)-Number($('rightTrim').value))} mm`;}
function changed(){state.dirty=true;store();updateAvailable();if(state.snapshot?.result){$('plan-label').textContent='输入已修改';feedback('需求或工艺已修改，图中保留上次方案；请重新计算后再调整或导出。');}controls();}
function renderOrders(){
    $('order-count').textContent=`${state.orders.length} 条`;$('empty-orders').hidden=!!state.orders.length;
    $('order-rows').innerHTML=state.orders.map((o,i)=>`<div class="order-row" data-row="${i}"><div class="order-row-head"><input data-field="messageText" aria-label="第 ${i+1} 条订单标识" maxlength="200" required value="${esc(o.messageText)}"><button class="tool-btn remove" type="button" data-remove="${i}" aria-label="删除第 ${i+1} 条需求">×</button></div><div class="order-fields">${[['width','幅宽 mm'],['quantity','需求 卷'],['length','卷长 m']].map(([key,label])=>`<label>${label}<input type="number" min="1" step="1" required data-field="${key}" value="${esc(o[key])}"></label>`).join('')}</div><label class="treatment">表面处理<input data-field="surfaceTreatment" maxlength="100" required value="${esc(o.surfaceTreatment)}"></label></div>`).join('');
}
function controls(){
    const ready=!!state.snapshot?.result&&!state.dirty&&!state.busy;
    $('input-fields').disabled=state.busy;$('solve').disabled=state.busy;
    $('solve').textContent=state.busy?'正在计算…':'生成分切方案';
    for(const id of ['new-task','import-excel','load-sample'])$(id).disabled=state.busy;
    $('export').disabled=!ready;$('recut').disabled=!ready||!state.checked.size;$('undo').disabled=!ready||!state.snapshot?.undoCount;
    $('undo').textContent=`撤销调整${state.snapshot?.undoCount?` (${state.snapshot.undoCount})`:''}`;
    $('group-filter').disabled=!state.snapshot?.result||state.busy;
    $('refresh-result').disabled=!state.taskId||state.busy;
    document.querySelectorAll('[data-check]').forEach(el=>el.disabled=!ready);
}
async function request(path,options={}){
    const response=await fetch('/api/linear'+path,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...options.headers},cache:'no-store'});
    const data=await response.json().catch(()=>({message:`请求失败（${response.status}）`}));
    if(!response.ok||data.success===false)throw Error(data.message||data.detail||'操作失败，请重试。');
    return data;
}
function rememberTask(){try{if(state.taskId)sessionStorage.setItem(taskKey,state.taskId);else sessionStorage.removeItem(taskKey);}catch{}}
async function poll(epoch,attempt=0){
    if(epoch!==state.epoch||!state.taskId)return;
    try{
        const snapshot=await request(`/tasks/${encodeURIComponent(state.taskId)}`);
        if(epoch!==state.epoch)return;
        if(snapshot.status==='RUNNING'){state.busy=true;$('footer-status').textContent='分切计算中，正在等待结果';controls();setTimeout(()=>poll(epoch),1000);return;}
        state.busy=false;state.snapshot=snapshot;state.checked.clear();
        if(snapshot.input&&!state.dirty){setInput(snapshot.input);store();}
        if(snapshot.result){renderResult();}
        if(snapshot.status==='FAILED'){feedback(`计算或调整失败：${snapshot.message}。可重试计算${snapshot.result?'，当前保留的方案请核对后使用':''}。`,true);$('plan-label').textContent='操作失败';}
        else{feedback('分切方案已生成。选择组合查看明细；勾选组合可重新搭切。');$('plan-label').textContent='预览方案';}
        if(state.dirty){$('plan-label').textContent='输入已修改';feedback('已恢复你修改后的需求草稿；图中是上次方案，请重新计算后再调整或导出。');}
        $('footer-status').textContent=snapshot.status==='FAILED'?'操作失败，可重试':'计算完成 · 方案未报工';controls();
    }catch(error){
        if(epoch!==state.epoch)return;
        feedback(`暂时无法读取结果：${error.message}${attempt<3?'，正在重试…':'。点击“刷新结果”恢复查询。'}`,true);
        if(attempt<3)setTimeout(()=>poll(epoch,attempt+1),2000);
        else{state.busy=false;$('footer-status').textContent='结果状态待确认';controls();}
    }
}
function allGroups(){return state.snapshot?.preview?.preview||[];}
function renderResult(){
    const groups=allGroups(),snapshot=state.snapshot,summary=totals(groups,snapshot.input);
    const groupsSet=[...new Set(groups.map(groupKey))],previous=$('group-filter').value;
    $('group-filter').innerHTML='<option value="">全部分组</option>'+groupsSet.map(g=>`<option value="${esc(g)}">${esc(g)}</option>`).join('');
    if(groupsSet.includes(previous))$('group-filter').value=previous;
    $('metrics').innerHTML=[['用卷数',fmt(summary.rolls),'卷'],['分切组合',fmt(groups.length),'组'],['整卷得率',fmt(snapshot.result.utilizationRate,2),'%'],['可切区利用率',fmt(summary.cuttableRate,2),'%'],['累计可切区余边',fmt(summary.remaining),'mm·卷'],['左右固定切边',`${snapshot.input.leftTrim} / ${snapshot.input.rightTrim}`,'mm']].map(([label,value,unit])=>`<div class="metric"><span>${label}</span><strong>${value}<small> ${unit}</small></strong></div>`).join('');
    const balance=demandBalance(snapshot.input.orderItems,snapshot.result.patterns),labels=[...new Set(balance.map(r=>r.group))];
    $('fulfillment').innerHTML=labels.map(group=>`<div class="fulfillment-group">${esc(group)}</div><table class="linear-table"><thead><tr><th>幅宽 mm</th><th>需求</th><th>预计</th><th>差额</th></tr></thead><tbody>${balance.filter(r=>r.group===group).map(r=>`<tr><td>${r.width}</td><td>${r.demand}</td><td>${r.actual}</td><td class="${r.difference<0?'short':''}">${r.difference>0?'+':''}${r.difference}</td></tr>`).join('')}</tbody></table>`).join('');
    state.selected=groups.some(g=>g.sequenceNumber===state.selected)?state.selected:groups[0]?.sequenceNumber;
    renderPatterns();renderSelection();
    $('result-note').textContent='导出当前任务方案，保留长阳输出模板';
}
function renderPatterns(){
    const filter=$('group-filter').value,groups=allGroups().filter(g=>!filter||groupKey(g)===filter),params=state.snapshot.input;
    $('patterns').innerHTML=groups.map(group=>{
        const l=layout(group,params),num=group.sequenceNumber;
        const segment=(w,cls,text)=>w>0?`<span class="${cls}" style="width:${w/params.motherWidth*100}%" title="${esc(text)}">${w/params.motherWidth>.055?w:''}</span>`:'';
        return `<article class="pattern-card ${state.selected===num?'selected':''}" data-pattern="${num}"><div class="pattern-heading"><label><input type="checkbox" data-check="${num}" ${state.checked.has(num)?'checked':''}>组合 ${num}</label><span>${esc(groupKey(group))} · 重复 ${group.usageCount} 卷</span></div><button type="button" class="pattern-select" data-select="${num}" aria-label="查看组合 ${num}，重复 ${group.usageCount} 卷"><div class="pattern-strip" role="img" aria-label="左切边 ${params.leftTrim} mm，成品 ${l.widths.join('、')} mm，余边 ${l.remaining} mm，右切边 ${params.rightTrim} mm">${segment(params.leftTrim,'trim','左固定切边 '+params.leftTrim+' mm')}${l.widths.map(w=>segment(w,'product','成品 '+w+' mm')).join('')}${segment(l.remaining,'remaining','可切区余边 '+l.remaining+' mm')}${segment(params.rightTrim,'trim','右固定切边 '+params.rightTrim+' mm')}</div><div class="pattern-caption"><span>成品 <b>${l.product}</b> / 可切区 <b>${l.available}</b> mm</span><span>余边 <b>${l.remaining}</b> mm · 利用率 <b>${fmt(l.cuttableRate,2)}%</b></span></div></button></article>`;
    }).join('')||'<p class="empty-hint">当前分组没有可展示的组合，请核对需求对账。</p>';
    controls();
}
function renderSelection(){
    const group=allGroups().find(g=>g.sequenceNumber===state.selected);
    if(!group){$('selection').textContent='暂无组合明细。';return;}
    const l=layout(group,state.snapshot.input);
    $('selection').innerHTML=`<div class="selection-meta"><strong>组合 ${group.sequenceNumber}</strong> · 重复 ${group.usageCount} 卷<br>${esc(groupKey(group))}<br>成品宽度：${l.widths.join(' + ')} mm<br>固定切边：${state.snapshot.input.leftTrim+state.snapshot.input.rightTrim} mm<br>可切区余边：${l.remaining} mm</div>`+(group.rows||[]).map(row=>`<div class="selection-row"><strong>${esc(row.messageText)}</strong><p>${row.width} mm · ${row.length} m · ${row.rolls} 卷${row.salesperson?' · '+esc(row.salesperson):''}</p></div>`).join('');
    controls();
}
function confirmAction(title,message){const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-message').textContent=message;dialog.returnValue='cancel';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));}
function resetResult(){state.epoch++;state.snapshot=null;state.taskId=null;state.checked.clear();state.selected=null;state.dirty=false;rememberTask();$('metrics').innerHTML='';$('fulfillment').textContent='计算后显示需求、预计产出和差额。';$('selection').textContent='选择组合查看订单明细。';$('patterns').innerHTML='<div class="canvas-empty"><h3>等待生成方案</h3><p>完善左侧需求后开始计算。</p></div>';$('plan-label').textContent='尚未计算';$('result-note').textContent='尚无可导出的方案';feedback('');controls();}
async function change(action,body={}){
    if(state.busy||state.dirty)return;
    const preview=state.snapshot.preview;
    try{state.busy=true;controls();await request(`/tasks/${state.taskId}/${action}`,{method:'POST',body:JSON.stringify({planId:preview.planId,baseRevisionId:preview.revisionId,...body})});feedback('正在处理分切调整…');poll(++state.epoch);}catch(error){state.busy=false;feedback(error.message,true);controls();}
}
$('linear-form').addEventListener('submit',async event=>{
    event.preventDefault();if(state.busy)return;
    try{const payload=validateInput(input());state.busy=true;controls();feedback('正在提交分切需求…');const epoch=++state.epoch;const task=await request('/tasks',{method:'POST',body:JSON.stringify(payload)});state.taskId=task.taskId;state.snapshot=null;state.dirty=false;store();rememberTask();$('metrics').innerHTML='';$('selection').textContent='正在计算新方案。';$('fulfillment').textContent='正在计算需求对账。';$('patterns').innerHTML='<div class="canvas-empty"><h3>正在计算分切组合</h3><p>页面会自动读取结果，可等待计算完成。</p></div>';$('plan-label').textContent='计算中';feedback('正在计算，完成后自动更新结果。');poll(epoch);}catch(error){state.busy=false;feedback(error.message,true);controls();}
});
$('order-rows').addEventListener('input',event=>{const key=event.target.dataset.field,index=Number(event.target.closest('[data-row]')?.dataset.row);if(!key)return;state.orders[index][key]=['width','quantity','length'].includes(key)?Number(event.target.value):event.target.value;changed();});
$('order-rows').addEventListener('click',async event=>{const button=event.target.closest('[data-remove]');if(!button)return;const index=Number(button.dataset.remove);if(await confirmAction('删除需求',`删除“${state.orders[index].messageText}”的输入需求？已有方案不会自动重算。`)){state.orders.splice(index,1);renderOrders();changed();}});
for(const id of fields)$(id).addEventListener('input',changed);
$('add-order').onclick=()=>{state.orders.push({messageText:`订单 ${state.orders.length+1}`,width:1000,quantity:1,length:1000,surfaceTreatment:'单面处理'});renderOrders();changed();$('order-rows').lastElementChild.querySelector('input').focus();};
$('load-sample').onclick=async()=>{if(state.orders.length&&!await confirmAction('载入示例','替换本页需求和工艺为三条演示订单？'))return;resetResult();setInput(sample());store();feedback('已载入演示需求。点击“生成分切方案”运行真实计算。');};
$('new-task').onclick=async()=>{if(state.orders.length&&!await confirmAction('新建需求','清空本页需求并开始新任务？请先导出需要保留的方案。'))return;resetResult();setInput(defaults);store();};
$('import-excel').onclick=()=>$('excel-file').click();
$('excel-file').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    try{if(state.orders.length&&!await confirmAction('导入订单','用 Excel 内容替换当前需求？当前工艺参数保留。'))return;const data=new FormData();data.append('file',file);state.busy=true;controls();feedback('正在解析 Excel…');const parsed=await request('/import',{method:'POST',body:data});if(!parsed.orderItems?.length)throw Error('Excel 未解析到有效需求，请检查模板。');resetResult();state.orders=parsed.orderItems;renderOrders();store();feedback(`已导入 ${state.orders.length} 条需求 · ${parsed.templateSource||'Excel'}。请核对母卷和切边后计算。`);}catch(error){feedback(error.message,true);}finally{state.busy=false;controls();event.target.value='';}
};
$('patterns').addEventListener('change',event=>{if(!event.target.matches('[data-check]'))return;const n=Number(event.target.dataset.check),selected=allGroups().find(g=>g.sequenceNumber===n),checked=event.target.checked;const indices=new Set(selected.instructionIndices||[]);for(const group of allGroups())if(group.sequenceNumber===n||(group.instructionIndices||[]).some(i=>indices.has(i)))checked?state.checked.add(group.sequenceNumber):state.checked.delete(group.sequenceNumber);renderPatterns();});
$('patterns').addEventListener('click',event=>{const b=event.target.closest('[data-select]');if(!b)return;state.selected=Number(b.dataset.select);document.querySelectorAll('[data-pattern]').forEach(el=>el.classList.toggle('selected',Number(el.dataset.pattern)===state.selected));renderSelection();});
$('group-filter').onchange=()=>{state.checked.clear();renderPatterns();};
$('recut').onclick=async()=>{if(!await confirmAction('重新搭切',`对勾选的 ${state.checked.size} 个组合重新计算，其他组合保持当前方案。继续？`))return;change('re-cut',{selectedSequenceNumbers:[...state.checked],selectedSequenceGroupIds:allGroups().filter(g=>state.checked.has(g.sequenceNumber)).map(g=>g.sequenceGroupId)});};
$('undo').onclick=()=>change('undo');
$('refresh-result').onclick=()=>{if(state.dirty){feedback('输入已修改，请重新计算；刷新结果会覆盖当前输入，已暂时保留你的修改。',true);return;}state.busy=true;controls();poll(++state.epoch);};
$('export').onclick=async()=>{try{$('export').disabled=true;const response=await fetch(`/api/linear/tasks/${state.taskId}/export`);if(!response.ok)throw Error((await response.json()).message||'导出失败');const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='一维分切方案.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);feedback('方案 Excel 已生成并下载。');}catch(error){feedback(error.message,true);}finally{controls();}};
$('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';};
try{const draft=JSON.parse(sessionStorage.getItem(draftKey)||'null')||defaults;setInput(draft);state.dirty=!!draft.draftDirty;state.taskId=sessionStorage.getItem(taskKey);}catch{setInput(defaults);feedback('本页草稿无法读取，请重新导入订单。',true);}
controls();if(state.taskId){state.busy=true;controls();poll(++state.epoch);}
