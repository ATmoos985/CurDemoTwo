import { csvCell } from '@static/js/business/analysis/report-model.js';

export interface NormalizedReconciliationReportRow {
  reportId: string;
  taskId: string;
  taskName: string;
  materialModel: string;
  batchNo: string;
  report: any;
  dispositions: any[];
  reviewableCountHint?: number;
}

/**
 * 适配 `GET /api/v2/reconciliation/reports?limit=&offset=` 的单条聚合报工记录，
 * 同时兼容嵌套 `{ report, task, ... }` 与扁平展开形态。
 */
export function normalizeReconciliationReportItem(item: any): NormalizedReconciliationReportRow | null {
  if (!item || typeof item !== 'object') return null;
  const rawReport = item.report && typeof item.report === 'object' ? item.report : item;
  const reportId = String(rawReport.planId || item.reportId || item.planId || rawReport.id || '');
  if (!reportId) return null;

  const dispositions = Array.isArray(rawReport.qualityDispositions)
    ? rawReport.qualityDispositions
    : Array.isArray(item.dispositions)
    ? item.dispositions
    : [];

  const normalizedReport = {
    ...rawReport,
    planId: reportId,
    qualityDispositions: dispositions,
    pieceResults: Array.isArray(rawReport.pieceResults) ? rawReport.pieceResults : []
  };

  return {
    reportId,
    taskId: String(item.taskId || item.task?.id || rawReport.taskId || ''),
    taskName: String(item.taskName || item.task?.name || rawReport.taskName || '未命名需求族'),
    materialModel: String(item.materialModel || item.task?.materialModel || rawReport.materialModel || ''),
    batchNo: String(item.batchNo || rawReport.batchNo || ''),
    report: normalizedReport,
    dispositions,
    reviewableCountHint:
      typeof item.reviewableCount === 'number'
        ? item.reviewableCount
        : typeof item.reviewablePiecesCount === 'number'
        ? item.reviewablePiecesCount
        : undefined
  };
}

export function isDispositionRevoked(disp: any): boolean {
  if (!disp || typeof disp !== 'object') return false;
  return Boolean(
    disp.revocation ||
      disp.revoked ||
      disp.revokedAt ||
      String(disp.status || '').toUpperCase() === 'REVOKED'
  );
}

export interface NormalizedDispositionView {
  id: string;
  pieceId?: number | string;
  disposition: string;
  inspector: string;
  reason: string;
  remnantId: string;
  revoked: boolean;
  revokedBy: string;
  revokedReason: string;
}

/** 统一兼容后端嵌套 `QualityDisposition{id, command, remnantId, revocation}` 与扁平形态。 */
export function readDispositionFields(disp: any, fallbackIdx = 0): NormalizedDispositionView {
  const cmd = disp?.command && typeof disp.command === 'object' ? disp.command : disp || {};
  const rev = disp?.revocation && typeof disp.revocation === 'object' ? disp.revocation : null;
  return {
    id: String(disp?.id || disp?.dispositionId || fallbackIdx),
    pieceId: cmd.pieceId ?? disp?.pieceId,
    disposition: String(cmd.disposition || disp?.disposition || ''),
    inspector: String(cmd.inspector || disp?.inspector || ''),
    reason: String(cmd.reason || disp?.reason || ''),
    remnantId: String(disp?.remnantId || disp?.recoveredRemnantId || ''),
    revoked: isDispositionRevoked(disp),
    revokedBy: String(rev?.operator || disp?.revokedBy || ''),
    revokedReason: String(rev?.reason || disp?.revokedReason || '')
  };
}

/**
 * 构造安全转义的对账流水 CSV（统一通过 `csvCell` 抵御逗号/引号/公式注入，并附带已加载范围元数据）。
 */
export function buildLedgerCsvText(
  ledgerItems: any[],
  options?: { hasMore?: boolean }
): { csv: string; rangeLabel: string } {
  const cols = ['sequence', 'eventType', 'aggregateType', 'aggregateId', 'actor', 'occurredAt'];
  const headerLabels = ['序号', '事件类型', '账本对象', '对象编号', '操作方', '过账时间'];
  const seqs = ledgerItems
    .map((x) => Number(x?.sequence))
    .filter((n) => Number.isFinite(n));
  const minSeq = seqs.length ? Math.min(...seqs) : 0;
  const maxSeq = seqs.length ? Math.max(...seqs) : 0;
  const rangeLabel = seqs.length
    ? `已加载 ${ledgerItems.length} 条（序号 #${minSeq}~#${maxSeq}${options?.hasMore ? '，尚有更多未加载' : '，已全部加载'}）`
    : `已加载 ${ledgerItems.length} 条`;

  const lines = [
    headerLabels.map((h) => csvCell(h)).join(','),
    ...ledgerItems.map((it) => cols.map((k) => csvCell(it?.[k])).join(','))
  ];
  return {
    csv: '\uFEFF' + lines.join('\n'),
    rangeLabel
  };
}
