import React, { useEffect, useMemo, useRef, useState } from 'react';
import { validateRollPlacement as validateRollPlacementPure } from '../pages/workbench/boardPlacementValidation';
import type {
  BoardContextMenuEvent,
  BoardCutLine,
  BoardDefect,
  BoardDemandSpec,
  BoardLeftover,
  BoardPlacedPiece,
  BoardPoint,
  BoardShapeGeometry,
  BoardZone,
  WorkbenchBoardCanvasProps,
  WorkbenchBoardHandle
} from './canvas/canvasTypes';
import type { CameraState } from './canvas/canvasGeometry';
import {
  isDocumentDarkTheme,
  syncPieceHighlightState,
  type BoardCanvasLiveProps,
  type BoardCanvasRefs,
  type CulledPieceEntry,
  type DragFeedbackState,
  type HatchCache,
  type PieceNodeMapEntry,
  type ValidateRollPlacementFn
} from './canvas/canvasKonvaHelpers';
import { renderOverlay, updateFeedLineVisual } from './canvas/canvasDynamicOverlay';
import { createCameraController } from './canvas/canvasCamera';
import { mountWorkbenchStage } from './canvas/canvasStageMount';
import { attachWorkbenchKeyboard } from './canvas/canvasKeyboard';
import { renderBaseLayer } from './canvas/canvasBaseLayer';
import { renderPiecesLayer } from './canvas/canvasPiecesLayer';
import { renderToolpathLayer } from './canvas/canvasToolpathLayer';

export type {
  BoardPoint,
  BoardShapeGeometry,
  BoardDemandSpec,
  BoardPlacedPiece,
  BoardLeftover,
  BoardDefect,
  BoardZone,
  BoardCutLine,
  BoardContextMenuEvent,
  WorkbenchBoardHandle,
  WorkbenchBoardCanvasProps
};

export const WorkbenchBoardCanvas: React.FC<WorkbenchBoardCanvasProps> = ({
  rollTitle,
  rollWidthMm,
  rollLengthMm,
  occupiedLengthMm,
  trimStartMm,
  pieceGapMm,
  defects,
  demands,
  placedPieces,
  leftovers = [],
  cuts = [],
  zones = [],
  rollShape = null,
  feedPositionMm = null,
  selectedDefectId = null,
  selectedLeftoverId = null,
  simCutStep = null,
  startCorner = 'left-top',
  showStaging = true,
  interactivePieces = true,
  vertical = true,
  tool = 'pan',
  showDimensions,
  showPath,
  highlightedDemandKey,
  selectedPieceIndex,
  ariaLabel = '二维交互排料工作台画布',
  onDropStagingPiece,
  onMovePlacedPiece,
  onNudgePlacedPiece,
  onRotatePlacedPiece,
  onRemovePlacedPiece,
  onUndo,
  onRedo,
  onSelectLeftover,
  onHoverDemandKey,
  onSelectPiece,
  onCursorMove,
  onCollisionNotice,
  onInteract,
  onContextInspect,
  onContextMenu,
  onDefectSelect,
  onDefectDraw,
  onDefectEdit,
  boardRef
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rulerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragFeedback, setDragFeedback] = useState<DragFeedbackState | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [darkTheme, setDarkTheme] = useState<boolean>(() => isDocumentDarkTheme());

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDarkTheme(root.dataset.theme === 'dark');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const stageRef = useRef<any>(null);
  const baseLayerRef = useRef<any>(null);
  const piecesLayerRef = useRef<any>(null);
  const toolpathLayerRef = useRef<any>(null);
  const dynamicLayerRef = useRef<any>(null);

  const worldGroupsRef = useRef<any[]>([]);
  const rollGroupsRef = useRef<any[]>([]);
  const stagingGroupRef = useRef<any>(null);
  const baseRollGroupRef = useRef<any>(null);
  const piecesRollGroupRef = useRef<any>(null);
  const toolpathRollGroupRef = useRef<any>(null);
  const dynamicRollGroupRef = useRef<any>(null);

  const feedNodesRef = useRef<{
    group: any;
    line: any;
    tagBg: any;
    tagText: any;
  } | null>(null);
  const overlayGroupRef = useRef<any>(null);

  const baseScaleNodesRef = useRef<(() => void)[]>([]);
  const piecesScaleNodesRef = useRef<(() => void)[]>([]);
  const toolpathScaleNodesRef = useRef<(() => void)[]>([]);
  const culledPiecesRef = useRef<CulledPieceEntry[]>([]);

  const lastBaseSigRef = useRef<string>('');
  const lastPiecesSigRef = useRef<string>('');

  const camRef = useRef<CameraState>({
    x: 40,
    y: 40,
    scale: 0.25,
    fitScale: 0.25
  });
  const rollOffsetRef = useRef<BoardPoint>({ x: 0, y: 0 });
  const cursorLocalRef = useRef<BoardPoint | null>(null);
  const stagingOffsetsRef = useRef<Map<string, BoardPoint>>(new Map());
  const stagingBoundsRef = useRef<{ x: number; y: number; width: number; height: number }>({
    x: 0,
    y: 0,
    width: 1500,
    height: 3000
  });
  const didInitialFitRef = useRef<boolean>(false);
  const lastFitSigRef = useRef<string>('');
  const rafCamIdRef = useRef<number | null>(null);
  const rafRulerIdRef = useRef<number | null>(null);
  const hatchCacheRef = useRef<HatchCache>({});
  const measureLineRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);
  const defectDraftRef = useRef<{ p1: BoardPoint; p2: BoardPoint } | null>(null);
  const pieceNodeMapRef = useRef<PieceNodeMapEntry[]>([]);

  const refs: BoardCanvasRefs = {
    hostRef,
    rulerCanvasRef,
    stageRef,
    baseLayerRef,
    piecesLayerRef,
    toolpathLayerRef,
    dynamicLayerRef,
    worldGroupsRef,
    rollGroupsRef,
    stagingGroupRef,
    baseRollGroupRef,
    piecesRollGroupRef,
    toolpathRollGroupRef,
    dynamicRollGroupRef,
    feedNodesRef,
    overlayGroupRef,
    baseScaleNodesRef,
    piecesScaleNodesRef,
    toolpathScaleNodesRef,
    culledPiecesRef,
    lastBaseSigRef,
    lastPiecesSigRef,
    camRef,
    rollOffsetRef,
    cursorLocalRef,
    stagingOffsetsRef,
    stagingBoundsRef,
    didInitialFitRef,
    lastFitSigRef,
    rafCamIdRef,
    rafRulerIdRef,
    hatchCacheRef,
    measureLineRef,
    defectDraftRef,
    pieceNodeMapRef
  };

  const liveProps: BoardCanvasLiveProps = {
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    pieceGapMm,
    defects,
    demands,
    placedPieces,
    leftovers,
    cuts,
    zones,
    rollShape,
    feedPositionMm,
    selectedDefectId,
    selectedLeftoverId,
    simCutStep,
    startCorner,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    showDimensions,
    showPath,
    highlightedDemandKey,
    selectedPieceIndex,
    darkTheme,
    onDropStagingPiece,
    onMovePlacedPiece,
    onNudgePlacedPiece,
    onRotatePlacedPiece,
    onRemovePlacedPiece,
    onUndo,
    onRedo,
    onSelectLeftover,
    onHoverDemandKey,
    onSelectPiece,
    onCursorMove,
    onCollisionNotice,
    onInteract,
    onContextInspect,
    onContextMenu,
    onDefectSelect,
    onDefectDraw,
    onDefectEdit
  };

  const propsRef = useRef<BoardCanvasLiveProps>(liveProps);
  propsRef.current = liveProps;

  const cam = useMemo(() => createCameraController(refs, propsRef, setZoomPct), []);

  const validateRollPlacement: ValidateRollPlacementFn = (
    shape,
    w,
    h,
    localX,
    localY,
    ignorePieceIndex
  ) => {
    const p = propsRef.current;
    return validateRollPlacementPure({
      shape,
      w,
      h,
      localX,
      localY,
      ignorePieceIndex,
      rollWidthMm: p.rollWidthMm,
      rollLengthMm: p.rollLengthMm,
      trimStartMm: p.trimStartMm,
      pieceGapMm: p.pieceGapMm,
      defects: p.defects,
      placedPieces: p.placedPieces
    });
  };

  useEffect(() => {
    if (!boardRef) return;
    boardRef.current = {
      fit: cam.fitView,
      zoom: (f: number) => cam.zoomBy(f),
      resetRollOffset: cam.resetRollOffset,
      focusRange: cam.focusRange,
      followPosition: cam.followPosition,
      clearMeasure: cam.clearMeasure
    };
    return () => {
      if (boardRef) boardRef.current = null;
    };
  }, [boardRef, cam]);

  // 1. 仅挂载一次 Konva Stage 与四层 Layer
  useEffect(() => mountWorkbenchStage(refs, propsRef, cam), [cam]);

  // 同步工具光标与整卷拖动手柄开关
  useEffect(() => {
    const rollGroup = baseRollGroupRef.current;
    const host = hostRef.current;
    if (rollGroup) {
      rollGroup.draggable(tool === 'pan');
    }
    if (host) {
      host.style.cursor = tool === 'defect' || tool === 'measure' ? 'crosshair' : '';
    }
    if (tool !== 'measure' && measureLineRef.current) {
      measureLineRef.current = null;
      renderOverlay(refs, propsRef);
    }
  }, [tool]);

  // 键盘快捷键
  useEffect(() => attachWorkbenchKeyboard(propsRef), []);

  // LAYER 1: 静态材料底图 + 左侧待排区
  useEffect(() => {
    renderBaseLayer({ refs, propsRef, cam, validateRollPlacement, setDragFeedback });
  }, [
    rollTitle,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    trimStartMm,
    demands,
    zones,
    rollShape,
    showStaging,
    interactivePieces,
    vertical,
    tool,
    darkTheme
  ]);

  // LAYER 2: 裁片 + 疵点 Layer
  useEffect(() => {
    renderPiecesLayer({ refs, propsRef, cam, validateRollPlacement, setDragFeedback });
  }, [
    placedPieces,
    defects,
    selectedDefectId,
    interactivePieces,
    vertical,
    tool,
    rollWidthMm,
    rollLengthMm,
    trimStartMm,
    pieceGapMm,
    onDefectSelect,
    onDefectEdit
  ]);

  // LAYER 3: 料头与刀路 Layer
  useEffect(() => {
    renderToolpathLayer(refs, propsRef, cam);
  }, [
    leftovers,
    selectedLeftoverId,
    cuts,
    showPath,
    simCutStep,
    startCorner,
    rollWidthMm,
    rollLengthMm,
    occupiedLengthMm,
    vertical
  ]);

  // LAYER 4: 10Hz 验布线原地更新
  useEffect(() => {
    updateFeedLineVisual(refs, propsRef, true);
  }, [feedPositionMm, rollWidthMm, rollLengthMm, vertical]);

  // 尺寸标尺开关或暗色主题切换时重绘屏幕固定标尺
  useEffect(() => {
    cam.drawRulersNow();
  }, [showDimensions, darkTheme, vertical, rollWidthMm, rollLengthMm, cam]);

  // 轻量级高亮与选中视觉切换
  useEffect(() => {
    syncPieceHighlightState(refs, selectedPieceIndex, highlightedDemandKey);
  }, [highlightedDemandKey, selectedPieceIndex, placedPieces, demands]);

  return (
    <div className="wb-board-stage" aria-label={ariaLabel}>
      <div ref={hostRef} className="wb-board-konva-host" tabIndex={0} />
      <canvas
        ref={rulerCanvasRef}
        className="wb-board-ruler-canvas"
        aria-hidden="true"
      />
      {dragFeedback && (
        <div className={`wb-board-feedback is-${dragFeedback.tone}`} role="status">
          {dragFeedback.text}
        </div>
      )}
      <div className="wb-board-zoom-pill num" aria-hidden="true">
        {zoomPct}%
      </div>
    </div>
  );
};
