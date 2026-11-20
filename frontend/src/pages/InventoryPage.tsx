import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestJSON,
  fmtM,
  fmtN,
  toast,
  idempotentPost,
  pendingWrite,
  retryWrite,
  dropWrite,
  createUuid
} from '@static/app/js/util.js';
import { buildRollScene, remnantAsRoll } from '@static/app/js/model/roll-scene.js';
import { workflowTemplate } from '@static/app/js/model/showcase.js';
import { CadCanvasView } from '../components/CadCanvasView';
import { ModalDialog } from '../components/ModalDialog';
import {
  SegmentedControl,
  CodeBadge,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';
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
type InventoryViewScope = 'ALL' | 'ROLLS' | 'REMNANTS';
type InventoryStatusScope = 'ALL' | 'READY' | 'PENDING' | 'HISTORY';

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

  // Filter & Product -> Mother Roll -> Linked Remnant hierarchy state
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [focusedRollId, setFocusedRollId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewScope, setViewScope] = useState<InventoryViewScope>('ALL');
  const [statusScope, setStatusScope] = useState<InventoryStatusScope>('ALL');

  // Right Preview Pane & Resizable Split Layout State
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget>(null);
  const [previewOpen, setPreviewOpen] = useState<boolean>(true);
  const [previewWidth, setPreviewWidth] = useState<number>(() =>
    clampNum(Number(localStorage.getItem('cutplan.inv.rightW')) || 384, 300, 740)
  );
  const [draggingRight, setDraggingRight] = useState<boolean>(false);
  const [liveAnnounce, setLiveAnnounce] = useState<string>('');

  // Preview CAD Canvas options & Mother Roll Spatial Map (Cut Zones + Planned Zones + Defects)
  const [rollLayout, setRollLayout] = useState<RollPreviewLayout>('tile');
  const [vertical, setVertical] = useState<boolean>(true);
  const [tool, setTool] = useState<'pan' | 'measure'>('pan');
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);
  const [rollSpatialMap, setRollSpatialMap] = useState<any | null>(null);

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
      // Support deep-linking via #/inventory?roll=ROLL_ID
      const hashQuery = location.hash.split('?')[1] || '';
      const targetRollParam = new URLSearchParams(hashQuery).get('roll');
      if (targetRollParam && Array.isArray(r)) {
        const hit = r.find((x: any) => x.rollId === targetRollParam);
        if (hit) {
          setSelectedModel(hit.rollModel || hit.materialName || '未分类品号');
          setPreviewTarget({ kind: 'roll', id: hit.rollId });
          setPreviewOpen(true);
        }
      }
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

  const commitPreviewWidth = (next: number) => {
    const containerW = layoutContainerRef.current?.clientWidth || 1200;
    const maxRight = Math.max(320, Math.min(760, containerW - 440));
    const clamped = clampNum(Math.round(next), 300, maxRight);
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
              rollId: 'DEMO-' + createUuid().slice(0, 8)
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

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return productGroups.filter((g) => {
      if (viewScope === 'ROLLS' && g.rolls.length === 0) return false;
      if (viewScope === 'REMNANTS') {
        if (statusScope === 'HISTORY' ? g.remnants.length === 0 : g.availableRemnants.length === 0 && g.remnants.every((rm) => rm.status === 'CONSUMED' || rm.status === 'SCRAPPED')) {
          return false;
        }
      }
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
  }, [productGroups, searchQuery, viewScope, statusScope]);

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

  const displayedRolls = useMemo(() => {
    if (!activeProduct) return [];
    const q = searchQuery.trim().toLowerCase();
    return activeProduct.rolls.filter((r) => {
      if (statusScope === 'READY' && r.inspectionStatus !== 'PASSED') return false;
      if (statusScope === 'PENDING' && r.inspectionStatus === 'PASSED') return false;
      if (q && !productMatchesQuery) {
        return `${r.rollId} ${r.batchNo || ''} ${r.storageLocation || ''}`
          .toLowerCase()
          .includes(q);
      }
      return true;
    });
  }, [activeProduct, statusScope, searchQuery, productMatchesQuery]);

  const displayedRemnants = useMemo(() => {
    if (!activeProduct) return [];
    const q = searchQuery.trim().toLowerCase();
    let list = focusedRollId
      ? activeProduct.remnants.filter((rm) => rm.sourceRollId === focusedRollId)
      : activeProduct.remnants;

    if (statusScope === 'ALL') {
      list = list.filter(
        (rm) =>
          rm.status === 'AVAILABLE' || rm.status === 'RESERVED' || rm.status === 'QUARANTINED'
      );
    } else if (statusScope === 'READY') {
      list = list.filter((rm) => rm.status === 'AVAILABLE');
    } else if (statusScope === 'PENDING') {
      list = list.filter((rm) => rm.status === 'QUARANTINED' || rm.status === 'LOST');
    }

    if (q && !productMatchesQuery) {
      list = list.filter((rm) =>
        `${rm.id} ${rm.sourceRollId || ''} ${rm.location || ''}`.toLowerCase().includes(q)
      );
    }
    return list;
  }, [activeProduct, focusedRollId, statusScope, searchQuery, productMatchesQuery]);

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

  // Load Mother Roll Spatial Map (Cut Zones + Planned Zones + Clean Spans) when previewRoll changes
  useEffect(() => {
    if (!previewRoll?.rollId) {
      setRollSpatialMap(null);
      return;
    }
    let cancelled = false;
    requestJSON('/api/rolls/' + encodeURIComponent(previewRoll.rollId) + '/spatial-map')
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

  const previewScene = useMemo(() => {
    if (previewRoll) {
      const cutZones: any[] = rollSpatialMap?.cutZones || [];
      const plannedZones: any[] = rollSpatialMap?.plannedZones || [];

      const mappedPlans = [
        ...cutZones.map((cz: any) => ({
          id: cz.planId,
          status: 'CONFIRMED',
          version: 1,
          request: {
            rollId: previewRoll.rollId,
            rollW: previewRoll.width,
            rollL: cz.lengthMm,
            windowStartY: cz.startY,
            feedPortType: 'roll',
            cutOrigin: 'left-top'
          },
          result: {
            deductLen: cz.lengthMm,
            pieces: cz.pieces || []
          }
        })),
        ...plannedZones.map((pz: any, i: number) => ({
          id: pz.planId || pz.schemeId || `PZ-${i}`,
          status: 'PENDING',
          version: 1,
          request: {
            rollId: previewRoll.rollId,
            rollW: previewRoll.width,
            rollL: pz.lengthMm,
            windowStartY: pz.startY,
            feedPortType: 'roll',
            cutOrigin: 'left-top'
          },
          result: {
            deductLen: pz.lengthMm,
            pieces: pz.pieces || []
          }
        }))
      ];

      const mappedReports = cutZones.map((cz: any) => ({
        planId: cz.planId,
        status: 'CONFIRMED',
        windowStartY: cz.startY,
        actualCutLen: cz.lengthMm,
        pieceResults: (cz.pieces || []).length
          ? (cz.pieces || []).map((p: any) => ({
              pieceId: p.id,
              demandId: p.demandId,
              name: p.name,
              x: p.x,
              y: p.y,
              w: p.w,
              l: p.l,
              shape: p.shape,
              outcome: 'QUALIFIED'
            }))
          : undefined
      }));

      return buildRollScene({
        roll: previewRoll,
        plans: mappedPlans,
        reports: mappedReports,
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
  }, [previewRoll, previewRemnant, rollSpatialMap]);

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
      {/* Screen-reader live region for splitter resize feedback */}
      <div className="sr-only" aria-live="polite">
        {liveAnnounce}
      </div>

      {/* Light Desktop Page Header & Filter Toolbar */}
      <div className="mp-inv-header">
        <div className="mp-inv-head-row">
          <div className="mp-page-title-block">
            <h1>库存</h1>
            <span className="mp-page-summary num">
              {productGroups.length} 个品号 · {rolls.length} 卷母卷（合格 {passedRollTotal}）·{' '}
              {availableRemnantTotal} 块可用料头
            </span>
          </div>

          <div className="mp-toolbar-actions">
            {!previewOpen && (
              <button
                type="button"
                className="mp-ghost-btn"
                onClick={() => {
                  setPreviewOpen(true);
                  announceResize('右侧实物预览窗格已展开');
                }}
              >
                展开实物预览
              </button>
            )}
            {picked.size > 0 && (
              <button
                type="button"
                className="mp-ghost-btn"
                onClick={() => setPicked(new Set())}
              >
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
              ＋ 登记母卷
            </button>
          </div>
        </div>

        <div className="mp-filter-toolbar mp-inv-filter-row">
          <div className="mp-search-wrap">
            <span className="mp-search-ico" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14">
                <circle
                  cx="7.2"
                  cy="7.2"
                  r="4.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="m10.8 10.8 2.8 2.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <input
              type="search"
              className="mp-search-input"
              aria-label="搜索物料品号、母卷或料头"
              placeholder="搜品号、卷号、批号、库位或料头号"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <span className="mp-toolbar-count num">
            显示 {filteredProducts.length} / {productGroups.length} 品号
          </span>

          <div className="mp-inv-filter-controls">
            <SegmentedControl
              options={viewOptions}
              value={viewScope}
              onChange={(next) => setViewScope(next)}
              ariaLabel="按台账类别筛选"
              size="sm"
            />
            <SegmentedControl
              options={statusOptions}
              value={statusScope}
              onChange={(next) => setStatusScope(next)}
              ariaLabel="按库存状态筛选"
              size="sm"
            />
          </div>
        </div>
      </div>

      {pendings.length > 0 && (
        <div className="mp-inv-notice">
          {pendings.map(([s]) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>{ACTION_TITLES[s]}提交结果未确认</span>
              <button type="button" className="btn sm" onClick={() => handleRetryWrite(s)}>
                重试原操作
              </button>
              <button type="button" className="btn sm" onClick={() => handleDropWrite(s)}>
                放弃
              </button>
            </span>
          ))}
        </div>
      )}

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
          className={`inv-resizable-workspace mp-inv-workspace ${
            draggingRight ? 'is-resizing' : ''
          }`}
          style={{
            gridTemplateColumns: previewOpen
              ? `minmax(420px, 1fr) 10px ${previewWidth}px`
              : 'minmax(0, 1fr)'
          }}
        >
          {/* Left Pure-White 12px Rounded Aggregated Ledger Card */}
          <section className="mp-inv-ledger-card" aria-label="母卷与料头聚合台账">
            {/* Compact Product Model Switcher Strip */}
            <div className="mp-inv-model-bar">
              <span className="mp-inv-model-bar-label">品号</span>
              <div
                className="mp-inv-model-strip"
                role="listbox"
                aria-label="物料品号切换"
              >
                {filteredProducts.length > 0 ? (
                  filteredProducts.map((g) => {
                    const isActive = activeProduct?.modelKey === g.modelKey;
                    return (
                      <button
                        key={g.modelKey}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className="mp-inv-model-pill"
                        onClick={() => {
                          setSelectedModel(g.modelKey);
                          setFocusedRollId('');
                        }}
                      >
                        <span>{g.modelKey}</span>
                        <span className="mp-pill-meta num">
                          {g.rolls.length}卷
                          {g.availableRemnants.length > 0
                            ? ` · ${g.availableRemnants.length}料`
                            : ''}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <span className="mp-inv-section-hint">没有匹配的物料品号</span>
                )}
              </div>
            </div>

            {activeProduct ? (
              <>
                {/* Selected Product Compact Identity & Inline Metrics */}
                <div className="mp-inv-product-strip">
                  <div className="mp-inv-product-identity">
                    <strong>{activeProduct.modelKey}</strong>
                    {activeProduct.primaryWidthMm > 0 && (
                      <CodeBadge>{fmtN(activeProduct.primaryWidthMm)} mm</CodeBadge>
                    )}
                    {activeProduct.materialName && (
                      <span className="mp-inv-product-meta">{activeProduct.materialName}</span>
                    )}
                    {(activeProduct.color || activeProduct.composition) && (
                      <span className="mp-inv-product-meta">
                        {[activeProduct.color, activeProduct.composition]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </div>

                  <div className="mp-inv-metrics-inline num">
                    <div className="mp-inv-metric-item">
                      <span>母卷</span>
                      <b>{activeProduct.rolls.length}</b>
                      <span>卷（合格 {activeProduct.passedRollCount}）</span>
                    </div>
                    <div className="mp-inv-metric-item">
                      <span>总余长</span>
                      <b>{fmtN(activeProduct.totalRemainingM, 2)}</b>
                      <span>m</span>
                    </div>
                    <div className="mp-inv-metric-item">
                      <span>可用料头</span>
                      <b className={activeProduct.availableRemnants.length ? 'is-ok' : ''}>
                        {activeProduct.availableRemnants.length}
                      </b>
                      <span>块 ({fmtN(activeProduct.availableRemnantAreaM2, 2)} m²)</span>
                    </div>
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

                {/* Scrollable Aggregated Tables Body */}
                <div className="mp-inv-ledger-body">
                  {/* Section 1: Mother Rolls */}
                  {viewScope !== 'REMNANTS' && (
                    <div className="mp-inv-section">
                      <div className="mp-inv-section-head">
                        <span>在库母卷（{displayedRolls.length} 卷）</span>
                        <span className="mp-inv-section-hint">
                          点击任意行在右侧预览整卷余量、切割区段与疵点坐标
                        </span>
                      </div>
                      {displayedRolls.length > 0 ? (
                        <div className="mp-table-scroll">
                          <table className="t">
                            <thead>
                              <tr>
                                <th style={{ width: 28 }}>
                                  <input
                                    type="checkbox"
                                    aria-label="全选该品母卷"
                                    checked={
                                      displayedRolls.length > 0 &&
                                      displayedRolls.every((r) => picked.has(idOf(true, r)))
                                    }
                                    onChange={(e) => {
                                      const next = new Set(picked);
                                      displayedRolls.forEach((r) => {
                                        const k = idOf(true, r);
                                        if (e.target.checked) next.add(k);
                                        else next.delete(k);
                                      });
                                      setPicked(next);
                                    }}
                                  />
                                </th>
                                <th>母卷编号 / 批号</th>
                                <th className="r" title="门幅 (mm)">门幅</th>
                                <th className="r">剩余 / 整卷</th>
                                <th>派生料头</th>
                                <th className="r">疵点</th>
                                <th>库位</th>
                                <th>检验</th>
                                <th style={{ textAlign: 'right' }}>操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {displayedRolls.map((r) => {
                                const itemKey = idOf(true, r);
                                const isChecked = picked.has(itemKey);
                                const isPreviewed =
                                  previewTarget?.kind === 'roll' && previewTarget.id === r.rollId;
                                const remLen =
                                  r.currentRemainingLength ??
                                  r.totalLength - (r.usedLength || 0);
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
                                    <td>
                                      <div className="mp-inv-id-cell">
                                        <strong className="num mp-inv-roll-id" title={r.rollId}>
                                          {r.rollId}
                                        </strong>
                                        {r.batchNo && <CodeBadge>{r.batchNo}</CodeBadge>}
                                      </div>
                                    </td>
                                    <td className="r num">{fmtN(r.width)}</td>
                                    <td className="r num">
                                      <div>
                                        <b>{fmtM(remLen)}</b>/{fmtM(r.totalLength)}m
                                      </div>
                                      {(r.usedLength || 0) > 0 && (
                                        <div className="mp-inv-sub-meta">
                                          已切 {fmtM(r.usedLength)}m
                                        </div>
                                      )}
                                    </td>
                                    <td onClick={(e) => e.stopPropagation()}>
                                      {linkedRems.length > 0 ? (
                                        <button
                                          type="button"
                                          className={`mp-inv-remnant-link num ${
                                            focusedRollId === r.rollId ? 'active' : ''
                                          }`}
                                          title={
                                            activeProduct.rolls.length > 1
                                              ? `可用 ${availRems.length} / 共 ${linkedRems.length} 块，点击仅看此母卷派生的料头`
                                              : `可用 ${availRems.length} / 共 ${linkedRems.length} 块，点击预览第一块派生料头`
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
                                          {availRems.length}/{linkedRems.length}块
                                        </button>
                                      ) : (
                                        <span className="muted">无</span>
                                      )}
                                    </td>
                                    <td className="r num">
                                      {r.defectsCount ?? (r.defects || []).length}
                                    </td>
                                    <td>
                                      <span
                                        className="mp-inv-loc-cell"
                                        title={r.storageLocation || '—'}
                                      >
                                        {r.storageLocation || '—'}
                                      </span>
                                    </td>
                                    <td>
                                      <span className={`tag ${qc}`}>{qt}</span>
                                    </td>
                                    <td
                                      style={{ textAlign: 'right' }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="mp-inv-row-actions">
                                        <button
                                          type="button"
                                          className="btn sm soft-accent"
                                          onClick={() => handleInspectRoll(r)}
                                          title="查看该母卷已切割区域、预占区段与疵点空间图"
                                        >
                                          看切割区
                                        </button>
                                        <a
                                          className="btn sm"
                                          href={`#/inspection/${encodeURIComponent(r.rollId)}`}
                                        >
                                          跑疵点
                                        </a>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="mp-empty-inline">当前筛选条件下暂无整卷母卷记录</div>
                      )}
                    </div>
                  )}

                  {/* Section 2: Linked Remnants */}
                  {viewScope !== 'ROLLS' && (
                    <div className="mp-inv-section">
                      <div className="mp-inv-section-head">
                        <span>关联派生料头（{displayedRemnants.length} 块）</span>
                        {focusedRollId && (
                          <span className="tag run">
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
                        <span className="mp-inv-section-hint">
                          点击料头行在右侧预览单块实尺与疵点
                        </span>
                      </div>

                      {displayedRemnants.length > 0 ? (
                        <div className="mp-table-scroll">
                          <table className="t">
                            <thead>
                              <tr>
                                <th style={{ width: 28 }}>
                                  <input
                                    type="checkbox"
                                    aria-label="全选当前列表料头"
                                    checked={
                                      displayedRemnants.length > 0 &&
                                      displayedRemnants.every((rm) =>
                                        picked.has(idOf(false, rm))
                                      )
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
                                <th>来源母卷 · 谱系</th>
                                <th className="r" title="宽 × 长 (mm)">宽×长 mm</th>
                                <th className="r" title="面积 (m²)">面积 m²</th>
                                <th>疵点</th>
                                <th>状态</th>
                                <th style={{ textAlign: 'right' }}>操作</th>
                              </tr>
                            </thead>
                            <tbody>
                              {displayedRemnants.map((rm) => {
                                const itemKey = idOf(false, rm);
                                const isChecked = picked.has(itemKey);
                                const isPreviewed =
                                  previewTarget?.kind === 'remnant' &&
                                  previewTarget.id === rm.id;
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
                                    <td>
                                      <CodeBadge className="mp-inv-rem-id" title={rm.id}>
                                        {rm.id}
                                      </CodeBadge>
                                    </td>
                                    <td>
                                      <div className="mp-inv-lineage-cell">
                                        <span
                                          className="num muted mp-inv-source-id"
                                          title={rm.sourceRollId || '—'}
                                        >
                                          {rm.sourceRollId || '—'}
                                        </span>
                                        {rm.generation ? (
                                          <CodeBadge>G{rm.generation}</CodeBadge>
                                        ) : null}
                                        {rm.qualityDispositionId && (
                                          <span className="tag warn">复检回收</span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="r num">
                                      {fmtN(rm.width)}×{fmtN(rm.length)}
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
                                    <td
                                      style={{ textAlign: 'right' }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="mp-inv-row-actions">
                                        {rm.status === 'AVAILABLE' && (
                                          <button
                                            type="button"
                                            className="btn sm soft-accent"
                                            onClick={() => {
                                              setCanvasSpec({
                                                canvasMode: 'REMNANT',
                                                selectedRemnantId: rm.id,
                                                canvasWidthMm: rm.width,
                                                canvasLengthMm: rm.length,
                                                materialModel2D:
                                                  rm.materialBatch ||
                                                  activeProduct?.modelKey ||
                                                  'REMNANT'
                                              });
                                              location.hash = '#/workbench';
                                            }}
                                          >
                                            排料
                                          </button>
                                        )}
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
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="mp-empty-inline">暂无符合当前筛选条件的料头</div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="mp-empty-inline" style={{ padding: 44 }}>
                <strong>暂无匹配的物料品号</strong>
                请调整顶部搜索词或切换台账筛选条件，或登记新的在库母卷。
              </div>
            )}
          </section>

          {/* Resizer Handle + Right Dark Charcoal 12px CAD Preview Card */}
          {previewOpen && (
            <>
              <button
                type="button"
                className={`inv-split-handle mp-inv-splitter ${
                  draggingRight ? 'dragging' : ''
                }`}
                aria-label="左右拖动或按左右方向键调节右侧实物预览区宽度"
                title="左右拖动调节预览区宽度（双击切换标准/宽屏，或按方向键）"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragOriginRef.current = { startX: e.clientX, startW: previewWidth };
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDraggingRight(true);
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  commitPreviewWidth(
                    dragOriginRef.current.startW + (dragOriginRef.current.startX - e.clientX)
                  );
                }}
                onLostPointerCapture={() => setDraggingRight(false)}
                onDoubleClick={() => {
                  const next = previewWidth < 480 ? 560 : 384;
                  commitPreviewWidth(next);
                  announceResize(next > 480 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度');
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
                    commitPreviewWidth(384);
                    announceResize('预览区已恢复标准宽度');
                  }
                }}
              />

              <aside
                className="inv-preview-pane mp-inv-preview-card"
                aria-label="实物几何与疵点预览"
              >
                <div className="mp-inv-preview-head">
                  {previewRoll ? (
                    <>
                      <span className="mp-dark-pill-tag roll">母卷预览</span>
                      <strong className="num inv-preview-id">{previewRoll.rollId}</strong>
                    </>
                  ) : previewRemnant ? (
                    <>
                      <span className="mp-dark-pill-tag remnant">料头预览</span>
                      <strong className="num inv-preview-id">{previewRemnant.id}</strong>
                    </>
                  ) : (
                    <span>实物几何预览</span>
                  )}
                  <span className="sp" />
                  {previewRoll && previewRoll.inspectionStatus === 'PASSED' && (
                    <button
                      type="button"
                      className="mp-dark-btn accent"
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
                      className="mp-dark-btn accent"
                      onClick={() => {
                        setCanvasSpec({
                          canvasMode: 'REMNANT',
                          selectedRemnantId: previewRemnant.id,
                          canvasWidthMm: previewRemnant.width,
                          canvasLengthMm: previewRemnant.length,
                          materialModel2D:
                            previewRemnant.materialBatch ||
                            activeProduct?.modelKey ||
                            'REMNANT'
                        });
                        toast(
                          `已选定在库料头 ${previewRemnant.id} (${previewRemnant.width}×${previewRemnant.length}mm) 进入搭切工作台`
                        );
                        location.hash = '#/workbench';
                      }}
                    >
                      去排料 →
                    </button>
                  )}
                  <button
                    type="button"
                    className="mp-dark-btn"
                    title="在标准宽度与加宽预览之间切换"
                    onClick={() => {
                      const next = previewWidth < 480 ? 560 : 384;
                      commitPreviewWidth(next);
                      announceResize(
                        next > 480 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度'
                      );
                    }}
                  >
                    {previewWidth < 480 ? '加宽' : '标准'}
                  </button>
                  <button
                    type="button"
                    className="mp-dark-btn"
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

                      {(previewRoll?.defects || previewRemnant?.defects || []).length > 0 && (
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
                              定位疵点 (
                              {(previewRoll?.defects || previewRemnant?.defects || []).length})…
                            </option>
                            {(previewRoll?.defects || previewRemnant?.defects || []).map(
                              (d: any, idx: number) => (
                                <option key={d.id || idx} value={idx}>
                                  #{idx + 1} {d.typeName || d.defectType} · Y{' '}
                                  {previewRoll
                                    ? `${(d.y / 1000).toFixed(2)}m`
                                    : `${fmtN(d.y)}mm`}
                                </option>
                              )
                            )}
                          </select>
                        </>
                      )}
                    </div>

                    {/* Mother Roll Spatial Cut-Zone & Planned-Zone Strip */}
                    {previewRoll && rollSpatialMap && (
                      <div className="roll-spatial-panel">
                        <div className="roll-spatial-legend num">
                          <span className="spatial-dot cut" />
                          <span>
                            已切割{' '}
                            <b>
                              {fmtM(
                                (rollSpatialMap.cutZones || []).reduce(
                                  (s: number, z: any) => s + (z.lengthMm || 0),
                                  0
                                ) ||
                                  previewRoll.usedLength ||
                                  0
                              )}
                              m
                            </b>
                          </span>
                          <span className="spatial-dot planned" />
                          <span>
                            排程预占{' '}
                            <b>{fmtM(rollSpatialMap.summary?.plannedLengthMm || 0)}m</b>
                          </span>
                          <span className="spatial-dot clean" />
                          <span>
                            净可排余量{' '}
                            <b>{fmtM(rollSpatialMap.summary?.netAvailableToPlanMm || 0)}m</b>
                          </span>
                          <span className="spatial-dot defect" />
                          <span>疵点 {(previewRoll.defects || []).length} 处</span>
                        </div>

                        <div
                          className="roll-spatial-bar"
                          role="group"
                          aria-label="母卷全长切割与预占空间分布条"
                        >
                          {(rollSpatialMap.cutZones || []).map((cz: any, idx: number) => {
                            const total = Math.max(1, previewRoll.totalLength);
                            const leftPct = (cz.startY / total) * 100;
                            const widthPct = Math.max(1.2, (cz.lengthMm / total) * 100);
                            return (
                              <button
                                key={`cz-${idx}`}
                                type="button"
                                className="spatial-seg cut"
                                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                                title={`已切割区域：${cz.title} (${fmtM(cz.startY)}m ~ ${fmtM(cz.endY)}m)`}
                                onClick={() =>
                                  handleZoomToSpan(cz.startY, cz.endY, previewRoll.width)
                                }
                              >
                                {widthPct >= 14 ? '已切' : ''}
                              </button>
                            );
                          })}
                          {(rollSpatialMap.plannedZones || []).map((pz: any, idx: number) => {
                            const total = Math.max(1, previewRoll.totalLength);
                            const leftPct = (pz.startY / total) * 100;
                            const widthPct = Math.max(1.2, (pz.lengthMm / total) * 100);
                            return (
                              <button
                                key={`pz-${idx}`}
                                type="button"
                                className="spatial-seg planned"
                                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                                title={`排程预占：${pz.title} (${fmtM(pz.startY)}m ~ ${fmtM(pz.endY)}m)`}
                                onClick={() =>
                                  handleZoomToSpan(pz.startY, pz.endY, previewRoll.width)
                                }
                              >
                                {widthPct >= 14 ? '预占' : ''}
                              </button>
                            );
                          })}
                          {(previewRoll.defects || []).map((d: any, idx: number) => {
                            const total = Math.max(1, previewRoll.totalLength);
                            const leftPct = Math.min(99, (d.y / total) * 100);
                            return (
                              <i
                                key={`df-${idx}`}
                                className="spatial-defect-tick"
                                style={{ left: `${leftPct}%` }}
                                title={`疵点 #${idx + 1}: ${d.typeName || d.defectType} (Y=${fmtM(d.y)}m)`}
                                onClick={() => handleZoomToDefect(d, previewRoll.width)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}

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
                      {cursor
                        ? ` · X=${fmtN(cursor.v, 0)} / Y=${fmtN(cursor.u, 0)} mm`
                        : ''}
                    </div>
                  </div>
                ) : (
                  <div className="mp-inv-preview-empty">
                    点击左侧任意母卷或料头行，即可在此预览实物几何尺寸与疵点坐标
                  </div>
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
            <div className="mp-table-scroll" style={{ marginBottom: 12 }}>
              <table className="t">
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
            </div>

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
