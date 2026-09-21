/**
 * 全景雷达条与 60FPS 平滑穿梭交互插件 (Radar Scrubber Plugin)
 */
import { stage, mainLayer, bedStationGroup, dynBedRangeBadge, dynBedBottomBadge, defectGroup } from '../cad/cad-stage.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { updateStatusBar } from '../cad/cad-renderer.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';

let isRadarDragging = false;
let dragScreenBedY = null;
let radarRafId = null;

export function updateFabricScrollPosition(targetY) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    targetY = Math.max(0, Math.min(totalL - bedL, Math.round(targetY)));

    const prevY = data.windowStartY || 0;
    data.windowStartY = targetY;

    // 1. 红框工位在世界坐标系内对齐到新的 targetY
    if (bedStationGroup) {
        bedStationGroup.position({ x: 0, y: targetY });
    }

    // 2. 保证红框工位在屏幕视口像素位置绝对不动：
    // stage.y() 随着 targetY 相应偏移，长卷布料自然在固定红框内上下贯穿滚动
    if (stage) {
        const scale = stage.scaleY();
        const anchorScreenY = (dragScreenBedY !== null) ? dragScreenBedY : (stage.y() + prevY * scale);
        stage.y(anchorScreenY - targetY * scale);
    }

    // 3. 更新工位顶部标牌与底部切断线下死点数值
    if (dynBedRangeBadge) {
        dynBedRangeBadge.text(`【数控裁床加工工位】当前裁切范围: ${targetY} ~ ${targetY + bedL} mm (${(targetY/1000).toFixed(1)}m ~ ${((targetY+bedL)/1000).toFixed(1)}m) | 机台长 ${(bedL/1000).toFixed(1)}m`);
    }
    if (dynBedBottomBadge) {
        dynBedBottomBadge.text(`[工位切刀口/下死点基准] 切断线 Y=${targetY + bedL}mm (${((targetY+bedL)/1000).toFixed(1)}m)`);
    }

    // 4. 同步侧边栏输入框
    const inp = document.getElementById("inp-window-start-y");
    if (inp) inp.value = targetY;

    // 5. 同步雷达滑块位置与文字
    const winEl = document.getElementById("radar-window");
    if (winEl) {
        const leftPct = (targetY / totalL) * 100;
        winEl.style.left = `${leftPct}%`;
        const textEl = document.getElementById("radar-window-text");
        if (textEl) {
            textEl.innerText = `${(targetY/1000).toFixed(1)}~${((targetY+bedL)/1000).toFixed(1)}m`;
        }
    }

    if (mainLayer) mainLayer.batchDraw();
    drawRulers();
    updateStatusBar();
    bus.emit('station:moved', { targetY, bedL, winStartY: targetY, winEndY: targetY + bedL });
}

export function renderRadar() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const winStartY = data.windowStartY || 0;
    const defects = data.globalDefects || data.defects || [];

    const infoEl = document.getElementById("radar-roll-info");
    if (infoEl) {
        infoEl.innerText = `全长: ${(totalL/1000).toFixed(0)}m (${totalL}mm) | 全局疵点: ${defects.length} 处`;
    }

    const track = document.getElementById("radar-track");
    if (!track) return;

    // 清理旧刻度与旧疵点标，保留 #radar-window
    const oldScales = track.querySelectorAll(".radar-scale-line, .radar-scale-mark, .radar-defect-marker");
    oldScales.forEach(el => el.remove());

    const winEl = document.getElementById("radar-window");
    const leftPct = (winStartY / totalL) * 100;
    const widthPct = Math.min(100 - leftPct, (bedL / totalL) * 100);
    if (winEl) {
        winEl.style.left = `${leftPct}%`;
        winEl.style.width = `${Math.max(2.5, widthPct)}%`;
        const textEl = document.getElementById("radar-window-text");
        if (textEl) {
            textEl.innerText = `${(winStartY/1000).toFixed(1)}~${((winStartY+bedL)/1000).toFixed(1)}m`;
        }
    }

    // 绘制米数刻度
    const stepM = totalL > 40000 ? 10 : 5;
    const stepMm = stepM * 1000;
    for (let posMm = 0; posMm <= totalL; posMm += stepMm) {
        const pct = (posMm / totalL) * 100;

        const line = document.createElement("div");
        line.className = "radar-scale-line";
        line.style.left = `${pct}%`;
        track.appendChild(line);

        const mark = document.createElement("div");
        mark.className = "radar-scale-mark";
        mark.style.left = `${pct}%`;
        mark.innerText = `${(posMm/1000).toFixed(0)}m`;
        track.appendChild(mark);
    }

    // 绘制全局疵点标记
    defects.forEach(d => {
        const dPct = (d.y / totalL) * 100;
        const marker = document.createElement("div");
        const inBed = (d.y + d.h >= winStartY && d.y <= winStartY + bedL);
        marker.className = inBed ? "radar-defect-marker" : "radar-defect-marker warning";
        marker.style.left = `${dPct}%`;
        marker.dataset.defectY = d.y;
        marker.dataset.defectH = d.h;
        marker.title = `疵点 #${d.id} [${d.desc || '疵点'}] 全局Y: ${d.y}mm (${(d.y/1000).toFixed(2)}m) 宽:${d.w}mm 长:${d.h}mm`;
        track.appendChild(marker);
    });
}

export function updateDefectRadarActiveState() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const track = document.getElementById("radar-track");
    if (!track) return;
    const markers = track.querySelectorAll(".radar-defect-marker");
    markers.forEach(marker => {
        const y = parseFloat(marker.dataset.defectY || 0);
        const h = parseFloat(marker.dataset.defectH || 0);
        const inBed = (y + h >= winStartY && y <= winStartY + bedL);
        if (inBed) {
            marker.classList.remove("warning");
        } else {
            marker.classList.add("warning");
        }
    });
}

export function updateDefectVisualStates() {
    const data = state.getCurrentCaseData();
    if (!data || !defectGroup) return;
    const winStartY = data.windowStartY || 0;
    const bedL = data.bedL || 5000;
    const winEndY = winStartY + bedL;
    const isDark = (document.documentElement.getAttribute("data-theme") !== "light");
    const defects = data.globalDefects || data.defects || [];

    defects.forEach(d => {
        const inBed = (d.y + d.h >= winStartY && d.y <= winEndY);
        const inUpcoming = (d.y > winEndY);
        const zone = defectGroup.findOne(`.defect-zone-${d.id}`);
        const box = defectGroup.findOne(`.defect-box-${d.id}`);
        const txt = defectGroup.findOne(`.defect-txt-${d.id}`);

        if (zone) {
            if (inBed) {
                zone.visible(true);
                zone.fill(isDark ? "rgba(239, 68, 68, 0.25)" : "rgba(239, 68, 68, 0.15)");
                zone.stroke("#dc2626");
                zone.strokeWidth(2);
                zone.dash([8, 4]);
            } else if (inUpcoming) {
                zone.visible(true);
                zone.fill(isDark ? "rgba(245, 158, 11, 0.16)" : "rgba(245, 158, 11, 0.12)");
                zone.stroke("#f59e0b");
                zone.strokeWidth(1.5);
                zone.dash([6, 4]);
            } else {
                zone.visible(false);
            }
        }
        if (box) {
            if (inBed) {
                box.fill("#ef4444");
                box.stroke("#991b1b");
                box.strokeWidth(2);
            } else if (inUpcoming) {
                box.fill("#d97706");
                box.stroke("#b45309");
                box.strokeWidth(1.5);
            } else {
                box.fill(isDark ? "#3f3f46" : "#cbd5e1");
                box.stroke(isDark ? "#52525b" : "#94a3b8");
                box.strokeWidth(1);
            }
        }
        if (txt) {
            if (inBed) {
                txt.text(`[工位避让疵点] #${d.id} ${d.w}×${d.h}mm (工位Y: ${d.y - winStartY}mm | 全局: ${(d.y/1000).toFixed(2)}m)`);
                txt.fill(isDark ? "#fecaca" : "#991b1b");
                txt.fontSize(17);
                txt.fontStyle("bold");
            } else if (inUpcoming) {
                txt.text(`[进料预警] #${d.id} [${d.desc || '瑕疵'}] 全局 ${(d.y/1000).toFixed(2)}m (距工位 +${((d.y - winEndY)/1000).toFixed(2)}m)`);
                txt.fill(isDark ? "#fde68a" : "#92400e");
                txt.fontSize(17);
                txt.fontStyle("bold");
            } else {
                txt.text(`[已过段] #${d.id} ${(d.y/1000).toFixed(2)}m`);
                txt.fill(isDark ? "#71717a" : "#94a3b8");
                txt.fontSize(15);
                txt.fontStyle("normal");
            }
        }
    });
    if (mainLayer) mainLayer.batchDraw();
}

export function setupRadarInteraction() {
    const track = document.getElementById("radar-track");
    const winEl = document.getElementById("radar-window");
    if (!track || !winEl) return;
    if (track.dataset.bound === "true") return;
    track.dataset.bound = "true";

    let cachedTrackRect = null;
    let grabOffsetX = 0;
    let pendingTargetY = null;

    const applyScroll = () => {
        if (pendingTargetY !== null) {
            updateFabricScrollPosition(pendingTargetY);
            pendingTargetY = null;
        }
        radarRafId = null;
    };

    const scheduleScroll = (targetY) => {
        pendingTargetY = targetY;
        if (!radarRafId) {
            radarRafId = requestAnimationFrame(applyScroll);
        }
    };

    const onPointerMove = (e) => {
        if (!isRadarDragging || !cachedTrackRect) return;
        const data = state.getCurrentCaseData();
        if (!data) return;
        const totalL = data.totalRollL || 60000;
        const trackW = cachedTrackRect.width;
        if (trackW <= 0) return;

        const handleLeftPx = e.clientX - cachedTrackRect.left - grabOffsetX;
        const targetY = (handleLeftPx / trackW) * totalL;
        scheduleScroll(targetY);
    };

    const onPointerUp = (e) => {
        if (!isRadarDragging) return;
        isRadarDragging = false;
        dragScreenBedY = null;
        winEl.classList.remove("dragging");
        document.body.style.cursor = "";

        if (radarRafId) {
            cancelAnimationFrame(radarRafId);
            radarRafId = null;
        }

        const data = state.getCurrentCaseData();
        const totalL = data ? (data.totalRollL || 60000) : 60000;
        const bedL = data ? (data.bedL || 5000) : 5000;
        let finalY = (pendingTargetY !== null) ? pendingTargetY : (data ? (data.windowStartY || 0) : 0);
        pendingTargetY = null;

        // 工位智能磁吸 (Station Snapping)
        let maxCutY = 0;
        if (data && data.pieces && data.pieces.length > 0) {
            maxCutY = Math.max(...data.pieces.map(p => p.y + p.l));
        }
        if (maxCutY > 0 && Math.abs(finalY - maxCutY) <= 800) {
            finalY = Math.round(maxCutY);
        } else {
            const nearestStation = Math.round(finalY / bedL) * bedL;
            if (Math.abs(finalY - nearestStation) <= 800) {
                finalY = nearestStation;
            } else {
                finalY = Math.round(finalY / 500) * 500;
            }
        }
        finalY = Math.max(0, Math.min(totalL - bedL, finalY));
        updateFabricScrollPosition(finalY);

        try {
            if (winEl.releasePointerCapture) winEl.releasePointerCapture(e.pointerId);
            if (track.releasePointerCapture) track.releasePointerCapture(e.pointerId);
        } catch (err) {}

        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);

        updateDefectVisualStates();
        updateDefectRadarActiveState();
        bus.emit('radar:dragend', { finalY });
    };

    // 1. 滑块自身 Pointer 拖拽刷动
    winEl.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        isRadarDragging = true;
        cachedTrackRect = track.getBoundingClientRect();
        const winRect = winEl.getBoundingClientRect();
        grabOffsetX = e.clientX - winRect.left;

        const data = state.getCurrentCaseData();
        const curWinY = data.windowStartY || 0;
        const scale = stage ? stage.scaleY() : 1;
        dragScreenBedY = stage ? (stage.y() + curWinY * scale) : 0;

        winEl.classList.add("dragging");
        document.body.style.cursor = "ew-resize";

        try {
            winEl.setPointerCapture(e.pointerId);
        } catch (err) {}

        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
    });

    // 2. 点击或在轨道上任意滑动
    track.addEventListener("pointerdown", (e) => {
        if (e.target === winEl || winEl.contains(e.target)) return;
        e.preventDefault();
        cachedTrackRect = track.getBoundingClientRect();
        const data = state.getCurrentCaseData();
        if (!data) return;
        const totalL = data.totalRollL || 60000;
        const bedL = data.bedL || 5000;
        const trackW = cachedTrackRect.width;
        if (trackW <= 0) return;

        const winWidthPx = Math.max(16, (bedL / totalL) * trackW);
        grabOffsetX = winWidthPx / 2;
        const clickLeftPx = (e.clientX - cachedTrackRect.left) - grabOffsetX;
        const targetY = (clickLeftPx / trackW) * totalL;

        const scale = stage ? stage.scaleY() : 1;
        dragScreenBedY = stage ? (stage.y() + (data.windowStartY || 0) * scale) : 0;
        updateFabricScrollPosition(targetY);

        isRadarDragging = true;
        winEl.classList.add("dragging");
        document.body.style.cursor = "ew-resize";

        try {
            track.setPointerCapture(e.pointerId);
        } catch (err) {}

        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerUp);
    });

    // 3. 鼠标滚轮在雷达条上滚动
    track.addEventListener("wheel", (e) => {
        e.preventDefault();
        const data = state.getCurrentCaseData();
        if (!data) return;
        const totalL = data.totalRollL || 60000;
        const bedL = data.bedL || 5000;
        const curY = data.windowStartY || 0;
        const step = (e.deltaY > 0 ? 1 : -1) * (totalL > 40000 ? 1000 : 500);
        const targetY = Math.max(0, Math.min(totalL - bedL, curY + step));
        updateFabricScrollPosition(targetY);
        updateDefectVisualStates();
        updateDefectRadarActiveState();
        bus.emit('radar:wheel', { targetY });
    }, { passive: false });
}

export function advanceBed(delta) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const currentY = data.windowStartY || 0;

    let nextY = currentY + delta * bedL;
    nextY = Math.max(0, Math.min(totalL - bedL, nextY));
    updateFabricScrollPosition(nextY);
}

export function smartAdvanceBed() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const curY = data.windowStartY || 0;

    let maxCutY = 0;
    if (data.pieces && data.pieces.length > 0) {
        maxCutY = Math.max(...data.pieces.map(p => p.y + p.l));
    }
    if (data.cuts && data.cuts.length > 0) {
        data.cuts.filter(c => c.type === "横切").forEach(c => {
            if (c.pos > maxCutY) maxCutY = c.pos;
        });
    }

    let nextY = 0;
    if (maxCutY > 0) {
        nextY = Math.round(maxCutY);
    } else {
        nextY = curY + bedL;
    }

    nextY = Math.max(0, Math.min(totalL - bedL, nextY));
    updateFabricScrollPosition(nextY);
    updateDefectVisualStates();
    updateDefectRadarActiveState();
    bus.emit('bed:smart-advanced', { nextY });
}
