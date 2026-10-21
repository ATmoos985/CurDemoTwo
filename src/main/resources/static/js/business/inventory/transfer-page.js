const $=id=>document.getElementById(id),storageKey='cutdemo.inventory-transfer.v1';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={destination:'',reason:'',operator:'',selected:[],pending:null},options=null,busy=false,storageBroken=false,lastStoredRaw=null;
const error=message=>{$('transfer-error').textContent=message;$('transfer-error').hidden=!message;};
try {
    const raw=localStorage.getItem(storageKey);lastStoredRaw=raw;
    if(raw){const parsed=JSON.parse(raw);if(!parsed||!Array.isArray(parsed.selected)||!['destination','reason','operator'].every(k=>typeof parsed[k]==='string')||parsed.pending&&(!parsed.pending.key||!parsed.pending.body))throw Error('草稿格式无效');state=parsed;}
}catch{storageBroken=true;error('无法读取本机移库草稿。请保留浏览器数据并核对历史单据，当前禁止提交。');}
function adopt(raw){
    state=raw?JSON.parse(raw):{destination:'',reason:'',operator:'',selected:[],pending:null};lastStoredRaw=raw;
    for(const key of ['destination','reason','operator'])$('transfer-'+key).value=state[key];
    renderMaterials();controls();
}
async function persist(){
    try{
        if(!navigator.locks)throw Error('浏览器不支持跨页提交保护');
        return await navigator.locks.request(storageKey,()=>{
            const raw=localStorage.getItem(storageKey);
            if(raw!==lastStoredRaw){adopt(raw);error('其他页面已更新移库草稿或提交凭证，已同步；请重新核对。');return false;}
            const next=JSON.stringify(state);localStorage.setItem(storageKey,next);lastStoredRaw=next;return true;
        });
    }catch{storageBroken=true;error('无法保存提交凭证，当前禁止发起新请求。请恢复浏览器存储后刷新。');return false;}
}
window.addEventListener('storage',event=>{
    if(event.key!==storageKey&&event.key!==null)return;
    try{adopt(localStorage.getItem(storageKey));error('其他页面已更新移库草稿或提交凭证，已同步；请重新核对。');}
    catch{storageBroken=true;error('跨页草稿读取失败，禁止新提交。');controls();}
});
function controls(){
    $('transfer-fields').disabled=busy||storageBroken||!!state.pending||!options;
    $('refresh-transfers').disabled=busy;
    $('retry-transfer').disabled=busy||storageBroken;
    $('transfer-pending').hidden=!state.pending;
    $('transfer-pending-summary').textContent=state.pending?JSON.stringify(state.pending.body,null,2):'';
    $('transfer-selection').textContent=`已选 ${state.selected.length} 项（最多 100 项）；目标库位：${state.destination||'待填写'}。提交前请核对材料和原库位。`;
}
async function request(path,init={}){
    const response=await fetch('/api/v2/inventory-transfers'+path,{...init,signal:AbortSignal.timeout(20000)});
    let data;try{data=await response.json();}catch{throw Error('服务返回无法识别，请保留凭证后重试');}
    if(!response.ok){const failure=Error(data.message||`服务返回 ${response.status}`);failure.definitive=[400,409].includes(response.status)&&['INVALID_INPUT','INVENTORY_CONFLICT'].includes(data.code);throw failure;}return data;
}
function renderMaterials(){
    const materials=options?.materials||[];
    $('transfer-materials').innerHTML=materials.map((item,index)=>`<tr><td><input type="checkbox" data-index="${index}" aria-label="选择 ${escape(item.id)}" ${state.selected.includes(item.type+'/'+item.id)?'checked':''} ${item.allowed?'':'disabled'}></td><td>${escape(item.id)}<small>${item.type==='roll'?'母卷':'料头'}</small></td><td>${escape(item.materialModel)}</td><td>${escape(item.location)||'未登记'}</td><td>${item.allowed?'可移库':escape(item.reason)}</td></tr>`).join('');
}
async function refresh(){
    busy=true;controls();
    try{
        const [next,history]=await Promise.all([request('/options'),request('')]);
        if(!Number.isSafeInteger(next.revision)||!Array.isArray(next.materials)||!Array.isArray(history))throw Error('响应契约无效');
        options=next;renderMaterials();
        $('transfer-history').innerHTML=history.length?history.map(doc=>`<details class="management-explanation"><summary>${escape(new Date(doc.postedAt).toLocaleString())} · ${escape(doc.command.destination)} · ${doc.lines.length} 项 · ${escape(doc.command.operator)}</summary><p>单号 ${escape(doc.id)} · ${escape(doc.command.reason)}</p><ul>${doc.lines.map(line=>`<li>${escape(line.id)}：${escape(line.fromLocation)||'未登记'} → ${escape(line.toLocation)}</li>`).join('')}</ul></details>`).join(''):'尚无移库单。';
        $('transfer-message').textContent=`库存版本 ${next.revision} · ${next.materials.length} 项材料 · ${history.length} 张移库单`;
    }catch(failure){options=null;error('读取失败，禁止提交；已显示内容可能过期。'+failure.message);}
    finally{busy=false;controls();}
}
async function submitPending(){
    if(busy||storageBroken||!state.pending)return;
    const submitted=state.pending;
    busy=true;error('');controls();
    try{
        const result=await request('',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':submitted.key},body:JSON.stringify(submitted.body)});
        if(!result.id||result.idempotencyKey!==submitted.key)throw Error('返回单据身份不符');
        if(state.pending?.key!==submitted.key){error('原请求已登记，其他页面已更新草稿；当前凭证已保留。');return;}
        const previous=state;state={destination:'',reason:'',operator:state.operator,selected:[],pending:null};
        if(!await persist()){if(storageBroken)state=previous;throw Error('移库已登记，但本机凭证未清理。请核对当前待确认请求。');}
        for(const key of ['destination','reason','operator'])$('transfer-'+key).value=state[key];
        $('transfer-message').textContent='已登记移库单 '+result.id;
    }catch(failure){
        if(failure.definitive&&state.pending?.key===submitted.key){const previous=state.pending;state.pending=null;if(!await persist()&&storageBroken)state.pending=previous;options=null;}
        error(failure.message+(state.pending?'；请使用“确认上次提交结果”，不要另建重复单。':'；请刷新库存并重新核对后提交。'));
    }finally{busy=false;controls();}
    if(!state.pending&&!storageBroken)await refresh();
}
for(const key of ['destination','reason','operator']){
    $('transfer-'+key).value=state[key];
    $('transfer-'+key).addEventListener('input',async event=>{state[key]=event.target.value;await persist();controls();});
}
$('transfer-materials').addEventListener('change',async event=>{
    const index=event.target.dataset.index;if(index===undefined||!options)return;
    const item=options.materials[Number(index)],identity=item.type+'/'+item.id;
    state.selected=state.selected.filter(id=>id!==identity);if(event.target.checked)state.selected.push(identity);
    await persist();controls();
});
$('transfer-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||storageBroken||!options||state.pending)return;
    const selected=options.materials.filter(item=>state.selected.includes(item.type+'/'+item.id));
    if(!selected.length||selected.length>100||selected.length!==state.selected.length||selected.some(item=>!item.allowed||item.location===state.destination)){error('请选择 1–100 项可移库材料，目标库位不能与原库位相同；失效选择请重新核对。');return;}
    state.pending={key:crypto.randomUUID(),body:{expectedRevision:options.revision,destination:state.destination,reason:state.reason,operator:state.operator,materials:selected.map(({type,id})=>({type,id}))}};
    controls();if(await persist())submitPending();else controls();
});
$('retry-transfer').addEventListener('click',submitPending);
$('clear-transfer-selection').addEventListener('click',async()=>{state.selected=[];await persist();renderMaterials();controls();});
$('refresh-transfers').addEventListener('click',()=>{if(!storageBroken)error('');refresh();});
controls();refresh();
