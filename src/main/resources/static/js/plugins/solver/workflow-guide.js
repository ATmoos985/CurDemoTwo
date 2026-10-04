import {state} from '../../core/state.js';
import {toggleSidebar, switchRightPanelTab} from '../layout/splitter.js';
import {workflowState} from './workflow-state.js';

const el = id => document.getElementById(id);
const value = id => el(id)?.value;
export function readWorkflowState(plan = {}) {
    const data = state.getCurrentCaseData(), sheet = state.currentCutMode === 'remnant';
    return workflowState({name:value('task-name'), model:value('task-material'), ...plan,
        demands:[...document.querySelectorAll('#demands-container .item-row')].map(row => ({
            id:Number(row.dataset.id), name:row.querySelector('.dem-name').value,
            width:Number(row.querySelector('.dem-w').value), length:Number(row.querySelector('.dem-l').value),
            quantity:Number(row.querySelector('.dem-count').value), completed:state.taskCompleted[row.dataset.id] || 0
        })),
        material:{available:data.materialAvailable && (!sheet || !!state.loadedRemnant), sheet,
            model:sheet ? state.loadedRemnant?.materialBatch : el('lbl-roll-model-desc')?.textContent,
            length:sheet ? state.loadedRemnant?.length : data.stockRemainingLength,
            used:data.stockUsedLength || 0, total:data.totalRollL},
        process:{length:Number(value('inp-bed-l')), start:sheet ? 0 : Number(value('inp-window-start-y')), trim:Number(value('inp-trim-start'))}
    });
}

/** Stage buttons reveal existing surfaces. They never save, solve, report or move the cutting window. */
export function navigateWorkflowStage(stage, target) {
    const node = document.querySelector(target || ['#card-demands','#card-mother-roll','#card-material-balance','#right-roll-actions'][stage]);
    if (!node) return;
    const side = node.closest('#sidebar-left') ? 'left' : 'right';
    if (el('sidebar-'+side)?.classList.contains('collapsed')) toggleSidebar(side);
    if (stage >= 2) switchRightPanelTab('balance');
    for (let parent=node; parent; parent=parent.parentElement) {
        if (parent.classList.contains('collapsible')) {parent.classList.remove('collapsed');parent.querySelector('.section-toggle')?.setAttribute('aria-expanded','true');}
        if (parent.tagName === 'DETAILS') parent.open = true;
    }
    const focus = target ? node : node.querySelector('input,select,button') || node;
    if (!focus.matches('input,select,button,a')) focus.tabIndex = -1;
    focus.focus({preventScroll:true}); node.scrollIntoView({block:'nearest'});
}

export function renderWorkflowGuide(plan = {}) {
    const flow = readWorkflowState(plan), busy = plan.busy;
    const actions = {solve:'btn-trigger-solve-station', report:'btn-confirm-station-cut', validate:'btn-validate-adjustment'};
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
        button.title = (completed ? '已就绪 · ' : index === flow.stage ? '当前阶段 · ' : '待完成 · ') + '点击查看，执行操作请用右侧按钮';
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
    const solve = el(actions.solve);solve.disabled = !!busy || !flow.canSolve;solve.hidden = !flow.canSolve;
    solve.textContent = busy === '正在生成方案…' ? busy : plan.ready || plan.edited ? '重新排料' : '生成排料方案';
    const report = el(actions.report);report.disabled = !!busy || flow.action !== 'report';report.hidden = !plan.ready && !plan.edited;
    report.textContent = '核对实切并报工';
    el('btn-validate-adjustment').hidden = !plan.edited;
    el('station-navigation-group').hidden = !state.getCurrentCaseData().materialAvailable;
    return flow;
}
