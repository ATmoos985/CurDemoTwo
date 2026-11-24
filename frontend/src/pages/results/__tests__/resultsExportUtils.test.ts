import { describe, expect, it } from 'vitest';
import { dxfText } from '@static/js/plugins/export/cam-format.js';
import {
  buildSlittingCsvText,
  extractWindowDefects,
  matchScannedScheme
} from '../cutTicketUtils';
import {
  buildLedgerCsvText,
  isDispositionRevoked,
  normalizeReconciliationReportItem,
  readDispositionFields
} from '../reconciliationUtils';

describe('结果中心与对账导出、疵点透传、扫码定位及聚合报工适配', () => {
  it('extractWindowDefects 透传窗口内实卷疵点并正确输出 DXF 3_DEFECTS 图层', () => {
    const scheme = {
      id: 'SCH-DEF-01',
      widthMm: 1800,
      occupiedLengthMm: 2500,
      windowStartY: 1200,
      layout2D: {
        placements: [{ id: 1, name: '前片', x: 0, y: 0, w: 600, l: 900 }],
        cuts: []
      }
    };
    const boundRoll = {
      rollId: 'ROLL-DEF-01',
      defects: [
        { id: 10, x: 200, y: 1800, w: 70, h: 50, margin: 15, typeName: '破洞' }, // 窗口内 -> 局部 y=600
        { id: 11, x: 400, y: 500, w: 40, h: 40, margin: 10, typeName: '断经' } // 窗口前 -> 过滤
      ]
    };

    const defects = extractWindowDefects(scheme, boundRoll);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({ id: 10, x: 200, y: 600, w: 70, h: 50, margin: 15, desc: '破洞' });

    const dxf = dxfText({
      rollId: boundRoll.rollId,
      rollW: scheme.widthMm,
      bedL: scheme.occupiedLengthMm,
      windowStartY: scheme.windowStartY,
      pieces: scheme.layout2D.placements,
      remnants: [],
      defects,
      cuts: []
    });
    expect(dxf).toContain('3_DEFECTS');
    expect(dxf).toContain('DEFECT #10 (破洞)');
  });

  it('buildSlittingCsvText 与 buildLedgerCsvText 统一复用 csvCell 防逗号、双引号与公式注入', () => {
    const slittingCsv = buildSlittingCsvText({
      id: '=CMD|" /C calc"!A0',
      slitting1D: {
        leftTrimMm: 20,
        rightTrimMm: 20,
        patterns: [
          {
            lengthMm: 120000,
            repetitions: 3,
            usedWidthMm: 1500,
            spareWidthMm: 60,
            stations: [{ widthMm: 500, countPerRepetition: 3 }]
          }
        ]
      }
    });
    expect(slittingCsv.startsWith('\uFEFF')).toBe(true);
    // 公式前缀 `=` 必须被前置单引号中和且内部双引号正确双写转义
    expect(slittingCsv).toContain('"\'=CMD|"" /C calc""!A0"');

    const { csv: ledgerCsv, rangeLabel } = buildLedgerCsvText(
      [
        {
          sequence: 101,
          eventType: 'ROLL_SCRAP',
          aggregateType: 'ROLL',
          aggregateId: '+ROLL,01"X',
          actor: '@evil',
          occurredAt: '-2026-11-25'
        },
        {
          sequence: 102,
          eventType: 'QUALITY_RELEASE',
          aggregateType: 'REMNANT',
          aggregateId: 'REM-009',
          actor: '质检员',
          occurredAt: '2026-11-25 10:00:00'
        }
      ],
      { hasMore: true }
    );
    expect(ledgerCsv).toContain('"\'+ROLL,01""X"');
    expect(ledgerCsv).toContain('"\'@evil"');
    expect(ledgerCsv).toContain('"\'-2026-11-25"');
    expect(rangeLabel).toContain('已加载 2 条');
    expect(rangeLabel).toContain('#101~#102');
    expect(rangeLabel).toContain('尚有更多未加载');
  });

  it('matchScannedScheme 精准识别工单号 WO- 前缀、方案号、母卷号与外部单号', () => {
    const entries = [
      { scheme: { id: 'SCH-AAA1', rollId: 'ROLL-1001', externalOrderNo: 'MES-99' } },
      { scheme: { id: 'SCH-BBB2', rollId: 'ROLL-2002', externalOrderNo: 'ERP-77' } }
    ];
    expect(matchScannedScheme(entries, 'WO-SCH-BBB2')?.scheme.id).toBe('SCH-BBB2');
    expect(matchScannedScheme(entries, 'sch-aaa1')?.scheme.id).toBe('SCH-AAA1');
    expect(matchScannedScheme(entries, 'ROLL-2002')?.scheme.id).toBe('SCH-BBB2');
    expect(matchScannedScheme(entries, 'MES-99')?.scheme.id).toBe('SCH-AAA1');
    expect(matchScannedScheme(entries, 'NOT-EXIST')).toBeNull();
  });

  it('normalizeReconciliationReportItem 同时兼容嵌套与扁平聚合报工并识别已撤销处置', () => {
    const nested = normalizeReconciliationReportItem({
      taskId: 'T-01',
      taskName: '卫衣大货',
      materialModel: 'TC-2026',
      batchNo: 'BAT-A1',
      report: {
        planId: 'PLAN-01',
        rollId: 'ROLL-01',
        actualCutLen: 3200,
        netUtilization: 86.5,
        pieceResults: [],
        qualityDispositions: [{ id: 'D-1', pieceId: 1, disposition: 'SCRAP', revoked: false }]
      }
    });
    expect(nested?.reportId).toBe('PLAN-01');
    expect(nested?.batchNo).toBe('BAT-A1');
    expect(nested?.dispositions).toHaveLength(1);
    expect(isDispositionRevoked(nested?.dispositions[0])).toBe(false);

    const flat = normalizeReconciliationReportItem({
      reportId: 'PLAN-02',
      taskId: 'T-02',
      taskName: '补片单',
      dispositions: [{ dispositionId: 'D-2', status: 'REVOKED' }]
    });
    expect(flat?.reportId).toBe('PLAN-02');
    expect(isDispositionRevoked(flat?.dispositions[0])).toBe(true);

    // 真实后端 QualityDisposition 嵌套 command + revocation 形态校验
    const backendDisp = {
      id: 'DISP-REAL-1',
      planId: 'PLAN-03',
      remnantId: 'REM-202611-009',
      command: {
        operationId: 'op-1',
        expectedRevision: 0,
        pieceId: 7,
        disposition: 'REMNANT',
        inspector: '质检员王工',
        reason: '边角暗伤'
      },
      revocation: {
        idempotencyKey: 'rev-op-1',
        operator: '质检主管刘工',
        reason: '二次复核为浮尘',
        revokedAt: '2026-11-25T04:00:00'
      }
    };
    expect(isDispositionRevoked(backendDisp)).toBe(true);
    expect(readDispositionFields(backendDisp)).toMatchObject({
      id: 'DISP-REAL-1',
      pieceId: 7,
      disposition: 'REMNANT',
      inspector: '质检员王工',
      reason: '边角暗伤',
      remnantId: 'REM-202611-009',
      revoked: true,
      revokedBy: '质检主管刘工',
      revokedReason: '二次复核为浮尘'
    });
  });
});
