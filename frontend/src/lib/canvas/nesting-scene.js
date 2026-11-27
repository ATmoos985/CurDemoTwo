/** Pure presentation model. No inventory, task store, DOM or transport dependencies. */
export const rectangle = (width, height) => ({ type: 'RECTANGLE', width, height });

export function shapeVertices(value) {
    return value.type === 'RECTANGLE' ? [{ x: 0, y: 0 }, { x: value.width, y: 0 },
        { x: value.width, y: value.height }, { x: 0, y: value.height }] : value.vertices;
}
function ringAreaMm2(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
}
export function shapeArea(value) {
    if (!value) return 0;
    const outer = value.type === 'RECTANGLE'
        ? Math.max(0, Number(value.width) || 0) * Math.max(0, Number(value.height) || 0)
        : ringAreaMm2(shapeVertices(value));
    if (!Array.isArray(value.holes) || value.holes.length === 0) {
        return outer;
    }
    let holesArea = 0;
    for (const hole of value.holes) {
        holesArea += ringAreaMm2(hole);
    }
    return Math.max(0, outer - holesArea);
}
export function polygon(vertices, holes = []) {
    const normalizedHoles = Array.isArray(holes)
        ? holes
            .filter(h => Array.isArray(h) && h.length >= 3)
            .map(h => h.map(p => ({ x: p.x, y: p.y })))
        : [];
    return {
        type: 'POLYGON',
        width: Math.max(...vertices.map(p => p.x)),
        height: Math.max(...vertices.map(p => p.y)),
        vertices,
        ...(normalizedHoles.length > 0 ? { holes: normalizedHoles } : {})
    };
}
function shape(value) {
    if (!['RECTANGLE', 'POLYGON'].includes(value?.type)) throw new Error('画布仅支持矩形和简单多边形轮廓');
    if (![value.width, value.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('材料或裁片尺寸无效');
    if (value.type === 'POLYGON') {
        if (!Array.isArray(value.vertices) || value.vertices.length < 3 || value.vertices.length > 128
            || !value.vertices.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0)) throw new Error('多边形需要 3–128 个有效顶点');
        const points = value.vertices.map(p => ({ x: p.x, y: p.y }));
        if (Math.abs(Math.min(...points.map(p => p.x))) > 1e-7 || Math.abs(Math.min(...points.map(p => p.y))) > 1e-7
            || Math.abs(Math.max(...points.map(p => p.x)) - value.width) > 1e-7 || Math.abs(Math.max(...points.map(p => p.y)) - value.height) > 1e-7)
            throw new Error('多边形须按外接框左上角归零，宽高与轮廓一致');
        const holes = Array.isArray(value.holes) && value.holes.length > 0
            ? value.holes
                .filter(ring => Array.isArray(ring) && ring.length >= 3)
                .map(ring => ring.map(p => {
                    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0) {
                        throw new Error('多边形内孔顶点坐标无效');
                    }
                    return { x: p.x, y: p.y };
                }))
            : [];
        return {
            type: 'POLYGON',
            width: value.width,
            height: value.height,
            vertices: points,
            ...(holes.length > 0 ? { holes } : {})
        };
    }
    return rectangle(value.width, value.height);
}
function position(item) {
    if (![item.x, item.y].every(Number.isFinite)) throw new Error('几何坐标无效');
    return { ...item, shape: shape(item.shape) };
}

/** Output shapes are already transformed; rotationDegrees must NOT rotate them again. */
export function createNestingScene(problem, result = null) {
    if (problem?.schemaVersion !== '1' || problem?.unit !== 'mm') throw new Error('画布需要 v1 毫米制裁切输入');
    const materialShape = shape(problem.material?.shape);
    if (result) {
        if (result.schemaVersion !== '1' || result.unit !== 'mm' || result.coordinateSystem !== 'source-local-top-left')
            throw new Error('求解结果的版本、单位或坐标系不匹配');
        if (!['FEASIBLE', 'NO_SOLUTION_FOUND'].includes(result.status)) throw new Error(result.message || '求解未成功');
        const region = shape(result.processingRegion);
        if (result.materialId !== problem.material.id || JSON.stringify(region) !== JSON.stringify(materialShape))
            throw new Error('求解结果与当前材料不匹配，请重新求解');
    }
    const cuts = (result?.cuts || []).map(c => {
        if (![c.startX, c.startY, c.endX, c.endY].every(Number.isFinite)) throw new Error('刀路坐标无效');
        return { ...c };
    });
    return {
        unit: 'mm', material: { id: problem.material.id, shape: materialShape },
        region: { x: 0, y: 0, shape: materialShape },
        exclusions: (problem.material.exclusions || []).map(position),
        placements: (result?.placements || []).map(position),
        leftovers: (result?.leftovers || []).map(position), cuts,
        contours: (result?.contours || []).map(c => {
            if (!c.closed || !Array.isArray(c.vertices) || c.vertices.length < 3 || !c.vertices.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('轮廓坐标无效');
            return { ...c, vertices: c.vertices.map(p => ({ ...p })) };
        }),
        process: { ...problem.process },
        parts: (problem.parts || []).map(p => ({ ...p, shape: shape(p.shape) })),
        fulfillment: (result?.fulfillment || []).map(f => ({ ...f })),
        metrics: result?.metrics ? { ...result.metrics } : null,
        status: result?.status || 'INPUT', engine: result?.engine || null
    };
}

export function sceneOrigin(scene) {
    const { region, process } = scene;
    const right = (process.startCorner || 'right-bottom').startsWith('right');
    const bottom = (process.startCorner || 'right-bottom').endsWith('bottom');
    const trim = process.trimStart || 0;
    return { x: region.x + (right ? region.shape.width : 0),
        y: region.y + (bottom ? region.shape.height - trim : trim) };
}
