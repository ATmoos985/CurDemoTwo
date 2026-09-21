/**
 * 刀序演播与真机连续平滑 CAM 仿真引擎 (Continuous CAM Toolpath Simulator)
 * 支持离散单步推演与 60fps 平滑连续真机轨迹仿真、多倍速调节(1x/2x/5x/10x)、下刀/提刀/快移状态指示
 */
import { state } from '../../core/state.js';
import { renderScene } from '../cad/cad-renderer.js';
import { stage, mainLayer } from '../cad/cad-stage.js';
import { bus } from '../../core/event-bus.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';

let isSimulating = false;
let simSpeed = 2; // 默认 2x 仿真速度
let animFrameId = null;
let simToolGroup = null;

// 仿真状态机
let simState = {
    stepIndex: 0,
    phase: 'rapid', // 'rapid' (空刀快移) 或 'cutting' (下刀切削)
    progress: 0.0,  // 0.0 ~ 1.0
    fromX: 0, fromY: 0,
    toX: 0, toY: 0,
    lastTime: null
};

/**
 * 离散跳刀 (保留向后兼容)
 */
export function stepCut(delta) {
    if (isSimulating) pauseContinuousSim();

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
    updateSimStatusText(`刀序演播: ${currentLimit === 0 ? '未下刀 (原料状态)' : (currentLimit >= cuts.length ? `全部显示 (共 ${cuts.length} 刀)` : `当前第 ${currentLimit} / ${cuts.length} 刀`)}`);
    
    destroySimTool();
    renderScene();
    bus.emit('cut:stepped', { step: currentLimit, total: cuts.length });
}

/**
 * 启动或继续连续真机平滑仿真
 */
export function startContinuousSim() {
    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    if (cuts.length === 0) {
        alert("当前工位暂无切刀指令，请先执行排料！");
        return;
    }

    if (isSimulating) {
        pauseContinuousSim();
        return;
    }

    isSimulating = true;
    updatePlayPauseButtonUI(true);

    // 若已经处于末尾，从头开始
    if (simState.stepIndex >= cuts.length || state.currentCutStepLimit >= cuts.length) {
        resetContinuousSim();
        isSimulating = true;
        updatePlayPauseButtonUI(true);
    }

    simState.lastTime = performance.now();
    animFrameId = requestAnimationFrame(simAnimationLoop);
}

/**
 * 暂停平滑仿真
 */
export function pauseContinuousSim() {
    isSimulating = false;
    if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
    }
    updatePlayPauseButtonUI(false);
}

/**
 * 兼容旧接口别名
 */
export function playCuts() {
    startContinuousSim();
}

export function pauseCuts() {
    pauseContinuousSim();
}

/**
 * 重置仿真至起始状态
 */
export function resetContinuousSim() {
    pauseContinuousSim();
    const data = state.getCurrentCaseData();
    const home = getHomeCoordinates(data);
    simState.stepIndex = 0;
    simState.phase = 'rapid';
    simState.progress = 0.0;
    simState.fromX = home.x;
    simState.fromY = home.y;
    simState.lastTime = null;

    state.setCutStepLimit(0);
    destroySimTool();
    renderScene();
    updateSimStatusText("刀序演播: 未下刀 (原料状态)");
}

/**
 * 切换仿真播放倍速
 */
export function toggleSimSpeed() {
    const speeds = [1, 2, 5, 10];
    const idx = speeds.indexOf(simSpeed);
    simSpeed = speeds[(idx + 1) % speeds.length];
    const btn = document.getElementById("btn-sim-speed");
    if (btn) btn.innerText = `${simSpeed}x 仿真`;
}

/**
 * 仿真主时钟循环 (60fps requestAnimationFrame)
 */
function simAnimationLoop(now) {
    if (!isSimulating) return;

    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    if (simState.stepIndex >= cuts.length) {
        // 全刀加工完毕
        isSimulating = false;
        updatePlayPauseButtonUI(false);
        state.setCutStepLimit(cuts.length);
        renderScene();
        destroySimTool();
        updateSimStatusText(`仿真完成: 共 ${cuts.length} 刀全部加工完成！`);
        return;
    }

    const dt = Math.min(100, (now - (simState.lastTime || now))) / 1000; // 秒
    simState.lastTime = now;

    const cut = cuts[simState.stepIndex];
    const isHoriz = (cut.type === "横切");
    let startX = cut.startX !== undefined ? cut.startX : (isHoriz ? cut.start : cut.pos);
    let startY = cut.startY !== undefined ? cut.startY : (isHoriz ? cut.pos : cut.start);
    let endX = cut.endX !== undefined ? cut.endX : (isHoriz ? cut.end : cut.pos);
    let endY = cut.endY !== undefined ? cut.endY : (isHoriz ? cut.pos : cut.end);

    // 基础物理速度 (mm/s)
    const RAPID_SPEED = 2500 * simSpeed; // 空刀快移 2500mm/s
    const CUT_SPEED = 600 * simSpeed;    // 切割进给 600mm/s

    if (simState.phase === 'rapid') {
        // 1. 空走快移动画阶段
        const airDist = Math.hypot(startX - simState.fromX, startY - simState.fromY);
        const duration = Math.max(0.12, airDist / RAPID_SPEED);
        simState.progress += dt / duration;

        const curX = simState.fromX + (startX - simState.fromX) * Math.min(1.0, simState.progress);
        const curY = simState.fromY + (startY - simState.fromY) * Math.min(1.0, simState.progress);
        renderSimTool(curX, curY, 'rapid', simState.stepIndex + 1, cuts.length);

        updateSimStatusText(`[快移飞奔] 刀序 #${simState.stepIndex + 1} ➔ 下刀点 (${Math.round(startX)}, ${Math.round(startY)})`);

        if (simState.progress >= 1.0) {
            // 到达下刀点，切换至下刀切削
            simState.phase = 'cutting';
            simState.progress = 0.0;
            simState.fromX = startX;
            simState.fromY = startY;
        }
    } else {
        // 2. 直线切削下刀阶段
        const cutDist = Math.hypot(endX - startX, endY - startY);
        const duration = Math.max(0.2, cutDist / CUT_SPEED);
        simState.progress += dt / duration;

        const curX = startX + (endX - startX) * Math.min(1.0, simState.progress);
        const curY = startY + (endY - startY) * Math.min(1.0, simState.progress);
        renderSimTool(curX, curY, 'cutting', simState.stepIndex + 1, cuts.length);

        updateSimStatusText(`[正在切削] 刀序 #${simState.stepIndex + 1} (${cut.type}) 进给 ${(cutDist * simState.progress).toFixed(0)} / ${Math.round(cutDist)} mm`);

        if (simState.progress >= 1.0) {
            // 本刀切完，更新永久切刀显示至本步
            state.setCutStepLimit(simState.stepIndex + 1);
            renderScene();

            // 切换至下一刀
            simState.stepIndex++;
            simState.phase = 'rapid';
            simState.progress = 0.0;
            simState.fromX = endX;
            simState.fromY = endY;
        }
    }

    animFrameId = requestAnimationFrame(simAnimationLoop);
}

/**
 * 在 Konva 视口中渲染动态刀头实体
 */
function renderSimTool(x, y, mode, stepNum, totalSteps) {
    if (!mainLayer) return;

    if (!simToolGroup) {
        simToolGroup = new Konva.Group({ name: "sim-tool-head" });
        mainLayer.add(simToolGroup);
    }
    simToolGroup.destroyChildren();

    const isRapid = (mode === 'rapid');
    const toolColor = isRapid ? "#0284c7" : "#ef4444";
    const toolGlow = isRapid ? "rgba(56, 189, 248, 0.4)" : "rgba(239, 68, 68, 0.5)";

    // 刀头光环
    simToolGroup.add(new Konva.Circle({
        x: x, y: y, radius: 18,
        fill: toolGlow, stroke: toolColor, strokeWidth: 1.5
    }));
    // 刀头实体
    simToolGroup.add(new Konva.Circle({
        x: x, y: y, radius: 7,
        fill: toolColor, stroke: "#ffffff", strokeWidth: 2
    }));
    // 十字刻线
    simToolGroup.add(new Konva.Line({
        points: [x - 24, y, x + 24, y], stroke: toolColor, strokeWidth: 1.5, dash: [4, 4]
    }));
    simToolGroup.add(new Konva.Line({
        points: [x, y - 24, x, y + 24], stroke: toolColor, strokeWidth: 1.5, dash: [4, 4]
    }));

    // 刀头状态文字浮动标签
    const tagText = isRapid ? `[G00 快移] 刀 #${stepNum}/${totalSteps}` : `[G01 下刀] 刀 #${stepNum}/${totalSteps}`;
    simToolGroup.add(new Konva.Rect({
        x: x + 12, y: y - 26, width: tagText.length * 8.5 + 14, height: 22,
        fill: "rgba(15, 23, 42, 0.9)", stroke: toolColor, strokeWidth: 1, cornerRadius: 3
    }));
    simToolGroup.add(new Konva.Text({
        x: x + 18, y: y - 21, text: tagText,
        fontSize: 11.5, fill: isRapid ? "#38bdf8" : "#fca5a5", fontStyle: "bold", fontFamily: "monospace"
    }));

    simToolGroup.moveToTop();
    mainLayer.batchDraw();
}

function destroySimTool() {
    if (simToolGroup) {
        simToolGroup.destroy();
        simToolGroup = null;
        if (mainLayer) mainLayer.batchDraw();
    }
}

function updateSimStatusText(text) {
    const statusEl = document.getElementById("cut-sim-status");
    if (statusEl) statusEl.innerText = text;
}

function updatePlayPauseButtonUI(isPlaying) {
    const btn = document.getElementById("btn-sim-play-pause");
    if (btn) {
        btn.innerText = isPlaying ? "暂停仿真" : "▶ 连续仿真";
        btn.style.background = isPlaying ? "#d97706" : "#0284c7";
    }
}
