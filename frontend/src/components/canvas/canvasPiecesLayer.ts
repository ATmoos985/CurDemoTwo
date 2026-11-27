import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import { round1, styleForDemand } from './canvasGeometry';
import {
  buildPiecesSignature,
  computeSnappedRollPosition,
  createLabelUpdater,
  ensureHatchTiles,
  makeShapeNode,
  type BoardCanvasLiveProps,
  type BoardCanvasRefs,
  type CulledPieceEntry,
  type DragFeedbackState,
  type ValidateRollPlacementFn
} from './canvasKonvaHelpers';
import type { CameraController } from './canvasCamera';
import { syncCulledPieces } from './canvasDynamicOverlay';

export interface RenderPiecesLayerParams {
  refs: BoardCanvasRefs;
  propsRef: MutableRefObject<BoardCanvasLiveProps>;
  cam: CameraController;
  validateRollPlacement: ValidateRollPlacementFn;
  setDragFeedback: (fb: DragFeedbackState | null) => void;
}

export function renderPiecesLayer(params: RenderPiecesLayerParams): void {
  const { refs, propsRef, cam, validateRollPlacement, setDragFeedback } = params;
  const piecesRollGroup = refs.piecesRollGroupRef.current;
  const host = refs.hostRef.current;
  if (!Konva || !piecesRollGroup || !host) return;

  const p0 = propsRef.current;
  const sig = buildPiecesSignature({
    placedPieces: p0.placedPieces,
    defects: p0.defects,
    selectedDefectId: p0.selectedDefectId,
    interactivePieces: p0.interactivePieces,
    vertical: p0.vertical,
    tool: p0.tool,
    rollWidthMm: p0.rollWidthMm,
    rollLengthMm: p0.rollLengthMm,
    trimStartMm: p0.trimStartMm,
    pieceGapMm: p0.pieceGapMm,
    hasDefectHandlers: Boolean(p0.onDefectSelect || p0.onDefectEdit)
  });
  if (sig === refs.lastPiecesSigRef.current) {
    return;
  }
  refs.lastPiecesSigRef.current = sig;

  piecesRollGroup.destroyChildren();
  refs.piecesScaleNodesRef.current = [];
  refs.culledPiecesRef.current = [];
  refs.pieceNodeMapRef.current = refs.pieceNodeMapRef.current.filter((it) => it.layerKind !== 'pieces');

  ensureHatchTiles(refs.hatchCacheRef.current);
  cam.syncAllRollGroupsTransform();

  // 2.1 已排裁片
  const placedLayerGroup = new Konva.Group();
  piecesRollGroup.add(placedLayerGroup);

  for (const pc of p0.placedPieces) {
    const style = styleForDemand(pc.demandId, pc.index, pc.gapFill);
    const pcGroup = new Konva.Group({
      x: pc.x,
      y: pc.y,
      draggable: p0.interactivePieces
    });

    const bodyNode = makeShapeNode(Konva, pc.shape, pc.width, pc.height, {
      fill: style.fill,
      stroke: style.stroke,
      strokeWidth: 1.4,
      ...(pc.gapFill ? { dash: [5, 3] } : {})
    });
    pcGroup.add(bodyNode);

    const labelText = pc.gapFill ? `补 · ${pc.name}` : pc.name;
    const rotTag = pc.rotationDegrees ? ` · ${pc.rotationDegrees}°` : '';
    const syncLabel = createLabelUpdater(
      Konva,
      pcGroup,
      labelText,
      `${Math.round(pc.width)}×${Math.round(pc.height)}${rotTag}`,
      pc.width,
      pc.height,
      style.text,
      true,
      refs.camRef,
      propsRef
    );

    const cullEntry: CulledPieceEntry = {
      node: pcGroup,
      localX: pc.x,
      localY: pc.y,
      width: pc.width,
      height: pc.height,
      dragging: false,
      syncLabel
    };
    refs.culledPiecesRef.current.push(cullEntry);

    refs.pieceNodeMapRef.current.push({
      node: pcGroup,
      outline: bodyNode,
      demandKey: pc.demandKey,
      baseStroke: style.stroke,
      placedIndex: pc.index,
      gapFill: pc.gapFill,
      layerKind: 'pieces'
    });

    pcGroup.on('click tap', (e: any) => {
      e.cancelBubble = true;
      propsRef.current.onSelectLeftover?.(null);
      propsRef.current.onSelectPiece?.(pc.index);
    });
    pcGroup.on('contextmenu', (e: any) => {
      const p = propsRef.current;
      if (!p.onContextMenu && !p.onContextInspect) return;
      e.evt.preventDefault();
      e.cancelBubble = true;
      p.onSelectLeftover?.(null);
      p.onSelectPiece?.(pc.index);
      p.onContextMenu?.({
        kind: 'piece',
        pieceIndex: pc.index,
        entityId: pc.id,
        clientX: e.evt.clientX,
        clientY: e.evt.clientY,
        localX: round1(pc.x),
        localY: round1(pc.y)
      });
      p.onContextInspect?.({
        entityId: pc.id,
        x: round1(pc.x),
        y: round1(pc.y)
      });
    });

    if (p0.interactivePieces) {
      const origX = pc.x;
      const origY = pc.y;

      pcGroup.on('mousedown touchstart', (e: any) => {
        e.cancelBubble = true;
      });
      pcGroup.on('mouseenter', () => {
        host.style.cursor = 'grab';
        propsRef.current.onHoverDemandKey?.(pc.demandKey);
      });
      pcGroup.on('mouseleave', () => {
        host.style.cursor = '';
        propsRef.current.onHoverDemandKey?.(null);
      });
      pcGroup.on('dragstart', (e: any) => {
        e.cancelBubble = true;
        cullEntry.dragging = true;
        pcGroup.moveToTop();
        host.style.cursor = 'grabbing';
        propsRef.current.onSelectLeftover?.(null);
        propsRef.current.onSelectPiece?.(pc.index);
        bodyNode.shadowEnabled(true);
        bodyNode.shadowColor('rgba(15, 23, 42, 0.22)');
        bodyNode.shadowBlur(10);
      });
      pcGroup.on('dragmove', (e: any) => {
        e.cancelBubble = true;
        const p = propsRef.current;
        const rawX = pcGroup.x();
        const rawY = pcGroup.y();
        const cx = rawX + pc.width / 2;
        const cy = rawY + pc.height / 2;

        const insideRoll = cx >= 0 && cx <= p.rollWidthMm && cy >= 0 && cy <= p.rollLengthMm;
        if (!insideRoll) {
          bodyNode.stroke('#5b61f6');
          bodyNode.strokeWidth(2.2);
          bodyNode.dash([6, 4]);
          setDragFeedback({ tone: 'return', text: '松手退回左侧待排区' });
        } else {
          bodyNode.dash(pc.gapFill ? [5, 3] : []);
          const snapped = computeSnappedRollPosition({
            w: pc.width,
            h: pc.height,
            rawX,
            rawY,
            ignorePieceIndex: pc.index,
            scale: refs.camRef.current.scale,
            pieceGapMm: p.pieceGapMm,
            rollWidthMm: p.rollWidthMm,
            rollLengthMm: p.rollLengthMm,
            trimStartMm: p.trimStartMm,
            placedPieces: p.placedPieces
          });
          pcGroup.position(snapped);
          const check = validateRollPlacement(
            pc.shape,
            pc.width,
            pc.height,
            snapped.x,
            snapped.y,
            pc.index
          );
          if (check.ok) {
            bodyNode.stroke('#10b981');
            bodyNode.strokeWidth(2.4);
            setDragFeedback({
              tone: 'ok',
              text: `微调落位 · X ${Math.round(snapped.x)}, Y ${Math.round(snapped.y)} mm`
            });
          } else {
            bodyNode.stroke('#e11d48');
            bodyNode.strokeWidth(2.4);
            setDragFeedback({ tone: 'err', text: check.reason });
          }
        }
      });
      pcGroup.on('dragend', (e: any) => {
        e.cancelBubble = true;
        cullEntry.dragging = false;
        host.style.cursor = '';
        bodyNode.shadowEnabled(false);
        bodyNode.dash(pc.gapFill ? [5, 3] : []);
        bodyNode.stroke(style.stroke);
        bodyNode.strokeWidth(1.4);
        setDragFeedback(null);

        const p = propsRef.current;
        const fx = pcGroup.x();
        const fy = pcGroup.y();
        const cx = fx + pc.width / 2;
        const cy = fy + pc.height / 2;

        const insideRoll = cx >= 0 && cx <= p.rollWidthMm && cy >= 0 && cy <= p.rollLengthMm;
        if (!insideRoll) {
          propsRef.current.onRemovePlacedPiece?.(pc.index);
          return;
        }

        const fitsW = pc.width <= p.rollWidthMm;
        const fitsH = pc.height <= Math.max(0, p.rollLengthMm - p.trimStartMm);
        const clampedX = fitsW ? Math.max(0, Math.min(p.rollWidthMm - pc.width, fx)) : fx;
        const clampedY = fitsH
          ? Math.max(p.trimStartMm, Math.min(p.rollLengthMm - pc.height, fy))
          : fy;
        const check = validateRollPlacement(
          pc.shape,
          pc.width,
          pc.height,
          clampedX,
          clampedY,
          pc.index
        );
        if (check.ok) {
          if (Math.abs(clampedX - origX) > 0.05 || Math.abs(clampedY - origY) > 0.05) {
            propsRef.current.onMovePlacedPiece?.(pc.index, round1(clampedX), round1(clampedY));
          } else {
            pcGroup.position({ x: origX, y: origY });
            refs.piecesLayerRef.current?.batchDraw();
          }
        } else {
          pcGroup.position({ x: origX, y: origY });
          refs.piecesLayerRef.current?.batchDraw();
          propsRef.current.onCollisionNotice?.(check.reason);
        }
      });
    }

    placedLayerGroup.add(pcGroup);
  }

  // 2.2 疵点禁入区与交互手柄
  const defectLayerGroup = new Konva.Group();
  piecesRollGroup.add(defectLayerGroup);

  for (const d of p0.defects) {
    const defId = String(d.id);
    const isSelected = p0.selectedDefectId != null && String(p0.selectedDefectId) === defId;
    const canInteract = Boolean(p0.onDefectSelect || d.editable);
    const canEdit = Boolean(d.editable && p0.onDefectEdit && p0.tool !== 'defect' && p0.tool !== 'measure');
    const margin = d.margin ?? 0;

    if (margin > 0) {
      defectLayerGroup.add(
        new Konva.Rect({
          x: Math.max(0, d.x - margin),
          y: Math.max(0, d.y - margin),
          width: Math.min(p0.rollWidthMm - Math.max(0, d.x - margin), d.w + margin * 2),
          height: Math.min(p0.rollLengthMm - Math.max(0, d.y - margin), d.h + margin * 2),
          fill: 'rgba(239, 68, 68, 0.05)',
          stroke: isSelected ? 'rgba(91, 97, 246, 0.55)' : 'rgba(220, 38, 38, 0.45)',
          strokeWidth: 1,
          dash: [5, 4],
          strokeScaleEnabled: false,
          listening: false
        })
      );
    }

    const defGroup = new Konva.Group({
      x: d.x,
      y: d.y,
      draggable: canEdit
    });

    const defRect = new Konva.Rect({
      width: d.w,
      height: d.h,
      fillPatternImage: refs.hatchCacheRef.current.defect,
      stroke: isSelected ? '#5b61f6' : d.fresh ? '#f97316' : '#dc2626',
      strokeWidth: isSelected ? 2.4 : 1.5,
      strokeScaleEnabled: false,
      shadowEnabled: isSelected,
      shadowColor: 'rgba(91, 97, 246, 0.35)',
      shadowBlur: 8,
      listening: canInteract
    });
    defGroup.add(defRect);

    const defTxt = new Konva.Text({
      text: d.label || '疵点',
      fill: isSelected ? '#312e81' : '#b91c1c',
      fontStyle: '600',
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
      listening: false
    });
    defGroup.add(defTxt);
    const syncDef = () => {
      const s = Math.max(0.002, refs.camRef.current.scale);
      const isVert = propsRef.current.vertical;
      const vis = isVert ? d.w * s >= 24 && d.h * s >= 14 : d.h * s >= 24 && d.w * s >= 14;
      defTxt.visible(vis);
      defTxt.fontSize(10 / s);
      defTxt.rotation(isVert ? 0 : 90);
      if (isVert) {
        defTxt.position({ x: 4 / s, y: 3 / s });
      } else {
        defTxt.position({ x: d.w - 4 / s, y: 3 / s });
      }
    };
    syncDef();
    refs.piecesScaleNodesRef.current.push(syncDef);

    if (canInteract) {
      defRect.on('mousedown touchstart', (e: any) => {
        if (propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure') return;
        e.cancelBubble = true;
        propsRef.current.onInteract?.();
        propsRef.current.onDefectSelect?.(defId);
      });
      defRect.on('mouseenter', () => {
        if (propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure') return;
        host.style.cursor = canEdit ? 'move' : 'pointer';
      });
      defRect.on('mouseleave', () => {
        host.style.cursor =
          propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure'
            ? 'crosshair'
            : '';
      });
    }

    if (canEdit) {
      defGroup.on('dragstart', (e: any) => {
        if (e.target !== defGroup) return;
        e.cancelBubble = true;
        propsRef.current.onInteract?.();
        propsRef.current.onDefectSelect?.(defId);
      });
      defGroup.on('dragend', (e: any) => {
        if (e.target !== defGroup) return;
        e.cancelBubble = true;
        const p = propsRef.current;
        const nx = Math.max(0, Math.min(p.rollWidthMm - d.w, defGroup.x()));
        const ny = Math.max(0, Math.min(p.rollLengthMm - d.h, defGroup.y()));
        defGroup.position({ x: nx, y: ny });
        p.onDefectEdit?.(defId, {
          u: round1(ny),
          v: round1(nx),
          du: round1(d.h),
          dv: round1(d.w)
        });
      });

      if (isSelected) {
        const corners: { id: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }[] = [
          { id: 'nw', x: 0, y: 0 },
          { id: 'ne', x: d.w, y: 0 },
          { id: 'sw', x: 0, y: d.h },
          { id: 'se', x: d.w, y: d.h }
        ];
        for (const c of corners) {
          const handle = new Konva.Rect({
            x: c.x,
            y: c.y,
            fill: '#ffffff',
            stroke: '#5b61f6',
            strokeWidth: 1.6,
            strokeScaleEnabled: false,
            draggable: true
          });
          const syncHandle = () => {
            const s = Math.max(0.002, refs.camRef.current.scale);
            const sz = 8 / s;
            handle.size({ width: sz, height: sz });
            handle.offsetX(sz / 2);
            handle.offsetY(sz / 2);
          };
          syncHandle();
          refs.piecesScaleNodesRef.current.push(syncHandle);

          handle.on('mousedown touchstart', (e: any) => {
            e.cancelBubble = true;
          });
          handle.on('dragstart', (e: any) => {
            e.cancelBubble = true;
            propsRef.current.onInteract?.();
          });
          handle.on('dragend', (e: any) => {
            e.cancelBubble = true;
            const p = propsRef.current;
            let x0 = d.x;
            let y0 = d.y;
            let x1 = d.x + d.w;
            let y1 = d.y + d.h;
            const hx = d.x + handle.x();
            const hy = d.y + handle.y();
            if (c.id === 'nw' || c.id === 'sw') x0 = hx;
            if (c.id === 'ne' || c.id === 'se') x1 = hx;
            if (c.id === 'nw' || c.id === 'ne') y0 = hy;
            if (c.id === 'sw' || c.id === 'se') y1 = hy;
            const nx0 = Math.max(0, Math.min(p.rollWidthMm, Math.min(x0, x1)));
            const nx1 = Math.max(0, Math.min(p.rollWidthMm, Math.max(x0, x1)));
            const ny0 = Math.max(0, Math.min(p.rollLengthMm, Math.min(y0, y1)));
            const ny1 = Math.max(0, Math.min(p.rollLengthMm, Math.max(y0, y1)));
            p.onDefectEdit?.(defId, {
              u: round1(ny0),
              v: round1(nx0),
              du: round1(Math.max(1, ny1 - ny0)),
              dv: round1(Math.max(1, nx1 - nx0))
            });
          });
          defGroup.add(handle);
        }
      }
    }

    defectLayerGroup.add(defGroup);
  }

  syncCulledPieces(refs, propsRef);
  refs.piecesLayerRef.current?.batchDraw();
}
