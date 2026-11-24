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
