import React, { RefObject } from 'react';
import { CanvasMode2D, Scenario2DType } from '../../store/useStudioStore';
import { SlittingWidthMode } from '../../store/studioSettings';
import { NumberInput } from '../../components/ui/NumberInput';
import { fmtM } from '../../lib/core/util.js';
import { openCraftSettings } from './workbenchUtils';
import {
  MultiMaterialCandidateRollOption,
  MultiMaterialFilterContext
} from './workbenchTypes';

export interface WorkbenchTopBarProps {
  is2D: boolean;
  setActiveDimension: (d: '2D' | '1D') => void;
  showWorkflowGuide: boolean;
  currentStage: 1 | 2 | 3;
  leftPaneRef: RefObject<HTMLElement | null>;
  rightPaneRef: RefObject<HTMLElement | null>;
  stripRef: RefObject<HTMLDivElement | null>;

  // 侧栏一键折叠（平板/窄屏适配）
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeftPane: () => void;
  onToggleRightPane: () => void;

  // 2D spec
  canvasMode: CanvasMode2D;
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  setMultiWidthsText2D: (val: string) => void;
  canvasWidthMm: number;
  canvasLengthMm: number;
  effectiveWindowStartY: number;
  pieceGapMm: number;
  trimStartMm: number;
  setCanvasSpec: (spec: Record<string, any>) => void;
  onRequestChangeMaterial2D: (spec: Record<string, any>, label: string) => void;
  onSuggestFeedWindow: () => void;
  passedRolls: any[];
  availableRemnants: any[];
  currentRoll2D: any;
  currentRemnant2D: any;

  // 多料联排顶栏控制
  multiPreferRemnants: boolean;
  multiMaxRemnants: number;
  multiCandidateRollIds: string[];
  multiCandidateRollOptions: MultiMaterialCandidateRollOption[];
  multiFilterContext: MultiMaterialFilterContext;

  // 1D spec
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitMotherWidthMm: number;
  slitFixedLengthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitWidthMode: SlittingWidthMode;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  currentRoll1D: any;
  setSlitSpec: (spec: Record<string, any>) => void;
  onRequestChangeMaterial1D: (spec: Record<string, any>, label: string) => void;
}

export const WorkbenchTopBar: React.FC<WorkbenchTopBarProps> = ({
  is2D,
  setActiveDimension,
  showWorkflowGuide,
  currentStage,
  leftPaneRef,
  rightPaneRef,
  stripRef,
  leftCollapsed,
  rightCollapsed,
  onToggleLeftPane,
  onToggleRightPane,
  canvasMode,
  scenario2D,
  multiWidthsText2D,
  setMultiWidthsText2D,
  canvasWidthMm,
  canvasLengthMm,
  effectiveWindowStartY,
  pieceGapMm,
  trimStartMm,
  setCanvasSpec,
  onRequestChangeMaterial2D,
  onSuggestFeedWindow,
  passedRolls,
  availableRemnants,
  currentRoll2D,
  currentRemnant2D,
  multiPreferRemnants,
  multiMaxRemnants,
  multiCandidateRollIds,
  multiCandidateRollOptions,
  multiFilterContext,
  slitMaterialMode,
  slitMotherWidthMm,
  slitFixedLengthMm,
  slitLeftTrimMm,
  slitRightTrimMm,
  slitWidthMode,
  slitMinWidthMm,
  slitMaxWidthMm,
  currentRoll1D,
  setSlitSpec,
  onRequestChangeMaterial1D
}) => {
  const minRollStartY = currentRoll2D ? Math.max(0, Number(currentRoll2D.usedLength) || 0) : 0;
  const maxRollStartY = currentRoll2D
    ? Math.max(minRollStartY, Math.floor((Number(currentRoll2D.totalLength) || 0) - 500))
    : 0;
  const eligibleMultiRollsCount = multiCandidateRollOptions.filter((r) => r.eligible).length;
  const selectedRollSet = new Set(multiCandidateRollIds);
  const toggleMultiCandidateRoll = (rollId: string) => {
    const next = selectedRollSet.has(rollId)
      ? multiCandidateRollIds.filter((id) => id !== rollId)
      : [...multiCandidateRollIds, rollId];
    setCanvasSpec({ multiCandidateRollIds: next });
  };

  return (
    <div className="studio-top-bar">
      <h1 className="studio-title">搭切工作台</h1>

      <div className="seg" role="group" aria-label="裁切维度">
        <button
          type="button"
          className={is2D ? 'on' : ''}
          aria-pressed={is2D}
          onClick={() => setActiveDimension('2D')}
        >
          二维排料
        </button>
        <button
          type="button"
          className={!is2D ? 'on' : ''}
          aria-pressed={!is2D}
          onClick={() => setActiveDimension('1D')}
        >
          一维分切
        </button>
      </div>

      {/* Workflow guide stepper — hidden by default; enabled via Settings -> 显示排程流程引导 */}
      {showWorkflowGuide && (
        <div className="stage-stepper" role="group" aria-label="排程流程引导">
          <button
            type="button"
            className={currentStage === 1 ? 'active' : ''}
            onClick={() =>
              leftPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
          >
            <b>1. 搭切前</b>
          </button>
          <span className="stage-arrow" aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className={currentStage === 2 ? 'active' : ''}
            onClick={() =>
              rightPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
          >
            <b>2. 搭切中</b>
          </button>
          <span className="stage-arrow" aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className={currentStage === 3 ? 'active' : ''}
            onClick={() =>
              stripRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
          >
            <b>3. 搭切后</b>
          </button>
        </div>
      )}

      {/* Mother Roll Selection Mode */}
      {is2D ? (
        <>
          <div className="seg" role="group" aria-label="母卷投料来源">
            <button
              type="button"
              className={canvasMode === 'FREE_CANVAS' ? 'on' : ''}
              aria-pressed={canvasMode === 'FREE_CANVAS'}
              onClick={() => {
                if (canvasMode !== 'FREE_CANVAS') {
                  onRequestChangeMaterial2D(
                    { canvasMode: 'FREE_CANVAS', windowStartY2D: null },
                    '切换至「默认新母卷」'
                  );
                }
              }}
            >
              默认新母卷
            </button>
            <button
              type="button"
              className={canvasMode === 'STOCK_ROLL' ? 'on' : ''}
              aria-pressed={canvasMode === 'STOCK_ROLL'}
              onClick={() => {
                if (canvasMode !== 'STOCK_ROLL') {
                  onRequestChangeMaterial2D(
                    { canvasMode: 'STOCK_ROLL', windowStartY2D: null },
                    '切换至「现有母卷」'
                  );
                }
              }}
            >
              现有母卷 ({passedRolls.length})
            </button>
            <button
              type="button"
              className={canvasMode === 'REMNANT' ? 'on' : ''}
              aria-pressed={canvasMode === 'REMNANT'}
              onClick={() => {
                if (canvasMode !== 'REMNANT') {
                  onRequestChangeMaterial2D(
                    { canvasMode: 'REMNANT', windowStartY2D: null },
                    '切换至「在库料头」'
                  );
                }
              }}
            >
              在库料头 ({availableRemnants.length})
            </button>
            <button
              type="button"
              className={canvasMode === 'MULTI_MATERIAL' ? 'on' : ''}
              aria-pressed={canvasMode === 'MULTI_MATERIAL'}
              title="跨多块在库料头接力消化 + 多卷在库母卷对比联合排产"
              onClick={() => {
                if (canvasMode !== 'MULTI_MATERIAL') {
                  onRequestChangeMaterial2D(
                    { canvasMode: 'MULTI_MATERIAL', windowStartY2D: null },
                    '切换至「多料联排」'
                  );
                }
              }}
            >
              多料联排
            </button>
          </div>

          {canvasMode === 'FREE_CANVAS' ? (
            <div className="studio-canvas-inputs">
              {scenario2D === 'MULTI_WIDTH' ? (
                <label>
                  <span>门幅列表</span>
                  <input
                    className="field num"
                    style={{ width: 148 }}
                    value={multiWidthsText2D}
                    onChange={(e) => setMultiWidthsText2D(e.target.value)}
                    placeholder="1500, 1650, 1800"
                  />
                  <em>mm</em>
                </label>
              ) : (
                <>
                  <label>
                    <span>门幅 W</span>
                    <NumberInput
                      className="field num"
                      style={{ width: 68 }}
                      min={300}
                      fallback={1500}
                      value={canvasWidthMm}
                      onValueChange={(w) => setCanvasSpec({ canvasWidthMm: w })}
                    />
                    <em>mm</em>
                  </label>
                  <div className="width-quick-pills" role="group" aria-label="常用门幅">
                    {[1220, 1500, 1650, 1800, 2000].map((w) => (
                      <button
                        key={w}
                        type="button"
                        className={canvasWidthMm === w ? 'on' : ''}
                        aria-pressed={canvasWidthMm === w}
                        onClick={() => setCanvasSpec({ canvasWidthMm: w })}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <label>
                <span>版长 L</span>
                <NumberInput
                  className="field num"
                  style={{ width: 70 }}
                  min={500}
                  fallback={2000}
                  value={canvasLengthMm}
                  onValueChange={(l) => setCanvasSpec({ canvasLengthMm: l })}
                />
                <em>mm</em>
              </label>
            </div>
          ) : canvasMode === 'STOCK_ROLL' ? (
            <div className="studio-canvas-inputs">
              <label>
                <span>母卷</span>
                <select
                  className="field"
                  value={currentRoll2D?.rollId || ''}
                  onChange={(e) => {
                    const r = passedRolls.find((x) => x.rollId === e.target.value);
                    onRequestChangeMaterial2D(
                      {
                        selectedRollId: e.target.value,
                        windowStartY2D: null,
                        ...(r ? { canvasWidthMm: r.width, materialModel2D: r.rollModel } : {})
                      },
                      `切换实卷至 ${e.target.value}`
                    );
                  }}
                >
                  {passedRolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      {r.rollId} · {r.rollModel} (W{r.width} · 余{fmtM(r.currentRemainingLength)}m)
                    </option>
                  ))}
                </select>
              </label>

              {currentRoll2D && (
                <label title="调节本次连续开卷工位起切位置（仅调整试算窗口，不扣库存）">
                  <span>起切 Y</span>
                  <NumberInput
                    className="field num"
                    style={{ width: 68 }}
                    min={minRollStartY}
                    max={maxRollStartY}
                    step={50}
                    fallback={minRollStartY}
                    value={effectiveWindowStartY}
                    onValueChange={(v) =>
                      setCanvasSpec({
                        windowStartY2D: Math.max(minRollStartY, Math.min(maxRollStartY, v))
                      })
                    }
                  />
                  {maxRollStartY > minRollStartY && (
                    <input
                      type="range"
                      className="wb-starty-slider"
                      aria-label="连续开卷工位起切点滑块"
                      min={minRollStartY}
                      max={maxRollStartY}
                      step={50}
                      value={effectiveWindowStartY}
                      onChange={(e) =>
                        setCanvasSpec({ windowStartY2D: Number(e.target.value) })
                      }
                    />
                  )}
                  <em>mm</em>
                </label>
              )}

              <label>
                <span>拉布长 L</span>
                <NumberInput
                  className="field num"
                  style={{ width: 68 }}
                  min={500}
                  fallback={2000}
                  value={canvasLengthMm}
                  onValueChange={(l) => setCanvasSpec({ canvasLengthMm: l })}
                />
                <em>mm</em>
              </label>

              {currentRoll2D && (
                <button
                  type="button"
                  className="btn sm"
                  title="根据当前需求长度、面积与母卷疵点自动建议拉布窗口（仅更新预览，不写库）"
                  onClick={onSuggestFeedWindow}
                >
                  按需求建议拉布
                </button>
              )}
            </div>
          ) : canvasMode === 'REMNANT' ? (
            <div className="studio-canvas-inputs">
              <label>
                <span>料头</span>
                <select
                  className="field"
                  value={currentRemnant2D?.id || ''}
                  onChange={(e) =>
                    onRequestChangeMaterial2D(
                      { selectedRemnantId: e.target.value, windowStartY2D: null },
                      `切换料头至 ${e.target.value}`
                    )
                  }
                >
                  {availableRemnants.map((rm) => (
                    <option key={rm.id} value={rm.id}>
                      {rm.id} · {rm.materialBatch} ({rm.width}×{rm.length}mm)
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <div className="studio-canvas-inputs wb-multi-controls">
              <label
                className="wb-multi-check"
                title="先跨多块在库合格料头接力消化裁片，再将剩余件送入多卷母卷比选"
              >
                <input
                  type="checkbox"
                  checked={multiPreferRemnants}
                  onChange={(e) => setCanvasSpec({ multiPreferRemnants: e.target.checked })}
                />
                <span>优先消化料头</span>
              </label>

              <label title="最多连续接力消化的在库料头块数（0–20）">
                <span>料头上限</span>
                <NumberInput
                  className="field num"
                  style={{ width: 52 }}
                  min={0}
                  max={20}
                  integer
                  fallback={6}
                  disabled={!multiPreferRemnants}
                  value={multiMaxRemnants}
                  onValueChange={(v) => setCanvasSpec({ multiMaxRemnants: v })}
                />
                <em>块</em>
              </label>

              <details className="craft-disclosure wb-multi-roll-picker">
                <summary title="选择参与多料联排对比的在库母卷（默认按品号/缸号/色号自动匹配全部合格同型卷）">
                  候选母卷{' '}
                  <span className="num">
                    {multiCandidateRollIds.length > 0
                      ? `已选 ${multiCandidateRollIds.length} 卷`
                      : `全部合格同型 (${eligibleMultiRollsCount})`}
                  </span>
                </summary>
                <div className="craft-disclosure-panel wb-multi-roll-panel">
                  <div className="wb-multi-roll-head">
                    <span>勾选特定母卷（留空=全部合格同型卷）</span>
                    <div className="wb-multi-roll-head-actions">
                      {multiCandidateRollIds.length > 0 && (
                        <button
                          type="button"
                          className="wb-tiny-ghost"
                          onClick={() => setCanvasSpec({ multiCandidateRollIds: [] })}
                        >
                          恢复全部同型
                        </button>
                      )}
                      {eligibleMultiRollsCount > 0 && (
                        <button
                          type="button"
                          className="wb-tiny-ghost"
                          onClick={() =>
                            setCanvasSpec({
                              multiCandidateRollIds: multiCandidateRollOptions
                                .filter((r) => r.eligible)
                                .map((r) => r.rollId)
                            })
                          }
                        >
                          全选同型
                        </button>
                      )}
                    </div>
                  </div>

                  {(multiFilterContext.materialModel ||
                    multiFilterContext.requiredBatchNo ||
                    multiFilterContext.requiredColor) && (
                    <div className="wb-multi-guard-chips num">
                      {multiFilterContext.materialModel && (
                        <span>品号 {multiFilterContext.materialModel}</span>
                      )}
                      {multiFilterContext.requiredBatchNo && (
                        <span>
                          · 缸号 {multiFilterContext.requiredBatchNo}
                          {multiFilterContext.strictBatchMatch ? ' (强同缸)' : ''}
                        </span>
                      )}
                      {multiFilterContext.requiredColor && (
                        <span>· 色号 {multiFilterContext.requiredColor}</span>
                      )}
                    </div>
                  )}

                  {multiCandidateRollOptions.length === 0 ? (
                    <div className="wb-multi-roll-empty">暂无已质检放行的在库合格母卷</div>
                  ) : (
                    <div className="wb-multi-roll-list">
                      {multiCandidateRollOptions.map((opt) => {
                        const checked = selectedRollSet.has(opt.rollId);
                        return (
                          <label
                            key={opt.rollId}
                            className={`wb-multi-roll-opt${checked ? ' is-checked' : ''}${
                              opt.blockedByStrict ? ' is-disabled' : ''
                            }`}
                            title={opt.mismatchReason || `${opt.rollId} · ${opt.rollModel}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={opt.blockedByStrict}
                              onChange={() => toggleMultiCandidateRoll(opt.rollId)}
                            />
                            <div className="wb-multi-roll-opt-body">
                              <div className="wb-multi-roll-opt-top num">
                                <b>{opt.rollId}</b>
                                <span>W{opt.width}</span>
                                <span>余{fmtM(opt.availableLengthMm)}m</span>
                                <span className="sp" />
                                {opt.eligible ? (
                                  <span className="tag ok">同型适配</span>
                                ) : (
                                  <span className="tag warn">{opt.mismatchReason || '非同型'}</span>
                                )}
                              </div>
                              <div className="wb-multi-roll-opt-sub">
                                {opt.rollModel || '未登记品号'}
                                {opt.batchNo ? ` · 缸号 ${opt.batchNo}` : ''}
                                {opt.color ? ` · ${opt.color}` : ''}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}

          <details className="craft-disclosure">
            <summary>
              工艺 <span className="num">距{pieceGapMm} · 头{trimStartMm}</span>
            </summary>
            <div className="craft-disclosure-panel">
              <label>
                <span>裁片安全间距 (mm)</span>
                <NumberInput
                  className="field num"
                  min={0}
                  max={50}
                  fallback={0}
                  value={pieceGapMm}
                  onValueChange={(v) => setCanvasSpec({ pieceGapMm: v })}
                />
              </label>
              <label>
                <span>首端修边切头 (mm)</span>
                <NumberInput
                  className="field num"
                  min={0}
                  max={200}
                  fallback={0}
                  value={trimStartMm}
                  onValueChange={(v) => setCanvasSpec({ trimStartMm: v })}
                />
              </label>
              <button
                type="button"
                className="btn sm"
                style={{ width: '100%', justifyContent: 'center', marginTop: 2 }}
                onClick={(e) => {
                  e.currentTarget.closest('details')?.removeAttribute('open');
                  openCraftSettings();
                }}
              >
                更多全局工艺设置…
              </button>
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="seg" role="group" aria-label="一维母卷来源">
            <button
              type="button"
              className={slitMaterialMode === 'VIRTUAL_ROLL' ? 'on' : ''}
              aria-pressed={slitMaterialMode === 'VIRTUAL_ROLL'}
              onClick={() => {
                if (slitMaterialMode !== 'VIRTUAL_ROLL') {
                  onRequestChangeMaterial1D(
                    { slitMaterialMode: 'VIRTUAL_ROLL' },
                    '一维母卷切换至「默认新母卷」'
                  );
                }
              }}
            >
              默认新母卷
            </button>
            <button
              type="button"
              className={slitMaterialMode === 'STOCK_ROLL' ? 'on' : ''}
              aria-pressed={slitMaterialMode === 'STOCK_ROLL'}
              onClick={() => {
                if (slitMaterialMode !== 'STOCK_ROLL') {
                  onRequestChangeMaterial1D(
                    {
                      slitMaterialMode: 'STOCK_ROLL',
                      slitAvoidDefects: true,
                      ...(currentRoll1D
                        ? { slitRollId: currentRoll1D.rollId, slitMotherWidthMm: currentRoll1D.width }
                        : {})
                    },
                    '一维母卷切换至「现有母卷」'
                  );
                }
              }}
            >
              现有母卷 ({passedRolls.length})
            </button>
          </div>

          {slitMaterialMode === 'VIRTUAL_ROLL' ? (
            <div className="studio-canvas-inputs">
              <label>
                <span>母卷幅宽</span>
                <NumberInput
                  className="field num"
                  style={{ width: 72 }}
                  min={500}
                  fallback={2000}
                  value={slitMotherWidthMm}
                  onValueChange={(w) => {
                    const usable = Math.max(100, w - slitLeftTrimMm - slitRightTrimMm);
                    const nextMax = Math.min(slitMaxWidthMm, usable);
                    setSlitSpec({
                      slitMotherWidthMm: w,
                      slitMaxWidthMm: nextMax,
                      slitMinWidthMm:
                        slitWidthMode === 'FIXED' ? nextMax : Math.min(slitMinWidthMm, nextMax)
                    });
                  }}
                />
                <em>mm</em>
              </label>
              <label>
                <span>定长</span>
                <NumberInput
                  className="field num"
                  style={{ width: 72 }}
                  min={100}
                  value={slitFixedLengthMm}
                  onValueChange={(v) => setSlitSpec({ slitFixedLengthMm: v })}
                />
                <em>mm</em>
              </label>
            </div>
          ) : (
            <div className="studio-canvas-inputs">
              <label>
                <span>实卷</span>
                <select
                  className="field"
                  value={currentRoll1D?.rollId || ''}
                  onChange={(e) => {
                    const r = passedRolls.find((x) => x.rollId === e.target.value);
                    const usable = r
                      ? Math.max(100, r.width - slitLeftTrimMm - slitRightTrimMm)
                      : slitMaxWidthMm;
                    onRequestChangeMaterial1D(
                      {
                        slitRollId: e.target.value,
                        ...(r
                          ? {
                              slitMotherWidthMm: r.width,
                              slitMaterialModel: r.rollModel,
                              slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                              slitMinWidthMm:
                                slitWidthMode === 'FIXED'
                                  ? Math.min(slitMaxWidthMm, usable)
                                  : Math.min(slitMinWidthMm, Math.min(slitMaxWidthMm, usable))
                            }
                          : {})
                      },
                      `一维实卷切换至 ${e.target.value}`
                    );
                  }}
                >
                  {passedRolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      {r.rollId} (W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>定长</span>
                <NumberInput
                  className="field num"
                  style={{ width: 70 }}
                  min={100}
                  value={slitFixedLengthMm}
                  onValueChange={(v) => setSlitSpec({ slitFixedLengthMm: v })}
                />
                <em>mm</em>
              </label>
            </div>
          )}
        </>
      )}

      <span className="sp" />

      {/* 工业平板/窄屏快速收折左右侧栏按钮 */}
      <div className="wb-pane-toggles" role="group" aria-label="侧栏收折控制">
        <button
          type="button"
          className={`btn sm ${leftCollapsed ? 'on' : ''}`}
          aria-pressed={!leftCollapsed}
          title={leftCollapsed ? '展开左侧需求栏' : '收起左侧需求栏'}
          onClick={onToggleLeftPane}
        >
          {leftCollapsed ? '▶ 需求' : '◀ 需求'}
        </button>
        <button
          type="button"
          className={`btn sm ${rightCollapsed ? 'on' : ''}`}
          aria-pressed={!rightCollapsed}
          title={rightCollapsed ? '展开右侧方案栏' : '收起右侧方案栏'}
          onClick={onToggleRightPane}
        >
          {rightCollapsed ? '方案 ◀' : '方案 ▶'}
        </button>
      </div>
    </div>
  );
};
