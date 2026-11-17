import {esc, fmtN} from '../util.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {OptimizationSession} from '../../../js/business/optimization/job-client.js';
import {SHOWCASE_CASES, WORKFLOW_GUIDES, WORKFLOW_TEMPLATES, showcaseRequest, showcaseScene} from '../model/showcase.js';
import {fulfillmentReason} from '../../../js/business/cutting/demand-progress-model.js';
import {independentBaseline, planSummary} from '../../../js/linear/linear-model.js';

const METRICS = {processingAreaUtilization: ['加工区占用率', '裁片净面积 / 本次加工区面积'], markerAreaUtilization: ['预计唛架利用率', '齐套衣片面积 / 实际唛架面积，排除未用尾料'], motherAreaUtilization: ['预计产出面积占比', '含超产面积 / 母卷面积，含固定切边'], usableAreaUtilization: ['可切区占用率', '含超产面积 / 扣除切边后的可用面积']};

export async function mount(el, [id]) {
    const selected = SHOWCASE_CASES.find(c => c.id === id);
    if (!selected) {
        const groups = [...new Set(SHOWCASE_CASES.map(c => c.group))];
        el.innerHTML = `<div class="ph"><h1>能力展示</h1><span class="crumb">算法基准与业务演练沙盒 · ${SHOWCASE_CASES.length} 个计算用例 · 6 条业务演示路线</span></div>
          <div class="toolbar">
            <div class="seg" id="case-tabs" role="group" aria-label="沙盒分类">
              <button type="button" class="on" data-group-filter="all">全部 (${SHOWCASE_CASES.length})</button>
              ${groups.map(g => `<button type="button" data-group-filter="${esc(g)}">${esc(g)}</button>`).join('')}
              <button type="button" data-group-filter="__workflow__">业务流程演练 (6)</button>
            </div>
            <span class="sp"></span>
            <label>查找用例 <input class="field" id="case-search" type="search" placeholder="行业、规则或异常"></label>
            <span class="muted">计算演示不扣库存；业务流程使用实际任务。</span>
          </div>
          <div class="body"><div id="case-catalogue">${groups.map(group => `<section data-case-group="${esc(group)}"><h3>${esc(group)}</h3><div class="cards">${SHOWCASE_CASES.filter(c => c.group === group).map(c => `<a class="card demo-card" data-case="${esc(c.id)}" href="#/showcase/${encodeURIComponent(c.id)}"><small>${esc(c.kind === 'marker' ? '齐套与用布优化' : c.kind === 'slitting' ? '独立分切 / 快速 / 精细' : '二维计算')}</small><b>${esc(c.name)}</b><p>${esc(c.note)}</p><span>打开用例 →</span></a>`).join('')}</div></section>`).join('')}</div>
          <div id="workflow-sandbox">
            <section><h3>业务演示数据 <span class="tag warn">写入演练库</span></h3><p class="muted">先登记演示母卷并完成检验，再创建匹配任务。按钮只预填表单；点击保存才写入数据。</p><div class="cards">${WORKFLOW_TEMPLATES.map(t => `<article class="card demo-card"><b>${esc(t.name)}</b><p>母卷 ${t.width} mm × ${t.totalLength / 1000} m · 拉布 ${t.bedLength} mm · ${t.demands.reduce((n,d)=>n+d[3],0)} 件 / 卷</p><a class="btn sm" href="#/inventory/receive/${t.id}">① 登记演示母卷</a> <a class="btn sm" href="#/task/new/${t.id}">② 创建演示任务</a></article>`).join('')}</div></section>
            <section><h3>完整业务流程</h3><p class="muted">以下步骤使用新版实际业务页面，报工会记账。建议使用单独登记的演示材料和任务。</p><div class="cards">${WORKFLOW_GUIDES.map(([title, steps, acceptance, route]) => `<article class="card demo-card"><b>${esc(title)}</b><p>${esc(steps)}</p><p><strong>验收：</strong>${esc(acceptance)}</p><a class="btn sm" href="#/${route}">进入${esc(title)}</a></article>`).join('')}</div></section>
          </div></div>`;
        let activeGroup = 'all';
        function applyFilter() {
            const query = el.querySelector('#case-search').value.trim().toLowerCase();
            const onlyWorkflow = activeGroup === '__workflow__';
            el.querySelector('#case-catalogue').hidden = onlyWorkflow;
            el.querySelector('#workflow-sandbox').hidden = activeGroup !== 'all' && !onlyWorkflow;
            if (!onlyWorkflow) {
                el.querySelectorAll('[data-case]').forEach(a => {
                    const c = SHOWCASE_CASES.find(x => x.id === a.dataset.case);
                    const groupMatch = activeGroup === 'all' || c.group === activeGroup;
                    const textMatch = !query || (a.textContent + c.group).toLowerCase().includes(query);
                    a.hidden = !(groupMatch && textMatch);
                });
                el.querySelectorAll('[data-case-group]').forEach(s => { s.hidden = !s.querySelector('[data-case]:not([hidden])'); });
            }
        }
        el.querySelector('#case-search').oninput = applyFilter;
        el.querySelectorAll('[data-group-filter]').forEach(b => b.onclick = () => {
            activeGroup = b.dataset.groupFilter;
            el.querySelectorAll('[data-group-filter]').forEach(x => x.classList.toggle('on', x === b));
            applyFilter();
        });
        return;
    }
    let request = showcaseRequest(id), result = null, disposed = false, busy = false, token = 0, patternIndex = 0;
    const runs = new Map(), slit = selected.kind === 'slitting';
    el.innerHTML = `<div class="ph"><a class="btn" href="#/showcase">← 用例库</a><h1>${esc(selected.name)}</h1><span class="sp"></span><span class="tag">计算预览 · 不扣库存</span></div>
      <div class="toolbar"><span>${esc(selected.note)}</span></div>
      <div class="split demo-split"><section class="pane"><div class="pane-h">输入与演示步骤</div><div class="pane-b" id="demo-input"></div></section>
        <section class="pane"><div class="pane-h">${slit ? '定长横切示意' : '排料图'}<span class="sp"></span><button class="btn sm" id="demo-fit">适合窗口</button><button class="btn sm" id="demo-rotate">横 / 竖</button><button class="btn sm" id="demo-path" aria-pressed="false" ${slit || request.problem.process?.mode === 'CONTOUR' ? 'disabled title="此演示没有可执行刀序"' : ''}>刀序</button></div><div id="demo-canvas" class="demo-canvas" tabindex="0" aria-label="演示排料画布"></div><div class="foot" id="demo-selection">滚轮缩放，拖动平移；右键查看裁片尺寸。</div></section>
        <section class="pane"><div class="pane-h">计算结果</div><div class="pane-b" id="demo-result"><div class="empty">尚未计算</div></div></section></div>
      <div class="foot"><span id="demo-state" role="status">待计算</span><span class="sp"></span><button class="btn" id="demo-input-export">导出输入</button><button class="btn" id="demo-result-export" disabled>导出结果</button><button class="btn" id="demo-cancel" hidden>停止计算</button><button class="btn pri" id="demo-run">${slit ? '快速搭切' : '开始计算'}</button>${slit ? '<button class="btn" id="demo-quality">精细优化</button>' : ''}</div>`;
    const $ = selector => el.querySelector(selector);
    const session = new OptimizationSession(undefined, 150, error => { if (!disposed) $('#demo-state').textContent = '未确认停止：' + error.message; });
    let vertical = true, path = false;
    const canvas = createRollCanvas($('#demo-canvas'), {onContextMenu: hit => {
        const piece = showcaseScene(request, result, patternIndex).segments[0].pieces.find(p => p.id === hit?.entityId);
        $('#demo-selection').textContent = piece ? `${piece.label} · X ${fmtN(piece.v, 1)} / Y ${fmtN(piece.u, 1)} mm · ${fmtN(piece.dv, 1)} × ${fmtN(piece.du, 1)} mm` : '右键查看裁片尺寸。';
    }});
    const paint = () => canvas.setScene(showcaseScene(request, result, patternIndex), {refit: true});
    function input() {
        const p = request.problem, rows = slit ? p.orders.map(o => [o.id, o.widthMm, o.lengthMm, o.quantity])
            : p.parts.map(o => [o.name, o.shape.width, o.shape.height, o.quantity]);
        $('#demo-input').innerHTML = `<div class="kv"><div>材料幅宽</div><div class="num">${fmtN(slit ? p.motherWidthMm : p.material.shape.width)} mm</div>
          <div>${slit ? '切边 左 / 右' : '加工长度'}</div><div class="num">${slit ? `${p.leftTrimMm} / ${p.rightTrimMm}` : fmtN(p.material.shape.height)} mm</div></div>
          ${slit ? `<div class="demo-note">图示段长 ${fmtN(showcaseScene(request, result, patternIndex).roll.total)} mm；订单卷长见下表，图示不展开整卷。</div>` : ''}<table class="t"><thead><tr><th>需求</th><th>宽×长 mm</th><th>数量</th></tr></thead><tbody>${rows.map(r => `<tr><td class="wrap">${esc(r[0])}</td><td class="num">${fmtN(r[1])}×${fmtN(r[2])}</td><td class="num">${r[3]}</td></tr>`).join('')}</tbody></table>
          <div class="sec">操作与验收</div><ol class="demo-steps"><li>核对材料、需求和工艺；点击计算。</li><li>${slit ? '查看组合、重复车数、缺口与超产；切换组合查看条宽。' : '查看裁片、禁入区与未排原因；矩形方案可打开刀序。'}</li><li>${selected.kind === 'marker' ? '核对每种衣片是否齐套及各轮试排记录；搜索结果不保证全局最优。' : id === '6' ? '这里只计算一个工位；多工位报工接续请使用用例库中的业务演示路线。' : slit ? '运行精细优化与快速结果对比；基线逐规格开卷，不受组合下限约束。' : '预览不扣库存。未排入并不等同于证明无解。'}</li></ol>
          ${selected.kind === 'marker' || id.startsWith('GARMENT') ? '<p class="demo-note">服装曲边为折线近似，未包含对条对格、缝份及任意角度旋转。</p>' : ''}
          <details class="demo-note"><summary>查看输入 JSON</summary><pre>${esc(JSON.stringify(request, null, 2))}</pre></details>`;
    }
    function output() {
        if (!result) return;
        const layout = result.layout, s = result.slitting;
        const fulfilled = s?.fulfillment || layout?.fulfillment || [];
        const count = s ? s.patterns.reduce((n, p) => n + p.repetitions, 0) : layout.placements.length;
        $('#demo-result').innerHTML = `<div class="metric"><div><small>${slit ? '计划车数' : '已排裁片'}</small><b>${count}<em>${slit ? '车' : '件'}</em></b></div><div><small>需求完成状态</small><strong>${result.fulfillmentStatus === 'COMPLETE' ? '齐套' : '未齐套'}</strong></div></div>
          <div class="demo-note">${esc(layout?.message || '')}${result.fulfillmentStatus !== 'COMPLETE' ? ' 请核对缺口；不能作为齐套完成。' : ''}</div>
          <table class="t"><thead><tr><th>需求</th><th>已排 / 需求</th><th>缺口</th></tr></thead><tbody>${fulfilled.map(f => `<tr><td class="wrap">${esc(request.problem.parts?.find(p => p.id === f.demandId)?.name || f.orderId || f.demandId)}</td><td class="num">${f.placed ?? f.produced ?? 0} / ${f.requested}</td><td class="num">${f.missing ?? f.unplaced ?? 0}</td></tr>${f.reason && (f.unplaced || f.missing) ? `<tr><td colspan="3" class="wrap muted"><small>${esc(fulfillmentReason(f.reason))}</small></td></tr>` : ''}`).join('')}</tbody></table>
          ${s ? `<div class="sec">分切组合（单车示意）</div>${s.patterns.map((p, i) => `<button class="btn demo-pattern" data-pattern="${i}">${i + 1}. ${esc(p.stations.map(v => `${v.widthMm}×${v.countPerRepetition}`).join(' + '))} · ${p.repetitions} 车</button>`).join('')}<div id="demo-compare"></div>` : ''}
          ${result.marker ? `<div class="sec">齐套缩短记录</div><ol class="demo-steps">${result.marker.trials.map(t => `<li>${fmtN(t.lengthMm)} mm：${t.complete ? `齐套，占用 ${fmtN(t.occupiedLengthMm)} mm` : `未齐套，排入 ${t.placed} 件`}</li>`).join('')}</ol><p class="demo-note">${result.marker.occupiedLengthMm != null ? `实际唛架 ${fmtN(result.marker.occupiedLengthMm)} mm；未使用尾料不计入用布。` : '本次搜索未形成齐套唛架。'}</p>` : ''}
          <div class="sec">指标与口径</div>${result.metrics.map(m => `<div class="demo-note">${esc(METRICS[m.name]?.[0] || m.name)}：<b class="num">${fmtN(m.value, 3)} ${esc(m.unit)}</b><br><small>${esc(METRICS[m.name]?.[1] || m.basis)}</small></div>`).join('')}`;
        if (s) {
            const p = request.problem, old = {motherWidth: p.motherWidthMm, leftTrim: p.leftTrimMm, rightTrim: p.rightTrimMm, orderItems: p.orders.map(o => ({width: o.widthMm, length: o.lengthMm, quantity: o.quantity, surfaceTreatment: o.surfaceTreatment}))}, baseline = planSummary(independentBaseline(old), old);
            const rows = [['逐规格独立分切', baseline.rolls, 0, 0], ...[...runs].map(([profile, r]) => [profile === 'FAST' ? '快速搭切' : '精细优化', r.slitting.patterns.reduce((n, p) => n + p.repetitions, 0), r.slitting.fulfillment.reduce((n, f) => n + f.missing, 0), r.slitting.totalOverproduced])];
            $('#demo-compare').innerHTML = `<div class="sec">同一输入对比</div><table class="t"><thead><tr><th>方法</th><th>车数</th><th>缺口</th><th>超产</th></tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        }
        el.querySelectorAll('[data-pattern]').forEach(b => b.onclick = () => { patternIndex = Number(b.dataset.pattern); input(); paint(); });
    }
    function buttons() {
        $('#demo-run').disabled = busy; if (slit) $('#demo-quality').disabled = busy;
        $('#demo-cancel').hidden = !busy; $('#demo-result-export').disabled = !result;
    }
    async function run(profile = 'FAST') {
        if (busy) return;
        const mine = ++token; request = showcaseRequest(id, profile); result = null; patternIndex = 0; busy = true;
        input(); paint(); buttons(); $('#demo-result').innerHTML = '<div class="empty">计算中…</div>';
        $('#demo-state').textContent = '正在提交计算…';
        try {
            const response = await session.solve(request, {onProgress: j => { if (!disposed && mine === token) $('#demo-state').textContent = j.message || j.phase || j.state; }});
            if (disposed || mine !== token) return;
            result = response.result; if (slit) runs.set(profile, result);
            paint(); output();
            $('#demo-state').textContent = `${result.fulfillmentStatus === 'COMPLETE' ? '计算完成 · 齐套' : '计算结束 · 未齐套'}${response.job.state !== 'SUCCEEDED' ? ' · 搜索提前结束' : ''}`;
        } catch (e) {
            if (disposed || mine !== token) return;
            $('#demo-state').textContent = e.name === 'AbortError' ? '已停止计算' : '计算未完成，可重试';
            $('#demo-result').innerHTML = `<div class="error-box" role="alert">${esc(e.message)}</div>`;
        } finally { if (!disposed && mine === token) { busy = false; buttons(); } }
    }
    $('#demo-run').onclick = () => run(); if (slit) $('#demo-quality').onclick = () => run('QUALITY');
    $('#demo-cancel').onclick = () => { ++token; session.cancel(); busy = false; buttons(); $('#demo-state').textContent = '已请求停止计算'; $('#demo-result').innerHTML = '<div class="empty">本次计算已停止，可重新计算。</div>'; };
    $('#demo-fit').onclick = () => canvas.fit();
    $('#demo-rotate').onclick = () => canvas.setOptions({vertical: vertical = !vertical});
    $('#demo-path').onclick = e => { canvas.setOptions({showPath: path = !path}); e.currentTarget.setAttribute('aria-pressed', String(path)); };
    const download = (suffix, value) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'})), a = document.createElement('a'); a.href = url; a.download = `${id}-${suffix}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    $('#demo-input-export').onclick = () => download('input', request); $('#demo-result-export').onclick = () => { if (result) download('result', result); };
    input(); paint();
    return () => { disposed = true; ++token; session.cancel(); canvas.destroy(); };
}
