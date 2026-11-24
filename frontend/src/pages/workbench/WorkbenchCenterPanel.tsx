import React, { Dispatch, RefObject, SetStateAction } from 'react';
import { SavedScheme2D, SlittingOrderLine, SlittingSchemeRun } from '../../store/useStudioStore';
import {
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle,
  BoardDemandSpec,
  BoardPlacedPiece,
  BoardDefect,
  BoardCutLine
} from '../../components/WorkbenchBoardCanvas';
import { toast, fmtN } from '@static/app/js/util.js';
import { SlittingStripBar } from './SlittingStripBar';
import { DefectScheduleRow } from './workbenchTypes';

export interface WorkbenchCenterPanelProps {
  is2D: boolean;
  stripRef: RefObject<HTMLDivElement | null>;
  boardRef: RefObject<WorkbenchBoardHandle | null>;

  // 2D view
  showDimensions: boolean;
  setShowDimensions: Dispatch<SetStateAction<boolean>>;
  showPath: boolean;
  setShowPath: Dispatch<SetStateAction<boolean>>;
  selectedPieceIndex: number | null;
  setSelectedPieceIndex: Dispatch<SetStateAction<number | null>>;
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
  boardCuts: BoardCutLine[];
  activeHighlightKey: string | null;
  setHoveredDemandKey: (key: string | null) => void;
  onDropStagingPiece: (demandKey: string, localX: number, localY: number) => void;
  onMovePlacedPiece: (pieceIndex: number, localX: number, localY: number) => void;
  onRotatePlacedPiece: (pieceIndex: number) => void;
  onRemovePlacedPiece: (pieceIndex: number) => void;

  // 1D view
  slitSchemes: SlittingSchemeRun[];
  activeScheme1D: SlittingSchemeRun | null;
  setActiveSlitScheme: (id: string) => void;
  savedCars1D: number;
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

export const WorkbenchCenterPanel: React.FC<WorkbenchCenterPanelProps> = ({
  is2D,
  stripRef,
  boardRef,
  showDimensions,
  setShowDimensions,
  showPath,
  setShowPath,
  selectedPieceIndex,
  setSelectedPieceIndex,
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
  boardCuts,
  activeHighlightKey,
  setHoveredDemandKey,
  onDropStagingPiece,
  onMovePlacedPiece,
  onRotatePlacedPiece,
  onRemovePlacedPiece,
  slitSchemes,
  activeScheme1D,
  setActiveSlitScheme,
  savedCars1D,
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
          </div>

          <span className="div" role="separator" aria-orientation="vertical" />

          <div className="ctool-group" role="group" aria-label="图层开关">
            <button
              type="button"
              aria-pressed={showDimensions}
              onClick={() => setShowDimensions((s) => !s)}
            >
              尺寸标注
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
              </div>
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
            cuts={boardCuts}
            showDimensions={showDimensions}
            showPath={showPath}
            highlightedDemandKey={activeHighlightKey}
            selectedPieceIndex={selectedPieceIndex}
            onDropStagingPiece={onDropStagingPiece}
            onMovePlacedPiece={onMovePlacedPiece}
            onRotatePlacedPiece={onRotatePlacedPiece}
            onRemovePlacedPiece={onRemovePlacedPiece}
            onHoverDemandKey={setHoveredDemandKey}
            onSelectPiece={setSelectedPieceIndex}
            onCursorMove={setCursor}
            onCollisionNotice={(msg) => toast(msg, true)}
            boardRef={boardRef}
          />
        </div>

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

  return (
    /* 1D Slitting Center View */
    <section ref={stripRef as any} className="pane" style={{ background: 'var(--bg)' }}>
      <div className="body" style={{ overflowY: 'auto' }}>
        {slitSchemes.length === 0 ? (
          <div className="box" style={{ padding: 36, textAlign: 'center' }}>
            <strong style={{ fontSize: 15 }}>一维定长分切</strong>
            <p className="muted num" style={{ maxWidth: 460, margin: '8px auto 16px', fontSize: 12.5 }}>
              {slitMaterialMode === 'VIRTUAL_ROLL'
                ? `新母卷 ${slitMotherWidthMm} mm`
                : `实卷 ${currentRoll1D?.rollId || ''} (${
                    currentRoll1D?.width || slitMotherWidthMm
                  } mm)`}{' '}
              · 定长 {slitFixedLengthMm} mm · 待排 {slitOrders.length} 项共 {totalRolls1D} 卷
            </p>
            <button type="button" className="btn pri" onClick={onRunSolve1D}>
              开始排版
            </button>
          </div>
        ) : (
          <>
            {savedCars1D > 0 && (
              <div className="roi-banner num">
                <span className="tag ok">省车收益</span>
                <span>
                  较逐规格独立分切减少 <b>{savedCars1D} 车</b> 上机排刀
                </span>
              </div>
            )}

            <div className="cards" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
              {slitSchemes.map((s) => (
                <div
                  key={s.id}
                  className={`card slit-scheme-card ${activeScheme1D?.id === s.id ? 'on' : ''}`}
                  onClick={() => setActiveSlitScheme(s.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <small style={{ flex: 1, fontWeight: 600, color: 'var(--text)' }}>
                      {s.strategyName}
                    </small>
                    <span
                      className={`tag ${
                        s.state === 'SUCCEEDED' ? 'ok' : s.state === 'RUNNING' ? 'run' : 'err'
                      }`}
                    >
                      {s.state === 'SUCCEEDED' ? `${s.elapsedMs}ms` : s.state}
                    </span>
                  </div>
                  <b className="num">{s.state === 'RUNNING' ? '…' : `${s.totalCars} 车`}</b>
                  <div className="d num">
                    组数 {s.patterns?.length ?? 0} · 利用率 {s.avgUtilizationPct}% · 缺口{' '}
                    {s.missingRolls} · 超产 {s.overproducedRolls}
                  </div>
                </div>
              ))}
            </div>

            {activeScheme1D && activeScheme1D.state === 'SUCCEEDED' && (
              <div className="box" style={{ margin: '12px 0 0' }}>
                <div className="pane-h">
                  <span>
                    刀组排布（{activeScheme1D.patterns.length} 组 · {activeScheme1D.totalCars} 车）
                  </span>
                  <span className="sp" />
                  <button type="button" className="btn sm" onClick={onQuickExportExcel1D}>
                    导出 Excel
                  </button>
                </div>
                <div className="slit-patterns-list">
                  {activeScheme1D.patterns.map((p, idx) => (
                    <div key={p.id} className="slit-pattern-row">
                      <div className="slit-pattern-meta">
                        <span className="tag kind">组 {idx + 1}</span>
                        <b className="num">{p.repetitions} 车</b>
                        <span className="num">
                          {p.stations
                            .map((s) => `${s.widthMm}×${s.countPerRepetition}`)
                            .join(' + ')}
                        </span>
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
                      />
                    </div>
                  ))}
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
