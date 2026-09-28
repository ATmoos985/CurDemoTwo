/**
 * CAD 料头双向点击定位与高亮联动插件 (CAD Remnant Bidirectional Inspection & Highlight Plugin)
 * 核心功能：
 * 1. 【中央点图看表】：在 CAD 画布上左键点击料头实体，自动弹出悬浮发光标识牌，
 *    自动切至右侧【料头与对账】Tab，定位到台账行并高亮滚动居中；
 * 2. 【右侧点表查图】：在右侧台账点击料头行或“定位”按钮，CAD 视口平滑聚焦居中该料头，
 *    产生高亮发光霓虹脉冲边框与尺寸规格卡片；
 * 3. 【悬停预览联动】：鼠标悬停表格或图形时，双向即时高亮反馈；
 * 4. 【状态生命周期持久】：在缩放、漫游、重排或换视图时保持高亮选定。
 * 5. 【自适应物理视口无级缩放】：高亮外框、瞄准十字与悬浮 HUD 标牌采用自适应逆缩放技术 (invScale)，
 *    在任何 CAD 缩放级别下始终保持像素级高清与高可读性。
 */
import { stage, mainLayer, remnantGroup, remnantHighlightGroup } from './cad-stage.js';
import { updateStatusBar } from './cad-renderer.js';
import { drawRulers } from './cad-rulers.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { showToast } from '../../core/toast.js';
import { switchRightPanelTab } from '../layout/splitter.js';

let activePulseAnim = null;
let animTimer = null;
let hoverHighlightNode = null;

/**
 * 平滑动画移动 CAD 视口中心至世界坐标 (worldX, worldY)，并支持平滑变焦 (targetScale)
 */
export function panToCADCoord(worldX, worldY, targetScale = null, duration = 320) {
    if (!stage) return;
    const cw = stage.width();
    const ch = stage.height();
    const startScale = stage.scaleX();
    const endScale = targetScale || startScale;

    const targetX = Math.round(cw / 2 - worldX * endScale);
    const targetY = Math.round(ch / 2 - worldY * endScale);

    const startX = stage.x();
    const startY = stage.y();
    const diffX = targetX - startX;
    const diffY = targetY - startY;
    const diffScale = endScale - startScale;

    if (Math.abs(diffX) < 4 && Math.abs(diffY) < 4 && Math.abs(diffScale) < 0.005) {
        return;
    }

    if (duration <= 0) {
        stage.scale({ x: endScale, y: endScale });
        stage.position({ x: targetX, y: targetY });
        drawRulers();
        updateStatusBar();
        renderRemnantHighlight();
        if (mainLayer) mainLayer.batchDraw();
        return;
    }

    const startTime = performance.now();
    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        // easeInOutCubic
        const ease = progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const curScale = startScale + diffScale * ease;

        stage.scale({ x: curScale, y: curScale });
        stage.position({
            x: startX + diffX * ease,
            y: startY + diffY * ease
        });
        drawRulers();
        updateStatusBar();

        if (progress < 1) {
            requestAnimationFrame(step);
        } else {
            renderRemnantHighlight();
            if (mainLayer) mainLayer.batchDraw();
        }
    }
    requestAnimationFrame(step);
}

/**
 * 选中并定位指定料头 (支持从画布点击或从表格点击触发)
 * @param {string} remnantId 料头 ID (如 REM-2D-01)
 * @param {object} options 选项: { fromTable, fromCanvas, smoothPan, switchTab, showToastMsg }
 */
export function selectRemnant(remnantId, options = {}) {
    if (!remnantId) {
        clearRemnantSelection();
        return;
    }

    state.selectedRemnantId = remnantId;
    const data = state.getCurrentCaseData();
    const rem = (data.remnants || []).find(r => r.id === remnantId);

    if (!rem) {
        clearRemnantSelection();
        return;
    }

    // 1. 绘制 CAD 画布高亮图形
    renderRemnantHighlight();

    // 2. CAD 画布视口平滑聚焦（若由表格触发，或料头在视口外/部分遮挡）
    if (stage) {
        const scale = stage.scaleX();
        const sx = rem.x * scale + stage.x();
        const sy = rem.y * scale + stage.y();
        const sw = rem.w * scale;
        const sh = rem.l * scale;
        const cw = stage.width();
        const ch = stage.height();

        const isWellVisible = (
            sx >= 60 &&
            sx + sw <= cw - 60 &&
            sy >= 60 &&
            sy + sh <= ch - 60
        );

        if (options.smoothPan || !isWellVisible) {
            const centerX = rem.x + rem.w / 2;
            const centerY = rem.y + rem.l / 2;
            // 若当前视口缩放过小 (如全卷宏观缩放 < 0.2)，自动平滑变焦至适宜观察的 0.28 比例
            let targetZoom = scale;
            if (scale < 0.22) {
                targetZoom = 0.28;
            }
            panToCADCoord(centerX, centerY, targetZoom, 320);
        }
    }

    // 3. 联动右侧【料头与对账】Tab 面板与表格行
    if (options.switchTab !== false) {
        switchRightPanelTab('balance');
    }

    // 选中对应表格行并平滑滚动
    const tbody = document.getElementById("remnant-table-body");
    if (tbody) {
        const rows = tbody.querySelectorAll("tr");
        rows.forEach(row => {
            row.classList.remove("remnant-selected-row", "active-row");
        });

        const targetRow = document.getElementById(`remnant-row-${remnantId}`) ||
            tbody.querySelector(`tr[data-remnant-id="${remnantId}"]`);
        if (targetRow) {
            targetRow.classList.add("remnant-selected-row", "active-row");
            try {
                targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
            } catch (_) {
                targetRow.scrollIntoView(false);
            }
        }
    }

    // 4. 浮动 Toast 气泡提醒
    if (options.showToastMsg !== false) {
        const statusText = rem.hasDefect ? '⚠ 带疵待处置' : '✓ 完好入库';
        showToast(`[已定位料头 #${rem.id}] 规格: ${rem.w}×${rem.l}mm (${rem.area.toFixed(2)}m²)，状态: ${statusText}`, 'info');
    }

    bus.emit('remnant:selected', { id: remnantId, remnant: rem, options });
}

/**
 * 清除当前选中的料头高亮
 */
export function clearRemnantSelection() {
    state.selectedRemnantId = null;

    if (activePulseAnim) {
        activePulseAnim.stop();
        activePulseAnim = null;
    }
    if (animTimer) {
        clearTimeout(animTimer);
        animTimer = null;
    }

    if (remnantHighlightGroup) {
        remnantHighlightGroup.destroyChildren();
    }

    // 清除表格行选中态
    const tbody = document.getElementById("remnant-table-body");
    if (tbody) {
        const rows = tbody.querySelectorAll("tr");
        rows.forEach(row => {
            row.classList.remove("remnant-selected-row", "active-row");
        });
    }

    if (mainLayer) {
        mainLayer.batchDraw();
    }

    bus.emit('remnant:deselected');
}

/**
 * 表格鼠标悬停时的画布临时预览联动
 */
export function hoverRemnant(remnantId, isHovering) {
    if (!stage || !remnantHighlightGroup) return;

    // 如果悬停的是当前已选中的料头，不做重复操作
    if (remnantId === state.selectedRemnantId) return;

    if (hoverHighlightNode) {
        hoverHighlightNode.destroy();
        hoverHighlightNode = null;
    }

    if (isHovering && remnantId) {
        const data = state.getCurrentCaseData();
        const rem = (data.remnants || []).find(r => r.id === remnantId);
        if (rem) {
            const curScale = stage.scaleX() || 0.2;
            const inv = 1 / curScale;
            hoverHighlightNode = new Konva.Rect({
                name: "remnant-hover-preview",
                x: rem.x,
                y: rem.y,
                width: rem.w,
                height: rem.l,
                fill: rem.hasDefect ? "rgba(245, 158, 11, 0.14)" : "rgba(56, 189, 248, 0.14)",
                stroke: rem.hasDefect ? "#f59e0b" : "#38bdf8",
                strokeWidth: 2.5 * inv,
                dash: [6 * inv, 4 * inv],
                listening: false
            });
            remnantHighlightGroup.add(hoverHighlightNode);
            mainLayer.batchDraw();
        }
    } else {
        if (mainLayer) mainLayer.batchDraw();
    }
}

/**
 * 重新在 CAD 画布上渲染选中料头的全套高亮指示（发光边框 + 四角瞄准十字 + 悬浮工艺卡牌）
 * 核心：全要素逆比例自适应缩放 (invScale)，保证在任何缩放倍率下都是像素级清晰易读！
 */
export function renderRemnantHighlight() {
    if (!remnantHighlightGroup) return;

    // 停止现有动画
    if (activePulseAnim) {
        activePulseAnim.stop();
        activePulseAnim = null;
    }
    if (animTimer) {
        clearTimeout(animTimer);
        animTimer = null;
    }

    remnantHighlightGroup.destroyChildren();

    const remnantId = state.selectedRemnantId;
    if (!remnantId) {
        if (mainLayer) mainLayer.batchDraw();
        return;
    }

    const data = state.getCurrentCaseData();
    const rem = (data.remnants || []).find(r => r.id === remnantId);
    if (!rem) {
        if (mainLayer) mainLayer.batchDraw();
        return;
    }

    const curScale = (stage && stage.scaleX()) ? stage.scaleX() : 0.25;
    const inv = 1 / curScale; // 视口逆缩放系数

    const isDefect = !!rem.hasDefect;
    const neonColor = isDefect ? "#fbbf24" : "#38bdf8";
    const shadowColor = isDefect ? "#f59e0b" : "#0284c7";
    const bgTint = isDefect ? "rgba(245, 158, 11, 0.22)" : "rgba(56, 189, 248, 0.2)";

    // 1. 半透明高光底色
    const tintRect = new Konva.Rect({
        x: rem.x,
        y: rem.y,
        width: rem.w,
        height: rem.l,
        fill: bgTint,
        listening: false
    });
    remnantHighlightGroup.add(tintRect);

    // 2. 霓虹呼吸发光外框 (粗细恒定保持屏幕 4px)
    const pulseRect = new Konva.Rect({
        name: "pulse-rect",
        x: rem.x,
        y: rem.y,
        width: rem.w,
        height: rem.l,
        stroke: neonColor,
        strokeWidth: 4 * inv,
        dash: [12 * inv, 6 * inv],
        shadowColor: shadowColor,
        shadowBlur: 16 * inv,
        shadowOpacity: 0.9,
        listening: false
    });
    remnantHighlightGroup.add(pulseRect);

    // 3. 四角高对比度瞄准十字手柄 (Targeting Crosshair Brackets，臂长恒定屏幕 22px)
    const arm = Math.min(24 * inv, Math.min(rem.w, rem.l) / 3);
    const offset = 3 * inv;
    const bracketPoints = [
        // 左上
        [rem.x - offset, rem.y + arm, rem.x - offset, rem.y - offset, rem.x + arm, rem.y - offset],
        // 右上
        [rem.x + rem.w - arm, rem.y - offset, rem.x + rem.w + offset, rem.y - offset, rem.x + rem.w + offset, rem.y + arm],
        // 左下
        [rem.x - offset, rem.y + rem.l - arm, rem.x - offset, rem.y + rem.l + offset, rem.x + arm, rem.y + rem.l + offset],
        // 右下
        [rem.x + rem.w - arm, rem.y + rem.l + offset, rem.x + rem.w + offset, rem.y + rem.l + offset, rem.x + rem.w + offset, rem.y + rem.l - arm]
    ];

    bracketPoints.forEach(pts => {
        remnantHighlightGroup.add(new Konva.Line({
            points: pts,
            stroke: "#ffffff",
            strokeWidth: 3 * inv,
            lineCap: "square",
            listening: false
        }));
    });

    // 4. 悬浮工艺参数标牌 (Floating HUD Badge，屏幕尺寸恒定 330×54px)
    const badgeW = 330 * inv;
    const badgeH = 54 * inv;
    const rollW = data.rollW || 2000;

    // 水平居中并限制在幅宽内
    let badgeX = Math.round(rem.x + (rem.w - badgeW) / 2);
    badgeX = Math.max(10 * inv, Math.min(badgeX, rollW - badgeW - 10 * inv));

    // 垂直方向：空间充足则悬浮在上方，否则置于下方
    let badgeY;
    let arrowPoints;
    const arrowW = 8 * inv;
    const arrowH = 10 * inv;
    const arrowMargin = 6 * inv;

    if (rem.y >= badgeH + arrowH + arrowMargin) {
        badgeY = rem.y - badgeH - arrowH - arrowMargin;
        const arrowCenterX = Math.min(Math.max(badgeX + 24 * inv, rem.x + rem.w / 2), badgeX + badgeW - 24 * inv);
        arrowPoints = [
            arrowCenterX - arrowW, badgeY + badgeH,
            arrowCenterX + arrowW, badgeY + badgeH,
            arrowCenterX, rem.y
        ];
    } else {
        badgeY = rem.y + rem.l + arrowH + arrowMargin;
        const arrowCenterX = Math.min(Math.max(badgeX + 24 * inv, rem.x + rem.w / 2), badgeX + badgeW - 24 * inv);
        arrowPoints = [
            arrowCenterX - arrowW, badgeY,
            arrowCenterX + arrowW, badgeY,
            arrowCenterX, rem.y + rem.l
        ];
    }

    const badgeGroup = new Konva.Group({ listening: false });

    // 箭头指示三角形
    badgeGroup.add(new Konva.Line({
        points: arrowPoints,
        fill: "#090d16",
        stroke: neonColor,
        strokeWidth: 2 * inv,
        closed: true
    }));

    // 标牌卡片背景
    badgeGroup.add(new Konva.Rect({
        x: badgeX,
        y: badgeY,
        width: badgeW,
        height: badgeH,
        fill: "#090d16",
        stroke: neonColor,
        strokeWidth: 2 * inv,
        cornerRadius: 6 * inv,
        shadowColor: "#000000",
        shadowBlur: 14 * inv,
        shadowOpacity: 0.85
    }));

    // 标牌主标题 (屏幕恒定 14.5px 粗体)
    badgeGroup.add(new Konva.Text({
        x: badgeX + 12 * inv,
        y: badgeY + 9 * inv,
        text: `🎯 当前定位料头: ${rem.id}`,
        fontSize: 14.5 * inv,
        fontStyle: "bold",
        fill: neonColor,
        fontFamily: "system-ui, -apple-system, sans-serif"
    }));

    // 标牌工艺副标题 (屏幕恒定 11px 等宽)
    const subText = `规格: ${rem.w}×${rem.l}mm (${rem.area.toFixed(2)}m²) · ${isDefect ? '⚠ 带疵待处置' : '✓ 完好入库'}`;
    badgeGroup.add(new Konva.Text({
        x: badgeX + 12 * inv,
        y: badgeY + 30 * inv,
        text: subText,
        fontSize: 11 * inv,
        fill: "#cbd5e1",
        fontFamily: "monospace"
    }));

    remnantHighlightGroup.add(badgeGroup);

    // 5. 启动 3.5 秒的醒目脉冲边框呼吸动画
    activePulseAnim = new Konva.Animation((frame) => {
        if (!pulseRect) return;
        const curScaleNow = (stage && stage.scaleX()) ? stage.scaleX() : 0.25;
        const currentInv = 1 / curScaleNow;
        const elapsed = (frame.time || 0) * 0.005;
        const pulse = Math.sin(elapsed);
        pulseRect.strokeWidth((3.5 + pulse * 1.5) * currentInv);
        pulseRect.dashOffset(-frame.time * 0.04 * currentInv);
        pulseRect.shadowBlur((12 + pulse * 6) * currentInv);
    }, mainLayer);

    activePulseAnim.start();

    // 3.5 秒后平稳停止动画，保留高对比度静态外框
    animTimer = setTimeout(() => {
        if (activePulseAnim) {
            activePulseAnim.stop();
            activePulseAnim = null;
        }
        if (pulseRect) {
            const curScaleNow = (stage && stage.scaleX()) ? stage.scaleX() : 0.25;
            pulseRect.strokeWidth(4 / curScaleNow);
            pulseRect.shadowBlur(14 / curScaleNow);
            if (mainLayer) mainLayer.batchDraw();
        }
    }, 3500);

    if (mainLayer) {
        mainLayer.batchDraw();
    }
}

// 监听画布视口变换（缩放或平移时实时自适应重绘高亮标牌大小）
bus.on('stage:transformed', () => {
    if (state.selectedRemnantId) {
        renderRemnantHighlight();
    }
});

// 监听画布空白区域点击去选
bus.on('stage:empty-clicked', () => {
    if (state.selectedRemnantId) {
        clearRemnantSelection();
    }
});

// 监听裁片选中事件，确保排料裁片与料头互斥高亮
bus.on('piece:selected', () => {
    if (state.selectedRemnantId) {
        clearRemnantSelection();
    }
});

// ESC 键去选
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedRemnantId) {
        clearRemnantSelection();
    }
});
