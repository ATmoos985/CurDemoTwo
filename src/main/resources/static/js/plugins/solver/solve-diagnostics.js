import {demandFeedLength, suggestedFeedLength} from '../radar/feed-window.js';

export function solveDiagnostics(request, result = {}) {
    const width = request.rollW, length = request.rollL - (request.trimStart || 0);
    const lines = (request.demands || []).filter(d => d.demand > 0).map(d => {
        let reason = '';
        const required = demandFeedLength(d,request);
        if (required > length) {
            if(Number.isFinite(required))reason='超过本次拉布长度';
            else if (!request.allowLongitudinal) reason = '仅横切时，裁片宽度必须等于母料幅宽';
            else reason = '超过母料幅宽或旋转受限';
        }
        return {...d,reason};
    });
    const blocked = lines.filter(d=>d.reason), allBlocked = lines.length > 0 && blocked.length === lines.length;
    const reasons = [...new Set(blocked.map(d=>d.reason))];
    const facts = [`母料幅宽 ${width} mm；本次拉布 ${request.rollL} mm，扣除切头后可用 ${length} mm。`];
    if (request.remainingLength != null) facts.push(`母卷账面剩余 ${request.remainingLength} mm。总余量与单工位加工长度分别核对。`);
    if (allBlocked) facts.push(`全部 ${lines.length} 项需求受尺寸或工艺限制，本次拉布范围放不下一件。`);
    else if (blocked.length) facts.push(`${blocked.length} 项需求受尺寸或工艺限制，其余需求仍需结合疵点与切割规则排料。`);
    const possible = [];
    if (request.defects?.length) possible.push(`当前加工区有 ${request.defects.length} 处疵点，避让后可能没有足够的连续可用区域。`);
    if (!allBlocked) possible.push('切割顺序、修边或搜索时限可能影响结果；本次未找到不等于已证明无解。');
    const neededArea = lines.reduce((n,d)=>n+d.width*d.length*d.demand,0);
    if (request.remainingLength != null && neededArea > width*request.remainingLength)
        facts.push('剩余需求净面积超过母卷账面剩余面积，即使不计损耗也无法用这一卷全部完成。');
    const suggested=suggestedFeedLength(request), available=Math.min(request.remainingLength??Infinity,(request.totalRollL??Infinity)-(request.windowStartY||0));
    const suggestedLength=request.feedPortType!=='remnant' && suggested>request.rollL && suggested<=available?suggested:null;
    if(suggestedLength)facts.push(`按最长单片尺寸需拉布至少 ${suggestedLength} mm（含切头、不含疵点避让），可调整后重新排料；不代表全部件数能一次排完。`);
    else if(suggested>request.rollL && suggested>available)facts.push(`最长单片需拉布 ${suggested} mm，超过当前位置可用的 ${available} mm，请核对卷尾或更换材料。`);
    return {title:result.status && result.status!=='NO_SOLUTION_FOUND' ? '本次排料未完成' : '本次排料未找到方案',
        summary:allBlocked ? reasons.join('；') : result.message || '当前条件下未生成可用方案', facts, possible, lines, suggestedLength,
        advice:suggestedLength ? '可按现场拉布范围调长后重排，整片需求保持不拆分；幅宽、疵点和纵切限制仍需满足。' : '核对需求、材料和本次拉布范围后，可调整工艺或搜索时间再试。'};
}
