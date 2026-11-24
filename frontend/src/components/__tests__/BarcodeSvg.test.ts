import { describe, expect, it } from 'vitest';
import {
  CODE128_PATTERNS,
  encodeCode128B,
  sanitizeCode128BText
} from '../BarcodeSvg';

describe('BarcodeSvg 纯前端零依赖 Code128B 编码器', () => {
  it('ISO/IEC 15417 编码表包含完整 107 项且模块总宽度严格合规', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    for (let i = 0; i <= 105; i++) {
      const p = CODE128_PATTERNS[i];
      expect(p).toHaveLength(6);
      const sum = [...p].reduce((acc, ch) => acc + Number(ch), 0);
      expect(sum).toBe(11);
    }
    const stop = CODE128_PATTERNS[106];
    expect(stop).toHaveLength(7);
    expect([...stop].reduce((acc, ch) => acc + Number(ch), 0)).toBe(13);
  });

  it('正确编码工单号 WO-SCH-2026 与母卷号 ROLL-2026-0920 并验证 Mod 103 校验和与静区', () => {
    const wo = encodeCode128B('WO-SCH-2026');
    expect(wo.sanitizedValue).toBe('WO-SCH-2026');
    expect(wo.codes[0]).toBe(104); // Start B
    expect(wo.codes[wo.codes.length - 1]).toBe(106); // Stop
    expect(wo.codes).toHaveLength('WO-SCH-2026'.length + 3);

    // 独立验算 Mod 103 校验位
    let expectedSum = 104;
    for (let i = 0; i < 'WO-SCH-2026'.length; i++) {
      expectedSum += ('WO-SCH-2026'.charCodeAt(i) - 32) * (i + 1);
    }
    expect(wo.checksum).toBe(expectedSum % 103);
    expect(wo.codes[wo.codes.length - 2]).toBe(wo.checksum);

    // 总模块宽 = 10(左静区) + (Start + N数据 + Checksum) * 11 + 13(Stop) + 10(右静区)
    const expectedModules = 10 + ('WO-SCH-2026'.length + 2) * 11 + 13 + 10;
    expect(wo.totalModules).toBe(expectedModules);

    // 验证条纹严格不重叠且位于左右静区之内
    expect(wo.bars.length).toBeGreaterThan(0);
    expect(wo.bars[0].x).toBe(10);
    for (let i = 1; i < wo.bars.length; i++) {
      expect(wo.bars[i].x).toBeGreaterThan(wo.bars[i - 1].x + wo.bars[i - 1].width);
    }
    const lastBar = wo.bars[wo.bars.length - 1];
    expect(lastBar.x + lastBar.width).toBe(wo.totalModules - 10);

    const roll = encodeCode128B('ROLL-2026-0920');
    expect(roll.sanitizedValue).toBe('ROLL-2026-0920');
    expect(roll.bars.length).toBe(('ROLL-2026-0920'.length + 2) * 3 + 4);
  });

  it('清洗非 ASCII 字符与空字符串时安全降级不抛异常', () => {
    expect(sanitizeCode128BText('  WO-01 织布  ')).toBe('WO-01 --');
    const empty = encodeCode128B('   ');
    expect(empty.sanitizedValue).toBe('');
    expect(empty.totalModules).toBe(0);
    expect(empty.bars).toEqual([]);
  });
});
