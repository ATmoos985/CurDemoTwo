import { Scenario2DType, ShapeGeometry } from '../../store/useStudioStore';

export interface SolverStrategyDef {
  id: string;
  name: string;
  shortTag: string;
  badge: string;
  description: string;
  halfTurn: boolean;
  forceRotateRect?: boolean;
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
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'PS_ROT',
    name: '旋转缩长',
    shortTag: '180°/90° · 最短版长',
    badge: '旋转',
    description: '异形片允许 180° 倒顺对排、矩形允许 90° 旋转，追求最短版长',
    halfTurn: true,
    forceRotateRect: true,
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
    description: '针对异形裁片多轮搜索凹凸互补与共边压紧',
    halfTurn: true,
    forceRotateRect: true,
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
    description: '快速启发式排料基线，用于多方案对照与兜底',
    halfTurn: false,
    forceRotateRect: false,
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

export const STRIP_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#4f46e5'
];

export interface DemandRowView {
  key: string;
  rawId: number | string;
  index: number;
  name: string;
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
