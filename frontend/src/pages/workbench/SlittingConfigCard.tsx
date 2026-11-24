import React, { useState } from 'react';
import {
  SlittingProfile,
  SlittingWidthMode,
  SlittingWidthPreset,
  StudioSettings,
  loadSlittingPresets,
  saveCustomSlittingPresets
} from '../../store/studioSettings';
import { NumberInput } from '../../components/ui/NumberInput';
import { toast } from '@static/app/js/util.js';
import { openEngineSettings } from './workbenchUtils';

export interface SlittingConfigCardProps {
  slitProfile: SlittingProfile;
  slitWidthMode: SlittingWidthMode;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  setSlitSpec: (spec: Record<string, any>) => void;
  settings: StudioSettings;
  updateStudioSettings: (next: StudioSettings) => void;
}

export const SlittingConfigCard: React.FC<SlittingConfigCardProps> = ({
  slitProfile,
  slitWidthMode,
  slitMotherWidthMm,
  slitLeftTrimMm,
  slitRightTrimMm,
  slitMinWidthMm,
  slitMaxWidthMm,
  slitWidthStepMm,
  slitOverCap,
  setSlitSpec,
  settings,
  updateStudioSettings
}) => {
  const [slitPresets, setSlitPresets] = useState<SlittingWidthPreset[]>(() =>
    loadSlittingPresets()
  );
  const [selectedSlitPresetId, setSelectedSlitPresetId] = useState<string>('');
  const [savingPresetOpen, setSavingPresetOpen] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

  const handleApplySlitPreset = (presetId: string) => {
    setSelectedSlitPresetId(presetId);
    const p = slitPresets.find((item) => item.id === presetId);
    if (!p) return;
    setSlitSpec({
      slitMotherWidthMm: p.motherWidthMm,
      slitLeftTrimMm: p.leftTrimMm,
      slitRightTrimMm: p.rightTrimMm,
      slitMinWidthMm: p.widthMode === 'FIXED' ? p.maxWidthMm : p.minWidthMm,
      slitMaxWidthMm: p.maxWidthMm,
      slitWidthStepMm: p.widthStepMm,
      slitOverCap: p.totalOverCap,
      slitWidthMode: p.widthMode
    });
  };

  const handleSaveCurrentSlitPreset = () => {
    const clean = newPresetName.trim();
    if (!clean) {
      toast('请输入预设名称', true);
      return;
    }
    const created: SlittingWidthPreset = {
      id: `preset-custom-${Date.now()}`,
      name: clean,
      motherWidthMm: Math.floor(slitMotherWidthMm),
      leftTrimMm: Math.floor(slitLeftTrimMm),
      rightTrimMm: Math.floor(slitRightTrimMm),
      minWidthMm:
        slitWidthMode === 'FIXED' ? Math.floor(slitMaxWidthMm) : Math.floor(slitMinWidthMm),
      maxWidthMm: Math.floor(slitMaxWidthMm),
      widthStepMm: Math.max(1, Math.floor(slitWidthStepMm)),
      totalOverCap: Math.max(0, Math.floor(slitOverCap)),
      widthMode: slitWidthMode,
      builtin: false
    };
    const next = saveCustomSlittingPresets([...slitPresets, created]);
    setSlitPresets(next);
    setSelectedSlitPresetId(created.id);
    setNewPresetName('');
    setSavingPresetOpen(false);
    toast(`已保存一维预设「${clean}」`);
  };

  const handleDeleteSelectedSlitPreset = () => {
    const target = slitPresets.find((p) => p.id === selectedSlitPresetId);
    if (!target || target.builtin) return;
    const next = saveCustomSlittingPresets(slitPresets.filter((p) => p.id !== target.id));
    setSlitPresets(next);
    setSelectedSlitPresetId('');
    toast(`已删除预设「${target.name}」`);
  };

  return (
    <div className="wb-right-section slit-cfg-card" id="wb-slitting-params">
      <div className="wb-right-section-head">
        <span>分切参数</span>
        <button
          type="button"
          className="link-btn"
          onClick={openEngineSettings}
          title="在系统设置中调整全部求解参数"
        >
          高级 ↗
        </button>
      </div>

      {/* Preset Loader & Saver */}
      <div className="slit-preset-row">
        <select
          className="field"
          aria-label="一维幅宽预设"
          value={selectedSlitPresetId}
          onChange={(e) => handleApplySlitPreset(e.target.value)}
        >
          <option value="">预设…</option>
          {slitPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className="btn sm" onClick={() => setSavingPresetOpen((v) => !v)}>
          保存
        </button>
        {selectedSlitPresetId &&
          !slitPresets.find((p) => p.id === selectedSlitPresetId)?.builtin && (
            <button
              type="button"
              className="btn sm"
              onClick={handleDeleteSelectedSlitPreset}
              title="删除当前自定义预设"
            >
              删
            </button>
          )}
      </div>
      {savingPresetOpen && (
        <div className="slit-preset-row">
          <input
            type="text"
            className="field"
            placeholder="预设名称"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveCurrentSlitPreset();
              }
            }}
          />
          <button type="button" className="btn sm pri" onClick={handleSaveCurrentSlitPreset}>
            确认
          </button>
        </div>
      )}

      {/* Solver Profile Switcher (FAST / QUALITY) */}
      <div className="slit-profile-bar">
        <div className="seg" role="group" aria-label="一维求解档位" style={{ flex: 1 }}>
          <button
            type="button"
            className={slitProfile === 'FAST' ? 'on' : ''}
            aria-pressed={slitProfile === 'FAST'}
            title="快捷解 (FAST)"
            onClick={() => setSlitSpec({ slitProfile: 'FAST' })}
          >
            快捷
          </button>
          <button
            type="button"
            className={slitProfile === 'QUALITY' ? 'on' : ''}
            aria-pressed={slitProfile === 'QUALITY'}
            title="精确解 (QUALITY)"
            onClick={() => setSlitSpec({ slitProfile: 'QUALITY' })}
          >
            精确
          </button>
        </div>
        <label className="slit-both-toggle" title="同时运行快捷与精确解对比">
          <input
            type="checkbox"
            checked={settings.slitRunBothProfiles}
            onChange={(e) =>
              updateStudioSettings({
                ...settings,
                slitRunBothProfiles: e.target.checked
              })
            }
          />
          <span>双档对比</span>
        </label>
      </div>

      {/* Width Mode */}
      <div className="seg" role="group" aria-label="幅宽约束模式" style={{ width: '100%' }}>
        <button
          type="button"
          className={slitWidthMode === 'FLEXIBLE' ? 'on' : ''}
          onClick={() => setSlitSpec({ slitWidthMode: 'FLEXIBLE' })}
        >
          可变宽
        </button>
        <button
          type="button"
          className={slitWidthMode === 'FIXED' ? 'on' : ''}
          onClick={() => setSlitSpec({ slitWidthMode: 'FIXED', slitMinWidthMm: slitMaxWidthMm })}
        >
          固定宽
        </button>
      </div>

      <div className="slit-cfg-grid">
        <label className="slit-cfg-field">
          <span>母卷总宽 (mm)</span>
          <NumberInput
            min={500}
            fallback={500}
            className="field num"
            value={slitMotherWidthMm}
            onValueChange={(w) => {
              const usable = Math.max(100, w - slitLeftTrimMm - slitRightTrimMm);
              setSlitSpec({
                slitMotherWidthMm: w,
                slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                slitMinWidthMm:
                  slitWidthMode === 'FIXED'
                    ? Math.min(slitMaxWidthMm, usable)
                    : Math.min(slitMinWidthMm, usable)
              });
            }}
          />
        </label>
        <label className="slit-cfg-field">
          <span>超产上限 (卷)</span>
          <NumberInput
            min={0}
            max={10000}
            fallback={0}
            integer
            className="field num"
            value={slitOverCap}
            onValueChange={(v) => setSlitSpec({ slitOverCap: v })}
          />
        </label>
        <label className="slit-cfg-field">
          <span>左切边 (mm)</span>
          <NumberInput
            min={0}
            fallback={0}
            className="field num"
            value={slitLeftTrimMm}
            onValueChange={(lt) => {
              const usable = Math.max(100, slitMotherWidthMm - lt - slitRightTrimMm);
              setSlitSpec({
                slitLeftTrimMm: lt,
                slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                slitMinWidthMm: Math.min(slitMinWidthMm, usable)
              });
            }}
          />
        </label>
        <label className="slit-cfg-field">
          <span>右切边 (mm)</span>
          <NumberInput
            min={0}
            fallback={0}
            className="field num"
            value={slitRightTrimMm}
            onValueChange={(rt) => {
              const usable = Math.max(100, slitMotherWidthMm - slitLeftTrimMm - rt);
              setSlitSpec({
                slitRightTrimMm: rt,
                slitMaxWidthMm: Math.min(slitMaxWidthMm, usable),
                slitMinWidthMm: Math.min(slitMinWidthMm, usable)
              });
            }}
          />
        </label>
        {slitWidthMode === 'FLEXIBLE' ? (
          <>
            <label className="slit-cfg-field">
              <span>最小组合宽 (mm)</span>
              <NumberInput
                min={100}
                fallback={100}
                className="field num"
                value={slitMinWidthMm}
                onValueChange={(v) => setSlitSpec({ slitMinWidthMm: v })}
              />
            </label>
            <label className="slit-cfg-field">
              <span>最大组合宽 (mm)</span>
              <NumberInput
                min={100}
                fallback={100}
                className="field num"
                value={slitMaxWidthMm}
                onValueChange={(v) => setSlitSpec({ slitMaxWidthMm: v })}
              />
            </label>
            <label className="slit-cfg-field">
              <span>幅宽步长 (mm)</span>
              <NumberInput
                min={1}
                fallback={10}
                className="field num"
                value={slitWidthStepMm}
                onValueChange={(v) => setSlitSpec({ slitWidthStepMm: v })}
              />
            </label>
          </>
        ) : (
          <label className="slit-cfg-field span-2">
            <span>固定组合宽 (mm)</span>
            <NumberInput
              min={100}
              fallback={100}
              className="field num"
              value={slitMaxWidthMm}
              onValueChange={(v) => setSlitSpec({ slitMaxWidthMm: v, slitMinWidthMm: v })}
            />
          </label>
        )}
        <label className="slit-cfg-field">
          <span>求解时限 (秒)</span>
          <NumberInput
            min={1}
            max={180}
            fallback={30}
            integer
            className="field num"
            value={settings.slitTimeLimitSeconds}
            onValueChange={(v) => updateStudioSettings({ ...settings, slitTimeLimitSeconds: v })}
          />
        </label>
      </div>

      <div className="slit-cfg-summary num">
        可切净宽 <b>{Math.max(0, slitMotherWidthMm - slitLeftTrimMm - slitRightTrimMm)}</b> mm ·
        候选宽{' '}
        <b>
          {slitWidthMode === 'FIXED'
            ? 1
            : slitMaxWidthMm >= slitMinWidthMm
            ? Math.floor((slitMaxWidthMm - slitMinWidthMm) / Math.max(1, slitWidthStepMm)) + 1
            : 0}
        </b>{' '}
        档
      </div>

      {/* Collapsible Advanced Solver Parameters */}
      <details className="slit-adv-fold">
        <summary className="num">
          高级参数 · 宽幅≤{settings.slitMaxDistinctWidths}
        </summary>
        <div className="slit-cfg-grid" style={{ marginTop: 6 }}>
          <label className="slit-cfg-field">
            <span>TOP K 超产</span>
            <NumberInput
              min={0}
              max={50}
              fallback={0}
              integer
              className="field num"
              value={settings.slitTopK}
              onValueChange={(v) => updateStudioSettings({ ...settings, slitTopK: v })}
            />
          </label>
          <label className="slit-cfg-field">
            <span>列生成迭代</span>
            <NumberInput
              min={1}
              max={5000}
              step={10}
              fallback={300}
              integer
              className="field num"
              value={settings.slitMaxIterations}
              onValueChange={(v) => updateStudioSettings({ ...settings, slitMaxIterations: v })}
            />
          </label>
          <label className="slit-cfg-field">
            <span>最大花型池</span>
            <NumberInput
              min={1}
              max={20000}
              step={50}
              fallback={800}
              integer
              className="field num"
              value={settings.slitMaxPatterns}
              onValueChange={(v) => updateStudioSettings({ ...settings, slitMaxPatterns: v })}
            />
          </label>
          <label className="slit-cfg-field">
            <span>不同宽幅上限</span>
            <NumberInput
              min={1}
              max={20}
              fallback={4}
              integer
              className="field num"
              value={settings.slitMaxDistinctWidths}
              onValueChange={(v) =>
                updateStudioSettings({ ...settings, slitMaxDistinctWidths: v })
              }
            />
          </label>
          <label className="slit-cfg-field span-2">
            <span>单阶段时限 (ms)</span>
            <NumberInput
              min={1000}
              max={600000}
              step={1000}
              fallback={120000}
              integer
              className="field num"
              value={settings.slitStageTimeLimitMs}
              onValueChange={(v) => updateStudioSettings({ ...settings, slitStageTimeLimitMs: v })}
            />
          </label>
        </div>
      </details>
    </div>
  );
};
