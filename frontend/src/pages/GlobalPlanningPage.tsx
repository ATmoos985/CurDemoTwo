import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, fmtN, toast } from '@static/app/js/util.js';
import { csvCell } from '@static/js/business/analysis/report-model.js';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { useStudioStore, DemandFamilySummary } from '../store/useStudioStore';

export interface MultiMaterialDemandDraft {
  id: string;
  name: string;
  width: number;
  length: number;
  quantity: number;
  allowRotation: boolean;
}

export interface MultiMaterialRemnantAllocation {
  remnantId: string;
  widthMm: number;
  lengthMm: number;
  utilizationPct: number;
  placedCount: number;
  piecesAreaM2: number;
  allocatedItems: any[];
}

export interface MultiMaterialRollOption {
  rollId: string;
  widthMm: number;
  availableLengthMm: number;
  estimatedCutLengthMm: number;
  utilizationPct: number;
  placedCount: number;
  feasible: boolean;
  recommended: boolean;
}

export interface MultiMaterialPlanResponse {
  materialModel: string | null;
  totalRequestedPieces: number;
  placedByRemnants: number;
  placedByRoll: number;
  unplacedPieces: number;
  remnantAllocations: MultiMaterialRemnantAllocation[];
  rollOptions: MultiMaterialRollOption[];
  totalSavedAreaM2: number;
  elapsedMs: number;
  warnings: string[];
}

export interface CutPlanSizeRow {
  size: string;
  quantity: number;
  unitAreaM2: number;
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

export const DEFAULT_MULTI_DEMANDS: MultiMaterialDemandDraft[] = [
  { id: '1', name: '前大身片', width: 580, length: 760, quantity: 6, allowRotation: true },
  { id: '2', name: '后片', width: 560, length: 740, quantity: 6, allowRotation: true },
  { id: '3', name: '袖片', width: 420, length: 620, quantity: 10, allowRotation: true }
];

export const DEFAULT_GARMENT_SIZES: CutPlanSizeRow[] = [
  { size: 'S', quantity: 60, unitAreaM2: 1.18 },
  { size: 'M', quantity: 120, unitAreaM2: 1.26 },
  { size: 'L', quantity: 150, unitAreaM2: 1.35 },
  { size: 'XL', quantity: 90, unitAreaM2: 1.44 },
  { size: '2XL', quantity: 40, unitAreaM2: 1.54 }
];

export interface MultiMaterialFormState {
  sourceMode: 'TASK' | 'MANUAL';
  taskId: string;
  materialModel: string;
  requiredBatchNo: string;
  requiredColor: string;
  preferRemnants: boolean;
  maxRemnants: number;
  timeBudgetMs: number;
  pieceGapMm: number;
  trimStartMm: number;
  demands: MultiMaterialDemandDraft[];
}

export function buildMultiMaterialPayload(form: MultiMaterialFormState): {
  payload?: Record<string, any>;
  error?: string;
} {
  const payload: Record<string, any> = {
    preferRemnants: Boolean(form.preferRemnants),
    maxRemnants: Math.max(0, Math.min(50, Math.round(Number(form.maxRemnants) || 0))),
    timeBudgetMs: Math.max(200, Math.min(60000, Math.round(Number(form.timeBudgetMs) || 3000))),
    pieceGapMm: Math.max(0, Number(form.pieceGapMm) || 0),
    trimStartMm: Math.max(0, Number(form.trimStartMm) || 0)
  };
  if (form.materialModel.trim()) payload.materialModel = form.materialModel.trim();
  if (form.requiredBatchNo.trim()) payload.requiredBatchNo = form.requiredBatchNo.trim();
  if (form.requiredColor.trim()) payload.requiredColor = form.requiredColor.trim();

  if (form.sourceMode === 'TASK') {
    if (!form.taskId.trim()) {
      return { error: '请先在需求池中选择一个待排任务，或切换至手工录单模式' };
    }
    payload.taskId = form.taskId.trim();
  } else {
    const valid = form.demands
      .filter((d) => Number(d.width) > 0 && Number(d.length) > 0 && Number(d.quantity) > 0)
      .map((d, idx) => ({
        id: idx + 1,
        name: d.name.trim() || `裁片-${idx + 1}`,
        width: Number(d.width),
        length: Number(d.length),
        quantity: Math.floor(Number(d.quantity)),
        allowRotation: Boolean(d.allowRotation)
      }));
    if (!valid.length) {
      return { error: '请至少录入 1 行有效的裁片宽、长与件数' };
    }
    payload.demands = valid;
  }

  return { payload };
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

export function buildCutPlanPayload(form: CutPlanFormState): {
  payload?: Record<string, any>;
  error?: string;
} {
  if (!form.styleName.trim()) return { error: '请填写款号名称' };
  if (!form.colorName.trim()) return { error: '请填写颜色名称' };
  const fabricWidthMm = Number(form.fabricWidthMm);
  const maxPliesPerLay = Math.floor(Number(form.maxPliesPerLay));
  const maxGarmentsPerMarker = Math.floor(Number(form.maxGarmentsPerMarker));
  if (!Number.isFinite(fabricWidthMm) || fabricWidthMm <= 0) {
    return { error: '布料门幅须大于 0 mm' };
  }
  if (!Number.isFinite(maxPliesPerLay) || maxPliesPerLay < 1) {
    return { error: '单床最大铺布层数须至少为 1 层' };
  }
  if (!Number.isFinite(maxGarmentsPerMarker) || maxGarmentsPerMarker < 1) {
    return { error: '单唛最大件数须至少为 1 件' };
  }

  const sizeQuantities: Record<string, number> = {};
  const sizeUnitAreaM2: Record<string, number> = {};
  let totalOrdered = 0;

  for (const row of form.sizes) {
    const key = row.size.trim().toUpperCase();
    const qty = Math.floor(Number(row.quantity) || 0);
    if (!key || qty <= 0) continue;
    sizeQuantities[key] = (sizeQuantities[key] || 0) + qty;
    totalOrdered += qty;
    if (Number(row.unitAreaM2) > 0) {
      sizeUnitAreaM2[key] = Number(row.unitAreaM2);
    }
  }

  if (totalOrdered <= 0) {
    return { error: '请至少为一个尺码录入大于 0 的订单件数' };
  }

  const payload: Record<string, any> = {
    styleName: form.styleName.trim(),
    colorName: form.colorName.trim(),
    fabricWidthMm,
    maxPliesPerLay,
    maxGarmentsPerMarker,
    sizeQuantities
  };
  if (Object.keys(sizeUnitAreaM2).length > 0) payload.sizeUnitAreaM2 = sizeUnitAreaM2;
  if (Number(form.maxLayLengthMm) > 0) payload.maxLayLengthMm = Number(form.maxLayLengthMm);
  if (Number(form.endAllowanceMm) >= 0) payload.endAllowanceMm = Number(form.endAllowanceMm);
  if (Number(form.grammageGsm) > 0) payload.grammageGsm = Number(form.grammageGsm);
  if (Number(form.defaultUnitAreaM2) > 0) payload.defaultUnitAreaM2 = Number(form.defaultUnitAreaM2);
  if (Number(form.targetUtilizationPct) > 0) {
    payload.targetUtilizationPct = Number(form.targetUtilizationPct);
  }
  if (Number(form.allowOvercutPct) >= 0) payload.allowOvercutPct = Number(form.allowOvercutPct);

  return { payload };
}

export function summarizeSizeAudit(audit: CutPlanSizeAudit[]): {
  balanced: boolean;
  exactCount: number;
  overcutTotal: number;
  shortageTotal: number;
} {
  let exactCount = 0;
  let overcutTotal = 0;
  let shortageTotal = 0;
  for (const row of audit || []) {
    const delta = Number(row.delta) || 0;
    if (delta === 0) exactCount += 1;
    else if (delta > 0) overcutTotal += delta;
    else shortageTotal += Math.abs(delta);
  }
  return {
    balanced: shortageTotal === 0,
    exactCount,
    overcutTotal,
    shortageTotal
  };
}

export function buildCutPlanCsvText(plan: CutPlanResponse): string {
  const sizeKeys = Array.from(
    new Set([
      ...(plan.sizeAudit || []).map((a) => a.size),
      ...(plan.lays || []).flatMap((l) => Object.keys(l.ratio || {}))
    ])
  );
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

export function buildMultiMaterialCsvText(plan: MultiMaterialPlanResponse): string {
  const header = [
    '类别',
    '材料编号',
    '品号',
    '门幅(mm)',
    '长度/可用余长(mm)',
    '预计切长(mm)',
    '利用率(%)',
    '排入件数',
    '状态/明细'
  ];
  const rows: (string | number)[][] = [];
  for (const rem of plan.remnantAllocations || []) {
    rows.push([
      '料头接力',
      rem.remnantId,
      plan.materialModel || '',
      rem.widthMm,
      rem.lengthMm,
      rem.lengthMm,
      Number(rem.utilizationPct || 0).toFixed(2),
      rem.placedCount,
      formatAllocatedItems(rem.allocatedItems)
    ]);
  }
  for (const opt of plan.rollOptions || []) {
    rows.push([
      '母卷评估',
      opt.rollId,
      plan.materialModel || '',
      opt.widthMm,
      opt.availableLengthMm,
      opt.estimatedCutLengthMm,
      Number(opt.utilizationPct || 0).toFixed(2),
      opt.placedCount,
      opt.recommended ? '推荐首选' : opt.feasible ? '可行备选' : '长度或门幅不足'
    ]);
  }
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function formatAllocatedItems(items: any[]): string {
  if (!Array.isArray(items) || !items.length) return '—';
  return items
    .map((it) => {
      if (typeof it === 'string') return it;
      const label =
        it?.name ||
        it?.partName ||
        (it?.demandId != null
          ? `裁片#${it.demandId}`
          : it?.partId != null
          ? `裁片#${it.partId}`
          : '裁片');
      const count = it?.count ?? it?.quantity;
      return count != null ? `${label}×${count}` : String(label);
    })
    .join('、');
}

export const GlobalPlanningPage: React.FC = () => {
  const { loadDemandFamilyIntoWorkbench, setCanvasSpec } = useStudioStore();
  const [activeTab, setActiveTab] = useState<'multi' | 'cutplan'>('multi');
  const [dispatching, setDispatching] = useState(false);

  // 需求池选项（只读 GET 加载）
  const [demandTasks, setDemandTasks] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);

  // Tab 1: 多料头 + 多母卷联合排产状态
  const [multiForm, setMultiForm] = useState<MultiMaterialFormState>({
    sourceMode: 'MANUAL',
    taskId: '',
    materialModel: '',
    requiredBatchNo: '',
    requiredColor: '',
    preferRemnants: true,
    maxRemnants: 5,
    timeBudgetMs: 3000,
    pieceGapMm: 4,
    trimStartMm: 20,
    demands: DEFAULT_MULTI_DEMANDS
  });
  const [multiBusy, setMultiBusy] = useState(false);
  const [multiError, setMultiError] = useState<string | null>(null);
  const [multiResult, setMultiResult] = useState<MultiMaterialPlanResponse | null>(null);

  // Tab 2: 服装订单自动分床状态
  const [cutForm, setCutForm] = useState<CutPlanFormState>({
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
    sizes: DEFAULT_GARMENT_SIZES
  });
  const [cutBusy, setCutBusy] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);
  const [cutResult, setCutResult] = useState<CutPlanResponse | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingTasks(true);
    requestJSON('/api/v2/demand-pool')
      .then((res) => {
        if (!active) return;
        const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
        setDemandTasks(list);
      })
      .catch(() => {
        if (active) setDemandTasks([]);
      })
      .finally(() => {
        if (active) setLoadingTasks(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const tabOptions: SegmentedOption<'multi' | 'cutplan'>[] = useMemo(
    () => [
      {
        value: 'multi',
        label: '多料头 + 多母卷联合排产',
        count: multiResult ? multiResult.rollOptions.length : undefined,
        accent: 'indigo'
      },
      {
        value: 'cutplan',
        label: '服装订单自动分床 (Cut Plan)',
        count: cutResult ? cutResult.layCount : undefined,
        accent: 'emerald'
      }
    ],
    [multiResult, cutResult]
  );

  const handleSelectTask = (taskId: string) => {
    const matched = demandTasks.find((t) => String(t.id) === taskId);
    setMultiForm((prev) => ({
      ...prev,
      taskId,
      materialModel: matched?.materialModel || prev.materialModel,
      requiredBatchNo: matched?.batchNo || prev.requiredBatchNo,
      requiredColor: matched?.color || prev.requiredColor
    }));
  };

  const handleRunMultiMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (multiBusy) return;
    const { payload, error } = buildMultiMaterialPayload(multiForm);
    if (error || !payload) {
      setMultiError(error || '参数无效');
      toast(error || '参数无效', true);
      return;
    }
    setMultiBusy(true);
    setMultiError(null);
    try {
      const data: MultiMaterialPlanResponse = await requestJSON(
        '/api/v2/planning/multi-material',
        payload
      );
      setMultiResult(data);
      toast(
        `联合排产测算完成：料头消化 ${data.placedByRemnants} 件、母卷承接 ${data.placedByRoll} 件（耗时 ${fmtN(
          data.elapsedMs,
          0
        )} ms）`
      );
    } catch (err: any) {
      const msg = err?.message || '联合排产计算失败';
      setMultiError(msg);
      toast(msg, true);
    } finally {
      setMultiBusy(false);
    }
  };

  const handleRunCutPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cutBusy) return;
    const { payload, error } = buildCutPlanPayload(cutForm);
    if (error || !payload) {
      setCutError(error || '分床参数无效');
      toast(error || '分床参数无效', true);
      return;
    }
    setCutBusy(true);
    setCutError(null);
    try {
      const data: CutPlanResponse = await requestJSON('/api/v2/planning/cut-plan', payload);
      setCutResult(data);
      toast(`自动分床完成：共 ${data.layCount} 床 / ${data.totalPlies} 层，计划产出 ${data.totalPlannedGarments} 件`);
    } catch (err: any) {
      const msg = err?.message || '自动分床计算失败';
      setCutError(msg);
      toast(msg, true);
    } finally {
      setCutBusy(false);
    }
  };

  const handleExportCutPlanCsv = () => {
    if (!cutResult) return;
    const csv = buildCutPlanCsvText(cutResult);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `分床配比方案-${cutResult.styleName}-${cutResult.colorName}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出安全转义的分床方案 CSV');
  };

  const handleExportMultiCsv = () => {
    if (!multiResult) return;
    const csv = buildMultiMaterialCsvText(multiResult);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `联合排产方案-${multiResult.materialModel || 'ALL'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出安全转义的联合排产 CSV');
  };

  const handleSendMultiToWorkbench = async (preferredRollId?: string) => {
    if (!multiResult || dispatching) return;
    setDispatching(true);
    try {
      let fam: DemandFamilySummary | null = null;
      if (multiForm.sourceMode === 'TASK' && multiForm.taskId) {
        fam = await requestJSON(
          '/api/v2/demand-pool/' + encodeURIComponent(multiForm.taskId)
        );
      } else {
        const validLines = multiForm.demands.filter(
          (d) => Number(d.width) > 0 && Number(d.length) > 0 && Number(d.quantity) > 0
        );
        if (!validLines.length) {
          toast('没有有效裁片明细可生成需求族', true);
          return;
        }
        fam = await requestJSON('/api/v2/demand-pool', {
          name: `联排转入 · ${multiForm.materialModel.trim() || multiResult.materialModel || '标准面料'}`,
          materialModel: multiForm.materialModel.trim() || multiResult.materialModel || 'STANDARD-MAT',
          externalRef: 'GLOBAL-PLAN-MULTI',
          dimension: 'RECT_2D',
          pieceGapMm: Number(multiForm.pieceGapMm) || 0,
          trimStartMm: Number(multiForm.trimStartMm) || 0,
          requiredBatchNo: multiForm.requiredBatchNo.trim() || undefined,
          requiredColor: multiForm.requiredColor.trim() || undefined,
          demands: validLines.map((d, idx) => ({
            id: idx + 1,
            name: d.name.trim() || `裁片 #${idx + 1}`,
            width: Number(d.width),
            length: Number(d.length),
            quantity: Math.max(1, Math.floor(Number(d.quantity))),
            allowRotation: Boolean(d.allowRotation)
          }))
        });
      }
      if (!fam?.id) throw new Error('未能获取有效需求族');
      loadDemandFamilyIntoWorkbench(fam);
      const targetOpt =
        (preferredRollId
          ? multiResult.rollOptions.find((o) => o.rollId === preferredRollId)
          : null) ||
        multiResult.rollOptions.find((o) => o.recommended) ||
        multiResult.rollOptions.find((o) => o.feasible);
      if (targetOpt?.rollId) {
        setCanvasSpec({
          canvasMode: 'STOCK_ROLL',
          selectedRollId: targetOpt.rollId,
          canvasWidthMm: targetOpt.widthMm || undefined,
          windowStartY2D: null
        });
      }
      toast(
        targetOpt?.rollId
          ? `已生成需求族并绑定推荐母卷 ${targetOpt.rollId}，正在进入工作台…`
          : '已生成待排需求族并转入搭切工作台…'
      );
      location.hash = '#/workbench';
    } catch (err: any) {
      toast('转入工作台失败：' + (err?.message || '未知错误'), true);
    } finally {
      setDispatching(false);
    }
  };

  const handleSendCutPlanToWorkbench = async () => {
    if (!cutResult || dispatching) return;
    const validSizes = (cutResult.sizeAudit || []).filter((s) => s.planned > 0);
    if (!validSizes.length) {
      toast('分床结果没有有效计划件数', true);
      return;
    }
    setDispatching(true);
    try {
      const fabW = Math.max(600, Number(cutForm.fabricWidthMm) || 1650);
      const demands = validSizes.map((s, idx) => {
        const sizeRow = cutForm.sizes.find((x) => x.size === s.size);
        const areaM2 = Math.max(0.2, Number(sizeRow?.unitAreaM2) || Number(cutForm.defaultUnitAreaM2) || 1.25);
        // 按单件耗布面积折算近似矩形排料块，保留尺码与分床计划件数供工作台进一步替换/精排
        const w = Math.min(Math.round(fabW * 0.45), 720);
        const l = Math.max(400, Math.round((areaM2 * 1_000_000) / w));
        return {
          id: idx + 1,
          name: `${cutResult.styleName}-${s.size}码整套`,
          sizeLabel: s.size,
          width: w,
          length: l,
          quantity: s.planned,
          allowRotation: false
        };
      });
      const fam: DemandFamilySummary = await requestJSON('/api/v2/demand-pool', {
        name: `分床转入 · ${cutResult.styleName} (${cutResult.colorName})`,
        materialModel: `${cutResult.styleName}-FABRIC`,
        externalRef: `CUTPLAN-${cutResult.layCount}LAY`,
        dimension: 'RECT_2D',
        requiredColor: cutResult.colorName || undefined,
        demands
      });
      loadDemandFamilyIntoWorkbench(fam);
      setCanvasSpec({
        canvasMode: 'FREE_CANVAS',
        canvasWidthMm: fabW,
        canvasLengthMm: Math.max(2000, Math.round(cutResult.lays?.[0]?.estimatedMarkerLengthMm || 3200))
      });
      toast(`已按分床计划创建需求族（共 ${cutResult.totalPlannedGarments} 件），正在转入工作台…`);
      location.hash = '#/workbench';
    } catch (err: any) {
      toast('分床转入工作台失败：' + (err?.message || '未知错误'), true);
    } finally {
      setDispatching(false);
    }
  };

  const cutRatioSizes = useMemo(() => {
    if (!cutResult) return [] as string[];
    return Array.from(
      new Set([
        ...(cutResult.sizeAudit || []).map((a) => a.size),
        ...(cutResult.lays || []).flatMap((l) => Object.keys(l.ratio || {}))
      ])
    );
  }, [cutResult]);

  const auditSummary = useMemo(
    () => (cutResult ? summarizeSizeAudit(cutResult.sizeAudit) : null),
    [cutResult]
  );

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>联合排产与自动分床</h1>
            <span className="mp-page-summary">
              预览测算工作台 · 仅执行只读方案推演，绝不扣减实物库存或变更订单余量
            </span>
          </div>
          <div className="mp-toolbar-actions">
            <a className="mp-ghost-btn" href="#/workbench">
              返回搭切工作台
            </a>
            <a className="mp-ghost-btn" href="#/cost-analytics">
              成本与备料分析 →
            </a>
          </div>
        </div>

        <div className="mp-filter-toolbar">
          <SegmentedControl<'multi' | 'cutplan'>
            options={tabOptions}
            value={activeTab}
            onChange={(next) => setActiveTab(next)}
            ariaLabel="高级规划功能切换"
          />
          <div className="mp-toolbar-actions">
            {activeTab === 'multi' && multiResult && (
              <>
                <button type="button" className="mp-ghost-btn" onClick={handleExportMultiCsv}>
                  导出联排 CSV
                </button>
                <button
                  type="button"
                  className="btn sm pri"
                  disabled={dispatching}
                  onClick={() => handleSendMultiToWorkbench()}
                >
                  {dispatching ? '生成中…' : '一键转入搭切工作台 →'}
                </button>
              </>
            )}
            {activeTab === 'cutplan' && cutResult && (
              <>
                <button type="button" className="mp-ghost-btn" onClick={handleExportCutPlanCsv}>
                  导出分床 CSV
                </button>
                <button
                  type="button"
                  className="btn sm pri"
                  disabled={dispatching}
                  onClick={handleSendCutPlanToWorkbench}
                >
                  {dispatching ? '生成中…' : '按分床生成需求族并转工作台 →'}
                </button>
              </>
            )}
          </div>
        </div>

        {activeTab === 'multi' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <form className="box" onSubmit={handleRunMultiMaterial}>
              <div className="pane-h">
                <span>多料头接力与多门幅母卷联排参数</span>
                <span className="sub">POST /api/v2/planning/multi-material · 只读预演</span>
              </div>
              <div className="pane-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                  <SegmentedControl
                    size="sm"
                    ariaLabel="需求来源模式"
                    value={multiForm.sourceMode}
                    onChange={(mode) => setMultiForm((p) => ({ ...p, sourceMode: mode }))}
                    options={[
                      { value: 'MANUAL', label: '手工录单试算' },
                      {
                        value: 'TASK',
                        label: '从需求池载入',
                        count: demandTasks.length
                      }
                    ]}
                  />
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      checked={multiForm.preferRemnants}
                      onChange={(e) => setMultiForm((p) => ({ ...p, preferRemnants: e.target.checked }))}
                    />
                    <span>优先接力消耗可用料头</span>
                  </label>
                </div>

                {multiForm.sourceMode === 'TASK' && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span>选择需求池任务</span>
                      <select
                        value={multiForm.taskId}
                        disabled={loadingTasks}
                        onChange={(e) => handleSelectTask(e.target.value)}
                      >
                        <option value="">
                          {loadingTasks ? '正在加载需求池…' : '— 请选择待排任务 —'}
                        </option>
                        {demandTasks.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name || t.id} · {t.materialModel || '未指定品号'}（待排 {t.openTotal ?? t.remainingPieces ?? 0} 件）
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>品号 / 型号过滤</span>
                    <input
                      type="text"
                      placeholder="留空则不限型号"
                      value={multiForm.materialModel}
                      onChange={(e) => setMultiForm((p) => ({ ...p, materialModel: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>同缸号约束</span>
                    <input
                      type="text"
                      placeholder="可选，如 BAT-01"
                      value={multiForm.requiredBatchNo}
                      onChange={(e) => setMultiForm((p) => ({ ...p, requiredBatchNo: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>色号约束</span>
                    <input
                      type="text"
                      placeholder="可选，如 炭灰"
                      value={multiForm.requiredColor}
                      onChange={(e) => setMultiForm((p) => ({ ...p, requiredColor: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>最大料头接力数 (张)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      max={50}
                      value={multiForm.maxRemnants}
                      onChange={(e) => setMultiForm((p) => ({ ...p, maxRemnants: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>片间距 (mm)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      step="any"
                      value={multiForm.pieceGapMm}
                      onChange={(e) => setMultiForm((p) => ({ ...p, pieceGapMm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>起切修边 (mm)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      step="any"
                      value={multiForm.trimStartMm}
                      onChange={(e) => setMultiForm((p) => ({ ...p, trimStartMm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>时间预算 (ms)</span>
                    <input
                      type="number"
                      className="num"
                      min={200}
                      max={60000}
                      step="any"
                      value={multiForm.timeBudgetMs}
                      onChange={(e) => setMultiForm((p) => ({ ...p, timeBudgetMs: Number(e.target.value) }))}
                    />
                  </label>
                </div>

                {multiForm.sourceMode === 'MANUAL' && (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 6
                      }}
                    >
                      <strong style={{ fontSize: 12.5 }}>试算裁片需求清单</strong>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          setMultiForm((p) => ({
                            ...p,
                            demands: [
                              ...p.demands,
                              {
                                id: String(Date.now()),
                                name: `裁片-${p.demands.length + 1}`,
                                width: 500,
                                length: 650,
                                quantity: 4,
                                allowRotation: true
                              }
                            ]
                          }))
                        }
                      >
                        ＋ 新增裁片行
                      </button>
                    </div>
                    <div className="mp-table-scroll">
                      <table className="t">
                        <thead>
                          <tr>
                            <th>裁片名称</th>
                            <th>宽度 (mm)</th>
                            <th>长度 (mm)</th>
                            <th>件数 (件)</th>
                            <th>允许旋转 90°</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {multiForm.demands.map((row, idx) => (
                            <tr key={row.id}>
                              <td>
                                <input
                                  type="text"
                                  value={row.name}
                                  onChange={(e) =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.map((d, i) =>
                                        i === idx ? { ...d, name: e.target.value } : d
                                      )
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  className="num"
                                  min={1}
                                  step="0.1"
                                  value={row.width}
                                  onChange={(e) =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.map((d, i) =>
                                        i === idx ? { ...d, width: Number(e.target.value) } : d
                                      )
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  className="num"
                                  min={1}
                                  step="0.1"
                                  value={row.length}
                                  onChange={(e) =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.map((d, i) =>
                                        i === idx ? { ...d, length: Number(e.target.value) } : d
                                      )
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  className="num"
                                  min={1}
                                  value={row.quantity}
                                  onChange={(e) =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.map((d, i) =>
                                        i === idx ? { ...d, quantity: Number(e.target.value) } : d
                                      )
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={row.allowRotation}
                                  onChange={(e) =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.map((d, i) =>
                                        i === idx ? { ...d, allowRotation: e.target.checked } : d
                                      )
                                    }))
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn sm"
                                  disabled={multiForm.demands.length <= 1}
                                  onClick={() =>
                                    setMultiForm((p) => ({
                                      ...p,
                                      demands: p.demands.filter((_, i) => i !== idx)
                                    }))
                                  }
                                >
                                  删除
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button type="submit" className="btn pri" disabled={multiBusy}>
                    {multiBusy ? '正在推演联合排产…' : '执行联合排产测算'}
                  </button>
                </div>
              </div>
            </form>

            {multiError && (
              <div
                className="box"
                role="alert"
                style={{
                  borderLeft: '3px solid var(--err, #dc2626)',
                  padding: '10px 14px',
                  fontSize: 12.5
                }}
              >
                <strong>联合排产测算异常：</strong> {multiError}
              </div>
            )}

            {multiResult && (
              <>
                <div className="cards" aria-label="联合排产总览指标">
                  <article className="card">
                    <span>需求总件数</span>
                    <strong className="num">{multiResult.totalRequestedPieces} 件</strong>
                  </article>
                  <article className="card">
                    <span>料头接力消化 / 省料</span>
                    <strong className="num">
                      {multiResult.placedByRemnants} 件 · {fmtN(multiResult.totalSavedAreaM2, 2)} m²
                    </strong>
                  </article>
                  <article className="card">
                    <span>母卷承接排入</span>
                    <strong className="num">{multiResult.placedByRoll} 件</strong>
                  </article>
                  <article className="card">
                    <span>未排入缺口 / 耗时</span>
                    <strong
                      className="num"
                      style={{
                        color: multiResult.unplacedPieces > 0 ? 'var(--err, #dc2626)' : 'var(--ok, #059669)'
                      }}
                    >
                      {multiResult.unplacedPieces} 件 · {fmtN(multiResult.elapsedMs, 0)} ms
                    </strong>
                  </article>
                </div>

                {Array.isArray(multiResult.warnings) && multiResult.warnings.length > 0 && (
                  <div
                    className="box"
                    role="status"
                    style={{
                      borderLeft: '3px solid var(--warn, #d97706)',
                      padding: '10px 14px',
                      fontSize: 12.5
                    }}
                  >
                    <strong>排产提醒与约束提示</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                      {multiResult.warnings.map((w, idx) => (
                        <li key={idx}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="box">
                  <div className="pane-h">
                    <span>料头接力消耗明细</span>
                    <span className="sub num">
                      共 {multiResult.remnantAllocations.length} 张可用料头参与接力 · 节省新料{' '}
                      {fmtN(multiResult.totalSavedAreaM2, 3)} m²
                    </span>
                  </div>
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>料头编号</th>
                          <th>规格尺寸 (mm)</th>
                          <th>料头利用率 (%)</th>
                          <th>消化件数 (件)</th>
                          <th>裁片净面积 (m²)</th>
                          <th>分配裁片明细</th>
                        </tr>
                      </thead>
                      <tbody>
                        {multiResult.remnantAllocations.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                              当前过滤条件下未匹配可接力消耗的可用料头，将由下方母卷承接全部裁片。
                            </td>
                          </tr>
                        ) : (
                          multiResult.remnantAllocations.map((rem) => (
                            <tr key={rem.remnantId}>
                              <td>
                                <CodeBadge>{rem.remnantId}</CodeBadge>
                              </td>
                              <td className="num">
                                {fmtN(rem.widthMm, 1)} × {fmtN(rem.lengthMm, 1)} mm
                              </td>
                              <td className="num">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span>{fmtN(rem.utilizationPct, 2)}%</span>
                                  <div
                                    style={{
                                      flex: 1,
                                      minWidth: 54,
                                      height: 6,
                                      borderRadius: 3,
                                      background: 'var(--line-2, #e2e8f0)',
                                      overflow: 'hidden'
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: `${Math.max(0, Math.min(100, Number(rem.utilizationPct) || 0))}%`,
                                        height: '100%',
                                        background: 'var(--ok, #059669)'
                                      }}
                                    />
                                  </div>
                                </div>
                              </td>
                              <td className="num">{rem.placedCount} 件</td>
                              <td className="num">{fmtN(rem.piecesAreaM2, 3)} m²</td>
                              <td>{formatAllocatedItems(rem.allocatedItems)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="box">
                  <div className="pane-h">
                    <span>多门幅母卷候选对比与推荐</span>
                    <span className="sub num">共评估 {multiResult.rollOptions.length} 卷母卷</span>
                  </div>
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>母卷编号</th>
                          <th>门幅 (mm)</th>
                          <th>可用余长 (mm)</th>
                          <th>预计切长 (mm)</th>
                          <th>预计利用率 (%)</th>
                          <th>可排件数 (件)</th>
                          <th>评估结论</th>
                          <th style={{ textAlign: 'right' }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {multiResult.rollOptions.length === 0 ? (
                          <tr>
                            <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 16 }}>
                              当前品号/缸号条件下无可承接母卷，请前往「成本与备料分析」核对采购缺口。
                            </td>
                          </tr>
                        ) : (
                          multiResult.rollOptions.map((opt) => {
                            const statusLabel = opt.recommended
                              ? '推荐首选'
                              : opt.feasible
                              ? '可行备选'
                              : '长度或门幅不足';
                            const tagCls = opt.recommended ? 'ok' : opt.feasible ? 'run' : 'err';
                            return (
                              <tr key={opt.rollId}>
                                <td>
                                  <CodeBadge>{opt.rollId}</CodeBadge>
                                </td>
                                <td className="num">{fmtN(opt.widthMm, 1)} mm</td>
                                <td className="num">{fmtN(opt.availableLengthMm, 1)} mm</td>
                                <td className="num">{fmtN(opt.estimatedCutLengthMm, 1)} mm</td>
                                <td className="num">{fmtN(opt.utilizationPct, 2)}%</td>
                                <td className="num">{opt.placedCount} 件</td>
                                <td>
                                  <span className={`tag ${tagCls}`}>{statusLabel}</span>
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <button
                                    type="button"
                                    className={`btn sm ${opt.recommended ? 'soft-accent' : ''}`}
                                    disabled={dispatching || !opt.feasible}
                                    onClick={() => handleSendMultiToWorkbench(opt.rollId)}
                                  >
                                    选此卷去排料 →
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <form className="box" onSubmit={handleRunCutPlan}>
              <div className="pane-h">
                <span>服装大货订单自动分床与尺码配比配置</span>
                <span className="sub">POST /api/v2/planning/cut-plan · 尺码守恒核对</span>
              </div>
              <div className="pane-b" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>款号</span>
                    <input
                      type="text"
                      value={cutForm.styleName}
                      onChange={(e) => setCutForm((p) => ({ ...p, styleName: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>颜色</span>
                    <input
                      type="text"
                      value={cutForm.colorName}
                      onChange={(e) => setCutForm((p) => ({ ...p, colorName: e.target.value }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>有效门幅 (mm)</span>
                    <input
                      type="number"
                      className="num"
                      min={300}
                      step="1"
                      value={cutForm.fabricWidthMm}
                      onChange={(e) => setCutForm((p) => ({ ...p, fabricWidthMm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>单床最大层数 (层)</span>
                    <input
                      type="number"
                      className="num"
                      min={1}
                      value={cutForm.maxPliesPerLay}
                      onChange={(e) => setCutForm((p) => ({ ...p, maxPliesPerLay: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>单唛最大件数 (件)</span>
                    <input
                      type="number"
                      className="num"
                      min={1}
                      value={cutForm.maxGarmentsPerMarker}
                      onChange={(e) =>
                        setCutForm((p) => ({ ...p, maxGarmentsPerMarker: Number(e.target.value) }))
                      }
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>最大裁床床长 (mm)</span>
                    <input
                      type="number"
                      className="num"
                      min={500}
                      value={cutForm.maxLayLengthMm}
                      onChange={(e) => setCutForm((p) => ({ ...p, maxLayLengthMm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>床头尾损耗 (mm)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      value={cutForm.endAllowanceMm}
                      onChange={(e) => setCutForm((p) => ({ ...p, endAllowanceMm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>面料克重 (g/m²)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      value={cutForm.grammageGsm}
                      onChange={(e) => setCutForm((p) => ({ ...p, grammageGsm: Number(e.target.value) }))}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>目标利用率 (%)</span>
                    <input
                      type="number"
                      className="num"
                      min={30}
                      max={99}
                      step="any"
                      value={cutForm.targetUtilizationPct}
                      onChange={(e) =>
                        setCutForm((p) => ({ ...p, targetUtilizationPct: Number(e.target.value) }))
                      }
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                    <span>允许超裁上限 (%)</span>
                    <input
                      type="number"
                      className="num"
                      min={0}
                      max={20}
                      step="any"
                      value={cutForm.allowOvercutPct}
                      onChange={(e) =>
                        setCutForm((p) => ({ ...p, allowOvercutPct: Number(e.target.value) }))
                      }
                    />
                  </label>
                </div>

                <div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 6
                    }}
                  >
                    <strong style={{ fontSize: 12.5 }}>
                      尺码订单矩阵（合计{' '}
                      <span className="num">
                        {cutForm.sizes.reduce((s, r) => s + (Math.max(0, Math.floor(Number(r.quantity) || 0))), 0)}
                      </span>{' '}
                      件）
                    </strong>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          setCutForm((p) => ({
                            ...p,
                            sizes: DEFAULT_GARMENT_SIZES.map((s) => ({ ...s }))
                          }))
                        }
                      >
                        重置 S~2XL 经典配比
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          setCutForm((p) => ({
                            ...p,
                            sizes: [...p.sizes, { size: '3XL', quantity: 20, unitAreaM2: 1.62 }]
                          }))
                        }
                      >
                        ＋ 添加尺码
                      </button>
                    </div>
                  </div>
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>尺码</th>
                          <th>订单件数 (件)</th>
                          <th>单件净面积参考 (m²/件)</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cutForm.sizes.map((row, idx) => (
                          <tr key={`${row.size}-${idx}`}>
                            <td>
                              <input
                                type="text"
                                value={row.size}
                                onChange={(e) =>
                                  setCutForm((p) => ({
                                    ...p,
                                    sizes: p.sizes.map((s, i) =>
                                      i === idx ? { ...s, size: e.target.value } : s
                                    )
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                className="num"
                                min={0}
                                value={row.quantity}
                                onChange={(e) =>
                                  setCutForm((p) => ({
                                    ...p,
                                    sizes: p.sizes.map((s, i) =>
                                      i === idx ? { ...s, quantity: Number(e.target.value) } : s
                                    )
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                className="num"
                                min={0.1}
                                step="0.01"
                                value={row.unitAreaM2}
                                onChange={(e) =>
                                  setCutForm((p) => ({
                                    ...p,
                                    sizes: p.sizes.map((s, i) =>
                                      i === idx ? { ...s, unitAreaM2: Number(e.target.value) } : s
                                    )
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <button
                                type="button"
                                className="btn sm"
                                disabled={cutForm.sizes.length <= 1}
                                onClick={() =>
                                  setCutForm((p) => ({
                                    ...p,
                                    sizes: p.sizes.filter((_, i) => i !== idx)
                                  }))
                                }
                              >
                                移除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button type="submit" className="btn pri" disabled={cutBusy}>
                    {cutBusy ? '正在生成分床方案…' : '生成最优分床方案'}
                  </button>
                </div>
              </div>
            </form>

            {cutError && (
              <div
                className="box"
                role="alert"
                style={{
                  borderLeft: '3px solid var(--err, #dc2626)',
                  padding: '10px 14px',
                  fontSize: 12.5
                }}
              >
                <strong>自动分床异常：</strong> {cutError}
              </div>
            )}

            {cutResult && (
              <>
                <div className="cards" aria-label="分床总览指标">
                  <article className="card">
                    <span>计划产出 / 订单总量</span>
                    <strong className="num">
                      {cutResult.totalPlannedGarments} / {cutResult.totalOrderedGarments} 件
                    </strong>
                  </article>
                  <article className="card">
                    <span>总床数 / 铺布总层数</span>
                    <strong className="num">
                      {cutResult.layCount} 床 · {cutResult.totalPlies} 层
                    </strong>
                  </article>
                  <article className="card">
                    <span>预计耗布总长 / 面积</span>
                    <strong className="num">
                      {fmtN(cutResult.totalFabricLengthM, 2)} m · {fmtN(cutResult.totalFabricAreaM2, 2)} m²
                    </strong>
                  </article>
                  <article className="card">
                    <span>预估布重 / 平均效率</span>
                    <strong className="num">
                      {fmtN(cutResult.estimatedWeightKg, 2)} kg · {fmtN(cutResult.averageEfficiencyPct, 2)}%
                    </strong>
                  </article>
                </div>

                <div className="box">
                  <div className="pane-h">
                    <span>分床配比执行表（{cutResult.styleName} · {cutResult.colorName}）</span>
                    <span className="sub num">超裁 {cutResult.overcutGarments} 件</span>
                  </div>
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>床次</th>
                          <th>铺布层数 (层)</th>
                          {cutRatioSizes.map((sz) => (
                            <th key={sz}>{sz} 配比</th>
                          ))}
                          <th>单唛件数 (件)</th>
                          <th>本床产出 (件)</th>
                          <th>预估唛架长 (mm)</th>
                          <th>耗布长 (m)</th>
                          <th>耗布面积 (m²)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cutResult.lays.map((lay) => (
                          <tr key={lay.layNo}>
                            <td>
                              <CodeBadge>第 {lay.layNo} 床</CodeBadge>
                            </td>
                            <td className="num">{lay.plies} 层</td>
                            {cutRatioSizes.map((sz) => (
                              <td key={sz} className="num">
                                {lay.ratio?.[sz] ? <strong>{lay.ratio[sz]}</strong> : <span className="muted">0</span>}
                              </td>
                            ))}
                            <td className="num">{lay.garmentsPerMarker} 件</td>
                            <td className="num">{lay.layGarments} 件</td>
                            <td className="num">{fmtN(lay.estimatedMarkerLengthMm, 1)} mm</td>
                            <td className="num">{fmtN(lay.fabricLengthM, 2)} m</td>
                            <td className="num">{fmtN(lay.fabricAreaM2, 2)} m²</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="box">
                  <div className="pane-h">
                    <span>尺码守恒核对表</span>
                    <span className="sub">
                      {auditSummary?.balanced
                        ? `全部尺码无欠裁（精准守恒 ${auditSummary.exactCount} 项，超裁合计 +${auditSummary.overcutTotal} 件）`
                        : `存在短缺 -${auditSummary?.shortageTotal ?? 0} 件，请放宽层数或单唛件数重算`}
                    </span>
                  </div>
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>尺码</th>
                          <th>订单需求 (件)</th>
                          <th>分床计划 (件)</th>
                          <th>偏差 (件)</th>
                          <th>守恒核对结论</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cutResult.sizeAudit.map((row) => {
                          const cls = row.delta === 0 ? 'ok' : row.delta > 0 ? 'warn' : 'err';
                          const text =
                            row.delta === 0
                              ? '精准守恒'
                              : row.delta > 0
                              ? `允许超裁 (+${row.delta})`
                              : `存在短缺 (${row.delta})`;
                          return (
                            <tr key={row.size}>
                              <td>
                                <CodeBadge>{row.size}</CodeBadge>
                              </td>
                              <td className="num">{row.ordered} 件</td>
                              <td className="num">{row.planned} 件</td>
                              <td className="num">{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                              <td>
                                <span className={`tag ${cls}`}>{text}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
