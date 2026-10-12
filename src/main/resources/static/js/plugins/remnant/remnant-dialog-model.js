export function expectedRemnants(data) {
    return (data.remnants || []).filter(r => !r.confirmed && !r.queued);
}

export function taskRemnants(data, reports, queue, request) {
    const fits = r => r.w >= (request.minRemnantWidth ?? 200) && r.l >= (request.minRemnantLength ?? 300);
    const reportedPlans = new Set(reports.map(r => r.planId));
    const rows = request.feedPortType === 'remnant' ? [] : expectedRemnants(data).filter(fits)
        .map(r => ({...r, phase:'expected', canvasId:r.id}));
    for (const {pending, report} of queue) {
        if (pending.rollId !== request.rollId || pending.feedPortType === 'remnant' || reportedPlans.has(report.planId)) continue;
        const largeEnough = r => r.w >= (pending.request.minRemnantWidth ?? 200) && r.l >= (pending.request.minRemnantLength ?? 300);
        rows.push(...(report.actualRemnants || []).filter(largeEnough).map(r => ({...r, phase:'queued',
            canvasId:(data.remnants || []).find(shape => shape.queued && shape.planId === report.planId
                && shape.sourceCandidateId === r.id)?.id})));
    }
    for (const report of reports) {
        if (report.status === 'REVERSED' || report.rollId !== request.rollId) continue;
        rows.push(...(report.derivedRemnants || []).map(r => ({id:r.id,w:r.width,l:r.length,
            hasDefect:r.hasDefect,phase:'reported',canvasId:(data.remnants || []).find(shape => shape.confirmed && shape.id === r.id)?.id})));
    }
    return rows;
}

export function motherRollRemnants(stocks, rollId) {
    return rollId ? stocks.filter(r => r.sourceRollId === rollId) : [];
}
