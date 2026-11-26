import { describe, expect, it } from 'vitest';
import {
  resolveRotationStep,
  tryRotatePlacedPiece,
  validateRollPlacement
} from './boardPlacementValidation';
import { applyLayoutValidationResult } from './useWorkbenchBoardEdit';
import type { SavedScheme2D } from '../../store/useStudioStore';

describe('手调旋转约束与几何碰撞拦截', () => {
  it('不可旋转件（allowRotation=false, allowHalfTurn=false）严格拒绝旋转', () => {
    const decision = resolveRotationStep({ allowRotation: false, allowHalfTurn: false }, '主帘左片');
    expect(decision.allowed).toBe(false);
    expect(decision.stepDeg).toBeNull();
    expect(decision.reason).toContain('不可旋转件');

    const res = tryRotatePlacedPiece({
      target: {
        name: '主帘左片',
        x: 100,
        y: 100,
        w: 600,
        l: 900,
        rotationDegrees: 0,
        shape: { type: 'RECTANGLE', width: 600, height: 900 }
      },
      pieceIndex: 0,
      demand: { allowRotation: false, allowHalfTurn: false },
      placedPieces: [
        { index: 0, name: '主帘左片', x: 100, y: 100, width: 600, height: 900 }
      ],
      rollWidthMm: 2000,
      rollLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: []
    });
    expect(res.ok).toBe(false);
  });

  it('仅允许半转件（allowRotation=false, allowHalfTurn=true）只旋转 180°', () => {
    const res = tryRotatePlacedPiece({
      target: {
        name: '120码 · 卫衣前片',
        x: 200,
        y: 200,
        w: 400,
        l: 600,
        rotationDegrees: 0,
        shape: {
          type: 'POLYGON',
          width: 400,
          height: 600,
          vertices: [
            { x: 0, y: 0 },
            { x: 400, y: 0 },
            { x: 350, y: 600 },
            { x: 50, y: 600 }
          ]
        }
      },
      pieceIndex: 0,
      demand: { allowRotation: false, allowHalfTurn: true },
      placedPieces: [
        { index: 0, name: '120码 · 卫衣前片', x: 200, y: 200, width: 400, height: 600 }
      ],
      rollWidthMm: 1800,
      rollLengthMm: 2400,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: []
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stepDeg).toBe(180);
      expect(res.nextRotationDegrees).toBe(180);
      expect(res.rotatedShape.width).toBe(400);
      expect(res.rotatedShape.height).toBe(600);
    }
  });

  it('允许 90° 旋转件正常旋转并互换宽高', () => {
    const res = tryRotatePlacedPiece({
      target: {
        name: '可转层板',
        x: 200,
        y: 200,
        w: 400,
        l: 800,
        rotationDegrees: 0,
        shape: { type: 'RECTANGLE', width: 400, height: 800 }
      },
      pieceIndex: 0,
      demand: { allowRotation: true, allowHalfTurn: false },
      placedPieces: [
        { index: 0, name: '可转层板', x: 200, y: 200, width: 400, height: 800 }
      ],
      rollWidthMm: 1800,
      rollLengthMm: 2400,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: []
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stepDeg).toBe(90);
      expect(res.nextRotationDegrees).toBe(90);
      expect(res.rotatedShape.width).toBe(800);
      expect(res.rotatedShape.height).toBe(400);
    }
  });

  it('旋转后与相邻裁片重叠或碰撞疵点时拒绝旋转并回退原角度', () => {
    // 旋转前 300x900 位于 (100,100)，旁侧 (420,250) 放了一块 400x400；旋转 90° 后变为 900x300 必然重叠
    const overlapRes = tryRotatePlacedPiece({
      target: {
        name: '长条件A',
        x: 100,
        y: 100,
        w: 300,
        l: 900,
        rotationDegrees: 0,
        shape: { type: 'RECTANGLE', width: 300, height: 900 }
      },
      pieceIndex: 0,
      demand: { allowRotation: true },
      placedPieces: [
        { index: 0, name: '长条件A', x: 100, y: 100, width: 300, height: 900 },
        { index: 1, name: '相邻件B', x: 420, y: 250, width: 400, height: 400 }
      ],
      rollWidthMm: 2000,
      rollLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 5,
      defects: []
    });
    expect(overlapRes.ok).toBe(false);
    if (!overlapRes.ok) {
      expect(overlapRes.reason).toContain('相邻件B');
    }

    // 旋转后与疵点碰撞拦截
    const defectRes = tryRotatePlacedPiece({
      target: {
        name: '长条件A',
        x: 100,
        y: 100,
        w: 300,
        l: 900,
        rotationDegrees: 0,
        shape: { type: 'RECTANGLE', width: 300, height: 900 }
      },
      pieceIndex: 0,
      demand: { allowRotation: true },
      placedPieces: [
        { index: 0, name: '长条件A', x: 100, y: 100, width: 300, height: 900 }
      ],
      rollWidthMm: 2000,
      rollLengthMm: 3000,
      trimStartMm: 0,
      pieceGapMm: 0,
      defects: [{ id: 1, x: 500, y: 450, w: 60, h: 60, margin: 20 }]
    });
    expect(defectRes.ok).toBe(false);
    if (!defectRes.ok) {
      expect(defectRes.reason).toContain('疵点');
    }
  });

  it('validateRollPlacement 准确拦截切头修边区侵占与越界', () => {
    const trimErr = validateRollPlacement({
      shape: { type: 'RECTANGLE', width: 400, height: 400 },
      w: 400,
      h: 400,
      localX: 0,
      localY: 20,
      ignorePieceIndex: -1,
      rollWidthMm: 1600,
      rollLengthMm: 2400,
      trimStartMm: 50,
      pieceGapMm: 0,
      defects: [],
      placedPieces: []
    });
    expect(trimErr.ok).toBe(false);
    expect(trimErr.reason).toContain('切头修边区');
  });
});

describe('手调脏状态标记与校验重建闭环', () => {
  const dirtyScheme: SavedScheme2D = {
    id: 'MANUAL-1',
    title: '手工排布 (1600×1200mm)',
    strategyId: 'MANUAL_BOARD',
    strategyName: '手工排布',
    createdAt: '10:00:00',
    canvasMode: 'FREE_CANVAS',
    materialModel: 'MAT',
    widthMm: 1600,
    canvasLengthMm: 2400,
    occupiedLengthMm: 1200,
    utilizationPct: 75,
    pieceAreaM2: 1.44,
    placedCount: 2,
    requestedCount: 2,
    complete: true,
    demands: [],
    request: {},
    result: { layout: { placements: [], cuts: [], leftovers: [] } },
    layoutDirty: true
  };

  it('校验通过后回填真实 cuts 与 leftovers 并清除 layoutDirty', () => {
    const updated = applyLayoutValidationResult(dirtyScheme, {
      feasible: true,
      errors: [],
      cuts: [
        { sequence: 1, kind: 'HORIZONTAL', startX: 0, startY: 600, endX: 1600, endY: 600 }
      ],
      leftovers: [
        { id: 'REM-1', x: 0, y: 1200, w: 1600, l: 1200, hasDefect: false }
      ]
    });
    expect(updated.layoutDirty).toBe(false);
    expect(updated.layoutValidationErrors).toEqual([]);
    expect(updated.result.layout.cuts).toHaveLength(1);
    expect(updated.result.layout.leftovers).toHaveLength(1);
    expect(updated.result.layout.leftovers[0].id).toBe('REM-1');
  });

  it('校验失败时保留 layoutDirty=true 并保存错误信息', () => {
    const failed = applyLayoutValidationResult(dirtyScheme, {
      feasible: false,
      errors: ['裁片 #2 与母卷疵点冲突']
    });
    expect(failed.layoutDirty).toBe(true);
    expect(failed.layoutValidationErrors).toEqual(['裁片 #2 与母卷疵点冲突']);
  });
});
