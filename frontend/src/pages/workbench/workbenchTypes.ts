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
    name: 'PackingSolver 严格经向缩长',
    shortTag: '0° 保丝缕 · 二分缩长压紧',
    badge: 'C++ 原生',
    description: '保持全部裁片严格 0° 丝缕方向，多轮二分缩短并压紧唛架长度',
    halfTurn: false,
    forceRotateRect: false,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'PS_ROT',
    name: 'PackingSolver 180°/90° 倒顺缩长',
    shortTag: '异形 180° / 矩形 90° · 最短版长',
    badge: 'C++ 原生',
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
    name: 'Deepnest NFP+GA 进化嵌套',
    shortTag: 'Minkowski 临界多边形 + 遗传共边寻优',
    badge: 'NFP+GA',
    description: '使用临界多边形卷积与遗传算法进化搜索凹凸互补与共边奖励',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 8
  },
  {
    id: 'DN_FIXED',
    name: 'Deepnest 严格经向直排',
    shortTag: '0° 严保纱向 · 临界多边形紧贴',
    badge: 'NFP 经向',
    description: '保持 0° 丝缕方向，采用 Deepnest NFP 精确凹凸嵌套直排对照',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 5
  },
  {
    id: 'JAVA_FAST',
    name: 'Java 天际线/直刀快速基线',
    shortTag: '极速秒出基线对照与降级兜底',
    badge: 'Java 内置',
    description: '内置天际线/直刀快速启发式引擎，作多算法对照与极速基线',
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
  { id: 'SHORTEN_KIT', label: '齐套最短版长', desc: '装入全部待排需求并压紧用料长度' },
  { id: 'SHORTEN_GAP_FILL', label: '齐套 + 空隙补备片', desc: '齐套后在空隙填补小件提升利用率' },
  { id: 'FIXED_BED', label: '定长台板装入', desc: '按版长上限单次装入最大裁片面积' },
  { id: 'MULTI_WIDTH', label: '多门幅阶梯比选', desc: '批量对比多个门幅的单耗与版长' }
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
