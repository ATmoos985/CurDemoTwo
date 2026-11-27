import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ShowcasePage,
  applySlitDraftToRequest,
  buildSlitDraftFromRequest,
  buildSlittingCompareRows,
  evaluateCaseResult,
  getCaseMeta,
  matchesShowcaseCase,
  summarizeCaseInput,
  validateShowcaseSlitDraft
} from '../../ShowcasePage';
import { CaseThumbSvg } from '../ShowcaseThumbnails';
import { ShowcaseDetailPanel } from '../ShowcaseDetailPanel';
import { SHOWCASE_CASES, showcaseRequest } from '../../../lib/model/showcase.js';
import type { ThumbKind } from '../showcaseCaseMeta';

describe('ShowcasePage 1D 分切草稿与参数校验', () => {
  it('buildSlitDraftFromRequest 识别 FIXED/FLEXIBLE 且在 Node 无 localStorage 时安全兜底', () => {
    const fixedDraft = buildSlitDraftFromRequest({
      problem: {
        motherWidthMm: 4500,
        leftTrimMm: 50,
        rightTrimMm: 50,
        minWidthMm: 4200,
        maxWidthMm: 4200,
        widthStepMm: 20,
        totalOverCap: 0,
        timeLimitSeconds: 45
      }
    });
    expect(fixedDraft.widthMode).toBe('FIXED');
    expect(fixedDraft.motherWidthMm).toBe(4500);
    expect(fixedDraft.leftTrimMm).toBe(50);
    expect(fixedDraft.totalOverCap).toBe(0);
    expect(fixedDraft.timeLimitSeconds).toBe(45);

    const flexDraft = buildSlitDraftFromRequest({
      problem: {
        minWidthMm: 4100,
        maxWidthMm: 4400
      }
    });
    expect(flexDraft.widthMode).toBe('FLEXIBLE');
    expect(flexDraft.minWidthMm).toBe(4100);
    expect(flexDraft.maxWidthMm).toBe(4400);
  });

  it('applySlitDraftToRequest 对 FIXED 幅宽、QUALITY 时限提升与高级参数上下限做精确钳制', () => {
    const baseLarge = {
      problemType: 'SLITTING_1D',
      problem: {
        orders: Array.from({ length: 42 }, (_, idx) => ({
          id: `O-${idx}`,
          widthMm: 1000,
          lengthMm: 1350,
          quantity: 10
        }))
      }
    };
    const draft = buildSlitDraftFromRequest(baseLarge);
    const applied = applySlitDraftToRequest(
      baseLarge,
      {
        ...draft,
        widthMode: 'FIXED',
        motherWidthMm: 4600,
        leftTrimMm: 100,
        rightTrimMm: 100,
        minWidthMm: 3800,
        maxWidthMm: 4500, // 超过 usable 4400，应被钳制为 4400
        timeLimitSeconds: 20,
        topK: 99,
        maxIterations: 99999,
        maxPatterns: 99999,
        maxDistinctWidths: 99,
        stageTimeLimitMs: 100
      },
      'QUALITY'
    );

    expect(applied.problem.maxWidthMm).toBe(4400);
    expect(applied.problem.minWidthMm).toBe(4400);
    expect(applied.problem.timeLimitSeconds).toBe(180);
    expect(applied.problem.topK).toBe(50);
    expect(applied.problem.maxIterations).toBe(5000);
    expect(applied.problem.maxPatterns).toBe(20000);
    expect(applied.problem.maxDistinctWidths).toBe(20);
    expect(applied.problem.stageTimeLimitMs).toBe(1000);

    const smallQuality = applySlitDraftToRequest(
      { problem: { orders: [{ id: '1', widthMm: 900, lengthMm: 1000, quantity: 5 }] } },
      { ...draft, timeLimitSeconds: 15 },
      'QUALITY'
    );
    expect(smallQuality.problem.timeLimitSeconds).toBe(60);
  });

  it('validateShowcaseSlitDraft 拦截无效可切宽区间与超宽订单', () => {
    const baseDraft = buildSlitDraftFromRequest({});
    expect(
      validateShowcaseSlitDraft(
        { ...baseDraft, motherWidthMm: 200, leftTrimMm: 120, rightTrimMm: 100 },
        []
      )
    ).toContain('可切幅宽须大于 0');

    expect(
      validateShowcaseSlitDraft(
        { ...baseDraft, widthMode: 'FLEXIBLE', motherWidthMm: 4600, minWidthMm: 4300, maxWidthMm: 4100 },
        []
      )
    ).toContain('最小组合宽');

    expect(
      validateShowcaseSlitDraft(
        { ...baseDraft, widthMode: 'FIXED', motherWidthMm: 4600, leftTrimMm: 100, rightTrimMm: 100, maxWidthMm: 1200 },
        [{ widthMm: 1350 }]
      )
    ).toContain('1350 mm');

    expect(
      validateShowcaseSlitDraft(
        { ...baseDraft, widthMode: 'FIXED', motherWidthMm: 4600, leftTrimMm: 100, rightTrimMm: 100, maxWidthMm: 4400 },
        [{ widthMm: 1480 }]
      )
    ).toBeNull();
  });
});

describe('ShowcasePage 元数据、算例评估与对比表', () => {
  it('getCaseMeta 精确返回已知算例阈值与未知算例分类兜底', () => {
    const guil = getCaseMeta({ id: 'GUILLOTINE' });
    expect(guil.minUtilization).toBe(80);
    expect(guil.smoke).toBe(true);

    const rotOff = getCaseMeta({ id: 'rotation-off' });
    expect(rotOff.expectUnplaced).toBe(true);

    const unknownSlit = getCaseMeta({ id: 'unknown-s', kind: 'slitting', group: '卷材 · 薄膜', name: '新膜', note: '说明' });
    expect(unknownSlit.capGroup).toBe('1d-slitting');
    expect(unknownSlit.thumb).toBe('slitting');

    const unknownMarker = getCaseMeta({ id: 'unknown-m', kind: 'marker', group: '服装齐套', name: '新款式', note: '说明' });
    expect(unknownMarker.capGroup).toBe('2d-marker');
  });

  it('summarizeCaseInput 覆盖 1D、2D 异形与无效 ID 降级', () => {
    const filmCase = SHOWCASE_CASES.find((c: any) => c.id === 'film');
    expect(filmCase).toBeDefined();
    const filmSum = summarizeCaseInput(filmCase);
    expect(filmSum.engineBadge).toBe('1D 分切');
    expect(filmSum.specText).toContain('幅宽');

    const contourCase = SHOWCASE_CASES.find((c: any) => c.id === 'CONTOUR');
    expect(contourCase).toBeDefined();
    const contourSum = summarizeCaseInput(contourCase);
    expect(contourSum.engineBadge).toBe('2D 异形');

    const fallback = summarizeCaseInput({ id: '__nonexistent__', kind: 'marker' });
    expect(fallback.specText).toBe('标准规格');
    expect(fallback.engineBadge).toBe('齐套缩短');
  });

  it('evaluateCaseResult 校验 rotation-off 预期阻断、1D 齐套与 2D 指标优先级', () => {
    const rotOffCase = SHOWCASE_CASES.find((c: any) => c.id === 'rotation-off');
    const passBlocked = evaluateCaseResult(
      rotOffCase,
      {},
      { fulfillmentStatus: 'INCOMPLETE', layout: { placements: [] }, metrics: [] },
      12
    );
    expect(passBlocked.pass).toBe(true);
    expect(passBlocked.badgeText).toBe('✓ 符合预期未排');

    const failPlaced = evaluateCaseResult(
      rotOffCase,
      {},
      { fulfillmentStatus: 'COMPLETE', layout: { placements: [{ id: 1 }] }, metrics: [] },
      12
    );
    expect(failPlaced.pass).toBe(false);

    const slitPass = evaluateCaseResult(
      { id: 'film', kind: 'slitting' },
      {},
      {
        fulfillmentStatus: 'COMPLETE',
        slitting: { patterns: [{ repetitions: 3 }, { repetitions: 2 }] },
        metrics: [{ name: 'usableAreaUtilization', value: 94.5 }]
      },
      25
    );
    expect(slitPass.pass).toBe(true);
    expect(slitPass.badgeText).toContain('5 车');

    const guilCase = SHOWCASE_CASES.find((c: any) => c.id === 'GUILLOTINE');
    const guilPass = evaluateCaseResult(
      guilCase,
      {},
      {
        fulfillmentStatus: 'COMPLETE',
        layout: { placements: [{ id: 1 }] },
        metrics: [
          { name: 'usableAreaUtilization', value: 70 },
          { name: 'processingAreaUtilization', value: 82.5 },
          { name: 'markerAreaUtilization', value: 84.0 }
        ]
      },
      18
    );
    expect(guilPass.pass).toBe(true);
    expect(guilPass.utilizationValue).toBe(84);

    const guilLow = evaluateCaseResult(
      guilCase,
      {},
      {
        fulfillmentStatus: 'COMPLETE',
        layout: { placements: [{ id: 1 }] },
        metrics: [{ name: 'processingAreaUtilization', value: 75.0 }]
      },
      18
    );
    expect(guilLow.pass).toBe(false);
  });

  it('matchesShowcaseCase 与 buildSlittingCompareRows 准确筛选并构造对比表', () => {
    const filmCase = SHOWCASE_CASES.find((c: any) => c.id === 'film');
    expect(
      matchesShowcaseCase(filmCase, {
        mainTab: 'lab',
        capFilter: '1d-slitting',
        scenarioFilter: 'all',
        activeGroup: 'all',
        searchQuery: ''
      })
    ).toBe(true);
    expect(
      matchesShowcaseCase(filmCase, {
        mainTab: 'lab',
        capFilter: 'boundary',
        scenarioFilter: 'all',
        activeGroup: 'all',
        searchQuery: ''
      })
    ).toBe(false);

    const filmReq = showcaseRequest('film');
    const rows = buildSlittingCompareRows(filmReq.problem, {
      FAST: {
        slitting: {
          patterns: [{ repetitions: 4 }],
          fulfillment: [{ missing: 0 }],
          totalOverproduced: 1
        }
      },
      QUALITY: {
        slitting: {
          patterns: [{ repetitions: 3 }],
          fulfillment: [{ missing: 0 }],
          totalOverproduced: 0
        }
      }
    });
    expect(rows[0][0]).toBe('逐规格独立分切');
    expect(rows[1]).toEqual(['快速搭切', 4, 0, 1]);
    expect(rows[2]).toEqual(['精细优化', 3, 0, 0]);
  });

  it('ShowcaseThumbnails & ShowcasePage & ShowcaseDetailPanel SSR 渲染保留关键 DOM ID', () => {
    const thumbs: ThumbKind[] = [
      'crosscut', 'defect', 'remnant', 'guillotine', 'window', 'contour',
      'marker', 'grain-lock', 'grain-free', 'slitting', 'block', 'rotate-ok', 'gap'
    ];
    for (const kind of thumbs) {
      const svgHtml = renderToStaticMarkup(React.createElement(CaseThumbSvg, { kind }));
      expect(svgHtml).toContain('class="mp-case-thumb"');
      expect(svgHtml).toContain('aria-hidden="true"');
    }

    const overviewHtml = renderToStaticMarkup(React.createElement(ShowcasePage, {}));
    expect(overviewHtml).toContain('id="case-search"');
    expect(overviewHtml).toContain('id="case-tabs"');
    expect(overviewHtml).toContain('id="case-catalogue"');

    const filmCase = SHOWCASE_CASES.find((c: any) => c.id === 'film');
    const filmReq = showcaseRequest('film');
    const detailHtml = renderToStaticMarkup(
      React.createElement(ShowcaseDetailPanel, {
        selected: filmCase,
        request: filmReq,
        result: null,
        errorText: null,
        cancelledHint: false,
        busy: false,
        stateText: '待计算',
        patternIndex: 0,
        onChangePatternIndex: () => {},
        vertical: true,
        onToggleVertical: () => {},
        showPath: false,
        onToggleShowPath: () => {},
        selectionText: '提示',
        detailTab: 'data',
        onChangeDetailTab: () => {},
        activeScene: null,
        canvasRef: { current: null },
        onContextInspect: () => {},
        slitRuns: {},
        slitDraft: buildSlitDraftFromRequest(filmReq),
        onPatchSlitDraft: () => {},
        onResetSlitDraft: () => {},
        caseInputSummaries: { [filmCase.id]: summarizeCaseInput(filmCase) },
        verifications: {},
        onDownloadJson: () => {},
        onCancel: () => {},
        onRun: () => {}
      })
    );
    for (const id of [
      'id="demo-case-select"',
      'id="demo-fit"',
      'id="demo-rotate"',
      'id="demo-path"',
      'id="demo-canvas"',
      'id="demo-selection"',
      'id="demo-result"',
      'id="demo-slit-params"',
      'id="demo-input"',
      'id="demo-state"',
      'id="demo-input-export"',
      'id="demo-result-export"',
      'id="demo-cancel"',
      'id="demo-run"',
      'id="demo-quality"'
    ]) {
      expect(detailHtml).toContain(id);
    }
  });
});
