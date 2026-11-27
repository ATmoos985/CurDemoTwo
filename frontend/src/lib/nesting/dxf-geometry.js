/**
 * 通用 CAD / DXF 2D 几何离散、容差缝合、内孔嵌套归属与归一化工具（纯 JS 叶子模块）。
 * 对齐后端 PolygonGeometry 契约：3-128 顶点/环、最多 64 孔、0.1 mm 分辨率、外环 CCW / 内孔 CW、左上角归零。
 */

export function quantize01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const q = Math.round(n * 10) / 10;
    return Object.is(q, -0) ? 0 : q;
}

export function signedArea2(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return sum;
}

export function ringArea(points) {
    return Math.abs(signedArea2(points)) / 2;
}

export function ensureCcw(points) {
    return signedArea2(points) < 0 ? [...points].reverse() : points.slice();
}

export function ensureCw(points) {
    return signedArea2(points) > 0 ? [...points].reverse() : points.slice();
}

export function getBoundingBox(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}

function pointToSegmentDistSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-12) {
        return (px - ax) * (px - ax) + (py - ay) * (py - ay);
    }
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/** 射线法判定点是否在多边形内部（含严格离边阈值检查） */
export function pointStrictlyInsideRing(pt, ring, minEdgeDist = 1e-4) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    let inside = false;
    const minDist2 = minEdgeDist * minEdgeDist;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (pointToSegmentDistSq(pt.x, pt.y, a.x, a.y, b.x, b.y) <= minDist2) {
            return false;
        }
        const intersect =
            (a.y > pt.y) !== (b.y > pt.y) &&
            pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
        if (intersect) inside = !inside;
    }
    return inside;
}

function segmentsCrossOrTouch(a, b, c, d, minDist2) {
    if (
        Math.max(a.x, b.x) < Math.min(c.x, d.x) - 1e-6 ||
        Math.max(c.x, d.x) < Math.min(a.x, b.x) - 1e-6 ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y) - 1e-6 ||
        Math.max(c.y, d.y) < Math.min(a.y, b.y) - 1e-6
    ) {
        return false;
    }
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    if (
        pointToSegmentDistSq(c.x, c.y, a.x, a.y, b.x, b.y) <= minDist2 ||
        pointToSegmentDistSq(d.x, d.y, a.x, a.y, b.x, b.y) <= minDist2 ||
        pointToSegmentDistSq(a.x, a.y, c.x, c.y, d.x, d.y) <= minDist2 ||
        pointToSegmentDistSq(b.x, b.y, c.x, c.y, d.x, d.y) <= minDist2
    ) {
        return true;
    }
    return false;
}

/** 校验内环的所有顶点均严格位于外环内部，且任意线段与外环线段无相交或贴边穿刺 */
export function isRingStrictlyInsideRing(innerRing, outerRing, minEdgeDist = 1e-4, knownProbe = null) {
    if (!Array.isArray(innerRing) || innerRing.length < 3 || !Array.isArray(outerRing) || outerRing.length < 3) {
        return false;
    }
    const probe = knownProbe || findInteriorPoint(innerRing);
    if (!probe || !pointStrictlyInsideRing(probe, outerRing, minEdgeDist)) {
        return false;
    }
    for (let i = 0; i < innerRing.length; i++) {
        if (!pointStrictlyInsideRing(innerRing[i], outerRing, minEdgeDist)) {
            return false;
        }
    }
    const minDist2 = minEdgeDist * minEdgeDist;
    for (let i = 0; i < innerRing.length; i++) {
        const a = innerRing[i];
        const b = innerRing[(i + 1) % innerRing.length];
        for (let j = 0; j < outerRing.length; j++) {
            const c = outerRing[j];
            const d = outerRing[(j + 1) % outerRing.length];
            if (segmentsCrossOrTouch(a, b, c, d, minDist2)) {
                return false;
            }
        }
    }
    return true;
}

/** 获取位于环内部的代表点，用于判定包含关系（兼容凹多边形） */
export function findInteriorPoint(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const bbox = getBoundingBox(ring);
    const center = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
    if (pointStrictlyInsideRing(center, ring, 1e-5)) return center;

    // 扫描中心水平线交点中点（对任意非退化简单多边形必能找到内部点）
    const ys = Array.from(new Set(ring.map(p => p.y))).sort((a, b) => a - b);
    for (let i = 0; i + 1 < ys.length; i++) {
        const yMid = (ys[i] + ys[i + 1]) / 2;
        const xs = [];
        for (let k = 0; k < ring.length; k++) {
            const a = ring[k];
            const b = ring[(k + 1) % ring.length];
            if ((a.y <= yMid && b.y > yMid) || (b.y <= yMid && a.y > yMid)) {
                xs.push(a.x + ((yMid - a.y) * (b.x - a.x)) / (b.y - a.y));
            }
        }
        xs.sort((a, b) => a - b);
        if (xs.length >= 2) {
            const candidate = { x: (xs[0] + xs[1]) / 2, y: yMid };
            if (pointStrictlyInsideRing(candidate, ring, 1e-5)) return candidate;
        }
    }
    return ring[0];
}

/** 计算给定圆弧半径与弦高公差下的离散步数 */
function computeArcSteps(radius, sweepRad, chordToleranceMm = 0.5) {
    const absSweep = Math.abs(sweepRad);
    if (absSweep < 1e-6) return 1;
    const tol = Math.max(1e-6, Number(chordToleranceMm) || 0.5);
    const r = Math.max(tol * 1.001, radius);
    const cosArg = Math.max(-1, Math.min(1, 1 - tol / r));
    const maxStep = 2 * Math.acos(cosArg);
    const safeStep = Number.isFinite(maxStep) && maxStep > 1e-3 ? maxStep : absSweep / 8;
    const rawSteps = Math.ceil(absSweep / safeStep);
    return Math.max(2, Math.min(256, rawSteps));
}

/** 将 DXF POLYLINE/LWPOLYLINE 的凸度（bulge = tan(theta/4)）圆弧段离散为点列（含起点与终点） */
export function bulgeToArcPoints(p1, p2, bulge, chordToleranceMm = 0.5) {
    if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-7) {
        return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }];
    }
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-9) {
        return [{ x: p1.x, y: p1.y }];
    }
    const theta = 4 * Math.atan(bulge);
    const alpha = theta / 2;
    const tanAlpha = Math.tan(alpha);
    if (Math.abs(tanAlpha) < 1e-9) {
        return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }];
    }
    const s = (chord / 2) / tanAlpha;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = -dy / chord;
    const ny = dx / chord;
    const cx = mx + nx * s;
    const cy = my + ny * s;
    const radius = Math.hypot(p1.x - cx, p1.y - cy);
    const startAngle = Math.atan2(p1.y - cy, p1.x - cx);
    const steps = computeArcSteps(radius, theta, chordToleranceMm);

    const pts = [{ x: p1.x, y: p1.y }];
    for (let i = 1; i < steps; i++) {
        const ang = startAngle + (theta * i) / steps;
        pts.push({ x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) });
    }
    pts.push({ x: p2.x, y: p2.y });
    return pts;
}

/** 将带顶点凸度的多段线顶点离散为纯折线点列 */
export function expandBulgePolyline(vertices, closed, chordToleranceMm = 0.5) {
    if (!Array.isArray(vertices) || vertices.length === 0) return [];
    const pts = [];
    const count = closed ? vertices.length : vertices.length - 1;
    for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        const seg = bulgeToArcPoints(a, b, Number(a.bulge) || 0, chordToleranceMm);
        if (i === 0) {
            pts.push(...seg);
        } else {
            pts.push(...seg.slice(1));
        }
    }
    if (!closed && vertices.length === 1) {
        pts.push({ x: vertices[0].x, y: vertices[0].y });
    }
    if (closed && pts.length > 1) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) {
            pts.pop();
        }
    }
    return pts;
}

/** 采样圆为闭合顶点环 */
export function sampleCirclePoints(cx, cy, radius, chordToleranceMm = 0.5) {
    if (!Number.isFinite(radius) || radius <= 0) return [];
    const steps = Math.max(8, computeArcSteps(radius, Math.PI * 2, chordToleranceMm));
    const pts = [];
    for (let i = 0; i < steps; i++) {
        const ang = (Math.PI * 2 * i) / steps;
        pts.push({ x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) });
    }
    return pts;
}

/** 采样 DXF ARC（逆时针从 startDeg 到 endDeg） */
export function sampleArcPoints(cx, cy, radius, startDeg, endDeg, chordToleranceMm = 0.5) {
    if (!Number.isFinite(radius) || radius <= 0) return [];
    const s = ((startDeg % 360) + 360) % 360;
    const e = ((endDeg % 360) + 360) % 360;
    let spanDeg = e - s;
    if (spanDeg <= 0) spanDeg += 360;
    const sweepRad = (spanDeg * Math.PI) / 180;
    const startRad = (s * Math.PI) / 180;
    const steps = computeArcSteps(radius, sweepRad, chordToleranceMm);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const ang = startRad + (sweepRad * i) / steps;
        pts.push({ x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) });
    }
    return pts;
}

/** 采样 DXF SPLINE（支持标准有理/非有理 B-Spline 求值及拟合点回退） */
export function sampleSplinePoints({
    degree = 3,
    knots = [],
    controlPoints = [],
    weights = [],
    fitPoints = [],
    closed = false
}, chordToleranceMm = 0.5) {
    if (controlPoints.length >= 2) {
        const p = Math.max(1, Math.min(degree, controlPoints.length - 1));
        let ctrl = controlPoints.map(pt => ({ x: pt.x, y: pt.y }));
        let w = weights.length === ctrl.length ? weights.slice() : ctrl.map(() => 1);
        let knotVec = knots.slice();

        if (closed && knotVec.length === 0) {
            ctrl = [...ctrl, ...ctrl.slice(0, p)];
            w = [...w, ...w.slice(0, p)];
        }
        if (knotVec.length !== ctrl.length + p + 1) {
            // 构造 clamped 均匀节点向量
            const n = ctrl.length - 1;
            const m = n + p + 1;
            knotVec = [];
            for (let i = 0; i <= m; i++) {
                if (closed) {
                    knotVec.push(i);
                } else if (i <= p) {
                    knotVec.push(0);
                } else if (i >= m - p) {
                    knotVec.push(n - p + 1);
                } else {
                    knotVec.push(i - p);
                }
            }
        }

        const uMin = knotVec[p];
        const uMax = knotVec[ctrl.length];
        if (uMax > uMin) {
            // 估算控制多边形总长决定采样点数
            let polyLen = 0;
            for (let i = 1; i < ctrl.length; i++) {
                polyLen += Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].y - ctrl[i - 1].y);
            }
            const tol = Math.max(1e-6, Number(chordToleranceMm) || 0.5);
            const samples = Math.max(16, Math.min(256, Math.ceil(polyLen / Math.max(1e-5, tol * 4))));
            const pts = [];
            for (let s = 0; s <= samples; s++) {
                const u = s === samples ? uMax - 1e-9 : uMin + ((uMax - uMin) * s) / samples;
                const pt = evaluateNurbs(p, knotVec, ctrl, w, u);
                if (pt) pts.push(pt);
            }
            if (closed && pts.length > 1) {
                const first = pts[0];
                const last = pts[pts.length - 1];
                if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) pts.pop();
            }
            if (pts.length >= 2) return pts;
        }
    }
    return fitPoints.map(pt => ({ x: pt.x, y: pt.y }));
}

function evaluateNurbs(p, knots, ctrl, weights, u) {
    const n = ctrl.length - 1;
    let span = p;
    if (u >= knots[n + 1]) {
        span = n;
    } else {
        for (let k = p; k <= n; k++) {
            if (u >= knots[k] && u < knots[k + 1]) {
                span = k;
                break;
            }
        }
    }
    const d = [];
    for (let j = 0; j <= p; j++) {
        const idx = span - p + j;
        const wi = weights[idx] ?? 1;
        d.push({ x: ctrl[idx].x * wi, y: ctrl[idx].y * wi, w: wi });
    }
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const idx = span - p + j;
            const denom = knots[idx + 1 + p - r] - knots[idx];
            const alpha = denom > 1e-12 ? (u - knots[idx]) / denom : 0;
            d[j] = {
                x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
                y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
                w: (1 - alpha) * d[j - 1].w + alpha * d[j].w
            };
        }
    }
    const res = d[p];
    if (!res || Math.abs(res.w) < 1e-12) return null;
    return { x: res.x / res.w, y: res.y / res.w };
}

/** 按端点容差将散落的开放线段/圆弧链拼接为闭合环 */
export function stitchOpenSegments(chains, endpointToleranceMm = 0.5) {
    const tol = Math.max(1e-4, Number(endpointToleranceMm) || 0.5);
    const pool = chains
        .filter(c => Array.isArray(c) && c.length >= 2)
        .map(c => c.map(p => ({ x: p.x, y: p.y })));
    const closedRings = [];
    const openRemnants = [];

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    while (pool.length > 0) {
        const current = pool.shift();
        if (current.length >= 3 && dist(current[0], current[current.length - 1]) <= tol) {
            current.pop();
            closedRings.push(current);
            continue;
        }

        let extended = true;
        while (extended) {
            extended = false;
            const head = current[0];
            const tail = current[current.length - 1];
            let bestIdx = -1;
            let bestDist = tol;
            let attachMode = 'tail-head';

            for (let i = 0; i < pool.length; i++) {
                const cand = pool[i];
                const cHead = cand[0];
                const cTail = cand[cand.length - 1];

                const dTH = dist(tail, cHead);
                if (dTH <= bestDist) { bestDist = dTH; bestIdx = i; attachMode = 'tail-head'; }
                const dTT = dist(tail, cTail);
                if (dTT <= bestDist) { bestDist = dTT; bestIdx = i; attachMode = 'tail-tail'; }
                const dHT = dist(head, cTail);
                if (dHT <= bestDist) { bestDist = dHT; bestIdx = i; attachMode = 'head-tail'; }
                const dHH = dist(head, cHead);
                if (dHH <= bestDist) { bestDist = dHH; bestIdx = i; attachMode = 'head-head'; }
            }

            if (bestIdx >= 0) {
                const [picked] = pool.splice(bestIdx, 1);
                if (attachMode === 'tail-head') {
                    current.push(...picked.slice(1));
                } else if (attachMode === 'tail-tail') {
                    current.push(...picked.reverse().slice(1));
                } else if (attachMode === 'head-tail') {
                    current.unshift(...picked.slice(0, -1));
                } else if (attachMode === 'head-head') {
                    current.unshift(...picked.reverse().slice(0, -1));
                }
                extended = true;
                if (current.length >= 3 && dist(current[0], current[current.length - 1]) <= tol) {
                    current.pop();
                    closedRings.push(current);
                    break;
                }
            }
        }

        if (current.length >= 3 && dist(current[0], current[current.length - 1]) <= tol) {
            // 若上面刚好拼合未入 closedRings
            const lastClosed = closedRings[closedRings.length - 1];
            if (lastClosed !== current) {
                current.pop();
                closedRings.push(current);
            }
        } else if (!closedRings.includes(current)) {
            openRemnants.push(current);
        }
    }

    return { closedRings, openRemnants };
}

/** 最小三角形面积误差抽稀闭合多边形，保证顶点数 <= maxVertices */
export function simplifyClosedPolygon(points, maxVertices = 128) {
    if (!Array.isArray(points) || points.length <= maxVertices) return points ? points.slice() : [];
    const pts = points.slice();
    while (pts.length > maxVertices && pts.length > 3) {
        let minIdx = -1;
        let minErr = Infinity;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const a = pts[(i - 1 + n) % n];
            const b = pts[i];
            const c = pts[(i + 1) % n];
            const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
            if (area2 < minErr) {
                minErr = area2;
                minIdx = i;
            }
        }
        if (minIdx < 0) break;
        pts.splice(minIdx, 1);
    }
    return pts;
}

/** 清理相邻重复点与共线折返尖刺 */
export function cleanPolygonVertices(points, eps = 1e-6) {
    let pts = [];
    for (const p of points || []) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const prev = pts[pts.length - 1];
        if (!prev || Math.abs(prev.x - p.x) > eps || Math.abs(prev.y - p.y) > eps) {
            pts.push({ x: p.x, y: p.y });
        }
    }
    if (pts.length > 1 && Math.abs(pts[0].x - pts[pts.length - 1].x) <= eps && Math.abs(pts[0].y - pts[pts.length - 1].y) <= eps) {
        pts.pop();
    }

    let changed = true;
    let guard = 0;
    while (changed && pts.length >= 3 && guard++ < 64) {
        changed = false;
        const next = [];
        const n = pts.length;
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n];
            const curr = pts[i];
            const after = pts[(i + 1) % n];
            if (Math.abs(curr.x - prev.x) <= eps && Math.abs(curr.y - prev.y) <= eps) {
                changed = true;
                continue;
            }
            const ux = curr.x - prev.x;
            const uy = curr.y - prev.y;
            const vx = after.x - curr.x;
            const vy = after.y - curr.y;
            const cross = ux * vy - uy * vx;
            const dot = ux * vx + uy * vy;
            if (Math.abs(cross) <= 1e-9 && dot < 0) {
                changed = true;
                continue;
            }
            next.push(curr);
        }
        pts = next;
    }
    return pts;
}

function matchesLayerKeywords(layerName, keywords) {
    if (!layerName || !Array.isArray(keywords) || keywords.length === 0) return false;
    const upper = String(layerName).trim().toUpperCase();
    return keywords.some(kw => {
        const k = String(kw).trim().toUpperCase();
        if (!k) return false;
        return upper === k || upper.includes(k);
    });
}

/**
 * 构建带内孔（holes）且满足 PolygonGeometry 契约的外轮廓列表：
 * - 图层语义优先 + 面积降序包含树（奇偶嵌套）建立外环与内孔归属（最多 64 孔）
 * - 外环 CCW (signedArea > 0)、内孔 CW (signedArea < 0)
 * - 抽稀至 <= maxVerticesPerRing (默认 128)、0.1 mm 量化并平移归零 (0, 0)
 */
export function buildContourShapesWithHoles(rawRings, options = {}) {
    const maxVerticesPerRing = Math.max(3, Math.min(128, Number(options.maxVerticesPerRing) || 128));
    const holeLayerKeywords = options.holeLayerKeywords || ['HOLE', 'INNER', 'CUTOUT', 'DRILL', '内孔', '开孔', '孔', '窗口', '11'];
    const outerLayerKeywords = options.outerLayerKeywords || ['OUTER', 'CUT', 'PROFILE', 'BOUNDARY', '外框', '裁切', '1'];
    const warnings = [];

    const validRings = [];
    for (const item of rawRings || []) {
        const cleaned = cleanPolygonVertices(item.vertices || item);
        if (cleaned.length < 3) continue;
        const area = ringArea(cleaned);
        if (area < 0.05) continue;
        const layer = item.layer || '0';
        validRings.push({
            layer,
            vertices: cleaned,
            area,
            bbox: getBoundingBox(cleaned),
            probe: findInteriorPoint(cleaned),
            isHoleLayer: matchesLayerKeywords(layer, holeLayerKeywords),
            isOuterLayer: matchesLayerKeywords(layer, outerLayerKeywords),
            parentIndex: -1,
            depth: 0
        });
    }

    // 面积降序，计算直接父环与嵌套深度
    validRings.sort((a, b) => b.area - a.area);
    for (let i = 0; i < validRings.length; i++) {
        const child = validRings[i];
        if (!child.probe) continue;
        for (let p = i - 1; p >= 0; p--) {
            const cand = validRings[p];
            if (
                child.bbox.minX < cand.bbox.minX - 1e-4 ||
                child.bbox.maxX > cand.bbox.maxX + 1e-4 ||
                child.bbox.minY < cand.bbox.minY - 1e-4 ||
                child.bbox.maxY > cand.bbox.maxY + 1e-4
            ) {
                continue;
            }
            if (isRingStrictlyInsideRing(child.vertices, cand.vertices, 1e-4, child.probe)) {
                child.parentIndex = p;
                child.depth = cand.depth + 1;
                break;
            }
            if (child.isHoleLayer && !child.isOuterLayer && pointStrictlyInsideRing(child.probe, cand.vertices, 1e-4)) {
                child.piercesOuter = true;
            }
        }
    }

    const shapesMap = new Map();
    const role = new Array(validRings.length).fill('outer');

    for (let i = 0; i < validRings.length; i++) {
        const ring = validRings[i];
        if (ring.parentIndex >= 0) {
            if (ring.isHoleLayer && !ring.isOuterLayer) {
                role[i] = 'hole';
            } else if (!ring.isOuterLayer && ring.depth % 2 === 1) {
                role[i] = 'hole';
            } else {
                role[i] = 'outer';
            }
        } else if (ring.piercesOuter) {
            role[i] = 'ignored';
            warnings.push(`内孔图层 "${ring.layer}" 轮廓穿刺或越出外轮廓边界，已跳过`);
        } else if (ring.isHoleLayer && !ring.isOuterLayer) {
            warnings.push(`内孔图层 "${ring.layer}" 轮廓未找到包含它的外轮廓，已按独立外轮廓处理`);
        }
    }

    for (let i = 0; i < validRings.length; i++) {
        if (role[i] === 'outer') {
            shapesMap.set(i, { ring: validRings[i], holes: [] });
        }
    }

    for (let i = 0; i < validRings.length; i++) {
        if (role[i] !== 'hole') continue;
        // 寻找最近的 outer 祖先
        let p = validRings[i].parentIndex;
        while (p >= 0 && role[p] !== 'outer') {
            p = validRings[p].parentIndex;
        }
        if (p >= 0 && shapesMap.has(p)) {
            const container = shapesMap.get(p);
            if (container.holes.length >= 64) {
                warnings.push(`外轮廓内孔数量超过 64 个上限，已截断多余内孔`);
            } else {
                container.holes.push(validRings[i]);
            }
        }
    }

    const shapes = [];
    for (const { ring, holes } of shapesMap.values()) {
        const simplifiedOuter = simplifyClosedPolygon(ensureCcw(ring.vertices), maxVerticesPerRing);
        const minX0 = Math.min(...simplifiedOuter.map(p => p.x));
        const minY0 = Math.min(...simplifiedOuter.map(p => p.y));

        let shiftedOuter = simplifiedOuter.map(p => ({
            x: Math.max(0, quantize01(p.x - minX0)),
            y: Math.max(0, quantize01(p.y - minY0))
        }));
        shiftedOuter = ensureCcw(cleanPolygonVertices(shiftedOuter));
        if (shiftedOuter.length < 3 || ringArea(shiftedOuter) <= 0.05) continue;

        const minX1 = Math.min(...shiftedOuter.map(p => p.x));
        const minY1 = Math.min(...shiftedOuter.map(p => p.y));
        if (minX1 > 0 || minY1 > 0) {
            shiftedOuter = shiftedOuter.map(p => ({
                x: Math.max(0, quantize01(p.x - minX1)),
                y: Math.max(0, quantize01(p.y - minY1))
            }));
        }
        const width = quantize01(Math.max(...shiftedOuter.map(p => p.x)));
        const height = quantize01(Math.max(...shiftedOuter.map(p => p.y)));
        if (width <= 0 || height <= 0) continue;

        const normHoles = [];
        for (const h of holes) {
            const simpHole = simplifyClosedPolygon(ensureCw(h.vertices), maxVerticesPerRing);
            let shiftedHole = simpHole.map(p => ({
                x: Math.max(0, quantize01(p.x - minX0 - minX1)),
                y: Math.max(0, quantize01(p.y - minY0 - minY1))
            }));
            shiftedHole = ensureCw(cleanPolygonVertices(shiftedHole));
            if (shiftedHole.length < 3 || ringArea(shiftedHole) <= 0.05) continue;
            const probe = findInteriorPoint(shiftedHole);
            if (!probe || !isRingStrictlyInsideRing(shiftedHole, shiftedOuter, 1e-4, probe)) {
                warnings.push('已跳过量化后穿刺边界、贴边或越界的内孔');
                continue;
            }
            normHoles.push(shiftedHole);
        }

        shapes.push({
            layer: ring.layer,
            shape: {
                type: 'POLYGON',
                width,
                height,
                vertices: shiftedOuter,
                ...(normHoles.length > 0 ? { holes: normHoles } : {})
            }
        });
    }

    return { shapes, warnings };
}
