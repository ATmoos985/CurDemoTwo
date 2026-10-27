// 适配层：把任务的方案版本与母卷档案转换为画布场景。纯函数，不发请求。
// 方案坐标：件与疵点的 y 相对工位起点（request.windowStartY），x 为幅宽方向；母卷疵点 y 为整卷坐标。

export const PIECE_PALETTE = ['#5f87b0', '#7f9d6e', '#b8925a', '#9a7aa0', '#5f9a96', '#a8735f', '#7a86b8', '#8f9a5a', '#b07a8f', '#5a8fb0'];
export const SEGMENT_TINTS = ['#47627d', '#4d6b55', '#6b5a43', '#5d4f66', '#3f6563'];

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
            label: `${Math.round(p.w)}×${Math.round(p.l)}`,
            title: `${p.name || '裁片'} · ${p.w}×${p.l} mm${p.rotated ? ' · 旋转' : ''}`,
            color: colors.get(p.demandId) || PIECE_PALETTE[0]
        })),
        cuts: (res.cuts || []).filter(c => [c.startX, c.startY, c.endX, c.endY].every(Number.isFinite))
            .map(c => ({u1: start + c.startY, v1: c.startX, u2: start + c.endY, v2: c.endX, type: c.type, step: c.step})),
        pieceArea: Number(res.pieceArea) || 0,
        totalArea: Number(res.totalArea) || 0,
        fulfillment: res.fulfillment || [],
        engine: res.engine, fallbackReason: res.fallbackReason
    };
}

export function rollDefects(roll, fresh = []) {
    const base = (roll?.defects || []).map(d => ({
        id: d.id, u: d.y, v: d.x, du: d.h, dv: d.w, margin: d.margin || 0,
        label: `${d.typeName || d.defectType || '疵点'} · Y ${(d.y / 1000).toFixed(2)} m`, fresh: false, source: d.detectionSource
    }));
    return base.concat(fresh.map(d => ({...d, fresh: true})));
}

/** 已切段末端：工位不能移入此前区域。 */
export function cutEnd(segments, used = 0) {
    return segments.filter(s => s.status === 'cut').reduce((m, s) => Math.max(m, s.start + s.len), used);
}

/** selectedId = NEW_STATION 表示对准最后一段有效拉布之后的新工位。 */
export const NEW_STATION = '__new__';

export function buildRollScene({roll, plans, reports = [], rollId, demands, process, freshDefects = [], selectedId = null, window: manual = null}) {
    const colors = demandColors(demands, plans);
    const list = plansOnRoll(plans, rollId);
    const reported = reportedPlans(reports);
    const segments = list.map((p, i) => planSegment(p, colors, i, reported));
    const total = Number(roll?.totalLength) || Math.max(...segments.map(s => s.start + s.len), 1);
    const used = Math.min(Number(roll?.usedLength) || 0, total);
    const lock = Math.max(cutEnd(segments, 0), used);
    const bed = Number(process?.bedLength) || 5000;
    const liveEnd = segments.filter(live).reduce((m, s) => Math.max(m, s.start + s.len), 0);
    const fresh = {start: Math.max(liveEnd, used), len: Math.max(0, Math.min(bed, total - Math.max(liveEnd, used)))};
    const current = selectedId === NEW_STATION ? null
        : segments.find(s => s.id === selectedId) || segments.find(s => s.status === 'pending') || null;
    const base = current ? {start: current.start, len: current.len} : fresh;
    const win = manual ? {...manual} : {...base};
    win.adjusted = !!manual && (Math.abs(manual.start - base.start) > .5 || Math.abs(manual.len - base.len) > .5);
    win.isNew = !current;
    return {
        roll: {id: rollId, width: Number(roll?.width) || Number(list[0]?.request?.rollW) || 0, total, used},
        segments, defects: rollDefects(roll, freshDefects),
        currentId: current?.id || null, window: win, lock,
        bed: {min: 500, max: Math.max(bed, 6000)}
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
