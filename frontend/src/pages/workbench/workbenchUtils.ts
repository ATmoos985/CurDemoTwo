import type {
  DemandItem,
  SavedScheme2D,
  ShapeGeometry,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/studioTypes';
import { StudioSettings, extractCncPostOptions } from '../../store/studioSettings';
import type { BoardDefect } from '../../components/canvas/canvasTypes';
import { shapeArea } from '../../lib/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '../../lib/domain/cam-format.js';
import { feedLengthLimits, suggestedFeedLength } from '../../lib/domain/feed-length.js';
import { carStart, assignCar } from '../../lib/model/slitting.js';
import { toast, fmtN, loadSheetLib } from '../../lib/core/util.js';
import { DefectScheduleRow, DemandRowView, OverviewStats } from './workbenchTypes';

export { rotateShapeGeometry } from './boardPlacementValidation';

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

export interface SuggestedFeedWindowResult {
  suggestedLengthMm: number;
  suggestedStartY: number;
  minLengthMm: number;
  maxLengthMm: number;
  avoidedDefectsCount: number;
  reason: string;
}

/**
 * 复用 frontend/src/lib/domain/feed-length.js 计算当前需求与母卷下的建议拉布长度及避疵工位窗口。
 * 纯函数：只生成预览建议，绝不写库或修改母卷库存。
 */
export function computeSuggestedFeedWindow(params: {
  roll: {
    width: number;
    totalLength: number;
    usedLength?: number;
    currentRemainingLength?: number;
    defects?: Array<{ id?: string | number; x: number; y: number; w: number; h: number; margin?: number }>;
  };
  demands: DemandItem[];
  windowStartY: number;
  trimStartMm: number;
  defaultDefectMarginMm: number;
}): SuggestedFeedWindowResult {
  const { roll, demands, trimStartMm, defaultDefectMarginMm } = params;
  const rollW = Math.max(100, Number(roll.width) || 1500);
  const totalRollL = Math.max(100, Number(roll.totalLength) || 5000);
  const usedLen = Math.max(0, Number(roll.usedLength) || 0);
  let startY = Math.max(usedLen, Math.min(totalRollL, Number(params.windowStartY) || usedLen));

  const defects = Array.isArray(roll.defects) ? roll.defects : [];
  // 检查当前起切点有效区首端是否被贯穿宽幅的高危疵点阻挡，若遮挡则尝试微调起切点避开
  const fullWidthDefects = defects
    .map((d) => {
      const m = Number(d.margin ?? defaultDefectMarginMm) || 0;
      const y0 = Math.max(0, (Number(d.y) || 0) - m);
      const y1 = Math.min(totalRollL, (Number(d.y) || 0) + (Number(d.h) || 0) + m);
      const x0 = Math.max(0, (Number(d.x) || 0) - m);
      const x1 = Math.min(rollW, (Number(d.x) || 0) + (Number(d.w) || 0) + m);
      return { y0, y1, widthCoverage: (x1 - x0) / rollW };
    })
    .sort((a, b) => a.y0 - b.y0);

  let avoidedDefectsCount = 0;
  for (const band of fullWidthDefects) {
    if (band.widthCoverage >= 0.7 && startY + trimStartMm >= band.y0 && startY + trimStartMm < band.y1) {
      const jumped = Math.min(totalRollL - 100, Math.ceil(band.y1));
      if (jumped > startY) {
        startY = jumped;
        avoidedDefectsCount += 1;
      }
    }
  }

  const limits = feedLengthLimits({
    totalRollL,
    windowStartY: startY,
    stockRemainingLength: roll.currentRemainingLength ?? Math.max(0, totalRollL - usedLen),
    trimStart: trimStartMm
  });

  const openDemands = demands.filter((d) => (Number(d.quantity) || 0) > 0 && d.width > 0 && d.length > 0);
  const sourceDemands =
    openDemands.length > 0
      ? openDemands
      : demands.filter((d) => (Number(d.orderedQty) || 0) > 0 && d.width > 0 && d.length > 0);

  const rawSuggested = suggestedFeedLength({
    rollW,
    trimStart: trimStartMm,
    allowLongitudinal: true,
    allowRotation: sourceDemands.some((d) => Boolean(d.allowRotation)),
    demands: sourceDemands.map((d) => ({
      width: d.width,
      length: d.length,
      demand: Math.max(1, d.quantity || d.orderedQty || 1),
      allowRotation: Boolean(d.allowRotation),
      shape: d.shape
    }))
  });

  // 同时估算整单面积所需长度，并与最长单片需求取合理上限
  const netAreaMm2 = sourceDemands.reduce(
    (sum, d) =>
      sum +
      (d.shape ? shapeArea(d.shape) : d.width * d.length) * Math.max(1, d.quantity || d.orderedQty || 1),
    0
  );
  const areaEstLen =
    netAreaMm2 > 0
      ? Math.ceil((netAreaMm2 / Math.max(200, rollW * 0.72) + trimStartMm) / 100) * 100
      : 2000;

  let targetLen = Math.max(rawSuggested || 500, areaEstLen, limits.min || 500);

  // 对窗口内的局部疵点叠加面积补偿，并避免窗口末尾刚好卡在疵点中部
  const windowDefects = defects.filter((d) => {
    const m = Number(d.margin ?? defaultDefectMarginMm) || 0;
    return d.y - m < startY + targetLen && d.y + d.h + m > startY;
  });
  if (windowDefects.length > 0) {
    avoidedDefectsCount += windowDefects.length;
    const defectAreaMm2 = windowDefects.reduce((sum, d) => {
      const m = Number(d.margin ?? defaultDefectMarginMm) || 0;
      return sum + (d.w + m * 2) * (d.h + m * 2);
    }, 0);
    targetLen += Math.ceil(defectAreaMm2 / Math.max(200, rollW) / 50) * 50;
    for (const d of windowDefects) {
      const m = Number(d.margin ?? defaultDefectMarginMm) || 0;
      const dEnd = d.y + d.h + m;
      if (d.y - m < startY + targetLen && dEnd > startY + targetLen) {
        targetLen = Math.ceil((dEnd - startY) / 50) * 50;
      }
    }
  }

  const maxLen = Math.max(limits.min || 100, limits.max || Math.max(100, totalRollL - startY));
  const clampedLen = Math.max(
    Math.min(500, maxLen),
    Math.min(maxLen, Math.round(targetLen * 10) / 10)
  );

  const reason =
    avoidedDefectsCount > 0
      ? `已按需求建议拉布 ${fmtN(clampedLen, 1)} mm（含 ${avoidedDefectsCount} 处疵点避让补偿）`
      : `已按需求建议拉布 ${fmtN(clampedLen, 1)} mm（仅调整试算窗口，未写库）`;

  return {
    suggestedLengthMm: clampedLen,
    suggestedStartY: Math.round(startY * 10) / 10,
    minLengthMm: limits.min,
    maxLengthMm: maxLen,
    avoidedDefectsCount,
    reason
  };
}

/** 构造 CAM（DXF / G-Code）导出数据结构，真实透传窗口内疵点图层，便于单元测试直接校验。 */
export function buildCamExportPayload(
  activeScheme2D: SavedScheme2D,
  settings: StudioSettings,
  windowDefects: BoardDefect[] = []
) {
  const layout = activeScheme2D.result?.layout || {};
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
  const mappedRemnants = (layout.leftovers || []).map((rm: any, idx: number) => ({
    id: String(rm.id ?? idx + 1),
    x: Number(rm.x) || 0,
    y: Number(rm.y) || 0,
    w: Number(rm.shape?.width ?? rm.w) || 0,
    l: Number(rm.shape?.height ?? rm.l) || 0,
    hasDefect: Boolean(rm.hasDefect)
  }));
  const mappedDefects = (windowDefects || []).map((d, idx) => ({
    id: d.id ?? idx + 1,
    x: Number(d.x) || 0,
    y: Number(d.y) || 0,
    w: Number(d.w) || 0,
    h: Number(d.h) || 0,
    margin: d.margin ?? settings.defectMarginMm,
    desc: d.label || 'Flaw'
  }));
  return {
    rollId: activeScheme2D.rollId || 'VIRTUAL-NEW-ROLL',
    rollW: activeScheme2D.widthMm,
    bedL: activeScheme2D.occupiedLengthMm,
    windowStartY: activeScheme2D.windowStartY || 0,
    cutOrigin: settings.startCorner,
    pieces: mappedPieces,
    placements: mappedPieces,
    remnants: mappedRemnants,
    defects: mappedDefects,
    cuts: (layout.cuts || []).map((c: any) => ({
      step: c.sequence,
      type: c.kind === 'HORIZONTAL' ? '横切' : '纵切',
      startX: c.startX,
      startY: c.startY,
      endX: c.endX,
      endY: c.endY
    }))
  };
}

/** 生成 DXF 或 G-Code 文本：G-Code 透传设置的 CNC 后处理参数，DXF 透传窗口内真实疵点层。 */
export function generateCamExportText(
  activeScheme2D: SavedScheme2D,
  settings: StudioSettings,
  kind: 'dxf' | 'nc',
  windowDefects: BoardDefect[] = []
): string {
  const data = buildCamExportPayload(activeScheme2D, settings, windowDefects);
  if (kind === 'nc') {
    return gcodeText(data, extractCncPostOptions(settings));
  }
  return dxfText(data);
}

export function exportCam2D(
  activeScheme2D: SavedScheme2D | null,
  settings: StudioSettings,
  kind: 'dxf' | 'nc',
  windowDefects: BoardDefect[] = []
) {
  if (!activeScheme2D?.result?.layout) return;
  if (kind === 'nc' && activeScheme2D.layoutDirty) {
    toast('已手调，请先校验并重建刀路后再导出 G-Code', true);
    return;
  }
  const content = generateCamExportText(activeScheme2D, settings, kind, windowDefects);
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
