import {
  SlittingWidthMode,
  extractSlittingSolverOptions,
  loadStudioSettings
} from '../../store/studioSettings';

export interface ShowcaseSlitDraft {
  widthMode: SlittingWidthMode;
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  minWidthMm: number;
  maxWidthMm: number;
  widthStepMm: number;
  totalOverCap: number;
  timeLimitSeconds: number;
  topK: number;
  maxIterations: number;
  maxPatterns: number;
  maxDistinctWidths: number;
  stageTimeLimitMs: number;
  useOptimizedAssignment: boolean;
  underPenalty: number;
  seqGroupAlpha: number;
  seqGroupBeta: number;
  lnsEnabled: boolean;
}

export function buildSlitDraftFromRequest(req: any): ShowcaseSlitDraft {
  const p = req?.problem || {};
  const studio = loadStudioSettings();
  const adv = extractSlittingSolverOptions(studio);
  const minW = Number(p.minWidthMm) || 4300;
  const maxW = Number(p.maxWidthMm) || 4400;
  return {
    widthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
    motherWidthMm: Number(p.motherWidthMm) || 4600,
    leftTrimMm: p.leftTrimMm != null ? Number(p.leftTrimMm) : 100,
    rightTrimMm: p.rightTrimMm != null ? Number(p.rightTrimMm) : 100,
    minWidthMm: minW,
    maxWidthMm: maxW,
    widthStepMm: Math.max(1, Number(p.widthStepMm) || 10),
    totalOverCap: Math.max(0, p.totalOverCap != null ? Number(p.totalOverCap) : 30),
    timeLimitSeconds: Math.min(180, Math.max(1, Number(p.timeLimitSeconds) || studio.slitTimeLimitSeconds || 30)),
    topK: p.topK != null ? Number(p.topK) : adv.topK,
    maxIterations: p.maxIterations != null ? Number(p.maxIterations) : adv.maxIterations,
    maxPatterns: p.maxPatterns != null ? Number(p.maxPatterns) : adv.maxPatterns,
    maxDistinctWidths: p.maxDistinctWidths != null ? Number(p.maxDistinctWidths) : adv.maxDistinctWidths,
    stageTimeLimitMs: p.stageTimeLimitMs != null ? Number(p.stageTimeLimitMs) : adv.stageTimeLimitMs,
    useOptimizedAssignment:
      p.useOptimizedAssignment != null ? Boolean(p.useOptimizedAssignment) : adv.useOptimizedAssignment,
    underPenalty: p.underPenalty != null ? Number(p.underPenalty) : adv.underPenalty,
    seqGroupAlpha: p.seqGroupAlpha != null ? Number(p.seqGroupAlpha) : adv.seqGroupAlpha,
    seqGroupBeta: p.seqGroupBeta != null ? Number(p.seqGroupBeta) : adv.seqGroupBeta,
    lnsEnabled: p.lnsEnabled != null ? Boolean(p.lnsEnabled) : adv.lnsEnabled
  };
}

export function applySlitDraftToRequest(baseReq: any, draft: ShowcaseSlitDraft, profile: string): any {
  const motherW = Math.max(100, Math.floor(Number(draft.motherWidthMm) || 4600));
  const leftTrim = Math.max(0, Math.floor(Number(draft.leftTrimMm) || 0));
  const rightTrim = Math.max(0, Math.floor(Number(draft.rightTrimMm) || 0));
  const usable = Math.max(1, motherW - leftTrim - rightTrim);
  const maxW = Math.min(usable, Math.max(1, Math.floor(Number(draft.maxWidthMm) || usable)));
  const minW =
    draft.widthMode === 'FIXED'
      ? maxW
      : Math.min(maxW, Math.max(1, Math.floor(Number(draft.minWidthMm) || maxW)));
  const step = Math.max(1, Math.floor(Number(draft.widthStepMm) || 10));
  const overCap = Math.max(0, Math.floor(Number(draft.totalOverCap) || 0));
  const rawTime = Math.floor(Number(draft.timeLimitSeconds) || 30);
  const orderCount = (baseReq?.problem?.orders || []).length;
  const effTime = Math.min(
    180,
    Math.max(1, profile === 'QUALITY' ? Math.max(rawTime, orderCount >= 40 ? 180 : 60) : rawTime)
  );
  const rawDistinct = Math.min(20, Math.max(1, Math.floor(Number(draft.maxDistinctWidths) || 4)));

  return {
    ...baseReq,
    problem: {
      ...(baseReq?.problem || {}),
      motherWidthMm: motherW,
      leftTrimMm: leftTrim,
      rightTrimMm: rightTrim,
      minWidthMm: minW,
      maxWidthMm: maxW,
      widthStepMm: step,
      totalOverCap: overCap,
      profile,
      timeLimitSeconds: effTime,
      topK: Math.min(50, Math.max(0, Math.floor(Number(draft.topK) || 0))),
      maxIterations: Math.min(5000, Math.max(1, Math.floor(Number(draft.maxIterations) || 300))),
      maxPatterns: Math.min(20000, Math.max(1, Math.floor(Number(draft.maxPatterns) || 800))),
      maxDistinctWidths: rawDistinct,
      stageTimeLimitMs: Math.min(
        600000,
        Math.max(1000, Math.floor(Number(draft.stageTimeLimitMs) || 120000))
      ),
      useOptimizedAssignment: Boolean(draft.useOptimizedAssignment),
      underPenalty: Math.max(0, Number(draft.underPenalty) || 0),
      seqGroupAlpha: Math.max(0, Number(draft.seqGroupAlpha) || 0),
      seqGroupBeta: Math.max(0, Number(draft.seqGroupBeta) || 0),
      lnsEnabled: Boolean(draft.lnsEnabled)
    }
  };
}

export function validateShowcaseSlitDraft(draft: ShowcaseSlitDraft, orders: any[]): string | null {
  const usable = draft.motherWidthMm - draft.leftTrimMm - draft.rightTrimMm;
  const effMax = Math.min(usable, draft.maxWidthMm);
  const effMin = draft.widthMode === 'FIXED' ? effMax : draft.minWidthMm;
  const maxOrderW = Math.max(
    ...(orders || []).map((o: any) => Number(o.widthMm) || 0),
    0
  );
  if (usable <= 0 || effMin <= 0 || effMax < effMin) {
    return '请检查母卷幅宽、左右切边与组合宽区间：可切幅宽须大于 0 且最小组合宽 ≤ 最大组合宽。';
  }
  if (maxOrderW > effMax) {
    return `当前订单最大宽幅 ${maxOrderW} mm 超过组合上限 ${effMax} mm，请调大母卷总宽或最大组合宽。`;
  }
  return null;
}
