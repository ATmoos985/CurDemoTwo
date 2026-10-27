// 生产分析：内部库存对账与报工面积汇总（只读）。
import {requestJSON, esc, fmtN, shortId, errorBox} from '../util.js';

export async function mount(el) {
    let rec, rows;
    try { [rec, rows] = await Promise.all([requestJSON('/api/v2/inventory-ledger/reconciliation'), requestJSON('/api/cutting/task-summaries')]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    const areas = rec.areas || [], sum = k => areas.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const consumed = sum('consumed'), qualified = sum('qualified');
    const done = rows.filter(r => r.status === 'COMPLETED').length;
    el.innerHTML = `<div class="ph"><h1>生产分析</h1><span class="crumb">来自报工记账与库存流水</span><span class="sp"></span><a class="btn" href="/analysis.html">完整对账 ↗</a></div>
      <div class="body">
        <div class="cards">
          <div class="card"><small>库存对账</small><b style="color:${(rec.issues || []).length ? 'var(--err)' : 'var(--ok)'}">${(rec.issues || []).length ? (rec.issues.length + ' 项异常') : '平衡'}</b><div class="d">流水 ${fmtN(rec.entryCount)} 条</div></div>
          <div class="card"><small>报工面积利用率</small><b>${consumed ? (qualified / consumed * 100).toFixed(1) : '—'}%</b><div class="d">良品 ${fmtN(qualified, 2)} / 耗用 ${fmtN(consumed, 2)} m²</div></div>
          <div class="card"><small>已完成任务</small><b>${done}</b><div class="d">共 ${rows.length} 个任务</div></div>
          <div class="card"><small>报工单</small><b>${areas.length}</b><div class="d">回收 ${fmtN(sum('recovered'), 2)} m² · 报废 ${fmtN(sum('rejected'), 2)} m²</div></div>
        </div>
        ${(rec.issues || []).length ? `<div class="box"><div class="pane-h">对账异常</div><table class="t" style="border:0"><tbody>${rec.issues.map(i => `<tr><td class="wrap">${esc(JSON.stringify(i))}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="box"><div class="pane-h">报工面积明细<span class="sub">单位 m²</span></div>
          ${areas.length ? `<table class="t" style="border:0"><thead><tr><th>报工单</th><th class="r">耗用</th><th class="r">良品</th><th class="r">回收</th><th class="r">报废</th><th class="r">其他损耗</th><th class="r">差异</th><th class="r">利用率</th></tr></thead><tbody>
          ${areas.map(a => `<tr><td class="num">${shortId(a.reportId)}</td><td class="r num">${fmtN(a.consumed, 3)}</td><td class="r num">${fmtN(a.qualified, 3)}</td><td class="r num">${fmtN(a.recovered, 3)}</td><td class="r num">${fmtN(a.rejected, 3)}</td><td class="r num">${fmtN(a.otherWasteAndLoss, 3)}</td><td class="r num" style="color:${Math.abs(a.difference) > 1e-6 ? 'var(--err)' : 'inherit'}">${fmtN(a.difference, 3)}</td><td class="r num">${a.consumed ? (a.qualified / a.consumed * 100).toFixed(1) : '—'}%</td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无报工</div>'}</div>
      </div>`;
}
