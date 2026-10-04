import { saveCurrentTask, refreshTaskProgress, escapeText } from './task-workspace.js';
import { createPlanHistory, planScene } from './plan-editing.js';
import { layoutMetrics, materialSummary } from './material-accounting.js';
import { renderWorkflowGuide, navigateWorkflowStage } from './workflow-guide.js';
import { requestJSON, ApiError, failurePresentation } from '../../core/api-request.js';
import { updateDemandProgress } from './demand-progress.js';
import { classifyReport, applyReportReceipt } from './report-outcomes.js';
import { renderReportPieces, readReportPieces, syncReportRemnants, readReportRemnants, reportPieceError } from './report-editor.js';
/**
 * 求解器通信与排料控制插件 (Solver Client Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { renderRadar, smartAdvanceBed } from '../radar/radar-scrubber.js';
import {
    updateDemandCompletionFromPieces, recalculateRollStats, updateOriginHeaderSummary,
    addOrMergeInterval, renderDemandsUI, renderDefectsUI,
    getDemandsFromUI, getDefectsFromUI
} from './quota-manager.js';
import { showToast } from '../../core/toast.js';
import { solverSettings } from '../settings/settings.js';
import { renderToolpathUI } from '../toolpath/toolpath-optimizer.js';
import { selectRemnant, clearRemnantSelection, hoverRemnant } from '../cad/cad-remnant-highlight.js';

export function updateUIInfo() {
    const data = state.getCurrentCaseData();
    if (!data) return;

    if (document.getElementById("inp-total-roll-l")) document.getElementById("inp-total-roll-l").value = data.totalRollL || 60000;
    if (document.getElementById("inp-bed-l")) document.getElementById("inp-bed-l").value = data.bedL || 5000;
    if (document.getElementById("inp-window-start-y")) document.getElementById("inp-window-start-y").value = data.windowStartY || 0;
    if (document.getElementById("inp-roll-w")) document.getElementById("inp-roll-w").value = data.rollW || 2000;

    if (document.getElementById("inp-trim-start")) document.getElementById("inp-trim-start").value = data.trimStart || 0;
    if (document.getElementById("sel-cut-origin")) document.getElementById("sel-cut-origin").value = data.cutOrigin || "right-bottom";
    if (document.getElementById("sel-first-stage")) document.getElementById("sel-first-stage").value = data.firstStageOrientation || "horizontal";
    if (document.getElementById("sel-allow-rotation")) document.getElementById("sel-allow-rotation").value = data.allowRotation ? "1" : "0";
    if (document.getElementById("sel-allow-longitudinal")) document.getElementById("sel-allow-longitudinal").value = data.allowLongitudinal === false ? "0" : "1";
    updateOriginHeaderSummary();

    const rollIdInp = document.getElementById("inp-roll-id");
    if (rollIdInp && document.getElementById("sb-roll-id")) {
        document.getElementById("sb-roll-id").innerText = data.materialAvailable === false ? '未装载' : rollIdInp.value;
    }
    if (document.getElementById("sb-engine")) {
        document.getElementById("sb-engine").innerText = data.engine || "智能几何排料内核";
    }

    const originStr = (data.cutOrigin || "right-bottom").toLowerCase();
    const isRight = originStr.startsWith("right");
    const isBottom = originStr.endsWith("bottom");
    const trim = data.trimStart || 0;
    const originX = isRight ? (data.rollW || 2000) : 0;
    const winStartY = data.windowStartY || 0;
    const originY = isBottom ? (winStartY + (data.bedL || 5000) - trim) : (winStartY + trim);
    const originLbl = document.getElementById("sb-origin-lbl");
    if (originLbl) {
        let name = isRight ? "靠右导轨" : "靠左布边";
        let pos = isBottom ? "落料口起切" : "顺流进料口";
        originLbl.innerText = `${name}·${pos} (${originX}, ${originY}) mm`;
    }

    // 现场切刀表
    const totalCutsBadge = document.getElementById("total-cuts-badge");
    if (totalCutsBadge) totalCutsBadge.innerText = `${(data.cuts || []).length} 刀`;
    const rightTabCutBadge = document.getElementById("right-tab-cut-badge");
    if (rightTabCutBadge) rightTabCutBadge.innerText = `${(data.cuts || []).length} 刀`;

    const cutTbody = document.getElementById("cut-table-body");
    if (cutTbody) {
        const currentLimit = state.currentCutStepLimit;
        const isOpt = state.isToolpathOptimized;
        cutTbody.innerHTML = (data.cuts || []).map(c => {
            const isActive = (c.step === currentLimit);
            const dirStr = (c.startX !== undefined && c.endX !== undefined) ?
                `<div style="font-size:10px; color:#0284c7; font-family:monospace; margin-top:2px;">(${Math.round(c.startX)},${Math.round(c.startY)}) ➔ (${Math.round(c.endX)},${Math.round(c.endY)})</div>` : "";
            const airBadge = (isOpt && c.airDistance !== undefined) ?
                `<span style="font-size:9px; background:rgba(2,132,199,0.12); color:#0284c7; padding:1px 4px; border-radius:3px; border:1px solid rgba(2,132,199,0.25); margin-left:4px; font-family:monospace;">空+${Math.round(c.airDistance)}</span>` : "";
            return `
            <tr class="${isActive ? 'active-row' : ''}">
                <td><span class="badge-cut">${c.step}</span></td>
                <td><b>${c.type}</b>${airBadge}</td>
                <td>${c.pos}mm${dirStr}</td>
                <td>${c.desc}</td>
            </tr>
            `;
        }).join("");
    }

    // 料头登记表
    const remBadge = document.getElementById("remnant-count-badge");
    if (remBadge) remBadge.innerText = `${(data.remnants || []).length} 块`;
    const rightTabRemBadge = document.getElementById("right-tab-rem-badge");
    if (rightTabRemBadge) rightTabRemBadge.innerText = `${(data.pieces || []).filter(p => !p.confirmed).length} 件`;
    const remTbody = document.getElementById("remnant-table-body");
    if (remTbody) {
        remTbody.innerHTML = (data.remnants || []).map(r => {
            const isSelected = (state.selectedRemnantId === r.id);
            return `
            <tr id="remnant-row-${r.id}" data-remnant-id="${r.id}"
                class="interactive-row ${isSelected ? 'remnant-selected-row active-row' : ''}"
                onclick="window.selectRemnant('${r.id}', { fromTable: true, smoothPan: true, showToastMsg: true })"
                onmouseenter="window.hoverRemnant('${r.id}', true)"
                onmouseleave="window.hoverRemnant('${r.id}', false)"
                title="点击在 CAD 画布中居中定位并高亮此料头 #${r.id}">
                <td><code class="remnant-code">${escapeText(r.id)}</code></td>
                <td>${r.w} × ${r.l} mm</td>
                <td>${r.area.toFixed(2)} m²</td>
                <td><span class="quality-badge ${r.hasDefect ? 'has-defect' : ''}">${r.hasDefect ? '带疵' : '无疵'}</span></td>
                <td>
                    <button class="tool-btn rem-locate-btn"
                        onclick="event.stopPropagation(); window.selectRemnant('${r.id}', { fromTable: true, smoothPan: true, showToastMsg: true })"
                        title="在 CAD 画布中居中定位此料头">
                        定位
                    </button>
                </td>
            </tr>
            `;
        }).join("");
    }

    // 台账数据：当前工位实切对账
    const winStartYVal = data.windowStartY || 0;
    const bedLVal = data.bedL || 5000;
    const winEndYVal = winStartYVal + bedLVal;
    const hasStationPlan = ((data.totalArea || 0) > 0 || (data.pieces || []).some(p => {
        const pMid = p.y + p.l / 2;
        return pMid >= winStartYVal && pMid < winEndYVal;
    }));

    const sheet = state.currentCutMode === 'remnant';
    const metrics = materialSummary(data, sheet);
    if (document.getElementById('lbl-deduct-len')) document.getElementById('lbl-deduct-len').innerText = hasStationPlan ? metrics.deductLen + ' mm' : '—';
    for (const [id,value] of [['lbl-piece-area',metrics.pieceArea],['lbl-rem-area',metrics.remArea],['lbl-waste-area',metrics.wasteArea],['lbl-total-area',metrics.totalArea],['lbl-processing-area',metrics.processingArea]]) {
        const element = document.getElementById(id); if (element) element.innerText = hasStationPlan ? (value || 0).toFixed(3) + ' m²' : '—';
    }
    const utilEl = document.getElementById('lbl-utilization');
    if (utilEl) utilEl.innerText = hasStationPlan && metrics.totalArea > 0 ? metrics.utilization.toFixed(1) + '%' : '—';
    const processingUtilEl = document.getElementById('lbl-processing-utilization');
    if (processingUtilEl) processingUtilEl.innerText = hasStationPlan ? metrics.processingUtilization.toFixed(1) + '%' : '—';
    for (const [id,text] of [
        ['lbl-utilization-title',metrics.actual ? '实际利用率' : '预计利用率'],
        ['lbl-usage-title',sheet ? '母卷扣料' : metrics.actual ? '实切用料' : '预计用料'],
        ['lbl-rem-area-title',metrics.actual ? '已回收料头' : '候选回收料头'],
        ['lbl-waste-area-title',metrics.actual ? '实切损耗' : '预计损耗'],
        ['lbl-total-area-title',metrics.actual ? '实切用料面积' : '预计用料面积'],
        ['metrics-note',metrics.actual ? '按报工回执计算；回收料头单独记账。' : sheet ? '裁片面积 ÷ 整块料头面积；报工才核销。' : '裁片面积 ÷ 预计用料面积；预览不扣库存。']
    ]) { const element = document.getElementById(id); if (element) element.textContent = text; }
    updateWorkflowControls();

    const sum = (metrics.pieceArea || 0) + (metrics.remArea || 0) + (metrics.wasteArea || 0);
    const diff = Math.abs(sum - (metrics.totalArea || 0));
    const statusEl = document.getElementById("lbl-balance-status");
    if (statusEl) {
        if (!hasStationPlan || (data.totalArea || 0) === 0) {
            statusEl.className = "status-badge";
            statusEl.innerText = "工位就绪 (待排料)";
        } else if (diff < 0.001) {
            statusEl.className = "status-badge";
            statusEl.innerText = metrics.actual ? "回执面积一致" : "预计面积一致";
        } else {
            statusEl.className = "badge-cut";
            statusEl.innerText = `偏差: ${diff.toFixed(3)} m²`;
        }
    }

    // 母卷剩余米数实时对齐
    const rollRemainingEl = document.getElementById("lbl-roll-remaining");
    if (rollRemainingEl) {
        const totalRollL = data.totalRollL || 60000;
        let maxConfirmedY = data.stockUsedLength || 0;
        (data.pieces || []).filter(p => p.confirmed).forEach(p => {
            if (p.y + p.l > maxConfirmedY) maxConfirmedY = p.y + p.l;
        });
        if (data.lastReceipt && data.lastReceipt.windowStartY !== undefined && data.lastReceipt.actualCutLen) {
            const rEnd = data.lastReceipt.windowStartY + data.lastReceipt.actualCutLen;
            if (rEnd > maxConfirmedY) maxConfirmedY = rEnd;
        }
        const remainingLen = Math.max(0, totalRollL - maxConfirmedY);
        rollRemainingEl.innerText = `${remainingLen.toLocaleString()} mm`;
    }
}

export function loadCase(id) {
    state.pendingPlan = null;
    clearRemnantSelection();
    state.setCutMode('roll');
    document.body.dataset.source = 'roll';
    document.getElementById('source-kind').textContent = '母卷';
    document.getElementById('source-remnant-summary').hidden = true;
    state.setCaseId(id);
    Object.assign(state.scenarios[id], {lastReceipt:null, pieces:[], cuts:[], remnants:[], cutIntervals:[], pieceArea:0, totalArea:0, deductLen:0});
    for (let i = 1; i <= 8; i++) {
        const btn = document.getElementById(`btn-case-${i}`);
        if (btn) btn.classList.toggle("active", i === id);
    }
    const data = state.getCurrentCaseData();
    const rollId = data.rollId || "ROLL-2026-0920";
    data.materialAvailable = false;
    document.body.dataset.material = 'empty';

    // 1. 同步母卷下拉选框选项与当前值
    const selMother = document.getElementById("sel-mother-roll-id");
    if (selMother) {
        selMother.value = [...selMother.options].some(option => option.value === rollId) ? rollId : '';
    }

    // 2. 规范母卷规格与状态
    const spec = state.motherRollSpecs[rollId] || {
        model: data.rollModel || "标准面料",
        rollW: data.rollW || 2000,
        totalRollL: data.totalRollL || 60000,
        bedL: data.bedL || 5000
    };
    if (data.rollW) spec.rollW = data.rollW;
    if (data.totalRollL) spec.totalRollL = data.totalRollL;
    if (data.bedL) spec.bedL = data.bedL;
    if (data.rollModel) spec.model = data.rollModel;
    state.motherRollSpecs[rollId] = spec;
    data.rollW = spec.rollW;
    data.totalRollL = spec.totalRollL;

    if (document.getElementById("inp-roll-id")) document.getElementById("inp-roll-id").value = rollId;
    if (document.getElementById("inp-roll-w")) document.getElementById("inp-roll-w").value = data.rollW;
    if (document.getElementById("inp-total-roll-l")) document.getElementById("inp-total-roll-l").value = data.totalRollL;
    if (document.getElementById("inp-bed-l")) document.getElementById("inp-bed-l").value = data.bedL || 5000;
    if (document.getElementById("inp-window-start-y")) document.getElementById("inp-window-start-y").value = data.windowStartY || 0;

    // 3. 同步左侧母卷规格卡片文字标签
    const modelLbl = document.getElementById("lbl-roll-model-desc");
    if (modelLbl) modelLbl.innerText = spec.model || data.rollModel || "标准布卷";
    const wLbl = document.getElementById("lbl-roll-w-desc");
    if (wLbl) wLbl.innerText = spec.rollW;
    const sbRoll = document.getElementById("sb-roll-id");
    if (sbRoll) sbRoll.innerText = rollId;
    const totalLenEl = document.getElementById("lbl-roll-total-len");
    if (totalLenEl) totalLenEl.innerText = spec.totalRollL.toLocaleString();
    const remLenEl = document.getElementById("lbl-roll-remaining-len");
    if (remLenEl) remLenEl.innerText = `${spec.totalRollL.toLocaleString()} mm`;
    const usedLenEl = document.getElementById("lbl-roll-used-len");
    if (usedLenEl) usedLenEl.innerText = `0 mm`;
    const progressEl = document.getElementById("roll-len-progress");
    if (progressEl) progressEl.style.width = `0%`;
    const baseOriginEl = document.getElementById("lbl-roll-base-origin");
    if (baseOriginEl) baseOriginEl.innerText = `Y = ${(data.windowStartY || 0).toLocaleString()} mm (${((data.windowStartY || 0)/1000).toFixed(2)}m)`;

    if (document.getElementById("inp-trim-start")) document.getElementById("inp-trim-start").value = data.trimStart || 0;
    if (document.getElementById("sel-cut-origin")) document.getElementById("sel-cut-origin").value = data.cutOrigin || "right-bottom";
    const headerTag = document.getElementById("tag-cut-origin-header");
    if (headerTag) {
        const val = data.cutOrigin || "right-bottom";
        const bedL = data.bedL || 5000;
        if (val === "right-bottom") { headerTag.innerText = `右下角 · ${bedL}mm`; headerTag.style.color = "var(--text-muted)"; }
        else if (val === "right-top") { headerTag.innerText = `右上角 · ${bedL}mm`; headerTag.style.color = "var(--text-muted)"; }
        else if (val === "left-bottom") { headerTag.innerText = `左下角 · ${bedL}mm`; headerTag.style.color = "var(--text-muted)"; }
        else { headerTag.innerText = `左上角 · ${bedL}mm`; headerTag.style.color = "var(--text-muted)"; }
    }
    if (document.getElementById("sel-first-stage")) document.getElementById("sel-first-stage").value = data.firstStageOrientation || "horizontal";
    if (document.getElementById("sel-allow-rotation")) document.getElementById("sel-allow-rotation").value = data.allowRotation ? "1" : "0";
    if (document.getElementById("sel-allow-longitudinal")) document.getElementById("sel-allow-longitudinal").value = data.allowLongitudinal === false ? "0" : "1";

    updateDemandCompletionFromPieces(data);
    recalculateRollStats(data);

    renderDefectsUI(data.globalDefects || data.defects || []);
    renderDemandsUI(data.demands);

    const demandsRollLbl = document.getElementById("demands-roll-label");
    if (demandsRollLbl) demandsRollLbl.innerText = `${rollId} (${spec.rollW}mm · ${spec.model || data.rollModel || ''})`;
    const craftHint = document.getElementById("demands-craft-hint");
    if (craftHint) {
        if (rollId === "ROLL-REAL-893292" || id === 7) {
            craftHint.innerHTML = "<b>893292 窗帘整单</b>: 11项主帘定高横裁(幅宽2170~2715mm) · 门幅剩余630mm边料竖切套排窗幔/绑带/抱枕(37件套)";
        } else if (rollId === "ROLL-REAL-893153" || id === 8) {
            craftHint.innerHTML = "<b>893153 工程整单</b>: 4大超长工程主帘(5.4m~9m横裁) · 门幅剩余边料竖切套排长绑带/抱枕(18件套)";
        } else {
            craftHint.innerText = "工艺规则：窗帘定高横裁为主要落料，门幅剩余窄边料顺流纵切套排辅件吃净";
        }
    }

    renderScene();
    renderRadar();
    resetToBedView();
    bus.emit('demands:changed');
    updateUIInfo();
}

export function updateWorkflowControls() {
    const ready = canUseCurrentPlan();
    const editable = currentPlanContext();
    const edited = editable && !ready;
    const editPanel = document.getElementById('plan-edit-controls');
    if (editPanel) { editPanel.hidden = !editable; editPanel.dataset.edited = String(edited); editPanel.querySelector('.plan-edit-actions').hidden = !state.pendingPlan?.history?.canUndo && !state.pendingPlan?.history?.canRedo; }
    const validateButton = document.getElementById('btn-validate-adjustment');
    if (validateButton) { validateButton.disabled = !edited || validatingAdjustment; validateButton.textContent = validatingAdjustment ? '正在校验…' : '校验并保存调整版'; }
    for (const [id, enabled] of [['btn-undo-plan',state.pendingPlan?.history?.canUndo],['btn-redo-plan',state.pendingPlan?.history?.canRedo]]) {
        const button = document.getElementById(id); if (button) button.disabled = !enabled || validatingAdjustment;
    }
    const editMessage = document.getElementById('plan-edit-message');
    if (editMessage) editMessage.textContent = editable ? state.pendingPlan.adjustmentError || (edited ? '手动调整待校验；刀序与候选余料将重新计算。' : `方案版本 ${state.pendingPlan.version || 1} · 已校验`) : '';
    const flow = renderWorkflowGuide({ready, edited, busy:solving ? '正在生成方案…' : validatingAdjustment ? '正在校验调整…' : reporting ? '正在保存报工…' : ''});
    const data = state.getCurrentCaseData(), reportEl = document.getElementById('lbl-report-status');
    if (reportEl) reportEl.textContent = materialSummary(data, state.currentCutMode === 'remnant').actual ? '已报工保存 · ' + data.lastReceipt.finishedPieceCount + ' 件' :
        edited ? '手动调整 · 待校验' : ready ? '待报工 · 尚未保存产出' : flow.done || flow.stage < 2 ? flow.title : '当前工位待排料';
    updateDemandProgress({pending:editable ? state.pendingPlan : null, edited, attempt:latestSolveAttempt && latestSolveAttempt.context === solveContext() ? latestSolveAttempt : null});
    renderSolveFeedback(flow);
    return {...flow, ready, edited};
}

let latestSolveAttempt = null;
export function resetSolveFeedback() { latestSolveAttempt = null; }
function renderSolveFeedback(flow) {
    const panel=document.getElementById('solve-feedback');if(!panel)return;
    const attempt=latestSolveAttempt && latestSolveAttempt.context===solveContext()?latestSolveAttempt:null;
    panel.hidden=!attempt;if(!attempt)return;
    const feedback=failurePresentation(attempt.result);
    panel.querySelector('strong').textContent=feedback.title;
    panel.querySelector('[data-error-message]').textContent=feedback.message;
    const preserved=state.pendingPlan ? (currentPlanContext()?'原方案与手调预览已保留，新结果未应用；需求进度仍按原方案显示。':'旧图形保留供核对，版本或材料需重新核实，不能报工。') : '';
    panel.querySelector('[data-error-hint]').textContent=feedback.hint+(preserved?' '+preserved:'');
    const retry=panel.querySelector('[data-retry]');retry.disabled=solving || !flow.canSolve;retry.onclick=triggerSolve;
    panel.querySelector('[data-review-input]').onclick=()=>navigateWorkflowStage(feedback.code==='UNSUPPORTED'?2:0,flow.target || (feedback.code==='UNSUPPORTED'?'#card-bed-origin':'#card-demands'));
}
let solving = false;
function planGeometry() {
    const {pieces, remnants, cuts} = state.getCurrentCaseData();
    return JSON.stringify({pieces, remnants, cuts});
}
export function canUseCurrentPlan() {
    return currentPlanContext() && state.pendingPlan.geometry === planGeometry();
}
function currentPlanContext() {return !!state.pendingPlan?.result?.planId && !state.pendingPlan.blockedError && state.pendingPlan.context===solveContext()
    && (!state.activeTask || state.pendingPlan.request?.taskRevision===state.activeTask.revision);}
export function recordPlanEdit() {
    const pending = state.pendingPlan;
    if (!pending?.history) return;
    const data = state.getCurrentCaseData();
    // The old cut tree and leftover partition cease to describe a moved or removed piece.
    if (JSON.stringify(data.pieces) !== JSON.stringify(pending.history.current.pieces)) {
        data.cuts = []; data.remnants = []; data.cutIntervals = [];
    }
    if (pending.history.record(planScene(data))) {
        pending.adjustmentError = ''; pending.adjustmentId = null;
        state.isToolpathOptimized = false; state.toolpathStats = null; state.originalCutsBackup = null;
    }
    recalculateRollStats(data); updateUIInfo(); renderScene(); renderToolpathUI();
}
export function undoPlanEdit() { applyPlanHistory('undo'); }
export function redoPlanEdit() { applyPlanHistory('redo'); }
function applyPlanHistory(direction) {
    const pending = state.pendingPlan;
    if (validatingAdjustment || !pending?.history || pending.context !== solveContext()) return;
    const scene = pending.history[direction]();
    if (!scene) return;
    Object.assign(state.getCurrentCaseData(), scene);
    pending.adjustmentError = ''; pending.adjustmentId = null;
    state.isToolpathOptimized = false; state.toolpathStats = null; state.originalCutsBackup = null;
    recalculateRollStats(state.getCurrentCaseData()); updateUIInfo(); renderScene(); renderToolpathUI();
}
let validatingAdjustment = false;
export async function validatePlanAdjustment() {
    const pending = state.pendingPlan;
    if (validatingAdjustment || !pending || !currentPlanContext()) return;
    if (canUseCurrentPlan()) return;
    const geometry = planGeometry();
    pending.adjustmentId ||= crypto.randomUUID();
    const pieces = state.getCurrentCaseData().pieces.filter(p => !p.confirmed && p.planId === pending.result.planId)
        .map(p => ({id:p.sourcePieceId, x:p.x, y:p.y-pending.windowStartY, rotated:!!p.rotated}));
    validatingAdjustment = true;
    const wasInert = document.body.inert; document.body.inert = true;
    try {
        pending.adjustmentError = ''; updateUIInfo();
        const response = await fetch('/api/cutting/plans/' + encodeURIComponent(pending.result.planId) + '/adjust', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({adjustmentId:pending.adjustmentId, pieces})
        });
        const saved = await response.json();
        if (state.pendingPlan !== pending || pending.context !== solveContext() || geometry !== planGeometry()) return;
        if (!response.ok) throw new Error(saved.message || '调整校验失败，请检查布局后重试');
        restoreSavedPlan(saved);
        showToast(`调整版 ${saved.version} 已保存，原方案已取消；请核对后实切报工`, 'success');
    } catch (error) {
        if (state.pendingPlan === pending) { pending.adjustmentError = error.message; showToast(error.message, 'error'); }
    } finally { validatingAdjustment = false; document.body.inert = wasInert; updateUIInfo(); }
}
function solveContext() {
    return JSON.stringify([state.activeTask?.id, state.activeTask?.revision, state.currentCaseId, state.currentCutMode, state.loadedRemnant?.id,
        getDemandsFromUI(), getDefectsFromUI(), solverSettings(), ...['task-name','task-material','sel-mother-roll-id','inp-roll-w','inp-bed-l','inp-window-start-y','inp-trim-start','sel-cut-origin','sel-first-stage','sel-allow-rotation','sel-allow-longitudinal'].map(id => document.getElementById(id)?.value)]);
}
export function restoreSavedPlan(saved) {
    const {request, result} = saved;
    latestSolveAttempt = null;
    const data = state.getCurrentCaseData();
    const offset = request.feedPortType === 'remnant' ? 0 : request.windowStartY;
    Object.assign(data, {rollId:request.rollId, rollW:request.rollW, bedL:request.rollL,
        windowStartY:offset, trimStart:request.trimStart, cutOrigin:request.cutOrigin,
        firstStageOrientation:request.firstStageOrientation, allowRotation:request.allowRotation,
        allowLongitudinal:request.allowLongitudinal, lastReceipt:null});
    data.pieces = (result.pieces || []).map(p => ({...p, sourcePieceId:p.id, planId:result.planId, y:p.y + offset}));
    data.remnants = (result.remnants || []).map(r => ({...r, y:r.y + offset}));
    data.cuts = (result.cuts || []).map(c => ({...c, pos:c.type === '横切' ? c.pos + offset : c.pos,
        start:c.type === '横切' ? c.start : c.start + offset, end:c.type === '横切' ? c.end : c.end + offset,
        ...(c.startY === undefined ? {} : {startY:c.startY + offset}),
        ...(c.endY === undefined ? {} : {endY:c.endY + offset})}));
    data.cutIntervals = [{start:offset, end:offset + request.rollL}];
    data.engine = result.engine;
    recalculateRollStats(data);
    updateUIInfo(); renderScene(); renderRadar(); resetToBedView();
    state.pendingPlan = {result, request, rollId:request.rollId, rollModel:request.rollModel, bedL:request.rollL,
        feedPortType:request.feedPortType, sourceRemnantId:request.sourceRemnantId,
        taskId:request.taskId, windowStartY:offset, context:solveContext(), geometry:planGeometry(), version:saved.version || 1,
        history:createPlanHistory(planScene(data))};
    updateUIInfo();
    bus.emit('solve:success', {result, elapsed:0, rollId:request.rollId});
}
export async function triggerSolve() {
    if (solving) return;
    const flow = updateWorkflowControls();
    if (!flow.canSolve) { showToast(flow.hint, 'warning');navigateWorkflowStage(flow.stage,flow.target);return; }
    solving = true; latestSolveAttempt = null;
    const operation={context:solveContext()};
    updateWorkflowControls();
    try { await runSolve(operation); }
    catch (error) {
        if(operation.context!==solveContext())return;
        latestSolveAttempt={context:solveContext(),result:{status:error.code || 'SERVICE',message:error.message}};
        if(state.pendingPlan && ['CONFLICT','INVALID_INPUT'].includes(error.code))state.pendingPlan.blockedError=error.message;
    }
    finally { solving = false; updateWorkflowControls(); }
}
async function runSolve(operation) {
    const task = await saveCurrentTask();
    operation.context=solveContext();
    const data = state.getCurrentCaseData();
    const isRemnantMode = (state.currentCutMode === "remnant");

    let rollW, bedL, totalL, winStartY, demands, sourceRemnantId, feedPortType, rollId, rollModel, activeDemands;

    if (isRemnantMode) {
        const loadedRemnant = state.loadedRemnant;
        if (!loadedRemnant) {
            showToast("请先在左侧料头货架中选择或扫描一块料头装载至机台！", "warning");
            return;
        }
        demands = window.camApp ? window.camApp.getRemnantDemandsFromUI() : [];
        if (!demands || demands.length === 0) {
            showToast("请至少在左侧添加 1 项料头裁片套裁需求！", "warning");
            return;
        }
        activeDemands = demands;
        rollW = loadedRemnant.width;
        bedL = loadedRemnant.length;
        totalL = loadedRemnant.length;
        winStartY = 0;
        sourceRemnantId = loadedRemnant.id;
        feedPortType = "remnant";
        rollId = loadedRemnant.sourceRollId || (document.getElementById("sel-mother-roll-id") ? document.getElementById("sel-mother-roll-id").value : "ROLL-2026-0920");
        rollModel = loadedRemnant.materialBatch || "在库料头";
    } else {
        rollW = parseFloat(document.getElementById("inp-roll-w").value) || data.rollW || 2000;
        bedL = parseFloat(document.getElementById("inp-bed-l").value) || data.bedL || 5000;
        winStartY = parseFloat(document.getElementById("inp-window-start-y").value) || data.windowStartY || 0;
        totalL = data.totalRollL || 60000;
        sourceRemnantId = null;
        feedPortType = "roll";
        rollId = document.getElementById("sel-mother-roll-id") ? document.getElementById("sel-mother-roll-id").value : "ROLL-2026-0920";
        rollModel = document.getElementById("lbl-roll-model-desc") ? document.getElementById("lbl-roll-model-desc").innerText : "标准面料";

    }
    activeDemands = getDemandsFromUI().filter(d => d.demand > 0).map(d => ({id:d.id, name:d.name, width:d.width, length:d.length, demand:d.demand, allowRotation:d.allowRotation}));
    if (!activeDemands.length) return showToast('本次需求已全部完成，可新建下一任务', 'info');
    demands = activeDemands;

    const winEndY = winStartY + bedL;
    const trimStart = parseFloat(document.getElementById("inp-trim-start").value) || 0;
    const cutOrigin = document.getElementById("sel-cut-origin").value || "right-bottom";
    const firstStageOrientation = document.getElementById("sel-first-stage").value || "horizontal";
    const allowRotation = (document.getElementById("sel-allow-rotation").value === "1");
    const allowLongitudinal = (document.getElementById("sel-allow-longitudinal").value === "1");

    const allDefects = isRemnantMode ? ((state.loadedRemnant && state.loadedRemnant.defects) || []) : getDefectsFromUI();

    const activeBedDefects = allDefects
        .filter(d => (d.y + d.h >= winStartY && d.y <= winEndY))
        .map(d => ({
            id: d.id,
            x: d.x,
            y: Math.max(0, d.y - winStartY),
            w: d.w,
            h: d.h,
            margin: d.margin ?? 20
        }));

    const payload = {
        ...solverSettings(),
        taskId: task.id, taskRevision: task.revision,
        rollId: rollId,
        rollModel: rollModel,
        rollW: rollW,
        rollL: bedL,
        totalRollL: totalL,
        windowStartY: winStartY,
        trimStart: trimStart,
        cutOrigin: cutOrigin,
        firstStageOrientation: firstStageOrientation,
        allowRotation: allowRotation,
        allowLongitudinal: allowLongitudinal,
        feedPortType: feedPortType,
        sourceRemnantId: sourceRemnantId,
        solver: "packingsolver",
        defects: activeBedDefects,
        demands: demands
    };

    const context = solveContext();
    const geometry=planGeometry();
    const t0 = performance.now();
        const result = await requestJSON('/api/solve',payload);
        if (context !== solveContext()) {
            if(state.activeTask?.id===task.id)latestSolveAttempt={context:solveContext(),result:{status:'STALE_INPUT',message:'需求或材料已变化，未应用返回方案，请重新排料。'}};
            return;
        }
        if(geometry!==planGeometry())throw new ApiError('等待期间预览已调整，当前手调位置保留。','STALE_INPUT');
        if(result.success && (!result.planId || !Array.isArray(result.pieces) || !result.pieces.length || !Array.isArray(result.cuts) || !Array.isArray(result.remnants)))throw new ApiError('求解响应缺少完整方案，原预览保留。','INVALID_RESULT');
        latestSolveAttempt = result.success && result.planId && result.pieces?.length ? null : {context, result:{...result,status:result.status || 'INVALID_RESULT'}};
        {
            const elapsed = Math.round(performance.now() - t0);
            if (result.success && result.planId && result.pieces?.length) {
                state.pendingPlan = { result, request:payload, rollId, rollModel, bedL, feedPortType, sourceRemnantId, context, taskId:task.id, windowStartY: winStartY };
                data.lastReceipt = null;
                data.rollW = rollW;
                data.bedL = bedL;
                data.windowStartY = winStartY;
                data.trimStart = trimStart;
                data.cutOrigin = cutOrigin;
                data.firstStageOrientation = firstStageOrientation;
                data.allowRotation = allowRotation;
                data.allowLongitudinal = allowLongitudinal;
                data.globalDefects = allDefects;

                if (isRemnantMode) {
                    data.pieces = (result.pieces || []).map(p => ({ ...p, sourcePieceId:p.id, planId:result.planId, y: p.y }));
                    data.cuts = (result.cuts || []).map(c => ({ ...c }));
                    data.remnants = (result.remnants || []).map(r => ({ ...r }));
                    data.deductLen = 0.0;
                    data.pieceArea = result.pieceArea;
                    data.remArea = result.remArea;
                    data.wasteArea = result.wasteArea;
                    data.totalArea = result.totalArea;
                } else {
                    const isPieceInCurrentStation = (p) => {
                        const pMid = p.y + p.l / 2;
                        return (pMid >= winStartY && pMid < winEndY);
                    };
                    const retainedPieces = (data.pieces || []).filter(p => !isPieceInCurrentStation(p));
                    const newPieces = (result.pieces || []).map((p, idx) => {
                        const matchedDemand = (activeDemands || []).find(ad => ad.id === p.demandId);
                        return {
                            ...p,
                            id: Math.max(0, ...retainedPieces.map(p => p.id)) + idx + 1,
                            sourcePieceId: p.id,
                            planId: result.planId,
                            demandId: matchedDemand ? (matchedDemand.id || (activeDemands.indexOf(matchedDemand) + 1)) : p.demandId,
                            name: matchedDemand ? matchedDemand.name : p.name,
                            y: p.y + winStartY
                        };
                    });
                    data.pieces = [...retainedPieces, ...newPieces].sort((a, b) => a.y - b.y || a.x - b.x);

                    // CNC 数控切刀严格归属于当前工位切削循环，严禁拼接或保留历史工位切刀
                    const newCuts = (result.cuts || []).map((c, idx) => {
                        const isHoriz = (c.type === "横切");
                        return {
                            ...c,
                            step: idx + 1,
                            pos: isHoriz ? (c.pos + winStartY) : c.pos,
                            start: !isHoriz ? (c.start + winStartY) : c.start,
                            end: !isHoriz ? (c.end + winStartY) : c.end,
                            ...(c.startY === undefined ? {} : {startY:c.startY + winStartY}),
                            ...(c.endY === undefined ? {} : {endY:c.endY + winStartY})
                        };
                    });
                    data.cuts = newCuts;

                    const currentStationIdx = Math.round(winStartY / Math.max(100, bedL || 5000)) + 1;
                    
                    // 1. 过滤与修复历史料头：
                    // A. 凡是起始坐标已在当前待切工位内（r.y >= winStartY - 1）的旧料头彻底清除；
                    // B. 凡是跨过当前工位起始线 winStartY 的旧料头，物理截断至 winStartY，绝不允许刺入当前工位；
                    const retainedRemnants = (data.remnants || [])
                        .filter(r => r.y < winStartY - 1)
                        .map(r => {
                            if (r.y + r.l > winStartY) {
                                const newL = Math.max(0, winStartY - r.y);
                                return {
                                    ...r,
                                    l: newL,
                                    area: Number(((r.w * newL) / 1000000.0).toFixed(3))
                                };
                            }
                            return r;
                        })
                        .filter(r => r.l >= 100);

                    // 2. 注入新工位料头，保证全局 ID 唯一性与工位溯源性
                    const existingIds = new Set(retainedRemnants.map(r => r.id));
                    let nextRemSeq = 1;
                    const newRemnants = (result.remnants || []).map((r, idx) => {
                        let finalId = r.id;
                        // 若 ID 重复或包含旧格式 REM-PS-，重构为 REM-S{工位}-{序号} 全局唯一编号
                        if (!finalId || existingIds.has(finalId) || finalId.startsWith("REM-PS-")) {
                            do {
                                finalId = `REM-S${currentStationIdx}-${String(nextRemSeq++).padStart(2, '0')}`;
                            } while (existingIds.has(finalId));
                        }
                        existingIds.add(finalId);
                        return {
                            ...r,
                            id: finalId,
                            y: r.y + winStartY
                        };
                    });
                    data.remnants = [...retainedRemnants, ...newRemnants];

                    if (!data.cutIntervals) data.cutIntervals = [];
                    data.cutIntervals = addOrMergeInterval(data.cutIntervals, winStartY, winEndY);

                    recalculateRollStats(data);
                    updateDemandCompletionFromPieces(data);
                    renderDemandsUI(data.demands);
                }

                recalculateRollStats(data);
                updateDemandCompletionFromPieces(data);
                renderDemandsUI(data.demands);
                data.engine = `${result.engine} [${elapsed}ms]`;
                state.setCutStepLimit(999);
                renderScene();
                if (isRemnantMode) {
                    resetToBedView();
                }
                updateUIInfo();

                state.pendingPlan.geometry = planGeometry();
                state.pendingPlan.history = createPlanHistory(planScene(data));
                state.pendingPlan.version = 1;
                updateUIInfo();
                bus.emit('solve:success', { result, elapsed, rollId });

                const stationCount = (data.cutIntervals || []).length;
                const totalCutPieces = (data.pieces || []).length;
                const thisBedPieces = (result.pieces || []).length;

                showToast(`直刀排料计算成功：产出 ${thisBedPieces} 件，预计利用率 ${materialSummary(data, isRemnantMode).utilization.toFixed(1)}%`, 'success');
                return;
            } else {
                return;
            }
        }
}

export function requiredReportLength(pieces = [], remnants = []) {
    return Math.max(0, ...pieces.map(p => p.y + p.l), ...remnants.map(r => r.y + r.l));
}
let openingReport = false;
export async function openCutReport() {
    if (openingReport || document.getElementById('cut-report-modal').open) return;
    openingReport = true;
    try { await prepareCutReport(); } finally { openingReport = false; }
}
async function prepareCutReport() {
    let pending = state.pendingPlan;
    if (!canUseCurrentPlan()) {
        showToast(pending?.blockedError ? '方案的任务或材料已变化，请重新核对并排料' : pending?.result?.planId ? '调整尚未校验，请先校验并保存调整版' : '请先生成并核对当前排料方案，再进行报工', 'warning');
        return;
    }
    const { result, bedL, feedPortType } = pending;
    const minW = pending.request?.minRemnantWidth ?? 200, minL = pending.request?.minRemnantLength ?? 300;
    const recoverable = (result.remnants || []).filter(r => r.w >= minW && r.l >= minL);
    const defaultCutLen = Math.max(result.deductLen || 0, layoutMetrics({rollW:pending.request.rollW, bedL, pieces:result.pieces, remnants:recoverable, cuts:result.cuts}).deductLen) || bedL;
    const actualLenInput = document.getElementById("report-actual-len");
    if (actualLenInput) {
        actualLenInput.value = feedPortType === "remnant" ? 0 : (pending.reportActualCutLen ?? defaultCutLen);
        actualLenInput.disabled = feedPortType === "remnant";
    }
    renderReportPieces(pending, updateReportPreview);
    document.getElementById('report-remnants').replaceChildren();
    document.getElementById("report-error").textContent = "";
    document.getElementById("report-length-label").textContent = feedPortType === "remnant" ? "母卷扣料（mm）" : "实切长度（mm）";
    pending.currentRemaining = null;
    if (feedPortType === "roll") {
        try { const response = await fetch(`/api/rolls/${encodeURIComponent(pending.rollId)}`); if (!response.ok) throw new Error(); pending.currentRemaining = (await response.json()).currentRemainingLength; }
        catch { showToast("读取库存失败，请重试", "error"); return; }
    }

    if (state.pendingPlan !== pending || pending.context !== solveContext()) return;
    // 当前方案的报工预览
    await updateReportPreview();

    document.getElementById("cut-report-modal").showModal();
    document.querySelector("#cut-report-modal button").focus();
}

export async function updateReportPreview() {
    const pending = state.pendingPlan;
    if (!pending) return;
    const { rollId, result, feedPortType } = pending;
    const rollIdEl = document.getElementById("report-preview-roll-id");
    if (rollIdEl) rollIdEl.innerText = feedPortType === "remnant" ? (pending.sourceRemnantId || "料头切削") : (rollId || "母卷开卷");

    const curRemaining = pending.currentRemaining;
    document.getElementById('report-stock-preview').hidden = feedPortType === 'remnant';
    document.getElementById('report-preview-cur-len').textContent = curRemaining == null ? '—' : curRemaining.toLocaleString() + ' mm';
    const cutLen = Number(document.getElementById('report-actual-len').value);
    document.getElementById('report-preview-after-len').textContent = curRemaining == null ? '—' : (curRemaining - cutLen).toLocaleString() + ' mm';

    const results=readReportPieces();pending.reportPieceResults=results;pending.reportActualCutLen=cutLen;
    const groups=classifyReport(result.pieces || [],results);
    document.getElementById('report-piece-count').value=groups.QUALIFIED.length;
    const counts = new Map();
    for(const p of result.pieces || []) {
        if(!counts.has(p.demandId))counts.set(p.demandId,{name:p.name,QUALIFIED:0,REJECTED:0,UNCUT:0});
        const outcome=results.find(r=>r.pieceId===p.id)?.outcome;
        if(outcome)counts.get(p.demandId)[outcome]++;
    }
    document.getElementById('report-preview-demand-text').textContent=[...counts].map(([id,c])=>
        '需求 '+id+' '+c.name+'：合格 '+c.QUALIFIED+' / 异常 '+c.REJECTED+' / 未切 '+c.UNCUT).join('；');
    syncReportRemnants(pending,results,updateReportPreview);
    const selected=readReportRemnants(pending);
    const recovered=selected.filter(r=>r.w>=(pending.request.minRemnantWidth ?? 200)&&r.l>=(pending.request.minRemnantLength ?? 300));
    document.getElementById('report-preview-remnant-text').textContent=recovered.length+' 块回库'+(selected.length>recovered.length ? '，尺寸不足 '+(selected.length-recovered.length)+' 块计入损耗' : '');
    const usedArea=pending.request.rollW*(feedPortType==='remnant'?pending.bedL:cutLen)/1_000_000;
    const pieceArea=groups.QUALIFIED.reduce((sum,p)=>sum+p.w*p.l/1_000_000,0);
    const rejectedArea=groups.REJECTED.reduce((sum,p)=>sum+p.w*p.l/1_000_000,0);
    const remArea=recovered.reduce((sum,r)=>sum+r.w*r.l/1_000_000,0);
    document.getElementById('report-area-preview').textContent=usedArea>0&&Number.isFinite(usedArea)
        ? '待保存利用率 '+(pieceArea/usedArea*100).toFixed(1)+'% · 合格 '+pieceArea.toFixed(3)+' ÷ 用料 '+usedArea.toFixed(3)+' m²；回收 '+remArea.toFixed(3)+' m² 另计'
        : '请填写有效的实切长度，报工成功后才记录实际利用率。';
    document.getElementById('report-outcome-summary').textContent='合格 '+groups.QUALIFIED.length+' 件 · 异常 '+groups.REJECTED.length+' 件 · 未切 '+groups.UNCUT.length+' 件。预计损耗 '+Math.max(0,usedArea-pieceArea-remArea).toFixed(3)+' m²（含异常 '+rejectedArea.toFixed(3)+' m²）。';
    const uncutLost=Math.max(0,[...pending.reportCandidates.values()].filter(r=>r.uncut).reduce((sum,r)=>sum+r.w*r.l/1_000_000,0)
        -recovered.filter(r=>r.uncut).reduce((sum,r)=>sum+r.w*r.l/1_000_000,0));
    if(uncutLost>.000001)document.getElementById('report-outcome-summary').textContent+=' 未切区域有 '+uncutLost.toFixed(3)+' m² 已计入用料但未回收，将计入损耗。';

}

export function closeCutReport() { document.getElementById("cut-report-modal").close(); document.getElementById("btn-confirm-station-cut")?.focus(); }

export async function openStationLapConfirmModal() {
    await openCutReport();
}

let reporting = false;
export async function confirmCutReport() {
    if (reporting) return;
    const pending = state.pendingPlan;
    if (!canUseCurrentPlan()) { document.getElementById("report-error").textContent = "方案、需求或材料需重新核实，请重新排料"; return; }
    const actualCutLen = Number(document.getElementById("report-actual-len").value);
    const finishedPieceCount = Number(document.getElementById("report-piece-count").value);
    const location = document.getElementById("report-location").value.trim();
    const pieceResults=readReportPieces();
    const inputError=reportPieceError(pending,pieceResults);
    if(inputError){document.getElementById('report-error').textContent=inputError.message;document.querySelector(inputError.selector)?.focus();return;}
    const actualRemnants=readReportRemnants(pending);

    const report = {
        planId: pending.result.planId,
        actualCutLen: actualCutLen,
        finishedPieceCount: finishedPieceCount,
        location: location,
        actualRemnants: actualRemnants,
        pieceResults
    };

    reporting = true;
    let reported = false;
    document.getElementById("report-confirm-button").disabled = true;
    try {
        const response = await fetch("/api/cutting/report-confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report)
        });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.message || "实切确认失败");
        reported = true;
        if (state.activeTask?.id !== pending.taskId || pending.context !== solveContext()) {
            closeCutReport(); showToast("原任务已完成报工，请从任务记录查看结果", "success"); return;
        }

        const data = state.getCurrentCaseData();
        data.lastReceipt = receipt;
        if (receipt.feedPortType === "roll") {
            data.stockUsedLength = (data.stockUsedLength || 0) + receipt.actualCutLen;
            data.stockRemainingLength = receipt.remainingLength;
        }
        state.lastCutReceipt = receipt;
        state.pendingPlan = null;

        applyReportReceipt(data, pending, receipt);

        await refreshTaskProgress();
        updateDemandCompletionFromPieces(data);
        renderDemandsUI(data.demands);

        // 3. 更新母卷看板状态 (总长、余量、已扣用料及进度条)
        const remaining = document.getElementById("lbl-roll-remaining");
        if (remaining && receipt.remainingLength != null) remaining.innerText = `${receipt.remainingLength} mm`;

        const rollResponse = await fetch(`/api/rolls/${encodeURIComponent(pending.rollId)}`, { cache: "no-store" });
        if (rollResponse.ok) {
            const roll = await rollResponse.json();
            data.stockUsedLength = roll.usedLength; data.stockRemainingLength = roll.currentRemainingLength;
            const remLenEl = document.getElementById("lbl-roll-remaining-len");
            if (remLenEl) remLenEl.innerText = `${(roll.currentRemainingLength || 0).toLocaleString()} mm`;
            const usedLenEl = document.getElementById("lbl-roll-used-len");
            if (usedLenEl) usedLenEl.innerText = `${(roll.usedLength || 0).toLocaleString()} mm`;
            const totalLenEl = document.getElementById("lbl-roll-total-len");
            if (totalLenEl) totalLenEl.innerText = `${(roll.totalLength || 0).toLocaleString()}`;
            const progressEl = document.getElementById("roll-len-progress");
            if (progressEl && roll.totalLength > 0) {
                const pct = Math.min(100, Math.max(0, (roll.usedLength / roll.totalLength) * 100));
                progressEl.style.width = `${pct.toFixed(1)}%`;
            }
            if (remaining) remaining.innerText = `${roll.currentRemainingLength} mm`;
        }

        // 4. 更新料头库存与货架
        if (window.camApp && window.camApp.updateMotherRollRemnantStats) {
            await window.camApp.updateMotherRollRemnantStats(pending.rollId);
        }
        if (window.camApp && window.camApp.refreshShelfRemnantsList) {
            await window.camApp.refreshShelfRemnantsList();
        }

        // 5. 更新台账与视图
        recalculateRollStats(data);
        updateUIInfo();
        renderScene();
        renderRadar();
        closeCutReport();

        // 6. 成功提示并自动平滑转入下一待切工位
        const remCount = receipt.derivedRemnants ? receipt.derivedRemnants.length : 0;
        if (pending.feedPortType === "remnant") {
            showToast(`报工成功：合格 ${receipt.finishedPieceCount} 件，异常 ${receipt.rejectedPieceCount || 0} 件，未切 ${receipt.uncutPieceCount || 0} 件，回收 ${remCount} 块料头`, "success");
        } else {
            showToast(`报工成功：合格 ${receipt.finishedPieceCount} 件，异常 ${receipt.rejectedPieceCount || 0} 件，未切 ${receipt.uncutPieceCount || 0} 件，用料 ${receipt.actualCutLen} mm，回收 ${remCount} 块`, "success");

            // 自动化现场核心交互：自动推进至下一待切工位，已切区域固化为历史，并更新当前拉布基准
            {
                data.cuts = [];
                smartAdvanceBed();
                const curY = state.getCurrentCaseData().windowStartY || 0;
                const baseOriginEl = document.getElementById("lbl-roll-base-origin");
                if (baseOriginEl) baseOriginEl.innerText = `Y = ${curY.toLocaleString()} mm (${(curY/1000).toFixed(2)}m)`;
                if (window.camApp && window.camApp.updateToolpathStatsUI) {
                    window.camApp.updateToolpathStatsUI();
                }

            }
        }
    } catch (error) {
        document.getElementById("report-error").textContent = reported ? "报工已完成，页面刷新失败，请重新打开该任务查看结果" : error.message;
    } finally { reporting = false; document.getElementById("report-confirm-button").disabled = false; updateWorkflowControls(); }
}

export function exportCutResult() {
    const data = state.getCurrentCaseData();
    const metrics = materialSummary(data, state.currentCutMode === 'remnant');
    const exportData = { status: metrics.actual ? "已实切确认" : "示例或方案预览", receipt: metrics.actual ? data.lastReceipt : null,
        rollId: data.rollId || null, demands: data.demands || [], pieces: data.pieces || [], cuts: data.cuts || [],
        remnants: data.remnants || [], pieceArea: metrics.pieceArea || 0, usedArea:metrics.totalArea || 0,
        utilization:metrics.utilization, utilizationBasis:metrics.actual ? 'actual-used-area' : 'estimated-used-area',
        processingArea:metrics.processingArea || 0, processingUtilization:metrics.processingUtilization };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `cut-result-${Date.now()}.json`; link.click();
    URL.revokeObjectURL(url);
}

export function renderCutTable(cuts) {
    const data = state.getCurrentCaseData();
    if (cuts) data.cuts = cuts;
    recalculateRollStats(data);
}
