import { describe, expect, it } from 'vitest';
import {
  BoardEditSnapshot,
  createEmptyHistoryStack,
  pushBoardHistory,
  redoBoardHistory,
  restoreOriginalBoardHistory,
  tryNudgePlacedPiece,
  undoBoardHistory
} from '../boardHistory';

const makeSnap = (x: number, leftoversCount = 1, layoutDirty = true): BoardEditSnapshot => ({
  mainPlacements: [{ id: 1, name: '主帘A', x, y: 100, w: 400, l: 600 }],
  gapPlacements: [],
  leftovers: Array.from({ length: leftoversCount }, (_, i) => ({
    id: `REM-${i + 1}`,
    x: 500,
    y: 0,
    w: 500,
    l: 1000
  })),
  discardedLeftoverIds: [],
  cuts: layoutDirty ? [] : [{ sequence: 1, startX: 0, startY: 700, endX: 1500, endY: 700 }],
  layoutDirty,
  strategyName: layoutDirty ? '经向缩长 · 手调' : '经向缩长'
});

describe('手调撤销/重做历史栈与恢复原预览', () => {
  it('连续手调压栈后支持多步撤销、重做与恢复初始预览', () => {
    const initial = makeSnap(100, 2, false);
    const step1 = makeSnap(120, 2, true);
    const step2 = makeSnap(150, 1, true); // 模拟抛弃一块余料并移动

    let stack = createEmptyHistoryStack();
    stack = pushBoardHistory(stack, initial);
    stack = pushBoardHistory(stack, step1);

    expect(stack.past).toHaveLength(2);
    expect(stack.future).toHaveLength(0);
    expect(stack.original?.mainPlacements[0].x).toBe(100);
    expect(stack.original?.leftovers).toHaveLength(2);

    // 撤销第 1 次 -> 回到 step1
    const u1 = undoBoardHistory(stack, step2);
    expect(u1.snapshot?.mainPlacements[0].x).toBe(120);
    expect(u1.snapshot?.leftovers).toHaveLength(2);
    expect(u1.stack.past).toHaveLength(1);
    expect(u1.stack.future).toHaveLength(1);

    // 重做 -> 回到 step2
    const r1 = redoBoardHistory(u1.stack, u1.snapshot!);
    expect(r1.snapshot?.mainPlacements[0].x).toBe(150);
    expect(r1.snapshot?.leftovers).toHaveLength(1);
    expect(r1.stack.future).toHaveLength(0);

    // 恢复原预览 -> 回到 initial（保留未脏刀路与 2 块余料）
    const restored = restoreOriginalBoardHistory(r1.stack, r1.snapshot!);
    expect(restored.snapshot?.mainPlacements[0].x).toBe(100);
    expect(restored.snapshot?.layoutDirty).toBe(false);
    expect(restored.snapshot?.cuts).toHaveLength(1);
    expect(restored.snapshot?.leftovers).toHaveLength(2);
  });

  it('撤销后再产生新编辑会清空 future 分支', () => {
    const s0 = makeSnap(0, 1, false);
    const s1 = makeSnap(10, 1, true);
    const s2 = makeSnap(20, 1, true);

    let stack = pushBoardHistory(createEmptyHistoryStack(), s0);
    stack = pushBoardHistory(stack, s1);
    const undone = undoBoardHistory(stack, s2);
    expect(undone.stack.future).toHaveLength(1);

    const branched = pushBoardHistory(undone.stack, undone.snapshot!);
    expect(branched.future).toHaveLength(0);
  });
});

describe('键盘方向键微调（1mm / Shift 0.1mm）与碰撞越界拦截', () => {
  const basePieces = [
    { index: 0, name: '主片A', x: 100, y: 100, width: 400, height: 600 },
    { index: 1, name: '相邻片B', x: 505, y: 100, width: 300, height: 600 }
  ];

  it('安全空间内支持 1mm 与 Shift+方向键 0.1mm 精确微调', () => {
    const move1mm = tryNudgePlacedPiece({
      target: { name: '主片A', x: 100, y: 100, w: 400, l: 600 },
      pieceIndex: 0,
      dxMm: 1,
      dyMm: 0,
      placedPieces: basePieces,
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 50,
      pieceGapMm: 0,
      defects: []
    });
    expect(move1mm.ok).toBe(true);
    if (move1mm.ok) {
      expect(move1mm.nextX).toBe(101);
      expect(move1mm.nextY).toBe(100);
    }

    const move01mm = tryNudgePlacedPiece({
      target: { name: '主片A', x: 100, y: 100, w: 400, l: 600 },
      pieceIndex: 0,
      dxMm: 0,
      dyMm: 0.1,
      placedPieces: basePieces,
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 50,
      pieceGapMm: 0,
      defects: []
    });
    expect(move01mm.ok).toBe(true);
    if (move01mm.ok) {
      expect(move01mm.nextX).toBe(100);
      expect(move01mm.nextY).toBe(100.1);
    }
  });

  it('方向键微调撞到邻片间距、疵点或切头修边区时严格拒绝', () => {
    // pieceGap = 5，A 右边在 500，B 左边在 505；再向右 1mm 违反 5mm 间距
    const hitNeighbor = tryNudgePlacedPiece({
      target: { name: '主片A', x: 100, y: 100, w: 400, l: 600 },
      pieceIndex: 0,
      dxMm: 1,
      dyMm: 0,
      placedPieces: basePieces,
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 50,
      pieceGapMm: 5,
      defects: []
    });
    expect(hitNeighbor.ok).toBe(false);
    expect(hitNeighbor.reason).toContain('相邻片B');

    // 向上微调侵入切头修边区
    const hitTrim = tryNudgePlacedPiece({
      target: { name: '主片A', x: 100, y: 50, w: 400, l: 600 },
      pieceIndex: 0,
      dxMm: 0,
      dyMm: -1,
      placedPieces: [{ index: 0, name: '主片A', x: 100, y: 50, width: 400, height: 600 }],
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 50,
      pieceGapMm: 0,
      defects: []
    });
    expect(hitTrim.ok).toBe(false);
    expect(hitTrim.reason).toContain('切头修边区');

    // 碰撞疵点禁入区
    const hitDefect = tryNudgePlacedPiece({
      target: { name: '主片A', x: 100, y: 100, w: 400, l: 600 },
      pieceIndex: 0,
      dxMm: 0,
      dyMm: 1,
      placedPieces: [{ index: 0, name: '主片A', x: 100, y: 100, width: 400, height: 600 }],
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: [{ id: 'D1', x: 200, y: 720, w: 50, h: 50, margin: 20 }]
    });
    expect(hitDefect.ok).toBe(false);
    expect(hitDefect.reason).toContain('疵点');
  });
});
