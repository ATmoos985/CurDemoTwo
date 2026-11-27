import { fmtN } from '../../lib/core/util.js';
import { showcaseRequest } from '../../lib/model/showcase.js';
import { independentBaseline, planSummary } from '../../lib/domain/linear-model.js';
import {
  CapabilityCategory,
  SCENARIO_DOMAINS,
  ShowcaseMainTab,
  getCaseMeta
} from './showcaseCaseMeta';

export const METRIC_LABELS: Record<string, [string, string]> = {
  processingAreaUtilization: ['加工区占用率', '裁片净面积 / 本次加工区面积'],
  markerAreaUtilization: [
    '预计唛架利用率',
    '齐套衣片面积 / 实际唛架面积，排除未用尾料'
  ],
  motherAreaUtilization: [
    '预计产出面积占比',
    '含超产面积 / 母卷面积，含固定切边'
  ],
  usableAreaUtilization: [
    '可切区占用率',
    '含超产面积 / 扣除切边后的可用面积'
  ]
};

export interface CaseInputSummary {
  specText: string;
  pieceSummary: string;
  engineBadge: string;
}

export function summarizeCaseInput(c: any): CaseInputSummary {
  try {
    const req: any = showcaseRequest(c.id);
    const p: any = req.problem || {};
    if (c.kind === 'slitting') {
      const orders = p.orders || [];
      const totalRolls = orders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
      return {
        specText: `幅宽 ${fmtN(p.motherWidthMm)} mm`,
        pieceSummary: `${orders.length} 规格 · ${totalRolls} 条`,
        engineBadge: '1D 分切'
      };
    }
    const w = p.material?.shape?.width || 0;
    const h = p.material?.shape?.height || 0;
    const parts = p.parts || [];
    const totalPcs = parts.reduce((s: number, pt: any) => s + (pt.quantity || 0), 0);
    return {
      specText: `${fmtN(w)} × ${fmtN(h)} mm`,
      pieceSummary: `${parts.length} 类 · ${totalPcs} 件`,
      engineBadge: c.kind === 'marker' ? '齐套缩短' : p.process?.mode === 'CONTOUR' ? '2D 异形' : '2D 矩排'
    };
  } catch {
    return {
      specText: '标准规格',
      pieceSummary: '内置需求',
      engineBadge: c.kind === 'slitting' ? '1D 分切' : c.kind === 'marker' ? '齐套缩短' : '2D 排料'
    };
  }
}

export interface VerificationRecord {
  caseId: string;
  pass: boolean;
  badgeText: string;
  detailText: string;
  utilizationValue: number | null;
  elapsedMs: number;
  result: any;
  request: any;
}

export function evaluateCaseResult(
  c: any,
  req: any,
  res: any,
  elapsedMs: number
): VerificationRecord {
  const meta = getCaseMeta(c);
  const layout = res?.layout;
  const s = res?.slitting;
  const metrics = res?.metrics || [];
  const primaryMetric =
    metrics.find((m: any) => m.name === 'markerAreaUtilization') ||
    metrics.find((m: any) => m.name === 'processingAreaUtilization') ||
    metrics.find((m: any) => m.name === 'usableAreaUtilization') ||
    metrics[0];
  const utilVal =
    primaryMetric && Number.isFinite(Number(primaryMetric.value))
      ? Number(primaryMetric.value)
      : null;

  if (meta.expectUnplaced) {
    const placedCount = layout?.placements?.length ?? 0;
    const pass = placedCount === 0 && res?.fulfillmentStatus !== 'COMPLETE';
    return {
      caseId: c.id,
      pass,
      badgeText: pass ? '✓ 符合预期未排' : '断言偏差',
      detailText: pass
        ? `验证通过：禁止旋转下 900×600 mm 裁片未越界强排（排入 0 件），引擎正确返回未排原因（${elapsedMs} ms）。`
        : `预期排入 0 件，实际排入 ${placedCount} 件。`,
      utilizationValue: utilVal,
      elapsedMs,
      result: res,
      request: req
    };
  }

  if (s) {
    const totalCars = (s.patterns || []).reduce(
      (n: number, pat: any) => n + (pat.repetitions || 0),
      0
    );
    const pass = res?.fulfillmentStatus === 'COMPLETE' && totalCars > 0;
    return {
      caseId: c.id,
      pass,
      badgeText: pass
        ? `✓ ${totalCars} 车${utilVal != null ? ` · ${fmtN(utilVal, 1)}%` : ''}`
        : `未齐套 · ${totalCars} 车`,
      detailText: pass
        ? `验证通过：共 ${s.patterns.length} 组刀位组合、合计 ${totalCars} 车完成全部订单齐套（${elapsedMs} ms）。`
        : `计算结束：生成 ${totalCars} 车方案，存在部分未满足条数（${elapsedMs} ms）。`,
      utilizationValue: utilVal,
      elapsedMs,
      result: res,
      request: req
    };
  }

  const placedCount = layout?.placements?.length ?? 0;
  const minUtilOk =
    meta.minUtilization == null || (utilVal != null && utilVal >= meta.minUtilization);
  const pass = placedCount > 0 && minUtilOk;
  const utilStr = utilVal != null ? `${fmtN(utilVal, 1)}%` : `${placedCount} 件`;
  return {
    caseId: c.id,
    pass,
    badgeText: `${pass ? '✓' : '!'} ${utilStr}`,
    detailText: pass
      ? `验证通过：排入 ${placedCount} 件${
          utilVal != null ? `，${METRIC_LABELS[primaryMetric?.name]?.[0] || '利用率'} ${fmtN(utilVal, 2)}%` : ''
        }${
          res?.marker?.occupiedLengthMm != null
            ? `，最短齐套唛架 ${fmtN(res.marker.occupiedLengthMm)} mm`
            : ''
        }（${elapsedMs} ms）。`
      : `计算完成：排入 ${placedCount} 件${
          utilVal != null ? `，利用率 ${fmtN(utilVal, 2)}%` : ''
        }（${elapsedMs} ms）。`,
    utilizationValue: utilVal,
    elapsedMs,
    result: res,
    request: req
  };
}

export function matchesShowcaseCase(
  c: any,
  opts: {
    mainTab: ShowcaseMainTab;
    capFilter: CapabilityCategory;
    scenarioFilter: string;
    activeGroup: string;
    searchQuery: string;
  }
): boolean {
  const kindText =
    c.kind === 'marker'
      ? '齐套与用布优化'
      : c.kind === 'slitting'
      ? '独立分切 / 快速 / 精细'
      : '二维计算';
  const meta = getCaseMeta(c);
  const capMatch =
    opts.mainTab !== 'lab' || opts.capFilter === 'all' || meta.capGroup === opts.capFilter;
  const domainObj =
    opts.mainTab === 'scenario' && opts.scenarioFilter !== 'all'
      ? SCENARIO_DOMAINS.find((d) => d.id === opts.scenarioFilter)
      : null;
  const domainMatch = !domainObj || domainObj.groups.includes(c.group);
  const groupMatch = opts.activeGroup === 'all' || c.group === opts.activeGroup;
  const qLower = opts.searchQuery.trim().toLowerCase();
  const textMatch =
    !qLower ||
    `${kindText}${c.name}${c.note}打开用例 →${c.group}`
      .toLowerCase()
      .includes(qLower);
  return capMatch && domainMatch && groupMatch && textMatch;
}

export function buildSlittingCompareRows(
  problem: any,
  slitRuns: Record<string, any>
): (string | number)[][] {
  const p = problem || {};
  const oldInput = {
    motherWidth: p.motherWidthMm,
    leftTrim: p.leftTrimMm,
    rightTrim: p.rightTrimMm,
    orderItems: (p.orders || []).map((o: any) => ({
      width: o.widthMm,
      length: o.lengthMm,
      quantity: o.quantity,
      surfaceTreatment: o.surfaceTreatment
    }))
  };
  const baseline = planSummary(independentBaseline(oldInput), oldInput);
  return [
    ['逐规格独立分切', baseline.rolls, 0, 0],
    ...Object.entries(slitRuns).map(([prof, r]: [string, any]) => [
      prof === 'FAST' ? '快速搭切' : '精细优化',
      (r?.slitting?.patterns || []).reduce(
        (n: number, pat: any) => n + (pat.repetitions || 0),
        0
      ),
      (r?.slitting?.fulfillment || []).reduce(
        (n: number, f: any) => n + (f.missing || 0),
        0
      ),
      r?.slitting?.totalOverproduced ?? 0
    ])
  ];
}
