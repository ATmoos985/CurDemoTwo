import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  checkDefect01MmPrecision,
  computeRollStats,
  withoutSubmitted
} from '../inspectionTypes';
import { InspectionPage } from '../../InspectionPage';
import { InspectionCanvasWorkspace } from '../InspectionCanvasWorkspace';
import { InspectionBatchDefectModal } from '../InspectionBatchDefectModal';
import { AuthSession } from '../../../utils/authClient';

describe('InspectionPage 拆解纯逻辑与瑕疵批导 SSR 契约', () => {
  it('checkDefect01MmPrecision 与 computeRollStats 口径正确', () => {
    expect(checkDefect01MmPrecision({ x: 10.5, y: 20.0, w: 30.1, h: 40.2, margin: 5.0 })).toEqual([]);
    expect(checkDefect01MmPrecision({ x: 10.25, y: 20.0, w: 30.001, h: 40.0 })).toEqual(['x', 'w']);

    const stats = computeRollStats([
      { rollId: 'R1', totalLength: 50000, usedLength: 10000, inspectionStatus: 'PENDING', defectsCount: 2 },
      { rollId: 'R2', totalLength: 40000, usedLength: 0, inspectionStatus: 'PASSED', defectsCount: 0 },
      { rollId: 'R3', totalLength: 30000, usedLength: 0, inspectionStatus: 'FAILED', defectsCount: 1 }
    ]);
    expect(stats).toEqual({
      pending: 1,
      pendingLength: 40000,
      passed: 1,
      blocked: 1,
      defects: 3,
      withDefects: 2
    });

    expect(
      withoutSubmitted(
        [{ captureId: 'c1', x: 1 }, { captureId: 'c2', x: 2 }],
        [{ captureId: 'c1', x: 1 }]
      )
    ).toEqual([{ captureId: 'c2', x: 2 }]);
  });

  it('InspectionPage、InspectionCanvasWorkspace 与 InspectionBatchDefectModal 保留全部核心 ID 与 data-testid', () => {
    const pageHtml = renderToStaticMarkup(React.createElement(InspectionPage));
    expect(pageHtml).toContain('<h1>跑布验疵</h1>');
    expect(pageHtml).toContain('id="roll"');
    expect(pageHtml).toContain('id="save"');
    expect(pageHtml).toContain('data-testid="insp-open-batch-defects-btn"');

    const wsHtml = renderToStaticMarkup(
      React.createElement(InspectionCanvasWorkspace, {
        roll: { rollId: 'R-1', width: 2000, totalLength: 50000, usedLength: 0, defects: [] },
        pending: [],
        allDefects: [],
        historyLength: 0,
        pos: 0,
        posInputText: '0.000',
        onSetPosInputText: () => {},
        onUpdatePos: () => {},
        step: 1,
        onSetStep: () => {},
        speed: 3,
        onSetSpeed: () => {},
        running: false,
        onToggleRunning: () => {},
        tool: 'mark',
        onSetTool: () => {},
        overview: false,
        onSetFollowMode: () => {},
        onSetOverviewMode: () => {},
        panelCollapsed: false,
        onTogglePanelCollapsed: () => {},
        saving: false,
        pointerText: '0,0',
        sel: null,
        onSelectIndex: () => {},
        selectedDefect: null,
        editable: false,
        inCutArea: false,
        voidReason: '',
        onSetVoidReason: () => {},
        onVoidDefect: () => {},
        fRight: 0,
        setFRight: () => {},
        fY: 0,
        setFY: () => {},
        fW: 50,
        setFW: () => {},
        fH: 50,
        setFH: () => {},
        fType: 'STAIN',
        setFType: () => {},
        fMargin: 20,
        setFMargin: () => {},
        onUndo: () => {},
        onRemoveSelected: () => {},
        onApplyManualDefect: () => {},
        onJumpToDefectRow: () => {},
        canvasRef: { current: null },
        inspectionDefects: [],
        inspectionZones: [],
        emptyDemands: [],
        emptyPlaced: [],
        selectedDefectKey: null,
        onCanvasInteract: () => {},
        onCanvasCursor: () => {},
        onCanvasDefectSelect: () => {},
        onCanvasDefectDraw: () => {},
        onCanvasDefectEdit: () => {}
      })
    );
    ['#pos', '#locate', '#step', '#advance', '#speed', '#run', '#vtrack', '#follow', '#overview', '#undo', '#toggle-panel', '#pointer-position', '#isvg', '#editor', '#apply'].forEach((selId) => {
      expect(wsHtml).toContain(`id="${selId.slice(1)}"`);
    });
    ['right', 'y', 'w', 'h', 'type', 'margin'].forEach((f) => {
      expect(wsHtml).toContain(`data-f="${f}"`);
    });

    const warehouseAuth: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'wh1',
      displayName: '仓管',
      role: 'WAREHOUSE',
      roles: ['WAREHOUSE'],
      actorType: 'USER'
    };
    const modalHtml = renderToStaticMarkup(
      React.createElement(InspectionBatchDefectModal, {
        open: true,
        defaultRollId: 'R-1',
        auth: warehouseAuth,
        onClose: () => {},
        onSuccessRefresh: async () => {}
      })
    );
    expect(modalHtml).toContain('data-testid="insp-batch-defects-modal"');
    expect(modalHtml).toContain('data-testid="insp-import-permission-alert"');
    expect(modalHtml).toContain('data-testid="insp-import-template-xlsx-btn"');
    expect(modalHtml).toContain('data-testid="insp-import-template-csv-btn"');
    expect(modalHtml).toContain('data-testid="insp-import-file-input"');
    expect(modalHtml).toContain('data-testid="insp-import-idempotency-key"');
    expect(modalHtml).toContain('data-testid="insp-import-preview-btn"');
    expect(modalHtml).toContain('data-testid="insp-import-commit-btn"');
  });
});
