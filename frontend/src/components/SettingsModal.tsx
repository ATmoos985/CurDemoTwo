import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { requestJSON, toast, fmtN } from '../lib/core/util.js';
import { presets, matchPreset } from '../lib/domain/industry-profiles.js';
import {
  DEFAULT_CNC_POST_OPTIONS,
  DEFAULT_SLITTING_SOLVER_SETTINGS,
  DEFAULT_STUDIO_SETTINGS,
  FirstStageOrientation,
  SettingsTabId,
  SlittingProfile,
  StartCornerType,
  StudioSettings,
  StudioThemeMode,
  WORKBENCH_STRATEGIES_2D,
  applyThemeToDocument,
  loadStudioSettings,
  validateStudioSettings
} from '../store/studioSettings';
import { useStudioStore } from '../store/useStudioStore';
import { NumberInput } from './ui/NumberInput';

export interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTabId;
  onClose: () => void;
  onCapabilitiesLoaded?: (summary: { ok: boolean; workers?: number; engineCount?: number }) => void;
}

interface TabMeta {
  id: SettingsTabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabMeta[] = [
  {
    id: 'general',
    label: '画布与常规',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="2.2"
          y="2.8"
          width="13.6"
          height="12.4"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M2.2 6.8h13.6M6.8 6.8v8.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  },
  {
    id: 'craft',
    label: '裁切工艺与预设',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <circle cx="5" cy="5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="13" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M6.9 6.3 15.2 13.5M15.2 4.5 6.9 11.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'remnant',
    label: '料头与余料策略',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="2.5"
          y="2.5"
          width="13"
          height="13"
          rx="1.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M9.5 2.5v7h6M2.5 9.5h7v6"
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
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <rect
          x="4.5"
          y="4.5"
          width="9"
          height="9"
          rx="1.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M7.2 2v2.5M10.8 2v2.5M7.2 13.5V16M10.8 13.5V16M2 7.2h2.5M2 10.8h2.5M13.5 7.2H16M13.5 10.8H16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'integration',
    label: '导出与系统接入',
    icon: (
      <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
        <path
          d="M6.2 5.5 2.8 9l3.4 3.5M11.8 5.5 15.2 9l-3.4 3.5M10.2 4l-2.4 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
];

const CORNERS: {
  id: StartCornerType;
  short: string;
  sub: string;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
}[] = [
  { id: 'left-top', short: '左上起刀', sub: 'Left-Top · 标准 CAM', cx: 38, cy: 34, dx: 1, dy: 1 },
  { id: 'right-top', short: '右上起刀', sub: 'Right-Top · 右导轨顺流', cx: 242, cy: 34, dx: -1, dy: 1 },
  {
    id: 'left-bottom',
    short: '左下起刀',
    sub: 'Left-Bottom · 落料口左起',
    cx: 38,
    cy: 146,
    dx: 1,
    dy: -1
  },
  {
    id: 'right-bottom',
    short: '右下起刀',
    sub: 'Right-Bottom · 落料口右起',
    cx: 242,
    cy: 146,
    dx: -1,
    dy: -1
  }
];

const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  crosscut: '通幅横切引擎',
  deepnest: '异形轮廓排料引擎',
  javaguillotine: '二维直刀排料引擎',
  javairregular: '异形快速排料引擎',
  packingsolver: '高精度直刀引擎',
  'packingsolver-irregular': '高精度异形引擎',
  'ortools-1d': '一维分切搭切引擎'
};

const ENGINE_MODE_LABELS: Record<string, string> = {
  CROSSCUT: '横切',
  GUILLOTINE: '直刀',
  CONTOUR: '异形',
  SLITTING: '分切',
  RECTANGLE: '矩形',
  POLYGON: '多边形',
  '1D STRIP': '一维分条'
};

function formatEngineDisplayName(id: string): string {
  return ENGINE_DISPLAY_NAMES[id] || '内置求解引擎';
}

function formatEngineModeLabel(mode: string): string {
  return ENGINE_MODE_LABELS[mode] || mode;
}

function countChangedFields(a: StudioSettings, b: StudioSettings): number {
  let diff = 0;
  (Object.keys(DEFAULT_STUDIO_SETTINGS) as (keyof StudioSettings)[]).forEach((k) => {
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      const same = va.length === vb.length && va.every((item) => vb.includes(item));
      if (!same) diff += 1;
    } else if (va !== vb) {
      diff += 1;
    }
  });
  return diff;
}

const StepperNumberInput: React.FC<{
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (next: number) => void;
}> = ({ id, value, min, max, step, unit, onChange }) => {
  const bump = (dir: -1 | 1) => {
    const raw = Number((value + dir * step).toFixed(2));
    onChange(Math.min(max, Math.max(min, raw)));
  };
  return (
    <div className="sc-stepper">
      <button
        type="button"
        className="sc-step-btn"
        aria-label="减小数值"
        disabled={value <= min}
        onClick={() => bump(-1)}
      >
        −
      </button>
      <NumberInput
        id={id}
        min={min}
        max={max}
        step={step}
        className="sc-step-input num"
        value={value}
        onValueChange={onChange}
      />
      <button
        type="button"
        className="sc-step-btn"
        aria-label="增大数值"
        disabled={value >= max}
        onClick={() => bump(1)}
      >
        +
      </button>
      <span className="sc-step-unit num">{unit}</span>
    </div>
  );
};

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
  const panelRefs = useRef<Record<SettingsTabId, HTMLDivElement | null>>({
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

  useEffect(() => {
    if (open) {
      setDraft(loadStudioSettings());
      setValidationError(null);
      setActiveTab(initialTab);
      fetchRuntimeStatus();
    } else {
      fetchSeqRef.current += 1;
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) {
      setDraft(storeSettings);
    }
  }, [storeSettings, open]);

  // Sync hidden="until-found" & beforematch for browser find-in-page per modern-web-guidance `tabs`
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const tab of TABS) {
      const el = panelRefs.current[tab.id];
      if (!el) continue;
      if (activeTab === tab.id) {
        el.removeAttribute('hidden');
      } else {
        el.setAttribute('hidden', 'until-found');
      }
      const onBeforeMatch = () => setActiveTab(tab.id);
      el.addEventListener('beforematch', onBeforeMatch);
      cleanups.push(() => el.removeEventListener('beforematch', onBeforeMatch));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [activeTab]);

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
      applyThemeToDocument(useStudioStore.getState().settings.theme);
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
    toast(`已套用「${preset.name}」参数模板`);
  };

  const handleRestoreDefaults = () => {
    setDraft({
      ...DEFAULT_STUDIO_SETTINGS,
      enabledStrategies2D: [...DEFAULT_STUDIO_SETTINGS.enabledStrategies2D]
    });
    setValidationError(null);
    toast('已恢复默认参数，点击「保存并应用」生效');
  };

  const handleToggleStrategy = (strategyId: string, nextChecked: boolean) => {
    const currentlyEnabled = draft.enabledStrategies2D.includes(strategyId);
    if (!nextChecked && currentlyEnabled && draft.enabledStrategies2D.length <= 1) {
      toast('至少保留 1 个启用算法', true);
      return;
    }
    const nextSet = new Set(draft.enabledStrategies2D);
    if (nextChecked) {
      nextSet.add(strategyId);
    } else {
      nextSet.delete(strategyId);
    }
    const ordered = WORKBENCH_STRATEGIES_2D.map((s) => s.id).filter((id) => nextSet.has(id));
    patchDraft({ enabledStrategies2D: ordered });
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
    toast('设置已保存并应用');
    dialogRef.current?.close();
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      nextIdx = (idx + 1) % TABS.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
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
              shapes: ['1D STRIP'],
              modes: ['SLITTING'],
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

  const activeCornerMeta = CORNERS.find((c) => c.id === draft.startCorner) || CORNERS[0];
  const minRemnantAreaM2 = ((draft.minRemnantWidthMm * draft.minRemnantLengthMm) / 1_000_000).toFixed(
    3
  );

  // Scaled visual preview geometry for Remnant Blueprint (clamped for visual proportion)
  const remVisW = Math.round(
    Math.min(132, Math.max(44, (draft.minRemnantWidthMm / 1000) * 140))
  );
  const remVisH = Math.round(
    Math.min(108, Math.max(38, (draft.minRemnantLengthMm / 1200) * 116))
  );

  // Scaled visual preview geometry for Craft Tolerance Schematic
  const trimVis = Math.min(28, Math.max(0, Math.round(draft.trimStartMm / 8)));
  const marginVis = Math.min(18, Math.max(2, Math.round(draft.defectMarginMm / 4)));
  const gapVis = Math.min(16, Math.max(2, Math.round(2 + draft.pieceGapMm * 0.6)));

  return (
    <dialog
      ref={dialogRef}
      id="studio-settings-dialog"
      closedby="any"
      aria-labelledby={titleId}
      className="native-modal-dialog settings-center-dialog"
    >
      {/* Slim Architectural Top Bar */}
      <div className="sc-head">
        <div className="sc-brand">
          <span className="sc-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="15" height="15">
              <circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <h1 id={titleId}>设置</h1>
        </div>

        <div className="sc-head-right">
          <kbd className="sc-kbd" aria-hidden="true">
            ESC
          </kbd>
          <button
            type="button"
            className="sc-close-btn"
            aria-label="关闭设置弹窗"
            onClick={() => dialogRef.current?.close()}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span>关闭</span>
          </button>
        </div>
      </div>

      {/* Main Split Workspace: Left Vertical Tabs + Right Instrument Deck */}
      <form className="sc-form" onSubmit={handleSave}>
        <div className="sc-body">
          {/* Left Vertical Tab Rail */}
          <div
            className="sc-rail"
            role="tablist"
            aria-orientation="vertical"
            aria-label="系统设置分类"
            {...({ focusgroup: 'tablist nomemory' } as any)}
          >
            <div className="sc-rail-tabs">
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
                    tabIndex={selected ? 0 : -1}
                    {...(selected ? ({ focusgroupstart: '' } as any) : {})}
                    className="sc-tab"
                    onClick={() => setActiveTab(tab.id)}
                    onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  >
                    <span className="sc-tab-ico">{tab.icon}</span>
                    <strong>{tab.label}</strong>
                    {tab.id === 'engines' && allEngines.length > 0 && (
                      <span className="sc-tab-pill num">{readyEngineCount}/{allEngines.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Tab Panels Stack (shared grid cell + hidden="until-found") */}
          <div className="sc-panels-host">
            {/* ==================== TAB 1: 画布与常规 ==================== */}
            <div
              ref={(el) => {
                panelRefs.current.general = el;
              }}
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
                        {/* Machine Bed Surface */}
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
                        {/* Guide Rails */}
                        <line x1="30" y1="26" x2="30" y2="154" stroke="#334155" strokeWidth="3" />
                        <line x1="250" y1="26" x2="250" y2="154" stroke="#334155" strokeWidth="3" />
                        <text x="140" y="21" textAnchor="middle" fill="#64748b" fontSize="10">
                          母卷进给方向 ↓
                        </text>
                        <text x="140" y="168" textAnchor="middle" fill="#64748b" fontSize="10">
                          裁床前端落料口
                        </text>

                        {/* Sample Nested Part Silhouette */}
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

                        {/* Active Origin X / Y Axis Vectors */}
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

                      {/* 4 Tactile Corner Hotspots */}
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

                    {/* Accessible Native Select Synced Underneath for Keyboard / Form Clarity */}
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

            {/* ==================== TAB 2: 裁切工艺与预设 ==================== */}
            <div
              ref={(el) => {
                panelRefs.current.craft = el;
              }}
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

                {/* 4-Up Clean Preset Cards */}
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
                        onClick={() => handleApplyIndustryPreset(preset)}
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

                {/* 2-Column Tolerance Steppers + Visual Craft Schematic */}
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
                    {/* Live Dynamic SVG Schematic of Trim + Gap + Defect Margin */}
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
                        {/* Trim Zone */}
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
                        {/* Two Adjacent Parts separated by pieceGap */}
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
                        {/* Defect Core + Safety Margin Halo */}
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

            {/* ==================== TAB 3: 料头与余料策略 ==================== */}
            <div
              ref={(el) => {
                panelRefs.current.remnant = el;
              }}
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

                  {/* Right Live Proportional Remnant Schematic */}
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
                      {/* Cut Qualified Parts */}
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
                      {/* Dynamic Amber Recoverable Remnant Zone */}
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
                      {/* Below-threshold Scrap Strip */}
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

            {/* ==================== TAB 4: 求解引擎与配额 ==================== */}
            <div
              ref={(el) => {
                panelRefs.current.engines = el;
              }}
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
                    onClick={fetchRuntimeStatus}
                  >
                    {capLoading ? '检测中…' : '↻ 刷新能力'}
                  </button>
                </div>

                {/* Compact Top Telemetry + Budget Strip */}
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

                {/* 2D Parallel Strategy Management Card */}
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
                          onChange={(e) => handleToggleStrategy(st.id, e.target.checked)}
                        />
                      </label>
                    );
                  })}
                </section>

                {/* 1D Slitting Configuration Card */}
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
                    <button type="button" className="btn sm" onClick={fetchRuntimeStatus}>
                      重试
                    </button>
                  </div>
                )}

                {/* Engine Availability Table (business-friendly labels, internal solver ids hidden) */}
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

            {/* ==================== TAB 5: 导出与系统接入 ==================== */}
            <div
              ref={(el) => {
                panelRefs.current.integration = el;
              }}
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

                {/* Live Filename Token Composer + Ticket Toggle */}
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

                {/* CNC Post-Processor Parameters Card */}
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

                {/* 2x2 Clean Endpoint Status Cards */}
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
          </div>
        </div>

        {/* Clean Single-Row Footer */}
        <div className="sc-foot">
          <button type="button" className="btn" onClick={handleRestoreDefaults}>
            恢复默认
          </button>

          <div className="sc-foot-mid" role="status">
            {validationError ? (
              <span className="sc-err-msg">{validationError}</span>
            ) : changedCount > 0 ? (
              <span className="sc-dirty-pill">
                <i aria-hidden="true" /> {changedCount} 项待保存
              </span>
            ) : null}
          </div>

          <div className="sc-foot-actions">
            <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
              取消
            </button>
            <button type="submit" className="btn pri sc-save-btn">
              保存并应用
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
};
