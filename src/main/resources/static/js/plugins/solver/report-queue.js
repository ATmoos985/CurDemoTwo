import {state} from '../../core/state.js';

// shortcut: 待报工只保存在当前浏览器，需要跨设备接力时改为服务端暂存。
const key = taskId => 'cutting-report-queue-' + taskId;
export function loadReportQueue(taskId, storage = localStorage) {
    const rows = JSON.parse(storage.getItem(key(taskId)) || '[]');
    if (!Array.isArray(rows) || rows.some(row => row.pending?.taskId !== taskId || !row.report?.planId))
        throw new Error('本机待报工记录无法读取，请保留浏览器数据并核对方案记录。');
    return rows;
}
export function saveReportQueue(taskId, rows, storage = localStorage) {
    try {storage.setItem(key(taskId), JSON.stringify(rows));}
    catch {throw new Error('本机暂存失败，当前工位已保留。请保留页面，可直接报工后继续。');}
}
export function queuedReports() {
    const reported = new Set((state.taskReports || []).map(r => r.planId));
    return (state.reportQueue || []).filter(row => row.pending.taskId === state.activeTask?.id && !reported.has(row.report.planId));
}
export function queuedQuantities(rows = queuedReports()) {
    const quantities = {};
    for (const {pending,report} of rows) {
        const outcomes = new Map(report.pieceResults.map(p => [p.pieceId,p.outcome]));
        for (const p of pending.result.pieces) if (outcomes.get(p.id) === 'QUALIFIED')
            quantities[p.demandId] = (quantities[p.demandId] || 0) + 1;
    }
    return quantities;
}
export function queuedRollEnd(rollId, rows = queuedReports()) {
    return Math.max(0,...rows.filter(r => r.pending.feedPortType === 'roll' && r.pending.rollId === rollId)
        .map(r => r.pending.windowStartY + r.report.actualCutLen));
}
export function queuedStockLength(rollId, rows = queuedReports()) {
    return rows.filter(r => r.pending.feedPortType === 'roll' && r.pending.rollId === rollId).reduce((sum,r) => sum + r.report.actualCutLen,0);
}
export function queueEntry(pending, report) {
    const {taskId,result,request,rollId,feedPortType,sourceRemnantId,windowStartY,bedL,reportRecovery} = pending;
    return structuredClone({pending:{taskId,result,request,rollId,feedPortType,sourceRemnantId,windowStartY,bedL,reportRecovery},report});
}
