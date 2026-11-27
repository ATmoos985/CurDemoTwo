import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sanitizeSchemeTitle, validateBatchZipSelection } from '../resultsSceneUtils';
import { ResultsCenterPage } from '../../ResultsCenterPage';
import { ResultsDetailPanel } from '../ResultsDetailPanel';
import { ResultsExportModals } from '../ResultsExportModals';
import { AuthSession } from '../../../utils/authClient';

describe('ResultsCenterPage 拆解与多格式导出弹窗 SSR 契约', () => {
  it('validateBatchZipSelection 强制 1..50 方案上限与至少 1 种格式', () => {
    expect(validateBatchZipSelection([], ['nc']).valid).toBe(false);
    expect(validateBatchZipSelection(['S1'], []).valid).toBe(false);
    const fiftyOne = Array.from({ length: 51 }, (_, i) => `S-${i}`);
    expect(validateBatchZipSelection(fiftyOne, ['nc']).valid).toBe(false);
    expect(validateBatchZipSelection(['S1', 'S2'], ['dxf_lwpolyline', 'ticket_pdf']).valid).toBe(true);
    expect(sanitizeSchemeTitle('OR-Tools 天际线 (FAST)')).toBe('天际线');
  });

  it('ResultsCenterPage、ResultsDetailPanel 与 ResultsExportModals 保留旧按钮并渲染全量 data-testid', () => {
    const pageHtml = renderToStaticMarkup(React.createElement(ResultsCenterPage));
    expect(pageHtml).toContain('<h1>结果管理</h1>');
    expect(pageHtml).toContain('data-testid="res-open-summary-export-modal-btn"');

    const detail2DHtml = renderToStaticMarkup(
      React.createElement(ResultsDetailPanel, {
        activeEntry: { canComplete: false, canBindRoll: true, canCancel: true },
        activeScheme: {
          id: 'SCH-1',
          title: '标准排料',
          state: 'AWAITING_ROLL',
          dimension: 'RECT_2D',
          materialModel: 'M1',
          widthMm: 1600,
          occupiedLengthMm: 2000,
          utilizationPct: 88.5,
          placedCount: 4,
          requestedCount: 4,
          taskName: '测试需求'
        },
        busy: false,
        canGenerateReplenish: false,
        schemeReversal: { showAction: false, eligible: false },
        taskOpenMap: {},
        createdReplenishTask: null,
        matchingPassedRolls: [],
        matchingPendingRolls: [],
        rolls: [],
        bindRollId: '',
        onSetBindRollId: () => {},
        newRollCode: '',
        onSetNewRollCode: () => {},
        pendingCreatedRollId: '',
        onOpenQuickComplete: () => {},
        onOpenCompleteModal: () => {},
        onDispatchMes: () => {},
        onOpenReplenishModal: () => {},
        onOpenReverseModal: () => {},
        onOpenCancelConfirm: () => {},
        onBindStockRoll: () => {},
        onExport2DCamLocal: () => {},
        onExportSlitLocalCsv: () => {},
        onExportExcelLocal: () => {},
        onOpenCamExportModal: () => {},
        slitExportFormat: 'xlsx',
        onSetSlitExportFormat: () => {},
        onDownloadSlittingServer: () => {},
        onDownloadTicketPdfServer: () => {},
        onOpenTicketModal: () => {},
        exportError: null,
        onDismissExportError: () => {},
        replayScene2D: null,
        vertical: true,
        onToggleVertical: () => {},
        showPath: true,
        onToggleShowPath: () => {},
        canvasRef: { current: null }
      })
    );
    expect(detail2DHtml).toContain('导出 CNC G-Code (.nc)');
    expect(detail2DHtml).toContain('打印 A4 车间派工裁切单');
    expect(detail2DHtml).toContain('data-testid="res-open-cam-export-modal-btn"');
    expect(detail2DHtml).toContain('data-testid="res-ticket-pdf-download-btn"');

    const agentAuth: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'agent-1',
      displayName: 'AI助手',
      role: 'PLANNER',
      roles: ['PLANNER'],
      actorType: 'AGENT',
      scopes: ['INVENTORY_READ']
    };
    const modalsHtml = renderToStaticMarkup(
      React.createElement(ResultsExportModals, {
        auth: agentAuth,
        activeScheme: { id: 'SCH-1' },
        camModalOpen: true,
        onCloseCamModal: () => {},
        batchZipModalOpen: true,
        onCloseBatchZipModal: () => {},
        checkedSchemeIds: ['SCH-1'],
        summaryModalOpen: true,
        onCloseSummaryModal: () => {}
      })
    );
    expect(modalsHtml).toContain('data-testid="res-cam-export-modal"');
    expect(modalsHtml).toContain('data-testid="res-cam-format-select"');
    expect(modalsHtml).toContain('data-testid="res-cam-export-submit-btn"');
    expect(modalsHtml).toContain('data-testid="res-batch-zip-modal"');
    expect(modalsHtml).toContain('data-testid="res-batch-zip-permission-alert"');
    expect(modalsHtml).toContain('data-testid="res-batch-zip-submit-btn"');
    expect(modalsHtml).toContain('data-testid="res-summary-export-modal"');
    expect(modalsHtml).toContain('data-testid="res-summary-format-select"');
    expect(modalsHtml).toContain('data-testid="res-summary-export-submit-btn"');
  });
});
