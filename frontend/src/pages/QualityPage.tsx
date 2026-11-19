import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, shortId } from '@static/app/js/util.js';
import {
  reviewablePieces,
  effectivePieceResults,
  receiptSummary
} from '@static/app/js/model/quality.js';
import { CodeBadge } from '../components/ui/MagpiePrimitives';

interface ReportRow {
  task: any;
  report: any;
}

export const QualityPage: React.FC = () => {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);

  const loadQualityReports = async () => {
    setLoading(true);
    setError(null);
    try {
      const summaries = ((await requestJSON('/api/cutting/task-summaries')) || []).filter(
        (r: any) => r.reportCount > 0
      );
      const details = await Promise.all(
        summaries.map((s: any) =>
          requestJSON('/api/cutting/tasks/' + encodeURIComponent(s.task.id))
        )
      );
      const allRows: ReportRow[] = details.flatMap((d: any) =>
        (d.reports || []).map((r: any) => ({ task: d.task, report: r }))
      );
      setRows(allRows);
    } catch (e: any) {
      setError(e.message || '读取复检报工列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadQualityReports();
  }, []);

  const filteredList = useMemo(() => {
    return rows
      .filter(
        (x) =>
          x.report.status !== 'REVERSED' &&
          (!onlyOpen || reviewablePieces(x.report).length > 0)
      )
      .sort((a, b) =>
        String(b.report.confirmedAt || '').localeCompare(String(a.report.confirmedAt || ''))
      );
  }, [rows, onlyOpen]);

  return (
    <div className="react-page mp-legacy-page">
      <div className="mp-page-shell">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>复检处置</h1>
            <span
              className="mp-page-summary"
              title="已报良品发现不良时可报废或转料头；原报工与母卷耗用保留，完成量扣回形成补产"
            >
              已报工产出质量重分类 · {filteredList.length} 张报工单
            </span>
          </div>
        </div>

        <div className="mp-filter-toolbar">
          <label className="mp-switch-label">
            <input
              type="checkbox"
              className="ux-switch"
              checked={onlyOpen}
              onChange={(e) => setOnlyOpen(e.target.checked)}
            />
            <span>只看仍可复检的报工</span>
          </label>
          <div className="mp-toolbar-actions">
            <button type="button" className="btn" onClick={loadQualityReports}>
              刷新列表
            </button>
          </div>
        </div>

        {error ? (
          <div className="error-box" role="alert">
            <b>操作未完成</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="mp-demand-card">
            <div className="loading">正在读取报工回执与可复检裁片…</div>
          </div>
        ) : filteredList.length > 0 ? (
          <div className="mp-demand-card">
            <table className="t">
              <thead>
                <tr>
                  <th>报工单</th>
                  <th>任务</th>
                  <th>母卷 / 料头</th>
                  <th className="r">实切 mm</th>
                  <th className="r">合格</th>
                  <th className="r">异常</th>
                  <th className="r">可复检</th>
                  <th className="r">已复检</th>
                  <th>时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredList.map(({ task, report }) => {
                  const s = receiptSummary(report, effectivePieceResults);
                  const revCount = reviewablePieces(report).length;
                  return (
                    <tr key={report.planId}>
                      <td>
                        <CodeBadge>{shortId(report.planId)}</CodeBadge>
                      </td>
                      <td style={{ fontWeight: 600 }}>{task.name}</td>
                      <td className="num">
                        {report.rollId || report.sourceRemnantId || '—'}
                      </td>
                      <td className="r num">{Math.round(report.actualCutLen || 0)}</td>
                      <td className="r num">{s.qualified}</td>
                      <td className="r num">{s.rejected}</td>
                      <td className="r num">{revCount}</td>
                      <td className="r num">{s.dispositions}</td>
                      <td className="num">
                        {String(report.confirmedAt || '')
                          .replace('T', ' ')
                          .slice(5, 16)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <a
                          className="btn sm soft-accent"
                          href={`#/execution/${encodeURIComponent(task.id)}/${encodeURIComponent(
                            report.planId
                          )}?intent=quality`}
                        >
                          打开处置
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mp-demand-card">
            <div className="empty">没有需要复检的报工</div>
          </div>
        )}
      </div>
    </div>
  );
};
