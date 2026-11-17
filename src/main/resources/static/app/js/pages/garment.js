import {esc, fmtN} from '../util.js';
import {MARKER_STYLES} from '../../../js/nesting/marker-demo.js';
import {OptimizationSession} from '../../../js/business/optimization/job-client.js';
import {GARMENT_EXAMPLES, candidateWidths, compactionSavingMm, effectiveUtilization, fabricConsumption, markerRequest, selectMarkerTrial, solveMarkerDirection} from '../model/garment.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {showcaseScene} from '../model/showcase.js';

export function mount(el) {
    el.innerHTML = `<div class="ph"><h1>唛架幅宽试算</h1><span class="crumb">服装工艺测算 · 多门幅单耗与齐套排料对比</span></div>
      <div class="split garment-split"><section class="pane"><div class="pane-b">
      <details id="garment-help"><summary class="pane-h" role="button" aria-label="试算条件帮助">试算条件<span class="help-mark" aria-hidden="true">?</span></summary>
        <div class="garment-help-text">
          <p id="angle-help">面料允许倒顺排时，可勾选旋转，比较同幅宽下两种方向的利用率。</p>
          <p id="fill-help">同款裁片补空在齐套唛架内加排备片，每个已选尺码最多备两件成衣所需的裁片。含补片利用率计入实补面积，每件单耗仍按原配码计算。</p>
          <p><a href="./examples/garment-shirt-gap-fill.png" target="_blank" rel="noopener">查看 1950 mm 上衣补片前后对照图</a></p>
          <p id="width-help">M、L 码每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000 mm，用逗号或空格分隔。</p>
          <p id="weight-help">每件用布重量按含布边的幅宽、实际唛架长度和克重估算，未计布头、布尾及备损。</p>
        </div>
      </details>
      <div class="style-pills" id="garment-style-pills" aria-label="快捷样板选择">
        ${MARKER_STYLES.map(s => `<button type="button" class="style-pill" data-style-pill="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
      </div>
      <form id="garment-form" class="form">
      <label for="garment-half-turn">允许 180° 旋转</label><input id="garment-half-turn" name="halfTurn" type="checkbox" aria-describedby="angle-help">
      <label for="garment-gap-fill">同款裁片补空</label><input id="garment-gap-fill" name="gapFill" type="checkbox" aria-describedby="fill-help" checked>
      <label for="garment-example">试算示例</label><select class="field" id="garment-example" name="example"><option value="" disabled>自定义参数</option>${GARMENT_EXAMPLES.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <label for="garment-style">内置样板</label><select class="field" id="garment-style" name="style">${MARKER_STYLES.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <label for="garment-m">M 码（件/版）</label><input class="field" id="garment-m" name="M" type="number" min="0" max="12" required>
      <label for="garment-l">L 码（件/版）</label><input class="field" id="garment-l" name="L" type="number" min="0" max="12" required>
      <label for="garment-widths">有效幅宽（mm）</label><input class="field" id="garment-widths" name="widths" aria-describedby="width-help" required>
      <label for="garment-edge">两侧布边合计（mm）</label><input class="field" id="garment-edge" name="edge" type="number" min="0" step="0.1" required>
      <label for="garment-gsm">克重（g/m²）</label><input class="field" id="garment-gsm" name="gsm" type="number" min="0.1" step="0.1" aria-describedby="weight-help" required></form></div></section>
      <section class="pane">
      <div class="garment-kpis" id="garment-kpis"></div>
      <div class="pane-h">候选幅宽比较<span class="sub">按实算齐套结果对比单耗与利用率</span></div><div class="garment-results"><table class="t">
      <thead><tr>${['有效幅宽 mm','试算状态','唛架长 mm','齐套利用率 %','mm/件','g/件'].map(v => `<th>${v}</th>`).join('')}<th id="garment-fill-column">含补片利用率 %</th><th>排料图</th></tr></thead><tbody></tbody></table></div>
      <div class="pane-h"><span id="garment-view">排料图</span><span class="sp"></span>
        <button type="button" class="btn sm" id="garment-export" disabled>导出唛架 JSON</button>
        <button type="button" class="btn sm pri" id="garment-to-task" disabled title="将当前选中的门幅与样板裁片带入新建二维生产任务">转入生产任务 ↗</button>
      </div><div id="garment-canvas" class="demo-canvas" aria-label="当前候选唛架"></div></section></div>
      <div class="foot"><span role="status">待试算</span><span class="sp"></span><button type="button" class="btn" id="garment-stop" hidden>停止</button>
      <button class="btn pri" type="submit" form="garment-form">试算幅宽</button></div>`;
    const $ = selector => el.querySelector(selector);
    const help = $('#garment-help');
    help.onkeydown = event => {
        if (event.key === 'Escape' && help.open) help.open = false;
    };
    const form = $('form'), status = $('[role=status]'), run = $('[type=submit]'), stop = $('#garment-stop');
    const expBtn = $('#garment-export'), toTaskBtn = $('#garment-to-task'), kpiBox = $('#garment-kpis');
    const session = new OptimizationSession();
    let rows = [], revision = 0, canvas, selected = null, manualView = false;
    function syncActions() {
        const hasLayout = Boolean(selected?.result?.layout);
        expBtn.disabled = !hasLayout;
        toTaskBtn.disabled = !hasLayout;
    }
    function select(row) {
        selected = row;
        canvas ??= createRollCanvas($('#garment-canvas'));
        canvas.setScene(showcaseScene(row.layoutRequest, row.result, 0, {
            occupiedLengthMm:row.use?.length, gapFillPlacements:row.result?.marker?.gapFillPlacements
        }), {refit:true});
        $('#garment-view').textContent = `排料图 · ${fmtN(row.width, 1)} mm · ${row.usedFixed ? '沿用固定方向' : row.direction} · ${row.state}`;
        syncActions();
    }
    function renderKpis(lowestRow, highestRow) {
        const m = Number(form.elements.M?.value) || 0, l = Number(form.elements.L?.value) || 0;
        const done = rows.filter(r => r.use);
        kpiBox.innerHTML = `<div class="metric garment-metric">
          <div><small>最低单件克重</small><b>${lowestRow ? fmtN(lowestRow.use.gramsPerGarment, 2) : '—'}<em>g/件</em></b></div>
          <div><small>推荐最优门幅</small><b>${lowestRow ? fmtN(lowestRow.width, 1) : '—'}<em>mm</em></b></div>
          <div><small>最高利用率</small><b>${highestRow ? fmtN(effectiveUtilization(highestRow.use), 2) : '—'}<em>%</em></b></div>
          <div><small>本版配码 / 已齐套</small><b>${m + l}<em>件 · ${done.length}/${rows.length || 0}</em></b></div>
        </div>`;
    }
    function render() {
        const validRows = rows.filter(r => r.use);
        const lowest = Math.min(...validRows.map(r => r.use.gramsPerGarment));
        const highest = Math.max(...validRows.map(r => effectiveUtilization(r.use)));
        const lowestRow = validRows.find(r => r.use.gramsPerGarment === lowest) || null;
        const highestRow = validRows.find(r => effectiveUtilization(r.use) === highest) || null;
        const comparison = form.elements.halfTurn.checked;
        const filling = form.elements.gapFill.checked;
        $('#garment-fill-column').hidden = !filling;
        renderKpis(lowestRow, highestRow);
        syncActions();
        function trialDetail(row) {
            const info = comparison ? [row.direction] : [];
            if (row.retryNote) info.push(row.retryNote);
            if (row.halfTurn && row.result?.layout) {
                if (row.usedFixed) info.push('沿用固定方向');
                const turned = row.result.layout.placements.filter(p => p.rotationDegrees === 180).length;
                const turnedSpares = row.result.marker?.gapFillPlacements?.filter(p => p.rotationDegrees === 180).length ?? 0;
                info.push(`掉头 ${turned + turnedSpares} 片${turnedSpares ? `（含备片 ${turnedSpares} 片）` : ''}`);
                if (row.usedFixed) {
                    const raw = row.trial.use;
                    info.push(raw ? `掉头原试排 ${fmtN(raw.length, 2)} mm / 齐套 ${fmtN(raw.utilization, 2)}%${raw.fillCount != null ? ` / 含补片 ${fmtN(raw.utilizationWithFill, 2)}%` : ''}` : '掉头试排未齐套');
                    if (row.trial.job.state === 'TIMED_OUT') info.push('掉头试排限时结束');
                }
                const base = rows.find(r => r.width === row.width && !r.halfTurn);
                if (row.use && base?.use) {
                    const withFill = filling && row.use.fillCount != null && base.use.fillCount != null;
                    const key = withFill ? 'utilizationWithFill' : 'utilization';
                    const delta = row.use[key] - base.use[key];
                    info.push(`${withFill ? '含补片' : '齐套'}较固定 ${delta > 0 ? '+' : ''}${fmtN(delta, 2)} 个百分点`);
                }
            }
            const saved = row.use && compactionSavingMm(row.result.marker.trials);
            if (saved > 0) info.push(`${row.usedFixed ? '固定方案' : ''}压紧节省 ${saved < 0.01 ? '不足 0.01' : fmtN(saved, 2)} mm`);
            return info.length ? `<br><small>${esc(info.join(' · '))}</small>` : '';
        }
        $('tbody').innerHTML = rows.map((r, i) => `<tr><td class="num">${fmtN(r.width, 1)}</td>
          <td class="wrap">${esc(r.state)}${r.use && effectiveUtilization(r.use) === highest ? (r.use.fillCount != null ? ' · 最高含补片利用率' : ' · 最高齐套利用率') : ''}${r.use?.gramsPerGarment === lowest ? ' · 当前最低单耗' : ''}${trialDetail(r)}</td>
          ${['length','utilization','lengthPerGarment','gramsPerGarment'].map(k => `<td class="num">${r.use ? fmtN(r.use[k], 2) : '—'}</td>`).join('')}
          ${filling ? `<td class="num">${r.use?.fillCount != null ? `${fmtN(r.use.utilizationWithFill, 2)}<br><small>实补 ${r.use.fillCount} 片</small>` : '—'}</td>` : ''}
          <td>${r.result?.layout ? `<button class="btn sm" type="button" data-index="${i}" aria-label="查看 ${r.width} mm ${r.direction}排料图" aria-pressed="${selected === r}">查看</button>` : '—'}</td></tr>`).join('');
    }
    $('tbody').onclick = event => {
        const button = event.target.closest('button[data-index]');
        if (button) {
            manualView = true;
            select(rows[Number(button.dataset.index)]);
            $('tbody').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
        }
    };
    function clear() {
        rows = []; selected = null; manualView = false;
        canvas?.destroy(); canvas = null;
        $('#garment-view').textContent = '排料图'; render(); status.textContent = '待试算';
    }
    function busy(value) {
        for (const field of form.elements) field.disabled = value;
        run.disabled = value; stop.hidden = !value;
    }
    function resetResults() {
        for (const field of form.querySelectorAll('input')) field.setCustomValidity('');
        clear();
    }
    const fields = form.elements;
    function syncStylePills() {
        const cur = fields.style.value;
        el.querySelectorAll('[data-style-pill]').forEach(b => b.classList.toggle('on', b.dataset.stylePill === cur));
    }
    function loadExample(example) {
        fields.example.value = example.id;
        for (const key of ['style', 'M', 'L', 'edge', 'gsm']) fields[key].value = example[key];
        fields.widths.value = example.widths.join(', ');
        syncStylePills();
        resetResults();
    }
    fields.example.onchange = () => loadExample(GARMENT_EXAMPLES.find(e => e.id === fields.example.value));
    el.querySelectorAll('[data-style-pill]').forEach(b => b.onclick = () => {
        if (run.disabled) return;
        fields.style.value = b.dataset.stylePill;
        fields.example.value = '';
        syncStylePills();
        resetResults();
    });
    loadExample(GARMENT_EXAMPLES[0]);
    form.oninput = event => {
        if (event.target !== fields.example) {
            if (event.target !== fields.halfTurn && event.target !== fields.gapFill) fields.example.value = '';
            syncStylePills();
            resetResults();
        }
    };
    stop.onclick = () => {
        revision++; session.cancel();
        for (const r of rows) if (!r.finished) r.state = '已停止';
        render(); busy(false); status.textContent = '已停止，保留已返回的幅宽结果';
    };
    expBtn.onclick = () => {
        if (!selected?.result) return;
        const blob = new Blob([JSON.stringify({request: selected.layoutRequest, result: selected.result, consumption: selected.use}, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `marker-${selected.width}mm.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    toTaskBtn.onclick = () => {
        if (!selected?.layoutRequest?.problem) return;
        const prob = selected.layoutRequest.problem;
        const styleName = MARKER_STYLES.find(s => s.id === form.elements.style.value)?.name || '服装唛架';
        const draft = {
            name: `${styleName} · ${fmtN(selected.width, 0)}mm 幅宽试算转排产`,
            problemType: 'NESTING_2D',
            materialModel: `GARMENT-${Math.round(selected.width)}`,
            externalRef: `唛架试算 ${fmtN(selected.width, 1)}mm (${selected.direction})`,
            process: {
                bedLength: Math.ceil(selected.use?.length || prob.material?.shape?.height || 5000),
                trimStart: 0,
                pieceGap: prob.process?.pieceGap ?? 0,
                cutOrigin: 'left-top',
                firstStageOrientation: 'horizontal',
                allowRotation: false,
                allowLongitudinal: true
            },
            demands: (prob.parts || []).map((p, i) => ({
                id: i + 1,
                name: p.name || p.id,
                width: p.shape?.width || 0,
                length: p.shape?.height || 0,
                quantity: p.quantity || 1,
                allowRotation: Boolean(p.allowRotation || p.allowHalfTurn),
                shape: p.shape
            }))
        };
        localStorage.setItem('cutplan.app.taskdraft.new', JSON.stringify(draft));
        location.hash = '#/task/new';
    };
    form.onsubmit = async event => {
        event.preventDefault();
        if (run.disabled) return;
        const f = form.elements, sizes = {M:f.M.valueAsNumber, L:f.L.valueAsNumber};
        const count = sizes.M + sizes.L, gsm = f.gsm.valueAsNumber, edge = f.edge.valueAsNumber;
        if (count < 1 || count > 12) { f.L.setCustomValidity('每版合计须在 1–12 件之间'); f.L.reportValidity(); return; }
        let widths;
        try { widths = candidateWidths(f.widths.value); }
        catch (e) { f.widths.setCustomValidity(e.message); f.widths.reportValidity(); return; }
        const mine = ++revision;
        clear();
        const compare = f.halfTurn.checked;
        const filling = f.gapFill.checked;
        rows = widths.flatMap(width => (compare ? [false, true] : [false]).map(halfTurn => ({
            width, halfTurn, direction:halfTurn ? '允许掉头' : '固定方向', state:'待计算',
            request:markerRequest(f.style.value, width, sizes, crypto.randomUUID(), halfTurn, filling)
        })));
        busy(true);
        try {
            for (const row of rows) {
                const baseline = row.halfTurn ? rows.find(r => r.width === row.width && !r.halfTurn) : null;
                row.state = '计算中'; render();
                status.textContent = `正在试排 ${row.width} mm · ${row.direction}`;
                async function solve(request) {
                    let lastJob;
                    const {job, result} = await session.solve(request, {onProgress:job => { lastJob = job; }}).catch(error => {
                        // A terminal timeout can have no result to fetch. Transport errors still surface as failures.
                        if (lastJob?.state === 'TIMED_OUT' && !lastJob.resultRef) return {job:lastJob, result:null};
                        throw error;
                    });
                    return {job, request, result, use:result && fabricConsumption(result, row.width, edge, gsm, count)};
                }
                try {
                    const outcome = await solveMarkerDirection(row.request, baseline?.trial, solve, () => mine === revision, () => {
                        row.state = '原起长复试中'; render();
                        status.textContent = `正在试排 ${row.width} mm · 允许掉头 · 原起长复试`;
                    });
                    if (mine !== revision) return;
                    row.trial = outcome.trial;
                    row.retryNote = outcome.retryNote;
                    const job = row.trial.job;
                    const chosen = selectMarkerTrial(job.state, row.trial, baseline?.trial, filling);
                    row.usedFixed = chosen !== row.trial;
                    row.layoutRequest = chosen.request;
                    row.result = chosen.result;
                    row.use = chosen.use;
                    row.state = row.use ? '齐套' : '未取得齐套结果';
                    if (chosen.job.state === 'TIMED_OUT') row.state += '（试排限时结束）';
                    if (job.state === 'FAILED' || job.state === 'CANCELLED') row.state = `${job.state === 'FAILED' ? '试算失败' : '已停止'} · ${row.state}`;
                    if (!manualView && row.result?.layout && (!selected || effectiveUtilization(row.use) > effectiveUtilization(selected.use))) select(row);
                } catch (e) {
                    if (mine !== revision) return;
                    row.state = '试算失败 · ' + e.message;
                }
                row.finished = true; render();
            }
            const complete = rows.filter(r => r.use);
            status.textContent = `试算结束 · ${complete.length} / ${rows.length} 个${compare ? '方案' : '幅宽'}齐套`;
        } finally { if (mine === revision) busy(false); }
    };
    return () => { revision++; session.cancel(); canvas?.destroy(); };
}
