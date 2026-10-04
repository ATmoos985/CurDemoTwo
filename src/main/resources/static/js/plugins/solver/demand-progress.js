import {state} from '../../core/state.js';
import {bus} from '../../core/event-bus.js';
import {demandProgress} from './demand-progress-model.js';
import {getSelectedPieceId, setSelectedPieceId} from '../cad/cad-interactive-nesting.js';
import {focusPiece} from '../cad/cad-renderer.js';
import {toggleSidebar} from '../layout/splitter.js';

let currentPieces = [];
const rows = () => [...(document.getElementById('demands-container')?.querySelectorAll('.item-row') || [])];
const display = value => value == null ? '—' : String(value);

export function updateDemandProgress(options = {}) {
    const list = rows();
    const pieces = state.getCurrentCaseData().pieces || [];
    currentPieces = options.pending ? pieces.filter(p => p.planId === options.pending.result.planId && !p.confirmed) : [];
    const progress = demandProgress(list.map(row => ({id:Number(row.dataset.id),quantity:row.querySelector('.dem-count').value.trim() === '' ? NaN : Number(row.querySelector('.dem-count').value)})),
        state.taskCompleted, {...options,pieces});
    list.forEach((row,index) => {
        const item = progress[index];row.dataset.completed = item.completed;
        let status = row.querySelector('.demand-status');
        if (!status) {status=document.createElement('div');status.className='demand-status';row.append(status);}
        status.textContent = `本方案 ${item.planned} · 已报工 ${item.completed} · 剩余 ${display(item.remaining)}`;
        status.classList.toggle('done',item.remaining === 0);
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
    const badge=document.getElementById('demands-summary-badge');
    if (badge) badge.textContent=`已报工 ${progress.reduce((n,d)=>n+d.completed,0)} / 总 ${progress.every(d=>Number.isSafeInteger(d.total) && d.total > 0)?progress.reduce((n,d)=>n+d.total,0):'—'} 件`;
    const feedback=document.getElementById('demand-progress-summary');
    if (feedback) feedback.textContent=options.attempt ? '求解反馈：'+(options.attempt.result.message || '本次没有生成方案，请核对未排入原因。')
        : options.pending ? `本方案 ${currentPieces.length} 件${options.edited?' · 手调待校验':''}；剩余数量含本方案尚未报工的裁片。` : '尺寸：mm · 剩余按合格报工计算，预览不扣数量。';
    syncDemandSelection(false);
}

function locateDemand(id) {
    const matches=currentPieces.filter(p=>p.demandId===id);if(!matches.length)return;
    const index=matches.findIndex(p=>p.id===getSelectedPieceId());
    const piece=matches[(index+1)%matches.length];
    setSelectedPieceId(piece.id);focusPiece(piece.id);
}

function syncDemandSelection(reveal) {
    const piece=(state.getCurrentCaseData().pieces || []).find(p=>p.id===getSelectedPieceId());
    for(const row of rows()) {
        const selected=piece?.demandId===Number(row.dataset.id);
        row.classList.toggle('demand-selected',selected);
        if(selected && reveal) {
            const sidebar=document.getElementById('sidebar-left');if(sidebar.classList.contains('collapsed'))toggleSidebar('left');
            const card=document.getElementById('card-demands');card.classList.remove('collapsed');card.querySelector('.section-toggle').setAttribute('aria-expanded','true');
            // Keep keyboard focus on the canvas; revealing the row must not start editing it.
            row.scrollIntoView({block:'nearest'});
        }
    }
}
bus.on('piece:selected',()=>syncDemandSelection(true));
for(const event of ['stage:empty-clicked','remnant:selected','case:changed','mode:changed'])bus.on(event,()=>syncDemandSelection(false));
