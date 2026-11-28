import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestJSON,
  toast,
  pendingWrite,
  retryWrite,
  dropWrite,
  createUuid
} from '../lib/core/util.js';
import { workflowTemplate } from '../lib/model/showcase.js';
import { SegmentedOption } from '../components/ui/MagpiePrimitives';
import { useWorkbench2DActions } from '../store/selectors';
import { AuthSession, LOCAL_FALLBACK_SESSION } from '../utils/authClient';
import {
  CountRowState,
  InventoryActionKind,
  InventoryStatusScope,
  InventoryViewScope,
  PendingSlotKey,
  PreviewTarget,
  ProductGroup,
  REMNANT_STATUS_MAP,
  ReceiveModalMode,
  RollPreviewLayout,
  buildInventoryPreviewScene,
  buildProductGroups,
  clampNum,
  idOf
} from './inventory/inventoryTypes';
import {
  executeInventoryAction,
  filterDisplayedRemnants,
  filterDisplayedRolls,
  filterInventoryProducts,
  findScanTargets
} from './inventory/inventoryActions';
import { InventoryToolbar } from './inventory/InventoryToolbar';
import { InventoryLedgerPanel } from './inventory/InventoryLedgerPanel';
import { InventoryPreviewPane } from './inventory/InventoryPreviewPane';
import { InventoryActionModal } from './inventory/InventoryActionModal';

export const InventoryPage: React.FC<{
  params?: string[];
  auth?: AuthSession;
}> = ({ params = [], auth = LOCAL_FALLBACK_SESSION }) => {
  const [intent, templateId] = params;
  const { setCanvasSpec } = useWorkbench2DActions();

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState<string>('');
  const [focusedRollId, setFocusedRollId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [scanCode, setScanCode] = useState<string>('');
  const [scanHitKey, setScanHitKey] = useState<string>('');
  const [includeQuarantined, setIncludeQuarantined] = useState<boolean>(false);
  const [viewScope, setViewScope] = useState<InventoryViewScope>('ALL');
  const [statusScope, setStatusScope] = useState<InventoryStatusScope>('ALL');

  const [previewTarget, setPreviewTarget] = useState<PreviewTarget>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean>(true);
  const [previewWidth, setPreviewWidth] = useState<number>(() => {
    try {
      return clampNum(Number(localStorage.getItem('cutplan.inv.rightW')) || 384, 300, 740);
    } catch {
      return 384;
    }
  });
  const [draggingRight, setDraggingRight] = useState<boolean>(false);
  const [liveAnnounce, setLiveAnnounce] = useState<string>('');

  const [rollLayout, setRollLayout] = useState<RollPreviewLayout>('tile');
  const [vertical, setVertical] = useState<boolean>(true);
  const [tool, setTool] = useState<'pan' | 'measure'>('pan');
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);
  const [rollSpatialMap, setRollSpatialMap] = useState<any | null>(null);

  const layoutContainerRef = useRef<HTMLDivElement | null>(null);
  const previewCanvasRef = useRef<any>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const dragOriginRef = useRef<{ startX: number; startW: number }>({ startX: 0, startW: 0 });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<InventoryActionKind | null>(null);
  const [receiveMode, setReceiveMode] = useState<ReceiveModalMode>('single');
  const [opts, setOpts] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [pendingTick, setPendingTick] = useState(0);

  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [rollIdInput, setRollIdInput] = useState('');
  const [rollModelInput, setRollModelInput] = useState('');
  const [widthInput, setWidthInput] = useState<string | number>('');
  const [lengthInput, setLengthInput] = useState<string | number>('');
  const [batchNoInput, setBatchNoInput] = useState('');
  const [colorInput, setColorInput] = useState('');
  const [shrinkageInput, setShrinkageInput] = useState<string | number>('');
  const [locationInput, setLocationInput] = useState('');
  const [scrapId, setScrapId] = useState('');
  const [releaseRemnantId, setReleaseRemnantId] = useState('');
  const [releaseDecision, setReleaseDecision] = useState<'RELEASE_AVAILABLE' | 'SCRAP'>(
    'RELEASE_AVAILABLE'
  );
  const [releaseInspector, setReleaseInspector] = useState('');
  const [scrapRollId, setScrapRollId] = useState('');
  const [editRollTarget, setEditRollTarget] = useState<any | null>(null);
  const [countsMap, setCountsMap] = useState<Record<string, CountRowState>>({});

  const loadData = async (forceIncludeQuarantined?: boolean) => {
    setLoading(true);
    setError(null);
    const shouldIncludeQ = forceIncludeQuarantined ?? includeQuarantined;
    try {
      const [r, rem] = await Promise.all([
        requestJSON('/api/v2/rolls'),
        requestJSON(shouldIncludeQ ? '/api/v2/remnants?includeQuarantined=true' : '/api/v2/remnants')
      ]);
      setRolls(r || []);
      setRemnants(rem || []);
      const hashQuery = typeof location !== 'undefined' ? location.hash.split('?')[1] || '' : '';
      const targetRollParam = new URLSearchParams(hashQuery).get('roll');
      if (targetRollParam && Array.isArray(r)) {
        const hit = r.find((x: any) => x.rollId === targetRollParam);
        if (hit) {
          setSelectedModel(hit.rollModel || hit.materialName || '未分类品号');
          setPreviewTarget({ kind: 'roll', id: hit.rollId });
          setPreviewOpen(true);
        }
      }
      return { rolls: r || [], remnants: rem || [] };
    } catch (e: any) {
      setError(e.message || '读取库存档案失败');
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [includeQuarantined]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        scanInputRef.current?.focus();
        scanInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const announceResize = (msg: string) => {
    setLiveAnnounce(msg);
    window.setTimeout(() => {
      setLiveAnnounce((cur) => (cur === msg ? '' : cur));
    }, 1200);
  };

  const commitPreviewWidth = (next: number) => {
    const containerW = layoutContainerRef.current?.clientWidth || 1200;
    const maxRight = Math.max(320, Math.min(760, containerW - 440));
    const clamped = clampNum(Math.round(next), 300, maxRight);
    setPreviewWidth(clamped);
    try {
      localStorage.setItem('cutplan.inv.rightW', String(clamped));
    } catch {}
  };

  const openActionPanel = async (kind: InventoryActionKind, extra: any = {}) => {
    setAction(kind);
    if (kind === 'receive') {
      setReceiveMode(extra.receiveMode || 'single');
    }
    setReason('');
    setOpts(null);
    if (extra.rollId !== undefined) setRollIdInput(extra.rollId);
    if (extra.rollModel !== undefined) setRollModelInput(extra.rollModel);
    if (extra.width !== undefined) setWidthInput(extra.width);
    if (extra.length !== undefined) setLengthInput(extra.length);
    if (extra.batchNo !== undefined) setBatchNoInput(extra.batchNo);
    else if (kind === 'receive') setBatchNoInput('');
    if (extra.color !== undefined) setColorInput(extra.color);
    else if (kind === 'receive') setColorInput('');
    if (extra.shrinkageRate !== undefined) setShrinkageInput(extra.shrinkageRate);
    else if (kind === 'receive') setShrinkageInput('');
    if (extra.storageLocation !== undefined) setLocationInput(extra.storageLocation);
    else if (kind === 'receive') setLocationInput('');
    if (extra.scrapId !== undefined) setScrapId(extra.scrapId);
    if (extra.releaseRemnantId !== undefined) {
      setReleaseRemnantId(extra.releaseRemnantId);
      setReleaseDecision(extra.decision || 'RELEASE_AVAILABLE');
    }
    if (extra.scrapRollId !== undefined) setScrapRollId(extra.scrapRollId);
    if (kind === 'editRoll' && extra.roll) {
      setEditRollTarget(extra.roll);
      setBatchNoInput(extra.roll.batchNo || '');
      setColorInput(extra.roll.color || '');
      setShrinkageInput(extra.roll.shrinkageRate ?? '');
      setLocationInput(extra.roll.storageLocation || '');
    }

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
              rollId: 'DEMO-' + createUuid().slice(0, 8)
            }
          : {}
      );
    }
  }, [intent, templateId]);

  const productGroups = useMemo<ProductGroup[]>(
    () => buildProductGroups(rolls, remnants),
    [rolls, remnants]
  );

  const passedRollTotal = useMemo(
    () => rolls.filter((r) => r.inspectionStatus === 'PASSED').length,
    [rolls]
  );
  const availableRemnantTotal = useMemo(
    () => remnants.filter((rm) => rm.status === 'AVAILABLE').length,
    [remnants]
  );
  const pendingIssueTotal = useMemo(
    () =>
      rolls.filter((r) => r.inspectionStatus !== 'PASSED').length +
      remnants.filter((rm) => rm.status === 'QUARANTINED' || rm.status === 'LOST').length,
    [rolls, remnants]
  );

  const filteredProducts = useMemo(
    () => filterInventoryProducts(productGroups, searchQuery, viewScope, statusScope),
    [productGroups, searchQuery, viewScope, statusScope]
  );

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

  useEffect(() => {
    if (!activeProduct) {
      setPreviewTarget(null);
      return;
    }
    const validCurrent =
      (previewTarget?.kind === 'roll' && activeProduct.rolls.some((r) => r.rollId === previewTarget.id)) ||
      (previewTarget?.kind === 'remnant' && activeProduct.remnants.some((rm) => rm.id === previewTarget.id));

    if (!validCurrent) {
      if (viewScope !== 'REMNANTS' && activeProduct.rolls.length > 0) {
        const firstRoll = activeProduct.rolls[0];
        setPreviewTarget({ kind: 'roll', id: firstRoll.rollId });
        setRollLayout(firstRoll.totalLength > 15000 ? 'tile' : 'strip');
      } else if (activeProduct.remnants.length > 0) {
        setPreviewTarget({ kind: 'remnant', id: activeProduct.remnants[0].id });
      } else if (activeProduct.rolls.length > 0) {
        const firstRoll = activeProduct.rolls[0];
        setPreviewTarget({ kind: 'roll', id: firstRoll.rollId });
        setRollLayout(firstRoll.totalLength > 15000 ? 'tile' : 'strip');
      } else {
        setPreviewTarget(null);
      }
    }
  }, [activeProduct, viewScope]);

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

  const productMatchesQuery = useMemo(() => {
    if (!activeProduct) return true;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return `${activeProduct.modelKey} ${activeProduct.materialName} ${activeProduct.color} ${activeProduct.composition}`
      .toLowerCase()
      .includes(q);
  }, [activeProduct, searchQuery]);

  const displayedRolls = useMemo(
    () => filterDisplayedRolls(activeProduct, statusScope, searchQuery, productMatchesQuery),
    [activeProduct, statusScope, searchQuery, productMatchesQuery]
  );

  const rollLookup = useMemo(() => {
    const map = new Map<string, any>();
    for (const r of rolls) {
      if (r?.rollId) map.set(r.rollId, r);
    }
    return map;
  }, [rolls]);

  const handleScanLocate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = scanCode.trim();
    if (!raw) return;
    const upper = raw.toUpperCase();

    let rollList = rolls;
    let remList = remnants;
    let { hitRoll, hitRem } = findScanTargets(rollList, remList, upper);

    if (!hitRoll && !hitRem && !includeQuarantined) {
      setIncludeQuarantined(true);
      const refreshed = await loadData(true);
      if (refreshed) {
        rollList = refreshed.rolls;
        remList = refreshed.remnants;
        ({ hitRoll, hitRem } = findScanTargets(rollList, remList, upper));
      }
    }

    if (hitRoll) {
      const modelKey = hitRoll.rollModel || hitRoll.materialName || '未分类品号';
      setSearchQuery('');
      setViewScope('ALL');
      setStatusScope(
        hitRoll.inspectionStatus === 'SCRAPPED' || hitRoll.status === 'SCRAPPED' ? 'HISTORY' : 'ALL'
      );
      setSelectedModel(modelKey);
      setFocusedRollId('');
      setPreviewTarget({ kind: 'roll', id: hitRoll.rollId });
      setRollLayout(hitRoll.totalLength > 15000 ? 'tile' : 'strip');
      setPreviewOpen(true);
      const hitKey = `roll:${hitRoll.rollId}`;
      setScanHitKey(hitKey);
      window.setTimeout(() => {
        document
          .querySelector(`[data-inv-row="${CSS.escape(hitKey)}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
      toast(`扫码定位成功：母卷 ${hitRoll.rollId}（${modelKey}）`);
      setScanCode('');
      return;
    }

    if (hitRem) {
      const parentRoll = hitRem.sourceRollId ? rollList.find((r) => r.rollId === hitRem.sourceRollId) : null;
      const modelKey = parentRoll?.rollModel || hitRem.materialBatch || hitRem.sourceRollId || '未分类品号';
      setSearchQuery('');
      setViewScope('ALL');
      if (hitRem.status === 'QUARANTINED' || hitRem.status === 'LOST') {
        setIncludeQuarantined(true);
        setStatusScope('ALL');
      } else if (['CONSUMED', 'SCRAPPED', 'REVOKED', 'VOIDED'].includes(hitRem.status)) {
        setStatusScope('HISTORY');
      } else {
        setStatusScope('ALL');
      }
      setSelectedModel(modelKey);
      setFocusedRollId('');
      setPreviewTarget({ kind: 'remnant', id: hitRem.id });
      setPreviewOpen(true);
      const hitKey = `remnant:${hitRem.id}`;
      setScanHitKey(hitKey);
      window.setTimeout(() => {
        document
          .querySelector(`[data-inv-row="${CSS.escape(hitKey)}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
      toast(`扫码定位成功：料头 ${hitRem.id}（状态：${REMNANT_STATUS_MAP[hitRem.status]?.[0] || hitRem.status}）`);
      setScanCode('');
      return;
    }

    toast(`未在台账中找到编号「${raw}」，请检查条码或开启「显示隔离/盘亏料头」后重试`, true);
  };

  const displayedRemnants = useMemo(
    () =>
      filterDisplayedRemnants(
        activeProduct,
        focusedRollId,
        statusScope,
        searchQuery,
        productMatchesQuery,
        includeQuarantined,
        rollLookup
      ),
    [activeProduct, focusedRollId, statusScope, searchQuery, productMatchesQuery, includeQuarantined, rollLookup]
  );

  const previewRoll = useMemo(
    () => (previewTarget?.kind === 'roll' ? rolls.find((r) => r.rollId === previewTarget.id) || null : null),
    [previewTarget, rolls]
  );

  const previewRemnant = useMemo(
    () => (previewTarget?.kind === 'remnant' ? remnants.find((rm) => rm.id === previewTarget.id) || null : null),
    [previewTarget, remnants]
  );

  useEffect(() => {
    if (!previewRoll?.rollId) {
      setRollSpatialMap(null);
      return;
    }
    let cancelled = false;
    requestJSON('/api/v2/rolls/' + encodeURIComponent(previewRoll.rollId) + '/spatial-map')
      .then((data) => {
        if (!cancelled) setRollSpatialMap(data);
      })
      .catch(() => {
        if (!cancelled) setRollSpatialMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [previewRoll?.rollId, rolls]);

  const previewScene = useMemo(
    () => buildInventoryPreviewScene(previewRoll, previewRemnant, rollSpatialMap),
    [previewRoll, previewRemnant, rollSpatialMap]
  );

  const handleZoomToSpan = (startY: number, endY: number, widthMm: number) => {
    if (!previewCanvasRef.current) return;
    if (rollLayout === 'tile') {
      setRollLayout('strip');
      window.setTimeout(() => {
        previewCanvasRef.current?.fitBounds({
          u0: Math.max(0, startY - 300),
          u1: endY + 300,
          v0: 0,
          v1: widthMm
        });
      }, 40);
      return;
    }
    previewCanvasRef.current.fitBounds({
      u0: Math.max(0, startY - 300),
      u1: endY + 300,
      v0: 0,
      v1: widthMm
    });
  };

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
    try {
      return (['transfer', 'count', 'quality-release', 'roll-scrap'] as const)
        .map((s) => [s, pendingWrite(s)] as const)
        .filter(([, v]) => Boolean(v));
    } catch {
      return [];
    }
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
    return { present: true, width: m?.width ?? '', length: m?.length ?? '' };
  };

  const updateCountRow = (key: string, patch: Partial<CountRowState>) => {
    const cur = getCountRow(key);
    setCountsMap((prev) => ({ ...prev, [key]: { ...cur, ...patch } }));
  };

  const handleSubmitAction = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    try {
      const outcome = await executeInventoryAction({
        action,
        rollIdInput,
        rollModelInput,
        widthInput,
        lengthInput,
        batchNoInput,
        colorInput,
        shrinkageInput,
        locationInput,
        editRollTarget,
        releaseRemnantId,
        releaseDecision,
        releaseInspector,
        scrapRollId,
        scrapId,
        destination,
        reason,
        operator,
        opts,
        selectedMaterials,
        getCountRow
      });
      toast(outcome.toastMessage);
      if (outcome.clearEditRoll) setEditRollTarget(null);
      if (outcome.clearPicked) setPicked(new Set());
      setAction(null);
      if (outcome.redirectHash) {
        location.hash = outcome.redirectHash;
        return;
      }
      await loadData();
    } catch (err: any) {
      const msg = err.message || '提交失败';
      toast((err.httpStatus || msg.startsWith('请') || msg.startsWith('上次') ? '' : '结果未确认，可重试：') + msg, true);
    } finally {
      setBusy(false);
      setPendingTick((t) => t + 1);
    }
  };

  const handleRetryWrite = async (slot: PendingSlotKey) => {
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

  const handleDropWrite = (slot: PendingSlotKey) => {
    dropWrite(slot);
    toast('已放弃待确认操作，请到库存单据核对是否已过账');
    setPendingTick((t) => t + 1);
  };

  const viewOptions: SegmentedOption<InventoryViewScope>[] = useMemo(
    () => [
      { value: 'ALL', label: '全部台账' },
      { value: 'ROLLS', label: '母卷', count: rolls.length, accent: 'indigo' },
      { value: 'REMNANTS', label: '料头', count: availableRemnantTotal, accent: 'emerald' }
    ],
    [rolls.length, availableRemnantTotal]
  );

  const statusOptions: SegmentedOption<InventoryStatusScope>[] = useMemo(
    () => [
      { value: 'ALL', label: '在库' },
      { value: 'READY', label: '合格 / 可用' },
      { value: 'PENDING', label: '待检 / 异常', count: pendingIssueTotal || undefined },
      { value: 'HISTORY', label: '含已耗 / 报废' }
    ],
    [pendingIssueTotal]
  );

  return (
    <div className="react-page mp-inv-page">
      <div className="sr-only" aria-live="polite">
        {liveAnnounce}
      </div>

      <InventoryToolbar
        productGroups={productGroups}
        filteredProducts={filteredProducts}
        rollsCount={rolls.length}
        passedRollTotal={passedRollTotal}
        availableRemnantTotal={availableRemnantTotal}
        previewOpen={previewOpen}
        onExpandPreview={() => {
          setPreviewOpen(true);
          announceResize('右侧实物预览窗格已展开');
        }}
        pickedCount={picked.size}
        onClearPicked={() => setPicked(new Set())}
        onOpenAction={openActionPanel}
        onOpenBatchImport={() => openActionPanel('receive', { receiveMode: 'batch_rolls' })}
        activeProduct={activeProduct}
        scanInputRef={scanInputRef}
        scanCode={scanCode}
        onScanCodeChange={setScanCode}
        onScanLocate={handleScanLocate}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        includeQuarantined={includeQuarantined}
        onToggleQuarantined={setIncludeQuarantined}
        viewOptions={viewOptions}
        viewScope={viewScope}
        onViewScopeChange={setViewScope}
        statusOptions={statusOptions}
        statusScope={statusScope}
        onStatusScopeChange={setStatusScope}
        pendings={pendings}
        onRetryWrite={handleRetryWrite}
        onDropWrite={handleDropWrite}
      />

      {error ? (
        <div className="mp-page-shell">
          <div className="error-box" role="alert">
            <b>读取失败</b>
            <p>{error}</p>
          </div>
        </div>
      ) : loading ? (
        <div className="mp-page-shell">
          <div className="mp-doc-card">
            <div className="loading">正在读取物料品号与母卷料头台账…</div>
          </div>
        </div>
      ) : (
        <div
          ref={layoutContainerRef}
          className={`inv-resizable-workspace mp-inv-workspace ${draggingRight ? 'is-resizing' : ''} ${
            !previewOpen ? 'is-preview-closed' : ''
          }`}
          style={{
            '--inv-preview-w': `${previewWidth}px`
          } as React.CSSProperties}
        >
          <InventoryLedgerPanel
            filteredProducts={filteredProducts}
            activeProduct={activeProduct}
            selectedModel={selectedModel}
            onSelectModel={(modelKey) => {
              setSelectedModel(modelKey);
              setFocusedRollId('');
            }}
            focusedRollId={focusedRollId}
            onFocusRollId={setFocusedRollId}
            viewScope={viewScope}
            displayedRolls={displayedRolls}
            displayedRemnants={displayedRemnants}
            remnantsByRollId={remnantsByRollId}
            rollLookup={rollLookup}
            picked={picked}
            onTogglePick={togglePick}
            onSetPicked={setPicked}
            previewTarget={previewTarget}
            scanHitKey={scanHitKey}
            onInspectRoll={handleInspectRoll}
            onInspectRemnant={handleInspectRemnant}
            onOpenAction={openActionPanel}
            onUseRemnantInWorkbench={(rm) => {
              setCanvasSpec({
                canvasMode: 'REMNANT',
                selectedRemnantId: rm.id,
                canvasWidthMm: rm.width,
                canvasLengthMm: rm.length,
                materialModel2D: rm.materialBatch || activeProduct?.modelKey || 'REMNANT'
              });
              location.hash = '#/workbench';
            }}
          />

          <InventoryPreviewPane
            previewOpen={previewOpen}
            previewWidth={previewWidth}
            draggingRight={draggingRight}
            dragOriginRef={dragOriginRef}
            onSetDraggingRight={setDraggingRight}
            onCommitPreviewWidth={commitPreviewWidth}
            onAnnounceResize={announceResize}
            onClosePreview={() => setPreviewOpen(false)}
            previewRoll={previewRoll}
            previewRemnant={previewRemnant}
            previewScene={previewScene}
            rollSpatialMap={rollSpatialMap}
            rolls={rolls}
            activeProduct={activeProduct}
            rollLayout={rollLayout}
            onSetRollLayout={setRollLayout}
            vertical={vertical}
            onToggleVertical={() => setVertical((v) => !v)}
            tool={tool}
            onToggleTool={() => setTool((t) => (t === 'measure' ? 'pan' : 'measure'))}
            cursor={cursor}
            onCursorMove={setCursor}
            previewCanvasRef={previewCanvasRef}
            onInspectRoll={handleInspectRoll}
            onOpenAction={openActionPanel}
            onZoomToSpan={handleZoomToSpan}
            onZoomToDefect={handleZoomToDefect}
            onSendRollToWorkbench={(roll) => {
              setCanvasSpec({
                canvasMode: 'STOCK_ROLL',
                selectedRollId: roll.rollId,
                canvasWidthMm: roll.width,
                materialModel2D: roll.rollModel
              });
              location.hash = '#/workbench';
            }}
            onSendRemnantToWorkbench={(rem) => {
              setCanvasSpec({
                canvasMode: 'REMNANT',
                selectedRemnantId: rem.id,
                canvasWidthMm: rem.width,
                canvasLengthMm: rem.length,
                materialModel2D: rem.materialBatch || activeProduct?.modelKey || 'REMNANT'
              });
              toast(`已选定在库料头 ${rem.id} (${rem.width}×${rem.length}mm) 进入搭切工作台`);
              location.hash = '#/workbench';
            }}
          />
        </div>
      )}

      <InventoryActionModal
        action={action}
        receiveMode={receiveMode}
        onReceiveModeChange={setReceiveMode}
        auth={auth}
        busy={busy}
        onClose={() => setAction(null)}
        onSubmit={handleSubmitAction}
        onSuccessRefresh={async () => {
          await loadData();
        }}
        productGroups={productGroups}
        rolls={rolls}
        remnants={remnants}
        rollLookup={rollLookup}
        opts={opts}
        selectedMaterials={selectedMaterials}
        blockedMaterials={blockedMaterials}
        getCountRow={getCountRow}
        updateCountRow={updateCountRow}
        rollIdInput={rollIdInput}
        setRollIdInput={setRollIdInput}
        rollModelInput={rollModelInput}
        setRollModelInput={setRollModelInput}
        widthInput={widthInput}
        setWidthInput={setWidthInput}
        lengthInput={lengthInput}
        setLengthInput={setLengthInput}
        batchNoInput={batchNoInput}
        setBatchNoInput={setBatchNoInput}
        colorInput={colorInput}
        setColorInput={setColorInput}
        shrinkageInput={shrinkageInput}
        setShrinkageInput={setShrinkageInput}
        locationInput={locationInput}
        setLocationInput={setLocationInput}
        editRollTarget={editRollTarget}
        releaseRemnantId={releaseRemnantId}
        releaseDecision={releaseDecision}
        setReleaseDecision={setReleaseDecision}
        releaseInspector={releaseInspector}
        setReleaseInspector={setReleaseInspector}
        scrapRollId={scrapRollId}
        scrapId={scrapId}
        destination={destination}
        setDestination={setDestination}
        reason={reason}
        setReason={setReason}
        operator={operator}
        setOperator={setOperator}
      />
    </div>
  );
};
