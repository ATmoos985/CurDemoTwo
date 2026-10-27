// 跑布验疵：验布线固定，布面随位置滚动。坐标沿用母卷档案：x 自左边缘、y 自卷头（mm）；界面显示距右边缘。
// 本次标记保存在本机，点「保存到母卷」一次入档（与现有验疵页同一接口）。
import {requestJSON, esc, fmtM, fmtN, errorBox, toast} from '../util.js';
import {setStatus} from '../main.js';
import {validateDefect, advance, round} from '../../../js/inspection/inspection-model.js';

const TYPES = [['STAIN', '污渍 / 斑点'], ['HOLE', '破洞'], ['WEFT_DEFECT', '跳纱'], ['SLUB', '粗节'], ['SHADING', '色差'], ['MANUAL_MARK', '其他疵点']];
const draftKey = id => 'cutplan.app.inspection.' + id;

export async function mount(el, [rollParam]) {
    let rolls;
    try { rolls = await requestJSON('/api/rolls'); } catch (e) { el.innerHTML = errorBox(e); return; }
    const st = {roll: null, pending: [], pos: 0, step: 1, speed: 3, running: false, tool: 'mark', sel: null, drag: null, move: null, margin: 20, type: 'STAIN', saving: false};
    let timer = 0, last = 0;

    async function load(id) {
        stop();
        st.roll = id ? await requestJSON('/api/rolls/' + encodeURIComponent(id)).catch(e => { toast(e.message, true); return null; }) : null;
        const draft = st.roll ? JSON.parse(localStorage.getItem(draftKey(st.roll.rollId)) || 'null') : null;
        st.pending = draft?.pending || []; st.pos = draft?.pos ?? (st.roll ? Math.min(st.roll.usedLength || 0, st.roll.totalLength) : 0); st.sel = null;
        render();
    }
    const persist = () => st.roll && localStorage.setItem(draftKey(st.roll.rollId), JSON.stringify({pending: st.pending, pos: st.pos}));
    const all = () => [...(st.roll?.defects || []).map(d => ({...d, saved: true})), ...st.pending.map(d => ({...d, saved: false}))];

    function render() {
        const r = st.roll, list = all(), pend = st.pending.length;
        el.innerHTML = `<div class="ph"><h1>跑布验疵</h1>
            <select class="field" id="roll" style="width:300px"><option value="">选择母卷开始验布</option>${rolls.map(x => `<option value="${esc(x.rollId)}" ${r && r.rollId === x.rollId ? 'selected' : ''}>${esc(x.rollId)} · ${esc(x.rollModel || '')} · ${fmtN(x.width)} mm × ${fmtM(x.totalLength)} m</option>`).join('')}</select>
            ${r ? `<span class="tag ${r.inspectionStatus === 'PASSED' ? 'ok' : 'warn'}">${esc(r.inspectionStatus || '待检')}</span>` : ''}
            <a class="btn" href="/inspection.html" title="新建母卷等完整功能">新建母卷 ↗</a><span class="sp"></span>
            <button class="btn pri" id="save" ${pend && !st.saving ? '' : 'disabled'}>保存到母卷${pend ? ` (${pend})` : ''}</button></div>
          ${!r ? '<div class="empty">选择母卷后开始标记。整卷连续跑布，所有疵点按距卷头的累计位置记录。</div>' : `
          <div class="toolbar">
            <span class="muted">当前位置</span><input class="field num" id="pos" style="width:100px;text-align:right" value="${(st.pos / 1000).toFixed(3)}"><span>m</span><button class="btn sm" id="locate">定位 / 校准</button>
            <span class="vsep"></span><span class="muted">每次前进</span><input class="field num" id="step" style="width:60px;text-align:right" value="${st.step}"><span>m</span><button class="btn sm" id="advance">前进一段 ↓</button>
            <span class="vsep"></span><span class="muted">速度</span><input class="field num" id="speed" style="width:56px;text-align:right" value="${st.speed}"><span>m/min</span><button class="btn sm ${st.running ? 'pri' : ''}" id="run">${st.running ? '❚❚ 暂停' : '▶ 自动跑布'}</button>
            <span class="sp"></span><span class="muted" style="font-size:12px">${st.running ? '自动跑布：位置按速度与时间计算，可随时暂停校准' : '手动模式'}</span></div>
          <div class="split" style="grid-template-columns:56px 1fr 370px">
            <section class="pane" style="background:#23272c;align-items:center;padding:8px 0" title="全卷：点击跳转"><div style="color:#9aa4ae;font-size:10.5px;margin-bottom:4px">全卷</div>
              <div class="vtrack" id="vtrack">${list.map(d => `<i class="${d.saved ? '' : 'new'}" style="top:${d.y / r.totalLength * 100}%"></i>`).join('')}<b style="height:${st.pos / r.totalLength * 100}%"></b><em style="top:${st.pos / r.totalLength * 100}%"></em></div>
              <div class="num" style="color:#9aa4ae;font-size:10px;margin-top:4px">${fmtM(r.totalLength)} m</div></section>
            <section class="pane" style="background:var(--canvas)">
              <div class="ctool"><div class="vseg"><button data-tool="mark" class="${st.tool === 'mark' ? 'on' : ''}">＋ 标记疵点</button><button data-tool="select" class="${st.tool === 'select' ? 'on' : ''}">选择 / 调整</button></div>
                <button id="undo" ${pend ? '' : 'disabled'}>↶ 撤销</button><div class="div"></div><span class="sp"></span><span>坐标：距右边缘 / 距卷头 · mm</span></div>
              <div class="canvas-wrap"><div id="isvg" style="position:absolute;inset:0;cursor:${st.tool === 'mark' ? 'crosshair' : 'default'}"></div></div>
            </section>
            <section class="pane"><div class="pane-h">疵点记录<span class="sp"></span><span class="sub">已入档 ${list.length - pend} · 本次待保存 ${pend}</span></div>
              <div class="pane-b">${editor(list)}
                <div class="sec">全部疵点 · 点击定位</div>
                <table class="t" style="border:0"><thead><tr><th>Y m</th><th class="r">距右</th><th class="r">宽×长</th><th>类型</th><th></th></tr></thead><tbody>
                ${list.map((d, i) => `<tr class="click ${st.sel === i ? 'sel' : ''}" data-i="${i}"><td class="num">${(d.y / 1000).toFixed(2)}</td><td class="r num">${fmtN(r.width - d.x - d.w, 1)}</td><td class="r num">${fmtN(d.w, 1)}×${fmtN(d.h, 1)}</td><td>${esc(d.typeName || d.defectType)}</td><td>${d.saved ? '<span class="tag">已入档</span>' : '<span class="tag warn">待保存</span>'}</td></tr>`).join('')}</tbody></table></div>
              <div class="foot" style="background:#fff;font-size:11.5px;color:var(--text-3)">本次记录保存在本机；入档后用于裁切避让，已有方案需重新核对</div></section></div>`}`;
        bind();
        draw();
        status();
    }

    function editor(list) {
        const d = st.sel != null ? list[st.sel] : null, editable = d && !d.saved, r = st.roll;
        const v = (k, dflt) => d ? (k === 'right' ? round(r.width - d.x - d.w) : d[k]) : dflt;
        return `<div class="sec">${d ? (editable ? '修改本次标记' : '已入档（只读）') : '精确录入'}</div>
          <div class="form" style="grid-template-columns:1fr 1fr;gap:6px 10px">
            ${[['right', '距右边缘 mm', 0], ['y', '距卷头 mm', Math.round(st.pos)], ['w', '疵点宽 mm', 50], ['h', '疵点长 mm', 50]].map(([k, t, dv]) =>
              `<label>${t}<input class="field num" data-f="${k}" value="${v(k, dv)}" style="width:100%" ${d && !editable ? 'disabled' : ''}></label>`).join('')}
            <label>类型<select class="field" data-f="defectType" style="width:100%" ${d && !editable ? 'disabled' : ''}>${TYPES.map(([k, t]) => `<option value="${k}" ${(d ? d.defectType : st.type) === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            <label>避让外扩 mm<input class="field num" data-f="margin" value="${v('margin', st.margin)}" style="width:100%" ${d && !editable ? 'disabled' : ''}></label></div>
          <div style="display:flex;gap:8px;padding:0 12px 10px;justify-content:flex-end">
            ${d ? `<button class="btn sm" id="new">新标记</button>` : ''}${editable ? '<button class="btn sm" id="del">删除</button><button class="btn sm pri" id="apply">更新</button>' : d ? '' : '<button class="btn sm pri" id="apply">添加到本次记录</button>'}</div>`;
    }

    function view() {
        const host = el.querySelector('#isvg'); if (!host || !st.roll) return null;
        const r = host.getBoundingClientRect(), W = st.roll.width, pad = {l: 54, r: 70, t: 26};
        const s = Math.max(.02, (r.width - pad.l - pad.r) / W), lineY = r.height * .62;
        return {host, r, s, pad, lineY, W, y0: st.pos - (lineY - pad.t) / s};
    }
    function draw() {
        const v = view(); if (!v) return;
        const {r, s, pad, lineY, W, y0} = v, sx = x => pad.l + x * s, sy = y => pad.t + (y - y0) * s, y1 = y0 + (r.height - pad.t) / s, list = all();
        let g = `<defs><pattern id="ig" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#343a41"/></pattern></defs><rect width="${r.width}" height="${r.height}" fill="url(#ig)"/>`;
        const top = Math.max(pad.t, sy(0)), bottom = Math.min(r.height, sy(st.roll.totalLength));
        g += `<rect x="${sx(0)}" y="${top}" width="${W * s}" height="${Math.max(0, bottom - top)}" fill="#3a4148" stroke="#6b747e"/>`;
        g += `<rect x="${sx(0)}" y="${top}" width="${W * s}" height="${Math.max(0, lineY - top)}" fill="#fff" fill-opacity=".04"/>`;
        list.forEach((d, i) => {
            if (d.y + d.h < y0 || d.y > y1) return;
            const L = sx(d.x), T = sy(d.y), m = (d.margin || 0) * s, on = st.sel === i;
            g += `<rect x="${L - m}" y="${T - m}" width="${d.w * s + 2 * m}" height="${d.h * s + 2 * m}" fill="none" stroke="#ff6b5b" stroke-opacity=".45" stroke-dasharray="3 3"/>`;
            g += `<rect x="${L}" y="${T}" width="${Math.max(3, d.w * s)}" height="${Math.max(3, d.h * s)}" fill="${d.saved ? '#ff6b5b' : '#ff9f43'}" fill-opacity=".35" stroke="${on ? '#fff' : d.saved ? '#ff6b5b' : '#ff9f43'}" stroke-width="${on ? 2 : 1.2}"/>`;
            g += `<text x="${L + d.w * s + 5}" y="${T + 10}" fill="#ffc2b8" font-size="10.5">${esc(d.typeName || d.defectType)} ${fmtN(d.w, 1)}×${fmtN(d.h, 1)}</text>`;
        });
        if (st.drag) { const [a, b] = [st.drag.a, st.drag.b]; g += `<rect x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(a[0] - b[0])}" height="${Math.abs(a[1] - b[1])}" fill="#ff9f43" fill-opacity=".25" stroke="#ff9f43" stroke-dasharray="4 2"/>`; }
        g += `<line x1="${sx(0) - 8}" x2="${sx(W) + 8}" y1="${lineY}" y2="${lineY}" stroke="#4cc38a" stroke-width="2"/>`;
        const tick = W > 3000 ? 500 : 200;
        for (let x = 0; x <= W; x += tick) { const X = sx(W - x); g += `<line x1="${X}" x2="${X}" y1="${lineY - (x % 1000 ? 4 : 8)}" y2="${lineY}" stroke="#4cc38a"/>${x % (tick * 2) ? '' : `<text x="${X}" y="${lineY - 11}" fill="#8fe0b5" font-size="9.5" text-anchor="middle" font-family="var(--mono)">${x}</text>`}`; }
        g += `<rect x="${sx(W) + 6}" y="${lineY - 9}" width="62" height="18" fill="#1d2125"/><text x="${sx(W) + 10}" y="${lineY + 4}" fill="#8fe0b5" font-size="11.5" font-family="var(--mono)">${(st.pos / 1000).toFixed(2)} m</text>`;
        g += `<rect x="0" y="0" width="${pad.l - 8}" height="${r.height}" fill="#23272c"/>`;
        const step = [100, 200, 500, 1000, 2000, 5000].find(n => n * s >= 50) || 10000;
        for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) { const Y = sy(y); if (Y < pad.t) continue; g += `<line x1="${pad.l - 16}" x2="${pad.l - 8}" y1="${Y}" y2="${Y}" stroke="#6b747e"/><text x="${pad.l - 18}" y="${Y + 3}" fill="#9aa4ae" font-size="9.5" text-anchor="end" font-family="var(--mono)">${(y / 1000).toFixed(step < 1000 ? 1 : 0)}</text>`; }
        g += `<rect x="${pad.l - 8}" y="0" width="${r.width}" height="${pad.t - 4}" fill="#23272c"/><text x="${sx(W)}" y="${pad.t - 9}" fill="#7d8791" font-size="9.5" text-anchor="end">右边缘 →</text><text x="${sx(0)}" y="${pad.t - 9}" fill="#7d8791" font-size="9.5">${fmtN(W)} mm</text>`;
        v.host.innerHTML = `<svg width="${r.width}" height="${r.height}">${g}</svg>`;
    }
    const model = (v, p) => [round(Math.max(0, Math.min(v.W, (p[0] - v.pad.l) / v.s))), round(Math.max(0, v.y0 + (p[1] - v.pad.t) / v.s))];
    function bindCanvas() {
        const host = el.querySelector('#isvg'); if (!host) return;
        const loc = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        host.onmousedown = e => {
            const p = loc(e), v = view();
            if (st.tool === 'mark') { stop(); st.drag = {a: p, b: p}; draw(); return; }
            const [x, y] = model(v, p), list = all();
            const i = list.findIndex(d => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h);
            st.sel = i < 0 ? null : i;
            if (i >= 0 && !list[i].saved) st.move = {k: i - (list.length - st.pending.length), p, x0: list[i].x, y0: list[i].y};
            render();
        };
        host.onmousemove = e => {
            const p = loc(e), v = view();
            if (st.drag) { st.drag.b = p; draw(); }
            else if (st.move) { const d = st.pending[st.move.k]; d.x = round(Math.max(0, Math.min(v.W - d.w, st.move.x0 + (p[0] - st.move.p[0]) / v.s))); d.y = round(Math.max(0, st.move.y0 + (p[1] - st.move.p[1]) / v.s)); draw(); }
        };
        host.onmouseup = () => {
            const v = view();
            if (st.drag) {
                const [x1, y1] = model(v, st.drag.a), [x2, y2] = model(v, st.drag.b); st.drag = null;
                try {
                    const d = validateDefect({x: Math.min(x1, x2), y: Math.min(y1, y2), w: round(Math.abs(x1 - x2)), h: round(Math.abs(y1 - y2)), margin: st.margin}, st.roll);
                    st.pending.push({...d, ...attrs(st.type), captureId: crypto.randomUUID()}); st.sel = all().length - 1; persist();
                } catch (e) { if (Math.abs(x1 - x2) > 2) toast(e.message, true); }
                render();
            }
            if (st.move) { st.move = null; persist(); render(); }
        };
    }
    const attrs = type => ({defectType: type, typeName: TYPES.find(t => t[0] === type)?.[1] || '其他疵点', detectionSource: 'MANUAL_INSPECT', avoidanceStrategy: 'MUST_AVOID', description: '跑布验疵人工标记'});

    function bind() {
        el.querySelector('#roll').onchange = e => { location.hash = '#/inspection/' + encodeURIComponent(e.target.value); };
        el.querySelector('#save')?.addEventListener('click', save);
        if (!st.roll) return;
        bindCanvas();
        el.querySelector('#locate').onclick = () => { const m = Number(el.querySelector('#pos').value); if (!(m >= 0)) return toast('请输入有效米数', true); st.pos = Math.min(st.roll.totalLength, round(m * 1000)); persist(); render(); };
        el.querySelector('#step').onchange = e => { st.step = Math.max(.1, Number(e.target.value) || 1); };
        el.querySelector('#advance').onclick = () => { st.pos = Math.min(st.roll.totalLength, st.pos + st.step * 1000); persist(); render(); };
        el.querySelector('#speed').onchange = e => { st.speed = Math.max(.1, Number(e.target.value) || 3); };
        el.querySelector('#run').onclick = () => st.running ? (stop(), render()) : start();
        el.querySelector('#vtrack').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); st.pos = round((e.clientY - r.top) / r.height * st.roll.totalLength); persist(); render(); };
        el.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { st.tool = b.dataset.tool; render(); });
        el.querySelector('#undo').onclick = () => { st.pending.pop(); st.sel = null; persist(); render(); };
        el.querySelectorAll('tr[data-i]').forEach(tr => tr.onclick = () => { st.sel = Number(tr.dataset.i); st.pos = all()[st.sel].y + 300; render(); });
        el.querySelector('#new')?.addEventListener('click', () => { st.sel = null; render(); });
        el.querySelector('#del')?.addEventListener('click', () => { st.pending.splice(st.sel - (all().length - st.pending.length), 1); st.sel = null; persist(); render(); });
        el.querySelector('#apply')?.addEventListener('click', () => {
            const f = k => el.querySelector(`[data-f="${k}"]`).value, num = k => Number(f(k));
            try {
                const w = num('w'), d = validateDefect({x: round(st.roll.width - num('right') - w), y: num('y'), w, h: num('h'), margin: num('margin')}, st.roll);
                const item = {...d, ...attrs(f('defectType'))};
                if (st.sel != null) { const k = st.sel - (all().length - st.pending.length); st.pending[k] = {...st.pending[k], ...item}; }
                else { st.pending.push({...item, captureId: crypto.randomUUID()}); st.sel = all().length - 1; }
                st.margin = d.margin; st.type = item.defectType; persist(); render();
            } catch (e) { toast(e.message, true); }
        });
    }
    function start() {
        st.running = true; last = performance.now();
        timer = setInterval(() => {
            const now = performance.now();
            try { st.pos = advance(st.pos, st.speed, (now - last) / 1000, st.roll.totalLength); } catch (e) { toast(e.message, true); stop(); }
            last = now; draw(); const i = el.querySelector('#pos'); if (i && document.activeElement !== i) i.value = (st.pos / 1000).toFixed(3);
            if (st.pos >= st.roll.totalLength) { stop(); render(); toast('已到卷尾（仅表示位置到达末端）'); }
        }, 100);
        render();
    }
    function stop() { if (st.running) persist(); st.running = false; clearInterval(timer); }
    async function save() {
        if (!st.roll || !st.pending.length) return;
        st.saving = true; render();
        try {
            st.roll = await requestJSON('/api/rolls/' + encodeURIComponent(st.roll.rollId) + '/inspection-defects', {width: st.roll.width, totalLength: st.roll.totalLength, defects: st.pending});
            st.pending = []; st.sel = null; persist(); toast('本次疵点已保存到母卷');
        } catch (e) { toast('保存失败，记录仍保留在本机：' + e.message, true); }
        st.saving = false; render();
    }
    function status() { setStatus(`<span>${st.roll ? `母卷 ${esc(st.roll.rollId)} · 位置 <span class="num">${(st.pos / 1000).toFixed(3)} m</span>` : '未选择母卷'}</span><span class="sp"></span><span>CutPlan v2 · 第一版</span>`); }

    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    await load(rollParam || null);
    return () => { stop(); window.removeEventListener('resize', onResize); };
}
