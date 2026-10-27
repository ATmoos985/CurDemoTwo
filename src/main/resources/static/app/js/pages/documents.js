// 库存单据：移库、盘点与库存流水（只读）；提交单据在现有移库 / 盘点页完成。
import {requestJSON, esc, fmtTime, shortId, errorBox} from '../util.js';

const EVENT = {MIGRATION_OPENING: '期初迁移', REPORT_CONFIRMED: '报工记账', REPORT_REVERSED: '报工冲销', TRANSFER_POSTED: '移库', COUNT_POSTED: '盘点',
    QUALITY_DISPOSITION: '复检处置', ROLL_REGISTERED: '母卷登记', INSPECTION_DEFECTS: '验布疵点', REMNANT_SCRAPPED: '料头报废'};

export async function mount(el) {
    let transfers, counts, ledger;
    try { [transfers, counts, ledger] = await Promise.all([requestJSON('/api/v2/inventory-transfers'), requestJSON('/api/v2/inventory-counts'), requestJSON('/api/v2/inventory-ledger?limit=100')]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    let tab = 'ledger', items = ledger.items || [], cursor = ledger.nextCursor, more = ledger.hasMore;
    const asList = x => Array.isArray(x) ? x : (Object.values(x || {}).find(Array.isArray) || []);
    function render() {
        const tr = asList(transfers), ct = asList(counts);
        el.innerHTML = `<div class="ph"><h1>库存单据</h1><span class="crumb">所有库存变化都有单据与流水</span><span class="sp"></span><a class="btn" href="/transfers.html">新建移库 ↗</a><a class="btn" href="/counts.html">新建盘点 ↗</a></div>
          <div class="toolbar"><div class="seg"><button data-tab="ledger" class="${tab === 'ledger' ? 'on' : ''}">库存流水 ${items.length}${more ? '+' : ''}</button><button data-tab="transfer" class="${tab === 'transfer' ? 'on' : ''}">移库 ${tr.length}</button><button data-tab="count" class="${tab === 'count' ? 'on' : ''}">盘点 ${ct.length}</button></div></div>
          <div class="body">${tab === 'ledger' ? `<table class="t"><thead><tr><th class="r">序号</th><th>时间</th><th>事件</th><th>对象</th><th>对象编号</th><th>操作者</th><th class="r">版本</th></tr></thead><tbody>
              ${items.slice().reverse().map(i => `<tr><td class="r num">${i.sequence}</td><td class="num">${fmtTime(i.occurredAt)}</td><td>${esc(EVENT[i.eventType] || i.eventType)}</td><td>${esc(i.aggregateType)}</td><td class="num">${esc(String(i.aggregateId).length > 24 ? shortId(i.aggregateId) : i.aggregateId)}</td><td>${esc(i.actor || '—')}</td><td class="r num">${i.beforeVersion} → ${i.afterVersion}</td></tr>`).join('')}</tbody></table>
              ${more ? '<div class="pager"><span></span><button class="btn sm" id="more">加载更多</button></div>' : ''}`
            : list(tab === 'transfer' ? tr : ct)}</div>`;
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
        el.querySelector('#more')?.addEventListener('click', async () => {
            const next = await requestJSON('/api/v2/inventory-ledger?limit=100&after=' + encodeURIComponent(cursor ?? items.at(-1)?.sequence ?? 0));
            items = items.concat(next.items || []); cursor = next.nextCursor; more = next.hasMore; render();
        });
    }
    function list(rows) {
        if (!rows.length) return '<div class="empty">暂无单据</div>';
        return `<table class="t"><thead><tr><th>单据</th><th>时间</th><th>内容</th></tr></thead><tbody>${rows.slice().reverse().map(r => `<tr><td class="num">${shortId(r.id || r.documentId)}</td><td class="num">${fmtTime(r.postedAt || r.createdAt || r.at)}</td><td class="wrap muted">${esc(JSON.stringify(r).slice(0, 160))}</td></tr>`).join('')}</tbody></table>`;
    }
    render();
}
