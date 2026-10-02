/**
 * 【主装配器】CAM 前端应用主入口 (Application Orchestrator)
 * 挂载微内核与所有独立插件，完成全局事件编排与向后兼容性绑定
 */
import { bus } from './core/event-bus.js';
import { state } from './core/state.js';

// 导入各业务与显示插件
import {
    toggleTheme, setTheme, openSettingsModal, closeSettingsModal,
    switchSettingsTab, loadSavedSettings, saveSettings, restoreDefaultSettings
} from './plugins/settings/settings.js';

import {
    toggleSectionCollapse, toggleSidebar, initLayoutResizers, switchRightPanelTab
} from './plugins/layout/splitter.js';
import { showToast } from './core/toast.js';

import {
    initKonva, stage
} from './plugins/cad/cad-stage.js';

import {
    drawRulers
} from './plugins/cad/cad-rulers.js';

import {
    renderScene, resetToBedView, resetToFlowView, viewFullRoll,
    fitView, resetZoom, updateStatusBar, zoomCanvas, setCanvasLayer
} from './plugins/cad/cad-renderer.js';

import {
    renderRadar, setupRadarInteraction, updateFabricScrollPosition,
    advanceBed, smartAdvanceBed, updateDefectRadarActiveState, updateDefectVisualStates
} from './plugins/radar/radar-scrubber.js';

import {
    stepCut, playCuts, pauseCuts,
    startContinuousSim, pauseContinuousSim, resetContinuousSim, toggleSimSpeed
} from './plugins/cut-player/cut-animator.js';

import {
    updateDemandCompletionFromPieces, recalculateRollStats,
    clearStationCuts, resetAllRollCuts, renderDemandsUI, renderDefectsUI,
    addDefectRow, addDemandRow, getDefectsFromUI, getDemandsFromUI,
    onRollConfigChange, onOriginParamChange, onParamChange,
    updateRollSize, toggleLongitudinal, loadCurtainOrderTemplate
} from './plugins/solver/quota-manager.js';

import {
    updateUIInfo, loadCase, triggerSolve,
    openCutReport, closeCutReport, confirmCutReport, exportCutResult,
    openStationLapConfirmModal, updateReportPreview
} from './plugins/solver/solver-client.js';

import {
    switchCutMode, onMotherRollChange, updateMotherRollRemnantStats,
    checkAllDemandsRemnantMatch, chooseRemnantForDemand, dismissRemnantHint,
    onRemnantFilterRollChange, refreshShelfRemnantsList, selectAndMountFromShelf,
    executeShelfBarcodeScan, quickSelectRemnant, mountRemnantToBed,
    renderRemnantDemandsUI, addRemnantDemandRow, getRemnantDemandsFromUI,
    reloadCurrentRemnant
} from './plugins/remnant/remnant-shelf.js';

import {
    openRemnantModal, closeRemnantModal, refreshRemnantsList,
    executeBarcodeScan, quickScan, selectAndLoadRemnant
} from './plugins/remnant/remnant-modal.js';

import {
    optimizeCurrentToolpath, restoreOriginalToolpath,
    toggleToolpathOptimization, renderToolpathUI, calculateCycleTime
} from './plugins/toolpath/toolpath-optimizer.js';

import {
    toggleMeasureTool, clearAllMeasurements
} from './plugins/cad/cad-measure.js';

import {
    initNestingKeyboardShortcuts, getSelectedPieceId, setSelectedPieceId
} from './plugins/cad/cad-interactive-nesting.js';

import {
    initCADContextMenu
} from './plugins/cad/cad-context-menu.js';

import {
    selectRemnant, clearRemnantSelection, hoverRemnant
} from './plugins/cad/cad-remnant-highlight.js';

import {
    generateGCode, generateDXF, openExportModal, closeExportModal,
    switchExportTab, copyExportPreview, openCutTicketModal, closeCutTicketModal,
    printCutTicketDocument
} from './plugins/export/nc-dxf-exporter.js';


import {
    openMaterialModal, closeMaterialModal, switchMaterialTab,
    selectRollForDetail, submitNewDefect, submitNewRoll, mountRollToStation,
    scrapRemnantById, toggleAddDefectForm, refreshRollsList
} from './plugins/material/material-manager.js';

// ==========================================
// 1. 注册核心事件总线监听 (Microkernel Event Wiring)
// ==========================================
bus.on('stage:transformed', (payload) => {
    drawRulers(payload.pointerX, payload.pointerY);
    updateStatusBar();
});

bus.on('stage:mouseleave', () => {
    drawRulers();
});

bus.on('cursor:moved', (payload) => {
    drawRulers(payload.pointerX, payload.pointerY);
});

bus.on('stage:resized', () => {
    drawRulers();
    renderRadar();
});

bus.on('station:moved', () => {
    updateUIInfo();
});

bus.on('radar:dragend', () => {
    updateUIInfo();
});

bus.on('radar:wheel', () => {
    updateUIInfo();
});

bus.on('demands:changed', () => {
    checkAllDemandsRemnantMatch();
});

bus.on('settings:updated', () => {
    renderScene();
    drawRulers();
});

bus.on('theme:changed', () => {
    renderScene();
    drawRulers();
    renderRadar();
    if (state.currentCutMode === "remnant") {
        refreshShelfRemnantsList();
    }
});

bus.on('remnant:registered', (payload) => {
    refreshShelfRemnantsList();
    updateMotherRollRemnantStats(payload.curRollId);
});

bus.on('solve:success', (payload) => {
    refreshShelfRemnantsList();
    updateMotherRollRemnantStats(payload.rollId);
    state.isToolpathOptimized = false;
    state.toolpathStats = null;
    state.originalCutsBackup = null;
    renderToolpathUI();
});

bus.on('case:changed', (payload) => {
    state.isToolpathOptimized = false;
    state.toolpathStats = null;
    state.originalCutsBackup = null;
    renderToolpathUI();
    if (payload && payload.caseId) {
        updatePresetTriggerLabel(payload.caseId);
    }
});

/**
 * 顶部 Header 预设工业工况下拉浮层控制
 */
export function togglePresetDropdown(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('preset-dropdown-menu');
    const trigger = document.getElementById('btn-preset-trigger');
    if (!menu) return;
    const isOpen = menu.classList.contains('show');
    if (trigger) trigger.setAttribute('aria-expanded', String(!isOpen));
    if (isOpen) {
        menu.classList.remove('show');
        if (trigger) trigger.classList.remove('active');
    } else {
        menu.classList.add('show');
        if (trigger) trigger.classList.add('active');
    }
}

export function closePresetDropdown() {
    const menu = document.getElementById('preset-dropdown-menu');
    const trigger = document.getElementById('btn-preset-trigger');
    if (menu) menu.classList.remove('show');
    if (trigger) trigger.classList.remove('active');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

export async function selectPresetCase(caseId) {
    if (typeof loadCase === 'function') {
        loadCase(caseId);
    }
    if (caseId === 3) {
        const case3 = state.scenarios[3];
        try {
            let remnant = null;
            try {
                const response = await fetch('/api/remnants/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: 'REM-202609-001' })
                });
                if (response.ok) {
                    const text = await response.text();
                    if (text && text.trim().length > 0 && text.trim() !== 'null') {
                        const r = JSON.parse(text);
                        if (r && r.id) remnant = r;
                    }
                }
            } catch (scanErr) {
                console.warn("Scan default remnant error, falling back to shelf:", scanErr);
            }

            if (!remnant) {
                const listRes = await fetch('/api/remnants');
                if (listRes.ok) {
                    const list = await listRes.json();
                    if (Array.isArray(list) && list.length > 0) {
                        // 优先选用完好的大料头
                        remnant = list.find(r => !r.hasDefect && r.area >= 1.0) || list[0];
                    }
                }
            }

            if (remnant && remnant.id) {
                await switchCutMode('remnant', remnant, case3);
                renderRemnantDemandsUI(case3.demands || [{ name: '次卧飘窗短帘主片', width: 1200, length: 1000, count: 1 }]);
                renderScene();
                resetToBedView();
                updateUIInfo();
                renderToolpathUI();
            } else {
                showToast('在库料头已耗尽，请从母卷排料生成料头或在料头库新增。', 'warning');
            }
        } catch (e) {
            console.error("Case 3 load error:", e);
        }
    } else {
        const currentData = state.getCurrentCaseData();
        const selectedRoll = currentData.rollId || 'ROLL-2026-0920';
        const selector = document.getElementById('sel-mother-roll-id');
        if (selector) {
            if (![...selector.options].some(o => o.value === selectedRoll)) {
                const opt = document.createElement("option");
                opt.value = selectedRoll;
                opt.textContent = `${selectedRoll} (${currentData.rollModel || ''} ${currentData.rollW ? (currentData.rollW/1000).toFixed(1) + 'm' : ''})`;
                selector.appendChild(opt);
            }
            selector.value = selectedRoll;
        }
        await onMotherRollChange();
        if (caseId === 7 || caseId === 8) {
            setTimeout(() => {
                if (window.camApp && typeof window.camApp.triggerSolve === 'function') {
                    window.camApp.triggerSolve();
                }
            }, 300);
        }
    }
    updatePresetTriggerLabel(caseId);
    closePresetDropdown();
}

export function updatePresetTriggerLabel(caseId) {
    const label = document.getElementById('preset-current-label');
    if (!label) return;
    const name = document.querySelector(`#btn-case-${caseId} .preset-item-name`);
    label.textContent = name ? name.textContent : `案例${caseId}`;
}

bus.on('toolpath:optimized', () => {
    renderScene();
    renderToolpathUI();
});

bus.on('toolpath:restored', () => {
    renderScene();
    renderToolpathUI();
});

bus.on('piece:moved', (payload) => {
    // 裁片在画布上手动微调后，动态重新计算切线、刀路与对账指标
    state.isToolpathOptimized = false;
    state.toolpathStats = null;
    state.originalCutsBackup = null;
    renderScene();
    renderToolpathUI();
    recalculateRollStats();
    updateDemandCompletionFromPieces();
});

// ==========================================
// 2. 导出面向全局 DOM 与 Inline Onclick 的统一命名空间
// ==========================================
const camApp = {
    bus,
    state,
    toggleTheme,
    setTheme,
    openSettingsModal,
    closeSettingsModal,
    switchSettingsTab,
    loadSavedSettings,
    saveSettings,
    restoreDefaultSettings,
    toggleSectionCollapse,
    toggleSidebar,
    initLayoutResizers,
    switchRightPanelTab,
    fitView,
    resetZoom,
    resetToBedView,
    resetToFlowView,
    viewFullRoll,
    zoomCanvas, setCanvasLayer,
    triggerSolve,
    openCutReport, closeCutReport, confirmCutReport, exportCutResult,
    openStationLapConfirmModal, updateReportPreview,
    loadCase,
    stepCut,
    playCuts,
    pauseCuts,
    startContinuousSim,
    pauseContinuousSim,
    resetContinuousSim,
    toggleSimSpeed,
    clearStationCuts,
    resetAllRollCuts,
    advanceBed,
    smartAdvanceBed,
    switchCutMode,
    onMotherRollChange,
    onRemnantFilterRollChange,
    refreshShelfRemnantsList,
    selectAndMountFromShelf,
    executeShelfBarcodeScan,
    quickSelectRemnant,
    renderRemnantDemandsUI,
    addRemnantDemandRow,
    getRemnantDemandsFromUI,
    openRemnantModal,
    closeRemnantModal,
    refreshRemnantsList,
    executeBarcodeScan,
    quickScan,
    selectAndLoadRemnant,
    reloadCurrentRemnant,
    onParamChange,
    onOriginParamChange,
    onRollConfigChange,
    updateRollSize,
    toggleLongitudinal,
    addDefectRow,
    addDemandRow,
    chooseRemnantForDemand,
    dismissRemnantHint,
    checkAllDemandsRemnantMatch,
    optimizeCurrentToolpath,
    restoreOriginalToolpath,
    toggleToolpathOptimization,
    renderToolpathUI,
    calculateCycleTime,
    toggleMeasureTool,
    clearAllMeasurements,
    getSelectedPieceId,
    setSelectedPieceId,
    openExportModal,
    closeExportModal,
    switchExportTab,
    copyExportPreview,
    openCutTicketModal,
    closeCutTicketModal,
    printCutTicketDocument,
    generateGCode,
    generateDXF,
    openMaterialModal,
    closeMaterialModal,
    switchMaterialTab,
    selectRollForDetail,
    submitNewDefect, submitNewRoll,
    mountRollToStation,
    scrapRemnantById,
    toggleAddDefectForm,
    refreshRollsList,
    togglePresetDropdown,
    closePresetDropdown,
    selectPresetCase,
    updatePresetTriggerLabel,
    toggleSectionCollapse,
    toggleSidebar,
    switchRightPanelTab,
    showToast,
    loadCurtainOrderTemplate,
    selectRemnant,
    clearRemnantSelection,
    hoverRemnant
};

window.camApp = camApp;
window.selectRemnant = selectRemnant;
window.clearRemnantSelection = clearRemnantSelection;
window.hoverRemnant = hoverRemnant;
window.cutApp = window.cutApp || {};
window.cutApp.plugins = {
    export: {
        openExportModal, closeExportModal, switchExportTab,
        copyExportPreview, openCutTicketModal, closeCutTicketModal,
        printCutTicketDocument,
        generateGCode, generateDXF
    },
    measure: {
        toggleMeasureTool, clearAllMeasurements
    },
    nesting: {
        getSelectedPieceId, setSelectedPieceId
    },
    toolpath: {
        optimizeCurrentToolpath, restoreOriginalToolpath,
        toggleToolpathOptimization, renderToolpathUI, calculateCycleTime
    },
    animator: {
        stepCut, startContinuousSim, pauseContinuousSim, resetContinuousSim, toggleSimSpeed
    },
    material: {
        openMaterialModal, closeMaterialModal, switchMaterialTab,
        selectRollForDetail, submitNewDefect, submitNewRoll, mountRollToStation,
        scrapRemnantById, toggleAddDefectForm, refreshRollsList
    }
};

// 直接映射到 window 顶级对象，确保原生 HTML 中的所有 onclick="fn()" 100% 正常运行
Object.keys(camApp).forEach(key => {
    window[key] = camApp[key];
});
window.camApp = camApp;

// ==========================================
// 3. 应用程序自启动装配与初始化 (Robust Bootstrap)
// ==========================================
async function bootstrapApp() {
    const savedTheme = localStorage.getItem("cam_theme") || "light";
    setTheme(savedTheme);

    let savedOrigin = localStorage.getItem("cam_origin");
    if (!savedOrigin || savedOrigin === "right-top") {
        savedOrigin = "right-bottom";
        localStorage.setItem("cam_origin", "right-bottom");
    }
    if (document.getElementById("sel-cut-origin")) {
        document.getElementById("sel-cut-origin").value = savedOrigin;
    }

    initKonva();
    initCADContextMenu();
    setupRadarInteraction();
    initLayoutResizers();
    initNestingKeyboardShortcuts();
    loadCase(1); // 默认打开案例1：窗帘定高整幅横切
    updatePresetTriggerLabel(1);
    await onMotherRollChange();
    refreshShelfRemnantsList();
    renderToolpathUI();
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootstrapApp);
} else {
    bootstrapApp();
}

// 全局监听：点击外部区域或按下 ESC 键自动收起演示工况浮层
document.addEventListener("click", (e) => {
    const container = document.getElementById("preset-dropdown-container");
    if (container && !container.contains(e.target)) {
        closePresetDropdown();
    }
    document.querySelectorAll('.header-more[open], .canvas-help[open], .status-details[open]').forEach(menu => {
        if (!menu.contains(e.target) || e.target.closest('button')) menu.open = false;
    });
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closePresetDropdown();
        document.querySelectorAll('.header-more[open], .canvas-help[open], .status-details[open]').forEach(menu => {
            menu.open = false;
            menu.querySelector('summary').focus();
        });
    }
});
