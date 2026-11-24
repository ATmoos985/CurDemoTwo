import type {
  BoardCutLine,
  BoardDemandSpec,
  BoardPoint,
  BoardShapeGeometry
} from './canvasTypes';

export interface PieceVisualStyle {
  fill: string;
  stroke: string;
  text: string;
}

export const PIECE_PALETTE: PieceVisualStyle[] = [
  { fill: '#eef2ff', stroke: '#5b61f6', text: '#312e81' },
  { fill: '#ecfdf5', stroke: '#10b981', text: '#065f46' },
  { fill: '#eff6ff', stroke: '#3b82f6', text: '#1e3a8a' },
  { fill: '#f5f3ff', stroke: '#8b5cf6', text: '#4c1d95' },
  { fill: '#f0fdfa', stroke: '#14b8a6', text: '#115e59' },
  { fill: '#fff7ed', stroke: '#f97316', text: '#7c2d12' },
  { fill: '#fdf2f8', stroke: '#ec4899', text: '#831843' },
  { fill: '#f0f9ff', stroke: '#0ea5e9', text: '#0c4a6e' }
];

export const GAP_FILL_STYLE: PieceVisualStyle = {
  fill: '#d1fae5',
  stroke: '#059669',
  text: '#065f46'
};

export function styleForDemand(
  demandId: number | undefined,
  fallbackIdx: number,
  gapFill?: boolean
): PieceVisualStyle {
  if (gapFill) return GAP_FILL_STYLE;
  const seed = Math.abs(Number.isFinite(demandId) ? Number(demandId) : fallbackIdx);
  return PIECE_PALETTE[seed % PIECE_PALETTE.length];
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export interface StagingRenderItem {
  instanceKey: string;
  demandKey: string;
  demandId: number;
  name: string;
  width: number;
  height: number;
  shape?: BoardShapeGeometry;
  x: number;
  y: number;
  stackExtra: number;
  style: PieceVisualStyle;
}

export interface StagingLayoutResult {
  items: StagingRenderItem[];
  totalCount: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export function computeStagingLayout(
  demands: BoardDemandSpec[],
  rollWidthMm: number,
  rollLengthMm: number
): StagingLayoutResult {
  const gapFromRoll = Math.max(
    260,
    Math.round(rollWidthMm * 0.24),
    Math.round(rollLengthMm * 0.038)
  );
  const itemGap = Math.max(44, Math.min(96, Math.round(rollWidthMm * 0.04)));
  const pad = Math.max(64, Math.min(120, Math.round(rollWidthMm * 0.055)));
  const colMaxH = Math.max(rollLengthMm, 1600);

  const rawItems: Omit<StagingRenderItem, 'x' | 'y'>[] = [];
  let totalCount = 0;

  demands.forEach((d, idx) => {
    const qty = Math.max(0, Math.floor(d.remainingQty || 0));
    if (qty <= 0 || d.width <= 0 || d.length <= 0) return;
    totalCount += qty;
    const renderN = qty <= 12 ? qty : 6;
    const extra = qty > 12 ? qty - 6 : 0;
    const style = styleForDemand(d.demandId, idx, false);
    for (let i = 0; i < renderN; i++) {
      rawItems.push({
        instanceKey: `${d.key}#${i}`,
        demandKey: d.key,
        demandId: d.demandId,
        name: d.name,
        width: d.width,
        height: d.length,
        shape: d.shape,
        stackExtra: i === renderN - 1 ? extra : 0,
        style
      });
    }
  });

  if (rawItems.length === 0) {
    const boxW = Math.max(420, Math.min(680, Math.round(rollWidthMm * 0.42)));
    const boxH = Math.max(520, Math.min(rollLengthMm, 1200));
    return {
      items: [],
      totalCount: 0,
      bounds: {
        x: -gapFromRoll - boxW,
        y: 0,
        width: boxW,
        height: boxH
      }
    };
  }

  interface ColBucket {
    items: (Omit<StagingRenderItem, 'x' | 'y'> & { relY: number })[];
    colWidth: number;
    colHeight: number;
  }
  const columns: ColBucket[] = [];
  let curCol: ColBucket = { items: [], colWidth: 0, colHeight: 0 };

  for (const item of rawItems) {
    const nextY = curCol.items.length === 0 ? 0 : curCol.colHeight + itemGap;
    if (curCol.items.length > 0 && nextY + item.height > colMaxH) {
      columns.push(curCol);
      curCol = { items: [], colWidth: 0, colHeight: 0 };
    }
    const relY = curCol.items.length === 0 ? 0 : curCol.colHeight + itemGap;
    curCol.items.push({ ...item, relY });
    curCol.colWidth = Math.max(curCol.colWidth, item.width);
    curCol.colHeight = relY + item.height;
  }
  if (curCol.items.length > 0) columns.push(curCol);

  const positioned: StagingRenderItem[] = [];
  let cursorRightX = -gapFromRoll - pad;
  let maxColH = 0;

  for (const col of columns) {
    const colLeftX = cursorRightX - col.colWidth;
    for (const it of col.items) {
      positioned.push({
        ...it,
        x: colLeftX + (col.colWidth - it.width) / 2,
        y: pad + it.relY
      });
    }
    maxColH = Math.max(maxColH, col.colHeight);
    cursorRightX = colLeftX - itemGap;
  }

  const contentLeftX = cursorRightX + itemGap;
  const boxX = contentLeftX - pad;
  const boxRightX = -gapFromRoll;
  const boxW = Math.max(320, boxRightX - boxX);
  const boxH = Math.max(460, maxColH + pad * 2);

  return {
    items: positioned,
    totalCount,
    bounds: { x: boxX, y: 0, width: boxW, height: boxH }
  };
}

export interface CameraState {
  x: number;
  y: number;
  scale: number;
  fitScale: number;
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 计算当前屏幕视口对应的世界坐标系矩形（含像素缓冲区 marginPx）。 */
export function computeViewportWorldRect(
  cam: Pick<CameraState, 'x' | 'y' | 'scale'>,
  viewportWidth: number,
  viewportHeight: number,
  marginPx = 48
): WorldRect {
  const s = Math.max(0.002, cam.scale);
  const pad = marginPx / s;
  return {
    minX: -cam.x / s - pad,
    minY: -cam.y / s - pad,
    maxX: (viewportWidth - cam.x) / s + pad,
    maxY: (viewportHeight - cam.y) / s + pad
  };
}

/** 将母卷局部矩形映射到世界坐标系矩形（适配纵向走布与横向台板 -90° 旋转）。 */
export function rollLocalBoxToWorldRect(
  localX: number,
  localY: number,
  width: number,
  height: number,
  rollOffset: BoardPoint,
  vertical: boolean
): WorldRect {
  if (vertical) {
    return {
      minX: rollOffset.x + localX,
      minY: rollOffset.y + localY,
      maxX: rollOffset.x + localX + width,
      maxY: rollOffset.y + localY + height
    };
  }
  // rollGroup rotation = -90°: worldX = ro.x + localY, worldY = ro.y - localX
  return {
    minX: rollOffset.x + localY,
    minY: rollOffset.y - (localX + width),
    maxX: rollOffset.x + localY + height,
    maxY: rollOffset.y - localX
  };
}

/** 判断两个世界矩形是否相交（用于视口裁剪 Viewport Culling）。 */
export function isWorldBoxVisible(box: WorldRect, viewportWorld: WorldRect): boolean {
  return (
    box.maxX >= viewportWorld.minX &&
    box.minX <= viewportWorld.maxX &&
    box.maxY >= viewportWorld.minY &&
    box.minY <= viewportWorld.maxY
  );
}

/** 计算右键上下文菜单屏幕定位，自动防视口右/底边界溢出。 */
export function computeContextMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8
): { left: number; top: number } {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    left: Math.max(margin, Math.min(clientX, maxLeft)),
    top: Math.max(margin, Math.min(clientY, maxTop))
  };
}

export interface ToolpathSegment {
  step: number;
  kind: string;
  cutStart: BoardPoint;
  cutEnd: BoardPoint;
  rapidStart: BoardPoint;
  rapidEnd: BoardPoint;
  cutDistMm: number;
  rapidDistMm: number;
}

export function resolveCornerHomeLocal(
  startCorner: 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom' | undefined,
  rollWidthMm: number,
  rollLengthMm: number
): BoardPoint {
  const origin = startCorner || 'left-top';
  return {
    x: origin.startsWith('right') ? rollWidthMm : 0,
    y: origin.endsWith('bottom') ? rollLengthMm : 0
  };
}

/** 根据刀路列表与起刀零点，派生每一刀的空程（G00）与切割（G01）轨迹及距离统计。 */
export function computeToolpathSegments(
  cuts: BoardCutLine[],
  startCorner: 'left-top' | 'right-bottom' | 'right-top' | 'left-bottom' | undefined,
  rollWidthMm: number,
  rollLengthMm: number
): { segments: ToolpathSegment[]; totalCutMm: number; totalRapidMm: number } {
  const home = resolveCornerHomeLocal(startCorner, rollWidthMm, rollLengthMm);
  let lastX = home.x;
  let lastY = home.y;
  let totalCutMm = 0;
  let totalRapidMm = 0;
  const segments: ToolpathSegment[] = [];

  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    const rapidDist = Math.hypot(c.startX - lastX, c.startY - lastY);
    const cutDist = Math.hypot(c.endX - c.startX, c.endY - c.startY);
    totalRapidMm += rapidDist;
    totalCutMm += cutDist;
    segments.push({
      step: c.sequence ?? i + 1,
      kind: c.kind || 'CONTOUR',
      rapidStart: { x: lastX, y: lastY },
      rapidEnd: { x: c.startX, y: c.startY },
      cutStart: { x: c.startX, y: c.startY },
      cutEnd: { x: c.endX, y: c.endY },
      cutDistMm: round1(cutDist),
      rapidDistMm: round1(rapidDist)
    });
    lastX = c.endX;
    lastY = c.endY;
  }

  return {
    segments,
    totalCutMm: round1(totalCutMm),
    totalRapidMm: round1(totalRapidMm)
  };
}

/** 双指捏合缩放与中点平移相机计算（纯函数，便于单测）。 */
export function computeTouchPinchTransform(
  p1: BoardPoint,
  p2: BoardPoint,
  prevDist: number,
  prevCenter: BoardPoint,
  cam: CameraState
): { nextCam: CameraState; dist: number; center: BoardPoint } {
  const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
  if (prevDist <= 1) {
    return { nextCam: cam, dist, center };
  }
  const factor = Math.max(0.5, Math.min(2.0, dist / prevDist));
  const nextScale = Math.max(0.002, Math.min(5.0, cam.scale * factor));
  const worldX = (prevCenter.x - cam.x) / cam.scale;
  const worldY = (prevCenter.y - cam.y) / cam.scale;
  return {
    dist,
    center,
    nextCam: {
      ...cam,
      scale: nextScale,
      x: center.x - worldX * nextScale,
      y: center.y - worldY * nextScale
    }
  };
}

/** 将屏幕方向键移动量映射为母卷局部坐标微调量（兼容纵向走布与横向台板视角）。 */
export function mapArrowKeyToRollDelta(
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  stepMm: number,
  vertical: boolean
): { dx: number; dy: number } {
  if (vertical) {
    if (key === 'ArrowLeft') return { dx: -stepMm, dy: 0 };
    if (key === 'ArrowRight') return { dx: stepMm, dy: 0 };
    if (key === 'ArrowUp') return { dx: 0, dy: -stepMm };
    return { dx: 0, dy: stepMm };
  }
  // 横向台板 (-90°)：屏幕右 = +Y，屏幕左 = -Y，屏幕上 = +X，屏幕下 = -X
  if (key === 'ArrowRight') return { dx: 0, dy: stepMm };
  if (key === 'ArrowLeft') return { dx: 0, dy: -stepMm };
  if (key === 'ArrowUp') return { dx: stepMm, dy: 0 };
  return { dx: -stepMm, dy: 0 };
}

export function createHatchTile(
  background: string | null,
  stroke: string,
  size = 10
): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext('2d');
  if (ctx) {
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size, size);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-1, 1);
    ctx.lineTo(1, -1);
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.moveTo(size - 1, size + 1);
    ctx.lineTo(size + 1, size - 1);
    ctx.stroke();
  }
  return tile;
}
