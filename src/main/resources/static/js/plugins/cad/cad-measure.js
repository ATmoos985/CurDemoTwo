/** 两点测量：端点使用模型 mm，标签保持屏幕像素大小。 */
import { stage, mainLayer } from './cad-stage.js';
import { bus } from '../../core/event-bus.js';

let measuring = false, start = null, preview = null, group = null;
const measurements = [];

export function toggleMeasureTool(force = null) {
    measuring = force === null ? !measuring : !!force;
    const button = document.getElementById('btn-measure-tool');
    if (button) {
        button.setAttribute('aria-pressed', String(measuring));
        button.textContent = measuring ? '结束测量' : '测量';
    }
    const hint = document.getElementById('cad-tool-hint');
    if (hint) hint.hidden = !measuring;
    const caption = document.getElementById('cad-view-caption');
    if (caption) caption.hidden = measuring;
    if (stage) {
        stage.draggable(!measuring);
        stage.off('click.measure mousemove.measure');
        if (measuring) { stage.on('click.measure', clickPoint); stage.on('mousemove.measure', movePoint); }
    }
    // 测量时让点击穿过实体，避免移动裁片或打开料头操作。
    if (mainLayer) mainLayer.listening(!measuring);
    const container = document.getElementById('konva-container');
    if (container) container.style.cursor = measuring ? 'crosshair' : 'default';
    start = preview = null;
    drawMeasurements();
}

export function clearAllMeasurements() {
    measurements.length = 0;
    start = preview = null;
    drawMeasurements();
}

function worldPoint() {
    const pointer = stage.getPointerPosition(), scale = stage.scaleX(), pos = stage.position();
    return pointer ? { x: Math.round((pointer.x - pos.x) / scale), y: Math.round((pointer.y - pos.y) / scale) } : null;
}
function clickPoint() {
    const point = worldPoint();
    if (!point) return;
    if (!start) start = point;
    else {
        if (Math.hypot(point.x - start.x, point.y - start.y) >= 1) measurements.push([start, point]);
        start = preview = null;
    }
    drawMeasurements();
}
function movePoint() {
    if (!start) return;
    preview = worldPoint();
    drawMeasurements();
}
function drawMeasurements() {
    if (!stage || !mainLayer) return;
    if (!group) { group = new Konva.Group({ listening: false }); mainLayer.add(group); }
    group.destroyChildren();
    const inv = 1 / stage.scaleX();
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const marker = p => group.add(new Konva.Circle({ x: p.x, y: p.y, radius: 3 * inv,
        fill: '#b78a3d', stroke: dark ? '#19232e' : '#ffffff', strokeWidth: 1, strokeScaleEnabled: false }));
    const pairs = [...measurements];
    if (start && preview) pairs.push([start, preview]);
    else if (start) marker(start);
    for (const [a, b] of pairs) {
        group.add(new Konva.Line({ points: [a.x, a.y, b.x, b.y], stroke: '#b78a3d', strokeWidth: 1.5, strokeScaleEnabled: false }));
        marker(a); marker(b);
        const badge = new Konva.Group({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scaleX: inv, scaleY: inv });
        const text = new Konva.Text({ text: `${Math.hypot(b.x - a.x, b.y - a.y).toFixed(1)} mm  ·  ΔX ${Math.abs(b.x-a.x)} / ΔY ${Math.abs(b.y-a.y)}`,
            fontSize: 12, fontFamily: 'Consolas, sans-serif', fill: dark ? '#dfbf80' : '#856020', padding: 7 });
        text.position({ x: -text.width() / 2, y: -32 });
        badge.add(new Konva.Rect({ x: text.x(), y: text.y(), width: text.width(), height: text.height(),
            fill: dark ? '#242d35' : '#fffdf8', stroke: '#ceb98e', strokeWidth: 1, cornerRadius: 3 }));
        badge.add(text);
        group.add(badge);
    }
    group.moveToTop();
    mainLayer.batchDraw();
}
window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !measuring) return;
    if (start) { start = preview = null; drawMeasurements(); }
    else toggleMeasureTool(false);
});
for (const event of ['stage:transformed', 'stage:resized', 'theme:changed']) bus.on(event, drawMeasurements);
for (const event of ['case:changed', 'mode:changed']) bus.on(event, () => { clearAllMeasurements(); toggleMeasureTool(false); });
