import React from 'react';
import { fmtN, shortId } from '../../lib/core/util.js';
import { DISPOSITIONS, effectivePieceResults, receiptSummary, reviewablePieces } from '../../lib/model/quality.js';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import {
  NormalizedReconciliationReportRow,
  isDispositionRevoked,
  readDispositionFields
} from '../results/reconciliationUtils';
import { evaluateReportReversalEligibility } from '../results/reportReversalUtils';

export interface RevokeDraft {
  reportId: string;
  taskName: string;
  dispositionId: string;
  pieceId?: number | string;
  dispositionLabel: string;
  inspector?: string;
  origReason?: string;
  operator: string;
  reason: string;
}

export interface ReverseReportDraft {
  reportId: string;
  taskName: string;
  materialLabel: string;
  actualCutLen: number;
  qualifiedCount: number;
  reason: string;
  error: string;
}

export interface ReconciliationQualityTabProps {
  reports: NormalizedReconciliationReportRow[];
  filteredReports: NormalizedReconciliationReportRow[];
  reportTotal: number;
  reportOffset: number;
  reportPageSize: number;
  reportHasMore: boolean;
  loading: boolean;
  busy: boolean;
  expandedReportId: string | null;
  onToggleExpand: (reportId: string | null) => void;
  onOpenQualityReview: (report: any) => void;
  onReplenishTask: (taskId: string) => void;
  onOpenReverseDraft: (draft: ReverseReportDraft) => void;
  onOpenRevokeDraft: (draft: RevokeDraft) => void;
  onPageChange: (nextOffset: number) => void;
  onClearSearch: () => void;
}

export const ReconciliationQualityTab: React.FC<ReconciliationQualityTabProps> = ({
  reports,
  filteredReports,
  reportTotal,
  reportOffset,
  reportPageSize,
  reportHasMore,
  loading,
  busy,
  expandedReportId,
  onToggleExpand,
  onOpenQualityReview,
  onReplenishTask,
  onOpenReverseDraft,
  onOpenRevokeDraft,
  onPageChange,
  onClearSearch
}) => {
  const pageStart = reportTotal > 0 ? reportOffset + 1 : 0;
  const pageEnd = Math.min(reportTotal, reportOffset + reports.length);

  return (
    <>
      <div className="mp-rec-note">
        <span>
          裁后质量重分类与撤销均保留原母卷消耗不篡改，仅受控调整良品履约量与派生余料状态（支持跨刷新幂等恢复）。
        </span>
        <span className="mp-toolbar-count num">
          {reportTotal > 0 ? `第 ${pageStart}-${pageEnd} / 共 ${reportTotal} 笔` : '共 0 笔'}
        </span>
      </div>

      {reports.length === 0 ? (
        <div className="mp-empty-card">
          <strong>暂无已完工报工记录</strong>
          <p>
            排程方案在「结果管理」完成完工过账（或由 MES 回传报工）后，即可在此执行裁后复检判废、剪裁转料头或受控撤销。
          </p>
          <a className="btn" href="#/results">
            前往结果管理查看方案 →
          </a>
        </div>
      ) : filteredReports.length === 0 ? (
        <div className="mp-empty-card">
          <strong>未找到匹配的报工回执</strong>
          <p>请调整搜索关键词或翻页查看其他报工记录。</p>
          <button type="button" className="btn" onClick={onClearSearch}>
            清空搜索
          </button>
        </div>
      ) : (
        <div className="mp-rec-table-card">
          <div className="mp-table-scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>报工单号</th>
                  <th>所属需求族 / 品号缸号</th>
                  <th>消耗母卷 / 料头</th>
                  <th className="r">实切长 mm</th>
                  <th className="r">净合格件</th>
                  <th className="r">异常 / 判废</th>
                  <th className="r">净利用率</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredReports.map((row) => {
                  const { report, dispositions } = row;
                  const s = receiptSummary(report, effectivePieceResults);
                  const revCount = reviewablePieces(report).length;
                  const defectCount = Number(s.rejected) || 0;
                  const activeDispCount = dispositions.filter((d) => !isDispositionRevoked(d)).length;
                  const hasGap = activeDispCount > 0 || defectCount > 0;
                  const isExpanded = expandedReportId === row.reportId;
                  const reversalCheck = evaluateReportReversalEligibility({
                    reportId: row.reportId,
                    status: report.status,
                    dispositions,
                    report
                  });

                  return (
                    <React.Fragment key={row.reportId}>
                      <tr>
                        <td>
                          <CodeBadge title={row.reportId}>{shortId(row.reportId)}</CodeBadge>
                        </td>
                        <td className="mp-rec-name-cell">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <strong>{row.taskName}</strong>
                            {row.materialModel && (
                              <span className="muted num" style={{ fontSize: 11.5 }}>
                                {row.materialModel}
                              </span>
                            )}
                            {row.batchNo && <CodeBadge>缸:{row.batchNo}</CodeBadge>}
                          </div>
                          {report.confirmedAt && (
                            <span className="mp-rec-name-sub num">
                              完工于 {String(report.confirmedAt).replace('T', ' ').slice(0, 19)}
                            </span>
                          )}
                        </td>
                        <td>
                          <CodeBadge>{report.sourceRemnantId || report.rollId || '—'}</CodeBadge>
                        </td>
                        <td className="r num">{fmtN(report.actualCutLen, 1)}</td>
                        <td className="r num" style={{ color: '#059669', fontWeight: 600 }}>
                          {s.qualified}
                        </td>
                        <td
                          className="r num"
                          style={{
                            color: defectCount > 0 ? '#e11d48' : 'var(--cp-ink-3)',
                            fontWeight: defectCount > 0 ? 600 : 400
                          }}
                        >
                          {defectCount}
                        </td>
                        <td className="r num">{fmtN(report.netUtilization, 2)}%</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {dispositions.length > 0 && (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => onToggleExpand(isExpanded ? null : row.reportId)}
                              >
                                {isExpanded ? '收起处置' : `复检记录 (${dispositions.length})`}
                              </button>
                            )}
                            {revCount > 0 && (
                              <button
                                type="button"
                                className="btn sm"
                                onClick={() => onOpenQualityReview(report)}
                              >
                                复检处置 ({revCount})
                              </button>
                            )}
                            {hasGap && row.taskId && (
                              <button
                                type="button"
                                className="btn sm soft-accent"
                                onClick={() => onReplenishTask(row.taskId)}
                              >
                                带缺口去补排 →
                              </button>
                            )}
                            {report.status !== 'REVERSED' && (
                              <button
                                type="button"
                                className="btn sm"
                                style={reversalCheck.eligible ? { color: 'var(--err, #b91c1c)' } : undefined}
                                disabled={busy || !reversalCheck.eligible}
                                title={
                                  reversalCheck.eligible
                                    ? '冲销该笔报工，恢复母卷/料头消耗并回滚完成量'
                                    : reversalCheck.reason
                                }
                                onClick={() =>
                                  onOpenReverseDraft({
                                    reportId: row.reportId,
                                    taskName: row.taskName,
                                    materialLabel: report.sourceRemnantId || report.rollId || '—',
                                    actualCutLen: Number(report.actualCutLen) || 0,
                                    qualifiedCount: Number(s.qualified) || 0,
                                    reason: '',
                                    error: ''
                                  })
                                }
                              >
                                冲销报工
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {isExpanded && dispositions.length > 0 && (
                        <tr>
                          <td colSpan={8} style={{ background: 'var(--panel-2, #f8fafc)', padding: '10px 14px' }}>
                            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--cp-ink-2)' }}>
                              历史复检处置记录（保留不可变审计痕迹，未撤销处置可执行受控撤销）
                            </div>
                            <table className="t">
                              <thead>
                                <tr>
                                  <th>处置编号</th>
                                  <th>裁片</th>
                                  <th>方式</th>
                                  <th>检验人</th>
                                  <th>原因</th>
                                  <th>派生料头</th>
                                  <th>状态</th>
                                  <th style={{ textAlign: 'right' }}>受控操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {dispositions.map((d: any, idx: number) => {
                                  const info = readDispositionFields(d, idx);
                                  const dispId = info.id;
                                  const revoked = info.revoked;
                                  const dispLabel =
                                    (DISPOSITIONS as Record<string, string>)[info.disposition] ||
                                    info.disposition ||
                                    '复检处置';
                                  return (
                                    <tr
                                      key={dispId}
                                      style={revoked ? { opacity: 0.65, textDecoration: 'line-through' } : undefined}
                                    >
                                      <td>
                                        <CodeBadge title={dispId}>{shortId(dispId)}</CodeBadge>
                                      </td>
                                      <td className="num">#{info.pieceId ?? '—'}</td>
                                      <td>
                                        <span className="tag warn">{dispLabel}</span>
                                      </td>
                                      <td>{info.inspector || '—'}</td>
                                      <td>{info.reason || '—'}</td>
                                      <td className="num">{info.remnantId || '—'}</td>
                                      <td>
                                        <span className={`tag ${revoked ? '' : 'ok'}`}>
                                          {revoked ? '已撤销' : '生效中'}
                                        </span>
                                      </td>
                                      <td style={{ textAlign: 'right' }}>
                                        {!revoked && (d.id || d.dispositionId) ? (
                                          <button
                                            type="button"
                                            className="btn sm"
                                            style={{ color: 'var(--err, #b91c1c)' }}
                                            onClick={() =>
                                              onOpenRevokeDraft({
                                                reportId: row.reportId,
                                                taskName: row.taskName,
                                                dispositionId: String(d.id || d.dispositionId),
                                                pieceId: info.pieceId,
                                                dispositionLabel: dispLabel,
                                                inspector: info.inspector,
                                                origReason: info.reason,
                                                operator: '',
                                                reason: ''
                                              })
                                            }
                                          >
                                            撤销处置
                                          </button>
                                        ) : (
                                          <span className="muted" style={{ fontSize: 11.5 }}>
                                            {info.revokedReason
                                              ? `${info.revokedBy ? `${info.revokedBy} · ` : ''}${info.revokedReason}`
                                              : '—'}
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderTop: '1px solid var(--line-2, #e2e8f0)',
              fontSize: 12
            }}
          >
            <span className="muted num">
              每页 {reportPageSize} 笔 · 当前第 {pageStart}~{pageEnd} / 共 {reportTotal} 笔
            </span>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              <button
                type="button"
                className="btn sm"
                disabled={reportOffset <= 0 || loading}
                onClick={() => onPageChange(Math.max(0, reportOffset - reportPageSize))}
              >
                ← 上一页
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!reportHasMore || loading}
                onClick={() => onPageChange(reportOffset + reportPageSize)}
              >
                下一页 →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
