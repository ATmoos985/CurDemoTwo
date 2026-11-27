import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { requestJSON, toast } from '../lib/core/util.js';
import { presets, matchPreset } from '../lib/domain/industry-profiles.js';
import {
  DEFAULT_STUDIO_SETTINGS,
  SettingsTabId,
  StudioSettings,
  WORKBENCH_STRATEGIES_2D,
  applyThemeToDocument,
  loadStudioSettings,
  validateStudioSettings
} from '../store/studioSettings';
import { getStudioSettingsSnapshot, useStudioSettingsStore } from '../store/selectors';
import {
  SettingsModalProps,
  TABS,
  countChangedFields
} from './settings/settingsMeta';
import { SettingsGeneralTab } from './settings/SettingsGeneralTab';
import { SettingsCraftTab } from './settings/SettingsCraftTab';
import { SettingsRemnantTab } from './settings/SettingsRemnantTab';
import { SettingsEnginesTab } from './settings/SettingsEnginesTab';
import { SettingsIntegrationTab } from './settings/SettingsIntegrationTab';

export type { SettingsModalProps };

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

  const { settings: storeSettings, updateStudioSettings } = useStudioSettingsStore();

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
      requestJSON('/api/v2/health').catch(() => null)
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
      applyThemeToDocument(getStudioSettingsSnapshot().theme);
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

          <div className="sc-panels-host">
            <SettingsGeneralTab
              panelRef={(el) => {
                panelRefs.current.general = el;
              }}
              draft={draft}
              patchDraft={patchDraft}
            />
            <SettingsCraftTab
              panelRef={(el) => {
                panelRefs.current.craft = el;
              }}
              draft={draft}
              patchDraft={patchDraft}
              industryPresets={industryPresets}
              matchedPresetId={matchedPresetId}
              onApplyIndustryPreset={handleApplyIndustryPreset}
            />
            <SettingsRemnantTab
              panelRef={(el) => {
                panelRefs.current.remnant = el;
              }}
              draft={draft}
              patchDraft={patchDraft}
            />
            <SettingsEnginesTab
              panelRef={(el) => {
                panelRefs.current.engines = el;
              }}
              draft={draft}
              patchDraft={patchDraft}
              cap={cap}
              capLoading={capLoading}
              capError={capError}
              allEngines={allEngines}
              onRefreshStatus={fetchRuntimeStatus}
              onToggleStrategy={handleToggleStrategy}
            />
            <SettingsIntegrationTab
              panelRef={(el) => {
                panelRefs.current.integration = el;
              }}
              draft={draft}
              patchDraft={patchDraft}
              healthInfo={healthInfo}
            />
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
