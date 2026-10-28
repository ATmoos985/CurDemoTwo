// Benchmark problems, built from code so that every run sends byte-identical request bodies (compare hash()).
// Presets come from the front-end scenario data; the lab examples are copied because nesting-lab.js needs a DOM.
import { createHash } from 'node:crypto';
import { scenarioExample } from '../src/main/resources/static/js/nesting/scenario-examples.js';
import { rectangle, polygon, shapeArea } from '../src/main/resources/static/js/canvas/nesting-scene.js';
import { getInitialScenarios } from '../src/main/resources/static/js/plugins/presets/scenarios.js';

const MAX_PIECES = 10000; // NestingValidation: 单次求解最多支持 10000 件
const CONTINUOUS = { mode: 'GUILLOTINE', feedMode: 'CONTINUOUS', startCorner: 'right-top', firstStageOrientation: 'horizontal',
    trimStart: 0, minReusableWidth: 100, minReusableHeight: 100, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' };
const CONTOUR = { mode: 'CONTOUR', feedMode: 'SHEET', startCorner: 'left-top', firstStageOrientation: 'none', trimStart: 0,
    minReusableWidth: 0, minReusableHeight: 0, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' };
const L_SHAPE = polygon([{x:0,y:0},{x:500,y:0},{x:500,y:200},{x:200,y:200},{x:200,y:500},{x:0,y:500}]);
const TRIANGLE = polygon([{x:0,y:0},{x:400,y:0},{x:0,y:400}]);
// 10 sizes; one copy of each covers 1,047,900 mm², so N/10 copies on 2000 × 30N mm make demand 1.75× the region.
const SIZES = [[300,400],[250,500],[200,300],[350,450],[150,600],[400,400],[220,330],[180,240],[500,260],[320,280]];

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
    guillotine: { title: '裁切试验台默认：二维避疵，1 件', build: guillotine },
    contour14: { title: '裁切试验台异形示例：L 形 8 件 + 三角 6 件', build: contour14 },
    contour200: { title: '异形上限：L 形与三角各 100 件，3000×4000 板', build: contour200 },
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
    smoke: ['guillotine', 'contour14', 'scenario4', 'synthetic2000'],
    demo: ['guillotine', 'contour14', ...Object.keys(getInitialScenarios()).map(id => `scenario${id}`)],
    large: ['synthetic2000', 'synthetic10000', 'contour200'],
};
SETS.all = [...SETS.demo, ...SETS.large];

/** Named problems for --list; the scenario/synthetic/distinct families also accept other sizes. */
export function problemNames() {
    return [...new Set([...SETS.all, 'distinct2000'])];
}

export function problem(name) {
    if (FIXED[name]) return { name, title: FIXED[name].title, body: FIXED[name].build() };
    for (const family of FAMILIES) {
        const match = family.pattern.exec(name);
        if (!match) continue;
        const n = Number(match[1]);
        if (family.capped && !(n >= 1 && n <= MAX_PIECES)) throw new Error(`${name}：件数须为 1–${MAX_PIECES}`);
        return { name, title: family.title(n), body: family.build(n) };
    }
    throw new Error(`未知题目 ${name}；可用：${problemNames().join(', ')}，以及 synthetic<N>、distinct<N>`);
}

/** The engine SolverFactory dispatches to: an explicit engine, otherwise by process mode. */
export function expectedEngine(body) {
    if (body.engine && body.engine !== 'auto') return body.engine;
    return { CROSSCUT: 'crosscut', CONTOUR: 'packingsolver-irregular' }[body.process.mode] ?? 'packingsolver';
}

export function hash(body) {
    return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12);
}

export function describe(body) {
    const pieces = body.parts.reduce((sum, p) => sum + p.quantity, 0);
    const demand = body.parts.reduce((sum, p) => sum + p.quantity * shapeArea(p.shape), 0);
    return { mode: body.process.mode, feedMode: body.process.feedMode,
        material: `${body.material.shape.width}×${body.material.shape.height}`, parts: body.parts.length, pieces,
        demandRatio: +(demand / shapeArea(body.material.shape)).toFixed(2), exclusions: body.material.exclusions.length,
        timeLimitSeconds: body.timeLimitSeconds };
}

/** A problem as it will be sent, with an optional time-limit override, the hash of that body and what it asks for. */
export function prepare(name, timeLimitSeconds = null) {
    const { title, body: canonical } = problem(name);
    const body = timeLimitSeconds == null ? canonical : { ...canonical, timeLimitSeconds };
    return { name, title, body, hash: hash(body), expectedEngine: expectedEngine(body), ...describe(body) };
}
