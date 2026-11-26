import { create } from 'zustand';
import { loadStudioSettings } from './studioSettings';
import { createDemandPoolSlice } from './slices/demandPoolSlice';
import type { StudioInitialContext, StudioState } from './slices/sliceTypes';
import { createInitialClusters, expandClusterToDemands } from './slices/templateHelpers';
import { createTemplateSlice } from './slices/templateSlice';
import { createWorkbench1DSlice } from './slices/workbench1DSlice';
import { createWorkbench2DSlice } from './slices/workbench2DSlice';
import { createWorkspaceSlice } from './slices/workspaceSlice';

export { expandClusterToDemands };

export type {
  CanvasMode2D,
  CanvasSpecPatch,
  ClusterTemplatePiece,
  DemandCluster,
  DemandFamilySummary,
  DemandItem,
  MultiMaterialRunSummary,
  SavedScheme2D,
  SavedSchemeCanvasMode2D,
  Scenario1DType,
  Scenario2DType,
  SchemeDefectSnapshot,
  ShapeGeometry,
  SlittingOrderLine,
  SlittingSchemeRun,
  StrategyJobRun,
  WorkbenchDraftPayload,
  WorkbenchLaunchPreset
} from './studioTypes';

export type {
  DemandPoolSlice,
  StudioState,
  TemplateSlice,
  Workbench1DSlice,
  Workbench2DSlice,
  WorkspaceSlice
} from './slices/sliceTypes';

function buildInitialContext(): StudioInitialContext {
  const initialSettings = loadStudioSettings();
  const initialClusters = createInitialClusters();
  const initialSelectionMap: Record<string, Record<string, number>> = {};
  for (const c of initialClusters) {
    initialSelectionMap[c.id] = { ...c.defaultSizeCounts };
  }

  const defaultCluster2D = initialClusters.find((c) => c.id === 'DXF_1226') || initialClusters[0];
  const defaultDemands2D = expandClusterToDemands(
    defaultCluster2D,
    defaultCluster2D.defaultSizeCounts,
    1
  );
  const defaultSlitCluster = initialClusters.find((c) => c.id === 'CLUSTER_SLIT_FILM')!;

  return {
    initialSettings,
    initialClusters,
    initialSelectionMap,
    defaultCluster2D,
    defaultDemands2D,
    defaultSlitCluster
  };
}

const initialContext = buildInitialContext();

/**
 * 排料工作台根 Store（由 5 个正交业务域切片组装而成）。
 * 100% 兼容原有字段、action 与类型导出；单域页面推荐优先从 `./selectors` 按域订阅以减少耦合与重渲染。
 */
export const useStudioStore = create<StudioState>()((...args) => ({
  ...createWorkspaceSlice(initialContext)(...args),
  ...createTemplateSlice(initialContext)(...args),
  ...createWorkbench2DSlice(initialContext)(...args),
  ...createWorkbench1DSlice(initialContext)(...args),
  ...createDemandPoolSlice()(...args)
}));
