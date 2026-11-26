import type { SavedScheme2D, WorkbenchDraftPayload } from './studioTypes';

export type { WorkbenchDraftPayload } from './studioTypes';

export const WORKBENCH_DRAFT_PREFIX = 'cutplan.workbench.draft.v1.';

export function workbenchDraftKey(taskId: string | null | undefined): string {
  const clean = (taskId || '').trim();
  return `${WORKBENCH_DRAFT_PREFIX}${clean || 'scratch'}`;
}

/** 精简待保存的未确认方案（保留 placements / cuts / leftovers / demands 与核心元数据）。 */
function compactSchemeForDraft(s: SavedScheme2D): SavedScheme2D {
  return {
    ...s,
    request: s.request
      ? {
          schemaVersion: s.request.schemaVersion,
          problemType: s.request.problemType,
          problem: s.request.problem
            ? {
                unit: s.request.problem.unit,
                material: s.request.problem.material,
                process: s.request.problem.process
              }
            : undefined
        }
      : undefined
  };
}

export function saveWorkbenchDraft(
  taskId: string | null | undefined,
  draft: Omit<WorkbenchDraftPayload, 'version' | 'taskKey' | 'savedAt'> & { savedAt?: string },
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage !== 'undefined'
    ? localStorage
    : null
): WorkbenchDraftPayload | null {
  if (!storage) return null;
  const taskKey = (taskId || '').trim() || 'scratch';
  const payload: WorkbenchDraftPayload = {
    ...draft,
    version: 1,
    taskKey,
    savedAt: draft.savedAt || new Date().toISOString(),
    unconfirmedSchemes2D: (draft.unconfirmedSchemes2D || [])
      .filter((s) => !s.confirmedSchemeId)
      .slice(0, 6)
      .map(compactSchemeForDraft)
  };
  try {
    storage.setItem(workbenchDraftKey(taskKey), JSON.stringify(payload));
    return payload;
  } catch {
    // 若配额超限，仅保留需求与工艺参数草稿降级写入
    try {
      const fallback: WorkbenchDraftPayload = {
        ...payload,
        unconfirmedSchemes2D: [],
        activeSchemeId2D: null
      };
      storage.setItem(workbenchDraftKey(taskKey), JSON.stringify(fallback));
      return fallback;
    } catch {
      return null;
    }
  }
}

export function loadWorkbenchDraft(
  taskId: string | null | undefined,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage !== 'undefined'
    ? localStorage
    : null
): WorkbenchDraftPayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(workbenchDraftKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed.taskKey !== 'string') {
      return null;
    }
    if (!Array.isArray(parsed.activeDemands2D) && !Array.isArray(parsed.slitOrders)) {
      return null;
    }
    return parsed as WorkbenchDraftPayload;
  } catch {
    return null;
  }
}

export function clearWorkbenchDraft(
  taskId: string | null | undefined,
  storage: Pick<Storage, 'removeItem'> | null = typeof localStorage !== 'undefined'
    ? localStorage
    : null
): void {
  if (!storage) return;
  try {
    storage.removeItem(workbenchDraftKey(taskId));
  } catch {}
}
