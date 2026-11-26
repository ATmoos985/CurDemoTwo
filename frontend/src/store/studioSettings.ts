export type StartCornerType = 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom';
export type FirstStageOrientation = 'horizontal' | 'vertical';
export type SettingsTabId = 'general' | 'craft' | 'remnant' | 'engines' | 'integration';
export type SlittingProfile = 'FAST' | 'QUALITY';
export type SlittingWidthMode = 'FLEXIBLE' | 'FIXED';
export type StudioThemeMode = 'light' | 'dark';

export interface CncPostOptions {
  cutFeed: number;
  rapidFeed: number;
  plungeDelay: number;
  retractDelay: number;
}

export const DEFAULT_CNC_POST_OPTIONS: CncPostOptions = {
  cutFeed: 4000,
  rapidFeed: 15000,
  plungeDelay: 200,
  retractDelay: 100
};

export interface SlittingWidthPreset {
  id: string;
  name: string;
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  minWidthMm: number;
  maxWidthMm: number;
  widthStepMm: number;
  totalOverCap: number;
  widthMode: SlittingWidthMode;
  builtin?: boolean;
}

export const DEFAULT_SLITTING_PRESETS: SlittingWidthPreset[] = [
  {
    id: 'preset-film-4600-std',
    name: '光学膜 4600 · 标准 (4300–4400)',
    motherWidthMm: 4600,
    leftTrimMm: 100,
    rightTrimMm: 100,
    minWidthMm: 4300,
    maxWidthMm: 4400,
    widthStepMm: 10,
    totalOverCap: 30,
    widthMode: 'FLEXIBLE',
    builtin: true
  },
  {
    id: 'preset-film-4600-wide',
    name: '光学膜 4600 · 宽区 (4200–4400)',
    motherWidthMm: 4600,
    leftTrimMm: 100,
    rightTrimMm: 100,
    minWidthMm: 4200,
    maxWidthMm: 4400,
    widthStepMm: 10,
    totalOverCap: 30,
    widthMode: 'FLEXIBLE',
    builtin: true
  },
  {
    id: 'preset-curtain-2800',
    name: '窗帘宽幅 2800 (2600–2760)',
    motherWidthMm: 2800,
    leftTrimMm: 20,
    rightTrimMm: 20,
    minWidthMm: 2600,
    maxWidthMm: 2760,
    widthStepMm: 10,
    totalOverCap: 8,
    widthMode: 'FLEXIBLE',
    builtin: true
  },
  {
    id: 'preset-board-1220',
    name: '标准板材 1220 (1080–1200)',
    motherWidthMm: 1220,
    leftTrimMm: 10,
    rightTrimMm: 10,
    minWidthMm: 1080,
    maxWidthMm: 1200,
    widthStepMm: 10,
    totalOverCap: 6,
    widthMode: 'FLEXIBLE',
    builtin: true
  }
];

const SLITTING_PRESETS_KEY = 'cutplan.slitting.widthPresets.v1';

export function loadSlittingPresets(): SlittingWidthPreset[] {
  try {
    const raw = localStorage.getItem(SLITTING_PRESETS_KEY);
    if (!raw) return [...DEFAULT_SLITTING_PRESETS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SLITTING_PRESETS];
    const custom = parsed.filter(
      (p: any) =>
        p &&
        typeof p.name === 'string' &&
        Number.isFinite(Number(p.motherWidthMm)) &&
        Number.isFinite(Number(p.minWidthMm)) &&
        Number.isFinite(Number(p.maxWidthMm))
    );
    return [...DEFAULT_SLITTING_PRESETS, ...custom.map((p: any) => ({ ...p, builtin: false }))];
  } catch {
    return [...DEFAULT_SLITTING_PRESETS];
  }
}

export function saveCustomSlittingPresets(allPresets: SlittingWidthPreset[]): SlittingWidthPreset[] {
  const custom = allPresets.filter((p) => !p.builtin);
  try {
    localStorage.setItem(SLITTING_PRESETS_KEY, JSON.stringify(custom));
  } catch {}
  return [...DEFAULT_SLITTING_PRESETS, ...custom];
}

export interface SlittingSolverOptions {
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

/** 一维分切可选刀架物理硬约束（全部对应 SlittingProblem.java 与 optimization-request.schema.json 精确字段）。 */
export interface SlittingPhysicalConstraintInput {
  maxKnives?: number | null;
  minBladeSpacingMm?: number | null;
  kerfMm?: number | null;
  forbiddenNarrowEdgeMinMm?: number | null;
  forbiddenNarrowEdgeMaxMm?: number | null;
}

/** 透传到 SLITTING_1D problem 的有效物理刀架约束子集（仅含正值或成对有效禁区）。 */
export interface SlittingPhysicalConstraintPayload {
  maxKnives?: number;
  minBladeSpacingMm?: number;
  kerfMm?: number;
  forbiddenNarrowEdgeMinMm?: number;
  forbiddenNarrowEdgeMaxMm?: number;
}

function toOptionalNonNegInt(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

/**
 * 校验工作台一维物理刀架约束（与 SlittingValidation.java 口径一致）：
 * - 0 或留空视为不限制；
 * - 危险细边丝禁区需上限 > 0 且 0 <= 下限 <= 上限 <= 100000；
 * - 若传入最小订单宽度，则提前阻断宽幅小于最小物理刀距的无解请求。
 */
export function validateSlittingPhysicalConstraints(
  input: SlittingPhysicalConstraintInput | null | undefined,
  minOrderWidthMm?: number
): string | null {
  if (!input) return null;
  const maxKnives = toOptionalNonNegInt(input.maxKnives);
  if (maxKnives !== null && maxKnives !== 0 && (maxKnives < 1 || maxKnives > 100)) {
    return '单车最大刀数须在 1–100 刀之间（填 0 表示不限制）';
  }
  const minBladeSpacingMm = toOptionalNonNegInt(input.minBladeSpacingMm);
  if (
    minBladeSpacingMm !== null &&
    minBladeSpacingMm !== 0 &&
    (minBladeSpacingMm < 1 || minBladeSpacingMm > 100_000)
  ) {
    return '最小物理刀距须在 1–100000 mm 之间（填 0 表示不限制）';
  }
  if (
    minBladeSpacingMm !== null &&
    minBladeSpacingMm > 0 &&
    typeof minOrderWidthMm === 'number' &&
    Number.isFinite(minOrderWidthMm) &&
    minOrderWidthMm > 0 &&
    minOrderWidthMm < minBladeSpacingMm
  ) {
    return `存在规格宽 ${Math.floor(minOrderWidthMm)} mm 小于机台最小物理刀距 ${minBladeSpacingMm} mm`;
  }
  const kerfMm = toOptionalNonNegInt(input.kerfMm);
  if (kerfMm !== null && (kerfMm < 0 || kerfMm > 500)) {
    return '每刀切缝损耗须在 0–500 mm 之间';
  }
  const fMin = toOptionalNonNegInt(input.forbiddenNarrowEdgeMinMm) ?? 0;
  const fMax = toOptionalNonNegInt(input.forbiddenNarrowEdgeMaxMm) ?? 0;
  if (fMin < 0 || fMax < 0 || fMin > 100_000 || fMax > 100_000) {
    return '危险细边丝禁区范围须在 0–100000 mm 之间';
  }
  if (fMin > 0 && fMax === 0) {
    return '启用危险细边丝禁区时须填写大于 0 的上限（且上限不小于下限）';
  }
  if (fMax > 0 && fMin > fMax) {
    return `危险细边丝禁区下限（${fMin} mm）不能大于上限（${fMax} mm）`;
  }
  return null;
}

/**
 * 构造透传给 POST /api/v2/optimization-jobs SLITTING_1D problem 的可选刀架硬约束字段。
 * 默认全 0/留空时返回空对象 {}，不改变默认 1D 求解请求体和幂等哈希。
 */
export function buildSlittingPhysicalConstraintFields(
  input: SlittingPhysicalConstraintInput | null | undefined
): SlittingPhysicalConstraintPayload {
  if (!input) return {};
  const payload: SlittingPhysicalConstraintPayload = {};
  const maxKnives = toOptionalNonNegInt(input.maxKnives);
  if (maxKnives !== null && maxKnives >= 1 && maxKnives <= 100) {
    payload.maxKnives = maxKnives;
  }
  const minBladeSpacingMm = toOptionalNonNegInt(input.minBladeSpacingMm);
  if (minBladeSpacingMm !== null && minBladeSpacingMm >= 1 && minBladeSpacingMm <= 100_000) {
    payload.minBladeSpacingMm = minBladeSpacingMm;
  }
  const kerfMm = toOptionalNonNegInt(input.kerfMm);
  if (kerfMm !== null && kerfMm >= 1 && kerfMm <= 500) {
    payload.kerfMm = kerfMm;
  }
  const fMin = toOptionalNonNegInt(input.forbiddenNarrowEdgeMinMm) ?? 0;
  const fMax = toOptionalNonNegInt(input.forbiddenNarrowEdgeMaxMm) ?? 0;
  if (fMax > 0 && fMin >= 0 && fMin <= fMax && fMax <= 100_000) {
    payload.forbiddenNarrowEdgeMinMm = fMin;
    payload.forbiddenNarrowEdgeMaxMm = fMax;
  }
  return payload;
}

export interface WorkbenchStrategyDef {
  id: string;
  name: string;
  badge: string;
  shortTag: string;
}

export const WORKBENCH_STRATEGIES_2D: WorkbenchStrategyDef[] = [
  { id: 'PS_FIXED', name: '经向缩长', badge: '经向', shortTag: '0° 保丝缕 · 缩长压紧' },
  { id: 'PS_ROT', name: '旋转缩长', badge: '旋转', shortTag: '异形 180° / 矩形 90°' },
  { id: 'DN_GA', name: '异形进化', badge: '异形', shortTag: '凹凸嵌合 · 进化寻优' },
  { id: 'DN_FIXED', name: '异形经向', badge: '异形', shortTag: '0° 保丝缕 · 凹凸嵌合' },
  { id: 'JAVA_FAST', name: '快速基线', badge: '极速', shortTag: '极速秒出对照' }
];

export interface StudioSettings {
  // Tab 1: 画布与常规
  theme: StudioThemeMode;
  vertical: boolean;
  showDimensions: boolean;
  showPath: boolean;
  showWorkflowGuide: boolean;
  startCorner: StartCornerType;

  // Tab 2: 裁切工艺与预设
  defectMarginMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  firstStageOrientation: FirstStageOrientation;
  defaultAllowRotation: boolean;

  // Tab 3: 料头与余料策略
  minRemnantWidthMm: number;
  minRemnantLengthMm: number;

  // Tab 4: 求解引擎与配额（2D + 1D Solartron-Cut NewSolver 全量参数）
  timeLimitSeconds: number;
  allowFallback: boolean;
  enabledStrategies2D: string[];
  slitProfile: SlittingProfile;
  slitRunBothProfiles: boolean;
  slitTimeLimitSeconds: number;
  slitTopK: number;
  slitMaxIterations: number;
  slitMaxPatterns: number;
  slitMaxDistinctWidths: number;
  slitStageTimeLimitMs: number;
  slitUseOptimizedAssignment: boolean;
  slitUnderPenalty: number;
  slitSeqGroupAlpha: number;
  slitSeqGroupBeta: number;
  slitLnsEnabled: boolean;

  // Tab 5: 导出与系统接入（含 CNC 后处理参数）
  exportPrefix: string;
  ticketShowCuts: boolean;
  cncCutFeed: number;
  cncRapidFeed: number;
  cncPlungeDelay: number;
  cncRetractDelay: number;
}

export const DEFAULT_SLITTING_SOLVER_SETTINGS = {
  slitProfile: 'FAST' as SlittingProfile,
  slitRunBothProfiles: false,
  slitTimeLimitSeconds: 30,
  slitTopK: 3,
  slitMaxIterations: 300,
  slitMaxPatterns: 800,
  slitMaxDistinctWidths: 4,
  slitStageTimeLimitMs: 120000,
  slitUseOptimizedAssignment: true,
  slitUnderPenalty: 1000000,
  slitSeqGroupAlpha: 1.0,
  slitSeqGroupBeta: 0.0,
  slitLnsEnabled: false
};

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  theme: 'light',
  vertical: true,
  showDimensions: true,
  showPath: false,
  showWorkflowGuide: false,
  startCorner: 'left-top',

  defectMarginMm: 20,
  trimStartMm: 0,
  pieceGapMm: 0,
  firstStageOrientation: 'horizontal',
  defaultAllowRotation: false,

  minRemnantWidthMm: 200,
  minRemnantLengthMm: 300,

  timeLimitSeconds: 5,
  allowFallback: true,
  enabledStrategies2D: ['PS_FIXED', 'PS_ROT', 'DN_GA', 'JAVA_FAST'],
  ...DEFAULT_SLITTING_SOLVER_SETTINGS,

  exportPrefix: 'CutPlan',
  ticketShowCuts: true,
  cncCutFeed: DEFAULT_CNC_POST_OPTIONS.cutFeed,
  cncRapidFeed: DEFAULT_CNC_POST_OPTIONS.rapidFeed,
  cncPlungeDelay: DEFAULT_CNC_POST_OPTIONS.plungeDelay,
  cncRetractDelay: DEFAULT_CNC_POST_OPTIONS.retractDelay
};

export function extractCncPostOptions(settings: StudioSettings): CncPostOptions {
  return {
    cutFeed: Math.min(60000, Math.max(100, Math.round(Number(settings.cncCutFeed) || DEFAULT_CNC_POST_OPTIONS.cutFeed))),
    rapidFeed: Math.min(100000, Math.max(500, Math.round(Number(settings.cncRapidFeed) || DEFAULT_CNC_POST_OPTIONS.rapidFeed))),
    plungeDelay: Math.min(10000, Math.max(0, Math.round(Number(settings.cncPlungeDelay ?? DEFAULT_CNC_POST_OPTIONS.plungeDelay)))),
    retractDelay: Math.min(10000, Math.max(0, Math.round(Number(settings.cncRetractDelay ?? DEFAULT_CNC_POST_OPTIONS.retractDelay))))
  };
}

export function applyThemeToDocument(theme: StudioThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

export function extractSlittingSolverOptions(settings: StudioSettings): SlittingSolverOptions {
  return {
    topK: Math.min(50, Math.max(0, Math.round(settings.slitTopK))),
    maxIterations: Math.min(5000, Math.max(1, Math.round(settings.slitMaxIterations))),
    maxPatterns: Math.min(20000, Math.max(1, Math.round(settings.slitMaxPatterns))),
    maxDistinctWidths: Math.min(20, Math.max(1, Math.round(settings.slitMaxDistinctWidths))),
    stageTimeLimitMs: Math.min(600000, Math.max(1000, Math.round(settings.slitStageTimeLimitMs))),
    useOptimizedAssignment: Boolean(settings.slitUseOptimizedAssignment),
    underPenalty: Math.max(0, Number(settings.slitUnderPenalty) || 0),
    seqGroupAlpha: Math.max(0, Number(settings.slitSeqGroupAlpha) || 0),
    seqGroupBeta: Math.max(0, Number(settings.slitSeqGroupBeta) || 0),
    lnsEnabled: Boolean(settings.slitLnsEnabled)
  };
}

const VALID_CORNERS: StartCornerType[] = ['left-top', 'right-bottom', 'right-top', 'left-bottom'];
const VALID_STRATEGY_IDS = new Set(WORKBENCH_STRATEGIES_2D.map((s) => s.id));
const PREF_KEY = 'cutplan.app.prefs';

function normalizeEnabledStrategies2D(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['JAVA_FAST'];
  const picked = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && VALID_STRATEGY_IDS.has(item)) {
      picked.add(item);
    }
  }
  const ordered = WORKBENCH_STRATEGIES_2D.map((s) => s.id).filter((id) => picked.has(id));
  return ordered.length > 0 ? ordered : ['JAVA_FAST'];
}

function readEnabledStrategies2D(raw: string | null): string[] {
  if (raw == null) {
    return [...DEFAULT_STUDIO_SETTINGS.enabledStrategies2D];
  }
  try {
    return normalizeEnabledStrategies2D(JSON.parse(raw));
  } catch {
    return ['JAVA_FAST'];
  }
}

function readNumber(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadStudioSettings(): StudioSettings {
  try {
    const rawPrefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const rawCorner = localStorage.getItem('cam_origin') as StartCornerType | null;
    const rawFirstStage = localStorage.getItem('cam_first_stage');
    const rawRot = localStorage.getItem('cam_rot');
    const rawWorkflowGuide = localStorage.getItem('cutplan.studio.showWorkflowGuide');
    const rawFallback = localStorage.getItem('cutplan.studio.allowFallback');
    const rawEnabledStrategies2D = localStorage.getItem('cutplan.studio.enabledStrategies2D');
    const rawTicketCuts = localStorage.getItem('cutplan.studio.ticketShowCuts');
    const rawPrefix = (localStorage.getItem('cutplan.studio.exportPrefix') || '').trim();
    const rawTheme = localStorage.getItem('cutplan.studio.theme');

    return {
      theme: rawTheme === 'dark' ? 'dark' : 'light',
      vertical:
        typeof rawPrefs.vertical === 'boolean'
          ? rawPrefs.vertical
          : DEFAULT_STUDIO_SETTINGS.vertical,
      showDimensions:
        typeof rawPrefs.showDimensions === 'boolean'
          ? rawPrefs.showDimensions
          : DEFAULT_STUDIO_SETTINGS.showDimensions,
      showPath:
        typeof rawPrefs.showPath === 'boolean'
          ? rawPrefs.showPath
          : DEFAULT_STUDIO_SETTINGS.showPath,
      showWorkflowGuide:
        rawWorkflowGuide === '1'
          ? true
          : rawWorkflowGuide === '0'
          ? false
          : DEFAULT_STUDIO_SETTINGS.showWorkflowGuide,
      startCorner:
        rawCorner && VALID_CORNERS.includes(rawCorner)
          ? rawCorner
          : DEFAULT_STUDIO_SETTINGS.startCorner,

      defectMarginMm: readNumber(
        localStorage.getItem('cam_margin'),
        DEFAULT_STUDIO_SETTINGS.defectMarginMm,
        0,
        200
      ),
      trimStartMm: readNumber(
        localStorage.getItem('cam_trim'),
        DEFAULT_STUDIO_SETTINGS.trimStartMm,
        0,
        1000
      ),
      pieceGapMm: readNumber(
        localStorage.getItem('cutplan.studio.pieceGapMm'),
        DEFAULT_STUDIO_SETTINGS.pieceGapMm,
        0,
        50
      ),
      firstStageOrientation:
        rawFirstStage === 'vertical' || rawFirstStage === 'horizontal'
          ? rawFirstStage
          : DEFAULT_STUDIO_SETTINGS.firstStageOrientation,
      defaultAllowRotation:
        rawRot === '1' ? true : rawRot === '0' ? false : DEFAULT_STUDIO_SETTINGS.defaultAllowRotation,

      minRemnantWidthMm: readNumber(
        localStorage.getItem('cam_min_rem_w'),
        DEFAULT_STUDIO_SETTINGS.minRemnantWidthMm,
        50,
        2000
      ),
      minRemnantLengthMm: readNumber(
        localStorage.getItem('cam_min_rem_l'),
        DEFAULT_STUDIO_SETTINGS.minRemnantLengthMm,
        50,
        5000
      ),

      timeLimitSeconds: readNumber(
        localStorage.getItem('cam_timeout'),
        DEFAULT_STUDIO_SETTINGS.timeLimitSeconds,
        1,
        60
      ),
      allowFallback:
        rawFallback === '0'
          ? false
          : rawFallback === '1'
          ? true
          : DEFAULT_STUDIO_SETTINGS.allowFallback,
      enabledStrategies2D: readEnabledStrategies2D(rawEnabledStrategies2D),

      slitProfile:
        localStorage.getItem('cutplan.slit.profile') === 'QUALITY'
          ? 'QUALITY'
          : DEFAULT_STUDIO_SETTINGS.slitProfile,
      slitRunBothProfiles:
        localStorage.getItem('cutplan.slit.runBothProfiles') === '1'
          ? true
          : localStorage.getItem('cutplan.slit.runBothProfiles') === '0'
          ? false
          : DEFAULT_STUDIO_SETTINGS.slitRunBothProfiles,
      slitTimeLimitSeconds: readNumber(
        localStorage.getItem('cutplan.slit.timeLimitSeconds'),
        DEFAULT_STUDIO_SETTINGS.slitTimeLimitSeconds,
        1,
        180
      ),
      slitTopK: readNumber(
        localStorage.getItem('cutplan.slit.topK'),
        DEFAULT_STUDIO_SETTINGS.slitTopK,
        0,
        50
      ),
      slitMaxIterations: readNumber(
        localStorage.getItem('cutplan.slit.maxIterations'),
        DEFAULT_STUDIO_SETTINGS.slitMaxIterations,
        1,
        5000
      ),
      slitMaxPatterns: readNumber(
        localStorage.getItem('cutplan.slit.maxPatterns'),
        DEFAULT_STUDIO_SETTINGS.slitMaxPatterns,
        1,
        20000
      ),
      slitMaxDistinctWidths: readNumber(
        localStorage.getItem('cutplan.slit.maxDistinctWidths'),
        DEFAULT_STUDIO_SETTINGS.slitMaxDistinctWidths,
        1,
        20
      ),
      slitStageTimeLimitMs: readNumber(
        localStorage.getItem('cutplan.slit.stageTimeLimitMs'),
        DEFAULT_STUDIO_SETTINGS.slitStageTimeLimitMs,
        1000,
        600000
      ),
      slitUseOptimizedAssignment:
        localStorage.getItem('cutplan.slit.useOptimizedAssignment') === '0'
          ? false
          : localStorage.getItem('cutplan.slit.useOptimizedAssignment') === '1'
          ? true
          : DEFAULT_STUDIO_SETTINGS.slitUseOptimizedAssignment,
      slitUnderPenalty: readNumber(
        localStorage.getItem('cutplan.slit.underPenalty'),
        DEFAULT_STUDIO_SETTINGS.slitUnderPenalty,
        0,
        1e12
      ),
      slitSeqGroupAlpha: readNumber(
        localStorage.getItem('cutplan.slit.seqGroupAlpha'),
        DEFAULT_STUDIO_SETTINGS.slitSeqGroupAlpha,
        0,
        1000
      ),
      slitSeqGroupBeta: readNumber(
        localStorage.getItem('cutplan.slit.seqGroupBeta'),
        DEFAULT_STUDIO_SETTINGS.slitSeqGroupBeta,
        0,
        1000
      ),
      slitLnsEnabled:
        localStorage.getItem('cutplan.slit.lnsEnabled') === '1'
          ? true
          : localStorage.getItem('cutplan.slit.lnsEnabled') === '0'
          ? false
          : DEFAULT_STUDIO_SETTINGS.slitLnsEnabled,

      exportPrefix: rawPrefix || DEFAULT_STUDIO_SETTINGS.exportPrefix,
      ticketShowCuts:
        rawTicketCuts === '0'
          ? false
          : rawTicketCuts === '1'
          ? true
          : DEFAULT_STUDIO_SETTINGS.ticketShowCuts,
      cncCutFeed: readNumber(
        localStorage.getItem('cutplan.studio.cncCutFeed'),
        DEFAULT_STUDIO_SETTINGS.cncCutFeed,
        100,
        60000
      ),
      cncRapidFeed: readNumber(
        localStorage.getItem('cutplan.studio.cncRapidFeed'),
        DEFAULT_STUDIO_SETTINGS.cncRapidFeed,
        500,
        100000
      ),
      cncPlungeDelay: readNumber(
        localStorage.getItem('cutplan.studio.cncPlungeDelay'),
        DEFAULT_STUDIO_SETTINGS.cncPlungeDelay,
        0,
        10000
      ),
      cncRetractDelay: readNumber(
        localStorage.getItem('cutplan.studio.cncRetractDelay'),
        DEFAULT_STUDIO_SETTINGS.cncRetractDelay,
        0,
        10000
      )
    };
  } catch {
    return {
      ...DEFAULT_STUDIO_SETTINGS,
      enabledStrategies2D: [...DEFAULT_STUDIO_SETTINGS.enabledStrategies2D]
    };
  }
}

export function validateStudioSettings(draft: StudioSettings): string | null {
  if (!Number.isFinite(draft.defectMarginMm) || draft.defectMarginMm < 0 || draft.defectMarginMm > 200) {
    return '疵点避让安全间距须在 0–200 mm 之间';
  }
  if (!Number.isFinite(draft.trimStartMm) || draft.trimStartMm < 0 || draft.trimStartMm > 1000) {
    return '卷头默认修边长度须在 0–1000 mm 之间';
  }
  if (!Number.isFinite(draft.pieceGapMm) || draft.pieceGapMm < 0 || draft.pieceGapMm > 50) {
    return '裁片默认安全间距须在 0–50 mm 之间';
  }
  if (
    !Number.isFinite(draft.minRemnantWidthMm) ||
    draft.minRemnantWidthMm < 50 ||
    draft.minRemnantWidthMm > 2000
  ) {
    return '候选料头最小回收宽度须在 50–2000 mm 之间';
  }
  if (
    !Number.isFinite(draft.minRemnantLengthMm) ||
    draft.minRemnantLengthMm < 50 ||
    draft.minRemnantLengthMm > 5000
  ) {
    return '候选料头最小回收长度须在 50–5000 mm 之间';
  }
  if (!Number.isFinite(draft.timeLimitSeconds) || draft.timeLimitSeconds < 1 || draft.timeLimitSeconds > 60) {
    return '二维单作业默认求解时限须在 1–60 秒之间';
  }
  if (
    !Number.isFinite(draft.slitTimeLimitSeconds) ||
    draft.slitTimeLimitSeconds < 1 ||
    draft.slitTimeLimitSeconds > 180
  ) {
    return '一维分切默认求解时限须在 1–180 秒之间';
  }
  if (!Number.isFinite(draft.slitTopK) || draft.slitTopK < 0 || draft.slitTopK > 50) {
    return '一维 TOP K 超产宽度数须在 0–50 之间';
  }
  if (
    !Number.isFinite(draft.slitMaxIterations) ||
    draft.slitMaxIterations < 1 ||
    draft.slitMaxIterations > 5000
  ) {
    return '一维列生成最大迭代次数须在 1–5000 之间';
  }
  if (
    !Number.isFinite(draft.slitMaxPatterns) ||
    draft.slitMaxPatterns < 1 ||
    draft.slitMaxPatterns > 20000
  ) {
    return '一维最大花型池上限须在 1–20000 之间';
  }
  if (
    !Number.isFinite(draft.slitMaxDistinctWidths) ||
    draft.slitMaxDistinctWidths < 1 ||
    draft.slitMaxDistinctWidths > 20
  ) {
    return '一维单卷不同宽幅上限须在 1–20 之间';
  }
  if (
    !Number.isFinite(draft.slitStageTimeLimitMs) ||
    draft.slitStageTimeLimitMs < 1000 ||
    draft.slitStageTimeLimitMs > 600000
  ) {
    return '单阶段求解时限须在 1000–600000 毫秒之间';
  }
  if (!Number.isFinite(draft.slitUnderPenalty) || draft.slitUnderPenalty < 0) {
    return '一维欠产惩罚系数必须为非负数';
  }
  if (!Number.isFinite(draft.slitSeqGroupAlpha) || draft.slitSeqGroupAlpha < 0) {
    return '一维顺序组权重 alpha 必须为非负数';
  }
  if (!Number.isFinite(draft.slitSeqGroupBeta) || draft.slitSeqGroupBeta < 0) {
    return '一维顺序组权重 beta 必须为非负数';
  }
  if (
    !Array.isArray(draft.enabledStrategies2D) ||
    draft.enabledStrategies2D.filter((id) => VALID_STRATEGY_IDS.has(id)).length < 1
  ) {
    return '至少保留启用 1 个二维并行排版算法';
  }
  const cleanPrefix = draft.exportPrefix.trim();
  if (!cleanPrefix || cleanPrefix.length > 32 || /[\\/:*?"<>|]/.test(cleanPrefix)) {
    return '导出文件名前缀须为 1–32 个合法文件名字符（不含 \\ / : * ? " < > |）';
  }
  if (!Number.isFinite(draft.cncCutFeed) || draft.cncCutFeed < 100 || draft.cncCutFeed > 60000) {
    return 'CNC 切割进给速度须在 100–60000 mm/min 之间';
  }
  if (!Number.isFinite(draft.cncRapidFeed) || draft.cncRapidFeed < 500 || draft.cncRapidFeed > 100000) {
    return 'CNC 空程进给速度须在 500–100000 mm/min 之间';
  }
  if (!Number.isFinite(draft.cncPlungeDelay) || draft.cncPlungeDelay < 0 || draft.cncPlungeDelay > 10000) {
    return 'CNC 下刀延时须在 0–10000 ms 之间';
  }
  if (!Number.isFinite(draft.cncRetractDelay) || draft.cncRetractDelay < 0 || draft.cncRetractDelay > 10000) {
    return 'CNC 抬刀延时须在 0–10000 ms 之间';
  }
  return null;
}

export function persistStudioSettings(next: StudioSettings): StudioSettings {
  const sanitized: StudioSettings = {
    ...next,
    theme: next.theme === 'dark' ? 'dark' : 'light',
    showWorkflowGuide: Boolean(next.showWorkflowGuide),
    defectMarginMm: Math.round(next.defectMarginMm * 10) / 10,
    trimStartMm: Math.round(next.trimStartMm * 10) / 10,
    pieceGapMm: Math.round(next.pieceGapMm * 10) / 10,
    minRemnantWidthMm: Math.round(next.minRemnantWidthMm * 10) / 10,
    minRemnantLengthMm: Math.round(next.minRemnantLengthMm * 10) / 10,
    timeLimitSeconds: Math.min(60, Math.max(1, Math.round(next.timeLimitSeconds))),
    enabledStrategies2D: normalizeEnabledStrategies2D(next.enabledStrategies2D),
    slitProfile: next.slitProfile === 'QUALITY' ? 'QUALITY' : 'FAST',
    slitRunBothProfiles: Boolean(next.slitRunBothProfiles),
    slitTimeLimitSeconds: Math.min(180, Math.max(1, Math.round(next.slitTimeLimitSeconds))),
    slitTopK: Math.min(50, Math.max(0, Math.round(next.slitTopK))),
    slitMaxIterations: Math.min(5000, Math.max(1, Math.round(next.slitMaxIterations))),
    slitMaxPatterns: Math.min(20000, Math.max(1, Math.round(next.slitMaxPatterns))),
    slitMaxDistinctWidths: Math.min(20, Math.max(1, Math.round(next.slitMaxDistinctWidths))),
    slitStageTimeLimitMs: Math.min(600000, Math.max(1000, Math.round(next.slitStageTimeLimitMs))),
    slitUseOptimizedAssignment: Boolean(next.slitUseOptimizedAssignment),
    slitUnderPenalty: Math.max(0, Number(next.slitUnderPenalty) || 0),
    slitSeqGroupAlpha: Math.max(0, Number(next.slitSeqGroupAlpha) || 0),
    slitSeqGroupBeta: Math.max(0, Number(next.slitSeqGroupBeta) || 0),
    slitLnsEnabled: Boolean(next.slitLnsEnabled),
    exportPrefix: next.exportPrefix.trim() || 'CutPlan',
    cncCutFeed: Math.min(60000, Math.max(100, Math.round(Number(next.cncCutFeed) || DEFAULT_CNC_POST_OPTIONS.cutFeed))),
    cncRapidFeed: Math.min(100000, Math.max(500, Math.round(Number(next.cncRapidFeed) || DEFAULT_CNC_POST_OPTIONS.rapidFeed))),
    cncPlungeDelay: Math.min(10000, Math.max(0, Math.round(Number(next.cncPlungeDelay ?? DEFAULT_CNC_POST_OPTIONS.plungeDelay)))),
    cncRetractDelay: Math.min(10000, Math.max(0, Math.round(Number(next.cncRetractDelay ?? DEFAULT_CNC_POST_OPTIONS.retractDelay))))
  };

  applyThemeToDocument(sanitized.theme);

  try {
    const existingPrefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        ...existingPrefs,
        vertical: sanitized.vertical,
        showDimensions: sanitized.showDimensions,
        showPath: sanitized.showPath
      })
    );
    localStorage.setItem('cutplan.studio.theme', sanitized.theme);
    localStorage.setItem('cutplan.studio.showWorkflowGuide', sanitized.showWorkflowGuide ? '1' : '0');
    localStorage.setItem('cam_origin', sanitized.startCorner);
    localStorage.setItem('cam_margin', String(sanitized.defectMarginMm));
    localStorage.setItem('cam_trim', String(sanitized.trimStartMm));
    localStorage.setItem('cutplan.studio.pieceGapMm', String(sanitized.pieceGapMm));
    localStorage.setItem('cam_first_stage', sanitized.firstStageOrientation);
    localStorage.setItem('cam_rot', sanitized.defaultAllowRotation ? '1' : '0');
    localStorage.setItem('cam_min_rem_w', String(sanitized.minRemnantWidthMm));
    localStorage.setItem('cam_min_rem_l', String(sanitized.minRemnantLengthMm));
    localStorage.setItem('cam_timeout', String(sanitized.timeLimitSeconds));
    localStorage.setItem('cutplan.studio.allowFallback', sanitized.allowFallback ? '1' : '0');
    localStorage.setItem(
      'cutplan.studio.enabledStrategies2D',
      JSON.stringify(sanitized.enabledStrategies2D)
    );
    localStorage.setItem('cutplan.slit.profile', sanitized.slitProfile);
    localStorage.setItem(
      'cutplan.slit.runBothProfiles',
      sanitized.slitRunBothProfiles ? '1' : '0'
    );
    localStorage.setItem('cutplan.slit.timeLimitSeconds', String(sanitized.slitTimeLimitSeconds));
    localStorage.setItem('cutplan.slit.topK', String(sanitized.slitTopK));
    localStorage.setItem('cutplan.slit.maxIterations', String(sanitized.slitMaxIterations));
    localStorage.setItem('cutplan.slit.maxPatterns', String(sanitized.slitMaxPatterns));
    localStorage.setItem(
      'cutplan.slit.maxDistinctWidths',
      String(sanitized.slitMaxDistinctWidths)
    );
    localStorage.setItem(
      'cutplan.slit.stageTimeLimitMs',
      String(sanitized.slitStageTimeLimitMs)
    );
    localStorage.setItem(
      'cutplan.slit.useOptimizedAssignment',
      sanitized.slitUseOptimizedAssignment ? '1' : '0'
    );
    localStorage.setItem('cutplan.slit.underPenalty', String(sanitized.slitUnderPenalty));
    localStorage.setItem('cutplan.slit.seqGroupAlpha', String(sanitized.slitSeqGroupAlpha));
    localStorage.setItem('cutplan.slit.seqGroupBeta', String(sanitized.slitSeqGroupBeta));
    localStorage.setItem('cutplan.slit.lnsEnabled', sanitized.slitLnsEnabled ? '1' : '0');
    localStorage.setItem('cutplan.studio.exportPrefix', sanitized.exportPrefix);
    localStorage.setItem('cutplan.studio.ticketShowCuts', sanitized.ticketShowCuts ? '1' : '0');
    localStorage.setItem('cutplan.studio.cncCutFeed', String(sanitized.cncCutFeed));
    localStorage.setItem('cutplan.studio.cncRapidFeed', String(sanitized.cncRapidFeed));
    localStorage.setItem('cutplan.studio.cncPlungeDelay', String(sanitized.cncPlungeDelay));
    localStorage.setItem('cutplan.studio.cncRetractDelay', String(sanitized.cncRetractDelay));
  } catch {}

  return sanitized;
}
