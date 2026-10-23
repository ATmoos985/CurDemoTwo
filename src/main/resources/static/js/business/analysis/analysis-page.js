import {requestJSON} from '../../core/api-request.js';
import {reportTotals,csvCell} from './report-model.js';
const el=id=>document.getElementById(id),number=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:4}):'未知';
const jsonValue=value=>{try{return value?JSON.parse(value):null;}catch{return value;}};
const cell=(parent,value)=>{const node=document.createElement('td');node.textContent=value;parent.append(node);return node;};
let analysisGeneration=0,ledgerGeneration=0,cursor=0,entries=[],filter={},busy=false;
async function refreshAnalysis(){
 const request=++analysisGeneration;el('refresh-analysis').disabled=true;el('analysis-error').hidden=true;
 try{
  const result=await requestJSON('/api/v2/inventory-ledger/reconciliation');if(request!==analysisGeneration)return;
  el('analysis-status').textContent=({BALANCED:'对账平衡',MISMATCH:'对账发现差异',NOT_INITIALIZED:'尚未建立迁移期初'}[result.status] || '状态未知')+' · 库存版本 '+result.revision;
  el('actual-metrics').replaceChildren();const totals=reportTotals(result);
  if(totals)for(const [label,value]of[['实际良品产出率',totals.goodRate==null?'—':number(totals.goodRate*100)+'%'],['可回收率',totals.recoveryRate==null?'—':number(totals.recoveryRate*100)+'%'],['累计加工投入',number(totals.consumed)+' m²'],['有效报工',totals.count+' 单']]){
   const article=document.createElement('article'),title=document.createElement('span'),strong=document.createElement('strong');title.textContent=label;strong.textContent=value;article.append(title,strong);el('actual-metrics').append(article);
  }else el('actual-metrics').textContent='当前没有可可靠汇总的报工面积；不显示零值或估算利用率。';
  el('analysis-issues').replaceChildren();
  for(const issue of result.issues || []){const p=document.createElement('p');p.textContent='异常 '+issue.code+' · '+(issue.aggregate || issue.reportId || issue.entryId || '全局');el('analysis-issues').append(p);}
  el('area-rows').replaceChildren();
  for(const row of result.areas || []){const tr=document.createElement('tr');cell(tr,row.reportId);for(const key of ['consumed','qualified','recovered','rejected','otherWasteAndLoss'])cell(tr,number(row[key]));el('area-rows').append(tr);}
 }catch(error){if(request===analysisGeneration){el('analysis-error').textContent='读取失败：'+error.message+' 上次结果可能已过期，请刷新。';el('analysis-error').hidden=false;}}
 finally{if(request===analysisGeneration)el('refresh-analysis').disabled=false;}
}
const eventNames={INVENTORY_TRANSFER:'材料移库',INVENTORY_COUNT:'库存盘点',MIGRATION_OPENING:'迁移期初',CUT_REPORT:'实切报工',CUT_REPORT_BATCH:'批量报工',REPORT_REVERSE:'报工冲销',QUALITY_DISPOSITION:'复检处置',DEMAND_ADJUSTMENT:'需求调整',ROLL_RECEIPT:'母卷入库',ROLL_RECEIPT_OR_UPDATE:'母卷入库或维护',REMNANT_RECEIPT:'料头入库',REMNANT_SCRAP:'料头报废',INSPECTION:'检验记录',SYSTEM_UPDATE:'系统更新',DEMO_RECEIPT:'示例入库',DEMO_RESET:'示例重置'};
async function loadLedger(reset=false){
 if(busy && !reset)return;
 const request=++ledgerGeneration;busy=true;el('load-ledger').disabled=true;el('ledger-error').hidden=true;
 if(reset){cursor=0;entries=[];filter={aggregateType:el('ledger-type').value,aggregateId:el('ledger-id').value.trim()};el('ledger-rows').replaceChildren();el('export-ledger').disabled=true;el('load-ledger').hidden=true;}
 const params=new URLSearchParams({after:cursor,limit:50});for(const [key,value]of Object.entries(filter))if(value)params.set(key,value);
 try{
  const result=await requestJSON('/api/v2/inventory-ledger?'+params);if(request!==ledgerGeneration)return;
  entries.push(...result.items);cursor=result.nextCursor;
  for(const row of result.items){const tr=document.createElement('tr');cell(tr,row.sequence+' / '+new Date(row.occurredAt).toLocaleString('zh-CN',{hour12:false}));cell(tr,eventNames[row.eventType] || row.eventType);cell(tr,row.aggregateType+' / '+row.aggregateId);cell(tr,row.businessId+' / '+(row.sourceReportIds || []).join(', '));
   const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='查看前后值';pre.textContent=JSON.stringify({before:jsonValue(row.beforeJson),after:jsonValue(row.afterJson),actor:row.actor,reverses:row.reverses},null,2);detail.append(summary,pre);const td=document.createElement('td');td.append(detail);tr.append(td);el('ledger-rows').append(tr);
  }
  el('ledger-status').textContent='已载入 '+entries.length+' 条 · 本页库存版本 '+result.revision;el('load-ledger').hidden=!result.hasMore;el('load-ledger').textContent='加载下一页';el('export-ledger').disabled=!entries.length;
 }catch(error){if(request===ledgerGeneration){el('ledger-error').textContent='流水读取失败：'+error.message;el('ledger-error').hidden=false;el('load-ledger').hidden=false;el('load-ledger').textContent='重试读取';}}
 finally{if(request===ledgerGeneration){busy=false;el('load-ledger').disabled=false;}}
}
el('refresh-analysis').onclick=refreshAnalysis;el('ledger-filters').onsubmit=event=>{event.preventDefault();loadLedger(true);};el('load-ledger').onclick=()=>loadLedger();
el('export-ledger').onclick=()=>{const keys=['sequence','id','eventType','aggregateType','aggregateId','businessId','occurredAt','beforeVersion','afterVersion','beforeJson','afterJson'];const text=[keys,...entries.map(row=>keys.map(key=>row[key]))].map(row=>row.map(csvCell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff'+text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='已载入库存流水.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
await Promise.all([refreshAnalysis(),loadLedger(true)]);
