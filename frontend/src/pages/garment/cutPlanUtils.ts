import { csvCell } from '../../lib/domain/report-model.js';

export interface CutPlanSizeRow {
  size: string;
  quantity: number;
  unitAreaM2: number;
}

export interface CutPlanFormState {
  styleName: string;
  colorName: string;
  fabricWidthMm: number;
  maxPliesPerLay: number;
  maxGarmentsPerMarker: number;
  maxLayLengthMm: number;
  endAllowanceMm: number;
  grammageGsm: number;
  defaultUnitAreaM2: number;
  targetUtilizationPct: number;
  allowOvercutPct: number;
  sizes: CutPlanSizeRow[];
}

export interface CutPlanRequestPayload {
  styleName: string;
  colorName: string;
  fabricWidthMm: number;
  maxPliesPerLay: number;
  maxGarmentsPerMarker: number;
  sizeQuantities: Record<string, number>;
  sizeUnitAreaM2?: Record<string, number>;
  maxLayLengthMm?: number;
  endAllowanceMm?: number;
  grammageGsm?: number;
  defaultUnitAreaM2?: number;
  targetUtilizationPct?: number;
  allowOvercutPct?: number;
}

export interface CutPlanLay {
  layNo: number;
  plies: number;
  ratio: Record<string, number>;
  garmentsPerMarker: number;
  layGarments: number;
  estimatedMarkerLengthMm: number;
  fabricLengthM: number;
  fabricAreaM2: number;
}

export interface CutPlanSizeAudit {
  size: string;
  ordered: number;
  planned: number;
  delta: number;
}

export interface CutPlanResponse {
  styleName: string;
  colorName: string;
  totalOrderedGarments: number;
  totalPlannedGarments: number;
  overcutGarments: number;
  layCount: number;
  totalPlies: number;
  totalFabricLengthM: number;
  totalFabricAreaM2: number;
  estimatedWeightKg: number;
  averageEfficiencyPct: number;
  lays: CutPlanLay[];
  sizeAudit: CutPlanSizeAudit[];
}

export interface CutPlanAuditSummary {
  balanced: boolean;
  exactCount: number;
  overcutCount: number;
  shortageCount: number;
  overcutTotal: number;
  shortageTotal: number;
}

export interface CutPlanWorkbenchDemand {
  id: number;
  name: string;
  sizeLabel: string;
  width: number;
  length: number;
  quantity: number;
  allowRotation: boolean;
}

export interface CutPlanDemandPoolPayload {
  name: string;
  materialModel: string;
  externalRef: string;
  dimension: 'RECT_2D';
  requiredColor?: string;
  demands: CutPlanWorkbenchDemand[];
}

export interface CutPlanPreset {
  id: string;
  label: string;
  form: CutPlanFormState;
}

export const DEFAULT_GARMENT_SIZES: CutPlanSizeRow[] = [
  { size: 'S', quantity: 60, unitAreaM2: 1.18 },
  { size: 'M', quantity: 120, unitAreaM2: 1.26 },
  { size: 'L', quantity: 150, unitAreaM2: 1.35 },
  { size: 'XL', quantity: 90, unitAreaM2: 1.44 },
  { size: '2XL', quantity: 40, unitAreaM2: 1.54 }
];

export function cloneCutPlanSizes(sizes: readonly CutPlanSizeRow[]): CutPlanSizeRow[] {
  return sizes.map((row) => ({ ...row }));
}

export function createDefaultCutPlanForm(): CutPlanFormState {
  return {
    styleName: 'FZ-2026-HOODIE',
    colorName: '炭灰',
    fabricWidthMm: 1650,
    maxPliesPerLay: 60,
    maxGarmentsPerMarker: 8,
    maxLayLengthMm: 10000,
    endAllowanceMm: 60,
    grammageGsm: 280,
    defaultUnitAreaM2: 1.32,
    targetUtilizationPct: 84,
    allowOvercutPct: 0,
    sizes: cloneCutPlanSizes(DEFAULT_GARMENT_SIZES)
  };
}

export const CUT_PLAN_PRESETS: CutPlanPreset[] = [
  {
    id: 'hoodie-standard',
    label: '卫衣 S~2XL（460件）',
    form: createDefaultCutPlanForm()
  },
  {
    id: 'kids-graded',
    label: '童装 110~160（360件）',
    form: {
      styleName: 'KD-2026-SWEAT',
      colorName: '雾蓝',
      fabricWidthMm: 1780,
      maxPliesPerLay: 50,
      maxGarmentsPerMarker: 10,
      maxLayLengthMm: 9000,
      endAllowanceMm: 50,
      grammageGsm: 240,
      defaultUnitAreaM2: 0.92,
      targetUtilizationPct: 85,
      allowOvercutPct: 0,
      sizes: [
        { size: '110', quantity: 40, unitAreaM2: 0.72 },
        { size: '120', quantity: 60, unitAreaM2: 0.8 },
        { size: '130', quantity: 80, unitAreaM2: 0.88 },
        { size: '140', quantity: 80, unitAreaM2: 0.96 },
        { size: '150', quantity: 60, unitAreaM2: 1.05 },
        { size: '160', quantity: 40, unitAreaM2: 1.14 }
      ]
    }
  },
  {
    id: 'shirt-compact',
    label: '衬衫 S~XL（180件）',
    form: {
      styleName: 'SH-2026-OXFORD',
      colorName: '本白',
      fabricWidthMm: 1500,
      maxPliesPerLay: 40,
      maxGarmentsPerMarker: 6,
      maxLayLengthMm: 8000,
      endAllowanceMm: 40,
      grammageGsm: 185,
      defaultUnitAreaM2: 1.28,
      targetUtilizationPct: 83,
      allowOvercutPct: 2,
      sizes: [
        { size: 'S', quantity: 30, unitAreaM2: 1.15 },
        { size: 'M', quantity: 60, unitAreaM2: 1.24 },
        { size: 'L', quantity: 55, unitAreaM2: 1.33 },
        { size: 'XL', quantity: 35, unitAreaM2: 1.42 }
      ]
    }
  }
];

export function cloneCutPlanForm(form: CutPlanFormState): CutPlanFormState {
  return {
    ...form,
    sizes: cloneCutPlanSizes(form.sizes)
  };
}

export function totalCutPlanOrderedQty(sizes: readonly CutPlanSizeRow[]): number {
  let sum = 0;
  for (const row of sizes || []) {
    const qty = Number(row?.quantity);
    if (Number.isFinite(qty) && qty > 0) {
      sum += Math.floor(qty);
    }
  }
  return sum;
}

const ALPHA_SIZE_SEQUENCE = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
const NUMERIC_SIZE_SEQUENCE = ['90', '100', '110', '120', '130', '140', '150', '160', '170', '180'];

export function suggestNextSizeRow(existingSizes: readonly CutPlanSizeRow[]): CutPlanSizeRow {
  const existing = new Set(
    existingSizes.map((r) => r.size.trim().toUpperCase()).filter(Boolean)
  );
  const last = existingSizes[existingSizes.length - 1];
  const baseArea = last && Number.isFinite(last.unitAreaM2) && last.unitAreaM2 > 0
    ? Number((last.unitAreaM2 + 0.08).toFixed(2))
    : 1.4;

  const isNumericOrder = existingSizes.some((r) => /^\d+$/.test(r.size.trim()));
  const candidates = isNumericOrder ? NUMERIC_SIZE_SEQUENCE : ALPHA_SIZE_SEQUENCE;
  const lastCode = last?.size.trim().toUpperCase() ?? '';
  const lastIdx = candidates.indexOf(lastCode);
  const orderedCandidates =
    lastIdx >= 0
      ? [...candidates.slice(lastIdx + 1), ...candidates.slice(0, lastIdx)]
      : candidates;
  for (const cand of orderedCandidates) {
    if (!existing.has(cand)) {
      return { size: cand, quantity: 20, unitAreaM2: baseArea };
    }
  }

  let seq = existingSizes.length + 1;
  while (existing.has(`S${seq}`)) {
    seq += 1;
  }
  return { size: `S${seq}`, quantity: 20, unitAreaM2: baseArea };
}

/**
 * 严格校验分床配置并组装与后端 `/api/v2/planning/cut-plan` 一致的请求载荷。
 */
export function buildCutPlanPayload(form: CutPlanFormState): {
  payload?: CutPlanRequestPayload;
  error?: string;
} {
  const styleName = (form.styleName ?? '').trim();
  const colorName = (form.colorName ?? '').trim();
  if (!styleName) return { error: '请填写款号名称' };
  if (!colorName) return { error: '请填写颜色名称' };

  const fabricWidthMm = Number(form.fabricWidthMm);
  if (!Number.isFinite(fabricWidthMm) || fabricWidthMm <= 0) {
    return { error: '布料门幅须大于 0 mm' };
  }

  const maxPliesPerLay = Math.floor(Number(form.maxPliesPerLay));
  if (!Number.isFinite(maxPliesPerLay) || maxPliesPerLay < 1 || maxPliesPerLay > 10000) {
    return { error: '单床最大铺布层数须在 1 至 10,000 层之间' };
  }

  const maxGarmentsPerMarker = Math.floor(Number(form.maxGarmentsPerMarker));
  if (
    !Number.isFinite(maxGarmentsPerMarker) ||
    maxGarmentsPerMarker < 1 ||
    maxGarmentsPerMarker > 100
  ) {
    return { error: '单唛最大件数须在 1 至 100 件之间' };
  }

  const maxLayLengthMm = Number(form.maxLayLengthMm);
  if (!Number.isFinite(maxLayLengthMm) || maxLayLengthMm < 0) {
    return { error: '最大裁床床长不能为负数（填 0 表示不限制）' };
  }

  const endAllowanceMm = Number(form.endAllowanceMm);
  if (!Number.isFinite(endAllowanceMm) || endAllowanceMm < 0 || endAllowanceMm > 2000) {
    return { error: '床头尾损耗须在 0 至 2,000 mm 之间' };
  }

  const grammageGsm = Number(form.grammageGsm);
  if (!Number.isFinite(grammageGsm) || grammageGsm < 0) {
    return { error: '面料克重不能为负数' };
  }

  const defaultUnitAreaM2 = Number(form.defaultUnitAreaM2);
  if (!Number.isFinite(defaultUnitAreaM2) || defaultUnitAreaM2 <= 0) {
    return { error: '默认单件净面积须大于 0 m²' };
  }

  const targetUtilizationPct = Number(form.targetUtilizationPct);
  if (
    !Number.isFinite(targetUtilizationPct) ||
    targetUtilizationPct <= 10 ||
    targetUtilizationPct > 100
  ) {
    return { error: '目标利用率须在 10%（不含）至 100% 之间' };
  }

  const allowOvercutPct = Number(form.allowOvercutPct);
  if (!Number.isFinite(allowOvercutPct) || allowOvercutPct < 0 || allowOvercutPct > 50) {
    return { error: '允许超裁上限须在 0% 至 50% 之间' };
  }

  const sizeQuantities: Record<string, number> = {};
  const sizeAreaWeightedSum: Record<string, number> = {};
  const sizeAreaQtySum: Record<string, number> = {};
  let totalOrdered = 0;

  for (const row of form.sizes || []) {
    const key = (row?.size ?? '').trim().toUpperCase();
    const rawQty = Number(row?.quantity);
    if (!Number.isFinite(rawQty) || rawQty < 0) {
      return { error: `尺码「${key || '未命名'}」的订单件数不能为负数` };
    }
    const qty = Math.floor(rawQty);
    if (qty > 0 && !key) {
      return { error: '存在已填件数但尺码名称为空的行，请补全尺码名' };
    }
    if (!key || qty <= 0) continue;

    const rawArea = Number(row?.unitAreaM2);
    if (row?.unitAreaM2 !== undefined && (!Number.isFinite(rawArea) || rawArea < 0)) {
      return { error: `尺码「${key}」的单件净面积不能为负数` };
    }

    sizeQuantities[key] = (sizeQuantities[key] || 0) + qty;
    totalOrdered += qty;
    if (Number.isFinite(rawArea) && rawArea > 0) {
      sizeAreaWeightedSum[key] = (sizeAreaWeightedSum[key] || 0) + rawArea * qty;
      sizeAreaQtySum[key] = (sizeAreaQtySum[key] || 0) + qty;
    }
  }

  if (totalOrdered <= 0) {
    return { error: '请至少为一个尺码录入大于 0 的订单件数' };
  }

  const sizeUnitAreaM2: Record<string, number> = {};
  for (const key of Object.keys(sizeAreaQtySum)) {
    const weighted = sizeAreaWeightedSum[key] / sizeAreaQtySum[key];
    sizeUnitAreaM2[key] = Number(weighted.toFixed(4));
  }

  const payload: CutPlanRequestPayload = {
    styleName,
    colorName,
    fabricWidthMm,
    maxPliesPerLay,
    maxGarmentsPerMarker,
    sizeQuantities,
    endAllowanceMm,
    defaultUnitAreaM2,
    targetUtilizationPct,
    allowOvercutPct
  };

  if (Object.keys(sizeUnitAreaM2).length > 0) {
    payload.sizeUnitAreaM2 = sizeUnitAreaM2;
  }
  if (maxLayLengthMm > 0) {
    payload.maxLayLengthMm = maxLayLengthMm;
  }
  if (grammageGsm > 0) {
    payload.grammageGsm = grammageGsm;
  }

  return { payload };
}

export function extractCutPlanSizeKeys(plan: CutPlanResponse): string[] {
  return Array.from(
    new Set([
      ...(plan.sizeAudit || []).map((a) => a.size),
      ...(plan.lays || []).flatMap((l) => Object.keys(l.ratio || {}))
    ])
  );
}

export function summarizeSizeAudit(audit: readonly CutPlanSizeAudit[]): CutPlanAuditSummary {
  let exactCount = 0;
  let overcutCount = 0;
  let shortageCount = 0;
  let overcutTotal = 0;
  let shortageTotal = 0;

  for (const row of audit || []) {
    const delta = Number(row.delta) || 0;
    if (delta === 0) {
      exactCount += 1;
    } else if (delta > 0) {
      overcutCount += 1;
      overcutTotal += delta;
    } else {
      shortageCount += 1;
      shortageTotal += Math.abs(delta);
    }
  }

  return {
    balanced: shortageTotal === 0,
    exactCount,
    overcutCount,
    shortageCount,
    overcutTotal,
    shortageTotal
  };
}

/**
 * 导出防 CSV 公式注入与 RFC 4180 安全转义的分床明细表（UTF-8 BOM + CRLF）。
 */
export function buildCutPlanCsvText(plan: CutPlanResponse): string {
  const sizeKeys = extractCutPlanSizeKeys(plan);
  const header = [
    '款号',
    '颜色',
    '床次',
    '铺布层数(层)',
    ...sizeKeys.map((s) => `配比_${s}`),
    '单唛件数(件)',
    '本床产出(件)',
    '预估唛架长(mm)',
    '耗布米数(m)',
    '耗布面积(m²)'
  ];
  const rows = (plan.lays || []).map((lay) => [
    plan.styleName,
    plan.colorName,
    `第${lay.layNo}床`,
    lay.plies,
    ...sizeKeys.map((s) => lay.ratio?.[s] ?? 0),
    lay.garmentsPerMarker,
    lay.layGarments,
    lay.estimatedMarkerLengthMm,
    lay.fabricLengthM,
    lay.fabricAreaM2
  ]);
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * 将分床计划按尺码计划件数折算为可送入二维工作台的需求行列表。
 */
export function buildCutPlanWorkbenchDemands(
  plan: CutPlanResponse,
  form: Pick<CutPlanFormState, 'fabricWidthMm' | 'defaultUnitAreaM2' | 'sizes'>
): CutPlanWorkbenchDemand[] {
  const validSizes = (plan.sizeAudit || []).filter((s) => Number(s.planned) > 0);
  if (!validSizes.length) return [];

  const fabW = Math.max(600, Number(form.fabricWidthMm) || 1650);
  const fallbackArea = Math.max(0.2, Number(form.defaultUnitAreaM2) || 1.25);

  const areaByNormalizedSize = new Map<string, number>();
  for (const row of form.sizes || []) {
    const key = (row.size || '').trim().toUpperCase();
    if (key && Number.isFinite(Number(row.unitAreaM2)) && Number(row.unitAreaM2) > 0) {
      areaByNormalizedSize.set(key, Number(row.unitAreaM2));
    }
  }

  return validSizes.map((s, idx) => {
    const normSize = (s.size || '').trim().toUpperCase();
    const matchedArea = areaByNormalizedSize.get(normSize);
    const areaM2 = Math.max(0.2, matchedArea ?? fallbackArea);
    const w = Math.min(Math.round(fabW * 0.45), 720);
    const l = Math.max(400, Math.round((areaM2 * 1_000_000) / w));
    return {
      id: idx + 1,
      name: `${plan.styleName}-${s.size}码整套`,
      sizeLabel: s.size,
      width: w,
      length: l,
      quantity: Math.floor(s.planned),
      allowRotation: false
    };
  });
}

export function buildCutPlanDemandPoolPayload(
  plan: CutPlanResponse,
  form: Pick<CutPlanFormState, 'fabricWidthMm' | 'defaultUnitAreaM2' | 'sizes'>
): {
  payload?: CutPlanDemandPoolPayload;
  canvasWidthMm: number;
  canvasLengthMm: number;
  error?: string;
} {
  const fabW = Math.max(600, Number(form.fabricWidthMm) || 1650);
  const canvasLengthMm = Math.max(
    2000,
    Math.round(plan.lays?.[0]?.estimatedMarkerLengthMm || 3200)
  );
  const demands = buildCutPlanWorkbenchDemands(plan, form);
  if (!demands.length) {
    return {
      canvasWidthMm: fabW,
      canvasLengthMm,
      error: '分床结果没有有效计划件数'
    };
  }
  return {
    canvasWidthMm: fabW,
    canvasLengthMm,
    payload: {
      name: `分床转入 · ${plan.styleName} (${plan.colorName})`,
      materialModel: `${plan.styleName}-FABRIC`,
      externalRef: `CUTPLAN-${plan.layCount}LAY`,
      dimension: 'RECT_2D',
      requiredColor: plan.colorName?.trim() || undefined,
      demands
    }
  };
}
