/**
 * 通用生产级 CAD / AAMA DXF 几何解析引擎（纯 JS）。
 * 支持：$INSUNITS 单位换算与覆盖、BLOCKS+INSERT（缩放/旋转/负缩放镜像/阵列）、
 * LWPOLYLINE(凸度)、POLYLINE+VERTEX(凸度)、CIRCLE、ARC、SPLINE、散落 LINE/ARC 容差拼接、
 * 内孔 holes 提取与绕序校准（外 CCW / 内 CW）、弦高逼近、0.1 mm 量化及 AAMA 服装纸样防重放兼容。
 */

import { decodeTextBuffer } from '../domain/demand-import-csv.js';
import {
    quantize01,
    expandBulgePolyline,
    sampleCirclePoints,
    sampleArcPoints,
    sampleSplinePoints,
    stitchOpenSegments,
    buildContourShapesWithHoles,
    DEFAULT_HOLE_LAYER_KEYWORDS,
    DEFAULT_OUTER_LAYER_KEYWORDS,
    matchesLayerKeywords
} from './dxf-geometry.js';

export const DXF_INSUNITS_TO_MM = Object.freeze({
    0: null,
    1: 25.4,
    2: 304.8,
    4: 1,
    5: 10,
    6: 1000,
    14: 100
});

const UNIT_KEY_TO_MM = Object.freeze({
    mm: 1,
    cm: 10,
    dm: 100,
    m: 1000,
    inch: 25.4,
    in: 25.4,
    ft: 304.8,
    feet: 304.8
});

const UNIT_MM_TO_LABEL = new Map([
    [1, 'mm'],
    [10, 'cm'],
    [100, 'dm'],
    [1000, 'm'],
    [25.4, 'inch'],
    [304.8, 'ft']
]);

const DEFAULT_EXCLUDE_LAYERS = ['DIM', 'TEXT', 'DEFPOINTS', 'FRAME', '7'];
const DEFAULT_HOLE_KEYWORDS = DEFAULT_HOLE_LAYER_KEYWORDS;
const DEFAULT_OUTER_KEYWORDS = DEFAULT_OUTER_LAYER_KEYWORDS;
const AAMA_PREFIX_RE = /^(F1CRH1226 大货版_|FH20148D 二套版 排料_|F2FCG3129 套装_F2FCG3129 套装_|F2FCG3129 套装_|F2FCG3129 )/;

function resolveRotationFlags(rotationMode = 'FIXED') {
    const mode = String(rotationMode || 'FIXED').toUpperCase();
    if (mode === 'ROTATE_90' || mode === 'FREE' || mode === 'ANY') {
        return { allowRotation: true, allowHalfTurn: false };
    }
    if (mode === 'HALF_TURN_180' || mode === '180') {
        return { allowRotation: false, allowHalfTurn: true };
    }
    return { allowRotation: false, allowHalfTurn: false };
}

function tokenizeDxfPairs(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const pairs = [];
    let i = 0;
    while (i + 1 < lines.length) {
        const code = lines[i].trim();
        if (code === '' || !/^-?\d+$/.test(code)) {
            i++;
            continue;
        }
        const value = lines[i + 1].trim();
        pairs.push([code, value]);
        i += 2;
    }
    return pairs;
}

function parseDxfSections(pairs) {
    let insunits = null;
    const blocks = new Map();
    const entities = [];
    const warnings = [];

    let i = 0;
    while (i < pairs.length) {
        const [code, val] = pairs[i];
        if (code === '0' && val === 'SECTION') {
            i++;
            let secName = '';
            if (i < pairs.length && pairs[i][0] === '2') {
                secName = pairs[i][1].toUpperCase();
                i++;
            }
            if (secName === 'HEADER') {
                i = parseHeaderSection(pairs, i, v => { insunits = v; });
            } else if (secName === 'BLOCKS') {
                i = parseBlocksSection(pairs, i, blocks, warnings);
            } else if (secName === 'ENTITIES') {
                i = parseEntitiesLoop(pairs, i, 'ENDSEC', entities, warnings);
            } else {
                while (i < pairs.length && !(pairs[i][0] === '0' && pairs[i][1] === 'ENDSEC')) i++;
                if (i < pairs.length) i++;
            }
        } else {
            i++;
        }
    }

    return { insunits, blocks, entities, warnings };
}

function parseHeaderSection(pairs, startIdx, onInsunits) {
    let i = startIdx;
    while (i < pairs.length && !(pairs[i][0] === '0' && pairs[i][1] === 'ENDSEC')) {
        if (pairs[i][0] === '9' && pairs[i][1].toUpperCase() === '$INSUNITS') {
            i++;
            while (i < pairs.length && pairs[i][0] !== '9' && pairs[i][0] !== '0') {
                if (pairs[i][0] === '70') {
                    const num = parseInt(pairs[i][1], 10);
                    if (Number.isInteger(num)) onInsunits(num);
                }
                i++;
            }
            continue;
        }
        i++;
    }
    return i < pairs.length ? i + 1 : i;
}

function parseBlocksSection(pairs, startIdx, blocksMap, warnings) {
    let i = startIdx;
    while (i < pairs.length && !(pairs[i][0] === '0' && pairs[i][1] === 'ENDSEC')) {
        if (pairs[i][0] === '0' && pairs[i][1] === 'BLOCK') {
            i++;
            let name = '';
            let baseX = 0;
            let baseY = 0;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '2') name = v;
                else if (c === '10') baseX = Number(v) || 0;
                else if (c === '20') baseY = Number(v) || 0;
                i++;
            }
            const blockEntities = [];
            i = parseEntitiesLoop(pairs, i, 'ENDBLK', blockEntities, warnings);
            if (name) {
                blocksMap.set(name, { name, baseX, baseY, entities: blockEntities });
            }
        } else {
            i++;
        }
    }
    return i < pairs.length ? i + 1 : i;
}

function parseEntitiesLoop(pairs, startIdx, endType, targetList, warnings) {
    let i = startIdx;
    while (i < pairs.length && !(pairs[i][0] === '0' && pairs[i][1] === endType)) {
        if (pairs[i][0] !== '0') {
            i++;
            continue;
        }
        const type = pairs[i][1].toUpperCase();
        i++;

        if (type === 'TEXT' || type === 'MTEXT') {
            let layer = '0';
            let textMain = '';
            let textChunks = '';
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '3') textChunks += v;
                else if (c === '1') textMain = v;
                i++;
            }
            const value = (textChunks + textMain).replace(/\\P/gi, '\n').trim();
            if (value) targetList.push({ type: 'TEXT', layer, value });
        } else if (type === 'LWPOLYLINE') {
            let layer = '0';
            let flags = 0;
            const vertices = [];
            let curr = null;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '70') flags = parseInt(v, 10) || 0;
                else if (c === '10') {
                    if (curr) vertices.push(curr);
                    curr = { x: Number(v) || 0, y: 0, bulge: 0 };
                } else if (c === '20') {
                    if (!curr) curr = { x: 0, y: Number(v) || 0, bulge: 0 };
                    else curr.y = Number(v) || 0;
                } else if (c === '42') {
                    if (curr) curr.bulge = Number(v) || 0;
                }
                i++;
            }
            if (curr) vertices.push(curr);
            if (vertices.length >= 2) {
                targetList.push({ type: 'LWPOLYLINE', layer, closed: (flags & 1) === 1, vertices });
            }
        } else if (type === 'POLYLINE') {
            let layer = '0';
            let flags = 0;
            const vertices = [];
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '70') flags = parseInt(v, 10) || 0;
                i++;
            }
            while (i < pairs.length && !(pairs[i][0] === '0' && pairs[i][1] === 'SEQEND')) {
                if (pairs[i][0] === '0' && pairs[i][1] === 'VERTEX') {
                    i++;
                    let vx = 0;
                    let vy = 0;
                    let bulge = 0;
                    let vlayer = '';
                    let vflags = 0;
                    while (i < pairs.length && pairs[i][0] !== '0') {
                        const [c, v] = pairs[i];
                        if (c === '10') vx = Number(v) || 0;
                        else if (c === '20') vy = Number(v) || 0;
                        else if (c === '42') bulge = Number(v) || 0;
                        else if (c === '8') vlayer = v;
                        else if (c === '70') vflags = parseInt(v, 10) || 0;
                        i++;
                    }
                    if ((vflags & 16) === 0 && (vflags & 8) === 0) {
                        vertices.push({ x: vx, y: vy, bulge, layer: vlayer });
                    }
                } else {
                    i++;
                }
            }
            if (i < pairs.length && pairs[i][0] === '0' && pairs[i][1] === 'SEQEND') i++;
            if (vertices.length >= 2) {
                const effectiveLayer = layer !== '0' ? layer : (vertices.find(v => v.layer)?.layer || '0');
                targetList.push({ type: 'POLYLINE', layer: effectiveLayer, closed: (flags & 1) === 1, vertices });
            }
        } else if (type === 'LINE') {
            let layer = '0';
            let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '10') x1 = Number(v) || 0;
                else if (c === '20') y1 = Number(v) || 0;
                else if (c === '11') x2 = Number(v) || 0;
                else if (c === '21') y2 = Number(v) || 0;
                i++;
            }
            targetList.push({ type: 'LINE', layer, x1, y1, x2, y2 });
        } else if (type === 'CIRCLE') {
            let layer = '0';
            let cx = 0, cy = 0, r = 0;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '10') cx = Number(v) || 0;
                else if (c === '20') cy = Number(v) || 0;
                else if (c === '40') r = Number(v) || 0;
                i++;
            }
            if (r > 0) targetList.push({ type: 'CIRCLE', layer, cx, cy, r });
        } else if (type === 'ARC') {
            let layer = '0';
            let cx = 0, cy = 0, r = 0, startDeg = 0, endDeg = 360;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '10') cx = Number(v) || 0;
                else if (c === '20') cy = Number(v) || 0;
                else if (c === '40') r = Number(v) || 0;
                else if (c === '50') startDeg = Number(v) || 0;
                else if (c === '51') endDeg = Number(v) || 0;
                i++;
            }
            if (r > 0) targetList.push({ type: 'ARC', layer, cx, cy, r, startDeg, endDeg });
        } else if (type === 'SPLINE') {
            let layer = '0';
            let flags = 0;
            let degree = 3;
            const knots = [];
            const weights = [];
            const controlPoints = [];
            const fitPoints = [];
            let currCtrl = null;
            let currFit = null;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '70') flags = parseInt(v, 10) || 0;
                else if (c === '71') degree = parseInt(v, 10) || 3;
                else if (c === '40') knots.push(Number(v) || 0);
                else if (c === '41') weights.push(Number(v) || 1);
                else if (c === '10') {
                    if (currCtrl) controlPoints.push(currCtrl);
                    currCtrl = { x: Number(v) || 0, y: 0 };
                } else if (c === '20') {
                    if (!currCtrl) currCtrl = { x: 0, y: Number(v) || 0 };
                    else currCtrl.y = Number(v) || 0;
                } else if (c === '11') {
                    if (currFit) fitPoints.push(currFit);
                    currFit = { x: Number(v) || 0, y: 0 };
                } else if (c === '21') {
                    if (!currFit) currFit = { x: 0, y: Number(v) || 0 };
                    else currFit.y = Number(v) || 0;
                }
                i++;
            }
            if (currCtrl) controlPoints.push(currCtrl);
            if (currFit) fitPoints.push(currFit);
            if (controlPoints.length >= 2 || fitPoints.length >= 2) {
                targetList.push({
                    type: 'SPLINE',
                    layer,
                    closed: (flags & 1) === 1,
                    degree,
                    knots,
                    weights,
                    controlPoints,
                    fitPoints
                });
            }
        } else if (type === 'INSERT') {
            let layer = '0';
            let blockName = '';
            let tx = 0, ty = 0, sx = 1, sy = 1, rotDeg = 0;
            let cols = 1, rows = 1, colSpacing = 0, rowSpacing = 0;
            while (i < pairs.length && pairs[i][0] !== '0') {
                const [c, v] = pairs[i];
                if (c === '8') layer = v;
                else if (c === '2') blockName = v;
                else if (c === '10') tx = Number(v) || 0;
                else if (c === '20') ty = Number(v) || 0;
                else if (c === '41') sx = Number(v) || 1;
                else if (c === '42') sy = Number(v) || 1;
                else if (c === '50') rotDeg = Number(v) || 0;
                else if (c === '70') cols = Math.max(1, parseInt(v, 10) || 1);
                else if (c === '71') rows = Math.max(1, parseInt(v, 10) || 1);
                else if (c === '44') colSpacing = Number(v) || 0;
                else if (c === '45') rowSpacing = Number(v) || 0;
                i++;
            }
            if (blockName) {
                targetList.push({
                    type: 'INSERT',
                    layer,
                    blockName,
                    tx,
                    ty,
                    sx,
                    sy,
                    rotDeg,
                    cols,
                    rows,
                    colSpacing,
                    rowSpacing
                });
            }
        } else {
            if (['3DFACE', '3DSOLID', 'SOLID', 'TRACE'].includes(type)) {
                warnings.push(`已跳过不支持的 3D/实体图元：${type}`);
            }
            while (i < pairs.length && pairs[i][0] !== '0') i++;
        }
    }
    return i < pairs.length ? i + 1 : i;
}

function resolveScaleToMm(insunits, entities, options) {
    if (options.unitOverride) {
        const key = String(options.unitOverride).trim().toLowerCase();
        const factor = UNIT_KEY_TO_MM[key];
        if (factor) return { scaleToMm: factor, unit: UNIT_MM_TO_LABEL.get(factor) || key };
    }
    if (insunits != null && DXF_INSUNITS_TO_MM[insunits] != null) {
        const factor = DXF_INSUNITS_TO_MM[insunits];
        return { scaleToMm: factor, unit: UNIT_MM_TO_LABEL.get(factor) || 'mm' };
    }
    const unitText = entities.find(e => e.type === 'TEXT' && /^Units:\s*/i.test(e.value));
    if (unitText) {
        const raw = unitText.value.replace(/^Units:\s*/i, '').trim().toUpperCase();
        if (raw.includes('METRIC') || raw === 'MM') return { scaleToMm: 1, unit: 'mm' };
        if (raw.includes('ENGLISH') || raw.includes('IMPERIAL') || raw.includes('INCH')) {
            return { scaleToMm: 25.4, unit: 'inch' };
        }
    }
    const defKey = String(options.defaultUnit || 'mm').trim().toLowerCase();
    const factor = UNIT_KEY_TO_MM[defKey] || 1;
    return { scaleToMm: factor, unit: UNIT_MM_TO_LABEL.get(factor) || 'mm' };
}

function makeTransform(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
    return { a, b, c, d, tx, ty };
}

function composeTransform(outer, inner) {
    return {
        a: outer.a * inner.a + outer.b * inner.c,
        b: outer.a * inner.b + outer.b * inner.d,
        c: outer.c * inner.a + outer.d * inner.c,
        d: outer.c * inner.b + outer.d * inner.d,
        tx: outer.a * inner.tx + outer.b * inner.ty + outer.tx,
        ty: outer.c * inner.tx + outer.d * inner.ty + outer.ty
    };
}

function applyTransform(pt, mat) {
    return {
        x: mat.a * pt.x + mat.b * pt.y + mat.tx,
        y: mat.c * pt.x + mat.d * pt.y + mat.ty
    };
}

function isLayerAllowed(layer, includeSet, excludeSet, includeMatcher = null) {
    const key = String(layer || '0').trim().toUpperCase();
    if (excludeSet && excludeSet.has(key)) return false;
    if (includeSet || includeMatcher) {
        const inSet = includeSet ? includeSet.has(key) : false;
        const matched = includeMatcher ? includeMatcher(key) : false;
        if (!inSet && !matched) return false;
    }
    return true;
}

function collectGeometryFromEntities({
    entities,
    blocksMap,
    matrix,
    chordToleranceMm,
    endpointToleranceMm,
    includeSet,
    excludeSet,
    includeMatcher = null,
    warnings,
    depth = 0,
    stack = new Set()
}) {
    const closedRings = [];
    const openChains = [];

    const matScale = Math.max(
        1e-6,
        Math.hypot(matrix.a, matrix.c),
        Math.hypot(matrix.b, matrix.d)
    );
    const localChordTol = Math.max(1e-6, chordToleranceMm / matScale);
    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    const flipped = det < 0;

    for (const ent of entities) {
        if (ent.type === 'TEXT') continue;
        if (ent.type === 'INSERT') {
            if (depth >= 16) {
                warnings.push(`BLOCK 嵌套超过最大深度 16 层，已截断：${ent.blockName}`);
                continue;
            }
            if (stack.has(ent.blockName)) {
                warnings.push(`检测到 BLOCK 循环引用：${ent.blockName}`);
                continue;
            }
            const blk = blocksMap.get(ent.blockName);
            if (!blk) {
                warnings.push(`未找到引用的 BLOCK 定义：${ent.blockName}`);
                continue;
            }
            const rad = (ent.rotDeg * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            stack.add(ent.blockName);
            for (let r = 0; r < ent.rows; r++) {
                for (let c = 0; c < ent.cols; c++) {
                    const offX = c * ent.colSpacing;
                    const offY = r * ent.rowSpacing;
                    const wOffX = ent.tx + (offX * cos - offY * sin);
                    const wOffY = ent.ty + (offX * sin + offY * cos);
                    const insMat = makeTransform(
                        ent.sx * cos,
                        -ent.sy * sin,
                        ent.sx * sin,
                        ent.sy * cos,
                        wOffX - (ent.sx * cos * blk.baseX - ent.sy * sin * blk.baseY),
                        wOffY - (ent.sx * sin * blk.baseX + ent.sy * cos * blk.baseY)
                    );
                    const combined = composeTransform(matrix, insMat);
                    const sub = collectGeometryFromEntities({
                        entities: blk.entities,
                        blocksMap,
                        matrix: combined,
                        chordToleranceMm,
                        endpointToleranceMm,
                        includeSet,
                        excludeSet,
                        includeMatcher,
                        warnings,
                        depth: depth + 1,
                        stack
                    });
                    closedRings.push(...sub.closedRings);
                    openChains.push(...sub.openChains);
                }
            }
            stack.delete(ent.blockName);
            continue;
        }

        if (!isLayerAllowed(ent.layer, includeSet, excludeSet, includeMatcher)) continue;

        if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
            const pts = expandBulgePolyline(ent.vertices, ent.closed, localChordTol).map(p => applyTransform(p, matrix));
            if (pts.length < 2) continue;
            const isImplicitClosed =
                !ent.closed &&
                pts.length >= 3 &&
                Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= endpointToleranceMm;
            if (ent.closed || isImplicitClosed) {
                if (isImplicitClosed && pts.length > 3) pts.pop();
                closedRings.push({ layer: ent.layer, vertices: flipped ? pts.reverse() : pts });
            } else {
                openChains.push({ layer: ent.layer, points: pts });
            }
        } else if (ent.type === 'CIRCLE') {
            const pts = sampleCirclePoints(ent.cx, ent.cy, ent.r, localChordTol).map(p => applyTransform(p, matrix));
            if (pts.length >= 3) {
                closedRings.push({ layer: ent.layer, vertices: flipped ? pts.reverse() : pts });
            }
        } else if (ent.type === 'ARC') {
            const pts = sampleArcPoints(ent.cx, ent.cy, ent.r, ent.startDeg, ent.endDeg, localChordTol).map(p =>
                applyTransform(p, matrix)
            );
            if (pts.length >= 2) {
                openChains.push({ layer: ent.layer, points: pts });
            }
        } else if (ent.type === 'SPLINE') {
            const pts = sampleSplinePoints(ent, localChordTol).map(p => applyTransform(p, matrix));
            if (pts.length < 2) continue;
            const isImplicitClosed =
                !ent.closed &&
                pts.length >= 3 &&
                Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= endpointToleranceMm;
            if (ent.closed || isImplicitClosed) {
                if (isImplicitClosed && pts.length > 3) pts.pop();
                closedRings.push({ layer: ent.layer, vertices: flipped ? pts.reverse() : pts });
            } else {
                openChains.push({ layer: ent.layer, points: pts });
            }
        } else if (ent.type === 'LINE') {
            const p1 = applyTransform({ x: ent.x1, y: ent.y1 }, matrix);
            const p2 = applyTransform({ x: ent.x2, y: ent.y2 }, matrix);
            if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 1e-6) {
                openChains.push({ layer: ent.layer, points: [p1, p2] });
            }
        }
    }

    return { closedRings, openChains };
}

function stitchByLayerAndGlobal(openChains, endpointToleranceMm, warnings) {
    const byLayer = new Map();
    for (const item of openChains) {
        const key = String(item.layer || '0');
        if (!byLayer.has(key)) byLayer.set(key, []);
        byLayer.get(key).push(item.points);
    }
    const closedRings = [];
    const leftover = [];
    for (const [layer, chains] of byLayer.entries()) {
        const { closedRings: layerRings, openRemnants } = stitchOpenSegments(chains, endpointToleranceMm);
        for (const r of layerRings) closedRings.push({ layer, vertices: r });
        for (const rem of openRemnants) leftover.push({ layer, points: rem });
    }
    if (leftover.length > 1) {
        const { closedRings: crossRings, openRemnants: finalOpen } = stitchOpenSegments(
            leftover.map(x => x.points),
            endpointToleranceMm
        );
        for (const r of crossRings) closedRings.push({ layer: leftover[0].layer, vertices: r });
        if (finalOpen.length > 0) {
            warnings.push(`存在 ${finalOpen.length} 条未闭合开放线段/圆弧残段（容差 ${endpointToleranceMm} mm），已跳过`);
        }
    } else if (leftover.length === 1) {
        warnings.push(`存在 1 条未闭合开放线段/圆弧残段（容差 ${endpointToleranceMm} mm），已跳过`);
    }
    return closedRings;
}

function mirrorShapeX(shape) {
    const w = shape.width;
    const mirrorRing = ring =>
        [...ring].reverse().map(p => ({ x: quantize01(w - p.x), y: p.y }));
    return {
        type: 'POLYGON',
        width: w,
        height: shape.height,
        vertices: mirrorRing(shape.vertices),
        ...(shape.holes?.length ? { holes: shape.holes.map(h => mirrorRing(h)) } : {})
    };
}

function isAamaBlock(block) {
    return block.entities.some(
        e => e.type === 'TEXT' && /^(Piece Name:|Fabric:|Size:|Quantity:|Annotation:)/i.test(e.value)
    );
}

/**
 * 通用生产级 DXF 解析主入口（支持二进制 Buffer 或文本字符串）。
 */
export function parseDxfText(input, options = {}) {
    const decoded = decodeTextBuffer(input);
    const pairs = tokenizeDxfPairs(decoded.text);
    const { insunits, blocks, entities, warnings } = parseDxfSections(pairs);

    const fileName = options.fileName || 'pattern.dxf';
    const baseName = fileName.replace(/\.dxf$/i, '');
    const chordToleranceMm = Math.max(0.02, Number(options.chordToleranceMm) || 0.5);
    const endpointToleranceMm = Math.max(0.02, Number(options.endpointToleranceMm) || 0.5);
    const maxVerticesPerRing = Math.max(3, Math.min(128, Number(options.maxVerticesPerRing) || 128));
    const holeLayerKeywords = options.holeLayerKeywords || DEFAULT_HOLE_KEYWORDS;
    const outerLayerKeywords = options.outerLayerKeywords || DEFAULT_OUTER_KEYWORDS;
    const includeSet = Array.isArray(options.includeLayers)
        ? new Set(options.includeLayers.map(s => String(s).trim().toUpperCase()))
        : null;
    const excludeSet = new Set(
        (options.excludeLayers ?? DEFAULT_EXCLUDE_LAYERS).map(s => String(s).trim().toUpperCase())
    );

    const { scaleToMm, unit } = resolveScaleToMm(insunits, entities, options);
    const rootMatrix = makeTransform(scaleToMm, 0, 0, scaleToMm, 0, 0);
    const { allowRotation, allowHalfTurn } = resolveRotationFlags(options.rotationMode);

    const aamaBlocks = [...blocks.values()].filter(isAamaBlock);
    const aamaBlockNames = new Set(aamaBlocks.map(b => b.name));

    const groupsMap = new Map();

    // 1. 解析 AAMA 服装块（防止 ENTITIES 的 1:1 INSERT 重复生成）
    if (aamaBlocks.length > 0) {
        for (const blk of aamaBlocks) {
            const texts = blk.entities.filter(e => e.type === 'TEXT').map(e => e.value);
            const getField = prefix => {
                const line = texts.find(t => t.startsWith(prefix));
                return line ? line.slice(prefix.length).trim() : '';
            };
            const rawPieceName = getField('Piece Name:') || blk.name || '裁片';
            const pieceName = rawPieceName.replace(AAMA_PREFIX_RE, '');
            const fabric = getField('Fabric:') || '面布';
            const size = getField('Size:') || '均码';
            const qtyRaw = getField('Quantity:') || '1';
            const isPair = qtyRaw === '1,1' || texts.some(t => t.includes('L:1-R:1'));
            const qty = isPair ? 2 : Math.max(1, parseInt(qtyRaw, 10) || 1);

            // AAMA 块仅抽取外轮廓层 '1' 与内孔层（如 '11'/HOLE/CUTOUT/HOLE_1），屏蔽缝份层 '14'/内部线 '8' 等
            const aamaAllowed = new Set([
                '1',
                ...holeLayerKeywords.map(k => String(k).trim().toUpperCase()).filter(Boolean)
            ]);
            const aamaHoleMatcher = layerKey => matchesLayerKeywords(layerKey, holeLayerKeywords);
            const blkGeo = collectGeometryFromEntities({
                entities: blk.entities,
                blocksMap: blocks,
                matrix: rootMatrix,
                chordToleranceMm,
                endpointToleranceMm,
                includeSet: aamaAllowed,
                excludeSet,
                includeMatcher: aamaHoleMatcher,
                warnings
            });
            const stitched = stitchByLayerAndGlobal(blkGeo.openChains, endpointToleranceMm, warnings);
            const allRings = [...blkGeo.closedRings, ...stitched];
            if (!allRings.length) continue;

            const built = buildContourShapesWithHoles(allRings, {
                maxVerticesPerRing,
                holeLayerKeywords,
                outerLayerKeywords
            });
            warnings.push(...built.warnings);
            if (!built.shapes.length) continue;

            const primaryShape = built.shapes[0].shape;
            const groupKey = `${fabric} · ${size}码`;
            if (!groupsMap.has(groupKey)) {
                groupsMap.set(groupKey, {
                    materialModel: `DXF-${baseName}-${fabric}`,
                    fabricCode: `${fabric}-${size}码`,
                    demands: [],
                    issues: []
                });
            }
            const g = groupsMap.get(groupKey);
            if (isPair) {
                g.demands.push({
                    id: g.demands.length + 1,
                    name: `${size}码 · ${pieceName}(左)`,
                    width: primaryShape.width,
                    length: primaryShape.height,
                    quantity: 1,
                    allowRotation,
                    ...(allowHalfTurn ? { allowHalfTurn: true } : {}),
                    shape: primaryShape,
                    note: `${fabric} · 左片 (${primaryShape.vertices.length}顶点${primaryShape.holes?.length ? `, ${primaryShape.holes.length}孔` : ''})`
                });
                const rightShape = mirrorShapeX(primaryShape);
                g.demands.push({
                    id: g.demands.length + 1,
                    name: `${size}码 · ${pieceName}(右)`,
                    width: rightShape.width,
                    length: rightShape.height,
                    quantity: 1,
                    allowRotation,
                    ...(allowHalfTurn ? { allowHalfTurn: true } : {}),
                    shape: rightShape,
                    note: `${fabric} · 右镜像片 (${rightShape.vertices.length}顶点${rightShape.holes?.length ? `, ${rightShape.holes.length}孔` : ''})`
                });
            } else {
                g.demands.push({
                    id: g.demands.length + 1,
                    name: `${size}码 · ${pieceName}`,
                    width: primaryShape.width,
                    length: primaryShape.height,
                    quantity: qty,
                    allowRotation,
                    ...(allowHalfTurn ? { allowHalfTurn: true } : {}),
                    shape: primaryShape,
                    note: `${fabric} · 单片 (${primaryShape.vertices.length}顶点${primaryShape.holes?.length ? `, ${primaryShape.holes.length}孔` : ''})`
                });
            }
        }
    }

    // 2. 解析通用顶层 ENTITIES 与非 AAMA INSERT
    const nonAamaEntities = entities.filter(e => !(e.type === 'INSERT' && aamaBlockNames.has(e.blockName)));
    const cadGeo = collectGeometryFromEntities({
        entities: nonAamaEntities,
        blocksMap: blocks,
        matrix: rootMatrix,
        chordToleranceMm,
        endpointToleranceMm,
        includeSet,
        excludeSet,
        warnings
    });
    const cadStitched = stitchByLayerAndGlobal(cadGeo.openChains, endpointToleranceMm, warnings);
    const cadRings = [...cadGeo.closedRings, ...cadStitched];

    if (cadRings.length > 0) {
        const built = buildContourShapesWithHoles(cadRings, {
            maxVerticesPerRing,
            holeLayerKeywords,
            outerLayerKeywords
        });
        warnings.push(...built.warnings);

        if (built.shapes.length > 0) {
            const cadGroupKey = 'CAD_GEOMETRY';
            if (!groupsMap.has(cadGroupKey)) {
                groupsMap.set(cadGroupKey, {
                    materialModel: `DXF-${baseName}`,
                    fabricCode: unit,
                    demands: [],
                    issues: []
                });
            }
            const g = groupsMap.get(cadGroupKey);
            built.shapes.forEach((item, idx) => {
                const s = item.shape;
                g.demands.push({
                    id: g.demands.length + 1,
                    name: `${baseName} · 轮廓 #${idx + 1}`,
                    width: s.width,
                    length: s.height,
                    quantity: 1,
                    allowRotation,
                    ...(allowHalfTurn ? { allowHalfTurn: true } : {}),
                    shape: s,
                    note: `图层 ${item.layer} (${s.vertices.length}顶点${s.holes?.length ? `, ${s.holes.length}内孔` : ''})`
                });
            });
        }
    }

    const groups = [...groupsMap.values()].map((g, index) => ({ ...g, index }));
    if (!groups.length) {
        throw new Error('未能从 DXF 文件中识别出有效闭合裁片轮廓（请检查实体闭合或容差设置）');
    }

    return {
        format: aamaBlocks.length > 0 ? 'AAMA/ASTM 服装 CAD DXF' : '通用 CAD DXF',
        unit,
        scaleToMm,
        encoding: decoded.encoding,
        warnings,
        groups,
        issues: []
    };
}
