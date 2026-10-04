import { state } from '../../core/state.js';
import { getInitialScenarios } from '../presets/scenarios.js';
import { renderDemandsUI, getDemandsFromUI, updateDemandCompletionFromPieces } from './quota-manager.js';
import { switchCutMode } from '../remnant/remnant-shelf.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { renderRadar } from '../radar/radar-scrubber.js';
import { updateUIInfo, updateWorkflowControls, resetSolveFeedback, restoreSavedPlan } from './solver-client.js';
import { showToast, confirmAction } from '../../core/toast.js';
import { syncMaterialOptions } from '../material/material-options.js';
import { createDraftStore } from './task-drafts.js';

export const escapeText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const el = id => document.getElementById(id);
const DRAFT_ACTIVE = 'cutting-demand-draft-active';
const processFields = ['inp-bed-l', 'inp-trim-start', 'sel-cut-origin', 'sel-first-stage', 'sel-allow-rotation', 'sel-allow-longitudinal'];
let draftId = null, draftBaseline = '', draftReady = false, draftDirty = false, draftStored = false;
let switchPrompt = false;
const draftStore = () => createDraftStore(localStorage);

// Keep raw form values, including incomplete numeric fields; a draft is not a valid saved task.
function draftSnapshot() {
    return {
        task: {id:state.activeTask?.id, revision:state.activeTask?.revision || 0,
            name:el('task-name').value, materialModel:el('task-material').value, externalRef:el('task-external-ref').value,
            fields:Object.fromEntries(processFields.map(id => [id, el(id).value])),
            demands:[...document.querySelectorAll('#demands-container .item-row')].map(row => ({
                id:Number(row.dataset.id), name:row.querySelector('.dem-name').value,
                width:row.querySelector('.dem-w').value, length:row.querySelector('.dem-l').value,
                quantity:row.querySelector('.dem-count').value, allowRotation:row.dataset.rotation === 'true'
            }))},
        source: {mode:state.currentCutMode, rollId:state.getCurrentCaseData().rollId, remnantId:state.loadedRemnant?.id}
    };
}

function updateDraftCount() {
    try { if (el('btn-local-drafts')) el('btn-local-drafts').textContent = `本机草稿 ${draftStore().list().length}`; } catch { /* Saving reports storage failure separately. */ }
}

function clearActiveDraft() {
    draftStore().remove(draftId);
    if (localStorage.getItem(DRAFT_ACTIVE) === draftId) localStorage.removeItem(DRAFT_ACTIVE);
}

function resetDraftTracking() {
    draftId = null; draftDirty = false; draftStored = false;
    draftBaseline = JSON.stringify(draftSnapshot().task); draftReady = true;
    try { localStorage.removeItem(DRAFT_ACTIVE); } catch { /* No draft exists yet. */ }
    el('demand-undo')?.remove();
    updateDraftCount();
}

export function persistTaskDraft() {
    if (!draftReady) return true;
    const snapshot = draftSnapshot();
    draftDirty = JSON.stringify(snapshot.task) !== draftBaseline;
    try {
        if (draftDirty) {
            draftId ||= crypto.randomUUID();
            draftStore().write({version:1, id:draftId, updatedAt:Date.now(), ...snapshot});
            localStorage.setItem(DRAFT_ACTIVE, draftId);
            draftStored = true;
            el('task-state').textContent = '本机草稿 · 未保存到服务器';
        } else {
            clearActiveDraft(); draftId = null; draftStored = false;
            el('task-state').textContent = state.activeTask ? '已保存 · ' + state.activeTask.id.slice(0,8) : '新任务 · 未保存';
        }
        updateDraftCount();
        return true;
    } catch {
        draftStored = false;
        el('task-state').textContent = '需求未保存 · 本机草稿保存失败';
        return false;
    }
}

export async function prepareTaskSwitch() {
    if (!draftReady) return true;
    persistTaskDraft();
    if (!draftDirty) return true;
    if (switchPrompt) return false;
    switchPrompt = true;
    try {
        const choice = await new Promise(resolve => {
            const dialog = document.createElement('dialog'); dialog.className = 'action-dialog draft-switch-dialog';
            dialog.innerHTML = '<h2>当前需求尚未保存</h2><p>可以保存到服务器，或保留在本机草稿中稍后继续。</p><div class="dialog-actions"></div>';
            for (const [value, label] of [['cancel','继续编辑'], ['discard','放弃修改'], ['keep','保留草稿并继续'], ['save','保存并继续']]) {
                const button = document.createElement('button'); button.className = 'tool-btn' + (value === 'save' ? ' active' : '');
                button.textContent = label; button.onclick = () => dialog.close(value);
                dialog.querySelector('.dialog-actions').append(button);
            }
            dialog.addEventListener('close', () => { resolve(dialog.returnValue); dialog.remove(); }, {once:true});
            document.body.append(dialog); dialog.showModal(); dialog.querySelector('button').focus();
        });
        if (choice === 'save') { await saveCurrentTask(); return true; }
        if (choice === 'keep') {
            if (!persistTaskDraft()) throw new Error('本机草稿保存失败，请先保存到服务器，或继续编辑');
            return true;
        }
        if (choice === 'discard') { clearActiveDraft(); updateDraftCount(); return true; }
        return false;
    } catch (error) { showToast(error.message, 'error'); return false; }
    finally { switchPrompt = false; }
}

export async function openLocalDrafts() {
    try {
        persistTaskDraft();
        const drafts = draftStore().list();
        picker('本机需求草稿', '<p class="muted">仅保存在当前浏览器；恢复后仍需保存需求。材料可用量与已报工数量会重新读取。</p>' +
            (drafts.map(d => `<button class="task-list-item" data-draft="${escapeText(d.id)}"><strong>${escapeText(d.task.name || '未命名需求')}</strong><span>${d.task.demands.length} 项需求 · ${escapeText(new Date(d.updatedAt).toLocaleString('zh-CN', {hour12:false}))}</span><small>恢复草稿</small></button>`).join('') || '<p class="muted">暂无本机草稿</p>'));
        el('task-picker-body').querySelectorAll('[data-draft]').forEach(button => button.onclick = () => restoreTaskDraft(button.dataset.draft));
    } catch (error) { showToast(error.message, 'error'); }
}

async function restoreTaskDraft(id, initial = false) {
    if (!initial && id === draftId) { el('task-picker').close(); return true; }
    if (!initial && !await prepareTaskSwitch()) return false;
    const wasInert = document.body.inert; document.body.inert = true;
    try {
        const draft = draftStore().read(id);
        if (!draft) throw new Error('草稿不存在或格式不支持，原数据已保留');
        let current;
        if (draft.task.id) {
            const response = await fetch('/api/cutting/tasks/' + encodeURIComponent(draft.task.id), {cache:'no-store'});
            if (response.ok) current = await response.json();
            else if (response.status !== 404) throw new Error('无法核对原任务版本，请稍后重试');
        }
        const conflict = draft.task.id && (!current || current.task.revision !== draft.task.revision);
        if (current && !conflict) {
            if (!await loadTask(draft.task.id, {skipDraftGuard:true, detail:current})) return false;
        } else if (!await newCuttingTask(undefined, {skipDraftGuard:true})) { return false; }
        draftReady = false;
        const task = draft.task, data = state.getCurrentCaseData();
        el('task-name').value = task.name + (conflict ? '（草稿副本）' : '');
        el('task-external-ref').value = task.externalRef || '';
        if (![...el('task-material').options].some(o => o.value === task.materialModel)) el('task-material').add(new Option(task.materialModel,task.materialModel));
        el('task-material').value = task.materialModel;
        data.demands = task.demands.map(d => ({...d, width:Number(d.width), w:Number(d.width), length:Number(d.length), l:Number(d.length), count:Number(d.quantity)}));
        state.nextDemandId = Math.max(0, ...data.demands.map(d => d.id)) + 1;
        renderDemandsUI(data.demands);
        // Only references are restored; never restore a stale stock snapshot or a report receipt.
        if (draft.source?.mode === 'remnant') {
            const stock = (await api('/api/remnants')).find(r => r.id === draft.source.remnantId && r.status === 'AVAILABLE' && r.materialBatch === task.materialModel);
            if (stock) await switchCutMode('remnant', stock);
            else { el('sel-mother-roll-id').value = ''; await switchCutMode('roll'); showToast('原料头已不可用，需求已恢复，请重新选择材料', 'warning'); }
        } else {
            const stock = (await api('/api/rolls')).find(r => r.rollId === draft.source?.rollId && r.rollModel === task.materialModel && r.currentRemainingLength > 0);
            el('sel-mother-roll-id').value = stock?.rollId || '';
            await switchCutMode('roll');
        }
        const fields = task.fields || {};
        Object.assign(data, {bedL:Number(fields['inp-bed-l']), trimStart:Number(fields['inp-trim-start']), cutOrigin:fields['sel-cut-origin'],
            firstStageOrientation:fields['sel-first-stage'], allowRotation:fields['sel-allow-rotation'] === '1', allowLongitudinal:fields['sel-allow-longitudinal'] === '1'});
        updateDemandCompletionFromPieces(data); renderDemandsUI(data.demands); updateUIInfo(); renderScene(); renderRadar(); resetToBedView();
        for (const field of processFields) if (fields[field] !== undefined) el(field).value = fields[field];
        [...el('demands-container').querySelectorAll('.item-row')].forEach((row, index) => {
            const d = task.demands[index];
            for (const [selector,key] of [['.dem-name','name'],['.dem-w','width'],['.dem-l','length'],['.dem-count','quantity']]) row.querySelector(selector).value = d[key];
        });
        state.pendingPlan = null; draftId = id; draftReady = true;
        el('task-details-title').textContent = el('task-name').value || '任务信息';
        el('task-details').open = true; el('task-picker').close();
        persistTaskDraft();
        showToast(conflict ? '原任务已变化，草稿已恢复为独立副本，避免覆盖新版本' : '已恢复本机需求草稿，请核对后保存', conflict ? 'warning' : 'info');
        return true;
    } catch (error) { showToast(error.message, 'error'); return false; }
    finally { draftReady = true; document.body.inert = wasInert; }
}
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
    resetSolveFeedback();
    el('task-state').textContent = '需求已修改 · 待保存';
    el('task-details-title').textContent = el('task-name').value || '任务信息';
    persistTaskDraft();
    updateWorkflowControls();
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
    draftReady = false;
    el('demand-undo')?.remove();
}

export function finishTaskDraft() { resetDraftTracking(); draftBaseline = ''; taskInputChanged(); }

export async function newCuttingTask(rolls, {skipDraftGuard = false} = {}) {
    if (!skipDraftGuard && !await prepareTaskSwitch()) return false;
    const wasInert = document.body.inert; document.body.inert = true;
    try {
    rolls = rolls || await api('/api/rolls');
    syncMaterialOptions(rolls, {model:''});
    startTaskDraft();
    state.scenarios = getInitialScenarios();
    state.currentCaseId = 1;
    state.getCurrentCaseData().demands = [];
    renderDemandsUI([]);
    await switchCutMode('roll');
    resetDraftTracking();
    el('task-name').focus();
    return true;
    } catch (error) { showToast(error.message, 'error'); return false; }
    finally { document.body.inert = wasInert; }
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
    const wasInert = document.body.inert; document.body.inert = true;
    savingTask = saveTaskSnapshot().catch(error => {
        persistTaskDraft();
        el('task-state').textContent = draftStored ? '服务器保存失败 · 本机草稿已保留' : '保存失败 · 请保留当前页面';
        throw error;
    });
    try { return await savingTask; } finally { savingTask = null; document.body.inert = wasInert; }
}
async function saveTaskSnapshot() {
    state.getCurrentCaseData().demands = getDemandsFromUI();
    const payload = taskPayload();
    const current = state.activeTask;
    const task = await api('/api/cutting/tasks', payload);
    if (current !== state.activeTask || JSON.stringify(payload) !== JSON.stringify(taskPayload())) throw new Error('保存期间需求已变化，请再次保存当前需求');
    state.activeTask = task;
    try { localStorage.setItem('cutting-task-id', task.id); clearActiveDraft(); }
    catch { showToast('需求已保存，但本机草稿清理失败，刷新后请核对任务版本', 'warning'); }
    try { await refreshTaskProgress(); }
    catch { showToast('需求已保存，报工进度暂时无法刷新，请稍后重试', 'warning'); }
    resetDraftTracking();
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
    updateWorkflowControls();
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

export async function loadTask(id, {skipDraftGuard = false, detail:loadedDetail} = {}) {
    if (!skipDraftGuard && !await prepareTaskSwitch()) return false;
    const wasInert = document.body.inert; document.body.inert = true;
    try {
        const detail = loadedDetail || await api('/api/cutting/tasks/' + encodeURIComponent(id));
        const rolls = await api('/api/rolls');
        draftReady = false;
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
            updateUIInfo(); renderScene(); renderRadar(); resetToBedView();
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
        resetDraftTracking();
        return true;
    } catch (error) { showToast(error.message, 'error'); return false; }
    finally { document.body.inert = wasInert; }
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

export async function openTaskReports() {
    try { await refreshTaskProgress(); } catch (error) { return showToast(error.message, 'error'); }
    picker('报工记录与需求汇总', `<div class="report-progress">${state.getCurrentCaseData().demands.map(d => `<p><strong>${escapeText(d.name)}</strong><span>${state.taskCompleted[d.id] || 0} / ${d.count ?? d.demand} 件</span></p>`).join('')}</div>` + (state.taskReports.slice().reverse().map(r => `<article class="task-list-item"><strong>${escapeText(r.sourceRemnantId || r.rollId)}</strong><span>合格 ${r.finishedPieceCount} 件 · 异常 ${r.rejectedPieceCount || 0} 件 · 未切 ${r.uncutPieceCount || 0} 件 · ${r.feedPortType === 'remnant' ? '料头核销' : `用料 ${r.actualCutLen} mm`} · 回收 ${r.derivedRemnants.length} 块</span><small>${escapeText(new Date(r.confirmedAt).toLocaleString("zh-CN", {hour12:false}))}</small><details class="detail-disclosure"><summary>回收清单与凭证</summary>${r.derivedRemnants.map(rem => `<p>${escapeText(rem.id)} · ${rem.width} × ${rem.length} mm · ${escapeText(rem.location)}</p>`).join("")}<small>报工编号 ${escapeText(r.planId)}</small></details></article>`).join('') || '<p class="muted">暂无报工。排料预览不会扣减需求或库存。</p>'));
    el('task-picker-body').querySelectorAll('article').forEach((article, index) => {
        const report = state.taskReports.slice().reverse()[index];
        if (report.pieceResults?.length) {
            const detail=document.createElement('details');detail.className='detail-disclosure';
            const summary=document.createElement('summary');summary.textContent='逐件结果与异常原因';detail.append(summary);
            for(const piece of report.pieceResults){const row=document.createElement('p');
                row.textContent='#'+piece.pieceId+' · 需求 '+piece.demandId+' '+piece.name+' · '+({QUALIFIED:'合格',REJECTED:'异常',UNCUT:'未切'}[piece.outcome] || piece.outcome)+(piece.reason?' · '+piece.reason:'');detail.append(row);}
            article.append(detail);
        }
        const status = document.createElement('p'); status.className = 'muted';
        if (report.status === 'REVERSED') {
            status.textContent = '已撤回 · ' + report.reversalReason; article.append(status); return;
        }
        const button = document.createElement('button'); button.className = 'tool-btn'; button.textContent = '撤回报工';
        button.disabled = !report.undo;
        button.title = report.undo ? '退回本次需求数量和库存，并保留原记录' : '历史记录没有撤回快照';
        button.onclick = async () => {
            if (!await prepareTaskSwitch()) return;
            const reason = await confirmAction('仅用于纠正误报。请确认现场实物与退回后的库存一致；已实际裁切的布料无法物理复原。派生料头已有后续流转时，需先撤回后续记录。', {title:'撤回本次报工', action:'确认撤回', reason:true});
            if (!reason) return;
            button.disabled = true;
            try {
                await api('/api/cutting/reports/' + encodeURIComponent(report.planId) + '/reverse', {reason});
                state.pendingPlan = null;
                await loadTask(state.activeTask.id, {skipDraftGuard:true});
                await openTaskReports();
                showToast('报工已撤回，库存和任务完成量已更新', 'success');
            } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
        };
        article.append(button);
    });
}

export async function openTaskPlans() {
    if (!state.activeTask) return showToast('请先保存或打开任务', 'info');
    picker('方案记录', '<p class="muted">读取中…</p>');
    try {
        const plans = await api('/api/cutting/tasks/' + encodeURIComponent(state.activeTask.id) + '/plans');
        picker('方案记录', '<p class="muted">预览不扣库存。取消后仍可恢复；恢复时会校验需求、材料和疵点是否变化。</p>' +
            (plans.slice().reverse().map(p => `<article class="task-list-item"><strong>${escapeText(p.request.sourceRemnantId || p.request.rollId)} · ${p.result.pieces.length} 件 · 版本 ${escapeText(p.version || 1)}</strong><span>${p.status === 'CANCELLED' ? '已取消' : '待报工'} · ${escapeText(new Date(p.createdAt).toLocaleString('zh-CN', {hour12:false}))}</span><small>方案 ${escapeText(p.id)}${p.parentPlanId ? ` · 调整自 ${escapeText(p.parentPlanId)}` : ''}</small><div class="dialog-actions"><button class="tool-btn" data-restore="${escapeText(p.id)}">恢复预览</button>${p.status === 'PENDING' ? `<button class="tool-btn" data-cancel="${escapeText(p.id)}">取消方案</button>` : ''}</div></article>`).join('') || '<p class="muted">暂无未报工方案</p>'));
        el('task-picker-body').querySelectorAll('[data-cancel]').forEach(button => button.onclick = async () => {
            if (state.pendingPlan?.result?.planId === button.dataset.cancel && !await prepareTaskSwitch()) return;
            button.disabled = true;
            try {
                await api('/api/cutting/plans/' + encodeURIComponent(button.dataset.cancel) + '/cancel', {});
                if (state.pendingPlan?.result?.planId === button.dataset.cancel) {
                    state.pendingPlan = null;
                    await loadTask(state.activeTask.id, {skipDraftGuard:true});
                }
                await openTaskPlans();
            } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
        });
        el('task-picker-body').querySelectorAll('[data-restore]').forEach(button => button.onclick = async () => {
            if (!await prepareTaskSwitch()) return;
            button.disabled = true;
            try {
                const saved = await api('/api/cutting/plans/' + encodeURIComponent(button.dataset.restore) + '/restore', {});
                if (!await loadTask(saved.request.taskId, {skipDraftGuard:true})) return;
                if (saved.request.feedPortType === 'remnant') {
                    const stock = await api('/api/remnants/scan', {id:saved.request.sourceRemnantId});
                    if (!stock) throw new Error('料头已不可用');
                    await switchCutMode('remnant', stock);
                } else {
                    const id = saved.request.rollId;
                    if (![...el('sel-mother-roll-id').options].some(o => o.value === id)) el('sel-mother-roll-id').add(new Option(id,id));
                    el('sel-mother-roll-id').value = id;
                    await switchCutMode('roll');
                }
                restoreSavedPlan(saved); el('task-picker').close();
                showToast('已恢复原方案，请核对后报工', 'success');
            } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
        });
    } catch (error) { picker('方案记录', `<p role="alert">${escapeText(error.message)}</p>`); }
}

export async function initTaskWorkspace() {
    let activeDraft;
    try { activeDraft = localStorage.getItem(DRAFT_ACTIVE); } catch { /* The storage warning appears on first edit. */ }
    const rolls = await api('/api/rolls');
    syncMaterialOptions(rolls, {model:''});
    const saved = localStorage.getItem('cutting-task-id');
    if (activeDraft && await restoreTaskDraft(activeDraft, true)) { /* The recovered draft is the active workspace. */ }
    else if (!saved || !await loadTask(saved)) {
        state.getCurrentCaseData().demands = [];
        state.getCurrentCaseData().pieces = [];
        await newCuttingTask(rolls);
    }
    const selector = '#task-name, #task-material, #task-external-ref, #demands-container input, ' + processFields.map(id => '#' + id).join(', ');
    document.addEventListener('input', event => { if (event.target.matches(selector)) taskInputChanged(); });
    document.addEventListener('change', event => { if (event.target.closest('#sidebar-left')) updateWorkflowControls(); });
    window.addEventListener('beforeunload', event => {
        if (draftDirty && !persistTaskDraft()) { event.preventDefault(); event.returnValue = ''; }
    });
}
