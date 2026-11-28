import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_SCALE,
  MIN_CAMERA_SCALE,
  clampCameraScale,
  computeStraightZoomTweenState,
  computeWheelZoomFactor,
  computeZoomCameraAroundPoint,
  easeOutExpo,
  stepExponentialZoomDamp
} from '../canvasCameraMotion';

describe('画布相机动效数学模型（canvasCameraMotion）', () => {
  it('easeOutExpo 满足端点值与严格单调递增特性', () => {
    expect(easeOutExpo(-0.2)).toBe(0);
    expect(easeOutExpo(0)).toBe(0);
    expect(easeOutExpo(1)).toBe(1);
    expect(easeOutExpo(1.5)).toBe(1);

    const a = easeOutExpo(0.15);
    const b = easeOutExpo(0.5);
    const c = easeOutExpo(0.85);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeLessThan(1);
  });

  it('clampCameraScale 正确限制极小和极大缩放边界', () => {
    expect(clampCameraScale(0)).toBe(MIN_CAMERA_SCALE);
    expect(clampCameraScale(-1)).toBe(MIN_CAMERA_SCALE);
    expect(clampCameraScale(Number.NaN)).toBe(MIN_CAMERA_SCALE);
    expect(clampCameraScale(12)).toBe(MAX_CAMERA_SCALE);
    expect(clampCameraScale(0.75)).toBe(0.75);
  });

  it('computeWheelZoomFactor 支持像素滚轮、行滚轮与触控板捏合并安全限幅', () => {
    expect(computeWheelZoomFactor(0, 0, false)).toBe(1);
    const zoomIn = computeWheelZoomFactor(-100, 0, false);
    const zoomOut = computeWheelZoomFactor(100, 0, false);
    expect(zoomIn).toBeGreaterThan(1);
    expect(zoomOut).toBeLessThan(1);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 6);

    // deltaMode=1（按行）与 ctrlKey（触控板双指捏合）灵敏度更高
    const lineFactor = computeWheelZoomFactor(-3, 1, false);
    expect(lineFactor).toBeGreaterThan(1.05);
    const pinchFactor = computeWheelZoomFactor(-20, 0, true);
    expect(pinchFactor).toBeGreaterThan(computeWheelZoomFactor(-20, 0, false));

    // 超大 deltaY 触发安全钳位，不产生失控跳变
    expect(computeWheelZoomFactor(-99999, 0, false)).toBeCloseTo(
      computeWheelZoomFactor(-240, 0, false),
      6
    );
  });

  it('computeZoomCameraAroundPoint 缩放后锚点下世界坐标严格零漂移', () => {
    const cam = { x: 120, y: -45, scale: 0.4, fitScale: 0.25 };
    const anchor = { x: 480, y: 310 };
    const worldX = (anchor.x - cam.x) / cam.scale;
    const worldY = (anchor.y - cam.y) / cam.scale;

    const next = computeZoomCameraAroundPoint(cam, 1.35, anchor);
    expect(next.scale).toBeCloseTo(1.35, 6);
    expect((anchor.x - next.x) / next.scale).toBeCloseTo(worldX, 6);
    expect((anchor.y - next.y) / next.scale).toBeCloseTo(worldY, 6);
  });

  it('computeStraightZoomTweenState 在锚点模式与全览适配模式下均精准插值', () => {
    const from = { x: 80, y: 60, scale: 0.2, fitScale: 0.2 };
    const anchor = { x: 500, y: 360 };
    const to = computeZoomCameraAroundPoint(from, 1.6, anchor);
    const worldX = (anchor.x - from.x) / from.scale;
    const worldY = (anchor.y - from.y) / from.scale;

    const mid = computeStraightZoomTweenState(from, to, 0.5, anchor);
    expect(mid.scale).toBeGreaterThan(from.scale);
    expect(mid.scale).toBeLessThan(to.scale);
    expect((anchor.x - mid.x) / mid.scale).toBeCloseTo(worldX, 6);
    expect((anchor.y - mid.y) / mid.scale).toBeCloseTo(worldY, 6);

    // 无锚点（如 fitView / focusRange）在倒数空间做直线推拉并准确落点
    const fitTarget = { x: 240, y: 180, scale: 0.8, fitScale: 0.8 };
    const fitStart = computeStraightZoomTweenState(from, fitTarget, 0, null);
    const fitEnd = computeStraightZoomTweenState(from, fitTarget, 1, null);
    expect(fitStart).toEqual(from);
    expect(fitEnd).toEqual(fitTarget);
  });

  it('stepExponentialZoomDamp 逐帧锁定锚点并在有限步内收敛完成', () => {
    const start = { x: 100, y: 80, scale: 0.3, fitScale: 0.3 };
    const anchor = { x: 420, y: 260 };
    const target = computeZoomCameraAroundPoint(start, 0.9, anchor);
    const worldX = (anchor.x - start.x) / start.scale;
    const worldY = (anchor.y - start.y) / start.scale;

    let cur = start;
    let done = false;
    let steps = 0;
    while (!done && steps < 120) {
      const res = stepExponentialZoomDamp(cur, target, 16.67, anchor);
      cur = res.next;
      done = res.done;
      steps += 1;
      expect((anchor.x - cur.x) / cur.scale).toBeCloseTo(worldX, 5);
      expect((anchor.y - cur.y) / cur.scale).toBeCloseTo(worldY, 5);
    }

    expect(done).toBe(true);
    expect(cur.scale).toBeCloseTo(target.scale, 6);
    expect(steps).toBeLessThan(60);
  });
});
