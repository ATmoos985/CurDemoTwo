/** Inventory observations belong to the business UI; dimensions are mm, areas m². */
export const identity = item => `${item.type}/${item.id}`;
export const emptyDraft = () => ({editing:false,snapshot:null,observations:[],reason:'',operator:'',pending:null,requiresRefresh:false,receipt:null});
const size = (value,positive=false) => typeof value==='number' && Number.isFinite(value) && value<=(1e9) && (positive?value>0:value>=0);
const material = value => value && ['roll','remnant'].includes(value.type) && typeof value.id==='string' && value.id.length>0;
export function validateSnapshot(value){
    if(!value || !Number.isSafeInteger(value.revision) || value.revision<0 || !Array.isArray(value.materials))throw Error('账面响应无效，不能建立盘点快照');
    const ids=new Set();
    for(const item of value.materials){
        if(!material(item)||!size(item.width,true)||!size(item.length)||typeof item.allowed!=='boolean'||!['status','location','materialModel','reason'].every(k=>typeof item[k]==='string')||ids.has(identity(item)))throw Error('账面材料身份或尺寸无效');
        ids.add(identity(item));
    }
    return value;
}
export function observationFor(item){return {type:item.type,id:item.id,present:item.status!=='LOST',width:String(item.width),length:item.status==='LOST'?'0':String(item.length)};}
export function commandFor(draft){
    const snapshot=validateSnapshot(draft.snapshot);
    if(draft.requiresRefresh)throw Error('请先更新账面，并重新核对实测差异');
    if(typeof draft.reason!=='string'||!draft.reason.trim()||draft.reason.length>500||typeof draft.operator!=='string'||!draft.operator.trim()||draft.operator.length>100)throw Error('请填写盘点原因（最多 500 字）和经办人（最多 100 字）');
    if(!Array.isArray(draft.observations)||draft.observations.length<1||draft.observations.length>100)throw Error('请选择 1–100 项材料');
    const seen=new Set(), materials=draft.observations.map(observation=>{
        const id=identity(observation), item=snapshot.materials.find(i=>identity(i)===id);
        if(!item || seen.has(id))throw Error('材料已不存在或重复，请更新账面并重新选择');
        seen.add(id);
        if(!item.allowed)throw Error(`${item.id}：${item.reason||'当前不可盘点'}`);
        const width=Number(observation.width),length=Number(observation.length);
        if(typeof observation.present!=='boolean'||String(observation.width).trim()===''||String(observation.length).trim()===''||!size(width,true)||!size(length)|| (observation.present?length<=0:length!==0))throw Error(`${item.id}：在场长度须大于 0，未见实物长度为 0，尺寸最多 10 亿 mm`);
        if((item.type==='roll'||!observation.present)&&width!==item.width)throw Error(`${item.id}：母卷或未见实物须保留账面幅宽，请重新核对`);
        return {type:item.type,id:item.id,present:observation.present,width,length};
    });
    return {expectedRevision:snapshot.revision,reason:draft.reason,operator:draft.operator,materials};
}
export function differences(snapshot,command){
    return command.materials.map(observation=>{
        const before=snapshot.materials.find(item=>identity(item)===identity(observation));
        if(!before)throw Error('缺少原账面材料');
        const oldArea=before.type==='remnant'&&before.status==='LOST'?0:before.width*before.length/1e6;
        const area=observation.present?observation.width*observation.length/1e6:0;
        return {before,observation,differenceAreaM2:area-oldArea,afterStatus:before.type==='roll'?before.status:!observation.present?'LOST':before.status==='LOST'?'QUARANTINED':before.status};
    });
}
export function fingerprint(value){
    if(Array.isArray(value))return '['+value.map(fingerprint).join(',')+']';
    if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+fingerprint(value[key])).join(',')+'}';
    return JSON.stringify(value);
}
export function readDraft(raw){
    if(raw===null)return emptyDraft();
    const value=JSON.parse(raw);
    if(!value||typeof value.editing!=='boolean'||typeof value.requiresRefresh!=='boolean'||typeof value.reason!=='string'||typeof value.operator!=='string'||!Array.isArray(value.observations)||value.observations.length>100)throw Error('盘点草稿格式无效');
    if(value.snapshot)validateSnapshot(value.snapshot);
    if(value.editing&&!value.snapshot)throw Error('盘点草稿缺少账面快照');
    const ids=new Set();
    for(const item of value.observations){
        if(!material(item)||typeof item.present!=='boolean'||typeof item.width!=='string'||typeof item.length!=='string'||ids.has(identity(item)))throw Error('盘点实测草稿格式无效');
        ids.add(identity(item));
    }
    if(value.pending){
        if(typeof value.pending.key!=='string'||! /^[A-Za-z0-9._:-]{8,128}$/.test(value.pending.key)||fingerprint(value.pending.body)!==fingerprint(commandFor(value)))throw Error('待确认盘点凭证与草稿不一致');
    }
    if(value.receipt!==null && (!value.receipt || typeof value.receipt.id!=='string'||!Array.isArray(value.receipt.lines)))throw Error('盘点回执格式无效');
    return value;
}
