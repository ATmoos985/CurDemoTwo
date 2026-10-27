// 库存：母卷与料头档案（只读），详情含疵点；验布入口跳转跑布验疵。
import {requestJSON, esc, fmtM, fmtN, errorBox} from '../util.js';

const Q = {PASSED: ['合格', 'ok'], PENDING: ['待检', 'warn'], FAILED: ['不合格', 'err']};
const R = {AVAILABLE: ['可用', 'ok'], RESERVED: ['已预约', 'run'], CONSUMED: ['已消耗', ''], SCRAPPED: ['已报废', ''], QUARANTINED: ['隔离', 'err']};

export async function mount(el) {
    let rolls, remnants;
    try { [rolls, remnants] = await Promise.all([requestJSON('/api/rolls'), requestJSON('/api/remnants')]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    let tab = 'roll', sel = 0, q = '';
    function render() {
        const isRoll = tab === 'roll';
        const all = isRoll ? rolls : remnants;
        const list = all.filter(x => !q || JSON.stringify([x.rollId, x.id, x.rollModel, x.materialName, x.materialBatch, x.storageLocation, x.location]).toLowerCase().includes(q.toLowerCase()));
        const cur = list[Math.min(sel, list.length - 1)];
        el.innerHTML = `<div class="ph"><h1>库存</h1><span class="crumb">母卷与料头</span><span class="sp"></span>
            <a class="btn" href="/transfers.html">移库 ↗</a><a class="btn" href="/counts.html">盘点 ↗</a><a class="btn" href="/inventory.html">入库 / 档案 ↗</a></div>
          <div class="toolbar"><div class="seg"><button data-tab="roll" class="${isRoll ? 'on' : ''}">母卷 ${rolls.length}</button><button data-tab="rem" class="${isRoll ? '' : 'on'}">料头 ${remnants.length}</button></div>
            <span class="sp"></span><input class="field" id="q" placeholder="编号 / 型号 / 批次 / 库位" style="width:220px" value="${esc(q)}"></div>
          <div class="split" style="grid-template-columns:1fr 340px">
            <section class="pane" style="background:var(--bg)"><div class="body">${list.length ? `<table class="t"><thead><tr>${isRoll
                ? '<th>卷号</th><th>型号 / 材料</th><th class="r">幅宽</th><th class="r">剩余 / 总长</th><th>余量</th><th class="r">疵点</th><th>库位</th><th>验布</th>'
                : '<th>编号</th><th>来源</th><th class="r">宽 × 长</th><th class="r">面积</th><th>库位</th><th>疵点</th><th>状态</th>'}</tr></thead><tbody>
              ${list.map((x, i) => isRoll ? (() => { const rem = x.currentRemainingLength ?? (x.totalLength - x.usedLength), [qt, qc] = Q[x.inspectionStatus] || [x.inspectionStatus || '—', ''];
                    return `<tr class="click ${x === cur ? 'sel' : ''}" data-i="${i}"><td class="num">${esc(x.rollId)}</td><td>${esc(x.rollModel || '')} <span class="muted">${esc(x.materialName || '')}</span></td><td class="r num">${fmtN(x.width)}</td>
                      <td class="r num">${fmtM(rem)} / ${fmtM(x.totalLength)} m</td><td><span class="bar"><i style="width:${x.totalLength ? rem / x.totalLength * 100 : 0}%"></i></span></td><td class="r num">${x.defectsCount ?? (x.defects || []).length}</td><td>${esc(x.storageLocation || '—')}</td><td><span class="tag ${qc}">${esc(qt)}</span></td></tr>`; })()
                  : (() => { const [st, sc] = R[x.status] || [x.status, ''];
                    return `<tr class="click ${x === cur ? 'sel' : ''}" data-i="${i}"><td class="num">${esc(x.id)}</td><td class="num">${esc(x.sourceRollId || '—')}</td><td class="r num">${fmtN(x.width)} × ${fmtN(x.length)}</td><td class="r num">${fmtN(x.area, 2)} m²</td><td>${esc(x.location || '—')}</td><td>${x.hasDefect ? '<span class="tag warn">带疵</span>' : '无'}</td><td><span class="tag ${sc}">${esc(st)}</span></td></tr>`; })()).join('')}
              </tbody></table>` : '<div class="empty">没有匹配的记录</div>'}</div></section>
            <section class="pane">${cur ? (isRoll ? rollDetail(cur) : remDetail(cur)) : ''}</section></div>`;
        el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; sel = 0; render(); });
        el.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => { sel = Number(tr.dataset.i); render(); });
        const qi = el.querySelector('#q'); qi.oninput = () => { q = qi.value; sel = 0; const p = qi.selectionStart; render(); const n = el.querySelector('#q'); n.focus(); n.setSelectionRange(p, p); };
    }
    function rollDetail(x) {
        const rem = x.currentRemainingLength ?? (x.totalLength - x.usedLength);
        return `<div class="pane-h num">${esc(x.rollId)}<span class="sp"></span><a class="btn sm" href="#/inspection/${encodeURIComponent(x.rollId)}">跑布验疵</a></div><div class="pane-b">
          <div class="metric"><div><small>剩余</small><b>${fmtM(rem)}<em>m</em></b></div><div><small>幅宽</small><b>${fmtN(x.width)}<em>mm</em></b></div></div>
          <div class="kv"><div>型号</div><div>${esc(x.rollModel || '—')}</div><div>材料</div><div>${esc(x.materialName || '—')}</div><div>成分</div><div>${esc(x.composition || '—')}</div><div>颜色</div><div>${esc(x.color || '—')}</div>
            <div>批次</div><div>${esc(x.batchNo || '—')}</div><div>供应商</div><div>${esc(x.supplier || '—')}</div><div>库位</div><div>${esc(x.storageLocation || '—')}</div><div>验布</div><div>${esc(x.inspector || '—')} · ${esc(x.inspectionDate || '')}</div>
            <div>料头</div><div class="num">${x.remnantCount ?? 0} 块 · ${fmtN(x.remnantTotalArea, 2)} m²</div></div>
          <div class="sec">疵点 ${(x.defects || []).length || x.defectsCount || 0} 处</div>
          ${(x.defects || []).length ? `<table class="t" style="border:0"><thead><tr><th>Y m</th><th class="r">X</th><th class="r">宽×长</th><th>类型</th></tr></thead><tbody>${x.defects.map(d => `<tr><td class="num">${(d.y / 1000).toFixed(2)}</td><td class="r num">${fmtN(d.x)}</td><td class="r num">${fmtN(d.w)}×${fmtN(d.h)}</td><td>${esc(d.typeName || d.defectType)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">无疵点记录</div>'}
        </div>`;
    }
    function remDetail(x) {
        return `<div class="pane-h num">${esc(x.id)}</div><div class="pane-b">
          <div class="metric"><div><small>面积</small><b>${fmtN(x.area, 2)}<em>m²</em></b></div><div><small>尺寸</small><b style="font-size:14px">${fmtN(x.width)}×${fmtN(x.length)}</b></div></div>
          <div class="kv"><div>来源母卷</div><div class="num">${esc(x.sourceRollId || '—')}</div><div>批次</div><div>${esc(x.materialBatch || '—')}</div><div>库位</div><div>${esc(x.location || '—')}</div>
            <div>等级</div><div>${esc(x.qualityGrade || '—')}</div><div>代数</div><div class="num">${x.generation ?? '—'}</div><div>来源报工</div><div class="num">${esc(x.sourceReportId || '—')}</div><div>说明</div><div>${esc(x.defectDesc || '—')}</div></div></div>`;
    }
    render();
}
