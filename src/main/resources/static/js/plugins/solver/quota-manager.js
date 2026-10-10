/**
 * 需求配额核销与工位加工区间管理器 (Quota & Interval Manager Plugin)
 */
import {queuedReports} from './report-queue.js';
import { state } from '../../core/state.js';
import {renderMaterialInspection} from '../layout/workbench-panels.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { renderRadar, requireStationReport, updateFabricScrollPosition } from '../radar/radar-scrubber.js';
import { updateUIInfo, updateWorkflowControls } from './solver-client.js';
import { showToast, confirmAction } from '../../core/toast.js';
import { escapeText, taskInputChanged, startTaskDraft, finishTaskDraft, prepareTaskSwitch } from './task-workspace.js';
import { layoutMetrics } from './material-accounting.js';
import { CURTAIN_ORDER_TEMPLATES, getInitialScenarios } from '../presets/scenarios.js';

export function updateDemandCompletionFromPieces(data) {
    if (!data || !data.demands) return;
    data.demands.forEach((d, index) => {
        d.id ||= index + 1;
        d.completed = state.taskCompleted[d.id] || 0;
        d.remaining = Math.max(0, (d.count ?? d.demand ?? 1) - d.completed);
    });
}

export function addOrMergeInterval(intervals, start, end) {
    const list = [...(intervals || []), { start, end }];
    list.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const cur of list) {
        if (merged.length === 0) {
            merged.push({ start: cur.start, end: cur.end });
        } else {
            const prev = merged[merged.length - 1];
            if (cur.start <= prev.end) {
                prev.end = Math.max(prev.end, cur.end);
            } else {
                merged.push({ start: cur.start, end: cur.end });
            }
        }
    }
    return merged;
}

export function recalculateRollStats(data) {
    if (!data) return;
    Object.assign(data, layoutMetrics(data, {sheet:state.currentCutMode === 'remnant'}));
    data.globalMaxCutY = Math.max(0, ...(data.pieces || []).map(p => p.y + p.l));
}

export function clearStationCuts() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const isRemnantMode = (state.currentCutMode === "remnant");

    if (isRemnantMode) {
        const removedPieces = (data.pieces || []).length;
        data.pieces = (data.pieces || []).filter(p => p.confirmed || p.queued);
        data.cuts = [];
        data.remnants = (data.remnants || []).filter(r => r.confirmed || r.queued);
        data.cutIntervals = [];
        data.deductLen = 0;
        data.pieceArea = 0;
        data.remArea = 0;
        data.wasteArea = 0;
        data.totalArea = ((data.rollW || 2000) * (data.bedL || 1000)) / 1000000.0;
        data.lastReceipt = null;
        state.pendingPlan = null;

        if (!data.demands || data.demands.length === 0) {
            if (window.camApp && typeof window.camApp.getRemnantDemandsFromUI === 'function') {
                data.demands = window.camApp.getRemnantDemandsFromUI();
            }
        }
        updateDemandCompletionFromPieces(data);
        if (window.clearRemnantSelection) {
            window.clearRemnantSelection();
        }
        renderScene();
        drawRulers();
        updateUIInfo();
        if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
            window.camApp.renderToolpathUI();
        }

        showToast('已清除未报工预览，可从方案记录恢复；库存与报工保留', 'info');
        return;
    }

    const winStartY = parseFloat(document.getElementById("inp-window-start-y").value) || data.windowStartY || 0;
    const bedL = parseFloat(document.getElementById("inp-bed-l").value) || data.bedL || 5000;
    const winEndY = winStartY + bedL;

    const isPieceInCurrentStation = (p) => {
        const pMid = p.y + p.l / 2;
        return (pMid >= winStartY && pMid < winEndY);
    };
    const oldCount = (data.pieces || []).length;
    data.pieces = (data.pieces || []).filter(p => p.confirmed || p.queued || !isPieceInCurrentStation(p));
    const removedPieces = oldCount - data.pieces.length;

    // 清空切刀：CNC 数控切刀严格属于当前工位
    data.cuts = [];
    state.setCutStepLimit(999);
    state.pendingPlan = null;

    const isRemInCurrentStation = (r) => {
        const rMid = r.y + r.l / 2;
        return (rMid >= winStartY && rMid < winEndY);
    };
    data.remnants = (data.remnants || []).filter(r => r.confirmed || !isRemInCurrentStation(r));

    if (data.cutIntervals) {
        data.cutIntervals = data.cutIntervals.filter(inv => inv.end <= winStartY || inv.start >= winEndY);
    }

    recalculateRollStats(data);
    updateDemandCompletionFromPieces(data);

    renderDemandsUI(data.demands);
    if (window.clearRemnantSelection) {
        window.clearRemnantSelection();
    }
    renderScene();
    drawRulers();
    updateUIInfo();
    if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
        window.camApp.renderToolpathUI();
    }

    showToast('已清除本工位未报工预览，可从方案记录恢复；库存与报工保留', 'info');
}

export function resetAllRollCuts() {
    const data = state.getCurrentCaseData();
    data.pieces = (data.pieces || []).filter(p => p.confirmed || p.queued);
    data.remnants = (data.remnants || []).filter(r => r.confirmed || r.queued);
    data.cuts = []; state.pendingPlan = null;
    recalculateRollStats(data); updateDemandCompletionFromPieces(data);
    renderDemandsUI(data.demands); renderScene(); updateUIInfo();
    showToast('已清除未报工预览，库存与报工记录保留', 'info');
}

export async function resetContinuousCutting() {
    if(queuedReports().length){showToast('请先处理待报工工位，再重置库存。','warning');return;}
    const isRemnantMode = (state.currentCutMode === 'remnant');
    if (isRemnantMode) {
        showToast('当前处于料头模式，可切换为母卷开卷排产模式进行连续搭切', 'info');
        return;
    }
    const data = state.getCurrentCaseData();
    if (!data) return;
    const rollId = data.rollId || (document.getElementById("sel-mother-roll-id")?.value) || "ROLL-2026-0920";

    const ok = await confirmAction(
        `确定要重置当前母卷（${escapeText(rollId)}）的搭切进度吗？\n这将清空本卷已报工与实切记录，将工位回到 0m 起点，恢复整卷可用长度，方便重新从头搭切。`,
        { title: '重新搭切确认', action: '重置并重新搭切' }
    );
    if (!ok) return;

    const wasInert = document.body.inert;
    document.body.inert = true;
    try {
        const response = await fetch(`/api/rolls/${encodeURIComponent(rollId)}/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true })
        });
        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.message || '重置母卷失败');
        }

        const rollResp = await fetch(`/api/rolls/${encodeURIComponent(rollId)}`, { cache: 'no-store' });
        let roll = null;
        if (rollResp.ok) {
            roll = await rollResp.json();
        }

        data.pieces = [];
        data.cuts = [];
        data.remnants = [];
        data.cutIntervals = [];
        data.lastReceipt = null;
        data.deductLen = 0;
        data.pieceArea = 0;
        data.remArea = 0;
        data.wasteArea = 0;
        data.stockUsedLength = 0;
        if (roll) {
            data.stockRemainingLength = roll.currentRemainingLength;
            data.totalRollL = roll.totalLength;
            data.rollW = roll.width;
        } else {
            data.stockRemainingLength = data.totalRollL || 60000;
        }
        state.lastCutReceipt = null;
        state.pendingPlan = null;
        state.setCutStepLimit(999);

        data.windowStartY = 0;
        updateFabricScrollPosition(0);

        const currentCaseId = state.currentCaseId;
        const initialScenarios = getInitialScenarios();
        if (initialScenarios && initialScenarios[currentCaseId]) {
            const initCase = initialScenarios[currentCaseId];
            if (initCase.demands) {
                data.demands = JSON.parse(JSON.stringify(initCase.demands)).map(d => ({
                    ...d,
                    completed: 0
                }));
            }
        } else if (data.demands) {
            data.demands.forEach(d => { d.completed = 0; });
        }
        state.taskCompleted = {};

        const totalL = data.totalRollL || (roll ? roll.totalLength : 60000);
        const totalLenEl = document.getElementById('lbl-roll-total-len');
        if (totalLenEl) totalLenEl.innerText = totalL.toLocaleString();
        const remLenEl = document.getElementById('lbl-roll-remaining-len');
        if (remLenEl) remLenEl.innerText = `${totalL.toLocaleString()} mm`;
        const usedLenEl = document.getElementById('lbl-roll-used-len');
        if (usedLenEl) usedLenEl.innerText = '0 mm';
        const progressEl = document.getElementById('roll-len-progress');
        if (progressEl) progressEl.style.width = '0%';
        const baseOriginEl = document.getElementById('lbl-roll-base-origin');
        if (baseOriginEl) baseOriginEl.innerText = 'Y = 0 mm (0.00m)';
        const remaining = document.getElementById('lbl-roll-remaining');
        if (remaining) remaining.innerText = `${totalL} mm`;

        recalculateRollStats(data);
        updateDemandCompletionFromPieces(data);
        renderDemandsUI(data.demands);
        renderRadar();
        renderScene();
        resetToBedView();
        updateUIInfo();
        updateWorkflowControls();

        if (window.camApp && typeof window.camApp.updateMotherRollRemnantStats === 'function') {
            await window.camApp.updateMotherRollRemnantStats(rollId);
        }
        if (window.camApp && typeof window.camApp.refreshShelfRemnantsList === 'function') {
            await window.camApp.refreshShelfRemnantsList();
        }
        if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
            window.camApp.renderToolpathUI();
        }

        bus.emit('demands:changed');
        showToast(`已重置母卷搭切进度，回到第 1 工位（0~${((data.bedL || 5000) / 1000).toFixed(1)}m），可重新开始排料`, 'success');
    } catch (err) {
        showToast(`重置搭切失败：${err.message}`, 'error');
    } finally {
        document.body.inert = wasInert;
    }
}

export function renderDemandsUI(demands) {
    const container = document.getElementById("demands-container");
    if (!container) return;
    container.innerHTML = "";
    if (!demands || demands.length === 0) {
        container.innerHTML = '<div class="demand-entry-empty"><strong>添加这次任务要裁切的需求</strong><p>导入订单文件、使用 9.28 样例，或点击「添加需求」手动填写。</p></div>';
        const badge = document.getElementById("demands-summary-badge");
        if (badge) badge.innerText = "0 件";
        updateWorkflowControls();
        return;
    }

    demands.forEach((dem, idx) => {
        const row = document.createElement("div");
        row.className = "item-row";
        const wVal = dem.w !== undefined ? dem.w : (dem.width !== undefined ? dem.width : 500);
        const lVal = dem.l !== undefined ? dem.l : (dem.length !== undefined ? dem.length : 500);
        const totalCount = dem.count !== undefined ? dem.count : (dem.demand !== undefined ? dem.demand : 1);
        const completed = dem.completed !== undefined ? dem.completed : 0;

        row.setAttribute("data-id", dem.id || idx + 1);
        row.dataset.rotation = String(Boolean(dem.allowRotation));
        row.setAttribute("data-completed", completed);
        row.setAttribute("data-total", totalCount);

        row.innerHTML = `
            <div class="item-row-header" style="display:flex; justify-content:space-between; align-items:center;">
                <input type="text" class="dem-name" aria-label="裁片名称" value="${escapeText(dem.name || ('裁片-' + (idx + 1)))}" style="font-weight:600; flex:1; margin-right:6px;" onchange="window.camApp.onParamChange()">
                <button class="del-btn" onclick="window.camApp.removeDemandRow(this)" title="删除此裁片需求" style="margin-left:6px;">×</button>
            </div>
            <div class="mini-input-group" style="margin-top:4px;">
                <label>宽 <input type="number" class="mini-input dem-w" aria-label="裁片宽度 (mm)" value="${wVal}" onchange="window.camApp.onParamChange()" style="width:58px;"></label>
                <label>长 <input type="number" class="mini-input dem-l" aria-label="裁片长度 (mm)" value="${lVal}" onchange="window.camApp.onParamChange()" style="width:58px;"></label>
                <label>件数 <input type="number" class="mini-input dem-count" value="${totalCount}" min="1" style="width:48px;" onchange="window.camApp.onParamChange()" title="总计划需求件数"></label>
            </div>
            <div class="demand-status"></div>
            <div class="demand-remnant-box" id="rem-hint-${idx}" style="display: none;"></div>
        `;
        container.appendChild(row);
    });

    updateWorkflowControls();
}

function defectRow(d, open = false) {
    d=Object.fromEntries(['id','x','y','w','h','margin'].map(key=>[key,Number(d[key] ?? (key==='margin'?20:0))]));
    const row=document.createElement('details');row.className='item-row defect-editor-row';row.dataset.id=d.id;row.open=open;
    row.innerHTML='<summary><strong>#'+d.id+'</strong><span>X '+d.x+' / Y '+d.y+'</span><span>'+d.w+' × '+d.h+' mm</span><span>避让 '+(d.margin ?? 20)+' mm</span><small>编辑 ▾</small></summary><div class="defect-editor-fields">'+
        [['x','幅宽位置 X'],['y','长向位置 Y'],['w','疵点宽度'],['h','疵点长度'],['margin','避让余量']].map(([key,label])=>'<label>'+label+' (mm)<input type="number" min="0" class="mini-input d-'+key+'" value="'+(d[key] ?? 20)+'" onchange="window.camApp.onParamChange()"></label>').join('')+
        '<button class="tool-btn" onclick="this.closest(\'.item-row\').remove(); window.camApp.onParamChange();">删除此疵点</button></div>';
    return row;
}
export function renderDefectsUI(defects) {
    const container=document.getElementById('defects-container');if(!container)return;
    container.replaceChildren(...(defects || []).map((d,i)=>defectRow({...d,id:d.id || i+1})));
    if(!defects?.length)container.innerHTML='<p class="muted">未登记疵点；可在上方添加。</p>';
    const tag=document.getElementById('tag-defects-summary');if(tag)tag.textContent='共 '+(defects || []).length+' 处';
}
export function addDefectRow() {
    const container=document.getElementById('defects-container');
    if(!container.querySelector('.item-row'))container.replaceChildren();
    const id=Math.max(1,...[...container.querySelectorAll('.item-row')].map(r=>Number(r.dataset.id)+1));
    const row=defectRow({id,x:200,y:1000,w:150,h:200,margin:Number(localStorage.getItem('cam_margin') ?? 20)},true);
    container.append(row);onParamChange();row.querySelector('input').focus();
}

export function removeDemandRow(button) {
    const row = button.closest('.item-row');
    const container = document.getElementById('demands-container');
    const index = [...container.children].indexOf(row), removed = row.cloneNode(true);
    document.getElementById('demand-undo')?.remove();
    row.remove(); onParamChange();
    const notice = document.createElement('div'); notice.id = 'demand-undo'; notice.setAttribute('role', 'status');
    const label = document.createElement('span'); label.textContent = '已移除需求';
    const undo = document.createElement('button'); undo.className = 'tool-btn'; undo.textContent = '撤销删除';
    undo.onclick = () => {
        if (!container.querySelector(`.item-row[data-id="${Number(removed.dataset.id)}"]`)) {
            if (!container.querySelector('.item-row')) container.replaceChildren();
            container.insertBefore(removed, container.children[index] || null); onParamChange();
        }
        notice.remove();
    };
    notice.append(label, undo); container.before(notice);
}

export function addDemandRow() {
    window.camApp?.openDemandManager?.();
    const container = document.getElementById("demands-container");
    if (!container.querySelector('.item-row')) container.replaceChildren();
    const id = Math.max(state.nextDemandId, 1, ...[...container.querySelectorAll('.item-row')].map(row => Number(row.dataset.id) + 1));
    state.nextDemandId = id + 1;
    const row = document.createElement("div");
    row.className = "item-row";
    row.setAttribute("data-id", id);
    row.setAttribute("data-completed", 0);
    row.setAttribute("data-total", 1);
    row.dataset.rotation = 'false';
    row.innerHTML = `
        <div class="item-row-header" style="display:flex; justify-content:space-between; align-items:center;">
            <input type="text" class="dem-name" aria-label="裁片名称" value="裁片-${container.querySelectorAll('.item-row').length + 1}" onchange="window.camApp.onParamChange()">
            <button class="del-btn" onclick="window.camApp.removeDemandRow(this)" title="删除此裁片需求">×</button>
        </div>
        <div class="mini-input-group">
            <label>宽 <input type="number" class="mini-input dem-w" aria-label="裁片宽度 (mm)" placeholder="填写宽度" onchange="window.camApp.onParamChange()"></label>
            <label>长 <input type="number" class="mini-input dem-l" aria-label="裁片长度 (mm)" placeholder="填写长度" onchange="window.camApp.onParamChange()"></label>
            <label>件数 <input type="number" class="mini-input dem-count" value="1" min="1" onchange="window.camApp.onParamChange()" title="总计划需求件数"></label>
        </div>
        <span class="demand-status"></span><div class="demand-remnant-box" id="rem-hint-new-${id}" style="display:none;"></div>
    `;
    container.appendChild(row);
    onParamChange();
    row.querySelector('.dem-w').focus();
}

export function getDefectsFromUI() {
    const list = [];
    const rows = document.querySelectorAll("#defects-container .item-row");
    rows.forEach((r, idx) => {
        const id = parseInt(r.getAttribute("data-id")) || (idx + 1);
        const x = parseFloat(r.querySelector(".d-x").value) || 0;
        const y = parseFloat(r.querySelector(".d-y").value) || 0;
        const w = parseFloat(r.querySelector(".d-w").value) || 100;
        const h = parseFloat(r.querySelector(".d-h").value) || 100;
        const marginValue = Number(r.querySelector(".d-margin").value);
        const margin = Number.isFinite(marginValue) ? marginValue : 20;
        list.push({ id, x, y, w, h, margin });
    });
    return list;
}

export function getDemandsFromUI() {
    const list = [];
    const rows = document.querySelectorAll("#demands-container .item-row");
    rows.forEach((r, idx) => {
        const id = Number(r.dataset.id) || idx + 1;
        const name = (r.querySelector(".dem-name") ? r.querySelector(".dem-name").value.trim() : "") || ("裁片-" + id);
        const width = Number(r.querySelector(".dem-w")?.value);
        const length = Number(r.querySelector(".dem-l")?.value);
        const totalCount = Number(r.querySelector(".dem-count")?.value);
        const completed = parseInt(r.getAttribute("data-completed")) || 0;
        const remaining = Math.max(0, totalCount - completed);
        list.push({
            id,
            name,
            w: width,
            l: length,
            width: width,
            length: length,
            count: totalCount,
            demand: remaining,
            completed: completed,
            allowRotation: r.dataset.rotation === "true"
        });
    });
    return list;
}

export function updateOriginHeaderSummary() {
    const data = state.getCurrentCaseData();
    const headerTag = document.getElementById("tag-cut-origin-header");
    if (!headerTag || !data) return;
    const val = data.cutOrigin || "right-bottom";
    const bedL = data.bedL || 5000;
    let name = "右下角";
    let color = "#10b981";
    if (val === "right-bottom") { name = "右下角"; color = "#10b981"; }
    else if (val === "right-top") { name = "右上角"; color = "#38bdf8"; }
    else if (val === "left-bottom") { name = "左下角"; color = "#f59e0b"; }
    else { name = "左上角"; color = "#a855f7"; }
    headerTag.innerText = `${name} · ${bedL}mm`;
    headerTag.style.color = color;
}

export function onRollConfigChange() {
    if (state.pendingPlan) {
        updateUIInfo();
        requireStationReport();
        return;
    }
    state.pendingPlan = null;
    const data = state.getCurrentCaseData();
    data.totalRollL = parseFloat(document.getElementById("inp-total-roll-l").value) || 60000;
    data.bedL = parseFloat(document.getElementById("inp-bed-l").value) || 5000;
    data.windowStartY = parseFloat(document.getElementById("inp-window-start-y").value) || 0;
    data.rollW = parseFloat(document.getElementById("inp-roll-w").value) || 2000;

    const wLbl = document.getElementById("lbl-roll-w-desc");
    if (wLbl) wLbl.innerText = data.rollW;
    const totalLenEl = document.getElementById("lbl-roll-total-len");
    if (totalLenEl) totalLenEl.innerText = data.totalRollL.toLocaleString();

    updateOriginHeaderSummary();
    renderScene();
    renderRadar();
    resetToBedView();
}

export function onOriginParamChange() {
    state.pendingPlan = null;
    const data = state.getCurrentCaseData();
    data.trimStart = parseFloat(document.getElementById("inp-trim-start").value) || 0;
    data.cutOrigin = document.getElementById("sel-cut-origin").value || "right-bottom";
    data.firstStageOrientation = document.getElementById("sel-first-stage").value;
    data.allowRotation = (document.getElementById("sel-allow-rotation").value === "1");
    data.globalDefects = getDefectsFromUI();
    if (document.getElementById('material-manager-modal')?.open) renderMaterialInspection();
    const tagDefects=document.getElementById('tag-defects-summary');
    if(tagDefects)tagDefects.textContent='共 '+data.globalDefects.length+' 处';
    renderRadar();

    updateOriginHeaderSummary();

    const descTip = document.getElementById("lbl-origin-desc-tip");
    const val = data.cutOrigin;
    if (descTip) {
        if (val === "right-bottom") {
            descTip.innerText = "工业推荐：右下角原点 (靠右导轨量幅宽，落料口自下而上起切，刀路最优距离起刀)";
        } else if (val === "right-top") {
            descTip.innerText = "右上角原点 (靠右导轨量幅宽，顺流进料顺切)";
        } else if (val === "left-bottom") {
            descTip.innerText = "左下角原点 (靠左布边量幅宽，落料口自下而上起切)";
        } else {
            descTip.innerText = "标准CAM：左上角原点 (靠左量幅宽，顺流自上而下进料顺切)";
        }
    }

    renderScene();
}

export function onParamChange() {
    onOriginParamChange();
    taskInputChanged();
    const data = state.getCurrentCaseData();
    if (data) {
        data.demands = getDemandsFromUI();
        updateDemandCompletionFromPieces(data);
    }
    bus.emit('demands:changed');
}

export function updateRollSize() {
    onRollConfigChange();
}

export function toggleLongitudinal() {
    state.pendingPlan = null;
    const allow = (document.getElementById("sel-allow-longitudinal").value === "1");
    state.getCurrentCaseData().allowLongitudinal = allow;
    if (!allow && state.currentCaseId === 2) {
        showToast("【安全拦截触发】当前设备被设定为【仅能横切】，系统严禁下发需要纵切才能完成的改宽方案，保护原料不被误切！", "warning");
    }
}

/**
 * 一键载入真实窗帘整单订单模板 (Quick Order Templates)
 */
export async function loadCurtainOrderTemplate(templateKey) {
    if (!templateKey) return;
    const tpl = CURTAIN_ORDER_TEMPLATES[templateKey];
    if (!tpl) return;
    if (!await prepareTaskSwitch()) return;
    startTaskDraft(tpl.name);
    const isRemnant = (state.currentCutMode === "remnant");

    const newDemands = tpl.demands.map((d, idx) => ({
        id: idx + 1,
        name: d.name,
        width: d.width,
        w: d.width,
        length: d.length,
        l: d.length,
        count: d.count || 1,
        demand: d.count || 1,
        completed: 0
    }));

    if (isRemnant) {
        if (window.camApp && typeof window.camApp.renderRemnantDemandsUI === 'function') {
            window.camApp.renderRemnantDemandsUI(newDemands);
        }
    } else {
        const data = state.getCurrentCaseData();
        if (data) {
            data.demands = JSON.parse(JSON.stringify(newDemands));
            renderDemandsUI(data.demands);
        }
    }

    showToast(`已成功载入窗帘订单模板: ${tpl.name} (${newDemands.length} 项规格)，请选择材料后排料`, "info");

    const sel = document.getElementById("sel-curtain-order-template");
    if (sel) sel.value = "";
    const selRem = document.getElementById("sel-remnant-order-template");
    if (selRem) selRem.value = "";

    finishTaskDraft();
}

