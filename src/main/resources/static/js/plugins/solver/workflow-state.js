/** Readiness is advisory; solving and reporting still validate on the server. */
export function workflowState(input) {
    const {name, model, demands = [], material = {}, process = {}, ready, edited} = input;
    const step = (stage, title, hint, action, label, target, extra = {}) =>
        ({stage, title, hint, action, label, target, canSolve:false, done:false, ...extra});
    const missing = (hint, target) => step(0, '完善需求', hint, 'focus', '完善需求信息', target);
    if (!name?.trim()) return missing('请填写任务名称，方便下次查找和续作。', '#task-name');
    if (!model) return missing('请选择本次需求的材料型号。', '#task-material');
    if (!demands.length) return step(0, '添加需求', '导入订单 Excel，或添加要切出的尺寸和数量。', 'add', '添加裁片需求');
    if (demands.length > 200) return missing('每个任务最多 200 项需求，请拆分为多个任务。', '#demands-container');
    for (const d of demands) {
        const target = key => `[data-id="${d.id}"] .dem-${key}`;
        if (!d.name?.trim()) return missing('请填写裁片名称。', target('name'));
        if (!(Number.isFinite(d.width) && d.width > 0)) return missing(`${d.name}：宽度须大于 0。`, target('w'));
        if (!(Number.isFinite(d.length) && d.length > 0)) return missing(`${d.name}：长度须大于 0。`, target('l'));
        if (!Number.isSafeInteger(d.quantity) || d.quantity <= 0) return missing(`${d.name}：件数须为正整数。`, target('count'));
        if (d.quantity < d.completed) return missing(`${d.name}：需求不能少于已报工合格数量 ${d.completed} 件。`, target('count'));
    }
    const remaining = demands.reduce((n,d) => n+d.quantity-(d.completed || 0), 0);
    if (!remaining) return step(3, '本次需求已完成', '全部需求已有合格报工，可查看记录与回收明细。', 'reports', '查看报工记录', null, {done:true});
    const toCut = demands.reduce((n,d) => n+Math.max(0,d.quantity-(d.completed || 0)-(d.queued || 0)),0);
    if (!toCut && input.queued) return step(3,'待集中报工',`${input.queued} 个工位已暂存。集中报工后才记录合格完成量与扣减库存。`,'batch','核对并集中报工');
    if (!material.available || !(material.length > 0)) return step(1, '选择可用材料', `还有 ${remaining} 件待完成。请匹配并装载在库料头或母卷。`, 'match', '匹配料头与母卷');
    if (model !== material.model) return step(1, '重新匹配材料', '当前材料型号与需求不一致，请选择匹配的材料。', 'match', '重新匹配材料');
    if (!material.sheet && process.start < material.used - .001)
        return step(2, '正在回看前面的工位', '此处已有报工或暂存记录；继续排料请回到待切位置。', 'advance', '回到待切位置');
    if (!Number.isFinite(process.length) || process.length <= 0 || process.length > material.length + .001)
        return step(2, '核对拉布长度', '本次拉布长度须大于 0，且不超过材料剩余长度。', 'focus', '修改拉布长度', '#inp-bed-l');
    if (!Number.isFinite(process.start) || process.start < 0 || (!material.sheet && process.start+process.length > material.total+.001))
        return step(2, '核对加工区', '当前工位超出材料范围，请在母卷导航中调整位置。', 'focus', '定位母卷导航', '#radar-window');
    if (!Number.isFinite(process.trim) || process.trim < 0 || process.trim >= process.length)
        return step(2, '核对切头量', '切头量须不小于 0，且小于加工区长度。', 'focus', '修改切头量', '#inp-trim-start');
    if (ready) return step(3, '完成本工位', '核对实切结果后，可暂存并继续裁切，也可立即报工。', 'report', '完成本工位 / 继续裁切', null, {canSolve:true});
    if (edited) return step(2, '校验手调方案', '手动调整尚未校验，保存调整版后再打印和报工。', 'validate', '校验并保存调整版', null, {canSolve:true});
    return step(2, '生成排料方案', `还有 ${toCut} 件待裁切${input.queued ? `，${input.queued} 个工位待报工` : ''}。预览不扣库存。`, 'solve', '生成排料方案', null, {canSolve:true});
}
