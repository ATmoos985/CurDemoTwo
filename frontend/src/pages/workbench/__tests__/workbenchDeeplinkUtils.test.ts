import { describe, expect, it } from 'vitest';
import type { DemandFamilySummary } from '../../../store/studioTypes';
import {
  computeShapeNetAreaMm2,
  mapResultContextToWorkbenchPlan,
  resolveRectGapPaddingMm,
  type WorkbenchResultContextDto,
  type WorkbenchSchemeDraftDto
} from '../workbenchDeeplinkUtils';

describe('workbenchDeeplinkUtils 外部试排结果与持久化草案映射', () => {
  it('2D 直刀矩形方案正确还原 rectGapPaddingMm 并与母卷工位口径完全对齐', () => {
    const family: DemandFamilySummary = {
      id: 'TASK-RECT-01',
      name: '窗帘直刀测试单',
      materialModel: 'M-2000',
      dimension: 'RECT_2D',
      revision: 3,
      orderedTotal: 2,
      plannedTotal: 0,
      completedTotal: 0,
      openTotal: 2,
      schemeCount: 0,
      status: 'OPEN',
      lines: [
        {
          id: 1,
          name: '主幅 A',
          width: 600,
          length: 800,
          orderedQty: 2,
          plannedQty: 0,
          completedQty: 0,
          openQty: 2,
          allowRotation: true
        }
      ]
    };

    // 后端在直刀模式下按 pieceGap=10mm 对母卷(1500x2000)与裁片(600x800)外扩为 1510x2010 与 610x810
    const context: WorkbenchResultContextDto = {
      resultId: 'JOB-RECT-101',
      job: { id: 'JOB-RECT-101', state: 'SUCCEEDED', elapsedMs: 120 },
      source: {
        taskId: 'TASK-RECT-01',
        taskName: '窗帘直刀测试单',
        materialType: 'STOCK_ROLL',
        materialId: 'ROLL-2026-0920',
        materialModel: 'M-2000',
        widthMm: 1500,
        windowStartMm: 350,
        windowLengthMm: 2000,
        pieceGapMm: 10,
        rectGapPaddingMm: 10,
        trimStartMm: 20,
        processMode: 'GUILLOTINE'
      },
      input: {
        schemaVersion: '2.0',
        problemType: 'NESTING_2D',
        problem: {
          schemaVersion: '1',
          unit: 'mm',
          material: {
            id: 'ROLL-2026-0920',
            shape: { type: 'RECTANGLE', width: 1510, height: 2010 },
            exclusions: [
              {
                id: 1,
                x: 1300,
                y: 900,
                shape: { type: 'RECTANGLE', width: 120, height: 80 },
                clearance: 0
              }
            ]
          },
          parts: [
            {
              id: 1,
              name: '主幅 A',
              quantity: 2,
              allowRotation: true,
              shape: { type: 'RECTANGLE', width: 610, height: 810 }
            }
          ],
          process: {
            mode: 'GUILLOTINE',
            trimStart: 20,
            pieceGap: 0
          }
        }
      },
      result: {
        id: 'JOB-RECT-101',
        fulfillmentStatus: 'COMPLETE',
        layout: {
          status: 'FEASIBLE',
          processingRegion: { type: 'RECTANGLE', width: 1510, height: 2010 },
          placements: [
            {
              id: 1,
              demandId: 1,
              name: '主幅 A',
              x: 0,
              y: 20,
              rotationDegrees: 0,
              shape: { type: 'RECTANGLE', width: 610, height: 810 }
            },
            {
              id: 2,
              demandId: 1,
              name: '主幅 A',
              x: 610,
              y: 20,
              rotationDegrees: 90,
              shape: { type: 'RECTANGLE', width: 810, height: 610 }
            }
          ],
          leftovers: [
            {
              id: 'L-1',
              x: 0,
              y: 830,
              shape: { type: 'RECTANGLE', width: 1510, height: 1180 },
              hasDefect: false
            }
          ],
          cuts: [
            {
              sequence: 1,
              kind: 'THROUGH_H',
              startX: 0,
              startY: 830,
              endX: 1510,
              endY: 830
            }
          ]
        },
        marker: {
          occupiedLengthMm: 830
        }
      }
    };

    expect(resolveRectGapPaddingMm(context)).toBe(10);

    const mapped = mapResultContextToWorkbenchPlan(context, null, family, {
      nowMs: Date.parse('2026-11-26T10:00:00Z'),
      createdAtLabel: '18:00:00'
    });

    expect(mapped.error).toBeNull();
    expect(mapped.dimension).toBe('2D');
    expect(mapped.rectGapPaddingMm).toBe(10);
    expect(mapped.scheme2D).not.toBeNull();

    const scheme = mapped.scheme2D!;
    expect(scheme.id).toBe('EXT-2D-JOB-RECT-101');
    expect(scheme.canvasMode).toBe('STOCK_ROLL');
    expect(scheme.rollId).toBe('ROLL-2026-0920');
    expect(scheme.windowStartY).toBe(350);
    expect(scheme.widthMm).toBe(1500);
    expect(scheme.complete).toBe(true);
    expect(scheme.placedCount).toBe(2);
    expect(scheme.requestedCount).toBe(2);

    // 还原后的第 1 片 0°: 600x800，第 2 片 90°: 800x600；绝不是外扩后的 610/810
    const pls = scheme.result.layout.placements;
    expect(pls[0].shape).toEqual({ type: 'RECTANGLE', width: 600, height: 800 });
    expect(pls[1].shape).toEqual({ type: 'RECTANGLE', width: 800, height: 600 });
    // 物理占长按还原后最大 y + height = 20 + 800 = 820mm（不虚增 10mm 外扩间隙）
    expect(scheme.occupiedLengthMm).toBe(820);
    // 净面积 = 2 * 600 * 800 = 960,000 mm² = 0.96 m²；利用率 = 960000 / (1500 * 820) = 78.05%
    expect(scheme.pieceAreaM2).toBe(0.96);
    expect(scheme.utilizationPct).toBe(78.05);

    // 余料与刀路应裁剪回原始 1500x2000 净范围
    expect(scheme.result.layout.leftovers[0].shape.width).toBe(1500);
    expect(scheme.result.layout.leftovers[0].shape.height).toBe(1170);
    expect(scheme.result.layout.cuts[0].endX).toBe(1500);

    // 疵点快照转为已对齐窗口坐标
    expect(scheme.defects).toHaveLength(1);
    expect(scheme.defects?.[0]).toMatchObject({ x: 1300, y: 900, w: 120, h: 80, windowAligned: true });

    // 画布补丁与需求来源关联正确
    expect(mapped.canvasPatch2D).toMatchObject({
      activeDimension: '2D',
      canvasMode: 'STOCK_ROLL',
      selectedRollId: 'ROLL-2026-0920',
      windowStartY2D: 350,
      canvasWidthMm: 1500,
      canvasLengthMm: 2000,
      pieceGapMm: 10,
      trimStartMm: 20
    });
    expect(scheme.demands[0]).toMatchObject({
      id: 1,
      width: 600,
      length: 800,
      sourceTaskId: 'TASK-RECT-01',
      sourceLineId: 1
    });
    expect(mapped.banner).toMatchObject({
      resultId: 'JOB-RECT-101',
      draftId: null,
      fulfillmentStatus: 'COMPLETE',
      fulfillmentLabel: '齐套可排齐',
      stale: false,
      expired: false
    });
    expect(mapped.banner.materialLabel).toContain('ROLL-2026-0920');
    expect(mapped.banner.materialLabel).toContain('Y=350mm');
  });

  it('直刀模式未显式返回 rectGapPaddingMm 但存在 pieceGapMm 外扩时自动推导还原', () => {
    const context: WorkbenchResultContextDto = {
      resultId: 'JOB-RECT-INFER',
      source: {
        materialType: 'FREE_CANVAS',
        widthMm: 1000,
        windowLengthMm: 1000,
        pieceGapMm: 8,
        processMode: 'GUILLOTINE'
      },
      input: {
        problemType: 'NESTING_2D',
        problem: {
          material: { shape: { type: 'RECTANGLE', width: 1008, height: 1008 } },
          parts: [
            {
              id: 1,
              name: '小片',
              quantity: 1,
              shape: { type: 'RECTANGLE', width: 408, height: 508 }
            }
          ],
          process: { mode: 'GUILLOTINE', pieceGap: 0 }
        }
      },
      result: {
        fulfillmentStatus: 'COMPLETE',
        layout: {
          placements: [
            {
              id: 1,
              demandId: 1,
              name: '小片',
              x: 0,
              y: 0,
              rotationDegrees: 0,
              shape: { type: 'RECTANGLE', width: 408, height: 508 }
            }
          ]
        }
      }
    };

    const mapped = mapResultContextToWorkbenchPlan(context);
    expect(mapped.rectGapPaddingMm).toBe(8);
    expect(mapped.scheme2D?.result.layout.placements[0].shape).toEqual({
      type: 'RECTANGLE',
      width: 400,
      height: 500
    });
    expect(mapped.scheme2D?.occupiedLengthMm).toBe(500);
  });

  it('2D 异形带内孔方案保留顶点与内孔、扣除孔面积且过滤合成修边禁区', () => {
    const outerVerts = [
      { x: 0, y: 0 },
      { x: 500, y: 0 },
      { x: 500, y: 400 },
      { x: 0, y: 400 }
    ];
    const holeRing = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
      { x: 100, y: 200 }
    ];
    const polyWithHole = {
      type: 'POLYGON' as const,
      width: 500,
      height: 400,
      vertices: outerVerts,
      holes: [holeRing]
    };

    // 500*400 - 200*100 = 180,000 mm²
    expect(computeShapeNetAreaMm2(polyWithHole)).toBe(180_000);

    const context: WorkbenchResultContextDto = {
      resultId: 'JOB-POLY-202',
      source: {
        taskId: 'TASK-POLY-01',
        materialType: 'REMNANT',
        materialId: 'REM-88',
        materialModel: 'LEATHER-A',
        widthMm: 1200,
        windowLengthMm: 1000,
        pieceGapMm: 5,
        trimStartMm: 30,
        processMode: 'CONTOUR'
      },
      input: {
        problemType: 'NESTING_2D',
        problem: {
          material: {
            id: 'REM-88',
            shape: { type: 'RECTANGLE', width: 1200, height: 1000 },
            exclusions: [
              // 顶部真实疵点（非全宽修边条）
              {
                id: 1,
                x: 800,
                y: 200,
                shape: { type: 'RECTANGLE', width: 100, height: 100 }
              }
            ]
          },
          parts: [
            {
              id: 10,
              name: '门板挖孔件',
              quantity: 1,
              allowRotation: false,
              allowHalfTurn: true,
              shape: polyWithHole
            }
          ],
          process: { mode: 'CONTOUR', pieceGap: 5, trimStart: 0 }
        }
      },
      result: {
        fulfillmentStatus: 'COMPLETE',
        layout: {
          processingRegion: { type: 'RECTANGLE', width: 1200, height: 1000 },
          placements: [
            {
              id: 1,
              demandId: 10,
              name: '门板挖孔件',
              x: 20,
              y: 40,
              rotationDegrees: 180,
              shape: polyWithHole
            }
          ],
          leftovers: [],
          cuts: []
        },
        marker: {
          occupiedLengthMm: 440
        }
      }
    };

    const mapped = mapResultContextToWorkbenchPlan(context);
    expect(mapped.error).toBeNull();
    expect(mapped.rectGapPaddingMm).toBe(0);
    expect(mapped.scheme2D?.canvasMode).toBe('REMNANT');
    expect(mapped.scheme2D?.remnantId).toBe('REM-88');
    expect(mapped.canvasPatch2D?.trimStartMm).toBe(0);
    expect(mapped.scheme2D?.result.layout.placements[0].shape.holes).toHaveLength(1);
    expect(mapped.scheme2D?.demands[0].shape?.holes).toHaveLength(1);
    // 净面积扣除内孔：0.18 m²
    expect(mapped.scheme2D?.pieceAreaM2).toBe(0.18);
    expect(mapped.scheme2D?.occupiedLengthMm).toBe(440);
    expect(mapped.scheme2D?.defects).toHaveLength(1);
  });

  it('1D 一维分切方案完整映射为 SlittingSchemeRun 与 1D 参数补丁', () => {
    const family: DemandFamilySummary = {
      id: 'TASK-SLIT-01',
      name: 'BOPP 膜分切单',
      materialModel: 'BOPP-25U',
      dimension: 'SLITTING_1D',
      revision: 1,
      orderedTotal: 10,
      plannedTotal: 0,
      completedTotal: 0,
      openTotal: 10,
      schemeCount: 0,
      status: 'OPEN',
      lines: [
        {
          id: 1,
          name: '窄幅 1000mm',
          width: 1000,
          length: 3000,
          orderedQty: 6,
          plannedQty: 0,
          completedQty: 0,
          openQty: 6,
          surfaceTreatment: '双面电晕'
        },
        {
          id: 2,
          name: '宽幅 1200mm',
          width: 1200,
          length: 3000,
          orderedQty: 4,
          plannedQty: 0,
          completedQty: 0,
          openQty: 4,
          surfaceTreatment: '双面电晕'
        }
      ]
    };

    const context: WorkbenchResultContextDto = {
      resultId: 'JOB-SLIT-303',
      job: { id: 'JOB-SLIT-303', state: 'SUCCEEDED', elapsedMs: 85 },
      source: {
        taskId: 'TASK-SLIT-01',
        materialType: 'STOCK_ROLL',
        materialId: 'ROLL-FILM-01',
        materialModel: 'BOPP-25U',
        widthMm: 4600,
        processMode: 'SLITTING_1D',
        avoidDefects: true
      },
      input: {
        problemType: 'SLITTING_1D',
        problem: {
          motherWidthMm: 4600,
          leftTrimMm: 100,
          rightTrimMm: 100,
          minWidthMm: 4300,
          maxWidthMm: 4400,
          widthStepMm: 10,
          totalOverCap: 5,
          profile: 'QUALITY',
          maxKnives: 8,
          orders: [
            { id: '1', widthMm: 1000, lengthMm: 3000, quantity: 6, surfaceTreatment: '双面电晕' },
            { id: '2', widthMm: 1200, lengthMm: 3000, quantity: 4, surfaceTreatment: '双面电晕' }
          ]
        }
      },
      result: {
        id: 'JOB-SLIT-303',
        fulfillmentStatus: 'COMPLETE',
        metrics: [{ name: 'motherAreaUtilization', value: 95.652 }],
        slitting: {
          status: 'FEASIBLE',
          pieceAreaMm2: 132000000,
          motherAreaMm2: 138000000,
          usableAreaMm2: 132000000,
          totalOverproduced: 0,
          estimatedKnifeChanges: 2,
          knifeChangesSaved: 1,
          patterns: [
            {
              id: 'PAT-1',
              rollWidthMm: 4600,
              patternWidthMm: 4400,
              lengthMm: 3000,
              surfaceTreatment: '双面电晕',
              repetitions: 2,
              stations: [
                { widthMm: 1000, countPerRepetition: 2 },
                { widthMm: 1200, countPerRepetition: 2 }
              ],
              allocations: [
                { orderId: '1', quantity: 4 },
                { orderId: '2', quantity: 4 }
              ]
            },
            {
              id: 'PAT-2',
              rollWidthMm: 4600,
              patternWidthMm: 2000,
              lengthMm: 3000,
              surfaceTreatment: '双面电晕',
              repetitions: 1,
              stations: [{ widthMm: 1000, countPerRepetition: 2 }],
              allocations: [{ orderId: '1', quantity: 2 }]
            }
          ],
          fulfillment: [
            { orderId: '1', requested: 6, produced: 6, missing: 0, overproduced: 0 },
            { orderId: '2', requested: 4, produced: 4, missing: 0, overproduced: 0 }
          ]
        }
      }
    };

    const mapped = mapResultContextToWorkbenchPlan(context, null, family);
    expect(mapped.error).toBeNull();
    expect(mapped.dimension).toBe('1D');
    expect(mapped.scheme2D).toBeNull();
    expect(mapped.scheme1D).not.toBeNull();

    const s1 = mapped.scheme1D!;
    expect(s1.id).toBe('EXT-1D-JOB-SLIT-303');
    expect(s1.strategyId).toBe('QUALITY');
    expect(s1.totalCars).toBe(3);
    expect(s1.missingRolls).toBe(0);
    expect(s1.overproducedRolls).toBe(0);
    expect(s1.avgUtilizationPct).toBe(95.65);
    expect(s1.estimatedKnifeChanges).toBe(2);
    expect(s1.knifeChangesSaved).toBe(1);
    expect(s1.patterns[0].spareWidthMm).toBe(0);
    expect(s1.patterns[1].spareWidthMm).toBe(2400);
    expect(s1.fulfillment[0]).toMatchObject({
      orderId: '1',
      name: '窄幅 1000mm',
      widthMm: 1000,
      produced: 6
    });

    expect(mapped.slitPatch1D).toMatchObject({
      slitMaterialMode: 'STOCK_ROLL',
      slitRollId: 'ROLL-FILM-01',
      slitMotherWidthMm: 4600,
      slitLeftTrimMm: 100,
      slitRightTrimMm: 100,
      slitFixedLengthMm: 3000,
      slitMaxKnives: 8,
      slitAvoidDefects: true
    });
  });

  it('持久化草案 stale / EXPIRED 状态、风险预检项与备注准确映射到横幅元数据', () => {
    const context: WorkbenchResultContextDto = {
      resultId: 'JOB-DRAFT-404',
      source: {
        taskId: 'TASK-9',
        materialType: 'FREE_CANVAS',
        widthMm: 1500,
        windowLengthMm: 1200
      },
      input: {
        problemType: 'NESTING_2D',
        problem: {
          material: { shape: { type: 'RECTANGLE', width: 1500, height: 1200 } },
          parts: [{ id: 1, name: '靠垫', quantity: 2, shape: { type: 'RECTANGLE', width: 500, height: 500 } }],
          process: { mode: 'GUILLOTINE', pieceGap: 0 }
        }
      },
      result: {
        fulfillmentStatus: 'PARTIAL',
        layout: {
          placements: [
            { id: 1, demandId: 1, name: '靠垫', x: 0, y: 0, rotationDegrees: 0, shape: { type: 'RECTANGLE', width: 500, height: 500 } }
          ]
        }
      }
    };

    const draft: WorkbenchSchemeDraftDto = {
      id: 'DRF-999',
      draftId: 'DRF-999',
      status: 'EXPIRED',
      stale: true,
      staleReasons: ['任务版本已从 rev=2 变为 rev=4', '母卷剩余长度已变动'],
      expiresAt: '2026-11-26T08:00:00Z',
      note: 'AI 建议优先核对色差缸号',
      target: {
        resultId: 'JOB-DRAFT-404',
        taskId: 'TASK-9',
        materialType: 'FREE_CANVAS'
      },
      riskChecks: [
        { code: 'BATCH_MATCH', passed: true, message: '同缸号校验通过' },
        { code: 'FULFILLMENT', passed: false, message: '当前仅排入 1/2 件，存在 1 件缺口' }
      ]
    };

    const mapped = mapResultContextToWorkbenchPlan(context, draft, null, {
      nowMs: Date.parse('2026-11-26T10:00:00Z')
    });

    expect(mapped.error).toBeNull();
    expect(mapped.banner).toMatchObject({
      draftId: 'DRF-999',
      resultId: 'JOB-DRAFT-404',
      status: 'EXPIRED',
      expired: true,
      stale: true,
      staleReasons: ['任务版本已从 rev=2 变为 rev=4', '母卷剩余长度已变动'],
      note: 'AI 建议优先核对色差缸号',
      fulfillmentStatus: 'PARTIAL',
      fulfillmentLabel: '部分排入（存在缺件）'
    });
    expect(mapped.banner.riskChecks).toHaveLength(2);
    expect(mapped.banner.failedRiskChecks).toHaveLength(1);
    expect(mapped.banner.failedRiskChecks[0].code).toBe('FULFILLMENT');
  });

  it('缺省字段、空结果或未完成作业状态容错而不抛出异常', () => {
    const emptyPlan = mapResultContextToWorkbenchPlan(null, {
      draftId: 'DRF-EMPTY',
      status: 'PENDING_CONFIRMATION',
      expiresAt: '2020-01-01T00:00:00Z',
      target: { resultId: 'JOB-MISSING', taskId: 'T-404' }
    }, null, { nowMs: Date.parse('2026-11-26T10:00:00Z') });

    expect(emptyPlan.scheme2D).toBeNull();
    expect(emptyPlan.scheme1D).toBeNull();
    expect(emptyPlan.error).toContain('JOB-MISSING');
    // 虽然状态为 PENDING_CONFIRMATION，但 expiresAt 早于 nowMs，应自动判为过期
    expect(emptyPlan.banner.expired).toBe(true);
    expect(emptyPlan.banner.status).toBe('EXPIRED');

    const runningPlan = mapResultContextToWorkbenchPlan({
      resultId: 'JOB-RUN-1',
      job: { id: 'JOB-RUN-1', state: 'RUNNING', message: '求解进行中' },
      result: null
    });
    expect(runningPlan.scheme2D).toBeNull();
    expect(runningPlan.error).toContain('RUNNING');

    const unplacedPlan = mapResultContextToWorkbenchPlan({
      resultId: 'JOB-ZERO-1',
      input: { problemType: 'NESTING_2D', problem: {} },
      result: {
        fulfillmentStatus: 'INFEASIBLE',
        layout: { placements: [], message: '裁片宽超门幅' }
      }
    });
    expect(unplacedPlan.scheme2D).toBeNull();
    expect(unplacedPlan.error).toBe('裁片宽超门幅');
    expect(unplacedPlan.banner.fulfillmentStatus).toBe('INFEASIBLE');
  });
});
