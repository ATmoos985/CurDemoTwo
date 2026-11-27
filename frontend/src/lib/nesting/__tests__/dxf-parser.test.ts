import { describe, it, expect } from 'vitest';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { readFileSync } from 'node:fs';
// @ts-ignore — frontend/tsconfig.json 未包含 @types/node
import { fileURLToPath } from 'node:url';
import { parseDxfText } from '../dxf-parser.js';
import {
  signedArea2,
  buildContourShapesWithHoles,
  matchesLayerKeywords,
  classifyLayerRole,
  DEFAULT_HOLE_LAYER_KEYWORDS,
  DEFAULT_OUTER_LAYER_KEYWORDS
} from '../dxf-geometry.js';
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

  it('拦截 BBox 越界穿刺 HOLE 与凹多边形跨凹口且质心在外部的穿刺 HOLE，绝不升格为独立裁片', () => {
    // 探针 1A：外轮廓 [0,0]~[200,100]，HOLE [150,20]~[220,80] 穿刺右边界越出 BBox
    const bboxOverflowBuilt = buildContourShapesWithHoles([
      {
        layer: 'OUTER',
        vertices: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 100 },
          { x: 0, y: 100 }
        ]
      },
      {
        layer: 'HOLE',
        vertices: [
          { x: 150, y: 20 },
          { x: 220, y: 20 },
          { x: 220, y: 80 },
          { x: 150, y: 80 }
        ]
      }
    ]);
    expect(bboxOverflowBuilt.shapes).toHaveLength(1);
    expect(bboxOverflowBuilt.shapes[0].shape.holes ?? []).toHaveLength(0);
    expect(bboxOverflowBuilt.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);

    const bboxOverflowDxf = parseDxfText(
      dxfDoc([
        '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
        '10', '0', '20', '0',
        '10', '200', '20', '0',
        '10', '200', '20', '100',
        '10', '0', '20', '100',
        '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
        '10', '150', '20', '20',
        '10', '220', '20', '20',
        '10', '220', '20', '80',
        '10', '150', '20', '80'
      ])
    );
    expect(bboxOverflowDxf.groups[0].demands).toHaveLength(1);
    expect(bboxOverflowDxf.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);

    // 探针 1B：L 形凹多边形外轮廓内 BBox 范围，HOLE [90,60]~[180,180] 穿刺凹口且质心 (135,120) 位于凹口外部
    const concaveBuilt = buildContourShapesWithHoles([
      {
        layer: 'OUTER',
        vertices: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 100 },
          { x: 100, y: 100 },
          { x: 100, y: 200 },
          { x: 0, y: 200 }
        ]
      },
      {
        layer: 'HOLE',
        vertices: [
          { x: 90, y: 60 },
          { x: 180, y: 60 },
          { x: 180, y: 180 },
          { x: 90, y: 180 }
        ]
      }
    ]);
    expect(concaveBuilt.shapes).toHaveLength(1);
    expect(concaveBuilt.shapes[0].shape.holes ?? []).toHaveLength(0);
    expect(concaveBuilt.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);
  });

  it('图层关键词词边界与精确数字匹配：消除 CUTOUT/CUT、11/1、HOLE_1/1 冲突', () => {
    expect(matchesLayerKeywords('11', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('14', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('HOLE_1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('DRILL_1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('内孔1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('CUTOUT', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('CUTOUT_1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);
    expect(matchesLayerKeywords('CUTOUT1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(false);

    expect(matchesLayerKeywords('1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('CUT', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('CUT_1', DEFAULT_OUTER_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('11', DEFAULT_HOLE_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('CUTOUT', DEFAULT_HOLE_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('CUTOUT_1', DEFAULT_HOLE_LAYER_KEYWORDS)).toBe(true);
    expect(matchesLayerKeywords('HOLE_1', DEFAULT_HOLE_LAYER_KEYWORDS)).toBe(true);

    // 显式优先级仲裁：通用弱外框词不压过具体内孔词，纯正外框词保持外轮廓语义
    expect(classifyLayerRole('CUTOUT')).toEqual({ isHoleLayer: true, isOuterLayer: false });
    expect(classifyLayerRole('11')).toEqual({ isHoleLayer: true, isOuterLayer: false });
    expect(classifyLayerRole('HOLE_1')).toEqual({ isHoleLayer: true, isOuterLayer: false });
    expect(classifyLayerRole('INNER_CUT')).toEqual({ isHoleLayer: true, isOuterLayer: false });
    expect(classifyLayerRole('内孔裁切')).toEqual({ isHoleLayer: true, isOuterLayer: false });
    expect(classifyLayerRole('OUTER')).toEqual({ isHoleLayer: false, isOuterLayer: true });
    expect(classifyLayerRole('1')).toEqual({ isHoleLayer: false, isOuterLayer: true });
  });

  it('对抗回归 1：通用 DXF OUTER + CUTOUT 合法内孔归属为 holes，不升格为独立裁片', () => {
    const dxf = dxfDoc([
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0',
      '10', '300', '20', '0',
      '10', '300', '20', '200',
      '10', '0', '20', '200',
      '0', 'LWPOLYLINE', '8', 'CUTOUT', '70', '1',
      '10', '40', '20', '40',
      '10', '120', '20', '40',
      '10', '120', '20', '120',
      '10', '40', '20', '120'
    ]);
    const res = parseDxfText(dxf);
    expect(res.groups[0].demands).toHaveLength(1);
    const shape = res.groups[0].demands[0].shape;
    expect(shape.width).toBe(300);
    expect(shape.length ?? shape.height).toBe(200);
    expect(shape.holes).toHaveLength(1);
    expect(signedArea2(shape.holes![0])).toBeLessThan(0);
  });

  it('对抗回归 2：通用 DXF OUTER + CUTOUT 与 OUTER + HOLE_1 越界穿刺均被穿刺拦截跳过', () => {
    for (const holeLayer of ['CUTOUT', 'CUTOUT_1', 'HOLE_1']) {
      const piercingDxf = dxfDoc([
        '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
        '10', '0', '20', '0',
        '10', '200', '20', '0',
        '10', '200', '20', '100',
        '10', '0', '20', '100',
        '0', 'LWPOLYLINE', '8', holeLayer, '70', '1',
        '10', '150', '20', '20',
        '10', '220', '20', '20',
        '10', '220', '20', '80',
        '10', '150', '20', '80'
      ]);
      const res = parseDxfText(piercingDxf);
      expect(res.groups[0].demands).toHaveLength(1);
      expect(res.groups[0].demands[0].shape.holes ?? []).toHaveLength(0);
      expect(res.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);
    }
  });

  it('对抗回归 3：通用 DXF 图层 1 (外框) + 图层 11 (内孔) 合法套孔保留 1 孔且越界拦截', () => {
    const legitDxf = dxfDoc([
      '0', 'LWPOLYLINE', '8', '1', '70', '1',
      '10', '0', '20', '0',
      '10', '300', '20', '0',
      '10', '300', '20', '200',
      '10', '0', '20', '200',
      '0', 'LWPOLYLINE', '8', '11', '70', '1',
      '10', '40', '20', '40',
      '10', '120', '20', '40',
      '10', '120', '20', '120',
      '10', '40', '20', '120'
    ]);
    const legitRes = parseDxfText(legitDxf);
    expect(legitRes.groups[0].demands).toHaveLength(1);
    expect(legitRes.groups[0].demands[0].shape.holes).toHaveLength(1);
    expect(signedArea2(legitRes.groups[0].demands[0].shape.holes![0])).toBeLessThan(0);

    const pierceDxf = dxfDoc([
      '0', 'LWPOLYLINE', '8', '1', '70', '1',
      '10', '0', '20', '0',
      '10', '200', '20', '0',
      '10', '200', '20', '100',
      '10', '0', '20', '100',
      '0', 'LWPOLYLINE', '8', '11', '70', '1',
      '10', '150', '20', '20',
      '10', '220', '20', '20',
      '10', '220', '20', '80',
      '10', '150', '20', '80'
    ]);
    const pierceRes = parseDxfText(pierceDxf);
    expect(pierceRes.groups[0].demands).toHaveLength(1);
    expect(pierceRes.groups[0].demands[0].shape.holes ?? []).toHaveLength(0);
    expect(pierceRes.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);
  });

  it('对抗回归 4：AAMA BLOCK Layer 1 (外框) + Layer 11 (内孔) 正确解析出 holes=1，绝不静默丢孔', () => {
    const buildAamaDxf = (quantity: string) => [
      '0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'FrontPanel', '10', '0', '20', '0',
      '0', 'TEXT', '8', '0', '1', 'Piece Name: FrontPanel',
      '0', 'TEXT', '8', '0', '1', 'Fabric: 面布',
      '0', 'TEXT', '8', '0', '1', 'Size: M',
      '0', 'TEXT', '8', '0', '1', `Quantity: ${quantity}`,
      // Layer 1 外框 400x300
      '0', 'LWPOLYLINE', '8', '1', '70', '1',
      '10', '0', '20', '0',
      '10', '400', '20', '0',
      '10', '400', '20', '300',
      '10', '0', '20', '300',
      // Layer 11 内孔 80x80
      '0', 'LWPOLYLINE', '8', '11', '70', '1',
      '10', '60', '20', '60',
      '10', '140', '20', '60',
      '10', '140', '20', '140',
      '10', '60', '20', '140',
      // Layer 14 缝份与 Layer 8 内部线应被 AAMA 屏蔽
      '0', 'LWPOLYLINE', '8', '14', '70', '1',
      '10', '-10', '20', '-10',
      '10', '410', '20', '-10',
      '10', '410', '20', '310',
      '10', '-10', '20', '310',
      '0', 'LINE', '8', '8', '10', '200', '20', '0', '11', '200', '21', '300',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', '1', '2', 'FrontPanel', '10', '0', '20', '0',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');

    const singleRes = parseDxfText(buildAamaDxf('1'));
    expect(singleRes.groups).toHaveLength(1);
    expect(singleRes.groups[0].demands).toHaveLength(1);
    const singleDemand = singleRes.groups[0].demands[0];
    expect(singleDemand.width).toBe(400);
    expect(singleDemand.length).toBe(300);
    expect(singleDemand.shape.holes).toHaveLength(1);
    expect(signedArea2(singleDemand.shape.holes![0])).toBeLessThan(0);
    expect(singleDemand.note).toContain('1孔');

    const pairRes = parseDxfText(buildAamaDxf('1,1'));
    expect(pairRes.groups[0].demands).toHaveLength(2);
    for (const d of pairRes.groups[0].demands) {
      expect(d.shape.holes).toHaveLength(1);
      expect(signedArea2(d.shape.holes![0])).toBeLessThan(0);
      expect(d.note).toContain('1孔');
    }
  });

  it('对抗回归 4a：岛中岛场景下穿刺内层岛屿边界的孔被拦截，绝不逃逸挂接到祖先外框', () => {
    const islandPierceDxf = dxfDoc([
      // 外框 A [0,0]~[500,500]
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0',
      '10', '500', '20', '0',
      '10', '500', '20', '500',
      '10', '0', '20', '500',
      // 外层内孔 H1 [50,50]~[450,450]
      '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
      '10', '50', '20', '50',
      '10', '450', '20', '50',
      '10', '450', '20', '450',
      '10', '50', '20', '450',
      // 岛屿 B [100,100]~[300,300]
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '100', '20', '100',
      '10', '300', '20', '100',
      '10', '300', '20', '300',
      '10', '100', '20', '300',
      // 穿刺岛屿 B 右边界 x=300 的孔 H2 [250,150]~[350,250]
      '0', 'LWPOLYLINE', '8', 'HOLE_1', '70', '1',
      '10', '250', '20', '150',
      '10', '350', '20', '150',
      '10', '350', '20', '250',
      '10', '250', '20', '250'
    ]);

    const res = parseDxfText(islandPierceDxf);
    expect(res.groups[0].demands).toHaveLength(2);
    const outerA = res.groups[0].demands.find(d => Math.abs(d.width - 500) < 0.1)!;
    const islandB = res.groups[0].demands.find(d => Math.abs(d.width - 200) < 0.1)!;
    expect(outerA).toBeDefined();
    expect(islandB).toBeDefined();
    expect(outerA.shape.holes).toHaveLength(1);
    expect(islandB.shape.holes ?? []).toHaveLength(0);
    expect(res.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(true);
  });

  it('对抗回归 4b：岛中岛场景下严格位于岛屿内部的安全内孔正常归属岛屿，不误杀', () => {
    const islandSafeHoleDxf = dxfDoc([
      // 外框 A [0,0]~[500,500]
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0',
      '10', '500', '20', '0',
      '10', '500', '20', '500',
      '10', '0', '20', '500',
      // 外层内孔 H1 [50,50]~[450,450]
      '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
      '10', '50', '20', '50',
      '10', '450', '20', '50',
      '10', '450', '20', '450',
      '10', '50', '20', '450',
      // 岛屿 B [100,100]~[300,300]
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '100', '20', '100',
      '10', '300', '20', '100',
      '10', '300', '20', '300',
      '10', '100', '20', '300',
      // 严格位于岛屿 B 内部的安全内孔 H2 [150,150]~[250,250]
      '0', 'LWPOLYLINE', '8', 'HOLE_1', '70', '1',
      '10', '150', '20', '150',
      '10', '250', '20', '150',
      '10', '250', '20', '250',
      '10', '150', '20', '250'
    ]);

    const res = parseDxfText(islandSafeHoleDxf);
    expect(res.groups[0].demands).toHaveLength(2);
    const outerA = res.groups[0].demands.find(d => Math.abs(d.width - 500) < 0.1)!;
    const islandB = res.groups[0].demands.find(d => Math.abs(d.width - 200) < 0.1)!;
    expect(outerA.shape.holes).toHaveLength(1);
    expect(signedArea2(outerA.shape.holes![0])).toBeLessThan(0);
    expect(islandB.shape.holes).toHaveLength(1);
    expect(signedArea2(islandB.shape.holes![0])).toBeLessThan(0);
    expect(res.warnings.some(w => w.includes('穿刺') || w.includes('越出'))).toBe(false);
  });
});
