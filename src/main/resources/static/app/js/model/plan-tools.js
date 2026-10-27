// 适配层：方案工具（刀路、导出、手动调整）。纯函数，不发请求。
// 方案结果坐标均为工位局部：x 幅宽方向、y 卷长方向；画布世界坐标 u = 工位起点 + y，v = x。
import {homePoint} from '../../../js/plugins/export/cam-format.js';

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
    return Object.fromEntries((plan.result.pieces || []).map(p => [p.id, {x: p.x, y: p.y, rotated: !!p.rotated}]));
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
    if (!p || p.shape) return positions; // 轮廓件旋转需按角度校验，这里只处理矩形件
    return {...positions, [id]: {...positions[id], rotated: !positions[id].rotated}};
}

/** 件的当前外形尺寸：旋转状态与原方案不同则宽长互换。 */
export function sizeOf(p, rotated) { return rotated === !!p.rotated ? {w: p.w, l: p.l} : {w: p.l, l: p.w}; }

export function changedPieces(positions, plan) {
    return (plan.result.pieces || []).filter(p => { const q = positions[p.id]; return q && (Math.abs(q.x - p.x) > .05 || Math.abs(q.y - p.y) > .05 || q.rotated !== !!p.rotated); }).length;
}

export function adjustPayload(positions, adjustmentId) {
    return {adjustmentId, pieces: Object.entries(positions).map(([id, q]) => ({id: Number(id), x: q.x, y: q.y, rotated: q.rotated}))};
}

/** 把调整中的位置套到画布段上（只改当前段的件）。 */
export function applyPositions(seg, plan, positions) {
    return {...seg, cuts: [], pieces: seg.pieces.map(piece => {
        const p = plan.result.pieces.find(x => x.id === piece.id), q = positions[piece.id];
        if (!p || !q) return piece;
        const {w, l} = sizeOf(p, q.rotated);
        return {...piece, u: seg.start + q.y, v: q.x, du: l, dv: w, label: `${Math.round(w)}×${Math.round(l)}`};
    })};
}
