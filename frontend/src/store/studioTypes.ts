import type { SlittingProfile, SlittingWidthMode } from './studioSettings';

export interface ShapeGeometry {
  type: 'RECTANGLE' | 'POLYGON';
  width: number;
  height: number;
  vertices?: { x: number; y: number }[];
  holes?: { x: number; y: number }[][];
}

export interface DemandItem {
  id: number;
  name: string;
  width: number;
  length: number;
  quantity: number;
  orderedQty?: number;
  plannedQty?: number;
  completedQty?: number;
  allowRotation: boolean;
  allowHalfTurn?: boolean;
  shape?: ShapeGeometry;
  clusterId?: string;
  clusterName?: string;
  sourceTaskId?: string;
  sourceTaskName?: string;
  sourceLineId?: number;
  sizeLabel?: string;
  fabric?: string;
  surfaceTreatment?: string;
}

export interface ClusterTemplatePiece {
  name: string;
  fabric?: string;
  surfaceTreatment?: string;
  quantityPerUnit: number;
  pairMirror?: boolean;
  grainRule?: 'STRICT_0' | 'HALF_TURN_180' | 'FREE_90';
  sizes: Record<string, { w: number; h: number; v?: [number, number][] }>;
}

export interface DemandCluster {
  id: string;
  name: string;
  code: string;
  category: 'DXF_GARMENT' | 'CURTAIN_2D' | 'BOARD_2D' | 'SLITTING_1D';
  dimension: '2D' | '1D';
  subDimension?: 'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D';
  description: string;
  defaultWidthMm: number;
  defaultLengthMm: number;
  defaultSlitting?: {
    leftTrimMm: number;
    rightTrimMm: number;
    minWidthMm: number;
    maxWidthMm: number;
    widthStepMm: number;
    totalOverCap: number;
  };
  materialModel: string;
  availableSizes: string[];
  defaultSizeCounts: Record<string, number>;
  custom?: boolean;
  pieces: ClusterTemplatePiece[];
}

export interface StrategyJobRun {
  strategyId: string;
  strategyName: string;
  description: string;
  jobId?: string;
  state: 'IDLE' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'TIMED_OUT' | 'FAILED' | 'CANCELLED';
  phaseText: string;
  errorDetail?: string;
  elapsedMs?: number;
  occupiedLengthMm?: number;
  utilizationPct?: number;
  placedCount?: number;
  requestedCount?: number;
  complete?: boolean;
  request?: any;
  result?: any;
}

export type SavedSchemeCanvasMode2D = 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
export type CanvasMode2D = SavedSchemeCanvasMode2D | 'MULTI_MATERIAL';

export interface SchemeDefectSnapshot {
  id?: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin?: number;
  label?: string;
  typeName?: string;
  defectType?: string;
  /** 标记该疵点是否已完成工位窗口局部坐标裁切（margin 已展开为 0），避免画布二次外扩 */
  windowAligned?: boolean;
}

export interface MultiMaterialRunSummary {
  batchId: string;
  materialModel: string | null;
  totalRequestedPieces: number;
  placedByRemnants: number;
  placedByRoll: number;
  unplacedPieces: number;
  remnantCount: number;
  feasibleRollCount: number;
  recommendedRollId: string | null;
  totalSavedAreaM2: number;
  elapsedMs: number;
  warnings: string[];
  rawResponse: any;
}

export interface SavedScheme2D {
  id: string;
  title: string;
  strategyId?: string;
  strategyName: string;
  scenarioId?: string;
  createdAt: string;
  canvasMode: SavedSchemeCanvasMode2D;
  rollId?: string;
  remnantId?: string;
  windowStartY?: number;
  materialModel: string;
  widthMm: number;
  canvasLengthMm: number;
  occupiedLengthMm: number;
  utilizationPct: number;
  pieceAreaM2: number;
  placedCount: number;
  requestedCount: number;
  gapFillCount?: number;
  complete: boolean;
  demands: DemandItem[];
  request: any;
  result: any;
  /** 方案专属窗口疵点快照（多料联排每块料头/每卷母卷自带，切卡片时画布原生渲染） */
  defects?: SchemeDefectSnapshot[];
  /** 多料联排卡片角色 */
  multiMaterialRole?: 'REMNANT_RELAY' | 'ROLL_RECOMMENDED' | 'ROLL_ALTERNATIVE';
  /** 料头接力序号（从 1 开始） */
  multiMaterialRelayIndex?: number;
  /** 同批次多料联排标识 */
  multiMaterialBatchId?: string;
  /** 辅助展示字段：缸号 / 色号 / 料头排入明细 */
  batchNo?: string;
  color?: string;
  allocatedSummary?: string;
  layoutDirty?: boolean;
  layoutValidationErrors?: string[];
  dispatchedTaskId?: string;
  confirmedSchemeId?: string;
}

export interface SlittingOrderLine {
  id: string;
  name: string;
  widthMm: number;
  lengthMm: number;
  quantity: number;
  orderedQty?: number;
  plannedQty?: number;
  completedQty?: number;
  sourceTaskId?: string;
  sourceTaskName?: string;
  sourceLineId?: number;
  surfaceTreatment?: string;
}

export interface SlittingSchemeRun {
  id: string;
  strategyId: 'BASELINE' | 'FAST' | 'QUALITY';
  strategyName: string;
  state: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  totalCars: number;
  missingRolls: number;
  overproducedRolls: number;
  avgUtilizationPct: number;
  /** 后端换刀顺序优化器返回的预计换刀次数（未返回时为 null/undefined）。 */
  estimatedKnifeChanges?: number | null;
  /** 后端换刀顺序优化器返回的较原序节省换刀次数（未返回时为 null/undefined）。 */
  knifeChangesSaved?: number | null;
  elapsedMs?: number;
  errorMessage?: string;
  patterns: {
    id: string;
    lengthMm: number;
    repetitions: number;
    stations: { widthMm: number; countPerRepetition: number }[];
    usedWidthMm: number;
    spareWidthMm: number;
    surfaceTreatment?: string;
    allocations?: { orderId: string; quantity: number }[];
  }[];
  fulfillment: {
    orderId: string;
    name: string;
    widthMm: number;
    requested: number;
    produced: number;
    missing: number;
    overproduced: number;
  }[];
  rawResult?: any;
  dispatchedTaskId?: string;
  confirmedSchemeId?: string;
}

export interface DemandFamilySummary {
  id: string;
  name: string;
  materialModel: string;
  externalRef?: string;
  dimension: 'CONTOUR_2D' | 'RECT_2D' | 'SLITTING_1D';
  revision: number;
  orderedTotal: number;
  plannedTotal: number;
  completedTotal: number;
  openTotal: number;
  schemeCount: number;
  status: string;
  dueDate?: string;
  priority?: string;
  customerName?: string;
  kittingGroup?: string;
  requiredBatchNo?: string;
  requiredColor?: string;
  strictBatchMatch?: boolean;
  machineId?: string;
  shiftTeam?: string;
  process?: any;
  slitting?: any;
  lines: {
    id: number;
    name: string;
    width: number;
    length: number;
    orderedQty: number;
    plannedQty: number;
    completedQty: number;
    openQty: number;
    allowRotation?: boolean;
    allowHalfTurn?: boolean;
    sizeLabel?: string;
    sourceTemplateId?: string;
    surfaceTreatment?: string;
    shape?: ShapeGeometry;
  }[];
}

export type Scenario2DType = 'SHORTEN_KIT' | 'SHORTEN_GAP_FILL' | 'FIXED_BED' | 'MULTI_WIDTH';
export type Scenario1DType = 'MIN_CARS' | 'MAX_UTIL';

export interface WorkbenchLaunchPreset {
  canvasMode?: CanvasMode2D;
  canvasWidthMm?: number;
  canvasLengthMm?: number;
  selectedRollId?: string;
  selectedRemnantId?: string;
  multiPreferRemnants?: boolean;
  multiMaxRemnants?: number;
  multiCandidateRollIds?: string[];
  pieceGapMm?: number;
  trimStartMm?: number;
  scenario2D?: Scenario2DType;
  multiWidthsText2D?: string;
  slitMaterialMode?: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitMotherWidthMm?: number;
  slitLeftTrimMm?: number;
  slitRightTrimMm?: number;
  slitMinWidthMm?: number;
  slitMaxWidthMm?: number;
  slitWidthStepMm?: number;
  slitWidthMode?: SlittingWidthMode;
  slitProfile?: SlittingProfile;
  slitFixedLengthMm?: number;
  slitRollId?: string;
  slitOverCap?: number;
  slitMaxKnives?: number;
  slitMinBladeSpacingMm?: number;
  slitKerfMm?: number;
  slitForbiddenNarrowEdgeMinMm?: number;
  slitForbiddenNarrowEdgeMaxMm?: number;
  scenario1D?: Scenario1DType;
}

export interface CanvasSpecPatch {
  activeDimension?: '2D' | '1D';
  canvasMode?: CanvasMode2D;
  canvasWidthMm?: number;
  canvasLengthMm?: number;
  windowStartY2D?: number | null;
  pieceGapMm?: number;
  trimStartMm?: number;
  selectedRollId?: string;
  selectedRemnantId?: string;
  multiPreferRemnants?: boolean;
  multiMaxRemnants?: number;
  multiCandidateRollIds?: string[];
  multiMaterialSummary?: MultiMaterialRunSummary | null;
  materialModel2D?: string;
  loadedTaskId?: string | null;
  loadedTaskName?: string | null;
  loadedExternalRef?: string | null;
}

export interface WorkbenchDraftPayload {
  version: 1;
  taskKey: string;
  savedAt: string;
  activeDimension: '2D' | '1D';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  canvasMode: SavedSchemeCanvasMode2D;
  canvasWidthMm: number;
  canvasLengthMm: number;
  windowStartY2D: number | null;
  pieceGapMm: number;
  trimStartMm: number;
  selectedRollId: string;
  selectedRemnantId: string;
  materialModel2D: string;
  activeDemands2D: DemandItem[];
  /** 仅保存尚未确认入库的候选/手调方案，避免超出 localStorage 配额 */
  unconfirmedSchemes2D: SavedScheme2D[];
  activeSchemeId2D: string | null;

  // 1D 草稿状态
  scenario1D: Scenario1DType;
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitWidthMode: SlittingWidthMode;
  slitProfile: SlittingProfile;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitRollId: string;
  slitMaterialModel: string;
  slitOrders: SlittingOrderLine[];
}
