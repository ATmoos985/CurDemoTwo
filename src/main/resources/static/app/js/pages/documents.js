// 库存单据：库存流水是每一次库存 / 需求 / 报工变化的审计记录，用于追溯与对账。
// 期初迁移是启用流水时为已有对象各写一条的开账记录，默认隐藏。移库、盘点单据在现有页面提交。
import {requestJSON, esc, fmtTime, shortId, errorBox} from '../util.js';

// 与后端写入流水的事件代码一一对应（RemnantService.mutate）
const EVENT = {MIGRATION_OPENING: '期初迁移', CUT_REPORT: '报工记账', CUT_REPORT_BATCH: '批量报工', REPORT_REVERSE: '报工冲销',
    DEMAND_ADJUSTMENT: '需求调整', INSPECTION: '验布入档', INVENTORY_COUNT: '盘点', INVENTORY_TRANSFER: '移库', QUALITY_DISPOSITION: '复检处置',
    REMNANT_ISSUE: '料头领用', REMNANT_RECEIPT: '料头入库', REMNANT_SCRAP: '料头报废', REMNANT_STATUS_ADJUSTMENT: '料头状态调整',
    ROLL_RECEIPT: '母卷入库', ROLL_RECEIPT_OR_UPDATE: '母卷入库 / 更新', DEMO_RECEIPT: '演示入库', DEMO_RESET: '演示重置', SYSTEM_UPDATE: '系统更新',
    DEFECT_VOID: '疵点作废'};
const AGG = {DEMAND: '需求', ROLL: '母卷', MOTHER_ROLL: '母卷', REMNANT: '料头', REPORT: '报工单', TASK: '任务', PLAN: '方案', EXECUTION: '执行单',
    CHECKPOINT: '检查点', TRANSFER: '移库单', COUNT: '盘点单', QUALITY: '复检'};
const label = (map, k) => map[k] || k;

async function loadLedger() {
    let items = [], after = 0;
    for (let i = 0; i < 20; i++) {           // 最多 20 页，防止异常数据无限翻页
        const page = await requestJSON('/api/v2/inventory-ledger?limit=500&after=' + after);
        items = items.concat(page.items || []);
        if (!page.hasMore || !(page.items || []).length) break;
        after = page.nextCursor ?? items[items.length - 1].sequence;
    }
    return items;
}

export async function mount(el) {
    let transfers, counts, items;
    try { [transfers, counts, items] = await Promise.all([requestJSON('/api/v2/inventory-transfers'), requestJSON('/api/v2/inventory-counts'), loadLedger()]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    const asList = x => Array.isArray(x) ? x : (Object.values(x || {}).find(Array.isArray) || []);
    const f = {tab: 'ledger', event: '', agg: '', q: '', opening: false};
    const events = [...new Set(items.map(i => i.eventType))], aggs = [...new Set(items.map(i => i.aggregateType))];
    const openingCount = items.filter(i => i.eventType === 'MIGRATION_OPENING').length;

    function filtered() {
        const q = f.q.trim().toLowerCase();
        return items.filter(i => (f.opening || i.eventType !== 'MIGRATION_OPENING')
            && (!f.event || i.eventType === f.event) && (!f.agg || i.aggregateType === f.agg)
            && (!q || [i.aggregateId, i.businessId, i.actor, i.transactionId, ...(i.sourceReportIds || [])].some(v => String(v || '').toLowerCase().includes(q))));
    }
    function render() {
        const tr = asList(transfers), ct = asList(counts), list = filtered();
        el.innerHTML = `<div class="ph"><h1>库存单据</h1><span class="crumb">库存流水记录每一次库存、需求与报工变化，用于追溯和对账</span><span class="sp"></span><a class="btn" href="/transfers.html">新建移库 ↗</a><a class="btn" href="/counts.html">新建盘点 ↗</a></div>
          <div class="toolbar"><div class="seg"><button data-tab="ledger" class="${f.tab === 'ledger' ? 'on' : ''}">库存流水</button><button data-tab="transfer" class="${f.tab === 'transfer' ? 'on' : ''}">移库 ${tr.length}</button><button data-tab="count" class="${f.tab === 'count' ? 'on' : ''}">盘点 ${ct.length}</button></div>
            ${f.tab === 'ledger' ? `<span class="vsep"></span>
            <select class="field" id="f-event"><option value="">全部事件</option>${events.map(e => `<option value="${esc(e)}" ${f.event === e ? 'selected' : ''}>${esc(label(EVENT, e))}</option>`).join('')}</select>
            <select class="field" id="f-agg"><option value="">全部对象</option>${aggs.map(a => `<option value="${esc(a)}" ${f.agg === a ? 'selected' : ''}>${esc(label(AGG, a))}</option>`).join('')}</select>
            <label class="muted" style="display:flex;align-items:center;gap:4px;font-size:12.5px"><input type="checkbox" id="f-open" ${f.opening ? 'checked' : ''}>显示期初迁移（${openingCount}）</label>
            <span class="sp"></span><input class="field" id="f-q" placeholder="对象编号 / 报工单 / 操作者" style="width:220px" value="${esc(f.q)}">` : ''}</div>
          <div class="body">${f.tab === 'ledger' ? (list.length ? `<table class="t"><thead><tr><th class="r">序号</th><th>时间</th><th>事件</th><th>对象</th><th>对象编号</th><th>关联报工</th><th>操作者</th><th class="r">版本</th></tr></thead><tbody>
              ${list.slice().reverse().map(i => `<tr><td class="r num">${i.sequence}</td><td class="num">${fmtTime(i.occurredAt)}</td><td>${esc(label(EVENT, i.eventType))}</td><td>${esc(label(AGG, i.aggregateType))}</td>
                <td class="num" title="${esc(i.aggregateId)}">${esc(String(i.aggregateId).length > 24 ? shortId(i.aggregateId) : i.aggregateId)}</td><td class="num">${(i.sourceReportIds || []).map(shortId).join(', ') || '—'}</td>
                <td>${esc(i.actor || '—')}</td><td class="r num">${i.beforeVersion} → ${i.afterVersion}</td></tr>`).join('')}</tbody></table>
              <div class="pager"><span>显示 ${list.length} / 共 ${items.length} 条</span><span>最新在前</span></div>` : '<div class="empty">没有符合条件的流水</div>')
            : docs(f.tab === 'transfer' ? tr : ct)}</div>`;
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { f.tab = b.dataset.tab; render(); });
        const on = (id, ev, fn) => el.querySelector(id)?.addEventListener(ev, fn);
        on('#f-event', 'change', e => { f.event = e.target.value; render(); });
        on('#f-agg', 'change', e => { f.agg = e.target.value; render(); });
        on('#f-open', 'change', e => { f.opening = e.target.checked; render(); });
        on('#f-q', 'input', e => { f.q = e.target.value; const p = e.target.selectionStart; render(); const n = el.querySelector('#f-q'); n.focus(); n.setSelectionRange(p, p); });
    }
    function docs(rows) {
        if (!rows.length) return '<div class="empty">暂无单据</div>';
        return `<table class="t"><thead><tr><th>单据</th><th>时间</th><th>内容</th></tr></thead><tbody>${rows.slice().reverse().map(r => `<tr><td class="num">${shortId(r.id || r.documentId)}</td><td class="num">${fmtTime(r.postedAt || r.createdAt || r.at)}</td><td class="wrap muted">${esc(JSON.stringify(r).slice(0, 160))}</td></tr>`).join('')}</tbody></table>`;
    }
    render();
}
