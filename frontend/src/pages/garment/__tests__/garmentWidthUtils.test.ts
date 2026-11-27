import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildPreviewRow,
  buildSizeCounts,
  buildStudio2DDemandsFromMarker,
  buildTrialDetailNotes,
  computeGarmentRowMetricsSummary,
  getOrderedSizes,
  resolveGarmentMaterialMeta,
  resolveInitialExample
} from '../../GarmentWidthPage';
import { GarmentWidthFormSidebar } from '../GarmentWidthFormSidebar';
import { fourPieceOptimized } from '../../../lib/nesting/four-piece-seed.js';

describe('GarmentWidthPage 服装唛架纯函数与 DOM 表单契约', () => {
  it('getOrderedSizes 与 buildSizeCounts 区分传统样板与 DXF 样板尺码排序与数量回退', () => {
    const skirtSizes = getOrderedSizes('GARMENT_SKIRT');
    expect(skirtSizes).toEqual(['M', 'L']);
    expect(buildSizeCounts('GARMENT_SKIRT')).toEqual({ M: 1, L: 1 });

    const dxfSizes = getOrderedSizes('GARMENT_DXF_20148D_SHELL');
    expect(dxfSizes.slice(0, 2)).toEqual(['130', '140']);

    const counts = buildSizeCounts('GARMENT_DXF_20148D_SHELL', {
      '130': 3,
      '140': 'invalid'
    });
    expect(counts['130']).toBe(3);
    expect(counts['140']).toBe(0);
  });

  it('buildPreviewRow 与 computeGarmentRowMetricsSummary 支持按克重或按含补片利用率推荐最优门幅', () => {
    const preview = buildPreviewRow(fourPieceOptimized(), '优化排料');
    expect(preview.width).toBeGreaterThan(0);
    expect(preview.state).toContain('片');

    const rowsWithGsm = [
      { width: 1500, use: { length: 2000, utilization: 80, gramsPerGarment: 120 } },
      { width: 1650, use: { length: 1800, utilization: 85, gramsPerGarment: 105 } }
    ];
    const gsmSummary = computeGarmentRowMetricsSummary(rowsWithGsm);
    expect(gsmSummary.lowestRow?.width).toBe(1650);
    expect(gsmSummary.recommendedRow?.width).toBe(1650);

    const rowsWithoutGsm = [
      { width: 1500, use: { length: 2000, utilization: 79, utilizationWithFill: 86, fillCount: 2, gramsPerGarment: null } },
      { width: 1650, use: { length: 1800, utilization: 82, gramsPerGarment: null } }
    ];
    const utilSummary = computeGarmentRowMetricsSummary(rowsWithoutGsm);
    expect(utilSummary.lowestRow).toBeNull();
    expect(utilSummary.highestRow?.width).toBe(1500);
    expect(utilSummary.recommendedRow?.width).toBe(1500);

    const emptySummary = computeGarmentRowMetricsSummary([{ width: 1500, use: null }]);
    expect(emptySummary.recommendedRow).toBeNull();
  });

  it('buildTrialDetailNotes 准确拼装参考对比、SEED 缩短、掉头回退与限时提示', () => {
    const fixedRow = {
      width: 1600,
      halfTurn: false,
      direction: '固定方向',
      use: { length: 2000, utilization: 80, fillCount: 1, utilizationWithFill: 83 }
    };
    const halfTurnFallbackRow = {
      width: 1600,
      halfTurn: true,
      direction: '允许掉头',
      usedFixed: true,
      retryNote: '原起长复试回退',
      use: { length: 2000, utilization: 80, fillCount: 1, utilizationWithFill: 83 },
      trial: {
        job: { state: 'TIMED_OUT' },
        use: { length: 2100, utilization: 76, fillCount: 1, utilizationWithFill: 78 }
      },
      result: {
        layout: { placements: [{ rotationDegrees: 180 }, { rotationDegrees: 0 }] },
        marker: {
          gapFillPlacements: [{ rotationDegrees: 180 }],
          trials: [{ phase: 'SEED', occupiedLengthMm: 2250 }]
        }
      }
    };

    const notes = buildTrialDetailNotes(halfTurnFallbackRow, {
      halfTurn: true,
      gapFill: true,
      rows: [fixedRow, halfTurnFallbackRow],
      referencePreview: { use: { utilization: 78 } }
    });
    const joined = notes.join(' | ');
    expect(joined).toContain('较按图复排 +2 个百分点');
    expect(joined).toContain('较初排缩短 250 mm');
    expect(joined).toContain('沿用固定方向');
    expect(joined).toContain('掉头 2 片（含备片 1 片）');
    expect(joined).toContain('掉头试排限时结束');
    expect(joined).toContain('含补片较固定 0 个百分点');
  });

  it('buildStudio2DDemandsFromMarker 与 resolveGarmentMaterialMeta 保留旋转/几何与材质型号口径', () => {
    const demands = buildStudio2DDemandsFromMarker([
      {
        id: 'p1',
        name: '前片',
        quantity: 2,
        allowRotation: false,
        allowHalfTurn: true,
        shape: { type: 'POLYGON', width: 420, height: 680, vertices: [{ x: 0, y: 0 }] }
      }
    ]);
    expect(demands[0]).toMatchObject({
      id: 1,
      name: '前片',
      width: 420,
      length: 680,
      quantity: 2,
      allowRotation: false,
      allowHalfTurn: true
    });

    const metaDxf = resolveGarmentMaterialMeta('GARMENT_FOUR_PIECE', { width: 1780, direction: '优化' });
    expect(metaDxf.materialModel).toBe('面布');
    expect(metaDxf.externalRef).toContain('.dxf');

    const metaDefault = resolveGarmentMaterialMeta('GARMENT_SHIRT', { width: 1850, direction: '固定方向' });
    expect(metaDefault.materialModel).toBe('GARMENT-1850');
  });

  it('GarmentWidthFormSidebar SSR 渲染严格保留 #garment-* 表单 ID、name 与 help 属性', () => {
    const ex = resolveInitialExample(undefined);
    const html = renderToStaticMarkup(
      React.createElement(GarmentWidthFormSidebar, {
        helpRef: { current: null },
        sizeInputRefs: { current: {} },
        inputWidthsRef: { current: null },
        styleId: ex.style,
        currentExampleId: ex.id,
        isBusy: false,
        halfTurn: false,
        gapFill: true,
        orderedSizes: getOrderedSizes(ex.style),
        sizeCounts: buildSizeCounts(ex.style, ex),
        widthsText: ex.widths.join(', '),
        edgeMm: ex.edge,
        gsmText: ex.gsm != null ? String(ex.gsm) : '',
        isDxfStyleActive: Boolean(ex.source),
        onPillClick: () => {},
        onToggleHalfTurn: () => {},
        onToggleGapFill: () => {},
        onSelectExample: () => {},
        onChangeStyle: () => {},
        onChangeSizeCount: () => {},
        onChangeWidthsText: () => {},
        onChangeEdgeMm: () => {},
        onChangeGsmText: () => {},
        onSubmit: () => {}
      })
    );

    for (const token of [
      'id="garment-help"',
      'id="angle-help"',
      'id="fill-help"',
      'id="width-help"',
      'id="weight-help"',
      'id="garment-style-pills"',
      'id="garment-form"',
      'id="garment-half-turn"',
      'name="halfTurn"',
      'id="garment-gap-fill"',
      'name="gapFill"',
      'id="garment-example"',
      'name="example"',
      'id="garment-style"',
      'name="style"',
      'id="garment-sizes"',
      'id="garment-widths"',
      'name="widths"',
      'id="garment-edge"',
      'name="edge"',
      'id="garment-gsm"',
      'name="gsm"',
      'aria-label="试算条件帮助"'
    ]) {
      expect(html).toContain(token);
    }
  });
});
