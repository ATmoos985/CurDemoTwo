import { describe, expect, it } from 'vitest';
import {
  formatSolverPhaseLabel,
  formatSolverProgressText
} from '../workbench/solverProgressUtils';
import {
  buildCostSummaryCsvText,
  buildProcurementCsvText,
  computeWasteSharePct,
  normalizeAlertLevel
} from '../CostAnalyticsPage';

describe('阶段四：SSE 进度格式化与成本备料分析', () => {
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
