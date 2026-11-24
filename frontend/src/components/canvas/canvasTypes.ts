import type React from 'react';

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

export interface BoardLeftover {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasDefect?: boolean;
  discarded?: boolean;
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

export interface BoardContextMenuEvent {
  kind: 'piece' | 'leftover' | 'empty';
  clientX: number;
  clientY: number;
  localX: number;
  localY: number;
  pieceIndex?: number;
  leftoverId?: string;
  entityId?: string | number;
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
  leftovers?: BoardLeftover[];
  cuts?: BoardCutLine[];
  zones?: BoardZone[];
  rollShape?: BoardShapeGeometry | null;
  feedPositionMm?: number | null;
  selectedDefectId?: string | null;
  selectedLeftoverId?: string | null;
  /** 走刀动画仿真当前已演示步数：null/undefined 表示不启用步进高亮，展示全量刀路。 */
  simCutStep?: number | null;
  /** 起刀原点，用于计算刀路空程起点 */
  startCorner?: 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom';
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
  onNudgePlacedPiece?: (pieceIndex: number, dxMm: number, dyMm: number) => void;
  onRotatePlacedPiece?: (pieceIndex: number) => void;
  onRemovePlacedPiece?: (pieceIndex: number) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onSelectLeftover?: (leftoverId: string | null) => void;
  onHoverDemandKey?: (demandKey: string | null) => void;
  onSelectPiece?: (pieceIndex: number | null) => void;
  onCursorMove?: (cursor: { x: number; y: number } | null) => void;
  onCollisionNotice?: (message: string) => void;
  onInteract?: () => void;
  onContextInspect?: (hit: { entityId?: string | number; x: number; y: number } | null) => void;
  onContextMenu?: (ev: BoardContextMenuEvent) => void;
  onDefectSelect?: (id: string) => void;
  onDefectDraw?: (box: { u: number; v: number; du: number; dv: number }) => void;
  onDefectEdit?: (id: string, box: { u: number; v: number; du: number; dv: number }) => void;
  boardRef?: React.MutableRefObject<WorkbenchBoardHandle | null>;
}
