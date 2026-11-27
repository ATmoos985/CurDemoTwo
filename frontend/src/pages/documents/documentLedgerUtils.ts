import { requestJSON, shortId, fmtN } from '../../lib/core/util.js';

export const EVENT_LABELS: Record<string, string> = {
  MIGRATION_OPENING: '期初迁移',
  CUT_REPORT: '报工记账',
  CUT_REPORT_BATCH: '批量报工',
  REPORT_REVERSE: '报工冲销',
  DEMAND_ADJUSTMENT: '需求调整',
  INSPECTION: '验布入档',
  INVENTORY_COUNT: '盘点',
  INVENTORY_TRANSFER: '移库',
  QUALITY_DISPOSITION: '复检处置',
  QUALITY_DISPOSITION_REVOKE: '复检撤销',
  QUALITY_RELEASE: '隔离放行',
  RECEIPT_IN: '采购入库',
  MATERIAL_ISSUE: '车间领料',
  MATERIAL_RETURN: '车间退料',
  ROLL_SCRAP: '母卷报废',
  REMNANT_ISSUE: '料头领用',
  REMNANT_RECEIPT: '料头入库',
  REMNANT_SCRAP: '料头报废',
  REMNANT_STATUS_ADJUSTMENT: '料头状态调整',
  ROLL_RECEIPT: '母卷入库',
  ROLL_RECEIPT_OR_UPDATE: '母卷入库 / 更新',
  DEMO_RECEIPT: '演示入库',
  DEMO_RESET: '演示重置',
  SYSTEM_UPDATE: '系统更新',
  DEFECT_VOID: '疵点作废'
};

export const AGG_LABELS: Record<string, string> = {
  DEMAND: '需求',
  ROLL: '母卷',
  MOTHER_ROLL: '母卷',
  REMNANT: '料头',
  REPORT: '报工单',
  TASK: '任务',
  PLAN: '方案',
  EXECUTION: '执行单',
  CHECKPOINT: '检查点',
  TRANSFER: '移库单',
  COUNT: '盘点单',
  RECEIPT: '采购入库单',
  MATERIAL_ISSUE: '领退料单',
  QUALITY_RELEASE: '放行单',
  QUALITY: '复检'
};

export const ACTOR_LABELS: Record<string, string> = {
  UNAUTHENTICATED_LOCAL: '本机（未登录）',
  SYSTEM_MIGRATION: '系统迁移'
};

/** Business categories used by the overview KPI cards and as a filter. */
export type Category = 'receipt' | 'report' | 'remnant' | 'demand' | 'quality' | 'reverse';

export const CATEGORY_EVENTS: Record<Category, string[]> = {
  receipt: ['ROLL_RECEIPT', 'ROLL_RECEIPT_OR_UPDATE', 'DEMO_RECEIPT', 'RECEIPT_IN'],
  report: ['CUT_REPORT', 'CUT_REPORT_BATCH'],
  remnant: [
    'REMNANT_RECEIPT',
    'REMNANT_ISSUE',
    'REMNANT_SCRAP',
    'REMNANT_STATUS_ADJUSTMENT',
    'MATERIAL_ISSUE',
    'MATERIAL_RETURN'
  ],
  demand: ['DEMAND_ADJUSTMENT'],
  quality: [
    'INSPECTION',
    'QUALITY_DISPOSITION',
    'QUALITY_RELEASE',
    'INVENTORY_COUNT',
    'INVENTORY_TRANSFER'
  ],
  reverse: ['REPORT_REVERSE', 'DEFECT_VOID', 'ROLL_SCRAP', 'QUALITY_DISPOSITION_REVOKE']
};

export const CATEGORY_LABELS: Record<Category, string> = {
  receipt: '母卷入库',
  report: '报工记账',
  remnant: '料头流转',
  demand: '需求调整',
  quality: '验布 / 盘点 / 移库',
  reverse: '冲销 / 作废'
};

export const categoryOf = (eventType: string): Category | null =>
  (Object.keys(CATEGORY_EVENTS) as Category[]).find((c) =>
    CATEGORY_EVENTS[c].includes(eventType)
  ) || null;

/** Field labels for before/after diffs: [label, unit]. Lookup uses the last key segment. */
export const FIELD_LABELS: Record<string, [string, string?]> = {
  currentRemainingLength: ['余长', 'mm'],
  usedLength: ['已切长度', 'mm'],
  totalLength: ['总长', 'mm'],
  width: ['幅宽', 'mm'],
  length: ['长度', 'mm'],
  area: ['面积', 'm²'],
  status: ['状态'],
  location: ['库位'],
  storageLocation: ['库位'],
  inspectionStatus: ['验布状态'],
  defectsCount: ['疵点数', '处'],
  completed: ['已完成', '件'],
  quantity: ['需求数量', '件'],
  qualityGrade: ['质量等级'],
  consumedByOrder: ['领用单'],
  utilization: ['利用率', '%'],
  actualCutLen: ['实切长度', 'mm'],
  usedArea: ['耗用面积', 'm²'],
  wasteArea: ['废料面积', 'm²'],
  finishedPieceCount: ['成品件数', '件'],
  sourceRollId: ['来源母卷'],
  rollId: ['母卷'],
  materialBatch: ['材料批次'],
  batchNo: ['缸号/批次'],
  color: ['色号'],
  shrinkageRate: ['缩水率', '%'],
  issuedMachineId: ['领用机台'],
  issuedShiftTeam: ['领用班组'],
  rollModel: ['品号']
};

const NOISY_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'confirmedAt',
  'consumedAt',
  'schemaVersion',
  'payloadJson',
  'id'
]);

export function eventTagClass(eventType: string): string {
  switch (categoryOf(eventType)) {
    case 'receipt':
      return 'ok';
    case 'report':
    case 'remnant':
      return 'run';
    case 'demand':
    case 'quality':
      return 'warn';
    case 'reverse':
      return 'err';
    default:
      return eventType === 'REMNANT_SCRAP' ? 'err' : 'kind';
  }
}

export async function loadAllLedgerItems(): Promise<any[]> {
  let items: any[] = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await requestJSON('/api/v2/inventory-ledger?limit=500&after=' + after);
    items = items.concat(page.items || []);
    if (!page.hasMore || !(page.items || []).length) break;
    after = page.nextCursor ?? items[items.length - 1].sequence;
  }
  return items;
}

export const asList = (x: any): any[] =>
  Array.isArray(x) ? x : (Object.values(x || {}).find(Array.isArray) as any[]) || [];

export const parseJson = (s: any): any => {
  if (!s || typeof s !== 'string') return s && typeof s === 'object' ? s : null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Flatten one level of nested objects (e.g. demand.line.quantity); arrays become counts. */
export function flatten(obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!obj || typeof obj !== 'object') return out;
  Object.entries(obj).forEach(([k, v]) => {
    if (NOISY_FIELDS.has(k)) return;
    if (Array.isArray(v)) out[k] = `${v.length} 项`;
    else if (v && typeof v === 'object') {
      Object.entries(v as any).forEach(([k2, v2]) => {
        if (NOISY_FIELDS.has(k2) || (v2 && typeof v2 === 'object')) return;
        out[`${k}.${k2}`] = v2;
      });
    } else out[k] = v;
  });
  return out;
}

export const fieldLabel = (key: string): [string, string?] => {
  const last = key.split('.').pop() || key;
  return FIELD_LABELS[last] || [key];
};

export const fmtVal = (v: any, unit?: string): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    const d = unit === '%' || unit === 'm²' ? 2 : 1;
    return `${fmtN(v, d)}${unit ? ' ' + unit : ''}`;
  }
  return String(v);
};

export interface FieldChange {
  key: string;
  label: string;
  unit?: string;
  before: any;
  after: any;
}

/** Before/after diff. Creations only show labelled key fields to stay readable. */
export function diffLine(line: any): FieldChange[] {
  const b = flatten(parseJson(line.beforeJson));
  const a = flatten(parseJson(line.afterJson));
  const creation = !line.beforeJson;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return keys
    .filter((k) => (creation ? FIELD_LABELS[k.split('.').pop() || k] : String(b[k]) !== String(a[k])))
    .map((k) => {
      const [label, unit] = fieldLabel(k);
      return { key: k, label, unit, before: b[k], after: a[k] };
    })
    .sort((x, y) => Number(!FIELD_LABELS[x.key.split('.').pop() || '']) - Number(!FIELD_LABELS[y.key.split('.').pop() || '']));
}

export interface Txn {
  id: string;
  lines: any[];
  occurredAt: number;
  maxSeq: number;
  eventType: string;
  businessId: string;
  actor: string;
  beforeVersion: any;
  afterVersion: any;
  aggCounts: [string, number][];
  primary: { type: string; id: string } | null;
  facts: string[];
}

/** Human-readable key facts of one business transaction. */
export function txnFacts(lines: any[]): string[] {
  const facts: string[] = [];
  let newRem = 0;
  let newRemArea = 0;
  let demandDelta = 0;
  lines.forEach((l) => {
    const b = parseJson(l.beforeJson);
    const a = parseJson(l.afterJson);
    if (l.aggregateType === 'ROLL' && a) {
      const ra = a.currentRemainingLength ?? (a.totalLength ?? 0) - (a.usedLength ?? 0);
      if (b) {
        const rb = b.currentRemainingLength ?? (b.totalLength ?? 0) - (b.usedLength ?? 0);
        if (rb !== ra) facts.push(`${l.aggregateId} 余长 ${fmtN(rb / 1000, 2)} → ${fmtN(ra / 1000, 2)} m`);
        else if (b.inspectionStatus !== a.inspectionStatus)
          facts.push(`${l.aggregateId} 验布 ${b.inspectionStatus || '—'} → ${a.inspectionStatus || '—'}`);
      } else {
        facts.push(`${l.aggregateId} 入库 ${fmtN(a.width)} mm × ${fmtN((a.totalLength || 0) / 1000, 1)} m`);
      }
    } else if (l.aggregateType === 'REMNANT' && a) {
      if (!b) {
        newRem += 1;
        newRemArea += Number(a.area) || 0;
      } else if (b.status !== a.status) facts.push(`料头 ${l.aggregateId} ${b.status} → ${a.status}`);
    } else if (l.aggregateType === 'DEMAND' && a && b) {
      demandDelta += (Number(a.completed) || 0) - (Number(b.completed) || 0);
    } else if (l.aggregateType === 'REPORT' && a && a.utilization != null && !b) {
      facts.push(`利用率 ${fmtN(a.utilization, 1)}%`);
    }
  });
  if (newRem) facts.push(`新增料头 ${newRem} 块 · ${fmtN(newRemArea, 2)} m²`);
  if (demandDelta) facts.push(`需求完成 ${demandDelta > 0 ? '+' : ''}${demandDelta} 件`);
  return facts;
}

export function buildTxns(lines: any[]): Txn[] {
  const map = new Map<string, any[]>();
  lines.forEach((l) => {
    const k = l.transactionId || l.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(l);
  });
  return [...map.entries()]
    .map(([id, ls]) => {
      const typeCount = new Map<string, number>();
      const aggCount = new Map<string, Set<string>>();
      ls.forEach((l) => {
        typeCount.set(l.eventType, (typeCount.get(l.eventType) || 0) + 1);
        if (!aggCount.has(l.aggregateType)) aggCount.set(l.aggregateType, new Set());
        aggCount.get(l.aggregateType)!.add(l.aggregateId);
      });
      const eventType = [...typeCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const first = ls[0];
      const primaryLine =
        ls.find((l) => l.aggregateType === 'ROLL') ||
        ls.find((l) => l.aggregateType === 'REPORT') ||
        first;
      return {
        id,
        lines: ls,
        occurredAt: Math.max(...ls.map((l) => l.occurredAt || 0)),
        maxSeq: Math.max(...ls.map((l) => l.sequence || 0)),
        eventType,
        businessId: first.businessId && first.businessId !== id ? first.businessId : '',
        actor: first.actor,
        beforeVersion: first.beforeVersion,
        afterVersion: first.afterVersion,
        aggCounts: [...aggCount.entries()].map(([t, s]) => [t, s.size] as [string, number]),
        primary: primaryLine ? { type: primaryLine.aggregateType, id: primaryLine.aggregateId } : null,
        facts: txnFacts(ls)
      };
    })
    .sort((a, b) => b.maxSeq - a.maxSeq);
}

export type DocTab = 'ledger' | 'receipt' | 'issue' | 'transfer' | 'count';
export type RangeKey = 'today' | '7d' | '30d' | 'all';
export type ViewKey = 'txn' | 'line';
export type Focus =
  | { kind: 'txn'; id: string }
  | { kind: 'obj'; type: string; id: string }
  | { kind: 'report'; id: string }
  | null;

export interface ReceiptRollDraft {
  id: string;
  materialModel: string;
  materialType: string;
  color: string;
  batchNo: string;
  widthMm: string;
  totalLengthMm: string;
  grammage: string;
  shrinkageRate: string;
  storageLocation: string;
  inspectionStatus: 'PENDING' | 'PASSED';
}

export const createEmptyReceiptRoll = (prev?: ReceiptRollDraft): ReceiptRollDraft => ({
  id: '',
  materialModel: prev?.materialModel || 'TC涤棉-B2026',
  materialType: prev?.materialType || '面料',
  color: prev?.color || '',
  batchNo: prev?.batchNo || '',
  widthMm: prev?.widthMm || '1650',
  totalLengthMm: prev?.totalLengthMm || '60000',
  grammage: prev?.grammage || '240',
  shrinkageRate: prev?.shrinkageRate || '1.5',
  storageLocation: prev?.storageLocation || '原料库位 R-01',
  inspectionStatus: prev?.inspectionStatus || 'PENDING'
});

export type DocPendingSlot = 'inventory-receipt' | 'material-issue';
export const DOC_PENDING_LABELS: Record<DocPendingSlot, string> = {
  'inventory-receipt': '采购批量入库单',
  'material-issue': '车间领/退料单'
};

export const DAY_MS = 86400000;
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const startOfToday = (now = Date.now()) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const objectHref = (type: string, id: string): string | null => {
  if (type === 'ROLL' || type === 'MOTHER_ROLL') return `#/inventory?roll=${encodeURIComponent(id)}`;
  if (type === 'REMNANT') return '#/inventory';
  return null;
};

/** Shorten long UUIDs while preserving any `/lineId` suffix (e.g. `32a73567-.../1` -> `32a73567/1`). */
export const fmtObjId = (id: any): string => {
  const s = String(id || '');
  if (s.length <= 24) return s;
  const slash = s.indexOf('/');
  if (slash > 8) return `${s.slice(0, 8)}${s.slice(slash)}`;
  return shortId(s);
};

export const actorText = (a: string): string => ACTOR_LABELS[a] || a || '—';

export function filterRangeLines(
  items: any[],
  range: RangeKey,
  day: string,
  now = Date.now()
): any[] {
  const from =
    range === 'today'
      ? startOfToday(now)
      : range === '7d'
      ? now - 7 * DAY_MS
      : range === '30d'
      ? now - 30 * DAY_MS
      : 0;
  return items.filter(
    (i) =>
      i.eventType !== 'MIGRATION_OPENING' &&
      (day ? dayKey(i.occurredAt) === day : (i.occurredAt || 0) >= from)
  );
}

export interface LedgerKpis {
  total: number;
  lines: number;
  receipt: number;
  receiptLen: number;
  report: number;
  consumed: number;
  newRem: number;
  remnant: number;
  remIssue: number;
  remScrap: number;
  demand: number;
  demandRows: number;
  quality: number;
  reverse: number;
}

export function computeLedgerKpis(rangeLines: any[]): LedgerKpis {
  const txnsOf = (c: Category) =>
    new Set(rangeLines.filter((l) => categoryOf(l.eventType) === c).map((l) => l.transactionId)).size;
  const receiptRolls = rangeLines.filter(
    (l) => categoryOf(l.eventType) === 'receipt' && l.aggregateType === 'ROLL'
  );
  const receiptLen = receiptRolls.reduce((s, l) => s + (Number(parseJson(l.afterJson)?.totalLength) || 0), 0);
  let consumed = 0;
  let newRem = 0;
  rangeLines
    .filter((l) => categoryOf(l.eventType) === 'report')
    .forEach((l) => {
      const b = parseJson(l.beforeJson);
      const a = parseJson(l.afterJson);
      if (l.aggregateType === 'ROLL' && a && b) consumed += (a.usedLength || 0) - (b.usedLength || 0);
      if (l.aggregateType === 'REMNANT' && a && !b) newRem += 1;
    });
  const remLines = rangeLines.filter((l) => categoryOf(l.eventType) === 'remnant');
  const demandLines = rangeLines.filter((l) => l.eventType === 'DEMAND_ADJUSTMENT');
  return {
    total: new Set(rangeLines.map((l) => l.transactionId)).size,
    lines: rangeLines.length,
    receipt: new Set(receiptRolls.map((l) => l.aggregateId)).size,
    receiptLen,
    report: txnsOf('report'),
    consumed,
    newRem,
    remnant: remLines.length,
    remIssue: remLines.filter((l) => l.eventType === 'REMNANT_ISSUE').length,
    remScrap: remLines.filter((l) => l.eventType === 'REMNANT_SCRAP').length,
    demand: txnsOf('demand'),
    demandRows: new Set(demandLines.map((l) => l.aggregateId)).size,
    quality: txnsOf('quality'),
    reverse: txnsOf('reverse')
  };
}

export interface DailyBucketResult {
  rows: { key: string; label: string; count: number }[];
  max: number;
}

export function computeDailyBuckets(items: any[], today = startOfToday()): DailyBucketResult {
  const buckets = Array.from({ length: 14 }, (_, i) => {
    const t = today - (13 - i) * DAY_MS;
    return {
      key: dayKey(t),
      label: `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`,
      txns: new Set<string>()
    };
  });
  const index = new Map(buckets.map((b) => [b.key, b]));
  items.forEach((i) => {
    if (i.eventType === 'MIGRATION_OPENING') return;
    index.get(dayKey(i.occurredAt))?.txns.add(i.transactionId);
  });
  const rows = buckets.map((b) => ({ key: b.key, label: b.label, count: b.txns.size }));
  return { rows, max: Math.max(1, ...rows.map((r) => r.count)) };
}

export interface TopObjectItem {
  type: string;
  id: string;
  count: number;
  last: number;
}

export function computeTopObjects(rangeLines: any[]): TopObjectItem[] {
  const m = new Map<string, TopObjectItem>();
  rangeLines.forEach((l) => {
    if (l.aggregateType === 'CHECKPOINT') return;
    const k = l.aggregateType + '|' + l.aggregateId;
    const cur = m.get(k) || { type: l.aggregateType, id: l.aggregateId, count: 0, last: 0 };
    cur.count += 1;
    cur.last = Math.max(cur.last, l.occurredAt || 0);
    m.set(k, cur);
  });
  return [...m.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 8);
}

export function matchesLedgerQuery(i: any, q: string): boolean {
  return [
    i.aggregateId,
    i.businessId,
    i.actor,
    i.transactionId,
    i.eventType,
    EVENT_LABELS[i.eventType],
    ...(i.sourceReportIds || [])
  ].some((v) => String(v || '').toLowerCase().includes(q));
}

export function filterLedgerLines(
  items: any[],
  rangeLines: any[],
  opts: {
    showOpening: boolean;
    category: Category | '';
    filterAgg: string;
    searchQuery: string;
  }
): any[] {
  const q = opts.searchQuery.trim().toLowerCase();
  const inRange = new Set(rangeLines);
  const base = opts.showOpening
    ? items.filter((i) => i.eventType === 'MIGRATION_OPENING' || inRange.has(i))
    : rangeLines;
  return base.filter(
    (i) =>
      (!opts.category || categoryOf(i.eventType) === opts.category) &&
      (!opts.filterAgg || i.aggregateType === opts.filterAgg) &&
      (!q || matchesLedgerQuery(i, q))
  );
}

export function filterTransfers(transfers: any[], searchQuery: string): any[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return transfers;
  return transfers.filter((r) => {
    const mats = r.items || r.materials || [];
    return [
      r.id,
      r.documentId,
      r.destination,
      r.reason,
      r.operator,
      ...mats.map((m: any) => `${m.id || m.materialId || ''} ${m.fromLocation || ''}`)
    ].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

export function filterCounts(counts: any[], searchQuery: string): any[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return counts;
  return counts.filter((r) => {
    const mats = r.items || r.materials || [];
    return [r.id, r.documentId, r.reason, r.operator, ...mats.map((m: any) => m.id || m.materialId || '')].some(
      (v) => String(v || '').toLowerCase().includes(q)
    );
  });
}

export function filterReceipts(receipts: any[], searchQuery: string): any[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return receipts;
  return receipts.filter((r) => {
    const rls = r.lines || r.rolls || r.items || [];
    return [
      r.id,
      r.documentId,
      r.supplierName,
      r.deliveryNoteNo,
      r.operator,
      r.remarks,
      ...rls.map((x: any) => `${x.rollId || x.id || ''} ${x.materialModel || x.rollModel || ''} ${x.batchNo || ''}`)
    ].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

export function filterIssues(
  issues: any[],
  issueDirFilter: 'ALL' | 'ISSUE' | 'RETURN',
  searchQuery: string
): any[] {
  const q = searchQuery.trim().toLowerCase();
  return issues.filter((r) => {
    if (issueDirFilter !== 'ALL' && r.direction !== issueDirFilter) return false;
    if (!q) return true;
    return [
      r.id,
      r.documentId,
      r.direction,
      r.rollId,
      r.materialModel,
      r.batchNo,
      r.machineId,
      r.shiftTeam,
      r.fromLocation,
      r.toLocation,
      r.targetLocation,
      r.operator,
      r.reason
    ].some((v) => String(v || '').toLowerCase().includes(q));
  });
}

export type LedgerPayloadValidationResult =
  | { ok: true; payload: any; error?: undefined }
  | { ok: false; error: string; payload?: undefined };

export function validateAndBuildReceiptPayload(input: {
  supplierName: string;
  deliveryNoteNo: string;
  operator: string;
  inspector: string;
  remarks: string;
  rolls: ReceiptRollDraft[];
}): LedgerPayloadValidationResult {
  if (!input.supplierName.trim() || !input.deliveryNoteNo.trim() || !input.operator.trim()) {
    return { ok: false, error: '请完整填写供应商名称、送货单号与经办人' };
  }
  const validRolls = input.rolls
    .filter((r) => r.materialModel.trim() && Number(r.widthMm) > 0 && Number(r.totalLengthMm) > 0)
    .map((r) => ({
      id: r.id.trim() || undefined,
      materialModel: r.materialModel.trim(),
      materialType: r.materialType.trim() || '面料',
      color: r.color.trim() || undefined,
      batchNo: r.batchNo.trim() || undefined,
      widthMm: Number(r.widthMm),
      totalLengthMm: Number(r.totalLengthMm),
      grammage: r.grammage !== '' && Number.isFinite(Number(r.grammage)) ? Number(r.grammage) : undefined,
      shrinkageRate:
        r.shrinkageRate !== '' && Number.isFinite(Number(r.shrinkageRate))
          ? Number(r.shrinkageRate)
          : undefined,
      storageLocation: r.storageLocation.trim() || '原料库位 R-01',
      inspectionStatus: r.inspectionStatus
    }));
  if (!validRolls.length) {
    return { ok: false, error: '请至少录入 1 行包含有效品号、门幅与总长的母卷明细' };
  }
  const hasPassedRoll = validRolls.some((r) => r.inspectionStatus === 'PASSED');
  if (hasPassedRoll && !input.inspector.trim()) {
    return { ok: false, error: '入库直通合格(PASSED)必须填写来料质检员姓名' };
  }
  return {
    ok: true,
    payload: {
      supplierName: input.supplierName.trim(),
      deliveryNoteNo: input.deliveryNoteNo.trim(),
      operator: input.operator.trim(),
      inspector: hasPassedRoll ? input.inspector.trim() : undefined,
      remarks: input.remarks.trim() || undefined,
      rolls: validRolls
    }
  };
}

export function validateAndBuildIssuePayload(input: {
  direction: 'ISSUE' | 'RETURN';
  rollId: string;
  machineId: string;
  shiftTeam: string;
  operator: string;
  targetLocation: string;
  reason: string;
}): LedgerPayloadValidationResult {
  if (!input.rollId.trim() || !input.operator.trim()) {
    return { ok: false, error: '请选择母卷并填写经办人' };
  }
  if (input.direction === 'ISSUE' && !input.machineId.trim()) {
    return { ok: false, error: '车间领料请填写领用机台编号' };
  }
  if (input.direction === 'RETURN' && !input.targetLocation.trim()) {
    return { ok: false, error: '车间退料请填写退回仓库目标库位' };
  }
  const targetLocation =
    input.targetLocation.trim() ||
    (input.direction === 'ISSUE' ? `车间:${input.machineId.trim()}` : '原料库位 R-01');
  return {
    ok: true,
    payload: {
      direction: input.direction,
      rollId: input.rollId.trim(),
      machineId: input.machineId.trim() || undefined,
      shiftTeam: input.shiftTeam.trim() || undefined,
      operator: input.operator.trim(),
      targetLocation,
      reason:
        input.reason.trim() ||
        (input.direction === 'ISSUE' ? '车间领料投产' : '完工余卷退库')
    }
  };
}
