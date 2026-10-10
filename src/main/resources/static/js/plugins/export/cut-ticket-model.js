const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
export const ticketNumber = plan => `WO-${plan.id || plan.result.planId}-V${plan.version || 1}`;
export const planStatusLabel = status => ({PENDING:'待报工',CANCELLED:'已取消',CONFIRMED:'已报工',REVERSED:'已撤回'}[status] || '状态未知');
export function ticketModel(plan, historical = false) {
    const {request, result, receipt} = plan;
    if (!request || !result?.pieces?.length || !result.planId || !(request.rollW > 0 && request.rollL > 0)) throw new Error('方案记录不完整，无法生成工单');
    if (receipt && receipt.planId !== result.planId) throw new Error('报工与方案编号不一致');
    const recorded=['CONFIRMED','REVERSED'].includes(plan.status);
    const outcomes = new Map((receipt?.pieceResults || []).map(p => [p.pieceId,p]));
    const pieces = result.pieces.map(p => ({...p, outcome:receipt || recorded ? outcomes.get(p.id)?.outcome || 'UNRECORDED' : 'PLANNED', reason:outcomes.get(p.id)?.reason || ''}));
    const remnants = receipt ? (receipt.derivedRemnants || []).map(r => ({...r, w:r.width, l:r.length, ...(receipt.recoveredGeometry || []).find(g => g.id === r.id)})) : request.feedPortType === 'remnant' ? [] : (result.remnants || []);
    return {number:ticketNumber(plan),planId:result.planId,taskId:request.taskId,taskRevision:request.taskRevision,version:plan.version || 1,parentPlanId:plan.parentPlanId,
        recorded,status:planStatusLabel(plan.status),notice:plan.status==='REVERSED'?'已撤回记录，仅供追溯，不计入当前产出和库存。':plan.status==='CONFIRMED'?'已报工记录，仅供追溯，请勿重复裁切。' : historical || plan.status!=='PENDING'?'历史方案，仅供核对；执行前须恢复并重新校验。':'待报工方案，现场核对并裁切后再报工；预览不代表合格产出或已入库。',
        createdAt:plan.createdAt || '未记录',request,receipt,pieces,remnants,cuts:result.cuts || []};
}
const fmt = n => Number(n).toLocaleString('zh-CN',{maximumFractionDigits:3});
const outcomes = {PLANNED:'计划裁片 · 待现场核对',QUALIFIED:'合格',REJECTED:'异常',UNCUT:'未切',UNRECORDED:'历史记录未逐件登记'};
export function ticketBlueprint(model) {
    const {request:r,pieces,remnants,cuts}=model, scale=Math.min(270/r.rollW,330/r.rollL), w=r.rollW*scale,h=r.rollL*scale;
    const rect=(p,fill,stroke)=>`<rect x="${p.x*scale}" y="${p.y*scale}" width="${p.w*scale}" height="${p.l*scale}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
    const cutLines=cuts.map(c=>c.type==='横切'?`<line x1="${c.start*scale}" y1="${c.pos*scale}" x2="${c.end*scale}" y2="${c.pos*scale}"/>`:`<line x1="${c.pos*scale}" y1="${c.start*scale}" x2="${c.pos*scale}" y2="${c.end*scale}"/>`).join('');
    return `<svg viewBox="0 0 340 390" role="img" aria-label="方案加工区和裁片位置，使用方案局部坐标"><text x="170" y="18" text-anchor="middle" font-size="12">${fmt(r.rollW)} × ${fmt(r.rollL)} mm</text><g transform="translate(${(340-w)/2},32)"><rect width="${w}" height="${h}" fill="#fff" stroke="#64748b"/>${remnants.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>rect(p,'#ecfdf5','#059669')).join('')}${pieces.map(p=>rect(p,p.outcome==='UNCUT'?'#f1f5f9':p.outcome==='REJECTED'?'#fef3c7':'#e0f2fe','#28718c')+`<text x="${(p.x+p.w/2)*scale}" y="${(p.y+p.l/2)*scale}" text-anchor="middle" font-size="10">#${escape(p.id)}</text>`).join('')}<g stroke="#c55757" stroke-dasharray="3 2" fill="none">${cutLines}</g></g><text x="170" y="383" text-anchor="middle" font-size="10">左上角为局部坐标 (0,0)，图形等比例</text></svg>`;
}
export function ticketHTML(m) {
    const r=m.request,receipt=m.receipt;
    const table=(headers,rows)=>`<table><thead><tr class="ticket-table-id"><th colspan="${headers.length}">${escape(m.number)} · ${escape(m.status)}</th></tr><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${headers.length}">无</td></tr>`}</tbody></table>`;
    return `<header><h1>裁切工单 · ${escape(m.status)}</h1><strong id="ticket-no-val">${escape(m.number)}</strong><p>${escape(m.notice)}</p></header>
    <dl class="ticket-meta"><div><dt>任务 / 需求版本</dt><dd>${escape(m.taskId || '独立方案')} / ${escape(m.taskRevision ?? '—')}</dd></div><div><dt>方案 / 版本</dt><dd>${escape(m.planId)} / ${m.version}</dd></div><div><dt>调整来源</dt><dd>${escape(m.parentPlanId || '原始方案')}</dd></div><div><dt>生成时间</dt><dd>${escape(m.createdAt)}</dd></div><div><dt>材料来源 / 型号</dt><dd>${escape(r.sourceRemnantId || r.rollId)} / ${escape(r.rollModel)}</dd></div><div><dt>${r.feedPortType==='remnant'?'料头尺寸':'幅宽 × 拉布长度'} / 全卷区间</dt><dd>${fmt(r.rollW)} × ${fmt(r.rollL)} mm / ${r.feedPortType==='remnant'?'料头局部区域':fmt(r.windowStartY || 0)+'–'+fmt((r.windowStartY || 0)+r.rollL)+' mm'}</dd></div><div><dt>起刀 / 工艺</dt><dd>${escape({'left-top':'左上角','left-bottom':'左下角','right-top':'右上角','right-bottom':'右下角'}[r.cutOrigin] || r.cutOrigin)} / ${r.allowLongitudinal?'允许纵切':'仅横切'}</dd></div><div><dt>报工时间 / 实际用料</dt><dd>${receipt?escape(receipt.confirmedAt)+' / '+(r.feedPortType==='remnant'?'整块料头核销':fmt(receipt.actualCutLen)+' mm'):m.recorded?'未取得报工明细':'尚未报工'}</dd></div></dl>
    <section class="ticket-diagram"><div id="ticket-blueprint-container">${ticketBlueprint(m)}</div><div><h2>方案与实切说明</h2><p>计划 ${m.pieces.length} 件 · 方案刀序 ${m.cuts.length} 刀</p><p>${receipt?`合格 ${receipt.finishedPieceCount} 件 · 异常 ${receipt.rejectedPieceCount || 0} 件 · 未切 ${receipt.uncutPieceCount || 0} 件`:'裁片和回收区域均为计划值。'}</p><p>蓝色：计划或已切裁片；灰色：未切；黄色：异常；绿色：${receipt?'实收':'候选'}料头。</p><p>图中虚线是保存方案的刀序，不是实际机台刀路记录。</p>${receipt?.reversalReason?`<p>撤回原因：${escape(receipt.reversalReason)}</p>`:''}</div></section>
    <h2>裁片清单 · ${receipt?'报工结果':'计划值'}</h2>${table(['裁片 / 需求编号','名称','宽 × 长 (mm)','结果','原因 / 核对'],m.pieces.map(p=>`<tr><td>#${escape(p.id)} / ${escape(p.demandId)}</td><td>${escape(p.name)}</td><td>${fmt(p.w)} × ${fmt(p.l)}</td><td>${escape(outcomes[p.outcome] || p.outcome)}</td><td>${escape(p.reason || (receipt?'—':'□ 现场核对'))}</td></tr>`))}
    <h2>${receipt?'实际回收料头':r.feedPortType==='remnant'?'料头只使用一次，余料不再回收':'候选回收区域 · 报工后才生成入库凭证'}</h2>${table(['编号','宽 × 长 (mm)','面积 (m²)','库位 / 说明'],m.remnants.map(p=>`<tr><td>${escape(p.id)}</td><td>${fmt(p.w)} × ${fmt(p.l)}</td><td>${fmt(p.w*p.l/1e6)}</td><td>${escape(receipt?p.location || '未记录':'待现场测量并确认回收')}</td></tr>`))}
    <footer><span class="ticket-sign-id">${escape(m.number)} · ${escape(m.status)}</span>操作人：________________　复核人：________________　日期：________________</footer>`;
}
