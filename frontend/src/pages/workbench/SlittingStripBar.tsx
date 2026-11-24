import React from 'react';
import { STRIP_COLORS } from './workbenchTypes';

export function SlittingStripBar({
  motherWidthMm,
  leftTrimMm,
  rightTrimMm,
  stations
}: {
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  stations: { widthMm: number; countPerRepetition: number }[];
}) {
  const strips = stations.flatMap((s) => Array(s.countPerRepetition).fill(s.widthMm));
  const usedWidth = strips.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, motherWidthMm - leftTrimMm - rightTrimMm - usedWidth);

  return (
    <div
      className="slit-bar-wrap"
      title={`总幅宽 ${motherWidthMm}mm · 已用 ${usedWidth}mm · 余宽 ${spare}mm`}
    >
      {leftTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(leftTrimMm / motherWidthMm) * 100}%` }}
        >
          {leftTrimMm >= 60 ? `${leftTrimMm}` : ''}
        </div>
      )}
      {strips.map((w, idx) => (
        <div
          key={idx}
          className="slit-seg"
          style={{
            width: `${(w / motherWidthMm) * 100}%`,
            backgroundColor: STRIP_COLORS[w % STRIP_COLORS.length]
          }}
        >
          <span>{w}</span>
        </div>
      ))}
      {spare > 0 && (
        <div
          className="slit-seg slit-spare"
          style={{ width: `${(spare / motherWidthMm) * 100}%` }}
        >
          {spare >= 80 ? `余 ${spare}` : ''}
        </div>
      )}
      {rightTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(rightTrimMm / motherWidthMm) * 100}%` }}
        >
          {rightTrimMm >= 60 ? `${rightTrimMm}` : ''}
        </div>
      )}
    </div>
  );
}
