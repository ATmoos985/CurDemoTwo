/** The fabric workflow owns global coordinates and completion facts, not the renderer. */
import { rectangle } from '../../nesting/nesting-scene.js';

export function workspaceCompletedLength(data) {
    const receipt = data.lastReceipt;
    return Math.max(0, ...(data.pieces || []).filter(p => p.confirmed).map(p => p.y + p.l),
        receipt?.actualCutLen ? Math.round((receipt.windowStartY || 0) + receipt.actualCutLen) : 0);
}

export function createWorkspaceScene(data) {
    const width = data.rollW || 2000, height = data.totalRollL || 60000;
    const start = data.windowStartY || 0, length = data.bedL || 5000;
    const placements = (data.pieces || []).map(p => ({ id: p.id, demandId: p.demandId, name: p.name,
        x: p.x, y: p.y, shape: rectangle(p.w, p.l), rotationDegrees: p.rotated ? 90 : 0 }));
    const cuts = (data.cuts || []).filter(c => {
        const y = c.type === '横切' ? c.pos : (c.start + c.end) / 2;
        return y >= start - 10 && y <= start + length + 10;
    }).map(c => {
        const horizontal = c.type === '横切';
        return { sequence: c.step, kind: horizontal ? 'HORIZONTAL' : 'VERTICAL',
            startX: c.startX ?? (horizontal ? c.start : c.pos), startY: c.startY ?? (horizontal ? c.pos : c.start),
            endX: c.endX ?? (horizontal ? c.end : c.pos), endY: c.endY ?? (horizontal ? c.pos : c.end) };
    });
    return {
        scene: { unit: 'mm', material: { id: data.rollId, shape: rectangle(width, height) },
            region: { x: 0, y: start, shape: rectangle(width, length) },
            process: { startCorner: data.cutOrigin || 'right-bottom', trimStart: data.trimStart || 0 },
            exclusions: (data.globalDefects || data.defects || []).map(d => ({ id: d.id, x: d.x, y: d.y,
                shape: rectangle(d.w, d.h), clearance: d.margin ?? 20 })),
            placements, leftovers: (data.remnants || []).map(r => ({ id: r.id, x: r.x, y: r.y,
                shape: rectangle(r.w, r.l), hasDefect: r.hasDefect })), cuts },
        overlay: {
            completedIds: new Set((data.pieces || []).filter(p => p.confirmed).map(p => p.id)),
            completedLength: workspaceCompletedLength(data)
        }
    };
}
