const explanations = {
    EXCEEDS_MATERIAL_WIDTH:'裁片幅宽超出本次材料，当前允许的摆放方向均放不下；请选择更宽材料或核对旋转设置。',
    EXCEEDS_PROCESSING_LENGTH:'裁片长度超出本次加工区的有效长度（已扣切头量）；请核对机台允许长度或选择其他材料。',
    EXCEEDS_PROCESSING_REGION:'当前允许的摆放方向均超出加工区；请核对材料尺寸、工位长度及旋转设置。',
    ROTATION_REQUIRED:'原方向放不下，旋转 90° 后尺寸可容纳；仅在纹理和工艺允许时开启旋转，再求解验证。',
    NOT_INCLUDED_IN_MANUAL_LAYOUT:'当前手调方案未包含这些数量，仍需在后续方案中排料。',
    NOT_PLACED_IN_THIS_SOLUTION:'本次搜索未排入这些数量，不能据此判定无法裁切。可在下一工位续排，或核对加工区、疵点和工艺后重新求解。'
};

export function demandProgress(demands, completed, {pending, pieces = [], edited = false, attempt} = {}) {
    const current = pending ? pieces.filter(p => p.planId === pending.result.planId && !p.confirmed) : [];
    const counts = new Map(); current.forEach(p => counts.set(p.demandId,(counts.get(p.demandId) || 0)+1));
    return demands.map(d => {
        const good = Number(completed[d.id] || 0), planned = counts.get(d.id) || 0;
        const remaining = Number.isSafeInteger(d.quantity) && d.quantity > 0 && d.quantity >= good ? d.quantity-good : null;
        const unplaced = remaining == null ? null : Math.max(0,remaining-planned);
        const result = pending?.result || attempt?.result;
        const fulfillment = result?.fulfillment?.find(f => f.demandId === d.id);
        const removed = edited ? Math.max(0,(pending.result.pieces || []).filter(p => p.demandId === d.id).length-planned) : 0;
        let reason = '';
        if (unplaced && result) {
            if (removed) reason = `手动调整移除了 ${removed} 件；当前预览尚未校验，其余未排数量仍需后续排料。`;
            else if (result.status && !['FEASIBLE','NO_SOLUTION_FOUND'].includes(result.status)) reason = '本次未生成有效方案，请查看求解反馈并修正后重试。';
            else reason = explanations[fulfillment?.reason] || explanations.NOT_PLACED_IN_THIS_SOLUTION;
        }
        return {id:d.id, total:d.quantity, completed:good, planned, remaining, unplaced, reason, edited};
    });
}
