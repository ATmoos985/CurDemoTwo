import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, shortId, fmtN, toast } from '@static/app/js/util.js';
import {
  reviewablePieces,
  effectivePieceResults,
  emptyQualityForm,
  qualityProblems,
  buildQualityCommand,
  receiptSummary,
  DISPOSITIONS
} from '@static/app/js/model/quality.js';
import { csvCell } from '@static/js/business/analysis/report-model.js';
import { ModalDialog } from '../components/ModalDialog';
import { useStudioStore, DemandFamilySummary } from '../store/useStudioStore';

export const ReconciliationPage: React.FC = () => {
  const loadDemandFamilyIntoWorkbench = useStudioStore((s) => s.loadDemandFamilyIntoWorkbench);

  const [tab, setTab] = useState<'quality' | 'reconcile'>('quality');
  const [reports, setReports] = useState<{ task: any; report: any }[]>([]);
  const [recon, setRecon] = useState<any>(null);
  const [ledgerItems, setLedgerItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [qualityDraft, setQualityDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [summaries, reconData, ledPage] = await Promise.all([
        requestJSON('/api/cutting/task-summaries').catch(() => []),
        requestJSON('/api/v2/inventory-ledger/reconciliation').catch(() => null),
        requestJSON('/api/v2/inventory-ledger?limit=100&after=0').catch(() => ({ items: [] }))
      ]);

      const withReports = (summaries || []).filter((r: any) => r.reportCount > 0);
      const details = await Promise.all(
        withReports.map((s: any) =>
          requestJSON('/api/cutting/tasks/' + encodeURIComponent(s.task.id)).catch(() => null)
        )
      );
      const rows = details
        .filter(Boolean)
        .flatMap((d: any) => (d.reports || []).map((r: any) => ({ task: d.task, report: r })))
        .filter((x: any) => x.report.status !== 'REVERSED')
        .sort((a: any, b: any) =>
          String(b.report.confirmedAt || '').localeCompare(String(a.report.confirmedAt || ''))
        );

      setReports(rows);
      setRecon(reconData);
      setLedgerItems(ledPage?.items || []);
    } catch (err: any) {
      toast('读取复检与对账数据失败：' + err.message, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleOpenQualityReview = (report: any) => {
    const revPieces = reviewablePieces(report);
    if (!revPieces.length) {
      toast('该报工单已无剩余可复检合格件', true);
      return;
    }
    setQualityDraft(emptyQualityForm(report, revPieces[0].pieceId));
  };

  const handleSubmitQuality = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qualityDraft || busy) return;
    const revPieces = reviewablePieces(qualityDraft.report);
    const piece = revPieces.find((p: any) => p.pieceId === Number(qualityDraft.pieceId));
    const probs = qualityProblems(qualityDraft, piece);
    if (probs.length > 0) {
      toast(probs[0], true);
      return;
    }
    const cmd = buildQualityCommand(qualityDraft, crypto.randomUUID());
    setBusy(true);
    try {
      await requestJSON(
        '/api/cutting/reports/' +
          encodeURIComponent(qualityDraft.report.planId) +
          '/quality-dispositions',
        cmd
      );
      toast('复检处置已过账！原母卷耗用保持不变，不良件已扣回良品量并退回需求池待补排');
      setQualityDraft(null);
      await loadData();
    } catch (err: any) {
      toast('复检处置失败：' + err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleReplenishTask = async (taskId: string) => {
    try {
      const fam: DemandFamilySummary = await requestJSON(
        '/api/v2/demand-pool/' + encodeURIComponent(taskId)
      );
      loadDemandFamilyIntoWorkbench(fam);
      toast(`已将缺口需求族「${fam.name}」（待补排 ${fam.openTotal} 件）带入搭切工作台`);
      location.hash = '#/workbench';
    } catch (err: any) {
      toast('读取缺口需求失败：' + err.message, true);
    }
  };

  const handleExportLedgerCsv = () => {
    if (!ledgerItems.length) return;
    const cols = ['sequence', 'eventType', 'aggregateType', 'aggregateId', 'actor', 'occurredAt'];
    const csv =
      '\uFEFF' +
      [cols.join(',')]
        .concat(
          ledgerItems.map((it) => cols.map((k) => csvCell(it[k])).join(','))
        )
        .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = '库存与需求过账流水.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const areaStats = useMemo(() => {
    const areas: any[] = recon?.areas || [];
    const consumed = areas.reduce((s, a) => s + (Number(a.consumed) || 0), 0);
    const qualified = areas.reduce((s, a) => s + (Number(a.qualified) || 0), 0);
    const recovered = areas.reduce((s, a) => s + (Number(a.recovered) || 0), 0);
    const waste = areas.reduce(
      (s, a) => s + (Number(a.rejected) || 0) + (Number(a.otherWasteAndLoss) || 0),
      0
    );
    return {
      consumed,
      qualified,
      recovered,
      waste,
      netRate: consumed > 0 ? ((qualified / consumed) * 100).toFixed(2) : null
    };
  }, [recon]);

  return (
    <div className="react-page">
      <div className="ph">
        <h1>复检补排与对账</h1>
        <span className="crumb">
          裁后质量重分类（不良退回需求池补排、不篡改已切母卷耗用）· 净良品产出率与流水平衡核验
        </span>
        <span className="sp" />
        <div className="seg" role="group" aria-label="对账子视图">
          <button
            type="button"
            className={tab === 'quality' ? 'on' : ''}
            aria-pressed={tab === 'quality'}
            onClick={() => setTab('quality')}
          >
            裁后复检与缺口补排 ({reports.length})
          </button>
          <button
            type="button"
            className={tab === 'reconcile' ? 'on' : ''}
            aria-pressed={tab === 'reconcile'}
            onClick={() => setTab('reconcile')}
          >
            用料对账与不可变流水
          </button>
        </div>
        <button type="button" className="btn sm" onClick={loadData}>
          刷新
        </button>
      </div>

      <div className="body">
        {loading ? (
          <div className="loading">正在读取报工回执与账实对账快照…</div>
        ) : tab === 'quality' ? (
          reports.length === 0 ? (
            <div className="box" style={{ padding: 32, textAlign: 'center' }}>
              <strong>暂无已完工报工记录</strong>
              <p className="muted" style={{ marginTop: 6 }}>
                排程方案在「结果管理」完成完工过账（或由 MES 回传报工）后，即可在此执行裁后复检判废或剪裁转料头。
              </p>
            </div>
          ) : (
            <div className="box" style={{ margin: 0 }}>
              <table className="t">
                <thead>
                  <tr>
                    <th>报工单号</th>
                    <th>所属需求族</th>
                    <th>消耗母卷 / 料头</th>
                    <th className="r">实切长 mm</th>
                    <th className="r">净合格件</th>
                    <th className="r">异常/判废</th>
                    <th className="r">净利用率</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map(({ task, report }) => {
                    const s = receiptSummary(report, effectivePieceResults);
                    const revCount = reviewablePieces(report).length;
                    const hasGap = (report.qualityDispositions || []).length > 0 || s.rejected > 0;
                    return (
                      <tr key={report.planId}>
                        <td className="num">{shortId(report.planId)}</td>
                        <td style={{ fontWeight: 600 }}>{task.name}</td>
                        <td className="num">{report.sourceRemnantId || report.rollId}</td>
                        <td className="r num">{fmtN(report.actualCutLen, 1)}</td>
                        <td className="r num" style={{ color: 'var(--ok)', fontWeight: 600 }}>
                          {s.qualified}
                        </td>
                        <td className="r num" style={{ color: hasGap ? 'var(--err)' : undefined }}>
                          {s.rejected + s.scrapped + s.remnant}
                        </td>
                        <td className="r num">{fmtN(report.netUtilization, 2)}%</td>
                        <td>
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            {revCount > 0 && (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => handleOpenQualityReview(report)}
                              >
                                复检处置 ({revCount})
                              </button>
                            )}
                            {hasGap && (
                              <button
                                type="button"
                                className="btn sm pri"
                                onClick={() => handleReplenishTask(task.id)}
                              >
                                带缺口去补排 →
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="cards" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
              <div className="card">
                <small>账实流水平衡状态</small>
                <b
                  style={{
                    color:
                      recon?.status === 'BALANCED'
                        ? 'var(--ok)'
                        : recon?.status === 'MISMATCH'
                        ? 'var(--err)'
                        : undefined
                  }}
                >
                  {recon?.status === 'BALANCED'
                    ? 'BALANCED 平衡'
                    : recon?.status === 'MISMATCH'
                    ? '发现差异'
                    : '待首次记账'}
                </b>
                <div className="d num">版本 v{recon?.revision ?? 0}</div>
              </div>
              <div className="card">
                <small>累计实耗原料面积</small>
                <b className="num">{fmtN(areaStats.consumed, 3)} m²</b>
                <div className="d">含已切母卷与领用料头</div>
              </div>
              <div className="card">
                <small>扣除复检净良品面积</small>
                <b className="num" style={{ color: 'var(--ok)' }}>
                  {fmtN(areaStats.qualified, 3)} m²
                </b>
                <div className="d">仅合格成品计入履约</div>
              </div>
              <div className="card">
                <small>实际净良品产出率</small>
                <b className="num">
                  {areaStats.netRate ? `${areaStats.netRate}%` : '暂无实切'}
                </b>
                <div className="d">净良品面积 ÷ 实耗总面积</div>
              </div>
              <div className="card">
                <small>回收可用余料面积</small>
                <b className="num">{fmtN(areaStats.recovered, 3)} m²</b>
                <div className="d">独立入账 · 不虚增利用率</div>
              </div>
            </div>

            <div className="box" style={{ margin: 0 }}>
              <div className="pane-h">
                <span>不可变库存与需求过账流水（最近 {ledgerItems.length} 笔）</span>
                <span className="sp" />
                <button type="button" className="btn sm" onClick={handleExportLedgerCsv}>
                  导出流水 CSV
                </button>
              </div>
              <table className="t">
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>事件类型</th>
                    <th>账本对象</th>
                    <th>对象编号</th>
                    <th>操作方</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerItems.map((it) => (
                    <tr key={it.id}>
                      <td className="num">#{it.sequence}</td>
                      <td>
                        <span className="tag kind">{it.eventType}</span>
                      </td>
                      <td>{it.aggregateType}</td>
                      <td className="num">{it.aggregateId}</td>
                      <td>{it.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Quality Disposition Modal */}
      <ModalDialog
        open={qualityDraft !== null}
        title="裁后质量复检重分类（保持原母卷耗用不变，扣回良品完成量）"
        onClose={() => setQualityDraft(null)}
        maxWidth={560}
      >
        {qualityDraft && (
          <form onSubmit={handleSubmitQuality}>
            <div className="form" style={{ gridTemplateColumns: '110px 1fr', padding: '4px 0 12px' }}>
              <label>选择复检裁片</label>
              <select
                className="field"
                value={qualityDraft.pieceId}
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, pieceId: Number(e.target.value) })
                }
              >
                {reviewablePieces(qualityDraft.report).map((p: any) => (
                  <option key={p.pieceId} value={p.pieceId}>
                    #{p.pieceId} {p.name} ({fmtN(p.w)}×{fmtN(p.l)} mm)
                  </option>
                ))}
              </select>
              <label>处置方式</label>
              <select
                className="field"
                value={qualityDraft.disposition}
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, disposition: e.target.value })
                }
              >
                {Object.entries(DISPOSITIONS as Record<string, string>).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <label>检验人</label>
              <input
                className="field"
                required
                value={qualityDraft.inspector}
                placeholder="如：质检员王工"
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, inspector: e.target.value })
                }
              />
              <label>判定原因</label>
              <input
                className="field"
                required
                value={qualityDraft.reason}
                placeholder="如：缝制前发现局部暗伤"
                onChange={(e) =>
                  setQualityDraft({ ...qualityDraft, reason: e.target.value })
                }
              />
              {qualityDraft.disposition === 'REMNANT' && (
                <>
                  <label>回收宽×长 mm</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number"
                      className="field num"
                      placeholder="宽"
                      value={qualityDraft.width}
                      onChange={(e) =>
                        setQualityDraft({ ...qualityDraft, width: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      className="field num"
                      placeholder="长"
                      value={qualityDraft.length}
                      onChange={(e) =>
                        setQualityDraft({ ...qualityDraft, length: e.target.value })
                      }
                    />
                  </div>
                  <label>入库位置</label>
                  <input
                    className="field"
                    value={qualityDraft.location}
                    placeholder="如：复检回收架 Q-01"
                    onChange={(e) =>
                      setQualityDraft({ ...qualityDraft, location: e.target.value })
                    }
                  />
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setQualityDraft(null)}>
                取消
              </button>
              <button type="submit" className="btn pri" disabled={busy}>
                确认复检处置
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </div>
  );
};
