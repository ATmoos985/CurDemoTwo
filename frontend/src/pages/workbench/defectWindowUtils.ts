import type { BoardDefect } from '../../components/WorkbenchBoardCanvas';

/** 原始母卷或料头档案中的疵点记录（兼容后端 Defect 与前端表单形态）。 */
export interface RawRollDefect {
  id?: string | number;
  x?: number | null;
  y?: number | null;
  w?: number | null;
  h?: number | null;
  margin?: number | null;
  typeName?: string | null;
  defectType?: string | null;
  label?: string | null;
}

/** 投影到工位局部坐标、已完成扩边裁切并可供求解器直接使用的疵点禁区。 */
export interface SolverWindowDefect {
  id: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin: 0;
}

/** 消除二进制浮点尾数误差（如 0.30000000000000004 或 -0），保留 0.1mm 级及更高合法精度。 */
function cleanCoord(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveDefectMargin(rawMargin: unknown, defaultMarginMm: number): number {
  const fallback = Number.isFinite(defaultMarginMm) ? Math.max(0, defaultMarginMm) : 0;
  if (rawMargin === null || rawMargin === undefined || rawMargin === '') {
    return fallback;
  }
  const parsed = Number(rawMargin);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

interface ClippedWindowDefect {
  id: string | number;
  rawX: number;
  rawY: number;
  rawW: number;
  rawH: number;
  margin: number;
  clipX: number;
  clipLocalY: number;
  clipW: number;
  clipH: number;
  fullyInsideWindow: boolean;
  bodyOutsideWindow: boolean;
  baseLabel: string;
}

/**
 * 统一实卷/料头避疵裁窗核心计算：
 * 严格 1:1 复刻服务端 CuttingWorkflowService.windowDefects 语义——
 * 先按 margin（缺省回退 defaultMarginMm）向四周外扩禁区，再裁切到 [0, rollWidthMm] × [startY, startY + windowLengthMm]，
 * 最终换算到工位局部坐标系。
 */
function clipDefectsToWindow(
  defects: readonly RawRollDefect[] | null | undefined,
  startY: number,
  windowLengthMm: number,
  rollWidthMm: number,
  defaultMarginMm = 20
): ClippedWindowDefect[] {
  if (!Array.isArray(defects) || defects.length === 0) return [];
  const safeStartY = Number.isFinite(startY) ? startY : 0;
  const safeLen = Number.isFinite(windowLengthMm) ? windowLengthMm : 0;
  const safeWidth = Number.isFinite(rollWidthMm) ? rollWidthMm : 0;
  if (safeLen <= 0 || safeWidth <= 0) return [];

  const endY = safeStartY + safeLen;
  const projected: ClippedWindowDefect[] = [];

  for (let idx = 0; idx < defects.length; idx++) {
    const d = defects[idx];
    if (!d) continue;
    const dx = Number(d.x) || 0;
    const dy = Number(d.y) || 0;
    const dw = Number(d.w) || 0;
    const dh = Number(d.h) || 0;
    if (dw <= 0 || dh <= 0) continue;

    const m = resolveDefectMargin(d.margin, defaultMarginMm);
    const ex0 = dx - m;
    const ey0 = dy - m;
    const ex1 = dx + dw + m;
    const ey1 = dy + dh + m;

    const x0 = Math.max(0, ex0);
    const y0 = Math.max(safeStartY, ey0);
    const x1 = Math.min(safeWidth, ex1);
    const y1 = Math.min(endY, ey1);

    const clipW = cleanCoord(x1 - x0);
    const clipH = cleanCoord(y1 - y0);
    if (clipW <= 0 || clipH <= 0) continue;

    const fullyInsideWindow =
      ex0 >= 0 && ex1 <= safeWidth && ey0 >= safeStartY && ey1 <= endY;
    const bodyOutsideWindow =
      dx + dw <= 0 || dx >= safeWidth || dy + dh <= safeStartY || dy >= endY;

    projected.push({
      id: d.id ?? idx + 1,
      rawX: dx,
      rawY: dy,
      rawW: dw,
      rawH: dh,
      margin: m,
      clipX: cleanCoord(x0),
      clipLocalY: cleanCoord(y0 - safeStartY),
      clipW,
      clipH,
      fullyInsideWindow,
      bodyOutsideWindow,
      baseLabel: String(d.label || d.typeName || d.defectType || '疵点')
    });
  }

  return projected;
}

/**
 * 为二维求解器生成当前工位窗口内的避疵禁区列表：
 * 严格对齐 CuttingWorkflowService.windowDefects，先按安全边距外扩再裁切至工位局部坐标，输出 margin = 0，
 * 防止工位起止线外沿疵点的安全边距禁区丢失，同时避免下游 buildSafeNestingRequest2D 二次外扩。
 */
export function projectWindowDefectsForSolver(
  defects: readonly RawRollDefect[] | null | undefined,
  startY: number,
  windowLengthMm: number,
  rollWidthMm: number,
  defaultMarginMm = 20
): SolverWindowDefect[] {
  return clipDefectsToWindow(defects, startY, windowLengthMm, rollWidthMm, defaultMarginMm).map(
    (item) => ({
      id: item.id,
      x: item.clipX,
      y: item.clipLocalY,
      w: item.clipW,
      h: item.clipH,
      margin: 0
    })
  );
}

/**
 * 为前端工作台画布与手调碰撞校验生成当前工位窗口内的疵点展示数据：
 * - 筛选条件与求解器 100% 相同（按外扩安全边距后是否与窗口有正面积交集判断）；
 * - 完整落在窗口内的疵点保留本体矩形与安全边距（虚线外框与求解器禁区 100% 重合）；
 * - 跨工位边界或本体在窗外仅边距伸入窗口的疵点，直接投影为裁切后的精确禁区且 margin = 0，
 *   确保画布红框、手调防碰撞校验、validate-layout 载荷与求解器/服务端 100% 一致。
 */
export function projectWindowDefectsForBoard(
  defects: readonly RawRollDefect[] | null | undefined,
  startY: number,
  windowLengthMm: number,
  rollWidthMm: number,
  defaultMarginMm = 20
): BoardDefect[] {
  return clipDefectsToWindow(defects, startY, windowLengthMm, rollWidthMm, defaultMarginMm).map(
    (item) => {
      if (item.fullyInsideWindow) {
        return {
          id: item.id,
          x: cleanCoord(item.rawX),
          y: cleanCoord(item.rawY - startY),
          w: cleanCoord(item.rawW),
          h: cleanCoord(item.rawH),
          margin: cleanCoord(item.margin),
          label: item.baseLabel
        };
      }
      return {
        id: item.id,
        x: item.clipX,
        y: item.clipLocalY,
        w: item.clipW,
        h: item.clipH,
        margin: 0,
        label: item.bodyOutsideWindow
          ? `${item.baseLabel} · 边界禁区`
          : `${item.baseLabel} · 含边界禁区`
      };
    }
  );
}
