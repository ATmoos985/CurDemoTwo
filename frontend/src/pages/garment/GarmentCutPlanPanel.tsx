import React, { useMemo, useRef, useState } from 'react';
import { NumberInput } from '../../components/ui/NumberInput';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { fmtN, requestJSON, toast } from '../../lib/core/util.js';
import { DemandFamilySummary, useStudioStore } from '../../store/useStudioStore';
import {
  CUT_PLAN_PRESETS,
  CutPlanFormState,
  CutPlanResponse,
  DEFAULT_GARMENT_SIZES,
  buildCutPlanCsvText,
  buildCutPlanDemandPoolPayload,
  buildCutPlanPayload,
  cloneCutPlanForm,
  cloneCutPlanSizes,
  createDefaultCutPlanForm,
  extractCutPlanSizeKeys,
  suggestNextSizeRow,
  summarizeSizeAudit,
  totalCutPlanOrderedQty
} from './cutPlanUtils';
import './garment-cutplan.css';

export interface GarmentCutPlanPanelProps {
  form?: CutPlanFormState;
  onFormChange?: React.Dispatch<React.SetStateAction<CutPlanFormState>>;
  result?: CutPlanResponse | null;
  onResultChange?: React.Dispatch<React.SetStateAction<CutPlanResponse | null>>;
  error?: string | null;
  onErrorChange?: React.Dispatch<React.SetStateAction<string | null>>;
}

export const GarmentCutPlanPanel: React.FC<GarmentCutPlanPanelProps> = ({
  form: controlledForm,
  onFormChange,
  result: controlledResult,
  onResultChange,
  error: controlledError,
  onErrorChange
}) => {
  const [internalForm, setInternalForm] = useState<CutPlanFormState>(() =>
    createDefaultCutPlanForm()
  );
  const [internalResult, setInternalResult] = useState<CutPlanResponse | null>(null);
  const [internalError, setInternalError] = useState<string | null>(null);

  const form = controlledForm ?? internalForm;
  const setForm = onFormChange ?? setInternalForm;
  const result = controlledResult !== undefined ? controlledResult : internalResult;
  const setResult = onResultChange ?? setInternalResult;
  const error = controlledError !== undefined ? controlledError : internalError;
  const setError = onErrorChange ?? setInternalError;

  const [activePresetId, setActivePresetId] = useState<string>('hoodie-standard');
  const [busy, setBusy] = useState<boolean>(false);
  const [dispatching, setDispatching] = useState<boolean>(false);

  const helpRef = useRef<HTMLDetailsElement | null>(null);
  const styleInputRef = useRef<HTMLInputElement | null>(null);

  const loadDemandFamilyIntoWorkbench = useStudioStore(
    (s) => s.loadDemandFamilyIntoWorkbench
  );
  const setCanvasSpec = useStudioStore((s) => s.setCanvasSpec);

  const totalOrderedInput = useMemo(
    () => totalCutPlanOrderedQty(form.sizes),
    [form.sizes]
  );

  const activeSizeCount = useMemo(
    () =>
      form.sizes.filter(
        (r) => r.size.trim() !== '' && Math.floor(Number(r.quantity) || 0) > 0
      ).length,
    [form.sizes]
  );

  const ratioSizes = useMemo(
    () => (result ? extractCutPlanSizeKeys(result) : []),
    [result]
  );

  const auditSummary = useMemo(
    () => (result ? summarizeSizeAudit(result.sizeAudit) : null),
    [result]
  );

  const sizeTotalByKey = useMemo(() => {
    const totals: Record<string, number> = {};
    if (!result) return totals;
    for (const sz of ratioSizes) {
      totals[sz] = result.lays.reduce(
        (sum, lay) => sum + lay.plies * (lay.ratio?.[sz] ?? 0),
        0
      );
    }
    return totals;
  }, [result, ratioSizes]);

  const updateForm = (updater: (prev: CutPlanFormState) => CutPlanFormState) => {
    setActivePresetId('');
    setForm(updater);
  };

  const applyPreset = (presetId: string) => {
    const preset = CUT_PLAN_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setActivePresetId(preset.id);
    setForm(cloneCutPlanForm(preset.form));
    setError(null);
    setResult(null);
  };

  const runCutPlan = async () => {
    if (busy) return;
    const { payload, error: validationError } = buildCutPlanPayload(form);
    if (validationError || !payload) {
      setError(validationError || '分床参数无效');
      toast(validationError || '分床参数无效', true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data: CutPlanResponse = await requestJSON(
        '/api/v2/planning/cut-plan',
        payload
      );
      setResult(data);
      toast(
        `分床方案已生成：共 ${data.layCount} 床 / ${data.totalPlies} 层，计划产出 ${data.totalPlannedGarments} 件`
      );
    } catch (err: any) {
      const msg = err?.message || '自动分床计算失败';
      setError(msg);
      toast(msg, true);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runCutPlan();
  };

  const handleExportCsv = () => {
    if (!result) return;
    const csv = buildCutPlanCsvText(result);
    const url = URL.createObjectURL(
      new Blob([csv], { type: 'text/csv;charset=utf-8' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `分床配比方案-${result.styleName}-${result.colorName}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出分床方案 CSV');
  };

  const handleSendToWorkbench = async () => {
    if (!result || dispatching) return;
    const built = buildCutPlanDemandPoolPayload(result, form);
    if (built.error || !built.payload) {
      toast(built.error || '分床结果没有有效计划件数', true);
      return;
    }
    setDispatching(true);
    try {
      const fam: DemandFamilySummary = await requestJSON(
        '/api/v2/demand-pool',
        built.payload
      );
      loadDemandFamilyIntoWorkbench(fam);
      setCanvasSpec({
        canvasMode: 'FREE_CANVAS',
        canvasWidthMm: built.canvasWidthMm,
        canvasLengthMm: built.canvasLengthMm
      });
      toast(
        `已生成待排需求族（共 ${result.totalPlannedGarments} 件），正在进入搭切工作台…`
      );
      location.hash = '#/workbench';
    } catch (err: any) {
      toast('转入工作台失败：' + (err?.message || '未知错误'), true);
    } finally {
      setDispatching(false);
    }
  };

  const statusText = useMemo(() => {
    if (busy) return '正在计算最优多床配比与铺布层数…';
    if (error) return `分床测算受阻 · ${error}`;
    if (result) {
      const overcutNote =
        result.overcutGarments > 0
          ? `超裁 +${result.overcutGarments} 件`
          : '零超裁精准守恒';
      return `分床完成 · 共 ${result.layCount} 床 / ${result.totalPlies} 层 · 计划产出 ${result.totalPlannedGarments} 件（${overcutNote}）`;
    }
    return `待测算 · 已录入 ${activeSizeCount} 个有效尺码共 ${totalOrderedInput} 件（只读方案推演，不扣减库存）`;
  }, [busy, error, result, activeSizeCount, totalOrderedInput]);

  return (
    <div className="mp-cutplan-root">
      <div className="split garment-split mp-garment-split mp-cutplan-split">
        <section className="pane mp-float-card mp-garment-left mp-cutplan-left">
          <div className="pane-b">
            <details
              ref={helpRef}
              className="mp-cutplan-help"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && helpRef.current?.open) {
                  e.preventDefault();
                  helpRef.current.open = false;
                  helpRef.current.querySelector('summary')?.focus();
                }
              }}
            >
              <summary className="pane-h" role="button" aria-label="分床规则说明">
                分床参数配置
                <span className="help-mark" aria-hidden="true">
                  ?
                </span>
              </summary>
              <div className="mp-cutplan-help-text">
                <p>
                  自动分床仅执行只读工艺测算，不会扣减库存或改写现有订单余量。
                </p>
                <p>
                  引擎在满足单床最大层数、单唛最大件数与裁床台长约束下，优先压缩换版床数，并严格守恒各尺码订单件数。
                </p>
                <p>
                  允许超裁上限设为 0% 时执行零超裁精准配比；单件净面积用于按有效门幅与目标利用率折算每床预估唛架长度。
                </p>
              </div>
            </details>

            <div
              className="style-pills mp-style-pills mp-cutplan-pills"
              aria-label="快捷分床订单预设"
            >
              {CUT_PLAN_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`style-pill ${activePresetId === preset.id ? 'on' : ''}`}
                  disabled={busy}
                  onClick={() => applyPreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <form
              id="cutplan-form"
              className="mp-cutplan-form"
              onSubmit={handleSubmit}
            >
              <div className="mp-cutplan-section-title">
                <span>款式与裁床约束</span>
                <span className="mp-cutplan-section-sub">单位：mm / 层 / 件</span>
              </div>

              <div className="mp-cutplan-grid">
                <label className="mp-cutplan-field">
                  <span>款号</span>
                  <input
                    ref={styleInputRef}
                    type="text"
                    className="field"
                    disabled={busy}
                    value={form.styleName}
                    placeholder="如 FZ-2026-HOODIE"
                    onChange={(e) =>
                      updateForm((p) => ({ ...p, styleName: e.target.value }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>颜色</span>
                  <input
                    type="text"
                    className="field"
                    disabled={busy}
                    value={form.colorName}
                    placeholder="如 炭灰"
                    onChange={(e) =>
                      updateForm((p) => ({ ...p, colorName: e.target.value }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>有效门幅（mm）</span>
                  <NumberInput
                    className="field num"
                    min={300}
                    max={5000}
                    fallback={1650}
                    disabled={busy}
                    value={form.fabricWidthMm}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, fabricWidthMm: v }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>单床最大层数（层）</span>
                  <NumberInput
                    className="field num"
                    min={1}
                    max={10000}
                    fallback={60}
                    integer
                    disabled={busy}
                    value={form.maxPliesPerLay}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, maxPliesPerLay: v }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>单唛最大件数（件）</span>
                  <NumberInput
                    className="field num"
                    min={1}
                    max={100}
                    fallback={8}
                    integer
                    disabled={busy}
                    value={form.maxGarmentsPerMarker}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, maxGarmentsPerMarker: v }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>最大裁床床长（mm）</span>
                  <NumberInput
                    className="field num"
                    min={0}
                    max={50000}
                    fallback={10000}
                    disabled={busy}
                    value={form.maxLayLengthMm}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, maxLayLengthMm: v }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>床头尾损耗（mm）</span>
                  <NumberInput
                    className="field num"
                    min={0}
                    max={2000}
                    fallback={60}
                    disabled={busy}
                    value={form.endAllowanceMm}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, endAllowanceMm: v }))
                    }
                  />
                </label>

                <label className="mp-cutplan-field">
                  <span>面料克重（g/m²）</span>
                  <NumberInput
                    className="field num"
                    min={0}
                    max={2000}
                    fallback={280}
                    disabled={busy}
                    value={form.grammageGsm}
                    onValueChange={(v) =>
                      updateForm((p) => ({ ...p, grammageGsm: v }))
                    }
                  />
                </label>
              </div>

              <details className="mp-cutplan-advanced">
                <summary>核算与超裁参数</summary>
                <div className="mp-cutplan-advanced-body">
                  <div className="mp-cutplan-grid">
                    <label className="mp-cutplan-field">
                      <span>目标利用率（%）</span>
                      <NumberInput
                        className="field num"
                        min={11}
                        max={100}
                        fallback={84}
                        disabled={busy}
                        value={form.targetUtilizationPct}
                        onValueChange={(v) =>
                          updateForm((p) => ({ ...p, targetUtilizationPct: v }))
                        }
                      />
                    </label>

                    <label className="mp-cutplan-field">
                      <span>允许超裁上限（%）</span>
                      <NumberInput
                        className="field num"
                        min={0}
                        max={50}
                        fallback={0}
                        disabled={busy}
                        value={form.allowOvercutPct}
                        onValueChange={(v) =>
                          updateForm((p) => ({ ...p, allowOvercutPct: v }))
                        }
                      />
                    </label>

                    <label className="mp-cutplan-field">
                      <span>默认单件面积（m²）</span>
                      <NumberInput
                        className="field num"
                        min={0.1}
                        max={20}
                        fallback={1.32}
                        disabled={busy}
                        value={form.defaultUnitAreaM2}
                        onValueChange={(v) =>
                          updateForm((p) => ({ ...p, defaultUnitAreaM2: v }))
                        }
                      />
                    </label>
                  </div>
                </div>
              </details>

              <div className="mp-cutplan-sizes-block">
                <div className="mp-cutplan-section-title">
                  <span>
                    尺码订单矩阵（合计{' '}
                    <span className="num">{fmtN(totalOrderedInput)}</span> 件）
                  </span>
                  <div className="mp-cutplan-size-actions">
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        updateForm((p) => ({
                          ...p,
                          sizes: cloneCutPlanSizes(DEFAULT_GARMENT_SIZES)
                        }))
                      }
                    >
                      重置
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        updateForm((p) => ({
                          ...p,
                          sizes: [...p.sizes, suggestNextSizeRow(p.sizes)]
                        }))
                      }
                    >
                      ＋ 尺码
                    </button>
                  </div>
                </div>

                <div className="mp-cutplan-size-table-wrap">
                  <div className="mp-cutplan-size-head">
                    <span>尺码</span>
                    <span>订单（件）</span>
                    <span>单件（m²）</span>
                    <span aria-hidden="true" />
                  </div>
                  {form.sizes.map((row, idx) => (
                    <div key={`size-row-${idx}`} className="mp-cutplan-size-row">
                      <input
                        type="text"
                        className="field"
                        aria-label={`第 ${idx + 1} 行尺码`}
                        disabled={busy}
                        value={row.size}
                        onChange={(e) =>
                          updateForm((p) => ({
                            ...p,
                            sizes: p.sizes.map((s, i) =>
                              i === idx ? { ...s, size: e.target.value } : s
                            )
                          }))
                        }
                      />
                      <NumberInput
                        className="field num"
                        aria-label={`${row.size || `第${idx + 1}行`}订单件数`}
                        min={0}
                        max={100000}
                        fallback={0}
                        integer
                        disabled={busy}
                        value={row.quantity}
                        onValueChange={(v) =>
                          updateForm((p) => ({
                            ...p,
                            sizes: p.sizes.map((s, i) =>
                              i === idx ? { ...s, quantity: v } : s
                            )
                          }))
                        }
                      />
                      <NumberInput
                        className="field num"
                        aria-label={`${row.size || `第${idx + 1}行`}单件净面积`}
                        min={0.1}
                        max={20}
                        fallback={form.defaultUnitAreaM2 || 1.32}
                        disabled={busy}
                        value={row.unitAreaM2}
                        onValueChange={(v) =>
                          updateForm((p) => ({
                            ...p,
                            sizes: p.sizes.map((s, i) =>
                              i === idx ? { ...s, unitAreaM2: v } : s
                            )
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="mp-cutplan-row-del"
                        title="移除该尺码"
                        aria-label={`移除尺码 ${row.size || idx + 1}`}
                        disabled={busy || form.sizes.length <= 1}
                        onClick={() =>
                          updateForm((p) => ({
                            ...p,
                            sizes: p.sizes.filter((_, i) => i !== idx)
                          }))
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </form>
          </div>
        </section>

        <div className="mp-garment-right mp-cutplan-right">
          {error && (
            <section className="mp-cutplan-alert" role="alert">
              <div className="mp-cutplan-alert-body">
                <strong>分床测算失败</strong>
                <p>{error}</p>
              </div>
              <div className="mp-cutplan-alert-actions">
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => styleInputRef.current?.focus()}
                >
                  检查参数
                </button>
                <button
                  type="button"
                  className="btn sm soft-accent"
                  disabled={busy}
                  onClick={() => void runCutPlan()}
                >
                  重新测算
                </button>
              </div>
            </section>
          )}

          <section className="mp-float-card mp-cutplan-overview-card">
            <div
              className="garment-kpis mp-garment-kpis mp-cutplan-kpis"
              aria-label="分床总览指标"
            >
              <div className="metric garment-metric">
                <div>
                  <small>总床数 / 铺布总层数</small>
                  <b>
                    {result ? fmtN(result.layCount) : '—'}
                    <em>
                      {result ? `床 · ${fmtN(result.totalPlies)} 层` : '床'}
                    </em>
                  </b>
                </div>
                <div>
                  <small>计划产出 / 订单总量</small>
                  <b>
                    {result ? fmtN(result.totalPlannedGarments) : fmtN(totalOrderedInput)}
                    <em>
                      {result
                        ? `/ ${fmtN(result.totalOrderedGarments)} 件`
                        : '件（待算）'}
                    </em>
                  </b>
                </div>
                <div>
                  <small>预计耗布长 / 面积</small>
                  <b>
                    {result ? fmtN(result.totalFabricLengthM, 2) : '—'}
                    <em>
                      {result
                        ? `m · ${fmtN(result.totalFabricAreaM2, 2)} m²`
                        : 'm'}
                    </em>
                  </b>
                </div>
                <div>
                  <small>预估布重 / 平均效率</small>
                  <b>
                    {result
                      ? result.estimatedWeightKg > 0
                        ? fmtN(result.estimatedWeightKg, 2)
                        : '—'
                      : '—'}
                    <em>
                      {result
                        ? `${result.estimatedWeightKg > 0 ? 'kg · ' : ''}${fmtN(
                            result.averageEfficiencyPct,
                            2
                          )}%`
                        : '%'}
                    </em>
                  </b>
                </div>
              </div>
            </div>

            {result && auditSummary && (
              <div className="mp-cutplan-audit-strip" aria-label="尺码守恒核对条">
                <div className="mp-cutplan-audit-lead">
                  <span
                    className={`tag ${
                      !auditSummary.balanced
                        ? 'err'
                        : auditSummary.overcutTotal > 0
                        ? 'warn'
                        : 'ok'
                    }`}
                  >
                    {!auditSummary.balanced
                      ? `存在短缺 -${auditSummary.shortageTotal} 件`
                      : auditSummary.overcutTotal > 0
                      ? `守恒达标 · 超裁 +${auditSummary.overcutTotal} 件`
                      : '全部尺码精准守恒'}
                  </span>
                  <span>
                    精准 {auditSummary.exactCount} 码 · 超裁 {auditSummary.overcutCount} 码
                    {auditSummary.shortageCount > 0
                      ? ` · 短缺 ${auditSummary.shortageCount} 码`
                      : ''}
                  </span>
                </div>
                <div className="mp-cutplan-audit-chips">
                  {result.sizeAudit.map((item) => {
                    const tone =
                      item.delta === 0 ? 'ok' : item.delta > 0 ? 'warn' : 'err';
                    return (
                      <span
                        key={item.size}
                        className={`mp-cutplan-audit-chip is-${tone} num`}
                      >
                        <strong>{item.size}</strong>
                        <span>
                          {item.planned}/{item.ordered}
                        </span>
                        <span className={`mp-cutplan-audit-delta ${tone}`}>
                          {item.delta === 0
                            ? '精准'
                            : item.delta > 0
                            ? `+${item.delta}`
                            : String(item.delta)}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {!result ? (
            <section className="mp-float-card mp-cutplan-empty">
              <div className="mp-cutplan-empty-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 20 20"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="2.5" y="3.5" width="15" height="4" rx="1" />
                  <rect x="2.5" y="9.5" width="15" height="3.5" rx="1" />
                  <rect x="2.5" y="15" width="10" height="2.5" rx="1" />
                  <line x1="8" y1="3.5" x2="8" y2="7.5" />
                  <line x1="12.5" y1="3.5" x2="12.5" y2="7.5" />
                  <line x1="9.5" y1="9.5" x2="9.5" y2="13" />
                </svg>
              </div>
              <strong>准备就绪：点击右下角「生成分床方案」</strong>
              <p>
                系统将依据左侧款号、有效门幅、最大铺布层数与尺码矩阵，自动规划最少床数与最优整层配比，并逐码核对订单守恒。
              </p>
              <div className="mp-cutplan-empty-meta">
                <CodeBadge>{form.styleName.trim() || '未填款号'}</CodeBadge>
                <CodeBadge>{form.colorName.trim() || '未填颜色'}</CodeBadge>
                <CodeBadge>{`门幅 ${fmtN(form.fabricWidthMm)} mm`}</CodeBadge>
                <CodeBadge>{`${activeSizeCount} 尺码 · ${fmtN(totalOrderedInput)} 件`}</CodeBadge>
              </div>
            </section>
          ) : (
            <>
              <section className="mp-float-card mp-cutplan-table-card">
                <div className="pane-h">
                  <span>
                    分床配比明细（{result.styleName} · {result.colorName}）
                  </span>
                  <span className="sub num">
                    共 {result.layCount} 床 · 门幅 {fmtN(form.fabricWidthMm)} mm
                  </span>
                  <div className="mp-cutplan-card-actions">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={handleExportCsv}
                    >
                      导出分床 CSV
                    </button>
                    <button
                      type="button"
                      className="btn sm soft-accent"
                      disabled={dispatching}
                      onClick={() => void handleSendToWorkbench()}
                    >
                      {dispatching ? '生成中…' : '生成待排需求族并转工作台 →'}
                    </button>
                  </div>
                </div>

                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>床次</th>
                        <th>铺布层数（层）</th>
                        {ratioSizes.map((sz) => (
                          <th key={sz}>{sz} 配比</th>
                        ))}
                        <th>单唛件数（件）</th>
                        <th>本床产出（件）</th>
                        <th>预估唛架长（mm）</th>
                        <th>耗布长（m）</th>
                        <th>耗布面积（m²）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.lays.map((lay) => (
                        <tr key={lay.layNo}>
                          <td>
                            <CodeBadge>第 {lay.layNo} 床</CodeBadge>
                          </td>
                          <td className="num">{fmtN(lay.plies)} 层</td>
                          {ratioSizes.map((sz) => {
                            const count = lay.ratio?.[sz] ?? 0;
                            return (
                              <td key={sz} className="num">
                                {count > 0 ? (
                                  <span className="mp-cutplan-ratio-hit">{count}</span>
                                ) : (
                                  <span className="muted">0</span>
                                )}
                              </td>
                            );
                          })}
                          <td className="num">{fmtN(lay.garmentsPerMarker)} 件</td>
                          <td className="num">{fmtN(lay.layGarments)} 件</td>
                          <td className="num">
                            {fmtN(lay.estimatedMarkerLengthMm, 1)} mm
                          </td>
                          <td className="num">{fmtN(lay.fabricLengthM, 2)} m</td>
                          <td className="num">{fmtN(lay.fabricAreaM2, 2)} m²</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>合计</td>
                        <td className="num">{fmtN(result.totalPlies)} 层</td>
                        {ratioSizes.map((sz) => (
                          <td key={sz} className="num">
                            {fmtN(sizeTotalByKey[sz] ?? 0)} 件
                          </td>
                        ))}
                        <td className="num">—</td>
                        <td className="num">
                          {fmtN(result.totalPlannedGarments)} 件
                        </td>
                        <td className="num">—</td>
                        <td className="num">
                          {fmtN(result.totalFabricLengthM, 2)} m
                        </td>
                        <td className="num">
                          {fmtN(result.totalFabricAreaM2, 2)} m²
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              <section className="mp-float-card mp-cutplan-table-card">
                <div className="pane-h">
                  <span>尺码守恒核对明细</span>
                  <span className="sub">
                    {auditSummary?.balanced
                      ? `无欠裁 · 精准守恒 ${auditSummary.exactCount} 项 · 超裁合计 +${auditSummary.overcutTotal} 件`
                      : `存在短缺 -${auditSummary?.shortageTotal ?? 0} 件，请适当放宽单床层数或单唛件数后重算`}
                  </span>
                </div>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>尺码</th>
                        <th>订单需求（件）</th>
                        <th>分床计划（件）</th>
                        <th>偏差（件）</th>
                        <th>守恒核对结论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.sizeAudit.map((row) => {
                        const cls =
                          row.delta === 0 ? 'ok' : row.delta > 0 ? 'warn' : 'err';
                        const label =
                          row.delta === 0
                            ? '精准守恒'
                            : row.delta > 0
                            ? `允许超裁 (+${row.delta} 件)`
                            : `存在短缺 (${row.delta} 件)`;
                        return (
                          <tr key={row.size}>
                            <td>
                              <CodeBadge>{row.size}</CodeBadge>
                            </td>
                            <td className="num">{fmtN(row.ordered)} 件</td>
                            <td className="num">{fmtN(row.planned)} 件</td>
                            <td className="num">
                              {row.delta > 0 ? `+${row.delta}` : row.delta}
                            </td>
                            <td>
                              <span className={`tag ${cls}`}>{label}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <div className="foot mp-action-foot">
        <span role="status" className="mp-status-text">
          {statusText}
        </span>
        <span className="sp" />
        {result && (
          <button type="button" className="btn" onClick={handleExportCsv}>
            导出分床 CSV
          </button>
        )}
        <button
          className="btn pri"
          type="submit"
          form="cutplan-form"
          disabled={busy}
        >
          {busy ? '正在生成分床方案…' : '生成分床方案'}
        </button>
      </div>
    </div>
  );
};
