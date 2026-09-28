/**
 * CAD 实体与视窗场景渲染引擎 (CAD Renderer Plugin)
 */
import {
    stage, mainLayer,
    fabricBgGroup, defectGroup, remnantGroup, pieceGroup, cutGroup,
    bedStationGroup, setDynBedBadges
} from './cad-stage.js';
import { drawRulers } from './cad-rulers.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import { getHomeCoordinates } from '../toolpath/toolpath-optimizer.js';
import { makePieceInteractive } from './cad-interactive-nesting.js';
import { makeRemnantInteractive } from './cad-context-menu.js';
import { renderRemnantHighlight } from './cad-remnant-highlight.js';

export function renderScene() {
    if (!stage || !mainLayer) return;
    const data = state.getCurrentCaseData();

    fabricBgGroup.destroyChildren();
    defectGroup.destroyChildren();
    remnantGroup.destroyChildren();
    pieceGroup.destroyChildren();
    cutGroup.destroyChildren();
    bedStationGroup.destroyChildren();

    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const winStartY = data.windowStartY || 0;
    const winEndY = winStartY + bedL;
    const rollW = data.rollW || 2000;
    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");

    // -------------------------------------------------------------
    // A. 完整 60m 连续母卷布料底图与全幅米数标线 (Continuous Fabric Roll 0 ~ totalL)
    // -------------------------------------------------------------
    fabricBgGroup.add(new Konva.Rect({
        x: 0, y: 0, width: rollW, height: totalL,
        fill: isDark ? "#090d16" : "#f8fafc",
        stroke: isDark ? "#334155" : "#cbd5e1",
        strokeWidth: 2
    }));

    // 连续米数刻度标线 (1m 细网格 + 5m 粗主刻度)
    for (let my = 0; my <= totalL; my += 1000) {
        const isMajor = (my % 5000 === 0);
        fabricBgGroup.add(new Konva.Line({
            points: [0, my, rollW, my],
            stroke: isMajor ? (isDark ? "#334155" : "#cbd5e1") : (isDark ? "#1e293b" : "#f1f5f9"),
            strokeWidth: isMajor ? 2 : 1,
            dash: isMajor ? [8, 4] : [4, 6]
        }));
        fabricBgGroup.add(new Konva.Text({
            x: 16, y: my + 4,
            text: `${(my/1000).toFixed(0)}m (${my} mm)`,
            fontSize: isMajor ? 16 : 13,
            fill: isMajor ? (isDark ? "#94a3b8" : "#475569") : (isDark ? "#475569" : "#94a3b8"),
            fontFamily: "monospace", fontStyle: isMajor ? "bold" : "normal"
        }));
    }

    // 绘制已实切历史区覆盖层与醒目金黄色开卷物理基准线 (Current Cutting Datum)
    let maxConfirmedY = 0;
    (data.pieces || []).filter(p => p.confirmed).forEach(p => {
        if (p.y + p.l > maxConfirmedY) maxConfirmedY = p.y + p.l;
    });
    if (data.lastReceipt && data.lastReceipt.windowStartY !== undefined && data.lastReceipt.actualCutLen) {
        const rEnd = data.lastReceipt.windowStartY + data.lastReceipt.actualCutLen;
        if (rEnd > maxConfirmedY) maxConfirmedY = Math.round(rEnd);
    }

    if (maxConfirmedY > 0) {
        // 1. 已切历史区间半透明灰色沉浸遮罩 (0 ~ maxConfirmedY)
        fabricBgGroup.add(new Konva.Rect({
            x: 0, y: 0, width: rollW, height: maxConfirmedY,
            fill: isDark ? "rgba(30, 41, 59, 0.45)" : "rgba(148, 163, 184, 0.30)",
            stroke: isDark ? "#475569" : "#94a3b8", strokeWidth: 1.5, dash: [8, 4]
        }));
        fabricBgGroup.add(new Konva.Text({
            x: 20, y: 16,
            text: `[已实切下料出库历史区间 0 ~ ${(maxConfirmedY/1000).toFixed(2)}m (已扣 ${maxConfirmedY}mm)]`,
            fontSize: 18, fill: isDark ? "#94a3b8" : "#475569", fontStyle: "bold", fontFamily: "monospace"
        }));

        // 2. 醒目金黄色基准分割线 (当前开卷布头接刀基准)
        fabricBgGroup.add(new Konva.Line({
            points: [-120, maxConfirmedY, rollW + 120, maxConfirmedY],
            stroke: "#f59e0b", strokeWidth: 3.5,
            dash: [12, 6]
        }));
        
        const datumBadgeW = 560;
        const datumBadgeH = 40;
        fabricBgGroup.add(new Konva.Rect({
            x: rollW / 2 - datumBadgeW / 2, y: maxConfirmedY - datumBadgeH / 2,
            width: datumBadgeW, height: datumBadgeH,
            fill: isDark ? "#451a03" : "#fef3c7",
            stroke: "#d97706", strokeWidth: 2, cornerRadius: 6,
            shadowColor: "rgba(245, 158, 11, 0.45)", shadowBlur: 12
        }));
        fabricBgGroup.add(new Konva.Text({
            x: rollW / 2 - datumBadgeW / 2, y: maxConfirmedY - 9,
            width: datumBadgeW, align: "center",
            text: `⚓ [母卷开卷物理基准] Y = ${maxConfirmedY} mm (${(maxConfirmedY/1000).toFixed(2)}m) ➔ 本卷由此起刀拉布`,
            fontSize: 15, fill: isDark ? "#fde68a" : "#b45309", fontStyle: "bold", fontFamily: "monospace"
        }));
    }

    // -------------------------------------------------------------
    // B. 瑕疵区与安全避让外扩区 (Defects & Safety Margins)
    // -------------------------------------------------------------
    const defects = data.globalDefects || data.defects || [];
    defects.forEach((d) => {
        const dGroup = new Konva.Group();
        const m = (d.margin !== undefined ? d.margin : 20);
        const inBed = (d.y + d.h >= winStartY && d.y <= winEndY);
        const inUpcoming = (d.y > winEndY);

        // 安全避让外扩区 (虚线框)
        const zoneRect = new Konva.Rect({
            name: `defect-zone-${d.id}`,
            x: d.x - m, y: d.y - m,
            width: d.w + m * 2, height: d.h + m * 2,
            fill: inBed ? (isDark ? "rgba(239, 68, 68, 0.25)" : "rgba(239, 68, 68, 0.15)") :
                  (inUpcoming ? (isDark ? "rgba(245, 158, 11, 0.16)" : "rgba(245, 158, 11, 0.12)") : "transparent"),
            stroke: inBed ? "#dc2626" : (inUpcoming ? "#f59e0b" : "transparent"),
            strokeWidth: inBed ? 2 : 1.5,
            dash: inBed ? [8, 4] : [6, 4],
            visible: inBed || inUpcoming
        });
        dGroup.add(zoneRect);

        // 瑕疵本体实体框 (实心警示)
        const boxRect = new Konva.Rect({
            name: `defect-box-${d.id}`,
            x: d.x, y: d.y, width: d.w, height: d.h,
            fill: inBed ? "#ef4444" : (inUpcoming ? "#d97706" : (isDark ? "#3f3f46" : "#cbd5e1")),
            stroke: inBed ? "#991b1b" : (inUpcoming ? "#b45309" : (isDark ? "#52525b" : "#94a3b8")),
            strokeWidth: inBed ? 2 : 1
        });
        dGroup.add(boxRect);

        if (inBed || inUpcoming) {
            dGroup.add(new Konva.Line({
                points: [d.x, d.y, d.x + d.w, d.y + d.h],
                stroke: inBed ? "#ffffff" : (isDark ? "#fde68a" : "#78350f"),
                strokeWidth: 1.5
            }));
            dGroup.add(new Konva.Line({
                points: [d.x + d.w, d.y, d.x, d.y + d.h],
                stroke: inBed ? "#ffffff" : (isDark ? "#fde68a" : "#78350f"),
                strokeWidth: 1.5
            }));
        }

        // 瑕疵警示说明文字
        let txtStr = `[工位避让疵点] #${d.id} ${d.w}×${d.h}mm (工位Y: ${d.y - winStartY}mm | 全局: ${(d.y/1000).toFixed(2)}m)`;
        let txtColor = isDark ? "#fecaca" : "#991b1b";
        let txtSize = 17;
        let txtStyle = "bold";

        if (!inBed && inUpcoming) {
            txtStr = `[进料预警] #${d.id} [${d.desc || '瑕疵'}] 全局 ${(d.y/1000).toFixed(2)}m (距工位 +${((d.y - winEndY)/1000).toFixed(2)}m)`;
            txtColor = isDark ? "#fde68a" : "#92400e";
        } else if (!inBed && !inUpcoming) {
            txtStr = `[已过段] #${d.id} ${(d.y/1000).toFixed(2)}m`;
            txtColor = isDark ? "#71717a" : "#94a3b8";
            txtSize = 15;
            txtStyle = "normal";
        }

        const infoText = new Konva.Text({
            name: `defect-txt-${d.id}`,
            x: d.x, y: Math.max(8, d.y - 24),
            text: txtStr,
            fontSize: txtSize, fill: txtColor, fontStyle: txtStyle
        });
        dGroup.add(infoText);
        defectGroup.add(dGroup);
    });

    // -------------------------------------------------------------
    // C. 绘制回收料头 (科技蓝工程色)
    // -------------------------------------------------------------
    (data.remnants || []).forEach((r) => {
        const rGroup = new Konva.Group();
        const rFill = r.hasDefect ? (isDark ? "#451a03" : "#fef3c7") : (isDark ? "#0c4a6e" : "#f0f9ff");
        const rStroke = r.hasDefect ? (isDark ? "#f59e0b" : "#d97706") : (isDark ? "#0284c7" : "#0284c7");
        const rTitleFill = r.hasDefect ? (isDark ? "#fbbf24" : "#92400e") : (isDark ? "#bae6fd" : "#0369a1");
        const rSubFill = r.hasDefect ? (isDark ? "#fde68a" : "#b45309") : (isDark ? "#7dd3fc" : "#0284c7");

        rGroup.add(new Konva.Rect({
            x: r.x, y: r.y, width: r.w, height: r.l,
            fill: rFill, stroke: rStroke, strokeWidth: 2, dash: [8, 4]
        }));
        rGroup.add(new Konva.Text({
            x: r.x + 12, y: r.y + 12,
            text: `[${r.hasDefect ? '带疵料头' : '完好料头'}] ${r.id}`,
            fontSize: 22, fill: rTitleFill, fontStyle: "bold"
        }));
        rGroup.add(new Konva.Text({
            x: r.x + 12, y: r.y + 40,
            text: `${r.w} × ${r.l} mm (${r.area.toFixed(2)} m²)`,
            fontSize: 18, fill: rSubFill, fontFamily: "monospace"
        }));
        makeRemnantInteractive(rGroup, r, data);
        remnantGroup.add(rGroup);
    });

    // -------------------------------------------------------------
    // D. 绘制合格成品 (翡翠绿工程色，支持交互拖拽、精确微调与干涉碰撞检测)
    // -------------------------------------------------------------
    (data.pieces || []).forEach((p) => {
        const pGroup = new Konva.Group({
            x: p.x,
            y: p.y
        });
        const isHistory = !!p.confirmed;
        const pFill = isHistory ? (isDark ? "rgba(30, 41, 59, 0.75)" : "rgba(241, 245, 249, 0.9)") :
                                  (isDark ? "#065f46" : "#ecfdf5");
        const pStroke = isHistory ? (isDark ? "#475569" : "#94a3b8") :
                                    (isDark ? "#10b981" : "#059669");
        const pTitleFill = isHistory ? (isDark ? "#94a3b8" : "#475569") :
                                      (isDark ? "#ecfdf5" : "#065f46");
        const pSubFill = isHistory ? (isDark ? "#64748b" : "#64748b") :
                                    (isDark ? "#a7f3d0" : "#047857");
        const pGrainFill = isDark ? "#6ee7b7" : "#059669";

        pGroup.add(new Konva.Rect({
            x: 0, y: 0, width: p.w, height: p.l,
            fill: pFill, stroke: pStroke, strokeWidth: isHistory ? 2 : 3,
            dash: isHistory ? [8, 4] : [],
            shadowColor: isHistory ? "transparent" : (isDark ? "#059669" : "#cbd5e1"),
            shadowBlur: 4, shadowOpacity: isDark ? 0.6 : 0.25
        }));
        pGroup.add(new Konva.Text({
            x: p.w / 2 - 140, y: p.l / 2 - 25,
            text: p.name + (isHistory ? " [历史已切]" : ""), width: 280, align: "center",
            fontSize: 24, fill: pTitleFill, fontStyle: "bold"
        }));
        pGroup.add(new Konva.Text({
            x: p.w / 2 - 140, y: p.l / 2 + 8,
            text: `${p.w} × ${p.l} mm`, width: 280, align: "center",
            fontSize: 18, fill: pSubFill, fontFamily: "monospace"
        }));
        if (isHistory) {
            pGroup.add(new Konva.Rect({
                x: 10, y: 10, width: 145, height: 26,
                fill: isDark ? "rgba(16, 185, 129, 0.2)" : "rgba(16, 185, 129, 0.15)",
                stroke: "#10b981", strokeWidth: 1.5, cornerRadius: 4
            }));
            pGroup.add(new Konva.Text({
                x: 16, y: 15,
                text: "✓ 已实切下料出库", fontSize: 13,
                fill: isDark ? "#34d399" : "#059669", fontStyle: "bold"
            }));
            pGroup.draggable(false);
        } else {
            pGroup.add(new Konva.Text({
                x: 10, y: 10,
                text: "经向 (Length)", fontSize: 16, fill: pGrainFill
            }));
        }
        // 统一注入交互与点击拦截，防止事件穿透至底层或误触发其他图元
        makePieceInteractive(pGroup, p, data);

        pieceGroup.add(pGroup);
    });

    // -------------------------------------------------------------
    // E. 绘制切刀顺序与刀路轨迹 (Guillotine Cuts & Toolpath Traversal)
    // -------------------------------------------------------------
    const currentLimit = state.currentCutStepLimit;
    const isOpt = state.isToolpathOptimized;
    const home = getHomeCoordinates(data);
    let lastX = home.x;
    let lastY = home.y;

    // 如果开启了刀路优化，先绘制右下角起始停靠原点
    if (isOpt) {
        cutGroup.add(new Konva.Circle({
            x: home.x, y: home.y, radius: 14,
            fill: "#0284c7", stroke: "#ffffff", strokeWidth: 3,
            shadowColor: "#0284c7", shadowBlur: 10
        }));
        cutGroup.add(new Konva.Line({
            points: [home.x - 22, home.y, home.x + 22, home.y],
            stroke: "#ffffff", strokeWidth: 2
        }));
        cutGroup.add(new Konva.Line({
            points: [home.x, home.y - 22, home.x, home.y + 22],
            stroke: "#ffffff", strokeWidth: 2
        }));
        cutGroup.add(new Konva.Rect({
            x: home.x - 260, y: home.y - 34,
            width: 250, height: 26,
            fill: isDark ? "rgba(15, 23, 42, 0.9)" : "rgba(255, 255, 255, 0.9)",
            stroke: "#0284c7", strokeWidth: 1.5, cornerRadius: 4
        }));
        cutGroup.add(new Konva.Text({
            x: home.x - 252, y: home.y - 28,
            text: `[右下角起刀停靠点] (${home.x}, ${home.y})`,
            fontSize: 13, fill: isDark ? "#38bdf8" : "#0284c7",
            fontStyle: "bold", fontFamily: "monospace"
        }));
    }

    (data.cuts || []).forEach((c) => {
        if (c.step > currentLimit) return;

        // 仅渲染当前工位内的切削刀路，严禁旧刀路或越界刀路污染历史区域与画布
        const winStartY = data.windowStartY || 0;
        const bedL = data.bedL || 5000;
        const winEndY = winStartY + bedL;
        const cutY = (c.type === "横切") ? c.pos : (c.start + c.end) / 2;
        if (cutY < winStartY - 10 || cutY > winEndY + 10) return;

        const isHoriz = (c.type === "横切");
        let startX, startY, endX, endY;

        if (c.startX !== undefined && c.endX !== undefined) {
            startX = c.startX; startY = c.startY;
            endX = c.endX; endY = c.endY;
        } else {
            startX = isHoriz ? c.start : c.pos;
            startY = isHoriz ? c.pos : c.start;
            endX = isHoriz ? c.end : c.pos;
            endY = isHoriz ? c.pos : c.end;
        }

        // 绘制空刀快移路径 (Rapid Traverse Air Move)
        if (isOpt) {
            const airDist = Math.hypot(startX - lastX, startY - lastY);
            if (airDist > 1) {
                // 快移空刀线 (亮蓝色虚线)
                cutGroup.add(new Konva.Line({
                    points: [lastX, lastY, startX, startY],
                    stroke: "#0284c7", strokeWidth: 2,
                    dash: [6, 6]
                }));

                // 快移中点标注空走距离
                if (airDist > 150) {
                    const midAirX = (lastX + startX) / 2;
                    const midAirY = (lastY + startY) / 2;
                    cutGroup.add(new Konva.Rect({
                        x: midAirX - 35, y: midAirY - 9,
                        width: 70, height: 18,
                        fill: isDark ? "rgba(15, 23, 42, 0.85)" : "rgba(240, 249, 255, 0.9)",
                        stroke: "#38bdf8", strokeWidth: 1, cornerRadius: 3
                    }));
                    cutGroup.add(new Konva.Text({
                        x: midAirX - 30, y: midAirY - 5,
                        text: `空+${Math.round(airDist)}`,
                        fontSize: 11, fill: isDark ? "#7dd3fc" : "#0284c7",
                        fontFamily: "monospace"
                    }));
                }
            }
            lastX = endX;
            lastY = endY;
        }

        // 绘制实际切线 (实线下刀)
        cutGroup.add(new Konva.Line({
            points: [startX, startY, endX, endY],
            stroke: "#f43f5e", strokeWidth: 4,
            dash: isOpt ? [] : [14, 8]
        }));

        // 切刀方向指示箭头 (Arrow on cut line)
        if (isOpt) {
            const midCutX = (startX + endX) / 2;
            const midCutY = (startY + endY) / 2;
            const angle = Math.atan2(endY - startY, endX - startX);
            const arrowLen = 14;
            const a1x = midCutX - arrowLen * Math.cos(angle - Math.PI / 6);
            const a1y = midCutY - arrowLen * Math.sin(angle - Math.PI / 6);
            const a2x = midCutX - arrowLen * Math.cos(angle + Math.PI / 6);
            const a2y = midCutY - arrowLen * Math.sin(angle + Math.PI / 6);

            cutGroup.add(new Konva.Line({
                points: [a1x, a1y, midCutX, midCutY, a2x, a2y],
                stroke: "#ffffff", strokeWidth: 3
            }));
        }

        // 下刀起点徽章 (Numbered step badge at cut entry point)
        const badgeX = isOpt ? startX : (isHoriz ? c.start + 30 : c.pos);
        const badgeY = isOpt ? startY : (isHoriz ? c.pos : c.start + 30);

        cutGroup.add(new Konva.Circle({
            x: badgeX, y: badgeY, radius: 15,
            fill: "#f43f5e", stroke: "#ffffff", strokeWidth: 2
        }));
        cutGroup.add(new Konva.Text({
            x: badgeX - 9, y: badgeY - 7, text: `${c.step}`,
            fontSize: 14, fill: "#ffffff", fontStyle: "bold", fontFamily: "monospace"
        }));
    });

    // -------------------------------------------------------------
    // F. 构建醒目大红色物理裁切工位 (Red Bed Station: 0 ~ bedL)
    // -------------------------------------------------------------
    bedStationGroup.add(new Konva.Rect({
        x: 0, y: 0, width: rollW, height: bedL,
        fill: isDark ? "rgba(239, 68, 68, 0.08)" : "rgba(239, 68, 68, 0.06)",
        stroke: "#ef4444", strokeWidth: 4,
        shadowColor: "#ef4444", shadowBlur: 16, shadowOpacity: 0.35
    }));

    // 四角重工业定位角标 [ ] (4 Corner Brackets)
    const cLen = 70;
    const cWidth = 6;
    const cColor = "#ef4444";
    bedStationGroup.add(new Konva.Line({ points: [0, cLen, 0, 0, cLen, 0], stroke: cColor, strokeWidth: cWidth }));
    bedStationGroup.add(new Konva.Line({ points: [rollW - cLen, 0, rollW, 0, rollW, cLen], stroke: cColor, strokeWidth: cWidth }));
    bedStationGroup.add(new Konva.Line({ points: [0, bedL - cLen, 0, bedL, cLen, bedL], stroke: cColor, strokeWidth: cWidth }));
    bedStationGroup.add(new Konva.Line({ points: [rollW - cLen, bedL, rollW, bedL, rollW, bedL - cLen], stroke: cColor, strokeWidth: cWidth }));

    // 工位顶部大红标牌
    bedStationGroup.add(new Konva.Rect({
        x: 0, y: 0, width: rollW, height: 38,
        fill: "#ef4444"
    }));

    const originStr = (data.cutOrigin || "right-bottom").toLowerCase();
    const isRight = originStr.startsWith("right");
    const isBottom = originStr.endsWith("bottom");

    const topBadgeText = isBottom ?
        `【数控裁床加工工位】进料口 Y=${winStartY}mm (${(winStartY/1000).toFixed(2)}m) | 机台长 ${(bedL/1000).toFixed(1)}m` :
        `【数控裁床加工工位】顺流进料/接刀原点 Y=${winStartY}mm (${(winStartY/1000).toFixed(2)}m) | 机台长 ${(bedL/1000).toFixed(1)}m`;
    const dynBedRangeBadge = new Konva.Text({
        x: 16, y: 9,
        text: topBadgeText,
        fontSize: 18, fill: "#ffffff", fontStyle: "bold", fontFamily: "sans-serif"
    });
    bedStationGroup.add(dynBedRangeBadge);

    // 工位底切刀口基准线与落料标牌
    bedStationGroup.add(new Konva.Line({
        points: [0, bedL, rollW, bedL],
        stroke: "#ef4444", strokeWidth: 4, dash: [12, 6]
    }));
    bedStationGroup.add(new Konva.Rect({
        x: rollW / 2 - 200, y: bedL - 30, width: 400, height: 28,
        fill: "#ef4444", cornerRadius: 4
    }));
    const bottomBadgeText = isBottom ?
        `[工位起刀口/落料基准] 切断线 Y=${winEndY}mm (${(winEndY/1000).toFixed(2)}m)` :
        `[工位落料端/下死点] 切断线 Y=${winEndY}mm (${(winEndY/1000).toFixed(2)}m)`;
    const dynBedBottomBadge = new Konva.Text({
        x: rollW / 2 - 190, y: bedL - 24,
        text: bottomBadgeText,
        fontSize: 15, fill: "#ffffff", fontStyle: "bold"
    });
    bedStationGroup.add(dynBedBottomBadge);
    setDynBedBadges(dynBedRangeBadge, dynBedBottomBadge);

    // 机台起刀基准原点与坐标轴
    const trim = data.trimStart || 0;
    const originX = isRight ? rollW : 0;
    const originY = isBottom ? (bedL - trim) : trim;

    if (trim > 0) {
        const trimBoxY = isBottom ? (bedL - trim) : 0;
        bedStationGroup.add(new Konva.Rect({
            x: 0, y: trimBoxY, width: rollW, height: trim,
            fill: isDark ? "rgba(245, 158, 11, 0.2)" : "rgba(245, 158, 11, 0.25)",
            stroke: "#f59e0b", strokeWidth: 1.5, dash: [8, 4]
        }));
        bedStationGroup.add(new Konva.Text({
            x: 14, y: trimBoxY + Math.max(4, trim / 2 - 9),
            text: `[修齐切断] 卷头修齐区 [${trimBoxY} ~ ${trimBoxY + trim} mm]`,
            fontSize: 17, fill: isDark ? "#fbbf24" : "#b45309", fontStyle: "bold"
        }));
    }

    // 绘制工业原点准星
    bedStationGroup.add(new Konva.Circle({ x: originX, y: originY, radius: 14, fill: "#ef4444", stroke: "#ffffff", strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Line({ points: [originX - 24, originY, originX + 24, originY], stroke: "#ffffff", strokeWidth: 2 }));
    bedStationGroup.add(new Konva.Line({ points: [originX, originY - 24, originX, originY + 24], stroke: "#ffffff", strokeWidth: 2 }));

    // +X 轴
    const xDir = isRight ? -1 : 1;
    const xEnd = originX + xDir * 240;
    bedStationGroup.add(new Konva.Line({ points: [originX, originY, xEnd, originY], stroke: "#10b981", strokeWidth: 3.5 }));
    bedStationGroup.add(new Konva.Line({ points: [originX + xDir * 215, originY - 10, xEnd, originY, originX + xDir * 215, originY + 10], stroke: "#10b981", strokeWidth: 3.5 }));
    const xTextX = isRight ? (originX - 310) : (originX + 25);
    const xTextY = isBottom ? (originY + 14) : (originY - 28);
    const xTextDesc = isRight ? `+X 轴向 (靠右导轨, 向左量宽)` : `+X 轴向 (靠左布边, 向右量宽)`;
    bedStationGroup.add(new Konva.Text({ x: xTextX, y: xTextY, text: xTextDesc, fontSize: 16, fill: isDark ? "#34d399" : "#059669", fontStyle: "bold" }));

    // +Y 轴
    const yDir = isBottom ? -1 : 1;
    const yEnd = originY + yDir * 240;
    bedStationGroup.add(new Konva.Line({ points: [originX, originY, originX, yEnd], stroke: "#38bdf8", strokeWidth: 3.5 }));
    bedStationGroup.add(new Konva.Line({ points: [originX - 10, originY + yDir * 215, originX, yEnd, originX + 10, originY + yDir * 215], stroke: "#38bdf8", strokeWidth: 3.5 }));
    const yTextX = isRight ? (originX - 260) : (originX + 25);
    const yTextY = isBottom ? (originY - 120) : (originY + 100);
    const yTextDesc = isBottom ? `+Y 轴向 (自下而上起刀逆切)` : `+Y 轴向 (顺流送料进给 · 自上而下顺切)`;
    bedStationGroup.add(new Konva.Text({ x: yTextX, y: yTextY, text: yTextDesc, fontSize: 16, fill: isDark ? "#38bdf8" : "#0284c7", fontStyle: "bold" }));

    // 基准徽标说明
    let badgeTitle = "";
    if (originStr === "right-top") badgeTitle = `[基准原点] 右上角 (靠右导轨 · 顺流进给 · 工业标准)`;
    else if (originStr === "left-top") badgeTitle = `[基准原点] 左上角 (靠左布边 · 顺流进给 · 标准CAM)`;
    else if (originStr === "right-bottom") badgeTitle = `[基准原点] 右下角 (靠右导轨 · 落料口自下而上起切)`;
    else badgeTitle = `[基准原点] 左下角 (靠左布边 · 落料口自下而上起切)`;

    const badgeX = isRight ? (originX - 350) : (originX + 20);
    const badgeY = isBottom ? (originY - 35) : (originY + 15);
    bedStationGroup.add(new Konva.Rect({ x: badgeX, y: badgeY, width: 340, height: 26, fill: isDark ? "#1c1917" : "#fef2f2", stroke: "#ef4444", strokeWidth: 1.5, cornerRadius: 4 }));
    bedStationGroup.add(new Konva.Text({ x: badgeX + 8, y: badgeY + 5, text: badgeTitle, fontSize: 14, fill: isDark ? "#fda4af" : "#dc2626", fontStyle: "bold", fontFamily: "monospace" }));

    // CAD 尺寸标注线 (工业制图规范：充足安全外延，横向清晰胶囊卡片，杜绝元素贴身挤压)
    const dimY = -130;
    const dimLineColor = "#ef4444";
    const dimBgColor = isDark ? "#450a0a" : "#fee2e2";
    const dimTextColor = isDark ? "#fecaca" : "#991b1b";

    // 顶部幅宽标注线 (水平横向胶囊卡片，匹配母卷工程尺度)
    bedStationGroup.add(new Konva.Line({ points: [0, 0, 0, dimY - 40], stroke: dimLineColor, strokeWidth: 2, dash: [6, 6] }));
    bedStationGroup.add(new Konva.Line({ points: [rollW, 0, rollW, dimY - 40], stroke: dimLineColor, strokeWidth: 2, dash: [6, 6] }));
    bedStationGroup.add(new Konva.Line({ points: [0, dimY, rollW, dimY], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Line({ points: [-18, dimY + 18, 18, dimY - 18], stroke: dimLineColor, strokeWidth: 3 }));
    bedStationGroup.add(new Konva.Line({ points: [rollW - 18, dimY + 18, rollW + 18, dimY - 18], stroke: dimLineColor, strokeWidth: 3 }));
    
    const topCapW = 560;
    const topCapH = 120;
    bedStationGroup.add(new Konva.Rect({
        x: rollW / 2 - topCapW / 2, y: dimY - topCapH / 2,
        width: topCapW, height: topCapH,
        fill: dimBgColor, stroke: dimLineColor, strokeWidth: 2, cornerRadius: 10,
        shadowColor: "rgba(239, 68, 68, 0.25)", shadowBlur: 10
    }));
    bedStationGroup.add(new Konva.Text({
        x: rollW / 2 - topCapW / 2, y: dimY - 46,
        width: topCapW, align: "center",
        text: `有效加工幅宽 (Fabric Width)`,
        fontSize: 26, fill: dimTextColor, fontStyle: "bold"
    }));
    bedStationGroup.add(new Konva.Text({
        x: rollW / 2 - topCapW / 2, y: dimY + 6,
        width: topCapW, align: "center",
        text: `W: ${rollW} mm (${(rollW/1000).toFixed(2)}m)`,
        fontSize: 34, fill: dimTextColor, fontStyle: "bold", fontFamily: "monospace"
    }));

    // 左侧工位展开长标注线 (向外拓展至 -260mm，彻底拉开与母卷粗红线的距离；采用大比例横向工业卡片，解决文字-90°旋转挤压糊字)
    const dimX = -260;
    bedStationGroup.add(new Konva.Line({ points: [0, 0, dimX - 40, 0], stroke: dimLineColor, strokeWidth: 2, dash: [6, 6] }));
    bedStationGroup.add(new Konva.Line({ points: [0, bedL, dimX - 40, bedL], stroke: dimLineColor, strokeWidth: 2, dash: [6, 6] }));
    bedStationGroup.add(new Konva.Line({ points: [dimX, 0, dimX, bedL], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Line({ points: [dimX - 18, 18, dimX + 18, -18], stroke: dimLineColor, strokeWidth: 3 }));
    bedStationGroup.add(new Konva.Line({ points: [dimX - 18, bedL + 18, dimX + 18, bedL - 18], stroke: dimLineColor, strokeWidth: 3 }));
    
    const leftCapW = 540;
    const leftCapH = 120;
    bedStationGroup.add(new Konva.Rect({
        x: dimX - leftCapW / 2, y: bedL / 2 - leftCapH / 2,
        width: leftCapW, height: leftCapH,
        fill: dimBgColor, stroke: dimLineColor, strokeWidth: 2, cornerRadius: 10,
        shadowColor: "rgba(239, 68, 68, 0.25)", shadowBlur: 10
    }));
    bedStationGroup.add(new Konva.Text({
        x: dimX - leftCapW / 2, y: bedL / 2 - 46,
        width: leftCapW, align: "center",
        text: `机台展开长 (Bed Length)`,
        fontSize: 26, fill: dimTextColor, fontStyle: "bold"
    }));
    bedStationGroup.add(new Konva.Text({
        x: dimX - leftCapW / 2, y: bedL / 2 + 6,
        width: leftCapW, align: "center",
        text: `L: ${bedL} mm (${(bedL/1000).toFixed(2)}m)`,
        fontSize: 34, fill: dimTextColor, fontStyle: "bold", fontFamily: "monospace"
    }));

    bedStationGroup.position({ x: 0, y: winStartY });
    bedStationGroup.listening(false);

    renderRemnantHighlight();
    mainLayer.batchDraw();
    drawRulers();
    updateStatusBar();
}

export function resetToBedView() {
    if (!stage) return;
    const data = state.getCurrentCaseData();
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const rollW = data.rollW || 2000;
    const cw = stage.width();
    const ch = stage.height();

    const RULER_T = 24;
    const marginL = 230; // 充分留出左侧 -260mm 尺寸线与大胶囊卡片的呼吸留白空间
    const marginR = 60;
    const marginT = 120; // 充分留出顶部 -130mm 幅宽尺寸线的呼吸空间
    const marginB = 70;

    const availW = cw - RULER_T - marginL - marginR;
    const availH = ch - RULER_T - marginT - marginB;

    const scaleX = availW / rollW;
    const scaleY = availH / bedL;
    const scale = Math.min(scaleX, scaleY, 0.45);

    stage.scale({ x: scale, y: scale });

    const anchorX = RULER_T + marginL + (availW - rollW * scale) / 2;
    const anchorY = RULER_T + marginT + (availH - bedL * scale) / 2;

    stage.position({
        x: anchorX,
        y: anchorY - winStartY * scale
    });

    if (bedStationGroup) {
        bedStationGroup.position({ x: 0, y: winStartY });
    }

    drawRulers();
    updateStatusBar();
    if (mainLayer) mainLayer.batchDraw();
}

export function resetToFlowView() {
    if (!stage) return;
    const data = state.getCurrentCaseData();
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const rollW = data.rollW || 2000;
    const flowL = bedL + 8000;
    const cw = stage.width();
    const ch = stage.height();

    const RULER_T = 24;
    const marginL = 200;
    const marginR = 60;
    const marginT = 100;
    const marginB = 50;

    const availW = cw - RULER_T - marginL - marginR;
    const availH = ch - RULER_T - marginT - marginB;

    const scaleX = availW / rollW;
    const scaleY = availH / flowL;
    const scale = Math.min(scaleX, scaleY, 0.22);

    stage.scale({ x: scale, y: scale });
    stage.position({
        x: RULER_T + marginL + (availW - rollW * scale) / 2,
        y: RULER_T + marginT - winStartY * scale
    });
    drawRulers();
    updateStatusBar();
    if (mainLayer) mainLayer.batchDraw();
}

export function viewFullRoll() {
    if (!stage) return;
    const data = state.getCurrentCaseData();
    const totalL = data.totalRollL || 60000;
    const rollW = data.rollW || 2000;
    const cw = stage.width();
    const ch = stage.height();

    const RULER_T = 24;
    const marginL = 120;
    const marginR = 60;
    const marginT = 60;
    const marginB = 40;

    const availW = cw - RULER_T - marginL - marginR;
    const availH = ch - RULER_T - marginT - marginB;

    const scaleX = availW / rollW;
    const scaleY = availH / totalL;
    const scale = Math.min(scaleX, scaleY, 0.12);

    stage.scale({ x: scale, y: scale });
    stage.position({
        x: RULER_T + marginL + (availW - rollW * scale) / 2,
        y: RULER_T + marginT
    });
    drawRulers();
    updateStatusBar();
    if (mainLayer) mainLayer.batchDraw();
}

export function fitView() {
    resetToBedView();
}

export function resetZoom() {
    if (!stage) return;
    stage.scale({ x: 0.25, y: 0.25 });
    drawRulers();
    updateStatusBar();
}

export function updateStatusBar() {
    if (!stage) return;
    const el = document.getElementById("sb-scale");
    if (el) {
        el.innerText = `${(stage.scaleX() * 100).toFixed(1)}%`;
    }
    const data = state.getCurrentCaseData();
    if (!data) return;
    const originLbl = document.getElementById("sb-origin-lbl");
    if (originLbl) {
        let maxConfirmedY = 0;
        (data.pieces || []).filter(p => p.confirmed).forEach(p => {
            if (p.y + p.l > maxConfirmedY) maxConfirmedY = p.y + p.l;
        });
        const winY = data.windowStartY || 0;
        const bedL = data.bedL || 5000;
        const originDesc = (data.cutOrigin || "right-bottom").includes("right") ? "靠右导轨" : "靠左布边";
        originLbl.innerText = `${originDesc} · 当前工位 [Y=${winY} ~ ${winY+bedL}mm] | 母卷未切布头基准 Y=${maxConfirmedY > 0 ? maxConfirmedY + 'mm (' + (maxConfirmedY/1000).toFixed(2) + 'm)' : '0mm (整卷全新)'}`;
    }
}
