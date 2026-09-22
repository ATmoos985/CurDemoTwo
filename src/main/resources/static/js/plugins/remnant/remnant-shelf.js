/**
 * 现场料头货架与双模式工位管理插件 (Remnant Shelf Plugin)
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene, resetToBedView, updateStatusBar } from '../cad/cad-renderer.js';
import { renderDefectsUI } from '../solver/quota-manager.js';

export async function switchCutMode(mode, targetRemnant) {
    state.setCutMode(mode);

    const btnRoll = document.getElementById("tab-btn-roll");
    const btnRem = document.getElementById("tab-btn-remnant");
    const panelRoll = document.getElementById("panel-roll-mode");
    const panelRem = document.getElementById("panel-remnant-mode");
    const radarBar = document.getElementById("roll-radar-bar");

    if (mode === "roll") {
        if (btnRoll) btnRoll.className = "mode-tab-btn active roll-mode";
        if (btnRem) btnRem.className = "mode-tab-btn";
        if (panelRoll) panelRoll.style.display = "flex";
        if (panelRem) panelRem.style.display = "none";
        if (radarBar) {
            radarBar.style.opacity = "1";
            radarBar.style.pointerEvents = "auto";
        }
        // 关键修复：从料头切回母卷时，彻底恢复母卷工况 (Bed L = 5000mm)，杜绝料头尺寸残留
        if (window.camApp && typeof window.camApp.loadCase === 'function') {
            window.camApp.loadCase(state.currentCaseId);
        } else {
            await onMotherRollChange(true);
        }
    } else {
        if (btnRoll) btnRoll.className = "mode-tab-btn";
        if (btnRem) btnRem.className = "mode-tab-btn active remnant-mode";
        if (panelRoll) panelRoll.style.display = "none";
        if (panelRem) panelRem.style.display = "flex";
        if (radarBar) {
            radarBar.style.opacity = "0.35";
            radarBar.style.pointerEvents = "none";
        }

        const curRollId = document.getElementById("sel-mother-roll-id") ? document.getElementById("sel-mother-roll-id").value : "ROLL-2026-0920";
        const selFilter = document.getElementById("sel-remnant-filter-roll");
        if (selFilter && curRollId) {
            selFilter.value = curRollId;
        }

        refreshShelfRemnantsList();

        if (targetRemnant) {
            mountRemnantToBed(targetRemnant);
        } else if (!state.loadedRemnant) {
            selectAndMountFromShelf("REM-202609-001");
        } else {
            mountRemnantToBed(state.loadedRemnant);
        }
    }
}

export async function onMotherRollChange(forceResetBed = false) {
    const sel = document.getElementById("sel-mother-roll-id");
    const rollId = sel ? sel.value : "ROLL-2026-0920";
    const spec = state.motherRollSpecs[rollId] || { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 };

    if (document.getElementById("inp-roll-id")) document.getElementById("inp-roll-id").value = rollId;
    if (document.getElementById("inp-roll-w")) document.getElementById("inp-roll-w").value = spec.rollW;
    if (document.getElementById("inp-total-roll-l")) document.getElementById("inp-total-roll-l").value = spec.totalRollL;

    const targetBedL = spec.bedL || 5000;
    const data = state.getCurrentCaseData();
    data.rollW = spec.rollW;
    data.totalRollL = spec.totalRollL;

    // 关键修复：母卷开卷必须保证台面长度为标准机台床台（5000mm），不能沿用料头短料长度
    if (forceResetBed || !data.bedL || data.bedL < 3000) {
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

    renderScene();
    resetToBedView();
    checkAllDemandsRemnantMatch();
    updateStatusBar();
}

export async function updateMotherRollRemnantStats(rollId) {
    try {
        const res = await fetch("/api/rolls");
        if (res.ok) {
            const rolls = await res.json();
            const rollInfo = rolls.find(r => r.rollId === rollId);
            if (rollInfo) {
                const countEl = document.getElementById("lbl-roll-rem-count");
                if (countEl) countEl.innerText = `${rollInfo.remnantCount} 块`;
                const areaEl = document.getElementById("lbl-roll-rem-area");
                if (areaEl) areaEl.innerText = `${rollInfo.remnantTotalArea.toFixed(2)}m²`;
            }
            const totalRemCount = rolls.reduce((acc, r) => acc + (r.remnantCount || 0), 0);
            const headCount = document.getElementById("header-remnant-count");
            if (headCount) headCount.innerText = totalRemCount;
        }
    } catch (e) {
        console.error("Fetch rolls error:", e);
    }
}

export async function checkAllDemandsRemnantMatch() {
    if (state.currentCutMode === "remnant") return;
    const rollId = document.getElementById("sel-mother-roll-id") ? document.getElementById("sel-mother-roll-id").value : "ROLL-2026-0920";
    const allowRotation = (document.getElementById("sel-allow-rotation").value === "1");
    const rows = document.querySelectorAll("#demands-container .item-row");

    for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx];
        const w = parseFloat(r.querySelector(".dem-w").value) || 500;
        const l = parseFloat(r.querySelector(".dem-l").value) || 500;
        const hintEl = document.getElementById(`rem-hint-${idx}`);
        if (!hintEl) continue;

        try {
            const res = await fetch("/api/remnants/match", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rollId: rollId, w: w, l: l, allowRotation: allowRotation })
            });
            if (res.ok) {
                const matches = await res.json();
                if (matches && matches.length > 0) {
                    const best = matches[0];
                    hintEl.style.display = "block";
                    hintEl.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <span style="font-weight: 700; color: var(--accent-amber); font-size: 10.5px;">发现本卷可用在库料头</span>
                            <span style="background: var(--badge-green-bg); color: var(--badge-green-color); font-size: 9px; padding: 1px 4px; border-radius: 2px; font-weight: 600;">0 扣母卷</span>
                        </div>
                        <div style="font-size: 10px; color: var(--text-main); line-height: 1.3;">
                            料号: <b style="color: var(--accent-blue);">${best.id}</b> (${best.width}×${best.length}mm, ${best.location})
                        </div>
                        <div style="display: flex; gap: 6px; margin-top: 5px;">
                            <button class="btn-action-use-rem" onclick="window.camApp.chooseRemnantForDemand('${best.id}', ${idx})">
                                改用料头切 (0扣料)
                            </button>
                            <button class="btn-action-keep-roll" onclick="window.camApp.dismissRemnantHint(${idx})">
                                坚持母卷切
                            </button>
                        </div>
                    `;
                } else {
                    hintEl.style.display = "none";
                }
            }
        } catch (e) {
            console.error("Match remnant error for idx " + idx, e);
        }
    }
}

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
                const rows = document.querySelectorAll("#demands-container .item-row");
                let demItem = null;
                if (rows[demIdx]) {
                    demItem = {
                        name: rows[demIdx].querySelector(".dem-name").value,
                        width: parseFloat(rows[demIdx].querySelector(".dem-w").value) || 500,
                        length: parseFloat(rows[demIdx].querySelector(".dem-l").value) || 500,
                        count: parseInt(rows[demIdx].querySelector(".dem-count").value) || 1
                    };
                }

                switchCutMode("remnant", rem);

                if (demItem) {
                    renderRemnantDemandsUI([demItem]);
                }

                alert(`决策生效：已自动切换至【模式二：料头复用精益切割】！\n` +
                    `装载料头: [${rem.id}] (${rem.width}×${rem.length}mm, ${rem.location})\n` +
                    `母卷扣料已锁定为 0mm！\n` +
                    `请点击底部【执行料头精益切割】直接计算刀路。`);
            }
        }
    } catch (e) {
        alert("装载料头异常: " + e.message);
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
        alert("装载料头异常: " + e.message);
    }
}

export async function executeShelfBarcodeScan() {
    const code = document.getElementById("inp-shelf-scan-code").value.trim();
    if (!code) {
        alert("请输入或扫描料头条码！");
        return;
    }
    selectAndMountFromShelf(code);
}

export function quickSelectRemnant(id) {
    document.getElementById("inp-shelf-scan-code").value = id;
    selectAndMountFromShelf(id);
}

export function mountRemnantToBed(rem) {
    state.setLoadedRemnant(rem);

    document.getElementById("lbl-shelf-active-id").innerText = rem.id;
    document.getElementById("lbl-shelf-active-size").innerText = `${rem.width} × ${rem.length} mm (${(rem.width * rem.length / 1000000).toFixed(2)} m²)`;
    document.getElementById("lbl-shelf-active-loc").innerText = rem.location || "现场库位";
    document.getElementById("lbl-shelf-active-status").innerText = rem.hasDefect ? "带瑕疵料头 (已启动避让)" : "完好可用料头";
    document.getElementById("lbl-shelf-active-status").style.color = rem.hasDefect ? "#fbbf24" : "#4ade80";

    document.getElementById("inp-roll-w").value = rem.width;
    document.getElementById("inp-bed-l").value = rem.length;
    document.getElementById("inp-total-roll-l").value = rem.length;
    document.getElementById("inp-window-start-y").value = 0;

    const data = state.getCurrentCaseData();
    data.rollW = rem.width;
    data.bedL = rem.length;
    data.totalRollL = rem.length;
    data.windowStartY = 0;
    data.globalDefects = rem.defects || [];
    data.deductLen = 0;
    data.pieces = [];
    data.cuts = [];
    data.remnants = [];

    const currentRemDemands = getRemnantDemandsFromUI();
    if (currentRemDemands.length === 0) {
        const fitW = rem.width >= 1000 ? Math.round(rem.width * 0.7) : rem.width;
        const fitL = rem.length >= 800 ? Math.round(rem.length * 0.6) : rem.length;
        renderRemnantDemandsUI([{ name: "料头裁片-1", width: fitW, length: fitL, count: 1 }]);
    }

    renderDefectsUI(data.globalDefects);
    renderScene();
    resetToBedView();
    updateStatusBar();
}

export function renderRemnantDemandsUI(demands) {
    const container = document.getElementById("remnant-demands-container");
    if (!container) return;
    container.innerHTML = "";
    if (!demands || demands.length === 0) {
        container.innerHTML = "<div style='color:var(--text-muted);font-size:11px;padding:4px;'>暂无需求 (可点击上方+增裁片)</div>";
        return;
    }
    demands.forEach((dem, idx) => {
        const row = document.createElement("div");
        row.className = "item-row";
        const wVal = dem.w !== undefined ? dem.w : (dem.width !== undefined ? dem.width : 500);
        const lVal = dem.l !== undefined ? dem.l : (dem.length !== undefined ? dem.length : 500);
        const cVal = dem.count !== undefined ? dem.count : (dem.demand !== undefined ? dem.demand : 1);
        row.innerHTML = `
            <div class="item-row-header">
                <input type="text" class="dem-name remnant-dem" value="${dem.name || ('料头成品-' + (idx + 1))}">
                <button class="del-btn" onclick="this.closest('.item-row').remove();">×</button>
            </div>
            <div class="mini-input-group">
                <span>宽:</span><input type="number" class="mini-input dem-w" value="${wVal}">
                <span>长:</span><input type="number" class="mini-input dem-l" value="${lVal}">
                <span>件数:</span><input type="number" class="mini-input dem-count" value="${cVal}" style="width:40px;">
            </div>
        `;
        container.appendChild(row);
    });
}

export function addRemnantDemandRow() {
    const container = document.getElementById("remnant-demands-container");
    if (container.querySelector("div[style*='暂无']")) container.innerHTML = "";
    const id = container.querySelectorAll(".item-row").length + 1;
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
        <div class="item-row-header">
            <input type="text" class="dem-name remnant-dem" value="套裁裁片-${id}">
            <button class="del-btn" onclick="this.closest('.item-row').remove();">×</button>
        </div>
        <div class="mini-input-group">
            <span>宽:</span><input type="number" class="mini-input dem-w" value="500">
            <span>长:</span><input type="number" class="mini-input dem-l" value="600">
            <span>件数:</span><input type="number" class="mini-input dem-count" value="1" style="width:40px;">
        </div>
    `;
    container.appendChild(row);
}

export function getRemnantDemandsFromUI() {
    const list = [];
    const rows = document.querySelectorAll("#remnant-demands-container .item-row");
    rows.forEach((r, idx) => {
        const id = idx + 1;
        const name = r.querySelector(".dem-name").value.trim() || ("料头成品-" + id);
        const width = parseFloat(r.querySelector(".dem-w").value) || 500;
        const length = parseFloat(r.querySelector(".dem-l").value) || 500;
        const demand = parseInt(r.querySelector(".dem-count").value) || 1;
        list.push({ id, name, width, length, demand, allowRotation: false });
    });
    return list;
}
