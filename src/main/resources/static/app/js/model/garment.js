import {markerExample} from '../../../js/nesting/marker-demo.js';

export const GARMENT_EXAMPLES = [
    {id:'dxf-1226-mixed', name:'[DXF] 1226 卫衣大货版 · 120/140码三门幅对比', style:'DXF_1226', M:1, L:1, widths:[1550,1650,1800], edge:30, gsm:280},
    {id:'dxf-20148d-mixed', name:'[DXF] 20148D 二套版 T恤 · 120/140码门幅试算', style:'DXF_20148D', M:1, L:1, widths:[1500,1650,1800], edge:25, gsm:200},
    {id:'dxf-3129-suit', name:'[DXF] 3129 连帽套装 · 120/140码全套面布搭切', style:'DXF_3129', M:1, L:1, widths:[1650,1750,1850], edge:30, gsm:320},
    {id:'dxf-1226-batch', name:'[DXF] 1226 卫衣大货版 · 2件120搭1件140密排', style:'DXF_1226', M:2, L:1, widths:[1650,1850], edge:30, gsm:280},
    {id:'shirt-mixed', name:'上衣 · 三种门幅对比', style:'GARMENT_SHIRT', M:1, L:1, widths:[1600,1850,1950], edge:0, gsm:200},
    {id:'shirt-three', name:'上衣 · 两件 M 搭一件 L', style:'GARMENT_SHIRT', M:2, L:1, widths:[1600,1850], edge:0, gsm:200},
    {id:'pants-denim', name:'长裤 · 单码厚牛仔', style:'GARMENT_PANTS', M:0, L:1, widths:[1450,1550], edge:40, gsm:360},
    {id:'skirt-light', name:'半裙 · 双码轻薄料', style:'GARMENT_SKIRT', M:1, L:1, widths:[1400,1500], edge:20, gsm:135},
    {id:'tank-knit', name:'背心 · 针织包条', style:'GARMENT_TANK', M:1, L:1, widths:[1500,1750], edge:30, gsm:165},
    {id:'shorts-pair', name:'短裤 · 同码双件', style:'GARMENT_SHORTS', M:2, L:0, widths:[1450,1600], edge:20, gsm:220},
    {id:'apron-canvas', name:'围裙 · 帆布长系带', style:'GARMENT_APRON', M:1, L:1, widths:[1200,1500], edge:25, gsm:280},
    {id:'gored-skirt', name:'六片裙 · 梯形裙片交错密排', style:'GARMENT_GORED_SKIRT', M:2, L:0, widths:[1270,1400], edge:20, gsm:180},
    {id:'gathered-skirt', name:'抽褶裙 · 直裁满幅对照', style:'GARMENT_GATHERED_SKIRT', M:2, L:0, widths:[1400,1500], edge:20, gsm:150},
    {id:'tank-six', name:'背心 · 混码六件合排', style:'GARMENT_TANK', M:3, L:3, widths:[1750], edge:30, gsm:165}
];

export function markerRequest(style, width, sizeCounts, clientRequestId, allowHalfTurn = false, gapFill = false) {
    const problem = markerExample(width, style, sizeCounts);
    if (allowHalfTurn) problem.parts.forEach(part => { part.allowHalfTurn = true; });
    const strategy = {id:'marker-shortening', version:'2', maxTrials:7};
    if (gapFill) {
        // Spare stock is capped at two garments of each requested size regardless of the order quantity.
        const oneEach = {M:Math.min(1, sizeCounts.M), L:Math.min(1, sizeCounts.L)};
        const perSize = markerExample(width, style, oneEach).parts;
        strategy.gapFillLimits = Object.fromEntries(perSize.map(part => [part.id, 2 * part.quantity]));
    }
    return {schemaVersion: '2.0', clientRequestId, problemType: 'NESTING_2D', allowFallback: true,
        requireComplete: true, problem: {...problem, timeLimitSeconds: gapFill ? 15 : 14}, strategy};
}

export function candidateWidths(input) {
    const values = [...new Set(input.trim().split(/[\s,，、]+/u).map(Number))];
    if (values.length > 8 || values.some(w => !Number.isFinite(w) || w < 1200 || w > 2000))
        throw new Error('请输入 1–8 个 1200–2000 mm 的有效幅宽，以逗号或空格分隔');
    return values;
}

export function fabricConsumption(result, width, edge, gsm, garmentCount) {
    const length = result.marker?.occupiedLengthMm;
    const utilization = result.metrics?.find(m => m.name === 'markerAreaUtilization')?.value;
    if (result.validationStatus !== 'PASSED' || result.fulfillmentStatus !== 'COMPLETE'
        || !result.meetsRequirement || !Number.isFinite(length) || length <= 0 || !Number.isFinite(utilization)) return null;
    const lengthPerGarment = length / garmentCount;
    const consumption = {length, utilization, lengthPerGarment,
        gramsPerGarment: (width + edge) * lengthPerGarment * gsm / 1_000_000};
    const withFill = result.metrics.find(m => m.name === 'markerAreaUtilizationWithFill')?.value;
    if (Number.isFinite(withFill) && Array.isArray(result.marker.gapFillPlacements)) {
        consumption.utilizationWithFill = withFill;
        consumption.fillCount = result.marker.gapFillPlacements.length;
    }
    return consumption;
}

export const effectiveUtilization = use => use?.utilizationWithFill ?? use?.utilization ?? -1;

export function compactionSavingMm(trials = []) {
    const index = trials.findIndex(trial => trial.phase === 'COMPACTION');
    if (index < 1) return 0;
    const occupied = trial => trial.complete && Number.isFinite(trial.occupiedLengthMm) && trial.occupiedLengthMm > 0;
    const before = trials.slice(0, index).filter(occupied);
    if (!before.length || !occupied(trials[index])) return 0;
    const shortest = Math.min(...before.map(trial => trial.occupiedLengthMm));
    return Math.max(0, shortest - trials[index].occupiedLengthMm);
}

export function selectMarkerTrial(jobState, trial, fixed, gapFill = false) {
    const canCompare = jobState === 'SUCCEEDED' || jobState === 'TIMED_OUT';
    if (canCompare && fixed?.use) {
        if (!trial.use || fixed.use.length < trial.use.length) return fixed;
        if (gapFill && effectiveUtilization(fixed.use) > effectiveUtilization(trial.use)) return fixed;
    }
    return trial;
}

export async function solveMarkerDirection(request, fixed, solve, isActive, onRetry) {
    const originalLength = request.problem.material.shape.height;
    const tightLength = fixed?.use && Math.ceil(fixed.use.length * 10) / 10;
    if (!tightLength || tightLength >= originalLength) return {trial:await solve(request)};
    const tightRequest = structuredClone(request);
    tightRequest.problem.material.shape.height = tightLength;
    const first = await solve(tightRequest);
    if (!isActive() || first.use || !['SUCCEEDED', 'TIMED_OUT'].includes(first.job.state)) return {trial:first};

    onRetry();
    let label = first.job.state === 'TIMED_OUT' ? '紧窗限时未齐套 · 原起长复试' : '紧窗未齐套 · 原起长复试';
    try {
        const retry = await solve({...request, clientRequestId:crypto.randomUUID()});
        if (retry.job.state === 'FAILED' || retry.job.state === 'CANCELLED') {
            label += retry.job.state === 'FAILED' ? '失败' : '已取消';
            return {trial:first, retryNote:label};
        }
        return {trial:retry, retryNote:label};
    } catch (error) {
        return {trial:first, retryNote:`${label}失败 · ${error.message}`};
    }
}
