// Benchmark problems, built from code so that every run sends byte-identical request bodies (compare hash()).
// Presets come from the front-end scenario data; the lab examples are copied because nesting-lab.js needs a DOM.
import { createHash } from 'node:crypto';
import { scenarioExample } from '../frontend/src/lib/nesting/scenario-examples.js';
import { rectangle, polygon, shapeArea } from '../frontend/src/lib/canvas/nesting-scene.js';
import { getInitialScenarios } from '../frontend/src/lib/nesting/scenarios.js';

const MAX_PIECES = 10000; // NestingValidation: 单次求解最多支持 10000 件
const CONTINUOUS = { mode: 'GUILLOTINE', feedMode: 'CONTINUOUS', startCorner: 'right-top', firstStageOrientation: 'horizontal',
    trimStart: 0, minReusableWidth: 100, minReusableHeight: 100, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' };
const CONTOUR = { mode: 'CONTOUR', feedMode: 'SHEET', startCorner: 'left-top', firstStageOrientation: 'none', trimStart: 0,
    minReusableWidth: 0, minReusableHeight: 0, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' };
const L_SHAPE = polygon([{x:0,y:0},{x:500,y:0},{x:500,y:200},{x:200,y:200},{x:200,y:500},{x:0,y:500}]);
const TRIANGLE = polygon([{x:0,y:0},{x:400,y:0},{x:0,y:400}]);
// 10 sizes; one copy of each covers 1,047,900 mm², so N/10 copies on 2000 × 30N mm make demand 1.75× the region.
const SIZES = [[300,400],[250,500],[200,300],[350,450],[150,600],[400,400],[220,330],[180,240],[500,260],[320,280]];

export function ringArea(points) {
    return Math.abs(points.reduce((sum, p, i) => {
        const q = points[(i + 1) % points.length];
        return sum + p.x * q.y - q.x * p.y;
    }, 0)) / 2;
}

/** 构造带内孔的多边形形状（兼容 NestingProblem.Shape 协议）。 */
export function polygonWithHoles(vertices, holes = []) {
    return { ...polygon(vertices), holes };
}

/** 计算形状净面积（外环面积扣除所有内孔面积）。 */
export function netShapeArea(value) {
    if (!value) return 0;
    const outer = value.type === 'RECTANGLE' ? value.width * value.height : shapeArea(value);
    const holeArea = Array.isArray(value.holes) ? value.holes.reduce((sum, hole) => sum + ringArea(hole), 0) : 0;
    return Math.max(0, outer - holeArea);
}

/** Small 32-bit generator: the same seed gives the same sequence on every platform. */
export function mulberry32(seed) {
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Same as nesting-lab.js example('GUILLOTINE'), the lab's default 二维避疵 scenario.
const guillotine = () => ({ schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
    material: { id: 'MATERIAL-1', shape: rectangle(2000, 4000), continuesAfterRegion: false,
        exclusions: [{ id: 1, x: 200, y: 1500, shape: rectangle(150, 600), clearance: 50 }] },
    parts: [{ id: 1, name: '矩形裁片', shape: rectangle(1500, 3000), quantity: 1, allowRotation: false }],
    process: { mode: 'GUILLOTINE', feedMode: 'SHEET', startCorner: 'right-bottom', firstStageOrientation: 'horizontal',
        trimStart: 0, minReusableWidth: 100, minReusableHeight: 100, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' } });

// Same as nesting-lab.js example('CONTOUR').
const contour14 = () => ({ schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
    material: { id: 'POLYGON-1', shape: polygon([{x:0,y:0},{x:1600,y:0},{x:1600,y:900},{x:1000,y:900},{x:1000,y:1600},{x:0,y:1600}]),
        continuesAfterRegion: false, exclusions: [{ id: 1, x: 300, y: 300, shape: rectangle(120,120), clearance: 0 }] },
    parts: [{ id: 1, name: 'L 形裁片', shape: L_SHAPE, quantity: 8, allowRotation: true },
        { id: 2, name: '三角裁片', shape: TRIANGLE, quantity: 6, allowRotation: true }],
    process: { ...CONTOUR } });

// 带内孔的复杂异形套料（由 SolverFactory 自动路由至 deepnest 自主求解，无需原生 C++ 二进制）。
const contourHoles16 = () => ({
    schemaVersion: '1',
    unit: 'mm',
    engine: 'auto',
    timeLimitSeconds: 8,
    material: {
        id: 'POLYGON-HOLES-16',
        shape: rectangle(2200, 2400),
        continuesAfterRegion: false,
        exclusions: [{ id: 1, x: 950, y: 1050, shape: rectangle(160, 140), clearance: 20 }]
    },
    parts: [
        {
            id: 1,
            name: '双孔L型法兰板',
            quantity: 6,
            allowRotation: true,
            shape: polygonWithHoles(
                [{x:0,y:0},{x:600,y:0},{x:600,y:260},{x:320,y:260},{x:320,y:560},{x:0,y:560}],
                [
                    [{x:60,y:60},{x:240,y:60},{x:240,y:200},{x:60,y:200}],
                    [{x:360,y:60},{x:540,y:60},{x:540,y:200},{x:360,y:200}]
                ]
            )
        },
        {
            id: 2,
            name: '中空六边形垫片',
            quantity: 6,
            allowRotation: true,
            shape: polygonWithHoles(
                [{x:110,y:0},{x:330,y:0},{x:440,y:200},{x:330,y:400},{x:110,y:400},{x:0,y:200}],
                [[{x:160,y:120},{x:280,y:120},{x:280,y:280},{x:160,y:280}]]
            )
        },
        {
            id: 3,
            name: '开槽梯形连片',
            quantity: 4,
            allowRotation: true,
            shape: polygonWithHoles(
                [{x:60,y:0},{x:420,y:0},{x:480,y:320},{x:0,y:320}],
                [[{x:140,y:80},{x:340,y:80},{x:360,y:240},{x:120,y:240}]]
            )
        }
    ],
    process: { ...CONTOUR }
});

// 1D 分切基础标准题（异步作业 SLITTING_1D，OR-Tools QUALITY）。
const slittingBasic = () => ({
    schemaVersion: '2.0',
    problemType: 'SLITTING_1D',
    clientRequestId: 'bench-slitting-basic',
    allowFallback: false,
    requireComplete: true,
    problem: {
        schemaVersion: '1',
        unit: 'mm',
        motherWidthMm: 2400,
        leftTrimMm: 15,
        rightTrimMm: 15,
        minWidthMm: 2100,
        maxWidthMm: 2370,
        widthStepMm: 10,
        totalOverCap: 6,
        profile: 'QUALITY',
        orders: [
            { id: 'SLIT-1', widthMm: 620, lengthMm: 4000, quantity: 6, surfaceTreatment: 'A' },
            { id: 'SLIT-2', widthMm: 480, lengthMm: 4000, quantity: 8, surfaceTreatment: 'A' },
            { id: 'SLIT-3', widthMm: 350, lengthMm: 4000, quantity: 8, surfaceTreatment: 'A' },
            { id: 'SLIT-4', widthMm: 520, lengthMm: 3000, quantity: 6, surfaceTreatment: 'B' },
            { id: 'SLIT-5', widthMm: 410, lengthMm: 3000, quantity: 6, surfaceTreatment: 'B' }
        ],
        timeLimitSeconds: 5
    }
});

// 2D 异步作业闭环题（NESTING_2D，javaguillotine）。
const nesting2dJob = () => ({
    schemaVersion: '2.0',
    problemType: 'NESTING_2D',
    clientRequestId: 'bench-nesting-2d-job',
    allowFallback: false,
    requireComplete: true,
    problem: { ...guillotine(), engine: 'javaguillotine' }
});

// 多料头 + 多母卷连续接力联排（依赖 --cutdemo.seed-demo-data=true 默认库存，纯只读试排）。
const multiMaterialRelay = () => ({
    materialModel: 'TC涤棉-B2026',
    preferRemnants: true,
    maxRemnants: 6,
    candidateRollIds: ['ROLL-2026-0920', 'ROLL-2026-0921'],
    continueAcrossRolls: true,
    timeBudgetMs: 12000,
    pieceGapMm: 0,
    trimStartMm: 0,
    demands: [
        { id: 1, name: '接力主帘大板', width: 1750, length: 3000, quantity: 22, allowRotation: false },
        { id: 2, name: '料头匹配短帘', width: 900, length: 1400, quantity: 2, allowRotation: true },
        { id: 3, name: '窄幅料头绑定件', width: 450, length: 1200, quantity: 5, allowRotation: false }
    ]
});

// The contour request cap (200 pieces) with twice the sheet's area in demand.
const contour200 = () => ({ schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 20,
    material: { id: 'POLYGON-200', shape: rectangle(3000, 4000), continuesAfterRegion: false,
        exclusions: [{ id: 1, x: 300, y: 300, shape: rectangle(120,120), clearance: 0 }] },
    parts: [{ id: 1, name: 'L 形裁片', shape: L_SHAPE, quantity: 100, allowRotation: true },
        { id: 2, name: '三角裁片', shape: TRIANGLE, quantity: 100, allowRotation: true }],
    process: { ...CONTOUR } });

function synthetic(pieces) {
    if (pieces % 10) throw new Error(`synthetic 的件数必须是 10 的倍数：${pieces}`);
    const length = 30 * pieces;
    return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 20,
        material: { id: `SYNTH-${pieces}`, shape: rectangle(2000, length), continuesAfterRegion: true,
            exclusions: [{ id: 1, x: 700, y: length / 5, shape: rectangle(120, 80), clearance: 20 },
                { id: 2, x: 1500, y: Math.round(length * 41 / 60), shape: rectangle(60, 300), clearance: 20 }] },
        parts: SIZES.map(([w, h], i) => ({ id: i + 1, name: `规格${i + 1}`, shape: rectangle(w, h), quantity: pieces / 10, allowRotation: i % 2 === 0 })),
        process: { ...CONTINUOUS } };
}

// One piece per demand, all sizes different: as many native item types as pieces, the worst case for COPIES.
function distinct(pieces) {
    const random = mulberry32(20261018), seen = new Set(), parts = [];
    while (parts.length < pieces) {
        const w = 150 + Math.floor(random() * 351), h = 200 + Math.floor(random() * 401);
        if (seen.has(`${w}x${h}`)) continue;
        seen.add(`${w}x${h}`);
        parts.push({ id: parts.length + 1, name: `件${parts.length + 1}`, shape: rectangle(w, h), quantity: 1, allowRotation: parts.length % 2 === 0 });
    }
    const length = Math.round(parts.reduce((sum, p) => sum + p.shape.width * p.shape.height, 0) / 1.75 / 2000);
    return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 20,
        material: { id: `SYNTH-${pieces}-DISTINCT`, shape: rectangle(2000, length), continuesAfterRegion: true,
            exclusions: [{ id: 1, x: 700, y: Math.round(length / 5), shape: rectangle(120, 80), clearance: 20 }] },
        parts, process: { ...CONTINUOUS } };
}

const FIXED = {
    guillotine: { kind: 'nesting', title: '裁切试验台默认：二维避疵，1 件', build: guillotine },
    'guillotine-java': { kind: 'nesting', title: '自主二维直刀（javaguillotine）：二维避疵，1 件', build: () => ({ ...guillotine(), engine: 'javaguillotine' }) },
    'scenario4-java': { kind: 'nesting', title: '自主二维直刀（javaguillotine）：预设案例 4（74 件）', build: () => ({ ...scenarioExample(4), engine: 'javaguillotine' }) },
    contour14: { kind: 'nesting', title: '裁切试验台异形示例（自主 deepnest）：L 形 8 件 + 三角 6 件', build: contour14 },
    'contour14-native': { kind: 'nesting', title: '异形原生对照（packingsolver-irregular）：L 形 8 件 + 三角 6 件', build: () => ({ ...contour14(), engine: 'packingsolver-irregular' }) },
    'contour-holes-16': { kind: 'nesting', title: '复杂异形带内孔（deepnest）：双孔L型+中空六边形+开槽梯形共 16 件', build: contourHoles16 },
    'nesting-2d-job': { kind: 'optimization-job', title: '2D 异步作业闭环门禁（javaguillotine）：二维避疵 1 件', build: nesting2dJob },
    'slitting-basic': { kind: 'optimization-job', title: '1D 分条排刀门禁：双表面处理 5 规格 34 卷（ortools-1d QUALITY）', build: slittingBasic },
    'multi-material-relay': { kind: 'multi-material', title: '多料头+多母卷接力联排：3料头消化辅件 + 2母卷跨卷接力主帘', build: multiMaterialRelay },
    contour200: { kind: 'nesting', title: '异形上限（自主 deepnest）：L 形与三角各 100 件，3000×4000 板', build: contour200 },
};
const FAMILIES = [
    { pattern: /^scenario(\d+)$/, title: n => getInitialScenarios()[n]?.name, build: n => {
        if (!getInitialScenarios()[n]) throw new Error(`没有预设案例 ${n}`);
        return scenarioExample(n);
    } },
    { pattern: /^synthetic(\d+)$/, capped: true, title: n => `合成 ${n} 件：10 种规格各 ${n / 10} 件，2000×${30 * n} mm 连续卷`, build: synthetic },
    { pattern: /^distinct(\d+)$/, capped: true, title: n => `合成 ${n} 种不同规格各 1 件（mulberry32 种子 20261018）`, build: distinct },
];

export const SETS = {
    smoke: ['guillotine', 'guillotine-java', 'contour14', 'scenario4', 'synthetic2000'],
    demo: ['guillotine', 'contour14', ...Object.keys(getInitialScenarios()).map(id => `scenario${id}`)],
    'v2-gate': ['guillotine-java', 'scenario1', 'scenario4-java', 'contour14', 'contour-holes-16', 'nesting-2d-job', 'slitting-basic', 'multi-material-relay'],
    large: ['synthetic2000', 'synthetic10000', 'contour200'],
    compare: ['guillotine-java', 'scenario4-java', 'contour14', 'contour14-native'],
};
SETS.all = [...SETS.demo, ...SETS.large];

/** Named problems for --list; the scenario/synthetic/distinct families also accept other sizes. */
export function problemNames() {
    return [...new Set([...SETS.all, ...SETS['v2-gate'], ...SETS.compare, 'distinct2000'])];
}

export function problemKind(body) {
    if (body?.problemType) return 'optimization-job';
    if (Array.isArray(body?.demands) && body?.materialModel) return 'multi-material';
    return 'nesting';
}

export function problem(name) {
    if (FIXED[name]) return { name, kind: FIXED[name].kind, title: FIXED[name].title, body: FIXED[name].build() };
    for (const family of FAMILIES) {
        const match = family.pattern.exec(name);
        if (!match) continue;
        const n = Number(match[1]);
        if (family.capped && !(n >= 1 && n <= MAX_PIECES)) throw new Error(`${name}：件数须为 1–${MAX_PIECES}`);
        return { name, kind: 'nesting', title: family.title(n), body: family.build(n) };
    }
    throw new Error(`未知题目 ${name}；可用：${problemNames().join(', ')}，以及 synthetic<N>、distinct<N>`);
}

/** The engine SolverFactory dispatches to: an explicit engine, otherwise by process mode. */
export function expectedEngine(body) {
    if (body?.problemType === 'SLITTING_1D') return 'ortools-1d';
    if (body?.problemType === 'NESTING_2D') return expectedEngine(body.problem);
    if (Array.isArray(body?.demands) && body?.materialModel) return 'javaguillotine';
    if (body.engine && body.engine !== 'auto') return body.engine;
    return { CROSSCUT: 'crosscut', CONTOUR: 'deepnest' }[body.process.mode] ?? 'packingsolver';
}

export function hash(body) {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
}

export function describe(body, kind = problemKind(body)) {
    if (kind === 'optimization-job' && body.problemType === 'SLITTING_1D') {
        const p = body.problem;
        const pieces = p.orders.reduce((sum, o) => sum + o.quantity, 0);
        return {
            mode: 'SLITTING_1D',
            feedMode: p.profile,
            material: `${p.motherWidthMm}mm(净${p.motherWidthMm - p.leftTrimMm - p.rightTrimMm})`,
            parts: p.orders.length,
            pieces,
            demandRatio: 1,
            exclusions: 0,
            timeLimitSeconds: p.timeLimitSeconds
        };
    }
    if (kind === 'optimization-job' && body.problemType === 'NESTING_2D') {
        const inner = describe(body.problem, 'nesting');
        return { ...inner, mode: `JOB:${inner.mode}` };
    }
    if (kind === 'multi-material') {
        const pieces = body.demands.reduce((sum, d) => sum + d.quantity, 0);
        return {
            mode: 'MULTI_MAT',
            feedMode: body.continueAcrossRolls ? 'RELAY' : 'SINGLE',
            material: `${body.materialModel}(${body.candidateRollIds?.length ?? 0}卷+${body.maxRemnants ?? 0}料头)`,
            parts: body.demands.length,
            pieces,
            demandRatio: 1,
            exclusions: 0,
            timeLimitSeconds: Math.ceil((body.timeBudgetMs ?? 6000) / 1000)
        };
    }
    const pieces = body.parts.reduce((sum, p) => sum + p.quantity, 0);
    const demand = body.parts.reduce((sum, p) => sum + p.quantity * netShapeArea(p.shape), 0);
    return { mode: body.process.mode, feedMode: body.process.feedMode,
        material: `${body.material.shape.width}×${body.material.shape.height}`, parts: body.parts.length, pieces,
        demandRatio: +(demand / netShapeArea(body.material.shape)).toFixed(2), exclusions: body.material.exclusions.length,
        timeLimitSeconds: body.timeLimitSeconds };
}

function overrideTimeLimit(body, kind, timeLimitSeconds) {
    if (timeLimitSeconds == null) return body;
    if (kind === 'optimization-job') {
        return { ...body, problem: { ...body.problem, timeLimitSeconds } };
    }
    if (kind === 'multi-material') {
        return { ...body, timeBudgetMs: timeLimitSeconds * 1000 };
    }
    return { ...body, timeLimitSeconds };
}

/** A problem as it will be sent, with an optional time-limit override, the hash of that body and what it asks for. */
export function prepare(name, timeLimitSeconds = null) {
    const { kind, title, body: canonical } = problem(name);
    const body = overrideTimeLimit(canonical, kind, timeLimitSeconds);
    return { name, kind, title, body, hash: hash(body), expectedEngine: expectedEngine(body), ...describe(body, kind) };
}
