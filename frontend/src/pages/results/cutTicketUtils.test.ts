import { describe, expect, it } from 'vitest';
import { buildCutTicketModel } from './cutTicketUtils';

describe('A4 车间派工裁切单完整模型（严禁 25/16 截断）', () => {
  it('60 件裁片与 35 道贯通直刀全部保留不截断，且正确标注工单号、件号、尺寸、刀序、疵点与起点', () => {
    const placements = Array.from({ length: 60 }, (_, idx) => ({
      id: idx + 1,
      name: `裁片部件-${idx + 1}`,
      x: (idx % 6) * 260,
      y: Math.floor(idx / 6) * 320,
      w: 240,
      l: 300
    }));
    const cuts = Array.from({ length: 35 }, (_, idx) => ({
      sequence: idx + 1,
      kind: idx % 2 === 0 ? 'HORIZONTAL' : 'VERTICAL',
      startX: 0,
      startY: (idx + 1) * 90,
      endX: 1800,
      endY: (idx + 1) * 90
    }));

    const scheme = {
      id: 'SCH-0925-ABCD',
      widthMm: 1800,
      occupiedLengthMm: 3400,
      windowStartY: 1000,
      layout2D: { placements, cuts }
    };
    const boundRoll = {
      rollId: 'ROLL-888',
      defects: [
        { id: 1, x: 300, y: 1500, w: 80, h: 60, margin: 20 }, // 落在 [1000, 4400] 内 -> 局部 y=500
        { id: 2, x: 100, y: 200, w: 50, h: 50, margin: 10 } // 落在窗口之前，应过滤
      ]
    };

    const model = buildCutTicketModel(scheme, { cutOrigin: 'right-bottom', boundRoll });
    expect(model.workOrderNo).toBe('WO-SCH-0925-ABCD');
    expect(model.placements).toHaveLength(60);
    expect(model.placements[59].pieceLabel).toBe('#60');
    expect(model.placements[59].dimLabel).toBe('240×300');

    expect(model.cuts).toHaveLength(35);
    expect(model.cuts[34].sequence).toBe(35);
    expect(model.cuts[0].directionLabel).toBe('横切');
    expect(model.cuts[1].directionLabel).toBe('纵切');

    expect(model.defects).toHaveLength(1);
    expect(model.defects[0].y).toBe(500);
    expect(model.originPoint).toEqual({ x: 1800, y: 3400, label: '起点(右下)' });
  });

  it('超大门幅下 SVG 线宽与字体随最大边自适应缩放，避免线条过细变形', () => {
    const smallModel = buildCutTicketModel({
      id: 'SCH-SMALL',
      widthMm: 1000,
      occupiedLengthMm: 1000,
      layout2D: { placements: [], cuts: [] }
    });
    const largeModel = buildCutTicketModel({
      id: 'SCH-LARGE',
      widthMm: 4600,
      occupiedLengthMm: 8000,
      layout2D: { placements: [], cuts: [] }
    });
    expect(largeModel.borderStroke).toBeGreaterThan(smallModel.borderStroke * 4);
    expect(largeModel.headerFontSize).toBeGreaterThan(smallModel.headerFontSize * 4);
    expect(largeModel.viewBox.split(' ')).toHaveLength(4);
  });
});
