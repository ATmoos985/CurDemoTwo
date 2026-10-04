const area = rectangles => rectangles.reduce((sum, p) => sum + p.w * p.l / 1_000_000, 0);
const percent = (part, total) => total > 0 ? part / total * 100 : 0;

/** Processing area and consumed material are different denominators. Coordinates remain in mm. */
export function layoutMetrics(data, {sheet = false, actualCutLen} = {}) {
    const width = data.rollW || 0, height = data.bedL || 0, start = sheet ? 0 : (data.windowStartY || 0);
    const inStation = p => p.y + p.l / 2 >= start && p.y + p.l / 2 < start + height;
    const pieces = (data.pieces || []).filter(inStation), remnants = (data.remnants || []).filter(inStation);
    const cutEnds = (data.cuts || []).map(c => c.endY !== undefined
        ? Math.max(c.startY, c.endY) : c.type === '横切' ? c.pos : c.end)
        .filter(y => y >= start && y <= start + height + .001);
    const hasLayout = pieces.length > 0 || remnants.length > 0 || cutEnds.some(y => y > start);
    // Remove binary arithmetic noise only; never round physical dimensions to whole millimetres.
    const extent = Number((Math.max(start, ...pieces.map(p => p.y + p.l), ...remnants.map(r => r.y + r.l), ...cutEnds) - start).toFixed(6));
    const length = actualCutLen === undefined ? extent : actualCutLen;
    const processingArea = width * height / 1_000_000;
    const totalArea = sheet ? (hasLayout ? processingArea : 0) : width * length / 1_000_000;
    const pieceArea = area(pieces), remArea = area(remnants);
    return {deductLen:sheet ? 0 : length, processingArea, totalArea, pieceArea, remArea,
        wasteArea:Math.max(0, totalArea - pieceArea - remArea)};
}

/** Actual accounting comes entirely from the matching receipt, never from preview remnants. */
export function materialSummary(data, sheet = false) {
    const r = data.lastReceipt;
    const actual = !!r && r.status !== 'REVERSED' && (sheet ? r.feedPortType === 'remnant'
        : r.feedPortType === 'roll' && Math.abs(r.windowStartY - (data.windowStartY || 0)) < .001);
    const values = actual ? {
        deductLen:r.actualCutLen, pieceArea:r.pieceArea, remArea:r.remArea, wasteArea:r.wasteArea,
        totalArea:r.usedArea ?? (r.pieceArea + r.remArea + r.wasteArea),
        processingArea:r.processingArea ?? (data.rollW * data.bedL / 1_000_000)
    } : data;
    return {deductLen:values.deductLen, pieceArea:values.pieceArea, remArea:values.remArea, wasteArea:values.wasteArea,
        totalArea:values.totalArea, processingArea:values.processingArea, actual, utilization:percent(values.pieceArea || 0, values.totalArea || 0),
        processingUtilization:percent(values.pieceArea || 0, values.processingArea || 0)};
}
