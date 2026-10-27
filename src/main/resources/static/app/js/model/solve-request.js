// 适配层：由任务、母卷与工位窗口组装排料请求（与经典工作台同一接口 /api/solve）。纯函数，不发请求。
import {windowDefects} from '../../../js/business/cutting/forward-search.js';

/** 每项需求的剩余待排数量 = 需求数 − 已完成 − 已预约。 */
export function remainingDemands(task, completed = {}, reserved = {}) {
    return (task.demands || []).map(d => ({
        id: d.id, name: d.name, width: d.width, length: d.length, shape: d.shape ?? null, allowRotation: !!d.allowRotation,
        demand: Math.max(0, d.quantity - (completed[d.id] || completed[String(d.id)] || 0) - (reserved[d.id] || reserved[String(d.id)] || 0))
    })).filter(d => d.demand > 0);
}

/** 工位窗口是否落在母卷可用范围内；返回问题说明，合法时返回 null。 */
export function windowProblem(roll, win) {
    if (!roll || !win) return '未选择母卷或工位';
    if (roll.remnant) {
        if (roll.remnant.status !== 'AVAILABLE') return '该料头已不可用（已使用、报废或隔离）';
        return win.start === 0 && Math.abs(win.len - roll.totalLength) < .001 ? null : '料头须整块投料';
    }
    if (!(win.len > 0)) return '拉布长度须大于 0';
    if (win.start < (roll.usedLength || 0) - .001) return `工位起点不能早于已用长度 ${(roll.usedLength / 1000).toFixed(2)} m`;
    if (win.start + win.len > roll.totalLength + .001) return '工位超出卷尾';
    const remaining = roll.currentRemainingLength ?? (roll.totalLength - roll.usedLength);
    if (win.len > remaining + .001) return `拉布长度超过母卷剩余 ${(remaining / 1000).toFixed(2)} m`;
    return null;
}

export function buildSolveRequest({task, roll, win, completed, reserved, settings = {}}) {
    const p = task.process || {}, stock = roll.remnant;
    // 料头投料：整块为一个工位，母卷编号取料头来源母卷，型号取料头批次（后端据此核对）
    const feed = stock ? {rollId: stock.sourceRollId, rollModel: stock.materialBatch, rollW: stock.width, rollL: stock.length,
        totalRollL: stock.length, windowStartY: 0, feedPortType: 'remnant', sourceRemnantId: stock.id,
        defects: windowDefects(stock.defects || [], 0, stock.length, stock.width)} : null;
    return {
        minRemnantWidth: settings.minRemnantWidth ?? 200,
        minRemnantLength: settings.minRemnantLength ?? 300,
        timeLimitSeconds: settings.timeLimitSeconds ?? 3,
        taskId: task.id, taskRevision: task.revision,
        rollId: roll.rollId, rollModel: roll.rollModel,
        rollW: roll.width, rollL: win.len, totalRollL: roll.totalLength, windowStartY: win.start,
        trimStart: p.trimStart ?? 0, pieceGap: p.pieceGap ?? 0,
        cutOrigin: p.cutOrigin || 'right-bottom', firstStageOrientation: p.firstStageOrientation || 'horizontal',
        allowRotation: !!p.allowRotation, allowLongitudinal: p.allowLongitudinal !== false,
        feedPortType: 'roll', sourceRemnantId: null, solver: 'packingsolver',
        defects: windowDefects(roll.defects || [], win.start, win.len, roll.width),
        demands: remainingDemands(task, completed, reserved),
        ...(feed || {})
    };
}

/** 求解结果是否为可用方案（与经典工作台同一判定）。 */
export function usablePlan(result) {
    return !!(result?.success && result.planId && result.pieces?.length && Array.isArray(result.cuts) && Array.isArray(result.remnants));
}
