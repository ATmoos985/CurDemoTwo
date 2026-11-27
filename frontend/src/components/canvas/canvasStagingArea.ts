import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import { computeStagingLayout, round1 } from './canvasGeometry';
import {
  computeSnappedRollPosition,
  createLabelUpdater,
  makeShapeNode,
  type BoardCanvasLiveProps,
  type BoardCanvasRefs,
  type DragFeedbackState,
  type ValidateRollPlacementFn
} from './canvasKonvaHelpers';

export interface RenderStagingAreaParams {
  refs: BoardCanvasRefs;
  propsRef: MutableRefObject<BoardCanvasLiveProps>;
  host: HTMLDivElement;
  stagingGroup: any;
  getRollWorldRect: () => { x: number; y: number; width: number; height: number };
  validateRollPlacement: ValidateRollPlacementFn;
  setDragFeedback: (fb: DragFeedbackState | null) => void;
}

export function renderStagingArea(params: RenderStagingAreaParams): void {
  const {
    refs,
    propsRef,
    host,
    stagingGroup,
    getRollWorldRect,
    validateRollPlacement,
    setDragFeedback
  } = params;
  const p0 = propsRef.current;

  if (!p0.showStaging) {
    refs.stagingBoundsRef.current = getRollWorldRect();
    return;
  }

  const staging = computeStagingLayout(p0.demands, p0.rollWidthMm, p0.rollLengthMm);
  refs.stagingBoundsRef.current = staging.bounds;

  const validInstanceKeys = new Set(staging.items.map((it) => it.instanceKey));
  for (const k of Array.from(refs.stagingOffsetsRef.current.keys())) {
    if (!validInstanceKeys.has(k)) refs.stagingOffsetsRef.current.delete(k);
  }

  stagingGroup.add(
    new Konva.Rect({
      x: staging.bounds.x,
      y: staging.bounds.y,
      width: staging.bounds.width,
      height: staging.bounds.height,
      fill: p0.darkTheme ? 'rgba(30, 41, 59, 0.55)' : 'rgba(255, 255, 255, 0.42)',
      stroke: p0.darkTheme ? 'rgba(148, 163, 184, 0.25)' : 'rgba(15, 23, 42, 0.16)',
      strokeWidth: 1.2,
      dash: [6, 5],
      strokeScaleEnabled: false,
      cornerRadius: 8,
      listening: false
    })
  );

  const stagingHeader = new Konva.Text({
    text: `待排裁片 · ${staging.totalCount} 件`,
    fill: p0.darkTheme ? '#cbd5e1' : '#52525b',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontStyle: '600',
    wrap: 'none',
    listening: false
  });
  stagingGroup.add(stagingHeader);
  const syncStagingHeader = () => {
    const s = Math.max(0.002, refs.camRef.current.scale);
    stagingHeader.fontSize(11.5 / s);
    const headerW = stagingHeader.width();
    const rightEdge = staging.bounds.x + staging.bounds.width;
    const hx = Math.min(staging.bounds.x + 2 / s, rightEdge - headerW);
    stagingHeader.position({ x: hx, y: staging.bounds.y - 24 / s });
  };
  syncStagingHeader();
  refs.baseScaleNodesRef.current.push(syncStagingHeader);

  if (staging.items.length === 0) {
    const emptyText = new Konva.Text({
      text: '待排区已清空\n拖出母卷裁片可退回',
      fill: p0.darkTheme ? '#94a3b8' : '#8e929b',
      align: 'center',
      lineHeight: 1.5,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      listening: false
    });
    stagingGroup.add(emptyText);
    const syncEmpty = () => {
      const s = Math.max(0.002, refs.camRef.current.scale);
      const boxPxW = staging.bounds.width * s;
      if (boxPxW < 108) {
        emptyText.visible(false);
        return;
      }
      emptyText.visible(true);
      emptyText.fontSize(11 / s);
      emptyText.width(staging.bounds.width - 16 / s);
      emptyText.position({
        x: staging.bounds.x + 8 / s,
        y: staging.bounds.y + staging.bounds.height * 0.42
      });
    };
    syncEmpty();
    refs.baseScaleNodesRef.current.push(syncEmpty);
  }

  for (const item of staging.items) {
    const savedPos = refs.stagingOffsetsRef.current.get(item.instanceKey);
    const startX = savedPos ? savedPos.x : item.x;
    const startY = savedPos ? savedPos.y : item.y;

    const pieceGroup = new Konva.Group({
      x: startX,
      y: startY,
      draggable: p0.interactivePieces
    });

    const bodyNode = makeShapeNode(Konva, item.shape, item.width, item.height, {
      fill: item.style.fill,
      stroke: item.style.stroke,
      strokeWidth: 1.4,
      shadowColor: 'rgba(15, 23, 42, 0.08)',
      shadowBlur: 5,
      shadowOffsetY: 2,
      shadowEnabled: true
    });
    pieceGroup.add(bodyNode);

    const syncLbl = createLabelUpdater(
      Konva,
      pieceGroup,
      item.name,
      `${Math.round(item.width)}×${Math.round(item.height)}`,
      item.width,
      item.height,
      item.style.text,
      false,
      refs.camRef,
      propsRef
    );
    syncLbl();
    refs.baseScaleNodesRef.current.push(syncLbl);

    if (item.stackExtra > 0) {
      const badgeBg = new Konva.Rect({ fill: '#18181b', cornerRadius: 4, listening: false });
      const badgeTxt = new Konva.Text({
        text: `+余 ${item.stackExtra}`,
        fill: '#ffffff',
        fontStyle: '600',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        listening: false
      });
      pieceGroup.add(badgeBg, badgeTxt);
      const syncBadge = () => {
        const s = Math.max(0.002, refs.camRef.current.scale);
        const fz = 10 / s;
        badgeTxt.fontSize(fz);
        const padX = 5 / s;
        const padY = 2.5 / s;
        const bw = badgeTxt.width() + padX * 2;
        const bh = fz + padY * 2;
        badgeBg.size({ width: bw, height: bh });
        badgeBg.position({ x: item.width - bw + 4 / s, y: -bh * 0.45 });
        badgeTxt.position({ x: item.width - bw + 4 / s + padX, y: -bh * 0.45 + padY });
      };
      syncBadge();
      refs.baseScaleNodesRef.current.push(syncBadge);
    }

    refs.pieceNodeMapRef.current.push({
      node: pieceGroup,
      outline: bodyNode,
      demandKey: item.demandKey,
      baseStroke: item.style.stroke,
      placedIndex: null,
      layerKind: 'base'
    });

    if (p0.interactivePieces) {
      let dragOrigin = { x: startX, y: startY };
      pieceGroup.on('mousedown touchstart', (e: any) => {
        e.cancelBubble = true;
      });
      pieceGroup.on('mouseenter', () => {
        host.style.cursor = 'grab';
        propsRef.current.onHoverDemandKey?.(item.demandKey);
      });
      pieceGroup.on('mouseleave', () => {
        host.style.cursor = '';
        propsRef.current.onHoverDemandKey?.(null);
      });
      pieceGroup.on('dragstart', (e: any) => {
        e.cancelBubble = true;
        dragOrigin = { x: pieceGroup.x(), y: pieceGroup.y() };
        pieceGroup.moveToTop();
        host.style.cursor = 'grabbing';
        bodyNode.shadowBlur(12);
        bodyNode.shadowColor('rgba(15, 23, 42, 0.22)');
      });
      pieceGroup.on('dragmove', (e: any) => {
        e.cancelBubble = true;
        const p = propsRef.current;
        const ro = refs.rollOffsetRef.current;
        let rawLocalX: number;
        let rawLocalY: number;
        if (p.vertical) {
          rawLocalX = pieceGroup.x() - ro.x;
          rawLocalY = pieceGroup.y() - ro.y;
        } else {
          const worldCx = pieceGroup.x() + item.width / 2;
          const worldCy = pieceGroup.y() + item.height / 2;
          rawLocalX = ro.y - worldCy - item.width / 2;
          rawLocalY = worldCx - ro.x - item.height / 2;
        }
        const cx = rawLocalX + item.width / 2;
        const cy = rawLocalY + item.height / 2;
        const overRoll =
          cx >= -20 && cx <= p.rollWidthMm + 20 && cy >= -20 && cy <= p.rollLengthMm + 20;

        if (overRoll) {
          const snapped = computeSnappedRollPosition({
            w: item.width,
            h: item.height,
            rawX: rawLocalX,
            rawY: rawLocalY,
            ignorePieceIndex: -1,
            scale: refs.camRef.current.scale,
            pieceGapMm: p.pieceGapMm,
            rollWidthMm: p.rollWidthMm,
            rollLengthMm: p.rollLengthMm,
            trimStartMm: p.trimStartMm,
            placedPieces: p.placedPieces
          });
          if (p.vertical) {
            pieceGroup.position({ x: snapped.x + ro.x, y: snapped.y + ro.y });
          }
          const check = validateRollPlacement(
            item.shape,
            item.width,
            item.height,
            snapped.x,
            snapped.y,
            -1
          );
          if (check.ok) {
            bodyNode.stroke('#10b981');
            bodyNode.strokeWidth(2.4);
            setDragFeedback({
              tone: 'ok',
              text: `松手排入母卷 · X ${Math.round(snapped.x)}, Y ${Math.round(snapped.y)} mm`
            });
          } else {
            bodyNode.stroke('#e11d48');
            bodyNode.strokeWidth(2.4);
            setDragFeedback({ tone: 'err', text: check.reason });
          }
        } else {
          bodyNode.stroke(item.style.stroke);
          bodyNode.strokeWidth(1.5);
          setDragFeedback(null);
        }
      });
      pieceGroup.on('dragend', (e: any) => {
        e.cancelBubble = true;
        host.style.cursor = '';
        bodyNode.shadowBlur(5);
        bodyNode.shadowColor('rgba(15, 23, 42, 0.08)');
        bodyNode.stroke(item.style.stroke);
        bodyNode.strokeWidth(1.4);
        setDragFeedback(null);

        const p = propsRef.current;
        const ro = refs.rollOffsetRef.current;
        let localX: number;
        let localY: number;
        if (p.vertical) {
          localX = pieceGroup.x() - ro.x;
          localY = pieceGroup.y() - ro.y;
        } else {
          const worldCx = pieceGroup.x() + item.width / 2;
          const worldCy = pieceGroup.y() + item.height / 2;
          localX = ro.y - worldCy - item.width / 2;
          localY = worldCx - ro.x - item.height / 2;
        }
        const cx = localX + item.width / 2;
        const cy = localY + item.height / 2;

        const overRoll = cx >= 0 && cx <= p.rollWidthMm && cy >= 0 && cy <= p.rollLengthMm;
        if (overRoll) {
          const fitsRollW = item.width <= p.rollWidthMm;
          const fitsRollH = item.height <= Math.max(0, p.rollLengthMm - p.trimStartMm);
          const targetX = fitsRollW
            ? Math.max(0, Math.min(p.rollWidthMm - item.width, localX))
            : localX;
          const targetY = fitsRollH
            ? Math.max(p.trimStartMm, Math.min(p.rollLengthMm - item.height, localY))
            : localY;
          const check = validateRollPlacement(
            item.shape,
            item.width,
            item.height,
            targetX,
            targetY,
            -1
          );
          if (check.ok) {
            refs.stagingOffsetsRef.current.delete(item.instanceKey);
            propsRef.current.onDropStagingPiece?.(
              item.demandKey,
              round1(targetX),
              round1(targetY)
            );
          } else {
            pieceGroup.position(dragOrigin);
            refs.baseLayerRef.current?.batchDraw();
            propsRef.current.onCollisionNotice?.(check.reason);
          }
        } else {
          refs.stagingOffsetsRef.current.set(item.instanceKey, {
            x: pieceGroup.x(),
            y: pieceGroup.y()
          });
        }
      });
    }

    stagingGroup.add(pieceGroup);
  }
}
