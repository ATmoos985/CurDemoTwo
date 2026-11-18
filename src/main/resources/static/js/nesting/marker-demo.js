import {garmentContourProblem, garmentExample} from './scenario-examples.js';
import {dxfParts, DXF_TRIAL_STYLES} from './dxf-patterns.js';
import {isDxfStyle, buildDxfStyleParts} from './dxf-garment-samples.js';
export {DXF_TRIAL_STYLES};
import {polygon, rectangle, shapeArea} from '../canvas/nesting-scene.js';

export const MARKER_STYLES = Object.freeze([
    {id:'GARMENT_SHIRT', name:'上衣', description:'前片、后片、袖片、领片、贴边与袋布'},
    {id:'GARMENT_PANTS', name:'长裤', description:'前裤片、后裤片、裤袋、腰头与门襟'},
    {id:'GARMENT_SKIRT', name:'半裙', description:'裙片、贴袋与腰头'},
    {id:'GARMENT_TANK', name:'背心', description:'前后身片、领口包条与袖窿包条'},
    {id:'GARMENT_SHORTS', name:'短裤', description:'前后裤片、松紧腰头与贴袋'},
    {id:'GARMENT_APRON', name:'围裙', description:'围裙身片、前贴袋、挂颈带与腰系带'},
    {id:'GARMENT_GORED_SKIRT', name:'六片裙', description:'六片梯形裙片与分段腰头'},
    {id:'GARMENT_GATHERED_SKIRT', name:'直裁抽褶裙', description:'两片直裁裙身与分段腰头'}
]);

export const GARMENT_TRIAL_STYLES = Object.freeze([...MARKER_STYLES, ...DXF_TRIAL_STYLES]);

export function markerSizeLabels(style) {
    const entry = GARMENT_TRIAL_STYLES.find(item => item.id === style);
    if (entry) return entry.sizes ?? ['M','L'];
    if (isDxfStyle(style)) return ['M','L'];
    throw new Error('唛架款式不存在');
}

function gradedParts(style, sizeCounts) {
    const base = garmentExample(style);
    const small = style === 'GARMENT_SHIRT' ? [
        {name:'领片', quantity:1, shape:polygon([{x:0,y:0},{x:340,y:0},{x:320,y:70},{x:20,y:70}])},
        {name:'贴边', quantity:2, shape:rectangle(55,400)},
        {name:'袋布', quantity:2, shape:polygon([{x:0,y:0},{x:150,y:0},{x:150,y:140},{x:75,y:180},{x:0,y:140}])}
    ] : style === 'GARMENT_PANTS' ? [
        {name:'腰头', quantity:1, shape:rectangle(760,90)},
        {name:'门襟', quantity:2, shape:rectangle(65,240)}
    ] : style === 'GARMENT_SKIRT' ? [{name:'腰头', quantity:1, shape:rectangle(720,90)}] : [];
    return ['M','L'].flatMap((size, index) => [...base.parts, ...small].map(part => {
        const scale = index ? 1.08 : 1;
        const shape = part.shape.type === 'RECTANGLE' ? rectangle(Math.round(part.shape.width * scale), Math.round(part.shape.height * scale))
            : polygon(part.shape.vertices.map(p => ({x:Math.round(p.x * scale), y:Math.round(p.y * scale)})));
        return {name:`${size}码 · ${part.name}`, quantity:part.quantity * sizeCounts[size], shape, allowRotation:false};
    })).map((part, index) => ({...part, id:index + 1})).filter(part => part.quantity > 0);
}

/** Each requested garment contributes its full set of cut pieces. */
export function markerExample(width = 1500, style = 'GARMENT_SHIRT', sizeCounts) {
    if (!Number.isFinite(width) || width < 1200 || width > 2000) throw new Error('示例布宽应在 1200–2000 mm 之间');
    const sizes = markerSizeLabels(style);
    const dxf = DXF_TRIAL_STYLES.find(item => item.id === style);
    const supplied = sizeCounts ?? dxf?.defaultCounts ?? {M:1,L:1};
    if (Object.keys(supplied).some(size => !sizes.includes(size))) throw new Error('请求包含样板没有的尺码');
    const counts = Object.fromEntries(sizes.map(size => [size, supplied[size] ?? 0]));
    const total = sizes.reduce((sum, size) => sum + counts[size], 0);
    if (!sizes.every(size => Number.isInteger(counts[size]) && counts[size] >= 0) || total < 1 || total > 12)
        throw new Error(`每版 ${sizes.join('、')} 码合计须为 1–12 件成衣`);
    const parts = dxf ? dxfParts(dxf, counts)
        : isDxfStyle(style) ? buildDxfStyleParts(style, {sizeCounts:counts, fabricFilter:'面布', splitMirrorPairs:true})
            .map(({id, name, quantity, shape, allowRotation}) => ({id, name, quantity, shape, allowRotation}))
        : gradedParts(style, counts);
    // A deterministic row layout supplies a generous starting length, not an asserted optimum.
    let x = 0, y = 0, rowHeight = 0;
    for (const part of parts) for (let i = 0; i < part.quantity; i++) {
        if (x + part.shape.width > width) { y += rowHeight; x = 0; rowHeight = 0; }
        x += part.shape.width; rowHeight = Math.max(rowHeight, part.shape.height);
    }
    const materialId = `DEMO-MARKER-${style}-${sizes.join('')}`;
    return garmentContourProblem(materialId, rectangle(width, Math.ceil(y + rowHeight + 100)), parts, 2);
}

export function markerSummary(problem, scene) {
    const requested = problem.parts.reduce((sum, part) => sum + part.quantity, 0);
    const counts = new Map();
    for (const p of scene?.placements || []) counts.set(p.demandId, (counts.get(p.demandId) || 0) + 1);
    const rows = problem.parts.map(part => ({name:part.name, requested:part.quantity, placed:counts.get(part.id) || 0}));
    const complete = scene?.status === 'FEASIBLE' && rows.every(row => row.placed === row.requested)
        && scene.placements.length === requested;
    const length = scene?.placements.length ? Math.max(...scene.placements.map(p => p.y + p.shape.height)) : 0;
    const pieceArea = problem.parts.reduce((sum, p) => sum + shapeArea(p.shape) * p.quantity, 0);
    const trialLength = problem.material.shape.height;
    return {requested, rows, complete:!!complete, length, trialLength,
        unusedTail:complete ? Math.max(0, trialLength - length) : null,
        utilization:complete && length > 0 ? pieceArea / (problem.material.shape.width * length) : null};
}
