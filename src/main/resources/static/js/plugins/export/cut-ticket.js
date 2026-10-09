import {state} from '../../core/state.js';
import {requestJSON} from '../../core/api-request.js';
import {showToast} from '../../core/toast.js';
import {canUseCurrentPlan} from '../solver/solver-client.js';
import {ticketModel, ticketHTML} from './cut-ticket-model.js';

let selected=null, opening=0;
const currentMatches=id=>canUseCurrentPlan() && state.pendingPlan.result.planId===id;
function showTicket(saved,historical) {
    const model=ticketModel(saved,historical);let dialog=document.getElementById('cam-cut-ticket-modal');
    if(!dialog){dialog=document.createElement('dialog');dialog.id='cam-cut-ticket-modal';dialog.className='workflow-dialog ticket-dialog';dialog.setAttribute('aria-labelledby','ticket-preview-title');
        dialog.innerHTML='<div class="dialog-heading"><h2 id="ticket-preview-title">打印工单预览</h2><button class="tool-btn" data-close>关闭</button></div><div class="ticket-scroll"><article id="printable-cut-ticket-area"></article></div><div class="dialog-actions"><span role="status" id="ticket-error"></span><button class="tool-btn active" data-print>打印 / 保存 PDF</button></div>';
        dialog.querySelector('[data-close]').onclick=closeCutTicketModal;dialog.querySelector('[data-print]').onclick=printCutTicketDocument;dialog.addEventListener('close',()=>{if(selected){selected=null;opening++;}});document.body.append(dialog);}
    document.getElementById('printable-cut-ticket-area').innerHTML=ticketHTML(model);
    document.getElementById('ticket-error').textContent='';
    selected={saved,historical};if(!dialog.open)dialog.showModal();
}
export async function openCutTicketModal({planId,historical=false}={}) {
    if (!planId && !state.pendingPlan) {
        planId = [...(state.taskReports || [])].reverse().find(r => r.status !== 'REVERSED')?.planId;
        historical = true;
    }
    const id=planId || state.pendingPlan?.result?.planId;
    if(!id || (!historical && !currentMatches(id)))return showToast('请先生成方案或校验调整版；历史工单可从方案或报工记录查看。','warning');
    const sequence=++opening;
    try {
        const saved=await requestJSON('/api/cutting/plans/'+encodeURIComponent(id));
        if(sequence!==opening)return;
        if(!historical && (!currentMatches(id) || saved.status!=='PENDING'))throw new Error('方案或报工状态已变化，请重新核对，历史记录可从报工列表查看。');
        showTicket(saved,historical);
    }catch(error){showToast(error.message,'error');}
}
export function closeCutTicketModal(){opening++;document.getElementById('cam-cut-ticket-modal')?.close();selected=null;}
export async function printCutTicketDocument() {
    if(!selected)return;
    const snapshot=selected,id=snapshot.saved.result.planId,button=document.querySelector('#cam-cut-ticket-modal [data-print]');button.disabled=true;
    try {
        if(!snapshot.historical && !currentMatches(id))throw new Error('当前方案已修改，请关闭并校验调整版后重新打开工单。');
        const saved=await requestJSON('/api/cutting/plans/'+encodeURIComponent(id));
        if(selected!==snapshot)return;
        if(JSON.stringify(saved)!==JSON.stringify(snapshot.saved)){showTicket(saved,true);throw new Error('记录状态已更新，请核对更新后的工单，再点击打印。');}
        const frame=document.createElement('iframe');frame.id='pure-print-iframe';frame.className='ticket-print-frame';document.body.append(frame);
        frame.onload=()=>{frame.contentWindow.addEventListener('afterprint',()=>frame.remove(),{once:true});frame.contentWindow.focus();frame.contentWindow.print();};
        const doc=frame.contentDocument;doc.open();doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>裁切工单</title><link rel="stylesheet" href="${location.origin}/css/cut-ticket.css"></head><body><article id="printable-cut-ticket-area">${ticketHTML(ticketModel(saved,snapshot.historical))}</article></body></html>`);doc.close();
    }catch(error){const target=document.getElementById('ticket-error');if(target)target.textContent=error.message;}
    finally {button.disabled=false;}
}
