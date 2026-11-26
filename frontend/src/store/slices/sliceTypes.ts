import type { StateCreator } from 'zustand';
import type { SlittingProfile, SlittingWidthMode, StudioSettings } from '../studioSettings';
import type {
  CanvasMode2D,
  CanvasSpecPatch,
  DemandCluster,
  DemandFamilySummary,
  DemandItem,
  MultiMaterialRunSummary,
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingOrderLine,
  SlittingSchemeRun,
  StrategyJobRun,
  WorkbenchDraftPayload,
  WorkbenchLaunchPreset
} from '../studioTypes';

/** 全局维度、场景导航、草稿恢复与系统设置切片 */
export interface WorkspaceSlice {
  activeDimension: '2D' | '1D';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  scenario1D: Scenario1DType;
  settings: StudioSettings;

  setActiveDimension: (dim: '2D' | '1D') => void;
  setScenario2D: (sc: Scenario2DType) => void;
  setMultiWidthsText2D: (txt: string) => void;
  setScenario1D: (sc: Scenario1DType) => void;
  restoreWorkbenchDraft: (draft: WorkbenchDraftPayload) => void;
  updateStudioSettings: (next: StudioSettings) => StudioSettings;
}

/** 纸样模板库与尺码配比域切片 */
export interface TemplateSlice {
  clusters: DemandCluster[];
  clusterSelections: Record<string, Record<string, number>>;

  syncTemplatesFromServer: () => Promise<void>;
  setClusterCount: (clusterId: string, sizeKey: string, count: number) => void;
  addCustomCluster: (cluster: DemandCluster) => void;
  deleteCustomCluster: (clusterId: string) => void;
  importDxfAsCluster: (text: string, fileName: string) => DemandCluster;
  loadClusterInto2D: (clusterId: string, append?: boolean) => void;
  loadSelectedClustersInto2D: (clusterIds: string[], append?: boolean) => void;
  loadClusterInto1D: (clusterId: string, append?: boolean) => void;
}

/** 二维排料工作台、多料联排与候选方案域切片 */
export interface Workbench2DSlice {
  canvasMode: CanvasMode2D;
  canvasWidthMm: number;
  canvasLengthMm: number;
  /** 连续开卷可调起切点（mm），null 表示自动跟随实卷已切终点 usedLength */
  windowStartY2D: number | null;
  pieceGapMm: number;
  trimStartMm: number;
  selectedRollId: string;
  selectedRemnantId: string;
  /** 多料联排参数：优先消化料头、料头接力上限（0..20）、指定候选母卷 ID（空表示全部合格同型卷） */
  multiPreferRemnants: boolean;
  multiMaxRemnants: number;
  multiCandidateRollIds: string[];
  multiMaterialSummary: MultiMaterialRunSummary | null;
  materialModel2D: string;
  loadedTaskId: string | null;
  loadedTaskName: string | null;
  loadedExternalRef: string | null;
  mergedSourceTaskIds: string[];
  activeDemands2D: DemandItem[];
  selectedStrategies2D: string[];
  strategyRuns2D: StrategyJobRun[];
  schemes2D: SavedScheme2D[];
  activeSchemeId2D: string | null;

  setCanvasSpec: (spec: CanvasSpecPatch) => void;
  setActiveDemands2D: (demands: DemandItem[]) => void;
  updateDemand2D: (id: number, patch: Partial<DemandItem>) => void;
  removeDemand2D: (id: number) => void;
  addBlankDemand2D: () => void;
  toggleStrategy2D: (strategyId: string) => void;
  setStrategyRuns2D: (
    runs: StrategyJobRun[] | ((prev: StrategyJobRun[]) => StrategyJobRun[])
  ) => void;
  addSchemes2D: (
    newSchemes: SavedScheme2D[],
    options?: { selectIfBetter?: boolean; batchIds?: ReadonlySet<string> }
  ) => void;
  setSchemes2D: (schemes: SavedScheme2D[], activeId?: string | null) => void;
  setMultiMaterialSummary: (summary: MultiMaterialRunSummary | null) => void;
  removeScheme2D: (id: string) => void;
  clearSchemes2D: () => void;
  setActiveScheme2D: (id: string | null) => void;
  markSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId?: string) => void;
}

/** 一维定长分切排程域切片 */
export interface Workbench1DSlice {
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitWidthMode: SlittingWidthMode;
  slitProfile: SlittingProfile;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  /** 一维可选刀架物理硬约束（0 表示不限制，仅正值/有效禁区透传后端 SLITTING_1D） */
  slitMaxKnives: number;
  slitMinBladeSpacingMm: number;
  slitKerfMm: number;
  slitForbiddenNarrowEdgeMinMm: number;
  slitForbiddenNarrowEdgeMaxMm: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitRollId: string;
  slitMaterialModel: string;
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string | null;
  slitMergedSourceTaskIds: string[];
  slitOrders: SlittingOrderLine[];
  slitSchemes: SlittingSchemeRun[];
  activeSlitSchemeId: string | null;

  setSlitSpec: (spec: Partial<StudioState>) => void;
  updateSlitOrder: (id: string, patch: Partial<SlittingOrderLine>) => void;
  addSlitOrder: () => void;
  removeSlitOrder: (id: string) => void;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  setActiveSlitScheme: (id: string | null) => void;
  markSlitSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId?: string) => void;
}

/** 需求池载入、多族合排与三态进度同步域切片 */
export interface DemandPoolSlice {
  loadDemandFamilyIntoWorkbench: (
    family: DemandFamilySummary,
    preset?: WorkbenchLaunchPreset
  ) => void;
  syncDemandFamilyProgress: (family: DemandFamilySummary) => void;
  syncMergedDemandFamiliesProgress: (families: DemandFamilySummary[]) => void;
  loadDemandFamiliesMergedIntoWorkbench: (families: DemandFamilySummary[]) => void;
}

/** 完整排料工作台根状态（由五个正交业务切片组合而成） */
export type StudioState = WorkspaceSlice &
  TemplateSlice &
  Workbench2DSlice &
  Workbench1DSlice &
  DemandPoolSlice;

export type StudioSliceCreator<TSlice> = StateCreator<StudioState, [], [], TSlice>;

export interface StudioInitialContext {
  initialSettings: StudioSettings;
  initialClusters: DemandCluster[];
  initialSelectionMap: Record<string, Record<string, number>>;
  defaultCluster2D: DemandCluster;
  defaultDemands2D: DemandItem[];
  defaultSlitCluster: DemandCluster;
}
