import React from 'react';
import { FirstStageOrientation, StudioSettings } from '../../store/studioSettings';
import { StepperNumberInput } from './settingsMeta';

export interface SettingsCraftTabProps {
  panelRef: (el: HTMLDivElement | null) => void;
  draft: StudioSettings;
  patchDraft: (patch: Partial<StudioSettings>) => void;
  industryPresets: any[];
  matchedPresetId: string | null | undefined;
  onApplyIndustryPreset: (preset: any) => void;
}

export const SettingsCraftTab: React.FC<SettingsCraftTabProps> = ({
  panelRef,
  draft,
  patchDraft,
  industryPresets,
  matchedPresetId,
  onApplyIndustryPreset
}) => {
  const trimVis = Math.min(28, Math.max(0, Math.round(draft.trimStartMm / 8)));
  const marginVis = Math.min(18, Math.max(2, Math.round(draft.defectMarginMm / 4)));
  const gapVis = Math.min(16, Math.max(2, Math.round(2 + draft.pieceGapMm * 0.6)));

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="settings-tab-craft"
      className="sc-panel"
    >
      <div className="sc-panel-inner">
        <div className="sc-pane-bar">
          <h2>裁切工艺与行业预设</h2>
          <span className={`sc-state-chip ${matchedPresetId ? 'ok' : ''}`}>
            {matchedPresetId
              ? `预设：${industryPresets.find((p) => p.id === matchedPresetId)?.name}`
              : '自定义工艺组合'}
          </span>
        </div>

        <div className="sc-preset-strip" role="group" aria-label="行业工艺预设">
          {industryPresets.map((preset: any) => {
            const active = matchedPresetId === preset.id;
            const v = preset.values || {};
            return (
              <button
                key={preset.id}
                type="button"
                className={`settings-preset-card sc-preset-tile ${active ? 'on' : ''}`}
                aria-pressed={active}
                onClick={() => onApplyIndustryPreset(preset)}
              >
                <div className="sc-preset-tile-head">
                  <strong>{preset.name}</strong>
                  {active && <span className="sc-preset-dot" aria-hidden="true" />}
                </div>
                <div className="sc-preset-chips num">
                  <span>避疵 {v.defectMargin}</span>
                  <span>切头 {v.trimStart}</span>
                  <span>{Number(v.allowRotation) === 1 ? '↻ 90°' : '0° 经向'}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="sc-two-col">
          <section className="sc-card">
            <div className="sc-card-head">
              <span>几何安全容差</span>
              <span className="muted num">精度 0.1 mm</span>
            </div>

            <div className="sc-ctrl-row">
              <label htmlFor="cfg-studio-margin">
                <strong>疵点避让外扩</strong>
                <span className="num muted">0 – 200 mm</span>
              </label>
              <StepperNumberInput
                id="cfg-studio-margin"
                value={draft.defectMarginMm}
                min={0}
                max={200}
                step={5}
                unit="mm"
                onChange={(v) => patchDraft({ defectMarginMm: v })}
              />
            </div>

            <div className="sc-ctrl-row">
              <label htmlFor="cfg-studio-trim">
                <strong>卷头修边切头</strong>
                <span className="num muted">0 – 1000 mm</span>
              </label>
              <StepperNumberInput
                id="cfg-studio-trim"
                value={draft.trimStartMm}
                min={0}
                max={1000}
                step={10}
                unit="mm"
                onChange={(v) => patchDraft({ trimStartMm: v })}
              />
            </div>

            <div className="sc-ctrl-row">
              <label htmlFor="cfg-studio-gap">
                <strong>裁片安全刀缝</strong>
                <span className="num muted">0 – 50 mm</span>
              </label>
              <StepperNumberInput
                id="cfg-studio-gap"
                value={draft.pieceGapMm}
                min={0}
                max={50}
                step={0.5}
                unit="mm"
                onChange={(v) => patchDraft({ pieceGapMm: v })}
              />
            </div>
          </section>

          <div className="sc-col-stack">
            <section className="sc-card sc-craft-vis-card">
              <div className="sc-card-head">
                <span>容差实时图解</span>
                <span className="num muted">
                  切头 {draft.trimStartMm} · 片距 {draft.pieceGapMm} · 避疵{' '}
                  {draft.defectMarginMm} mm
                </span>
              </div>
              <svg viewBox="0 0 280 98" className="sc-craft-svg" aria-hidden="true">
                <rect
                  x="10"
                  y="10"
                  width="260"
                  height="78"
                  rx="3"
                  fill="#0f172a"
                  stroke="#334155"
                />
                {trimVis > 0 && (
                  <rect
                    x="10"
                    y="10"
                    width={trimVis}
                    height="78"
                    fill="rgba(245,158,11,0.28)"
                    stroke="#f59e0b"
                    strokeDasharray="3 2"
                  />
                )}
                <rect
                  x={18 + trimVis}
                  y="20"
                  width="68"
                  height="56"
                  rx="2"
                  fill="rgba(56,189,248,0.2)"
                  stroke="#38bdf8"
                />
                <rect
                  x={18 + trimVis + 68 + gapVis}
                  y="20"
                  width="62"
                  height="56"
                  rx="2"
                  fill="rgba(56,189,248,0.2)"
                  stroke="#38bdf8"
                />
                <rect
                  x={216 - marginVis}
                  y={46 - marginVis}
                  width={16 + marginVis * 2}
                  height={12 + marginVis * 2}
                  rx="2"
                  fill="rgba(239,68,68,0.16)"
                  stroke="#ef4444"
                  strokeDasharray="3 2"
                />
                <circle cx="224" cy="52" r="4" fill="#ef4444" />
              </svg>
            </section>

            <section className="sc-card">
              <div className="sc-ctrl-row compact">
                <strong>首阶段直刀方向</strong>
                <div className="seg" role="group" aria-label="第一阶段直刀方向">
                  <button
                    type="button"
                    className={draft.firstStageOrientation === 'horizontal' ? 'on' : ''}
                    aria-pressed={draft.firstStageOrientation === 'horizontal'}
                    onClick={() =>
                      patchDraft({
                        firstStageOrientation: 'horizontal' as FirstStageOrientation
                      })
                    }
                  >
                    ━ 横切优先
                  </button>
                  <button
                    type="button"
                    className={draft.firstStageOrientation === 'vertical' ? 'on' : ''}
                    aria-pressed={draft.firstStageOrientation === 'vertical'}
                    onClick={() =>
                      patchDraft({
                        firstStageOrientation: 'vertical' as FirstStageOrientation
                      })
                    }
                  >
                    ┃ 纵切优先
                  </button>
                </div>
              </div>

              <div className="sc-ctrl-row compact">
                <strong>新建矩形件纹理</strong>
                <div className="seg" role="group" aria-label="默认旋转规则">
                  <button
                    type="button"
                    className={!draft.defaultAllowRotation ? 'on' : ''}
                    aria-pressed={!draft.defaultAllowRotation}
                    onClick={() => patchDraft({ defaultAllowRotation: false })}
                  >
                    0° 锁经向
                  </button>
                  <button
                    type="button"
                    className={draft.defaultAllowRotation ? 'on' : ''}
                    aria-pressed={draft.defaultAllowRotation}
                    onClick={() => patchDraft({ defaultAllowRotation: true })}
                  >
                    ↻ 允许 90°
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
};
