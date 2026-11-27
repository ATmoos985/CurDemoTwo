import React from 'react';
import { NumberInput } from '../../components/ui/NumberInput';
import type { ShowcaseSlitDraft } from './showcaseSlitDraft';

interface ShowcaseSlitConfigCardProps {
  slitDraft: ShowcaseSlitDraft;
  onPatch: (patch: Partial<ShowcaseSlitDraft>) => void;
  onReset: () => void;
}

export const ShowcaseSlitConfigCard: React.FC<ShowcaseSlitConfigCardProps> = ({
  slitDraft,
  onPatch,
  onReset
}) => {
  return (
    <div className="mp-side-section slit-cfg-card" id="demo-slit-params">
      <div className="wb-right-section-head">
        <span>一维搭切参数设置</span>
        <button
          type="button"
          className="link-btn"
          onClick={onReset}
          title="恢复此示例默认参数"
        >
          恢复示例默认
        </button>
      </div>

      <div className="seg" role="group" aria-label="示例幅宽模式" style={{ width: '100%' }}>
        <button
          type="button"
          className={slitDraft.widthMode === 'FLEXIBLE' ? 'on' : ''}
          onClick={() => onPatch({ widthMode: 'FLEXIBLE' })}
        >
          可变幅宽区间
        </button>
        <button
          type="button"
          className={slitDraft.widthMode === 'FIXED' ? 'on' : ''}
          onClick={() =>
            onPatch({
              widthMode: 'FIXED',
              minWidthMm: slitDraft.maxWidthMm
            })
          }
        >
          固定组合宽
        </button>
      </div>

      <div className="slit-cfg-grid">
        <label className="slit-cfg-field">
          <span>母卷总宽 (mm)</span>
          <NumberInput
            min={200}
            fallback={200}
            className="field num"
            value={slitDraft.motherWidthMm}
            onValueChange={(w) => {
              const usable = Math.max(100, w - slitDraft.leftTrimMm - slitDraft.rightTrimMm);
              const nextMax = Math.min(slitDraft.maxWidthMm, usable);
              onPatch({
                motherWidthMm: w,
                maxWidthMm: nextMax,
                minWidthMm:
                  slitDraft.widthMode === 'FIXED'
                    ? nextMax
                    : Math.min(slitDraft.minWidthMm, nextMax)
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
            value={slitDraft.totalOverCap}
            onValueChange={(v) => onPatch({ totalOverCap: v })}
          />
        </label>
        <label className="slit-cfg-field">
          <span>左切边 (mm)</span>
          <NumberInput
            min={0}
            fallback={0}
            className="field num"
            value={slitDraft.leftTrimMm}
            onValueChange={(lt) => {
              const usable = Math.max(100, slitDraft.motherWidthMm - lt - slitDraft.rightTrimMm);
              onPatch({
                leftTrimMm: lt,
                maxWidthMm: Math.min(slitDraft.maxWidthMm, usable),
                minWidthMm: Math.min(slitDraft.minWidthMm, usable)
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
            value={slitDraft.rightTrimMm}
            onValueChange={(rt) => {
              const usable = Math.max(100, slitDraft.motherWidthMm - slitDraft.leftTrimMm - rt);
              onPatch({
                rightTrimMm: rt,
                maxWidthMm: Math.min(slitDraft.maxWidthMm, usable),
                minWidthMm: Math.min(slitDraft.minWidthMm, usable)
              });
            }}
          />
        </label>
        {slitDraft.widthMode === 'FLEXIBLE' ? (
          <>
            <label className="slit-cfg-field">
              <span>最小组合宽 (mm)</span>
              <NumberInput
                min={100}
                fallback={100}
                className="field num"
                value={slitDraft.minWidthMm}
                onValueChange={(v) => onPatch({ minWidthMm: v })}
              />
            </label>
            <label className="slit-cfg-field">
              <span>最大组合宽 (mm)</span>
              <NumberInput
                min={100}
                fallback={100}
                className="field num"
                value={slitDraft.maxWidthMm}
                onValueChange={(v) => onPatch({ maxWidthMm: v })}
              />
            </label>
            <label className="slit-cfg-field">
              <span>幅宽步长 (mm)</span>
              <NumberInput
                min={1}
                fallback={10}
                className="field num"
                value={slitDraft.widthStepMm}
                onValueChange={(v) => onPatch({ widthStepMm: v })}
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
              value={slitDraft.maxWidthMm}
              onValueChange={(v) => onPatch({ maxWidthMm: v, minWidthMm: v })}
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
            value={slitDraft.timeLimitSeconds}
            onValueChange={(v) => onPatch({ timeLimitSeconds: v })}
          />
        </label>
      </div>

      <details className="slit-adv-fold">
        <summary className="num">
          高级参数 · 宽幅≤{slitDraft.maxDistinctWidths}
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
              value={slitDraft.topK}
              onValueChange={(v) => onPatch({ topK: v })}
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
              value={slitDraft.maxIterations}
              onValueChange={(v) => onPatch({ maxIterations: v })}
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
              value={slitDraft.maxPatterns}
              onValueChange={(v) => onPatch({ maxPatterns: v })}
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
              value={slitDraft.maxDistinctWidths}
              onValueChange={(v) => onPatch({ maxDistinctWidths: v })}
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
              value={slitDraft.stageTimeLimitMs}
              onValueChange={(v) => onPatch({ stageTimeLimitMs: v })}
            />
          </label>
          <label className="slit-both-toggle span-2">
            <input
              type="checkbox"
              checked={slitDraft.lnsEnabled}
              onChange={(e) => onPatch({ lnsEnabled: e.target.checked })}
            />
            <span>精细优化启用深度邻域搜索</span>
          </label>
        </div>
      </details>
    </div>
  );
};
