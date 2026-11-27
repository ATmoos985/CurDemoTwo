import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  annotateBoardPiecesWithReinspection as reexportedAnnotate,
  computeTaskExecutionProjection as reexportedProjection
} from '../../CuttingWorkbenchPage';
import {
  annotateBoardPiecesWithReinspection,
  buildBoardCuts,
  buildBoardLeftovers,
  buildBoardPlacedPieces,
  buildBoardStagingDemands,
  computeBatchGuardWarning,
  computeEffectiveRollLengthMm,
  computeEffectiveRollTitle,
  computeEffectiveRollWidthMm,
  computeEffectiveWindowStartY,
  computeTaskExecutionProjection
} from '../workbenchProjectionUtils';
import {
  BatchGuardBanner,
  LocalDraftRecoveryBanner,
  TaskExecutionSyncBar
} from '../WorkbenchStatusBanners';
import { WorkbenchSwitchConfirmModal } from '../WorkbenchSwitchConfirmModal';
import type { DemandFamilySummary, SavedScheme2D } from '../../../store/studioTypes';

describe('CuttingWorkbenchPage 投影纯函数、防色差拦截与状态条校验', () => {
  it('CuttingWorkbenchPage 向后兼容 re-export 与 workbenchProjectionUtils 保持完全同源引用', () => {
    expect(reexportedProjection).toBe(computeTaskExecutionProjection);
    expect(reexportedAnnotate).toBe(annotateBoardPiecesWithReinspection);
  });

  const baseFamily: DemandFamilySummary = {
    id: 'TASK-1',
    name: '客厅主单',
    materialModel: 'TC-B1',
    dimension: 'RECT_2D',
    revision: 1,
    orderedTotal: 10,
    plannedTotal: 0,
    completedTotal: 0,
    openTotal: 10,
    schemeCount: 0,
    status: 'OPEN',
    requiredBatchNo: 'BAT-2026A',
    requiredColor: 'Navy',
    strictBatchMatch: true,
    lines: []
  };

  const passedRolls = [
    { rollId: 'R-MATCH', rollModel: 'TC-B1', batchNo: 'bat-2026a', color: 'navy', width: 2000 },
    { rollId: 'R-OTHER-BATCH', rollModel: 'TC-B1', batchNo: 'BAT-999', color: 'navy', width: 2000 },
    { rollId: 'R-NO-BATCH', rollModel: 'TC-B1', batchNo: '', color: 'navy', width: 2000 },
    { rollId: 'R-DIFF-COLOR', rollModel: 'TC-B1', batchNo: 'BAT-2026A', color: 'Red', width: 2000 }
  ];

  it('computeBatchGuardWarning 覆盖无约束放行、强约束拦截、弱约束预警、多料候选捕获与 1D 色号校验', () => {
    expect(
      computeBatchGuardWarning({
        activePoolFamily: { ...baseFamily, requiredBatchNo: '', requiredColor: '', strictBatchMatch: false },
        is2D: true,
        canvasMode: 'STOCK_ROLL',
        currentRoll2D: passedRolls[1],
        currentRemnant2D: null,
        multiCandidateRollIds: [],
        slitMaterialMode: 'STOCK_ROLL',
        currentRoll1D: null,
        passedRolls
      })
    ).toBeNull();

    // 匹配成功（忽略大小写）
    expect(
      computeBatchGuardWarning({
        activePoolFamily: baseFamily,
        is2D: true,
        canvasMode: 'STOCK_ROLL',
        currentRoll2D: passedRolls[0],
        currentRemnant2D: null,
        multiCandidateRollIds: [],
        slitMaterialMode: 'STOCK_ROLL',
        currentRoll1D: null,
        passedRolls
      })
    ).toBeNull();

    // 严格同缸模式下，未登记缸号或跨缸号均强阻断且推荐同缸卷 R-MATCH
    const noBatchWarn = computeBatchGuardWarning({
      activePoolFamily: baseFamily,
      is2D: true,
      canvasMode: 'STOCK_ROLL',
      currentRoll2D: passedRolls[2],
      currentRemnant2D: null,
      multiCandidateRollIds: [],
      slitMaterialMode: 'STOCK_ROLL',
      currentRoll1D: null,
      passedRolls
    });
    expect(noBatchWarn?.blocking).toBe(true);
    expect(noBatchWarn?.suggestedRoll?.rollId).toBe('R-MATCH');

    // 非严格模式返回预警不阻断
    const weakWarn = computeBatchGuardWarning({
      activePoolFamily: { ...baseFamily, strictBatchMatch: false },
      is2D: true,
      canvasMode: 'STOCK_ROLL',
      currentRoll2D: passedRolls[1],
      currentRemnant2D: null,
      multiCandidateRollIds: [],
      slitMaterialMode: 'STOCK_ROLL',
      currentRoll1D: null,
      passedRolls
    });
    expect(weakWarn?.blocking).toBe(false);
    expect(weakWarn?.title).toBe('跨缸号预警提示');

    // MULTI_MATERIAL 候选卷包含异缸卷时精准捕获
    const multiWarn = computeBatchGuardWarning({
      activePoolFamily: baseFamily,
      is2D: true,
      canvasMode: 'MULTI_MATERIAL',
      currentRoll2D: null,
      currentRemnant2D: null,
      multiCandidateRollIds: ['R-MATCH', 'R-OTHER-BATCH'],
      slitMaterialMode: 'STOCK_ROLL',
      currentRoll1D: null,
      passedRolls
    });
    expect(multiWarn?.blocking).toBe(true);
    expect(multiWarn?.detail).toContain('R-OTHER-BATCH');

    // 1D 色号差异拦截
    const slitColorWarn = computeBatchGuardWarning({
      activePoolFamily: baseFamily,
      is2D: false,
      canvasMode: 'STOCK_ROLL',
      currentRoll2D: null,
      currentRemnant2D: null,
      multiCandidateRollIds: [],
      slitMaterialMode: 'STOCK_ROLL',
      currentRoll1D: passedRolls[3],
      passedRolls
    });
    expect(slitColorWarn?.blocking).toBe(true);
    expect(slitColorWarn?.title).toBe('色号不匹配拦截');
  });

  it('有效窗口、幅宽、长度、标题与画布裁片/余料/刀路/待排需求投影精确计算', () => {
    expect(
      computeEffectiveWindowStartY({
        canvasMode: 'STOCK_ROLL',
        currentRoll2D: { usedLength: 1200, totalLength: 10000 },
        windowStartY2D: 500
      })
    ).toBe(1200);
    expect(
      computeEffectiveWindowStartY({
        canvasMode: 'STOCK_ROLL',
        currentRoll2D: { usedLength: 1200, totalLength: 10000 },
        windowStartY2D: 9995
      })
    ).toBe(9900);

    expect(
      computeEffectiveRollWidthMm({
        activeScheme2D: null,
        canvasMode: 'MULTI_MATERIAL',
        currentRoll2D: null,
        currentRemnant2D: null,
        multiCandidateRollOptions: [
          { rollId: 'A', width: 1650, eligible: false } as any,
          { rollId: 'B', width: 1850, eligible: true } as any
        ],
        canvasWidthMm: 2000
      })
    ).toBe(1850);

    const scheme: SavedScheme2D = {
      id: 'S1',
      title: '方案1',
      strategyName: '默认',
      createdAt: '',
      canvasMode: 'STOCK_ROLL',
      rollId: 'R-1',
      windowStartY: 1500,
      materialModel: 'TC',
      widthMm: 2000,
      canvasLengthMm: 3000,
      occupiedLengthMm: 3200,
      utilizationPct: 80,
      pieceAreaM2: 4,
      placedCount: 2,
      requestedCount: 3,
      complete: false,
      demands: [],
      request: {},
      result: {
        layout: {
          placements: [{ id: 1, demandId: 10, name: '主帘', x: 0, y: 0, w: 800, l: 1200 }],
          leftovers: [
            { id: 'L1', x: 800, y: 0, w: 400, l: 1200 },
            { id: 'L0', x: 0, y: 0, w: 0, l: 100 }
          ],
          cuts: [{ startX: 0, startY: 1200, endX: 2000, endY: 1200 }]
        },
        marker: {
          gapFillPlacements: [{ id: 'gf-1', demandId: 10, name: '补片', x: 800, y: 0, w: 400, l: 600 }]
        }
      }
    };

    expect(
      computeEffectiveRollLengthMm({
        activeScheme2D: scheme,
        canvasMode: 'STOCK_ROLL',
        currentRemnant2D: null,
        canvasLengthMm: 2500
      })
    ).toBe(3200);
    expect(
      computeEffectiveRollTitle({
        activeScheme2D: scheme,
        canvasMode: 'STOCK_ROLL',
        currentRoll2D: null,
        currentRemnant2D: null
      })
    ).toBe('实卷 R-1 (Y=1500mm)');

    const pieces = buildBoardPlacedPieces(scheme, {
      schemeId: 'S1',
      reportCount: 1,
      netQualifiedCount: 1,
      reinspectedCount: 1,
      rejectedTotalCount: 1,
      disposedPieces: new Map([
        [1, { pieceId: 1, disposition: 'SCRAP', dispositionLabel: '报废', reason: '破洞' }]
      ])
    });
    expect(pieces).toHaveLength(2);
    expect(pieces[0].name).toBe('[复检判废] 主帘');
    expect(pieces[1].gapFill).toBe(true);
    expect(pieces[1].index).toBe(1);

    const leftovers = buildBoardLeftovers(scheme);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0].id).toBe('L1');

    const cuts = buildBoardCuts(scheme);
    expect(cuts[0].sequence).toBe(1);

    const staging = buildBoardStagingDemands(
      [{ id: 10, name: '主帘', width: 800, length: 1200, quantity: 3, allowRotation: false }],
      scheme
    );
    expect(staging[0].remainingQty).toBe(2);
  });

  it('工作台状态横幅与确认弹窗 SSR 渲染保留关键语义属性与路径', () => {
    const syncHtml = renderToStaticMarkup(
      React.createElement(TaskExecutionSyncBar, {
        projection: {
          taskId: 'T1',
          reportCount: 2,
          netQualifiedCount: 5,
          rejectedTotalCount: 2,
          reinspectionDisposedTotal: 1,
          reinspectionScrapCount: 1,
          reinspectionRemnantCount: 0,
          reviewableCount: 4,
          openRemainingCount: 3,
          bySchemeId: new Map()
        },
        is2D: true,
        hasConfirmedActive2D: true,
        activeSchemeExecution: {
          schemeId: 'S1',
          reportCount: 1,
          netQualifiedCount: 3,
          reinspectedCount: 1,
          rejectedTotalCount: 1,
          disposedPieces: new Map([[1, { pieceId: 1, disposition: 'SCRAP', dispositionLabel: '报废', reason: '破洞' }]])
        }
      })
    );
    expect(syncHtml).toContain('role="status"');
    expect(syncHtml).toContain('aria-label="实绩与复检同步条"');
    expect(syncHtml).toContain('href="#/reconciliation"');

    const bannerHtml = renderToStaticMarkup(
      React.createElement(BatchGuardBanner, {
        warning: {
          blocking: true,
          title: '防色差同缸强约束拦截',
          detail: '缸号不一致',
          suggestedRoll: { rollId: 'R-MATCH', batchNo: 'B1' }
        },
        onSelectSuggestedRoll: () => {}
      })
    );
    expect(bannerHtml).toContain('role="alert"');
    expect(bannerHtml).toContain('R-MATCH');

    const draftHtml = renderToStaticMarkup(
      React.createElement(LocalDraftRecoveryBanner, {
        draft: { savedAt: Date.now(), activeDemands2D: [], unconfirmedSchemes2D: [] } as any,
        onRestore: () => {},
        onIgnore: () => {}
      })
    );
    expect(draftHtml).toContain('class="wb-draft-banner"');
    expect(draftHtml).toContain('恢复草稿');

    const modalHtml = renderToStaticMarkup(
      React.createElement(WorkbenchSwitchConfirmModal, {
        pendingConfirm: { title: '确认切料？', description: '将清空未确认方案', action: () => {} },
        onCancel: () => {},
        onConfirm: () => {}
      })
    );
    expect(modalHtml).toContain('<dialog');
    expect(modalHtml).toContain('确认切换');
  });
});
