import React, { useMemo } from 'react';

/**
 * 标准 ISO/IEC 15417 Code 128 编码表（值 0..106）。
 * - 0..105：6 位数字（条/空/条/空/条/空，模块总和恒为 11）
 * - 106（Stop）：7 位数字（条/空/条/空/条/空/条，模块总和恒为 13）
 */
export const CODE128_PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

const START_CODE_B = 104;
const STOP_CODE = 106;

export interface BarcodeBar {
  x: number;
  width: number;
}

export interface Code128Encoded {
  rawValue: string;
  sanitizedValue: string;
  codes: number[];
  checksum: number;
  quietZoneModules: number;
  totalModules: number;
  bars: BarcodeBar[];
}

/** 清洗为 Code 128B 可编码 ASCII 字符集（0x20..0x7E） */
export function sanitizeCode128BText(input: string): string {
  const raw = String(input ?? '').trim();
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (ch >= 32 && ch <= 126) {
      out += raw[i];
    } else if (!/\s/.test(raw[i])) {
      // 非 ASCII 符号兜底替换为连字符，防止工业扫码乱码或编码越界
      out += '-';
    }
  }
  return out;
}

/**
 * 纯前端零依赖 Code 128B 编码器：
 * - Start B (104) + 数据位 + Mod 103 校验位 + Stop (106)
 * - 默认左右各留 10 模块静区（ISO/IEC 15417 要求 >= 10X）
 */
export function encodeCode128B(value: string, quietZoneModules = 10): Code128Encoded {
  const rawValue = String(value ?? '');
  const sanitizedValue = sanitizeCode128BText(rawValue);
  if (!sanitizedValue) {
    return {
      rawValue,
      sanitizedValue: '',
      codes: [],
      checksum: 0,
      quietZoneModules,
      totalModules: 0,
      bars: []
    };
  }

  const dataCodes: number[] = [];
  for (let i = 0; i < sanitizedValue.length; i++) {
    dataCodes.push(sanitizedValue.charCodeAt(i) - 32);
  }

  let sum = START_CODE_B;
  for (let i = 0; i < dataCodes.length; i++) {
    sum += dataCodes[i] * (i + 1);
  }
  const checksum = sum % 103;
  const codes = [START_CODE_B, ...dataCodes, checksum, STOP_CODE];

  const bars: BarcodeBar[] = [];
  let cursor = quietZoneModules;
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    for (let i = 0; i < pattern.length; i++) {
      const w = Number(pattern[i]);
      if (i % 2 === 0) {
        bars.push({ x: cursor, width: w });
      }
      cursor += w;
    }
  }
  const totalModules = cursor + quietZoneModules;

  return {
    rawValue,
    sanitizedValue,
    codes,
    checksum,
    quietZoneModules,
    totalModules,
    bars
  };
}

export interface BarcodeSvgProps {
  value: string;
  label?: string;
  height?: number;
  moduleWidth?: number;
  showText?: boolean;
  className?: string;
}

/**
 * 工业级矢量 Code128 SVG 条码组件（零外部依赖，适合 A4 车间派工单高清打印与扫码枪直扫）。
 */
export const BarcodeSvg: React.FC<BarcodeSvgProps> = ({
  value,
  label,
  height = 42,
  moduleWidth = 1.4,
  showText = true,
  className = ''
}) => {
  const encoded = useMemo(() => encodeCode128B(value), [value]);

  if (!encoded.sanitizedValue || encoded.totalModules <= 0) {
    return null;
  }

  const textHeight = showText ? 14 : 0;
  const topPad = 4;
  const bottomPad = 4;
  const svgWidth = Math.round(encoded.totalModules * moduleWidth);
  const svgHeight = topPad + height + textHeight + bottomPad;

  return (
    <div
      className={`cp-barcode-box ${className}`.trim()}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 4,
        padding: '4px 6px'
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 10,
            color: '#475569',
            lineHeight: 1.2,
            marginBottom: 2,
            fontWeight: 600
          }}
        >
          {label}
        </span>
      )}
      <svg
        role="img"
        aria-label={label ? `${label} 条码 ${encoded.sanitizedValue}` : `条码 ${encoded.sanitizedValue}`}
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        preserveAspectRatio="xMidYMid meet"
        shapeRendering="crispEdges"
        style={{ display: 'block', maxWidth: '100%', height: 'auto', background: '#ffffff' }}
      >
        <rect x={0} y={0} width={svgWidth} height={svgHeight} fill="#ffffff" />
        {encoded.bars.map((bar, idx) => (
          <rect
            key={idx}
            x={Number((bar.x * moduleWidth).toFixed(2))}
            y={topPad}
            width={Number((bar.width * moduleWidth).toFixed(2))}
            height={height}
            fill="#000000"
          />
        ))}
        {showText && (
          <text
            x={svgWidth / 2}
            y={topPad + height + 11}
            textAnchor="middle"
            fontSize={10}
            fontFamily='"JetBrains Mono", Consolas, monospace'
            fill="#0f172a"
          >
            {encoded.sanitizedValue}
          </text>
        )}
      </svg>
    </div>
  );
};
