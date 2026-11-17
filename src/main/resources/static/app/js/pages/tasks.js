// 任务列表：读取任务汇总，按状态筛选，进入工作台或经典页面的对应环节。
import {requestJSON, esc, shortId, errorBox} from '../util.js';
import {taskLabels, filterTasks} from '../../../js/business/cutting/task-list-model.js';

const TAG = {PLAN_PENDING: 'idle', EXECUTION_PENDING: 'run', REPORT_PENDING: 'warn', ATTENTION: 'err', COMPLETED: 'ok'};

export async function mount(el) {
    let rows = [], status = 'all', search = '';
    try { rows = await requestJSON('/api/cutting/task-summaries'); }
    catch (e) { el.innerHTML = errorBox(e); return; }

    function render() {
        const list = filterTasks(rows, search, status);
        const count = k => k === 'all' ? rows.length : rows.filter(r => r.status === k).length;
        const tabs = ['all', ...Object.keys(taskLabels)].map(k =>
            `<button class="${status === k ? 'on' : ''}" data-status="${k}" aria-pressed="${status === k}">${k === 'all' ? '全部' : taskLabels[k]} <span class="filter-count num">${count(k)}</span></button>`).join('');
        el.innerHTML = `<div class="ph"><h1>任务</h1><span class="tag kind">${rows.length} 个任务</span>
            <div class="hub-tabs" role="navigation" aria-label="生产作业视图">
              <a class="on" href="#/tasks">任务队列</a>
              <a href="#/execution">工位执行单</a>
              <a href="#/quality">异常复检</a>
            </div>
            <span class="sp"></span>
            <a class="btn pri" href="#/task/new">新建任务</a></div>
          <div class="toolbar"><div class="seg task-filters" role="group" aria-label="任务状态">${tabs}</div><span class="sp"></span>
            <input class="field" id="task-search" aria-label="搜索任务" placeholder="任务号 / 名称 / 型号 / 来源" style="width:240px" value="${esc(search)}"></div>
          <div class="body">${list.length ? `<table class="t task-table"><thead><tr><th>任务 / 来源</th><th>类型</th><th>材料型号</th><th class="r">需求项</th><th>良品进度</th><th>状态</th><th class="r">候选</th><th class="r">报工</th><th>操作</th></tr></thead><tbody>
            ${list.map(r => {
                const t = r.task, pct = r.total ? r.completed / r.total * 100 : 0;
                const directIntent = r.status === 'REPORT_PENDING' ? 'report' : r.status === 'ATTENTION' ? 'quality' : '';
                return `<tr class="click" data-id="${esc(t.id)}"><td class="task-identity"><a href="#/workbench/${encodeURIComponent(t.id)}">${esc(t.name)}</a><small><span class="num">${shortId(t.id)}</span> · ${esc(t.externalRef || '无来源编号')}</small></td>
                  <td><span class="tag kind">${t.problemType === 'SLITTING_1D' ? '一维' : '二维'}</span></td><td>${esc(t.materialModel)}</td><td class="r num">${(t.demands || []).length}</td>
                  <td><div class="task-progress"><span class="num">${r.completed}<span class="muted"> / ${r.total} 件</span></span><span class="bar" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></span></div></td>
                  <td><span class="tag ${TAG[r.status] || ''}">${esc(taskLabels[r.status] || r.status)}</span></td>
                  <td class="r num">${r.pendingCount || 0}</td><td class="r num">${r.reportCount || 0}</td>
                  <td><a class="btn sm ${!directIntent && r.status === 'PLAN_PENDING' ? 'pri' : ''}" href="#/workbench/${encodeURIComponent(t.id)}">${({PLAN_PENDING: '去排料', EXECUTION_PENDING: '查看方案', REPORT_PENDING: '工作台', ATTENTION: '工作台', COMPLETED: '查看产出'})[r.status] || '打开'}</a>${directIntent ? ` <a class="btn sm pri" href="#/workbench/${encodeURIComponent(t.id)}?intent=${directIntent}">${directIntent === 'report' ? '去报工' : '处理异常'}</a>` : ''} <a class="btn sm" href="#/task/${encodeURIComponent(t.id)}">编辑</a></td></tr>`;
            }).join('')}</tbody></table>` : '<div class="empty">没有符合条件的任务</div>'}
            <div class="pager"><span>共 ${list.length} 条</span><span>双击行直接进入排料工作台</span></div></div>`;
        el.querySelectorAll('[data-status]').forEach(b => b.onclick = () => { status = b.dataset.status; render(); });
        const input = el.querySelector('#task-search');
        input.oninput = () => { search = input.value; const pos = input.selectionStart; render(); const i = el.querySelector('#task-search'); i.focus(); i.setSelectionRange(pos, pos); };
        el.querySelectorAll('tr[data-id]').forEach(tr => tr.ondblclick = () => { location.hash = '#/workbench/' + encodeURIComponent(tr.dataset.id); });
    }
    render();
}
