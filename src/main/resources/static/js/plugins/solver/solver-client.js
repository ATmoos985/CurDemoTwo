/**
 * 求解器通信与排料控制插件 (Solver Client Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { drawRulers } from '../cad/cad-rulers.js';
import {
    updateDemandCompletionFromPieces, recalculateRollStats,
    addOrMergeInterval, renderDemandsUI, renderDefectsUI,
    getDemandsFromUI, getDefectsFromUI
} from './quota-manager.js';

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
        remTbody.innerHTML = (data.remnants || []).map(r => `
            <tr>
                <td><code>${r.id}</code></td>
                <td>${r.w} × ${r.l} mm</td>
                <td>${r.area.toFixed(2)} m²</td>
                <td><span class="${r.hasDefect ? 'badge-cut' : 'badge-rem'}">${r.status}</span></td>
                <td><button class="tool-btn" style="padding: 1px 4px; font-size: 10px; background: var(--badge-green-bg); color: var(--badge-green-color); border: 1px solid var(--accent-green); font-weight: 600;" onclick="window.camApp.registerCurrentRemnant('${r.id}', ${r.w}, ${r.l}, ${r.hasDefect || false})">入库</button></td>
            </tr>
        `).join("");
    }

    // 台账数据
    if (document.getElementById("lbl-deduct-len")) document.getElementById("lbl-deduct-len").innerText = `${data.deductLen || data.bedL} mm`;
    if (document.getElementById("lbl-piece-area")) document.getElementById("lbl-piece-area").innerText = `${(data.pieceArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-rem-area")) document.getElementById("lbl-rem-area").innerText = `${(data.remArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-waste-area")) document.getElementById("lbl-waste-area").innerText = `${(data.wasteArea || 0).toFixed(3)} m²`;
    if (document.getElementById("lbl-total-area")) document.getElementById("lbl-total-area").innerText = `${(data.totalArea || 0).toFixed(3)} m²`;

    const sum = (data.pieceArea || 0) + (data.remArea || 0) + (data.wasteArea || 0);
    const diff = Math.abs(sum - (data.totalArea || 0));
    const statusEl = document.getElementById("lbl-balance-status");
    if (statusEl) {
        if (diff < 0.001) {
            statusEl.className = "status-badge";
            statusEl.innerText = "100.0% 严格守恒";
        } else {
            statusEl.className = "badge-cut";
            statusEl.innerText = `偏差: ${diff.toFixed(3)} m²`;
        }
    }
}

export function loadCase(id) {
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
    }
    state.setCaseId(id);
    for (let i = 1; i <= 4; i++) {
        const btn = document.getElementById(`btn-case-${i}`);
        if (btn) btn.classList.toggle("active", i === id);
    }
    const data = state.getCurrentCaseData();
    if (document.getElementById("inp-total-roll-l")) document.getElementById("inp-total-roll-l").value = data.totalRollL || 60000;
    if (document.getElementById("inp-bed-l")) document.getElementById("inp-bed-l").value = data.bedL || 5000;
    if (document.getElementById("inp-window-start-y")) document.getElementById("inp-window-start-y").value = data.windowStartY || 0;
    if (document.getElementById("inp-roll-w")) document.getElementById("inp-roll-w").value = data.rollW || 2000;

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

    updateDemandCompletionFromPieces(data);
    recalculateRollStats(data);

    renderDefectsUI(data.globalDefects || data.defects || []);
    renderDemandsUI(data.demands);

    renderScene();
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
            alert("【料头切割提示】请先在左侧料头货架中选择或扫描一块料头装载至机台！");
            return;
        }
        demands = window.camApp ? window.camApp.getRemnantDemandsFromUI() : [];
        if (!demands || demands.length === 0) {
            alert("【排料提示】请至少在左侧添加 1 项料头裁片套裁需求！");
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
            alert("【排料提示】请至少在左侧添加 1 项母卷开卷裁片需求！");
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
            alert("【订单需求已全部完成】\n当前订单池中所有裁片均已在其他工位完成排料！\n\n您可以：\n1. 点击【+ 增裁片】或在现有裁片上增加【计划件数】；\n2. 点击【清空整卷已排】从头开始新一轮接续排料模拟。");
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
                data.rollW = rollW;
                data.bedL = bedL;
                data.windowStartY = winStartY;
                data.trimStart = trimStart;
                data.cutOrigin = cutOrigin;
                data.firstStageOrientation = firstStageOrientation;
                data.allowRotation = allowRotation;
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

                    const isCutInCurrentStation = (c) => {
                        if (c.type === "横切") return (c.pos > winStartY && c.pos < winEndY);
                        const cutMidY = (c.start + c.end) / 2;
                        return (cutMidY >= winStartY && cutMidY <= winEndY);
                    };
                    const retainedCuts = (data.cuts || []).filter(c => !isCutInCurrentStation(c));
                    const newCuts = (result.cuts || []).map((c, idx) => {
                        const isHoriz = (c.type === "横切");
                        return {
                            ...c,
                            pos: isHoriz ? (c.pos + winStartY) : c.pos,
                            start: !isHoriz ? (c.start + winStartY) : c.start,
                            end: !isHoriz ? (c.end + winStartY) : c.end
                        };
                    });
                    data.cuts = [...retainedCuts, ...newCuts];
                    data.cuts.forEach((c, idx) => { c.step = idx + 1; });

                    const isRemInCurrentStation = (r) => {
                        const rMid = r.y + r.l / 2;
                        return (rMid >= winStartY && rMid < winEndY);
                    };
                    const retainedRemnants = (data.remnants || []).filter(r => !isRemInCurrentStation(r));
                    const newRemnants = (result.remnants || []).map(r => ({
                        ...r,
                        y: r.y + winStartY
                    }));
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

                let derivedMsg = "";
                if (result.derivedRemnants && result.derivedRemnants.length > 0) {
                    derivedMsg = `\n自动归档新料头至 [${rollId}] 货架:\n` +
                        result.derivedRemnants.map(d => `  · ${d.id} (${d.width}×${d.length}mm, ${d.location})`).join("\n");
                }

                const stationCount = (data.cutIntervals || []).length;
                const totalCutPieces = (data.pieces || []).length;
                const thisBedPieces = (result.pieces || []).length;

                alert(`【智能几何排料计算成功】\n` +
                    `工位模式: ${isRemnantMode ? '模式二：料头复用精益切割 (母卷 0 消耗)' : '模式一：母卷连续开卷接续搭切'}\n` +
                    `母卷批号: ${rollId} (${rollModel})\n` +
                    `当前工位: ${winStartY} ~ ${winEndY} mm (${(winStartY/1000).toFixed(1)}m ~ ${(winEndY/1000).toFixed(1)}m)\n` +
                    `起刀基准: 右下角 (靠右导轨对齐, 经向送料)\n` +
                    `计算引擎: ${result.engine} [${elapsed}ms]\n` +
                    `避让疵点: ${activeBedDefects.length} 处\n` +
                    `本工位产出: ${thisBedPieces} 件 (整卷累计保留: ${totalCutPieces} 件)\n` +
                    `切刀工步: 本次 ${result.cuts.length} 步 (整卷累计: ${(data.cuts||[]).length} 步直刀)\n` +
                    `母卷加工: 累计 ${(data.deductLen/1000).toFixed(1)}m (${stationCount} 个工位接续)\n` +
                    `面积守恒: ${data.totalArea.toFixed(3)} m² (100% 严密守恒)${derivedMsg}`);
                return;
            } else {
                alert("【智能排料计算失败】\n" + (result.message || "未知原因"));
                return;
            }
        }
    } catch (err) {
        console.error(err);
        alert("调用后端 /api/solve 异常: " + err.message);
    }
}

export async function registerCurrentRemnant(remId, w, l, hasDefect) {
    const loc = prompt("请输入此料头的存放库位 (如 A-02-05):", "库位 A-02-05");
    if (!loc) return;
    const curRollId = document.getElementById("sel-mother-roll-id") ? document.getElementById("sel-mother-roll-id").value : "ROLL-2026-0920";
    const newRem = {
        id: remId + "-" + Math.floor(Math.random() * 900 + 100),
        width: w,
        length: l,
        location: loc,
        materialBatch: "现场已开卷批次",
        status: "AVAILABLE",
        sourceRollId: curRollId,
        hasDefect: hasDefect,
        defectDesc: hasDefect ? "裁切分离出的带疵余料" : "现场裁切合格矩形余料"
    };
    try {
        const res = await fetch("/api/remnants/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newRem)
        });
        if (res.ok) {
            const saved = await res.json();
            alert(`料头 [${saved.id}] 登记入库成功！\n尺寸: ${saved.width} × ${saved.length} mm\n所属母卷: ${saved.sourceRollId}\n库位: ${saved.location}\n已加入现场料头池，随时支持扫码识别与 0 扣料领用！`);
            bus.emit('remnant:registered', { saved, curRollId });
        }
    } catch (e) {
        alert("登记料头异常: " + e.message);
    }
}

export function renderCutTable(cuts) {
    const data = state.getCurrentCaseData();
    if (cuts) data.cuts = cuts;
    recalculateRollStats(data);
}
