/**
 * CAD 毫米标尺独立渲染引擎 (CAD Rulers Plugin)
 */
import { stage } from './cad-stage.js';
import { state } from '../../core/state.js';

export function drawRulers(cursorX, cursorY) {
    const canvas = document.getElementById("cad-ruler-canvas");
    if (!canvas || !stage) return;
    const container = document.getElementById("konva-container");
    if (!container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
    }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const RULER_T = 24; // 标尺厚度
    const scale = stage.scaleX();
    const pos = stage.position();

    const data = state.getCurrentCaseData();
    const rollW = data.rollW || 2000;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const winStartY = data.windowStartY || 0;
    const winEndY = winStartY + bedL;

    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");
    const rulerBg = isDark ? "#18181b" : "#f1f5f9";
    const rulerBorder = isDark ? "#3f3f46" : "#cbd5e1";
    const rulerText = isDark ? "#a1a1aa" : "#475569";
    const rulerMajorLine = isDark ? "#71717a" : "#94a3b8";
    const rulerSubLine = isDark ? "#3f3f46" : "#cbd5e1";
    const rulerCornerBg = isDark ? "#27272a" : "#e2e8f0";
    const rulerAccent = isDark ? "#38bdf8" : "#0284c7";

    // 1. 标尺底色与基线
    // 顶标尺 (X 轴: 幅宽方向)
    ctx.fillStyle = rulerBg;
    ctx.fillRect(0, 0, w, RULER_T);
    ctx.strokeStyle = rulerBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_T - 0.5);
    ctx.lineTo(w, RULER_T - 0.5);
    ctx.stroke();

    // 左标尺 (Y 轴: 展开长度方向)
    ctx.fillStyle = rulerBg;
    ctx.fillRect(0, 0, RULER_T, h);
    ctx.beginPath();
    ctx.moveTo(RULER_T - 0.5, 0);
    ctx.lineTo(RULER_T - 0.5, h);
    ctx.stroke();

    // 2. 标尺上布料与机台活动区间投影高亮 (Active Range Projection)
    // X 轴投影: [0, rollW]
    const scrX0 = pos.x;
    const scrX1 = pos.x + rollW * scale;
    if (scrX1 > RULER_T && scrX0 < w) {
        const clipX0 = Math.max(RULER_T, scrX0);
        const clipX1 = Math.min(w, scrX1);
        ctx.fillStyle = isDark ? "rgba(2, 132, 199, 0.45)" : "rgba(2, 132, 199, 0.35)";
        ctx.fillRect(clipX0, RULER_T - 4, clipX1 - clipX0, 3);
    }

    // Y 轴投影: [winStartY, winEndY] (当前台面) 与 [winEndY, totalL] (未展开母卷)
    const scrY0 = pos.y + winStartY * scale;
    const scrY1 = pos.y + winEndY * scale;
    const scrYTotal = pos.y + totalL * scale;

    // 当前数控有效裁切台面高亮 (醒目大红工位投影)
    if (scrY1 > RULER_T && scrY0 < h) {
        const clipY0 = Math.max(RULER_T, scrY0);
        const clipY1 = Math.min(h, scrY1);
        ctx.fillStyle = "rgba(239, 68, 68, 0.75)";
        ctx.fillRect(RULER_T - 5, clipY0, 4, clipY1 - clipY0);
    }
    // 未展开母卷高亮 (暗琥珀色)
    if (scrYTotal > RULER_T && scrY1 < h) {
        const clipY1 = Math.max(RULER_T, scrY1);
        const clipY2 = Math.min(h, scrYTotal);
        ctx.fillStyle = isDark ? "rgba(245, 158, 11, 0.40)" : "rgba(217, 119, 6, 0.40)";
        ctx.fillRect(RULER_T - 3, clipY1, 2, clipY2 - clipY1);
    }

    // 3. 动态自适应刻度步长计算 (确保在不同缩放比下数字不拥挤重叠)
    const targetWorldStep = 80 / scale;
    const niceSteps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    let step = 1000;
    for (let s of niceSteps) {
        if (s >= targetWorldStep) {
            step = s;
            break;
        }
    }
    let subStep = step / 5;
    if (subStep < 1) subStep = 1;

    // 4. 绘制 X 标尺 (精确对应画布布料宽度 0 ~ rollW)
    ctx.font = "9px 'JetBrains Mono', Consolas, monospace";
    ctx.textBaseline = "top";

    const minWorldX = Math.floor((RULER_T - pos.x) / (scale * subStep)) * subStep;
    const maxWorldX = Math.ceil((w - pos.x) / (scale * subStep)) * subStep;

    for (let wx = minWorldX; wx <= maxWorldX; wx += subStep) {
        const sx = Math.round(pos.x + wx * scale) + 0.5;
        if (sx < RULER_T || sx > w) continue;

        const roundedWx = Math.round(wx);
        const isEdge = (roundedWx === 0 || roundedWx === rollW);
        const isMajor = (Math.abs(roundedWx) % step === 0);

        ctx.beginPath();
        if (isEdge) {
            ctx.strokeStyle = rulerAccent;
            ctx.lineWidth = 1.5;
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, RULER_T);
            ctx.stroke();
            ctx.fillStyle = rulerAccent;
            ctx.fillText(roundedWx, sx + 2, 6);
        } else if (isMajor) {
            ctx.strokeStyle = rulerMajorLine;
            ctx.lineWidth = 1;
            ctx.moveTo(sx, RULER_T - 8);
            ctx.lineTo(sx, RULER_T);
            ctx.stroke();
            ctx.fillStyle = rulerText;
            ctx.fillText(roundedWx, sx + 2, 6);
        } else {
            ctx.strokeStyle = rulerSubLine;
            ctx.lineWidth = 1;
            ctx.moveTo(sx, RULER_T - 4);
            ctx.lineTo(sx, RULER_T);
            ctx.stroke();
        }
    }

    // 5. 绘制 Y 标尺 (精确对应机台 Y 展开与全局母卷 Y)
    const minWorldY = Math.floor((RULER_T - pos.y) / (scale * subStep)) * subStep;
    const maxWorldY = Math.ceil((h - pos.y) / (scale * subStep)) * subStep;

    for (let wy = minWorldY; wy <= maxWorldY; wy += subStep) {
        const sy = Math.round(pos.y + wy * scale) + 0.5;
        if (sy < RULER_T || sy > h) continue;

        const roundedWy = Math.round(wy);
        const isBedEdge = (roundedWy === winStartY || roundedWy === winEndY);
        const isMajor = (Math.abs(roundedWy) % step === 0);

        ctx.beginPath();
        if (isBedEdge) {
            ctx.strokeStyle = rulerAccent;
            ctx.lineWidth = 1.5;
            ctx.moveTo(0, sy);
            ctx.lineTo(RULER_T, sy);
            ctx.stroke();
            ctx.fillStyle = rulerAccent;
            const label = (roundedWy % 1000 === 0) ? `${(roundedWy/1000).toFixed(0)}m` : `${roundedWy}`;
            ctx.fillText(label, 2, sy - 11);
        } else if (isMajor) {
            ctx.strokeStyle = rulerMajorLine;
            ctx.lineWidth = 1;
            ctx.moveTo(RULER_T - 8, sy);
            ctx.lineTo(RULER_T, sy);
            ctx.stroke();
            ctx.fillStyle = rulerText;
            const label = (Math.abs(roundedWy) >= 1000 && roundedWy % 1000 === 0) ? `${(roundedWy/1000).toFixed(0)}m` : `${roundedWy}`;
            ctx.fillText(label, 2, sy - 11);
        } else {
            ctx.strokeStyle = rulerSubLine;
            ctx.lineWidth = 1;
            ctx.moveTo(RULER_T - 4, sy);
            ctx.lineTo(RULER_T, sy);
            ctx.stroke();
        }
    }

    // 6. 光标实时投影线 (Crosshair Tracking Indicator)
    if (cursorX !== undefined && cursorX >= RULER_T && cursorX <= w) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cursorX, 0);
        ctx.lineTo(cursorX, RULER_T);
        ctx.stroke();
    }
    if (cursorY !== undefined && cursorY >= RULER_T && cursorY <= h) {
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cursorY);
        ctx.lineTo(RULER_T, cursorY);
        ctx.stroke();
    }

    // 7. 标尺左上角基准块 (Origin Indicator Corner)
    ctx.fillStyle = rulerCornerBg;
    ctx.fillRect(0, 0, RULER_T, RULER_T);
    ctx.strokeStyle = rulerBorder;
    ctx.strokeRect(0.5, 0.5, RULER_T - 1, RULER_T - 1);
    ctx.fillStyle = rulerAccent;
    ctx.font = "bold 9px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("mm", RULER_T / 2, RULER_T / 2);

    ctx.restore();
}
