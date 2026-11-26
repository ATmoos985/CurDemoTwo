import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { requestJSON, fmtN, toast } from '../lib/core/util.js';
import { csvCell } from '../lib/domain/report-model.js';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';

export interface CostSummaryTotals {
  totalReports: number;
  totalConsumedAreaM2: number;
  netGoodAreaM2: number;
  recoveredRemnantAreaM2: number;
  wasteAreaM2: number;
  totalMaterialCost: number;
  recoveredResidualValue: number;
  netEffectiveCost: number;
  wasteCost: number;
  avgCostPerGoodSqm: number;
}

export interface CostBreakdownRow {
  taskId?: string;
  taskName?: string;
  materialModel?: string;
  reportCount?: number;
  totalReports?: number;
  consumedAreaM2?: number;
  totalConsumedAreaM2?: number;
  netGoodAreaM2?: number;
  recoveredRemnantAreaM2?: number;
  wasteAreaM2?: number;
  materialCost?: number;
  totalMaterialCost?: number;
  recoveredResidualValue?: number;
  netEffectiveCost?: number;
  wasteCost?: number;
  avgCostPerGoodSqm?: number;
}

export interface CostSummaryResponse {
  currency: string;
  defaultUnitPricePerSqm: number;
  remnantResidualFactor: number;
  summary: CostSummaryTotals;
  byTask: CostBreakdownRow[];
  byMaterialModel: CostBreakdownRow[];
}

export interface ProcurementSuggestionItem {
  materialModel: string;
  demandAreaM2: number;
  requiredWithBufferAreaM2: number;
  availableRollAreaM2: number;
  availableRemnantAreaM2: number;
  netAvailableAreaM2: number;
  shortageAreaM2: number;
  recommendedWidthMm: number;
  recommendedLengthM: number;
  recommendedRolls: number;
  alertLevel: string;
  pendingTaskCount: number;
  activeBatches: string[];
}

export interface ProcurementSuggestionsResponse {
  safetyBufferPct: number;
  defaultRollLengthM: number;
  totalModels: number;
  shortageModels: number;
  items: ProcurementSuggestionItem[];
}

export function normalizeAlertLevel(level?: string): { label: string; tagClass: string; priority: number } {
  const key = String(level || '').trim().toUpperCase();
  if (key === 'CRITICAL' || key === 'URGENT' || key === 'HIGH' || key === 'SHORTAGE') {
    return { label: key === 'CRITICAL' ? '紧急缺料' : '高危缺口', tagClass: 'err', priority: 3 };
  }
  if (key === 'WARNING' || key === 'WARN' || key === 'MEDIUM' || key === 'LOW_STOCK') {
    return { label: '库存偏紧', tagClass: 'warn', priority: 2 };
  }
  return { label: '库存充足', tagClass: 'ok', priority: 1 };
}

export function computeWasteSharePct(summary?: CostSummaryTotals | null): number {
  if (!summary || !Number(summary.totalMaterialCost)) return 0;
  return Number(((Number(summary.wasteCost || 0) / Number(summary.totalMaterialCost)) * 100).toFixed(2));
}

function readRowMetric(row: CostBreakdownRow, primary: keyof CostBreakdownRow, alt?: keyof CostBreakdownRow): number {
  const v = row[primary] ?? (alt ? row[alt] : undefined);
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

export function buildCostSummaryCsvText(
  cost: CostSummaryResponse,
  dimension: 'task' | 'model'
): string {
  const rows = dimension === 'task' ? cost.byTask || [] : cost.byMaterialModel || [];
  const header = [
    dimension === 'task' ? '任务编号' : '品号型号',
    ...(dimension === 'task' ? ['任务名称'] : []),
    '有效报工数(单)',
    '累计耗料面积(m²)',
    '净良品面积(m²)',
    '回收料头面积(m²)',
    '废料面积(m²)',
    `原料总投入(${cost.currency || 'CNY'})`,
    `回收残值抵扣(${cost.currency || 'CNY'})`,
    `净有效成本(${cost.currency || 'CNY'})`,
    `废料损失(${cost.currency || 'CNY'})`,
    `单方良品成本(${cost.currency || 'CNY'}/m²)`
  ];
  const body = rows.map((row) => [
    dimension === 'task' ? row.taskId || '—' : row.materialModel || '—',
    ...(dimension === 'task' ? [row.taskName || '—'] : []),
    readRowMetric(row, 'totalReports', 'reportCount'),
    readRowMetric(row, 'totalConsumedAreaM2', 'consumedAreaM2'),
    readRowMetric(row, 'netGoodAreaM2'),
    readRowMetric(row, 'recoveredRemnantAreaM2'),
    readRowMetric(row, 'wasteAreaM2'),
    readRowMetric(row, 'totalMaterialCost', 'materialCost'),
    readRowMetric(row, 'recoveredResidualValue'),
    readRowMetric(row, 'netEffectiveCost'),
    readRowMetric(row, 'wasteCost'),
    readRowMetric(row, 'avgCostPerGoodSqm')
  ]);
  return '\uFEFF' + [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function buildProcurementCsvText(proc: ProcurementSuggestionsResponse): string {
  const header = [
    '品号型号',
    '预警等级',
    '待排需求面积(m²)',
    `含${proc.safetyBufferPct}%缓冲总需求(m²)`,
    '在库可用母卷(m²)',
    '可用料头面积(m²)',
    '净可用库存(m²)',
    '缺口面积(m²)',
    '建议采购门幅(mm)',
    '标准卷长(m)',
    '建议采购卷数(卷)',
    '关联待排任务数(单)',
    '当前在库缸号批次'
  ];
  const body = (proc.items || []).map((it) => [
    it.materialModel,
    normalizeAlertLevel(it.alertLevel).label,
    it.demandAreaM2,
    it.requiredWithBufferAreaM2,
    it.availableRollAreaM2,
    it.availableRemnantAreaM2,
    it.netAvailableAreaM2,
    it.shortageAreaM2,
    it.recommendedWidthMm,
    it.recommendedLengthM,
    it.recommendedRolls,
    it.pendingTaskCount,
    (it.activeBatches || []).join(' / ')
  ]);
  return '\uFEFF' + [header, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export const CostAnalyticsPage: React.FC = () => {
  const [viewTab, setViewTab] = useState<'cost' | 'procurement'>('cost');
  const [costDimension, setCostDimension] = useState<'task' | 'model'>('task');

  // 可调核算口径参数（支持实时重算）
  const [unitPrice, setUnitPrice] = useState<number>(25);
  const [residualFactor, setResidualFactor] = useState<number>(0.7);
  const [safetyBufferPct, setSafetyBufferPct] = useState<number>(15);
  const [defaultRollLengthM, setDefaultRollLengthM] = useState<number>(50);

  const [costData, setCostData] = useState<CostSummaryResponse | null>(null);
  const [procData, setProcData] = useState<ProcurementSuggestionsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(
    async (params: {
      unitPrice: number;
      residualFactor: number;
      safetyBufferPct: number;
      defaultRollLengthM: number;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const costQuery = new URLSearchParams({
          defaultUnitPricePerSqm: String(Math.max(0, Number(params.unitPrice) || 25)),
          remnantResidualFactor: String(
            Math.max(0, Math.min(1, Number(params.residualFactor) || 0))
          )
        });
        const procQuery = new URLSearchParams({
          safetyBufferPct: String(Math.max(0, Number(params.safetyBufferPct) || 0)),
          defaultRollLengthM: String(Math.max(1, Number(params.defaultRollLengthM) || 50))
        });

        const [costRes, procRes] = await Promise.all([
          requestJSON('/api/v2/analytics/cost-summary?' + costQuery.toString()),
          requestJSON('/api/v2/analytics/procurement-suggestions?' + procQuery.toString())
        ]);
        setCostData(costRes);
        setProcData(procRes);
      } catch (err: any) {
        const msg = err?.message || '读取成本与备料分析失败';
        setError(msg);
        toast(msg, true);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchAnalytics({ unitPrice, residualFactor, safetyBufferPct, defaultRollLengthM });
  }, []);

  const handleRecalculate = (e: React.FormEvent) => {
    e.preventDefault();
    fetchAnalytics({ unitPrice, residualFactor, safetyBufferPct, defaultRollLengthM });
  };

  const handleExportCsv = () => {
    if (viewTab === 'cost' && costData) {
      const csv = buildCostSummaryCsvText(costData, costDimension);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `实绩成本核算-${costDimension === 'task' ? '按任务' : '按品号'}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出实绩成本明细 CSV');
    } else if (viewTab === 'procurement' && procData) {
      const csv = buildProcurementCsvText(procData);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `跨订单采购备料建议-缓冲${procData.safetyBufferPct}pct.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出采购备料建议 CSV');
    }
  };

  const tabOptions: SegmentedOption<'cost' | 'procurement'>[] = useMemo(
    () => [
      {
        value: 'cost',
        label: '实绩成本与废料核算',
        count: costData?.summary?.totalReports
      },
      {
        value: 'procurement',
        label: '跨订单采购备料预警',
        count: procData?.shortageModels,
        accent: (procData?.shortageModels || 0) > 0 ? 'amber' : 'emerald'
      }
    ],
    [costData?.summary?.totalReports, procData?.shortageModels]
  );

  const summary = costData?.summary;
  const currency = costData?.currency || 'CNY';
  const wasteSharePct = computeWasteSharePct(summary);
  const activeCostRows = useMemo(
    () => (costDimension === 'task' ? costData?.byTask || [] : costData?.byMaterialModel || []),
    [costData, costDimension]
  );

  const shortageCards = useMemo(
    () =>
      (procData?.items || [])
        .filter((it) => Number(it.shortageAreaM2) > 0 || normalizeAlertLevel(it.alertLevel).priority >= 2)
        .sort((a, b) => Number(b.shortageAreaM2) - Number(a.shortageAreaM2)),
    [procData]
  );

  return (
    <div className="react-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>成本与备料分析</h1>
            <span className="mp-page-summary num">
              基于已过账实绩报工与在库可用量核算（不含未报工预览方案）· 货币口径 {currency}
            </span>
          </div>
          <div className="mp-toolbar-actions">
            <a className="mp-ghost-btn" href="#/reconciliation">
              复检补排与对账
            </a>
            <a className="mp-ghost-btn" href="#/planning">
              联合排产与分床 →
            </a>
          </div>
        </div>

        <form className="box" onSubmit={handleRecalculate} style={{ marginBottom: 12 }}>
          <div className="pane-h">
            <span>核算参数与备料安全系数（修改后点击重算即时更新）</span>
            <span className="sub">只读实时分析</span>
          </div>
          <div
            className="pane-b"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 10,
              alignItems: 'end'
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>默认面料单价 ({currency}/m²)</span>
              <input
                type="number"
                className="num"
                min={0}
                step="any"
                value={unitPrice}
                onChange={(e) => setUnitPrice(Number(e.target.value))}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>料头残值折算系数 (0~1)</span>
              <input
                type="number"
                className="num"
                min={0}
                max={1}
                step="any"
                value={residualFactor}
                onChange={(e) => setResidualFactor(Number(e.target.value))}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>采购安全缓冲率 (%)</span>
              <input
                type="number"
                className="num"
                min={0}
                max={200}
                step="any"
                value={safetyBufferPct}
                onChange={(e) => setSafetyBufferPct(Number(e.target.value))}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              <span>标准采购卷长 (m/卷)</span>
              <input
                type="number"
                className="num"
                min={1}
                step="any"
                value={defaultRollLengthM}
                onChange={(e) => setDefaultRollLengthM(Number(e.target.value))}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="submit" className="btn pri" disabled={loading}>
                {loading ? '核算中…' : '按口径重算'}
              </button>
            </div>
          </div>
        </form>

        {error && (
          <div
            className="box"
            role="alert"
            style={{
              borderLeft: '3px solid var(--err, #dc2626)',
              padding: '10px 14px',
              marginBottom: 12,
              fontSize: 12.5
            }}
          >
            <strong>分析接口异常：</strong> {error}
          </div>
        )}

        <div
          className="cards"
          aria-label="成本与备料关键指标"
          style={{
            marginBottom: 12,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))',
            gap: 10
          }}
        >
          <article
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 14px' }}
          >
            <span style={{ fontSize: 12, color: 'var(--cp-ink-3)' }}>累计净有效成本（扣残值）</span>
            <strong className="num" style={{ fontSize: 19, lineHeight: 1.25 }}>
              {summary ? `${fmtN(summary.netEffectiveCost, 2)} ${currency}` : '—'}
            </strong>
            <span className="muted num" style={{ fontSize: 11 }}>
              单方良品 {summary ? `${fmtN(summary.avgCostPerGoodSqm, 2)} ${currency}/m²` : '—'}
            </span>
          </article>
          <article
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 14px' }}
          >
            <span style={{ fontSize: 12, color: 'var(--cp-ink-3)' }}>原料总投入 / 有效报工</span>
            <strong className="num" style={{ fontSize: 19, lineHeight: 1.25 }}>
              {summary ? `${fmtN(summary.totalMaterialCost, 2)} ${currency}` : '—'}
            </strong>
            <span className="muted num" style={{ fontSize: 11 }}>
              {summary ? `${fmtN(summary.totalConsumedAreaM2, 2)} m² · ${summary.totalReports} 单` : '—'}
            </span>
          </article>
          <article
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 14px' }}
          >
            <span style={{ fontSize: 12, color: 'var(--cp-ink-3)' }}>废料损失金额 / 占比</span>
            <strong
              className="num"
              style={{
                fontSize: 19,
                lineHeight: 1.25,
                color: wasteSharePct >= 15 ? 'var(--err, #dc2626)' : undefined
              }}
            >
              {summary ? `${fmtN(summary.wasteCost, 2)} ${currency}` : '—'}
            </strong>
            <span className="muted num" style={{ fontSize: 11 }}>
              {summary ? `废料 ${fmtN(summary.wasteAreaM2, 2)} m²（占投入 ${wasteSharePct}%）` : '—'}
            </span>
          </article>
          <article
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 14px' }}
          >
            <span style={{ fontSize: 12, color: 'var(--cp-ink-3)' }}>回收料头残值抵扣</span>
            <strong
              className="num"
              style={{ fontSize: 19, lineHeight: 1.25, color: 'var(--ok, #059669)' }}
            >
              {summary ? `-${fmtN(summary.recoveredResidualValue, 2)} ${currency}` : '—'}
            </strong>
            <span className="muted num" style={{ fontSize: 11 }}>
              {summary ? `可复用回收 ${fmtN(summary.recoveredRemnantAreaM2, 2)} m²` : '—'}
            </span>
          </article>
          <article
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '12px 14px' }}
          >
            <span style={{ fontSize: 12, color: 'var(--cp-ink-3)' }}>跨订单缺料预警型号</span>
            <strong
              className="num"
              style={{
                fontSize: 19,
                lineHeight: 1.25,
                color: (procData?.shortageModels || 0) > 0 ? 'var(--err, #dc2626)' : 'var(--ok, #059669)'
              }}
            >
              {procData ? `${procData.shortageModels} / ${procData.totalModels} 个` : '—'}
            </strong>
            <span className="muted num" style={{ fontSize: 11 }}>
              安全缓冲 +{procData?.safetyBufferPct ?? safetyBufferPct}%
            </span>
          </article>
        </div>

        <div className="mp-filter-toolbar">
          <SegmentedControl<'cost' | 'procurement'>
            options={tabOptions}
            value={viewTab}
            onChange={(next) => setViewTab(next)}
            ariaLabel="成本与备料子视图"
          />
          <div className="mp-toolbar-actions">
            {viewTab === 'cost' && (
              <SegmentedControl<'task' | 'model'>
                size="sm"
                ariaLabel="成本归集维度"
                value={costDimension}
                onChange={(next) => setCostDimension(next)}
                options={[
                  { value: 'task', label: '按任务 / 订单归集', count: costData?.byTask?.length },
                  { value: 'model', label: '按品号型号归集', count: costData?.byMaterialModel?.length }
                ]}
              />
            )}
            <button
              type="button"
              className="btn pri"
              disabled={loading || (viewTab === 'cost' ? !costData : !procData)}
              onClick={handleExportCsv}
            >
              导出当前明细 CSV
            </button>
          </div>
        </div>

        {loading && !costData && !procData ? (
          <div className="mp-empty-card">
            <div className="loading">正在拉取实绩成本台账与跨订单备料缺口…</div>
          </div>
        ) : viewTab === 'cost' ? (
          <div className="box">
            <div className="pane-h">
              <span>
                {costDimension === 'task' ? '按任务 / 订单实绩成本分解' : '按品号型号实绩成本分解'}
              </span>
              <span className="sub">
                净有效成本 = 原料总投入 − 回收料头残值抵扣（单价 {costData?.defaultUnitPricePerSqm ?? unitPrice}{' '}
                {currency}/m² · 残值系数 {costData?.remnantResidualFactor ?? residualFactor}）
              </span>
            </div>
            <div className="mp-table-scroll" style={{ overflowX: 'auto' }}>
              <table className="t" style={{ minWidth: 980 }}>
                <thead>
                  <tr>
                    <th>{costDimension === 'task' ? '任务编号 / 名称' : '品号型号'}</th>
                    <th>报工数 (单)</th>
                    <th>耗料面积 (m²)</th>
                    <th>净良品 (m²)</th>
                    <th>回收料头 (m²)</th>
                    <th>废料面积 (m²)</th>
                    <th>原料投入 ({currency})</th>
                    <th>残值抵扣 ({currency})</th>
                    <th>净有效成本 ({currency})</th>
                    <th>废料损失 ({currency})</th>
                    <th>单方良品 ({currency}/m²)</th>
                  </tr>
                </thead>
                <tbody>
                  {activeCostRows.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                        暂无可核算的已过账实绩报工记录。完成现场裁切报工后将自动归集。
                      </td>
                    </tr>
                  ) : (
                    activeCostRows.map((row, idx) => (
                      <tr key={row.taskId || row.materialModel || idx}>
                        <td>
                          {costDimension === 'task' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <CodeBadge>{row.taskId || '—'}</CodeBadge>
                              <span style={{ fontSize: 12 }}>{row.taskName || '未命名任务'}</span>
                            </div>
                          ) : (
                            <CodeBadge>{row.materialModel || '未分类品号'}</CodeBadge>
                          )}
                        </td>
                        <td className="num">{readRowMetric(row, 'totalReports', 'reportCount')}</td>
                        <td className="num">
                          {fmtN(readRowMetric(row, 'totalConsumedAreaM2', 'consumedAreaM2'), 2)}
                        </td>
                        <td className="num">{fmtN(readRowMetric(row, 'netGoodAreaM2'), 2)}</td>
                        <td className="num">{fmtN(readRowMetric(row, 'recoveredRemnantAreaM2'), 2)}</td>
                        <td className="num">{fmtN(readRowMetric(row, 'wasteAreaM2'), 2)}</td>
                        <td className="num">
                          {fmtN(readRowMetric(row, 'totalMaterialCost', 'materialCost'), 2)}
                        </td>
                        <td className="num" style={{ color: 'var(--ok, #059669)' }}>
                          -{fmtN(readRowMetric(row, 'recoveredResidualValue'), 2)}
                        </td>
                        <td className="num">
                          <strong>{fmtN(readRowMetric(row, 'netEffectiveCost'), 2)}</strong>
                        </td>
                        <td className="num" style={{ color: 'var(--err, #dc2626)' }}>
                          {fmtN(readRowMetric(row, 'wasteCost'), 2)}
                        </td>
                        <td className="num">{fmtN(readRowMetric(row, 'avgCostPerGoodSqm'), 2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {shortageCards.length > 0 && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: 10
                }}
                aria-label="高危缺料预警卡片"
              >
                {shortageCards.map((item) => {
                  const badge = normalizeAlertLevel(item.alertLevel);
                  return (
                    <article
                      key={item.materialModel}
                      className="box"
                      style={{
                        borderLeft: `3px solid ${
                          badge.tagClass === 'err' ? 'var(--err, #dc2626)' : 'var(--warn, #d97706)'
                        }`,
                        padding: '10px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <CodeBadge>{item.materialModel}</CodeBadge>
                        <span className={`tag ${badge.tagClass}`}>{badge.label}</span>
                      </div>
                      <div className="num" style={{ fontSize: 15, fontWeight: 700, color: 'var(--err, #dc2626)' }}>
                        净缺口 {fmtN(item.shortageAreaM2, 2)} m²
                      </div>
                      <div style={{ fontSize: 12 }} className="num">
                        建议补采：门幅 {fmtN(item.recommendedWidthMm, 0)} mm × {fmtN(item.recommendedLengthM, 1)} m ×{' '}
                        <strong>{item.recommendedRolls} 卷</strong>
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        涉及待排任务 {item.pendingTaskCount} 单 · 现有缸号：
                        {item.activeBatches?.length ? item.activeBatches.join('、') : '无在库批次'}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            <div className="box">
              <div className="pane-h">
                <span>跨订单全品号备料核算与采购建议表</span>
                <span className="sub num">
                  共 {procData?.totalModels ?? 0} 个品号 · 缺料 {procData?.shortageModels ?? 0} 个 · 默认卷长{' '}
                  {procData?.defaultRollLengthM ?? defaultRollLengthM} m
                </span>
              </div>
              <div className="mp-table-scroll" style={{ overflowX: 'auto' }}>
                <table className="t" style={{ minWidth: 940 }}>
                  <thead>
                    <tr>
                      <th>品号型号</th>
                      <th>预警状态</th>
                      <th>待排需求 (m²)</th>
                      <th>含缓冲需求 (m²)</th>
                      <th>可用母卷 (m²)</th>
                      <th>可用料头 (m²)</th>
                      <th>净可用库存 (m²)</th>
                      <th>缺口面积 (m²)</th>
                      <th>建议采购规格</th>
                      <th>待排任务 (单)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(procData?.items || []).length === 0 ? (
                      <tr>
                        <td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                          当前没有待排需求型号的备料数据。
                        </td>
                      </tr>
                    ) : (
                      (procData?.items || []).map((item) => {
                        const badge = normalizeAlertLevel(item.alertLevel);
                        return (
                          <tr key={item.materialModel}>
                            <td>
                              <CodeBadge>{item.materialModel}</CodeBadge>
                            </td>
                            <td>
                              <span className={`tag ${badge.tagClass}`}>{badge.label}</span>
                            </td>
                            <td className="num">{fmtN(item.demandAreaM2, 2)}</td>
                            <td className="num">{fmtN(item.requiredWithBufferAreaM2, 2)}</td>
                            <td className="num">{fmtN(item.availableRollAreaM2, 2)}</td>
                            <td className="num">{fmtN(item.availableRemnantAreaM2, 2)}</td>
                            <td className="num">{fmtN(item.netAvailableAreaM2, 2)}</td>
                            <td
                              className="num"
                              style={{
                                fontWeight: item.shortageAreaM2 > 0 ? 700 : 400,
                                color: item.shortageAreaM2 > 0 ? 'var(--err, #dc2626)' : undefined
                              }}
                            >
                              {fmtN(item.shortageAreaM2, 2)}
                            </td>
                            <td className="num">
                              {item.recommendedRolls > 0
                                ? `${fmtN(item.recommendedWidthMm, 0)}mm × ${fmtN(
                                    item.recommendedLengthM,
                                    0
                                  )}m × ${item.recommendedRolls}卷`
                                : '暂无需补采'}
                            </td>
                            <td className="num">{item.pendingTaskCount}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
