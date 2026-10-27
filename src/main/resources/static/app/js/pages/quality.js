// 复检处置：列出有报工的任务，进入经典工作台的复检处置（本版只读入口）。
import {requestJSON, esc, shortId, errorBox} from '../util.js';
import {taskLabels} from '../../../js/business/cutting/task-list-model.js';

export async function mount(el) {
    let rows;
    try { rows = await requestJSON('/api/cutting/task-summaries'); } catch (e) { el.innerHTML = errorBox(e); return; }
    const list = rows.filter(r => r.reportCount > 0).reverse();
    el.innerHTML = `<div class="ph"><h1>复检处置</h1><span class="crumb">已报良品发现不良时：转料头、报废或待检隔离；已消耗母卷不恢复</span></div>
      <div class="body"><div class="notice" style="margin:0 0 12px">本版先提供入口：选择任务后在经典工作台的“报工记录”中发起复检处置。</div>
      ${list.length ? `<table class="t"><thead><tr><th>任务</th><th>名称</th><th>状态</th><th class="r">报工单</th><th class="r">良品 / 需求</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr><td class="num">${shortId(r.task.id)}</td><td>${esc(r.task.name)}</td><td>${esc(taskLabels[r.status] || r.status)}</td><td class="r num">${r.reportCount}</td><td class="r num">${r.completed} / ${r.total}</td>
        <td><a class="btn sm" href="/index.html?taskId=${encodeURIComponent(r.task.id)}&view=reports">报工记录 ↗</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty">没有已报工的任务</div>'}</div>`;
}
