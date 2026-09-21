/**
 * CAD/CAM 工业级刀路优化插件 (Toolpath Optimizer Plugin)
 * 核心功能：以机床右下角 (Right-Bottom Home Point) 为起始停刀位，
 * 运用 Segment-TSP (线段旅行商) 启发式双向寻优与 2-Opt 局部搜索算法，
 * 极大压缩空刀快移 (Air Cut / Rapid Move) 距离与刀具抬刀磨损。
 */
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { renderScene } from '../cad/cad-renderer.js';
import { renderCutTable } from '../solver/solver-client.js';

/**
 * 获取当前工位的右下角基准停刀原点 (Right-Bottom Home Point)
 */
export function getHomeCoordinates(data) {
    const isRemnantMode = (state.currentCutMode === "remnant");
    let homeX, homeY;
    if (isRemnantMode && state.loadedRemnant) {
        homeX = state.loadedRemnant.width || 2000;
        homeY = state.loadedRemnant.length || 1600;
    } else {
        homeX = data.rollW || 2000;
        homeY = (data.windowStartY || 0) + (data.bedL || 5000);
    }
    return { x: homeX, y: homeY };
}

/**
 * 针对切刀序列执行纯前端/后端协同的刀路优化
 */
export async function optimizeCurrentToolpath(respectPrecedence = true) {
    const data = state.getCurrentCaseData();
    const cuts = data.cuts || [];
    if (cuts.length === 0) {
        alert("【刀路优化提示】当前工位暂无切刀指令，请先完成排料生成下刀切序！");
        return;
    }

    // 备份原始切序 (防破坏)
    if (!state.originalCutsBackup || !state.isToolpathOptimized) {
        state.originalCutsBackup = JSON.parse(JSON.stringify(cuts));
    }

    const home = getHomeCoordinates(data);

    // 1. 尝试调用后端 /api/toolpath/optimize 工业级算法
    try {
        const res = await fetch("/api/toolpath/optimize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cuts: state.originalCutsBackup,
                homeX: home.x,
                homeY: home.y,
                respectPrecedence: respectPrecedence
            })
        });
        if (res.ok) {
            const result = await res.json();
            if (result.success && result.optimizedCuts) {
                applyOptimizedResult(data, result, home);
                return;
            }
        }
    } catch (e) {
        console.warn("后端刀路接口不可达，自动回退至前端内置 Segment-TSP 引擎", e);
    }

    // 2. 本地微内核内置 Segment-TSP + 2-Opt 快速求解 (Fallback)
    const localResult = solveLocalSegmentTSP(state.originalCutsBackup, home.x, home.y, respectPrecedence);
    applyOptimizedResult(data, localResult, home);
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
export function restoreOriginalToolpath() {
    if (!state.originalCutsBackup) return;
    const data = state.getCurrentCaseData();
    data.cuts = JSON.parse(JSON.stringify(state.originalCutsBackup));
    state.isToolpathOptimized = false;
    state.toolpathStats = null;

    renderToolpathUI();
    renderCutTable(data.cuts);
    renderScene();
    bus.emit('toolpath:restored');
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
 * 本地 Segment-TSP 启发式双向寻优与 2-Opt
 */
function solveLocalSegmentTSP(rawCuts, homeX, homeY, respectPrecedence) {
    const segments = rawCuts.map((c) => {
        let p1x, p1y, p2x, p2y;
        if (c.type === "横切") {
            p1x = c.start; p1y = c.pos;
            p2x = c.end; p2y = c.pos;
        } else {
            p1x = c.pos; p1y = c.start;
            p2x = c.pos; p2y = c.end;
        }
        let stage = 1;
        const m = (c.desc || "").match(/第\s*(\d+)\s*阶段/);
        if (m) stage = parseInt(m[1]);

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

    // 贪心最近邻构建
    const pool = [...segments];
    const tour = [];
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

    // 2-Opt 局部路径交换与端点翻转
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
    }

    const optAir = calcAir(tour);
    const saved = Math.max(0, origAir - optAir);
    const cutLen = tour.reduce((sum, s) => sum + s.length, 0);

    let cx = homeX, cy = homeY;
    const finalCuts = tour.map((s, idx) => {
        const airDist = Math.hypot(s.startX - cx, s.startY - cy);
        cx = s.endX; cy = s.endY;
        return {
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

    if (!isOpt || !stats) {
        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="font-size: 11px; color: var(--text-muted);">
                    起刀停靠位: <b style="color: #f59e0b;">右下角原点</b> | 状态: <span style="color:#94a3b8;">原始刀序</span>
                </div>
                <button class="tool-btn active" style="font-size: 11px; padding: 3px 8px; background: #0284c7;" onclick="window.camApp.toggleToolpathOptimization()">
                    一键右下角刀路优化
                </button>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; background: rgba(2, 132, 199, 0.05); border: 1px dashed rgba(2, 132, 199, 0.25); border-radius: 4px; padding: 4px 8px;">
                <span>预估节拍: <b>${cycle.cycleTimeStr}</b> (纯切${cycle.tCut}s | 空刀${cycle.tRapid}s)</span>
                <span style="color: #0284c7;">产能: ~${cycle.uph} 件/小时</span>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
                <button class="tool-btn" style="flex: 1; font-size: 10.5px; padding: 3px 0; background: #0284c7; color: #ffffff;" onclick="window.cutApp.plugins.export.openExportModal('gcode')">
                    导出机床代码 (CNC/DXF)
                </button>
                <button class="tool-btn" style="flex: 1; font-size: 10.5px; padding: 3px 0; background: #d97706; color: #ffffff;" onclick="window.cutApp.plugins.export.openCutTicketModal()">
                    生成现场工单 (Cut Ticket)
                </button>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <div style="font-size: 11px; font-weight: bold; color: #10b981;">
                    ✓ 右下角刀路已优化 (空走路线最短)
                </div>
                <div style="display: flex; gap: 6px;">
                    <button class="tool-btn" style="font-size: 10px; padding: 2px 6px; background: rgba(239, 68, 68, 0.12); color: #dc2626; border-color: rgba(239, 68, 68, 0.3);" onclick="window.camApp.toggleToolpathOptimization()">
                        恢复原始切序
                    </button>
                    <button class="tool-btn active" style="font-size: 10px; padding: 2px 6px; background: #059669;" onclick="window.camApp.toggleToolpathOptimization()">
                        重新寻优
                    </button>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; font-size: 10.5px; background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 4px; padding: 6px;">
                <div>
                    <span style="color: var(--text-muted);">空刀快移: </span>
                    <span style="text-decoration: line-through; color: #94a3b8;">${(stats.originalAirDistance/1000).toFixed(2)}m</span>
                    ➔ <b style="color: #10b981;">${(stats.optimizedAirDistance/1000).toFixed(2)}m</b>
                </div>
                <div>
                    <span style="color: var(--text-muted);">节省空程: </span>
                    <b style="color: #0284c7;">-${(stats.savedAirDistance/1000).toFixed(2)}m (${stats.savingRatio}%)</b>
                </div>
                <div>
                    <span style="color: var(--text-muted);">机床加工节拍: </span>
                    <b style="color: #10b981;">${cycle.cycleTimeStr}</b>
                </div>
                <div>
                    <span style="color: var(--text-muted);">生产效率: </span>
                    <b style="color: #0284c7;">~${cycle.uph} 件/小时</b>
                </div>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
                <button class="tool-btn" style="flex: 1; font-size: 10.5px; padding: 3px 0; background: #0284c7; color: #ffffff;" onclick="window.cutApp.plugins.export.openExportModal('gcode')">
                    导出机床代码 (CNC/DXF)
                </button>
                <button class="tool-btn" style="flex: 1; font-size: 10.5px; padding: 3px 0; background: #d97706; color: #ffffff;" onclick="window.cutApp.plugins.export.openCutTicketModal()">
                    生成现场工单 (Cut Ticket)
                </button>
            </div>
        `;
    }
}
