// 适配层：一维分切任务。纯函数，不发请求。
// 一维 = 定长二维：分切组合的一次重复是一“车”，即母卷上长度为“切头 + 卷长”的工位，条沿幅宽从左切边起依次排开。
import {windowDefects} from '../../../js/business/cutting/forward-search.js';
import {buildSolveRequest} from './solve-request.js';

export const SLITTING = 'SLITTING_1D';
export const isSlitting = task => task?.problemType === SLITTING;
export const DEFAULT_SLITTING = {leftTrim: 10, rightTrim: 10, minWidth: 0, maxWidth: 0, widthStep: 10, totalOverCap: 0};

/** 一维任务参数问题（保存前校验，与后端规则一致）；无问题返回 null。 */
export function slittingProblems(s, demands = []) {
    const int = v => Number.isInteger(Number(v));
    if (![s.leftTrim, s.rightTrim, s.minWidth, s.maxWidth, s.widthStep, s.totalOverCap].every(int)) return '切边、组合宽度、步长与超产上限须为整数';
    if (s.leftTrim < 0 || s.rightTrim < 0) return '切边不能为负';
    if (!(s.minWidth > 0) || s.maxWidth < s.minWidth) return '组合宽度下限须大于 0 且不大于上限';
    if (!(s.widthStep > 0) || (s.maxWidth - s.minWidth) / s.widthStep > 1000) return '步长须为正，候选宽度不超过 1001 个';
    if (s.totalOverCap < 0 || s.totalOverCap > 10000) return '超产上限须在 0–10000 卷';
    const bad = demands.find(d => !int(d.width) || d.width > s.maxWidth || !int(d.length) || d.length % 1000 !== 0 || d.length > 1_000_000);
    return bad ? `需求「${bad.name || bad.id}」：分切宽度须为整数且不超过组合上限，卷长须为整米（1000 mm 的倍数）` : null;
}

/** 候选方案中已占用的条数（未报工的候选也算，避免重复出车）。 */
export function pendingCounts(plans = []) {
    const out = {};
    for (const p of plans) if (p.status === 'PENDING')
        for (const piece of p.result?.pieces || []) if (piece.demandId != null) out[piece.demandId] = (out[piece.demandId] || 0) + 1;
    return out;
}

/** 剩余待出条数 = 剩余需求 − 候选已占用。 */
export function openDemands(remaining, plans) {
    const used = pendingCounts(plans);
    return remaining.map(d => ({...d, demand: Math.max(0, d.demand - (used[d.id] || 0))})).filter(d => d.demand > 0);
}

/** v2 计算作业请求：母卷幅宽取所选母卷（整数 mm），订单编号为需求编号。 */
export function slittingJob(task, rollWidth, open, {profile = 'FAST', timeLimitSeconds = 10} = {}) {
    const s = task.slitting || DEFAULT_SLITTING;
    return {schemaVersion: '2.0', problemType: SLITTING, clientRequestId: `${task.id}-r${task.revision}`,
        problem: {schemaVersion: '1', unit: 'mm', motherWidthMm: Math.floor(rollWidth), leftTrimMm: s.leftTrim, rightTrimMm: s.rightTrim,
            minWidthMm: s.minWidth, maxWidthMm: s.maxWidth, widthStepMm: s.widthStep, totalOverCap: s.totalOverCap, profile,
            orders: open.map(d => ({id: String(d.id), widthMm: d.width, lengthMm: d.length, quantity: d.demand, surfaceTreatment: task.materialModel || '默认'})),
            timeLimitSeconds},
        allowFallback: false, requireComplete: false};
}

/** 组合的条宽序列（按站位展开）。 */
export const patternStrips = pattern => pattern.stations.flatMap(s => Array(s.countPerRepetition).fill(s.widthMm));
export const compositionText = pattern => pattern.stations.map(s => `${s.widthMm}×${s.countPerRepetition}`).join(' + ');

/**
 * 一车的条分配：每条按宽度与卷长匹配剩余需求，优先该组合分配到的订单；没有剩余需求的条不出（留作余料）。
 * 返回 {strips:[{x, width, demandId}], skipped}，x 从左切边起算。
 */
export function assignCar(pattern, open, leftTrim = 0) {
    const left = new Map(open.map(d => [d.id, d.demand]));
    const prefer = new Set((pattern.allocations || []).map(a => String(a.orderId)));
    const strips = []; let x = leftTrim, skipped = 0;
    for (const width of patternStrips(pattern)) {
        const fits = open.filter(d => d.width === width && d.length === pattern.lengthMm && left.get(d.id) > 0)
            .sort((a, b) => Number(prefer.has(String(b.id))) - Number(prefer.has(String(a.id))) || left.get(b.id) - left.get(a.id));
        if (fits[0]) { strips.push({x, width, demandId: fits[0].id}); left.set(fits[0].id, left.get(fits[0].id) - 1); }
        else skipped++;
        x += width;
    }
    return {strips, skipped};
}

/** 按当前剩余需求，该组合还能出几车（每车至少出一条），最多为计划车数。 */
export function usefulCars(pattern, open) {
    let rest = open.map(d => ({...d})), n = 0;
    for (; n < pattern.repetitions; n++) {
        const {strips} = assignCar(pattern, rest);
        if (!strips.length) break;
        for (const s of strips) rest.find(d => d.id === s.demandId).demand--;
        rest = rest.filter(d => d.demand > 0);
    }
    return n;
}

/**
 * 车的起点：从 from 起向后避让疵点（含避让边距），直到所有条覆盖的幅宽区间内整车长度无疵点。
 * 返回起点；卷尾放不下时返回 null。
 */
export function carStart(roll, from, length, strips) {
    const defects = (roll.defects || []).map(d => ({x0: d.x - (d.margin ?? 20), x1: d.x + d.w + (d.margin ?? 20), y0: d.y - (d.margin ?? 20), y1: d.y + d.h + (d.margin ?? 20)}));
    let start = from;
    for (let guard = 0; guard <= defects.length; guard++) {
        if (start + length > roll.totalLength + .001) return null;
        const hit = defects.filter(d => d.y0 < start + length && d.y1 > start && strips.some(s => d.x0 < s.x + s.width && d.x1 > s.x));
        if (!hit.length) return start;
        start = Math.ceil(Math.max(...hit.map(d => d.y1)) * 10) / 10;
    }
    return null;
}

/** 出车请求：工位 = 切头 + 卷长；需求数量 = 本车各需求条数；疵点由后端按母卷档案重算。 */
export function carRequest({task, roll, start, pattern, strips, settings}) {
    const trim = task.process?.trimStart || 0, len = trim + pattern.lengthMm;
    const base = buildSolveRequest({task, roll, win: {start, len}, completed: {}, reserved: {}, settings});
    const counts = {};
    strips.forEach(s => { counts[s.demandId] = (counts[s.demandId] || 0) + 1; });
    const demands = base.demands.filter(d => counts[d.id]).map(d => ({...d, demand: counts[d.id]}));
    return {request: {...base, demands, allowLongitudinal: true, allowRotation: false, firstStageOrientation: 'vertical',
            defects: windowDefects(roll.defects || [], start, len, roll.width)},
        pieces: strips.map((s, i) => ({id: i + 1, name: '', x: s.x, y: trim, w: s.width, l: pattern.lengthMm, rotated: false, demandId: s.demandId}))};
}

/** 余宽 = 母卷幅宽 − 左右切边 − 条宽合计（组合宽 rollWidthMm 是本组合选用的分切总宽，不是母卷）。 */
export const spareWidth = (pattern, motherWidth, s = DEFAULT_SLITTING) => motherWidth - s.leftTrim - s.rightTrim - pattern.patternWidthMm;

/** 方案汇总（导出与展示）：每个组合一行。 */
export function patternRows(result, names = new Map(), motherWidth = 0, slitting = DEFAULT_SLITTING) {
    return (result?.patterns || []).map((p, i) => ({
        no: i + 1, id: p.id, length: p.lengthMm, composition: compositionText(p), patternWidth: p.patternWidthMm, comboWidth: p.rollWidthMm,
        motherWidth, spare: spareWidth(p, motherWidth, slitting), repetitions: p.repetitions,
        allocations: (p.allocations || []).map(a => `${names.get(Number(a.orderId))?.name || a.orderId}: ${a.quantity}`).join('；')
    }));
}
