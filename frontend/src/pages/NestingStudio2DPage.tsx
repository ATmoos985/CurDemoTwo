import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandItem,
  SavedScheme2D
} from '../store/useStudioStore';
import { CadCanvasView } from '../components/CadCanvasView';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  buildSafeNestingRequest2D,
  unpadGuillotineResult
} from '@static/js/business/optimization/nesting-request-adapter.js';
import { showcaseScene } from '@static/app/js/model/showcase.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '@static/js/plugins/export/cam-format.js';
import { requestJSON, toast, fmtN } from '@static/app/js/util.js';

interface SolverStrategyDef {
  id: string;
  name: string;
  shortTag: string;
  badge: string;
  description: string;
  halfTurn: boolean;
  forceRotateRect?: boolean;
  shorten: boolean;
  gapFill: boolean;
  enginePref: 'auto' | 'java' | 'deepnest';
  timeLimit: number;
}

const STRATEGIES_2D: SolverStrategyDef[] = [
  {
    id: 'SHORTEN_FIXED',
    name: '严格经向齐套缩长',
    shortTag: '0° 保丝缕 · 二分缩长压紧',
    badge: 'C++ 原生',
    description: '保持全部裁片严格 0° 丝缕方向，7 轮二分缩短并压紧唛架长度（或矩形最优直刀）',
    halfTurn: false,
    forceRotateRect: false,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'SHORTEN_HALF_TURN',
    name: '180° 倒顺对排缩长',
    shortTag: '异形 180° / 矩形 90° · 追求最短版长',
    badge: 'C++ 原生',
    description: '异形片允许 180° 倒顺对排、矩形允许 90° 旋转，追求最短长度与最低单耗',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'DEEPNEST_NFP_GA',
    name: 'Deepnest NFP+GA 进化排料',
    shortTag: 'Minkowski 凹凸嵌套 · 遗传算法共边寻优',
    badge: 'NFP+GA',
    description: '使用迁移自 Deepnest 的 Minkowski 临界多边形卷积 + 遗传算法进化搜索与共边奖励',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 8
  },
  {
    id: 'SHORTEN_GAP_FILL',
    name: '齐套缩长 + 空隙补片',
    shortTag: '主片齐套后自动填入小件备片提利用率',
    badge: '智能补片',
    description: '在齐套唛架空隙内自动加排同款小件备片，最大化整床幅面利用率',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: true,
    enginePref: 'auto',
    timeLimit: 12
  },
  {
    id: 'DEEPNEST_FIXED_GRAIN',
    name: 'Deepnest 严格经向直排',
    shortTag: '0° 固定丝缕 · NFP 精确凹凸贴合',
    badge: 'NFP 经向',
    description: '保持 0° 丝缕方向，采用 Deepnest NFP 精确凹凸嵌套与多代遗传进化直排对照',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'deepnest',
    timeLimit: 5
  },
  {
    id: 'JAVA_HEURISTIC',
    name: '天际线快速启发式',
    shortTag: '毫秒级快速基线对照',
    badge: 'Java 内置',
    description: '独立线程并行运行 Java 天际线快速启发式引擎，作多策略交叉对照',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'java',
    timeLimit: 5
  },
  {
    id: 'DIRECT_FIXED_WINDOW',
    name: '定长台板单次直排',
    shortTag: '按当前设定版长上限单次装入检验',
    badge: '定长直排',
    description: '按上方预设幅宽 × 长度整床一次直排，快速查看固定台板装入量',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 4
  }
];

export const NestingStudio2DPage: React.FC<{ taskId?: string }> = ({ taskId }) => {
  const {
    clusters,
    clusterSelections,
    setClusterCount,
    importDxfAsCluster,
    loadClusterInto2D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    materialModel2D,
    loadedTaskName,
    activeDemands2D,
    selectedStrategies2D,
    strategyRuns2D,
    schemes2D,
    activeSchemeId2D,
    settings,
    setCanvasSpec,
    setActiveDemands2D,
    updateDemand2D,
    removeDemand2D,
    addBlankDemand2D,
    toggleStrategy2D,
    setStrategyRuns2D,
    addSchemes2D,
    removeScheme2D,
    clearSchemes2D,
    setActiveScheme2D,
    markSchemeDispatched
  } = useStudioStore();

  const [rolls, setRolls] = useState<any[]>([]);
  const [workerCount, setWorkerCount] = useState<number>(6);
  const [vertical, setVertical] = useState(true);
  const [showPath, setShowPath] = useState(false);
  const [showDimensions, setShowDimensions] = useState(true);
  const [tool, setTool] = useState<'pan' | 'measure'>('pan');
  const [cursor, setCursor] = useState<{ u: number; v: number } | null>(null);
  const [inspectedText, setInspectedText] = useState<string>(
    '滚轮缩放 · 拖动画布平移 · 右键查看单件坐标与外接尺寸'
  );
  const [runningParallel, setRunningParallel] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');

  const canvasInstanceRef = useRef<any>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const activeSessionsRef = useRef<OptimizationSession[]>([]);

  useEffect(() => {
    requestJSON('/api/rolls').then((r) => setRolls(r || [])).catch(() => {});
    requestJSON('/api/v2/capabilities')
      .then((c) => {
        if (c?.limits?.workers) setWorkerCount(c.limits.workers);
      })
      .catch(() => {});
    return () => {
      activeSessionsRef.current.forEach((s) => s.cancel());
    };
  }, []);

  // Roving tabindex fallback for role="toolbar" when native focusgroup is unsupported
  useEffect(() => {
    const bar = toolbarRef.current;
    if (!bar || 'focusGroup' in HTMLElement.prototype) return;

    const getItems = () =>
      Array.from(bar.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));

    const initItems = getItems();
    initItems.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });

    const onFocusIn = (e: FocusEvent) => {
      const items = getItems();
      const target = e.target as HTMLButtonElement;
      if (items.includes(target)) {
        items.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const items = getItems();
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      if (idx < 0 || !items.length) return;
      const rtl = getComputedStyle(bar).direction === 'rtl';
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + (rtl ? -1 : 1) + items.length) % items.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx + (rtl ? 1 : -1) + items.length) % items.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = items.length - 1;

      if (nextIdx >= 0) {
        e.preventDefault();
        items[nextIdx].focus();
      }
    };

    bar.addEventListener('focusin', onFocusIn);
    bar.addEventListener('keydown', onKeyDown);
    return () => {
      bar.removeEventListener('focusin', onFocusIn);
      bar.removeEventListener('keydown', onKeyDown);
    };
  }, [tool]);

  // Load task demands + latest plan if navigated via #/workbench/:taskId
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    (async () => {
      try {
        const [detail, plans] = await Promise.all([
          requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId)),
          requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId) + '/plans')
        ]);
        if (cancelled || !detail?.task) return;
        const t = detail.task;
        const items: DemandItem[] = (t.demands || []).map((d: any) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          length: d.length,
          quantity: d.quantity,
          allowRotation: Boolean(d.allowRotation),
          shape: d.shape,
          clusterName: t.name
        }));
        const latestPlan = plans?.[plans.length - 1];
        setCanvasSpec({
          loadedTaskId: t.id,
          loadedTaskName: t.name,
          materialModel2D: t.materialModel || 'CUSTOM',
          canvasWidthMm: latestPlan?.request?.rollW || canvasWidthMm,
          canvasLengthMm: t.process?.bedLength || canvasLengthMm,
          pieceGapMm: t.process?.pieceGap || 0,
          trimStartMm: t.process?.trimStart || 0,
          ...(latestPlan?.request?.rollId
            ? { canvasMode: 'STOCK_ROLL', selectedRollId: latestPlan.request.rollId }
            : {})
        });
        setActiveDemands2D(items);

        if (latestPlan?.result?.pieces?.length) {
          const r = latestPlan.result;
          const builtPlan = buildSafeNestingRequest2D({
            strategy: STRATEGIES_2D[0],
            scenario: 'SHORTEN_KIT',
            widthMm: latestPlan.request?.rollW || canvasWidthMm,
            lengthMm: latestPlan.request?.rollL || t.process?.bedLength || 2000,
            pieceGapMm: t.process?.pieceGap || 0,
            trimStartMm: t.process?.trimStart || 0,
            demands: items,
            settings
          });
          const reqObj = builtPlan.request || {
            schemaVersion: '2.0',
            problemType: 'NESTING_2D',
            problem: {
              schemaVersion: '1',
              unit: 'mm',
              material: {
                id: `CANVAS-${latestPlan.request?.rollW || canvasWidthMm}x${latestPlan.request?.rollL || 2000}`,
                shape: rectangle(latestPlan.request?.rollW || canvasWidthMm, latestPlan.request?.rollL || 2000),
                exclusions: []
              },
              parts: [],
              process: { mode: 'GUILLOTINE', startCorner: 'left-top', trimStart: 0 }
            }
          };
          const layout = {
            schemaVersion: '1',
            unit: 'mm',
            coordinateSystem: 'source-local-top-left',
            materialId: reqObj.problem.material.id,
            processingRegion: reqObj.problem.material.shape,
            status: 'FEASIBLE',
            placements: r.pieces.map((p: any) => ({
              id: p.id,
              demandId: p.demandId,
              name: p.name,
              x: p.x,
              y: p.y,
              rotationDegrees: p.rotationDegrees || 0,
              shape: p.shape || rectangle(p.w, p.l)
            })),
            leftovers: (r.remnants || []).map((rm: any, i: number) => ({
              id: i + 1,
              x: rm.x,
              y: rm.y,
              shape: rectangle(rm.w, rm.l),
              hasDefect: Boolean(rm.hasDefect)
            })),
            cuts: (r.cuts || []).map((c: any) => ({
              sequence: c.step,
              kind:
                c.type === '横切' ? 'HORIZONTAL' : c.type === '纵切' ? 'VERTICAL' : 'CONTOUR',
              startX: c.startX,
              startY: c.startY,
              endX: c.endX,
              endY: c.endY
            }))
          };
          const occupiedLengthMm =
            r.deductLen ||
            Math.max(...r.pieces.map((p: any) => p.y + (p.shape?.height || p.l)));
          const pieceAreaM2 = Number((r.pieceArea || 0).toFixed(3));
          const util =
            r.totalArea > 0 ? Number(((r.pieceArea / r.totalArea) * 100).toFixed(2)) : 0;
          addSchemes2D([
            {
              id: 'TASK-PLAN-' + latestPlan.id.slice(0, 8),
              title: `已存方案 (${latestPlan.request?.rollW}×${Math.round(occupiedLengthMm)}mm)`,
              strategyName: r.engine || '已求解历史方案',
              createdAt: String(latestPlan.createdAt || '').slice(11, 19) || '已载入',
              canvasMode: latestPlan.request?.rollId ? 'STOCK_ROLL' : 'FREE_CANVAS',
              rollId: latestPlan.request?.rollId,
              materialModel: t.materialModel,
              widthMm: latestPlan.request?.rollW || canvasWidthMm,
              canvasLengthMm: latestPlan.request?.rollL || 2000,
              occupiedLengthMm: Math.round(occupiedLengthMm * 10) / 10,
              utilizationPct: util,
              pieceAreaM2,
              placedCount: r.pieces.length,
              requestedCount: items.reduce((s, d) => s + d.quantity, 0),
              complete: r.pieces.length >= items.reduce((s, d) => s + d.quantity, 0),
              demands: items,
              request: reqObj,
              result: {
                fulfillmentStatus: 'COMPLETE',
                meetsRequirement: true,
                layout,
                marker: { occupiedLengthMm, trials: [] }
              },
              dispatchedTaskId: t.id
            }
          ]);
        }
      } catch (e: any) {
        toast('加载任务失败：' + e.message, true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const currentRoll = useMemo(
    () => rolls.find((r) => r.rollId === selectedRollId) || null,
    [rolls, selectedRollId]
  );

  const activeScheme = useMemo(
    () => schemes2D.find((s) => s.id === activeSchemeId2D) || null,
    [schemes2D, activeSchemeId2D]
  );

  const currentScene = useMemo(() => {
    const projectScene = showcaseScene as any;
    if (activeScheme?.request && activeScheme?.result) {
      return projectScene(activeScheme.request, activeScheme.result, 0, {
        occupiedLengthMm: activeScheme.occupiedLengthMm,
        gapFillPlacements: activeScheme.result?.marker?.gapFillPlacements
      });
    }
    const previewBuilt = buildSafeNestingRequest2D({
      strategy: STRATEGIES_2D[6],
      scenario: 'FIXED_BED',
      widthMm: canvasWidthMm,
      lengthMm: canvasLengthMm,
      pieceGapMm,
      trimStartMm,
      demands: activeDemands2D,
      defects: canvasMode === 'STOCK_ROLL' && currentRoll ? currentRoll.defects || [] : [],
      settings
    });
    const previewReq = previewBuilt.request || {
      schemaVersion: '2.0',
      problemType: 'NESTING_2D',
      problem: {
        schemaVersion: '1',
        unit: 'mm',
        material: {
          id: `CANVAS-${canvasWidthMm}x${canvasLengthMm}`,
          shape: rectangle(canvasWidthMm, canvasLengthMm),
          exclusions: []
        },
        parts: [],
        process: { mode: 'GUILLOTINE', startCorner: 'left-top', trimStart: 0 }
      }
    };
    return projectScene(previewReq, null);
  }, [
    activeScheme,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    activeDemands2D,
    canvasMode,
    currentRoll,
    settings
  ]);

  const handleQuickDxfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (!text.includes('Piece Name:') || text.includes('\uFFFD')) {
        try {
          text = new TextDecoder('gb18030').decode(buf);
        } catch {}
      }
      const created = importDxfAsCluster(text, file.name);
      setActiveClusterQuickId(created.id);
      loadClusterInto2D(created.id, false);
      toast(`已导入 CAD 纸样「${created.name}」（${created.pieces.length} 种裁片）`);
    } catch (err: any) {
      toast('DXF 导入失败：' + err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  const handleRunParallelStrategies = async () => {
    if (runningParallel) return;
    const validDemands = activeDemands2D.filter(
      (d) => d.quantity > 0 && d.width > 0 && d.length > 0
    );
    if (!validDemands.length) {
      toast('请先载入样板簇或添加至少一项有效裁片需求', true);
      return;
    }
    const badWidth = validDemands.find((d) => d.width > canvasWidthMm && !d.allowRotation);
    if (badWidth) {
      toast(
        `裁片「${badWidth.name}」宽度 (${badWidth.width}mm) 超过当前门幅 (${canvasWidthMm}mm)`,
        true
      );
      return;
    }

    const chosenDefs = STRATEGIES_2D.filter((s) => selectedStrategies2D.includes(s.id));
    if (!chosenDefs.length) {
      toast('请在右侧至少勾选一种求解引擎策略', true);
      return;
    }

    setRunningParallel(true);
    activeSessionsRef.current.forEach((s) => s.cancel());
    activeSessionsRef.current = [];

    const totalRequested = validDemands.reduce((s, d) => s + d.quantity, 0);
    setStrategyRuns2D(
      chosenDefs.map((def) => ({
        strategyId: def.id,
        strategyName: def.name,
        description: def.description,
        state: 'QUEUED',
        phaseText: '排队提交…',
        requestedCount: totalRequested
      }))
    );

    const defects =
      canvasMode === 'STOCK_ROLL' && currentRoll
        ? (currentRoll.defects || []).filter((d: any) => d.y < canvasLengthMm)
        : [];

    const createdSchemes: SavedScheme2D[] = [];
    const failureMessages: string[] = [];

    await Promise.all(
      chosenDefs.map(async (def) => {
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const built = buildSafeNestingRequest2D({
          strategy: def,
          scenario: def.shorten ? (def.gapFill ? 'SHORTEN_GAP_FILL' : 'SHORTEN_KIT') : 'FIXED_BED',
          widthMm: canvasWidthMm,
          lengthMm: canvasLengthMm,
          pieceGapMm,
          trimStartMm,
          demands: validDemands,
          defects,
          settings
        });
        if (built.error || !built.request) {
          const msg = built.error || '请求参数无效';
          failureMessages.push(`${def.name}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === def.id ? { ...r, state: 'FAILED', phaseText: msg } : r
            )
          );
          return;
        }
        const req = built.request;
        const t0 = performance.now();
        try {
          const { job, result: rawResult } = await (session as any).solve(req, {
            onProgress: (j: any) => {
              setStrategyRuns2D((prev) =>
                prev.map((r) =>
                  r.strategyId === def.id
                    ? {
                        ...r,
                        jobId: j.id,
                        state: j.state === 'QUEUED' ? 'QUEUED' : 'RUNNING',
                        phaseText: j.message || j.phase || '计算中…'
                      }
                    : r
                )
              );
            }
          });
          const result = unpadGuillotineResult(rawResult, built);
          const elapsedMs = Math.round(performance.now() - t0);
          const layout = result?.layout;
          const placements = layout?.placements || [];
          const gapFills = result?.marker?.gapFillPlacements || [];
          const occupiedLengthMm =
            result?.marker?.occupiedLengthMm ||
            (placements.length
              ? Math.max(...placements.map((p: any) => p.y + p.shape.height))
              : canvasLengthMm);
          const netAreaMm2 = [...placements, ...gapFills].reduce(
            (s: number, p: any) => s + shapeArea(p.shape),
            0
          );
          const denomAreaMm2 = canvasWidthMm * Math.max(1, occupiedLengthMm);
          const utilizationPct = Number(((netAreaMm2 / denomAreaMm2) * 100).toFixed(2));
          const complete = result?.fulfillmentStatus === 'COMPLETE';
          const fallbackHint = layout?.fallbackReason ? ' · 已降级' : '';

          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === def.id
                ? {
                    ...r,
                    jobId: job.id,
                    state: job.state as any,
                    phaseText: complete
                      ? `齐套 · ${fmtN(occupiedLengthMm, 1)}mm · ${utilizationPct}%${fallbackHint}`
                      : `已排 ${placements.length}/${totalRequested} · ${utilizationPct}%${fallbackHint}`,
                    elapsedMs,
                    occupiedLengthMm,
                    utilizationPct,
                    placedCount: placements.length,
                    requestedCount: totalRequested,
                    complete,
                    request: req,
                    result
                  }
                : r
            )
          );

          if (placements.length > 0) {
            const schemeId = `SCH-${def.id}-${Date.now().toString(36).slice(-4)}`;
            createdSchemes.push({
              id: schemeId,
              title: `${def.name} (${canvasWidthMm}×${Math.round(occupiedLengthMm)}mm)`,
              strategyName: def.name,
              createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              canvasMode,
              rollId: canvasMode === 'STOCK_ROLL' ? selectedRollId : undefined,
              materialModel: materialModel2D || `CANVAS-${canvasWidthMm}`,
              widthMm: canvasWidthMm,
              canvasLengthMm,
              occupiedLengthMm: Math.round(occupiedLengthMm * 10) / 10,
              utilizationPct,
              pieceAreaM2: Number((netAreaMm2 / 1_000_000).toFixed(3)),
              placedCount: placements.length + gapFills.length,
              requestedCount: totalRequested,
              complete,
              demands: structuredClone(validDemands),
              request: req,
              result
            });
          } else {
            failureMessages.push(`${def.name}：${layout?.message || '未排入任何裁片'}`);
          }
        } catch (err: any) {
          const msg = err?.message || '求解未完成';
          if (err?.name !== 'AbortError') failureMessages.push(`${def.name}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === def.id
                ? {
                    ...r,
                    state: err.name === 'AbortError' ? 'CANCELLED' : 'FAILED',
                    phaseText: msg
                  }
                : r
            )
          );
        }
      })
    );

    if (createdSchemes.length > 0) {
      addSchemes2D(createdSchemes);
      toast(`并行求解完成：生成 ${createdSchemes.length} 套候选排料方案`);
    } else if (failureMessages.length > 0) {
      toast(`求解未生成方案：${failureMessages[0]}`, true);
    }
    setRunningParallel(false);
  };

  const handleStopParallel = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningParallel(false);
    toast('已停止并行计算');
  };

  const handleExportCam = (kind: 'dxf' | 'nc') => {
    if (!activeScheme?.result?.layout) return;
    const layout = activeScheme.result.layout;
    const placements = [
      ...(layout.placements || []),
      ...(activeScheme.result?.marker?.gapFillPlacements || [])
    ];
    const data = {
      rollId: activeScheme.rollId || 'FREE-CANVAS',
      rollW: activeScheme.widthMm,
      bedL: activeScheme.occupiedLengthMm,
      windowStartY: 0,
      cutOrigin: 'left-top',
      pieces: placements.map((p: any) => ({
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        w: p.shape.width,
        l: p.shape.height,
        shape: p.shape
      })),
      remnants: layout.leftovers || [],
      defects: [],
      cuts: (layout.cuts || []).map((c: any) => ({
        step: c.sequence,
        type: c.kind === 'HORIZONTAL' ? '横切' : '纵切',
        startX: c.startX,
        startY: c.startY,
        endX: c.endX,
        endY: c.endY
      }))
    };
    const content = kind === 'nc' ? gcodeText(data) : dxfText(data);
    const blob = new Blob([content], {
      type: kind === 'nc' ? 'text/plain;charset=utf-8' : 'application/dxf'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `CutPlan-${activeScheme.widthMm}x${Math.round(activeScheme.occupiedLengthMm)}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const handleDispatchSchemeToExecution = async () => {
    if (!activeScheme || dispatching) return;
    if (activeScheme.dispatchedTaskId) {
      location.hash = `#/execution/${encodeURIComponent(activeScheme.dispatchedTaskId)}`;
      return;
    }
    setDispatching(true);
    try {
      const modelName = activeScheme.materialModel || `STUDIO-${activeScheme.widthMm}`;
      const allRolls: any[] = await requestJSON('/api/rolls');
      const targetRoll =
        (activeScheme.rollId
          ? allRolls.find((r) => r.rollId === activeScheme.rollId)
          : null) ||
        allRolls.find(
          (r) =>
            r.inspectionStatus === 'PASSED' &&
            r.rollModel === modelName &&
            Math.abs(r.width - activeScheme.widthMm) < 1 &&
            (r.currentRemainingLength ?? r.totalLength) >= activeScheme.occupiedLengthMm
        ) ||
        allRolls.find(
          (r) =>
            r.inspectionStatus === 'PASSED' &&
            Math.abs(r.width - activeScheme.widthMm) < 1 &&
            (r.currentRemainingLength ?? r.totalLength) >= activeScheme.occupiedLengthMm
        );

      const reqParts: any[] = activeScheme.request?.problem?.parts || [];
      const allowRotAny = reqParts.some((p) => p.allowRotation || p.allowHalfTurn);
      const bedL = Math.max(500, Math.ceil(activeScheme.occupiedLengthMm + trimStartMm));

      const task = await requestJSON('/api/cutting/tasks', {
        revision: 0,
        name: `选定方案移交 · ${activeScheme.title}`,
        materialModel: targetRoll?.rollModel || modelName,
        externalRef: `${activeScheme.strategyName} · 利用率 ${activeScheme.utilizationPct}%`,
        process: {
          bedLength: bedL,
          trimStart: trimStartMm,
          pieceGap: pieceGapMm,
          cutOrigin: 'left-top',
          firstStageOrientation: 'horizontal',
          allowRotation: allowRotAny,
          allowLongitudinal: true
        },
        demands: activeScheme.demands.map((d, idx) => {
          const rp = reqParts[idx];
          return {
            id: idx + 1,
            name: d.name,
            width: d.width,
            length: d.length,
            quantity: d.quantity,
            allowRotation: Boolean(d.allowRotation || rp?.allowRotation || rp?.allowHalfTurn),
            ...(d.shape ? { shape: d.shape } : {})
          };
        })
      });

      try {
        localStorage.setItem('cutplan.app.2d.scheme.' + task.id, JSON.stringify(activeScheme));
      } catch {}

      if (targetRoll) {
        const startY = targetRoll.usedLength || 0;
        const winDefects = (targetRoll.defects || []).filter(
          (d: any) => d.y < startY + bedL && d.y + d.h > startY
        );
        await requestJSON('/api/solve', {
          minRemnantWidth: 200,
          minRemnantLength: 300,
          timeLimitSeconds: Math.min(10, activeScheme.request?.problem?.timeLimitSeconds || 6),
          taskId: task.id,
          taskRevision: task.revision,
          rollId: targetRoll.rollId,
          rollModel: targetRoll.rollModel,
          rollW: targetRoll.width,
          rollL: bedL,
          totalRollL: targetRoll.totalLength,
          windowStartY: startY,
          trimStart: trimStartMm,
          pieceGap: pieceGapMm,
          cutOrigin: 'left-top',
          firstStageOrientation: 'horizontal',
          allowRotation: allowRotAny,
          allowLongitudinal: true,
          feedPortType: 'roll',
          sourceRemnantId: null,
          solver:
            activeScheme.request?.problem?.engine === 'javaguillotine' ||
            activeScheme.request?.problem?.engine === 'javairregular' ||
            activeScheme.request?.problem?.engine === 'deepnest'
              ? activeScheme.request.problem.engine
              : 'packingsolver',
          defects: winDefects,
          demands: task.demands.map((d: any) => ({
            id: d.id,
            name: d.name,
            width: d.width,
            length: d.length,
            shape: d.shape ?? null,
            allowRotation: Boolean(d.allowRotation),
            demand: d.quantity
          }))
        });
      }

      markSchemeDispatched(activeScheme.id, task.id);
      toast(
        targetRoll
          ? `方案「${activeScheme.title}」已绑定在库实卷 ${targetRoll.rollId} 并移交报工`
          : `生产单「${task.name}」已移交，请在执行与报工页选用实卷锁料`
      );
      location.hash = `#/execution/${encodeURIComponent(task.id)}`;
    } catch (e: any) {
      toast('方案移交失败：' + e.message, true);
    } finally {
      setDispatching(false);
    }
  };

  const clusters2D = clusters.filter((c) => c.dimension === '2D');
  const quickCluster = clusters2D.find((c) => c.id === activeClusterQuickId) || clusters2D[0];
  const quickCounts =
    (quickCluster && clusterSelections[quickCluster.id]) ||
    quickCluster?.defaultSizeCounts ||
    {};
  const totalPiecesCount = activeDemands2D.reduce((s, d) => s + (Number(d.quantity) || 0), 0);
  const activeRunCount = strategyRuns2D.filter(
    (r) => r.state === 'RUNNING' || r.state === 'QUEUED'
  ).length;
  const bestUtilizationPct = useMemo(
    () => (schemes2D.length ? Math.max(...schemes2D.map((x) => x.utilizationPct)) : 0),
    [schemes2D]
  );

  const savedMm = activeScheme
    ? Math.max(0, Math.round((activeScheme.canvasLengthMm - activeScheme.occupiedLengthMm) * 10) / 10)
    : 0;

  return (
    <div className="react-page studio-2d-page">
      {/* Top Studio Header Bar: Core Material Spec + Progressive Craft Disclosure + Single Primary CTA */}
      <div className="studio-top-bar">
        <h1 className="studio-title">排料工作台</h1>

        <div className="seg" role="group" aria-label="画布投料模式">
          <button
            type="button"
            className={canvasMode === 'FREE_CANVAS' ? 'on' : ''}
            aria-pressed={canvasMode === 'FREE_CANVAS'}
            onClick={() => setCanvasSpec({ canvasMode: 'FREE_CANVAS' })}
          >
            自由门幅
          </button>
          <button
            type="button"
            className={canvasMode === 'STOCK_ROLL' ? 'on' : ''}
            aria-pressed={canvasMode === 'STOCK_ROLL'}
            onClick={() => setCanvasSpec({ canvasMode: 'STOCK_ROLL' })}
          >
            实卷避疵
          </button>
        </div>

        {canvasMode === 'FREE_CANVAS' ? (
          <div className="studio-canvas-inputs">
            <label>
              <span>门幅 W</span>
              <input
                type="number"
                className="field num"
                style={{ width: 74 }}
                value={canvasWidthMm}
                onChange={(e) =>
                  setCanvasSpec({ canvasWidthMm: Math.max(300, Number(e.target.value) || 1500) })
                }
              />
              <em>mm</em>
            </label>
            <div className="width-quick-pills" role="group" aria-label="常用门幅快捷切换">
              {[1500, 1600, 1650, 1750, 2000].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={canvasWidthMm === w ? 'on' : ''}
                  aria-pressed={canvasWidthMm === w}
                  onClick={() => setCanvasSpec({ canvasWidthMm: w })}
                >
                  {w}
                </button>
              ))}
            </div>
            <label>
              <span>版长上限 L</span>
              <input
                type="number"
                className="field num"
                style={{ width: 78 }}
                value={canvasLengthMm}
                onChange={(e) =>
                  setCanvasSpec({ canvasLengthMm: Math.max(500, Number(e.target.value) || 2000) })
                }
              />
              <em>mm</em>
            </label>
          </div>
        ) : (
          <div className="studio-canvas-inputs">
            <label>
              <span>在库母卷</span>
              <select
                className="field"
                value={selectedRollId}
                onChange={(e) => {
                  const r = rolls.find((x) => x.rollId === e.target.value);
                  setCanvasSpec({
                    selectedRollId: e.target.value,
                    ...(r ? { canvasWidthMm: r.width, materialModel2D: r.rollModel } : {})
                  });
                }}
              >
                {rolls.map((r) => (
                  <option key={r.rollId} value={r.rollId}>
                    {r.rollId} · {r.rollModel} ({r.width}mm · {(r.defects || []).length}处疵点)
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>拉布长 L</span>
              <input
                type="number"
                className="field num"
                style={{ width: 78 }}
                value={canvasLengthMm}
                onChange={(e) =>
                  setCanvasSpec({ canvasLengthMm: Math.max(500, Number(e.target.value) || 2000) })
                }
              />
              <em>mm</em>
            </label>
          </div>
        )}

        {/* Secondary craft tolerances tucked behind progressive disclosure */}
        <details className="craft-disclosure">
          <summary>
            工艺余量 <span className="num">距 {pieceGapMm} · 切头 {trimStartMm} mm</span>
          </summary>
          <div className="craft-disclosure-panel">
            <label>
              <span>裁片安全间距 (mm)</span>
              <input
                type="number"
                className="field num"
                min={0}
                max={50}
                value={pieceGapMm}
                onChange={(e) =>
                  setCanvasSpec({ pieceGapMm: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
            <label>
              <span>首端修边切头 (mm)</span>
              <input
                type="number"
                className="field num"
                min={0}
                max={200}
                value={trimStartMm}
                onChange={(e) =>
                  setCanvasSpec({ trimStartMm: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
          </div>
        </details>

        {loadedTaskName && (
          <span className="tag run" title={loadedTaskName}>
            关联任务：{loadedTaskName.slice(0, 16)}
          </span>
        )}

        <span className="sp" />

        <div className="studio-run-controls">
          {runningParallel ? (
            <>
              <span className="tag run num">
                并发计算中 {activeRunCount}/{workerCount}
              </span>
              <button type="button" className="btn" onClick={handleStopParallel}>
                ■ 停止
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn pri studio-solve-btn"
            disabled={runningParallel}
            onClick={handleRunParallelStrategies}
          >
            {runningParallel
              ? '正在求解最优排料…'
              : `智能并行排料 (${selectedStrategies2D.length} 引擎)`}
          </button>
        </div>
      </div>

      {/* Main 3-Column Studio Split */}
      <div className="studio-split">
        {/* Left Column: Demand & Sample Cluster Picker */}
        <section className="pane studio-left">
          <div className="pane-h">
            <span>裁片需求与样板</span>
            <span className="sp" />
            <label className="link-btn" title="直接解析服装/工业 CAD DXF 文件">
              导入 DXF
              <input type="file" accept=".dxf" hidden onChange={handleQuickDxfUpload} />
            </label>
            <a href="#/clusters" className="link-btn">
              簇库
            </a>
          </div>
          <div className="pane-b">
            <div className="cluster-quick-box">
              <div className="cluster-quick-row">
                <select
                  className="field"
                  aria-label="选择行业样板或纸样簇"
                  style={{ flex: 1 }}
                  value={activeClusterQuickId}
                  onChange={(e) => setActiveClusterQuickId(e.target.value)}
                >
                  {clusters2D.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              {quickCluster && (
                <>
                  <div className="cluster-quick-sizes">
                    {quickCluster.availableSizes.map((sz) => (
                      <label key={sz} className={(quickCounts[sz] || 0) > 0 ? 'on' : ''}>
                        <span>{sz}</span>
                        <input
                          type="number"
                          min={0}
                          max={30}
                          value={quickCounts[sz] ?? 0}
                          onChange={(e) =>
                            setClusterCount(quickCluster.id, sz, Number(e.target.value))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="cluster-quick-btns">
                    <button
                      type="button"
                      className="btn sm pri"
                      style={{ flex: 1 }}
                      onClick={() => {
                        loadClusterInto2D(quickCluster.id, false);
                        toast(
                          `已载入「${quickCluster.name}」，门幅 ${quickCluster.defaultWidthMm} mm`
                        );
                      }}
                    >
                      载入样板
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        loadClusterInto2D(quickCluster.id, true);
                        toast(`已将「${quickCluster.name}」追加合排`);
                      }}
                    >
                      ＋ 合排
                    </button>
                  </div>
                </>
              )}
            </div>

            <div
              className="sec"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <span>
                待排清单 (<b className="num">{activeDemands2D.length}</b> 种 · 共{' '}
                <b className="num">{totalPiecesCount}</b> 片)
              </span>
              <button type="button" className="btn sm" onClick={addBlankDemand2D}>
                ＋ 新增规格
              </button>
            </div>

            <table className="t dock-table" style={{ border: 0 }}>
              <thead>
                <tr>
                  <th>部件</th>
                  <th className="r">尺寸 mm</th>
                  <th className="r">数量</th>
                  <th title="允许 90° 旋转">旋</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeDemands2D.map((d) => {
                  const isPoly = d.shape?.type === 'POLYGON';
                  return (
                    <tr key={d.id}>
                      <td className="wrap">
                        <div style={{ fontWeight: 600, fontSize: 12 }}>{d.name}</div>
                        <small className="muted">
                          {isPoly ? `异形轮廓 · ${d.shape?.vertices?.length}点` : '矩形件'}
                        </small>
                      </td>
                      <td className="r num">
                        {isPoly ? (
                          `${fmtN(d.width, 0)}×${fmtN(d.length, 0)}`
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                            <input
                              type="number"
                              className="field num"
                              aria-label={`${d.name} 宽度`}
                              style={{ width: 44, height: 22, padding: '0 2px' }}
                              value={d.width}
                              onChange={(e) =>
                                updateDemand2D(d.id, { width: Number(e.target.value) })
                              }
                            />
                            ×
                            <input
                              type="number"
                              className="field num"
                              aria-label={`${d.name} 长度`}
                              style={{ width: 44, height: 22, padding: '0 2px' }}
                              value={d.length}
                              onChange={(e) =>
                                updateDemand2D(d.id, { length: Number(e.target.value) })
                              }
                            />
                          </span>
                        )}
                      </td>
                      <td className="r">
                        <input
                          type="number"
                          min={0}
                          max={200}
                          aria-label={`${d.name} 数量`}
                          className="field num"
                          style={{ width: 44, height: 22, textAlign: 'right' }}
                          value={d.quantity}
                          onChange={(e) =>
                            updateDemand2D(d.id, {
                              quantity: Math.max(0, Number(e.target.value))
                            })
                          }
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(d.allowRotation)}
                          onChange={(e) =>
                            updateDemand2D(d.id, { allowRotation: e.target.checked })
                          }
                          aria-label={`${d.name} 允许旋转`}
                          title="允许 90° 旋转"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ padding: '0 5px', height: 20 }}
                          onClick={() => removeDemand2D(d.id)}
                          aria-label={`移除 ${d.name}`}
                          title="移除"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Center Column: Accessible CAD Toolbar + Konva Canvas + Scheme Comparison Strip */}
        <section className="pane studio-center" style={{ background: 'var(--canvas)' }}>
          <div
            ref={toolbarRef}
            className="ctool"
            role="toolbar"
            focusgroup="toolbar wrap"
            aria-label="画布视图与测量工具"
          >
            <div className="vseg" role="group" aria-label="交互模式">
              <button
                type="button"
                aria-pressed={tool === 'pan'}
                onClick={() => setTool('pan')}
              >
                平移
              </button>
              <button
                type="button"
                aria-pressed={tool === 'measure'}
                onClick={() => setTool('measure')}
              >
                测距
              </button>
            </div>
            <span className="div" role="separator" aria-orientation="vertical" />
            <div className="ctool-group" role="group" aria-label="缩放与方向">
              <button type="button" onClick={() => canvasInstanceRef.current?.fit()}>
                居中适配
              </button>
              <button
                type="button"
                aria-label="缩小画布"
                title="缩小画布"
                onClick={() => canvasInstanceRef.current?.zoom(1 / 1.25)}
              >
                −
              </button>
              <button
                type="button"
                aria-label="放大画布"
                title="放大画布"
                onClick={() => canvasInstanceRef.current?.zoom(1.25)}
              >
                ＋
              </button>
              <button
                type="button"
                aria-pressed={!vertical}
                onClick={() => setVertical((v) => !v)}
              >
                {vertical ? '竖排视图' : '横排视图'}
              </button>
            </div>
            <span className="div" role="separator" aria-orientation="vertical" />
            <div className="ctool-group" role="group" aria-label="工程图层">
              <button
                type="button"
                aria-pressed={showDimensions}
                onClick={() => setShowDimensions((s) => !s)}
              >
                尺寸标注
              </button>
              <button
                type="button"
                aria-pressed={showPath}
                onClick={() => setShowPath((s) => !s)}
              >
                切割刀路
              </button>
              {tool === 'measure' && (
                <button
                  type="button"
                  onClick={() => canvasInstanceRef.current?.clearMeasure()}
                >
                  清除标尺
                </button>
              )}
            </div>
            <span className="sp" />
            <span className="num ctool-readout">
              {activeScheme
                ? `${activeScheme.widthMm} × ${fmtN(activeScheme.occupiedLengthMm, 1)} mm · 利用率 ${activeScheme.utilizationPct}%`
                : `画布 ${canvasWidthMm} × ${canvasLengthMm} mm`}
              {cursor ? ` · X ${fmtN(cursor.v, 0)} / Y ${fmtN(cursor.u, 0)}` : ''}
            </span>
          </div>

          <div className="canvas-wrap" style={{ flex: 1 }}>
            <CadCanvasView
              scene={currentScene}
              vertical={vertical}
              showPath={showPath}
              showDimensions={showDimensions}
              tool={tool}
              onCursorMove={setCursor}
              onContextInspect={(hit) => {
                const seg = currentScene?.segments?.[0];
                const pc = seg?.pieces?.find((p: any) => p.id === hit?.entityId);
                setInspectedText(
                  pc
                    ? `裁片「${pc.label}」· 坐标 X=${fmtN(pc.v, 1)} mm, Y=${fmtN(pc.u, 1)} mm · 外接尺寸 ${fmtN(pc.dv, 1)}×${fmtN(pc.du, 1)} mm`
                    : `空白坐标 X=${fmtN(hit.v, 1)} mm, Y=${fmtN(hit.u, 1)} mm`
                );
              }}
              canvasRefOut={canvasInstanceRef}
            />
          </div>

          <div className="studio-canvas-hint">{inspectedText}</div>

          {/* Bottom Multi-Scheme Comparison Strip */}
          <div className="scheme-strip">
            <div className="scheme-strip-head">
              <strong>候选排料方案对比 ({schemes2D.length})</strong>
              <small className="muted">点击任意卡片即刻在上方画布对照明细排布</small>
              <span className="sp" />
              {schemes2D.length > 0 && (
                <button type="button" className="btn sm" onClick={clearSchemes2D}>
                  清空
                </button>
              )}
            </div>
            <div className="scheme-slots">
              {schemes2D.length === 0 ? (
                <div className="scheme-empty">
                  尚未生成方案 — 确认门幅 W 与左侧裁片后，点击右上角「智能并行排料」同屏比选多引擎结果
                </div>
              ) : (
                schemes2D.map((s, idx) => {
                  const isBest = s.utilizationPct === bestUtilizationPct;
                  const isSelected = activeScheme?.id === s.id;
                  return (
                    <div
                      key={s.id}
                      className={`scheme-slot ${isSelected ? 'on' : ''}`}
                      onClick={() => setActiveScheme2D(s.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveScheme2D(s.id);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="scheme-slot-top">
                        <strong>
                          #{schemes2D.length - idx} {s.strategyName}
                        </strong>
                        {isBest && <span className="tag ok">最优利用率</span>}
                        {s.dispatchedTaskId && <span className="tag run">已投产</span>}
                        <button
                          type="button"
                          className="scheme-del"
                          aria-label={`移除方案 ${s.title}`}
                          title="移除此方案"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeScheme2D(s.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="scheme-slot-metrics num">
                        <span>
                          利用率 <b>{s.utilizationPct}%</b>
                        </span>
                        <span>
                          实长 <b>{s.occupiedLengthMm} mm</b>
                        </span>
                        <span>
                          齐套{' '}
                          <b>
                            {s.placedCount}/{s.requestedCount}
                          </b>
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Customer Value KPIs & Delivery FIRST, Progressive Engine Configuration SECOND */}
        <section className="pane studio-right">
          <div className="pane-h">
            <span>排料效益与投产交付</span>
          </div>
          <div className="pane-b">
            {activeScheme ? (
              <div className="value-hero-panel">
                <div className="value-hero-head">
                  <div>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      当前审阅方案
                    </span>
                    <div className="value-hero-title">{activeScheme.strategyName}</div>
                  </div>
                  <span className={`tag ${activeScheme.complete ? 'ok' : 'warn'}`}>
                    {activeScheme.complete ? '齐套达标' : '部分排入'}
                  </span>
                </div>

                <div className="value-kpi-grid num">
                  <div className="value-kpi-cell highlight">
                    <small>综合材料利用率</small>
                    <b>
                      {activeScheme.utilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>实占唛架长度</small>
                    <b>
                      {fmtN(activeScheme.occupiedLengthMm, 1)}
                      <em>mm</em>
                    </b>
                    {savedMm > 0 && (
                      <span className="kpi-sub ok-ink">较上限省料 {fmtN(savedMm, 0)} mm</span>
                    )}
                  </div>
                  <div className="value-kpi-cell">
                    <small>排入裁片齐套数</small>
                    <b>
                      {activeScheme.placedCount}
                      <em>/ {activeScheme.requestedCount} 片</em>
                    </b>
                  </div>
                  <div className="value-kpi-cell">
                    <small>净面积 / 门幅</small>
                    <b>
                      {activeScheme.pieceAreaM2}
                      <em>m² · W{activeScheme.widthMm}</em>
                    </b>
                  </div>
                </div>

                <div className="value-actions">
                  <button
                    type="button"
                    className="btn pri value-primary-cta"
                    disabled={dispatching}
                    onClick={handleDispatchSchemeToExecution}
                  >
                    {dispatching
                      ? '正在建立生产单并移交…'
                      : activeScheme.dispatchedTaskId
                      ? '已移交生产 · 查看执行单'
                      : '确认选定方案 → 移交车间执行'}
                  </button>
                  <div className="value-export-row">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => handleExportCam('dxf')}
                    >
                      导出 CAD DXF
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => handleExportCam('nc')}
                    >
                      导出 CNC G-Code
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="value-empty-card">
                <strong>实时评估利用率、实占版长与省料效益</strong>
                <p>
                  当前待排 <b className="num">{activeDemands2D.length}</b> 种部件（共{' '}
                  <b className="num">{totalPiecesCount}</b> 片），设定门幅{' '}
                  <b className="num">{canvasWidthMm} mm</b>。点击下方按钮并发比选最优唛架。
                </p>
                <button
                  type="button"
                  className="btn pri"
                  style={{ width: '100%' }}
                  disabled={runningParallel}
                  onClick={handleRunParallelStrategies}
                >
                  立即生成多引擎对比方案
                </button>
              </div>
            )}

            {/* Progressive Disclosure Accordion for Solver Engines */}
            <details className="studio-accordion" open={!activeScheme || runningParallel}>
              <summary>
                <span>并行竞速引擎组合</span>
                <span className="tag num" style={{ marginLeft: 'auto' }}>
                  已选 {selectedStrategies2D.length} / {STRATEGIES_2D.length}
                </span>
              </summary>
              <div className="choice-card-list">
                {STRATEGIES_2D.map((stDef) => {
                  const checked = selectedStrategies2D.includes(stDef.id);
                  const runInfo = strategyRuns2D.find((r) => r.strategyId === stDef.id);
                  return (
                    <label
                      key={stDef.id}
                      className={`choice-card ${runInfo?.state === 'RUNNING' ? 'is-running' : ''}`}
                      title={stDef.description}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleStrategy2D(stDef.id)}
                      />
                      <div className="choice-card-body">
                        <div className="choice-card-head">
                          <strong>{stDef.name}</strong>
                          <span className="tag">{stDef.badge}</span>
                        </div>
                        <div className="choice-card-sub">{stDef.shortTag}</div>
                        {runInfo && (
                          <div className="choice-card-status num">
                            <span
                              className={`tag ${
                                runInfo.state === 'SUCCEEDED' || runInfo.state === 'TIMED_OUT'
                                  ? 'ok'
                                  : runInfo.state === 'RUNNING' || runInfo.state === 'QUEUED'
                                  ? 'run'
                                  : 'err'
                              }`}
                            >
                              {runInfo.state === 'SUCCEEDED'
                                ? '完成'
                                : runInfo.state === 'RUNNING'
                                ? '计算中'
                                : runInfo.state === 'QUEUED'
                                ? '排队'
                                : runInfo.state}
                            </span>
                            <span className="choice-card-phase">{runInfo.phaseText}</span>
                            {runInfo.elapsedMs != null && (
                              <small className="muted">
                                {(runInfo.elapsedMs / 1000).toFixed(1)}s
                              </small>
                            )}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </details>
          </div>
        </section>
      </div>
    </div>
  );
};
