import { describe, it, expect } from 'vitest';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { readFileSync } from 'node:fs';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { fileURLToPath } from 'node:url';
import { parseDxfText } from '../dxf-parser.js';
import { signedArea2 } from '../dxf-geometry.js';
import { parseDxfGarmentText } from '../dxf-garment-samples.js';
import { normalizePolygonShape01 } from '../../domain/nesting-request-adapter.js';

function dxfDoc(bodyLines, headerLines = []) {
  return [
    '0', 'SECTION',
    '2', 'HEADER',
    ...headerLines,
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
    ...bodyLines,
    '0', 'ENDSEC',
    '0', 'EOF'
  ].join('\n');
}

describe('dxf-parser', () => {
  it('支持 $INSUNITS (inch/cm/m/mm) 自动换算及 unitOverride 覆盖', () => {
    const rectLines = [
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0',
      '10', '10', '20', '0',
      '10', '10', '20', '5',
      '10', '0', '20', '5'
    ];

    const inchRes = parseDxfText(dxfDoc(rectLines, ['9', '$INSUNITS', '70', '1']));
    expect(inchRes.unit).toBe('inch');
    expect(inchRes.groups[0].demands[0].width).toBe(254);
    expect(inchRes.groups[0].demands[0].length).toBe(127);

    const cmRes = parseDxfText(dxfDoc(rectLines, ['9', '$INSUNITS', '70', '5']));
    expect(cmRes.groups[0].demands[0]).toMatchObject({ width: 100, length: 50 });

    const mRes = parseDxfText(dxfDoc(rectLines, ['9', '$INSUNITS', '70', '6']));
    expect(mRes.groups[0].demands[0]).toMatchObject({ width: 10000, length: 5000 });

    const overrideRes = parseDxfText(dxfDoc(rectLines, ['9', '$INSUNITS', '70', '1']), { unitOverride: 'cm' });
    expect(overrideRes.unit).toBe('cm');
    expect(overrideRes.groups[0].demands[0]).toMatchObject({ width: 100, length: 50 });
  });

  it('支持经典 POLYLINE + VERTEX (含组码 42 凸度圆弧) 解析', () => {
    const dxf = dxfDoc([
      '0', 'POLYLINE', '8', '0', '70', '1',
      '0', 'VERTEX', '8', '0', '10', '0', '20', '0', '42', '0',
      '0', 'VERTEX', '8', '0', '10', '200', '20', '0', '42', '1',
      '0', 'VERTEX', '8', '0', '10', '200', '20', '100', '42', '0',
      '0', 'VERTEX', '8', '0', '10', '0', '20', '100', '42', '0',
      '0', 'SEQEND'
    ]);
    const res = parseDxfText(dxf);
    expect(res.groups[0].demands).toHaveLength(1);
    const d = res.groups[0].demands[0];
    expect(d.width).toBeCloseTo(250, 0);
    expect(d.length).toBe(100);
    expect(d.shape.vertices.length).toBeGreaterThan(4);
  });

  it('支持 LWPOLYLINE 凸度圆角、POLYLINE+VERTEX、CIRCLE 与 SPLINE 离散并抽稀至 <= 128 顶点', () => {
    // 含半圆凸度(bulge=1)的跑道形 LWPOLYLINE + 高密度 CIRCLE
    const dxf = dxfDoc([
      '0', 'LWPOLYLINE', '8', '0', '70', '1',
      '10', '100', '20', '0', '42', '0',
      '10', '300', '20', '0', '42', '1',
      '10', '300', '20', '100', '42', '0',
      '10', '100', '20', '100', '42', '1',
      '0', 'CIRCLE', '8', '0', '10', '1000', '20', '1000', '40', '250',
      '0', 'SPLINE', '8', '0', '70', '1', '71', '2',
      '10', '2000', '20', '0',
      '10', '2150', '20', '0',
      '10', '2150', '20', '120',
      '10', '2000', '20', '120'
    ]);
    const res = parseDxfText(dxf, { chordToleranceMm: 0.05, maxVerticesPerRing: 128 });
    const demands = res.groups[0].demands;
    expect(demands).toHaveLength(3);
    for (const d of demands) {
      expect(d.shape.type).toBe('POLYGON');
      expect(d.shape.vertices.length).toBeGreaterThanOrEqual(3);
      expect(d.shape.vertices.length).toBeLessThanOrEqual(128);
      const norm = normalizePolygonShape01(d.shape);
      expect(norm.vertices.length).toBeLessThanOrEqual(128);
    }
    const stadium = demands.find(d => Math.abs(d.length - 100) < 1);
    expect(stadium?.width).toBeCloseTo(300, 0);
  });

  it('支持散落乱序 LINE + ARC 容差拼接闭环及未闭合残段 warning', () => {
    // 乱序的 3 条 LINE + 1 条 ARC 构成矩形右侧半圆口（带 0.2mm 误差）+ 1 条孤立开放线
    const dxf = dxfDoc([
      '0', 'LINE', '8', '0', '10', '200', '20', '100', '11', '0', '21', '100',
      '0', 'LINE', '8', '0', '10', '0.1', '20', '0', '11', '200', '21', '0.1',
      '0', 'ARC', '8', '0', '10', '200', '20', '50', '40', '50', '50', '270', '51', '90',
      '0', 'LINE', '8', '0', '10', '0', '20', '100', '11', '0', '21', '0',
      '0', 'LINE', '8', '0', '10', '900', '20', '900', '11', '950', '21', '950'
    ]);
    const res = parseDxfText(dxf, { endpointToleranceMm: 0.5 });
    expect(res.groups[0].demands).toHaveLength(1);
    expect(res.groups[0].demands[0].width).toBeCloseTo(250, 0);
    expect(res.groups[0].demands[0].length).toBeCloseTo(100, 0);
    expect(res.warnings.some(w => w.includes('未闭合'))).toBe(true);

    // 未闭合纯散线抛错
    expect(() =>
      parseDxfText(dxfDoc(['0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '100', '21', '0']))
    ).toThrow(/未闭合|未能/);
  });

  it('支持 BLOCKS + INSERT 平移、非等比缩放、旋转与负缩放镜像变换', () => {
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'TRI_PART', '10', '0', '20', '0',
      '0', 'LWPOLYLINE', '8', '0', '70', '1',
      '10', '0', '20', '0',
      '10', '100', '20', '0',
      '10', '0', '20', '50',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      // 放大2倍并旋转90° -> 宽变成 100 (原50*2), 高变成 200 (原100*2)
      '0', 'INSERT', '8', '0', '2', 'TRI_PART', '10', '500', '20', '500', '41', '2', '42', '2', '50', '90',
      // 负缩放镜像 (-1, 1)
      '0', 'INSERT', '8', '0', '2', 'TRI_PART', '10', '1000', '20', '0', '41', '-1', '42', '1', '50', '0',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');

    const res = parseDxfText(dxf);
    const demands = res.groups[0].demands;
    expect(demands).toHaveLength(2);
    const scaledRotated = demands.find(d => d.width === 100 && d.length === 200);
    const mirrored = demands.find(d => d.width === 100 && d.length === 50);
    expect(scaledRotated).toBeDefined();
    expect(mirrored).toBeDefined();
    expect(signedArea2(scaledRotated!.shape.vertices)).toBeGreaterThan(0);
    expect(signedArea2(mirrored!.shape.vertices)).toBeGreaterThan(0);
  });

  it('支持内孔 holes 语义图层与几何嵌套提取、外 CCW / 内 CW 绕序校准与 normalizePolygonShape01 兼容', () => {
    const dxf = dxfDoc([
      // 外矩形 500x400 (刻意使用 CW 绕序输入，测试自动纠偏为 CCW)
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '100', '20', '100',
      '10', '100', '20', '500',
      '10', '600', '20', '500',
      '10', '600', '20', '100',
      // 孔1：语义图层 HOLE，矩形孔（刻意使用 CCW 输入，测试自动纠偏为 CW）
      '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
      '10', '150', '20', '150',
      '10', '250', '20', '150',
      '10', '250', '20', '250',
      '10', '150', '20', '250',
      // 孔2：普通图层 0 圆形孔（靠几何奇偶包含深度=1自动归属为内孔）
      '0', 'CIRCLE', '8', '0', '10', '450', '20', '350', '40', '40'
    ]);

    const res = parseDxfText(dxf);
    expect(res.groups[0].demands).toHaveLength(1);
    const shape = res.groups[0].demands[0].shape;
    expect(shape.width).toBe(500);
    expect(shape.height).toBe(400);
    expect(signedArea2(shape.vertices)).toBeGreaterThan(0); // 外环 CCW
    expect(shape.holes).toHaveLength(2);
    for (const hole of shape.holes!) {
      expect(signedArea2(hole)).toBeLessThan(0); // 内孔 CW
      expect(hole.length).toBeGreaterThanOrEqual(3);
      expect(hole.length).toBeLessThanOrEqual(128);
    }

    const norm = normalizePolygonShape01(shape);
    expect(norm.holes).toHaveLength(2);
  });

  it('正确映射 rotationMode (FIXED / HALF_TURN_180 / ROTATE_90)', () => {
    const dxf = dxfDoc([
      '0', 'LWPOLYLINE', '8', '0', '70', '1',
      '10', '0', '20', '0', '10', '200', '20', '0', '10', '200', '20', '100', '10', '0', '20', '100'
    ]);
    const fixed = parseDxfText(dxf, { rotationMode: 'FIXED' }).groups[0].demands[0];
    expect(fixed.allowRotation).toBe(false);
    expect(fixed.allowHalfTurn).toBeUndefined();

    const half = parseDxfText(dxf, { rotationMode: 'HALF_TURN_180' }).groups[0].demands[0];
    expect(half.allowRotation).toBe(false);
    expect(half.allowHalfTurn).toBe(true);

    const rot90 = parseDxfText(dxf, { rotationMode: 'ROTATE_90' }).groups[0].demands[0];
    expect(rot90.allowRotation).toBe(true);
  });

  it('对真实 AAMA 纸样 1226 / 20148D / 3129 不触发 BLOCK+INSERT 双重生成且兼容 normalizePolygonShape01', () => {
    const maxExpectedQty = { '1226.dxf': 84, '20148D.dxf': 48, '3129.dxf': 252 };
    for (const file of ['1226.dxf', '20148D.dxf', '3129.dxf']) {
      const buf = readFileSync(
        fileURLToPath(new URL(`../../../../../src/test/resources/fixtures/dxf/${file}`, import.meta.url))
      );
      const parsed = parseDxfGarmentText(buf, file);
      expect(parsed.groups.length).toBeGreaterThanOrEqual(6);
      expect(parsed.groups.some(g => g.materialModel === `DXF-${file.replace(/\.dxf$/i, '')}`)).toBe(false);
      const totalCount = parsed.groups.flatMap(g => g.demands).reduce((s, d) => s + d.quantity, 0);
      expect(totalCount).toBeLessThanOrEqual(maxExpectedQty[file]);
      for (const d of parsed.groups.flatMap(g => g.demands)) {
        const norm = normalizePolygonShape01(d.shape);
        expect(norm.type).toBe('POLYGON');
        expect(norm.vertices.length).toBeGreaterThanOrEqual(3);
        expect(norm.vertices.length).toBeLessThanOrEqual(128);
      }
    }
  });

  it('在 $INSUNITS=6 (米) 下保持毫米级闭合与弦高容差，不静默闭合 5mm 缺口', () => {
    // 0.5m x 0.5m 米制多段线存在 0.005m (5mm) 开口缺口，endpointToleranceMm=0.5 不得隐式闭合
    const openGap5mmDxf = dxfDoc(
      [
        '0', 'LWPOLYLINE', '8', '0', '70', '0',
        '10', '0', '20', '0',
        '10', '0.5', '20', '0',
        '10', '0.5', '20', '0.5',
        '10', '0', '20', '0.5',
        '10', '0', '20', '0.005'
      ],
      ['9', '$INSUNITS', '70', '6']
    );
    expect(() => parseDxfText(openGap5mmDxf, { endpointToleranceMm: 0.5 })).toThrow(/未闭合|未能/);

    // 同一米制图纸下 0.0002m (0.2mm) 缺口应正常闭合；半径 0.5m (500mm) 圆弧应保持高精度采样
    const closedMeterCircleAndPoly = dxfDoc(
      [
        '0', 'LWPOLYLINE', '8', '0', '70', '0',
        '10', '0', '20', '0',
        '10', '0.5', '20', '0',
        '10', '0.5', '20', '0.5',
        '10', '0', '20', '0.5',
        '10', '0', '20', '0.0002',
        '0', 'CIRCLE', '8', '0', '10', '2', '20', '2', '40', '0.5'
      ],
      ['9', '$INSUNITS', '70', '6']
    );
    const res = parseDxfText(closedMeterCircleAndPoly, { endpointToleranceMm: 0.5, chordToleranceMm: 0.5 });
    expect(res.groups[0].demands).toHaveLength(2);
    const circle = res.groups[0].demands.find(d => Math.abs(d.width - 1000) < 2);
    expect(circle).toBeDefined();
    expect(circle!.shape.vertices.length).toBeGreaterThan(20);
  });

  it('容错 DXF 前导空行与段间空行，且不破坏含合法空字符串组值的实体', () => {
    const raw = [
      '',
      '',
      '0', 'SECTION',
      '2', 'HEADER',
      '0', 'ENDSEC',
      '',
      '0', 'SECTION',
      '2', 'ENTITIES',
      '0', 'TEXT', '8', 'TEXT', '1', '',
      '0', 'LWPOLYLINE', '8', '0', '70', '1',
      '10', '0', '20', '0',
      '10', '200', '20', '0',
      '10', '200', '20', '100',
      '10', '0', '20', '100',
      '0', 'ENDSEC',
      '0', 'EOF',
      ''
    ].join('\n');
    const res = parseDxfText(raw);
    expect(res.groups[0].demands).toHaveLength(1);
    expect(res.groups[0].demands[0]).toMatchObject({ width: 200, length: 100 });
  });

  it('拒绝仅重心在内但顶点或线段穿刺凹 U 形外环的非法内孔', () => {
    const uOuterWithPiercingHole = dxfDoc([
      // 凹 U 形外环: 左臂 [0,80]x[0,200], 底部 [0,200]x[0,60], 右臂 [120,200]x[0,200]
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0',
      '10', '200', '20', '0',
      '10', '200', '20', '200',
      '10', '120', '20', '200',
      '10', '120', '20', '60',
      '10', '80', '20', '60',
      '10', '80', '20', '200',
      '10', '0', '20', '200',
      // 非法孔: 在底部的矩形/三角形，重心位于 (50, 35) 实心区，但顶点 (100, 120) 刺穿凹槽边界
      '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
      '10', '20', '20', '20',
      '10', '60', '20', '20',
      '10', '100', '20', '120',
      '10', '20', '20', '40'
    ]);
    const res = parseDxfText(uOuterWithPiercingHole);
    expect(res.groups[0].demands).toHaveLength(1);
    expect(res.groups[0].demands[0].shape.holes ?? []).toHaveLength(0);
    expect(res.warnings.some(w => w.includes('穿刺') || w.includes('越界') || w.includes('内孔'))).toBe(true);
  });
});
