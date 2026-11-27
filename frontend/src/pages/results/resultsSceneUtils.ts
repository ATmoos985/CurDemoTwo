import { showcaseScene } from '../../lib/model/showcase.js';
import { rectangle } from '../../lib/canvas/nesting-scene.js';
import type { BatchZipFormat, ExportCamFormat } from '../../utils/exportApiClient';

export const STATE_BADGE: Record<string, { label: string; cls: string }> = {
  AWAITING_ROLL: { label: '待绑实卷 (虚拟母卷)', cls: 'warn' },
  READY_TO_CUT: { label: '已锁实卷待切', cls: 'run' },
  DISPATCHED_MES: { label: '已下发 MES', cls: 'kind' },
  COMPLETED: { label: '已完工记账', cls: 'ok' },
  CANCELLED: { label: '已作废释放', cls: '' },
  REVERSED: { label: '已冲销释放', cls: 'warn' }
};

export const CAM_FORMAT_OPTIONS: Array<{ value: ExportCamFormat; label: string }> = [
  { value: 'dxf_lwpolyline', label: 'DXF LWPOLYLINE (通用 CAD/振刀机)' },
  { value: 'dxf_r12', label: 'DXF R12 (兼容老旧设备/POLYLINE)' },
  { value: 'dxf_aama', label: 'AAMA/ASTM DXF (服装纸样标准)' },
  { value: 'plt', label: 'HPGL Plotter (.plt 振刀绘图机)' },
  { value: 'nc', label: 'CNC G-Code (.nc 数控裁床)' }
];

export const BATCH_ZIP_FORMAT_OPTIONS: Array<{ value: BatchZipFormat; label: string }> = [
  { value: 'dxf_lwpolyline', label: 'DXF (LWPOLYLINE)' },
  { value: 'dxf_r12', label: 'DXF (R12)' },
  { value: 'dxf_aama', label: 'AAMA DXF' },
  { value: 'plt', label: 'HPGL (.plt)' },
  { value: 'nc', label: 'CNC G-Code (.nc)' },
  { value: 'ticket_pdf', label: 'A4 随工单 PDF' },
  { value: 'slitting_json', label: '1D 分切配方 JSON' },
  { value: 'slitting_csv', label: '1D 分切配方 CSV' },
  { value: 'slitting_xlsx', label: '1D 分切配方 XLSX' }
];

export const MAX_BATCH_ZIP_SCHEMES = 50;

export function validateBatchZipSelection(
  schemeIds: string[],
  formats: BatchZipFormat[]
): { valid: boolean; reason?: string } {
  const unique = [...new Set(schemeIds.filter(Boolean))];
  if (unique.length === 0) {
    return { valid: false, reason: '请至少勾选 1 个排程方案' };
  }
  if (unique.length > MAX_BATCH_ZIP_SCHEMES) {
    return { valid: false, reason: `单次批量导出最多支持 ${MAX_BATCH_ZIP_SCHEMES} 个方案` };
  }
  if (!formats.length) {
    return { valid: false, reason: '请至少选择 1 种导出文件格式' };
  }
  return { valid: true };
}

export function sanitizeSchemeTitle(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/OR-?Tools\s*/gi, '')
    .replace(/Deepnest\s*(NFP\+GA\s*)?/gi, '异形')
    .replace(/PackingSolver\s*/gi, '')
    .replace(/NewSolver\s*/gi, '')
    .replace(/Java\s*天际线\/直刀/gi, '')
    .replace(/\s*\((FAST|QUALITY)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildReplayScene2D(scheme: any) {
  if (!scheme?.layout2D?.placements?.length) return null;
  try {
    const hasPoly = scheme.dimension === 'CONTOUR_2D';
    const matId = scheme.rollId || 'VIRTUAL-ROLL';
    const allPlacements = scheme.layout2D.placements || [];
    const leftovers = scheme.layout2D.leftovers || [];
    const cuts = scheme.layout2D.cuts || [];

    const maxPieceY = allPlacements.reduce(
      (m: number, p: any) =>
        m > (p.y || 0) + (p.shape?.height || p.l || 0)
          ? m
          : (p.y || 0) + (p.shape?.height || p.l || 0),
      0
    );
    const maxRemY = leftovers.reduce((m: number, r: any) => Math.max(m, (r.y || 0) + (r.l || 0)), 0);
    const maxCutY = cuts.reduce((m: number, c: any) => Math.max(m, c.startY || 0, c.endY || 0), 0);
    const matLen = Math.max(100, Number(scheme.occupiedLengthMm) || 0, maxPieceY, maxRemY, maxCutY);
    const matWidth = Math.max(100, Number(scheme.widthMm) || 1600);
    const matShape = rectangle(matWidth, matLen);

    const req = {
      schemaVersion: '2.0',
      problemType: 'NESTING_2D',
      problem: {
        schemaVersion: '1',
        unit: 'mm',
        material: { id: matId, shape: matShape, exclusions: [] },
        parts: [],
        process: {
          mode: hasPoly ? 'CONTOUR' : 'GUILLOTINE',
          startCorner: 'left-top',
          trimStart: scheme.trimStartMm || 0
        }
      }
    };
    const gapFillPlacements = allPlacements
      .filter((p: any) => p.gapFill)
      .map((p: any) => ({
        id: p.id,
        demandId: p.demandId,
        name: p.name,
        x: p.x,
        y: p.y,
        rotationDegrees: p.rotationDegrees || 0,
        shape: p.shape || rectangle(Math.max(1, p.w), Math.max(1, p.l))
      }));

    const res = {
      meetsRequirement: Boolean(scheme.complete),
      fulfillmentStatus: scheme.complete ? 'COMPLETE' : 'PARTIAL',
      layout: {
        schemaVersion: '1',
        unit: 'mm',
        coordinateSystem: 'source-local-top-left',
        status: 'FEASIBLE',
        materialId: matId,
        processingRegion: matShape,
        placements: allPlacements
          .filter((p: any) => !p.gapFill)
          .map((p: any) => ({
            id: p.id,
            demandId: p.demandId,
            name: p.name,
            x: p.x,
            y: p.y,
            rotationDegrees: p.rotationDegrees || 0,
            shape: p.shape || rectangle(Math.max(1, p.w), Math.max(1, p.l))
          })),
        leftovers: leftovers
          .filter((rm: any) => rm.w > 0 && rm.l > 0)
          .map((rm: any, i: number) => ({
            id: rm.id || i + 1,
            x: rm.x,
            y: rm.y,
            shape: rectangle(rm.w, rm.l),
            hasDefect: Boolean(rm.hasDefect)
          })),
        cuts: cuts.map((c: any) => ({
          sequence: c.sequence,
          kind: c.kind,
          startX: c.startX,
          startY: c.startY,
          endX: c.endX,
          endY: c.endY
        }))
      },
      marker: { occupiedLengthMm: matLen, gapFillPlacements }
    };
    const sc = (showcaseScene as any)(req, res, 0, {
      occupiedLengthMm: matLen,
      gapFillPlacements
    });
    if (sc && sc.roll) {
      sc.roll = { ...sc.roll, id: scheme.rollId || '虚拟新母卷', width: matWidth, total: matLen };
      if (Array.isArray(sc.segments) && sc.segments[0]) {
        sc.segments[0] = {
          ...sc.segments[0],
          label: sanitizeSchemeTitle(scheme.title) || scheme.id || '排程方案复盘'
        };
      }
    }
    return sc;
  } catch (err) {
    console.warn('buildReplayScene2D fallback:', err);
    return null;
  }
}
