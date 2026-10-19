/**
 * 行业场景与规则目录：介绍页、场景演示页和通用操作台的行业预设共用同一份数据。
 * 状态口径：ready 生产流程可用；demo 只能预览或属近似实现；none 当前版本没有。
 */
export const STATUS = Object.freeze({ready: '已支持', demo: '演示级', none: '未支持'});

/** 通用操作台“设置 → 工艺与切刀 / 料头管理策略”中可被行业预设改写的字段，与 settings.js 的 cfg-* 对应。 */
export const PRESET_FIELDS = Object.freeze([
    {key: 'defectMargin', id: 'cfg-defect-margin', label: '疵点避让间距', unit: 'mm'},
    {key: 'trimStart', id: 'cfg-trim-start', label: '卷头修边', unit: 'mm'},
    {key: 'allowRotation', id: 'cfg-allow-rot', label: '裁片旋转', options: {0: '禁止旋转', 1: '允许 90° 旋转'}},
    {key: 'allowLongitudinal', id: 'cfg-allow-longi', label: '机台纵切', options: {0: '仅横切', 1: '支持纵切'}},
    {key: 'minRemnantWidth', id: 'cfg-min-rem-w', label: '料头最小宽', unit: 'mm'},
    {key: 'minRemnantLength', id: 'cfg-min-rem-l', label: '料头最小长', unit: 'mm'}
]);

const rule = (name, value, status, where) => ({name, value, status, where});
const scenario = (key, name, note) => ({key, name, note});

export const INDUSTRIES = Object.freeze([
    {
        id: 'curtain', name: '窗帘 · 家纺', dimension: '二维',
        lead: '门幅宽、整幅长条多：以整幅横切为主，绕开布面疵点，剩余料头回库复用。',
        cuts: ['整幅横切', '贯通套裁', '疵点避让', '料头复用', '连续送料'],
        rules: [
            rule('整幅横切', '按需求顺序一刀切到边', 'ready', '操作台 · 场景演示「整幅横切」'),
            rule('疵点避让间距', '默认 20 mm，疵点外扩为禁入区', 'ready', '设置 → 工艺与切刀'),
            rule('裁片旋转', '默认禁止，保持经向', 'ready', '设置 → 工艺与切刀'),
            rule('机台纵切能力', '支持分条 + 断刀，也可限定仅横切', 'ready', '设置 → 工艺与切刀'),
            rule('卷头修边', '默认 0 mm', 'ready', '设置 → 工艺与切刀'),
            rule('裁片间距', '0–100 mm，成品尺寸不变', 'ready', '操作台 → 机台与工艺参数'),
            rule('料头回收门槛', '默认宽 200 × 长 300 mm', 'ready', '设置 → 料头管理策略'),
            rule('连续送料', '母卷长于工位时自动接续', 'ready', '操作台 · 场景演示「连续送料工位」'),
            rule('机床代码 / DXF 导出', '导出机床代码或 DXF 文件', 'ready', '操作台 → 工具与设置'),
            rule('对花 · 花型循环', '按花距对齐裁片', 'none', '')
        ],
        presets: [{
            id: 'curtain', name: '窗帘 · 家纺',
            values: {defectMargin: 20, trimStart: 0, allowRotation: 0, allowLongitudinal: 1, minRemnantWidth: 200, minRemnantLength: 300}
        }],
        scenarios: [
            scenario('CROSSCUT', '整幅横切', '三件整幅裁片按需求顺序横切到边'),
            scenario('GUILLOTINE', '二维避疵', '幅面上有一处疵点，大件裁片绕开疵点区'),
            scenario('3', '短料头复用', '在库短料头上套裁飘窗短帘、抱枕与挂带'),
            scenario('4', '多规格套裁', '窗幔、平幔、绑带与抱枕同幅直刀套裁'),
            scenario('6', '连续送料工位', '60 m 大卷按工位接续，展示接续边界')
        ]
    },
    {
        id: 'garment', name: '服装', dimension: '二维',
        lead: '裁片形状各异、多件混排：异形轮廓排料，经向固定，以实际利用率与未排数量评价。',
        cuts: ['异形轮廓排料', '多件混排', '经向固定'],
        rules: [
            rule('轮廓排料', '简单多边形，曲边按折线近似', 'demo', '场景演示 · 服装'),
            rule('布纹方向', '示例固定经向，不旋转', 'demo', '场景演示 · 服装'),
            rule('90° 步进旋转', '引擎支持，示例默认关闭', 'demo', '场景演示 · 异形排料'),
            rule('多件混排', '上衣、长裤、半裙及衣身袖片密排', 'demo', '场景演示 · 服装'),
            rule('刀序 · 刀补', '轮廓只是裁片边界预览', 'none', ''),
            rule('任意角度旋转 · 弧线 · 孔洞', '', 'none', ''),
            rule('对条对格', '', 'none', ''),
            rule('多材料 / 多床联合优化', '', 'none', '')
        ],
        presets: [{
            id: 'garment', name: '服装（矩形裁切参数）',
            values: {defectMargin: 10, trimStart: 50, allowRotation: 0, allowLongitudinal: 1, minRemnantWidth: 100, minRemnantLength: 100}
        }],
        scenarios: [
            scenario('CONTOUR', '异形排料', 'L 形与三角形裁片，含一处禁入区'),
            scenario('GARMENT_SHIRT', '上衣裁片', '衣身、袖片等多边形裁片'),
            scenario('GARMENT_PANTS', '长裤裁片', '前后片、腰头等'),
            scenario('GARMENT_SKIRT', '半裙裁片', '前后片、腰头等'),
            scenario('GARMENT_FULL', '衣身袖片密排', '增加贴袋需求，求解约 10 秒')
        ]
    },
    {
        id: 'board', name: '板材', dimension: '二维',
        lead: '定尺整板开料：贯通直切并输出刀序；木纹板禁止旋转，素色板允许旋转以换取更高出材率。',
        cuts: ['贯通直切', '纹理方向', '缺陷区避让', '余料回收'],
        rules: [
            rule('贯通直切 + 刀序', '全刀直切，输出切割顺序', 'ready', '场景演示 · 板材'),
            rule('纹理方向', '木纹板禁止旋转，素色板允许 90°', 'ready', '场景演示 · 板材'),
            rule('缺陷区避让', '缺陷以禁入区外扩安全距离', 'ready', '设置 → 工艺与切刀'),
            rule('余料回收', '按最小回收尺寸划分整板余料', 'ready', '设置 → 料头管理策略'),
            rule('锯缝补偿', '以裁片间距近似；引擎按 0 刀缝计算', 'demo', '操作台 → 机台与工艺参数'),
            rule('板边修边', '仅起始端修边，四边修边未支持', 'demo', '设置 → 工艺与切刀'),
            rule('多板联合排料 · 板材库存', '', 'none', ''),
            rule('封边 · 排钻 · 标签', '', 'none', '')
        ],
        presets: [
            {id: 'board-plain', name: '板材 · 素色板',
                values: {defectMargin: 30, trimStart: 0, allowRotation: 1, allowLongitudinal: 1, minRemnantWidth: 300, minRemnantLength: 300}},
            {id: 'board-grain', name: '板材 · 木纹板',
                values: {defectMargin: 30, trimStart: 0, allowRotation: 0, allowLongitudinal: 1, minRemnantWidth: 300, minRemnantLength: 300}}
        ],
        scenarios: [
            scenario('BOARD_GRAIN', '木纹板 · 禁止旋转', '同一批柜体裁片，裁片固定纹理方向'),
            scenario('BOARD_PLAIN', '素色板 · 允许旋转', '同一批柜体裁片，允许 90° 旋转')
        ]
    },
    {
        id: 'roll', name: '卷材 · 薄膜', dimension: '一维',
        lead: '母卷按幅宽方向切成多条：把不同订单的条宽搭配到同一母卷，尽量用满幅宽。',
        cuts: ['幅宽分条', '多订单搭切', '选组重切'],
        rules: [
            rule('母卷幅宽与左右固定切边', '光学膜示例母卷 4600 mm，左右各 100 mm', 'ready', '分切工作台 → 母卷与固定切边'),
            rule('组合宽度上下限与步长', '光学膜示例 4200–4400 mm，步长 10 mm', 'ready', '分切工作台 → 组合宽度'),
            rule('卷长 + 表面处理分组', '同卷长、同表面处理的订单才会搭切', 'ready', '分切工作台 → 分切需求'),
            rule('超产上限', '示例均为 30 卷', 'ready', '分切工作台 → 组合宽度'),
            rule('快速计算 / 精细优化', '精细优化耗时更长，不承诺全局最优', 'ready', '分切工作台 · 搭切对比'),
            rule('选组重切 · 撤销调整', '只重算勾选的组合', 'ready', '分切工作台'),
            rule('Excel 导入 / 导出', '支持长阳 APS 与线下模板，导出保留输出模板', 'ready', '分切工作台'),
            rule('刀缝补偿', '条宽需已含锯缝', 'none', '')
        ],
        presets: [],
        scenarios: [
            scenario('film', '光学膜', '四个客户、同卷长，幅宽混搭'),
            scenario('curtain', '卷帘面料', '涂层面料开条，条宽差异大'),
            scenario('board', '板条开条', '1220 × 2440 整板开条，锯缝已含在条宽内')
        ]
    }
]);

/** 切割能力总览：engines 为 /api/v1/nesting/engines 中的引擎标识；demo 为场景演示键，link 为一维页面。 */
export const CAPABILITIES = Object.freeze([
    {id: 'crosscut', dimension: '二维', name: '整幅横切', status: 'ready', engines: ['crosscut'], demo: 'CROSSCUT',
        text: '按需求顺序沿整幅一刀切到边，需求宽度等于材料宽度。'},
    {id: 'guillotine', dimension: '二维', name: '矩形贯通套裁', status: 'ready', engines: ['javaguillotine', 'packingsolver'], demo: '4',
        text: '多规格矩形混排，全刀直切并输出刀序，可逐件限定是否允许旋转 90°。'},
    {id: 'defect', dimension: '二维', name: '疵点 / 缺陷区避让', status: 'ready', engines: [], demo: 'GUILLOTINE',
        text: '疵点按安全距离外扩为禁入区，裁片不压疵，其余面积尽量排满。'},
    {id: 'remnant', dimension: '二维', name: '料头复用与余料回收', status: 'ready', engines: [], demo: '3',
        text: '先用在库短料头套裁，剩余面积按最小回收尺寸划分为候选余料。'},
    {id: 'continuous', dimension: '二维', name: '连续送料', status: 'ready', engines: [], demo: '6',
        text: '母卷长于工位时按工位接续，报工后推进到下一工位。'},
    {id: 'contour', dimension: '二维', name: '异形轮廓排料', status: 'ready', engines: ['javairregular', 'packingsolver-irregular'], demo: 'GARMENT_FULL',
        text: '简单多边形与 90° 步进旋转；输出裁片边界，尚无刀序刀补，也不划分余料。'},
    {id: 'linear', dimension: '一维', name: '幅宽分条搭切', status: 'ready', engines: [], link: '/linear-demo.html',
        text: '把不同订单的条宽组合到同一母卷，受组合宽度上下限与固定切边约束，减少母卷用量。'},
    {id: 'profile', dimension: '一维', name: '快速计算 / 精细优化', status: 'ready', engines: [], link: '/linear-demo.html',
        text: '快速通常数秒内出方案，精细优化搜索更久；两者都不承诺全局最优。'},
    {id: 'recut', dimension: '一维', name: '选组重切与 Excel 导出', status: 'ready', engines: [], link: '/linear.html',
        text: '只重算勾选的组合，可撤销；方案导出 Excel 并保留长阳输出模板。'}
]);

export const industry = id => INDUSTRIES.find(item => item.id === id) ?? null;

/** 二维场景键所属的行业；一维演示场景不在场景演示页中。 */
export const industryOfScenario = key => INDUSTRIES.find(item => item.dimension === '二维' && item.scenarios.some(s => s.key === String(key))) ?? null;

export const presets = () => INDUSTRIES.flatMap(item => item.presets.map(preset => ({...preset, industry: item.id})));

/** 当前设置值与哪个行业预设完全一致；都不一致返回空串（自定义）。 */
export function matchPreset(values) {
    const same = preset => PRESET_FIELDS.every(({key}) => Number(values?.[key]) === preset.values[key]);
    return presets().find(same)?.id ?? '';
}

/** 预设值的可读摘要，用于设置面板与介绍页：“疵点避让间距 20 mm · 禁止旋转 …”。 */
export function describePreset(values) {
    return PRESET_FIELDS.map(({key, label, unit, options}) => ({label, text: options ? options[values[key]] : `${values[key]} ${unit}`}));
}

const MODES = {GUILLOTINE: '矩形贯通切割', CROSSCUT: '整幅横切', CONTOUR: '轮廓排料'};

/** 当前标准输入里实际用到的规则，场景演示页据此列出“本场景用到了什么规则”。 */
export function scenarioRules(problem) {
    const {material, parts, process} = problem;
    const exclusions = material.exclusions?.length ?? 0, rotating = parts.filter(part => part.allowRotation).length;
    const rows = [
        ['排料方式', MODES[process.mode] ?? process.mode],
        ['材料', `${material.shape.width} × ${material.shape.height} mm · ${process.feedMode === 'CONTINUOUS' ? '连续送料' : '整块材料'}${material.continuesAfterRegion ? '，末端接续' : ''}`],
        ['裁片旋转', !rotating ? '全部禁止旋转' : rotating === parts.length ? '全部允许 90° 旋转' : `${rotating} / ${parts.length} 种允许 90° 旋转`],
        ['禁入区', exclusions ? `${exclusions} 处（疵点 / 缺陷）` : '无']
    ];
    if (process.mode !== 'CONTOUR') {
        rows.push(['入口修边', `${process.trimStart} mm`], ['最小回收', `${process.minReusableWidth} × ${process.minReusableHeight} mm`]);
    }
    return rows.map(([name, value]) => ({name, value}));
}
