// 适配层：报工回执的复检处置。复用经典 quality-review 的口径（可复检件、复检后的有效结果），纯函数。
// 后端 QualityDisposition.Command：每次处置一件；转料头须给出相对裁片左上角的回收矩形与库位。
export {reviewablePieces, effectivePieceResults} from '../../../js/business/cutting/quality-review.js';

export const DISPOSITIONS = {SCRAP: '报废', REMNANT: '转料头'};

export function emptyQualityForm(report, pieceId) {
    return {pieceId, disposition: 'SCRAP', inspector: '', reason: '', x: 0, y: 0, width: '', length: '', location: '', quality: 'QUARANTINED', report};
}

export function qualityProblems(form, piece) {
    const p = [];
    if (!piece) p.push('请选择要处置的裁片');
    if (!form.inspector.trim()) p.push('请填写检验人');
    if (!form.reason.trim()) p.push('请填写复检原因');
    if (form.disposition === 'REMNANT') {
        const [x, y, w, l] = [form.x, form.y, form.width, form.length].map(Number);
        if (!(x >= 0 && y >= 0 && w > 0 && l > 0)) p.push('回收矩形的起点不能为负，宽度和长度须大于 0');
        else if (piece && (x + w > piece.w + .001 || y + l > piece.l + .001)) p.push(`回收矩形超出裁片 ${piece.w}×${piece.l} mm`);
        if (!form.location.trim()) p.push('请填写回收料头库位');
    }
    return p;
}

/** 生成不可变命令；operationId 由调用方在首次提交时生成，结果不确定时原样重发。 */
export function buildQualityCommand(form, operationId) {
    const r = form.report;
    return {operationId, expectedRevision: r.qualityRevision ?? (r.qualityDispositions || []).length, pieceId: Number(form.pieceId),
        disposition: form.disposition, inspector: form.inspector.trim(), reason: form.reason.trim(),
        recovery: form.disposition === 'REMNANT' ? {x: Number(form.x), y: Number(form.y), width: Number(form.width), length: Number(form.length),
            location: form.location.trim(), quality: form.quality} : null};
}

/** 回执摘要：按复检后的有效结果统计。 */
export function receiptSummary(report, effective) {
    const rows = effective(report);
    return {qualified: rows.filter(p => p.outcome === 'QUALIFIED').length, rejected: rows.filter(p => p.outcome === 'REJECTED').length,
        uncut: rows.filter(p => p.outcome === 'UNCUT').length, dispositions: (report.qualityDispositions || []).length};
}
