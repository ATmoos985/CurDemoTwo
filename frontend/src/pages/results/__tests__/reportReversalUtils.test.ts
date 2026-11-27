import { describe, expect, it } from 'vitest';
import {
  MAX_REVERSAL_REASON_LENGTH,
  buildReversalRequest,
  evaluateReportReversalEligibility,
  evaluateSchemeReversalEligibility,
  validateReversalReason
} from '../reportReversalUtils';

describe('报工冲销纯函数资格判定与请求构造', () => {
  it('validateReversalReason 严格校验 1~500 字非空原因并做首尾裁剪', () => {
    expect(validateReversalReason('')).toMatchObject({ valid: false });
    expect(validateReversalReason('   \n\t  ')).toMatchObject({ valid: false });
    expect(validateReversalReason('  实切长度录错  ')).toEqual({
      valid: true,
      trimmed: '实切长度录错'
    });

    const maxText = '冲'.repeat(MAX_REVERSAL_REASON_LENGTH);
    expect(validateReversalReason(maxText)).toEqual({ valid: true, trimmed: maxText });

    const tooLong = '冲'.repeat(MAX_REVERSAL_REASON_LENGTH + 1);
    const over = validateReversalReason(tooLong);
    expect(over.valid).toBe(false);
    expect(over.error).toContain('500');
  });

  it('evaluateReportReversalEligibility 放行未冲销且无复检记录的报工，拦截已冲销与已有复检记录', () => {
    // 正常可冲销
    expect(
      evaluateReportReversalEligibility({
        reportId: 'PLAN-1001',
        report: { planId: 'PLAN-1001', status: 'CONFIRMED', qualityDispositions: [] },
        dispositions: []
      })
    ).toEqual({
      eligible: true,
      reportId: 'PLAN-1001',
      status: 'CONFIRMED',
      dispositionCount: 0
    });

    // 已冲销（REVERSED）禁止重复发起
    expect(
      evaluateReportReversalEligibility({
        reportId: 'PLAN-1002',
        status: 'REVERSED',
        dispositions: []
      })
    ).toMatchObject({
      eligible: false,
      reportId: 'PLAN-1002',
      status: 'REVERSED'
    });

    // 存在生效复检处置：严禁冲销原料耗用
    const withActiveDisp = evaluateReportReversalEligibility({
      reportId: 'PLAN-1003',
      status: 'CONFIRMED',
      dispositions: [{ id: 'D-1', disposition: 'SCRAP' }]
    });
    expect(withActiveDisp.eligible).toBe(false);
    expect(withActiveDisp.dispositionCount).toBe(1);
    expect(withActiveDisp.reason).toContain('复检处置');

    // 存在已撤销复检处置：对齐后端 qualityEvents(receipt).isEmpty()，仍严禁冲销
    const withRevokedDisp = evaluateReportReversalEligibility({
      reportId: 'PLAN-1004',
      report: {
        planId: 'PLAN-1004',
        status: 'CONFIRMED',
        qualityDispositions: [{ id: 'D-2', revocation: { operator: '主管', reason: '误判' } }]
      }
    });
    expect(withRevokedDisp.eligible).toBe(false);
    expect(withRevokedDisp.dispositionCount).toBe(1);

    // 缺少 planId / reportId
    expect(evaluateReportReversalEligibility({ status: 'CONFIRMED' })).toMatchObject({
      eligible: false,
      reportId: ''
    });
  });

  it('evaluateSchemeReversalEligibility 精准判断方案冲销资格并按 LIFO 逆序输出 planId', () => {
    // 未完工或已作废方案不展示冲销按钮
    expect(
      evaluateSchemeReversalEligibility({
        scheme: { id: 'SCH-1', state: 'READY_TO_CUT', linkedPlanIds: ['P-1'] },
        receipts: []
      })
    ).toMatchObject({ showAction: false, eligible: false, targetPlanIds: [] });

    expect(
      evaluateSchemeReversalEligibility({
        scheme: { id: 'SCH-2', state: 'REVERSED', linkedPlanIds: ['P-2'] },
        receipts: []
      })
    ).toMatchObject({ showAction: false, eligible: false, targetPlanIds: [] });

    // 单回执已完工方案允许冲销
    expect(
      evaluateSchemeReversalEligibility({
        scheme: { id: 'SCH-3', state: 'COMPLETED', linkedPlanIds: ['P-3'] },
        receipts: [{ planId: 'P-3', status: 'CONFIRMED', qualityDispositions: [] }]
      })
    ).toEqual({
      showAction: true,
      eligible: true,
      targetPlanIds: ['P-3'],
      blockedCount: 0
    });

    // 多段分切回执按 confirmedAt 逆序（LIFO）返回，避免触发同母卷顺序拦截
    const multi = evaluateSchemeReversalEligibility({
      scheme: { id: 'SCH-4', state: 'COMPLETED', linkedPlanIds: ['P-A', 'P-B'] },
      receipts: [
        { planId: 'P-A', status: 'CONFIRMED', confirmedAt: '2026-11-25T09:00:00', qualityDispositions: [] },
        { planId: 'P-B', status: 'CONFIRMED', confirmedAt: '2026-11-25T09:05:00', qualityDispositions: [] }
      ]
    });
    expect(multi).toEqual({
      showAction: true,
      eligible: true,
      targetPlanIds: ['P-B', 'P-A'],
      blockedCount: 0
    });

    // 任意关联回执含复检处置则阻断并保留禁用态提示
    const blockedScheme = evaluateSchemeReversalEligibility({
      scheme: { id: 'SCH-5', state: 'COMPLETED', linkedPlanIds: ['P-5'] },
      receipts: [
        {
          planId: 'P-5',
          status: 'CONFIRMED',
          qualityDispositions: [{ id: 'DISP-1' }]
        }
      ]
    });
    expect(blockedScheme).toMatchObject({
      showAction: true,
      eligible: false,
      blockedCount: 1,
      targetPlanIds: []
    });
    expect(blockedScheme.reason).toContain('复检处置');

    // 兼容摘要数据缺少 receipts 字段时回退 linkedPlanIds（逆序去重）
    expect(
      evaluateSchemeReversalEligibility({
        scheme: { id: 'SCH-6', state: 'COMPLETED', linkedPlanIds: ['P-1', 'P-2', 'P-1'] }
      })
    ).toEqual({
      showAction: true,
      eligible: true,
      targetPlanIds: ['P-1', 'P-2'],
      blockedCount: 0
    });
  });

  it('buildReversalRequest 正确编码路径参数并校验非法输入', () => {
    expect(buildReversalRequest('PLAN/2026#01', '  错绑母卷  ')).toEqual({
      url: '/api/v2/cutting/reports/PLAN%2F2026%2301/reverse',
      body: { reason: '错绑母卷' }
    });
    expect(() => buildReversalRequest('', '原因')).toThrow();
    expect(() => buildReversalRequest('PLAN-01', '   ')).toThrow();
  });
});
