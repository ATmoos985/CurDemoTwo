import React, { useEffect, useRef, useState } from 'react';
import { validateRollPlacement as validateRollPlacementPure } from '../pages/workbench/boardPlacementValidation';
import type {
  BoardContextMenuEvent,
  BoardCutLine,
  BoardDefect,
  BoardDemandSpec,
  BoardLeftover,
  BoardPlacedPiece,
  BoardPoint,
  BoardShapeGeometry,
  BoardZone,
  WorkbenchBoardCanvasProps,
  WorkbenchBoardHandle
} from './canvas/canvasTypes';
import {
  CameraState,
  computeStagingLayout,
  computeToolpathSegments,
  computeTouchPinchTransform,
  computeViewportWorldRect,
  createHatchTile,
  isWorldBoxVisible,
  mapArrowKeyToRollDelta,
  rollLocalBoxToWorldRect,
  round1,
  styleForDemand
} from './canvas/canvasGeometry';
import { drawScreenRulers, RULER_THICKNESS } from './canvas/canvasRuler';

export type {
  BoardPoint,
  BoardShapeGeometry,
  BoardDemandSpec,
  BoardPlacedPiece,
  BoardLeftover,
  BoardDefect,
  BoardZone,
  BoardCutLine,
  BoardContextMenuEvent,
  WorkbenchBoardHandle,
  WorkbenchBoardCanvasProps
};

interface DragFeedbackState {
  tone: 'ok' | 'err' | 'return';
  text: string;
}

interface CulledPieceEntry {
  node: any;
  localX: number;
  localY: number;
  width: number;
  height: number;
  dragging: boolean;
  syncLabel: () => void;
}

function isDocumentDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.theme === 'dark';
}

function makeShapeNode(
  Konva: any,
  shape: BoardShapeGeometry | undefined,
  w: number,
  h: number,
  attrs: Record<string, any>
) {
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    return new Konva.Line({
      points: shape.vertices.flatMap((pt) => [pt.x, pt.y]),
      closed: true,
      strokeScaleEnabled: false,
      perfectDrawEnabled: false,
      ...attrs
    });
  }
  return new Konva.Rect({
    width: w,
    height: h,
    cornerRadius: 0,
    strokeScaleEnabled: false,
    perfectDrawEnabled: false,
    ...attrs
  });
}

function buildBaseSignature(p: {
  rollTitle: string;
  rollWidthMm: number;
  rollLengthMm: number;
  occupiedLengthMm: number;
  trimStartMm: number;
  demands: BoardDemandSpec[];
  zones: BoardZone[];
  rollShape: BoardShapeGeometry | null;
  showStaging: boolean;
  interactivePieces: boolean;
  vertical: boolean;
  tool: string;
  dark: boolean;
}): string {
  const demSig = p.demands
    .map((d) => `${d.key}:${d.width}x${d.length}:${d.remainingQty}:${d.shape?.type || 'R'}`)
    .join('|');
  const zoneSig = p.zones
    .map((z) => `${z.id}:${z.kind}:${z.startY}:${z.lengthMm}:${z.label || ''}`)
    .join('|');
  const shapeSig = p.rollShape
    ? `${p.rollShape.type}:${p.rollShape.width}x${p.rollShape.height}:${p.rollShape.vertices?.length || 0}`
    : '';
  return `${p.rollTitle}|${p.rollWidthMm}x${p.rollLengthMm}|occ=${p.occupiedLengthMm}|trim=${p.trimStartMm}|st=${p.showStaging ? 1 : 0}|ip=${p.interactivePieces ? 1 : 0}|v=${p.vertical ? 1 : 0}|t=${p.tool}|dk=${p.dark ? 1 : 0}|d=${demSig}|z=${zoneSig}|s=${shapeSig}`;
}

function buildPiecesSignature(p: {
  placedPieces: BoardPlacedPiece[];
  defects: BoardDefect[];
  selectedDefectId: string | null;
  interactivePieces: boolean;
  vertical: boolean;
  tool: string;
  rollWidthMm: number;
  rollLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  hasDefectHandlers: boolean;
}): string {
  const pcSig = p.placedPieces
    .map(
      (pc) =>
        `${pc.id}:${pc.index}:${pc.demandKey}:${pc.x},${pc.y},${pc.width}x${pc.height}:${pc.rotationDegrees || 0}:${pc.gapFill ? 1 : 0}:${pc.shape?.type || 'R'}:${pc.shape?.vertices?.length || 0}`
    )
    .join('|');
  const defSig = p.defects
    .map(
      (d) =>
        `${d.id}:${d.x},${d.y},${d.w}x${d.h}:${d.margin ?? 0}:${d.editable ? 1 : 0}:${d.fresh ? 1 : 0}:${d.label || ''}`
    )
    .join('|');
  return `${p.rollWidthMm}x${p.rollLengthMm}|trim=${p.trimStartMm}|gap=${p.pieceGapMm}|ip=${p.interactivePieces ? 1 : 0}|v=${p.vertical ? 1 : 0}|t=${p.tool}|selDef=${p.selectedDefectId || ''}|hd=${p.hasDefectHandlers ? 1 : 0}|pc=${pcSig}|df=${defSig}`;
}

export const WorkbenchBoardCanvas: React.FC<WorkbenchBoardCanvasProps> = ({
  rollTitle,
  rollWidthMm,
  rollLengthMm,
  occupiedLengthMm,
  trimStartMm,
  pieceGapMm,
  defects,
  demands,
  placedPieces,
  leftovers = [],
  cuts = [],
  zones = [],
  rollShape = null,
  feedPositionMm = null,
  selectedDefectId = null,
  selectedLeftoverId = null,
  simCutStep = null,
  startCorner = 'left-top',
  showStaging = true,
  interactivePieces = true,
  vertical = true,
  tool = 'pan',
  showDimensions,
  showPath,
  highlightedDemandKey,
  selectedPieceIndex,
  ariaLabel = '二维交互排料工作台画布',
  onDropStagingPiece,
  onMovePlacedPiece,
  onNudgePlacedPiece,
  onRotatePlacedPiece,
  onRemovePlacedPiece,
  onUndo,
  onRedo,
  onSelectLeftover,
  onHoverDemandKey,
  onSelectPiece,
  onCursorMove,
  onCollisionNotice,
  onInteract,
  onContextInspect,
  onContextMenu,
  onDefectSelect,
  onDefectDraw,
  onDefectEdit,
  boardRef
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragFeedback, setDragFeedback] = useState<DragFeedbackState | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [darkTheme, setDarkTheme] = useState<boolean>(() => isDocumentDarkTheme());

  // 监听全局 data-theme 变化，保证浅色工业 / 暗色车间大屏无缝同步画布与标尺
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDarkTheme(root.dataset.theme === 'dark');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // 四层独立 Konva Layer + 共享坐标变换的 world/roll Group refs
  const stageRef = useRef<any>(null);
  const baseLayerRef = useRef<any>(null);
  const piecesLayerRef = useRef<any>(null);
  const toolpathLayerRef = useRef<any>(null);
  const dynamicLayerRef = useRef<any>(null);

  const worldGroupsRef = useRef<any[]>([]);
  const rollGroupsRef = useRef<any[]>([]);
  const stagingGroupRef = useRef<any>(null);
  const baseRollGroupRef = useRef<any>(null);
  const piecesRollGroupRef = useRef<any>(null);
  const toolpathRollGroupRef = useRef<any>(null);
  const dynamicRollGroupRef = useRef<any>(null);

  // 持久化的验布跑布线节点（零销毁重建，10Hz 仅原地改坐标与文本）
  const feedNodesRef = useRef<{
    group: any;
    line: any;
    tagBg: any;
    tagText: any;
  } | null>(null);
  const overlayGroupRef = useRef<any>(null);

  // 各层缩放自适应回调，分开存储以支持按层独立重建
  const baseScaleNodesRef = useRef<(() => void)[]>([]);
  const piecesScaleNodesRef = useRef<(() => void)[]>([]);
  const toolpathScaleNodesRef = useRef<(() => void)[]>([]);
  const culledPiecesRef = useRef<CulledPieceEntry[]>([]);

  const lastBaseSigRef = useRef<string>('');
  const lastPiecesSigRef = useRef<string>('');

  const camRef = useRef<CameraState>({
    x: 40,
    y: 40,
    scale: 0.25,
    fitScale: 0.25
  });
  const rollOffsetRef = useRef<BoardPoint>({ x: 0, y: 0 });
  const cursorLocalRef = useRef<BoardPoint | null>(null);
  const stagingOffsetsRef = useRef<Map<string, BoardPoint>>(new Map());
  const stagingBoundsRef = useRef<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 1500,
    height: 3000
  });
  const didInitialFitRef = useRef<boolean>(false);
  const lastFitSigRef = useRef<string>('');
  const rafCamIdRef = useRef<number | null>(null);
  const rafRulerIdRef = useRef<number | null>(null);

  const hatchCacheRef = useRef<{
    trim?: HTMLCanvasElement;
    defect?: HTMLCanvasElement;
    cut?: HTMLCanvasElement;
    used?: HTMLCanvasElement;
    leftover?: HTMLCanvasElement;
  }>({});
  const measureLineRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);
  const defectDraftRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);

  // 高亮/选中快速更新表（零几何重建）
  const pieceNodeMapRef = useRef<
    {
      node: any;
      outline: any;
      demandKey: string;
      baseStroke: string;
      placedIndex: number | null;
      gapFill?: boolean;
      layerKind: 'base' | 'pieces';
    }[]
  >([]);

  const propsRef = useRef({
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    demands,
    placedPieces,
    leftovers,
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    selectedLeftoverId,
    simCutStep,
    startCorner,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath,
    highlightedDemandKey,
    selectedPieceIndex,
    darkTheme,
    onDropStagingPiece,
    onMovePlacedPiece,
    onNudgePlacedPiece,
    onRotatePlacedPiece,
    onRemovePlacedPiece,
    onUndo,
    onRedo,
    onSelectLeftover,
    onHoverDemandKey,
    onSelectPiece,
    onCursorMove,
    onCollisionNotice,
    onInteract,
    onContextInspect,
    onContextMenu,
    onDefectSelect,
    onDefectDraw,
    onDefectEdit
  });
  propsRef.current = {
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    demands,
    placedPieces,
    leftovers,
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    selectedLeftoverId,
    simCutStep,
    startCorner,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath,
    highlightedDemandKey,
    selectedPieceIndex,
    darkTheme,
    onDropStagingPiece,
    onMovePlacedPiece,
    onNudgePlacedPiece,
    onRotatePlacedPiece,
    onRemovePlacedPiece,
    onUndo,
    onRedo,
    onSelectLeftover,
    onHoverDemandKey,
    onSelectPiece,
    onCursorMove,
    onCollisionNotice,
    onInteract,
    onContextInspect,
    onContextMenu,
    onDefectSelect,
    onDefectDraw,
    onDefectEdit
  };

  const getRollWorldRect = () => {
    const p = propsRef.current;
    const ro = rollOffsetRef.current;
    const w = Math.max(1, p.rollWidthMm);
    const l = Math.max(1, p.rollLengthMm);
    if (p.vertical) {
      return { x: ro.x, y: ro.y, width: w, height: l };
    }
    return { x: ro.x, y: ro.y - w, width: l, height: w };
  };

  const syncAllRollGroupsTransform = () => {
    const ro = rollOffsetRef.current;
    const rot = propsRef.current.vertical ? 0 : -90;
    for (const rg of rollGroupsRef.current) {
      if (!rg) continue;
      rg.position(ro);
      rg.rotation(rot);
    }
  };

  const stageToRollLocal = (stagePt: { x: number; y: number }): BoardPoint | null => {
    const rollGroup = baseRollGroupRef.current;
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
    const canvas = rulerCanvasRef.current;
    const host = hostRef.current;
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
      cam: camRef.current,
      rollOffset: rollOffsetRef.current,
      rollWidthMm: p.rollWidthMm,
      rollLengthMm: p.rollLengthMm,
      vertical: p.vertical,
      cursorLocal: cursorLocalRef.current,
      dark: p.darkTheme,
      dpr
    });
  };

  const scheduleRulerDraw = () => {
    if (rafRulerIdRef.current != null) return;
    rafRulerIdRef.current = window.requestAnimationFrame(() => {
      rafRulerIdRef.current = null;
      drawRulersNow();
    });
  };

  /** 原地更新独立动态 Layer 上的验布线（零节点创建/销毁，专为 10Hz 跑布设计）。 */
  const updateFeedLineVisual = (drawLayer = true) => {
    const fn = feedNodesRef.current;
    const dynLayer = dynamicLayerRef.current;
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
    const s = Math.max(0.002, camRef.current.scale);
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
  };

  const renderOverlay = () => {
    const Konva = (globalThis as any).Konva;
    const overlay = overlayGroupRef.current;
    const dynLayer = dynamicLayerRef.current;
    if (!Konva || !overlay || !dynLayer) return;
    overlay.destroyChildren();
    const s = Math.max(0.03, camRef.current.scale);
    const isVert = propsRef.current.vertical;

    const m = measureLineRef.current;
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

    const d = defectDraftRef.current;
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
  };

  /** 视口裁剪（Viewport Culling）：跳过完全在视口外的裁片标签同步并按需裁剪隐藏。 */
  const syncCulledPieces = () => {
    const host = hostRef.current;
    const entries = culledPiecesRef.current;
    if (!host || entries.length === 0) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    const viewportWorld = computeViewportWorldRect(camRef.current, vw, vh, 64);
    const ro = rollOffsetRef.current;
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
  };

  const applyCameraImmediate = () => {
    const worldGroups = worldGroupsRef.current;
    if (!worldGroups.length) return;
    const c = camRef.current;
    for (const wg of worldGroups) {
      if (!wg) continue;
      wg.position({ x: c.x, y: c.y });
      wg.scale({ x: c.scale, y: c.scale });
    }
    for (const fn of baseScaleNodesRef.current) fn();
    for (const fn of piecesScaleNodesRef.current) fn();
    for (const fn of toolpathScaleNodesRef.current) fn();
    syncCulledPieces();
    updateFeedLineVisual(false);
    renderOverlay();

    baseLayerRef.current?.batchDraw();
    piecesLayerRef.current?.batchDraw();
    toolpathLayerRef.current?.batchDraw();
    dynamicLayerRef.current?.batchDraw();
    drawRulersNow();

    const relPct =
      c.fitScale > 0 ? Math.round((c.scale / c.fitScale) * 100) : Math.round(c.scale * 400);
    setZoomPct(Math.max(10, Math.min(999, relPct)));
  };

  /** 平移/缩放 rAF 节流，合并同一帧内多次滚轮/拖拽相机变更。 */
  const scheduleCameraApply = () => {
    if (rafCamIdRef.current != null) return;
    rafCamIdRef.current = window.requestAnimationFrame(() => {
      rafCamIdRef.current = null;
      applyCameraImmediate();
    });
  };

  const fitView = () => {
    const host = hostRef.current;
    const stage = stageRef.current;
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
      const sb = stagingBoundsRef.current;
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

    camRef.current = { x, y, scale, fitScale: scale };
    applyCameraImmediate();
  };

  const focusRange = (startY: number, endY: number, startX?: number, endX?: number) => {
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!host || !stage) return;
    const vw = host.clientWidth;
    const vh = host.clientHeight;
    if (vw < 40 || vh < 40) return;

    const p = propsRef.current;
    const ro = rollOffsetRef.current;
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

    camRef.current = { x, y, scale, fitScale: scale };
    applyCameraImmediate();
  };

  /** 跟随验布线位置：若当前已在局部视野则平移跟踪，首次或全卷视角下自动聚焦合理跨度。 */
  const followPosition = (yMm: number) => {
    const host = hostRef.current;
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
    const cur = camRef.current;
    // 如果当前缩放比远离跟拍视野（例如刚从全卷切回），调用 focusRange；否则仅平滑平移，避免抖动
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

    const ro = rollOffsetRef.current;
    const rulerPad = p.showDimensions ? RULER_THICKNESS : 0;
    if (p.vertical) {
      const targetScreenY = rulerPad + (vh - rulerPad) * 0.5;
      const nextCamY = targetScreenY - (ro.y + yMm) * cur.scale;
      if (Math.abs(nextCamY - cur.y) < 0.5) return;
      camRef.current = { ...cur, y: nextCamY };
    } else {
      const targetScreenX = rulerPad + (vw - rulerPad) * 0.5;
      const nextCamX = targetScreenX - (ro.x + yMm) * cur.scale;
      if (Math.abs(nextCamX - cur.x) < 0.5) return;
      camRef.current = { ...cur, x: nextCamX };
    }
    scheduleCameraApply();
  };

  const clearMeasure = () => {
    measureLineRef.current = null;
    renderOverlay();
  };

  const zoomBy = (factor: number, centerPx?: { x: number; y: number }) => {
    const host = hostRef.current;
    if (!host) return;
    const cx = centerPx ? centerPx.x : host.clientWidth / 2;
    const cy = centerPx ? centerPx.y : host.clientHeight / 2;
    const c = camRef.current;
    const nextScale = Math.max(0.002, Math.min(5.0, c.scale * factor));
    const worldX = (cx - c.x) / c.scale;
    const worldY = (cy - c.y) / c.scale;
    camRef.current = {
      ...c,
      scale: nextScale,
      x: cx - worldX * nextScale,
      y: cy - worldY * nextScale
    };
    scheduleCameraApply();
  };

  const resetRollOffset = () => {
    rollOffsetRef.current = { x: 0, y: 0 };
    syncAllRollGroupsTransform();
    fitView();
  };

  useEffect(() => {
    if (!boardRef) return;
    boardRef.current = {
      fit: fitView,
      zoom: (f: number) => zoomBy(f),
      resetRollOffset,
      focusRange,
      followPosition,
      clearMeasure
    };
    return () => {
      if (boardRef) boardRef.current = null;
    };
  }, [boardRef]);

  // 1. 仅挂载一次 Konva Stage 与四层 Layer（静态底图 / 裁片疵点 / 料头刀路 / 动态验布线交互）
  useEffect(() => {
    const host = hostRef.current;
    const Konva = (globalThis as any).Konva;
    if (!host || !Konva) return;

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

    // 持久化验布跑布线与标签节点（位于独立 dynamicLayer，永不销毁重建）
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

    stageRef.current = stage;
    baseLayerRef.current = baseLayer;
    piecesLayerRef.current = piecesLayer;
    toolpathLayerRef.current = toolpathLayer;
    dynamicLayerRef.current = dynamicLayer;
    worldGroupsRef.current = [baseWorld, piecesWorld, toolpathWorld, dynamicWorld];
    rollGroupsRef.current = [baseRollGroup, piecesRollGroup, toolpathRollGroup, dynamicRollGroup];
    stagingGroupRef.current = stagingGroup;
    baseRollGroupRef.current = baseRollGroup;
    piecesRollGroupRef.current = piecesRollGroup;
    toolpathRollGroupRef.current = toolpathRollGroup;
    dynamicRollGroupRef.current = dynamicRollGroup;
    feedNodesRef.current = { group: feedGroup, line: feedLine, tagBg: feedTagBg, tagText: feedTagText };
    overlayGroupRef.current = overlayGroup;

    // 整卷刚体拖动：同步其余 3 层的 rollGroup 偏移，不修改裁片自身局部坐标
    baseRollGroup.on('dragstart', (e: any) => {
      if (e.target !== baseRollGroup) return;
      host.style.cursor = 'grabbing';
      propsRef.current.onInteract?.();
    });
    baseRollGroup.on('dragmove', (e: any) => {
      if (e.target !== baseRollGroup) return;
      rollOffsetRef.current = { x: baseRollGroup.x(), y: baseRollGroup.y() };
      piecesRollGroup.position(rollOffsetRef.current);
      toolpathRollGroup.position(rollOffsetRef.current);
      dynamicRollGroup.position(rollOffsetRef.current);
      piecesLayer.batchDraw();
      toolpathLayer.batchDraw();
      dynamicLayer.batchDraw();
      scheduleRulerDraw();
    });
    baseRollGroup.on('dragend', (e: any) => {
      if (e.target !== baseRollGroup) return;
      rollOffsetRef.current = { x: baseRollGroup.x(), y: baseRollGroup.y() };
      piecesRollGroup.position(rollOffsetRef.current);
      toolpathRollGroup.position(rollOffsetRef.current);
      dynamicRollGroup.position(rollOffsetRef.current);
      host.style.cursor = '';
      scheduleCameraApply();
    });

    // Pointer Events 统一处理：单指平移、测距/画疵点、以及双指捏合缩放
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
          // 进入双指捏合缩放，取消任何进行中的单指平移/画框
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
        const local = stageToRollLocal(stagePt);
        if (local) {
          measureLineRef.current = { p1: local, p2: local };
          activeToolDrag = { kind: 'measure', pointerId: evt.pointerId };
          renderOverlay();
          propsRef.current.onInteract?.();
        }
        return;
      }

      if (isLeft && curTool === 'defect') {
        const local = stageToRollLocal(stagePt);
        if (
          local &&
          local.x >= -20 &&
          local.x <= propsRef.current.rollWidthMm + 20 &&
          local.y >= -20 &&
          local.y <= propsRef.current.rollLengthMm + 20
        ) {
          const clamped = clampToRoll(local);
          defectDraftRef.current = { p1: clamped, p2: clamped };
          activeToolDrag = { kind: 'defect', pointerId: evt.pointerId };
          renderOverlay();
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
            camX: camRef.current.x,
            camY: camRef.current.y
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
            camRef.current
          );
          camRef.current = nextCam;
          pinchState = { dist, center };
          scheduleCameraApply();
          return;
        }
      }

      if (panState && evt.pointerId === panState.pointerId) {
        camRef.current = {
          ...camRef.current,
          x: panState.camX + (evt.clientX - panState.startX),
          y: panState.camY + (evt.clientY - panState.startY)
        };
        scheduleCameraApply();
        return;
      }

      if (activeToolDrag && evt.pointerId === activeToolDrag.pointerId) {
        const local = stageToRollLocal(getPointerFromClient(evt.clientX, evt.clientY));
        if (!local) return;
        if (activeToolDrag.kind === 'measure' && measureLineRef.current) {
          measureLineRef.current = { ...measureLineRef.current, p2: local };
          renderOverlay();
        } else if (activeToolDrag.kind === 'defect' && defectDraftRef.current) {
          defectDraftRef.current = { ...defectDraftRef.current, p2: clampToRoll(local) };
          renderOverlay();
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
          const draft = defectDraftRef.current;
          defectDraftRef.current = null;
          renderOverlay();
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
      const local = pt ? stageToRollLocal(pt) : null;
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
        cursorLocalRef.current = null;
        propsRef.current.onCursorMove?.(null);
        scheduleRulerDraw();
        return;
      }
      const local = stageToRollLocal(pt);
      const p = propsRef.current;
      if (
        local &&
        local.x >= 0 &&
        local.x <= p.rollWidthMm &&
        local.y >= 0 &&
        local.y <= p.rollLengthMm
      ) {
        const rounded = { x: round1(local.x), y: round1(local.y) };
        cursorLocalRef.current = rounded;
        propsRef.current.onCursorMove?.(rounded);
      } else {
        cursorLocalRef.current = null;
        propsRef.current.onCursorMove?.(null);
      }
      scheduleRulerDraw();
    });

    stage.on('mouseleave', () => {
      cursorLocalRef.current = null;
      propsRef.current.onCursorMove?.(null);
      scheduleRulerDraw();
    });

    stage.on('wheel', (e: any) => {
      e.evt.preventDefault();
      propsRef.current.onInteract?.();
      const pt = stage.getPointerPosition();
      const factor = e.evt.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomBy(factor, pt || undefined);
    });

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w > 20 && h > 20) {
        stage.size({ width: w, height: h });
        if (!didInitialFitRef.current) {
          didInitialFitRef.current = true;
          fitView();
        } else {
          scheduleCameraApply();
        }
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      if (rafCamIdRef.current != null) window.cancelAnimationFrame(rafCamIdRef.current);
      if (rafRulerIdRef.current != null) window.cancelAnimationFrame(rafRulerIdRef.current);
      host.removeEventListener('pointerdown', onHostPointerDown);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      stage.destroy();
      stageRef.current = null;
      baseLayerRef.current = null;
      piecesLayerRef.current = null;
      toolpathLayerRef.current = null;
      dynamicLayerRef.current = null;
      worldGroupsRef.current = [];
      rollGroupsRef.current = [];
      stagingGroupRef.current = null;
      baseRollGroupRef.current = null;
      piecesRollGroupRef.current = null;
      toolpathRollGroupRef.current = null;
      dynamicRollGroupRef.current = null;
      feedNodesRef.current = null;
      overlayGroupRef.current = null;
    };
  }, []);

  // 同步工具光标与整卷拖动手柄开关
  useEffect(() => {
    const rollGroup = baseRollGroupRef.current;
    const host = hostRef.current;
    if (rollGroup) {
      rollGroup.draggable(tool === 'pan');
    }
    if (host) {
      host.style.cursor = tool === 'defect' || tool === 'measure' ? 'crosshair' : '';
    }
    if (tool !== 'measure' && measureLineRef.current) {
      measureLineRef.current = null;
      renderOverlay();
    }
  }, [tool]);

  // 键盘快捷键：撤销/重做、方向键微调（1mm / Shift 0.1mm）、R 旋转、Delete 退回、Esc 取消选中
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const p = propsRef.current;
      if (!p.interactivePieces) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const lowerKey = e.key.toLowerCase();

      if (mod && !e.altKey) {
        if (lowerKey === 'z' && !e.shiftKey) {
          e.preventDefault();
          p.onUndo?.();
          return;
        }
        if (lowerKey === 'y' || (lowerKey === 'z' && e.shiftKey)) {
          e.preventDefault();
          p.onRedo?.();
          return;
        }
      }

      const selIdx = p.selectedPieceIndex;
      if (selIdx == null) {
        if (e.key === 'Escape') {
          p.onSelectLeftover?.(null);
        }
        return;
      }

      if (
        !mod &&
        !e.altKey &&
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown')
      ) {
        e.preventDefault();
        const stepMm = e.shiftKey ? 0.1 : 1;
        const { dx, dy } = mapArrowKeyToRollDelta(e.key, stepMm, p.vertical);
        p.onNudgePlacedPiece?.(selIdx, dx, dy);
        return;
      }

      if ((e.key === 'r' || e.key === 'R') && !mod && !e.altKey) {
        e.preventDefault();
        p.onRotatePlacedPiece?.(selIdx);
      } else if (e.key === 'Escape') {
        p.onSelectPiece?.(null);
        p.onSelectLeftover?.(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
        e.preventDefault();
        p.onRemovePlacedPiece?.(selIdx);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const validateRollPlacement = (
    shape: BoardShapeGeometry | undefined,
    w: number,
    h: number,
    localX: number,
    localY: number,
    ignorePieceIndex: number
  ): { ok: boolean; reason: string } => {
    const p = propsRef.current;
    return validateRollPlacementPure({
      shape,
      w,
      h,
      localX,
      localY,
      ignorePieceIndex,
      rollWidthMm: p.rollWidthMm,
      rollLengthMm: p.rollLengthMm,
      trimStartMm: p.trimStartMm,
      pieceGapMm: p.pieceGapMm,
      defects: p.defects,
      placedPieces: p.placedPieces
    });
  };

  const snapRollPosition = (
    w: number,
    h: number,
    rawX: number,
    rawY: number,
    ignorePieceIndex: number
  ): { x: number; y: number } => {
    const p = propsRef.current;
    const snapDist = Math.min(26, Math.max(10, 10 / Math.max(0.05, camRef.current.scale)));
    const gap = Math.max(0, p.pieceGapMm);

    const candX = [0, Math.max(0, p.rollWidthMm - w)];
    const candY = [p.trimStartMm, Math.max(p.trimStartMm, p.rollLengthMm - h)];

    for (const other of p.placedPieces) {
      if (other.index === ignorePieceIndex) continue;
      candX.push(other.x, other.x + other.width + gap, other.x - w - gap, other.x + other.width - w);
      candY.push(other.y, other.y + other.height + gap, other.y - h - gap, other.y + other.height - h);
    }

    let bestX = rawX;
    let bestDx = snapDist;
    for (const tx of candX) {
      const d = Math.abs(rawX - tx);
      if (d < bestDx) {
        bestDx = d;
        bestX = tx;
      }
    }

    let bestY = rawY;
    let bestDy = snapDist;
    for (const ty of candY) {
      const d = Math.abs(rawY - ty);
      if (d < bestDy) {
        bestDy = d;
        bestY = ty;
      }
    }

    return { x: bestX, y: bestY };
  };

  const ensureHatchTiles = () => {
    if (!hatchCacheRef.current.trim) {
      hatchCacheRef.current.trim = createHatchTile('#f1f5f9', '#cbd5e1', 10);
    }
    if (!hatchCacheRef.current.defect) {
      hatchCacheRef.current.defect = createHatchTile(
        'rgba(239, 68, 68, 0.14)',
        'rgba(220, 38, 38, 0.45)',
        9
      );
    }
    if (!hatchCacheRef.current.cut) {
      hatchCacheRef.current.cut = createHatchTile(
        'rgba(148, 163, 184, 0.16)',
        'rgba(100, 116, 139, 0.36)',
        10
      );
    }
    if (!hatchCacheRef.current.used) {
      hatchCacheRef.current.used = createHatchTile(
        'rgba(226, 232, 240, 0.42)',
        'rgba(148, 163, 184, 0.45)',
        10
      );
    }
    if (!hatchCacheRef.current.leftover) {
      hatchCacheRef.current.leftover = createHatchTile(
        'rgba(16, 185, 129, 0.08)',
        'rgba(16, 185, 129, 0.28)',
        12
      );
    }
  };

  const createLabelUpdater = (
    Konva: any,
    parent: any,
    textStr: string,
    subStr: string,
    w: number,
    h: number,
    color: string,
    inRollGroup: boolean
  ): (() => void) => {
    const titleNode = new Konva.Text({
      text: textStr,
      fill: color,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontStyle: '600',
      align: 'center',
      verticalAlign: 'middle',
      wrap: 'none',
      ellipsis: true,
      listening: false
    });
    const subNode = new Konva.Text({
      text: subStr,
      fill: color,
      opacity: 0.72,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      align: 'center',
      verticalAlign: 'middle',
      wrap: 'none',
      ellipsis: true,
      listening: false
    });
    parent.add(titleNode, subNode);

    return () => {
      const s = Math.max(0.002, camRef.current.scale);
      const horizRoll = inRollGroup && !propsRef.current.vertical;
      const screenW = (horizRoll ? h : w) * s;
      const screenH = (horizRoll ? w : h) * s;

      if (horizRoll) {
        if (screenW < 36 || screenH < 16) {
          titleNode.visible(false);
          subNode.visible(false);
          return;
        }
        const fontPx = Math.min(11.5, Math.max(8.5, Math.min(screenW / 5.5, screenH * 0.34)));
        const fontMm = fontPx / s;
        const boxW = Math.max(10, h - 8 / s);
        const lineH = fontMm * 1.28;
        const showSub = screenW >= 58 && screenH >= 34;

        titleNode.visible(true);
        titleNode.rotation(90);
        titleNode.fontSize(fontMm);
        titleNode.width(boxW);
        titleNode.height(lineH);
        titleNode.offsetX(boxW / 2);
        titleNode.offsetY(lineH / 2);

        if (showSub) {
          const subFontMm = Math.max(7.5 / s, fontMm * 0.84);
          const subLineH = subFontMm * 1.25;
          const shift = subLineH * 0.52;
          titleNode.position({ x: w / 2 + shift, y: h / 2 });
          subNode.visible(true);
          subNode.rotation(90);
          subNode.fontSize(subFontMm);
          subNode.width(boxW);
          subNode.height(subLineH);
          subNode.offsetX(boxW / 2);
          subNode.offsetY(subLineH / 2);
          subNode.position({ x: w / 2 - shift, y: h / 2 });
        } else {
          titleNode.position({ x: w / 2, y: h / 2 });
          subNode.visible(false);
        }
        return;
      }

      const useVertical = screenW >= 20 && screenW < 58 && screenH >= 48 && screenH > screenW * 1.25;
      if (useVertical) {
        const fontPx = Math.min(11, Math.max(8.5, screenW * 0.28));
        const fontMm = fontPx / s;
        const boxW = Math.max(8, h - 10 / s);
        const boxH = fontMm * 1.3;
        titleNode.visible(true);
        titleNode.fontSize(fontMm);
        titleNode.width(boxW);
        titleNode.height(boxH);
        titleNode.offsetX(boxW / 2);
        titleNode.offsetY(boxH / 2);
        titleNode.rotation(-90);
        titleNode.position({ x: w / 2, y: h / 2 });
        subNode.visible(false);
        return;
      }

      if (screenW < 40 || screenH < 18) {
        titleNode.visible(false);
        subNode.visible(false);
        return;
      }
      const fontPx = Math.min(11.5, Math.max(8.5, Math.min(screenW / 5.5, screenH * 0.34)));
      const fontMm = fontPx / s;
      const boxW = Math.max(10, w - 8 / s);
      const lineH = fontMm * 1.28;

      titleNode.visible(true);
      titleNode.rotation(0);
      titleNode.offsetX(0);
      titleNode.offsetY(0);
      titleNode.fontSize(fontMm);
      titleNode.width(boxW);
      titleNode.height(lineH);
      titleNode.x(4 / s);

      const showSub = screenW >= 62 && screenH >= 36;
      if (showSub) {
        const subFontMm = Math.max(7.5 / s, fontMm * 0.84);
        const subLineH = subFontMm * 1.25;
        subNode.visible(true);
        subNode.rotation(0);
        subNode.offsetX(0);
        subNode.offsetY(0);
        subNode.fontSize(subFontMm);
        subNode.width(boxW);
        subNode.height(subLineH);
        subNode.x(4 / s);
        const totalH = lineH + subLineH;
        titleNode.y((h - totalH) / 2);
        subNode.y((h - totalH) / 2 + lineH);
      } else {
        subNode.visible(false);
        titleNode.y((h - lineH) / 2);
      }
    };
  };

  // ==================== LAYER 1: 静态材料底图 + 左侧待排区（完全不受 10Hz 验布线与刀路仿真影响） ====================
  useEffect(() => {
    const Konva = (globalThis as any).Konva;
    const stagingGroup = stagingGroupRef.current;
    const rollGroup = baseRollGroupRef.current;
    const host = hostRef.current;
    if (!Konva || !stagingGroup || !rollGroup || !host) return;

    const sig = buildBaseSignature({
      rollTitle,
      rollWidthMm,
      rollLengthMm,
      occupiedLengthMm,
      trimStartMm,
      demands,
      zones,
      rollShape,
      showStaging,
      interactivePieces,
      vertical,
      tool,
      dark: darkTheme
    });
    if (sig === lastBaseSigRef.current) {
      return;
    }
    lastBaseSigRef.current = sig;

    stagingGroup.destroyChildren();
    rollGroup.destroyChildren();
    baseScaleNodesRef.current = [];
    pieceNodeMapRef.current = pieceNodeMapRef.current.filter((it) => it.layerKind !== 'base');

    ensureHatchTiles();
    syncAllRollGroupsTransform();
    rollGroup.draggable(tool === 'pan');

    // 1.1 左侧待排区
    if (showStaging) {
      const staging = computeStagingLayout(demands, rollWidthMm, rollLengthMm);
      stagingBoundsRef.current = staging.bounds;

      const validInstanceKeys = new Set(staging.items.map((it) => it.instanceKey));
      for (const k of Array.from(stagingOffsetsRef.current.keys())) {
        if (!validInstanceKeys.has(k)) stagingOffsetsRef.current.delete(k);
      }

      stagingGroup.add(
        new Konva.Rect({
          x: staging.bounds.x,
          y: staging.bounds.y,
          width: staging.bounds.width,
          height: staging.bounds.height,
          fill: darkTheme ? 'rgba(30, 41, 59, 0.55)' : 'rgba(255, 255, 255, 0.42)',
          stroke: darkTheme ? 'rgba(148, 163, 184, 0.25)' : 'rgba(15, 23, 42, 0.16)',
          strokeWidth: 1.2,
          dash: [6, 5],
          strokeScaleEnabled: false,
          cornerRadius: 8,
          listening: false
        })
      );

      const stagingHeader = new Konva.Text({
        text: `待排裁片 · ${staging.totalCount} 件`,
        fill: darkTheme ? '#cbd5e1' : '#52525b',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
        fontStyle: '600',
        wrap: 'none',
        listening: false
      });
      stagingGroup.add(stagingHeader);
      const syncStagingHeader = () => {
        const s = Math.max(0.002, camRef.current.scale);
        stagingHeader.fontSize(11.5 / s);
        const headerW = stagingHeader.width();
        const rightEdge = staging.bounds.x + staging.bounds.width;
        const hx = Math.min(staging.bounds.x + 2 / s, rightEdge - headerW);
        stagingHeader.position({ x: hx, y: staging.bounds.y - 24 / s });
      };
      syncStagingHeader();
      baseScaleNodesRef.current.push(syncStagingHeader);

      if (staging.items.length === 0) {
        const emptyText = new Konva.Text({
          text: '待排区已清空\n拖出母卷裁片可退回',
          fill: darkTheme ? '#94a3b8' : '#8e929b',
          align: 'center',
          lineHeight: 1.5,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
          listening: false
        });
        stagingGroup.add(emptyText);
        const syncEmpty = () => {
          const s = Math.max(0.002, camRef.current.scale);
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
        baseScaleNodesRef.current.push(syncEmpty);
      }

      for (const item of staging.items) {
        const savedPos = stagingOffsetsRef.current.get(item.instanceKey);
        const startX = savedPos ? savedPos.x : item.x;
        const startY = savedPos ? savedPos.y : item.y;

        const pieceGroup = new Konva.Group({
          x: startX,
          y: startY,
          draggable: interactivePieces
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
          false
        );
        syncLbl();
        baseScaleNodesRef.current.push(syncLbl);

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
            const s = Math.max(0.002, camRef.current.scale);
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
          baseScaleNodesRef.current.push(syncBadge);
        }

        pieceNodeMapRef.current.push({
          node: pieceGroup,
          outline: bodyNode,
          demandKey: item.demandKey,
          baseStroke: item.style.stroke,
          placedIndex: null,
          layerKind: 'base'
        });

        if (interactivePieces) {
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
            const ro = rollOffsetRef.current;
            // 将待排片世界坐标映射到母卷局部坐标（支持纵向与横向台板）
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
              const snapped = snapRollPosition(item.width, item.height, rawLocalX, rawLocalY, -1);
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
            const ro = rollOffsetRef.current;
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
                stagingOffsetsRef.current.delete(item.instanceKey);
                propsRef.current.onDropStagingPiece?.(
                  item.demandKey,
                  round1(targetX),
                  round1(targetY)
                );
              } else {
                pieceGroup.position(dragOrigin);
                baseLayerRef.current?.batchDraw();
                propsRef.current.onCollisionNotice?.(check.reason);
              }
            } else {
              stagingOffsetsRef.current.set(item.instanceKey, {
                x: pieceGroup.x(),
                y: pieceGroup.y()
              });
            }
          });
        }

        stagingGroup.add(pieceGroup);
      }
    } else {
      stagingBoundsRef.current = getRollWorldRect();
    }

    // 1.2 母卷顶部拖动手柄条
    const handleGroup = new Konva.Group();
    const handleBg = new Konva.Rect({
      fill: darkTheme ? '#1e293b' : '#ffffff',
      stroke: darkTheme ? 'rgba(148, 163, 184, 0.28)' : 'rgba(15, 23, 42, 0.14)',
      strokeWidth: 1,
      strokeScaleEnabled: false,
      cornerRadius: 6,
      shadowColor: 'rgba(15, 23, 42, 0.12)',
      shadowBlur: 6,
      shadowOffsetY: 2
    });
    const handleTitle = new Konva.Text({
      text: `${rollTitle} · ${Math.round(rollWidthMm)}×${Math.round(rollLengthMm)} mm`,
      fill: darkTheme ? '#f8fafc' : '#18181b',
      fontStyle: '600',
      wrap: 'none',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      listening: false
    });
    const handleHint = new Konva.Text({
      text: '拖动整卷',
      fill: darkTheme ? '#94a3b8' : '#8e929b',
      wrap: 'none',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      listening: false
    });
    handleGroup.add(handleBg, handleTitle, handleHint);
    handleGroup.on('mouseenter', () => {
      if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
    });
    handleGroup.on('mouseleave', () => {
      host.style.cursor =
        propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure'
          ? 'crosshair'
          : '';
    });
    rollGroup.add(handleGroup);

    const syncHandleBar = () => {
      const s = Math.max(0.002, camRef.current.scale);
      const isVert = propsRef.current.vertical;
      const barH = 26 / s;
      const gap = 8 / s;
      const padX = 10 / s;
      handleTitle.fontSize(11.5 / s);
      handleHint.fontSize(10.5 / s);
      const titleW = handleTitle.width();
      const hintW = handleHint.width();
      const baseSpan = isVert ? rollWidthMm : rollLengthMm;
      const showHint = baseSpan * s >= (titleW + hintW) * s + 34 && propsRef.current.tool === 'pan';
      const barW = Math.max(
        baseSpan,
        titleW + padX * 2 + (showHint ? hintW + 14 / s : 0)
      );

      if (isVert) {
        handleGroup.rotation(0);
        const hx = propsRef.current.showStaging ? 0 : (rollWidthMm - barW) / 2;
        handleGroup.position({ x: hx, y: -(barH + gap) });
      } else {
        handleGroup.rotation(90);
        const hy = propsRef.current.showStaging ? 0 : (rollLengthMm - barW) / 2;
        handleGroup.position({ x: rollWidthMm + barH + gap, y: hy });
      }
      handleBg.position({ x: 0, y: 0 });
      handleBg.size({ width: barW, height: barH });
      handleBg.cornerRadius(6 / s);
      handleTitle.position({ x: padX, y: 7 / s });
      handleHint.visible(showHint);
      if (showHint) {
        handleHint.position({ x: barW - hintW - padX, y: 7.5 / s });
      }
    };
    syncHandleBar();
    baseScaleNodesRef.current.push(syncHandleBar);

    // 1.3 母卷纸面（支持不规则多边形料头；暗色模式采用高对比工业深岩灰避免刺眼亮白块）
    const sheetFill = darkTheme ? '#1e293b' : '#ffffff';
    const sheetStroke = darkTheme ? '#475569' : '#cbd5e1';
    const rollSheet =
      rollShape?.type === 'POLYGON' && rollShape.vertices && rollShape.vertices.length >= 3
        ? new Konva.Line({
            points: rollShape.vertices.flatMap((pt) => [pt.x, pt.y]),
            closed: true,
            fill: sheetFill,
            stroke: sheetStroke,
            strokeWidth: 1.5,
            strokeScaleEnabled: false,
            shadowColor: darkTheme ? 'rgba(0, 0, 0, 0.42)' : 'rgba(15, 23, 42, 0.13)',
            shadowBlur: 20,
            shadowOffsetY: 6
          })
        : new Konva.Rect({
            x: 0,
            y: 0,
            width: rollWidthMm,
            height: rollLengthMm,
            fill: sheetFill,
            stroke: sheetStroke,
            strokeWidth: 1.5,
            strokeScaleEnabled: false,
            shadowColor: darkTheme ? 'rgba(0, 0, 0, 0.42)' : 'rgba(15, 23, 42, 0.13)',
            shadowBlur: 20,
            shadowOffsetY: 6
          });
    rollSheet.on('mouseenter', () => {
      if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
    });
    rollSheet.on('mouseleave', () => {
      host.style.cursor =
        propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure'
          ? 'crosshair'
          : '';
    });
    rollSheet.on('click tap', (e: any) => {
      e.cancelBubble = true;
      propsRef.current.onSelectPiece?.(null);
      propsRef.current.onSelectLeftover?.(null);
    });
    rollSheet.on('contextmenu', (e: any) => {
      const p = propsRef.current;
      if (!p.onContextMenu && !p.onContextInspect) return;
      e.evt.preventDefault();
      e.cancelBubble = true;
      const pt = stageRef.current?.getPointerPosition();
      const local = pt ? stageToRollLocal(pt) : null;
      const lx = local ? round1(local.x) : 0;
      const ly = local ? round1(local.y) : 0;
      p.onContextMenu?.({
        kind: 'empty',
        clientX: e.evt.clientX,
        clientY: e.evt.clientY,
        localX: lx,
        localY: ly
      });
      if (local) p.onContextInspect?.({ x: lx, y: ly });
    });
    rollGroup.add(rollSheet);

    // 1.4 内部米线参考
    const meterStep =
      rollLengthMm > 60000
        ? 10000
        : rollLengthMm > 20000
        ? 5000
        : rollLengthMm > 10000
        ? 2000
        : 1000;
    for (let y = meterStep; y < rollLengthMm; y += meterStep) {
      rollGroup.add(
        new Konva.Line({
          points: [0, y, rollWidthMm, y],
          stroke: 'rgba(15, 23, 42, 0.06)',
          strokeWidth: 1,
          strokeScaleEnabled: false,
          listening: false
        })
      );
    }

    // 1.5 分区（已切 / 预占 / 已使用 / 工位窗口）
    for (const z of zones) {
      const zy = Math.max(0, z.startY);
      const zh = Math.max(0, Math.min(rollLengthMm - zy, z.lengthMm));
      if (zh <= 0.1) continue;
      if (z.kind === 'window') {
        rollGroup.add(
          new Konva.Rect({
            x: 0,
            y: zy,
            width: rollWidthMm,
            height: zh,
            fill: 'rgba(16, 185, 129, 0.04)',
            stroke: 'rgba(16, 185, 129, 0.55)',
            strokeWidth: 1.3,
            dash: [6, 4],
            strokeScaleEnabled: false,
            listening: false
          })
        );
      } else {
        const isCut = z.kind === 'cut';
        const isPlanned = z.kind === 'planned';
        rollGroup.add(
          new Konva.Rect({
            x: 0,
            y: zy,
            width: rollWidthMm,
            height: zh,
            ...(isPlanned
              ? { fill: 'rgba(91, 97, 246, 0.08)' }
              : {
                  fillPatternImage: isCut ? hatchCacheRef.current.cut : hatchCacheRef.current.used
                }),
            stroke: isPlanned ? 'rgba(91, 97, 246, 0.5)' : '#94a3b8',
            strokeWidth: 1.1,
            dash: isPlanned ? [5, 4] : undefined,
            strokeScaleEnabled: false,
            listening: false
          })
        );
        if (z.label) {
          const zTxt = new Konva.Text({
            text: z.label,
            fill: isPlanned ? '#4338ca' : '#475569',
            fontStyle: '600',
            wrap: 'none',
            ellipsis: true,
            fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
            listening: false
          });
          rollGroup.add(zTxt);
          const syncZoneTxt = () => {
            const s = Math.max(0.002, camRef.current.scale);
            const isVert = propsRef.current.vertical;
            const visible = isVert
              ? zh * s >= 18 && rollWidthMm * s >= 52
              : zh * s >= 48 && rollWidthMm * s >= 20;
            zTxt.visible(visible);
            zTxt.fontSize(10.5 / s);
            zTxt.rotation(isVert ? 0 : 90);
            if (isVert) {
              zTxt.width(Math.max(10, rollWidthMm - 14 / s));
              zTxt.position({ x: 7 / s, y: zy + 5 / s });
            } else {
              zTxt.width(Math.max(10, zh - 12 / s));
              zTxt.position({ x: rollWidthMm - 6 / s, y: zy + 6 / s });
            }
          };
          syncZoneTxt();
          baseScaleNodesRef.current.push(syncZoneTxt);
        }
      }
    }

    // 1.6 首端切头修边区
    if (trimStartMm > 0) {
      const trimH = Math.min(trimStartMm, rollLengthMm);
      rollGroup.add(
        new Konva.Rect({
          x: 0,
          y: 0,
          width: rollWidthMm,
          height: trimH,
          fillPatternImage: hatchCacheRef.current.trim,
          stroke: '#94a3b8',
          strokeWidth: 1,
          dash: [4, 4],
          strokeScaleEnabled: false,
          listening: false
        })
      );
      const trimLabel = new Konva.Text({
        text: `切头修边 ${Math.round(trimStartMm)} mm`,
        fill: '#64748b',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        listening: false
      });
      rollGroup.add(trimLabel);
      const syncTrimLabel = () => {
        const s = Math.max(0.002, camRef.current.scale);
        const isVert = propsRef.current.vertical;
        trimLabel.visible(trimH * s >= 14);
        trimLabel.fontSize(10 / s);
        trimLabel.rotation(isVert ? 0 : 90);
        if (isVert) {
          trimLabel.position({ x: 8 / s, y: Math.max(2 / s, (trimH - 11 / s) / 2) });
        } else {
          trimLabel.position({ x: rollWidthMm - 8 / s, y: 4 / s });
        }
      };
      syncTrimLabel();
      baseScaleNodesRef.current.push(syncTrimLabel);
    }

    // 1.7 实占长度标记线
    if (occupiedLengthMm > 0 && occupiedLengthMm <= rollLengthMm) {
      rollGroup.add(
        new Konva.Line({
          points: [0, occupiedLengthMm, rollWidthMm, occupiedLengthMm],
          stroke: '#10b981',
          strokeWidth: 1.4,
          dash: [6, 4],
          strokeScaleEnabled: false,
          listening: false
        })
      );
      const occTag = new Konva.Text({
        text: `实占 ${round1(occupiedLengthMm)} mm`,
        fill: darkTheme ? '#34d399' : '#047857',
        fontStyle: '600',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        listening: false
      });
      rollGroup.add(occTag);
      const syncOcc = () => {
        const s = Math.max(0.002, camRef.current.scale);
        const isVert = propsRef.current.vertical;
        occTag.fontSize(10.5 / s);
        occTag.rotation(isVert ? 0 : 90);
        if (isVert) {
          occTag.position({ x: rollWidthMm + 8 / s, y: occupiedLengthMm - 6 / s });
        } else {
          occTag.position({ x: -8 / s, y: occupiedLengthMm - 4 / s });
        }
      };
      syncOcc();
      baseScaleNodesRef.current.push(syncOcc);
    }

    // 仅在卷尺寸、朝向、待排区开关或需求族变更时自动 fitView
    const fitSig = `${rollWidthMm}x${rollLengthMm}-${vertical ? 'V' : 'H'}-${showStaging ? 'S' : 'N'}-${demands.map((d) => d.key).join(',')}`;
    if (!didInitialFitRef.current || fitSig !== lastFitSigRef.current) {
      lastFitSigRef.current = fitSig;
      didInitialFitRef.current = true;
      fitView();
    } else {
      applyCameraImmediate();
    }
  }, [
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    demands,
    zones,
    rollShape,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    darkTheme
  ]);

  // ==================== LAYER 2: 裁片 + 疵点 Layer（独立重建，支持视口裁剪） ====================
  useEffect(() => {
    const Konva = (globalThis as any).Konva;
    const piecesRollGroup = piecesRollGroupRef.current;
    const host = hostRef.current;
    if (!Konva || !piecesRollGroup || !host) return;

    const sig = buildPiecesSignature({
      placedPieces,
      defects,
      selectedDefectId,
      interactivePieces,
      vertical,
      tool,
      rollWidthMm,
      rollLengthMm,
      trimStartMm,
      pieceGapMm,
      hasDefectHandlers: Boolean(onDefectSelect || onDefectEdit)
    });
    if (sig === lastPiecesSigRef.current) {
      return;
    }
    lastPiecesSigRef.current = sig;

    piecesRollGroup.destroyChildren();
    piecesScaleNodesRef.current = [];
    culledPiecesRef.current = [];
    pieceNodeMapRef.current = pieceNodeMapRef.current.filter((it) => it.layerKind !== 'pieces');

    ensureHatchTiles();
    syncAllRollGroupsTransform();

    // 2.1 已排裁片
    const placedLayerGroup = new Konva.Group();
    piecesRollGroup.add(placedLayerGroup);

    for (const pc of placedPieces) {
      const style = styleForDemand(pc.demandId, pc.index, pc.gapFill);
      const pcGroup = new Konva.Group({
        x: pc.x,
        y: pc.y,
        draggable: interactivePieces
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
        true
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
      culledPiecesRef.current.push(cullEntry);

      pieceNodeMapRef.current.push({
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

      if (interactivePieces) {
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
            const snapped = snapRollPosition(pc.width, pc.height, rawX, rawY, pc.index);
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
              piecesLayerRef.current?.batchDraw();
            }
          } else {
            pcGroup.position({ x: origX, y: origY });
            piecesLayerRef.current?.batchDraw();
            propsRef.current.onCollisionNotice?.(check.reason);
          }
        });
      }

      placedLayerGroup.add(pcGroup);
    }

    // 2.2 疵点禁入区与交互手柄
    const defectLayerGroup = new Konva.Group();
    piecesRollGroup.add(defectLayerGroup);

    for (const d of defects) {
      const defId = String(d.id);
      const isSelected = selectedDefectId != null && String(selectedDefectId) === defId;
      const canInteract = Boolean(onDefectSelect || d.editable);
      const canEdit = Boolean(d.editable && onDefectEdit && tool !== 'defect' && tool !== 'measure');
      const margin = d.margin ?? 0;

      if (margin > 0) {
        defectLayerGroup.add(
          new Konva.Rect({
            x: Math.max(0, d.x - margin),
            y: Math.max(0, d.y - margin),
            width: Math.min(rollWidthMm - Math.max(0, d.x - margin), d.w + margin * 2),
            height: Math.min(rollLengthMm - Math.max(0, d.y - margin), d.h + margin * 2),
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
        fillPatternImage: hatchCacheRef.current.defect,
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
        const s = Math.max(0.002, camRef.current.scale);
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
      piecesScaleNodesRef.current.push(syncDef);

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
              const s = Math.max(0.002, camRef.current.scale);
              const sz = 8 / s;
              handle.size({ width: sz, height: sz });
              handle.offsetX(sz / 2);
              handle.offsetY(sz / 2);
            };
            syncHandle();
            piecesScaleNodesRef.current.push(syncHandle);

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

    syncCulledPieces();
    piecesLayerRef.current?.batchDraw();
  }, [
    placedPieces,
    defects,
    selectedDefectId,
    interactivePieces,
    vertical,
    tool,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    onDefectSelect,
    onDefectEdit
  ]);

  // ==================== LAYER 3: 料头与刀路 Layer（含走刀动画仿真与余料交互） ====================
  useEffect(() => {
    const Konva = (globalThis as any).Konva;
    const tpRollGroup = toolpathRollGroupRef.current;
    const host = hostRef.current;
    if (!Konva || !tpRollGroup || !host) return;

    tpRollGroup.destroyChildren();
    toolpathScaleNodesRef.current = [];
    ensureHatchTiles();
    syncAllRollGroupsTransform();

    // 3.1 计划余料（料头）虚线绿框渲染 + 点击高亮 + 右键抛弃菜单
    const activeLeftovers = (leftovers || []).filter((rm) => !rm.discarded && rm.width > 0 && rm.height > 0);
    if (activeLeftovers.length > 0) {
      const remGroup = new Konva.Group();
      tpRollGroup.add(remGroup);

      for (const rm of activeLeftovers) {
        const isSel = selectedLeftoverId != null && String(selectedLeftoverId) === String(rm.id);
        const areaM2 = ((rm.width * rm.height) / 1_000_000).toFixed(2);
        const strokeColor = isSel ? '#059669' : rm.hasDefect ? '#d97706' : '#10b981';

        const boxGroup = new Konva.Group({ x: rm.x, y: rm.y });
        const boxShape = makeShapeNode(Konva, rm.shape, rm.width, rm.height, {
          fill: isSel
            ? 'rgba(16, 185, 129, 0.22)'
            : rm.hasDefect
            ? 'rgba(245, 158, 11, 0.1)'
            : undefined,
          fillPatternImage: !isSel && !rm.hasDefect ? hatchCacheRef.current.leftover : undefined,
          stroke: strokeColor,
          strokeWidth: isSel ? 2.4 : 1.5,
          dash: [6, 4],
          shadowEnabled: isSel,
          shadowColor: 'rgba(16, 185, 129, 0.35)',
          shadowBlur: 10
        });
        boxGroup.add(boxShape);

        const syncRemLbl = createLabelUpdater(
          Konva,
          boxGroup,
          `余料 #${rm.id}${rm.hasDefect ? ' · 含疵' : ''}`,
          `${Math.round(rm.width)}×${Math.round(rm.height)} · ${areaM2}m²`,
          rm.width,
          rm.height,
          rm.hasDefect ? '#92400e' : '#065f46',
          true
        );
        syncRemLbl();
        toolpathScaleNodesRef.current.push(syncRemLbl);

        boxGroup.on('mouseenter', () => {
          host.style.cursor = 'pointer';
        });
        boxGroup.on('mouseleave', () => {
          host.style.cursor = '';
        });
        boxGroup.on('click tap', (e: any) => {
          e.cancelBubble = true;
          propsRef.current.onSelectPiece?.(null);
          propsRef.current.onSelectLeftover?.(String(rm.id));
        });
        boxGroup.on('contextmenu', (e: any) => {
          const p = propsRef.current;
          if (!p.onContextMenu) return;
          e.evt.preventDefault();
          e.cancelBubble = true;
          p.onSelectPiece?.(null);
          p.onSelectLeftover?.(String(rm.id));
          p.onContextMenu({
            kind: 'leftover',
            leftoverId: String(rm.id),
            entityId: rm.id,
            clientX: e.evt.clientX,
            clientY: e.evt.clientY,
            localX: round1(rm.x),
            localY: round1(rm.y)
          });
        });

        remGroup.add(boxGroup);
      }
    }

    // 3.2 切割刀路与走刀仿真动画（含提刀空程 G00 路径）
    const shouldRenderPath = (showPath || simCutStep != null) && cuts.length > 0;
    if (shouldRenderPath) {
      const pathGroup = new Konva.Group({ listening: false });
      tpRollGroup.add(pathGroup);

      const { segments } = computeToolpathSegments(
        cuts,
        startCorner,
        rollWidthMm,
        occupiedLengthMm > 0 ? occupiedLengthMm : rollLengthMm
      );
      const isSimMode = simCutStep != null;
      const activeStep = isSimMode ? Math.max(0, Math.min(segments.length, simCutStep)) : segments.length;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const stepIdx = i + 1;
        const isCurrent = isSimMode && stepIdx === activeStep;
        const isDone = !isSimMode || stepIdx < activeStep;

        // 提刀空程 G00（在仿真模式或当前刀路展示）
        if (isSimMode && stepIdx <= activeStep && seg.rapidDistMm > 0.5) {
          pathGroup.add(
            new Konva.Line({
              points: [seg.rapidStart.x, seg.rapidStart.y, seg.rapidEnd.x, seg.rapidEnd.y],
              stroke: isCurrent ? '#0284c7' : 'rgba(2, 132, 199, 0.35)',
              strokeWidth: isCurrent ? 1.8 : 1.1,
              dash: [4, 4],
              strokeScaleEnabled: false,
              listening: false
            })
          );
        }

        // 切割线段 G01
        pathGroup.add(
          new Konva.Line({
            points: [seg.cutStart.x, seg.cutStart.y, seg.cutEnd.x, seg.cutEnd.y],
            stroke: isCurrent ? '#f97316' : isDone ? '#e11d48' : 'rgba(225, 29, 72, 0.22)',
            strokeWidth: isCurrent ? 3.2 : isDone ? 1.6 : 1,
            dash: isCurrent ? undefined : isDone ? (isSimMode ? undefined : [6, 4]) : [3, 4],
            strokeScaleEnabled: false,
            listening: false
          })
        );

        // 当前步进刀头高亮光标 + 刀序号标牌
        if (isCurrent) {
          const headHalo = new Konva.Circle({
            x: seg.cutEnd.x,
            y: seg.cutEnd.y,
            fill: 'rgba(249, 115, 22, 0.25)',
            stroke: '#f97316',
            strokeWidth: 1.8,
            strokeScaleEnabled: false,
            listening: false
          });
          const headDot = new Konva.Circle({
            x: seg.cutEnd.x,
            y: seg.cutEnd.y,
            fill: '#ea580c',
            listening: false
          });
          const startDot = new Konva.Circle({
            x: seg.cutStart.x,
            y: seg.cutStart.y,
            fill: '#0284c7',
            listening: false
          });
          const stepBadge = new Konva.Text({
            x: (seg.cutStart.x + seg.cutEnd.x) / 2,
            y: (seg.cutStart.y + seg.cutEnd.y) / 2,
            text: `#${seg.step}`,
            fill: '#ea580c',
            fontStyle: '700',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            listening: false
          });
          pathGroup.add(headHalo, headDot, startDot, stepBadge);
          const syncSimHead = () => {
            const s = Math.max(0.002, camRef.current.scale);
            headHalo.radius(10 / s);
            headDot.radius(4.5 / s);
            startDot.radius(3.5 / s);
            stepBadge.fontSize(11 / s);
            stepBadge.rotation(propsRef.current.vertical ? 0 : 90);
          };
          syncSimHead();
          toolpathScaleNodesRef.current.push(syncSimHead);
        }
      }
    }

    toolpathLayerRef.current?.batchDraw();
  }, [
    leftovers,
    selectedLeftoverId,
    cuts,
    showPath,
    simCutStep,
    startCorner,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    vertical
  ]);

  // ==================== LAYER 4: 10Hz 验布线原地更新（零 destroyChildren） ====================
  useEffect(() => {
    updateFeedLineVisual(true);
  }, [feedPositionMm, rollWidthMm, rollLengthMm, vertical]);

  // 尺寸标尺开关或暗色主题切换时重绘屏幕固定标尺
  useEffect(() => {
    drawRulersNow();
  }, [showDimensions, darkTheme, vertical, rollWidthMm, rollLengthMm]);

  // 轻量级高亮与选中视觉切换（零几何重建）
  useEffect(() => {
    const entries = pieceNodeMapRef.current;
    if (!entries.length) return;
    let touchedBase = false;
    let touchedPieces = false;
    for (const item of entries) {
      const isSelected = selectedPieceIndex != null && item.placedIndex === selectedPieceIndex;
      const isHighlighted = highlightedDemandKey != null && item.demandKey === highlightedDemandKey;
      if (isSelected) {
        item.outline.stroke('#18181b');
        item.outline.strokeWidth(2.6);
        item.outline.shadowEnabled(true);
        item.outline.shadowColor('rgba(91, 97, 246, 0.34)');
        item.outline.shadowBlur(10);
      } else if (isHighlighted) {
        item.outline.stroke('#5b61f6');
        item.outline.strokeWidth(2.4);
        item.outline.shadowEnabled(true);
        item.outline.shadowColor('rgba(91, 97, 246, 0.26)');
        item.outline.shadowBlur(8);
      } else {
        item.outline.stroke(item.baseStroke);
        item.outline.strokeWidth(1.4);
        if (item.placedIndex != null) {
          item.outline.shadowEnabled(false);
        } else {
          item.outline.shadowEnabled(true);
          item.outline.shadowColor('rgba(15, 23, 42, 0.08)');
          item.outline.shadowBlur(5);
        }
      }
      if (item.layerKind === 'base') touchedBase = true;
      else touchedPieces = true;
    }
    if (touchedBase) baseLayerRef.current?.batchDraw();
    if (touchedPieces) piecesLayerRef.current?.batchDraw();
  }, [highlightedDemandKey, selectedPieceIndex, placedPieces, demands]);

  return (
    <div className="wb-board-stage" aria-label={ariaLabel}>
      <div ref={hostRef} className="wb-board-konva-host" tabIndex={0} />
      <canvas
        ref={rulerCanvasRef}
        className="wb-board-ruler-canvas"
        aria-hidden="true"
      />
      {dragFeedback && (
        <div className={`wb-board-feedback is-${dragFeedback.tone}`} role="status">
          {dragFeedback.text}
        </div>
      )}
      <div className="wb-board-zoom-pill num" aria-hidden="true">
        {zoomPct}%
      </div>
    </div>
  );
};
