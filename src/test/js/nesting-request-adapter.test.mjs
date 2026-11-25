import test from 'node:test';
import assert from 'node:assert/strict';
import {
    quantize01,
    normalizePolygonShape01,
    buildSafeNestingRequest2D,
    unpadGuillotineResult
} from '../../main/resources/static/js/business/optimization/nesting-request-adapter.js';

test('CONTOUR mode forces left-top startCorner, none firstStage, and converts trimStart into top exclusion', () => {
    const built = buildSafeNestingRequest2D({
        strategy: {id: 'PS_FIXED', enginePref: 'auto', shorten: true, halfTurn: false, timeLimit: 10},
        scenario: 'SHORTEN_KIT',
        widthMm: 1650,
        lengthMm: 1600,
        pieceGapMm: 0,
        trimStartMm: 50,
        demands: [{
            id: 1,
            name: '120码·前片',
            width: 430.05,
            length: 462.04,
            quantity: 2,
            shape: {
                type: 'POLYGON',
                width: 430.05,
                height: 462.04,
                vertices: [{x: 0.04, y: 0.02}, {x: 430.09, y: 0.02}, {x: 430.09, y: 462.06}, {x: 0.04, y: 462.06}, {x: 0.04, y: 0.02}]
            }
        }],
        settings: {startCorner: 'right-bottom', firstStageOrientation: 'vertical', minRemnantWidthMm: 200, minRemnantLengthMm: 300, timeLimitSeconds: 5}
    });
    assert.equal(built.error, null);
    const p = built.request.problem;
    assert.equal(p.process.mode, 'CONTOUR');
    assert.equal(p.process.startCorner, 'left-top');
    assert.equal(p.process.firstStageOrientation, 'none');
    assert.equal(p.process.trimStart, 0);
    assert.equal(p.process.minReusableWidth, 0);
    assert.equal(p.process.minReusableHeight, 0);
    // trimStart=50 converted into a top exclusion zone
    assert.equal(p.material.exclusions.length, 1);
    assert.deepEqual(p.material.exclusions[0], {
        id: 1, x: 0, y: 0, shape: {type: 'RECTANGLE', width: 1650, height: 50}, clearance: 0
    });
    // vertices quantized to 0.1 mm and closing duplicate removed
    assert.equal(p.parts[0].shape.vertices.length, 4);
    for (const v of p.parts[0].shape.vertices) {
        assert.ok(Math.abs(v.x * 10 - Math.round(v.x * 10)) < 1e-9);
        assert.ok(Math.abs(v.y * 10 - Math.round(v.y * 10)) < 1e-9);
    }
});

test('GUILLOTINE mode with pieceGap > 0 pads request cleanly and unpads returned placements', () => {
    const built = buildSafeNestingRequest2D({
        strategy: {id: 'JAVA_FAST', enginePref: 'java', shorten: false, timeLimit: 5},
        scenario: 'FIXED_BED',
        widthMm: 1000,
        lengthMm: 2000,
        pieceGapMm: 5.5,
        trimStartMm: 20,
        demands: [
            {id: 1, name: '窗帘A', width: 490, length: 600, quantity: 2, allowRotation: false},
            {id: 1, name: '重复ID窗帘B', width: 300, length: 500, quantity: 1, allowRotation: true}
        ],
        settings: {startCorner: 'right-top', firstStageOrientation: 'vertical', timeLimitSeconds: 5}
    });
    assert.equal(built.error, null);
    const p = built.request.problem;
    assert.equal(p.process.mode, 'GUILLOTINE');
    assert.equal(p.process.pieceGap, 0);
    assert.equal(p.process.startCorner, 'right-top');
    assert.equal(p.process.firstStageOrientation, 'vertical');
    assert.equal(p.material.shape.width, 1005.5);
    assert.equal(p.material.shape.height, 2005.5);
    assert.equal(p.parts[0].shape.width, 495.5);
    assert.equal(p.parts[0].shape.height, 605.5);
    // duplicate demand id auto-deduplicated
    assert.notEqual(p.parts[0].id, p.parts[1].id);

    const fakeResult = {
        layout: {
            processingRegion: {type: 'RECTANGLE', width: 1005.5, height: 2005.5, vertices: []},
            placements: [
                {id: 1, demandId: p.parts[0].id, x: 0, y: 20, rotationDegrees: 0, shape: {type: 'RECTANGLE', width: 495.5, height: 605.5, vertices: []}},
                {id: 2, demandId: p.parts[1].id, x: 495.5, y: 20, rotationDegrees: 90, shape: {type: 'RECTANGLE', width: 505.5, height: 305.5, vertices: []}}
            ],
            leftovers: [
                {id: 1, x: 0, y: 625.5, shape: {type: 'RECTANGLE', width: 1005.5, height: 1380, vertices: []}, hasDefect: false}
            ],
            cuts: [
                {sequence: 1, kind: 'HORIZONTAL', startX: 0, startY: 625.5, endX: 1005.5, endY: 625.5}
            ],
            metrics: {reusableAreaMm2: 1387590}
        }
    };
    const restored = unpadGuillotineResult(fakeResult, built);
    assert.equal(restored.layout.placements[0].shape.width, 490);
    assert.equal(restored.layout.placements[0].shape.height, 600);
    assert.equal(restored.layout.placements[1].shape.width, 500);
    assert.equal(restored.layout.placements[1].shape.height, 300);
    assert.equal(restored.layout.processingRegion.width, 1000);
    assert.equal(restored.layout.leftovers[0].shape.width, 1000);
    assert.equal(restored.layout.leftovers[0].shape.height, 1374.5);
    assert.equal(restored.layout.cuts[0].endX, 1000);
});

test('CONTOUR preflight rejects >200 pieces cleanly, removes fold-back spikes, and caps >128 vertices', () => {
    assert.equal(Object.is(quantize01(-0.001), 0), true);
    const norm = normalizePolygonShape01({type: 'POLYGON', width: 100.04, height: 200.06, vertices: [{x: 0, y: 0}, {x: 100.04, y: 0}, {x: 100.04, y: 200.06}]});
    assert.equal(norm.width, 100);
    assert.equal(norm.height, 200.1);

    // Collinear fold-back spike (0,0) -> (50,0) -> (40,0) -> (100,0) -> (100,100) -> (0,100)
    const spikeCleaned = normalizePolygonShape01({
        type: 'POLYGON',
        width: 100,
        height: 100,
        vertices: [{x: 0, y: 0}, {x: 50, y: 0}, {x: 40, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}]
    });
    assert.ok(spikeCleaned.vertices.length <= 5);

    // 160-vertex circle simplified to <= 128
    const circle = Array.from({length: 160}, (_, i) => {
        const a = (2 * Math.PI * i) / 160;
        return {x: 100 + 100 * Math.cos(a), y: 100 + 100 * Math.sin(a)};
    });
    const simplified = normalizePolygonShape01({type: 'POLYGON', width: 200, height: 200, vertices: circle});
    assert.ok(simplified.vertices.length <= 128 && simplified.vertices.length >= 64);

    const tooMany = buildSafeNestingRequest2D({
        strategy: {id: 'PS_FIXED', enginePref: 'auto', shorten: true, timeLimit: 10},
        widthMm: 1650,
        lengthMm: 1600,
        demands: [{
            id: 1, name: '片', width: 100, length: 100, quantity: 205,
            shape: {type: 'POLYGON', width: 100, height: 100, vertices: [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}]}
        }]
    });
    assert.match(tooMany.error, /最多 200 件/);
});

test('求解策略绝不越权放开禁用旋转或禁用半转的裁片，且经向策略可安全收紧为 0°', () => {
    const polyShape = {
        type: 'POLYGON',
        width: 200,
        height: 300,
        vertices: [{x: 0, y: 0}, {x: 200, y: 0}, {x: 180, y: 300}, {x: 0, y: 300}]
    };
    const rectBuilt = buildSafeNestingRequest2D({
        strategy: {id: 'PS_ROT', enginePref: 'auto', forceRotateRect: true, halfTurn: true, shorten: true, timeLimit: 10},
        widthMm: 1600,
        lengthMm: 2000,
        demands: [
            {id: 1, name: '直纹窗帘禁转', width: 600, length: 800, quantity: 2, allowRotation: false},
            {id: 2, name: '素色配件可转', width: 300, length: 500, quantity: 2, allowRotation: true}
        ]
    });
    assert.equal(rectBuilt.error, null);
    assert.equal(rectBuilt.request.problem.parts[0].allowRotation, false);
    assert.equal(rectBuilt.request.problem.parts[1].allowRotation, true);

    const contourBuilt = buildSafeNestingRequest2D({
        strategy: {id: 'DN_GA', enginePref: 'deepnest', halfTurn: true, forceRotateRect: true, shorten: true, timeLimit: 8},
        widthMm: 1600,
        lengthMm: 2000,
        demands: [
            {id: 1, name: '倒顺毛禁半转', width: 200, length: 300, quantity: 2, allowRotation: false, allowHalfTurn: false, shape: polyShape},
            {id: 2, name: '允许半转裁片', width: 200, length: 300, quantity: 2, allowRotation: false, allowHalfTurn: true, shape: polyShape}
        ]
    });
    assert.equal(contourBuilt.error, null);
    assert.equal(contourBuilt.request.problem.parts[0].allowRotation, false);
    assert.equal(contourBuilt.request.problem.parts[0].allowHalfTurn, undefined);
    assert.equal(contourBuilt.request.problem.parts[1].allowHalfTurn, true);

    const fixedBuilt = buildSafeNestingRequest2D({
        strategy: {id: 'PS_FIXED', enginePref: 'auto', lockZeroGrain: true, shorten: true, timeLimit: 10},
        widthMm: 1600,
        lengthMm: 2000,
        demands: [
            {id: 2, name: '允许半转裁片', width: 200, length: 300, quantity: 2, allowRotation: true, allowHalfTurn: true, shape: polyShape}
        ]
    });
    assert.equal(fixedBuilt.error, null);
    assert.equal(fixedBuilt.request.problem.parts[0].allowRotation, false);
    assert.equal(fixedBuilt.request.problem.parts[0].allowHalfTurn, undefined);
});

test('带孔多边形归一化按外轮廓相同 minX/minY 平移并 0.1mm 量化保留 shape.holes，无孔不附带空字段', () => {
    // 1. 无孔多边形绝不附带 holes 字段，保持旧测试与旧请求零漂移
    const noHole = normalizePolygonShape01({
        type: 'POLYGON',
        width: 200,
        height: 150,
        vertices: [{x: 10, y: 20}, {x: 210, y: 20}, {x: 210, y: 170}, {x: 10, y: 170}]
    });
    assert.equal('holes' in noHole, false, '无孔裁片不应附带空 holes 字段');

    // 2. 带孔多边形：外轮廓带偏移 (10.04, 20.06)，内孔含闭合重复点、亚毫米坐标与退化孔洞
    const withHoles = normalizePolygonShape01({
        type: 'POLYGON',
        width: 500,
        height: 400,
        vertices: [
            {x: 10.04, y: 20.06},
            {x: 510.08, y: 20.06},
            {x: 510.08, y: 420.12},
            {x: 10.04, y: 420.12},
            {x: 10.04, y: 20.06}
        ],
        holes: [
            [
                {x: 110.09, y: 120.11},
                {x: 210.09, y: 120.11},
                {x: 210.09, y: 220.11},
                {x: 110.09, y: 220.11},
                {x: 110.09, y: 120.11}
            ],
            // {vertices} 包裹与数组顶点形态同样兼容
            {
                vertices: [
                    [310.04, 120.06],
                    [370.04, 120.06],
                    [310.04, 200.06]
                ]
            },
            // 退化孔洞应被静默过滤
            [{x: 50, y: 50}, {x: 60, y: 50}]
        ]
    });
    assert.equal(withHoles.width, 500);
    assert.equal(withHoles.height, 400.1);
    assert.equal(withHoles.holes.length, 2, '应保留 2 个有效内孔并过滤退化孔');
    assert.deepEqual(withHoles.holes[0], [
        {x: 100.1, y: 100.1},
        {x: 200.1, y: 100.1},
        {x: 200.1, y: 200.1},
        {x: 100.1, y: 200.1}
    ]);
    assert.deepEqual(withHoles.holes[1], [
        {x: 300, y: 100},
        {x: 360, y: 100},
        {x: 300, y: 180}
    ]);

    // 3. 构造完整 2D 排料请求时，shape.holes 完整透传至 problem.parts[*].shape.holes
    const built = buildSafeNestingRequest2D({
        strategy: {id: 'PS_FIXED', enginePref: 'auto', shorten: true, timeLimit: 10},
        scenario: 'SHORTEN_KIT',
        widthMm: 1600,
        lengthMm: 2000,
        demands: [{
            id: 7,
            name: '带孔窗口面板',
            width: 500,
            length: 400,
            quantity: 2,
            shape: {
                type: 'POLYGON',
                width: 500,
                height: 400,
                vertices: [
                    {x: 5, y: 10},
                    {x: 505, y: 10},
                    {x: 505, y: 410},
                    {x: 5, y: 410}
                ],
                holes: [
                    [
                        {x: 105.04, y: 110.06},
                        {x: 205.04, y: 110.06},
                        {x: 205.04, y: 210.06},
                        {x: 105.04, y: 210.06}
                    ]
                ]
            }
        }]
    });
    assert.equal(built.error, null);
    assert.equal(built.request.problem.process.mode, 'CONTOUR');
    const partShape = built.request.problem.parts[0].shape;
    assert.equal(partShape.holes.length, 1);
    assert.deepEqual(partShape.holes[0], [
        {x: 100, y: 100.1},
        {x: 200, y: 100.1},
        {x: 200, y: 200.1},
        {x: 100, y: 200.1}
    ]);
});
