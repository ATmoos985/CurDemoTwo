import React, { useEffect, useMemo, useState } from 'react';
import { loadSheetLib } from '../../lib/core/util.js';
import {
  inspectDemandWorkbook,
  parseDemandCsv,
  parseDemandJSON,
  parseDemandWorkbook
} from '../../lib/domain/demand-import-model.js';
import { ModalDialog } from '../../components/ModalDialog';
import { OperationFeedbackCard } from '../../components/OperationFeedbackCard';
import {
  DEMAND_MAPPING_FIELDS,
  buildImportIssuesCsvText,
  triggerCsvFileDownload
} from './demandCreateTypes';

export interface DemandImportWizardModalProps {
  open: boolean;
  initialFile?: { name: string; buffer: ArrayBuffer } | null;
  onClose: () => void;
  onConfirmImport: (fileName: string, groups: any[]) => void;
}

export const DemandImportWizardModal: React.FC<DemandImportWizardModalProps> = ({
  open,
  initialFile = null,
  onClose,
  onConfirmImport
}) => {
  const [fileName, setFileName] = useState('');
  const [fileKind, setFileKind] = useState<'workbook' | 'csv' | 'json' | null>(null);
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [workbookObj, setWorkbookObj] = useState<any>(null);
  const [inspection, setInspection] = useState<any>(null);
  const [sheetName, setSheetName] = useState('');
  const [defaultUnit, setDefaultUnit] = useState<'mm' | 'cm' | 'm' | 'inch' | 'ft'>('mm');
  const [delimiter, setDelimiter] = useState<'AUTO' | ',' | ';' | '\t'>('AUTO');
  const [productTypeOverride, setProductTypeOverride] = useState<'AUTO' | 'RECT_2D' | 'SLITTING_1D'>('AUTO');
  const [bomRootQty, setBomRootQty] = useState<number>(1);
  const [bomRootCode, setBomRootCode] = useState<string>('');
  const [columnOverrides, setColumnOverrides] = useState<Record<string, string>>({});
  const [parseError, setParseError] = useState('');
  const [parsedResult, setParsedResult] = useState<any>(null);

  const loadFromFileData = async (name: string, buf: ArrayBuffer) => {
    setFileName(name);
    setRawBuffer(buf);
    setParseError('');
    setParsedResult(null);
    setColumnOverrides({});
    const lower = name.toLowerCase();
    try {
      if (lower.endsWith('.json')) {
        setFileKind('json');
        setWorkbookObj(null);
        setInspection(null);
        const text = new TextDecoder('utf-8').decode(buf);
        const res = parseDemandJSON(JSON.parse(text));
        setParsedResult(res);
      } else if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
        setFileKind('csv');
        setWorkbookObj(null);
        setInspection(null);
      } else {
        setFileKind('workbook');
        const XLSX = await loadSheetLib();
        const book = XLSX.read(buf, { type: 'array' });
        const insp = inspectDemandWorkbook(book, { xlsxUtils: XLSX.utils });
        setWorkbookObj({ book, xlsxUtils: XLSX.utils });
        setInspection(insp);
        setSheetName(insp.recommendedSheetName || insp.sheets[0]?.sheetName || '');
      }
    } catch (err: any) {
      setParseError(err?.message || '读取文件失败');
    }
  };

  useEffect(() => {
    if (open && initialFile) {
      loadFromFileData(initialFile.name, initialFile.buffer);
    }
  }, [open, initialFile]);

  useEffect(() => {
    if (!open || !fileKind || fileKind === 'json') return;
    setParseError('');
    try {
      const cleanOverrides: Record<string, string> = {};
      for (const [k, v] of Object.entries(columnOverrides)) {
        if (v !== '') cleanOverrides[k] = v;
      }
      const options: Record<string, any> = {
        defaultUnit,
        productTypeOverride,
        bomRootQty: Math.max(1, Number(bomRootQty) || 1),
        ...(bomRootCode.trim() ? { bomRootCode: bomRootCode.trim() } : {}),
        ...(Object.keys(cleanOverrides).length ? { columnOverrides: cleanOverrides } : {})
      };
      if (fileKind === 'csv' && rawBuffer) {
        if (delimiter !== 'AUTO') options.delimiter = delimiter;
        setParsedResult(parseDemandCsv(rawBuffer, options));
      } else if (fileKind === 'workbook' && workbookObj) {
        if (sheetName) options.sheetName = sheetName;
        options.xlsxUtils = workbookObj.xlsxUtils;
        setParsedResult(parseDemandWorkbook(workbookObj.book, options));
      }
    } catch (err: any) {
      setParsedResult(null);
      setParseError(err?.message || '解析需求工作表失败');
    }
  }, [
    open,
    fileKind,
    rawBuffer,
    workbookObj,
    sheetName,
    defaultUnit,
    delimiter,
    productTypeOverride,
    bomRootQty,
    bomRootCode,
    columnOverrides
  ]);

  const currentSheetMeta = useMemo(() => {
    if (!inspection?.sheets?.length) return null;
    return (
      inspection.sheets.find((s: any) => s.sheetName === sheetName) || inspection.sheets[0] || null
    );
  }, [inspection, sheetName]);

  const isBomMode = Boolean(
    currentSheetMeta?.format === 'BOM_TREE' ||
      String(parsedResult?.format || '').includes('BOM') ||
      (columnOverrides.bomParent && columnOverrides.bomChild && columnOverrides.bomUsage)
  );

  const validGroups = useMemo(
    () => (parsedResult?.groups || []).filter((g: any) => Array.isArray(g.demands) && g.demands.length > 0),
    [parsedResult]
  );

  const issues: any[] = parsedResult?.issues || [];

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      await loadFromFileData(file.name, buf);
    } finally {
      e.target.value = '';
    }
  };

  return (
    <ModalDialog open={open} title="生产级需求 / BOM 表格导入向导" onClose={onClose} maxWidth={900}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="demand-import-modal">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="btn sm soft-accent" style={{ cursor: 'pointer' }}>
            选择 Excel / CSV / JSON 文件
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.json"
              hidden
              data-testid="demand-import-file-input"
              onChange={handleFileInput}
            />
          </label>
          {fileName && (
            <span className="num" style={{ fontSize: 12, color: 'var(--cp-ink-2)' }}>
              {fileName}
              {parsedResult?.format ? ` · ${parsedResult.format}` : ''}
              {parsedResult?.encoding ? ` · 编码 ${parsedResult.encoding}` : ''}
              {parsedResult?.delimiter ? ` · 分隔符 ${JSON.stringify(parsedResult.delimiter)}` : ''}
            </span>
          )}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
            gap: 10
          }}
        >
          {fileKind === 'workbook' && inspection?.sheets?.length > 0 && (
            <div className="field-group">
              <label>工作表 (Sheet)</label>
              <select
                className="field"
                data-testid="demand-import-sheet-select"
                value={sheetName}
                onChange={(e) => {
                  setSheetName(e.target.value);
                  setColumnOverrides({});
                }}
              >
                {inspection.sheets.map((s: any) => (
                  <option key={s.sheetName} value={s.sheetName}>
                    {s.sheetName} ({s.format} · 评分{s.score}
                    {s.recommended ? ' · 推荐' : ''})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field-group">
            <label>默认尺寸单位</label>
            <select
              className="field"
              data-testid="demand-import-unit-select"
              value={defaultUnit}
              onChange={(e) => setDefaultUnit(e.target.value as any)}
            >
              <option value="mm">毫米 (mm)</option>
              <option value="cm">厘米 (cm)</option>
              <option value="m">米 (m)</option>
              <option value="inch">英寸 (inch)</option>
              <option value="ft">英尺 (ft)</option>
            </select>
          </div>

          {fileKind === 'csv' && (
            <div className="field-group">
              <label>CSV 分隔符</label>
              <select
                className="field"
                data-testid="demand-import-delimiter-select"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as any)}
              >
                <option value="AUTO">自动探测</option>
                <option value=",">逗号 (,)</option>
                <option value=";">分号 (;)</option>
                <option value={'\t'}>制表符 (Tab)</option>
              </select>
            </div>
          )}

          <div className="field-group">
            <label>产品维度覆写</label>
            <select
              className="field"
              data-testid="demand-import-type-select"
              value={productTypeOverride}
              onChange={(e) => setProductTypeOverride(e.target.value as any)}
            >
              <option value="AUTO">按表头与行内容自动识别</option>
              <option value="RECT_2D">强制二维排料 (RECT_2D)</option>
              <option value="SLITTING_1D">强制一维分切 (SLITTING_1D)</option>
            </select>
          </div>

          {isBomMode && (
            <>
              <div className="field-group">
                <label>BOM 根套件数量</label>
                <input
                  type="number"
                  min={1}
                  className="field num"
                  data-testid="demand-import-bom-root-qty"
                  value={bomRootQty}
                  onChange={(e) => setBomRootQty(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
              <div className="field-group">
                <label>指定根父件编码（选填）</label>
                <input
                  type="text"
                  className="field num"
                  placeholder="留空自动推导顶层"
                  data-testid="demand-import-bom-root-code"
                  value={bomRootCode}
                  onChange={(e) => setBomRootCode(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        {currentSheetMeta?.headers?.length > 0 && (
          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              列映射预览与手动覆写（已识别 {Object.keys(parsedResult?.detectedMapping || currentSheetMeta.detectedMapping || {}).length} 列）
            </summary>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 8,
                marginTop: 8
              }}
            >
              {DEMAND_MAPPING_FIELDS.map(({ field, label }) => {
                const detectedIdx = (parsedResult?.detectedMapping || currentSheetMeta.detectedMapping || {})[field];
                const currentVal =
                  columnOverrides[field] !== undefined
                    ? columnOverrides[field]
                    : detectedIdx !== undefined
                    ? String(detectedIdx)
                    : '';
                return (
                  <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>{label}</span>
                    <select
                      className="field"
                      value={currentVal}
                      onChange={(e) =>
                        setColumnOverrides((prev) => ({ ...prev, [field]: e.target.value }))
                      }
                    >
                      <option value="">（未映射）</option>
                      {currentSheetMeta.headers.map((h: string, idx: number) => (
                        <option key={idx} value={String(idx)}>
                          列{idx + 1}: {h || '(空)'}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </details>
        )}

        {parseError && (
          <OperationFeedbackCard tone="err" title="需求表格解析失败" message={parseError} />
        )}

        {parsedResult && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
            <span>
              有效型号分组：<b className="num">{validGroups.length}</b> 组
            </span>
            <span>
              有效规格行：<b className="num">{validGroups.reduce((s: number, g: any) => s + g.demands.length, 0)}</b> 行
            </span>
            {issues.length > 0 && (
              <span style={{ color: 'var(--err)' }}>
                待修正异常：<b className="num">{issues.length}</b> 条
              </span>
            )}
          </div>
        )}

        {issues.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="mp-table-scroll" style={{ maxHeight: 170 }}>
              <table className="t" data-testid="demand-import-issues-table">
                <thead>
                  <tr>
                    <th>工作表</th>
                    <th>行号</th>
                    <th>列</th>
                    <th>错误码</th>
                    <th>原因说明</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((it, i) => (
                    <tr key={i}>
                      <td>{it.sheetName || sheetName || '—'}</td>
                      <td className="num">{it.rowIndex ?? it.row ?? '—'}</td>
                      <td>{it.column || it.field || '—'}</td>
                      <td className="num">{it.code || 'INVALID'}</td>
                      <td>{it.reason || it.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <button
                type="button"
                className="btn sm"
                data-testid="demand-import-download-errors-btn"
                onClick={() =>
                  triggerCsvFileDownload('demand-import-errors.csv', buildImportIssuesCsvText(issues))
                }
              >
                下载错误明细 CSV ({issues.length})
              </button>
            </div>
          </div>
        )}

        {validGroups.length > 0 && (
          <div className="mp-table-scroll" style={{ maxHeight: 160 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>组序号</th>
                  <th>材料型号</th>
                  <th>维度</th>
                  <th className="r">规格行数</th>
                  <th>表面处理示例</th>
                </tr>
              </thead>
              <tbody>
                {validGroups.map((g: any, idx: number) => (
                  <tr key={idx}>
                    <td className="num">#{idx + 1}</td>
                    <td className="num">{g.materialModel}</td>
                    <td>
                      <span className={`tag ${g.dimension === 'SLITTING_1D' ? 'kind' : 'ok'}`}>
                        {g.dimension === 'SLITTING_1D' ? '1D 分切' : '2D 排料'}
                      </span>
                    </td>
                    <td className="r num">{g.demands.length}</td>
                    <td className="muted">
                      {g.demands.find((d: any) => d.surfaceTreatment)?.surfaceTreatment || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mp-modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn pri"
            data-testid="demand-import-confirm-btn"
            disabled={validGroups.length === 0}
            onClick={() => onConfirmImport(fileName || '需求表', validGroups)}
          >
            确认写入需求草稿 ({validGroups.length} 组)
          </button>
        </div>
      </div>
    </ModalDialog>
  );
};
