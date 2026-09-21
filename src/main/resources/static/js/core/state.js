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
    }

    /**
     * 获取当前案例数据引用
     */
    getCurrentCaseData() {
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
