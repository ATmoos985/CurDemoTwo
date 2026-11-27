import type { MutableRefObject } from 'react';
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
  WorkbenchBoardCanvasProps
} from './canvasTypes';
import { CameraState, createHatchTile } from './canvasGeometry';

export interface DragFeedbackState {
  tone: 'ok' | 'err' | 'return';
  text: string;
}

export interface CulledPieceEntry {
  node: any;
  localX: number;
  localY: number;
  width: number;
  height: number;
  dragging: boolean;
  syncLabel: () => void;
}

export interface HatchCache {
  trim?: HTMLCanvasElement;
  defect?: HTMLCanvasElement;
  cut?: HTMLCanvasElement;
  used?: HTMLCanvasElement;
  leftover?: HTMLCanvasElement;
}

export interface PieceNodeMapEntry {
  node: any;
  outline: any;
  demandKey: string;
  baseStroke: string;
  placedIndex: number | null;
  gapFill?: boolean;
  layerKind: 'base' | 'pieces';
}

export type BoardCanvasLiveProps = Omit<WorkbenchBoardCanvasProps, 'ariaLabel' | 'boardRef'> & {
  darkTheme: boolean;
  leftovers: BoardLeftover[];
  cuts: BoardCutLine[];
  zones: BoardZone[];
  rollShape: BoardShapeGeometry | null;
  feedPositionMm: number | null;
  selectedDefectId: string | null;
  selectedLeftoverId: string | null;
  simCutStep: number | null;
  startCorner: 'left-top' | 'right-top' | 'left-bottom' | 'right-bottom';
  showStaging: boolean;
  interactivePieces: boolean;
  vertical: boolean;
  tool: 'pan' | 'move' | 'defect' | 'measure';
};

export interface BoardCanvasRefs {
  hostRef: MutableRefObject<HTMLDivElement | null>;
  rulerCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  stageRef: MutableRefObject<any>;
  baseLayerRef: MutableRefObject<any>;
  piecesLayerRef: MutableRefObject<any>;
  toolpathLayerRef: MutableRefObject<any>;
  dynamicLayerRef: MutableRefObject<any>;
  worldGroupsRef: MutableRefObject<any[]>;
  rollGroupsRef: MutableRefObject<any[]>;
  stagingGroupRef: MutableRefObject<any>;
  baseRollGroupRef: MutableRefObject<any>;
  piecesRollGroupRef: MutableRefObject<any>;
  toolpathRollGroupRef: MutableRefObject<any>;
  dynamicRollGroupRef: MutableRefObject<any>;
  feedNodesRef: MutableRefObject<{
    group: any;
    line: any;
    tagBg: any;
    tagText: any;
  } | null>;
  overlayGroupRef: MutableRefObject<any>;
  baseScaleNodesRef: MutableRefObject<(() => void)[]>;
  piecesScaleNodesRef: MutableRefObject<(() => void)[]>;
  toolpathScaleNodesRef: MutableRefObject<(() => void)[]>;
  culledPiecesRef: MutableRefObject<CulledPieceEntry[]>;
  lastBaseSigRef: MutableRefObject<string>;
  lastPiecesSigRef: MutableRefObject<string>;
  camRef: MutableRefObject<CameraState>;
  rollOffsetRef: MutableRefObject<BoardPoint>;
  cursorLocalRef: MutableRefObject<BoardPoint | null>;
  stagingOffsetsRef: MutableRefObject<Map<string, BoardPoint>>;
  stagingBoundsRef: MutableRefObject<{ x: number; y: number; width: number; height: number }>;
  didInitialFitRef: MutableRefObject<boolean>;
  lastFitSigRef: MutableRefObject<string>;
  rafCamIdRef: MutableRefObject<number | null>;
  rafRulerIdRef: MutableRefObject<number | null>;
  hatchCacheRef: MutableRefObject<HatchCache>;
  measureLineRef: MutableRefObject<{ p1: BoardPoint; p2: BoardPoint } | null>;
  defectDraftRef: MutableRefObject<{ p1: BoardPoint; p2: BoardPoint } | null>;
  pieceNodeMapRef: MutableRefObject<PieceNodeMapEntry[]>;
}

export type ValidateRollPlacementFn = (
  shape: BoardShapeGeometry | undefined,
  w: number,
  h: number,
  localX: number,
  localY: number,
  ignorePieceIndex: number
) => { ok: boolean; reason: string };

export function isDocumentDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset.theme === 'dark';
}

export function makeShapeNode(
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

export function buildBaseSignature(p: {
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

export function buildPiecesSignature(p: {
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

export function ensureHatchTiles(cache: HatchCache): void {
  if (!cache.trim) {
    cache.trim = createHatchTile('#f1f5f9', '#cbd5e1', 10);
  }
  if (!cache.defect) {
    cache.defect = createHatchTile(
      'rgba(239, 68, 68, 0.14)',
      'rgba(220, 38, 38, 0.45)',
      9
    );
  }
  if (!cache.cut) {
    cache.cut = createHatchTile(
      'rgba(148, 163, 184, 0.16)',
      'rgba(100, 116, 139, 0.36)',
      10
    );
  }
  if (!cache.used) {
    cache.used = createHatchTile(
      'rgba(226, 232, 240, 0.42)',
      'rgba(148, 163, 184, 0.45)',
      10
    );
  }
  if (!cache.leftover) {
    cache.leftover = createHatchTile(
      'rgba(16, 185, 129, 0.08)',
      'rgba(16, 185, 129, 0.28)',
      12
    );
  }
}

export function computeSnappedRollPosition(params: {
  w: number;
  h: number;
  rawX: number;
  rawY: number;
  ignorePieceIndex: number;
  scale: number;
  pieceGapMm: number;
  rollWidthMm: number;
  rollLengthMm: number;
  trimStartMm: number;
  placedPieces: BoardPlacedPiece[];
}): { x: number; y: number } {
  const {
    w,
    h,
    rawX,
    rawY,
    ignorePieceIndex,
    scale,
    pieceGapMm,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    placedPieces
  } = params;
  const snapDist = Math.min(26, Math.max(10, 10 / Math.max(0.05, scale)));
  const gap = Math.max(0, pieceGapMm);

  const candX = [0, Math.max(0, rollWidthMm - w)];
  const candY = [trimStartMm, Math.max(trimStartMm, rollLengthMm - h)];

  for (const other of placedPieces) {
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
}

export function createLabelUpdater(
  Konva: any,
  parent: any,
  textStr: string,
  subStr: string,
  w: number,
  h: number,
  color: string,
  inRollGroup: boolean,
  camRef: MutableRefObject<CameraState>,
  propsRef: MutableRefObject<BoardCanvasLiveProps>
): () => void {
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
}

export function syncPieceHighlightState(
  refs: BoardCanvasRefs,
  selectedPieceIndex: number | null | undefined,
  highlightedDemandKey: string | null | undefined
): void {
  const entries = refs.pieceNodeMapRef.current;
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
  if (touchedBase) refs.baseLayerRef.current?.batchDraw();
  if (touchedPieces) refs.piecesLayerRef.current?.batchDraw();
}

export type { BoardContextMenuEvent };
