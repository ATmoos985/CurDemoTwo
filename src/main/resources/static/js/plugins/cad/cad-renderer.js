/** CAD 几何使用 mm；尺寸、文字和选择标记在独立屏幕图层绘制。 */
import {
    stage, mainLayer, annotationLayer, fabricBgGroup, defectGroup, remnantGroup,
    pieceGroup, cutGroup, bedStationGroup
} from './cad-stage.js';
import { drawRulers } from './cad-rulers.js';
import { fitBounds, labelDetail, stationOrigin, stationCoordinates, RULER_SIZE, canvasView as view } from './cad-view.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';
import { makePieceInteractive, getSelectedPieceId } from './cad-interactive-nesting.js';
import { makeRemnantInteractive } from './cad-context-menu.js';
import { renderRemnantHighlight } from './cad-remnant-highlight.js';
import { createWorkspaceScene } from './workspace-scene.js';
import { renderNestingGeometry } from '../../nesting/nesting-renderer.js';

let cutBadges = [];
let fitMode = 'station';
const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

export function renderScene() {
    if (!stage || !mainLayer) return;
    const data = state.getCurrentCaseData();
    const { scene, overlay } = createWorkspaceScene(data);
    const pieces = new Map((data.pieces || []).map(p => [p.id, p]));
    const remnants = new Map((data.remnants || []).map(r => [r.id, r]));
    cutBadges = renderNestingGeometry(Konva, {
        background: fabricBgGroup, exclusions: defectGroup, leftovers: remnantGroup,
        placements: pieceGroup, cuts: cutGroup, boundary: bedStationGroup
    }, scene, {
        dark: isDark(), overlay, stepLimit: state.currentCutStepLimit,
        optimized: state.isToolpathOptimized, showPaths: view.paths, home: getHomeCoordinates(data),
        onPlacement: (group, p) => makePieceInteractive(group, pieces.get(p.id), data),
        onLeftover: (group, r) => makeRemnantInteractive(group, remnants.get(r.id), data)
    });
    updateCanvasAnnotations();
    mainLayer.batchDraw();
    drawRulers();
    updateStatusBar();
}

export function updateCanvasAnnotations() {
    if (!stage || !annotationLayer) return;
    annotationLayer.destroyChildren();
    const scale = stage.scaleX(), pos = stage.position();
    // 抵消父舞台变换，以下坐标均为屏幕像素；实体坐标从不改写。
    annotationLayer.scale({ x: 1 / scale, y: 1 / scale });
    annotationLayer.position({ x: -pos.x / scale, y: -pos.y / scale });
    annotationLayer.clip({ x: RULER_SIZE, y: RULER_SIZE, width: Math.max(0, stage.width() - RULER_SIZE), height: Math.max(0, stage.height() - RULER_SIZE) });
    const data = state.getCurrentCaseData(), dark = isDark();
    const ink = dark ? '#d2dce4' : '#405567', muted = dark ? '#97a9b9' : '#6b7e8d';
    const paper = dark ? '#19232e' : '#ffffff';
    const sx = x => pos.x + x * scale, sy = y => pos.y + y * scale;
    const line = (points, color = muted, width = 1) => annotationLayer.add(new Konva.Line({ points, stroke: color, strokeWidth: width }));
    const label = (text, x, y, width, options = {}) => {
        const node = new Konva.Text({ text: String(text), x, y, width, fontSize: 12, fontFamily: 'Consolas, Microsoft YaHei, sans-serif',
            fill: ink, align: 'center', wrap: 'none', ellipsis: true, ...options });
        annotationLayer.add(node);
        return node;
    };
    const dimension = (a, b, offset, value, vertical = false) => {
        if (Math.abs(b - a) < 44) return;
        if (vertical) {
            line([offset, a, offset, b]);
            for (const y of [a, b]) line([offset - 4, y + 4, offset + 4, y - 4]);
            const text = new Konva.Text({ text: value, fontSize: 12, fontFamily: 'Consolas, sans-serif', fill: ink });
            text.position({ x: offset - 17, y: (a + b) / 2 + text.width() / 2 });
            text.rotation(-90);
            annotationLayer.add(text);
        } else {
            line([a, offset, b, offset]);
            for (const x of [a, b]) line([x - 4, offset + 4, x + 4, offset - 4]);
            const text = new Konva.Text({ text: value, fontSize: 12, fontFamily: 'Consolas, Microsoft YaHei, sans-serif', fill: ink });
            text.position({ x: (a + b - text.width()) / 2, y: offset - 19 });
            annotationLayer.add(text);
        }
    };
    const start = data.windowStartY || 0, end = start + data.bedL;
    const x0 = sx(0), x1 = sx(data.rollW), y0 = sy(start), y1 = sy(end);
    const detailed = !view.overview && data.rollW * scale >= 80 && data.bedL * scale >= 110;
    if (view.dimensions && detailed) {
        line([x0, y0 - 6, x0, y0 - 34]); line([x1, y0 - 6, x1, y0 - 34]);
        dimension(x0, x1, y0 - 28, `幅宽 ${data.rollW} mm`);
        line([x0 - 6, y0, x0 - 32, y0]); line([x0 - 6, y1, x0 - 32, y1]);
        dimension(y0, y1, x0 - 26, `${data.bedL} mm`, true);
        label(`当前工位 · 全卷 ${start}–${end} mm`, x0, y1 + 14, Math.max(80, x1 - x0), { fill: muted, fontSize: 11 });
    }
    const origin = stationOrigin(data);
    const ox = sx(origin.x), oy = sy(origin.y);
    if (detailed) {
        const color = dark ? '#8fc2d7' : '#326e88';
        line([ox, oy, ox + origin.dx * 38, oy], color, 1.5);
        line([ox, oy, ox, oy + origin.dy * 38], color, 1.5);
        annotationLayer.add(new Konva.Circle({ x: ox, y: oy, radius: 3, fill: paper, stroke: color, strokeWidth: 1.5 }));
        label('X', ox + origin.dx * 47 - 6, oy - 6, 12, { fill: color, fontSize: 11 });
        label('Y', ox - 6, oy + origin.dy * 47 - 6, 12, { fill: color, fontSize: 11 });
    }
    const selectedId = getSelectedPieceId();
    const selectedDemand = (data.pieces || []).find(p => p.id === selectedId)?.demandId;
    for (const p of data.pieces || []) {
        const entity = pieceGroup.findOne(`.piece-entity-${p.id}`);
        const x = sx(entity ? entity.x() : p.x), y = sy(entity ? entity.y() : p.y);
        const w = p.w * scale, h = p.l * scale;
        const level = labelDetail(p.w, p.l, scale, view.overview);
        if (x + w < RULER_SIZE || x > stage.width() || y + h < RULER_SIZE || y > stage.height()) continue;
        if (level) label(level === 2 ? (p.name || `#${p.id}`) : `#${p.id}`, x + 6, y + h / 2 - (level === 2 ? 16 : 6), w - 12, { fontStyle: 'bold' });
        if (level === 2) label(`${p.w} × ${p.l} mm${p.outcome === 'REJECTED' ? ' · 异常' : p.confirmed ? ' · 合格' : ''}`, x + 6, y + h / 2 + 4, w - 12, { fontSize: 11, fill: muted });
        if (selectedDemand != null && p.demandId === selectedDemand && p.id !== selectedId) {
            annotationLayer.add(new Konva.Rect({name:'demand-related',x,y,width:w,height:h,stroke:'#2d7899',strokeWidth:1.5,dash:[5,3],listening:false}));
        }
        if (p.id === selectedId) {
            annotationLayer.add(new Konva.Rect({ x, y, width: w, height: h, stroke: '#2d7899', strokeWidth: 2 }));
            for (const [cx, cy] of [[x,y], [x+w,y], [x,y+h], [x+w,y+h]]) annotationLayer.add(new Konva.Rect({ x: cx-3, y: cy-3, width: 6, height: 6, fill: paper, stroke: '#2d7899', strokeWidth: 1 }));
        }
    }
    for (const r of data.remnants || []) {
        const level = labelDetail(r.w, r.l, scale, view.overview);
        if (!level) continue;
        const w = r.w * scale, h = r.l * scale;
        label(state.currentCutMode === 'remnant' && !r.confirmed ? '余料 · 不回收' : r.hasDefect ? '带疵料头' : '可用料头', sx(r.x) + 6, sy(r.y) + h / 2 - (level === 2 ? 16 : 6), w - 12, { fill: muted });
        if (level === 2) label(`${r.w} × ${r.l} mm`, sx(r.x) + 6, sy(r.y) + h / 2 + 4, w - 12, { fill: muted, fontSize: 11 });
    }
    if (detailed && view.paths) {
        // ponytail: 当前工位少量刀序直接检查邻近；上千刀时改为空间分桶。
        const occupied = [];
        for (const c of cutBadges) {
            const x = sx(c.x), y = sy(c.y);
            if (x < RULER_SIZE || y < RULER_SIZE || x > stage.width() || y > stage.height()) continue;
            if (occupied.some(point => Math.hypot(x - point.x, y - point.y) < 25)) continue;
            occupied.push({ x, y });
            annotationLayer.add(new Konva.Circle({ x, y, radius: 9, fill: paper, stroke: '#b96070', strokeWidth: 1 }));
            label(c.step, x - 8, y - 5, 16, { fontSize: 10, fill: '#a24a5c' });
            if (state.isToolpathOptimized) annotationLayer.add(new Konva.Arrow({
                points: [sx((c.x+c.x2)/2), sy((c.y+c.y2)/2), sx((c.x+c.x2)/2) + Math.sign(c.x2-c.x)*12, sy((c.y+c.y2)/2) + Math.sign(c.y2-c.y)*12],
                stroke: '#a24a5c', fill: '#a24a5c', strokeWidth: 1, pointerLength: 4, pointerWidth: 4
            }));
        }
    }
    const selected = (data.pieces || []).find(p => p.id === selectedId);
    const panel = document.getElementById('cad-selection');
    if (panel) {
        panel.hidden = !selected;
        if (selected) {
            const local = stationCoordinates(selected.x + (origin.dx < 0 ? selected.w : 0), selected.y + (origin.dy < 0 ? selected.l : 0), data);
            document.getElementById('cad-selection-name').textContent = selected.name || `裁片 ${selected.id}`;
            document.getElementById('cad-selection-size').textContent = `${selected.w} × ${selected.l} mm`;
            document.getElementById('cad-selection-position').textContent = `距原点 X ${local.x} · Y ${local.y} mm`;
            document.getElementById('cad-selection-state').textContent = selected.confirmed ? '已实切 · 锁定' : '方向键微调 · R 旋转';
        }
    }
    const caption = document.getElementById('cad-view-caption');
    if (caption) caption.textContent = view.overview ? '全卷坐标 · mm' : `${origin.label}起刀原点 · mm${data.trimStart ? ` · 修齐 ${data.trimStart}` : ''}`;
    renderRemnantHighlight();
    annotationLayer.batchDraw();
}

export function setCanvasLayer(name, enabled) {
    if (!['dimensions', 'paths'].includes(name)) return;
    view[name] = !!enabled;
    if (cutGroup) { cutGroup.visible(view.paths); mainLayer.batchDraw(); }
    updateCanvasAnnotations();
}

function frameBounds(bounds, mode = 'station') {
    if (!stage) return;
    fitMode = mode;
    view.overview = mode === 'full';
    const fit = fitBounds(stage.width(), stage.height(), bounds);
    stage.scale({ x: fit.scale, y: fit.scale });
    stage.position({ x: fit.x, y: fit.y });
    updateCanvasAnnotations();
    drawRulers();
    updateStatusBar();
    if (mainLayer) mainLayer.batchDraw();
}
export function focusPiece(id) {
    const piece = (state.getCurrentCaseData().pieces || []).find(p => p.id === id);
    if (piece) frameBounds({x:piece.x-120,y:piece.y-120,width:piece.w+240,height:piece.l+240}, 'piece');
}
export function resetToBedView() {
    const data = state.getCurrentCaseData();
    frameBounds({ x: 0, y: data.windowStartY || 0, width: data.rollW || 2000, height: data.bedL || 5000 });
}
export function resetToFlowView() {
    const data = state.getCurrentCaseData();
    frameBounds({ x: 0, y: data.windowStartY || 0, width: data.rollW || 2000,
        height: Math.min((data.bedL || 5000) + 8000, (data.totalRollL || 60000) - (data.windowStartY || 0)) }, 'flow');
}
export function viewFullRoll() {
    const data = state.getCurrentCaseData();
    frameBounds({ x: 0, y: 0, width: data.rollW || 2000, height: data.totalRollL || 60000 }, 'full');
}
export function fitView() { resetToBedView(); }
export function resetZoom() { zoomCanvas(.25 / (stage?.scaleX() || .25)); }
export function zoomCanvas(factor) {
    if (!stage) return;
    fitMode = null;
    view.overview = false;
    const old = stage.scaleX(), next = Math.max(.002, Math.min(3, old * factor));
    const x = stage.width() / 2, y = stage.height() / 2;
    const pos = stage.position();
    stage.scale({ x: next, y: next });
    stage.position({ x: x - (x - pos.x) * next / old, y: y - (y - pos.y) * next / old });
}
export function updateStatusBar() {
    if (!stage) return;
    for (const id of ['sb-scale', 'cad-scale']) {
        const el = document.getElementById(id);
        if (el) el.innerText = `${(stage.scaleX() * 100).toFixed(1)}%`;
    }
    const data = state.getCurrentCaseData();
    const label = document.getElementById('sb-origin-lbl');
    const origin = stationOrigin(data), sheet = state.currentCutMode === 'remnant';
    const source = document.getElementById('sb-source-label');
    if (source) source.textContent = sheet ? '来源母卷' : '当前母卷';
    if (label) label.innerText = data.materialAvailable === false ? '切割基准 —'
        : `切割基准 ${origin.label} · ${sheet ? '料头' : '母卷'} X ${origin.x.toLocaleString()} / Y ${origin.y.toLocaleString()} mm`;
}
for (const event of ['stage:transformed', 'stage:resized', 'station:moved', 'piece:selected', 'piece:dragging', 'stage:empty-clicked', 'remnant:selected']) bus.on(event, updateCanvasAnnotations);
bus.on('stage:zoomed', () => { fitMode = null; view.overview = false; });
bus.on('stage:panned', () => { fitMode = null; });
bus.on('stage:resized', () => {
    if (fitMode === 'station') resetToBedView();
    else if (fitMode === 'full') viewFullRoll();
    else if (fitMode === 'flow') resetToFlowView();
});
for (const event of ['case:changed', 'mode:changed']) bus.on(event, () => { view.overview = false; });
