import { describe, expect, it } from 'vitest';
import { pickRulerStep } from '../canvasRuler';
import {
  computeContextMenuPosition,
  computeToolpathSegments,
  computeTouchPinchTransform,
  computeViewportWorldRect,
  isWorldBoxVisible,
  mapArrowKeyToRollDelta,
  rollLocalBoxToWorldRect
} from '../canvasGeometry';

describe('CAD 标尺步长与细粒度刻度选择', () => {
  it('高倍放大下支持 1mm / 5mm / 10mm 细粒度刻度', () => {
    expect(pickRulerStep(80, 68)).toEqual({ majorStep: 1, minorStep: 1 });
    expect(pickRulerStep(15, 68)).toEqual({ majorStep: 5, minorStep: 1 });
    expect(pickRulerStep(7, 68)).toEqual({ majorStep: 10, minorStep: 2 });
    expect(pickRulerStep(1.5, 68)).toEqual({ majorStep: 50, minorStep: 10 });
  });

  it('长卷全览缩小下自动切换大步长刻度', () => {
    expect(pickRulerStep(0.1, 68)).toEqual({ majorStep: 1000, minorStep: 200 });
    expect(pickRulerStep(0.015, 68)).toEqual({ majorStep: 5000, minorStep: 1000 });
    expect(pickRulerStep(0.004, 68)).toEqual({ majorStep: 20000, minorStep: 4000 });
  });
});

describe('视口裁剪（Viewport Culling）与坐标变换', () => {
  it('纵向走布下准确区分视口内与视口外裁片', () => {
    const cam = { x: 100, y: -1000, scale: 0.5, fitScale: 0.5 };
    const vp = computeViewportWorldRect(cam, 800, 600, 40);
    // 视口 Y 范围约为 [1920, 3280]
    const inside = rollLocalBoxToWorldRect(100, 2200, 400, 500, { x: 0, y: 0 }, true);
    const farAbove = rollLocalBoxToWorldRect(100, 100, 400, 300, { x: 0, y: 0 }, true);
    const farBelow = rollLocalBoxToWorldRect(100, 4500, 400, 300, { x: 0, y: 0 }, true);

    expect(isWorldBoxVisible(inside, vp)).toBe(true);
    expect(isWorldBoxVisible(farAbove, vp)).toBe(false);
    expect(isWorldBoxVisible(farBelow, vp)).toBe(false);
  });

  it('横向台板（-90°）下正确映射卷长与幅宽并执行视口裁剪', () => {
    const cam = { x: 0, y: 800, scale: 0.5, fitScale: 0.5 };
    const vp = computeViewportWorldRect(cam, 800, 600, 20);
    // 横向：worldX = localY (0..1640), worldY = -localX (-1640..-360)
    const inside = rollLocalBoxToWorldRect(600, 400, 300, 400, { x: 0, y: 0 }, false);
    const farRight = rollLocalBoxToWorldRect(600, 5000, 300, 400, { x: 0, y: 0 }, false);

    expect(isWorldBoxVisible(inside, vp)).toBe(true);
    expect(isWorldBoxVisible(farRight, vp)).toBe(false);
  });
});

describe('右键菜单防溢出、双指触控缩放、方向键映射与刀路空程计算', () => {
  it('右键菜单靠近视口右下角时自动回拉防溢出', () => {
    const pos = computeContextMenuPosition(1240, 760, 204, 240, 1280, 800, 8);
    expect(pos.left).toBe(1280 - 204 - 8);
    expect(pos.top).toBe(800 - 240 - 8);
  });

  it('双指捏合拉开时以两指中心为锚点按比例放大缩放比', () => {
    const cam = { x: 100, y: 100, scale: 0.5, fitScale: 0.5 };
    const res = computeTouchPinchTransform(
      { x: 200, y: 200 },
      { x: 400, y: 200 },
      100,
      { x: 300, y: 200 },
      cam
    );
    expect(res.nextCam.scale).toBeCloseTo(1.0, 5);
    expect(res.dist).toBe(200);
    // 世界锚点 (300 - 100)/0.5 = 400 -> 缩放后仍在屏幕 x=300
    expect(res.nextCam.x + 400 * res.nextCam.scale).toBeCloseTo(300, 5);
  });

  it('方向键微调在纵向走布与横向台板下均符合视觉直觉', () => {
    expect(mapArrowKeyToRollDelta('ArrowRight', 1, true)).toEqual({ dx: 1, dy: 0 });
    expect(mapArrowKeyToRollDelta('ArrowDown', 0.1, true)).toEqual({ dx: 0, dy: 0.1 });
    expect(mapArrowKeyToRollDelta('ArrowRight', 1, false)).toEqual({ dx: 0, dy: 1 });
    expect(mapArrowKeyToRollDelta('ArrowUp', 0.1, false)).toEqual({ dx: 0.1, dy: 0 });
  });

  it('刀路仿真段正确计算提刀空程与切割距离', () => {
    const { segments, totalCutMm, totalRapidMm } = computeToolpathSegments(
      [
        { sequence: 1, kind: 'HORIZONTAL', startX: 0, startY: 500, endX: 1500, endY: 500 },
        { sequence: 2, kind: 'VERTICAL', startX: 600, startY: 0, endX: 600, endY: 500 }
      ],
      'left-top',
      1500,
      1000
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].rapidStart).toEqual({ x: 0, y: 0 });
    expect(segments[0].rapidDistMm).toBe(500);
    expect(segments[0].cutDistMm).toBe(1500);
    expect(totalCutMm).toBe(2000);
    expect(totalRapidMm).toBeGreaterThan(1500);
  });
});
