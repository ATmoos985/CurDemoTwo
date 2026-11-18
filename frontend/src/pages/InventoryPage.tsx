import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestJSON,
  fmtM,
  fmtN,
  toast,
  idempotentPost,
  pendingWrite,
  retryWrite,
  dropWrite
} from '@static/app/js/util.js';
import { buildRollScene, remnantAsRoll } from '@static/app/js/model/roll-scene.js';
import { workflowTemplate } from '@static/app/js/model/showcase.js';
import { CadCanvasView } from '../components/CadCanvasView';
import { ModalDialog } from '../components/ModalDialog';
import { useStudioStore } from '../store/useStudioStore';

const ROLL_QUALITY_MAP: Record<string, [string, string]> = {
  PASSED: ['合格', 'ok'],
  PENDING: ['待检', 'warn'],
  FAILED: ['不合格', 'err'],
  QUARANTINED: ['隔离', 'err']
};

const REMNANT_STATUS_MAP: Record<string, [string, string]> = {
  AVAILABLE: ['可用', 'ok'],
  RESERVED: ['已预约', 'run'],
  CONSUMED: ['已消耗', ''],
  SCRAPPED: ['已报废', ''],
  LOST: ['盘亏', 'err'],
  QUARANTINED: ['隔离', 'err']
};

const ACTION_TITLES: Record<string, string> = {
  receive: '母卷入库登记',
  transfer: '材料批量移库',
  count: '实物库存盘点',
  scrap: '料头报废确认'
};

interface CountRowState {
  present: boolean;
  width: string | number;
  length: string | number;
}

interface ProductGroup {
  modelKey: string;
  materialName: string;
  composition: string;
  color: string;
  primaryWidthMm: number;
  rolls: any[];
  remnants: any[];
  passedRollCount: number;
  totalRemainingM: number;
  availableRemnants: any[];
  availableRemnantAreaM2: number;
}

type PreviewTarget =
  | { kind: 'roll'; id: string }
  | { kind: 'remnant'; id: string }
  | null;

type RollPreviewLayout = 'tile' | 'strip' | 'station';

function clampNum(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export const InventoryPage: React.FC<{ params?: string[] }> = ({ params = [] }) => {
  const [intent, templateId] = params;
  const setCanvasSpec = useStudioStore((s) => s.setCanvasSpec);

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Product -> Mother Roll -> Linked Remnant hierarchy state
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [focusedRollId, setFocusedRollId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [onlyWithRemnants, setOnlyWithRemnants] = useState<boolean>(false);
  const [remnantStatusFilter, setRemnantStatusFilter] = useState<'AVAILABLE_FIRST' | 'ALL'>(
    'AVAILABLE_FIRST'
  );

  // Right Preview Pane & Resizable Split Layout State
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean>(true);
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    clampNum(Number(localStorage.getItem('cutplan.inv.leftW')) || 268, 210, 400)
  );
  const [previewWidth, setPreviewWidth] = useState<number>(() =>
    clampNum(Number(localStorage.getItem('cutplan.inv.rightW')) || 420, 290, 740)
  );
  const [draggingSide, setDraggingSide] = useState<'left' | 'right' | null>(null);
  const [liveAnnounce, setLiveAnnounce] = useState<string>('');

  // Preview CAD Canvas options
  const [rollLayout, setRollLayout] = useState<RollPreviewLayout>('tile');
  const [vertical, setVertical] = useState<boolean>(true);
  const [tool, setTool] = useState<'pan' | 'measure'>('pan');
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);

  const layoutContainerRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<any>(null);
  const dragOriginRef = useRef<{ startX: number; startW: number }>({ startX: 0, startW: 0 });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<'receive' | 'transfer' | 'count' | 'scrap' | null>(null);
  const [opts, setOpts] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  // Action modal form fields
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [rollIdInput, setRollIdInput] = useState('');
  const [rollModelInput, setRollModelInput] = useState('');
  const [widthInput, setWidthInput] = useState<string | number>('');
  const [lengthInput, setLengthInput] = useState<string | number>('');
  const [scrapId, setScrapId] = useState('');
  const [countsMap, setCountsMap] = useState<Record<string, CountRowState>>({});

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, rem] = await Promise.all([
        requestJSON('/api/rolls'),
        requestJSON('/api/remnants')
      ]);
      setRolls(r || []);
      setRemnants(rem || []);
    } catch (e: any) {
      setError(e.message || '读取库存档案失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const announceResize = (msg: string) => {
    setLiveAnnounce(msg);
    window.setTimeout(() => {
      setLiveAnnounce((cur) => (cur === msg ? '' : cur));
    }, 1200);
  };

  const commitLeftWidth = (next: number) => {
    const containerW = layoutContainerRef.current?.clientWidth || 1200;
    const maxLeft = Math.max(220, Math.min(420, containerW - (previewOpen ? previewWidth : 0) - 340));
    const clamped = clampNum(Math.round(next), 200, maxLeft);
    setLeftWidth(clamped);
    try {
      localStorage.setItem('cutplan.inv.leftW', String(clamped));
    } catch {}
  };

  const commitPreviewWidth = (next: number) => {
    const containerW = layoutContainerRef.current?.clientWidth || 1200;
    const maxRight = Math.max(300, Math.min(760, containerW - leftWidth - 340));
    const clamped = clampNum(Math.round(next), 280, maxRight);
    setPreviewWidth(clamped);
    try {
      localStorage.setItem('cutplan.inv.rightW', String(clamped));
    } catch {}
  };

  const openActionPanel = async (
    kind: 'receive' | 'transfer' | 'count' | 'scrap',
    extra: any = {}
  ) => {
    setAction(kind);
    setReason('');
    setOpts(null);
    if (extra.rollId !== undefined) setRollIdInput(extra.rollId);
    if (extra.rollModel !== undefined) setRollModelInput(extra.rollModel);
    if (extra.width !== undefined) setWidthInput(extra.width);
    if (extra.length !== undefined) setLengthInput(extra.length);
    if (extra.scrapId !== undefined) setScrapId(extra.scrapId);

    if (kind === 'transfer' || kind === 'count') {
      try {
        const res = await requestJSON(
          `/api/v2/inventory-${kind === 'transfer' ? 'transfers' : 'counts'}/options`
        );
        setOpts(res);
      } catch (e: any) {
        toast(e.message, true);
      }
    }
  };

  useEffect(() => {
    if (intent === 'receive') {
      const tpl = templateId ? workflowTemplate(templateId) : null;
      openActionPanel(
        'receive',
        tpl
          ? {
              ...tpl.material,
              rollId: 'DEMO-' + crypto.randomUUID().slice(0, 8)
            }
          : {}
      );
    }
  }, [intent, templateId]);

  // Build Product -> Mother Rolls + Linked Remnants groups
  const productGroups = useMemo<ProductGroup[]>(() => {
    const rollById = new Map<string, any>();
    for (const r of rolls) {
      if (r?.rollId) rollById.set(r.rollId, r);
    }

    const map = new Map<string, { rolls: any[]; remnants: any[] }>();
    const ensure = (key: string) => {
      const k = key || '未分类品号';
      let g = map.get(k);
      if (!g) {
        g = { rolls: [], remnants: [] };
        map.set(k, g);
      }
      return g;
    };

    for (const r of rolls) {
      ensure(r.rollModel || r.materialName || '未分类品号').rolls.push(r);
    }

    for (const rem of remnants) {
      const parentRoll = rem.sourceRollId ? rollById.get(rem.sourceRollId) : null;
      const modelKey =
        parentRoll?.rollModel || rem.materialBatch || rem.sourceRollId || '未分类品号';
      ensure(modelKey).remnants.push(rem);
    }

    const groups: ProductGroup[] = [];
    for (const [modelKey, { rolls: gRolls, remnants: gRems }] of map.entries()) {
      const sampleRoll = gRolls[0];
      const passedRollCount = gRolls.filter((r) => r.inspectionStatus === 'PASSED').length;
      const totalRemainingMm = gRolls.reduce(
        (sum, r) =>
          sum + Math.max(0, r.currentRemainingLength ?? r.totalLength - (r.usedLength || 0)),
        0
      );
      const availableRemnants = gRems.filter((rm) => rm.status === 'AVAILABLE');
      const availableRemnantAreaM2 = availableRemnants.reduce(
        (sum, rm) =>
          sum + (Number(rm.area) || (Number(rm.width) * Number(rm.length)) / 1e6 || 0),
        0
      );

      groups.push({
        modelKey,
        materialName: sampleRoll?.materialName || '',
        composition: sampleRoll?.composition || '',
        color: sampleRoll?.color || '',
        primaryWidthMm: sampleRoll?.width || gRems[0]?.width || 0,
        rolls: gRolls,
        remnants: gRems,
        passedRollCount,
        totalRemainingM: totalRemainingMm / 1000,
        availableRemnants,
        availableRemnantAreaM2
      });
    }

    return groups.sort((a, b) => {
      const scoreA = (a.rolls.length > 0 ? 100 : 0) + Math.min(50, a.availableRemnants.length * 5);
      const scoreB = (b.rolls.length > 0 ? 100 : 0) + Math.min(50, b.availableRemnants.length * 5);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.modelKey.localeCompare(b.modelKey, 'zh-CN');
    });
  }, [rolls, remnants]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return productGroups.filter((g) => {
      if (onlyWithRemnants && g.availableRemnants.length === 0) return false;
      if (!q) return true;
      if (
        `${g.modelKey} ${g.materialName} ${g.color} ${g.composition}`.toLowerCase().includes(q)
      ) {
        return true;
      }
      if (
        g.rolls.some((r) =>
          `${r.rollId} ${r.batchNo || ''} ${r.storageLocation || ''}`.toLowerCase().includes(q)
        )
      ) {
        return true;
      }
      return g.remnants.some((rm) =>
        `${rm.id} ${rm.sourceRollId || ''} ${rm.location || ''}`.toLowerCase().includes(q)
      );
    });
  }, [productGroups, searchQuery, onlyWithRemnants]);

  useEffect(() => {
    if (!filteredProducts.length) return;
    if (!selectedModel || !filteredProducts.some((g) => g.modelKey === selectedModel)) {
      setSelectedModel(filteredProducts[0].modelKey);
      setFocusedRollId('');
    }
  }, [filteredProducts, selectedModel]);

  const activeProduct = useMemo(
    () =>
      filteredProducts.find((g) => g.modelKey === selectedModel) ||
      productGroups.find((g) => g.modelKey === selectedModel) ||
      null,
    [filteredProducts, productGroups, selectedModel]
  );

  // Sync previewTarget when activeProduct changes so something meaningful is always previewed
  useEffect(() => {
    if (!activeProduct) {
      setPreviewTarget(null);
      return;
    }
    const validCurrent =
      (previewTarget?.kind === 'roll' &&
        activeProduct.rolls.some((r) => r.rollId === previewTarget.id)) ||
      (previewTarget?.kind === 'remnant' &&
        activeProduct.remnants.some((rm) => rm.id === previewTarget.id));

    if (!validCurrent) {
      if (activeProduct.rolls.length > 0) {
        const firstRoll = activeProduct.rolls[0];
        setPreviewTarget({ kind: 'roll', id: firstRoll.rollId });
        setRollLayout(firstRoll.totalLength > 15000 ? 'tile' : 'strip');
      } else if (activeProduct.remnants.length > 0) {
        setPreviewTarget({ kind: 'remnant', id: activeProduct.remnants[0].id });
      } else {
        setPreviewTarget(null);
      }
    }
  }, [activeProduct]);

  const remnantsByRollId = useMemo(() => {
    const map = new Map<string, any[]>();
    if (!activeProduct) return map;
    for (const rm of activeProduct.remnants) {
      const key = rm.sourceRollId || '__UNLINKED__';
      const arr = map.get(key) || [];
      arr.push(rm);
      map.set(key, arr);
    }
    return map;
  }, [activeProduct]);

  const displayedRemnants = useMemo(() => {
    if (!activeProduct) return [];
    let list = focusedRollId
      ? activeProduct.remnants.filter((rm) => rm.sourceRollId === focusedRollId)
      : activeProduct.remnants;
    if (remnantStatusFilter === 'AVAILABLE_FIRST') {
      list = list.filter(
        (rm) =>
          rm.status === 'AVAILABLE' || rm.status === 'RESERVED' || rm.status === 'QUARANTINED'
      );
    }
    return list;
  }, [activeProduct, focusedRollId, remnantStatusFilter]);

  const previewRoll = useMemo(
    () =>
      previewTarget?.kind === 'roll'
        ? rolls.find((r) => r.rollId === previewTarget.id) || null
        : null,
    [previewTarget, rolls]
  );

  const previewRemnant = useMemo(
    () =>
      previewTarget?.kind === 'remnant'
        ? remnants.find((rm) => rm.id === previewTarget.id) || null
        : null,
    [previewTarget, remnants]
  );

  const previewScene = useMemo(() => {
    if (previewRoll) {
      return buildRollScene({
        roll: previewRoll,
        plans: [],
        reports: [],
        rollId: previewRoll.rollId,
        demands: [],
        process: { bedLength: Math.min(3000, previewRoll.totalLength || 3000) }
      });
    }
    if (previewRemnant) {
      const asRoll = remnantAsRoll(previewRemnant);
      return buildRollScene({
        roll: asRoll,
        plans: [],
        reports: [],
        rollId: previewRemnant.id,
        demands: [],
        process: { bedLength: previewRemnant.length || 1000 }
      });
    }
    return null;
  }, [previewRoll, previewRemnant]);

  const handleInspectRoll = (r: any) => {
    setPreviewTarget({ kind: 'roll', id: r.rollId });
    setRollLayout(r.totalLength > 15000 ? 'tile' : 'strip');
    setCursor(null);
    if (!previewOpen) setPreviewOpen(true);
  };

  const handleInspectRemnant = (rm: any) => {
    setPreviewTarget({ kind: 'remnant', id: rm.id });
    setCursor(null);
    if (!previewOpen) setPreviewOpen(true);
  };

  const handleZoomToDefect = (d: any, materialWidth: number) => {
    if (!previewCanvasRef.current) return;
    if (previewRoll && rollLayout === 'tile') {
      setRollLayout('strip');
      window.setTimeout(() => {
        previewCanvasRef.current?.fitBounds({
          u0: Math.max(0, d.y - 600),
          u1: d.y + (d.h || 200) + 600,
          v0: 0,
          v1: materialWidth
        });
      }, 40);
      return;
    }
    previewCanvasRef.current.fitBounds({
      u0: Math.max(0, d.y - 500),
      u1: d.y + (d.h || 200) + 500,
      v0: 0,
      v1: materialWidth
    });
  };

  const idOf = (rollMode: boolean, item: any) =>
    `${rollMode ? 'roll' : 'remnant'}:${rollMode ? item.rollId : item.id}`;

  const togglePick = (key: string, checked: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const pendings = useMemo(() => {
    void pendingTick;
    return (['transfer', 'count'] as const)
      .map((s) => [s, pendingWrite(s)] as const)
      .filter(([, v]) => Boolean(v));
  }, [pendingTick, busy]);

  const selectedMaterials = useMemo(() => {
    return [...picked].map((s) => {
      const [type, id] = s.split(':');
      const m = opts?.materials?.find((x: any) => x.type === type && x.id === id);
      return { type, id, m };
    });
  }, [picked, opts]);

  const blockedMaterials = useMemo(
    () => selectedMaterials.filter((x) => !x.m?.allowed),
    [selectedMaterials]
  );

  const getCountRow = (key: string): CountRowState => {
    if (countsMap[key]) return countsMap[key];
    const [type, mid] = key.split(':');
    const m = opts?.materials?.find((x: any) => x.type === type && x.id === mid);
    return {
      present: true,
      width: m?.width ?? '',
      length: m?.length ?? ''
    };
  };

  const updateCountRow = (key: string, patch: Partial<CountRowState>) => {
    const cur = getCountRow(key);
    setCountsMap((prev) => ({
      ...prev,
      [key]: { ...cur, ...patch }
    }));
  };

  const handleSubmitAction = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    try {
      if (action === 'receive') {
        const body = {
          rollId: String(rollIdInput).trim(),
          rollModel: String(rollModelInput).trim(),
          width: Number(widthInput),
          totalLength: Math.round(Number(lengthInput) * 1000)
        };
        if (!body.rollId || !body.rollModel || !(body.width > 0) || !(body.totalLength > 0)) {
          throw new Error('请填写卷号、品号、幅宽与整卷长');
        }
        await requestJSON('/api/inspection/rolls', body);
        toast('母卷已登记，进入跑布验疵');
        setAction(null);
        location.hash = '#/inspection/' + encodeURIComponent(body.rollId);
        return;
      }

      if (action === 'scrap') {
        if (!reason.trim()) throw new Error('请填写报废原因');
        await requestJSON('/api/remnants/' + encodeURIComponent(scrapId) + '/scrap', {
          reason: reason.trim()
        });
        toast('料头已报废');
        setAction(null);
      } else {
        if (
          !reason.trim() ||
          !operator.trim() ||
          (action === 'transfer' && !destination.trim())
        ) {
          throw new Error(
            action === 'transfer' ? '请填写目标库位、原因与操作人' : '请填写原因与操作人'
          );
        }
        const materials = selectedMaterials.map(({ type, id }) => {
          if (action === 'transfer') return { type, id };
          const c = getCountRow(type + ':' + id);
          return {
            type,
            id,
            present: Boolean(c.present),
            width: c.present ? Number(c.width) : 0,
            length: c.present ? Number(c.length) : 0
          };
        });
        const body =
          action === 'transfer'
            ? {
                expectedRevision: opts.revision,
                destination: destination.trim(),
                reason: reason.trim(),
                operator: operator.trim(),
                materials
              }
            : {
                expectedRevision: opts.revision,
                reason: reason.trim(),
                operator: operator.trim(),
                materials
              };
        await idempotentPost(
          action,
          `/api/v2/inventory-${action === 'transfer' ? 'transfers' : 'counts'}`,
          body
        );
        toast(`${ACTION_TITLES[action]}已过账`);
        setPicked(new Set());
        setAction(null);
      }
      await loadData();
    } catch (err: any) {
      const msg = err.message || '提交失败';
      toast(
        (err.httpStatus || msg.startsWith('请') || msg.startsWith('上次')
          ? ''
          : '结果未确认，可重试：') + msg,
        true
      );
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleRetryWrite = async (slot: 'transfer' | 'count') => {
    try {
      await retryWrite(slot);
      toast('原操作已确认');
      await loadData();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setPendingTick((t) => t + 1);
    }
  };

  const handleDropWrite = (slot: 'transfer' | 'count') => {
    dropWrite(slot);
    toast('已放弃待确认操作，请到库存单据核对是否已过账');
    setPendingTick((t) => t + 1);
  };

  return (
    <div className="react-page">
      {/* Screen-reader live region for splitter resize feedback (Modern Web Guidance: drag) */}
      <div className="sr-only" aria-live="polite">
        {liveAnnounce}
      </div>

      <div className="ph">
        <h1>库存</h1>
        <span className="crumb">选品号查看在库母卷与派生料头 · 点击任意行在右侧预览实物几何与疵点</span>
        <span className="sp" />
        {!previewOpen && (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setPreviewOpen(true);
              announceResize('右侧实物预览窗格已展开');
            }}
          >
            展开右侧预览
          </button>
        )}
        {picked.size > 0 && (
          <button type="button" className="btn sm" onClick={() => setPicked(new Set())}>
            清空勾选 ({picked.size})
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={picked.size === 0}
          title={picked.size === 0 ? '先勾选母卷或料头' : undefined}
          onClick={() => openActionPanel('transfer')}
        >
          移库{picked.size ? ` (${picked.size})` : ''}
        </button>
        <button
          type="button"
          className="btn"
          disabled={picked.size === 0}
          title={picked.size === 0 ? '先勾选母卷或料头' : undefined}
          onClick={() => openActionPanel('count')}
        >
          盘点{picked.size ? ` (${picked.size})` : ''}
        </button>
        <button
          type="button"
          className="btn pri"
          onClick={() =>
            openActionPanel('receive', {
              rollId: '',
              rollModel: activeProduct?.modelKey || '',
              width: activeProduct?.primaryWidthMm || '',
              length: ''
            })
          }
        >
          ＋ 母卷入库
        </button>
      </div>

      {pendings.length > 0 && (
        <div className="notice" style={{ margin: '8px 16px 0' }}>
          {pendings.map(([s]) => (
            <span key={s} style={{ marginRight: 16 }}>
              {ACTION_TITLES[s]}提交结果未确认{' '}
              <button type="button" className="btn sm" onClick={() => handleRetryWrite(s)}>
                重试原操作
              </button>{' '}
              <button type="button" className="btn sm" onClick={() => handleDropWrite(s)}>
                放弃
              </button>
            </span>
          ))}
        </div>
      )}

      {error ? (
        <div className="body">
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        </div>
      ) : loading ? (
        <div className="body">
          <div className="loading">正在读取物料品号与母卷料头台账…</div>
        </div>
      ) : (
        <div
          ref={layoutContainerRef}
          className={`inv-resizable-workspace ${draggingSide ? 'is-resizing' : ''}`}
          style={{
            gridTemplateColumns: previewOpen
              ? `${leftWidth}px 6px minmax(340px, 1fr) 6px ${previewWidth}px`
              : `${leftWidth}px 6px minmax(340px, 1fr)`
          }}
        >
          {/* Column 1: Product Selector ("选择一个品") */}
          <section className="pane inv-product-pane">
            <div className="pane-h">
              <span>物料品号 ({filteredProducts.length})</span>
              <span className="sp" />
              <label className="inv-mini-filter">
                <input
                  type="checkbox"
                  checked={onlyWithRemnants}
                  onChange={(e) => setOnlyWithRemnants(e.target.checked)}
                />
                <span>含料头</span>
              </label>
            </div>

            <div className="inv-search-box">
              <input
                type="search"
                className="field"
                aria-label="搜索物料品号、母卷或料头"
                placeholder="搜品号 / 面料名 / 卷号 / 料头号…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="pane-b inv-product-list" role="listbox" aria-label="物料品号列表">
              {filteredProducts.length > 0 ? (
                filteredProducts.map((g) => {
                  const isActive = activeProduct?.modelKey === g.modelKey;
                  return (
                    <button
                      key={g.modelKey}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className="inv-product-card"
                      onClick={() => {
                        setSelectedModel(g.modelKey);
                        setFocusedRollId('');
                      }}
                    >
                      <div className="inv-product-top">
                        <strong>{g.modelKey}</strong>
                        {g.primaryWidthMm > 0 && (
                          <span className="num muted inv-width-tag">
                            {fmtN(g.primaryWidthMm)} mm
                          </span>
                        )}
                      </div>
                      {g.materialName && (
                        <div className="inv-product-name">{g.materialName}</div>
                      )}
                      <div className="inv-product-badges num">
                        <span className="tag kind">
                          母卷 {g.rolls.length} · {fmtN(g.totalRemainingM, 0)}m
                        </span>
                        {g.availableRemnants.length > 0 ? (
                          <span className="tag ok">料头 {g.availableRemnants.length} 块</span>
                        ) : g.remnants.length > 0 ? (
                          <span className="tag">历史料头 {g.remnants.length}</span>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }}>
                            无料头
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="empty">没有匹配的物料品号</div>
              )}
            </div>
          </section>

          {/* Resizer Handle 1: Left Product List <-> Center Tables */}
          <button
            type="button"
            className={`inv-split-handle ${draggingSide === 'left' ? 'dragging' : ''}`}
            aria-label="调节左侧物料目录宽度，使用左右方向键缩放"
            title="拖动调节物料目录宽度"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              dragOriginRef.current = { startX: e.clientX, startW: leftWidth };
              e.currentTarget.setPointerCapture(e.pointerId);
              setDraggingSide('left');
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              commitLeftWidth(
                dragOriginRef.current.startW + (e.clientX - dragOriginRef.current.startX)
              );
            }}
            onLostPointerCapture={() => setDraggingSide(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                e.preventDefault();
                commitLeftWidth(leftWidth - 20);
                announceResize('已收窄物料目录列');
              } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                commitLeftWidth(leftWidth + 20);
                announceResize('已加宽物料目录列');
              }
            }}
          />

          {/* Column 2: Selected Product's Mother Rolls + Linked Remnants */}
          <section className="pane" style={{ background: 'var(--bg)' }}>
            <div className="body">
              {activeProduct ? (
                <>
                  <div className="box inv-product-hero">
                    <div className="inv-hero-main">
                      <div>
                        <div className="inv-hero-eyebrow">当前选定物料品号</div>
                        <h2 className="inv-hero-title">
                          {activeProduct.modelKey}
                          {activeProduct.materialName ? (
                            <span> · {activeProduct.materialName}</span>
                          ) : null}
                        </h2>
                        {(activeProduct.composition || activeProduct.color) && (
                          <div className="inv-hero-meta">
                            {[activeProduct.color, activeProduct.composition]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="inv-hero-actions">
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            openActionPanel('receive', {
                              rollId: '',
                              rollModel: activeProduct.modelKey,
                              width: activeProduct.primaryWidthMm || '',
                              length: ''
                            })
                          }
                        >
                          ＋ 补录同品母卷
                        </button>
                      </div>
                    </div>

                    <div className="inv-hero-kpis num">
                      <div>
                        <small>在库母卷数</small>
                        <b>
                          {activeProduct.rolls.length}{' '}
                          <em>卷（合格 {activeProduct.passedRollCount}）</em>
                        </b>
                      </div>
                      <div>
                        <small>母卷可用总余长</small>
                        <b>
                          {fmtN(activeProduct.totalRemainingM, 2)} <em>m</em>
                        </b>
                      </div>
                      <div>
                        <small>关联可用料头</small>
                        <b
                          style={{
                            color: activeProduct.availableRemnants.length
                              ? 'var(--ok)'
                              : undefined
                          }}
                        >
                          {activeProduct.availableRemnants.length}{' '}
                          <em>块（共 {activeProduct.remnants.length} 条）</em>
                        </b>
                      </div>
                      <div>
                        <small>料头可用总面积</small>
                        <b>
                          {fmtN(activeProduct.availableRemnantAreaM2, 2)} <em>m²</em>
                        </b>
                      </div>
                    </div>
                  </div>

                  {/* Section 1: Mother Rolls */}
                  <div className="box">
                    <div className="pane-h">
                      <span>1. 该品在库母卷（{activeProduct.rolls.length} 卷）</span>
                      <small className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                        点击母卷行在右侧预览整卷余量与疵点坐标
                      </small>
                    </div>
                    {activeProduct.rolls.length > 0 ? (
                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 32 }}>
                              <input
                                type="checkbox"
                                aria-label="全选该品母卷"
                                checked={
                                  activeProduct.rolls.length > 0 &&
                                  activeProduct.rolls.every((r) => picked.has(idOf(true, r)))
                                }
                                onChange={(e) => {
                                  const next = new Set(picked);
                                  activeProduct.rolls.forEach((r) => {
                                    const k = idOf(true, r);
                                    if (e.target.checked) next.add(k);
                                    else next.delete(k);
                                  });
                                  setPicked(next);
                                }}
                              />
                            </th>
                            <th>母卷编号</th>
                            <th className="r">门幅</th>
                            <th className="r">剩余 / 整卷</th>
                            <th>派生关联料头</th>
                            <th className="r">疵点</th>
                            <th>库位</th>
                            <th>检验</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeProduct.rolls.map((r) => {
                            const itemKey = idOf(true, r);
                            const isChecked = picked.has(itemKey);
                            const isPreviewed =
                              previewTarget?.kind === 'roll' && previewTarget.id === r.rollId;
                            const remLen =
                              r.currentRemainingLength ?? r.totalLength - (r.usedLength || 0);
                            const [qt, qc] = ROLL_QUALITY_MAP[r.inspectionStatus] || [
                              r.inspectionStatus || '—',
                              ''
                            ];
                            const linkedRems = remnantsByRollId.get(r.rollId) || [];
                            const availRems = linkedRems.filter(
                              (rm) => rm.status === 'AVAILABLE'
                            );

                            return (
                              <tr
                                key={r.rollId}
                                className={`click ${isPreviewed ? 'sel' : ''}`}
                                onClick={() => handleInspectRoll(r)}
                              >
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    aria-label={`选择母卷 ${r.rollId}`}
                                    checked={isChecked}
                                    onChange={(e) => togglePick(itemKey, e.target.checked)}
                                  />
                                </td>
                                <td className="num" style={{ fontWeight: 600 }}>
                                  {r.rollId}
                                  {r.batchNo && (
                                    <div>
                                      <small className="muted">批次 {r.batchNo}</small>
                                    </div>
                                  )}
                                </td>
                                <td className="r num">{fmtN(r.width)}</td>
                                <td className="r num">
                                  <b>{fmtM(remLen)}</b> / {fmtM(r.totalLength)} m
                                </td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  {linkedRems.length > 0 ? (
                                    <button
                                      type="button"
                                      className="inv-roll-link num"
                                      title={
                                        activeProduct.rolls.length > 1
                                          ? '点击仅看此母卷派生的料头'
                                          : '点击预览第一块派生料头'
                                      }
                                      onClick={() => {
                                        if (activeProduct.rolls.length > 1) {
                                          setFocusedRollId((cur) =>
                                            cur === r.rollId ? '' : r.rollId
                                          );
                                        } else if (linkedRems[0]) {
                                          handleInspectRemnant(linkedRems[0]);
                                        }
                                      }}
                                    >
                                      可用 {availRems.length} / 共 {linkedRems.length} 块
                                    </button>
                                  ) : (
                                    <span className="muted">无料头</span>
                                  )}
                                </td>
                                <td className="r num">
                                  {r.defectsCount ?? (r.defects || []).length}
                                </td>
                                <td>{r.storageLocation || '—'}</td>
                                <td>
                                  <span className={`tag ${qc}`}>{qt}</span>
                                </td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  <a
                                    className="btn sm"
                                    href={`#/inspection/${encodeURIComponent(r.rollId)}`}
                                  >
                                    验疵
                                  </a>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty" style={{ padding: 16 }}>
                        该品号暂无整卷母卷记录
                      </div>
                    )}
                  </div>

                  {/* Section 2: Linked Remnants */}
                  <div className="box">
                    <div className="pane-h">
                      <span>2. 关联派生料头（{displayedRemnants.length} 块）</span>
                      {focusedRollId && (
                        <span className="tag run" style={{ marginLeft: 8 }}>
                          来源母卷：{focusedRollId}
                          <button
                            type="button"
                            className="inv-clear-chip"
                            onClick={() => setFocusedRollId('')}
                          >
                            × 全部
                          </button>
                        </span>
                      )}
                      <small className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                        点击料头行在右侧预览单块实尺与疵点
                      </small>
                      <span className="sp" />
                      <div className="seg" role="group" aria-label="料头状态范围">
                        <button
                          type="button"
                          className={remnantStatusFilter === 'AVAILABLE_FIRST' ? 'on' : ''}
                          aria-pressed={remnantStatusFilter === 'AVAILABLE_FIRST'}
                          onClick={() => setRemnantStatusFilter('AVAILABLE_FIRST')}
                        >
                          在库料头 ({activeProduct.availableRemnants.length})
                        </button>
                        <button
                          type="button"
                          className={remnantStatusFilter === 'ALL' ? 'on' : ''}
                          aria-pressed={remnantStatusFilter === 'ALL'}
                          onClick={() => setRemnantStatusFilter('ALL')}
                        >
                          含已耗/报废 ({activeProduct.remnants.length})
                        </button>
                      </div>
                    </div>

                    {displayedRemnants.length > 0 ? (
                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th style={{ width: 32 }}>
                              <input
                                type="checkbox"
                                aria-label="全选当前列表料头"
                                checked={
                                  displayedRemnants.length > 0 &&
                                  displayedRemnants.every((rm) => picked.has(idOf(false, rm)))
                                }
                                onChange={(e) => {
                                  const next = new Set(picked);
                                  displayedRemnants.forEach((rm) => {
                                    const k = idOf(false, rm);
                                    if (e.target.checked) next.add(k);
                                    else next.delete(k);
                                  });
                                  setPicked(next);
                                }}
                              />
                            </th>
                            <th>料头编号</th>
                            <th>关联来源母卷 · 谱系</th>
                            <th className="r">宽 × 长 mm</th>
                            <th className="r">面积 m²</th>
                            <th>疵点</th>
                            <th>状态</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayedRemnants.map((rm) => {
                            const itemKey = idOf(false, rm);
                            const isChecked = picked.has(itemKey);
                            const isPreviewed =
                              previewTarget?.kind === 'remnant' && previewTarget.id === rm.id;
                            const [stLabel, stClass] = REMNANT_STATUS_MAP[rm.status] || [
                              rm.status,
                              ''
                            ];
                            return (
                              <tr
                                key={rm.id}
                                className={`click ${isPreviewed ? 'sel' : ''}`}
                                onClick={() => handleInspectRemnant(rm)}
                              >
                                <td onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    aria-label={`选择料头 ${rm.id}`}
                                    checked={isChecked}
                                    onChange={(e) => togglePick(itemKey, e.target.checked)}
                                  />
                                </td>
                                <td className="num" style={{ fontWeight: 600 }}>
                                  {rm.id}
                                </td>
                                <td>
                                  <div
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 5,
                                      flexWrap: 'wrap'
                                    }}
                                  >
                                    <span className="num muted">
                                      母卷 {rm.sourceRollId || '—'}
                                    </span>
                                    {rm.generation ? (
                                      <span className="tag">G{rm.generation}</span>
                                    ) : null}
                                    {rm.qualityDispositionId && (
                                      <span className="tag warn">复检回收</span>
                                    )}
                                  </div>
                                </td>
                                <td className="r num">
                                  {fmtN(rm.width)} × {fmtN(rm.length)}
                                </td>
                                <td className="r num">{fmtN(rm.area, 2)}</td>
                                <td>
                                  {rm.hasDefect ? (
                                    <span className="tag warn">带疵</span>
                                  ) : (
                                    <span className="muted">无疵</span>
                                  )}
                                </td>
                                <td>
                                  <span className={`tag ${stClass}`}>{stLabel}</span>
                                </td>
                                <td onClick={(e) => e.stopPropagation()}>
                                  {(rm.status === 'AVAILABLE' ||
                                    rm.status === 'QUARANTINED') && (
                                    <button
                                      type="button"
                                      className="btn sm"
                                      onClick={() =>
                                        openActionPanel('scrap', { scrapId: rm.id })
                                      }
                                    >
                                      报废
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <div className="empty" style={{ padding: 16 }}>
                        暂无符合当前筛选条件的料头
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="empty">请从左侧选择一个物料品号查看对应母卷与料头</div>
              )}
            </div>
          </section>

          {/* Resizer Handle 2 + Column 3: Right Interactive CAD Preview Pane */}
          {previewOpen && (
            <>
              <button
                type="button"
                className={`inv-split-handle ${draggingSide === 'right' ? 'dragging' : ''}`}
                aria-label="左右拖动或按左右方向键调节右侧实物预览区宽度"
                title="左右拖动调节预览区大小（或按键盘 ← → 键）"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragOriginRef.current = { startX: e.clientX, startW: previewWidth };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDraggingSide('right');
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  // Moving pointer left increases right preview width
                  commitPreviewWidth(
                    dragOriginRef.current.startW + (dragOriginRef.current.startX - e.clientX)
                  );
                }}
                onLostPointerCapture={() => setDraggingSide(null)}
                onDoubleClick={() => {
                  const next = previewWidth < 500 ? 580 : 420;
                  commitPreviewWidth(next);
                  announceResize(next > 500 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度');
                }}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 48 : 20;
                  if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    commitPreviewWidth(previewWidth + step);
                    announceResize('已加宽右侧实物预览区');
                  } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    commitPreviewWidth(previewWidth - step);
                    announceResize('已收窄右侧实物预览区');
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    commitPreviewWidth(640);
                    announceResize('预览区已设为最大宽度');
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    commitPreviewWidth(420);
                    announceResize('预览区已恢复标准宽度');
                  }
                }}
              />

              <aside className="pane inv-preview-pane" aria-label="实物几何与疵点预览">
                <div className="pane-h inv-preview-head">
                  {previewRoll ? (
                    <>
                      <span className="tag run">母卷预览</span>
                      <strong className="num inv-preview-id">{previewRoll.rollId}</strong>
                    </>
                  ) : previewRemnant ? (
                    <>
                      <span className="tag ok">料头预览</span>
                      <strong className="num inv-preview-id">{previewRemnant.id}</strong>
                    </>
                  ) : (
                    <span>实物几何预览</span>
                  )}
                  <span className="sp" />
                  {previewRoll && previewRoll.inspectionStatus === 'PASSED' && (
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={() => {
                        setCanvasSpec({
                          canvasMode: 'STOCK_ROLL',
                          selectedRollId: previewRoll.rollId,
                          canvasWidthMm: previewRoll.width,
                          materialModel2D: previewRoll.rollModel
                        });
                        location.hash = '#/workbench';
                      }}
                    >
                      去排料 →
                    </button>
                  )}
                  {previewRemnant && previewRemnant.status === 'AVAILABLE' && (
                    <button
                      type="button"
                      className="btn sm pri"
                      onClick={() => {
                        setCanvasSpec({
                          canvasMode: 'FREE_CANVAS',
                          canvasWidthMm: previewRemnant.width,
                          canvasLengthMm: previewRemnant.length,
                          materialModel2D:
                            previewRemnant.materialBatch || activeProduct?.modelKey || 'REMNANT'
                        });
                        toast(
                          `已按料头 ${previewRemnant.id} (${previewRemnant.width}×${previewRemnant.length}mm) 设定排料画布`
                        );
                        location.hash = '#/workbench';
                      }}
                    >
                      去排料 →
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    title="一键在标准宽度与宽屏大图预览之间切换"
                    onClick={() => {
                      const next = previewWidth < 500 ? 580 : 420;
                      commitPreviewWidth(next);
                      announceResize(
                        next > 500 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度'
                      );
                    }}
                  >
                    {previewWidth < 500 ? '⇔ 加宽' : '⇒ 标准'}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    aria-label="收起右侧预览窗格"
                    title="收起预览"
                    onClick={() => {
                      setPreviewOpen(false);
                      announceResize('右侧实物预览窗格已收起');
                    }}
                  >
                    收起
                  </button>
                </div>

                {previewScene && (previewRoll || previewRemnant) ? (
                  <div className="inv-preview-body">
                    {/* CAD Preview Toolbar */}
                    <div
                      className="ctool inv-preview-toolbar"
                      role="toolbar"
                      aria-label="库存实物预览控制工具栏"
                    >
                      {previewRoll ? (
                        <>
                          <div className="ctool-group" role="group" aria-label="母卷展开方式">
                            <button
                              type="button"
                              aria-pressed={rollLayout === 'tile'}
                              onClick={() => setRollLayout('tile')}
                              title="将长母卷自动分排折叠，同屏看清全卷与疵点"
                            >
                              折叠全卷
                            </button>
                            <button
                              type="button"
                              aria-pressed={rollLayout === 'strip'}
                              onClick={() => setRollLayout('strip')}
                              title="按真实比例单条展开整卷"
                            >
                              单条全卷
                            </button>
                            <button
                              type="button"
                              aria-pressed={rollLayout === 'station'}
                              onClick={() => setRollLayout('station')}
                              title="聚焦待裁切起始端头窗口"
                            >
                              待切端头
                            </button>
                          </div>
                          <span className="div" role="separator" aria-orientation="vertical" />
                        </>
                      ) : previewRemnant?.sourceRollId ? (
                        <>
                          <button
                            type="button"
                            title="切换查看该料头的来源母卷整卷预览"
                            onClick={() => {
                              const parent = rolls.find(
                                (r) => r.rollId === previewRemnant.sourceRollId
                              );
                              if (parent) handleInspectRoll(parent);
                            }}
                          >
                            ↑ 看母卷
                          </button>
                          <span className="div" role="separator" aria-orientation="vertical" />
                        </>
                      ) : null}

                      <div className="ctool-group" role="group" aria-label="画布缩放与测距">
                        <button
                          type="button"
                          onClick={() => previewCanvasRef.current?.fit()}
                        >
                          居中
                        </button>
                        <button
                          type="button"
                          aria-label="缩小预览"
                          onClick={() => previewCanvasRef.current?.zoom(1 / 1.25)}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          aria-label="放大预览"
                          onClick={() => previewCanvasRef.current?.zoom(1.25)}
                        >
                          ＋
                        </button>
                        <button
                          type="button"
                          aria-pressed={!vertical}
                          onClick={() => setVertical((v) => !v)}
                        >
                          {vertical ? '竖排' : '横排'}
                        </button>
                        <button
                          type="button"
                          aria-pressed={tool === 'measure'}
                          onClick={() =>
                            setTool((t) => (t === 'measure' ? 'pan' : 'measure'))
                          }
                        >
                          测距
                        </button>
                      </div>

                      {((previewRoll?.defects || previewRemnant?.defects || []).length > 0) && (
                        <>
                          <span className="sp" />
                          <select
                            className="inv-toolbar-select num"
                            aria-label="选择疵点放大定位"
                            value=""
                            onChange={(e) => {
                              const list = previewRoll?.defects || previewRemnant?.defects || [];
                              const d = list[Number(e.target.value)];
                              const w = previewRoll?.width || previewRemnant?.width || 2000;
                              if (d) handleZoomToDefect(d, w);
                            }}
                          >
                            <option value="" disabled>
                              定位疵点 ({(previewRoll?.defects || previewRemnant?.defects || []).length})…
                            </option>
                            {(previewRoll?.defects || previewRemnant?.defects || []).map(
                              (d: any, idx: number) => (
                                <option key={d.id || idx} value={idx}>
                                  #{idx + 1} {d.typeName || d.defectType} · Y{' '}
                                  {previewRoll ? `${(d.y / 1000).toFixed(2)}m` : `${fmtN(d.y)}mm`}
                                </option>
                              )
                            )}
                          </select>
                        </>
                      )}
                    </div>

                    {/* Full-Height Interactive Konva CAD Canvas */}
                    <div className="inv-canvas-box">
                      <CadCanvasView
                        scene={previewScene}
                        vertical={vertical}
                        showDimensions={true}
                        showPath={false}
                        viewMode={
                          previewRoll
                            ? rollLayout === 'station'
                              ? 'station'
                              : 'full'
                            : 'station'
                        }
                        fullMode={
                          previewRoll && rollLayout === 'tile' ? 'tile' : 'strip'
                        }
                        minHeight={360}
                        ariaLabel={
                          previewRoll
                            ? `母卷 ${previewRoll.rollId} 实物预览画布`
                            : `料头 ${previewRemnant?.id} 实物预览画布`
                        }
                        tool={tool}
                        onCursorMove={setCursor}
                        canvasRefOut={previewCanvasRef}
                      />
                    </div>

                    <div className="studio-canvas-hint num">
                      {previewRoll
                        ? `幅宽 ${fmtN(previewRoll.width)} mm × 总长 ${fmtM(previewRoll.totalLength)} m（剩余 ${fmtM(previewRoll.currentRemainingLength ?? previewRoll.totalLength - (previewRoll.usedLength || 0))} m · 疵点 ${(previewRoll.defects || []).length} 处）`
                        : `料头尺寸 ${fmtN(previewRemnant?.width)} × ${fmtN(previewRemnant?.length)} mm（${fmtN(previewRemnant?.area, 2)} m²）`}
                      {cursor ? ` · X=${fmtN(cursor.v, 0)} / Y=${fmtN(cursor.u, 0)} mm` : ''}
                    </div>
                  </div>
                ) : (
                  <div className="empty">点击任意母卷或料头查看实物尺寸与疵点图</div>
                )}
              </aside>
            </>
          )}
        </div>
      )}

      {/* Operational Action Modal: Receive / Transfer / Count / Scrap */}
      <ModalDialog
        open={action !== null}
        title={action ? ACTION_TITLES[action] : '库存业务操作'}
        onClose={() => {
          if (!busy) setAction(null);
        }}
        maxWidth={680}
      >
        {action === 'receive' ? (
          <form onSubmit={handleSubmitAction}>
            <div className="form" style={{ gridTemplateColumns: '100px 1fr', padding: '4px 0 8px' }}>
              <label htmlFor="inv-rec-rollid">母卷卷号</label>
              <input
                id="inv-rec-rollid"
                data-form="rollId"
                className="field"
                required
                placeholder="如 ROLL-2026-1101"
                value={rollIdInput}
                onChange={(e) => setRollIdInput(e.target.value)}
              />
              <label htmlFor="inv-rec-model">物料品号</label>
              <input
                id="inv-rec-model"
                data-form="rollModel"
                className="field"
                required
                list="inv-models-datalist"
                value={rollModelInput}
                onChange={(e) => setRollModelInput(e.target.value)}
              />
              <datalist id="inv-models-datalist">
                {productGroups.map((g) => (
                  <option key={g.modelKey} value={g.modelKey} />
                ))}
              </datalist>
              <label htmlFor="inv-rec-width">幅宽 mm</label>
              <input
                id="inv-rec-width"
                data-form="width"
                type="number"
                required
                className="field num"
                value={widthInput}
                onChange={(e) => setWidthInput(e.target.value)}
              />
              <label htmlFor="inv-rec-len">整卷长度 m</label>
              <input
                id="inv-rec-len"
                data-form="length"
                type="number"
                step="0.01"
                required
                className="field num"
                value={lengthInput}
                onChange={(e) => setLengthInput(e.target.value)}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 14px' }}>
              新母卷入库后默认处于“待检”状态，确认登记后直接进入跑布验疵定位画布，检验放行后方可投产锁料。
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setAction(null)}>
                取消
              </button>
              <button id="act-submit" type="submit" className="btn pri" disabled={busy}>
                登记并去验布 →
              </button>
            </div>
          </form>
        ) : action === 'scrap' ? (
          <form onSubmit={handleSubmitAction}>
            {(() => {
              const targetRem = remnants.find((r) => r.id === scrapId);
              return (
                <>
                  <div className="kv" style={{ padding: '4px 0 10px' }}>
                    <div>料头编号</div>
                    <div className="num">{targetRem?.id}</div>
                    <div>关联来源母卷</div>
                    <div className="num">{targetRem?.sourceRollId || '—'}</div>
                    <div>实物尺寸</div>
                    <div className="num">
                      {fmtN(targetRem?.width)} × {fmtN(targetRem?.length)} mm（
                      {fmtN(targetRem?.area, 2)} m²）
                    </div>
                  </div>
                  <div
                    className="form"
                    style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 14px' }}
                  >
                    <label htmlFor="inv-scrap-reason">报废原因</label>
                    <input
                      id="inv-scrap-reason"
                      className="field"
                      required
                      autoFocus
                      value={reason}
                      placeholder="如：污损无法复用 / 窄边清理"
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setAction(null)}
                    >
                      取消
                    </button>
                    <button type="submit" className="btn pri" disabled={busy}>
                      确认报废
                    </button>
                  </div>
                </>
              );
            })()}
          </form>
        ) : !opts ? (
          <div className="loading">正在校验已选母卷与料头可操作状态…</div>
        ) : (
          <form onSubmit={handleSubmitAction}>
            <table className="t" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>实物编号</th>
                  <th>当前库位</th>
                  {action === 'count' && (
                    <>
                      <th>实物在库</th>
                      <th className="r">实测宽 mm</th>
                      <th className="r">实测长 mm</th>
                    </>
                  )}
                  <th />
                </tr>
              </thead>
              <tbody>
                {selectedMaterials.map(({ type, id, m }) => {
                  const rowKey = `${type}:${id}`;
                  const c = getCountRow(rowKey);
                  return (
                    <tr key={rowKey}>
                      <td>
                        <span className="tag kind">{type === 'roll' ? '母卷' : '料头'}</span>
                      </td>
                      <td className="num">{id}</td>
                      <td>{m?.location || '—'}</td>
                      {action === 'count' && (
                        <>
                          <td>
                            <input
                              type="checkbox"
                              checked={c.present}
                              onChange={(e) =>
                                updateCountRow(rowKey, { present: e.target.checked })
                              }
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              className="field num"
                              value={c.width}
                              style={{ width: 72, textAlign: 'right' }}
                              disabled={type === 'roll' || !c.present}
                              onChange={(e) => updateCountRow(rowKey, { width: e.target.value })}
                            />
                          </td>
                          <td className="r">
                            <input
                              type="number"
                              className="field num"
                              value={c.length}
                              style={{ width: 82, textAlign: 'right' }}
                              disabled={!c.present}
                              onChange={(e) => updateCountRow(rowKey, { length: e.target.value })}
                            />
                          </td>
                        </>
                      )}
                      <td>
                        {!m?.allowed && (
                          <span className="tag err" title={m?.reason || '不可操作'}>
                            不可操作
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {blockedMaterials.length > 0 && (
              <div className="notice" style={{ marginBottom: 10 }}>
                {blockedMaterials.map((x) => (
                  <div key={`${x.type}:${x.id}`}>
                    {x.id}：{x.m?.reason || '当前处于锁定或不可操作状态'}
                  </div>
                ))}
              </div>
            )}

            <div className="form" style={{ gridTemplateColumns: '90px 1fr', padding: '4px 0 8px' }}>
              {action === 'transfer' && (
                <>
                  <label htmlFor="inv-dest">目标库位</label>
                  <input
                    id="inv-dest"
                    className="field"
                    required
                    value={destination}
                    placeholder="如：裁床待料区 A-02"
                    onChange={(e) => setDestination(e.target.value)}
                  />
                </>
              )}
              <label htmlFor="inv-reason">变更原因</label>
              <input
                id="inv-reason"
                className="field"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <label htmlFor="inv-operator">经办人</label>
              <input
                id="inv-operator"
                className="field"
                required
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
              />
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 14px' }}>
              {action === 'count'
                ? '母卷按实测剩余长度核对（幅宽不变）；料头核对实测宽×长；实物不在库请取消勾选。盘点差异独立入账，不计入生产耗用。'
                : '移库仅变更存放库位并生成不可变移库单，不改变数量、质量状态与母卷谱系。'}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setAction(null)}>
                取消
              </button>
              <button
                type="submit"
                className="btn pri"
                disabled={busy || blockedMaterials.length > 0 || selectedMaterials.length === 0}
              >
                确认{ACTION_TITLES[action]}
              </button>
            </div>
          </form>
        )}
      </ModalDialog>
    </div>
  );
};
