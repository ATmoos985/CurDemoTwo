import React from 'react';
import { toast, fmtN } from '../../lib/core/util.js';
import {
  DEFAULT_SLITTING_SOLVER_SETTINGS,
  SlittingProfile,
  StudioSettings,
  WORKBENCH_STRATEGIES_2D
} from '../../store/studioSettings';
import { NumberInput } from '../ui/NumberInput';
import { formatEngineDisplayName, formatEngineModeLabel } from './settingsMeta';

export interface SettingsEnginesTabProps {
  panelRef: (el: HTMLDivElement | null) => void;
  draft: StudioSettings;
  patchDraft: (patch: Partial<StudioSettings>) => void;
  cap: any;
  capLoading: boolean;
  capError: string | null;
  allEngines: any[];
  onRefreshStatus: () => void;
  onToggleStrategy: (strategyId: string, nextChecked: boolean) => void;
}

export const SettingsEnginesTab: React.FC<SettingsEnginesTabProps> = ({
  panelRef,
  draft,
  patchDraft,
  cap,
  capLoading,
  capError,
  allEngines,
  onRefreshStatus,
  onToggleStrategy
}) => {
  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="settings-tab-engines"
      className="sc-panel"
    >
      <div className="sc-panel-inner">
        <div className="sc-pane-bar">
          <h2>求解内核与并发配额</h2>
          <button
            type="button"
            className="btn sm"
            disabled={capLoading}
            onClick={onRefreshStatus}
          >
            {capLoading ? '检测中…' : '↻ 刷新能力'}
          </button>
        </div>

        <div className="sc-engine-top">
          <div className="sc-kpis">
            <div className="sc-kpi">
              <span>并发线程</span>
              <strong className="num ok">{cap?.limits?.workers ?? '—'}</strong>
            </div>
            <div className="sc-kpi">
              <span>队列容量</span>
              <strong className="num">{cap?.limits?.queueCapacity ?? '—'}</strong>
            </div>
            <div className="sc-kpi">
              <span>异形上限</span>
              <strong className="num">{fmtN(cap?.limits?.maxContourPieces ?? 0)}</strong>
            </div>
            <div className="sc-kpi">
              <span>矩形上限</span>
              <strong className="num">{fmtN(cap?.limits?.maxPieces ?? 0)}</strong>
            </div>
          </div>

          <div className="sc-engine-budget">
            <div className="sc-budget-item">
              <label htmlFor="s-time">基准时限</label>
              <div className="width-quick-pills" role="group" aria-label="时限快捷档">
                {[3, 5, 10, 30].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={draft.timeLimitSeconds === sec ? 'on' : ''}
                    aria-pressed={draft.timeLimitSeconds === sec}
                    onClick={() => patchDraft({ timeLimitSeconds: sec })}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
              <div className="settings-unit-input">
                <NumberInput
                  id="s-time"
                  min={1}
                  max={60}
                  step={1}
                  integer
                  className="field num"
                  style={{ width: 54 }}
                  value={draft.timeLimitSeconds}
                  onValueChange={(v) => patchDraft({ timeLimitSeconds: v })}
                />
                <span>s</span>
              </div>
            </div>

            <label className="sc-budget-fallback">
              <span>主引擎不可用时自动切换备用引擎</span>
              <input
                type="checkbox"
                role="switch"
                {...({ switch: '' } as any)}
                className="ux-switch"
                checked={draft.allowFallback}
                onChange={(e) => patchDraft({ allowFallback: e.target.checked })}
              />
            </label>
          </div>
        </div>

        <section className="sc-card">
          <div className="sc-card-head">
            <span>二维并行排料策略</span>
            <code className="sc-code-pill num">
              已启用 {draft.enabledStrategies2D.length} / {WORKBENCH_STRATEGIES_2D.length}
            </code>
          </div>

          {WORKBENCH_STRATEGIES_2D.map((st) => {
            const enabled = draft.enabledStrategies2D.includes(st.id);
            const inputId = `cfg-strategy-${st.id}`;
            return (
              <label
                key={st.id}
                htmlFor={inputId}
                className="sc-switch-row"
                data-strategy-id={st.id}
              >
                <span className="sc-switch-label">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{st.name}</strong>
                    <span
                      className="sc-code-pill num"
                      style={{ fontSize: 10.5, padding: '1px 7px', lineHeight: 1.5 }}
                    >
                      {st.badge}
                    </span>
                  </span>
                  <code className="num">{st.shortTag}</code>
                </span>
                <input
                  id={inputId}
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={enabled}
                  onChange={(e) => onToggleStrategy(st.id, e.target.checked)}
                />
              </label>
            );
          })}
        </section>

        <section className="sc-card" id="cfg-slitting-1d-card">
          <div className="sc-card-head">
            <span>一维分切求解参数</span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <code className="sc-code-pill num">
                {draft.slitProfile === 'QUALITY' ? '精确解' : '快捷解'}
              </code>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  patchDraft({ ...DEFAULT_SLITTING_SOLVER_SETTINGS });
                  toast('已恢复一维分切默认参数');
                }}
              >
                恢复一维默认
              </button>
            </div>
          </div>

          <div className="sc-ctrl-row compact">
            <strong>默认求解档位</strong>
            <div className="seg" role="group" aria-label="一维默认求解档位">
              <button
                type="button"
                className={draft.slitProfile === 'FAST' ? 'on' : ''}
                aria-pressed={draft.slitProfile === 'FAST'}
                onClick={() => patchDraft({ slitProfile: 'FAST' as SlittingProfile })}
              >
                快捷解
              </button>
              <button
                type="button"
                className={draft.slitProfile === 'QUALITY' ? 'on' : ''}
                aria-pressed={draft.slitProfile === 'QUALITY'}
                onClick={() => patchDraft({ slitProfile: 'QUALITY' as SlittingProfile })}
              >
                精确解
              </button>
            </div>
          </div>

          <div className="sc-slit-profile-note">
            {draft.slitProfile === 'QUALITY'
              ? '精确解：多候选深度寻优，优先压低排产车数与换刀组数。'
              : '快捷解：轻量快速求解，优先在较短时间内产出稳定方案。'}
          </div>

          <label className="sc-switch-row" htmlFor="cfg-slit-run-both">
            <span className="sc-switch-label">
              <strong>工作台同时对照快捷解与精确解</strong>
              <code className="num">关闭时仅运行所选档位，响应更快</code>
            </span>
            <input
              id="cfg-slit-run-both"
              type="checkbox"
              role="switch"
              {...({ switch: '' } as any)}
              className="ux-switch"
              checked={draft.slitRunBothProfiles}
              onChange={(e) => patchDraft({ slitRunBothProfiles: e.target.checked })}
            />
          </label>

          <div className="sc-ctrl-row compact">
            <label htmlFor="cfg-slit-time">
              <strong>一维总求解时限</strong>
              <span className="num muted">1 – 180 秒</span>
            </label>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <div className="width-quick-pills" role="group" aria-label="一维时限快捷档">
                {[10, 30, 60, 120, 180].map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    className={draft.slitTimeLimitSeconds === sec ? 'on' : ''}
                    aria-pressed={draft.slitTimeLimitSeconds === sec}
                    onClick={() => patchDraft({ slitTimeLimitSeconds: sec })}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
              <div className="settings-unit-input">
                <NumberInput
                  id="cfg-slit-time"
                  min={1}
                  max={180}
                  step={1}
                  integer
                  className="field num"
                  style={{ width: 60 }}
                  value={draft.slitTimeLimitSeconds}
                  onValueChange={(v) => patchDraft({ slitTimeLimitSeconds: v })}
                />
                <span>s</span>
              </div>
            </div>
          </div>

          <div className="sc-slit-grid">
            <div className="sc-slit-field">
              <label htmlFor="cfg-slit-topk">TOP K 超产宽度</label>
              <NumberInput
                id="cfg-slit-topk"
                min={0}
                max={50}
                integer
                className="field num"
                value={draft.slitTopK}
                onValueChange={(v) => patchDraft({ slitTopK: v })}
              />
              <small>允许超产的前 K 个大需求宽幅（默认 3）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-slit-max-iter">最大迭代轮次</label>
              <NumberInput
                id="cfg-slit-max-iter"
                min={1}
                max={5000}
                step={10}
                integer
                className="field num"
                value={draft.slitMaxIterations}
                onValueChange={(v) => patchDraft({ slitMaxIterations: v })}
              />
              <small>方案生成循环上限（默认 300）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-slit-max-pat">最大花型池</label>
              <NumberInput
                id="cfg-slit-max-pat"
                min={1}
                max={20000}
                step={50}
                integer
                className="field num"
                value={draft.slitMaxPatterns}
                onValueChange={(v) => patchDraft({ slitMaxPatterns: v })}
              />
              <small>候选分切花型池上限（默认 800）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-slit-max-distinct">单卷不同宽幅上限</label>
              <NumberInput
                id="cfg-slit-max-distinct"
                min={1}
                max={20}
                integer
                className="field num"
                value={draft.slitMaxDistinctWidths}
                onValueChange={(v) => patchDraft({ slitMaxDistinctWidths: v })}
              />
              <small>单支母卷最多搭切不同规格数（默认 4）</small>
            </div>
            <div className="sc-slit-field span-2">
              <label htmlFor="cfg-slit-stage-ms">单阶段求解时限（毫秒）</label>
              <NumberInput
                id="cfg-slit-stage-ms"
                min={1000}
                max={600000}
                step={1000}
                integer
                className="field num"
                value={draft.slitStageTimeLimitMs}
                onValueChange={(v) => patchDraft({ slitStageTimeLimitMs: v })}
              />
              <small>单个求解阶段的安全上限（默认 120000 ms，受总求解时限约束）</small>
            </div>
          </div>

          <details className="sc-fold" style={{ marginTop: 6 }}>
            <summary>高级权重与搜索微调</summary>
            <div className="sc-slit-grid" style={{ marginTop: 8 }}>
              <label className="sc-switch-row span-2" htmlFor="cfg-slit-opt-assign">
                <span className="sc-switch-label">
                  <strong>启用最优换刀分配</strong>
                  <code className="num">优先压减换刀次数（默认开启）</code>
                </span>
                <input
                  id="cfg-slit-opt-assign"
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={draft.slitUseOptimizedAssignment}
                  onChange={(e) =>
                    patchDraft({ slitUseOptimizedAssignment: e.target.checked })
                  }
                />
              </label>
              <label className="sc-switch-row span-2" htmlFor="cfg-slit-lns">
                <span className="sc-switch-label">
                  <strong>启用深度邻域优化</strong>
                  <code className="num">仅精确解生效，大单会增加耗时</code>
                </span>
                <input
                  id="cfg-slit-lns"
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={draft.slitLnsEnabled}
                  onChange={(e) => patchDraft({ slitLnsEnabled: e.target.checked })}
                />
              </label>
              <div className="sc-slit-field">
                <label htmlFor="cfg-slit-under-pen">欠产惩罚系数</label>
                <NumberInput
                  id="cfg-slit-under-pen"
                  min={0}
                  step={10000}
                  className="field num"
                  value={draft.slitUnderPenalty}
                  onValueChange={(v) => patchDraft({ slitUnderPenalty: v })}
                />
              </div>
              <div className="sc-slit-field">
                <label htmlFor="cfg-slit-alpha">顺序组权重 α / β</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <NumberInput
                    id="cfg-slit-alpha"
                    min={0}
                    step={0.1}
                    className="field num"
                    aria-label="顺序组权重 alpha"
                    value={draft.slitSeqGroupAlpha}
                    onValueChange={(v) => patchDraft({ slitSeqGroupAlpha: v })}
                  />
                  <NumberInput
                    id="cfg-slit-beta"
                    min={0}
                    step={0.1}
                    className="field num"
                    aria-label="顺序组权重 beta"
                    value={draft.slitSeqGroupBeta}
                    onValueChange={(v) => patchDraft({ slitSeqGroupBeta: v })}
                  />
                </div>
              </div>
            </div>
          </details>
        </section>

        {capError && (
          <div id="capabilities-error" className="sc-alert-row">
            <span>读取失败：{capError}</span>
            <button type="button" className="btn sm" onClick={onRefreshStatus}>
              重试
            </button>
          </div>
        )}

        <section className="sc-card sc-table-card">
          {cap ? (
            <table className="sc-engine-table">
              <thead>
                <tr>
                  <th>求解引擎</th>
                  <th>运行状态</th>
                  <th>支持工艺</th>
                  <th className="r">坐标精度</th>
                </tr>
              </thead>
              <tbody id="engine-rows">
                {allEngines.map((e: any) => (
                  <tr key={e.id}>
                    <td className="sc-eng-id">{formatEngineDisplayName(e.id)}</td>
                    <td>
                      <span className={`sc-status-pill ${e.available ? 'ok' : 'err'}`}>
                        <i aria-hidden="true" />
                        {e.available ? '就绪' : '未就绪'}
                      </span>
                    </td>
                    <td>
                      <div className="sc-mode-tags">
                        {[...(e.modes || []), ...(e.shapes || [])].map((m: string) => (
                          <span key={m}>{formatEngineModeLabel(m)}</span>
                        ))}
                      </div>
                    </td>
                    <td className="r num">{e.coordinateResolutionMm} mm</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : !capError ? (
            <div className="loading">正在检测求解引擎…</div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
