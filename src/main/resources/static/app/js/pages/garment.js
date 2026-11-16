import {esc, fmtN} from '../util.js';
import {MARKER_STYLES} from '../../../js/nesting/marker-demo.js';
import {OptimizationSession} from '../../../js/business/optimization/job-client.js';
import {candidateWidths, fabricConsumption, markerRequest} from '../model/garment.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {showcaseScene} from '../model/showcase.js';

export function mount(el) {
    el.innerHTML = `<div class="ph"><h1>唛架幅宽试算</h1><span class="crumb">服装 · 单层用料</span></div>
      <div class="split garment-split"><section class="pane"><div class="pane-h">试算条件</div>
      <div class="pane-b"><form id="garment-form" class="form">
      <label for="garment-style">内置样板</label><select class="field" id="garment-style" name="style">${MARKER_STYLES.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
      <label for="garment-m">M 码（件/版）</label><input class="field" id="garment-m" name="M" type="number" min="0" max="12" value="1" required>
      <label for="garment-l">L 码（件/版）</label><input class="field" id="garment-l" name="L" type="number" min="0" max="12" value="1" required>
      <label for="garment-widths">有效幅宽（mm）</label><input class="field" id="garment-widths" name="widths" value="1600, 1850, 1950" aria-describedby="width-help" required>
      <label for="garment-edge">两侧布边合计（mm）</label><input class="field" id="garment-edge" name="edge" type="number" min="0" step="0.1" value="0" required>
      <label for="garment-gsm">克重（g/m²）</label><input class="field" id="garment-gsm" name="gsm" type="number" min="0.1" step="0.1" value="200" required></form>
      <p class="demo-note" id="width-help">每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000 mm，用逗号或空格分隔。</p>
      <p class="demo-note">样板使用固定纱向的简化轮廓。克重单耗按含布边幅宽和实际唛架长度估算，未计布头、布尾及备损。</p></div></section>
      <section class="pane"><div class="pane-h">候选幅宽比较</div><div class="garment-results"><table class="t">
      <thead><tr>${['有效幅宽 mm','试算状态','唛架长 mm','利用率 %','mm/件','g/件','排料图'].map(v => `<th>${v}</th>`).join('')}</tr></thead><tbody></tbody></table></div>
      <div class="pane-h" id="garment-view">排料图</div><div id="garment-canvas" class="demo-canvas" aria-label="当前候选唛架"></div></section></div>
      <div class="foot"><span role="status">待试算</span><span class="sp"></span><button type="button" class="btn" id="garment-stop" hidden>停止</button>
      <button class="btn pri" type="submit" form="garment-form">试算幅宽</button></div>`;
    const $ = selector => el.querySelector(selector);
    const form = $('form'), status = $('[role=status]'), run = $('[type=submit]'), stop = $('#garment-stop');
    const session = new OptimizationSession();
    let rows = [], revision = 0, canvas, selected = null;
    function select(row) {
        selected = row;
        canvas ??= createRollCanvas($('#garment-canvas'));
        canvas.setScene(showcaseScene(row.request, row.result), {refit:true});
        $('#garment-view').textContent = `排料图 · ${fmtN(row.width, 1)} mm · ${row.state}`;
    }
    function render() {
        const lowest = Math.min(...rows.filter(r => r.use).map(r => r.use.gramsPerGarment));
        $('tbody').innerHTML = rows.map((r, i) => `<tr><td class="num">${fmtN(r.width, 1)}</td>
          <td class="wrap">${esc(r.state)}${r.use?.gramsPerGarment === lowest ? ' · 当前最低单耗' : ''}</td>
          ${['length','utilization','lengthPerGarment','gramsPerGarment'].map(k => `<td class="num">${r.use ? fmtN(r.use[k], 2) : '—'}</td>`).join('')}
          <td>${r.result?.layout ? `<button class="btn sm" type="button" data-index="${i}" aria-label="查看 ${r.width} mm 排料图" aria-pressed="${selected === r}">查看</button>` : '—'}</td></tr>`).join('');
    }
    $('tbody').onclick = event => {
        const button = event.target.closest('button[data-index]');
        if (button) {
            select(rows[Number(button.dataset.index)]);
            $('tbody').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
        }
    };
    function clear() {
        rows = []; selected = null;
        canvas?.destroy(); canvas = null;
        $('#garment-view').textContent = '排料图'; render(); status.textContent = '待试算';
    }
    function busy(value) {
        for (const field of form.elements) field.disabled = value;
        run.disabled = value; stop.hidden = !value;
    }
    form.oninput = () => {
        for (const field of form.querySelectorAll('input')) field.setCustomValidity('');
        clear();
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
        rows = widths.map(width => ({width, request:markerRequest(f.style.value, width, sizes, crypto.randomUUID()), state:'待计算'}));
        busy(true);
        try {
            for (const row of rows) {
                row.state = '计算中'; render();
                status.textContent = `正在试排 ${row.width} mm`;
                try {
                    const {job, result} = await session.solve(row.request);
                    if (mine !== revision) return;
                    row.result = result;
                    row.use = fabricConsumption(result, row.width, edge, gsm, count);
                    row.state = row.use ? '齐套' : '未取得齐套结果';
                    if (job.state !== 'SUCCEEDED') row.state += '（提前结束）';
                    if (!selected && result.layout) select(row);
                } catch (e) {
                    if (mine !== revision) return;
                    row.state = '试算失败 · ' + e.message;
                }
                row.finished = true; render();
            }
            const complete = rows.filter(r => r.use);
            status.textContent = `试算结束 · ${complete.length} / ${rows.length} 个幅宽齐套`;
        } finally { if (mine === revision) busy(false); }
    };
    return () => { revision++; session.cancel(); canvas?.destroy(); };
}
