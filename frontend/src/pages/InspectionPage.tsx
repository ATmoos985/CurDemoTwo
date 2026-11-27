import React, { useEffect, useMemo, useRef, useState } from 'react';
import { requestJSON, fmtM, fmtN, toast, createUuid } from '../lib/core/util.js';
import { validateDefect, advance, round } from '../lib/domain/inspection-model.js';
import { WorkbenchBoardHandle, BoardDefect, BoardZone } from '../components/WorkbenchBoardCanvas';
import { SegmentedControl, CodeBadge, SegmentedOption } from '../components/ui/MagpiePrimitives';
import { AuthSession, LOCAL_FALLBACK_SESSION } from '../utils/authClient';
import {
  ROLL_STATUS_LABEL,
  RollFilterScope,
  SAVED_EVENT,
  computeRollStats,
  defectAttrs,
  defectKey,
  draftKey,
  withoutSubmitted
} from './inspection/inspectionTypes';
import { InspectionRollBoard } from './inspection/InspectionRollBoard';
import { InspectionCanvasWorkspace } from './inspection/InspectionCanvasWorkspace';
import { InspectionDecisionModal } from './inspection/InspectionDecisionModal';
import { InspectionBatchDefectModal } from './inspection/InspectionBatchDefectModal';

export const InspectionPage: React.FC<{
  params?: string[];
  auth?: AuthSession;
}> = ({ params = [], auth = LOCAL_FALLBACK_SESSION }) => {
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
  const [inspectModalAction, setInspectModalAction] = useState<'PASSED' | 'FAILED' | null>(null);
  const [inspectorName, setInspectorName] = useState<string>('');
  const [inspectRemarks, setInspectRemarks] = useState<string>('');
  const [inspectSubmitting, setInspectSubmitting] = useState<boolean>(false);
  const [batchDefectModalOpen, setBatchDefectModalOpen] = useState<boolean>(false);

  const [fRight, setFRight] = useState<string | number>(0);
  const [fY, setFY] = useState<string | number>(0);
  const [fW, setFW] = useState<string | number>(50);
  const [fH, setFH] = useState<string | number>(50);
  const [fType, setFType] = useState<string>('STAIN');
  const [fMargin, setFMargin] = useState<string | number>(20);

  const canvasRef = useRef<WorkbenchBoardHandle | null>(null);
  const stateRef = useRef({
    roll, pending, history, pos, step, speed, running, tool, sel, overview, margin, defaultType, saving
  });
  stateRef.current = {
    roll, pending, history, pos, step, speed, running, tool, sel, overview, margin, defaultType, saving
  };

  const persistDraft = (r: any, nextPending: any[], nextPos: number) => {
    if (!r?.rollId) return;
    try {
      localStorage.setItem(draftKey(r.rollId), JSON.stringify({ pending: nextPending, pos: nextPos }));
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
  const boardRolls = useMemo(() => {
    const q = rollQuery.trim().toLowerCase();
    const rank = (s: string) => (s === 'PASSED' ? 2 : s === 'FAILED' || s === 'QUARANTINED' ? 1 : 0);
    return filteredRolls
      .filter(
        (x) =>
          !q ||
          [x.rollId, x.rollModel, x.materialName, x.batchNo, x.storageLocation, x.supplier].some((v) =>
            String(v || '').toLowerCase().includes(q)
          )
      )
      .slice()
      .sort(
        (a, b) =>
          rank(a.inspectionStatus) - rank(b.inspectionStatus) ||
          String(a.rollId).localeCompare(String(b.rollId))
      );
  }, [filteredRolls, rollQuery]);

  const rollStats = useMemo(() => computeRollStats(rolls), [rolls]);

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
    requestJSON('/api/v2/rolls')
      .then((r) => setRolls(r || []))
      .catch((e) => setError(e.message || '读取母卷列表失败'));
  }, []);

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
    requestJSON('/api/v2/rolls/' + encodeURIComponent(rollParam))
      .then((r) => {
        if (cancelled || !r) return;
        let draft: any = null;
        try {
          draft = JSON.parse(localStorage.getItem(draftKey(r.rollId)) || 'null');
        } catch {}
        const initPending = draft?.pending || [];
        const initPos = draft?.pos ?? Math.min(r.usedLength || 0, r.totalLength || 0);
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
      persistDraft(stateRef.current.roll, stateRef.current.pending, stateRef.current.pos);
    }
  };

  const handleCanvasCursor = (pt: { x: number; y: number } | null) => {
    const curRoll = stateRef.current.roll;
    if (!curRoll) return;
    setPointerText(pt ? `距右 ${round(curRoll.width - pt.x)} · 距卷头 ${round(pt.y)} mm` : '距右 / 距卷头 · mm');
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
      const d = validateDefect({ x: box.v, y: box.u, w: box.dv, h: box.du, margin: st.margin }, st.roll);
      const nextHistory = [...st.history.slice(-49), structuredClone(st.pending)];
      const newItem = { ...d, ...defectAttrs(st.defaultType), captureId: createUuid() };
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

  const handleCanvasDefectEdit = (key: string, box: { u: number; v: number; du: number; dv: number }) => {
    const st = stateRef.current;
    if (st.saving || !st.roll) return;
    const k = st.pending.findIndex((d: any) => d.captureId === key);
    if (k < 0) return;
    try {
      const next = validateDefect({ ...st.pending[k], x: box.v, y: box.u, w: box.dv, h: box.du }, st.roll);
      if (JSON.stringify(next) !== JSON.stringify(st.pending[k])) {
        const nextHistory = [...st.history.slice(-49), structuredClone(st.pending)];
        const nextPending = st.pending.map((it: any, idx: number) => (idx === k ? next : it));
        setHistory(nextHistory);
        setPending(nextPending);
        persistDraft(st.roll, nextPending, st.pos);
      }
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  useEffect(() => {
    if (!running || !roll) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const st = stateRef.current;
      if (!st.roll) return;
      try {
        const nextPos = advance(st.pos, st.speed, (now - last) / 1000, st.roll.totalLength);
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

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && stateRef.current.running) {
        setRunning(false);
        persistDraft(stateRef.current.roll, stateRef.current.pending, stateRef.current.pos);
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
          ...(saved.defects || []).filter((d: any) => captures.has(d.captureId) && !known.has(d.id))
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
        target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable);
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel != null) {
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
      const saved = await requestJSON('/api/v2/rolls/' + encodeURIComponent(rollId) + '/inspection-defects', {
        width: roll.width,
        totalLength: roll.totalLength,
        defects: submitted
      });
      let latest: any = null;
      try {
        latest = JSON.parse(localStorage.getItem(draftKey(rollId)) || 'null');
      } catch {}
      if (latest) {
        localStorage.setItem(
          draftKey(rollId),
          JSON.stringify({ ...latest, pending: withoutSubmitted(latest.pending, submitted) })
        );
      }
      window.dispatchEvent(new CustomEvent(SAVED_EVENT, { detail: { saved, submitted } }));
      const refreshed = await requestJSON('/api/v2/rolls');
      setRolls(refreshed || []);
      toast('本次疵点已保存到母卷');
    } catch (e: any) {
      toast('保存失败，记录仍保留在本机：' + e.message, true);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmitInspectionDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roll || !inspectModalAction || inspectSubmitting) return;
    setRunning(false);
    const rollId = roll.rollId;
    setInspectSubmitting(true);
    try {
      if (pending.length > 0) {
        const submitted = structuredClone(pending);
        const saved = await requestJSON('/api/v2/rolls/' + encodeURIComponent(rollId) + '/inspection-defects', {
          width: roll.width,
          totalLength: roll.totalLength,
          defects: submitted
        });
        let latest: any = null;
        try {
          latest = JSON.parse(localStorage.getItem(draftKey(rollId)) || 'null');
        } catch {}
        if (latest) {
          localStorage.setItem(
            draftKey(rollId),
            JSON.stringify({ ...latest, pending: withoutSubmitted(latest.pending, submitted) })
          );
        }
        window.dispatchEvent(new CustomEvent(SAVED_EVENT, { detail: { saved, submitted } }));
      }
      const updated = await requestJSON(`/api/v2/quality/rolls/${encodeURIComponent(rollId)}/inspect-complete`, {
        status: inspectModalAction,
        inspector: inspectorName.trim() || '质检员',
        remarks: inspectRemarks.trim() || undefined
      });
      const refreshed = await requestJSON('/api/v2/rolls');
      const list = Array.isArray(refreshed) ? refreshed : [];
      setRolls(list);
      const latestRoll = list.find((x: any) => x.rollId === rollId) || updated;
      if (latestRoll) setRoll(latestRoll);
      setInspectModalAction(null);
      setInspectRemarks('');
      toast(
        inspectModalAction === 'PASSED'
          ? `母卷 ${rollId} 已质检合格放行 (PASSED)，现可领料并进入搭切排料`
          : `母卷 ${rollId} 已判定不合格 (FAILED)，将拦截领料与排料`
      );
    } catch (err: any) {
      toast('提交质检判定失败：' + (err.message || '未知错误'), true);
    } finally {
      setInspectSubmitting(false);
    }
  };

  const handleApplyManualDefect = () => {
    if (saving || !roll) return;
    try {
      const wNum = Number(fW);
      const rightNum = Number(fRight);
      const d = validateDefect(
        { x: round(roll.width - rightNum - wNum), y: Number(fY), w: wNum, h: Number(fH), margin: Number(fMargin) },
        roll
      );
      const item = { ...d, ...defectAttrs(fType) };
      const nextHistory = [...history.slice(-49), structuredClone(pending)];
      const savedCount = (roll.defects || []).length;
      let nextPending: any[];
      let nextSel: number;
      if (sel != null && sel >= savedCount) {
        const k = sel - savedCount;
        nextPending = pending.map((it, idx) => (idx === k ? { ...it, ...item } : it));
        nextSel = sel;
      } else {
        nextPending = [...pending, { ...item, captureId: createUuid() }];
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
        `/api/v2/rolls/${encodeURIComponent(roll.rollId)}/defects/${encodeURIComponent(d.id)}/void`,
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

  const handleBatchDefectSuccess = async (affectedRollIds: string[]) => {
    const refreshed = await requestJSON('/api/v2/rolls').catch(() => null);
    if (Array.isArray(refreshed)) {
      setRolls(refreshed);
    }
    if (roll?.rollId && (!affectedRollIds.length || affectedRollIds.includes(roll.rollId))) {
      const latest = await requestJSON('/api/v2/rolls/' + encodeURIComponent(roll.rollId)).catch(() => null);
      if (latest) setRoll(latest);
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
    selectedDefect && selectedDefect.saved && selectedDefect.y + selectedDefect.h <= (roll?.usedLength || 0)
  );
  const [rollStatusText, rollStatusCls] = roll
    ? ROLL_STATUS_LABEL[roll.inspectionStatus] || [roll.inspectionStatus || '待检', 'warn']
    : ['', ''];

  return (
    <div className="react-page mp-insp-page">
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
            location.hash = e.target.value ? '#/inspection/' + encodeURIComponent(e.target.value) : '#/inspection';
          }}
        >
          <option value="">选择母卷开始验布</option>
          {filteredRolls.map((x) => (
            <option key={x.rollId} value={x.rollId}>
              {x.rollId} · {x.rollModel || ''} · {fmtN(x.width)} mm × {fmtM(x.totalLength)} m
            </option>
          ))}
        </select>

        {roll && <span className={`tag ${rollStatusCls}`}>{rollStatusText}</span>}

        {roll && (roll.usedLength || 0) > 0 && (
          <CodeBadge title="已切割区段历史疵点不可作废，验布默认从已切终点起跳">
            已切 0~{fmtM(roll.usedLength)}m · 余长 {fmtM(Math.max(0, roll.totalLength - roll.usedLength))}m
          </CodeBadge>
        )}

        <div className="mp-toolbar-actions">
          <button
            type="button"
            className="mp-ghost-btn"
            data-testid="insp-open-batch-defects-btn"
            onClick={() => setBatchDefectModalOpen(true)}
          >
            批量导入瑕疵
          </button>
          {roll && (
            <a
              className="mp-ghost-btn"
              href={`#/inventory?roll=${encodeURIComponent(roll.rollId)}`}
              title="跳转到母卷台账查看已切割区域与排程预占空间图"
            >
              看已切割区域
            </a>
          )}
          <a className="mp-ghost-btn" href="#/inventory/receive" title="登记母卷后返回跑布验疵">
            新建母卷
          </a>
          <button
            type="button"
            className={`btn ${roll && roll.inspectionStatus === 'PASSED' ? 'pri' : ''}`}
            id="save"
            disabled={!pending.length || saving || inspectSubmitting}
            onClick={handleSaveToRoll}
          >
            保存到母卷{pending.length ? ` (${pending.length})` : ''}
          </button>
          {roll && roll.inspectionStatus !== 'SCRAPPED' && roll.inspectionStatus !== 'PASSED' && (
            <>
              <button
                type="button"
                className="btn pri"
                id="inspect-pass-btn"
                disabled={saving || inspectSubmitting}
                onClick={() => {
                  setInspectorName((prev) => prev || roll.inspector || '');
                  setInspectModalAction('PASSED');
                }}
              >
                ✓ 质检合格放行
              </button>
              <button
                type="button"
                className="btn"
                id="inspect-fail-btn"
                style={{ color: 'var(--err, #dc2626)' }}
                disabled={saving || inspectSubmitting}
                onClick={() => {
                  setInspectorName((prev) => prev || roll.inspector || '');
                  setInspectModalAction('FAILED');
                }}
              >
                判不合格
              </button>
            </>
          )}
          {roll && roll.inspectionStatus === 'PASSED' && (
            <>
              <a className="btn soft-accent" href="#/workbench" title="母卷已质检放行，可直接前往搭切工作台锁卷排料">
                去搭切排料 →
              </a>
              <button
                type="button"
                className="btn"
                id="inspect-fail-btn"
                style={{ color: 'var(--err, #dc2626)' }}
                disabled={saving || inspectSubmitting}
                onClick={() => {
                  setInspectorName((prev) => prev || roll.inspector || '');
                  setInspectModalAction('FAILED');
                }}
              >
                复判不合格
              </button>
            </>
          )}
        </div>
      </div>

      {!roll ? (
        <InspectionRollBoard
          rollFilter={rollFilter}
          onSetRollFilter={setRollFilter}
          rollStats={rollStats}
          rollQuery={rollQuery}
          onSetRollQuery={setRollQuery}
          boardRolls={boardRolls}
          totalRollsCount={rolls.length}
        />
      ) : (
        <InspectionCanvasWorkspace
          roll={roll}
          pending={pending}
          allDefects={allDefects}
          historyLength={history.length}
          pos={pos}
          posInputText={posInputText}
          onSetPosInputText={setPosInputText}
          onUpdatePos={(nextPos) => {
            setPos(nextPos);
            persistDraft(roll, pending, nextPos);
          }}
          step={step}
          onSetStep={setStep}
          speed={speed}
          onSetSpeed={setSpeed}
          running={running}
          onToggleRunning={() => {
            if (running) {
              setRunning(false);
              persistDraft(roll, pending, pos);
            } else {
              setOverview(false);
              setRunning(true);
              canvasRef.current?.followPosition(pos);
            }
          }}
          tool={tool}
          onSetTool={setTool}
          overview={overview}
          onSetFollowMode={() => {
            setOverview(false);
            setTimeout(() => canvasRef.current?.followPosition(stateRef.current.pos), 0);
          }}
          onSetOverviewMode={() => {
            setRunning(false);
            setOverview(true);
            setTimeout(() => canvasRef.current?.fit(), 0);
          }}
          panelCollapsed={panelCollapsed}
          onTogglePanelCollapsed={() => setPanelCollapsed((c) => !c)}
          saving={saving}
          pointerText={pointerText}
          sel={sel}
          onSelectIndex={setSel}
          selectedDefect={selectedDefect}
          editable={editable}
          inCutArea={inCutArea}
          voidReason={voidReason}
          onSetVoidReason={setVoidReason}
          onVoidDefect={handleVoidDefect}
          fRight={fRight}
          setFRight={setFRight}
          fY={fY}
          setFY={setFY}
          fW={fW}
          setFW={setFW}
          fH={fH}
          setFH={setFH}
          fType={fType}
          setFType={setFType}
          fMargin={fMargin}
          setFMargin={setFMargin}
          onUndo={handleUndo}
          onRemoveSelected={handleRemoveSelected}
          onApplyManualDefect={handleApplyManualDefect}
          onJumpToDefectRow={(d, i) => {
            setRunning(false);
            setSel(i);
            const nextPos = Math.min(roll.totalLength, d.y + 300);
            setPos(nextPos);
            setOverview(false);
            persistDraft(roll, pending, nextPos);
            setTimeout(() => canvasRef.current?.followPosition(nextPos), 0);
          }}
          canvasRef={canvasRef}
          inspectionDefects={inspectionDefects}
          inspectionZones={inspectionZones}
          emptyDemands={emptyDemands}
          emptyPlaced={emptyPlaced}
          selectedDefectKey={selectedDefectKey}
          onCanvasInteract={handleCanvasInteract}
          onCanvasCursor={handleCanvasCursor}
          onCanvasDefectSelect={handleCanvasDefectSelect}
          onCanvasDefectDraw={handleCanvasDefectDraw}
          onCanvasDefectEdit={handleCanvasDefectEdit}
        />
      )}

      <InspectionDecisionModal
        open={Boolean(inspectModalAction && roll)}
        action={inspectModalAction}
        roll={roll}
        pendingCount={pending.length}
        inspectorName={inspectorName}
        onSetInspectorName={setInspectorName}
        inspectRemarks={inspectRemarks}
        onSetInspectRemarks={setInspectRemarks}
        submitting={inspectSubmitting}
        onClose={() => {
          if (!inspectSubmitting) setInspectModalAction(null);
        }}
        onSubmit={handleSubmitInspectionDecision}
      />

      <InspectionBatchDefectModal
        open={batchDefectModalOpen}
        defaultRollId={roll?.rollId}
        auth={auth}
        onClose={() => setBatchDefectModalOpen(false)}
        onSuccessRefresh={handleBatchDefectSuccess}
      />
    </div>
  );
};
