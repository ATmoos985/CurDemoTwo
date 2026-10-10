/**
 * 母卷导航与工位接续。待报工方案在移动前必须处理。
 */
import { stage, mainLayer, bedStationGroup, defectGroup } from '../cad/cad-stage.js';
import { drawRulers } from '../cad/cad-rulers.js';
import { updateStatusBar, renderScene, resetToBedView } from '../cad/cad-renderer.js';
import { clearRemnantSelection } from '../cad/cad-remnant-highlight.js';
import { recalculateRollStats, getDemandsFromUI } from '../solver/quota-manager.js';
import { updateUIInfo } from '../solver/solver-client.js';
import { state } from '../../core/state.js';
import { bus } from '../../core/event-bus.js';
import {queuedRollEnd, queuedStockLength, queuedQuantities} from '../solver/report-queue.js';
import {feedLengthLimits, suggestedFeedLength} from './feed-window.js';
import {renderMaterialInspection} from '../layout/workbench-panels.js';

export function requireStationReport() {
    if (!state.pendingPlan) return false;
    bus.emit('report:requested');
    return true;
}

export function nextCutPosition(data) {
    if (!data) return 0;
    const receiptEnd = data.lastReceipt?.feedPortType === 'roll' ? data.lastReceipt.windowStartY + data.lastReceipt.actualCutLen : 0;
    return Math.max(data.stockUsedLength || 0, receiptEnd, queuedRollEnd(data.rollId), 0, ...(data.pieces || []).map(p => p.y + p.l), ...(data.cuts || []).filter(c => c.type === '横切').map(c => c.pos));
}

export function getSnappableNextStation(data) {
    if (!data) return null;
    if (state.currentCutMode === 'remnant') return 0;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const maxScrollY = Math.max(0, totalL - bedL);
    const stationY = nextCutPosition(data);
    if (!Number.isFinite(stationY)) return null;
    return Math.max(0, Math.min(maxScrollY, Number(stationY.toFixed(6))));
}

export function getSnapThresholdMm(trackWidth, totalL = 60000) {
    if (!trackWidth || trackWidth <= 0) return 1000;
    const pxPerMm = trackWidth / totalL;
    return Math.max(800, Math.min(1500, 16 / pxPerMm));
}

function stationRange(start, length, isSnapped = false) {
    if (state.getCurrentCaseData().materialAvailable === false) return '切割区域 —';
    const sheet = state.currentCutMode === 'remnant';
    const rangeText = `${sheet ? '料头区域' : '切割区域'} Y ${start.toLocaleString()}–${(start + length).toLocaleString()} mm · ${sheet ? '长度' : '拉布'} ${length.toLocaleString()} mm`;
    return isSnapped && !sheet ? `${rangeText} (待切接续工位)` : rangeText;
}

export function updateFabricScrollPosition(targetY, silent = false) {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const maxScrollY = Math.max(0, totalL - bedL);
    targetY = Math.max(0, Math.min(maxScrollY, Number(targetY.toFixed(6))));

    const prevY = data.windowStartY || 0;
    if (!silent && targetY !== prevY && requireStationReport()) return false;
    data.windowStartY = targetY;

    // 1. 红框工位在世界坐标系内对齐到新的 targetY
    if (bedStationGroup) {
        bedStationGroup.position({ x: 0, y: targetY });
    }

    // 2. 保证红框工位在屏幕视口像素位置绝对不动：
    // stage.y() 随着 targetY 相应偏移，长卷布料自然在固定红框内上下贯穿滚动
    if (stage) {
        const scale = stage.scaleY();
        const anchorScreenY = (stage.y() + prevY * scale);
        stage.y(anchorScreenY - targetY * scale);
    }

    // 4. 同步侧边栏输入框
    const inp = document.getElementById("inp-window-start-y");
    if (inp) inp.value = targetY;

    // 5. 同步雷达滑块位置与文字
    const winEl = document.getElementById("radar-window");
    if (winEl) {
        const leftPct = (targetY / totalL) * 100;
        winEl.style.left = `${leftPct}%`;
        winEl.setAttribute('aria-valuenow', targetY);
        const snapStation = getSnappableNextStation(data);
        const isSnapped = (snapStation !== null && Math.abs(targetY - snapStation) < 1);
        if (winEl.classList?.toggle) {
            winEl.classList.toggle('snapped', isSnapped);
        }
        winEl.setAttribute('aria-valuetext', stationRange(targetY, bedL, isSnapped));
        const textEl = document.getElementById("radar-window-text");
        if (textEl) {
            textEl.innerText = stationRange(targetY, bedL, isSnapped);
        }
    }
    updateFeedControls();

    if (mainLayer) mainLayer.batchDraw();
    drawRulers();
    updateStatusBar();
    bus.emit('station:moved', { targetY, bedL, winStartY: targetY, winEndY: targetY + bedL });
    return true;
}

export function resizeFeedWindow(length, {live = false} = {}) {
    const data = state.getCurrentCaseData(), input = document.getElementById('inp-bed-l');
    if (!data || state.currentCutMode === 'remnant' || data.materialAvailable === false) return false;
    if (requireStationReport()) {if(input)input.value=data.bedL;return false;}
    const {min,max} = feedLengthLimits(data,queuedStockLength(data.rollId));
    if (!Number.isFinite(length) || length < min || length > max) {
        input?.setCustomValidity(`拉布长度须为 ${min}–${max} mm，不能超过卷尾或可用余量。`);
        input?.reportValidity();
        return false;
    }
    input?.setCustomValidity('');
    data.bedL = length;
    if(input)input.value=length;
    data.cuts=[];
    recalculateRollStats(data);renderScene();renderRadar();updateUIInfo();
    if (!live) {resetToBedView();bus.emit('feed:resized',{length});}
    return true;
}

export function updateFeedControls() {
    const data=state.getCurrentCaseData();if(!data)return;
    const sheet=state.currentCutMode==='remnant', {min,max}=feedLengthLimits(data,queuedStockLength(data.rollId));
    const input=document.getElementById('inp-bed-l'), end=document.getElementById('radar-resize-end'), fit=document.getElementById('btn-feed-fit');
    if(input){input.disabled=sheet || data.materialAvailable===false;input.min=min;input.max=max;}
    if(end){
        end.hidden=sheet || data.materialAvailable===false;
        end.style.left=((data.windowStartY||0)+data.bedL)/data.totalRollL*100+'%';
        for(const [name,value] of Object.entries({'aria-valuemin':min,'aria-valuemax':max,'aria-valuenow':data.bedL,'aria-valuetext':`拉布 ${data.bedL} mm`}))end.setAttribute(name,value);
    }
    if(fit){
        const staged=queuedQuantities();
        const length=suggestedFeedLength({rollW:data.rollW,trimStart:data.trimStart,allowRotation:data.allowRotation,allowLongitudinal:data.allowLongitudinal!==false,
            demands:getDemandsFromUI().map(d=>({...d,demand:Math.max(0,d.demand-(staged[d.id]||0))}))});
        fit.hidden=sheet;fit.disabled=!length || length>max || data.materialAvailable===false;
        fit.textContent=length?`按最长单片 · ${length.toLocaleString()} mm`:'按最长单片';
        fit.title=length>max?'当前余量或卷尾放不下最长单片，请选择其他材料。':'按单片尺寸设置，含切头量、不含疵点避让；不代表所有件数能一次排完。';
        fit.onclick=()=>resizeFeedWindow(length);
    }
    if(document.getElementById('material-manager-modal')?.open)renderMaterialInspection();
}

export function renderRadar() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const winStartY = data.windowStartY || 0;
    const defects = data.globalDefects || data.defects || [];

    const track = document.getElementById("radar-track");
    updateFeedControls();
    if (!track) return;

    // 清理旧刻度与旧疵点标及历史实切块，保留 #radar-window
    const oldScales = track.querySelectorAll(".radar-scale-line, .radar-scale-mark, .radar-defect-marker, .radar-consumed-history, .radar-datum-pin");
    oldScales.forEach(el => el.remove());

    // 计算当前母卷已实切末端与布头基准 (0 ~ maxConfirmedY)
    let maxConfirmedY = data.stockUsedLength || 0;
    (data.pieces || []).filter(p => p.confirmed).forEach(p => {
        if (p.y + p.l > maxConfirmedY) maxConfirmedY = p.y + p.l;
    });
    if (data.lastReceipt && data.lastReceipt.windowStartY !== undefined && data.lastReceipt.actualCutLen) {
        const rEnd = data.lastReceipt.windowStartY + data.lastReceipt.actualCutLen;
        if (rEnd > maxConfirmedY) maxConfirmedY = rEnd;
    }

    const infoEl = document.getElementById("radar-roll-info");
    if (infoEl) {
        const sheet = state.currentCutMode === 'remnant', source = state.loadedRemnant;
        const consumed = sheet && data.lastReceipt?.sourceRemnantId === source?.id && data.lastReceipt?.status !== 'REVERSED';
        infoEl.innerText = data.materialAvailable === false ? '材料信息 —' : sheet
            ? `料头 ${source?.id || '—'} · ${data.rollW.toLocaleString()} × ${bedL.toLocaleString()} mm · ${consumed ? '已核销' : '未核销'} · 疵点 ${defects.length} 处`
            : `幅宽 ${data.rollW.toLocaleString()} mm · 全长 ${totalL.toLocaleString()} mm · 已报工 ${(data.stockUsedLength || 0).toLocaleString()} mm · 余量 ${(data.stockRemainingLength ?? totalL - (data.stockUsedLength || 0)).toLocaleString()} mm · 疵点 ${defects.length} 处`;
        infoEl.title = infoEl.textContent;
    }

    if (maxConfirmedY > 0) {
        const historyPct = Math.min(100, (maxConfirmedY / totalL) * 100);
        const histEl = document.createElement("div");
        histEl.className = "radar-consumed-history";
        histEl.style.position = "absolute";
        histEl.style.left = "0%";
        histEl.style.width = `${historyPct}%`;

        histEl.style.pointerEvents = "none";
        histEl.title = `已实切下料出库历史: 0 ~ ${maxConfirmedY} mm (${(maxConfirmedY/1000).toFixed(2)}m)`;
        track.appendChild(histEl);

        const pinEl = document.createElement("div");
        pinEl.className = "radar-datum-pin";
        pinEl.style.position = "absolute";
        pinEl.style.left = `${historyPct}%`;
        pinEl.title = `当前有效布头基准点 Y=${maxConfirmedY}mm`;
        track.appendChild(pinEl);
    }

    const winEl = document.getElementById("radar-window");
    const leftPct = (winStartY / totalL) * 100;
    const widthPct = Math.min(100 - leftPct, (bedL / totalL) * 100);
    if (winEl) {
        winEl.style.left = `${leftPct}%`;
        winEl.style.width = `${widthPct}%`;
        winEl.setAttribute('aria-valuemin', 0);
        winEl.setAttribute('aria-valuemax', Math.max(0, totalL - bedL));
        winEl.setAttribute('aria-valuenow', winStartY);
        const snapStation = getSnappableNextStation(data);
        const isSnapped = (snapStation !== null && Math.abs(winStartY - snapStation) < 1);
        if (winEl.classList?.toggle) {
            winEl.classList.toggle('snapped', isSnapped);
        }
        winEl.setAttribute('aria-valuetext', stationRange(winStartY, bedL, isSnapped));
        const textEl = document.getElementById("radar-window-text");
        if (textEl) {
            textEl.innerText = stationRange(winStartY, bedL, isSnapped);
        }
    }

    // Keep meter labels readable even for a short remnant or a long mother roll.
    const stepMm = radarTickStep(totalL, track.clientWidth);
    for (let posMm = 0; posMm <= totalL; posMm += stepMm) {
        const pct = (posMm / totalL) * 100;

        const line = document.createElement("div");
        line.className = "radar-scale-line";
        line.style.left = `${pct}%`;
        track.appendChild(line);

        const mark = document.createElement("div");
        mark.className = "radar-scale-mark";
        mark.style.left = `${pct}%`;
        mark.innerText = `${posMm/1000}`;
        if (posMm === 0) mark.classList.add('first');
        if (posMm === totalL) mark.classList.add('last');
        track.appendChild(mark);
    }

    // 绘制全局疵点标记
    defects.forEach(d => {
        const dPct = (d.y / totalL) * 100;
        const marker = document.createElement("div");
        const inBed = (d.y + d.h >= winStartY && d.y <= winStartY + bedL);
        marker.className = inBed ? "radar-defect-marker" : "radar-defect-marker warning";
        marker.style.left = `${dPct}%`;
        marker.style.width = `${Math.max(0, d.h / totalL * 100)}%`;
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

export function radarTickStep(totalL, width = 600) {
    const rough = totalL / Math.max(1, Math.floor((width || 600) / 72));
    const power = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
    return [1, 2, 5, 10].map(n => n * power).find(n => n >= rough);
}
export function setupRadarInteraction() {
    const track = document.getElementById('radar-track');
    const winEl = document.getElementById('radar-window');
    const endEl = document.getElementById('radar-resize-end');
    if (!track || !winEl || track.dataset.bound) return;
    track.dataset.bound = 'true';
    let drag = null;

    track.addEventListener('pointerdown', e => {
        if (e.button !== 0 || drag) return;
        e.preventDefault();
        const data = state.getCurrentCaseData();
        const rect = track.getBoundingClientRect();
        if (!data || !rect.width || requireStationReport()) return;
        const handle = winEl.getBoundingClientRect();
        const onHandle = winEl.contains(e.target);
        const resize = e.target === endEl;
        drag = { pointerId: e.pointerId, startY: data.windowStartY || 0, length:data.bedL, resize, clientX:e.clientX, rect,
            offset: onHandle ? e.clientX - handle.left : handle.width / 2 };
        track.setPointerCapture(e.pointerId);
        (resize?endEl:winEl).focus({ preventScroll: true });
        winEl.classList.add('dragging');
        if (!onHandle && !resize) {
            const totalL = data.totalRollL || 60000;
            const rawY = (e.clientX - rect.left - drag.offset) / rect.width * totalL;
            const snapStation = getSnappableNextStation(data);
            const threshold = getSnapThresholdMm(rect.width, totalL);
            let targetY = rawY;
            if (snapStation !== null && Math.abs(rawY - snapStation) <= threshold) {
                targetY = snapStation;
            }
            updateFabricScrollPosition(targetY);
        }
    });
    track.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const data = state.getCurrentCaseData();
        if (!data) return;
        const totalL = data.totalRollL || 60000;
        if(drag.resize){
            const {min,max}=feedLengthLimits(data,queuedStockLength(data.rollId));
            const length=Math.round((drag.length+(e.clientX-drag.clientX)/drag.rect.width*totalL)*10)/10;
            if(max>=min)resizeFeedWindow(Math.min(max,Math.max(min,length)),{live:true});
            return;
        }
        const rawY = (e.clientX - drag.rect.left - drag.offset) / drag.rect.width * totalL;
        const snapStation = getSnappableNextStation(data);
        const threshold = getSnapThresholdMm(drag.rect.width, totalL);

        let targetY = rawY;
        if (snapStation !== null && Math.abs(rawY - snapStation) <= threshold) {
            targetY = snapStation;
        }
        updateFabricScrollPosition(targetY);
    });
    const finishDrag = e => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const { startY, rect, resize, length } = drag;
        drag = null;
        winEl.classList.remove('dragging');
        if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
        const data = state.getCurrentCaseData();
        if (!data) return;
        if(resize){
            resizeFeedWindow(e.type==='pointercancel'?length:data.bedL);
            return;
        }
        let finalY = data.windowStartY || 0;
        const totalL = data.totalRollL || 60000;
        const bedL = data.bedL || 5000;
        const snapStation = getSnappableNextStation(data);
        const threshold = getSnapThresholdMm(rect?.width || 800, totalL);

        // 1. 若释放于待切工位附近，自动精准吸附到待切工位
        if (snapStation !== null && Math.abs(finalY - snapStation) <= threshold) {
            finalY = snapStation;
        } else {
            // 2. 离开待切工位后，支持自由查看全卷；松手按裁片末端 / 工位整倍数 / 500mm 对齐
            const maxCutY = Math.max(0, ...(data.pieces || []).map(p => p.y + p.l));
            const nearestStation = Math.round(finalY / bedL) * bedL;
            if (maxCutY > 0 && Math.abs(finalY - maxCutY) <= 800) {
                finalY = maxCutY;
            } else if (Math.abs(finalY - nearestStation) <= 800) {
                finalY = nearestStation;
            } else {
                finalY = Math.round(finalY / 500) * 500;
            }
        }
        moveStation(finalY, startY);
        bus.emit('radar:dragend', { finalY: data.windowStartY });
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(event, finishDrag);
    track.addEventListener('wheel', e => {
        e.preventDefault();
        if (drag || !e.deltaY) return;
        const data = state.getCurrentCaseData();
        if (!data) return;
        const step = (data.totalRollL || 60000) > 40000 ? 1000 : 500;
        let targetY = (data.windowStartY || 0) + Math.sign(e.deltaY) * step;
        const snapStation = getSnappableNextStation(data);
        if (snapStation !== null && Math.abs(targetY - snapStation) <= 400) {
            targetY = snapStation;
        }
        if (moveStation(targetY)) {
            bus.emit('radar:wheel', { targetY: data.windowStartY });
        }
    }, { passive: false });
    winEl.addEventListener('keydown', e => {
        if (drag) return;
        const data = state.getCurrentCaseData();
        if (!data) return;
        const current = data.windowStartY || 0, bedL = data.bedL || 5000;
        const positions = { ArrowLeft: current - 500, ArrowDown: current - 500,
            ArrowRight: current + 500, ArrowUp: current + 500, PageDown: current - bedL,
            PageUp: current + bedL, Home: 0, End: (data.totalRollL || 60000) - bedL };
        if (!(e.key in positions)) return;
        e.preventDefault();
        let target = positions[e.key];
        const snapStation = getSnappableNextStation(data);
        if (snapStation !== null && Math.abs(target - snapStation) <= 400) {
            target = snapStation;
        }
        moveStation(target);
    });
    endEl?.addEventListener('keydown',e=>{
        if(drag)return;
        const data=state.getCurrentCaseData(), {min,max}=feedLengthLimits(data,queuedStockLength(data.rollId));
        const step=e.shiftKey ? .1 : 100;
        const targets={ArrowLeft:data.bedL-step,ArrowDown:data.bedL-step,ArrowRight:data.bedL+step,ArrowUp:data.bedL+step,Home:min,End:max};
        if(!(e.key in targets))return;
        e.preventDefault();e.stopPropagation();
        if(max>=min)resizeFeedWindow(Math.min(max,Math.max(min,Math.round(targets[e.key]*10)/10)));
    });
}
function moveStation(targetY, previous = state.getCurrentCaseData()?.windowStartY || 0) {
    const data = state.getCurrentCaseData();
    if (!data) return false;
    if (!updateFabricScrollPosition(targetY)) return false;
    if (data.windowStartY === previous) return true;
    data.cuts = [];
    state.setCutStepLimit(999);
    if (state.selectedRemnantId) clearRemnantSelection();
    updateDefectVisualStates();
    updateDefectRadarActiveState();
    recalculateRollStats(data);
    renderScene();
    drawRulers();
    updateUIInfo();
    window.camApp?.renderToolpathUI?.();
    return true;
}

export function advanceBed(delta) {
    const data = state.getCurrentCaseData();
    if (data) moveStation((data.windowStartY || 0) + delta * (data.bedL || 5000));
}

export function smartAdvanceBed() {
    const data = state.getCurrentCaseData();
    if (!data) return;
    const totalL = data.totalRollL || 60000;
    const bedL = data.bedL || 5000;
    const curY = data.windowStartY || 0;

    if (state.currentCutMode === 'remnant' || requireStationReport()) return;
    const nextY = Math.min(totalL, nextCutPosition(data) || curY + bedL);
    if (nextY >= totalL) return;
    data.bedL = Math.min(bedL, totalL - nextY);
    const lengthInput = document.getElementById('inp-bed-l');
    if (lengthInput) lengthInput.value = data.bedL;

    if (nextY !== curY) {
        data.cuts = [];
        state.setCutStepLimit(999);
        state.pendingPlan = null;
        if (state.selectedRemnantId) clearRemnantSelection();
    }

    updateFabricScrollPosition(nextY);
    updateDefectVisualStates();
    updateDefectRadarActiveState();
    recalculateRollStats(data);
    renderScene();
    drawRulers();
    updateUIInfo();
    if (window.camApp && typeof window.camApp.renderToolpathUI === 'function') {
        window.camApp.renderToolpathUI();
    }
    renderRadar();
    bus.emit('bed:smart-advanced', { nextY });
}
