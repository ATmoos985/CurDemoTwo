// 适配层：方案工具（刀路、导出、手动调整）。纯函数，不发请求。
// 方案结果坐标均为工位局部：x 幅宽方向、y 卷长方向；画布世界坐标 u = 工位起点 + y，v = x。
import {homePoint} from '../../../js/plugins/export/cam-format.js';
import {pieceVertices, outlinesConflict, rotateShape} from '../../../js/canvas/outline-geometry.js';

const r1 = n => Math.round(n * 10) / 10;

/** 工位局部机台原点（数控代码与刀路优化使用局部坐标，原点不叠加工位起点）。 */
export function localHome(plan) {
    const q = plan.request;
    return homePoint({cutOrigin: q.cutOrigin, width: q.rollW, length: q.rollL, windowStartY: 0});
}

/** 导出数据：方案局部坐标 + 局部原点；windowStartY 仅写入程序头说明。 */
export function camData(plan) {
    const q = plan.request, r = plan.result;
    return {data: {rollId: q.feedPortType === 'remnant' ? q.sourceRemnantId : q.rollId, rollW: q.rollW, bedL: q.rollL, windowStartY: q.windowStartY || 0,
        cutOrigin: q.cutOrigin, cuts: r.cuts || [], pieces: r.pieces || [], remnants: q.feedPortType === 'remnant' ? [] : r.remnants || [], defects: q.defects || []},
        home: localHome(plan)};
}

/** 画布刀路图层用的世界坐标原点。 */
export const worldHome = (plan, segStart) => { const h = localHome(plan); return {u: segStart + h.y, v: h.x}; };

/** 手动调整的初始位置（来自已保存方案）。 */
export function initialPositions(plan) {
    return Object.fromEntries((plan.result.pieces || []).map(p => [p.id, {x: p.x, y: p.y, rotated: !!p.rotated,
        ...(p.shape ? {rotationDegrees: p.rotationDegrees || 0} : {})}]));
}

/** 移动一件：du 沿卷长、dv 沿幅宽（世界增量）→ 局部 y、x；限制在工位内，精度 0.1 mm。 */
export function movePiece(positions, plan, id, du, dv, base = positions) {
    const p = (plan.result.pieces || []).find(x => x.id === Number(id) || x.id === id);
    if (!p) return positions;
    const pos = base[p.id], {w, l} = sizeOf(p, pos.rotated);
    const x = Math.max(0, Math.min(plan.request.rollW - w, r1(pos.x + dv)));
    const y = Math.max(0, Math.min(plan.request.rollL - l, r1(pos.y + du)));
    return {...positions, [p.id]: {...positions[p.id], x, y}};
}

export function rotatePiece(positions, plan, id) {
    const p = (plan.result.pieces || []).find(x => x.id === id);
    if (!p || !rotationAllowed(plan, p)) return positions;
    return {...positions, [id]: {...positions[id], rotated: !positions[id].rotated,
        ...(p.shape ? {rotationDegrees: (positions[id].rotationDegrees + 90) % 360} : {})}};
}

const contourMode = plan => (plan.request.demands || []).some(d => d.shape);
export function rotationAllowed(plan, piece) {
    const demand = plan.request.demands?.find(d => d.id === piece.demandId);
    return !!(contourMode(plan) ? demand?.allowRotation : plan.request.allowRotation || demand?.allowRotation);
}

/** 件的当前外形尺寸：旋转状态与原方案不同则宽长互换。 */
export function sizeOf(p, rotated) { return rotated === !!p.rotated ? {w: p.w, l: p.l} : {w: p.l, l: p.w}; }

export function changedPieces(positions, plan) {
    return (plan.result.pieces || []).filter(p => { const q = positions[p.id]; return q && (Math.abs(q.x - p.x) > .05 || Math.abs(q.y - p.y) > .05 || q.rotated !== !!p.rotated
        || p.shape && q.rotationDegrees !== (p.rotationDegrees || 0)); }).length;
}

export function adjustPayload(positions, adjustmentId) {
    return {adjustmentId, pieces: Object.entries(positions).map(([id, q]) => ({id: Number(id), x: q.x, y: q.y, rotated: q.rotated,
        ...(q.rotationDegrees == null ? {} : {rotationDegrees: q.rotationDegrees})}))};
}

function positioned(piece, pos) {
    const angle = pos.rotationDegrees ?? ((piece.rotationDegrees || 0) + (pos.rotated !== !!piece.rotated ? 90 : 0)) % 360;
    return {...piece, ...pos, ...sizeOf(piece, pos.rotated),
        ...(piece.shape ? {shape: rotateShape(piece.shape, (angle - (piece.rotationDegrees || 0) + 360) % 360)} : {})};
}

const overlaps = (a, b, gap = 0) => a.x + a.w + gap > b.x + .001 && b.x + b.w + gap > a.x + .001
    && a.y + a.l + gap > b.y + .001 && b.y + b.l + gap > a.y + .001;

/** Local geometry feedback only. Saving still validates grain, complete sets and executable cuts on the server. */
export function placementProblem(positions, plan, id) {
    const source = plan.result.pieces.find(p => p.id === id), q = positions[id], request = plan.request;
    const issue = (code, message, subject = null, related = []) => ({code, pieceId: id, message: `裁片 #${id}：${message}`, subject, related});
    if (!source || !q || ![q.x, q.y].every(n => Number.isFinite(n) && Math.abs(n * 10 - Math.round(n * 10)) < .000001))
        return issue('POSITION', '位置须为有效数字，精确到 0.1 mm');
    if (source.shape && !['RECTANGLE', 'POLYGON'].includes(source.shape.type)) return issue('SHAPE', '不支持该轮廓，不能按外接矩形通过预检');
    if (source.shape && (![0, 90, 180, 270].includes(q.rotationDegrees) || (q.rotationDegrees % 180 !== 0) !== q.rotated))
        return issue('ROTATION', '旋转角度与尺寸状态不一致');
    const p = positioned(source, q), contour = contourMode(plan);
    if ((q.rotated !== !!source.rotated || source.shape && q.rotationDegrees !== (source.rotationDegrees || 0)) && !rotationAllowed(plan, source))
        return issue('ROTATION', '该需求不允许旋转', p);
    if (p.x < -.001 || p.y < -.001 || p.x + p.w > request.rollW + .001 || p.y + p.l > request.rollL + .001)
        return issue('BOUNDS', '超出当前工位边界', p);
    const trim = request.trimStart || 0, trimAtEnd = !contour && request.feedPortType === 'remnant' && request.allowLongitudinal && request.cutOrigin?.endsWith('bottom');
    if (trimAtEnd ? p.y + p.l > request.rollL - trim + .001 : p.y < trim - .001)
        return issue('TRIM', '进入修齐区域', p);
    if (!contour && !request.allowLongitudinal && (Math.abs(p.x) > .001 || Math.abs(p.w - request.rollW) > .001))
        return issue('CROSSCUT', '仅横切时须保持整幅宽度', p);
    const vertices = pieceVertices(p);
    for (const d of request.defects || []) {
        const margin = d.margin ?? 20, zone = {id: d.id, x: d.x - margin, y: d.y - margin, w: d.w + margin * 2, l: d.h + margin * 2};
        if (overlaps(p, zone) && outlinesConflict(vertices, pieceVertices(zone)))
            return issue('DEFECT', `进入疵点 #${d.id} 的避让区域（外扩 ${margin} mm）`, p, [zone]);
    }
    const gap = request.pieceGap || 0;
    for (const other of plan.result.pieces) {
        if (other.id === id) continue;
        if (!positions[other.id] || other.shape && !['RECTANGLE', 'POLYGON'].includes(other.shape.type)) return issue('SHAPE', `无法校验裁片 #${other.id} 的轮廓`, p);
        const b = positioned(other, positions[other.id]);
        if (overlaps(p, b, gap) && (!contour || outlinesConflict(vertices, pieceVertices(b), gap)))
            return issue('PIECE', `与裁片 #${b.id} 重叠或间距不足（至少 ${gap} mm）`, p, [b]);
    }
    return null;
}

/** 把调整中的位置套到画布段上（只改当前段的件）。 */
export function applyPositions(seg, plan, positions) {
    return {...seg, len: plan.request?.rollL ?? seg.len, cuts: [], remnants: [], pieces: seg.pieces.map(piece => {
        const p = plan.result.pieces.find(x => x.id === piece.id), q = positions[piece.id];
        if (!p || !q) return piece;
        const moved = positioned(p, q), {w, l} = moved;
        return {...piece, u: seg.start + q.y, v: q.x, du: l, dv: w,
            shape: moved.shape || {type: 'RECTANGLE', width: w, height: l}, label: `${Math.round(w)}×${Math.round(l)}`};
    })};
}
