/**
 * CAD 视口与 Konva 舞台管理插件 (CAD Stage Plugin)
 */
import { bus } from '../../core/event-bus.js';
import { state } from '../../core/state.js';

export let stage, mainLayer;
export let fabricScrollGroup, fabricBgGroup, gridGroup, defectGroup, remnantGroup, pieceGroup, cutGroup;
export let bedStationGroup, dynBedRangeBadge, dynBedBottomBadge;

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

    // 1. 随滑块上下贯穿滚动的长布料组 (Fabric Continuous Roll)
    fabricScrollGroup = new Konva.Group();
    mainLayer.add(fabricScrollGroup);

    fabricBgGroup = new Konva.Group();
    gridGroup = fabricBgGroup;
    defectGroup = new Konva.Group();
    remnantGroup = new Konva.Group();
    pieceGroup = new Konva.Group();
    cutGroup = new Konva.Group();

    fabricScrollGroup.add(fabricBgGroup);
    fabricScrollGroup.add(remnantGroup);
    fabricScrollGroup.add(pieceGroup);
    fabricScrollGroup.add(defectGroup);
    fabricScrollGroup.add(cutGroup);

    // 2. 绝对固定在视口中央的醒目大红框物理裁切工位 (Fixed Red Cutting Bed Station)
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

        if (newScale < 0.015 || newScale > 3.0) return;

        stage.scale({ x: newScale, y: newScale });
        const newPos = {
            x: pointer.x - mousePointTo.x * newScale,
            y: pointer.y - mousePointTo.y * newScale,
        };
        stage.position(newPos);
        bus.emit('stage:transformed', { pointerX: pointer.x, pointerY: pointer.y });
    });

    // 移动与平移
    stage.on("dragmove", () => {
        const pointer = stage.getPointerPosition();
        bus.emit('stage:transformed', pointer ? { pointerX: pointer.x, pointerY: pointer.y } : {});
    });

    stage.on("mousemove", (e) => {
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const scale = stage.scaleX();
        const worldX = Math.round((pointer.x - stage.x()) / scale);
        const worldY = Math.round((pointer.y - stage.y()) / scale);
        const data = state.getCurrentCaseData();
        const rollW = data.rollW || 2000;
        const bedL = data.bedL || 5000;
        const winStartY = data.windowStartY || 0;
        const winEndY = winStartY + bedL;
        const originStr = (data.cutOrigin || "right-bottom").toLowerCase();
        const isRight = originStr.startsWith("right");
        const isBottom = originStr.endsWith("bottom");
        const bedY = isBottom ? (winEndY - worldY) : (worldY - winStartY);
        const xLabel = isRight ? `距右导轨 X: ${rollW - worldX} mm` : `距左布边 X: ${worldX} mm`;
        const yLabel = isBottom ? `距落料起刀线 Y: ${bedY} mm` : `距进料接刀口 Y: ${bedY} mm`;
        const cursorText = `${xLabel} | ${yLabel} | 全卷展开 Y: ${worldY} mm (${(worldY/1000).toFixed(2)}m)`;
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
}

export function handleStageResize() {
    const container = document.getElementById("konva-container");
    if (stage && container) {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        bus.emit('stage:resized');
    }
}

export function setDynBedBadges(rangeBadge, bottomBadge) {
    dynBedRangeBadge = rangeBadge;
    dynBedBottomBadge = bottomBadge;
}
