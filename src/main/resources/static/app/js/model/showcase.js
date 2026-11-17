// 演示数据与场景投影：复用正式计算契约和共享画布，不创建业务方案或库存。
import {basicExample, scenarioExample, garmentExample, boardExample} from '../../../js/nesting/scenario-examples.js';
import {markerExample, MARKER_STYLES} from '../../../js/nesting/marker-demo.js';
import {DXF_GARMENT_STYLES, buildDxfStyleParts} from '../../../js/nesting/dxf-garment-samples.js';
import {INDUSTRIES} from '../../../js/industry/industry-profiles.js';
import {LINEAR_SCENARIOS} from '../../../js/linear/linear-scenarios.js';
import {createNestingScene, rectangle, shapeArea, sceneOrigin} from '../../../js/canvas/nesting-scene.js';
import {PIECE_PALETTE} from './roll-scene.js';
import {DEFAULT_PROCESS} from './task-form.js';
import {markerRequest} from './garment.js';

export const SHOWCASE_CASES = [
    ...INDUSTRIES.flatMap(industry => industry.scenarios.map(s => ({id: s.key, name: s.name, group: industry.name,
        note: ({board: '2440 mm 整板定长分条，精确保留板长。', GARMENT_SHIRT: 'M / L 两个尺码的批量前后片、袖片、领片与袋布，填充一个加工区。', GARMENT_PANTS: 'M / L 批量裤片、裤袋、腰头与门襟，同场搭配。', GUILLOTINE: '主片避开左侧疵点，上方长条与边角辅件共同套裁。', '3': '短料上混排主帘、长条、抱枕与绑带，充分利用余料。'})[s.key] || s.note,
        kind: industry.dimension === '一维' ? 'slitting' : 'nesting'}))),
    {id: 'board-2m', name: '板条 2000 mm · 整米对照', group: '卷材 · 薄膜', kind: 'slitting', note: '同一组条宽改为明确的 2000 mm 示例，比较逐规格分切与搭切。'},
    ...MARKER_STYLES.map(s => ({id: 'marker-' + s.id, name: s.name + ' M / L 齐套唛架', group: '服装齐套',
        note: s.description + '；逐轮缩短试排长度，核对每种衣片数量。', kind: 'marker'})),
    {id: 'rotation-off', name: '旋转限制：未排入', group: '边界与异常', kind: 'nesting', note: '900×600 裁片在 800×1200 材料中禁止旋转，查看未排原因。'},
    {id: 'rotation-on', name: '允许旋转：同尺寸对照', group: '边界与异常', kind: 'nesting', note: '仅开启 90° 旋转，对照上一用例的结果。'},
    {id: 'gap', name: '异形裁片间距 10 mm', group: '边界与异常', kind: 'nesting', note: '衣片保留原轮廓，间隔固定为 10 mm。矩形间距请从业务工作台设置。'}
];

export function showcaseRequest(id, profile = 'FAST') {
    const item = SHOWCASE_CASES.find(c => c.id === id);
    if (!item) throw new Error('演示用例不存在');
    const envelope = {schemaVersion: '2.0', clientRequestId: 'demo-' + id, problemType: 'NESTING_2D', allowFallback: true, requireComplete: false};
    if (item.kind === 'slitting') {
        const source = LINEAR_SCENARIOS[id === 'board-2m' ? 'board' : id], p = source.input, scale = source.lengthUnit === 'm' ? 1000 : 1;
        return {...envelope, problemType: 'SLITTING_1D', allowFallback: false,
            problem: {schemaVersion: '1', unit: 'mm', motherWidthMm: p.motherWidth, leftTrimMm: p.leftTrim, rightTrimMm: p.rightTrim,
                minWidthMm: p.minWidth, maxWidthMm: p.maxWidth, widthStepMm: p.step, totalOverCap: p.totalOverCap,
                profile, timeLimitSeconds: profile === 'QUALITY' ? 30 : 10,
                orders: p.orderItems.map((o, i) => ({id: String(i + 1), widthMm: o.width, lengthMm: id === 'board-2m' ? 2000 : o.length * scale,
                    quantity: o.quantity, surfaceTreatment: o.surfaceTreatment}))}};
    }
    let problem;
    if (item.kind === 'marker') {
        return markerRequest(id.replace('marker-', ''), 1500, undefined, envelope.clientRequestId);
    }
    if (['CROSSCUT', 'GUILLOTINE', 'CONTOUR'].includes(id)) problem = basicExample(id);
    else if (['GARMENT_SHIRT', 'GARMENT_PANTS'].includes(id)) {
        problem = markerExample(1500, id);
        problem.material.shape = rectangle(1500, id === 'GARMENT_SHIRT' ? 2400 : 3600);
        problem.parts.forEach(p => { p.quantity *= 2; });
        problem.timeLimitSeconds = 10;
    } else if (id.startsWith('GARMENT_')) problem = garmentExample(id);
    else if (id.startsWith('BOARD_')) problem = boardExample(id);
    else if (id.startsWith('rotation-')) {
        problem = basicExample('GUILLOTINE'); problem.material = {id, shape: rectangle(800, 1200), exclusions: [], continuesAfterRegion: false};
        problem.parts = [{id: 1, name: '旋转对照裁片', shape: rectangle(900, 600), quantity: 1, allowRotation: id === 'rotation-on'}];
    } else if (id === 'gap') {
        problem = garmentExample('GARMENT_SHIRT'); problem.process.pieceGap = 10;
    } else problem = scenarioExample(id);
    if (id === 'GUILLOTINE') {
        problem.process.startCorner = 'left-bottom';
        problem.parts = [
            {id:1, name:'避疵主帘', shape:rectangle(1500,3000), quantity:1, allowRotation:false},
            {id:2, name:'顶部通幅长条', shape:rectangle(2000,900), quantity:1, allowRotation:false},
            {id:3, name:'侧边辅片', shape:rectangle(450,1300), quantity:2, allowRotation:false},
            {id:4, name:'窄幅挂带', shape:rectangle(120,600), quantity:4, allowRotation:false}
        ];
    }
    if (id === '3') {
        problem.parts[1].quantity = 4;
        problem.parts[2].quantity = 4;
        problem.parts.push({id:4, name:'通幅窗幔长条', shape:rectangle(2000,300), quantity:1, allowRotation:false});
    }
    return {...envelope, problem};
}

/** 将已校验的计算结果投影到新版画布，输出轮廓不二次旋转。 */
export function showcaseScene(request, result = null, patternIndex = 0, {occupiedLengthMm, gapFillPlacements = []} = {}) {
    const p = request.problem;
    let width, length, outline, home, pieces = [], cuts = [], remnants = [], defects = [];
    if (request.problemType === 'SLITTING_1D') {
        const pattern = result?.slitting?.patterns?.[patternIndex];
        width = p.motherWidthMm; length = Math.min(pattern?.lengthMm || p.orders[0].lengthMm, DEFAULT_PROCESS.bedLength);
        let x = p.leftTrimMm;
        for (const station of pattern?.stations || []) for (let i = 0; i < station.countPerRepetition; i++) {
            pieces.push({id: pieces.length + 1, u: 0, v: x, du: length, dv: station.widthMm,
                shape: rectangle(station.widthMm, length), label: `${station.widthMm} mm`, color: PIECE_PALETTE[pieces.length % PIECE_PALETTE.length]});
            x += station.widthMm;
        }
    } else {
        // 唛架策略返回缩短后的加工区，按实际返回尺寸核对材料。
        const layout = result?.layout;
        const input = layout && request.strategy ? {...p, material: {...p.material, shape: layout.processingRegion}} : p;
        const ordered = layout?.placements || [];
        const preview = layout && result.meetsRequirement && gapFillPlacements?.length
            ? {...layout, placements: [...ordered, ...gapFillPlacements]} : layout;
        const sc = createNestingScene(input, preview);
        outline = sc.material.shape;
        // 服装页传入已验齐套的实耗长度。保留原始试排区校验，并避免截断任何已返回图元。
        if (result?.meetsRequirement && outline.type === 'RECTANGLE' && Number.isFinite(occupiedLengthMm)
            && occupiedLengthMm > 0 && occupiedLengthMm < outline.height && sc.placements.length
            && [...sc.placements, ...sc.leftovers, ...sc.exclusions].every(item => item.y + item.shape.height <= occupiedLengthMm)
            && sc.cuts.every(cut => Math.max(cut.startY, cut.endY) <= occupiedLengthMm)) {
            outline = rectangle(outline.width, occupiedLengthMm);
            sc.region.shape = outline;
        }
        const origin = sceneOrigin(sc);
        home = {u: origin.y, v: origin.x};
        width = outline.width; length = outline.height;
        pieces = sc.placements.map((v, i) => {
            const fill = i >= ordered.length;
            const name = v.name || String(v.demandId);
            const label = fill ? `补 · ${name}` : name;
            return {id: fill ? `gap-fill-${i - ordered.length + 1}` : v.id, demandId: v.demandId,
                u: v.y, v: v.x, du: v.shape.height, dv: v.shape.width, shape: v.shape,
                label, ...(fill ? {title: label} : {}),
                color: fill ? '#48b59e' : PIECE_PALETTE[(v.demandId ?? i) % PIECE_PALETTE.length]};
        });
        cuts = sc.cuts.map(c => ({u1: c.startY, v1: c.startX, u2: c.endY, v2: c.endX, type: c.kind, step: c.sequence}));
        remnants = sc.leftovers.map(v => ({id: v.id, x: v.x, y: v.y, w: v.shape.width, l: v.shape.height, shape: v.shape, hasDefect: v.hasDefect}));
        defects = sc.exclusions.map(v => ({id: v.id, u: v.y, v: v.x, du: v.shape.height, dv: v.shape.width, margin: v.clearance || 0, label: '禁入区'}));
    }
    return {roll: {id: '演示材料', width, total: length, used: 0, shape: outline},
        segments: [{id: 'demo', start: 0, len: length, bedLength: length, status: 'pending', label: '计算预览',
            home, pieces, cuts, remnants, pieceArea: pieces.reduce((n, v) => n + shapeArea(v.shape), 0), totalArea: width * length}],
        // 一维只投影默认拉布长度内的定长横切示意；原始请求、结果、面积指标保持真实卷长。
        defects, currentId: 'demo', window: {start: 0, len: length, readOnly: true}, lock: 0, fixed: true};
}

export const WORKFLOW_GUIDES = [
    ['连续搭切与报工', '新建二维任务，需求量覆盖多个工位；选料并计算首工位 → 下达执行单 → 开工 → 报工 → 新工位计算。', '每次报工后母卷已用长度推进，良品完成量增加；预览不扣库存。', 'tasks'],
    ['一维连续出车', '新建一维任务，录入同卷长订单 → 计算分切组合 → 连续出两车 → 逐车执行与报工。', '两车区间不重叠；已预约条数只扣一次，已用长度以实际报工为准。', 'tasks'],
    ['疵点与材料检验', '登记母卷 → 跑布验疵保存疵点 → 完成检验 → 任务中选该卷并排料。', '新方案避开已入档疵点；未检验合格的卷不能下达。', 'inspection'],
    ['料头回收与复用', '报工时勾选实际回收区域及库位 → 库存查看料头 → 同型号任务选择料头排料并报工。', '仅回收实切区；料头整块消耗，不再次扣来源母卷。', 'inventory'],
    ['复检与补产', '已有良品报工 → 选择一件复检 → 转废料或回收料头 → 返回任务查看剩余需求。', '良品履约扣回，补产需求增加；已经消耗的母卷不恢复。', 'quality'],
    ['库存与流水对账', '完成以上报工后，在生产分析中按任务、母卷或料头筛选流水并导出。', '原料耗用、良品、回收与废料分开展示；对账差异可追溯。', 'analysis']
];

// 仅预填表单；用户点击保存后才创建材料或任务。
export const WORKFLOW_TEMPLATES = [
    {id:'dxf-1226', name:'1226 卫衣大货版 DXF 搭切', width:1650, totalLength:20000, bedLength:3600, dxfStyle:'DXF_1226', sizeCounts:{M:2, L:2},
        demands:buildDxfStyleParts('DXF_1226', {sizeCounts:{M:2, L:2}, fabricFilter:'面布', splitMirrorPairs:true}).map(p => [p.name, p.shape.width, p.shape.height, p.quantity, p.shape])},
    {id:'dxf-20148d', name:'20148D 二套版 T恤 DXF 搭切', width:1600, totalLength:20000, bedLength:3200, dxfStyle:'DXF_20148D', sizeCounts:{M:2, L:2},
        demands:buildDxfStyleParts('DXF_20148D', {sizeCounts:{M:2, L:2}, fabricFilter:'面布', splitMirrorPairs:true}).map(p => [p.name, p.shape.width, p.shape.height, p.quantity, p.shape])},
    {id:'dxf-3129', name:'3129 连帽卫衣套装 DXF 搭切', width:1750, totalLength:25000, bedLength:4500, dxfStyle:'DXF_3129', sizeCounts:{M:1, L:1},
        demands:buildDxfStyleParts('DXF_3129', {sizeCounts:{M:1, L:1}, fabricFilter:'面布', splitMirrorPairs:true}).map(p => [p.name, p.shape.width, p.shape.height, p.quantity, p.shape])},
    {id:'continuous', name:'多工位窗帘搭切', width:2000, totalLength:24000, bedLength:3000, demands:[['主帘',1200,1600,8],['短帘',600,800,16],['抱枕',450,450,20]]},
    {id:'slitting', name:'一维连续出车', width:2000, totalLength:30000, bedLength:2050, demands:[['订单 A',600,2000,10],['订单 B',700,2000,5]]},
    {id:'quality', name:'回收复用与复检补产', width:1500, totalLength:12000, bedLength:2000, demands:[['主体裁片',900,1000,4],['配件',300,400,10]]}
];
export function workflowTemplate(id) {
    const t = WORKFLOW_TEMPLATES.find(t => t.id === id);
    if (!t) return null;
    const dxfMeta = t.dxfStyle && DXF_GARMENT_STYLES[t.dxfStyle];
    const materialModel = dxfMeta ? dxfMeta.materialModel : 'DEMO-' + id.toUpperCase();
    return {material:{rollModel:materialModel,width:t.width,length:t.totalLength/1000},
        task:{name:dxfMeta ? `DXF排料 · ${t.name}` : '演示 · '+t.name,materialModel,externalRef:dxfMeta ? `CAD纸样 ${dxfMeta.file}` : '新版业务演示模板',revision:0,
            demands:t.demands.map(([name,width,length,quantity,shape],i)=>({id:i+1,name,width,length,quantity,allowRotation:false,...(shape?{shape:structuredClone(shape)}:{})})),
            process:{bedLength:t.bedLength,trimStart:id==='slitting'?50:0,cutOrigin:'left-top',firstStageOrientation:'horizontal',allowRotation:false,allowLongitudinal:true,pieceGap:0},
            ...(id==='slitting'?{problemType:'SLITTING_1D',slitting:{leftTrim:10,rightTrim:10,minWidth:1800,maxWidth:1980,widthStep:10,totalOverCap:2}}:{})}};
}
