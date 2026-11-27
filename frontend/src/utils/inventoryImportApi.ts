import { createUuid, loadSheetLib } from '../lib/core/util.js';
import { decodeTextBuffer, parseDelimitedText } from '../lib/domain/demand-import-csv.js';
import { csvCell } from '../lib/domain/report-model.js';
import { AuthSession, buildAuthHeaders, getAuthToken } from './authClient';

export type BatchImportKind = 'rolls' | 'remnants' | 'defects';

export interface RollRowInput {
  rollId?: string;
  rollModel?: string;
  batchNo?: string;
  supplier?: string;
  materialName?: string;
  color?: string;
  grammage?: number;
  composition?: string;
  shrinkageRate?: number;
  width?: number;
  rawWidth?: number;
  totalLength?: number;
  usedLength?: number;
  currentRemainingLength?: number;
  scrappedLengthMm?: number;
  storageLocation?: string;
  inspectionStatus?: string;
  inspector?: string;
  inspectionDate?: string;
  unitPricePerMeter?: number;
  unitPricePerSqm?: number;
}

export interface RemnantRowInput {
  id?: string;
  width?: number;
  length?: number;
  location?: string;
  materialBatch?: string;
  status?: string;
  sourceRollId?: string;
  parentRemnantId?: string;
  generation?: number;
  qualityGrade?: string;
  hasDefect?: boolean;
  defectDesc?: string;
  batchNo?: string;
  color?: string;
}

export interface DefectRowInput {
  rollId?: string;
  captureId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  margin?: number;
  defectType?: string;
  typeName?: string;
  severity?: number;
  points?: number;
  detectionSource?: string;
  avoidanceStrategy?: string;
  description?: string;
}

export interface BatchImportRequest<R> {
  idempotencyKey?: string;
  operator?: string;
  rows: R[];
}

export interface BatchImportRowError {
  rowIndex: number; // 0-based
  field: string;
  code: string;
  message: string;
}

export interface BatchImportResult {
  importType: string;
  dryRun: boolean;
  valid: boolean;
  idempotencyKey?: string;
  idempotentReplay: boolean;
  documentId?: string;
  revision: number;
  totalRows: number;
  validRows: number;
  errorRows: number;
  importedCount: number;
  skippedCount: number;
  errors: BatchImportRowError[];
  createdIds: string[];
}

export class InventoryImportError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  readonly retryable: boolean;
  readonly errors: BatchImportRowError[];

  constructor(
    message: string,
    status: number,
    code = 'BATCH_IMPORT_ERROR',
    errors: BatchImportRowError[] = [],
    traceId?: string,
    retryable = false
  ) {
    super(message);
    this.name = 'InventoryImportError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.traceId = traceId;
    this.retryable = retryable;
  }
}

export function canImportRollsOrRemnants(auth?: AuthSession | null): boolean {
  if (!auth || !auth.enabled) return true;
  if (!auth.authenticated) return false;
  if (String(auth.actorType || '').toUpperCase() === 'AGENT') return false;
  const role = String(auth.role || '').toUpperCase();
  return role === 'WAREHOUSE' || role === 'ADMIN';
}

export function canImportDefects(auth?: AuthSession | null): boolean {
  if (!auth || !auth.enabled) return true;
  if (!auth.authenticated) return false;
  if (String(auth.actorType || '').toUpperCase() === 'AGENT') return false;
  const role = String(auth.role || '').toUpperCase();
  return role === 'INSPECTOR' || role === 'ADMIN';
}

export function generateImportIdempotencyKey(kind: BatchImportKind): string {
  return `IMP-${kind.toUpperCase()}-${createUuid()}`;
}

type FetchFn = typeof fetch;

export async function postInventoryImport<R>(
  endpoint: string,
  body: BatchImportRequest<R>,
  options: { idempotencyKey?: string; isCommit?: boolean } = {},
  fetchImpl: FetchFn = globalThis.fetch
): Promise<BatchImportResult> {
  const token = getAuthToken();
  const isCommit = options.isCommit ?? !endpoint.endsWith('/preview');
  const effectiveKey = isCommit
    ? String(options.idempotencyKey || body.idempotencyKey || generateImportIdempotencyKey('rolls')).trim()
    : body.idempotencyKey;

  const headers = buildAuthHeaders(
    {
      'Content-Type': 'application/json',
      ...(isCommit && effectiveKey ? { 'Idempotency-Key': effectiveKey } : {})
    },
    token
  );

  const nextBody: BatchImportRequest<R> = {
    ...body,
    ...(isCommit && effectiveKey ? { idempotencyKey: effectiveKey } : {})
  };

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    cache: 'no-store',
    headers,
    body: JSON.stringify(nextBody)
  });

  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const errors: BatchImportRowError[] = Array.isArray(payload?.errors)
      ? payload.errors.map((e: any) => ({
          rowIndex: Number(e?.rowIndex ?? 0),
          field: String(e?.field || ''),
          code: String(e?.code || ''),
          message: String(e?.message || '')
        }))
      : [];
    const fallback =
      res.status === 401
        ? '身份认证已过期，请重新登录（401）'
        : res.status === 403
        ? '当前账号无权执行该批量导入操作（403）'
        : res.status === 409
        ? '幂等键冲突：相同 Idempotency-Key 被用于不同载荷或已变更数据（409）'
        : `批量导入失败（HTTP ${res.status}）`;
    throw new InventoryImportError(
      String(payload?.message || fallback),
      res.status,
      String(payload?.code || `HTTP_${res.status}`),
      errors,
      payload?.traceId ? String(payload.traceId) : undefined,
      Boolean(payload?.retryable)
    );
  }

  return payload as BatchImportResult;
}

export const previewRollsImport = (body: BatchImportRequest<RollRowInput>, fetchImpl?: FetchFn) =>
  postInventoryImport('/api/v2/inventory/import/rolls/preview', body, { isCommit: false }, fetchImpl);

export const commitRollsImport = (
  body: BatchImportRequest<RollRowInput>,
  idempotencyKey: string,
  fetchImpl?: FetchFn
) => postInventoryImport('/api/v2/inventory/import/rolls', body, { idempotencyKey, isCommit: true }, fetchImpl);

export const previewRemnantsImport = (body: BatchImportRequest<RemnantRowInput>, fetchImpl?: FetchFn) =>
  postInventoryImport('/api/v2/inventory/import/remnants/preview', body, { isCommit: false }, fetchImpl);

export const commitRemnantsImport = (
  body: BatchImportRequest<RemnantRowInput>,
  idempotencyKey: string,
  fetchImpl?: FetchFn
) => postInventoryImport('/api/v2/inventory/import/remnants', body, { idempotencyKey, isCommit: true }, fetchImpl);

export const previewDefectsImport = (body: BatchImportRequest<DefectRowInput>, fetchImpl?: FetchFn) =>
  postInventoryImport('/api/v2/inventory/import/defects/preview', body, { isCommit: false }, fetchImpl);

export const commitDefectsImport = (
  body: BatchImportRequest<DefectRowInput>,
  idempotencyKey: string,
  fetchImpl?: FetchFn
) => postInventoryImport('/api/v2/inventory/import/defects', body, { idempotencyKey, isCommit: true }, fetchImpl);

const ROLL_HEADER_MAP: Record<string, keyof RollRowInput> = {
  rollid: 'rollId',
  母卷号: 'rollId',
  卷号: 'rollId',
  rollmodel: 'rollModel',
  材料型号: 'rollModel',
  型号: 'rollModel',
  品号: 'rollModel',
  batchno: 'batchNo',
  缸号: 'batchNo',
  批号: 'batchNo',
  supplier: 'supplier',
  供应商: 'supplier',
  materialname: 'materialName',
  物料名称: 'materialName',
  color: 'color',
  颜色: 'color',
  色号: 'color',
  grammage: 'grammage',
  克重: 'grammage',
  composition: 'composition',
  成分: 'composition',
  shrinkagerate: 'shrinkageRate',
  缩率: 'shrinkageRate',
  缩水率: 'shrinkageRate',
  width: 'width',
  有效幅宽: 'width',
  幅宽: 'width',
  rawwidth: 'rawWidth',
  门幅: 'rawWidth',
  毛幅宽: 'rawWidth',
  totallength: 'totalLength',
  整卷总长: 'totalLength',
  总长: 'totalLength',
  usedlength: 'usedLength',
  已用长度: 'usedLength',
  已切长度: 'usedLength',
  currentremaininglength: 'currentRemainingLength',
  剩余长度: 'currentRemainingLength',
  当前余长: 'currentRemainingLength',
  scrappedlengthmm: 'scrappedLengthMm',
  报废长度: 'scrappedLengthMm',
  storagelocation: 'storageLocation',
  库位: 'storageLocation',
  仓位: 'storageLocation',
  inspectionstatus: 'inspectionStatus',
  质检状态: 'inspectionStatus',
  inspector: 'inspector',
  质检员: 'inspector',
  inspectiondate: 'inspectionDate',
  质检日期: 'inspectionDate',
  unitpricepermeter: 'unitPricePerMeter',
  米单价: 'unitPricePerMeter',
  unitpricepersqm: 'unitPricePerSqm',
  平米单价: 'unitPricePerSqm'
};

const REMNANT_HEADER_MAP: Record<string, keyof RemnantRowInput> = {
  id: 'id',
  料头号: 'id',
  料头编号: 'id',
  width: 'width',
  幅宽: 'width',
  宽度: 'width',
  length: 'length',
  长度: 'length',
  余长: 'length',
  location: 'location',
  库位: 'location',
  materialbatch: 'materialBatch',
  材料型号: 'materialBatch',
  品号: 'materialBatch',
  型号: 'materialBatch',
  status: 'status',
  状态: 'status',
  sourcerollid: 'sourceRollId',
  来源母卷: 'sourceRollId',
  来源母卷号: 'sourceRollId',
  parentremnantid: 'parentRemnantId',
  父料头: 'parentRemnantId',
  父料头号: 'parentRemnantId',
  generation: 'generation',
  代次: 'generation',
  qualitygrade: 'qualityGrade',
  等级: 'qualityGrade',
  质量等级: 'qualityGrade',
  hasdefect: 'hasDefect',
  含疵点: 'hasDefect',
  defectdesc: 'defectDesc',
  疵点说明: 'defectDesc',
  batchno: 'batchNo',
  缸号: 'batchNo',
  color: 'color',
  颜色: 'color'
};

const DEFECT_HEADER_MAP: Record<string, keyof DefectRowInput> = {
  rollid: 'rollId',
  母卷号: 'rollId',
  卷号: 'rollId',
  captureid: 'captureId',
  采集号: 'captureId',
  抓拍号: 'captureId',
  x: 'x',
  y: 'y',
  w: 'w',
  宽: 'w',
  宽度: 'w',
  h: 'h',
  高: 'h',
  高度: 'h',
  长: 'h',
  长度: 'h',
  margin: 'margin',
  安全边距: 'margin',
  边距: 'margin',
  defecttype: 'defectType',
  瑕疵类型: 'defectType',
  瑕疵代码: 'defectType',
  typename: 'typeName',
  类型名称: 'typeName',
  瑕疵名称: 'typeName',
  severity: 'severity',
  严重度: 'severity',
  points: 'points',
  扣分: 'points',
  detectionsource: 'detectionSource',
  来源: 'detectionSource',
  检测来源: 'detectionSource',
  avoidancestrategy: 'avoidanceStrategy',
  避让策略: 'avoidanceStrategy',
  description: 'description',
  描述: 'description',
  备注: 'description'
};

const HEADER_UNIT_RE = /[(（\[【]\s*(mm|cm|m)\s*[)）\]】]/i;

function normalizeHeaderMeta(raw: unknown): { key: string; unit: 'mm' | 'cm' | 'm' | null } {
  const s = String(raw ?? '').trim();
  const unitMatch = s.match(HEADER_UNIT_RE);
  const unit = unitMatch ? (unitMatch[1].toLowerCase() as 'mm' | 'cm' | 'm') : null;
  const key = s
    .replace(/[(（\[【][^()（）\[\]【】]*[)）\]】]/g, '')
    .replace(/[\s_\-:：/]+/g, '')
    .toLowerCase();
  return { key, unit };
}

function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toBool(v: unknown): boolean | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (['true', '1', 'yes', 'y', '是'].includes(s)) return true;
  if (['false', '0', 'no', 'n', '否'].includes(s)) return false;
  return undefined;
}

function convertUnitToMm(value: number | undefined, unit: 'mm' | 'cm' | 'm' | null): number | undefined {
  if (value === undefined) return undefined;
  if (unit === 'm') return Math.round(value * 1000 * 1000) / 1000;
  if (unit === 'cm') return Math.round(value * 10 * 1000) / 1000;
  return value;
}

export function isAlignedTo01Mm(val: number | undefined): boolean {
  if (val === undefined || !Number.isFinite(val)) return true;
  return Math.abs(val * 10 - Math.round(val * 10)) <= 1e-6;
}

export interface ParsedBatchTable<R> {
  rows: R[];
  sourceRowNumbers: number[]; // 1-based Excel/CSV line number corresponding to rows[i]
  localWarnings: string[];
}

const LENGTH_FIELDS_BY_KIND: Record<BatchImportKind, Set<string>> = {
  rolls: new Set(['width', 'rawWidth', 'totalLength', 'usedLength', 'currentRemainingLength', 'scrappedLengthMm']),
  remnants: new Set(['width', 'length']),
  defects: new Set(['x', 'y', 'w', 'h', 'margin'])
};

export function parseBatchMatrix<R>(
  matrix: unknown[][],
  kind: BatchImportKind
): ParsedBatchTable<R> {
  if (!Array.isArray(matrix) || matrix.length < 2) {
    throw new Error('表格至少需要 1 行表头与 1 行数据。');
  }
  const headerIdx = matrix.findIndex(
    (r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== '')
  );
  if (headerIdx < 0) {
    throw new Error('未在文件中发现有效表头行。');
  }
  const headerRow = matrix[headerIdx];
  const mapDict =
    kind === 'rolls'
      ? ROLL_HEADER_MAP
      : kind === 'remnants'
      ? REMNANT_HEADER_MAP
      : DEFECT_HEADER_MAP;

  const colDefs: Array<{ index: number; field: string; unit: 'mm' | 'cm' | 'm' | null }> = [];
  const localWarnings: string[] = [];
  let convertedUnitCols = 0;

  headerRow.forEach((cell, idx) => {
    const { key, unit } = normalizeHeaderMeta(cell);
    const field = (mapDict as Record<string, string>)[key];
    if (field) {
      colDefs.push({ index: idx, field, unit });
      if (unit && (unit === 'm' || unit === 'cm') && LENGTH_FIELDS_BY_KIND[kind].has(field)) {
        convertedUnitCols++;
      }
    }
  });

  if (colDefs.length < 2) {
    throw new Error('未能识别出有效的批量导入列头，请先下载标准模板对照表头填写。');
  }
  if (convertedUnitCols > 0) {
    localWarnings.push(`检测到 ${convertedUnitCols} 个非 mm 单位列（m / cm），客户端已自动换算为毫米 (mm)。`);
  }

  const rows: R[] = [];
  const sourceRowNumbers: number[] = [];
  const numericFields = new Set([
    'grammage',
    'shrinkageRate',
    'width',
    'rawWidth',
    'totalLength',
    'usedLength',
    'currentRemainingLength',
    'scrappedLengthMm',
    'unitPricePerMeter',
    'unitPricePerSqm',
    'length',
    'generation',
    'x',
    'y',
    'w',
    'h',
    'margin',
    'severity',
    'points'
  ]);
  const intFields = new Set(['generation', 'severity', 'points']);

  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const rawRow = matrix[r];
    if (!Array.isArray(rawRow) || !rawRow.some((c) => String(c ?? '').trim() !== '')) {
      continue;
    }
    const obj: Record<string, unknown> = {};
    for (const def of colDefs) {
      const val = rawRow[def.index];
      const str = String(val ?? '').trim();
      if (!str) continue;
      if (def.field === 'hasDefect') {
        const b = toBool(val);
        if (b !== undefined) obj[def.field] = b;
      } else if (numericFields.has(def.field)) {
        const num = toNum(val);
        if (num !== undefined) {
          if (intFields.has(def.field)) {
            obj[def.field] = Math.trunc(num);
          } else if (LENGTH_FIELDS_BY_KIND[kind].has(def.field)) {
            obj[def.field] = convertUnitToMm(num, def.unit);
          } else {
            obj[def.field] = num;
          }
        }
      } else {
        obj[def.field] = str;
      }
    }

    if (kind === 'defects') {
      const defect = obj as DefectRowInput;
      const non01 = (['x', 'y', 'w', 'h', 'margin'] as const).filter(
        (f) => defect[f] !== undefined && !isAlignedTo01Mm(defect[f])
      );
      if (non01.length > 0) {
        localWarnings.push(
          `第 ${r + 1} 行坐标 (${non01.join(', ')}) 超过 0.1 mm 工业精度，提交预检将被拒绝。`
        );
      }
    }

    rows.push(obj as R);
    sourceRowNumbers.push(r + 1);
  }

  if (rows.length === 0) {
    throw new Error('文件中没有包含有效数据行。');
  }
  if (rows.length > 500) {
    localWarnings.push(`当前共解析 ${rows.length} 行，超过单批上限 500 行，请拆分为多批导入。`);
  }

  return { rows, sourceRowNumbers, localWarnings };
}

export async function parseBatchTableFile<R>(
  file: File,
  kind: BatchImportKind
): Promise<ParsedBatchTable<R>> {
  const lower = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const decoded = decodeTextBuffer(buf);
    const { rows } = parseDelimitedText(decoded.text);
    return parseBatchMatrix<R>(rows, kind);
  }
  const XLSX = await loadSheetLib();
  const book = XLSX.read(buf, { type: 'array' });
  const firstSheet = book.SheetNames?.[0];
  if (!firstSheet) {
    throw new Error('工作簿中不包含可读工作表。');
  }
  const matrix = XLSX.utils.sheet_to_json(book.Sheets[firstSheet], { header: 1, defval: '' });
  return parseBatchMatrix<R>(matrix, kind);
}

const TEMPLATE_DATA: Record<BatchImportKind, { fileNameBase: string; sheetName: string; aoa: (string | number)[][] }> = {
  rolls: {
    fileNameBase: 'mother-rolls-import-template-mm',
    sheetName: '母卷批量导入(mm)',
    aoa: [
      [
        '母卷号',
        '材料型号',
        '缸号',
        '颜色',
        '有效幅宽(mm)',
        '整卷总长(mm)',
        '已用长度(mm)',
        '剩余长度(mm)',
        '报废长度(mm)',
        '库位',
        '质检状态',
        '供应商'
      ],
      ['ROLL-BATCH-001', '2#A3A-Cream', 'LOT-2601', '米白', 2800, 60000, 0, 60000, 0, 'A-01-01', 'PASSED', '示范织造厂']
    ]
  },
  remnants: {
    fileNameBase: 'remnants-import-template-mm',
    sheetName: '料头批量导入(mm)',
    aoa: [
      ['料头号', '材料型号', '来源母卷号', '父料头号', '代次', '幅宽(mm)', '长度(mm)', '库位', '状态', '质量等级', '缸号', '颜色'],
      ['REM-BATCH-001', '2#A3A-Cream', 'R-001', '', 1, 1800, 4200, 'R-02-01', 'AVAILABLE', 'GRADE_A', 'LOT-2601', '米白']
    ]
  },
  defects: {
    fileNameBase: 'defects-import-template-mm',
    sheetName: '瑕疵批量导入(0.1mm)',
    aoa: [
      ['母卷号', 'x(mm)', 'y(mm)', '宽度(mm)', '高度(mm)', '安全边距(mm)', '瑕疵类型', '类型名称', '严重度', '描述'],
      ['R-001', 120.5, 4500.0, 40.0, 50.0, 20.0, 'STAIN', '油污', 2, '批量导入示例瑕疵（0.1mm精度）']
    ]
  }
};

export function buildBatchTemplateCsvText(kind: BatchImportKind): string {
  const tpl = TEMPLATE_DATA[kind];
  const lines = tpl.aoa.map((row) => row.map((cell) => csvCell(cell)).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

export function downloadTextCsv(fileName: string, csvText: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  if (typeof window !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function downloadInventoryImportTemplate(
  kind: BatchImportKind,
  format: 'xlsx' | 'csv'
): Promise<void> {
  const tpl = TEMPLATE_DATA[kind];
  if (format === 'csv') {
    downloadTextCsv(`${tpl.fileNameBase}.csv`, buildBatchTemplateCsvText(kind));
    return;
  }
  const XLSX = await loadSheetLib();
  const ws = XLSX.utils.aoa_to_sheet(tpl.aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tpl.sheetName);
  XLSX.writeFile(wb, `${tpl.fileNameBase}.xlsx`);
}

export function buildBatchErrorCsvText(
  errors: BatchImportRowError[],
  sourceRowNumbers?: number[]
): string {
  const header = ['批次行索引(0-based)', 'Excel物理行号(1-based)', '字段', '错误码', '错误说明']
    .map((c) => csvCell(c))
    .join(',');
  const lines = errors.map((e) => {
    const physicalRow = sourceRowNumbers?.[e.rowIndex] ?? e.rowIndex + 2;
    return [
      csvCell(e.rowIndex),
      csvCell(physicalRow),
      csvCell(e.field),
      csvCell(e.code),
      csvCell(e.message)
    ].join(',');
  });
  return `\ufeff${[header, ...lines].join('\r\n')}\r\n`;
}
