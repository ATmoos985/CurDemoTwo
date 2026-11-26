import type {
  DemandItem,
  SavedScheme2D,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/studioTypes';
import type { BoardDefect } from '../../components/canvas/canvasTypes';

export interface SourceAllocationItem {
  taskId: string;
  lineId: number;
  quantity: number;
}

export interface SourceAllocationSummary {
  allocations: SourceAllocationItem[];
  uniqueTaskIds: string[];
  isMultiFamily: boolean;
  resolvedTaskId: string | undefined;
  shouldSendSourceAllocations: boolean;
}

/** 递归规范化序列化对象（键按字典序排序、忽略 undefined），确保语义相同的数据生成同一哈希。 */
export function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    return Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : 'null';
  }
  if (t === 'boolean' || t === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalSerialize(item))).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalSerialize(obj[k])}`).join(',') + '}';
  }
  return 'null';
}

/** 确定性 64 位双 FNV-1a 哈希（输出 16 位小写十六进制，不依赖时间戳或随机数）。 */
export function stableHash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 生成与内容严格绑定的确定性幂等键。 */
export function computeDeterministicIdempotencyKey(prefix: string, payload: unknown): string {
  return `${prefix}-${stableHash64(canonicalSerialize(payload))}`;
}

function finalizeSourceAllocations(
  countsByKey: Map<string, SourceAllocationItem>,
  loadedTaskId: string | null | undefined
): SourceAllocationSummary {
  const allocations = [...countsByKey.values()]
    .filter((a) => a.quantity > 0)
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.lineId - b.lineId);

  const uniqueTaskIds = [...new Set(allocations.map((a) => a.taskId))];
  const isMultiFamily = uniqueTaskIds.length > 1;
  const resolvedTaskId = isMultiFamily
    ? undefined
    : loadedTaskId || (uniqueTaskIds.length === 1 ? uniqueTaskIds[0] : undefined);
  const shouldSendSourceAllocations =
    allocations.length > 0 &&
    (isMultiFamily || !loadedTaskId || (uniqueTaskIds.length === 1 && uniqueTaskIds[0] !== loadedTaskId));

  return {
    allocations,
    uniqueTaskIds,
    isMultiFamily,
    resolvedTaskId,
    shouldSendSourceAllocations
  };
}

/** 按 2D 方案中真实排入（非 gapFill）的裁片数量构造跨需求族 sourceAllocations。 */
export function buildSourceAllocations2D(
  placements: Array<{ demandId?: number | string; gapFill?: boolean }>,
  demands: DemandItem[],
  loadedTaskId?: string | null
): SourceAllocationSummary {
  const demandById = new Map<number, DemandItem>();
  for (const d of demands) {
    demandById.set(Number(d.id), d);
  }
  const counts = new Map<string, SourceAllocationItem>();
  for (const p of placements || []) {
    if (p.gapFill) continue;
    if (p.demandId == null) continue;
    const d = demandById.get(Number(p.demandId));
    if (!d?.sourceTaskId || d.sourceLineId == null) continue;
    const key = `${d.sourceTaskId}::${d.sourceLineId}`;
    const existing = counts.get(key);
    if (existing) {
      existing.quantity += 1;
    } else {
      counts.set(key, {
        taskId: d.sourceTaskId,
        lineId: Number(d.sourceLineId),
        quantity: 1
      });
    }
  }
  return finalizeSourceAllocations(counts, loadedTaskId);
}

/** 按 1D 分切方案的真实履约产出（不超过当前行待排余量）构造跨需求族 sourceAllocations。 */
export function buildSourceAllocations1D(
  fulfillment: Array<{ orderId: string | number; produced: number }>,
  slitOrders: SlittingOrderLine[],
  slitLoadedTaskId?: string | null
): SourceAllocationSummary {
  const orderById = new Map<string, SlittingOrderLine>();
  for (const o of slitOrders) {
    orderById.set(String(o.id), o);
  }
  const counts = new Map<string, SourceAllocationItem>();
  for (const f of fulfillment || []) {
    const o = orderById.get(String(f.orderId));
    if (!o?.sourceTaskId || o.sourceLineId == null) continue;
    const produced = Math.max(0, Math.floor(Number(f.produced) || 0));
    const open = Math.max(0, Math.floor(Number(o.quantity) || 0));
    const qty = open > 0 ? Math.min(open, produced) : produced;
    if (qty <= 0) continue;
    const key = `${o.sourceTaskId}::${o.sourceLineId}`;
    const existing = counts.get(key);
    if (existing) {
      existing.quantity += qty;
    } else {
      counts.set(key, {
        taskId: o.sourceTaskId,
        lineId: Number(o.sourceLineId),
        quantity: qty
      });
    }
  }
  return finalizeSourceAllocations(counts, slitLoadedTaskId);
}

/** 为 2D 方案确认生成确定性幂等键（同一批排布内容反复提交或断网重放保持一致）。 */
export function buildConfirm2DIdempotencyKey(params: {
  scheme: SavedScheme2D;
  taskId?: string;
  sourceAllocations?: SourceAllocationItem[];
  trimStartMm: number;
  pieceGapMm: number;
  placements: Array<{
    demandId?: number;
    x: number;
    y: number;
    w: number;
    l: number;
    rotationDegrees?: number;
    gapFill?: boolean;
  }>;
}): string {
  const { scheme, taskId, sourceAllocations, trimStartMm, pieceGapMm, placements } = params;
  return computeDeterministicIdempotencyKey('CONFIRM-2D', {
    dimension: scheme.demands.some((d) => d.shape?.type === 'POLYGON') ? 'CONTOUR_2D' : 'RECT_2D',
    strategyId: scheme.strategyId || 'AUTO',
    taskId: taskId || null,
    sourceAllocations: sourceAllocations || null,
    materialMode: scheme.canvasMode === 'FREE_CANVAS' ? 'VIRTUAL_ROLL' : scheme.canvasMode,
    rollId: scheme.rollId || null,
    remnantId: scheme.remnantId || null,
    widthMm: scheme.widthMm,
    occupiedLengthMm: scheme.occupiedLengthMm,
    windowStartY: scheme.windowStartY || 0,
    trimStartMm,
    pieceGapMm,
    placements: placements.map((p) => ({
      d: p.demandId ?? null,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      w: Math.round(p.w * 10) / 10,
      l: Math.round(p.l * 10) / 10,
      r: p.rotationDegrees || 0,
      g: Boolean(p.gapFill)
    }))
  });
}

/** 为 1D 分切方案确认生成确定性幂等键（完全去除 Date.now()，支持断网重放）。 */
export function buildConfirm1DIdempotencyKey(params: {
  scheme: SlittingSchemeRun;
  taskId?: string;
  sourceAllocations?: SourceAllocationItem[];
  materialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  rollId?: string;
  fixedLengthMm: number;
  avoidDefects: boolean;
}): string {
  const { scheme, taskId, sourceAllocations, materialMode, rollId, fixedLengthMm, avoidDefects } =
    params;
  return computeDeterministicIdempotencyKey('CONFIRM-1D', {
    strategyId: scheme.strategyId,
    taskId: taskId || null,
    sourceAllocations: sourceAllocations || null,
    materialMode,
    rollId: rollId || null,
    motherWidthMm: scheme.motherWidthMm,
    leftTrimMm: scheme.leftTrimMm,
    rightTrimMm: scheme.rightTrimMm,
    fixedLengthMm,
    avoidDefects,
    totalCars: scheme.totalCars,
    patterns: scheme.patterns.map((p) => ({
      l: p.lengthMm,
      r: p.repetitions,
      s: p.stations.map((st) => [st.widthMm, st.countPerRepetition])
    })),
    fulfillment: scheme.fulfillment.map((f) => [String(f.orderId), f.produced])
  });
}

/** 为结果管理完工记账构造确定性幂等键。 */
export function buildCompleteSchemeIdempotencyKey(params: {
  schemeId: string;
  customMode: boolean;
  actualCutLenMm?: number;
  rejectedPieceIds?: number[];
  recoverRemnants: boolean;
  remnantLocation: string;
}): string {
  return computeDeterministicIdempotencyKey(`COMPLETE-${params.schemeId}`, {
    customMode: params.customMode,
    actualCutLenMm: params.customMode ? params.actualCutLenMm ?? null : null,
    rejectedPieceIds: [...(params.rejectedPieceIds || [])].sort((a, b) => a - b),
    recoverRemnants: params.recoverRemnants,
    remnantLocation: params.remnantLocation
  });
}

/** 按前后端冻结契约构造 POST /api/v2/schemes/validate-layout 请求体。 */
export function buildValidateLayoutPayload(params: {
  scheme: SavedScheme2D;
  demands: DemandItem[];
  trimStartMm: number;
  pieceGapMm: number;
  defects: BoardDefect[];
  defaultDefectMarginMm: number;
}) {
  const { scheme, demands, trimStartMm, pieceGapMm, defects, defaultDefectMarginMm } = params;
  const mainPlacements: any[] = scheme.result?.layout?.placements || [];
  const gapPlacements: any[] = scheme.result?.marker?.gapFillPlacements || [];
  const materialLengthMm = Math.max(
    100,
    Number(scheme.canvasLengthMm) || 0,
    Number(scheme.occupiedLengthMm) || 0
  );
  const effectiveDemands = scheme.demands?.length ? scheme.demands : demands;

  return {
    materialWidthMm: scheme.widthMm,
    materialLengthMm,
    trimStartMm,
    pieceGapMm,
    avoidDefects: defects.length > 0,
    rollId: scheme.rollId || undefined,
    remnantId: scheme.remnantId || undefined,
    windowStartY: scheme.windowStartY ?? 0,
    defects: defects.map((d) => ({
      id: d.id,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      margin: d.margin ?? defaultDefectMarginMm
    })),
    placements: [
      ...mainPlacements.map((p, idx) => ({
        id: Number(p.id) || idx + 1,
        demandId: p.demandId,
        name: p.name,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        w: Number(p.shape?.width ?? p.w) || 0,
        l: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: Number(p.rotationDegrees) || 0,
        gapFill: false,
        shape: p.shape
      })),
      ...gapPlacements.map((p, idx) => ({
        id: Number(p.id) || mainPlacements.length + idx + 1,
        demandId: p.demandId,
        name: p.name,
        x: Number(p.x) || 0,
        y: Number(p.y) || 0,
        w: Number(p.shape?.width ?? p.w) || 0,
        l: Number(p.shape?.height ?? p.l) || 0,
        rotationDegrees: Number(p.rotationDegrees) || 0,
        gapFill: true,
        shape: p.shape
      }))
    ],
    demands: effectiveDemands.map((d) => ({
      id: d.id,
      name: d.name,
      width: d.width,
      length: d.length,
      quantity: Math.max(1, d.orderedQty || d.quantity),
      allowRotation: Boolean(d.allowRotation),
      allowHalfTurn: Boolean(d.allowHalfTurn),
      sizeLabel: d.sizeLabel,
      shape: d.shape
    }))
  };
}
