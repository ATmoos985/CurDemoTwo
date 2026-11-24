import React, { Dispatch, RefObject, SetStateAction, useEffect, useMemo, useState } from 'react';
import { SavedScheme2D, SlittingOrderLine, SlittingSchemeRun } from '../../store/useStudioStore';
import { StartCornerType } from '../../store/studioSettings';
import {
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle,
  BoardContextMenuEvent,
  BoardDemandSpec,
  BoardLeftover,
  BoardPlacedPiece,
  BoardDefect,
  BoardCutLine
} from '../../components/WorkbenchBoardCanvas';
import { toast, fmtN } from '@static/app/js/util.js';
import { SlittingStripBar } from './SlittingStripBar';
import { DefectScheduleRow } from './workbenchTypes';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { ToolpathPlayerBar } from './ToolpathPlayerBar';

export interface WorkbenchCenterPanelProps {
  is2D: boolean;
  stripRef: RefObject<HTMLDivElement | null>;
  boardRef: RefObject<WorkbenchBoardHandle | null>;

  // 2D view
  vertical: boolean;
  onToggleVertical: () => void;
  startCorner: StartCornerType;
  showDimensions: boolean;
  setShowDimensions: Dispatch<SetStateAction<boolean>>;
  showPath: boolean;
  setShowPath: Dispatch<SetStateAction<boolean>>;
  selectedPieceIndex: number | null;
  setSelectedPieceIndex: Dispatch<SetStateAction<number | null>>;
  selectedLeftoverId: string | null;
  setSelectedLeftoverId: Dispatch<SetStateAction<string | null>>;
  cursor: { x: number; y: number } | null;
  setCursor: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  activeScheme2D: SavedScheme2D | null;
  schemes2D: SavedScheme2D[];
  bestUtil2D: number;
  setActiveScheme2D: (id: string) => void;
  removeScheme2D: (id: string) => void;
  clearSchemes2D: () => void;
  effectiveRollTitle: string;
  effectiveRollWidthMm: number;
  effectiveRollLengthMm: number;
  trimStartMm: number;
  pieceGapMm: number;
  windowDefects2D: BoardDefect[];
  boardStagingDemands: BoardDemandSpec[];
  boardPlacedPieces: BoardPlacedPiece[];
  boardLeftovers: BoardLeftover[];
  boardCuts: BoardCutLine[];
  activeHighlightKey: string | null;
  setHoveredDemandKey: (key: string | null) => void;
  canUndo: boolean;
  canRedo: boolean;
  canRestoreOriginal: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreOriginalPreview: () => void;
  onDropStagingPiece: (demandKey: string, localX: number, localY: number) => void;
  onMovePlacedPiece: (pieceIndex: number, localX: number, localY: number) => void;
  onNudgePlacedPiece: (pieceIndex: number, dxMm: number, dyMm: number) => void;
  onRotatePlacedPiece: (pieceIndex: number) => void;
  onRemovePlacedPiece: (pieceIndex: number) => void;
  onDiscardLeftover: (leftoverId: string) => void;
  validatingLayout: boolean;
  onValidateAndRebuildLayout: () => void;

  // 1D view
  slitSchemes: SlittingSchemeRun[];
  activeScheme1D: SlittingSchemeRun | null;
  setActiveSlitScheme: (id: string) => void;
  baselineCars1D: number;
  solveElapsedMs: number;
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitMotherWidthMm: number;
  slitFixedLengthMm: number;
  currentRoll1D: any;
  slitOrders: SlittingOrderLine[];
  totalRolls1D: number;
  defectSchedules1D: DefectScheduleRow[];
  onRunSolve1D: () => void;
  onQuickExportExcel1D: () => void;
}

function fmtElapsed(ms?: number): string {
  const n = Math.max(0, Math.round(ms || 0));
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

export const WorkbenchCenterPanel: React.FC<WorkbenchCenterPanelProps> = ({
  is2D,
  stripRef,
  boardRef,
  vertical,
  onToggleVertical,
  startCorner,
  showDimensions,
  setShowDimensions,
  showPath,
  setShowPath,
  selectedPieceIndex,
  setSelectedPieceIndex,
  selectedLeftoverId,
  setSelectedLeftoverId,
  cursor,
  setCursor,
  activeScheme2D,
  schemes2D,
  bestUtil2D,
  setActiveScheme2D,
  removeScheme2D,
  clearSchemes2D,
  effectiveRollTitle,
  effectiveRollWidthMm,
  effectiveRollLengthMm,
  trimStartMm,
  pieceGapMm,
  windowDefects2D,
  boardStagingDemands,
  boardPlacedPieces,
  boardLeftovers,
  boardCuts,
  activeHighlightKey,
  setHoveredDemandKey,
  canUndo,
  canRedo,
  canRestoreOriginal,
  onUndo,
  onRedo,
  onRestoreOriginalPreview,
  onDropStagingPiece,
  onMovePlacedPiece,
  onNudgePlacedPiece,
  onRotatePlacedPiece,
  onRemovePlacedPiece,
  onDiscardLeftover,
  validatingLayout,
  onValidateAndRebuildLayout,
  slitSchemes,
  activeScheme1D,
  setActiveSlitScheme,
  baselineCars1D,
  solveElapsedMs,
  slitMaterialMode,
  slitMotherWidthMm,
  slitFixedLengthMm,
  currentRoll1D,
  slitOrders,
  totalRolls1D,
  defectSchedules1D,
  onRunSolve1D,
  onQuickExportExcel1D
}) => {
  const [hoveredStripWidth1D, setHoveredStripWidth1D] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuEvent | null>(null);
  const [simCutStep, setSimCutStep] = useState<number | null>(null);

  // 切换方案时自动复位走刀动画与右键菜单
  useEffect(() => {
    setSimCutStep(null);
    setContextMenu(null);
  }, [activeScheme2D?.id]);

  const selectedLeftover = useMemo(
    () =>
      selectedLeftoverId != null
        ? boardLeftovers.find((rm) => String(rm.id) === String(selectedLeftoverId)) || null
        : null,
    [selectedLeftoverId, boardLeftovers]
  );

  const contextPiece = useMemo(
    () =>
      contextMenu?.kind === 'piece' && contextMenu.pieceIndex != null
        ? boardPlacedPieces.find((p) => p.index === contextMenu.pieceIndex) || null
        : null,
    [contextMenu, boardPlacedPieces]
  );

  const contextLeftover = useMemo(
    () =>
      contextMenu?.kind === 'leftover' && contextMenu.leftoverId != null
        ? boardLeftovers.find((rm) => String(rm.id) === String(contextMenu.leftoverId)) || null
        : null,
    [contextMenu, boardLeftovers]
  );

  const widthBounds1D = useMemo(() => {
    const widths: number[] = [];
    for (const p of activeScheme1D?.patterns || []) {
      for (const st of p.stations || []) {
        if (st.widthMm > 0) widths.push(st.widthMm);
      }
    }
    if (!widths.length) return { min: 0, max: 0 };
    return { min: Math.min(...widths), max: Math.max(...widths) };
  }, [activeScheme1D]);

  const highlightedOrder1D = useMemo(() => {
    if (is2D || !activeHighlightKey) return null;
    return slitOrders.find((o) => String(o.id) === activeHighlightKey) || null;
  }, [is2D, activeHighlightKey, slitOrders]);

  const effectiveHighlightWidth1D = highlightedOrder1D
    ? Math.round(highlightedOrder1D.widthMm)
    : hoveredStripWidth1D;

  if (is2D) {
    return (
      <section className="pane studio-center">
        <div className="ctool" role="toolbar" aria-label="画布视图工具">
          <div className="ctool-group" role="group" aria-label="缩放与对齐">
            <button type="button" onClick={() => boardRef.current?.fit()}>
              居中适配
            </button>
            <button
              type="button"
              onClick={() => boardRef.current?.zoom(1 / 1.25)}
              aria-label="缩小"
            >
              −
            </button>
            <button type="button" onClick={() => boardRef.current?.zoom(1.25)} aria-label="放大">
              ＋
            </button>
            <button type="button" onClick={() => boardRef.current?.resetRollOffset()}>
              重置卷位
            </button>
            <button
              type="button"
              aria-pressed={!vertical}
              title="切换纵向走布 / 横向台板视角"
              onClick={onToggleVertical}
            >
              {vertical ? '纵向走布' : '横向台板'}
            </button>
          </div>

          <span className="div" role="separator" aria-orientation="vertical" />

          <div className="ctool-group" role="group" aria-label="手调撤销重做">
            <button
              type="button"
              disabled={!canUndo}
              title="撤销手调 (Ctrl+Z)"
              onClick={onUndo}
            >
              ↶ 撤销
            </button>
            <button
              type="button"
              disabled={!canRedo}
              title="重做手调 (Ctrl+Y / Ctrl+Shift+Z)"
              onClick={onRedo}
            >
              ↷ 重做
            </button>
            {canRestoreOriginal && (
              <button
                type="button"
                title="一键还原到初始求解预览"
                onClick={onRestoreOriginalPreview}
              >
                恢复原预览
              </button>
            )}
          </div>

          <span className="div" role="separator" aria-orientation="vertical" />

          <div className="ctool-group" role="group" aria-label="图层开关">
            <button
              type="button"
              aria-pressed={showDimensions}
              onClick={() => setShowDimensions((s) => !s)}
            >
              标尺尺寸
            </button>
            <button type="button" aria-pressed={showPath} onClick={() => setShowPath((s) => !s)}>
              切割刀路
            </button>
          </div>

          {selectedPieceIndex != null && (
            <>
              <span className="div" role="separator" aria-orientation="vertical" />
              <div className="ctool-group" role="group" aria-label="选中裁片操作">
                <button
                  type="button"
                  className="ctool-piece-act"
                  onClick={() => onRotatePlacedPiece(selectedPieceIndex)}
                >
                  旋转 (R)
                </button>
                <button type="button" onClick={() => onRemovePlacedPiece(selectedPieceIndex)}>
                  退回待排
                </button>
                <span
                  className="ctool-nudge-hint num"
                  title="选中裁片后可用方向键微调 1mm，按住 Shift 微调 0.1mm"
                >
                  ←↑↓→ 微调
                </span>
              </div>
            </>
          )}

          {activeScheme2D?.layoutDirty && !activeScheme2D.confirmedSchemeId && (
            <>
              <span className="div" role="separator" aria-orientation="vertical" />
              <button
                type="button"
                className="ctool-piece-act"
                disabled={validatingLayout}
                onClick={onValidateAndRebuildLayout}
              >
                {validatingLayout ? '校验重建中…' : '校验并重建刀路'}
              </button>
            </>
          )}

          <span className="sp" />

          <span className="num ctool-readout">
            {activeScheme2D
              ? `${activeScheme2D.widthMm}×${fmtN(activeScheme2D.occupiedLengthMm, 1)} mm · ${activeScheme2D.utilizationPct}%`
              : `${effectiveRollWidthMm}×${effectiveRollLengthMm} mm`}
            {cursor ? ` · X ${fmtN(cursor.x, 0)} / Y ${fmtN(cursor.y, 0)}` : ''}
          </span>
        </div>

        {/* 选中计划余料属性条 */}
        {selectedLeftover && (
          <div className="wb-leftover-banner" role="status">
            <span className="num">
              已选计划余料 <b>#{selectedLeftover.id}</b> · {Math.round(selectedLeftover.width)}×
              {Math.round(selectedLeftover.height)} mm（
              {((selectedLeftover.width * selectedLeftover.height) / 1_000_000).toFixed(3)} m²）
              {selectedLeftover.hasDefect ? ' · 含疵点' : ''}
            </span>
            <span className="sp" />
            {!activeScheme2D?.confirmedSchemeId && (
              <button
                type="button"
                className="btn sm"
                onClick={() => onDiscardLeftover(selectedLeftover.id)}
              >
                从预览抛弃此余料
              </button>
            )}
            <button
              type="button"
              className="wb-tiny-ghost"
              onClick={() => setSelectedLeftoverId(null)}
            >
              关闭
            </button>
          </div>
        )}

        <div className="canvas-wrap" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <WorkbenchBoardCanvas
            rollTitle={effectiveRollTitle}
            rollWidthMm={effectiveRollWidthMm}
            rollLengthMm={effectiveRollLengthMm}
            occupiedLengthMm={activeScheme2D?.occupiedLengthMm || 0}
            trimStartMm={trimStartMm}
            pieceGapMm={pieceGapMm}
            defects={windowDefects2D}
            demands={boardStagingDemands}
            placedPieces={boardPlacedPieces}
            leftovers={boardLeftovers}
            cuts={boardCuts}
            selectedLeftoverId={selectedLeftoverId}
            simCutStep={simCutStep}
            startCorner={startCorner}
            vertical={vertical}
            showDimensions={showDimensions}
            showPath={showPath}
            highlightedDemandKey={activeHighlightKey}
            selectedPieceIndex={selectedPieceIndex}
            onDropStagingPiece={onDropStagingPiece}
            onMovePlacedPiece={onMovePlacedPiece}
            onNudgePlacedPiece={onNudgePlacedPiece}
            onRotatePlacedPiece={onRotatePlacedPiece}
            onRemovePlacedPiece={onRemovePlacedPiece}
            onUndo={onUndo}
            onRedo={onRedo}
            onSelectLeftover={setSelectedLeftoverId}
            onHoverDemandKey={setHoveredDemandKey}
            onSelectPiece={setSelectedPieceIndex}
            onCursorMove={setCursor}
            onContextMenu={setContextMenu}
            onCollisionNotice={(msg) => toast(msg, true)}
            boardRef={boardRef}
          />
        </div>

        {/* 走刀动画仿真控制条（仅在当前方案含刀路时呈现） */}
        {boardCuts.length > 0 && (
          <ToolpathPlayerBar
            cuts={boardCuts}
            startCorner={startCorner}
            rollWidthMm={effectiveRollWidthMm}
            rollLengthMm={activeScheme2D?.occupiedLengthMm || effectiveRollLengthMm}
            simCutStep={simCutStep}
            onChangeSimCutStep={(next) => {
              setSimCutStep(next);
              if (next != null && !showPath) setShowPath(true);
            }}
          />
        )}

        {/* 右键上下文快捷操作菜单 */}
        <WorkbenchContextMenu
          menu={contextMenu}
          piece={contextPiece}
          leftover={contextLeftover}
          canUndo={canUndo}
          canRedo={canRedo}
          canRestoreOriginal={canRestoreOriginal}
          showDimensions={showDimensions}
          showPath={showPath}
          onClose={() => setContextMenu(null)}
          onRotatePiece={onRotatePlacedPiece}
          onFocusPiece={(pc) =>
            boardRef.current?.focusRange(
              Math.max(0, pc.y - 120),
              pc.y + pc.height + 120,
              Math.max(0, pc.x - 120),
              pc.x + pc.width + 120
            )
          }
          onRemovePiece={onRemovePlacedPiece}
          onDiscardLeftover={onDiscardLeftover}
          onFocusLeftover={(rm) =>
            boardRef.current?.focusRange(
              Math.max(0, rm.y - 120),
              rm.y + rm.height + 120,
              Math.max(0, rm.x - 120),
              rm.x + rm.width + 120
            )
          }
          onUndo={onUndo}
          onRedo={onRedo}
          onRestoreOriginal={onRestoreOriginalPreview}
          onFitView={() => boardRef.current?.fit()}
          onResetRollOffset={() => boardRef.current?.resetRollOffset()}
          onToggleDimensions={() => setShowDimensions((s) => !s)}
          onTogglePath={() => setShowPath((s) => !s)}
        />

        {/* Minimal Floating Candidate Switcher Pills (only when candidates exist) */}
        {schemes2D.length > 0 && (
          <div ref={stripRef} className="scheme-strip" role="region" aria-label="候选方案切换">
            <div className="scheme-slots">
              {schemes2D.map((s) => {
                const isBest = schemes2D.length > 1 && s.utilizationPct === bestUtil2D;
                const isSelected = activeScheme2D?.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={`scheme-slot ${isSelected ? 'on' : ''}`}
                    onClick={() => setActiveScheme2D(s.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveScheme2D(s.id);
                      }
                    }}
                  >
                    <span className="scheme-slot-name" title={s.strategyName}>
                      {s.strategyName}
                    </span>
                    <span className="scheme-slot-stat num">
                      <b>{s.utilizationPct}%</b> · {fmtN(s.occupiedLengthMm, 0)}mm
                    </span>
                    {isBest && <span className="tag ok">最优</span>}
                    {s.layoutDirty && !s.confirmedSchemeId && <span className="tag warn">待校验</span>}
                    {s.confirmedSchemeId && <span className="tag run">已选定</span>}
                    <button
                      type="button"
                      className="scheme-del"
                      aria-label={`删除候选方案 ${s.strategyName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeScheme2D(s.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <button type="button" className="wb-tiny-ghost" onClick={clearSchemes2D}>
              清空
            </button>
          </div>
        )}
      </section>
    );
  }

  const bestSolved1DId =
    slitSchemes.find((s) => s.state === 'SUCCEEDED' && s.strategyId !== 'BASELINE')?.id || null;

  return (
    /* 1D Slitting Center View */
    <section ref={stripRef as any} className="pane" style={{ background: 'var(--bg)' }}>
      <div className="body" style={{ overflowY: 'auto' }}>
        {slitSchemes.length === 0 ? (
          <div className="box slit-empty-box">
            <div className="slit-empty-meta num">
              <span>
                {slitMaterialMode === 'VIRTUAL_ROLL'
                  ? `W${slitMotherWidthMm}`
                  : `${currentRoll1D?.rollId || '实卷'} · W${
                      currentRoll1D?.width || slitMotherWidthMm
                    }`}
              </span>
              <span className="slit-empty-sep" aria-hidden="true" />
              <span>L{slitFixedLengthMm}</span>
              <span className="slit-empty-sep" aria-hidden="true" />
              <span>
                {slitOrders.length} 规格 · {totalRolls1D} 卷
              </span>
            </div>
            <button type="button" className="btn pri" onClick={onRunSolve1D}>
              开始排版
            </button>
          </div>
        ) : (
          <>
            <div
              className="cards slit-scheme-grid"
              style={{
                gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, slitSchemes.length))}, minmax(0, 1fr))`
              }}
            >
              {slitSchemes.map((s) => {
                const isRunning = s.state === 'RUNNING';
                const isFailed = s.state === 'FAILED' || s.state === 'TIMED_OUT';
                const isSolved = s.state === 'SUCCEEDED';
                const isBaseline = s.strategyId === 'BASELINE';
                const isBest = isSolved && !isBaseline && s.id === bestSolved1DId;
                const savedCars =
                  isSolved && !isBaseline && baselineCars1D > 0
                    ? Math.max(0, baselineCars1D - s.totalCars)
                    : 0;
                const techTitle =
                  s.strategyId === 'FAST'
                    ? '快捷分切方案'
                    : s.strategyId === 'QUALITY'
                    ? '精细分切方案'
                    : '逐规格独立分切基线';

                return (
                  <div
                    key={s.id}
                    className={`card slit-scheme-card ${activeScheme1D?.id === s.id ? 'on' : ''} ${
                      isRunning ? 'is-running' : ''
                    } ${isFailed ? 'is-failed' : ''}`}
                    title={s.errorMessage || techTitle}
                    onClick={() => {
                      if (!isRunning) setActiveSlitScheme(s.id);
                    }}
                  >
                    {isRunning && <span className="slit-progress-line" aria-hidden="true" />}
                    <div className="slit-card-head">
                      <span className="slit-card-name">{s.strategyName}</span>
                      {isBest && <span className="tag ok">最优</span>}
                      <span className="sp" />
                      {isRunning ? (
                        <span className="slit-card-timer num">
                          <i className="wb-status-dot is-running" aria-hidden="true" />
                          {fmtElapsed(solveElapsedMs)}
                        </span>
                      ) : isSolved ? (
                        <span className="slit-card-time num">{fmtElapsed(s.elapsedMs)}</span>
                      ) : (
                        <span className="tag err">失败</span>
                      )}
                    </div>

                    {isRunning ? (
                      <>
                        <div className="slit-skeleton-num" aria-hidden="true" />
                        <div className="slit-skeleton-sub" aria-hidden="true" />
                      </>
                    ) : isFailed ? (
                      <>
                        <b className="num slit-card-main is-muted">—</b>
                        <div className="d slit-card-err">{s.errorMessage || '求解未完成'}</div>
                      </>
                    ) : (
                      <>
                        <div className="slit-card-main-row">
                          <b className="num slit-card-main">
                            {s.totalCars}
                            <em>车</em>
                          </b>
                          {savedCars > 0 && (
                            <span
                              className="slit-save-pill num"
                              title={`较独立分切节省 ${savedCars} 车`}
                            >
                              −{savedCars}车
                            </span>
                          )}
                        </div>
                        <div className="d num slit-card-meta">
                          <span>{s.avgUtilizationPct}%</span>
                          <span>·</span>
                          <span>{s.patterns?.length ?? 0} 组</span>
                          {s.missingRolls > 0 && (
                            <span className="slit-warn-pill is-err">缺 {s.missingRolls}</span>
                          )}
                          {s.overproducedRolls > 0 && (
                            <span className="slit-warn-pill">超 {s.overproducedRolls}</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {activeScheme1D && activeScheme1D.state === 'SUCCEEDED' && (
              <div className="box" style={{ margin: '12px 0 0' }}>
                <div className="pane-h">
                  <span>
                    刀组排布 · {activeScheme1D.patterns.length} 组 · {activeScheme1D.totalCars} 车
                  </span>
                  <span className="sp" />
                  <span className="slit-legend" aria-label="条带图例">
                    <span className="slit-legend-item" title="色阶深浅对应条宽由窄到宽">
                      <i className="slit-swatch-scale" aria-hidden="true" />
                      窄→宽
                    </span>
                    <span className="slit-legend-item">
                      <i className="slit-swatch-trim" aria-hidden="true" />
                      切边
                    </span>
                    <span className="slit-legend-item">
                      <i className="slit-swatch-spare" aria-hidden="true" />
                      余宽
                    </span>
                  </span>
                  <button type="button" className="btn sm" onClick={onQuickExportExcel1D}>
                    导出 Excel
                  </button>
                </div>
                <div className="slit-patterns-list">
                  {activeScheme1D.patterns.map((p, idx) => {
                    const hasOrderHighlight = Boolean(highlightedOrder1D);
                    const hasAlloc = Boolean(p.allocations && p.allocations.length > 0);
                    const matchedAlloc =
                      hasOrderHighlight && hasAlloc
                        ? p.allocations!.find(
                            (a) => String(a.orderId) === String(highlightedOrder1D!.id) && a.quantity > 0
                          )
                        : null;
                    const hasWidthInPattern =
                      effectiveHighlightWidth1D != null &&
                      p.stations.some(
                        (st) => Math.round(st.widthMm) === Math.round(effectiveHighlightWidth1D)
                      );
                    const isRowMatched = hasOrderHighlight
                      ? hasAlloc
                        ? Boolean(matchedAlloc)
                        : hasWidthInPattern
                      : hasWidthInPattern;
                    const isRowDimmed =
                      (hasOrderHighlight || hoveredStripWidth1D != null) && !isRowMatched;

                    return (
                      <div
                        key={p.id}
                        className={`slit-pattern-row${isRowMatched ? ' is-matched' : ''}${
                          isRowDimmed ? ' is-dimmed' : ''
                        }`}
                      >
                        <div className="slit-pattern-meta">
                          <span className="tag kind">组 {idx + 1}</span>
                          <b className="num">{p.repetitions} 车</b>
                          <span className="num">
                            {p.stations
                              .map((s) => `${s.widthMm}×${s.countPerRepetition}`)
                              .join(' + ')}
                          </span>
                          {matchedAlloc && (
                            <span className="slit-alloc-pill num">
                              本单 {matchedAlloc.quantity} 卷
                            </span>
                          )}
                          <span className="sp" />
                          <span className="num muted">
                            已切 {p.usedWidthMm} mm · 余 {p.spareWidthMm} mm
                          </span>
                        </div>
                        <SlittingStripBar
                          motherWidthMm={activeScheme1D.motherWidthMm}
                          leftTrimMm={activeScheme1D.leftTrimMm}
                          rightTrimMm={activeScheme1D.rightTrimMm}
                          stations={p.stations}
                          minWidthMm={widthBounds1D.min}
                          maxWidthMm={widthBounds1D.max}
                          highlightedWidthMm={isRowDimmed ? null : effectiveHighlightWidth1D}
                          dimAll={isRowDimmed}
                          onHoverWidth={setHoveredStripWidth1D}
                        />
                      </div>
                    );
                  })}
                </div>

                {defectSchedules1D.length > 0 && (
                  <div style={{ padding: '0 12px 12px' }}>
                    <div className="sec">实卷避疵车次 ({currentRoll1D?.rollId})</div>
                    <table className="t" style={{ marginTop: 6 }}>
                      <thead>
                        <tr>
                          <th>车次</th>
                          <th className="r">母卷区间 mm</th>
                          <th>排刀组合</th>
                          <th>状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {defectSchedules1D.map((row) => (
                          <tr key={row.carNo}>
                            <td className="num">#{row.carNo}</td>
                            <td className="r num">
                              {fmtN(row.startY)} ~ {fmtN(row.endY)}
                            </td>
                            <td className="num">{row.comp}</td>
                            <td>
                              {row.avoided ? (
                                <span className="tag warn">跳段避疵</span>
                              ) : (
                                <span className="tag ok">连续净区</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
