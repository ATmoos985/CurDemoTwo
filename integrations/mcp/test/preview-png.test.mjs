import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodeRgbPng, renderCuttingPreviewPng } from '../src/preview-png.mjs';

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 解析并校验 PNG 签名、IHDR 尺寸、块结构及 IDAT 可正确解压出完整 RGB 像素缓冲。 */
function parseAndDecodePng(buffer) {
  assert.ok(Buffer.isBuffer(buffer), '输出必须为 Buffer');
  assert.ok(buffer.length > 33, 'PNG 体积过小');
  assert.deepEqual(buffer.subarray(0, 8), PNG_MAGIC, 'PNG 魔数不匹配');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  const idatParts = [];
  let sawIend = false;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }

  assert.equal(sawIend, true, '缺少 IEND 结束块');
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 2);
  const raw = inflateSync(Buffer.concat(idatParts));
  assert.equal(raw.length, height * (width * 3 + 1), '解压后的像素字节长度与尺寸不符');
  return { width, height, raw };
}

function getPixel(decoded, x, y) {
  const rowStart = y * (decoded.width * 3 + 1);
  const idx = rowStart + 1 + x * 3;
  return [decoded.raw[idx], decoded.raw[idx + 1], decoded.raw[idx + 2]];
}

test('encodeRgbPng 生成合法标准 PNG 魔数、IHDR 尺寸与可解压 RGB 像素', () => {
  const rgb = new Uint8Array(4 * 3 * 3);
  rgb[0] = 30;
  rgb[1] = 58;
  rgb[2] = 138;
  const png = encodeRgbPng(4, 3, rgb);
  const decoded = parseAndDecodePng(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.deepEqual(getPixel(decoded, 0, 0), [30, 58, 138]);
});

test('renderCuttingPreviewPng 渲染 2D 矩形排料、疵点与计划料头并保持尺寸与摘要一致', () => {
  const rendered = renderCuttingPreviewPng({
    widthPx: 640,
    heightPx: 360,
    result: {
      id: 'res-2d-rect',
      fulfillmentStatus: 'COMPLETE',
      validationStatus: 'PASSED',
      metrics: [{ name: 'utilization', value: 86.5, unit: '%' }],
      layout: {
        materialId: 'ROLL-101',
        processingRegion: { type: 'RECTANGLE', width: 2000, height: 3000 },
        placements: [
          { id: 1, demandId: 1, name: '前片', x: 0, y: 0, shape: { type: 'RECTANGLE', width: 1000, height: 1200 }, rotationDegrees: 0 },
          { id: 2, demandId: 2, name: '后片', x: 1000, y: 0, shape: { type: 'RECTANGLE', width: 1000, height: 1200 }, rotationDegrees: 0 }
        ],
        leftovers: [
          { id: 'L-1', x: 0, y: 1200, shape: { type: 'RECTANGLE', width: 2000, height: 1800 }, hasDefect: false }
        ],
        metrics: {
          processingAreaMm2: 6_000_000,
          pieceAreaMm2: 2_400_000,
          reusableAreaMm2: 3_600_000,
          unassignedAreaMm2: 0,
          suggestedFeedLengthMm: 1200
        }
      }
    },
    input: {
      problem: {
        material: {
          id: 'ROLL-101',
          shape: { type: 'RECTANGLE', width: 2000, height: 3000 },
          exclusions: [{ id: 1, x: 200, y: 1500, shape: { type: 'RECTANGLE', width: 120, height: 80 } }]
        }
      }
    }
  });

  assert.equal(rendered.mode, 'NESTING_2D');
  assert.equal(rendered.widthPx, 640);
  assert.equal(rendered.heightPx, 360);
  assert.equal(rendered.summary.placementCount, 2);
  assert.equal(rendered.summary.leftoverCount, 1);
  assert.equal(rendered.summary.defectCount, 1);
  assert.equal(rendered.summary.occupiedLengthMm, 1200);
  assert.equal(rendered.summary.utilizationPct, 86.5);

  const decoded = parseAndDecodePng(rendered.buffer);
  assert.equal(decoded.width, 640);
  assert.equal(decoded.height, 360);
  // 顶部标题栏应为深石板蓝 [30, 41, 59]
  assert.deepEqual(getPixel(decoded, 2, 2), [30, 41, 59]);
});

test('renderCuttingPreviewPng 渲染 2D 异形多边形及内孔镂空扫描线填充', () => {
  // 正方形 2000x2000，外轮廓覆满 [100..1900]x[100..1900]，正中开一个大内孔 [600..1400]x[600..1400]
  const rendered = renderCuttingPreviewPng({
    widthPx: 480,
    heightPx: 480,
    result: {
      id: 'res-2d-poly-hole',
      fulfillmentStatus: 'COMPLETE',
      validationStatus: 'PASSED',
      metrics: [],
      layout: {
        materialId: 'FREE',
        processingRegion: { type: 'RECTANGLE', width: 2000, height: 2000 },
        placements: [
          {
            id: 1,
            demandId: 0,
            name: '带孔异形件',
            x: 100,
            y: 100,
            rotationDegrees: 0,
            shape: {
              type: 'POLYGON',
              width: 1800,
              height: 1800,
              vertices: [
                { x: 0, y: 0 },
                { x: 1800, y: 0 },
                { x: 1800, y: 1800 },
                { x: 0, y: 1800 }
              ],
              holes: [
                [
                  { x: 500, y: 500 },
                  { x: 1300, y: 500 },
                  { x: 1300, y: 1300 },
                  { x: 500, y: 1300 }
                ]
              ]
            }
          }
        ],
        leftovers: [],
        metrics: {
          processingAreaMm2: 4_000_000,
          pieceAreaMm2: 2_600_000,
          reusableAreaMm2: 0,
          unassignedAreaMm2: 1_400_000,
          suggestedFeedLengthMm: 1900
        }
      }
    }
  });

  assert.equal(rendered.mode, 'NESTING_2D');
  const decoded = parseAndDecodePng(rendered.buffer);
  assert.equal(decoded.width, 480);
  assert.equal(decoded.height, 480);

  // 采样内孔正中心附近（排除居中文字区域偏移一点）应保留米白底板颜色 [255, 253, 247]
  // 外壳实体区域应被蓝灰裁片颜色填充（非米白）
  let sawBaseInsideHole = false;
  let sawPieceBlue = false;
  for (let y = 140; y < 340; y += 4) {
    for (let x = 140; x < 340; x += 4) {
      const [r, g, b] = getPixel(decoded, x, y);
      if (r > 248 && g > 245 && b > 235) sawBaseInsideHole = true;
      if (b > r + 15 && b > 220) sawPieceBlue = true;
    }
  }
  assert.equal(sawBaseInsideHole, true, '内孔区域应镂空露出米白底板');
  assert.equal(sawPieceBlue, true, '异形实体区域应被蓝灰填充');
});

test('renderCuttingPreviewPng 渲染 1D 分切多车次条带与边丝余料并处理空结果降级', () => {
  const rendered1D = renderCuttingPreviewPng({
    widthPx: 800,
    heightPx: 420,
    input: {
      problem: {
        motherWidthMm: 2200,
        leftTrimMm: 20,
        rightTrimMm: 20
      }
    },
    result: {
      id: 'res-1d',
      fulfillmentStatus: 'COMPLETE',
      validationStatus: 'PASSED',
      metrics: [{ name: 'utilization', value: 94.5, unit: '%' }],
      slitting: {
        motherAreaMm2: 22_000_000,
        pieceAreaMm2: 20_790_000,
        estimatedKnifeChanges: 3,
        patterns: [
          {
            id: 'P1',
            motherWidthMm: 2200,
            rollWidthMm: 2160,
            patternWidthMm: 2100,
            lengthMm: 5000,
            repetitions: 2,
            stations: [
              { widthMm: 600, countPerRepetition: 2 },
              { widthMm: 450, countPerRepetition: 2 }
            ]
          },
          {
            id: 'P2',
            motherWidthMm: 2200,
            rollWidthMm: 2160,
            patternWidthMm: 2000,
            lengthMm: 5000,
            repetitions: 1,
            stations: [{ widthMm: 500, countPerRepetition: 4 }]
          }
        ]
      }
    }
  });

  assert.equal(rendered1D.mode, 'SLITTING_1D');
  assert.equal(rendered1D.summary.patternCount, 2);
  assert.equal(rendered1D.summary.materialWidthMm, 2200);
  const decoded1D = parseAndDecodePng(rendered1D.buffer);
  assert.equal(decoded1D.width, 800);
  assert.equal(decoded1D.height, 420);

  // 空结果不崩溃，返回合法降级提示图
  const renderedEmpty = renderCuttingPreviewPng({ result: { id: 'res-empty' }, widthPx: 320, heightPx: 200 });
  assert.equal(renderedEmpty.mode, 'EMPTY');
  const decodedEmpty = parseAndDecodePng(renderedEmpty.buffer);
  assert.equal(decodedEmpty.width, 320);
  assert.equal(decodedEmpty.height, 200);
});
