import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildProductGroups, idOf } from '../inventoryTypes';
import {
  filterDisplayedRemnants,
  filterDisplayedRolls,
  filterInventoryProducts,
  findScanTargets
} from '../inventoryActions';
import { InventoryPage } from '../../InventoryPage';
import { InventoryActionModal } from '../InventoryActionModal';
import { InventoryBatchImportTab } from '../InventoryBatchImportTab';
import { AuthSession } from '../../../utils/authClient';

describe('InventoryPage 拆解纯逻辑与批导 SSR 契约', () => {
  it('buildProductGroups 正确聚合同品号母卷与派生料头', () => {
    const rolls = [
      { rollId: 'R-1', rollModel: 'M-A', width: 2000, totalLength: 50000, usedLength: 10000, inspectionStatus: 'PASSED' },
      { rollId: 'R-2', rollModel: 'M-A', width: 2000, totalLength: 50000, usedLength: 0, inspectionStatus: 'PENDING' }
    ];
    const remnants = [
      { id: 'REM-1', sourceRollId: 'R-1', width: 1500, length: 4000, status: 'AVAILABLE' },
      { id: 'REM-2', sourceRollId: 'R-1', width: 1000, length: 2000, status: 'CONSUMED' }
    ];
    const groups = buildProductGroups(rolls, remnants);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      modelKey: 'M-A',
      passedRollCount: 1,
      totalRemainingM: 90,
      availableRemnantAreaM2: 6
    });
    expect(idOf(true, rolls[0])).toBe('roll:R-1');
    expect(idOf(false, remnants[0])).toBe('remnant:REM-1');
  });

  it('InventoryPage 与 InventoryActionModal 保留核心 DOM ID 与批导 Tab data-testid', () => {
    const pageHtml = renderToStaticMarkup(React.createElement(InventoryPage));
    expect(pageHtml).toContain('<h1>库存</h1>');
    expect(pageHtml).toContain('data-testid="inv-open-batch-import-btn"');
    expect(pageHtml).toContain('＋ 登记母卷');

    const singleModalHtml = renderToStaticMarkup(
      React.createElement(InventoryActionModal, {
        action: 'receive',
        receiveMode: 'single',
        onReceiveModeChange: () => {},
        busy: false,
        onClose: () => {},
        onSubmit: () => {},
        onSuccessRefresh: async () => {},
        productGroups: [],
        rolls: [],
        remnants: [],
        rollLookup: new Map(),
        opts: null,
        selectedMaterials: [],
        blockedMaterials: [],
        getCountRow: () => ({ present: true, width: '', length: '' }),
        updateCountRow: () => {},
        rollIdInput: '',
        setRollIdInput: () => {},
        rollModelInput: '',
        setRollModelInput: () => {},
        widthInput: '',
        setWidthInput: () => {},
        lengthInput: '',
        setLengthInput: () => {},
        batchNoInput: '',
        setBatchNoInput: () => {},
        colorInput: '',
        setColorInput: () => {},
        shrinkageInput: '',
        setShrinkageInput: () => {},
        locationInput: '',
        setLocationInput: () => {},
        editRollTarget: null,
        releaseRemnantId: '',
        releaseDecision: 'RELEASE_AVAILABLE',
        setReleaseDecision: () => {},
        releaseInspector: '',
        setReleaseInspector: () => {},
        scrapRollId: '',
        scrapId: '',
        destination: '',
        setDestination: () => {},
        reason: '',
        setReason: () => {},
        operator: '',
        setOperator: () => {}
      })
    );
    expect(singleModalHtml).toContain('id="inv-rec-rollid"');
    expect(singleModalHtml).toContain('id="inv-rec-model"');
    expect(singleModalHtml).toContain('id="inv-rec-width"');
    expect(singleModalHtml).toContain('id="inv-rec-len"');
    expect(singleModalHtml).toContain('id="act-submit"');
    expect(singleModalHtml).toContain('data-testid="inv-receive-mode-tabs"');
    expect(singleModalHtml).toContain('data-testid="inv-receive-tab-single"');
    expect(singleModalHtml).toContain('data-testid="inv-receive-tab-batch-rolls"');
    expect(singleModalHtml).toContain('data-testid="inv-receive-tab-batch-remnants"');

    const plannerAuth: AuthSession = {
      enabled: true,
      authenticated: true,
      username: 'planner1',
      displayName: '计划员',
      role: 'PLANNER',
      roles: ['PLANNER'],
      actorType: 'USER'
    };
    const batchHtml = renderToStaticMarkup(
      React.createElement(InventoryBatchImportTab, {
        kind: 'rolls',
        auth: plannerAuth,
        onSuccessRefresh: async () => {},
        onClose: () => {}
      })
    );
    expect(batchHtml).toContain('data-testid="inv-import-permission-alert"');
    expect(batchHtml).toContain('data-testid="inv-import-template-xlsx-btn"');
    expect(batchHtml).toContain('data-testid="inv-import-template-csv-btn"');
    expect(batchHtml).toContain('data-testid="inv-import-file-input"');
    expect(batchHtml).toContain('data-testid="inv-import-idempotency-key"');
    expect(batchHtml).toContain('data-testid="inv-import-preview-btn"');
    expect(batchHtml).toContain('data-testid="inv-import-commit-btn"');
  });

  it('filterInventoryProducts / filterDisplayedRolls / filterDisplayedRemnants / findScanTargets 纯逻辑筛选准确', () => {
    const rolls = [
      { rollId: 'R-PASS', rollModel: 'M-1', width: 1800, totalLength: 40000, usedLength: 0, inspectionStatus: 'PASSED', batchNo: 'B1' },
      { rollId: 'R-PEND', rollModel: 'M-1', width: 1800, totalLength: 40000, usedLength: 0, inspectionStatus: 'PENDING', batchNo: 'B2' }
    ];
    const remnants = [
      { id: 'RM-AV', sourceRollId: 'R-PASS', width: 1200, length: 3000, status: 'AVAILABLE' },
      { id: 'RM-Q', sourceRollId: 'R-PASS', width: 900, length: 2000, status: 'QUARANTINED' },
      { id: 'RM-L', sourceRollId: 'R-PEND', width: 800, length: 1500, status: 'LOST' }
    ];
    const groups = buildProductGroups(rolls, remnants);
    expect(filterInventoryProducts(groups, 'R-PEND', 'ROLLS', 'ALL')).toHaveLength(1);
    expect(filterDisplayedRolls(groups[0], 'READY', '', true).map((r) => r.rollId)).toEqual(['R-PASS']);
    const rollLookup = new Map(rolls.map((r) => [r.rollId, r]));
    expect(
      filterDisplayedRemnants(groups[0], '', 'ALL', '', true, false, rollLookup).map((rm) => rm.id)
    ).toEqual(['RM-AV', 'RM-Q']);
    expect(
      filterDisplayedRemnants(groups[0], '', 'ALL', '', true, true, rollLookup).map((rm) => rm.id)
    ).toEqual(['RM-AV', 'RM-Q', 'RM-L']);
    const hit = findScanTargets(rolls, remnants, 'RM-Q');
    expect(hit.hitRoll).toBeNull();
    expect(hit.hitRem?.id).toBe('RM-Q');
  });
});
