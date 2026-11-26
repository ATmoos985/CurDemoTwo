import { describe, expect, it } from 'vitest';
import {
  buildCompleteSchemeIdempotencyKey,
  buildConfirm1DIdempotencyKey,
  buildConfirm2DIdempotencyKey,
  buildSourceAllocations1D,
  buildSourceAllocations2D,
  buildValidateLayoutPayload,
  computeDeterministicIdempotencyKey
} from './schemeConfirmUtils';
import type { DemandItem, SavedScheme2D, SlittingOrderLine, SlittingSchemeRun } from '../../store/useStudioStore';

const makeScheme2D = (overrides: Partial<SavedScheme2D> = {}): SavedScheme2D => ({
  id: 'CAND-JAVA_FAST-abcd',
  title: '快速基线 (1800×2400mm)',
  strategyId: 'JAVA_FAST',
  strategyName: '快速基线',
  scenarioId: 'SHORTEN_KIT',
  createdAt: '10:00:00',
  canvasMode: 'FREE_CANVAS',
  windowStartY: 0,
  materialModel: 'MAT-A',
  widthMm: 1800,
  canvasLengthMm: 2400,
  occupiedLengthMm: 1600,
  utilizationPct: 82.5,
  pieceAreaM2: 2.376,
  placedCount: 4,
  requestedCount: 4,
  complete: true,
  demands: [
    { id: 1, name: '门板A', width: 600, length: 800, quantity: 2, allowRotation: true },
    { id: 2, name: '侧板B', width: 500, length: 700, quantity: 2, allowRotation: false }
  ],
  request: {},
  result: {
    layout: {
      placements: [
        { id: 1, demandId: 1, name: '门板A', x: 0, y: 0, w: 600, l: 800, rotationDegrees: 0 },
        { id: 2, demandId: 2, name: '侧板B', x: 600, y: 0, w: 500, l: 700, rotationDegrees: 0 }
      ],
      cuts: [],
      leftovers: []
    },
    marker: { gapFillPlacements: [] }
  },
  ...overrides
});

const makeScheme1D = (overrides: Partial<SlittingSchemeRun> = {}): SlittingSchemeRun => ({
  id: 'SLIT-FAST',
  strategyId: 'FAST',
  strategyName: '快捷解',
  state: 'SUCCEEDED',
  motherWidthMm: 4600,
  leftTrimMm: 100,
  rightTrimMm: 100,
  totalCars: 5,
  missingRolls: 0,
  overproducedRolls: 0,
  avgUtilizationPct: 95.65,
  patterns: [
    {
      id: 'P1',
      lengthMm: 2000,
      repetitions: 3,
      stations: [
        { widthMm: 1080, countPerRepetition: 2 },
        { widthMm: 1120, countPerRepetition: 2 }
      ],
      usedWidthMm: 4400,
      spareWidthMm: 0
    }
  ],
  fulfillment: [
    { orderId: '1', name: '客户A', widthMm: 1080, requested: 6, produced: 6, missing: 0, overproduced: 0 },
    { orderId: '2', name: '客户B', widthMm: 1120, requested: 6, produced: 6, missing: 0, overproduced: 0 }
  ],
  ...overrides
});

describe('确定性幂等键生成（1D / 2D / 完工核销）', () => {
  it('规范化序列化忽略对象键顺序，确保相同内容生成相同幂等键', () => {
    const k1 = computeDeterministicIdempotencyKey('TEST', { b: 2, a: 1, nested: { y: 'hi', x: true } });
    const k2 = computeDeterministicIdempotencyKey('TEST', { a: 1, nested: { x: true, y: 'hi' }, b: 2 });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^TEST-[0-9a-f]{16}$/);
  });

  it('1D 确认幂等键完全确定性（不含时间戳抖动），内容变化后立即变化', () => {
    const scheme = makeScheme1D();
    const keyA = buildConfirm1DIdempotencyKey({
      scheme,
      taskId: 'TASK-1D-01',
      materialMode: 'VIRTUAL_ROLL',
      fixedLengthMm: 2000,
      avoidDefects: false
    });
    const keyB = buildConfirm1DIdempotencyKey({
      scheme: structuredClone(scheme),
      taskId: 'TASK-1D-01',
      materialMode: 'VIRTUAL_ROLL',
      fixedLengthMm: 2000,
      avoidDefects: false
    });
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^CONFIRM-1D-[0-9a-f]{16}$/);

    const keyDifferentCars = buildConfirm1DIdempotencyKey({
      scheme: makeScheme1D({ totalCars: 6 }),
      taskId: 'TASK-1D-01',
      materialMode: 'VIRTUAL_ROLL',
      fixedLengthMm: 2000,
      avoidDefects: false
    });
    expect(keyDifferentCars).not.toBe(keyA);
  });

  it('2D 确认幂等键与临时候选 ID 无关，仅绑定真实排布与参数内容', () => {
    const placements = [
      { demandId: 1, x: 0, y: 0, w: 600, l: 800, rotationDegrees: 0, gapFill: false },
      { demandId: 2, x: 600, y: 0, w: 500, l: 700, rotationDegrees: 0, gapFill: false }
    ];
    const k1 = buildConfirm2DIdempotencyKey({
      scheme: makeScheme2D({ id: 'CAND-RUN-1111' }),
      taskId: 'TASK-2D-01',
      trimStartMm: 0,
      pieceGapMm: 0,
      placements
    });
    const k2 = buildConfirm2DIdempotencyKey({
      scheme: makeScheme2D({ id: 'CAND-RUN-9999' }),
      taskId: 'TASK-2D-01',
      trimStartMm: 0,
      pieceGapMm: 0,
      placements
    });
    expect(k1).toBe(k2);

    const kMoved = buildConfirm2DIdempotencyKey({
      scheme: makeScheme2D({ id: 'CAND-RUN-9999' }),
      taskId: 'TASK-2D-01',
      trimStartMm: 0,
      pieceGapMm: 0,
      placements: [
        { demandId: 1, x: 10, y: 0, w: 600, l: 800, rotationDegrees: 0, gapFill: false },
        placements[1]
      ]
    });
    expect(kMoved).not.toBe(k1);
  });

  it('一键完工核销幂等键稳定且对废片列表顺序不敏感', () => {
    const k1 = buildCompleteSchemeIdempotencyKey({
      schemeId: 'SCH-001',
      customMode: true,
      actualCutLenMm: 1650,
      rejectedPieceIds: [5, 2, 9],
      recoverRemnants: true,
      remnantLocation: 'A-01'
    });
    const k2 = buildCompleteSchemeIdempotencyKey({
      schemeId: 'SCH-001',
      customMode: true,
      actualCutLenMm: 1650,
      rejectedPieceIds: [9, 5, 2],
      recoverRemnants: true,
      remnantLocation: 'A-01'
    });
    expect(k1).toBe(k2);
  });
});

describe('多族合排 sourceAllocations 汇总构造', () => {
  it('2D 多族合排按真实排入数量汇总（忽略补空片），且清空顶层 taskId', () => {
    const demands: DemandItem[] = [
      { id: 1, name: '族A · 前片', width: 500, length: 700, quantity: 3, allowRotation: false, sourceTaskId: 'TASK-A', sourceTaskName: '族A', sourceLineId: 10 },
      { id: 2, name: '族A · 后片', width: 500, length: 700, quantity: 2, allowRotation: false, sourceTaskId: 'TASK-A', sourceTaskName: '族A', sourceLineId: 11 },
      { id: 3, name: '族B · 门板', width: 600, length: 900, quantity: 4, allowRotation: true, sourceTaskId: 'TASK-B', sourceTaskName: '族B', sourceLineId: 1 }
    ];
    const placements = [
      { demandId: 1, gapFill: false },
      { demandId: 1, gapFill: false },
      { demandId: 3, gapFill: false },
      { demandId: 3, gapFill: false },
      { demandId: 3, gapFill: false },
      { demandId: 2, gapFill: true } // 补空备片不扣减正单 sourceAllocations
    ];

    const summary = buildSourceAllocations2D(placements, demands, null);
    expect(summary.isMultiFamily).toBe(true);
    expect(summary.resolvedTaskId).toBeUndefined();
    expect(summary.shouldSendSourceAllocations).toBe(true);
    expect(summary.allocations).toEqual([
      { taskId: 'TASK-A', lineId: 10, quantity: 2 },
      { taskId: 'TASK-B', lineId: 1, quantity: 3 }
    ]);
  });

  it('2D 单任务载入保持 taskId 兼容，不干扰单任务旧路径', () => {
    const demands: DemandItem[] = [
      { id: 1, name: '主帘', width: 1000, length: 1200, quantity: 2, allowRotation: false, sourceTaskId: 'TASK-SINGLE', sourceLineId: 1 }
    ];
    const summary = buildSourceAllocations2D(
      [{ demandId: 1 }, { demandId: 1 }],
      demands,
      'TASK-SINGLE'
    );
    expect(summary.isMultiFamily).toBe(false);
    expect(summary.resolvedTaskId).toBe('TASK-SINGLE');
    expect(summary.shouldSendSourceAllocations).toBe(false);
    expect(summary.allocations).toEqual([{ taskId: 'TASK-SINGLE', lineId: 1, quantity: 2 }]);
  });

  it('1D 多族合排按真实产出且不超过待排余量汇总 sourceAllocations', () => {
    const orders: SlittingOrderLine[] = [
      { id: '1', name: '族1 · 1080mm', widthMm: 1080, lengthMm: 2000, quantity: 5, sourceTaskId: 'T-1D-A', sourceLineId: 1 },
      { id: '2', name: '族2 · 920mm', widthMm: 920, lengthMm: 2000, quantity: 8, sourceTaskId: 'T-1D-B', sourceLineId: 2 }
    ];
    const summary = buildSourceAllocations1D(
      [
        { orderId: '1', produced: 7 }, // 超产 2 卷，扣减不超过 openQty=5
        { orderId: '2', produced: 6 }
      ],
      orders,
      null
    );
    expect(summary.isMultiFamily).toBe(true);
    expect(summary.resolvedTaskId).toBeUndefined();
    expect(summary.shouldSendSourceAllocations).toBe(true);
    expect(summary.allocations).toEqual([
      { taskId: 'T-1D-A', lineId: 1, quantity: 5 },
      { taskId: 'T-1D-B', lineId: 2, quantity: 6 }
    ]);
  });

  it('validate-layout 请求载荷严格包含契约约定的全部字段', () => {
    const scheme = makeScheme2D({ rollId: 'ROLL-01', windowStartY: 500 });
    const payload = buildValidateLayoutPayload({
      scheme,
      demands: scheme.demands,
      trimStartMm: 30,
      pieceGapMm: 5,
      defects: [{ id: 1, x: 100, y: 120, w: 40, h: 40 }],
      defaultDefectMarginMm: 20
    });
    expect(payload.materialWidthMm).toBe(1800);
    expect(payload.materialLengthMm).toBe(2400);
    expect(payload.trimStartMm).toBe(30);
    expect(payload.pieceGapMm).toBe(5);
    expect(payload.avoidDefects).toBe(true);
    expect(payload.rollId).toBe('ROLL-01');
    expect(payload.windowStartY).toBe(500);
    expect(payload.defects[0].margin).toBe(20);
    expect(payload.placements).toHaveLength(2);
    expect(payload.demands).toHaveLength(2);
  });
});
