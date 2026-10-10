export function feedLengthLimits(data, reserved = 0) {
    const tail = data.totalRollL - (data.windowStartY || 0);
    return {
        min: Math.ceil(((data.trimStart || 0) + .1) * 10) / 10,
        max: Math.floor(Math.max(0, Math.min(tail, (data.stockRemainingLength ?? tail) - reserved)) * 10 + 1e-6) / 10
    };
}

export function demandFeedLength(demand, request) {
    const fitsWidth = width => request.allowLongitudinal ? width <= request.rollW : Math.abs(width - request.rollW) < .001;
    const lengths = [];
    if (fitsWidth(demand.width) && demand.length > 0) lengths.push(demand.length);
    // The crosscut engine keeps the fabric direction and only cuts the full width.
    if (request.allowLongitudinal && (request.allowRotation || demand.allowRotation) && fitsWidth(demand.length) && demand.width > 0)
        lengths.push(demand.width);
    return Math.min(...lengths);
}

export function suggestedFeedLength(request) {
    const lengths = (request.demands || []).filter(d => d.demand > 0).map(d => demandFeedLength(d, request)).filter(Number.isFinite);
    return lengths.length ? Math.ceil((Math.max(...lengths) + (request.trimStart || 0)) * 10) / 10 : null;
}
