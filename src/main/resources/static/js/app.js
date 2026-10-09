import { initTaskWorkspace, newCuttingTask, startTaskDraft, finishTaskDraft, prepareTaskSwitch, openLocalDrafts, saveTaskFromUI, matchTaskMaterials, openTaskList, openTaskReports, openTaskPlans, taskInputChanged } from './plugins/solver/task-workspace.js';
import {initWorkbenchPanels, openDemandManager, openMaterialDetails} from './plugins/layout/workbench-panels.js';
import {openDemandImport} from './plugins/solver/demand-import.js';
import {openNewTask} from './plugins/solver/task-creation.js';
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
import { showToast, confirmAction } from './core/toast.js';
import { syncMaterialOptions } from './plugins/material/material-options.js';
import { getInitialScenarios, MOTHER_ROLL_SPECS } from './plugins/presets/scenarios.js';

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
    renderRadar, setupRadarInteraction, updateFabricScrollPosition, resizeFeedWindow,
    advanceBed, smartAdvanceBed, updateDefectRadarActiveState, updateDefectVisualStates
} from './plugins/radar/radar-scrubber.js';

import {
    stepCut, playCuts, pauseCuts,
    startContinuousSim, pauseContinuousSim, resetContinuousSim, toggleSimSpeed
} from './plugins/cut-player/cut-animator.js';

import {
    updateDemandCompletionFromPieces, recalculateRollStats,
    clearStationCuts, resetAllRollCuts, resetContinuousCutting, renderDemandsUI, renderDefectsUI,
    addDefectRow, addDemandRow, removeDemandRow, getDefectsFromUI, getDemandsFromUI,
    onRollConfigChange, onOriginParamChange, onParamChange,
    updateRollSize, toggleLongitudinal, loadCurtainOrderTemplate
} from './plugins/solver/quota-manager.js';

import {
    updateUIInfo, loadCase, triggerSolve,
    openCutReport, closeCutReport, confirmCutReport, openBatchReport, exportCutResult,
    openStationLapConfirmModal, updateReportPreview, recordPlanEdit, undoPlanEdit, redoPlanEdit, validatePlanAdjustment,
    stageAndAdvanceNextStation, handleClearStationClick, handleClearStationDblClick
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

bus.on('report:requested', () => { openCutReport(); });
bus.on('feed:resized', () => { taskInputChanged(); });
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

let loadingPreset = false;
export async function selectPresetCase(caseId) {
    if (loadingPreset) return;
    loadingPreset = true;
    if (!await prepareTaskSwitch()) { loadingPreset = false; return; }
    const alreadyInert = document.body.inert;
    let replaced = false;
    document.body.inert = true;
    try {
    const readRolls = async () => {
        const response = await fetch('/api/rolls', {cache:'no-store'});
        if (!response.ok) throw new Error('无法读取库存，请稍后重试');
        return response.json();
    };
    let rolls = await readRolls();
    if (!rolls.length) {
        document.body.inert = alreadyInert;
        const create = await confirmAction('当前没有母卷。确认后会在空库创建 6 卷示例母卷和 5 块示例料头，用于演示完整流程；这些数据不是实物库存。取消则仅载入示例需求。已有业务数据时不会创建或覆盖。', {title:'准备示例材料', action:'创建示例材料并载入'});
        document.body.inert = true;
        if (create) {
            const response = await fetch('/api/demo/inventory', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({confirmed:true})});
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '创建示例材料失败');
            rolls = await readRolls();
        }
    }
    const scenarios = getInitialScenarios();
    const preset = scenarios[caseId];
    if (!preset) throw new Error('示例不存在');
    const model = preset.rollModel || MOTHER_ROLL_SPECS[preset.rollId]?.model || '';
    syncMaterialOptions(rolls, {rollId:preset.rollId, model, fallback:false});
    startTaskDraft(document.querySelector(`#btn-case-${caseId} .preset-item-name`)?.textContent || "示例切割任务");
    replaced = true;
    state.scenarios = scenarios;
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
                    const list = (await listRes.json()).filter(item => item.status === 'AVAILABLE' && item.materialBatch === model);
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
                document.getElementById('sel-mother-roll-id').value = '';
                await onMotherRollChange();
                showToast('已载入示例需求；暂无同型号可用料头，请录入材料或选择其他示例。', 'warning');
            }
        } catch (e) {
            throw e;
        }
    } else {
        await onMotherRollChange();
        if (!state.getCurrentCaseData().materialAvailable) showToast('示例需求已载入；当前库存没有对应示例母卷，请录入材料或匹配同型号库存。', 'info', 7000);
    }
    document.getElementById("task-material").value = model;
    updatePresetTriggerLabel(caseId);
    closePresetDropdown();
    } catch (error) { showToast(error.message, 'error'); }
    finally { if (replaced) finishTaskDraft(); document.body.inert = alreadyInert; loadingPreset = false; }
}

export function updatePresetTriggerLabel(caseId) {
    const label = document.getElementById('preset-current-label');
    if (!label) return;
    const name = document.querySelector(`#btn-case-${caseId} .preset-item-name`);
    label.textContent = name ? name.textContent : `案例${caseId}`;
}

bus.on('toolpath:optimized', () => {
    resetContinuousSim();
    renderScene();
    renderToolpathUI();
});

bus.on('toolpath:restored', () => {
    resetContinuousSim();
    renderScene();
    renderToolpathUI();
});

bus.on('piece:moved', (payload) => {
    // Preserve the saved version; only a validated adjustment can supply new cuts and leftovers.
    recordPlanEdit();
});
bus.on('plan:edited', recordPlanEdit);
window.addEventListener('keydown', event => {
    if (event.target?.closest?.('input, textarea, select, [contenteditable=true]') || !(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoPlanEdit() : undoPlanEdit(); }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); redoPlanEdit(); }
});

// ==========================================
// 2. 导出面向全局 DOM 与 Inline Onclick 的统一命名空间
// ==========================================
const camApp = {
    openDemandManager, openMaterialDetails, openDemandImport, openNewTask,
    undoPlanEdit, redoPlanEdit, validatePlanAdjustment,
    newCuttingTask, saveTaskFromUI, matchTaskMaterials, openTaskList, openTaskReports, openTaskPlans, openLocalDrafts, taskInputChanged,
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
    openCutReport, closeCutReport, confirmCutReport, openBatchReport, exportCutResult,
    openStationLapConfirmModal, updateReportPreview,
    stageAndAdvanceNextStation,
    handleClearStationClick,
    handleClearStationDblClick,
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
    resetContinuousCutting,
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
    onRollConfigChange, resizeFeedWindow,
    updateRollSize,
    toggleLongitudinal,
    addDefectRow,
    addDemandRow, removeDemandRow,
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
    document.body.inert = true;
    try {
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
    // Load real inventory before selecting material; empty databases have no demo rolls.
    initWorkbenchPanels();
    await initTaskWorkspace();
    renderToolpathUI();
    } catch (error) { showToast("工作台初始化失败：" + error.message, "error"); }
    finally { document.body.inert = false; }
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
    const demos = document.getElementById('demo-tools');
    if (demos?.open && (!demos.contains(e.target) || e.target.closest('.preset-menu-item, #btn-reset-continuous'))) demos.open = false;
    document.querySelectorAll('.header-more[open], .canvas-help[open], .status-details[open]').forEach(menu => {
        if (!menu.contains(e.target) || e.target.closest('button')) menu.open = false;
    });
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closePresetDropdown();
        document.querySelectorAll('.header-more[open], .demo-tools[open], .canvas-help[open], .status-details[open]').forEach(menu => {
            menu.open = false;
            menu.querySelector('summary').focus();
        });
    }
});
