import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReconciliationPage } from '../../ReconciliationPage';
import { ReconciliationQualityTab } from '../ReconciliationQualityTab';
import { ReconciliationModals } from '../ReconciliationModals';
import {
  CostAnalyticsPage,
  buildCostSummaryCsvText,
  computeWasteSharePct,
  normalizeAlertLevel
} from '../../CostAnalyticsPage';

describe('ReconciliationPage 与 CostAnalyticsPage 拆解及报表导出契约', () => {
  it('ReconciliationPage 与 CostAnalyticsPage 保留全部导出符号、表格列序及汇总导出 data-testid', () => {
    const reconHtml = renderToStaticMarkup(React.createElement(ReconciliationPage));
    expect(reconHtml).toContain('<h1>复检补排与对账</h1>');
    expect(reconHtml).toContain('data-testid="recon-export-summary-pdf-btn"');
    expect(reconHtml).toContain('data-testid="recon-export-summary-xlsx-btn"');

    const qualityHtml = renderToStaticMarkup(
      React.createElement(ReconciliationQualityTab, {
        reports: [
          {
            reportId: 'REP-001',
            taskId: 'T-1',
            taskName: '测试需求',
            materialModel: 'M1',
            batchNo: 'B1',
            report: {
              planId: 'REP-001',
              rollId: 'R-1',
              actualCutLen: 2500,
              netUtilization: 86.5,
              status: 'CONFIRMED',
              pieceResults: [
                { pieceId: 1, name: 'P1', w: 500, l: 500, outcome: 'QUALIFIED' }
              ]
            },
            dispositions: []
          }
        ],
        filteredReports: [
          {
            reportId: 'REP-001',
            taskId: 'T-1',
            taskName: '测试需求',
            materialModel: 'M1',
            batchNo: 'B1',
            report: {
              planId: 'REP-001',
              rollId: 'R-1',
              actualCutLen: 2500,
              netUtilization: 86.5,
              status: 'CONFIRMED',
              pieceResults: [
                { pieceId: 1, name: 'P1', w: 500, l: 500, outcome: 'QUALIFIED' }
              ]
            },
            dispositions: []
          }
        ],
        reportTotal: 1,
        reportOffset: 0,
        reportPageSize: 50,
        reportHasMore: false,
        loading: false,
        busy: false,
        expandedReportId: null,
        onToggleExpand: () => {},
        onOpenQualityReview: () => {},
        onReplenishTask: () => {},
        onOpenReverseDraft: () => {},
        onOpenRevokeDraft: () => {},
        onPageChange: () => {},
        onClearSearch: () => {}
      })
    );
    expect(qualityHtml).toContain('<th>报工单号</th><th>所属需求族 / 品号缸号</th><th>消耗母卷 / 料头</th><th class="r">实切长 mm</th><th class="r">净合格件</th><th class="r">异常 / 判废</th><th class="r">净利用率</th><th style="text-align:right">操作</th>');
    expect(qualityHtml).toContain('复检处置 (1)');
    expect(qualityHtml).toContain('冲销报工');

    const modalsHtml = renderToStaticMarkup(
      React.createElement(ReconciliationModals, {
        busy: false,
        qualityDraft: null,
        setQualityDraft: () => {},
        onSubmitQuality: () => {},
        revokeDraft: {
          reportId: 'REP-1',
          taskName: 'T1',
          dispositionId: 'D1',
          dispositionLabel: '判废',
          operator: '',
          reason: ''
        },
        setRevokeDraft: () => {},
        onSubmitRevoke: () => {},
        reverseDraft: {
          reportId: 'REP-1',
          taskName: 'T1',
          materialLabel: 'R1',
          actualCutLen: 1000,
          qualifiedCount: 2,
          reason: '',
          error: ''
        },
        setReverseDraft: () => {},
        onSubmitReverseReport: () => {}
      })
    );
    expect(modalsHtml).toContain('id="rev-operator"');
    expect(modalsHtml).toContain('id="rev-reason"');
    expect(modalsHtml).toContain('id="recon-reverse-reason"');

    const costHtml = renderToStaticMarkup(
      React.createElement(CostAnalyticsPage, {
        initialCostData: {
          currency: 'CNY',
          defaultUnitPricePerSqm: 25,
          remnantResidualFactor: 0.7,
          summary: {
            totalReports: 1,
            totalConsumedAreaM2: 10,
            netGoodAreaM2: 8,
            recoveredRemnantAreaM2: 1,
            wasteAreaM2: 1,
            totalMaterialCost: 250,
            recoveredResidualValue: 17.5,
            netEffectiveCost: 232.5,
            wasteCost: 25,
            avgCostPerGoodSqm: 29.06
          },
          byTask: [{ taskId: 'T-1', taskName: '任务1', totalReports: 1, totalConsumedAreaM2: 10, netGoodAreaM2: 8 }],
          byMaterialModel: []
        }
      })
    );
    expect(costHtml).toContain('<h1>成本与备料</h1>');
    expect(costHtml).toContain('data-testid="cost-export-summary-pdf-btn"');
    expect(costHtml).toContain('data-testid="cost-export-summary-xlsx-btn"');
    expect(costHtml).toContain('data-testid="cost-detail-csv-btn"');
    expect(costHtml).toContain('<th>任务编号 / 名称</th><th>报工数 (单)</th><th>耗料面积 (m²)</th><th>净良品 (m²)</th>');

    expect(normalizeAlertLevel('CRITICAL').tagClass).toBe('err');
    expect(
      computeWasteSharePct({
        totalReports: 1,
        totalConsumedAreaM2: 10,
        netGoodAreaM2: 8,
        recoveredRemnantAreaM2: 1,
        wasteAreaM2: 1,
        totalMaterialCost: 100,
        recoveredResidualValue: 10,
        netEffectiveCost: 90,
        wasteCost: 25,
        avgCostPerGoodSqm: 11.25
      })
    ).toBe(25);
    const csv = buildCostSummaryCsvText(
      {
        currency: 'CNY',
        defaultUnitPricePerSqm: 25,
        remnantResidualFactor: 0.7,
        summary: {
          totalReports: 1,
          totalConsumedAreaM2: 10,
          netGoodAreaM2: 8,
          recoveredRemnantAreaM2: 1,
          wasteAreaM2: 1,
          totalMaterialCost: 100,
          recoveredResidualValue: 10,
          netEffectiveCost: 90,
          wasteCost: 25,
          avgCostPerGoodSqm: 11.25
        },
        byTask: [{ taskId: 'T1', taskName: '=CMD', totalReports: 1 }],
        byMaterialModel: []
      },
      'task'
    );
    expect(csv).toContain("\'=CMD");
  });
});
