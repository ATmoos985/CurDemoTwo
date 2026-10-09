import {demandFeedLength} from '../radar/feed-window.js';

// Expand clearance before clipping so a defect just outside the window still blocks its safety margin.
export function windowDefects(defects, start, length, width) {
    return defects.map(d=>{
        const margin=d.margin ?? 20, x=Math.max(0,d.x-margin), y=Math.max(start,d.y-margin);
        return {id:d.id,x,y:y-start,w:Math.min(width,d.x+d.w+margin)-x,h:Math.min(start+length,d.y+d.h+margin)-y,margin:0};
    }).filter(d=>d.w>0 && d.h>0);
}

function hasRoom(request) {
    const defects=request.defects, xs=[0,...defects.map(d=>d.x+d.w)], ys=[0,...defects.map(d=>d.y+d.h)];
    return request.demands.some(d=>{
        if(!(d.demand>0) || demandFeedLength(d,request)>request.rollL-(request.trimStart || 0))return false;
        const sizes=[[d.width,d.length]];
        if(request.allowLongitudinal && (request.allowRotation || d.allowRotation))sizes.push([d.length,d.width]);
        return sizes.some(([w,l])=>xs.some(x=>x+w<=request.rollW+.001 && ys.some(y=>y+l<=request.rollL+.001 &&
            !defects.some(b=>x<b.x+b.w-.001 && x+w>b.x+.001 && y<b.y+b.h-.001 && y+l>b.y+.001))));
    });
}

export function forwardWindows(request, defects) {
    if(request.feedPortType==='remnant')return [];
    // shortcut: 搜索疵点安全边界而非所有位置；需要证明无解时改为完整连续区间搜索。
    const positions=[...new Set(defects.map(d=>Math.ceil((d.y+d.h+(d.margin ?? 20))*10)/10))]
        .filter(y=>y>request.windowStartY && y<request.totalRollL).sort((a,b)=>a-b);
    return positions.map(start=>{
        const length=Math.min(request.rollL,request.totalRollL-start);
        return {...request,windowStartY:start,rollL:length,defects:windowDefects(defects,start,length,request.rollW)};
    }).filter(hasRoom);
}

export async function findForwardPlan(request, defects, solve, {isCurrent=()=>true,onAttempt=()=>{}}={}) {
    const candidates=forwardWindows(request,defects);
    const search={from:request.windowStartY,to:request.totalRollL,candidates:candidates.length,attempts:0,found:false,exhausted:false};
    for(const candidate of candidates) {
        if(!isCurrent())return null;
        onAttempt(candidate,++search.attempts,candidates.length);
        const result=await solve(candidate);
        if(!isCurrent())return null;
        if(result.success && result.planId && result.pieces?.length && Array.isArray(result.cuts) && Array.isArray(result.remnants)){
            search.found=true;return {request:candidate,result,search};
        }
        if(result.success)return {request:candidate,result:{success:false,status:'INVALID_RESULT',message:'后续位置的求解结果不完整，请重试。'},search};
        if(result.status!=='NO_SOLUTION_FOUND')return {request:candidate,result,search};
    }
    search.exhausted=true;
    return {request,result:{success:false,status:'NO_SOLUTION_FOUND',message:'已检查后续可用位置，未找到符合当前需求与工艺的方案。'},search};
}
