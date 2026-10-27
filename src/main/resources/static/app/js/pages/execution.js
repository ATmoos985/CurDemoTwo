// 执行与报工：执行单列表与详情；报工在经典工作台提交（本版只读）。
import {requestJSON, esc, shortId, fmtTime, errorBox} from '../util.js';

const STATE = {DRAFT: ['草稿', ''], RELEASED: ['已下达', 'run'], RUNNING: ['执行中', 'run'], REPORTED: ['已报工', 'ok'], CANCELLED: ['已取消', ''], EXPIRED: ['已过期', 'warn']};

export async function mount(el) {
    let rows;
    try { rows = await requestJSON('/api/v2/execution-orders'); } catch (e) { el.innerHTML = errorBox(e); return; }
    let filter = 'open', sel = null;
    const open = r => !['REPORTED', 'CANCELLED', 'EXPIRED'].includes(r.execution.state);
    function render() {
        const list = rows.filter(r => filter === 'all' || open(r)).slice().reverse();
        const cur = list.find(r => r.execution.id === sel) || list[0] || null;
        const stations = [...new Set(rows.filter(open).map(r => r.execution.station))];
        el.innerHTML = `<div class="ph"><h1>执行与报工</h1><span class="crumb">按工位查看执行单</span><span class="sp"></span><a class="btn pri" href="/index.html?view=executions">报工（经典工作台）↗</a></div>
          <div class="body">
            <div class="cards">${stations.length ? stations.map(s => {
                const rs = rows.filter(r => open(r) && r.execution.station === s), e = rs[0].execution, [t, c] = STATE[e.state] || [e.state, ''];
                return `<div class="card"><small>工位 ${esc(s)}</small><b style="font-size:15px;font-family:inherit">${rs.length} 张执行单</b><div class="d"><span class="tag ${c}">${t}</span> <span class="num">${shortId(e.id)}</span></div><div class="d">材料 <span class="num">${esc(e.materialId)}</span></div></div>`;
            }).join('') : '<div class="card"><small>工位</small><b style="font-size:15px;font-family:inherit">暂无进行中的执行单</b></div>'}</div>
            <div class="split" style="grid-template-columns:3fr 2fr;gap:12px">
              <div class="box" style="margin:0"><div class="pane-h">执行单<span class="sp"></span><div class="seg"><button data-f="open" class="${filter === 'open' ? 'on' : ''}">未完成</button><button data-f="all" class="${filter === 'all' ? 'on' : ''}">全部</button></div></div>
                ${list.length ? `<table class="t" style="border:0"><thead><tr><th>执行单</th><th>任务</th><th>工位</th><th>材料</th><th class="r">数量</th><th>状态</th><th>创建</th></tr></thead><tbody>
                ${list.map(r => { const e = r.execution, [t, c] = STATE[e.state] || [e.state, '']; const qty = Object.values(e.demandQuantities || {}).reduce((a, b) => a + b, 0);
                    return `<tr class="click ${cur && e.id === cur.execution.id ? 'sel' : ''}" data-id="${esc(e.id)}"><td class="num">${shortId(e.id)}</td><td class="num"><a href="#/workbench/${encodeURIComponent(e.taskId)}">${shortId(e.taskId)}</a></td><td>${esc(e.station)}</td><td class="num">${esc(e.materialId)}</td><td class="r num">${qty}</td><td><span class="tag ${c}">${t}</span></td><td class="num">${fmtTime(e.createdAt)}</td></tr>`; }).join('')}</tbody></table>`
                : '<div class="empty">没有执行单</div>'}</div>
              <div class="box" style="margin:0">${cur ? detail(cur) : '<div class="empty">选择执行单查看详情</div>'}</div>
            </div></div>`;
        el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { filter = b.dataset.f; render(); });
        el.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => { sel = tr.dataset.id; render(); });
    }
    function detail(r) {
        const e = r.execution, [t, c] = STATE[e.state] || [e.state, ''];
        return `<div class="pane-h">执行单 <span class="num">${shortId(e.id)}</span><span class="sp"></span><span class="tag ${c}">${t}</span></div>
          <div class="kv"><div>任务</div><div class="num">${esc(e.taskId)}</div><div>方案</div><div class="num">${esc(e.planId)}</div><div>工位</div><div>${esc(e.station)}</div>
          <div>材料</div><div class="num">${esc(e.materialType)} · ${esc(e.materialId)}</div><div>版本</div><div class="num">${e.version}</div><div>到期</div><div class="num">${fmtTime(e.expiresAt)}</div></div>
          <div class="sec">需求数量</div><div class="kv">${Object.entries(e.demandQuantities || {}).map(([k, v]) => `<div>需求 ${esc(k)}</div><div class="num">${v}</div>`).join('')}</div>
          <div class="sec">操作记录</div><table class="t" style="border:0"><tbody>${(e.events || []).map(ev => `<tr><td class="num">${fmtTime(ev.at)}</td><td>${esc({release: '下达', start: '开工', cancel: '取消', report: '报工'}[ev.action] || ev.action)}</td><td class="muted">${esc(ev.reason || '')}</td></tr>`).join('')}</tbody></table>`;
    }
    render();
}
