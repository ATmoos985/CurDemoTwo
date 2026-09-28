/**
 * 需求配额核销与工位加工区间管理器 (Quota & Interval Manager Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { updateUIInfo } from './solver-client.js';
import { showToast } from '../../core/toast.js';
import { CURTAIN_ORDER_TEMPLATES } from '../presets/scenarios.js';

export function updateDemandCompletionFromPieces(data) {
    if (!data || !data.demands) return;
    const pieces = data.pieces || [];
    data.demands.forEach((d, idx) => {
        const dName = (d.name || "").trim().toLowerCase();
        const dW = d.w || d.width || 0;
        const dL = d.l || d.length || 0;
        const dId = d.id || (idx + 1);

        const matched = pieces.filter(p => {
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
        });
        d.completed = matched.length;
        const totalCount = (d.count !== undefined ? d.count : (d.demand !== undefined ? d.demand : 1));
        d.remaining = Math.max(0, totalCount - d.completed);
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
    const rollW = data.rollW || 2000;
    const isRemnantMode = (state.currentCutMode === "remnant");

    if (isRemnantMode) {
        const bedL = data.bedL || 1000;
        data.deductLen = 0;
        data.pieceArea = (data.pieces || []).reduce((acc, p) => acc + (p.w * p.l) / 1000000.0, 0);
        data.remArea = (data.remnants || []).reduce((acc, r) => acc + (r.area !== undefined ? r.area : (r.w * r.l)/1000000.0), 0);
        data.totalArea = (rollW * bedL) / 1000000.0;
        data.wasteArea = Math.max(0, data.totalArea - data.pieceArea - data.remArea);
        return;
    }

    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;

    // 1. 过滤属于当前工位 [winStartY, winEndY) 的裁片与料头
    const isPieceInCurrentStation = (p) => {
        const pMid = p.y + p.l / 2;
        return (pMid >= winStartY && pMid < winEndY);
    };
    const stationPieces = (data.pieces || []).filter(isPieceInCurrentStation);

    const isRemInCurrentStation = (r) => {
        const rMid = r.y + r.l / 2;
        return (rMid >= winStartY && rMid < winEndY);
    };
    const stationRemnants = (data.remnants || []).filter(isRemInCurrentStation);

    // 2. 当前工位进给/落料跨度（本次用料长度）
    let maxStationY = 0;
    if (stationPieces.length > 0) {
        maxStationY = Math.max(...stationPieces.map(p => p.y + p.l));
    }
    if (stationRemnants.length > 0) {
        maxStationY = Math.max(maxStationY, ...stationRemnants.map(r => r.y + r.l));
    }
    if (data.cuts && data.cuts.length > 0) {
        data.cuts.filter(c => c.type === "横切" && c.pos >= winStartY && c.pos <= winEndY).forEach(c => {
            if (c.pos > maxStationY) maxStationY = c.pos;
        });
    }

    let stationSpan = 0;
    if (maxStationY > winStartY) {
        stationSpan = Math.round(maxStationY - winStartY);
    } else if (state.pendingPlan && state.pendingPlan.result && state.pendingPlan.result.deductLen && state.pendingPlan.result.windowStartY === winStartY) {
        stationSpan = Math.round(state.pendingPlan.result.deductLen);
    }

    // 3. 计算“本次用料与实切对账”台账
    if (stationSpan === 0 && stationPieces.length === 0 && stationRemnants.length === 0) {
        // 当前工位尚未排料或已清空
        data.deductLen = 0;
        data.pieceArea = 0;
        data.remArea = 0;
        data.wasteArea = 0;
        data.totalArea = 0;
    } else {
        data.deductLen = stationSpan;
        const effectiveBedL = (stationSpan > 0 ? stationSpan : bedL);
        data.totalArea = (rollW * effectiveBedL) / 1000000.0;
        data.pieceArea = stationPieces.reduce((acc, p) => acc + (p.w * p.l) / 1000000.0, 0);
        data.remArea = stationRemnants.reduce((acc, r) => acc + (r.area !== undefined ? r.area : (r.w * r.l)/1000000.0), 0);
        data.wasteArea = Math.max(0, data.totalArea - data.pieceArea - data.remArea);
    }

    // 4. 全局累计已下料长度
    let maxGlobalY = 0;
    (data.pieces || []).forEach(p => {
        if (p.y + p.l > maxGlobalY) maxGlobalY = p.y + p.l;
    });
    data.globalMaxCutY = maxGlobalY;
}

export function clearStationCuts() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const isRemnantMode = (state.currentCutMode === "remnant");

    if (isRemnantMode) {
        const removedPieces = (data.pieces || []).length;
        data.pieces = [];
        data.cuts = [];
        data.remnants = [];
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

        showToast(`料头排料已清空：已清除当前在台料头上的 ${removedPieces} 件裁片与切刀`, "info");
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
    data.pieces = (data.pieces || []).filter(p => !isPieceInCurrentStation(p));
    const removedPieces = oldCount - data.pieces.length;

    // 清空切刀：CNC 数控切刀严格属于当前工位
    data.cuts = [];
    state.setCutStepLimit(999);
    state.pendingPlan = null;

    const isRemInCurrentStation = (r) => {
        const rMid = r.y + r.l / 2;
        return (rMid >= winStartY && rMid < winEndY);
    };
    data.remnants = (data.remnants || []).filter(r => !isRemInCurrentStation(r));

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

    showToast(`工位排料已清除：已移除工位 [${winStartY}~${winEndY}mm] 内的 ${removedPieces} 件裁片与切刀`, "info");
}

export async function resetAllRollCuts() {
    if (!confirm("确定要清空整卷所有工位的已排裁片与切刀记录吗？\n这将恢复为未开卷裁切的整料状态，所有需求件数核销将归零。")) {
        return;
    }
    const data = state.getCurrentCaseData();
    if (!data) return;
    const rollId = data.rollId || "ROLL-2026-0920";
    try {
        await fetch(`/api/rolls/${encodeURIComponent(rollId)}/reset`, { method: "POST" });
    } catch (_) {}

    data.pieces = [];
    data.cuts = [];
    data.remnants = [];
    data.cutIntervals = [];
    data.deductLen = 0;
    data.pieceArea = 0;
    data.remArea = 0;
    data.wasteArea = 0;
    data.totalArea = 0;
    data.lastReceipt = null;
    state.lastCutReceipt = null;
    state.pendingPlan = null;
    if (data.demands) {
        data.demands.forEach(d => { d.completed = 0; });
    }

    if (window.camApp && window.camApp.updateMotherRollRemnantStats) {
        await window.camApp.updateMotherRollRemnantStats(rollId);
    }
    if (window.camApp && window.camApp.refreshShelfRemnantsList) {
        await window.camApp.refreshShelfRemnantsList();
    }

    renderDemandsUI(data.demands);
    renderScene();
    drawRulers();
    updateUIInfo();
    showToast("整卷排料已重置：母卷已恢复初始全长，历史实切记录已清空，可从头开始在任意红框工位排料", "info");
}

export function renderDemandsUI(demands) {
    const container = document.getElementById("demands-container");
    if (!container) return;
    container.innerHTML = "";
    if (!demands || demands.length === 0) {
        container.innerHTML = "<div style='color:var(--text-muted);font-size:11px;padding:4px;'>暂无需求 (可点击上方+增裁片)</div>";
        const badge = document.getElementById("demands-summary-badge");
        if (badge) badge.innerText = "0 件";
        return;
    }

    let totalPlanAll = 0;
    let totalCutAll = 0;

    demands.forEach((dem, idx) => {
        const row = document.createElement("div");
        row.className = "item-row";
        const wVal = dem.w !== undefined ? dem.w : (dem.width !== undefined ? dem.width : 500);
        const lVal = dem.l !== undefined ? dem.l : (dem.length !== undefined ? dem.length : 500);
        const totalCount = dem.count !== undefined ? dem.count : (dem.demand !== undefined ? dem.demand : 1);
        const completed = dem.completed !== undefined ? dem.completed : 0;
        const remaining = Math.max(0, totalCount - completed);

        totalPlanAll += totalCount;
        totalCutAll += completed;

        row.setAttribute("data-id", idx + 1);
        row.setAttribute("data-completed", completed);
        row.setAttribute("data-total", totalCount);

        const isDone = (completed >= totalCount && totalCount > 0);
        const isProgress = (!isDone && completed > 0);

        let statusBadge = "";
        let progressPct = Math.min(100, Math.round((completed / Math.max(1, totalCount)) * 100));
        let progressColor = "#0284c7";

        if (isDone) {
            statusBadge = `<span style="font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; background:#ecfdf5; color:#059669; border:1px solid #10b981;">已满额 (${completed}/${totalCount})</span>`;
            progressColor = "#10b981";
        } else if (isProgress) {
            statusBadge = `<span style="font-size:10px; font-weight:600; padding:1px 5px; border-radius:3px; background:#eff6ff; color:#0284c7; border:1px solid #38bdf8;">已切 ${completed}/${totalCount}</span>`;
            progressColor = "#0284c7";
        } else {
            statusBadge = `<span style="font-size:10px; padding:1px 5px; border-radius:3px; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1;">待排 0/${totalCount}</span>`;
            progressColor = "#94a3b8";
        }

        row.innerHTML = `
            <div class="item-row-header" style="display:flex; justify-content:space-between; align-items:center;">
                <input type="text" class="dem-name" value="${dem.name || ('裁片-' + (idx + 1))}" style="font-weight:600; flex:1; margin-right:6px;" onchange="window.camApp.onParamChange()">
                ${statusBadge}
                <button class="del-btn" onclick="this.closest('.item-row').remove(); window.camApp.onParamChange();" title="删除此裁片需求" style="margin-left:6px;">×</button>
            </div>
            <div class="mini-input-group" style="margin-top:4px;">
                <span>宽:</span><input type="number" class="mini-input dem-w" value="${wVal}" onchange="window.camApp.onParamChange()" style="width:52px;">
                <span>长:</span><input type="number" class="mini-input dem-l" value="${lVal}" onchange="window.camApp.onParamChange()" style="width:52px;">
                <span>计划:</span><input type="number" class="mini-input dem-count" value="${totalCount}" min="1" style="width:42px; font-weight:bold;" onchange="window.camApp.onParamChange()" title="总计划需求件数">
                <span style="font-size:10px; color:var(--text-muted); margin-left:auto;">待切: <b style="color:${remaining > 0 ? 'var(--accent-blue)' : 'var(--accent-green)'}; font-weight:700;">${remaining}</b> 件</span>
            </div>
            <div style="margin-top:5px; background:var(--panel-border); height:4px; border-radius:2px; overflow:hidden;">
                <div style="background:${progressColor}; width:${progressPct}%; height:100%;"></div>
            </div>
            <div class="demand-remnant-box" id="rem-hint-${idx}" style="display: none;"></div>
        `;
        container.appendChild(row);
    });

    const headerTitleBadge = document.getElementById("demands-summary-badge");
    if (headerTitleBadge) {
        headerTitleBadge.innerText = `已切 ${totalCutAll} / 总 ${totalPlanAll} 件`;
        if (totalCutAll >= totalPlanAll && totalPlanAll > 0) {
            headerTitleBadge.style.background = "#ecfdf5";
            headerTitleBadge.style.color = "#059669";
            headerTitleBadge.style.borderColor = "#10b981";
        } else {
            headerTitleBadge.style.background = "#eff6ff";
            headerTitleBadge.style.color = "#0284c7";
            headerTitleBadge.style.borderColor = "#38bdf8";
        }
    }
}

export function renderDefectsUI(defects) {
    const container = document.getElementById("defects-container");
    if (!container) return;
    container.innerHTML = "";
    if (!defects || defects.length === 0) {
        container.innerHTML = "<div style='color:var(--text-muted);font-size:11px;padding:4px;'>暂无瑕疵点 (可点击上方+增疵点)</div>";
        return;
    }
    defects.forEach((d, idx) => {
        const row = document.createElement("div");
        row.className = "item-row";
        row.setAttribute("data-id", d.id || (idx + 1));
        row.innerHTML = `
            <div class="item-row-header">
                <span style="color:#f87171;">瑕疵 #${d.id || (idx + 1)}</span>
                <button class="del-btn" onclick="this.closest('.item-row').remove(); window.camApp.onParamChange();">×</button>
            </div>
            <div class="mini-input-group">
                <span>X:</span><input type="number" class="mini-input d-x" value="${d.x}" onchange="window.camApp.onParamChange()">
                <span>Y:</span><input type="number" class="mini-input d-y" value="${d.y}" onchange="window.camApp.onParamChange()">
                <span>宽:</span><input type="number" class="mini-input d-w" value="${d.w}" onchange="window.camApp.onParamChange()">
                <span>长:</span><input type="number" class="mini-input d-h" value="${d.h}" onchange="window.camApp.onParamChange()">
                <span>余:</span><input type="number" class="mini-input d-margin" value="${d.margin !== undefined ? d.margin : 20}" title="安全避让余量" onchange="window.camApp.onParamChange()">
            </div>
        `;
        container.appendChild(row);
    });

    const tagDefects = document.getElementById("tag-defects-summary");
    if (tagDefects) {
        const count = (defects || []).length;
        tagDefects.innerText = count > 0 ? `共 ${count} 处瑕疵` : "无瑕疵";
        tagDefects.style.color = count > 0 ? "#f59e0b" : "var(--text-muted)";
    }
}

export function addDefectRow() {
    const container = document.getElementById("defects-container");
    if (container.querySelector("div[style*='暂无']")) container.innerHTML = "";
    const id = container.querySelectorAll(".item-row").length + 1;
    const row = document.createElement("div");
    row.className = "item-row";
    row.setAttribute("data-id", id);
    row.innerHTML = `
        <div class="item-row-header">
            <span style="color:#f87171;">瑕疵 #${id}</span>
            <button class="del-btn" onclick="this.closest('.item-row').remove(); window.camApp.onParamChange();">×</button>
        </div>
        <div class="mini-input-group">
            <span>X:</span><input type="number" class="mini-input d-x" value="200" onchange="window.camApp.onParamChange()">
            <span>Y:</span><input type="number" class="mini-input d-y" value="1000" onchange="window.camApp.onParamChange()">
            <span>宽:</span><input type="number" class="mini-input d-w" value="150" onchange="window.camApp.onParamChange()">
            <span>长:</span><input type="number" class="mini-input d-h" value="200" onchange="window.camApp.onParamChange()">
            <span>余:</span><input type="number" class="mini-input d-margin" value="20" title="安全避让余量" onchange="window.camApp.onParamChange()">
        </div>
    `;
    container.appendChild(row);
    const tagDefects = document.getElementById("tag-defects-summary");
    if (tagDefects) {
        const count = container.querySelectorAll(".item-row").length;
        tagDefects.innerText = `共 ${count} 处瑕疵`;
        tagDefects.style.color = "#f59e0b";
    }
    onParamChange();
}

export function addDemandRow() {
    const container = document.getElementById("demands-container");
    if (container.querySelector("div[style*='暂无']")) container.innerHTML = "";
    const id = container.querySelectorAll(".item-row").length + 1;
    const row = document.createElement("div");
    row.className = "item-row";
    row.setAttribute("data-id", id);
    row.setAttribute("data-completed", 0);
    row.setAttribute("data-total", 4);
    row.innerHTML = `
        <div class="item-row-header" style="display:flex; justify-content:space-between; align-items:center;">
            <input type="text" class="dem-name" value="新裁片-${id}" style="font-weight:600; flex:1; margin-right:6px;" onchange="window.camApp.onParamChange()">
            <span style="font-size:10px; padding:1px 5px; border-radius:3px; background:#f1f5f9; color:#64748b; border:1px solid #cbd5e1;">待排 0/4</span>
            <button class="del-btn" onclick="this.closest('.item-row').remove(); window.camApp.onParamChange();" style="margin-left:6px;">×</button>
        </div>
        <div class="mini-input-group" style="margin-top:4px;">
            <span>宽:</span><input type="number" class="mini-input dem-w" value="600" onchange="window.camApp.onParamChange()" style="width:52px;">
            <span>长:</span><input type="number" class="mini-input dem-l" value="800" onchange="window.camApp.onParamChange()" style="width:52px;">
            <span>计划:</span><input type="number" class="mini-input dem-count" value="4" min="1" style="width:42px; font-weight:bold;" onchange="window.camApp.onParamChange()">
            <span style="font-size:10px; color:var(--text-muted); margin-left:auto;">待切: <b style="color:var(--accent-blue); font-weight:700;">4</b> 件</span>
        </div>
        <div style="margin-top:5px; background:var(--panel-border); height:4px; border-radius:2px; overflow:hidden;">
            <div style="background:#94a3b8; width:0%; height:100%;"></div>
        </div>
    `;
    container.appendChild(row);
    onParamChange();
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
        const margin = parseFloat(r.querySelector(".d-margin").value) || 20;
        list.push({ id, x, y, w, h, margin });
    });
    return list;
}

export function getDemandsFromUI() {
    const list = [];
    const rows = document.querySelectorAll("#demands-container .item-row");
    rows.forEach((r, idx) => {
        const id = idx + 1;
        const name = (r.querySelector(".dem-name") ? r.querySelector(".dem-name").value.trim() : "") || ("裁片-" + id);
        const width = parseFloat(r.querySelector(".dem-w") ? r.querySelector(".dem-w").value : 500) || 500;
        const length = parseFloat(r.querySelector(".dem-l") ? r.querySelector(".dem-l").value : 500) || 500;
        const totalCount = parseInt(r.querySelector(".dem-count") ? r.querySelector(".dem-count").value : 1) || 1;
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
            allowRotation: false
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
    const data = state.getCurrentCaseData();
    data.totalRollL = parseFloat(document.getElementById("inp-total-roll-l").value) || 60000;
    data.bedL = parseFloat(document.getElementById("inp-bed-l").value) || 5000;
    data.windowStartY = parseFloat(document.getElementById("inp-window-start-y").value) || 0;
    data.rollW = parseFloat(document.getElementById("inp-roll-w").value) || 2000;
    updateOriginHeaderSummary();
    renderScene();
    resetToBedView();
}

export function onOriginParamChange() {
    const data = state.getCurrentCaseData();
    data.trimStart = parseFloat(document.getElementById("inp-trim-start").value) || 0;
    data.cutOrigin = document.getElementById("sel-cut-origin").value || "right-bottom";
    data.firstStageOrientation = document.getElementById("sel-first-stage").value;
    data.allowRotation = (document.getElementById("sel-allow-rotation").value === "1");
    data.globalDefects = getDefectsFromUI();

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

    showToast(`已成功载入窗帘订单模板: ${tpl.name} (${newDemands.length} 项规格)，正在排料...`, "info");

    const sel = document.getElementById("sel-curtain-order-template");
    if (sel) sel.value = "";
    const selRem = document.getElementById("sel-remnant-order-template");
    if (selRem) selRem.value = "";

    // 自动触发排料计算，直接在画布展示最优排料与刀序
    if (window.camApp && typeof window.camApp.triggerSolve === 'function') {
        setTimeout(() => {
            window.camApp.triggerSolve();
        }, 150);
    }
}

