import {DXF_OUTLINES} from './dxf-outlines.js';
import {polygon} from '../canvas/nesting-scene.js';

const GRADES = ['110','120','130','140','150','160'];
const FABRICS = {面布:'shell', 罗纹:'rib', 衬布:'interlining', 里布:'lining'};

export const DXF_TRIAL_STYLES = ['1226','20148D','3129'].flatMap(source =>
    Object.entries(DXF_OUTLINES[source]).filter(([,group]) => FABRICS[group.fabric])
        .map(([materialCode, {fabric}]) => {
            const slug = FABRICS[fabric];
            const primary = source === '1226' && fabric === '面布';
            const defaultCounts = source === '1226' ? {'130':2, '140':2}
                : source === '3129' ? {'130':1} : {'130':1,'140':1};
            return {
                id:primary ? 'GARMENT_FOUR_PIECE' : `GARMENT_DXF_${source}_${slug.toUpperCase()}`,
                exampleId:primary ? 'four-piece-130-140' : `dxf-${source.toLowerCase()}-${slug}`,
                name:`${source}${source === '1226' ? ' 四大件' : source === '3129' ? ' 套装' : ''} · ${fabric}`,
                source, fabric, materialCode, sizes:GRADES, defaultCounts,
                ...(primary ? {benchmark:{width:1780,length:1825.1,utilization:83.4,counts:{'130':2,'140':2}}} : {})
            };
        }));

// Optimization accepts tenths of a millimetre. Keep the measured DXF data for the report overlay.
function solverVertices(vertices) {
    const points = vertices.map(([x,y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    return points.filter(([x,y], i) => {
        const previous = points[(i + points.length - 1) % points.length];
        return x !== previous[0] || y !== previous[1];
    });
}

export function dxfParts(style, counts, solverGrid = true) {
    const pieces = DXF_OUTLINES[style.source][style.materialCode].pieces;
    const parts = [];
    let id = 0;
    for (const size of style.sizes) for (const piece of pieces) {
        for (const side of ['left','right']) {
            if (!piece[side]) continue;
            id++;
            if (!counts[size]) continue;
            const vertices = solverGrid ? solverVertices(piece.sizes[size]) : piece.sizes[size];
            const width = Math.max(...vertices.map(([x]) => x));
            const points = side === 'left' ? vertices.map(([x,y]) => ({x,y}))
                : vertices.map(([x,y]) => ({x:Number((width - x).toFixed(4)),y})).reverse();
            const suffix = piece.left && piece.right ? (side === 'left' ? '（左）' : '（右）') : '';
            parts.push({id, name:`${size}码 · ${piece.name}${suffix}`, quantity:piece[side]*counts[size],
                shape:polygon(points), allowRotation:false});
        }
    }
    return parts;
}
