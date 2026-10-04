const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export function stockSignature(stock) {
    return JSON.stringify([stock.id, stock.sourceRollId, stock.materialBatch, stock.width, stock.length,
        stock.status || 'AVAILABLE', !!stock.hasDefect, (stock.defects || []).map(d=>[d.id,d.x,d.y,d.w,d.h,d.margin ?? 20])]);
}

export function recommendationMarkup(analysis) {
    const rows=analysis.recommendations;
    return `<p class="muted">已试排 ${analysis.evaluatedCount} / ${analysis.candidateCount} 块尺寸候选${analysis.deferredCount?`；另有 ${analysis.deferredCount} 块尚未评估`:''}。每块分别使用同一批剩余需求，结果不能相加。</p>
        ${rows.length?'':'<p>本次未得到可用推荐。可核对工艺与疵点，或选择母卷继续；未排入不表示已证明无解。</p>'}
        ${rows.map((r,i)=>`<article class="remnant-recommendation">
            <div class="recommendation-heading"><strong>${i===0?'建议先用':'备选'} · ${escape(r.stock.id)}</strong><button type="button" class="tool-btn ${i===0?'active':''}" data-recommend-stock="${escape(r.stock.id)}">选择并核对</button></div>
            <p>${r.stock.width} × ${r.stock.length} mm · ${escape(r.stock.location || '库位未登记')}${r.stock.hasDefect?' · 已按库存疵点避让':''}</p>
            <p><strong>可先切 ${r.pieceCount} 件</strong> · 裁片 ${r.pieceArea.toFixed(3)} m² · 整块料头利用率 ${r.utilization.toFixed(1)}% · ${r.cutCount} 刀</p>
            <details ${i===0?'open':''}><summary>切哪些需求 · 切完还剩多少</summary><table><thead><tr><th>需求 / 尺寸 mm</th><th>待切</th><th>本块可切</th><th>切后剩余</th></tr></thead><tbody>${r.lines.map(l=>`<tr><td>${escape(l.name)} <small>(${l.demandId})</small><br><small>${l.width} × ${l.length}</small></td><td>${l.requested}</td><td>${l.placed}</td><td>${l.remaining}</td></tr>`).join('')}</tbody></table></details>
        </article>`).join('')}
        ${analysis.unavailable.length?`<details class="detail-disclosure"><summary>${analysis.unavailable.length} 块未形成推荐 · 查看原因</summary><ul>${analysis.unavailable.map(r=>`<li>${escape(r.id)}：${escape(r.message || r.status)}</li>`).join('')}</ul></details>`:''}`;
}
