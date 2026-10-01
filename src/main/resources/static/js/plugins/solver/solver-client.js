/**
 * 求解器通信与排料控制插件 (Solver Client Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { renderRadar, smartAdvanceBed } from '../radar/radar-scrubber.js';
import {
    updateDemandCompletionFromPieces, recalculateRollStats,
    addOrMergeInterval, renderDemandsUI, renderDefectsUI,
    getDemandsFromUI, getDefectsFromUI
} from './quota-manager.js';
import { showToast } from '../../core/toast.js';
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

    const rollIdInp = document.getElementById("inp-roll-id");
    if (rollIdInp && document.getElementById("sb-roll-id")) {
        document.getElementById("sb-roll-id").innerText = rollIdInp.value;
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
    if (rightTabRemBadge) rightTabRemBadge.innerText = `${(data.remnants || []).length} 块`;
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
                <td><code style="color: #38bdf8; font-weight: 700; font-size: 11.5px;">${r.id}</code></td>
                <td>${r.w} × ${r.l} mm</td>
                <td>${r.area.toFixed(2)} m²</td>
                <td><span class="${r.hasDefect ? 'badge-cut' : 'badge-rem'}">${r.status || (r.hasDefect ? '带疵料头' : '完好可用')}</span></td>
                <td>
                    <button class="tool-btn rem-locate-btn"
                        style="font-size: 10px; padding: 2px 6px; color: #38bdf8; border: 1px solid rgba(56,189,248,0.4); background: rgba(56,189,248,0.1); cursor: pointer;"
                        onclick="event.stopPropagation(); window.selectRemnant('${r.id}', { fromTable: true, smoothPan: true, showToastMsg: true })"
                        title="在 CAD 画布中居中定位此料头">
                        🎯 定位
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

    if (document.getElementById("lbl-deduct-len")) {
        document.getElementById("lbl-deduct-len").innerText = hasStationPlan ? `${data.deductLen || 0} mm` : "—";
    }
    if (document.getElementById("lbl-piece-area")) document.getElementById("lbl-piece-area").innerText = `${(data.pieceArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-rem-area")) document.getElementById("lbl-rem-area").innerText = `${(data.remArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-waste-area")) document.getElementById("lbl-waste-area").innerText = `${(data.wasteArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-total-area")) document.getElementById("lbl-total-area").innerText = `${(data.totalArea || 0).toFixed(3)} m²`;

    const utilization = data.lastReceipt ? data.lastReceipt.utilization :
        ((data.totalArea || 0) > 0 ? (data.pieceArea || 0) / data.totalArea * 100 : 0);
    const utilEl = document.getElementById("lbl-utilization");
    if (utilEl) {
        utilEl.innerText = hasStationPlan && (data.totalArea || 0) > 0 ? `${utilization.toFixed(1)}% ${data.lastReceipt ? '实切' : '方案'}` : "—";
    }
    const reportEl = document.getElementById("lbl-report-status");
    if (reportEl) {
        reportEl.innerText = data.lastReceipt ? `已确认 ${data.lastReceipt.planId.slice(0, 8)}` :
            (state.pendingPlan ? '方案待实切确认' : (hasStationPlan ? '方案待实切确认' : '工位就绪 / 待排料'));
    }

    const sum = (data.pieceArea || 0) + (data.remArea || 0) + (data.wasteArea || 0);
    const diff = Math.abs(sum - (data.totalArea || 0));
    const statusEl = document.getElementById("lbl-balance-status");
    if (statusEl) {
        if (!hasStationPlan || (data.totalArea || 0) === 0) {
            statusEl.className = "status-badge";
            statusEl.innerText = "工位就绪 (待排料)";
        } else if (diff < 0.001) {
            statusEl.className = "status-badge";
            statusEl.innerText = "100.0% 严密守恒";
        } else {
            statusEl.className = "badge-cut";
            statusEl.innerText = `偏差: ${diff.toFixed(3)} m²`;
        }
    }

    // 母卷剩余米数实时对齐
    const rollRemainingEl = document.getElementById("lbl-roll-remaining");
    if (rollRemainingEl) {
        const totalRollL = data.totalRollL || 60000;
        let maxConfirmedY = 0;
        (data.pieces || []).filter(p => p.confirmed).forEach(p => {
            if (p.y + p.l > maxConfirmedY) maxConfirmedY = p.y + p.l;
        });
        if (data.lastReceipt && data.lastReceipt.windowStartY !== undefined && data.lastReceipt.actualCutLen) {
            const rEnd = data.lastReceipt.windowStartY + data.lastReceipt.actualCutLen;
            if (rEnd > maxConfirmedY) maxConfirmedY = Math.round(rEnd);
        }
        const remainingLen = Math.max(0, totalRollL - maxConfirmedY);
        rollRemainingEl.innerText = `${remainingLen.toLocaleString()} mm`;
    }
}

export function loadCase(id) {
    state.pendingPlan = null;
    clearRemnantSelection();
    if (state.currentCutMode !== "roll") {
        state.setCutMode("roll");
        const btnRoll = document.getElementById("tab-btn-roll");
        const btnRem = document.getElementById("tab-btn-remnant");
        const panelRoll = document.getElementById("panel-roll-mode");
        const panelRem = document.getElementById("panel-remnant-mode");
        const radarBar = document.getElementById("roll-radar-bar");
        if (btnRoll) btnRoll.className = "mode-tab-btn active roll-mode";
        if (btnRem) btnRem.className = "mode-tab-btn";
        if (panelRoll) panelRoll.style.display = "flex";
        if (panelRem) panelRem.style.display = "none";
        if (radarBar) {
            radarBar.style.opacity = "1";
            radarBar.style.pointerEvents = "auto";
        }
        const rightRollActions = document.getElementById("right-roll-actions");
        const rightRemnantActions = document.getElementById("right-remnant-actions");
        if (rightRollActions) rightRollActions.style.display = "block";
        if (rightRemnantActions) rightRemnantActions.style.display = "none";
    }
    state.setCaseId(id);
    state.scenarios[id].lastReceipt = null;
    for (let i = 1; i <= 8; i++) {
        const btn = document.getElementById(`btn-case-${i}`);
        if (btn) btn.classList.toggle("active", i === id);
    }
    const data = state.getCurrentCaseData();
    const rollId = data.rollId || "ROLL-2026-0920";

    // 1. 同步母卷下拉选框选项与当前值
    const selMother = document.getElementById("sel-mother-roll-id");
    if (selMother) {
        if (![...selMother.options].some(o => o.value === rollId)) {
            const opt = document.createElement("option");
            opt.value = rollId;
            opt.textContent = `${rollId} (${data.rollModel || ''} ${data.rollW ? (data.rollW/1000).toFixed(1) + 'm' : ''})`;
            selMother.appendChild(opt);
        }
        selMother.value = rollId;
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
        if (val === "right-bottom") { headerTag.innerText = `右下角 · ${bedL}mm`; headerTag.style.color = "#10b981"; }
        else if (val === "right-top") { headerTag.innerText = `右上角 · ${bedL}mm`; headerTag.style.color = "#38bdf8"; }
        else if (val === "left-bottom") { headerTag.innerText = `左下角 · ${bedL}mm`; headerTag.style.color = "#f59e0b"; }
        else { headerTag.innerText = `左上角 · ${bedL}mm`; headerTag.style.color = "#a855f7"; }
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
            craftHint.innerHTML = "🏆 <b>893292 窗帘整单</b>: 11项主帘定高横裁(幅宽2170~2715mm) · 门幅剩余630mm边料竖切套排窗幔/绑带/抱枕(37件套)";
        } else if (rollId === "ROLL-REAL-893153" || id === 8) {
            craftHint.innerHTML = "🏆 <b>893153 工程整单</b>: 4大超长工程主帘(5.4m~9m横裁) · 门幅剩余边料竖切套排长绑带/抱枕(18件套)";
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

export async function triggerSolve() {
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

        const tempWinEndY = winStartY + bedL;

        const isPieceInCurrentStation = (p) => {
            const pMid = p.y + p.l / 2;
            return (pMid >= winStartY && pMid < tempWinEndY);
        };
        const retainedPieces = (data.pieces || []).filter(p => !isPieceInCurrentStation(p));

        const externalUsageMap = new Map();
        (data.demands || []).forEach((d, idx) => {
            const dId = d.id || (idx + 1);
            const dName = (d.name || "").trim().toLowerCase();
            const dW = d.w || d.width || 0;
            const dL = d.l || d.length || 0;

            const usedCount = retainedPieces.filter(p => {
                if (p.demandId && p.demandId === dId) return true;
                if (dW > 0 && dL > 0) {
                    const sizeMatch = (Math.abs(p.w - dW) < 1.5 && Math.abs(p.l - dL) < 1.5) ||
                                      (Math.abs(p.w - dL) < 1.5 && Math.abs(p.l - dW) < 1.5);
                    if (sizeMatch) return true;
                }
                const pName = (p.name || "").trim().toLowerCase();
                if (pName && dName) {
                    return pName === dName || pName.startsWith(dName + "-") || pName.startsWith(dName + "_");
                }
                return false;
            }).length;
            externalUsageMap.set(dId, usedCount);
        });

        const rawDemands = getDemandsFromUI();
        if (rawDemands.length === 0) {
            showToast("请至少在左侧添加 1 项母卷开卷裁片需求！", "warning");
            return;
        }

        activeDemands = rawDemands.map((d, idx) => {
            const dId = d.id || (idx + 1);
            const extUsed = externalUsageMap.get(dId) || 0;
            const totalCount = (d.count !== undefined ? d.count : (d.demand !== undefined ? d.demand : 1));
            const availableQuota = Math.max(0, totalCount - extUsed);
            return {
                ...d,
                demand: availableQuota
            };
        }).filter(d => d.demand > 0);

        if (activeDemands.length === 0) {
            showToast("【需求已就绪】当前订单池裁片已完成排布，若需加料可增加计划件数。", "info");
            return;
        }
        demands = activeDemands;
    }

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
            margin: d.margin || 20
        }));

    const payload = {
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

    const t0 = performance.now();
    try {
        const res = await fetch("/api/solve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            const result = await res.json();
            const elapsed = Math.round(performance.now() - t0);
            if (result.success) {
                state.pendingPlan = { result, rollId, rollModel, bedL, feedPortType };
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
                    data.pieces = (result.pieces || []).map(p => ({ ...p, y: p.y }));
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
                        let matchedDemand = (activeDemands || []).find(ad => ad.id === p.demandId);
                        if (!matchedDemand) {
                            matchedDemand = (activeDemands || []).find(ad =>
                                (Math.abs(p.w - ad.w) < 1.5 && Math.abs(p.l - ad.l) < 1.5) ||
                                (Math.abs(p.w - ad.l) < 1.5 && Math.abs(p.l - ad.w) < 1.5)
                            );
                        }
                        if (!matchedDemand) {
                            matchedDemand = (activeDemands || []).find(ad => (ad.name || "").trim() === (p.name || "").trim());
                        }
                        if (!matchedDemand && data.demands) {
                            matchedDemand = data.demands.find(d => d.id === p.demandId);
                        }
                        return {
                            ...p,
                            id: retainedPieces.length + idx + 1,
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
                            end: !isHoriz ? (c.end + winStartY) : c.end
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

                data.engine = `${result.engine} [${elapsed}ms]`;
                state.setCutStepLimit(999);
                renderScene();
                if (isRemnantMode) {
                    resetToBedView();
                }
                updateUIInfo();

                bus.emit('solve:success', { result, elapsed, rollId });

                const stationCount = (data.cutIntervals || []).length;
                const totalCutPieces = (data.pieces || []).length;
                const thisBedPieces = (result.pieces || []).length;

                showToast(`直刀排料计算成功：产出 ${thisBedPieces} 件，利用率 ${(result.totalArea ? result.pieceArea / result.totalArea * 100 : 0).toFixed(1)}%`, 'success');
                return;
            } else {
                showToast("排料求解未能找到有效方案: " + (result.message || "未知原因"), "warning");
                return;
            }
        }
    } catch (err) {
        console.error(err);
        showToast("调用排料引擎接口异常: " + err.message, "error");
    }
}

export async function openCutReport() {
    let pending = state.pendingPlan;
    if (!pending || !pending.result || !pending.result.planId) {
        // 若当前未执行排料，自动触发一次后端试算建立草稿方案
        await triggerSolve();
        pending = state.pendingPlan;
    }
    if (!pending || !pending.result || !pending.result.planId) {
        showToast("当前工位暂无可确认的有效排料结果，请先检查需求并点击【在当前红框工位排料】。", "warning");
        return;
    }
    const { result, bedL, feedPortType } = pending;
    const defaultCutLen = (result.deductLen && result.deductLen > 0) ? result.deductLen : bedL;
    const actualLenInput = document.getElementById("report-actual-len");
    if (actualLenInput) {
        actualLenInput.value = feedPortType === "remnant" ? 0 : defaultCutLen;
        actualLenInput.disabled = feedPortType === "remnant";
    }
    const pieceCountInput = document.getElementById("report-piece-count");
    if (pieceCountInput) {
        pieceCountInput.value = result.pieces ? result.pieces.length : 0;
    }
    const remContainer = document.getElementById("report-remnants");
    if (remContainer) {
        remContainer.innerHTML = "";
        for (const remnant of result.remnants || []) {
            const row = document.createElement("div");
            row.className = "report-remnant-row";
            row.style.cssText = "display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap";
            const check = document.createElement("input"); check.type = "checkbox"; check.checked = true;
            check.onchange = () => updateReportPreview();
            const label = document.createElement("span"); label.textContent = `${remnant.status || '派生料头'} ${remnant.id}`;
            const width = document.createElement("input"); width.type = "number"; width.min = "1"; width.value = remnant.w; width.className = "prop-input report-w"; width.style.width = "80px";
            width.oninput = () => updateReportPreview();
            const length = document.createElement("input"); length.type = "number"; length.min = "1"; length.value = remnant.l; length.className = "prop-input report-l"; length.style.width = "80px";
            length.oninput = () => updateReportPreview();
            row.dataset.remnantId = remnant.id;
            row.append(check, label, width, document.createTextNode("×"), length, document.createTextNode("mm"));
            remContainer.append(row);
        }
    }
    document.getElementById("report-error").textContent = "可取消未回收料头；实测宽长允许小幅偏差，但不得越过母料或与成品、其他料头重叠。超出时请复核，勿改小实测值硬过。";

    // 填充三维闭环扣减预览看板
    await updateReportPreview();

    document.getElementById("cut-report-modal").style.display = "flex";
}

export async function updateReportPreview() {
    const pending = state.pendingPlan;
    if (!pending) return;
    const { rollId, result, feedPortType } = pending;
    const rollIdEl = document.getElementById("report-preview-roll-id");
    if (rollIdEl) rollIdEl.innerText = feedPortType === "remnant" ? (pending.sourceRemnantId || "料头切削") : (rollId || "母卷开卷");

    let curRemaining = 60000;
    try {
        const res = await fetch(`/api/rolls/${encodeURIComponent(rollId)}`, { cache: "no-store" });
        if (res.ok) {
            const roll = await res.json();
            curRemaining = roll.currentRemainingLength || 60000;
        }
    } catch (_) {}

    const curLenEl = document.getElementById("report-preview-cur-len");
    if (curLenEl) curLenEl.innerText = `${curRemaining.toLocaleString()}`;

    const cutLen = Number(document.getElementById("report-actual-len") ? document.getElementById("report-actual-len").value : 0);
    const afterLen = feedPortType === "remnant" ? curRemaining : Math.max(0, curRemaining - cutLen);
    const afterLenEl = document.getElementById("report-preview-after-len");
    if (afterLenEl) afterLenEl.innerText = `${afterLen.toLocaleString()} mm`;

    // 需求核销明细
    const pieces = result.pieces || [];
    const demandTextEl = document.getElementById("report-preview-demand-text");
    if (demandTextEl) {
        if (pieces.length === 0) {
            demandTextEl.innerText = "本工位暂无合格成品";
        } else {
            const counts = {};
            pieces.forEach(p => {
                const name = p.name || `${p.w}×${p.l}`;
                counts[name] = (counts[name] || 0) + 1;
            });
            const summary = Object.entries(counts).map(([name, c]) => `${name}×${c}`).join("、");
            demandTextEl.innerText = `本次产出 ${pieces.length} 件 (${summary})，将正式核销需求达成`;
        }
    }

    // 料头建档预览
    const remRows = [...document.querySelectorAll(".report-remnant-row")].filter(row => row.querySelector('input[type="checkbox"]').checked);
    const remTextEl = document.getElementById("report-preview-remnant-text");
    if (remTextEl) {
        if (remRows.length === 0) {
            remTextEl.innerText = "无派生料头回库";
        } else {
            remTextEl.innerText = `确认 ${remRows.length} 块有效料头，上架登记入库`;
        }
    }
}

export function closeCutReport() { document.getElementById("cut-report-modal").style.display = "none"; }

export async function openStationLapConfirmModal() {
    await openCutReport();
}

export async function confirmCutReport() {
    const pending = state.pendingPlan;
    if (!pending) return;
    const actualCutLen = Number(document.getElementById("report-actual-len").value);
    const finishedPieceCount = Number(document.getElementById("report-piece-count").value);
    const location = document.getElementById("report-location").value.trim();
    const actualRemnants = [...document.querySelectorAll(".report-remnant-row")]
        .filter(row => row.querySelector('input[type="checkbox"]').checked)
        .map(row => ({
            ...((pending.result.remnants || []).find(r => r.id === row.dataset.remnantId) || {}),
            w: Number(row.querySelector(".report-w").value),
            l: Number(row.querySelector(".report-l").value)
        }));

    const report = {
        planId: pending.result.planId,
        actualCutLen: actualCutLen,
        finishedPieceCount: finishedPieceCount,
        location: location,
        actualRemnants: actualRemnants
    };

    try {
        const response = await fetch("/api/cutting/report-confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report)
        });
        const receipt = await response.json();
        if (!response.ok) throw new Error(receipt.message || "实切确认失败");

        const data = state.getCurrentCaseData();
        data.lastReceipt = receipt;
        state.lastCutReceipt = receipt;
        state.pendingPlan = null;

        // 1. 标记当前工位内的裁片为已实切确认
        const winStartY = pending.result.windowStartY !== undefined ? pending.result.windowStartY : (data.windowStartY || 0);
        const bedL = pending.bedL || 5000;
        const winEndY = winStartY + (receipt.actualCutLen || bedL);
        (data.pieces || []).forEach(p => {
            const pMid = p.y + p.l / 2;
            if (pMid >= winStartY && pMid <= winEndY) {
                p.confirmed = true;
            }
        });

        // 1.1 固化与截断当前工位料头，彻底消除越过实切截断线的假料头
        (data.remnants || []).forEach(r => {
            if (r.y >= winStartY && r.y + r.l <= winEndY + 5) {
                r.confirmed = true;
            } else if (r.y < winEndY && r.y + r.l > winEndY) {
                const newL = Math.max(0, winEndY - r.y);
                r.l = newL;
                r.area = Number(((r.w * newL) / 1000000.0).toFixed(3));
                r.confirmed = true;
            }
        });
        data.remnants = (data.remnants || []).filter(r => r.y < winEndY - 5 && r.l >= 100);

        // 2. 扣减与核销订单需求
        updateDemandCompletionFromPieces(data);
        renderDemandsUI(data.demands);

        // 3. 更新母卷看板状态 (总长、余量、已扣用料及进度条)
        const remaining = document.getElementById("lbl-roll-remaining");
        if (remaining && receipt.remainingLength != null) remaining.innerText = `${receipt.remainingLength} mm`;

        const rollResponse = await fetch(`/api/rolls/${encodeURIComponent(pending.rollId)}`, { cache: "no-store" });
        if (rollResponse.ok) {
            const roll = await rollResponse.json();
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
            showToast(`✅ 料头精益实切确认成功！原料头已核销，产出合格品 ${receipt.finishedPieceCount} 件，母卷 0 消耗，派生新料头 ${remCount} 块已建档入库！`, "success");
        } else {
            showToast(`✅ 工位搭切确认成功！母卷扣减 ${receipt.actualCutLen} mm (余 ${receipt.remainingLength != null ? receipt.remainingLength.toLocaleString() : '--'} mm)，核销需求 ${receipt.finishedPieceCount} 件，派生料头 ${remCount} 块已建档入库！`, "success");

            // 自动化现场核心交互：自动推进至下一待切工位，已切区域固化为历史，并更新当前拉布基准
            setTimeout(() => {
                data.cuts = [];
                smartAdvanceBed();
                const curY = state.getCurrentCaseData().windowStartY || 0;
                const baseOriginEl = document.getElementById("lbl-roll-base-origin");
                if (baseOriginEl) baseOriginEl.innerText = `Y = ${curY.toLocaleString()} mm (${(curY/1000).toFixed(2)}m)`;
                if (window.camApp && window.camApp.updateToolpathStatsUI) {
                    window.camApp.updateToolpathStatsUI();
                }
                showToast(`🚀 已自动为您推进至下一待切工位 (开卷物理进给基准 Y=${curY}mm)，已切区域已归档为历史！`, "info");
            }, 350);
        }
    } catch (error) {
        document.getElementById("report-error").textContent = error.message;
    }
}

export function exportCutResult() {
    const data = state.getCurrentCaseData();
    const exportData = { status: data.lastReceipt ? "已实切确认" : "示例或方案预览", receipt: data.lastReceipt || null,
        rollId: data.rollId || null, demands: data.demands || [], pieces: data.pieces || [], cuts: data.cuts || [],
        remnants: data.remnants || [], pieceArea: data.pieceArea || 0,
        utilization: data.lastReceipt ? data.lastReceipt.utilization : ((data.totalArea || 0) ? data.pieceArea / data.totalArea * 100 : 0) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `cut-result-${Date.now()}.json`; link.click();
    URL.revokeObjectURL(url);
}

export function renderCutTable(cuts) {
    const data = state.getCurrentCaseData();
    if (cuts) data.cuts = cuts;
    recalculateRollStats(data);
}
