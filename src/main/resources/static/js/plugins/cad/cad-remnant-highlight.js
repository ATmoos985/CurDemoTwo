/** 料头与台账双向定位，使用克制的固定像素选中标记。 */
import { stage, mainLayer, remnantGroup, remnantHighlightGroup } from './cad-stage.js';
import { updateStatusBar } from './cad-renderer.js';
import { drawRulers } from './cad-rulers.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { showToast } from '../../core/toast.js';
import { switchRightPanelTab, toggleSectionCollapse } from '../layout/splitter.js';

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
        const ledger = document.getElementById('card-remnant-ledger');
        if (ledger && ledger.classList.contains('collapsed')) {
            toggleSectionCollapse(ledger.querySelector('.section-toggle'));
        }
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

export function renderRemnantHighlight() {
    if (!remnantHighlightGroup || !stage) return;
    remnantHighlightGroup.destroyChildren();
    hoverHighlightNode = null;
    const rem = (state.getCurrentCaseData().remnants || []).find(r => r.id === state.selectedRemnantId);
    if (!rem) { if (mainLayer) mainLayer.batchDraw(); return; }
    const inv = 1 / stage.scaleX();
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const color = rem.hasDefect ? '#b68d48' : '#2d7899';
    remnantHighlightGroup.add(new Konva.Rect({ x: rem.x, y: rem.y, width: rem.w, height: rem.l,
        stroke: color, strokeWidth: 2, strokeScaleEnabled: false, listening: false }));
    const width = Math.min(310, Math.max(100, stage.width() - 64));
    const screenX = Math.max(36, Math.min(stage.x() + rem.x / inv, stage.width() - width - 8));
    const screenY = Math.max(34, Math.min(stage.y() + rem.y / inv - 58, stage.height() - 64));
    const badge = new Konva.Group({ x: (screenX - stage.x()) * inv, y: (screenY - stage.y()) * inv,
        scaleX: inv, scaleY: inv, listening: false });
    badge.add(new Konva.Rect({ width, height: 48, fill: dark ? '#242f3b' : '#ffffff', stroke: color, strokeWidth: 1, cornerRadius: 3 }));
    badge.add(new Konva.Text({ x: 10, y: 8, width: width - 20, text: `料头 ${rem.id}`, fontSize: 12,
        fontStyle: 'bold', fill: color, wrap: 'none', ellipsis: true }));
    badge.add(new Konva.Text({ x: 10, y: 28, width: width - 20,
        text: `${rem.w} × ${rem.l} mm · ${rem.hasDefect ? '带疵待处置' : '可用料头'}`, fontSize: 11,
        fontFamily: 'Consolas, Microsoft YaHei, sans-serif', fill: dark ? '#becbd5' : '#607484', wrap: 'none', ellipsis: true }));
    remnantHighlightGroup.add(badge);
    mainLayer.batchDraw();
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
