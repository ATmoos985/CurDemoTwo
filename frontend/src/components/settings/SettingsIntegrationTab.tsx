import React from 'react';
import { toast } from '../../lib/core/util.js';
import { DEFAULT_CNC_POST_OPTIONS, StudioSettings } from '../../store/studioSettings';
import { NumberInput } from '../ui/NumberInput';

export interface SettingsIntegrationTabProps {
  panelRef: (el: HTMLDivElement | null) => void;
  draft: StudioSettings;
  patchDraft: (patch: Partial<StudioSettings>) => void;
  healthInfo: any;
}

export const SettingsIntegrationTab: React.FC<SettingsIntegrationTabProps> = ({
  panelRef,
  draft,
  patchDraft,
  healthInfo
}) => {
  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="settings-tab-integration"
      className="sc-panel"
    >
      <div className="sc-panel-inner">
        <div className="sc-pane-bar">
          <h2>导出规范与开放契约</h2>
          <span className={`sc-state-chip ${healthInfo?.status === 'UP' ? 'ok' : ''}`}>
            {healthInfo?.status === 'UP'
              ? `服务 UP · 在库料头 ${healthInfo.remnantsInStock ?? 0} 块`
              : '检测连接中'}
          </span>
        </div>

        <section className="sc-card">
          <div className="sc-export-composer">
            <div className="sc-export-input-group">
              <label htmlFor="cfg-export-prefix">CAM 导出文件前缀</label>
              <div className="sc-token-preview num">
                <input
                  id="cfg-export-prefix"
                  type="text"
                  maxLength={32}
                  className="sc-prefix-input num"
                  value={draft.exportPrefix}
                  onChange={(e) => patchDraft({ exportPrefix: e.target.value })}
                  placeholder="CutPlan"
                />
                <span className="sc-token-sep">-1650x1540</span>
                <span className="sc-ext-badge">.dxf</span>
                <span className="sc-ext-badge">.nc</span>
              </div>
            </div>

            <label className="sc-switch-row sc-ticket-switch">
              <span className="sc-switch-label">
                <strong>A4 随工单打印直刀顺序表</strong>
                <code className="num">附带每刀起点 / 终点坐标</code>
              </span>
              <input
                type="checkbox"
                role="switch"
                {...({ switch: '' } as any)}
                className="ux-switch"
                checked={draft.ticketShowCuts}
                onChange={(e) => patchDraft({ ticketShowCuts: e.target.checked })}
              />
            </label>
          </div>
        </section>

        <section className="sc-card" id="cfg-cnc-post-card">
          <div className="sc-card-head">
            <span>CNC 后处理参数（G-Code 导出）</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                patchDraft({
                  cncCutFeed: DEFAULT_CNC_POST_OPTIONS.cutFeed,
                  cncRapidFeed: DEFAULT_CNC_POST_OPTIONS.rapidFeed,
                  cncPlungeDelay: DEFAULT_CNC_POST_OPTIONS.plungeDelay,
                  cncRetractDelay: DEFAULT_CNC_POST_OPTIONS.retractDelay
                });
                toast('已恢复默认 CNC 后处理参数');
              }}
            >
              恢复默认
            </button>
          </div>

          <div className="sc-slit-grid">
            <div className="sc-slit-field">
              <label htmlFor="cfg-cnc-cut-feed">切割进给 cutFeed (mm/min)</label>
              <NumberInput
                id="cfg-cnc-cut-feed"
                min={100}
                max={60000}
                step={100}
                integer
                className="field num"
                value={draft.cncCutFeed}
                onValueChange={(v) => patchDraft({ cncCutFeed: v })}
              />
              <small>G01 切削进给率 F 值（默认 4000 mm/min）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-cnc-rapid-feed">空程进给 rapidFeed (mm/min)</label>
              <NumberInput
                id="cfg-cnc-rapid-feed"
                min={500}
                max={100000}
                step={500}
                integer
                className="field num"
                value={draft.cncRapidFeed}
                onValueChange={(v) => patchDraft({ cncRapidFeed: v })}
              />
              <small>G00 提刀空程速度 F 值（默认 15000 mm/min）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-cnc-plunge-delay">下刀延时 plungeDelay (ms)</label>
              <NumberInput
                id="cfg-cnc-plunge-delay"
                min={0}
                max={10000}
                step={50}
                integer
                className="field num"
                value={draft.cncPlungeDelay}
                onValueChange={(v) => patchDraft({ cncPlungeDelay: v })}
              />
              <small>M03 落刀/开光后的 G04 稳定延时（默认 200 ms）</small>
            </div>
            <div className="sc-slit-field">
              <label htmlFor="cfg-cnc-retract-delay">抬刀延时 retractDelay (ms)</label>
              <NumberInput
                id="cfg-cnc-retract-delay"
                min={0}
                max={10000}
                step={50}
                integer
                className="field num"
                value={draft.cncRetractDelay}
                onValueChange={(v) => patchDraft({ cncRetractDelay: v })}
              />
              <small>M05 抬刀/关光后的 G04 复位延时（默认 100 ms）</small>
            </div>
          </div>
        </section>

        <div className="sc-endpoint-grid">
          <div className="sc-ep-card">
            <div className="sc-ep-top">
              <strong>OpenAPI 3.1 契约</strong>
              <a
                href="/api-v2/openapi.json"
                target="_blank"
                rel="noreferrer"
                className="btn sm"
              >
                查看 JSON ↗
              </a>
            </div>
            <code className="num">/api-v2/openapi.json</code>
          </div>

          <div className="sc-ep-card">
            <div className="sc-ep-top">
              <strong>MES 派工与报工闭环</strong>
              <span className="sc-status-pill ok">
                <i aria-hidden="true" /> 已启用
              </span>
            </div>
            <code className="num">/api/v2/mes/* · Idempotency-Key</code>
          </div>

          <div className="sc-ep-card">
            <div className="sc-ep-top">
              <strong>不可变库存流水对账</strong>
              <span className="sc-status-pill ok">
                <i aria-hidden="true" /> 同事务追加
              </span>
            </div>
            <code className="num">/api/v2/inventory-ledger/reconciliation</code>
          </div>

          <div className="sc-ep-card">
            <div className="sc-ep-top">
              <strong>本机 MCP 适配器</strong>
              <span className="sc-status-pill">宿主门禁</span>
            </div>
            <code className="num">integrations/mcp · stdio</code>
          </div>
        </div>
      </div>
    </div>
  );
};
