import { useEffect, useRef, useState } from 'react';
import {
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingOrderLine,
  SlittingSchemeRun,
  StrategyJobRun
} from '../../store/useStudioStore';
import {
  SlittingProfile,
  SlittingWidthMode,
  StudioSettings,
  extractSlittingSolverOptions
} from '../../store/studioSettings';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  buildSafeNestingRequest2D,
  unpadGuillotineResult
} from '@static/js/business/optimization/nesting-request-adapter.js';
import { shapeArea } from '@static/js/canvas/nesting-scene.js';
import { independentBaseline, planSummary } from '@static/js/linear/linear-model.js';
import { requestJSON, toast, fmtN } from '@static/app/js/util.js';
import { LastConfirmSummary, SolverStrategyDef } from './workbenchTypes';

export interface UseWorkbenchSolverOptions {
  // 2D inputs
  activeDemands2D: DemandItem[];
  activeAlgos: SolverStrategyDef[];
  canvasMode: 'FREE_CANVAS' | 'STOCK_ROLL' | 'REMNANT';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  canvasWidthMm: number;
  canvasLengthMm: number;
  pieceGapMm: number;
  trimStartMm: number;
  materialModel2D: string;
  loadedTaskId: string | null;
  loadedTaskName: string;
  loadedExternalRef: string;
  currentRoll2D: any;
  currentRemnant2D: any;
  activeScheme2D: SavedScheme2D | null;
  setStrategyRuns2D: (
    runs: StrategyJobRun[] | ((prev: StrategyJobRun[]) => StrategyJobRun[])
  ) => void;
  addSchemes2D: (schemes: SavedScheme2D[]) => void;
  markSchemeDispatched: (schemeId: string, taskId: string, confirmedSchemeId: string) => void;

  // 1D inputs
  slitOrders: SlittingOrderLine[];
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitWidthMode: SlittingWidthMode;
  slitProfile: SlittingProfile;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitMaterialModel: string;
  slitLoadedTaskId: string | null;
  slitLoadedTaskName: string;
  scenario1D: Scenario1DType;
  currentRoll1D: any;
  activeScheme1D: SlittingSchemeRun | null;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  markSlitSchemeDispatched: (
    runId: string,
    taskId: string,
    confirmedSchemeId: string
  ) => void;

  // Shared
  settings: StudioSettings;
  reloadReferenceData: (explicitTaskId?: string | null) => Promise<DemandFamilySummary[]>;
  syncDemandFamilyProgress: (fam: DemandFamilySummary) => void;
}

export function useWorkbenchSolver(opts: UseWorkbenchSolverOptions) {
  const {
    activeDemands2D,
    activeAlgos,
    canvasMode,
    scenario2D,
    multiWidthsText2D,
    canvasWidthMm,
    canvasLengthMm,
    pieceGapMm,
    trimStartMm,
    materialModel2D,
    loadedTaskId,
    loadedTaskName,
    loadedExternalRef,
    currentRoll2D,
    currentRemnant2D,
    activeScheme2D,
    setStrategyRuns2D,
    addSchemes2D,
    markSchemeDispatched,
    slitOrders,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitMaterialModel,
    slitLoadedTaskId,
    slitLoadedTaskName,
    scenario1D,
    currentRoll1D,
    activeScheme1D,
    setSlitSchemes,
    markSlitSchemeDispatched,
    settings,
    reloadReferenceData,
    syncDemandFamilyProgress
  } = opts;

  const [runningSolve, setRunningSolve] = useState(false);
  const [confirmingScheme, setConfirmingScheme] = useState(false);
  const [lastConfirmSummary, setLastConfirmSummary] = useState<LastConfirmSummary | null>(null);
  const activeSessionsRef = useRef<OptimizationSession[]>([]);

  useEffect(() => {
    return () => {
      activeSessionsRef.current.forEach((s) => s.cancel());
    };
  }, []);

  const handleRunSolve2D = async () => {
    if (runningSolve) return;
    let validDemands = activeDemands2D.filter(
      (d) => d.quantity > 0 && d.width > 0 && d.length > 0
    );
    if (!validDemands.length) {
      const retrial = activeDemands2D
        .filter((d) => (d.orderedQty || 0) > 0 && d.width > 0 && d.length > 0)
        .map((d) => ({ ...d, quantity: d.orderedQty || 1 }));
      if (retrial.length > 0) {
        validDemands = retrial;
        toast('该需求族已排齐，按原单总量进行重排试算');
      } else {
        toast('请先在左侧选择需求族、载入模板或添加裁片需求', true);
        return;
      }
    }

    const chosenDefs = activeAlgos;
    if (!chosenDefs.length) {
      toast('请在系统设置中至少启用一种二维排版算法', true);
      return;
    }

    const candidateWidths =
      canvasMode === 'FREE_CANVAS' && scenario2D === 'MULTI_WIDTH'
        ? multiWidthsText2D
            .split(/[,，\s]+/)
            .map((s) => Math.round(Number(s.trim())))
            .filter((n) => n >= 400 && n <= 6000)
            .slice(0, 5)
        : [
            canvasMode === 'STOCK_ROLL' && currentRoll2D
              ? currentRoll2D.width
              : canvasMode === 'REMNANT' && currentRemnant2D
              ? currentRemnant2D.width
              : canvasWidthMm
          ];

    if (!candidateWidths.length) {
      toast('请填写有效候选门幅（400–6000 mm）', true);
      return;
    }

    const effLength =
      canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.length : canvasLengthMm;
    const effectiveScenario: Scenario2DType =
      canvasMode === 'REMNANT' ? 'FIXED_BED' : scenario2D;

    setRunningSolve(true);
    setLastConfirmSummary(null);
    activeSessionsRef.current.forEach((s) => s.cancel());
    activeSessionsRef.current = [];

    const totalRequested = validDemands.reduce((s, d) => s + d.quantity, 0);
    const jobsToRun =
      candidateWidths.length > 1
        ? candidateWidths.map((w) => ({
            def: chosenDefs[0],
            width: w,
            runKey: `${chosenDefs[0].id}-W${w}`,
            label: `门幅 ${w}mm · ${chosenDefs[0].name}`
          }))
        : chosenDefs.map((def) => ({
            def,
            width: candidateWidths[0],
            runKey: def.id,
            label: def.name
          }));

    setStrategyRuns2D(
      jobsToRun.map((j) => ({
        strategyId: j.runKey,
        strategyName: j.label,
        description: j.def.description,
        state: 'QUEUED',
        phaseText: '排队提交…',
        requestedCount: totalRequested
      }))
    );

    const startOffset =
      canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.usedLength || 0 : 0;
    const windowDefects =
      canvasMode === 'STOCK_ROLL' && currentRoll2D
        ? (currentRoll2D.defects || [])
            .filter((d: any) => d.y < startOffset + effLength && d.y + d.h > startOffset)
            .map((d: any) => ({
              ...d,
              y: Math.max(0, d.y - startOffset)
            }))
        : canvasMode === 'REMNANT' && currentRemnant2D
        ? currentRemnant2D.defects || []
        : [];

    const createdSchemes: SavedScheme2D[] = [];
    const failureMessages: string[] = [];

    await Promise.all(
      jobsToRun.map(async ({ def, width, runKey, label }) => {
        const tooWide = validDemands.some((d) => {
          const isPoly = d.shape?.type === 'POLYGON';
          const canRot90 = isPoly
            ? Boolean(d.allowRotation)
            : Boolean(d.allowRotation || def.forceRotateRect);
          return canRot90 ? Math.min(d.width, d.length) > width : d.width > width;
        });
        if (tooWide) {
          const msg = `存在裁片宽超门幅 ${width}mm`;
          failureMessages.push(`${label}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey ? { ...r, state: 'FAILED', phaseText: msg } : r
            )
          );
          return;
        }
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const stockMaxCap =
          canvasMode === 'STOCK_ROLL' && currentRoll2D
            ? Math.max(200, currentRoll2D.currentRemainingLength ?? currentRoll2D.totalLength)
            : undefined;
        const built = buildSafeNestingRequest2D({
          strategy: def,
          scenario: effectiveScenario,
          widthMm: width,
          lengthMm: effLength,
          pieceGapMm,
          trimStartMm,
          demands: validDemands,
          defects: windowDefects,
          maxLengthCapMm: stockMaxCap,
          settings
        });
        if (built.error || !built.request) {
          const msg = built.error || '请求参数无法构造有效求解问题';
          failureMessages.push(`${label}：${msg}`);
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey ? { ...r, state: 'FAILED', phaseText: msg } : r
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
                  r.strategyId === runKey
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
              : effLength);
          const netAreaMm2 = [...placements, ...gapFills].reduce(
            (s: number, p: any) => s + shapeArea(p.shape),
            0
          );
          const denomAreaMm2 = width * Math.max(1, occupiedLengthMm);
          const utilizationPct = Number(((netAreaMm2 / denomAreaMm2) * 100).toFixed(2));
          const complete = result?.fulfillmentStatus === 'COMPLETE';
          const fallbackHint = layout?.fallbackReason ? ' · 已降级' : '';

          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    jobId: job.id,
                    state: job.state as any,
                    phaseText: complete
                      ? `齐套 · ${fmtN(occupiedLengthMm, 1)}mm · ${utilizationPct}%${fallbackHint}`
                      : placements.length > 0
                      ? `已排 ${placements.length}/${totalRequested} · ${utilizationPct}%${fallbackHint}`
                      : layout?.message || '未排入任何裁片（请检查门幅与版长）',
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
            const schemeId = `CAND-${runKey}-${Date.now().toString(36).slice(-4)}`;
            createdSchemes.push({
              id: schemeId,
              title: `${label} (${width}×${Math.round(occupiedLengthMm)}mm)`,
              strategyId: def.id,
              strategyName: label,
              scenarioId: effectiveScenario,
              createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              canvasMode,
              rollId:
                canvasMode === 'STOCK_ROLL' && currentRoll2D ? currentRoll2D.rollId : undefined,
              remnantId:
                canvasMode === 'REMNANT' && currentRemnant2D ? currentRemnant2D.id : undefined,
              windowStartY: startOffset,
              materialModel:
                canvasMode === 'STOCK_ROLL' && currentRoll2D
                  ? currentRoll2D.rollModel
                  : canvasMode === 'REMNANT' && currentRemnant2D
                  ? currentRemnant2D.materialBatch
                  : materialModel2D || `VIRTUAL-${width}`,
              widthMm: width,
              canvasLengthMm: effLength,
              occupiedLengthMm: Math.round(occupiedLengthMm * 10) / 10,
              utilizationPct,
              pieceAreaM2: Number((netAreaMm2 / 1_000_000).toFixed(3)),
              placedCount: placements.length + gapFills.length,
              requestedCount: totalRequested,
              gapFillCount: gapFills.length,
              complete,
              demands: structuredClone(validDemands),
              request: req,
              result
            });
          } else {
            failureMessages.push(
              `${label}：${layout?.message || '未能排入裁片，请增大版长或调整旋转规则'}`
            );
          }
        } catch (err: any) {
          const rawMsg = err?.message || '求解未完成';
          const friendlyMsg =
            /failed to fetch|networkerror|connection|无法连接|fetch/i.test(rawMsg)
              ? '无法连接后端求解服务（请确认 8080 端口服务已启动）'
              : rawMsg;
          if (err?.name !== 'AbortError') {
            failureMessages.push(`${label}：${friendlyMsg}`);
          }
          setStrategyRuns2D((prev) =>
            prev.map((r) =>
              r.strategyId === runKey
                ? {
                    ...r,
                    state: err.name === 'AbortError' ? 'CANCELLED' : 'FAILED',
                    phaseText: friendlyMsg
                  }
                : r
            )
          );
        }
      })
    );

    if (createdSchemes.length > 0) {
      addSchemes2D(createdSchemes);
      toast(`排版完成：生成 ${createdSchemes.length} 套候选方案`);
    } else if (failureMessages.length > 0) {
      toast(`排版未生成方案：${failureMessages[0]}`, true);
    }
    setRunningSolve(false);
  };

  const handleRunSolve1D = async () => {
    if (runningSolve) return;
    let validOrders = slitOrders.filter((o) => o.quantity > 0 && o.widthMm > 0);
    if (!validOrders.length) {
      const retrial = slitOrders
        .filter((o) => (o.orderedQty || 0) > 0 && o.widthMm > 0)
        .map((o) => ({ ...o, quantity: o.orderedQty || 1 }));
      if (retrial.length > 0) {
        validOrders = retrial;
        toast('该分条需求族已排齐，按原单总量进行重排试算');
      } else {
        toast('请先在左侧载入分条需求族或添加分条规格', true);
        return;
      }
    }
    const effMotherW = Math.floor(
      slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
        ? currentRoll1D.width
        : slitMotherWidthMm
    );
    const effLeftTrim = Math.max(0, Math.floor(Number(slitLeftTrimMm) || 0));
    const effRightTrim = Math.max(0, Math.floor(Number(slitRightTrimMm) || 0));
    const maxUsable = effMotherW - effLeftTrim - effRightTrim;
    if (!Number.isFinite(effMotherW) || effMotherW <= 0 || maxUsable <= 0) {
      toast('请检查母卷幅宽与左右切边：扣边后可用幅宽必须大于 0 mm', true);
      return;
    }

    const rawMaxW = Math.floor(Number(slitMaxWidthMm) || maxUsable);
    const effMaxW = Math.min(maxUsable, rawMaxW);
    const effMinW =
      slitWidthMode === 'FIXED'
        ? effMaxW
        : Math.floor(Number(slitMinWidthMm) || effMaxW);
    const effStep = Math.max(1, Math.floor(Number(slitWidthStepMm) || 10));
    const effOverCap =
      scenario1D === 'MAX_UTIL'
        ? Math.max(Math.max(0, Math.floor(Number(slitOverCap) || 0)), 30)
        : Math.max(0, Math.floor(Number(slitOverCap) || 0));

    if (effMinW <= 0 || effMaxW < effMinW || effMaxW > maxUsable) {
      toast(
        `组合宽度区间 [${effMinW}, ${effMaxW}] mm 无效，须位于可切幅宽 (≤ ${maxUsable} mm) 内且下限 ≤ 上限`,
        true
      );
      return;
    }
    if (Math.floor((effMaxW - effMinW) / effStep) > 1000) {
      toast('组合幅宽候选步数超过 1001 档，请调大步长或收窄区间', true);
      return;
    }
    const maxOrderW = Math.max(...validOrders.map((o) => Math.floor(o.widthMm)));
    if (maxOrderW > effMaxW) {
      toast(
        `最大订单幅宽 ${maxOrderW} mm 超出当前组合上限 ${effMaxW} mm，请调大母卷幅宽或组合上限`,
        true
      );
      return;
    }

    setRunningSolve(true);
    setLastConfirmSummary(null);
    const advOpts = extractSlittingSolverOptions(settings);
    const runProfiles: SlittingProfile[] = settings.slitRunBothProfiles
      ? ['FAST', 'QUALITY']
      : [slitProfile];

    try {
      const baselineInput = {
        motherWidth: effMotherW,
        leftTrim: effLeftTrim,
        rightTrim: effRightTrim,
        orderItems: validOrders.map((o) => ({
          width: Math.floor(o.widthMm),
          length: Math.floor(o.lengthMm > 0 ? o.lengthMm : slitFixedLengthMm),
          quantity: Math.floor(o.quantity),
          surfaceTreatment: o.surfaceTreatment?.trim() || '不电晕/不涂布'
        }))
      };
      const baseGroups = independentBaseline(baselineInput);
      const baseSummary = planSummary(baseGroups, baselineInput);
      const baselineRun: SlittingSchemeRun = {
        id: 'SLIT-BASELINE',
        strategyId: 'BASELINE',
        strategyName: '逐规格独立分切（基线）',
        state: 'SUCCEEDED',
        motherWidthMm: effMotherW,
        leftTrimMm: effLeftTrim,
        rightTrimMm: effRightTrim,
        totalCars: baseSummary.rolls,
        missingRolls: baseSummary.shortage || 0,
        overproducedRolls: baseSummary.surplus || 0,
        avgUtilizationPct: Number((baseSummary.rate || 0).toFixed(2)),
        elapsedMs: 1,
        patterns: baseGroups.map((g: any, i: number) => {
          const widthCounts = new Map<number, number>();
          for (const w of g.comboExpanded || []) {
            const nw = Number(w);
            widthCounts.set(nw, (widthCounts.get(nw) || 0) + 1);
          }
          const stations = Array.from(widthCounts.entries()).map(
            ([widthMm, countPerRepetition]) => ({ widthMm, countPerRepetition })
          );
          const usedW = stations.reduce((s, it) => s + it.widthMm * it.countPerRepetition, 0);
          return {
            id: `BASE-${i + 1}`,
            lengthMm: g.length || slitFixedLengthMm,
            repetitions: g.usageCount || 1,
            stations,
            usedWidthMm: usedW,
            spareWidthMm: Math.max(0, effMotherW - effLeftTrim - effRightTrim - usedW)
          };
        }),
        fulfillment: validOrders.map((o) => ({
          orderId: o.id,
          name: o.name,
          widthMm: o.widthMm,
          requested: o.quantity,
          produced: o.quantity,
          missing: 0,
          overproduced: 0
        }))
      };

      const makePending = (profile: SlittingProfile): SlittingSchemeRun => ({
        id: `SLIT-${profile}`,
        strategyId: profile,
        strategyName:
          profile === 'FAST' ? 'OR-Tools 快捷解 (FAST)' : 'OR-Tools 精确解 (QUALITY)',
        state: 'RUNNING',
        motherWidthMm: effMotherW,
        leftTrimMm: effLeftTrim,
        rightTrimMm: effRightTrim,
        totalCars: 0,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 0,
        patterns: [],
        fulfillment: []
      });
      setSlitSchemes([...runProfiles.map(makePending), baselineRun]);

      const runProfile = async (profile: SlittingProfile): Promise<SlittingSchemeRun> => {
        const session = new OptimizationSession();
        activeSessionsRef.current.push(session);
        const t0 = performance.now();
        const effTimeLimit = Math.min(
          180,
          Math.max(
            1,
            Math.round(
              profile === 'QUALITY'
                ? Math.max(settings.slitTimeLimitSeconds, validOrders.length >= 40 ? 180 : 60)
                : settings.slitTimeLimitSeconds
            )
          )
        );
        const req = {
          schemaVersion: '2.0',
          clientRequestId: `slit-${profile}-${Date.now()}`,
          problemType: 'SLITTING_1D',
          allowFallback: false,
          requireComplete: false,
          problem: {
            schemaVersion: '1',
            unit: 'mm',
            motherWidthMm: effMotherW,
            leftTrimMm: effLeftTrim,
            rightTrimMm: effRightTrim,
            minWidthMm: effMinW,
            maxWidthMm: effMaxW,
            widthStepMm: effStep,
            totalOverCap: effOverCap,
            profile,
            timeLimitSeconds: effTimeLimit,
            topK: advOpts.topK,
            maxIterations: advOpts.maxIterations,
            maxPatterns: advOpts.maxPatterns,
            maxDistinctWidths:
              profile === 'QUALITY'
                ? Math.max(advOpts.maxDistinctWidths, 5)
                : advOpts.maxDistinctWidths,
            stageTimeLimitMs: advOpts.stageTimeLimitMs,
            useOptimizedAssignment: advOpts.useOptimizedAssignment,
            underPenalty: advOpts.underPenalty,
            seqGroupAlpha: advOpts.seqGroupAlpha,
            seqGroupBeta: advOpts.seqGroupBeta,
            lnsEnabled: advOpts.lnsEnabled,
            orders: validOrders.map((o) => ({
              id: o.id,
              widthMm: Math.floor(o.widthMm),
              lengthMm: Math.floor(o.lengthMm > 0 ? o.lengthMm : slitFixedLengthMm),
              quantity: Math.floor(o.quantity),
              surfaceTreatment: o.surfaceTreatment?.trim() || '不电晕/不涂布'
            }))
          }
        };
        try {
          const { result } = await (session as any).solve(req);
          const s = result.slitting;
          const utilMetric =
            result.metrics?.find((m: any) => m.name === 'motherAreaUtilization')?.value || 0;
          const totalCars = s.patterns.reduce((n: number, p: any) => n + p.repetitions, 0);
          const missingRolls = s.fulfillment.reduce((n: number, f: any) => n + f.missing, 0);
          const overproducedRolls = s.fulfillment.reduce(
            (n: number, f: any) => n + f.overproduced,
            0
          );
          return {
            id: `SLIT-${profile}`,
            strategyId: profile,
            strategyName:
              profile === 'FAST' ? 'OR-Tools 快捷解 (FAST)' : 'OR-Tools 精确解 (QUALITY)',
            state: 'SUCCEEDED',
            motherWidthMm: effMotherW,
            leftTrimMm: effLeftTrim,
            rightTrimMm: effRightTrim,
            totalCars,
            missingRolls,
            overproducedRolls,
            avgUtilizationPct: Number(utilMetric.toFixed(2)),
            elapsedMs: Math.round(performance.now() - t0),
            patterns: s.patterns.map((p: any) => ({
              id: p.id,
              lengthMm: p.lengthMm,
              repetitions: p.repetitions,
              stations: p.stations,
              usedWidthMm: p.patternWidthMm,
              spareWidthMm: Math.max(
                0,
                effMotherW - effLeftTrim - effRightTrim - p.patternWidthMm
              ),
              allocations: p.allocations
            })),
            fulfillment: s.fulfillment.map((f: any) => {
              const ord = validOrders.find((o) => o.id === String(f.orderId));
              return {
                orderId: String(f.orderId),
                name: ord?.name || f.orderId,
                widthMm: ord?.widthMm || 0,
                requested: f.requested,
                produced: f.produced,
                missing: f.missing,
                overproduced: f.overproduced
              };
            }),
            rawResult: result
          };
        } catch (e: any) {
          return {
            ...makePending(profile),
            strategyName: `OR-Tools (${profile}) - ${e.message || '求解失败'}`,
            state: 'FAILED'
          };
        }
      };

      const results = await Promise.all(runProfiles.map((prof) => runProfile(prof)));
      const orderedResults = [...results].sort((a, b) => {
        if (a.state === 'SUCCEEDED' && b.state !== 'SUCCEEDED') return -1;
        if (b.state === 'SUCCEEDED' && a.state !== 'SUCCEEDED') return 1;
        return a.totalCars - b.totalCars;
      });
      setSlitSchemes([...orderedResults, baselineRun]);
      const bestSolved = orderedResults.find((r) => r.state === 'SUCCEEDED');
      if (bestSolved) {
        toast(
          `分切排版完成：${bestSolved.strategyName} ${bestSolved.totalCars} 车（较独立分切省 ${Math.max(
            0,
            baselineRun.totalCars - bestSolved.totalCars
          )} 车，利用率 ${bestSolved.avgUtilizationPct}%）`
        );
      } else {
        toast(orderedResults[0]?.strategyName || '一维分切求解未返回有效方案', true);
      }
    } catch (e: any) {
      toast('一维分切求解失败：' + e.message, true);
    } finally {
      setRunningSolve(false);
    }
  };

  const handleStopSolve = () => {
    activeSessionsRef.current.forEach((s) => s.cancel());
    setRunningSolve(false);
    toast('已中止当前排版计算');
  };

  const handleConfirmSelectedScheme2D = async () => {
    if (!activeScheme2D || confirmingScheme) return;
    if (activeScheme2D.confirmedSchemeId) {
      location.hash = `#/results/${encodeURIComponent(activeScheme2D.confirmedSchemeId)}`;
      return;
    }
    setConfirmingScheme(true);
    try {
      const layout = activeScheme2D.result?.layout;
      const rawMain: any[] = layout?.placements || [];
      const rawGap: any[] = activeScheme2D.result?.marker?.gapFillPlacements || [];
      const hasPoly = activeScheme2D.demands.some((d) => d.shape?.type === 'POLYGON');

      const placementsPayload = [
        ...rawMain.map((p, idx) => ({
          id: idx + 1,
          demandId: p.demandId,
          name: p.name,
          x: p.x,
          y: p.y,
          w: p.shape?.width || 0,
          l: p.shape?.height || 0,
          rotationDegrees: p.rotationDegrees || 0,
          gapFill: false,
          shape: hasPoly ? p.shape : undefined
        })),
        ...rawGap.map((p, idx) => ({
          id: rawMain.length + idx + 1,
          demandId: p.demandId,
          name: p.name,
          x: p.x,
          y: p.y,
          w: p.shape?.width || 0,
          l: p.shape?.height || 0,
          rotationDegrees: p.rotationDegrees || 0,
          gapFill: true,
          shape: hasPoly ? p.shape : undefined
        }))
      ];

      const res = await requestJSON('/api/v2/schemes/confirm', {
        idempotencyKey: `CONFIRM-${activeScheme2D.id}`,
        title: activeScheme2D.title,
        dimension: hasPoly ? 'CONTOUR_2D' : 'RECT_2D',
        scenarioId: activeScheme2D.scenarioId || scenario2D,
        strategyId: activeScheme2D.strategyId || 'AUTO',
        strategyName: activeScheme2D.strategyName,
        taskId: loadedTaskId || undefined,
        taskName: loadedTaskName || `${activeScheme2D.materialModel} · 排料需求族`,
        externalOrderNo: loadedExternalRef || undefined,
        materialMode:
          activeScheme2D.canvasMode === 'FREE_CANVAS'
            ? 'VIRTUAL_ROLL'
            : activeScheme2D.canvasMode,
        rollId: activeScheme2D.rollId,
        remnantId: activeScheme2D.remnantId,
        materialModel: activeScheme2D.materialModel,
        widthMm: activeScheme2D.widthMm,
        canvasLengthMm: activeScheme2D.canvasLengthMm,
        windowStartY: activeScheme2D.windowStartY,
        occupiedLengthMm: activeScheme2D.occupiedLengthMm,
        trimStartMm,
        pieceGapMm,
        utilizationPct: activeScheme2D.utilizationPct,
        pieceAreaM2: activeScheme2D.pieceAreaM2,
        demands: activeDemands2D.map((d) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          length: d.length,
          quantity: Math.max(1, d.orderedQty || d.quantity),
          allowRotation: Boolean(d.allowRotation),
          allowHalfTurn: Boolean(d.allowHalfTurn),
          sizeLabel: d.sizeLabel,
          shape: d.shape
        })),
        layout2D: {
          placements: placementsPayload,
          leftovers: (layout?.leftovers || []).map((rm: any, i: number) => ({
            id: String(rm.id || i + 1),
            x: rm.x,
            y: rm.y,
            w: rm.shape?.width || rm.w || 0,
            l: rm.shape?.height || rm.l || 0,
            hasDefect: Boolean(rm.hasDefect)
          })),
          cuts: (layout?.cuts || []).map((c: any, i: number) => ({
            sequence: c.sequence || i + 1,
            kind: c.kind || 'CONTOUR',
            startX: c.startX,
            startY: c.startY,
            endX: c.endX,
            endY: c.endY
          }))
        }
      });

      const savedScheme = res.scheme;
      const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
      markSchemeDispatched(activeScheme2D.id, savedScheme.taskId, savedScheme.id);

      await reloadReferenceData(savedScheme.taskId);
      if (updatedFamily) {
        syncDemandFamilyProgress(updatedFamily);
        setLastConfirmSummary({
          schemeId: savedScheme.id,
          openRemaining: updatedFamily.openTotal,
          state: savedScheme.state
        });
      }

      toast(
        savedScheme.state === 'AWAITING_ROLL'
          ? `已确认方案「${savedScheme.id}」并扣减待排需求`
          : `已确认方案「${savedScheme.id}」并锁定实卷区段`
      );
    } catch (err: any) {
      toast('选定方案确认失败：' + err.message, true);
    } finally {
      setConfirmingScheme(false);
    }
  };

  const handleConfirmSelectedScheme1D = async () => {
    if (!activeScheme1D || activeScheme1D.state !== 'SUCCEEDED' || confirmingScheme) return;
    if (activeScheme1D.confirmedSchemeId) {
      location.hash = `#/results/${encodeURIComponent(activeScheme1D.confirmedSchemeId)}`;
      return;
    }
    setConfirmingScheme(true);
    try {
      const res = await requestJSON('/api/v2/schemes/confirm', {
        idempotencyKey: `CONFIRM-1D-${activeScheme1D.id}-${Date.now()}`,
        title: `${activeScheme1D.strategyName} (${activeScheme1D.motherWidthMm}mm · ${activeScheme1D.totalCars}车)`,
        dimension: 'SLITTING_1D',
        scenarioId: scenario1D,
        strategyId: activeScheme1D.strategyId,
        strategyName: activeScheme1D.strategyName,
        taskId: slitLoadedTaskId || undefined,
        taskName: slitLoadedTaskName || `${slitMaterialModel} · 一维分切需求族`,
        materialMode: slitMaterialMode,
        rollId:
          slitMaterialMode === 'STOCK_ROLL' && currentRoll1D ? currentRoll1D.rollId : undefined,
        materialModel:
          slitMaterialMode === 'STOCK_ROLL' && currentRoll1D
            ? currentRoll1D.rollModel
            : slitMaterialModel || `SLIT-${activeScheme1D.motherWidthMm}`,
        widthMm: activeScheme1D.motherWidthMm,
        canvasLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
        occupiedLengthMm: activeScheme1D.totalCars * slitFixedLengthMm,
        trimStartMm: 0,
        pieceGapMm: 0,
        utilizationPct: activeScheme1D.avgUtilizationPct,
        pieceAreaM2: Number(
          (
            (activeScheme1D.motherWidthMm *
              activeScheme1D.totalCars *
              slitFixedLengthMm *
              (activeScheme1D.avgUtilizationPct / 100)) /
            1_000_000
          ).toFixed(2)
        ),
        avoidDefects: slitAvoidDefects,
        demands: slitOrders.map((o, idx) => ({
          id: Number(o.id) || idx + 1,
          name: o.name,
          width: o.widthMm,
          length: slitFixedLengthMm,
          quantity: Math.max(1, o.orderedQty || o.quantity),
          allowRotation: false
        })),
        slitting1D: {
          leftTrimMm: activeScheme1D.leftTrimMm,
          rightTrimMm: activeScheme1D.rightTrimMm,
          minWidthMm: slitMinWidthMm,
          maxWidthMm: slitMaxWidthMm,
          widthStepMm: slitWidthStepMm,
          totalOverCap: slitOverCap,
          fixedLengthMm: slitFixedLengthMm,
          totalCars: activeScheme1D.totalCars,
          missingRolls: activeScheme1D.missingRolls,
          overproducedRolls: activeScheme1D.overproducedRolls,
          patterns: activeScheme1D.patterns.map((p) => ({
            id: p.id,
            lengthMm: p.lengthMm,
            repetitions: p.repetitions,
            usedWidthMm: p.usedWidthMm,
            spareWidthMm: p.spareWidthMm,
            stations: p.stations
          })),
          fulfillment: activeScheme1D.fulfillment
        }
      });

      const savedScheme = res.scheme;
      const updatedFamily: DemandFamilySummary | undefined = res.demandFamily;
      markSlitSchemeDispatched(activeScheme1D.id, savedScheme.taskId, savedScheme.id);
      await reloadReferenceData(savedScheme.taskId);
      if (updatedFamily) {
        syncDemandFamilyProgress(updatedFamily);
        setLastConfirmSummary({
          schemeId: savedScheme.id,
          openRemaining: updatedFamily.openTotal,
          state: savedScheme.state
        });
      }
      toast(`已选定分切方案「${savedScheme.id}」并扣减待排需求`);
    } catch (err: any) {
      toast('选定分切方案失败：' + err.message, true);
    } finally {
      setConfirmingScheme(false);
    }
  };

  return {
    runningSolve,
    confirmingScheme,
    lastConfirmSummary,
    setLastConfirmSummary,
    handleRunSolve2D,
    handleRunSolve1D,
    handleStopSolve,
    handleConfirmSelectedScheme2D,
    handleConfirmSelectedScheme1D
  };
}
