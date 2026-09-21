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
        remnantGroup.add(rGroup);
    });

    // -------------------------------------------------------------
    // D. 绘制合格成品 (翡翠绿工程色)
    // -------------------------------------------------------------
    (data.pieces || []).forEach((p) => {
        const pGroup = new Konva.Group();
        const pFill = isDark ? "#065f46" : "#ecfdf5";
        const pStroke = isDark ? "#10b981" : "#059669";
        const pTitleFill = isDark ? "#ecfdf5" : "#065f46";
        const pSubFill = isDark ? "#a7f3d0" : "#047857";
        const pGrainFill = isDark ? "#6ee7b7" : "#059669";

        pGroup.add(new Konva.Rect({
            x: p.x, y: p.y, width: p.w, height: p.l,
            fill: pFill, stroke: pStroke, strokeWidth: 3,
            shadowColor: isDark ? "#059669" : "#cbd5e1", shadowBlur: 4,
            shadowOpacity: isDark ? 0.6 : 0.25
        }));
        pGroup.add(new Konva.Text({
            x: p.x + p.w / 2 - 120, y: p.y + p.l / 2 - 25,
            text: p.name, width: 240, align: "center",
            fontSize: 26, fill: pTitleFill, fontStyle: "bold"
        }));
        pGroup.add(new Konva.Text({
            x: p.x + p.w / 2 - 120, y: p.y + p.l / 2 + 8,
            text: `${p.w} × ${p.l} mm`, width: 240, align: "center",
            fontSize: 20, fill: pSubFill, fontFamily: "monospace"
        }));
        pGroup.add(new Konva.Text({
            x: p.x + 10, y: p.y + 10,
            text: "经向 (Length)", fontSize: 16, fill: pGrainFill
        }));
        pieceGroup.add(pGroup);
    });

    // -------------------------------------------------------------
    // E. 绘制切刀顺序与刀路轨迹 (Guillotine Cuts)
    // -------------------------------------------------------------
    const currentLimit = state.currentCutStepLimit;
    (data.cuts || []).forEach((c) => {
        if (c.step > currentLimit) return;

        const isHoriz = (c.type === "横切");
        const line = isHoriz ?
            new Konva.Line({
                points: [c.start, c.pos, c.end, c.pos],
                stroke: "#f43f5e", strokeWidth: 4, dash: [14, 8]
            }) :
            new Konva.Line({
                points: [c.pos, c.start, c.pos, c.end],
                stroke: "#f43f5e", strokeWidth: 4, dash: [14, 8]
            });

        cutGroup.add(line);

        const badgeX = isHoriz ? c.start + 30 : c.pos;
        const badgeY = isHoriz ? c.pos : c.start + 30;

        cutGroup.add(new Konva.Circle({
            x: badgeX, y: badgeY, radius: 16, fill: "#f43f5e"
        }));
        cutGroup.add(new Konva.Text({
            x: badgeX - 10, y: badgeY - 8, text: `${c.step}`,
            fontSize: 16, fill: "#ffffff", fontStyle: "bold", fontFamily: "monospace"
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

    const originStr = (data.cutOrigin || "right-top").toLowerCase();
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

    // CAD 尺寸标注线
    const dimY = -65;
    const dimLineColor = "#ef4444";
    const dimBgColor = isDark ? "#450a0a" : "#fee2e2";
    const dimTextColor = isDark ? "#fecaca" : "#991b1b";

    // 顶部幅宽标注线
    bedStationGroup.add(new Konva.Line({ points: [0, 0, 0, dimY - 18], stroke: dimLineColor, strokeWidth: 1.5, dash: [4, 4] }));
    bedStationGroup.add(new Konva.Line({ points: [rollW, 0, rollW, dimY - 18], stroke: dimLineColor, strokeWidth: 1.5, dash: [4, 4] }));
    bedStationGroup.add(new Konva.Line({ points: [0, dimY, rollW, dimY], stroke: dimLineColor, strokeWidth: 2 }));
    bedStationGroup.add(new Konva.Line({ points: [-10, dimY + 10, 10, dimY - 10], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Line({ points: [rollW - 10, dimY + 10, rollW + 10, dimY - 10], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Rect({ x: rollW / 2 - 185, y: dimY - 15, width: 370, height: 28, fill: dimBgColor, stroke: dimLineColor, strokeWidth: 1.5, cornerRadius: 4 }));
    bedStationGroup.add(new Konva.Text({ x: rollW / 2 - 175, y: dimY - 8, text: `[有效幅宽] W: ${rollW} mm (${(rollW/1000).toFixed(2)}m)`, fontSize: 15, fill: dimTextColor, fontStyle: "bold", fontFamily: "monospace" }));

    // 左侧工位展开长标注线
    const dimX = -85;
    bedStationGroup.add(new Konva.Line({ points: [0, 0, dimX - 18, 0], stroke: dimLineColor, strokeWidth: 1.5, dash: [4, 4] }));
    bedStationGroup.add(new Konva.Line({ points: [0, bedL, dimX - 18, bedL], stroke: dimLineColor, strokeWidth: 1.5, dash: [4, 4] }));
    bedStationGroup.add(new Konva.Line({ points: [dimX, 0, dimX, bedL], stroke: dimLineColor, strokeWidth: 2 }));
    bedStationGroup.add(new Konva.Line({ points: [dimX - 10, 10, dimX + 10, -10], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Line({ points: [dimX - 10, bedL + 10, dimX + 10, bedL - 10], stroke: dimLineColor, strokeWidth: 2.5 }));
    bedStationGroup.add(new Konva.Rect({ x: dimX - 28, y: bedL / 2 - 120, width: 26, height: 240, fill: dimBgColor, stroke: dimLineColor, strokeWidth: 1.5, cornerRadius: 4 }));
    bedStationGroup.add(new Konva.Text({ x: dimX - 9, y: bedL / 2 + 100, text: `机台展开长 L: ${bedL} mm (${(bedL/1000).toFixed(2)}m)`, rotation: -90, fontSize: 15, fill: dimTextColor, fontStyle: "bold", fontFamily: "monospace" }));

    bedStationGroup.position({ x: 0, y: winStartY });
    bedStationGroup.listening(false);

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
    const marginL = 130;
    const marginR = 60;
    const marginT = 100;
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
    const marginL = 130;
    const marginR = 60;
    const marginT = 90;
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
}
