import React, { useEffect, useState } from 'react';
import { requestJSON } from '@static/app/js/util.js';
import { reportTotals, csvCell } from '@static/js/business/analysis/report-model.js';

const EVENT_NAMES: Record<string, string> = {
  INVENTORY_TRANSFER: '材料移库',
  INVENTORY_COUNT: '库存盘点',
  MIGRATION_OPENING: '迁移期初',
  CUT_REPORT: '实切报工',
  CUT_REPORT_BATCH: '批量报工',
  REPORT_REVERSE: '报工冲销',
  QUALITY_DISPOSITION: '复检处置',
  DEMAND_ADJUSTMENT: '需求调整',
  ROLL_RECEIPT: '母卷入库',
  ROLL_RECEIPT_OR_UPDATE: '母卷入库或维护',
  REMNANT_RECEIPT: '料头入库',
  REMNANT_SCRAP: '料头报废',
  INSPECTION: '检验记录',
  SYSTEM_UPDATE: '系统更新',
  DEMO_RECEIPT: '示例入库',
  DEMO_RESET: '示例重置'
};

const RECON_STATUS_LABELS: Record<string, string> = {
  BALANCED: '对账平衡',
  MISMATCH: '对账发现差异',
  NOT_INITIALIZED: '尚未建立迁移期初'
};

function fmtNum4(value: any): string {
  return Number.isFinite(value)
    ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
    : '未知';
}

function parseJsonSafe(value: any): any {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return value;
  }
}

export const AnalysisPage: React.FC = () => {
  const [recon, setRecon] = useState<any>(null);
  const [reconBusy, setReconBusy] = useState(false);
  const [reconError, setReconError] = useState<string | null>(null);
  const [taskSummaryText, setTaskSummaryText] = useState<string>('正在读取任务汇总…');

  const [ledgerType, setLedgerType] = useState<string>('');
  const [ledgerId, setLedgerId] = useState<string>('');
  const [entries, setEntries] = useState<any[]>([]);
  const [cursor, setCursor] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [ledgerRev, setLedgerRev] = useState<number | string>('—');
  const [ledgerBusy, setLedgerBusy] = useState<boolean>(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const refreshAnalysis = async () => {
    setReconBusy(true);
    setReconError(null);
    try {
      const [res, summaries] = await Promise.all([
        requestJSON('/api/v2/inventory-ledger/reconciliation'),
        requestJSON('/api/cutting/task-summaries').catch(() => null)
      ]);
      setRecon(res);
      if (Array.isArray(summaries)) {
        const doneCount = summaries.filter((r: any) => r.status === 'COMPLETED').length;
        setTaskSummaryText(`已完成任务 ${doneCount} / ${summaries.length}`);
      }
    } catch (e: any) {
      setReconError(
        `读取失败：${e.message || '网络异常'} 上次结果可能已过期，请刷新。`
      );
    } finally {
      setReconBusy(false);
    }
  };

  const loadLedgerPage = async (reset = false, filterOverride?: { type: string; id: string }) => {
    if (ledgerBusy && !reset) return;
    setLedgerBusy(true);
    setLedgerError(null);
    const activeType = filterOverride ? filterOverride.type : ledgerType;
    const activeId = (filterOverride ? filterOverride.id : ledgerId).trim();
    const nextAfter = reset ? 0 : cursor;

    const params = new URLSearchParams({
      after: String(nextAfter),
      limit: '50'
    });
    if (activeType) params.set('aggregateType', activeType);
    if (activeId) params.set('aggregateId', activeId);

    try {
      const result = await requestJSON('/api/v2/inventory-ledger?' + params.toString());
      const newItems = result.items || [];
      setEntries((prev) => (reset ? newItems : [...prev, ...newItems]));
      setCursor(result.nextCursor ?? 0);
      setHasMore(Boolean(result.hasMore));
      setLedgerRev(result.revision ?? '—');
    } catch (e: any) {
      setLedgerError('流水读取失败：' + (e.message || '未知错误'));
    } finally {
      setLedgerBusy(false);
    }
  };

  useEffect(() => {
    refreshAnalysis();
    loadLedgerPage(true, { type: '', id: '' });
  }, []);

  const handleExportCsv = () => {
    if (!entries.length) return;
    const keys = [
      'sequence',
      'id',
      'eventType',
      'aggregateType',
      'aggregateId',
      'businessId',
      'occurredAt',
      'beforeVersion',
      'afterVersion',
      'beforeJson',
      'afterJson'
    ];
    const text = [keys, ...entries.map((row) => keys.map((k) => row[k]))]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(
      new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = '已载入库存流水.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const totals: any = recon ? reportTotals(recon) : null;
  const statusLabel = recon
    ? `${RECON_STATUS_LABELS[recon.status] || '状态未知'} · 库存版本 ${recon.revision}`
    : '正在读取对账状态…';

  return (
    <div className="react-page">
      <div className="ph">
        <h1>生产分析</h1>
        <span className="crumb">实际产出与库存对账</span>
        <div className="hub-tabs" role="navigation" aria-label="材料与台账视图">
          <a href="#/inventory">实物库存</a>
          <a href="#/inspection">跑布验疵</a>
          <a href="#/documents">移库与盘点单</a>
          <a className="on" href="#/analysis">
            产出对账
          </a>
        </div>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          id="refresh-analysis"
          disabled={reconBusy}
          onClick={refreshAnalysis}
        >
          刷新对账
        </button>
      </div>

      <div className="body">
        <div id="analysis-status" role="status">
          {statusLabel}
        </div>
        {reconError && (
          <div id="analysis-error" className="notice" role="alert">
            {reconError}
          </div>
        )}

        {totals ? (
          <div className="cards" id="actual-metrics" aria-label="实际报工指标">
            {[
              [
                '实际良品产出率',
                totals.goodRate == null ? '—' : `${fmtNum4(totals.goodRate * 100)}%`
              ],
              [
                '可回收率',
                totals.recoveryRate == null
                  ? '—'
                  : `${fmtNum4(totals.recoveryRate * 100)}%`
              ],
              ['累计加工投入', `${fmtNum4(totals.consumed)} m²`],
              ['有效报工', `${totals.count} 单`]
            ].map(([label, value]) => (
              <article key={label} className="card">
                <span>{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        ) : (
          <div className="cards" id="actual-metrics" aria-label="实际报工指标">
            {recon
              ? '当前没有可可靠汇总的报工面积；不显示零值或估算利用率。'
              : '正在计算面积汇总…'}
          </div>
        )}

        <div className="muted" id="task-summary" role="status">
          {taskSummaryText}
        </div>

        <details className="box">
          <summary className="pane-h">指标口径与适用范围</summary>
          <div className="pane-b">
            <p>
              只统计未冲销、面积资料完整的二维报工，良品已扣除复检降级。实际良品产出率 = 净良品面积总和 ÷ 加工投入面积总和；可回收率 = 回收面积总和 ÷ 加工投入面积总和。按面积加权，单位 m²。
            </p>
            <p>
              料头再次裁切会再次计入加工投入；回收后再领用不抹去原回收产出。未切尾料不计入投入。预览方案、旧一维作业与外部 WMS 不计入；历史面积缺失或对账异常时不显示汇总百分比。
            </p>
          </div>
        </details>

        <div id="analysis-issues" role="status">
          {(recon?.issues || []).map((issue: any, idx: number) => (
            <p key={idx}>
              异常 {issue.code} · {issue.aggregate || issue.reportId || issue.entryId || '全局'}
            </p>
          ))}
        </div>

        <div className="box">
          <div className="pane-h">
            逐单面积分解<span className="sub">单位 m²</span>
          </div>
          <div style={{ overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>报工编号</th>
                  <th>投入</th>
                  <th>净良品</th>
                  <th>回收</th>
                  <th>不良</th>
                  <th>其他废料与损耗</th>
                  <th>差异</th>
                  <th>良品产出率</th>
                </tr>
              </thead>
              <tbody id="area-rows">
                {(recon?.areas || []).map((row: any) => (
                  <tr key={row.reportId}>
                    <td>{row.reportId}</td>
                    <td>{fmtNum4(row.consumed)}</td>
                    <td>{fmtNum4(row.qualified)}</td>
                    <td>{fmtNum4(row.recovered)}</td>
                    <td>{fmtNum4(row.rejected)}</td>
                    <td>{fmtNum4(row.otherWasteAndLoss)}</td>
                    <td>{fmtNum4(row.difference)}</td>
                    <td>
                      {row.unit === 'm2' &&
                      row.consumed > 0 &&
                      Number.isFinite(row.qualified)
                        ? `${fmtNum4((row.qualified / row.consumed) * 100)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <section className="box" id="ledger">
          <div className="pane-h">
            库存与需求流水
            <span className="sp" />
            <button
              type="button"
              className="btn sm"
              id="export-ledger"
              disabled={!entries.length}
              onClick={handleExportCsv}
            >
              导出已载入流水 CSV
            </button>
          </div>
          <div className="notice">
            流水按顺序追加。迁移期初是历史余额快照，不代表当时发生过入库或裁切。
          </div>
          <form
            id="ledger-filters"
            className="toolbar"
            style={{ flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              loadLedgerPage(true);
            }}
          >
            <label htmlFor="ledger-type">对象类型</label>
            <select
              className="field"
              id="ledger-type"
              value={ledgerType}
              onChange={(e) => setLedgerType(e.target.value)}
            >
              <option value="">全部</option>
              {[
                ['ROLL', '母卷'],
                ['REMNANT', '料头'],
                ['DEMAND', '需求'],
                ['REPORT', '报工'],
                ['TRANSFER', '移库单'],
                ['COUNT', '盘点单'],
                ['CHECKPOINT', '迁移检查点']
              ].map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
            <label htmlFor="ledger-id">对象编号</label>
            <input
              className="field"
              id="ledger-id"
              placeholder="精确匹配对象编号"
              value={ledgerId}
              onChange={(e) => setLedgerId(e.target.value)}
            />
            <button className="btn" type="submit" disabled={ledgerBusy}>
              查询流水
            </button>
            <span id="ledger-status" role="status">
              已载入 {entries.length} 条 · 本页库存版本 {ledgerRev}
            </span>
          </form>

          {ledgerError && (
            <div id="ledger-error" className="notice" role="alert">
              {ledgerError}
            </div>
          )}

          <div style={{ overflow: 'auto' }}>
            <table className="t">
              <thead>
                <tr>
                  <th>序号 / 时间</th>
                  <th>业务事件</th>
                  <th>对象 / 编号</th>
                  <th>业务编号 / 来源报告</th>
                  <th>变更证据</th>
                </tr>
              </thead>
              <tbody id="ledger-rows">
                {entries.map((row) => (
                  <tr key={row.sequence}>
                    <td>
                      {row.sequence} /{' '}
                      {new Date(row.occurredAt).toLocaleString('zh-CN', {
                        hour12: false
                      })}
                    </td>
                    <td>{EVENT_NAMES[row.eventType] || row.eventType}</td>
                    <td>
                      {row.aggregateType} / {row.aggregateId}
                    </td>
                    <td>
                      {row.businessId} / {(row.sourceReportIds || []).join(', ')}
                    </td>
                    <td>
                      <details>
                        <summary>查看前后值</summary>
                        <pre>
                          {JSON.stringify(
                            {
                              before: parseJsonSafe(row.beforeJson),
                              after: parseJsonSafe(row.afterJson),
                              actor: row.actor,
                              reverses: row.reverses
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(hasMore || ledgerError) && (
            <button
              type="button"
              className="btn"
              id="load-ledger"
              style={{ margin: '8px 12px' }}
              disabled={ledgerBusy}
              onClick={() => loadLedgerPage(false)}
            >
              {ledgerError ? '重试读取' : '加载下一页'}
            </button>
          )}
        </section>
      </div>
    </div>
  );
};
