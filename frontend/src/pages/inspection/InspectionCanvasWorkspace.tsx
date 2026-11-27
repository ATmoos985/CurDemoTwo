import React from 'react';
import { fmtM, fmtN, toast } from '../../lib/core/util.js';
import { round } from '../../lib/domain/inspection-model.js';
import {
  BoardDefect,
  BoardZone,
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle
} from '../../components/WorkbenchBoardCanvas';
import { NumberInput } from '../../components/ui/NumberInput';
import { DEFECT_TYPES, defectKey } from './inspectionTypes';

export interface InspectionCanvasWorkspaceProps {
  roll: any;
  pending: any[];
  allDefects: any[];
  historyLength: number;
  pos: number;
  posInputText: string;
  onSetPosInputText: (v: string) => void;
  onUpdatePos: (nextPos: number) => void;
  step: number;
  onSetStep: (v: number) => void;
  speed: number;
  onSetSpeed: (v: number) => void;
  running: boolean;
  onToggleRunning: () => void;
  tool: 'mark' | 'select' | 'measure';
  onSetTool: (t: 'mark' | 'select' | 'measure') => void;
  overview: boolean;
  onSetFollowMode: () => void;
  onSetOverviewMode: () => void;
  panelCollapsed: boolean;
  onTogglePanelCollapsed: () => void;
  saving: boolean;
  pointerText: string;
  sel: number | null;
  onSelectIndex: (idx: number | null) => void;
  selectedDefect: any | null;
  editable: boolean;
  inCutArea: boolean;
  voidReason: string;
  onSetVoidReason: (v: string) => void;
  onVoidDefect: () => void;
  fRight: string | number;
  setFRight: (v: string | number) => void;
  fY: string | number;
  setFY: (v: string | number) => void;
  fW: string | number;
  setFW: (v: string | number) => void;
  fH: string | number;
  setFH: (v: string | number) => void;
  fType: string;
  setFType: (v: string) => void;
  fMargin: string | number;
  setFMargin: (v: string | number) => void;
  onUndo: () => void;
  onRemoveSelected: () => void;
  onApplyManualDefect: () => void;
  onJumpToDefectRow: (defect: any, index: number) => void;
  canvasRef: React.MutableRefObject<WorkbenchBoardHandle | null>;
  inspectionDefects: BoardDefect[];
  inspectionZones: BoardZone[];
  emptyDemands: any[];
  emptyPlaced: any[];
  selectedDefectKey: string | null;
  onCanvasInteract: () => void;
  onCanvasCursor: (pt: { x: number; y: number } | null) => void;
  onCanvasDefectSelect: (key: string) => void;
  onCanvasDefectDraw: (box: { u: number; v: number; du: number; dv: number }) => void;
  onCanvasDefectEdit: (key: string, box: { u: number; v: number; du: number; dv: number }) => void;
}

export const InspectionCanvasWorkspace: React.FC<InspectionCanvasWorkspaceProps> = ({
  roll,
  pending,
  allDefects,
  historyLength,
  pos,
  posInputText,
  onSetPosInputText,
  onUpdatePos,
  step,
  onSetStep,
  speed,
  onSetSpeed,
  running,
  onToggleRunning,
  tool,
  onSetTool,
  overview,
  onSetFollowMode,
  onSetOverviewMode,
  panelCollapsed,
  onTogglePanelCollapsed,
  saving,
  pointerText,
  sel,
  onSelectIndex,
  selectedDefect,
  editable,
  inCutArea,
  voidReason,
  onSetVoidReason,
  onVoidDefect,
  fRight,
  setFRight,
  fY,
  setFY,
  fW,
  setFW,
  fH,
  setFH,
  fType,
  setFType,
  fMargin,
  setFMargin,
  onUndo,
  onRemoveSelected,
  onApplyManualDefect,
  onJumpToDefectRow,
  canvasRef,
  inspectionDefects,
  inspectionZones,
  emptyDemands,
  emptyPlaced,
  selectedDefectKey,
  onCanvasInteract,
  onCanvasCursor,
  onCanvasDefectSelect,
  onCanvasDefectDraw,
  onCanvasDefectEdit
}) => {
  return (
    <>
      <div className="mp-insp-feedbar">
        <div className="mp-seg mp-seg-sm" role="group" aria-label="画布验疵工具切换">
          <button
            type="button"
            data-tool="mark"
            className={`mp-seg-btn ${tool === 'mark' ? 'on' : ''}`}
            aria-pressed={tool === 'mark'}
            onClick={() => onSetTool('mark')}
          >
            标记疵点
          </button>
          <button
            type="button"
            data-tool="select"
            className={`mp-seg-btn ${tool === 'select' ? 'on' : ''}`}
            aria-pressed={tool === 'select'}
            onClick={() => onSetTool('select')}
          >
            选择 / 调整
          </button>
          <button
            type="button"
            data-tool="measure"
            className={`mp-seg-btn ${tool === 'measure' ? 'on' : ''}`}
            aria-pressed={tool === 'measure'}
            onClick={() => onSetTool('measure')}
          >
            测距
          </button>
        </div>

        <span className="mp-insp-vsep" />

        <div className="mp-insp-feed-group">
          <span className="muted">位置</span>
          <input
            className="field num"
            id="pos"
            aria-label="当前位置米数"
            style={{ width: 82, textAlign: 'right' }}
            value={posInputText}
            onChange={(e) => onSetPosInputText(e.target.value)}
          />
          <span className="muted">m</span>
          <button
            type="button"
            className="btn sm"
            id="locate"
            onClick={() => {
              const m = Number(posInputText);
              if (!(m >= 0)) {
                toast('请输入有效米数', true);
                return;
              }
              const nextPos = Math.min(roll.totalLength, round(m * 1000));
              onUpdatePos(nextPos);
            }}
          >
            定位 / 校准
          </button>
        </div>

        <span className="mp-insp-vsep" />

        <div className="mp-insp-feed-group">
          <span className="muted">步进</span>
          <NumberInput
            className="field num"
            id="step"
            aria-label="每次前进米数"
            min={0.1}
            step={0.1}
            fallback={1}
            style={{ width: 54, textAlign: 'right' }}
            value={step}
            onValueChange={onSetStep}
          />
          <span className="muted">m</span>
          <button
            type="button"
            className="btn sm"
            id="advance"
            onClick={() => {
              const nextPos = Math.min(roll.totalLength, pos + step * 1000);
              onUpdatePos(nextPos);
            }}
          >
            前进 ↓
          </button>
        </div>

        <span className="mp-insp-vsep" />

        <div className="mp-insp-feed-group">
          <span className="muted">速度</span>
          <NumberInput
            className="field num"
            id="speed"
            aria-label="自动跑布速度"
            min={0.1}
            step={0.1}
            fallback={3}
            style={{ width: 54, textAlign: 'right' }}
            value={speed}
            onValueChange={onSetSpeed}
          />
          <span className="muted">m/min</span>
          <button
            type="button"
            className={`btn sm ${running ? 'soft-accent' : ''}`}
            id="run"
            onClick={onToggleRunning}
          >
            {running ? '暂停跑布' : '自动跑布'}
          </button>
        </div>

        <span className="sp" />
        <span className="mp-toolbar-count">
          {running ? '自动跑布中 · 空格随时暂停' : '手动模式 · 空格启停'}
        </span>
      </div>

      <div
        className="mp-insp-workspace"
        style={{
          gridTemplateColumns: panelCollapsed ? '52px minmax(0, 1fr)' : '52px minmax(0, 1fr) 368px'
        }}
      >
        <section className="mp-insp-track-card" title="全卷位置导轨：点击跳转">
          <div className="mp-insp-track-label">全卷</div>
          <div
            className="vtrack"
            id="vtrack"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const nextPos = round(((e.clientY - r.top) / r.height) * roll.totalLength);
              onUpdatePos(nextPos);
            }}
          >
            {allDefects.map((d, idx) => (
              <i
                key={defectKey(d) || idx}
                className={d.saved ? '' : 'new'}
                style={{ top: `${(d.y / roll.totalLength) * 100}%` }}
              />
            ))}
            <b style={{ height: `${(pos / roll.totalLength) * 100}%` }} />
            <em style={{ top: `${(pos / roll.totalLength) * 100}%` }} />
          </div>
          <div className="num" style={{ color: '#9aa4b2', fontSize: 10, marginTop: 6 }}>
            {fmtM(roll.totalLength)}m
          </div>
        </section>

        <section className="mp-insp-canvas-card">
          <div className="ctool">
            <div className="vseg">
              <button
                type="button"
                id="follow"
                className={!overview ? 'on' : ''}
                onClick={onSetFollowMode}
              >
                跟随验布线
              </button>
              <button
                type="button"
                id="overview"
                className={overview ? 'on' : ''}
                onClick={onSetOverviewMode}
              >
                全卷
              </button>
            </div>
            <button
              type="button"
              id="undo"
              title="撤销本次未保存的操作（Ctrl+Z）"
              disabled={!historyLength || saving}
              onClick={onUndo}
            >
              ↶ 撤销
            </button>
            <button
              type="button"
              id="toggle-panel"
              aria-expanded={!panelCollapsed}
              title="收起或展开右侧疵点记录卡"
              onClick={onTogglePanelCollapsed}
            >
              {panelCollapsed ? '展开记录' : '收起记录'}
            </button>
            <span className="sp" />
            <span id="pointer-position" className="num">
              {pointerText}
            </span>
          </div>
          <div className="canvas-wrap">
            <div id="isvg" style={{ position: 'absolute', inset: 0 }}>
              <WorkbenchBoardCanvas
                rollTitle={roll.rollId ? String(roll.rollId) : '验布母卷'}
                rollWidthMm={Math.max(10, Number(roll.width || 1500))}
                rollLengthMm={Math.max(10, Number(roll.totalLength || 3000))}
                occupiedLengthMm={0}
                trimStartMm={0}
                pieceGapMm={0}
                defects={inspectionDefects}
                demands={emptyDemands}
                placedPieces={emptyPlaced}
                zones={inspectionZones}
                feedPositionMm={pos}
                selectedDefectId={selectedDefectKey}
                showStaging={false}
                interactivePieces={false}
                vertical={true}
                tool={tool === 'mark' ? 'defect' : tool === 'measure' ? 'measure' : 'pan'}
                showDimensions={true}
                showPath={false}
                highlightedDemandKey={null}
                selectedPieceIndex={null}
                ariaLabel="验布实时画布"
                onInteract={onCanvasInteract}
                onCursorMove={onCanvasCursor}
                onDefectSelect={onCanvasDefectSelect}
                onDefectDraw={onCanvasDefectDraw}
                onDefectEdit={onCanvasDefectEdit}
                boardRef={canvasRef}
              />
            </div>
          </div>
        </section>

        <section className="mp-insp-side-card" style={panelCollapsed ? { display: 'none' } : undefined}>
          <div className="pane-h">
            <span>疵点记录</span>
            <span className="sp" />
            <span className="sub num">
              已入档 {allDefects.length - pending.length} · 待保存 {pending.length}
            </span>
          </div>
          <div className="pane-b">
            <div id="editor">
              <div className="sec">
                {selectedDefect
                  ? editable
                    ? '本次标记 · 可修改 / Delete 删除'
                    : '已入档疵点'
                  : '精确坐标录入'}
              </div>
              {selectedDefect && (
                <div className="kv">
                  <div>位置</div>
                  <div className="num">
                    Y {(selectedDefect.y / 1000).toFixed(3)} m · 距右{' '}
                    {fmtN(roll.width - selectedDefect.x - selectedDefect.w, 1)} mm
                  </div>
                  <div>来源</div>
                  <div>
                    {selectedDefect.detectionSource || '—'}
                    {selectedDefect.description ? ' · ' + selectedDefect.description : ''}
                  </div>
                </div>
              )}
              {selectedDefect && !editable && (
                inCutArea ? (
                  <div className="notice">该疵点位于已切区域，属于历史记录，不能作废。</div>
                ) : (
                  <>
                    <div className="mp-insp-void-row">
                      <input
                        className="field"
                        id="void-reason"
                        placeholder="作废原因（必填，如：复核为误检）"
                        style={{ flex: 1, height: 30 }}
                        value={voidReason}
                        onChange={(e) => onSetVoidReason(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn sm"
                        id="void"
                        disabled={saving}
                        onClick={onVoidDefect}
                      >
                        作废
                      </button>
                    </div>
                    <div className="mp-insp-void-note">
                      作废后不再避让，原记录与原因留痕；该卷上未报工的候选方案需重新计算。
                    </div>
                  </>
                )
              )}

              <div className="form">
                <label>
                  距右边缘 mm
                  <input
                    type="number"
                    data-f="right"
                    className="field num"
                    disabled={Boolean(saving || (selectedDefect && !editable))}
                    value={fRight}
                    onChange={(e) => setFRight(e.target.value)}
                  />
                </label>
                <label>
                  距卷头 mm
                  <input
                    type="number"
                    data-f="y"
                    className="field num"
                    disabled={Boolean(saving || (selectedDefect && !editable))}
                    value={fY}
                    onChange={(e) => setFY(e.target.value)}
                  />
                </label>
                <label>
                  疵点宽 mm
                  <input
                    type="number"
                    data-f="w"
                    className="field num"
                    disabled={Boolean(saving || (selectedDefect && !editable))}
                    value={fW}
                    onChange={(e) => setFW(e.target.value)}
                  />
                </label>
                <label>
                  疵点长 mm
                  <input
                    type="number"
                    data-f="h"
                    className="field num"
                    disabled={Boolean(saving || (selectedDefect && !editable))}
                    value={fH}
                    onChange={(e) => setFH(e.target.value)}
                  />
                </label>
                <label>
                  类型
                  <select
                    data-f="type"
                    className="field"
                    disabled={Boolean(selectedDefect && !editable)}
                    value={fType}
                    onChange={(e) => setFType(e.target.value)}
                  >
                    {DEFECT_TYPES.map(([k, t]) => (
                      <option key={k} value={k}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  避让外扩 mm
                  <input
                    type="number"
                    data-f="margin"
                    className="field num"
                    disabled={Boolean(saving || (selectedDefect && !editable))}
                    value={fMargin}
                    onChange={(e) => setFMargin(e.target.value)}
                  />
                </label>
              </div>

              <div style={{ display: 'flex', gap: 6, padding: '0 13px 10px', justifyContent: 'flex-end' }}>
                {selectedDefect && (
                  <button type="button" id="new" className="btn sm" onClick={() => onSelectIndex(null)}>
                    新标记
                  </button>
                )}
                {editable ? (
                  <>
                    <button type="button" className="btn sm" onClick={onRemoveSelected}>
                      删除
                    </button>
                    <button type="button" id="apply" className="btn sm soft-accent" onClick={onApplyManualDefect}>
                      更新标记
                    </button>
                  </>
                ) : !selectedDefect ? (
                  <button type="button" id="apply" className="btn sm soft-accent" onClick={onApplyManualDefect}>
                    添加到本次记录
                  </button>
                ) : null}
              </div>
            </div>

            <div className="sec">全部疵点 · 点击定位（{allDefects.length}）</div>
            {allDefects.length > 0 ? (
              <div className="mp-table-scroll">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Y m</th>
                      <th className="r">距右</th>
                      <th className="r">宽×长</th>
                      <th>类型</th>
                      <th style={{ textAlign: 'right' }}>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allDefects.map((d, i) => (
                      <tr
                        key={defectKey(d) || i}
                        className={`click ${sel === i ? 'sel' : ''}`}
                        onClick={() => onJumpToDefectRow(d, i)}
                      >
                        <td className="num">{(d.y / 1000).toFixed(2)}</td>
                        <td className="r num">{fmtN(roll.width - d.x - d.w, 1)}</td>
                        <td className="r num">
                          {fmtN(d.w, 1)}×{fmtN(d.h, 1)}
                        </td>
                        <td>{d.typeName || d.defectType}</td>
                        <td style={{ textAlign: 'right' }}>
                          {d.saved ? <span className="tag">已入档</span> : <span className="tag warn">待保存</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mp-empty-inline">暂未标记疵点，可直接在左侧画布框选或上方录入坐标</div>
            )}

            {(roll.voidedDefects || []).length > 0 && (
              <>
                <div className="sec">已作废 {roll.voidedDefects.length} 处 · 留痕</div>
                <div className="mp-table-scroll">
                  <table className="t">
                    <tbody>
                      {roll.voidedDefects
                        .slice()
                        .reverse()
                        .map((v: any, idx: number) => (
                          <tr key={idx}>
                            <td className="num muted">{(v.defect.y / 1000).toFixed(2)} m</td>
                            <td className="muted">{v.defect.typeName || v.defect.defectType}</td>
                            <td className="wrap muted" title={v.voidedAt}>
                              {v.reason}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
          <div className="mp-insp-side-foot">
            本次记录保存在本机；点击右上角「保存到母卷」入档后用于裁切避让，已有方案需重新核对。
          </div>
        </section>
      </div>
    </>
  );
};
