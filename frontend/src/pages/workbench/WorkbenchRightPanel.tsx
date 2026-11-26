import React, { RefObject } from 'react';
import {
  CanvasMode2D,
  MultiMaterialRunSummary,
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingSchemeRun,
  StrategyJobRun
} from '../../store/useStudioStore';
import { SlittingProfile, SlittingWidthMode, StudioSettings } from '../../store/studioSettings';
import { fmtN } from '../../lib/core/util.js';
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
  setActiveScheme2D: (id: string) => void;
  strategyRuns2D: StrategyJobRun[];
  runningSolve: boolean;
  solveElapsedMs: number;
  confirmingScheme: boolean;
  validatingLayout: boolean;
  lastConfirmSummary: LastConfirmSummary | null;
  onContinueAfterConfirm: () => void;
  onValidateAndRebuildLayout: () => void;
  onConfirmSelectedScheme2D: () => void;
  onConfirmSelectedScheme1D: () => void;
  onQuickExportCam: (kind: 'dxf' | 'nc') => void;
  onExportMultiMaterialCsv?: () => void;
  onStopSolve: () => void;
  onRunSolve2D: () => void;
  onRunSolve1D: () => void;

  // Scenario & display
  canvasMode: CanvasMode2D;
  multiPreferRemnants?: boolean;
  multiMaxRemnants?: number;
  multiCandidateRollCount?: number;
  multiMaterialSummary?: MultiMaterialRunSummary | null;
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
  slitMaxKnives: number;
  slitMinBladeSpacingMm: number;
  slitKerfMm: number;
  slitForbiddenNarrowEdgeMinMm: number;
  slitForbiddenNarrowEdgeMaxMm: number;
  currentRoll1D: any;
  setSlitSpec: (spec: Record<string, any>) => void;
  settings: StudioSettings;
  updateStudioSettings: (next: StudioSettings) => void;
  /** 当前激活 2D 已确认方案的报工与复检实绩摘要（仅存在报工时传入）。 */
  activeSchemeExecutionSummary?: {
    reportCount: number;
    netQualifiedCount: number;
    reinspectedCount: number;
    rejectedTotalCount: number;
  } | null;
}

export const WorkbenchRightPanel: React.FC<WorkbenchRightPanelProps> = ({
  rightPaneRef,
  is2D,
  schemes2D,
  activeScheme2D,
  activeScheme1D,
  setActiveScheme2D,
  strategyRuns2D,
  runningSolve,
  solveElapsedMs,
  confirmingScheme,
  validatingLayout,
  lastConfirmSummary,
  onContinueAfterConfirm,
  onValidateAndRebuildLayout,
  onConfirmSelectedScheme2D,
  onConfirmSelectedScheme1D,
  onQuickExportCam,
  onExportMultiMaterialCsv,
  onStopSolve,
  onRunSolve2D,
  onRunSolve1D,
  canvasMode,
  multiPreferRemnants = true,
  multiMaxRemnants = 6,
  multiCandidateRollCount = 0,
  multiMaterialSummary = null,
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
  slitMaxKnives,
  slitMinBladeSpacingMm,
  slitKerfMm,
  slitForbiddenNarrowEdgeMinMm,
  slitForbiddenNarrowEdgeMaxMm,
  currentRoll1D,
  setSlitSpec,
  settings,
  updateStudioSettings,
  activeSchemeExecutionSummary
}) => {
  const multiSchemes2D = is2D
    ? schemes2D.filter((s) => Boolean(s.multiMaterialRole))
    : [];
  const showMultiMaterialPanel =
    is2D && (Boolean(multiMaterialSummary) || multiSchemes2D.length > 0);

  return (
    <section ref={rightPaneRef} className="pane studio-right">
      <div className="pane-h">
        <span>{canvasMode === 'MULTI_MATERIAL' ? '联排方案' : '方案'}</span>
        <span className="sp" />
        {is2D && schemes2D.length > 0 && (
          <span className="tag kind num">{schemes2D.length} 套</span>
        )}
      </div>

      <div className="pane-b">
        {/* 多料联排顶部紧凑汇总卡 */}
        {is2D && multiMaterialSummary && (
          <div className="wb-multi-summary-card" role="region" aria-label="多料联排总览">
            <div className="wb-multi-summary-head">
              <span>多料联排总览</span>
              <span className="tag kind num">{multiMaterialSummary.elapsedMs}ms</span>
              <span className="sp" />
              {onExportMultiMaterialCsv && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={onExportMultiMaterialCsv}
                  title="导出料头接力与多母卷比选明细 CSV"
                >
                  导出联排 CSV
                </button>
              )}
            </div>

            <div className="wb-multi-summary-grid num">
              <div className="wb-multi-kpi">
                <small>料头接力</small>
                <b>
                  {multiMaterialSummary.placedByRemnants}
                  <em>件</em>
                </b>
              </div>
              <div className="wb-multi-kpi">
                <small>推荐母卷</small>
                <b>
                  {multiMaterialSummary.placedByRoll}
                  <em>件</em>
                </b>
              </div>
              <div className="wb-multi-kpi is-save">
                <small>预计节料</small>
                <b>
                  {fmtN(multiMaterialSummary.totalSavedAreaM2, 2)}
                  <em>m²</em>
                </b>
              </div>
            </div>

            <div className="wb-multi-summary-foot num">
              <span>
                共 {multiMaterialSummary.remnantCount} 块料头 ·{' '}
                {multiMaterialSummary.feasibleRollCount} 卷可齐套母卷
              </span>
              {multiMaterialSummary.unplacedPieces > 0 ? (
                <span className="tag warn">余 {multiMaterialSummary.unplacedPieces} 件未排</span>
              ) : (
                <span className="tag ok">全单可排齐</span>
              )}
            </div>

            {multiMaterialSummary.warnings.length > 0 && (
              <ul className="wb-multi-warn-list">
                {multiMaterialSummary.warnings.slice(0, 3).map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}

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

        {/* 多料联排可点击料头/母卷方案列表（点选即刻切换四层 CAD 画布） */}
        {showMultiMaterialPanel && multiSchemes2D.length > 0 && (
          <div className="wb-right-section" role="region" aria-label="多料联排候选方案列表">
            <div className="wb-right-section-head">
              <span>点击切换料头 / 母卷画布预览</span>
              <span className="num">{multiSchemes2D.length} 料</span>
            </div>
            <div className="wb-multi-scheme-list">
              {multiSchemes2D.map((s) => {
                const isSelected = activeScheme2D?.id === s.id;
                const isRemnant = s.multiMaterialRole === 'REMNANT_RELAY';
                const isRecRoll = s.multiMaterialRole === 'ROLL_RECOMMENDED';
                const cardHeading = isRemnant
                  ? s.title
                  : s.strategyName;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`wb-multi-scheme-item ${isSelected ? 'on' : ''}`}
                    aria-pressed={isSelected}
                    onClick={() => setActiveScheme2D(s.id)}
                  >
                    <div className="wb-multi-scheme-top">
                      <span className="wb-multi-scheme-name" title={cardHeading}>
                        {cardHeading}
                      </span>
                      {isRecRoll && <span className="tag ok">推荐</span>}
                      {isRemnant && <span className="tag kind">料头</span>}
                      {s.confirmedSchemeId && <span className="tag run">已选定</span>}
                    </div>
                    <div className="wb-multi-scheme-meta num">
                      <span>
                        {isRemnant
                          ? `${fmtN(s.widthMm, 0)}×${fmtN(s.canvasLengthMm, 0)} mm`
                          : `W${fmtN(s.widthMm, 0)} · 切 ${fmtN(s.occupiedLengthMm, 0)} mm`}
                      </span>
                      <span>
                        排入 <b>{s.placedCount}</b> 件 · <b>{s.utilizationPct}%</b>
                      </span>
                    </div>
                    {(s.allocatedSummary ||
                      (!isRemnant && (s.windowStartY || 0) > 0) ||
                      s.batchNo ||
                      s.color) && (
                      <div className="wb-multi-scheme-sub num">
                        {isRemnant && s.allocatedSummary ? s.allocatedSummary : ''}
                        {!isRemnant && (s.windowStartY || 0) > 0
                          ? `起切 Y=${fmtN(s.windowStartY || 0, 1)}mm`
                          : ''}
                        {s.batchNo ? ` · 缸号 ${s.batchNo}` : ''}
                        {s.color ? ` · ${s.color}` : ''}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Active Candidate Decision Card */}
        {is2D && activeScheme2D ? (
          <div className="value-hero-panel">
            <div className="value-hero-head">
              <div className="value-hero-title">{activeScheme2D.strategyName}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {activeScheme2D.multiMaterialRole === 'ROLL_RECOMMENDED' && (
                  <span className="tag ok">推荐</span>
                )}
                {activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId && (
                  <span className="tag warn">待校验</span>
                )}
                <span className={`tag ${activeScheme2D.complete ? 'ok' : 'kind'}`}>
                  {activeScheme2D.complete ? '齐套' : '部分'}
                </span>
              </div>
            </div>

            {activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId && (
              <div className="wb-dirty-banner" role="status">
                <div className="wb-dirty-banner-title">已手调，需校验并重建刀路</div>
                {activeScheme2D.layoutValidationErrors &&
                  activeScheme2D.layoutValidationErrors.length > 0 && (
                    <ul className="wb-dirty-error-list">
                      {activeScheme2D.layoutValidationErrors.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  )}
                <button
                  type="button"
                  className="btn sm soft-accent"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={validatingLayout}
                  onClick={onValidateAndRebuildLayout}
                >
                  {validatingLayout ? '校验重建中…' : '校验并重建刀路'}
                </button>
              </div>
            )}

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

            {activeScheme2D.confirmedSchemeId &&
              activeSchemeExecutionSummary &&
              activeSchemeExecutionSummary.reportCount > 0 && (
                <div
                  className="num"
                  role="status"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    padding: '6px 8px',
                    borderRadius: 4,
                    fontSize: 11.5,
                    background:
                      activeSchemeExecutionSummary.reinspectedCount > 0
                        ? 'var(--warn-bg, rgba(245, 158, 11, 0.14))'
                        : 'var(--ok-bg, rgba(16, 185, 129, 0.1))',
                    borderLeft: `3px solid ${
                      activeSchemeExecutionSummary.reinspectedCount > 0
                        ? 'var(--warn, #d97706)'
                        : 'var(--ok, #059669)'
                    }`
                  }}
                >
                  <span>
                    已报工：净合格 <b>{activeSchemeExecutionSummary.netQualifiedCount}</b> 片
                    {activeSchemeExecutionSummary.reinspectedCount > 0 && (
                      <>
                        {' '}
                        · 复检判废{' '}
                        <b style={{ color: 'var(--err, #dc2626)' }}>
                          {activeSchemeExecutionSummary.reinspectedCount}
                        </b>{' '}
                        片
                      </>
                    )}
                  </span>
                  <a href="#/reconciliation" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                    质检 ↗
                  </a>
                </div>
              )}

            <div className="value-actions">
              <button
                type="button"
                className="btn pri value-primary-cta"
                disabled={
                  confirmingScheme ||
                  Boolean(activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId)
                }
                title={
                  activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId
                    ? '已手调，需校验并重建刀路后才可选定此方案'
                    : '扣减待排需求并保存至结果管理'
                }
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
                <button
                  type="button"
                  className="btn sm"
                  disabled={Boolean(activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId)}
                  title={
                    activeScheme2D.layoutDirty && !activeScheme2D.confirmedSchemeId
                      ? '已手调，需校验并重建刀路后再导出 G-Code'
                      : undefined
                  }
                  onClick={() => onQuickExportCam('nc')}
                >
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
              {(activeScheme1D.estimatedKnifeChanges != null ||
                activeScheme1D.knifeChangesSaved != null) && (
                <>
                  <div className="value-kpi-cell">
                    <small>预计换刀</small>
                    <b>
                      {activeScheme1D.estimatedKnifeChanges ?? '—'}
                      <em>次</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>优化省换刀</small>
                    <b
                      style={
                        (activeScheme1D.knifeChangesSaved ?? 0) > 0
                          ? { color: 'var(--ok, #059669)' }
                          : undefined
                      }
                    >
                      {(activeScheme1D.knifeChangesSaved ?? 0) > 0
                        ? `省 ${activeScheme1D.knifeChangesSaved}`
                        : activeScheme1D.knifeChangesSaved ?? 0}
                      <em>次</em>
                    </b>
                  </div>
                </>
              )}
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

        {/* 1D Parameter Config Section */}
        {!is2D && (
          <SlittingConfigCard
            slitWidthMode={slitWidthMode}
            slitMotherWidthMm={
              slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
                ? currentRoll1D.width
                : slitMotherWidthMm
            }
            slitLeftTrimMm={slitLeftTrimMm}
            slitRightTrimMm={slitRightTrimMm}
            slitMinWidthMm={slitMinWidthMm}
            slitMaxWidthMm={slitMaxWidthMm}
            slitWidthStepMm={slitWidthStepMm}
            slitOverCap={slitOverCap}
            slitMaxKnives={slitMaxKnives}
            slitMinBladeSpacingMm={slitMinBladeSpacingMm}
            slitKerfMm={slitKerfMm}
            slitForbiddenNarrowEdgeMinMm={slitForbiddenNarrowEdgeMinMm}
            slitForbiddenNarrowEdgeMaxMm={slitForbiddenNarrowEdgeMaxMm}
            setSlitSpec={setSlitSpec}
            settings={settings}
            updateStudioSettings={updateStudioSettings}
          />
        )}

        {/* Compact Solving Strategy / Goal Card */}
        {is2D ? (
          canvasMode === 'MULTI_MATERIAL' ? (
            <div className="wb-multi-hint-card" role="region" aria-label="多料联排配置摘要">
              <div className="wb-multi-hint-row">
                <span>料头接力消化</span>
                <b className="num">
                  {multiPreferRemnants ? `优先 · 最多 ${multiMaxRemnants} 块` : '已关闭'}
                </b>
              </div>
              <div className="wb-multi-hint-row">
                <span>母卷对比范围</span>
                <b className="num">
                  {multiCandidateRollCount > 0
                    ? `指定 ${multiCandidateRollCount} 卷`
                    : '全部合格同型卷'}
                </b>
              </div>
              <div className="wb-multi-hint-row">
                <span>落库方式</span>
                <b>逐料预览 · 点选落库</b>
              </div>
            </div>
          ) : (
            <div className="wb-param-card">
              <div className="wb-param-head">
                <span>求解目标</span>
              </div>
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
            </div>
          )
        ) : (
          <div className="wb-param-card">
            <div className="wb-param-head">
              <span>求解策略</span>
            </div>
            <div className="seg" role="radiogroup" aria-label="一维求解档位">
              <button
                type="button"
                role="radio"
                aria-checked={!settings.slitRunBothProfiles && slitProfile === 'FAST'}
                title="仅运行快捷解，快速出图"
                className={!settings.slitRunBothProfiles && slitProfile === 'FAST' ? 'on' : ''}
                onClick={() => {
                  setSlitSpec({ slitProfile: 'FAST' });
                  if (settings.slitRunBothProfiles) {
                    updateStudioSettings({ ...settings, slitRunBothProfiles: false, slitProfile: 'FAST' });
                  }
                }}
              >
                快捷
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={!settings.slitRunBothProfiles && slitProfile === 'QUALITY'}
                title="仅运行精确解，深度压车"
                className={!settings.slitRunBothProfiles && slitProfile === 'QUALITY' ? 'on' : ''}
                onClick={() => {
                  setSlitSpec({ slitProfile: 'QUALITY' });
                  if (settings.slitRunBothProfiles) {
                    updateStudioSettings({ ...settings, slitRunBothProfiles: false, slitProfile: 'QUALITY' });
                  }
                }}
              >
                精确
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={settings.slitRunBothProfiles}
                title="并行运行快捷解与精确解，先出先看"
                className={settings.slitRunBothProfiles ? 'on' : ''}
                onClick={() => updateStudioSettings({ ...settings, slitRunBothProfiles: true })}
              >
                双档
              </button>
            </div>
            <div className="seg" role="radiogroup" aria-label="一维求解目标">
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
          </div>
        )}
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
            ·{' '}
            {is2D
              ? canvasMode === 'MULTI_MATERIAL' && !activeScheme2D
                ? '多料联排'
                : `W${effectiveRollWidthMm}`
              : `W${
                  slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
                    ? currentRoll1D.width
                    : slitMotherWidthMm
                }`}
          </span>
          {is2D ? (
            canvasMode === 'MULTI_MATERIAL' ? (
              <span className="wb-param-badge">只读评估</span>
            ) : (
              <button
                type="button"
                className="wb-algo-config-link"
                title="配置二维求解算法"
                onClick={openEngineSettings}
              >
                {activeAlgos.length} 算法 ↗
              </button>
            )
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
            {runningSolve
              ? is2D && canvasMode === 'MULTI_MATERIAL'
                ? '联排计算中…'
                : '计算中…'
              : is2D && canvasMode === 'MULTI_MATERIAL'
              ? '开始多料联排'
              : '开始排版'}
          </button>
        </div>
      </div>
    </section>
  );
};
