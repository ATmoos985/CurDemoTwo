import type { MutableRefObject } from 'react';
import type { SavedScheme2D, Scenario2DType } from '../../store/studioTypes';
import type { UseWorkbenchSolverOptions } from './solverRequestBuilders';
import { OptimizationSession } from '../../lib/domain/job-client.js';
import {
  buildSafeNestingRequest2D,
  unpadGuillotineResult
} from '../../lib/domain/nesting-request-adapter.js';
import { shapeArea } from '../../lib/canvas/nesting-scene.js';
import { requestJSON, toast, fmtN } from '../../lib/core/util.js';
import type { LastConfirmSummary } from './workbenchTypes';
import { formatSolverProgressText } from './solverProgressUtils';
import { projectWindowDefectsForSolver } from './defectWindowUtils';
import {
  buildMultiMaterialWorkbenchRequest,
  mapMultiMaterialResponseToSchemes2D,
  type MultiMaterialPlanResponse
} from './multiMaterialWorkbenchUtils';

export async function executeSolve2D(
  opts: UseWorkbenchSolverOptions,
  activeSessionsRef: MutableRefObject<OptimizationSession[]>,
  callbacks: {
    setRunningSolve: (running: boolean) => void;
    setLastConfirmSummary: (summary: LastConfirmSummary | null) => void;
  }
) {
  const {
    activeDemands2D,
    activeAlgos,
    canvasMode,
    scenario2D,
    multiWidthsText2D,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D,
    pieceGapMm,
    trimStartMm,
    materialModel2D,
    requiredBatchNo = null,
    requiredColor = null,
    multiPreferRemnants = true,
    multiMaxRemnants = 6,
    multiCandidateRollIds = [],
    loadedTaskId,
    currentRoll2D,
    currentRemnant2D,
    setStrategyRuns2D,
    addSchemes2D,
    setSchemes2D,
    setMultiMaterialSummary,
    settings,
    batchGuardWarning
  } = opts;
  const { setRunningSolve, setLastConfirmSummary } = callbacks;

  if (batchGuardWarning?.blocking) {
    toast(`${batchGuardWarning.title}：${batchGuardWarning.detail}`, true);
    return;
  }

  if (canvasMode === 'MULTI_MATERIAL') {
    const builtReq = buildMultiMaterialWorkbenchRequest({
      demands: activeDemands2D,
      taskId: loadedTaskId,
      materialModel: materialModel2D,
      requiredBatchNo,
      requiredColor,
      preferRemnants: multiPreferRemnants,
      maxRemnants: multiMaxRemnants,
      candidateRollIds: multiCandidateRollIds,
      pieceGapMm,
      trimStartMm,
      timeBudgetMs: 6000
    });
    if (builtReq.error || !builtReq.payload || !builtReq.effectiveDemands) {
      toast(builtReq.error || '多料联排参数无效', true);
      return;
    }
    if (builtReq.usedOrderedFallback) {
      toast('已排齐，按原单试算多料联排');
    }

    setRunningSolve(true);
    setLastConfirmSummary(null);
    activeSessionsRef.current.forEach((s) => s.cancel());
    activeSessionsRef.current = [];

    const totalReqCount = builtReq.effectiveDemands.reduce((s, d) => s + d.quantity, 0);
    setStrategyRuns2D([
      {
        strategyId: 'MULTI_MATERIAL_PLAN',
        strategyName: '多料头接力 + 多母卷对比',
        description: '只读联合排产评估，生成各块料头与可行母卷真实排布预览',
        state: 'RUNNING',
        phaseText: '联排试算中…',
        requestedCount: totalReqCount
      }
    ]);

    const t0 = performance.now();
    try {
      const res: MultiMaterialPlanResponse = await requestJSON(
        '/api/v2/planning/multi-material',
        builtReq.payload
      );
      const elapsedMs = Math.round(performance.now() - t0);
      const { schemes, summary } = mapMultiMaterialResponseToSchemes2D(res, {
        demands: builtReq.effectiveDemands,
        fallbackMaterialModel: materialModel2D || 'STANDARD',
        pieceGapMm,
        trimStartMm
      });

      setMultiMaterialSummary?.(summary);
      if (schemes.length > 0) {
        if (setSchemes2D) {
          setSchemes2D(schemes, schemes[0].id);
        } else {
          addSchemes2D(schemes);
        }
      } else if (setSchemes2D) {
        setSchemes2D([], null);
      }

      const totalPlaced = summary.placedByRemnants + summary.placedByRoll;
      setStrategyRuns2D([
        {
          strategyId: 'MULTI_MATERIAL_PLAN',
          strategyName: '多料头接力 + 多母卷对比',
          description: '只读联合排产评估，生成各块料头与可行母卷真实排布预览',
          state: totalPlaced > 0 ? 'SUCCEEDED' : 'FAILED',
          phaseText:
            totalPlaced > 0
              ? `料头 ${summary.placedByRemnants} 件 · 母卷 ${summary.placedByRoll} 件`
              : '未命中可用料',
          errorDetail:
            totalPlaced === 0
              ? summary.warnings[0] || '未找到可排入当前需求的在库料头或母卷'
              : undefined,
          elapsedMs,
          placedCount: totalPlaced,
          requestedCount: totalReqCount,
          complete: summary.unplacedPieces === 0 && totalPlaced > 0
        }
      ]);

      if (schemes.length === 0) {
        toast(
          summary.warnings[0] || '多料联排未命中可用在库料头或母卷，请核对品号/缸号或切换新母卷',
          true
        );
      } else {
        toast(
          `多料联排完成：料头消化 ${summary.placedByRemnants} 件、推荐母卷承接 ${summary.placedByRoll} 件，共生成 ${schemes.length} 套可预览方案`
        );
      }
    } catch (err: any) {
      const rawMsg = err?.message || '多料联排计算失败';
      const isNetErr = /failed to fetch|networkerror|connection|无法连接|fetch/i.test(rawMsg);
      const friendlyDetail = isNetErr ? '无法连接后端求解服务（8080）' : rawMsg;
      setStrategyRuns2D([
        {
          strategyId: 'MULTI_MATERIAL_PLAN',
          strategyName: '多料头接力 + 多母卷对比',
          description: '只读联合排产评估',
          state: 'FAILED',
          phaseText: isNetErr ? '未连接' : '失败',
          errorDetail: friendlyDetail
        }
      ]);
      toast('多料联排失败：' + friendlyDetail, true);
    } finally {
      setRunningSolve(false);
    }
    return;
  }

  let validDemands = activeDemands2D.filter(
    (d) => d.quantity > 0 && d.width > 0 && d.length > 0
  );
  if (!validDemands.length) {
    const retrial = activeDemands2D
      .filter((d) => (d.orderedQty || 0) > 0 && d.width > 0 && d.length > 0)
      .map((d) => ({ ...d, quantity: d.orderedQty || 1 }));
    if (retrial.length > 0) {
      validDemands = retrial;
      toast('已排齐，按原单试算');
    } else {
      toast('请先载入或添加需求', true);
      return;
    }
  }

  const chosenDefs = activeAlgos;
  if (!chosenDefs.length) {
    toast('请先启用至少一种算法', true);
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
    toast('门幅需在 400–6000 mm 内', true);
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
          label: `W${w} · ${chosenDefs[0].name}`
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
      phaseText: '',
      requestedCount: totalRequested
    }))
  );

  const rollUsedLen =
    canvasMode === 'STOCK_ROLL' && currentRoll2D ? Number(currentRoll2D.usedLength) || 0 : 0;
  const rollTotalLen =
    canvasMode === 'STOCK_ROLL' && currentRoll2D ? Number(currentRoll2D.totalLength) || 0 : 0;
  const startOffset =
    canvasMode === 'STOCK_ROLL' && currentRoll2D
      ? Math.max(
          rollUsedLen,
          Math.min(
            Math.max(rollUsedLen, rollTotalLen - 100),
            windowStartY2D != null && Number.isFinite(windowStartY2D) ? windowStartY2D : rollUsedLen
          )
        )
      : 0;
  const stockMaxCap =
    canvasMode === 'STOCK_ROLL' && currentRoll2D
      ? Math.max(
          200,
          Math.min(
            Math.max(200, (currentRoll2D.totalLength || 0) - startOffset),
            currentRoll2D.currentRemainingLength ?? currentRoll2D.totalLength
          )
        )
      : undefined;
  const solverWindowLength =
    canvasMode === 'STOCK_ROLL' && currentRoll2D
      ? effectiveScenario === 'FIXED_BED'
        ? effLength
        : Math.max(effLength, stockMaxCap ?? effLength)
      : effLength;
  const windowDefects =
    canvasMode === 'STOCK_ROLL' && currentRoll2D
      ? projectWindowDefectsForSolver(
          currentRoll2D.defects,
          startOffset,
          solverWindowLength,
          Number(currentRoll2D.width) || candidateWidths[0],
          settings.defectMarginMm
        )
      : canvasMode === 'REMNANT' && currentRemnant2D
      ? projectWindowDefectsForSolver(
          currentRemnant2D.defects,
          0,
          effLength,
          Number(currentRemnant2D.width) || candidateWidths[0],
          settings.defectMarginMm
        )
      : [];

  const batchSchemeIds = new Set<string>();
  const createdSchemes: SavedScheme2D[] = [];
  const failureMessages: string[] = [];

  await Promise.all(
    jobsToRun.map(async ({ def, width, runKey, label }) => {
      const tooWide = validDemands.some((d) => {
        const canRot90 = !def.lockZeroGrain && Boolean(d.allowRotation);
        return canRot90 ? Math.min(d.width, d.length) > width : d.width > width;
      });
      if (tooWide) {
        const detail = `存在裁片宽超门幅 ${width}mm`;
        failureMessages.push(`${label}：${detail}`);
        setStrategyRuns2D((prev) =>
          prev.map((r) =>
            r.strategyId === runKey
              ? { ...r, state: 'FAILED', phaseText: '超门幅', errorDetail: detail }
              : r
          )
        );
        return;
      }
      const session = new OptimizationSession();
      activeSessionsRef.current.push(session);
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
        const detail = built.error || '参数无效';
        failureMessages.push(`${label}：${detail}`);
        setStrategyRuns2D((prev) =>
          prev.map((r) =>
            r.strategyId === runKey
              ? { ...r, state: 'FAILED', phaseText: '参数无效', errorDetail: detail }
              : r
          )
        );
        return;
      }
      const req = built.request;
      const t0 = performance.now();
      try {
        const { job, result: rawResult } = await (session as any).solve(req, {
          onProgress: (j: any) => {
            const liveState = j.state || j.status || 'RUNNING';
            const livePhase = formatSolverProgressText({
              state: liveState,
              phase: j.phase,
              elapsedMs: j.elapsedMs,
              transport: j.transport
            });
            setStrategyRuns2D((prev) =>
              prev.map((r) =>
                r.strategyId === runKey
                  ? {
                      ...r,
                      jobId: j.id,
                      state: liveState === 'QUEUED' ? 'QUEUED' : 'RUNNING',
                      phaseText: livePhase,
                      ...(typeof j.elapsedMs === 'number' && Number.isFinite(j.elapsedMs)
                        ? { elapsedMs: Math.round(j.elapsedMs) }
                        : {})
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
        const fallbackHint = layout?.fallbackReason ? ' · 降级' : '';

        setStrategyRuns2D((prev) =>
          prev.map((r) =>
            r.strategyId === runKey
              ? {
                  ...r,
                  jobId: job.id,
                  state: job.state as any,
                  phaseText:
                    placements.length > 0
                      ? complete
                        ? `${utilizationPct}% · ${fmtN(occupiedLengthMm, 0)}mm${fallbackHint}`
                        : `${placements.length}/${totalRequested} · ${utilizationPct}%${fallbackHint}`
                      : '未排入',
                  errorDetail:
                    placements.length === 0
                      ? layout?.message || '未排入任何裁片，请检查门幅或版长'
                      : undefined,
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
          const scheme: SavedScheme2D = {
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
          };
          batchSchemeIds.add(schemeId);
          createdSchemes.push(scheme);
          addSchemes2D([scheme], { selectIfBetter: true, batchIds: batchSchemeIds });
        } else {
          failureMessages.push(`${label}：${layout?.message || '未排入裁片'}`);
        }
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError';
        const rawMsg = err?.message || '求解失败';
        const isNetErr = /failed to fetch|networkerror|connection|无法连接|fetch/i.test(rawMsg);
        const friendlyDetail = isNetErr ? '无法连接后端求解服务（8080）' : rawMsg;
        const shortTag = isAbort
          ? '已停止'
          : isNetErr
          ? '未连接'
          : /超时|timeout|TIMED_OUT/i.test(rawMsg)
          ? '超时'
          : '失败';
        if (!isAbort) {
          failureMessages.push(`${label}：${friendlyDetail}`);
        }
        setStrategyRuns2D((prev) =>
          prev.map((r) =>
            r.strategyId === runKey
              ? {
                  ...r,
                  state: isAbort ? 'CANCELLED' : 'FAILED',
                  phaseText: shortTag,
                  errorDetail: friendlyDetail
                }
              : r
          )
        );
      }
    })
  );

  if (createdSchemes.length === 0 && failureMessages.length > 0) {
    toast(failureMessages[0], true);
  }
  setRunningSolve(false);
}
