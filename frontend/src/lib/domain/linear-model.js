export const defaults = {motherWidth:4600,leftTrim:100,rightTrim:100,minWidth:4300,maxWidth:4400,step:10,totalOverCap:30,profile:'FAST',orderItems:[]};
export const sample = () => ({...defaults,orderItems:[
    {messageText:'示例订单 A',width:2200,quantity:4,length:1000,surfaceTreatment:'单面处理'},
    {messageText:'示例订单 B',width:1100,quantity:8,length:1000,surfaceTreatment:'单面处理'},
    {messageText:'示例订单 C',width:1450,quantity:6,length:1500,surfaceTreatment:'双面处理'}
]});
export function validateInput(input) {
    const {motherWidth,leftTrim,rightTrim,minWidth,maxWidth,step,totalOverCap,orderItems}=input;
    if (![motherWidth,leftTrim,rightTrim,minWidth,maxWidth,step,totalOverCap].every(Number.isInteger)) throw Error('幅宽、切边、步长和数量须为整数，不能自动取整。');
    if (motherWidth<=0 || motherWidth>100000 || leftTrim<0 || rightTrim<0 || motherWidth<=leftTrim+rightTrim) throw Error('请检查母卷幅宽和左右切边。');
    if (minWidth<=0 || maxWidth<minWidth || maxWidth>motherWidth-leftTrim-rightTrim || step<=0 || (maxWidth-minWidth)/step>1000) throw Error('组合宽度须在可切区内，上限不能小于下限。');
    if (totalOverCap<0 || totalOverCap>10000) throw Error('超产上限须为 0–10000 卷。');
    if (!['FAST','QUALITY'].includes(input.profile)) throw Error('请选择计算方式。');
    if (!orderItems?.length || orderItems.length>500) throw Error('请提供 1–500 条需求。');
    orderItems.forEach((o,i)=>{
        if (![o.width,o.quantity,o.length].every(Number.isInteger) || o.width<=0 || o.width>maxWidth || o.quantity<=0 || o.quantity>100000 || o.length<=0 || o.length>1000000) throw Error(`第 ${i+1} 条需求的幅宽、卷数或卷长无效；幅宽须小于等于组合上限。`);
        if (!o.messageText?.trim() || o.messageText.length>200 || !o.surfaceTreatment?.trim() || o.surfaceTreatment.length>100) throw Error(`请完善第 ${i+1} 条需求的订单标识和表面处理。`);
    });
    return input;
}
export function layout(group,input) {
    const widths=(group.comboExpanded||[]).map(Number), available=input.motherWidth-input.leftTrim-input.rightTrim;
    const product=widths.reduce((a,b)=>a+b,0);
    if (!widths.length || widths.some(w=>!Number.isFinite(w)||w<=0) || available<=0 || product>available) throw Error('方案宽度与母卷可切区不一致，请检查输入和结果。');
    return {widths,product,available,remaining:available-product,wholeRate:product/input.motherWidth*100,cuttableRate:product/available*100};
}
export function totals(groups,input) {
    let product=0,available=0,remaining=0,rolls=0;
    for (const group of groups) {
        const count=group.usageCount;
        if (!Number.isInteger(count)||count<=0) throw Error('方案重复用卷数无效。');
        const item=layout(group,input);
        rolls+=count; product+=item.product*count; available+=item.available*count; remaining+=item.remaining*count;
    }
    return {rolls,product,remaining,cuttableRate:available?product/available*100:null};
}
export const groupKey=o=>`${o.length}m+${o.surfaceTreatment}`;
export function demandBalance(orders,patterns) {
    const rows=new Map();
    const get=(o,width)=>{const group=groupKey(o),key=JSON.stringify([group,width]);if(!rows.has(key))rows.set(key,{group,width,demand:0,actual:0});return rows.get(key);};
    for(const o of orders)get(o,o.width).demand+=o.quantity;
    for(const p of patterns||[])for(const [width,count] of Object.entries(p.subRolls||{}))get(p,Number(width)).actual+=count*p.usageCount;
    return [...rows.values()].map(r=>({...r,difference:r.actual-r.demand})).sort((a,b)=>a.group.localeCompare(b.group)||b.width-a.width);
}
/** 逐规格独立分切基线：同卷长、同表面处理、同幅宽的需求合并后单独开卷，每卷只切一种幅宽，不同规格不搭配。
 *  末卷条数不足时单独成组，空位不算成品。基线不受组合下限约束，对基线有利。返回与搭切结果同形的方案行。 */
export function independentBaseline(input) {
    const available=input.motherWidth-input.leftTrim-input.rightTrim,specs=new Map();
    for(const order of input.orderItems){
        const key=JSON.stringify([groupKey(order),order.width]);
        if(!specs.has(key))specs.set(key,{width:order.width,length:order.length,surfaceTreatment:order.surfaceTreatment,quantity:0});
        specs.get(key).quantity+=order.quantity;
    }
    return [...specs.values()].flatMap(spec=>{
        const perRoll=Math.floor(available/spec.width);
        if(perRoll<1)throw Error('订单幅宽超过可切区，无法独立分切。');
        const row=(count,usageCount)=>({comboExpanded:Array(count).fill(spec.width),length:spec.length,surfaceTreatment:spec.surfaceTreatment,usageCount});
        const full=Math.floor(spec.quantity/perRoll),tail=spec.quantity%perRoll;
        return [...(full?[row(perRoll,full)]:[]),...(tail?[row(tail,1)]:[])];
    });
}
/** 方案汇总，求解结果与基线共用同一口径：得率 = 需求成品面积 ÷ 母卷面积（按卷长加权），超产不计入得率；超产和缺口按规格逐项对账。 */
export function planSummary(plan,input) {
    let rolls=0,motherArea=0,demandArea=0,surplus=0,shortage=0;
    for(const row of plan){rolls+=row.usageCount;motherArea+=row.usageCount*input.motherWidth*row.length;}
    for(const order of input.orderItems)demandArea+=order.width*order.quantity*order.length;
    const patterns=plan.map(row=>({...row,subRolls:row.comboExpanded.reduce((count,width)=>({...count,[width]:(count[width]||0)+1}),{})}));
    for(const {difference} of demandBalance(input.orderItems,patterns)){if(difference>0)surplus+=difference;else shortage-=difference;}
    return {rolls,groups:plan.length,rate:motherArea?demandArea/motherArea*100:null,surplus,shortage};
}
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
