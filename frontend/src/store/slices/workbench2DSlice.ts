import { persistStudioSettings } from '../studioSettings';
import type { StudioInitialContext, StudioSliceCreator, Workbench2DSlice } from './sliceTypes';
import { mergeAndSelectBestSchemes2D } from './workbench2DHelpers';

export function createWorkbench2DSlice(
  ctx: StudioInitialContext
): StudioSliceCreator<Workbench2DSlice> {
  return (set) => ({
    canvasMode: 'FREE_CANVAS',
    canvasWidthMm: ctx.defaultCluster2D.defaultWidthMm,
    canvasLengthMm: ctx.defaultCluster2D.defaultLengthMm,
    windowStartY2D: null,
    pieceGapMm: ctx.initialSettings.pieceGapMm,
    trimStartMm: ctx.initialSettings.trimStartMm,
    selectedRollId: 'ROLL-2026-0920',
    selectedRemnantId: '',
    multiPreferRemnants: true,
    multiMaxRemnants: 6,
    multiCandidateRollIds: [],
    multiMaterialSummary: null,
    materialModel2D: ctx.defaultCluster2D.materialModel,
    loadedTaskId: null,
    loadedTaskName: null,
    loadedExternalRef: null,
    mergedSourceTaskIds: [],
    activeDemands2D: ctx.defaultDemands2D,
    selectedStrategies2D: [...ctx.initialSettings.enabledStrategies2D],
    strategyRuns2D: [],
    schemes2D: [],
    activeSchemeId2D: null,

    setCanvasSpec: (spec) => set((st) => ({ ...st, ...spec })),

    setActiveDemands2D: (demands) => set({ activeDemands2D: demands }),

    updateDemand2D: (id, patch) =>
      set((st) => ({
        activeDemands2D: st.activeDemands2D.map((d) => (d.id === id ? { ...d, ...patch } : d))
      })),

    removeDemand2D: (id) =>
      set((st) => ({
        activeDemands2D: st.activeDemands2D.filter((d) => d.id !== id)
      })),

    addBlankDemand2D: () =>
      set((st) => {
        const nextId = st.activeDemands2D.reduce((m, d) => Math.max(m, d.id), 0) + 1;
        return {
          activeDemands2D: [
            ...st.activeDemands2D,
            {
              id: nextId,
              name: `自定义规格件 #${nextId}`,
              width: 500,
              length: 800,
              quantity: 2,
              allowRotation: Boolean(st.settings.defaultAllowRotation),
              clusterName: '手动录入'
            }
          ]
        };
      }),

    toggleStrategy2D: (strategyId) =>
      set((st) => {
        const exists = st.selectedStrategies2D.includes(strategyId);
        if (exists && st.selectedStrategies2D.length <= 1) return st;
        const nextStrategies = exists
          ? st.selectedStrategies2D.filter((id) => id !== strategyId)
          : [...st.selectedStrategies2D, strategyId];
        const saved = persistStudioSettings({
          ...st.settings,
          enabledStrategies2D: nextStrategies
        });
        return {
          settings: saved,
          selectedStrategies2D: [...saved.enabledStrategies2D]
        };
      }),

    setStrategyRuns2D: (runs) =>
      set((st) => ({
        strategyRuns2D: typeof runs === 'function' ? runs(st.strategyRuns2D) : runs
      })),

    addSchemes2D: (newSchemes, options) =>
      set((st) => {
        const merged = mergeAndSelectBestSchemes2D(
          st.schemes2D,
          st.activeSchemeId2D,
          newSchemes,
          options
        );
        return merged ?? st;
      }),

    setSchemes2D: (schemes, activeId) =>
      set({
        schemes2D: schemes,
        activeSchemeId2D: activeId !== undefined ? activeId : schemes[0]?.id || null
      }),

    setMultiMaterialSummary: (summary) => set({ multiMaterialSummary: summary }),

    removeScheme2D: (id) =>
      set((st) => {
        const next = st.schemes2D.filter((s) => s.id !== id);
        const hasMulti = next.some((s) => Boolean(s.multiMaterialRole));
        return {
          schemes2D: next,
          activeSchemeId2D: st.activeSchemeId2D === id ? next[0]?.id || null : st.activeSchemeId2D,
          multiMaterialSummary: hasMulti ? st.multiMaterialSummary : null
        };
      }),

    clearSchemes2D: () =>
      set({ schemes2D: [], activeSchemeId2D: null, multiMaterialSummary: null }),

    setActiveScheme2D: (id) => set({ activeSchemeId2D: id }),

    markSchemeDispatched: (schemeId, taskId, confirmedSchemeId) =>
      set((st) => ({
        schemes2D: st.schemes2D.map((s) =>
          s.id === schemeId ? { ...s, dispatchedTaskId: taskId, confirmedSchemeId } : s
        )
      }))
  });
}
