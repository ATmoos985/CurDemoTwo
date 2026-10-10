import {state} from '../../core/state.js';
import {toggleSidebar, switchRightPanelTab} from '../layout/splitter.js';
import {workflowState} from './workflow-state.js';
import {openDemandManager, openMaterialDetails, renderDemandEditor} from '../layout/workbench-panels.js';
import {scheduleRemnantAvailability} from '../material/material-selection.js';
import {queuedReports, queuedQuantities, queuedRollEnd, queuedStockLength} from './report-queue.js';

const el = id => document.getElementById(id);
const value = id => el(id)?.value;
const remnantConsumed = data => !!state.loadedRemnant?.id && data.lastReceipt?.feedPortType === 'remnant'
    && data.lastReceipt.sourceRemnantId === state.loadedRemnant.id && data.lastReceipt.status !== 'REVERSED';
export function readWorkflowState(plan = {}) {
    const data = state.getCurrentCaseData(), sheet = state.currentCutMode === 'remnant';
    const queue = queuedReports(), staged = queuedQuantities(queue);
    return workflowState({name:value('task-name'), model:value('task-material'), queued:queue.length, ...plan,
        demands:[...document.querySelectorAll('#demands-container .item-row')].map(row => ({
            id:Number(row.dataset.id), name:row.querySelector('.dem-name').value,
            width:Number(row.querySelector('.dem-w').value), length:Number(row.querySelector('.dem-l').value),
            quantity:Number(row.querySelector('.dem-count').value), completed:state.taskCompleted[row.dataset.id] || 0, queued:staged[row.dataset.id] || 0
        })),
        material:{available:data.materialAvailable && (!sheet || (!!state.loadedRemnant && !remnantConsumed(data) && !queue.some(r => r.pending.sourceRemnantId === state.loadedRemnant.id))), sheet,
            model:sheet ? state.loadedRemnant?.materialBatch : el('lbl-roll-model-desc')?.textContent,
            length:sheet ? state.loadedRemnant?.length : data.stockRemainingLength - queuedStockLength(data.rollId,queue),
            used:Math.max(data.stockUsedLength || 0,queuedRollEnd(data.rollId,queue)), total:data.totalRollL},
        process:{length:Number(value('inp-bed-l')), start:sheet ? 0 : Number(value('inp-window-start-y')), trim:Number(value('inp-trim-start'))}
    });
}

/** Stage buttons reveal existing surfaces. They never save, solve, report or move the cutting window. */
export function navigateWorkflowStage(stage, target) {
    if (!target && stage === 0) {openDemandManager();return;}
    if (!target && stage === 1) {openMaterialDetails();return;}
    const node = document.querySelector(target || ['#card-demands','#card-mother-roll','#card-material-balance','#right-roll-actions'][stage]);
    if (!node) return;
    if (stage === 0) openDemandManager();
    if (node.closest('#material-details')) openMaterialDetails();
    const side = node.closest('#sidebar-left') ? 'left' : 'right';
    if (!node.closest('dialog') && el('sidebar-'+side)?.classList.contains('collapsed')) toggleSidebar(side);
    if (stage >= 2) switchRightPanelTab('balance');
    for (let parent=node; parent; parent=parent.parentElement) {
        if (parent.classList.contains('collapsible')) {parent.classList.remove('collapsed');parent.querySelector('.section-toggle')?.setAttribute('aria-expanded','true');}
        if (parent.tagName === 'DETAILS') parent.open = true;
    }
    const focus = stage === 0 && !node.closest('#demand-manager') ? el('task-name') : target ? node : node.querySelector('input,select,button') || node;
    if (!focus.matches('input,select,button,a,[tabindex]')) focus.tabIndex = -1;
    focus.focus({preventScroll:true}); node.scrollIntoView({block:'nearest'});
}

export function renderWorkflowGuide(plan = {}) {
    const flow = readWorkflowState(plan), busy = plan.busy;
    renderDemandEditor(flow);
    const actions = {solve:'btn-trigger-solve-station', report:'btn-stage-advance', batch:'btn-batch-report', validate:'btn-validate-adjustment'};
    const primary = actions[flow.action] || 'btn-workflow-next';
    const footer = el('right-roll-actions'); if (!footer) return flow;
    footer.dataset.stage = flow.done ? 'complete' : String(flow.stage);
    el('workflow-current').textContent = busy || flow.title;
    el('station-action-hint').textContent = flow.hint;
    for (const button of document.querySelectorAll('[data-workflow-stage]')) {
        const index = Number(button.dataset.workflowStage), completed = flow.done || index < flow.stage;
        button.dataset.state = index === flow.stage ? 'current' : completed ? 'complete' : 'pending';
        if (index === flow.stage) button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current');
        button.querySelector('.stage-marker').textContent = completed ? '✓' : index+1;
        button.title = ['查看当前需求','查看母卷、疵点与料头库','查看排料结果','核对产出并报工'][index];
        button.onclick = () => navigateWorkflowStage(index);
    }
    for (const id of [...Object.values(actions),'btn-workflow-next']) {
        const button = el(id); if (!button) continue;
        button.classList.toggle('workflow-primary', id === primary);
        button.classList.toggle('workflow-secondary', id !== primary);
    }
    const next = el('btn-workflow-next');next.hidden = primary !== next.id;next.disabled = !!busy;next.textContent = flow.label;
    next.onclick = () => {
        if (flow.action === 'add') {window.camApp.addDemandRow();navigateWorkflowStage(0);}
        if (flow.action === 'focus') navigateWorkflowStage(flow.stage, flow.target);
        if (flow.action === 'match') window.camApp.matchTaskMaterials();
        if (flow.action === 'reports') window.camApp.openTaskReports();
        if (flow.action === 'advance') window.camApp.smartAdvanceBed();
    };
    const nextHost = flow.stage >= 2 ? footer : el('left-input-actions');
    if (next.parentElement !== nextHost) nextHost.prepend(next);
    const statusHost = flow.stage >= 2 ? footer : el('input-flow-status');
    if (el('workflow-current').parentElement !== statusHost) statusHost.prepend(el('workflow-current'),el('station-action-hint'));
    const solve = el(actions.solve);solve.disabled = !!busy || !flow.canSolve;solve.hidden = !flow.canSolve;
    solve.textContent = busy === '正在生成方案…' ? busy : plan.ready || plan.edited ? '重新排料' : '生成排料方案';
    const secondary = el('station-secondary-actions');
    if (plan.ready || plan.edited) secondary.prepend(solve);
    else footer.insertBefore(solve,el(actions.report));
    const stageAdvance = el(actions.report);
    stageAdvance.hidden = !plan.ready;
    stageAdvance.disabled = !!busy || flow.action !== 'report';
    stageAdvance.textContent = '记录并排下一工位';
    const report = el('btn-confirm-station-cut');
    report.hidden = !plan.ready;report.disabled = !!busy || flow.action !== 'report';
    const queue = queuedReports(), batch = el(actions.batch);
    batch.hidden = !queue.length && !plan.ready;
    batch.disabled = !!busy || !!plan.edited;
    batch.textContent = '统一报工 · ' + (queue.length + (plan.ready ? 1 : 0)) + ' 工位';
    el('btn-validate-adjustment').hidden = !plan.edited;
    const data = state.getCurrentCaseData(), sheet = state.currentCutMode === 'remnant';
    el('station-navigation-group').hidden = !data.materialAvailable;
    el('material-context-id').textContent = data.materialAvailable ? (sheet ? state.loadedRemnant?.id : data.rollId) : '未装载材料';
    const stock = sheet ? state.loadedRemnant : null;
    el('material-context-info').textContent = sheet && remnantConsumed(data) ? '本块料头已报工核销；继续裁切请重新选料。' : !data.materialAvailable ? '先完善需求，再匹配可用材料。' : sheet
        ? (stock?.materialBatch || '') + ' · ' + stock?.width + ' × ' + stock?.length + ' mm'
        : (el('lbl-roll-model-desc')?.textContent || '') + ' · 幅宽 ' + data.rollW + ' mm · 余量 ' + (data.stockRemainingLength || 0).toLocaleString() + ' mm';
    el('btn-material-details').onclick = openMaterialDetails;
    if(el('lbl-current-roll-id'))el('lbl-current-roll-id').textContent=data.materialAvailable?data.rollId:'未装载';
    if(el('current-task-name'))el('current-task-name').textContent = value('task-name') || '未命名任务';
    const receipts = (state.taskReports || []).filter(r => r.status !== 'REVERSED');
    if(el('output-empty'))el('output-empty').hidden = !!plan.ready || !!plan.edited || !!queue.length || !!receipts.length;
    renderStationOrders(queue,receipts);
    scheduleRemnantAvailability();
    return flow;
}

function renderStationOrders(queue, receipts) {
    const panel = el('station-work-orders'), list = el('station-work-orders-list');
    if (!panel || !list) return;
    panel.hidden = !queue.length && !receipts.length;
    el('station-work-orders-count').textContent = queue.length + ' 待报 · ' + receipts.length + ' 已报';
    const signature = JSON.stringify([queue,receipts]);
    if (list.dataset.signature === signature) return;
    list.dataset.signature = signature;
    list.replaceChildren();
    const rows = [...receipts.map(report => ({report,pending:report,reported:true})), ...queue];
    rows.forEach(({report,pending,reported},index) => {
        const item = document.createElement('details');item.className = 'station-order';
        const summary = document.createElement('summary');
        summary.textContent = '工位 ' + (index+1) + ' · ' + report.finishedPieceCount + ' 件 · ' + (reported ? '已报工' : '待报工');
        const source = document.createElement('p');source.textContent = pending.sourceRemnantId || pending.rollId;
        const range = document.createElement('p');range.className = 'muted-note';
        range.textContent = pending.feedPortType === 'remnant' ? '料头使用一次，余料不回收' : pending.windowStartY + '–' + (pending.windowStartY+report.actualCutLen) + ' mm · 用料 ' + report.actualCutLen + ' mm';
        const results = document.createElement('p');results.className = 'muted-note';
        results.textContent = '合格 ' + report.finishedPieceCount + ' · 异常 ' + (report.pieceResults || []).filter(p => p.outcome === 'REJECTED').length + ' · 未切 ' + (report.pieceResults || []).filter(p => p.outcome === 'UNCUT').length;
        const ticket = document.createElement('button');ticket.className = 'tool-btn';ticket.textContent = '查看工单';
        ticket.onclick = () => window.camApp.openCutTicketModal({planId:report.planId,historical:true});
        item.append(summary,source,range,results,ticket);list.append(item);
    });
}
