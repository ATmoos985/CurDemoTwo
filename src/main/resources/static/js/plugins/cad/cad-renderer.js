/** CAD 几何使用 mm；尺寸、文字和选择标记在独立屏幕图层绘制。 */
import {
    stage, mainLayer, annotationLayer, fabricBgGroup, defectGroup, remnantGroup,
    pieceGroup, cutGroup, bedStationGroup, invalidatePanSnapshot
} from './cad-stage.js';
import { drawRulers } from './cad-rulers.js';
import { fitBounds, gridIndex, labelDetail, spacedPoints, stationOrigin, stationCoordinates, RULER_SIZE, canvasView as view } from '../../canvas/cad-view.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';
import { makePieceInteractive, getSelectedPieceId } from './cad-interactive-nesting.js';
import { makeRemnantInteractive } from './cad-context-menu.js';
import { renderRemnantHighlight } from './cad-remnant-highlight.js';
import { createWorkspaceScene } from '../../business/cutting/workspace-scene.js';
import { renderNestingGeometry, setNestingCutStep } from '../../canvas/nesting-renderer.js';

let cutBadges = [];
let fitMode = 'station';
const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

// 标注节点常驻：固定标注按键、裁片/料头/刀序按数据对象复用，每次只改位置、文本和挂载顺序。
const TEXT = { fontSize: 12, fontFamily: 'Consolas, Microsoft YaHei, sans-serif', align: 'center', wrap: 'none', ellipsis: true };
const GRID_MM = 1000, NONE = [];
const fixedMarks = new Map(), itemMarks = new WeakMap();
const keep = (key, make) => fixedMarks.get(key) || fixedMarks.set(key, make()).get(key);
const marksOf = item => itemMarks.get(item) || itemMarks.set(item, {}).get(item);
let entities = new Map(), index = null, markGroup = null, shown = new Map(), viewKey = '', dragFrame = null;

export function renderScene() {
    if (!stage || !mainLayer) return;
    invalidatePanSnapshot();
    const data = state.getCurrentCaseData();
    const { scene, overlay } = createWorkspaceScene(data);
    const pieces = new Map((data.pieces || []).map(p => [p.id, p]));
    const remnants = new Map((data.remnants || []).map(r => [r.id, r]));
    entities = new Map();
    index = null;
    cutBadges = renderNestingGeometry(Konva, {
        background: fabricBgGroup, exclusions: defectGroup, leftovers: remnantGroup,
        placements: pieceGroup, cuts: cutGroup, boundary: bedStationGroup
    }, scene, {
        dark: isDark(), overlay, stepLimit: state.currentCutStepLimit, retainCutSteps: true,
        optimized: state.isToolpathOptimized, showPaths: view.paths, home: getHomeCoordinates(data),
        onPlacement: (group, p) => {
            if (!entities.has(p.id)) entities.set(p.id, group);
            makePieceInteractive(group, pieces.get(p.id), data);
        },
        onLeftover: (group, r) => makeRemnantInteractive(group, remnants.get(r.id), data)
    });
    updateCanvasAnnotations();
    mainLayer.batchDraw();
    drawRulers();
    updateStatusBar();
}

/** 演播仅改变刀线显隐与刀序标注，保持实体、交互状态和空间索引。 */
export function updateCutProgress() {
    if (!cutGroup) return;
    invalidatePanSnapshot();
    setNestingCutStep(cutGroup, state.currentCutStepLimit);
    updateCanvasAnnotations();
    mainLayer.batchDraw();
}

// 裁片可能正被拖动，位置以实体为准。
const entityAt = p => { const entity = entities.get(p.id); return entity ? { x: entity.x(), y: entity.y() } : p; };
// 与逐件绘制时相同的判定：屏幕矩形与标尺内可视区无交集即跳过。
const outside = (v, x, y, w, h) => x + w < RULER_SIZE || x > v.width || y + h < RULER_SIZE || y > v.height;

/** 视口裁剪网格：裁片按实体位置分桶；拖动、微调或旋转过的裁片记入 loose，每次直接精确判断。 */
function annotationIndex(data) {
    const pieces = data.pieces || NONE, remnants = data.remnants || NONE;
    if (index?.pieces === pieces && index.remnants === remnants
        && index.pieceCount === pieces.length && index.remnantCount === remnants.length) return index;
    const ids = new Map();
    pieces.forEach((p, i) => { if (!ids.has(p.id)) ids.set(p.id, i); });
    return index = {
        pieces, remnants, pieceCount: pieces.length, remnantCount: remnants.length, ids, loose: new Set(),
        pieceGrid: gridIndex(pieces.map(p => { const at = entityAt(p); return { x: at.x, y: at.y, w: p.w, h: p.l }; }), GRID_MM),
        remnantGrid: gridIndex(remnants.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.l })), GRID_MM)
    };
}

function viewContext(data, idx) {
    const scale = stage.scaleX(), pos = stage.position(), dark = isDark(), selectedId = getSelectedPieceId();
    return {
        data, scale, pos, dark, selectedId, selected: idx.pieces[idx.ids.get(selectedId)],
        width: stage.width(), height: stage.height(),
        ink: dark ? '#d2dce4' : '#405567', muted: dark ? '#97a9b9' : '#6b7e8d', paper: dark ? '#19232e' : '#ffffff',
        sx: x => pos.x + x * scale, sy: y => pos.y + y * scale
    };
}

/** 网格查视口（外扩 1 px 吸收浮点误差），并入 loose 后按数据顺序返回候选序号。 */
function candidates(grid, v, loose) {
    const pad = 1 / v.scale, left = (RULER_SIZE - v.pos.x) / v.scale, top = (RULER_SIZE - v.pos.y) / v.scale;
    const found = grid.query(left - pad, top - pad, (v.width - v.pos.x) / v.scale + pad, (v.height - v.pos.y) / v.scale + pad);
    return loose?.size ? [...new Set([...found, ...loose])].sort((a, b) => a - b) : found;
}

/** 居中单行标签。放得下时用自动宽度并平移到原居中位置，缩放只改坐标；放不下才交给 Konva 按宽度截断加省略号。 */
function placeLabel(node, text, x, y, width, fill) {
    text = String(text);
    if (node.text() !== text || node.fullWidth === undefined) {
        node.setAttrs({ text, width: 'auto' });
        node.fullWidth = text.includes('\n') ? Infinity : node.width();
    }
    const fits = node.fullWidth <= width;
    return node.setAttrs({ width: fits ? 'auto' : width, x: fits ? x + (width - node.fullWidth) / 2 : x, y, fill });
}

/** 单件裁片的标签、同需求虚线框和选中框，顺序同逐件绘制；不在视口内时为空。 */
function pieceMarks(p, v) {
    const at = entityAt(p), x = v.sx(at.x), y = v.sy(at.y), w = p.w * v.scale, h = p.l * v.scale;
    if (outside(v, x, y, w, h)) return NONE;
    const level = labelDetail(p.w, p.l, v.scale, view.overview), demand = v.selected?.demandId;
    const related = demand != null && p.demandId === demand && p.id !== v.selectedId, selected = p.id === v.selectedId;
    if (!level && !related && !selected) return NONE;
    const m = marksOf(p), out = [];
    if (level) out.push(placeLabel(m.name ||= new Konva.Text({ ...TEXT, fontStyle: 'bold' }),
        level === 2 ? (p.name || `#${p.id}`) : `#${p.id}`, x + 6, y + h / 2 - (level === 2 ? 16 : 6), w - 12, v.ink));
    if (level === 2) out.push(placeLabel(m.size ||= new Konva.Text({ ...TEXT, fontSize: 11 }),
        `${Number(p.w.toFixed(1))} × ${Number(p.l.toFixed(1))} mm${p.outcome === 'REJECTED' ? ' · 异常' : p.confirmed ? ' · 合格' : p.queued ? ' · 待报工' : ''}`, x + 6, y + h / 2 + 4, w - 12, v.muted));
    if (related) {
        m.related ||= new Konva.Rect({ name: 'demand-related', stroke: '#2d7899', strokeWidth: 1.5, dash: [5, 3], listening: false });
        out.push(m.related.setAttrs({ x, y, width: w, height: h }));
    }
    if (selected) {
        m.selection ||= [new Konva.Rect({ stroke: '#2d7899', strokeWidth: 2 }),
            ...[0, 1, 2, 3].map(() => new Konva.Rect({ width: 6, height: 6, stroke: '#2d7899', strokeWidth: 1 }))];
        const [frame, ...handles] = m.selection;
        frame.setAttrs({ x, y, width: w, height: h });
        [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy], k) => handles[k].setAttrs({ x: cx - 3, y: cy - 3, fill: v.paper }));
        out.push(...m.selection);
    }
    return out;
}

function remnantMarks(r, v) {
    const x = v.sx(r.x), y = v.sy(r.y), w = r.w * v.scale, h = r.l * v.scale;
    const level = labelDetail(r.w, r.l, v.scale, view.overview);
    if (!level || outside(v, x, y, w, h)) return NONE;
    const m = marksOf(r), out = [placeLabel(m.name ||= new Konva.Text({ ...TEXT }),
        state.currentCutMode === 'remnant' && !r.confirmed ? '余料 · 不回收' : r.hasDefect ? '带疵料头' : '可用料头', x + 6, y + h / 2 - (level === 2 ? 16 : 6), w - 12, v.muted)];
    if (level === 2) out.push(placeLabel(m.size ||= new Konva.Text({ ...TEXT, fontSize: 11 }),
        `${Number(r.w.toFixed(1))} × ${Number(r.l.toFixed(1))} mm${r.queued ? ' · 待报工' : r.confirmed ? ' · 已报工' : ''}`, x + 6, y + h / 2 + 4, w - 12, v.muted));
    return out;
}

function marksLayerGroup() {
    if (markGroup?.getLayer() !== annotationLayer) {
        markGroup = new Konva.Group();
        annotationLayer.add(markGroup);
        markGroup.moveToBottom();   // 料头提示牌由 renderRemnantHighlight 追加在其上
    }
    return markGroup;
}

/** 子节点已是目标序列时不动，否则按序换挂；只涉及视口内的节点。 */
function attach(group, nodes) {
    const children = group.getChildren();
    if (children.length === nodes.length && nodes.every((node, i) => node === children[i])) return;
    group.removeChildren();
    if (nodes.length) group.add(...nodes);
}

// 视口每次变化都会走到这里，文字不变时不写 DOM。
const setText = (id, text) => { const el = document.getElementById(id); if (el.textContent !== text) el.textContent = text; };

export function updateCanvasAnnotations() {
    if (!stage || !annotationLayer) return;
    const data = state.getCurrentCaseData(), idx = annotationIndex(data), v = viewContext(data, idx), list = [];
    const { scale, pos } = v;
    viewKey = viewSignature();
    // 抵消父舞台变换，以下坐标均为屏幕像素；实体坐标从不改写。
    annotationLayer.scale({ x: 1 / scale, y: 1 / scale });
    annotationLayer.position({ x: -pos.x / scale, y: -pos.y / scale });
    annotationLayer.clip({ x: RULER_SIZE, y: RULER_SIZE, width: Math.max(0, stage.width() - RULER_SIZE), height: Math.max(0, stage.height() - RULER_SIZE) });
    const line = (key, points, color = v.muted, width = 1) => list.push(keep(key, () => new Konva.Line()).setAttrs({ points, stroke: color, strokeWidth: width }));
    const label = (key, text, x, y, width, fill) => list.push(placeLabel(keep(key, () => new Konva.Text({ ...TEXT, fontSize: 11 })), text, x, y, width, fill));
    const dimension = (key, a, b, offset, value, vertical = false) => {
        if (Math.abs(b - a) < 44) return;
        line(`${key}-line`, vertical ? [offset, a, offset, b] : [a, offset, b, offset]);
        [a, b].forEach((t, k) => line(`${key}-tick-${k}`, vertical ? [offset - 4, t + 4, offset + 4, t - 4] : [t - 4, offset + 4, t + 4, offset - 4]));
        const text = keep(`${key}-text`, () => new Konva.Text({ fontSize: 12, rotation: vertical ? -90 : 0,
            fontFamily: vertical ? 'Consolas, sans-serif' : 'Consolas, Microsoft YaHei, sans-serif' }));
        text.setAttrs({ text: value, fill: v.ink });
        list.push(text.position(vertical ? { x: offset - 17, y: (a + b) / 2 + text.width() / 2 } : { x: (a + b - text.width()) / 2, y: offset - 19 }));
    };
    const start = data.windowStartY || 0, end = start + data.bedL;
    const x0 = v.sx(0), x1 = v.sx(data.rollW), y0 = v.sy(start), y1 = v.sy(end);
    const detailed = !view.overview && data.rollW * scale >= 80 && data.bedL * scale >= 110;
    if (view.dimensions && detailed) {
        line('width-ext-0', [x0, y0 - 6, x0, y0 - 34]); line('width-ext-1', [x1, y0 - 6, x1, y0 - 34]);
        dimension('width', x0, x1, y0 - 28, `幅宽 ${data.rollW} mm`);
        line('length-ext-0', [x0 - 6, y0, x0 - 32, y0]); line('length-ext-1', [x0 - 6, y1, x0 - 32, y1]);
        dimension('length', y0, y1, x0 - 26, `${data.bedL} mm`, true);
        label('station', `当前工位 · 全卷 ${start}–${end} mm`, x0, y1 + 14, Math.max(80, x1 - x0), v.muted);
    }
    const origin = stationOrigin(data);
    const ox = v.sx(origin.x), oy = v.sy(origin.y);
    if (detailed) {
        const color = v.dark ? '#8fc2d7' : '#326e88';
        line('origin-x', [ox, oy, ox + origin.dx * 38, oy], color, 1.5);
        line('origin-y', [ox, oy, ox, oy + origin.dy * 38], color, 1.5);
        list.push(keep('origin', () => new Konva.Circle({ radius: 3, strokeWidth: 1.5 })).setAttrs({ x: ox, y: oy, fill: v.paper, stroke: color }));
        label('origin-x-text', 'X', ox + origin.dx * 47 - 6, oy - 6, 12, color);
        label('origin-y-text', 'Y', ox - 6, oy + origin.dy * 47 - 6, 12, color);
    }
    shown = new Map();
    // 全卷总览不画裁片标签，只剩选中件与同需求件的框。
    if (!view.overview || v.selected) for (const i of candidates(idx.pieceGrid, v, idx.loose)) {
        const marks = pieceMarks(idx.pieces[i], v);
        if (marks.length) { shown.set(i, marks); list.push(...marks); }
    }
    if (!view.overview) for (const i of candidates(idx.remnantGrid, v)) list.push(...remnantMarks(idx.remnants[i], v));
    if (detailed && view.paths) {
        const visible = [];
        const contour = data.pieces?.some(p => p.shape);
        for (const c of cutBadges) {
            if (c.step > state.currentCutStepLimit) continue;
            // A garment has many short edges; show the active edge number while keeping every cut line visible.
            if (contour && c.step !== state.currentCutStepLimit) continue;
            const x = v.sx(c.x), y = v.sy(c.y);
            if (x < RULER_SIZE || y < RULER_SIZE || x > v.width || y > v.height) continue;
            visible.push({ x, y, c });
        }
        // 刀序标记按顺序贪心避让 25 px，网格只查相邻格。
        for (const { x, y, c } of spacedPoints(visible, 25)) {
            const m = marksOf(c);
            list.push((m.badge ||= new Konva.Circle({ radius: 9, stroke: '#b96070', strokeWidth: 1 })).setAttrs({ x, y, fill: v.paper }),
                placeLabel(m.step ||= new Konva.Text({ ...TEXT, fontSize: 10 }), c.step, x - 8, y - 5, 16, '#a24a5c'));
            if (!state.isToolpathOptimized) continue;
            const mx = v.sx((c.x + c.x2) / 2), my = v.sy((c.y + c.y2) / 2);
            list.push((m.arrow ||= new Konva.Arrow({ stroke: '#a24a5c', fill: '#a24a5c', strokeWidth: 1, pointerLength: 4, pointerWidth: 4 }))
                .points([mx, my, mx + Math.sign(c.x2 - c.x) * 12, my + Math.sign(c.y2 - c.y) * 12]));
        }
    }
    attach(marksLayerGroup(), list);
    const selected = v.selected;
    const panel = document.getElementById('cad-selection');
    if (panel) {
        if (panel.hidden !== !selected) panel.hidden = !selected;
        if (selected) {
            const local = stationCoordinates(selected.x + (origin.dx < 0 ? selected.w : 0), selected.y + (origin.dy < 0 ? selected.l : 0), data);
            setText('cad-selection-name', selected.name || `裁片 ${selected.id}`);
            setText('cad-selection-size', `${Number(selected.w.toFixed(1))} × ${Number(selected.l.toFixed(1))} mm`);
            setText('cad-selection-position', `距原点 X ${local.x} · Y ${local.y} mm`);
            setText('cad-selection-state', selected.confirmed ? '已实切 · 锁定' : selected.queued ? '已记录 · 待报工' : '方向键微调 · R 旋转');
        }
    }
    renderRemnantHighlight();
    annotationLayer.batchDraw();
}

/** 拖拽中每帧只更新被拖裁片（即选中件）的标签和选中框；视口已变或节点增减（进出视口）时整层更新。 */
function updateDraggedPiece() {
    dragFrame = null;
    if (!stage || !annotationLayer) return;
    // 本回调与实体同帧直接绘制，属性更新不再安排下一帧重复提交同一张画布。
    const autoDraw = Konva.autoDrawEnabled;
    Konva.autoDrawEnabled = false;
    try { drawDraggedPiece(); }
    finally { Konva.autoDrawEnabled = autoDraw; }
}

function drawDraggedPiece() {
    const data = state.getCurrentCaseData(), idx = annotationIndex(data), i = idx.ids.get(getSelectedPieceId());
    if (i === undefined || viewSignature() !== viewKey) return updateCanvasAnnotations();
    const before = shown.get(i) || NONE, now = pieceMarks(idx.pieces[i], viewContext(data, idx));
    if (now.length !== before.length || now.some((node, k) => node !== before[k])) return updateCanvasAnnotations();
    annotationLayer.draw();   // 与裁片几何同一帧落屏
}

export function setCanvasLayer(name, enabled) {
    if (!['dimensions', 'paths'].includes(name)) return;
    invalidatePanSnapshot();
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
export function focusCurrentLayout() {
    const data=state.getCurrentCaseData(), start=data.windowStartY || 0;
    const pieces=(data.pieces || []).filter(p=>!p.confirmed && !p.queued && p.y>=start && p.y<start+data.bedL);
    if(pieces.length)frameBounds({x:0,y:start,width:data.rollW,height:Math.max(...pieces.map(p=>p.y+p.l))-start}, 'layout');
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
    if (label) label.innerText = data.materialAvailable === false ? '切割基准 —'
        : `切割基准 ${origin.label} · ${sheet ? '料头' : '母卷'} X ${origin.x.toLocaleString()} / Y ${origin.y.toLocaleString()} mm`;
}
// 适配视图已同步更新过标注时，跳过后续属性变更通知。
const viewSignature = () => `${stage.scaleX()} ${stage.x()} ${stage.y()} ${stage.width()} ${stage.height()}`;
const updateView = () => { if (stage && viewSignature() !== viewKey) updateCanvasAnnotations(); };
for (const event of ['stage:transformed', 'stage:resized']) bus.on(event, updateView);
for (const event of ['station:moved', 'piece:selected', 'stage:empty-clicked', 'remnant:selected']) bus.on(event, updateCanvasAnnotations);
// 实体或尺寸已偏离网格的裁片记入 loose；拖拽时立即登记，标注按帧更新。
const markMoved = id => { const i = index?.ids.get(id); if (i !== undefined) index.loose.add(i); };
bus.on('piece:dragging', () => { markMoved(getSelectedPieceId()); dragFrame ||= requestAnimationFrame(updateDraggedPiece); });
bus.on('piece:moved', ({ pieceId } = {}) => markMoved(pieceId));
bus.on('stage:zoomed', () => { fitMode = null; view.overview = false; });
bus.on('stage:panned', () => { fitMode = null; });
bus.on('stage:resized', () => {
    if (fitMode === 'station') resetToBedView();
    else if (fitMode === 'full') viewFullRoll();
    else if (fitMode === 'flow') resetToFlowView();
    else if (fitMode === 'layout') focusCurrentLayout();
});
for (const event of ['case:changed', 'mode:changed']) bus.on(event, () => { view.overview = false; });
