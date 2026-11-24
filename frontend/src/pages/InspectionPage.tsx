import React, { useEffect, useMemo, useRef, useState } from 'react';
import { requestJSON, fmtM, fmtN, toast, createUuid } from '@static/app/js/util.js';
import {
  validateDefect,
  advance,
  round
} from '@static/js/inspection/inspection-model.js';
import {
  WorkbenchBoardCanvas,
  WorkbenchBoardHandle,
  BoardDefect,
  BoardZone
} from '../components/WorkbenchBoardCanvas';
import { NumberInput } from '../components/ui/NumberInput';
import {
  SegmentedControl,
  CodeBadge,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';

const DEFECT_TYPES: [string, string][] = [
  ['STAIN', '污渍 / 斑点'],
  ['HOLE', '破洞'],
  ['WEFT_DEFECT', '跳纱'],
  ['SLUB', '粗节'],
  ['SHADING', '色差'],
  ['MANUAL_MARK', '其他疵点']
];

const ROLL_STATUS_LABEL: Record<string, [string, string]> = {
  PASSED: ['合格', 'ok'],
  PENDING: ['待检', 'warn'],
  FAILED: ['不合格', 'err'],
  QUARANTINED: ['隔离', 'err']
};

type RollFilterScope = 'ALL' | 'PENDING' | 'PASSED';

const draftKey = (id: string) => 'cutplan.app.inspection.' + id;
const SAVED_EVENT = 'cutplan:inspection-saved';

function withoutSubmitted(items: any[], submitted: any[]): any[] {
  const signatures = new Map(
    submitted.map((d) => [d.captureId, JSON.stringify(d)])
  );
  return (items || []).filter(
    (d) => !d.captureId || signatures.get(d.captureId) !== JSON.stringify(d)
  );
}

const defectAttrs = (type: string) => ({
  defectType: type,
  typeName: DEFECT_TYPES.find((t) => t[0] === type)?.[1] || '其他疵点',
  detectionSource: 'MANUAL_INSPECT',
  avoidanceStrategy: 'MUST_AVOID',
  description: '跑布验疵人工标记'
});

const defectKey = (d: any) => (d.saved ? `saved-${d.id}` : d.captureId);

export const InspectionPage: React.FC<{ params?: string[] }> = ({
  params = []
}) => {
  const [rollParam] = params;

  const [rolls, setRolls] = useState<any[]>([]);
  const [rollFilter, setRollFilter] = useState<RollFilterScope>('ALL');
  const [error, setError] = useState<string | null>(null);
  const [roll, setRoll] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [history, setHistory] = useState<any[][]>([]);
  const [pos, setPos] = useState<number>(0);
  const [posInputText, setPosInputText] = useState<string>('0.000');
  const [step, setStep] = useState<number>(1);
  const [speed, setSpeed] = useState<number>(3);
  const [running, setRunning] = useState<boolean>(false);
  const [tool, setTool] = useState<'mark' | 'select' | 'measure'>('mark');
  const [sel, setSel] = useState<number | null>(null);
  const [overview, setOverview] = useState<boolean>(false);
  const [panelCollapsed, setPanelCollapsed] = useState<boolean>(false);
  const [margin, setMargin] = useState<number>(20);
  const [defaultType, setDefaultType] = useState<string>('STAIN');
  const [saving, setSaving] = useState<boolean>(false);
  const [pointerText, setPointerText] = useState<string>('距右 / 距卷头 · mm');
  const [voidReason, setVoidReason] = useState<string>('');

  // Form inputs for manual entry / editing
  const [fRight, setFRight] = useState<string | number>(0);
  const [fY, setFY] = useState<string | number>(0);
  const [fW, setFW] = useState<string | number>(50);
  const [fH, setFH] = useState<string | number>(50);
  const [fType, setFType] = useState<string>('STAIN');
  const [fMargin, setFMargin] = useState<string | number>(20);

  const canvasRef = useRef<WorkbenchBoardHandle | null>(null);
  const stateRef = useRef({
    roll,
    pending,
    history,
    pos,
    step,
    speed,
    running,
    tool,
    sel,
    overview,
    margin,
    defaultType,
    saving
  });
  stateRef.current = {
    roll,
    pending,
    history,
    pos,
    step,
    speed,
    running,
    tool,
    sel,
    overview,
    margin,
    defaultType,
    saving
  };

  const persistDraft = (r: any, nextPending: any[], nextPos: number) => {
    if (!r?.rollId) return;
    try {
      localStorage.setItem(
        draftKey(r.rollId),
        JSON.stringify({ pending: nextPending, pos: nextPos })
      );
    } catch {}
  };

  const allDefects = useMemo(() => {
    if (!roll) return [];
    return [
      ...(roll.defects || []).map((d: any) => ({ ...d, saved: true })),
      ...pending.map((d: any) => ({ ...d, saved: false }))
    ];
  }, [roll, pending]);

  const filteredRolls = useMemo(() => {
    const base = rolls.filter((x) => {
      if (rollFilter === 'PENDING') return x.inspectionStatus !== 'PASSED';
      if (rollFilter === 'PASSED') return x.inspectionStatus === 'PASSED';
      return true;
    });
    if (roll?.rollId && !base.some((x) => x.rollId === roll.rollId)) {
      const current = rolls.find((x) => x.rollId === roll.rollId) || roll;
      return [current, ...base];
    }
    return base;
  }, [rolls, rollFilter, roll]);

  const [rollQuery, setRollQuery] = useState<string>('');

  // Empty-state roll board: pending first, then by remaining length; free-text search.
  const boardRolls = useMemo(() => {
    const q = rollQuery.trim().toLowerCase();
    const rank = (s: string) => (s === 'PASSED' ? 2 : s === 'FAILED' || s === 'QUARANTINED' ? 1 : 0);
    return filteredRolls
      .filter(
        (x) =>
          !q ||
          [x.rollId, x.rollModel, x.materialName, x.batchNo, x.storageLocation, x.supplier]
            .some((v) => String(v || '').toLowerCase().includes(q))
      )
      .slice()
      .sort(
        (a, b) =>
          rank(a.inspectionStatus) - rank(b.inspectionStatus) ||
          String(a.rollId).localeCompare(String(b.rollId))
      );
  }, [filteredRolls, rollQuery]);

  const rollStats = useMemo(() => {
    const remain = (x: any) =>
      x.currentRemainingLength ?? Math.max(0, (x.totalLength || 0) - (x.usedLength || 0));
    const pendingRolls = rolls.filter((r) => !r.inspectionStatus || r.inspectionStatus === 'PENDING');
    const blocked = rolls.filter(
      (r) => r.inspectionStatus === 'FAILED' || r.inspectionStatus === 'QUARANTINED'
    );
    return {
      pending: pendingRolls.length,
      pendingLength: pendingRolls.reduce((s, r) => s + remain(r), 0),
      passed: rolls.filter((r) => r.inspectionStatus === 'PASSED').length,
      blocked: blocked.length,
      defects: rolls.reduce((s, r) => s + (r.defectsCount ?? (r.defects || []).length), 0),
      withDefects: rolls.filter((r) => (r.defectsCount ?? (r.defects || []).length) > 0).length
    };
  }, [rolls]);

  const rollFilterOptions: SegmentedOption<RollFilterScope>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部', count: rolls.length },
      {
        value: 'PENDING',
        label: '待检',
        count: rolls.filter((r) => r.inspectionStatus !== 'PASSED').length,
        accent: 'indigo'
      },
      {
        value: 'PASSED',
        label: '已检',
        count: rolls.filter((r) => r.inspectionStatus === 'PASSED').length,
        accent: 'emerald'
      }
    ],
    [rolls]
  );

  // Sync editor form fields when selection or position changes
  useEffect(() => {
    if (!roll) return;
    const d = sel != null ? allDefects[sel] : null;
    if (d) {
      setFRight(round(roll.width - d.x - d.w));
      setFY(d.y);
      setFW(d.w);
      setFH(d.h);
      setFType(d.defectType || defaultType);
      setFMargin(d.margin ?? margin);
    } else {
      setFRight(0);
      setFY(Math.round(pos));
      setFW(50);
      setFH(50);
      setFType(defaultType);
      setFMargin(margin);
    }
  }, [sel, roll, allDefects.length]);

  useEffect(() => {
    setPosInputText((pos / 1000).toFixed(3));
  }, [pos]);

  useEffect(() => {
    requestJSON('/api/rolls')
      .then((r) => setRolls(r || []))
      .catch((e) => setError(e.message || '读取母卷列表失败'));
  }, []);

  // Load selected roll by rollParam
  useEffect(() => {
    let cancelled = false;
    setRunning(false);
    if (!rollParam) {
      setRoll(null);
      setPending([]);
      setHistory([]);
      setSel(null);
      return;
    }
    requestJSON('/api/rolls/' + encodeURIComponent(rollParam))
      .then((r) => {
        if (cancelled || !r) return;
        let draft: any = null;
        try {
          draft = JSON.parse(localStorage.getItem(draftKey(r.rollId)) || 'null');
        } catch {}
        const initPending = draft?.pending || [];
        const initPos =
          draft?.pos ?? Math.min(r.usedLength || 0, r.totalLength || 0);
        setRoll(r);
        setPending(initPending);
        setHistory([]);
        setPos(initPos);
        setSel(null);
      })
      .catch((e) => {
        if (!cancelled) {
          toast(e.message, true);
          setRoll(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rollParam]);

  // 静态疵点与已用区段独立 memo（绝不依赖 10Hz 变化的 pos，确保跑布期间零节点销毁重建）
  const inspectionDefects: BoardDefect[] = useMemo(() => {
    if (!roll) return [];
    return allDefects.map((d: any) => ({
      id: defectKey(d),
      x: Number(d.x) || 0,
      y: Number(d.y) || 0,
      w: Math.max(0.5, Number(d.w) || 10),
      h: Math.max(0.5, Number(d.h) || 10),
      margin: Number(d.margin ?? 0),
      label: d.typeName || d.defectType || '疵点',
      editable: !d.saved,
      fresh: !d.saved
    }));
  }, [roll, allDefects]);

  const inspectionZones: BoardZone[] = useMemo(() => {
    if (!roll) return [];
    const usedLen = Number(roll.usedLength || 0);
    const totalLen = Math.max(10, Number(roll.totalLength || 3000));
    if (usedLen <= 0) return [];
    return [
      {
        id: 'roll-used-band',
        startY: 0,
        lengthMm: Math.min(usedLen, totalLen),
        kind: 'used',
        label: `已使用 ${(usedLen / 1000).toFixed(2)} m`
      }
    ];
  }, [roll?.rollId, roll?.usedLength, roll?.totalLength]);

  const emptyDemands = useMemo(() => [], []);
  const emptyPlaced = useMemo(() => [], []);
  const selectedDefectKey = useMemo(() => {
    const curD = sel != null ? allDefects[sel] : null;
    return curD ? String(defectKey(curD)) : null;
  }, [sel, allDefects]);

  // 跟随验布线模式：仅在非全卷视图下平滑移动视口，不触发静态底图/疵点层重建
  const prevOverviewRef = useRef(overview);
  useEffect(() => {
    if (!roll) return;
    const prevOverview = prevOverviewRef.current;
    prevOverviewRef.current = overview;
    if (!overview) {
      canvasRef.current?.followPosition(pos);
    } else if (!prevOverview && overview) {
      canvasRef.current?.fit();
    }
  }, [roll?.rollId, overview, pos]);

  const handleCanvasInteract = () => {
    if (stateRef.current.running) {
      setRunning(false);
      persistDraft(
        stateRef.current.roll,
        stateRef.current.pending,
        stateRef.current.pos
      );
    }
  };

  const handleCanvasCursor = (pt: { x: number; y: number } | null) => {
    const curRoll = stateRef.current.roll;
    if (!curRoll) return;
    setPointerText(
      pt
        ? `距右 ${round(curRoll.width - pt.x)} · 距卷头 ${round(pt.y)} mm`
        : '距右 / 距卷头 · mm'
    );
  };

  const handleCanvasDefectSelect = (key: string) => {
    const st = stateRef.current;
    if (!st.roll) return;
    const list = [
      ...(st.roll.defects || []).map((d: any) => ({ ...d, saved: true })),
      ...st.pending.map((d: any) => ({ ...d, saved: false }))
    ];
    const i = list.findIndex((d) => defectKey(d) === key);
    setSel(i < 0 ? null : i);
  };

  const handleCanvasDefectDraw = (box: { u: number; v: number; du: number; dv: number }) => {
    const st = stateRef.current;
    if (st.saving || !st.roll) return;
    try {
      const d = validateDefect(
        {
          x: box.v,
          y: box.u,
          w: box.dv,
          h: box.du,
          margin: st.margin
        },
        st.roll
      );
      const nextHistory = [
        ...st.history.slice(-49),
        structuredClone(st.pending)
      ];
      const newItem = {
        ...d,
        ...defectAttrs(st.defaultType),
        captureId: createUuid()
      };
      const nextPending = [...st.pending, newItem];
      const savedLen = (st.roll.defects || []).length;
      setHistory(nextHistory);
      setPending(nextPending);
      setSel(savedLen + nextPending.length - 1);
      persistDraft(st.roll, nextPending, st.pos);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  const handleCanvasDefectEdit = (
    key: string,
    box: { u: number; v: number; du: number; dv: number }
  ) => {
    const st = stateRef.current;
    if (st.saving || !st.roll) return;
    const k = st.pending.findIndex((d: any) => d.captureId === key);
    if (k < 0) return;
    try {
      const next = validateDefect(
        {
          ...st.pending[k],
          x: box.v,
          y: box.u,
          w: box.dv,
          h: box.du
        },
        st.roll
      );
      if (JSON.stringify(next) !== JSON.stringify(st.pending[k])) {
        const nextHistory = [
          ...st.history.slice(-49),
          structuredClone(st.pending)
        ];
        const nextPending = st.pending.map((it: any, idx: number) =>
          idx === k ? next : it
        );
        setHistory(nextHistory);
        setPending(nextPending);
        persistDraft(st.roll, nextPending, st.pos);
      }
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  // Automatic roll running timer
  useEffect(() => {
    if (!running || !roll) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const st = stateRef.current;
      if (!st.roll) return;
      try {
        const nextPos = advance(
          st.pos,
          st.speed,
          (now - last) / 1000,
          st.roll.totalLength
        );
        last = now;
        setPos(nextPos);
        if (nextPos >= st.roll.totalLength) {
          setRunning(false);
          persistDraft(st.roll, st.pending, nextPos);
          toast('已到卷尾（仅表示位置到达末端）');
        }
      } catch (e: any) {
        toast(e.message, true);
        setRunning(false);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [running, roll?.rollId]);

  const handleUndo = () => {
    if (saving || !history.length || !roll) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setPending(prev);
    setSel(null);
    persistDraft(roll, prev, pos);
  };

  const handleRemoveSelected = () => {
    if (saving || sel == null || !roll) return;
    const savedCount = (roll.defects || []).length;
    const k = sel - savedCount;
    if (k < 0) return;
    const nextHistory = [...history.slice(-49), structuredClone(pending)];
    const nextPending = pending.filter((_, idx) => idx !== k);
    setHistory(nextHistory);
    setPending(nextPending);
    setSel(null);
    persistDraft(roll, nextPending, pos);
  };

  // Keyboard shortcuts & cross-tab sync
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && stateRef.current.running) {
        setRunning(false);
        persistDraft(
          stateRef.current.roll,
          stateRef.current.pending,
          stateRef.current.pos
        );
      }
    };
    const onSaved = (ev: any) => {
      const { saved, submitted } = ev.detail || {};
      const st = stateRef.current;
      if (!st.roll || st.roll.rollId !== saved?.rollId) return;
      const captures = new Set((submitted || []).map((d: any) => d.captureId));
      const known = new Set([
        ...(st.roll.defects || []).map((d: any) => d.id),
        ...(st.roll.voidedDefects || []).map((d: any) => d.defect.id)
      ]);
      const mergedRoll = {
        ...st.roll,
        defects: [
          ...(st.roll.defects || []),
          ...(saved.defects || []).filter(
            (d: any) => captures.has(d.captureId) && !known.has(d.id)
          )
        ]
      };
      const cleanedPending = withoutSubmitted(st.pending, submitted);
      setRoll(mergedRoll);
      setPending(cleanedPending);
      setSel(null);
      persistDraft(mergedRoll, cleanedPending, st.pos);
    };
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) ||
          target.isContentEditable);
      if (!st.roll || st.saving || isTyping) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => {
          if (r) persistDraft(st.roll, st.pending, st.pos);
          else setOverview(false);
          return !r;
        });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        st.sel != null
      ) {
        const k = st.sel - (st.roll.defects || []).length;
        if (k >= 0) {
          e.preventDefault();
          handleRemoveSelected();
        }
      } else if (e.key === 'Escape' && st.sel != null) {
        setSel(null);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(SAVED_EVENT, onSaved);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(SAVED_EVENT, onSaved);
      document.removeEventListener('keydown', onKey);
    };
  }, [history, pending, pos, roll, saving, sel]);

  const handleSaveToRoll = async () => {
    if (!roll || !pending.length || saving) return;
    setRunning(false);
    const rollId = roll.rollId;
    const submitted = structuredClone(pending);
    setSaving(true);
    try {
      const saved = await requestJSON(
        '/api/rolls/' + encodeURIComponent(rollId) + '/inspection-defects',
        {
          width: roll.width,
          totalLength: roll.totalLength,
          defects: submitted
        }
      );
      let latest: any = null;
      try {
        latest = JSON.parse(localStorage.getItem(draftKey(rollId)) || 'null');
      } catch {}
      if (latest) {
        localStorage.setItem(
          draftKey(rollId),
          JSON.stringify({
            ...latest,
            pending: withoutSubmitted(latest.pending, submitted)
          })
        );
      }
      window.dispatchEvent(
        new CustomEvent(SAVED_EVENT, { detail: { saved, submitted } })
      );
      const refreshed = await requestJSON('/api/rolls');
      setRolls(refreshed || []);
      toast('本次疵点已保存到母卷');
    } catch (e: any) {
      toast('保存失败，记录仍保留在本机：' + e.message, true);
    } finally {
      setSaving(false);
    }
  };

  const handleApplyManualDefect = () => {
    if (saving || !roll) return;
    try {
      const wNum = Number(fW);
      const rightNum = Number(fRight);
      const d = validateDefect(
        {
          x: round(roll.width - rightNum - wNum),
          y: Number(fY),
          w: wNum,
          h: Number(fH),
          margin: Number(fMargin)
        },
        roll
      );
      const item = { ...d, ...defectAttrs(fType) };
      const nextHistory = [...history.slice(-49), structuredClone(pending)];
      const savedCount = (roll.defects || []).length;

      let nextPending: any[];
      let nextSel: number;
      if (sel != null && sel >= savedCount) {
        const k = sel - savedCount;
        nextPending = pending.map((it, idx) =>
          idx === k ? { ...it, ...item } : it
        );
        nextSel = sel;
      } else {
        nextPending = [
          ...pending,
          { ...item, captureId: createUuid() }
        ];
        nextSel = savedCount + nextPending.length - 1;
      }

      setHistory(nextHistory);
      setPending(nextPending);
      setSel(nextSel);
      setMargin(d.margin);
      setDefaultType(item.defectType);
      persistDraft(roll, nextPending, pos);
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  const handleVoidDefect = async () => {
    if (!roll || sel == null || saving) return;
    const d = allDefects[sel];
    if (!d?.saved) return;
    if (!voidReason.trim()) {
      toast('请填写作废原因', true);
      return;
    }
    setSaving(true);
    try {
      const updated = await requestJSON(
        `/api/rolls/${encodeURIComponent(roll.rollId)}/defects/${encodeURIComponent(
          d.id
        )}/void`,
        { reason: voidReason.trim() }
      );
      setRoll(updated);
      setSel(null);
      setVoidReason('');
      toast('疵点已作废并留痕；该卷候选方案需重新计算');
    } catch (e: any) {
      toast('作废失败：' + e.message, true);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="react-page">
        <div className="mp-page-shell">
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const selectedDefect = sel != null ? allDefects[sel] : null;
  const editable = Boolean(selectedDefect && !selectedDefect.saved);
  const inCutArea = Boolean(
    selectedDefect &&
      selectedDefect.saved &&
      selectedDefect.y + selectedDefect.h <= (roll?.usedLength || 0)
  );
  const [rollStatusText, rollStatusCls] = roll
    ? ROLL_STATUS_LABEL[roll.inspectionStatus] || [roll.inspectionStatus || '待检', 'warn']
    : ['', ''];

  return (
    <div className="react-page mp-insp-page">
      {/* Compact Light Top Header Bar */}
      <div className="mp-insp-head inspection-head">
        <h1>跑布验疵</h1>

        <SegmentedControl
          options={rollFilterOptions}
          value={rollFilter}
          onChange={(next) => setRollFilter(next)}
          ariaLabel="筛选母卷验布状态"
          size="sm"
        />

        <select
          className="field mp-insp-roll-select"
          id="roll"
          aria-label="选择验布母卷"
          value={roll?.rollId || ''}
          onChange={(e) => {
            location.hash = e.target.value
              ? '#/inspection/' + encodeURIComponent(e.target.value)
              : '#/inspection';
          }}
        >
          <option value="">选择母卷开始验布</option>
          {filteredRolls.map((x) => (
            <option key={x.rollId} value={x.rollId}>
              {x.rollId} · {x.rollModel || ''} · {fmtN(x.width)} mm ×{' '}
              {fmtM(x.totalLength)} m
            </option>
          ))}
        </select>

        {roll && <span className={`tag ${rollStatusCls}`}>{rollStatusText}</span>}

        {roll && (roll.usedLength || 0) > 0 && (
          <CodeBadge title="已切割区段历史疵点不可作废，验布默认从已切终点起跳">
            已切 0~{fmtM(roll.usedLength)}m · 余长{' '}
            {fmtM(Math.max(0, roll.totalLength - roll.usedLength))}m
          </CodeBadge>
        )}

        <div className="mp-toolbar-actions">
          {roll && (
            <a
              className="mp-ghost-btn"
              href={`#/inventory?roll=${encodeURIComponent(roll.rollId)}`}
              title="跳转到母卷台账查看已切割区域与排程预占空间图"
            >
              看已切割区域
            </a>
          )}
          <a
            className="mp-ghost-btn"
            href="#/inventory/receive"
            title="登记母卷后返回跑布验疵"
          >
            新建母卷
          </a>
          <button
            type="button"
            className="btn pri"
            id="save"
            disabled={!pending.length || saving}
            onClick={handleSaveToRoll}
          >
            保存到母卷{pending.length ? ` (${pending.length})` : ''}
          </button>
        </div>
      </div>

      {!roll ? (
        <div className="mp-insp-empty-wrap">
          <div className="mp-insp-board">
            <div className="mp-kpi-row" role="group" aria-label="母卷验布概况">
              <button
                type="button"
                className={`mp-kpi ${rollFilter === 'PENDING' ? 'on' : ''}`}
                onClick={() => setRollFilter('PENDING')}
                title="筛选未通过验布的母卷"
              >
                <span className="mp-kpi-label">待验布</span>
                <span className="mp-kpi-value num">
                  {rollStats.pending}
                  <small>卷</small>
                </span>
                <span className="mp-kpi-sub num">待检余长 {fmtM(rollStats.pendingLength)} m</span>
              </button>
              <button
                type="button"
                className={`mp-kpi ${rollFilter === 'PASSED' ? 'on' : ''}`}
                onClick={() => setRollFilter('PASSED')}
                title="筛选验布合格母卷"
              >
                <span className="mp-kpi-label">验布合格</span>
                <span className="mp-kpi-value num">
                  {rollStats.passed}
                  <small>卷</small>
                </span>
                <span className="mp-kpi-sub">可进入排料与报工</span>
              </button>
              <div className="mp-kpi" data-tone={rollStats.blocked ? 'err' : undefined}>
                <span className="mp-kpi-label">不合格 / 隔离</span>
                <span className="mp-kpi-value num">
                  {rollStats.blocked}
                  <small>卷</small>
                </span>
                <span className="mp-kpi-sub">不参与排料</span>
              </div>
              <div className="mp-kpi">
                <span className="mp-kpi-label">已登记疵点</span>
                <span className="mp-kpi-value num">
                  {rollStats.defects}
                  <small>处</small>
                </span>
                <span className="mp-kpi-sub num">分布在 {rollStats.withDefects} 卷</span>
              </div>
            </div>

            <div className="mp-insp-board-card">
              <div className="mp-insp-board-head">
                <div>
                  <h2>选择一卷母卷开始跑布验疵</h2>
                  <p>
                    疵点按距卷头的绝对物理坐标（mm）记录；本机草稿自动暂存，点右上角「保存到母卷」才正式入档。
                  </p>
                </div>
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
                    aria-label="搜索母卷"
                    placeholder="搜卷号、品号、批次、库位"
                    value={rollQuery}
                    onChange={(e) => setRollQuery(e.target.value)}
                  />
                </div>
              </div>
              {boardRolls.length > 0 ? (
                <div className="mp-table-scroll">
                  <table className="t mp-insp-board-table">
                    <thead>
                      <tr>
                        <th>卷号</th>
                        <th>验布状态</th>
                        <th>品号 / 材料</th>
                        <th>批次</th>
                        <th className="r">幅宽 mm</th>
                        <th className="r">总长 m</th>
                        <th className="r">已切 m</th>
                        <th className="r">余长 m</th>
                        <th className="r">疵点</th>
                        <th>库位</th>
                        <th>验布记录</th>
                        <th className="r">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boardRolls.map((x) => {
                        const [stTxt, stCls] = ROLL_STATUS_LABEL[x.inspectionStatus] || [
                          x.inspectionStatus || '待检',
                          'warn'
                        ];
                        const used = x.usedLength || 0;
                        const remain =
                          x.currentRemainingLength ?? Math.max(0, (x.totalLength || 0) - used);
                        const dc = x.defectsCount ?? (x.defects || []).length;
                        const href = `#/inspection/${encodeURIComponent(x.rollId)}`;
                        return (
                          <tr
                            key={x.rollId}
                            className="mp-row-link"
                            onClick={() => {
                              location.hash = href;
                            }}
                          >
                            <td>
                              <strong className="num">{x.rollId}</strong>
                            </td>
                            <td>
                              <span className={`tag ${stCls}`}>{stTxt}</span>
                            </td>
                            <td>{x.rollModel || x.materialName || '未分类品号'}</td>
                            <td className="num muted">{x.batchNo || '—'}</td>
                            <td className="r num">{fmtN(x.width)}</td>
                            <td className="r num">{fmtM(x.totalLength)}</td>
                            <td className="r num">{used > 0 ? fmtM(used) : '—'}</td>
                            <td className="r num">{fmtM(remain)}</td>
                            <td className="r num">
                              {dc > 0 ? <span className="tag warn">{dc} 处</span> : <span className="muted">0</span>}
                            </td>
                            <td className="muted">{x.storageLocation || '—'}</td>
                            <td className="muted num">
                              {x.inspectionDate ? `${x.inspectionDate} · ${x.inspector || '—'}` : '未验布'}
                            </td>
                            <td className="r">
                              <a
                                className={x.inspectionStatus === 'PASSED' ? 'mp-ghost-btn' : 'mp-ghost-btn mp-ghost-strong'}
                                href={href}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {x.inspectionStatus === 'PASSED' ? '复验' : '开始验布'}
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mp-empty-inline" style={{ padding: 36 }}>
                  当前条件下暂无母卷，可清空搜索词、切换上方筛选器或先登记新母卷。
                </div>
              )}
              <div className="mp-doc-foot">
                <span className="num">
                  显示 {boardRolls.length} / 共 {rolls.length} 卷 · 未通过验布的母卷排在最前
                </span>
                <a href="#/inventory/receive">登记新母卷 →</a>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Compact Light Tool & Roll Feed Control Bar */}
          <div className="mp-insp-feedbar">
            <div
              className="mp-seg mp-seg-sm"
              role="group"
              aria-label="画布验疵工具切换"
            >
              <button
                type="button"
                data-tool="mark"
                className={`mp-seg-btn ${tool === 'mark' ? 'on' : ''}`}
                aria-pressed={tool === 'mark'}
                onClick={() => setTool('mark')}
              >
                标记疵点
              </button>
              <button
                type="button"
                data-tool="select"
                className={`mp-seg-btn ${tool === 'select' ? 'on' : ''}`}
                aria-pressed={tool === 'select'}
                onClick={() => setTool('select')}
              >
                选择 / 调整
              </button>
              <button
                type="button"
                data-tool="measure"
                className={`mp-seg-btn ${tool === 'measure' ? 'on' : ''}`}
                aria-pressed={tool === 'measure'}
                onClick={() => setTool('measure')}
              >
                测距
              </button>
            </div>

            <span className="mp-insp-vsep" />

            <div className="mp-insp-feed-group">
              <span className="muted">位置</span>
              <input
                className="field num"
                id="pos"
                aria-label="当前位置米数"
                style={{ width: 82, textAlign: 'right' }}
                value={posInputText}
                onChange={(e) => setPosInputText(e.target.value)}
              />
              <span className="muted">m</span>
              <button
                type="button"
                className="btn sm"
                id="locate"
                onClick={() => {
                  const m = Number(posInputText);
                  if (!(m >= 0)) {
                    toast('请输入有效米数', true);
                    return;
                  }
                  const nextPos = Math.min(roll.totalLength, round(m * 1000));
                  setPos(nextPos);
                  persistDraft(roll, pending, nextPos);
                }}
              >
                定位 / 校准
              </button>
            </div>

            <span className="mp-insp-vsep" />

            <div className="mp-insp-feed-group">
              <span className="muted">步进</span>
              <NumberInput
                className="field num"
                id="step"
                aria-label="每次前进米数"
                min={0.1}
                step={0.1}
                fallback={1}
                style={{ width: 54, textAlign: 'right' }}
                value={step}
                onValueChange={setStep}
              />
              <span className="muted">m</span>
              <button
                type="button"
                className="btn sm"
                id="advance"
                onClick={() => {
                  const nextPos = Math.min(roll.totalLength, pos + step * 1000);
                  setPos(nextPos);
                  persistDraft(roll, pending, nextPos);
                }}
              >
                前进 ↓
              </button>
            </div>

            <span className="mp-insp-vsep" />

            <div className="mp-insp-feed-group">
              <span className="muted">速度</span>
              <NumberInput
                className="field num"
                id="speed"
                aria-label="自动跑布速度"
                min={0.1}
                step={0.1}
                fallback={3}
                style={{ width: 54, textAlign: 'right' }}
                value={speed}
                onValueChange={setSpeed}
              />
              <span className="muted">m/min</span>
              <button
                type="button"
                className={`btn sm ${running ? 'soft-accent' : ''}`}
                id="run"
                onClick={() => {
                  if (running) {
                    setRunning(false);
                    persistDraft(roll, pending, pos);
                  } else {
                    setOverview(false);
                    setRunning(true);
                    canvasRef.current?.followPosition(pos);
                  }
                }}
              >
                {running ? '暂停跑布' : '自动跑布'}
              </button>
            </div>

            <span className="sp" />
            <span className="mp-toolbar-count">
              {running ? '自动跑布中 · 空格随时暂停' : '手动模式 · 空格启停'}
            </span>
          </div>

          {/* Floating Light-Shell 3-Card Workspace */}
          <div
            className="mp-insp-workspace"
            style={{
              gridTemplateColumns: panelCollapsed
                ? '52px minmax(0, 1fr)'
                : '52px minmax(0, 1fr) 368px'
            }}
          >
            {/* Card 1: Vertical Full-Roll Navigator Track */}
            <section
              className="mp-insp-track-card"
              title="全卷位置导轨：点击跳转"
            >
              <div className="mp-insp-track-label">全卷</div>
              <div
                className="vtrack"
                id="vtrack"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const nextPos = round(
                    ((e.clientY - r.top) / r.height) * roll.totalLength
                  );
                  setPos(nextPos);
                  persistDraft(roll, pending, nextPos);
                }}
              >
                {allDefects.map((d, idx) => (
                  <i
                    key={defectKey(d) || idx}
                    className={d.saved ? '' : 'new'}
                    style={{ top: `${(d.y / roll.totalLength) * 100}%` }}
                  />
                ))}
                <b style={{ height: `${(pos / roll.totalLength) * 100}%` }} />
                <em style={{ top: `${(pos / roll.totalLength) * 100}%` }} />
              </div>
              <div
                className="num"
                style={{ color: '#9aa4b2', fontSize: 10, marginTop: 6 }}
              >
                {fmtM(roll.totalLength)}m
              </div>
            </section>

            {/* Card 2: Dark Charcoal #181c22 CAD Inspection Viewport */}
            <section className="mp-insp-canvas-card">
              <div className="ctool">
                <div className="vseg">
                  <button
                    type="button"
                    id="follow"
                    className={!overview ? 'on' : ''}
                    onClick={() => {
                      setOverview(false);
                      setTimeout(() => canvasRef.current?.followPosition(stateRef.current.pos), 0);
                    }}
                  >
                    跟随验布线
                  </button>
                  <button
                    type="button"
                    id="overview"
                    className={overview ? 'on' : ''}
                    onClick={() => {
                      setRunning(false);
                      setOverview(true);
                      setTimeout(() => canvasRef.current?.fit(), 0);
                    }}
                  >
                    全卷
                  </button>
                </div>
                <button
                  type="button"
                  id="undo"
                  title="撤销本次未保存的操作（Ctrl+Z）"
                  disabled={!history.length || saving}
                  onClick={handleUndo}
                >
                  ↶ 撤销
                </button>
                <button
                  type="button"
                  id="toggle-panel"
                  aria-expanded={!panelCollapsed}
                  title="收起或展开右侧疵点记录卡"
                  onClick={() => setPanelCollapsed((c) => !c)}
                >
                  {panelCollapsed ? '展开记录' : '收起记录'}
                </button>
                <span className="sp" />
                <span id="pointer-position" className="num">
                  {pointerText}
                </span>
              </div>
              <div className="canvas-wrap">
                <div
                  id="isvg"
                  style={{
                    position: 'absolute',
                    inset: 0
                  }}
                >
                  <WorkbenchBoardCanvas
                    rollTitle={roll.rollId ? String(roll.rollId) : '验布母卷'}
                    rollWidthMm={Math.max(10, Number(roll.width || 1500))}
                    rollLengthMm={Math.max(10, Number(roll.totalLength || 3000))}
                    occupiedLengthMm={0}
                    trimStartMm={0}
                    pieceGapMm={0}
                    defects={inspectionDefects}
                    demands={emptyDemands}
                    placedPieces={emptyPlaced}
                    zones={inspectionZones}
                    feedPositionMm={pos}
                    selectedDefectId={selectedDefectKey}
                    showStaging={false}
                    interactivePieces={false}
                    vertical={true}
                    tool={
                      tool === 'mark'
                        ? 'defect'
                        : tool === 'measure'
                        ? 'measure'
                        : 'pan'
                    }
                    showDimensions={true}
                    showPath={false}
                    highlightedDemandKey={null}
                    selectedPieceIndex={null}
                    ariaLabel="验布实时画布"
                    onInteract={handleCanvasInteract}
                    onCursorMove={handleCanvasCursor}
                    onDefectSelect={handleCanvasDefectSelect}
                    onDefectDraw={handleCanvasDefectDraw}
                    onDefectEdit={handleCanvasDefectEdit}
                    boardRef={canvasRef}
                  />
                </div>
              </div>
            </section>

            {/* Card 3: Pure-White 12px Defect Records & Precision Editor Card */}
            <section
              className="mp-insp-side-card"
              style={panelCollapsed ? { display: 'none' } : undefined}
            >
              <div className="pane-h">
                <span>疵点记录</span>
                <span className="sp" />
                <span className="sub num">
                  已入档 {allDefects.length - pending.length} · 待保存 {pending.length}
                </span>
              </div>
              <div className="pane-b">
                <div id="editor">
                  <div className="sec">
                    {selectedDefect
                      ? editable
                        ? '本次标记 · 可修改 / Delete 删除'
                        : '已入档疵点'
                      : '精确坐标录入'}
                  </div>
                  {selectedDefect && (
                    <div className="kv">
                      <div>位置</div>
                      <div className="num">
                        Y {(selectedDefect.y / 1000).toFixed(3)} m · 距右{' '}
                        {fmtN(
                          roll.width - selectedDefect.x - selectedDefect.w,
                          1
                        )}{' '}
                        mm
                      </div>
                      <div>来源</div>
                      <div>
                        {selectedDefect.detectionSource || '—'}
                        {selectedDefect.description
                          ? ' · ' + selectedDefect.description
                          : ''}
                      </div>
                    </div>
                  )}
                  {selectedDefect && !editable && (
                    inCutArea ? (
                      <div className="notice">
                        该疵点位于已切区域，属于历史记录，不能作废。
                      </div>
                    ) : (
                      <>
                        <div className="mp-insp-void-row">
                          <input
                            className="field"
                            id="void-reason"
                            placeholder="作废原因（必填，如：复核为误检）"
                            style={{ flex: 1, height: 30 }}
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value)}
                          />
                          <button
                            type="button"
                            className="btn sm"
                            id="void"
                            disabled={saving}
                            onClick={handleVoidDefect}
                          >
                            作废
                          </button>
                        </div>
                        <div className="mp-insp-void-note">
                          作废后不再避让，原记录与原因留痕；该卷上未报工的候选方案需重新计算。
                        </div>
                      </>
                    )
                  )}

                  <div className="form">
                    <label>
                      距右边缘 mm
                      <input
                        type="number"
                        data-f="right"
                        className="field num"
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fRight}
                        onChange={(e) => setFRight(e.target.value)}
                      />
                    </label>
                    <label>
                      距卷头 mm
                      <input
                        type="number"
                        data-f="y"
                        className="field num"
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fY}
                        onChange={(e) => setFY(e.target.value)}
                      />
                    </label>
                    <label>
                      疵点宽 mm
                      <input
                        type="number"
                        data-f="w"
                        className="field num"
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fW}
                        onChange={(e) => setFW(e.target.value)}
                      />
                    </label>
                    <label>
                      疵点长 mm
                      <input
                        type="number"
                        data-f="h"
                        className="field num"
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fH}
                        onChange={(e) => setFH(e.target.value)}
                      />
                    </label>
                    <label>
                      类型
                      <select
                        data-f="type"
                        className="field"
                        disabled={Boolean(selectedDefect && !editable)}
                        value={fType}
                        onChange={(e) => setFType(e.target.value)}
                      >
                        {DEFECT_TYPES.map(([k, t]) => (
                          <option key={k} value={k}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      避让外扩 mm
                      <input
                        type="number"
                        data-f="margin"
                        className="field num"
                        disabled={Boolean(selectedDefect && !editable)}
                        value={fMargin}
                        onChange={(e) => setFMargin(e.target.value)}
                      />
                    </label>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      padding: '0 13px 10px',
                      justifyContent: 'flex-end'
                    }}
                  >
                    {selectedDefect && (
                      <button
                        type="button"
                        id="new"
                        className="btn sm"
                        onClick={() => setSel(null)}
                      >
                        新标记
                      </button>
                    )}
                    {editable ? (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={handleRemoveSelected}
                        >
                          删除
                        </button>
                        <button
                          type="button"
                          id="apply"
                          className="btn sm soft-accent"
                          onClick={handleApplyManualDefect}
                        >
                          更新标记
                        </button>
                      </>
                    ) : !selectedDefect ? (
                      <button
                        type="button"
                        id="apply"
                        className="btn sm soft-accent"
                        onClick={handleApplyManualDefect}
                      >
                        添加到本次记录
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="sec">全部疵点 · 点击定位（{allDefects.length}）</div>
                {allDefects.length > 0 ? (
                  <div className="mp-table-scroll">
                    <table className="t">
                      <thead>
                        <tr>
                          <th>Y m</th>
                          <th className="r">距右</th>
                          <th className="r">宽×长</th>
                          <th>类型</th>
                          <th style={{ textAlign: 'right' }}>状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allDefects.map((d, i) => (
                          <tr
                            key={defectKey(d) || i}
                            className={`click ${sel === i ? 'sel' : ''}`}
                            onClick={() => {
                              setRunning(false);
                              setSel(i);
                              const nextPos = Math.min(roll.totalLength, d.y + 300);
                              setPos(nextPos);
                              setOverview(false);
                              persistDraft(roll, pending, nextPos);
                              setTimeout(() => canvasRef.current?.followPosition(nextPos), 0);
                            }}
                          >
                            <td className="num">{(d.y / 1000).toFixed(2)}</td>
                            <td className="r num">
                              {fmtN(roll.width - d.x - d.w, 1)}
                            </td>
                            <td className="r num">
                              {fmtN(d.w, 1)}×{fmtN(d.h, 1)}
                            </td>
                            <td>{d.typeName || d.defectType}</td>
                            <td style={{ textAlign: 'right' }}>
                              {d.saved ? (
                                <span className="tag">已入档</span>
                              ) : (
                                <span className="tag warn">待保存</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="mp-empty-inline">
                    暂未标记疵点，可直接在左侧画布框选或上方录入坐标
                  </div>
                )}

                {(roll.voidedDefects || []).length > 0 && (
                  <>
                    <div className="sec">
                      已作废 {roll.voidedDefects.length} 处 · 留痕
                    </div>
                    <div className="mp-table-scroll">
                      <table className="t">
                        <tbody>
                          {roll.voidedDefects
                            .slice()
                            .reverse()
                            .map((v: any, idx: number) => (
                              <tr key={idx}>
                                <td className="num muted">
                                  {(v.defect.y / 1000).toFixed(2)} m
                                </td>
                                <td className="muted">
                                  {v.defect.typeName || v.defect.defectType}
                                </td>
                                <td className="wrap muted" title={v.voidedAt}>
                                  {v.reason}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
              <div className="mp-insp-side-foot">
                本次记录保存在本机；点击右上角「保存到母卷」入档后用于裁切避让，已有方案需重新核对。
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
};
