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

/** Draw only reported cut pieces and actually recovered rectangles; unfinished previews are discarded. */
export function applyReportReceipt(data, pending, receipt) {
    const results = receipt.pieceResults || pending.result.pieces.map(p => ({pieceId:p.id,outcome:'QUALIFIED'}));
    const byId = new Map(results.map(r => [r.pieceId,r]));
    data.pieces = (data.pieces || []).flatMap(p => {
        if (p.planId !== pending.result.planId) return [p];
        const row = byId.get(p.sourcePieceId);
        return row && row.outcome !== 'UNCUT' ? [{...p,confirmed:true,outcome:row.outcome,reportReason:row.reason || ''}] : [];
    });
    data.remnants = [...(data.remnants || []).filter(r => r.confirmed), ...(receipt.recoveredGeometry || []).map(r => ({
        ...r,y:r.y+pending.windowStartY,status:r.hasDefect ? '带疵料头' : '已回收料头',confirmed:true,planId:pending.result.planId
    }))];
    data.cuts = [];
    data.cutIntervals = [];
}
