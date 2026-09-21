/**
 * CAD 精密尺寸测距标尺与交互标注插件 (CAD Measure Tape Plugin)
 * 允许用户在画布任意两点间拉线测量，实时呈现水平(ΔX)、垂直(ΔY)、欧氏直线距离及角度
 */
import { stage, mainLayer } from './cad-stage.js';
import { bus } from '../../core/event-bus.js';

let isMeasuring = false;
let startPoint = null;
let currentPreviewLine = null;
let currentPreviewText = null;
let currentPreviewRect = null;
let measureGroup = null;
let persistentMeasures = [];

/**
 * 初始化或获取测量图层
 */
function getMeasureGroup() {
    if (!measureGroup && mainLayer) {
        measureGroup = new Konva.Group({ name: "measure-layer" });
        mainLayer.add(measureGroup);
    }
    return measureGroup;
}

/**
 * 切换 CAD 交互测距模式
 */
export function toggleMeasureTool(forceState = null) {
    if (forceState !== null) {
        isMeasuring = forceState;
    } else {
        isMeasuring = !isMeasuring;
    }

    const btn = document.getElementById("btn-measure-tool");
    const container = document.getElementById("konva-container");

    if (isMeasuring) {
        if (btn) {
            btn.classList.add("active");
            btn.style.background = "#d97706";
            btn.style.borderColor = "#b45309";
            btn.innerText = "退出测距 (ESC)";
        }
        if (stage) stage.draggable(false);
        if (container) container.style.cursor = "crosshair";
        setupMeasureListeners();
    } else {
        if (btn) {
            btn.classList.remove("active");
            btn.style.background = "";
            btn.style.borderColor = "";
            btn.innerText = "CAD 测量尺";
        }
        if (stage) stage.draggable(true);
        if (container) container.style.cursor = "default";
        teardownMeasureListeners();
        resetPreview();
    }
}

/**
 * 清除所有测距标注
 */
export function clearAllMeasurements() {
    const grp = getMeasureGroup();
    if (grp) grp.destroyChildren();
    persistentMeasures = [];
    resetPreview();
    if (mainLayer) mainLayer.batchDraw();
}

function resetPreview() {
    startPoint = null;
    if (currentPreviewLine) {
        currentPreviewLine.destroy();
        currentPreviewLine = null;
    }
    if (currentPreviewRect) {
        currentPreviewRect.destroy();
        currentPreviewRect = null;
    }
    if (currentPreviewText) {
        currentPreviewText.destroy();
        currentPreviewText = null;
    }
    if (mainLayer) mainLayer.batchDraw();
}

function getWorldCoords(pointer) {
    if (!stage || !pointer) return { x: 0, y: 0 };
    const scale = stage.scaleX();
    const pos = stage.position();
    return {
        x: Math.round((pointer.x - pos.x) / scale),
        y: Math.round((pointer.y - pos.y) / scale)
    };
}

function onStageClick(e) {
    if (!isMeasuring || !stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const world = getWorldCoords(pointer);

    if (!startPoint) {
        // 第一击：设定起点
        startPoint = world;
        drawStartCrosshair(world.x, world.y);
    } else {
        // 第二击：确定终点，固化尺寸标注
        fixMeasurement(startPoint, world);
        startPoint = null;
        resetPreview();
    }
}

function onStageMouseMove(e) {
    if (!isMeasuring || !stage || !startPoint) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const world = getWorldCoords(pointer);

    updateMeasurePreview(startPoint, world);
}

function onKeyDown(e) {
    if (e.key === "Escape" && isMeasuring) {
        if (startPoint) {
            resetPreview();
        } else {
            toggleMeasureTool(false);
        }
    }
}

function setupMeasureListeners() {
    if (!stage) return;
    stage.on("click.measure", onStageClick);
    stage.on("mousemove.measure", onStageMouseMove);
    window.addEventListener("keydown", onKeyDown);
}

function teardownMeasureListeners() {
    if (!stage) return;
    stage.off("click.measure");
    stage.off("mousemove.measure");
    window.removeEventListener("keydown", onKeyDown);
}

function drawStartCrosshair(x, y) {
    const grp = getMeasureGroup();
    if (!grp) return;
    const size = 15;
    const line1 = new Konva.Line({
        points: [x - size, y, x + size, y],
        stroke: "#f59e0b", strokeWidth: 2, name: "temp-cross"
    });
    const line2 = new Konva.Line({
        points: [x, y - size, x, y + size],
        stroke: "#f59e0b", strokeWidth: 2, name: "temp-cross"
    });
    grp.add(line1);
    grp.add(line2);
    mainLayer.batchDraw();
}

function updateMeasurePreview(p1, p2) {
    const grp = getMeasureGroup();
    if (!grp) return;

    const dx = Math.abs(p2.x - p1.x);
    const dy = Math.abs(p2.y - p1.y);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;

    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");

    if (!currentPreviewLine) {
        currentPreviewLine = new Konva.Line({
            stroke: "#f59e0b", strokeWidth: 2, dash: [6, 4]
        });
        grp.add(currentPreviewLine);
    }
    currentPreviewLine.points([p1.x, p1.y, p2.x, p2.y]);

    const labelText = `距: ${dist.toFixed(1)} mm (ΔX: ${dx} mm, ΔY: ${dy} mm)`;
    const textWidth = labelText.length * 8.5;

    if (!currentPreviewRect) {
        currentPreviewRect = new Konva.Rect({
            fill: isDark ? "rgba(24, 24, 27, 0.92)" : "rgba(255, 255, 255, 0.92)",
            stroke: "#f59e0b", strokeWidth: 1.5, cornerRadius: 4,
            height: 24
        });
        grp.add(currentPreviewRect);
    }
    currentPreviewRect.position({ x: midX - textWidth / 2 - 8, y: midY - 14 });
    currentPreviewRect.width(textWidth + 16);

    if (!currentPreviewText) {
        currentPreviewText = new Konva.Text({
            fontSize: 13, fill: isDark ? "#fbbf24" : "#b45309",
            fontStyle: "bold", fontFamily: "monospace"
        });
        grp.add(currentPreviewText);
    }
    currentPreviewText.position({ x: midX - textWidth / 2, y: midY - 8 });
    currentPreviewText.text(labelText);

    mainLayer.batchDraw();
}

function fixMeasurement(p1, p2) {
    const grp = getMeasureGroup();
    if (!grp) return;

    // 清除临时的十字准星
    grp.find(".temp-cross").forEach(node => node.destroy());

    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist < 1) return; // 零距离忽略

    const dx = Math.abs(p2.x - p1.x);
    const dy = Math.abs(p2.y - p1.y);
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");

    const mItem = new Konva.Group({ name: "fixed-measure-item" });

    // 主测距实线与端点刻度
    mItem.add(new Konva.Line({
        points: [p1.x, p1.y, p2.x, p2.y],
        stroke: "#f59e0b", strokeWidth: 2.5
    }));
    // 端点 1 刻度与圆点
    mItem.add(new Konva.Circle({
        x: p1.x, y: p1.y, radius: 4, fill: "#f59e0b", stroke: "#ffffff", strokeWidth: 1.5
    }));
    // 端点 2 刻度与圆点
    mItem.add(new Konva.Circle({
        x: p2.x, y: p2.y, radius: 4, fill: "#f59e0b", stroke: "#ffffff", strokeWidth: 1.5
    }));

    const labelText = `直距: ${dist.toFixed(1)}mm (X: ${dx} | Y: ${dy})`;
    const textWidth = labelText.length * 8.5;

    // 标签底框
    mItem.add(new Konva.Rect({
        x: midX - textWidth / 2 - 8, y: midY - 14,
        width: textWidth + 16, height: 26,
        fill: isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.95)",
        stroke: "#f59e0b", strokeWidth: 1.5, cornerRadius: 4,
        shadowColor: "rgba(0,0,0,0.3)", shadowBlur: 6
    }));

    // 标签文字
    mItem.add(new Konva.Text({
        x: midX - textWidth / 2, y: midY - 7,
        text: labelText,
        fontSize: 13, fill: isDark ? "#fbbf24" : "#b45309",
        fontStyle: "bold", fontFamily: "monospace"
    }));

    grp.add(mItem);
    persistentMeasures.push(mItem);
    mainLayer.batchDraw();
}
