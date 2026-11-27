import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  applyDirectionMode,
  buildImportIssuesCsvText,
  estimatePolygonArea,
  getDirectionMode
} from '../demandCreateTypes';
import { DemandCreatePage } from '../../DemandCreatePage';
import { DemandImportWizardModal } from '../DemandImportWizardModal';
import { DxfImportWizardModal } from '../../../components/DxfImportWizardModal';

describe('DemandCreatePage 拆解纯逻辑与导入向导 SSR 契约', () => {
  it('buildImportIssuesCsvText 对潜在公式注入转义且保留行号列名，estimatePolygonArea 准确计算', () => {
    const csv = buildImportIssuesCsvText([
      { sheetName: 'Sheet1', rowIndex: 3, column: '宽度', field: 'width', code: 'BAD_DIM', reason: '=HYPERLINK("x")' }
    ]);
    expect(csv).toContain('"Sheet1","3","宽度","width","BAD_DIM","\'=HYPERLINK(""x"")"');

    expect(
      estimatePolygonArea([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 0, y: 50 }
      ])
    ).toBe(5000);

    const base = { name: 'P', width: 100, length: 200, quantity: 1, allowRotation: false, allowHalfTurn: false };
    expect(getDirectionMode(base)).toBe('FIXED');
    expect(getDirectionMode(applyDirectionMode(base, 'HALF_180'))).toBe('HALF_180');
    expect(getDirectionMode(applyDirectionMode(base, 'ROTATE_90'))).toBe('ROTATE_90');
  });

  it('DemandCreatePage、DemandImportWizardModal 与 DxfImportWizardModal 保留全部关键选择器与 data-testid', () => {
    const pageHtml = renderToStaticMarkup(React.createElement(DemandCreatePage));
    expect(pageHtml).toContain('<h1>需求管理</h1>');
    expect(pageHtml).toContain('dc-dropzone');
    expect(pageHtml).toContain('id="dp-name"');
    expect(pageHtml).toContain('id="dc-w2d"');
    expect(pageHtml).toContain('id="dc-l2d"');
    expect(pageHtml).toContain('dc-width-chips');
    expect(pageHtml).toContain('1800mm');
    expect(pageHtml).toContain('dc-gallery-grid');
    expect(pageHtml).toContain('dc-piece-card');
    expect(pageHtml).toContain('data-testid="demand-import-wizard-btn"');
    expect(pageHtml).toContain('data-testid="demand-template-csv-btn"');
    expect(pageHtml).toContain('data-testid="demand-template-xlsx-btn"');
    expect(pageHtml).toContain('data-testid="demand-template-bom-xlsx-btn"');

    const wizardHtml = renderToStaticMarkup(
      React.createElement(DemandImportWizardModal, {
        open: true,
        onClose: () => {},
        onConfirmImport: () => {}
      })
    );
    expect(wizardHtml).toContain('data-testid="demand-import-modal"');
    expect(wizardHtml).toContain('data-testid="demand-import-file-input"');
    expect(wizardHtml).toContain('data-testid="demand-import-unit-select"');
    expect(wizardHtml).toContain('data-testid="demand-import-type-select"');
    expect(wizardHtml).toContain('data-testid="demand-import-confirm-btn"');

    const sampleDxf = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'OUTER', '70', '1',
      '10', '0', '20', '0', '10', '400', '20', '0', '10', '400', '20', '300', '10', '0', '20', '300',
      '0', 'LWPOLYLINE', '8', 'HOLE', '70', '1',
      '10', '100', '20', '100', '10', '200', '20', '100', '10', '200', '20', '200', '10', '100', '20', '200',
      '0', 'ENDSEC', '0', 'EOF'
    ].join('\n');

    const dxfHtml = renderToStaticMarkup(
      React.createElement(DxfImportWizardModal, {
        open: true,
        initialFileName: 'hole-test.dxf',
        initialBuffer: sampleDxf,
        onClose: () => {},
        onConfirm: () => {}
      })
    );
    expect(dxfHtml).toContain('data-testid="dxf-import-modal"');
    expect(dxfHtml).toContain('data-testid="dxf-unit-override-select"');
    expect(dxfHtml).toContain('data-testid="dxf-chord-tol-input"');
    expect(dxfHtml).toContain('data-testid="dxf-endpoint-tol-input"');
    expect(dxfHtml).toContain('data-testid="dxf-rotation-mode-select"');
    expect(dxfHtml).toContain('data-testid="dxf-pieces-preview"');
    expect(dxfHtml).toContain('data-testid="dxf-import-confirm-btn"');
    expect(dxfHtml).toContain('1 内孔');
  });
});
