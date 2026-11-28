import type { CameraState } from './canvasGeometry';

export const MIN_CAMERA_SCALE = 0.002;
export const MAX_CAMERA_SCALE = 5.0;
export const DEFAULT_CAMERA_TWEEN_MS = 240;
export const WHEEL_DAMP_LAMBDA = 20;

export interface CameraPoint {
  x: number;
  y: number;
}

export function clampCameraScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return MIN_CAMERA_SCALE;
  return Math.max(MIN_CAMERA_SCALE, Math.min(MAX_CAMERA_SCALE, scale));
}

export function easeOutExpo(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -10 * t);
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 将鼠标滚轮与触控板捏合（ctrlKey）的 deltaY 归一化为连续对数缩放因子。
 * 鼠标刻度（deltaMode=1）与像素滚轮（deltaMode=0）均限制在安全步长内。
 */
export function computeWheelZoomFactor(
  deltaY: number,
  deltaMode: number,
  ctrlKey: boolean
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  let pxDelta = deltaY;
  if (deltaMode === 1) {
    pxDelta *= 16;
  } else if (deltaMode === 2) {
    pxDelta *= 120;
  }
  const clamped = Math.max(-240, Math.min(240, pxDelta));
  const sensitivity = ctrlKey ? 0.0085 : 0.0024;
  return Math.exp(-clamped * sensitivity);
}

/**
 * 保持屏幕锚点 anchorPx 对应的世界坐标不变，计算目标倍率下的相机平移与缩放。
 */
export function computeZoomCameraAroundPoint(
  cam: CameraState,
  targetScale: number,
  anchorPx: CameraPoint
): CameraState {
  const safeCurScale = Math.max(MIN_CAMERA_SCALE, cam.scale);
  const nextScale = clampCameraScale(targetScale);
  const worldX = (anchorPx.x - cam.x) / safeCurScale;
  const worldY = (anchorPx.y - cam.y) / safeCurScale;
  return {
    ...cam,
    scale: nextScale,
    x: anchorPx.x - worldX * nextScale,
    y: anchorPx.y - worldY * nextScale
  };
}

/**
 * 在对数缩放空间中计算平滑推拉相机状态：
 * - 若提供 anchorPx，全程锁定锚点世界坐标零漂移；
 * - 若未提供 anchorPx（如 fitView / focusRange），在透视倒数空间做直线推拉消除弧线晃动。
 */
export function computeStraightZoomTweenState(
  from: CameraState,
  to: CameraState,
  progress: number,
  anchorPx?: CameraPoint | null
): CameraState {
  const u = easeOutExpo(progress);
  if (u <= 0) return { ...from };
  if (u >= 1) return { ...to };

  const s0 = Math.max(MIN_CAMERA_SCALE, from.scale);
  const s1 = Math.max(MIN_CAMERA_SCALE, to.scale);
  const scale = clampCameraScale(s0 * Math.pow(s1 / s0, u));

  if (anchorPx) {
    const worldX = (anchorPx.x - from.x) / s0;
    const worldY = (anchorPx.y - from.y) / s0;
    return {
      ...to,
      scale,
      x: anchorPx.x - worldX * scale,
      y: anchorPx.y - worldY * scale
    };
  }

  let x: number;
  let y: number;
  if (Math.abs(s1 - s0) > 1e-6) {
    const inv0 = 1 / s0;
    const inv1 = 1 / s1;
    const invS = 1 / scale;
    const w = (invS - inv0) / (inv1 - inv0);
    const ox = from.x * inv0 + (to.x * inv1 - from.x * inv0) * w;
    const oy = from.y * inv0 + (to.y * inv1 - from.y * inv0) * w;
    x = ox * scale;
    y = oy * scale;
  } else {
    x = from.x + (to.x - from.x) * u;
    y = from.y + (to.y - from.y) * u;
  }

  return {
    ...to,
    scale,
    x,
    y
  };
}

/**
 * 帧率无关的指数阻尼缩放步进：在 log(scale) 空间平滑逼近 target，并锁死光标锚点。
 */
export function stepExponentialZoomDamp(
  current: CameraState,
  target: CameraState,
  dtMs: number,
  anchorPx: CameraPoint,
  lambda = WHEEL_DAMP_LAMBDA
): { next: CameraState; done: boolean } {
  const sCur = Math.max(MIN_CAMERA_SCALE, current.scale);
  const sTarget = clampCameraScale(target.scale);

  if (Math.abs(sTarget - sCur) / Math.max(sTarget, 1e-6) < 0.0008) {
    return {
      next: computeZoomCameraAroundPoint(current, sTarget, anchorPx),
      done: true
    };
  }

  const dtSec = Math.max(0.001, Math.min(dtMs, 64)) / 1000;
  const alpha = 1 - Math.exp(-lambda * dtSec);
  const logCur = Math.log(sCur);
  const logTarget = Math.log(sTarget);
  const nextScale = clampCameraScale(Math.exp(logCur + (logTarget - logCur) * alpha));

  if (Math.abs(sTarget - nextScale) / Math.max(sTarget, 1e-6) < 0.0008) {
    return {
      next: computeZoomCameraAroundPoint(current, sTarget, anchorPx),
      done: true
    };
  }

  return {
    next: computeZoomCameraAroundPoint(current, nextScale, anchorPx),
    done: false
  };
}
