export interface TicketPlacementItem {
  id: number | string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  pieceLabel: string;
  dimLabel: string;
  showDimLabel: boolean;
  fontSize: number;
  pointsAttr?: string;
}

export interface TicketCutItem {
  sequence: number;
  kind: string;
  directionLabel: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  labelX: number;
  labelY: number;
}

export interface TicketDefectItem {
  id: string | number;
  x: number;
  y: number;
  w: number;
  h: number;
  margin: number;
}

export interface CutTicketModel {
  workOrderNo: string;
  widthMm: number;
  occupiedLengthMm: number;
  windowStartY: number;
  cutOrigin: string;
  originPoint: { x: number; y: number; label: string };
  viewBox: string;
  borderStroke: number;
  pieceStroke: number;
  cutStroke: number;
  headerY: number;
  headerFontSize: number;
  cutBadgeRadius: number;
  cutBadgeFontSize: number;
  placements: TicketPlacementItem[];
  cuts: TicketCutItem[];
  defects: TicketDefectItem[];
}

function originCorner(cutOrigin: string, widthMm: number, lengthMm: number) {
  const origin = String(cutOrigin || 'left-top');
  const isRight = origin.startsWith('right');
  const isBottom = origin.endsWith('bottom');
  return {
    x: isRight ? widthMm : 0,
    y: isBottom ? lengthMm : 0,
    label: `起点(${isRight ? '右' : '左'}${isBottom ? '下' : '上'})`
  };
}

/**
 * 构造 A4 车间派工裁切单的完整数据模型（零截断）：
 * - 完整保留全部裁片与全部刀序坐标，绝不做 25 / 16 截断；
 * - 按图幅比例计算自适应 SVG 线宽与标注字号，避免超大或超小门幅下图形变形或失真。
 */
export function buildCutTicketModel(
  scheme: any,
  options?: { cutOrigin?: string; boundRoll?: any }
): CutTicketModel {
  const widthMm = Math.max(100, Number(scheme?.widthMm) || 1600);
  const occupiedLengthMm = Math.max(100, Number(scheme?.occupiedLengthMm) || 1000);
  const windowStartY = Math.max(0, Number(scheme?.windowStartY) || 0);
  const cutOrigin = options?.cutOrigin || 'left-top';

  const maxDim = Math.max(widthMm, occupiedLengthMm, 100);
  const pad = Math.max(28, Math.round(maxDim * 0.04));
  const headerBand = Math.max(54, Math.round(maxDim * 0.055));
  const borderStroke = Math.max(2, Number((maxDim * 0.0024).toFixed(2)));
  const pieceStroke = Math.max(1.5, Number((maxDim * 0.0018).toFixed(2)));
  const cutStroke = Math.max(1.6, Number((maxDim * 0.002).toFixed(2)));
  const headerFontSize = Math.max(22, Math.round(maxDim * 0.024));
  const cutBadgeRadius = Math.max(14, Math.round(maxDim * 0.016));
  const cutBadgeFontSize = Math.max(13, Math.round(cutBadgeRadius * 1.15));

  const rawPlacements: any[] = Array.isArray(scheme?.layout2D?.placements)
    ? scheme.layout2D.placements
    : [];
  const placements: TicketPlacementItem[] = rawPlacements.map((p, idx) => {
    const w = Math.max(0, Number(p.shape?.width ?? p.w) || 0);
    const h = Math.max(0, Number(p.shape?.height ?? p.l) || 0);
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const vertices = Array.isArray(p.shape?.vertices) ? p.shape.vertices : null;
    const pointsAttr =
      vertices && vertices.length >= 3
        ? vertices.map((pt: any) => `${x + (Number(pt.x) || 0)},${y + (Number(pt.y) || 0)}`).join(' ')
        : undefined;
    const minSide = Math.max(1, Math.min(w, h));
    const fontSize = Math.max(
      14,
      Math.min(Math.round(maxDim * 0.026), Math.round(minSide * 0.24))
    );
    const showDimLabel = w >= fontSize * 3.8 && h >= fontSize * 2.5;
    const pieceId = p.id ?? idx + 1;
    return {
      id: pieceId,
      name: p.name || `裁片 #${pieceId}`,
      x,
      y,
      w,
      h,
      cx: x + w / 2,
      cy: y + h / 2,
      pieceLabel: `#${pieceId}`,
      dimLabel: `${Math.round(w)}×${Math.round(h)}`,
      showDimLabel,
      fontSize,
      pointsAttr
    };
  });

  const rawCuts: any[] = Array.isArray(scheme?.layout2D?.cuts) ? scheme.layout2D.cuts : [];
  const cuts: TicketCutItem[] = rawCuts.map((c, idx) => {
    const startX = Number(c.startX) || 0;
    const startY = Number(c.startY) || 0;
    const endX = Number(c.endX) || 0;
    const endY = Number(c.endY) || 0;
    const kind = String(c.kind || 'CONTOUR');
    return {
      sequence: Number(c.sequence) || idx + 1,
      kind,
      directionLabel: kind === 'HORIZONTAL' ? '横切' : kind === 'VERTICAL' ? '纵切' : '轮廓',
      startX,
      startY,
      endX,
      endY,
      labelX: (startX + endX) / 2,
      labelY: (startY + endY) / 2
    };
  });

  // 合并方案自带疵点或绑定实卷落在本次裁切窗口内的疵点
  const rawDefects: any[] = Array.isArray(scheme?.layout2D?.defects)
    ? scheme.layout2D.defects
    : Array.isArray(options?.boundRoll?.defects)
    ? options.boundRoll.defects
        .filter((d: any) => {
          const dy = Number(d.y) || 0;
          const dh = Number(d.h) || 0;
          return dy < windowStartY + occupiedLengthMm && dy + dh > windowStartY;
        })
        .map((d: any) => ({
          ...d,
          y: Math.max(0, (Number(d.y) || 0) - windowStartY)
        }))
    : [];

  const defects: TicketDefectItem[] = rawDefects.map((d, idx) => ({
    id: d.id ?? idx + 1,
    x: Number(d.x) || 0,
    y: Number(d.y) || 0,
    w: Math.max(0, Number(d.w) || 0),
    h: Math.max(0, Number(d.h) || 0),
    margin: Number(d.margin) || 0
  }));

  const workOrderNo = `WO-${scheme?.id || 'DRAFT'}`;
  const originPoint = originCorner(cutOrigin, widthMm, occupiedLengthMm);
  const viewBox = `${-pad} ${-(pad + headerBand)} ${widthMm + pad * 2} ${occupiedLengthMm + pad * 2 + headerBand}`;

  return {
    workOrderNo,
    widthMm,
    occupiedLengthMm,
    windowStartY,
    cutOrigin,
    originPoint,
    viewBox,
    borderStroke,
    pieceStroke,
    cutStroke,
    headerY: -Math.round(headerBand * 0.4),
    headerFontSize,
    cutBadgeRadius,
    cutBadgeFontSize,
    placements,
    cuts,
    defects
  };
}
