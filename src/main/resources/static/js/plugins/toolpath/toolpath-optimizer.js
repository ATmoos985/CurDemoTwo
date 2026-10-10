/**
 * CAD/CAM 工业级刀路优化插件 (Toolpath Optimizer Plugin)
 * 以所选机台原点为起点，使用最近邻、方向翻转和相邻交换减少空走距离。
 * 保留工艺先后关系，优化和恢复均保存为可追溯的方案版本。
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene } from '../cad/cad-renderer.js';
import { renderCutTable, canUseCurrentPlan, saveToolpathAdjustment } from '../solver/solver-client.js';
import { showToast } from '../../core/toast.js';

let optimizing = false;

/**
 * 获取当前工位所选机台原点。
 */
export function getHomeCoordinates(data) {
    const isRemnantMode = (state.currentCutMode === "remnant");
    const origin = data.cutOrigin || 'right-bottom';
    const width = isRemnantMode ? state.loadedRemnant?.width || data.rollW : data.rollW;
    const height = isRemnantMode ? state.loadedRemnant?.length || data.bedL : data.bedL;
    return {x:origin.startsWith('right') ? width || 2000 : 0,
        y:(isRemnantMode ? 0 : data.windowStartY || 0) + (origin.endsWith('bottom') ? height || 5000 : 0)};
}

/**
 * 针对切刀序列执行纯前端/后端协同的刀路优化
 */
export async function optimizeCurrentToolpath(respectPrecedence = true) {
    if (optimizing) return;
    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    if (cuts.length === 0) {
        alert("【刀路优化提示】当前工位暂无切刀指令，请先完成排料生成下刀切序！");
        return;
    }

    const pending = state.pendingPlan;
    if (pending && !canUseCurrentPlan()) { showToast('请先校验裁片调整，再优化刀路', 'warning'); return; }
    const snapshot = JSON.stringify({pieces:data.pieces, remnants:data.remnants, cuts});
    const backup = JSON.parse(JSON.stringify(cuts));
    const home = getHomeCoordinates(data);
    optimizing = true;
    try {
        let result;
        try {
            const res = await fetch('/api/toolpath/optimize', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({cuts:backup, homeX:home.x, homeY:home.y, respectPrecedence})
            });
            if (res.ok) {
                const response = await res.json();
                if (response.success && Array.isArray(response.optimizedCuts)) result = response;
            }
        } catch (e) {
            console.warn('刀路接口不可达，使用本地算法计算候选刀路', e);
        }
        result ||= solveLocalSegmentTSP(backup, home.x, home.y, respectPrecedence);
        if (data !== state.getCurrentCaseData() || pending !== state.pendingPlan
                || snapshot !== JSON.stringify({pieces:data.pieces, remnants:data.remnants, cuts:data.cuts})
                || JSON.stringify(home) !== JSON.stringify(getHomeCoordinates(data))) return;
        if (pending) {
            if (!await saveToolpathAdjustment(result.optimizedCuts)) return;
            result.optimizedCuts = data.cuts;
        }
        state.originalCutsBackup = backup;
        applyOptimizedResult(data, result, home);
    } catch (e) { showToast(e.message || '刀路保存失败，原方案保留', 'error'); }
    finally { optimizing = false; }
}

/**
 * 应用优化结果并刷新界面与渲染层
 */
function applyOptimizedResult(data, result, home) {
    data.cuts = result.optimizedCuts;
    state.isToolpathOptimized = true;
    state.toolpathStats = {
        ...result,
        homeX: home.x,
        homeY: home.y
    };

    renderToolpathUI();
    renderCutTable(data.cuts);
    renderScene();
    bus.emit('toolpath:optimized', state.toolpathStats);
}

/**
 * 恢复原始默认切序
 */
export async function restoreOriginalToolpath() {
    if (optimizing || !state.originalCutsBackup) return;
    const data = state.getCurrentCaseData();
    const cuts = JSON.parse(JSON.stringify(state.originalCutsBackup));
    optimizing = true;
    try {
        if (state.pendingPlan) {
            if (!await saveToolpathAdjustment(cuts)) return;
        } else data.cuts = cuts;
        state.isToolpathOptimized = false;
        state.toolpathStats = null;
        state.originalCutsBackup = null;
        renderToolpathUI(); renderCutTable(data.cuts); renderScene();
        bus.emit('toolpath:restored');
    } catch (e) { showToast(e.message || '恢复刀路失败，当前方案保留', 'error'); }
    finally { optimizing = false; }
}

/**
 * 切换优化状态 (Toggle)
 */
export function toggleToolpathOptimization() {
    if (state.isToolpathOptimized) {
        restoreOriginalToolpath();
    } else {
        optimizeCurrentToolpath(true);
    }
}

/**
 * 本地最近邻、方向翻转与相邻交换。
 */
function solveLocalSegmentTSP(rawCuts, homeX, homeY, respectPrecedence) {
    const explicitStages = rawCuts.every(c => Number.isInteger(c.stage) && c.stage > 0);
    const segments = rawCuts.map((c, index) => {
        let p1x, p1y, p2x, p2y;
        if (c.startX != null && c.endX != null && c.startY != null && c.endY != null) {
            p1x = c.startX; p1y = c.startY;
            p2x = c.endX; p2y = c.endY;
        } else if (c.type === "横切") {
            p1x = c.start; p1y = c.pos;
            p2x = c.end; p2y = c.pos;
        } else {
            p1x = c.pos; p1y = c.start;
            p2x = c.pos; p2y = c.end;
        }
        const stage = !respectPrecedence ? 1 : explicitStages ? c.stage : index + 1;

        return {
            original: c,
            stage: stage,
            p1x, p1y, p2x, p2y,
            startX: p1x, startY: p1y,
            endX: p2x, endY: p2y,
            length: Math.hypot(p2x - p1x, p2y - p1y),
            isReversed: false
        };
    });

    const setSegDirection = (s, rev) => {
        s.isReversed = rev;
        s.startX = rev ? s.p2x : s.p1x;
        s.startY = rev ? s.p2y : s.p1y;
        s.endX = rev ? s.p1x : s.p2x;
        s.endY = rev ? s.p1y : s.p2y;
    };

    const calcAir = (tour) => {
        let air = 0;
        let cx = homeX, cy = homeY;
        tour.forEach(s => {
            air += Math.hypot(s.startX - cx, s.startY - cy);
            cx = s.endX; cy = s.endY;
        });
        return air;
    };

    const origAir = calcAir(segments);
    const original = segments.map(s => ({...s}));

    // 贪心最近邻构建
    const pool = [...segments];
    let tour = [];
    let curX = homeX, curY = homeY;

    // 按阶段排序分组
    const stageGroups = {};
    pool.forEach(s => {
        const st = respectPrecedence ? s.stage : 1;
        if (!stageGroups[st]) stageGroups[st] = [];
        stageGroups[st].push(s);
    });

    Object.keys(stageGroups).sort((a,b)=>a-b).forEach(st => {
        const subPool = stageGroups[st];
        while (subPool.length > 0) {
            let bestIdx = -1;
            let bestRev = false;
            let bestDist = Infinity;

            for (let i = 0; i < subPool.length; i++) {
                const s = subPool[i];
                const d1 = Math.hypot(s.p1x - curX, s.p1y - curY);
                if (d1 < bestDist) { bestDist = d1; bestIdx = i; bestRev = false; }
                const d2 = Math.hypot(s.p2x - curX, s.p2y - curY);
                if (d2 < bestDist) { bestDist = d2; bestIdx = i; bestRev = true; }
            }

            const chosen = subPool.splice(bestIdx, 1)[0];
            setSegDirection(chosen, bestRev);
            tour.push(chosen);
            curX = chosen.endX;
            curY = chosen.endY;
        }
    });

    // 同阶段相邻交换与端点翻转。
    let pass = 0;
    let improved = true;
    while (improved && pass++ < 80) {
        improved = false;
        // 翻转单条线段方向
        for (let i = 0; i < tour.length; i++) {
            const prevX = (i === 0) ? homeX : tour[i - 1].endX;
            const prevY = (i === 0) ? homeY : tour[i - 1].endY;
            const nextX = (i === tour.length - 1) ? tour[i].endX : tour[i + 1].startX;
            const nextY = (i === tour.length - 1) ? tour[i].endY : tour[i + 1].startY;

            const s = tour[i];
            const curDist = Math.hypot(s.startX - prevX, s.startY - prevY) +
                (i < tour.length - 1 ? Math.hypot(nextX - s.endX, nextY - s.endY) : 0);
            const flippedDist = Math.hypot(s.endX - prevX, s.endY - prevY) +
                (i < tour.length - 1 ? Math.hypot(nextX - s.startX, nextY - s.startY) : 0);

            if (flippedDist + 1e-4 < curDist) {
                setSegDirection(s, !s.isReversed);
                improved = true;
            }
        }
        // Match the server's adjacent-swap search, including the open route's free final endpoint.
        for (let i = 0; i + 1 < tour.length; i++) {
            const a = tour[i], b = tour[i + 1];
            if (a.stage !== b.stage) continue;
            const prev = i ? tour[i - 1] : {endX:homeX,endY:homeY};
            const next = tour[i + 2];
            const cost = (first, second) => Math.hypot(first.startX-prev.endX,first.startY-prev.endY)
                + Math.hypot(second.startX-first.endX,second.startY-first.endY)
                + (next ? Math.hypot(next.startX-second.endX,next.startY-second.endY) : 0);
            if (cost(b,a) + 1e-4 < cost(a,b)) {
                [tour[i],tour[i + 1]] = [b,a];
                improved = true;
            }
        }
    }

    let optAir = calcAir(tour);
    if (original.every((s,i) => !i || original[i - 1].stage <= s.stage) && origAir <= optAir + 1e-6) {
        tour = original;
        optAir = origAir;
    }
    const saved = Math.max(0, origAir - optAir);
    const cutLen = tour.reduce((sum, s) => sum + s.length, 0);

    let cx = homeX, cy = homeY;
    const finalCuts = tour.map((s, idx) => {
        const airDist = Math.hypot(s.startX - cx, s.startY - cy);
        cx = s.endX; cy = s.endY;
        return {
            ...s.original,
            step: idx + 1,
            type: s.original.type,
            pos: s.original.pos,
            start: s.original.start,
            end: s.original.end,
            startX: Math.round(s.startX * 10) / 10,
            startY: Math.round(s.startY * 10) / 10,
            endX: Math.round(s.endX * 10) / 10,
            endY: Math.round(s.endY * 10) / 10,
            airDistance: Math.round(airDist * 10) / 10,
            desc: s.original.desc
        };
    });

    return {
        success: true,
        startX: homeX,
        startY: homeY,
        originalAirDistance: Math.round(origAir * 10) / 10,
        optimizedAirDistance: Math.round(optAir * 10) / 10,
        savedAirDistance: Math.round(saved * 10) / 10,
        savingRatio: origAir > 0 ? Math.round((saved / origAir) * 1000) / 10 : 0,
        cutDistance: Math.round(cutLen * 10) / 10,
        totalDistance: Math.round((cutLen + optAir) * 10) / 10,
        optimizedCuts: finalCuts
    };
}

/**
 * 计算加工节拍与工时生产成本预估
 */
export function calculateCycleTime(data, stats) {
    const cuts = data.cuts || [];
    const pieces = data.pieces || [];
    const cutDist = stats ? stats.cutDistance : cuts.reduce((sum, c) => sum + (c.type === "横切" ? Math.abs((c.end || 0) - (c.start || 0)) : Math.abs((c.end || 0) - (c.start || 0))), 0);
    const airDist = stats ? (state.isToolpathOptimized ? stats.optimizedAirDistance : stats.originalAirDistance) : 10000;
    const cutCount = cuts.length;

    // 工业加工动力学参数 (标定)
    const cutFeedMmS = 4000 / 60;      // 66.7 mm/s (进给速度 4000 mm/min)
    const rapidFeedMmS = 15000 / 60;  // 250 mm/s (快移速度 15000 mm/min)
    const actionDelayS = 0.3;          // 提落刀延时 0.3s/次

    const tCut = cutDist / cutFeedMmS;
    const tRapid = airDist / rapidFeedMmS;
    const tAction = cutCount * actionDelayS;
    const totalSeconds = Math.round(tCut + tRapid + tAction + 2); // 包含 2 秒真空台吸附启动

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const cycleTimeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

    const uph = totalSeconds > 0 ? Math.round((3600 / totalSeconds) * Math.max(1, pieces.length)) : 0;

    return {
        cutDistance: cutDist,
        airDistance: airDist,
        cutCount: cutCount,
        tCut: Math.round(tCut),
        tRapid: Math.round(tRapid),
        totalSeconds: totalSeconds,
        cycleTimeStr: cycleTimeStr,
        uph: uph
    };
}

/**
 * 渲染刀路优化统计与控制条
 */
export function renderToolpathUI() {
    let container = document.getElementById("toolpath-stats-box");
    const parent = document.getElementById("card-cut-sequence");
    if (!parent) return;

    if (!container) {
        container = document.createElement("div");
        container.id = "toolpath-stats-box";
        container.className = "toolpath-control-card";
        const contentDiv = parent.querySelector(".section-content");
        if (contentDiv) {
            contentDiv.insertBefore(container, contentDiv.firstChild);
        }
    }

    const isOpt = state.isToolpathOptimized;
    const stats = state.toolpathStats;
    const data = state.getCurrentCaseData();
    const cycle = calculateCycleTime(data, stats);
    const originLabel = {'right-bottom':'右下角','right-top':'右上角','left-bottom':'左下角','left-top':'左上角'}[data.cutOrigin || 'right-bottom'];

    if (data.cuts == null || data.cuts.length === 0) {
        container.innerHTML = `
            <div style="font-size: 11px; color: var(--text-muted); text-align: center; padding: 6px; background: rgba(148, 163, 184, 0.05); border-radius: 4px;">
                机台就绪 · 待生成排料切序
            </div>
        `;
        return;
    }

    if (!isOpt || !stats) {
        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="font-size: 11px; color: var(--text-muted);">
                    起刀点: <b style="color: #f59e0b;">${originLabel}</b> | 状态: <span style="color:#94a3b8;">当前方案刀序</span>
                </div>
                <button class="tool-btn active" style="font-size: 10.5px; padding: 2px 8px; background: #0284c7;" onclick="window.camApp.toggleToolpathOptimization()">
                    优化空走刀
                </button>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div style="font-size: 11px; font-weight: bold; color: #10b981;">
                    ${stats.savedAirDistance > 0 ? '✓ 刀路已优化 (空程已压缩)' : '✓ 刀路已核对 (保留工艺顺序)'}
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="tool-btn" style="font-size: 10px; padding: 2px 6px; background: rgba(239, 68, 68, 0.12); color: #dc2626; border-color: rgba(239, 68, 68, 0.3);" onclick="window.camApp.toggleToolpathOptimization()">
                        恢复标准
                    </button>
                </div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 10.5px; background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 4px; padding: 4px 8px;">
                <div>
                    <span style="color: var(--text-muted);">空刀快移: </span>
                    <span style="text-decoration: line-through; color: #94a3b8;">${(stats.originalAirDistance/1000).toFixed(2)}m</span>
                    ➔ <b style="color: #10b981;">${(stats.optimizedAirDistance/1000).toFixed(2)}m</b>
                </div>
                <div>
                    <span style="color: var(--text-muted);">节省空程: </span>
                    <b style="color: #0284c7;">-${(stats.savedAirDistance/1000).toFixed(2)}m (${stats.savingRatio}%)</b>
                </div>
            </div>
        `;
    }
}
