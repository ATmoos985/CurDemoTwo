// 母卷导航条：整卷比例尺。已切段固定；工位滑块可拖动（吸附段边界）、拖右端改拉布长度；点击段跳转。
// 只渲染宿主给出的场景并回调，不读写业务状态。

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmtM = mm => (mm / 1000).toLocaleString('zh-CN', {maximumFractionDigits: 1});

/** 吸附：靠近任一吸附点（阈值内）则取该点，否则按 step 取整。 */
export function snapPosition(pos, snaps, threshold, step = 100) {
    let best = null;
    for (const s of snaps) if (Math.abs(s - pos) <= threshold && (best === null || Math.abs(s - pos) < Math.abs(best - pos))) best = s;
    return best ?? Math.round(pos / step) * step;
}

export function tickStep(total, widthPx) {
    const target = total / Math.max(1, widthPx / 70);
    const mag = 10 ** Math.floor(Math.log10(target));
    return [1, 2, 5, 10].find(n => n * mag >= target) * mag;
}

export function createRollNavigator(host, callbacks = {}) {
    let scene = null, drag = null, destroyed = false;
    const listeners = new AbortController(), hadClass = host.classList.contains('rn-host');
    host.classList.add('rn-host');
    const cancelDrag = () => { drag?.abort(); drag = null; };
    host.addEventListener('click', e => {
        if (destroyed || document.hidden) return;
        const segment = e.target.closest('.rn-seg');
        if (segment && host.contains(segment)) { e.stopPropagation(); callbacks.onPick?.(segment.dataset.seg); }
    }, {signal: listeners.signal});
    host.addEventListener('mousedown', beginDrag, {signal: listeners.signal});
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelDrag(); }, {signal: listeners.signal});
    window.addEventListener('blur', cancelDrag, {signal: listeners.signal});

    function render() {
        if (!scene) { host.innerHTML = ''; return; }
        const {roll, segments, defects, window: win, lock} = scene;
        const pct = v => (v / roll.total * 100).toFixed(4) + '%';
        let t = roll.used > 0 ? `<div class="rn-b rn-used" style="left:0;width:${pct(Math.min(roll.used, roll.total))}" title="已用 ${fmtM(roll.used)} m"></div>` : '';
        for (const s of segments) {
            const cut = s.status === 'cut', stale = s.status === 'stale';
            t += `<div class="rn-b rn-seg ${cut ? 'rn-cut' : ''} ${stale ? 'rn-stale' : ''} ${s.id === scene.currentId ? 'rn-on' : ''}" data-seg="${esc(s.id)}" style="left:${pct(s.start)};width:${pct(s.len)};background:${stale ? 'transparent' : s.tint}" title="${esc(s.label)} · Y ${fmtM(s.start)}–${fmtM(s.start + s.len)} m${cut ? ' · 已切（固定）' : stale ? ' · 已失效（母卷重置遗留）' : ''}"></div>`;
        }
        for (const d of defects) t += `<div class="rn-def ${d.fresh ? 'rn-fresh' : ''}" style="left:${pct(d.u)}" title="${esc(d.label)}"></div>`;
        if (win) {
            const ro = win.start < lock - 1 || scene.fixed || win.readOnly;
            t += `<div class="rn-win ${ro ? 'rn-ro' : ''} ${win.adjusted ? 'rn-adj' : ''}" style="left:${pct(win.start)};width:${pct(win.len)}">
              <span class="rn-wl">${scene.fixed ? '整块投料 · ' : win.readOnly ? '范围固定 · ' : ro ? '已切 · ' : ''}工位 ${fmtM(win.start)}–${fmtM(win.start + win.len)} m · 拉布 ${Math.round(win.len)} mm</span>
              ${ro || !scene.bed ? '' : '<div class="rn-handle" title="拖动调整拉布长度">Ⅱ</div>'}</div>`;
        }
        const width = host.clientWidth || 800, step = tickStep(roll.total, width);
        for (let p = 0; p <= roll.total + 1e-6; p += step) t += `<div class="rn-tick" style="left:${pct(p)}">${fmtM(p)}</div>`;
        host.innerHTML = `<div class="rn-track">${t}</div>`;
    }

    function beginDrag(e) {
        if (destroyed || document.hidden || !scene || e.button !== 0) return;
        const track = host.querySelector('.rn-track');
        const win = e.target.closest('.rn-win:not(.rn-ro)');
        if (!win || !track?.contains(win)) return;
        e.preventDefault(); e.stopPropagation(); cancelDrag(); drag = new AbortController();
        const resize = e.target.classList.contains('rn-handle');
        const {roll, window: w0, lock, segments, bed} = scene;
        const mmPerPx = roll.total / track.getBoundingClientRect().width, x0 = e.clientX;
        const snaps = [lock, ...segments.filter(s => s.status !== 'cut').map(s => s.start)];
        window.addEventListener('mousemove', ev => {
            if (document.hidden) return;
            const d = (ev.clientX - x0) * mmPerPx;
            let next;
            if (resize) {
                const max = Math.min(bed.max, roll.total - w0.start), min = Math.min(bed.min, max);
                next = {start: w0.start, len: Math.max(min, Math.min(max, Math.round((w0.len + d) / 100) * 100))};
            } else {
                const max = roll.total - w0.len, raw = Math.max(lock, Math.min(max, w0.start + d));
                next = {start: Math.max(lock, Math.min(max, snapPosition(raw, snaps, 12 * mmPerPx))), len: w0.len};
            }
            callbacks.onWindow?.(next);
        }, {signal: drag.signal});
        window.addEventListener('mouseup', ev => {
            if (ev.button !== 0) return;
            cancelDrag(); callbacks.onWindowEnd?.();
        }, {signal: drag.signal});
    }

    return {
        setScene(next) {
            if (destroyed) return;
            if (!next || scene && (scene.roll.id !== next.roll.id || scene.currentId !== next.currentId || scene.lock !== next.lock || next.fixed || next.window?.readOnly)) cancelDrag();
            scene = next; render();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true; cancelDrag(); listeners.abort(); scene = null; host.innerHTML = '';
            if (!hadClass) host.classList.remove('rn-host');
        }
    };
}
