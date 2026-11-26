import type { Scenario2DType, ShapeGeometry } from '../../store/studioTypes';

export interface SolverStrategyDef {
  id: string;
  name: string;
  shortTag: string;
  badge: string;
  description: string;
  halfTurn: boolean;
  forceRotateRect?: boolean;
  lockZeroGrain?: boolean;
  shorten: boolean;
  gapFill: boolean;
  enginePref: 'auto' | 'java' | 'deepnest';
  timeLimit: number;
}

export const STRATEGIES_2D: SolverStrategyDef[] = [
  {
    id: 'PS_FIXED',
    name: '经向缩长',
    shortTag: '0° 保丝缕 · 缩长压紧',
    badge: '经向',
    description: '保持全部裁片严格 0° 丝缕方向，多轮缩短并压紧版长',
    halfTurn: false,
    forceRotateRect: false,
    lockZeroGrain: true,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'PS_ROT',
    name: '旋转缩长',
    shortTag: '按工艺允许旋转 · 缩长',
    badge: '旋转',
    description: '在需求工艺允许的 180°/90° 方向约束内缩短版长，绝不越权旋转禁用件',
    halfTurn: true,
    forceRotateRect: false,
    lockZeroGrain: false,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'DN_GA',
    name: '异形进化',
    shortTag: '凹凸嵌合 · 进化寻优',
    badge: '异形',
    description: '在需求允许方向内对异形裁片多轮搜索凹凸互补与共边压紧',
    halfTurn: true,
    forceRotateRect: false,
    lockZeroGrain: false,
    shorten: true,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 8
  },
  {
    id: 'DN_FIXED',
    name: '异形经向',
    shortTag: '0° 保丝缕 · 凹凸嵌合',
    badge: '异形',
    description: '保持 0° 丝缕方向，针对异形轮廓精确凹凸嵌套直排',
    halfTurn: false,
    forceRotateRect: false,
    lockZeroGrain: true,
    shorten: false,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 5
  },
  {
    id: 'JAVA_FAST',
    name: '快速基线',
    shortTag: '极速秒出对照',
    badge: '极速',
    description: '按需求自身方向约束快速启发式排料，用于多方案对照与兜底',
    halfTurn: false,
    forceRotateRect: false,
    lockZeroGrain: false,
    shorten: false,
    gapFill: false,
    enginePref: 'java',
    timeLimit: 5
  }
];

export const LEGACY_STRATEGY_ALIAS: Record<string, string> = {
  SHORTEN_FIXED: 'PS_FIXED',
  SHORTEN_HALF_TURN: 'PS_ROT',
  DEEPNEST_NFP_GA: 'DN_GA',
  DEEPNEST_FIXED_GRAIN: 'DN_FIXED',
  JAVA_HEURISTIC: 'JAVA_FAST'
};

export const DEFAULT_ENABLED_STRATEGIES = ['PS_FIXED', 'PS_ROT', 'DN_GA', 'JAVA_FAST'];

export const SCENARIOS_2D: { id: Scenario2DType; label: string; desc: string }[] = [
  { id: 'SHORTEN_KIT', label: '齐套最短', desc: '装入全部待排需求并压紧用料长度' },
  { id: 'SHORTEN_GAP_FILL', label: '齐套补空', desc: '齐套后在空隙填补小件提升利用率' },
  { id: 'FIXED_BED', label: '定长装满', desc: '按版长上限单次装入最大裁片面积' },
  { id: 'MULTI_WIDTH', label: '多幅比选', desc: '批量对比多个门幅的单耗与版长' }
];

export interface DemandRowView {
  key: string;
  rawId: number | string;
  index: number;
  name: string;
  sourceTaskId?: string;
  sourceTaskName?: string;
  sourceLineId?: number;
  width: number;
  length: number;
  shape: ShapeGeometry | undefined;
  compactDim: string;
  specText: string;
  kindText: string;
  ordered: number;
  done: number;
  planned: number;
  uncut: number;
  cand: number;
  afterCandUncut: number;
  areaM2: number;
}

export interface OverviewStats {
  itemCount: number;
  ordered: number;
  done: number;
  planned: number;
  settled: number;
  uncut: number;
  cand: number;
  afterCandUncut: number;
  totalAreaM2: number;
  pct: number;
  unit: string;
}

export interface LastConfirmSummary {
  schemeId: string;
  openRemaining: number;
  state: string;
}

export interface DefectScheduleRow {
  carNo: number;
  startY: number;
  endY: number;
  comp: string;
  avoided: boolean;
}

export interface MultiMaterialCandidateRollOption {
  rollId: string;
  rollModel: string;
  width: number;
  availableLengthMm: number;
  batchNo: string;
  color: string;
  matchesModel: boolean;
  matchesBatch: boolean;
  matchesColor: boolean;
  /** 是否同时满足品号/缸号/色号条件（默认“全部合格同型卷”范围） */
  eligible: boolean;
  /** 开启强同缸约束时不合规卷禁止勾选 */
  blockedByStrict: boolean;
  mismatchReason?: string;
}

export interface MultiMaterialFilterContext {
  materialModel?: string;
  requiredBatchNo?: string;
  requiredColor?: string;
  strictBatchMatch?: boolean;
}
