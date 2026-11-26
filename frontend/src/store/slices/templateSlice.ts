import { requestJSON } from '../../lib/core/util.js';
import type { DemandCluster, DemandItem, SlittingOrderLine } from '../studioTypes';
import type { StudioInitialContext, StudioSliceCreator, TemplateSlice } from './sliceTypes';
import {
  expandClusterToDemands,
  mapServerTemplateToCluster,
  parseDxfToDemandCluster,
  saveCustomClusters
} from './templateHelpers';

export function createTemplateSlice(
  ctx: StudioInitialContext
): StudioSliceCreator<TemplateSlice> {
  return (set, get) => ({
    clusters: ctx.initialClusters,
    clusterSelections: ctx.initialSelectionMap,

    syncTemplatesFromServer: async () => {
      try {
        const serverTpls: any[] = await requestJSON('/api/v2/demand-templates');
        if (!Array.isArray(serverTpls) || serverTpls.length === 0) return;
        const mapped: DemandCluster[] = serverTpls.map(mapServerTemplateToCluster);
        set((st) => {
          const serverIds = new Set(mapped.map((m) => m.id));
          const builtinsAndLocal = st.clusters.filter((c) => !serverIds.has(c.id));
          const nextSel = { ...st.clusterSelections };
          for (const m of mapped) {
            if (!nextSel[m.id]) nextSel[m.id] = { ...m.defaultSizeCounts };
          }
          return {
            clusters: [...mapped, ...builtinsAndLocal],
            clusterSelections: nextSel
          };
        });
      } catch {}
    },

    setClusterCount: (clusterId, sizeKey, count) =>
      set((st) => ({
        clusterSelections: {
          ...st.clusterSelections,
          [clusterId]: {
            ...(st.clusterSelections[clusterId] || {}),
            [sizeKey]: Math.max(0, Math.floor(count || 0))
          }
        }
      })),

    addCustomCluster: (cluster) => {
      const withFlag: DemandCluster = { ...cluster, custom: true };
      set((st) => {
        const next = [withFlag, ...st.clusters.filter((c) => c.id !== withFlag.id)];
        saveCustomClusters(next);
        return {
          clusters: next,
          clusterSelections: {
            ...st.clusterSelections,
            [withFlag.id]: { ...withFlag.defaultSizeCounts }
          }
        };
      });
      // 异步将自定义模板持久化到后端模板库
      requestJSON('/api/v2/demand-templates', {
        id: withFlag.id,
        code: withFlag.code,
        name: withFlag.name,
        category: withFlag.category,
        dimension:
          withFlag.subDimension ||
          (withFlag.dimension === '1D'
            ? 'SLITTING_1D'
            : withFlag.category === 'DXF_GARMENT'
            ? 'CONTOUR_2D'
            : 'RECT_2D'),
        description: withFlag.description,
        defaultWidthMm: withFlag.defaultWidthMm,
        defaultLengthMm: withFlag.defaultLengthMm,
        materialModel: withFlag.materialModel,
        availableSizes: withFlag.availableSizes,
        defaultSizeCounts: withFlag.defaultSizeCounts,
        custom: true,
        pieces: withFlag.pieces
      }).catch(() => {});
    },

    deleteCustomCluster: (clusterId) => {
      set((st) => {
        const next = st.clusters.filter((c) => c.id !== clusterId || !c.custom);
        saveCustomClusters(next);
        return { clusters: next };
      });
      fetch('/api/v2/demand-templates/' + encodeURIComponent(clusterId), {
        method: 'DELETE'
      }).catch(() => {});
    },

    importDxfAsCluster: (text, fileName) => {
      const newCluster = parseDxfToDemandCluster(text, fileName);
      get().addCustomCluster(newCluster);
      return newCluster;
    },

    loadClusterInto2D: (clusterId, append = false) => {
      const st = get();
      const cluster = st.clusters.find((c) => c.id === clusterId);
      if (!cluster) return;
      const counts = st.clusterSelections[clusterId] || cluster.defaultSizeCounts;
      const hasPositive = Object.values(counts).some((v) => v > 0);
      const effectiveCounts = hasPositive ? counts : { [cluster.availableSizes[0]]: 1 };
      const startId = append ? st.activeDemands2D.reduce((m, d) => Math.max(m, d.id), 0) + 1 : 1;
      const expanded = expandClusterToDemands(cluster, effectiveCounts, startId);
      set({
        activeDimension: '2D',
        loadedTaskId: append ? st.loadedTaskId : null,
        loadedTaskName: append ? st.loadedTaskName : null,
        loadedExternalRef: append ? st.loadedExternalRef : null,
        mergedSourceTaskIds: append ? st.mergedSourceTaskIds : [],
        activeDemands2D: append ? [...st.activeDemands2D, ...expanded] : expanded,
        canvasWidthMm: append ? st.canvasWidthMm : cluster.defaultWidthMm,
        canvasLengthMm: append ? st.canvasLengthMm : cluster.defaultLengthMm,
        materialModel2D: append ? st.materialModel2D : cluster.materialModel,
        ...(append
          ? {}
          : {
              activeSchemeId2D: null,
              schemes2D: [],
              multiMaterialSummary: null,
              multiCandidateRollIds: []
            })
      });
    },

    loadSelectedClustersInto2D: (clusterIds, append = false) => {
      const st = get();
      const chosen1D = clusterIds
        .map((id) => st.clusters.find((c) => c.id === id))
        .filter((c): c is DemandCluster => Boolean(c && c.dimension === '1D'));
      const chosen2D = clusterIds
        .map((id) => st.clusters.find((c) => c.id === id))
        .filter((c): c is DemandCluster => Boolean(c && c.dimension === '2D'));

      if (chosen2D.length === 0 && chosen1D.length > 0) {
        get().loadClusterInto1D(chosen1D[0].id, false);
        for (let i = 1; i < chosen1D.length; i++) {
          get().loadClusterInto1D(chosen1D[i].id, true);
        }
        return;
      }

      let list: DemandItem[] = append ? [...st.activeDemands2D] : [];
      let nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
      let firstCluster: DemandCluster | null = null;
      for (const cluster of chosen2D) {
        if (!firstCluster) firstCluster = cluster;
        const counts = st.clusterSelections[cluster.id] || cluster.defaultSizeCounts;
        const effectiveCounts = Object.values(counts).some((v) => v > 0)
          ? counts
          : { [cluster.availableSizes[0]]: 1 };
        const items = expandClusterToDemands(cluster, effectiveCounts, nextId);
        list = [...list, ...items];
        nextId = list.reduce((m, d) => Math.max(m, d.id), 0) + 1;
      }
      if (list.length) {
        set({
          activeDimension: '2D',
          loadedTaskId: null,
          loadedTaskName: null,
          loadedExternalRef: null,
          mergedSourceTaskIds: [],
          activeDemands2D: list,
          ...(firstCluster && !append
            ? {
                canvasWidthMm: firstCluster.defaultWidthMm,
                canvasLengthMm: firstCluster.defaultLengthMm,
                materialModel2D: firstCluster.materialModel,
                activeSchemeId2D: null,
                schemes2D: []
              }
            : {})
        });
      }
    },

    loadClusterInto1D: (clusterId, append = false) => {
      const st = get();
      const cluster = st.clusters.find((c) => c.id === clusterId);
      if (!cluster) return;
      const counts = st.clusterSelections[clusterId] || cluster.defaultSizeCounts;
      const mult = Math.max(1, Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0));
      const baseIdx = append
        ? st.slitOrders.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0)
        : 0;
      const orders: SlittingOrderLine[] = cluster.pieces.map((p, idx) => {
        const g = Object.values(p.sizes)[0];
        return {
          id: String(baseIdx + idx + 1),
          name: p.name,
          widthMm: g.w,
          lengthMm: g.h,
          quantity: p.quantityPerUnit * mult,
          surfaceTreatment: p.surfaceTreatment
        };
      });
      const ds = cluster.defaultSlitting;
      const lt = ds ? ds.leftTrimMm : cluster.defaultWidthMm >= 4000 ? 100 : 10;
      const rt = ds ? ds.rightTrimMm : cluster.defaultWidthMm >= 4000 ? 100 : 10;
      const usable = Math.max(200, cluster.defaultWidthMm - lt - rt);
      const maxW = ds ? Math.min(usable, ds.maxWidthMm) : usable;
      const minW = ds ? Math.min(maxW, ds.minWidthMm) : Math.floor((usable * 0.95) / 10) * 10;
      const stepW = ds ? ds.widthStepMm : 10;
      const overCap = ds ? ds.totalOverCap : 30;
      set({
        activeDimension: '1D',
        slitLoadedTaskId: append ? st.slitLoadedTaskId : null,
        slitLoadedTaskName: append ? st.slitLoadedTaskName : null,
        slitMergedSourceTaskIds: append ? st.slitMergedSourceTaskIds : [],
        slitMaterialModel: append ? st.slitMaterialModel : cluster.materialModel,
        ...(append
          ? { slitOrders: [...st.slitOrders, ...orders] }
          : {
              slitWidthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
              slitMotherWidthMm: cluster.defaultWidthMm,
              slitLeftTrimMm: lt,
              slitRightTrimMm: rt,
              slitMaxWidthMm: maxW,
              slitMinWidthMm: minW,
              slitWidthStepMm: stepW,
              slitOverCap: overCap,
              slitFixedLengthMm: cluster.defaultLengthMm,
              slitOrders: orders,
              slitSchemes: [],
              activeSlitSchemeId: null
            })
      });
    }
  });
}
