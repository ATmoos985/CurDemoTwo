import React, { RefObject } from 'react';
import { Scenario2DType } from '../../store/useStudioStore';
import { SlittingWidthMode } from '../../store/studioSettings';
import { NumberInput } from '../../components/ui/NumberInput';
import { fmtM } from '@static/app/js/util.js';
import { openCraftSettings, openEngineSettings } from './workbenchUtils';

export interface WorkbenchTopBarProps {
  is2D: boolean;
  setActiveDimension: (d: '2D' | '1D') => void;
  showWorkflowGuide: boolean;
  currentStage: 1 | 2 | 3;
  leftPaneRef: RefObject<HTMLElement | null>;
  rightPaneRef: RefObject<HTMLElement | null>;
  stripRef: RefObject<HTMLDivElement | null>;

  // 2D spec
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  setMultiWidthsText2D: (val: string) => void;
  canvasWidthMm: number;
  canvasLengthMm: number;
  pieceGapMm: number;
  trimStartMm: number;
  setCanvasSpec: (spec: Record<string, any>) => void;
  passedRolls: any[];
  availableRemnants: any[];
  currentRoll2D: any;
  currentRemnant2D: any;

  // 1D spec
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitMotherWidthMm: number;
  slitFixedLengthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitWidthMode: SlittingWidthMode;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  currentRoll1D: any;
  setSlitSpec: (spec: Record<string, any>) => void;
}

export const WorkbenchTopBar: React.FC<WorkbenchTopBarProps> = ({
  is2D,
  setActiveDimension,
  showWorkflowGuide,
  currentStage,
  leftPaneRef,
  rightPaneRef,
  stripRef,
  canvasMode,
  scenario2D,
  multiWidthsText2D,
  setMultiWidthsText2D,
  canvasWidthMm,
  canvasLengthMm,
  pieceGapMm,
  trimStartMm,
  setCanvasSpec,
  passedRolls,
  availableRemnants,
  currentRoll2D,
  currentRemnant2D,
  slitMaterialMode,
  slitMotherWidthMm,
  slitFixedLengthMm,
  slitLeftTrimMm,
  slitRightTrimMm,
  slitWidthMode,
  slitMinWidthMm,
  slitMaxWidthMm,
  slitWidthStepMm,
  slitOverCap,
  currentRoll1D,
  setSlitSpec
}) => {
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
              onClick={() => setCanvasSpec({ canvasMode: 'FREE_CANVAS' })}
            >
              默认新母卷
            </button>
            <button
              type="button"
              className={canvasMode === 'STOCK_ROLL' ? 'on' : ''}
              aria-pressed={canvasMode === 'STOCK_ROLL'}
              onClick={() => setCanvasSpec({ canvasMode: 'STOCK_ROLL' })}
            >
              现有母卷 ({passedRolls.length})
            </button>
            <button
              type="button"
              className={canvasMode === 'REMNANT' ? 'on' : ''}
              aria-pressed={canvasMode === 'REMNANT'}
              onClick={() => setCanvasSpec({ canvasMode: 'REMNANT' })}
            >
              在库料头 ({availableRemnants.length})
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
                    setCanvasSpec({
                      selectedRollId: e.target.value,
                      ...(r ? { canvasWidthMm: r.width, materialModel2D: r.rollModel } : {})
                    });
                  }}
                >
                  {passedRolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      {r.rollId} · {r.rollModel} (W{r.width} · 余{fmtM(r.currentRemainingLength)}m)
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>拉布长 L</span>
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
          ) : (
            <div className="studio-canvas-inputs">
              <label>
                <span>料头</span>
                <select
                  className="field"
                  value={currentRemnant2D?.id || ''}
                  onChange={(e) => setCanvasSpec({ selectedRemnantId: e.target.value })}
                >
                  {availableRemnants.map((rm) => (
                    <option key={rm.id} value={rm.id}>
                      {rm.id} · {rm.materialBatch} ({rm.width}×{rm.length}mm)
                    </option>
                  ))}
                </select>
              </label>
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
              onClick={() => setSlitSpec({ slitMaterialMode: 'VIRTUAL_ROLL' })}
            >
              默认新母卷
            </button>
            <button
              type="button"
              className={slitMaterialMode === 'STOCK_ROLL' ? 'on' : ''}
              aria-pressed={slitMaterialMode === 'STOCK_ROLL'}
              onClick={() =>
                setSlitSpec({
                  slitMaterialMode: 'STOCK_ROLL',
                  slitAvoidDefects: true,
                  ...(currentRoll1D
                    ? { slitRollId: currentRoll1D.rollId, slitMotherWidthMm: currentRoll1D.width }
                    : {})
                })
              }
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
                    setSlitSpec({
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
                    });
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

          <details className="craft-disclosure">
            <summary>
              一维参数{' '}
              <span className="num">
                切边 {slitLeftTrimMm}+{slitRightTrimMm} · 宽
                {slitWidthMode === 'FIXED'
                  ? `${slitMaxWidthMm}`
                  : `${slitMinWidthMm}-${slitMaxWidthMm}/步${slitWidthStepMm}`}{' '}
                · 超≤{slitOverCap}
              </span>
            </summary>
            <div className="craft-disclosure-panel" style={{ minWidth: 270 }}>
              <label>
                <span>宽度模式</span>
                <select
                  className="field"
                  value={slitWidthMode}
                  onChange={(e) => {
                    const nextMode = e.target.value as SlittingWidthMode;
                    setSlitSpec({
                      slitWidthMode: nextMode,
                      ...(nextMode === 'FIXED' ? { slitMinWidthMm: slitMaxWidthMm } : {})
                    });
                  }}
                >
                  <option value="FLEXIBLE">可变宽幅区间</option>
                  <option value="FIXED">固定组合宽</option>
                </select>
              </label>
              <label>
                <span>左固定切边 (mm)</span>
                <NumberInput
                  min={0}
                  fallback={0}
                  className="field num"
                  value={slitLeftTrimMm}
                  onValueChange={(lt) => {
                    const usable = Math.max(100, slitMotherWidthMm - lt - slitRightTrimMm);
                    setSlitSpec({
                      slitLeftTrimMm: lt,
                      slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                      slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                    });
                  }}
                />
              </label>
              <label>
                <span>右固定切边 (mm)</span>
                <NumberInput
                  min={0}
                  fallback={0}
                  className="field num"
                  value={slitRightTrimMm}
                  onValueChange={(rt) => {
                    const usable = Math.max(100, slitMotherWidthMm - slitLeftTrimMm - rt);
                    setSlitSpec({
                      slitRightTrimMm: rt,
                      slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                      slitMinWidthMm: Math.min(slitMinWidthMm, usable)
                    });
                  }}
                />
              </label>
              {slitWidthMode === 'FLEXIBLE' && (
                <label>
                  <span>最小组合宽 (mm)</span>
                  <NumberInput
                    min={100}
                    fallback={100}
                    className="field num"
                    value={slitMinWidthMm}
                    onValueChange={(v) => setSlitSpec({ slitMinWidthMm: v })}
                  />
                </label>
              )}
              <label>
                <span>{slitWidthMode === 'FIXED' ? '固定组合宽 (mm)' : '最大组合宽 (mm)'}</span>
                <NumberInput
                  min={100}
                  fallback={100}
                  className="field num"
                  value={slitMaxWidthMm}
                  onValueChange={(v) => {
                    setSlitSpec({
                      slitMaxWidthMm: v,
                      ...(slitWidthMode === 'FIXED' ? { slitMinWidthMm: v } : {})
                    });
                  }}
                />
              </label>
              {slitWidthMode === 'FLEXIBLE' && (
                <label>
                  <span>幅宽步长 (mm)</span>
                  <NumberInput
                    min={1}
                    fallback={10}
                    className="field num"
                    value={slitWidthStepMm}
                    onValueChange={(v) => setSlitSpec({ slitWidthStepMm: v })}
                  />
                </label>
              )}
              <label>
                <span>超产上限 (卷)</span>
                <NumberInput
                  min={0}
                  fallback={0}
                  className="field num"
                  value={slitOverCap}
                  onValueChange={(v) => setSlitSpec({ slitOverCap: v })}
                />
              </label>
              <button
                type="button"
                className="btn sm"
                style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
                onClick={(e) => {
                  e.currentTarget.closest('details')?.removeAttribute('open');
                  openEngineSettings();
                }}
              >
                打开 NewSolver 高级参数设置…
              </button>
            </div>
          </details>
        </>
      )}
    </div>
  );
};
