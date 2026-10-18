import { renderNestingGeometry, shapeNode } from './nesting-renderer.js';
import { fitBounds, labelDetail, stationOrigin, RULER_SIZE } from '../plugins/cad/cad-view.js';
import * as cad from '../plugins/cad/cad-stage.js';
import { drawRulers } from '../plugins/cad/cad-rulers.js';
import { clearAllMeasurements, toggleMeasureTool } from '../plugins/cad/cad-measure.js';
import { bus } from '../core/event-bus.js';

/** Reusable read-only canvas; hosts own input editing and business actions. */
export function mountNestingViewer(container, { Konva = globalThis.Konva, onSelect = () => {}, onZoom = () => {} } = {}) {
    let scene = null, selected = null, showPaths = true, showDimensions = true, fitted = true;
    const getData = () => scene ? { rollW: scene.material.shape.width, bedL: scene.region.shape.height,
        windowStartY: scene.region.y, cutOrigin: scene.process.startCorner, trimStart: scene.process.trimStart } : null;
    const destroyStage = cad.initKonva({ container, Konva, getData, materialLabel: () => '材料' });
    const { stage, mainLayer: layer, annotationLayer: labels } = cad;
    const groups = { background: cad.fabricBgGroup, leftovers: cad.remnantGroup, placements: cad.pieceGroup,
        exclusions: cad.defectGroup, cuts: cad.cutGroup, boundary: cad.bedStationGroup };
    function annotations() {
        labels.destroyChildren();
        if (!scene) return;
        const scale = stage.scaleX(), pos = stage.position();
        labels.scale({ x: 1 / scale, y: 1 / scale });
        labels.position({ x: -pos.x / scale, y: -pos.y / scale });
        labels.clip({x:RULER_SIZE,y:RULER_SIZE,width:Math.max(0,stage.width()-RULER_SIZE),height:Math.max(0,stage.height()-RULER_SIZE)});
        const text = (value, x, y, width, options = {}) => labels.add(new Konva.Text({
            text: value, x, y, width, fontFamily: 'Consolas, Microsoft YaHei, sans-serif', fontSize: 12,
            fill: '#405567', align: 'center', wrap: 'none', ellipsis: true, ...options }));
        const { width, height } = scene.region.shape;
        if (showDimensions) {
            text(`${width} mm`, pos.x, pos.y - 26, width * scale);
            text(`${height} mm`, pos.x + width * scale + 10, pos.y + height * scale / 2, 86, { align: 'left' });
            const origin = stationOrigin(getData());
            text(`切割基准 ${origin.label} · X ${origin.x} / Y ${origin.y} mm`, pos.x, pos.y + height * scale + 16, Math.max(250, width * scale), { align: 'left', fontSize: 11 });
            const x = pos.x + origin.x * scale, y = pos.y + origin.y * scale;
            labels.add(new Konva.Line({points:[x+origin.dx*35,y,x,y,x,y+origin.dy*35],stroke:'#326e88',strokeWidth:1.5}));
            labels.add(new Konva.Circle({x,y,radius:3,fill:'#ffffff',stroke:'#326e88',strokeWidth:1.5}));
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
        const old = stage.scaleX(), next = Math.max(.002, Math.min(3, old * factor));
        fitted = false;
        const pos = stage.position();
        stage.scale({ x: next, y: next });
        stage.position({ x: pointer.x - (pointer.x - pos.x) * next / old, y: pointer.y - (pointer.y - pos.y) * next / old });
        annotations();
    }
    const subscriptions = [
        bus.on('stage:zoomed', () => { fitted = false; }),
        bus.on('stage:panned', () => { fitted = false; }),
        bus.on('stage:transformed', ({pointerX,pointerY}) => { annotations(); drawRulers(pointerX,pointerY); }),
        bus.on('cursor:moved', ({pointerX,pointerY}) => drawRulers(pointerX,pointerY)),
        bus.on('stage:mouseleave', () => { drawRulers(); document.getElementById('sb-cursor-pos').textContent = '指针 — · 单位 mm'; }),
        bus.on('stage:empty-clicked', () => { selected = null; onSelect(null); annotations(); }),
        bus.on('stage:resized', () => { if (fitted) fit(); else annotations(); drawRulers(); })
    ];
    const keydown = event => {
        if (event.key === '0') fit();
        else if (event.key === '+' || event.key === '=') zoom(1.25);
        else if (event.key === '-') zoom(1 / 1.25);
        else return;
        event.preventDefault();
    };
    container.addEventListener('keydown', keydown);
    return {
        setScene(next, { fitView = false } = {}) {
            clearAllMeasurements(); toggleMeasureTool(false);
            scene = next; selected = null; onSelect(null);
            document.getElementById('sb-cursor-pos').textContent = '指针 — · 单位 mm';
            if (!scene) { Object.values(groups).forEach(group => group.destroyChildren()); labels.destroyChildren(); layer.batchDraw(); labels.batchDraw(); drawRulers(); return; }
            renderNestingGeometry(Konva, groups, scene, { showPaths, onPlacement(group, piece) {
                group.on('click tap', event => { event.cancelBubble = true; selected = piece.id; onSelect(piece); annotations(); });
            } });
            if (fitView || fitted) fit(); else annotations();
            drawRulers();
            layer.batchDraw();
        },
        fit, zoom,
        setPaths(value) { showPaths = value; groups.cuts.visible(value); layer.batchDraw(); },
        setDimensions(value) { showDimensions = value; annotations(); },
        destroy() { toggleMeasureTool(false); subscriptions.forEach(unsubscribe => unsubscribe()); container.removeEventListener('keydown', keydown); destroyStage(); }
    };
}
