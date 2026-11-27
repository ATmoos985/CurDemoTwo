import { fmtN } from '../../lib/core/util.js';
import {
  DXF_TRIAL_STYLES,
  GARMENT_TRIAL_STYLES,
  MARKER_STYLES,
  markerSizeLabels
} from '../../lib/nesting/marker-demo.js';
import { DXF_GARMENT_STYLES } from '../../lib/nesting/dxf-garment-samples.js';
import {
  GARMENT_EXAMPLES,
  compactionSavingMm,
  effectiveUtilization
} from '../../lib/model/garment.js';
import type { DemandItem } from '../../store/studioTypes';

export interface GarmentExample {
  id: string;
  name: string;
  style: string;
  widths: number[];
  edge: number;
  gsm?: number | null;
  source?: string;
  fabric?: string;
  halfTurn?: boolean;
  gapFill?: boolean;
  benchmark?: {
    width: number;
    length: number;
    counts: Record<string, number>;
    utilization: number;
    dxfUtilization: number;
  };
  [size: string]: any;
}

export const EXAMPLES = GARMENT_EXAMPLES as GarmentExample[];

export type SelectedSource =
  | { kind: 'row'; index: number }
  | { kind: 'optimized' }
  | { kind: 'reference' }
  | null;

export type GarmentPageTab = 'width' | 'cutplan';

export const QUICK_PILL_STYLES = [
  ...DXF_TRIAL_STYLES.filter((s: any) => s.fabric === '面布'),
  ...MARKER_STYLES
];

export function resolveInitialExample(id?: string): GarmentExample {
  return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
}

export function buildPreviewRow(layout: any, direction: string) {
  const { request, result, verified } = layout;
  return {
    width: verified.widthMm,
    layoutRequest: request,
    result,
    direction,
    state: `${verified.pieceCount} 片 · 掉头 ${verified.rotatedCount} 片`,
    use: {
      length: verified.occupiedLengthMm,
      utilization: verified.utilizationPercent,
      gramsPerGarment: null
    },
    verified
  };
}

export function getOrderedSizes(style: string): string[] {
  const dxf = EXAMPLES.find((e) => e.style === style && e.source);
  const sizes: string[] = markerSizeLabels(style);
  return dxf
    ? [...sizes.filter((s) => dxf[s] > 0), ...sizes.filter((s) => !dxf[s])]
    : sizes;
}

export function buildSizeCounts(
  style: string,
  source?: Record<string, any>
): Record<string, number> {
  const dxf = EXAMPLES.find((e) => e.style === style && e.source);
  const sizes: string[] = markerSizeLabels(style);
  const out: Record<string, number> = {};
  for (const s of sizes) {
    const raw = source?.[s] ?? dxf?.[s] ?? 1;
    out[s] = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  }
  return out;
}

export function resolveGarmentMaterialMeta(
  styleId: string,
  displayedRow?: { width?: number; direction?: string } | null
): { styleName: string; materialModel: string; externalRef: string } {
  const dxfTrial = DXF_TRIAL_STYLES.find((s: any) => s.id === styleId);
  const dxfLegacy = (DXF_GARMENT_STYLES as any)[styleId];
  const styleName =
    GARMENT_TRIAL_STYLES.find((s: any) => s.id === styleId)?.name || '服装唛架';
  const materialModel =
    dxfTrial?.fabric ||
    dxfLegacy?.materialModel ||
    (displayedRow?.width != null
      ? `GARMENT-${Math.round(displayedRow.width)}`
      : 'TC涤棉-B2026');
  const externalRef = dxfTrial
    ? `${dxfTrial.source}.dxf · ${fmtN(displayedRow?.width ?? 1780, 1)}mm`
    : dxfLegacy
    ? `CAD纸样 ${dxfLegacy.file} · ${fmtN(displayedRow?.width ?? 1650, 1)}mm`
    : `唛架试算 ${fmtN(displayedRow?.width ?? 1500, 1)}mm (${displayedRow?.direction || ''})`;
  return { styleName, materialModel, externalRef };
}

export function buildStudio2DDemandsFromMarker(parts: any[]): DemandItem[] {
  return (parts || []).map((p: any, i: number) => ({
    id: i + 1,
    name: p.name || String(p.id),
    width: p.shape?.width || 0,
    length: p.shape?.height || 0,
    quantity: p.quantity || 1,
    allowRotation: Boolean(p.allowRotation),
    allowHalfTurn: Boolean(p.allowHalfTurn),
    shape: p.shape
  }));
}

export function computeGarmentRowMetricsSummary(rows: any[]) {
  const validRows = rows.filter((r) => r.use);
  const finiteGramRows = validRows.filter((r) =>
    Number.isFinite(r.use?.gramsPerGarment)
  );
  const lowestGrams = finiteGramRows.length
    ? Math.min(...finiteGramRows.map((r) => r.use.gramsPerGarment))
    : Infinity;
  const highestUtil = validRows.length
    ? Math.max(...validRows.map((r) => effectiveUtilization(r.use)))
    : -Infinity;
  const lowestRow =
    finiteGramRows.find((r) => r.use.gramsPerGarment === lowestGrams) || null;
  const highestRow =
    validRows.find((r) => effectiveUtilization(r.use) === highestUtil) || null;
  const recommendedRow = lowestRow || highestRow;
  return {
    validRows,
    finiteGramRows,
    lowestGrams,
    highestUtil,
    lowestRow,
    highestRow,
    recommendedRow
  };
}

export function buildTrialDetailNotes(
  row: any,
  opts: {
    halfTurn: boolean;
    gapFill: boolean;
    rows: any[];
    referencePreview?: { use: { utilization: number } } | null;
  }
): string[] {
  const { halfTurn, gapFill, rows, referencePreview } = opts;
  const info: string[] = halfTurn ? [row.direction] : [];
  if (referencePreview && row.use) {
    const delta = row.use.utilization - referencePreview.use.utilization;
    info.push(`较按图复排 ${delta > 0 ? '+' : ''}${fmtN(delta, 2)} 个百分点`);
  }
  const seed = row.result?.marker?.trials?.find((t: any) => t.phase === 'SEED');
  if (seed && row.use) {
    const improvement = seed.occupiedLengthMm - row.use.length;
    info.push(
      improvement > 0.005
        ? `较初排缩短 ${fmtN(improvement, 2)} mm`
        : '沿用已验初排'
    );
  }
  if (row.retryNote) info.push(row.retryNote);
  if (row.halfTurn && row.result?.layout) {
    if (row.usedFixed) info.push('沿用固定方向');
    const turned = row.result.layout.placements.filter(
      (p: any) => p.rotationDegrees === 180
    ).length;
    const turnedSpares =
      row.result.marker?.gapFillPlacements?.filter(
        (p: any) => p.rotationDegrees === 180
      ).length ?? 0;
    info.push(
      `掉头 ${turned + turnedSpares} 片${
        turnedSpares ? `（含备片 ${turnedSpares} 片）` : ''
      }`
    );
    if (row.usedFixed) {
      const raw = row.trial?.use;
      info.push(
        raw
          ? `掉头原试排 ${fmtN(raw.length, 2)} mm / 齐套 ${fmtN(
              raw.utilization,
              2
            )}%${
              raw.fillCount != null
                ? ` / 含补片 ${fmtN(raw.utilizationWithFill, 2)}%`
                : ''
            }`
          : '掉头试排未齐套'
      );
      if (row.trial?.job?.state === 'TIMED_OUT') info.push('掉头试排限时结束');
    }
    const base = rows.find((r) => r.width === row.width && !r.halfTurn);
    if (row.use && base?.use) {
      const withFill =
        gapFill && row.use.fillCount != null && base.use.fillCount != null;
      const key = withFill ? 'utilizationWithFill' : 'utilization';
      const delta = row.use[key] - base.use[key];
      info.push(
        `${withFill ? '含补片' : '齐套'}较固定 ${
          delta > 0 ? '+' : ''
        }${fmtN(delta, 2)} 个百分点`
      );
    }
  }
  const saved = row.use && row.result?.marker?.trials ? compactionSavingMm(row.result.marker.trials) : 0;
  if (saved > 0 && !seed) {
    info.push(
      `${row.usedFixed ? '固定方案' : ''}压紧节省 ${
        saved < 0.01 ? '不足 0.01' : fmtN(saved, 2)
      } mm`
    );
  }
  return info;
}
