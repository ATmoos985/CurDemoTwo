export type ShowcaseMainTab = 'lab' | 'scenario' | 'garment';
export type CapabilityCategory =
  | 'all'
  | '2d-guillotine'
  | '2d-contour'
  | '2d-marker'
  | '1d-slitting'
  | 'boundary';
export type DetailSideTab = 'data' | 'about';
export type ThumbKind =
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

export interface CaseMeta {
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

export const CASE_META: Record<string, CaseMeta> = {
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

export const SCENARIO_DOMAINS = [
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

export const CAP_GROUPS: Exclude<CapabilityCategory, 'all'>[] = [
  '2d-guillotine',
  '2d-contour',
  '2d-marker',
  '1d-slitting',
  'boundary'
];

export const CAP_GROUP_TITLES: Record<Exclude<CapabilityCategory, 'all'>, [string, string]> = {
  '2d-guillotine': ['二维套裁与避疵', '通幅直切 · 疵点禁入区避让 · 短料头复用 · 贯通刀序'],
  '2d-contour': ['异形轮廓与密排', '多边形折线包络 · 凹角嵌合 · 服装大小片填空'],
  '2d-marker': ['服装混码齐套缩短', 'M/L 混码全部位 100% 齐套 · 多轮二分缩短唛架长度'],
  '1d-slitting': ['一维分切与搭切', '列生成合卷搭切 · 独立分切基线对比 · 快/精双档'],
  boundary: ['边界与规则对照', '尺寸越界防呆阻断 · 90° 旋转解锁 · 10mm 刀缝间距']
};

export function getCaseMeta(c: any): CaseMeta {
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
