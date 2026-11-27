import React from 'react';
import { loadSheetLib } from '../../lib/core/util.js';
import { demandTemplateCsv } from '../../lib/domain/demand-import-model.js';
import { csvCell } from '../../lib/domain/report-model.js';
import { SegmentedOption } from '../../components/ui/MagpiePrimitives';
import type { Scenario1DType, Scenario2DType } from '../../store/studioTypes';

export type DimensionKey = 'RECT_2D' | 'CONTOUR_2D' | 'SLITTING_1D';
export type DirectionMode = 'FIXED' | 'ROTATE_90' | 'HALF_180';

export interface DraftLine {
  name: string;
  width: number;
  length: number;
  quantity: number;
  allowRotation: boolean;
  allowHalfTurn?: boolean;
  sizeLabel?: string;
  sourceTemplateId?: string;
  surfaceTreatment?: string;
  shape?: any;
}

export interface ParsedFileContext {
  fileName: string;
  groups: any[];
  groupIndex: number;
}

export const CREATE_DIM_OPTIONS: SegmentedOption<DimensionKey>[] = [
  { value: 'RECT_2D', label: '二维矩形' },
  { value: 'CONTOUR_2D', label: '二维异形' },
  { value: 'SLITTING_1D', label: '一维分条' }
];

export const QUICK_WIDTHS_2D = [1220, 1500, 1650, 1800, 2000];

export const GOALS_2D: { id: Scenario2DType; title: string; sub: string }[] = [
  { id: 'SHORTEN_KIT', title: '齐套最短版长', sub: '全数排入并压紧用料长度' },
  { id: 'SHORTEN_GAP_FILL', title: '齐套 + 空隙补片', sub: '齐套后在空隙自动填补备片' },
  { id: 'FIXED_BED', title: '定长台板装入', sub: '按设定版长装入最大面积' },
  { id: 'MULTI_WIDTH', title: '多门幅阶梯比选', sub: '虚拟卷横向对比多门幅单耗' }
];

export const GOALS_1D: { id: Scenario1DType; title: string; sub: string }[] = [
  { id: 'MIN_CARS', title: '最少出车换刀', sub: '严格控超产，减少换刀次数' },
  { id: 'MAX_UTIL', title: '最高母卷利用率', sub: '适度放宽备库超产压废边' }
];

export const DEMAND_MAPPING_FIELDS: Array<{ field: string; label: string }> = [
  { field: 'materialModel', label: '材料型号' },
  { field: 'name', label: '裁片名称' },
  { field: 'width', label: '宽度/条宽' },
  { field: 'length', label: '长度/定长' },
  { field: 'quantity', label: '数量' },
  { field: 'productType', label: '产品类型(2D/1D)' },
  { field: 'surfaceTreatment', label: '表面处理' },
  { field: 'allowRotation', label: '允许旋转' },
  { field: 'order', label: '订单编号' },
  { field: 'bomParent', label: 'BOM父件' },
  { field: 'bomChild', label: 'BOM子件' },
  { field: 'bomUsage', label: 'BOM单耗' }
];

export const createDefaultDraftLines = (): DraftLine[] => [
  {
    name: '主规格 #1',
    width: 800,
    length: 1200,
    quantity: 10,
    allowRotation: false,
    allowHalfTurn: false
  },
  {
    name: '配片 #2',
    width: 450,
    length: 600,
    quantity: 10,
    allowRotation: true,
    allowHalfTurn: false
  }
];

export function getDirectionMode(ln: DraftLine): DirectionMode {
  if (ln.allowRotation) return 'ROTATE_90';
  if (ln.allowHalfTurn) return 'HALF_180';
  return 'FIXED';
}

export function applyDirectionMode(ln: DraftLine, mode: DirectionMode): DraftLine {
  if (mode === 'ROTATE_90') return { ...ln, allowRotation: true, allowHalfTurn: false };
  if (mode === 'HALF_180') return { ...ln, allowRotation: false, allowHalfTurn: true };
  return { ...ln, allowRotation: false, allowHalfTurn: false };
}

export function estimatePolygonArea(vertices: any[]): number {
  if (!Array.isArray(vertices) || vertices.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const ax = Number(a?.x ?? a?.[0] ?? 0);
    const ay = Number(a?.y ?? a?.[1] ?? 0);
    const bx = Number(b?.x ?? b?.[0] ?? 0);
    const by = Number(b?.y ?? b?.[1] ?? 0);
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) * 0.5;
}

export function buildImportIssuesCsvText(issues: any[]): string {
  const header = ['工作表', '行号(1-based)', '列名', '字段', '错误码', '原因说明']
    .map((c) => csvCell(c))
    .join(',');
  const lines = (issues || []).map((it) =>
    [
      csvCell(it?.sheetName || ''),
      csvCell(it?.rowIndex ?? it?.row ?? ''),
      csvCell(it?.column || ''),
      csvCell(it?.field || ''),
      csvCell(it?.code || ''),
      csvCell(it?.reason || it?.message || '')
    ].join(',')
  );
  return `\ufeff${[header, ...lines].join('\r\n')}\r\n`;
}

export function triggerCsvFileDownload(fileName: string, csvText: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (typeof window !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

export async function downloadDemandTemplate(kind: 'csv' | 'xlsx' | 'bom_xlsx'): Promise<void> {
  if (kind === 'csv') {
    const csv = demandTemplateCsv();
    triggerCsvFileDownload('CutPlan-需求导入模板.csv', csv.startsWith('\ufeff') ? csv : `\ufeff${csv}`);
    return;
  }
  const XLSX = await loadSheetLib();
  const wb = XLSX.utils.book_new();
  if (kind === 'xlsx') {
    const ws2d = XLSX.utils.aoa_to_sheet([
      ['材料型号', '产品类型', '裁片名称', '宽度(mm)', '长度(mm)', '数量', '表面处理', '允许旋转', '订单编号'],
      ['TC涤棉-B2026', '2D', '客厅主帘', 2170, 3250, 2, '', '否', 'SO-0001'],
      ['反射膜_T29', '1D', '光膜分条A', 1200, 1350000, 6, '不涂布', '否', 'SO-0002']
    ]);
    XLSX.utils.book_append_sheet(wb, ws2d, '标准需求表(2D_1D混排)');
    XLSX.writeFile(wb, 'CutPlan-标准需求导入模板.xlsx');
    return;
  }
  const wsBom = XLSX.utils.aoa_to_sheet([
    ['父件编码', '子件编码', '单耗', '材料型号', '产品类型', '裁片名称', '宽度(mm)', '长度(mm)', '表面处理', '允许旋转'],
    ['SUITE-A', 'PANEL-TOP', 2, '板材-1220', '2D', '顶板', 600, 1200, '哑光白', '是'],
    ['SUITE-A', 'STRIP-EDGE', 4, '铝条-200', '1D', '封边条', 50, 2400, '阳极氧化', '否']
  ]);
  XLSX.utils.book_append_sheet(wb, wsBom, 'BOM层级展开模板');
  XLSX.writeFile(wb, 'CutPlan-BOM需求展开模板.xlsx');
}

export const PieceSilhouetteSvg: React.FC<{ line: DraftLine; is1D: boolean; oversize: boolean }> = ({
  line,
  is1D,
  oversize
}) => {
  const stroke = oversize ? '#e11d48' : '#5b61f6';
  const fill = oversize ? 'rgba(225, 29, 72, 0.12)' : 'rgba(91, 97, 246, 0.12)';
  const verts = line.shape?.type === 'POLYGON' ? line.shape?.vertices : null;

  if (!is1D && Array.isArray(verts) && verts.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const pts = verts.map((p: any) => {
      const x = Number(p?.x ?? p?.[0] ?? 0);
      const y = Number(p?.y ?? p?.[1] ?? 0);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return [x, y];
    });
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const scale = Math.min(82 / bw, 42 / bh);
    const ox = (92 - bw * scale) / 2;
    const oy = (46 - bh * scale) / 2;
    const toPath = (ring: any[]) =>
      ring
        .map((p: any, idx: number) => {
          const x = ox + (Number(p?.x ?? p?.[0] ?? 0) - minX) * scale;
          const y = oy + (Number(p?.y ?? p?.[1] ?? 0) - minY) * scale;
          return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ') + ' Z';
    const dParts = [toPath(pts)];
    if (Array.isArray(line.shape?.holes)) {
      for (const h of line.shape.holes) {
        if (Array.isArray(h) && h.length >= 3) dParts.push(toPath(h));
      }
    }
    return (
      <svg viewBox="0 0 92 46" width="92" height="46" aria-hidden="true">
        <path
          d={dParts.join(' ')}
          fill={fill}
          fillRule="evenodd"
          stroke={stroke}
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const w = Math.max(1, Number(line.width) || 100);
  const h = is1D ? Math.max(1, Math.min(w * 2.2, 1600)) : Math.max(1, Number(line.length) || 100);
  const scale = Math.min(80 / w, 40 / h);
  const rw = Math.max(12, w * scale);
  const rh = Math.max(10, h * scale);
  const rx = (92 - rw) / 2;
  const ry = (46 - rh) / 2;

  return (
    <svg viewBox="0 0 92 46" width="92" height="46" aria-hidden="true">
      <rect x={rx} y={ry} width={rw} height={rh} rx="2" fill={fill} stroke={stroke} strokeWidth="1.4" />
      {is1D && (
        <path
          d={`M ${rx + rw * 0.25} ${ry} V ${ry + rh} M ${rx + rw * 0.75} ${ry} V ${ry + rh}`}
          stroke={stroke}
          strokeOpacity="0.45"
          strokeDasharray="2 2"
          strokeWidth="1"
        />
      )}
    </svg>
  );
};
