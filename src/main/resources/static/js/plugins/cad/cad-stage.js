/**
 * CAD 视口与 Konva 舞台管理插件 (CAD Stage Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { state } from '../../core/state.js';
import { stationCoordinates } from './cad-view.js';

export let stage, mainLayer, annotationLayer;
export let fabricScrollGroup, fabricBgGroup, gridGroup, defectGroup, remnantGroup, pieceGroup, cutGroup, remnantHighlightGroup;
export let bedStationGroup;

export function initKonva() {
    const container = document.getElementById("konva-container");
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;

    stage = new Konva.Stage({
        container: "konva-container",
        width: width,
        height: height,
        draggable: true
    });

    mainLayer = new Konva.Layer();
    stage.add(mainLayer);
    annotationLayer = new Konva.Layer({ listening: false });
    stage.add(annotationLayer);

    // 所有视口入口（滚轮、适配、料头定位动画）共用一次标注更新。
    let viewFrame = null;
    stage.on('xChange yChange scaleXChange scaleYChange', () => {
        if (viewFrame !== null) return;
        viewFrame = requestAnimationFrame(() => {
            viewFrame = null;
            bus.emit('stage:transformed', {});
        });
    });

    // 1. 随滑块上下贯穿滚动的长布料组 (Fabric Continuous Roll)
    fabricScrollGroup = new Konva.Group();
    mainLayer.add(fabricScrollGroup);

    fabricBgGroup = new Konva.Group();
    gridGroup = fabricBgGroup;
    defectGroup = new Konva.Group();
    remnantGroup = new Konva.Group();
    pieceGroup = new Konva.Group();
    cutGroup = new Konva.Group();
    remnantHighlightGroup = new Konva.Group({ name: "remnant-highlight-group" });

    fabricScrollGroup.add(fabricBgGroup);
    fabricScrollGroup.add(remnantGroup);
    fabricScrollGroup.add(pieceGroup);
    fabricScrollGroup.add(defectGroup);
    fabricScrollGroup.add(cutGroup);
    fabricScrollGroup.add(remnantHighlightGroup);

    // 2. 固定裁切工位；几何边界保留真实尺寸。
    bedStationGroup = new Konva.Group();
    mainLayer.add(bedStationGroup);

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

        const direction = e.evt.deltaY > 0 ? -1 : 1;
        const factor = 1.12;
        const newScale = direction > 0 ? oldScale * factor : oldScale / factor;

        if (newScale < 0.002 || newScale > 3.0) return;

        stage.scale({ x: newScale, y: newScale });
        const newPos = {
            x: pointer.x - mousePointTo.x * newScale,
            y: pointer.y - mousePointTo.y * newScale,
        };
        stage.position(newPos);
        bus.emit('stage:zoomed');
        bus.emit('stage:transformed', { pointerX: pointer.x, pointerY: pointer.y });
    });

    // 移动与平移
    stage.on('dragstart', e => { if (e.target === stage) bus.emit('stage:panned'); });
    stage.on("dragmove", () => {
        const pointer = stage.getPointerPosition();
        bus.emit('stage:transformed', pointer ? { pointerX: pointer.x, pointerY: pointer.y } : {});
    });

    // 点击空白处通知去选
    stage.on("click", (e) => {
        if (e.target === stage || e.target.parent === stage || e.target.parent === fabricBgGroup) {
            bus.emit('stage:empty-clicked');
        }
    });

    stage.on("mousemove", (e) => {
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const scale = stage.scaleX();
        const worldX = Math.round((pointer.x - stage.x()) / scale);
        const worldY = Math.round((pointer.y - stage.y()) / scale);
        const local = stationCoordinates(worldX, worldY, state.getCurrentCaseData());
        const cursorText = `指针 X ${local.x} · Y ${local.y} mm  |  ${state.currentCutMode === 'remnant' ? '料头' : '母卷'} Y ${worldY} mm`;
        const sbCursor = document.getElementById("sb-cursor-pos");
        if (sbCursor) sbCursor.innerText = cursorText;

        bus.emit('cursor:moved', { pointerX: pointer.x, pointerY: pointer.y, worldX, worldY });
    });

    stage.on("mouseleave", () => {
        bus.emit('stage:mouseleave');
    });

    window.addEventListener("resize", () => {
        handleStageResize();
    });

    bus.on('viewport:resized', () => {
        handleStageResize();
    });
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(handleStageResize).observe(container);
    }
}

export function handleStageResize() {
    const container = document.getElementById("konva-container");
    if (stage && container) {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        bus.emit('stage:resized');
    }
}
