// 适配层：任务编辑表单（新建 / 编辑 / 导入）。纯函数，不发请求。
// 校验与后端 RemnantService.saveTask 一致：名称与型号必填；1–200 项需求；编号唯一为正；尺寸为正；单项 1–10000 件；
// 已报工需求不能删除、不能改名改尺寸，总件数不得小于已报工件数。

export const DEFAULT_PROCESS = {bedLength: 5000, trimStart: 0, pieceGap: 0, cutOrigin: 'right-bottom', firstStageOrientation: 'horizontal',
    allowRotation: false, allowLongitudinal: true};

export function emptyTask() {
    return {id: null, revision: 0, name: '', materialModel: '', externalRef: '', process: {...DEFAULT_PROCESS}, demands: []};
}

/** 从后端任务转为表单（深拷贝，补齐工艺默认值）。 */
export function fromTask(task) {
    return {id: task.id, revision: task.revision, name: task.name || '', materialModel: task.materialModel || '', externalRef: task.externalRef || '',
        process: {...DEFAULT_PROCESS, ...(task.process || {})},
        demands: (task.demands || []).map(d => ({id: d.id, name: d.name, width: d.width, length: d.length, quantity: d.quantity,
            allowRotation: !!d.allowRotation, ...(d.shape ? {shape: d.shape} : {})}))};
}

export const nextDemandId = demands => demands.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0) + 1;

export function addDemand(form, line = {}) {
    const id = nextDemandId(form.demands);
    return {...form, demands: [...form.demands, {id, name: line.name ?? `需求 ${id}`, width: line.width ?? 0, length: line.length ?? 0,
        quantity: line.quantity ?? 1, allowRotation: !!line.allowRotation}]};
}

/** 导入结果合并：replace=true 替换全部需求（已报工项保留），否则追加并重新编号。 */
export function mergeImport(form, imported, {replace = true, completed = {}} = {}) {
    const keep = replace ? form.demands.filter(d => (completed[d.id] || completed[String(d.id)] || 0) > 0) : form.demands;
    let next = {...form, demands: keep};
    for (const d of imported.demands) next = addDemand(next, d);
    return {...next, name: form.name || imported.name, materialModel: form.materialModel || imported.materialModel,
        externalRef: form.externalRef || imported.externalRef};
}

const done = (completed, id) => completed[id] || completed[String(id)] || 0;

/** 返回问题列表；空表示可保存。original 为编辑前的后端任务（新建为 null）。 */
export function taskProblems(form, {original = null, completed = {}} = {}) {
    const p = [];
    if (!form.name.trim()) p.push('请填写任务名称');
    if (!form.materialModel.trim()) p.push('请填写材料型号');
    if (!form.demands.length || form.demands.length > 200) p.push('需求需为 1 至 200 项');
    const pr = form.process;
    if (!(pr.bedLength > 0)) p.push('拉布长度须大于 0');
    if (!(pr.trimStart >= 0)) p.push('切头不能为负数');
    if (!(pr.pieceGap >= 0)) p.push('件间距不能为负数');
    const ids = new Set();
    form.demands.forEach((d, i) => {
        const at = `第 ${i + 1} 行`;
        if (!(Number.isInteger(d.id) && d.id > 0) || ids.has(d.id)) p.push(`${at}：编号须为唯一正整数`);
        ids.add(d.id);
        if (!String(d.name || '').trim()) p.push(`${at}：请填写名称`);
        if (!(d.width > 0 && d.length > 0)) p.push(`${at}：宽度、长度须大于 0`);
        if (!(Number.isInteger(d.quantity) && d.quantity >= 1 && d.quantity <= 10000)) p.push(`${at}：件数须为 1–10000 的整数`);
    });
    if (original) {
        if (Object.keys(completed).length && original.materialModel !== form.materialModel) p.push('已有报工的任务不能更改材料型号');
        for (const old of original.demands || []) {
            const count = done(completed, old.id);
            if (!count) continue;
            const now = form.demands.find(d => d.id === old.id);
            if (!now) p.push(`已报工需求「${old.name}」不能删除`);
            else if (now.name !== old.name || now.width !== old.width || now.length !== old.length) p.push(`已报工需求「${old.name}」不能改名或改尺寸`);
            else if (now.quantity < count) p.push(`「${old.name}」总件数不得小于已报工 ${count} 件`);
        }
    }
    return p;
}

/** 已报工需求的锁定状态：名称、尺寸、删除不可改；件数下限。 */
export function lineLock(line, completed = {}) {
    const count = done(completed, line.id);
    return {locked: count > 0, minQuantity: Math.max(1, count)};
}

export function toPayload(form) {
    return {id: form.id || undefined, revision: form.revision || 0, name: form.name.trim(), materialModel: form.materialModel.trim(),
        externalRef: form.externalRef.trim(), process: {...form.process},
        demands: form.demands.map(d => ({id: d.id, name: String(d.name).trim(), width: Number(d.width), length: Number(d.length),
            quantity: Number(d.quantity), allowRotation: !!d.allowRotation, ...(d.shape ? {shape: d.shape} : {})}))};
}

/** 标准需求模板（CSV，可用 Excel 打开），列名与 parseDemandSheet 一致。 */
export function demandTemplateCsv() {
    return '﻿材料型号,裁片名称,宽度(mm),长度(mm),数量,订单编号,允许旋转\n2#A3A-Cream,示例窗帘,2170,3250,2,SO-0001,否\n';
}
