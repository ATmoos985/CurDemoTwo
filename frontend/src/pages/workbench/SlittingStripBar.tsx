export interface SlittingStripBarProps {
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  stations: { widthMm: number; countPerRepetition: number }[];
  minWidthMm?: number;
  maxWidthMm?: number;
  highlightedWidthMm?: number | null;
  dimAll?: boolean;
  onHoverWidth?: (widthMm: number | null) => void;
}

/**
 * 统一冷蓝单色阶（窄浅宽深，保持高文字对比度），杜绝随机彩虹撞色与告警色混淆。
 */
function stripToneByWidth(widthMm: number, minW: number, maxW: number): { bg: string; fg: string } {
  const ratio =
    maxW > minW ? Math.min(1, Math.max(0, (widthMm - minW) / (maxW - minW))) : 0.45;
  const hue = Math.round(222 + ratio * 8); // 222 -> 230（统一品牌蓝靛色相）
  const sat = Math.round(48 + ratio * 14); // 48% -> 62%
  const light = Math.round(92 - ratio * 21); // 92%（窄条通透浅蓝）-> 71%（宽条沉稳冷蓝）
  return {
    bg: `hsl(${hue}, ${sat}%, ${light}%)`,
    fg: light <= 74 ? '#0f172a' : '#1e293b'
  };
}

export function SlittingStripBar({
  motherWidthMm,
  leftTrimMm,
  rightTrimMm,
  stations,
  minWidthMm,
  maxWidthMm,
  highlightedWidthMm = null,
  dimAll = false,
  onHoverWidth
}: SlittingStripBarProps) {
  const strips = stations.flatMap((s) => Array(s.countPerRepetition).fill(s.widthMm));
  const usedWidth = strips.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, motherWidthMm - leftTrimMm - rightTrimMm - usedWidth);

  const localMin =
    minWidthMm != null ? minWidthMm : strips.length ? Math.min(...strips) : 0;
  const localMax =
    maxWidthMm != null ? maxWidthMm : strips.length ? Math.max(...strips) : 0;
  const hasHighlight = highlightedWidthMm != null;

  return (
    <div
      className={`slit-bar-wrap${dimAll ? ' is-dimmed' : ''}`}
      title={`母卷 ${motherWidthMm}mm · 已切 ${usedWidth}mm · 余 ${spare}mm`}
      onMouseLeave={onHoverWidth ? () => onHoverWidth(null) : undefined}
    >
      {leftTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(leftTrimMm / motherWidthMm) * 100}%` }}
          title={`左切边 ${leftTrimMm}mm`}
        >
          {leftTrimMm >= 60 ? `${leftTrimMm}` : ''}
        </div>
      )}
      {strips.map((w, idx) => {
        const isHit = !dimAll && hasHighlight && Math.round(w) === Math.round(highlightedWidthMm);
        const isDimmed = dimAll || (hasHighlight && !isHit);
        const tone = stripToneByWidth(w, localMin, localMax);
        return (
          <div
            key={idx}
            className={`slit-seg slit-strip${isHit ? ' is-hit' : ''}${isDimmed ? ' is-dim' : ''}`}
            style={{
              width: `${(w / motherWidthMm) * 100}%`,
              ...(isHit ? {} : { backgroundColor: tone.bg, color: tone.fg })
            }}
            title={`幅宽 ${w} mm`}
            onMouseEnter={onHoverWidth ? () => onHoverWidth(w) : undefined}
          >
            <span>{w}</span>
          </div>
        );
      })}
      {spare > 0 && (
        <div
          className="slit-seg slit-spare"
          style={{ width: `${(spare / motherWidthMm) * 100}%` }}
          title={`余宽 ${spare}mm`}
        >
          {spare >= 80 ? `余 ${spare}` : ''}
        </div>
      )}
      {rightTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(rightTrimMm / motherWidthMm) * 100}%` }}
          title={`右切边 ${rightTrimMm}mm`}
        >
          {rightTrimMm >= 60 ? `${rightTrimMm}` : ''}
        </div>
      )}
    </div>
  );
}
