export function solveDiagnostics(request, result = {}) {
    const width = request.rollW, length = request.rollL - (request.trimStart || 0);
    const lines = (request.demands || []).filter(d => d.demand > 0).map(d => {
        const fits = (w,l) => w <= width && l <= length && (request.allowLongitudinal || Math.abs(w-width)<.001);
        const rotate = request.allowRotation || d.allowRotation;
        let reason = '';
        if (!fits(d.width,d.length) && !(rotate && fits(d.length,d.width))) {
            if (d.width > width && (!rotate || d.length > width)) reason = '超过母料幅宽';
            else if (d.length > length && (!rotate || d.width > length || d.length > width)) reason = '超过当前加工区长度';
            else if (!request.allowLongitudinal) reason = '仅横切时，裁片宽度必须等于母料幅宽';
            else reason = '当前尺寸与旋转限制不匹配';
        }
        return {...d,reason};
    });
    const blocked = lines.filter(d=>d.reason), allBlocked = lines.length > 0 && blocked.length === lines.length;
    const reasons = [...new Set(blocked.map(d=>d.reason))];
    const facts = [`母料幅宽 ${width} mm；加工区 ${request.rollL} mm，扣除切头后可用 ${length} mm。`];
    if (request.remainingLength != null) facts.push(`母卷账面剩余 ${request.remainingLength} mm。总余量与单工位加工长度分别核对。`);
    if (allBlocked) facts.push(`全部 ${lines.length} 项需求受尺寸或工艺限制，当前加工区放不下一件。`);
    else if (blocked.length) facts.push(`${blocked.length} 项需求受尺寸或工艺限制，其余需求仍需结合疵点与切割规则排料。`);
    const possible = [];
    if (request.defects?.length) possible.push(`当前加工区有 ${request.defects.length} 处疵点，避让后可能没有足够的连续可用区域。`);
    if (!allBlocked) possible.push('切割顺序、修边或搜索时限可能影响结果；本次未找到不等于已证明无解。');
    const neededArea = lines.reduce((n,d)=>n+d.width*d.length*d.demand,0);
    if (request.remainingLength != null && neededArea > width*request.remainingLength)
        facts.push('剩余需求净面积超过母卷账面剩余面积，即使不计损耗也无法用这一卷全部完成。');
    return {title:result.status && result.status!=='NO_SOLUTION_FOUND' ? '本次排料未完成' : '本次排料未找到方案',
        summary:allBlocked ? reasons.join('；') : result.message || '当前条件下未生成可用方案', facts, possible, lines,
        advice:allBlocked ? '核对需求尺寸与加工区长度；只有设备支持时才调整加工长度。需要拼接的需求请按确认的工艺拆分，系统不会自动拆片。' : '核对需求和材料后，可调整工艺或搜索时间再试。'};
}
