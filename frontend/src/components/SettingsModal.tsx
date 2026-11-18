import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { requestJSON, toast, fmtN } from '@static/app/js/util.js';
import { presets, matchPreset, describePreset } from '@static/js/industry/industry-profiles.js';
import {
  DEFAULT_STUDIO_SETTINGS,
  FirstStageOrientation,
  SettingsTabId,
  StartCornerType,
  StudioSettings,
  loadStudioSettings,
  validateStudioSettings
} from '../store/studioSettings';
import { useStudioStore } from '../store/useStudioStore';

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTabId;
  onClose: () => void;
  onCapabilitiesLoaded?: (summary: { ok: boolean; workers?: number; engineCount?: number }) => void;
}

interface TabMeta {
  id: SettingsTabId;
  label: string;
  hint: string;
  desc: string;
  icon: React.ReactNode;
}

const TABS: TabMeta[] = [
  {
    id: 'general',
    label: '画布与常规',
    hint: '视口图层 · 起刀原点',
    desc: '配置 CAD 排料视口的默认朝向、标注图层以及机床起刀坐标基准。',
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect
          x="2"
          y="2.5"
          width="12"
          height="11"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path d="M2 6h12M6 6v7.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  },
  {
    id: 'craft',
    label: '裁切工艺与预设',
    hint: '行业模板 · 避疵修边',
    desc: '一键套用工厂行业工艺预设，或精细设定避疵外扩、切头修边、刀缝与直刀方向。',
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="4.5" cy="4.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="4.5" cy="11.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M6.2 5.7 13.5 12M13.5 4 6.2 10.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'remnant',
    label: '料头与余料策略',
    hint: '回收门槛 · 账实规则',
    desc: '定义排料后候选余料的最小回收宽高门槛，明确试算、完工入库与复检剪裁边界。',
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M2.5 2.5h11v11h-11v-11Zm6 0v6h5M2.5 8.5h6v5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    id: 'engines',
    label: '求解引擎与配额',
    hint: '并发池 · 内核状态',
    desc: '配置计算作业求解时限与降级保护，实时监控多线程并发队列与 7 大算法内核状态。',
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect
          x="4"
          y="4"
          width="8"
          height="8"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'integration',
    label: '导出与系统接入',
    hint: 'CAM 命名 · 开放契约',
    desc: '设置 DXF / G-Code 导出命名与车间随工单打印选项，查看 OpenAPI、MES 与 MCP 协同状态。',
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
];

const CORNER_OPTIONS: { value: StartCornerType; label: string; detail: string }[] = [
  {
    value: 'left-top',
    label: '左上角 (Left-Top · 标准 CAM 基准)',
    detail: '靠左导轨顺流进给，与二维排料默认局部坐标系一致'
  },
  {
    value: 'right-bottom',
    label: '右下角 (Right-Bottom · 落料口自下而上)',
    detail: '靠右基准导轨，从裁床前端落料口向卷内逆向起刀'
  },
  {
    value: 'right-top',
    label: '右上角 (Right-Top · 靠右导轨顺流)',
    detail: '靠右基准导轨定位，顺走布送料方向排刀'
  },
  {
    value: 'left-bottom',
    label: '左下角 (Left-Bottom · 靠左布边起切)',
    detail: '靠左布边导轨，从落料口前端自下而上起切'
  }
];

function countChangedFields(a: StudioSettings, b: StudioSettings): number {
  let diff = 0;
  (Object.keys(DEFAULT_STUDIO_SETTINGS) as (keyof StudioSettings)[]).forEach((k) => {
    if (a[k] !== b[k]) diff += 1;
  });
  return diff;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  initialTab = 'general',
  onClose,
  onCapabilitiesLoaded
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const tabRefs = useRef<Record<SettingsTabId, HTMLButtonElement | null>>({
    general: null,
    craft: null,
    remnant: null,
    engines: null,
    integration: null
  });
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const storeSettings = useStudioStore((s) => s.settings);
  const updateStudioSettings = useStudioStore((s) => s.updateStudioSettings);

  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [draft, setDraft] = useState<StudioSettings>(() => loadStudioSettings());
  const [validationError, setValidationError] = useState<string | null>(null);

  const [cap, setCap] = useState<any>(null);
  const [healthInfo, setHealthInfo] = useState<any>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const industryPresets = useMemo(() => presets() as any[], []);

  const fetchRuntimeStatus = () => {
    const seq = ++fetchSeqRef.current;
    setCapLoading(true);
    setCapError(null);
    Promise.all([
      requestJSON('/api/v2/capabilities'),
      requestJSON('/api/health').catch(() => null)
    ])
      .then(([c, h]) => {
        if (seq !== fetchSeqRef.current) return;
        setCap(c);
        setHealthInfo(h);
        setCapLoading(false);
        const availableCount =
          (c?.engines || []).filter((e: any) => e.available).length +
          (c?.slittingEngine?.available ? 1 : 0);
        onCapabilitiesLoaded?.({
          ok: h ? h.status === 'UP' : true,
          workers: c?.limits?.workers,
          engineCount: availableCount || undefined
        });
      })
      .catch((err: any) => {
        if (seq !== fetchSeqRef.current) return;
        setCapLoading(false);
        setCapError(err?.message || '读取并发求解能力失败');
      });
  };

  // Sync draft & tab whenever modal opens
  useEffect(() => {
    if (open) {
      setDraft(loadStudioSettings());
      setValidationError(null);
      setActiveTab(initialTab);
      fetchRuntimeStatus();
    } else {
      // Invalidate in-flight capability fetches when closed
      fetchSeqRef.current += 1;
    }
  }, [open, initialTab]);

  // Keep draft synced if storeSettings changes externally while clean
  useEffect(() => {
    if (!open) {
      setDraft(storeSettings);
    }
  }, [storeSettings, open]);

  // Manage native <dialog> top-layer modal lifecycle
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onCloseRef.current();
    };
    dialog.addEventListener('close', handleClose);

    let cleanupFallback: (() => void) | undefined;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const rect = dialog.getBoundingClientRect();
        return (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        );
      };
      const onPointerDown = (e: PointerEvent) => {
        if (e.target !== dialog) {
          pressedOutside = false;
          return;
        }
        pressedOutside = isOutside(e);
      };
      const onPointerUp = (e: PointerEvent) => {
        if (e.target === dialog && pressedOutside && isOutside(e)) {
          dialog.close();
        }
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      cleanupFallback = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      cleanupFallback?.();
    };
  }, []);

  const patchDraft = (patch: Partial<StudioSettings>) => {
    setValidationError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const matchedPresetId = useMemo(
    () =>
      matchPreset({
        defectMargin: draft.defectMarginMm,
        trimStart: draft.trimStartMm,
        allowRotation: draft.defaultAllowRotation ? 1 : 0,
        allowLongitudinal: 1,
        minRemnantWidth: draft.minRemnantWidthMm,
        minRemnantLength: draft.minRemnantLengthMm
      }),
    [
      draft.defectMarginMm,
      draft.trimStartMm,
      draft.defaultAllowRotation,
      draft.minRemnantWidthMm,
      draft.minRemnantLengthMm
    ]
  );

  const handleApplyIndustryPreset = (preset: any) => {
    if (!preset?.values) return;
    patchDraft({
      defectMarginMm: Number(preset.values.defectMargin ?? 20),
      trimStartMm: Number(preset.values.trimStart ?? 0),
      defaultAllowRotation: Number(preset.values.allowRotation) === 1,
      minRemnantWidthMm: Number(preset.values.minRemnantWidth ?? 200),
      minRemnantLengthMm: Number(preset.values.minRemnantLength ?? 300)
    });
    toast(`已填入「${preset.name}」工艺预设，点击右下角保存并应用后生效`);
  };

  const handleRestoreDefaults = () => {
    setDraft({ ...DEFAULT_STUDIO_SETTINGS });
    setValidationError(null);
    toast('已填入系统出厂默认参数，点击「保存并应用」后生效');
  };

  const handleSave = (e?: React.FormEvent) => {
    e?.preventDefault();
    const err = validateStudioSettings(draft);
    if (err) {
      setValidationError(err);
      toast(err, true);
      return;
    }
    updateStudioSettings(draft);
    toast('系统与工艺设置已保存并应用');
    dialogRef.current?.close();
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx = -1;
    if (e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % TABS.length;
    } else if (e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + TABS.length) % TABS.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = TABS.length - 1;
    }
    if (nextIdx >= 0) {
      e.preventDefault();
      const targetTab = TABS[nextIdx].id;
      setActiveTab(targetTab);
      tabRefs.current[targetTab]?.focus();
    }
  };

  const allEngines = useMemo(() => {
    if (!cap) return [];
    return [
      ...(cap.engines || []),
      ...(cap.slittingEngine
        ? [
            {
              ...cap.slittingEngine,
              shapes: ['定长条宽订单'],
              modes: ['一维分切'],
              coordinateResolutionMm: cap.slittingEngine.lengthResolutionMm
            }
          ]
        : [])
    ];
  }, [cap]);

  const readyEngineCount = useMemo(
    () => allEngines.filter((e: any) => e.available).length,
    [allEngines]
  );

  const changedCount = useMemo(
    () => countChangedFields(draft, storeSettings),
    [draft, storeSettings]
  );

  const currentTabMeta = TABS.find((t) => t.id === activeTab) || TABS[0];
  const minRemnantAreaM2 = ((draft.minRemnantWidthMm * draft.minRemnantLengthMm) / 1_000_000).toFixed(
    3
  );

  return (
    <dialog
      ref={dialogRef}
      id="studio-settings-dialog"
      closedby="any"
      aria-labelledby={titleId}
      className="native-modal-dialog settings-center-dialog"
    >
      {/* Top Modal Header */}
      <div className="settings-center-head">
        <div className="settings-center-title-wrap">
          <span className="settings-head-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <h1 id={titleId}>设置</h1>
          <span className="settings-head-sep" aria-hidden="true">
            /
          </span>
          <span className="settings-center-sub">系统偏好、裁切工艺、余料策略与求解内核配置</span>
        </div>
        <div className="settings-head-actions">
          <kbd className="settings-kbd" aria-hidden="true">
            Esc
          </kbd>
          <button
            type="button"
            className="btn sm"
            aria-label="关闭设置弹窗"
            onClick={() => dialogRef.current?.close()}
          >
            关闭
          </button>
        </div>
      </div>

      {/* Main Split Body: Left Vertical Tabs + Right Tab Panel */}
      <form className="settings-center-form" onSubmit={handleSave}>
        <div className="settings-center-body">
          {/* Left Vertical Tab Column */}
          <div
            className="settings-center-rail"
            role="tablist"
            aria-orientation="vertical"
            aria-label="系统设置分组"
          >
            <div className="settings-rail-caption">配置模块</div>
            {TABS.map((tab, idx) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`settings-tab-item ${selected ? 'on' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                >
                  <span className="settings-tab-icon">{tab.icon}</span>
                  <span className="settings-tab-text">
                    <strong>{tab.label}</strong>
                    <small>{tab.hint}</small>
                  </span>
                  {tab.id === 'engines' && allEngines.length > 0 && (
                    <span className="settings-tab-badge num" title="就绪内核数 / 总注册数">
                      {readyEngineCount}/{allEngines.length}
                    </span>
                  )}
                </button>
              );
            })}

            <div className="settings-rail-foot">
              <div>存储范围：本机浏览器</div>
              <div>排料试算零扣库 · 完工扣库存</div>
            </div>
          </div>

          {/* Right Settings Detail Panel */}
          <div
            className="settings-center-pane"
            role="tabpanel"
            id={`settings-panel-${activeTab}`}
            aria-labelledby={`settings-tab-${activeTab}`}
          >
            <div className="settings-pane-head">
              <div>
                <h2>{currentTabMeta.label}</h2>
                <p>{currentTabMeta.desc}</p>
              </div>
              {activeTab === 'engines' && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={capLoading}
                  onClick={fetchRuntimeStatus}
                >
                  {capLoading ? '检测中…' : '↻ 刷新服务能力'}
                </button>
              )}
            </div>

            {/* TAB 1: 画布与常规 */}
            {activeTab === 'general' && (
              <div className="settings-sections">
                <section className="settings-section">
                  <div className="settings-sec-title">CAD 排料视口默认显示</div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>画布默认排布朝向</strong>
                      <small>控制搭切工作台与结果中心打开时的母卷展开视角（工具栏仍可随时切换）</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="seg" role="group" aria-label="画布默认排布朝向">
                        <button
                          type="button"
                          className={draft.vertical ? 'on' : ''}
                          aria-pressed={draft.vertical}
                          onClick={() => patchDraft({ vertical: true })}
                        >
                          纵向走布 (推荐)
                        </button>
                        <button
                          type="button"
                          className={!draft.vertical ? 'on' : ''}
                          aria-pressed={!draft.vertical}
                          onClick={() => patchDraft({ vertical: false })}
                        >
                          横向台板
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>裁片尺寸与件号标注图层</strong>
                      <small>在二维 CAD 画布中默认绘制裁片名称、长宽毫米标注与旋转角</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <label className="settings-switch">
                        <input
                          type="checkbox"
                          checked={draft.showDimensions}
                          onChange={(e) => patchDraft({ showDimensions: e.target.checked })}
                        />
                        <span>{draft.showDimensions ? '默认开启' : '默认隐藏'}</span>
                      </label>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>CNC 走刀路径与刀序叠加</strong>
                      <small>在排料画布上默认显示贯通直刀切割线、空行程虚线与下刀序号</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <label className="settings-switch">
                        <input
                          type="checkbox"
                          checked={draft.showPath}
                          onChange={(e) => patchDraft({ showPath: e.target.checked })}
                        />
                        <span>{draft.showPath ? '默认开启' : '按需开启'}</span>
                      </label>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-sec-title">机床坐标系与起刀基准</div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="cfg-studio-corner">
                        <strong>默认起刀位置 (Start Corner)</strong>
                      </label>
                      <small>
                        {CORNER_OPTIONS.find((c) => c.value === draft.startCorner)?.detail}
                      </small>
                    </div>
                    <div className="settings-row-ctrl">
                      <select
                        id="cfg-studio-corner"
                        className="field"
                        style={{ width: 256 }}
                        value={draft.startCorner}
                        onChange={(e) =>
                          patchDraft({ startCorner: e.target.value as StartCornerType })
                        }
                      >
                        {CORNER_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="settings-note-bar">
                    起刀基准决定二维排切刀序方向及 G-Code / DXF 导出零点映射；已确认锁定的历史排程方案保留原坐标快照不变。
                  </div>
                </section>
              </div>
            )}

            {/* TAB 2: 裁切工艺与预设 */}
            {activeTab === 'craft' && (
              <div className="settings-sections">
                <section className="settings-section">
                  <div className="settings-sec-head">
                    <span>工厂行业规则预设</span>
                    <span className={`tag ${matchedPresetId ? 'run' : 'kind'}`}>
                      {matchedPresetId
                        ? `当前匹配：${
                            industryPresets.find((p) => p.id === matchedPresetId)?.name || '预设'
                          }`
                        : '当前：自定义工艺参数'}
                    </span>
                  </div>

                  <div className="settings-preset-grid">
                    {industryPresets.map((preset: any) => {
                      const active = matchedPresetId === preset.id;
                      const summary = describePreset(preset.values)
                        .slice(0, 4)
                        .map((d: any) => `${d.label} ${d.text}`)
                        .join(' · ');
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`settings-preset-card ${active ? 'on' : ''}`}
                          aria-pressed={active}
                          onClick={() => handleApplyIndustryPreset(preset)}
                        >
                          <div className="settings-preset-top">
                            <strong>{preset.name}</strong>
                            <span>{active ? '已匹配' : '填入预设'}</span>
                          </div>
                          <small>{summary}</small>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-sec-title">二维排料与瑕疵隔离参数</div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="cfg-studio-margin">
                        <strong>疵点默认安全避让间距</strong>
                      </label>
                      <small>母卷疵点未单独指定边距时，自动向外扩展禁入区的安全距离 (0–200 mm)</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="settings-unit-input">
                        <input
                          id="cfg-studio-margin"
                          type="number"
                          min={0}
                          max={200}
                          step={1}
                          className="field num"
                          value={draft.defectMarginMm}
                          onChange={(e) => patchDraft({ defectMarginMm: Number(e.target.value) })}
                        />
                        <span>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="cfg-studio-trim">
                        <strong>卷头默认修边切头长度</strong>
                      </label>
                      <small>新建排程画布起始端默认预留的齐头修边宽度 (0–1000 mm)</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="settings-unit-input">
                        <input
                          id="cfg-studio-trim"
                          type="number"
                          min={0}
                          max={1000}
                          step={10}
                          className="field num"
                          value={draft.trimStartMm}
                          onChange={(e) => patchDraft({ trimStartMm: Number(e.target.value) })}
                        />
                        <span>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="cfg-studio-gap">
                        <strong>裁片默认安全刀缝 / 间距</strong>
                      </label>
                      <small>相邻裁片轮廓之间的最小安全净距，支持 0.1 mm 精度 (0–50 mm)</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="settings-unit-input">
                        <input
                          id="cfg-studio-gap"
                          type="number"
                          min={0}
                          max={50}
                          step={0.5}
                          className="field num"
                          value={draft.pieceGapMm}
                          onChange={(e) => patchDraft({ pieceGapMm: Number(e.target.value) })}
                        />
                        <span>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>第一阶段贯通直刀方向</strong>
                      <small>矩形 Guillotine 排切时的首刀切透方向偏好</small>
                    </div>
                    <div className="settings-row-ctrl">
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
                          横切优先
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
                          纵切优先
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>手动新增矩形件默认旋转规则</strong>
                      <small>在搭切工作台新增自定义规格件时的初始 90° 旋转开关</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="seg" role="group" aria-label="默认旋转规则">
                        <button
                          type="button"
                          className={!draft.defaultAllowRotation ? 'on' : ''}
                          aria-pressed={!draft.defaultAllowRotation}
                          onClick={() => patchDraft({ defaultAllowRotation: false })}
                        >
                          禁止旋转 (保纹理)
                        </button>
                        <button
                          type="button"
                          className={draft.defaultAllowRotation ? 'on' : ''}
                          aria-pressed={draft.defaultAllowRotation}
                          onClick={() => patchDraft({ defaultAllowRotation: true })}
                        >
                          允许 90° 旋转
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* TAB 3: 料头与余料策略 */}
            {activeTab === 'remnant' && (
              <div className="settings-sections">
                <section className="settings-section">
                  <div className="settings-sec-head">
                    <span>候选料头自动划分尺寸门槛</span>
                    <div className="width-quick-pills" role="group" aria-label="常用回收门槛快捷档">
                      {[
                        { label: '100×100 小料', w: 100, l: 100 },
                        { label: '200×300 标准布料', w: 200, l: 300 },
                        { label: '300×300 整板余料', w: 300, l: 300 }
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

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="s-width">
                        <strong>候选料头最小回收宽度</strong>
                      </label>
                      <small>低于此宽度的边角余料视为不可复用损耗，不生成候选料头块 (50–2000 mm)</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="settings-unit-input">
                        <input
                          id="s-width"
                          type="number"
                          min={50}
                          max={2000}
                          step={10}
                          className="field num"
                          value={draft.minRemnantWidthMm}
                          onChange={(e) =>
                            patchDraft({ minRemnantWidthMm: Number(e.target.value) })
                          }
                        />
                        <span>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="s-length">
                        <strong>候选料头最小回收长度</strong>
                      </label>
                      <small>沿送料方向满足此最小长度的整洁余料区自动标定为可回收料头 (50–5000 mm)</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <div className="settings-unit-input">
                        <input
                          id="s-length"
                          type="number"
                          min={50}
                          max={5000}
                          step={10}
                          className="field num"
                          value={draft.minRemnantLengthMm}
                          onChange={(e) =>
                            patchDraft({ minRemnantLengthMm: Number(e.target.value) })
                          }
                        />
                        <span>mm</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>单块最小入库面积折算</strong>
                      <small>由最小回收宽 × 最小回收长实时折算的单块入库门槛</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <span className="tag ok num" style={{ height: 24, lineHeight: '24px' }}>
                        ≥ {minRemnantAreaM2} m² ({fmtN(draft.minRemnantWidthMm)} ×{' '}
                        {fmtN(draft.minRemnantLengthMm)} mm)
                      </span>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-sec-title">余料与台账业务不变量</div>
                  <div className="settings-rules-list">
                    <div>
                      <span className="tag run">排料试算</span>
                      <span>
                        仅在画布与方案快照中标出候选余料区域，零扣减母卷库存、不混入成品净利用率。
                      </span>
                    </div>
                    <div>
                      <span className="tag ok">完工过账</span>
                      <span>
                        结果管理执行实切完工记账后，合格余料方才生成可扫码料头档案并追加不可变库存流水。
                      </span>
                    </div>
                    <div>
                      <span className="tag warn">复检剪裁</span>
                      <span>
                        裁后复检判废剪裁转料头时，回收矩形须完全处于原裁片实物轮廓内，且不冲抵已耗母卷长度。
                      </span>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {/* TAB 4: 求解引擎与配额 */}
            {activeTab === 'engines' && (
              <div className="settings-sections">
                <section className="settings-section">
                  <div className="settings-sec-title">计算作业预算与回退策略</div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="s-time">
                        <strong>单作业基准求解时限</strong>
                      </label>
                      <small>
                        标准计算作业时间预算 (1–120 秒)；多轮二分缩长策略按此基准等比放宽搜索时限
                      </small>
                    </div>
                    <div className="settings-row-ctrl" style={{ gap: 8 }}>
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
                        <input
                          id="s-time"
                          type="number"
                          min={1}
                          max={120}
                          step={1}
                          className="field num"
                          style={{ width: 68 }}
                          value={draft.timeLimitSeconds}
                          onChange={(e) => patchDraft({ timeLimitSeconds: Number(e.target.value) })}
                        />
                        <span>秒</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>缺少 C++ 原生二进制时允许平滑降级</strong>
                      <small>
                        开启后若部署环境未安装原生 PackingSolver，将回退至内置 Java 引擎并在结果中显式标注降级原因
                      </small>
                    </div>
                    <div className="settings-row-ctrl">
                      <label className="settings-switch">
                        <input
                          type="checkbox"
                          checked={draft.allowFallback}
                          onChange={(e) => patchDraft({ allowFallback: e.target.checked })}
                        />
                        <span>{draft.allowFallback ? '允许降级' : '严格指定'}</span>
                      </label>
                    </div>
                  </div>
                </section>

                <section className="settings-section" style={{ padding: 0, overflow: 'hidden' }}>
                  <div className="pane-h" style={{ background: 'var(--panel-2)' }}>
                    <span>多线程并发配额与已注册求解内核</span>
                    <span className="sp" />
                    {cap && (
                      <span className="muted num" style={{ fontSize: 11.5, fontWeight: 400 }}>
                        契约 v{cap.schemaVersion || '2.0'}
                      </span>
                    )}
                  </div>

                  {capError && (
                    <div
                      id="capabilities-error"
                      className="error-box"
                      style={{
                        margin: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10
                      }}
                    >
                      <span>读取失败：{capError}</span>
                      <button type="button" className="btn sm" onClick={fetchRuntimeStatus}>
                        重试
                      </button>
                    </div>
                  )}

                  {cap ? (
                    <>
                      <div className="metric" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                        <div>
                          <small>并发求解工作线程</small>
                          <b className="num" style={{ color: 'var(--ok)' }}>
                            {cap.limits?.workers ?? '—'} <em>线程</em>
                          </b>
                        </div>
                        <div>
                          <small>等待队列容量</small>
                          <b className="num">
                            {cap.limits?.queueCapacity ?? '—'} <em>作业</em>
                          </b>
                        </div>
                        <div>
                          <small>异形最大裁片数</small>
                          <b className="num">{fmtN(cap.limits?.maxContourPieces ?? 0)}</b>
                        </div>
                        <div>
                          <small>矩形最大裁片数</small>
                          <b className="num">{fmtN(cap.limits?.maxPieces ?? 0)}</b>
                        </div>
                      </div>

                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th>求解器引擎 ID</th>
                            <th>状态</th>
                            <th>支持几何 / 工艺模式</th>
                            <th className="r">物理精度</th>
                          </tr>
                        </thead>
                        <tbody id="engine-rows">
                          {allEngines.map((e: any) => (
                            <tr key={e.id}>
                              <td className="num" style={{ fontWeight: 600 }}>
                                {e.id}
                              </td>
                              <td>
                                <span className={`tag ${e.available ? 'ok' : 'err'}`}>
                                  {e.available ? '可用 (并行隔离进程)' : '未就绪'}
                                </span>
                              </td>
                              <td>{[...(e.modes || []), ...(e.shapes || [])].join(' · ')}</td>
                              <td className="r num">{e.coordinateResolutionMm} mm</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : !capError ? (
                    <div className="loading">正在读取服务端线程池与内核能力…</div>
                  ) : null}
                </section>
              </div>
            )}

            {/* TAB 5: 导出与系统接入 */}
            {activeTab === 'integration' && (
              <div className="settings-sections">
                <section className="settings-section">
                  <div className="settings-sec-title">车间单据与 CAM 文件导出</div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <label htmlFor="cfg-export-prefix">
                        <strong>DXF / G-Code 导出文件名前缀</strong>
                      </label>
                      <small className="num">
                        文件命名预览：{draft.exportPrefix.trim() || 'CutPlan'}-1650x1540.dxf
                      </small>
                    </div>
                    <div className="settings-row-ctrl">
                      <input
                        id="cfg-export-prefix"
                        type="text"
                        maxLength={32}
                        className="field num"
                        style={{ width: 190 }}
                        value={draft.exportPrefix}
                        onChange={(e) => patchDraft({ exportPrefix: e.target.value })}
                        placeholder="CutPlan"
                      />
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-info">
                      <strong>A4 车间随工单附带直刀顺序明细</strong>
                      <small>当二维方案包含贯通直刀路径时，在打印派工单底部输出刀序坐标表</small>
                    </div>
                    <div className="settings-row-ctrl">
                      <label className="settings-switch">
                        <input
                          type="checkbox"
                          checked={draft.ticketShowCuts}
                          onChange={(e) => patchDraft({ ticketShowCuts: e.target.checked })}
                        />
                        <span>{draft.ticketShowCuts ? '附带刀序' : '仅裁片表'}</span>
                      </label>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-sec-head">
                    <span>系统运行健康与开放协同契约</span>
                    <span className={`tag ${healthInfo?.status === 'UP' ? 'ok' : 'warn'}`}>
                      {healthInfo?.status === 'UP'
                        ? `服务在线 · 在库可用料头 ${healthInfo.remnantsInStock ?? 0} 块`
                        : '健康状态待刷新'}
                    </span>
                  </div>

                  <div className="settings-endpoint-list">
                    <div className="settings-endpoint-row">
                      <div>
                        <strong>OpenAPI 3.1 统一计算与业务契约</strong>
                        <small className="num">/api-v2/openapi.json</small>
                      </div>
                      <a
                        href="/api-v2/openapi.json"
                        target="_blank"
                        rel="noreferrer"
                        className="btn sm"
                      >
                        查看契约 JSON
                      </a>
                    </div>

                    <div className="settings-endpoint-row">
                      <div>
                        <strong>MES 工单下推与完工报工协同接口</strong>
                        <small className="num">/api/v2/mes/* · 幂等键防重放</small>
                      </div>
                      <span className="tag ok">已启用</span>
                    </div>

                    <div className="settings-endpoint-row">
                      <div>
                        <strong>不可变库存流水与内部账实平衡核验</strong>
                        <small className="num">/api/v2/inventory-ledger/reconciliation</small>
                      </div>
                      <span className="tag ok">同事务追加</span>
                    </div>

                    <div className="settings-endpoint-row">
                      <div>
                        <strong>本机 AI / MCP 受控适配器</strong>
                        <small className="num">integrations/mcp · 复用标准 REST 与只读权限门禁</small>
                      </div>
                      <span className="tag kind">宿主受控</span>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>

        {/* Sticky Modal Footer */}
        <div className="settings-center-foot">
          <button type="button" className="btn sm" onClick={handleRestoreDefaults}>
            恢复默认参数
          </button>

          <div className="settings-foot-status" role="status">
            {validationError ? (
              <span className="settings-err-text">{validationError}</span>
            ) : changedCount > 0 ? (
              <span className="settings-dirty-badge">
                <i aria-hidden="true" /> 已修改 <b className="num">{changedCount}</b> 项设置，保存后生效
              </span>
            ) : (
              <span className="muted">设置保存在本机，新排料与视口立即生效，已锁方案保持原快照</span>
            )}
          </div>

          <div className="settings-foot-btns">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              取消
            </button>
            <button type="submit" className="btn pri">
              保存并应用
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
};
