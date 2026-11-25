import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STUDIO_SETTINGS,
  buildSlittingPhysicalConstraintFields,
  extractSlittingSolverOptions,
  validateSlittingPhysicalConstraints
} from '../../../store/studioSettings';
import {
  buildSlittingOptimizationRequest,
  extractSlittingKnifeMetrics,
  shouldPersistConfirm2DShape
} from '../useWorkbenchSolver';
import {
  annotateBoardPiecesWithReinspection,
  computeTaskExecutionProjection
} from '../../CuttingWorkbenchPage';
import { receiptSummary, effectivePieceResults } from '../../../lib/model/quality.js';
import type { BoardPlacedPiece } from '../../../components/WorkbenchBoardCanvas';

describe('一维物理刀架硬约束请求体构建与换刀结果提取', () => {
  const sampleOrders = [
    { id: '1', name: '宽条A', widthMm: 1080, lengthMm: 2000, quantity: 10 },
    { id: '2', name: '宽条B', widthMm: 760, lengthMm: 2000, quantity: 12 }
  ];

  it('默认物理约束全部为 0 或未配置时，problem 不注入物理刀架字段（零回归兼容）', () => {
    expect(
      validateSlittingPhysicalConstraints(
        {
          maxKnives: 0,
          minBladeSpacingMm: 0,
          kerfMm: 0,
          forbiddenNarrowEdgeMinMm: 0,
          forbiddenNarrowEdgeMaxMm: 0
        },
        760
      )
    ).toBeNull();

    const req = buildSlittingOptimizationRequest({
      profile: 'FAST',
      motherWidthMm: 4600,
      leftTrimMm: 100,
      rightTrimMm: 100,
      minWidthMm: 4300,
      maxWidthMm: 4400,
      widthStepMm: 10,
      totalOverCap: 30,
      timeLimitSeconds: 30,
      fixedLengthMm: 2000,
      orders: sampleOrders,
      advOpts: extractSlittingSolverOptions(DEFAULT_STUDIO_SETTINGS),
      physicalConstraints: {
        maxKnives: 0,
        minBladeSpacingMm: 0,
        kerfMm: 0,
        forbiddenNarrowEdgeMinMm: 0,
        forbiddenNarrowEdgeMaxMm: 0
      },
      clientRequestId: 'slit-test-default'
    });

    expect(req.problemType).toBe('SLITTING_1D');
    expect(req.problem).not.toHaveProperty('maxKnives');
    expect(req.problem).not.toHaveProperty('minBladeSpacingMm');
    expect(req.problem).not.toHaveProperty('kerfMm');
    expect(req.problem).not.toHaveProperty('forbiddenNarrowEdgeMinMm');
    expect(req.problem).not.toHaveProperty('forbiddenNarrowEdgeMaxMm');
  });

  it('配置正值物理刀架约束时，按 SlittingProblem.java 精确字段名透传到 SLITTING_1D problem', () => {
    const physical = {
      maxKnives: 6,
      minBladeSpacingMm: 120,
      kerfMm: 4,
      forbiddenNarrowEdgeMinMm: 5,
      forbiddenNarrowEdgeMaxMm: 35
    };
    expect(validateSlittingPhysicalConstraints(physical, 760)).toBeNull();
    expect(buildSlittingPhysicalConstraintFields(physical)).toEqual(physical);

    const req = buildSlittingOptimizationRequest({
      profile: 'QUALITY',
      motherWidthMm: 4600,
      leftTrimMm: 100,
      rightTrimMm: 100,
      minWidthMm: 4200,
      maxWidthMm: 4400,
      widthStepMm: 10,
      totalOverCap: 20,
      timeLimitSeconds: 60,
      fixedLengthMm: 2000,
      orders: sampleOrders,
      advOpts: extractSlittingSolverOptions(DEFAULT_STUDIO_SETTINGS),
      physicalConstraints: physical,
      clientRequestId: 'slit-test-physical'
    });

    expect(req.problem.maxKnives).toBe(6);
    expect(req.problem.minBladeSpacingMm).toBe(120);
    expect(req.problem.kerfMm).toBe(4);
    expect(req.problem.forbiddenNarrowEdgeMinMm).toBe(5);
    expect(req.problem.forbiddenNarrowEdgeMaxMm).toBe(35);
  });

  it('危险细边丝禁区允许下限=0、上限>0，但拦截单填下限或下限大于上限或最小刀距大于订单宽', () => {
    expect(
      buildSlittingPhysicalConstraintFields({
        forbiddenNarrowEdgeMinMm: 0,
        forbiddenNarrowEdgeMaxMm: 25
      })
    ).toEqual({
      forbiddenNarrowEdgeMinMm: 0,
      forbiddenNarrowEdgeMaxMm: 25
    });

    expect(
      validateSlittingPhysicalConstraints({
        forbiddenNarrowEdgeMinMm: 15,
        forbiddenNarrowEdgeMaxMm: 0
      })
    ).toContain('上限');

    expect(
      validateSlittingPhysicalConstraints({
        forbiddenNarrowEdgeMinMm: 40,
        forbiddenNarrowEdgeMaxMm: 20
      })
    ).toContain('不能大于');

    expect(
      validateSlittingPhysicalConstraints({ minBladeSpacingMm: 800 }, 760)
    ).toContain('小于机台最小物理刀距');
  });

  it('从后端 SlittingResult 准确提取 estimatedKnifeChanges 与 knifeChangesSaved（含合法 0 值）', () => {
    expect(
      extractSlittingKnifeMetrics({ estimatedKnifeChanges: 4, knifeChangesSaved: 3 })
    ).toEqual({ estimatedKnifeChanges: 4, knifeChangesSaved: 3 });

    expect(
      extractSlittingKnifeMetrics({ estimatedKnifeChanges: 0, knifeChangesSaved: 0 })
    ).toEqual({ estimatedKnifeChanges: 0, knifeChangesSaved: 0 });

    expect(extractSlittingKnifeMetrics({})).toEqual({
      estimatedKnifeChanges: null,
      knifeChangesSaved: null
    });
  });
});

describe('工作台报工与复检判废实绩投影（与质检页 / 履约账本 100% 同源口径）', () => {
  it('聚合任务报工净合格件、复检判废扣回与待补排余量，且自动忽略已冲销报工与已撤销复检', () => {
    const activeReport = {
      reportId: 'PLAN-101',
      planId: 'PLAN-101',
      schemeId: 'SCH-001',
      taskId: 'TASK-A',
      status: 'CONFIRMED',
      pieceResults: [
        { pieceId: 1, demandId: 1, name: '客厅主帘', outcome: 'QUALIFIED', w: 800, l: 1200 },
        { pieceId: 2, demandId: 1, name: '客厅主帘', outcome: 'QUALIFIED', w: 800, l: 1200 },
        { pieceId: 3, demandId: 2, name: '短帘', outcome: 'QUALIFIED', w: 600, l: 900 },
        { pieceId: 4, demandId: 2, name: '短帘', outcome: 'REJECTED', w: 600, l: 900 }
      ],
      qualityDispositions: [
        {
          id: 'DISP-1',
          command: { pieceId: 2, disposition: 'SCRAP', inspector: '质检甲', reason: '抽丝破损' }
        },
        {
          id: 'DISP-2',
          command: { pieceId: 3, disposition: 'REMNANT', inspector: '质检甲', reason: '角部污渍转料头' },
          revocation: { operator: '主管', reason: '误判撤销' }
        }
      ]
    };
    const reversedReport = {
      reportId: 'PLAN-REV',
      planId: 'PLAN-REV',
      schemeId: 'SCH-OLD',
      taskId: 'TASK-A',
      status: 'REVERSED',
      pieceResults: [{ pieceId: 1, demandId: 1, name: '冲销片', outcome: 'QUALIFIED', w: 500, l: 500 }],
      qualityDispositions: []
    };

    const projection = computeTaskExecutionProjection({
      taskId: 'TASK-A',
      rawReports: [activeReport, reversedReport],
      openRemainingCount: 3
    });

    // 与 ReconciliationPage 使用的 receiptSummary 校验 100% 一致
    const expectedFromQuality = receiptSummary(activeReport, effectivePieceResults);
    expect(projection).not.toBeNull();
    expect(projection!.reportCount).toBe(1);
    expect(projection!.netQualifiedCount).toBe(expectedFromQuality.qualified); // 2 片（#1 与已撤销复检的 #3）
    expect(projection!.rejectedTotalCount).toBe(expectedFromQuality.rejected); // 2 片（复检判废 #2 + 初始不良 #4）
    expect(projection!.reinspectionDisposedTotal).toBe(expectedFromQuality.dispositions); // 1 片生效复检处置
    expect(projection!.reinspectionScrapCount).toBe(1);
    expect(projection!.reinspectionRemnantCount).toBe(0);
    expect(projection!.openRemainingCount).toBe(3);

    const schemeExec = projection!.bySchemeId.get('SCH-001');
    expect(schemeExec).toBeDefined();
    expect(schemeExec!.disposedPieces.has(2)).toBe(true);
    expect(schemeExec!.disposedPieces.has(3)).toBe(false); // 已撤销不标注

    // 画布裁片标注：对已判废的 pieceId=2 打上「复检判废」标签并刷新签名 ID
    const pieces: BoardPlacedPiece[] = [
      { id: 1, index: 0, demandId: 1, demandKey: '1', name: '客厅主帘', x: 0, y: 0, width: 800, height: 1200 },
      { id: 2, index: 1, demandId: 1, demandKey: '1', name: '客厅主帘', x: 800, y: 0, width: 800, height: 1200 },
      { id: 3, index: 2, demandId: 2, demandKey: '2', name: '短帘', x: 0, y: 1200, width: 600, height: 900 }
    ];
    const annotated = annotateBoardPiecesWithReinspection(pieces, schemeExec);
    expect(annotated[0].name).toBe('客厅主帘');
    expect(annotated[1].name).toBe('[复检判废] 客厅主帘');
    expect(annotated[1].id).toBe('2-REINSPECTED');
    expect(annotated[2].name).toBe('短帘');
  });

  it('报工记录未携带 schemeId 时可通过 taskSchemes.linkedPlanIds 准确回溯方案并标注转料头判废片', () => {
    const rawReport = {
      planId: 'PLAN-LINKED-9',
      taskId: 'TASK-B',
      status: 'CONFIRMED',
      pieceResults: [
        { pieceId: 1, demandId: 1, name: '飘窗帘', outcome: 'QUALIFIED', w: 600, l: 900 }
      ],
      qualityDispositions: [
        {
          id: 'DISP-9',
          command: { pieceId: 1, disposition: 'REMNANT', inspector: '质检乙', reason: '色差转料头' }
        }
      ]
    };

    const projection = computeTaskExecutionProjection({
      taskId: 'TASK-B',
      rawReports: [rawReport],
      taskSchemes: [{ id: 'SCH-LINKED-9', linkedPlanIds: ['PLAN-LINKED-9'] }],
      openRemainingCount: 1
    });

    const schemeExec = projection?.bySchemeId.get('SCH-LINKED-9');
    expect(schemeExec).toBeDefined();
    expect(projection!.reinspectionRemnantCount).toBe(1);
    expect(projection!.netQualifiedCount).toBe(0);

    const pieces: BoardPlacedPiece[] = [
      { id: 'm-1', index: 0, demandId: 1, demandKey: '1', name: '飘窗帘', x: 0, y: 0, width: 600, height: 900 }
    ];
    const annotated = annotateBoardPiecesWithReinspection(pieces, schemeExec);
    expect(annotated[0].name).toBe('[复检判废·转料头] 飘窗帘');
  });

  it('2D 方案确认落库同时兼容 POLYGON 与带内孔 holes 的矩形外壳，保证 shape.holes 不被剥离', () => {
    const rectWithoutHole = [{ shape: { type: 'RECTANGLE', width: 600, height: 800 } }];
    const rectWithHole = [
      {
        shape: {
          type: 'RECTANGLE',
          width: 600,
          height: 800,
          holes: [[{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }]]
        }
      }
    ];
    const polygonDemand = [{ shape: { type: 'POLYGON', width: 500, height: 700 } }];

    expect(shouldPersistConfirm2DShape(rectWithoutHole)).toBe(false);
    expect(shouldPersistConfirm2DShape(rectWithHole)).toBe(true);
    expect(shouldPersistConfirm2DShape(polygonDemand)).toBe(true);
    expect(shouldPersistConfirm2DShape(rectWithoutHole, rectWithHole)).toBe(true);
  });
});
