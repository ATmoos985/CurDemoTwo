import type { MutableRefObject } from 'react';
import type { SlittingSchemeRun } from '../../store/studioTypes';
import {
  SlittingProfile,
  extractSlittingSolverOptions,
  validateSlittingPhysicalConstraints
} from '../../store/studioSettings';
import {
  buildSlittingOptimizationRequest,
  extractSlittingKnifeMetrics,
  type UseWorkbenchSolverOptions
} from './solverRequestBuilders';
import { OptimizationSession } from '../../lib/domain/job-client.js';
import { independentBaseline, planSummary } from '../../lib/domain/linear-model.js';
import { toast } from '../../lib/core/util.js';
import type { LastConfirmSummary } from './workbenchTypes';

export async function executeSolve1D(
  opts: UseWorkbenchSolverOptions,
  activeSessionsRef: MutableRefObject<OptimizationSession[]>,
  callbacks: {
    setRunningSolve: (running: boolean) => void;
    setLastConfirmSummary: (summary: LastConfirmSummary | null) => void;
  }
) {
  const {
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
    slitMaxKnives = 0,
    slitMinBladeSpacingMm = 0,
    slitKerfMm = 0,
    slitForbiddenNarrowEdgeMinMm = 0,
    slitForbiddenNarrowEdgeMaxMm = 0,
    slitFixedLengthMm,
    scenario1D,
    currentRoll1D,
    setSlitSchemes,
    settings,
    batchGuardWarning
  } = opts;
  const { setRunningSolve, setLastConfirmSummary } = callbacks;

  if (batchGuardWarning?.blocking) {
    toast(`${batchGuardWarning.title}：${batchGuardWarning.detail}`, true);
    return;
  }
  let validOrders = slitOrders.filter((o) => o.quantity > 0 && o.widthMm > 0);
  if (!validOrders.length) {
    const retrial = slitOrders
      .filter((o) => (o.orderedQty || 0) > 0 && o.widthMm > 0)
      .map((o) => ({ ...o, quantity: o.orderedQty || 1 }));
    if (retrial.length > 0) {
      validOrders = retrial;
      toast('已排齐，按原单试算');
    } else {
      toast('请先载入或添加分条规格', true);
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
    toast('扣边后可用幅宽须 > 0 mm', true);
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
    toast(`组合宽 [${effMinW}, ${effMaxW}] 超出可切幅宽 ${maxUsable} mm`, true);
    return;
  }
  if (Math.floor((effMaxW - effMinW) / effStep) > 1000) {
    toast('候选宽档位超过 1000，请调大步长', true);
    return;
  }
  const maxOrderW = Math.max(...validOrders.map((o) => Math.floor(o.widthMm)));
  if (maxOrderW > effMaxW) {
    toast(`最大规格 ${maxOrderW} mm 超出上限 ${effMaxW} mm`, true);
    return;
  }
  const minOrderW = Math.min(...validOrders.map((o) => Math.floor(o.widthMm)));
  const physicalConstraints = {
    maxKnives: slitMaxKnives,
    minBladeSpacingMm: slitMinBladeSpacingMm,
    kerfMm: slitKerfMm,
    forbiddenNarrowEdgeMinMm: slitForbiddenNarrowEdgeMinMm,
    forbiddenNarrowEdgeMaxMm: slitForbiddenNarrowEdgeMaxMm
  };
  const physicalErr = validateSlittingPhysicalConstraints(physicalConstraints, minOrderW);
  if (physicalErr) {
    toast(physicalErr, true);
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
      strategyName: '独立分切',
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

    const profileLabel = (profile: SlittingProfile) =>
      profile === 'FAST' ? '快捷解' : '精确解';

    const makePending = (profile: SlittingProfile): SlittingSchemeRun => ({
      id: `SLIT-${profile}`,
      strategyId: profile,
      strategyName: profileLabel(profile),
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

    const liveRuns = new Map<SlittingProfile, SlittingSchemeRun>(
      runProfiles.map((prof) => [prof, makePending(prof)])
    );
    const sortSchemes = (list: SlittingSchemeRun[]) =>
      [...list].sort((a, b) => {
        const rank = (s: SlittingSchemeRun) =>
          s.state === 'SUCCEEDED' ? 0 : s.state === 'RUNNING' ? 1 : 2;
        const rDiff = rank(a) - rank(b);
        if (rDiff !== 0) return rDiff;
        if (a.state === 'SUCCEEDED' && b.state === 'SUCCEEDED') {
          if (a.totalCars !== b.totalCars) return a.totalCars - b.totalCars;
          return (a.patterns?.length ?? 0) - (b.patterns?.length ?? 0);
        }
        return 0;
      });

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
      const req = buildSlittingOptimizationRequest({
        profile,
        motherWidthMm: effMotherW,
        leftTrimMm: effLeftTrim,
        rightTrimMm: effRightTrim,
        minWidthMm: effMinW,
        maxWidthMm: effMaxW,
        widthStepMm: effStep,
        totalOverCap: effOverCap,
        timeLimitSeconds: effTimeLimit,
        fixedLengthMm: slitFixedLengthMm,
        orders: validOrders,
        advOpts,
        physicalConstraints
      });
      try {
        const { result } = await (session as any).solve(req, {
          onProgress: (j: any) => {
            const liveElapsed =
              typeof j?.elapsedMs === 'number' && Number.isFinite(j.elapsedMs)
                ? Math.round(j.elapsedMs)
                : Math.round(performance.now() - t0);
            const prevRun = liveRuns.get(profile) || makePending(profile);
            if (prevRun.state === 'RUNNING') {
              liveRuns.set(profile, {
                ...prevRun,
                elapsedMs: liveElapsed
              });
              const currentOrdered = sortSchemes(
                runProfiles.map((p) => liveRuns.get(p) || makePending(p))
              );
              setSlitSchemes([...currentOrdered, baselineRun]);
            }
          }
        });
        const s = result.slitting;
        const knifeMetrics = extractSlittingKnifeMetrics(s);
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
          strategyName: profileLabel(profile),
          state: 'SUCCEEDED',
          motherWidthMm: effMotherW,
          leftTrimMm: effLeftTrim,
          rightTrimMm: effRightTrim,
          totalCars,
          missingRolls,
          overproducedRolls,
          avgUtilizationPct: Number(utilMetric.toFixed(2)),
          estimatedKnifeChanges: knifeMetrics.estimatedKnifeChanges,
          knifeChangesSaved: knifeMetrics.knifeChangesSaved,
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
            ...(p.surfaceTreatment ? { surfaceTreatment: p.surfaceTreatment } : {}),
            ...(Array.isArray(p.allocations) && p.allocations.length > 0
              ? {
                  allocations: p.allocations.map((a: any) => ({
                    orderId: String(a.orderId),
                    quantity: Number(a.quantity ?? a.count) || 0
                  }))
                }
              : {})
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
          state: 'FAILED',
          errorMessage: e.message || '求解失败'
        };
      }
    };

    const results = await Promise.all(
      runProfiles.map((prof) =>
        runProfile(prof).then((done) => {
          liveRuns.set(prof, done);
          const currentOrdered = sortSchemes(
            runProfiles.map((p) => liveRuns.get(p) || makePending(p))
          );
          setSlitSchemes([...currentOrdered, baselineRun]);
          return done;
        })
      )
    );
    const orderedResults = sortSchemes(results);
    setSlitSchemes([...orderedResults, baselineRun]);
    const bestSolved = orderedResults.find((r) => r.state === 'SUCCEEDED');
    if (!bestSolved) {
      toast(orderedResults[0]?.errorMessage || '分切求解未返回有效方案', true);
    }
  } catch (e: any) {
    toast('求解失败：' + e.message, true);
  } finally {
    setRunningSolve(false);
  }
}
