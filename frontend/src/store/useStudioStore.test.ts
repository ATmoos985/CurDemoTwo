import { describe, expect, it } from 'vitest';
import {
  useStudioStore,
  expandClusterToDemands,
  type DemandFamilySummary,
  type SavedScheme2D
} from './useStudioStore';
import { getStudioSettingsSnapshot } from './selectors';
import { mergeAndSelectBestSchemes2D } from './slices/workbench2DHelpers';
import {
  mapServerTemplateToCluster,
  parseDxfToDemandCluster
} from './slices/templateHelpers';
import { DEFAULT_STUDIO_SETTINGS } from './studioSettings';
import { shapeArea } from '../lib/canvas/nesting-scene.js';
import { signedArea2 } from '../lib/nesting/dxf-geometry.js';

const makeFamily2D = (id: string, name: string, open1: number, open2: number): DemandFamilySummary => ({
  id,
  name,
  materialModel: 'MAT-2D',
  dimension: 'RECT_2D',
  revision: 1,
  orderedTotal: open1 + open2,
  plannedTotal: 0,
  completedTotal: 0,
  openTotal: open1 + open2,
  schemeCount: 0,
  status: 'OPEN',
  lines: [
    { id: 1, name: '主片', width: 600, length: 900, orderedQty: open1, plannedQty: 0, completedQty: 0, openQty: open1, allowRotation: true },
    { id: 2, name: '辅片', width: 300, length: 400, orderedQty: open2, plannedQty: 0, completedQty: 0, openQty: open2, allowRotation: false }
  ]
});

const makeFamily1D = (id: string, name: string, width: number, open: number): DemandFamilySummary => ({
  id,
  name,
  materialModel: 'FILM-4600',
  dimension: 'SLITTING_1D',
  revision: 1,
  orderedTotal: open,
  plannedTotal: 0,
  completedTotal: 0,
  openTotal: open,
  schemeCount: 0,
  status: 'OPEN',
  slitting: { leftTrim: 100, rightTrim: 100, minWidth: 4200, maxWidth: 4400, widthStep: 10, totalOverCap: 30 },
  lines: [
    { id: 7, name: `${width}mm宽条`, width, length: 2000, orderedQty: open, plannedQty: 0, completedQty: 0, openQty: open }
  ]
});

const makeScheme2D = (
  id: string,
  utilizationPct: number,
  complete = true
): SavedScheme2D => ({
  id,
  title: `方案 ${id}`,
  strategyId: 'PS_FIXED',
  strategyName: '经向缩长',
  createdAt: '12:00:00',
  canvasMode: 'FREE_CANVAS',
  materialModel: 'MAT-2D',
  widthMm: 1600,
  canvasLengthMm: 2400,
  occupiedLengthMm: 1200,
  utilizationPct,
  pieceAreaM2: 1.5,
  placedCount: complete ? 4 : 2,
  requestedCount: 4,
  complete,
  demands: [],
  request: {},
  result: { layout: { placements: [], cuts: [], leftovers: [] } }
});

describe('useStudioStore 多族合排溯源保持与进度同步', () => {
  it('2D 多族合并载入工作台时在每个展开需求项保留 sourceTaskId 与 sourceLineId', () => {
    const famA = makeFamily2D('FAM-A', '订单A', 4, 2);
    const famB = makeFamily2D('FAM-B', '订单B', 3, 0);

    useStudioStore.getState().loadDemandFamiliesMergedIntoWorkbench([famA, famB]);
    const st = useStudioStore.getState();

    expect(st.activeDimension).toBe('2D');
    expect(st.loadedTaskId).toBeNull();
    expect(st.mergedSourceTaskIds).toEqual(['FAM-A', 'FAM-B']);
    expect(st.activeDemands2D).toHaveLength(3);
    expect(st.activeDemands2D[0]).toMatchObject({
      sourceTaskId: 'FAM-A',
      sourceTaskName: '订单A',
      sourceLineId: 1,
      quantity: 4
    });
    expect(st.activeDemands2D[1]).toMatchObject({
      sourceTaskId: 'FAM-A',
      sourceTaskName: '订单A',
      sourceLineId: 2,
      quantity: 2
    });
    expect(st.activeDemands2D[2]).toMatchObject({
      sourceTaskId: 'FAM-B',
      sourceTaskName: '订单B',
      sourceLineId: 1,
      quantity: 3
    });

    // 确认后多族进度刷新同步扣减各原行余量
    useStudioStore.getState().syncMergedDemandFamiliesProgress([
      {
        ...famA,
        plannedTotal: 2,
        openTotal: 4,
        lines: [
          { ...famA.lines[0], plannedQty: 2, openQty: 2 },
          famA.lines[1]
        ]
      },
      {
        ...famB,
        plannedTotal: 3,
        openTotal: 0,
        lines: [
          { ...famB.lines[0], plannedQty: 3, openQty: 0 },
          famB.lines[1]
        ]
      }
    ]);
    const after = useStudioStore.getState();
    expect(after.activeDemands2D[0].quantity).toBe(2);
    expect(after.activeDemands2D[0].plannedQty).toBe(2);
    expect(after.activeDemands2D[2].quantity).toBe(0);
    expect(after.activeDemands2D[2].plannedQty).toBe(3);
  });

  it('1D 多族合并载入工作台时保留每条分切订单的 sourceTaskId 与 sourceLineId', () => {
    const f1 = makeFamily1D('SLIT-A', '光学膜甲', 1080, 10);
    const f2 = makeFamily1D('SLIT-B', '光学膜乙', 920, 12);

    useStudioStore.getState().loadDemandFamiliesMergedIntoWorkbench([f1, f2]);
    const st = useStudioStore.getState();

    expect(st.activeDimension).toBe('1D');
    expect(st.slitLoadedTaskId).toBeNull();
    expect(st.slitMergedSourceTaskIds).toEqual(['SLIT-A', 'SLIT-B']);
    expect(st.slitOrders).toHaveLength(2);
    expect(st.slitOrders[0]).toMatchObject({
      sourceTaskId: 'SLIT-A',
      sourceTaskName: '光学膜甲',
      sourceLineId: 7,
      quantity: 10
    });
    expect(st.slitOrders[1]).toMatchObject({
      sourceTaskId: 'SLIT-B',
      sourceTaskName: '光学膜乙',
      sourceLineId: 7,
      quantity: 12
    });
  });
});

describe('正交域切片联动与纯辅助逻辑回归验证', () => {
  it('WorkspaceSlice 更新设置时与 2D/1D 策略同步，且受 loadedTaskId 保护不误覆写任务工艺', () => {
    // 无加载任务时：更新 pieceGapMm / trimStartMm 同步生效
    useStudioStore.getState().setCanvasSpec({ loadedTaskId: null, pieceGapMm: 0, trimStartMm: 0 });
    const updated = useStudioStore.getState().updateStudioSettings({
      ...DEFAULT_STUDIO_SETTINGS,
      pieceGapMm: 8,
      trimStartMm: 25,
      slitProfile: 'QUALITY',
      enabledStrategies2D: ['PS_FIXED', 'JAVA_FAST']
    });

    expect(updated.pieceGapMm).toBe(8);
    expect(getStudioSettingsSnapshot().pieceGapMm).toBe(8);
    expect(useStudioStore.getState().pieceGapMm).toBe(8);
    expect(useStudioStore.getState().trimStartMm).toBe(25);
    expect(useStudioStore.getState().slitProfile).toBe('QUALITY');
    expect(useStudioStore.getState().selectedStrategies2D).toEqual(['PS_FIXED', 'JAVA_FAST']);

    // 已加载需求族任务时：全局默认 pieceGapMm 不得覆盖当前任务工艺参数
    useStudioStore.getState().setCanvasSpec({ loadedTaskId: 'TASK-LOCKED', pieceGapMm: 12, trimStartMm: 40 });
    useStudioStore.getState().updateStudioSettings({
      ...DEFAULT_STUDIO_SETTINGS,
      pieceGapMm: 2,
      trimStartMm: 5
    });
    expect(useStudioStore.getState().pieceGapMm).toBe(12);
    expect(useStudioStore.getState().trimStartMm).toBe(40);
    expect(getStudioSettingsSnapshot().pieceGapMm).toBe(2);
  });

  it('TemplateSlice 尺码配比展开与单/多模板载入 2D/1D 正常工作', () => {
    const curtain = useStudioStore.getState().clusters.find((c) => c.id === 'CLUSTER_CURTAIN_SUITE')!;
    expect(curtain).toBeDefined();

    const expanded = expandClusterToDemands(curtain, { '标准2.6m高': 2, '挑空3.2m高': 0 }, 10);
    expect(expanded.length).toBe(curtain.pieces.length);
    expect(expanded[0].id).toBe(10);
    expect(expanded[0].quantity).toBe(4);

    useStudioStore.getState().setClusterCount('CLUSTER_CURTAIN_SUITE', '标准2.6m高', 3);
    useStudioStore.getState().loadClusterInto2D('CLUSTER_CURTAIN_SUITE', false);
    expect(useStudioStore.getState().activeDimension).toBe('2D');
    expect(useStudioStore.getState().materialModel2D).toBe(curtain.materialModel);
    expect(useStudioStore.getState().activeDemands2D[0].quantity).toBe(6);

    useStudioStore.getState().loadClusterInto1D('CLUSTER_SLIT_CURTAIN', false);
    expect(useStudioStore.getState().activeDimension).toBe('1D');
    expect(useStudioStore.getState().slitMotherWidthMm).toBe(2000);
    expect(useStudioStore.getState().slitOrders).toHaveLength(3);
  });

  it('Workbench2D 候选择优逻辑优先齐套且尊重同批次 selectIfBetter', () => {
    const s1 = makeScheme2D('S-1', 84.5, true);
    const s2 = makeScheme2D('S-2', 79.0, true);
    const s3 = makeScheme2D('S-3', 91.0, false);

    // 即使 s3 利用率高，但未齐套，因此仍选齐套的 s1
    const first = mergeAndSelectBestSchemes2D([], null, [s2, s3, s1]);
    expect(first?.activeSchemeId2D).toBe('S-1');

    // 同批次新方案 s4 更差时保持已选 s1；更优的 s5 则自动切换
    const s4 = makeScheme2D('S-4', 80.0, true);
    const keepBetter = mergeAndSelectBestSchemes2D([s1], 'S-1', [s4], {
      selectIfBetter: true,
      batchIds: new Set(['S-1', 'S-4'])
    });
    expect(keepBetter?.activeSchemeId2D).toBe('S-1');

    const s5 = makeScheme2D('S-5', 88.2, true);
    const switchBetter = mergeAndSelectBestSchemes2D([s1], 'S-1', [s5], {
      selectIfBetter: true,
      batchIds: new Set(['S-1', 'S-5'])
    });
    expect(switchBetter?.activeSchemeId2D).toBe('S-5');
  });

  it('Workbench1D 订单行增删改与优选非 BASELINE 方案切换行为一致', () => {
    useStudioStore.getState().loadClusterInto1D('CLUSTER_SLIT_CURTAIN', false);
    const initialCount = useStudioStore.getState().slitOrders.length;
    useStudioStore.getState().addSlitOrder();
    const afterAdd = useStudioStore.getState().slitOrders;
    expect(afterAdd).toHaveLength(initialCount + 1);

    const addedId = afterAdd[afterAdd.length - 1].id;
    useStudioStore.getState().updateSlitOrder(addedId, { widthMm: 520, quantity: 9 });
    expect(useStudioStore.getState().slitOrders.find((o) => o.id === addedId)).toMatchObject({
      widthMm: 520,
      quantity: 9
    });

    useStudioStore.getState().removeSlitOrder(addedId);
    expect(useStudioStore.getState().slitOrders).toHaveLength(initialCount);

    useStudioStore.getState().setSlitSchemes([
      {
        id: 'BASE-1',
        strategyId: 'BASELINE',
        strategyName: '基线',
        state: 'SUCCEEDED',
        motherWidthMm: 2000,
        leftTrimMm: 10,
        rightTrimMm: 10,
        totalCars: 10,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 80,
        patterns: [],
        fulfillment: []
      },
      {
        id: 'FAST-1',
        strategyId: 'FAST',
        strategyName: '快速优化',
        state: 'SUCCEEDED',
        motherWidthMm: 2000,
        leftTrimMm: 10,
        rightTrimMm: 10,
        totalCars: 8,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 92,
        patterns: [],
        fulfillment: []
      }
    ]);
    expect(useStudioStore.getState().activeSlitSchemeId).toBe('FAST-1');
  });

  it('含内孔 DXF 转需求模板、服务端往返与 pairMirror 展开全链路保留 CW 内孔并扣除净面积', () => {
    const aamaHoleDxf = [
      '0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'WingPanel', '10', '0', '20', '0',
      '0', 'TEXT', '8', '0', '1', 'Piece Name: WingPanel',
      '0', 'TEXT', '8', '0', '1', 'Fabric: 面布',
      '0', 'TEXT', '8', '0', '1', 'Size: M',
      '0', 'TEXT', '8', '0', '1', 'Quantity: 1,1',
      // 外框 400x300 (Layer 1)
      '0', 'LWPOLYLINE', '8', '1', '70', '1',
      '10', '0', '20', '0',
      '10', '400', '20', '0',
      '10', '400', '20', '300',
      '10', '0', '20', '300',
      // 偏心内孔 [40,60]~[120,140] (Layer 11)
      '0', 'LWPOLYLINE', '8', '11', '70', '1',
      '10', '40', '20', '60',
      '10', '120', '20', '60',
      '10', '120', '20', '140',
      '10', '40', '20', '140',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', '1', '2', 'WingPanel', '10', '0', '20', '0',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');

    const cluster = parseDxfToDemandCluster(aamaHoleDxf, 'wing-hole.dxf');
    expect(cluster.pieces).toHaveLength(1);
    const savedGeom = cluster.pieces[0].sizes['M'];
    expect(savedGeom.holes).toHaveLength(1);

    // 模拟经由服务端 /api/v2/demand-templates JSON 序列化往返
    const serverRoundTrip = mapServerTemplateToCluster(JSON.parse(JSON.stringify(cluster)));
    expect(serverRoundTrip.pieces[0].sizes['M'].holes).toHaveLength(1);

    const expanded = expandClusterToDemands(serverRoundTrip, { M: 1 }, 100);
    expect(expanded).toHaveLength(2);
    const left = expanded.find((d) => d.name.endsWith('(左)'))!;
    const right = expanded.find((d) => d.name.endsWith('(右)'))!;
    expect(left?.shape?.holes).toHaveLength(1);
    expect(right?.shape?.holes).toHaveLength(1);

    // 外环 CCW (>0)，内孔 CW (<0)
    expect(signedArea2(left.shape!.vertices!)).toBeGreaterThan(0);
    expect(signedArea2(left.shape!.holes![0])).toBeLessThan(0);
    expect(signedArea2(right.shape!.vertices!)).toBeGreaterThan(0);
    expect(signedArea2(right.shape!.holes![0])).toBeLessThan(0);

    // 右片内孔 X 坐标正确镜像为 [280, 360]
    const rightHoleXs = right.shape!.holes![0].map((p) => p.x);
    expect(Math.min(...rightHoleXs)).toBe(280);
    expect(Math.max(...rightHoleXs)).toBe(360);

    // shapeArea 正确扣除 80x80 内孔面积：400*300 - 80*80 = 113600
    expect(shapeArea(left.shape)).toBe(113600);
    expect(shapeArea(right.shape)).toBe(113600);
  });
});
