import type {
  DemandItem,
  MultiMaterialRunSummary,
  SavedScheme2D,
  SchemeDefectSnapshot,
  ShapeGeometry
} from '../../store/useStudioStore';
import type { BoardDefect } from '../../components/WorkbenchBoardCanvas';
import { rectangle, shapeArea } from '../../lib/canvas/nesting-scene.js';
import { csvCell } from '../../lib/domain/report-model.js';
import { toast } from '../../lib/core/util.js';
import type {
  MultiMaterialCandidateRollOption,
  MultiMaterialFilterContext
} from './workbenchTypes';

export interface MultiMaterialPlacementSnapshot {
  id?: number | string;
  demandId?: number;
  name?: string;
  x: number;
  y: number;
  w: number;
  l: number;
  rotationDegrees?: number;
  rotated?: boolean;
  polygon?: Array<{ x: number; y: number }>;
  holes?: Array<Array<{ x: number; y: number }>>;
  shape?: ShapeGeometry;
  sourceTaskId?: string;
  sourceLineId?: number;
}

export interface MultiMaterialDefectSnapshot {
  id?: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin?: number;
  defectType?: string;
  typeName?: string;
  severity?: number;
  points?: number;
  detectionSource?: string;
  avoidanceStrategy?: string;
  description?: string;
  label?: string;
}

export interface MultiMaterialAllocatedItem {
  demandId?: number;
  name?: string;
  partName?: string;
  partId?: number;
  quantity?: number;
  count?: number;
}

export interface MultiMaterialRemnantAllocation {
  remnantId: string;
  widthMm: number;
  lengthMm: number;
  utilizationPct: number;
  placedCount: number;
  piecesAreaM2: number;
  allocatedItems: MultiMaterialAllocatedItem[];
  placements?: MultiMaterialPlacementSnapshot[];
  defects?: MultiMaterialDefectSnapshot[];
  materialModel?: string;
  batchNo?: string;
  color?: string;
}

export interface MultiMaterialRollOption {
  rollId: string;
  widthMm: number;
  availableLengthMm: number;
  estimatedCutLengthMm: number;
  utilizationPct: number;
  placedCount: number;
  feasible: boolean;
  recommended: boolean;
  windowStartY?: number;
  totalLengthMm?: number;
  placements?: MultiMaterialPlacementSnapshot[];
  defects?: MultiMaterialDefectSnapshot[];
  rollModel?: string;
  batchNo?: string;
  color?: string;
}

export interface MultiMaterialPlanResponse {
  materialModel: string | null;
  totalRequestedPieces: number;
  placedByRemnants: number;
  placedByRoll: number;
  unplacedPieces: number;
  remnantAllocations: MultiMaterialRemnantAllocation[];
  rollOptions: MultiMaterialRollOption[];
  totalSavedAreaM2: number;
  elapsedMs: number;
  warnings: string[];
}

export interface BuildMultiMaterialRequestParams {
  demands: DemandItem[];
  taskId?: string | null;
  materialModel?: string | null;
  requiredBatchNo?: string | null;
  requiredColor?: string | null;
  preferRemnants: boolean;
  maxRemnants: number;
  candidateRollIds?: string[];
  pieceGapMm: number;
  trimStartMm: number;
  timeBudgetMs?: number;
}

export interface BuildMultiMaterialRequestResult {
  payload?: Record<string, any>;
  effectiveDemands?: DemandItem[];
  usedOrderedFallback?: boolean;
  error?: string;
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function round3(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function hasCustomShape(shape?: ShapeGeometry | null): boolean {
  if (!shape) return false;
  if (shape.type === 'POLYGON' && Array.isArray(shape.vertices) && shape.vertices.length >= 3) {
    return true;
  }
  return Array.isArray(shape.holes) && shape.holes.length > 0;
}

/**
 * 根据工作台左侧待排需求池、任务上下文与顶栏多料联排配置，构造
 * `POST /api/v2/planning/multi-material` 严格合规请求体。
 */
export function buildMultiMaterialWorkbenchRequest(
  params: BuildMultiMaterialRequestParams
): BuildMultiMaterialRequestResult {
  const {
    demands,
    taskId,
    materialModel,
    requiredBatchNo,
    requiredColor,
    preferRemnants,
    maxRemnants,
    candidateRollIds = [],
    pieceGapMm,
    trimStartMm,
    timeBudgetMs = 6000
  } = params;

  let effectiveDemands = (demands || []).filter(
    (d) => Number(d.quantity) > 0 && Number(d.width) > 0 && Number(d.length) > 0
  );
  let usedOrderedFallback = false;

  if (effectiveDemands.length === 0) {
    const retrial = (demands || [])
      .filter((d) => Number(d.orderedQty) > 0 && Number(d.width) > 0 && Number(d.length) > 0)
      .map((d) => ({ ...d, quantity: Math.max(1, Math.floor(Number(d.orderedQty) || 1)) }));
    if (retrial.length > 0) {
      effectiveDemands = retrial;
      usedOrderedFallback = true;
    }
  }

  if (effectiveDemands.length === 0) {
    return { error: '请先载入或添加有效裁片需求' };
  }

  const clampedMaxRemnants = preferRemnants
    ? Math.max(0, Math.min(20, Math.round(Number(maxRemnants) || 0)))
    : 0;
  const clampedBudget = Math.max(500, Math.min(30000, Math.round(Number(timeBudgetMs) || 6000)));

  const payload: Record<string, any> = {
    preferRemnants: Boolean(preferRemnants),
    maxRemnants: clampedMaxRemnants,
    timeBudgetMs: clampedBudget,
    pieceGapMm: Math.max(0, Number(pieceGapMm) || 0),
    trimStartMm: Math.max(0, Number(trimStartMm) || 0)
  };

  const cleanTaskId = String(taskId || '').trim();
  if (cleanTaskId) {
    payload.taskId = cleanTaskId;
  }
  const cleanModel = String(materialModel || '').trim();
  if (cleanModel) {
    payload.materialModel = cleanModel;
  }
  const cleanBatch = String(requiredBatchNo || '').trim();
  if (cleanBatch) {
    payload.requiredBatchNo = cleanBatch;
  }
  const cleanColor = String(requiredColor || '').trim();
  if (cleanColor) {
    payload.requiredColor = cleanColor;
  }

  const cleanedRollIds = Array.from(
    new Set(
      (candidateRollIds || [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )
  );
  if (cleanedRollIds.length > 0) {
    payload.candidateRollIds = cleanedRollIds;
  }

  payload.demands = effectiveDemands.map((d, idx) => {
    const item: Record<string, any> = {
      id: Number.isInteger(Number(d.id)) && Number(d.id) > 0 ? Number(d.id) : idx + 1,
      name: String(d.name || '').trim() || `裁片 #${idx + 1}`,
      width: Number(d.width),
      length: Number(d.length),
      quantity: Math.max(1, Math.floor(Number(d.quantity) || 1)),
      allowRotation: Boolean(d.allowRotation)
    };
    if (d.allowHalfTurn) {
      item.allowHalfTurn = true;
    }
    if (hasCustomShape(d.shape) && d.shape) {
      item.shape = {
        type: d.shape.type,
        width: Number(d.shape.width) || Number(d.width),
        height: Number(d.shape.height) || Number(d.length),
        ...(Array.isArray(d.shape.vertices) && d.shape.vertices.length >= 3
          ? {
              vertices: d.shape.vertices.map((pt) => ({
                x: Number(pt.x) || 0,
                y: Number(pt.y) || 0
              }))
            }
          : {}),
        ...(Array.isArray(d.shape.holes) && d.shape.holes.length > 0
          ? {
              holes: d.shape.holes.map((ring) =>
                ring.map((pt) => ({ x: Number(pt.x) || 0, y: Number(pt.y) || 0 }))
              )
            }
          : {})
      };
    }
    if (d.sourceTaskId) {
      item.sourceTaskId = d.sourceTaskId;
    }
    if (d.sourceLineId != null && Number.isFinite(Number(d.sourceLineId))) {
      item.sourceLineId = Number(d.sourceLineId);
    }
    return item;
  });

  return {
    payload,
    effectiveDemands,
    usedOrderedFallback
  };
}

/** 将后端 PlacementSnapshot 规范化为四层 CAD 画布与 confirmSelectedScheme2D 统一消费的裁片结构。 */
export function normalizeMultiMaterialPlacement(
  raw: MultiMaterialPlacementSnapshot,
  idx: number
): Record<string, any> {
  const w = round1(Number(raw.w ?? raw.shape?.width) || 0);
  const l = round1(Number(raw.l ?? raw.shape?.height) || 0);
  const rawPoly =
    Array.isArray(raw.polygon) && raw.polygon.length >= 3
      ? raw.polygon
      : raw.shape?.type === 'POLYGON' && Array.isArray(raw.shape.vertices) && raw.shape.vertices.length >= 3
      ? raw.shape.vertices
      : null;
  const rawHoles =
    Array.isArray(raw.holes) && raw.holes.length > 0
      ? raw.holes
      : Array.isArray(raw.shape?.holes) && raw.shape.holes.length > 0
      ? raw.shape.holes
      : null;

  const holes = rawHoles
    ? rawHoles.map((ring) => ring.map((pt) => ({ x: Number(pt.x) || 0, y: Number(pt.y) || 0 })))
    : undefined;

  const shape: ShapeGeometry = rawPoly
    ? {
        type: 'POLYGON',
        width: w,
        height: l,
        vertices: rawPoly.map((pt) => ({ x: Number(pt.x) || 0, y: Number(pt.y) || 0 })),
        ...(holes ? { holes } : {})
      }
    : {
        type: 'RECTANGLE',
        width: w,
        height: l,
        ...(holes ? { holes } : {})
      };

  const rot = Number(raw.rotationDegrees) || 0;
  return {
    id: raw.id ?? idx + 1,
    demandId: raw.demandId,
    name: raw.name || `#${raw.demandId ?? idx + 1}`,
    x: round1(Number(raw.x) || 0),
    y: round1(Number(raw.y) || 0),
    w,
    l,
    rotationDegrees: rot,
    rotated: raw.rotated ?? (Math.abs(rot) % 180 !== 0),
    shape,
    ...(raw.sourceTaskId ? { sourceTaskId: raw.sourceTaskId } : {}),
    ...(raw.sourceLineId != null ? { sourceLineId: Number(raw.sourceLineId) } : {})
  };
}

function normalizeDefectSnapshots(
  defects: MultiMaterialDefectSnapshot[] | undefined,
  windowAligned: boolean
): SchemeDefectSnapshot[] {
  if (!Array.isArray(defects) || defects.length === 0) return [];
  return defects
    .filter((d) => d && Number(d.w) > 0 && Number(d.h) > 0)
    .map((d, idx) => ({
      id: d.id ?? idx + 1,
      x: round1(Number(d.x) || 0),
      y: round1(Number(d.y) || 0),
      w: round1(Number(d.w) || 0),
      h: round1(Number(d.h) || 0),
      margin: windowAligned ? 0 : Math.max(0, Number(d.margin ?? 0) || 0),
      label: d.label || d.typeName || d.defectType || d.description || '疵点',
      typeName: d.typeName,
      defectType: d.defectType,
      windowAligned
    }));
}

export function formatAllocatedItems(items: MultiMaterialAllocatedItem[] | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return '—';
  return items
    .map((it) => {
      if (typeof it === 'string') return it;
      const label =
        it?.name ||
        it?.partName ||
        (it?.demandId != null
          ? `裁片#${it.demandId}`
          : it?.partId != null
          ? `裁片#${it.partId}`
          : '裁片');
      const count = it?.quantity ?? it?.count;
      return count != null ? `${label}×${count}` : String(label);
    })
    .join('、');
}

function buildMinimalNestingRequestShell(params: {
  materialId: string;
  widthMm: number;
  lengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  isContour: boolean;
}) {
  const { materialId, widthMm, lengthMm, trimStartMm, pieceGapMm, isContour } = params;
  return {
    schemaVersion: '2.0',
    problemType: 'NESTING_2D',
    problem: {
      schemaVersion: '1',
      unit: 'mm',
      material: {
        id: materialId,
        shape: rectangle(widthMm, lengthMm),
        exclusions: []
      },
      parts: [],
      process: {
        mode: isContour ? 'CONTOUR' : 'GUILLOTINE',
        startCorner: 'left-top',
        trimStart: trimStartMm,
        pieceGap: pieceGapMm
      }
    }
  };
}

export interface MapMultiMaterialResponseOptions {
  demands: DemandItem[];
  fallbackMaterialModel?: string;
  pieceGapMm: number;
  trimStartMm: number;
  batchId?: string;
  createdAt?: string;
}

/**
 * 将 `POST /api/v2/planning/multi-material` 响应映射为右侧方案列表的标准 `SavedScheme2D[]`
 * （先料头接力 #1..#k，再推荐母卷置顶 + 其他可行备选母卷）以及右侧顶部汇总卡摘要。
 */
export function mapMultiMaterialResponseToSchemes2D(
  response: MultiMaterialPlanResponse,
  options: MapMultiMaterialResponseOptions
): {
  schemes: SavedScheme2D[];
  summary: MultiMaterialRunSummary;
} {
  const {
    demands,
    fallbackMaterialModel = 'STANDARD',
    pieceGapMm,
    trimStartMm,
    batchId = `MM-${Date.now().toString(36).slice(-5)}`,
    createdAt = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  } = options;

  const clonedDemands = demands.map((d) => ({
    ...d,
    ...(d.shape ? { shape: structuredClone(d.shape) } : {})
  }));
  const isContour = clonedDemands.some((d) => d.shape?.type === 'POLYGON');
  const totalRequested = Math.max(
    0,
    Number(response.totalRequestedPieces) ||
      clonedDemands.reduce((s, d) => s + Math.max(0, Number(d.quantity) || 0), 0)
  );
  const placedByRemnants = Math.max(0, Number(response.placedByRemnants) || 0);
  const schemes: SavedScheme2D[] = [];

  // 1. 阶段一：料头接力卡片（按接力顺序）
  const remList = Array.isArray(response.remnantAllocations) ? response.remnantAllocations : [];
  remList.forEach((rem, idx) => {
    if (!rem?.remnantId) return;
    const relayIndex = idx + 1;
    const widthMm = round1(Number(rem.widthMm) || 0);
    const lengthMm = round1(Number(rem.lengthMm) || 0);
    const placements = (rem.placements || []).map((p, pIdx) =>
      normalizeMultiMaterialPlacement(p, pIdx)
    );
    const maxEndY =
      placements.length > 0
        ? Math.max(...placements.map((p) => (Number(p.y) || 0) + (Number(p.l) || 0)))
        : lengthMm;
    const occupiedLengthMm = round1(
      lengthMm > 0 ? Math.min(lengthMm, Math.max(0, maxEndY)) : Math.max(0, maxEndY)
    );
    const utilPct = round2(Number(rem.utilizationPct) || 0);
    const placedCount = Math.max(Number(rem.placedCount) || 0, placements.length);
    const netAreaM2 =
      Number(rem.piecesAreaM2) > 0
        ? round3(Number(rem.piecesAreaM2))
        : round3(
            placements.reduce((s, p) => s + (p.shape ? shapeArea(p.shape) : p.w * p.l), 0) /
              1_000_000
          );
    const complete = totalRequested > 0 && placedCount >= totalRequested;
    const strategyName = `料头接力 #${relayIndex} · ${rem.remnantId}`;
    const title = `料头接力 #${relayIndex} · ${rem.remnantId}（排入 ${placedCount} 件 · 利用率 ${utilPct.toFixed(
      1
    )}%）`;
    const matModel = rem.materialModel || response.materialModel || fallbackMaterialModel;
    const reqShell = buildMinimalNestingRequestShell({
      materialId: rem.remnantId,
      widthMm,
      lengthMm: Math.max(lengthMm, occupiedLengthMm, 100),
      trimStartMm: 0,
      pieceGapMm,
      isContour
    });

    schemes.push({
      id: `${batchId}-REM-${relayIndex}-${rem.remnantId}`,
      title,
      strategyId: 'MULTI_MATERIAL_REMNANT',
      strategyName,
      scenarioId: 'FIXED_BED',
      createdAt,
      canvasMode: 'REMNANT',
      remnantId: rem.remnantId,
      windowStartY: 0,
      materialModel: matModel,
      widthMm,
      canvasLengthMm: Math.max(lengthMm, occupiedLengthMm, 100),
      occupiedLengthMm,
      utilizationPct: utilPct,
      pieceAreaM2: netAreaM2,
      placedCount,
      requestedCount: Math.max(totalRequested, placedCount),
      gapFillCount: 0,
      complete,
      demands: structuredClone(clonedDemands),
      request: reqShell,
      result: {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        engine: 'multi-material',
        materialId: rem.remnantId,
        fulfillmentStatus: complete ? 'COMPLETE' : 'PARTIAL',
        meetsRequirement: complete,
        processingRegion: rectangle(widthMm, Math.max(lengthMm, occupiedLengthMm, 100)),
        layout: {
          processingRegion: rectangle(widthMm, Math.max(lengthMm, occupiedLengthMm, 100)),
          placements,
          leftovers: [],
          cuts: [],
          contours: []
        },
        marker: {
          occupiedLengthMm,
          gapFillPlacements: []
        }
      },
      defects: normalizeDefectSnapshots(rem.defects, false),
      multiMaterialRole: 'REMNANT_RELAY',
      multiMaterialRelayIndex: relayIndex,
      multiMaterialBatchId: batchId,
      batchNo: rem.batchNo,
      color: rem.color,
      allocatedSummary: formatAllocatedItems(rem.allocatedItems)
    });
  });

  // 2. 阶段二：可行母卷卡片（推荐卷置顶）
  const remainingForRoll = Math.max(0, totalRequested - placedByRemnants);
  const rawRollOptions = Array.isArray(response.rollOptions) ? response.rollOptions : [];
  const rankedRolls = rawRollOptions
    .map((opt, origIdx) => ({ opt, origIdx }))
    .filter(({ opt }) => opt?.rollId && (Number(opt.placedCount) > 0 || (opt.placements?.length || 0) > 0))
    .sort((a, b) => {
      if (Boolean(a.opt.recommended) !== Boolean(b.opt.recommended)) {
        return a.opt.recommended ? -1 : 1;
      }
      if (Boolean(a.opt.feasible) !== Boolean(b.opt.feasible)) {
        return a.opt.feasible ? -1 : 1;
      }
      return a.origIdx - b.origIdx;
    });

  rankedRolls.forEach(({ opt }, idx) => {
    const widthMm = round1(Number(opt.widthMm) || 0);
    const placements = (opt.placements || []).map((p, pIdx) =>
      normalizeMultiMaterialPlacement(p, pIdx)
    );
    const maxEndY =
      placements.length > 0
        ? Math.max(...placements.map((p) => (Number(p.y) || 0) + (Number(p.l) || 0)))
        : 0;
    const occupiedLengthMm = round1(
      Number(opt.estimatedCutLengthMm) > 0 ? Number(opt.estimatedCutLengthMm) : maxEndY
    );
    const canvasLengthMm = Math.max(occupiedLengthMm, round1(maxEndY), 100);
    const utilPct = round2(Number(opt.utilizationPct) || 0);
    const placedCount = Math.max(Number(opt.placedCount) || 0, placements.length);
    const netAreaM2 =
      placements.length > 0
        ? round3(
            placements.reduce((s, p) => s + (p.shape ? shapeArea(p.shape) : p.w * p.l), 0) /
              1_000_000
          )
        : round3((widthMm * occupiedLengthMm * (utilPct / 100)) / 1_000_000);
    const windowStartY = round1(Math.max(0, Number(opt.windowStartY) || 0));
    const complete = Boolean(opt.feasible);
    const strategyName = opt.recommended
      ? `推荐母卷 · ${opt.rollId}`
      : `备选母卷 · ${opt.rollId}`;
    const title = `${strategyName} (${widthMm}×${Math.round(occupiedLengthMm)}mm)`;
    const matModel = opt.rollModel || response.materialModel || fallbackMaterialModel;
    const reqShell = buildMinimalNestingRequestShell({
      materialId: opt.rollId,
      widthMm,
      lengthMm: canvasLengthMm,
      trimStartMm,
      pieceGapMm,
      isContour
    });

    schemes.push({
      id: `${batchId}-ROLL-${idx + 1}-${opt.rollId}`,
      title,
      strategyId: opt.recommended ? 'MULTI_MATERIAL_ROLL_REC' : 'MULTI_MATERIAL_ROLL_ALT',
      strategyName,
      scenarioId: 'SHORTEN_KIT',
      createdAt,
      canvasMode: 'STOCK_ROLL',
      rollId: opt.rollId,
      windowStartY,
      materialModel: matModel,
      widthMm,
      canvasLengthMm,
      occupiedLengthMm,
      utilizationPct: utilPct,
      pieceAreaM2: netAreaM2,
      placedCount,
      requestedCount: Math.max(remainingForRoll, placedCount),
      gapFillCount: 0,
      complete,
      demands: structuredClone(clonedDemands),
      request: reqShell,
      result: {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        engine: 'multi-material',
        materialId: opt.rollId,
        fulfillmentStatus: complete ? 'COMPLETE' : 'PARTIAL',
        meetsRequirement: complete,
        processingRegion: rectangle(widthMm, canvasLengthMm),
        layout: {
          processingRegion: rectangle(widthMm, canvasLengthMm),
          placements,
          leftovers: [],
          cuts: [],
          contours: []
        },
        marker: {
          occupiedLengthMm,
          gapFillPlacements: []
        }
      },
      defects: normalizeDefectSnapshots(opt.defects, true),
      multiMaterialRole: opt.recommended ? 'ROLL_RECOMMENDED' : 'ROLL_ALTERNATIVE',
      multiMaterialBatchId: batchId,
      batchNo: opt.batchNo,
      color: opt.color
    });
  });

  const recommendedOpt =
    rawRollOptions.find((o) => o.recommended) ||
    rankedRolls[0]?.opt ||
    null;

  const summary: MultiMaterialRunSummary = {
    batchId,
    materialModel: response.materialModel ?? null,
    totalRequestedPieces: totalRequested,
    placedByRemnants,
    placedByRoll: Math.max(0, Number(response.placedByRoll) || 0),
    unplacedPieces: Math.max(0, Number(response.unplacedPieces) || 0),
    remnantCount: remList.length,
    feasibleRollCount: rawRollOptions.filter((o) => o.feasible).length,
    recommendedRollId: recommendedOpt?.rollId || null,
    totalSavedAreaM2: Number(Number(response.totalSavedAreaM2 || 0).toFixed(4)),
    elapsedMs: Math.max(0, Math.round(Number(response.elapsedMs) || 0)),
    warnings: Array.isArray(response.warnings) ? [...response.warnings] : [],
    rawResponse: response
  };

  return { schemes, summary };
}

/**
 * 结合工作台当前品号/缸号/色号防色差约束，生成顶栏候选母卷选择器选项列表（同型适配卷置顶）。
 */
export function buildMultiMaterialCandidateRollOptions(
  passedRolls: any[],
  filter: MultiMaterialFilterContext
): MultiMaterialCandidateRollOption[] {
  const targetModel = String(filter.materialModel || '').trim().toLowerCase();
  const reqBatch = String(filter.requiredBatchNo || '').trim().toLowerCase();
  const reqColor = String(filter.requiredColor || '').trim().toLowerCase();
  const strict = Boolean(filter.strictBatchMatch);

  return (passedRolls || [])
    .filter((r) => r && r.rollId)
    .map((r) => {
      const rollModel = String(r.rollModel || '').trim();
      const batchNo = String(r.batchNo || '').trim();
      const color = String(r.color || '').trim();
      const matchesModel = !targetModel || rollModel.toLowerCase() === targetModel;
      const matchesBatch = reqBatch
        ? Boolean(batchNo && batchNo.toLowerCase() === reqBatch)
        : !strict || Boolean(batchNo);
      const matchesColor = !reqColor || !color || color.toLowerCase() === reqColor;
      const eligible = matchesModel && matchesBatch && matchesColor;
      const blockedByStrict = strict && (!matchesBatch || !matchesColor);

      const reasons: string[] = [];
      if (!matchesBatch) reasons.push(batchNo ? `异缸 ${batchNo}` : '未登记缸号');
      if (!matchesColor) reasons.push(`异色 ${color}`);
      if (!matchesModel) reasons.push('异型');

      return {
        rollId: String(r.rollId),
        rollModel,
        width: Number(r.width) || 0,
        availableLengthMm: Math.max(
          0,
          Number(r.currentRemainingLength ?? Math.max(0, (Number(r.totalLength) || 0) - (Number(r.usedLength) || 0))) || 0
        ),
        batchNo,
        color,
        matchesModel,
        matchesBatch,
        matchesColor,
        eligible,
        blockedByStrict,
        mismatchReason: reasons.length > 0 ? reasons.join(' · ') : undefined
      };
    })
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.blockedByStrict !== b.blockedByStrict) return a.blockedByStrict ? 1 : -1;
      if (b.availableLengthMm !== a.availableLengthMm) {
        return b.availableLengthMm - a.availableLengthMm;
      }
      return a.rollId.localeCompare(b.rollId);
    });
}

/** 将已对齐工位窗口或料头坐标的方案疵点转换为画布直接渲染的 BoardDefect[]。 */
export function toBoardDefectsFromSchemeSnapshot(
  defects: SchemeDefectSnapshot[] | undefined
): BoardDefect[] {
  if (!Array.isArray(defects) || defects.length === 0) return [];
  return defects
    .filter((d) => d && Number(d.w) > 0 && Number(d.h) > 0)
    .map((d, idx) => ({
      id: d.id ?? idx + 1,
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      w: Number(d.w) || 0,
      h: Number(d.h) || 0,
      margin: d.windowAligned ? 0 : Math.max(0, Number(d.margin ?? 0) || 0),
      label: d.label || d.typeName || d.defectType || '疵点'
    }));
}

/** 生成带 UTF-8 BOM 与公式注入防转义的多料联排方案 CSV 文本。 */
export function buildMultiMaterialCsvText(plan: MultiMaterialPlanResponse): string {
  const header = [
    '类别',
    '材料编号',
    '品号',
    '门幅(mm)',
    '长度/可用余长(mm)',
    '起切位Y(mm)',
    '预计切长(mm)',
    '利用率(%)',
    '排入件数',
    '状态/明细'
  ];
  const rows: (string | number)[][] = [];
  for (const rem of plan.remnantAllocations || []) {
    rows.push([
      '料头接力',
      rem.remnantId,
      rem.materialModel || plan.materialModel || '',
      rem.widthMm,
      rem.lengthMm,
      0,
      rem.lengthMm,
      Number(rem.utilizationPct || 0).toFixed(2),
      rem.placedCount,
      formatAllocatedItems(rem.allocatedItems)
    ]);
  }
  for (const opt of plan.rollOptions || []) {
    rows.push([
      '母卷评估',
      opt.rollId,
      opt.rollModel || plan.materialModel || '',
      opt.widthMm,
      opt.availableLengthMm,
      round1(Number(opt.windowStartY) || 0),
      opt.estimatedCutLengthMm,
      Number(opt.utilizationPct || 0).toFixed(2),
      opt.placedCount,
      opt.recommended ? '推荐首选' : opt.feasible ? '可行备选' : '长度或门幅不足'
    ]);
  }
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function exportMultiMaterialCsv(plan: MultiMaterialPlanResponse | null | undefined) {
  if (!plan) return;
  const csv = buildMultiMaterialCsvText(plan);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `多料联排方案-${plan.materialModel || 'ALL'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出安全转义的多料联排 CSV');
}
