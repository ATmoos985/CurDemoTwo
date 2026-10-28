// 跑布验疵：验布线固定，布面随位置滚动。坐标沿用母卷档案：x 自左边缘、y 自卷头（mm）；界面显示距右边缘。
// 本次标记保存在本机，点「保存到母卷」一次入档（与现有验疵页同一接口）。
import {requestJSON, esc, fmtM, fmtN, errorBox, toast} from '../util.js';
import {setStatus} from '../main.js';
import {validateDefect, advance, round} from '../../../js/inspection/inspection-model.js';
import {createRollCanvas} from '../../../js/canvas/roll-canvas.js';
import {buildInspectionScene} from '../model/roll-scene.js';

const TYPES = [['STAIN', '污渍 / 斑点'], ['HOLE', '破洞'], ['WEFT_DEFECT', '跳纱'], ['SLUB', '粗节'], ['SHADING', '色差'], ['MANUAL_MARK', '其他疵点']];
const draftKey = id => 'cutplan.app.inspection.' + id;
const savedEvent = 'cutplan:inspection-saved';
function withoutSubmitted(items, submitted) {
    const signatures = new Map(submitted.map(d => [d.captureId, JSON.stringify(d)]));
    return items.filter(d => !d.captureId || signatures.get(d.captureId) !== JSON.stringify(d));
}

export async function mount(el, [rollParam]) {
    let rolls;
    try { rolls = await requestJSON('/api/rolls'); } catch (e) { el.innerHTML = errorBox(e); return; }
    const st = {roll: null, pending: [], history: [], pos: 0, step: 1, speed: 3, running: false, tool: 'mark', sel: null, overview: false, panelCollapsed: false, margin: 20, type: 'STAIN', saving: false};
    let timer = 0, last = 0, canvas = null, disposed = false;

    async function load(id) {
        stop();
        st.roll = id ? await requestJSON('/api/rolls/' + encodeURIComponent(id)).catch(e => { toast(e.message, true); return null; }) : null;
        const draft = st.roll ? JSON.parse(localStorage.getItem(draftKey(st.roll.rollId)) || 'null') : null;
        st.pending = draft?.pending || []; st.pos = draft?.pos ?? (st.roll ? Math.min(st.roll.usedLength || 0, st.roll.totalLength) : 0); st.sel = null;
        render();
    }
    const persist = () => st.roll && localStorage.setItem(draftKey(st.roll.rollId), JSON.stringify({pending: st.pending, pos: st.pos}));
    const all = () => [...(st.roll?.defects || []).map(d => ({...d, saved: true})), ...st.pending.map(d => ({...d, saved: false}))];
    const checkpoint = () => { st.history.push(structuredClone(st.pending)); if (st.history.length > 50) st.history.shift(); };
    function undo() { if (st.saving || !st.history.length) return; st.pending = st.history.pop(); st.sel = null; persist(); render(); }
    function removeSelected() {
        const k = st.sel == null ? -1 : st.sel - (all().length - st.pending.length);
        if (st.saving || k < 0) return;
        checkpoint(); st.pending.splice(k, 1); st.sel = null; persist(); render();
    }

    function render() {
        if (disposed || !el.isConnected) return;
        const r = st.roll, list = all(), pend = st.pending.length;
        // 保留同一实例与 DOM 节点；更新表单不能在拖动中销毁舞台。
        const canvasHost = canvas ? el.querySelector('#isvg') : null;
        const focused = canvasHost && document.activeElement === canvasHost;
        canvasHost?.remove();
        el.innerHTML = `<div class="ph inspection-head"><h1>跑布验疵</h1>
            <select class="field" id="roll" style="width:300px"><option value="">选择母卷开始验布</option>${rolls.map(x => `<option value="${esc(x.rollId)}" ${r && r.rollId === x.rollId ? 'selected' : ''}>${esc(x.rollId)} · ${esc(x.rollModel || '')} · ${fmtN(x.width)} mm × ${fmtM(x.totalLength)} m</option>`).join('')}</select>
            ${r ? `<span class="tag ${r.inspectionStatus === 'PASSED' ? 'ok' : 'warn'}">${esc(r.inspectionStatus || '待检')}</span>` : ''}
            <a class="btn" href="/inspection.html" title="新建母卷等完整功能">新建母卷 ↗</a><span class="sp"></span>
            <button class="btn pri" id="save" ${pend && !st.saving ? '' : 'disabled'}>保存到母卷${pend ? ` (${pend})` : ''}</button></div>
          ${!r ? '<div class="empty">选择母卷后开始标记。整卷连续跑布，所有疵点按距卷头的累计位置记录。</div>' : `
          <div class="toolbar">
            <span class="muted">当前位置</span><input class="field num" id="pos" style="width:100px;text-align:right" value="${(st.pos / 1000).toFixed(3)}"><span>m</span><button class="btn sm" id="locate">定位 / 校准</button>
            <span class="vsep"></span><span class="muted">每次前进</span><input class="field num" id="step" style="width:60px;text-align:right" value="${st.step}"><span>m</span><button class="btn sm" id="advance">前进一段 ↓</button>
            <span class="vsep"></span><span class="muted">速度</span><input class="field num" id="speed" style="width:56px;text-align:right" value="${st.speed}"><span>m/min</span><button class="btn sm ${st.running ? 'pri' : ''}" id="run">${st.running ? '❚❚ 暂停' : '▶ 自动跑布'}</button><span class="muted" style="font-size:11.5px">空格 启停</span>
            <span class="sp"></span><span class="muted" style="font-size:12px">${st.running ? '自动跑布：位置按速度与时间计算，可随时暂停校准' : '手动模式'}</span></div>
          <div class="split" style="grid-template-columns:56px minmax(0,1fr) ${st.panelCollapsed ? '0px' : '370px'}">
            <section class="pane" style="background:#23272c;align-items:center;padding:8px 0" title="全卷：点击跳转"><div style="color:#9aa4ae;font-size:10.5px;margin-bottom:4px">全卷</div>
              <div class="vtrack" id="vtrack">${list.map(d => `<i class="${d.saved ? '' : 'new'}" style="top:${d.y / r.totalLength * 100}%"></i>`).join('')}<b style="height:${st.pos / r.totalLength * 100}%"></b><em style="top:${st.pos / r.totalLength * 100}%"></em></div>
              <div class="num" style="color:#9aa4ae;font-size:10px;margin-top:4px">${fmtM(r.totalLength)} m</div></section>
            <section class="pane" style="background:var(--canvas)">
              <div class="ctool"><div class="vseg"><button data-tool="mark" class="${st.tool === 'mark' ? 'on' : ''}">＋ 标记疵点</button><button data-tool="select" class="${st.tool === 'select' ? 'on' : ''}">选择 / 调整</button></div>
                <button data-tool="measure" class="${st.tool === 'measure' ? 'on' : ''}">测距</button><button id="follow">跟随验布线</button><button id="overview" class="${st.overview ? 'on' : ''}">全卷</button>
                <button id="undo" title="撤销本次未保存的操作（Ctrl+Z）" ${st.history.length && !st.saving ? '' : 'disabled'}>↶ 撤销</button>
                <button id="toggle-panel" aria-expanded="${!st.panelCollapsed}" title="收起或展开疵点记录">记录</button><div class="div"></div><span class="sp"></span><span id="pointer-position">距右 / 距卷头 · mm</span></div>
              <div class="canvas-wrap"><div id="isvg" style="position:absolute;inset:0;cursor:${st.tool === 'mark' ? 'crosshair' : 'default'}"></div></div>
            </section>
            <section class="pane" ${st.panelCollapsed ? 'style="display:none"' : ''}><div class="pane-h">疵点记录<span class="sp"></span><span class="sub">已入档 ${list.length - pend} · 本次待保存 ${pend}</span></div>
              <div class="pane-b">${editor(list)}
                <div class="sec">全部疵点 · 点击定位</div>
                <table class="t" style="border:0"><thead><tr><th>Y m</th><th class="r">距右</th><th class="r">宽×长</th><th>类型</th><th></th></tr></thead><tbody>
                ${list.map((d, i) => `<tr class="click ${st.sel === i ? 'sel' : ''}" data-i="${i}"><td class="num">${(d.y / 1000).toFixed(2)}</td><td class="r num">${fmtN(r.width - d.x - d.w, 1)}</td><td class="r num">${fmtN(d.w, 1)}×${fmtN(d.h, 1)}</td><td>${esc(d.typeName || d.defectType)}</td><td>${d.saved ? '<span class="tag">已入档</span>' : '<span class="tag warn">待保存</span>'}</td></tr>`).join('')}</tbody></table>
                ${(r.voidedDefects || []).length ? `<div class="sec">已作废 ${r.voidedDefects.length} 处 · 留痕</div>
                <table class="t" style="border:0"><tbody>${r.voidedDefects.slice().reverse().map(v => `<tr><td class="num muted">${(v.defect.y / 1000).toFixed(2)} m</td><td class="muted">${esc(v.defect.typeName || v.defect.defectType)}</td><td class="wrap muted" title="${esc(v.voidedAt)}">${esc(v.reason)}</td></tr>`).join('')}</tbody></table>` : ''}</div>
              <div class="foot" style="background:#fff;font-size:11.5px;color:var(--text-3)">本次记录保存在本机；入档后用于裁切避让，已有方案需重新核对</div></section></div>`}`;
        if (r) {
            const host = el.querySelector('#isvg');
            if (canvasHost) host.replaceWith(canvasHost); else mountCanvas(host);
        } else { canvas?.destroy(); canvas = null; }
        bind();
        draw();
        status();
        if (focused) canvasHost.focus({preventScroll: true});
    }

    function editor(list) {
        const d = st.sel != null ? list[st.sel] : null, editable = d && !d.saved, r = st.roll;
        const v = (k, dflt) => d ? (k === 'right' ? round(r.width - d.x - d.w) : d[k]) : dflt;
        const cutArea = d && d.saved && d.y + d.h <= (r.usedLength || 0);
        return `<div id="editor"><div class="sec">${d ? (editable ? '本次标记 · 可修改 / 删除（Delete）' : '已入档疵点') : '精确录入'}</div>
          ${d ? `<div class="kv"><div>位置</div><div class="num">Y ${(d.y / 1000).toFixed(3)} m · 距右 ${fmtN(r.width - d.x - d.w, 1)} mm</div><div>来源</div><div>${esc(d.detectionSource || '—')}${d.description ? ' · ' + esc(d.description) : ''}</div></div>` : ''}
          ${d && !editable ? (cutArea ? '<div class="notice">该疵点位于已切区域，属于历史记录，不能作废。</div>'
            : `<div style="padding:8px 12px;display:flex;gap:6px;align-items:center"><input class="field" id="void-reason" placeholder="作废原因（必填，如：复核为误检）" style="flex:1"><button class="btn sm" id="void" ${st.saving ? 'disabled' : ''}>作废</button></div>
               <div class="muted" style="padding:0 12px 8px;font-size:11.5px">作废后不再避让，原记录与原因留痕；该卷上未报工的候选方案需重新计算。</div>`) : ''}
          <div class="form" style="grid-template-columns:1fr 1fr;gap:6px 10px">
            ${[['right', '距右边缘 mm', 0], ['y', '距卷头 mm', Math.round(st.pos)], ['w', '疵点宽 mm', 50], ['h', '疵点长 mm', 50]].map(([k, t, dv]) =>
              `<label>${t}<input class="field num" data-f="${k}" value="${v(k, dv)}" style="width:100%" ${st.saving || d && !editable ? 'disabled' : ''}></label>`).join('')}
            <label>类型<select class="field" data-f="defectType" style="width:100%" ${d && !editable ? 'disabled' : ''}>${TYPES.map(([k, t]) => `<option value="${k}" ${(d ? d.defectType : st.type) === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>避让外扩 mm<input class="field num" data-f="margin" value="${v('margin', st.margin)}" style="width:100%" ${d && !editable ? 'disabled' : ''}></label></div>
          <div style="display:flex;gap:8px;padding:0 12px 10px;justify-content:flex-end">
            ${d ? `<button class="btn sm" id="new">新标记</button>` : ''}${editable ? '<button class="btn sm" id="del">删除</button><button class="btn sm pri" id="apply">更新</button>' : d ? '' : '<button class="btn sm pri" id="apply">添加到本次记录</button>'}</div></div>`;
    }

    const defectKey = d => d.saved ? `saved-${d.id}` : d.captureId;
    function draw() {
        if (!canvas || !st.roll || disposed) return;
        const d = all()[st.sel];
        canvas.setOptions({view: st.overview ? 'full' : 'inspection', tool: st.tool === 'mark' ? 'defect' : st.tool,
            editDefects: true, editable: !st.saving, minDefectSize: .1});
        canvas.setScene(buildInspectionScene(st.roll, st.pending, st.pos, d ? defectKey(d) : null), {follow: !st.overview});
    }
    function mountCanvas(host) {
        canvas = createRollCanvas(host, {
            onInteract: () => { if (st.running) { stop(); render(); } },
            onCursor: p => { const label = el.querySelector('#pointer-position'); if (label) label.textContent = p
                ? `距右 ${round(st.roll.width - p.v)} · 距卷头 ${round(p.u)} mm` : '距右 / 距卷头 · mm'; },
            onDefectSelect: key => {
                const i = all().findIndex(d => defectKey(d) === key);
                st.sel = i < 0 ? null : i; render();
            },
            onDefectDraw: box => {
                if (st.saving) return;
                try {
                    const d = validateDefect({x: box.v, y: box.u, w: box.dv, h: box.du, margin: st.margin}, st.roll);
                    checkpoint();
                    st.pending.push({...d, ...attrs(st.type), captureId: crypto.randomUUID()});
                    st.sel = all().length - 1; persist(); render();
                } catch (e) { toast(e.message, true); }
            },
            onDefectEdit: (key, box) => {
                const k = st.pending.findIndex(d => d.captureId === key);
                if (k < 0 || st.saving) return;
                try {
                    const next = validateDefect({...st.pending[k], x: box.v, y: box.u, w: box.dv, h: box.du}, st.roll);
                    if (JSON.stringify(next) !== JSON.stringify(st.pending[k])) { checkpoint(); st.pending[k] = next; }
                    persist(); render();
                } catch (e) { toast(e.message, true); draw(); }
            }
        });
    }
    const attrs = type => ({defectType: type, typeName: TYPES.find(t => t[0] === type)?.[1] || '其他疵点', detectionSource: 'MANUAL_INSPECT', avoidanceStrategy: 'MUST_AVOID', description: '跑布验疵人工标记'});

    function bind() {
        el.querySelector('#roll').onchange = e => { location.hash = '#/inspection/' + encodeURIComponent(e.target.value); };
        el.querySelector('#save')?.addEventListener('click', save);
        if (!st.roll) return;
        el.querySelector('#locate').onclick = () => { const m = Number(el.querySelector('#pos').value); if (!(m >= 0)) return toast('请输入有效米数', true); st.pos = Math.min(st.roll.totalLength, round(m * 1000)); persist(); render(); };
        el.querySelector('#step').onchange = e => { st.step = Math.max(.1, Number(e.target.value) || 1); };
        el.querySelector('#advance').onclick = () => { st.pos = Math.min(st.roll.totalLength, st.pos + st.step * 1000); persist(); render(); };
        el.querySelector('#speed').onchange = e => { st.speed = Math.max(.1, Number(e.target.value) || 3); };
        el.querySelector('#run').onclick = () => st.running ? (stop(), render()) : start();
        el.querySelector('#follow').onclick = () => { st.overview = false; render(); canvas.fit(); };
        el.querySelector('#overview').onclick = () => { stop(); st.overview = true; render(); canvas.fit(); };
        el.querySelector('#toggle-panel').onclick = () => { st.panelCollapsed = !st.panelCollapsed; render(); };
        el.querySelector('#vtrack').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); st.pos = round((e.clientY - r.top) / r.height * st.roll.totalLength); persist(); render(); };
        el.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { st.tool = b.dataset.tool; render(); });
        el.querySelector('#undo').onclick = undo;
        el.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => {
            stop(); st.sel = Number(tr.dataset.i); st.pos = Math.min(st.roll.totalLength, all()[st.sel].y + 300);
            st.overview = false; persist(); render(); canvas.fit();
        });
        el.querySelector('#new')?.addEventListener('click', () => { st.sel = null; render(); });
        el.querySelector('#void')?.addEventListener('click', async () => {
            const d = all()[st.sel], reason = el.querySelector('#void-reason').value.trim();
            if (!reason) return toast('请填写作废原因', true);
            st.saving = true; render();
            try {
                st.roll = await requestJSON(`/api/rolls/${encodeURIComponent(st.roll.rollId)}/defects/${encodeURIComponent(d.id)}/void`, {reason});
                st.sel = null; toast('疵点已作废并留痕；该卷候选方案需重新计算');
            } catch (e) { toast('作废失败：' + e.message, true); }
            st.saving = false; render();
        });
        el.querySelector('#del')?.addEventListener('click', removeSelected);
        el.querySelector('#apply')?.addEventListener('click', () => {
            if (st.saving) return;
            const f = k => el.querySelector(`[data-f="${k}"]`).value, num = k => Number(f(k));
            try {
                const w = num('w'), d = validateDefect({x: round(st.roll.width - num('right') - w), y: num('y'), w, h: num('h'), margin: num('margin')}, st.roll);
                const item = {...d, ...attrs(f('defectType'))};
                checkpoint();
                if (st.sel != null) { const k = st.sel - (all().length - st.pending.length); st.pending[k] = {...st.pending[k], ...item}; }
                else { st.pending.push({...item, captureId: crypto.randomUUID()}); st.sel = all().length - 1; }
                st.margin = d.margin; st.type = item.defectType; persist(); render();
            } catch (e) { toast(e.message, true); }
        });
    }
    function start() {
        if (disposed || st.running) return;
        st.overview = false;
        st.running = true; last = performance.now();
        timer = setInterval(() => {
            const now = performance.now();
            try { st.pos = advance(st.pos, st.speed, (now - last) / 1000, st.roll.totalLength); } catch (e) { toast(e.message, true); stop(); }
            last = now; draw(); status(); const i = el.querySelector('#pos'); if (i && document.activeElement !== i) i.value = (st.pos / 1000).toFixed(3);
            const progress = el.querySelector('#vtrack b'), pointer = el.querySelector('#vtrack em');
            if (progress) progress.style.height = st.pos / st.roll.totalLength * 100 + '%';
            if (pointer) pointer.style.top = st.pos / st.roll.totalLength * 100 + '%';
            if (st.pos >= st.roll.totalLength) { stop(); render(); toast('已到卷尾（仅表示位置到达末端）'); }
        }, 100);
        render(); canvas?.fit();
    }
    function stop() { if (st.running) persist(); st.running = false; clearInterval(timer); }
    async function save() {
        if (!st.roll || !st.pending.length || st.saving) return;
        stop();
        const rollId = st.roll.rollId, submitted = structuredClone(st.pending);
        st.saving = true; render();
        try {
            const saved = await requestJSON('/api/rolls/' + encodeURIComponent(rollId) + '/inspection-defects', {width: st.roll.width, totalLength: st.roll.totalLength, defects: submitted});
            // 确认属于提交快照；迟到响应不能清空后来新增或修改的本机记录、位置。
            const latest = JSON.parse(localStorage.getItem(draftKey(rollId)) || 'null');
            if (latest) localStorage.setItem(draftKey(rollId), JSON.stringify({...latest, pending: withoutSubmitted(latest.pending, submitted)}));
            window.dispatchEvent(new CustomEvent(savedEvent, {detail: {saved, submitted}}));
            if (!disposed) toast('本次疵点已保存到母卷');
        } catch (e) { if (!disposed) toast('保存失败，记录仍保留在本机：' + e.message, true); }
        st.saving = false; render();
    }
    function status() { setStatus(`<span>${st.roll ? `母卷 ${esc(st.roll.rollId)} · 位置 <span class="num">${(st.pos / 1000).toFixed(3)} m</span>` : '未选择母卷'}</span><span class="sp"></span><span>CutPlan v2 · 第一版</span>`); }

    const onVisibility = () => {
        if (document.hidden) stop();
        canvas?.setVisible(!document.hidden);
        if (!document.hidden) render();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onSaved = ({detail: {saved, submitted}}) => {
        if (disposed || st.roll?.rollId !== saved.rollId) return;
        const captures = new Set(submitted.map(d => d.captureId));
        const known = new Set([...(st.roll.defects || []).map(d => d.id), ...(st.roll.voidedDefects || []).map(d => d.defect.id)]);
        st.roll = {...st.roll, defects: [...(st.roll.defects || []), ...saved.defects.filter(d => captures.has(d.captureId) && !known.has(d.id))]};
        st.pending = withoutSubmitted(st.pending, submitted);
        st.history = st.history.map(items => withoutSubmitted(items, submitted));
        while (st.history.length && JSON.stringify(st.history.at(-1)) === JSON.stringify(st.pending)) st.history.pop();
        st.sel = null; persist(); render();
    };
    window.addEventListener(savedEvent, onSaved);
    const typing = t => t && (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || t.isContentEditable);
    const onKey = e => {
        if (!st.roll || st.saving || typing(e.target)) return;
        if (e.code === 'Space') { e.preventDefault(); st.running ? (stop(), render()) : start(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel != null) {
            const k = st.sel - (all().length - st.pending.length);
            if (k >= 0) { e.preventDefault(); removeSelected(); }
        } else if (e.key === 'Escape' && st.sel != null) { st.sel = null; render(); }
    };
    document.addEventListener('keydown', onKey);
    await load(rollParam || null);
    return () => {
        if (disposed) return;
        stop(); disposed = true; canvas?.destroy(); canvas = null;
        document.removeEventListener('visibilitychange', onVisibility); document.removeEventListener('keydown', onKey);
        window.removeEventListener(savedEvent, onSaved);
    };
}
