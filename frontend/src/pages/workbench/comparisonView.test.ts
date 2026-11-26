import { describe, expect, it } from 'vitest';
import type { SavedScheme2D, StrategyJobRun } from '../../store/useStudioStore';
import { archivedDrawing, CandidateComparisonReport, ComparisonSide, emptyArchiveChoices, lengthVerdict, selectionIssue } from './comparisonView';

const candidate = { comparisonSource: { taskId: 'task-1', resultId: 'result-1' } } as SavedScheme2D;
const side = { resultId: 'result-1', inputHash: 'archived-hash', rectGapPaddingMm: 2 } as ComparisonSide;
const piece = { id: 1, demandId: 1, name: '前片', x: 0, y: 0, shape: { type: 'RECTANGLE', width: 102, height: 82 } };
const archive = { id: 'result-1', inputHash: side.inputHash, layout: {
  unit: 'mm', coordinateSystem: 'source-local-top-left', processingRegion: { type: 'RECTANGLE', width: 1502, height: 902 },
  placements: [piece], cuts: [{ sequence: 1, startX: 0, startY: 82, endX: 1502, endY: 82 }]
}, marker: { gapFillPlacements: [{ ...piece, id: 2, x: 120 }] } };

describe('工作台候选对比', () => {
  it('未排入裁片的归档作业可以复盘，运行中或缺少归档的作业不提供选项', () => {
    const run = { comparisonSource: candidate.comparisonSource, strategyName: '快速基线', placedCount: 0, physicalWidthMm: 1500 } as StrategyJobRun;
    expect(emptyArchiveChoices([run, { ...run, placedCount: undefined }, { ...run, placedCount: 1 }, { ...run, comparisonSource: undefined }]))
      .toEqual([{ id: 'archive-result-1', strategyName: '快速基线', comparisonSource: candidate.comparisonSource, widthMm: 1500, empty: true }]);
  });
  it('手调、无归档与其他工单的候选无法参比，即使仍带旧结果号', () => {
    expect(selectionIssue(candidate, 'task-1')).toBe('');
    expect(selectionIssue(candidate, 'other')).toContain('其他工单');
    expect(selectionIssue({ ...candidate, comparisonSource: { taskId: 'scratch:123', resultId: 'result-2' } }, 'task-1')).toBe('');
    expect(selectionIssue({ ...candidate, layoutDirty: true })).toContain('手调');
    expect(selectionIssue({ result: { id: 'result-1' } } as SavedScheme2D)).toContain('缺少原始归档');
  });
  it('要求两项归档证据完全对应当前所查看的一侧', () => {
    expect(() => archivedDrawing({ ...archive, id: 'right' }, side)).toThrow('版本');
    expect(() => archivedDrawing({ ...archive, inputHash: 'another-version' }, side)).toThrow('版本');
  });
  it('在原件及补空片上还原同一间距补偿，并夹紧刀线至实物幅宽', () => {
    const draw = archivedDrawing(archive, side);
    expect(draw.region).toMatchObject({ width: 1500, height: 900 });
    expect(draw.pieces.map(p => [p.shape.width, p.shape.height, p.spare])).toEqual([[100, 80, false], [100, 80, true]]);
    expect(draw.cuts[0].endX).toBe(1500);
    expect(archive.layout.placements[0].shape.width).toBe(102);
  });
  it('不向无单位或错误坐标系的历史布局补造几何数据', () => {
    expect(() => archivedDrawing({ ...archive, layout: { ...archive.layout, unit: 'in' } }, side)).toThrow('毫米制');
    expect(() => archivedDrawing({ ...archive, layout: { ...archive.layout, coordinateSystem: '' } }, side)).toThrow('毫米制');
  });
  it('只展示服务端可比的节省量，未齐套、单位不同或材料窗口不同均不推荐赢家', () => {
    const report = { left: { resultId: 'A' }, right: { resultId: 'B' },
      lengthComparison: { status: 'COMPARABLE', shorterResultId: 'B', savedLengthMm: 2.35 } } as CandidateComparisonReport;
    expect(lengthVerdict(report)).toBe('方案 B 预计少用 2.35 mm');
    for (const status of ['INCOMPLETE', 'DIFFERENT_CONTEXT', 'DIFFERENT_CONSTRAINTS', 'UNAVAILABLE']) {
      expect(lengthVerdict({ ...report, lengthComparison: { ...report.lengthComparison, status } })).not.toContain('预计少用');
    }
  });
});
