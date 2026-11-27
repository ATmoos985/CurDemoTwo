import React, { useMemo, useState } from 'react';
import { toast } from '../../lib/core/util.js';
import { AuthSession } from '../../utils/authClient';
import {
  BatchImportResult,
  BatchImportRowError,
  DefectRowInput,
  InventoryImportError,
  buildBatchErrorCsvText,
  canImportDefects,
  commitDefectsImport,
  downloadInventoryImportTemplate,
  downloadTextCsv,
  generateImportIdempotencyKey,
  parseBatchTableFile,
  previewDefectsImport
} from '../../utils/inventoryImportApi';
import { ModalDialog } from '../../components/ModalDialog';
import { OperationFeedbackCard } from '../../components/OperationFeedbackCard';
import { checkDefect01MmPrecision } from './inspectionTypes';

export interface InspectionBatchDefectModalProps {
  open: boolean;
  defaultRollId?: string;
  auth?: AuthSession | null;
  onClose: () => void;
  onSuccessRefresh: (affectedRollIds: string[]) => Promise<void>;
}

export const InspectionBatchDefectModal: React.FC<InspectionBatchDefectModalProps> = ({
  open,
  defaultRollId,
  auth,
  onClose,
  onSuccessRefresh
}) => {
  const canImport = canImportDefects(auth);
  const [rows, setRows] = useState<DefectRowInput[]>([]);
  const [sourceRowNumbers, setSourceRowNumbers] = useState<number[]>([]);
  const [localWarnings, setLocalWarnings] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateImportIdempotencyKey('defects'));
  const [busy, setBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<BatchImportResult | null>(null);
  const [commitResult, setCommitResult] = useState<BatchImportResult | null>(null);
  const [rowErrors, setRowErrors] = useState<BatchImportRowError[]>([]);
  const [feedback, setFeedback] = useState<{
    tone: 'err' | 'warn' | 'ok' | 'info';
    title: string;
    message: string;
    traceId?: string;
    status?: number;
  } | null>(null);

  const errorByIndex = useMemo(() => {
    const map = new Map<number, BatchImportRowError[]>();
    for (const err of rowErrors) {
      const list = map.get(err.rowIndex) || [];
      list.push(err);
      map.set(err.rowIndex, list);
    }
    return map;
  }, [rowErrors]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    setPreviewResult(null);
    setCommitResult(null);
    setRowErrors([]);
    try {
      const parsed = await parseBatchTableFile<DefectRowInput>(file, 'defects');
      const normalized = parsed.rows.map((r) => ({
        ...r,
        rollId: r.rollId || defaultRollId || ''
      }));
      setFileName(file.name);
      setRows(normalized);
      setSourceRowNumbers(parsed.sourceRowNumbers);
      setLocalWarnings(parsed.localWarnings);
      setIdempotencyKey(generateImportIdempotencyKey('defects'));
      toast(`已解析瑕疵表 ${file.name}：共 ${normalized.length} 条瑕疵`);
    } catch (err: any) {
      setRows([]);
      setFeedback({
        tone: 'err',
        title: '瑕疵表格解析失败',
        message: err?.message || '请下载标准模板检查列头。'
      });
    } finally {
      e.target.value = '';
    }
  };

  const handlePreview = async () => {
    if (!rows.length || busy) return;
    setBusy(true);
    setFeedback(null);
    setCommitResult(null);
    try {
      const res = await previewDefectsImport({
        operator: auth?.username || undefined,
        rows
      });
      setPreviewResult(res);
      setRowErrors(res.errors || []);
      if (res.valid) {
        setFeedback({
          tone: 'ok',
          title: '瑕疵服务端预检通过',
          message: `共 ${res.totalRows} 条瑕疵全部满足 0.1 mm 精度与母卷边界约束，可执行原子提交。`
        });
      } else {
        setFeedback({
          tone: 'warn',
          title: `预检发现 ${res.errorRows} 条错误`,
          message: '请修正下方高亮行或下载错误明细 CSV 后重试。'
        });
      }
    } catch (err: any) {
      if (err instanceof InventoryImportError) {
        setRowErrors(err.errors || []);
        setFeedback({
          tone: 'err',
          title: `预检失败（HTTP ${err.status}）`,
          message: err.message,
          traceId: err.traceId,
          status: err.status
        });
      } else {
        setFeedback({ tone: 'err', title: '预检请求失败', message: err?.message || '网络异常' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!rows.length || busy || !canImport) return;
    setBusy(true);
    setFeedback(null);
    try {
      const key = idempotencyKey.trim() || generateImportIdempotencyKey('defects');
      setIdempotencyKey(key);
      const res = await commitDefectsImport(
        { idempotencyKey: key, operator: auth?.username || undefined, rows },
        key
      );
      setCommitResult(res);
      setRowErrors(res.errors || []);
      setFeedback({
        tone: 'ok',
        title: res.idempotentReplay ? '幂等重放命中（未重复写入）' : '瑕疵批量原子提交成功',
        message: `单据 ${res.documentId || '—'} · 成功写入 ${res.importedCount} 处瑕疵。`
      });
      const affected = [...new Set(rows.map((r) => r.rollId).filter(Boolean) as string[])];
      await onSuccessRefresh(affected);
    } catch (err: any) {
      if (err instanceof InventoryImportError) {
        setRowErrors(err.errors || []);
        setFeedback({
          tone: 'err',
          title:
            err.status === 409
              ? '幂等键冲突（409）'
              : err.status === 403
              ? '权限不足（403）'
              : err.status === 401
              ? '登录已失效（401）'
              : `提交失败已整批回滚（HTTP ${err.status}）`,
          message: err.message,
          traceId: err.traceId,
          status: err.status
        });
      } else {
        setFeedback({ tone: 'err', title: '批量提交请求失败', message: err?.message || '网络异常' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadErrors = () => {
    if (!rowErrors.length) return;
    downloadTextCsv('defects-import-errors.csv', buildBatchErrorCsvText(rowErrors, sourceRowNumbers));
  };

  return (
    <ModalDialog
      open={open}
      title="批量导入母卷瑕疵（0.1 mm 精度）"
      onClose={() => {
        if (!busy) onClose();
      }}
      maxWidth={840}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="insp-batch-defects-modal">
        {!canImport && (
          <OperationFeedbackCard
            tone="warn"
            testId="insp-import-permission-alert"
            title="当前账号无权批量导入瑕疵（仅限 INSPECTOR / ADMIN）"
            message={`当前身份为 ${auth?.displayName || '未登录'}（${auth?.actorType === 'AGENT' ? 'AI Agent' : auth?.role || 'GUEST'}），服务端将拦截为 403 FORBIDDEN。`}
          />
        )}

        <div className="sec-feedback" style={{ fontSize: 12 }}>
          <strong>工业精度约束：瑕疵坐标 (x, y, w, h, margin) 严格校验 0.1 mm 步长</strong>
          <span>
            {defaultRollId ? `当前选中母卷 ${defaultRollId}（若表格中母卷号留空将自动填充）。` : '请在表格中指定目标母卷号。'}
            服务端将校验越界、已预留母卷保护及 <code>PRECISION_VIOLATION</code>，任一行失败整批原子回滚。
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="btn sm"
            data-testid="insp-import-template-xlsx-btn"
            onClick={() => downloadInventoryImportTemplate('defects', 'xlsx')}
          >
            下载瑕疵 Excel 模板 (.xlsx)
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid="insp-import-template-csv-btn"
            onClick={() => downloadInventoryImportTemplate('defects', 'csv')}
          >
            下载 CSV 模板 (.csv)
          </button>
          <label className="btn sm soft-accent" style={{ cursor: 'pointer' }}>
            选择瑕疵文件 (.xlsx / .csv)
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.tsv"
              hidden
              data-testid="insp-import-file-input"
              onChange={handleFileChange}
            />
          </label>
          {fileName && (
            <span className="num" style={{ fontSize: 12, color: 'var(--cp-ink-2)' }}>
              {fileName}（{rows.length} 行）
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="insp-batch-idemp" style={{ fontSize: 12, fontWeight: 600 }}>
            Idempotency-Key
          </label>
          <input
            id="insp-batch-idemp"
            type="text"
            className="field num"
            style={{ flex: 1, minWidth: 220 }}
            data-testid="insp-import-idempotency-key"
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => setIdempotencyKey(generateImportIdempotencyKey('defects'))}
          >
            重新生成 Key
          </button>
        </div>

        {localWarnings.length > 0 && (
          <div className="sec-feedback is-warn">
            <strong>0.1 mm 本地精度预检提示</strong>
            {localWarnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        {feedback && (
          <OperationFeedbackCard
            tone={feedback.tone}
            title={feedback.title}
            message={feedback.message}
            traceId={feedback.traceId}
            actions={[
              ...(feedback.status === 401
                ? [{ label: '前往登录', primary: true, onClick: () => { location.hash = '#/login'; } }]
                : []),
              ...(feedback.status === 409
                ? [
                    {
                      label: '重新生成幂等键',
                      primary: true,
                      onClick: () => setIdempotencyKey(generateImportIdempotencyKey('defects'))
                    }
                  ]
                : [])
            ]}
          />
        )}

        {rows.length > 0 && (
          <div className="mp-table-scroll" style={{ maxHeight: 200 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>Excel行</th>
                  <th>母卷号</th>
                  <th className="r">X / Y (mm)</th>
                  <th className="r">宽 × 高 (mm)</th>
                  <th className="r">外扩 (mm)</th>
                  <th>0.1mm 精度</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, idx) => {
                  const errs = errorByIndex.get(idx) || [];
                  const badPrecision = checkDefect01MmPrecision(r);
                  return (
                    <tr key={idx} style={errs.length ? { background: 'var(--err-bg)' } : undefined}>
                      <td className="num">{sourceRowNumbers[idx] ?? idx + 2}</td>
                      <td className="num">{r.rollId || '—'}</td>
                      <td className="r num">
                        {r.x ?? '—'} / {r.y ?? '—'}
                      </td>
                      <td className="r num">
                        {r.w ?? '—'} × {r.h ?? '—'}
                      </td>
                      <td className="r num">{r.margin ?? 0}</td>
                      <td>
                        {badPrecision.length > 0 ? (
                          <span className="tag warn">超 0.1mm ({badPrecision.join(',')})</span>
                        ) : (
                          <span className="tag ok">对齐</span>
                        )}
                      </td>
                      <td>
                        {errs.length > 0 ? (
                          <span className="tag err">{errs[0].message}</span>
                        ) : previewResult ? (
                          <span className="tag ok">预检通过</span>
                        ) : (
                          <span className="tag">待预检</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rowErrors.length > 0 && (
          <div className="mp-table-scroll" style={{ maxHeight: 160 }}>
            <table className="t" data-testid="insp-import-errors-table">
              <thead>
                <tr>
                  <th>Excel行(1-based)</th>
                  <th>批次索引(0-based)</th>
                  <th>字段</th>
                  <th>错误码</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {rowErrors.map((err, i) => (
                  <tr key={i}>
                    <td className="num">{sourceRowNumbers[err.rowIndex] ?? err.rowIndex + 2}</td>
                    <td className="num">{err.rowIndex}</td>
                    <td className="num">{err.field}</td>
                    <td className="num">{err.code}</td>
                    <td>{err.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {rowErrors.length > 0 && (
            <button
              type="button"
              className="btn sm"
              data-testid="insp-import-download-errors-btn"
              onClick={handleDownloadErrors}
            >
              下载错误明细 CSV
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn"
            data-testid="insp-import-preview-btn"
            disabled={busy || rows.length === 0 || rows.length > 500}
            onClick={handlePreview}
          >
            服务端只读预检
          </button>
          <button
            type="button"
            className="btn pri"
            data-testid="insp-import-commit-btn"
            disabled={busy || !canImport || rows.length === 0 || rows.length > 500 || Boolean(commitResult && !commitResult.idempotentReplay)}
            onClick={handleCommit}
          >
            确认原子提交瑕疵
          </button>
        </div>
      </div>
    </ModalDialog>
  );
};
