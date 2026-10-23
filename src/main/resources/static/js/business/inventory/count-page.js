import {identity,emptyDraft,validateSnapshot,observationFor,commandFor,differences,fingerprint,readDraft} from './count-model.js';
const $=id=>document.getElementById(id),storageKey='cutdemo.inventory-count.v1';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const typeName=type=>type==='roll'?'母卷':'料头';
const statusName=status=>({AVAILABLE:'可用',QUARANTINED:'隔离待检',LOST:'盘亏',CONSUMED:'已耗用',SCRAPPED:'已报废',PENDING:'待验',INSPECTED:'已验',PASSED:'检验通过',FAILED:'检验未通过'}[status]||status||'未登记');
const area=value=>(value>0?'+':'')+Number(value).toLocaleString('zh-CN',{maximumFractionDigits:6});
let state=emptyDraft(),lastRaw=null,busy=false,storageBroken=false,review=null,showEditor=false;
const error=message=>{$('count-error').textContent=message;$('count-error').hidden=!message;};
function failStorage(message){storageBroken=true;review=null;error(message+'。已停止提交；请保留浏览器数据，核对历史单据后恢复存储并刷新。');render();}
function readCurrent(){return localStorage.getItem(storageKey);}
function adopt(raw){state=readDraft(raw);lastRaw=raw;showEditor=state.editing;review=null;render();}
function compareStored(){
    const current=readCurrent();
    if(current===lastRaw)return true;
    adopt(current);error('其他页面已更新盘点草稿或提交凭证，已同步，请重新核对。');return false;
}
function save(next){
    try{
        if(!compareStored())return false;
        const raw=JSON.stringify(next);
        localStorage.setItem(storageKey,raw);
        if(readCurrent()!==raw)throw Error('盘点凭证未能可靠保存');
        lastRaw=raw;state=next;return true;
    }catch(failure){failure.storageFailure=true;throw failure;}
}
async function edit(change,full=false){
    if(busy||storageBroken||state.pending)return false;
    try{return await navigator.locks.request(storageKey,()=>{
        if(!compareStored()||state.pending)return false;
        const next=structuredClone(state);change(next);
        if(!save(next))return false;
        review=null;if(full)render();else controls();return true;
    });}catch(failure){failStorage('无法保存盘点草稿：'+failure.message);return false;}
}
function controls(){
    const unavailable=busy||storageBroken;
    $('new-count').hidden=showEditor&&!state.pending;
    $('new-count').disabled=unavailable||!!state.pending;
    $('new-count').textContent=state.editing?'继续盘点草稿':'新建盘点';
    $('count-fields').disabled=unavailable||!!state.pending||!state.snapshot;
    $('back-counts').disabled=busy;
    $('refresh-count-history').disabled=busy;
    $('retry-count').disabled=unavailable;
    $('post-count').disabled=unavailable||!!state.pending||!review;
    $('count-pending').hidden=!state.pending;
    $('count-pending-summary').textContent=state.pending?`原库存版本 ${state.pending.body.expectedRevision} · ${state.pending.body.materials.length} 项 · 经办人 ${state.pending.body.operator} · ${state.pending.body.reason}`:'';
    $('count-editor').hidden=!showEditor||!!state.pending;
    $('count-list').hidden=showEditor&&!state.pending;
    $('count-receipt').hidden=!state.receipt;
    $('count-receipt-summary').textContent=state.receipt?`盘点单 ${state.receipt.id} · 已登记 ${state.receipt.lines.length} 项实测。可在下方记录查看原值和差异。`:'';
    $('count-review').hidden=!review;
    $('count-selection').textContent=`已选 ${state.observations.length} / 100 项`;
    $('count-snapshot').textContent=state.snapshot?`本次账面版本 ${state.snapshot.revision}${state.requiresRefresh?' · 已失效，请更新后重新核对':' · 不会自动替换本次测量依据'}`:'';
}
function renderPicker(){
    const query=$('count-search').value.trim().toLowerCase();
    const rows=(state.snapshot?.materials||[]).filter(item=>[item.id,item.materialModel,item.location].some(v=>v.toLowerCase().includes(query)));
    $('count-materials').innerHTML=rows.map(item=>{
        const selected=state.observations.some(o=>identity(o)===identity(item)),index=state.snapshot.materials.indexOf(item);
        return `<tr><td><input type="checkbox" data-pick="${index}" aria-label="选择 ${escape(item.id)}" ${selected?'checked':''} ${!item.allowed&&!selected?'disabled':''}></td><td>${escape(item.id)}<small>${typeName(item.type)} · ${escape(item.materialModel)||'未登记型号'}</small></td><td class="numeric">${item.width} × ${item.length}${item.status==='LOST'?'<small>历史几何；账面在库面积为 0</small>':''}</td><td>${escape(item.location)||'未登记'}<small>${escape(statusName(item.status))}</small></td><td>${item.allowed?'可盘点':escape(item.reason)}</td></tr>`;
    }).join('')||'<tr><td colspan="5">没有匹配的材料。</td></tr>';
}
function renderObservations(){
    $('count-observations').innerHTML=state.observations.map((observation,index)=>{
        const before=state.snapshot?.materials.find(item=>identity(item)===identity(observation));
        const lockedWidth=observation.type==='roll'||!observation.present;
        return `<article class="count-observation"><div class="count-observation-title"><h3>${escape(observation.id)} · ${typeName(observation.type)}</h3><button type="button" data-remove="${index}" aria-label="移除 ${escape(observation.id)}">移除</button></div><p class="scope-note">${before?`账面 ${before.width} × ${before.length} mm · ${escape(statusName(before.status))}`:'最新账面中已无此材料，请核查后移除。'}${before&&!before.allowed?' · '+escape(before.reason):''}</p><div class="count-measurements"><label>实物情况<select data-observation="${index}" data-field="present" id="count-present-${index}"><option value="true" ${observation.present?'selected':''}>在场</option><option value="false" ${!observation.present?'selected':''}>未见实物</option></select></label><label>实测幅宽 / mm<input type="number" id="count-width-${index}" data-observation="${index}" data-field="width" value="${escape(observation.width)}" min="0.000001" max="1000000000" step="any" required ${lockedWidth?'readonly':''}></label><label>${observation.type==='roll'?'未切余长':'实测长度'} / mm<input type="number" id="count-length-${index}" data-observation="${index}" data-field="length" value="${escape(observation.length)}" min="${observation.present?'0.000001':'0'}" max="1000000000" step="any" required ${observation.present?'':'readonly'}></label></div></article>`;
    }).join('');
}
function render(){
    $('count-reason').value=state.reason;$('count-operator').value=state.operator;
    renderPicker();renderObservations();controls();
}
async function request(path,init={}){
    const response=await fetch('/api/v2/inventory-counts'+path,{...init,signal:AbortSignal.timeout(20000)});
    let data;try{data=await response.json();}catch{throw Error('服务返回无法识别，提交结果仍待确认');}
    if(!response.ok){const failure=Error(data.message||`服务返回 ${response.status}`);failure.definitive=(response.status===400&&data.code==='INVALID_INPUT')||(response.status===409&&data.code==='INVENTORY_CONFLICT');throw failure;}
    return data;
}
function historyLines(doc){
    return `<div class="management-table-wrap"><table><thead><tr><th>材料</th><th>原账面 mm</th><th>实测 mm</th><th>面积差异 m²</th><th>状态变化</th></tr></thead><tbody>${doc.lines.map(line=>`<tr><td>${escape(line.id)}<small>${typeName(line.type)}</small></td><td class="numeric">${line.beforeWidth} × ${line.beforeLength}${line.beforeStatus==='LOST'?'<small>盘亏历史几何，在库面积为 0</small>':''}</td><td class="numeric">${line.measuredWidth} × ${line.measuredLength}${line.type==='roll'?`<small>已切 ${line.usedLength} mm 保留</small>`:''}</td><td class="numeric">${area(line.differenceAreaM2)}</td><td>${escape(statusName(line.beforeStatus))} → ${escape(statusName(line.afterStatus))}</td></tr>`).join('')}</tbody></table></div>`;
}
async function loadHistory(){
    $('refresh-count-history').disabled=true;
    try{
        const records=await request('');
        if(!Array.isArray(records)||records.some(doc=>!doc.id||!doc.command||!Array.isArray(doc.lines)))throw Error('盘点记录响应格式无效');
        $('count-history').innerHTML=records.length?records.map(doc=>`<details class="management-explanation" ${state.receipt?.id===doc.id?'open':''}><summary>${escape(new Date(doc.postedAt).toLocaleString())} · ${doc.lines.length} 项 · ${escape(doc.command.operator)} · 差异 ${area(doc.lines.reduce((sum,line)=>sum+line.differenceAreaM2,0))} m²</summary><p>单号 ${escape(doc.id)}</p><p>${escape(doc.command.reason)} · 账面版本 ${doc.command.expectedRevision} → ${doc.inventoryRevision}</p>${historyLines(doc)}</details>`).join(''):'尚无盘点单。新建盘点后在这里查看实测、差异与凭证。';
        $('count-message').textContent=`${records.length} 张已过账盘点单${state.editing?' · 本机有未完成草稿':''}`;
    }catch(failure){error('读取记录失败，已显示内容可能过期：'+failure.message);}
    finally{controls();}
}
async function begin(){
    if(busy||storageBroken||state.pending)return;
    if(state.editing){showEditor=true;render();return;}
    busy=true;controls();error('');
    try{
        const snapshot=validateSnapshot(await request('/options'));
        await navigator.locks.request(storageKey,()=>{
            if(!compareStored()||state.pending||state.editing)return;
            if(save({...emptyDraft(),operator:state.operator,editing:true,snapshot})){showEditor=true;review=null;render();}
        });
    }catch(failure){if(failure.storageFailure)failStorage(failure.message);else error('无法建立盘点：'+failure.message);}
    finally{busy=false;controls();}
}
async function updateSnapshot(){
    if(busy||storageBroken||state.pending)return;
    busy=true;controls();error('');
    try{
        const snapshot=validateSnapshot(await request('/options'));
        await navigator.locks.request(storageKey,()=>{
            if(!compareStored()||state.pending)return;
            if(save({...state,snapshot,requiresRefresh:false})){review=null;render();$('count-message').textContent='已更新账面，实测录入保持原样；请重新核对差异。';}
        });
    }catch(failure){if(failure.storageFailure)failStorage(failure.message);else error('更新账面失败，原快照和实测仍保留：'+failure.message);}
    finally{busy=false;controls();}
}
async function reviewDifferences(){
    if(busy||storageBroken||state.pending)return;
    try{await navigator.locks.request(storageKey,()=>{
        if(!compareStored()||state.pending)return;
        const command=commandFor(state),rows=differences(state.snapshot,command);review=fingerprint(command);
        $('count-review-summary').textContent=`${rows.length} 项 · 账面版本 ${command.expectedRevision} · 合计差异 ${area(rows.reduce((sum,row)=>sum+row.differenceAreaM2,0))} m² · 经办人 ${command.operator} · ${command.reason}`;
        $('count-differences').innerHTML=rows.map(({before,observation,differenceAreaM2,afterStatus})=>`<tr><td>${escape(before.id)}</td><td class="numeric">${before.width} × ${before.length}${before.status==='LOST'?'<small>盘亏历史几何，在库面积为 0</small>':''}</td><td class="numeric">${observation.width} × ${observation.length}<small>${observation.present?'在场':'未见实物'}</small></td><td class="numeric">${area(differenceAreaM2)}</td><td>${escape(statusName(afterStatus))}</td></tr>`).join('');
        error('');controls();$('count-review').focus();
    });}catch(failure){review=null;error(failure.message);controls();}
}
async function submit(retry=false){
    if(busy||storageBroken)return;
    busy=true;controls();error('');
    try{await navigator.locks.request(storageKey,{ifAvailable:true},async lock=>{
        if(!lock){error('另一页面正在保存或提交这份盘点，请稍后重新核对。');return;}
        if(!compareStored())return;
        if(retry&&!state.pending){error('当前没有待确认请求，请查看记录。');return;}
        if(!retry){
            if(state.pending)throw Error('已有待确认请求，请先确认原请求结果');
            const command=commandFor(state);
            if(!review||review!==fingerprint(command))throw Error('输入或账面已改变，请重新核对差异');
            if(!save({...state,pending:{key:crypto.randomUUID(),body:command}}))return;
        }
        // Recheck durable storage even for retries before issuing any network write.
        if(!save(state))return;
        const pending=structuredClone(state.pending);controls();
        try{
            const result=await request('',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});
            if(typeof result?.id!=='string'||!result.id||result.idempotencyKey!==pending.key||!Array.isArray(result.lines)||fingerprint(result.command)!==fingerprint(pending.body))throw Error('回执身份或正文不一致，保留原凭证');
            if(save({...emptyDraft(),operator:state.operator,receipt:result})){showEditor=false;review=null;render();$('count-message').textContent='盘点已过账，原始记录已保留。';}
        }catch(failure){
            if(failure.storageFailure){failStorage('服务可能已登记，但本机凭证未能保存：'+failure.message);}
            else if(failure.definitive){
                if(save({...state,pending:null,requiresRefresh:true})){showEditor=true;review=null;render();}
                error(failure.message+'；已保留实测，请更新账面后重新核对。');
            }else{error(failure.message+'；结果仍待确认，请使用原请求确认，不要另建重复单。');}
        }
    });}catch(failure){
        // Any storage failure here must leave the saved command recoverable, never dispatch a fresh identity.
        if(failure.storageFailure)failStorage('提交保护失败：'+failure.message);
        else error(failure.message);
    }finally{busy=false;controls();}
    await loadHistory();
}
window.addEventListener('storage',event=>{
    if(event.key!==storageKey&&event.key!==null)return;
    try{if(readCurrent()!==lastRaw){adopt(readCurrent());error('其他页面已更新草稿或提交凭证，已同步，请重新核对。');}}
    catch(failure){failStorage('无法读取跨页盘点凭证：'+failure.message);}
});
$('new-count').addEventListener('click',begin);
$('back-counts').addEventListener('click',()=>{showEditor=false;controls();});
$('refresh-count-history').addEventListener('click',loadHistory);
$('refresh-count-snapshot').addEventListener('click',updateSnapshot);
$('retry-count').addEventListener('click',()=>submit(true));
$('post-count').addEventListener('click',()=>submit(false));
$('count-form').addEventListener('submit',event=>{event.preventDefault();reviewDifferences();});
$('count-search').addEventListener('input',renderPicker);
for(const field of ['reason','operator'])$('count-'+field).addEventListener('input',event=>{const value=event.target.value;edit(next=>{next[field]=value;});});
$('count-materials').addEventListener('change',event=>{
    if(event.target.dataset.pick===undefined)return;
    const item=state.snapshot?.materials[Number(event.target.dataset.pick)],selected=event.target.checked;
    if(!item)return;
    edit(next=>{
        next.observations=next.observations.filter(o=>identity(o)!==identity(item));
        if(selected){if(next.observations.length>=100){error('每张盘点单最多选择 100 项材料');return;}next.observations.push(observationFor(item));}
    },true);
});
$('count-observations').addEventListener('click',event=>{
    if(event.target.dataset.remove===undefined)return;
    const item=state.observations[Number(event.target.dataset.remove)];
    if(item)edit(next=>{next.observations=next.observations.filter(o=>identity(o)!==identity(item));},true);
});
$('count-observations').addEventListener('input',event=>{
    const index=Number(event.target.dataset.observation),field=event.target.dataset.field,value=event.target.value;
    if(!['width','length'].includes(field))return;
    const item=state.observations[index];if(!item)return;
    edit(next=>{const current=next.observations.find(o=>identity(o)===identity(item));if(current)current[field]=value;});
});
$('count-observations').addEventListener('change',event=>{
    if(event.target.dataset.field!=='present')return;
    const item=state.observations[Number(event.target.dataset.observation)],present=event.target.value==='true';if(!item)return;
    edit(next=>{
        const current=next.observations.find(o=>identity(o)===identity(item));if(!current)return;
        current.present=present;
        if(!present){current.width=String(next.snapshot.materials.find(o=>identity(o)===identity(item))?.width??current.width);current.length='0';}
        else if(current.length==='0')current.length='';
    },true);
});
try{
    if(!navigator.locks)throw Error('浏览器不支持跨页提交保护');
    lastRaw=readCurrent();state=readDraft(lastRaw);showEditor=state.editing;
    // Probe persistence under the same cross-page lock before allowing a command.
    await navigator.locks.request(storageKey,()=>{if(compareStored())save(state);});
}catch(failure){failStorage('无法恢复盘点草稿：'+failure.message);}
render();loadHistory();
