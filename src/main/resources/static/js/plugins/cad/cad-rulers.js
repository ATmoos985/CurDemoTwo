/** 固定屏幕像素的毫米标尺；原点与工位起刀设置一致。 */
import { stage } from './cad-stage.js';
import { state } from '../../core/state.js';
import { RULER_SIZE, rulerStep, rulerOrigin, canvasView } from './cad-view.js';

export function drawRulers(cursorX, cursorY) {
    const canvas = document.getElementById('cad-ruler-canvas');
    if (!canvas || !stage) return;
    const w = stage.width(), h = stage.height();
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    const size = RULER_SIZE, scale = stage.scaleX(), pos = stage.position();
    const data = state.getCurrentCaseData(), origin = rulerOrigin(data, canvasView.overview);
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const bg = dark ? '#18212d' : '#f1f4f6';
    const border = dark ? '#465362' : '#ccd4dc';
    const ink = dark ? '#b9c8d5' : '#526476';
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, size);
    ctx.fillRect(0, 0, size, h);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size - .5, h); ctx.lineTo(size - .5, size - .5); ctx.lineTo(w, size - .5);
    ctx.stroke();
    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = ink;
    const step = rulerStep(scale), sub = step / 5;
    for (const horizontal of [true, false]) {
        const length = horizontal ? w : h;
        const start = horizontal ? pos.x + origin.x * scale : pos.y + origin.y * scale;
        const direction = horizontal ? origin.dx : origin.dy;
        const a = (size - start) / (scale * direction);
        const b = (length - start) / (scale * direction);
        const first = Math.ceil(Math.min(a, b) / sub), last = Math.floor(Math.max(a, b) / sub);
        for (let i = first; i <= last; i++) {
            const pixel = Math.round(start + i * sub * scale * direction) + .5;
            const major = i % 5 === 0;
            const tick = major ? 9 : 4;
            ctx.strokeStyle = major ? ink : border;
            ctx.beginPath();
            if (horizontal) { ctx.moveTo(pixel, size - tick); ctx.lineTo(pixel, size); }
            else { ctx.moveTo(size - tick, pixel); ctx.lineTo(size, pixel); }
            ctx.stroke();
            if (!major) continue;
            ctx.save();
            if (horizontal) { ctx.textAlign = 'center'; ctx.fillText(String(Math.round(i * sub)), pixel, 12); }
            else { ctx.translate(12, pixel); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(String(Math.round(i * sub)), 0, 0); }
            ctx.restore();
        }
    }
    // 布宽和当前工位在标尺上的投影。
    ctx.fillStyle = '#547c92';
    const x0 = Math.max(size, pos.x), x1 = Math.min(w, pos.x + data.rollW * scale);
    if (x1 > x0) ctx.fillRect(x0, size - 3, x1 - x0, 2);
    ctx.fillStyle = '#c45656';
    const y0 = Math.max(size, pos.y + (data.windowStartY || 0) * scale);
    const y1 = Math.min(h, pos.y + ((data.windowStartY || 0) + data.bedL) * scale);
    if (y1 > y0) ctx.fillRect(size - 3, y0, 2, y1 - y0);
    ctx.strokeStyle = '#2e718f';
    ctx.beginPath();
    if (cursorX >= size && cursorX <= w) { ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, size); }
    if (cursorY >= size && cursorY <= h) { ctx.moveTo(0, cursorY); ctx.lineTo(size, cursorY); }
    ctx.stroke();
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size - 1, size - 1);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.fillText('mm', size / 2, 18);
    ctx.restore();
}
