import {MARKER_STYLES, markerExample, markerSummary, searchMarker} from './marker-demo.js';
import {createNestingScene} from './nesting-scene.js';
import {NestingSession} from './nesting-client.js';
import {mountNestingViewer} from './nesting-viewer.js';

const $ = id => document.getElementById(id);
const session = new NestingSession();
for (const style of MARKER_STYLES) $('marker-style').add(new Option(style.name, style.id));
const initialStyle = new URLSearchParams(location.search).get('style');
if (MARKER_STYLES.some(style => style.id === initialStyle)) $('marker-style').value = initialStyle;
let problem = markerExample(), best = null, controller = null, revision = 0;
const viewer = mountNestingViewer($('marker-canvas'), {onSelect:piece => {
    $('marker-selection').textContent = piece ? `${piece.name} · X ${piece.x} / Y ${piece.y} mm · 固定纱向`
        : '点击衣片查看尺码与名称；滚轮缩放、拖动平移。';
}});
function checklist(summary = markerSummary(problem, null)) {
    $('marker-checklist').replaceChildren(...summary.rows.map(row => {
        const el = document.createElement('div'); el.className = `marker-check${row.placed === row.requested ? ' complete' : ''}`;
        el.append(row.name); const count = document.createElement('span'); count.textContent = `${row.placed} / ${row.requested}`; el.append(count); return el;
    }));
}
function cancel() { controller?.abort(); controller = null; session.invalidate(); revision++; }
function busy(value) { $('marker-run').disabled = value; $('marker-cancel').hidden = !value; }
function reset() {
    cancel(); busy(false); best = null; $('marker-result-export').disabled = true;
    for (const id of ['marker-length','marker-utilization','marker-saving']) $(id).textContent = '—';
    $('marker-trials').replaceChildren(); $('marker-error').hidden = true;
    checklist();
    if (!$('marker-width').checkValidity()) { viewer.setScene(null); $('marker-state').textContent = '请输入 1200–2000 mm 的布宽（步长 10 mm）'; return; }
    problem = markerExample($('marker-width').valueAsNumber, $('marker-style').value);
    const style = MARKER_STYLES.find(item => item.id === $('marker-style').value);
    $('marker-style-title').textContent = `${style.name} · M / L 两种尺码`;
    $('marker-style-description').textContent = `每码 1 件：${style.description}，共 ${markerSummary(problem,null).requested} 片。`;
    viewer.setScene(createNestingScene(problem), {fitView:true}); checklist();
    $('marker-state').textContent = '待排料 · 衣片齐全才算完成';
}
$('marker-width').addEventListener('input', reset);
$('marker-style').addEventListener('change', () => {
    const params = new URLSearchParams(location.search); params.set('style',$('marker-style').value);
    history.replaceState(null,'',`${location.pathname}?${params}${location.hash}`); reset();
});
$('marker-cancel').onclick = () => { cancel(); busy(false); $('marker-state').textContent = '已停止，可重新开始排料'; };
$('marker-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!$('marker-form').reportValidity()) return;
    reset(); const token = ++revision; controller = new AbortController(); const signal = controller.signal; busy(true);
    try {
        const output = await searchMarker(problem, async candidate => {
            session.setProblem(candidate); const scene = await session.solve();
            signal.throwIfAborted(); if (!scene) throw new Error('本次排料已取消');
            return {scene, result:session.result};
        }, {signal, onTrial:trial => { $('marker-state').textContent = `尝试 ${trial.index} / ${trial.total} · 门幅 ${problem.material.shape.width} mm · 长度 ${trial.length} mm`; }});
        if (token !== revision) return;
        best = output.best;
        const displayed = best || output.latest;
        if (displayed) { viewer.setScene(displayed.scene, {fitView:true}); checklist(displayed.summary); }
        $('marker-trials').replaceChildren(...output.history.map(trial => {
            const li = document.createElement('li'); li.textContent = `${trial.length} mm：${trial.complete ? '衣片齐套' : `未齐套，排入 ${trial.placed} 片（不采用）`}`; return li;
        }));
        if (best) {
            $('marker-state').textContent = `${best.summary.requested} / ${best.summary.requested} 片齐套 · 本次找到的较短方案`;
            $('marker-length').textContent = `${best.summary.length.toFixed(0)} mm`;
            $('marker-utilization').textContent = `${(best.summary.utilization * 100).toFixed(1)}%`;
            $('marker-saving').textContent = `${Math.max(0, output.first.summary.length - best.summary.length).toFixed(0)} mm`;
            $('marker-result-export').disabled = false;
        } else $('marker-state').textContent = '本次搜索未排齐全部衣片，请重试；不代表该布宽无解。';
    } catch (error) {
        if (token === revision && error.name !== 'AbortError') { $('marker-error').hidden = false; $('marker-error').textContent = error.message; $('marker-state').textContent = '排料未完成，请检查服务后重试'; }
    } finally { if (token === revision) { busy(false); controller = null; } }
});
function download(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)], {type:'application/json'})); const link = document.createElement('a'); link.href=url; link.download=name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
$('marker-input-export').onclick = () => { if ($('marker-form').reportValidity()) download('marker-input.json', best?.problem || problem); };
$('marker-result-export').onclick = () => { if (best) download('marker-result.json', best.result); };
$('marker-fit').onclick = () => viewer.fit();
window.addEventListener('pagehide', event => { if (!event.persisted) { cancel(); viewer.destroy(); } });
reset();
