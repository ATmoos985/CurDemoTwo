import React, { useEffect, useMemo, useRef, useState } from 'react';
import { requestJSON, fmtM, fmtN, toast } from '@static/app/js/util.js';
import {
  validateDefect,
  advance,
  round
} from '@static/js/inspection/inspection-model.js';
import { createRollCanvas } from '@static/js/canvas/roll-canvas.js';
import { buildInspectionScene } from '@static/app/js/model/roll-scene.js';

const DEFECT_TYPES: [string, string][] = [
  ['STAIN', '污渍 / 斑点'],
  ['HOLE', '破洞'],
  ['WEFT_DEFECT', '跳纱'],
  ['SLUB', '粗节'],
  ['SHADING', '色差'],
  ['MANUAL_MARK', '其他疵点']
];

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

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<any>(null);
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

  // Mount / destroy Konva inspection canvas when roll becomes active
  useEffect(() => {
    if (!roll || !canvasHostRef.current) {
      canvasRef.current?.destroy();
      canvasRef.current = null;
      return;
    }
    const c = createRollCanvas(canvasHostRef.current, {
      onInteract: () => {
        if (stateRef.current.running) {
          setRunning(false);
          persistDraft(
            stateRef.current.roll,
            stateRef.current.pending,
            stateRef.current.pos
          );
        }
      },
      onCursor: (p: any) => {
        const curRoll = stateRef.current.roll;
        if (!curRoll) return;
        setPointerText(
          p
            ? `距右 ${round(curRoll.width - p.v)} · 距卷头 ${round(p.u)} mm`
            : '距右 / 距卷头 · mm'
        );
      },
      onDefectSelect: (key: string) => {
        const st = stateRef.current;
        if (!st.roll) return;
        const list = [
          ...(st.roll.defects || []).map((d: any) => ({ ...d, saved: true })),
          ...st.pending.map((d: any) => ({ ...d, saved: false }))
        ];
        const i = list.findIndex((d) => defectKey(d) === key);
        setSel(i < 0 ? null : i);
      },
      onDefectDraw: (box: any) => {
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
            captureId: crypto.randomUUID()
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
      },
      onDefectEdit: (key: string, box: any) => {
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
          // Re-render current scene on invalid drag
          const list = [
            ...(st.roll.defects || []).map((d: any) => ({ ...d, saved: true })),
            ...st.pending.map((d: any) => ({ ...d, saved: false }))
          ];
          const curD = st.sel != null ? list[st.sel] : null;
          c.setScene(
            buildInspectionScene(
              st.roll,
              st.pending,
              st.pos,
              curD ? defectKey(curD) : null
            ),
            { follow: !st.overview }
          );
        }
      }
    });
    canvasRef.current = c;
    return () => {
      c.destroy();
      canvasRef.current = null;
    };
  }, [roll?.rollId]);

  // Update canvas options & scene whenever inspection state changes
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !roll) return;
    const curD = sel != null ? allDefects[sel] : null;
    c.setOptions({
      view: overview ? 'full' : 'inspection',
      tool: tool === 'mark' ? 'defect' : tool,
      editDefects: true,
      editable: !saving,
      minDefectSize: 0.1
    });
    c.setScene(
      buildInspectionScene(
        roll,
        pending,
        pos,
        curD ? defectKey(curD) : null
      ),
      { follow: !overview }
    );
  }, [roll, pending, pos, sel, overview, tool, saving, allDefects]);

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
      canvasRef.current?.setVisible(!document.hidden);
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
          { ...item, captureId: crypto.randomUUID() }
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
        <div className="error-box" role="alert">
          <b>读取失败</b>
          <p>{error}</p>
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

  return (
    <div className="react-page">
      <div className="ph inspection-head">
        <h1>跑布验疵</h1>
        <select
          className="field"
          id="roll"
          style={{ width: 300 }}
          value={roll?.rollId || ''}
          onChange={(e) => {
            location.hash = e.target.value
              ? '#/inspection/' + encodeURIComponent(e.target.value)
              : '#/inspection';
          }}
        >
          <option value="">选择母卷开始验布</option>
          {rolls.map((x) => (
            <option key={x.rollId} value={x.rollId}>
              {x.rollId} · {x.rollModel || ''} · {fmtN(x.width)} mm ×{' '}
              {fmtM(x.totalLength)} m
            </option>
          ))}
        </select>
        {roll && (
          <span
            className={`tag ${
              roll.inspectionStatus === 'PASSED' ? 'ok' : 'warn'
            }`}
          >
            {roll.inspectionStatus || '待检'}
          </span>
        )}
        {roll && (roll.usedLength || 0) > 0 && (
          <span className="tag run num" title="已切割区段历史疵点不可作废，验布默认从已切终点起跳">
            已切 0 ~ {fmtM(roll.usedLength)}m · 余长 {fmtM(Math.max(0, roll.totalLength - roll.usedLength))}m
          </span>
        )}
        {roll && (
          <a
            className="btn sm"
            href={`#/inventory?roll=${encodeURIComponent(roll.rollId)}`}
            title="跳转到母卷台账查看已切割区域与排程预占空间图"
          >
            看已切割区域
          </a>
        )}
        <a
          className="btn"
          href="#/inventory/receive"
          title="登记母卷后返回跑布验疵"
        >
          新建母卷
        </a>
        <span className="sp" />
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

      {!roll ? (
        <div className="empty">
          选择母卷后开始标记。整卷连续跑布，所有疵点按距卷头的累计位置记录。
        </div>
      ) : (
        <>
          <div className="toolbar">
            <span className="muted">当前位置</span>
            <input
              className="field num"
              id="pos"
              style={{ width: 100, textAlign: 'right' }}
              value={posInputText}
              onChange={(e) => setPosInputText(e.target.value)}
            />
            <span>m</span>
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
            <span className="vsep" />
            <span className="muted">每次前进</span>
            <input
              type="number"
              className="field num"
              id="step"
              style={{ width: 60, textAlign: 'right' }}
              value={step}
              onChange={(e) => setStep(Math.max(0.1, Number(e.target.value) || 1))}
            />
            <span>m</span>
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
              前进一段 ↓
            </button>
            <span className="vsep" />
            <span className="muted">速度</span>
            <input
              type="number"
              className="field num"
              id="speed"
              style={{ width: 56, textAlign: 'right' }}
              value={speed}
              onChange={(e) => setSpeed(Math.max(0.1, Number(e.target.value) || 3))}
            />
            <span>m/min</span>
            <button
              type="button"
              className={`btn sm ${running ? 'pri' : ''}`}
              id="run"
              onClick={() => {
                if (running) {
                  setRunning(false);
                  persistDraft(roll, pending, pos);
                } else {
                  setOverview(false);
                  setRunning(true);
                  canvasRef.current?.fit();
                }
              }}
            >
              {running ? '暂停跑布' : '自动跑布'}
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              空格 启停
            </span>
            <span className="sp" />
            <span className="muted" style={{ fontSize: 12 }}>
              {running
                ? '自动跑布：位置按速度与时间计算，可随时暂停校准'
                : '手动模式'}
            </span>
          </div>

          <div
            className="split"
            style={{
              gridTemplateColumns: `56px minmax(0,1fr) ${
                panelCollapsed ? '0px' : '370px'
              }`
            }}
          >
            <section
              className="pane"
              style={{
                background: '#23272c',
                alignItems: 'center',
                padding: '8px 0'
              }}
              title="全卷：点击跳转"
            >
              <div style={{ color: '#9aa4ae', fontSize: 10.5, marginBottom: 4 }}>
                全卷
              </div>
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
                style={{ color: '#9aa4ae', fontSize: 10, marginTop: 4 }}
              >
                {fmtM(roll.totalLength)} m
              </div>
            </section>

            <section className="pane" style={{ background: 'var(--canvas)' }}>
              <div className="ctool">
                <div className="vseg">
                  <button
                    type="button"
                    className={tool === 'mark' ? 'on' : ''}
                    onClick={() => setTool('mark')}
                  >
                    ＋ 标记疵点
                  </button>
                  <button
                    type="button"
                    className={tool === 'select' ? 'on' : ''}
                    onClick={() => setTool('select')}
                  >
                    选择 / 调整
                  </button>
                </div>
                <button
                  type="button"
                  className={tool === 'measure' ? 'on' : ''}
                  onClick={() => setTool('measure')}
                >
                  测距
                </button>
                <button
                  type="button"
                  id="follow"
                  onClick={() => {
                    setOverview(false);
                    setTimeout(() => canvasRef.current?.fit(), 0);
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
                  title="收起或展开疵点记录"
                  onClick={() => setPanelCollapsed((c) => !c)}
                >
                  记录
                </button>
                <div className="div" />
                <span className="sp" />
                <span id="pointer-position">{pointerText}</span>
              </div>
              <div className="canvas-wrap">
                <div
                  ref={canvasHostRef}
                  id="isvg"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    cursor: tool === 'mark' ? 'crosshair' : 'default'
                  }}
                />
              </div>
            </section>

            <section
              className="pane"
              style={panelCollapsed ? { display: 'none' } : undefined}
            >
              <div className="pane-h">
                疵点记录
                <span className="sp" />
                <span className="sub">
                  已入档 {allDefects.length - pending.length} · 本次待保存{' '}
                  {pending.length}
                </span>
              </div>
              <div className="pane-b">
                <div id="editor">
                  <div className="sec">
                    {selectedDefect
                      ? editable
                        ? '本次标记 · 可修改 / 删除（Delete）'
                        : '已入档疵点'
                      : '精确录入'}
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
                        <div
                          style={{
                            padding: '8px 12px',
                            display: 'flex',
                            gap: 6,
                            alignItems: 'center'
                          }}
                        >
                          <input
                            className="field"
                            id="void-reason"
                            placeholder="作废原因（必填，如：复核为误检）"
                            style={{ flex: 1 }}
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
                        <div
                          className="muted"
                          style={{ padding: '0 12px 8px', fontSize: 11.5 }}
                        >
                          作废后不再避让，原记录与原因留痕；该卷上未报工的候选方案需重新计算。
                        </div>
                      </>
                    )
                  )}

                  <div
                    className="form"
                    style={{ gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}
                  >
                    <label>
                      距右边缘 mm
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%' }}
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fRight}
                        onChange={(e) => setFRight(e.target.value)}
                      />
                    </label>
                    <label>
                      距卷头 mm
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%' }}
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fY}
                        onChange={(e) => setFY(e.target.value)}
                      />
                    </label>
                    <label>
                      疵点宽 mm
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%' }}
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fW}
                        onChange={(e) => setFW(e.target.value)}
                      />
                    </label>
                    <label>
                      疵点长 mm
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%' }}
                        disabled={Boolean(saving || (selectedDefect && !editable))}
                        value={fH}
                        onChange={(e) => setFH(e.target.value)}
                      />
                    </label>
                    <label>
                      类型
                      <select
                        className="field"
                        style={{ width: '100%' }}
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
                        className="field num"
                        style={{ width: '100%' }}
                        disabled={Boolean(selectedDefect && !editable)}
                        value={fMargin}
                        onChange={(e) => setFMargin(e.target.value)}
                      />
                    </label>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: '0 12px 10px',
                      justifyContent: 'flex-end'
                    }}
                  >
                    {selectedDefect && (
                      <button
                        type="button"
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
                          className="btn sm pri"
                          onClick={handleApplyManualDefect}
                        >
                          更新
                        </button>
                      </>
                    ) : !selectedDefect ? (
                      <button
                        type="button"
                        className="btn sm pri"
                        onClick={handleApplyManualDefect}
                      >
                        添加到本次记录
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="sec">全部疵点 · 点击定位</div>
                <table className="t" style={{ border: 0 }}>
                  <thead>
                    <tr>
                      <th>Y m</th>
                      <th className="r">距右</th>
                      <th className="r">宽×长</th>
                      <th>类型</th>
                      <th />
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
                          setTimeout(() => canvasRef.current?.fit(), 0);
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
                        <td>
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

                {(roll.voidedDefects || []).length > 0 && (
                  <>
                    <div className="sec">
                      已作废 {roll.voidedDefects.length} 处 · 留痕
                    </div>
                    <table className="t" style={{ border: 0 }}>
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
                  </>
                )}
              </div>
              <div
                className="foot"
                style={{
                  background: '#fff',
                  fontSize: 11.5,
                  color: 'var(--text-3)'
                }}
              >
                本次记录保存在本机；入档后用于裁切避让，已有方案需重新核对
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
};
