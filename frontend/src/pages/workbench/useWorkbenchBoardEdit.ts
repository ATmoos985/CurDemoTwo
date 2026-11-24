import { Dispatch, SetStateAction, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandItem,
  SavedScheme2D,
  Scenario2DType
} from '../../store/useStudioStore';
import { StudioSettings } from '../../store/studioSettings';
import { BoardDefect } from '../../components/WorkbenchBoardCanvas';
import { buildSafeNestingRequest2D } from '@static/js/business/optimization/nesting-request-adapter.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { requestJSON, toast } from '@static/app/js/util.js';
import { LastConfirmSummary, STRATEGIES_2D } from './workbenchTypes';
import {
  tryRotatePlacedPiece,
  ValidationPlacedPiece
} from './boardPlacementValidation';
import {
  BoardEditSnapshot,
  BoardHistoryStack,
  createEmptyHistoryStack,
  pushBoardHistory,
  redoBoardHistory,
  restoreOriginalBoardHistory,
  tryNudgePlacedPiece,
  undoBoardHistory
} from './boardHistory';
import { buildValidateLayoutPayload } from './schemeConfirmUtils';

export interface UseWorkbenchBoardEditOptions {
  activeScheme2D: SavedScheme2D | null;
  activeDemands2D: DemandItem[];
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  scenario2D: Scenario2DType;
  currentRoll2D: any;
  currentRemnant2D: any;
  materialModel2D: string;
  effectiveRollWidthMm: number;
  effectiveRollLengthMm: number;
  effectiveWindowStartY: number;
  pieceGapMm: number;
  trimStartMm: number;
  windowDefects2D: BoardDefect[];
  settings: StudioSettings;
  removeScheme2D: (id: string) => void;
  setSelectedPieceIndex: Dispatch<SetStateAction<number | null>>;
  setSelectedLeftoverId: Dispatch<SetStateAction<string | null>>;
  setLastConfirmSummary: Dispatch<SetStateAction<LastConfirmSummary | null>>;
}

export interface ValidateLayoutResponse {
  feasible: boolean;
  errors?: string[];
  cuts?: Array<{
    sequence?: number;
    kind?: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }>;
  leftovers?: Array<{
    id?: string | number;
    x: number;
    y: number;
    w?: number;
    l?: number;
    shape?: { type: 'RECTANGLE' | 'POLYGON'; width: number; height: number };
    hasDefect?: boolean;
  }>;
}

/** 将后端 validate-layout 响应规范化并合并回方案结构，便于单测直接验证。 */
export function applyLayoutValidationResult(
  scheme: SavedScheme2D,
  res: ValidateLayoutResponse
): SavedScheme2D {
  if (!res?.feasible) {
    const errors =
      Array.isArray(res?.errors) && res.errors.length > 0
        ? res.errors
        : ['手调布局几何校验未通过，请检查裁片边界、旋转许可与碰撞情况'];
    return {
      ...scheme,
      layoutDirty: true,
      layoutValidationErrors: errors
    };
  }

  const normalizedCuts = (res.cuts || []).map((c, idx) => ({
    sequence: c.sequence ?? idx + 1,
    kind: c.kind || 'CONTOUR',
    startX: Number(c.startX) || 0,
    startY: Number(c.startY) || 0,
    endX: Number(c.endX) || 0,
    endY: Number(c.endY) || 0
  }));
  const normalizedLeftovers = (res.leftovers || []).map((rm, idx) => {
    const w = Number(rm.shape?.width ?? rm.w) || 0;
    const l = Number(rm.shape?.height ?? rm.l) || 0;
    return {
      id: String(rm.id ?? idx + 1),
      x: Number(rm.x) || 0,
      y: Number(rm.y) || 0,
      w,
      l,
      shape: rm.shape || rectangle(w, l),
      hasDefect: Boolean(rm.hasDefect)
    };
  });

  return {
    ...scheme,
    layoutDirty: false,
    layoutValidationErrors: [],
    result: {
      ...(scheme.result || {}),
      layout: {
        ...(scheme.result?.layout || {}),
        cuts: normalizedCuts,
        leftovers: normalizedLeftovers
      }
    }
  };
}

function captureSchemeSnapshot(scheme: SavedScheme2D): BoardEditSnapshot {
  return {
    mainPlacements: structuredClone(scheme.result?.layout?.placements || []),
    gapPlacements: structuredClone(scheme.result?.marker?.gapFillPlacements || []),
    leftovers: structuredClone(scheme.result?.layout?.leftovers || []),
    discardedLeftoverIds: structuredClone(scheme.result?.layout?.discardedLeftoverIds || []),
    cuts: structuredClone(scheme.result?.layout?.cuts || []),
    layoutDirty: Boolean(scheme.layoutDirty),
    strategyName: scheme.strategyName
  };
}

export function useWorkbenchBoardEdit(opts: UseWorkbenchBoardEditOptions) {
  const {
    activeScheme2D,
    activeDemands2D,
    canvasMode,
    scenario2D,
    currentRoll2D,
    currentRemnant2D,
    materialModel2D,
    effectiveRollWidthMm,
    effectiveRollLengthMm,
    effectiveWindowStartY,
    pieceGapMm,
    trimStartMm,
    windowDefects2D,
    settings,
    removeScheme2D,
    setSelectedPieceIndex,
    setSelectedLeftoverId,
    setLastConfirmSummary
  } = opts;

  const [validatingLayout, setValidatingLayout] = useState(false);
  const historyMapRef = useRef<Map<string, BoardHistoryStack>>(new Map());
  const [, setHistoryTick] = useState(0);

  const getHistoryFor = (schemeId: string | undefined): BoardHistoryStack => {
    if (!schemeId) return createEmptyHistoryStack();
    return historyMapRef.current.get(schemeId) || createEmptyHistoryStack();
  };

  const setHistoryFor = (schemeId: string, next: BoardHistoryStack) => {
    historyMapRef.current.set(schemeId, next);
    setHistoryTick((t) => t + 1);
  };

  const buildUpdatedScheme = (
    existingEditable: SavedScheme2D | null,
    snap: BoardEditSnapshot
  ): { nextScheme: SavedScheme2D; isManualNew: boolean } => {
    const allPieces = [...snap.mainPlacements, ...snap.gapPlacements];
    const effW = existingEditable ? existingEditable.widthMm : effectiveRollWidthMm;
    const effL = existingEditable ? existingEditable.canvasLengthMm : effectiveRollLengthMm;
    const startOffset =
      existingEditable?.windowStartY ??
      (canvasMode === 'STOCK_ROLL' ? effectiveWindowStartY : 0);

    const occupiedLengthMm = allPieces.length
      ? Math.round(
          Math.max(
            ...allPieces.map(
              (p: any) => (Number(p.y) || 0) + (Number(p.shape?.height ?? p.l) || 0)
            )
          ) * 10
        ) / 10
      : 0;
    const netAreaMm2 = allPieces.reduce(
      (s: number, p: any) =>
        s + (p.shape ? shapeArea(p.shape) : (Number(p.w) || 0) * (Number(p.l) || 0)),
      0
    );
    const utilizationPct =
      occupiedLengthMm > 0
        ? Number(((netAreaMm2 / (effW * occupiedLengthMm)) * 100).toFixed(2))
        : 0;
    const pieceAreaM2 = Number((netAreaMm2 / 1_000_000).toFixed(3));

    const activeOpenDemands = activeDemands2D.filter(
      (d) => d.quantity > 0 && d.width > 0 && d.length > 0
    );
    const totalRequested = activeOpenDemands.reduce((s, d) => s + d.quantity, 0);
    const placedCounts = new Map<number, number>();
    for (const p of snap.mainPlacements) {
      if (p.demandId != null) {
        const id = Number(p.demandId);
        placedCounts.set(id, (placedCounts.get(id) || 0) + 1);
      }
    }
    const complete =
      activeOpenDemands.length > 0 &&
      activeOpenDemands.every((d) => (placedCounts.get(d.id) || 0) >= d.quantity);

    const manualBuilt = existingEditable?.request
      ? null
      : buildSafeNestingRequest2D({
          strategy: STRATEGIES_2D[4],
          scenario: 'FIXED_BED',
          widthMm: effW,
          lengthMm: Math.max(effL, occupiedLengthMm || effL),
          pieceGapMm,
          trimStartMm,
          demands: activeOpenDemands.length > 0 ? activeOpenDemands : activeDemands2D,
          defects: windowDefects2D,
          settings
        });
    const baseReq = existingEditable?.request || manualBuilt?.request || {
      schemaVersion: '2.0',
      problemType: 'NESTING_2D',
      problem: {
        schemaVersion: '1',
        unit: 'mm',
        material: {
          id: `CANVAS-${effW}x${Math.max(effL, occupiedLengthMm || effL)}`,
          shape: rectangle(effW, Math.max(effL, occupiedLengthMm || effL)),
          exclusions: []
        },
        parts: [],
        process: { mode: 'GUILLOTINE', startCorner: 'left-top', trimStart: 0 }
      }
    };

    const nextResult = {
      ...(existingEditable?.result || {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        engine: 'manual-board',
        materialId: baseReq.problem.material.id,
        processingRegion: rectangle(effW, Math.max(effL, occupiedLengthMm || effL))
      }),
      fulfillmentStatus: complete ? 'COMPLETE' : 'PARTIAL',
      meetsRequirement: complete,
      layout: {
        ...(existingEditable?.result?.layout || {
          processingRegion: rectangle(effW, Math.max(effL, occupiedLengthMm || effL)),
          contours: []
        }),
        placements: snap.mainPlacements,
        leftovers: snap.leftovers,
        discardedLeftoverIds: snap.discardedLeftoverIds,
        cuts: snap.cuts
      },
      marker: {
        ...(existingEditable?.result?.marker || {}),
        occupiedLengthMm,
        gapFillPlacements: snap.gapPlacements
      }
    };

    const isManualNew = !existingEditable;
    const schemeId = existingEditable
      ? existingEditable.id
      : `MANUAL-BOARD-${Date.now().toString(36).slice(-5)}`;

    const nextScheme: SavedScheme2D = {
      id: schemeId,
      title: `${snap.strategyName} (${effW}×${Math.round(occupiedLengthMm)}mm)`,
      strategyId: existingEditable ? existingEditable.strategyId : 'MANUAL_BOARD',
      strategyName: snap.strategyName,
      scenarioId: existingEditable?.scenarioId || scenario2D,
      createdAt:
        existingEditable?.createdAt || new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      canvasMode: existingEditable?.canvasMode || canvasMode,
      rollId:
        existingEditable?.rollId ??
        (canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.rollId : undefined),
      remnantId:
        existingEditable?.remnantId ??
        (canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.id : undefined),
      windowStartY: startOffset,
      materialModel:
        existingEditable?.materialModel ||
        (canvasMode === 'STOCK_ROLL' && currentRoll2D
          ? currentRoll2D.rollModel
          : canvasMode === 'REMNANT' && currentRemnant2D
          ? currentRemnant2D.materialBatch
          : materialModel2D || `VIRTUAL-${effW}`),
      widthMm: effW,
      canvasLengthMm: Math.max(effL, occupiedLengthMm),
      occupiedLengthMm,
      utilizationPct,
      pieceAreaM2,
      placedCount: allPieces.length,
      requestedCount: Math.max(totalRequested, allPieces.length),
      gapFillCount: snap.gapPlacements.length,
      complete,
      demands: structuredClone(activeOpenDemands.length > 0 ? activeOpenDemands : activeDemands2D),
      request: baseReq,
      result: nextResult,
      layoutDirty: snap.layoutDirty,
      layoutValidationErrors: undefined
    };

    return { nextScheme, isManualNew };
  };

  const applySchemeSnapshotToStore = (
    existingEditable: SavedScheme2D | null,
    snap: BoardEditSnapshot
  ): SavedScheme2D => {
    const { nextScheme, isManualNew } = buildUpdatedScheme(existingEditable, snap);
    useStudioStore.setState((st) => {
      if (isManualNew) {
        return {
          schemes2D: [nextScheme, ...st.schemes2D],
          activeSchemeId2D: nextScheme.id
        };
      }
      return {
        schemes2D: st.schemes2D.map((s) => (s.id === nextScheme.id ? nextScheme : s)),
        activeSchemeId2D: nextScheme.id
      };
    });
    setLastConfirmSummary(null);
    return nextScheme;
  };

  const commitBoardPlacements = (
    mutate: (
      mainPlacements: any[],
      gapPlacements: any[],
      leftovers: any[]
    ) => {
      mainPlacements: any[];
      gapPlacements: any[];
      leftovers?: any[];
      discardedLeftoverIds?: string[];
      notice?: string;
    } | null
  ) => {
    const existingEditable =
      activeScheme2D && !activeScheme2D.confirmedSchemeId ? activeScheme2D : null;
    const beforeSnap: BoardEditSnapshot = existingEditable
      ? captureSchemeSnapshot(existingEditable)
      : {
          mainPlacements: [],
          gapPlacements: [],
          leftovers: [],
          discardedLeftoverIds: [],
          cuts: [],
          layoutDirty: false,
          strategyName: '手工排布'
        };

    const mutated = mutate(
      structuredClone(beforeSnap.mainPlacements),
      structuredClone(beforeSnap.gapPlacements),
      structuredClone(beforeSnap.leftovers)
    );
    if (!mutated) return;

    const { mainPlacements, gapPlacements, notice } = mutated;
    const allPieces = [...mainPlacements, ...gapPlacements];

    if (allPieces.length === 0 && existingEditable?.strategyId === 'MANUAL_BOARD') {
      removeScheme2D(existingEditable.id);
      historyMapRef.current.delete(existingEditable.id);
      setSelectedPieceIndex(null);
      setSelectedLeftoverId(null);
      if (notice) toast(notice);
      return;
    }

    const nextStrategyName = existingEditable
      ? existingEditable.strategyId === 'MANUAL_BOARD'
        ? '手工排布'
        : existingEditable.strategyName.endsWith(' · 手调')
        ? existingEditable.strategyName
        : `${existingEditable.strategyName} · 手调`
      : '手工排布';

    const nextSnap: BoardEditSnapshot = {
      mainPlacements,
      gapPlacements,
      leftovers: mutated.leftovers !== undefined ? mutated.leftovers : [],
      discardedLeftoverIds:
        mutated.discardedLeftoverIds !== undefined
          ? mutated.discardedLeftoverIds
          : beforeSnap.discardedLeftoverIds,
      cuts: [],
      layoutDirty: true,
      strategyName: nextStrategyName
    };

    const nextScheme = applySchemeSnapshotToStore(existingEditable, nextSnap);
    const prevStack = getHistoryFor(nextScheme.id);
    setHistoryFor(nextScheme.id, pushBoardHistory(prevStack, beforeSnap));
    if (notice) toast(notice);
  };

  const handleDropStagingPiece = (demandKey: string, localX: number, localY: number) => {
    const demand = activeDemands2D.find((d) => String(d.id) === demandKey);
    if (!demand) return;
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const nextId =
        mainPlacements.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0) + 1;
      const shape = demand.shape
        ? structuredClone(demand.shape)
        : rectangle(Number(demand.width), Number(demand.length));
      mainPlacements.push({
        id: nextId,
        demandId: demand.id,
        name: demand.name,
        x: localX,
        y: localY,
        rotationDegrees: 0,
        allowRotation: Boolean(demand.allowRotation),
        allowHalfTurn: Boolean(demand.allowHalfTurn),
        shape
      });
      setSelectedPieceIndex(mainPlacements.length - 1);
      return { mainPlacements, gapPlacements };
    });
  };

  const handleMovePlacedPiece = (pieceIndex: number, localX: number, localY: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      if (pieceIndex < mainPlacements.length) {
        mainPlacements[pieceIndex] = {
          ...mainPlacements[pieceIndex],
          x: localX,
          y: localY
        };
      } else {
        const gIdx = pieceIndex - mainPlacements.length;
        if (gIdx >= 0 && gIdx < gapPlacements.length) {
          gapPlacements[gIdx] = {
            ...gapPlacements[gIdx],
            x: localX,
            y: localY
          };
        } else {
          return null;
        }
      }
      return { mainPlacements, gapPlacements };
    });
  };

  const handleNudgePlacedPiece = (pieceIndex: number, dxMm: number, dyMm: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const isMain = pieceIndex < mainPlacements.length;
      const target = isMain
        ? mainPlacements[pieceIndex]
        : gapPlacements[pieceIndex - mainPlacements.length];
      if (!target) return null;

      const allPlaced: ValidationPlacedPiece[] = [...mainPlacements, ...gapPlacements].map(
        (p: any, idx: number) => ({
          index: idx,
          name: p.name || `#${p.id ?? idx + 1}`,
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          width: Number(p.shape?.width ?? p.w) || 0,
          height: Number(p.shape?.height ?? p.l) || 0,
          shape: p.shape
        })
      );

      const effW = activeScheme2D ? activeScheme2D.widthMm : effectiveRollWidthMm;
      const effL = activeScheme2D
        ? Math.max(activeScheme2D.canvasLengthMm, effectiveRollLengthMm)
        : effectiveRollLengthMm;

      const attempt = tryNudgePlacedPiece({
        target,
        pieceIndex,
        dxMm,
        dyMm,
        placedPieces: allPlaced,
        rollWidthMm: effW,
        rollLengthMm: effL,
        trimStartMm,
        pieceGapMm,
        defects: windowDefects2D
      });
      if (!attempt.ok) {
        toast(attempt.reason, true);
        return null;
      }

      const updated = { ...target, x: attempt.nextX, y: attempt.nextY };
      if (isMain) mainPlacements[pieceIndex] = updated;
      else gapPlacements[pieceIndex - mainPlacements.length] = updated;
      return { mainPlacements, gapPlacements };
    });
  };

  const handleRotatePlacedPiece = (pieceIndex: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const isMain = pieceIndex < mainPlacements.length;
      const target = isMain
        ? mainPlacements[pieceIndex]
        : gapPlacements[pieceIndex - mainPlacements.length];
      if (!target) return null;

      const demand =
        activeDemands2D.find((d) => d.id === target.demandId) ||
        activeScheme2D?.demands?.find((d) => d.id === target.demandId);

      const allPlaced: ValidationPlacedPiece[] = [...mainPlacements, ...gapPlacements].map(
        (p: any, idx: number) => ({
          index: idx,
          name: p.name || `#${p.id ?? idx + 1}`,
          x: Number(p.x) || 0,
          y: Number(p.y) || 0,
          width: Number(p.shape?.width ?? p.w) || 0,
          height: Number(p.shape?.height ?? p.l) || 0,
          shape: p.shape
        })
      );

      const effW = activeScheme2D ? activeScheme2D.widthMm : effectiveRollWidthMm;
      const effL = activeScheme2D
        ? Math.max(activeScheme2D.canvasLengthMm, effectiveRollLengthMm)
        : effectiveRollLengthMm;

      const attempt = tryRotatePlacedPiece({
        target,
        pieceIndex,
        demand,
        placedPieces: allPlaced,
        rollWidthMm: effW,
        rollLengthMm: effL,
        trimStartMm,
        pieceGapMm,
        defects: windowDefects2D
      });

      if (!attempt.ok) {
        toast(attempt.reason, true);
        return null;
      }

      const updated = {
        ...target,
        x: attempt.nextX,
        y: attempt.nextY,
        rotationDegrees: attempt.nextRotationDegrees,
        shape: attempt.rotatedShape
      };
      if (isMain) mainPlacements[pieceIndex] = updated;
      else gapPlacements[pieceIndex - mainPlacements.length] = updated;

      return { mainPlacements, gapPlacements };
    });
  };

  const handleRemovePlacedPiece = (pieceIndex: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      if (pieceIndex < mainPlacements.length) {
        mainPlacements.splice(pieceIndex, 1);
      } else {
        const gIdx = pieceIndex - mainPlacements.length;
        if (gIdx >= 0 && gIdx < gapPlacements.length) {
          gapPlacements.splice(gIdx, 1);
        } else {
          return null;
        }
      }
      setSelectedPieceIndex(null);
      return { mainPlacements, gapPlacements };
    });
  };

  /** 从当前预览中抛弃指定计划余料：标脏提示需恢复原预览或校验重建刀路。 */
  const handleDiscardLeftover = (leftoverId: string) => {
    if (!activeScheme2D || activeScheme2D.confirmedSchemeId) return;
    commitBoardPlacements((mainPlacements, gapPlacements, leftovers) => {
      const targetIdx = leftovers.findIndex((rm: any, i: number) => String(rm.id ?? i + 1) === leftoverId);
      if (targetIdx < 0) return null;
      const nextLeftovers = leftovers.filter((_, idx) => idx !== targetIdx);
      const prevDiscarded: string[] = activeScheme2D.result?.layout?.discardedLeftoverIds || [];
      setSelectedLeftoverId(null);
      return {
        mainPlacements,
        gapPlacements,
        leftovers: nextLeftovers,
        discardedLeftoverIds: Array.from(new Set([...prevDiscarded, leftoverId])),
        notice: `已从预览抛弃计划余料 #${leftoverId}（标脏，可恢复原预览或校验重建刀路）`
      };
    });
  };

  const handleUndoBoardEdit = () => {
    if (!activeScheme2D || activeScheme2D.confirmedSchemeId) return;
    const stack = getHistoryFor(activeScheme2D.id);
    const { stack: nextStack, snapshot } = undoBoardHistory(
      stack,
      captureSchemeSnapshot(activeScheme2D)
    );
    if (!snapshot) return;
    setHistoryFor(activeScheme2D.id, nextStack);
    applySchemeSnapshotToStore(activeScheme2D, snapshot);
    setSelectedPieceIndex(null);
    setSelectedLeftoverId(null);
    toast('已撤销上一步手调');
  };

  const handleRedoBoardEdit = () => {
    if (!activeScheme2D || activeScheme2D.confirmedSchemeId) return;
    const stack = getHistoryFor(activeScheme2D.id);
    const { stack: nextStack, snapshot } = redoBoardHistory(
      stack,
      captureSchemeSnapshot(activeScheme2D)
    );
    if (!snapshot) return;
    setHistoryFor(activeScheme2D.id, nextStack);
    applySchemeSnapshotToStore(activeScheme2D, snapshot);
    setSelectedPieceIndex(null);
    setSelectedLeftoverId(null);
    toast('已重做手调');
  };

  const handleRestoreOriginalPreview = () => {
    if (!activeScheme2D || activeScheme2D.confirmedSchemeId) return;
    const stack = getHistoryFor(activeScheme2D.id);
    const { stack: nextStack, snapshot } = restoreOriginalBoardHistory(
      stack,
      captureSchemeSnapshot(activeScheme2D)
    );
    if (!snapshot) return;
    setHistoryFor(activeScheme2D.id, nextStack);
    applySchemeSnapshotToStore(activeScheme2D, snapshot);
    setSelectedPieceIndex(null);
    setSelectedLeftoverId(null);
    toast('已恢复至初始排料预览');
  };

  const handleValidateAndRebuildLayout = async () => {
    if (!activeScheme2D || activeScheme2D.confirmedSchemeId || validatingLayout) return;
    setValidatingLayout(true);
    try {
      const payload = buildValidateLayoutPayload({
        scheme: activeScheme2D,
        demands: activeDemands2D,
        trimStartMm,
        pieceGapMm,
        defects: windowDefects2D,
        defaultDefectMarginMm: settings.defectMarginMm
      });
      const res: ValidateLayoutResponse = await requestJSON(
        '/api/v2/schemes/validate-layout',
        payload
      );
      const targetId = activeScheme2D.id;
      useStudioStore.setState((st) => ({
        schemes2D: st.schemes2D.map((s) =>
          s.id === targetId ? applyLayoutValidationResult(s, res) : s
        )
      }));
      if (res?.feasible) {
        const cutCount = Array.isArray(res.cuts) ? res.cuts.length : 0;
        const remCount = Array.isArray(res.leftovers) ? res.leftovers.length : 0;
        toast(`校验通过，已重建刀路（${cutCount} 道）与余料（${remCount} 块）`);
      } else {
        const firstErr = res?.errors?.[0] || '手调布局几何校验未通过';
        toast(firstErr, true);
      }
    } catch (err: any) {
      const msg = err?.message || '刀路校验与重建请求失败';
      const targetId = activeScheme2D.id;
      useStudioStore.setState((st) => ({
        schemes2D: st.schemes2D.map((s) =>
          s.id === targetId
            ? { ...s, layoutDirty: true, layoutValidationErrors: [msg] }
            : s
        )
      }));
      toast('校验重建失败：' + msg, true);
    } finally {
      setValidatingLayout(false);
    }
  };

  const activeHistory =
    activeScheme2D && !activeScheme2D.confirmedSchemeId
      ? getHistoryFor(activeScheme2D.id)
      : createEmptyHistoryStack();

  return {
    validatingLayout,
    canUndo: activeHistory.past.length > 0,
    canRedo: activeHistory.future.length > 0,
    canRestoreOriginal: activeHistory.original != null && activeHistory.past.length > 0,
    handleDropStagingPiece,
    handleMovePlacedPiece,
    handleNudgePlacedPiece,
    handleRotatePlacedPiece,
    handleRemovePlacedPiece,
    handleDiscardLeftover,
    handleUndoBoardEdit,
    handleRedoBoardEdit,
    handleRestoreOriginalPreview,
    handleValidateAndRebuildLayout
  };
}
