import { describe, expect, it } from 'vitest';
import {
  projectWindowDefectsForBoard,
  projectWindowDefectsForSolver,
  type RawRollDefect
} from './defectWindowUtils';
import { validateRollPlacement } from './boardPlacementValidation';

describe('实卷避疵统一裁窗纯函数（对齐 CuttingWorkflowService.windowDefects）', () => {
  it('工位起点外 5mm 且带 20mm 安全边距的疵点必须产出局部 y=0, h=15, margin=0', () => {
    const startY = 1000;
    const windowLengthMm = 2000;
    const rollWidthMm = 1600;
    // 疵点底边位于 995mm（距离起切点 1000mm 外侧 5mm），安全边距 20mm 伸入工位 15mm
    const defects: RawRollDefect[] = [
      { id: 'DEF-TOP-OUT', x: 300, y: 975, w: 40, h: 20, margin: 20, typeName: '油污' }
    ];

    const solverDefects = projectWindowDefectsForSolver(
      defects,
      startY,
      windowLengthMm,
      rollWidthMm,
      20
    );
    expect(solverDefects).toEqual([
      { id: 'DEF-TOP-OUT', x: 280, y: 0, w: 80, h: 15, margin: 0 }
    ]);

    const boardDefects = projectWindowDefectsForBoard(
      defects,
      startY,
      windowLengthMm,
      rollWidthMm,
      20
    );
    expect(boardDefects).toHaveLength(1);
    expect(boardDefects[0]).toMatchObject({
      id: 'DEF-TOP-OUT',
      x: 280,
      y: 0,
      w: 80,
      h: 15,
      margin: 0
    });
    expect(boardDefects[0].label).toContain('边界禁区');

    // 手调碰撞校验与画布/求解器 100% 一致：放在 y=10 被拦截，放在 y=15 放行
    const blocked = validateRollPlacement({
      shape: undefined,
      w: 100,
      h: 100,
      localX: 280,
      localY: 10,
      ignorePieceIndex: -1,
      rollWidthMm,
      rollLengthMm: windowLengthMm,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: boardDefects,
      placedPieces: []
    });
    expect(blocked.ok).toBe(false);

    const allowed = validateRollPlacement({
      shape: undefined,
      w: 100,
      h: 100,
      localX: 280,
      localY: 15.5,
      ignorePieceIndex: -1,
      rollWidthMm,
      rollLengthMm: windowLengthMm,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: boardDefects,
      placedPieces: []
    });
    expect(allowed.ok).toBe(true);
  });

  it('工位终点外 10mm 且带 20mm 安全边距的疵点必须产出局部 y=len-10, h=10, margin=0', () => {
    const startY = 500;
    const windowLengthMm = 2000;
    const rollWidthMm = 1600;
    // 工位终点为 2500mm，疵点顶边位于 2510mm（终点外 10mm），20mm 边距向内伸入 10mm
    const defects: RawRollDefect[] = [
      { id: 'DEF-BOT-OUT', x: 500, y: 2510, w: 60, h: 30, margin: 20, typeName: '破洞' }
    ];

    const solverDefects = projectWindowDefectsForSolver(
      defects,
      startY,
      windowLengthMm,
      rollWidthMm,
      20
    );
    expect(solverDefects).toEqual([
      { id: 'DEF-BOT-OUT', x: 480, y: windowLengthMm - 10, w: 100, h: 10, margin: 0 }
    ]);

    const boardDefects = projectWindowDefectsForBoard(
      defects,
      startY,
      windowLengthMm,
      rollWidthMm,
      20
    );
    expect(boardDefects).toHaveLength(1);
    expect(boardDefects[0]).toMatchObject({
      id: 'DEF-BOT-OUT',
      x: 480,
      y: windowLengthMm - 10,
      w: 100,
      h: 10,
      margin: 0
    });
  });

  it('疵点跨过起切线时高度严格按窗口裁剪而非保留整高，同时正确裁剪左右门幅边界', () => {
    // 复刻服务端测试基准用例：x=10, y=990, w=10, h=20, margin=20, start=1000, len=4000, width=2000
    // 扩边后 x∈[-10, 40] -> 裁切 [0, 40] (w=40)；y∈[970, 1030] -> 裁切 [1000, 1030] (localY=0, h=30)
    const defects: RawRollDefect[] = [{ id: 1, x: 10, y: 990, w: 10, h: 20, margin: 20 }];
    expect(projectWindowDefectsForSolver(defects, 1000, 4000, 2000, 20)).toEqual([
      { id: 1, x: 0, y: 0, w: 40, h: 30, margin: 0 }
    ]);

    // 疵点跨过起切线（无边距场景）：y=950, h=100 跨过 startY=1000，仅 50mm 在工位内，绝不能保留整高 100
    const crossStart: RawRollDefect[] = [{ id: 2, x: 400, y: 950, w: 80, h: 100, margin: 0 }];
    const solverCross = projectWindowDefectsForSolver(crossStart, 1000, 2000, 1600, 20);
    expect(solverCross).toEqual([{ id: 2, x: 400, y: 0, w: 80, h: 50, margin: 0 }]);

    const boardCross = projectWindowDefectsForBoard(crossStart, 1000, 2000, 1600, 20);
    expect(boardCross).toEqual([
      { id: 2, x: 400, y: 0, w: 80, h: 50, margin: 0, label: '疵点 · 含边界禁区' }
    ]);
  });

  it('完全位于工位内部的疵点：画布保留本体与安全边距且外扩后与求解器 100% 恒等', () => {
    const startY = 1000;
    const defects: RawRollDefect[] = [
      { id: 7, x: 200, y: 1400, w: 50, h: 60, margin: undefined, typeName: '色斑' }
    ];

    const solver = projectWindowDefectsForSolver(defects, startY, 2000, 1600, 20);
    const board = projectWindowDefectsForBoard(defects, startY, 2000, 1600, 20);

    expect(solver).toEqual([{ id: 7, x: 180, y: 380, w: 90, h: 100, margin: 0 }]);
    expect(board).toEqual([
      { id: 7, x: 200, y: 400, w: 50, h: 60, margin: 20, label: '色斑' }
    ]);

    // 校验画布外扩边界与求解器禁区严格一致
    const b = board[0];
    const m = b.margin ?? 0;
    expect({
      x: b.x - m,
      y: b.y - m,
      w: b.w + m * 2,
      h: b.h + m * 2
    }).toEqual({
      x: solver[0].x,
      y: solver[0].y,
      w: solver[0].w,
      h: solver[0].h
    });
  });

  it('外扩安全边距后仍与窗口无交集（含刚好相切）的疵点会被剔除', () => {
    const defects: RawRollDefect[] = [
      // 底边 970 + margin 20 = 990 < 1000
      { id: 1, x: 100, y: 950, w: 40, h: 20, margin: 20 },
      // 底边 980 + margin 20 = 1000 == startY（刚好相切，交集高为 0）
      { id: 2, x: 100, y: 960, w: 40, h: 20, margin: 20 },
      // 顶边 3020 - margin 20 = 3000 == endY（刚好相切，交集高为 0）
      { id: 3, x: 100, y: 3020, w: 40, h: 20, margin: 20 }
    ];
    expect(projectWindowDefectsForSolver(defects, 1000, 2000, 1600, 20)).toEqual([]);
    expect(projectWindowDefectsForBoard(defects, 1000, 2000, 1600, 20)).toEqual([]);
  });
});
