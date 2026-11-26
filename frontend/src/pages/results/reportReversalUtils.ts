export const MAX_REVERSAL_REASON_LENGTH = 500;

export interface ReversalReasonValidation {
  valid: boolean;
  trimmed: string;
  error?: string;
}

export interface ReportReversalEligibility {
  eligible: boolean;
  reportId: string;
  status: string;
  dispositionCount: number;
  reason?: string;
}

export interface SchemeReversalEligibility {
  eligible: boolean;
  showAction: boolean;
  targetPlanIds: string[];
  blockedCount: number;
  reason?: string;
}

export interface ReversalRequestPayload {
  url: string;
  body: {
    reason: string;
  };
}

/**
 * 校验报工冲销原因（严格对齐后端 RemnantService.reverseReport：1~500 字非空字符串）。
 */
export function validateReversalReason(raw: string): ReversalReasonValidation {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return {
      valid: false,
      trimmed,
      error: '请填写冲销原因（1 至 500 字）'
    };
  }
  if (trimmed.length > MAX_REVERSAL_REASON_LENGTH) {
    return {
      valid: false,
      trimmed,
      error: `冲销原因不能超过 ${MAX_REVERSAL_REASON_LENGTH} 字（当前 ${trimmed.length} 字）`
    };
  }
  return { valid: true, trimmed };
}

function readDispositionCount(input: any): number {
  const reportObj = input?.report && typeof input.report === 'object' ? input.report : input;
  const fromOuter = Array.isArray(input?.dispositions) ? input.dispositions.length : 0;
  const fromReport = Array.isArray(reportObj?.qualityDispositions)
    ? reportObj.qualityDispositions.length
    : 0;
  const fromNumeric =
    (typeof input?.activeDispositionCount === 'number' ? input.activeDispositionCount : 0) +
    (typeof input?.revokedDispositionCount === 'number' ? input.revokedDispositionCount : 0);
  return Math.max(fromOuter, fromReport, fromNumeric);
}

/**
 * 判定单条报工记录是否具备前端发起「报工冲销」的资格。
 * 后端不变量（RemnantService.reverseReport）：
 * 1. 仅未冲销（status !== 'REVERSED'）且存在有效 planId 的报工记录可冲销；
 * 2. 一旦存在任何复检处置历史（无论是否已撤销，qualityEvents 非空），严禁冲销原料耗用。
 */
export function evaluateReportReversalEligibility(input: any): ReportReversalEligibility {
  const reportObj = input?.report && typeof input.report === 'object' ? input.report : input || {};
  const reportId = String(
    input?.reportId || reportObj?.planId || reportObj?.reportId || input?.planId || ''
  ).trim();
  const status = String(input?.status ?? reportObj?.status ?? 'CONFIRMED').toUpperCase();
  const dispositionCount = readDispositionCount(input);

  if (!reportId) {
    return {
      eligible: false,
      reportId: '',
      status,
      dispositionCount,
      reason: '缺少有效的报工单号（planId），无法执行冲销'
    };
  }
  if (status === 'REVERSED') {
    return {
      eligible: false,
      reportId,
      status,
      dispositionCount,
      reason: '该报工记录已冲销，无需重复操作'
    };
  }
  if (dispositionCount > 0) {
    return {
      eligible: false,
      reportId,
      status,
      dispositionCount,
      reason: '已有复检处置记录，不能冲销原料耗用（请保留实际裁切事实）'
    };
  }
  return {
    eligible: true,
    reportId,
    status,
    dispositionCount
  };
}

/**
 * 判定结果管理页中单个排程方案条目是否可执行「冲销报工」，并按 LIFO 逆序输出目标 planId 列表。
 * 说明：后端 RemnantService.reverseReport 要求同一母卷必须从最近一次报工逆序撤回。
 */
export function evaluateSchemeReversalEligibility(entry: any): SchemeReversalEligibility {
  const scheme = entry?.scheme;
  if (!scheme || typeof scheme !== 'object') {
    return {
      eligible: false,
      showAction: false,
      targetPlanIds: [],
      blockedCount: 0,
      reason: '缺少排程方案信息'
    };
  }

  const state = String(scheme.state || '').toUpperCase();
  const rawReceipts: any[] = Array.isArray(entry?.receipts) ? entry.receipts : [];
  const activeReceipts = rawReceipts.filter(
    (r) => r && String(r.status || 'CONFIRMED').toUpperCase() !== 'REVERSED'
  );

  if (activeReceipts.length === 0) {
    if (state === 'COMPLETED') {
      const linked: string[] = Array.isArray(scheme.linkedPlanIds)
        ? scheme.linkedPlanIds.map((id: any) => String(id || '').trim()).filter(Boolean)
        : [];
      if (linked.length > 0) {
        const reversedUnique = Array.from(new Set([...linked].reverse()));
        return {
          eligible: true,
          showAction: true,
          targetPlanIds: reversedUnique,
          blockedCount: 0
        };
      }
      return {
        eligible: false,
        showAction: false,
        targetPlanIds: [],
        blockedCount: 0,
        reason: '该完工方案未关联可冲销的报工回执'
      };
    }
    return {
      eligible: false,
      showAction: false,
      targetPlanIds: [],
      blockedCount: 0,
      reason:
        state === 'REVERSED'
          ? '该方案关联报工已冲销释放'
          : '仅已完工且存在未冲销报工回执的方案可执行冲销'
    };
  }

  const evaluations = activeReceipts.map((r) => evaluateReportReversalEligibility(r));
  const blocked = evaluations.filter((e) => !e.eligible);
  if (blocked.length > 0) {
    return {
      eligible: false,
      showAction: true,
      targetPlanIds: [],
      blockedCount: blocked.length,
      reason: blocked[0].reason || '关联报工当前不满足冲销条件'
    };
  }

  // 后端 enrichSchemeView 按 scheme.linkedPlanIds 写入顺序返回 receipts，
  // 而 RemnantService.reverseReport 按插入顺序 LIFO 拦截同母卷早先报工，
  // 因此严格按 [...activeReceipts].reverse() 逆序冲销最确定可靠。
  const targetPlanIds = Array.from(
    new Set(
      [...activeReceipts]
        .reverse()
        .map((r) => String(r.planId || r.reportId || '').trim())
        .filter(Boolean)
    )
  );
  if (targetPlanIds.length === 0) {
    return {
      eligible: false,
      showAction: false,
      targetPlanIds: [],
      blockedCount: 0,
      reason: '缺少有效的报工单号（planId），无法执行冲销'
    };
  }

  return {
    eligible: true,
    showAction: true,
    targetPlanIds,
    blockedCount: 0
  };
}

/**
 * 构造后端 `POST /api/cutting/reports/{id}/reverse` 请求地址与载荷。
 */
export function buildReversalRequest(reportId: string, reason: string): ReversalRequestPayload {
  const id = String(reportId ?? '').trim();
  if (!id) {
    throw new Error('缺少有效的报工单号（planId），无法执行冲销');
  }
  const validation = validateReversalReason(reason);
  if (!validation.valid) {
    throw new Error(validation.error || '请填写有效的冲销原因');
  }
  return {
    url: `/api/cutting/reports/${encodeURIComponent(id)}/reverse`,
    body: { reason: validation.trimmed }
  };
}
