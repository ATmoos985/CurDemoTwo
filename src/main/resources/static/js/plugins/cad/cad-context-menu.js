/**
 * CAD 实体右键操作上下文菜单插件 (CAD Entity Context Menu Plugin)
 * 满足现场操作员在画布上对【料头块】、【成品裁片】、【机台工位】的直接审查与干预：
 * 1. 【料头块】：右键抛弃此料头，保持母卷不切断（切断线自动收缩回退、扣料量同步核减、未切布料归还母卷）；
 *    或从此料头起点直接接切下一工位（智能零间隙吸附进给）；
 * 2. 【成品裁片】：右键抛弃此裁片退回需求池（配额自动返还、母卷该处恢复未切、动态收缩工位切断线）；
 * 3. 【机台工位/空白母卷】：一键去除尾部余料收缩切线、智能接刀吸附进料、清空工位。
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { showToast } from '../../core/toast.js';
import { stage, mainLayer } from './cad-stage.js';
import { renderScene } from './cad-renderer.js';
import { updateDemandCompletionFromPieces, recalculateRollStats, renderDemandsUI } from '../solver/quota-manager.js';
import { updateUIInfo } from '../solver/solver-client.js';
import {
    updateFabricScrollPosition, updateDefectVisualStates,
    updateDefectRadarActiveState, smartAdvanceBed
} from '../radar/radar-scrubber.js';
import { selectRemnant, clearRemnantSelection } from './cad-remnant-highlight.js';

let activeMenu = null;
let currentTarget = null;

export function initCADContextMenu() {
    activeMenu = document.getElementById("cad-context-menu");
    if (!activeMenu) {
        activeMenu = document.createElement("div");
        activeMenu.id = "cad-context-menu";
        activeMenu.className = "cad-context-menu";
        document.body.appendChild(activeMenu);
    }

    // 全局点击、滚轮或 ESC 自动关闭上下文菜单
    document.addEventListener("click", (e) => {
        if (activeMenu && !activeMenu.contains(e.target)) {
            closeCADContextMenu();
        }
    });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeCADContextMenu();
        }
    });

    const container = document.getElementById("konva-container");
    if (container) {
        container.addEventListener("contextmenu", (e) => {
            e.preventDefault();
        });
    }

    // 舞台背景区域右键打开工位控制菜单
    if (stage) {
        stage.on("contextmenu", (e) => {
            e.evt.preventDefault();
            // 如果点在空白处（没有被 pieceGroup 或 remnantGroup 的子图形冒泡拦截）
            if (e.target === stage || !e.target || e.target.name() === "" || e.target.parent === stage) {
                openStationContextMenu(e.evt.clientX, e.evt.clientY);
            }
        });
    }
}

export function closeCADContextMenu() {
    if (activeMenu) {
        activeMenu.style.display = "none";
        currentTarget = null;
    }
}
window.openStationContextMenu = openStationContextMenu;
window.closeCADContextMenu = closeCADContextMenu;

function showMenuAt(clientX, clientY, htmlContent) {
    if (!activeMenu) return;
    activeMenu.innerHTML = htmlContent;
    activeMenu.style.display = "block";

    const menuW = 280;
    const menuH = activeMenu.offsetHeight || 220;
    let left = clientX;
    let top = clientY;

    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 12;
    if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 12;
    if (left < 6) left = 6;
    if (top < 6) top = 6;

    activeMenu.style.left = `${left}px`;
    activeMenu.style.top = `${top}px`;
}

/**
 * 注入料头 Konva 节点交互行为与右键菜单
 */
export function makeRemnantInteractive(rGroup, remnant, caseData) {
    rGroup.name(`remnant-entity-${remnant.id}`);

    // 鼠标悬停高亮与右侧表格行高亮联动
    rGroup.on("mouseenter", () => {
        const container = document.getElementById("konva-container");
        if (container) container.style.cursor = "pointer";
        const mainRect = rGroup.findOne("Rect");
        if (mainRect) {
            mainRect.strokeWidth(3.5);
            mainRect.dash([6, 3]);
            mainLayer.batchDraw();
        }
        const row = document.getElementById(`remnant-row-${remnant.id}`);
        if (row && !row.classList.contains("remnant-selected-row")) {
            row.classList.add("remnant-hover-row");
        }
    });

    rGroup.on("mouseleave", () => {
        const container = document.getElementById("konva-container");
        if (container) container.style.cursor = "default";
        const mainRect = rGroup.findOne("Rect");
        if (mainRect) {
            mainRect.strokeWidth(2);
            mainRect.dash([8, 4]);
            mainLayer.batchDraw();
        }
        const row = document.getElementById(`remnant-row-${remnant.id}`);
        if (row) {
            row.classList.remove("remnant-hover-row");
        }
    });

    // 右键打开料头上下文菜单
    rGroup.on("contextmenu", (e) => {
        e.evt.preventDefault();
        e.cancelBubble = true;
        selectRemnant(remnant.id, { fromCanvas: true, showToastMsg: false, switchTab: false });
        openRemnantContextMenu(remnant, e.evt.clientX, e.evt.clientY);
    });

    // 左键点击：在 CAD 画布上高亮选中此料头，自动切换至右侧【料头与对账】Tab 并定位滚动到对应表格行
    rGroup.on("click", (e) => {
        e.cancelBubble = true;
        selectRemnant(remnant.id, { fromCanvas: true, showToastMsg: true, switchTab: true });
    });
}

/**
 * 打开【料头块】右键菜单
 */
export function openRemnantContextMenu(remnant, clientX, clientY) {
    currentTarget = { type: 'remnant', data: remnant };
    const data = state.getCurrentCaseData();
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;
    const maxPieceY = Math.max(winStartY, ...((data.pieces || []).map(p => p.y + p.l)));
    const isTail = (remnant.y + remnant.l >= winEndY - 50) || (remnant.y >= maxPieceY - 5);

    const html = `
        <div class="cad-menu-header">
            <span style="display:flex; align-items:center; gap:6px;">
                <span style="color:#38bdf8;">🧩</span>
                <span>${remnant.status || '料头块'} · ${remnant.id}</span>
            </span>
            <span style="font-size:10px; color:#94a3b8; font-family:monospace;">${remnant.w}×${remnant.l}mm</span>
        </div>
        <div class="cad-menu-item danger" onclick="window.cadMenuActions.discardRemnant('${remnant.id}')">
            <div class="cad-menu-item-title">
                <span>🗑 抛弃此料头 · 保持母卷不切断</span>
            </div>
            <div class="cad-menu-item-desc">
                取消此料头切刀，${isTail ? '母卷该区域恢复未切断状态，自动收缩工位切断线' : '从入库清单中移除'}
            </div>
        </div>
        ${isTail ? `
        <div class="cad-menu-item highlight" onclick="window.cadMenuActions.advanceFromRemnant('${remnant.id}')">
            <div class="cad-menu-item-title">
                <span>✂ 从此料头起点接刀开启下一工位 ▶</span>
            </div>
            <div class="cad-menu-item-desc">
                机台工位红框吸附至 Y=${Math.round(remnant.y)}mm，从该处接续排料
            </div>
        </div>
        ` : ''}
        <div class="cad-menu-divider"></div>
        <div class="cad-menu-item" onclick="window.cadMenuActions.locateRemnant('${remnant.id}')">
            <div class="cad-menu-item-title">
                <span>🔍 查看详细参数与坐标</span>
            </div>
            <div class="cad-menu-item-desc">
                起点: (${remnant.x}, ${remnant.y}) | 面积: ${remnant.area.toFixed(2)}m² | ${remnant.hasDefect ? '带疵' : '无疵'}
            </div>
        </div>
    `;
    showMenuAt(clientX, clientY, html);
}

/**
 * 打开【合格成品裁片】右键菜单
 */
export function openPieceContextMenu(piece, clientX, clientY) {
    currentTarget = { type: 'piece', data: piece };
    if (piece.confirmed) {
        const html = `
            <div class="cad-menu-header">
                <span style="color:#34d399;">✓ 实切已核销裁片 · #${piece.id} ${piece.name || ''}</span>
            </div>
            <div class="cad-menu-item" style="cursor:default; opacity:0.8;">
                <div class="cad-menu-item-title"><span>🔒 该裁片已完成实切核销与物料扣减</span></div>
                <div class="cad-menu-item-desc">物理库存已锁定入账，不可在工位中随意抛弃或篡改。</div>
            </div>
        `;
        showMenuAt(clientX, clientY, html);
        return;
    }

    const html = `
        <div class="cad-menu-header">
            <span style="display:flex; align-items:center; gap:6px;">
                <span style="color:#10b981;">🟩</span>
                <span>裁片 #${piece.id} · ${piece.name || '窗帘裁片'}</span>
            </span>
            <span style="font-size:10px; color:#94a3b8; font-family:monospace;">${piece.w}×${piece.l}mm</span>
        </div>
        <div class="cad-menu-item danger" onclick="window.cadMenuActions.discardPiece(${piece.id})">
            <div class="cad-menu-item-title">
                <span>🗑 抛弃此裁片 · 退回需求池</span>
            </div>
            <div class="cad-menu-item-desc">
                从工位中移除，订单需求数自动返还，母卷该区域恢复未切
            </div>
        </div>
        <div class="cad-menu-item highlight" onclick="window.cadMenuActions.rotatePiece(${piece.id})">
            <div class="cad-menu-item-title">
                <span>🔄 顺时针旋转 90° (就地调向)</span>
            </div>
            <div class="cad-menu-item-desc">
                切换经纬走向 (${piece.l}×${piece.w}mm)，并实时校验干涉
            </div>
        </div>
        <div class="cad-menu-divider"></div>
        <div class="cad-menu-item success" onclick="window.cadMenuActions.setAsStationCutEnd(${piece.id})">
            <div class="cad-menu-item-title">
                <span>✂ 设为本工位收尾截断线</span>
            </div>
            <div class="cad-menu-item-desc">
                以此裁片底边 (Y=${piece.y + piece.l}mm) 截断，下方余料全部归还母卷
            </div>
        </div>
    `;
    showMenuAt(clientX, clientY, html);
}

/**
 * 打开【数控机台工位 / 空白母卷】右键菜单
 */
export function openStationContextMenu(clientX, clientY) {
    if (state.currentCutMode === 'remnant') {
        const rem = state.loadedRemnant;
        const data = state.getCurrentCaseData();
        const code = rem ? (rem.id || rem.code || '当前在台料头') : '当前在台料头';
        const w = rem ? rem.width : (data.rollW || 2000);
        const l = rem ? rem.length : (data.bedL || 1500);
        const pieceCount = (data.pieces || []).length;
        const cutCount = (data.cuts || []).length;

        currentTarget = { type: 'remnant-station' };
        const html = `
            <div class="cad-menu-header">
                <span style="display:flex; align-items:center; gap:6px;">
                    <span style="color:#d97706;">🧩</span>
                    <span>在台料头 [${code}]</span>
                </span>
                <span style="font-size:10px; color:#94a3b8;">${w}×${l}mm</span>
            </div>
            <div class="cad-menu-item highlight" onclick="window.cadMenuActions.solveRemnant()">
                <div class="cad-menu-item-title">
                    <span>⚡ 执行料头智能排料 (母卷 0 扣料)</span>
                </div>
                <div class="cad-menu-item-desc">
                    在当前在台料头上执行直刀优化排料，自动避开瑕疵
                </div>
            </div>
            <div class="cad-menu-divider"></div>
            <div class="cad-menu-item danger" onclick="window.cadMenuActions.clearRemnantCuts()">
                <div class="cad-menu-item-title">
                    <span>🧹 清除本料头排料 (${pieceCount}片 / ${cutCount}刀)</span>
                </div>
                <div class="cad-menu-item-desc">
                    清空料头上的所有排料裁片与切刀路径，恢复空白
                </div>
            </div>
            <div class="cad-menu-item warning" onclick="window.cadMenuActions.reloadRemnant()">
                <div class="cad-menu-item-title">
                    <span>🔄 重置在台料头至初始状态</span>
                </div>
                <div class="cad-menu-item-desc">
                    重新从料头库装载干净料头，重设规格基准
                </div>
            </div>
        `;
        showMenuAt(clientX, clientY, html);
        return;
    }

    currentTarget = { type: 'station' };
    const data = state.getCurrentCaseData();
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;

    const html = `
        <div class="cad-menu-header">
            <span style="display:flex; align-items:center; gap:6px;">
                <span style="color:#ef4444;">📐</span>
                <span>数控裁床加工工位 [${winStartY} ~ ${winEndY} mm]</span>
            </span>
            <span style="font-size:10px; color:#94a3b8;">长 ${(bedL/1000).toFixed(1)}m</span>
        </div>
        <div class="cad-menu-item success" onclick="window.cadMenuActions.autoTrimTail()">
            <div class="cad-menu-item-title">
                <span>✂ 一键去除尾部料头 (收缩切线归还母卷)</span>
            </div>
            <div class="cad-menu-item-desc">
                自动清除工位末端零散料头，切断线下移对齐至最后一块裁片底边
            </div>
        </div>
        <div class="cad-menu-item highlight" onclick="window.cadMenuActions.smartAdvance()">
            <div class="cad-menu-item-title">
                <span>⏩ 接续下一工位 (智能零间隙吸附进给)</span>
            </div>
            <div class="cad-menu-item-desc">
                将工位红框吸附至当前有效裁刀终点，推进机台开切
            </div>
        </div>
        <div class="cad-menu-divider"></div>
        <div class="cad-menu-item danger" onclick="window.cadMenuActions.clearStation()">
            <div class="cad-menu-item-title">
                <span>🧹 清空当前工位排料结果</span>
            </div>
            <div class="cad-menu-item-desc">
                撤销本工位所有裁片与刀路，母卷整段恢复初始未切
            </div>
        </div>
    `;
    showMenuAt(clientX, clientY, html);
}

/**
 * 抛弃料头：核心处理逻辑
 */
export function discardRemnant(remnantId) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const remnant = (data.remnants || []).find(r => r.id === remnantId);
    if (!remnant) return;

    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;

    // 1. 从已排料头列表中移除
    data.remnants = (data.remnants || []).filter(r => r.id !== remnantId);
    if (state.pendingPlan && state.pendingPlan.result && state.pendingPlan.result.remnants) {
        state.pendingPlan.result.remnants = state.pendingPlan.result.remnants.filter(r => r.id !== remnantId);
    }

    // 2. 判断是否属于工位尾部/落料端料头
    const maxPieceY = Math.max(winStartY, ...((data.pieces || []).map(p => p.y + p.l)));
    const isTailRemnant = (remnant.y + remnant.l >= winEndY - 50) || (remnant.y >= maxPieceY - 5);

    if (isTailRemnant) {
        // A. 尾部料头：母卷该段恢复完整未切状态！
        // 移除位于该料头内部及之后的横切断刀与纵切
        data.cuts = (data.cuts || []).filter(c => {
            if (c.type === "横切") {
                return c.pos <= remnant.y;
            } else {
                return c.start < remnant.y;
            }
        });
        data.cuts.forEach((c, idx) => { c.step = idx + 1; });

        // 计算当前工位剩余实切的最大 Y
        const stationPieces = (data.pieces || []).filter(p => p.y + p.l > winStartY && p.y < winEndY);
        const stationRemnants = (data.remnants || []).filter(r => r.y + r.l > winStartY && r.y < winEndY);
        let newStationCutEnd = winStartY;
        if (stationPieces.length > 0) {
            newStationCutEnd = Math.max(newStationCutEnd, ...stationPieces.map(p => p.y + p.l));
        }
        if (stationRemnants.length > 0) {
            newStationCutEnd = Math.max(newStationCutEnd, ...stationRemnants.map(r => r.y + r.l));
        }

        // 如果仍有裁片，确保在裁片底边有横切刀将其裁出
        if (newStationCutEnd > winStartY) {
            const hasEndCut = data.cuts.some(c => c.type === "横切" && Math.abs(c.pos - newStationCutEnd) < 5);
            if (!hasEndCut) {
                data.cuts.push({
                    step: data.cuts.length + 1,
                    type: "横切",
                    pos: newStationCutEnd,
                    start: 0,
                    end: data.rollW || 2000,
                    desc: `工位收尾横切 (截断至裁片底边 Y=${newStationCutEnd}mm，余料保留在母卷未切)`
                });
            }
        }

        // 刷新工位加工区间 cutIntervals
        data.cutIntervals = (data.cutIntervals && data.cutIntervals.length > 0) ?
            data.cutIntervals : [{ start: winStartY, end: winEndY }];
        data.cutIntervals = data.cutIntervals.filter(inv => inv.end <= winStartY || inv.start >= winEndY);
        if (newStationCutEnd > winStartY) {
            data.cutIntervals.push({ start: winStartY, end: newStationCutEnd });
        }

        recalculateRollStats(data);
        if (state.pendingPlan && state.pendingPlan.result) {
            state.pendingPlan.result.deductLen = data.deductLen;
        }

        showToast(`已抛弃料头 ${remnant.id}，恢复 ${(remnant.l/1000).toFixed(2)}m 布料至母卷未切状态！工位落料点收缩至 Y=${newStationCutEnd}mm。`, 'success');
    } else {
        // B. 侧边料头或疵点料头
        recalculateRollStats(data);
        showToast(`已抛弃料头 ${remnant.id} (面积 ${remnant.area.toFixed(2)}m²)，不入库登记。`, 'info');
    }

    if (state.selectedRemnantId === remnantId) {
        clearRemnantSelection();
    }

    updateUIInfo();
    renderScene();
}

/**
 * 从料头起点开启下一工位
 */
export function advanceFromRemnantStart(remnantId) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const remnant = (data.remnants || []).find(r => r.id === remnantId);
    if (!remnant) return;

    const targetY = Math.round(remnant.y);
    discardRemnant(remnantId);

    const curY = data.windowStartY || 0;
    if (targetY !== curY) {
        data.cuts = [];
        state.setCutStepLimit(999);
        state.pendingPlan = null;
        if (state.selectedRemnantId) clearRemnantSelection();
    }

    // 顺流吸附红框工位至该料头起点
    updateFabricScrollPosition(targetY);
    updateDefectVisualStates();
    updateDefectRadarActiveState();
    recalculateRollStats(data);
    renderScene();
    drawRulers();
    updateUIInfo();
    if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
        window.camApp.renderToolpathUI();
    }
    bus.emit('bed:smart-advanced', { nextY: targetY });

    showToast(`机台工位红框已顺流吸附至 Y=${targetY}mm，已就绪开切下一工位！`, 'success');
}

/**
 * 抛弃裁片：退回需求池，恢复母卷未切状态
 */
export function discardPiece(pieceId) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const piece = (data.pieces || []).find(p => p.id === pieceId);
    if (!piece) return;

    if (piece.confirmed) {
        showToast(`裁片 "${piece.name || piece.id}" 已完成实切核销，禁止修改或抛弃。`, 'warning');
        return;
    }

    // 1. 从裁片列表中移除
    data.pieces = (data.pieces || []).filter(p => p.id !== pieceId);
    if (state.pendingPlan && state.pendingPlan.result && state.pendingPlan.result.pieces) {
        state.pendingPlan.result.pieces = state.pendingPlan.result.pieces.filter(p => p.id !== pieceId);
    }

    // 2. 自动重新核销与返还需求池配额
    updateDemandCompletionFromPieces(data);
    renderDemandsUI(data.demands);

    // 3. 检查并收缩切断线
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;

    const stationPieces = (data.pieces || []).filter(p => p.y + p.l > winStartY && p.y < winEndY);
    const stationRemnants = (data.remnants || []).filter(r => r.y + r.l > winStartY && r.y < winEndY);

    let newStationCutEnd = winStartY;
    if (stationPieces.length > 0) {
        newStationCutEnd = Math.max(newStationCutEnd, ...stationPieces.map(p => p.y + p.l));
    }
    if (stationRemnants.length > 0) {
        newStationCutEnd = Math.max(newStationCutEnd, ...stationRemnants.map(r => r.y + r.l));
    }

    if (newStationCutEnd > winStartY) {
        data.cuts = (data.cuts || []).filter(c => {
            if (c.type === "横切" && c.pos > newStationCutEnd + 5) return false;
            return true;
        });
        data.cuts.forEach((c, idx) => { c.step = idx + 1; });
    }

    data.cutIntervals = (data.cutIntervals && data.cutIntervals.length > 0) ?
        data.cutIntervals : [{ start: winStartY, end: winEndY }];
    data.cutIntervals = data.cutIntervals.filter(inv => inv.end <= winStartY || inv.start >= winEndY);
    if (newStationCutEnd > winStartY) {
        data.cutIntervals.push({ start: winStartY, end: newStationCutEnd });
    }

    recalculateRollStats(data);
    if (state.pendingPlan && state.pendingPlan.result) {
        state.pendingPlan.result.deductLen = data.deductLen;
    }

    updateUIInfo();
    renderScene();
    showToast(`已抛弃裁片 "${piece.name || piece.id}"，已退回 1 件需求至订单池，母卷恢复未切断。`, 'success');
}

/**
 * 设为工位收尾截断线
 */
export function setPieceAsCutEnd(pieceId) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const piece = (data.pieces || []).find(p => p.id === pieceId);
    if (!piece) return;

    const cutEndY = piece.y + piece.l;
    const winStartY = data.windowStartY || 0;
    const winEndY = winStartY + (data.bedL || 5000);

    // 移除位于 cutEndY 下方的所有料头
    data.remnants = (data.remnants || []).filter(r => r.y < cutEndY - 5);

    // 移除 cutEndY 下方的切刀
    data.cuts = (data.cuts || []).filter(c => {
        if (c.type === "横切") return c.pos <= cutEndY;
        return c.start < cutEndY;
    });

    const hasEndCut = data.cuts.some(c => c.type === "横切" && Math.abs(c.pos - cutEndY) < 5);
    if (!hasEndCut) {
        data.cuts.push({
            step: data.cuts.length + 1,
            type: "横切",
            pos: cutEndY,
            start: 0,
            end: data.rollW || 2000,
            desc: `以裁片 #${piece.id} 底边作为工位落料截断线 (Y=${cutEndY}mm)`
        });
    }
    data.cuts.forEach((c, idx) => { c.step = idx + 1; });

    data.cutIntervals = (data.cutIntervals && data.cutIntervals.length > 0) ?
        data.cutIntervals : [{ start: winStartY, end: winEndY }];
    data.cutIntervals = data.cutIntervals.filter(inv => inv.end <= winStartY || inv.start >= winEndY);
    data.cutIntervals.push({ start: winStartY, end: cutEndY });

    recalculateRollStats(data);
    if (state.pendingPlan && state.pendingPlan.result) {
        state.pendingPlan.result.deductLen = data.deductLen;
        state.pendingPlan.result.remnants = (data.remnants || []).map(r => ({ ...r }));
    }

    updateUIInfo();
    renderScene();
    showToast(`已以此裁片底边 (Y=${cutEndY}mm) 截断工位，下方布料全部归还母卷！`, 'success');
}

/**
 * 一键去除尾部料头，收缩切线
 */
export function autoTrimStationTailWaste() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;

    const stationPieces = (data.pieces || []).filter(p => p.y + p.l > winStartY && p.y < winEndY);
    if (stationPieces.length === 0) {
        showToast("当前工位暂无有效成品裁片，无需去除尾料。", "info");
        return;
    }

    const maxPieceY = Math.max(...stationPieces.map(p => p.y + p.l));
    if (maxPieceY >= winEndY - 10) {
        showToast("当前工位排料已铺满机台落料端，无尾部空隙余料。", "info");
        return;
    }

    // 抛弃所有在 maxPieceY 之后的尾部料头
    data.remnants = (data.remnants || []).filter(r => r.y < maxPieceY - 5);
    if (state.pendingPlan && state.pendingPlan.result) {
        state.pendingPlan.result.remnants = (data.remnants || []).map(r => ({ ...r }));
    }

    // 移除位于 maxPieceY 之后的所有切刀
    data.cuts = (data.cuts || []).filter(c => {
        if (c.type === "横切") return c.pos <= maxPieceY;
        return c.start < maxPieceY;
    });

    const hasEndCut = data.cuts.some(c => c.type === "横切" && Math.abs(c.pos - maxPieceY) < 5);
    if (!hasEndCut) {
        data.cuts.push({
            step: data.cuts.length + 1,
            type: "横切",
            pos: maxPieceY,
            start: 0,
            end: data.rollW || 2000,
            desc: `工位收尾横切 (截断至裁片底边 Y=${maxPieceY}mm，余料保留在母卷未切)`
        });
    }
    data.cuts.forEach((c, idx) => { c.step = idx + 1; });

    data.cutIntervals = (data.cutIntervals && data.cutIntervals.length > 0) ?
        data.cutIntervals : [{ start: winStartY, end: winEndY }];
    data.cutIntervals = data.cutIntervals.filter(inv => inv.end <= winStartY || inv.start >= winEndY);
    data.cutIntervals.push({ start: winStartY, end: maxPieceY });

    recalculateRollStats(data);
    if (state.pendingPlan && state.pendingPlan.result) {
        state.pendingPlan.result.deductLen = data.deductLen;
    }

    const savedMm = Math.round(winEndY - maxPieceY);
    updateUIInfo();
    renderScene();
    showToast(`已一键去除尾部料头，切断线收缩至 Y=${maxPieceY}mm，恢复 ${savedMm}mm (${(savedMm/1000).toFixed(2)}m) 布料至母卷未切状态！`, 'success');
}

/**
 * 顺时针旋转裁片 90°
 */
export function rotatePieceById(pieceId) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const piece = (data.pieces || []).find(p => p.id === pieceId);
    if (!piece) return;

    const oldW = piece.w;
    piece.w = piece.l;
    piece.l = oldW;

    updateUIInfo();
    renderScene();
    bus.emit('piece:moved', { pieceId: piece.id, x: piece.x, y: piece.y });
    showToast(`裁片 #${piece.id} 已旋转 90° 为 ${piece.w}×${piece.l}mm`, 'info');
}

// 挂载全局菜单动作回调供 DOM 行内 onclick 调用
window.cadMenuActions = {
    discardRemnant: (remnantId) => {
        closeCADContextMenu();
        discardRemnant(remnantId);
    },
    advanceFromRemnant: (remnantId) => {
        closeCADContextMenu();
        advanceFromRemnantStart(remnantId);
    },
    locateRemnant: (remnantId) => {
        closeCADContextMenu();
        selectRemnant(remnantId, { smoothPan: true, showToastMsg: true, switchTab: true });
    },
    discardPiece: (pieceId) => {
        closeCADContextMenu();
        discardPiece(pieceId);
    },
    rotatePiece: (pieceId) => {
        closeCADContextMenu();
        rotatePieceById(pieceId);
    },
    setAsStationCutEnd: (pieceId) => {
        closeCADContextMenu();
        setPieceAsCutEnd(pieceId);
    },
    autoTrimTail: () => {
        closeCADContextMenu();
        autoTrimStationTailWaste();
    },
    smartAdvance: () => {
        closeCADContextMenu();
        smartAdvanceBed();
    },
    clearStation: () => {
        closeCADContextMenu();
        import('../solver/quota-manager.js').then(m => m.clearStationCuts());
    },
    clearRemnantCuts: () => {
        closeCADContextMenu();
        import('../solver/quota-manager.js').then(m => m.clearStationCuts());
    },
    reloadRemnant: () => {
        closeCADContextMenu();
        import('../remnant/remnant-shelf.js').then(m => m.reloadCurrentRemnant());
    },
    solveRemnant: () => {
        closeCADContextMenu();
        import('../solver/solver-client.js').then(m => m.triggerSolve());
    }
};
