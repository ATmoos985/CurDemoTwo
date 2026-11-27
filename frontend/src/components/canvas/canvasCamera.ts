import type { MutableRefObject } from 'react';
import type { BoardPoint } from './canvasTypes';
import { drawScreenRulers, RULER_THICKNESS } from './canvasRuler';
import type { BoardCanvasLiveProps, BoardCanvasRefs } from './canvasKonvaHelpers';
import { renderOverlay, syncCulledPieces, updateFeedLineVisual } from './canvasDynamicOverlay';

export interface CameraController {
  getRollWorldRect: () => { x: number; y: number; width: number; height: number };
  syncAllRollGroupsTransform: () => void;
  stageToRollLocal: (stagePt: { x: number; y: number }) => BoardPoint | null;
  drawRulersNow: () => void;
  scheduleRulerDraw: () => void;
  applyCameraImmediate: () => void;
  scheduleCameraApply: () => void;
  fitView: () => void;
  focusRange: (startY: number, endY: number, startX?: number, endX?: number) => void;
  followPosition: (yMm: number) => void;
  clearMeasure: () => void;
  zoomBy: (factor: number, centerPx?: { x: number; y: number }) => void;
  resetRollOffset: () => void;
}

export function createCameraController(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>,
  setZoomPct: (pct: number) => void
): CameraController {
  const getRollWorldRect = () => {
    const p = propsRef.current;
    const ro = refs.rollOffsetRef.current;
    const w = Math.max(1, p.rollWidthMm);
    const l = Math.max(1, p.rollLengthMm);
    if (p.vertical) {
      return { x: ro.x, y: ro.y, width: w, height: l };
    }
    return { x: ro.x, y: ro.y - w, width: l, height: w };
  };

  const syncAllRollGroupsTransform = () => {
    const ro = refs.rollOffsetRef.current;
    const rot = propsRef.current.vertical ? 0 : -90;
    for (const rg of refs.rollGroupsRef.current) {
      if (!rg) continue;
      rg.position(ro);
      rg.rotation(rot);
    }
  };

  const stageToRollLocal = (stagePt: { x: number; y: number }): BoardPoint | null => {
    const rollGroup = refs.baseRollGroupRef.current;
    if (!rollGroup) return null;
    try {
      const inv = rollGroup.getAbsoluteTransform().copy().invert();
      const pt = inv.point(stagePt);
      return { x: pt.x, y: pt.y };
    } catch {
      return null;
    }
  };

  const drawRulersNow = () => {
    const canvas = refs.rulerCanvasRef.current;
    const host = refs.hostRef.current;
    if (!canvas || !host) return;
    const p = propsRef.current;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (!p.showDimensions || vw <= 24 || vh <= 24) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.round(vw * dpr);
    const targetH = Math.round(vh * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScreenRulers(ctx, {
      width: vw,
      height: vh,
      cam: refs.camRef.current,
      rollOffset: refs.rollOffsetRef.current,
      rollWidthMm: p.rollWidthMm,
      rollLengthMm: p.rollLengthMm,
      vertical: p.vertical,
      cursorLocal: refs.cursorLocalRef.current,
      dark: p.darkTheme,
      dpr
    });
  };

  const scheduleRulerDraw = () => {
    if (refs.rafRulerIdRef.current != null) return;
    refs.rafRulerIdRef.current = window.requestAnimationFrame(() => {
      refs.rafRulerIdRef.current = null;
      drawRulersNow();
    });
  };

  const applyCameraImmediate = () => {
    const worldGroups = refs.worldGroupsRef.current;
    if (!worldGroups.length) return;
    const c = refs.camRef.current;
    for (const wg of worldGroups) {
      if (!wg) continue;
      wg.position({ x: c.x, y: c.y });
      wg.scale({ x: c.scale, y: c.scale });
    }
    for (const fn of refs.baseScaleNodesRef.current) fn();
    for (const fn of refs.piecesScaleNodesRef.current) fn();
    for (const fn of refs.toolpathScaleNodesRef.current) fn();
    syncCulledPieces(refs, propsRef);
    updateFeedLineVisual(refs, propsRef, false);
    renderOverlay(refs, propsRef);

    refs.baseLayerRef.current?.batchDraw();
    refs.piecesLayerRef.current?.batchDraw();
    refs.toolpathLayerRef.current?.batchDraw();
    refs.dynamicLayerRef.current?.batchDraw();
    drawRulersNow();

    const relPct =
      c.fitScale > 0 ? Math.round((c.scale / c.fitScale) * 100) : Math.round(c.scale * 400);
    setZoomPct(Math.max(10, Math.min(999, relPct)));
  };

  const scheduleCameraApply = () => {
    if (refs.rafCamIdRef.current != null) return;
    refs.rafCamIdRef.current = window.requestAnimationFrame(() => {
      refs.rafCamIdRef.current = null;
      applyCameraImmediate();
    });
  };

  const fitView = () => {
    const host = refs.hostRef.current;
    const stage = refs.stageRef.current;
    if (!host || !stage) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (vw < 40 || vh < 40) return;

    const p = propsRef.current;
    const rb = getRollWorldRect();
    let minX = rb.x;
    let maxX = rb.x + rb.width;
    let minY = rb.y;
    let maxY = rb.y + rb.height;

    if (p.showStaging) {
      const sb = refs.stagingBoundsRef.current;
      minX = Math.min(minX, sb.x);
      maxX = Math.max(maxX, sb.x + sb.width);
      minY = Math.min(minY, sb.y);
      maxY = Math.max(maxY, sb.y + sb.height);
    }

    const worldW = Math.max(200, maxX - minX);
    const worldH = Math.max(200, maxY - minY);
    const rulerPad = p.showDimensions ? RULER_THICKNESS : 0;
    const padLeft = rulerPad + 36;
    const padRight = 40;
    const padTop = rulerPad + 42;
    const padBottom = 34;
    const scale = Math.max(
      0.002,
      Math.min(
        1.6,
        Math.min((vw - padLeft - padRight) / worldW, (vh - padTop - padBottom) / worldH)
      )
    );

    const x = padLeft + (vw - padLeft - padRight - worldW * scale) / 2 - minX * scale;
    const y = padTop + (vh - padTop - padBottom - worldH * scale) / 2 - minY * scale;

    refs.camRef.current = { x, y, scale, fitScale: scale };
    applyCameraImmediate();
  };

  const focusRange = (startY: number, endY: number, startX?: number, endX?: number) => {
    const host = refs.hostRef.current;
    const stage = refs.stageRef.current;
    if (!host || !stage) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (vw < 40 || vh < 40) return;

    const p = propsRef.current;
    const ro = refs.rollOffsetRef.current;
    const x0 = Math.max(0, startX ?? 0);
    const x1 = Math.min(p.rollWidthMm, endX ?? p.rollWidthMm);
    const y0 = Math.max(0, Math.min(startY, endY));
    const y1 = Math.min(p.rollLengthMm, Math.max(startY, endY));

    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    if (p.vertical) {
      minX = ro.x + x0;
      maxX = ro.x + Math.max(x0 + 50, x1);
      minY = ro.y + y0;
      maxY = ro.y + Math.max(y0 + 120, y1);
    } else {
      minX = ro.x + y0;
      maxX = ro.x + Math.max(y0 + 120, y1);
      minY = ro.y - Math.max(x0 + 50, x1);
      maxY = ro.y - x0;
    }

    const worldW = Math.max(120, maxX - minX);
    const worldH = Math.max(120, maxY - minY);
    const rulerPad = p.showDimensions ? RULER_THICKNESS : 0;
    const padLeft = rulerPad + 36;
    const padRight = 36;
    const padTop = rulerPad + 36;
    const padBottom = 36;
    const scale = Math.max(
      0.002,
      Math.min(
        2.4,
        Math.min((vw - padLeft - padRight) / worldW, (vh - padTop - padBottom) / worldH)
      )
    );
    const x = padLeft + (vw - padLeft - padRight - worldW * scale) / 2 - minX * scale;
    const y = padTop + (vh - padTop - padBottom - worldH * scale) / 2 - minY * scale;

    refs.camRef.current = { x, y, scale, fitScale: scale };
    applyCameraImmediate();
  };

  const followPosition = (yMm: number) => {
    const host = refs.hostRef.current;
    const p = propsRef.current;
    if (!host) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (vw < 40 || vh < 40) return;

    const span = Math.min(p.rollLengthMm, Math.max(2400, p.rollWidthMm * 2.2));
    const desiredScale = Math.min(
      2.2,
      Math.max(
        0.02,
        p.vertical
          ? Math.min((vw - 96) / Math.max(200, p.rollWidthMm), (vh - 96) / span)
          : Math.min((vw - 96) / span, (vh - 96) / Math.max(200, p.rollWidthMm))
      )
    );
    const cur = refs.camRef.current;
    if (cur.scale < desiredScale * 0.55 || cur.scale > desiredScale * 3.5) {
      const half = span / 2;
      let y0 = Math.max(0, yMm - half);
      let y1 = y0 + span;
      if (y1 > p.rollLengthMm) {
        y1 = p.rollLengthMm;
        y0 = Math.max(0, y1 - span);
      }
      focusRange(y0, y1, 0, p.rollWidthMm);
      return;
    }

    const ro = refs.rollOffsetRef.current;
    const rulerPad = p.showDimensions ? RULER_THICKNESS : 0;
    if (p.vertical) {
      const targetScreenY = rulerPad + (vh - rulerPad) * 0.5;
      const nextCamY = targetScreenY - (ro.y + yMm) * cur.scale;
      if (Math.abs(nextCamY - cur.y) < 0.5) return;
      refs.camRef.current = { ...cur, y: nextCamY };
    } else {
      const targetScreenX = rulerPad + (vw - rulerPad) * 0.5;
      const nextCamX = targetScreenX - (ro.x + yMm) * cur.scale;
      if (Math.abs(nextCamX - cur.x) < 0.5) return;
      refs.camRef.current = { ...cur, x: nextCamX };
    }
    scheduleCameraApply();
  };

  const clearMeasure = () => {
    refs.measureLineRef.current = null;
    renderOverlay(refs, propsRef);
  };

  const zoomBy = (factor: number, centerPx?: { x: number; y: number }) => {
    const host = refs.hostRef.current;
    if (!host) return;
    const cx = centerPx ? centerPx.x : host.clientWidth / 2;
    const cy = centerPx ? centerPx.y : host.clientHeight / 2;
    const c = refs.camRef.current;
    const nextScale = Math.max(0.002, Math.min(5.0, c.scale * factor));
    const worldX = (cx - c.x) / c.scale;
    const worldY = (cy - c.y) / c.scale;
    refs.camRef.current = {
      ...c,
      scale: nextScale,
      x: cx - worldX * nextScale,
      y: cy - worldY * nextScale
    };
    scheduleCameraApply();
  };

  const resetRollOffset = () => {
    refs.rollOffsetRef.current = { x: 0, y: 0 };
    syncAllRollGroupsTransform();
    fitView();
  };

  return {
    getRollWorldRect,
    syncAllRollGroupsTransform,
    stageToRollLocal,
    drawRulersNow,
    scheduleRulerDraw,
    applyCameraImmediate,
    scheduleCameraApply,
    fitView,
    focusRange,
    followPosition,
    clearMeasure,
    zoomBy,
    resetRollOffset
  };
}
