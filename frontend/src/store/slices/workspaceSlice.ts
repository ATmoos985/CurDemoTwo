import { persistStudioSettings } from '../studioSettings';
import type { StudioInitialContext, StudioSliceCreator, WorkspaceSlice } from './sliceTypes';
import { buildRestoredWorkbenchState } from './workbench2DHelpers';

export function createWorkspaceSlice(
  ctx: StudioInitialContext
): StudioSliceCreator<WorkspaceSlice> {
  return (set) => ({
    activeDimension: '2D',
    scenario2D: 'SHORTEN_KIT',
    multiWidthsText2D: '1500, 1650, 1800',
    scenario1D: 'MIN_CARS',
    settings: ctx.initialSettings,

    setActiveDimension: (dim) => set({ activeDimension: dim }),
    setScenario2D: (sc) => set({ scenario2D: sc }),
    setMultiWidthsText2D: (txt) => set({ multiWidthsText2D: txt }),
    setScenario1D: (sc) => set({ scenario1D: sc }),

    restoreWorkbenchDraft: (draft) => set((st) => buildRestoredWorkbenchState(st, draft)),

    updateStudioSettings: (next) => {
      const saved = persistStudioSettings(next);
      set((st) => ({
        settings: saved,
        selectedStrategies2D: [...saved.enabledStrategies2D],
        slitProfile: saved.slitProfile,
        ...(st.loadedTaskId
          ? {}
          : {
              pieceGapMm: saved.pieceGapMm,
              trimStartMm: saved.trimStartMm
            })
      }));
      return saved;
    }
  });
}
