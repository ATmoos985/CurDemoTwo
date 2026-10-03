/**
 * 现场料头货架与双模式工位管理插件 (Remnant Shelf Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView, updateStatusBar } from '../cad/cad-renderer.js';
import { renderDefectsUI, updateDemandCompletionFromPieces, loadCurtainOrderTemplate, renderDemandsUI, getDemandsFromUI, addDemandRow } from '../solver/quota-manager.js';
import { renderRadar } from '../radar/radar-scrubber.js';
import { updateUIInfo } from '../solver/solver-client.js';
import { showToast } from '../../core/toast.js';

export async function switchCutMode(mode, targetRemnant, presetData = null) {
    const alreadyInert = document.body.inert;
    document.body.inert = true;
    try {
    const data = state.getCurrentCaseData();
    // Material is a source for the same demand batch, never a separate order pool.
    if (!presetData) data.demands = getDemandsFromUI();
    if (mode === 'remnant' && !targetRemnant) {
        return window.camApp.matchTaskMaterials();
    }
    state.setCutMode(mode, targetRemnant);
    data.pieces = []; data.cuts = []; data.remnants = []; data.cutIntervals = [];
    data.lastReceipt = null; data.deductLen = 0; data.pieceArea = 0; data.totalArea = 0;
    document.body.dataset.source = mode;
    document.getElementById('source-kind').textContent = mode === 'remnant' ? '在库料头' : '母卷';
    document.getElementById('source-remnant-summary').hidden = mode !== 'remnant';
    if (mode === 'remnant') {
        data.materialAvailable = true; document.body.dataset.material = 'ready';
        mountRemnantToBed(targetRemnant, presetData);
    }
    else { data.windowStartY = 0; await onMotherRollChange(true); }
    updateDemandCompletionFromPieces(data);
    renderDemandsUI(data.demands);
    renderScene(); renderRadar(); resetToBedView(); updateUIInfo();
    } finally { document.body.inert = alreadyInert; }
}

export async function onMotherRollChange(forceResetBed = false) {
    const sel = document.getElementById("sel-mother-roll-id");
    state.pendingPlan = null;
    const rollId = sel ? sel.value : "ROLL-2026-0920";
    const unavailable = () => {
        const current = state.getCurrentCaseData();
        Object.assign(current, {materialAvailable:false, rollId:'', stockUsedLength:0, stockRemainingLength:0,
            pieces:[], cuts:[], remnants:[], cutIntervals:[], globalDefects:[], lastReceipt:null});
        document.body.dataset.material = 'empty';
        for (const id of ['lbl-roll-model-desc','lbl-roll-remaining-len','sb-roll-id']) {
            const label = document.getElementById(id); if (label) label.textContent = '未装载';
        }
        for (const id of ['lbl-roll-w-desc','lbl-roll-used-len','lbl-roll-total-len','lbl-roll-base-origin','lbl-roll-rem-count','lbl-roll-rem-area']) {
            const label = document.getElementById(id); if (label) label.textContent = '—';
        }
        document.getElementById('inp-roll-id').value = '';
        document.getElementById('roll-len-progress').style.width = '0%';
        renderDefectsUI([]); updateUIInfo();
    };
    if (!rollId) { unavailable(); return; }
    let spec = state.motherRollSpecs[rollId] || { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 };
    try {
        const response = await fetch(`/api/rolls/${encodeURIComponent(rollId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error('读取母卷失败，请刷新库存后重试');
        if (response.ok) {
            const roll = await response.json();
            if (!roll?.rollId) { unavailable(); return; }
            if (roll && roll.rollId) {
                spec = { model: roll.rollModel, rollW: roll.width, totalRollL: roll.totalLength,
                    bedL: Math.min(5000, roll.currentRemainingLength) };
                const current = state.getCurrentCaseData();
                current.materialAvailable = true; document.body.dataset.material = 'ready';
                current.rollId = rollId;
                current.stockUsedLength = roll.usedLength || 0;
                current.stockRemainingLength = roll.currentRemainingLength;
                current.globalDefects = roll.defects || [];
                const remaining = document.getElementById("lbl-roll-remaining");
                if (remaining) remaining.innerText = `${roll.currentRemainingLength} mm`;
                renderDefectsUI(current.globalDefects);

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

                const baseOriginEl = document.getElementById("lbl-roll-base-origin");
                const used = roll.usedLength || 0;
                if (baseOriginEl) baseOriginEl.innerText = `Y = ${used.toLocaleString()} mm (${(used/1000).toFixed(2)}m)`;

                // 生产现场防呆：若重新载入或拿出该母卷且已有实切用料，自动将开卷工位定位到已切布头
                if (used > 0 && (!current.windowStartY || current.windowStartY < used)) {
                    current.windowStartY = used;
                }
            }
        }
    } catch (error) { unavailable(); throw error; }

    if (document.getElementById("inp-roll-id")) document.getElementById("inp-roll-id").value = rollId;
    if (document.getElementById("inp-roll-w")) document.getElementById("inp-roll-w").value = spec.rollW;
    if (document.getElementById("inp-total-roll-l")) document.getElementById("inp-total-roll-l").value = spec.totalRollL;

    const targetBedL = spec.bedL || 5000;
    const data = state.getCurrentCaseData();
    data.rollId = rollId;
    data.rollW = spec.rollW;
    data.totalRollL = spec.totalRollL;

    // 关键修复：母卷开卷必须保证台面长度为标准机台床台（5000mm），不能沿用料头短料长度
    if (forceResetBed || !data.bedL || data.bedL < 3000 || data.bedL > targetBedL) {
        data.bedL = targetBedL;
    }
    if (document.getElementById("inp-bed-l")) {
        document.getElementById("inp-bed-l").value = data.bedL || targetBedL;
    }
    data.windowStartY = data.windowStartY || 0;
    if (document.getElementById("inp-window-start-y")) {
        document.getElementById("inp-window-start-y").value = data.windowStartY;
    }

    const modelLbl = document.getElementById("lbl-roll-model-desc");
    if (modelLbl) modelLbl.innerText = spec.model;
    const wLbl = document.getElementById("lbl-roll-w-desc");
    if (wLbl) wLbl.innerText = spec.rollW;
    const sbRoll = document.getElementById("sb-roll-id");
    if (sbRoll) sbRoll.innerText = rollId;

    // 更新折叠卡片摘要
    const originTag = document.getElementById("tag-cut-origin-header");
    if (originTag) {
        const origVal = data.cutOrigin || "right-bottom";
        const origName = origVal.startsWith("right") ? "右" : "左";
        const origPos = origVal.endsWith("bottom") ? "下角" : "上角";
        originTag.innerText = `${origName}${origPos} · ${data.bedL}mm`;
    }

    await updateMotherRollRemnantStats(rollId);

    // 同步更新需求清单卡片上的归属母卷标签与窗帘工艺说明
    const demandsRollLbl = document.getElementById("demands-roll-label");
    if (demandsRollLbl) demandsRollLbl.innerText = `${rollId} (${spec.rollW}mm · ${spec.model})`;
    const craftHint = document.getElementById("demands-craft-hint");
    if (craftHint) {
        if (rollId === "ROLL-REAL-893292") {
            craftHint.innerHTML = "🏆 <b>893292 窗帘整单</b>: 11项主帘定高横裁(幅宽2170~2715mm) · 门幅剩余630mm边料竖切套排窗幔/绑带/抱枕(37件套)";
        } else if (rollId === "ROLL-REAL-893153") {
            craftHint.innerHTML = "🏆 <b>893153 工程整单</b>: 4大超长工程主帘(5.4m~9m横裁) · 门幅剩余边料竖切套排长绑带/抱枕(18件套)";
        } else {
            craftHint.innerText = "工艺规则：窗帘定高横裁为主要落料，门幅剩余窄边料顺流纵切套排辅件吃净";
        }
    }

    renderScene();
    renderRadar();
    resetToBedView();
    checkAllDemandsRemnantMatch();
    updateStatusBar();
}

export async function updateMotherRollRemnantStats(rollId) {
    try {
        const res = await fetch("/api/rolls", { cache: "no-store" });
        if (res.ok) {
            const rolls = await res.json();
            const rollInfo = rolls.find(r => r.rollId === rollId);
            if (rollInfo) {
                const countEl = document.getElementById("lbl-roll-rem-count");
                if (countEl) countEl.innerText = `${rollInfo.remnantCount} 块`;
                const areaEl = document.getElementById("lbl-roll-rem-area");
                if (areaEl) areaEl.innerText = `${rollInfo.remnantTotalArea.toFixed(2)}m²`;

                const remLenEl = document.getElementById("lbl-roll-remaining-len");
                if (remLenEl) remLenEl.innerText = `${(rollInfo.currentRemainingLength || 0).toLocaleString()} mm`;
                const usedLenEl = document.getElementById("lbl-roll-used-len");
                if (usedLenEl) usedLenEl.innerText = `${(rollInfo.usedLength || 0).toLocaleString()} mm`;
                const totalLenEl = document.getElementById("lbl-roll-total-len");
                if (totalLenEl) totalLenEl.innerText = `${(rollInfo.totalLength || 0).toLocaleString()}`;
                const progressEl = document.getElementById("roll-len-progress");
                if (progressEl && rollInfo.totalLength > 0) {
                    const pct = Math.min(100, Math.max(0, (rollInfo.usedLength / rollInfo.totalLength) * 100));
                    progressEl.style.width = `${pct.toFixed(1)}%`;
                }
            }
            const totalRemCount = rolls.reduce((acc, r) => acc + (r.remnantCount || 0), 0);
            const headCount = document.getElementById("header-remnant-count");
            if (headCount) headCount.innerText = totalRemCount;
        }
    } catch (e) {
        console.error("Fetch rolls error:", e);
    }
}

export async function checkAllDemandsRemnantMatch() { /* Replaced by task-wide material matching. */ }

export async function chooseRemnantForDemand(remId, demIdx) {
    try {
        const res = await fetch("/api/remnants/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: remId })
        });
        if (res.ok) {
            const rem = await res.json();
            if (rem && rem.id) {
                await switchCutMode('remnant', rem);
                showToast('已选用料头 ' + rem.id + '，本次需求保持不变', 'success');
            }
        }
    } catch (e) {
        showToast("装载料头异常: " + e.message, "error");
    }
}

export function dismissRemnantHint(demIdx) {
    const hintEl = document.getElementById(`rem-hint-${demIdx}`);
    if (hintEl) {
        hintEl.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 10px; color: var(--text-muted);">已确认：使用母卷开卷排切 (扣减母卷 ΔL)</span>
                <button class="del-btn" style="font-size: 10px; color: var(--text-muted);" onclick="window.camApp.checkAllDemandsRemnantMatch()">重新检测</button>
            </div>
        `;
    }
}

export function onRemnantFilterRollChange() {
    refreshShelfRemnantsList();
}

export async function refreshShelfRemnantsList() {
    const filterRoll = document.getElementById("sel-remnant-filter-roll") ? document.getElementById("sel-remnant-filter-roll").value : "ALL";
    const container = document.getElementById("shelf-remnant-cards-container");
    if (!container) return;
    container.innerHTML = `<div style="color: #71717a; font-size: 11px; padding: 10px; text-align: center;">加载料头货架...</div>`;

    let url = "/api/remnants";
    if (filterRoll && filterRoll !== "ALL") {
        url += `?rollId=${filterRoll}`;
    }

    try {
        const res = await fetch(url);
        if (res.ok) {
            const list = await res.json();
            const badge = document.getElementById("shelf-remnant-total-badge");
            if (badge) badge.innerText = `${list.length} 块在库`;

            if (list.length === 0) {
                container.innerHTML = `<div style="color: #71717a; font-size: 11px; padding: 10px; text-align: center;">本母卷暂无在库料头，排产裁切后将自动生成入库。</div>`;
                return;
            }

            container.innerHTML = list.map(r => `
                <div class="shelf-card-box" style="border-color: ${r.hasDefect ? 'var(--accent-amber)' : 'var(--panel-border)'};">
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-family: monospace; font-size: 11.5px; font-weight: 700; color: var(--accent-blue);">${r.id}</span>
                            <span class="${r.hasDefect ? 'badge-cut' : 'badge-piece'}" style="padding: 1px 4px; font-size: 9px;">
                                ${r.hasDefect ? '带疵需避让' : '完好'}
                            </span>
                        </div>
                        <div style="font-size: 11px; color: var(--text-main); margin-top: 2px;">
                            <b>${r.width} × ${r.length} mm</b> (${r.area.toFixed(2)}m²) | <span style="color:var(--accent-amber);">${r.location}</span>
                        </div>
                        <div style="font-size: 9.5px; color: var(--text-muted);">
                            所属母卷: ${r.sourceRollId || '母卷切出'}
                        </div>
                    </div>
                    <button class="tool-btn active" style="font-size: 10.5px; padding: 4px 8px;" onclick="window.camApp.selectAndMountFromShelf('${r.id}')">
                        装载机台
                    </button>
                </div>
            `).join("");
        }
    } catch (e) {
        container.innerHTML = `<div style="color: #ef4444; font-size: 11px; padding: 10px; text-align: center;">读取料头库失败: ${e.message}</div>`;
    }
}

export async function selectAndMountFromShelf(remId) {
    try {
        const res = await fetch("/api/remnants/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: remId })
        });
        if (res.ok) {
            const rem = await res.json();
            if (rem && rem.id) {
                mountRemnantToBed(rem);
            }
        }
    } catch (e) {
        showToast("装载料头异常: " + e.message, "error");
    }
}

export async function executeShelfBarcodeScan() {
    const code = document.getElementById("inp-shelf-scan-code").value.trim();
    if (!code) {
        showToast("请输入或扫描料头条码！", "warning");
        return;
    }
    selectAndMountFromShelf(code);
}

export function quickSelectRemnant(id) {
    document.getElementById("inp-shelf-scan-code").value = id;
    selectAndMountFromShelf(id);
}

export function mountRemnantToBed(rem, presetData = null) {
    state.setLoadedRemnant(rem);
    document.getElementById("tag-cut-origin-header").textContent = `料头 · ${rem.length}mm`;

    document.getElementById("lbl-shelf-active-id").innerText = rem.id;
    document.getElementById("lbl-shelf-active-size").innerText = `${rem.width} × ${rem.length} mm (${(rem.width * rem.length / 1000000).toFixed(2)} m²)`;
    document.getElementById("lbl-shelf-active-loc").innerText = rem.location || "现场库位";
    document.getElementById("lbl-shelf-active-status").innerText = rem.hasDefect ? "带瑕疵料头 (已启动避让)" : "完好可用料头";
    document.getElementById("lbl-shelf-active-status").style.color = "var(--text-muted)";

    document.getElementById("inp-roll-w").value = rem.width;
    document.getElementById("inp-bed-l").value = rem.length;
    document.getElementById("inp-total-roll-l").value = rem.length;
    document.getElementById("inp-window-start-y").value = 0;

    const data = state.getCurrentCaseData();
    state.pendingPlan = null;
    data.rollId = rem.sourceRollId;
    data.rollW = rem.width;
    data.bedL = rem.length;
    data.totalRollL = rem.length;
    data.windowStartY = 0;
    data.globalDefects = rem.defects || [];
    data.lastReceipt = null;
    data.allowLongitudinal = document.getElementById("sel-allow-longitudinal")?.value !== "0";

    if (presetData && presetData.pieces && presetData.pieces.length > 0) {
        data.pieces = JSON.parse(JSON.stringify(presetData.pieces));
        data.cuts = JSON.parse(JSON.stringify(presetData.cuts || []));
        data.remnants = JSON.parse(JSON.stringify(presetData.remnants || []));
        data.deductLen = presetData.deductLen || 0;
        data.pieceArea = presetData.pieceArea || 0;
        data.remArea = presetData.remArea || 0;
        data.wasteArea = presetData.wasteArea || 0;
        data.totalArea = presetData.totalArea || 0;
        data.engine = presetData.engine || "料头精益复用排料引擎";
    } else {
        data.deductLen = 0;
        data.pieces = [];
        data.cuts = [];
        data.remnants = [];
        data.pieceArea = 0;
        data.remArea = 0;
        data.wasteArea = 0;
        data.totalArea = 0;
    }

    /* Shared demand batch already loaded. */

    renderDefectsUI(data.globalDefects);
    renderScene();
    resetToBedView();
    if (document.getElementById("inp-roll-id")) document.getElementById("inp-roll-id").value = rem.sourceRollId;
    updateUIInfo();
    updateStatusBar();
}

export function renderRemnantDemandsUI(demands) {
    state.getCurrentCaseData().demands = demands;
    renderDemandsUI(demands);
}
export function addRemnantDemandRow() { addDemandRow(); }
export function getRemnantDemandsFromUI() { return getDemandsFromUI(); }

/**
 * 重置在台料头至初始未排状态
 */
export function reloadCurrentRemnant() {
    if (state.loadedRemnant) {
        mountRemnantToBed(state.loadedRemnant, null);
        const data = state.getCurrentCaseData();
        if (data) {
            data.demands = getRemnantDemandsFromUI();
            updateDemandCompletionFromPieces(data);
        }
        if (window.clearRemnantSelection) {
            window.clearRemnantSelection();
        }
        if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
            window.camApp.renderToolpathUI();
        }
        showToast(`已重置在台料头 [${state.loadedRemnant.id}] 为初始未排状态`, 'info');
    } else {
        if (typeof window.clearStationCuts === 'function') {
            window.clearStationCuts();
        }
    }
}

