/**
 * 【微内核架构】响应式全局状态管理器 (State Store)
 * 集中管理系统运行态，并通过 EventBus 对外发布变更通知
 */
import { bus } from './event-bus.js';
import { getInitialScenarios, MOTHER_ROLL_SPECS } from '../plugins/presets/scenarios.js';

class StateStore {
    constructor() {
        this.scenarios = getInitialScenarios();
        this.motherRollSpecs = { ...MOTHER_ROLL_SPECS };
        this.currentCaseId = 4;
        this.currentCutMode = "roll"; // "roll" | "remnant"
        this.currentFeedPort = "roll";
        this.currentCutStepLimit = 999;
        this.loadedRemnant = null;
        this.isToolpathOptimized = false;
        this.toolpathStats = null;
        this.originalCutsBackup = null;

        // 料头工况专用独立运行态，彻底杜绝料头尺寸与数据污染母卷案例
        this.remnantWorkspaceData = {
            rollId: "REMNANT-STATION",
            totalRollL: 1600,
            bedL: 1600,
            windowStartY: 0,
            rollW: 2000,
            trimStart: 0,
            cutOrigin: "right-bottom",
            firstStageOrientation: "horizontal",
            allowRotation: false,
            allowLongitudinal: true,
            globalDefects: [],
            demands: [],
            pieces: [],
            remnants: [],
            cuts: [],
            deductLen: 0,
            pieceArea: 0,
            remArea: 0,
            wasteArea: 0,
            totalArea: 0,
            engine: "料头精益复用排料引擎"
        };
    }

    /**
     * 获取当前工况数据引用 (母卷模式与料头模式严格环境隔离)
     */
    getCurrentCaseData() {
        if (this.currentCutMode === "remnant") {
            return this.remnantWorkspaceData;
        }
        if (!this.scenarios[this.currentCaseId]) {
            this.scenarios[this.currentCaseId] = {};
        }
        return this.scenarios[this.currentCaseId];
    }

    /**
     * 切换当前案例
     */
    setCaseId(caseId) {
        this.currentCaseId = caseId;
        this.currentCutStepLimit = 999;
        bus.emit('case:changed', {
            caseId,
            data: this.getCurrentCaseData()
        });
    }

    /**
     * 切换工位模式 (roll / remnant)
     */
    setCutMode(mode, remnant = null) {
        this.currentCutMode = mode;
        this.currentFeedPort = mode;
        if (remnant) {
            this.loadedRemnant = remnant;
        }
        bus.emit('mode:changed', {
            mode,
            loadedRemnant: this.loadedRemnant
        });
    }

    /**
     * 设置刀序限制
     */
    setCutStepLimit(limit) {
        this.currentCutStepLimit = limit;
        bus.emit('cut-step:changed', { limit });
    }

    /**
     * 装载料头
     */
    setLoadedRemnant(rem) {
        this.loadedRemnant = rem;
        bus.emit('remnant:loaded', rem);
    }
}

export const state = new StateStore();
