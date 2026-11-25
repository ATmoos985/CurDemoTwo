import test from 'node:test';
import assert from 'node:assert/strict';
import { gcodeText, dxfText, homePoint } from '../../main/resources/static/js/plugins/export/cam-format.js';

const FIXED_NOW = new Date('2026-11-25T00:00:00.000Z');

test('直刀模式 data.cuts 非空时逐字节保持向后兼容', () => {
    const data = {
        rollId: 'ROLL-TEST-01',
        rollW: 2000,
        bedL: 3000,
        windowStartY: 500,
        cutOrigin: 'left-top',
        cuts: [
            { step: 1, type: '横切', startX: 0, startY: 1000, endX: 2000, endY: 1000, info: '第1刀' },
            { step: 2, type: '纵切', startX: 800, startY: 0, endX: 800, endY: 1000 }
        ]
    };
    const out = gcodeText(data, { now: FIXED_NOW });
    assert.match(out, /\( TOTAL CUTS\s+:\s+2 STEPS\s+\)/);
    assert.match(out, /G00 X0\.000 Y1000\.000 Z10\.000 \(Rapid Air Move\)/);
    assert.match(out, /G01 X2000\.000 Y1000\.000 Z0\.000 F4000 \(Cutting Feed\)/);
    assert.match(out, /G01 X800\.000 Y1000\.000 Z0\.000 F4000 \(Cutting Feed\)/);
    assert.match(out, /\(TOTAL CUT DISTANCE: 3000 mm \| TOTAL AIR DISTANCE:/);
});

test('异形多边形裁片 cuts 为空时按闭合轮廓生成提刀/下刀/G1/抬刀指令，杜绝 0 STEPS 空程序', () => {
    const data = {
        rollId: 'ROLL-CONTOUR-01',
        rollW: 1650,
        bedL: 2400,
        windowStartY: 0,
        cutOrigin: 'left-top',
        cuts: [],
        placements: [
            {
                id: 1,
                name: '120码 · 卫衣前片',
                x: 100,
                y: 200,
                shape: {
                    type: 'POLYGON',
                    width: 400,
                    height: 300,
                    vertices: [
                        { x: 0, y: 0 },
                        { x: 400, y: 0 },
                        { x: 400, y: 300 },
                        { x: 100, y: 300 }
                    ]
                }
            },
            {
                id: 2,
                name: '多边形直接传入 polygon 字段',
                x: 600,
                y: 200,
                w: 200,
                l: 200,
                polygon: [
                    [0, 0],
                    [200, 0],
                    [200, 200],
                    [0, 200]
                ]
            }
        ]
    };
    const out = gcodeText(data, { now: FIXED_NOW, home: homePoint({ cutOrigin: 'left-top', width: 1650, length: 2400 }) });
    assert.doesNotMatch(out, /TOTAL CUTS\s*:\s*0 STEPS/, '异形裁片绝不能输出 0 STEPS 空程序');
    assert.match(out, /\( TOTAL CUTS\s+:\s+2 CONTOURS \(8 STEPS\)/);

    // 验证第一片完整闭环：提刀至 (100,200) -> 下刀 -> (500,200) -> (500,500) -> (200,500) -> 闭合回 (100,200) -> 抬刀
    const firstBlockIdx = out.indexOf('(--- CONTOUR 1: 120码 · 卫衣前片');
    assert.ok(firstBlockIdx > 0);
    const secondBlockIdx = out.indexOf('(--- CONTOUR 2: 多边形直接传入 polygon 字段');
    assert.ok(secondBlockIdx > firstBlockIdx);

    const block1 = out.slice(firstBlockIdx, secondBlockIdx);
    assert.match(block1, /G00 X100\.000 Y200\.000 Z10\.000 \(Rapid Air Move\)/);
    assert.match(block1, /M03 S1\s+\(Tool Down \/ Laser ON\)/);
    const g1Lines1 = block1.split('\n').filter(line => line.startsWith('G01 '));
    assert.equal(g1Lines1.length, 4, '4 顶点多边形应有 4 条闭合 G01 边线');
    assert.match(g1Lines1[0], /G01 X500\.000 Y200\.000 Z0\.000 F4000/);
    assert.match(g1Lines1[1], /G01 X500\.000 Y500\.000 Z0\.000 F4000/);
    assert.match(g1Lines1[2], /G01 X200\.000 Y500\.000 Z0\.000 F4000/);
    assert.match(g1Lines1[3], /G01 X100\.000 Y200\.000 Z0\.000 F4000/);
    assert.match(block1, /M05\s+\(Tool Up \/ Laser OFF\)/);

    // 验证第二片 polygon 坐标偏移正确
    const block2 = out.slice(secondBlockIdx);
    assert.match(block2, /G00 X600\.000 Y200\.000 Z10\.000/);
    assert.match(block2, /G01 X800\.000 Y400\.000 Z0\.000 F4000/);
    assert.match(block2, /G01 X600\.000 Y200\.000 Z0\.000 F4000/);

    const distMatch = out.match(/TOTAL CUT DISTANCE:\s*(\d+)\s*mm/);
    assert.ok(distMatch && Number(distMatch[1]) > 1800, '异形总切割距离必须大于 0');
});

test('矩形裁片 cuts 为空且仅传 pieces 时按四角轮廓闭合切割并计算准确周长', () => {
    const data = {
        rollId: 'ROLL-RECT-01',
        rollW: 1500,
        bedL: 2000,
        windowStartY: 0,
        cutOrigin: 'left-top',
        cuts: [],
        pieces: [
            { id: 1, name: '门板A', x: 50, y: 100, w: 300, l: 500 }
        ]
    };
    const out = gcodeText(data, { now: FIXED_NOW });
    assert.doesNotMatch(out, /TOTAL CUTS\s*:\s*0 STEPS/);
    assert.match(out, /TOTAL CUTS\s+:\s+1 CONTOURS \(4 STEPS\)/);
    assert.match(out, /G00 X50\.000 Y100\.000 Z10\.000/);
    assert.match(out, /G01 X350\.000 Y100\.000 Z0\.000 F4000/);
    assert.match(out, /G01 X350\.000 Y600\.000 Z0\.000 F4000/);
    assert.match(out, /G01 X50\.000 Y600\.000 Z0\.000 F4000/);
    assert.match(out, /G01 X50\.000 Y100\.000 Z0\.000 F4000/);
    // 周长 = 2 * (300 + 500) = 1600 mm
    assert.match(out, /TOTAL CUT DISTANCE: 1600 mm/);
});

test('DXF 导出仍保留完整图层与多边形实体', () => {
    const dxf = dxfText({
        rollW: 1600,
        bedL: 2000,
        pieces: [{ id: 1, name: '异形片', x: 10, y: 20, w: 100, l: 100, shape: { type: 'POLYGON', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }] } }]
    });
    assert.match(dxf, /1_PIECES/);
    assert.match(dxf, /10\n10\.000\n20\n20\.000/);
    assert.match(dxf, /EOF$/);
});

test('带单孔裁片 G-Code 严格先切内孔再切外轮廓、计入内孔周长与空程，且 DXF 合法输出内孔图层线段', () => {
    const data = {
        rollId: 'ROLL-HOLE-01',
        rollW: 1600,
        bedL: 2000,
        windowStartY: 0,
        cutOrigin: 'left-top',
        cuts: [],
        placements: [
            {
                id: 10,
                name: '窗框面板A',
                x: 100,
                y: 200,
                shape: {
                    type: 'POLYGON',
                    width: 600,
                    height: 400,
                    vertices: [
                        { x: 0, y: 0 },
                        { x: 600, y: 0 },
                        { x: 600, y: 400 },
                        { x: 0, y: 400 }
                    ],
                    holes: [
                        // 含连续重复点与首尾闭合重复点，检验 normalizeContourPoints 去重归一化
                        [
                            { x: 100, y: 100 },
                            { x: 100, y: 100 },
                            { x: 200, y: 100 },
                            { x: 200, y: 200 },
                            { x: 100, y: 200 },
                            { x: 100, y: 100 }
                        ]
                    ]
                }
            }
        ]
    };

    const nc = gcodeText(data, { now: FIXED_NOW, home: { x: 0, y: 0 } });
    assert.match(nc, /\( TOTAL CUTS\s+:\s+2 CONTOURS \(8 STEPS\)/);

    const holeHeaderIdx = nc.indexOf('(--- CONTOUR 1: 窗框面板A [INNER HOLE #1] (4 PTS, L=400mm) ---)');
    const outerHeaderIdx = nc.indexOf('(--- CONTOUR 2: 窗框面板A [OUTER CONTOUR] (4 PTS, L=2000mm) ---)');
    assert.ok(holeHeaderIdx > 0, 'G-Code 应明确标注内孔 INNER HOLE 注释头');
    assert.ok(outerHeaderIdx > holeHeaderIdx, 'G-Code 必须严格先切内孔、再切外轮廓');

    const holeBlock = nc.slice(holeHeaderIdx, outerHeaderIdx);
    const outerBlock = nc.slice(outerHeaderIdx);

    // 内孔世界坐标：(200,300) -> (300,300) -> (300,400) -> (200,400) -> 闭合回 (200,300)
    assert.match(holeBlock, /G00 X200\.000 Y300\.000 Z10\.000 \(Rapid Air Move\)/);
    const holeG1 = holeBlock.split('\n').filter(line => line.startsWith('G01 '));
    assert.equal(holeG1.length, 4, '正方形内孔应有 4 段闭合 G01 轨迹');
    assert.match(holeG1[0], /G01 X300\.000 Y300\.000 Z0\.000 F4000/);
    assert.match(holeG1[1], /G01 X300\.000 Y400\.000 Z0\.000 F4000/);
    assert.match(holeG1[2], /G01 X200\.000 Y400\.000 Z0\.000 F4000/);
    assert.match(holeG1[3], /G01 X200\.000 Y300\.000 Z0\.000 F4000/);

    // 外轮廓世界坐标起点 (100,200) 必须出现在内孔之后
    assert.match(outerBlock, /G00 X100\.000 Y200\.000 Z10\.000 \(Rapid Air Move\)/);
    assert.match(outerBlock, /G01 X700\.000 Y200\.000 Z0\.000 F4000/);
    assert.match(outerBlock, /G01 X700\.000 Y600\.000 Z0\.000 F4000/);
    assert.match(outerBlock, /G01 X100\.000 Y600\.000 Z0\.000 F4000/);
    assert.match(outerBlock, /G01 X100\.000 Y200\.000 Z0\.000 F4000/);

    // 总切程 = 外轮廓 2000 + 内孔 400 = 2400 mm；总空走程 = hypot(200,300) + hypot(-100,-100) ≈ 502 mm
    const expectedAir = Math.round(Math.hypot(200, 300) + Math.hypot(100 - 200, 200 - 300));
    assert.match(nc, new RegExp(`TOTAL CUT DISTANCE: 2400 mm \\| TOTAL AIR DISTANCE: ${expectedAir} mm`));

    // 验证 R12 DXF 图层声明与内孔闭合线段
    const dxf = dxfText(data);
    assert.match(dxf, /0\nTABLE\n2\nLAYER\n70\n7/);
    assert.match(dxf, /0\nLAYER\n2\n1_PIECES_HOLES\n70\n0\n62\n2\n6\nCONTINUOUS/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n200\.000\n20\n300\.000\n30\n0\.0\n11\n300\.000\n21\n300\.000\n31\n0\.0/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n300\.000\n20\n300\.000\n30\n0\.0\n11\n300\.000\n21\n400\.000\n31\n0\.0/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n300\.000\n20\n400\.000\n30\n0\.0\n11\n200\.000\n21\n400\.000\n31\n0\.0/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n200\.000\n20\n400\.000\n30\n0\.0\n11\n200\.000\n21\n300\.000\n31\n0\.0/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES\n10\n100\.000\n20\n200\.000\n30\n0\.0\n11\n700\.000\n21\n200\.000\n31\n0\.0/);
    assert.match(dxf, /0\nEOF$/);
});

test('多裁片多孔洞混合格式（数组与 {vertices}）严格全部内孔先于所有外轮廓且忽略退化孔洞', () => {
    const data = {
        rollId: 'ROLL-MULTI-HOLES',
        rollW: 2000,
        bedL: 2500,
        windowStartY: 0,
        cutOrigin: 'left-top',
        cuts: [],
        pieces: [
            {
                id: 1,
                name: '多孔垫片1',
                x: 50,
                y: 50,
                w: 500,
                l: 300,
                shape: {
                    type: 'POLYGON',
                    width: 500,
                    height: 300,
                    vertices: [
                        { x: 0, y: 0 },
                        { x: 500, y: 0 },
                        { x: 500, y: 300 },
                        { x: 0, y: 300 }
                    ],
                    holes: [
                        // 孔1：对象顶点数组（周长 200）
                        [
                            { x: 50, y: 50 },
                            { x: 100, y: 50 },
                            { x: 100, y: 100 },
                            { x: 50, y: 100 }
                        ],
                        // 孔2：{ vertices } 包裹 + 二维数组坐标（直角三角形 3-4-5 边长 60/80/100，周长 240）
                        {
                            vertices: [
                                [200, 50],
                                [260, 50],
                                [200, 130]
                            ]
                        },
                        // 退化孔（不足 3 有效顶点）应被安全过滤
                        [{ x: 10, y: 10 }, { x: 20, y: 20 }]
                    ]
                }
            },
            {
                id: 2,
                name: '单孔垫片2',
                x: 700,
                y: 50,
                w: 300,
                l: 300,
                shape: {
                    type: 'RECTANGLE',
                    width: 300,
                    height: 300,
                    holes: [
                        // 孔3：{ vertices } 对象数组（周长 400）
                        {
                            vertices: [
                                { x: 100, y: 100 },
                                { x: 200, y: 100 },
                                { x: 200, y: 200 },
                                { x: 100, y: 200 }
                            ]
                        }
                    ]
                }
            }
        ]
    };

    const nc = gcodeText(data, { now: FIXED_NOW, home: { x: 0, y: 0 } });
    // 3 有效内孔（4+3+4=11 步） + 2 外轮廓（4+4=8 步） = 5 CONTOURS (19 STEPS)
    assert.match(nc, /\( TOTAL CUTS\s+:\s+5 CONTOURS \(19 STEPS\)/);

    const h1Idx = nc.indexOf('多孔垫片1 [INNER HOLE #1]');
    const h2Idx = nc.indexOf('多孔垫片1 [INNER HOLE #2]');
    const h3Idx = nc.indexOf('单孔垫片2 [INNER HOLE #1]');
    const o1Idx = nc.indexOf('多孔垫片1 [OUTER CONTOUR]');
    const o2Idx = nc.indexOf('单孔垫片2 [OUTER CONTOUR]');
    assert.ok(h1Idx > 0 && h2Idx > h1Idx && h3Idx > h2Idx, '全部内孔必须按序输出');
    assert.ok(o1Idx > h3Idx && o2Idx > o1Idx, '所有内孔必须严格出现在全部外轮廓之前');

    // 验证所有内孔关键轨迹点都出现在首个外轮廓之前
    const holeRegion = nc.slice(0, o1Idx);
    assert.match(holeRegion, /G00 X100\.000 Y100\.000 Z10\.000/); // 垫片1孔1起点 (50+50, 50+50)
    assert.match(holeRegion, /G01 X310\.000 Y100\.000 Z0\.000 F4000/); // 垫片1孔2顶点 (50+260, 50+50)
    assert.match(holeRegion, /G01 X900\.000 Y250\.000 Z0\.000 F4000/); // 垫片2孔1顶点 (700+200, 50+200)

    // 总切程 = 孔1(200) + 孔2(240) + 孔3(400) + 外1(1600) + 外2(1200) = 3640 mm
    assert.match(nc, /TOTAL CUT DISTANCE: 3640 mm/);

    // DXF 验证：1_PIECES_HOLES 应恰好包含 4 + 3 + 4 = 11 条内孔 LINE 实体
    const dxf = dxfText(data);
    const holeLines = dxf.match(/0\nLINE\n8\n1_PIECES_HOLES\n/g) || [];
    assert.equal(holeLines.length, 11, 'DXF 内孔图层应输出全部 3 个有效内孔的 11 条闭合线段');
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n250\.000\n20\n100\.000\n30\n0\.0\n11\n310\.000\n21\n100\.000\n31\n0\.0/);
    assert.match(dxf, /0\nLINE\n8\n1_PIECES_HOLES\n10\n800\.000\n20\n150\.000\n30\n0\.0\n11\n900\.000\n21\n150\.000\n31\n0\.0/);
});
