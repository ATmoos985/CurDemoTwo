import React from 'react';
import { fmtM } from '../../lib/core/util.js';
import { SegmentedControl } from '../../components/ui/MagpiePrimitives';
import { NumberInput } from '../../components/ui/NumberInput';
import type { Scenario1DType, Scenario2DType } from '../../store/studioTypes';
import { GOALS_1D, GOALS_2D, QUICK_WIDTHS_2D } from './demandCreateTypes';

export interface DemandPreScheduleSectionProps {
  is1D: boolean;
  passedRolls: any[];
  availableRemnants: any[];
  canvasMode2D: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  setCanvasMode2D: (v: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT') => void;
  motherWidth2D: number;
  setMotherWidth2D: (v: number) => void;
  bedLength2D: number;
  setBedLength2D: (v: number) => void;
  selectedRollId2D: string;
  setSelectedRollId2D: (v: string) => void;
  selectedRemnantId2D: string;
  setSelectedRemnantId2D: (v: string) => void;
  scenario2D: Scenario2DType;
  setScenario2D: (v: Scenario2DType) => void;
  pieceGapMm: number;
  setPieceGapMm: (v: number) => void;
  trimStartMm: number;
  setTrimStartMm: (v: number) => void;
  slitMode1D: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  setSlitMode1D: (v: 'VIRTUAL_ROLL' | 'STOCK_ROLL') => void;
  selectedRollId1D: string;
  setSelectedRollId1D: (v: string) => void;
  motherWidth1D: number;
  setMotherWidth1D: (v: number) => void;
  fixedLen1D: number;
  setFixedLen1D: (v: number) => void;
  leftTrim1D: number;
  setLeftTrim1D: (v: number) => void;
  rightTrim1D: number;
  setRightTrim1D: (v: number) => void;
  minWidth1D: number;
  setMinWidth1D: (v: number) => void;
  maxWidth1D: number;
  setMaxWidth1D: (v: number) => void;
  widthStep1D: number;
  setWidthStep1D: (v: number) => void;
  overCap1D: number;
  setOverCap1D: (v: number) => void;
  scenario1D: Scenario1DType;
  setScenario1D: (v: Scenario1DType) => void;
}

export const DemandPreScheduleSection: React.FC<DemandPreScheduleSectionProps> = ({
  is1D,
  passedRolls,
  availableRemnants,
  canvasMode2D,
  setCanvasMode2D,
  motherWidth2D,
  setMotherWidth2D,
  bedLength2D,
  setBedLength2D,
  selectedRollId2D,
  setSelectedRollId2D,
  selectedRemnantId2D,
  setSelectedRemnantId2D,
  scenario2D,
  setScenario2D,
  pieceGapMm,
  setPieceGapMm,
  trimStartMm,
  setTrimStartMm,
  slitMode1D,
  setSlitMode1D,
  selectedRollId1D,
  setSelectedRollId1D,
  motherWidth1D,
  setMotherWidth1D,
  fixedLen1D,
  setFixedLen1D,
  leftTrim1D,
  setLeftTrim1D,
  rightTrim1D,
  setRightTrim1D,
  minWidth1D,
  setMinWidth1D,
  maxWidth1D,
  setMaxWidth1D,
  widthStep1D,
  setWidthStep1D,
  overCap1D,
  setOverCap1D,
  scenario1D,
  setScenario1D
}) => {
  return (
    <div className="dc-sec">
      <div className="dc-sec-head">
        <span className="dc-sec-title">排程前置配置</span>
        <span style={{ fontSize: 11, color: 'var(--cp-ink-3)' }}>直带入工作台</span>
      </div>

      {!is1D ? (
        <>
          <SegmentedControl
            options={[
              { value: 'FREE_CANVAS', label: '默认新母卷' },
              { value: 'STOCK_ROLL', label: `现有母卷 (${passedRolls.length})` },
              { value: 'REMNANT', label: `在库料头 (${availableRemnants.length})` }
            ]}
            value={canvasMode2D}
            onChange={(v) => setCanvasMode2D(v)}
            ariaLabel="预选二维母卷来源"
            size="sm"
            fullWidth
          />

          {canvasMode2D === 'FREE_CANVAS' ? (
            <>
              <div className="dc-grid-2">
                <div className="dc-field">
                  <label htmlFor="dc-w2d">
                    新母卷门幅 <small>mm</small>
                  </label>
                  <NumberInput
                    id="dc-w2d"
                    min={200}
                    fallback={1650}
                    className="field num"
                    value={motherWidth2D}
                    onValueChange={setMotherWidth2D}
                  />
                </div>
                <div className="dc-field">
                  <label htmlFor="dc-l2d">
                    版长上限 <small>mm</small>
                  </label>
                  <NumberInput
                    id="dc-l2d"
                    min={500}
                    fallback={2400}
                    className="field num"
                    value={bedLength2D}
                    onValueChange={setBedLength2D}
                  />
                </div>
              </div>
              <div className="dc-width-chips">
                {QUICK_WIDTHS_2D.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`dc-chip-btn num ${motherWidth2D === w ? 'on' : ''}`}
                    onClick={() => setMotherWidth2D(w)}
                  >
                    {w}mm
                  </button>
                ))}
              </div>
            </>
          ) : canvasMode2D === 'STOCK_ROLL' ? (
            <div className="dc-field">
              <label>选择在库合格母卷</label>
              <select
                className="field num"
                value={selectedRollId2D}
                onChange={(e) => setSelectedRollId2D(e.target.value)}
              >
                {passedRolls.length === 0 ? (
                  <option value="">暂无可用合格母卷</option>
                ) : (
                  passedRolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      {r.rollId} · W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m
                    </option>
                  ))
                )}
              </select>
            </div>
          ) : (
            <div className="dc-field">
              <label>选择在库可用料头</label>
              <select
                className="field num"
                value={selectedRemnantId2D}
                onChange={(e) => setSelectedRemnantId2D(e.target.value)}
              >
                {availableRemnants.length === 0 ? (
                  <option value="">暂无可用料头</option>
                ) : (
                  availableRemnants.map((rm) => (
                    <option key={rm.id} value={rm.id}>
                      {rm.id} · {rm.width}×{rm.length}mm ({rm.materialBatch})
                    </option>
                  ))
                )}
              </select>
            </div>
          )}

          <div className="dc-field">
            <label>求解目标</label>
            <div className="dc-goal-grid">
              {GOALS_2D.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`dc-goal-btn ${scenario2D === g.id ? 'on' : ''}`}
                  aria-pressed={scenario2D === g.id}
                  onClick={() => setScenario2D(g.id)}
                >
                  <strong>{g.title}</strong>
                  <span>{g.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="dc-grid-2">
            <div className="dc-field">
              <label htmlFor="dc-gap">
                裁片间距 <small>mm</small>
              </label>
              <NumberInput
                id="dc-gap"
                min={0}
                max={50}
                fallback={0}
                className="field num"
                value={pieceGapMm}
                onValueChange={setPieceGapMm}
              />
            </div>
            <div className="dc-field">
              <label htmlFor="dc-trim">
                首端切头 <small>mm</small>
              </label>
              <NumberInput
                id="dc-trim"
                min={0}
                max={500}
                fallback={0}
                className="field num"
                value={trimStartMm}
                onValueChange={setTrimStartMm}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <SegmentedControl
            options={[
              { value: 'VIRTUAL_ROLL', label: '默认新母卷' },
              { value: 'STOCK_ROLL', label: `现有母卷 (${passedRolls.length})` }
            ]}
            value={slitMode1D}
            onChange={(v) => setSlitMode1D(v)}
            ariaLabel="预选一维母卷来源"
            size="sm"
            fullWidth
          />

          {slitMode1D === 'STOCK_ROLL' && (
            <div className="dc-field">
              <label>选择实卷避疵分切</label>
              <select
                className="field num"
                value={selectedRollId1D}
                onChange={(e) => {
                  setSelectedRollId1D(e.target.value);
                  const r = passedRolls.find((x) => x.rollId === e.target.value);
                  if (r) setMotherWidth1D(Number(r.width) || 2000);
                }}
              >
                {passedRolls.map((r) => (
                  <option key={r.rollId} value={r.rollId}>
                    {r.rollId} · W{r.width}mm · 余{fmtM(r.currentRemainingLength)}m
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="dc-grid-2">
            <div className="dc-field">
              <label>
                母卷幅宽 <small>mm</small>
              </label>
              <NumberInput
                min={500}
                fallback={2000}
                className="field num"
                value={motherWidth1D}
                onValueChange={(w) => {
                  const usable = Math.max(100, w - leftTrim1D - rightTrim1D);
                  setMotherWidth1D(w);
                  setMaxWidth1D(Math.min(maxWidth1D, usable));
                  setMinWidth1D(Math.min(minWidth1D, usable));
                }}
              />
            </div>
            <div className="dc-field">
              <label>
                定长卷长 <small>mm</small>
              </label>
              <NumberInput
                min={100}
                fallback={2000}
                className="field num"
                value={fixedLen1D}
                onValueChange={setFixedLen1D}
              />
            </div>
          </div>

          <div className="dc-field">
            <label>分切目标</label>
            <div className="dc-goal-grid">
              {GOALS_1D.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`dc-goal-btn ${scenario1D === g.id ? 'on' : ''}`}
                  aria-pressed={scenario1D === g.id}
                  onClick={() => setScenario1D(g.id)}
                >
                  <strong>{g.title}</strong>
                  <span>{g.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="dc-grid-2">
            <div className="dc-field">
              <label>
                左/右修边 <small>mm</small>
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <NumberInput
                  min={0}
                  fallback={0}
                  className="field num"
                  aria-label="左修边"
                  value={leftTrim1D}
                  onValueChange={(lt) => {
                    const usable = Math.max(100, motherWidth1D - lt - rightTrim1D);
                    setLeftTrim1D(lt);
                    setMaxWidth1D(Math.min(maxWidth1D, usable));
                    setMinWidth1D(Math.min(minWidth1D, usable));
                  }}
                />
                <NumberInput
                  min={0}
                  fallback={0}
                  className="field num"
                  aria-label="右修边"
                  value={rightTrim1D}
                  onValueChange={(rt) => {
                    const usable = Math.max(100, motherWidth1D - leftTrim1D - rt);
                    setRightTrim1D(rt);
                    setMaxWidth1D(Math.min(maxWidth1D, usable));
                    setMinWidth1D(Math.min(minWidth1D, usable));
                  }}
                />
              </div>
            </div>
            <div className="dc-field">
              <label>
                超产上限 <small>卷</small>
              </label>
              <NumberInput
                min={0}
                fallback={0}
                integer
                className="field num"
                value={overCap1D}
                onValueChange={setOverCap1D}
              />
            </div>
          </div>

          <div className="dc-grid-2">
            <div className="dc-field">
              <label>
                最小 / 最大组合宽 <small>mm</small>
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                <NumberInput
                  min={100}
                  fallback={100}
                  className="field num"
                  aria-label="最小组合宽"
                  value={minWidth1D}
                  onValueChange={setMinWidth1D}
                />
                <NumberInput
                  min={100}
                  fallback={100}
                  className="field num"
                  aria-label="最大组合宽"
                  value={maxWidth1D}
                  onValueChange={setMaxWidth1D}
                />
              </div>
            </div>
            <div className="dc-field">
              <label>
                幅宽步长 <small>mm</small>
              </label>
              <NumberInput
                min={1}
                fallback={10}
                className="field num"
                value={widthStep1D}
                onValueChange={setWidthStep1D}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
