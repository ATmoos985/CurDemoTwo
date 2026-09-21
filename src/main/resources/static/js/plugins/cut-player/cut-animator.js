/**
 * 刀序演播与工步模拟插件 (Cut Step Animator Plugin)
 */
import { state } from '../../core/state.js';
import { renderScene } from '../cad/cad-renderer.js';
import { bus } from '../../core/event-bus.js';

let playTimer = null;

export function stepCut(delta) {
    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    let currentLimit = state.currentCutStepLimit;

    if (delta === -999) {
        currentLimit = 0;
    } else if (delta === 999) {
        currentLimit = cuts.length;
    } else {
        currentLimit = Math.max(0, Math.min(cuts.length, currentLimit + delta));
    }

    state.setCutStepLimit(currentLimit);

    const statusEl = document.getElementById("cut-sim-status");
    if (statusEl) {
        if (currentLimit === 0) {
            statusEl.innerText = "刀序演播: 未下刀 (原料状态)";
        } else if (currentLimit >= cuts.length) {
            statusEl.innerText = `刀序演播: 全部显示 (共 ${cuts.length} 刀)`;
        } else {
            statusEl.innerText = `刀序演播: 当前第 ${currentLimit} / ${cuts.length} 刀`;
        }
    }

    renderScene();
    bus.emit('cut:stepped', { step: currentLimit, total: cuts.length });
}

export function playCuts() {
    pauseCuts();
    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    if (state.currentCutStepLimit >= cuts.length) {
        state.setCutStepLimit(0);
    }
    playTimer = setInterval(() => {
        const d = state.getCurrentCaseData();
        const total = (d.cuts || []).length;
        if (state.currentCutStepLimit < total) {
            stepCut(1);
        } else {
            pauseCuts();
        }
    }, 1000);
}

export function pauseCuts() {
    if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
    }
}
