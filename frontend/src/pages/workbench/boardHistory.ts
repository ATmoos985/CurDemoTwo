import {
  validateRollPlacement,
  type ValidationDefect,
  type ValidationPlacedPiece
} from './boardPlacementValidation';
import type { ShapeGeometry } from '../../store/useStudioStore';

export interface BoardEditSnapshot {
  mainPlacements: any[];
  gapPlacements: any[];
  leftovers: any[];
  discardedLeftoverIds: string[];
  cuts: any[];
  layoutDirty: boolean;
  strategyName: string;
}

export interface BoardHistoryStack {
  original: BoardEditSnapshot | null;
  past: BoardEditSnapshot[];
  future: BoardEditSnapshot[];
}

export const MAX_BOARD_HISTORY = 50;

export function createEmptyHistoryStack(): BoardHistoryStack {
  return { original: null, past: [], future: [] };
}

export function cloneBoardSnapshot(snap: BoardEditSnapshot): BoardEditSnapshot {
  return structuredClone(snap);
}

/** 压入一次新的手调前快照：保留原始快照，清空重做栈，并按上限裁剪历史深度。 */
export function pushBoardHistory(
  stack: BoardHistoryStack,
  beforeSnapshot: BoardEditSnapshot,
  maxDepth = MAX_BOARD_HISTORY
): BoardHistoryStack {
  const cloned = cloneBoardSnapshot(beforeSnapshot);
  const nextPast = [...stack.past, cloned];
  const trimmedPast = nextPast.length > maxDepth ? nextPast.slice(nextPast.length - maxDepth) : nextPast;
  return {
    original: stack.original ? stack.original : cloneBoardSnapshot(beforeSnapshot),
    past: trimmedPast,
    future: []
  };
}

/** 撤销：弹出 past 末尾作为目标状态，并将当前状态压入 future。 */
export function undoBoardHistory(
  stack: BoardHistoryStack,
  currentSnapshot: BoardEditSnapshot
): { stack: BoardHistoryStack; snapshot: BoardEditSnapshot | null } {
  if (stack.past.length === 0) {
    return { stack, snapshot: null };
  }
  const previous = stack.past[stack.past.length - 1];
  return {
    snapshot: cloneBoardSnapshot(previous),
    stack: {
      original: stack.original,
      past: stack.past.slice(0, -1),
      future: [cloneBoardSnapshot(currentSnapshot), ...stack.future].slice(0, MAX_BOARD_HISTORY)
    }
  };
}

/** 重做：弹出 future 队首作为目标状态，并将当前状态压回 past。 */
export function redoBoardHistory(
  stack: BoardHistoryStack,
  currentSnapshot: BoardEditSnapshot
): { stack: BoardHistoryStack; snapshot: BoardEditSnapshot | null } {
  if (stack.future.length === 0) {
    return { stack, snapshot: null };
  }
  const [next, ...rest] = stack.future;
  return {
    snapshot: cloneBoardSnapshot(next),
    stack: {
      original: stack.original,
      past: [...stack.past, cloneBoardSnapshot(currentSnapshot)].slice(-MAX_BOARD_HISTORY),
      future: rest
    }
  };
}

/** 恢复原始求解预览：保留当前状态到 past（可撤销恢复），返回 original 快照。 */
export function restoreOriginalBoardHistory(
  stack: BoardHistoryStack,
  currentSnapshot: BoardEditSnapshot
): { stack: BoardHistoryStack; snapshot: BoardEditSnapshot | null } {
  if (!stack.original) {
    return { stack, snapshot: null };
  }
  return {
    snapshot: cloneBoardSnapshot(stack.original),
    stack: {
      original: stack.original,
      past: [...stack.past, cloneBoardSnapshot(currentSnapshot)].slice(-MAX_BOARD_HISTORY),
      future: []
    }
  };
}

export interface TryNudgePlacedPieceParams {
  target: {
    name?: string;
    x?: number;
    y?: number;
    w?: number;
    l?: number;
    shape?: ShapeGeometry;
  };
  pieceIndex: number;
  dxMm: number;
  dyMm: number;
  placedPieces: ValidationPlacedPiece[];
  rollWidthMm: number;
  rollLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  defects: ValidationDefect[];
}

export type TryNudgePlacedPieceResult =
  | { ok: true; nextX: number; nextY: number; reason: '' }
  | { ok: false; reason: string };

/** 键盘方向键微调预检（与拖动共用 validateRollPlacement，冲突直接拒绝不入历史栈）。 */
export function tryNudgePlacedPiece(
  params: TryNudgePlacedPieceParams
): TryNudgePlacedPieceResult {
  const {
    target,
    pieceIndex,
    dxMm,
    dyMm,
    placedPieces,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    defects
  } = params;
  const w = Number(target.shape?.width ?? target.w) || 0;
  const h = Number(target.shape?.height ?? target.l) || 0;
  const nextX = Math.round(((Number(target.x) || 0) + dxMm) * 10) / 10;
  const nextY = Math.round(((Number(target.y) || 0) + dyMm) * 10) / 10;

  const check = validateRollPlacement({
    shape: target.shape,
    w,
    h,
    localX: nextX,
    localY: nextY,
    ignorePieceIndex: pieceIndex,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    placedPieces
  });
  if (!check.ok) {
    return { ok: false, reason: `微调受阻：${check.reason}` };
  }
  return { ok: true, nextX, nextY, reason: '' };
}
