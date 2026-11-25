import {rectangle} from '../../canvas/nesting-scene.js';

const VALID_START_CORNERS = new Set(['left-top', 'right-top', 'left-bottom', 'right-bottom']);
const VALID_FIRST_STAGE = new Set(['horizontal', 'vertical']);

/** 量化至 0.1 mm 引擎坐标分辨率，消除浮点噪声与 0.01 mm 亚分辨率被拒问题。 */
export function quantize01(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const q = Math.round(n * 10) / 10;
    return Object.is(q, -0) ? 0 : q;
}

/** 对超过 128 个顶点的闭合多边形做最小误差抽稀，满足后端 3–128 顶点契约。 */
function simplifyClosedPolygon(points, maxVertices = 128) {
    if (points.length <= maxVertices) return points;
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

/** 清理量化后可能出现的相邻重复点或共线折返尖刺（PolygonGeometry 禁止折返重叠）。 */
function cleanPolygonVertices(points) {
    let pts = points.slice();
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
            if (Math.abs(curr.x - prev.x) <= 1e-6 && Math.abs(curr.y - prev.y) <= 1e-6) {
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

/** 计算闭合轮廓的有向面积（2倍），用于判定轮廓或内孔是否退化。 */
function signedArea2(points) {
    let area2 = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area2 += a.x * b.y - b.x * a.y;
    }
    return area2;
}

/** 按与外轮廓一致的原点平移与 0.1 mm 分辨率归一化单个闭合内孔，剔除重复点、共线折返并控制顶点数 <= 128。 */
function normalizeHoleRing01(rawHole, minX0, minY0, minX1 = 0, minY1 = 0) {
    const rawPts = Array.isArray(rawHole) ? rawHole : rawHole?.vertices;
    if (!Array.isArray(rawPts) || rawPts.length < 3) return null;
    const shifted = [];
    for (const v of rawPts) {
        const rx = Array.isArray(v) ? Number(v[0]) : Number(v?.x);
        const ry = Array.isArray(v) ? Number(v[1]) : Number(v?.y);
        if (!Number.isFinite(rx) || !Number.isFinite(ry)) continue;
        let x = Math.max(0, quantize01(rx - minX0));
        let y = Math.max(0, quantize01(ry - minY0));
        if (minX1 > 0 || minY1 > 0) {
            x = Math.max(0, quantize01(x - minX1));
            y = Math.max(0, quantize01(y - minY1));
        }
        const prev = shifted[shifted.length - 1];
        if (!prev || Math.abs(prev.x - x) > 1e-6 || Math.abs(prev.y - y) > 1e-6) {
            shifted.push({x, y});
        }
    }
    if (shifted.length > 1) {
        const first = shifted[0];
        const last = shifted[shifted.length - 1];
        if (Math.abs(first.x - last.x) <= 1e-6 && Math.abs(first.y - last.y) <= 1e-6) {
            shifted.pop();
        }
    }
    const cleaned = simplifyClosedPolygon(cleanPolygonVertices(shifted), 128);
    if (cleaned.length < 3 || Math.abs(signedArea2(cleaned)) <= 1e-5) return null;
    return cleaned;
}

/** 批量归一化多边形内孔列表（最多保留 64 个有效内孔，与后端 PolygonGeometry 契约一致）。 */
function normalizePolygonHoles01(rawHoles, minX0, minY0, minX1 = 0, minY1 = 0) {
    if (!Array.isArray(rawHoles) || rawHoles.length === 0) return [];
    const normalized = [];
    for (const rawHole of rawHoles) {
        if (normalized.length >= 64) break;
        const ring = normalizeHoleRing01(rawHole, minX0, minY0, minX1, minY1);
        if (ring) normalized.push(ring);
    }
    return normalized;
}

/** 归一化多边形顶点（含可选内孔 holes）至 0.1 mm 分辨率、局部 (0,0) 原点，剔除重复点、共线折返并控制顶点数 <= 128。 */
export function normalizePolygonShape01(shape, fallbackW = 100, fallbackH = 100) {
    const fallbackRect = () => {
        const w = Math.max(0.1, quantize01(shape?.width ?? fallbackW, 100));
        const h = Math.max(0.1, quantize01(shape?.height ?? fallbackH, 100));
        const holes = normalizePolygonHoles01(shape?.holes, 0, 0, 0, 0);
        return {
            type: 'POLYGON',
            width: w,
            height: h,
            vertices: [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}],
            ...(holes.length > 0 ? {holes} : {})
        };
    };
    const rawVerts = Array.isArray(shape?.vertices) ? shape.vertices : [];
    if (rawVerts.length < 3) return fallbackRect();
    const finite = rawVerts.map(v => ({x: Number(v.x) || 0, y: Number(v.y) || 0}));
    const minX0 = Math.min(...finite.map(v => v.x));
    const minY0 = Math.min(...finite.map(v => v.y));
    const shifted = finite.map(v => ({
        x: Math.max(0, quantize01(v.x - minX0)),
        y: Math.max(0, quantize01(v.y - minY0))
    }));
    const dedup = [];
    for (const pt of shifted) {
        const prev = dedup[dedup.length - 1];
        if (!prev || Math.abs(prev.x - pt.x) > 1e-6 || Math.abs(prev.y - pt.y) > 1e-6) {
            dedup.push(pt);
        }
    }
    if (dedup.length > 1) {
        const first = dedup[0];
        const last = dedup[dedup.length - 1];
        if (Math.abs(first.x - last.x) <= 1e-6 && Math.abs(first.y - last.y) <= 1e-6) {
            dedup.pop();
        }
    }
    let cleaned = simplifyClosedPolygon(cleanPolygonVertices(dedup), 128);
    if (cleaned.length < 3) return fallbackRect();
    const minX = Math.min(...cleaned.map(v => v.x));
    const minY = Math.min(...cleaned.map(v => v.y));
    if (minX > 0 || minY > 0) {
        cleaned = cleaned.map(v => ({x: Math.max(0, quantize01(v.x - minX)), y: Math.max(0, quantize01(v.y - minY))}));
    }
    const maxX = Math.max(...cleaned.map(v => v.x));
    const maxY = Math.max(...cleaned.map(v => v.y));
    const area2 = signedArea2(cleaned);
    if (maxX <= 0 || maxY <= 0 || Math.abs(area2) <= 1e-5) return fallbackRect();
    const holes = normalizePolygonHoles01(shape?.holes, minX0, minY0, minX, minY);
    return {
        type: 'POLYGON',
        width: quantize01(maxX),
        height: quantize01(maxY),
        vertices: cleaned,
        ...(holes.length > 0 ? {holes} : {})
    };
}

/**
 * 将工作台/用户全局设置安全适配为严格符合 v2 NestingProblem 契约的请求：
 * 1. CONTOUR 强制使用 left-top + none 首刀，并将 trimStart 转为顶部禁入区（与 ContourWorkflow 一致）；
 * 2. GUILLOTINE 当 pieceGap > 0 时按 FabricSolveAdapter 同口径做外扩求解，配套 unpadGuillotineResult 还原；
 * 3. 全量坐标与尺寸量化至 0.1 mm，去重裁片 ID，裁剪越界疵点并限制最大件数/顶点数。
 */
export function buildSafeNestingRequest2D({
    strategy,
    scenario = 'SHORTEN_KIT',
    widthMm,
    lengthMm,
    pieceGapMm = 0,
    trimStartMm = 0,
    demands = [],
    defects = [],
    maxLengthCapMm = undefined,
    settings = {}
}) {
    const validRaw = demands.filter(d => d && Number(d.quantity) > 0 && Number(d.width) > 0 && Number(d.length) > 0);
    if (!validRaw.length) {
        return {error: '没有可排的有效裁片需求'};
    }

    const hasHoles = d => Array.isArray(d?.shape?.holes) && d.shape.holes.length > 0;
    const hasPolygon = validRaw.some(d => d.shape?.type === 'POLYGON' || hasHoles(d));
    const mode = hasPolygon ? 'CONTOUR' : 'GUILLOTINE';
    const engine = strategy.enginePref === 'deepnest'
        ? (mode === 'CONTOUR' ? 'deepnest' : 'javaguillotine')
        : strategy.enginePref === 'java'
        ? (mode === 'CONTOUR' ? 'javairregular' : 'javaguillotine')
        : 'auto';

    const openLengthScenario = scenario !== 'FIXED_BED';
    const useShorten = openLengthScenario && (Boolean(strategy.shorten) || scenario === 'MULTI_WIDTH');
    const useGapFill = scenario === 'SHORTEN_GAP_FILL' || Boolean(strategy.gapFill);

    const safeWidth = Math.max(1, quantize01(widthMm, 1500));
    const baseLength = Math.max(1, quantize01(lengthMm, 2000));
    const safeGap = Math.min(100, Math.max(0, quantize01(pieceGapMm, 0)));
    const rawTrim = Math.max(0, quantize01(trimStartMm, 0));

    // 去重并确保所有需求 ID 为唯一正整数
    const usedIds = new Set();
    let nextAutoId = 1;
    const allocateId = candidate => {
        const n = Math.floor(Number(candidate));
        if (Number.isInteger(n) && n > 0 && !usedIds.has(n)) {
            usedIds.add(n);
            return n;
        }
        while (usedIds.has(nextAutoId)) nextAutoId++;
        usedIds.add(nextAutoId);
        return nextAutoId++;
    };

    // 策略仅可在需求自身允许的方向约束范围内收敛（如 lockZeroGrain 强制 0° 经向），绝不越权放开禁用旋转/半转的裁片
    const lockZeroGrain = Boolean(
        strategy.lockZeroGrain || strategy.id === 'PS_FIXED' || strategy.id === 'DN_FIXED'
    );
    const origParts = validRaw.map((d, idx) => {
        const id = allocateId(d.id ?? idx + 1);
        const w01 = Math.max(0.1, quantize01(d.width));
        const l01 = Math.max(0.1, quantize01(d.length));
        const baseShape = mode === 'CONTOUR'
            ? (d.shape?.type === 'POLYGON' || hasHoles(d)
                ? normalizePolygonShape01(d.shape, w01, l01)
                : normalizePolygonShape01(null, w01, l01))
            : rectangle(w01, l01);
        const allowRot90 = !lockZeroGrain && Boolean(d.allowRotation);
        const allowHalfTurn180 = mode === 'CONTOUR' && !lockZeroGrain && Boolean(d.allowHalfTurn);
        return {
            id,
            name: String(d.name || `裁片 #${id}`),
            quantity: Math.max(1, Math.floor(Number(d.quantity))),
            allowRotation: allowRot90,
            ...(allowHalfTurn180 ? {allowHalfTurn: true} : {}),
            shape: baseShape
        };
    });

    const totalQty = origParts.reduce((s, p) => s + p.quantity, 0);
    if (totalQty > 10000) {
        return {error: `单次求解最多支持 10000 件（当前 ${totalQty} 件），请分批排程`};
    }
    if (mode === 'CONTOUR') {
        const totalVertices = origParts.reduce(
            (s, p) => s + ((p.shape.vertices?.length || 4) + (p.shape.holes || []).reduce((hs, h) => hs + h.length, 0)) * p.quantity,
            0
        );
        if (totalQty > 200 || totalVertices > 10000) {
            return {error: `异形轮廓单次最多 200 件、10000 顶点（当前 ${totalQty} 件 / ${totalVertices} 顶点），请减少套数或分批排程`};
        }
    }

    // 估算安全初始试排长度（含修边与间距）
    let rowX = 0;
    let rowY = rawTrim;
    let rowH = 0;
    for (const p of origParts) {
        for (let i = 0; i < p.quantity; i++) {
            if (rowX + p.shape.width > safeWidth) {
                rowY += rowH + safeGap;
                rowX = 0;
                rowH = 0;
            }
            rowX += p.shape.width + safeGap;
            rowH = Math.max(rowH, p.shape.height);
        }
    }
    const rawHeight = openLengthScenario
        ? Math.max(baseLength, Math.ceil(rowY + rowH + 180))
        : baseLength;
    const cap01 = maxLengthCapMm != null && Number(maxLengthCapMm) > 0
        ? Math.max(1, quantize01(maxLengthCapMm))
        : null;
    const safeStartHeight = cap01 != null ? Math.min(quantize01(rawHeight), cap01) : quantize01(rawHeight);
    const effectiveTrim = rawTrim > 0 && rawTrim < safeStartHeight - 1 ? rawTrim : 0;

    // 矩形间距外扩适配（与 FabricSolveAdapter 保持完全一致）
    const rectGapPadding = mode === 'GUILLOTINE' && safeGap > 0 ? safeGap : 0;
    const solverMaterialW = quantize01(safeWidth + rectGapPadding);
    const solverMaterialH = quantize01(safeStartHeight + rectGapPadding);
    const solverParts = rectGapPadding > 0
        ? origParts.map(p => ({
            ...p,
            shape: rectangle(quantize01(p.shape.width + rectGapPadding), quantize01(p.shape.height + rectGapPadding))
        }))
        : origParts;

    // 疵点裁剪、量化并分配唯一递增 ID
    const defaultDefectMargin = Math.max(0, quantize01(settings.defectMarginMm ?? 0));
    const exclusions = [];
    for (const d of defects || []) {
        if (!d) continue;
        const margin = Math.max(0, quantize01(d.margin ?? defaultDefectMargin));
        const dx = Number(d.x) || 0;
        const dy = Number(d.y) || 0;
        const dw = Number(d.w) || 0;
        const dh = Number(d.h) || 0;
        if (dw <= 0 || dh <= 0) continue;
        const x0 = Math.max(0, quantize01(dx - margin));
        const y0 = Math.max(0, quantize01(dy - margin));
        const x1 = Math.min(safeWidth, quantize01(dx + dw + margin));
        const y1 = Math.min(safeStartHeight, quantize01(dy + dh + margin));
        const ew = quantize01(x1 - x0);
        const eh = quantize01(y1 - y0);
        if (ew >= 0.1 && eh >= 0.1 && x0 < safeWidth && y0 < safeStartHeight) {
            exclusions.push({
                id: exclusions.length + 1,
                x: x0,
                y: y0,
                shape: rectangle(ew, eh),
                clearance: 0
            });
        }
    }
    // 轮廓排料模式下，将首端修边转化为顶部禁入区（与 ContourWorkflow 一致），保留真实避让且满足 trimStart=0 契约
    if (mode === 'CONTOUR' && effectiveTrim >= 0.1 && exclusions.length < 128) {
        exclusions.push({
            id: exclusions.length + 1,
            x: 0,
            y: 0,
            shape: rectangle(solverMaterialW, effectiveTrim),
            clearance: 0
        });
    }
    const boundedExclusions = mode === 'CONTOUR' ? exclusions.slice(0, 128) : exclusions;

    const timeScale = Math.max(0.2, (Number(settings.timeLimitSeconds) || 5) / 5);
    const scaledTimeLimit = Math.min(60, Math.max(1, Math.round((Number(strategy.timeLimit) || 5) * timeScale)));

    const startCorner = mode === 'CONTOUR'
        ? 'left-top'
        : (VALID_START_CORNERS.has(settings.startCorner) ? settings.startCorner : 'left-top');
    const firstStageOrientation = mode === 'CONTOUR'
        ? 'none'
        : (VALID_FIRST_STAGE.has(settings.firstStageOrientation) ? settings.firstStageOrientation : 'horizontal');
    const minRemW = mode === 'CONTOUR' ? 0 : Math.max(0, quantize01(settings.minRemnantWidthMm ?? 200));
    const minRemH = mode === 'CONTOUR' ? 0 : Math.max(0, quantize01(settings.minRemnantLengthMm ?? 300));

    const problem = {
        schemaVersion: '1',
        unit: 'mm',
        engine,
        timeLimitSeconds: scaledTimeLimit,
        material: {
            id: `CANVAS-${safeWidth}x${safeStartHeight}`,
            shape: rectangle(solverMaterialW, solverMaterialH),
            continuesAfterRegion: false,
            exclusions: boundedExclusions
        },
        parts: solverParts,
        process: {
            mode,
            feedMode: 'SHEET',
            startCorner,
            firstStageOrientation,
            trimStart: mode === 'CONTOUR' ? 0 : effectiveTrim,
            minReusableWidth: minRemW,
            minReusableHeight: minRemH,
            kerf: 0,
            objective: 'MAXIMIZE_PIECE_AREA',
            pieceGap: mode === 'CONTOUR' ? safeGap : 0
        }
    };

    const fitsWidth = origParts.every(p =>
        p.shape.width <= safeWidth || (p.allowRotation && p.shape.height <= safeWidth)
    );
    const canUseMarkerStrategy = mode === 'CONTOUR'
        && useShorten
        && strategy.enginePref !== 'java'
        && fitsWidth;

    const strategyBlock = canUseMarkerStrategy
        ? {
            id: 'marker-shortening',
            version: '2',
            maxTrials: 7,
            ...(useGapFill
                ? {
                    gapFillLimits: Object.fromEntries(
                        origParts.slice(0, 80).map(p => [p.id, Math.min(80, Math.max(2, p.quantity))])
                    )
                }
                : {})
        }
        : undefined;

    return {
        error: null,
        rectGapPadding,
        origParts,
        origWidthMm: safeWidth,
        origHeightMm: safeStartHeight,
        request: {
            schemaVersion: '2.0',
            clientRequestId: `studio-${strategy.id}-${safeWidth}-${Date.now()}`,
            problemType: 'NESTING_2D',
            allowFallback: settings.allowFallback !== false,
            requireComplete: Boolean(canUseMarkerStrategy),
            problem,
            ...(strategyBlock ? {strategy: strategyBlock} : {})
        }
    };
}

/** 矩形间距外扩求解返回后，将裁片还原为真实净尺寸，并将余料与刀路裁剪回原始门幅/版长范围。 */
export function unpadGuillotineResult(result, {rectGapPadding = 0, origParts = [], origWidthMm = 0, origHeightMm = 0} = {}) {
    if (!result?.layout || !rectGapPadding || rectGapPadding <= 0) return result;
    const partMap = new Map(origParts.map(p => [p.id, p]));
    const placements = (result.layout.placements || []).map(pl => {
        const orig = partMap.get(pl.demandId);
        const rotated = Number(pl.rotationDegrees) % 180 !== 0;
        const w = orig
            ? (rotated ? orig.shape.height : orig.shape.width)
            : Math.max(0.1, quantize01((pl.shape?.width || 0) - rectGapPadding));
        const h = orig
            ? (rotated ? orig.shape.width : orig.shape.height)
            : Math.max(0.1, quantize01((pl.shape?.height || 0) - rectGapPadding));
        return {
            ...pl,
            x: Math.max(0, Math.min(origWidthMm - w, quantize01(pl.x))),
            y: Math.max(0, Math.min(origHeightMm - h, quantize01(pl.y))),
            shape: rectangle(w, h)
        };
    });
    const leftovers = (result.layout.leftovers || [])
        .map(rm => {
            const x0 = Math.max(0, quantize01(rm.x));
            const y0 = Math.max(0, quantize01(rm.y));
            const x1 = Math.min(origWidthMm, quantize01(x0 + (rm.shape?.width || 0)));
            const y1 = Math.min(origHeightMm, quantize01(y0 + (rm.shape?.height || 0)));
            const rw = quantize01(x1 - x0);
            const rh = quantize01(y1 - y0);
            if (rw < 0.1 || rh < 0.1) return null;
            return {...rm, x: x0, y: y0, shape: rectangle(rw, rh)};
        })
        .filter(Boolean);
    const cuts = (result.layout.cuts || [])
        .map(c => {
            const sx = Math.max(0, Math.min(origWidthMm, quantize01(c.startX)));
            const sy = Math.max(0, Math.min(origHeightMm, quantize01(c.startY)));
            const ex = Math.max(0, Math.min(origWidthMm, quantize01(c.endX)));
            const ey = Math.max(0, Math.min(origHeightMm, quantize01(c.endY)));
            if (Math.abs(sx - ex) < 0.1 && Math.abs(sy - ey) < 0.1) return null;
            return {...c, startX: sx, startY: sy, endX: ex, endY: ey};
        })
        .filter(Boolean);
    const pieceAreaMm2 = placements.reduce((s, p) => s + p.shape.width * p.shape.height, 0);
    const reusableAreaMm2 = leftovers.reduce((s, r) => s + r.shape.width * r.shape.height, 0);
    const processingAreaMm2 = origWidthMm * origHeightMm;
    return {
        ...result,
        layout: {
            ...result.layout,
            processingRegion: rectangle(origWidthMm, origHeightMm),
            placements,
            leftovers,
            cuts,
            metrics: {
                ...(result.layout.metrics || {}),
                processingAreaMm2,
                pieceAreaMm2,
                reusableAreaMm2,
                unassignedAreaMm2: Math.max(0, processingAreaMm2 - pieceAreaMm2 - reusableAreaMm2)
            }
        }
    };
}
