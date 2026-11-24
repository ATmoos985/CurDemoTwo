import { describe, expect, it } from 'vitest';
import {
  formatSolverPhaseLabel,
  formatSolverProgressText
} from '../workbench/solverProgressUtils';
import {
  DEFAULT_GARMENT_SIZES,
  DEFAULT_MULTI_DEMANDS,
  buildCutPlanCsvText,
  buildCutPlanPayload,
  buildMultiMaterialPayload,
  summarizeSizeAudit
} from '../GlobalPlanningPage';
import {
  buildCostSummaryCsvText,
  buildProcurementCsvText,
  computeWasteSharePct,
  normalizeAlertLevel
} from '../CostAnalyticsPage';

describe('阶段四：SSE 进度格式化、联合排产/自动分床与成本备料分析', () => {
  it('formatSolverProgressText 将 SSE 与轮询阶段映射为清晰的中文实时反馈文本', () => {
    expect(formatSolverPhaseLabel('COLUMN_GENERATION')).toBe('列生成求解');
    expect(formatSolverPhaseLabel(null, 'QUEUED')).toBe('排队中');
    expect(
      formatSolverProgressText({
        state: 'RUNNING',
        phase: 'SOLVING',
        elapsedMs: 1250,
        transport: 'sse'
      })
    ).toBe('求解搜索中 · 1.3s (实时)');
    expect(
      formatSolverProgressText({
        state: 'RUNNING',
        phase: 'VALIDATING',
        elapsedMs: 400
      })
    ).toBe('几何校验中 · 0.4s');
  });

  it('buildMultiMaterialPayload 严格校验任务/手工需求模式并组装冻结 API 载荷', () => {
    const emptyTask = buildMultiMaterialPayload({
      sourceMode: 'TASK',
      taskId: '',
      materialModel: 'TC-2026',
      requiredBatchNo: '',
      requiredColor: '',
      preferRemnants: true,
      maxRemnants: 5,
      timeBudgetMs: 3000,
      pieceGapMm: 4,
      trimStartMm: 20,
      demands: []
    });
    expect(emptyTask.error).toContain('需求池');

    const manualOk = buildMultiMaterialPayload({
      sourceMode: 'MANUAL',
      taskId: '',
      materialModel: 'TC-2026',
      requiredBatchNo: 'BAT-09',
      requiredColor: '炭灰',
      preferRemnants: true,
      maxRemnants: 3,
      timeBudgetMs: 2500,
      pieceGapMm: 5,
      trimStartMm: 15,
      demands: DEFAULT_MULTI_DEMANDS
    });
    expect(manualOk.error).toBeUndefined();
    expect(manualOk.payload).toMatchObject({
      materialModel: 'TC-2026',
      requiredBatchNo: 'BAT-09',
      requiredColor: '炭灰',
      preferRemnants: true,
      maxRemnants: 3,
      timeBudgetMs: 2500
    });
    expect(manualOk.payload?.demands).toHaveLength(3);
  });

  it('buildCutPlanPayload、summarizeSizeAudit 与 buildCutPlanCsvText 保证尺码守恒与 CSV 防公式注入', () => {
    const built = buildCutPlanPayload({
      styleName: 'FZ-HOODIE',
      colorName: '藏青',
      fabricWidthMm: 1650,
      maxPliesPerLay: 60,
      maxGarmentsPerMarker: 8,
      maxLayLengthMm: 10000,
      endAllowanceMm: 50,
      grammageGsm: 280,
      defaultUnitAreaM2: 1.3,
      targetUtilizationPct: 85,
      allowOvercutPct: 0,
      sizes: DEFAULT_GARMENT_SIZES
    });
    expect(built.error).toBeUndefined();
    expect(built.payload?.sizeQuantities).toEqual({ S: 60, M: 120, L: 150, XL: 90, '2XL': 40 });

    const audit = summarizeSizeAudit([
      { size: 'S', ordered: 60, planned: 60, delta: 0 },
      { size: 'M', ordered: 120, planned: 122, delta: 2 }
    ]);
    expect(audit).toEqual({ balanced: true, exactCount: 1, overcutTotal: 2, shortageTotal: 0 });

    const shortageAudit = summarizeSizeAudit([
      { size: 'L', ordered: 100, planned: 95, delta: -5 }
    ]);
    expect(shortageAudit.balanced).toBe(false);
    expect(shortageAudit.shortageTotal).toBe(5);

    const csv = buildCutPlanCsvText({
      styleName: '=CMD|calc',
      colorName: '红,蓝"混色',
      totalOrderedGarments: 100,
      totalPlannedGarments: 100,
      overcutGarments: 0,
      layCount: 1,
      totalPlies: 50,
      totalFabricLengthM: 120,
      totalFabricAreaM2: 198,
      estimatedWeightKg: 55.4,
      averageEfficiencyPct: 85.2,
      lays: [
        {
          layNo: 1,
          plies: 50,
          ratio: { S: 1, M: 1 },
          garmentsPerMarker: 2,
          layGarments: 100,
          estimatedMarkerLengthMm: 2400,
          fabricLengthM: 120,
          fabricAreaM2: 198
        }
      ],
      sizeAudit: [
        { size: 'S', ordered: 50, planned: 50, delta: 0 },
        { size: 'M', ordered: 50, planned: 50, delta: 0 }
      ]
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=CMD|calc"');
    expect(csv).toContain('"红,蓝""混色"');
  });

  it('CostAnalyticsPage 预警分级、废料占比与双表 csvCell 安全导出正确', () => {
    expect(normalizeAlertLevel('CRITICAL').tagClass).toBe('err');
    expect(normalizeAlertLevel('WARNING').tagClass).toBe('warn');
    expect(normalizeAlertLevel('OK').tagClass).toBe('ok');

    expect(
      computeWasteSharePct({
        totalReports: 2,
        totalConsumedAreaM2: 100,
        netGoodAreaM2: 80,
        recoveredRemnantAreaM2: 5,
        wasteAreaM2: 15,
        totalMaterialCost: 2500,
        recoveredResidualValue: 87.5,
        netEffectiveCost: 2412.5,
        wasteCost: 375,
        avgCostPerGoodSqm: 30.16
      })
    ).toBe(15);

    const costCsv = buildCostSummaryCsvText(
      {
        currency: 'CNY',
        defaultUnitPricePerSqm: 25,
        remnantResidualFactor: 0.7,
        summary: {
          totalReports: 1,
          totalConsumedAreaM2: 50,
          netGoodAreaM2: 40,
          recoveredRemnantAreaM2: 4,
          wasteAreaM2: 6,
          totalMaterialCost: 1250,
          recoveredResidualValue: 70,
          netEffectiveCost: 1180,
          wasteCost: 150,
          avgCostPerGoodSqm: 29.5
        },
        byTask: [
          {
            taskId: '+TASK-01',
            taskName: '@订单,测试',
            totalReports: 1,
            totalConsumedAreaM2: 50,
            netGoodAreaM2: 40,
            recoveredRemnantAreaM2: 4,
            wasteAreaM2: 6,
            totalMaterialCost: 1250,
            recoveredResidualValue: 70,
            netEffectiveCost: 1180,
            wasteCost: 150,
            avgCostPerGoodSqm: 29.5
          }
        ],
        byMaterialModel: []
      },
      'task'
    );
    expect(costCsv).toContain('"\'+TASK-01"');
    expect(costCsv).toContain('"\'@订单,测试"');

    const procCsv = buildProcurementCsvText({
      safetyBufferPct: 15,
      defaultRollLengthM: 50,
      totalModels: 1,
      shortageModels: 1,
      items: [
        {
          materialModel: '-MODEL"A',
          demandAreaM2: 100,
          requiredWithBufferAreaM2: 115,
          availableRollAreaM2: 50,
          availableRemnantAreaM2: 10,
          netAvailableAreaM2: 60,
          shortageAreaM2: 55,
          recommendedWidthMm: 1650,
          recommendedLengthM: 50,
          recommendedRolls: 1,
          alertLevel: 'HIGH',
          pendingTaskCount: 2,
          activeBatches: ['B1', 'B2']
        }
      ]
    });
    expect(procCsv).toContain('"\'-MODEL""A"');
    expect(procCsv).toContain('高危缺口');
  });
});
