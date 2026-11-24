import React, { useEffect, useRef, useState } from 'react';
import { validateRollPlacement as validateRollPlacementPure } from '../pages/workbench/boardPlacementValidation';

export interface BoardPoint {
  x: number;
  y: number;
}

export interface BoardShapeGeometry {
  type: 'RECTANGLE' | 'POLYGON';
  width: number;
  height: number;
  vertices?: BoardPoint[];
}

export interface BoardDemandSpec {
  key: string;
  demandId: number;
  name: string;
  width: number;
  length: number;
  remainingQty: number;
  totalQty: number;
  allowRotation?: boolean;
  allowHalfTurn?: boolean;
  shape?: BoardShapeGeometry;
}

export interface BoardPlacedPiece {
  id: string | number;
  index: number;
  demandId?: number;
  demandKey: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees?: number;
  gapFill?: boolean;
  shape?: BoardShapeGeometry;
}

export interface BoardDefect {
  id: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin?: number;
  label?: string;
  editable?: boolean;
  fresh?: boolean;
}

export interface BoardZone {
  id: string;
  startY: number;
  lengthMm: number;
  kind: 'cut' | 'planned' | 'used' | 'window';
  label?: string;
}

export interface BoardCutLine {
  sequence?: number;
  kind?: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface WorkbenchBoardHandle {
  fit: () => void;
  zoom: (factor: number) => void;
  resetRollOffset: () => void;
  focusRange: (startY: number, endY: number, startX?: number, endX?: number) => void;
  followPosition: (yMm: number) => void;
  clearMeasure: () => void;
}

export interface WorkbenchBoardCanvasProps {
  rollTitle: string;
  rollWidthMm: number;
  rollLengthMm: number;
  occupiedLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  defects: BoardDefect[];
  demands: BoardDemandSpec[];
  placedPieces: BoardPlacedPiece[];
  cuts?: BoardCutLine[];
  zones?: BoardZone[];
  rollShape?: BoardShapeGeometry | null;
  feedPositionMm?: number | null;
  selectedDefectId?: string | null;
  showStaging?: boolean;
  interactivePieces?: boolean;
  vertical?: boolean;
  tool?: 'pan' | 'measure' | 'defect' | 'move';
  showDimensions: boolean;
  showPath: boolean;
  highlightedDemandKey: string | null;
  selectedPieceIndex: number | null;
  ariaLabel?: string;
  onDropStagingPiece?: (demandKey: string, localX: number, localY: number) => void;
  onMovePlacedPiece?: (pieceIndex: number, localX: number, localY: number) => void;
  onRotatePlacedPiece?: (pieceIndex: number) => void;
  onRemovePlacedPiece?: (pieceIndex: number) => void;
  onHoverDemandKey?: (demandKey: string | null) => void;
  onSelectPiece?: (pieceIndex: number | null) => void;
  onCursorMove?: (cursor: { x: number; y: number } | null) => void;
  onCollisionNotice?: (message: string) => void;
  onInteract?: () => void;
  onContextInspect?: (hit: { entityId?: string | number; x: number; y: number } | null) => void;
  onDefectSelect?: (id: string) => void;
  onDefectDraw?: (box: { u: number; v: number; du: number; dv: number }) => void;
  onDefectEdit?: (id: string, box: { u: number; v: number; du: number; dv: number }) => void;
  boardRef?: React.MutableRefObject<WorkbenchBoardHandle | null>;
}

interface PieceVisualStyle {
  fill: string;
  stroke: string;
  text: string;
}

const PIECE_PALETTE: PieceVisualStyle[] = [
  { fill: '#eef2ff', stroke: '#5b61f6', text: '#312e81' },
  { fill: '#ecfdf5', stroke: '#10b981', text: '#065f46' },
  { fill: '#eff6ff', stroke: '#3b82f6', text: '#1e3a8a' },
  { fill: '#f5f3ff', stroke: '#8b5cf6', text: '#4c1d95' },
  { fill: '#f0fdfa', stroke: '#14b8a6', text: '#115e59' },
  { fill: '#fff7ed', stroke: '#f97316', text: '#7c2d12' },
  { fill: '#fdf2f8', stroke: '#ec4899', text: '#831843' },
  { fill: '#f0f9ff', stroke: '#0ea5e9', text: '#0c4a6e' }
];

const GAP_FILL_STYLE: PieceVisualStyle = {
  fill: '#d1fae5',
  stroke: '#059669',
  text: '#065f46'
};

function styleForDemand(demandId: number | undefined, fallbackIdx: number, gapFill?: boolean): PieceVisualStyle {
  if (gapFill) return GAP_FILL_STYLE;
  const seed = Math.abs(Number.isFinite(demandId) ? Number(demandId) : fallbackIdx);
  return PIECE_PALETTE[seed % PIECE_PALETTE.length];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function createHatchTile(background: string | null, stroke: string, size = 10): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext('2d');
  if (ctx) {
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size, size);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-1, 1);
    ctx.lineTo(1, -1);
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.moveTo(size - 1, size + 1);
    ctx.lineTo(size + 1, size - 1);
    ctx.stroke();
  }
  return tile;
}

function pickRulerStep(scalePxPerMm: number, minGapPx = 68): number {
  const raw = minGapPx / Math.max(0.01, scalePxPerMm);
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const s of steps) {
    if (s >= raw) return s;
  }
  return Math.ceil(raw / 5000) * 5000;
}

interface StagingRenderItem {
  instanceKey: string;
  demandKey: string;
  demandId: number;
  name: string;
  width: number;
  height: number;
  shape?: BoardShapeGeometry;
  x: number;
  y: number;
  stackExtra: number;
  style: PieceVisualStyle;
}

interface StagingLayoutResult {
  items: StagingRenderItem[];
  totalCount: number;
  bounds: { x: number; y: number; width: number; height: number };
}

function computeStagingLayout(
  demands: BoardDemandSpec[],
  rollWidthMm: number,
  rollLengthMm: number
): StagingLayoutResult {
  const gapFromRoll = Math.max(
    260,
    Math.round(rollWidthMm * 0.24),
    Math.round(rollLengthMm * 0.038)
  );
  const itemGap = Math.max(44, Math.min(96, Math.round(rollWidthMm * 0.04)));
  const pad = Math.max(64, Math.min(120, Math.round(rollWidthMm * 0.055)));
  const colMaxH = Math.max(rollLengthMm, 1600);

  const rawItems: Omit<StagingRenderItem, 'x' | 'y'>[] = [];
  let totalCount = 0;

  demands.forEach((d, idx) => {
    const qty = Math.max(0, Math.floor(d.remainingQty || 0));
    if (qty <= 0 || d.width <= 0 || d.length <= 0) return;
    totalCount += qty;
    const renderN = qty <= 12 ? qty : 6;
    const extra = qty > 12 ? qty - 6 : 0;
    const style = styleForDemand(d.demandId, idx, false);
    for (let i = 0; i < renderN; i++) {
      rawItems.push({
        instanceKey: `${d.key}#${i}`,
        demandKey: d.key,
        demandId: d.demandId,
        name: d.name,
        width: d.width,
        height: d.length,
        shape: d.shape,
        stackExtra: i === renderN - 1 ? extra : 0,
        style
      });
    }
  });

  if (rawItems.length === 0) {
    const boxW = Math.max(420, Math.min(680, Math.round(rollWidthMm * 0.42)));
    const boxH = Math.max(520, Math.min(rollLengthMm, 1200));
    return {
      items: [],
      totalCount: 0,
      bounds: {
        x: -gapFromRoll - boxW,
        y: 0,
        width: boxW,
        height: boxH
      }
    };
  }

  // Group into neat vertical columns flowing right-to-left (closest to mother roll first)
  interface ColBucket {
    items: (Omit<StagingRenderItem, 'x' | 'y'> & { relY: number })[];
    colWidth: number;
    colHeight: number;
  }
  const columns: ColBucket[] = [];
  let curCol: ColBucket = { items: [], colWidth: 0, colHeight: 0 };

  for (const item of rawItems) {
    const nextY = curCol.items.length === 0 ? 0 : curCol.colHeight + itemGap;
    if (curCol.items.length > 0 && nextY + item.height > colMaxH) {
      columns.push(curCol);
      curCol = { items: [], colWidth: 0, colHeight: 0 };
    }
    const relY = curCol.items.length === 0 ? 0 : curCol.colHeight + itemGap;
    curCol.items.push({ ...item, relY });
    curCol.colWidth = Math.max(curCol.colWidth, item.width);
    curCol.colHeight = relY + item.height;
  }
  if (curCol.items.length > 0) columns.push(curCol);

  const positioned: StagingRenderItem[] = [];
  let cursorRightX = -gapFromRoll - pad;
  let maxColH = 0;

  for (const col of columns) {
    const colLeftX = cursorRightX - col.colWidth;
    for (const it of col.items) {
      positioned.push({
        ...it,
        x: colLeftX + (col.colWidth - it.width) / 2,
        y: pad + it.relY
      });
    }
    maxColH = Math.max(maxColH, col.colHeight);
    cursorRightX = colLeftX - itemGap;
  }

  const contentLeftX = cursorRightX + itemGap;
  const boxX = contentLeftX - pad;
  const boxRightX = -gapFromRoll;
  const boxW = Math.max(320, boxRightX - boxX);
  const boxH = Math.max(460, maxColH + pad * 2);

  return {
    items: positioned,
    totalCount,
    bounds: { x: boxX, y: 0, width: boxW, height: boxH }
  };
}

interface DragFeedbackState {
  tone: 'ok' | 'err' | 'return';
  text: string;
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
  cuts = [],
  zones = [],
  rollShape = null,
  feedPositionMm = null,
  selectedDefectId = null,
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
  onRotatePlacedPiece,
  onRemovePlacedPiece,
  onHoverDemandKey,
  onSelectPiece,
  onCursorMove,
  onCollisionNotice,
  onInteract,
  onContextInspect,
  onDefectSelect,
  onDefectDraw,
  onDefectEdit,
  boardRef
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [dragFeedback, setDragFeedback] = useState<DragFeedbackState | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);

  // Persistent refs for Konva objects & camera so highlight/zoom never resets drag offsets
  const stageRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const worldGroupRef = useRef<any>(null);
  const stagingGroupRef = useRef<any>(null);
  const rollGroupRef = useRef<any>(null);
  const overlayGroupRef = useRef<any>(null);
  const scaleNodesRef = useRef<(() => void)[]>([]);

  const camRef = useRef<{ x: number; y: number; scale: number; fitScale: number }>({
    x: 40,
    y: 40,
    scale: 0.25,
    fitScale: 0.25
  });
  const rollOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const stagingOffsetsRef = useRef<Map<string, BoardPoint>>(new Map());
  const stagingBoundsRef = useRef<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 1500,
    height: 3000
  });
  const didInitialFitRef = useRef<boolean>(false);
  const lastFitSigRef = useRef<string>('');
  const hatchCacheRef = useRef<{
    trim?: HTMLCanvasElement;
    defect?: HTMLCanvasElement;
    cut?: HTMLCanvasElement;
    used?: HTMLCanvasElement;
  }>({});
  const measureLineRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);
  const defectDraftRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);

  // Keep latest props & callbacks in a ref for Konva event handlers
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
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath,
    highlightedDemandKey,
    selectedPieceIndex,
    onDropStagingPiece,
    onMovePlacedPiece,
    onRotatePlacedPiece,
    onRemovePlacedPiece,
    onHoverDemandKey,
    onSelectPiece,
    onCursorMove,
    onCollisionNotice,
    onInteract,
    onContextInspect,
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
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath,
    highlightedDemandKey,
    selectedPieceIndex,
    onDropStagingPiece,
    onMovePlacedPiece,
    onRotatePlacedPiece,
    onRemovePlacedPiece,
    onHoverDemandKey,
    onSelectPiece,
    onCursorMove,
    onCollisionNotice,
    onInteract,
    onContextInspect,
    onDefectSelect,
    onDefectDraw,
    onDefectEdit
  };

  // Keep node references for fast highlight/selection visual updates without rebuilding geometry
  const pieceNodeMapRef = useRef<
    {
      node: any;
      outline: any;
      demandKey: string;
      baseStroke: string;
      placedIndex: number | null;
      gapFill?: boolean;
    }[]
  >([]);

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

  const stageToRollLocal = (stagePt: { x: number; y: number }): BoardPoint | null => {
    const rollGroup = rollGroupRef.current;
    if (!rollGroup) return null;
    try {
      const inv = rollGroup.getAbsoluteTransform().copy().invert();
      const pt = inv.point(stagePt);
      return { x: pt.x, y: pt.y };
    } catch {
      return null;
    }
  };

  const renderOverlay = () => {
    const Konva = (globalThis as any).Konva;
    const overlay = overlayGroupRef.current;
    const layer = layerRef.current;
    if (!Konva || !overlay || !layer) return;
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
        y: y,
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

    layer.batchDraw();
  };

  const applyCamera = () => {
    const world = worldGroupRef.current;
    const layer = layerRef.current;
    if (!world || !layer) return;
    const c = camRef.current;
    world.position({ x: c.x, y: c.y });
    world.scale({ x: c.scale, y: c.scale });
    for (const fn of scaleNodesRef.current) fn();
    renderOverlay();
    layer.batchDraw();
    const relPct = c.fitScale > 0 ? Math.round((c.scale / c.fitScale) * 100) : Math.round(c.scale * 400);
    setZoomPct(Math.max(10, Math.min(999, relPct)));
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
    const padX = 52;
    const padTop = 54;
    const padBottom = 36;
    const scale = Math.max(
      0.002,
      Math.min(1.6, Math.min((vw - padX * 2) / worldW, (vh - padTop - padBottom) / worldH))
    );

    const x = (vw - worldW * scale) / 2 - minX * scale;
    const y = padTop + (vh - padTop - padBottom - worldH * scale) / 2 - minY * scale;

    camRef.current = { x, y, scale, fitScale: scale };
    applyCamera();
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
    const padX = 48;
    const padY = 48;
    const scale = Math.max(
      0.002,
      Math.min(2.2, Math.min((vw - padX * 2) / worldW, (vh - padY * 2) / worldH))
    );
    const x = (vw - worldW * scale) / 2 - minX * scale;
    const y = (vh - worldH * scale) / 2 - minY * scale;

    camRef.current = { x, y, scale, fitScale: scale };
    applyCamera();
  };

  const followPosition = (yMm: number) => {
    const p = propsRef.current;
    const span = Math.min(p.rollLengthMm, Math.max(2400, p.rollWidthMm * 2.2));
    const half = span / 2;
    let y0 = Math.max(0, yMm - half);
    let y1 = y0 + span;
    if (y1 > p.rollLengthMm) {
      y1 = p.rollLengthMm;
      y0 = Math.max(0, y1 - span);
    }
    focusRange(y0, y1, 0, p.rollWidthMm);
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
    const nextScale = Math.max(0.002, Math.min(3.0, c.scale * factor));
    const worldX = (cx - c.x) / c.scale;
    const worldY = (cy - c.y) / c.scale;
    camRef.current = {
      ...c,
      scale: nextScale,
      x: cx - worldX * nextScale,
      y: cy - worldY * nextScale
    };
    applyCamera();
  };

  const resetRollOffset = () => {
    rollOffsetRef.current = { x: 0, y: 0 };
    if (rollGroupRef.current) {
      rollGroupRef.current.position({ x: 0, y: 0 });
    }
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

  // Mount Konva Stage once
  useEffect(() => {
    const host = hostRef.current;
    const Konva = (globalThis as any).Konva;
    if (!host || !Konva) return;

    const stage = new Konva.Stage({
      container: host,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight)
    });
    const layer = new Konva.Layer();
    const worldGroup = new Konva.Group();
    const stagingGroup = new Konva.Group();
    const rollGroup = new Konva.Group({ draggable: propsRef.current.tool === 'pan' });

    worldGroup.add(stagingGroup);
    worldGroup.add(rollGroup);
    layer.add(worldGroup);
    stage.add(layer);

    stageRef.current = stage;
    layerRef.current = layer;
    worldGroupRef.current = worldGroup;
    stagingGroupRef.current = stagingGroup;
    rollGroupRef.current = rollGroup;

    // Whole-roll dragging (moves roll + all placed pieces as a rigid unit without mutating piece coords)
    rollGroup.on('dragstart', (e: any) => {
      if (e.target !== rollGroup) return;
      host.style.cursor = 'grabbing';
      propsRef.current.onInteract?.();
    });
    rollGroup.on('dragmove', (e: any) => {
      if (e.target !== rollGroup) return;
      rollOffsetRef.current = { x: rollGroup.x(), y: rollGroup.y() };
    });
    rollGroup.on('dragend', (e: any) => {
      if (e.target !== rollGroup) return;
      rollOffsetRef.current = { x: rollGroup.x(), y: rollGroup.y() };
      host.style.cursor = '';
    });

    // Pan empty grid background + measure / defect drawing gestures
    let panState: { startX: number; startY: number; camX: number; camY: number } | null = null;
    let activeToolDrag: 'measure' | 'defect' | null = null;

    const getPointerFromClient = (evt: MouseEvent): { x: number; y: number } => {
      const rect = host.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    };

    const clampToRoll = (pt: BoardPoint): BoardPoint => ({
      x: Math.max(0, Math.min(propsRef.current.rollWidthMm, pt.x)),
      y: Math.max(0, Math.min(propsRef.current.rollLengthMm, pt.y))
    });

    const onWindowMove = (evt: MouseEvent) => {
      if (panState) {
        camRef.current = {
          ...camRef.current,
          x: panState.camX + (evt.clientX - panState.startX),
          y: panState.camY + (evt.clientY - panState.startY)
        };
        applyCamera();
        return;
      }
      if (activeToolDrag === 'measure' && measureLineRef.current) {
        const local = stageToRollLocal(getPointerFromClient(evt));
        if (local) {
          measureLineRef.current = { ...measureLineRef.current, p2: local };
          renderOverlay();
        }
        return;
      }
      if (activeToolDrag === 'defect' && defectDraftRef.current) {
        const local = stageToRollLocal(getPointerFromClient(evt));
        if (local) {
          defectDraftRef.current = { ...defectDraftRef.current, p2: clampToRoll(local) };
          renderOverlay();
        }
      }
    };

    const onWindowUp = () => {
      if (panState) {
        panState = null;
        host.style.cursor = '';
      }
      if (activeToolDrag === 'measure') {
        activeToolDrag = null;
      }
      if (activeToolDrag === 'defect') {
        activeToolDrag = null;
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
    };
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);

    stage.on('mousedown', (e: any) => {
      const evt = e.evt as MouseEvent;
      const isMiddle = evt.button === 1;
      const isLeft = evt.button === 0;
      const curTool = propsRef.current.tool;

      if (isLeft && curTool === 'measure') {
        const pt = stage.getPointerPosition();
        const local = pt ? stageToRollLocal(pt) : null;
        if (local) {
          measureLineRef.current = { p1: local, p2: local };
          activeToolDrag = 'measure';
          renderOverlay();
          propsRef.current.onInteract?.();
        }
        return;
      }

      if (isLeft && curTool === 'defect') {
        const pt = stage.getPointerPosition();
        const local = pt ? stageToRollLocal(pt) : null;
        if (
          local &&
          local.x >= -20 &&
          local.x <= propsRef.current.rollWidthMm + 20 &&
          local.y >= -20 &&
          local.y <= propsRef.current.rollLengthMm + 20
        ) {
          const clamped = clampToRoll(local);
          defectDraftRef.current = { p1: clamped, p2: clamped };
          activeToolDrag = 'defect';
          renderOverlay();
          propsRef.current.onInteract?.();
        }
        return;
      }

      if (e.target === stage || isMiddle || (isLeft && curTool === 'move' && e.target === stage)) {
        if (e.target === stage) {
          propsRef.current.onSelectPiece?.(null);
        }
        panState = {
          startX: evt.clientX,
          startY: evt.clientY,
          camX: camRef.current.x,
          camY: camRef.current.y
        };
        host.style.cursor = 'grabbing';
        propsRef.current.onInteract?.();
      }
    });

    stage.on('contextmenu', (e: any) => {
      if (!propsRef.current.onContextInspect) return;
      e.evt.preventDefault();
      const pt = stage.getPointerPosition();
      const local = pt ? stageToRollLocal(pt) : null;
      if (local) {
        propsRef.current.onContextInspect({
          x: round1(local.x),
          y: round1(local.y)
        });
      }
    });

    stage.on('mousemove', () => {
      const pt = stage.getPointerPosition();
      if (!pt) {
        propsRef.current.onCursorMove?.(null);
        return;
      }
      const local = stageToRollLocal(pt);
      const p = propsRef.current;
      if (local && local.x >= 0 && local.x <= p.rollWidthMm && local.y >= 0 && local.y <= p.rollLengthMm) {
        propsRef.current.onCursorMove?.({ x: round1(local.x), y: round1(local.y) });
      } else {
        propsRef.current.onCursorMove?.(null);
      }
    });

    stage.on('mouseleave', () => {
      propsRef.current.onCursorMove?.(null);
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
          applyCamera();
        }
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
      stage.destroy();
      stageRef.current = null;
      layerRef.current = null;
      worldGroupRef.current = null;
      stagingGroupRef.current = null;
      rollGroupRef.current = null;
      overlayGroupRef.current = null;
    };
  }, []);

  // Sync tool cursor & rollGroup draggability when tool switches
  useEffect(() => {
    const rollGroup = rollGroupRef.current;
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

  // Keyboard shortcuts: R to rotate selected piece, Delete/Backspace to return, Esc to deselect
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!propsRef.current.interactivePieces) return;
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
      const selIdx = propsRef.current.selectedPieceIndex;
      if (selIdx == null) return;
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        propsRef.current.onRotatePlacedPiece?.(selIdx);
      } else if (e.key === 'Escape') {
        propsRef.current.onSelectPiece?.(null);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        propsRef.current.onRemovePlacedPiece?.(selIdx);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Helper: validate a placement in mother-roll local coordinates
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

  // Magnetic snapping inside mother roll
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

  // Rebuild geometry whenever scene data changes (NOT on hover/select)
  useEffect(() => {
    const Konva = (globalThis as any).Konva;
    const stagingGroup = stagingGroupRef.current;
    const rollGroup = rollGroupRef.current;
    const host = hostRef.current;
    if (!Konva || !stagingGroup || !rollGroup || !host) return;

    stagingGroup.destroyChildren();
    rollGroup.destroyChildren();
    scaleNodesRef.current = [];
    pieceNodeMapRef.current = [];

    if (!hatchCacheRef.current.trim) {
      hatchCacheRef.current.trim = createHatchTile('#f1f5f9', '#cbd5e1', 10);
    }
    if (!hatchCacheRef.current.defect) {
      hatchCacheRef.current.defect = createHatchTile('rgba(239, 68, 68, 0.14)', 'rgba(220, 38, 38, 0.45)', 9);
    }
    if (!hatchCacheRef.current.cut) {
      hatchCacheRef.current.cut = createHatchTile('rgba(148, 163, 184, 0.16)', 'rgba(100, 116, 139, 0.36)', 10);
    }
    if (!hatchCacheRef.current.used) {
      hatchCacheRef.current.used = createHatchTile('rgba(226, 232, 240, 0.42)', 'rgba(148, 163, 184, 0.45)', 10);
    }

    const makeShapeNode = (
      shape: BoardShapeGeometry | undefined,
      w: number,
      h: number,
      attrs: Record<string, any>
    ) => {
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
    };

    const addPieceLabel = (
      parent: any,
      textStr: string,
      subStr: string,
      w: number,
      h: number,
      color: string,
      inRollGroup: boolean
    ) => {
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

      const syncLabel = () => {
        const s = Math.max(0.002, camRef.current.scale);
        const horizRoll = inRollGroup && !propsRef.current.vertical;
        const screenW = (horizRoll ? h : w) * s;
        const screenH = (horizRoll ? w : h) * s;

        // Horizontal roll mode: rotate labels +90 deg so text is upright on screen
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

        // Tall & narrow piece on screen: rotate label -90 deg along vertical spine
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
      syncLabel();
      scaleNodesRef.current.push(syncLabel);
    };

    // ==================== 1. LEFT STAGING ZONE (1:1 mm, optional) ====================
    if (showStaging) {
      const staging = computeStagingLayout(demands, rollWidthMm, rollLengthMm);
      stagingBoundsRef.current = staging.bounds;

      const validInstanceKeys = new Set(staging.items.map((it) => it.instanceKey));
      for (const k of Array.from(stagingOffsetsRef.current.keys())) {
        if (!validInstanceKeys.has(k)) stagingOffsetsRef.current.delete(k);
      }

      const stagingFrame = new Konva.Rect({
        x: staging.bounds.x,
        y: staging.bounds.y,
        width: staging.bounds.width,
        height: staging.bounds.height,
        fill: 'rgba(255, 255, 255, 0.42)',
        stroke: 'rgba(15, 23, 42, 0.16)',
        strokeWidth: 1.2,
        dash: [6, 5],
        strokeScaleEnabled: false,
        cornerRadius: 8,
        listening: false
      });
      stagingGroup.add(stagingFrame);

      const stagingHeader = new Konva.Text({
        text: `待排裁片 · ${staging.totalCount} 件`,
        fill: '#52525b',
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
        stagingHeader.position({
          x: hx,
          y: staging.bounds.y - 24 / s
        });
      };
      syncStagingHeader();
      scaleNodesRef.current.push(syncStagingHeader);

      if (staging.items.length === 0) {
        const emptyText = new Konva.Text({
          text: '待排区已清空\n拖出母卷裁片可退回',
          fill: '#8e929b',
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
        scaleNodesRef.current.push(syncEmpty);
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

        const bodyNode = makeShapeNode(item.shape, item.width, item.height, {
          fill: item.style.fill,
          stroke: item.style.stroke,
          strokeWidth: 1.4,
          shadowColor: 'rgba(15, 23, 42, 0.08)',
          shadowBlur: 5,
          shadowOffsetY: 2,
          shadowEnabled: true
        });
        pieceGroup.add(bodyNode);

        addPieceLabel(
          pieceGroup,
          item.name,
          `${Math.round(item.width)}×${Math.round(item.height)}`,
          item.width,
          item.height,
          item.style.text,
          false
        );

        if (item.stackExtra > 0) {
          const badgeBg = new Konva.Rect({
            fill: '#18181b',
            cornerRadius: 4,
            listening: false
          });
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
          scaleNodesRef.current.push(syncBadge);
        }

        pieceNodeMapRef.current.push({
          node: pieceGroup,
          outline: bodyNode,
          demandKey: item.demandKey,
          baseStroke: item.style.stroke,
          placedIndex: null
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
            const ro = rollOffsetRef.current;
            const rawLocalX = pieceGroup.x() - ro.x;
            const rawLocalY = pieceGroup.y() - ro.y;
            const cx = rawLocalX + item.width / 2;
            const cy = rawLocalY + item.height / 2;
            const p = propsRef.current;

            const overRoll =
              cx >= -20 && cx <= p.rollWidthMm + 20 && cy >= -20 && cy <= p.rollLengthMm + 20;

            if (overRoll) {
              const snapped = snapRollPosition(item.width, item.height, rawLocalX, rawLocalY, -1);
              pieceGroup.position({ x: snapped.x + ro.x, y: snapped.y + ro.y });
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

            const ro = rollOffsetRef.current;
            const localX = pieceGroup.x() - ro.x;
            const localY = pieceGroup.y() - ro.y;
            const cx = localX + item.width / 2;
            const cy = localY + item.height / 2;
            const p = propsRef.current;

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
                propsRef.current.onDropStagingPiece?.(item.demandKey, round1(targetX), round1(targetY));
              } else {
                pieceGroup.position(dragOrigin);
                layerRef.current?.batchDraw();
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

    // ==================== 2. MOTHER ROLL BOARD (rollGroup) ====================
    rollGroup.position(rollOffsetRef.current);
    rollGroup.rotation(vertical ? 0 : -90);
    rollGroup.draggable(tool === 'pan');

    // Top Drag Handle Bar (attached to rollGroup so dragging it moves the entire roll)
    const handleGroup = new Konva.Group();
    const handleBg = new Konva.Rect({
      fill: '#ffffff',
      stroke: 'rgba(15, 23, 42, 0.14)',
      strokeWidth: 1,
      strokeScaleEnabled: false,
      cornerRadius: 6,
      shadowColor: 'rgba(15, 23, 42, 0.08)',
      shadowBlur: 6,
      shadowOffsetY: 2
    });
    const handleTitle = new Konva.Text({
      text: `${rollTitle} · ${Math.round(rollWidthMm)}×${Math.round(rollLengthMm)} mm`,
      fill: '#18181b',
      fontStyle: '600',
      wrap: 'none',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      listening: false
    });
    const handleHint = new Konva.Text({
      text: '拖动整卷',
      fill: '#8e929b',
      wrap: 'none',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei", sans-serif',
      listening: false
    });
    handleGroup.add(handleBg, handleTitle, handleHint);
    handleGroup.on('mouseenter', () => {
      if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
    });
    handleGroup.on('mouseleave', () => {
      host.style.cursor = propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure' ? 'crosshair' : '';
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
        // Horizontal roll: top screen edge is local x = rollWidthMm, y from 0..rollLengthMm
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
        handleHint.position({
          x: barW - hintW - padX,
          y: 7.5 / s
        });
      }
    };
    syncHandleBar();
    scaleNodesRef.current.push(syncHandleBar);

    // Mother roll crisp white sheet (supports irregular remnant polygons via rollShape)
    const rollSheet =
      rollShape?.type === 'POLYGON' && rollShape.vertices && rollShape.vertices.length >= 3
        ? new Konva.Line({
            points: rollShape.vertices.flatMap((pt) => [pt.x, pt.y]),
            closed: true,
            fill: '#ffffff',
            stroke: '#cbd5e1',
            strokeWidth: 1.5,
            strokeScaleEnabled: false,
            shadowColor: 'rgba(15, 23, 42, 0.13)',
            shadowBlur: 20,
            shadowOffsetY: 6
          })
        : new Konva.Rect({
            x: 0,
            y: 0,
            width: rollWidthMm,
            height: rollLengthMm,
            fill: '#ffffff',
            stroke: '#cbd5e1',
            strokeWidth: 1.5,
            strokeScaleEnabled: false,
            shadowColor: 'rgba(15, 23, 42, 0.13)',
            shadowBlur: 20,
            shadowOffsetY: 6
          });
    rollSheet.on('mouseenter', () => {
      if (propsRef.current.tool === 'pan') host.style.cursor = 'grab';
    });
    rollSheet.on('mouseleave', () => {
      host.style.cursor = propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure' ? 'crosshair' : '';
    });
    rollSheet.on('click tap', (e: any) => {
      e.cancelBubble = true;
      propsRef.current.onSelectPiece?.(null);
    });
    rollGroup.add(rollSheet);

    // Subtle meter lines inside sheet (auto-scaled step for very long rolls)
    const meterStep =
      rollLengthMm > 60000 ? 10000 : rollLengthMm > 20000 ? 5000 : rollLengthMm > 10000 ? 2000 : 1000;
    for (let y = meterStep; y < rollLengthMm; y += meterStep) {
      rollGroup.add(
        new Konva.Line({
          points: [0, y, rollWidthMm, y],
          stroke: 'rgba(15, 23, 42, 0.05)',
          strokeWidth: 1,
          strokeScaleEnabled: false,
          listening: false
        })
      );
    }

    // Spatial zones (cut / planned / used / inspection window)
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
          scaleNodesRef.current.push(syncZoneTxt);
        }
      }
    }

    // Trim Start Zone (gray hatched band)
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
      scaleNodesRef.current.push(syncTrimLabel);
    }

    // Occupied length marker line
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
        fill: '#047857',
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
      scaleNodesRef.current.push(syncOcc);
    }

    // Inspection feed line (InspectionPage)
    if (feedPositionMm != null && Number.isFinite(feedPositionMm)) {
      const fy = Math.max(0, Math.min(rollLengthMm, feedPositionMm));
      rollGroup.add(
        new Konva.Line({
          points: [0, fy, rollWidthMm, fy],
          stroke: '#10b981',
          strokeWidth: 2,
          strokeScaleEnabled: false,
          listening: false
        })
      );
      const feedTag = new Konva.Text({
        text: `验布线 ${(fy / 1000).toFixed(2)} m`,
        fill: '#047857',
        fontStyle: '700',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        listening: false
      });
      rollGroup.add(feedTag);
      const syncFeed = () => {
        const s = Math.max(0.002, camRef.current.scale);
        const isVert = propsRef.current.vertical;
        feedTag.fontSize(10.5 / s);
        feedTag.rotation(isVert ? 0 : 90);
        if (isVert) {
          feedTag.position({ x: rollWidthMm + 8 / s, y: fy - 6 / s });
        } else {
          feedTag.position({ x: -8 / s, y: fy - 4 / s });
        }
      };
      syncFeed();
      scaleNodesRef.current.push(syncFeed);
    }

    // Rulers & Dimensions
    if (showDimensions) {
      const rulerGroup = new Konva.Group({ listening: false });
      rollGroup.add(rulerGroup);

      const syncRulers = () => {
        rulerGroup.destroyChildren();
        const s = Math.max(0.002, camRef.current.scale);
        const isVert = propsRef.current.vertical;
        const stepX = pickRulerStep(s, 72);
        const stepY = pickRulerStep(s, 68);
        const tickLen = 6 / s;
        const fontSize = 9.5 / s;

        if (isVert) {
          for (let x = 0; x <= rollWidthMm; x += stepX) {
            rulerGroup.add(
              new Konva.Line({
                points: [x, rollLengthMm, x, rollLengthMm + tickLen],
                stroke: '#94a3b8',
                strokeWidth: 1,
                strokeScaleEnabled: false
              })
            );
            const tickTxt = new Konva.Text({
              x,
              y: rollLengthMm + tickLen + 2 / s,
              text: String(Math.round(x)),
              fontSize,
              fill: '#64748b',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            });
            tickTxt.offsetX(x === 0 ? 0 : tickTxt.width() / 2);
            rulerGroup.add(tickTxt);
          }
          for (let y = 0; y <= rollLengthMm; y += stepY) {
            rulerGroup.add(
              new Konva.Line({
                points: [rollWidthMm, y, rollWidthMm + tickLen, y],
                stroke: '#94a3b8',
                strokeWidth: 1,
                strokeScaleEnabled: false
              })
            );
            if (occupiedLengthMm > 0 && Math.abs(y - occupiedLengthMm) * s < 16) continue;
            if (feedPositionMm != null && Math.abs(y - feedPositionMm) * s < 16) continue;
            rulerGroup.add(
              new Konva.Text({
                x: rollWidthMm + tickLen + 4 / s,
                y: y - 5 / s,
                text: String(Math.round(y)),
                fontSize,
                fill: '#64748b',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
              })
            );
          }
        } else {
          // Horizontal roll: length runs along bottom (x = 0, y = 0..rollLengthMm), width along right (y = rollLengthMm, x = 0..rollWidthMm)
          for (let y = 0; y <= rollLengthMm; y += stepY) {
            rulerGroup.add(
              new Konva.Line({
                points: [0, y, -tickLen, y],
                stroke: '#94a3b8',
                strokeWidth: 1,
                strokeScaleEnabled: false
              })
            );
            const tickTxt = new Konva.Text({
              x: -tickLen - 4 / s,
              y,
              text: String(Math.round(y)),
              fontSize,
              rotation: 90,
              fill: '#64748b',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            });
            tickTxt.offsetX(y === 0 ? 0 : tickTxt.width() / 2);
            rulerGroup.add(tickTxt);
          }
          for (let x = 0; x <= rollWidthMm; x += stepX) {
            rulerGroup.add(
              new Konva.Line({
                points: [x, rollLengthMm, x, rollLengthMm + tickLen],
                stroke: '#94a3b8',
                strokeWidth: 1,
                strokeScaleEnabled: false
              })
            );
            const tickTxt = new Konva.Text({
              x: x + 4 / s,
              y: rollLengthMm + tickLen + 4 / s,
              text: String(Math.round(x)),
              fontSize,
              rotation: 90,
              fill: '#64748b',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
            });
            rulerGroup.add(tickTxt);
          }
        }
      };
      syncRulers();
      scaleNodesRef.current.push(syncRulers);
    }

    // Placed Pieces inside rollGroup
    const placedLayerGroup = new Konva.Group();
    rollGroup.add(placedLayerGroup);

    for (const pc of placedPieces) {
      const style = styleForDemand(pc.demandId, pc.index, pc.gapFill);
      const pcGroup = new Konva.Group({
        x: pc.x,
        y: pc.y,
        draggable: interactivePieces
      });

      const bodyNode = makeShapeNode(pc.shape, pc.width, pc.height, {
        fill: style.fill,
        stroke: style.stroke,
        strokeWidth: 1.4,
        ...(pc.gapFill ? { dash: [5, 3] } : {})
      });
      pcGroup.add(bodyNode);

      const labelText = pc.gapFill ? `补 · ${pc.name}` : pc.name;
      const rotTag = pc.rotationDegrees ? ` · ${pc.rotationDegrees}°` : '';
      addPieceLabel(
        pcGroup,
        labelText,
        `${Math.round(pc.width)}×${Math.round(pc.height)}${rotTag}`,
        pc.width,
        pc.height,
        style.text,
        true
      );

      pieceNodeMapRef.current.push({
        node: pcGroup,
        outline: bodyNode,
        demandKey: pc.demandKey,
        baseStroke: style.stroke,
        placedIndex: pc.index,
        gapFill: pc.gapFill
      });

      pcGroup.on('click tap', (e: any) => {
        e.cancelBubble = true;
        propsRef.current.onSelectPiece?.(pc.index);
      });
      pcGroup.on('contextmenu', (e: any) => {
        if (!propsRef.current.onContextInspect) return;
        e.evt.preventDefault();
        e.cancelBubble = true;
        propsRef.current.onContextInspect({
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
          pcGroup.moveToTop();
          host.style.cursor = 'grabbing';
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
            if (Math.abs(clampedX - origX) > 0.2 || Math.abs(clampedY - origY) > 0.2) {
              propsRef.current.onMovePlacedPiece?.(pc.index, round1(clampedX), round1(clampedY));
            } else {
              pcGroup.position({ x: origX, y: origY });
              layerRef.current?.batchDraw();
            }
          } else {
            pcGroup.position({ x: origX, y: origY });
            layerRef.current?.batchDraw();
            propsRef.current.onCollisionNotice?.(check.reason);
          }
        });
      }

      placedLayerGroup.add(pcGroup);
    }

    // Defect Exclusion Zones (drawn above pieces when inspecting, supports selection + drag/resize)
    const defectLayerGroup = new Konva.Group();
    rollGroup.add(defectLayerGroup);

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
      scaleNodesRef.current.push(syncDef);

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
            propsRef.current.tool === 'defect' || propsRef.current.tool === 'measure' ? 'crosshair' : '';
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

        // 4 corner resize handles when selected
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
            scaleNodesRef.current.push(syncHandle);

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

    // Optional Cutting Toolpaths inside rollGroup
    if (showPath && cuts.length > 0) {
      const pathGroup = new Konva.Group({ listening: false });
      rollGroup.add(pathGroup);
      for (let i = 0; i < cuts.length; i++) {
        const c = cuts[i];
        pathGroup.add(
          new Konva.Line({
            points: [c.startX, c.startY, c.endX, c.endY],
            stroke: '#e11d48',
            strokeWidth: 1.5,
            dash: [6, 4],
            strokeScaleEnabled: false
          })
        );
      }
    }

    // Top overlay group for active measure / defect drawing previews
    const overlayGroup = new Konva.Group({ listening: false });
    rollGroup.add(overlayGroup);
    overlayGroupRef.current = overlayGroup;

    // Auto-fit when dimensions, orientation, or demand roster changes significantly
    const fitSig = `${rollWidthMm}x${rollLengthMm}-${vertical ? 'V' : 'H'}-${showStaging ? 'S' : 'N'}-${demands.map((d) => d.key).join(',')}`;
    if (!didInitialFitRef.current || fitSig !== lastFitSigRef.current) {
      lastFitSigRef.current = fitSig;
      didInitialFitRef.current = true;
      fitView();
    } else {
      applyCamera();
    }
  }, [
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    demands,
    placedPieces,
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath
  ]);

  // Lightweight highlight & selection visual pass (zero geometry rebuild)
  useEffect(() => {
    const entries = pieceNodeMapRef.current;
    const layer = layerRef.current;
    if (!layer || !entries.length) return;
    for (const item of entries) {
      const isSelected = selectedPieceIndex != null && item.placedIndex === selectedPieceIndex;
      const isHighlighted = highlightedDemandKey != null && item.demandKey === highlightedDemandKey;
      if (isSelected) {
        item.outline.stroke('#18181b');
        item.outline.strokeWidth(2.6);
        item.outline.shadowEnabled(true);
        item.outline.shadowColor('rgba(91, 97, 246, 0.32)');
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
    }
    layer.batchDraw();
  }, [highlightedDemandKey, selectedPieceIndex, placedPieces, demands]);

  return (
    <div className="wb-board-stage" aria-label={ariaLabel}>
      <div ref={hostRef} className="wb-board-konva-host" tabIndex={0} />
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
