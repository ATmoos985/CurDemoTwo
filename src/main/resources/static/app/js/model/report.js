// 适配层：候选方案的报工草稿与提交内容（/api/cutting/report-confirm）。纯函数，不发请求。
// 规则与后端 ReportOutput 一致：每件必须给出 合格 / 异常（须填原因）/ 未切；实切长度不短于已切裁片末端；
// 可回收料头 = 方案料头 + 未切裁片所在区域（UNCUT-编号），实测尺寸不得大于方案尺寸。

export const OUTCOMES = {QUALIFIED: '合格', REJECTED: '异常', UNCUT: '未切'};

/** 新草稿：全部合格，实切长度 = 方案拉布长度，方案料头默认回收。 */
export function defaultReport(seg, {remnant = false} = {}) {
    return {
        planId: seg.id, remnant,
        // 料头投料：后端要求实切长度为 0、不再回收料头（料头只使用一次）
        len: remnant ? 0 : Math.round(seg.len * 10) / 10,
        rows: Object.fromEntries(seg.pieces.map(p => [p.id, {outcome: 'QUALIFIED', reason: ''}])),
        rem: remnant ? {} : Object.fromEntries((seg.remnants || []).map(r => [r.id, {use: true, w: r.w, l: r.l}])),
        location: '现场料头架'
    };
}

/** 批量：全设合格 / 全设未切 / 实切长度之外的裁片标为未切。 */
export function applyBulk(report, kind, seg) {
    const rows = {...report.rows};
    for (const p of seg.pieces) {
        const end = p.u - seg.start + p.du;
        if (kind === 'all-qualified') rows[p.id] = {outcome: 'QUALIFIED', reason: ''};
        else if (kind === 'all-uncut') rows[p.id] = {outcome: 'UNCUT', reason: ''};
        else if (kind === 'beyond-uncut' && end > report.len + .001) rows[p.id] = {outcome: 'UNCUT', reason: ''};
    }
    return {...report, rows};
}

/** 可回收料头候选：方案料头 + 未切裁片区域（只取实切长度以内的部分）。 */
export function recoveryCandidates(seg, report) {
    if (report.remnant) return [];
    const list = (seg.remnants || []).map(r => ({id: r.id, x: r.x, y: r.y, w: r.w, l: r.l, hasDefect: !!r.hasDefect, source: '方案料头'}));
    for (const p of seg.pieces) {
        if (report.rows[p.id]?.outcome !== 'UNCUT') continue;
        const y = p.u - seg.start, l = Math.min(y + p.du, report.len) - y;
        if (l > 0) list.push({id: 'UNCUT-' + p.id, x: p.v, y, w: p.dv, l, hasDefect: false, source: '未切区域'});
    }
    return list;
}

export function reportSummary(seg, report) {
    const count = k => seg.pieces.filter(p => report.rows[p.id]?.outcome === k).length;
    const cutEnd = Math.max(0, ...seg.pieces.filter(p => report.rows[p.id]?.outcome !== 'UNCUT').map(p => p.u - seg.start + p.du));
    return {qualified: count('QUALIFIED'), rejected: count('REJECTED'), uncut: count('UNCUT'), cutEnd};
}

/** 校验草稿，返回问题列表（空表示可提交）。 */
export function reportProblems(seg, report, bedLength = seg.len) {
    const problems = [], s = reportSummary(seg, report);
    if (!report.remnant) {
        if (!(report.len > 0)) problems.push('请填写实切长度');
        if (report.len > bedLength + .001) problems.push(`实切长度不能超过本工位拉布长度 ${Math.round(bedLength)} mm`);
        if (report.len + .001 < s.cutEnd) problems.push(`实切长度短于已切裁片末端 ${Math.round(s.cutEnd * 10) / 10} mm，请把末端以外的裁片标为未切`);
    }
    for (const p of seg.pieces) {
        const r = report.rows[p.id];
        if (!r) problems.push(`裁片 ${p.id} 未填写结果`);
        else if (r.outcome === 'REJECTED' && !r.reason.trim()) problems.push(`异常裁片 ${p.id} 须填写原因`);
    }
    const cands = new Map(recoveryCandidates(seg, report).map(c => [c.id, c]));
    for (const [id, r] of Object.entries(report.rem)) {
        if (!r.use) continue;
        const c = cands.get(id);
        if (!c) { problems.push(`料头 ${id} 已不在可回收范围`); continue; }
        if (!(r.w > 0 && r.l > 0)) problems.push(`料头 ${id} 实测尺寸须大于 0`);
        else if (r.w > c.w + .001 || r.l > c.l + .001) problems.push(`料头 ${id} 实测尺寸不能大于 ${Math.round(c.w)}×${Math.round(c.l)} mm`);
    }
    return problems;
}

export function buildCutReport(seg, report) {
    const s = reportSummary(seg, report);
    const cands = new Map(recoveryCandidates(seg, report).map(c => [c.id, c]));
    return {
        planId: report.planId,
        actualCutLen: report.remnant ? 0 : report.len,
        finishedPieceCount: s.qualified,
        location: report.location?.trim() || '现场料头架',
        pieceResults: seg.pieces.map(p => ({pieceId: p.id, outcome: report.rows[p.id].outcome, reason: report.rows[p.id].outcome === 'REJECTED' ? report.rows[p.id].reason.trim() : ''})),
        actualRemnants: Object.entries(report.rem).filter(([id, r]) => r.use && cands.has(id))
            .map(([id, r]) => ({id, status: cands.get(id).source, x: cands.get(id).x, y: cands.get(id).y, w: Number(r.w), l: Number(r.l),
                area: Number(r.w) * Number(r.l) / 1e6, hasDefect: cands.get(id).hasDefect}))
    };
}
