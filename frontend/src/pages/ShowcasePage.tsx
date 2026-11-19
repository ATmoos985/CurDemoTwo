import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtN } from '@static/app/js/util.js';
import { createRollCanvas } from '@static/app/js/canvas/roll-canvas.js';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  SHOWCASE_CASES,
  showcaseRequest,
  showcaseScene
} from '@static/app/js/model/showcase.js';
import { fulfillmentReason } from '@static/js/business/cutting/demand-progress-model.js';
import {
  independentBaseline,
  planSummary
} from '@static/js/linear/linear-model.js';
import {
  SegmentedControl,
  CodeBadge,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';
import { GarmentWidthPage } from './GarmentWidthPage';

const METRIC_LABELS: Record<string, [string, string]> = {
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

export type ShowcaseMainTab = 'lab' | 'scenario' | 'garment';
export type CapabilityCategory =
  | 'all'
  | '2d-guillotine'
  | '2d-contour'
  | '2d-marker'
  | '1d-slitting'
  | 'boundary';

interface CaseMeta {
  capGroup: Exclude<CapabilityCategory, 'all'>;
  capLabel: string;
  algorithm: string;
  scenario: string;
  why: string;
  verifyRule: string;
  smoke?: boolean;
  expectUnplaced?: boolean;
  minUtilization?: number;
}

const CASE_META: Record<string, CaseMeta> = {
  CROSSCUT: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 一阶段通幅横切（Crosscut Guillotine）',
    scenario: '窗帘定高/定宽整幅横切、家纺床品通幅直切',
    why: '验证最基础的通幅一刀切工艺：当裁片宽度等于母卷门幅时，检验引擎是否生成零纵向废料的极简通幅横切刀路。',
    verifyRule: '全部裁片 100% 排入，仅含通幅横切刀路，无碎片余料。',
    smoke: true
  },
  GUILLOTINE: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 多级断头台套裁 + 疵点禁入区避让',
    scenario: '验布后含局部瑕疵的窗帘母卷主帘与辅件混合套裁',
    why: '检验核心避疵与大小件套裁能力：左下方存在疵点禁入区时，主帘大件需自动避开疵点，同时利用上方通幅区与侧边余条套裁长条、辅片与挂带。',
    verifyRule: '4 类 8 件全排入、0 疵点干涉、通幅长条位于主帘上方、加工区占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  '3': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 余料短段多规格混排（Remnant Packing）',
    scenario: '车间裁床 2.4m 短料头回收后再利用，混排主帘、抱枕与绑带',
    why: '验证短料头高密度复用价值：在受限长度的余料上通过主件+多规格小辅件填空，降低短料头报废率。',
    verifyRule: '多规格裁片紧密填充短料段，加工区占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  '4': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 多级条带断头台精确刀序生成',
    scenario: '多窗户不同尺寸窗帘、侧帘与抱枕同卷合单套裁',
    why: '验证多规格矩形合单时的条带划分与可执行的贯通切刀序列（刀序 1→N），确保自动裁床或人工直刀可按序下刀。',
    verifyRule: '生成合法的贯通断头台刀路序列，点击「刀序」可逐步复核切刀路径。'
  },
  '6': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 固定裁床台面（3m 加工窗）单工位截断求解',
    scenario: '60m 长母卷在 3m 固定长度裁床上的单工位拉布排料',
    why: '验证超大订单超过单次拉布台面长度时，算法在单个工位窗口内的局部截断填充行为（多工位推进在正式工作台闭环完成）。',
    verifyRule: '仅在当前 3,000 mm 台面窗口内排入可容纳裁片，超出部分诚实记为待后续工位排产。'
  },
  CONTOUR: {
    capGroup: '2d-contour',
    capLabel: '异形轮廓与密排',
    algorithm: '2D 真实多边形包络与凹角互补嵌套（Polygon NFP Nesting）',
    scenario: '服装/箱包 L 形、斜边与非矩形异形样板排料',
    why: '对比外接矩形排料，验证引擎对非矩形折线轮廓的凹角嵌合能力，证明异形件可互相借位节省用布。',
    verifyRule: 'L 形与斜边异形片在同一个加工区内无重叠紧凑嵌合。',
    smoke: true
  },
  GARMENT_SHIRT: {
    capGroup: '2d-contour',
    capLabel: '异形轮廓与密排',
    algorithm: '2D 服装多部位异形样板定长台面高密填充',
    scenario: '衬衫/上衣 M、L 两码批量前后片、袖片、领片与袋布混排',
    why: '验证固定 1500×2400 mm 台面下，大面积衣身片与零碎领/袋小裁片的混合填空能力与高利用率表现。',
    verifyRule: '排入裁片数 ≥ 20 片，加工区占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  GARMENT_PANTS: {
    capGroup: '2d-contour',
    capLabel: '异形轮廓与密排',
    algorithm: '2D 细长梯形裤片与零散辅片互补密排',
    scenario: '长裤 M、L 两码前后裤片、腰头、裤袋与门襟同场套裁',
    why: '裤片呈上宽下窄斜边轮廓，容易产生三角空隙；本算例检验算法将腰头、袋布塞入裤腿斜边空隙的能力。',
    verifyRule: '排入裁片数 ≥ 20 片，加工区占用率 ≥ 70%。',
    minUtilization: 70
  },
  GARMENT_SKIRT: {
    capGroup: '2d-contour',
    capLabel: '异形轮廓与密排',
    algorithm: '2D 扇形/梯形裙片斜边正反互补排料',
    scenario: '半裙前后裙片与腰头样板排料',
    why: '验证宽下摆裙片在受限门幅内的交错排布与腰头窄条穿插效果。',
    verifyRule: '裙片与腰头在加工区内完整排入且轮廓零重叠。'
  },
  GARMENT_FULL: {
    capGroup: '2d-contour',
    capLabel: '异形轮廓与密排',
    algorithm: '2D 10 秒限时多启发式搜索密排',
    scenario: '高密度衣身与袖片大批量紧凑合排',
    why: '验证在 10 秒求解时间预算内，引擎对多件异形衣身与袖片的持续邻域搜索压紧能力。',
    verifyRule: '在限时内完成多轮搜索并返回高密度无重叠排料方案。'
  },
  BOARD_GRAIN: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 板材定长开料 · 纹理方向硬约束（0° 锁定）',
    scenario: '胡桃木/橡木等带天然木纹方向的家具板材开料',
    why: '与「素色板·允许旋转」构成成对对照：当木纹件禁止 90° 旋转时，检验算法是否严格保持所有木纹件方向一致。',
    verifyRule: '所有锁纹板件旋转角均为 0°，严格遵守木纹纹理方向约束。',
    smoke: true
  },
  BOARD_PLAIN: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    algorithm: '2D 板材定长开料 · 允许 90° 旋转优化',
    scenario: '密度板、素色颗粒板等无纹理方向要求的家具板材开料',
    why: '与「木纹板·禁止旋转」使用完全相同的订单输入，放开 90° 旋转权限，直观展示旋转自由度带来的排入率与利用率提升。',
    verifyRule: '同输入下利用 90° 旋转排入更多板件或获得更高板材利用率。'
  },
  film: {
    capGroup: '1d-slitting',
    capLabel: '一维分切与搭切',
    algorithm: '1D 列生成（Column Generation）+ 整数规划合卷搭切',
    scenario: '6000m 光学膜母卷多规格条宽同卷长订单合卷分切',
    why: '检验一维分切核心价值：对比传统「逐规格独立分切」需要开多卷，算法通过不同条宽组合搭切大幅减少开卷车数与边丝损耗。',
    verifyRule: '订单 100% 齐套（COMPLETE），搭切车数显著低于逐规格独立分切基线。',
    smoke: true
  },
  curtain: {
    capGroup: '1d-slitting',
    capLabel: '一维分切与搭切',
    algorithm: '1D 快速启发式搭切 vs 精细分支定界优化对比',
    scenario: '卷帘面料多订单条宽组合开条与超产控制',
    why: '验证一维求解器的「快速搭切（FAST）」与「精细优化（QUALITY）」双档位能力，并与独立分切基线同表对比车数、缺口与超产。',
    verifyRule: '支持切换快速搭切与精细优化，右侧自动生成三种方法对比表。'
  },
  board: {
    capGroup: '1d-slitting',
    capLabel: '一维分切与搭切',
    algorithm: '1D 2440mm 标准整板定长开条组合优化',
    scenario: '2440mm 标准建材板材按不同宽度批量开条',
    why: '验证一维分切模型在定长板材开条场景下的精确长度保持（2440 mm）与刀位宽度组合优化。',
    verifyRule: '全部开条需求 COMPLETE 齐套，单车段长精确保留 2,440 mm。'
  },
  'board-2m': {
    capGroup: '1d-slitting',
    capLabel: '一维分切与搭切',
    algorithm: '1D 2000mm 整米对照分切模型',
    scenario: '与 2440mm 板条相同条宽组合、改为 2000mm 整米定长的对照场景',
    why: '通过将卷长改为 2000 mm 整米，方便业务人员心算核对面积占比、切边损耗与超产面积口径。',
    verifyRule: '条宽组合与 2440mm 算例一致，段长按 2,000 mm 精确计量。'
  },
  'marker-GARMENT_SHIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（Marker Length Compaction）',
    scenario: '上衣 M/L 混码整套衣片（前片、后片、袖片、领片）齐套唛架',
    why: '服装排料不追求塞入残缺散片，而是要求「整件衣服所有部位一片不少」且用布最短；本算例验证多轮缩短试排找到最短齐套唛架长度。',
    verifyRule: 'M/L 所有部位 100% 齐套，记录每一轮试排长度与最终实际唛架长度。',
    smoke: true
  },
  'marker-GARMENT_PANTS': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（长裤全部位）',
    scenario: '长裤 M/L 混码（前后裤片、裤袋、腰头、门襟）齐套唛架',
    why: '验证细长裤片在保证 M/L 每套裤子全部位齐套前提下的最短唛架用布压缩能力。',
    verifyRule: '全部裤片与辅片齐套排入，输出多轮试排缩短轨迹与净用布长度。'
  },
  'marker-GARMENT_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（半裙）',
    scenario: '半裙 M/L 混码裙片与腰头齐套排料',
    why: '验证中小件服装款式的快速齐套收敛速度与尾料剔除计账口径。',
    verifyRule: '裙片与腰头 100% 齐套，未使用尾料不计入实际唛架用布。'
  },
  'marker-GARMENT_TANK': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（背心）',
    scenario: '背心 M/L 混码前后身片、领口与袖窿包边条齐套排料',
    why: '验证含细长包边条的针织背心款式在齐套约束下的边角穿插与总长缩短。',
    verifyRule: '主身片与全部包边条齐套排入，输出最短齐套唛架长度。'
  },
  'marker-GARMENT_SHORTS': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（短裤）',
    scenario: '短裤 M/L 混码前后裤片、松紧腰头与袋布齐套排料',
    why: '检验短裤多部位中等尺寸样板在 1500mm 门幅下的齐套紧凑度。',
    verifyRule: 'M/L 短裤全部衣片齐套排入，记录试排缩短过程。'
  },
  'marker-GARMENT_APRON': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 混码齐套二分缩短试排（围裙）',
    scenario: '工装围裙 M/L 混码主体片、前袋与长系带齐套排料',
    why: '围裙包含极细长的系带与大块围裙主体，检验算法将长系带嵌入主体侧边余隙以缩短总用布的能力。',
    verifyRule: '围裙主体、口袋与全部系带 100% 齐套排入。'
  },
  'marker-GARMENT_GORED_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 多片梯形裙幅正反互补齐套缩短',
    scenario: '六片裙 M/L 混码（每件 6 片梯形裙幅 + 腰头）齐套唛架',
    why: '六片裙由大量斜边梯形裁片组成，验证多片同形梯形件在齐套约束下的密集排布效果。',
    verifyRule: 'M/L 共 12 片裙幅及腰头全部齐套排入。'
  },
  'marker-GARMENT_GATHERED_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    algorithm: '2D 宽幅直裁裙幅与配件齐套缩短',
    scenario: '直裁抽褶裙 M/L 混码宽幅裙片与腰头齐套唛架',
    why: '验证接近门幅宽度的直裁大裙片与腰头辅件的齐套组合与长度压缩。',
    verifyRule: '全部裙幅与腰头齐套排入，无遗漏部位。'
  },
  'rotation-off': {
    capGroup: 'boundary',
    capLabel: '边界与规则对照',
    algorithm: '几何可行性前置校验 · 0° 旋转禁令阻断',
    scenario: '800×1200 mm 材料排入 900×600 mm 裁片（禁止旋转）',
    why: '防呆基准算例：裁片宽 900 mm 超过材料幅宽 800 mm，且工艺禁止旋转时，引擎绝不能越界强排或静默丢件，必须诚实返回「未排入」及具体原因。',
    verifyRule: '预期排入 0 件、缺口 1 件，并明确给出尺寸超限/禁止旋转的未排原因（属于符合预期的正向阻断）。',
    smoke: true,
    expectUnplaced: true
  },
  'rotation-on': {
    capGroup: 'boundary',
    capLabel: '边界与规则对照',
    algorithm: '几何可行性对照 · 开启 90° 旋转解锁排入',
    scenario: '800×1200 mm 材料排入 900×600 mm 裁片（允许 90° 旋转）',
    why: '与「旋转限制：未排入」严格成对：同一块 900×600 裁片仅打开 90° 旋转开关，旋转为 600×900 后即可合法排入 800×1200 材料。',
    verifyRule: '预期排入 1 件（旋转 90° 后尺寸 600×900 mm），需求 100% 齐套。',
    smoke: true
  },
  gap: {
    capGroup: 'boundary',
    capLabel: '边界与规则对照',
    algorithm: '2D 异形轮廓 10mm 固定刀缝安全间距膨胀校验',
    scenario: '自动裁床电刀/激光切割需预留 10mm 过刀安全间距的异形衣片排料',
    why: '检验工艺参数 `pieceGap = 10 mm` 在异形轮廓上的真实生效情况：既要保留衣片原始形状，又必须保证任意两片之间净距 ≥ 10 mm。',
    verifyRule: '生成带 10 mm 固定刀缝间隔的异形排料方案，无任何裁片间距小于 10 mm。'
  }
};

function getCaseMeta(c: any): CaseMeta {
  if (CASE_META[c.id]) return CASE_META[c.id];
  const capGroup: Exclude<CapabilityCategory, 'all'> =
    c.kind === 'slitting'
      ? '1d-slitting'
      : c.kind === 'marker'
      ? '2d-marker'
      : c.group === '边界与异常'
      ? 'boundary'
      : c.group === '服装'
      ? '2d-contour'
      : '2d-guillotine';
  return {
    capGroup,
    capLabel:
      capGroup === '1d-slitting'
        ? '一维分切与搭切'
        : capGroup === '2d-marker'
        ? '服装齐套缩短'
        : capGroup === 'boundary'
        ? '边界与规则对照'
        : capGroup === '2d-contour'
        ? '异形轮廓与密排'
        : '二维套裁与避疵',
    algorithm: c.kind === 'slitting' ? '1D 列生成分切优化' : '2D 排料优化',
    scenario: `${c.group} · ${c.name}`,
    why: c.note,
    verifyRule: '完成求解并返回合法排料方案与指标。'
  };
}

interface CaseInputSummary {
  specText: string;
  pieceSummary: string;
  engineBadge: string;
}

function summarizeCaseInput(c: any): CaseInputSummary {
  try {
    const req: any = showcaseRequest(c.id);
    const p: any = req.problem || {};
    if (c.kind === 'slitting') {
      const orders = p.orders || [];
      const totalRolls = orders.reduce((s: number, o: any) => s + (o.quantity || 0), 0);
      return {
        specText: `母卷幅宽 ${fmtN(p.motherWidthMm)} mm`,
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

interface VerificationRecord {
  caseId: string;
  pass: boolean;
  badgeText: string;
  detailText: string;
  utilizationValue: number | null;
  elapsedMs: number;
  result: any;
  request: any;
}

function evaluateCaseResult(
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
        ? `验证通过：一维分切共 ${s.patterns.length} 组刀位组合、合计 ${totalCars} 车完成全部订单齐套（${elapsedMs} ms）。`
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
      ? `验证通过：成功排入 ${placedCount} 件${
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

const SCENARIO_DOMAINS = [
  {
    id: '窗帘 · 家纺',
    title: '窗帘 · 家纺定制',
    subtitle: '定高通幅横切、验布疵点避让、大小件套裁与裁床短料头复用',
    painPoint: '解决家纺门幅宽、主帘面积大、局部瑕疵多、尾料短段难复用四大车间痛点。',
    groups: ['窗帘 · 家纺']
  },
  {
    id: '服装 · 异形与齐套',
    title: '服装 · 异形与齐套唛架',
    subtitle: '异形折线轮廓凹角密排、M/L 混码全部位齐套与二分缩短用布',
    painPoint: '解决服装多尺码混排必须整件齐套（不缺袖/领/袋）且不断压缩唛架总长的核心诉求。',
    groups: ['服装', '服装齐套']
  },
  {
    id: '板材',
    title: '板材 · 开料与纹理方向',
    subtitle: '木纹板 0° 锁纹方向开料 vs 素色板 90° 旋转自由度同输入对照',
    painPoint: '直观对比纹理方向硬约束与允许 90° 旋转对开料排入率与板材利用率的影响。',
    groups: ['板材']
  },
  {
    id: '卷材 · 薄膜',
    title: '卷材 · 薄膜与板条分切',
    subtitle: '光学膜、卷帘面料与定长板条的一维列生成合卷搭切 vs 独立分切基线',
    painPoint: '将多规格条宽订单合卷同切，显著降低开卷车数、换刀次数与边丝废料。',
    groups: ['卷材 · 薄膜']
  },
  {
    id: '边界与异常',
    title: '边界与工艺规则对照',
    subtitle: '尺寸超限禁止旋转阻断、90° 旋转解锁对照、10mm 固定刀缝安全间距',
    painPoint: '验证算法在几何不可行时的防呆诚实阻断，以及刀缝间距等硬性工艺参数的严格执行。',
    groups: ['边界与异常']
  }
];

export const ShowcasePage: React.FC<{ params?: string[]; groupQuery?: string }> = ({
  params = [],
  groupQuery = ''
}) => {
  const [caseIdParam] = params;

  // Top-level 3 tabs: 算法工作台 ('lab') | 场景空间 ('scenario') | 多门幅工艺对比 ('garment')
  const [mainTab, setMainTab] = useState<ShowcaseMainTab>('lab');

  // Capability category filter in Algorithm Workbench
  const [capFilter, setCapFilter] = useState<CapabilityCategory>('all');
  // Industry group filter (also syncs with legacy ?group= query)
  const [activeGroup, setActiveGroup] = useState<string>(
    groupQuery && groupQuery !== '__workflow__' ? groupQuery : 'all'
  );
  // Active scenario domain in Scenario Space
  const [scenarioDomainId, setScenarioDomainId] = useState<string>('窗帘 · 家纺');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Currently active case in the live CAD workbench (always defaults to a valid case so the workbench is live on #/showcase)
  const [activeCaseId, setActiveCaseId] = useState<string>(
    () =>
      (caseIdParam && SHOWCASE_CASES.some((c: any) => c.id === caseIdParam)
        ? caseIdParam
        : SHOWCASE_CASES[0]?.id) || 'CROSSCUT'
  );

  useEffect(() => {
    if (caseIdParam && SHOWCASE_CASES.some((c: any) => c.id === caseIdParam)) {
      setActiveCaseId(caseIdParam);
    }
  }, [caseIdParam]);

  useEffect(() => {
    if (groupQuery && groupQuery !== '__workflow__') {
      setActiveGroup(groupQuery);
      const matchedDomain = SCENARIO_DOMAINS.find((d) =>
        d.groups.includes(groupQuery)
      );
      if (matchedDomain) {
        setScenarioDomainId(matchedDomain.id);
      }
      const firstInGroup = SHOWCASE_CASES.find((c: any) => c.group === groupQuery);
      if (firstInGroup && !caseIdParam) {
        setActiveCaseId(firstInGroup.id);
      }
    } else {
      setActiveGroup('all');
    }
  }, [groupQuery, caseIdParam]);

  const selected = useMemo(
    () =>
      SHOWCASE_CASES.find((c: any) => c.id === activeCaseId) ||
      SHOWCASE_CASES[0],
    [activeCaseId]
  );

  const caseInputSummaries = useMemo(() => {
    const map: Record<string, CaseInputSummary> = {};
    for (const c of SHOWCASE_CASES) {
      map[c.id] = summarizeCaseInput(c);
    }
    return map;
  }, []);

  // Detail solver state for the active case
  const [request, setRequest] = useState<any>(() =>
    selected ? showcaseRequest(selected.id) : null
  );
  const [result, setResult] = useState<any>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [cancelledHint, setCancelledHint] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [stateText, setStateText] = useState<string>('待计算');
  const [patternIndex, setPatternIndex] = useState<number>(0);
  const [vertical, setVertical] = useState<boolean>(true);
  const [showPath, setShowPath] = useState<boolean>(false);
  const [selectionText, setSelectionText] = useState<string>(
    '滚轮缩放，拖动平移；右键查看裁片尺寸。'
  );
  const [slitRuns, setSlitRuns] = useState<Record<string, any>>({});

  // Cached verification records across cases (populated by single solve or batch 一键快检)
  const [verifications, setVerifications] = useState<
    Record<string, VerificationRecord>
  >({});
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const [batchProgressText, setBatchProgressText] = useState<string>('');
  const batchAbortRef = useRef<number>(0);

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const tokenRef = useRef<number>(0);
  const stateRef = useRef({ request, result, patternIndex });
  stateRef.current = { request, result, patternIndex };

  // Mount / update Konva CAD canvas when selected case or mainTab changes
  useEffect(() => {
    if (mainTab === 'garment' || !selected) {
      tokenRef.current++;
      sessionRef.current?.cancel();
      canvasRef.current?.destroy();
      canvasRef.current = null;
      return;
    }

    const cached = verifications[selected.id];
    const initReq = cached?.request || showcaseRequest(selected.id);
    const initRes = cached?.result || null;

    setRequest(initReq);
    setResult(initRes);
    setErrorText(null);
    setCancelledHint(false);
    setBusy(false);
    setStateText(
      initRes
        ? `${
            initRes.fulfillmentStatus === 'COMPLETE'
              ? '计算完成 · 齐套'
              : '计算结束 · 未齐套'
          }`
        : '待计算'
    );
    setPatternIndex(0);
    setVertical(true);
    setShowPath(false);
    setSlitRuns(initRes && selected.kind === 'slitting' ? { FAST: initRes } : {});
    setSelectionText('滚轮缩放，拖动平移；右键查看裁片尺寸。');

    let disposed = false;
    sessionRef.current = new (OptimizationSession as any)(
      undefined,
      150,
      (err?: any) => {
        if (!disposed) setStateText('未确认停止：' + (err?.message || ''));
      }
    );

    if (canvasHostRef.current) {
      canvasRef.current?.destroy();
      canvasRef.current = createRollCanvas(canvasHostRef.current, {
        onContextMenu: (hit: any) => {
          const st = stateRef.current;
          if (!st.request) return;
          const sc = showcaseScene(st.request, st.result, st.patternIndex);
          const piece = sc.segments[0]?.pieces?.find(
            (p: any) => p.id === hit?.entityId
          );
          setSelectionText(
            piece
              ? `${piece.label} · X ${fmtN(piece.v, 1)} / Y ${fmtN(
                  piece.u,
                  1
                )} mm · ${fmtN(piece.dv, 1)} × ${fmtN(piece.du, 1)} mm`
              : '右键查看裁片尺寸。'
          );
        }
      });
      canvasRef.current.setScene(showcaseScene(initReq, initRes, 0), {
        refit: true
      });
    }

    return () => {
      disposed = true;
      tokenRef.current++;
      sessionRef.current?.cancel();
      canvasRef.current?.destroy();
      canvasRef.current = null;
    };
  }, [selected?.id, mainTab]);

  useEffect(() => {
    if (mainTab === 'garment' || !selected || !request || !canvasRef.current) return;
    canvasRef.current.setScene(showcaseScene(request, result, patternIndex), {
      refit: true
    });
  }, [selected, request, result, patternIndex, mainTab]);

  const handleRun = async (profile = 'FAST') => {
    if (!selected || busy) return;
    const mine = ++tokenRef.current;
    const nextReq = showcaseRequest(selected.id, profile);
    setRequest(nextReq);
    setResult(null);
    setErrorText(null);
    setCancelledHint(false);
    setPatternIndex(0);
    setBusy(true);
    setStateText('正在提交计算…');
    const t0 = performance.now();
    try {
      const response = await sessionRef.current.solve(nextReq, {
        onProgress: (j: any) => {
          if (mine === tokenRef.current) {
            setStateText(j.message || j.phase || j.state);
          }
        }
      });
      if (mine !== tokenRef.current) return;
      const res = response.result;
      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
      setResult(res);
      if (selected.kind === 'slitting') {
        setSlitRuns((prev) => ({ ...prev, [profile]: res }));
      }
      const record = evaluateCaseResult(selected, nextReq, res, elapsedMs);
      setVerifications((prev) => ({ ...prev, [selected.id]: record }));
      setStateText(
        `${
          res.fulfillmentStatus === 'COMPLETE'
            ? '计算完成 · 齐套'
            : '计算结束 · 未齐套'
        }${response.job.state !== 'SUCCEEDED' ? ' · 搜索提前结束' : ''}`
      );
    } catch (e: any) {
      if (mine !== tokenRef.current) return;
      if (e.name === 'AbortError') {
        setStateText('已停止计算');
      } else {
        setStateText('计算未完成，可重试');
        setErrorText(e.message);
      }
    } finally {
      if (mine === tokenRef.current) {
        setBusy(false);
      }
    }
  };

  const handleCancel = () => {
    tokenRef.current++;
    sessionRef.current?.cancel();
    if (batchRunning) {
      batchAbortRef.current++;
      setBatchRunning(false);
      setBatchProgressText('已停止批量快检');
    }
    setBusy(false);
    setStateText('已请求停止计算');
    setResult(null);
    setErrorText(null);
    setCancelledHint(true);
  };

  // 一键快检：依次求解指定算例集，实时回填通过状态、利用率与耗时
  const handleBatchVerify = async (targetCases: any[]) => {
    if (!targetCases.length || batchRunning || busy) return;
    const batchToken = ++batchAbortRef.current;
    setBatchRunning(true);
    for (let i = 0; i < targetCases.length; i++) {
      if (batchToken !== batchAbortRef.current) break;
      const c = targetCases[i];
      setActiveCaseId(c.id);
      setBatchProgressText(`正在快检 ${i + 1} / ${targetCases.length}：${c.name}`);
      const req = showcaseRequest(c.id, 'FAST');
      setRequest(req);
      setResult(null);
      setErrorText(null);
      setPatternIndex(0);
      setBusy(true);
      setStateText(`快检 (${i + 1}/${targetCases.length}) · ${c.name}…`);
      const t0 = performance.now();
      try {
        const tempSession = new (OptimizationSession as any)(undefined, 120);
        sessionRef.current = tempSession;
        const response = await tempSession.solve(req, {});
        if (batchToken !== batchAbortRef.current) break;
        const res = response.result;
        const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
        const record = evaluateCaseResult(c, req, res, elapsedMs);
        setVerifications((prev) => ({ ...prev, [c.id]: record }));
        setResult(res);
        setStateText(
          `${
            res.fulfillmentStatus === 'COMPLETE'
              ? '计算完成 · 齐套'
              : '计算结束 · 未齐套'
          }`
        );
      } catch (e: any) {
        if (batchToken !== batchAbortRef.current) break;
        setErrorText(e.message || '快检异常');
      } finally {
        setBusy(false);
      }
    }
    if (batchToken === batchAbortRef.current) {
      setBatchRunning(false);
      setBatchProgressText(`已完成 ${targetCases.length} 项算例快检`);
    }
  };

  const handleDownloadJson = (suffix: string, value: any) => {
    if (!selected || !value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.id}-${suffix}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const qLower = searchQuery.trim().toLowerCase();

  // Keep exact search matching semantics so searching '旋转' matches the 4 rotation cases
  const matchesCase = (c: any) => {
    const kindText =
      c.kind === 'marker'
        ? '齐套与用布优化'
        : c.kind === 'slitting'
        ? '独立分切 / 快速 / 精细'
        : '二维计算';
    const meta = getCaseMeta(c);
    const capMatch = capFilter === 'all' || meta.capGroup === capFilter;
    const groupMatch = activeGroup === 'all' || c.group === activeGroup;
    const textMatch =
      !qLower ||
      `${kindText}${c.name}${c.note}打开用例 →${c.group}`
        .toLowerCase()
        .includes(qLower);
    return capMatch && groupMatch && textMatch;
  };

  const visibleCases = useMemo(
    () => SHOWCASE_CASES.filter((c: any) => matchesCase(c)),
    [capFilter, activeGroup, qLower]
  );

  const smokeCases = useMemo(
    () => SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).smoke),
    []
  );

  const verifiedList = Object.values(verifications);
  const verifiedPassCount = verifiedList.filter((v) => v.pass).length;

  const mainTabOptions: SegmentedOption<ShowcaseMainTab>[] = [
    {
      value: 'lab',
      label: '算法工作台',
      count: SHOWCASE_CASES.length,
      accent: 'indigo',
      title: '按算法能力分类、核对设计目的与预期规则、一键批量快检与原地求解'
    },
    {
      value: 'scenario',
      label: '场景空间',
      count: SCENARIO_DOMAINS.length,
      title: '按窗帘家纺、服装齐套、板材开料、卷材分切与边界规则体验真实行业裁切场景'
    },
    {
      value: 'garment',
      label: '多门幅工艺对比',
      title: '服装多候选门幅单耗、利用率、掉头与尾料补片对比试算'
    }
  ];

  const capFilterOptions: SegmentedOption<CapabilityCategory>[] = useMemo(
    () => [
      { value: 'all', label: '全部', count: SHOWCASE_CASES.length },
      {
        value: '2d-guillotine',
        label: '二维套裁与避疵',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-guillotine').length
      },
      {
        value: '2d-contour',
        label: '异形与密排',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-contour').length
      },
      {
        value: '2d-marker',
        label: '服装齐套缩短',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '2d-marker').length
      },
      {
        value: '1d-slitting',
        label: '一维分切搭切',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === '1d-slitting').length
      },
      {
        value: 'boundary',
        label: '边界对照',
        count: SHOWCASE_CASES.filter((c: any) => getCaseMeta(c).capGroup === 'boundary').length
      }
    ],
    []
  );

  const slit = selected?.kind === 'slitting';
  const p = request?.problem || {};
  const inputRows = slit
    ? (p.orders || []).map((o: any) => [
        o.id,
        o.widthMm,
        o.lengthMm,
        o.quantity
      ])
    : (p.parts || []).map((o: any) => [
        o.name,
        o.shape.width,
        o.shape.height,
        o.quantity
      ]);
  const currentSc = request ? showcaseScene(request, result, patternIndex) : null;
  const activeMeta = selected ? getCaseMeta(selected) : null;
  const activeVerification = selected ? verifications[selected.id] : undefined;
  const activeScenarioDomain =
    SCENARIO_DOMAINS.find((d) => d.id === scenarioDomainId) || SCENARIO_DOMAINS[0];

  // Shared right-hand Live CAD & Verification Workbench (used in both 'lab' and 'scenario' tabs)
  const renderLiveWorkbench = () => {
    if (!selected || !activeMeta) return null;
    const summary = caseInputSummaries[selected.id];

    return (
      <div className="mp-lab-main">
        {/* Top Purpose & Verification Card: 展示算法能力、适用场景、为什么要做这个算例、预期检验规则 */}
        <section className="mp-lab-brief mp-float-card" aria-label="算例设计目的与检验标准">
          <div className="mp-lab-brief-top">
            <div className="mp-lab-title-group">
              <span className="tag kind">{summary?.engineBadge}</span>
              <h2>{selected.name}</h2>
              <CodeBadge>{selected.id}</CodeBadge>
              <span className="mp-lab-meta-chip num">
                {selected.group} · {summary?.specText} · {summary?.pieceSummary}
              </span>
            </div>
            <div className="mp-lab-top-status">
              {activeVerification ? (
                <span
                  className={`tag ${activeVerification.pass ? 'ok' : 'warn'} num`}
                  title={activeVerification.detailText}
                >
                  {activeVerification.badgeText} · {activeVerification.elapsedMs} ms
                </span>
              ) : (
                <span className="tag">计算预览 · 不扣库存</span>
              )}
            </div>
          </div>

          <div className="mp-lab-why-grid">
            <div className="mp-lab-why-item">
              <span className="mp-lab-why-kicker">算法能力与适用场景</span>
              <strong>{activeMeta.algorithm}</strong>
              <p>{activeMeta.scenario}</p>
            </div>
            <div className="mp-lab-why-item">
              <span className="mp-lab-why-kicker">为什么要做这个算例（设计目的）</span>
              <p>{activeMeta.why}</p>
            </div>
            <div
              className={`mp-lab-why-item mp-lab-verify-box ${
                activeVerification ? (activeVerification.pass ? 'is-pass' : 'is-warn') : ''
              }`}
            >
              <span className="mp-lab-why-kicker">
                {activeVerification ? '快速检验实测结论' : '快速检验预期标准'}
              </span>
              <p className="num">
                {activeVerification ? activeVerification.detailText : activeMeta.verifyRule}
              </p>
            </div>
          </div>
        </section>

        {/* Center CAD Viewport + Right Input/Result Inspector */}
        <div className="mp-lab-workspace">
          <section className="pane mp-cad-card mp-demo-canvas-card">
            <div className="mp-cad-head">
              <span className="mp-cad-title">
                {slit ? '一维定长横切刀位示意' : '实时 CAD 排料与禁入区视口'}
              </span>
              <span className="mp-cad-sub num">
                {result
                  ? '已生成排料图 · 右键点击裁片查坐标'
                  : '待求解预览（显示原材料边界与疵点禁入区）'}
              </span>
              <span className="sp" />
              <button
                type="button"
                className="mp-cad-btn"
                id="demo-fit"
                onClick={() => canvasRef.current?.fit()}
              >
                适合窗口
              </button>
              <button
                type="button"
                className="mp-cad-btn"
                id="demo-rotate"
                onClick={() => {
                  const next = !vertical;
                  setVertical(next);
                  canvasRef.current?.setOptions({ vertical: next });
                }}
              >
                横 / 竖
              </button>
              <button
                type="button"
                className="mp-cad-btn"
                id="demo-path"
                aria-pressed={showPath}
                disabled={slit || p.process?.mode === 'CONTOUR'}
                title={
                  slit || p.process?.mode === 'CONTOUR'
                    ? '此演示没有可执行刀序'
                    : undefined
                }
                onClick={() => {
                  const next = !showPath;
                  setShowPath(next);
                  canvasRef.current?.setOptions({ showPath: next });
                }}
              >
                刀序
              </button>
            </div>
            <div
              ref={canvasHostRef}
              id="demo-canvas"
              className="demo-canvas"
              tabIndex={0}
              aria-label="演示排料画布"
            />
            <div className="mp-cad-foot" id="demo-selection">
              {selectionText}
            </div>
          </section>

          {/* Right Inspector: Result Verification (#demo-result) + Input Specification (#demo-input) */}
          <div className="mp-lab-inspector">
            <section className="pane mp-float-card mp-lab-result-card">
              <div className="pane-h">
                <span>求解结果与检验对账</span>
                {activeVerification && (
                  <span className="sub num">{activeVerification.elapsedMs} ms</span>
                )}
              </div>
              <div className="pane-b" id="demo-result">
                {busy ? (
                  <div className="empty">正在调用引擎求解…</div>
                ) : errorText ? (
                  <div className="error-box" role="alert">
                    {errorText}
                  </div>
                ) : cancelledHint ? (
                  <div className="empty">本次计算已停止，可重新点击下方按钮计算。</div>
                ) : !result ? (
                  <div className="mp-lab-unrun">
                    <strong>尚未执行求解</strong>
                    <p>
                      当前画布展示原材料轮廓与疵点禁入区。点击右下角「
                      {slit ? '快速搭切' : '开始计算'}」立即在原地生成排料方案并核对预期断言。
                    </p>
                  </div>
                ) : (
                  (() => {
                    const layout = result.layout;
                    const s = result.slitting;
                    const fulfilled = s?.fulfillment || layout?.fulfillment || [];
                    const count = s
                      ? s.patterns.reduce(
                          (n: number, pat: any) => n + pat.repetitions,
                          0
                        )
                      : layout.placements.length;
                    let compareRows: any[] = [];
                    if (s) {
                      const oldInput = {
                        motherWidth: p.motherWidthMm,
                        leftTrim: p.leftTrimMm,
                        rightTrim: p.rightTrimMm,
                        orderItems: p.orders.map((o: any) => ({
                          width: o.widthMm,
                          length: o.lengthMm,
                          quantity: o.quantity,
                          surfaceTreatment: o.surfaceTreatment
                        }))
                      };
                      const baseline = planSummary(
                        independentBaseline(oldInput),
                        oldInput
                      );
                      compareRows = [
                        ['逐规格独立分切', baseline.rolls, 0, 0],
                        ...Object.entries(slitRuns).map(
                          ([prof, r]: [string, any]) => [
                            prof === 'FAST' ? '快速搭切' : '精细优化',
                            r.slitting.patterns.reduce(
                              (n: number, pat: any) => n + pat.repetitions,
                              0
                            ),
                            r.slitting.fulfillment.reduce(
                              (n: number, f: any) => n + f.missing,
                              0
                            ),
                            r.slitting.totalOverproduced
                          ]
                        )
                      ];
                    }

                    return (
                      <>
                        <div className="metric">
                          <div>
                            <small>{slit ? '计划车数' : '已排裁片'}</small>
                            <b>
                              {count}
                              <em>{slit ? '车' : '件'}</em>
                            </b>
                          </div>
                          <div>
                            <small>需求完成状态</small>
                            <strong>
                              {activeMeta.expectUnplaced && count === 0
                                ? '符合预期阻断'
                                : result.fulfillmentStatus === 'COMPLETE'
                                ? '齐套'
                                : '未齐套'}
                            </strong>
                          </div>
                        </div>
                        <div className="demo-note">
                          {layout?.message || ''}
                          {result.fulfillmentStatus !== 'COMPLETE'
                            ? activeMeta.expectUnplaced
                              ? ' 尺寸超限且禁止旋转，引擎按预期阻断排入。'
                              : ' 请核对缺口；不能作为齐套完成。'
                            : ''}
                        </div>
                        <div className="mp-table-scroll">
                          <table className="t">
                            <thead>
                              <tr>
                                <th>需求</th>
                                <th>已排 / 需求</th>
                                <th>缺口</th>
                              </tr>
                            </thead>
                            <tbody>
                              {fulfilled.map((f: any, idx: number) => (
                                <React.Fragment key={idx}>
                                  <tr>
                                    <td className="wrap">
                                      {p.parts?.find(
                                        (pt: any) => pt.id === f.demandId
                                      )?.name ||
                                        f.orderId ||
                                        f.demandId}
                                    </td>
                                    <td className="num">
                                      {f.placed ?? f.produced ?? 0} / {f.requested}
                                    </td>
                                    <td className="num">
                                      {f.missing ?? f.unplaced ?? 0}
                                    </td>
                                  </tr>
                                  {f.reason &&
                                    Boolean(f.unplaced || f.missing) && (
                                      <tr>
                                        <td colSpan={3} className="wrap muted">
                                          <small>{fulfillmentReason(f.reason)}</small>
                                        </td>
                                      </tr>
                                    )}
                                </React.Fragment>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {s && (
                          <>
                            <div className="sec">分切组合（点击切换单车刀位图）</div>
                            {s.patterns.map((pat: any, i: number) => (
                              <button
                                key={pat.id || i}
                                type="button"
                                className={`btn demo-pattern ${
                                  patternIndex === i ? 'on' : ''
                                }`}
                                data-pattern={i}
                                onClick={() => setPatternIndex(i)}
                              >
                                {i + 1}.{' '}
                                {pat.stations
                                  .map(
                                    (v: any) =>
                                      `${v.widthMm}×${v.countPerRepetition}`
                                  )
                                  .join(' + ')}{' '}
                                · {pat.repetitions} 车
                              </button>
                            ))}
                            <div id="demo-compare">
                              <div className="sec">同一输入对比</div>
                              <div className="mp-table-scroll">
                                <table className="t">
                                  <thead>
                                    <tr>
                                      <th>方法</th>
                                      <th>车数</th>
                                      <th>缺口</th>
                                      <th>超产</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {compareRows.map((row, rIdx) => (
                                      <tr key={rIdx}>
                                        {row.map((v: any, cIdx: number) => (
                                          <td key={cIdx}>{v}</td>
                                        ))}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </>
                        )}

                        {result.marker && (
                          <>
                            <div className="sec">齐套缩短记录</div>
                            <ol className="demo-steps">
                              {result.marker.trials.map((t: any, idx: number) => (
                                <li key={idx}>
                                  {fmtN(t.lengthMm)} mm：
                                  {t.complete
                                    ? `齐套，占用 ${fmtN(t.occupiedLengthMm)} mm`
                                    : `未齐套，排入 ${t.placed} 件`}
                                </li>
                              ))}
                            </ol>
                            <p className="demo-note">
                              {result.marker.occupiedLengthMm != null
                                ? `实际唛架 ${fmtN(
                                    result.marker.occupiedLengthMm
                                  )} mm；未使用尾料不计入用布。`
                                : '本次搜索未形成齐套唛架。'}
                            </p>
                          </>
                        )}

                        <div className="sec">指标与口径</div>
                        {(result.metrics || []).map((m: any) => (
                          <div key={m.name} className="demo-note">
                            {METRIC_LABELS[m.name]?.[0] || m.name}：
                            <b className="num">
                              {fmtN(m.value, 3)} {m.unit}
                            </b>
                            <br />
                            <small>{METRIC_LABELS[m.name]?.[1] || m.basis}</small>
                          </div>
                        ))}
                      </>
                    );
                  })()
                )}
              </div>
            </section>

            <section className="pane mp-float-card mp-lab-input-card">
              <div className="pane-h">
                <span>输入材料与需求清单</span>
                <span className="sub num">{inputRows.length} 项</span>
              </div>
              <div className="pane-b" id="demo-input">
                <div className="kv">
                  <div>材料幅宽</div>
                  <div className="num">
                    {fmtN(slit ? p.motherWidthMm : p.material?.shape?.width)} mm
                  </div>
                  <div>{slit ? '切边 左 / 右' : '加工长度'}</div>
                  <div className="num">
                    {slit
                      ? `${p.leftTrimMm} / ${p.rightTrimMm}`
                      : fmtN(p.material?.shape?.height)}{' '}
                    mm
                  </div>
                </div>
                {slit && currentSc && (
                  <div className="demo-note">
                    图示段长 {fmtN(currentSc.roll.total)} mm；订单卷长见下表，图示不展开整卷。
                  </div>
                )}
                <div className="mp-table-scroll">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>需求</th>
                        <th>宽×长 mm</th>
                        <th>数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inputRows.map((r: any, idx: number) => (
                        <tr key={idx}>
                          <td className="wrap">{r[0]}</td>
                          <td className="num">
                            {fmtN(r[1])}×{fmtN(r[2])}
                          </td>
                          <td className="num">{r[3]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <details className="demo-note">
                  <summary>查看请求契约 JSON</summary>
                  <pre>{JSON.stringify(request, null, 2)}</pre>
                </details>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="react-page page-host mp-showcase-page mp-showcase-v2">
      {/* Top Unified Header with 3 Main Tabs */}
      <div className="mp-sc-topbar mp-sc-header-v2">
        <div className="mp-sc-brand-title">
          <h1>能力展示</h1>
          <span className="mp-sc-sub num">
            算法工作台与行业场景空间 · {SHOWCASE_CASES.length} 个标准算例 · 试算不扣减真实库存
          </span>
        </div>

        <SegmentedControl
          options={mainTabOptions}
          value={mainTab}
          onChange={(next) => setMainTab(next)}
          ariaLabel="切换算法工作台、场景空间与多门幅工艺对比"
        />

        <span className="sp" />

        {mainTab !== 'garment' && (
          <div className="mp-sc-quick-actions">
            {verifiedList.length > 0 && (
              <span className="mp-verify-summary num">
                已检 {verifiedList.length}/{SHOWCASE_CASES.length} · 通过{' '}
                <b>{verifiedPassCount}</b>
              </span>
            )}
            {batchRunning ? (
              <button
                type="button"
                className="btn sm"
                onClick={handleCancel}
              >
                停止快检 ({batchProgressText})
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="mp-ghost-btn"
                  disabled={busy}
                  onClick={() => handleBatchVerify(smokeCases)}
                  title="自动依次求解 8 个核心冒烟算例（覆盖横切、避疵、料头、异形、服装、木纹、一维分切、旋转阻断）"
                >
                  一键快检核心集 ({smokeCases.length})
                </button>
                <button
                  type="button"
                  className="mp-ghost-btn"
                  disabled={busy || visibleCases.length === 0}
                  onClick={() => handleBatchVerify(visibleCases)}
                  title="对当前筛选列表中的全部算例依次求解并核对断言"
                >
                  快检当前列表 ({visibleCases.length})
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {mainTab === 'garment' ? (
        <div className="mp-sc-garment-host">
          <GarmentWidthPage embedded />
        </div>
      ) : (
        <>
          <div className="mp-sc-body">
            {/* Left Sidebar: switches between Algorithm Workbench Directory ('lab') and Industry Scenario Showroom ('scenario') */}
            <aside
              className={`mp-lab-sidebar mp-float-card ${
                mainTab === 'scenario' ? 'is-scenario-mode' : ''
              }`}
              aria-label={mainTab === 'lab' ? '算法算例目录' : '行业场景空间目录'}
            >
              {mainTab === 'lab' ? (
                <>
                  <div className="mp-lab-side-head">
                    <div className="mp-search-wrap mp-lab-search">
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
                        className="mp-search-input"
                        id="case-search"
                        type="search"
                        aria-label="查找用例"
                        placeholder="搜索算法能力、行业或边界规则"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>

                    <div className="mp-lab-cap-pills" id="case-tabs" role="group" aria-label="按算法能力筛选">
                      {capFilterOptions.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`mp-cap-pill ${
                            capFilter === opt.value && activeGroup === 'all' ? 'on' : ''
                          }`}
                          onClick={() => {
                            setCapFilter(opt.value);
                            setActiveGroup('all');
                          }}
                        >
                          <span>{opt.label}</span>
                          <em className="num">{opt.count}</em>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mp-lab-case-list" id="case-catalogue">
                    {SHOWCASE_CASES.map((c: any) => {
                      const meta = getCaseMeta(c);
                      const sum = caseInputSummaries[c.id];
                      const ver = verifications[c.id];
                      const isHidden = !matchesCase(c);
                      const isActive = selected?.id === c.id;
                      return (
                        <a
                          key={c.id}
                          className={`mp-lab-case-row demo-card ${isActive ? 'on' : ''}`}
                          data-case={c.id}
                          href={`#/showcase/${encodeURIComponent(c.id)}`}
                          hidden={isHidden}
                          onClick={() => setActiveCaseId(c.id)}
                        >
                          <div className="mp-lab-row-top">
                            <span className="tag kind">{sum?.engineBadge}</span>
                            <strong className="mp-lab-row-title">{c.name}</strong>
                            {ver ? (
                              <span
                                className={`mp-lab-ver-badge num ${
                                  ver.pass ? 'ok' : 'warn'
                                }`}
                              >
                                {ver.badgeText}
                              </span>
                            ) : meta.smoke ? (
                              <span className="mp-lab-smoke-tag">核心冒烟</span>
                            ) : null}
                          </div>
                          <div className="mp-lab-row-why">{meta.why}</div>
                          <div className="mp-lab-row-foot num">
                            <span>{c.group}</span>
                            <span>·</span>
                            <span>{sum?.specText}</span>
                            <span>·</span>
                            <span>{sum?.pieceSummary}</span>
                          </div>
                        </a>
                      );
                    })}
                    {visibleCases.length === 0 && (
                      <div className="mp-empty-inline" style={{ padding: 24 }}>
                        没有匹配的算例，可清空搜索词或切换上方能力分类。
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Scenario Space Left Showroom */}
                  <div className="mp-scenario-side-head">
                    <div className="mp-scenario-domain-tabs" role="tablist" aria-label="选择制造行业场景">
                      {SCENARIO_DOMAINS.map((dom) => {
                        const count = SHOWCASE_CASES.filter((c: any) =>
                          dom.groups.includes(c.group)
                        ).length;
                        const active = dom.id === activeScenarioDomain.id;
                        return (
                          <button
                            key={dom.id}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            className={`mp-scenario-domain-btn ${active ? 'on' : ''}`}
                            onClick={() => {
                              setScenarioDomainId(dom.id);
                              const first = SHOWCASE_CASES.find((c: any) =>
                                dom.groups.includes(c.group)
                              );
                              if (first) setActiveCaseId(first.id);
                            }}
                          >
                            <div className="mp-scenario-domain-top">
                              <strong>{dom.title}</strong>
                              <span className="num">{count} 个场景</span>
                            </div>
                            <p>{dom.subtitle}</p>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mp-scenario-pain-banner">
                      <span>场景痛点：</span>
                      {activeScenarioDomain.painPoint}
                    </div>
                  </div>

                  <div className="mp-scenario-card-list">
                    {SHOWCASE_CASES.filter((c: any) =>
                      activeScenarioDomain.groups.includes(c.group)
                    ).map((c: any) => {
                      const meta = getCaseMeta(c);
                      const sum = caseInputSummaries[c.id];
                      const ver = verifications[c.id];
                      const isActive = selected?.id === c.id;
                      return (
                        <a
                          key={c.id}
                          className={`mp-scenario-card ${isActive ? 'on' : ''}`}
                          data-case={c.id}
                          href={`#/showcase/${encodeURIComponent(c.id)}`}
                          onClick={() => setActiveCaseId(c.id)}
                        >
                          <div className="mp-scenario-card-head">
                            <span className="tag kind">{sum?.engineBadge}</span>
                            <strong>{c.name}</strong>
                            <CodeBadge>{c.id}</CodeBadge>
                            {ver && (
                              <span
                                className={`mp-lab-ver-badge num ${
                                  ver.pass ? 'ok' : 'warn'
                                }`}
                              >
                                {ver.badgeText}
                              </span>
                            )}
                          </div>
                          <div className="mp-scenario-card-row">
                            <span className="mp-scenario-k">适用场景：</span>
                            <span>{meta.scenario}</span>
                          </div>
                          <div className="mp-scenario-card-row">
                            <span className="mp-scenario-k">设计目的：</span>
                            <span>{meta.why}</span>
                          </div>
                          <div className="mp-scenario-card-foot num">
                            <span>
                              {sum?.specText} · {sum?.pieceSummary}
                            </span>
                            <span className="mp-scenario-try">
                              {isActive ? '当前右侧演练中 →' : '载入右侧试算 →'}
                            </span>
                          </div>
                        </a>
                      );
                    })}
                  </div>
                </>
              )}
            </aside>

            {/* Right Live CAD & Verification Workbench */}
            {renderLiveWorkbench()}
          </div>

          {/* Bottom Fixed Primary Action Bar (Single Primary Action + Export & Stop) */}
          <div className="foot mp-action-foot">
            <span id="demo-state" role="status" className="mp-status-text">
              {stateText}
            </span>
            {batchProgressText && !batchRunning && (
              <span className="mp-batch-done-tag num">{batchProgressText}</span>
            )}
            <span className="sp" />
            <button
              type="button"
              className="btn"
              id="demo-input-export"
              onClick={() => handleDownloadJson('input', request)}
            >
              导出输入
            </button>
            <button
              type="button"
              className="btn"
              id="demo-result-export"
              disabled={!result}
              onClick={() => handleDownloadJson('result', result)}
            >
              导出结果
            </button>
            <button
              type="button"
              className="btn"
              id="demo-cancel"
              hidden={!busy}
              onClick={handleCancel}
            >
              停止计算
            </button>
            <button
              type="button"
              className="btn pri"
              id="demo-run"
              disabled={busy}
              onClick={() => handleRun('FAST')}
            >
              {slit ? '快速搭切' : '立即求解'}
            </button>
            {slit && (
              <button
                type="button"
                className="btn"
                id="demo-quality"
                disabled={busy}
                onClick={() => handleRun('QUALITY')}
              >
                精细优化
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
