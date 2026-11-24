import React, { useEffect, useMemo, useState } from 'react';
import {
  requestJSON,
  fmtTime,
  shortId,
  fmtN,
  fmtM,
  toast,
  pendingWrite,
  retryWrite,
  dropWrite
} from '@static/app/js/util.js';
import { ModalDialog } from '../components/ModalDialog';
import {
  SegmentedControl,
  CodeBadge,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';
import { idempotentJsonPost } from '../utils/authClient';

const EVENT_LABELS: Record<string, string> = {
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

const AGG_LABELS: Record<string, string> = {
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

const ACTOR_LABELS: Record<string, string> = {
  UNAUTHENTICATED_LOCAL: '本机（未登录）',
  SYSTEM_MIGRATION: '系统迁移'
};

/** Business categories used by the overview KPI cards and as a filter. */
type Category = 'receipt' | 'report' | 'remnant' | 'demand' | 'quality' | 'reverse';

const CATEGORY_EVENTS: Record<Category, string[]> = {
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

const CATEGORY_LABELS: Record<Category, string> = {
  receipt: '母卷入库',
  report: '报工记账',
  remnant: '料头流转',
  demand: '需求调整',
  quality: '验布 / 盘点 / 移库',
  reverse: '冲销 / 作废'
};

const categoryOf = (eventType: string): Category | null =>
  (Object.keys(CATEGORY_EVENTS) as Category[]).find((c) =>
    CATEGORY_EVENTS[c].includes(eventType)
  ) || null;

/** Field labels for before/after diffs: [label, unit]. Lookup uses the last key segment. */
const FIELD_LABELS: Record<string, [string, string?]> = {
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

function eventTagClass(eventType: string): string {
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

async function loadAllLedgerItems(): Promise<any[]> {
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

const asList = (x: any): any[] =>
  Array.isArray(x) ? x : (Object.values(x || {}).find(Array.isArray) as any[]) || [];

const parseJson = (s: any): any => {
  if (!s || typeof s !== 'string') return s && typeof s === 'object' ? s : null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Flatten one level of nested objects (e.g. demand.line.quantity); arrays become counts. */
function flatten(obj: any): Record<string, any> {
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

const fieldLabel = (key: string): [string, string?] => {
  const last = key.split('.').pop() || key;
  return FIELD_LABELS[last] || [key];
};

const fmtVal = (v: any, unit?: string): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    const d = unit === '%' || unit === 'm²' ? 2 : 1;
    return `${fmtN(v, d)}${unit ? ' ' + unit : ''}`;
  }
  return String(v);
};

interface FieldChange {
  key: string;
  label: string;
  unit?: string;
  before: any;
  after: any;
}

/** Before/after diff. Creations only show labelled key fields to stay readable. */
function diffLine(line: any): FieldChange[] {
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

interface Txn {
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
function txnFacts(lines: any[]): string[] {
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

function buildTxns(lines: any[]): Txn[] {
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

type DocTab = 'ledger' | 'receipt' | 'issue' | 'transfer' | 'count';
type RangeKey = 'today' | '7d' | '30d' | 'all';
type ViewKey = 'txn' | 'line';
type Focus =
  | { kind: 'txn'; id: string }
  | { kind: 'obj'; type: string; id: string }
  | { kind: 'report'; id: string }
  | null;

interface ReceiptRollDraft {
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

const createEmptyReceiptRoll = (prev?: ReceiptRollDraft): ReceiptRollDraft => ({
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

type DocPendingSlot = 'inventory-receipt' | 'material-issue';
const DOC_PENDING_LABELS: Record<DocPendingSlot, string> = {
  'inventory-receipt': '采购批量入库单',
  'material-issue': '车间领/退料单'
};

const DAY_MS = 86400000;
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const objectHref = (type: string, id: string): string | null => {
  if (type === 'ROLL' || type === 'MOTHER_ROLL') return `#/inventory?roll=${encodeURIComponent(id)}`;
  if (type === 'REMNANT') return '#/inventory';
  return null;
};

/** Shorten long UUIDs while preserving any `/lineId` suffix (e.g. `32a73567-.../1` -> `32a73567/1`). */
const fmtObjId = (id: any): string => {
  const s = String(id || '');
  if (s.length <= 24) return s;
  const slash = s.indexOf('/');
  if (slash > 8) return `${s.slice(0, 8)}${s.slice(slash)}`;
  return shortId(s);
};

export const DocumentsPage: React.FC = () => {
  const [transfers, setTransfers] = useState<any[]>([]);
  const [counts, setCounts] = useState<any[]>([]);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<DocTab>('ledger');
  const [range, setRange] = useState<RangeKey>('7d');
  const [day, setDay] = useState<string>('');
  const [category, setCategory] = useState<Category | ''>('');
  const [filterAgg, setFilterAgg] = useState<string>('');
  const [view, setView] = useState<ViewKey>('txn');
  const [showOpening, setShowOpening] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [issueDirFilter, setIssueDirFilter] = useState<'ALL' | 'ISSUE' | 'RETURN'>('ALL');
  const [focus, setFocus] = useState<Focus>(null);

  // 新建单据弹窗与表单状态
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [supplierName, setSupplierName] = useState('');
  const [deliveryNoteNo, setDeliveryNoteNo] = useState('');
  const [receiptOperator, setReceiptOperator] = useState('');
  const [receiptRemarks, setReceiptRemarks] = useState('');
  const [receiptRolls, setReceiptRolls] = useState<ReceiptRollDraft[]>(() => [
    createEmptyReceiptRoll()
  ]);

  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueDirection, setIssueDirection] = useState<'ISSUE' | 'RETURN'>('ISSUE');
  const [issueRollId, setIssueRollId] = useState('');
  const [issueMachineId, setIssueMachineId] = useState('');
  const [issueShiftTeam, setIssueShiftTeam] = useState('');
  const [issueOperator, setIssueOperator] = useState('');
  const [issueTargetLoc, setIssueTargetLoc] = useState('');
  const [issueReason, setIssueReason] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, ct, rec, iss, rollList, led] = await Promise.all([
        requestJSON('/api/v2/inventory-transfers'),
        requestJSON('/api/v2/inventory-counts'),
        requestJSON('/api/v2/inventory-receipts').catch(() => []),
        requestJSON('/api/v2/material-issues').catch(() => []),
        requestJSON('/api/rolls').catch(() => []),
        loadAllLedgerItems()
      ]);
      setTransfers(asList(tr));
      setCounts(asList(ct));
      setReceipts(asList(rec));
      setIssues(asList(iss));
      const rArr = asList(rollList);
      setRolls(rArr);
      if (rArr.length && !issueRollId) {
        const firstActive = rArr.find(
          (r: any) =>
            r.inspectionStatus !== 'SCRAPPED' &&
            r.status !== 'SCRAPPED' &&
            (r.currentRemainingLength ?? r.totalLength) > 0
        );
        if (firstActive) setIssueRollId(firstActive.rollId);
      }
      setItems(led);
    } catch (e: any) {
      setError(e.message || '读取库存单据与流水失败');
    } finally {
      setLoading(false);
    }
  };

  const pendingSlots = useMemo(() => {
    void pendingTick;
    return (['inventory-receipt', 'material-issue'] as const)
      .map((s) => [s, pendingWrite(s)] as const)
      .filter(([, v]) => Boolean(v));
  }, [pendingTick, submitting]);

  const handleRetryDoc = async (slot: DocPendingSlot) => {
    try {
      await retryWrite(slot);
      toast(`${DOC_PENDING_LABELS[slot]}已确认过账`);
      await loadData();
    } catch (err: any) {
      toast(err.message || '重试失败', true);
    } finally {
      setPendingTick((t) => t + 1);
    }
  };

  const handleDropDoc = (slot: DocPendingSlot) => {
    dropWrite(slot);
    toast('已放弃未确认草稿，请核对单据列表是否已入账');
    setPendingTick((t) => t + 1);
  };

  const handleSubmitReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!supplierName.trim() || !deliveryNoteNo.trim() || !receiptOperator.trim()) {
      toast('请完整填写供应商名称、送货单号与经办人', true);
      return;
    }
    const validRolls = receiptRolls
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
      toast('请至少录入 1 行包含有效品号、门幅与总长的母卷明细', true);
      return;
    }
    setSubmitting(true);
    try {
      const res = await idempotentJsonPost('inventory-receipt', '/api/v2/inventory-receipts', {
        supplierName: supplierName.trim(),
        deliveryNoteNo: deliveryNoteNo.trim(),
        operator: receiptOperator.trim(),
        remarks: receiptRemarks.trim() || undefined,
        rolls: validRolls
      });
      const createdCount = Array.isArray(res?.createdRolls) ? res.createdRolls.length : validRolls.length;
      toast(`采购入库单已过账！原子创建 ${createdCount} 卷母卷并写入不可变流水`);
      setReceiptModalOpen(false);
      setSupplierName('');
      setDeliveryNoteNo('');
      setReceiptRemarks('');
      setReceiptRolls([createEmptyReceiptRoll()]);
      await loadData();
    } catch (err: any) {
      toast('提交采购入库单失败：' + (err.message || '未知错误'), true);
    } finally {
      setSubmitting(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleSubmitIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!issueRollId.trim() || !issueOperator.trim()) {
      toast('请选择母卷并填写经办人', true);
      return;
    }
    if (issueDirection === 'ISSUE' && !issueMachineId.trim()) {
      toast('车间领料请填写领用机台编号', true);
      return;
    }
    if (issueDirection === 'RETURN' && !issueTargetLoc.trim()) {
      toast('车间退料请填写退回仓库目标库位', true);
      return;
    }
    setSubmitting(true);
    try {
      const targetLocation =
        issueTargetLoc.trim() ||
        (issueDirection === 'ISSUE' ? `车间:${issueMachineId.trim()}` : '原料库位 R-01');
      await idempotentJsonPost('material-issue', '/api/v2/material-issues', {
        direction: issueDirection,
        rollId: issueRollId.trim(),
        machineId: issueMachineId.trim() || undefined,
        shiftTeam: issueShiftTeam.trim() || undefined,
        operator: issueOperator.trim(),
        targetLocation,
        reason: issueReason.trim() || (issueDirection === 'ISSUE' ? '车间领料投产' : '完工余卷退库')
      });
      toast(
        issueDirection === 'ISSUE'
          ? `母卷 ${issueRollId.trim()} 发料单已过账（机台 ${issueMachineId.trim()}）`
          : `母卷 ${issueRollId.trim()} 退料入库单已过账（目标库位 ${targetLocation}）`
      );
      setIssueModalOpen(false);
      setIssueReason('');
      await loadData();
    } catch (err: any) {
      toast('提交车间领/退料单失败：' + (err.message || '未知错误'), true);
    } finally {
      setSubmitting(false);
      setPendingTick((t) => t + 1);
    }
  };

  useEffect(() => {
    loadData();
    // Deep link: #/documents?trace=<objectId> opens the trace panel directly.
    const sp = new URLSearchParams(location.hash.split('?')[1] || '');
    const trace = sp.get('trace');
    if (trace) {
      setFocus({ kind: 'obj', type: sp.get('type') || '', id: trace });
      setRange('all');
    }
  }, []);

  /** Lines within the selected time window (opening migration is never counted in KPIs). */
  const rangeLines = useMemo(() => {
    const now = Date.now();
    const from =
      range === 'today' ? startOfToday() : range === '7d' ? now - 7 * DAY_MS : range === '30d' ? now - 30 * DAY_MS : 0;
    return items.filter(
      (i) =>
        i.eventType !== 'MIGRATION_OPENING' &&
        (day ? dayKey(i.occurredAt) === day : (i.occurredAt || 0) >= from)
    );
  }, [items, range, day]);

  const kpis = useMemo(() => {
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
  }, [rangeLines]);

  /** Daily transaction counts for the last 14 days (chart is independent of the range filter). */
  const daily = useMemo(() => {
    const today = startOfToday();
    const buckets = Array.from({ length: 14 }, (_, i) => {
      const t = today - (13 - i) * DAY_MS;
      return { key: dayKey(t), label: `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`, txns: new Set<string>() };
    });
    const index = new Map(buckets.map((b) => [b.key, b]));
    items.forEach((i) => {
      if (i.eventType === 'MIGRATION_OPENING') return;
      index.get(dayKey(i.occurredAt))?.txns.add(i.transactionId);
    });
    const rows = buckets.map((b) => ({ key: b.key, label: b.label, count: b.txns.size }));
    return { rows, max: Math.max(1, ...rows.map((r) => r.count)) };
  }, [items]);

  const topObjects = useMemo(() => {
    const m = new Map<string, { type: string; id: string; count: number; last: number }>();
    rangeLines.forEach((l) => {
      if (l.aggregateType === 'CHECKPOINT') return;
      const k = l.aggregateType + '|' + l.aggregateId;
      const cur = m.get(k) || { type: l.aggregateType, id: l.aggregateId, count: 0, last: 0 };
      cur.count += 1;
      cur.last = Math.max(cur.last, l.occurredAt || 0);
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 8);
  }, [rangeLines]);

  const aggs = useMemo(
    () => [...new Set(items.map((i) => i.aggregateType).filter(Boolean))],
    [items]
  );
  const openingCount = useMemo(
    () => items.filter((i) => i.eventType === 'MIGRATION_OPENING').length,
    [items]
  );

  const matchesQuery = (i: any, q: string) =>
    [
      i.aggregateId,
      i.businessId,
      i.actor,
      i.transactionId,
      i.eventType,
      EVENT_LABELS[i.eventType],
      ...(i.sourceReportIds || [])
    ].some((v) => String(v || '').toLowerCase().includes(q));

  const filteredLedger = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const inRange = new Set(rangeLines);
    const base = showOpening
      ? items.filter((i) => i.eventType === 'MIGRATION_OPENING' || inRange.has(i))
      : rangeLines;
    return base.filter(
      (i) =>
        (!category || categoryOf(i.eventType) === category) &&
        (!filterAgg || i.aggregateType === filterAgg) &&
        (!q || matchesQuery(i, q))
    );
  }, [items, rangeLines, showOpening, category, filterAgg, searchQuery]);

  const txns = useMemo(() => buildTxns(filteredLedger), [filteredLedger]);

  const focusLines = useMemo(() => {
    if (!focus) return [];
    if (focus.kind === 'txn') return items.filter((i) => (i.transactionId || i.id) === focus.id);
    if (focus.kind === 'obj')
      return items.filter(
        (i) => i.aggregateId === focus.id && (!focus.type || i.aggregateType === focus.type)
      );
    return items.filter((i) => (i.sourceReportIds || []).includes(focus.id) || i.aggregateId === focus.id);
  }, [focus, items]);

  const filteredTransfers = useMemo(() => {
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
  }, [transfers, searchQuery]);

  const filteredCounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return counts;
    return counts.filter((r) => {
      const mats = r.items || r.materials || [];
      return [r.id, r.documentId, r.reason, r.operator, ...mats.map((m: any) => m.id || m.materialId || '')].some(
        (v) => String(v || '').toLowerCase().includes(q)
      );
    });
  }, [counts, searchQuery]);

  const filteredReceipts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter((r) => {
      const rls = r.rolls || r.items || [];
      return [
        r.id,
        r.documentId,
        r.supplierName,
        r.deliveryNoteNo,
        r.operator,
        r.remarks,
        ...rls.map((x: any) => `${x.id || x.rollId || ''} ${x.materialModel || x.rollModel || ''} ${x.batchNo || ''}`)
      ].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [receipts, searchQuery]);

  const filteredIssues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return issues.filter((r) => {
      if (issueDirFilter !== 'ALL' && r.direction !== issueDirFilter) return false;
      if (!q) return true;
      return [
        r.id,
        r.documentId,
        r.direction,
        r.rollId,
        r.machineId,
        r.shiftTeam,
        r.targetLocation,
        r.operator,
        r.reason
      ].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [issues, issueDirFilter, searchQuery]);

  const tabOptions: SegmentedOption<DocTab>[] = useMemo(
    () => [
      { value: 'ledger', label: '库存流水', count: items.length - openingCount, accent: 'indigo' },
      { value: 'receipt', label: '采购入库单', count: receipts.length, accent: 'emerald' },
      { value: 'issue', label: '车间领/退料单', count: issues.length, accent: 'amber' },
      { value: 'transfer', label: '移库单', count: transfers.length },
      { value: 'count', label: '盘点单', count: counts.length }
    ],
    [items.length, openingCount, receipts.length, issues.length, transfers.length, counts.length]
  );

  const rangeOptions: SegmentedOption<RangeKey>[] = [
    { value: 'today', label: '今日' },
    { value: '7d', label: '近 7 天' },
    { value: '30d', label: '近 30 天' },
    { value: 'all', label: '全部' }
  ];

  const viewOptions: SegmentedOption<ViewKey>[] = [
    { value: 'txn', label: '按业务事务', count: txns.length, title: '一次报工 / 入库 / 调整合并为一行' },
    { value: 'line', label: '按变动明细', count: filteredLedger.length, title: '每个对象的每次版本变动一行' }
  ];

  const toggleCategory = (c: Category) => setCategory((cur) => (cur === c ? '' : c));
  const traceObj = (type: string, id: string) => setFocus({ kind: 'obj', type, id });
  const actorText = (a: string) => ACTOR_LABELS[a] || a || '—';

  const activeChips: { key: string; text: string; clear: () => void }[] = [];
  if (day) activeChips.push({ key: 'day', text: `日期 ${day}`, clear: () => setDay('') });
  if (category) activeChips.push({ key: 'cat', text: CATEGORY_LABELS[category], clear: () => setCategory('') });
  if (filterAgg) activeChips.push({ key: 'agg', text: `对象 ${AGG_LABELS[filterAgg] || filterAgg}`, clear: () => setFilterAgg('') });
  if (searchQuery.trim()) activeChips.push({ key: 'q', text: `搜索「${searchQuery.trim()}」`, clear: () => setSearchQuery('') });

  const kpiCard = (
    c: Category | '',
    label: string,
    value: number,
    unit: string,
    sub: React.ReactNode,
    tone?: 'err'
  ) => (
    <button
      type="button"
      key={c || 'all'}
      className={`mp-kpi ${category === c ? 'on' : ''}`}
      data-tone={tone && value > 0 ? tone : undefined}
      onClick={() => (c ? toggleCategory(c) : setCategory(''))}
      aria-pressed={category === c}
      title={c ? `只看「${CATEGORY_LABELS[c]}」，再次点击取消` : '查看全部业务'}
    >
      <span className="mp-kpi-label">{label}</span>
      <span className="mp-kpi-value num">
        {value}
        <small>{unit}</small>
      </span>
      <span className="mp-kpi-sub num">{sub}</span>
    </button>
  );

  const renderChanges = (line: any) => {
    const changes = diffLine(line);
    if (!changes.length) return <span className="muted">无字段变化</span>;
    const creation = !line.beforeJson;
    return (
      <ul className="mp-diff-list">
        {changes.slice(0, 8).map((c) => (
          <li key={c.key}>
            <span className="mp-diff-key">{c.label}</span>
            {creation ? (
              <span className="num">{fmtVal(c.after, c.unit)}</span>
            ) : (
              <span className="num">
                <span className="mp-diff-before">{fmtVal(c.before, c.unit)}</span>
                <span className="mp-diff-arrow">→</span>
                <b>{fmtVal(c.after, c.unit)}</b>
              </span>
            )}
          </li>
        ))}
        {changes.length > 8 && <li className="muted">另有 {changes.length - 8} 项字段变化</li>}
      </ul>
    );
  };

  const renderFocus = () => {
    if (!focus) return null;
    const sorted = focusLines.slice().sort((a, b) => a.sequence - b.sequence);
    const title =
      focus.kind === 'txn'
        ? '业务事务明细'
        : focus.kind === 'obj'
        ? `对象追溯 · ${AGG_LABELS[focus.type] || focus.type || '对象'}`
        : '报工单追溯';
    const href = focus.kind === 'obj' ? objectHref(focus.type, focus.id) : null;
    return (
      <aside className="mp-doc-drawer" aria-label={title}>
        <div className="mp-doc-drawer-head">
          <div>
            <span className="mp-doc-drawer-kicker">{title}</span>
            <strong className="num" title={focus.id}>
              {focus.kind === 'txn' ? shortId(focus.id) : focus.id}
            </strong>
            <span className="mp-doc-drawer-meta num">
              共 {sorted.length} 条变动
              {sorted.length > 0 && ` · ${fmtTime(sorted[0].occurredAt)} 起`}
            </span>
          </div>
          <div className="mp-doc-drawer-actions">
            {href && (
              <a className="mp-ghost-btn" href={href}>
                去台账
              </a>
            )}
            {focus.kind === 'obj' && focus.type === 'ROLL' && (
              <a className="mp-ghost-btn" href={`#/inspection/${encodeURIComponent(focus.id)}`}>
                验布
              </a>
            )}
            <button type="button" className="mp-ghost-btn" onClick={() => setFocus(null)} aria-label="关闭追溯面板">
              关闭
            </button>
          </div>
        </div>
        <ol className="mp-trace-list">
          {sorted.map((l) => (
            <li key={l.id || l.sequence} className="mp-trace-item">
              <div className="mp-trace-top">
                <span className={`tag ${eventTagClass(l.eventType)}`}>{EVENT_LABELS[l.eventType] || l.eventType}</span>
                {focus.kind !== 'obj' ? (
                  <button
                    type="button"
                    className="mp-link-btn num"
                    onClick={() => traceObj(l.aggregateType, l.aggregateId)}
                    title="追溯该对象全部历史"
                  >
                    {AGG_LABELS[l.aggregateType] || l.aggregateType} {fmtObjId(l.aggregateId)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="mp-link-btn num"
                    onClick={() => setFocus({ kind: 'txn', id: l.transactionId || l.id })}
                    title="查看同一事务内的全部变动"
                  >
                    事务 {shortId(l.transactionId)}
                  </button>
                )}
                <span className="mp-trace-time num">
                  #{l.sequence} · {fmtTime(l.occurredAt)}
                </span>
              </div>
              {renderChanges(l)}
              <div className="mp-trace-foot num">
                {actorText(l.actor)} · 版本 {l.beforeVersion} → {l.afterVersion}
                {(l.sourceReportIds || []).map((rid: string) => (
                  <button
                    key={rid}
                    type="button"
                    className="mp-link-btn"
                    onClick={() => setFocus({ kind: 'report', id: rid })}
                    title={rid}
                  >
                    报工 {shortId(rid)}
                  </button>
                ))}
              </div>
            </li>
          ))}
          {sorted.length === 0 && <li className="mp-empty-inline">未找到该对象的库存流水。</li>}
        </ol>
      </aside>
    );
  };

  const objButton = (type: string, id: string) => (
    <button
      type="button"
      className="mp-link-btn num"
      title={`追溯 ${id} 的全部历史`}
      onClick={(e) => {
        e.stopPropagation();
        traceObj(type, id);
      }}
    >
      {fmtObjId(id)}
    </button>
  );

  const renderLedger = () => {
    if (view === 'txn') {
      if (!txns.length) return emptyLedger;
      return (
        <div className="mp-table-scroll">
          <table className="t mp-doc-txn-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>业务</th>
                <th>业务单号</th>
                <th>主对象</th>
                <th>影响范围</th>
                <th>关键变化</th>
                <th>经办</th>
                <th className="r">版本</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr
                  key={t.id}
                  className={`mp-row-link ${focus?.kind === 'txn' && focus.id === t.id ? 'sel' : ''}`}
                  onClick={() => setFocus({ kind: 'txn', id: t.id })}
                >
                  <td className="num">{fmtTime(t.occurredAt)}</td>
                  <td>
                    <span className={`tag ${eventTagClass(t.eventType)}`}>{EVENT_LABELS[t.eventType] || t.eventType}</span>
                  </td>
                  <td>
                    {t.businessId ? <CodeBadge title={t.businessId}>{t.businessId.length > 24 ? shortId(t.businessId) : t.businessId}</CodeBadge> : <span className="muted">—</span>}
                  </td>
                  <td>{t.primary ? objButton(t.primary.type, t.primary.id) : '—'}</td>
                  <td className="mp-doc-agg-cell">
                    {t.aggCounts.map(([type, n]) => (
                      <span key={type} className="mp-agg-chip num">
                        {AGG_LABELS[type] || type} {n}
                      </span>
                    ))}
                  </td>
                  <td className="mp-doc-detail-cell num">
                    {t.facts.length ? t.facts.join('；') : <span className="muted">{t.lines.length} 条变动</span>}
                  </td>
                  <td>{actorText(t.actor)}</td>
                  <td className="r num">
                    {t.beforeVersion} → {t.afterVersion}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (!filteredLedger.length) return emptyLedger;
    return (
      <div className="mp-table-scroll">
        <table className="t">
          <thead>
            <tr>
              <th className="r">序号</th>
              <th>时间</th>
              <th>事件</th>
              <th>对象</th>
              <th>对象编号</th>
              <th>字段变化</th>
              <th>关联报工</th>
              <th>经办</th>
              <th className="r">版本</th>
            </tr>
          </thead>
          <tbody>
            {filteredLedger
              .slice()
              .reverse()
              .map((i) => {
                const changes = diffLine(i);
                return (
                  <tr
                    key={i.sequence}
                    className={`mp-row-link ${focus?.kind === 'obj' && focus.id === i.aggregateId ? 'sel' : ''}`}
                    onClick={() => traceObj(i.aggregateType, i.aggregateId)}
                  >
                    <td className="r num">{i.sequence}</td>
                    <td className="num">{fmtTime(i.occurredAt)}</td>
                    <td>
                      <span className={`tag ${eventTagClass(i.eventType)}`}>{EVENT_LABELS[i.eventType] || i.eventType}</span>
                    </td>
                    <td>
                      <span className="tag kind">{AGG_LABELS[i.aggregateType] || i.aggregateType}</span>
                    </td>
                    <td>{objButton(i.aggregateType, i.aggregateId)}</td>
                    <td className="mp-doc-detail-cell num">
                      {changes.length
                        ? changes
                            .slice(0, 3)
                            .map((c) =>
                              i.beforeJson
                                ? `${c.label} ${fmtVal(c.before, c.unit)}→${fmtVal(c.after, c.unit)}`
                                : `${c.label} ${fmtVal(c.after, c.unit)}`
                            )
                            .join('；') + (changes.length > 3 ? ` 等 ${changes.length} 项` : '')
                        : '—'}
                    </td>
                    <td className="num">
                      {(i.sourceReportIds || []).length > 0 ? (
                        <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {(i.sourceReportIds || []).map((rid: string) => (
                            <button
                              key={rid}
                              type="button"
                              className="mp-link-btn"
                              title={rid}
                              onClick={(e) => {
                                e.stopPropagation();
                                setFocus({ kind: 'report', id: rid });
                              }}
                            >
                              {shortId(rid)}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{actorText(i.actor)}</td>
                    <td className="r num">
                      {i.beforeVersion} → {i.afterVersion}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    );
  };

  const emptyLedger = (
    <div className="mp-empty-inline" style={{ padding: 36 }}>
      <strong>当前条件下没有库存流水</strong>
      可放宽时间范围（如切到「全部」）、取消上方业务卡片筛选或清空搜索词。
    </div>
  );

  return (
    <div className="react-page">
      <div className="mp-page-shell mp-doc-page">
        <div className="mp-page-head">
          <div className="mp-page-title-block">
            <h1>库存单据</h1>
            <span className="mp-page-summary num">
              不可变流水 {items.length - openingCount} 条 · 采购入库 {receipts.length} · 领退料 {issues.length} · 移库 {transfers.length} · 盘点 {counts.length}
            </span>
          </div>
          <div className="mp-toolbar-actions">
            <button type="button" className="mp-ghost-btn" onClick={loadData}>
              刷新
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTab('issue');
                setIssueModalOpen(true);
              }}
            >
              ＋ 车间领/退料
            </button>
            <button
              type="button"
              className="btn pri"
              onClick={() => {
                setTab('receipt');
                setReceiptModalOpen(true);
              }}
            >
              ＋ 采购入库单
            </button>
            <a className="mp-ghost-btn" href="#/inventory">
              库存台账
            </a>
          </div>
        </div>

        {pendingSlots.length > 0 && (
          <div className="mp-inv-notice" style={{ marginBottom: 10 }}>
            {pendingSlots.map(([slot]) => (
              <span key={slot} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span>{DOC_PENDING_LABELS[slot]}提交结果未确认（幂等保护已落盘）</span>
                <button type="button" className="btn sm" onClick={() => handleRetryDoc(slot)}>
                  重试原提交
                </button>
                <button type="button" className="btn sm" onClick={() => handleDropDoc(slot)}>
                  放弃
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mp-doc-subbar">
          <SegmentedControl options={tabOptions} value={tab} onChange={(next) => setTab(next)} ariaLabel="切换单据与流水类型" />
          {tab === 'ledger' && (
            <SegmentedControl
              options={rangeOptions}
              value={range}
              onChange={(next) => {
                setRange(next);
                setDay('');
              }}
              ariaLabel="统计时间范围"
              size="sm"
            />
          )}
        </div>

        {error ? (
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="mp-doc-card">
            <div className="loading">正在读取库存单据与不可变流水…</div>
          </div>
        ) : tab === 'ledger' ? (
          <>
            <div className="mp-kpi-row" role="group" aria-label="库存业务概况，点击卡片筛选">
              {kpiCard('', day ? `${day} 业务事务` : '业务事务', kpis.total, '笔', `${kpis.lines} 条对象变动`)}
              {kpiCard('receipt', '母卷入库', kpis.receipt, '卷', `合计 ${fmtN(kpis.receiptLen / 1000, 1)} m`)}
              {kpiCard('report', '报工记账', kpis.report, '单', `耗用母卷 ${fmtN(kpis.consumed / 1000, 1)} m · 新增料头 ${kpis.newRem} 块`)}
              {kpiCard('remnant', '料头流转', kpis.remnant, '次', `领用 ${kpis.remIssue} · 报废 ${kpis.remScrap}`)}
              {kpiCard('demand', '需求调整', kpis.demand, '笔', `涉及需求行 ${kpis.demandRows}`)}
              {kpiCard('quality', '验布 / 盘点 / 移库', kpis.quality, '笔', `移库单 ${transfers.length} · 盘点单 ${counts.length}`)}
              {kpiCard('reverse', '冲销 / 作废', kpis.reverse, '笔', kpis.reverse ? '需关注原因' : '无异常冲销', 'err')}
            </div>

            <div className="mp-doc-insight">
              <section className="mp-doc-panel" aria-label="近 14 天业务量">
                <div className="mp-doc-panel-head">
                  <strong>近 14 天业务量</strong>
                  <span className="muted">按事务计 · 点柱子筛选当天</span>
                </div>
                <div className="mp-day-chart">
                  {daily.rows.map((r) => (
                    <button
                      type="button"
                      key={r.key}
                      className={`mp-day-col ${day === r.key ? 'on' : ''}`}
                      onClick={() => setDay((cur) => (cur === r.key ? '' : r.key))}
                      title={`${r.key}：${r.count} 笔事务`}
                      disabled={r.count === 0}
                    >
                      <span className="mp-day-count num">{r.count || ''}</span>
                      <span className="mp-day-bar" style={{ height: `${(r.count / daily.max) * 100}%` }} />
                      <span className="mp-day-label num">{r.label}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="mp-doc-panel" aria-label="变动最频繁的对象">
                <div className="mp-doc-panel-head">
                  <strong>变动最频繁的对象</strong>
                  <span className="muted">点击追溯全部历史</span>
                </div>
                {topObjects.length ? (
                  <ul className="mp-top-list">
                    {topObjects.map((o) => (
                      <li key={o.type + o.id}>
                        <button type="button" className="mp-top-item" onClick={() => traceObj(o.type, o.id)}>
                          <span className="tag kind">{AGG_LABELS[o.type] || o.type}</span>
                          <span className="num mp-top-id" title={o.id}>
                            {fmtObjId(o.id)}
                          </span>
                          <span className="num muted">{o.count} 次</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mp-empty-inline">当前时间范围内没有对象变动。</div>
                )}
              </section>
            </div>

            <div className="mp-filter-toolbar">
              <SegmentedControl options={viewOptions} value={view} onChange={(next) => setView(next)} ariaLabel="流水展示粒度" size="sm" />
              <div className="mp-search-wrap">
                <span className="mp-search-ico" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <circle cx="7.2" cy="7.2" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    <path d="m10.8 10.8 2.8 2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  type="search"
                  className="mp-search-input"
                  aria-label="搜索库存流水"
                  placeholder="搜卷号、料头号、业务单号、报工单"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <select
                className="field mp-doc-select"
                aria-label="按对象类型筛选"
                value={filterAgg}
                onChange={(e) => setFilterAgg(e.target.value)}
              >
                <option value="">全部对象</option>
                {aggs.map((a) => (
                  <option key={a} value={a}>
                    {AGG_LABELS[a] || a}
                  </option>
                ))}
              </select>
              <label className="mp-doc-switch-label">
                <input type="checkbox" className="ux-switch" checked={showOpening} onChange={(e) => setShowOpening(e.target.checked)} />
                <span>含期初迁移（{openingCount}）</span>
              </label>
              {activeChips.length > 0 && (
                <div className="mp-chip-row">
                  {activeChips.map((c) => (
                    <button key={c.key} type="button" className="mp-filter-chip" onClick={c.clear} title="移除该筛选">
                      {c.text} ×
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className={`mp-doc-main ${focus ? 'has-drawer' : ''}`}>
              <div className="mp-doc-card">
                {renderLedger()}
                <div className="mp-doc-foot">
                  <span className="num">
                    {view === 'txn'
                      ? `${txns.length} 笔事务 · ${filteredLedger.length} 条变动`
                      : `显示 ${filteredLedger.length} 条变动`}
                    {' · 点击行查看明细与追溯'}
                  </span>
                  <span>
                    面积核对与 CSV 导出见 <a href="#/reconciliation">产出对账 →</a>
                  </span>
                </div>
              </div>
              {renderFocus()}
            </div>
          </>
        ) : tab === 'receipt' ? (
          <div className="mp-doc-card">
            <div className="mp-filter-toolbar" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-2, #e2e8f0)' }}>
              <div className="mp-search-wrap">
                <input
                  type="search"
                  className="mp-search-input"
                  aria-label="搜索采购入库单"
                  placeholder="搜入库单号、供应商、送货单号、母卷号或缸号"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <span className="mp-toolbar-count num">
                显示 {filteredReceipts.length} / 共 {receipts.length} 张采购入库单
              </span>
              <div className="mp-toolbar-actions">
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => setReceiptModalOpen(true)}
                >
                  ＋ 新建采购入库单
                </button>
              </div>
            </div>
            {filteredReceipts.length > 0 ? (
              <div className="mp-table-scroll">
                <table className="t">
                  <thead>
                    <tr>
                      <th>入库单号</th>
                      <th>入库时间</th>
                      <th>供应商</th>
                      <th>送货单号</th>
                      <th className="r">母卷数</th>
                      <th>入库母卷与缸号明细</th>
                      <th>经办人</th>
                      <th className="r">版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReceipts
                      .slice()
                      .reverse()
                      .map((r, idx) => {
                        const rls = r.rolls || r.items || [];
                        const detail = rls
                          .map((x: any) => {
                            const rid = x.id || x.rollId || '—';
                            const model = x.materialModel || x.rollModel || '';
                            const batch = x.batchNo ? `缸:${x.batchNo}` : '';
                            const dim =
                              x.widthMm && x.totalLengthMm
                                ? `${x.widthMm}×${fmtM(x.totalLengthMm)}m`
                                : '';
                            return [rid, model, batch, dim].filter(Boolean).join(' ');
                          })
                          .join('；');
                        return (
                          <tr key={r.id || r.documentId || idx}>
                            <td>
                              <CodeBadge title={r.id || r.documentId}>
                                {shortId(r.id || r.documentId)}
                              </CodeBadge>
                            </td>
                            <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                            <td style={{ fontWeight: 600 }}>{r.supplierName || '—'}</td>
                            <td className="num">{r.deliveryNoteNo || '—'}</td>
                            <td className="r num">{rls.length}</td>
                            <td className="mp-doc-detail-cell num" title={detail}>
                              {detail || '—'}
                              {r.remarks ? ` · 备注：${r.remarks}` : ''}
                            </td>
                            <td>{r.operator || '—'}</td>
                            <td className="r num">
                              {r.beforeRevision != null && r.afterRevision != null
                                ? `${r.beforeRevision} → ${r.afterRevision}`
                                : r.revision ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无采购批量入库单据</strong>
                点击右上角「＋ 新建采购入库单」一次原子录入供应商送货单与多卷新母卷（含缸号、色号、缩水率与库位）。
              </div>
            )}
          </div>
        ) : tab === 'issue' ? (
          <div className="mp-doc-card">
            <div className="mp-filter-toolbar" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line-2, #e2e8f0)' }}>
              <SegmentedControl
                options={[
                  { value: 'ALL', label: '全部', count: issues.length },
                  {
                    value: 'ISSUE',
                    label: '车间领料',
                    count: issues.filter((x) => x.direction === 'ISSUE').length,
                    accent: 'amber'
                  },
                  {
                    value: 'RETURN',
                    label: '车间退料',
                    count: issues.filter((x) => x.direction === 'RETURN').length,
                    accent: 'emerald'
                  }
                ]}
                value={issueDirFilter}
                onChange={(v) => setIssueDirFilter(v)}
                ariaLabel="按领退料方向筛选"
                size="sm"
              />
              <div className="mp-search-wrap">
                <input
                  type="search"
                  className="mp-search-input"
                  aria-label="搜索车间领退料单"
                  placeholder="搜单号、母卷号、机台、班组、库位或经办人"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="mp-toolbar-actions">
                <button
                  type="button"
                  className="btn sm pri"
                  onClick={() => setIssueModalOpen(true)}
                >
                  ＋ 新建领/退料单
                </button>
              </div>
            </div>
            {filteredIssues.length > 0 ? (
              <div className="mp-table-scroll">
                <table className="t">
                  <thead>
                    <tr>
                      <th>单据号</th>
                      <th>时间</th>
                      <th>方向</th>
                      <th>母卷编号</th>
                      <th>机台 / 班组</th>
                      <th>目标库位</th>
                      <th>原因说明</th>
                      <th>经办人</th>
                      <th className="r">版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIssues
                      .slice()
                      .reverse()
                      .map((r, idx) => {
                        const isIssue = r.direction === 'ISSUE';
                        return (
                          <tr key={r.id || r.documentId || idx}>
                            <td>
                              <CodeBadge title={r.id || r.documentId}>
                                {shortId(r.id || r.documentId)}
                              </CodeBadge>
                            </td>
                            <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                            <td>
                              <span className={`tag ${isIssue ? 'warn' : 'ok'}`}>
                                {isIssue ? '领料出库' : '退料入库'}
                              </span>
                            </td>
                            <td>
                              <a
                                href={`#/inventory?roll=${encodeURIComponent(r.rollId || '')}`}
                                className="mp-link-btn num"
                              >
                                {r.rollId || '—'}
                              </a>
                            </td>
                            <td className="num">
                              {[r.machineId, r.shiftTeam].filter(Boolean).join(' · ') || '—'}
                            </td>
                            <td>
                              <span className="tag kind">{r.targetLocation || '—'}</span>
                            </td>
                            <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                            <td>{r.operator || '—'}</td>
                            <td className="r num">
                              {r.beforeRevision != null && r.afterRevision != null
                                ? `${r.beforeRevision} → ${r.afterRevision}`
                                : r.revision ?? '—'}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无车间领/退料单据</strong>
                点击「＋ 新建领/退料单」登记母卷发往裁床机台/班组，或将完工余卷退回原料仓库位。
              </div>
            )}
          </div>
        ) : tab === 'transfer' ? (
          <div className="mp-doc-card">
            {filteredTransfers.length > 0 ? (
              <>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>移库单号</th>
                        <th>过账时间</th>
                        <th>目标库位</th>
                        <th className="r">项数</th>
                        <th>移库材料明细</th>
                        <th>原因</th>
                        <th>经办人</th>
                        <th className="r">版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTransfers
                        .slice()
                        .reverse()
                        .map((r, idx) => {
                          const mats = r.items || r.materials || [];
                          const summary = mats
                            .map(
                              (m: any) =>
                                `${m.id || m.materialId || '—'}${
                                  m.fromLocation ? ` (${m.fromLocation}→${r.destination || m.toLocation || ''})` : ''
                                }`
                            )
                            .join('、');
                          return (
                            <tr key={r.id || r.documentId || idx}>
                              <td>
                                <CodeBadge title={r.id || r.documentId}>{shortId(r.id || r.documentId)}</CodeBadge>
                              </td>
                              <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                              <td>
                                <span className="tag ok">{r.destination || '—'}</span>
                              </td>
                              <td className="r num">{mats.length}</td>
                              <td className="mp-doc-detail-cell num">{summary || '—'}</td>
                              <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                              <td>{r.operator || '—'}</td>
                              <td className="r num">
                                {r.beforeRevision != null && r.afterRevision != null
                                  ? `${r.beforeRevision} → ${r.afterRevision}`
                                  : r.revision ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="mp-doc-foot">
                  <span className="num">
                    显示 {filteredTransfers.length} / 共 {transfers.length} 张移库单
                  </span>
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无移库单据</strong>
                可在「母卷与料头台账」勾选在库材料后发起批量移库。
              </div>
            )}
          </div>
        ) : (
          <div className="mp-doc-card">
            {filteredCounts.length > 0 ? (
              <>
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>盘点单号</th>
                        <th>过账时间</th>
                        <th className="r">盘点项数</th>
                        <th>实测与差异明细</th>
                        <th>盘点原因</th>
                        <th>经办人</th>
                        <th className="r">版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCounts
                        .slice()
                        .reverse()
                        .map((r, idx) => {
                          const mats = r.items || r.materials || [];
                          const summary = mats
                            .map(
                              (m: any) =>
                                `${m.id || m.materialId || '—'}: ${
                                  m.present === false
                                    ? '未见实物'
                                    : `${m.actualWidth ?? m.width ?? '—'}×${m.actualLength ?? m.length ?? '—'} mm`
                                }`
                            )
                            .join('；');
                          return (
                            <tr key={r.id || r.documentId || idx}>
                              <td>
                                <CodeBadge title={r.id || r.documentId}>{shortId(r.id || r.documentId)}</CodeBadge>
                              </td>
                              <td className="num">{fmtTime(r.postedAt || r.createdAt || r.at)}</td>
                              <td className="r num">{mats.length}</td>
                              <td className="mp-doc-detail-cell num">{summary || '—'}</td>
                              <td className="mp-doc-detail-cell">{r.reason || '—'}</td>
                              <td>{r.operator || '—'}</td>
                              <td className="r num">
                                {r.beforeRevision != null && r.afterRevision != null
                                  ? `${r.beforeRevision} → ${r.afterRevision}`
                                  : r.revision ?? '—'}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
                <div className="mp-doc-foot">
                  <span className="num">
                    显示 {filteredCounts.length} / 共 {counts.length} 张盘点单
                  </span>
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 36 }}>
                <strong>暂无盘点单据</strong>
                可在「母卷与料头台账」勾选在库材料后发起实物库存盘点。
              </div>
            )}
          </div>
        )}
      </div>

      {/* 新建采购批量入库单弹窗 */}
      <ModalDialog
        open={receiptModalOpen}
        title="新建采购批量入库单（原子建档多卷母卷与不可变流水）"
        onClose={() => {
          if (!submitting) setReceiptModalOpen(false);
        }}
        maxWidth={920}
      >
        <form onSubmit={handleSubmitReceipt}>
          <div
            className="form"
            style={{
              gridTemplateColumns: '90px 1fr 90px 1fr',
              gap: '8px 12px',
              padding: '4px 0 12px'
            }}
          >
            <label htmlFor="rec-supplier">供应商</label>
            <input
              id="rec-supplier"
              className="field"
              required
              placeholder="如：华联高新纺织印染"
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
            />
            <label htmlFor="rec-delivery">送货单号</label>
            <input
              id="rec-delivery"
              className="field num"
              required
              placeholder="如：DN-20261125-01"
              value={deliveryNoteNo}
              onChange={(e) => setDeliveryNoteNo(e.target.value)}
            />
            <label htmlFor="rec-operator">经办仓管</label>
            <input
              id="rec-operator"
              className="field"
              required
              placeholder="如：仓管王工"
              value={receiptOperator}
              onChange={(e) => setReceiptOperator(e.target.value)}
            />
            <label htmlFor="rec-remarks">备注</label>
            <input
              id="rec-remarks"
              className="field"
              placeholder="选填：来料批次或质检说明"
              value={receiptRemarks}
              onChange={(e) => setReceiptRemarks(e.target.value)}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6
            }}
          >
            <strong style={{ fontSize: 12.5 }}>入库母卷明细（共 {receiptRolls.length} 卷）</strong>
            <div style={{ display: 'inline-flex', gap: 6 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  setReceiptRolls((prev) => [
                    ...prev,
                    createEmptyReceiptRoll(prev[prev.length - 1])
                  ])
                }
              >
                ＋ 复制末行添加母卷
              </button>
            </div>
          </div>

          <div className="mp-table-scroll" style={{ maxHeight: 300, marginBottom: 12 }}>
            <table className="t">
              <thead>
                <tr>
                  <th style={{ minWidth: 112 }}>卷号(选填)</th>
                  <th style={{ minWidth: 112 }}>品号 *</th>
                  <th style={{ minWidth: 74 }}>类型</th>
                  <th style={{ minWidth: 96 }}>缸号</th>
                  <th style={{ minWidth: 82 }}>色号</th>
                  <th style={{ minWidth: 74 }} className="r">门幅 mm</th>
                  <th style={{ minWidth: 84 }} className="r">卷长 mm</th>
                  <th style={{ minWidth: 64 }} className="r">克重</th>
                  <th style={{ minWidth: 64 }} className="r">缩水%</th>
                  <th style={{ minWidth: 96 }}>库位</th>
                  <th style={{ minWidth: 80 }}>检验态</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {receiptRolls.map((row, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        placeholder="留空自动"
                        value={row.id}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) => p.map((x, i) => (i === idx ? { ...x, id: v } : x)));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field num"
                        required
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        value={row.materialModel}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, materialModel: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        value={row.materialType}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, materialType: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        placeholder="BAT-xxx"
                        value={row.batchNo}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, batchNo: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        placeholder="藏青"
                        value={row.color}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, color: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        required
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                        value={row.widthMm}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, widthMm: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={100}
                        required
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                        value={row.totalLengthMm}
                        title={
                          Number(row.totalLengthMm) > 0
                            ? `折合 ${fmtM(Number(row.totalLengthMm))} m`
                            : undefined
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, totalLengthMm: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                        value={row.grammage}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, grammage: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="0.1"
                        className="field num"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12, textAlign: 'right' }}
                        value={row.shrinkageRate}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, shrinkageRate: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="field"
                        style={{ width: '100%', padding: '3px 6px', fontSize: 12 }}
                        value={row.storageLocation}
                        onChange={(e) => {
                          const v = e.target.value;
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, storageLocation: v } : x))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className="field"
                        style={{ width: '100%', padding: '3px 4px', fontSize: 12 }}
                        value={row.inspectionStatus}
                        onChange={(e) => {
                          const v = e.target.value as 'PENDING' | 'PASSED';
                          setReceiptRolls((p) =>
                            p.map((x, i) => (i === idx ? { ...x, inspectionStatus: v } : x))
                          );
                        }}
                      >
                        <option value="PENDING">待检</option>
                        <option value="PASSED">已合格</option>
                      </select>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {receiptRolls.length > 1 && (
                        <button
                          type="button"
                          className="btn sm"
                          aria-label={`删除第 ${idx + 1} 行母卷`}
                          onClick={() =>
                            setReceiptRolls((p) => p.filter((_, i) => i !== idx))
                          }
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
            默认来料检验状态为「待检 (PENDING)」，入库后须经跑布验疵放行方可锁卷排切；支持跨刷新幂等防重。
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => setReceiptModalOpen(false)}
            >
              取消
            </button>
            <button type="submit" className="btn pri" disabled={submitting}>
              {submitting ? '过账中…' : `确认采购入库 (${receiptRolls.length} 卷)`}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* 新建车间领/退料单弹窗 */}
      <ModalDialog
        open={issueModalOpen}
        title="新建车间领 / 退料单"
        onClose={() => {
          if (!submitting) setIssueModalOpen(false);
        }}
        maxWidth={560}
      >
        <form onSubmit={handleSubmitIssue}>
          <div style={{ marginBottom: 12 }}>
            <SegmentedControl
              options={[
                { value: 'ISSUE', label: '车间领料出库 (ISSUE)' },
                { value: 'RETURN', label: '车间余卷退库 (RETURN)' }
              ]}
              value={issueDirection}
              onChange={(next) => {
                setIssueDirection(next);
                if (next === 'RETURN' && issueTargetLoc.startsWith('车间:')) {
                  setIssueTargetLoc('原料库位 R-01');
                }
              }}
              ariaLabel="选择领料或退料方向"
              fullWidth
            />
          </div>
          <div className="form" style={{ gridTemplateColumns: '96px 1fr', padding: '4px 0 14px' }}>
            <label htmlFor="iss-roll">选择母卷</label>
            <select
              id="iss-roll"
              className="field num"
              required
              value={issueRollId}
              onChange={(e) => setIssueRollId(e.target.value)}
            >
              <option value="">请选择在库母卷…</option>
              {rolls
                .filter((r) => r.inspectionStatus !== 'SCRAPPED' && r.status !== 'SCRAPPED')
                .map((r) => (
                  <option key={r.rollId} value={r.rollId}>
                    {r.rollId} · {r.rollModel}
                    {r.batchNo ? ` [缸:${r.batchNo}]` : ''} · 余
                    {fmtM(r.currentRemainingLength ?? r.totalLength)}m · {r.storageLocation || '未分配库位'}
                  </option>
                ))}
            </select>
            <label htmlFor="iss-machine">机台编号</label>
            <input
              id="iss-machine"
              className="field num"
              required={issueDirection === 'ISSUE'}
              placeholder="如：裁床-01 / SLIT-02"
              value={issueMachineId}
              onChange={(e) => {
                const v = e.target.value;
                setIssueMachineId(v);
                if (issueDirection === 'ISSUE' && (!issueTargetLoc || issueTargetLoc.startsWith('车间:'))) {
                  setIssueTargetLoc(v.trim() ? `车间:${v.trim()}` : '');
                }
              }}
            />
            <label htmlFor="iss-shift">班组</label>
            <input
              id="iss-shift"
              className="field"
              placeholder="如：甲班 / 白班一组"
              value={issueShiftTeam}
              onChange={(e) => setIssueShiftTeam(e.target.value)}
            />
            <label htmlFor="iss-loc">目标库位</label>
            <input
              id="iss-loc"
              className="field"
              required
              placeholder={issueDirection === 'ISSUE' ? '如：车间:裁床-01' : '如：原料库位 R-01-A03'}
              value={issueTargetLoc}
              onChange={(e) => setIssueTargetLoc(e.target.value)}
            />
            <label htmlFor="iss-operator">经办人</label>
            <input
              id="iss-operator"
              className="field"
              required
              placeholder="如：领料员陈工"
              value={issueOperator}
              onChange={(e) => setIssueOperator(e.target.value)}
            />
            <label htmlFor="iss-reason">原因说明</label>
            <input
              id="iss-reason"
              className="field"
              placeholder={issueDirection === 'ISSUE' ? '如：按排程工单领用投产' : '如：本班完工余卷退库'}
              value={issueReason}
              onChange={(e) => setIssueReason(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={() => setIssueModalOpen(false)}
            >
              取消
            </button>
            <button type="submit" className="btn pri" disabled={submitting}>
              {submitting
                ? '过账中…'
                : issueDirection === 'ISSUE'
                ? '确认发料出库'
                : '确认退料入库'}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
};
