import {markerExample} from '../../../js/nesting/marker-demo.js';

export const GARMENT_EXAMPLES = [
    {id:'shirt-mixed', name:'上衣 · 三种门幅对比', style:'GARMENT_SHIRT', M:1, L:1, widths:[1600,1850,1950], edge:0, gsm:200},
    {id:'shirt-three', name:'上衣 · 两件 M 搭一件 L', style:'GARMENT_SHIRT', M:2, L:1, widths:[1600,1850], edge:0, gsm:200},
    {id:'pants-denim', name:'长裤 · 单码厚牛仔', style:'GARMENT_PANTS', M:0, L:1, widths:[1450,1550], edge:40, gsm:360},
    {id:'skirt-light', name:'半裙 · 双码轻薄料', style:'GARMENT_SKIRT', M:1, L:1, widths:[1400,1500], edge:20, gsm:135},
    {id:'tank-knit', name:'背心 · 针织包条', style:'GARMENT_TANK', M:1, L:1, widths:[1500,1750], edge:30, gsm:165},
    {id:'shorts-pair', name:'短裤 · 同码双件', style:'GARMENT_SHORTS', M:2, L:0, widths:[1450,1600], edge:20, gsm:220},
    {id:'apron-canvas', name:'围裙 · 帆布长系带', style:'GARMENT_APRON', M:1, L:1, widths:[1200,1500], edge:25, gsm:280}
];

export function markerRequest(style, width, sizeCounts, clientRequestId, allowHalfTurn = false) {
    const problem = markerExample(width, style, sizeCounts);
    if (allowHalfTurn) problem.parts.forEach(part => { part.allowHalfTurn = true; });
    return {schemaVersion: '2.0', clientRequestId, problemType: 'NESTING_2D', allowFallback: true,
        requireComplete: true, problem: {...problem, timeLimitSeconds: 10},
        strategy: {id: 'marker-shortening', version: '1', maxTrials: 5}};
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
    return {length, utilization, lengthPerGarment,
        gramsPerGarment: (width + edge) * lengthPerGarment * gsm / 1_000_000};
}
