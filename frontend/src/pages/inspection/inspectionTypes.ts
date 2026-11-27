import { isAlignedTo01Mm } from '../../utils/inventoryImportApi';

export const DEFECT_TYPES: [string, string][] = [
  ['STAIN', '污渍 / 斑点'],
  ['HOLE', '破洞'],
  ['WEFT_DEFECT', '跳纱'],
  ['SLUB', '粗节'],
  ['SHADING', '色差'],
  ['MANUAL_MARK', '其他疵点']
];

export const ROLL_STATUS_LABEL: Record<string, [string, string]> = {
  PASSED: ['合格', 'ok'],
  PENDING: ['待检', 'warn'],
  FAILED: ['不合格', 'err'],
  QUARANTINED: ['隔离', 'err']
};

export type RollFilterScope = 'ALL' | 'PENDING' | 'PASSED';

export const draftKey = (id: string) => 'cutplan.app.inspection.' + id;
export const SAVED_EVENT = 'cutplan:inspection-saved';

export function withoutSubmitted(items: any[], submitted: any[]): any[] {
  const signatures = new Map(submitted.map((d) => [d.captureId, JSON.stringify(d)]));
  return (items || []).filter(
    (d) => !d.captureId || signatures.get(d.captureId) !== JSON.stringify(d)
  );
}

export const defectAttrs = (type: string) => ({
  defectType: type,
  typeName: DEFECT_TYPES.find((t) => t[0] === type)?.[1] || '其他疵点',
  detectionSource: 'MANUAL_INSPECT',
  avoidanceStrategy: 'MUST_AVOID',
  description: '跑布验疵人工标记'
});

export const defectKey = (d: any) => (d.saved ? `saved-${d.id}` : d.captureId);

export function computeRollStats(rolls: any[]) {
  const remain = (x: any) =>
    x.currentRemainingLength ?? Math.max(0, (x.totalLength || 0) - (x.usedLength || 0));
  const pendingRolls = rolls.filter((r) => !r.inspectionStatus || r.inspectionStatus === 'PENDING');
  const blocked = rolls.filter(
    (r) => r.inspectionStatus === 'FAILED' || r.inspectionStatus === 'QUARANTINED'
  );
  return {
    pending: pendingRolls.length,
    pendingLength: pendingRolls.reduce((s, r) => s + remain(r), 0),
    passed: rolls.filter((r) => r.inspectionStatus === 'PASSED').length,
    blocked: blocked.length,
    defects: rolls.reduce((s, r) => s + (r.defectsCount ?? (r.defects || []).length), 0),
    withDefects: rolls.filter((r) => (r.defectsCount ?? (r.defects || []).length) > 0).length
  };
}

export function checkDefect01MmPrecision(d: {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  margin?: number;
}): string[] {
  const badFields: string[] = [];
  (['x', 'y', 'w', 'h', 'margin'] as const).forEach((k) => {
    if (d[k] !== undefined && !isAlignedTo01Mm(d[k])) {
      badFields.push(k);
    }
  });
  return badFields;
}
