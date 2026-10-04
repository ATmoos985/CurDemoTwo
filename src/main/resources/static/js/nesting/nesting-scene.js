/** Pure presentation model. No inventory, task store, DOM or transport dependencies. */
export const rectangle = (width, height) => ({ type: 'RECTANGLE', width, height });

function shape(value) {
    if (value?.type !== 'RECTANGLE') throw new Error('当前画布仅支持矩形轮廓');
    if (![value.width, value.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('材料或裁片尺寸无效');
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
        if (result.materialId !== problem.material.id || region.width !== materialShape.width || region.height !== materialShape.height)
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
