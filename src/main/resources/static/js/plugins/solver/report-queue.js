import {state} from '../../core/state.js';
import {layoutMetrics} from './material-accounting.js';
import {reportRecoveryCandidates} from './report-outcomes.js';

// 暂存默认采用当前方案；打开实切核对后保留操作者的修改。
export function stationReport(pending) {
    const {result, request, bedL, feedPortType} = pending;
    const minW = request.minRemnantWidth ?? 200, minL = request.minRemnantLength ?? 300;
    const recoverable = (result.remnants || []).filter(r => r.w >= minW && r.l >= minL);
    const defaultLength = Math.max(result.deductLen || 0, layoutMetrics({rollW:request.rollW, bedL, pieces:result.pieces, remnants:recoverable, cuts:result.cuts}).deductLen) || bedL;
    const actualCutLen = feedPortType === 'remnant' ? 0 : pending.reportActualCutLen ?? defaultLength;
    const pieceResults = pending.reportPieceResults || result.pieces.map(p => ({pieceId:p.id,outcome:'QUALIFIED',reason:''}));
    const actualRemnants = feedPortType === 'remnant' ? [] : reportRecoveryCandidates(result,pieceResults,actualCutLen).flatMap(r => {
        const saved = pending.reportRecovery?.[r.id];
        const checked = saved?.checked ?? (!r.uncut && r.w >= minW && r.l >= minL);
        return checked ? [{...r,w:saved?.w ?? r.w,l:saved?.l ?? r.l}] : [];
    });
    return {planId:result.planId,actualCutLen,pieceResults,actualRemnants,
        finishedPieceCount:pieceResults.filter(p => p.outcome === 'QUALIFIED').length,
        location:pending.reportLocation ?? '现场料头架 A-01'};
}

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
