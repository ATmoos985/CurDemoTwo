import {markerExample} from './marker-demo.js';
import {fourPiecePreview} from './dxf-reference.js';

// A second layout found by offline strip search, piece exchanges and compaction of the DXF.
// Coordinates are bounding-box origins (mm) on the solver's 0.1 mm input grid.
const POSITIONS = [
    ["140码 · 后片", 1287.9, 0, 0],
    ["140码 · 前片", 403.8, 409.6, 180],
    ["140码 · 前片", 891.8, 871.1, 0],
    ["140码 · 后片", 9.2, 1275.3, 180],
    ["130码 · 袖子（左）", 863, 462.9, 180],
    ["130码 · 后片", 1328.3, 1310.3, 180],
    ["130码 · 前片", 487.1, 1315.8, 180],
    ["130码 · 后片", 0, 0, 0],
    ["140码 · 袖子（左）", 1351, 905, 0],
    ["140码 · 袖子（左）", 46.8, 870.4, 0],
    ["140码 · 袖子（右）", 435.8, 0, 0],
    ["140码 · 袖子（右）", 927, 1367.7, 180],
    ["130码 · 袖子（右）", 1328.8, 497.3, 180],
    ["130码 · 袖子（左）", 25.9, 462.7, 180],
    ["130码 · 袖子（右）", 514.3, 935.7, 0],
    ["130码 · 前片", 836.1, 0, 0]
];

export function fourPieceSeed(problem) {
    if (problem.material.shape.width !== 1780 || problem.parts.length !== 8 ||
        !problem.parts.every(part => part.quantity === 2 && part.allowHalfTurn)) return;
    const parts = new Map(problem.parts.map(part => [part.name, part]));
    if (!POSITIONS.every(([name]) => parts.has(name))) return;
    return POSITIONS.map(([name,x,y,rotationDegrees]) => ({demandId:parts.get(name).id, x,y,rotationDegrees}));
}

export function fourPieceOptimized() {
    return fourPiecePreview(markerExample(1780, 'GARMENT_FOUR_PIECE', {'130':2,'140':2}), POSITIONS,
        'optimized-1226-shell', 0.0583965);
}
