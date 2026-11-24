import {
  DemandItem,
  SavedScheme2D,
  ShapeGeometry,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/useStudioStore';
import { StudioSettings } from '../../store/studioSettings';
import { quantize01 } from '@static/js/business/optimization/nesting-request-adapter.js';
import { shapeArea } from '@static/js/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '@static/js/plugins/export/cam-format.js';
import { carStart, assignCar } from '@static/app/js/model/slitting.js';
import { toast, fmtN, loadSheetLib } from '@static/app/js/util.js';
import { DefectScheduleRow, DemandRowView, OverviewStats } from './workbenchTypes';

export function rotateShapeGeometry(
  shape: ShapeGeometry | undefined,
  w: number,
  h: number,
  stepDeg: 90 | 180
): ShapeGeometry {
  if (shape?.type === 'POLYGON' && shape.vertices && shape.vertices.length >= 3) {
    const sw = shape.width || w;
    const sh = shape.height || h;
    const raw = shape.vertices.map((pt) =>
      stepDeg === 90 ? { x: sh - pt.y, y: pt.x } : { x: sw - pt.x, y: sh - pt.y }
    );
    const minX = Math.min(...raw.map((p) => p.x));
    const minY = Math.min(...raw.map((p) => p.y));
    const normalized = raw.map((p) => ({
      x: Math.max(0, quantize01(p.x - minX)),
      y: Math.max(0, quantize01(p.y - minY))
    }));
    const newW = quantize01(Math.max(...normalized.map((p) => p.x)));
    const newH = quantize01(Math.max(...normalized.map((p) => p.y)));
    return {
      type: 'POLYGON',
      width: newW,
      height: newH,
      vertices: normalized
    };
  }
  return stepDeg === 90
    ? { type: 'RECTANGLE', width: quantize01(h), height: quantize01(w) }
    : { type: 'RECTANGLE', width: quantize01(w), height: quantize01(h) };
}

export function computeDemandRowsView(params: {
  is2D: boolean;
  activeDemands2D: DemandItem[];
  activeScheme2D: SavedScheme2D | null;
  slitOrders: SlittingOrderLine[];
  activeScheme1D: SlittingSchemeRun | null;
  slitFixedLengthMm: number;
}): DemandRowView[] {
  const { is2D, activeDemands2D, activeScheme2D, slitOrders, activeScheme1D, slitFixedLengthMm } =
    params;

  if (is2D) {
    const candCounts = new Map<number, number>();
    if (activeScheme2D && !activeScheme2D.confirmedSchemeId) {
      for (const p of activeScheme2D.result?.layout?.placements || []) {
        if (p.demandId != null) {
          candCounts.set(Number(p.demandId), (candCounts.get(Number(p.demandId)) || 0) + 1);
        }
      }
    }
    return activeDemands2D.map((d, idx) => {
      const done = Math.max(0, Number(d.completedQty) || 0);
      const planned = Math.max(0, Number(d.plannedQty) || 0);
      const uncut = Math.max(0, Number(d.quantity) || 0);
      const ordered = Math.max(Number(d.orderedQty) || 0, done + planned + uncut, 1);
      const cand = Math.min(uncut, candCounts.get(d.id) || 0);
      const afterCandUncut = Math.max(0, uncut - cand);
      const isPoly = d.shape?.type === 'POLYGON';
      const areaM2 = ((isPoly ? shapeArea(d.shape) : d.width * d.length) * ordered) / 1_000_000;
      return {
        key: String(d.id),
        rawId: d.id,
        index: idx + 1,
        name: d.name,
        sourceTaskId: d.sourceTaskId,
        sourceTaskName: d.sourceTaskName,
        sourceLineId: d.sourceLineId,
        width: d.width,
        length: d.length,
        shape: d.shape,
        compactDim: `${fmtN(d.width, 0)}×${fmtN(d.length, 0)}`,
        specText: `${fmtN(d.width, 0)} × ${fmtN(d.length, 0)} mm`,
        kindText: isPoly
          ? `异形轮廓${d.allowHalfTurn ? ' · 180°' : ' · 0°'}`
          : `矩形件${d.allowRotation ? ' · 可90°旋' : ' · 固定向'}`,
        ordered,
        done,
        planned,
        uncut,
        cand,
        afterCandUncut,
        areaM2
      };
    });
  }

  const cand1D = new Map<string, number>();
  if (
    activeScheme1D &&
    activeScheme1D.state === 'SUCCEEDED' &&
    !activeScheme1D.confirmedSchemeId
  ) {
    for (const f of activeScheme1D.fulfillment || []) {
      cand1D.set(String(f.orderId), Math.max(0, Number(f.produced) || 0));
    }
  }
  return slitOrders.map((o, idx) => {
    const done = Math.max(0, Number(o.completedQty) || 0);
    const planned = Math.max(0, Number(o.plannedQty) || 0);
    const uncut = Math.max(0, Number(o.quantity) || 0);
    const ordered = Math.max(Number(o.orderedQty) || 0, done + planned + uncut, 1);
    const cand = Math.min(uncut, cand1D.get(String(o.id)) || 0);
    const afterCandUncut = Math.max(0, uncut - cand);
    const areaM2 = (o.widthMm * slitFixedLengthMm * ordered) / 1_000_000;
    return {
      key: String(o.id),
      rawId: o.id,
      index: idx + 1,
      name: o.name,
      sourceTaskId: o.sourceTaskId,
      sourceTaskName: o.sourceTaskName,
      sourceLineId: o.sourceLineId,
      width: o.widthMm,
      length: slitFixedLengthMm,
      shape: undefined as ShapeGeometry | undefined,
      compactDim: `${fmtN(o.widthMm, 0)}×${fmtN(slitFixedLengthMm, 0)}`,
      specText: `宽 ${fmtN(o.widthMm, 0)} × 长 ${fmtN(slitFixedLengthMm, 0)} mm`,
      kindText: '一维定长分条',
      ordered,
      done,
      planned,
      uncut,
      cand,
      afterCandUncut,
      areaM2
    };
  });
}

export function computeOverviewStats(demandRowsView: DemandRowView[], is2D: boolean): OverviewStats {
  const ordered = demandRowsView.reduce((s, r) => s + r.ordered, 0);
  const done = demandRowsView.reduce((s, r) => s + r.done, 0);
  const planned = demandRowsView.reduce((s, r) => s + r.planned, 0);
  const uncut = demandRowsView.reduce((s, r) => s + r.uncut, 0);
  const cand = demandRowsView.reduce((s, r) => s + r.cand, 0);
  const afterCandUncut = demandRowsView.reduce((s, r) => s + r.afterCandUncut, 0);
  const totalAreaM2 = demandRowsView.reduce((s, r) => s + r.areaM2, 0);
  const settled = done + planned;
  const pct = ordered > 0 ? Math.min(100, Math.round((settled / ordered) * 100)) : 0;
  return {
    itemCount: demandRowsView.length,
    ordered,
    done,
    planned,
    settled,
    uncut,
    cand,
    afterCandUncut,
    totalAreaM2,
    pct,
    unit: is2D ? '片' : '卷'
  };
}

export function computeDefectSchedules1D(params: {
  slitAvoidDefects: boolean;
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  currentRoll1D: any;
  activeScheme1D: SlittingSchemeRun | null;
  slitOrders: SlittingOrderLine[];
  slitFixedLengthMm: number;
  slitLeftTrimMm: number;
}): DefectScheduleRow[] {
  const {
    slitAvoidDefects,
    slitMaterialMode,
    currentRoll1D,
    activeScheme1D,
    slitOrders,
    slitFixedLengthMm,
    slitLeftTrimMm
  } = params;

  if (
    !slitAvoidDefects ||
    slitMaterialMode !== 'STOCK_ROLL' ||
    !currentRoll1D ||
    !activeScheme1D?.patterns?.length
  ) {
    return [];
  }
  const open = slitOrders.map((o) => ({
    id: o.id,
    name: o.name,
    width: o.widthMm,
    length: slitFixedLengthMm,
    demand: o.quantity
  }));
  const list: DefectScheduleRow[] = [];
  let curY = currentRoll1D.usedLength || 0;
  let carNo = 1;
  for (const pat of activeScheme1D.patterns) {
    for (let r = 0; r < pat.repetitions && carNo <= 24; r++) {
      const assigned = assignCar({ ...pat, lengthMm: slitFixedLengthMm }, open, slitLeftTrimMm);
      const y0 = carStart(currentRoll1D, curY, slitFixedLengthMm, assigned.strips, []);
      if (y0 == null) break;
      list.push({
        carNo: carNo++,
        startY: y0,
        endY: y0 + slitFixedLengthMm,
        comp: pat.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
        avoided: y0 > curY + 1
      });
      curY = y0 + slitFixedLengthMm;
    }
  }
  return list;
}

export function exportCam2D(
  activeScheme2D: SavedScheme2D | null,
  settings: StudioSettings,
  kind: 'dxf' | 'nc'
) {
  if (!activeScheme2D?.result?.layout) return;
  if (kind === 'nc' && activeScheme2D.layoutDirty) {
    toast('已手调，请先校验并重建刀路后再导出 G-Code', true);
    return;
  }
  const layout = activeScheme2D.result.layout;
  const placements = [
    ...(layout.placements || []),
    ...(activeScheme2D.result?.marker?.gapFillPlacements || [])
  ];
  const mappedPieces = placements.map((p: any) => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    w: p.shape?.width ?? p.w ?? 0,
    l: p.shape?.height ?? p.l ?? 0,
    shape: p.shape
  }));
  const data = {
    rollId: activeScheme2D.rollId || 'VIRTUAL-NEW-ROLL',
    rollW: activeScheme2D.widthMm,
    bedL: activeScheme2D.occupiedLengthMm,
    windowStartY: activeScheme2D.windowStartY || 0,
    cutOrigin: settings.startCorner,
    pieces: mappedPieces,
    placements: mappedPieces,
    remnants: layout.leftovers || [],
    defects: [],
    cuts: (layout.cuts || []).map((c: any) => ({
      step: c.sequence,
      type: c.kind === 'HORIZONTAL' ? '横切' : '纵切',
      startX: c.startX,
      startY: c.startY,
      endX: c.endX,
      endY: c.endY
    }))
  };
  const content = kind === 'nc' ? gcodeText(data) : dxfText(data);
  const blob = new Blob([content], {
    type: kind === 'nc' ? 'text/plain;charset=utf-8' : 'application/dxf'
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${settings.exportPrefix || 'CutPlan'}-${activeScheme2D.widthMm}x${Math.round(
    activeScheme2D.occupiedLengthMm
  )}.${kind}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function exportExcel1D(activeScheme1D: SlittingSchemeRun | null) {
  if (!activeScheme1D?.patterns.length) return;
  try {
    const XLSX = await loadSheetLib();
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['组合编号', '卷长 mm', '分切组合', '已用宽 mm', '余宽 mm', '计划车数'],
        ...activeScheme1D.patterns.map((p, i) => [
          i + 1,
          p.lengthMm,
          p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
          p.usedWidthMm,
          p.spareWidthMm,
          p.repetitions
        ])
      ]),
      '分切组合方案'
    );
    XLSX.writeFile(
      book,
      `一维分切方案-${activeScheme1D.strategyId}-${activeScheme1D.motherWidthMm}mm.xlsx`
    );
  } catch (e: any) {
    toast('导出 Excel 失败：' + e.message, true);
  }
}

export function openEngineSettings() {
  window.dispatchEvent(new CustomEvent('cutplan:open-settings', { detail: { tab: 'engines' } }));
}

export function openCraftSettings() {
  window.dispatchEvent(new CustomEvent('cutplan:open-settings', { detail: { tab: 'craft' } }));
}
