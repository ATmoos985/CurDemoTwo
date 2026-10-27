// 任务列表：读取任务汇总，按状态筛选，进入工作台或经典页面的对应环节。
import {requestJSON, esc, shortId, errorBox} from '../util.js';
import {taskLabels, filterTasks, taskLink} from '../../../js/business/cutting/task-list-model.js';

const TAG = {PLAN_PENDING: 'idle', EXECUTION_PENDING: 'run', REPORT_PENDING: 'warn', ATTENTION: 'err', COMPLETED: 'ok'};

export async function mount(el) {
    let rows = [], status = 'all', search = '';
    try { rows = await requestJSON('/api/cutting/task-summaries'); }
    catch (e) { el.innerHTML = errorBox(e); return; }

    function render() {
        const list = filterTasks(rows, search, status);
        const count = k => k === 'all' ? rows.length : rows.filter(r => r.status === k).length;
        const tabs = ['all', ...Object.keys(taskLabels)].map(k =>
            `<button class="${status === k ? 'on' : ''}" data-status="${k}">${k === 'all' ? '全部' : taskLabels[k]} ${count(k)}</button>`).join('');
        el.innerHTML = `<div class="ph"><h1>任务</h1><span class="crumb">二维排料任务（一维任务并入统一任务体系后在此显示）</span><span class="sp"></span>
            <a class="btn pri" href="#/task/new">新建任务</a></div>
          <div class="toolbar"><div class="seg">${tabs}</div><span class="sp"></span>
            <input class="field" id="task-search" placeholder="任务号 / 名称 / 型号 / 来源" style="width:240px" value="${esc(search)}"></div>
          <div class="body">${list.length ? `<table class="t"><thead><tr><th>任务号</th><th>名称</th><th>材料型号</th><th>来源</th><th class="r">需求项</th><th class="r">良品 / 需求</th><th>进度</th><th>状态</th><th class="r">待执行</th><th class="r">报工</th><th></th></tr></thead><tbody>
            ${list.map(r => {
                const t = r.task, pct = r.total ? r.completed / r.total * 100 : 0;
                return `<tr class="click" data-id="${esc(t.id)}"><td class="num"><a href="#/workbench/${encodeURIComponent(t.id)}">${shortId(t.id)}</a></td><td>${esc(t.name)}</td>
                  <td>${esc(t.materialModel)}</td><td class="muted">${esc(t.externalRef || '—')}</td><td class="r num">${(t.demands || []).length}</td>
                  <td class="r num">${r.completed} / ${r.total}</td><td><span class="bar"><i style="width:${pct}%"></i></span></td>
                  <td><span class="tag ${TAG[r.status] || ''}">${esc(taskLabels[r.status] || r.status)}</span></td>
                  <td class="r num">${r.pendingCount || 0}</td><td class="r num">${r.reportCount || 0}</td>
                  <td><a class="btn sm" href="#/workbench/${encodeURIComponent(t.id)}">打开</a> <a class="btn sm" href="#/task/${encodeURIComponent(t.id)}">编辑</a></td></tr>`;
            }).join('')}</tbody></table>` : '<div class="empty">没有符合条件的任务</div>'}
            <div class="pager"><span>共 ${list.length} 条</span><span>双击行打开工作台</span></div></div>`;
        el.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { status = b.dataset.status; render(); });
        const input = el.querySelector('#task-search');
        input.oninput = () => { search = input.value; const pos = input.selectionStart; render(); const i = el.querySelector('#task-search'); i.focus(); i.setSelectionRange(pos, pos); };
        el.querySelectorAll('tr[data-id]').forEach(tr => tr.ondblclick = () => { location.hash = '#/workbench/' + encodeURIComponent(tr.dataset.id); });
    }
    render();
}
