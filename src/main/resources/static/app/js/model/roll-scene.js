// 适配层：把任务的方案版本与母卷档案转换为画布场景。纯函数，不发请求。
// 方案坐标：件与疵点的 y 相对工位起点（request.windowStartY），x 为幅宽方向；母卷疵点 y 为整卷坐标。
import {effectivePieceResults} from './quality.js';

export const PIECE_PALETTE = ['#5f87b0', '#7f9d6e', '#b8925a', '#9a7aa0', '#5f9a96', '#a8735f', '#7a86b8', '#8f9a5a', '#b07a8f', '#5a8fb0'];
export const SEGMENT_TINTS = ['#47627d', '#4d6b55', '#6b5a43', '#5d4f66', '#3f6563'];
export const OUTPUT_STYLES = {
    QUALIFIED: {label: '合格', color: '#4c956c'}, REJECTED: {label: '异常', color: '#c0392b'},
    SCRAP: {label: '复检报废', color: '#a4504a'}, REMNANT: {label: '复检转料头', color: '#bd9454'}
};

/** 需求名称与颜色：方案请求里的需求可能与任务当前版本不同，两者合并（任务优先）。 */
export function demandIndex(demands = [], plans = []) {
    const all = new Map();
    for (const d of demands) all.set(d.id, d.name);
    for (const p of plans) for (const d of p.request?.demands || []) if (!all.has(d.id)) all.set(d.id, d.name);
    return new Map([...all].map(([id, name], i) => [id, {name: name || `需求 ${id}`, color: PIECE_PALETTE[i % PIECE_PALETTE.length]}]));
}
export function demandColors(demands = [], plans = []) {
    return new Map([...demandIndex(demands, plans)].map(([id, v]) => [id, v.color]));
}

/**
 * 有效报工 → 已切（固定）；PENDING → 候选（可报工）；
 * CONFIRMED 但无报工 → 已失效：后端只在报工时置 CONFIRMED，演示“重置母卷”会删除报工而保留方案状态，这类方案既未切也不能再报工。
 */
export function segmentStatus(plan, reportedPlanIds = new Set()) {
    if (reportedPlanIds.has(plan.id)) return 'cut';
    return plan.status === 'PENDING' ? 'pending' : plan.status === 'CONFIRMED' ? 'stale' : 'other';
}
export const STATUS_TEXT = {cut: '已切', pending: '候选', stale: '已失效', other: '—'};
const live = s => s.status === 'cut' || s.status === 'pending';

/** 有效报工（未冲销）对应的方案。 */
export function reportedPlans(reports = []) {
    return new Set(reports.filter(r => r.status !== 'REVERSED' && r.planId).map(r => r.planId));
}

/** 某卷上的有效方案（排除已取消），按工位起点排序。 */
export function plansOnRoll(plans, rollId) {
    return (plans || []).filter(p => !['CANCELLED', 'REVERSED'].includes(p.status) && p.request?.rollId === rollId
            && p.request?.feedPortType !== 'remnant' && !p.request?.sourceRemnantId)
        .sort((a, b) => (a.request.windowStartY || 0) - (b.request.windowStartY || 0));
}

/** 某块料头上的有效方案（料头整块投料，只有一段）。 */
export function plansOnRemnant(plans, remnantId) {
    return (plans || []).filter(p => !['CANCELLED', 'REVERSED'].includes(p.status) && p.request?.sourceRemnantId === remnantId);
}

/** 料头视为一段短“母卷”：幅宽 × 长度，疵点为料头自身坐标，整块一个工位。 */
export function remnantAsRoll(stock) {
    return {rollId: stock.id, rollModel: stock.materialBatch, width: stock.width, totalLength: stock.length, usedLength: 0,
        currentRemainingLength: stock.status === 'AVAILABLE' ? stock.length : 0, defects: stock.defects || [], remnant: stock};
}

/** 任务涉及的母卷，最近的方案在前。 */
export function rollsOfPlans(plans) {
    const seen = [];
    for (const p of [...(plans || [])].filter(p => !['CANCELLED', 'REVERSED'].includes(p.status) && p.request?.feedPortType !== 'remnant' && !p.request?.sourceRemnantId).reverse())
        if (p.request?.rollId && !seen.includes(p.request.rollId)) seen.push(p.request.rollId);
    return seen;
}

export function planSegment(plan, colors = new Map(), index = 0, reported = new Set()) {
    const req = plan.request || {}, res = plan.result || {};
    const start = Number(req.windowStartY) || 0;
    const len = Number(res.deductLen) > 0 ? Number(res.deductLen) : Number(req.rollL) || 0;
    return {
        id: plan.id,
        start, len,
        status: segmentStatus(plan, reported),
        planStatus: plan.status,
        version: plan.version,
        label: `第 ${index + 1} 次拉布 · v${plan.version ?? 1}`,
        tint: SEGMENT_TINTS[index % SEGMENT_TINTS.length],
        bedLength: Number(req.rollL) || len,
        pieces: (res.pieces || []).map(p => ({
            id: p.id, demandId: p.demandId,
            u: start + p.y, v: p.x, du: p.l, dv: p.w,
            // 结果轮廓已经旋转，保持局部毫米坐标，不再次应用 rotated。
            shape: p.shape ? structuredClone(p.shape) : {type: 'RECTANGLE', width: p.w, height: p.l},
            label: `${Math.round(p.w)}×${Math.round(p.l)}`,
            title: `${p.name || '裁片'} · ${p.w}×${p.l} mm${p.rotated ? ' · 旋转' : ''}`,
            color: colors.get(p.demandId) || PIECE_PALETTE[0]
        })),
        cuts: (res.cuts || []).filter(c => [c.startX, c.startY, c.endX, c.endY].every(Number.isFinite))
            .map(c => ({u1: start + c.startY, v1: c.startX, u2: start + c.endY, v2: c.endX, type: c.type, step: c.step})),
        remnants: (res.remnants || []).map(r => ({id: r.id, x: r.x, y: r.y, w: r.w, l: r.l, hasDefect: !!r.hasDefect, status: r.status,
            shape: r.shape ? structuredClone(r.shape) : {type: 'RECTANGLE', width: r.w, height: r.l}})),
        pieceArea: Number(res.pieceArea) || 0,
        totalArea: Number(res.totalArea) || 0,
        fulfillment: res.fulfillment || [],
        engine: res.engine, fallbackReason: res.fallbackReason
    };
}

const located = p => [p.x, p.y, p.w, p.l].every(Number.isFinite) && p.w > 0 && p.l > 0;
const outline = p => p.shape ? structuredClone(p.shape) : {type: 'RECTANGLE', width: p.w, height: p.l};

/** 已记账段只投影回执；原始报工与复检事件保持不变，未切裁片不是已生产的裁片。 */
function recordedSegment(seg, report) {
    const start = Number.isFinite(report.windowStartY) ? report.windowStartY : seg.start;
    const len = Number.isFinite(report.actualCutLen) ? report.actualCutLen : seg.len;
    const hasDetails = Array.isArray(report.pieceResults);
    const events = new Map((report.qualityDispositions || []).map(e => [e.command.pieceId, e]));
    const original = new Map((report.pieceResults || []).map(p => [p.pieceId, p]));
    const cut = effectivePieceResults(report).filter(p => p.outcome !== 'UNCUT');
    const pieces = hasDetails ? cut.filter(located).map(p => {
        const disposition = events.get(p.pieceId)?.command.disposition;
        const style = OUTPUT_STYLES[disposition || p.outcome] || {label: '结果未知', color: '#69737d'};
        return {id: p.pieceId, demandId: p.demandId, u: start + p.y, v: p.x, du: p.l, dv: p.w, shape: outline(p),
            originalOutcome: original.get(p.pieceId)?.outcome, outcome: p.outcome, disposition,
            label: `${style.label} · ${Math.round(p.w)}×${Math.round(p.l)}`, color: style.color,
            title: `${p.name || '裁片'} · ${style.label}${p.reason ? ' · ' + p.reason : ''}`};
    }) : seg.pieces.map(p => ({...p, label: `计划 · ${p.label}`, title: `历史回执缺少逐件记录 · ${p.title}`,
        color: '#69737d', dash: [5, 4], opacity: .4}));
    const recovered = (report.recoveredGeometry || []).filter(located).map(r => ({...r, shape: outline(r),
        label: `报工回收 ${r.id}`, color: '#405950', stroke: r.hasDefect ? '#e1b86e' : '#8fbea5'}));
    for (const event of events.values()) {
        const r = event.command.recovery, p = original.get(event.command.pieceId);
        if (event.command.disposition !== 'REMNANT' || !event.remnantId || !r || !p || !located(p)) continue;
        recovered.push({id: event.remnantId, x: p.x + r.x, y: p.y + r.y, w: r.width, l: r.length,
            shape: {type: 'RECTANGLE', width: r.width, height: r.length},
            label: `复检回收 ${event.remnantId}${r.quality === 'QUARANTINED' ? ' · 待检' : ''}`,
            color: '#6b573b', stroke: '#e1b86e'});
    }
    const missing = cut.length - pieces.length;
    return {...seg, start, len, pieces, remnants: recovered, cuts: [], opacity: .95,
        caption: `实切 ${len} mm`,
        outputNote: !hasDetails ? '历史回执缺少逐件记录，虚线裁片仅为原计划。'
            : missing > 0 ? `${missing} 条裁片缺少定位信息，未绘制；未切裁片仅在回执中计数。`
                : '画布显示当前产出与回收登记；未切裁片仅在回执中计数。',
        pieceArea: report.netPieceArea ?? report.pieceArea ?? seg.pieceArea,
        totalArea: report.usedArea ?? seg.totalArea};
}

export function rollDefects(roll, fresh = []) {
    const base = (roll?.defects || []).map(d => ({
        id: d.id, u: d.y, v: d.x, du: d.h, dv: d.w, margin: d.margin || 0,
        label: `${d.typeName || d.defectType || '疵点'} · Y ${(d.y / 1000).toFixed(2)} m`, fresh: false, source: d.detectionSource
    }));
    return base.concat(fresh.map(d => ({...d, fresh: true})));
}

/** 验疵仍使用同一母卷毫米坐标；已入档记录只读，本机草稿允许画布编辑。 */
export function buildInspectionScene(roll, pending = [], position = 0, selected = null) {
    const defects = [
        ...(roll.defects || []).map(d => ({...d, key: `saved-${d.id}`, editable: false})),
        ...pending.map(d => ({...d, key: d.captureId, editable: true}))
    ].map(d => ({id: d.key, u: d.y, v: d.x, du: d.h, dv: d.w, margin: d.margin || 0,
        label: d.typeName || d.defectType || '疵点', fresh: d.editable, editable: d.editable}));
    return {roll: {id: roll.rollId, width: roll.width, total: roll.totalLength, used: roll.usedLength || 0},
        segments: [], defects, currentId: null, window: null, selectedDefect: selected,
        feed: {u: position, fromRight: true}};
}

/** 已切段末端：工位不能移入此前区域。 */
export function cutEnd(segments, used = 0) {
    return segments.filter(s => s.status === 'cut').reduce((m, s) => Math.max(m, s.start + s.len), used);
}

/** selectedId = NEW_STATION 表示对准最后一段有效拉布之后的新工位。 */
export const NEW_STATION = '__new__';

export function buildRollScene({roll, plans, reports = [], rollId, demands, process, freshDefects = [], selectedId = null, window: manual = null}) {
    const colors = demandColors(demands, plans);
    const isRemnant = !!roll?.remnant;
    const list = isRemnant ? plansOnRemnant(plans, roll.remnant.id) : plansOnRoll(plans, rollId);
    const reported = reportedPlans(reports);
    const receipts = new Map(reports.filter(r => r.status !== 'REVERSED').map(r => [r.planId, r]));
    const segments = list.map((p, i) => {
        const seg = planSegment(p, colors, i, reported);
        return receipts.has(p.id) ? recordedSegment(seg, receipts.get(p.id)) : seg;
    });
    const total = Number(roll?.totalLength) || Math.max(...segments.map(s => s.start + s.len), 1);
    const used = Math.min(Number(roll?.usedLength) || 0, total);
    const lock = Math.max(cutEnd(segments, 0), used);
    const bed = Number(process?.bedLength) || 5000;
    const liveEnd = segments.filter(live).reduce((m, s) => Math.max(m, s.start + s.len), 0);
    const fresh = {start: Math.max(liveEnd, used), len: Math.max(0, Math.min(bed, total - Math.max(liveEnd, used)))};
    const current = selectedId === NEW_STATION ? null
        : segments.find(s => s.id === selectedId) || segments.find(s => s.status === 'pending') || null;
    // 料头整块投料：工位固定为 0 → 料头长度，不可拖动或改长度
    const base = isRemnant ? {start: 0, len: total} : current ? {start: current.start, len: current.len} : fresh;
    const win = manual && !isRemnant ? {...manual} : {...base};
    win.adjusted = !!manual && (Math.abs(manual.start - base.start) > .5 || Math.abs(manual.len - base.len) > .5);
    win.isNew = !current;
    return {
        roll: {id: rollId, width: Number(roll?.width) || Number(list[0]?.request?.rollW) || 0, total, used,
            shape: roll?.remnant?.shape ? structuredClone(roll.remnant.shape) : null},
        segments, defects: rollDefects(roll, freshDefects),
        currentId: current?.id || null, window: win, lock,
        bed: isRemnant ? null : {min: 500, max: Math.max(bed, 6000)},
        fixed: isRemnant, remnant: isRemnant ? roll.remnant : null
    };
}

export function sceneMetrics(scene) {
    const valid = scene.segments.filter(live);
    const area = valid.reduce((a, s) => a + s.pieceArea, 0);
    const total = valid.reduce((a, s) => a + s.totalArea, 0);
    return {
        utilization: total > 0 ? area / total * 100 : 0,
        length: valid.reduce((a, s) => a + s.len, 0),
        spreads: valid.length,
        cut: scene.segments.filter(s => s.status === 'cut').length,
        pending: scene.segments.filter(s => s.status === 'pending').length,
        stale: scene.segments.filter(s => s.status === 'stale').length
    };
}
