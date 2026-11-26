import { useShallow } from 'zustand/react/shallow';
import type { StudioSettings } from './studioSettings';
import { expandClusterToDemands } from './slices/templateHelpers';
import { useStudioStore } from './useStudioStore';

export { expandClusterToDemands };

/** 仅订阅全局系统与工艺设置对象（引用稳定，其它域变更不触发重渲染） */
export function useStudioSettings(): StudioSettings {
  return useStudioStore((s) => s.settings);
}

/** 同步读取当前全局设置快照（用于非渲染回调如弹窗取消回滚主题） */
export function getStudioSettingsSnapshot(): StudioSettings {
  return useStudioStore.getState().settings;
}

/** 系统设置域 Hook：仅暴露 settings 与 updateStudioSettings */
export function useStudioSettingsStore() {
  return useStudioStore(
    useShallow((s) => ({
      settings: s.settings,
      updateStudioSettings: s.updateStudioSettings
    }))
  );
}

/** 模板库完整域 Hook（专供纸样模板中心页面使用） */
export function useTemplateLibraryStore() {
  return useStudioStore(
    useShallow((s) => ({
      clusters: s.clusters,
      clusterSelections: s.clusterSelections,
      syncTemplatesFromServer: s.syncTemplatesFromServer,
      setClusterCount: s.setClusterCount,
      addCustomCluster: s.addCustomCluster,
      deleteCustomCluster: s.deleteCustomCluster,
      importDxfAsCluster: s.importDxfAsCluster,
      loadClusterInto2D: s.loadClusterInto2D,
      loadSelectedClustersInto2D: s.loadSelectedClustersInto2D,
      loadClusterInto1D: s.loadClusterInto1D
    }))
  );
}

/** 模板目录轻量 Hook（不订阅 clusterSelections，减少建单页无关重渲染） */
export function useTemplateCatalogStore() {
  return useStudioStore(
    useShallow((s) => ({
      clusters: s.clusters,
      syncTemplatesFromServer: s.syncTemplatesFromServer
    }))
  );
}

/** 需求池载入与进度同步动作 Hook（仅动作引用，零重渲染开销） */
export function useDemandPoolStore() {
  return useStudioStore(
    useShallow((s) => ({
      loadDemandFamilyIntoWorkbench: s.loadDemandFamilyIntoWorkbench,
      loadDemandFamiliesMergedIntoWorkbench: s.loadDemandFamiliesMergedIntoWorkbench,
      syncDemandFamilyProgress: s.syncDemandFamilyProgress,
      syncMergedDemandFamiliesProgress: s.syncMergedDemandFamiliesProgress
    }))
  );
}

/** 二维排料工作台域 Hook */
export function useWorkbench2DStore() {
  return useStudioStore(
    useShallow((s) => ({
      canvasMode: s.canvasMode,
      canvasWidthMm: s.canvasWidthMm,
      canvasLengthMm: s.canvasLengthMm,
      windowStartY2D: s.windowStartY2D,
      pieceGapMm: s.pieceGapMm,
      trimStartMm: s.trimStartMm,
      selectedRollId: s.selectedRollId,
      selectedRemnantId: s.selectedRemnantId,
      multiPreferRemnants: s.multiPreferRemnants,
      multiMaxRemnants: s.multiMaxRemnants,
      multiCandidateRollIds: s.multiCandidateRollIds,
      multiMaterialSummary: s.multiMaterialSummary,
      materialModel2D: s.materialModel2D,
      loadedTaskId: s.loadedTaskId,
      loadedTaskName: s.loadedTaskName,
      loadedExternalRef: s.loadedExternalRef,
      mergedSourceTaskIds: s.mergedSourceTaskIds,
      activeDemands2D: s.activeDemands2D,
      selectedStrategies2D: s.selectedStrategies2D,
      strategyRuns2D: s.strategyRuns2D,
      schemes2D: s.schemes2D,
      activeSchemeId2D: s.activeSchemeId2D,
      setCanvasSpec: s.setCanvasSpec,
      setActiveDemands2D: s.setActiveDemands2D,
      updateDemand2D: s.updateDemand2D,
      removeDemand2D: s.removeDemand2D,
      addBlankDemand2D: s.addBlankDemand2D,
      toggleStrategy2D: s.toggleStrategy2D,
      setStrategyRuns2D: s.setStrategyRuns2D,
      addSchemes2D: s.addSchemes2D,
      setSchemes2D: s.setSchemes2D,
      setMultiMaterialSummary: s.setMultiMaterialSummary,
      removeScheme2D: s.removeScheme2D,
      clearSchemes2D: s.clearSchemes2D,
      setActiveScheme2D: s.setActiveScheme2D,
      markSchemeDispatched: s.markSchemeDispatched
    }))
  );
}

/** 二维工作台写入动作 Hook（仅订阅稳定动作引用，绝不因 2D 状态变更重渲染） */
export function useWorkbench2DActions() {
  return useStudioStore(
    useShallow((s) => ({
      setCanvasSpec: s.setCanvasSpec,
      setActiveDemands2D: s.setActiveDemands2D
    }))
  );
}

/** 一维分切排程域 Hook */
export function useWorkbench1DStore() {
  return useStudioStore(
    useShallow((s) => ({
      slitMaterialMode: s.slitMaterialMode,
      slitWidthMode: s.slitWidthMode,
      slitProfile: s.slitProfile,
      slitMotherWidthMm: s.slitMotherWidthMm,
      slitLeftTrimMm: s.slitLeftTrimMm,
      slitRightTrimMm: s.slitRightTrimMm,
      slitMinWidthMm: s.slitMinWidthMm,
      slitMaxWidthMm: s.slitMaxWidthMm,
      slitWidthStepMm: s.slitWidthStepMm,
      slitOverCap: s.slitOverCap,
      slitMaxKnives: s.slitMaxKnives,
      slitMinBladeSpacingMm: s.slitMinBladeSpacingMm,
      slitKerfMm: s.slitKerfMm,
      slitForbiddenNarrowEdgeMinMm: s.slitForbiddenNarrowEdgeMinMm,
      slitForbiddenNarrowEdgeMaxMm: s.slitForbiddenNarrowEdgeMaxMm,
      slitFixedLengthMm: s.slitFixedLengthMm,
      slitAvoidDefects: s.slitAvoidDefects,
      slitRollId: s.slitRollId,
      slitMaterialModel: s.slitMaterialModel,
      slitLoadedTaskId: s.slitLoadedTaskId,
      slitLoadedTaskName: s.slitLoadedTaskName,
      slitMergedSourceTaskIds: s.slitMergedSourceTaskIds,
      slitOrders: s.slitOrders,
      slitSchemes: s.slitSchemes,
      activeSlitSchemeId: s.activeSlitSchemeId,
      setSlitSpec: s.setSlitSpec,
      updateSlitOrder: s.updateSlitOrder,
      addSlitOrder: s.addSlitOrder,
      removeSlitOrder: s.removeSlitOrder,
      setSlitSchemes: s.setSlitSchemes,
      setActiveSlitScheme: s.setActiveSlitScheme,
      markSlitSchemeDispatched: s.markSlitSchemeDispatched
    }))
  );
}

/** 工作台维度导航与状态栏统计 Hook */
export function useWorkspaceNavStore() {
  return useStudioStore(
    useShallow((s) => ({
      activeDimension: s.activeDimension,
      scenario2D: s.scenario2D,
      multiWidthsText2D: s.multiWidthsText2D,
      scenario1D: s.scenario1D,
      candidateCount: s.schemes2D.length + s.slitSchemes.length,
      clusterCount: s.clusters.length,
      enabledAlgoCount: s.settings.enabledStrategies2D.length,
      setActiveDimension: s.setActiveDimension,
      setScenario2D: s.setScenario2D,
      setMultiWidthsText2D: s.setMultiWidthsText2D,
      setScenario1D: s.setScenario1D
    }))
  );
}

/** 仅订阅侧栏徽标与引擎算法计数标量（专供 App 导航壳层，避免列表内部变更触发整页重渲染） */
export function useWorkspaceNavBadges() {
  return useStudioStore(
    useShallow((s) => ({
      candidateCount: s.schemes2D.length + s.slitSchemes.length,
      clusterCount: s.clusters.length,
      enabledAlgoCount: s.settings.enabledStrategies2D.length
    }))
  );
}
