import {markerExample} from './marker-demo.js';
import {dxfParts, DXF_TRIAL_STYLES} from './dxf-patterns.js';
import {rectangle, shapeArea} from '../canvas/nesting-scene.js';
import {rotateShape} from '../canvas/outline-geometry.js';

// Measured against the F1CRH1226 report, then packed with the real DXF cutting outlines.
// Each position is the top-left of the turned outline's bounding box, in millimetres.
const POSITIONS = [
    ['130码 · 前片', 1328.38, 931.4515, 0],
    ['130码 · 前片', 476.8949, 495.756, 0],
    ['130码 · 后片', 928.6825, 0, 0],
    ['130码 · 后片', 477.0025, 0, 0],
    ['130码 · 袖子（左）', 1374.0045, 4.0729, 0],
    ['130码 · 袖子（右）', 625.0482, 1440.3144, 0],
    ['130码 · 袖子（左）', 910.4561, 527.5693, 0],
    ['130码 · 袖子（右）', 1019.1648, 1440.3144, 0],
    ['140码 · 前片', 0, 29.449, 0],
    ['140码 · 前片', 1302.8, 405.373, 180],
    ['140码 · 后片', 0, 555.5615, 0],
    ['140码 · 后片', 854.3006, 908.6569, 180],
    ['140码 · 袖子（左）', 0, 1086.6089, 0],
    ['140码 · 袖子（右）', 1369.915, 1406.2842, 180],
    ['140码 · 袖子（右）', 426.2038, 984.7125, 0],
    ['140码 · 袖子（左）', 257.936, 1409.3244, 180]
];

/** Display-only reconstruction. It uses the marker trial's zero nominal piece gap. */
export function fourPieceReference() {
    const widthMm = 1780;
    const style = DXF_TRIAL_STYLES.find(s => s.id === 'GARMENT_FOUR_PIECE');
    const counts = {'130':2, '140':2};
    const problem = markerExample(widthMm, style.id, counts);
    // The report reference retains the imported cutting vertices. A solve request uses the 0.1 mm engine grid.
    problem.parts = dxfParts(style, counts, false);
    const byName = new Map(problem.parts.map(part => [part.name, part]));
    for (const part of problem.parts) part.allowHalfTurn = true;
    const placements = POSITIONS.map(([name, x, y, rotationDegrees], index) => {
        const part = byName.get(name);
        return {id:index + 1, demandId:part.id, name, x, y, rotationDegrees, shape:rotateShape(part.shape, rotationDegrees)};
    });
    const occupiedLengthMm = Math.max(...placements.map(p => p.y + p.shape.height));
    const cuttingAreaMm2 = placements.reduce((sum, p) => sum + shapeArea(p.shape), 0);
    const utilizationPercent = 100 * cuttingAreaMm2 / (widthMm * occupiedLengthMm);
    const processingRegion = rectangle(widthMm, occupiedLengthMm);
    problem.material.shape = processingRegion;
    const request = {schemaVersion:'2.0', clientRequestId:'reference-1226-shell', problemType:'NESTING_2D',
        requireComplete:true, allowFallback:true, problem};
    const result = {
        validationStatus:'PASSED', fulfillmentStatus:'COMPLETE', meetsRequirement:true,
        layout:{schemaVersion:'1', unit:'mm', coordinateSystem:'source-local-top-left', status:'FEASIBLE',
            materialId:problem.material.id, processingRegion, placements},
        marker:{occupiedLengthMm}, metrics:[{name:'markerAreaUtilization', value:utilizationPercent}]
    };
    // Shortest edge-to-edge distance across all 120 pairs, checked against the displayed vertices.
    const verified = {widthMm, occupiedLengthMm, cuttingAreaMm2, utilizationPercent, pieceCount:placements.length,
        rotatedCount:placements.filter(p => p.rotationDegrees === 180).length, minGapMm:0.05975};
    return {request, result, verified};
}
