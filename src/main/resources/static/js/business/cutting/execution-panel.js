import {state} from '../../core/state.js';
import {requestJSON} from '../../core/api-request.js';
import {executionForPlan,executionLabels,executionWriter} from './execution-client.js';
import {escapeText,refreshTaskProgress,mountSavedPlan} from './task-workspace.js';
import {canUseCurrentPlan,openCutReport,updateWorkflowControls} from './solver-client.js';
import {queuedReports} from './report-queue.js';
import {showToast} from '../../core/toast.js';
import {renderScene} from '../../plugins/cad/cad-renderer.js';

export const currentExecution=()=>executionForPlan(state.taskExecutions,state.pendingPlan?.result?.planId);
let generation=0;
export async function openTaskExecutions() {
    if(!state.activeTask)return showToast('请先保存或打开任务','info');
    let dialog=document.getElementById('execution-dialog');
    if(!dialog) {
        dialog=document.createElement('dialog');dialog.id='execution-dialog';dialog.className='action-dialog workbench-dialog';
        dialog.setAttribute('aria-labelledby','execution-title');document.body.append(dialog);
        dialog.addEventListener('keydown',event=>event.stopPropagation());
        dialog.addEventListener('close',()=>generation++);
    }
    const taskId=state.activeTask.id, ticket=++generation;
    const isCurrent=()=>ticket===generation && taskId===state.activeTask?.id && dialog.open;
    dialog.innerHTML='<div class="workbench-dialog-heading"><h2 id="execution-title">执行与预约</h2><button class="tool-btn" data-close>关闭</button></div><div class="workbench-dialog-body"><p role="status">正在读取执行记录…</p></div>';
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    if(!dialog.open)dialog.showModal();
    try {
        await refreshTaskProgress();
        if(ticket!==generation || taskId!==state.activeTask?.id || !dialog.open)return;
        const writer=executionWriter(), unresolved=writer.pending(taskId), pending=state.pendingPlan, view=currentExecution();
        const body=dialog.querySelector('.workbench-dialog-body');
        body.innerHTML='<p>下达预约材料与需求；开工后须按实际结果报工。只有报工才扣减库存并计入合格完成量。</p><p id="execution-error" role="alert"></p>'+
            unresolved.map(([slot,intent])=>'<article class="task-list-item"><strong>上次操作结果待确认 · '+escapeText(intent.action)+'</strong><span>保留原编号与原输入，重试不会重复执行。</span><button class="tool-btn" data-retry="'+escapeText(slot)+'">重试原操作</button></article>').join('');
        const canCreate=canUseCurrentPlan() && (!view || ['CANCELLED','EXPIRED'].includes(view.effectiveState));
        if(canCreate && !queuedReports().length && !unresolved.length) {
            const form=document.createElement('form');form.className='task-list-item';
            form.innerHTML='<strong>当前方案 · '+pending.result.pieces.length+' 件</strong><label>加工工位<input name="station" required maxlength="100" placeholder="例如：裁床 A-01"></label><button class="tool-btn active" type="submit">创建执行单</button>';
            form.onsubmit=event=>{event.preventDefault();run(()=>writer.command('create',{taskId,planId:pending.result.planId},{station:form.elements.station.value.trim()}));};body.append(form);
        }
        if(queuedReports().length)body.insertAdjacentHTML('beforeend','<p>本机还有连续工位暂存，请先统一报工，再下达新的执行单。暂存内容保持不变。</p>');
        const views=state.taskExecutions.slice().reverse();
        if(!views.length && !canCreate)body.insertAdjacentHTML('beforeend','<p>暂无执行单。先生成并核对方案，再创建执行单。</p>');
        for(const item of views) {
            const e=item.execution,article=document.createElement('article');article.className='task-list-item';article.dataset.execution=e.id;
            article.innerHTML='<strong>'+escapeText(e.station)+' · '+escapeText(executionLabels[item.effectiveState] || item.effectiveState)+'</strong><span>'+escapeText(e.materialId)+' · 需求 '+Object.values(e.demandQuantities).reduce((a,b)=>a+b,0)+' 件</span><small>方案 '+escapeText(e.planId)+' · 版本 '+e.version+(e.expiresAt?' · 预约到 '+escapeText(new Date(e.expiresAt).toLocaleString()):'')+'</small><div class="dialog-actions"><button class="tool-btn" data-view>查看方案</button></div>';
            article.querySelector('[data-view]').onclick=()=>run(async()=>{
                const saved=await requestJSON('/api/cutting/plans/'+encodeURIComponent(e.planId));
                if(!isCurrent())return;
                if(saved.status!=='PENDING') {
                    const {openCutTicketModal}=await import('../../plugins/export/cut-ticket.js');
                    if(isCurrent()){dialog.close();await openCutTicketModal({planId:e.planId,historical:true});}
                    return;
                }
                if(isCurrent() && await mountSavedPlan(saved,{isCurrent}))dialog.close();
            },false);
            if(['DRAFT','RELEASED','EXPIRED','RUNNING'].includes(item.effectiveState)) {
                const form=document.createElement('form');
                form.innerHTML=(['DRAFT','EXPIRED'].includes(item.effectiveState)?'<label>预约分钟<input name="minutes" type="number" min="1" max="1440" step="1" value="30" required></label>':'')+
                    (item.effectiveState!=='RUNNING'?'<label>操作说明 / 取消原因<input name="reason" maxlength="500"></label>':'')+'<div class="dialog-actions"></div>';
                form.onsubmit=event=>event.preventDefault();
                for(const action of ['release','start','report','cancel']) {
                    const relevant=action==='release'?['DRAFT','EXPIRED'].includes(item.effectiveState):action==='start'?item.effectiveState==='RELEASED':action==='report'?item.effectiveState==='RUNNING':item.effectiveState!=='RUNNING';
                    if(!relevant)continue;
                    const advice=item.allowedActions?.[action], button=document.createElement('button');button.type='button';button.className='tool-btn';button.dataset.action=action;
                    button.textContent={release:'下达并预约',start:'确认开工',report:'填写实切结果',cancel:'取消执行单'}[action];
                    button.disabled=!advice?.allowed || !!unresolved.length || (action==='release' && !!queuedReports().length);
                    if(!advice?.allowed) {const note=document.createElement('p');note.className='muted-note';note.textContent=button.textContent+'：'+(advice?.reason || '请刷新状态');form.append(note);}
                    button.onclick=()=>{
                        if(!form.reportValidity())return;
                        const reason=form.elements.reason?.value.trim() || '';
                        if(action==='cancel' && !reason){body.querySelector('#execution-error').textContent='取消须填写原因。';form.elements.reason.focus();return;}
                        run(async()=>{
                            if(action==='report') {
                                if(state.pendingPlan?.result?.planId!==e.planId || !canUseCurrentPlan()) {
                                    const saved=await requestJSON('/api/cutting/plans/'+encodeURIComponent(e.planId));
                                    if(!isCurrent() || !await mountSavedPlan(saved,{isCurrent}))return;
                                }
                                if(!isCurrent())return;
                                dialog.close();await openCutReport();return;
                            }
                            await writer.command(action,e,{reason,reservationSeconds:Number(form.elements.minutes?.value || 0)*60});
                        },action!=='report');
                    };
                    form.querySelector('.dialog-actions').append(button);
                }
                article.append(form);
            }
            body.append(article);
        }
        body.querySelectorAll('[data-retry]').forEach(button=>button.onclick=()=>run(()=>writer.retry(button.dataset.retry)));
        async function run(operation, refresh=true) {
            dialog.inert=true;
            try {if(!isCurrent())return;await operation();if(refresh && isCurrent())await openTaskExecutions();}
            catch(error){if(isCurrent())dialog.querySelector('#execution-error').textContent=error.message;else showToast(error.message,'error');}
        finally {dialog.inert=false;updateWorkflowControls();renderScene();}
        }
    } catch(error) {if(ticket===generation && dialog.open)dialog.querySelector('.workbench-dialog-body').textContent=error.message;}
}
