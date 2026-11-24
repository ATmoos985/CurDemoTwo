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
  solveElapsedMs: number;
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
  solveElapsedMs,
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
            <div className="wb-confirm-head">
              <span className="tag ok">已落库</span>
              <b className="num">{lastConfirmSummary.schemeId}</b>
              <span className="sp" />
              <span className="num wb-confirm-rem">
                {lastConfirmSummary.openRemaining > 0
                  ? `余 ${lastConfirmSummary.openRemaining} 件`
                  : '已排齐'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, width: '100%' }}>
              <a
                className="btn sm pri"
                style={{ flex: 1, justifyContent: 'center' }}
                href={`#/results/${encodeURIComponent(lastConfirmSummary.schemeId)}`}
              >
                查看结果
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
                {activeScheme2D.complete ? '齐套' : '部分'}
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
                title="扣减待排需求并保存至结果管理"
                onClick={onConfirmSelectedScheme2D}
              >
                {confirmingScheme
                  ? '保存中…'
                  : activeScheme2D.confirmedSchemeId
                  ? `查看结果 · ${activeScheme2D.confirmedSchemeId}`
                  : '选定此方案'}
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
                title="扣减待排需求并保存至结果管理"
                onClick={onConfirmSelectedScheme1D}
              >
                {confirmingScheme
                  ? '保存中…'
                  : activeScheme1D.confirmedSchemeId
                  ? `查看结果 · ${activeScheme1D.confirmedSchemeId}`
                  : '选定此方案'}
              </button>
            </div>
          </div>
        ) : null}

        {/* Live Solve Progress Strip (minimal status dots + live metrics, zero verbose copy) */}
        {is2D &&
          strategyRuns2D.length > 0 &&
          (runningSolve ||
            (!activeScheme2D &&
              strategyRuns2D.some(
                (r) => r.state === 'FAILED' || r.state === 'TIMED_OUT' || r.placedCount === 0
              ))) && (() => {
            const doneCount = strategyRuns2D.filter(
              (r) => r.state !== 'QUEUED' && r.state !== 'RUNNING'
            ).length;
            const pct = Math.round((doneCount / strategyRuns2D.length) * 100);
            const liveSec = `${(solveElapsedMs / 1000).toFixed(1)}s`;
            return (
              <div className="wb-solve-progress">
                {runningSolve && (
                  <div className="wb-solve-bar" aria-hidden="true">
                    <i style={{ width: `${Math.max(8, pct)}%` }} />
                  </div>
                )}
                {strategyRuns2D.map((r) => {
                  const isRunning = r.state === 'RUNNING';
                  const isQueued = r.state === 'QUEUED';
                  const isOk = r.state === 'SUCCEEDED' && (r.placedCount ?? 0) > 0;
                  const isErr =
                    r.state === 'FAILED' ||
                    r.state === 'TIMED_OUT' ||
                    (r.state === 'SUCCEEDED' && (r.placedCount ?? 0) === 0);
                  const dotClass = isRunning
                    ? 'is-running'
                    : isOk
                    ? 'is-ok'
                    : isErr
                    ? 'is-err'
                    : 'is-queued';
                  const rightText = isRunning
                    ? liveSec
                    : isQueued
                    ? ''
                    : r.phaseText;
                  return (
                    <div
                      key={r.strategyId}
                      className="wb-solve-progress-row"
                      title={r.errorDetail || r.description}
                    >
                      <i className={`wb-status-dot ${dotClass}`} aria-hidden="true" />
                      <span className="wb-solve-progress-name">{r.strategyName}</span>
                      <span
                        className={`wb-solve-progress-phase num ${
                          isErr ? 'is-err' : isOk ? 'is-ok' : ''
                        }`}
                      >
                        {rightText}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}

        {/* 1D Full Parameter Config Section */}
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

        {/* Compact Solving Goal Selector (self-explanatory labels, tooltips on hover) */}
        <div className="wb-right-section">
          <div className="wb-right-section-head">
            <span>求解目标</span>
          </div>
          {is2D ? (
            <div className="wb-goal-grid" role="radiogroup" aria-label="二维求解目标">
              {SCENARIOS_2D.map((sc) => {
                const disabled = sc.id === 'MULTI_WIDTH' && canvasMode !== 'FREE_CANVAS';
                const checked = scenario2D === sc.id;
                return (
                  <button
                    key={sc.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={disabled}
                    title={sc.desc}
                    className={`wb-goal-pill ${checked ? 'on' : ''}`}
                    onClick={() => setScenario2D(sc.id)}
                  >
                    {sc.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="seg" role="radiogroup" aria-label="一维求解目标" style={{ width: '100%' }}>
              <button
                type="button"
                role="radio"
                aria-checked={scenario1D === 'MIN_CARS'}
                title="控制超产上限，减少上机换刀车数"
                className={scenario1D === 'MIN_CARS' ? 'on' : ''}
                onClick={() => setScenario1D('MIN_CARS')}
              >
                最少车数
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={scenario1D === 'MAX_UTIL'}
                title="适度放宽超产以提升幅宽利用率"
                className={scenario1D === 'MAX_UTIL' ? 'on' : ''}
                onClick={() => setScenario1D('MAX_UTIL')}
              >
                最高利用
              </button>
            </div>
          )}
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
            <button
              type="button"
              className="wb-algo-config-link"
              title="配置二维求解算法"
              onClick={openEngineSettings}
            >
              {activeAlgos.length} 算法 ↗
            </button>
          ) : (
            <button
              type="button"
              className="wb-algo-config-link"
              title="配置一维求解参数"
              onClick={openEngineSettings}
            >
              {settings.slitRunBothProfiles ? '双档' : slitProfile === 'FAST' ? '快捷' : '精确'} ↗
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
            {runningSolve ? '计算中…' : '开始排版'}
          </button>
        </div>
      </div>
    </section>
  );
};
