import { state } from '../../core/state.js';
import { getInitialScenarios } from '../presets/scenarios.js';
import { renderDemandsUI, getDemandsFromUI, updateDemandCompletionFromPieces } from './quota-manager.js';
import { switchCutMode } from '../remnant/remnant-shelf.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { updateUIInfo } from './solver-client.js';
import { showToast } from '../../core/toast.js';

export const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const el = id => document.getElementById(id);
async function api(url, body) {
    const response = await fetch(url, body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '请求失败，请重试');
    return result;
}

export function taskInputChanged() {
    state.pendingPlan = null;
    el('task-state').textContent = '需求已修改 · 待保存';
    el('task-details-title').textContent = el('task-name').value || '任务信息';
}

export function startTaskDraft(name = '本次切割') {
    state.activeTask = null;
    state.taskCompleted = {};
    state.taskReports = [];
    state.pendingPlan = null;
    localStorage.removeItem('cutting-task-id');
    el('task-name').value = name;
    el('task-details').open = true;
    el('task-details-title').textContent = name;
    el('task-external-ref').value = '';
    el('task-state').textContent = '新任务 · 未保存';
    el('task-report-count').textContent = '0';
    el('preset-current-label').textContent = '载入示例需求';
}

export async function newCuttingTask() {
    startTaskDraft();
    state.scenarios = getInitialScenarios();
    state.currentCaseId = 1;
    state.getCurrentCaseData().demands = [];
    renderDemandsUI([]);
    await switchCutMode('roll');
    el('task-name').focus();
}

function taskPayload() {
    return {
        id: state.activeTask?.id, revision: state.activeTask?.revision || 0,
        name: el('task-name').value.trim(), materialModel: el('task-material').value,
        externalRef: el('task-external-ref').value.trim(),
        process: {bedLength:Number(el('inp-bed-l').value), trimStart:Number(el('inp-trim-start').value),
            cutOrigin:el('sel-cut-origin').value, firstStageOrientation:el('sel-first-stage').value,
            allowRotation:el('sel-allow-rotation').value === '1', allowLongitudinal:el('sel-allow-longitudinal').value === '1'},
        demands: getDemandsFromUI().map(d => ({ id: d.id, name: d.name, width: d.width,
            length: d.length, quantity: d.count, allowRotation: d.allowRotation }))
    };
}

let savingTask;
export async function saveCurrentTask() {
    if (savingTask) return savingTask;
    savingTask = saveTaskSnapshot();
    try { return await savingTask; } finally { savingTask = null; }
}
async function saveTaskSnapshot() {
    state.getCurrentCaseData().demands = getDemandsFromUI();
    const payload = taskPayload();
    const current = state.activeTask;
    const task = await api('/api/cutting/tasks', payload);
    if (current !== state.activeTask || JSON.stringify(payload) !== JSON.stringify(taskPayload())) throw new Error('保存期间需求已变化，请再次保存当前需求');
    state.activeTask = task;
    localStorage.setItem('cutting-task-id', task.id);
    await refreshTaskProgress();
    el('task-state').textContent = '已保存 · ' + task.id.slice(0, 8);
    el('task-details').open = false;
    el('task-details-title').textContent = task.name;
    return task;
}

export async function saveTaskFromUI() {
    try { await saveCurrentTask(); showToast('需求已保存，可跨材料继续裁切', 'success'); }
    catch (error) { showToast(error.message, 'error'); }
}

export async function refreshTaskProgress() {
    if (!state.activeTask) return;
    const id = state.activeTask.id;
    const detail = await api('/api/cutting/tasks/' + encodeURIComponent(id));
    if (state.activeTask?.id !== id) return;
    state.taskCompleted = detail.completed;
    state.taskReports = detail.reports;
    const data = state.getCurrentCaseData();
    updateDemandCompletionFromPieces(data);
    renderDemandsUI(data.demands);
    el('task-report-count').textContent = detail.reports.length;
}

function picker(title, content) {
    el('task-picker-title').textContent = title;
    el('task-picker-body').replaceChildren();
    el('task-picker-body').innerHTML = content;
    if (!el('task-picker').open) el('task-picker').showModal();
}

export async function openTaskList() {
    picker('打开切割任务', '<p class="muted">读取中…</p>');
    try {
        const tasks = await api('/api/cutting/tasks');
        picker('打开切割任务', tasks.length ? tasks.slice().reverse().map(t => `<button class="task-list-item" data-task="${escapeText(t.id)}"><strong>${escapeText(t.name)}</strong><span>${escapeText(t.materialModel)} · ${t.demands.length} 项需求</span><small>${escapeText(t.externalRef || t.id.slice(0,8))}</small></button>`).join('') : '<p class="muted">暂无已保存任务。先收集需求，再点击“保存需求”。</p>');
        el('task-picker-body').querySelectorAll('[data-task]').forEach(button => button.onclick = () => loadTask(button.dataset.task));
    } catch (error) { picker('打开切割任务', `<p role="alert">${escapeText(error.message)}</p>`); }
}

export async function loadTask(id) {
    try {
        const detail = await api('/api/cutting/tasks/' + encodeURIComponent(id));
        state.activeTask = detail.task;
        state.taskCompleted = detail.completed;
        state.taskReports = detail.reports;
        const task = detail.task;
        el('task-name').value = task.name;
        el('task-external-ref').value = task.externalRef || '';
        if (![...el('task-material').options].some(o => o.value === task.materialModel)) el('task-material').add(new Option(task.materialModel, task.materialModel));
        el('task-material').value = task.materialModel;
        const data = state.getCurrentCaseData();
        data.demands = task.demands.map(d => ({...d, w:d.width, l:d.length, count:d.quantity, demand:d.quantity}));
        state.nextDemandId = Math.max(0, ...task.demands.map(d => d.id)) + 1;
        renderDemandsUI(data.demands);
        const rolls = await api('/api/rolls');
        const previousRoll = detail.reports.at(-1)?.rollId;
        const roll = rolls.find(r => r.rollId === previousRoll && r.rollModel === task.materialModel && r.currentRemainingLength > 0)
            || rolls.find(r => r.rollModel === task.materialModel && r.currentRemainingLength > 0);
        if (roll) {
            if (![...el('sel-mother-roll-id').options].some(o => o.value === roll.rollId)) el('sel-mother-roll-id').add(new Option(roll.rollId, roll.rollId));
            el('sel-mother-roll-id').value = roll.rollId;
        }
        await switchCutMode('roll');
        if (task.process) {
            const p = task.process;
            Object.assign(data, {bedL: Math.min(p.bedLength, data.stockRemainingLength), trimStart:p.trimStart, cutOrigin:p.cutOrigin,
                firstStageOrientation:p.firstStageOrientation, allowRotation:p.allowRotation, allowLongitudinal:p.allowLongitudinal});
            updateUIInfo(); renderScene(); resetToBedView();
        }
        updateDemandCompletionFromPieces(data);
        renderDemandsUI(data.demands);
        el('task-state').textContent = '已保存 · ' + task.id.slice(0, 8);
        el('task-report-count').textContent = detail.reports.length;
        el('task-picker').close();
        localStorage.setItem('cutting-task-id', task.id);
        el('task-details').open = false;
        el('task-details-title').textContent = task.name;
        el('preset-current-label').textContent = '载入示例需求';
    } catch (error) { showToast(error.message, 'error'); }
}

export async function matchTaskMaterials() {
    const demands = getDemandsFromUI().filter(d => d.demand > 0).map(({ count, ...d }) => d);
    if (!demands.length) return showToast('请先填写待切需求', 'warning');
    picker('选择本次用料', '<p class="muted">正在匹配库存…</p>');
    try {
        const candidates = await api('/api/cutting/material-candidates', {
            rollModel: el('task-material').value, demands,
            allowRotation: el('sel-allow-rotation').value === '1', allowLongitudinal: el('sel-allow-longitudinal').value === '1'
        });
        picker('选择本次用料', `<p class="muted">同型号料头优先列出。尺寸可容纳部分需求，具体产出与避疵结果以排料方案为准。</p>` + ['remnant', 'roll'].map(type => `<h3>${type === 'remnant' ? '可用料头' : '可用母卷'}</h3>` + (candidates.filter(c => c.type === type).map(c => `<button class="task-list-item" data-source="${escapeText(c.id)}"><strong>${escapeText(c.id)} <small>${c.fittingLines} 项尺寸可容纳</small></strong><span>${c.width} × ${c.length} mm · ${escapeText(c.location)}${c.hasDefect ? ' · 需避疵' : ''}</span><small>选择${type === 'remnant' ? '此料头' : '此母卷'}</small></button>`).join('') || '<p class="muted">暂无匹配材料</p>')).join(''));
        el('task-picker-body').querySelectorAll('[data-source]').forEach(button => button.onclick = async () => {
            button.disabled = true;
            try {
                const selected = candidates.find(c => c.id === button.dataset.source);
                if (selected.type === 'remnant') {
                    const remnant = await api('/api/remnants/scan', {id:selected.id});
                    if (!remnant) throw new Error('料头已不可用，请重新匹配');
                    await switchCutMode('remnant', remnant);
                } else {
                    if (![...el('sel-mother-roll-id').options].some(o => o.value === selected.id)) el('sel-mother-roll-id').add(new Option(selected.id, selected.id));
                    el('sel-mother-roll-id').value = selected.id;
                    await switchCutMode('roll');
                }
                el('task-picker').close();
            } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
        });
    } catch (error) { picker('选择本次用料', `<p role="alert">${escapeText(error.message)}</p>`); }
}

export function openTaskReports() {
    picker('报工记录与需求汇总', `<div class="report-progress">${state.getCurrentCaseData().demands.map(d => `<p><strong>${escapeText(d.name)}</strong><span>${state.taskCompleted[d.id] || 0} / ${d.count ?? d.demand} 件</span></p>`).join('')}</div>` + (state.taskReports.slice().reverse().map(r => `<article class="task-list-item"><strong>${escapeText(r.sourceRemnantId || r.rollId)}</strong><span>合格 ${r.finishedPieceCount} 件 · ${r.feedPortType === 'remnant' ? '料头核销' : `用料 ${r.actualCutLen} mm`} · 回收 ${r.derivedRemnants.length} 块</span><small>${escapeText(new Date(r.confirmedAt).toLocaleString("zh-CN", {hour12:false}))}</small><details class="detail-disclosure"><summary>回收清单与凭证</summary>${r.derivedRemnants.map(rem => `<p>${escapeText(rem.id)} · ${rem.width} × ${rem.length} mm · ${escapeText(rem.location)}</p>`).join("")}<small>报工编号 ${escapeText(r.planId)}</small></details></article>`).join('') || '<p class="muted">暂无报工。排料预览不会扣减需求或库存。</p>'));
}

export async function initTaskWorkspace() {
    const rolls = await api('/api/rolls');
    el('task-material').replaceChildren(...[...new Set(rolls.map(r => r.rollModel))].map(model => new Option(model, model)));
    el('sel-mother-roll-id').replaceChildren(...rolls.map(r => new Option(`${r.rollId} (${r.width} mm)`, r.rollId)));
    const saved = localStorage.getItem('cutting-task-id');
    if (saved) await loadTask(saved);
    else {
        state.getCurrentCaseData().demands = [];
        state.getCurrentCaseData().pieces = [];
        await newCuttingTask();
    }
}
