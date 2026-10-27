// 库存：母卷与料头档案、筛选，以及入库 / 移库 / 盘点 / 料头报废。
// 移库与盘点按后端 options 给出的可操作材料与库存版本提交（幂等键 + 本机留存，结果未知时可重试原操作）。
import {requestJSON, esc, fmtM, fmtN, errorBox, toast, idempotentPost, pendingWrite, retryWrite, dropWrite} from '../util.js';

const Q = {PASSED: ['合格', 'ok'], PENDING: ['待检', 'warn'], FAILED: ['不合格', 'err'], QUARANTINED: ['隔离', 'err']};
const R = {AVAILABLE: ['可用', 'ok'], RESERVED: ['已预约', 'run'], CONSUMED: ['已消耗', ''], SCRAPPED: ['已报废', ''], QUARANTINED: ['隔离', 'err']};
const ACTIONS = {receive: '母卷入库', transfer: '移库', count: '盘点', scrap: '料头报废'};

export async function mount(el) {
    let rolls, remnants;
    const load = async () => { [rolls, remnants] = await Promise.all([requestJSON('/api/rolls'), requestJSON('/api/remnants')]); };
    try { await load(); } catch (e) { el.innerHTML = errorBox(e); return; }
    let tab = 'roll', sel = 0, q = '', action = null, opts = null, busy = false;
    const picked = new Set();            // "type:id"
    const form = {destination: '', reason: '', operator: '', rollId: '', rollModel: '', width: '', length: '', counts: {}};
    const f = {model: '', loc: '', status: ''};
    const keys = isRoll => isRoll ? {model: 'rollModel', loc: 'storageLocation', status: 'inspectionStatus'} : {model: 'materialBatch', loc: 'location', status: 'status'};
    const options = (rows, k) => [...new Set(rows.map(x => x[k]).filter(Boolean))].sort();
    const idOf = (isRoll, x) => `${isRoll ? 'roll' : 'remnant'}:${isRoll ? x.rollId : x.id}`;

    function render() {
        const isRoll = tab === 'roll', k = keys(isRoll), all = isRoll ? rolls : remnants;
        const list = all.filter(x => (!f.model || x[k.model] === f.model) && (!f.loc || x[k.loc] === f.loc) && (!f.status || x[k.status] === f.status)
            && (!q || JSON.stringify([x.rollId, x.id, x.rollModel, x.materialName, x.materialBatch, x.storageLocation, x.location, x.sourceRollId]).toLowerCase().includes(q.toLowerCase())));
        const select = (id, all0, key, map) => `<select class="field" id="${id}"><option value="">${all0}</option>${options(all, k[key]).map(v => `<option value="${esc(v)}" ${f[key] === v ? 'selected' : ''}>${esc(map?.[v]?.[0] || v)}</option>`).join('')}</select>`;
        const cur = list[Math.min(sel, list.length - 1)];
        const pendings = ['transfer', 'count'].map(s => [s, pendingWrite(s)]).filter(([, v]) => v);
        el.innerHTML = `<div class="ph"><h1>库存</h1><span class="crumb">母卷与料头 · 勾选材料后可移库 / 盘点</span><span class="sp"></span>
            <button class="btn" data-action="transfer" ${picked.size ? '' : 'disabled title="先在列表中勾选材料"'}>移库${picked.size ? ` (${picked.size})` : ''}</button>
            <button class="btn" data-action="count" ${picked.size ? '' : 'disabled title="先在列表中勾选材料"'}>盘点${picked.size ? ` (${picked.size})` : ''}</button>
            <button class="btn pri" data-action="receive">母卷入库</button></div>
          ${pendings.length ? `<div class="notice" style="margin:8px 16px 0">${pendings.map(([s]) => `${ACTIONS[s]}提交结果未确认 <button class="btn sm" data-retry="${s}">重试原操作</button> <button class="btn sm" data-drop="${s}">放弃</button>`).join('　')}</div>` : ''}
          <div class="toolbar"><div class="seg"><button data-tab="roll" class="${isRoll ? 'on' : ''}">母卷 ${rolls.length}</button><button data-tab="rem" class="${isRoll ? '' : 'on'}">料头 ${remnants.length}</button></div>
            <span class="vsep"></span>${select('f-model', isRoll ? '全部型号' : '全部批次', 'model')}${select('f-loc', '全部库位', 'loc')}${select('f-status', '全部状态', 'status', isRoll ? Q : R)}
            ${f.model || f.loc || f.status || q ? '<button class="btn sm" id="f-clear">清除筛选</button>' : ''}
            ${picked.size ? `<button class="btn sm" id="pick-clear">清空勾选 ${picked.size}</button>` : ''}
            <span class="sp"></span><span class="muted" style="font-size:12px">${list.length} / ${all.length}</span><input class="field" id="q" placeholder="搜索编号 / 型号 / 批次 / 库位" style="width:220px" value="${esc(q)}"></div>
          <div class="split" style="grid-template-columns:1fr ${action ? 420 : 340}px">
            <section class="pane" style="background:var(--bg)"><div class="body">${list.length ? `<table class="t"><thead><tr><th><input type="checkbox" id="pick-all"></th>${isRoll
                ? '<th>卷号</th><th>型号 / 材料</th><th class="r">幅宽</th><th class="r">剩余 / 总长</th><th>余量</th><th class="r">疵点</th><th>库位</th><th>验布</th>'
                : '<th>编号</th><th>来源</th><th class="r">宽 × 长</th><th class="r">面积</th><th>库位</th><th>疵点</th><th>状态</th>'}</tr></thead><tbody>
              ${list.map((x, i) => { const pk = `<td><input type="checkbox" data-pick="${esc(idOf(isRoll, x))}" ${picked.has(idOf(isRoll, x)) ? 'checked' : ''}></td>`;
                  if (isRoll) { const rem = x.currentRemainingLength ?? (x.totalLength - x.usedLength), [qt, qc] = Q[x.inspectionStatus] || [x.inspectionStatus || '—', ''];
                    return `<tr class="click ${x === cur ? 'sel' : ''}" data-i="${i}">${pk}<td class="num">${esc(x.rollId)}</td><td>${esc(x.rollModel || '')} <span class="muted">${esc(x.materialName || '')}</span></td><td class="r num">${fmtN(x.width)}</td>
                      <td class="r num">${fmtM(rem)} / ${fmtM(x.totalLength)} m</td><td><span class="bar"><i style="width:${x.totalLength ? rem / x.totalLength * 100 : 0}%"></i></span></td><td class="r num">${x.defectsCount ?? (x.defects || []).length}</td><td>${esc(x.storageLocation || '—')}</td><td><span class="tag ${qc}">${esc(qt)}</span></td></tr>`; }
                  const [st, sc] = R[x.status] || [x.status, ''];
                  return `<tr class="click ${x === cur ? 'sel' : ''}" data-i="${i}">${pk}<td class="num">${esc(x.id)}</td><td class="num">${esc(x.sourceRollId || '—')}</td><td class="r num">${fmtN(x.width)} × ${fmtN(x.length)}</td><td class="r num">${fmtN(x.area, 2)} m²</td><td>${esc(x.location || '—')}</td><td>${x.hasDefect ? '<span class="tag warn">带疵</span>' : '无'}</td><td><span class="tag ${sc}">${esc(st)}</span></td></tr>`; }).join('')}
              </tbody></table>` : '<div class="empty">没有匹配的记录</div>'}</div></section>
            <section class="pane">${action ? actionPanel() : cur ? (isRoll ? rollDetail(cur) : remDetail(cur)) : ''}</section></div>`;
        bind(list, isRoll, cur);
    }

    function selectedMaterials() {
        return [...picked].map(s => { const [type, id] = s.split(':'); const m = opts?.materials?.find(x => x.type === type && x.id === id); return {type, id, m}; });
    }

    function actionPanel() {
        const head = `<div class="pane-h">${ACTIONS[action]}<span class="sp"></span><button class="btn sm" id="act-close" ${busy ? 'disabled' : ''}>关闭</button></div>`;
        if (action === 'receive') return `${head}<div class="pane-b"><div class="form" style="grid-template-columns:90px 1fr">
            <label>卷号</label><input class="field" data-form="rollId" value="${esc(form.rollId)}" placeholder="如 ROLL-2026-1101">
            <label>型号</label><input class="field" data-form="rollModel" list="inv-models" value="${esc(form.rollModel)}"><datalist id="inv-models">${options(rolls, 'rollModel').map(m => `<option>${esc(m)}</option>`).join('')}</datalist>
            <label>幅宽 mm</label><input class="field num" data-form="width" value="${esc(form.width)}">
            <label>整卷长 m</label><input class="field num" data-form="length" value="${esc(form.length)}"></div>
            <div class="muted" style="padding:0 12px 8px;font-size:12px">登记后状态为“待检”，在跑布验疵中标记疵点并入档；验布合格前不能下达执行。</div>
            <div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn pri" id="act-submit" ${busy ? 'disabled' : ''}>登记并去验布</button></div></div>`;
        if (action === 'scrap') {
            const x = remnants.find(r => r.id === form.scrapId);
            return `${head}<div class="pane-b"><div class="kv"><div>料头</div><div class="num">${esc(x?.id)}</div><div>尺寸</div><div class="num">${fmtN(x?.width)} × ${fmtN(x?.length)} mm</div></div>
              <div class="form" style="grid-template-columns:90px 1fr"><label>报废原因</label><input class="field" data-form="reason" value="${esc(form.reason)}" placeholder="如：现场破损"></div>
              <div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn pri" id="act-submit" ${busy ? 'disabled' : ''}>确认报废</button></div></div>`;
        }
        if (!opts) return `${head}<div class="loading">读取可操作材料…</div>`;
        const mats = selectedMaterials(), blocked = mats.filter(x => !x.m?.allowed);
        const rows = mats.map(({type, id, m}) => {
            const c = form.counts[type + ':' + id] || {present: true, width: m?.width ?? '', length: m?.length ?? ''};
            return `<tr><td>${type === 'roll' ? '母卷' : '料头'}</td><td class="num">${esc(id)}</td><td>${esc(m?.location || '—')}</td>
              ${action === 'count' ? `<td><input type="checkbox" data-cp="${esc(type + ':' + id)}" ${c.present ? 'checked' : ''}></td>
                <td class="r"><input class="field num" data-cw="${esc(type + ':' + id)}" value="${esc(c.width)}" style="width:66px;height:22px;text-align:right" ${type === 'roll' || !c.present ? 'disabled' : ''}></td>
                <td class="r"><input class="field num" data-cl="${esc(type + ':' + id)}" value="${esc(c.length)}" style="width:76px;height:22px;text-align:right" ${!c.present ? 'disabled' : ''}></td>` : ''}
              <td>${m?.allowed ? '' : `<span class="tag err" title="${esc(m?.reason || '不可操作')}">不可</span>`}</td></tr>`;
        }).join('');
        return `${head}<div class="pane-b">
          <table class="t" style="border:0"><thead><tr><th>类型</th><th>编号</th><th>现库位</th>${action === 'count' ? '<th>在库</th><th class="r">实测宽</th><th class="r">实测长 mm</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table>
          ${blocked.length ? `<div class="notice">${blocked.map(x => `${esc(x.id)}：${esc(x.m?.reason || '当前不可操作')}`).join('<br>')}</div>` : ''}
          <div class="form" style="grid-template-columns:90px 1fr">
            ${action === 'transfer' ? `<label>目标库位</label><input class="field" data-form="destination" value="${esc(form.destination)}">` : ''}
            <label>原因</label><input class="field" data-form="reason" value="${esc(form.reason)}">
            <label>操作人</label><input class="field" data-form="operator" value="${esc(form.operator)}"></div>
          ${action === 'count' ? '<div class="muted" style="padding:0 12px 8px;font-size:12px">母卷盘点实测未切长度（幅宽不随盘点改变）；料头实测宽、长；不在库填“否”。差额单独记账，不算生产产出。</div>' : '<div class="muted" style="padding:0 12px 8px;font-size:12px">移库只改库位，不改数量、质量与来源。</div>'}
          <div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn pri" id="act-submit" ${busy || blocked.length || !mats.length ? 'disabled' : ''}>确认${ACTIONS[action]}</button></div></div>`;
    }

    async function openAction(kind, extra = {}) {
        action = kind; Object.assign(form, {reason: '', ...extra}); opts = null; render();
        if (kind === 'transfer' || kind === 'count') {
            try { opts = await requestJSON(`/api/v2/inventory-${kind === 'transfer' ? 'transfers' : 'counts'}/options`); } catch (e) { toast(e.message, true); }
            render();
        }
    }

    async function submit() {
        busy = true; render();
        try {
            if (action === 'receive') {
                const body = {rollId: form.rollId.trim(), rollModel: form.rollModel.trim(), width: Number(form.width), totalLength: Math.round(Number(form.length) * 1000)};
                if (!body.rollId || !body.rollModel || !(body.width > 0) || !(body.totalLength > 0)) throw new Error('请填写卷号、型号、幅宽与整卷长');
                await requestJSON('/api/inspection/rolls', body);
                toast('母卷已登记，进入跑布验疵'); location.hash = '#/inspection/' + encodeURIComponent(body.rollId); return;
            }
            if (action === 'scrap') {
                if (!form.reason.trim()) throw new Error('请填写报废原因');
                await requestJSON('/api/remnants/' + encodeURIComponent(form.scrapId) + '/scrap', {reason: form.reason.trim()});
                toast('料头已报废'); action = null;
            } else {
                if (!form.reason.trim() || !form.operator.trim() || (action === 'transfer' && !form.destination.trim())) throw new Error(action === 'transfer' ? '请填写目标库位、原因与操作人' : '请填写原因与操作人');
                const materials = selectedMaterials().map(({type, id}) => {
                    if (action === 'transfer') return {type, id};
                    const c = form.counts[type + ':' + id] || {present: true, width: opts.materials.find(x => x.type === type && x.id === id)?.width, length: opts.materials.find(x => x.type === type && x.id === id)?.length};
                    return {type, id, present: !!c.present, width: c.present ? Number(c.width) : 0, length: c.present ? Number(c.length) : 0};
                });
                const body = action === 'transfer' ? {expectedRevision: opts.revision, destination: form.destination.trim(), reason: form.reason.trim(), operator: form.operator.trim(), materials}
                    : {expectedRevision: opts.revision, reason: form.reason.trim(), operator: form.operator.trim(), materials};
                await idempotentPost(action, `/api/v2/inventory-${action === 'transfer' ? 'transfers' : 'counts'}`, body);
                toast(`${ACTIONS[action]}已过账`); picked.clear(); action = null;
            }
            await load();
        } catch (e) { toast((e.httpStatus || e.message.startsWith('请') || e.message.startsWith('上次') ? '' : '结果未确认，可重试：') + e.message, true); }
        busy = false; render();
    }

    function bind(list, isRoll, cur) {
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; sel = 0; f.model = f.loc = f.status = ''; render(); });
        for (const key of ['model', 'loc', 'status']) el.querySelector('#f-' + key).onchange = e => { f[key] = e.target.value; sel = 0; render(); };
        el.querySelector('#f-clear')?.addEventListener('click', () => { f.model = f.loc = f.status = ''; q = ''; sel = 0; render(); });
        el.querySelector('#pick-clear')?.addEventListener('click', () => { picked.clear(); render(); });
        el.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = e => { if (e.target.matches('input')) return; sel = Number(tr.dataset.i); if (!action) render(); else { sel = Number(tr.dataset.i); } });
        el.querySelectorAll('[data-pick]').forEach(c => c.onchange = () => { c.checked ? picked.add(c.dataset.pick) : picked.delete(c.dataset.pick); render(); });
        el.querySelector('#pick-all')?.addEventListener('change', e => { list.forEach(x => e.target.checked ? picked.add(idOf(isRoll, x)) : picked.delete(idOf(isRoll, x))); render(); });
        const qi = el.querySelector('#q'); qi.oninput = () => { q = qi.value; sel = 0; const p = qi.selectionStart; render(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(p, p); };
        el.querySelectorAll('[data-action]').forEach(b => b.onclick = () => openAction(b.dataset.action));
        el.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => { try { await retryWrite(b.dataset.retry); toast('原操作已确认'); await load(); } catch (e) { toast(e.message, true); } render(); });
        el.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => { dropWrite(b.dataset.drop); toast('已放弃待确认操作，请到库存单据核对是否已过账'); render(); });
        el.querySelector('#scrap-open')?.addEventListener('click', () => openAction('scrap', {scrapId: cur.id}));
        el.querySelector('#act-close')?.addEventListener('click', () => { action = null; render(); });
        el.querySelector('#act-submit')?.addEventListener('click', submit);
        el.querySelectorAll('[data-form]').forEach(i => i.onchange = () => { form[i.dataset.form] = i.value; });
        const cnt = id => form.counts[id] ||= (() => { const [type, mid] = id.split(':'), m = opts?.materials?.find(x => x.type === type && x.id === mid); return {present: true, width: m?.width ?? '', length: m?.length ?? ''}; })();
        el.querySelectorAll('[data-cp]').forEach(c => c.onchange = () => { cnt(c.dataset.cp).present = c.checked; render(); });
        el.querySelectorAll('[data-cw]').forEach(i => i.onchange = () => { cnt(i.dataset.cw).width = i.value; });
        el.querySelectorAll('[data-cl]').forEach(i => i.onchange = () => { cnt(i.dataset.cl).length = i.value; });
    }

    function rollDetail(x) {
        const rem = x.currentRemainingLength ?? (x.totalLength - x.usedLength);
        return `<div class="pane-h num">${esc(x.rollId)}<span class="sp"></span><a class="btn sm" href="#/inspection/${encodeURIComponent(x.rollId)}">跑布验疵</a></div><div class="pane-b">
          <div class="metric"><div><small>剩余</small><b>${fmtM(rem)}<em>m</em></b></div><div><small>幅宽</small><b>${fmtN(x.width)}<em>mm</em></b></div></div>
          <div class="kv"><div>型号</div><div>${esc(x.rollModel || '—')}</div><div>材料</div><div>${esc(x.materialName || '—')}</div><div>成分</div><div>${esc(x.composition || '—')}</div><div>颜色</div><div>${esc(x.color || '—')}</div>
            <div>批次</div><div>${esc(x.batchNo || '—')}</div><div>供应商</div><div>${esc(x.supplier || '—')}</div><div>库位</div><div>${esc(x.storageLocation || '—')}</div><div>验布</div><div>${esc(x.inspector || '—')} · ${esc(x.inspectionDate || '')}</div>
            <div>料头</div><div class="num">${x.remnantCount ?? 0} 块 · ${fmtN(x.remnantTotalArea, 2)} m²</div></div>
          <div class="sec">疵点 ${(x.defects || []).length || x.defectsCount || 0} 处${(x.voidedDefects || []).length ? ` · 已作废 ${x.voidedDefects.length}` : ''}</div>
          ${(x.defects || []).length ? `<table class="t" style="border:0"><thead><tr><th>Y m</th><th class="r">X</th><th class="r">宽×长</th><th>类型</th></tr></thead><tbody>${x.defects.map(d => `<tr><td class="num">${(d.y / 1000).toFixed(2)}</td><td class="r num">${fmtN(d.x)}</td><td class="r num">${fmtN(d.w)}×${fmtN(d.h)}</td><td>${esc(d.typeName || d.defectType)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">无疵点记录</div>'}
        </div>`;
    }
    function remDetail(x) {
        return `<div class="pane-h num">${esc(x.id)}<span class="sp"></span>${x.status === 'AVAILABLE' || x.status === 'QUARANTINED' ? '<button class="btn sm" id="scrap-open">报废</button>' : ''}</div><div class="pane-b">
          <div class="metric"><div><small>面积</small><b>${fmtN(x.area, 2)}<em>m²</em></b></div><div><small>尺寸</small><b style="font-size:14px">${fmtN(x.width)}×${fmtN(x.length)}</b></div></div>
          <div class="kv"><div>来源母卷</div><div class="num">${esc(x.sourceRollId || '—')}</div><div>批次</div><div>${esc(x.materialBatch || '—')}</div><div>库位</div><div>${esc(x.location || '—')}</div>
            <div>等级</div><div>${esc(x.qualityGrade || '—')}</div><div>代数</div><div class="num">${x.generation ?? '—'}</div><div>来源报工</div><div class="num">${esc(x.sourceReportId || '—')}</div><div>说明</div><div>${esc(x.defectDesc || '—')}</div>
            ${x.consumedByOrder ? `<div>消耗于</div><div class="num">${esc(x.consumedByOrder)}</div>` : ''}</div></div>`;
    }
    render();
}
