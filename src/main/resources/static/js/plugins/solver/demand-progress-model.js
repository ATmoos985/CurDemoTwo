const explanations = {
    CROSSCUT_WIDTH_MISMATCH:'仅横切需要裁片宽度等于料头幅宽，此项留待其他材料或允许纵切后再排。',
    EXCEEDS_MATERIAL_WIDTH:'裁片幅宽超出本次材料，当前允许的摆放方向均放不下；请选择更宽材料或核对旋转设置。',
    EXCEEDS_PROCESSING_LENGTH:'裁片长度超出本次加工区的有效长度（已扣切头量）；请核对机台允许长度或选择其他材料。',
    EXCEEDS_PROCESSING_REGION:'当前允许的摆放方向均超出加工区；请核对材料尺寸、工位长度及旋转设置。',
    ROTATION_REQUIRED:'原方向放不下，旋转 90° 后尺寸可容纳；仅在纹理和工艺允许时开启旋转，再求解验证。',
    NOT_INCLUDED_IN_MANUAL_LAYOUT:'当前手调方案未包含这些数量，仍需在后续方案中排料。',
    NOT_PLACED_IN_THIS_SOLUTION:'本次搜索未排入这些数量，不能据此判定无法裁切。可在下一工位续排，或核对加工区、疵点和工艺后重新求解。'
};

export function demandProgress(demands, completed, {pending, pieces = [], edited = false, attempt, queued = {}} = {}) {
    const current = pending ? pieces.filter(p => p.planId === pending.result.planId && !p.confirmed) : [];
    const counts = new Map(); current.forEach(p => counts.set(p.demandId,(counts.get(p.demandId) || 0)+1));
    return demands.map(d => {
        const good = Number(completed[d.id] || 0), planned = counts.get(d.id) || 0;
        const remaining = Number.isSafeInteger(d.quantity) && d.quantity > 0 && d.quantity >= good ? d.quantity-good : null;
        const staged = Math.max(0,Number(queued[d.id] || 0));
        const toCut = remaining == null ? null : Math.max(0,remaining-staged);
        const unplaced = toCut == null ? null : Math.max(0,toCut-planned);
        const result = pending?.result || attempt?.result;
        const fulfillment = result?.fulfillment?.find(f => f.demandId === d.id);
        const removed = edited ? Math.max(0,(pending.result.pieces || []).filter(p => p.demandId === d.id).length-planned) : 0;
        let reason = '';
        if (unplaced && result) {
            if (removed) reason = `手动调整移除了 ${removed} 件；当前预览尚未校验，其余未排数量仍需后续排料。`;
            else if (result.status && !['FEASIBLE','NO_SOLUTION_FOUND'].includes(result.status)) reason = '本次未生成有效方案，请查看求解反馈并修正后重试。';
            else reason = explanations[fulfillment?.reason] || explanations.NOT_PLACED_IN_THIS_SOLUTION;
        }
        return {id:d.id, total:d.quantity, completed:good, staged, toCut, planned, remaining, unplaced, reason, edited};
    });
}

/** Whole lines and total pieces answer different questions; neither includes preview output. */
export function summarizeDemandProgress(progress) {
    const valid=progress.every(d=>d.remaining !== null);
    const satisfied=progress.filter(d=>d.remaining === 0).length;
    return {lines:progress.length,satisfied,partial:progress.filter(d=>d.completed>0 && d.remaining>0).length,
        completed:progress.reduce((n,d)=>n+d.completed,0),
        staged:progress.reduce((n,d)=>n+d.staged,0),
        cut:progress.reduce((n,d)=>n+d.completed+d.staged,0),
        toCut:valid?progress.reduce((n,d)=>n+d.toCut,0):null,
        total:valid?progress.reduce((n,d)=>n+d.total,0):null,
        remaining:valid?progress.reduce((n,d)=>n+d.remaining,0):null};
}

/** Use persisted receipts so reopening a task retains the explanation, without treating it as a new report. */
export function latestDemandChange(reports, taskId) {
    if(!taskId)return null;
    const candidates=(reports || []).filter(r=>r.taskId===taskId);
    const eventTime=r=>r.status==='REVERSED'?(r.reversedAt || r.confirmedAt):r.confirmedAt;
    const report=candidates.reduce((latest,r)=>!latest || String(eventTime(r) || '')>=String(eventTime(latest) || '')?r:latest,null);
    if(!report)return null;
    let quantities=report.demandQuantities;
    if(!quantities && Array.isArray(report.pieceResults) && (report.pieceResults.length || report.finishedPieceCount===0)) {
        quantities={};
        report.pieceResults.filter(p=>p.outcome==='QUALIFIED' && p.demandId!=null)
            .forEach(p=>quantities[p.demandId]=(quantities[p.demandId] || 0)+1);
    }
    const known=quantities!=null;
    const reversed=report.status==='REVERSED';
    const deltas=Object.fromEntries(Object.entries(quantities || {}).filter(([,n])=>Number.isSafeInteger(n) && n>0)
        .map(([id,n])=>[id,reversed?-n:n]));
    return {planId:report.planId,reversed,known,deltas,time:eventTime(report) || '',
        pieces:Object.values(deltas).reduce((n,x)=>n+Math.abs(x),0),
        rejected:report.rejectedPieceCount || 0,uncut:report.uncutPieceCount || 0};
}
