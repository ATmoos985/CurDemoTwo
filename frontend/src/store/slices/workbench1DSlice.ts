import type { StudioInitialContext, StudioSliceCreator, Workbench1DSlice } from './sliceTypes';

export function createWorkbench1DSlice(
  ctx: StudioInitialContext
): StudioSliceCreator<Workbench1DSlice> {
  return (set) => ({
    slitMaterialMode: 'VIRTUAL_ROLL',
    slitWidthMode: 'FLEXIBLE',
    slitProfile: ctx.initialSettings.slitProfile,
    slitMotherWidthMm: 4600,
    slitLeftTrimMm: 100,
    slitRightTrimMm: 100,
    slitMinWidthMm: 4300,
    slitMaxWidthMm: 4400,
    slitWidthStepMm: 10,
    slitOverCap: 30,
    slitMaxKnives: 0,
    slitMinBladeSpacingMm: 0,
    slitKerfMm: 0,
    slitForbiddenNarrowEdgeMinMm: 0,
    slitForbiddenNarrowEdgeMaxMm: 0,
    slitFixedLengthMm: 2000,
    slitAvoidDefects: false,
    slitRollId: '',
    slitMaterialModel: ctx.defaultSlitCluster.materialModel,
    slitLoadedTaskId: null,
    slitLoadedTaskName: null,
    slitMergedSourceTaskIds: [],
    slitOrders: ctx.defaultSlitCluster.pieces.map((p, idx) => ({
      id: String(idx + 1),
      name: p.name,
      widthMm: Object.values(p.sizes)[0].w,
      lengthMm: Object.values(p.sizes)[0].h,
      quantity: p.quantityPerUnit
    })),
    slitSchemes: [],
    activeSlitSchemeId: null,

    setSlitSpec: (spec) => set((st) => ({ ...st, ...spec })),

    updateSlitOrder: (id, patch) =>
      set((st) => ({
        slitOrders: st.slitOrders.map((o) => (o.id === id ? { ...o, ...patch } : o))
      })),

    addSlitOrder: () =>
      set((st) => {
        const nextId = String(
          st.slitOrders.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1
        );
        return {
          slitOrders: [
            ...st.slitOrders,
            {
              id: nextId,
              name: `分条规格 #${nextId}`,
              widthMm: 500,
              lengthMm: st.slitFixedLengthMm,
              quantity: 6
            }
          ]
        };
      }),

    removeSlitOrder: (id) =>
      set((st) => ({
        slitOrders: st.slitOrders.filter((o) => o.id !== id)
      })),

    setSlitSchemes: (schemes) =>
      set((st) => {
        const keepActive =
          st.activeSlitSchemeId != null &&
          schemes.some(
            (s) =>
              s.id === st.activeSlitSchemeId &&
              s.state === 'SUCCEEDED' &&
              s.strategyId !== 'BASELINE'
          );
        return {
          slitSchemes: schemes,
          activeSlitSchemeId: keepActive
            ? st.activeSlitSchemeId
            : schemes.find((s) => s.state === 'SUCCEEDED' && s.strategyId !== 'BASELINE')?.id ||
              schemes.find((s) => s.state === 'SUCCEEDED')?.id ||
              schemes[0]?.id ||
              null
        };
      }),

    setActiveSlitScheme: (id) => set({ activeSlitSchemeId: id }),

    markSlitSchemeDispatched: (schemeId, taskId, confirmedSchemeId) =>
      set((st) => ({
        slitSchemes: st.slitSchemes.map((s) =>
          s.id === schemeId ? { ...s, dispatchedTaskId: taskId, confirmedSchemeId } : s
        )
      }))
  });
}
