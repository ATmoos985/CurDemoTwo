import { Dispatch, SetStateAction } from 'react';
import {
  useStudioStore,
  DemandItem,
  SavedScheme2D,
  Scenario2DType,
  ShapeGeometry
} from '../../store/useStudioStore';
import { StudioSettings } from '../../store/studioSettings';
import { BoardDefect } from '../../components/WorkbenchBoardCanvas';
import { buildSafeNestingRequest2D } from '@static/js/business/optimization/nesting-request-adapter.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { toast } from '@static/app/js/util.js';
import { LastConfirmSummary, STRATEGIES_2D } from './workbenchTypes';
import { rotateShapeGeometry } from './workbenchUtils';

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
  pieceGapMm: number;
  trimStartMm: number;
  windowDefects2D: BoardDefect[];
  settings: StudioSettings;
  removeScheme2D: (id: string) => void;
  setSelectedPieceIndex: Dispatch<SetStateAction<number | null>>;
  setLastConfirmSummary: Dispatch<SetStateAction<LastConfirmSummary | null>>;
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
    pieceGapMm,
    trimStartMm,
    windowDefects2D,
    settings,
    removeScheme2D,
    setSelectedPieceIndex,
    setLastConfirmSummary
  } = opts;

  const commitBoardPlacements = (
    mutate: (mainPlacements: any[], gapPlacements: any[]) => {
      mainPlacements: any[];
      gapPlacements: any[];
      notice?: string;
    } | null
  ) => {
    const existingEditable =
      activeScheme2D && !activeScheme2D.confirmedSchemeId ? activeScheme2D : null;
    const baseMain = existingEditable
      ? structuredClone(existingEditable.result?.layout?.placements || [])
      : [];
    const baseGap = existingEditable
      ? structuredClone(existingEditable.result?.marker?.gapFillPlacements || [])
      : [];

    const mutated = mutate(baseMain, baseGap);
    if (!mutated) return;

    const { mainPlacements, gapPlacements, notice } = mutated;
    const allPieces = [...mainPlacements, ...gapPlacements];

    // If manual board becomes completely empty, remove the empty manual scheme cleanly
    if (allPieces.length === 0 && existingEditable?.strategyId === 'MANUAL_BOARD') {
      removeScheme2D(existingEditable.id);
      setSelectedPieceIndex(null);
      if (notice) toast(notice);
      return;
    }

    const effW = existingEditable ? existingEditable.widthMm : effectiveRollWidthMm;
    const effL = existingEditable ? existingEditable.canvasLengthMm : effectiveRollLengthMm;
    const startOffset =
      existingEditable?.windowStartY ??
      (canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.usedLength || 0 : 0);

    const occupiedLengthMm = allPieces.length
      ? Math.round(
          Math.max(...allPieces.map((p: any) => (Number(p.y) || 0) + (p.shape?.height || 0))) * 10
        ) / 10
      : 0;
    const netAreaMm2 = allPieces.reduce((s: number, p: any) => s + shapeArea(p.shape), 0);
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
    for (const p of mainPlacements) {
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
          leftovers: [],
          contours: []
        }),
        placements: mainPlacements,
        cuts: []
      },
      marker: {
        ...(existingEditable?.result?.marker || {}),
        occupiedLengthMm,
        gapFillPlacements: gapPlacements
      }
    };

    const isManualNew = !existingEditable;
    const schemeId = existingEditable
      ? existingEditable.id
      : `MANUAL-BOARD-${Date.now().toString(36).slice(-5)}`;
    const nextStrategyName = existingEditable
      ? existingEditable.strategyId === 'MANUAL_BOARD'
        ? '手工排布'
        : existingEditable.strategyName.endsWith(' · 手调')
        ? existingEditable.strategyName
        : `${existingEditable.strategyName} · 手调`
      : '手工排布';

    const nextScheme: SavedScheme2D = {
      id: schemeId,
      title: `${nextStrategyName} (${effW}×${Math.round(occupiedLengthMm)}mm)`,
      strategyId: existingEditable ? existingEditable.strategyId : 'MANUAL_BOARD',
      strategyName: nextStrategyName,
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
      gapFillCount: gapPlacements.length,
      complete,
      demands: structuredClone(activeOpenDemands.length > 0 ? activeOpenDemands : activeDemands2D),
      request: baseReq,
      result: nextResult
    };

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

  const handleRotatePlacedPiece = (pieceIndex: number) => {
    commitBoardPlacements((mainPlacements, gapPlacements) => {
      const isMain = pieceIndex < mainPlacements.length;
      const target = isMain
        ? mainPlacements[pieceIndex]
        : gapPlacements[pieceIndex - mainPlacements.length];
      if (!target) return null;

      const curShape: ShapeGeometry | undefined = target.shape;
      const curW = Number(curShape?.width ?? target.w) || 0;
      const curH = Number(curShape?.height ?? target.l) || 0;
      const demand = activeDemands2D.find((d) => d.id === target.demandId);
      const isPoly = curShape?.type === 'POLYGON';
      const stepDeg: 90 | 180 = isPoly && !demand?.allowRotation ? 180 : 90;

      const rotatedShape = rotateShapeGeometry(curShape, curW, curH, stepDeg);
      if (rotatedShape.width > effectiveRollWidthMm + 0.5) {
        toast(
          `旋转后宽度 ${Math.round(rotatedShape.width)}mm 超过母卷门幅 ${effectiveRollWidthMm}mm`,
          true
        );
        return null;
      }
      if (rotatedShape.height > effectiveRollLengthMm - trimStartMm + 0.5) {
        toast(
          `旋转后长度 ${Math.round(rotatedShape.height)}mm 超过当前母卷可用版长`,
          true
        );
        return null;
      }

      const cx = (Number(target.x) || 0) + curW / 2;
      const cy = (Number(target.y) || 0) + curH / 2;
      const nextX = Math.max(
        0,
        Math.min(
          effectiveRollWidthMm - rotatedShape.width,
          Math.round((cx - rotatedShape.width / 2) * 10) / 10
        )
      );
      const nextY = Math.max(
        trimStartMm,
        Math.min(
          effectiveRollLengthMm - rotatedShape.height,
          Math.round((cy - rotatedShape.height / 2) * 10) / 10
        )
      );

      const updated = {
        ...target,
        x: nextX,
        y: nextY,
        rotationDegrees: ((Number(target.rotationDegrees) || 0) + stepDeg) % 360,
        shape: rotatedShape
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

  return {
    handleDropStagingPiece,
    handleMovePlacedPiece,
    handleRotatePlacedPiece,
    handleRemovePlacedPiece
  };
}
