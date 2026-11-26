import React, { useEffect, useMemo, useState } from 'react';
import type { BoardCutLine } from '../../components/WorkbenchBoardCanvas';
import { computeToolpathSegments } from '../../components/canvas/canvasGeometry';

export interface ToolpathPlayerBarProps {
  cuts: BoardCutLine[];
  startCorner: 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom';
  rollWidthMm: number;
  rollLengthMm: number;
  simCutStep: number | null;
  onChangeSimCutStep: (next: number | null) => void;
}

const SPEEDS: Array<1 | 2 | 4> = [1, 2, 4];

export const ToolpathPlayerBar: React.FC<ToolpathPlayerBarProps> = ({
  cuts,
  startCorner,
  rollWidthMm,
  rollLengthMm,
  simCutStep,
  onChangeSimCutStep
}) => {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);

  const metrics = useMemo(
    () => computeToolpathSegments(cuts, startCorner, rollWidthMm, rollLengthMm),
    [cuts, startCorner, rollWidthMm, rollLengthMm]
  );

  const totalSteps = metrics.segments.length;

  useEffect(() => {
    if (totalSteps === 0) {
      setPlaying(false);
      if (simCutStep != null) onChangeSimCutStep(null);
    }
  }, [totalSteps]);

  useEffect(() => {
    if (!playing || totalSteps === 0) return;
    const intervalMs = Math.max(120, Math.round(700 / speed));
    const timer = window.setInterval(() => {
      onChangeSimCutStep(
        (() => {
          const cur = simCutStep == null ? 0 : simCutStep;
          if (cur >= totalSteps) {
            setPlaying(false);
            return totalSteps;
          }
          return cur + 1;
        })()
      );
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, speed, simCutStep, totalSteps, onChangeSimCutStep]);

  if (totalSteps === 0) return null;

  const activeIdx = simCutStep == null ? totalSteps : Math.max(0, Math.min(totalSteps, simCutStep));
  const currentSeg = activeIdx > 0 ? metrics.segments[activeIdx - 1] : null;
  const kindLabel = currentSeg
    ? currentSeg.kind === 'HORIZONTAL'
      ? '横切'
      : currentSeg.kind === 'VERTICAL'
      ? '纵切'
      : '轮廓切'
    : '就绪';

  const handleTogglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (simCutStep == null || simCutStep >= totalSteps) {
      onChangeSimCutStep(1);
    }
    setPlaying(true);
  };

  const handleStep = (delta: -1 | 1) => {
    setPlaying(false);
    const cur = simCutStep == null ? 0 : simCutStep;
    const next = Math.max(1, Math.min(totalSteps, cur + delta));
    onChangeSimCutStep(next);
  };

  const handleReset = () => {
    setPlaying(false);
    onChangeSimCutStep(1);
  };

  const handleShowAll = () => {
    setPlaying(false);
    onChangeSimCutStep(null);
  };

  return (
    <div className="wb-sim-bar" role="region" aria-label="走刀动画仿真控制条">
      <div className="wb-sim-controls">
        <button
          type="button"
          className={playing ? 'on' : ''}
          onClick={handleTogglePlay}
          title="连续播放/暂停刀路与提刀空程动画"
        >
          {playing ? '❚❚ 暂停' : '▶ 走刀仿真'}
        </button>

        <div className="wb-sim-speeds" role="group" aria-label="仿真倍速">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              type="button"
              className={speed === sp ? 'on' : ''}
              aria-pressed={speed === sp}
              onClick={() => setSpeed(sp)}
            >
              {sp}x
            </button>
          ))}
        </div>

        <button type="button" onClick={() => handleStep(-1)} disabled={activeIdx <= 1 && simCutStep != null}>
          上一刀
        </button>
        <button type="button" onClick={() => handleStep(1)} disabled={simCutStep != null && activeIdx >= totalSteps}>
          下一刀
        </button>
        <button type="button" onClick={handleReset}>
          重头
        </button>
        <button
          type="button"
          className={simCutStep == null ? 'on' : ''}
          onClick={handleShowAll}
        >
          全部刀路
        </button>
      </div>

      <span className="wb-sim-status num">
        {simCutStep == null
          ? `共 ${totalSteps} 刀 · 切程 ${Math.round(metrics.totalCutMm)}mm · 空程 ${Math.round(metrics.totalRapidMm)}mm`
          : `第 ${activeIdx}/${totalSteps} 刀 · ${kindLabel}${
              currentSeg ? ` · 切 ${currentSeg.cutDistMm}mm / 空 ${currentSeg.rapidDistMm}mm` : ''
            }`}
      </span>
    </div>
  );
};
