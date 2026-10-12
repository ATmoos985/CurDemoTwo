export const outcomeLabels = {QUALIFIED:'合格', REJECTED:'异常', UNCUT:'未切'};

export function classifyReport(pieces, results) {
    const byId = new Map(results.map(r => [r.pieceId,r]));
    return Object.fromEntries(Object.keys(outcomeLabels).map(outcome => [outcome,pieces.filter(p => byId.get(p.id)?.outcome === outcome)]));
}

export function reportRecoveryCandidates(result, results, length) {
    const uncut = classifyReport(result.pieces || [], results).UNCUT;
    return [...(result.remnants || []), ...uncut.flatMap(p => {
        const l = Math.max(0, Math.min(p.y+p.l,length)-p.y);
        return l ? [{id:'UNCUT-'+p.id,status:'未切毛料 #'+p.id,x:p.x,y:p.y,w:p.w,l,area:p.w*l/1_000_000,hasDefect:false,uncut:true}] : [];
    })];
}

/** Rebuild recorded geometry from work orders, including records saved before canvas history was retained. */
export function restoreRecordedGeometry(data, reports, queue, feedPortType = 'roll', sourceRemnantId = null) {
    const matches = row => row.rollId === data.rollId && row.feedPortType === feedPortType
        && (feedPortType !== 'remnant' || row.sourceRemnantId === sourceRemnantId);
    const reported = new Set(reports.map(r => r.planId));
    const stations = reports.filter(r => r.status !== 'REVERSED' && matches(r)).map(r => ({
        planId:r.planId, offset:r.windowStartY || 0, pieces:(r.pieceResults || []).map(p => ({...p,id:p.pieceId})),
        results:r.pieceResults || [], remnants:r.recoveredGeometry || [], queued:false
    }));
    for (const {pending,report} of queue) {
        if (reported.has(report.planId) || !matches(pending)) continue;
        stations.push({planId:report.planId, offset:pending.windowStartY || 0, pieces:pending.result.pieces,
            results:report.pieceResults, remnants:pending.feedPortType === 'remnant' ? [] : (report.actualRemnants || []).filter(r =>
                r.w >= (pending.request.minRemnantWidth ?? 200) && r.l >= (pending.request.minRemnantLength ?? 300)), queued:true});
    }
    const planIds = new Set(stations.map(s => s.planId));
    const oldPieces = new Map((data.pieces || []).map(p => [p.planId+':'+p.sourcePieceId,p]));
    let nextId = Math.max(0,...(data.pieces || []).map(p => Number(p.id) || 0));
    data.pieces = (data.pieces || []).filter(p => !p.confirmed && !p.queued && !planIds.has(p.planId));
    data.remnants = (data.remnants || []).filter(r => !r.confirmed && !r.queued && !planIds.has(r.planId));
    for (const station of stations) {
        const outcomes = new Map(station.results.map(r => [r.pieceId,r]));
        for (const piece of station.pieces) {
            const outcome = outcomes.get(piece.id);
            if (!outcome || outcome.outcome === 'UNCUT' || ![piece.x,piece.y,piece.w,piece.l].every(Number.isFinite)) continue;
            data.pieces.push({...piece, id:oldPieces.get(station.planId+':'+piece.id)?.id ?? ++nextId,
                sourcePieceId:piece.id, planId:station.planId, y:piece.y+station.offset,
                queued:station.queued, confirmed:!station.queued, outcome:outcome.outcome, reportReason:outcome.reason || ''});
        }
        data.remnants.push(...station.remnants.map(r => ({...r,
            id:station.queued ? `QUEUED-${station.planId}-${r.id}` : r.id, sourceCandidateId:r.sourceCandidateId || r.id,
            planId:station.planId, y:r.y+station.offset, area:r.w*r.l/1_000_000,
            queued:station.queued, confirmed:!station.queued, status:station.queued ? '待报工料头' : '已回收料头'})));
    }
}

/** Draw only reported cut pieces and actually recovered rectangles; unfinished previews are discarded. */
export function applyReportReceipt(data, pending, receipt) {
    const results = receipt.pieceResults || pending.result.pieces.map(p => ({pieceId:p.id,outcome:'QUALIFIED'}));
    const byId = new Map(results.map(r => [r.pieceId,r]));
    data.pieces = (data.pieces || []).flatMap(p => {
        if (p.planId !== pending.result.planId) return [p];
        const row = byId.get(p.sourcePieceId);
        return row && row.outcome !== 'UNCUT' ? [{...p,confirmed:true,queued:false,outcome:row.outcome,reportReason:row.reason || ''}] : [];
    });
    data.remnants = [...(data.remnants || []).filter(r => (r.confirmed || r.queued) && r.planId !== pending.result.planId), ...(receipt.recoveredGeometry || []).map(r => ({
        ...r,y:r.y+pending.windowStartY,status:r.hasDefect ? '带疵料头' : '已回收料头',confirmed:true,planId:pending.result.planId
    }))];
    data.cuts = [];
    data.cutIntervals = [];
}
