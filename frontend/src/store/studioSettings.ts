export type StartCornerType = 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom';
export type FirstStageOrientation = 'horizontal' | 'vertical';
export type SettingsTabId = 'general' | 'craft' | 'remnant' | 'engines' | 'integration';

export interface WorkbenchStrategyDef {
  id: string;
  name: string;
  badge: string;
  shortTag: string;
}

export const WORKBENCH_STRATEGIES_2D: WorkbenchStrategyDef[] = [
  { id: 'PS_FIXED', name: 'PackingSolver 严格经向缩长', badge: 'C++ 原生', shortTag: '0° 保丝缕 · 二分缩长压紧' },
  { id: 'PS_ROT', name: 'PackingSolver 180°/90° 倒顺缩长', badge: 'C++ 原生', shortTag: '异形 180° / 矩形 90° · 最短版长' },
  { id: 'DN_GA', name: 'Deepnest NFP+GA 进化嵌套', badge: 'NFP+GA', shortTag: 'Minkowski 临界多边形 + 遗传共边寻优' },
  { id: 'DN_FIXED', name: 'Deepnest 严格经向直排', badge: 'NFP 经向', shortTag: '0° 严保纱向 · 临界多边形紧贴' },
  { id: 'JAVA_FAST', name: 'Java 天际线/直刀快速基线', badge: 'Java 内置', shortTag: '极速秒出基线对照与降级兜底' }
];

export interface StudioSettings {
  // Tab 1: 画布与常规
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

  // Tab 4: 求解引擎与配额
  timeLimitSeconds: number;
  allowFallback: boolean;
  enabledStrategies2D: string[];

  // Tab 5: 导出与系统接入
  exportPrefix: string;
  ticketShowCuts: boolean;
}

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
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

  exportPrefix: 'CutPlan',
  ticketShowCuts: true
};

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

    return {
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
        120
      ),
      allowFallback:
        rawFallback === '0'
          ? false
          : rawFallback === '1'
          ? true
          : DEFAULT_STUDIO_SETTINGS.allowFallback,
      enabledStrategies2D: readEnabledStrategies2D(rawEnabledStrategies2D),

      exportPrefix: rawPrefix || DEFAULT_STUDIO_SETTINGS.exportPrefix,
      ticketShowCuts:
        rawTicketCuts === '0'
          ? false
          : rawTicketCuts === '1'
          ? true
          : DEFAULT_STUDIO_SETTINGS.ticketShowCuts
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
  if (!Number.isFinite(draft.timeLimitSeconds) || draft.timeLimitSeconds < 1 || draft.timeLimitSeconds > 120) {
    return '单作业默认求解时限须在 1–120 秒之间';
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
  return null;
}

export function persistStudioSettings(next: StudioSettings): StudioSettings {
  const sanitized: StudioSettings = {
    ...next,
    showWorkflowGuide: Boolean(next.showWorkflowGuide),
    defectMarginMm: Math.round(next.defectMarginMm * 10) / 10,
    trimStartMm: Math.round(next.trimStartMm * 10) / 10,
    pieceGapMm: Math.round(next.pieceGapMm * 10) / 10,
    minRemnantWidthMm: Math.round(next.minRemnantWidthMm * 10) / 10,
    minRemnantLengthMm: Math.round(next.minRemnantLengthMm * 10) / 10,
    timeLimitSeconds: Math.round(next.timeLimitSeconds),
    enabledStrategies2D: normalizeEnabledStrategies2D(next.enabledStrategies2D),
    exportPrefix: next.exportPrefix.trim() || 'CutPlan'
  };

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
    localStorage.setItem('cutplan.studio.exportPrefix', sanitized.exportPrefix);
    localStorage.setItem('cutplan.studio.ticketShowCuts', sanitized.ticketShowCuts ? '1' : '0');
  } catch {}

  return sanitized;
}
