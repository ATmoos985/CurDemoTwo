import { idempotentPost, requestJSON } from '../../lib/core/util.js';
import { idempotentJsonPost } from '../../utils/authClient';
import {
  ACTION_TITLES,
  CountRowState,
  InventoryActionKind,
  InventoryStatusScope,
  InventoryViewScope,
  ProductGroup
} from './inventoryTypes';

export function filterInventoryProducts(
  productGroups: ProductGroup[],
  searchQuery: string,
  viewScope: InventoryViewScope,
  statusScope: InventoryStatusScope
): ProductGroup[] {
  const q = searchQuery.trim().toLowerCase();
  return productGroups.filter((g) => {
    if (viewScope === 'ROLLS' && g.rolls.length === 0) return false;
    if (viewScope === 'REMNANTS') {
      if (
        statusScope === 'HISTORY'
          ? g.remnants.length === 0
          : g.availableRemnants.length === 0 &&
            g.remnants.every((rm) => rm.status === 'CONSUMED' || rm.status === 'SCRAPPED')
      ) {
        return false;
      }
    }
    if (!q) return true;
    if (`${g.modelKey} ${g.materialName} ${g.color} ${g.composition}`.toLowerCase().includes(q)) {
      return true;
    }
    if (
      g.rolls.some((r) => `${r.rollId} ${r.batchNo || ''} ${r.storageLocation || ''}`.toLowerCase().includes(q))
    ) {
      return true;
    }
    return g.remnants.some((rm) =>
      `${rm.id} ${rm.sourceRollId || ''} ${rm.location || ''}`.toLowerCase().includes(q)
    );
  });
}

export function filterDisplayedRolls(
  activeProduct: ProductGroup | null,
  statusScope: InventoryStatusScope,
  searchQuery: string,
  productMatchesQuery: boolean
): any[] {
  if (!activeProduct) return [];
  const q = searchQuery.trim().toLowerCase();
  return activeProduct.rolls.filter((r) => {
    if (statusScope === 'READY' && r.inspectionStatus !== 'PASSED') return false;
    if (statusScope === 'PENDING' && r.inspectionStatus === 'PASSED') return false;
    if (q && !productMatchesQuery) {
      return `${r.rollId} ${r.batchNo || ''} ${r.storageLocation || ''}`.toLowerCase().includes(q);
    }
    return true;
  });
}

export function filterDisplayedRemnants(
  activeProduct: ProductGroup | null,
  focusedRollId: string,
  statusScope: InventoryStatusScope,
  searchQuery: string,
  productMatchesQuery: boolean,
  includeQuarantined: boolean,
  rollLookup: Map<string, any>
): any[] {
  if (!activeProduct) return [];
  const q = searchQuery.trim().toLowerCase();
  let list = focusedRollId
    ? activeProduct.remnants.filter((rm) => rm.sourceRollId === focusedRollId)
    : activeProduct.remnants;

  if (statusScope === 'ALL') {
    list = list.filter(
      (rm) =>
        rm.status === 'AVAILABLE' ||
        rm.status === 'RESERVED' ||
        rm.status === 'QUARANTINED' ||
        (includeQuarantined && rm.status === 'LOST')
    );
  } else if (statusScope === 'READY') {
    list = list.filter((rm) => rm.status === 'AVAILABLE');
  } else if (statusScope === 'PENDING') {
    list = list.filter((rm) => rm.status === 'QUARANTINED' || rm.status === 'LOST');
  }

  if (q && !productMatchesQuery) {
    list = list.filter((rm) => {
      const parent = rm.sourceRollId ? rollLookup.get(rm.sourceRollId) : null;
      return `${rm.id} ${rm.sourceRollId || ''} ${rm.location || ''} ${rm.batchNo || parent?.batchNo || ''} ${rm.color || parent?.color || ''}`
        .toLowerCase()
        .includes(q);
    });
  }
  return list;
}

export function findScanTargets(
  rolls: any[],
  remnants: any[],
  queryUpper: string
): { hitRoll: any | null; hitRem: any | null } {
  const hitRoll =
    rolls.find((r) => String(r.rollId || '').toUpperCase() === queryUpper) ||
    rolls.find((r) => String(r.rollId || '').toUpperCase().includes(queryUpper)) ||
    null;
  const hitRem =
    remnants.find((rm) => String(rm.id || '').toUpperCase() === queryUpper) ||
    remnants.find((rm) => String(rm.id || '').toUpperCase().includes(queryUpper)) ||
    null;
  return { hitRoll, hitRem };
}

export interface ExecuteInventoryActionParams {
  action: InventoryActionKind;
  rollIdInput: string;
  rollModelInput: string;
  widthInput: string | number;
  lengthInput: string | number;
  batchNoInput: string;
  colorInput: string;
  shrinkageInput: string | number;
  locationInput: string;
  editRollTarget: any | null;
  releaseRemnantId: string;
  releaseDecision: 'RELEASE_AVAILABLE' | 'SCRAP';
  releaseInspector: string;
  scrapRollId: string;
  scrapId: string;
  destination: string;
  reason: string;
  operator: string;
  opts: any;
  selectedMaterials: Array<{ type: string; id: string; m: any }>;
  getCountRow: (key: string) => CountRowState;
}

export interface ExecuteInventoryActionResult {
  toastMessage: string;
  redirectHash?: string;
  clearEditRoll?: boolean;
  clearPicked?: boolean;
}

export async function executeInventoryAction(
  p: ExecuteInventoryActionParams
): Promise<ExecuteInventoryActionResult> {
  if (p.action === 'receive') {
    const shrinkNum = p.shrinkageInput === '' || p.shrinkageInput === null ? undefined : Number(p.shrinkageInput);
    const body: Record<string, any> = {
      rollId: String(p.rollIdInput).trim(),
      rollModel: String(p.rollModelInput).trim(),
      width: Number(p.widthInput),
      totalLength: Math.round(Number(p.lengthInput) * 1000)
    };
    if (p.batchNoInput.trim()) body.batchNo = p.batchNoInput.trim();
    if (p.colorInput.trim()) body.color = p.colorInput.trim();
    if (shrinkNum !== undefined && Number.isFinite(shrinkNum)) body.shrinkageRate = shrinkNum;
    if (p.locationInput.trim()) body.storageLocation = p.locationInput.trim();
    if (!body.rollId || !body.rollModel || !(body.width > 0) || !(body.totalLength > 0)) {
      throw new Error('请填写卷号、品号、幅宽与整卷长');
    }
    await requestJSON('/api/v2/inspection/rolls', body);
    return {
      toastMessage: '母卷已登记，进入跑布验疵',
      redirectHash: '#/inspection/' + encodeURIComponent(body.rollId)
    };
  }

  if (p.action === 'editRoll') {
    if (!p.editRollTarget) throw new Error('未选定待编辑母卷');
    const shrinkNum =
      p.shrinkageInput === '' || p.shrinkageInput === null
        ? p.editRollTarget.shrinkageRate ?? 0
        : Number(p.shrinkageInput);
    if (!Number.isFinite(shrinkNum) || shrinkNum < 0) throw new Error('缩水率须为非负数值');
    await requestJSON('/api/v2/rolls', {
      ...p.editRollTarget,
      batchNo: p.batchNoInput.trim() || p.editRollTarget.batchNo,
      color: p.colorInput.trim() || p.editRollTarget.color,
      shrinkageRate: shrinkNum,
      storageLocation: p.locationInput.trim() || p.editRollTarget.storageLocation
    });
    return {
      toastMessage: `母卷 ${p.editRollTarget.rollId} 档案已更新`,
      clearEditRoll: true
    };
  }

  if (p.action === 'release') {
    if (!p.releaseRemnantId) throw new Error('未选定待复验隔离料头');
    if (!p.releaseInspector.trim() || !p.reason.trim()) throw new Error('请填写质检员姓名与复验原因');
    await idempotentJsonPost(
      'quality-release',
      `/api/v2/quality/remnants/${encodeURIComponent(p.releaseRemnantId)}/release`,
      { decision: p.releaseDecision, inspector: p.releaseInspector.trim(), reason: p.reason.trim() }
    );
    return {
      toastMessage:
        p.releaseDecision === 'RELEASE_AVAILABLE'
          ? `隔离料头 ${p.releaseRemnantId} 已复验合格放行，转为可用状态`
          : `隔离料头 ${p.releaseRemnantId} 已复验判废并记账`
    };
  }

  if (p.action === 'scrapRoll') {
    if (!p.scrapRollId) throw new Error('未选定待报废母卷');
    if (!p.operator.trim() || !p.reason.trim()) throw new Error('请填写经办人与母卷报废原因');
    await idempotentJsonPost('roll-scrap', `/api/v2/rolls/${encodeURIComponent(p.scrapRollId)}/scrap`, {
      operator: p.operator.trim(),
      reason: p.reason.trim()
    });
    return {
      toastMessage: `母卷 ${p.scrapRollId} 已受控报废，剩余余量已清零并写入不可变流水`
    };
  }

  if (p.action === 'scrap') {
    if (!p.reason.trim()) throw new Error('请填写报废原因');
    await requestJSON('/api/v2/remnants/' + encodeURIComponent(p.scrapId) + '/scrap', {
      reason: p.reason.trim()
    });
    return { toastMessage: '料头已报废' };
  }

  if (!p.reason.trim() || !p.operator.trim() || (p.action === 'transfer' && !p.destination.trim())) {
    throw new Error(p.action === 'transfer' ? '请填写目标库位、原因与操作人' : '请填写原因与操作人');
  }
  const materials = p.selectedMaterials.map(({ type, id }) => {
    if (p.action === 'transfer') return { type, id };
    const c = p.getCountRow(type + ':' + id);
    return {
      type,
      id,
      present: Boolean(c.present),
      width: c.present ? Number(c.width) : 0,
      length: c.present ? Number(c.length) : 0
    };
  });
  const body =
    p.action === 'transfer'
      ? {
          expectedRevision: p.opts.revision,
          destination: p.destination.trim(),
          reason: p.reason.trim(),
          operator: p.operator.trim(),
          materials
        }
      : {
          expectedRevision: p.opts.revision,
          reason: p.reason.trim(),
          operator: p.operator.trim(),
          materials
        };
  await idempotentPost(p.action, `/api/v2/inventory-${p.action === 'transfer' ? 'transfers' : 'counts'}`, body);
  return {
    toastMessage: `${ACTION_TITLES[p.action]}已过账`,
    clearPicked: true
  };
}
