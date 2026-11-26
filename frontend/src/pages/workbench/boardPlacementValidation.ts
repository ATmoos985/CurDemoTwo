import type { ShapeGeometry } from '../../store/studioTypes';
import { quantize01 } from '../../lib/domain/nesting-request-adapter.js';

export function rotateShapeGeometry(
  shape: ShapeGeometry | undefined,
  w: number,
  h: number,
  stepDeg: 90 | 180
): ShapeGeometry {
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    const sw = shape.width || w;
    const sh = shape.height || h;
    const raw = shape.vertices.map((pt) =>
      stepDeg === 90 ? { x: sh - pt.y, y: pt.x } : { x: sw - pt.x, y: sh - pt.y }
    );
    const minX = Math.min(...raw.map((p) => p.x));
    const minY = Math.min(...raw.map((p) => p.y));
    const normalized = raw.map((p) => ({
      x: Math.max(0, quantize01(p.x - minX)),
      y: Math.max(0, quantize01(p.y - minY))
    }));
    const newW = quantize01(Math.max(...normalized.map((p) => p.x)));
    const newH = quantize01(Math.max(...normalized.map((p) => p.y)));
    return {
      type: 'POLYGON',
      width: newW,
      height: newH,
      vertices: normalized
    };
  }
  return stepDeg === 90
    ? { type: 'RECTANGLE', width: quantize01(h), height: quantize01(w) }
    : { type: 'RECTANGLE', width: quantize01(w), height: quantize01(h) };
}

export interface ValidationPoint {
  x: number;
  y: number;
}

export interface ValidationShapeGeometry {
  type: 'RECTANGLE' | 'POLYGON';
  width: number;
  height: number;
  vertices?: ValidationPoint[];
}

export interface ValidationDefect {
  id: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin?: number;
}

export interface ValidationPlacedPiece {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape?: ValidationShapeGeometry;
}

export interface PlacementValidationResult {
  ok: boolean;
  reason: string;
}

export interface ValidateRollPlacementParams {
  shape: ValidationShapeGeometry | undefined;
  w: number;
  h: number;
  localX: number;
  localY: number;
  ignorePieceIndex: number;
  rollWidthMm: number;
  rollLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  defects: ValidationDefect[];
  placedPieces: ValidationPlacedPiece[];
}

export interface RotationDemandConstraint {
  allowRotation?: boolean;
  allowHalfTurn?: boolean;
}

export interface RotationStepDecision {
  allowed: boolean;
  stepDeg: 90 | 180 | null;
  reason: string;
}

export interface TryRotatePlacedPieceParams {
  target: {
    name?: string;
    x?: number;
    y?: number;
    w?: number;
    l?: number;
    rotationDegrees?: number;
    shape?: ShapeGeometry;
    allowRotation?: boolean;
    allowHalfTurn?: boolean;
  };
  pieceIndex: number;
  demand?: RotationDemandConstraint | null;
  placedPieces: ValidationPlacedPiece[];
  rollWidthMm: number;
  rollLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  defects: ValidationDefect[];
}

export type TryRotatePlacedPieceResult =
  | {
      ok: true;
      reason: '';
      stepDeg: 90 | 180;
      nextX: number;
      nextY: number;
      nextRotationDegrees: number;
      rotatedShape: ShapeGeometry;
    }
  | {
      ok: false;
      reason: string;
    };

function getWorldVertices(
  shape: ValidationShapeGeometry | undefined,
  w: number,
  h: number,
  ox: number,
  oy: number
): ValidationPoint[] {
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    return shape.vertices.map((pt) => ({ x: pt.x + ox, y: pt.y + oy }));
  }
  return [
    { x: ox, y: oy },
    { x: ox + w, y: oy },
    { x: ox + w, y: oy + h },
    { x: ox, y: oy + h }
  ];
}

function pointInPolygonStrict(px: number, py: number, poly: ValidationPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > 1e-6) {
      const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
      const distSq = (px - (a.x + t * dx)) ** 2 + (py - (a.y + t * dy)) ** 2;
      if (distSq <= 0.36) return false;
    }
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsProperlyIntersect(
  a: ValidationPoint,
  b: ValidationPoint,
  c: ValidationPoint,
  d: ValidationPoint
): boolean {
  const cross = (p: ValidationPoint, q: ValidationPoint, r: ValidationPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  const eps = 1e-2;
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

function pointToSegmentDistSq(p: ValidationPoint, a: ValidationPoint, b: ValidationPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
}

export function polygonsOverlapOrViolateGap(
  polyA: ValidationPoint[],
  polyB: ValidationPoint[],
  minGap: number
): boolean {
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % polyB.length];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }
  for (const p of polyA) {
    if (pointInPolygonStrict(p.x, p.y, polyB)) return true;
  }
  for (const p of polyB) {
    if (pointInPolygonStrict(p.x, p.y, polyA)) return true;
  }
  const cA = polyA.reduce(
    (acc, p) => ({ x: acc.x + p.x / polyA.length, y: acc.y + p.y / polyA.length }),
    { x: 0, y: 0 }
  );
  const cB = polyB.reduce(
    (acc, p) => ({ x: acc.x + p.x / polyB.length, y: acc.y + p.y / polyB.length }),
    { x: 0, y: 0 }
  );
  if (pointInPolygonStrict(cA.x, cA.y, polyB) || pointInPolygonStrict(cB.x, cB.y, polyA)) {
    return true;
  }

  if (minGap > 0.6) {
    const thresholdSq = (minGap - 0.5) ** 2;
    for (const p of polyA) {
      for (let j = 0; j < polyB.length; j++) {
        if (pointToSegmentDistSq(p, polyB[j], polyB[(j + 1) % polyB.length]) < thresholdSq) {
          return true;
        }
      }
    }
    for (const p of polyB) {
      for (let i = 0; i < polyA.length; i++) {
        if (pointToSegmentDistSq(p, polyA[i], polyA[(i + 1) % polyA.length]) < thresholdSq) {
          return true;
        }
      }
    }
  }
  return false;
}

export function shapesCollide(
  shapeA: ValidationShapeGeometry | undefined,
  wA: number,
  hA: number,
  xA: number,
  yA: number,
  shapeB: ValidationShapeGeometry | undefined,
  wB: number,
  hB: number,
  xB: number,
  yB: number,
  gapMm: number
): boolean {
  const pad = Math.max(0, gapMm) - 0.5;
  if (
    xA + wA + pad <= xB ||
    xB + wB + pad <= xA ||
    yA + hA + pad <= yB ||
    yB + hB + pad <= yA
  ) {
    return false;
  }
  if (shapeA?.type !== 'POLYGON' && shapeB?.type !== 'POLYGON') {
    return true;
  }
  const polyA = getWorldVertices(shapeA, wA, hA, xA, yA);
  const polyB = getWorldVertices(shapeB, wB, hB, xB, yB);
  return polygonsOverlapOrViolateGap(polyA, polyB, Math.max(0, gapMm));
}

/** 校验裁片在母卷工位局部坐标系下是否越界、侵占切头区、碰撞疵点或与其他裁片重叠/间距不足。 */
export function validateRollPlacement(
  params: ValidateRollPlacementParams
): PlacementValidationResult {
  const {
    shape,
    w,
    h,
    localX,
    localY,
    ignorePieceIndex,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    placedPieces
  } = params;

  if (w > rollWidthMm + 0.5) {
    return { ok: false, reason: `裁片宽 ${Math.round(w)}mm 超过母卷门幅 ${rollWidthMm}mm` };
  }
  if (localX < -0.5 || localX + w > rollWidthMm + 0.5) {
    return { ok: false, reason: '超出母卷左右边界' };
  }
  if (localY < trimStartMm - 0.5) {
    return { ok: false, reason: `进入切头修边区 (Y < ${trimStartMm}mm)` };
  }
  if (localY + h > rollLengthMm + 0.5) {
    return { ok: false, reason: '超出当前母卷版长上限' };
  }
  for (const d of defects) {
    const m = d.margin ?? 0;
    const dx = Math.max(0, d.x - m);
    const dy = Math.max(0, d.y - m);
    const dw = d.w + m * 2;
    const dh = d.h + m * 2;
    if (shapesCollide(shape, w, h, localX, localY, undefined, dw, dh, dx, dy, 0)) {
      return { ok: false, reason: '与母卷疵点禁入区重叠' };
    }
  }
  for (const other of placedPieces) {
    if (other.index === ignorePieceIndex) continue;
    if (
      shapesCollide(
        shape,
        w,
        h,
        localX,
        localY,
        other.shape,
        other.width,
        other.height,
        other.x,
        other.y,
        pieceGapMm
      )
    ) {
      return { ok: false, reason: `与裁片「${other.name}」重叠或间距不足` };
    }
  }
  return { ok: true, reason: '' };
}

/** 根据需求件的 allowRotation / allowHalfTurn 严格判定允许旋转步进角，不可旋转件直接拒绝。 */
export function resolveRotationStep(
  constraint: RotationDemandConstraint | null | undefined,
  pieceName?: string
): RotationStepDecision {
  const allow90 = Boolean(constraint?.allowRotation);
  const allow180 = Boolean(constraint?.allowHalfTurn);
  if (allow90) {
    return { allowed: true, stepDeg: 90, reason: '' };
  }
  if (allow180) {
    return { allowed: true, stepDeg: 180, reason: '' };
  }
  return {
    allowed: false,
    stepDeg: null,
    reason: `裁片「${pieceName || '当前裁片'}」为不可旋转件（严格 0° 方向），禁止旋转`
  };
}

/** 尝试在画布内旋转已排裁片：依次校验旋转许可、母卷幅宽/版长、疵点禁入区与周边裁片碰撞。 */
export function tryRotatePlacedPiece(
  params: TryRotatePlacedPieceParams
): TryRotatePlacedPieceResult {
  const {
    target,
    pieceIndex,
    demand,
    placedPieces,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    defects
  } = params;

  const constraint: RotationDemandConstraint = demand ?? {
    allowRotation: target.allowRotation,
    allowHalfTurn: target.allowHalfTurn
  };
  const decision = resolveRotationStep(constraint, target.name);
  if (!decision.allowed || !decision.stepDeg) {
    return { ok: false, reason: decision.reason };
  }

  const stepDeg = decision.stepDeg;
  const curShape = target.shape;
  const curW = Number(curShape?.width ?? target.w) || 0;
  const curH = Number(curShape?.height ?? target.l) || 0;
  const rotatedShape = rotateShapeGeometry(curShape, curW, curH, stepDeg);

  if (rotatedShape.width > rollWidthMm + 0.5) {
    return {
      ok: false,
      reason: `旋转后宽度 ${Math.round(rotatedShape.width)}mm 超过母卷门幅 ${rollWidthMm}mm`
    };
  }
  if (rotatedShape.height > rollLengthMm - trimStartMm + 0.5) {
    return {
      ok: false,
      reason: `旋转后长度 ${Math.round(rotatedShape.height)}mm 超过当前母卷可用版长`
    };
  }

  const cx = (Number(target.x) || 0) + curW / 2;
  const cy = (Number(target.y) || 0) + curH / 2;
  const nextX = Math.max(
    0,
    Math.min(
      rollWidthMm - rotatedShape.width,
      Math.round((cx - rotatedShape.width / 2) * 10) / 10
    )
  );
  const nextY = Math.max(
    trimStartMm,
    Math.min(
      rollLengthMm - rotatedShape.height,
      Math.round((cy - rotatedShape.height / 2) * 10) / 10
    )
  );

  const check = validateRollPlacement({
    shape: rotatedShape,
    w: rotatedShape.width,
    h: rotatedShape.height,
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
    return { ok: false, reason: `旋转冲突已回退：${check.reason}` };
  }

  return {
    ok: true,
    reason: '',
    stepDeg,
    nextX,
    nextY,
    nextRotationDegrees: ((Number(target.rotationDegrees) || 0) + stepDeg) % 360,
    rotatedShape
  };
}
