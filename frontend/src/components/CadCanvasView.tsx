import React, { useEffect, useMemo, useRef } from 'react';
import {
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle,
  BoardCutLine,
  BoardDefect,
  BoardPlacedPiece,
  BoardShapeGeometry,
  BoardZone
} from './WorkbenchBoardCanvas';

export interface CadCanvasViewProps {
  scene: any;
  vertical?: boolean;
  showPath?: boolean;
  showDimensions?: boolean;
  viewMode?: 'station' | 'full' | 'inspection';
  fullMode?: 'strip' | 'tile';
  minHeight?: number;
  ariaLabel?: string;
  tool?: 'pan' | 'measure' | 'defect' | 'move';
  onCursorMove?: (cursor: { u: number; v: number } | null) => void;
  onSelectPiece?: (pieceId: any) => void;
  onContextInspect?: (hit: { entityId?: any; u: number; v: number }) => void;
  onInteract?: () => void;
  onDefectSelect?: (id: string) => void;
  onDefectDraw?: (box: { u: number; v: number; du: number; dv: number }) => void;
  onDefectEdit?: (id: string, box: { u: number; v: number; du: number; dv: number }) => void;
  canvasRefOut?: React.MutableRefObject<any>;
}

function normalizeShape(raw: any): BoardShapeGeometry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.type === 'POLYGON' && Array.isArray(raw.vertices) && raw.vertices.length >= 3) {
    return {
      type: 'POLYGON',
      width: Number(raw.width || 0),
      height: Number(raw.height || 0),
      vertices: raw.vertices.map((pt: any) => ({
        x: Number(pt.x ?? pt.v ?? 0),
        y: Number(pt.y ?? pt.u ?? 0)
      }))
    };
  }
  return undefined;
}

interface AdaptedScene {
  rollTitle: string;
  rollWidthMm: number;
  rollLengthMm: number;
  occupiedLengthMm: number;
  rollShape: BoardShapeGeometry | null;
  placedPieces: BoardPlacedPiece[];
  cuts: BoardCutLine[];
  defects: BoardDefect[];
  zones: BoardZone[];
  feedPositionMm: number | null;
  selectedDefectId: string | null;
}

function adaptRollScene(scene: any, viewMode: string): AdaptedScene {
  if (!scene || !scene.roll) {
    return {
      rollTitle: '母卷画布',
      rollWidthMm: 1500,
      rollLengthMm: 3000,
      occupiedLengthMm: 0,
      rollShape: null,
      placedPieces: [],
      cuts: [],
      defects: [],
      zones: [],
      feedPositionMm: null,
      selectedDefectId: null
    };
  }

  const roll = scene.roll;
  const rollWidthMm = Math.max(10, Number(roll.width || 1500));
  const rollLengthMm = Math.max(10, Number(roll.total || 3000));
  const rollTitle = roll.id ? String(roll.id) : '排料母卷';
  const rollShape = normalizeShape(roll.shape) || null;

  const segments: any[] = Array.isArray(scene.segments) ? scene.segments : [];
  const placedPieces: BoardPlacedPiece[] = [];
  const cuts: BoardCutLine[] = [];
  const zones: BoardZone[] = [];

  let pieceIdx = 0;
  let hasCutSegment = false;
  let maxOccupied = 0;

  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    const segStart = Number(seg?.start || 0);
    const segLen = Number(seg?.len || 0);
    const segStatus = String(seg?.status || '');
    const segPieces: any[] = Array.isArray(seg?.pieces) ? seg.pieces : [];
    const segCuts: any[] = Array.isArray(seg?.cuts) ? seg.cuts : [];

    if (segStatus === 'cut') {
      hasCutSegment = true;
      if (segLen > 0) {
        zones.push({
          id: seg.id ? `cut-${seg.id}` : `cut-${sIdx}`,
          startY: segStart,
          lengthMm: segLen,
          kind: 'cut',
          label: seg.label ? `已切 · ${seg.label}` : '已切割区域'
        });
      }
    } else if (
      segLen > 0 &&
      (segStatus === 'pending' || segStatus === 'stale') &&
      (segments.length > 1 || segPieces.length === 0 || segStart > 0)
    ) {
      zones.push({
        id: seg.id ? `plan-${seg.id}` : `plan-${sIdx}`,
        startY: segStart,
        lengthMm: segLen,
        kind: 'planned',
        label: seg.label ? `预占 · ${seg.label}` : '排程预占'
      });
    }

    for (const p of segPieces) {
      const x = Number(p.v ?? p.x ?? 0);
      const y = Number(p.u ?? p.y ?? 0);
      const w = Math.max(0.5, Number(p.dv ?? p.w ?? p.width ?? 10));
      const h = Math.max(0.5, Number(p.du ?? p.l ?? p.height ?? 10));
      const demandId = Number.isFinite(Number(p.demandId)) ? Number(p.demandId) : undefined;
      const isGapFill = Boolean(
        p.gapFill ||
          p.dash ||
          (typeof p.label === 'string' && p.label.startsWith('补'))
      );
      placedPieces.push({
        id: p.id ?? `pc-${pieceIdx}`,
        index: pieceIdx,
        demandId,
        demandKey: demandId != null ? `d-${demandId}` : `p-${pieceIdx}`,
        name: String(p.label || p.title || p.name || `#${pieceIdx + 1}`),
        x,
        y,
        width: w,
        height: h,
        gapFill: isGapFill,
        shape: normalizeShape(p.shape)
      });
      maxOccupied = Math.max(maxOccupied, y + h);
      pieceIdx++;
    }

    for (let cIdx = 0; cIdx < segCuts.length; cIdx++) {
      const c = segCuts[cIdx];
      cuts.push({
        sequence: c.step ?? cIdx + 1,
        kind: c.type,
        startX: Number(c.v1 ?? 0),
        startY: Number(c.u1 ?? 0),
        endX: Number(c.v2 ?? 0),
        endY: Number(c.u2 ?? 0)
      });
    }
  }

  // If roll has historical used length not covered by explicit cut segments, show a subtle used band
  const usedLen = Number(roll.used || 0);
  if (usedLen > 0 && !hasCutSegment) {
    zones.push({
      id: 'roll-used-band',
      startY: 0,
      lengthMm: Math.min(usedLen, rollLengthMm),
      kind: 'used',
      label: `已使用 ${(usedLen / 1000).toFixed(2)} m`
    });
  }

  // Optional inspection window highlight
  if (scene.window && Number(scene.window.len || 0) > 0 && viewMode === 'station') {
    zones.push({
      id: 'station-window',
      startY: Number(scene.window.start || 0),
      lengthMm: Number(scene.window.len || 0),
      kind: 'window'
    });
  }

  const defects: BoardDefect[] = (Array.isArray(scene.defects) ? scene.defects : []).map(
    (d: any, idx: number) => ({
      id: d.id != null ? String(d.id) : `def-${idx}`,
      x: Number(d.v ?? d.x ?? 0),
      y: Number(d.u ?? d.y ?? 0),
      w: Math.max(0.5, Number(d.dv ?? d.w ?? 10)),
      h: Math.max(0.5, Number(d.du ?? d.h ?? 10)),
      margin: Number(d.margin ?? 0),
      label: d.label ? String(d.label) : '疵点',
      editable: Boolean(d.editable),
      fresh: Boolean(d.fresh)
    })
  );

  // Occupied line only when showing a nesting layout with pieces and spare tail length
  let occupiedLengthMm = 0;
  if (segments.length === 1 && placedPieces.length > 0) {
    const segEnd = Number(segments[0]?.start || 0) + Number(segments[0]?.len || 0);
    const candidate = segEnd > 0 ? segEnd : maxOccupied;
    if (candidate > 0 && candidate < rollLengthMm - 1) {
      occupiedLengthMm = candidate;
    }
  }

  const feedPositionMm =
    scene.feed && Number.isFinite(Number(scene.feed.u)) ? Number(scene.feed.u) : null;
  const selectedDefectId =
    scene.selectedDefect != null ? String(scene.selectedDefect) : null;

  return {
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    rollShape,
    placedPieces,
    cuts,
    defects,
    zones,
    feedPositionMm,
    selectedDefectId
  };
}

export const CadCanvasView: React.FC<CadCanvasViewProps> = ({
  scene,
  vertical = true,
  showPath = false,
  showDimensions = true,
  viewMode = 'station',
  minHeight = 360,
  ariaLabel = '二维排料 CAD 画布',
  tool = 'pan',
  onCursorMove,
  onSelectPiece,
  onContextInspect,
  onInteract,
  onDefectSelect,
  onDefectDraw,
  onDefectEdit,
  canvasRefOut
}) => {
  const boardRef = useRef<WorkbenchBoardHandle | null>(null);
  const adapted = useMemo(() => adaptRollScene(scene, viewMode), [scene, viewMode]);
  const adaptedRef = useRef(adapted);
  adaptedRef.current = adapted;
  const prevViewModeRef = useRef(viewMode);

  // Expose backward-compatible imperative handle for existing callers
  useEffect(() => {
    if (!canvasRefOut) return;
    canvasRefOut.current = {
      fit: () => boardRef.current?.fit(),
      zoom: (factor: number) => boardRef.current?.zoom(factor),
      resetRollOffset: () => boardRef.current?.resetRollOffset(),
      fitBounds: (bounds: { u0: number; u1: number; v0?: number; v1?: number }) => {
        if (!bounds) return;
        boardRef.current?.focusRange(bounds.u0, bounds.u1, bounds.v0, bounds.v1);
      },
      focusRange: (startY: number, endY: number, startX?: number, endX?: number) => {
        boardRef.current?.focusRange(startY, endY, startX, endX);
      },
      followPosition: (yMm: number) => {
        boardRef.current?.followPosition(yMm);
      },
      clearMeasure: () => boardRef.current?.clearMeasure(),
      setOptions: () => {},
      setScene: () => {},
      destroy: () => {}
    };
    return () => {
      if (canvasRefOut) canvasRefOut.current = null;
    };
  }, [canvasRefOut]);

  // Smoothly follow feed line in inspection mode, or refit when switching back to full view
  useEffect(() => {
    const prevMode = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;
    if (viewMode === 'inspection' && adapted.feedPositionMm != null) {
      boardRef.current?.followPosition(adapted.feedPositionMm);
    } else if (prevMode !== viewMode) {
      boardRef.current?.fit();
    }
  }, [viewMode, adapted.feedPositionMm]);

  if (!scene || !scene.roll) {
    return (
      <div
        className="react-cad-host wb-board-stage"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          minHeight: `${minHeight}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#71717a',
          fontSize: 12.5
        }}
        aria-label={ariaLabel}
      >
        暂无排料几何图形，请先选择对象或运行排料计算
      </div>
    );
  }

  return (
    <div
      className="react-cad-host"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: `${minHeight}px`
      }}
    >
      <WorkbenchBoardCanvas
        rollTitle={adapted.rollTitle}
        rollWidthMm={adapted.rollWidthMm}
        rollLengthMm={adapted.rollLengthMm}
        occupiedLengthMm={adapted.occupiedLengthMm}
        trimStartMm={0}
        pieceGapMm={0}
        defects={adapted.defects}
        demands={[]}
        placedPieces={adapted.placedPieces}
        cuts={adapted.cuts}
        zones={adapted.zones}
        rollShape={adapted.rollShape}
        feedPositionMm={adapted.feedPositionMm}
        selectedDefectId={adapted.selectedDefectId}
        showStaging={false}
        interactivePieces={false}
        vertical={vertical}
        tool={tool}
        showDimensions={showDimensions}
        showPath={showPath}
        highlightedDemandKey={null}
        selectedPieceIndex={null}
        ariaLabel={ariaLabel}
        onSelectPiece={
          onSelectPiece
            ? (idx) => {
                if (idx == null) {
                  onSelectPiece(null);
                  return;
                }
                const pc = adaptedRef.current.placedPieces[idx];
                onSelectPiece(pc ? pc.id : null);
              }
            : undefined
        }
        onCursorMove={
          onCursorMove
            ? (pt) => {
                onCursorMove(pt ? { u: pt.y, v: pt.x } : null);
              }
            : undefined
        }
        onContextInspect={
          onContextInspect
            ? (hit) => {
                if (!hit) return;
                onContextInspect({
                  entityId: hit.entityId,
                  u: hit.y,
                  v: hit.x
                });
              }
            : undefined
        }
        onInteract={onInteract}
        onDefectSelect={onDefectSelect}
        onDefectDraw={onDefectDraw}
        onDefectEdit={onDefectEdit}
        boardRef={boardRef}
      />
    </div>
  );
};
