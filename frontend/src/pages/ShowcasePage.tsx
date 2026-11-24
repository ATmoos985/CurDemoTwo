import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtN } from '@static/app/js/util.js';
import { CadCanvasView } from '../components/CadCanvasView';
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
import { NumberInput } from '../components/ui/NumberInput';
import { GarmentWidthPage } from './GarmentWidthPage';
import {
  SlittingWidthMode,
  extractSlittingSolverOptions,
  loadStudioSettings
} from '../store/studioSettings';

interface ShowcaseSlitDraft {
  widthMode: SlittingWidthMode;
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  minWidthMm: number;
  maxWidthMm: number;
  widthStepMm: number;
  totalOverCap: number;
  timeLimitSeconds: number;
  topK: number;
  maxIterations: number;
  maxPatterns: number;
  maxDistinctWidths: number;
  stageTimeLimitMs: number;
  useOptimizedAssignment: boolean;
  underPenalty: number;
  seqGroupAlpha: number;
  seqGroupBeta: number;
  lnsEnabled: boolean;
}

function buildSlitDraftFromRequest(req: any): ShowcaseSlitDraft {
  const p = req?.problem || {};
  const studio = loadStudioSettings();
  const adv = extractSlittingSolverOptions(studio);
  const minW = Number(p.minWidthMm) || 4300;
  const maxW = Number(p.maxWidthMm) || 4400;
  return {
    widthMode: minW === maxW ? 'FIXED' : 'FLEXIBLE',
    motherWidthMm: Number(p.motherWidthMm) || 4600,
    leftTrimMm: Number(p.leftTrimMm) ?? 100,
    rightTrimMm: Number(p.rightTrimMm) ?? 100,
    minWidthMm: minW,
    maxWidthMm: maxW,
    widthStepMm: Math.max(1, Number(p.widthStepMm) || 10),
    totalOverCap: Math.max(0, Number(p.totalOverCap) ?? 30),
    timeLimitSeconds: Math.min(180, Math.max(1, Number(p.timeLimitSeconds) || studio.slitTimeLimitSeconds || 30)),
    topK: p.topK != null ? Number(p.topK) : adv.topK,
    maxIterations: p.maxIterations != null ? Number(p.maxIterations) : adv.maxIterations,
    maxPatterns: p.maxPatterns != null ? Number(p.maxPatterns) : adv.maxPatterns,
    maxDistinctWidths: p.maxDistinctWidths != null ? Number(p.maxDistinctWidths) : adv.maxDistinctWidths,
    stageTimeLimitMs: p.stageTimeLimitMs != null ? Number(p.stageTimeLimitMs) : adv.stageTimeLimitMs,
    useOptimizedAssignment:
      p.useOptimizedAssignment != null ? Boolean(p.useOptimizedAssignment) : adv.useOptimizedAssignment,
    underPenalty: p.underPenalty != null ? Number(p.underPenalty) : adv.underPenalty,
    seqGroupAlpha: p.seqGroupAlpha != null ? Number(p.seqGroupAlpha) : adv.seqGroupAlpha,
    seqGroupBeta: p.seqGroupBeta != null ? Number(p.seqGroupBeta) : adv.seqGroupBeta,
    lnsEnabled: p.lnsEnabled != null ? Boolean(p.lnsEnabled) : adv.lnsEnabled
  };
}

function applySlitDraftToRequest(baseReq: any, draft: ShowcaseSlitDraft, profile: string): any {
  const motherW = Math.max(100, Math.floor(Number(draft.motherWidthMm) || 4600));
  const leftTrim = Math.max(0, Math.floor(Number(draft.leftTrimMm) || 0));
  const rightTrim = Math.max(0, Math.floor(Number(draft.rightTrimMm) || 0));
  const usable = Math.max(1, motherW - leftTrim - rightTrim);
  const maxW = Math.min(usable, Math.max(1, Math.floor(Number(draft.maxWidthMm) || usable)));
  const minW =
    draft.widthMode === 'FIXED'
      ? maxW
      : Math.min(maxW, Math.max(1, Math.floor(Number(draft.minWidthMm) || maxW)));
  const step = Math.max(1, Math.floor(Number(draft.widthStepMm) || 10));
  const overCap = Math.max(0, Math.floor(Number(draft.totalOverCap) || 0));
  const rawTime = Math.floor(Number(draft.timeLimitSeconds) || 30);
  const orderCount = (baseReq?.problem?.orders || []).length;
  const effTime = Math.min(
    180,
    Math.max(1, profile === 'QUALITY' ? Math.max(rawTime, orderCount >= 40 ? 180 : 60) : rawTime)
  );
  const rawDistinct = Math.min(20, Math.max(1, Math.floor(Number(draft.maxDistinctWidths) || 4)));

  return {
    ...baseReq,
    problem: {
      ...baseReq.problem,
      motherWidthMm: motherW,
      leftTrimMm: leftTrim,
      rightTrimMm: rightTrim,
      minWidthMm: minW,
      maxWidthMm: maxW,
      widthStepMm: step,
      totalOverCap: overCap,
      profile,
      timeLimitSeconds: effTime,
      topK: Math.min(50, Math.max(0, Math.floor(Number(draft.topK) || 0))),
      maxIterations: Math.min(5000, Math.max(1, Math.floor(Number(draft.maxIterations) || 300))),
      maxPatterns: Math.min(20000, Math.max(1, Math.floor(Number(draft.maxPatterns) || 800))),
      maxDistinctWidths: rawDistinct,
      stageTimeLimitMs: Math.min(
        600000,
        Math.max(1000, Math.floor(Number(draft.stageTimeLimitMs) || 120000))
      ),
      useOptimizedAssignment: Boolean(draft.useOptimizedAssignment),
      underPenalty: Math.max(0, Number(draft.underPenalty) || 0),
      seqGroupAlpha: Math.max(0, Number(draft.seqGroupAlpha) || 0),
      seqGroupBeta: Math.max(0, Number(draft.seqGroupBeta) || 0),
      lnsEnabled: Boolean(draft.lnsEnabled)
    }
  };
}

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
type DetailSideTab = 'data' | 'about';
type ThumbKind =
  | 'crosscut'
  | 'defect'
  | 'remnant'
  | 'guillotine'
  | 'window'
  | 'contour'
  | 'marker'
  | 'grain-lock'
  | 'grain-free'
  | 'slitting'
  | 'block'
  | 'rotate-ok'
  | 'gap';

interface CaseMeta {
  capGroup: Exclude<CapabilityCategory, 'all'>;
  capLabel: string;
  featureTag: string;
  thumb: ThumbKind;
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
    featureTag: '通幅直切',
    thumb: 'crosscut',
    algorithm: '2D 一阶段通幅横切（Crosscut Guillotine）',
    scenario: '窗帘定高/定宽整幅横切、家纺床品通幅直切',
    why: '当裁片宽度等于母卷门幅时，验证引擎生成零纵向废料的极简通幅一刀切路径。',
    verifyRule: '全部裁片 100% 排入，仅含通幅横切刀路，无碎片余料。',
    smoke: true
  },
  GUILLOTINE: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '疵点避让',
    thumb: 'defect',
    algorithm: '2D 多级断头台套裁 + 疵点禁入区避让',
    scenario: '验布后含局部瑕疵的窗帘母卷主帘与辅件混合套裁',
    why: '左下方存在疵点禁入区时，主帘大件自动右移避疵，并利用上方通幅区与侧边余条套裁长条、辅片与挂带。',
    verifyRule: '4 类 8 件可排区域高密填充、0 疵点干涉、通幅长条位于主帘上方、占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  '3': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '余料混排',
    thumb: 'remnant',
    algorithm: '2D 余料短段多规格混排（Remnant Packing）',
    scenario: '车间裁床 1.6m 短料头回收后再利用，混排主帘、抱枕与绑带',
    why: '在受限长度的短料头上通过主件+多规格小辅件填空，降低短料头报废率。',
    verifyRule: '多规格裁片紧密填充短料段，加工区占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  '4': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '贯通刀序',
    thumb: 'guillotine',
    algorithm: '2D 多级条带断头台精确刀序生成',
    scenario: '多窗户不同尺寸窗帘、侧帘与抱枕同卷合单套裁',
    why: '验证多规格矩形合单时的条带划分与可执行的贯通切刀序列（刀序 1→N）。',
    verifyRule: '生成合法的贯通断头台刀路序列，打开「刀序」可复核切刀路径。'
  },
  '6': {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '单床窗口',
    thumb: 'window',
    algorithm: '2D 固定裁床台面单工位窗口截断求解',
    scenario: '长母卷在固定长度裁床上的单工位拉布排料',
    why: '验证超大订单超过单次拉布台面长度时，算法在单个工位窗口内的局部截断填充行为。',
    verifyRule: '仅在当前台面窗口内排入可容纳裁片，超出部分记为待后续工位排产。'
  },
  CONTOUR: {
    capGroup: '2d-contour',
    capLabel: '异形与密排',
    featureTag: '凹角嵌合',
    thumb: 'contour',
    algorithm: '2D 真实多边形包络与凹角互补嵌套',
    scenario: '服装/箱包 L 形、斜边与非矩形异形样板排料',
    why: '对比外接矩形排料，验证非矩形折线轮廓的凹角嵌合借位能力。',
    verifyRule: 'L 形与斜边异形片在同一个加工区内无重叠紧凑嵌合。',
    smoke: true
  },
  GARMENT_SHIRT: {
    capGroup: '2d-contour',
    capLabel: '异形与密排',
    featureTag: '大小件填空',
    thumb: 'contour',
    algorithm: '2D 服装多部位异形样板定长台面高密填充',
    scenario: '衬衫/上衣 M、L 两码批量前后片、袖片、领片与袋布混排',
    why: '验证固定 1500×2400 mm 台面下，大面积衣身片与零碎领/袋小裁片的混合填空能力。',
    verifyRule: '排入裁片数 ≥ 20 片，加工区占用率 ≥ 80%。',
    smoke: true,
    minUtilization: 80
  },
  GARMENT_PANTS: {
    capGroup: '2d-contour',
    capLabel: '异形与密排',
    featureTag: '斜边互补',
    thumb: 'contour',
    algorithm: '2D 细长梯形裤片与零散辅片互补密排',
    scenario: '长裤 M、L 两码前后裤片、腰头、裤袋与门襟同场套裁',
    why: '裤片呈上宽下窄斜边轮廓，检验算法将腰头、袋布塞入裤腿斜边三角空隙的能力。',
    verifyRule: '排入裁片数 ≥ 20 片，加工区占用率 ≥ 70%。',
    minUtilization: 70
  },
  GARMENT_SKIRT: {
    capGroup: '2d-contour',
    capLabel: '异形与密排',
    featureTag: '扇形交错',
    thumb: 'contour',
    algorithm: '2D 扇形/梯形裙片斜边正反互补排料',
    scenario: '半裙前后裙片与腰头样板排料',
    why: '验证宽下摆裙片在受限门幅内的交错排布与腰头窄条穿插效果。',
    verifyRule: '裙片与腰头在加工区内完整排入且轮廓零重叠。'
  },
  GARMENT_FULL: {
    capGroup: '2d-contour',
    capLabel: '异形与密排',
    featureTag: '限时密排',
    thumb: 'contour',
    algorithm: '2D 10 秒限时多启发式搜索密排',
    scenario: '高密度衣身与袖片大批量紧凑合排',
    why: '验证在 10 秒求解预算内，引擎对多件异形衣身与袖片的持续邻域搜索压紧能力。',
    verifyRule: '在限时内完成多轮搜索并返回高密度无重叠排料方案。'
  },
  BOARD_GRAIN: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '0° 锁木纹',
    thumb: 'grain-lock',
    algorithm: '2D 板材定长开料 · 纹理方向硬约束（0° 锁定）',
    scenario: '胡桃木/橡木等带天然木纹方向的家具板材开料',
    why: '与「素色板·允许旋转」构成成对对照：木纹件禁止 90° 旋转，严格保持纹理方向一致。',
    verifyRule: '所有锁纹板件旋转角均为 0°，严格遵守木纹纹理方向约束。',
    smoke: true
  },
  BOARD_PLAIN: {
    capGroup: '2d-guillotine',
    capLabel: '二维套裁与避疵',
    featureTag: '90° 自由旋转',
    thumb: 'grain-free',
    algorithm: '2D 板材定长开料 · 允许 90° 旋转优化',
    scenario: '密度板、素色颗粒板等无纹理方向要求的家具板材开料',
    why: '与「木纹板·禁止旋转」使用相同订单，放开 90° 旋转以提升排入率与利用率。',
    verifyRule: '同输入下利用 90° 旋转排入更多板件或获得更高板材利用率。'
  },
  film: {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '列生成合卷',
    thumb: 'slitting',
    algorithm: '1D 多规格合卷分切优化',
    scenario: '6000m 光学膜母卷多规格条宽同卷长订单合卷分切',
    why: '对比传统「逐规格独立分切」，通过不同条宽组合搭切大幅减少开卷车数与边丝损耗。',
    verifyRule: '订单 100% 齐套（COMPLETE），搭切车数显著低于逐规格独立分切基线。',
    smoke: true
  },
  'film-t29-50': {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '50单·3111卷实单',
    thumb: 'slitting',
    algorithm: '1D 大规模真实反射膜订单列生成 + 整数规划搭切',
    scenario: '188µm 反射膜 T29_DJY（4600mm 母卷、1350m 定长、不电晕/不涂布），50 条真实客户委托共 3,111 卷合卷分切',
    why: '面向真实光学膜大批量订单（730–1480mm 多档幅宽），在 4200–4400mm 组合宽度区间内自动压榨母卷利用率至 95%+ 并压低超产。',
    verifyRule: '50 条订单 3,111 卷 100% COMPLETE 齐套，零缺口，母卷得率 ≥ 94%。'
  },
  'film-t10-17': {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '17单·591卷实单',
    thumb: 'slitting',
    algorithm: '1D 反射膜中批量订单列生成 + 整数规划搭切',
    scenario: '188µm 反射膜 T10_ESY（4600mm 母卷、1350m 定长、不电晕/不涂布），17 条真实客户委托共 591 卷合卷分切',
    why: '验证中批量反射膜订单（860–1480mm 宽幅）在 2 秒内快速收敛至 95% 母卷得率且零超产。',
    verifyRule: '17 条订单 591 卷 100% COMPLETE 齐套，母卷得率 ≥ 94%。'
  },
  'film-t29-85': {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '85单·2501卷多客',
    thumb: 'slitting',
    algorithm: '1D 高维度多客户反射膜订单列生成 + 整数规划搭切',
    scenario: '188µm 反射膜 T29_DJY 多客户合单（4600mm 母卷、1350m 定长），85 条真实委托共 2,501 卷高密组合优化',
    why: '模拟真实生产计划中 85 条跨客户、27 种不同幅宽（740–1480mm）同材质同卷长合单排刀，检验大规模一维求解器稳定性与收敛质量。',
    verifyRule: '85 条订单 2,501 卷 100% COMPLETE 齐套，超产严格受控，母卷得率 ≥ 94%。'
  },
  curtain: {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '快/精双档对比',
    thumb: 'slitting',
    algorithm: '1D 快速启发式搭切 vs 精细分支定界优化对比',
    scenario: '卷帘面料多订单条宽组合开条与超产控制',
    why: '验证一维求解器「快速搭切」与「精细优化」双档位，并与独立分切基线同表对比车数与超产。',
    verifyRule: '支持切换快速搭切与精细优化，自动生成三种方法对比表。'
  },
  board: {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '2440mm 定长',
    thumb: 'slitting',
    algorithm: '1D 2440mm 标准整板定长开条组合优化',
    scenario: '2440mm 标准建材板材按不同宽度批量开条',
    why: '验证一维分切模型在定长板材开条场景下的精确长度保持（2440 mm）与刀位宽度组合优化。',
    verifyRule: '全部开条需求 COMPLETE 齐套，单车段长精确保留 2,440 mm。'
  },
  'board-2m': {
    capGroup: '1d-slitting',
    capLabel: '一维分切搭切',
    featureTag: '2000mm 整米',
    thumb: 'slitting',
    algorithm: '1D 2000mm 整米对照分切模型',
    scenario: '与 2440mm 板条相同条宽组合、改为 2000mm 整米定长的对照场景',
    why: '将卷长改为 2000 mm 整米，方便直观心算核对面积占比、切边损耗与超产面积口径。',
    verifyRule: '条宽组合与 2440mm 算例一致，段长按 2,000 mm 精确计量。'
  },
  'marker-GARMENT_SHIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: 'M/L 齐套缩短',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（Marker Length Compaction）',
    scenario: '上衣 M/L 混码整套衣片（前片、后片、袖片、领片）齐套唛架',
    why: '保证整件衣服所有部位一片不少，并通过多轮二分缩短试排找到最短齐套唛架长度。',
    verifyRule: 'M/L 所有部位 100% 齐套，输出每轮试排长度与最终实际唛架长度。',
    smoke: true
  },
  'marker-GARMENT_PANTS': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: 'M/L 齐套缩短',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（长裤全部位）',
    scenario: '长裤 M/L 混码（前后裤片、裤袋、腰头、门襟）齐套唛架',
    why: '验证细长裤片在保证 M/L 每套裤子全部位齐套前提下的最短唛架用布压缩能力。',
    verifyRule: '全部裤片与辅片齐套排入，输出多轮试排缩短轨迹与净用布长度。'
  },
  'marker-GARMENT_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: 'M/L 齐套缩短',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（半裙）',
    scenario: '半裙 M/L 混码裙片与腰头齐套排料',
    why: '验证中小件服装款式的快速齐套收敛速度与尾料剔除计账口径。',
    verifyRule: '裙片与腰头 100% 齐套，未使用尾料不计入实际唛架用布。'
  },
  'marker-GARMENT_TANK': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: '包边穿插齐套',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（背心）',
    scenario: '背心 M/L 混码前后身片、领口与袖窿包边条齐套排料',
    why: '验证含细长包边条的针织背心款式在齐套约束下的边角穿插与总长缩短。',
    verifyRule: '主身片与全部包边条齐套排入，输出最短齐套唛架长度。'
  },
  'marker-GARMENT_SHORTS': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: 'M/L 齐套缩短',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（短裤）',
    scenario: '短裤 M/L 混码前后裤片、松紧腰头与袋布齐套排料',
    why: '检验短裤多部位中等尺寸样板在 1500mm 门幅下的齐套紧凑度。',
    verifyRule: 'M/L 短裤全部衣片齐套排入，记录试排缩短过程。'
  },
  'marker-GARMENT_APRON': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: '长系带嵌合',
    thumb: 'marker',
    algorithm: '2D 混码齐套二分缩短试排（围裙）',
    scenario: '工装围裙 M/L 混码主体片、前袋与长系带齐套排料',
    why: '检验算法将极细长系带嵌入大块围裙主体侧边余隙以缩短总用布的能力。',
    verifyRule: '围裙主体、口袋与全部系带 100% 齐套排入。'
  },
  'marker-GARMENT_GORED_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: '多片斜裙齐套',
    thumb: 'marker',
    algorithm: '2D 多片梯形裙幅正反互补齐套缩短',
    scenario: '六片裙 M/L 混码（每件 6 片梯形裙幅 + 腰头）齐套唛架',
    why: '验证大量同形斜边梯形裙幅在齐套约束下的密集互补排布效果。',
    verifyRule: 'M/L 共 12 片裙幅及腰头全部齐套排入。'
  },
  'marker-GARMENT_GATHERED_SKIRT': {
    capGroup: '2d-marker',
    capLabel: '服装齐套缩短',
    featureTag: '宽幅直裁齐套',
    thumb: 'marker',
    algorithm: '2D 宽幅直裁裙幅与配件齐套缩短',
    scenario: '直裁抽褶裙 M/L 混码宽幅裙片与腰头齐套唛架',
    why: '验证接近门幅宽度的直裁大裙片与腰头辅件的齐套组合与长度压缩。',
    verifyRule: '全部裙幅与腰头齐套排入，无遗漏部位。'
  },
  'rotation-off': {
    capGroup: 'boundary',
    capLabel: '边界对照',
    featureTag: '越界防呆阻断',
    thumb: 'block',
    algorithm: '几何可行性前置校验 · 0° 旋转禁令阻断',
    scenario: '800×1200 mm 材料排入 900×600 mm 裁片（禁止旋转）',
    why: '裁片宽 900 mm 超过材料幅宽 800 mm 且禁止旋转时，引擎绝不越界强排，诚实返回「未排入」及原因。',
    verifyRule: '预期排入 0 件、缺口 1 件，并明确返回尺寸超限/禁止旋转原因（正向防呆阻断）。',
    smoke: true,
    expectUnplaced: true
  },
  'rotation-on': {
    capGroup: 'boundary',
    capLabel: '边界对照',
    featureTag: '90° 解锁排入',
    thumb: 'rotate-ok',
    algorithm: '几何可行性对照 · 开启 90° 旋转解锁排入',
    scenario: '800×1200 mm 材料排入 900×600 mm 裁片（允许 90° 旋转）',
    why: '与「旋转限制：未排入」成对对照：仅开启 90° 旋转开关，旋转为 600×900 后即可合法排入。',
    verifyRule: '预期排入 1 件（旋转 90° 后尺寸 600×900 mm），需求 100% 齐套。',
    smoke: true
  },
  gap: {
    capGroup: 'boundary',
    capLabel: '边界对照',
    featureTag: '10mm 刀缝间距',
    thumb: 'gap',
    algorithm: '2D 异形轮廓 10mm 固定刀缝安全间距膨胀校验',
    scenario: '自动裁床电刀/激光切割需预留 10mm 过刀安全间距的异形衣片排料',
    why: '检验工艺参数 pieceGap = 10 mm 在异形轮廓上的真实生效情况，保证任意两片净距 ≥ 10 mm。',
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
        ? '一维分切搭切'
        : capGroup === '2d-marker'
        ? '服装齐套缩短'
        : capGroup === 'boundary'
        ? '边界对照'
        : capGroup === '2d-contour'
        ? '异形与密排'
        : '二维套裁与避疵',
    featureTag: c.kind === 'slitting' ? '合卷分切' : c.kind === 'marker' ? '齐套缩短' : '二维套裁',
    thumb: c.kind === 'slitting' ? 'slitting' : c.kind === 'marker' ? 'marker' : 'guillotine',
    algorithm: c.kind === 'slitting' ? '1D 列生成分切优化' : '2D 排料优化',
    scenario: `${c.group} · ${c.name}`,
    why: c.note,
    verifyRule: '完成求解并返回合法排料方案与指标。'
  };
}

/** Minimalist SVG geometry thumbnail that visually explains each case's cutting pattern at a glance. */
const CaseThumbSvg: React.FC<{ kind: ThumbKind }> = ({ kind }) => {
  switch (kind) {
    case 'crosscut':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="44" height="9" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="4" y="15" width="44" height="9" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
          <line x1="2" y1="14" x2="50" y2="14" stroke="#4f46e5" strokeDasharray="2 1.5" />
          <line x1="2" y1="25" x2="50" y2="25" stroke="#4f46e5" strokeDasharray="2 1.5" />
        </svg>
      );
    case 'defect':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="44" height="7" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <rect x="6" y="14" width="7" height="7" rx="1" fill="#fee2e2" stroke="#e11d48" />
          <rect x="16" y="13" width="32" height="19" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="4" y="23" width="10" height="9" rx="1.5" fill="#ede9fe" stroke="#8b5cf6" />
        </svg>
      );
    case 'remnant':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="4" y="4" width="26" height="19" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
          <rect x="32" y="4" width="16" height="9" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="32" y="15" width="16" height="8" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="4" y="25" width="44" height="7" rx="1.5" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'contour':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <polygon points="5,5 25,5 25,14 14,14 14,30 5,30" fill="#e0e7ff" stroke="#6366f1" />
          <polygon points="16,16 34,16 30,31 16,31" fill="#d1fae5" stroke="#10b981" />
          <polygon points="27,5 47,5 47,29 36,29 36,14 27,14" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'marker':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <polygon points="5,5 21,5 23,16 5,16" fill="#e0e7ff" stroke="#6366f1" />
          <polygon points="5,19 23,19 21,31 5,31" fill="#dbeafe" stroke="#3b82f6" />
          <polygon points="25,5 39,7 39,17 25,17" fill="#d1fae5" stroke="#10b981" />
          <rect x="25" y="20" width="13" height="11" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <line x1="41" y1="3" x2="41" y2="33" stroke="#10b981" strokeWidth="1.5" strokeDasharray="2 1.5" />
        </svg>
      );
    case 'slitting':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="4" width="13" height="28" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="19" y="4" width="13" height="28" fill="#dbeafe" stroke="#3b82f6" />
          <rect x="33" y="4" width="9" height="28" fill="#d1fae5" stroke="#10b981" />
          <rect x="43" y="4" width="5" height="28" fill="#fef3c7" stroke="#d97706" />
        </svg>
      );
    case 'grain-lock':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="20" height="12" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <rect x="27" y="5" width="20" height="12" rx="1.5" fill="#fef3c7" stroke="#d97706" />
          <line x1="8" y1="11" x2="22" y2="11" stroke="#b45309" strokeWidth="1.2" />
          <line x1="30" y1="11" x2="44" y2="11" stroke="#b45309" strokeWidth="1.2" />
          <rect x="5" y="19" width="26" height="11" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
        </svg>
      );
    case 'grain-free':
    case 'rotate-ok':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="22" height="26" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="29" y="5" width="18" height="12" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="29" y="19" width="18" height="12" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
        </svg>
      );
    case 'block':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="34" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="6" y="8" width="42" height="18" rx="2" fill="rgba(225,29,72,0.12)" stroke="#e11d48" strokeDasharray="2.5 1.5" />
        </svg>
      );
    case 'gap':
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="6" y="6" width="17" height="24" rx="2" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="29" y="6" width="17" height="24" rx="2" fill="#d1fae5" stroke="#10b981" />
          <line x1="26" y1="6" x2="26" y2="30" stroke="#d97706" strokeDasharray="2 1.5" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 52 36" className="mp-case-thumb" aria-hidden="true">
          <rect x="2" y="2" width="48" height="32" rx="3" fill="#f4f5f8" stroke="#d4d8e1" />
          <rect x="5" y="5" width="24" height="15" rx="1.5" fill="#e0e7ff" stroke="#6366f1" />
          <rect x="31" y="5" width="16" height="15" rx="1.5" fill="#d1fae5" stroke="#10b981" />
          <rect x="5" y="22" width="42" height="9" rx="1.5" fill="#dbeafe" stroke="#3b82f6" />
        </svg>
      );
  }
};

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

const SCENARIO_DOMAINS = [
  {
    id: '窗帘 · 家纺',
    title: '窗帘 · 家纺定制',
    tags: ['幅宽 2000mm', '验布避疵套裁', '短料头混排复用'],
    groups: ['窗帘 · 家纺']
  },
  {
    id: '服装 · 异形与齐套',
    title: '服装 · 异形与齐套唛架',
    tags: ['折线异形轮廓', 'M/L 混码齐套', '二分缩短用布'],
    groups: ['服装', '服装齐套']
  },
  {
    id: '板材',
    title: '板材 · 纹理方向开料',
    tags: ['0° 锁木纹方向', '90° 旋转同单对照', '贯通直刀开料'],
    groups: ['板材']
  },
  {
    id: '卷材 · 薄膜',
    title: '卷材 · 薄膜与板条分切',
    tags: ['1D 列生成搭切', '独立分切基线对比', '快/精双档求解'],
    groups: ['卷材 · 薄膜']
  },
  {
    id: '边界与异常',
    title: '边界与工艺规则对照',
    tags: ['尺寸越界防呆阻断', '90° 旋转解锁', '10mm 固定刀缝间距'],
    groups: ['边界与异常']
  }
];

export const ShowcasePage: React.FC<{ params?: string[]; groupQuery?: string }> = ({
  params = [],
  groupQuery = ''
}) => {
  const [caseId] = params;
  const selected = useMemo(
    () => SHOWCASE_CASES.find((c: any) => c.id === caseId) || null,
    [caseId]
  );

  // Stage 1 Overview state
  const [mainTab, setMainTab] = useState<ShowcaseMainTab>('lab');
  const [capFilter, setCapFilter] = useState<CapabilityCategory>('all');
  const [activeGroup, setActiveGroup] = useState<string>(
    groupQuery && groupQuery !== '__workflow__' ? groupQuery : 'all'
  );
  const [scenarioFilter, setScenarioFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [viewStyle, setViewStyle] = useState<'list' | 'card'>('list');

  // Stage 2 Detail side-panel tab: 'data' (数据与结果, default) | 'about' (示例说明)
  const [detailTab, setDetailTab] = useState<DetailSideTab>('data');

  useEffect(() => {
    if (groupQuery && groupQuery !== '__workflow__') {
      setActiveGroup(groupQuery);
      setMainTab('scenario');
      const matched = SCENARIO_DOMAINS.find((d) => d.groups.includes(groupQuery));
      if (matched) setScenarioFilter(matched.id);
    } else {
      setActiveGroup('all');
    }
  }, [groupQuery]);

  const caseInputSummaries = useMemo(() => {
    const map: Record<string, CaseInputSummary> = {};
    for (const c of SHOWCASE_CASES) {
      map[c.id] = summarizeCaseInput(c);
    }
    return map;
  }, []);

  // Detail solver state
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
  const [slitDraft, setSlitDraft] = useState<ShowcaseSlitDraft | null>(() =>
    selected?.kind === 'slitting' ? buildSlitDraftFromRequest(showcaseRequest(selected.id)) : null
  );

  // Cached verification records across cases
  const [verifications, setVerifications] = useState<
    Record<string, VerificationRecord>
  >({});
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const [batchProgressText, setBatchProgressText] = useState<string>('');
  const batchAbortRef = useRef<number>(0);

  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const tokenRef = useRef<number>(0);
  const stateRef = useRef({ request, result, patternIndex });
  stateRef.current = { request, result, patternIndex };

  useEffect(() => {
    if (!selected) {
      tokenRef.current++;
      sessionRef.current?.cancel();
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
    setSlitDraft(selected.kind === 'slitting' ? buildSlitDraftFromRequest(initReq) : null);
    setSelectionText('滚轮缩放，拖动平移；右键查看裁片尺寸。');

    let disposed = false;
    sessionRef.current = new (OptimizationSession as any)(
      undefined,
      150,
      (err?: any) => {
        if (!disposed) setStateText('未确认停止：' + (err?.message || ''));
      }
    );

    return () => {
      disposed = true;
      tokenRef.current++;
      sessionRef.current?.cancel();
    };
  }, [selected?.id]);

  const activeScene = useMemo(() => {
    if (!selected || !request) return null;
    return showcaseScene(request, result, patternIndex);
  }, [selected, request, result, patternIndex]);

  const patchSlitDraft = (patch: Partial<ShowcaseSlitDraft>) => {
    setSlitDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (selected?.kind === 'slitting' && request) {
        setRequest(applySlitDraftToRequest(request, next, request.problem?.profile || 'FAST'));
      }
      return next;
    });
  };

  const handleResetSlitDraft = () => {
    if (!selected || selected.kind !== 'slitting') return;
    const base = showcaseRequest(selected.id, 'FAST');
    const fresh = buildSlitDraftFromRequest(base);
    setSlitDraft(fresh);
    setRequest(applySlitDraftToRequest(base, fresh, 'FAST'));
    setErrorText(null);
  };

  const handleRun = async (profile = 'FAST') => {
    if (!selected || busy) return;
    const mine = ++tokenRef.current;
    const baseReq = showcaseRequest(selected.id, profile);
    let nextReq = baseReq;
    if (selected.kind === 'slitting' && slitDraft) {
      const usable = slitDraft.motherWidthMm - slitDraft.leftTrimMm - slitDraft.rightTrimMm;
      const effMax = Math.min(usable, slitDraft.maxWidthMm);
      const effMin = slitDraft.widthMode === 'FIXED' ? effMax : slitDraft.minWidthMm;
      const maxOrderW = Math.max(
        ...((baseReq as any).problem?.orders || []).map((o: any) => Number(o.widthMm) || 0),
        0
      );
      if (usable <= 0 || effMin <= 0 || effMax < effMin) {
        setErrorText('请检查母卷幅宽、左右切边与组合宽区间：可切幅宽须大于 0 且最小组合宽 ≤ 最大组合宽。');
        return;
      }
      if (maxOrderW > effMax) {
        setErrorText(`当前订单最大宽幅 ${maxOrderW} mm 超过组合上限 ${effMax} mm，请调大母卷总宽或最大组合宽。`);
        return;
      }
      nextReq = applySlitDraftToRequest(baseReq, slitDraft, profile);
    }
    setRequest(nextReq);
    setResult(null);
    setErrorText(null);
    setCancelledHint(false);
    setPatternIndex(0);
    setBusy(true);
    setStateText('排队中');
    const t0 = performance.now();
    try {
      const response = await sessionRef.current.solve(nextReq, {
        onProgress: (j: any) => {
          if (mine === tokenRef.current) {
            setStateText(j.state === 'QUEUED' ? '排队中' : '计算中');
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
        `${res.fulfillmentStatus === 'COMPLETE' ? '齐套' : '未齐套'}${
          response.job.state !== 'SUCCEEDED' ? ' · 提前结束' : ''
        }`
      );
    } catch (e: any) {
      if (mine !== tokenRef.current) return;
      if (e.name === 'AbortError') {
        setStateText('已停止');
      } else {
        setStateText('未完成');
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
      setBatchProgressText('已停止');
    }
    setBusy(false);
    setStateText('已停止');
    setResult(null);
    setErrorText(null);
    setCancelledHint(true);
  };

  const handleBatchVerify = async (targetCases: any[]) => {
    if (!targetCases.length || batchRunning || busy) return;
    const batchToken = ++batchAbortRef.current;
    setBatchRunning(true);
    for (let i = 0; i < targetCases.length; i++) {
      if (batchToken !== batchAbortRef.current) break;
      const c = targetCases[i];
      setBatchProgressText(`${i + 1}/${targetCases.length} ${c.name}`);
      const req = showcaseRequest(c.id, 'FAST');
      const t0 = performance.now();
      try {
        const tempSession = new (OptimizationSession as any)(undefined, 120);
        const response = await tempSession.solve(req, {});
        if (batchToken !== batchAbortRef.current) break;
        const res = response.result;
        const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
        const record = evaluateCaseResult(c, req, res, elapsedMs);
        setVerifications((prev) => ({ ...prev, [c.id]: record }));
      } catch {
        if (batchToken !== batchAbortRef.current) break;
      }
    }
    if (batchToken === batchAbortRef.current) {
      setBatchRunning(false);
      setBatchProgressText('');
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

  const matchesCase = (c: any) => {
    const kindText =
      c.kind === 'marker'
        ? '齐套与用布优化'
        : c.kind === 'slitting'
        ? '独立分切 / 快速 / 精细'
        : '二维计算';
    const meta = getCaseMeta(c);
    const capMatch =
      mainTab !== 'lab' || capFilter === 'all' || meta.capGroup === capFilter;
    const domainObj =
      mainTab === 'scenario' && scenarioFilter !== 'all'
        ? SCENARIO_DOMAINS.find((d) => d.id === scenarioFilter)
        : null;
    const domainMatch = !domainObj || domainObj.groups.includes(c.group);
    const groupMatch = activeGroup === 'all' || c.group === activeGroup;
    const textMatch =
      !qLower ||
      `${kindText}${c.name}${c.note}打开用例 →${c.group}`
        .toLowerCase()
        .includes(qLower);
    return capMatch && domainMatch && groupMatch && textMatch;
  };

  const visibleCases = useMemo(
    () => SHOWCASE_CASES.filter((c: any) => matchesCase(c)),
    [mainTab, capFilter, scenarioFilter, activeGroup, qLower]
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
      accent: 'indigo'
    },
    {
      value: 'scenario',
      label: '场景空间',
      count: SCENARIO_DOMAINS.length
    },
    {
      value: 'garment',
      label: '多门幅工艺对比'
    }
  ];

  const capFilterOptions: SegmentedOption<CapabilityCategory>[] = useMemo(
    () => [
      { value: 'all', label: '全部算例', count: SHOWCASE_CASES.length },
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

  const scenarioFilterOptions: SegmentedOption<string>[] = useMemo(
    () => [
      { value: 'all', label: '全部场景', count: SHOWCASE_CASES.length },
      ...SCENARIO_DOMAINS.map((d) => ({
        value: d.id,
        label: d.title,
        count: SHOWCASE_CASES.filter((c: any) => d.groups.includes(c.group)).length
      }))
    ],
    []
  );

  // Render a single minimalist case item (List Row by default, or Simplified Card)
  const renderCaseItem = (c: any) => {
    const meta = getCaseMeta(c);
    const sum = caseInputSummaries[c.id];
    const ver = verifications[c.id];
    const isHidden = !matchesCase(c);

    if (viewStyle === 'list') {
      return (
        <a
          key={c.id}
          className="demo-card mp-case-list-row"
          data-case={c.id}
          href={`#/showcase/${encodeURIComponent(c.id)}`}
          hidden={isHidden}
        >
          <CaseThumbSvg kind={meta.thumb} />
          <div className="mp-clr-main">
            <div className="mp-clr-title-line">
              <b>{c.name}</b>
              <span className="mp-cc3-feature">{meta.featureTag}</span>
            </div>
            <p>{c.note}</p>
          </div>
          <div className="mp-clr-meta num">
            <span className="mp-clr-spec">
              {sum?.specText} · {sum?.pieceSummary}
            </span>
            {ver ? (
              <span className={`mp-lab-ver-badge num ${ver.pass ? 'ok' : 'warn'}`}>
                {ver.badgeText}
              </span>
            ) : (
              <span className="mp-clr-arrow" aria-hidden="true">
                →
              </span>
            )}
          </div>
        </a>
      );
    }

    return (
      <a
        key={c.id}
        className="card demo-card mp-case-card-v4"
        data-case={c.id}
        href={`#/showcase/${encodeURIComponent(c.id)}`}
        hidden={isHidden}
      >
        <CaseThumbSvg kind={meta.thumb} />
        <div className="mp-cc4-body">
          <div className="mp-cc4-head">
            <b>{c.name}</b>
            <span className="mp-cc3-feature">{meta.featureTag}</span>
            {ver && (
              <span className={`mp-lab-ver-badge num ${ver.pass ? 'ok' : 'warn'}`}>
                {ver.badgeText}
              </span>
            )}
          </div>
          <p>{c.note}</p>
          <span className="mp-cc4-spec num">
            {sum?.specText} · {sum?.pieceSummary}
          </span>
        </div>
      </a>
    );
  };

  // =========================================================================
  // STAGE 1: Minimalist Overview (#/showcase) — 分场景切割 + 列式清单
  // =========================================================================
  if (!selected) {
    const capGroups: Exclude<CapabilityCategory, 'all'>[] = [
      '2d-guillotine',
      '2d-contour',
      '2d-marker',
      '1d-slitting',
      'boundary'
    ];
    const capGroupTitles: Record<Exclude<CapabilityCategory, 'all'>, [string, string]> = {
      '2d-guillotine': ['二维套裁与避疵', '通幅直切 · 疵点禁入区避让 · 短料头复用 · 贯通刀序'],
      '2d-contour': ['异形轮廓与密排', '多边形折线包络 · 凹角嵌合 · 服装大小片填空'],
      '2d-marker': ['服装混码齐套缩短', 'M/L 混码全部位 100% 齐套 · 多轮二分缩短唛架长度'],
      '1d-slitting': ['一维分切与搭切', '列生成合卷搭切 · 独立分切基线对比 · 快/精双档'],
      boundary: ['边界与规则对照', '尺寸越界防呆阻断 · 90° 旋转解锁 · 10mm 刀缝间距']
    };

    const viewStyleOptions: SegmentedOption<'list' | 'card'>[] = [
      { value: 'list', label: '列式清单' },
      { value: 'card', label: '简约卡片' }
    ];

    const isSingleGroupFocused =
      (mainTab === 'lab' && capFilter !== 'all') ||
      (mainTab === 'scenario' && scenarioFilter !== 'all');

    return (
      <div className="react-page page-host mp-showcase-page">
        <div className="mp-sc-topbar mp-sc-header-v2">
          <div className="mp-sc-brand-title">
            <h1>能力展示</h1>
            <span className="mp-sc-sub num">
              {SHOWCASE_CASES.length} 个标准算例 · 试算不扣库存
            </span>
          </div>

          <SegmentedControl
            options={mainTabOptions}
            value={mainTab}
            onChange={(next) => {
              setMainTab(next);
              setActiveGroup('all');
            }}
            ariaLabel="切换算法工作台、场景空间与多门幅工艺对比"
          />

          <span className="sp" />

          {mainTab !== 'garment' && (
            <div className="mp-sc-quick-actions">
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
                  className="mp-search-input mp-sc-top-search"
                  id="case-search"
                  type="search"
                  aria-label="查找用例"
                  placeholder="搜算例、工艺或行业"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {verifiedList.length > 0 && (
                <span className="mp-verify-summary num">
                  已检 {verifiedList.length} · 通过 <b>{verifiedPassCount}</b>
                </span>
              )}

              {batchRunning ? (
                <button type="button" className="btn sm" onClick={handleCancel}>
                  停止快检 ({batchProgressText})
                </button>
              ) : (
                <button
                  type="button"
                  className="mp-ghost-btn"
                  onClick={() => handleBatchVerify(smokeCases)}
                  title="自动依次检验 10 个核心基准算例并回填实测利用率"
                >
                  一键快检 ({smokeCases.length})
                </button>
              )}
            </div>
          )}
        </div>

        {mainTab === 'garment' ? (
          <div className="mp-sc-garment-host">
            <GarmentWidthPage embedded />
          </div>
        ) : (
          <div className="mp-page-shell mp-sc-overview-shell">
            <div className="mp-sc-filter-bar" id="case-tabs">
              {mainTab === 'lab' ? (
                <SegmentedControl
                  options={capFilterOptions}
                  value={capFilter}
                  onChange={(next) => {
                    setCapFilter(next);
                    setActiveGroup('all');
                  }}
                  ariaLabel="按算法能力筛选"
                />
              ) : (
                <SegmentedControl
                  options={scenarioFilterOptions}
                  value={scenarioFilter}
                  onChange={(next) => {
                    setScenarioFilter(next);
                    setActiveGroup('all');
                  }}
                  ariaLabel="按行业场景筛选"
                />
              )}

              <div className="mp-sc-filter-right">
                <span className="mp-toolbar-count num">
                  显示 {visibleCases.length} / {SHOWCASE_CASES.length}
                </span>
                <SegmentedControl
                  options={viewStyleOptions}
                  value={viewStyle}
                  onChange={(next) => setViewStyle(next)}
                  ariaLabel="切换列式或卡片视图"
                  size="sm"
                />
              </div>
            </div>

            <div
              id="case-catalogue"
              className={`mp-sc-board-v4 ${
                viewStyle === 'list' ? 'is-list-board' : 'is-card-board'
              } ${isSingleGroupFocused ? 'is-single-group' : ''}`}
            >
              {mainTab === 'lab'
                ? capGroups.map((cg, gIdx) => {
                    const groupCases = SHOWCASE_CASES.filter(
                      (c: any) => getCaseMeta(c).capGroup === cg
                    );
                    const visibleInGroup = groupCases.filter((c: any) =>
                      matchesCase(c)
                    ).length;
                    const [title, tagsText] = capGroupTitles[cg];
                    return (
                      <section
                        key={cg}
                        data-case-group={cg}
                        hidden={visibleInGroup === 0}
                        className="mp-scene-panel"
                      >
                        <div className="mp-scene-panel-head">
                          <span className="mp-scene-index num">
                            0{gIdx + 1}
                          </span>
                          <div className="mp-scene-title-wrap">
                            <h3>{title}</h3>
                            <span className="mp-scene-sub">{tagsText}</span>
                          </div>
                          <span className="mp-scene-count num">
                            {visibleInGroup} 项
                          </span>
                        </div>
                        <div
                          className={
                            viewStyle === 'list'
                              ? 'mp-scene-row-list'
                              : 'mp-case-grid-v4'
                          }
                        >
                          {groupCases.map((c: any) => renderCaseItem(c))}
                        </div>
                      </section>
                    );
                  })
                : SCENARIO_DOMAINS.map((dom, gIdx) => {
                    const domCases = SHOWCASE_CASES.filter((c: any) =>
                      dom.groups.includes(c.group)
                    );
                    const visibleInDom = domCases.filter((c: any) =>
                      matchesCase(c)
                    ).length;
                    return (
                      <section
                        key={dom.id}
                        data-case-group={dom.id}
                        hidden={visibleInDom === 0}
                        className="mp-scene-panel"
                      >
                        <div className="mp-scene-panel-head">
                          <span className="mp-scene-index num">
                            0{gIdx + 1}
                          </span>
                          <div className="mp-scene-title-wrap">
                            <h3>{dom.title}</h3>
                            <span className="mp-scene-sub">
                              {dom.tags.join(' · ')}
                            </span>
                          </div>
                          <span className="mp-scene-count num">
                            {visibleInDom} 项
                          </span>
                        </div>
                        <div
                          className={
                            viewStyle === 'list'
                              ? 'mp-scene-row-list'
                              : 'mp-case-grid-v4'
                          }
                        >
                          {domCases.map((c: any) => renderCaseItem(c))}
                        </div>
                      </section>
                    );
                  })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // STAGE 2: Minimalist Full-Height Detail Workbench (#/showcase/:caseId)
  // Top Dropdown Switcher + Full-Height CAD Canvas + Tabbed Right Panel (数据与结果 | 示例说明)
  // =========================================================================
  const slit = selected.kind === 'slitting';
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
  const activeMeta = getCaseMeta(selected);
  const activeSummary = caseInputSummaries[selected.id];
  const activeVerification = verifications[selected.id];

  const currentIdx = SHOWCASE_CASES.findIndex((c: any) => c.id === selected.id);
  const prevCase =
    SHOWCASE_CASES[(currentIdx - 1 + SHOWCASE_CASES.length) % SHOWCASE_CASES.length];
  const nextCase = SHOWCASE_CASES[(currentIdx + 1) % SHOWCASE_CASES.length];

  const groups = [...new Set(SHOWCASE_CASES.map((c: any) => c.group))] as string[];

  const detailTabOptions: SegmentedOption<DetailSideTab>[] = [
    { value: 'data', label: '数据与结果' },
    { value: 'about', label: '示例说明' }
  ];

  return (
    <div className="react-page page-host mp-showcase-detail-page mp-detail-v3">
      {/* Minimalist Top Bar with Back Button + Case Dropdown Switcher + Spec Chips */}
      <div className="mp-sc-topbar mp-detail-topbar">
        <a className="mp-ghost-btn" href="#/showcase" title="返回算例与场景总览">
          ← 返回总览
        </a>

        <div className="mp-case-switcher">
          <select
            id="demo-case-select"
            className="field mp-case-select"
            aria-label="切换算例"
            value={selected.id}
            onChange={(e) => {
              location.hash = '#/showcase/' + encodeURIComponent(e.target.value);
            }}
          >
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {SHOWCASE_CASES.filter((c: any) => c.group === g).map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.id})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <a
            className="mp-step-btn"
            href={`#/showcase/${encodeURIComponent(prevCase.id)}`}
            title={`上一算例：${prevCase.name}`}
            aria-label="上一算例"
          >
            ‹
          </a>
          <a
            className="mp-step-btn"
            href={`#/showcase/${encodeURIComponent(nextCase.id)}`}
            title={`下一算例：${nextCase.name}`}
            aria-label="下一算例"
          >
            ›
          </a>
        </div>

        <h1 className="mp-detail-h1">{selected.name}</h1>
        <CodeBadge>{selected.id}</CodeBadge>
        <span className="tag kind">{activeSummary?.engineBadge}</span>
        <span className="mp-cc3-feature">{activeMeta.featureTag}</span>
        <span className="mp-sc-sub num">
          {selected.group} · {activeSummary?.specText} · {activeSummary?.pieceSummary}
        </span>

        <span className="sp" />

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

      {/* Main 2-Pane Split: Left 74% Full-Height Dark CAD Canvas + Right 26% Tabbed Inspector */}
      <div className="mp-detail-split">
        <section className="pane mp-cad-card mp-demo-canvas-card">
          <div className="mp-cad-head">
            <span className="mp-cad-title">
              {slit ? '定长横切示意' : '排料图'}
            </span>
            <span className="mp-cad-sub">
              {selected.note}
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
            id="demo-canvas"
            className="demo-canvas"
            aria-label="演示排料画布"
          >
            <CadCanvasView
              scene={activeScene}
              vertical={vertical}
              showPath={showPath}
              showDimensions={true}
              minHeight={360}
              ariaLabel="演示排料画布"
              onContextInspect={(hit) => {
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
              }}
              canvasRefOut={canvasRef}
            />
          </div>
          <div className="mp-cad-foot" id="demo-selection">
            {selectionText}
          </div>
        </section>

        <aside className="pane mp-float-card mp-detail-side">
          <div className="mp-detail-side-head">
            <SegmentedControl
              options={detailTabOptions}
              value={detailTab}
              onChange={(next) => setDetailTab(next)}
              ariaLabel="切换数据结果与示例说明"
              size="sm"
              fullWidth
            />
          </div>

          {/* Tab 1: 数据与结果 (默认展示输入规格与求解结果，干净无废话) */}
          <div
            className="mp-detail-side-body"
            hidden={detailTab !== 'data'}
          >
            <div className="mp-side-section" id="demo-result">
              <div className="sec">计算结果</div>
              {busy ? (
                <div className="empty">计算中…</div>
              ) : errorText ? (
                <div className="error-box" role="alert">
                  {errorText}
                </div>
              ) : cancelledHint ? (
                <div className="empty">本次计算已停止，可重新计算。</div>
              ) : !result ? (
                <div className="mp-unrun-compact">
                  尚未计算 · 点击右下角「{slit ? '快速搭切' : '开始计算'}」生成排料图
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
                      {(layout?.message || result.fulfillmentStatus !== 'COMPLETE') && (
                        <div className="demo-note">
                          {layout?.message || ''}
                          {result.fulfillmentStatus !== 'COMPLETE'
                            ? activeMeta.expectUnplaced
                              ? ' 尺寸超限且禁止旋转，引擎按预期阻断排入。'
                              : ' 请核对缺口；不能作为齐套完成。'
                            : ''}
                        </div>
                      )}
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
                          <div className="sec">分切组合（单车示意）</div>
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

            {slit && slitDraft && (
              <div className="mp-side-section slit-cfg-card" id="demo-slit-params">
                <div className="wb-right-section-head">
                  <span>一维搭切参数设置</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={handleResetSlitDraft}
                    title="恢复此示例默认参数"
                  >
                    恢复示例默认
                  </button>
                </div>

                <div className="seg" role="group" aria-label="示例幅宽模式" style={{ width: '100%' }}>
                  <button
                    type="button"
                    className={slitDraft.widthMode === 'FLEXIBLE' ? 'on' : ''}
                    onClick={() => patchSlitDraft({ widthMode: 'FLEXIBLE' })}
                  >
                    可变幅宽区间
                  </button>
                  <button
                    type="button"
                    className={slitDraft.widthMode === 'FIXED' ? 'on' : ''}
                    onClick={() =>
                      patchSlitDraft({
                        widthMode: 'FIXED',
                        minWidthMm: slitDraft.maxWidthMm
                      })
                    }
                  >
                    固定组合宽
                  </button>
                </div>

                <div className="slit-cfg-grid">
                  <label className="slit-cfg-field">
                    <span>母卷总宽 (mm)</span>
                    <NumberInput
                      min={200}
                      fallback={200}
                      className="field num"
                      value={slitDraft.motherWidthMm}
                      onValueChange={(w) => {
                        const usable = Math.max(100, w - slitDraft.leftTrimMm - slitDraft.rightTrimMm);
                        const nextMax = Math.min(slitDraft.maxWidthMm, usable);
                        patchSlitDraft({
                          motherWidthMm: w,
                          maxWidthMm: nextMax,
                          minWidthMm:
                            slitDraft.widthMode === 'FIXED'
                              ? nextMax
                              : Math.min(slitDraft.minWidthMm, nextMax)
                        });
                      }}
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>超产上限 (卷)</span>
                    <NumberInput
                      min={0}
                      max={10000}
                      fallback={0}
                      integer
                      className="field num"
                      value={slitDraft.totalOverCap}
                      onValueChange={(v) => patchSlitDraft({ totalOverCap: v })}
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>左切边 (mm)</span>
                    <NumberInput
                      min={0}
                      fallback={0}
                      className="field num"
                      value={slitDraft.leftTrimMm}
                      onValueChange={(lt) => {
                        const usable = Math.max(100, slitDraft.motherWidthMm - lt - slitDraft.rightTrimMm);
                        patchSlitDraft({
                          leftTrimMm: lt,
                          maxWidthMm: Math.min(slitDraft.maxWidthMm, usable),
                          minWidthMm: Math.min(slitDraft.minWidthMm, usable)
                        });
                      }}
                    />
                  </label>
                  <label className="slit-cfg-field">
                    <span>右切边 (mm)</span>
                    <NumberInput
                      min={0}
                      fallback={0}
                      className="field num"
                      value={slitDraft.rightTrimMm}
                      onValueChange={(rt) => {
                        const usable = Math.max(100, slitDraft.motherWidthMm - slitDraft.leftTrimMm - rt);
                        patchSlitDraft({
                          rightTrimMm: rt,
                          maxWidthMm: Math.min(slitDraft.maxWidthMm, usable),
                          minWidthMm: Math.min(slitDraft.minWidthMm, usable)
                        });
                      }}
                    />
                  </label>
                  {slitDraft.widthMode === 'FLEXIBLE' ? (
                    <>
                      <label className="slit-cfg-field">
                        <span>最小组合宽 (mm)</span>
                        <NumberInput
                          min={100}
                          fallback={100}
                          className="field num"
                          value={slitDraft.minWidthMm}
                          onValueChange={(v) => patchSlitDraft({ minWidthMm: v })}
                        />
                      </label>
                      <label className="slit-cfg-field">
                        <span>最大组合宽 (mm)</span>
                        <NumberInput
                          min={100}
                          fallback={100}
                          className="field num"
                          value={slitDraft.maxWidthMm}
                          onValueChange={(v) => patchSlitDraft({ maxWidthMm: v })}
                        />
                      </label>
                      <label className="slit-cfg-field">
                        <span>幅宽步长 (mm)</span>
                        <NumberInput
                          min={1}
                          fallback={10}
                          className="field num"
                          value={slitDraft.widthStepMm}
                          onValueChange={(v) => patchSlitDraft({ widthStepMm: v })}
                        />
                      </label>
                    </>
                  ) : (
                    <label className="slit-cfg-field span-2">
                      <span>固定组合宽 (mm)</span>
                      <NumberInput
                        min={100}
                        fallback={100}
                        className="field num"
                        value={slitDraft.maxWidthMm}
                        onValueChange={(v) => patchSlitDraft({ maxWidthMm: v, minWidthMm: v })}
                      />
                    </label>
                  )}
                  <label className="slit-cfg-field">
                    <span>求解时限 (秒)</span>
                    <NumberInput
                      min={1}
                      max={180}
                      fallback={30}
                      integer
                      className="field num"
                      value={slitDraft.timeLimitSeconds}
                      onValueChange={(v) => patchSlitDraft({ timeLimitSeconds: v })}
                    />
                  </label>
                </div>

                <details className="slit-adv-fold">
                  <summary className="num">
                    高级参数 · 宽幅≤{slitDraft.maxDistinctWidths}
                  </summary>
                  <div className="slit-cfg-grid" style={{ marginTop: 6 }}>
                    <label className="slit-cfg-field">
                      <span>TOP K 超产</span>
                      <NumberInput
                        min={0}
                        max={50}
                        fallback={0}
                        integer
                        className="field num"
                        value={slitDraft.topK}
                        onValueChange={(v) => patchSlitDraft({ topK: v })}
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>列生成迭代</span>
                      <NumberInput
                        min={1}
                        max={5000}
                        step={10}
                        fallback={300}
                        integer
                        className="field num"
                        value={slitDraft.maxIterations}
                        onValueChange={(v) => patchSlitDraft({ maxIterations: v })}
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>最大花型池</span>
                      <NumberInput
                        min={1}
                        max={20000}
                        step={50}
                        fallback={800}
                        integer
                        className="field num"
                        value={slitDraft.maxPatterns}
                        onValueChange={(v) => patchSlitDraft({ maxPatterns: v })}
                      />
                    </label>
                    <label className="slit-cfg-field">
                      <span>不同宽幅上限</span>
                      <NumberInput
                        min={1}
                        max={20}
                        fallback={4}
                        integer
                        className="field num"
                        value={slitDraft.maxDistinctWidths}
                        onValueChange={(v) => patchSlitDraft({ maxDistinctWidths: v })}
                      />
                    </label>
                    <label className="slit-cfg-field span-2">
                      <span>单阶段时限 (ms)</span>
                      <NumberInput
                        min={1000}
                        max={600000}
                        step={1000}
                        fallback={120000}
                        integer
                        className="field num"
                        value={slitDraft.stageTimeLimitMs}
                        onValueChange={(v) => patchSlitDraft({ stageTimeLimitMs: v })}
                      />
                    </label>
                    <label className="slit-both-toggle span-2">
                      <input
                        type="checkbox"
                        checked={slitDraft.lnsEnabled}
                        onChange={(e) => patchSlitDraft({ lnsEnabled: e.target.checked })}
                      />
                      <span>精细优化启用深度邻域搜索</span>
                    </label>
                  </div>
                </details>
              </div>
            )}

            <div className="mp-side-section" id="demo-input">
              <div className="sec">输入规格与需求 ({inputRows.length})</div>
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
            </div>
          </div>

          {/* Tab 2: 示例说明 (所有背景解释、算法模型、设计目的、检验规则、JSON 契约收敛于此) */}
          <div
            className="mp-detail-side-body mp-about-tab-body"
            hidden={detailTab !== 'about'}
          >
            <div className="mp-about-block">
              <span className="mp-about-label">适用场景</span>
              <p>{activeMeta.scenario}</p>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">算法与约束模型</span>
              <strong>{activeMeta.algorithm}</strong>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">为什么做这个算例（设计目的）</span>
              <p>{activeMeta.why}</p>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">快速检验标准</span>
              <p>{activeMeta.verifyRule}</p>
              {activeVerification && (
                <div
                  className={`mp-about-verdict num ${
                    activeVerification.pass ? 'ok' : 'warn'
                  }`}
                >
                  {activeVerification.detailText}
                </div>
              )}
            </div>
            {(selected.kind === 'marker' || selected.id.startsWith('GARMENT')) && (
              <div className="mp-about-block">
                <span className="mp-about-label">工艺边界说明</span>
                <p>服装曲边为折线近似，未包含对条对格、缝份及任意角度旋转。</p>
              </div>
            )}
            <details className="mp-about-json">
              <summary>查看输入请求 JSON</summary>
              <pre>{JSON.stringify(request, null, 2)}</pre>
            </details>
          </div>
        </aside>
      </div>

      <div className="foot mp-action-foot">
        <span id="demo-state" role="status" className="mp-status-text">
          {stateText}
        </span>
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
          {slit ? '快速搭切' : '开始计算'}
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
    </div>
  );
};
