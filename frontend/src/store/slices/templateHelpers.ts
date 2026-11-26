import {
  DXF_GARMENT_STYLES,
  parseDxfGarmentText,
  mirrorVerticesX
} from '../../lib/nesting/dxf-garment-samples.js';
import { polygon, rectangle } from '../../lib/canvas/nesting-scene.js';
import { LINEAR_SCENARIOS } from '../../lib/domain/linear-scenarios.js';
import type {
  ClusterTemplatePiece,
  DemandCluster,
  DemandItem,
  ShapeGeometry
} from '../studioTypes';

const CUSTOM_CLUSTERS_KEY = 'cutplan.react.customClusters.v1';

export function finiteOr(val: unknown, fallback: number): number {
  if (val == null || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

export function loadSavedCustomClusters(): DemandCluster[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CLUSTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomClusters(allClusters: DemandCluster[]): void {
  try {
    localStorage.setItem(CUSTOM_CLUSTERS_KEY, JSON.stringify(allClusters.filter((c) => c.custom)));
  } catch {}
}

export function createInitialClusters(): DemandCluster[] {
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
    description:
      '标准窗帘产品套系模板（落地主帘左/右片、飘窗短帘、定型绑带、同款抱枕套），支持标准高/挑空两档成套选配',
    defaultWidthMm: 2000,
    defaultLengthMm: 3600,
    materialModel: 'TC涤棉-B2026',
    availableSizes: ['标准2.6m高', '挑空3.2m高'],
    defaultSizeCounts: { '标准2.6m高': 1, '挑空3.2m高': 0 },
    pieces: [
      {
        name: '客厅双开主帘',
        quantityPerUnit: 2,
        grainRule: 'STRICT_0',
        sizes: { '标准2.6m高': { w: 1200, h: 1600 }, '挑空3.2m高': { w: 1400, h: 2200 } }
      },
      {
        name: '次卧飘窗短帘',
        quantityPerUnit: 2,
        grainRule: 'STRICT_0',
        sizes: { '标准2.6m高': { w: 600, h: 900 }, '挑空3.2m高': { w: 750, h: 1100 } }
      },
      {
        name: '定型绑带',
        quantityPerUnit: 4,
        grainRule: 'FREE_90',
        sizes: { '标准2.6m高': { w: 180, h: 750 }, '挑空3.2m高': { w: 200, h: 850 } }
      },
      {
        name: '同款沙发抱枕套',
        quantityPerUnit: 2,
        grainRule: 'FREE_90',
        sizes: { '标准2.6m高': { w: 450, h: 450 }, '挑空3.2m高': { w: 500, h: 500 } }
      }
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
      {
        name: '柜体门板',
        quantityPerUnit: 1,
        grainRule: 'STRICT_0',
        sizes: { '800宽柜体': { w: 800, h: 1200 }, '1000宽柜体': { w: 960, h: 1200 } }
      },
      {
        name: '柜体侧板',
        quantityPerUnit: 3,
        grainRule: 'FREE_90',
        sizes: { '800宽柜体': { w: 600, h: 500 }, '1000宽柜体': { w: 600, h: 550 } }
      },
      {
        name: '层板',
        quantityPerUnit: 1,
        grainRule: 'FREE_90',
        sizes: { '800宽柜体': { w: 764, h: 396 }, '1000宽柜体': { w: 964, h: 396 } }
      },
      {
        name: '抽屉面板',
        quantityPerUnit: 1,
        grainRule: 'STRICT_0',
        sizes: { '800宽柜体': { w: 720, h: 396 }, '1000宽柜体': { w: 920, h: 396 } }
      },
      {
        name: '隔板',
        quantityPerUnit: 1,
        grainRule: 'FREE_90',
        sizes: { '800宽柜体': { w: 400, h: 396 }, '1000宽柜体': { w: 480, h: 396 } }
      }
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
    defaultSizeCounts: { 标准批次: 1 },
    pieces: [
      { name: '客户A · 1080mm宽条', quantityPerUnit: 12, sizes: { 标准批次: { w: 1080, h: 2000 } } },
      { name: '客户B · 920mm宽条', quantityPerUnit: 15, sizes: { 标准批次: { w: 920, h: 2000 } } },
      { name: '客户C · 760mm宽条', quantityPerUnit: 18, sizes: { 标准批次: { w: 760, h: 2000 } } },
      { name: '客户D · 640mm宽条', quantityPerUnit: 10, sizes: { 标准批次: { w: 640, h: 2000 } } }
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
    defaultSizeCounts: { 标准批次: 1 },
    pieces: [
      { name: '工程卷帘条 A (600mm)', quantityPerUnit: 10, sizes: { 标准批次: { w: 600, h: 2000 } } },
      { name: '工程卷帘条 B (700mm)', quantityPerUnit: 8, sizes: { 标准批次: { w: 700, h: 2000 } } },
      { name: '窄幅遮光条 C (450mm)', quantityPerUnit: 6, sizes: { 标准批次: { w: 450, h: 2000 } } }
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
      defaultSizeCounts: { 标准批次: 1 },
      pieces: items.map((o) => ({
        name: o.messageText,
        surfaceTreatment: o.surfaceTreatment,
        quantityPerUnit: o.quantity,
        sizes: { 标准批次: { w: o.width, h: o.length * 1000 } }
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

export function mapServerTemplateToCluster(t: any): DemandCluster {
  return {
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
    availableSizes:
      Array.isArray(t.availableSizes) && t.availableSizes.length ? t.availableSizes : ['标准规格'],
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
  };
}

export function parseDxfToDemandCluster(text: string, fileName: string): DemandCluster {
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

  return {
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
}
