import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStudioStore,
  DemandItem,
  StrategyJobRun,
  SavedScheme2D
} from '../store/useStudioStore';
import { CadCanvasView } from '../components/CadCanvasView';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import { showcaseScene } from '@static/app/js/model/showcase.js';
import { rectangle, shapeArea } from '@static/js/canvas/nesting-scene.js';
import { gcodeText, dxfText } from '@static/js/plugins/export/cam-format.js';
import { requestJSON, toast, fmtN } from '@static/app/js/util.js';

interface SolverStrategyDef {
  id: string;
  name: string;
  badge: string;
  description: string;
  halfTurn: boolean;
  forceRotateRect?: boolean;
  shorten: boolean;
  gapFill: boolean;
  enginePref: 'auto' | 'java';
  timeLimit: number;
}

const STRATEGIES_2D: SolverStrategyDef[] = [
  {
    id: 'SHORTEN_FIXED',
    name: '策略 A · 严格经向齐套缩长',
    badge: '经向 0° · C++',
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
    name: '策略 B · 允许掉头/旋转互补',
    badge: '180°/90° · C++',
    description: '异形片允许 180° 倒顺对排、矩形允许 90° 旋转，追求最短长度与最低单耗',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 10
  },
  {
    id: 'SHORTEN_GAP_FILL',
    name: '策略 C · 齐套缩长 + 备片补空',
    badge: '智能补片 · C++',
    description: '在齐套唛架空隙内自动加排同款小件备片，最大化整床幅面利用率',
    halfTurn: true,
    forceRotateRect: true,
    shorten: true,
    gapFill: true,
    enginePref: 'auto',
    timeLimit: 12
  },
  {
    id: 'JAVA_HEURISTIC',
    name: '策略 D · Java 天际线启发式并行',
    badge: '天际线 · Java',
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
    name: '策略 E · 预设画布定长直排',
    badge: '定长画布 · C++',
    description: '按上方预设幅宽 × 长度整床一次直排，快速查看固定台板装入量',
    halfTurn: false,
    forceRotateRect: false,
    shorten: false,
    gapFill: false,
    enginePref: 'auto',
    timeLimit: 4
  }
];

function buildOptimizationRequest2D(
  strategy: SolverStrategyDef,
  widthMm: number,
  lengthMm: number,
  pieceGapMm: number,
  trimStartMm: number,
  demands: DemandItem[],
  defects: any[] = []
) {
  const hasPolygon = demands.some((d) => d.shape?.type === 'POLYGON');
  const mode = hasPolygon ? 'CONTOUR' : 'GUILLOTINE';
  const engine =
    strategy.enginePref === 'java'
      ? mode === 'CONTOUR'
        ? 'javairregular'
        : 'javaguillotine'
      : 'auto';

  const parts = demands
    .filter((d) => d.quantity > 0 && d.width > 0 && d.length > 0)
    .map((d, idx) => ({
      id: d.id || idx + 1,
      name: d.name,
      quantity: Math.max(1, Math.floor(d.quantity)),
      allowRotation: mode === 'GUILLOTINE' ? Boolean(strategy.forceRotateRect || d.allowRotation) : Boolean(d.allowRotation),
      ...(mode === 'CONTOUR' && (strategy.halfTurn || d.allowHalfTurn) ? { allowHalfTurn: true } : {}),
      shape: d.shape ? structuredClone(d.shape) : rectangle(Number(d.width), Number(d.length))
    }));

  let rowX = 0;
  let rowY = trimStartMm;
  let rowH = 0;
  for (const p of parts) {
    for (let i = 0; i < p.quantity; i++) {
      if (rowX + p.shape.width > widthMm) {
        rowY += rowH + pieceGapMm;
        rowX = 0;
        rowH = 0;
      }
      rowX += p.shape.width + pieceGapMm;
      rowH = Math.max(rowH, p.shape.height);
    }
  }
  const safeStartHeight = strategy.shorten
    ? Math.max(lengthMm, Math.ceil(rowY + rowH + 150))
    : lengthMm;

  const exclusions = defects.map((d, i) => ({
    id: d.id || i + 1,
    x: Math.max(0, d.x - (d.margin || 0)),
    y: Math.max(0, d.y - (d.margin || 0)),
    shape: rectangle(d.w + 2 * (d.margin || 0), d.h + 2 * (d.margin || 0)),
    clearance: 0
  }));

  const problem = {
    schemaVersion: '1',
    unit: 'mm',
    engine,
    timeLimitSeconds: strategy.timeLimit,
    material: {
      id: `CANVAS-${widthMm}x${safeStartHeight}`,
      shape: rectangle(widthMm, safeStartHeight),
      continuesAfterRegion: false,
      exclusions
    },
    parts,
    process: {
      mode,
      feedMode: 'SHEET',
      startCorner: 'left-top',
      firstStageOrientation: mode === 'CONTOUR' ? 'none' : 'horizontal',
      trimStart: mode === 'CONTOUR' ? 0 : trimStartMm,
      minReusableWidth: mode === 'CONTOUR' ? 0 : 150,
      minReusableHeight: mode === 'CONTOUR' ? 0 : 150,
      kerf: 0,
      objective: 'MAXIMIZE_PIECE_AREA',
      pieceGap: pieceGapMm
    }
  };

  const canUseMarkerStrategy =
    mode === 'CONTOUR' &&
    strategy.shorten &&
    strategy.enginePref !== 'java' &&
    parts.every((p) => p.shape.width <= widthMm);

  const strategyBlock = canUseMarkerStrategy
    ? {
        id: 'marker-shortening',
        version: '2',
        maxTrials: 7,
        ...(strategy.gapFill
          ? {
              gapFillLimits: Object.fromEntries(
                parts.slice(0, 80).map((p) => [p.id, Math.min(80, Math.max(2, p.quantity))])
              )
            }
          : {})
      }
    : undefined;

  return {
    schemaVersion: '2.0',
    clientRequestId: `studio-${strategy.id}-${Date.now()}`,
    problemType: 'NESTING_2D',
    allowFallback: true,
    requireComplete: Boolean(canUseMarkerStrategy),
    problem,
    ...(strategyBlock ? { strategy: strategyBlock } : {})
  };
}

export const NestingStudio2DPage: React.FC<{ taskId?: string }> = ({ taskId }) => {
  const {
    clusters,
    clusterSelections,
    setClusterCount,
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
  const [inspectedText, setInspectedText] = useState<string>('滚轮缩放 · 拖动画布平移 · 右键查看裁片坐标尺寸');
  const [runningParallel, setRunningParallel] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [activeClusterQuickId, setActiveClusterQuickId] = useState('DXF_1226');

  const canvasInstanceRef = useRef<any>(null);
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

        // If task already has solved plan, import it as a scheme slot so user sees it right away
        if (latestPlan?.result?.pieces?.length) {
          const r = latestPlan.result;
          const reqObj = buildOptimizationRequest2D(
            STRATEGIES_2D[0],
            latestPlan.request?.rollW || canvasWidthMm,
            latestPlan.request?.rollL || t.process?.bedLength || 2000,
            t.process?.pieceGap || 0,
            t.process?.trimStart || 0,
            items
          );
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
              kind: c.type === '横切' ? 'HORIZONTAL' : c.type === '纵切' ? 'VERTICAL' : 'CONTOUR',
              startX: c.startX,
              startY: c.startY,
              endX: c.endX,
              endY: c.endY
            }))
          };
          const occupiedLengthMm = r.deductLen || Math.max(...r.pieces.map((p: any) => p.y + (p.shape?.height || p.l)));
          const pieceAreaM2 = Number((r.pieceArea || 0).toFixed(3));
          const util = r.totalArea > 0 ? Number(((r.pieceArea / r.totalArea) * 100).toFixed(2)) : 0;
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
    const previewReq = buildOptimizationRequest2D(
      STRATEGIES_2D[4],
      canvasWidthMm,
      canvasLengthMm,
      pieceGapMm,
      trimStartMm,
      activeDemands2D,
      canvasMode === 'STOCK_ROLL' && currentRoll ? currentRoll.defects || [] : []
    );
    return projectScene(previewReq, null);
  }, [
    activeScheme,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    activeDemands2D,
    canvasMode,
    currentRoll
  ]);

  const handleRunParallelStrategies = async () => {
    if (runningParallel) return;
    const validDemands = activeDemands2D.filter((d) => d.quantity > 0 && d.width > 0 && d.length > 0);
    if (!validDemands.length) {
      toast('请先从左侧选择纸样簇或录入至少一项有效裁片需求', true);
      return;
    }
    const badWidth = validDemands.find((d) => d.width > canvasWidthMm && !d.allowRotation);
    if (badWidth) {
      toast(`裁片「${badWidth.name}」宽度 (${badWidth.width}mm) 超过画布幅宽 (${canvasWidthMm}mm)`, true);
      return;
    }

    const chosenDefs = STRATEGIES_2D.filter((s) => selectedStrategies2D.includes(s.id));
    if (!chosenDefs.length) return;

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
        phaseText: '排队提交至并发线程池…',
        requestedCount: totalRequested
      }))
    );

    const defects =
      canvasMode === 'STOCK_ROLL' && currentRoll
        ? (currentRoll.defects || []).filter((d: any) => d.y < canvasLengthMm)
        : [];

    const createdSchemes: SavedScheme2D[] = [];

    await Promise.all(
      chosenDefs.map(async (def) => {
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const req = buildOptimizationRequest2D(
          def,
          canvasWidthMm,
          canvasLengthMm,
          pieceGapMm,
          trimStartMm,
          validDemands,
          defects
        );
        const t0 = performance.now();
        try {
          const { job, result } = await (session as any).solve(req, {
            onProgress: (j: any) => {
              setStrategyRuns2D((prev) =>
                prev.map((r) =>
                  r.strategyId === def.id
                    ? {
                        ...r,
                        jobId: j.id,
                        state: j.state === 'QUEUED' ? 'QUEUED' : 'RUNNING',
                        phaseText: j.message || j.phase || '多线程计算中…'
                      }
                    : r
                )
              );
            }
          });
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

          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === def.id
                ? {
                    ...r,
                    jobId: job.id,
                    state: job.state as any,
                    phaseText: complete
                      ? `齐套完成 · 用布 ${fmtN(occupiedLengthMm, 1)}mm · ${utilizationPct}%`
                      : `已排 ${placements.length}/${totalRequested} 片 · ${utilizationPct}%`,
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
              title: `${def.badge.split('·')[0].trim()} (${canvasWidthMm}×${Math.round(occupiedLengthMm)}mm)`,
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
          }
        } catch (err: any) {
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === def.id
                ? {
                    ...r,
                    state: err.name === 'AbortError' ? 'CANCELLED' : 'FAILED',
                    phaseText: err.message || '求解未完成'
                  }
                : r
            )
          );
        }
      })
    );

    if (createdSchemes.length > 0) {
      addSchemes2D(createdSchemes);
      toast(`多线程并行求解完成：生成 ${createdSchemes.length} 套候选方案`);
    }
    setRunningParallel(false);
  };

  const handleStopParallel = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningParallel(false);
    toast('已停止所有并行求解线程');
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
      const bedL = Math.max(
        500,
        Math.ceil(activeScheme.occupiedLengthMm + trimStartMm)
      );

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
        localStorage.setItem(
          'cutplan.app.2d.scheme.' + task.id,
          JSON.stringify(activeScheme)
        );
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
          solver: activeScheme.request?.problem?.engine === 'javaguillotine' || activeScheme.request?.problem?.engine === 'javairregular' ? activeScheme.request.problem.engine : 'packingsolver',
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
          ? `已将方案「${activeScheme.title}」关联实卷 ${targetRoll.rollId} 移交至生产报工中心！`
          : `已创建生产任务「${task.name}」并移交方案快照（请在报工中心选用在库实卷投产）`
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
  const quickCounts = (quickCluster && clusterSelections[quickCluster.id]) || quickCluster?.defaultSizeCounts || {};
  const totalPiecesCount = activeDemands2D.reduce((s, d) => s + (Number(d.quantity) || 0), 0);
  const activeRunCount = strategyRuns2D.filter((r) => r.state === 'RUNNING' || r.state === 'QUEUED').length;

  return (
    <div className="react-page studio-2d-page">
      {/* Top Preset Canvas & Parallel Execution Bar */}
      <div className="studio-top-bar">
        <div className="seg">
          <button
            type="button"
            className={canvasMode === 'FREE_CANVAS' ? 'on' : ''}
            onClick={() => setCanvasSpec({ canvasMode: 'FREE_CANVAS' })}
          >
            预设自由画布
          </button>
          <button
            type="button"
            className={canvasMode === 'STOCK_ROLL' ? 'on' : ''}
            onClick={() => setCanvasSpec({ canvasMode: 'STOCK_ROLL' })}
          >
            绑定实卷避疵
          </button>
        </div>

        {canvasMode === 'FREE_CANVAS' ? (
          <div className="studio-canvas-inputs">
            <label>
              <span>幅宽 W</span>
              <input
                type="number"
                className="field num"
                style={{ width: 76 }}
                value={canvasWidthMm}
                onChange={(e) => setCanvasSpec({ canvasWidthMm: Math.max(300, Number(e.target.value) || 1500) })}
              />
              <em>mm</em>
            </label>
            <div className="width-quick-pills">
              {[1500, 1600, 1650, 1750, 2000].map((w) => (
                <button
                  key={w}
                  type="button"
                  className={canvasWidthMm === w ? 'on' : ''}
                  onClick={() => setCanvasSpec({ canvasWidthMm: w })}
                >
                  {w}
                </button>
              ))}
            </div>
            <label>
              <span>长度 L</span>
              <input
                type="number"
                className="field num"
                style={{ width: 78 }}
                value={canvasLengthMm}
                onChange={(e) => setCanvasSpec({ canvasLengthMm: Math.max(500, Number(e.target.value) || 2000) })}
              />
              <em>mm</em>
            </label>
            <label>
              <span>件距</span>
              <input
                type="number"
                className="field num"
                style={{ width: 48 }}
                min={0}
                max={50}
                value={pieceGapMm}
                onChange={(e) => setCanvasSpec({ pieceGapMm: Math.max(0, Number(e.target.value) || 0) })}
              />
              <em>mm</em>
            </label>
          </div>
        ) : (
          <div className="studio-canvas-inputs">
            <label>
              <span>实卷档案</span>
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
                    {r.rollId} · {r.rollModel} ({r.width}mm · {(r.defects || []).length}疵)
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>拉布长</span>
              <input
                type="number"
                className="field num"
                style={{ width: 78 }}
                value={canvasLengthMm}
                onChange={(e) => setCanvasSpec({ canvasLengthMm: Math.max(500, Number(e.target.value) || 2000) })}
              />
              <em>mm</em>
            </label>
          </div>
        )}

        {loadedTaskName && (
          <span className="tag run" title={loadedTaskName}>
            任务：{loadedTaskName.slice(0, 18)}
          </span>
        )}

        <span className="sp" />

        <div className="studio-run-controls">
          <span className="tag" title="后端多线程池并发额度">
            {runningParallel ? `并发线程 ${activeRunCount}/${workerCount}` : `池容量 ${workerCount} 线程`}
          </span>
          {runningParallel && (
            <button type="button" className="btn" onClick={handleStopParallel}>
              ■ 停止
            </button>
          )}
          <button
            type="button"
            className="btn pri studio-solve-btn"
            disabled={runningParallel}
            onClick={handleRunParallelStrategies}
          >
            {runningParallel
              ? '⚡ 多策略并行计算中…'
              : `⚡ 多线程并行搭切 (${selectedStrategies2D.length} 策略)`}
          </button>
        </div>
      </div>

      {/* Main 3-Column Studio Split */}
      <div className="studio-split">
        {/* Left Column: Cluster Quick Picker & Active Piece List */}
        <section className="pane studio-left">
          <div className="pane-h">
            1. 调入需求与纸样簇
            <span className="sp" />
            <a href="#/clusters" style={{ fontSize: 11.5 }}>
              打开簇库 ↗
            </a>
          </div>
          <div className="pane-b">
            <div className="cluster-quick-box">
              <div className="cluster-quick-row">
                <select
                  className="field"
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
                        toast(`已载入「${quickCluster.name}」，推荐门幅 ${quickCluster.defaultWidthMm}mm`);
                      }}
                    >
                      载入并替换
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        loadClusterInto2D(quickCluster.id, true);
                        toast(`已追加「${quickCluster.name}」至当前待排单`);
                      }}
                    >
                      ＋ 追加混排
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="sec" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>
                待排裁片 ({activeDemands2D.length} 项 · <b className="num">{totalPiecesCount}</b> 片)
              </span>
              <button type="button" className="btn sm" onClick={addBlankDemand2D}>
                ＋ 手动加件
              </button>
            </div>

            <table className="t dock-table" style={{ border: 0 }}>
              <thead>
                <tr>
                  <th>裁片名称</th>
                  <th className="r">宽×长</th>
                  <th className="r">件数</th>
                  <th>旋</th>
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
                          {isPoly ? `CAD异形(${d.shape?.vertices?.length}点)` : '矩形'}
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
                              style={{ width: 44, height: 22, padding: '0 2px' }}
                              value={d.width}
                              onChange={(e) => updateDemand2D(d.id, { width: Number(e.target.value) })}
                            />
                            ×
                            <input
                              type="number"
                              className="field num"
                              style={{ width: 44, height: 22, padding: '0 2px' }}
                              value={d.length}
                              onChange={(e) => updateDemand2D(d.id, { length: Number(e.target.value) })}
                            />
                          </span>
                        )}
                      </td>
                      <td className="r">
                        <input
                          type="number"
                          min={0}
                          max={200}
                          className="field num"
                          style={{ width: 44, height: 22, textAlign: 'right' }}
                          value={d.quantity}
                          onChange={(e) =>
                            updateDemand2D(d.id, { quantity: Math.max(0, Number(e.target.value)) })
                          }
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={Boolean(d.allowRotation)}
                          onChange={(e) => updateDemand2D(d.id, { allowRotation: e.target.checked })}
                          title="允许 90° 旋转"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          style={{ padding: '0 5px', height: 20 }}
                          onClick={() => removeDemand2D(d.id)}
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

        {/* Center Column: Pure CAD Canvas + Bottom Multi-Scheme Comparison Strip */}
        <section className="pane studio-center" style={{ background: 'var(--canvas)' }}>
          <div className="ctool">
            <div className="vseg">
              <button
                type="button"
                className={tool === 'pan' ? 'on' : ''}
                onClick={() => setTool('pan')}
              >
                平移
              </button>
              <button
                type="button"
                className={tool === 'measure' ? 'on' : ''}
                onClick={() => setTool('measure')}
              >
                测量
              </button>
            </div>
            <div className="div" />
            <button type="button" onClick={() => canvasInstanceRef.current?.fit()}>
              适应窗口
            </button>
            <button type="button" onClick={() => canvasInstanceRef.current?.zoom(1 / 1.25)}>
              −
            </button>
            <button type="button" onClick={() => canvasInstanceRef.current?.zoom(1.25)}>
              ＋
            </button>
            <button type="button" onClick={() => setVertical((v) => !v)}>
              {vertical ? '竖向 ⇅' : '横向 ⇆'}
            </button>
            <button
              type="button"
              className={showDimensions ? 'on' : ''}
              onClick={() => setShowDimensions((s) => !s)}
            >
              尺寸
            </button>
            <button
              type="button"
              className={showPath ? 'on' : ''}
              onClick={() => setShowPath((s) => !s)}
            >
              刀路
            </button>
            <button type="button" onClick={() => canvasInstanceRef.current?.clearMeasure()}>
              ✕ 清空测量
            </button>
            <span className="sp" />
            <span className="num" style={{ color: '#94a3b8', fontSize: 11.5 }}>
              {activeScheme
                ? `方案：${activeScheme.title} · 利用率 ${activeScheme.utilizationPct}%`
                : `画布预览：${canvasWidthMm} × ${canvasLengthMm} mm`}
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
                    ? `裁片「${pc.label}」· 坐标 X=${fmtN(pc.v, 1)} mm, Y=${fmtN(pc.u, 1)} mm · 尺寸 ${fmtN(pc.dv, 1)}×${fmtN(pc.du, 1)} mm`
                    : `空白坐标 X=${fmtN(hit.v, 1)} mm, Y=${fmtN(hit.u, 1)} mm`
                );
              }}
              canvasRefOut={canvasInstanceRef}
            />
          </div>

          <div className="studio-canvas-hint">{inspectedText}</div>

          {/* Bottom Scheme Slots Strip */}
          <div className="scheme-strip">
            <div className="scheme-strip-head">
              <span>多方案对比槽 ({schemes2D.length})</span>
              <small className="muted">同屏切换对比不同策略/不同幅宽的排料效果</small>
              <span className="sp" />
              {schemes2D.length > 0 && (
                <button type="button" className="btn sm" onClick={clearSchemes2D}>
                  清空对比槽
                </button>
              )}
            </div>
            <div className="scheme-slots">
              {schemes2D.length === 0 ? (
                <div className="scheme-empty">
                  尚未生成方案 — 可直接修改上方幅宽 W / 长度 L 或从左侧切换纸样簇，点击「⚡ 多线程并行搭切」生成多套对比方案
                </div>
              ) : (
                schemes2D.map((s, idx) => {
                  const isBest =
                    s.utilizationPct === Math.max(...schemes2D.map((x) => x.utilizationPct));
                  const isSelected = activeScheme?.id === s.id;
                  return (
                    <div
                      key={s.id}
                      className={`scheme-slot ${isSelected ? 'on' : ''}`}
                      onClick={() => setActiveScheme2D(s.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="scheme-slot-top">
                        <strong>#{schemes2D.length - idx} {s.title}</strong>
                        {isBest && <span className="tag ok">最优</span>}
                        {s.dispatchedTaskId && <span className="tag run">已移交</span>}
                        <span
                          className="scheme-del"
                          title="移除此方案"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeScheme2D(s.id);
                          }}
                        >
                          ×
                        </span>
                      </div>
                      <div className="scheme-slot-metrics num">
                        <span>利用率 <b>{s.utilizationPct}%</b></span>
                        <span>实长 <b>{s.occupiedLengthMm}mm</b></span>
                        <span>排入 <b>{s.placedCount}/{s.requestedCount}</b></span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>

        {/* Right Column: Parallel Solver Strategy Matrix & Selected Scheme Export/Dispatch */}
        <section className="pane studio-right">
          <div className="pane-h">
            2. 多线程策略矩阵与方案移交
          </div>
          <div className="pane-b">
            <div className="sec">选择并行求解策略（支持自定义多引擎竞速）</div>
            <div className="strategy-list">
              {STRATEGIES_2D.map((stDef) => {
                const checked = selectedStrategies2D.includes(stDef.id);
                const runInfo = strategyRuns2D.find((r) => r.strategyId === stDef.id);
                return (
                  <div
                    key={stDef.id}
                    className={`strategy-card ${checked ? 'checked' : ''} ${runInfo?.state === 'RUNNING' ? 'running' : ''}`}
                  >
                    <label className="strategy-head">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleStrategy2D(stDef.id)}
                      />
                      <b>{stDef.name}</b>
                      <span className="tag">{stDef.badge}</span>
                    </label>
                    <p className="strategy-desc">{stDef.description}</p>
                    {runInfo && (
                      <div className="strategy-run-status">
                        <span
                          className={`tag ${
                            runInfo.state === 'SUCCEEDED' || runInfo.state === 'TIMED_OUT'
                              ? 'ok'
                              : runInfo.state === 'RUNNING' || runInfo.state === 'QUEUED'
                              ? 'run'
                              : 'err'
                          }`}
                        >
                          {runInfo.state}
                        </span>
                        <span className="num" style={{ flex: 1 }}>
                          {runInfo.phaseText}
                        </span>
                        {runInfo.elapsedMs != null && (
                          <small className="num muted">{(runInfo.elapsedMs / 1000).toFixed(1)}s</small>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {activeScheme ? (
              <div className="active-scheme-panel">
                <div className="sec">选中方案详细指标 · {activeScheme.title}</div>
                <div className="metric">
                  <div>
                    <small>齐套利用率</small>
                    <b>
                      {activeScheme.utilizationPct}
                      <em>%</em>
                    </b>
                  </div>
                  <div>
                    <small>实占唛架长度</small>
                    <b>
                      {activeScheme.occupiedLengthMm}
                      <em>mm</em>
                    </b>
                  </div>
                  <div>
                    <small>幅宽 × 净面积</small>
                    <b>
                      {activeScheme.widthMm}
                      <em>mm · {activeScheme.pieceAreaM2}m²</em>
                    </b>
                  </div>
                  <div>
                    <small>排入裁片数</small>
                    <b>
                      {activeScheme.placedCount}
                      <em>/ {activeScheme.requestedCount} 片</em>
                    </b>
                  </div>
                </div>

                <div className="sec">CAM 下料文件导出</div>
                <div className="tool-grid" style={{ padding: '6px 12px' }}>
                  <button type="button" className="btn sm" onClick={() => handleExportCam('dxf')}>
                    导出 AutoCAD DXF
                  </button>
                  <button type="button" className="btn sm" onClick={() => handleExportCam('nc')}>
                    导出 CNC G-Code
                  </button>
                </div>

                <div className="sec">独立后续流程</div>
                <div style={{ padding: '8px 12px 14px' }}>
                  <button
                    type="button"
                    className="btn pri"
                    style={{ width: '100%', height: 36 }}
                    disabled={dispatching}
                    onClick={handleDispatchSchemeToExecution}
                  >
                    {dispatching
                      ? '正在建单并移交报工中心…'
                      : activeScheme.dispatchedTaskId
                      ? '✓ 已移交生产（前往报工中心 ↗）'
                      : '选定此方案 → 拿出去报工 ↗'}
                  </button>
                  <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
                    工作台专注切割与排料，绝不产生报工记账。仅在点击移交后才推送到执行与报工中心。
                  </p>
                </div>
              </div>
            ) : (
              <div className="empty" style={{ padding: '20px 14px' }}>
                点击上方「⚡ 多线程并行搭切」同时跑多种求解策略，选出最满意的一套方案后再导出或拿出去报工。
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
