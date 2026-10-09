import {state} from '../../core/state.js';
import {bus} from '../../core/event-bus.js';
import {demandProgress, summarizeDemandProgress, latestDemandChange} from './demand-progress-model.js';
import {getSelectedPieceId, setSelectedPieceId} from '../cad/cad-interactive-nesting.js';
import {focusPiece} from '../cad/cad-renderer.js';
import {toggleSidebar} from '../layout/splitter.js';
import {openDemandManager, renderDemandSummary} from '../layout/workbench-panels.js';
import {queuedQuantities} from './report-queue.js';

let currentPieces = [];
const rows = () => [...(document.getElementById('demands-container')?.querySelectorAll('.item-row') || [])];
const display = value => value == null ? '—' : String(value);

export function updateDemandProgress(options = {}) {
    const list = rows();
    const pieces = state.getCurrentCaseData().pieces || [];
    currentPieces = options.pending ? pieces.filter(p => p.planId === options.pending.result.planId && !p.confirmed) : [];
    const progress = demandProgress(list.map(row => ({id:Number(row.dataset.id),quantity:row.querySelector('.dem-count').value.trim() === '' ? NaN : Number(row.querySelector('.dem-count').value)})),
        state.taskCompleted, {...options,pieces,queued:queuedQuantities()});
    const change=latestDemandChange(state.taskReports,state.activeTask?.id);
    list.forEach((row,index) => {
        const item = progress[index];row.dataset.completed = item.completed;
        row.onkeydown=event=>{if(event.target===row)event.stopPropagation();};
        let status = row.querySelector('.demand-status');
        if (!status) {status=document.createElement('div');status.className='demand-status';row.append(status);}
        status.textContent = `已报工 ${item.completed} / ${display(Number.isSafeInteger(item.total) && item.total>0?item.total:null)} 件 · 待报工 ${item.staged} · 待切 ${display(item.toCut)}`;
        status.classList.toggle('done',item.remaining === 0);
        let meter=row.querySelector('.demand-meter');
        if(!meter){meter=document.createElement('div');meter.className='demand-meter';meter.append(document.createElement('span'));status.after(meter);}
        renderMeter(meter,item.completed,item.remaining===null?null:item.total,row.querySelector('.dem-name').value+' 裁切进度',item.staged);
        row.dataset.fulfilled=String(item.remaining===0);
        let delta=row.querySelector('.demand-change');
        if(!delta){delta=document.createElement('p');delta.className='demand-change';meter.after(delta);}
        const difference=change?.deltas[item.id] || 0;
        delta.hidden=!difference;delta.dataset.reversed=String(difference<0);
        delta.textContent=difference>0?`最近报工 +${difference} 件`:`最近撤回 · 恢复待切 ${-difference} 件`;
        delta.title=change?.time?`记录时间 ${change.time.replace('T',' ')} · ${change.planId}`:'';
        row.dataset.recentChange=difference>0?'reported':difference<0?'reversed':'';
        let preview=row.querySelector('.demand-preview-label');
        if(!preview){preview=document.createElement('p');preview.className='demand-preview-label';delta.after(preview);}
        preview.hidden=!item.planned;preview.textContent=`本方案预览 ${item.planned} 件 · ${options.edited?'待校验':'尚未确认裁切'}`;
        let tools = row.querySelector('.demand-progress-tools');
        if (!tools) {
            tools=document.createElement('div');tools.className='demand-progress-tools';
            const locate=document.createElement('button');locate.type='button';locate.className='tool-btn demand-locate';
            const detail=document.createElement('details');detail.className='demand-unplaced';detail.append(document.createElement('summary'),document.createElement('p'));
            tools.append(locate,detail);row.append(tools);
        }
        const locate=tools.querySelector('button');locate.textContent=`定位 ${item.planned} 件`;locate.disabled=!item.planned;
        locate.title='按此需求逐件定位画布，重复点击查看下一件';locate.onclick=()=>locateDemand(item.id);
        const detail=tools.querySelector('details');detail.hidden=!item.reason;
        detail.querySelector('summary').textContent=`未排入 ${display(item.unplaced)} 件 · 查看原因`;
        detail.querySelector('p').textContent=item.reason;
    });
    renderOverview(progress,list,change);
    renderDemandSummary(progress,list);
    const badge=document.getElementById('demands-summary-badge');
    if (badge) badge.textContent=progress.length+' 项';
    const feedback=document.getElementById('demand-progress-summary');
    if (feedback) feedback.textContent=options.attempt ? '求解反馈：'+(options.attempt.result.message || '本次没有生成方案，请核对未排入原因。')
        : options.pending ? `本方案预览 ${currentPieces.length} 件${options.edited?' · 手调待校验':''}；确认裁切后计入待报工。` : '尺寸：mm · 确认裁切减少待切量，合格报工计入完成量。';
    syncDemandSelection(false);
}

function renderMeter(element,completed,total,label,staged=0) {
    element.setAttribute('role','progressbar');element.setAttribute('aria-label',label);element.setAttribute('aria-valuemin','0');
    if(total==null){element.removeAttribute('aria-valuenow');element.removeAttribute('aria-valuemax');element.setAttribute('aria-valuetext','请核对需求数量');}
    else{element.setAttribute('aria-valuenow',String(Math.min(total,completed+staged)));element.setAttribute('aria-valuemax',String(total));element.setAttribute('aria-valuetext',`已报工 ${completed}，待报工 ${staged}，共 ${total} 件`);}
    element.firstElementChild.style.width=total>0?`${Math.min(100,Math.max(0,completed/total*100))}%`:'0%';
    if(element.children.length<2){const pending=document.createElement('span');pending.className='demand-meter-staged';element.append(pending);}
    element.lastElementChild.style.width=total>0?`${Math.max(0,Math.min(100-completed/total*100,staged/total*100))}%`:'0%';
    element.dataset.complete=String(total>0 && completed===total);
}

function renderOverview(progress,list,change) {
    const overview=document.getElementById('demand-overview');if(!overview)return;
    overview.hidden=!progress.length;if(!progress.length)return;
    overview.onkeydown=event=>event.stopPropagation();
    const summary=summarizeDemandProgress(progress);
    document.getElementById('demand-lines-progress').textContent=`已切 ${summary.cut} / ${display(summary.total)} 件`;
    document.getElementById('demand-pieces-progress').textContent=`待切 ${display(summary.toCut)} 件`;
    document.getElementById('demand-progress-counts').textContent=`已报工 ${summary.completed} · 待报工 ${summary.staged} · 已满足 ${summary.satisfied} / ${summary.lines} 项`;
    const segments=document.getElementById('demand-progress-segments'),overall=document.getElementById('demand-overall-meter');
    segments.hidden=true;overall.hidden=false;
    // Reuse segment buttons while typing or moving pieces so keyboard focus is retained.
    const ids=progress.map(d=>d.id).join(',');
    if(segments.dataset.ids!==ids){segments.replaceChildren(...progress.slice(0,12).map(()=>{
        const button=document.createElement('button');button.type='button';button.className='demand-segment';
        button.append(document.createElement('span'),document.createElement('b'));return button;
    }));segments.dataset.ids=ids;}
    [...segments.children].forEach((button,index)=>{
        const item=progress[index],name=list[index].querySelector('.dem-name').value;
        button.firstElementChild.style.width=item.remaining!==null?`${Math.min(100,item.completed/item.total*100)}%`:'0%';
        button.lastElementChild.textContent=`${index+1}${item.remaining===0?'✓':''}`;
        button.dataset.complete=String(item.remaining===0);
        button.title=button.ariaLabel=`第 ${index+1} 项 ${name} · 合格 ${item.completed} / ${display(item.remaining===null?null:item.total)} 件 · ${item.remaining===0?'已满足':`还差 ${display(item.remaining)} 件`}，点击定位需求`;
        button.onclick=()=>revealDemand(item.id);
    });
    renderMeter(overall,summary.completed,summary.total,'本次裁切进度',summary.staged);
    const recent=document.getElementById('demand-recent-change');recent.hidden=!change;
    if(!change)return;
    const changeKey=change.planId+':'+change.reversed;
    if(recent.dataset.change!==changeKey){recent.open=false;recent.dataset.change=changeKey;}
    recent.querySelector('summary').textContent=!change.known?(change.reversed?'最近撤回 · 逐项明细未登记':'最近报工 · 逐项明细未登记')
        :change.reversed?`最近撤回 · 恢复待切 ${change.pieces} 件`:`最近报工 +${change.pieces} 件 · 查看变化`;
    recent.querySelector('p').textContent=`${change.time.replace('T',' ')}${!change.reversed && (change.rejected || change.uncut)?` · 异常 ${change.rejected}、未切 ${change.uncut} 件未计入完成`:''}`;
    const changes=recent.querySelector('div');changes.replaceChildren();
    for(const item of progress){const delta=change.deltas[item.id];if(!delta)continue;
        const button=document.createElement('button');button.type='button';button.className='demand-change-link';
        button.textContent=`${list.find(r=>Number(r.dataset.id)===item.id).querySelector('.dem-name').value}：${delta>0?`+${delta}`:`恢复待切 ${-delta}`} 件${item.remaining===0?' · 已满足':''}`;
        button.onclick=()=>revealDemand(item.id);changes.append(button);
    }
}

function revealDemand(id) {
    const row=rows().find(r=>Number(r.dataset.id)===id);if(!row)return;
    openDemandManager(id);
    rows().forEach(r=>r.classList.toggle('demand-progress-target',r===row));
    row.scrollIntoView({block:'nearest'});row.tabIndex=-1;row.focus({preventScroll:true});
}

function locateDemand(id) {
    const matches=currentPieces.filter(p=>p.demandId===id);if(!matches.length)return;
    const index=matches.findIndex(p=>p.id===getSelectedPieceId());
    const piece=matches[(index+1)%matches.length];
    document.getElementById('demand-manager')?.close();
    setSelectedPieceId(piece.id);focusPiece(piece.id);
}

function syncDemandSelection(reveal) {
    const piece=(state.getCurrentCaseData().pieces || []).find(p=>p.id===getSelectedPieceId());
    for(const row of rows()) {
        const selected=piece?.demandId===Number(row.dataset.id);
        row.classList.toggle('demand-selected',selected);
        if(selected && reveal) {
            const sidebar=document.getElementById('sidebar-left');if(sidebar.classList.contains('collapsed'))toggleSidebar('left');
            // Selecting the canvas must not open a modal or steal keyboard focus.
            const summary=document.querySelector(`#demand-quick-list [data-demand="${row.dataset.id}"]`);
            summary?.scrollIntoView({block:'nearest'});
        }
    }
}
bus.on('piece:selected',()=>syncDemandSelection(true));
for(const event of ['stage:empty-clicked','remnant:selected','case:changed','mode:changed'])bus.on(event,()=>syncDemandSelection(false));
