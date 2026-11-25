import React, { useState } from 'react';
import {
  SlittingWidthMode,
  SlittingWidthPreset,
  StudioSettings,
  loadSlittingPresets,
  saveCustomSlittingPresets
} from '../../store/studioSettings';
import { NumberInput } from '../../components/ui/NumberInput';
import { toast } from '@static/app/js/util.js';

export interface SlittingConfigCardProps {
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
  setSlitSpec: (spec: Record<string, any>) => void;
  settings: StudioSettings;
  updateStudioSettings: (next: StudioSettings) => void;
}

export const SlittingConfigCard: React.FC<SlittingConfigCardProps> = ({
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

  const usableWidthMm = Math.max(0, slitMotherWidthMm - slitLeftTrimMm - slitRightTrimMm);
  const widthStepsCount =
    slitWidthMode === 'FIXED'
      ? 1
      : slitMaxWidthMm >= slitMinWidthMm
      ? Math.floor((slitMaxWidthMm - slitMinWidthMm) / Math.max(1, slitWidthStepMm)) + 1
      : 0;

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
    toast(`已保存预设「${clean}」`);
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
    <div className="wb-param-card" id="wb-slitting-params">
      <div className="wb-param-head">
        <span>分切工艺</span>
        <span className="wb-param-badge num" title={`母卷 ${slitMotherWidthMm}mm 扣切边后可切净宽`}>
          净宽 {usableWidthMm}mm{slitWidthMode === 'FLEXIBLE' ? ` · ${widthStepsCount}档` : ''}
        </span>
      </div>

      {/* Preset Loader & Saver */}
      <div className="slit-preset-row">
        <select
          className="field"
          aria-label="一维幅宽预设"
          value={selectedSlitPresetId}
          onChange={(e) => handleApplySlitPreset(e.target.value)}
        >
          <option value="">套用工艺预设…</option>
          {slitPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm"
          title="将当前工艺保存为预设"
          onClick={() => setSavingPresetOpen((v) => !v)}
        >
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
            确定
          </button>
        </div>
      )}

      {/* Left / Right Trim Pair */}
      <div className="wb-param-grid-2">
        <label className="wb-field">
          <span>左切边</span>
          <div className="wb-input-unit">
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
            <em>mm</em>
          </div>
        </label>
        <label className="wb-field">
          <span>右切边</span>
          <div className="wb-input-unit">
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
            <em>mm</em>
          </div>
        </label>
      </div>

      {/* Width Mode Switcher */}
      <div className="seg" role="group" aria-label="幅宽约束模式">
        <button
          type="button"
          className={slitWidthMode === 'FLEXIBLE' ? 'on' : ''}
          aria-pressed={slitWidthMode === 'FLEXIBLE'}
          onClick={() => setSlitSpec({ slitWidthMode: 'FLEXIBLE' })}
        >
          可变组合宽
        </button>
        <button
          type="button"
          className={slitWidthMode === 'FIXED' ? 'on' : ''}
          aria-pressed={slitWidthMode === 'FIXED'}
          onClick={() => setSlitSpec({ slitWidthMode: 'FIXED', slitMinWidthMm: slitMaxWidthMm })}
        >
          固定组合宽
        </button>
      </div>

      {/* Width Bounds (always symmetric, zero half-empty row) */}
      {slitWidthMode === 'FLEXIBLE' ? (
        <div className="wb-param-grid-3">
          <label className="wb-field">
            <span>最小宽</span>
            <NumberInput
              min={100}
              fallback={100}
              className="field num"
              value={slitMinWidthMm}
              onValueChange={(v) => setSlitSpec({ slitMinWidthMm: v })}
            />
          </label>
          <label className="wb-field">
            <span>最大宽</span>
            <NumberInput
              min={100}
              fallback={100}
              className="field num"
              value={slitMaxWidthMm}
              onValueChange={(v) => setSlitSpec({ slitMaxWidthMm: v })}
            />
          </label>
          <label className="wb-field">
            <span>步长</span>
            <NumberInput
              min={1}
              fallback={10}
              className="field num"
              value={slitWidthStepMm}
              onValueChange={(v) => setSlitSpec({ slitWidthStepMm: v })}
            />
          </label>
        </div>
      ) : (
        <label className="wb-field-inline">
          <span>组合宽</span>
          <div className="wb-input-unit">
            <NumberInput
              min={100}
              fallback={100}
              className="field num"
              value={slitMaxWidthMm}
              onValueChange={(v) => setSlitSpec({ slitMaxWidthMm: v, slitMinWidthMm: v })}
            />
            <em>mm</em>
          </div>
        </label>
      )}

      {/* Overproduction Cap & Time Budget Pair */}
      <div className="wb-param-grid-2">
        <label className="wb-field">
          <span>超产上限</span>
          <div className="wb-input-unit">
            <NumberInput
              min={0}
              max={10000}
              fallback={0}
              integer
              className="field num"
              value={slitOverCap}
              onValueChange={(v) => setSlitSpec({ slitOverCap: v })}
            />
            <em>卷</em>
          </div>
        </label>
        <label className="wb-field">
          <span>求解时限</span>
          <div className="wb-input-unit">
            <NumberInput
              min={1}
              max={180}
              fallback={30}
              integer
              className="field num"
              value={settings.slitTimeLimitSeconds}
              onValueChange={(v) => updateStudioSettings({ ...settings, slitTimeLimitSeconds: v })}
            />
            <em>秒</em>
          </div>
        </label>
      </div>

      {/* Collapsible Physical Slitting Knife Constraints (默认 0 表示不限制) */}
      {(() => {
        const activeCount =
          (slitMaxKnives > 0 ? 1 : 0) +
          (slitMinBladeSpacingMm > 0 ? 1 : 0) +
          (slitKerfMm > 0 ? 1 : 0) +
          (slitForbiddenNarrowEdgeMaxMm > 0 ? 1 : 0);
        return (
          <details className="wb-param-fold">
            <summary>
              刀架物理约束
              {activeCount > 0 ? ` · 已设 ${activeCount} 项` : '（可选）'}
            </summary>
            <div className="wb-param-grid-2" style={{ marginTop: 7 }}>
              <label className="wb-field" title="单车同时分切最大刀数/条数，0 表示不限制（1–100）">
                <span>最大刀数</span>
                <div className="wb-input-unit">
                  <NumberInput
                    min={0}
                    max={100}
                    fallback={0}
                    integer
                    placeholder="不限"
                    className="field num"
                    value={slitMaxKnives}
                    onValueChange={(v) => setSlitSpec({ slitMaxKnives: v })}
                  />
                  <em>刀</em>
                </div>
              </label>
              <label className="wb-field" title="相邻刀片最小物理间距，0 表示不限制（1–100000 mm）">
                <span>最小刀距</span>
                <div className="wb-input-unit">
                  <NumberInput
                    min={0}
                    max={100000}
                    fallback={0}
                    integer
                    placeholder="不限"
                    className="field num"
                    value={slitMinBladeSpacingMm}
                    onValueChange={(v) => setSlitSpec({ slitMinBladeSpacingMm: v })}
                  />
                  <em>mm</em>
                </div>
              </label>
              <label className="wb-field" title="相邻分切条之间每刀切缝损耗，0 表示不计（0–500 mm）">
                <span>切缝损耗</span>
                <div className="wb-input-unit">
                  <NumberInput
                    min={0}
                    max={500}
                    fallback={0}
                    integer
                    placeholder="0"
                    className="field num"
                    value={slitKerfMm}
                    onValueChange={(v) => setSlitSpec({ slitKerfMm: v })}
                  />
                  <em>mm</em>
                </div>
              </label>
              <div className="wb-field" style={{ justifyContent: 'flex-end' }}>
                <span className="muted" style={{ fontSize: 11, lineHeight: 1.35 }}>
                  填 0 表示不限制
                </span>
              </div>
              <label
                className="wb-field"
                title="危险细边丝禁区下限（须与上限成对生效，如 1~30mm 禁止出现细边丝）"
              >
                <span>禁区边丝下限</span>
                <div className="wb-input-unit">
                  <NumberInput
                    min={0}
                    max={100000}
                    fallback={0}
                    integer
                    placeholder="0"
                    className="field num"
                    value={slitForbiddenNarrowEdgeMinMm}
                    onValueChange={(v) => setSlitSpec({ slitForbiddenNarrowEdgeMinMm: v })}
                  />
                  <em>mm</em>
                </div>
              </label>
              <label
                className="wb-field"
                title="危险细边丝禁区上限，0 表示不启用边丝禁区"
              >
                <span>禁区边丝上限</span>
                <div className="wb-input-unit">
                  <NumberInput
                    min={0}
                    max={100000}
                    fallback={0}
                    integer
                    placeholder="不限"
                    className="field num"
                    value={slitForbiddenNarrowEdgeMaxMm}
                    onValueChange={(v) => setSlitSpec({ slitForbiddenNarrowEdgeMaxMm: v })}
                  />
                  <em>mm</em>
                </div>
              </label>
            </div>
          </details>
        );
      })()}

      {/* Collapsible Advanced Tuning */}
      <details className="wb-param-fold">
        <summary>更多参数</summary>
        <div className="wb-param-grid-2" style={{ marginTop: 7 }}>
          <label className="wb-field">
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
          <label className="wb-field">
            <span>宽幅上限</span>
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
          <label className="wb-field">
            <span>迭代上限</span>
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
          <label className="wb-field">
            <span>花型池上限</span>
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
          <label className="wb-field span-2">
            <span>单阶段时限</span>
            <div className="wb-input-unit">
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
              <em>ms</em>
            </div>
          </label>
        </div>
      </details>
    </div>
  );
};
