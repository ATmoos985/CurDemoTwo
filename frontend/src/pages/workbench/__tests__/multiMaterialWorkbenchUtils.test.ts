import { describe, expect, it } from 'vitest';
import {
  buildMultiMaterialCandidateRollOptions,
  buildMultiMaterialCsvText,
  buildMultiMaterialWorkbenchRequest,
  mapMultiMaterialResponseToSchemes2D,
  toBoardDefectsFromSchemeSnapshot,
  type MultiMaterialPlanResponse
} from '../multiMaterialWorkbenchUtils';
import type { DemandItem } from '../../../store/useStudioStore';

const samplePolygonShape = {
  type: 'POLYGON' as const,
  width: 500,
  height: 600,
  vertices: [
    { x: 0, y: 0 },
    { x: 500, y: 0 },
    { x: 500, y: 250 },
    { x: 250, y: 250 },
    { x: 250, y: 600 },
    { x: 0, y: 600 }
  ],
  holes: [
    [
      { x: 60, y: 60 },
      { x: 160, y: 60 },
      { x: 160, y: 160 },
      { x: 60, y: 160 }
    ]
  ]
};

const sampleDemands: DemandItem[] = [
  {
    id: 1,
    name: 'L型衣片',
    width: 500,
    length: 600,
    quantity: 3,
    orderedQty: 5,
    allowRotation: false,
    allowHalfTurn: true,
    shape: samplePolygonShape,
    sourceTaskId: 'TASK-001',
    sourceLineId: 11
  },
  {
    id: 2,
    name: '袖口矩形片',
    width: 300,
    length: 400,
    quantity: 4,
    orderedQty: 4,
    allowRotation: true,
    sourceTaskId: 'TASK-002',
    sourceLineId: 22
  }
];

describe('多料头 + 多母卷工作台联排请求构造', () => {
  it('携带左侧需求池（含多边形 shape/holes、旋转约束、跨任务 sourceTaskId/sourceLineId）与任务防色差参数', () => {
    const built = buildMultiMaterialWorkbenchRequest({
      demands: sampleDemands,
      taskId: 'TASK-001',
      materialModel: 'MODEL-TC',
      requiredBatchNo: 'BAT-A',
      requiredColor: '藏青',
      preferRemnants: true,
      maxRemnants: 25, // 超上限应钳位到 20
      candidateRollIds: ['ROLL-W1600', 'ROLL-W1800', 'ROLL-W1600'],
      pieceGapMm: 4,
      trimStartMm: 20,
      timeBudgetMs: 8000
    });

    expect(built.error).toBeUndefined();
    expect(built.usedOrderedFallback).toBe(false);
    expect(built.payload).toBeDefined();
    expect(built.payload!.taskId).toBe('TASK-001');
    expect(built.payload!.materialModel).toBe('MODEL-TC');
    expect(built.payload!.requiredBatchNo).toBe('BAT-A');
    expect(built.payload!.requiredColor).toBe('藏青');
    expect(built.payload!.preferRemnants).toBe(true);
    expect(built.payload!.maxRemnants).toBe(20);
    expect(built.payload!.candidateRollIds).toEqual(['ROLL-W1600', 'ROLL-W1800']);
    expect(built.payload!.pieceGapMm).toBe(4);
    expect(built.payload!.trimStartMm).toBe(20);
    expect(built.payload!.demands).toHaveLength(2);

    const first = built.payload!.demands[0];
    expect(first.allowRotation).toBe(false);
    expect(first.allowHalfTurn).toBe(true);
    expect(first.shape.type).toBe('POLYGON');
    expect(first.shape.vertices).toHaveLength(6);
    expect(first.shape.holes).toHaveLength(1);
    expect(first.sourceTaskId).toBe('TASK-001');
    expect(first.sourceLineId).toBe(11);

    const second = built.payload!.demands[1];
    expect(second.allowRotation).toBe(true);
    expect(second.shape).toBeUndefined();
    expect(second.sourceTaskId).toBe('TASK-002');
    expect(second.sourceLineId).toBe(22);
  });

  it('关闭优先消化料头时 maxRemnants 归零，未勾选母卷时不传 candidateRollIds', () => {
    const built = buildMultiMaterialWorkbenchRequest({
      demands: [sampleDemands[1]],
      preferRemnants: false,
      maxRemnants: 6,
      candidateRollIds: [],
      pieceGapMm: 0,
      trimStartMm: 10
    });

    expect(built.error).toBeUndefined();
    expect(built.payload!.preferRemnants).toBe(false);
    expect(built.payload!.maxRemnants).toBe(0);
    expect(built.payload!).not.toHaveProperty('candidateRollIds');
    expect(built.payload!).not.toHaveProperty('taskId');
  });

  it('当需求池 openQty 全为 0 时自动回退 orderedQty 试算；全空时返回明确错误', () => {
    const settled = buildMultiMaterialWorkbenchRequest({
      demands: [{ ...sampleDemands[1], quantity: 0, orderedQty: 5 }],
      preferRemnants: true,
      maxRemnants: 6,
      pieceGapMm: 0,
      trimStartMm: 0
    });
    expect(settled.error).toBeUndefined();
    expect(settled.usedOrderedFallback).toBe(true);
    expect(settled.payload!.demands[0].quantity).toBe(5);

    const empty = buildMultiMaterialWorkbenchRequest({
      demands: [],
      preferRemnants: true,
      maxRemnants: 6,
      pieceGapMm: 0,
      trimStartMm: 0
    });
    expect(empty.error).toContain('裁片需求');
  });
});

describe('多料联排响应映射到 SavedScheme2D[] 与画布疵点转换', () => {
  const sampleResponse: MultiMaterialPlanResponse = {
    materialModel: 'MODEL-TC',
    totalRequestedPieces: 7,
    placedByRemnants: 2,
    placedByRoll: 5,
    unplacedPieces: 0,
    totalSavedAreaM2: 0.725,
    elapsedMs: 142,
    warnings: ['已跳过带疵但未登记疵点坐标的料头：REM-BAD'],
    remnantAllocations: [
      {
        remnantId: 'REM-A1',
        widthMm: 850,
        lengthMm: 1050,
        utilizationPct: 81.25,
        placedCount: 2,
        piecesAreaM2: 0.725,
        allocatedItems: [
          { demandId: 1, name: 'L型衣片', quantity: 1 },
          { demandId: 2, name: '袖口矩形片', quantity: 1 }
        ],
        placements: [
          {
            id: 1,
            demandId: 1,
            name: 'L型衣片',
            x: 0,
            y: 0,
            w: 500,
            l: 600,
            rotationDegrees: 0,
            rotated: false,
            polygon: samplePolygonShape.vertices,
            holes: samplePolygonShape.holes,
            sourceTaskId: 'TASK-001',
            sourceLineId: 11
          },
          {
            id: 2,
            demandId: 2,
            name: '袖口矩形片',
            x: 520,
            y: 0,
            w: 300,
            l: 400,
            rotationDegrees: 90,
            rotated: true,
            sourceTaskId: 'TASK-002',
            sourceLineId: 22
          }
        ],
        defects: [
          {
            id: 'D-REM-1',
            x: 100,
            y: 780,
            w: 80,
            h: 60,
            margin: 20,
            defectType: 'STAIN',
            typeName: '污渍'
          }
        ],
        materialModel: 'MODEL-TC',
        batchNo: 'BAT-A',
        color: '藏青'
      }
    ],
    rollOptions: [
      {
        rollId: 'ROLL-ALT-1800',
        widthMm: 1800,
        availableLengthMm: 35000,
        estimatedCutLengthMm: 1450,
        utilizationPct: 76.4,
        placedCount: 5,
        feasible: true,
        recommended: false,
        windowStartY: 500,
        totalLengthMm: 40000,
        placements: [
          {
            id: 1,
            demandId: 1,
            name: 'L型衣片',
            x: 0,
            y: 20,
            w: 500,
            l: 600,
            rotationDegrees: 180,
            rotated: false,
            polygon: samplePolygonShape.vertices
          }
        ],
        defects: [],
        rollModel: 'MODEL-TC',
        batchNo: 'BAT-A',
        color: '藏青'
      },
      {
        rollId: 'ROLL-REC-1600',
        widthMm: 1600,
        availableLengthMm: 40000,
        estimatedCutLengthMm: 1320.5,
        utilizationPct: 86.2,
        placedCount: 5,
        feasible: true,
        recommended: true,
        windowStartY: 1200.5,
        totalLengthMm: 42000,
        placements: [
          {
            id: 1,
            demandId: 1,
            name: 'L型衣片',
            x: 0,
            y: 20,
            w: 500,
            l: 600,
            rotationDegrees: 0,
            rotated: false,
            polygon: samplePolygonShape.vertices,
            holes: samplePolygonShape.holes,
            sourceTaskId: 'TASK-001',
            sourceLineId: 11
          }
        ],
        defects: [
          {
            id: 9,
            x: 680,
            y: 480,
            w: 90,
            h: 90,
            margin: 0,
            defectType: 'HOLE',
            typeName: '破洞'
          }
        ],
        rollModel: 'MODEL-TC',
        batchNo: 'BAT-A',
        color: '藏青'
      },
      {
        rollId: 'ROLL-TOO-SHORT',
        widthMm: 1500,
        availableLengthMm: 200,
        estimatedCutLengthMm: 0,
        utilizationPct: 0,
        placedCount: 0,
        feasible: false,
        recommended: false,
        windowStartY: 0,
        placements: [],
        defects: []
      }
    ]
  };

  it('按「料头接力 -> 推荐母卷置顶 -> 备选母卷」顺序生成标准 SavedScheme2D，跳过 0 件不可行卷', () => {
    const { schemes, summary } = mapMultiMaterialResponseToSchemes2D(sampleResponse, {
      demands: sampleDemands,
      fallbackMaterialModel: 'MODEL-TC',
      pieceGapMm: 4,
      trimStartMm: 20,
      batchId: 'MM-TEST',
      createdAt: '14:20:00'
    });

    expect(schemes).toHaveLength(3);

    // 第 1 张：料头接力 #1
    const remScheme = schemes[0];
    expect(remScheme.canvasMode).toBe('REMNANT');
    expect(remScheme.remnantId).toBe('REM-A1');
    expect(remScheme.multiMaterialRole).toBe('REMNANT_RELAY');
    expect(remScheme.multiMaterialRelayIndex).toBe(1);
    expect(remScheme.widthMm).toBe(850);
    expect(remScheme.canvasLengthMm).toBe(1050);
    expect(remScheme.title).toBe('料头接力 #1 · REM-A1（排入 2 件 · 利用率 81.3%）');
    expect(remScheme.result.layout.placements).toHaveLength(2);
    expect(remScheme.result.layout.placements[0].shape.type).toBe('POLYGON');
    expect(remScheme.result.layout.placements[0].shape.holes).toHaveLength(1);
    expect(remScheme.result.layout.placements[1].shape.type).toBe('RECTANGLE');
    expect(remScheme.defects).toHaveLength(1);
    expect(remScheme.defects![0].windowAligned).toBe(false);
    expect(remScheme.defects![0].margin).toBe(20);
    expect(remScheme.allocatedSummary).toBe('L型衣片×1、袖口矩形片×1');

    // 第 2 张：推荐母卷必须置顶于备选母卷之前
    const recRoll = schemes[1];
    expect(recRoll.canvasMode).toBe('STOCK_ROLL');
    expect(recRoll.rollId).toBe('ROLL-REC-1600');
    expect(recRoll.multiMaterialRole).toBe('ROLL_RECOMMENDED');
    expect(recRoll.strategyName).toBe('推荐母卷 · ROLL-REC-1600');
    expect(recRoll.windowStartY).toBe(1200.5);
    expect(recRoll.occupiedLengthMm).toBe(1320.5);
    expect(recRoll.complete).toBe(true);
    expect(recRoll.defects).toHaveLength(1);
    expect(recRoll.defects![0].windowAligned).toBe(true);
    expect(recRoll.defects![0].margin).toBe(0);
    expect(toBoardDefectsFromSchemeSnapshot(recRoll.defects)).toEqual([
      { id: 9, x: 680, y: 480, w: 90, h: 90, margin: 0, label: '破洞' }
    ]);

    // 第 3 张：备选母卷
    const altRoll = schemes[2];
    expect(altRoll.canvasMode).toBe('STOCK_ROLL');
    expect(altRoll.rollId).toBe('ROLL-ALT-1800');
    expect(altRoll.multiMaterialRole).toBe('ROLL_ALTERNATIVE');
    expect(altRoll.strategyName).toBe('备选母卷 · ROLL-ALT-1800');
    expect(altRoll.windowStartY).toBe(500);

    // 汇总信息校验
    expect(summary.placedByRemnants).toBe(2);
    expect(summary.placedByRoll).toBe(5);
    expect(summary.unplacedPieces).toBe(0);
    expect(summary.recommendedRollId).toBe('ROLL-REC-1600');
    expect(summary.totalSavedAreaM2).toBe(0.725);
    expect(summary.warnings).toHaveLength(1);
  });

  it('防色差候选母卷筛选按同型适配置顶，强同缸约束拦截异缸与未登记缸号母卷', () => {
    const opts = buildMultiMaterialCandidateRollOptions(
      [
        {
          rollId: 'R-OTHER-BATCH',
          rollModel: 'MODEL-TC',
          width: 1600,
          currentRemainingLength: 30000,
          batchNo: 'BAT-B',
          color: '藏青'
        },
        {
          rollId: 'R-NO-BATCH',
          rollModel: 'MODEL-TC',
          width: 1600,
          currentRemainingLength: 25000,
          batchNo: '',
          color: '藏青'
        },
        {
          rollId: 'R-MATCH',
          rollModel: 'MODEL-TC',
          width: 1650,
          currentRemainingLength: 20000,
          batchNo: 'BAT-A',
          color: '藏青'
        }
      ],
      {
        materialModel: 'MODEL-TC',
        requiredBatchNo: 'BAT-A',
        requiredColor: '藏青',
        strictBatchMatch: true
      }
    );

    expect(opts[0].rollId).toBe('R-MATCH');
    expect(opts[0].eligible).toBe(true);
    expect(opts[0].blockedByStrict).toBe(false);

    const otherBatch = opts.find((o) => o.rollId === 'R-OTHER-BATCH')!;
    expect(otherBatch.eligible).toBe(false);
    expect(otherBatch.blockedByStrict).toBe(true);
    expect(otherBatch.mismatchReason).toContain('异缸');

    const noBatch = opts.find((o) => o.rollId === 'R-NO-BATCH')!;
    expect(noBatch.blockedByStrict).toBe(true);
    expect(noBatch.mismatchReason).toContain('未登记缸号');
  });

  it('导出联排 CSV 包含 UTF-8 BOM、起切位与防公式注入转义', () => {
    const injected: MultiMaterialPlanResponse = {
      ...sampleResponse,
      remnantAllocations: [
        {
          ...sampleResponse.remnantAllocations[0],
          remnantId: '=CMD|REM-1',
          allocatedItems: [{ demandId: 1, name: '+危险片', quantity: 2 }]
        }
      ]
    };

    const csv = buildMultiMaterialCsvText(injected);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"类别","材料编号","品号","门幅(mm)","长度/可用余长(mm)","起切位Y(mm)","预计切长(mm)","利用率(%)","排入件数","状态/明细"');
    expect(csv).toContain('"\'=CMD|REM-1"');
    expect(csv).toContain('"\'+危险片×2"');
    expect(csv).toContain('"ROLL-REC-1600"');
    expect(csv).toContain('"1200.5"');
    expect(csv).toContain('"推荐首选"');
    expect(csv).toContain('"长度或门幅不足"');
  });
});
