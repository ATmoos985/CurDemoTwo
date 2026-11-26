import { create } from 'zustand';
import {
  DXF_GARMENT_STYLES,
  parseDxfGarmentText,
  mirrorVerticesX
} from '../lib/nesting/dxf-garment-samples.js';
import { polygon, rectangle } from '../lib/canvas/nesting-scene.js';
import { LINEAR_SCENARIOS } from '../lib/domain/linear-scenarios.js';
import { requestJSON } from '../lib/core/util.js';
import {
  SlittingProfile,
  SlittingWidthMode,
  StudioSettings,
  loadStudioSettings,
  persistStudioSettings
} from './studioSettings';
import type { WorkbenchDraftPayload } from './workbenchDraft';

function finiteOr(val: unknown, fallback: number): number {
  if (val == null || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

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

export interface SavedScheme2D {
  id: string;
  title: string;
  strategyId?: string;
  strategyName: string;
  scenarioId?: string;
  createdAt: string;
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
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

const CUSTOM_CLUSTERS_KEY = 'cutplan.react.customClusters.v1';

function loadSavedCustomClusters(): DemandCluster[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CLUSTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomClusters(allClusters: DemandCluster[]) {
  try {
    localStorage.setItem(CUSTOM_CLUSTERS_KEY, JSON.stringify(allClusters.filter((c) => c.custom)));
  } catch {}
}

function createInitialClusters(): DemandCluster[] {
  const dxfClusters: DemandCluster[] = ['DXF_1226', 'DXF_20148D', 'DXF_3129'].map((styleId) => {
    const s = DXF_GARMENT_STYLES[styleId];
    const mainPieces = s.pieces.filter((p: any) => p.fabric === '面布');
    return {
      id: styleId,
      name: s.name,
      code: s.code,
      category: 'DXF_GARMENT',
      dimension: '2D',
      subDimension: 'CONTOUR_2D',
      description: s.description,
      defaultWidthMm: s.defaultWidth,
      defaultLengthMm: styleId === 'DXF_3129' ? 2400 : 1600,
      materialModel: s.materialModel,
      availableSizes: s.sizes,
      defaultSizeCounts:
        styleId === 'DXF_3129'
          ? { '110': 0, '120': 1, '130': 0, '140': 0, '150': 0, '160': 0 }
          : { '110': 0, '120': 1, '130': 0, '140': 1, '150': 0, '160': 0 },
      pieces: mainPieces.map((p: any) => ({
        name: p.name,
        fabric: p.fabric,
        quantityPerUnit: p.quantity,
        pairMirror: p.pairMirror,
        grainRule: 'STRICT_0',
        sizes: p.sizes
      }))
    };
  });

  const s1226 = DXF_GARMENT_STYLES.DXF_1226;
  const rib1226: DemandCluster = {
    id: 'DXF_1226_RIB',
    name: '1226 卫衣罗纹配套模板 (领/袖口/下摆)',
    code: 'F1CRH1226-RIB',
    category: 'DXF_GARMENT',
    dimension: '2D',
    subDimension: 'CONTOUR_2D',
    description: '1226.dxf 配套罗纹纸样模板：下摆×1、左右袖口×2、罗纹领×1（支持 110–160 码按套选配）',
    defaultWidthMm: 1500,
    defaultLengthMm: 1200,
    materialModel: 'DXF-1226-配套罗纹',
    availableSizes: s1226.sizes,
    defaultSizeCounts: { '110': 0, '120': 2, '130': 0, '140': 2, '150': 0, '160': 0 },
    pieces: s1226.pieces
      .filter((p: any) => p.fabric === '罗纹')
      .map((p: any) => ({
        name: p.name,
        fabric: p.fabric,
        quantityPerUnit: p.quantity,
        pairMirror: p.pairMirror,
        grainRule: 'STRICT_0',
        sizes: p.sizes
      }))
  };

  const curtainCluster: DemandCluster = {
    id: 'CLUSTER_CURTAIN_SUITE',
    name: '全屋窗帘主帘+辅件需求模板',
    code: 'CURTAIN-SUITE',
    category: 'CURTAIN_2D',
    dimension: '2D',
    subDimension: 'RECT_2D',
    description: '标准窗帘产品套系模板（落地主帘左/右片、飘窗短帘、定型绑带、同款抱枕套），支持标准高/挑空两档成套选配',
    defaultWidthMm: 2000,
    defaultLengthMm: 3600,
    materialModel: 'TC涤棉-B2026',
    availableSizes: ['标准2.6m高', '挑空3.2m高'],
    defaultSizeCounts: { '标准2.6m高': 1, '挑空3.2m高': 0 },
    pieces: [
      { name: '客厅双开主帘', quantityPerUnit: 2, grainRule: 'STRICT_0', sizes: { '标准2.6m高': { w: 1200, h: 1600 }, '挑空3.2m高': { w: 1400, h: 2200 } } },
      { name: '次卧飘窗短帘', quantityPerUnit: 2, grainRule: 'STRICT_0', sizes: { '标准2.6m高': { w: 600, h: 900 }, '挑空3.2m高': { w: 750, h: 1100 } } },
      { name: '定型绑带', quantityPerUnit: 4, grainRule: 'FREE_90', sizes: { '标准2.6m高': { w: 180, h: 750 }, '挑空3.2m高': { w: 200, h: 850 } } },
      { name: '同款沙发抱枕套', quantityPerUnit: 2, grainRule: 'FREE_90', sizes: { '标准2.6m高': { w: 450, h: 450 }, '挑空3.2m高': { w: 500, h: 500 } } }
    ]
  };

  const boardCluster: DemandCluster = {
    id: 'CLUSTER_CABINET_BOARD',
    name: '定制衣柜板材套板需求模板',
    code: 'CABINET-2440',
    category: 'BOARD_2D',
    dimension: '2D',
    subDimension: 'RECT_2D',
    description: '标准 1220×2440mm 板材开料套系模板（侧板、门板、层板、隔板、抽屉面板）',
    defaultWidthMm: 1220,
    defaultLengthMm: 2440,
    materialModel: '定制板材-1220',
    availableSizes: ['800宽柜体', '1000宽柜体'],
    defaultSizeCounts: { '800宽柜体': 1, '1000宽柜体': 0 },
    pieces: [
      { name: '柜体门板', quantityPerUnit: 1, grainRule: 'STRICT_0', sizes: { '800宽柜体': { w: 800, h: 1200 }, '1000宽柜体': { w: 960, h: 1200 } } },
      { name: '柜体侧板', quantityPerUnit: 3, grainRule: 'FREE_90', sizes: { '800宽柜体': { w: 600, h: 500 }, '1000宽柜体': { w: 600, h: 550 } } },
      { name: '层板', quantityPerUnit: 1, grainRule: 'FREE_90', sizes: { '800宽柜体': { w: 764, h: 396 }, '1000宽柜体': { w: 964, h: 396 } } },
      { name: '抽屉面板', quantityPerUnit: 1, grainRule: 'STRICT_0', sizes: { '800宽柜体': { w: 720, h: 396 }, '1000宽柜体': { w: 920, h: 396 } } },
      { name: '隔板', quantityPerUnit: 1, grainRule: 'FREE_90', sizes: { '800宽柜体': { w: 400, h: 396 }, '1000宽柜体': { w: 480, h: 396 } } }
    ]
  };

  const slittingFilmCluster: DemandCluster = {
    id: 'CLUSTER_SLIT_FILM',
    name: '光学膜同卷长分条需求模板 (4600mm母卷)',
    code: 'SLIT-FILM-4600',
    category: 'SLITTING_1D',
    dimension: '1D',
    subDimension: 'SLITTING_1D',
    description: '4 个客户同卷长 (2000mm) 不同条宽规格族模板，用于一维分切多组合套裁优化',
    defaultWidthMm: 4600,
    defaultLengthMm: 2000,
    defaultSlitting: {
      leftTrimMm: 100,
      rightTrimMm: 100,
      minWidthMm: 4200,
      maxWidthMm: 4400,
      widthStepMm: 10,
      totalOverCap: 30
    },
    materialModel: '光学膜-4600',
    availableSizes: ['标准批次'],
    defaultSizeCounts: { '标准批次': 1 },
    pieces: [
      { name: '客户A · 1080mm宽条', quantityPerUnit: 12, sizes: { '标准批次': { w: 1080, h: 2000 } } },
      { name: '客户B · 920mm宽条', quantityPerUnit: 15, sizes: { '标准批次': { w: 920, h: 2000 } } },
      { name: '客户C · 760mm宽条', quantityPerUnit: 18, sizes: { '标准批次': { w: 760, h: 2000 } } },
      { name: '客户D · 640mm宽条', quantityPerUnit: 10, sizes: { '标准批次': { w: 640, h: 2000 } } }
    ]
  };

  const slittingCurtainCluster: DemandCluster = {
    id: 'CLUSTER_SLIT_CURTAIN',
    name: '涂层面料定长分条模板 (2000mm母卷)',
    code: 'SLIT-CURTAIN-2000',
    category: 'SLITTING_1D',
    dimension: '1D',
    subDimension: 'SLITTING_1D',
    description: '宽窄条混搭一维分切模板（600mm / 700mm / 450mm），直接计算最优分条组合',
    defaultWidthMm: 2000,
    defaultLengthMm: 2000,
    defaultSlitting: {
      leftTrimMm: 10,
      rightTrimMm: 10,
      minWidthMm: 1800,
      maxWidthMm: 1980,
      widthStepMm: 10,
      totalOverCap: 8
    },
    materialModel: '涂层面料-2000',
    availableSizes: ['标准批次'],
    defaultSizeCounts: { '标准批次': 1 },
    pieces: [
      { name: '工程卷帘条 A (600mm)', quantityPerUnit: 10, sizes: { '标准批次': { w: 600, h: 2000 } } },
      { name: '工程卷帘条 B (700mm)', quantityPerUnit: 8, sizes: { '标准批次': { w: 700, h: 2000 } } },
      { name: '窄幅遮光条 C (450mm)', quantityPerUnit: 6, sizes: { '标准批次': { w: 450, h: 2000 } } }
    ]
  };

  const buildRealFilmSlitCluster = (
    scenarioKey: 'film-t29-50' | 'film-t10-17' | 'film-t29-85',
    id: string,
    name: string,
    code: string,
    materialModel: string,
    description: string
  ): DemandCluster => {
    const src = (LINEAR_SCENARIOS as any)[scenarioKey]?.input;
    const items: any[] = src?.orderItems || [];
    return {
      id,
      name,
      code,
      category: 'SLITTING_1D',
      dimension: '1D',
      subDimension: 'SLITTING_1D',
      description,
      defaultWidthMm: src?.motherWidth || 4600,
      defaultLengthMm: 1350000,
      defaultSlitting: {
        leftTrimMm: finiteOr(src?.leftTrim, 100),
        rightTrimMm: finiteOr(src?.rightTrim, 100),
        minWidthMm: finiteOr(src?.minWidth, 4200),
        maxWidthMm: finiteOr(src?.maxWidth, 4400),
        widthStepMm: finiteOr(src?.step, 10),
        totalOverCap: finiteOr(src?.totalOverCap, 30)
      },
      materialModel,
      availableSizes: ['标准批次'],
      defaultSizeCounts: { '标准批次': 1 },
      pieces: items.map((o) => ({
        name: o.messageText,
        surfaceTreatment: o.surfaceTreatment,
        quantityPerUnit: o.quantity,
        sizes: { '标准批次': { w: o.width, h: o.length * 1000 } }
      }))
    };
  };

  const slittingT2950Cluster = buildRealFilmSlitCluster(
    'film-t29-50',
    'CLUSTER_SLIT_T29_50',
    '反射膜 T29_DJY 实单分条模板 (50单·3111卷)',
    'SLIT-T29-50',
    '反射膜_T29_DJY_188',
    '188µm 反射膜 T29_DJY 50 条真实客户委托（宽 730–1480mm，长 1350m，不电晕/不涂布），4600mm 母卷合卷搭切'
  );

  const slittingT1017Cluster = buildRealFilmSlitCluster(
    'film-t10-17',
    'CLUSTER_SLIT_T10_17',
    '反射膜 T10_ESY 实单分条模板 (17单·591卷)',
    'SLIT-T10-17',
    '反射膜_T10_ESY_188',
    '188µm 反射膜 T10_ESY 17 条真实客户委托（宽 860–1480mm，长 1350m，不电晕/不涂布），4600mm 母卷合卷搭切'
  );

  const slittingT2985Cluster = buildRealFilmSlitCluster(
    'film-t29-85',
    'CLUSTER_SLIT_T29_85',
    '反射膜 T29_DJY 多客合单模板 (85单·2501卷)',
    'SLIT-T29-85',
    '反射膜_T29_DJY_188',
    '188µm 反射膜 T29_DJY 85 条多客户合单（宽 740–1480mm，长 1350m，不电晕/不涂布），大规模 4600mm 母卷搭切'
  );

  return [
    ...loadSavedCustomClusters(),
    ...dxfClusters,
    rib1226,
    curtainCluster,
    boardCluster,
    slittingFilmCluster,
    slittingT2950Cluster,
    slittingT1017Cluster,
    slittingT2985Cluster,
    slittingCurtainCluster
  ];
}

export function expandClusterToDemands(
  cluster: DemandCluster,
  sizeCounts: Record<string, number>,
  startId = 1
): DemandItem[] {
  const items: DemandItem[] = [];
  let nextId = startId;

  for (const [sizeKey, multiplier] of Object.entries(sizeCounts)) {
    const count = Math.floor(Number(multiplier) || 0);
    if (count <= 0) continue;

    for (const piece of cluster.pieces) {
      const geom = piece.sizes[sizeKey] || Object.values(piece.sizes)[0];
      if (!geom) continue;
      const allowFreeRot = piece.grainRule === 'FREE_90';
      const allowHalf = piece.grainRule === 'HALF_TURN_180';

      if (geom.v && geom.v.length >= 3) {
        const baseVerts = geom.v.map(([x, y]) => ({ x, y }));
        const baseShape = polygon(baseVerts) as ShapeGeometry;
        if (piece.pairMirror && piece.quantityPerUnit === 2) {
          const rightShape = polygon(mirrorVerticesX(baseVerts, geom.w)) as ShapeGeometry;
          items.push({
            id: nextId++,
            name: `${sizeKey}码 · ${piece.name}(左)`,
            width: baseShape.width,
            length: baseShape.height,
            quantity: count,
            allowRotation: allowFreeRot,
            allowHalfTurn: allowHalf,
            shape: baseShape,
            clusterId: cluster.id,
            clusterName: cluster.name,
            sizeLabel: sizeKey,
            fabric: piece.fabric
          });
          items.push({
            id: nextId++,
            name: `${sizeKey}码 · ${piece.name}(右)`,
            width: rightShape.width,
            length: rightShape.height,
            quantity: count,
            allowRotation: allowFreeRot,
            allowHalfTurn: allowHalf,
            shape: rightShape,
            clusterId: cluster.id,
            clusterName: cluster.name,
            sizeLabel: sizeKey,
            fabric: piece.fabric
          });
        } else {
          items.push({
            id: nextId++,
            name: `${sizeKey}码 · ${piece.name}`,
            width: baseShape.width,
            length: baseShape.height,
            quantity: piece.quantityPerUnit * count,
            allowRotation: allowFreeRot,
            allowHalfTurn: allowHalf,
            shape: baseShape,
            clusterId: cluster.id,
            clusterName: cluster.name,
            sizeLabel: sizeKey,
            fabric: piece.fabric
          });
        }
      } else {
        const rectShape = rectangle(geom.w, geom.h) as ShapeGeometry;
        items.push({
          id: nextId++,
          name: cluster.availableSizes.length > 1 ? `${sizeKey} · ${piece.name}` : piece.name,
          width: geom.w,
          length: geom.h,
          quantity: piece.quantityPerUnit * count,
          allowRotation: allowFreeRot,
          allowHalfTurn: allowHalf,
          shape: undefined,
          clusterId: cluster.id,
          clusterName: cluster.name,
          sizeLabel: sizeKey,
          ...(piece.surfaceTreatment ? { surfaceTreatment: piece.surfaceTreatment } : {})
        });
        void rectShape;
      }
    }
  }
  return items;
}

export interface WorkbenchLaunchPreset {
  canvasMode?: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  canvasWidthMm?: number;
  canvasLengthMm?: number;
  selectedRollId?: string;
  selectedRemnantId?: string;
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

interface StudioState {
  clusters: DemandCluster[];
  clusterSelections: Record<string, Record<string, number>>;

  // Unified Workbench Dimension & Scenario State
  activeDimension: '2D' | '1D';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  scenario1D: Scenario1DType;

  // 2D Studio State (defaults to FREE_CANVAS = Virtual New Mother Roll!)
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  canvasWidthMm: number;
  canvasLengthMm: number;
  /** 连续开卷可调起切点（mm），null 表示自动跟随实卷已切终点 usedLength */
  windowStartY2D: number | null;
  pieceGapMm: number;
  trimStartMm: number;
  selectedRollId: string;
  selectedRemnantId: string;
  materialModel2D: string;
  loadedTaskId: string | null;
  loadedTaskName: string | null;
  loadedExternalRef: string | null;
  mergedSourceTaskIds: string[];
  activeDemands2D: DemandItem[];
  selectedStrategies2D: string[];
  strategyRuns2D: StrategyJobRun[];
  schemes2D: SavedScheme2D[];
  activeSchemeId2D: string | null;

  // 1D Slitting Studio State
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
  /** 一维可选刀架物理硬约束（0 表示不限制，仅正值/有效禁区透传后端 SLITTING_1D） */
  slitMaxKnives: number;
  slitMinBladeSpacingMm: number;
  slitKerfMm: number;
  slitForbiddenNarrowEdgeMinMm: number;
  slitForbiddenNarrowEdgeMaxMm: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitRollId: string;
  slitMaterialModel: string;
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string | null;
  slitMergedSourceTaskIds: string[];
  slitOrders: SlittingOrderLine[];
  slitSchemes: SlittingSchemeRun[];
  activeSlitSchemeId: string | null;

  // Actions
  setActiveDimension: (dim: '2D' | '1D') => void;
  setScenario2D: (sc: Scenario2DType) => void;
  setMultiWidthsText2D: (txt: string) => void;
  setScenario1D: (sc: Scenario1DType) => void;
  syncTemplatesFromServer: () => Promise<void>;
  setClusterCount: (clusterId: string, sizeKey: string, count: number) => void;
  addCustomCluster: (cluster: DemandCluster) => void;
  deleteCustomCluster: (clusterId: string) => void;
  importDxfAsCluster: (text: string, fileName: string) => DemandCluster;
  loadClusterInto2D: (clusterId: string, append?: boolean) => void;
  loadSelectedClustersInto2D: (clusterIds: string[], append?: boolean) => void;
  loadDemandFamilyIntoWorkbench: (
    family: DemandFamilySummary,
    preset?: WorkbenchLaunchPreset
  ) => void;
  syncDemandFamilyProgress: (family: DemandFamilySummary) => void;
  syncMergedDemandFamiliesProgress: (families: DemandFamilySummary[]) => void;
  loadDemandFamiliesMergedIntoWorkbench: (families: DemandFamilySummary[]) => void;

  setCanvasSpec: (spec: Partial<{
    activeDimension: '2D' | '1D';
    canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
    canvasWidthMm: number;
    canvasLengthMm: number;
    windowStartY2D: number | null;
    pieceGapMm: number;
    trimStartMm: number;
    selectedRollId: string;
    selectedRemnantId: string;
    materialModel2D: string;
    loadedTaskId: string | null;
    loadedTaskName: string | null;
    loadedExternalRef: string | null;
  }>) => void;
  restoreWorkbenchDraft: (draft: WorkbenchDraftPayload) => void;
  setActiveDemands2D: (demands: DemandItem[]) => void;
  updateDemand2D: (id: number, patch: Partial<DemandItem>) => void;
  removeDemand2D: (id: number) => void;
  addBlankDemand2D: () => void;
  toggleStrategy2D: (strategyId: string) => void;
  setStrategyRuns2D: (runs: StrategyJobRun[] | ((prev: StrategyJobRun[]) => StrategyJobRun[])) => void;
  addSchemes2D: (
    newSchemes: SavedScheme2D[],
    options?: { selectIfBetter?: boolean; batchIds?: ReadonlySet<string> }
  ) => void;
  removeScheme2D: (id: string) => void;
  clearSchemes2D: () => void;
  setActiveScheme2D: (id: string | null) => void;
  markSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId?: string) => void;

  // 1D Actions
  loadClusterInto1D: (clusterId: string, append?: boolean) => void;
  setSlitSpec: (spec: Partial<StudioState>) => void;
  updateSlitOrder: (id: string, patch: Partial<SlittingOrderLine>) => void;
  addSlitOrder: () => void;
  removeSlitOrder: (id: string) => void;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  setActiveSlitScheme: (id: string | null) => void;
  markSlitSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId?: string) => void;

  // Global Studio Settings
  settings: StudioSettings;
  updateStudioSettings: (next: StudioSettings) => StudioSettings;
}

const initialSettings = loadStudioSettings();
const initialClusters = createInitialClusters();
const initialSelectionMap: Record<string, Record<string, number>> = {};
for (const c of initialClusters) {
  initialSelectionMap[c.id] = { ...c.defaultSizeCounts };
}

const defaultCluster2D = initialClusters.find((c) => c.id === 'DXF_1226') || initialClusters[0];
const defaultDemands2D = expandClusterToDemands(defaultCluster2D, defaultCluster2D.defaultSizeCounts, 1);
const defaultSlitCluster = initialClusters.find((c) => c.id === 'CLUSTER_SLIT_FILM')!;

export const useStudioStore = create<StudioState>((set, get) => ({
  clusters: initialClusters,
  clusterSelections: initialSelectionMap,

  activeDimension: '2D',
  scenario2D: 'SHORTEN_KIT',
  multiWidthsText2D: '1500, 1650, 1800',
  scenario1D: 'MIN_CARS',

  canvasMode: 'FREE_CANVAS',
  canvasWidthMm: defaultCluster2D.defaultWidthMm,
  canvasLengthMm: defaultCluster2D.defaultLengthMm,
  windowStartY2D: null,
  pieceGapMm: initialSettings.pieceGapMm,
  trimStartMm: initialSettings.trimStartMm,
  selectedRollId: 'ROLL-2026-0920',
  selectedRemnantId: '',
  materialModel2D: defaultCluster2D.materialModel,
  loadedTaskId: null,
  loadedTaskName: null,
  loadedExternalRef: null,
  mergedSourceTaskIds: [],
  activeDemands2D: defaultDemands2D,
  selectedStrategies2D: [...initialSettings.enabledStrategies2D],
  strategyRuns2D: [],
  schemes2D: [],
  activeSchemeId2D: null,

  slitMaterialMode: 'VIRTUAL_ROLL',
  slitWidthMode: 'FLEXIBLE',
  slitProfile: initialSettings.slitProfile,
  slitMotherWidthMm: 4600,
  slitLeftTrimMm: 100,
  slitRightTrimMm: 100,
  slitMinWidthMm: 4300,
  slitMaxWidthMm: 4400,
  slitWidthStepMm: 10,
  slitOverCap: 30,
  slitMaxKnives: 0,
  slitMinBladeSpacingMm: 0,
  slitKerfMm: 0,
  slitForbiddenNarrowEdgeMinMm: 0,
  slitForbiddenNarrowEdgeMaxMm: 0,
  slitFixedLengthMm: 2000,
  slitAvoidDefects: false,
  slitRollId: '',
  slitMaterialModel: defaultSlitCluster.materialModel,
  slitLoadedTaskId: null,
  slitLoadedTaskName: null,
  slitMergedSourceTaskIds: [],
  slitOrders: defaultSlitCluster.pieces.map((p, idx) => ({
    id: String(idx + 1),
    name: p.name,
    widthMm: Object.values(p.sizes)[0].w,
    lengthMm: Object.values(p.sizes)[0].h,
    quantity: p.quantityPerUnit
  })),
  slitSchemes: [],
  activeSlitSchemeId: null,

  setActiveDimension: (dim) => set({ activeDimension: dim }),
  setScenario2D: (sc) => set({ scenario2D: sc }),
  setMultiWidthsText2D: (txt) => set({ multiWidthsText2D: txt }),
  setScenario1D: (sc) => set({ scenario1D: sc }),

  syncTemplatesFromServer: async () => {
    try {
      const serverTpls: any[] = await requestJSON('/api/v2/demand-templates');
      if (!Array.isArray(serverTpls) || serverTpls.length === 0) return;
      const mapped: DemandCluster[] = serverTpls.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code || t.id,
        category: t.category || (t.dimension === 'SLITTING_1D' ? 'SLITTING_1D' : 'CURTAIN_2D'),
        dimension: t.dimension === 'SLITTING_1D' ? '1D' : '2D',
        subDimension: t.dimension,
        description: t.description || '',
        defaultWidthMm: Number(t.defaultWidthMm) || 1650,
        defaultLengthMm: Number(t.defaultLengthMm) || 2000,
        materialModel: t.materialModel || 'STANDARD',
        availableSizes: Array.isArray(t.availableSizes) && t.availableSizes.length ? t.availableSizes : ['标准规格'],
        defaultSizeCounts: t.defaultSizeCounts || { 标准规格: 1 },
        custom: true,
        pieces: (t.pieces || []).map((p: any) => ({
          name: p.name,
          fabric: p.fabric,
          quantityPerUnit: p.quantityPerUnit || 1,
          pairMirror: Boolean(p.pairMirror),
          grainRule: p.grainRule || 'STRICT_0',
          sizes: p.sizes || {}
        }))
      }));
      set((st) => {
        const serverIds = new Set(mapped.map((m) => m.id));
        const builtinsAndLocal = st.clusters.filter((c) => !serverIds.has(c.id));
        const nextSel = { ...st.clusterSelections };
        for (const m of mapped) {
          if (!nextSel[m.id]) nextSel[m.id] = { ...m.defaultSizeCounts };
        }
        return {
          clusters: [...mapped, ...builtinsAndLocal],
          clusterSelections: nextSel
        };
      });
    } catch {}
  },

  setClusterCount: (clusterId, sizeKey, count) =>
    set((st) => ({
      clusterSelections: {
        ...st.clusterSelections,
        [clusterId]: {
          ...(st.clusterSelections[clusterId] || {}),
          [sizeKey]: Math.max(0, Math.floor(count || 0))
        }
      }
    })),

  addCustomCluster: (cluster) => {
    const withFlag: DemandCluster = { ...cluster, custom: true };
    set((st) => {
      const next = [withFlag, ...st.clusters.filter((c) => c.id !== withFlag.id)];
      saveCustomClusters(next);
      return {
        clusters: next,
        clusterSelections: {
          ...st.clusterSelections,
          [withFlag.id]: { ...withFlag.defaultSizeCounts }
        }
      };
    });
    // Persist custom template to backend asynchronously
    requestJSON('/api/v2/demand-templates', {
      id: withFlag.id,
      code: withFlag.code,
      name: withFlag.name,
      category: withFlag.category,
      dimension:
        withFlag.subDimension ||
        (withFlag.dimension === '1D'
          ? 'SLITTING_1D'
          : withFlag.category === 'DXF_GARMENT'
          ? 'CONTOUR_2D'
          : 'RECT_2D'),
      description: withFlag.description,
      defaultWidthMm: withFlag.defaultWidthMm,
      defaultLengthMm: withFlag.defaultLengthMm,
      materialModel: withFlag.materialModel,
      availableSizes: withFlag.availableSizes,
      defaultSizeCounts: withFlag.defaultSizeCounts,
      custom: true,
      pieces: withFlag.pieces
    }).catch(() => {});
  },

  deleteCustomCluster: (clusterId) => {
    set((st) => {
      const next = st.clusters.filter((c) => c.id !== clusterId || !c.custom);
      saveCustomClusters(next);
      return { clusters: next };
    });
    fetch('/api/v2/demand-templates/' + encodeURIComponent(clusterId), { method: 'DELETE' }).catch(() => {});
  },

  importDxfAsCluster: (text, fileName) => {
    const parsed = parseDxfGarmentText(text, fileName);
    const baseCode = fileName.replace(/\.dxf$/i, '').toUpperCase();
    const id = 'DXF_CUSTOM_' + baseCode + '_' + Date.now().toString(36).slice(-4);
    const pieceMap = new Map<string, ClusterTemplatePiece>();
    const sizesSet = new Set<string>();

    for (const g of parsed.groups) {
      const sizeMatch = String(g.fabricCode || '').match(/-(\S+)码$/);
      const sz = sizeMatch ? sizeMatch[1] : '均码';
      sizesSet.add(sz);
      for (const d of g.demands) {
        if (d.name.endsWith('(右)')) continue;
        const isLeft = d.name.endsWith('(左)');
        const cleanName = d.name.replace(/^\S+码\s*·\s*/, '').replace(/\((左|右)\)$/, '');
        if (!pieceMap.has(cleanName)) {
          pieceMap.set(cleanName, {
            name: cleanName,
            fabric: '面布',
            quantityPerUnit: isLeft ? 2 : d.quantity,
            pairMirror: isLeft,
            grainRule: 'STRICT_0',
            sizes: {}
          });
        }
        pieceMap.get(cleanName)!.sizes[sz] = {
          w: d.width,
          h: d.length,
          v: d.shape?.vertices?.map((pt: any) => [pt.x, pt.y])
        };
      }
    }
    const availableSizes = [...sizesSet];
    const defaultSizeCounts: Record<string, number> = {};
    availableSizes.forEach((s, i) => {
      defaultSizeCounts[s] = i < 2 ? 1 : 0;
    });

    const newCluster: DemandCluster = {
      id,
      name: `${baseCode} 导入纸样模板 (DXF)`,
      code: baseCode,
      category: 'DXF_GARMENT',
      dimension: '2D',
      subDimension: 'CONTOUR_2D',
      description: `从 ${fileName} 解析的 CAD 纸样需求模板（共 ${pieceMap.size} 种裁片，尺码 ${availableSizes.join('/')}）`,
      defaultWidthMm: 1650,
      defaultLengthMm: 2000,
      materialModel: `DXF-${baseCode}`,
      availableSizes,
      defaultSizeCounts,
      custom: true,
      pieces: [...pieceMap.values()]
    };
    get().addCustomCluster(newCluster);
    return newCluster;
  },

  loadClusterInto2D: (clusterId, append = false) => {
    const st = get();
    const cluster = st.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const counts = st.clusterSelections[clusterId] || cluster.defaultSizeCounts;
    const hasPositive = Object.values(counts).some((v) => v > 0);
    const effectiveCounts = hasPositive ? counts : { [cluster.availableSizes[0]]: 1 };
    const startId = append ? st.activeDemands2D.reduce((m, d) => Math.max(m, d.id), 0) + 1 : 1;
    const expanded = expandClusterToDemands(cluster, effectiveCounts, startId);
    set({
      activeDimension: '2D',
      loadedTaskId: append ? st.loadedTaskId : null,
      loadedTaskName: append ? st.loadedTaskName : null,
      loadedExternalRef: append ? st.loadedExternalRef : null,
      mergedSourceTaskIds: append ? st.mergedSourceTaskIds : [],
      activeDemands2D: append ? [...st.activeDemands2D, ...expanded] : expanded,
      canvasWidthMm: append ? st.canvasWidthMm : cluster.defaultWidthMm,
      canvasLengthMm: append ? st.canvasLengthMm : cluster.defaultLengthMm,
      materialModel2D: append ? st.materialModel2D : cluster.materialModel,
      ...(append ? {} : { activeSchemeId2D: null, schemes2D: [] })
    });
  },

  loadSelectedClustersInto2D: (clusterIds, append = false) => {
    const st = get();
    const chosen1D = clusterIds
      .map((id) => st.clusters.find((c) => c.id === id))
      .filter((c): c is DemandCluster => Boolean(c && c.dimension === '1D'));
    const chosen2D = clusterIds
      .map((id) => st.clusters.find((c) => c.id === id))
      .filter((c): c is DemandCluster => Boolean(c && c.dimension === '2D'));

    if (chosen2D.length === 0 && chosen1D.length > 0) {
      get().loadClusterInto1D(chosen1D[0].id, false);
      for (let i = 1; i < chosen1D.length; i++) {
        get().loadClusterInto1D(chosen1D[i].id, true);
      }
      return;
    }

    let list: DemandItem[] = append ? [...st.activeDemands2D] : [];
    let nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    let firstCluster: DemandCluster | null = null;
    for (const cluster of chosen2D) {
      if (!firstCluster) firstCluster = cluster;
      const counts = st.clusterSelections[cluster.id] || cluster.defaultSizeCounts;
      const effectiveCounts = Object.values(counts).some((v) => v > 0)
        ? counts
        : { [cluster.availableSizes[0]]: 1 };
      const items = expandClusterToDemands(cluster, effectiveCounts, nextId);
      list = [...list, ...items];
      nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    }
    if (list.length) {
      set({
        activeDimension: '2D',
        loadedTaskId: null,
        loadedTaskName: null,
        loadedExternalRef: null,
        mergedSourceTaskIds: [],
        activeDemands2D: list,
        ...(firstCluster && !append
          ? {
              canvasWidthMm: firstCluster.defaultWidthMm,
              canvasLengthMm: firstCluster.defaultLengthMm,
              materialModel2D: firstCluster.materialModel,
              activeSchemeId2D: null,
              schemes2D: []
            }
          : {})
      });
    }
  },

  loadDemandFamilyIntoWorkbench: (family, preset) => {
    const allLines = family.lines;
    if (family.dimension === 'SLITTING_1D') {
      const sp = family.slitting || {};
      const lt = preset?.slitLeftTrimMm ?? finiteOr(sp.leftTrim, 100);
      const rt = preset?.slitRightTrimMm ?? finiteOr(sp.rightTrim, 100);
      const rawMaxW = preset?.slitMaxWidthMm ?? finiteOr(sp.maxWidth, 4400);
      const motherW = preset?.slitMotherWidthMm ?? Math.max(rawMaxW + lt + rt, 500);
      const usableW = Math.max(200, motherW - lt - rt);
      const maxW = Math.min(usableW, Math.max(200, rawMaxW));
      const defaultMinW = Math.min(maxW, Math.max(100, Math.floor((maxW * 0.95) / 10) * 10));
      const minW = Math.min(
        maxW,
        Math.max(100, preset?.slitMinWidthMm ?? finiteOr(sp.minWidth, defaultMinW))
      );
      const stepW = Math.max(1, preset?.slitWidthStepMm ?? finiteOr(sp.widthStep, 10));
      const overCap = Math.max(0, preset?.slitOverCap ?? finiteOr(sp.totalOverCap, 30));
      const fixedLen =
        preset?.slitFixedLengthMm ??
        (allLines[0]?.length || finiteOr(family.process?.bedLength, 2000));
      const widthMode: SlittingWidthMode =
        preset?.slitWidthMode ?? (minW === maxW ? 'FIXED' : 'FLEXIBLE');
      set({
        activeDimension: '1D',
        slitLoadedTaskId: family.id,
        slitLoadedTaskName: family.name,
        slitMergedSourceTaskIds: [],
        slitMaterialModel: family.materialModel,
        slitMaterialMode: preset?.slitMaterialMode ?? 'VIRTUAL_ROLL',
        slitWidthMode: widthMode,
        ...(preset?.slitProfile ? { slitProfile: preset.slitProfile } : {}),
        slitRollId: preset?.slitRollId ?? get().slitRollId,
        slitAvoidDefects: preset?.slitMaterialMode === 'STOCK_ROLL',
        slitMotherWidthMm: motherW,
        slitLeftTrimMm: lt,
        slitRightTrimMm: rt,
        slitMinWidthMm: widthMode === 'FIXED' ? maxW : minW,
        slitMaxWidthMm: maxW,
        slitWidthStepMm: stepW,
        slitOverCap: overCap,
        slitMaxKnives: Math.max(0, preset?.slitMaxKnives ?? finiteOr(sp.maxKnives, 0)),
        slitMinBladeSpacingMm: Math.max(
          0,
          preset?.slitMinBladeSpacingMm ?? finiteOr(sp.minBladeSpacingMm, 0)
        ),
        slitKerfMm: Math.max(0, preset?.slitKerfMm ?? finiteOr(sp.kerfMm, 0)),
        slitForbiddenNarrowEdgeMinMm: Math.max(
          0,
          preset?.slitForbiddenNarrowEdgeMinMm ?? finiteOr(sp.forbiddenNarrowEdgeMinMm, 0)
        ),
        slitForbiddenNarrowEdgeMaxMm: Math.max(
          0,
          preset?.slitForbiddenNarrowEdgeMaxMm ?? finiteOr(sp.forbiddenNarrowEdgeMaxMm, 0)
        ),
        slitFixedLengthMm: fixedLen,
        ...(preset?.scenario1D ? { scenario1D: preset.scenario1D } : {}),
        slitOrders: allLines.map((l) => ({
          id: String(l.id),
          name: l.name,
          widthMm: l.width,
          lengthMm: l.length,
          quantity: l.openQty,
          orderedQty: l.orderedQty,
          plannedQty: l.plannedQty,
          completedQty: l.completedQty,
          sourceTaskId: family.id,
          sourceTaskName: family.name,
          sourceLineId: l.id,
          surfaceTreatment: l.surfaceTreatment
        })),
        slitSchemes: [],
        activeSlitSchemeId: null
      });
    } else {
      const mappedDemands = allLines.map((l) => ({
        id: l.id,
        name: l.name,
        width: l.width,
        length: l.length,
        quantity: l.openQty,
        orderedQty: l.orderedQty,
        plannedQty: l.plannedQty,
        completedQty: l.completedQty,
        allowRotation: Boolean(l.allowRotation),
        allowHalfTurn: Boolean(l.allowHalfTurn),
        shape: l.shape,
        clusterName: family.name,
        sourceTaskId: family.id,
        sourceTaskName: family.name,
        sourceLineId: l.id,
        sizeLabel: l.sizeLabel
      }));
      const targetW = preset?.canvasWidthMm || get().canvasWidthMm || 1650;
      const openOrFullArea = mappedDemands.reduce(
        (s, d) => s + d.width * d.length * (d.quantity > 0 ? d.quantity : d.orderedQty || 1),
        0
      );
      const estLen = Math.ceil(openOrFullArea / Math.max(400, targetW * 0.65) / 500) * 500;
      set({
        activeDimension: '2D',
        loadedTaskId: family.id,
        loadedTaskName: family.name,
        loadedExternalRef: family.externalRef || null,
        mergedSourceTaskIds: [],
        materialModel2D: family.materialModel,
        canvasMode: preset?.canvasMode ?? 'FREE_CANVAS',
        canvasWidthMm: targetW,
        canvasLengthMm:
          preset?.canvasLengthMm ?? Math.max(Number(family.process?.bedLength) || 2400, estLen, 1500),
        ...(preset?.selectedRollId !== undefined ? { selectedRollId: preset.selectedRollId } : {}),
        ...(preset?.selectedRemnantId !== undefined
          ? { selectedRemnantId: preset.selectedRemnantId }
          : {}),
        pieceGapMm: preset?.pieceGapMm ?? (Number(family.process?.pieceGap) || 0),
        trimStartMm: preset?.trimStartMm ?? (Number(family.process?.trimStart) || 0),
        ...(preset?.scenario2D ? { scenario2D: preset.scenario2D } : {}),
        ...(preset?.multiWidthsText2D !== undefined
          ? { multiWidthsText2D: preset.multiWidthsText2D }
          : {}),
        activeDemands2D: mappedDemands,
        schemes2D: [],
        activeSchemeId2D: null
      });
    }
  },

  syncDemandFamilyProgress: (family) => {
    if (family.dimension === 'SLITTING_1D') {
      set({
        slitLoadedTaskId: family.id,
        slitLoadedTaskName: family.name,
        slitMergedSourceTaskIds: [],
        slitOrders: family.lines.map((l) => ({
          id: String(l.id),
          name: l.name,
          widthMm: l.width,
          lengthMm: l.length,
          quantity: l.openQty,
          orderedQty: l.orderedQty,
          plannedQty: l.plannedQty,
          completedQty: l.completedQty,
          sourceTaskId: family.id,
          sourceTaskName: family.name,
          sourceLineId: l.id,
          surfaceTreatment: l.surfaceTreatment
        }))
      });
    } else {
      set({
        loadedTaskId: family.id,
        loadedTaskName: family.name,
        loadedExternalRef: family.externalRef || null,
        mergedSourceTaskIds: [],
        activeDemands2D: family.lines.map((l) => ({
          id: l.id,
          name: l.name,
          width: l.width,
          length: l.length,
          quantity: l.openQty,
          orderedQty: l.orderedQty,
          plannedQty: l.plannedQty,
          completedQty: l.completedQty,
          allowRotation: Boolean(l.allowRotation),
          allowHalfTurn: Boolean(l.allowHalfTurn),
          shape: l.shape,
          clusterName: family.name,
          sourceTaskId: family.id,
          sourceTaskName: family.name,
          sourceLineId: l.id,
          sizeLabel: l.sizeLabel
        }))
      });
    }
  },

  syncMergedDemandFamiliesProgress: (families) => {
    const familyById = new Map<string, DemandFamilySummary>();
    for (const f of families) {
      familyById.set(f.id, f);
    }
    set((st) => {
      const nextDemands2D = st.activeDemands2D.map((d) => {
        if (!d.sourceTaskId || d.sourceLineId == null) return d;
        const fam = familyById.get(d.sourceTaskId);
        const ln = fam?.lines.find((l) => l.id === d.sourceLineId);
        if (!ln) return d;
        return {
          ...d,
          quantity: ln.openQty,
          orderedQty: ln.orderedQty,
          plannedQty: ln.plannedQty,
          completedQty: ln.completedQty
        };
      });
      const nextSlitOrders = st.slitOrders.map((o) => {
        if (!o.sourceTaskId || o.sourceLineId == null) return o;
        const fam = familyById.get(o.sourceTaskId);
        const ln = fam?.lines.find((l) => l.id === o.sourceLineId);
        if (!ln) return o;
        return {
          ...o,
          quantity: ln.openQty,
          orderedQty: ln.orderedQty,
          plannedQty: ln.plannedQty,
          completedQty: ln.completedQty
        };
      });
      return {
        activeDemands2D: nextDemands2D,
        slitOrders: nextSlitOrders
      };
    });
  },

  loadDemandFamiliesMergedIntoWorkbench: (families) => {
    if (!families.length) return;
    if (families.length === 1) {
      get().loadDemandFamilyIntoWorkbench(families[0]);
      return;
    }
    const first = families[0];
    if (first.dimension === 'SLITTING_1D') {
      let nextId = 1;
      const orders: SlittingOrderLine[] = [];
      const includedIds: string[] = [];
      for (const fam of families) {
        if (fam.dimension !== 'SLITTING_1D') continue;
        let hasOpen = false;
        for (const l of fam.lines) {
          if (l.openQty <= 0) continue;
          hasOpen = true;
          orders.push({
            id: String(nextId++),
            name: `${fam.name} · ${l.name}`,
            widthMm: l.width,
            lengthMm: l.length,
            quantity: l.openQty,
            orderedQty: l.orderedQty,
            plannedQty: l.plannedQty,
            completedQty: l.completedQty,
            sourceTaskId: fam.id,
            sourceTaskName: fam.name,
            sourceLineId: l.id,
            surfaceTreatment: l.surfaceTreatment
          });
        }
        if (hasOpen) includedIds.push(fam.id);
      }
      const sp = first.slitting || {};
      const maxW = finiteOr(sp.maxWidth, 4400);
      const lt = finiteOr(sp.leftTrim, 100);
      const rt = finiteOr(sp.rightTrim, 100);
      const minW = Math.min(maxW, finiteOr(sp.minWidth, Math.floor((maxW * 0.95) / 10) * 10));
      set({
        activeDimension: '1D',
        slitLoadedTaskId: null,
        slitLoadedTaskName: `多族合排 (${families.length} 族 · ${first.materialModel})`,
        slitMergedSourceTaskIds: includedIds,
        slitMaterialModel: first.materialModel,
        slitWidthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
        slitMotherWidthMm: maxW + lt + rt,
        slitLeftTrimMm: lt,
        slitRightTrimMm: rt,
        slitMaxWidthMm: maxW,
        slitMinWidthMm: minW,
        slitWidthStepMm: Math.max(1, finiteOr(sp.widthStep, 10)),
        slitOverCap: Math.max(0, finiteOr(sp.totalOverCap, 30)),
        slitFixedLengthMm: orders[0]?.lengthMm || 2000,
        slitOrders: orders,
        slitSchemes: [],
        activeSlitSchemeId: null
      });
    } else {
      let nextId = 1;
      const demands: DemandItem[] = [];
      const includedIds: string[] = [];
      for (const fam of families) {
        if (fam.dimension === 'SLITTING_1D') continue;
        let hasOpen = false;
        for (const l of fam.lines) {
          if (l.openQty <= 0) continue;
          hasOpen = true;
          demands.push({
            id: nextId++,
            name: `${fam.name} · ${l.name}`,
            width: l.width,
            length: l.length,
            quantity: l.openQty,
            orderedQty: l.orderedQty,
            plannedQty: l.plannedQty,
            completedQty: l.completedQty,
            allowRotation: Boolean(l.allowRotation),
            allowHalfTurn: Boolean(l.allowHalfTurn),
            shape: l.shape,
            clusterName: fam.name,
            sourceTaskId: fam.id,
            sourceTaskName: fam.name,
            sourceLineId: l.id,
            sizeLabel: l.sizeLabel
          });
        }
        if (hasOpen) includedIds.push(fam.id);
      }
      set({
        activeDimension: '2D',
        loadedTaskId: null,
        loadedTaskName: `多族合排 (${families.length} 族 · ${first.materialModel})`,
        loadedExternalRef: families.map((f) => f.externalRef || f.name).join(' + '),
        mergedSourceTaskIds: includedIds,
        materialModel2D: first.materialModel,
        activeDemands2D: demands,
        schemes2D: [],
        activeSchemeId2D: null
      });
    }
  },

  setCanvasSpec: (spec) => set((st) => ({ ...st, ...spec })),

  restoreWorkbenchDraft: (draft) =>
    set((st) => ({
      activeDimension: draft.activeDimension || st.activeDimension,
      scenario2D: draft.scenario2D || st.scenario2D,
      multiWidthsText2D: draft.multiWidthsText2D ?? st.multiWidthsText2D,
      canvasMode: draft.canvasMode || st.canvasMode,
      canvasWidthMm: Number(draft.canvasWidthMm) > 0 ? draft.canvasWidthMm : st.canvasWidthMm,
      canvasLengthMm: Number(draft.canvasLengthMm) > 0 ? draft.canvasLengthMm : st.canvasLengthMm,
      windowStartY2D: draft.windowStartY2D ?? null,
      pieceGapMm: Number.isFinite(draft.pieceGapMm) ? draft.pieceGapMm : st.pieceGapMm,
      trimStartMm: Number.isFinite(draft.trimStartMm) ? draft.trimStartMm : st.trimStartMm,
      selectedRollId: draft.selectedRollId ?? st.selectedRollId,
      selectedRemnantId: draft.selectedRemnantId ?? st.selectedRemnantId,
      materialModel2D: draft.materialModel2D || st.materialModel2D,
      activeDemands2D:
        Array.isArray(draft.activeDemands2D) && draft.activeDemands2D.length > 0
          ? draft.activeDemands2D
          : st.activeDemands2D,
      schemes2D: Array.isArray(draft.unconfirmedSchemes2D)
        ? draft.unconfirmedSchemes2D
        : st.schemes2D,
      activeSchemeId2D: draft.activeSchemeId2D ?? draft.unconfirmedSchemes2D?.[0]?.id ?? null,
      scenario1D: draft.scenario1D || st.scenario1D,
      slitMaterialMode: draft.slitMaterialMode || st.slitMaterialMode,
      slitWidthMode: draft.slitWidthMode || st.slitWidthMode,
      slitProfile: draft.slitProfile || st.slitProfile,
      slitMotherWidthMm:
        Number(draft.slitMotherWidthMm) > 0 ? draft.slitMotherWidthMm : st.slitMotherWidthMm,
      slitLeftTrimMm: Number.isFinite(draft.slitLeftTrimMm) ? draft.slitLeftTrimMm : st.slitLeftTrimMm,
      slitRightTrimMm: Number.isFinite(draft.slitRightTrimMm)
        ? draft.slitRightTrimMm
        : st.slitRightTrimMm,
      slitMinWidthMm: Number(draft.slitMinWidthMm) > 0 ? draft.slitMinWidthMm : st.slitMinWidthMm,
      slitMaxWidthMm: Number(draft.slitMaxWidthMm) > 0 ? draft.slitMaxWidthMm : st.slitMaxWidthMm,
      slitWidthStepMm:
        Number(draft.slitWidthStepMm) > 0 ? draft.slitWidthStepMm : st.slitWidthStepMm,
      slitOverCap: Number.isFinite(draft.slitOverCap) ? draft.slitOverCap : st.slitOverCap,
      slitFixedLengthMm:
        Number(draft.slitFixedLengthMm) > 0 ? draft.slitFixedLengthMm : st.slitFixedLengthMm,
      slitAvoidDefects:
        typeof draft.slitAvoidDefects === 'boolean' ? draft.slitAvoidDefects : st.slitAvoidDefects,
      slitRollId: draft.slitRollId ?? st.slitRollId,
      slitMaterialModel: draft.slitMaterialModel || st.slitMaterialModel,
      slitOrders:
        Array.isArray(draft.slitOrders) && draft.slitOrders.length > 0
          ? draft.slitOrders
          : st.slitOrders
    })),

  setActiveDemands2D: (demands) => set({ activeDemands2D: demands }),

  updateDemand2D: (id, patch) =>
    set((st) => ({
      activeDemands2D: st.activeDemands2D.map((d) => (d.id === id ? { ...d, ...patch } : d))
    })),

  removeDemand2D: (id) =>
    set((st) => ({
      activeDemands2D: st.activeDemands2D.filter((d) => d.id !== id)
    })),

  addBlankDemand2D: () =>
    set((st) => {
      const nextId = st.activeDemands2D.reduce((m, d) => Math.max(m, d.id), 0) + 1;
      return {
        activeDemands2D: [
          ...st.activeDemands2D,
          {
            id: nextId,
            name: `自定义规格件 #${nextId}`,
            width: 500,
            length: 800,
            quantity: 2,
            allowRotation: Boolean(st.settings.defaultAllowRotation),
            clusterName: '手动录入'
          }
        ]
      };
    }),

  toggleStrategy2D: (strategyId) =>
    set((st) => {
      const exists = st.selectedStrategies2D.includes(strategyId);
      if (exists && st.selectedStrategies2D.length <= 1) return st;
      const nextStrategies = exists
        ? st.selectedStrategies2D.filter((id) => id !== strategyId)
        : [...st.selectedStrategies2D, strategyId];
      const saved = persistStudioSettings({
        ...st.settings,
        enabledStrategies2D: nextStrategies
      });
      return {
        settings: saved,
        selectedStrategies2D: [...saved.enabledStrategies2D]
      };
    }),

  setStrategyRuns2D: (runs) =>
    set((st) => ({
      strategyRuns2D: typeof runs === 'function' ? runs(st.strategyRuns2D) : runs
    })),

  addSchemes2D: (newSchemes, options) =>
    set((st) => {
      if (!newSchemes.length) return st;
      const merged = [...newSchemes, ...st.schemes2D];
      const completeOnes = newSchemes.filter((x) => x.complete);
      const pool = completeOnes.length ? completeOnes : newSchemes;
      const bestNew = [...pool].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];

      let nextActiveId = bestNew.id;
      if (options?.selectIfBetter && st.activeSchemeId2D) {
        const cur = st.schemes2D.find((s) => s.id === st.activeSchemeId2D);
        const curInBatch = cur && (!options.batchIds || options.batchIds.has(cur.id));
        if (cur && curInBatch) {
          const curBetter =
            (cur.complete && !bestNew.complete) ||
            (cur.complete === bestNew.complete && cur.utilizationPct >= bestNew.utilizationPct);
          if (curBetter) {
            nextActiveId = cur.id;
          }
        }
      }

      return {
        schemes2D: merged,
        activeSchemeId2D: nextActiveId
      };
    }),

  removeScheme2D: (id) =>
    set((st) => {
      const next = st.schemes2D.filter((s) => s.id !== id);
      return {
        schemes2D: next,
        activeSchemeId2D: st.activeSchemeId2D === id ? next[0]?.id || null : st.activeSchemeId2D
      };
    }),

  clearSchemes2D: () => set({ schemes2D: [], activeSchemeId2D: null }),

  setActiveScheme2D: (id) => set({ activeSchemeId2D: id }),

  markSchemeDispatched: (schemeId, taskId, confirmedSchemeId) =>
    set((st) => ({
      schemes2D: st.schemes2D.map((s) =>
        s.id === schemeId ? { ...s, dispatchedTaskId: taskId, confirmedSchemeId } : s
      )
    })),

  loadClusterInto1D: (clusterId, append = false) => {
    const st = get();
    const cluster = st.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const counts = st.clusterSelections[clusterId] || cluster.defaultSizeCounts;
    const mult = Math.max(1, Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0));
    const baseIdx = append
      ? st.slitOrders.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0)
      : 0;
    const orders: SlittingOrderLine[] = cluster.pieces.map((p, idx) => {
      const g = Object.values(p.sizes)[0];
      return {
        id: String(baseIdx + idx + 1),
        name: p.name,
        widthMm: g.w,
        lengthMm: g.h,
        quantity: p.quantityPerUnit * mult,
        surfaceTreatment: p.surfaceTreatment
      };
    });
    const ds = cluster.defaultSlitting;
    const lt = ds ? ds.leftTrimMm : cluster.defaultWidthMm >= 4000 ? 100 : 10;
    const rt = ds ? ds.rightTrimMm : cluster.defaultWidthMm >= 4000 ? 100 : 10;
    const usable = Math.max(200, cluster.defaultWidthMm - lt - rt);
    const maxW = ds ? Math.min(usable, ds.maxWidthMm) : usable;
    const minW = ds ? Math.min(maxW, ds.minWidthMm) : Math.floor((usable * 0.95) / 10) * 10;
    const stepW = ds ? ds.widthStepMm : 10;
    const overCap = ds ? ds.totalOverCap : 30;
    set({
      activeDimension: '1D',
      slitLoadedTaskId: append ? st.slitLoadedTaskId : null,
      slitLoadedTaskName: append ? st.slitLoadedTaskName : null,
      slitMergedSourceTaskIds: append ? st.slitMergedSourceTaskIds : [],
      slitMaterialModel: append ? st.slitMaterialModel : cluster.materialModel,
      ...(append
        ? { slitOrders: [...st.slitOrders, ...orders] }
        : {
            slitWidthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
            slitMotherWidthMm: cluster.defaultWidthMm,
            slitLeftTrimMm: lt,
            slitRightTrimMm: rt,
            slitMaxWidthMm: maxW,
            slitMinWidthMm: minW,
            slitWidthStepMm: stepW,
            slitOverCap: overCap,
            slitFixedLengthMm: cluster.defaultLengthMm,
            slitOrders: orders,
            slitSchemes: [],
            activeSlitSchemeId: null
          })
    });
  },

  setSlitSpec: (spec) => set((st) => ({ ...st, ...spec })),

  updateSlitOrder: (id, patch) =>
    set((st) => ({
      slitOrders: st.slitOrders.map((o) => (o.id === id ? { ...o, ...patch } : o))
    })),

  addSlitOrder: () =>
    set((st) => {
      const nextId = String(st.slitOrders.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1);
      return {
        slitOrders: [
          ...st.slitOrders,
          {
            id: nextId,
            name: `分条规格 #${nextId}`,
            widthMm: 500,
            lengthMm: st.slitFixedLengthMm,
            quantity: 6
          }
        ]
      };
    }),

  removeSlitOrder: (id) =>
    set((st) => ({
      slitOrders: st.slitOrders.filter((o) => o.id !== id)
    })),

  setSlitSchemes: (schemes) =>
    set((st) => {
      const keepActive =
        st.activeSlitSchemeId != null &&
        schemes.some(
          (s) =>
            s.id === st.activeSlitSchemeId &&
            s.state === 'SUCCEEDED' &&
            s.strategyId !== 'BASELINE'
        );
      return {
        slitSchemes: schemes,
        activeSlitSchemeId: keepActive
          ? st.activeSlitSchemeId
          : schemes.find((s) => s.state === 'SUCCEEDED' && s.strategyId !== 'BASELINE')?.id ||
            schemes.find((s) => s.state === 'SUCCEEDED')?.id ||
            schemes[0]?.id ||
            null
      };
    }),

  setActiveSlitScheme: (id) => set({ activeSlitSchemeId: id }),

  markSlitSchemeDispatched: (schemeId, taskId, confirmedSchemeId) =>
    set((st) => ({
      slitSchemes: st.slitSchemes.map((s) =>
        s.id === schemeId ? { ...s, dispatchedTaskId: taskId, confirmedSchemeId } : s
      )
    })),

  settings: initialSettings,

  updateStudioSettings: (next) => {
    const saved = persistStudioSettings(next);
    set((st) => ({
      settings: saved,
      selectedStrategies2D: [...saved.enabledStrategies2D],
      slitProfile: saved.slitProfile,
      ...(st.loadedTaskId
        ? {}
        : {
            pieceGapMm: saved.pieceGapMm,
            trimStartMm: saved.trimStartMm
          })
    }));
    return saved;
  }
}));
