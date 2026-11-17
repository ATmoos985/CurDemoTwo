import {esc, fmtN} from '../util.js';
import {MARKER_STYLES} from '../../../js/nesting/marker-demo.js';
import {OptimizationSession} from '../../../js/business/optimization/job-client.js';
import {GARMENT_EXAMPLES, candidateWidths, compactionSavingMm, fabricConsumption, markerRequest, selectMarkerTrial, solveMarkerDirection} from '../model/garment.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {showcaseScene} from '../model/showcase.js';

export function mount(el) {
    el.innerHTML = `<div class="ph"><h1>唛架幅宽试算</h1><span class="crumb">服装 · 单层用料</span></div>
      <div class="split garment-split"><section class="pane"><div class="pane-b">
      <details id="garment-help"><summary class="pane-h" role="button" aria-label="试算条件帮助">试算条件<span class="help-mark" aria-hidden="true">?</span></summary>
        <div class="garment-help-text">
          <p id="angle-help">面料允许倒顺排时，可勾选旋转，比较同幅宽下两种方向的利用率。</p>
          <p id="width-help">M、L 码每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000 mm，用逗号或空格分隔。</p>
          <p id="weight-help">每件用布重量按含布边的幅宽、实际唛架长度和克重估算，未计布头、布尾及备损。</p>
        </div>
      </details>
      <form id="garment-form" class="form">
      <label for="garment-half-turn">允许 180° 旋转</label><input id="garment-half-turn" name="halfTurn" type="checkbox" aria-describedby="angle-help">
      <label for="garment-example">试算示例</label><select class="field" id="garment-example" name="example"><option value="" disabled>自定义参数</option>${GARMENT_EXAMPLES.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>
      <label for="garment-style">内置样板</label><select class="field" id="garment-style" name="style">${MARKER_STYLES.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <label for="garment-m">M 码（件/版）</label><input class="field" id="garment-m" name="M" type="number" min="0" max="12" required>
      <label for="garment-l">L 码（件/版）</label><input class="field" id="garment-l" name="L" type="number" min="0" max="12" required>
      <label for="garment-widths">有效幅宽（mm）</label><input class="field" id="garment-widths" name="widths" aria-describedby="width-help" required>
      <label for="garment-edge">两侧布边合计（mm）</label><input class="field" id="garment-edge" name="edge" type="number" min="0" step="0.1" required>
      <label for="garment-gsm">克重（g/m²）</label><input class="field" id="garment-gsm" name="gsm" type="number" min="0.1" step="0.1" aria-describedby="weight-help" required></form></div></section>
      <section class="pane"><div class="pane-h">候选幅宽比较</div><div class="garment-results"><table class="t">
      <thead><tr>${['有效幅宽 mm','试算状态','唛架长 mm','利用率 %','mm/件','g/件','排料图'].map(v => `<th>${v}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
      <div class="pane-h" id="garment-view">排料图</div><div id="garment-canvas" class="demo-canvas" aria-label="当前候选唛架"></div></section></div>
      <div class="foot"><span role="status">待试算</span><span class="sp"></span><button type="button" class="btn" id="garment-stop" hidden>停止</button>
      <button class="btn pri" type="submit" form="garment-form">试算幅宽</button></div>`;
    const $ = selector => el.querySelector(selector);
    const help = $('#garment-help');
    help.onkeydown = event => {
        if (event.key === 'Escape' && help.open) help.open = false;
    };
    const form = $('form'), status = $('[role=status]'), run = $('[type=submit]'), stop = $('#garment-stop');
    const session = new OptimizationSession();
    let rows = [], revision = 0, canvas, selected = null, manualView = false;
    function select(row) {
        selected = row;
        canvas ??= createRollCanvas($('#garment-canvas'));
        canvas.setScene(showcaseScene(row.layoutRequest, row.result), {refit:true});
        $('#garment-view').textContent = `排料图 · ${fmtN(row.width, 1)} mm · ${row.direction} · ${row.state}`;
    }
    function render() {
        const lowest = Math.min(...rows.filter(r => r.use).map(r => r.use.gramsPerGarment));
        const highest = Math.max(...rows.filter(r => r.use).map(r => r.use.utilization));
        const comparison = form.elements.halfTurn.checked;
        function trialDetail(row) {
            const info = comparison ? [row.direction] : [];
            if (row.retryNote) info.push(row.retryNote);
            if (row.halfTurn && row.result?.layout) {
                if (row.usedFixed) info.push('沿用固定方向');
                const turned = row.result.layout.placements.filter(p => p.rotationDegrees === 180).length;
                info.push(`掉头 ${turned} 片`);
                if (row.usedFixed) {
                    const raw = row.trial.use;
                    info.push(raw ? `掉头原试排 ${fmtN(raw.length, 2)} mm / ${fmtN(raw.utilization, 2)}%` : '掉头试排未齐套');
                }
                const base = rows.find(r => r.width === row.width && !r.halfTurn);
                if (row.use && base?.use) {
                    const delta = row.use.utilization - base.use.utilization;
                    info.push(`较固定 ${delta > 0 ? '+' : ''}${fmtN(delta, 2)} 个百分点`);
                }
            }
            const saved = row.use && compactionSavingMm(row.result.marker.trials);
            if (saved > 0) info.push(`${row.usedFixed ? '固定方案' : ''}压紧节省 ${saved < 0.01 ? '不足 0.01' : fmtN(saved, 2)} mm`);
            return info.length ? `<br><small>${esc(info.join(' · '))}</small>` : '';
        }
        $('tbody').innerHTML = rows.map((r, i) => `<tr><td class="num">${fmtN(r.width, 1)}</td>
          <td class="wrap">${esc(r.state)}${r.use?.utilization === highest ? ' · 最高利用率' : ''}${r.use?.gramsPerGarment === lowest ? ' · 当前最低单耗' : ''}${trialDetail(r)}</td>
          ${['length','utilization','lengthPerGarment','gramsPerGarment'].map(k => `<td class="num">${r.use ? fmtN(r.use[k], 2) : '—'}</td>`).join('')}
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
    function loadExample(example) {
        fields.example.value = example.id;
        for (const key of ['style', 'M', 'L', 'edge', 'gsm']) fields[key].value = example[key];
        fields.widths.value = example.widths.join(', ');
        resetResults();
    }
    fields.example.onchange = () => loadExample(GARMENT_EXAMPLES.find(e => e.id === fields.example.value));
    loadExample(GARMENT_EXAMPLES[0]);
    form.oninput = event => {
        if (event.target !== fields.example) {
            if (event.target !== fields.halfTurn) fields.example.value = '';
            resetResults();
        }
    };
    stop.onclick = () => {
        revision++; session.cancel();
        for (const r of rows) if (!r.finished) r.state = '已停止';
        render(); busy(false); status.textContent = '已停止，保留已返回的幅宽结果';
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
        rows = widths.flatMap(width => (compare ? [false, true] : [false]).map(halfTurn => ({
            width, halfTurn, direction:halfTurn ? '允许掉头' : '固定方向', state:'待计算',
            request:markerRequest(f.style.value, width, sizes, crypto.randomUUID(), halfTurn)
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
                    const chosen = selectMarkerTrial(job.state, row.trial, baseline?.trial);
                    row.usedFixed = chosen !== row.trial;
                    row.layoutRequest = chosen.request;
                    row.result = chosen.result;
                    row.use = chosen.use;
                    row.state = row.use ? '齐套' : '未取得齐套结果';
                    if (job.state === 'TIMED_OUT') row.state += '（试排限时结束）';
                    if (job.state === 'FAILED' || job.state === 'CANCELLED') row.state = `${job.state === 'FAILED' ? '试算失败' : '已停止'} · ${row.state}`;
                    if (!manualView && row.result?.layout && (!selected || row.use && row.use.utilization > (selected.use?.utilization ?? -1))) select(row);
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
