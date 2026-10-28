// 独立母卷画布。场景与相机属于实例，几何复用现有 Konva renderer；宿主处理业务命令。
import {shapeNode} from './nesting-renderer.js';
import {rectangle} from './nesting-scene.js';
import {toScreen, toWorld, screenRect, fitCamera, zoomAt, panBy, ratioOf, scaleForRatio, rulerStep, DEFAULT_MM_PER_PX} from './roll-camera.js';

const RULER = 22;
const fmtM = mm => (mm / 1000).toLocaleString('zh-CN', {maximumFractionDigits: 2});
const n1 = n => Math.round(n * 10) / 10;

/** 输入为全卷坐标；多边形凹口不属于裁片，轮廓上的点属于裁片。 */
export function containsRollPiece(piece, u, v) {
    const x = v - piece.v, y = u - piece.u;
    if (x < 0 || y < 0 || x > piece.dv || y > piece.du) return false;
    if (piece.shape?.type !== 'POLYGON') return true;
    const vertices = piece.shape.vertices;
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const a = vertices[j], b = vertices[i];
        const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
        if (Math.abs(cross) < 1e-7 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)
            && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) return true;
        if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

export function createRollCanvas(host, callbacks = {}, {Konva = globalThis.Konva} = {}) {
    if (!Konva) throw new Error('画布组件未加载，请刷新页面');
    let scene = null, cam = null, rows = null, gesture = null, measure = null, draft = null, defectPreview = null;
    let destroyed = false, visible = true, frame = null, dirty = true, worlds = [], coverage = null;
    let opts = {vertical: true, view: 'station', fullMode: 'strip', tool: 'pan', mmPerPx: DEFAULT_MM_PER_PX, showPath: false, showDimensions: true};
    const oldTabIndex = host.getAttribute('tabindex'), oldTouchAction = host.style.touchAction;
    const oldCursor = host.style.cursor, oldTitle = host.getAttribute('title'), hadClass = host.classList.contains('rc-host');
    host.classList.add('rc-host'); host.tabIndex = 0; host.style.touchAction = 'none';
    const stage = new Konva.Stage({container: host, width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight)});
    const geometry = new Konva.Layer({listening: false});
    const annotations = new Konva.Layer({listening: false});
    const textPool = []; let textCursor = 0;
    stage.add(geometry, annotations);
    const listeners = new AbortController();
    const size = () => ({width: host.clientWidth, height: host.clientHeight});
    const tiled = () => opts.view === 'full' && opts.fullMode === 'tile';
    const current = () => scene?.segments.find(s => s.id === scene.currentId);
    const screen = (c, u, v) => toScreen(c, opts.vertical, u, v);
    const world = p => toWorld(cam, opts.vertical, ...p);
    const local = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left - host.clientLeft, e.clientY - r.top - host.clientTop]; };
    const clamp = ([u, v]) => [Math.max(0, Math.min(scene.roll.total, u)), Math.max(0, Math.min(scene.roll.width, v))];
    function hatch(background, stroke) {
        const tile = document.createElement('canvas'); tile.width = tile.height = 8;
        const ctx = tile.getContext('2d');
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, 8, 8); }
        ctx.strokeStyle = stroke; ctx.beginPath();
        ctx.moveTo(-1, 1); ctx.lineTo(1, -1); ctx.moveTo(0, 8); ctx.lineTo(8, 0); ctx.moveTo(7, 9); ctx.lineTo(9, 7); ctx.stroke();
        return tile;
    }
    const usedPattern = hatch('#2b3036', '#454c54'), wastePattern = hatch(null, '#59616a');

    function requestDraw() {
        if (destroyed || !visible || frame !== null) return;
        frame = requestAnimationFrame(() => { frame = null; draw(); });
    }
    function fit() {
        if (destroyed || !scene) return;
        const sz = size(), W = scene.roll.width;
        if (!sz.width || !sz.height || !(W > 0) || !(scene.roll.total > 0)) return;
        if (opts.view === 'inspection' && scene.feed) {
            rows = null;
            const s = Math.max(.002, (sz.width - 124) / W);
            cam = {s, a: sz.height * .62 - scene.feed.u * s, c: 54};
        } else if (tiled()) {
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
            const w = scene.window, ctx = w ? Math.min(w.len * .2, 2500) : 0;
            const range = opts.view === 'station' && w ? {u0: w.start - ctx, u1: w.start + w.len + ctx} : {u0: 0, u1: scene.roll.total};
            cam = fitCamera({...range, v0: 0, v1: W}, sz, opts.vertical, {start: 68, end: 40, near: 78, far: 40});
        }
        cam.fit = cam.s; dirty = true; requestDraw();
    }
    function addShape(group, shape, x, y, attrs = {}) {
        // 平面裁片无阴影；关闭每个半透明填充/描边对象的整屏缓冲合成，避免全卷数千次复制。
        const node = shapeNode(Konva, shape, {x, y, strokeWidth: 1, strokeScaleEnabled: false, listening: false, perfectDrawEnabled: false, ...attrs});
        group.add(node); return node;
    }
    function line(group, points, attrs = {}) {
        const node = new Konva.Line({points, stroke: '#f0c674', strokeWidth: 1, strokeScaleEnabled: false, listening: false, ...attrs});
        group.add(node); return node;
    }
    function text(x, y, value, attrs = {}, parent = annotations) {
        // 标尺/尺寸只更新文本和位置，避免每帧重建文字测量及 Konva 属性订阅。
        const node = textPool[textCursor] || (textPool[textCursor] = new Konva.Text({listening: false})); textCursor++;
        node.setAttrs({x, y, offsetX: 0, offsetY: 0, name: '', text: String(value), fill: '#9aa4ae', fontFamily: 'monospace', fontSize: 11, ...attrs});
        parent.add(node); return node;
    }
    function label(x, y, value, attrs = {}, parent = annotations) {
        const node = text(x, y, value, attrs, parent); node.offsetX(node.width() / 2); return node;
    }
    function rectScreen(c, u, v, du, dv, attrs = {}, parent = annotations) {
        const r = screenRect(c, opts.vertical, u, v, du, dv);
        const node = new Konva.Rect({x: r.x, y: r.y, width: r.w, height: r.h, listening: false, ...attrs});
        parent.add(node); return node;
    }
    function visibleRange() {
        const sz = size(), along = opts.vertical ? sz.height : sz.width;
        return {start: Math.max(0, -cam.a / cam.s), end: Math.min(scene.roll.total, (along - cam.a) / cam.s)};
    }
    function rebuild() {
        geometry.destroyChildren(); worlds = [];
        const count = tiled() ? rows.n : 1, W = scene.roll.width;
        const range = visibleRange(), pad = (opts.vertical ? size().height : size().width) / cam.s;
        coverage = tiled() ? {start: 0, end: scene.roll.total}
            : {start: Math.max(0, range.start - pad), end: Math.min(scene.roll.total, range.end + pad)};
        for (let i = 0; i < count; i++) {
            const start = tiled() ? i * rows.rowLen : 0, end = tiled() ? start + rows.rowLen : scene.roll.total;
            const group = new Konva.Group(tiled() ? {clipX: 0, clipY: start, clipWidth: W, clipHeight: rows.rowLen} : {});
            geometry.add(group);
            addShape(group, scene.roll.shape || rectangle(W, scene.roll.total), 0, 0, {fill: '#353b42', stroke: '#6b747e'});
            if (scene.roll.used > 0) addShape(group, rectangle(W, Math.min(scene.roll.used, scene.roll.total)), 0, 0,
                {name: 'roll-hatch', fillPatternImage: usedPattern});
            const segments = [];
            for (const seg of scene.segments) {
                if (seg.start + seg.len < Math.max(start, coverage.start) || seg.start > Math.min(end, coverage.end)) continue;
                const cut = seg.status === 'cut', stale = seg.status === 'stale';
                const node = new Konva.Group({opacity: seg.opacity ?? (stale ? .25 : cut ? .42 : opts.view === 'station' && seg.id !== scene.currentId ? .5 : 1)});
                group.add(node);
                addShape(node, rectangle(W, seg.len), 0, seg.start,
                    {name: 'roll-hatch', fillPatternImage: wastePattern, stroke: '#5d6670', dash: stale ? [6, 4] : []});
                const pieces = seg.pieces.map(p => ({piece: p, node: addShape(node, p.shape || rectangle(p.dv, p.du), p.v, p.u,
                    {name: 'roll-piece', pieceId: p.id, segmentId: seg.id, fill: p.color, stroke: '#1d2125', opacity: p.opacity ?? .85,
                        ...(p.dash?.length ? {dash: p.dash} : {})})}));
                for (const r of seg.remnants || []) addShape(node, r.shape || rectangle(r.w, r.l), r.x, seg.start + r.y,
                    {name: 'roll-remnant', remnantId: r.id, segmentId: seg.id, fill: r.color || '#3d4549', stroke: r.stroke || (r.hasDefect ? '#b68d48' : '#8b9ba7'), dash: [6, 4]});
                if (opts.showPath) for (const k of seg.cuts || []) line(node, [k.v1, k.u1, k.v2, k.u2], {name: 'roll-cut', dash: [5, 3]});
                line(node, [0, seg.start, W, seg.start]);
                segments.push({seg, node, pieces});
            }
            for (const original of scene.defects) {
                const d = defectPreview?.id === original.id ? {...original, ...defectPreview} : original;
                if (d.u + d.du < start || d.u > end) continue;
                const color = d.fresh ? '#ff9f43' : '#ff6b5b';
                if (d.margin > 0) addShape(group, rectangle(d.dv + 2 * d.margin, d.du + 2 * d.margin), d.v - d.margin, d.u - d.margin,
                    {stroke: color, opacity: .5, dash: [3, 3]});
                addShape(group, rectangle(d.dv, d.du), d.v, d.u,
                    {name: 'roll-defect', defectId: d.id, fill: color, opacity: .5, stroke: color, strokeWidth: 1.5});
            }
            worlds.push({group, start, end, segments, hatches: group.find('.roll-hatch'), index: i});
        }
        dirty = false;
    }
    function drawRulers(sz) {
        annotations.add(new Konva.Rect({width: sz.width, height: RULER, fill: '#23272c'}));
        annotations.add(new Konva.Rect({width: RULER, height: sz.height, fill: '#23272c'}));
        const along = opts.vertical ? sz.height : sz.width, su = rulerStep(cam.s, 70);
        for (let u = Math.floor(-cam.a / cam.s / su) * su; cam.a + u * cam.s <= along; u += su) {
            const p = cam.a + u * cam.s; if (p < RULER) continue;
            line(annotations, opts.vertical ? [RULER - 7, p, RULER, p] : [p, RULER - 7, p, RULER], {stroke: '#6b747e'});
            const t = text(opts.vertical ? RULER - 3 : p + 3, opts.vertical ? p - 12 : 2, fmtM(u), {fontSize: 9.5});
            if (opts.vertical) t.offsetX(t.width());
        }
        const sv = rulerStep(cam.s, 44);
        for (let v = 0; v <= scene.roll.width; v += sv) {
            const p = cam.c + v * cam.s; if (p < RULER || p > (opts.vertical ? sz.width : sz.height)) continue;
            line(annotations, opts.vertical ? [p, RULER - 7, p, RULER] : [RULER - 7, p, RULER, p], {stroke: '#6b747e'});
            const t = text(opts.vertical ? p + 2 : RULER - 3, opts.vertical ? 2 : p - 5, Math.round(v), {fontSize: 9.5});
            if (!opts.vertical) t.offsetX(t.width());
        }
        annotations.add(new Konva.Rect({width: RULER, height: RULER, fill: '#1d2125'})); text(4, 4, 'm', {fontSize: 9.5});
    }
    function overlays() {
        const w = scene.window, W = scene.roll.width, seg = current();
        if (w) {
            rectScreen(cam, w.start, -6 / cam.s, w.len, W + 12 / cam.s, {stroke: w.adjusted ? '#f5b971' : '#7fb3e6', strokeWidth: 2, dash: [6, 3]});
            if (opts.showDimensions && w.len * cam.s > 80) {
                const a = screen(cam, w.start, -22 / cam.s), b = screen(cam, w.start + w.len, -22 / cam.s);
                line(annotations, [...a, ...b], {stroke: '#c9d0d7'});
                const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
                annotations.add(new Konva.Rect({x: x - 68, y: y - 8, width: 136, height: 18, fill: '#2a2f35'}));
                label(x, y - 6, seg?.caption || `拉布 ${n1(w.len)} mm`, {name: 'roll-dimension', fill: '#cfe3f7', fontSize: 12});
                for (const u of [w.start, w.start + w.len]) { const p = screen(cam, u, W); text(p[0] + (opts.vertical ? 8 : 0), p[1] + (opts.vertical ? -4 : 8), `Y ${fmtM(u)} m`); }
            }
        }
        if (opts.showPath && seg?.home) {
            let last = seg.home;
            const h = screen(cam, last.u, last.v);
            annotations.add(new Konva.Circle({name: 'roll-path', x: h[0], y: h[1], radius: 5, stroke: '#7fb3e6', strokeWidth: 2})); text(h[0] + 7, h[1] - 12, '原点', {name: 'roll-path'});
            (seg.cuts || []).forEach((k, i) => {
                const a = screen(cam, last.u, last.v), s = screen(cam, k.u1, k.v1), e = screen(cam, k.u2, k.v2);
                line(annotations, [...a, ...s], {name: 'roll-path', stroke: '#7fb3e6', dash: [2, 4]}); line(annotations, [...s, ...e], {name: 'roll-path', strokeWidth: 2});
                annotations.add(new Konva.Circle({name: 'roll-path', x: s[0], y: s[1], radius: 8, fill: '#1d2125', stroke: '#f0c674'}));
                label(s[0], s[1] - 5, k.step ?? i + 1, {name: 'roll-path', fill: '#f0c674', fontSize: 9.5}); last = {u: k.u2, v: k.v2};
            });
        }
        const selected = seg?.pieces.find(p => p.id === scene.selectedPiece);
        if (selected) {
            const group = new Konva.Group(); annotations.add(group); transform(group, cam);
            addShape(group, selected.shape || rectangle(selected.dv, selected.du), selected.v, selected.u, {stroke: '#fff', strokeWidth: 2});
        }
        for (const diagnostic of scene.diagnostics || []) {
            const group = new Konva.Group(); annotations.add(group); transform(group, cam);
            for (const p of diagnostic.shapes) addShape(group, p.shape || rectangle(p.dv, p.du), p.v, p.u,
                {name: 'roll-diagnostic', fill: '#ef444430', stroke: '#ff6b5b', strokeWidth: 2, dash: [4, 3]});
            const p = diagnostic.shapes[0];
            if (p) { const [x, y] = screen(cam, p.u, p.v); text(Math.max(RULER + 8, x), Math.max(RULER + 8, y - 20), diagnostic.message, {name: 'roll-diagnostic-label', fill: '#ff9b91'}); }
        }
        const defect = selectedDefect();
        if (defect) {
            rectScreen(cam, defect.u, defect.v, defect.du, defect.dv, {stroke: '#fff', strokeWidth: 2});
            if (opts.editDefects && opts.editable !== false && defect.editable && opts.tool === 'select')
                for (const [u, v] of defectCorners(defect)) {
                    const [x, y] = screen(cam, u, v);
                    annotations.add(new Konva.Rect({name: 'roll-defect-handle', x: x - 4, y: y - 4, width: 8, height: 8, fill: '#fff', stroke: '#ff9f43'}));
                }
        }
        if (scene.feed) {
            const u = scene.feed.u, a = screen(cam, u, 0), b = screen(cam, u, W);
            line(annotations, [...a, ...b], {name: 'roll-feed-line', stroke: '#4cc38a', strokeWidth: 2});
            const step = rulerStep(cam.s, 80);
            for (let d = 0; d <= W; d += step) {
                const p = screen(cam, u, scene.feed.fromRight ? W - d : d);
                line(annotations, opts.vertical ? [p[0], p[1] - 6, p[0], p[1] + 3] : [p[0] - 6, p[1], p[0] + 3, p[1]], {stroke: '#4cc38a'});
                label(p[0], p[1] - 19, n1(d), {fill: '#8fe0b5', fontSize: 9.5});
            }
            text(b[0] + 8, b[1] - 5, `${fmtM(u)} m`, {name: 'roll-feed-label', fill: '#8fe0b5'});
        }
        if (draft) rectScreen(cam, Math.min(draft.a[0], draft.b[0]), Math.min(draft.a[1], draft.b[1]),
            Math.abs(draft.a[0] - draft.b[0]), Math.abs(draft.a[1] - draft.b[1]), {fill: '#ff9f4340', stroke: '#ff9f43', dash: [4, 2]});
        if (measure) {
            const a = screen(cam, ...measure.a), b = screen(cam, ...measure.b), du = Math.abs(measure.a[0] - measure.b[0]), dv = Math.abs(measure.a[1] - measure.b[1]);
            line(annotations, [...a, ...b], {stroke: '#f5d76e', strokeWidth: 1.5});
            for (const p of [a, b]) annotations.add(new Konva.Circle({x: p[0], y: p[1], radius: 3, fill: '#f5d76e'}));
            text((a[0] + b[0]) / 2 + 10, (a[1] + b[1]) / 2 - 18,
                `${n1(Math.hypot(du, dv))} mm · 长 ${n1(du)} / 宽 ${n1(dv)}`, {name: 'roll-measure', fill: '#f5d76e'});
        }
    }
    // 几何始终保持 x=幅宽、y=卷长；横向仅在视图矩阵交换两轴。
    function transform(group, c) {
        group.setAttrs(opts.vertical ? {x: c.c, y: c.a, scaleX: c.s, scaleY: c.s, rotation: 0}
            : {x: c.a, y: c.c, scaleX: c.s, scaleY: -c.s, rotation: 90});
    }
    function draw() {
        if (destroyed || !visible || !scene || !cam) return;
        const sz = size(); if (!sz.width || !sz.height) return;
        stage.size(sz);
        const range = visibleRange();
        // 工位只保留视口及两侧缓冲区的节点；相机越出缓冲范围立即重建，不省略可见几何。
        if (dirty || !coverage || !tiled() && (range.start < coverage.start || range.end > coverage.end)) rebuild();
        for (const t of textPool) t.remove();
        textCursor = 0; annotations.destroyChildren();
        for (const item of worlds) {
            const c = tiled() ? {...cam, a: cam.a - item.index * rows.rowLen * cam.s, c: cam.c + item.index * (scene.roll.width + rows.gap) * cam.s} : cam;
            transform(item.group, c);
            for (const h of item.hatches) h.fillPatternScale({x: 1 / c.s, y: 1 / c.s});
            const min = Math.max(item.start, -c.a / c.s - 100), max = Math.min(item.end, ((opts.vertical ? sz.height : sz.width) - c.a) / c.s + 100);
            const labelGroup = new Konva.Group(); annotations.add(labelGroup);
            if (tiled()) {
                const r = screenRect(c, opts.vertical, item.start, 0, rows.rowLen, scene.roll.width);
                labelGroup.setAttrs({clipX: r.x, clipY: r.y, clipWidth: r.w, clipHeight: r.h});
            }
            for (const {seg, node, pieces} of item.segments) {
                const show = seg.start + seg.len >= min && seg.start <= max; node.visible(show); if (!show) continue;
                for (const {piece: p, node: pn} of pieces) {
                    const r = screenRect(c, opts.vertical, p.u, p.v, p.du, p.dv);
                    const inView = p.u + p.du >= min && p.u <= max && r.x + r.w >= 0 && r.x <= sz.width && r.y + r.h >= 0 && r.y <= sz.height;
                    pn.visible(inView);
                    if (inView && r.w > 56 && r.h > 16) label(r.x + r.w / 2, r.y + r.h / 2 - 5, p.label, {fill: '#fff'}, labelGroup);
                }
                const r = screenRect(c, opts.vertical, seg.start, 0, seg.len, scene.roll.width);
                for (const rem of seg.remnants || []) {
                    if (!rem.label) continue;
                    const rr = screenRect(c, opts.vertical, seg.start + rem.y, rem.x, rem.l, rem.w);
                    if (rr.w > 56 && rr.h > 16 && rr.y + rr.h >= 0 && rr.y <= sz.height && rr.x + rr.w >= 0 && rr.x <= sz.width)
                        label(rr.x + rr.w / 2, rr.y + 3, rem.label, {fill: '#e7d6b4', fontSize: 10}, labelGroup);
                }
                if (['cut', 'stale'].includes(seg.status) && Math.min(r.w, r.h) > 26 && !(opts.view === 'station' && seg.id === scene.currentId))
                    label(r.x + r.w / 2, r.y - 16, seg.caption || (seg.status === 'cut' ? '已切 ✓' : '已失效'), {fill: '#e6ebef'}, labelGroup);
            }
            if (opts.editDefects) for (const original of scene.defects) {
                const d = defectPreview?.id === original.id ? {...original, ...defectPreview} : original;
                if (d.u + d.du < min || d.u > max) continue;
                const r = screenRect(c, opts.vertical, d.u, d.v, d.du, d.dv);
                if (r.w > 32 && r.h > 18) text(r.x + 4, r.y + 4, d.label || '疵点', {fill: '#ffd3c9', fontSize: 10.5}, labelGroup);
            }
            if (tiled()) { const p = screen(c, item.start, 0); text(p[0], p[1] - 14, `${fmtM(item.start)} m`); }
        }
        if (!tiled()) { overlays(); drawRulers(sz); }
        stage.batchDraw();
        callbacks.onCamera?.({ratio: ratioOf(cam.s, opts.mmPerPx), percent: cam.fit ? cam.s / cam.fit * 100 : 100});
    }
    function cursorAt(p) {
        if (!scene || !cam) return null;
        let [u, v] = world(p);
        if (tiled()) {
            const i = Math.floor(v / (scene.roll.width + rows.gap));
            if (i < 0 || i >= rows.n || u < 0 || u > rows.rowLen) return null;
            u += i * rows.rowLen; v -= i * (scene.roll.width + rows.gap);
        }
        return u >= 0 && u <= scene.roll.total && v >= 0 && v <= scene.roll.width ? {u, v} : null;
    }
    function selectedDefect() {
        const d = scene?.defects.find(d => d.id === scene.selectedDefect);
        return d && defectPreview?.id === d.id ? {...d, ...defectPreview} : d;
    }
    const defectCorners = d => [[d.u, d.v], [d.u, d.v + d.dv], [d.u + d.du, d.v], [d.u + d.du, d.v + d.dv]];
    function editDefect(g, w) {
        const d = g.original;
        if (g.corner == null) return {...d,
            u: n1(Math.max(0, Math.min(scene.roll.total - d.du, d.u + w[0] - g.start[0]))),
            v: n1(Math.max(0, Math.min(scene.roll.width - d.dv, d.v + w[1] - g.start[1])))};
        const anchor = defectCorners(d)[3 - g.corner], q = clamp(w);
        const u = n1(g.corner < 2 ? Math.min(q[0], anchor[0] - .1) : Math.max(q[0], anchor[0] + .1));
        const v = n1(g.corner % 2 === 0 ? Math.min(q[1], anchor[1] - .1) : Math.max(q[1], anchor[1] + .1));
        return {...d, u: Math.min(u, anchor[0]), v: Math.min(v, anchor[1]), du: n1(Math.abs(u - anchor[0])), dv: n1(Math.abs(v - anchor[1]))};
    }
    const toolCursor = () => ['measure', 'defect'].includes(opts.tool) ? 'crosshair' : opts.tool === 'move' ? 'move' : opts.tool === 'select' ? 'default' : 'grab';
    function cancelGesture() {
        const g = gesture;
        gesture = null; draft = null;
        if (defectPreview) { defectPreview = null; dirty = true; }
        if (measure?.live) measure = null;
        if (g && host.hasPointerCapture?.(g.pointer)) host.releasePointerCapture(g.pointer);
        if (g?.kind === 'piece') callbacks.onPieceMove?.(g.id, 0, 0, true);
        host.style.cursor = toolCursor(); requestDraw();
    }
    function onDown(e) {
        if (!visible || !cam || !scene || e.button !== 0 || gesture) return;
        e.preventDefault(); host.focus({preventScroll: true});
        const p = local(e), w = world(p);
        callbacks.onInteract?.(opts.tool);
        if (!tiled() && opts.editDefects && ['defect', 'select'].includes(opts.tool)) {
            const selected = selectedDefect();
            const corner = selected?.editable && opts.tool === 'select'
                ? defectCorners(selected).findIndex(q => { const s = screen(cam, ...q); return Math.hypot(s[0] - p[0], s[1] - p[1]) <= 7; }) : -1;
            const tol = 4 / cam.s;
            const hit = corner >= 0 ? selected : scene.defects.slice().reverse().find(d =>
                w[0] >= d.u - tol && w[0] <= d.u + d.du + tol && w[1] >= d.v - tol && w[1] <= d.v + d.dv + tol);
            callbacks.onDefectSelect?.(hit?.id ?? null);
            if (hit) {
                if (!hit.editable || opts.editable === false) return;
                gesture = {kind: 'defect-edit', id: hit.id, original: {...hit}, start: w, corner: corner >= 0 ? corner : null, pointer: e.pointerId};
            }
        }
        if (gesture) { /* Editable defect already selected above. */ }
        else if (!tiled() && opts.tool === 'move') {
            const seg = current();
            const hit = seg?.status === 'pending' && !seg.invalid && opts.editable !== false
                ? seg.pieces.slice().reverse().find(x => containsRollPiece(x, ...w)) : null;
            callbacks.onPieceSelect?.(hit?.id ?? null);
            if (!hit) return;
            gesture = {kind: 'piece', id: hit.id, start: w, pointer: e.pointerId};
        } else if (!tiled() && ['measure', 'defect'].includes(opts.tool)) {
            if (opts.tool === 'defect' && opts.editable === false) return;
            if (!cursorAt(p)) return;
            gesture = {kind: opts.tool, pointer: e.pointerId};
            const q = {a: clamp(w), b: clamp(w), live: true};
            if (opts.tool === 'measure') measure = q; else draft = q;
        } else { gesture = {kind: 'pan', last: p, pointer: e.pointerId}; host.style.cursor = 'grabbing'; }
        host.setPointerCapture(e.pointerId); requestDraw();
    }
    function onMove(e) {
        if (!visible || !cam) return;
        const p = local(e), cursor = cursorAt(p); callbacks.onCursor?.(cursor);
        const segment = cursor && scene.segments.find(s => cursor.u >= s.start && cursor.u <= s.start + s.len
            && s.pieces.some(x => containsRollPiece(x, cursor.u, cursor.v)));
        const piece = segment?.pieces.find(x => containsRollPiece(x, cursor.u, cursor.v));
        const defect = cursor && scene.defects.find(d => cursor.u >= d.u && cursor.u <= d.u + d.du && cursor.v >= d.v && cursor.v <= d.v + d.dv);
        host.title = piece?.title || defect?.label || '';
        if (!gesture || gesture.pointer !== e.pointerId) return;
        const w = world(p);
        if (gesture.kind === 'piece') callbacks.onPieceMove?.(gesture.id, w[0] - gesture.start[0], w[1] - gesture.start[1], false);
        else if (gesture.kind === 'defect-edit') { defectPreview = editDefect(gesture, w); dirty = true; requestDraw(); }
        else if (gesture.kind === 'measure') { measure.b = clamp(w); requestDraw(); }
        else if (gesture.kind === 'defect') { draft.b = clamp(w); requestDraw(); }
        else { cam = panBy(cam, opts.vertical, p[0] - gesture.last[0], p[1] - gesture.last[1]); gesture.last = p; requestDraw(); }
    }
    function onUp(e) {
        if (!gesture || gesture.pointer !== e.pointerId) return;
        const g = gesture; gesture = null;
        if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
        if (g.kind === 'piece') { const w = world(local(e)); callbacks.onPieceMove?.(g.id, w[0] - g.start[0], w[1] - g.start[1], true); }
        if (g.kind === 'defect-edit') {
            const next = editDefect(g, world(local(e))); defectPreview = null; dirty = true;
            callbacks.onDefectEdit?.(g.id, {u: next.u, v: next.v, du: next.du, dv: next.dv});
        }
        if (measure) measure.live = false;
        if (draft) {
            const d = draft; draft = null;
            const du = n1(Math.abs(d.a[0] - d.b[0])), dv = n1(Math.abs(d.a[1] - d.b[1])), min = opts.minDefectSize ?? 5;
            if (du >= min && dv >= min) callbacks.onDefectDraw?.({u: n1(Math.min(d.a[0], d.b[0])), v: n1(Math.min(d.a[1], d.b[1])), du, dv});
        }
        host.style.cursor = toolCursor(); requestDraw();
    }
    function onWheel(e) {
        if (!visible || !cam || gesture) return;
        e.preventDefault(); callbacks.onInteract?.('zoom'); const p = local(e);
        cam = zoomAt(cam, opts.vertical, ...p, e.deltaY < 0 ? 1.15 : 1 / 1.15, cam.fit * .2, 8); requestDraw();
    }
    function onContextMenu(e) {
        if (!visible || !cam || !scene || !callbacks.onContextMenu) return;
        const cursor = cursorAt(local(e));
        if (!cursor) return;
        e.preventDefault(); cancelGesture(); host.focus({preventScroll: true});
        let target = {kind: 'station', segmentId: null};
        // Reverse drawing order, using actual outlines rather than bounding rectangles.
        for (const seg of [...scene.segments].reverse()) {
            const remnant = [...(seg.remnants || [])].reverse().find(r => containsRollPiece(
                {u: seg.start + r.y, v: r.x, du: r.l, dv: r.w, shape: r.shape}, cursor.u, cursor.v));
            const piece = [...seg.pieces].reverse().find(p => containsRollPiece(p, cursor.u, cursor.v));
            if (remnant || piece) { target = {kind: remnant ? 'remnant' : 'piece', segmentId: seg.id, entityId: (remnant || piece).id}; break; }
            if (cursor.u >= seg.start && cursor.u <= seg.start + seg.len) { target = {kind: 'station', segmentId: seg.id}; break; }
        }
        callbacks.onContextMenu({...target, ...cursor, clientX: e.clientX, clientY: e.clientY});
    }
    function onKey(e) {
        if (!visible || !scene || e.target !== host || e.isComposing) return;
        if (e.key === 'Escape') {
            cancelGesture(); measure = null;
            if (opts.tool === 'move') callbacks.onPieceSelect?.(null);
            requestDraw(); e.stopPropagation(); return;
        }
        if (gesture || e.altKey) return;
        const seg = current(), editable = opts.tool === 'move' && !tiled() && opts.editable !== false && seg?.status === 'pending' && !seg.invalid;
        const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
        if (ctrl) {
            if (editable && (key === 'z' || key === 'y')) {
                e.preventDefault(); callbacks.onEditCommand?.({type: key === 'y' || e.shiftKey ? 'redo' : 'undo'});
            }
            return;
        }
        if (key === 'f') { e.preventDefault(); if (!api.fitSelection()) fit(); return; }
        if (!editable || !seg.pieces.some(p => p.id === scene.selectedPiece)) return;
        const step = e.shiftKey ? 20 : 5, dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx || dy) {
            e.preventDefault(); callbacks.onEditCommand?.({type: 'nudge', pieceId: scene.selectedPiece, du: opts.vertical ? dy : dx, dv: opts.vertical ? dx : dy});
        } else if (['r', 'delete', 'backspace'].includes(key)) {
            e.preventDefault(); callbacks.onEditCommand?.({type: key === 'r' ? 'rotate' : 'remove', pieceId: scene.selectedPiece});
        }
    }
    for (const [type, handler] of Object.entries({pointerdown: onDown, pointermove: onMove, pointerup: onUp,
        pointercancel: cancelGesture, lostpointercapture: () => { if (gesture) cancelGesture(); },
        pointerleave: () => callbacks.onCursor?.(null), wheel: onWheel,
        keydown: onKey, contextmenu: onContextMenu}))
        host.addEventListener(type, handler, {signal: listeners.signal, ...(type === 'wheel' ? {passive: false} : {})});
    const observer = new ResizeObserver(() => {
        if (destroyed || !visible) return;
        if (!cam || opts.view === 'inspection') fit(); else requestDraw();
    }); observer.observe(host);

    const api = {
        setScene(next, {refit = false, follow = false} = {}) {
            if (destroyed) return;
            if (scene && (scene.currentId !== next?.currentId || scene.roll.id !== next?.roll.id)) { cancelGesture(); measure = null; }
            if (follow && cam && scene?.window && next?.window) cam = {...cam, a: cam.a - (next.window.start - scene.window.start) * cam.s};
            if (follow && cam && scene?.feed && next?.feed) cam = {...cam, a: cam.a - (next.feed.u - scene.feed.u) * cam.s};
            scene = next; dirty = true;
            if (!scene) { geometry.destroyChildren(); annotations.destroyChildren(); for (const t of textPool) t.destroy(); textPool.length = 0; return; }
            if (refit || !cam) fit(); else requestDraw();
        },
        getCamera: () => cam && {...cam, rows: rows && {...rows}},
        setCamera(c) {
            if (destroyed || !c || ![c.s, c.a, c.c].every(Number.isFinite) || c.s <= 0) return;
            const {rows: r, ...rest} = c; cam = {...rest, fit: rest.fit > 0 ? rest.fit : rest.s};
            rows = r ? {...r} : null;
            if (tiled() && !rows) fit(); else { dirty = true; requestDraw(); }
        },
        setOptions(next) {
            if (destroyed) return;
            const refit = ['vertical', 'view', 'fullMode'].some(k => k in next && next[k] !== opts[k]);
            if (refit || next.tool && next.tool !== opts.tool) cancelGesture();
            if ('showPath' in next && next.showPath !== opts.showPath) dirty = true;
            opts = {...opts, ...next}; if (next.tool && next.tool !== 'measure') measure = null;
            host.style.cursor = toolCursor();
            if (refit) fit(); else requestDraw();
        },
        fit,
        fitSelection() {
            if (destroyed || !scene || tiled()) return false;
            const p = current()?.pieces.find(p => p.id === scene.selectedPiece);
            if (!p) return false;
            return api.fitBounds({u0: p.u, u1: p.u + p.du, v0: p.v, v1: p.v + p.dv});
        },
        fitBounds(bounds) {
            if (destroyed || !scene || tiled() || !['u0', 'u1', 'v0', 'v1'].every(k => Number.isFinite(bounds?.[k]))
                || bounds.u1 < bounds.u0 || bounds.v1 < bounds.v0) return false;
            cam = fitCamera(bounds, size(), opts.vertical, {start: 48, end: 48, near: 48, far: 48});
            cam.fit = cam.s; dirty = true; requestDraw(); return true;
        },
        zoom(factor) {
            if (destroyed || !cam || !(factor > 0)) return;
            const sz = size(); cam = zoomAt(cam, opts.vertical, sz.width / 2, sz.height / 2, factor, cam.fit * .2, 8); requestDraw();
        },
        setRatio(n) { if (cam) api.zoom(scaleForRatio(n, opts.mmPerPx) / cam.s); },
        clearMeasure() { measure = null; requestDraw(); },
        hasMeasure: () => !!measure,
        getView: () => api.getCamera(), setView: c => api.setCamera(c),
        setTool: tool => api.setOptions({tool}),
        setSelection(id) { if (scene) api.setScene({...scene, selectedPiece: id}); },
        setVisible(next) {
            if (destroyed) return;
            visible = !!next; stage.visible(visible);
            if (!visible) { cancelGesture(); if (frame !== null) cancelAnimationFrame(frame); frame = null; }
            else cam ? requestDraw() : fit();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; listeners.abort(); observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
            if (gesture && host.hasPointerCapture(gesture.pointer)) host.releasePointerCapture(gesture.pointer);
            gesture = null; scene = null; worlds = []; stage.destroy();
            for (const t of textPool) t.destroy(); textPool.length = 0;
            if (!hadClass) host.classList.remove('rc-host');
            if (oldTabIndex === null) host.removeAttribute('tabindex'); else host.setAttribute('tabindex', oldTabIndex);
            host.style.touchAction = oldTouchAction; host.style.cursor = oldCursor;
            if (oldTitle === null) host.removeAttribute('title'); else host.setAttribute('title', oldTitle);
        }
    };
    return api;
}
