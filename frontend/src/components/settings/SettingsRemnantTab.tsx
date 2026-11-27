import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { StudioSettings } from '../../store/studioSettings';
import { StepperNumberInput } from './settingsMeta';

export interface SettingsRemnantTabProps {
  panelRef: (el: HTMLDivElement | null) => void;
  draft: StudioSettings;
  patchDraft: (patch: Partial<StudioSettings>) => void;
}

export const SettingsRemnantTab: React.FC<SettingsRemnantTabProps> = ({
  panelRef,
  draft,
  patchDraft
}) => {
  const minRemnantAreaM2 = ((draft.minRemnantWidthMm * draft.minRemnantLengthMm) / 1_000_000).toFixed(
    3
  );
  const remVisW = Math.round(
    Math.min(132, Math.max(44, (draft.minRemnantWidthMm / 1000) * 140))
  );
  const remVisH = Math.round(
    Math.min(108, Math.max(38, (draft.minRemnantLengthMm / 1200) * 116))
  );

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="settings-tab-remnant"
      className="sc-panel"
    >
      <div className="sc-panel-inner">
        <div className="sc-pane-bar">
          <h2>候选余料回收门槛</h2>
          <div className="width-quick-pills" role="group" aria-label="常用回收门槛快捷档">
            {[
              { label: '100 × 100 小料', w: 100, l: 100 },
              { label: '200 × 300 标准布料', w: 200, l: 300 },
              { label: '300 × 300 整板余料', w: 300, l: 300 }
            ].map((q) => {
              const isMatch =
                draft.minRemnantWidthMm === q.w && draft.minRemnantLengthMm === q.l;
              return (
                <button
                  key={q.label}
                  type="button"
                  className={isMatch ? 'on' : ''}
                  aria-pressed={isMatch}
                  onClick={() =>
                    patchDraft({ minRemnantWidthMm: q.w, minRemnantLengthMm: q.l })
                  }
                >
                  {q.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sc-two-col">
          <section className="sc-card">
            <div className="sc-card-head">
              <span>最小可入库几何尺寸</span>
            </div>

            <div className="sc-ctrl-row">
              <label htmlFor="s-width">
                <strong>最小回收宽度 W</strong>
                <span className="num muted">50 – 2000 mm</span>
              </label>
              <StepperNumberInput
                id="s-width"
                value={draft.minRemnantWidthMm}
                min={50}
                max={2000}
                step={10}
                unit="mm"
                onChange={(v) => patchDraft({ minRemnantWidthMm: v })}
              />
            </div>

            <div className="sc-ctrl-row">
              <label htmlFor="s-length">
                <strong>最小回收长度 L</strong>
                <span className="num muted">50 – 5000 mm</span>
              </label>
              <StepperNumberInput
                id="s-length"
                value={draft.minRemnantLengthMm}
                min={50}
                max={5000}
                step={10}
                unit="mm"
                onChange={(v) => patchDraft({ minRemnantLengthMm: v })}
              />
            </div>

            <div className="sc-rem-kpi">
              <span>单块最小入库面积</span>
              <strong className="num">{minRemnantAreaM2} m²</strong>
            </div>

            <details className="sc-fold">
              <summary>试算、过账与复检账实规则</summary>
              <p>
                排料试算仅划分候选余料区、零扣库存；完工过账后生成独立条码入库；复检判废剪裁转料头须处于原裁片轮廓内且不冲抵原卷耗用。
              </p>
            </details>
          </section>

          <section className="sc-card sc-rem-vis-card">
            <div className="sc-card-head">
              <span>余料划分示意</span>
              <code className="sc-code-pill amber num">
                ≥ {fmtN(draft.minRemnantWidthMm)} × {fmtN(draft.minRemnantLengthMm)} mm
              </code>
            </div>
            <svg viewBox="0 0 280 184" className="sc-rem-svg" aria-hidden="true">
              <rect
                x="18"
                y="16"
                width="244"
                height="152"
                rx="4"
                fill="#0f172a"
                stroke="#334155"
                strokeWidth="1.5"
              />
              <rect
                x="26"
                y="24"
                width={220 - remVisW}
                height="84"
                rx="2"
                fill="rgba(16,185,129,0.16)"
                stroke="#10b981"
              />
              <text
                x={26 + (220 - remVisW) / 2}
                y="70"
                textAnchor="middle"
                fill="#6ee7b7"
                fontSize="11"
              >
                合格裁片区
              </text>
              <rect
                x="26"
                y="114"
                width={220 - remVisW}
                height="46"
                rx="2"
                fill="rgba(56,189,248,0.14)"
                stroke="#38bdf8"
              />
              <rect
                x={254 - remVisW}
                y="24"
                width={remVisW}
                height={remVisH}
                rx="2"
                fill="rgba(245,158,11,0.22)"
                stroke="#f59e0b"
                strokeWidth="1.6"
                strokeDasharray="4 2"
              />
              <text
                x={254 - remVisW / 2}
                y={24 + remVisH / 2 - 3}
                textAnchor="middle"
                fill="#fcd34d"
                fontSize="10.5"
                fontWeight="700"
              >
                可回收料头
              </text>
              <text
                x={254 - remVisW / 2}
                y={24 + remVisH / 2 + 12}
                textAnchor="middle"
                fill="#fde68a"
                fontSize="10"
                fontFamily="var(--mono)"
              >
                {draft.minRemnantWidthMm}×{draft.minRemnantLengthMm}
              </text>
              {136 - remVisH > 16 && (
                <rect
                  x={254 - remVisW}
                  y={28 + remVisH}
                  width={remVisW}
                  height={132 - remVisH}
                  rx="2"
                  fill="rgba(100,116,139,0.16)"
                  stroke="#475569"
                />
              )}
            </svg>
          </section>
        </div>
      </div>
    </div>
  );
};
