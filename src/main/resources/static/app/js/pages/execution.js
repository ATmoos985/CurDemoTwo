// 执行与报工：按工位查看执行单，就地下达 / 开工 / 取消；报工在工作台对应方案上完成。
// 按钮可用性与原因来自后端 allowedActions；写操作经 executionWriter 先落盘再发送，结果不确定时可重试原操作。
import {requestJSON, esc, shortId, fmtTime, errorBox, toast} from '../util.js';
import {executionWriter, executionLabels} from '../../../js/business/cutting/execution-client.js';

const TAG = {DRAFT: '', RELEASED: 'run', RUNNING: 'run', EXPIRED: 'warn', CANCELLED: '', REPORTED: 'ok', REVERSED: 'err'};
const OPEN = ['DRAFT', 'RELEASED', 'RUNNING', 'EXPIRED'];

export async function mount(el) {
    const writer = executionWriter();
    let rows = [], tasks = new Map(), filter = 'open', sel = null, busy = '', cancelling = false;
    async function load() {
        const [views, summaries] = await Promise.all([requestJSON('/api/v2/execution-orders'), requestJSON('/api/cutting/task-summaries')]);
        rows = views; tasks = new Map(summaries.map(s => [s.task.id, s.task]));
    }
    try { await load(); } catch (e) { el.innerHTML = errorBox(e); return; }

    function render() {
        const list = rows.filter(r => filter === 'all' || OPEN.includes(r.effectiveState)).slice().reverse();
        const cur = list.find(r => r.execution.id === sel) || list[0] || null;
        const stations = [...new Set(rows.filter(r => r.reservationActive).map(r => r.execution.station))].sort();
        const pending = [...new Set(rows.map(r => r.execution.taskId))].flatMap(t => writer.pending(t));
        el.innerHTML = `<div class="ph"><h1>执行与报工</h1><span class="crumb">按工位查看执行单；创建执行单与报工在工作台方案上进行</span><span class="sp"></span><button class="btn" id="refresh">刷新</button></div>
          <div class="body">
            ${pending.length ? `<div class="notice" style="margin:0 0 12px">有 ${pending.length} 个执行单操作结果未确认。${pending.map(([slot, v]) => `<button class="btn sm" data-retry="${esc(slot)}">重试 ${esc(v.action)}</button>`).join(' ')}</div>` : ''}
            <div class="cards">${stations.length ? stations.map(s => {
                const rs = rows.filter(r => r.reservationActive && r.execution.station === s), r = rs[0];
                return `<div class="card"><small>工位 ${esc(s)}</small><b style="font-size:15px;font-family:inherit">${esc(tasks.get(r.execution.taskId)?.name || shortId(r.execution.taskId))}</b>
                  <div class="d"><span class="tag ${TAG[r.effectiveState]}">${esc(executionLabels[r.effectiveState] || r.effectiveState)}</span> <span class="num">${shortId(r.execution.id)}</span></div><div class="d">材料 <span class="num">${esc(r.execution.materialId)}</span>${rs.length > 1 ? ` · 另有 ${rs.length - 1} 张` : ''}</div></div>`;
            }).join('') : '<div class="card"><small>工位</small><b style="font-size:15px;font-family:inherit">暂无占用工位的执行单</b></div>'}</div>
            <div class="split" style="grid-template-columns:3fr 2fr;gap:12px">
              <div class="box" style="margin:0"><div class="pane-h">执行单<span class="sp"></span><div class="seg"><button data-f="open" class="${filter === 'open' ? 'on' : ''}">未完成</button><button data-f="all" class="${filter === 'all' ? 'on' : ''}">全部</button></div></div>
                ${list.length ? `<table class="t" style="border:0"><thead><tr><th>执行单</th><th>任务</th><th>工位</th><th>材料</th><th class="r">数量</th><th>状态</th><th>创建</th></tr></thead><tbody>
                ${list.map(r => { const e = r.execution, qty = Object.values(e.demandQuantities || {}).reduce((a, b) => a + b, 0);
                    return `<tr class="click ${cur && e.id === cur.execution.id ? 'sel' : ''}" data-id="${esc(e.id)}"><td class="num">${shortId(e.id)}</td><td>${esc(tasks.get(e.taskId)?.name || shortId(e.taskId))}</td><td>${esc(e.station)}</td><td class="num">${esc(e.materialId)}</td><td class="r num">${qty}</td>
                      <td><span class="tag ${TAG[r.effectiveState] || ''}">${esc(executionLabels[r.effectiveState] || r.effectiveState)}</span></td><td class="num">${fmtTime(e.createdAt)}</td></tr>`; }).join('')}</tbody></table>`
                : '<div class="empty">没有执行单。在工作台的候选方案上“创建执行单”。</div>'}</div>
              <div class="box" style="margin:0">${cur ? detail(cur) : '<div class="empty">选择执行单查看详情</div>'}</div>
            </div></div>`;
        bind(cur);
    }

    function detail(r) {
        const e = r.execution, a = r.allowedActions || {};
        const btn = (k, t) => `<button class="btn sm" data-act="${k}" ${a[k]?.allowed && !busy ? '' : 'disabled'} title="${esc(a[k]?.reason || '')}">${t}</button>`;
        return `<div class="pane-h">执行单 <span class="num">${shortId(e.id)}</span><span class="sp"></span><span class="tag ${TAG[r.effectiveState] || ''}">${esc(executionLabels[r.effectiveState] || r.effectiveState)}</span></div>
          <div class="kv"><div>任务</div><div>${esc(tasks.get(e.taskId)?.name || e.taskId)}</div><div>方案</div><div class="num">${shortId(e.planId)}</div><div>工位</div><div>${esc(e.station)}</div>
          <div>材料</div><div class="num">${esc(e.materialType)} · ${esc(e.materialId)}</div><div>版本</div><div class="num">${e.version}</div><div>预约至</div><div class="num">${fmtTime(e.expiresAt)}</div></div>
          <div style="display:flex;gap:6px;padding:8px 12px;align-items:center;flex-wrap:wrap">
            ${a.release?.allowed ? '<span class="muted">预约</span><input class="field num" id="reserve" value="30" style="width:56px;text-align:right"><span class="muted">分钟</span>' : ''}
            ${btn('release', '下达')}${btn('start', '开工')}${btn('cancel', '取消')}
            <a class="btn sm pri" href="#/workbench/${encodeURIComponent(e.taskId)}/${encodeURIComponent(e.planId)}">${a.report?.allowed ? '去报工' : '查看方案'}</a></div>
          ${cancelling ? '<div style="display:flex;gap:6px;padding:0 12px 10px"><input class="field" id="cancel-reason" placeholder="取消原因（必填）" style="flex:1"><button class="btn sm pri" id="cancel-submit">确认取消</button></div>' : ''}
          <div class="sec">需求数量</div><div class="kv">${Object.entries(e.demandQuantities || {}).map(([k, v]) => `<div>需求 ${esc(k)}</div><div class="num">${v} 件</div>`).join('')}</div>
          <div class="sec">操作记录</div><table class="t" style="border:0"><tbody>${(e.events || []).map(ev => `<tr><td class="num">${fmtTime(ev.at)}</td><td>${esc({release: '下达', start: '开工', cancel: '取消', report: '报工', reported: '报工', reversed: '冲销'}[ev.action] || ev.action)}</td><td class="muted">${esc(ev.reason || '')}</td></tr>`).join('')}</tbody></table>`;
    }

    async function act(action, r, values = {}) {
        busy = action; render();
        try {
            await writer.command(action, {taskId: r.execution.taskId, planId: r.execution.planId, id: r.execution.id, version: r.execution.version}, values);
            toast({release: '已下达并预约材料', start: '已开工', cancel: '执行单已取消'}[action]);
        } catch (e) { toast((e.httpStatus ? '' : '结果未确认，可重试：') + e.message, true); }
        busy = ''; cancelling = false;
        try { await load(); } catch { /* 刷新失败保留当前视图 */ }
        render();
    }

    function bind(cur) {
        el.querySelector('#refresh').onclick = async () => { await load(); render(); };
        el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
        el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { sel = tr.dataset.id; cancelling = false; render(); });
        el.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
            try { await writer.retry(b.dataset.retry); toast('原操作已确认完成'); } catch (e) { toast(e.message, true); }
            await load(); render();
        });
        if (!cur) return;
        el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
            const k = b.dataset.act;
            if (k === 'cancel') { cancelling = true; render(); return; }
            act(k, cur, k === 'release' ? {reservationSeconds: Math.round((Number(el.querySelector('#reserve')?.value) || 30) * 60)} : {});
        });
        el.querySelector('#cancel-submit')?.addEventListener('click', () => {
            const reason = el.querySelector('#cancel-reason').value.trim();
            if (!reason) return toast('请填写取消原因', true);
            act('cancel', cur, {reason});
        });
    }
    render();
}
