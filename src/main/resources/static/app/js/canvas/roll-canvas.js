// 母卷画布：整卷是一个连续世界，“工位 / 全卷”只是相机预设。
// 只接收宿主给出的场景数据并回调交互，不读写业务状态、不发请求。
import {toScreen, toWorld, screenRect, fitCamera, zoomAt, panBy, ratioOf, scaleForRatio, rulerStep, DEFAULT_MM_PER_PX} from './camera.js';

const RULER = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmtM = mm => (mm / 1000).toLocaleString('zh-CN', {maximumFractionDigits: 2});
const n1 = v => Math.round(v * 10) / 10;

const DEFS = `<defs>
<pattern id="rc-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#343a41"/></pattern>
<pattern id="rc-waste" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#59616a"/></pattern>
<pattern id="rc-used" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#2b3036"/><line x1="0" y1="0" x2="0" y2="5" stroke="#454c54" stroke-width="2"/></pattern></defs>`;

export function createRollCanvas(host, callbacks = {}) {
    let scene = null, cam = null, rows = null, drag = null, measure = null, draft = null;
    let opts = {vertical: true, view: 'station', fullMode: 'strip', tool: 'pan', mmPerPx: DEFAULT_MM_PER_PX};
    host.classList.add('rc-host');

    const size = () => ({width: host.clientWidth, height: host.clientHeight});
    const mode = () => (opts.view === 'full' && opts.fullMode === 'tile') ? 'tile' : 'strip';

    function fit() {
        if (!scene) return;
        const sz = size(), W = scene.roll.width;
        if (!sz.width || !sz.height) return;
        if (mode() === 'tile') {
            let best = null;
            for (let n = 1; n <= 12; n++) {
                const rowLen = scene.roll.total / n, gap = W * .3;
                const c = fitCamera({u0: 0, u1: rowLen, v0: 0, v1: n * W + (n - 1) * gap}, sz, opts.vertical,
                    {start: 18, end: 18, near: 30, far: 12});
                if (!best || c.s > best.s) best = {...c, rows: {n, rowLen, gap}};
            }
            rows = best.rows; cam = {s: best.s, a: best.a, c: best.c};
        } else {
            rows = null;
            const pad = {start: RULER + 46, end: 40, near: RULER + 56, far: 40};
            const w = scene.window;
            const range = opts.view === 'station' && w
                ? (() => { const ctx = Math.min(w.len * .2, 2500); return {u0: w.start - ctx, u1: w.start + w.len + ctx}; })()
                : {u0: 0, u1: scene.roll.total};
            cam = fitCamera({...range, v0: 0, v1: W}, sz, opts.vertical, pad);
        }
        cam.fit = cam.s;
        draw();
    }

    // ---- 绘制 ----
    function rect(c, u, v, du, dv, attrs) {
        const r = screenRect(c, opts.vertical, u, v, du, dv);
        return `<rect x="${r.x}" y="${r.y}" width="${Math.max(0, r.w)}" height="${Math.max(0, r.h)}" ${attrs}/>`;
    }
    function text(c, u, v, str, attrs = '', dx = 0, dy = 0) {
        const [x, y] = toScreen(c, opts.vertical, u, v);
        return `<text x="${x + dx}" y="${y + dy}" ${attrs}>${esc(str)}</text>`;
    }
    function drawContent(c, uMin, uMax) {
        const {roll} = scene, W = roll.width;
        let g = rect(c, 0, 0, roll.total, W, 'fill="#353b42" stroke="#6b747e"');
        if (roll.used > 0) g += rect(c, 0, 0, Math.min(roll.used, roll.total), W, 'fill="url(#rc-used)"');
        for (const seg of scene.segments) {
            if (seg.start + seg.len < uMin || seg.start > uMax) continue;
            const cut = seg.status === 'cut', on = seg.id === scene.currentId;
            const op = cut ? .42 : (opts.view === 'station' && !on ? .5 : 1);
            g += `<g opacity="${op}">` + rect(c, seg.start, 0, seg.len, W, 'fill="url(#rc-waste)" stroke="#5d6670"');
            for (const p of seg.pieces) {
                const r = screenRect(c, opts.vertical, p.u, p.v, p.du, p.dv);
                g += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${p.color}" fill-opacity=".85" stroke="#1d2125" stroke-width="${c.s > .05 ? 1 : .4}"><title>${esc(p.title || p.label)}</title></rect>`;
                if (r.w > 56 && r.h > 16) g += `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 4}" class="rc-piece">${esc(p.label)}</text>`;
            }
            for (const k of seg.cuts || []) {
                const [x1, y1] = toScreen(c, opts.vertical, k.u1, k.v1), [x2, y2] = toScreen(c, opts.vertical, k.u2, k.v2);
                g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f0c674" stroke-width="1" stroke-dasharray="5 3"/>`;
            }
            g += '</g>';
            const [bx1, by1] = toScreen(c, opts.vertical, seg.start, -4), [bx2, by2] = toScreen(c, opts.vertical, seg.start, W + 4);
            g += `<line x1="${bx1}" y1="${by1}" x2="${bx2}" y2="${by2}" stroke="#f0c674"/>`;
            const sr = screenRect(c, opts.vertical, seg.start, 0, seg.len, W);
            if (cut && Math.min(sr.w, sr.h) > 26) g += text(c, seg.start + seg.len / 2, W / 2, '已切 ✓', 'class="rc-cut"', 0, 4);
        }
        for (const d of scene.defects) {
            if (d.u + d.du < uMin || d.u > uMax) continue;
            const col = d.fresh ? '#ff9f43' : '#ff6b5b';
            if (d.margin > 0) g += rect(c, d.u - d.margin, d.v - d.margin, d.du + 2 * d.margin, d.dv + 2 * d.margin, `fill="none" stroke="${col}" stroke-opacity=".5" stroke-dasharray="3 3"`);
            const r = screenRect(c, opts.vertical, d.u, d.v, d.du, d.dv);
            g += `<rect x="${r.x}" y="${r.y}" width="${Math.max(3, r.w)}" height="${Math.max(3, r.h)}" fill="${col}" fill-opacity=".3" stroke="${col}" stroke-width="1.5"><title>${esc(d.label)}</title></rect>`;
        }
        return g;
    }
    function drawStation(c) {
        const w = scene.window; if (!w) return '';
        const W = scene.roll.width;
        let g = rect(c, w.start, -6 / c.s, w.len, W + 12 / c.s, `fill="none" stroke="${w.adjusted ? '#f5b971' : '#7fb3e6'}" stroke-width="2" stroke-dasharray="6 3"`);
        const lenPx = w.len * c.s;
        if (lenPx > 80) {
            const off = -22 / c.s;
            const [x1, y1] = toScreen(c, opts.vertical, w.start, off), [x2, y2] = toScreen(c, opts.vertical, w.start + w.len, off);
            g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c9d0d7"/>`;
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, label = `拉布 ${n1(w.len)} mm`;
            g += `<rect x="${mx - 58}" y="${my - 9}" width="116" height="18" fill="#2a2f35"/><text x="${mx}" y="${my + 4}" class="rc-dim">${label}</text>`;
            const end = (u, anchor) => text(c, u, W, `Y ${fmtM(u)} m`, `class="rc-sub" text-anchor="${anchor}"`, opts.vertical ? 8 : 0, opts.vertical ? 4 : 16);
            g += end(w.start, opts.vertical ? 'start' : 'start') + end(w.start + w.len, opts.vertical ? 'start' : 'end');
        }
        return g;
    }
    function drawOverlays(c) {
        let g = '';
        if (draft) {
            const u = Math.min(draft.a[0], draft.b[0]), v = Math.min(draft.a[1], draft.b[1]);
            g += rect(c, u, v, Math.abs(draft.a[0] - draft.b[0]), Math.abs(draft.a[1] - draft.b[1]), 'fill="#ff9f43" fill-opacity=".25" stroke="#ff9f43" stroke-dasharray="4 2"');
        }
        if (measure) {
            const [x1, y1] = toScreen(c, opts.vertical, ...measure.a), [x2, y2] = toScreen(c, opts.vertical, ...measure.b);
            const du = Math.abs(measure.a[0] - measure.b[0]), dv = Math.abs(measure.a[1] - measure.b[1]);
            const label = `${n1(Math.hypot(du, dv))} mm · 长 ${n1(du)} / 宽 ${n1(dv)}`;
            g += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f5d76e" stroke-width="1.5"/><circle cx="${x1}" cy="${y1}" r="3" fill="#f5d76e"/><circle cx="${x2}" cy="${y2}" r="3" fill="#f5d76e"/>`;
            g += `<rect x="${(x1 + x2) / 2 + 8}" y="${(y1 + y2) / 2 - 20}" width="${label.length * 7 + 8}" height="18" fill="#1d2125"/><text x="${(x1 + x2) / 2 + 12}" y="${(y1 + y2) / 2 - 7}" class="rc-measure">${esc(label)}</text>`;
        }
        return g;
    }
    function drawRulers(c, sz) {
        const V = opts.vertical, W = scene.roll.width;
        let g = V ? `<rect x="0" y="0" width="${RULER}" height="${sz.height}" class="rc-ruler"/><rect x="0" y="0" width="${sz.width}" height="${RULER}" class="rc-ruler"/>`
                  : `<rect x="0" y="0" width="${sz.width}" height="${RULER}" class="rc-ruler"/><rect x="0" y="0" width="${RULER}" height="${sz.height}" class="rc-ruler"/>`;
        const alongLen = V ? sz.height : sz.width, su = rulerStep(c.s, 70);
        for (let u = Math.floor(-c.a / c.s / su) * su; c.a + u * c.s <= alongLen; u += su) {
            const p = c.a + u * c.s; if (p < RULER) continue;
            g += V ? `<line x1="${RULER - 7}" x2="${RULER}" y1="${p}" y2="${p}" class="rc-tick"/><text x="${RULER - 3}" y="${p - 3}" class="rc-rl" text-anchor="end">${fmtM(u)}</text>`
                   : `<line x1="${p}" x2="${p}" y1="${RULER - 7}" y2="${RULER}" class="rc-tick"/><text x="${p + 3}" y="${RULER - 9}" class="rc-rl">${fmtM(u)}</text>`;
        }
        const sv = rulerStep(c.s, 44);
        for (let v = 0; v <= W + 1e-6; v += sv) {
            const p = c.c + v * c.s; if (p < RULER || p > (V ? sz.width : sz.height)) continue;
            g += V ? `<line x1="${p}" x2="${p}" y1="${RULER - 7}" y2="${RULER}" class="rc-tick"/><text x="${p + 2}" y="${RULER - 9}" class="rc-rl">${Math.round(v)}</text>`
                   : `<line x1="${RULER - 7}" x2="${RULER}" y1="${p}" y2="${p}" class="rc-tick"/><text x="${RULER - 3}" y="${p + 3}" class="rc-rl" text-anchor="end">${Math.round(v)}</text>`;
        }
        g += `<rect x="0" y="0" width="${RULER}" height="${RULER}" fill="#1d2125"/><text x="4" y="14" class="rc-rl">m</text>`;
        return g;
    }
    function draw() {
        if (!scene || !cam) { host.innerHTML = ''; return; }
        const sz = size();
        let g = DEFS + `<rect width="${sz.width}" height="${sz.height}" fill="url(#rc-grid)"/>`;
        if (mode() === 'tile') {
            const {n, rowLen, gap} = rows, W = scene.roll.width;
            for (let r = 0; r < n; r++) {
                const c = {s: cam.s, a: cam.a - r * rowLen * cam.s, c: cam.c + r * (W + gap) * cam.s}, u0 = r * rowLen;
                const clip = screenRect(c, opts.vertical, u0, -4 / cam.s, rowLen, W + 8 / cam.s);
                g += `<clipPath id="rc-row${r}"><rect x="${clip.x}" y="${clip.y}" width="${clip.w}" height="${clip.h}"/></clipPath>`;
                g += `<g clip-path="url(#rc-row${r})">${drawContent(c, u0, u0 + rowLen)}</g>`;
                g += text(c, u0, 0, `${fmtM(u0)} m`, 'class="rc-sub"', opts.vertical ? 0 : -6, opts.vertical ? -8 : 12) ;
            }
        } else {
            const sz2 = size(), span = (opts.vertical ? sz2.height : sz2.width) / cam.s;
            const uMin = -cam.a / cam.s - 100, uMax = uMin + span + 200;
            g += drawContent(cam, uMin, uMax) + drawStation(cam) + drawOverlays(cam) + drawRulers(cam, sz);
        }
        host.innerHTML = `<svg xmlns="${SVG_NS}" width="${sz.width}" height="${sz.height}" viewBox="0 0 ${sz.width} ${sz.height}">${g}</svg>`;
        callbacks.onCamera?.({ratio: ratioOf(cam.s, opts.mmPerPx), percent: cam.fit ? cam.s / cam.fit * 100 : 100});
    }

    // ---- 交互 ----
    const local = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const world = p => toWorld(cam, opts.vertical, ...p);
    const clampV = ([u, v]) => [u, Math.max(0, Math.min(scene.roll.width, v))];
    const toolActive = () => mode() === 'strip' && opts.tool !== 'pan';
    function cursorAt(p) {
        if (!cam || !scene) return null;
        if (mode() === 'tile') {
            const {rowLen, gap, n} = rows, W = scene.roll.width;
            const [a, c] = opts.vertical ? [p[1], p[0]] : p;
            const r = Math.floor((c - cam.c) / ((W + gap) * cam.s));
            if (r < 0 || r >= n) return null;
            const u = r * rowLen + (a - cam.a) / cam.s, v = (c - cam.c) / cam.s - r * (W + gap);
            return u >= 0 && u <= scene.roll.total && v >= 0 && v <= W ? {u, v} : null;
        }
        const [u, v] = world(p);
        return u >= 0 && u <= scene.roll.total && v >= 0 && v <= scene.roll.width ? {u, v} : null;
    }
    function onDown(e) {
        if (!cam || e.button !== 0) return;
        const p = local(e);
        if (toolActive()) {
            const w = clampV(world(p));
            if (opts.tool === 'measure') measure = {a: w, b: w, live: true}; else draft = {a: w, b: w};
            draw(); return;
        }
        drag = p; host.style.cursor = 'grabbing';
    }
    function onMove(e) {
        if (!cam) return;
        const p = local(e);
        callbacks.onCursor?.(cursorAt(p));
        if (measure?.live) { measure.b = clampV(world(p)); draw(); return; }
        if (draft) { draft.b = clampV(world(p)); draw(); return; }
        if (drag) { cam = panBy(cam, opts.vertical, p[0] - drag[0], p[1] - drag[1]); drag = p; draw(); }
    }
    function onUp() {
        if (measure?.live) measure.live = false;
        if (draft) {
            const u = Math.min(draft.a[0], draft.b[0]), v = Math.min(draft.a[1], draft.b[1]);
            const du = Math.abs(draft.a[0] - draft.b[0]), dv = Math.abs(draft.a[1] - draft.b[1]);
            draft = null; draw();
            if (du >= 5 && dv >= 5) callbacks.onDefectDraw?.({u: n1(u), v: n1(v), du: n1(du), dv: n1(dv)});
        }
        if (drag) { drag = null; host.style.cursor = toolActive() ? 'crosshair' : 'grab'; }
    }
    function onWheel(e) {
        if (!cam) return;
        e.preventDefault();
        const p = local(e);
        cam = {...zoomAt(cam, opts.vertical, p[0], p[1], e.deltaY < 0 ? 1.15 : 1 / 1.15, cam.fit * .2, 8), fit: cam.fit};
        draw();
    }
    host.addEventListener('mousedown', onDown);
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', () => callbacks.onCursor?.(null));
    window.addEventListener('mouseup', onUp);
    host.addEventListener('wheel', onWheel, {passive: false});
    const ro = new ResizeObserver(() => cam ? draw() : fit());
    ro.observe(host);

    return {
        setScene(next, {refit = false} = {}) { scene = next; if (refit || !cam) fit(); else draw(); },
        setOptions(next) {
            const refit = ['vertical', 'view', 'fullMode'].some(k => k in next && next[k] !== opts[k]);
            opts = {...opts, ...next};
            if (next.tool && next.tool !== 'measure') measure = null;
            host.style.cursor = toolActive() ? 'crosshair' : 'grab';
            refit ? fit() : draw();
        },
        fit,
        zoom(f) { if (!cam) return; const sz = size(); cam = {...zoomAt(cam, opts.vertical, sz.width / 2, sz.height / 2, f, cam.fit * .2, 8), fit: cam.fit}; draw(); },
        setRatio(n) { if (!cam) return; this.zoom(scaleForRatio(n, opts.mmPerPx) / cam.s); },
        clearMeasure() { measure = null; draw(); },
        hasMeasure: () => !!measure,
        destroy() { ro.disconnect(); window.removeEventListener('mouseup', onUp); host.innerHTML = ''; }
    };
}
