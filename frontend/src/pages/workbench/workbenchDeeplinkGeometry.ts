import type {
  SavedSchemeCanvasMode2D,
  SchemeDefectSnapshot,
  ShapeGeometry
} from '../../store/studioTypes';
import type { WorkbenchResultContextDto } from './workbenchDeeplinkTypes';
import { quantize01 } from '../../lib/domain/nesting-request-adapter.js';
import { rectangle } from '../../lib/canvas/nesting-scene.js';

export function positiveNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function nonNegNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value != null ? String(value).trim() : '';
}

export function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

export function round3(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function polygonRingAreaMm2(points: Array<{ x?: number; y?: number }> | undefined | null): number {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ax = Number(a?.x) || 0;
    const ay = Number(a?.y) || 0;
    const bx = Number(b?.x) || 0;
    const by = Number(b?.y) || 0;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

/** 计算矩形、异形多边形及带内孔轮廓的净实体面积（mm²）。 */
export function computeShapeNetAreaMm2(shape: any): number {
  if (!shape) return 0;
  const isPolygon =
    shape.type === 'POLYGON' && Array.isArray(shape.vertices) && shape.vertices.length >= 3;
  const outer = isPolygon
    ? polygonRingAreaMm2(shape.vertices)
    : Math.max(0, Number(shape.width) || 0) * Math.max(0, Number(shape.height) || 0);
  if (!Array.isArray(shape.holes) || shape.holes.length === 0) {
    return outer;
  }
  let holesArea = 0;
  for (const ring of shape.holes) {
    holesArea += polygonRingAreaMm2(ring);
  }
  return Math.max(0, outer - holesArea);
}

export function normalizeMaterialType(raw: unknown): SavedSchemeCanvasMode2D {
  const upper = cleanText(raw).toUpperCase();
  if (upper === 'STOCK_ROLL' || upper === 'ROLL') return 'STOCK_ROLL';
  if (upper === 'REMNANT') return 'REMNANT';
  return 'FREE_CANVAS';
}

export function hasPolygonOrHoleParts(problem: any, result: any): boolean {
  const checkShape = (s: any): boolean =>
    Boolean(
      s &&
        (s.type === 'POLYGON' ||
          (Array.isArray(s.vertices) && s.vertices.length >= 3) ||
          (Array.isArray(s.holes) && s.holes.length > 0))
    );
  const parts: any[] = Array.isArray(problem?.parts) ? problem.parts : [];
  if (parts.some((p) => checkShape(p?.shape))) return true;
  const placements: any[] = Array.isArray(result?.layout?.placements)
    ? result.layout.placements
    : [];
  return placements.some((p) => checkShape(p?.shape));
}

/**
 * 判定后端二维直刀方案是否使用了外扩间隙求解（rectGapPaddingMm），与前端
 * buildSafeNestingRequest2D / unpadGuillotineResult 保持完全一致的还原口径。
 */
export function resolveRectGapPaddingMm(context: WorkbenchResultContextDto | null | undefined): number {
  if (!context) return 0;
  const problem = context.input?.problem;
  const source = context.source;
  const mode = cleanText(problem?.process?.mode || source?.processMode).toUpperCase();
  if (mode === 'CONTOUR' || hasPolygonOrHoleParts(problem, context.result)) {
    return 0;
  }
  if (source && source.rectGapPaddingMm !== undefined && source.rectGapPaddingMm !== null) {
    const explicit = Number(source.rectGapPaddingMm);
    return Number.isFinite(explicit) && explicit > 0 ? quantize01(explicit, 0) : 0;
  }
  const sourceGap = positiveNum(source?.pieceGapMm, 0);
  const processGap = nonNegNum(problem?.process?.pieceGap, 0);
  if (sourceGap <= 0 || processGap > 0) return 0;
  if (mode && mode !== 'GUILLOTINE') return 0;

  const solverW = positiveNum(problem?.material?.shape?.width, 0);
  const origW = positiveNum(source?.physicalWidthMm ?? source?.widthMm, 0);
  if (solverW > 0 && origW > 0) {
    const diff = solverW - origW;
    if (Math.abs(diff - sourceGap) <= 0.25) {
      return quantize01(sourceGap, 0);
    }
    return diff > 0.05 ? quantize01(diff, 0) : 0;
  }
  return mode === 'GUILLOTINE' ? quantize01(sourceGap, 0) : 0;
}

export function unpadGapFillPlacements(
  rawGapFills: any[],
  rectGapPadding: number,
  partMap: Map<number, any>,
  origWidthMm: number,
  origHeightMm: number
): any[] {
  if (!Array.isArray(rawGapFills) || rawGapFills.length === 0) return [];
  if (!rectGapPadding || rectGapPadding <= 0) return rawGapFills;
  return rawGapFills.map((pl) => {
    const orig = partMap.get(Number(pl.demandId));
    const rotated = Number(pl.rotationDegrees) % 180 !== 0;
    const w = orig
      ? rotated
        ? orig.shape.height
        : orig.shape.width
      : Math.max(0.1, quantize01((pl.shape?.width || 0) - rectGapPadding));
    const h = orig
      ? rotated
        ? orig.shape.width
        : orig.shape.height
      : Math.max(0.1, quantize01((pl.shape?.height || 0) - rectGapPadding));
    return {
      ...pl,
      x: Math.max(0, Math.min(Math.max(0, origWidthMm - w), quantize01(pl.x))),
      y: Math.max(0, Math.min(Math.max(0, origHeightMm - h), quantize01(pl.y))),
      shape: rectangle(w, h)
    };
  });
}

export function normalizeShapeGeometry(rawShape: any, fallbackW: number, fallbackH: number): ShapeGeometry {
  const w = positiveNum(rawShape?.width, fallbackW);
  const h = positiveNum(rawShape?.height, fallbackH);
  const isPoly =
    rawShape?.type === 'POLYGON' &&
    Array.isArray(rawShape.vertices) &&
    rawShape.vertices.length >= 3;
  const holes =
    Array.isArray(rawShape?.holes) && rawShape.holes.length > 0
      ? rawShape.holes
          .filter((ring: any) => Array.isArray(ring) && ring.length >= 3)
          .map((ring: any[]) =>
            ring.map((pt) => ({
              x: nonNegNum(pt?.x, 0),
              y: nonNegNum(pt?.y, 0)
            }))
          )
      : undefined;
  if (isPoly) {
    return {
      type: 'POLYGON',
      width: w,
      height: h,
      vertices: rawShape.vertices.map((pt: any) => ({
        x: nonNegNum(pt?.x, 0),
        y: nonNegNum(pt?.y, 0)
      })),
      ...(holes && holes.length > 0 ? { holes } : {})
    };
  }
  return {
    type: 'RECTANGLE',
    width: w,
    height: h,
    ...(holes && holes.length > 0 ? { holes } : {})
  };
}

export function extractWindowDefectsFromProblem(
  problem: any,
  origWidthMm: number,
  trimStartMm: number,
  isContour: boolean
): SchemeDefectSnapshot[] | undefined {
  const exclusions: any[] = Array.isArray(problem?.material?.exclusions)
    ? problem.material.exclusions
    : [];
  if (exclusions.length === 0) return undefined;

  const list: SchemeDefectSnapshot[] = [];
  for (let i = 0; i < exclusions.length; i++) {
    const ex = exclusions[i];
    if (!ex) continue;
    const x = nonNegNum(ex.x, 0);
    const y = nonNegNum(ex.y, 0);
    const w = positiveNum(ex.shape?.width ?? ex.w, 0);
    const h = positiveNum(ex.shape?.height ?? ex.h, 0);
    if (w <= 0 || h <= 0) continue;

    const isSyntheticTrimStrip =
      isContour &&
      trimStartMm > 0 &&
      x <= 0.1 &&
      y <= 0.1 &&
      w >= Math.max(1, origWidthMm - 0.5) &&
      Math.abs(h - trimStartMm) <= 0.5;
    if (isSyntheticTrimStrip) continue;

    list.push({
      id: ex.id ?? `ex-${i + 1}`,
      x,
      y,
      w,
      h,
      margin: 0,
      label: ex.avoidancePolicy ? `禁区(${ex.avoidancePolicy})` : '避疵禁区',
      windowAligned: true
    });
  }
  return list.length > 0 ? list : undefined;
}
