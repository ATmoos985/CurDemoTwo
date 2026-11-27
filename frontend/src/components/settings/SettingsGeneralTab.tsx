import React from 'react';
import {
  StartCornerType,
  StudioSettings,
  StudioThemeMode,
  applyThemeToDocument
} from '../../store/studioSettings';
import { CORNERS } from './settingsMeta';

export interface SettingsGeneralTabProps {
  panelRef: (el: HTMLDivElement | null) => void;
  draft: StudioSettings;
  patchDraft: (patch: Partial<StudioSettings>) => void;
}

export const SettingsGeneralTab: React.FC<SettingsGeneralTabProps> = ({
  panelRef,
  draft,
  patchDraft
}) => {
  const activeCornerMeta = CORNERS.find((c) => c.id === draft.startCorner) || CORNERS[0];

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="settings-tab-general"
      className="sc-panel"
    >
      <div className="sc-panel-inner">
        <div className="sc-pane-bar">
          <h2>画布与坐标基准</h2>
        </div>

        <div className="sc-two-col">
          {/* Left Visual Card: Interactive CNC Machine Bed Origin Selector */}
          <section className="sc-card sc-origin-card">
            <div className="sc-card-head">
              <span>机床起刀零点</span>
              <code className="sc-code-pill num">{activeCornerMeta.short}</code>
            </div>

            <div
              className="sc-bed-pad"
              role="radiogroup"
              aria-label="默认起刀位置"
            >
              <svg
                viewBox="0 0 280 180"
                className="sc-bed-svg"
                aria-hidden="true"
              >
                <defs>
                  <pattern
                    id="sc-cad-grid"
                    width="20"
                    height="20"
                    patternUnits="userSpaceOnUse"
                  >
                    <path
                      d="M 20 0 L 0 0 0 20"
                      fill="none"
                      stroke="rgba(148,163,184,0.12)"
                      strokeWidth="1"
                    />
                  </pattern>
                </defs>
                <rect
                  x="38"
                  y="34"
                  width="204"
                  height="112"
                  rx="4"
                  fill="url(#sc-cad-grid)"
                  stroke="#475569"
                  strokeWidth="1.5"
                />
                <line x1="30" y1="26" x2="30" y2="154" stroke="#334155" strokeWidth="3" />
                <line x1="250" y1="26" x2="250" y2="154" stroke="#334155" strokeWidth="3" />
                <text x="140" y="21" textAnchor="middle" fill="#64748b" fontSize="10">
                  母卷进给方向 ↓
                </text>
                <text x="140" y="168" textAnchor="middle" fill="#64748b" fontSize="10">
                  裁床前端落料口
                </text>

                <rect
                  x="68"
                  y="56"
                  width="68"
                  height="42"
                  rx="2"
                  fill="rgba(56,189,248,0.12)"
                  stroke="rgba(56,189,248,0.4)"
                  strokeDasharray="3 2"
                />
                <rect
                  x="144"
                  y="56"
                  width="66"
                  height="66"
                  rx="2"
                  fill="rgba(56,189,248,0.08)"
                  stroke="rgba(56,189,248,0.32)"
                  strokeDasharray="3 2"
                />

                <line
                  x1={activeCornerMeta.cx}
                  y1={activeCornerMeta.cy}
                  x2={activeCornerMeta.cx + activeCornerMeta.dx * 54}
                  y2={activeCornerMeta.cy}
                  stroke="#38bdf8"
                  strokeWidth="2.2"
                />
                <line
                  x1={activeCornerMeta.cx}
                  y1={activeCornerMeta.cy}
                  x2={activeCornerMeta.cx}
                  y2={activeCornerMeta.cy + activeCornerMeta.dy * 44}
                  stroke="#10b981"
                  strokeWidth="2.2"
                />
                <text
                  x={activeCornerMeta.cx + activeCornerMeta.dx * 62}
                  y={activeCornerMeta.cy + 4}
                  textAnchor="middle"
                  fill="#38bdf8"
                  fontSize="10"
                  fontFamily="var(--mono)"
                  fontWeight="700"
                >
                  X
                </text>
                <text
                  x={activeCornerMeta.cx}
                  y={activeCornerMeta.cy + activeCornerMeta.dy * 54 + 3}
                  textAnchor="middle"
                  fill="#10b981"
                  fontSize="10"
                  fontFamily="var(--mono)"
                  fontWeight="700"
                >
                  Y
                </text>
              </svg>

              {CORNERS.map((c) => {
                const active = draft.startCorner === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`sc-corner-node pos-${c.id} ${active ? 'on' : ''}`}
                    onClick={() => patchDraft({ startCorner: c.id })}
                  >
                    <span className="sc-corner-dot" />
                    <span>{c.short}</span>
                  </button>
                );
              })}
            </div>

            <div className="sc-origin-select-row">
              <label htmlFor="cfg-studio-corner" className="muted">
                坐标枚举
              </label>
              <select
                id="cfg-studio-corner"
                className="field num"
                value={draft.startCorner}
                onChange={(e) =>
                  patchDraft({ startCorner: e.target.value as StartCornerType })
                }
              >
                {CORNERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.short} ({c.sub})
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* Right Visual Stack: Orientation Cards + Layer Switches */}
          <div className="sc-col-stack">
            <section className="sc-card">
              <div className="sc-card-head">
                <span>界面外观主题</span>
                <code className="sc-code-pill num">
                  {draft.theme === 'dark' ? '暗色车间大屏' : '浅色工业'}
                </code>
              </div>
              <div className="sc-orient-grid" role="radiogroup" aria-label="界面外观主题切换">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.theme === 'light'}
                  className={`sc-orient-card ${draft.theme === 'light' ? 'on' : ''}`}
                  onClick={() => {
                    const nextTheme: StudioThemeMode = 'light';
                    patchDraft({ theme: nextTheme });
                    applyThemeToDocument(nextTheme);
                  }}
                >
                  <strong>浅色工业</strong>
                  <span className="num">高亮办公室 / 明亮工位</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.theme === 'dark'}
                  className={`sc-orient-card ${draft.theme === 'dark' ? 'on' : ''}`}
                  onClick={() => {
                    const nextTheme: StudioThemeMode = 'dark';
                    patchDraft({ theme: nextTheme });
                    applyThemeToDocument(nextTheme);
                  }}
                >
                  <strong>暗色车间大屏</strong>
                  <span className="num">低光护眼 / 工业高对比</span>
                </button>
              </div>
            </section>

            <section className="sc-card">
              <div className="sc-card-head">
                <span>画布铺布视角</span>
              </div>
              <div className="sc-orient-grid" role="group" aria-label="画布默认排布朝向">
                <button
                  type="button"
                  className={`sc-orient-card ${draft.vertical ? 'on' : ''}`}
                  aria-pressed={draft.vertical}
                  onClick={() => patchDraft({ vertical: true })}
                >
                  <svg viewBox="0 0 64 48" width="56" height="42" aria-hidden="true">
                    <rect
                      x="16"
                      y="4"
                      width="32"
                      height="40"
                      rx="3"
                      fill="currentColor"
                      fillOpacity="0.08"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <rect
                      x="20"
                      y="9"
                      width="11"
                      height="14"
                      rx="1.5"
                      fill="currentColor"
                      fillOpacity="0.35"
                    />
                    <rect
                      x="33"
                      y="9"
                      width="11"
                      height="20"
                      rx="1.5"
                      fill="currentColor"
                      fillOpacity="0.24"
                    />
                  </svg>
                  <strong>纵向走布</strong>
                  <span className="num">母卷垂向进给</span>
                </button>

                <button
                  type="button"
                  className={`sc-orient-card ${!draft.vertical ? 'on' : ''}`}
                  aria-pressed={!draft.vertical}
                  onClick={() => patchDraft({ vertical: false })}
                >
                  <svg viewBox="0 0 64 48" width="56" height="42" aria-hidden="true">
                    <rect
                      x="6"
                      y="11"
                      width="52"
                      height="26"
                      rx="3"
                      fill="currentColor"
                      fillOpacity="0.08"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <rect
                      x="11"
                      y="15"
                      width="16"
                      height="9"
                      rx="1.5"
                      fill="currentColor"
                      fillOpacity="0.35"
                    />
                    <rect
                      x="30"
                      y="15"
                      width="22"
                      height="11"
                      rx="1.5"
                      fill="currentColor"
                      fillOpacity="0.24"
                    />
                  </svg>
                  <strong>横向台板</strong>
                  <span className="num">裁床水平视角</span>
                </button>
              </div>
            </section>

            <section className="sc-card">
              <div className="sc-card-head">
                <span>默认叠加图层</span>
              </div>

              <label className="sc-switch-row">
                <span className="sc-switch-label">
                  <strong>尺寸与件号标注</strong>
                  <code className="num">W × L mm · #ID</code>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={draft.showDimensions}
                  onChange={(e) => patchDraft({ showDimensions: e.target.checked })}
                />
              </label>

              <label className="sc-switch-row">
                <span className="sc-switch-label">
                  <strong>CNC 刀序与走刀轨迹</strong>
                  <code className="num">G00 / G01 路径线</code>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={draft.showPath}
                  onChange={(e) => patchDraft({ showPath: e.target.checked })}
                />
              </label>

              <label className="sc-switch-row" htmlFor="cfg-show-workflow-guide">
                <span className="sc-switch-label">
                  <strong>显示排程流程引导</strong>
                  <code className="num">在工作台顶栏显示步骤引导提示（默认关闭）</code>
                </span>
                <input
                  id="cfg-show-workflow-guide"
                  type="checkbox"
                  role="switch"
                  {...({ switch: '' } as any)}
                  className="ux-switch"
                  checked={draft.showWorkflowGuide}
                  onChange={(e) => patchDraft({ showWorkflowGuide: e.target.checked })}
                />
              </label>
            </section>

            <details className="sc-fold">
              <summary>历史方案坐标兼容规则</summary>
              <p>
                更改起刀零点仅作用于新发起的排料计算与 CAM 导出；已确认锁定的历史方案保留原快照坐标不变。
              </p>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
};
