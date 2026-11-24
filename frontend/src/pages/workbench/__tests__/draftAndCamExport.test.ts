import { describe, expect, it } from 'vitest';
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  workbenchDraftKey
} from '../../../store/workbenchDraft';
import {
  DEFAULT_STUDIO_SETTINGS,
  extractCncPostOptions,
  validateStudioSettings,
  type StudioSettings
} from '../../../store/studioSettings';
import { useStudioStore, type SavedScheme2D } from '../../../store/useStudioStore';
import { computeSuggestedFeedWindow, generateCamExportText } from '../workbenchUtils';

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    }
  };
}

const makeSampleScheme = (): SavedScheme2D => ({
  id: 'CAND-TEST-1',
  title: '经向缩长 (1600×1200mm)',
  strategyId: 'PS_FIXED',
  strategyName: '经向缩长',
  createdAt: '12:00:00',
  canvasMode: 'STOCK_ROLL',
  rollId: 'ROLL-2026-0920',
  windowStartY: 1000,
  materialModel: 'TC-2026',
  widthMm: 1600,
  canvasLengthMm: 2000,
  occupiedLengthMm: 1200,
  utilizationPct: 82.5,
  pieceAreaM2: 1.584,
  placedCount: 2,
  requestedCount: 2,
  complete: true,
  demands: [],
  request: {},
  result: {
    layout: {
      placements: [
        { id: 1, demandId: 1, name: '主帘左', x: 0, y: 0, w: 800, l: 1200 },
        { id: 2, demandId: 1, name: '主帘右', x: 800, y: 0, w: 800, l: 1200 }
      ],
      leftovers: [{ id: 'REM-A', x: 0, y: 1200, w: 1600, l: 800, hasDefect: false }],
      cuts: [
        { sequence: 1, kind: 'HORIZONTAL', startX: 0, startY: 1200, endX: 1600, endY: 1200 },
        { sequence: 2, kind: 'VERTICAL', startX: 800, startY: 0, endX: 800, endY: 1200 }
      ]
    }
  }
});

describe('按 taskId 隔离的工作台草稿持久化与恢复', () => {
  it('不同 taskId 的草稿互相隔离，已确认方案不会写入未落库草稿', () => {
    const storage = createMemoryStorage();
    const unconfirmed = makeSampleScheme();
    const confirmed: SavedScheme2D = { ...makeSampleScheme(), id: 'CAND-CONFIRMED', confirmedSchemeId: 'SCH-001' };

    saveWorkbenchDraft(
      'TASK-A',
      {
        activeDimension: '2D',
        scenario2D: 'SHORTEN_KIT',
        multiWidthsText2D: '1500, 1650',
        canvasMode: 'STOCK_ROLL',
        canvasWidthMm: 1600,
        canvasLengthMm: 2200,
        windowStartY2D: 800,
        pieceGapMm: 5,
        trimStartMm: 30,
        selectedRollId: 'ROLL-2026-0920',
        selectedRemnantId: '',
        materialModel2D: 'TC-A',
        activeDemands2D: [
          { id: 1, name: 'A单主帘', width: 800, length: 1200, quantity: 2, allowRotation: false }
        ],
        unconfirmedSchemes2D: [unconfirmed, confirmed],
        activeSchemeId2D: unconfirmed.id,
        scenario1D: 'MIN_CARS',
        slitMaterialMode: 'VIRTUAL_ROLL',
        slitWidthMode: 'FLEXIBLE',
        slitProfile: 'FAST',
        slitMotherWidthMm: 4600,
        slitLeftTrimMm: 100,
        slitRightTrimMm: 100,
        slitMinWidthMm: 4300,
        slitMaxWidthMm: 4400,
        slitWidthStepMm: 10,
        slitOverCap: 30,
        slitFixedLengthMm: 2000,
        slitAvoidDefects: false,
        slitRollId: '',
        slitMaterialModel: 'FILM',
        slitOrders: []
      },
      storage
    );

    expect(workbenchDraftKey('TASK-A')).not.toBe(workbenchDraftKey('TASK-B'));
    expect(loadWorkbenchDraft('TASK-B', storage)).toBeNull();

    const loadedA = loadWorkbenchDraft('TASK-A', storage);
    expect(loadedA).not.toBeNull();
    expect(loadedA!.windowStartY2D).toBe(800);
    expect(loadedA!.pieceGapMm).toBe(5);
    expect(loadedA!.unconfirmedSchemes2D).toHaveLength(1);
    expect(loadedA!.unconfirmedSchemes2D[0].id).toBe('CAND-TEST-1');

    // 通过 store.restoreWorkbenchDraft 完整恢复工作台状态
    useStudioStore.getState().restoreWorkbenchDraft(loadedA!);
    const st = useStudioStore.getState();
    expect(st.windowStartY2D).toBe(800);
    expect(st.pieceGapMm).toBe(5);
    expect(st.activeDemands2D[0].name).toBe('A单主帘');
    expect(st.schemes2D[0].id).toBe('CAND-TEST-1');

    clearWorkbenchDraft('TASK-A', storage);
    expect(loadWorkbenchDraft('TASK-A', storage)).toBeNull();
  });
});

describe('CNC 后处理参数透传与 DXF 疵点层真实导出', () => {
  it('G-Code 真实透传自定义 cutFeed / rapidFeed / plungeDelay / retractDelay', () => {
    const settings: StudioSettings = {
      ...DEFAULT_STUDIO_SETTINGS,
      cncCutFeed: 5200,
      cncRapidFeed: 18500,
      cncPlungeDelay: 350,
      cncRetractDelay: 150
    };
    expect(validateStudioSettings(settings)).toBeNull();
    expect(extractCncPostOptions(settings)).toEqual({
      cutFeed: 5200,
      rapidFeed: 18500,
      plungeDelay: 350,
      retractDelay: 150
    });

    const nc = generateCamExportText(makeSampleScheme(), settings, 'nc', []);
    expect(nc).toContain('F5200');
    expect(nc).toContain('F18500');
    expect(nc).toContain('G04 P350');
    expect(nc).toContain('G04 P150');
  });

  it('DXF 真实导出窗口内疵点到 3_DEFECTS 图层（不再写死空数组）', () => {
    const dxf = generateCamExportText(makeSampleScheme(), DEFAULT_STUDIO_SETTINGS, 'dxf', [
      { id: 'DEF-9', x: 320, y: 450, w: 60, h: 80, margin: 20, label: '油污' }
    ]);
    expect(dxf).toContain('3_DEFECTS');
    expect(dxf).toContain('DEFECT #DEF-9 (油污)');
    expect(dxf).toContain('300.000'); // x - margin = 320 - 20 = 300
    expect(dxf).toContain('430.000'); // y - margin = 450 - 20 = 430
  });

  it('CNC 参数越界时被 validateStudioSettings 准确拦截', () => {
    expect(validateStudioSettings({ ...DEFAULT_STUDIO_SETTINGS, cncCutFeed: 50 })).toContain(
      '切割进给'
    );
    expect(validateStudioSettings({ ...DEFAULT_STUDIO_SETTINGS, cncRapidFeed: 100 })).toContain(
      '空程进给'
    );
    expect(validateStudioSettings({ ...DEFAULT_STUDIO_SETTINGS, cncPlungeDelay: -10 })).toContain(
      '下刀延时'
    );
    expect(validateStudioSettings({ ...DEFAULT_STUDIO_SETTINGS, cncRetractDelay: 20000 })).toContain(
      '抬刀延时'
    );
  });
});

describe('连续开卷自动拉布避疵建议（复用 feed-length.js，纯预览不写库）', () => {
  it('遇起切首端高危宽幅疵点自动跳段并补偿局部疵点长度', () => {
    const roll = {
      width: 1600,
      totalLength: 20000,
      usedLength: 2000,
      currentRemainingLength: 18000,
      defects: [
        // 位于 2000~2150 覆盖 85% 幅宽的高危疵点
        { id: 1, x: 100, y: 2010, w: 1400, h: 120, margin: 20 },
        // 窗口内一处局部疵点
        { id: 2, x: 200, y: 2900, w: 100, h: 100, margin: 20 }
      ]
    };
    const res = computeSuggestedFeedWindow({
      roll,
      demands: [
        { id: 1, name: '帘片', width: 700, length: 1400, quantity: 2, allowRotation: false }
      ],
      windowStartY: 2000,
      trimStartMm: 20,
      defaultDefectMarginMm: 20
    });
    expect(res.suggestedStartY).toBeGreaterThan(2100);
    expect(res.suggestedLengthMm).toBeGreaterThanOrEqual(1420);
    expect(res.avoidedDefectsCount).toBeGreaterThanOrEqual(1);
    // 确认未改动原 roll
    expect(roll.usedLength).toBe(2000);
  });
});
