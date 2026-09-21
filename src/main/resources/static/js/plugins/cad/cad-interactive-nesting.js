/**
 * CAD 交互式手动排料微调与碰撞/瑕疵干涉检测插件 (Interactive Nesting & Collision Detection Plugin)
 * 允许用户在画布上直接点选、拖拽移动、方向键精确微调(5mm/20mm)、90°旋转，并提供毫秒级干涉碰撞报警
 */
import { stage, mainLayer } from './cad-stage.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';

let selectedPieceId = null;
let dragInitialPos = { x: 0, y: 0 };
let activeTooltip = null;

export function getSelectedPieceId() {
    return selectedPieceId;
}

export function setSelectedPieceId(id) {
    selectedPieceId = id;
    bus.emit('piece:selected', { pieceId: id });
}

/**
 * 为单个裁片 Konva 节点注入交互行为与干涉检测
 */
export function makePieceInteractive(pGroup, piece, caseData) {
    pGroup.draggable(true);
    pGroup.name(`piece-entity-${piece.id}`);

    const rollW = caseData.rollW || 2000;
    const bedL = caseData.bedL || 5000;
    const winStartY = caseData.windowStartY || 0;
    const winEndY = winStartY + bedL;
    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");

    // 鼠标悬停高亮
    pGroup.on("mouseenter", () => {
        const container = document.getElementById("konva-container");
        if (container) container.style.cursor = "move";
        const mainRect = pGroup.findOne("Rect");
        if (mainRect && selectedPieceId !== piece.id) {
            mainRect.strokeWidth(4);
            mainLayer.batchDraw();
        }
    });

    pGroup.on("mouseleave", () => {
        const container = document.getElementById("konva-container");
        if (container) container.style.cursor = "default";
        const mainRect = pGroup.findOne("Rect");
        if (mainRect && selectedPieceId !== piece.id) {
            mainRect.strokeWidth(3);
            mainLayer.batchDraw();
        }
    });

    // 鼠标点击选中
    pGroup.on("click", (e) => {
        e.cancelBubble = true;
        setSelectedPieceId(piece.id);
        highlightSelectedPiece(pGroup);
    });

    // 拖拽开始
    pGroup.on("dragstart", (e) => {
        e.cancelBubble = true;
        dragInitialPos = { x: pGroup.x(), y: pGroup.y() };
        setSelectedPieceId(piece.id);
        pGroup.moveToTop();
        highlightSelectedPiece(pGroup);
    });

    // 拖拽过程中的实时碰撞与瑕疵干涉检测
    pGroup.on("dragmove", (e) => {
        e.cancelBubble = true;
        const curX = pGroup.x();
        const curY = pGroup.y();

        const collision = checkCollision(piece, curX, curY, caseData);
        const mainRect = pGroup.findOne("Rect");

        if (collision.hasConflict) {
            // 触发干涉告警视觉呈现 (刺眼半透明红 + 红色高亮边框)
            if (mainRect) {
                mainRect.fill("rgba(239, 68, 68, 0.45)");
                mainRect.stroke("#dc2626");
                mainRect.strokeWidth(4);
            }
            showCollisionBadge(curX, curY, `[干涉警报] ${collision.reason}`);
        } else {
            // 安全合规状态 (翠绿色)
            if (mainRect) {
                mainRect.fill(isDark ? "rgba(6, 95, 70, 0.85)" : "rgba(236, 253, 245, 0.85)");
                mainRect.stroke("#10b981");
                mainRect.strokeWidth(3);
            }
            showCollisionBadge(curX, curY, `安全位置: X=${Math.round(curX)}, Y=${Math.round(curY)}`, false);
        }
        mainLayer.batchDraw();
    });

    // 拖拽释放
    pGroup.on("dragend", (e) => {
        e.cancelBubble = true;
        const curX = pGroup.x();
        const curY = pGroup.y();

        const collision = checkCollision(piece, curX, curY, caseData);
        hideCollisionBadge();

        if (collision.hasConflict) {
            // 发生干涉，平滑弹回原位，防止生成非法排产
            pGroup.to({
                x: dragInitialPos.x,
                y: dragInitialPos.y,
                duration: 0.15,
                onFinish: () => {
                    const mainRect = pGroup.findOne("Rect");
                    if (mainRect) {
                        mainRect.fill(isDark ? "#065f46" : "#ecfdf5");
                        mainRect.stroke(isDark ? "#10b981" : "#059669");
                        mainRect.strokeWidth(3);
                    }
                    mainLayer.batchDraw();
                }
            });
        } else {
            // 合法移动：固化新物理坐标
            piece.x = Math.round(curX);
            piece.y = Math.round(curY);
            bus.emit('piece:moved', { pieceId: piece.id, x: piece.x, y: piece.y });
        }
    });
}

/**
 * 毫秒级多重几何碰撞干涉检测
 */
function checkCollision(targetPiece, testX, testY, caseData) {
    const rollW = caseData.rollW || 2000;
    const bedL = caseData.bedL || 5000;
    const winStartY = caseData.windowStartY || 0;
    const winEndY = winStartY + bedL;
    const pieces = caseData.pieces || [];
    const defects = caseData.globalDefects || caseData.defects || [];

    const pX1 = testX;
    const pY1 = testY;
    const pX2 = testX + targetPiece.w;
    const pY2 = testY + targetPiece.l;

    // 1. 边界超界检测 (Out of Bounds)
    if (pX1 < 0) return { hasConflict: true, reason: "超出左侧导轨" };
    if (pX2 > rollW) return { hasConflict: true, reason: `超出右侧幅宽 (${pX2} > ${rollW}mm)` };
    if (pY1 < winStartY) return { hasConflict: true, reason: "超出当前工位上界" };
    if (pY2 > winEndY) return { hasConflict: true, reason: "超出当前工位展开下界" };

    // 2. 瑕疵碰撞检测 (Defect Safety Zone Collision)
    for (let d of defects) {
        const m = d.margin !== undefined ? d.margin : 20;
        const dX1 = d.x - m;
        const dY1 = d.y - m;
        const dX2 = d.x + d.w + m;
        const dY2 = d.y + d.h + m;

        // AABB 重叠相交判定
        if (pX1 < dX2 && pX2 > dX1 && pY1 < dY2 && pY2 > dY1) {
            return { hasConflict: true, reason: `触碰瑕疵 #${d.id} (${d.desc || '布疵'}) 外扩安全区` };
        }
    }

    // 3. 裁片相互重叠检测 (Piece-to-Piece Overlap)
    for (let other of pieces) {
        if (other.id === targetPiece.id) continue;
        const oX1 = other.x;
        const oY1 = other.y;
        const oX2 = other.x + other.w;
        const oY2 = other.y + other.l;

        if (pX1 < oX2 && pX2 > oX1 && pY1 < oY2 && pY2 > oY1) {
            return { hasConflict: true, reason: `与裁片 [${other.name || other.id}] 重叠碰撞` };
        }
    }

    return { hasConflict: false };
}

function showCollisionBadge(x, y, text, isAlert = true) {
    if (!activeTooltip) {
        activeTooltip = new Konva.Group({ name: "collision-tooltip" });
        activeTooltip.add(new Konva.Rect({
            name: "tip-bg", height: 26, cornerRadius: 4,
            shadowColor: "rgba(0,0,0,0.4)", shadowBlur: 6
        }));
        activeTooltip.add(new Konva.Text({
            name: "tip-text", fontSize: 13, fontStyle: "bold", fontFamily: "sans-serif"
        }));
        mainLayer.add(activeTooltip);
    }

    const tipBg = activeTooltip.findOne(".tip-bg");
    const tipText = activeTooltip.findOne(".tip-text");

    const textWidth = text.length * 9;
    tipBg.width(textWidth + 20);
    tipBg.fill(isAlert ? "#ef4444" : "#10b981");
    tipBg.stroke(isAlert ? "#991b1b" : "#047857");
    tipBg.strokeWidth(1.5);

    tipText.text(text);
    tipText.fill("#ffffff");
    tipText.position({ x: 10, y: 6 });

    activeTooltip.position({ x: x + 10, y: Math.max(10, y - 32) });
    activeTooltip.moveToTop();
    activeTooltip.show();
}

function hideCollisionBadge() {
    if (activeTooltip) {
        activeTooltip.hide();
        mainLayer.batchDraw();
    }
}

function highlightSelectedPiece(pGroup) {
    mainLayer.find(".selection-handle").forEach(node => node.destroy());
    const mainRect = pGroup.findOne("Rect");
    if (!mainRect) return;

    // 绘制高亮外包手柄
    const w = mainRect.width();
    const h = mainRect.height();
    const handleGrp = new Konva.Group({ name: "selection-handle" });

    // 四角蓝色定位手柄
    const corners = [
        { x: 0, y: 0 }, { x: w, y: 0 },
        { x: 0, y: h }, { x: w, y: h }
    ];
    corners.forEach(c => {
        handleGrp.add(new Konva.Rect({
            x: c.x - 5, y: c.y - 5, width: 10, height: 10,
            fill: "#0284c7", stroke: "#ffffff", strokeWidth: 2
        }));
    });

    pGroup.add(handleGrp);
    mainLayer.batchDraw();
}

/**
 * 键盘快捷键监听：方向键精确微调 (5mm/20mm) 与 R 键 90° 旋转
 */
export function initNestingKeyboardShortcuts() {
    window.addEventListener("keydown", (e) => {
        if (!selectedPieceId) return;
        const data = state.getCurrentCaseData();
        const piece = (data.pieces || []).find(p => p.id === selectedPieceId);
        if (!piece) return;

        const step = e.shiftKey ? 20 : 5; // 按住 Shift 粗调 20mm，平常微调 5mm
        let moved = false;
        let newX = piece.x;
        let newY = piece.y;

        if (e.key === "ArrowLeft") {
            newX -= step; moved = true;
        } else if (e.key === "ArrowRight") {
            newX += step; moved = true;
        } else if (e.key === "ArrowUp") {
            newY -= step; moved = true;
        } else if (e.key === "ArrowDown") {
            newY += step; moved = true;
        } else if (e.key === "r" || e.key === "R") {
            // 90° 旋转
            const oldW = piece.w;
            piece.w = piece.l;
            piece.l = oldW;
            const collision = checkCollision(piece, piece.x, piece.y, data);
            if (collision.hasConflict) {
                // 旋转冲突撤销
                piece.w = piece.l;
                piece.l = oldW;
                showCollisionBadge(piece.x, piece.y, `[旋转干涉] ${collision.reason}`);
                setTimeout(hideCollisionBadge, 1500);
            } else {
                bus.emit('piece:moved', { pieceId: piece.id, x: piece.x, y: piece.y });
            }
            e.preventDefault();
            return;
        } else if (e.key === "Escape") {
            setSelectedPieceId(null);
            mainLayer.find(".selection-handle").forEach(node => node.destroy());
            mainLayer.batchDraw();
            return;
        }

        if (moved) {
            e.preventDefault();
            const collision = checkCollision(piece, newX, newY, data);
            if (!collision.hasConflict) {
                piece.x = newX;
                piece.y = newY;
                bus.emit('piece:moved', { pieceId: piece.id, x: piece.x, y: piece.y });
            } else {
                showCollisionBadge(newX, newY, `[微调受阻] ${collision.reason}`);
                setTimeout(hideCollisionBadge, 1200);
            }
        }
    });
}
