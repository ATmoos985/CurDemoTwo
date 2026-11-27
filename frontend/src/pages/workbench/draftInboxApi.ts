import { requestJSON } from '../../lib/core/api-request.js';

export type WorkbenchDraftStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'DISCARDED'
  | 'EXPIRED';

export type DraftStatusFilter = 'ALL' | WorkbenchDraftStatus;

export interface WorkbenchDraftTargetDto {
  resultId: string;
  taskId?: string | null;
  materialId?: string | null;
  materialType?: string | null;
}

export interface WorkbenchDraftRiskCheckDto {
  code: string;
  passed: boolean;
  message: string;
}

export interface WorkbenchDraftDto {
  id: string;
  draftId: string;
  status: WorkbenchDraftStatus | string;
  approvalToken?: string;
  contentHash?: string;
  issuedAt: string;
  expiresAt: string;
  ttlSeconds?: number;
  requiresHumanConfirmation?: boolean;
  inventoryMutated?: boolean;
  stale: boolean;
  staleReasons: string[];
  target: WorkbenchDraftTargetDto;
  riskChecks: WorkbenchDraftRiskCheckDto[];
  workbenchUrl?: string;
  nextStep?: string;
  note?: string | null;
  snapshotTaskRevision?: number | null;
  snapshotMaterialRevision?: number | null;
  batchGroupId?: string | null;
  batchIndex?: number | null;
  batchTotal?: number | null;
  confirmedSchemeId?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  discardedBy?: string | null;
  discardedAt?: string | null;
  discardReason?: string | null;
}

export interface WorkbenchDraftPageDto {
  items: WorkbenchDraftDto[];
  total: number;
  page: number;
  size: number;
  pendingCount: number;
}

export interface MultiMaterialDraftBatchResponseDto {
  batchGroupId: string;
  inventoryMutated: boolean;
  requiresHumanConfirmation: boolean;
  draftCount: number;
  drafts: WorkbenchDraftDto[];
  planResult: any;
  warnings: string[];
}

export interface DraftDisplayGroup {
  key: string;
  isBatchGroup: boolean;
  batchGroupId: string | null;
  taskId: string | null;
  latestIssuedAt: string;
  pendingCount: number;
  confirmedCount: number;
  discardedCount: number;
  expiredCount: number;
  remnantCount: number;
  rollCount: number;
  drafts: WorkbenchDraftDto[];
}

export interface DraftStatusMeta {
  label: string;
  tagClass: 'run' | 'ok' | 'err' | 'warn' | 'kind';
}

export async function fetchWorkbenchDrafts(
  params: {
    status?: DraftStatusFilter;
    taskId?: string;
    batchGroupId?: string;
    page?: number;
    size?: number;
  } = {},
  options?: { signal?: AbortSignal }
): Promise<WorkbenchDraftPageDto> {
  const qs = new URLSearchParams();
  if (params.status && params.status !== 'ALL') {
    qs.set('status', params.status);
  } else if (params.status === 'ALL') {
    qs.set('status', 'ALL');
  }
  if (params.taskId && params.taskId.trim()) {
    qs.set('taskId', params.taskId.trim());
  }
  if (params.batchGroupId && params.batchGroupId.trim()) {
    qs.set('batchGroupId', params.batchGroupId.trim());
  }
  qs.set('page', String(params.page ?? 0));
  qs.set('size', String(params.size ?? 30));
  const data = await requestJSON(`/api/v2/workbench/drafts?${qs.toString()}`, undefined, {}, options);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: Number(data?.total ?? 0),
    page: Number(data?.page ?? 0),
    size: Number(data?.size ?? 30),
    pendingCount: Number(data?.pendingCount ?? 0)
  };
}

export async function fetchWorkbenchDraft(
  draftId: string,
  options?: { signal?: AbortSignal }
): Promise<WorkbenchDraftDto> {
  return requestJSON(`/api/v2/workbench/drafts/${encodeURIComponent(draftId)}`, undefined, {}, options);
}

export function evaluateActiveDraftBlockedReason(params: {
  draftId?: string | null;
  confirmedSchemeId?: string | null;
  banner?: {
    draftId?: string | null;
    status?: string | null;
    expired?: boolean | null;
    expiresAt?: string | null;
  } | null;
  nowMs?: number;
}): string | null {
  const { draftId, confirmedSchemeId, banner, nowMs = Date.now() } = params;
  if (!draftId || confirmedSchemeId) return null;
  if (banner && banner.draftId === draftId) {
    const upperStatus = String(banner.status || '').toUpperCase();
    if (upperStatus === 'DISCARDED') {
      return '当前关联草案已作废，请重新试排后再选定落库';
    }
    if (upperStatus === 'EXPIRED' || Boolean(banner.expired)) {
      return '当前关联草案已过期，请重新试排后再选定落库';
    }
    if (upperStatus !== 'CONFIRMED' && banner.expiresAt) {
      const expMs = Date.parse(banner.expiresAt);
      if (Number.isFinite(expMs) && expMs < nowMs) {
        return '当前关联草案已过期，请重新试排后再选定落库';
      }
    }
  }
  return null;
}

export async function confirmWorkbenchDraft(
  draftId: string,
  body?: { schemeId?: string; operator?: string }
): Promise<WorkbenchDraftDto> {
  return requestJSON(`/api/v2/workbench/drafts/${encodeURIComponent(draftId)}/confirm`, body || {});
}

export async function discardWorkbenchDraft(
  draftId: string,
  body: { reason?: string; operator?: string }
): Promise<WorkbenchDraftDto> {
  return requestJSON(`/api/v2/workbench/drafts/${encodeURIComponent(draftId)}/discard`, body || {});
}

export async function generateMultiMaterialDraftBatch(
  payload: Record<string, any>
): Promise<MultiMaterialDraftBatchResponseDto> {
  return requestJSON('/api/v2/workbench/multi-material-drafts', payload);
}

export function getDraftStatusMeta(status: string, stale?: boolean): DraftStatusMeta {
  const upper = String(status || '').toUpperCase();
  if (upper === 'CONFIRMED') return { label: '已确认', tagClass: 'ok' };
  if (upper === 'DISCARDED') return { label: '已作废', tagClass: 'err' };
  if (upper === 'EXPIRED') return { label: '已过期', tagClass: 'warn' };
  if (stale) return { label: '版本漂移', tagClass: 'err' };
  return { label: '待确认', tagClass: 'run' };
}

export function formatDraftMaterialType(materialType?: string | null): string {
  const upper = String(materialType || '').toUpperCase();
  if (upper === 'REMNANT') return '料头';
  if (upper === 'STOCK_ROLL') return '实卷';
  return '自由画布';
}

export function buildDraftDeeplinkHash(draft: Pick<WorkbenchDraftDto, 'draftId' | 'id' | 'target'>): string {
  const draftId = String(draft.draftId || draft.id || '').trim();
  const taskId = String(draft.target?.taskId || '').trim();
  const resultId = String(draft.target?.resultId || '').trim();
  const qs = new URLSearchParams();
  if (taskId) qs.set('taskId', taskId);
  if (resultId) qs.set('resultId', resultId);
  if (draftId) qs.set('draftId', draftId);
  const query = qs.toString();
  return query ? `#/workbench?${query}` : '#/workbench';
}

export function groupDraftsByBatch(drafts: WorkbenchDraftDto[]): DraftDisplayGroup[] {
  const list = Array.isArray(drafts) ? drafts : [];
  const buckets = new Map<string, WorkbenchDraftDto[]>();

  for (const draft of list) {
    const groupId = (draft.batchGroupId || '').trim();
    const key = groupId ? `batch:${groupId}` : `single:${draft.draftId || draft.id}`;
    const arr = buckets.get(key);
    if (arr) {
      arr.push(draft);
    } else {
      buckets.set(key, [draft]);
    }
  }

  const groups: DraftDisplayGroup[] = [];
  for (const [key, items] of buckets.entries()) {
    const isBatchGroup = key.startsWith('batch:');
    const sorted = [...items].sort((a, b) => {
      if (isBatchGroup) {
        const idxA = a.batchIndex ?? Number.MAX_SAFE_INTEGER;
        const idxB = b.batchIndex ?? Number.MAX_SAFE_INTEGER;
        if (idxA !== idxB) return idxA - idxB;
      }
      return Date.parse(b.issuedAt || '') - Date.parse(a.issuedAt || '');
    });

    let latestIssuedAt = sorted[0]?.issuedAt || '';
    let latestMs = Date.parse(latestIssuedAt) || 0;
    let pendingCount = 0;
    let confirmedCount = 0;
    let discardedCount = 0;
    let expiredCount = 0;
    let remnantCount = 0;
    let rollCount = 0;

    for (const d of sorted) {
      const ts = Date.parse(d.issuedAt || '') || 0;
      if (ts > latestMs) {
        latestMs = ts;
        latestIssuedAt = d.issuedAt;
      }
      const st = String(d.status || '').toUpperCase();
      if (st === 'PENDING_CONFIRMATION') pendingCount++;
      else if (st === 'CONFIRMED') confirmedCount++;
      else if (st === 'DISCARDED') discardedCount++;
      else if (st === 'EXPIRED') expiredCount++;

      const mt = String(d.target?.materialType || '').toUpperCase();
      if (mt === 'REMNANT') remnantCount++;
      else if (mt === 'STOCK_ROLL') rollCount++;
    }

    groups.push({
      key,
      isBatchGroup,
      batchGroupId: isBatchGroup ? (sorted[0]?.batchGroupId || null) : null,
      taskId: sorted.find((d) => d.target?.taskId)?.target?.taskId || null,
      latestIssuedAt,
      pendingCount,
      confirmedCount,
      discardedCount,
      expiredCount,
      remnantCount,
      rollCount,
      drafts: sorted
    });
  }

  groups.sort((a, b) => (Date.parse(b.latestIssuedAt || '') || 0) - (Date.parse(a.latestIssuedAt || '') || 0));
  return groups;
}
