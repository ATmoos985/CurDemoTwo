import { deflateSync } from 'node:zlib';

/**
 * 零第三方依赖工业风排料图 PNG 渲染器：
 * - 仅使用 Node.js 内置 node:zlib 与纯 JS 像素缓冲，零原生/三方依赖；
 * - 支持 2D 矩形排料、2D 异形多边形 + 内孔扫描线镂空、红色半透明疵点禁区、绿色虚线计划料头、坐标轴刻度与占用长度线；
 * - 支持 1D 分切横向条带车次、修边与余料边丝分布可视化。
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IEEE 802.3 CRC32 查找表
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let crc = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32([typeBuf, data]), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * 将 RGB 像素缓冲区（width * height * 3）编码为合法 PNG Buffer（colorType=2, bitDepth=8）。
 */
export function encodeRgbPng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: Truecolour (RGB)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOut = y * (stride + 1);
    raw[rowOut] = 0; // filter type 0 (None)
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), rowOut + 1);
  }
  const compressed = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// 极简 5x7 ASCII 位图字体（用于刻度尺、页眉指标与条带尺寸标注，不依赖系统字体）
const FONT_5X7 = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '|': ['00100', '00100', '00100', '00100', '00100', '00100', '00100'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111']
};

// 工业高对比蓝灰分色板（克制专业，便于区分不同需求规格）
const PIECE_PALETTE = [
  { fill: [219, 234, 254, 245], stroke: [30, 58, 138, 255] }, // 工业冰蓝
  { fill: [224, 242, 254, 245], stroke: [3, 105, 161, 255] }, // 钢青浅蓝
  { fill: [226, 232, 240, 245], stroke: [51, 65, 85, 255] },  // 冷灰铁板
  { fill: [199, 210, 254, 245], stroke: [55, 48, 163, 255] }, // 靛蓝灰
  { fill: [191, 219, 254, 245], stroke: [29, 78, 216, 255] }, // 深海蓝
  { fill: [203, 213, 225, 245], stroke: [30, 41, 59, 255] },  // 石板蓝灰
  { fill: [186, 230, 253, 245], stroke: [12, 74, 110, 255] }, // 工业天青
  { fill: [209, 213, 219, 245], stroke: [55, 65, 81, 255] }   // 金属银灰
];

const SLIT_PALETTE = [
  [59, 130, 246, 235],
  [14, 165, 233, 235],
  [100, 116, 139, 235],
  [37, 99, 235, 235],
  [2, 132, 199, 235],
  [71, 85, 105, 235],
  [79, 70, 229, 235],
  [30, 64, 175, 235]
];

class RasterCanvas {
  constructor(width, height, bgColor = [244, 245, 247]) {
    this.width = width;
    this.height = height;
    this.rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < this.rgb.length; i += 3) {
      this.rgb[i] = bgColor[0];
      this.rgb[i + 1] = bgColor[1];
      this.rgb[i + 2] = bgColor[2];
    }
  }

  blendPixel(x, y, color) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) return;
    const idx = (iy * this.width + ix) * 3;
    const a = (color[3] ?? 255) / 255;
    if (a <= 0) return;
    if (a >= 1) {
      this.rgb[idx] = color[0];
      this.rgb[idx + 1] = color[1];
      this.rgb[idx + 2] = color[2];
      return;
    }
    const inv = 1 - a;
    this.rgb[idx] = Math.round(color[0] * a + this.rgb[idx] * inv);
    this.rgb[idx + 1] = Math.round(color[1] * a + this.rgb[idx + 1] * inv);
    this.rgb[idx + 2] = Math.round(color[2] * a + this.rgb[idx + 2] * inv);
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    const a = (color[3] ?? 255) / 255;
    if (a <= 0) return;
    const inv = 1 - a;
    for (let py = y0; py < y1; py++) {
      let idx = (py * this.width + x0) * 3;
      for (let px = x0; px < x1; px++) {
        if (a >= 1) {
          this.rgb[idx] = color[0];
          this.rgb[idx + 1] = color[1];
          this.rgb[idx + 2] = color[2];
        } else {
          this.rgb[idx] = Math.round(color[0] * a + this.rgb[idx] * inv);
          this.rgb[idx + 1] = Math.round(color[1] * a + this.rgb[idx + 1] * inv);
          this.rgb[idx + 2] = Math.round(color[2] * a + this.rgb[idx + 2] * inv);
        }
        idx += 3;
      }
    }
  }

  drawLine(x0, y0, x1, y1, color, thickness = 1, dashOn = 0, dashOff = 0) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) {
      this.blendPixel(x0, y0, color);
      return;
    }
    const steps = Math.max(1, Math.ceil(dist));
    const period = dashOn > 0 && dashOff > 0 ? dashOn + dashOff : 0;
    const r = Math.max(0, Math.floor((thickness - 1) / 2));
    for (let i = 0; i <= steps; i++) {
      if (period > 0) {
        const pos = ((i / steps) * dist) % period;
        if (pos >= dashOn) continue;
      }
      const px = Math.round(x0 + (dx * i) / steps);
      const py = Math.round(y0 + (dy * i) / steps);
      if (r === 0) {
        this.blendPixel(px, py, color);
      } else {
        for (let oy = -r; oy <= r; oy++) {
          for (let ox = -r; ox <= r; ox++) {
            this.blendPixel(px + ox, py + oy, color);
          }
        }
      }
    }
  }

  strokeRect(x, y, w, h, color, thickness = 1, dashOn = 0, dashOff = 0) {
    const x2 = x + w;
    const y2 = y + h;
    this.drawLine(x, y, x2, y, color, thickness, dashOn, dashOff);
    this.drawLine(x2, y, x2, y2, color, thickness, dashOn, dashOff);
    this.drawLine(x2, y2, x, y2, color, thickness, dashOn, dashOff);
    this.drawLine(x, y2, x, y, color, thickness, dashOn, dashOff);
  }

  /**
   * 扫描线奇偶规则多边形填充（天然支持任意凹多边形与多个内孔镂空）。
   */
  fillPolygonWithHoles(rings, color) {
    const validRings = rings.filter((ring) => Array.isArray(ring) && ring.length >= 3);
    if (validRings.length === 0) return;
    let minY = Infinity;
    let maxY = -Infinity;
    const edges = [];
    for (const ring of validRings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (Math.abs(a.y - b.y) < 1e-6) continue;
        const yMin = Math.min(a.y, b.y);
        const yMax = Math.max(a.y, b.y);
        if (yMin < minY) minY = yMin;
        if (yMax > maxY) maxY = yMax;
        edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, yMin, yMax });
      }
    }
    if (edges.length === 0) return;

    const startY = Math.max(0, Math.floor(minY));
    const endY = Math.min(this.height - 1, Math.ceil(maxY));
    const a = (color[3] ?? 255) / 255;
    const inv = 1 - a;

    for (let py = startY; py <= endY; py++) {
      const sy = py + 0.5;
      const xs = [];
      for (const e of edges) {
        if (sy >= e.yMin && sy < e.yMax) {
          const t = (sy - e.y1) / (e.y2 - e.y1);
          xs.push(e.x1 + t * (e.x2 - e.x1));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((u, v) => u - v);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xStart = Math.max(0, Math.ceil(xs[i] - 0.5));
        const xEnd = Math.min(this.width - 1, Math.floor(xs[i + 1] - 0.5));
        for (let px = xStart; px <= xEnd; px++) {
          const idx = (py * this.width + px) * 3;
          if (a >= 1) {
            this.rgb[idx] = color[0];
            this.rgb[idx + 1] = color[1];
            this.rgb[idx + 2] = color[2];
          } else {
            this.rgb[idx] = Math.round(color[0] * a + this.rgb[idx] * inv);
            this.rgb[idx + 1] = Math.round(color[1] * a + this.rgb[idx + 1] * inv);
            this.rgb[idx + 2] = Math.round(color[2] * a + this.rgb[idx + 2] * inv);
          }
        }
      }
    }
  }

  strokeRing(ring, color, thickness = 1, dashOn = 0, dashOff = 0) {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      this.drawLine(a.x, a.y, b.x, b.y, color, thickness, dashOn, dashOff);
    }
  }

  drawText(x, y, text, color, scale = 1) {
    const str = String(text ?? '').toUpperCase();
    let cx = Math.round(x);
    const cy = Math.round(y);
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const glyph = FONT_5X7[ch] || FONT_5X7[' '];
      for (let row = 0; row < 7; row++) {
        const line = glyph[row];
        for (let col = 0; col < 5; col++) {
          if (line[col] === '1') {
            if (scale === 1) {
              this.blendPixel(cx + col, cy + row, color);
            } else {
              this.fillRect(cx + col * scale, cy + row * scale, scale, scale, color);
            }
          }
        }
      }
      cx += 6 * scale;
    }
  }

  measureText(text, scale = 1) {
    return String(text ?? '').length * 6 * scale;
  }

  toPngBuffer() {
    return encodeRgbPng(this.width, this.height, this.rgb);
  }
}

function niceStep(range, targetTicks = 5) {
  if (!Number.isFinite(range) || range <= 0) return 100;
  const rough = range / Math.max(2, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  if (norm <= 1.5) return mag;
  if (norm <= 3) return 2 * mag;
  if (norm <= 7) return 5 * mag;
  return 10 * mag;
}

function paletteIndex(key) {
  if (Number.isInteger(key) && key >= 0) return key % PIECE_PALETTE.length;
  const str = String(key ?? '0');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % PIECE_PALETTE.length;
}

function extractMetricPct(result, names = ['utilization', 'materialUtilization', 'netUtilization']) {
  const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
  for (const m of metrics) {
    if (m && names.some((n) => String(m.name || '').toLowerCase().includes(n.toLowerCase()))) {
      const val = Number(m.value);
      if (Number.isFinite(val)) return Number(val.toFixed(2));
    }
  }
  return null;
}

function shapeToLocalRings(shape) {
  if (!shape || typeof shape !== 'object') return { outer: [], holes: [] };
  const w = Number(shape.width ?? 0);
  const h = Number(shape.height ?? 0);
  const outer =
    shape.type === 'POLYGON' && Array.isArray(shape.vertices) && shape.vertices.length >= 3
      ? shape.vertices.map((p) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0) }))
      : w > 0 && h > 0
      ? [
          { x: 0, y: 0 },
          { x: w, y: 0 },
          { x: w, y: h },
          { x: 0, y: h }
        ]
      : [];
  const holes = Array.isArray(shape.holes)
    ? shape.holes
        .filter((ring) => Array.isArray(ring) && ring.length >= 3)
        .map((ring) => ring.map((p) => ({ x: Number(p.x ?? 0), y: Number(p.y ?? 0) })))
    : [];
  return { outer, holes };
}

function render2D(canvas, { result, input, source, taskSummary }) {
  const layout = result?.layout || {};
  const region = layout.processingRegion || input?.problem?.material?.shape || {};
  const placements = Array.isArray(layout.placements) ? layout.placements : [];
  const leftovers = Array.isArray(layout.leftovers) ? layout.leftovers : [];
  const exclusions = Array.isArray(input?.problem?.material?.exclusions)
    ? input.problem.material.exclusions
    : [];

  let matW = Number(region.width ?? 0);
  let matH = Number(region.height ?? 0);

  let maxPlacedY = 0;
  for (const p of placements) {
    const py = Number(p.y ?? 0) + Number(p.shape?.height ?? 0);
    const px = Number(p.x ?? 0) + Number(p.shape?.width ?? 0);
    if (py > maxPlacedY) maxPlacedY = py;
    if (px > matW) matW = px;
    if (py > matH) matH = py;
  }
  for (const l of leftovers) {
    const px = Number(l.x ?? 0) + Number(l.shape?.width ?? 0);
    const py = Number(l.y ?? 0) + Number(l.shape?.height ?? 0);
    if (px > matW) matW = px;
    if (py > matH) matH = py;
  }
  if (matW <= 0) matW = 2000;
  if (matH <= 0) matH = 3000;

  const occupiedLengthMm = Number(
    layout.metrics?.suggestedFeedLengthMm ?? (maxPlacedY > 0 ? maxPlacedY : 0)
  );
  // 若母卷极长而实际占长仅为局部片段，聚焦展示有效区域（含少量留白和料头），让裁片细节足够清晰
  const leftoverMaxY = leftovers.reduce((m, l) => Math.max(m, Number(l.y ?? 0) + Number(l.shape?.height ?? 0)), 0);
  const defectMaxY = exclusions.reduce((m, d) => Math.max(m, Number(d.y ?? 0) + Number(d.shape?.height ?? 0)), 0);
  const contentMaxY = Math.max(occupiedLengthMm, maxPlacedY, leftoverMaxY);
  const displayH =
    matH > matW * 4 && contentMaxY > 0
      ? Math.min(matH, Math.max(contentMaxY * 1.18, defectMaxY > contentMaxY * 1.5 ? contentMaxY * 1.18 : defectMaxY * 1.05, matW * 0.8))
      : matH;

  const headerH = 34;
  const footerH = 26;
  const marginLeft = 58;
  const marginRight = 24;
  const marginTop = headerH + 22;
  const marginBottom = footerH + 26;

  // 顶部深石板蓝工业标题栏
  canvas.fillRect(0, 0, canvas.width, headerH, [30, 41, 59, 255]);
  const utilMetric = extractMetricPct(result);
  const pieceArea = Number(layout.metrics?.pieceAreaMm2 ?? 0);
  const denomArea = matW * (occupiedLengthMm > 0 ? occupiedLengthMm : matH);
  const utilPct =
    utilMetric !== null
      ? utilMetric
      : denomArea > 0 && pieceArea > 0
      ? Number(((pieceArea / denomArea) * 100).toFixed(1))
      : null;

  const titleParts = [
    `2D ${Math.round(matW)}X${Math.round(matH)}MM`,
    `USED:${Math.round(occupiedLengthMm)}MM`,
    `PCS:${placements.length}`
  ];
  if (utilPct !== null) titleParts.push(`UTIL:${utilPct}%`);
  if (result?.fulfillmentStatus) titleParts.push(String(result.fulfillmentStatus));
  canvas.drawText(12, 13, titleParts.join(' | '), [248, 250, 252, 255], 1);

  // 画布可用区（如果长大于宽且画布为横向，采用 X=卷长横向展开 还是 X=门幅？保持标准工程视角：若 displayH > matW * 1.25 且画布横向宽于高，横置卷材（横轴为卷长 Y，纵轴为门幅 X），信息密度翻倍；否则保持标准 X=门幅, Y=卷长）
  const availW = Math.max(40, canvas.width - marginLeft - marginRight);
  const availH = Math.max(40, canvas.height - marginTop - marginBottom);
  const horizontalRoll = displayH > matW * 1.25 && availW > availH * 1.2;

  const worldW = horizontalRoll ? displayH : matW;
  const worldH = horizontalRoll ? matW : displayH;
  const scale = Math.min(availW / worldW, availH / worldH);
  const drawW = worldW * scale;
  const drawH = worldH * scale;
  const ox = marginLeft + Math.floor((availW - drawW) / 2);
  const oy = marginTop + Math.floor((availH - drawH) / 2);

  const mapPt = (wx, wy) =>
    horizontalRoll
      ? { x: ox + wy * scale, y: oy + wx * scale }
      : { x: ox + wx * scale, y: oy + wy * scale };

  // 米白母卷底板
  canvas.fillRect(ox, oy, drawW, drawH, [255, 253, 247, 255]);

  // 浅灰辅助网格 + 坐标轴刻度
  const stepX = niceStep(worldW, 6);
  for (let v = 0; v <= worldW + 1e-6; v += stepX) {
    const px = ox + v * scale;
    if (px > ox + drawW + 1) break;
    canvas.drawLine(px, oy, px, oy + drawH, [226, 232, 240, 200], 1);
    canvas.drawLine(px, oy + drawH, px, oy + drawH + 4, [100, 116, 139, 255], 1);
    const label = `${Math.round(v)}`;
    const lw = canvas.measureText(label, 1);
    if (px - lw / 2 >= 2 && px + lw / 2 <= canvas.width - 2) {
      canvas.drawText(px - lw / 2, oy + drawH + 7, label, [71, 85, 105, 255], 1);
    }
  }
  const stepY = niceStep(worldH, 4);
  for (let v = 0; v <= worldH + 1e-6; v += stepY) {
    const py = oy + v * scale;
    if (py > oy + drawH + 1) break;
    canvas.drawLine(ox, py, ox + drawW, py, [226, 232, 240, 200], 1);
    canvas.drawLine(ox - 4, py, ox, py, [100, 116, 139, 255], 1);
    const label = `${Math.round(v)}`;
    const lw = canvas.measureText(label, 1);
    canvas.drawText(Math.max(2, ox - lw - 7), py - 3, label, [71, 85, 105, 255], 1);
  }
  canvas.drawText(
    ox,
    oy - 12,
    horizontalRoll ? 'AXIS: X=LENGTH(MM), Y=WIDTH(MM)' : 'AXIS: X=WIDTH(MM), Y=LENGTH(MM)',
    [100, 116, 139, 255],
    1
  );

  // 计划料头（绿色浅填充 + 绿色虚线框）
  for (const lf of leftovers) {
    const lx = Number(lf.x ?? 0);
    const ly = Number(lf.y ?? 0);
    const lw = Number(lf.shape?.width ?? 0);
    const lh = Number(lf.shape?.height ?? 0);
    if (lw <= 0 || lh <= 0 || ly > displayH) continue;
    const p1 = mapPt(lx, ly);
    const p2 = mapPt(lx + lw, Math.min(displayH, ly + lh));
    const rx = Math.min(p1.x, p2.x);
    const ry = Math.min(p1.y, p2.y);
    const rw = Math.abs(p2.x - p1.x);
    const rh = Math.abs(p2.y - p1.y);
    canvas.fillRect(rx, ry, rw, rh, [34, 197, 94, 55]);
    canvas.strokeRect(rx, ry, rw, rh, [21, 128, 61, 255], 1, 4, 3);
  }

  // 裁片（支持矩形与异形多边形 + 内孔扫描线镂空）
  for (const p of placements) {
    const px0 = Number(p.x ?? 0);
    const py0 = Number(p.y ?? 0);
    const { outer, holes } = shapeToLocalRings(p.shape);
    if (outer.length < 3) continue;
    const palette = PIECE_PALETTE[paletteIndex(p.demandId ?? p.name ?? p.id)];
    const mappedOuter = outer.map((pt) => mapPt(px0 + pt.x, py0 + pt.y));
    const mappedHoles = holes.map((ring) => ring.map((pt) => mapPt(px0 + pt.x, py0 + pt.y)));

    if (p.shape?.type === 'POLYGON' || mappedHoles.length > 0) {
      canvas.fillPolygonWithHoles([mappedOuter, ...mappedHoles], palette.fill);
      canvas.strokeRing(mappedOuter, palette.stroke, 1);
      for (const hRing of mappedHoles) {
        canvas.strokeRing(hRing, [153, 27, 27, 220], 1, 3, 2);
      }
    } else {
      const p1 = mapPt(px0, py0);
      const p2 = mapPt(px0 + Number(p.shape.width), py0 + Number(p.shape.height));
      const rx = Math.min(p1.x, p2.x);
      const ry = Math.min(p1.y, p2.y);
      const rw = Math.abs(p2.x - p1.x);
      const rh = Math.abs(p2.y - p1.y);
      canvas.fillRect(rx, ry, rw, rh, palette.fill);
      canvas.strokeRect(rx, ry, rw, rh, palette.stroke, 1);
    }

    // 在空间足够的裁片中心标出规格序号
    const xs = mappedOuter.map((pt) => pt.x);
    const ys = mappedOuter.map((pt) => pt.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const tag = `#${p.demandId ?? p.id ?? ''}`;
    const tw = canvas.measureText(tag, 1);
    if (bw >= tw + 6 && bh >= 12) {
      const cx = (Math.min(...xs) + Math.max(...xs) - tw) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys) - 7) / 2;
      canvas.drawText(cx, cy, tag, [15, 23, 42, 255], 1);
    }
  }

  // 疵点禁区（红色半透明填充 + 红色交叉线）
  for (const d of exclusions) {
    const dx = Number(d.x ?? 0);
    const dy = Number(d.y ?? 0);
    const dw = Math.max(10, Number(d.shape?.width ?? 20));
    const dh = Math.max(10, Number(d.shape?.height ?? 20));
    if (dy > displayH) continue;
    const p1 = mapPt(dx, dy);
    const p2 = mapPt(dx + dw, Math.min(displayH, dy + dh));
    const rx = Math.min(p1.x, p2.x);
    const ry = Math.min(p1.y, p2.y);
    const rw = Math.max(6, Math.abs(p2.x - p1.x));
    const rh = Math.max(6, Math.abs(p2.y - p1.y));
    canvas.fillRect(rx, ry, rw, rh, [220, 38, 38, 95]);
    canvas.strokeRect(rx, ry, rw, rh, [185, 28, 28, 255], 1);
    canvas.drawLine(rx, ry, rx + rw, ry + rh, [185, 28, 28, 210], 1);
    canvas.drawLine(rx + rw, ry, rx, ry + rh, [185, 28, 28, 210], 1);
  }

  // 占用长度截断线（橙色虚线）
  if (occupiedLengthMm > 0 && occupiedLengthMm < displayH) {
    if (horizontalRoll) {
      const cutX = ox + occupiedLengthMm * scale;
      canvas.drawLine(cutX, oy, cutX, oy + drawH, [217, 119, 6, 255], 2, 5, 3);
    } else {
      const cutY = oy + occupiedLengthMm * scale;
      canvas.drawLine(ox, cutY, ox + drawW, cutY, [217, 119, 6, 255], 2, 5, 3);
    }
  }

  // 深蓝母卷外边界（2px 实线）
  canvas.strokeRect(ox, oy, drawW, drawH, [30, 58, 138, 255], 2);

  // 底部图例栏
  const legendY = canvas.height - footerH + 6;
  canvas.fillRect(0, canvas.height - footerH, canvas.width, footerH, [241, 245, 249, 255]);
  canvas.drawLine(0, canvas.height - footerH, canvas.width, canvas.height - footerH, [203, 213, 225, 255], 1);

  let lx = 12;
  const drawLegend = (fill, stroke, label, dashed = false) => {
    canvas.fillRect(lx, legendY, 12, 10, fill);
    canvas.strokeRect(lx, legendY, 12, 10, stroke, 1, dashed ? 2 : 0, dashed ? 2 : 0);
    canvas.drawText(lx + 16, legendY + 2, label, [51, 65, 85, 255], 1);
    lx += 24 + canvas.measureText(label, 1) + 12;
  };
  drawLegend([219, 234, 254, 255], [30, 58, 138, 255], `PIECES(${placements.length})`);
  drawLegend([34, 197, 94, 70], [21, 128, 61, 255], `LEFTOVERS(${leftovers.length})`, true);
  drawLegend([220, 38, 38, 95], [185, 28, 28, 255], `DEFECTS(${exclusions.length})`);

  const sourceTag = source?.materialId || taskSummary?.materialModel || layout.materialId || '';
  if (sourceTag) {
    const cleanTag = String(sourceTag).replace(/[^A-Za-z0-9._:/ -]/g, '').slice(0, 28);
    if (cleanTag) {
      const tw = canvas.measureText(cleanTag, 1);
      if (canvas.width - tw - 12 > lx) {
        canvas.drawText(canvas.width - tw - 12, legendY + 2, cleanTag, [100, 116, 139, 255], 1);
      }
    }
  }

  return {
    mode: 'NESTING_2D',
    summary: {
      materialWidthMm: Math.round(matW * 10) / 10,
      materialLengthMm: Math.round(matH * 10) / 10,
      occupiedLengthMm: Math.round(occupiedLengthMm * 10) / 10,
      placementCount: placements.length,
      leftoverCount: leftovers.length,
      defectCount: exclusions.length,
      patternCount: 0,
      utilizationPct: utilPct
    }
  };
}

function render1D(canvas, { result, input }) {
  const slit = result?.slitting || {};
  const patterns = Array.isArray(slit.patterns) ? slit.patterns : [];
  const headerH = 34;
  const footerH = 26;

  const motherArea = Number(slit.motherAreaMm2 ?? 0);
  const pieceArea = Number(slit.pieceAreaMm2 ?? 0);
  const utilMetric = extractMetricPct(result);
  const utilPct =
    utilMetric !== null
      ? utilMetric
      : motherArea > 0
      ? Number(((pieceArea / motherArea) * 100).toFixed(2))
      : null;

  canvas.fillRect(0, 0, canvas.width, headerH, [30, 41, 59, 255]);
  const totalRuns = patterns.reduce((s, p) => s + Number(p.repetitions ?? 0), 0);
  const titleParts = [`1D SLITTING`, `PATTERNS:${patterns.length}`, `RUNS:${totalRuns}`];
  if (utilPct !== null) titleParts.push(`UTIL:${utilPct}%`);
  if (slit.estimatedKnifeChanges !== undefined && slit.estimatedKnifeChanges !== null) {
    titleParts.push(`KNIVES:${slit.estimatedKnifeChanges}`);
  }
  canvas.drawText(12, 13, titleParts.join(' | '), [248, 250, 252, 255], 1);

  const marginLeft = 72;
  const marginRight = 92;
  const marginTop = headerH + 22;
  const marginBottom = footerH + 14;
  const availW = Math.max(80, canvas.width - marginLeft - marginRight);
  const availH = Math.max(40, canvas.height - marginTop - marginBottom);

  const maxRows = Math.max(1, Math.min(patterns.length, Math.floor(availH / 26)));
  const shown = patterns.slice(0, maxRows);
  const rowGap = 6;
  const rowH = Math.max(14, Math.min(34, Math.floor((availH - rowGap * Math.max(0, maxRows - 1)) / Math.max(1, maxRows))));

  const maxMotherW = Math.max(
    1,
    Number(input?.problem?.motherWidthMm ?? 0),
    ...patterns.map((p) => Number(p.motherWidthMm ?? p.rollWidthMm ?? p.patternWidthMm ?? 0))
  );
  const leftTrim = Math.max(0, Number(input?.problem?.leftTrimMm ?? 0));
  const rightTrim = Math.max(0, Number(input?.problem?.rightTrimMm ?? 0));

  // 顶部宽度标尺
  const step = niceStep(maxMotherW, 6);
  for (let w = 0; w <= maxMotherW + 1e-6; w += step) {
    const px = marginLeft + (w / maxMotherW) * availW;
    canvas.drawLine(px, marginTop - 4, px, marginTop + availH, [226, 232, 240, 200], 1);
    const label = `${Math.round(w)}`;
    const lw = canvas.measureText(label, 1);
    canvas.drawText(px - lw / 2, headerH + 8, label, [100, 116, 139, 255], 1);
  }

  for (let i = 0; i < shown.length; i++) {
    const pat = shown[i];
    const y = marginTop + i * (rowH + rowGap);
    const patMotherW = Number(pat.motherWidthMm ?? pat.rollWidthMm ?? maxMotherW);
    const barW = (patMotherW / maxMotherW) * availW;

    // 左侧车次标签
    canvas.drawText(8, y + Math.max(2, Math.floor((rowH - 7) / 2)), `P${i + 1} X${pat.repetitions ?? 1}`, [30, 41, 59, 255], 1);

    // 整卷底条（余料/边丝背景）
    canvas.fillRect(marginLeft, y, barW, rowH, [254, 226, 226, 220]);

    let cursorMm = leftTrim;
    if (leftTrim > 0) {
      const tw = (leftTrim / maxMotherW) * availW;
      canvas.fillRect(marginLeft, y, tw, rowH, [203, 213, 225, 255]);
    }

    const stations = Array.isArray(pat.stations) ? pat.stations : [];
    let usedMm = 0;
    for (const st of stations) {
      const sw = Number(st.widthMm ?? 0);
      const cnt = Math.max(0, Number(st.countPerRepetition ?? 0));
      const color = SLIT_PALETTE[paletteIndex(sw)];
      for (let c = 0; c < cnt; c++) {
        const sx = marginLeft + (cursorMm / maxMotherW) * availW;
        const pxW = (sw / maxMotherW) * availW;
        canvas.fillRect(sx, y, Math.max(1, pxW), rowH, color);
        canvas.strokeRect(sx, y, Math.max(1, pxW), rowH, [15, 23, 42, 255], 1);
        const wText = `${Math.round(sw)}`;
        const tw = canvas.measureText(wText, 1);
        if (pxW >= tw + 4 && rowH >= 13) {
          canvas.drawText(sx + (pxW - tw) / 2, y + Math.floor((rowH - 7) / 2), wText, [248, 250, 252, 255], 1);
        }
        cursorMm += sw;
        usedMm += sw;
      }
    }

    if (rightTrim > 0) {
      const rw = (rightTrim / maxMotherW) * availW;
      canvas.fillRect(marginLeft + barW - rw, y, rw, rowH, [203, 213, 225, 255]);
    }

    // 母卷外框
    canvas.strokeRect(marginLeft, y, barW, rowH, [30, 58, 138, 255], 1);

    // 右侧余料与利用率
    const wasteMm = Math.max(0, Math.round(patMotherW - usedMm));
    const patUtil = patMotherW > 0 ? ((usedMm / patMotherW) * 100).toFixed(1) : '0.0';
    canvas.drawText(
      marginLeft + barW + 6,
      y + Math.max(2, Math.floor((rowH - 7) / 2)),
      `${patUtil}% W:${wasteMm}`,
      [51, 65, 85, 255],
      1
    );
  }

  // 底部图例栏
  const legendY = canvas.height - footerH + 6;
  canvas.fillRect(0, canvas.height - footerH, canvas.width, footerH, [241, 245, 249, 255]);
  canvas.drawLine(0, canvas.height - footerH, canvas.width, canvas.height - footerH, [203, 213, 225, 255], 1);
  let lx = 12;
  const drawLegend = (fill, stroke, label) => {
    canvas.fillRect(lx, legendY, 12, 10, fill);
    canvas.strokeRect(lx, legendY, 12, 10, stroke, 1);
    canvas.drawText(lx + 16, legendY + 2, label, [51, 65, 85, 255], 1);
    lx += 24 + canvas.measureText(label, 1) + 12;
  };
  drawLegend([59, 130, 246, 235], [15, 23, 42, 255], 'SLIT STRIPS');
  drawLegend([254, 226, 226, 220], [185, 28, 28, 255], 'EDGE/TRIM WASTE');
  if (patterns.length > shown.length) {
    canvas.drawText(lx, legendY + 2, `+${patterns.length - shown.length} MORE PATTERNS`, [100, 116, 139, 255], 1);
  }

  return {
    mode: 'SLITTING_1D',
    summary: {
      materialWidthMm: Math.round(maxMotherW),
      materialLengthMm: 0,
      occupiedLengthMm: 0,
      placementCount: 0,
      leftoverCount: 0,
      defectCount: 0,
      patternCount: patterns.length,
      utilizationPct: utilPct
    }
  };
}

function renderEmpty(canvas, result) {
  canvas.fillRect(0, 0, canvas.width, 34, [30, 41, 59, 255]);
  canvas.drawText(12, 13, 'CUTTING PREVIEW | NO GEOMETRY PAYLOAD', [248, 250, 252, 255], 1);
  const msg = `RESULT ${String(result?.id || 'UNKNOWN').replace(/[^A-Za-z0-9._-]/g, '')} HAS NO 2D OR 1D LAYOUT`;
  const tw = canvas.measureText(msg, 1);
  canvas.drawText(Math.max(12, (canvas.width - tw) / 2), Math.floor(canvas.height / 2) - 4, msg, [71, 85, 105, 255], 1);
  return {
    mode: 'EMPTY',
    summary: {
      materialWidthMm: 0,
      materialLengthMm: 0,
      occupiedLengthMm: 0,
      placementCount: 0,
      leftoverCount: 0,
      defectCount: 0,
      patternCount: 0,
      utilizationPct: null
    }
  };
}

/**
 * 渲染标准 2D 或 1D 排料预览 PNG。
 */
export function renderCuttingPreviewPng({
  result,
  input = null,
  source = null,
  taskSummary = null,
  widthPx = 800,
  heightPx = 420
} = {}) {
  const w = Math.max(320, Math.min(2000, Math.round(Number(widthPx) || 800)));
  const h = Math.max(200, Math.min(1600, Math.round(Number(heightPx) || 420)));
  const canvas = new RasterCanvas(w, h);

  let rendered;
  if (result?.layout) {
    rendered = render2D(canvas, { result, input, source, taskSummary });
  } else if (result?.slitting) {
    rendered = render1D(canvas, { result, input, source, taskSummary });
  } else {
    rendered = renderEmpty(canvas, result);
  }

  return {
    buffer: canvas.toPngBuffer(),
    widthPx: w,
    heightPx: h,
    mode: rendered.mode,
    summary: rendered.summary
  };
}
