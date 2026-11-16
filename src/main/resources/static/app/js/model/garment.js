import {markerExample} from '../../../js/nesting/marker-demo.js';

export function markerRequest(style, width, sizeCounts, clientRequestId) {
    const problem = markerExample(width, style, sizeCounts);
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
