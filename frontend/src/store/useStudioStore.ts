import { create } from 'zustand';
import {
  DXF_GARMENT_STYLES,
  parseDxfGarmentText,
  mirrorVerticesX
} from '@static/js/nesting/dxf-garment-samples.js';
import { polygon, rectangle } from '@static/js/canvas/nesting-scene.js';

export interface ShapeGeometry {
  type: 'RECTANGLE' | 'POLYGON';
  width: number;
  height: number;
  vertices?: { x: number; y: number }[];
}

export interface DemandItem {
  id: number;
  name: string;
  width: number;
  length: number;
  quantity: number;
  allowRotation: boolean;
  allowHalfTurn?: boolean;
  shape?: ShapeGeometry;
  clusterId?: string;
  clusterName?: string;
  sizeLabel?: string;
  fabric?: string;
}

export interface ClusterTemplatePiece {
  name: string;
  fabric?: string;
  quantityPerUnit: number;
  pairMirror?: boolean;
  sizes: Record<string, { w: number; h: number; v?: [number, number][] }>;
}

export interface DemandCluster {
  id: string;
  name: string;
  code: string;
  category: 'DXF_GARMENT' | 'CURTAIN_2D' | 'BOARD_2D' | 'SLITTING_1D';
  dimension: '2D' | '1D';
  description: string;
  defaultWidthMm: number;
  defaultLengthMm: number;
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
  strategyName: string;
  createdAt: string;
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL';
  rollId?: string;
  materialModel: string;
  widthMm: number;
  canvasLengthMm: number;
  occupiedLengthMm: number;
  utilizationPct: number;
  pieceAreaM2: number;
  placedCount: number;
  requestedCount: number;
  complete: boolean;
  demands: DemandItem[];
  request: any;
  result: any;
  dispatchedTaskId?: string;
}

export interface SlittingOrderLine {
  id: string;
  name: string;
  widthMm: number;
  lengthMm: number;
  quantity: number;
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
  elapsedMs?: number;
  patterns: {
    id: string;
    lengthMm: number;
    repetitions: number;
    stations: { widthMm: number; countPerRepetition: number }[];
    usedWidthMm: number;
    spareWidthMm: number;
    allocations?: { orderId: string; count: number }[];
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
}

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
      description: s.description,
      defaultWidthMm: s.defaultWidth,
      defaultLengthMm: styleId === 'DXF_3129' ? 2400 : 1600,
      materialModel: s.materialModel,
      availableSizes: s.sizes,
      defaultSizeCounts: styleId === 'DXF_3129'
        ? { '110': 0, '120': 1, '130': 0, '140': 0, '150': 0, '160': 0 }
        : { '110': 0, '120': 1, '130': 0, '140': 1, '150': 0, '160': 0 },
      pieces: mainPieces.map((p: any) => ({
        name: p.name,
        fabric: p.fabric,
        quantityPerUnit: p.quantity,
        pairMirror: p.pairMirror,
        sizes: p.sizes
      }))
    };
  });

  const s1226 = DXF_GARMENT_STYLES.DXF_1226;
  const rib1226: DemandCluster = {
    id: 'DXF_1226_RIB',
    name: '1226 卫衣罗纹配套簇 (领/袖口/下摆)',
    code: 'F1CRH1226-RIB',
    category: 'DXF_GARMENT',
    dimension: '2D',
    description: '1226.dxf 配套罗纹裁片簇：下摆×1、左右袖口×2、罗纹领×1（支持 110–160 码按套选配）',
    defaultWidthMm: 1500,
    defaultLengthMm: 1200,
    materialModel: 'DXF-1226-配套罗纹',
    availableSizes: s1226.sizes,
    defaultSizeCounts: { '110': 0, '120': 2, '130': 0, '140': 2, '150': 0, '160': 0 },
    pieces: s1226.pieces.filter((p: any) => p.fabric === '罗纹').map((p: any) => ({
      name: p.name,
      fabric: p.fabric,
      quantityPerUnit: p.quantity,
      pairMirror: p.pairMirror,
      sizes: p.sizes
    }))
  };

  const curtainCluster: DemandCluster = {
    id: 'CLUSTER_CURTAIN_SUITE',
    name: '全屋窗帘主帘+辅件标准簇',
    code: 'CURTAIN-SUITE',
    category: 'CURTAIN_2D',
    dimension: '2D',
    description: '固定窗帘款式组成（落地主帘左/右片、飘窗短帘、定型绑带、同款抱枕套），支持标准高/挑空两档成套选配',
    defaultWidthMm: 2000,
    defaultLengthMm: 3600,
    materialModel: 'TC涤棉-B2026',
    availableSizes: ['标准2.6m高', '挑空3.2m高'],
    defaultSizeCounts: { '标准2.6m高': 1, '挑空3.2m高': 0 },
    pieces: [
      { name: '客厅双开主帘', quantityPerUnit: 2, sizes: { '标准2.6m高': { w: 1200, h: 1600 }, '挑空3.2m高': { w: 1400, h: 2200 } } },
      { name: '次卧飘窗短帘', quantityPerUnit: 2, sizes: { '标准2.6m高': { w: 600, h: 900 }, '挑空3.2m高': { w: 750, h: 1100 } } },
      { name: '定型绑带', quantityPerUnit: 4, sizes: { '标准2.6m高': { w: 180, h: 750 }, '挑空3.2m高': { w: 200, h: 850 } } },
      { name: '同款沙发抱枕套', quantityPerUnit: 2, sizes: { '标准2.6m高': { w: 450, h: 450 }, '挑空3.2m高': { w: 500, h: 500 } } }
    ]
  };

  const boardCluster: DemandCluster = {
    id: 'CLUSTER_CABINET_BOARD',
    name: '定制衣柜板材套板簇',
    code: 'CABINET-2440',
    category: 'BOARD_2D',
    dimension: '2D',
    description: '标准 1220×2440mm 板材开料套系（侧板、门板、层板、隔板、抽屉面板）',
    defaultWidthMm: 1220,
    defaultLengthMm: 2440,
    materialModel: '定制板材-1220',
    availableSizes: ['800宽柜体', '1000宽柜体'],
    defaultSizeCounts: { '800宽柜体': 1, '1000宽柜体': 0 },
    pieces: [
      { name: '柜体门板', quantityPerUnit: 1, sizes: { '800宽柜体': { w: 800, h: 1200 }, '1000宽柜体': { w: 960, h: 1200 } } },
      { name: '柜体侧板', quantityPerUnit: 3, sizes: { '800宽柜体': { w: 600, h: 500 }, '1000宽柜体': { w: 600, h: 550 } } },
      { name: '层板', quantityPerUnit: 1, sizes: { '800宽柜体': { w: 764, h: 396 }, '1000宽柜体': { w: 964, h: 396 } } },
      { name: '抽屉面板', quantityPerUnit: 1, sizes: { '800宽柜体': { w: 720, h: 396 }, '1000宽柜体': { w: 920, h: 396 } } },
      { name: '隔板', quantityPerUnit: 1, sizes: { '800宽柜体': { w: 400, h: 396 }, '1000宽柜体': { w: 480, h: 396 } } }
    ]
  };

  const slittingFilmCluster: DemandCluster = {
    id: 'CLUSTER_SLIT_FILM',
    name: '光学膜同卷长分条订单簇 (4600mm母卷)',
    code: 'SLIT-FILM-4600',
    category: 'SLITTING_1D',
    dimension: '1D',
    description: '4 个客户同卷长 (2000mm) 不同条宽规格簇，专门用于一维分切多组合套裁优化',
    defaultWidthMm: 4600,
    defaultLengthMm: 2000,
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
    name: '涂层面料定长分条簇 (2000mm母卷)',
    code: 'SLIT-CURTAIN-2000',
    category: 'SLITTING_1D',
    dimension: '1D',
    description: '宽窄条混搭一维分切簇（600mm / 700mm / 450mm），无需看二维卷面，直接算最优分条组合',
    defaultWidthMm: 2000,
    defaultLengthMm: 2000,
    materialModel: '涂层面料-2000',
    availableSizes: ['标准批次'],
    defaultSizeCounts: { '标准批次': 1 },
    pieces: [
      { name: '工程卷帘条 A (600mm)', quantityPerUnit: 10, sizes: { '标准批次': { w: 600, h: 2000 } } },
      { name: '工程卷帘条 B (700mm)', quantityPerUnit: 8, sizes: { '标准批次': { w: 700, h: 2000 } } },
      { name: '窄幅遮光条 C (450mm)', quantityPerUnit: 6, sizes: { '标准批次': { w: 450, h: 2000 } } }
    ]
  };

  return [
    ...loadSavedCustomClusters(),
    ...dxfClusters,
    rib1226,
    curtainCluster,
    boardCluster,
    slittingFilmCluster,
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
            allowRotation: false,
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
            allowRotation: false,
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
            allowRotation: false,
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
          allowRotation: false,
          shape: undefined,
          clusterId: cluster.id,
          clusterName: cluster.name,
          sizeLabel: sizeKey
        });
        void rectShape;
      }
    }
  }
  return items;
}

interface StudioState {
  clusters: DemandCluster[];
  clusterSelections: Record<string, Record<string, number>>;
  // 2D Studio State
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL';
  canvasWidthMm: number;
  canvasLengthMm: number;
  pieceGapMm: number;
  trimStartMm: number;
  selectedRollId: string;
  materialModel2D: string;
  loadedTaskId: string | null;
  loadedTaskName: string | null;
  activeDemands2D: DemandItem[];
  selectedStrategies2D: string[];
  strategyRuns2D: StrategyJobRun[];
  schemes2D: SavedScheme2D[];
  activeSchemeId2D: string | null;
  // 1D Slitting Studio State
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
  slitOrders: SlittingOrderLine[];
  slitSchemes: SlittingSchemeRun[];
  activeSlitSchemeId: string | null;

  // Actions
  setClusterCount: (clusterId: string, sizeKey: string, count: number) => void;
  addCustomCluster: (cluster: DemandCluster) => void;
  deleteCustomCluster: (clusterId: string) => void;
  importDxfAsCluster: (text: string, fileName: string) => DemandCluster;
  loadClusterInto2D: (clusterId: string, append?: boolean) => void;
  loadSelectedClustersInto2D: (clusterIds: string[], append?: boolean) => void;
  setCanvasSpec: (spec: Partial<{
    canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL';
    canvasWidthMm: number;
    canvasLengthMm: number;
    pieceGapMm: number;
    trimStartMm: number;
    selectedRollId: string;
    materialModel2D: string;
    loadedTaskId: string | null;
    loadedTaskName: string | null;
  }>) => void;
  setActiveDemands2D: (demands: DemandItem[]) => void;
  updateDemand2D: (id: number, patch: Partial<DemandItem>) => void;
  removeDemand2D: (id: number) => void;
  addBlankDemand2D: () => void;
  toggleStrategy2D: (strategyId: string) => void;
  setStrategyRuns2D: (runs: StrategyJobRun[] | ((prev: StrategyJobRun[]) => StrategyJobRun[])) => void;
  addSchemes2D: (newSchemes: SavedScheme2D[]) => void;
  removeScheme2D: (id: string) => void;
  clearSchemes2D: () => void;
  setActiveScheme2D: (id: string | null) => void;
  markSchemeDispatched: (schemeId: string, taskId: string) => void;

  // 1D Actions
  loadClusterInto1D: (clusterId: string) => void;
  setSlitSpec: (spec: Partial<StudioState>) => void;
  updateSlitOrder: (id: string, patch: Partial<SlittingOrderLine>) => void;
  addSlitOrder: () => void;
  removeSlitOrder: (id: string) => void;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  setActiveSlitScheme: (id: string | null) => void;
  markSlitSchemeDispatched: (schemeId: string, taskId: string) => void;
}

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

  canvasMode: 'FREE_CANVAS',
  canvasWidthMm: defaultCluster2D.defaultWidthMm,
  canvasLengthMm: defaultCluster2D.defaultLengthMm,
  pieceGapMm: 0,
  trimStartMm: 0,
  selectedRollId: 'ROLL-DXF-1226',
  materialModel2D: defaultCluster2D.materialModel,
  loadedTaskId: null,
  loadedTaskName: null,
  activeDemands2D: defaultDemands2D,
  selectedStrategies2D: ['SHORTEN_FIXED', 'SHORTEN_HALF_TURN', 'JAVA_HEURISTIC'],
  strategyRuns2D: [],
  schemes2D: [],
  activeSchemeId2D: null,

  slitMotherWidthMm: 4600,
  slitLeftTrimMm: 100,
  slitRightTrimMm: 100,
  slitMinWidthMm: 4200,
  slitMaxWidthMm: 4400,
  slitWidthStepMm: 10,
  slitOverCap: 20,
  slitFixedLengthMm: 2000,
  slitAvoidDefects: false,
  slitRollId: '',
  slitOrders: defaultSlitCluster.pieces.map((p, idx) => ({
    id: String(idx + 1),
    name: p.name,
    widthMm: Object.values(p.sizes)[0].w,
    lengthMm: Object.values(p.sizes)[0].h,
    quantity: p.quantityPerUnit
  })),
  slitSchemes: [],
  activeSlitSchemeId: null,

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

  addCustomCluster: (cluster) =>
    set((st) => {
      const next = [{ ...cluster, custom: true }, ...st.clusters];
      saveCustomClusters(next);
      return {
        clusters: next,
        clusterSelections: {
          ...st.clusterSelections,
          [cluster.id]: { ...cluster.defaultSizeCounts }
        }
      };
    }),

  deleteCustomCluster: (clusterId) =>
    set((st) => {
      const next = st.clusters.filter((c) => c.id !== clusterId || !c.custom);
      saveCustomClusters(next);
      return { clusters: next };
    }),

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
      name: `${baseCode} 导入纸样簇 (DXF)`,
      code: baseCode,
      category: 'DXF_GARMENT',
      dimension: '2D',
      description: `从 ${fileName} 实时解析的 CAD 纸样簇（共 ${pieceMap.size} 种裁片，尺码 ${availableSizes.join('/')}）`,
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
    const effectiveCounts = hasPositive
      ? counts
      : { [cluster.availableSizes[0]]: 1 };
    const startId = append ? st.activeDemands2D.reduce((m, d) => Math.max(m, d.id), 0) + 1 : 1;
    const expanded = expandClusterToDemands(cluster, effectiveCounts, startId);
    set({
      loadedTaskId: null,
      loadedTaskName: null,
      activeDemands2D: append ? [...st.activeDemands2D, ...expanded] : expanded,
      canvasWidthMm: append ? st.canvasWidthMm : cluster.defaultWidthMm,
      canvasLengthMm: append ? st.canvasLengthMm : cluster.defaultLengthMm,
      materialModel2D: append ? st.materialModel2D : cluster.materialModel,
      ...(append ? {} : { activeSchemeId2D: null })
    });
  },

  loadSelectedClustersInto2D: (clusterIds, append = false) => {
    const st = get();
    let list: DemandItem[] = append ? [...st.activeDemands2D] : [];
    let nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    let firstCluster: DemandCluster | null = null;
    for (const id of clusterIds) {
      const cluster = st.clusters.find((c) => c.id === id);
      if (!cluster || cluster.dimension !== '2D') continue;
      if (!firstCluster) firstCluster = cluster;
      const counts = st.clusterSelections[id] || cluster.defaultSizeCounts;
      const effectiveCounts = Object.values(counts).some((v) => v > 0)
        ? counts
        : { [cluster.availableSizes[0]]: 1 };
      const items = expandClusterToDemands(cluster, effectiveCounts, nextId);
      list = [...list, ...items];
      nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    }
    if (list.length) {
      set({
        loadedTaskId: null,
        loadedTaskName: null,
        activeDemands2D: list,
        ...(firstCluster && !append
          ? {
              canvasWidthMm: firstCluster.defaultWidthMm,
              canvasLengthMm: firstCluster.defaultLengthMm,
              materialModel2D: firstCluster.materialModel,
              activeSchemeId2D: null
            }
          : {})
      });
    }
  },

  setCanvasSpec: (spec) => set((st) => ({ ...st, ...spec })),

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
            name: `自定义矩形件 #${nextId}`,
            width: 500,
            length: 800,
            quantity: 2,
            allowRotation: false,
            clusterName: '手动录入'
          }
        ]
      };
    }),

  toggleStrategy2D: (strategyId) =>
    set((st) => {
      const exists = st.selectedStrategies2D.includes(strategyId);
      if (exists && st.selectedStrategies2D.length <= 1) return st;
      return {
        selectedStrategies2D: exists
          ? st.selectedStrategies2D.filter((id) => id !== strategyId)
          : [...st.selectedStrategies2D, strategyId]
      };
    }),

  setStrategyRuns2D: (runs) =>
    set((st) => ({
      strategyRuns2D: typeof runs === 'function' ? runs(st.strategyRuns2D) : runs
    })),

  addSchemes2D: (newSchemes) =>
    set((st) => {
      if (!newSchemes.length) return st;
      const merged = [...newSchemes, ...st.schemes2D];
      const completeOnes = newSchemes.filter((x) => x.complete);
      const pool = completeOnes.length ? completeOnes : newSchemes;
      const best = [...pool].sort((a, b) => b.utilizationPct - a.utilizationPct)[0];
      return {
        schemes2D: merged,
        activeSchemeId2D: best.id
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

  markSchemeDispatched: (schemeId, taskId) =>
    set((st) => ({
      schemes2D: st.schemes2D.map((s) => (s.id === schemeId ? { ...s, dispatchedTaskId: taskId } : s))
    })),

  loadClusterInto1D: (clusterId) => {
    const st = get();
    const cluster = st.clusters.find((c) => c.id === clusterId);
    if (!cluster) return;
    const orders: SlittingOrderLine[] = cluster.pieces.map((p, idx) => {
      const g = Object.values(p.sizes)[0];
      return {
        id: String(idx + 1),
        name: p.name,
        widthMm: g.w,
        lengthMm: g.h,
        quantity: p.quantityPerUnit
      };
    });
    const trim = cluster.defaultWidthMm >= 4000 ? 100 : 10;
    const usable = cluster.defaultWidthMm - trim * 2;
    set({
      slitMotherWidthMm: cluster.defaultWidthMm,
      slitLeftTrimMm: trim,
      slitRightTrimMm: trim,
      slitMaxWidthMm: usable,
      slitMinWidthMm: Math.floor((usable * 0.92) / 10) * 10,
      slitFixedLengthMm: cluster.defaultLengthMm,
      slitOrders: orders
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
    set({
      slitSchemes: schemes,
      activeSlitSchemeId:
        schemes.find((s) => s.state === 'SUCCEEDED' && s.strategyId !== 'BASELINE')?.id ||
        schemes.find((s) => s.state === 'SUCCEEDED')?.id ||
        schemes[0]?.id ||
        null
    }),

  setActiveSlitScheme: (id) => set({ activeSlitSchemeId: id }),

  markSlitSchemeDispatched: (schemeId, taskId) =>
    set((st) => ({
      slitSchemes: st.slitSchemes.map((s) => (s.id === schemeId ? { ...s, dispatchedTaskId: taskId } : s))
    }))
}));
