import type {
  CanvasMode2D,
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D
} from '../../store/studioTypes';
import type {
  BoardCutLine,
  BoardDefect,
  BoardDemandSpec,
  BoardLeftover,
  BoardPlacedPiece
} from '../../components/canvas/canvasTypes';
import {
  DISPOSITIONS,
  effectivePieceResults,
  receiptSummary,
  reviewablePieces
} from '../../lib/model/quality.js';
import {
  normalizeReconciliationReportItem,
  readDispositionFields,
  type NormalizedReconciliationReportRow
} from '../results/reconciliationUtils';
import { projectWindowDefectsForBoard } from './defectWindowUtils';
import { toBoardDefectsFromSchemeSnapshot } from './multiMaterialWorkbenchUtils';
import type { MultiMaterialCandidateRollOption } from './workbenchTypes';

export interface ReinspectedPieceTag {
  pieceId: number;
  disposition: string;
  dispositionLabel: string;
  reason: string;
}

export interface SchemeExecutionSummary {
  schemeId: string;
  reportCount: number;
  netQualifiedCount: number;
  reinspectedCount: number;
  rejectedTotalCount: number;
  disposedPieces: Map<number, ReinspectedPieceTag>;
}

export interface TaskExecutionProjection {
  taskId: string;
  reportCount: number;
  netQualifiedCount: number;
  rejectedTotalCount: number;
  reinspectionDisposedTotal: number;
  reinspectionScrapCount: number;
  reinspectionRemnantCount: number;
  reviewableCount: number;
  openRemainingCount: number;
  bySchemeId: Map<string, SchemeExecutionSummary>;
}

/**
 * 复用质检页与履约账本同一套 receiptSummary / effectivePieceResults 口径，
 * 计算当前需求池任务的实切净合格数、复检判废扣回数、待补排余量与各已确认方案的逐片判废映射。
 */
export function computeTaskExecutionProjection(params: {
  taskId: string | null;
  rawReports: any[];
  taskSchemes?: any[];
  openRemainingCount: number;
}): TaskExecutionProjection | null {
  const { taskId, rawReports, taskSchemes = [], openRemainingCount } = params;
  if (!taskId || !Array.isArray(rawReports) || rawReports.length === 0) return null;

  const planIdToSchemeId = new Map<string, string>();
  for (const sc of taskSchemes || []) {
    const sid = sc?.id ? String(sc.id) : '';
    if (!sid) continue;
    const linked: any[] = Array.isArray(sc.linkedPlanIds) ? sc.linkedPlanIds : [];
    for (const pid of linked) {
      if (pid != null && String(pid).trim()) {
        planIdToSchemeId.set(String(pid), sid);
      }
    }
  }

  let reportCount = 0;
  let netQualifiedCount = 0;
  let rejectedTotalCount = 0;
  let reinspectionDisposedTotal = 0;
  let reinspectionScrapCount = 0;
  let reinspectionRemnantCount = 0;
  let reviewableCount = 0;
  const bySchemeId = new Map<string, SchemeExecutionSummary>();

  for (const rawItem of rawReports) {
    const row: NormalizedReconciliationReportRow | null =
      normalizeReconciliationReportItem(rawItem);
    if (!row) continue;
    if (String(row.report.status || '').toUpperCase() === 'REVERSED') continue;

    reportCount += 1;
    const summary = receiptSummary(row.report, effectivePieceResults);
    netQualifiedCount += Number(summary.qualified) || 0;
    rejectedTotalCount += Number(summary.rejected) || 0;
    reinspectionDisposedTotal += Number(summary.dispositions) || 0;
    reviewableCount += reviewablePieces(row.report).length;

    const resolvedSchemeId = String(
      rawItem?.schemeId ||
        row.report.schemeId ||
        planIdToSchemeId.get(row.reportId) ||
        ''
    ).trim();

    let schemeBucket: SchemeExecutionSummary | null = null;
    if (resolvedSchemeId) {
      schemeBucket = bySchemeId.get(resolvedSchemeId) || {
        schemeId: resolvedSchemeId,
        reportCount: 0,
        netQualifiedCount: 0,
        reinspectedCount: 0,
        rejectedTotalCount: 0,
        disposedPieces: new Map<number, ReinspectedPieceTag>()
      };
      schemeBucket.reportCount += 1;
      schemeBucket.netQualifiedCount += Number(summary.qualified) || 0;
      schemeBucket.reinspectedCount += Number(summary.dispositions) || 0;
      schemeBucket.rejectedTotalCount += Number(summary.rejected) || 0;
      bySchemeId.set(resolvedSchemeId, schemeBucket);
    }

    row.dispositions.forEach((disp: any, idx: number) => {
      const info = readDispositionFields(disp, idx);
      if (info.revoked) return;
      if (info.disposition === 'REMNANT') {
        reinspectionRemnantCount += 1;
      } else {
        reinspectionScrapCount += 1;
      }
      if (schemeBucket && info.pieceId != null && Number.isFinite(Number(info.pieceId))) {
        const pid = Number(info.pieceId);
        const dispLabel =
          (DISPOSITIONS as Record<string, string>)[info.disposition] ||
          info.disposition ||
          '判废';
        schemeBucket.disposedPieces.set(pid, {
          pieceId: pid,
          disposition: info.disposition,
          dispositionLabel: dispLabel,
          reason: info.reason
        });
      }
    });
  }

  if (reportCount === 0) return null;

  return {
    taskId,
    reportCount,
    netQualifiedCount,
    rejectedTotalCount,
    reinspectionDisposedTotal,
    reinspectionScrapCount,
    reinspectionRemnantCount,
    reviewableCount,
    openRemainingCount: Math.max(0, Math.round(Number(openRemainingCount) || 0)),
    bySchemeId
  };
}

/**
 * 为已确认且存在复检判废记录的画布裁片注入「复检判废」清晰标签（并刷新稳定签名 ID 以触发 Konva 即时重绘）。
 */
export function annotateBoardPiecesWithReinspection(
  pieces: BoardPlacedPiece[],
  schemeExecution: SchemeExecutionSummary | null | undefined
): BoardPlacedPiece[] {
  if (!schemeExecution || schemeExecution.disposedPieces.size === 0) {
    return pieces;
  }
  return pieces.map((pc) => {
    const rawNumericId = Number(pc.id);
    const hit =
      (Number.isInteger(rawNumericId) && rawNumericId > 0
        ? schemeExecution.disposedPieces.get(rawNumericId)
        : undefined) || schemeExecution.disposedPieces.get(pc.index + 1);
    if (!hit) return pc;
    const prefix = hit.disposition === 'REMNANT' ? '[复检判废·转料头]' : '[复检判废]';
    return {
      ...pc,
      id: `${pc.id}-REINSPECTED`,
      name: `${prefix} ${pc.name}`
    };
  });
}

export interface BatchGuardWarning {
  blocking: boolean;
  title: string;
  detail: string;
  suggestedRoll: any | null;
}

export function computeBatchGuardWarning(params: {
  activePoolFamily: DemandFamilySummary | null;
  is2D: boolean;
  canvasMode: CanvasMode2D;
  currentRoll2D: any | null;
  currentRemnant2D: any | null;
  multiCandidateRollIds: string[];
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  currentRoll1D: any | null;
  passedRolls: any[];
}): BatchGuardWarning | null {
  const {
    activePoolFamily,
    is2D,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    multiCandidateRollIds,
    slitMaterialMode,
    currentRoll1D,
    passedRolls
  } = params;

  if (!activePoolFamily) return null;
  const reqBatch = String(activePoolFamily.requiredBatchNo || '').trim();
  const reqColor = String(activePoolFamily.requiredColor || '').trim();
  const strict = Boolean(activePoolFamily.strictBatchMatch);
  if (!reqBatch && !reqColor && !strict) return null;

  let matLabel = '';
  let matBatch = '';
  let matColor = '';
  if (is2D) {
    if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
      matLabel = `母卷 ${currentRoll2D.rollId}`;
      matBatch = String(currentRoll2D.batchNo || '').trim();
      matColor = String(currentRoll2D.color || '').trim();
    } else if (canvasMode === 'REMNANT' && currentRemnant2D) {
      matLabel = `料头 ${currentRemnant2D.id}`;
      matBatch = String(currentRemnant2D.batchNo || currentRemnant2D.materialBatch || '').trim();
      matColor = String(currentRemnant2D.color || '').trim();
    } else if (canvasMode === 'MULTI_MATERIAL' && multiCandidateRollIds.length > 0) {
      const offending = multiCandidateRollIds
        .map((rid) => passedRolls.find((r) => r.rollId === rid))
        .find((r) => {
          if (!r) return false;
          const rb = String(r.batchNo || '').trim();
          const rc = String(r.color || '').trim();
          if (reqBatch && (!rb || rb.toLowerCase() !== reqBatch.toLowerCase())) return true;
          if (strict && !rb) return true;
          if (reqColor && rc && rc.toLowerCase() !== reqColor.toLowerCase()) return true;
          return false;
        });
      if (!offending) return null;
      matLabel = `已选候选母卷 ${offending.rollId}`;
      matBatch = String(offending.batchNo || '').trim();
      matColor = String(offending.color || '').trim();
    } else {
      return null;
    }
  } else if (slitMaterialMode === 'STOCK_ROLL' && currentRoll1D) {
    matLabel = `母卷 ${currentRoll1D.rollId}`;
    matBatch = String(currentRoll1D.batchNo || '').trim();
    matColor = String(currentRoll1D.color || '').trim();
  } else {
    return null;
  }

  const matchingRoll = passedRolls.find((r) => {
    if (reqBatch && String(r.batchNo || '').trim().toLowerCase() !== reqBatch.toLowerCase()) {
      return false;
    }
    if (reqColor && r.color && String(r.color).trim().toLowerCase() !== reqColor.toLowerCase()) {
      return false;
    }
    if (strict && !String(r.batchNo || '').trim()) return false;
    return true;
  });

  if (reqBatch && (!matBatch || matBatch.toLowerCase() !== reqBatch.toLowerCase())) {
    return {
      blocking: strict,
      title: strict ? '防色差同缸强约束拦截' : '跨缸号预警提示',
      detail: `需求族「${activePoolFamily.name}」指定缸号 ${reqBatch}，当前所选 ${matLabel} 缸号为「${
        matBatch || '未登记'
      }」${strict ? '，已开启同单同缸强约束，禁止直接排版落库。' : '，请注意核对色差风险。'}`,
      suggestedRoll: matchingRoll || null
    };
  }
  if (strict && !matBatch) {
    return {
      blocking: true,
      title: '防色差同缸强约束拦截',
      detail: `需求族「${activePoolFamily.name}」已开启同单同缸强约束，但当前所选 ${matLabel} 未登记缸号，无法通过同缸校验。`,
      suggestedRoll: matchingRoll || null
    };
  }
  if (reqColor && matColor && matColor.toLowerCase() !== reqColor.toLowerCase()) {
    return {
      blocking: strict,
      title: strict ? '色号不匹配拦截' : '色号差异预警',
      detail: `需求族「${activePoolFamily.name}」指定色号「${reqColor}」，当前所选 ${matLabel} 色号为「${matColor}」。`,
      suggestedRoll: matchingRoll || null
    };
  }
  return null;
}

export function computeEffectiveWindowStartY(params: {
  canvasMode: CanvasMode2D;
  currentRoll2D: any | null;
  windowStartY2D: number | null;
}): number {
  const { canvasMode, currentRoll2D, windowStartY2D } = params;
  if (canvasMode !== 'STOCK_ROLL' || !currentRoll2D) return 0;
  const used = Math.max(0, Number(currentRoll2D.usedLength) || 0);
  const total = Math.max(used, Number(currentRoll2D.totalLength) || used);
  if (windowStartY2D == null || !Number.isFinite(windowStartY2D)) return used;
  return Math.max(used, Math.min(Math.max(used, total - 100), windowStartY2D));
}

export function computeEffectiveRollWidthMm(params: {
  activeScheme2D: SavedScheme2D | null;
  canvasMode: CanvasMode2D;
  currentRoll2D: any | null;
  currentRemnant2D: any | null;
  multiCandidateRollOptions: MultiMaterialCandidateRollOption[];
  canvasWidthMm: number;
}): number {
  const {
    activeScheme2D,
    canvasMode,
    currentRoll2D,
    currentRemnant2D,
    multiCandidateRollOptions,
    canvasWidthMm
  } = params;
  if (activeScheme2D?.widthMm) return activeScheme2D.widthMm;
  if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return currentRoll2D.width;
  if (canvasMode === 'REMNANT' && currentRemnant2D) return currentRemnant2D.width;
  if (canvasMode === 'MULTI_MATERIAL') {
    const firstEligible =
      multiCandidateRollOptions.find((r) => r.eligible) || multiCandidateRollOptions[0];
    if (firstEligible && firstEligible.width > 0) return firstEligible.width;
  }
  return canvasWidthMm;
}

export function computeEffectiveRollLengthMm(params: {
  activeScheme2D: SavedScheme2D | null;
  canvasMode: CanvasMode2D;
  currentRemnant2D: any | null;
  canvasLengthMm: number;
}): number {
  const { activeScheme2D, canvasMode, currentRemnant2D, canvasLengthMm } = params;
  const baseLen =
    canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
  if (!activeScheme2D) return baseLen;
  if (activeScheme2D.canvasMode === 'REMNANT' || Boolean(activeScheme2D.multiMaterialRole)) {
    return Math.max(
      100,
      Math.ceil(activeScheme2D.canvasLengthMm || 0),
      Math.ceil(activeScheme2D.occupiedLengthMm || 0)
    );
  }
  return Math.max(
    baseLen,
    Math.ceil(activeScheme2D.occupiedLengthMm || 0),
    Math.ceil(activeScheme2D.canvasLengthMm || 0)
  );
}

export function computeEffectiveRollTitle(params: {
  activeScheme2D: SavedScheme2D | null;
  canvasMode: CanvasMode2D;
  currentRoll2D: any | null;
  currentRemnant2D: any | null;
}): string {
  const { activeScheme2D, canvasMode, currentRoll2D, currentRemnant2D } = params;
  if (activeScheme2D) {
    if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
      const y0 = Math.round(Number(activeScheme2D.windowStartY) || 0);
      return y0 > 0
        ? `实卷 ${activeScheme2D.rollId} (Y=${y0}mm)`
        : `实卷 ${activeScheme2D.rollId}`;
    }
    if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
      return `料头 ${activeScheme2D.remnantId}`;
    }
    return '虚拟新母卷';
  }
  if (canvasMode === 'STOCK_ROLL' && currentRoll2D) return `实卷 ${currentRoll2D.rollId}`;
  if (canvasMode === 'REMNANT' && currentRemnant2D) return `料头 ${currentRemnant2D.id}`;
  if (canvasMode === 'MULTI_MATERIAL') return '多料联排（待求解）';
  return '虚拟新母卷';
}

export function computeWindowDefects2D(params: {
  activeScheme2D: SavedScheme2D | null;
  canvasMode: CanvasMode2D;
  rolls: any[];
  remnants: any[];
  currentRoll2D: any | null;
  currentRemnant2D: any | null;
  effectiveWindowStartY: number;
  effectiveRollWidthMm: number;
  effectiveRollLengthMm: number;
  defectMarginMm: number;
}): BoardDefect[] {
  const {
    activeScheme2D,
    canvasMode,
    rolls,
    remnants,
    currentRoll2D,
    currentRemnant2D,
    effectiveWindowStartY,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    defectMarginMm
  } = params;

  if (activeScheme2D) {
    if (Array.isArray(activeScheme2D.defects) && activeScheme2D.defects.length > 0) {
      const alreadyAligned = activeScheme2D.defects.some((d) => d.windowAligned);
      if (alreadyAligned) {
        return toBoardDefectsFromSchemeSnapshot(activeScheme2D.defects);
      }
      return projectWindowDefectsForBoard(
        activeScheme2D.defects,
        0,
        effectiveRollLengthMm,
        effectiveRollWidthMm,
        defectMarginMm
      );
    }
    if (activeScheme2D.canvasMode === 'STOCK_ROLL' && activeScheme2D.rollId) {
      const matchedRoll =
        rolls.find((r) => r.rollId === activeScheme2D.rollId) || currentRoll2D;
      if (matchedRoll) {
        const startY =
          activeScheme2D.windowStartY != null
            ? activeScheme2D.windowStartY
            : effectiveWindowStartY;
        return projectWindowDefectsForBoard(
          matchedRoll.defects,
          startY,
          effectiveRollLengthMm,
          Number(matchedRoll.width) || effectiveRollWidthMm,
          defectMarginMm
        );
      }
    }
    if (activeScheme2D.canvasMode === 'REMNANT' && activeScheme2D.remnantId) {
      const matchedRem =
        remnants.find((rm) => rm.id === activeScheme2D.remnantId) || currentRemnant2D;
      if (matchedRem) {
        return projectWindowDefectsForBoard(
          matchedRem.defects,
          0,
          effectiveRollLengthMm,
          Number(matchedRem.width) || effectiveRollWidthMm,
          defectMarginMm
        );
      }
    }
    if (activeScheme2D.canvasMode === 'FREE_CANVAS') {
      return [];
    }
  }

  if (canvasMode === 'STOCK_ROLL' && currentRoll2D) {
    return projectWindowDefectsForBoard(
      currentRoll2D.defects,
      effectiveWindowStartY,
      effectiveRollLengthMm,
      Number(currentRoll2D.width) || effectiveRollWidthMm,
      defectMarginMm
    );
  }
  if (canvasMode === 'REMNANT' && currentRemnant2D) {
    return projectWindowDefectsForBoard(
      currentRemnant2D.defects,
      0,
      effectiveRollLengthMm,
      Number(currentRemnant2D.width) || effectiveRollWidthMm,
      defectMarginMm
    );
  }
  return [];
}

export function buildBoardPlacedPieces(
  activeScheme2D: SavedScheme2D | null,
  activeSchemeExecution: SchemeExecutionSummary | null
): BoardPlacedPiece[] {
  if (!activeScheme2D?.result?.layout) return [];
  const mainList: any[] = activeScheme2D.result.layout.placements || [];
  const gapList: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
  const combined: BoardPlacedPiece[] = [];
  mainList.forEach((p, idx) => {
    combined.push({
      id: p.id ?? `m-${idx + 1}`,
      index: idx,
      demandId: p.demandId,
      demandKey: p.demandId != null ? String(p.demandId) : `p-${idx}`,
      name: p.name || `#${p.demandId ?? idx + 1}`,
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      width: Number(p.shape?.width ?? p.w) || 0,
      height: Number(p.shape?.height ?? p.l) || 0,
      rotationDegrees: p.rotationDegrees || 0,
      gapFill: false,
      shape: p.shape
    });
  });
  gapList.forEach((p, idx) => {
    const globalIdx = mainList.length + idx;
    combined.push({
      id: p.id ?? `g-${idx + 1}`,
      index: globalIdx,
      demandId: p.demandId,
      demandKey: p.demandId != null ? String(p.demandId) : `g-${idx}`,
      name: p.name || `#${p.demandId ?? idx + 1}`,
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      width: Number(p.shape?.width ?? p.w) || 0,
      height: Number(p.shape?.height ?? p.l) || 0,
      rotationDegrees: p.rotationDegrees || 0,
      gapFill: true,
      shape: p.shape
    });
  });
  return annotateBoardPiecesWithReinspection(combined, activeSchemeExecution);
}

export function buildBoardLeftovers(activeScheme2D: SavedScheme2D | null): BoardLeftover[] {
  const raw = activeScheme2D?.result?.layout?.leftovers || [];
  return raw
    .map((rm: any, idx: number) => ({
      id: String(rm.id ?? idx + 1),
      x: Number(rm.x) || 0,
      y: Number(rm.y) || 0,
      width: Number(rm.shape?.width ?? rm.w) || 0,
      height: Number(rm.shape?.height ?? rm.l) || 0,
      hasDefect: Boolean(rm.hasDefect),
      shape: rm.shape
    }))
    .filter((rm: BoardLeftover) => rm.width > 0 && rm.height > 0);
}

export function buildBoardCuts(activeScheme2D: SavedScheme2D | null): BoardCutLine[] {
  const raw = activeScheme2D?.result?.layout?.cuts || [];
  return raw.map((c: any, idx: number) => ({
    sequence: c.sequence ?? idx + 1,
    kind: c.kind,
    startX: Number(c.startX) || 0,
    startY: Number(c.startY) || 0,
    endX: Number(c.endX) || 0,
    endY: Number(c.endY) || 0
  }));
}

export function buildBoardStagingDemands(
  activeDemands2D: DemandItem[],
  activeScheme2D: SavedScheme2D | null
): BoardDemandSpec[] {
  const placedByDemand = new Map<number, number>();
  if (activeScheme2D && !activeScheme2D.confirmedSchemeId) {
    for (const p of activeScheme2D.result?.layout?.placements || []) {
      if (p.demandId != null) {
        const did = Number(p.demandId);
        placedByDemand.set(did, (placedByDemand.get(did) || 0) + 1);
      }
    }
  }
  return activeDemands2D.map((d) => {
    const openQty = Math.max(0, Number(d.quantity) || 0);
    const placed = placedByDemand.get(d.id) || 0;
    return {
      key: String(d.id),
      demandId: d.id,
      name: d.name,
      width: d.width,
      length: d.length,
      remainingQty: Math.max(0, openQty - placed),
      totalQty: openQty,
      allowRotation: d.allowRotation,
      allowHalfTurn: d.allowHalfTurn,
      shape: d.shape
    };
  });
}
