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

import {
    initKonva, stage
} from './plugins/cad/cad-stage.js';

import {
    drawRulers
} from './plugins/cad/cad-rulers.js';

import {
    renderScene, resetToBedView, resetToFlowView, viewFullRoll,
    fitView, resetZoom, updateStatusBar
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
    updateRollSize, toggleLongitudinal
} from './plugins/solver/quota-manager.js';

import {
    updateUIInfo, loadCase, triggerSolve, registerCurrentRemnant
} from './plugins/solver/solver-client.js';

import {
    switchCutMode, onMotherRollChange, updateMotherRollRemnantStats,
    checkAllDemandsRemnantMatch, chooseRemnantForDemand, dismissRemnantHint,
    onRemnantFilterRollChange, refreshShelfRemnantsList, selectAndMountFromShelf,
    executeShelfBarcodeScan, quickSelectRemnant, mountRemnantToBed,
    renderRemnantDemandsUI, addRemnantDemandRow, getRemnantDemandsFromUI
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
    generateGCode, generateDXF, openExportModal, closeExportModal,
    switchExportTab, copyExportPreview, openCutTicketModal, closeCutTicketModal,
    printCutTicketDocument
} from './plugins/export/nc-dxf-exporter.js';


import {
    openMaterialModal, closeMaterialModal, switchMaterialTab,
    selectRollForDetail, submitNewDefect, mountRollToStation,
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

bus.on('case:changed', () => {
    state.isToolpathOptimized = false;
    state.toolpathStats = null;
    state.originalCutsBackup = null;
    renderToolpathUI();
});

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
    triggerSolve,
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
    registerCurrentRemnant,
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
    submitNewDefect,
    mountRollToStation,
    scrapRemnantById,
    toggleAddDefectForm,
    refreshRollsList
};

window.camApp = camApp;
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
        selectRollForDetail, submitNewDefect, mountRollToStation,
        scrapRemnantById, toggleAddDefectForm, refreshRollsList
    }
};

// 直接映射到 window 顶级对象，确保原生 HTML 中的所有 onclick="fn()" 100% 正常运行
Object.keys(camApp).forEach(key => {
    window[key] = camApp[key];
});

// ==========================================
// 3. 应用程序自启动装配与初始化 (Robust Bootstrap)
// ==========================================
async function bootstrapApp() {
    const savedTheme = localStorage.getItem("cam_theme") || "dark";
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
    setupRadarInteraction();
    initLayoutResizers();
    initNestingKeyboardShortcuts();
    loadCase(4); // 默认打开 60米母卷全局全景演示
    await onMotherRollChange();
    refreshShelfRemnantsList();
    renderToolpathUI();
}

if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", bootstrapApp);
} else {
    bootstrapApp();
}
