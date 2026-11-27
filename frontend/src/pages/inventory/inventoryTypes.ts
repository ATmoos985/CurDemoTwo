import { buildRollScene, remnantAsRoll } from '../../lib/model/roll-scene.js';

export const ROLL_QUALITY_MAP: Record<string, [string, string]> = {
  PASSED: ['合格', 'ok'],
  PENDING: ['待检', 'warn'],
  FAILED: ['不合格', 'err'],
  QUARANTINED: ['隔离', 'err'],
  SCRAPPED: ['已报废', 'err']
};

export const REMNANT_STATUS_MAP: Record<string, [string, string]> = {
  AVAILABLE: ['可用', 'ok'],
  RESERVED: ['已预约', 'run'],
  CONSUMED: ['已消耗', ''],
  SCRAPPED: ['已报废', ''],
  REVOKED: ['已撤销', ''],
  VOIDED: ['已作废', ''],
  LOST: ['盘亏', 'err'],
  QUARANTINED: ['隔离', 'err']
};

export const ACTION_TITLES: Record<string, string> = {
  receive: '母卷入库登记',
  transfer: '材料批量移库',
  count: '实物库存盘点',
  scrap: '料头报废确认',
  release: '隔离料头质量复验放行',
  scrapRoll: '母卷级报废确认',
  editRoll: '编辑母卷缸号与工艺档案'
};

export type InventoryActionKind =
  | 'receive'
  | 'transfer'
  | 'count'
  | 'scrap'
  | 'release'
  | 'scrapRoll'
  | 'editRoll';

export type ReceiveModalMode = 'single' | 'batch_rolls' | 'batch_remnants';

export type PendingSlotKey = 'transfer' | 'count' | 'quality-release' | 'roll-scrap';

export const PENDING_SLOT_LABELS: Record<PendingSlotKey, string> = {
  transfer: '材料批量移库',
  count: '实物库存盘点',
  'quality-release': '隔离料头质量放行',
  'roll-scrap': '母卷级报废'
};

export interface CountRowState {
  present: boolean;
  width: string | number;
  length: string | number;
}

export interface ProductGroup {
  modelKey: string;
  materialName: string;
  composition: string;
  color: string;
  primaryWidthMm: number;
  rolls: any[];
  remnants: any[];
  passedRollCount: number;
  totalRemainingM: number;
  availableRemnants: any[];
  availableRemnantAreaM2: number;
}

export type PreviewTarget =
  | { kind: 'roll'; id: string }
  | { kind: 'remnant'; id: string }
  | null;

export type RollPreviewLayout = 'tile' | 'strip' | 'station';
export type InventoryViewScope = 'ALL' | 'ROLLS' | 'REMNANTS';
export type InventoryStatusScope = 'ALL' | 'READY' | 'PENDING' | 'HISTORY';

export function clampNum(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val));
}

export function idOf(rollMode: boolean, item: any) {
  return `${rollMode ? 'roll' : 'remnant'}:${rollMode ? item.rollId : item.id}`;
}

export function buildProductGroups(rolls: any[], remnants: any[]): ProductGroup[] {
  const rollById = new Map<string, any>();
  for (const r of rolls) {
    if (r?.rollId) rollById.set(r.rollId, r);
  }

  const map = new Map<string, { rolls: any[]; remnants: any[] }>();
  const ensure = (key: string) => {
    const k = key || '未分类品号';
    let g = map.get(k);
    if (!g) {
      g = { rolls: [], remnants: [] };
      map.set(k, g);
    }
    return g;
  };

  for (const r of rolls) {
    ensure(r.rollModel || r.materialName || '未分类品号').rolls.push(r);
  }

  for (const rem of remnants) {
    const parentRoll = rem.sourceRollId ? rollById.get(rem.sourceRollId) : null;
    const modelKey =
      parentRoll?.rollModel || rem.materialBatch || rem.sourceRollId || '未分类品号';
    ensure(modelKey).remnants.push(rem);
  }

  const groups: ProductGroup[] = [];
  for (const [modelKey, { rolls: gRolls, remnants: gRems }] of map.entries()) {
    const sampleRoll = gRolls[0];
    const passedRollCount = gRolls.filter((r) => r.inspectionStatus === 'PASSED').length;
    const totalRemainingMm = gRolls.reduce(
      (sum, r) =>
        sum + Math.max(0, r.currentRemainingLength ?? r.totalLength - (r.usedLength || 0)),
      0
    );
    const availableRemnants = gRems.filter((rm) => rm.status === 'AVAILABLE');
    const availableRemnantAreaM2 = availableRemnants.reduce(
      (sum, rm) =>
        sum + (Number(rm.area) || (Number(rm.width) * Number(rm.length)) / 1e6 || 0),
      0
    );

    groups.push({
      modelKey,
      materialName: sampleRoll?.materialName || '',
      composition: sampleRoll?.composition || '',
      color: sampleRoll?.color || '',
      primaryWidthMm: sampleRoll?.width || gRems[0]?.width || 0,
      rolls: gRolls,
      remnants: gRems,
      passedRollCount,
      totalRemainingM: totalRemainingMm / 1000,
      availableRemnants,
      availableRemnantAreaM2
    });
  }

  return groups.sort((a, b) => {
    const scoreA = (a.rolls.length > 0 ? 100 : 0) + Math.min(50, a.availableRemnants.length * 5);
    const scoreB = (b.rolls.length > 0 ? 100 : 0) + Math.min(50, b.availableRemnants.length * 5);
    if (scoreB !== scoreA) return scoreB - scoreA;
    return a.modelKey.localeCompare(b.modelKey, 'zh-CN');
  });
}

export function buildInventoryPreviewScene(
  previewRoll: any | null,
  previewRemnant: any | null,
  rollSpatialMap: any | null
) {
  if (previewRoll) {
    const cutZones: any[] = rollSpatialMap?.cutZones || [];
    const plannedZones: any[] = rollSpatialMap?.plannedZones || [];

    const mappedPlans = [
      ...cutZones.map((cz: any) => ({
        id: cz.planId,
        status: 'CONFIRMED',
        version: 1,
        request: {
          rollId: previewRoll.rollId,
          rollW: previewRoll.width,
          rollL: cz.lengthMm,
          windowStartY: cz.startY,
          feedPortType: 'roll',
          cutOrigin: 'left-top'
        },
        result: {
          deductLen: cz.lengthMm,
          pieces: cz.pieces || []
        }
      })),
      ...plannedZones.map((pz: any, i: number) => ({
        id: pz.planId || pz.schemeId || `PZ-${i}`,
        status: 'PENDING',
        version: 1,
        request: {
          rollId: previewRoll.rollId,
          rollW: previewRoll.width,
          rollL: pz.lengthMm,
          windowStartY: pz.startY,
          feedPortType: 'roll',
          cutOrigin: 'left-top'
        },
        result: {
          deductLen: pz.lengthMm,
          pieces: pz.pieces || []
        }
      }))
    ];

    const mappedReports = cutZones.map((cz: any) => ({
      planId: cz.planId,
      status: 'CONFIRMED',
      windowStartY: cz.startY,
      actualCutLen: cz.lengthMm,
      pieceResults: (cz.pieces || []).length
        ? (cz.pieces || []).map((p: any) => ({
            pieceId: p.id,
            demandId: p.demandId,
            name: p.name,
            x: p.x,
            y: p.y,
            w: p.w,
            l: p.l,
            shape: p.shape,
            outcome: 'QUALIFIED'
          }))
        : undefined
    }));

    return buildRollScene({
      roll: previewRoll,
      plans: mappedPlans,
      reports: mappedReports,
      rollId: previewRoll.rollId,
      demands: [],
      process: { bedLength: Math.min(3000, previewRoll.totalLength || 3000) }
    });
  }
  if (previewRemnant) {
    const asRoll = remnantAsRoll(previewRemnant);
    return buildRollScene({
      roll: asRoll,
      plans: [],
      reports: [],
      rollId: previewRemnant.id,
      demands: [],
      process: { bedLength: previewRemnant.length || 1000 }
    });
  }
  return null;
}
