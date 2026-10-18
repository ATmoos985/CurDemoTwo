import {requestJSON} from '../core/api-request.js';
import {showToast} from '../core/toast.js';
import {round,clamp,validateDefect,advance} from './inspection-model.js';
import {mountInspectionCanvas} from './inspection-canvas.js';

const el=id=>document.getElementById(id),form=el('defect-editor'),field=name=>form.elements.namedItem(name);
let roll=null,pending=[],selected=null,position=0,running=false,busy=false,mode='mark',undo=[],frame=0,lastTime=0,lastPersist=0,loadToken=0;
let editorDirty=false,storageFailed=false,lastDraw=0;
const key=d=>d.captureId || 'saved-'+d.id;
const current=()=>pending.find(d=>key(d)===selected) || roll?.defects?.find(d=>key(d)===selected);
const draftKey=id=>'fabric-inspection:'+id;
const fmt=n=>Number(n).toLocaleString('zh-CN',{maximumFractionDigits:1});
const canvas=mountInspectionCanvas(el('inspection-canvas'),{
    onMark:d=>{if(busy)return;try{const margin=field('margin').valueAsNumber;validateDefect({...d,margin},roll);checkpoint();const created={...d,...attributes(),margin,captureId:crypto.randomUUID()};pending.push(created);selected=key(created);update();}catch(e){error(e);}},
    onSelect:id=>select(id),
    onEdit:(id,d)=>{if(busy)return;try{validateDefect(d,roll);checkpoint();pending=pending.map(p=>key(p)===id?d:p);selected=id;update();}catch(e){error(e);}},
    onBrowse:()=>stop('浏览 / 调整中 · 自动滚动已暂停'),
    onPointer:p=>{if(!roll)return;el('pointer-status').textContent=p.x>=0&&p.x<=roll.width&&p.y>=0&&p.y<=roll.totalLength?`距右边缘 ${fmt(roll.width-p.x)} mm · 距卷头 ${fmt(p.y)} mm`:'基准：右边缘 / 卷头 · 单位 mm';},
    onView:text=>el('view-status').textContent=text,
    onSize:text=>{el('gesture-size').textContent=text;el('gesture-size').hidden=!text;}
});
function attributes(){return {defectType:field('defectType').value||'MANUAL_MARK',typeName:field('defectType').selectedOptions[0]?.textContent||'其他疵点',detectionSource:'MANUAL_INSPECT',avoidanceStrategy:'MUST_AVOID',description:'跑布验疵人工标记'};}
function error(e){el('editor-error').textContent=e.message;}
function persist(){
    if(!roll)return;
    try{localStorage.setItem(draftKey(roll.rollId),JSON.stringify({width:roll.width,totalLength:roll.totalLength,pending,position,selected,
        speed:el('feed-speed').value,step:el('feed-step').value,editor:editorDirty?Object.fromEntries(new FormData(form)):null}));localStorage.setItem('fabric-inspection-current',roll.rollId);storageFailed=false;}
    catch{storageFailed=true;}
    el('draft-status').textContent=storageFailed?'本机存储不可用，请及时保存到母卷':pending.length?`本机已保留 · ${pending.length} 处待保存`:'已与母卷档案同步';
}
function checkpoint(){undo.push(structuredClone(pending));if(undo.length>50)undo.shift();}
function fillEditor(){
    const d=current(),saved=d&&!pending.some(p=>key(p)===selected);
    el('editor-title').textContent=d?(saved?`已入档 #${d.id}`:'调整本次标记'):'快速标记 / 精确录入';
    for(const input of form.querySelectorAll('input,select'))input.disabled=!!saved||busy;
    if(d){field('right').value=round(roll.width-d.x-d.w);for(const name of ['y','w','h','margin','defectType'])field(name).value=d[name];}
    el('apply-mark').disabled=!!saved||!roll||busy;el('apply-mark').textContent=d?'应用调整':'添加到本次记录';
    el('delete-mark').hidden=!d||saved;el('delete-mark').disabled=busy;editorDirty=false;
    el('editor-note').hidden=!saved;el('editor-error').textContent='';
}
function renderList(){
    const host=el('defect-list');host.replaceChildren();
    const rows=[...pending.map(d=>({...d,saved:false})),...(roll?.defects||[]).map(d=>({...d,saved:true}))].sort((a,b)=>b.y-a.y);
    for(const d of rows){const btn=document.createElement('button');btn.type='button';btn.dataset.defectKey=key(d);btn.classList.toggle('selected',key(d)===selected);
        const title=document.createElement('span');title.className='defect-row-title';
        const name=document.createElement('span');name.textContent=d.typeName||'疵点';const phase=document.createElement('span');phase.className='defect-phase'+(d.saved?' saved':'');phase.textContent=d.saved?`已入档 #${d.id}`:'待保存';title.append(name,phase);
        const meta=document.createElement('span');meta.className='defect-row-meta';meta.textContent=`卷头 ${fmt(d.y)} · 距右 ${fmt(roll.width-d.x-d.w)} mm\n${fmt(d.w)} × ${fmt(d.h)} mm`;
        btn.append(title,meta);btn.onclick=()=>select(key(d),true);host.append(btn);}
    if(!rows.length){const p=document.createElement('p');p.className='hint';p.textContent='暂无记录，按住左键拖出第一处疵点。';host.append(p);}
    el('saved-count').textContent=roll?.defects?.length||0;el('pending-count').textContent=pending.length;el('defect-count').textContent=rows.length+' 处';
}
function update({editor=true}={}){
    el('canvas-empty').hidden=!!roll;el('roll-summary').textContent=roll?`${roll.rollModel||''} · 幅宽 ${fmt(roll.width)} mm · 全长 ${fmt(roll.totalLength/1000)} m`:'先选择已有母卷，或登记一卷新布';
    el('feed-position').value=(position/1000).toFixed(4);el('save-inspection').disabled=!pending.length||busy;el('save-inspection').textContent=busy?'正在保存…':`保存到母卷${pending.length?' · '+pending.length+' 处':''}`;
    el('undo-mark').disabled=!undo.length||busy;el('tool-mark').setAttribute('aria-pressed',mode==='mark');el('tool-select').setAttribute('aria-pressed',mode==='select');
    el('inspection-canvas').style.cursor=mode==='mark'?'crosshair':'default';
    for(const id of ['inspection-roll','new-roll','feed-next','feed-toggle','set-position','new-mark'])el(id).disabled=busy;
    canvas.set({roll,pending,position,selected,mode:busy?'locked':mode});renderList();if(editor)fillEditor();persist();
}
function select(id,locate=false){selected=id;mode='select';update();if(locate&&current())canvas.locate(current());}
function editorDefect(){
    const values=Object.fromEntries(['right','y','w','h','margin'].map(n=>[n,field(n).valueAsNumber]));
    return validateDefect({...attributes(),x:round(roll.width-values.right-values.w),y:values.y,w:values.w,h:values.h,margin:values.margin},roll);
}
function applyEditor(){
    if(!roll||busy)return false;
    try{if(!form.reportValidity())return false;const d=editorDefect(),old=pending.find(p=>key(p)===selected);checkpoint();
        if(old){pending=pending.map(p=>p===old?{...old,...d}:p);}else{d.captureId=crypto.randomUUID();pending.push(d);selected=key(d);}
        editorDirty=false;update();return true;
    }catch(e){error(e);return false;}
}
form.onsubmit=event=>{event.preventDefault();if(applyEditor())canvas.locate(current());};
form.addEventListener('input',()=>{editorDirty=true;persist();});
form.addEventListener('change',()=>{if(pending.some(p=>key(p)===selected))applyEditor();});
el('new-mark').onclick=()=>{selected=null;field('right').value=0;field('y').value=round(position);update();};
el('delete-mark').onclick=()=>{checkpoint();pending=pending.filter(d=>key(d)!==selected);selected=null;update();};
el('undo-mark').onclick=()=>{if(!undo.length||busy)return;pending=undo.pop();selected=null;update();};
el('tool-mark').onclick=()=>{mode='mark';canvas.cancel();update({editor:false});};
el('tool-select').onclick=()=>{mode='select';canvas.cancel();update({editor:false});};
function stop(message='已暂停 · 可手动校准累计长度'){
    running=false;cancelAnimationFrame(frame);lastTime=0;el('feed-toggle').textContent='▶ 开始自动跑布';el('feed-toggle').setAttribute('aria-pressed','false');el('feed-speed').disabled=false;el('feed-status').textContent=message;persist();
}
function tick(now){
    if(!running)return;
    if(lastTime)position=advance(position,Number(el('feed-speed').value),(now-lastTime)/1000,roll.totalLength);
    lastTime=now;if(now-lastDraw>32){canvas.set({position});el('feed-position').value=(position/1000).toFixed(4);lastDraw=now;}
    if(now-lastPersist>1000){persist();lastPersist=now;}
    if(position>=roll.totalLength){stop('已到卷尾 · 请复核并保存疵点');return;}frame=requestAnimationFrame(tick);
}
el('feed-toggle').onclick=()=>{
    if(running){stop();return;}if(!roll){showToast('请先选择母卷。','info');return;}
    const speed=Number(el('feed-speed').value);if(!Number.isFinite(speed)||speed<.1||speed>100){showToast('速度请输入 0.1–100 m/min。','error');return;}
    if(position>=roll.totalLength){showToast('已到卷尾，重新校准位置后可继续。','info');return;}
    canvas.follow();running=true;lastTime=0;el('feed-speed').disabled=true;el('feed-toggle').textContent='Ⅱ 暂停跑布';el('feed-toggle').setAttribute('aria-pressed','true');el('feed-status').textContent=`自动 · ${speed} m/min · 按速度估算`;frame=requestAnimationFrame(tick);
};
function moveTo(next){if(!roll)return;if(!Number.isFinite(next)||next<0||next>roll.totalLength){showToast('累计位置须在卷头和卷尾之间。','error');return;}stop();position=round(next);canvas.follow();update({editor:false});}
el('set-position').onclick=()=>moveTo(Number(el('feed-position').value)*1000);
el('feed-position').onfocus=()=>{if(running)stop('校准中 · 自动滚动已暂停');};
el('feed-position').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();el('set-position').click();}};
el('feed-next').onclick=()=>{const step=Number(el('feed-step').value);if(!Number.isFinite(step)||step<=0||step>100){showToast('前进长度请输入 0–100 m 之间的正数。','error');return;}if(roll)moveTo(Math.min(roll.totalLength,position+step*1000));};
el('follow-feed').onclick=()=>canvas.follow();el('view-all').onclick=()=>canvas.overview();
el('toggle-panel').onclick=()=>{const hidden=document.querySelector('.inspection-layout').classList.toggle('panel-hidden');el('toggle-panel').setAttribute('aria-expanded',!hidden);};
if(innerWidth<800){document.querySelector('.inspection-layout').classList.add('panel-hidden');el('toggle-panel').setAttribute('aria-expanded','false');}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stop('页面已离开 · 自动跑布暂停，请按现场读数校准');});
window.addEventListener('keydown',event=>{if(event.key==='Escape')canvas.cancel();if((event.ctrlKey||event.metaKey)&&event.key==='z'&&!event.target.matches('input,textarea,select')){event.preventDefault();el('undo-mark').click();}});
window.addEventListener('beforeunload',event=>{persist();if(pending.length||editorDirty){event.preventDefault();event.returnValue='';}});

async function loadRoll(id){
    stop();persist();const token=++loadToken;busy=true;update({editor:false});
    try{
        const next=await requestJSON('/api/rolls/'+encodeURIComponent(id));if(token!==loadToken)return;
        let draft=null;try{draft=JSON.parse(localStorage.getItem(draftKey(id))||'null');}catch{showToast('本机记录无法读取，请保留浏览器数据并联系维护人员。','error');}
        if(draft&&(draft.width!==next.width||draft.totalLength!==next.totalLength))throw new Error('本机草稿尺寸与母卷不一致，已保留草稿，请核对材料。');
        const restored=(draft?.pending||[]).filter(d=>{
            const saved=next.defects.find(s=>s.captureId&&s.captureId===d.captureId);
            if(saved&&['x','y','w','h','margin','defectType'].some(k=>saved[k]!==d[k]))throw new Error('已入档疵点与本机记录不一致，请保留草稿并核对');
            return !saved;
        });
        restored.forEach(d=>validateDefect(d,next));roll=next;pending=restored;position=clamp(draft?.position||0,0,roll.totalLength);selected=null;undo=[];
        el('inspection-roll').value=id;el('feed-speed').value=draft?.speed||3;el('feed-step').value=draft?.step||1;
        busy=false;update();canvas.follow();
        if(draft?.editor){for(const [name,value] of Object.entries(draft.editor))if(field(name))field(name).value=value;editorDirty=true;persist();}
        el('save-error').textContent='';
    }catch(e){el('save-error').textContent=e.message;el('inspection-roll').value=roll?.rollId||'';}
    finally{busy=false;update({editor:false});}
}
el('inspection-roll').onchange=()=>{if(el('inspection-roll').value)loadRoll(el('inspection-roll').value);};
async function refreshRolls(){
    const rolls=await requestJSON('/api/rolls');el('inspection-roll').replaceChildren(new Option('选择母卷开始验布',''));
    for(const r of rolls)el('inspection-roll').add(new Option(`${r.rollId} · ${r.rollModel||''}`,r.rollId));
    return rolls;
}
el('save-inspection').onclick=async()=>{
    if(busy||!pending.length)return;if(editorDirty&&!applyEditor())return;
    stop();canvas.cancel();busy=true;update({editor:false});el('save-error').textContent='';
    try{roll=await requestJSON('/api/rolls/'+encodeURIComponent(roll.rollId)+'/inspection-defects',{width:roll.width,totalLength:roll.totalLength,defects:pending});pending=[];undo=[];selected=null;showToast('本次疵点已保存到母卷，裁切作业可直接读取。','success');}
    catch(e){el('save-error').textContent=e.message+' 本次记录已保留，可重试保存。';}
    finally{busy=false;update();}
};
const newForm=el('new-roll-form'),newDialog=el('new-roll-dialog');
el('new-roll').onclick=()=>{stop();newForm.reset();el('new-roll-error').textContent='';newDialog.showModal();newForm.elements.rollId.focus();};
newDialog.querySelector('[data-close]').onclick=()=>{if(!busy)newDialog.close();};
newDialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
newForm.onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;for(const c of newForm.elements)c.disabled=true;
    try{const v=newForm.elements;const id=v.rollId.value.trim();if(!id)throw new Error('请输入母卷编号。');
        const r=await requestJSON('/api/inspection/rolls',{rollId:id,rollModel:v.rollModel.value.trim(),width:Number(v.width.value),totalLength:round(Number(v.namedItem('length').value)*1000)});
        newDialog.close();await refreshRolls();busy=false;await loadRoll(r.rollId);
    }catch(e){el('new-roll-error').textContent=e.message;}
    finally{busy=false;for(const c of newForm.elements)c.disabled=false;}
};
try{const rolls=await refreshRolls();const id=new URLSearchParams(location.search).get('roll')||localStorage.getItem('fabric-inspection-current');if(id&&rolls.some(r=>r.rollId===id))await loadRoll(id);else update();}
catch(e){el('save-error').textContent=e.message+' 请刷新页面重试。';}
