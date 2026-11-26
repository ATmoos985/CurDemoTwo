import type { SavedScheme2D, ShapeGeometry, StrategyJobRun } from '../../store/useStudioStore';
import { unpadGuillotineResult } from '../../lib/domain/nesting-request-adapter.js';

export interface ComparisonMetric {
  name: string;
  value: number;
  unit: string;
  numerator: number;
  denominator: number;
  basis: string;
  version: string;
}

export interface ComparisonSide {
  resultId: string;
  inputHash: string;
  fulfillmentStatus: string;
  requested: number;
  placed: number;
  unplaced: number;
  demands: { demandId: number; name: string; requested: number; placed: number; unplaced: number }[];
  occupiedLengthMm: number | null;
  lengthBasis: string | null;
  rectGapPaddingMm: number;
  metrics: ComparisonMetric[];
  materialWindow: {
    type: string; id: string; widthMm: number; windowStartMm: number; windowLengthMm: number;
  };
}

export interface CandidateComparisonReport {
  taskId: string;
  left: ComparisonSide;
  right: ComparisonSide;
  sameConstraints: boolean;
  constraintDifferences: string[];
  metricDeltas: {
    name: string; left: ComparisonMetric | null; right: ComparisonMetric | null;
    delta: number | null; status: string;
  }[];
  lengthComparison: { status: string; shorterResultId: string | null; savedLengthMm: number | null; basis: string; reason: string };
}

export const numberText = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
export const lengthText = (n: number | null) => Number.isFinite(n) ? `${numberText(n)} mm` : '未提供';

export type ComparisonChoice = Pick<SavedScheme2D, 'id' | 'strategyName' | 'comparisonSource' | 'layoutDirty'> & {
  widthMm?: number; createdAt?: string; empty?: boolean;
};

export function emptyArchiveChoices(runs: StrategyJobRun[]): ComparisonChoice[] {
  return runs.filter(run => run.placedCount === 0 && run.comparisonSource?.resultId).map(run => ({
    id: 'archive-' + run.comparisonSource.resultId, strategyName: run.strategyName,
    comparisonSource: run.comparisonSource, widthMm: run.physicalWidthMm, empty: true
  }));
}

export function selectionIssue(scheme: ComparisonChoice, taskId?: string) {
  if (scheme.layoutDirty) return '手调版本，请重新求解后比较';
  if (!scheme.comparisonSource?.taskId || !scheme.comparisonSource.resultId) {
    return '缺少原始归档关联（旧版、手调或合并需求），请重新生成单一任务的候选';
  }
  if (taskId && scheme.comparisonSource.taskId !== taskId && !scheme.comparisonSource.taskId.startsWith('scratch:')) return '属于其他工单';
  return '';
}

const differences: Record<string, string> = {
  'context.taskRevision': '工单版本', 'context.materialType': '材料来源类型', 'context.materialId': '材料编号',
  'context.materialRevision': '材料版本', 'context.physicalWidthMm': '实物门幅',
  'context.windowStartMm': '工位起点', 'context.windowLengthMm': '加工区长度',
  'context.rectGapPaddingMm': '直刀间距补偿', 'context.sourceLines': '需求来源或版本',
  'problem.material': '投入材料、尺寸或疵点', 'problem.parts': '裁片需求、数量或旋转许可',
  'problem.process': '裁切工艺参数', 'problem.unit': '输入单位', 'problemType': '问题类型',
  'schemaVersion': '数据契约版本', 'problem.schemaVersion': '输入格式版本',
  'strategy.gapFillLimits': '补空数量上限', 'requireComplete': '齐套要求'
};
export const differenceText = (key: string) => differences[key] || key;

export function lengthVerdict(report: CandidateComparisonReport) {
  const { status, shorterResultId, savedLengthMm } = report.lengthComparison;
  if (status === 'COMPARABLE' && Number.isFinite(savedLengthMm)) {
    if (savedLengthMm === 0) return '两套方案的预计占用版长相同';
    const side = shorterResultId === report.left.resultId ? 'A' : shorterResultId === report.right.resultId ? 'B' : null;
    if (side && savedLengthMm > 0) return `方案 ${side} 预计少用 ${lengthText(savedLengthMm)}`;
  }
  if (status === 'INCOMPLETE') return '未全部齐套，暂不能比较哪套更省布';
  if (status === 'DIFFERENT_CONTEXT') return '工单或用料条件不同，不能直接比较省布量';
  if (status === 'DIFFERENT_CONSTRAINTS') return '排料约束不同，不能直接比较省布量';
  return '缺少同口径的占用版长，暂不能比较省布量';
}

export const metricLabels: Record<string, string> = {
  processingAreaUtilization: '加工区占用率',
  markerAreaUtilization: '齐套版面利用率',
  markerAreaUtilizationWithFill: '含补空片的版面利用率'
};
const basisLabels: Record<string, string> = {
  'piece-net-area / submitted-processing-area; not actual consumed material': '需求裁片净面积 ÷ 提交加工区面积',
  'complete-kit-net-area / (fixed-width * occupied-marker-length); excludes unused tail; planned': '齐套需求裁片净面积 ÷（门幅 × 占用版长）',
  '(complete-kit + verified spare net area) / (fixed-width * occupied-marker-length); planned': '（齐套需求裁片 + 已校验补空片）净面积 ÷（门幅 × 占用版长）'
};
export const metricBasis = (basis: string) => basisLabels[basis] || basis;

/** These archived coordinates already include the workbench's projected defect margin. */
export function archivedExclusions(input: { problemType: string; problem: { unit: string; material: {
  exclusions: { id: number; x: number; y: number; shape: ShapeGeometry }[]
} } }) {
  if (input?.problemType !== 'NESTING_2D' || input.problem?.unit !== 'mm' || !Array.isArray(input.problem.material?.exclusions)) {
    throw new Error('未能核实这份归档的材料避让区，请重新读取原图。');
  }
  return input.problem.material.exclusions;
}

export interface ArchivedDrawing {
  region: ShapeGeometry;
  pieces: { id: number; demandId: number; name: string; x: number; y: number; shape: ShapeGeometry; spare: boolean }[];
  cuts: { sequence: number; startX: number; startY: number; endX: number; endY: number }[];
}

/** Render only the immutable server result returned for this side of this comparison. */
export function archivedDrawing(archive: any, side: ComparisonSide): ArchivedDrawing {
  if (!side.inputHash || archive?.id !== side.resultId || archive?.inputHash !== side.inputHash) {
    throw new Error('归档版本与对比表不一致，请关闭原图并重新比较。');
  }
  const region = archive.layout?.processingRegion;
  const gap = side.rectGapPaddingMm;
  if (archive.layout?.unit !== 'mm' || archive.layout?.coordinateSystem !== 'source-local-top-left' ||
      !Array.isArray(archive.layout.placements) || !region || !(region.width > 0 && region.height > 0) ||
      !Number.isFinite(gap) || gap < 0 || gap >= Math.min(region.width, region.height)) {
    throw new Error('这份归档缺少完整的毫米制排料图，暂时无法查看。');
  }
  const mainCount = archive.layout.placements.length;
  const allPlacements = [...archive.layout.placements, ...(archive.marker?.gapFillPlacements || [])];
  const corrected = unpadGuillotineResult({ ...archive, layout: { ...archive.layout, placements: allPlacements } }, {
    rectGapPadding: gap, origWidthMm: region.width - gap, origHeightMm: region.height - gap
  });
  return {
    region: corrected.layout.processingRegion,
    pieces: corrected.layout.placements.map((p, index) => ({ ...p, spare: index >= mainCount })),
    cuts: corrected.layout.cuts || []
  };
}
