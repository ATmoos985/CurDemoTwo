import React, { useMemo, useState } from 'react';
import { toast } from '../../lib/core/util.js';
import { AuthSession } from '../../utils/authClient';
import {
  BatchImportResult,
  BatchImportRowError,
  InventoryImportError,
  RemnantRowInput,
  RollRowInput,
  buildBatchErrorCsvText,
  canImportRollsOrRemnants,
  commitRemnantsImport,
  commitRollsImport,
  downloadInventoryImportTemplate,
  downloadTextCsv,
  generateImportIdempotencyKey,
  parseBatchTableFile,
  previewRemnantsImport,
  previewRollsImport
} from '../../utils/inventoryImportApi';
import { OperationFeedbackCard } from '../../components/OperationFeedbackCard';

export interface InventoryBatchImportTabProps {
  kind: 'rolls' | 'remnants';
  auth?: AuthSession | null;
  onSuccessRefresh: () => Promise<void>;
  onClose: () => void;
}

export const InventoryBatchImportTab: React.FC<InventoryBatchImportTabProps> = ({
  kind,
  auth,
  onSuccessRefresh,
  onClose
}) => {
  const canImport = canImportRollsOrRemnants(auth);
  const [rows, setRows] = useState<Array<RollRowInput | RemnantRowInput>>([]);
  const [sourceRowNumbers, setSourceRowNumbers] = useState<number[]>([]);
  const [localWarnings, setLocalWarnings] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateImportIdempotencyKey(kind));
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
      const parsed = await parseBatchTableFile<RollRowInput | RemnantRowInput>(file, kind);
      setFileName(file.name);
      setRows(parsed.rows);
      setSourceRowNumbers(parsed.sourceRowNumbers);
      setLocalWarnings(parsed.localWarnings);
      setIdempotencyKey(generateImportIdempotencyKey(kind));
      toast(`已解析 ${file.name}：共 ${parsed.rows.length} 条${kind === 'rolls' ? '母卷' : '料头'}记录`);
    } catch (err: any) {
      setRows([]);
      setFeedback({
        tone: 'err',
        title: '表格解析失败',
        message: err?.message || '请对照标准模板检查表头与文件格式。'
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
      const body = { operator: auth?.username || undefined, rows: rows as any };
      const res =
        kind === 'rolls'
          ? await previewRollsImport(body)
          : await previewRemnantsImport(body);
      setPreviewResult(res);
      setRowErrors(res.errors || []);
      if (res.valid) {
        setFeedback({
          tone: 'ok',
          title: '服务端预检通过',
          message: `共 ${res.totalRows} 行全部校验合格，可执行原子提交入库。`
        });
      } else {
        setFeedback({
          tone: 'warn',
          title: `预检发现 ${res.errorRows} 行错误`,
          message: '请修正下方标红行或下载错误明细 CSV 调整后重新上传。'
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
      const key = idempotencyKey.trim() || generateImportIdempotencyKey(kind);
      setIdempotencyKey(key);
      const body = { idempotencyKey: key, operator: auth?.username || undefined, rows: rows as any };
      const res =
        kind === 'rolls'
          ? await commitRollsImport(body, key)
          : await commitRemnantsImport(body, key);
      setCommitResult(res);
      setRowErrors(res.errors || []);
      setFeedback({
        tone: 'ok',
        title: res.idempotentReplay ? '幂等重放命中（未重复入库）' : '批量原子提交成功',
        message: `单据 ${res.documentId || '—'} · 成功入库 ${res.importedCount} 条（版本 rev.${res.revision}）。`
      });
      await onSuccessRefresh();
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
    const csv = buildBatchErrorCsvText(rowErrors, sourceRowNumbers);
    downloadTextCsv(`${kind}-import-errors.csv`, csv);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!canImport && (
        <OperationFeedbackCard
          tone="warn"
          testId="inv-import-permission-alert"
          title="当前账号无权批量导入库存（仅限 WAREHOUSE / ADMIN）"
          message={`当前身份为 ${auth?.displayName || '未登录'}（${auth?.actorType === 'AGENT' ? 'AI Agent' : auth?.role || 'GUEST'}），服务端将拦截为 403 FORBIDDEN。您可以下载模板或预览表格，但已禁止提交。`}
        />
      )}

      <div className="sec-feedback" style={{ fontSize: 12 }}>
        <strong>物理单位强提醒：批量导入全部尺寸均使用毫米 (mm)</strong>
        <span>
          母卷批量接口的幅宽、整卷总长、已用长度、剩余长度均为 <b>mm</b>（与单卷入库的米不同）；若导入表格表头标注了 <code>(m)</code> / <code>(cm)</code>，客户端会自动换算为 <b>mm</b>。单批上限 500 行，任意一行出错整批原子回滚。
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className="btn sm"
          data-testid="inv-import-template-xlsx-btn"
          onClick={() => downloadInventoryImportTemplate(kind, 'xlsx')}
        >
          下载 {kind === 'rolls' ? '母卷' : '料头'} Excel 模板 (.xlsx)
        </button>
        <button
          type="button"
          className="btn sm"
          data-testid="inv-import-template-csv-btn"
          onClick={() => downloadInventoryImportTemplate(kind, 'csv')}
        >
          下载 CSV 模板 (.csv)
        </button>
        <label className="btn sm soft-accent" style={{ cursor: 'pointer' }}>
          选择待导入文件 (.xlsx / .csv)
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            hidden
            data-testid="inv-import-file-input"
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
        <label htmlFor="inv-batch-idemp" style={{ fontSize: 12, fontWeight: 600 }}>
          Idempotency-Key
        </label>
        <input
          id="inv-batch-idemp"
          type="text"
          className="field num"
          style={{ flex: 1, minWidth: 220 }}
          data-testid="inv-import-idempotency-key"
          value={idempotencyKey}
          onChange={(e) => setIdempotencyKey(e.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          onClick={() => setIdempotencyKey(generateImportIdempotencyKey(kind))}
        >
          重新生成 Key
        </button>
      </div>

      {localWarnings.length > 0 && (
        <div className="sec-feedback is-warn">
          <strong>本地解析提示</strong>
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
          testId="inv-batch-error-banner"
          actions={[
            ...(feedback.status === 401
              ? [{ label: '前往登录', primary: true, onClick: () => { location.hash = '#/login'; } }]
              : []),
            ...(feedback.status === 409
              ? [
                  {
                    label: '重新生成幂等键',
                    primary: true,
                    onClick: () => setIdempotencyKey(generateImportIdempotencyKey(kind))
                  }
                ]
              : [])
          ]}
        />
      )}

      {rows.length > 0 && (
        <div className="mp-table-scroll" style={{ maxHeight: 220 }}>
          <table className="t" data-testid="inv-batch-preview-table">
            <thead>
              <tr>
                <th>Excel行</th>
                <th>批次#</th>
                <th>{kind === 'rolls' ? '母卷号' : '料头号'}</th>
                <th>材料型号</th>
                <th className="r">幅宽(mm)</th>
                <th className="r">{kind === 'rolls' ? '总长/剩余(mm)' : '长度(mm)'}</th>
                <th>校验状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row: any, idx) => {
                const errs = errorByIndex.get(idx) || [];
                const excelRow = sourceRowNumbers[idx] ?? idx + 2;
                return (
                  <tr
                    key={idx}
                    style={errs.length ? { background: 'var(--err-bg)' } : undefined}
                  >
                    <td className="num">{excelRow}</td>
                    <td className="num">#{idx}</td>
                    <td className="num">{kind === 'rolls' ? row.rollId || '自动' : row.id || '自动'}</td>
                    <td>{kind === 'rolls' ? row.rollModel || '—' : row.materialBatch || row.sourceRollId || '—'}</td>
                    <td className="r num">{row.width ?? '—'}</td>
                    <td className="r num">
                      {kind === 'rolls'
                        ? `${row.totalLength ?? '—'} / ${row.currentRemainingLength ?? row.totalLength ?? '—'}`
                        : row.length ?? '—'}
                    </td>
                    <td>
                      {errs.length > 0 ? (
                        <span className="tag err">{errs[0].field}: {errs[0].message}</span>
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
          <table className="t" data-testid="inv-import-errors-table">
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
            data-testid="inv-import-download-errors-btn"
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
          data-testid="inv-import-preview-btn"
          disabled={busy || rows.length === 0 || rows.length > 500}
          onClick={handlePreview}
        >
          服务端只读预检
        </button>
        <button
          type="button"
          className="btn pri"
          data-testid="inv-import-commit-btn"
          disabled={busy || !canImport || rows.length === 0 || rows.length > 500 || Boolean(commitResult && !commitResult.idempotentReplay)}
          onClick={handleCommit}
        >
          确认原子提交入库
        </button>
      </div>
    </div>
  );
};
