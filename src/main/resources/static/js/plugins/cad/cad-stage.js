/**
 * CAD 视口与 Konva 舞台管理插件 (CAD Stage Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { state } from '../../core/state.js';
import { stationCoordinates, viewRect, createViewCull, fitBounds, wheelScale, canvasView } from '../../canvas/cad-view.js';
import { deferHitGraph } from '../../canvas/cad-hit-graph.js';
import { cacheOverviewPan } from '../../canvas/cad-pan-snapshot.js';

// 视口裁剪外扩的屏幕像素，覆盖不随缩放的描边和斜接角。
const CULL_MARGIN = 32;

export let stage, backgroundLayer, mainLayer, interactionLayer, annotationLayer;
export let fabricBgGroup, gridGroup, defectGroup, remnantGroup, pieceGroup, cutGroup, remnantHighlightGroup;
export let bedStationGroup;
export let invalidatePanSnapshot = () => {};
let dataSource = () => state.getCurrentCaseData();
export const getCanvasData = () => dataSource();

export function initKonva({ container = document.getElementById('konva-container'),
    getData = () => state.getCurrentCaseData(), materialLabel = () => state.currentCutMode === 'remnant' ? '料头' : '母卷',
    Konva = globalThis.Konva } = {}) {
    if (!container) return;
    dataSource = getData;
    const width = container.clientWidth;
    const height = container.clientHeight;

    stage = new Konva.Stage({
        container,
        width: width,
        height: height,
        draggable: true
    });

    // 按更新频率分层，自下而上：
    // backgroundLayer  布面与网格，只随方案重建，不做命中检测；
    // mainLayer        料头、裁片、疵点和刀线，承载点选与拖拽，绘制前按视口裁剪；
    // interactionLayer 料头高亮、工位框、测量、碰撞提示等临时图形，变化时不重绘实体；
    // annotationLayer  屏幕像素标注。
    backgroundLayer = new Konva.Layer({ listening: false });
    mainLayer = new Konva.Layer();
    deferHitGraph(mainLayer);
    interactionLayer = new Konva.Layer();
    annotationLayer = new Konva.Layer({ listening: false });
    stage.add(backgroundLayer, mainLayer, interactionLayer, annotationLayer);
    // 测量、标记疵点时实体层停止响应，交互层的碰撞提示和刀头随之让行，与原先同层时一致。
    mainLayer.on('listeningChange', () => interactionLayer.listening(mainLayer.listening()));

    // 所有视口入口（滚轮、适配、料头定位动画）共用一次标注更新。
    let viewFrame = null;
    const notifyView = (payload = {}) => {
        if (viewFrame !== null) cancelAnimationFrame(viewFrame);
        viewFrame = null;
        bus.emit('stage:transformed', payload);
    };
    stage.on('xChange yChange scaleXChange scaleYChange', () => {
        if (viewFrame !== null) return;
        viewFrame = requestAnimationFrame(() => {
            viewFrame = null;
            notifyView();
        });
    });

    // 随滑块上下贯穿滚动的长布料；绘制顺序与合层时相同。
    fabricBgGroup = new Konva.Group();
    gridGroup = fabricBgGroup;
    defectGroup = new Konva.Group();
    remnantGroup = new Konva.Group();
    pieceGroup = new Konva.Group();
    cutGroup = new Konva.Group();
    remnantHighlightGroup = new Konva.Group({ name: "remnant-highlight-group" });
    // 固定裁切工位；几何边界保留真实尺寸。
    bedStationGroup = new Konva.Group();

    backgroundLayer.add(fabricBgGroup);
    mainLayer.add(remnantGroup, pieceGroup, defectGroup, cutGroup);
    interactionLayer.add(remnantHighlightGroup, bedStationGroup);

    // 工位视图通常只露出几十件裁片：视口外的实体不画场景，也不进命中图。
    const cull = createViewCull(), entities = [remnantGroup, pieceGroup, defectGroup, cutGroup];
    mainLayer.on('beforeDraw', () => {
        const view = viewRect(stage.width(), stage.height(), stage.x(), stage.y(), stage.scaleX(), CULL_MARGIN);
        const autoDraw = Konva.autoDrawEnabled;
        Konva.autoDrawEnabled = false;   // 绘制途中切换显隐，不另排一帧
        try { for (const group of entities) cull(group.children, view); }
        finally { Konva.autoDrawEnabled = autoDraw; }
    });
    invalidatePanSnapshot = cacheOverviewPan(mainLayer, stage, () => canvasView.overview);

    // 鼠标滚轮平滑缩放与上下漫游
    stage.on("wheel", (e) => {
        e.evt.preventDefault();
        const oldScale = stage.scaleX();
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const mousePointTo = {
            x: (pointer.x - stage.x()) / oldScale,
            y: (pointer.y - stage.y()) / oldScale,
        };

        const data = getCanvasData() || {};
        const fullScale = fitBounds(stage.width(), stage.height(), {
            x: 0, y: 0, width: data.rollW || 2000, height: data.totalRollL || 60000
        }).scale;
        const newScale = wheelScale(oldScale, e.evt.deltaY, fullScale);
        if (newScale === oldScale) return;
        const newPos = {
            x: pointer.x - mousePointTo.x * newScale,
            y: pointer.y - mousePointTo.y * newScale,
        };
        // setAttrs 批量提交变换，仅清理一次所有后代的绝对变换缓存。
        stage.setAttrs({ scaleX: newScale, scaleY: newScale, ...newPos });
        bus.emit('stage:zoomed');
        notifyView({ pointerX: pointer.x, pointerY: pointer.y });
    });

    // 移动与平移
    stage.on('dragstart', e => { if (e.target === stage) bus.emit('stage:panned'); });
    stage.on("dragmove", e => {
        if (e.target !== stage) return;
        const pointer = stage.getPointerPosition();
        notifyView(pointer ? { pointerX: pointer.x, pointerY: pointer.y } : {});
    });

    // 点击空白处通知去选；背景层不做命中检测，点在布面上时目标就是舞台。
    stage.on("click", (e) => {
        if (e.target === stage || e.target.parent === stage) {
            bus.emit('stage:empty-clicked');
        }
    });

    stage.on("mousemove", (e) => {
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const scale = stage.scaleX();
        const worldX = Math.round((pointer.x - stage.x()) / scale);
        const worldY = Math.round((pointer.y - stage.y()) / scale);
        const data = getCanvasData();
        if (!data) return;
        const local = stationCoordinates(worldX, worldY, data);
        const cursorText = `指针 X ${local.x} · Y ${local.y} mm  |  ${materialLabel()} Y ${worldY} mm`;
        const sbCursor = document.getElementById("sb-cursor-pos");
        if (sbCursor) sbCursor.innerText = cursorText;

        bus.emit('cursor:moved', { pointerX: pointer.x, pointerY: pointer.y, worldX, worldY });
    });

    stage.on("mouseleave", () => {
        bus.emit('stage:mouseleave');
    });

    window.addEventListener('resize', handleStageResize);
    const unsubscribeResize = bus.on('viewport:resized', handleStageResize);
    let resize;
    if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(handleStageResize);
        resize.observe(container);
    }
    return () => {
        resize?.disconnect(); unsubscribeResize();
        window.removeEventListener('resize', handleStageResize);
        if (viewFrame !== null) cancelAnimationFrame(viewFrame);
        stage.destroy();
    };
}

export function handleStageResize() {
    const container = stage?.container();
    if (stage && container) {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        bus.emit('stage:resized');
    }
}
