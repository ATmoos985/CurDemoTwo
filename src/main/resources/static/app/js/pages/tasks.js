// 任务队列共用任务汇总接口与状态筛选规则。
import {requestJSON, esc, shortId, errorBox} from '../util.js';
import {taskLabels, filterTasks} from '../../../js/business/cutting/task-list-model.js';

const TAG = {PLAN_PENDING: 'idle', EXECUTION_PENDING: 'run', REPORT_PENDING: 'warn', ATTENTION: 'err', COMPLETED: 'ok'};

export async function mount(el) {
    el.classList.add('task-page');
    let rows, status = 'all';
    try { rows = await requestJSON('/api/cutting/task-summaries'); }
    catch (e) { el.innerHTML = errorBox(e); return; }

    const count = k => k === 'all' ? rows.length : rows.filter(r => r.status === k).length;
    const tabs = ['all', ...Object.keys(taskLabels)].map(k =>
        `<button class="${status === k ? 'on' : ''}" data-status="${k}" aria-pressed="${status === k}">${k === 'all' ? '全部' : taskLabels[k]} <span class="filter-count num">${count(k)}</span></button>`).join('');
    el.innerHTML = `<div class="ph"><h1>任务</h1><span class="sp"></span>
          <a class="btn pri" href="#/task/new">新建任务</a></div>
        <div class="toolbar"><div class="seg task-filters" role="group" aria-label="任务状态">${tabs}</div><span class="sp"></span>
          <output class="muted" for="task-search"></output>
          <input class="field" id="task-search" type="search" aria-label="搜索任务" placeholder="任务号 / 名称 / 型号 / 来源"></div>
        <div class="body" role="region" aria-label="任务列表" tabindex="0"></div>`;
    const input = el.querySelector('#task-search'), body = el.querySelector('.body'), resultCount = el.querySelector('output');
    function renderRows() {
        const list = filterTasks(rows, input.value, status);
        resultCount.textContent = input.value.trim() ? `共 ${list.length} 条` : '';
        body.innerHTML = list.length ? `<table class="t task-table" aria-label="任务"><thead><tr>
              <th scope="col" class="task-name-col">任务名称 / 编号</th><th scope="col" class="task-status-col">状态</th><th scope="col" class="task-progress-col">良品进度</th>
              <th scope="col">类型 / 材料型号</th><th scope="col" class="task-source-col">来源</th><th scope="col" class="r task-count-col">需求项</th>
              <th scope="col" class="r task-count-col">候选</th><th scope="col" class="r task-count-col">报工</th><th scope="col" class="task-action-col">操作</th></tr></thead><tbody>
            ${list.map(r => {
                const t = r.task, pct = r.total ? r.completed / r.total * 100 : 0;
                const isSlitting = t.problemType === 'SLITTING_1D';
                return `<tr class="click" data-id="${esc(t.id)}"><td><div class="task-identity"><a class="task-clip" href="#/workbench/${encodeURIComponent(t.id)}" title="${esc(t.name)}">${esc(t.name)}</a><small class="num" title="${esc(t.id)}">${esc(shortId(t.id))}</small></div></td>
                  <td><span class="tag ${TAG[r.status] || ''}">${esc(taskLabels[r.status] || r.status)}</span></td>
                  <td><div class="task-progress"><span class="bar" aria-hidden="true"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></span><span class="num">${r.completed}<span class="muted"> / ${r.total} ${isSlitting ? '卷' : '件'}</span></span></div></td>
                  <td><div class="task-material"><span class="tag kind">${isSlitting ? '一维' : '二维'}</span><span class="task-clip" title="${esc(t.materialModel)}">${esc(t.materialModel)}</span></div></td>
                  <td><span class="task-clip muted" title="${esc(t.externalRef)}">${esc(t.externalRef || '—')}</span></td><td class="r num">${(t.demands || []).length}</td>
                  <td class="r num">${r.pendingCount || 0}</td><td class="r num">${r.reportCount || 0}</td>
                  <td><a class="btn sm" href="#/workbench/${encodeURIComponent(t.id)}">${({PLAN_PENDING: '去排料', EXECUTION_PENDING: '查看方案', REPORT_PENDING: '去报工', ATTENTION: '处理异常', COMPLETED: '查看产出'})[r.status] || '打开'}</a> <a class="btn sm" href="#/task/${encodeURIComponent(t.id)}">编辑</a></td></tr>`;
            }).join('')}</tbody></table>` : '<div class="empty">没有符合条件的任务</div>';
        body.scrollTop = 0;
    }
    const filters = el.querySelectorAll('[data-status]');
    filters.forEach(button => button.onclick = () => {
        status = button.dataset.status;
        for (const item of filters) {
            const selected = item === button;
            item.classList.toggle('on', selected);
            item.setAttribute('aria-pressed', String(selected));
        }
        renderRows();
    });
    input.oninput = renderRows;
    body.ondblclick = event => {
        const row = event.target.closest('tr[data-id]');
        if (row && !event.target.closest('a')) location.hash = '#/workbench/' + encodeURIComponent(row.dataset.id);
    };
    renderRows();
}
