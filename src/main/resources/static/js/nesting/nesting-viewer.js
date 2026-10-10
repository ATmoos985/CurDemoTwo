import { renderNestingGeometry, shapeNode } from './nesting-renderer.js';
import { fitBounds, labelDetail } from '../plugins/cad/cad-view.js';

/** Reusable read-only canvas; hosts own input editing and business actions. */
export function mountNestingViewer(container, { Konva = globalThis.Konva, onSelect = () => {}, onZoom = () => {} } = {}) {
    const stage = new Konva.Stage({ container, width: container.clientWidth, height: container.clientHeight, draggable: true });
    const layer = new Konva.Layer(), labels = new Konva.Layer({ listening: false });
    stage.add(layer); stage.add(labels);
    const groups = Object.fromEntries(['background', 'leftovers', 'placements', 'exclusions', 'cuts', 'boundary']
        .map(key => [key, new Konva.Group()]));
    Object.values(groups).forEach(group => layer.add(group));
    let scene = null, selected = null, showPaths = true, showDimensions = true, fitted = true;
    function annotations() {
        labels.destroyChildren();
        if (!scene) return;
        const scale = stage.scaleX(), pos = stage.position();
        labels.scale({ x: 1 / scale, y: 1 / scale });
        labels.position({ x: -pos.x / scale, y: -pos.y / scale });
        const text = (value, x, y, width, options = {}) => labels.add(new Konva.Text({
            text: value, x, y, width, fontFamily: 'Consolas, Microsoft YaHei, sans-serif', fontSize: 12,
            fill: '#405567', align: 'center', wrap: 'none', ellipsis: true, ...options }));
        const { width, height } = scene.region.shape;
        if (showDimensions) {
            text(`${width} mm`, pos.x, pos.y - 26, width * scale);
            text(`${height} mm`, pos.x + width * scale + 10, pos.y + height * scale / 2, 86, { align: 'left' });
            text('原点 (0, 0) · X → · Y ↓', pos.x, pos.y + height * scale + 16, Math.max(190, width * scale), { align: 'left', fontSize: 11 });
        }
        for (const p of scene.placements) {
            const x = pos.x + p.x * scale, y = pos.y + p.y * scale;
            const w = p.shape.width * scale, h = p.shape.height * scale;
            // A concave part's bounding-box center can be outside the part. Details remain in the selection panel.
            const detail = p.shape.type === 'POLYGON' ? 0 : labelDetail(p.shape.width, p.shape.height, scale);
            if (detail) text(p.name || `#${p.id}`, x + 4, y + h / 2 - (detail === 2 ? 15 : 6), w - 8);
            if (detail === 2 && showDimensions) text(`${p.shape.width} × ${p.shape.height}`, x + 4, y + h / 2 + 4, w - 8, { fill: '#6b7e8d', fontSize: 11 });
            if (selected === p.id) labels.add(shapeNode(Konva, p.shape, { x, y, scaleX: scale, scaleY: scale,
                stroke: '#275c7b', strokeWidth: 2, strokeScaleEnabled: false }));
        }
        onZoom(scale);
        labels.batchDraw();
    }
    function fit() {
        if (!scene) return;
        fitted = true;
        const fittedView = fitBounds(stage.width(), stage.height(), { x: 0, y: 0, width: scene.material.shape.width, height: scene.material.shape.height });
        stage.scale({ x: fittedView.scale, y: fittedView.scale });
        stage.position({ x: fittedView.x, y: fittedView.y });
        annotations();
    }
    function zoom(factor, pointer = { x: stage.width() / 2, y: stage.height() / 2 }) {
        const old = stage.scaleX(), next = Math.max(.00001, Math.min(5, old * factor));
        fitted = false;
        const pos = stage.position();
        stage.scale({ x: next, y: next });
        stage.position({ x: pointer.x - (pointer.x - pos.x) * next / old, y: pointer.y - (pointer.y - pos.y) * next / old });
        annotations();
    }
    stage.on('wheel', event => { event.evt.preventDefault(); zoom(event.evt.deltaY > 0 ? 1 / 1.12 : 1.12, stage.getPointerPosition() || undefined); });
    stage.on('dragstart', event => { if (event.target === stage) fitted = false; });
    stage.on('dragmove', annotations);
    stage.on('click tap', () => { selected = null; onSelect(null); annotations(); });
    const keydown = event => {
        if (event.key === '0') fit();
        else if (event.key === '+' || event.key === '=') zoom(1.25);
        else if (event.key === '-') zoom(1 / 1.25);
        else return;
        event.preventDefault();
    };
    container.addEventListener('keydown', keydown);
    const resize = new ResizeObserver(() => {
        stage.size({ width: container.clientWidth, height: container.clientHeight });
        if (fitted) fit(); else annotations();
    });
    resize.observe(container);
    return {
        setScene(next, { fitView = false } = {}) {
            scene = next; selected = null; onSelect(null);
            if (!scene) { Object.values(groups).forEach(group => group.destroyChildren()); labels.destroyChildren(); layer.batchDraw(); labels.batchDraw(); return; }
            renderNestingGeometry(Konva, groups, scene, { showPaths, onPlacement(group, piece) {
                group.on('click tap', event => { event.cancelBubble = true; selected = piece.id; onSelect(piece); annotations(); });
            } });
            if (fitView || fitted) fit(); else annotations();
            layer.batchDraw();
        },
        fit, zoom,
        setPaths(value) { showPaths = value; groups.cuts.visible(value); layer.batchDraw(); },
        setDimensions(value) { showDimensions = value; annotations(); },
        destroy() { resize.disconnect(); container.removeEventListener('keydown', keydown); stage.destroy(); }
    };
}
