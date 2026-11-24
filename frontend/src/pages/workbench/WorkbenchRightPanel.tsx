import React, { RefObject } from 'react';
import {
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingSchemeRun,
  StrategyJobRun
} from '../../store/useStudioStore';
import { SlittingProfile, SlittingWidthMode, StudioSettings } from '../../store/studioSettings';
import { fmtN } from '@static/app/js/util.js';
import {
  LastConfirmSummary,
  OverviewStats,
  SCENARIOS_2D,
  SolverStrategyDef
} from './workbenchTypes';
import { openEngineSettings } from './workbenchUtils';
import { SlittingConfigCard } from './SlittingConfigCard';

export interface WorkbenchRightPanelProps {
  rightPaneRef: RefObject<HTMLElement | null>;
  is2D: boolean;
  schemes2D: SavedScheme2D[];
  activeScheme2D: SavedScheme2D | null;
  activeScheme1D: SlittingSchemeRun | null;
  strategyRuns2D: StrategyJobRun[];
  runningSolve: boolean;
  confirmingScheme: boolean;
  lastConfirmSummary: LastConfirmSummary | null;
  onContinueAfterConfirm: () => void;
  onConfirmSelectedScheme2D: () => void;
  onConfirmSelectedScheme1D: () => void;
  onQuickExportCam: (kind: 'dxf' | 'nc') => void;
  onStopSolve: () => void;
  onRunSolve2D: () => void;
  onRunSolve1D: () => void;

  // Scenario & display
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  scenario2D: Scenario2DType;
  setScenario2D: (sc: Scenario2DType) => void;
  scenario1D: Scenario1DType;
  setScenario1D: (sc: Scenario1DType) => void;
  overviewStats: OverviewStats;
  effectiveRollWidthMm: number;
  activeAlgos: SolverStrategyDef[];

  // 1D config
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitProfile: SlittingProfile;
  slitWidthMode: SlittingWidthMode;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  currentRoll1D: any;
  setSlitSpec: (spec: Record<string, any>) => void;
  settings: StudioSettings;
  updateStudioSettings: (next: StudioSettings) => void;
}

export const WorkbenchRightPanel: React.FC<WorkbenchRightPanelProps> = ({
  rightPaneRef,
  is2D,
  schemes2D,
  activeScheme2D,
  activeScheme1D,
  strategyRuns2D,
  runningSolve,
  confirmingScheme,
  lastConfirmSummary,
  onContinueAfterConfirm,
  onConfirmSelectedScheme2D,
  onConfirmSelectedScheme1D,
  onQuickExportCam,
  onStopSolve,
  onRunSolve2D,
  onRunSolve1D,
  canvasMode,
  scenario2D,
  setScenario2D,
  scenario1D,
  setScenario1D,
  overviewStats,
  effectiveRollWidthMm,
  activeAlgos,
  slitMaterialMode,
  slitProfile,
  slitWidthMode,
  slitMotherWidthMm,
  slitLeftTrimMm,
  slitRightTrimMm,
  slitMinWidthMm,
  slitMaxWidthMm,
  slitWidthStepMm,
  slitOverCap,
  currentRoll1D,
  setSlitSpec,
  settings,
  updateStudioSettings
}) => {
  return (
    <section ref={rightPaneRef} className="pane studio-right">
      <div className="pane-h">
        <span>方案</span>
        <span className="sp" />
        {is2D && schemes2D.length > 0 && (
          <span className="tag kind num">{schemes2D.length} 套</span>
        )}
      </div>

      <div className="pane-b">
        {/* Post-Confirm Continuation Banner */}
        {lastConfirmSummary && (
          <div className="wb-confirm-banner">
            <div>
              <span className="tag ok" style={{ marginRight: 6 }}>
                已落库
              </span>
              <b className="num">{lastConfirmSummary.schemeId}</b>
            </div>
            <div>
              {lastConfirmSummary.openRemaining > 0
                ? `剩余 ${lastConfirmSummary.openRemaining} 件待排，可继续排下一卷`
                : '当前需求族待排量已全部排齐'}
            </div>
            <div style={{ display: 'flex', gap: 6, width: '100%' }}>
              <a
                className="btn sm pri"
                style={{ flex: 1, justifyContent: 'center' }}
                href={`#/results/${encodeURIComponent(lastConfirmSummary.schemeId)}`}
              >
                去结果管理查看/导出
              </a>
              {lastConfirmSummary.openRemaining > 0 && (
                <button type="button" className="btn sm" onClick={onContinueAfterConfirm}>
                  继续排
                </button>
              )}
            </div>
          </div>
        )}

        {/* Active Candidate Decision Card */}
        {is2D && activeScheme2D ? (
          <div className="value-hero-panel">
            <div className="value-hero-head">
              <div className="value-hero-title">{activeScheme2D.strategyName}</div>
              <span className={`tag ${activeScheme2D.complete ? 'ok' : 'kind'}`}>
                {activeScheme2D.complete ? '齐套' : '部分排入'}
              </span>
            </div>

            <div className="value-kpi-grid num">
              <div className="value-kpi-cell highlight">
                <small>利用率</small>
                <b>
                  {activeScheme2D.utilizationPct}
                  <em>%</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>实占长度</small>
                <b>
                  {fmtN(activeScheme2D.occupiedLengthMm, 1)}
                  <em>mm</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>已排件数</small>
                <b>
                  {activeScheme2D.placedCount}
                  <em>/ {activeScheme2D.requestedCount}</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>母卷</small>
                <b style={{ fontSize: 12.5 }}>
                  {activeScheme2D.canvasMode === 'FREE_CANVAS'
                    ? `W${activeScheme2D.widthMm}`
                    : activeScheme2D.rollId || activeScheme2D.remnantId}
                </b>
              </div>
            </div>

            <div className="value-actions">
              <button
                type="button"
                className="btn pri value-primary-cta"
                disabled={confirmingScheme}
                onClick={onConfirmSelectedScheme2D}
              >
                {confirmingScheme
                  ? '正在保存并扣减…'
                  : activeScheme2D.confirmedSchemeId
                  ? `已选定 (${activeScheme2D.confirmedSchemeId}) · 查看结果`
                  : '选定此方案（扣减需求并保存结果）'}
              </button>
              <div className="value-export-row">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => onQuickExportCam('dxf')}
                >
                  导出 DXF
                </button>
                <button type="button" className="btn sm" onClick={() => onQuickExportCam('nc')}>
                  导出 G-Code
                </button>
              </div>
            </div>
          </div>
        ) : !is2D && activeScheme1D && activeScheme1D.state === 'SUCCEEDED' ? (
          <div className="value-hero-panel">
            <div className="value-hero-head">
              <div className="value-hero-title">{activeScheme1D.strategyName}</div>
              <span className="tag ok">已验证</span>
            </div>

            <div className="value-kpi-grid num">
              <div className="value-kpi-cell highlight">
                <small>利用率</small>
                <b>
                  {activeScheme1D.avgUtilizationPct}
                  <em>%</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>排产车数</small>
                <b>
                  {activeScheme1D.totalCars}
                  <em>车</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>缺口 / 超产</small>
                <b>
                  {activeScheme1D.missingRolls}/{activeScheme1D.overproducedRolls}
                  <em>卷</em>
                </b>
              </div>
              <div className="value-kpi-cell">
                <small>母卷</small>
                <b style={{ fontSize: 12.5 }}>
                  {slitMaterialMode === 'VIRTUAL_ROLL'
                    ? `W${activeScheme1D.motherWidthMm}`
                    : currentRoll1D?.rollId || '实卷'}
                </b>
              </div>
            </div>

            <div className="value-actions">
              <button
                type="button"
                className="btn pri value-primary-cta"
                disabled={confirmingScheme}
                onClick={onConfirmSelectedScheme1D}
              >
                {confirmingScheme
                  ? '正在保存并扣减…'
                  : activeScheme1D.confirmedSchemeId
                  ? `已选定 (${activeScheme1D.confirmedSchemeId}) · 查看结果`
                  : '选定此方案（扣减需求并保存结果）'}
              </button>
            </div>
          </div>
        ) : null}

        {/* Live Solve Progress Strip (also persists failure/empty feedback after solving stops) */}
        {is2D &&
          strategyRuns2D.length > 0 &&
          (runningSolve ||
            (!activeScheme2D &&
              strategyRuns2D.some(
                (r) => r.state === 'FAILED' || r.state === 'TIMED_OUT' || r.placedCount === 0
              ))) && (
            <div className="wb-solve-progress">
              {strategyRuns2D.map((r) => (
                <div key={r.strategyId} className="wb-solve-progress-row">
                  <span className="wb-solve-progress-name">{r.strategyName}</span>
                  <span
                    className="wb-solve-progress-phase num"
                    style={
                      r.state === 'FAILED' || r.state === 'TIMED_OUT'
                        ? { color: '#dc2626' }
                        : undefined
                    }
                  >
                    {r.phaseText}
                  </span>
                </div>
              ))}
            </div>
          )}

        {/* 1D Full Solartron-Cut Parameter Config Section (always visible in 1D mode) */}
        {!is2D && (
          <SlittingConfigCard
            slitProfile={slitProfile}
            slitWidthMode={slitWidthMode}
            slitMotherWidthMm={slitMotherWidthMm}
            slitLeftTrimMm={slitLeftTrimMm}
            slitRightTrimMm={slitRightTrimMm}
            slitMinWidthMm={slitMinWidthMm}
            slitMaxWidthMm={slitMaxWidthMm}
            slitWidthStepMm={slitWidthStepMm}
            slitOverCap={slitOverCap}
            setSlitSpec={setSlitSpec}
            settings={settings}
            updateStudioSettings={updateStudioSettings}
          />
        )}

        {/* Clean Solving Goal Selector */}
        <div className="wb-right-section">
          <div className="wb-right-section-head">
            <span>求解目标</span>
          </div>
          <div className="wb-goal-list">
            {is2D ? (
              SCENARIOS_2D.map((sc) => {
                const disabled = sc.id === 'MULTI_WIDTH' && canvasMode !== 'FREE_CANVAS';
                return (
                  <label
                    key={sc.id}
                    className="wb-goal-item"
                    style={disabled ? { opacity: 0.5 } : undefined}
                  >
                    <input
                      type="radio"
                      name="scenario2d"
                      disabled={disabled}
                      checked={scenario2D === sc.id}
                      onChange={() => setScenario2D(sc.id)}
                    />
                    <div className="wb-goal-body">
                      <div className="wb-goal-title">{sc.label}</div>
                      <div className="wb-goal-desc">{sc.desc}</div>
                    </div>
                  </label>
                );
              })
            ) : (
              <>
                <label className="wb-goal-item">
                  <input
                    type="radio"
                    name="scenario1d"
                    checked={scenario1D === 'MIN_CARS'}
                    onChange={() => setScenario1D('MIN_CARS')}
                  />
                  <div className="wb-goal-body">
                    <div className="wb-goal-title">最少换刀车数</div>
                    <div className="wb-goal-desc">控制超产上限，减少上机换刀次数</div>
                  </div>
                </label>
                <label className="wb-goal-item">
                  <input
                    type="radio"
                    name="scenario1d"
                    checked={scenario1D === 'MAX_UTIL'}
                    onChange={() => setScenario1D('MAX_UTIL')}
                  />
                  <div className="wb-goal-body">
                    <div className="wb-goal-title">最高幅宽利用率</div>
                    <div className="wb-goal-desc">适度放宽超产以减少窄边余料</div>
                  </div>
                </label>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sticky Bottom-Right Primary Action Bar */}
      <div className="studio-right-foot">
        <div className="studio-right-foot-meta num">
          <span>
            待排{' '}
            <b>
              {overviewStats.uncut > 0 ? overviewStats.uncut : overviewStats.ordered}
              {overviewStats.unit}
            </b>{' '}
            · W
            {is2D
              ? effectiveRollWidthMm
              : slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
              ? currentRoll1D.width
              : slitMotherWidthMm}
          </span>
          {is2D ? (
            <button type="button" className="wb-algo-config-link" onClick={openEngineSettings}>
              已启 {activeAlgos.length} 算法 · 配置
            </button>
          ) : (
            <button type="button" className="wb-algo-config-link" onClick={openEngineSettings}>
              {settings.slitRunBothProfiles ? '快/精双档' : slitProfile} · 高级参数
            </button>
          )}
        </div>
        <div className="studio-right-foot-btns">
          {runningSolve && (
            <button type="button" className="btn" onClick={onStopSolve}>
              停止
            </button>
          )}
          <button
            type="button"
            className="btn pri studio-solve-btn"
            style={{ flex: 1 }}
            disabled={runningSolve}
            onClick={is2D ? onRunSolve2D : onRunSolve1D}
          >
            {runningSolve ? '正在排版…' : '开始排版'}
          </button>
        </div>
      </div>
    </section>
  );
};
