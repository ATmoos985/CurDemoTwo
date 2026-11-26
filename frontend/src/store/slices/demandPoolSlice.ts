import type { SlittingWidthMode } from '../studioSettings';
import type { DemandFamilySummary, DemandItem, SlittingOrderLine } from '../studioTypes';
import type { DemandPoolSlice, StudioSliceCreator } from './sliceTypes';
import { finiteOr } from './templateHelpers';

function mapFamilyLineToSlitOrder(
  family: DemandFamilySummary,
  l: DemandFamilySummary['lines'][number],
  overrideId?: string,
  prefixName = false
): SlittingOrderLine {
  return {
    id: overrideId ?? String(l.id),
    name: prefixName ? `${family.name} · ${l.name}` : l.name,
    widthMm: l.width,
    lengthMm: l.length,
    quantity: l.openQty,
    orderedQty: l.orderedQty,
    plannedQty: l.plannedQty,
    completedQty: l.completedQty,
    sourceTaskId: family.id,
    sourceTaskName: family.name,
    sourceLineId: l.id,
    surfaceTreatment: l.surfaceTreatment
  };
}

function mapFamilyLineToDemand2D(
  family: DemandFamilySummary,
  l: DemandFamilySummary['lines'][number],
  overrideId?: number,
  prefixName = false
): DemandItem {
  return {
    id: overrideId ?? l.id,
    name: prefixName ? `${family.name} · ${l.name}` : l.name,
    width: l.width,
    length: l.length,
    quantity: l.openQty,
    orderedQty: l.orderedQty,
    plannedQty: l.plannedQty,
    completedQty: l.completedQty,
    allowRotation: Boolean(l.allowRotation),
    allowHalfTurn: Boolean(l.allowHalfTurn),
    shape: l.shape,
    clusterName: family.name,
    sourceTaskId: family.id,
    sourceTaskName: family.name,
    sourceLineId: l.id,
    sizeLabel: l.sizeLabel
  };
}

export function createDemandPoolSlice(): StudioSliceCreator<DemandPoolSlice> {
  return (set, get) => ({
    loadDemandFamilyIntoWorkbench: (family, preset) => {
      const allLines = family.lines;
      if (family.dimension === 'SLITTING_1D') {
        const sp = family.slitting || {};
        const lt = preset?.slitLeftTrimMm ?? finiteOr(sp.leftTrim, 100);
        const rt = preset?.slitRightTrimMm ?? finiteOr(sp.rightTrim, 100);
        const rawMaxW = preset?.slitMaxWidthMm ?? finiteOr(sp.maxWidth, 4400);
        const motherW = preset?.slitMotherWidthMm ?? Math.max(rawMaxW + lt + rt, 500);
        const usableW = Math.max(200, motherW - lt - rt);
        const maxW = Math.min(usableW, Math.max(200, rawMaxW));
        const defaultMinW = Math.min(maxW, Math.max(100, Math.floor((maxW * 0.95) / 10) * 10));
        const minW = Math.min(
          maxW,
          Math.max(100, preset?.slitMinWidthMm ?? finiteOr(sp.minWidth, defaultMinW))
        );
        const stepW = Math.max(1, preset?.slitWidthStepMm ?? finiteOr(sp.widthStep, 10));
        const overCap = Math.max(0, preset?.slitOverCap ?? finiteOr(sp.totalOverCap, 30));
        const fixedLen =
          preset?.slitFixedLengthMm ??
          (allLines[0]?.length || finiteOr(family.process?.bedLength, 2000));
        const widthMode: SlittingWidthMode =
          preset?.slitWidthMode ?? (minW === maxW ? 'FIXED' : 'FLEXIBLE');
        set({
          activeDimension: '1D',
          slitLoadedTaskId: family.id,
          slitLoadedTaskName: family.name,
          slitMergedSourceTaskIds: [],
          slitMaterialModel: family.materialModel,
          slitMaterialMode: preset?.slitMaterialMode ?? 'VIRTUAL_ROLL',
          slitWidthMode: widthMode,
          ...(preset?.slitProfile ? { slitProfile: preset.slitProfile } : {}),
          slitRollId: preset?.slitRollId ?? get().slitRollId,
          slitAvoidDefects: preset?.slitMaterialMode === 'STOCK_ROLL',
          slitMotherWidthMm: motherW,
          slitLeftTrimMm: lt,
          slitRightTrimMm: rt,
          slitMinWidthMm: widthMode === 'FIXED' ? maxW : minW,
          slitMaxWidthMm: maxW,
          slitWidthStepMm: stepW,
          slitOverCap: overCap,
          slitMaxKnives: Math.max(0, preset?.slitMaxKnives ?? finiteOr(sp.maxKnives, 0)),
          slitMinBladeSpacingMm: Math.max(
            0,
            preset?.slitMinBladeSpacingMm ?? finiteOr(sp.minBladeSpacingMm, 0)
          ),
          slitKerfMm: Math.max(0, preset?.slitKerfMm ?? finiteOr(sp.kerfMm, 0)),
          slitForbiddenNarrowEdgeMinMm: Math.max(
            0,
            preset?.slitForbiddenNarrowEdgeMinMm ?? finiteOr(sp.forbiddenNarrowEdgeMinMm, 0)
          ),
          slitForbiddenNarrowEdgeMaxMm: Math.max(
            0,
            preset?.slitForbiddenNarrowEdgeMaxMm ?? finiteOr(sp.forbiddenNarrowEdgeMaxMm, 0)
          ),
          slitFixedLengthMm: fixedLen,
          ...(preset?.scenario1D ? { scenario1D: preset.scenario1D } : {}),
          slitOrders: allLines.map((l) => mapFamilyLineToSlitOrder(family, l)),
          slitSchemes: [],
          activeSlitSchemeId: null
        });
      } else {
        const mappedDemands = allLines.map((l) => mapFamilyLineToDemand2D(family, l));
        const targetW = preset?.canvasWidthMm || get().canvasWidthMm || 1650;
        const openOrFullArea = mappedDemands.reduce(
          (s, d) => s + d.width * d.length * (d.quantity > 0 ? d.quantity : d.orderedQty || 1),
          0
        );
        const estLen = Math.ceil(openOrFullArea / Math.max(400, targetW * 0.65) / 500) * 500;
        set({
          activeDimension: '2D',
          loadedTaskId: family.id,
          loadedTaskName: family.name,
          loadedExternalRef: family.externalRef || null,
          mergedSourceTaskIds: [],
          materialModel2D: family.materialModel,
          canvasMode: preset?.canvasMode ?? 'FREE_CANVAS',
          canvasWidthMm: targetW,
          canvasLengthMm:
            preset?.canvasLengthMm ??
            Math.max(Number(family.process?.bedLength) || 2400, estLen, 1500),
          ...(preset?.selectedRollId !== undefined
            ? { selectedRollId: preset.selectedRollId }
            : {}),
          ...(preset?.selectedRemnantId !== undefined
            ? { selectedRemnantId: preset.selectedRemnantId }
            : {}),
          ...(preset?.multiPreferRemnants !== undefined
            ? { multiPreferRemnants: preset.multiPreferRemnants }
            : {}),
          ...(preset?.multiMaxRemnants !== undefined
            ? { multiMaxRemnants: preset.multiMaxRemnants }
            : {}),
          multiCandidateRollIds: preset?.multiCandidateRollIds ?? [],
          multiMaterialSummary: null,
          pieceGapMm: preset?.pieceGapMm ?? (Number(family.process?.pieceGap) || 0),
          trimStartMm: preset?.trimStartMm ?? (Number(family.process?.trimStart) || 0),
          ...(preset?.scenario2D ? { scenario2D: preset.scenario2D } : {}),
          ...(preset?.multiWidthsText2D !== undefined
            ? { multiWidthsText2D: preset.multiWidthsText2D }
            : {}),
          activeDemands2D: mappedDemands,
          schemes2D: [],
          activeSchemeId2D: null
        });
      }
    },

    syncDemandFamilyProgress: (family) => {
      if (family.dimension === 'SLITTING_1D') {
        set({
          slitLoadedTaskId: family.id,
          slitLoadedTaskName: family.name,
          slitMergedSourceTaskIds: [],
          slitOrders: family.lines.map((l) => mapFamilyLineToSlitOrder(family, l))
        });
      } else {
        set({
          loadedTaskId: family.id,
          loadedTaskName: family.name,
          loadedExternalRef: family.externalRef || null,
          mergedSourceTaskIds: [],
          activeDemands2D: family.lines.map((l) => mapFamilyLineToDemand2D(family, l))
        });
      }
    },

    syncMergedDemandFamiliesProgress: (families) => {
      const familyById = new Map<string, DemandFamilySummary>();
      for (const f of families) {
        familyById.set(f.id, f);
      }
      set((st) => {
        const nextDemands2D = st.activeDemands2D.map((d) => {
          if (!d.sourceTaskId || d.sourceLineId == null) return d;
          const fam = familyById.get(d.sourceTaskId);
          const ln = fam?.lines.find((l) => l.id === d.sourceLineId);
          if (!ln) return d;
          return {
            ...d,
            quantity: ln.openQty,
            orderedQty: ln.orderedQty,
            plannedQty: ln.plannedQty,
            completedQty: ln.completedQty
          };
        });
        const nextSlitOrders = st.slitOrders.map((o) => {
          if (!o.sourceTaskId || o.sourceLineId == null) return o;
          const fam = familyById.get(o.sourceTaskId);
          const ln = fam?.lines.find((l) => l.id === o.sourceLineId);
          if (!ln) return o;
          return {
            ...o,
            quantity: ln.openQty,
            orderedQty: ln.orderedQty,
            plannedQty: ln.plannedQty,
            completedQty: ln.completedQty
          };
        });
        return {
          activeDemands2D: nextDemands2D,
          slitOrders: nextSlitOrders
        };
      });
    },

    loadDemandFamiliesMergedIntoWorkbench: (families) => {
      if (!families.length) return;
      if (families.length === 1) {
        get().loadDemandFamilyIntoWorkbench(families[0]);
        return;
      }
      const first = families[0];
      if (first.dimension === 'SLITTING_1D') {
        let nextId = 1;
        const orders: SlittingOrderLine[] = [];
        const includedIds: string[] = [];
        for (const fam of families) {
          if (fam.dimension !== 'SLITTING_1D') continue;
          let hasOpen = false;
          for (const l of fam.lines) {
            if (l.openQty <= 0) continue;
            hasOpen = true;
            orders.push(mapFamilyLineToSlitOrder(fam, l, String(nextId++), true));
          }
          if (hasOpen) includedIds.push(fam.id);
        }
        const sp = first.slitting || {};
        const maxW = finiteOr(sp.maxWidth, 4400);
        const lt = finiteOr(sp.leftTrim, 100);
        const rt = finiteOr(sp.rightTrim, 100);
        const minW = Math.min(maxW, finiteOr(sp.minWidth, Math.floor((maxW * 0.95) / 10) * 10));
        set({
          activeDimension: '1D',
          slitLoadedTaskId: null,
          slitLoadedTaskName: `多族合排 (${families.length} 族 · ${first.materialModel})`,
          slitMergedSourceTaskIds: includedIds,
          slitMaterialModel: first.materialModel,
          slitWidthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
          slitMotherWidthMm: maxW + lt + rt,
          slitLeftTrimMm: lt,
          slitRightTrimMm: rt,
          slitMaxWidthMm: maxW,
          slitMinWidthMm: minW,
          slitWidthStepMm: Math.max(1, finiteOr(sp.widthStep, 10)),
          slitOverCap: Math.max(0, finiteOr(sp.totalOverCap, 30)),
          slitFixedLengthMm: orders[0]?.lengthMm || 2000,
          slitOrders: orders,
          slitSchemes: [],
          activeSlitSchemeId: null
        });
      } else {
        let nextId = 1;
        const demands: DemandItem[] = [];
        const includedIds: string[] = [];
        for (const fam of families) {
          if (fam.dimension === 'SLITTING_1D') continue;
          let hasOpen = false;
          for (const l of fam.lines) {
            if (l.openQty <= 0) continue;
            hasOpen = true;
            demands.push(mapFamilyLineToDemand2D(fam, l, nextId++, true));
          }
          if (hasOpen) includedIds.push(fam.id);
        }
        set({
          activeDimension: '2D',
          loadedTaskId: null,
          loadedTaskName: `多族合排 (${families.length} 族 · ${first.materialModel})`,
          loadedExternalRef: families.map((f) => f.externalRef || f.name).join(' + '),
          mergedSourceTaskIds: includedIds,
          materialModel2D: first.materialModel,
          activeDemands2D: demands,
          schemes2D: [],
          activeSchemeId2D: null,
          multiMaterialSummary: null,
          multiCandidateRollIds: []
        });
      }
    }
  });
}
