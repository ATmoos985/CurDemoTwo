import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import {
  computeViewportWorldRect,
  isWorldBoxVisible,
  rollLocalBoxToWorldRect,
  round1
} from './canvasGeometry';
import type { BoardCanvasLiveProps, BoardCanvasRefs } from './canvasKonvaHelpers';

/** 原地更新独立动态 Layer 上的验布线（零节点创建/销毁，专为 10Hz 跑布设计）。 */
export function updateFeedLineVisual(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>,
  drawLayer = true
): void {
  const fn = refs.feedNodesRef.current;
  const dynLayer = refs.dynamicLayerRef.current;
  if (!fn || !dynLayer) return;
  const p = propsRef.current;
  if (p.feedPositionMm == null || !Number.isFinite(p.feedPositionMm)) {
    if (fn.group.visible()) {
      fn.group.visible(false);
      if (drawLayer) dynLayer.batchDraw();
    }
    return;
  }
  const fy = Math.max(0, Math.min(p.rollLengthMm, p.feedPositionMm));
  const s = Math.max(0.002, refs.camRef.current.scale);
  const isVert = p.vertical;

  fn.group.visible(true);
  fn.line.points([0, fy, p.rollWidthMm, fy]);
  fn.tagText.text(`验布线 ${(fy / 1000).toFixed(2)} m`);
  const fontMm = 10.5 / s;
  fn.tagText.fontSize(fontMm);
  fn.tagText.rotation(isVert ? 0 : 90);

  const padX = 5 / s;
  const padY = 2.5 / s;
  const tw = fn.tagText.width();
  const th = fontMm * 1.2;
  fn.tagBg.size({ width: tw + padX * 2, height: th + padY * 2 });
  fn.tagBg.cornerRadius(4 / s);
  fn.tagBg.rotation(isVert ? 0 : 90);

  if (isVert) {
    const tx = p.rollWidthMm + 8 / s;
    const ty = fy - (th + padY * 2) / 2;
    fn.tagBg.position({ x: tx, y: ty });
    fn.tagText.position({ x: tx + padX, y: ty + padY });
  } else {
    const tx = -8 / s;
    const ty = fy - (tw + padX * 2) / 2;
    fn.tagBg.position({ x: tx, y: ty });
    fn.tagText.position({ x: tx - padY, y: ty + padX });
  }

  if (drawLayer) dynLayer.batchDraw();
}

export function renderOverlay(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>
): void {
  const overlay = refs.overlayGroupRef.current;
  const dynLayer = refs.dynamicLayerRef.current;
  if (!Konva || !overlay || !dynLayer) return;
  overlay.destroyChildren();
  const s = Math.max(0.03, refs.camRef.current.scale);
  const isVert = propsRef.current.vertical;

  const m = refs.measureLineRef.current;
  if (m) {
    const dx = m.p2.x - m.p1.x;
    const dy = m.p2.y - m.p1.y;
    const dist = Math.hypot(dx, dy);
    overlay.add(
      new Konva.Line({
        points: [m.p1.x, m.p1.y, m.p2.x, m.p2.y],
        stroke: '#5b61f6',
        strokeWidth: 2,
        dash: [6, 4],
        strokeScaleEnabled: false,
        listening: false
      }),
      new Konva.Circle({
        x: m.p1.x,
        y: m.p1.y,
        radius: 4 / s,
        fill: '#5b61f6',
        listening: false
      }),
      new Konva.Circle({
        x: m.p2.x,
        y: m.p2.y,
        radius: 4 / s,
        fill: '#5b61f6',
        listening: false
      })
    );
    const midX = (m.p1.x + m.p2.x) / 2;
    const midY = (m.p1.y + m.p2.y) / 2;
    const labelGrp = new Konva.Group({
      x: midX,
      y: midY,
      rotation: isVert ? 0 : 90,
      listening: false
    });
    const txt = new Konva.Text({
      text: `${round1(dist)} mm  (ΔX ${round1(Math.abs(dx))}, ΔY ${round1(Math.abs(dy))})`,
      fill: '#ffffff',
      fontSize: 11 / s,
      fontStyle: '600',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      listening: false
    });
    const padX = 7 / s;
    const padY = 4 / s;
    const bw = txt.width() + padX * 2;
    const bh = 11 / s + padY * 2;
    const bg = new Konva.Rect({
      x: -bw / 2,
      y: -bh - 8 / s,
      width: bw,
      height: bh,
      fill: '#18181b',
      cornerRadius: 5 / s,
      listening: false
    });
    txt.position({ x: -bw / 2 + padX, y: -bh - 8 / s + padY });
    labelGrp.add(bg, txt);
    overlay.add(labelGrp);
  }

  const d = refs.defectDraftRef.current;
  if (d) {
    const x = Math.min(d.p1.x, d.p2.x);
    const y = Math.min(d.p1.y, d.p2.y);
    const w = Math.abs(d.p2.x - d.p1.x);
    const h = Math.abs(d.p2.y - d.p1.y);
    overlay.add(
      new Konva.Rect({
        x,
        y,
        width: w,
        height: h,
        fill: 'rgba(239, 68, 68, 0.18)',
        stroke: '#dc2626',
        strokeWidth: 1.8,
        dash: [5, 3],
        strokeScaleEnabled: false,
        listening: false
      })
    );
    const tagGrp = new Konva.Group({
      x: x + w / 2,
      y,
      rotation: isVert ? 0 : 90,
      listening: false
    });
    const tagTxt = new Konva.Text({
      text: `${round1(w)} × ${round1(h)} mm`,
      fill: '#ffffff',
      fontSize: 10.5 / s,
      fontStyle: '600',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      listening: false
    });
    const padX = 6 / s;
    const padY = 3 / s;
    const bw = tagTxt.width() + padX * 2;
    const bh = 10.5 / s + padY * 2;
    tagGrp.add(
      new Konva.Rect({
        x: -bw / 2,
        y: -bh - 6 / s,
        width: bw,
        height: bh,
        fill: '#dc2626',
        cornerRadius: 4 / s,
        listening: false
      }),
      tagTxt
    );
    tagTxt.position({ x: -bw / 2 + padX, y: -bh - 6 / s + padY });
    overlay.add(tagGrp);
  }

  dynLayer.batchDraw();
}

/** 视口裁剪（Viewport Culling）：跳过完全在视口外的裁片标签同步并按需裁剪隐藏。 */
export function syncCulledPieces(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>
): void {
  const host = refs.hostRef.current;
  const entries = refs.culledPiecesRef.current;
  if (!host || entries.length === 0) return;
  const vw = host.clientWidth;
  const vh = host.clientHeight;
  const viewportWorld = computeViewportWorldRect(refs.camRef.current, vw, vh, 64);
  const ro = refs.rollOffsetRef.current;
  const isVert = propsRef.current.vertical;

  for (const entry of entries) {
    if (entry.dragging) {
      if (!entry.node.visible()) entry.node.visible(true);
      entry.syncLabel();
      continue;
    }
    const box = rollLocalBoxToWorldRect(
      entry.localX,
      entry.localY,
      entry.width,
      entry.height,
      ro,
      isVert
    );
    const visible = isWorldBoxVisible(box, viewportWorld);
    if (visible) {
      if (!entry.node.visible()) entry.node.visible(true);
      entry.syncLabel();
    } else if (entry.node.visible()) {
      entry.node.visible(false);
    }
  }
}
