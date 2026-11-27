import { AuthSession, buildAuthHeaders, getAuthToken } from './authClient';

export type ExportCamFormat = 'dxf_r12' | 'dxf_lwpolyline' | 'dxf_aama' | 'plt' | 'nc';
export type ExportSlittingFormat = 'json' | 'csv' | 'xlsx';
export type ExportSummaryFormat = 'pdf' | 'xlsx';
export type BatchZipFormat =
  | ExportCamFormat
  | 'slitting_json'
  | 'slitting_csv'
  | 'slitting_xlsx'
  | 'ticket_pdf';

export interface CamExportOptionsDto {
  overcutMm: number;
  leadInMm: number;
  microJointWidthMm: number;
  deduplicateCommonEdges: boolean;
  cutTool: string;
  punchTool: string;
  creaseTool: string;
}

export const DEFAULT_CAM_EXPORT_OPTIONS: CamExportOptionsDto = {
  overcutMm: 0,
  leadInMm: 0,
  microJointWidthMm: 0,
  deduplicateCommonEdges: false,
  cutTool: 'T01',
  punchTool: 'T02',
  creaseTool: 'T03'
};

export interface SummaryExportFilter {
  taskId?: string;
  state?: string;
  from?: string;
  to?: string;
}

export interface BatchExportZipPayload {
  schemeIds: string[];
  formats: BatchZipFormat[];
  camOptions?: Partial<CamExportOptionsDto>;
}

export class ExportApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    status: number,
    code = 'EXPORT_ERROR',
    traceId?: string,
    retryable = false
  ) {
    super(message);
    this.name = 'ExportApiError';
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.retryable = retryable;
  }
}

export interface ExportDownloadResult {
  blob: Blob;
  fileName: string;
  contentType: string;
}

type FetchFn = typeof fetch;

export function sanitizeDownloadFilename(rawName: string, fallback: string): string {
  const cleaned = String(rawName || '')
    .replace(/[\r\n\0]/g, '')
    .replace(/^["']+|["']+$/g, '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.\.+/g, '.')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return fallback;
  }
  return cleaned;
}

/**
 * 解析服务端 Content-Disposition 响应头，优先支持 RFC 5987 `filename*=UTF-8''...`，
 * 回退至 `filename="..."` 并防御路径穿越字符。
 */
export function parseContentDispositionFilename(
  header: string | null | undefined,
  fallback: string
): string {
  if (!header) return sanitizeDownloadFilename(fallback, 'download.bin');
  const extMatch = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (extMatch && extMatch[1]) {
    try {
      const decoded = decodeURIComponent(extMatch[1].trim());
      return sanitizeDownloadFilename(decoded, fallback);
    } catch {
      // 忽略畸形 percent-encoding，继续回退到 filename=
    }
  }
  const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
  if (quotedMatch && quotedMatch[1]) {
    return sanitizeDownloadFilename(quotedMatch[1], fallback);
  }
  const plainMatch = header.match(/filename\s*=\s*([^;\s]+)/i);
  if (plainMatch && plainMatch[1]) {
    return sanitizeDownloadFilename(plainMatch[1], fallback);
  }
  return sanitizeDownloadFilename(fallback, 'download.bin');
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  if (typeof URL.createObjectURL !== 'function') return;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  if (typeof window !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

export function canReadExports(auth?: AuthSession | null): boolean {
  if (!auth || !auth.enabled) return true;
  if (!auth.authenticated) return false;
  if (String(auth.actorType || '').toUpperCase() === 'AGENT') {
    const scopes = Array.isArray(auth.scopes) ? auth.scopes : [];
    return scopes.includes('INVENTORY_READ');
  }
  return true;
}

export function canUseBatchZipExport(auth?: AuthSession | null): boolean {
  if (!auth || !auth.enabled) return true;
  if (!auth.authenticated) return false;
  return String(auth.actorType || '').toUpperCase() !== 'AGENT';
}

export function formatExportError(err: unknown): {
  title: string;
  message: string;
  status?: number;
  code?: string;
  traceId?: string;
} {
  if (err instanceof ExportApiError) {
    if (err.status === 401) {
      return {
        title: '身份认证已过期（401）',
        message: err.message || '请重新登录后再执行导出。',
        status: err.status,
        code: err.code,
        traceId: err.traceId
      };
    }
    if (err.status === 403) {
      return {
        title: '当前身份无导出权限（403）',
        message: err.message || '请联系管理员授予对应导出角色或作用域权限。',
        status: err.status,
        code: err.code,
        traceId: err.traceId
      };
    }
    if (err.status === 404) {
      return {
        title: '目标方案或单据不存在（404）',
        message: err.message || '请刷新列表确认方案状态后再导出。',
        status: err.status,
        code: err.code,
        traceId: err.traceId
      };
    }
    if (err.status === 400) {
      return {
        title: '导出参数校验失败（400）',
        message: err.message || '请检查刀头编号、工艺容差或时间区间筛选。',
        status: err.status,
        code: err.code,
        traceId: err.traceId
      };
    }
    return {
      title: `导出服务异常（HTTP ${err.status}）`,
      message: err.message,
      status: err.status,
      code: err.code,
      traceId: err.traceId
    };
  }
  const msg = err instanceof Error ? err.message : String(err || '导出请求失败');
  return {
    title: '导出请求失败',
    message: msg
  };
}

async function parseErrorPayload(res: Response): Promise<{
  code: string;
  message: string;
  traceId?: string;
  retryable: boolean;
}> {
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const defaultMsg =
    res.status === 401
      ? '登录会话已失效，请重新登录（401）'
      : res.status === 403
      ? '当前账号或 AI Agent 无权执行此导出操作（403）'
      : res.status === 404
      ? '未找到对应方案或导出资源（404）'
      : `导出失败（HTTP ${res.status}）`;
  return {
    code: String(payload?.code || `HTTP_${res.status}`),
    message: String(payload?.message || defaultMsg),
    traceId: payload?.traceId ? String(payload.traceId) : undefined,
    retryable: Boolean(payload?.retryable)
  };
}

export async function downloadAuthorizedBlob(
  url: string,
  init: RequestInit = {},
  fallbackFileName = 'export.bin',
  fetchImpl: FetchFn = globalThis.fetch,
  autoTriggerDownload = true
): Promise<ExportDownloadResult> {
  const token = getAuthToken();
  const headers = buildAuthHeaders(init.headers, token);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetchImpl(url, {
    ...init,
    cache: 'no-store',
    headers
  });

  if (!res.ok) {
    const parsed = await parseErrorPayload(res);
    throw new ExportApiError(
      parsed.message,
      res.status,
      parsed.code,
      parsed.traceId,
      parsed.retryable
    );
  }

  const blob = await res.blob();
  const fileName = parseContentDispositionFilename(
    res.headers?.get?.('Content-Disposition'),
    fallbackFileName
  );
  const contentType = res.headers?.get?.('Content-Type') || blob.type || 'application/octet-stream';

  if (autoTriggerDownload) {
    triggerBlobDownload(blob, fileName);
  }

  return { blob, fileName, contentType };
}

export function buildCamExportUrl(
  schemeId: string,
  format: ExportCamFormat,
  options: Partial<CamExportOptionsDto> = {}
): string {
  const merged = { ...DEFAULT_CAM_EXPORT_OPTIONS, ...options };
  const params = new URLSearchParams({
    format,
    overcutMm: String(merged.overcutMm ?? 0),
    leadInMm: String(merged.leadInMm ?? 0),
    microJointWidthMm: String(merged.microJointWidthMm ?? 0),
    deduplicateCommonEdges: String(Boolean(merged.deduplicateCommonEdges)),
    cutTool: merged.cutTool || 'T01',
    punchTool: merged.punchTool || 'T02',
    creaseTool: merged.creaseTool || 'T03'
  });
  return `/api/v2/exports/schemes/${encodeURIComponent(schemeId)}/cam?${params.toString()}`;
}

export async function downloadSchemeCamExport(
  schemeId: string,
  format: ExportCamFormat,
  options: Partial<CamExportOptionsDto> = {},
  fetchImpl: FetchFn = globalThis.fetch
): Promise<ExportDownloadResult> {
  const ext = format === 'plt' ? 'plt' : format === 'nc' ? 'nc' : 'dxf';
  const fallback = `${schemeId}-${format}.${ext}`;
  const url = buildCamExportUrl(schemeId, format, options);
  return downloadAuthorizedBlob(url, { method: 'GET' }, fallback, fetchImpl);
}

export async function downloadSchemeSlittingExport(
  schemeId: string,
  format: ExportSlittingFormat,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<ExportDownloadResult> {
  const url = `/api/v2/exports/schemes/${encodeURIComponent(schemeId)}/slitting?format=${encodeURIComponent(format)}`;
  const fallback = `${schemeId}-slitting.${format}`;
  return downloadAuthorizedBlob(url, { method: 'GET' }, fallback, fetchImpl);
}

export async function downloadSchemeTicketPdf(
  schemeId: string,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<ExportDownloadResult> {
  const url = `/api/v2/exports/schemes/${encodeURIComponent(schemeId)}/ticket.pdf`;
  return downloadAuthorizedBlob(url, { method: 'GET' }, `WO-${schemeId}.pdf`, fetchImpl);
}

export async function downloadProductionSummary(
  format: ExportSummaryFormat,
  filter: SummaryExportFilter = {},
  fetchImpl: FetchFn = globalThis.fetch
): Promise<ExportDownloadResult> {
  const params = new URLSearchParams({ format });
  if (filter.taskId?.trim()) params.set('taskId', filter.taskId.trim());
  if (filter.state?.trim()) params.set('state', filter.state.trim());
  if (filter.from?.trim()) params.set('from', filter.from.trim());
  if (filter.to?.trim()) params.set('to', filter.to.trim());
  const url = `/api/v2/exports/production-summary?${params.toString()}`;
  return downloadAuthorizedBlob(url, { method: 'GET' }, `production-summary.${format}`, fetchImpl);
}

export async function downloadBatchExportZip(
  payload: BatchExportZipPayload,
  fetchImpl: FetchFn = globalThis.fetch
): Promise<ExportDownloadResult> {
  return downloadAuthorizedBlob(
    '/api/v2/exports/batch-zip',
    {
      method: 'POST',
      body: JSON.stringify({
        schemeIds: payload.schemeIds,
        formats: payload.formats,
        camOptions: payload.camOptions ? { ...DEFAULT_CAM_EXPORT_OPTIONS, ...payload.camOptions } : undefined
      })
    },
    'cutplan-batch-export.zip',
    fetchImpl
  );
}
