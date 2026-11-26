import type { BoardPoint } from './canvasTypes';
import type { CameraState } from './canvasGeometry';

export const RULER_THICKNESS = 24;

export interface RulerStepSpec {
  majorStep: number;
  minorStep: number;
}

/** 屏幕固定 CAD 标尺步长选择：支持 1mm / 5mm / 10mm 细粒度刻度直至长卷 10000mm 刻度。 */
export function pickRulerStep(scalePxPerMm: number, minMajorGapPx = 68): RulerStepSpec {
  const raw = minMajorGapPx / Math.max(0.002, scalePxPerMm);
  const steps: Array<[number, number]> = [
    [1, 1],
    [2, 1],
    [5, 1],
    [10, 2],
    [20, 5],
    [25, 5],
    [50, 10],
    [100, 20],
    [200, 50],
    [250, 50],
    [500, 100],
    [1000, 200],
    [2000, 500],
    [5000, 1000],
    [10000, 2000]
  ];
  for (const [majorStep, minorStep] of steps) {
    if (majorStep >= raw) {
      return { majorStep, minorStep };
    }
  }
  const majorStep = Math.ceil(raw / 10000) * 10000;
  return { majorStep, minorStep: majorStep / 5 };
}

export interface DrawScreenRulersParams {
  width: number;
  height: number;
  cam: Pick<CameraState, 'x' | 'y' | 'scale'>;
  rollOffset: BoardPoint;
  rollWidthMm: number;
  rollLengthMm: number;
  vertical: boolean;
  cursorLocal: BoardPoint | null;
  dark: boolean;
  dpr?: number;
}

function formatTickValue(valMm: number): string {
  const rounded = Math.round(valMm);
  if (Math.abs(rounded) >= 10000 && rounded % 1000 === 0) {
    return `${rounded / 1000}m`;
  }
  return String(rounded);
}

/**
 * 绘制屏幕贴边固定 CAD 标尺（顶部水平条 + 左侧垂直条 + 左上角 mm 原点块）。
 * 纵向走布：顶尺对应幅宽 X（mm），左尺对应卷长 Y（mm）；
 * 横向台板：顶尺对应卷长 Y（mm），左尺对应幅宽 X（mm）。
 */
export function drawScreenRulers(
  ctx: CanvasRenderingContext2D,
  params: DrawScreenRulersParams
): void {
  const { width, height, cam, rollOffset, rollWidthMm, rollLengthMm, vertical, cursorLocal, dark } =
    params;
  if (width <= RULER_THICKNESS || height <= RULER_THICKNESS) return;

  const s = Math.max(0.002, cam.scale);
  const { majorStep: stepTop, minorStep: minorTop } = pickRulerStep(s, 72);
  const { majorStep: stepLeft, minorStep: minorLeft } = pickRulerStep(s, 68);

  const bg = dark ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.94)';
  const cornerBg = dark ? '#1e293b' : '#f4f5f8';
  const border = dark ? 'rgba(148, 163, 184, 0.24)' : 'rgba(15, 23, 42, 0.12)';
  const tickMajor = dark ? '#94a3b8' : '#64748b';
  const tickMinor = dark ? 'rgba(148, 163, 184, 0.4)' : 'rgba(100, 116, 139, 0.35)';
  const textFill = dark ? '#cbd5e1' : '#475569';
  const rangeTint = dark ? 'rgba(56, 189, 248, 0.12)' : 'rgba(91, 97, 246, 0.08)';
  const cursorColor = dark ? '#38bdf8' : '#5b61f6';

  ctx.clearRect(0, 0, width, height);

  // Top & Left ruler strips
  ctx.fillStyle = bg;
  ctx.fillRect(RULER_THICKNESS, 0, width - RULER_THICKNESS, RULER_THICKNESS);
  ctx.fillRect(0, RULER_THICKNESS, RULER_THICKNESS, height - RULER_THICKNESS);

  // Active roll span highlight inside rulers
  const topOriginPx = cam.x + rollOffset.x * s;
  const topMaxMm = vertical ? rollWidthMm : rollLengthMm;
  const topStartPx = Math.max(RULER_THICKNESS, topOriginPx);
  const topEndPx = Math.min(width, topOriginPx + topMaxMm * s);
  if (topEndPx > topStartPx) {
    ctx.fillStyle = rangeTint;
    ctx.fillRect(topStartPx, 0, topEndPx - topStartPx, RULER_THICKNESS);
  }

  let leftStartPx: number;
  let leftEndPx: number;
  if (vertical) {
    const leftOriginPx = cam.y + rollOffset.y * s;
    leftStartPx = Math.max(RULER_THICKNESS, leftOriginPx);
    leftEndPx = Math.min(height, leftOriginPx + rollLengthMm * s);
  } else {
    // Horizontal: localX = 0 at worldY = rollOffset.y; localX = rollWidthMm at worldY = rollOffset.y - rollWidthMm
    const yBottomPx = cam.y + rollOffset.y * s;
    const yTopPx = cam.y + (rollOffset.y - rollWidthMm) * s;
    leftStartPx = Math.max(RULER_THICKNESS, yTopPx);
    leftEndPx = Math.min(height, yBottomPx);
  }
  if (leftEndPx > leftStartPx) {
    ctx.fillStyle = rangeTint;
    ctx.fillRect(0, leftStartPx, RULER_THICKNESS, leftEndPx - leftStartPx);
  }

  // Border lines
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, RULER_THICKNESS - 0.5);
  ctx.lineTo(width, RULER_THICKNESS - 0.5);
  ctx.moveTo(RULER_THICKNESS - 0.5, 0);
  ctx.lineTo(RULER_THICKNESS - 0.5, height);
  ctx.stroke();

  ctx.font = '500 9.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'top';

  // ---- TOP RULER TICKS ----
  const topMinMmVisible = (RULER_THICKNESS - topOriginPx) / s;
  const topMaxMmVisible = (width - topOriginPx) / s;
  const firstTopMinor = Math.floor(topMinMmVisible / minorTop) * minorTop;
  const maxTopTicks = 1200;
  let topCount = 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(RULER_THICKNESS, 0, width - RULER_THICKNESS, RULER_THICKNESS);
  ctx.clip();

  for (let mm = firstTopMinor; mm <= topMaxMmVisible && topCount < maxTopTicks; mm += minorTop) {
    topCount++;
    const px = Math.round(topOriginPx + mm * s) + 0.5;
    if (px < RULER_THICKNESS || px > width) continue;
    const isMajor = Math.abs(mm % stepTop) < 1e-6 || Math.abs(Math.abs(mm % stepTop) - stepTop) < 1e-6;
    ctx.strokeStyle = isMajor ? tickMajor : tickMinor;
    ctx.beginPath();
    ctx.moveTo(px, isMajor ? RULER_THICKNESS - 10 : RULER_THICKNESS - 5);
    ctx.lineTo(px, RULER_THICKNESS);
    ctx.stroke();

    if (isMajor) {
      ctx.fillStyle = textFill;
      ctx.textAlign = 'left';
      ctx.fillText(formatTickValue(mm), px + 3, 2);
    }
  }

  if (cursorLocal) {
    const cMm = vertical ? cursorLocal.x : cursorLocal.y;
    const cPx = Math.round(topOriginPx + cMm * s) + 0.5;
    if (cPx >= RULER_THICKNESS && cPx <= width) {
      ctx.strokeStyle = cursorColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cPx, 0);
      ctx.lineTo(cPx, RULER_THICKNESS);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---- LEFT RULER TICKS ----
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_THICKNESS, RULER_THICKNESS, height - RULER_THICKNESS);
  ctx.clip();

  let leftMinMmVisible: number;
  let leftMaxMmVisible: number;
  const leftMmToPx = (mm: number) =>
    vertical ? cam.y + (rollOffset.y + mm) * s : cam.y + (rollOffset.y - mm) * s;

  if (vertical) {
    leftMinMmVisible = (RULER_THICKNESS - cam.y) / s - rollOffset.y;
    leftMaxMmVisible = (height - cam.y) / s - rollOffset.y;
  } else {
    leftMinMmVisible = rollOffset.y - (height - cam.y) / s;
    leftMaxMmVisible = rollOffset.y - (RULER_THICKNESS - cam.y) / s;
  }

  const firstLeftMinor = Math.floor(leftMinMmVisible / minorLeft) * minorLeft;
  let leftCount = 0;
  for (let mm = firstLeftMinor; mm <= leftMaxMmVisible && leftCount < maxTopTicks; mm += minorLeft) {
    leftCount++;
    const py = Math.round(leftMmToPx(mm)) + 0.5;
    if (py < RULER_THICKNESS || py > height) continue;
    const isMajor =
      Math.abs(mm % stepLeft) < 1e-6 || Math.abs(Math.abs(mm % stepLeft) - stepLeft) < 1e-6;
    ctx.strokeStyle = isMajor ? tickMajor : tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(isMajor ? RULER_THICKNESS - 10 : RULER_THICKNESS - 5, py);
    ctx.lineTo(RULER_THICKNESS, py);
    ctx.stroke();

    if (isMajor) {
      ctx.save();
      ctx.translate(2, py + 3);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = textFill;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(formatTickValue(mm), 0, 0);
      ctx.restore();
    }
  }

  if (cursorLocal) {
    const cMm = vertical ? cursorLocal.y : cursorLocal.x;
    const cPy = Math.round(leftMmToPx(cMm)) + 0.5;
    if (cPy >= RULER_THICKNESS && cPy <= height) {
      ctx.strokeStyle = cursorColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, cPy);
      ctx.lineTo(RULER_THICKNESS, cPy);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---- TOP-LEFT CORNER BADGE ("mm") ----
  ctx.fillStyle = cornerBg;
  ctx.fillRect(0, 0, RULER_THICKNESS - 1, RULER_THICKNESS - 1);
  ctx.fillStyle = tickMajor;
  ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('mm', RULER_THICKNESS / 2, RULER_THICKNESS / 2);
}
