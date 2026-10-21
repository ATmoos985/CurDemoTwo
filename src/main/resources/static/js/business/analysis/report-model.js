/** Reported throughput, including reused remnants; never a planned nesting utilization. */
export function reportTotals(reconciliation) {
    if(reconciliation.status!=='BALANCED' || !Array.isArray(reconciliation.areas) || !reconciliation.areas.length)return null;
    const keys=['consumed','qualified','rejected','recovered','otherWasteAndLoss'];
    const totals=Object.fromEntries(keys.map(key=>[key,0]));
    for(const row of reconciliation.areas) {
        if(row.unit!=='m2' || keys.some(key=>!Number.isFinite(row[key]) || row[key]<-1e-6))return null;
        for(const key of keys)totals[key]+=Math.max(0,row[key]);
    }
    return {...totals,count:reconciliation.areas.length,goodRate:totals.consumed>0?totals.qualified/totals.consumed:null,
        recoveryRate:totals.consumed>0?totals.recovered/totals.consumed:null};
}
export function csvCell(value) {
    let text=String(value ?? '');if(/^[\s]*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
}
