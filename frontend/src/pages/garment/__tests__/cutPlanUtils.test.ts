import { describe, expect, it } from 'vitest';
import {
  CUT_PLAN_PRESETS,
  CutPlanResponse,
  DEFAULT_GARMENT_SIZES,
  buildCutPlanCsvText,
  buildCutPlanDemandPoolPayload,
  buildCutPlanPayload,
  buildCutPlanWorkbenchDemands,
  createDefaultCutPlanForm,
  extractCutPlanSizeKeys,
  suggestNextSizeRow,
  summarizeSizeAudit,
  totalCutPlanOrderedQty
} from '../cutPlanUtils';

const SAMPLE_RESPONSE: CutPlanResponse = {
  styleName: 'FZ-2026-HOODIE',
  colorName: '炭灰',
  totalOrderedGarments: 210,
  totalPlannedGarments: 212,
  overcutGarments: 2,
  layCount: 2,
  totalPlies: 60,
  totalFabricLengthM: 215.4,
  totalFabricAreaM2: 355.41,
  estimatedWeightKg: 99.51,
  averageEfficiencyPct: 84.3,
  lays: [
    {
      layNo: 1,
      plies: 40,
      ratio: { S: 1, M: 2, L: 1 },
      garmentsPerMarker: 4,
      layGarments: 160,
      estimatedMarkerLengthMm: 3820,
      fabricLengthM: 155.2,
      fabricAreaM2: 256.08
    },
    {
      layNo: 2,
      plies: 20,
      ratio: { S: 1, M: 1, XL: 1 },
      garmentsPerMarker: 3,
      layGarments: 60,
      estimatedMarkerLengthMm: 2950,
      fabricLengthM: 60.2,
      fabricAreaM2: 99.33
    }
  ],
  sizeAudit: [
    { size: 'S', ordered: 60, planned: 60, delta: 0 },
    { size: 'M', ordered: 100, planned: 100, delta: 0 },
    { size: 'L', ordered: 40, planned: 40, delta: 0 },
    { size: 'XL', ordered: 10, planned: 12, delta: 2 }
  ]
};

describe('garment/cutPlanUtils 服装订单自动分床工具', () => {
  it('buildCutPlanPayload 正常组装载荷、合并同尺码并过滤零件数尺码', () => {
    const form = createDefaultCutPlanForm();
    form.styleName = '  FZ-HOODIE  ';
    form.colorName = '  藏青  ';
    form.sizes = [
      { size: ' s ', quantity: 30, unitAreaM2: 1.1 },
      { size: 'S', quantity: 30, unitAreaM2: 1.3 },
      { size: 'm', quantity: 100, unitAreaM2: 1.26 },
      { size: 'XL', quantity: 0, unitAreaM2: 1.44 }
    ];

    const built = buildCutPlanPayload(form);
    expect(built.error).toBeUndefined();
    expect(built.payload).toMatchObject({
      styleName: 'FZ-HOODIE',
      colorName: '藏青',
      fabricWidthMm: 1650,
      maxPliesPerLay: 60,
      maxGarmentsPerMarker: 8,
      maxLayLengthMm: 10000,
      endAllowanceMm: 60,
      grammageGsm: 280,
      defaultUnitAreaM2: 1.32,
      targetUtilizationPct: 84,
      allowOvercutPct: 0,
      sizeQuantities: { S: 60, M: 100 },
      sizeUnitAreaM2: { S: 1.2, M: 1.26 }
    });
  });

  it('buildCutPlanPayload 在 maxLayLengthMm=0 或 grammageGsm=0 时省略对应可选字段', () => {
    const form = createDefaultCutPlanForm();
    form.maxLayLengthMm = 0;
    form.grammageGsm = 0;
    const built = buildCutPlanPayload(form);
    expect(built.error).toBeUndefined();
    expect(built.payload?.maxLayLengthMm).toBeUndefined();
    expect(built.payload?.grammageGsm).toBeUndefined();
  });

  it('buildCutPlanPayload 严格拦截非法参数边界与缺失字段', () => {
    const base = createDefaultCutPlanForm();

    expect(buildCutPlanPayload({ ...base, styleName: '   ' }).error).toContain('款号');
    expect(buildCutPlanPayload({ ...base, colorName: '' }).error).toContain('颜色');
    expect(buildCutPlanPayload({ ...base, fabricWidthMm: 0 }).error).toContain('门幅');
    expect(buildCutPlanPayload({ ...base, maxPliesPerLay: 0 }).error).toContain('层数');
    expect(buildCutPlanPayload({ ...base, maxPliesPerLay: 10001 }).error).toContain('层数');
    expect(buildCutPlanPayload({ ...base, maxGarmentsPerMarker: 0 }).error).toContain('单唛');
    expect(buildCutPlanPayload({ ...base, maxGarmentsPerMarker: 101 }).error).toContain('单唛');
    expect(buildCutPlanPayload({ ...base, maxLayLengthMm: -10 }).error).toContain('床长');
    expect(buildCutPlanPayload({ ...base, endAllowanceMm: 2500 }).error).toContain('损耗');
    expect(buildCutPlanPayload({ ...base, grammageGsm: -1 }).error).toContain('克重');
    expect(buildCutPlanPayload({ ...base, defaultUnitAreaM2: 0 }).error).toContain('净面积');
    expect(buildCutPlanPayload({ ...base, targetUtilizationPct: 10 }).error).toContain('利用率');
    expect(buildCutPlanPayload({ ...base, allowOvercutPct: 55 }).error).toContain('超裁');
    expect(
      buildCutPlanPayload({
        ...base,
        sizes: [{ size: 'M', quantity: -5, unitAreaM2: 1.2 }]
      }).error
    ).toContain('负数');
    expect(
      buildCutPlanPayload({
        ...base,
        sizes: [{ size: '  ', quantity: 10, unitAreaM2: 1.2 }]
      }).error
    ).toContain('尺码名称');
    expect(
      buildCutPlanPayload({
        ...base,
        sizes: [{ size: 'S', quantity: 0, unitAreaM2: 1.2 }]
      }).error
    ).toContain('大于 0');
  });

  it('summarizeSizeAudit 准确区分精准守恒、允许超裁与短缺欠裁', () => {
    const okSummary = summarizeSizeAudit(SAMPLE_RESPONSE.sizeAudit);
    expect(okSummary).toEqual({
      balanced: true,
      exactCount: 3,
      overcutCount: 1,
      shortageCount: 0,
      overcutTotal: 2,
      shortageTotal: 0
    });

    const shortageSummary = summarizeSizeAudit([
      { size: 'S', ordered: 60, planned: 60, delta: 0 },
      { size: 'M', ordered: 100, planned: 94, delta: -6 },
      { size: 'L', ordered: 80, planned: 82, delta: 2 }
    ]);
    expect(shortageSummary).toEqual({
      balanced: false,
      exactCount: 1,
      overcutCount: 1,
      shortageCount: 1,
      overcutTotal: 2,
      shortageTotal: 6
    });
  });

  it('buildCutPlanCsvText 输出带 BOM 的安全转义 CSV 并防御公式注入', () => {
    const csv = buildCutPlanCsvText({
      ...SAMPLE_RESPONSE,
      styleName: '=CMD|calc',
      colorName: '+红,蓝"混色'
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"配比_S"');
    expect(lines[0]).toContain('"配比_XL"');
    expect(lines[1]).toContain('"\'=CMD|calc"');
    expect(lines[1]).toContain('"\'+红,蓝""混色"');
    expect(lines[1]).toContain('"第1床"');
    expect(lines[2]).toContain('"第2床"');
  });

  it('buildCutPlanWorkbenchDemands 与 buildCutPlanDemandPoolPayload 大小写无关匹配单件面积并生成合法需求族载荷', () => {
    const form = createDefaultCutPlanForm();
    form.fabricWidthMm = 1600;
    form.sizes = [
      { size: 's', quantity: 60, unitAreaM2: 1.0 },
      { size: 'm', quantity: 100, unitAreaM2: 1.5 }
    ];

    const demands = buildCutPlanWorkbenchDemands(SAMPLE_RESPONSE, form);
    expect(demands).toHaveLength(4);
    // width = min(round(1600 * 0.45), 720) = 720
    expect(demands[0]).toMatchObject({
      id: 1,
      name: 'FZ-2026-HOODIE-S码整套',
      sizeLabel: 'S',
      width: 720,
      length: Math.round(1_000_000 / 720),
      quantity: 60,
      allowRotation: false
    });
    expect(demands[1].length).toBe(Math.round(1_500_000 / 720));
    // L 码未在 form.sizes 中，回落 defaultUnitAreaM2 = 1.32
    expect(demands[2].length).toBe(Math.round(1_320_000 / 720));

    const pool = buildCutPlanDemandPoolPayload(SAMPLE_RESPONSE, form);
    expect(pool.error).toBeUndefined();
    expect(pool.canvasWidthMm).toBe(1600);
    expect(pool.canvasLengthMm).toBe(3820);
    expect(pool.payload).toMatchObject({
      name: '分床转入 · FZ-2026-HOODIE (炭灰)',
      materialModel: 'FZ-2026-HOODIE-FABRIC',
      externalRef: 'CUTPLAN-2LAY',
      dimension: 'RECT_2D',
      requiredColor: '炭灰'
    });
    expect(pool.payload?.demands).toHaveLength(4);

    const emptyPool = buildCutPlanDemandPoolPayload(
      { ...SAMPLE_RESPONSE, sizeAudit: [{ size: 'S', ordered: 10, planned: 0, delta: -10 }] },
      form
    );
    expect(emptyPool.error).toContain('有效计划件数');
  });

  it('extractCutPlanSizeKeys、totalCutPlanOrderedQty、suggestNextSizeRow 与内置预设均正确有效', () => {
    expect(extractCutPlanSizeKeys(SAMPLE_RESPONSE)).toEqual(['S', 'M', 'L', 'XL']);
    expect(totalCutPlanOrderedQty(DEFAULT_GARMENT_SIZES)).toBe(460);

    const nextAlpha = suggestNextSizeRow(DEFAULT_GARMENT_SIZES);
    expect(nextAlpha.size).toBe('3XL');
    expect(nextAlpha.unitAreaM2).toBe(1.62);

    const nextKid = suggestNextSizeRow([
      { size: '110', quantity: 20, unitAreaM2: 0.72 },
      { size: '120', quantity: 30, unitAreaM2: 0.8 }
    ]);
    expect(nextKid.size).toBe('130');

    for (const preset of CUT_PLAN_PRESETS) {
      const built = buildCutPlanPayload(preset.form);
      expect(built.error).toBeUndefined();
      expect(built.payload).toBeDefined();
    }
  });
});
