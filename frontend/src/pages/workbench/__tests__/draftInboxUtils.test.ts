import { describe, expect, it } from 'vitest';
import {
  buildDraftDeeplinkHash,
  formatDraftMaterialType,
  getDraftStatusMeta,
  groupDraftsByBatch,
  type WorkbenchDraftDto
} from '../draftInboxApi';
import { mapResultContextToWorkbenchPlan, type WorkbenchResultContextDto } from '../workbenchDeeplinkUtils';

function makeDraft(overrides: Partial<WorkbenchDraftDto> & { draftId: string }): WorkbenchDraftDto {
  return {
    id: overrides.draftId,
    draftId: overrides.draftId,
    status: overrides.status ?? 'PENDING_CONFIRMATION',
    issuedAt: overrides.issuedAt ?? '2026-11-27T02:00:00Z',
    expiresAt: overrides.expiresAt ?? '2099-11-27T02:30:00Z',
    stale: overrides.stale ?? false,
    staleReasons: overrides.staleReasons ?? [],
    target: overrides.target ?? {
      resultId: `RES-${overrides.draftId}`,
      taskId: 'TASK-01',
      materialId: 'ROLL-01',
      materialType: 'STOCK_ROLL'
    },
    riskChecks: overrides.riskChecks ?? [],
    batchGroupId: overrides.batchGroupId ?? null,
    batchIndex: overrides.batchIndex ?? null,
    batchTotal: overrides.batchTotal ?? null,
    confirmedSchemeId: overrides.confirmedSchemeId ?? null,
    discardReason: overrides.discardReason ?? null
  };
}

describe('draftInboxApi 与工作台草案收件箱协同工具', () => {
  it('groupDraftsByBatch 正确按 batchGroupId 聚合排序并保留单条独立草案', () => {
    const items: WorkbenchDraftDto[] = [
      makeDraft({
        draftId: 'DFT-ROLL-2',
        batchGroupId: 'MMB-100',
        batchIndex: 2,
        batchTotal: 2,
        issuedAt: '2026-11-27T03:00:00Z',
        target: { resultId: 'R2', taskId: 'T1', materialId: 'ROLL-2', materialType: 'STOCK_ROLL' }
      }),
      makeDraft({
        draftId: 'DFT-SINGLE-OLD',
        issuedAt: '2026-11-27T01:00:00Z'
      }),
      makeDraft({
        draftId: 'DFT-REM-1',
        batchGroupId: 'MMB-100',
        batchIndex: 1,
        batchTotal: 2,
        issuedAt: '2026-11-27T03:00:00Z',
        status: 'CONFIRMED',
        confirmedSchemeId: 'SCH-9',
        target: { resultId: 'R1', taskId: 'T1', materialId: 'REM-1', materialType: 'REMNANT' }
      })
    ];

    const groups = groupDraftsByBatch(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].isBatchGroup).toBe(true);
    expect(groups[0].batchGroupId).toBe('MMB-100');
    expect(groups[0].drafts.map((d) => d.draftId)).toEqual(['DFT-REM-1', 'DFT-ROLL-2']);
    expect(groups[0].remnantCount).toBe(1);
    expect(groups[0].rollCount).toBe(1);
    expect(groups[0].confirmedCount).toBe(1);
    expect(groups[0].pendingCount).toBe(1);

    expect(groups[1].isBatchGroup).toBe(false);
    expect(groups[1].drafts[0].draftId).toBe('DFT-SINGLE-OLD');
  });

  it('getDraftStatusMeta 与 formatDraftMaterialType 输出色彩+文字双保险标签', () => {
    expect(getDraftStatusMeta('PENDING_CONFIRMATION', false)).toEqual({ label: '待确认', tagClass: 'run' });
    expect(getDraftStatusMeta('PENDING_CONFIRMATION', true)).toEqual({ label: '版本漂移', tagClass: 'err' });
    expect(getDraftStatusMeta('CONFIRMED', true)).toEqual({ label: '已确认', tagClass: 'ok' });
    expect(getDraftStatusMeta('DISCARDED', false)).toEqual({ label: '已作废', tagClass: 'err' });
    expect(getDraftStatusMeta('EXPIRED', false)).toEqual({ label: '已过期', tagClass: 'warn' });

    expect(formatDraftMaterialType('REMNANT')).toBe('料头');
    expect(formatDraftMaterialType('STOCK_ROLL')).toBe('实卷');
    expect(formatDraftMaterialType('FREE_CANVAS')).toBe('自由画布');
  });

  it('buildDraftDeeplinkHash 正确编码参数生成工作台深链', () => {
    const hash = buildDraftDeeplinkHash(
      makeDraft({
        draftId: 'DFT-A+1',
        target: { resultId: 'RES/9', taskId: 'TASK 1', materialId: 'R1', materialType: 'STOCK_ROLL' }
      })
    );
    expect(hash).toBe('#/workbench?taskId=TASK+1&resultId=RES%2F9&draftId=DFT-A%2B1');
  });

  it('mapResultContextToWorkbenchPlan 正确透传 draftId、batchGroupId、已确认/已作废终态而不被时钟覆盖为过期', () => {
    const context: WorkbenchResultContextDto = {
      resultId: 'RES-FIN-1',
      job: { id: 'RES-FIN-1', state: 'SUCCEEDED', elapsedMs: 50 },
      source: {
        taskId: 'TASK-1',
        materialType: 'STOCK_ROLL',
        materialId: 'ROLL-1',
        widthMm: 1600,
        windowLengthMm: 2000,
        rectGapPaddingMm: 0
      },
      input: {
        schemaVersion: '2.0',
        problemType: 'NESTING_2D',
        problem: {
          schemaVersion: '1',
          unit: 'mm',
          material: { id: 'ROLL-1', shape: { type: 'RECTANGLE', width: 1600, height: 2000 }, exclusions: [] },
          parts: [{ id: 1, name: '门板', quantity: 1, allowRotation: true, shape: { type: 'RECTANGLE', width: 500, height: 600 } }],
          process: { mode: 'GUILLOTINE', trimStart: 0, pieceGap: 0 }
        }
      },
      result: {
        id: 'RES-FIN-1',
        fulfillmentStatus: 'COMPLETE',
        layout: {
          status: 'FEASIBLE',
          processingRegion: { type: 'RECTANGLE', width: 1600, height: 2000 },
          placements: [{ id: 1, demandId: 1, name: '门板', x: 0, y: 0, rotationDegrees: 0, shape: { type: 'RECTANGLE', width: 500, height: 600 } }],
          leftovers: []
        }
      }
    };

    const mapped = mapResultContextToWorkbenchPlan(
      context,
      {
        draftId: 'DFT-DISCARDED-1',
        status: 'DISCARDED',
        expiresAt: '2020-01-01T00:00:00Z',
        stale: true,
        staleReasons: ['不应保留漂移'],
        batchGroupId: 'MMB-999',
        batchIndex: 1,
        batchTotal: 3,
        discardReason: '现场改用料头'
      },
      null,
      { nowMs: Date.parse('2026-11-27T04:00:00Z') }
    );

    expect(mapped.scheme2D?.draftId).toBe('DFT-DISCARDED-1');
    expect(mapped.scheme2D?.draftBatchGroupId).toBe('MMB-999');
    expect(mapped.banner.status).toBe('DISCARDED');
    expect(mapped.banner.expired).toBe(false);
    expect(mapped.banner.stale).toBe(false);
    expect(mapped.banner.batchGroupId).toBe('MMB-999');
    expect(mapped.banner.discardReason).toBe('现场改用料头');
  });
});
