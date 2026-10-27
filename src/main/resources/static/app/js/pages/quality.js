// 复检处置：汇总各任务的报工回执，列出仍可复检的裁片；处置在工作台对应拉布段的“报工回执”中完成。
import {requestJSON, esc, shortId, errorBox} from '../util.js';
import {reviewablePieces, effectivePieceResults, receiptSummary} from '../model/quality.js';

export async function mount(el) {
    let rows;
    try {
        const summaries = (await requestJSON('/api/cutting/task-summaries')).filter(r => r.reportCount > 0);
        const details = await Promise.all(summaries.map(s => requestJSON('/api/cutting/tasks/' + encodeURIComponent(s.task.id))));
        rows = details.flatMap(d => (d.reports || []).map(r => ({task: d.task, report: r})));
    } catch (e) { el.innerHTML = errorBox(e); return; }
    let onlyOpen = true;
    function render() {
        const list = rows.filter(x => x.report.status !== 'REVERSED' && (!onlyOpen || reviewablePieces(x.report).length))
            .sort((a, b) => String(b.report.confirmedAt).localeCompare(String(a.report.confirmedAt)));
        el.innerHTML = `<div class="ph"><h1>复检处置</h1><span class="crumb">已报良品发现不良时：报废或转料头；原报工与母卷耗用保留，完成量扣回形成补产</span></div>
          <div class="toolbar"><label class="muted"><input type="checkbox" id="open" ${onlyOpen ? 'checked' : ''}> 只看仍可复检的报工</label><span class="sp"></span><span class="muted">${list.length} 张报工单</span></div>
          <div class="body">${list.length ? `<table class="t"><thead><tr><th>报工单</th><th>任务</th><th>母卷</th><th class="r">实切 mm</th><th class="r">合格</th><th class="r">异常</th><th class="r">可复检</th><th class="r">已复检</th><th>时间</th><th></th></tr></thead><tbody>
            ${list.map(({task, report}) => { const s = receiptSummary(report, effectivePieceResults);
              return `<tr><td class="num">${shortId(report.planId)}</td><td>${esc(task.name)}</td><td class="num">${esc(report.rollId || report.sourceRemnantId || '—')}</td><td class="r num">${Math.round(report.actualCutLen || 0)}</td>
                <td class="r num">${s.qualified}</td><td class="r num">${s.rejected}</td><td class="r num">${reviewablePieces(report).length}</td><td class="r num">${s.dispositions}</td>
                <td class="num">${esc(String(report.confirmedAt || '').replace('T', ' ').slice(5, 16))}</td>
                <td><a class="btn sm" href="#/workbench/${encodeURIComponent(task.id)}/${encodeURIComponent(report.planId)}">打开处置</a></td></tr>`; }).join('')}</tbody></table>`
            : '<div class="empty">没有需要复检的报工</div>'}</div>`;
        el.querySelector('#open').onchange = e => { onlyOpen = e.target.checked; render(); };
    }
    render();
}
