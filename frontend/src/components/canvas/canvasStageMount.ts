import type { MutableRefObject } from 'react';
import Konva from '../../vendor/konva';
import type { BoardPoint } from './canvasTypes';
import { computeTouchPinchTransform, round1 } from './canvasGeometry';
import type { BoardCanvasLiveProps, BoardCanvasRefs } from './canvasKonvaHelpers';
import type { CameraController } from './canvasCamera';
import { renderOverlay } from './canvasDynamicOverlay';

export function mountWorkbenchStage(
  refs: BoardCanvasRefs,
  propsRef: MutableRefObject<BoardCanvasLiveProps>,
  cam: CameraController
): () => void {
  const host = refs.hostRef.current;
  if (!host || !Konva) return () => {};

  const stage = new Konva.Stage({
    container: host,
    width: Math.max(1, host.clientWidth),
    height: Math.max(1, host.clientHeight)
  });

  const baseLayer = new Konva.Layer();
  const piecesLayer = new Konva.Layer();
  const toolpathLayer = new Konva.Layer();
  const dynamicLayer = new Konva.Layer({ listening: false });

  const baseWorld = new Konva.Group();
  const piecesWorld = new Konva.Group();
  const toolpathWorld = new Konva.Group();
  const dynamicWorld = new Konva.Group({ listening: false });

  const stagingGroup = new Konva.Group();
  const baseRollGroup = new Konva.Group({ draggable: propsRef.current.tool === 'pan' });
  const piecesRollGroup = new Konva.Group();
  const toolpathRollGroup = new Konva.Group();
  const dynamicRollGroup = new Konva.Group({ listening: false });

  const feedGroup = new Konva.Group({ visible: false, listening: false });
  const feedLine = new Konva.Line({
    points: [0, 0, 1000, 0],
    stroke: '#10b981',
    strokeWidth: 2,
    strokeScaleEnabled: false,
    listening: false
  });
  const feedTagBg = new Konva.Rect({
    fill: 'rgba(16, 185, 129, 0.14)',
    stroke: '#10b981',
    strokeWidth: 1,
    strokeScaleEnabled: false,
    listening: false
  });
  const feedTagText = new Konva.Text({
    text: '',
    fill: '#047857',
    fontStyle: '700',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    listening: false
  });
  feedGroup.add(feedLine, feedTagBg, feedTagText);

  const overlayGroup = new Konva.Group({ listening: false });
  dynamicRollGroup.add(feedGroup, overlayGroup);

  baseWorld.add(stagingGroup, baseRollGroup);
  piecesWorld.add(piecesRollGroup);
  toolpathWorld.add(toolpathRollGroup);
  dynamicWorld.add(dynamicRollGroup);

  baseLayer.add(baseWorld);
  piecesLayer.add(piecesWorld);
  toolpathLayer.add(toolpathWorld);
  dynamicLayer.add(dynamicWorld);

  stage.add(baseLayer, piecesLayer, toolpathLayer, dynamicLayer);

  refs.stageRef.current = stage;
  refs.baseLayerRef.current = baseLayer;
  refs.piecesLayerRef.current = piecesLayer;
  refs.toolpathLayerRef.current = toolpathLayer;
  refs.dynamicLayerRef.current = dynamicLayer;
  refs.worldGroupsRef.current = [baseWorld, piecesWorld, toolpathWorld, dynamicWorld];
  refs.rollGroupsRef.current = [baseRollGroup, piecesRollGroup, toolpathRollGroup, dynamicRollGroup];
  refs.stagingGroupRef.current = stagingGroup;
  refs.baseRollGroupRef.current = baseRollGroup;
  refs.piecesRollGroupRef.current = piecesRollGroup;
  refs.toolpathRollGroupRef.current = toolpathRollGroup;
  refs.dynamicRollGroupRef.current = dynamicRollGroup;
  refs.feedNodesRef.current = { group: feedGroup, line: feedLine, tagBg: feedTagBg, tagText: feedTagText };
  refs.overlayGroupRef.current = overlayGroup;

  baseRollGroup.on('dragstart', (e: any) => {
    if (e.target !== baseRollGroup) return;
    host.style.cursor = 'grabbing';
    propsRef.current.onInteract?.();
  });
  baseRollGroup.on('dragmove', (e: any) => {
    if (e.target !== baseRollGroup) return;
    refs.rollOffsetRef.current = { x: baseRollGroup.x(), y: baseRollGroup.y() };
    piecesRollGroup.position(refs.rollOffsetRef.current);
    toolpathRollGroup.position(refs.rollOffsetRef.current);
    dynamicRollGroup.position(refs.rollOffsetRef.current);
    piecesLayer.batchDraw();
    toolpathLayer.batchDraw();
    dynamicLayer.batchDraw();
    cam.scheduleRulerDraw();
  });
  baseRollGroup.on('dragend', (e: any) => {
    if (e.target !== baseRollGroup) return;
    refs.rollOffsetRef.current = { x: baseRollGroup.x(), y: baseRollGroup.y() };
    piecesRollGroup.position(refs.rollOffsetRef.current);
    toolpathRollGroup.position(refs.rollOffsetRef.current);
    dynamicRollGroup.position(refs.rollOffsetRef.current);
    host.style.cursor = '';
    cam.scheduleCameraApply();
  });

  let panState: { pointerId: number; startX: number; startY: number; camX: number; camY: number } | null =
    null;
  let activeToolDrag: { kind: 'measure' | 'defect'; pointerId: number } | null = null;
  const activeTouchPointers = new Map<number, BoardPoint>();
  let pinchState: { dist: number; center: BoardPoint } | null = null;

  const getPointerFromClient = (clientX: number, clientY: number): BoardPoint => {
    const rect = host.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const clampToRoll = (pt: BoardPoint): BoardPoint => ({
    x: Math.max(0, Math.min(propsRef.current.rollWidthMm, pt.x)),
    y: Math.max(0, Math.min(propsRef.current.rollLengthMm, pt.y))
  });

  const onHostPointerDown = (evt: PointerEvent) => {
    if (evt.pointerType === 'touch') {
      activeTouchPointers.set(evt.pointerId, getPointerFromClient(evt.clientX, evt.clientY));
      if (activeTouchPointers.size === 2) {
        panState = null;
        activeToolDrag = null;
        const pts = Array.from(activeTouchPointers.values());
        pinchState = {
          dist: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
          center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        };
        propsRef.current.onInteract?.();
        return;
      }
    }

    const isMiddle = evt.button === 1;
    const isLeft = evt.button === 0;
    const curTool = propsRef.current.tool;
    const stagePt = getPointerFromClient(evt.clientX, evt.clientY);

    if (isLeft && curTool === 'measure') {
      const local = cam.stageToRollLocal(stagePt);
      if (local) {
        refs.measureLineRef.current = { p1: local, p2: local };
        activeToolDrag = { kind: 'measure', pointerId: evt.pointerId };
        renderOverlay(refs, propsRef);
        propsRef.current.onInteract?.();
      }
      return;
    }

    if (isLeft && curTool === 'defect') {
      const local = cam.stageToRollLocal(stagePt);
      if (
        local &&
        local.x >= -20 &&
        local.x <= propsRef.current.rollWidthMm + 20 &&
        local.y >= -20 &&
        local.y <= propsRef.current.rollLengthMm + 20
      ) {
        const clamped = clampToRoll(local);
        refs.defectDraftRef.current = { p1: clamped, p2: clamped };
        activeToolDrag = { kind: 'defect', pointerId: evt.pointerId };
        renderOverlay(refs, propsRef);
        propsRef.current.onInteract?.();
      }
      return;
    }

    const hitShape = stage.getIntersection(stagePt);
    const isEmptyStage = !hitShape;
    if (isEmptyStage || isMiddle || (isLeft && curTool === 'move' && isEmptyStage)) {
      if (isEmptyStage && evt.button === 0) {
        propsRef.current.onSelectPiece?.(null);
        propsRef.current.onSelectLeftover?.(null);
      }
      if (isLeft || isMiddle) {
        panState = {
          pointerId: evt.pointerId,
          startX: evt.clientX,
          startY: evt.clientY,
          camX: refs.camRef.current.x,
          camY: refs.camRef.current.y
        };
        host.style.cursor = 'grabbing';
        propsRef.current.onInteract?.();
      }
    }
  };

  const onWindowPointerMove = (evt: PointerEvent) => {
    if (evt.pointerType === 'touch' && activeTouchPointers.has(evt.pointerId)) {
      activeTouchPointers.set(evt.pointerId, getPointerFromClient(evt.clientX, evt.clientY));
      if (activeTouchPointers.size === 2 && pinchState) {
        const pts = Array.from(activeTouchPointers.values());
        const { nextCam, dist, center } = computeTouchPinchTransform(
          pts[0],
          pts[1],
          pinchState.dist,
          pinchState.center,
          refs.camRef.current
        );
        refs.camRef.current = nextCam;
        pinchState = { dist, center };
        cam.scheduleCameraApply();
        return;
      }
    }

    if (panState && evt.pointerId === panState.pointerId) {
      refs.camRef.current = {
        ...refs.camRef.current,
        x: panState.camX + (evt.clientX - panState.startX),
        y: panState.camY + (evt.clientY - panState.startY)
      };
      cam.scheduleCameraApply();
      return;
    }

    if (activeToolDrag && evt.pointerId === activeToolDrag.pointerId) {
      const local = cam.stageToRollLocal(getPointerFromClient(evt.clientX, evt.clientY));
      if (!local) return;
      if (activeToolDrag.kind === 'measure' && refs.measureLineRef.current) {
        refs.measureLineRef.current = { ...refs.measureLineRef.current, p2: local };
        renderOverlay(refs, propsRef);
      } else if (activeToolDrag.kind === 'defect' && refs.defectDraftRef.current) {
        refs.defectDraftRef.current = { ...refs.defectDraftRef.current, p2: clampToRoll(local) };
        renderOverlay(refs, propsRef);
      }
    }
  };

  const onWindowPointerUp = (evt: PointerEvent) => {
    if (evt.pointerType === 'touch') {
      activeTouchPointers.delete(evt.pointerId);
      if (activeTouchPointers.size < 2) {
        pinchState = null;
      }
    }

    if (panState && evt.pointerId === panState.pointerId) {
      panState = null;
      host.style.cursor = '';
    }

    if (activeToolDrag && evt.pointerId === activeToolDrag.pointerId) {
      const kind = activeToolDrag.kind;
      activeToolDrag = null;
      if (kind === 'defect') {
        const draft = refs.defectDraftRef.current;
        refs.defectDraftRef.current = null;
        renderOverlay(refs, propsRef);
        if (draft) {
          const minX = Math.min(draft.p1.x, draft.p2.x);
          const minY = Math.min(draft.p1.y, draft.p2.y);
          const w = Math.abs(draft.p2.x - draft.p1.x);
          const h = Math.abs(draft.p2.y - draft.p1.y);
          if (w >= 0.1 && h >= 0.1) {
            propsRef.current.onDefectDraw?.({
              u: round1(minY),
              v: round1(minX),
              du: round1(h),
              dv: round1(w)
            });
          }
        }
      }
    }
  };

  host.addEventListener('pointerdown', onHostPointerDown);
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);

  stage.on('contextmenu', (e: any) => {
    const p = propsRef.current;
    if (!p.onContextMenu && !p.onContextInspect) return;
    e.evt.preventDefault();
    const pt = stage.getPointerPosition();
    const local = pt ? cam.stageToRollLocal(pt) : null;
    const lx = local ? round1(local.x) : 0;
    const ly = local ? round1(local.y) : 0;
    p.onContextMenu?.({
      kind: 'empty',
      clientX: e.evt.clientX,
      clientY: e.evt.clientY,
      localX: lx,
      localY: ly
    });
    if (local) {
      p.onContextInspect?.({ x: lx, y: ly });
    }
  });

  stage.on('mousemove pointermove', () => {
    const pt = stage.getPointerPosition();
    if (!pt) {
      refs.cursorLocalRef.current = null;
      propsRef.current.onCursorMove?.(null);
      cam.scheduleRulerDraw();
      return;
    }
    const local = cam.stageToRollLocal(pt);
    const p = propsRef.current;
    if (
      local &&
      local.x >= 0 &&
      local.x <= p.rollWidthMm &&
      local.y >= 0 &&
      local.y <= p.rollLengthMm
    ) {
      const rounded = { x: round1(local.x), y: round1(local.y) };
      refs.cursorLocalRef.current = rounded;
      propsRef.current.onCursorMove?.(rounded);
    } else {
      refs.cursorLocalRef.current = null;
      propsRef.current.onCursorMove?.(null);
    }
    cam.scheduleRulerDraw();
  });

  stage.on('mouseleave', () => {
    refs.cursorLocalRef.current = null;
    propsRef.current.onCursorMove?.(null);
    cam.scheduleRulerDraw();
  });

  stage.on('wheel', (e: any) => {
    e.evt.preventDefault();
    propsRef.current.onInteract?.();
    const pt = stage.getPointerPosition();
    const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    cam.zoomBy(factor, pt || undefined);
  });

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w > 20 && h > 20) {
      stage.size({ width: w, height: h });
      if (!refs.didInitialFitRef.current) {
        refs.didInitialFitRef.current = true;
        cam.fitView();
      } else {
        cam.scheduleCameraApply();
      }
    }
  });
  ro.observe(host);

  return () => {
    ro.disconnect();
    if (refs.rafCamIdRef.current != null) window.cancelAnimationFrame(refs.rafCamIdRef.current);
    if (refs.rafRulerIdRef.current != null) window.cancelAnimationFrame(refs.rafRulerIdRef.current);
    host.removeEventListener('pointerdown', onHostPointerDown);
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);
    window.removeEventListener('pointercancel', onWindowPointerUp);
    stage.destroy();
    refs.stageRef.current = null;
    refs.baseLayerRef.current = null;
    refs.piecesLayerRef.current = null;
    refs.toolpathLayerRef.current = null;
    refs.dynamicLayerRef.current = null;
    refs.worldGroupsRef.current = [];
    refs.rollGroupsRef.current = [];
    refs.stagingGroupRef.current = null;
    refs.baseRollGroupRef.current = null;
    refs.piecesRollGroupRef.current = null;
    refs.toolpathRollGroupRef.current = null;
    refs.dynamicRollGroupRef.current = null;
    refs.feedNodesRef.current = null;
    refs.overlayGroupRef.current = null;
  };
}
