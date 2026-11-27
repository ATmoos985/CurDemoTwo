/**
 * MCP 阶段二扩展工具：
 * 1) list_draft_schemes (businessRead)
 * 2) plan_multi_material_drafts (compute && businessRead && allowDraftScheme)
 * 3) discard_draft_scheme (allowDraftScheme)
 * 严守“绝不直接写库/扣减实物库存”与“绝不静默吞错”红线。
 */
export function registerPhase2DraftTools({
  tool,
  api,
  config,
  id,
  object,
  openObject,
  ref,
  resolveWorkbenchUrl,
  loadResultContextWithFallback,
  renderCuttingPreviewPng,
  withExtraContent,
  toPartialError,
  ToolFailure
}) {
  const DRAFT_STATUS_ENUM = ['PENDING_CONFIRMATION', 'CONFIRMED', 'DISCARDED', 'EXPIRED'];

  if (config.businessRead) {
    tool(
      'list_draft_schemes',
      '分页倒序查询后端持久化待审批草案列表（GET /api/v2/workbench/drafts），支持按状态、任务与批组过滤，并返回每条草案的实时状态、过期/版本漂移提示与工作台深链 URL。只读不写库存。',
      object(
        {
          status: { type: 'string', enum: ['ALL', ...DRAFT_STATUS_ENUM] },
          taskId: id,
          batchGroupId: id,
          page: { type: 'integer', minimum: 0, default: 0 },
          size: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        },
        []
      ),
      openObject(
        {
          items: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          size: { type: 'integer' },
          pendingCount: { type: 'integer' }
        },
        ['items', 'total', 'page', 'size', 'pendingCount']
      ),
      async ({ status, taskId, batchGroupId, page = 0, size = 20 }) => {
        const search = new URLSearchParams();
        if (status !== undefined) search.set('status', String(status));
        if (taskId !== undefined) search.set('taskId', String(taskId));
        if (batchGroupId !== undefined) search.set('batchGroupId', String(batchGroupId));
        search.set('page', String(page));
        search.set('size', String(size));
        const res = await api('/api/v2/workbench/drafts?' + search.toString());
        const rawItems = Array.isArray(res?.items) ? res.items : [];
        const items = rawItems.map((item) => {
          const draftId = String(item?.draftId || item?.id || '');
          const workbenchUrl = resolveWorkbenchUrl(config.origin, item?.workbenchUrl, {
            taskId: item?.target?.taskId ?? null,
            resultId: item?.target?.resultId ?? null,
            draftId
          });
          return { ...item, workbenchUrl };
        });
        return {
          items,
          total: Number(res?.total ?? items.length),
          page: Number(res?.page ?? page),
          size: Number(res?.size ?? size),
          pendingCount: Number(res?.pendingCount ?? 0)
        };
      }
    );
  }

  if (config.compute && config.businessRead && config.allowDraftScheme) {
    const multiReqSchema = ref('MultiMaterialPlanRequest');
    const batchInput = object(
      {
        ...multiReqSchema.properties,
        continueAcrossRolls: { type: 'boolean', default: true },
        note: { type: 'string', maxLength: 500 },
        ttlSeconds: { type: 'integer', minimum: 60, maximum: 86400, default: 1800 },
        includePreview: { type: 'boolean', default: true },
        previewMaxCount: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        previewWidthPx: { type: 'integer', minimum: 320, maximum: 2000, default: 800 },
        previewHeightPx: { type: 'integer', minimum: 200, maximum: 1600, default: 420 }
      },
      []
    );

    tool(
      'plan_multi_material_drafts',
      '执行多料头接力 + 多母卷连续接力联合排产并直接批量生成同 batchGroupId 的持久化待审批草案组（POST /api/v2/workbench/multi-material-drafts），可并发附带前 N 份排料 PNG 预览图。严禁直接锁库或扣减实物库存。',
      batchInput,
      openObject(
        {
          batchGroupId: { type: 'string' },
          inventoryMutated: { type: 'boolean', const: false },
          requiresHumanConfirmation: { type: 'boolean', const: true },
          draftCount: { type: 'integer' },
          drafts: { type: 'array', items: { type: 'object' } },
          planSummary: { type: 'object' },
          previewIncluded: { type: 'boolean' },
          previewedDraftIds: { type: 'array', items: { type: 'string' } },
          partialErrors: { type: 'array', items: { type: 'object' } }
        },
        [
          'batchGroupId',
          'inventoryMutated',
          'requiresHumanConfirmation',
          'draftCount',
          'drafts',
          'planSummary',
          'previewIncluded',
          'previewedDraftIds',
          'partialErrors'
        ]
      ),
      async (args) => {
        const hasTask = Boolean(args?.taskId);
        const hasModel = Boolean(args?.materialModel);
        const hasDemands = Array.isArray(args?.demands) && args.demands.length > 0;
        if (!hasTask && !hasModel && !hasDemands) {
          throw new ToolFailure('INVALID_INPUT', '请至少提供 taskId、materialModel 或 demands 之一');
        }
        const {
          includePreview = true,
          previewMaxCount = 3,
          previewWidthPx = 800,
          previewHeightPx = 420,
          continueAcrossRolls = true,
          ttlSeconds = 1800,
          ...rest
        } = args || {};

        const body = {
          ...rest,
          continueAcrossRolls,
          ttlSeconds
        };

        const resp = await api('/api/v2/workbench/multi-material-drafts', body);
        if (resp?.inventoryMutated !== false || resp?.requiresHumanConfirmation !== true) {
          throw new ToolFailure('INVALID_RESPONSE', '后端批量草案响应违反“待人工确认且不写库存”安全契约。');
        }
        const rawDrafts = Array.isArray(resp?.drafts) ? resp.drafts : [];
        for (const d of rawDrafts) {
          if (d?.inventoryMutated !== false || d?.requiresHumanConfirmation !== true) {
            throw new ToolFailure('INVALID_RESPONSE', '草案组内存在违反安全契约的草案条目。');
          }
        }

        const planResult = resp?.planResult || {};
        const remMap = new Map(
          (Array.isArray(planResult.remnantAllocations) ? planResult.remnantAllocations : []).map((r) => [
            r.remnantId,
            r
          ])
        );
        const rollMap = new Map(
          (Array.isArray(planResult.rollOptions) ? planResult.rollOptions : []).map((r) => [r.rollId, r])
        );

        const drafts = rawDrafts.map((d) => {
          const draftId = String(d.draftId || d.id || '');
          const resultId = d?.target?.resultId ?? '';
          const materialType = d?.target?.materialType ?? null;
          const materialId = d?.target?.materialId ?? null;
          const segMeta =
            materialType === 'REMNANT' ? remMap.get(materialId) : rollMap.get(materialId);
          const workbenchUrl = resolveWorkbenchUrl(config.origin, d.workbenchUrl, {
            taskId: d?.target?.taskId ?? args?.taskId ?? null,
            resultId,
            draftId
          });
          return {
            draftId,
            resultId,
            status: String(d.status || 'PENDING_CONFIRMATION'),
            batchGroupId: d.batchGroupId || resp.batchGroupId,
            batchIndex: d.batchIndex ?? null,
            batchTotal: d.batchTotal ?? rawDrafts.length,
            materialType,
            materialId,
            placedCount: segMeta?.placedCount ?? null,
            utilizationPct: segMeta?.utilizationPct ?? null,
            workbenchUrl,
            riskChecks: Array.isArray(d.riskChecks) ? d.riskChecks : []
          };
        });

        const previewedDraftIds = [];
        const extraContent = [];
        const partialErrors = [];
        if (includePreview && drafts.length > 0) {
          const targets = drafts.filter((d) => d.resultId).slice(0, previewMaxCount);
          const settled = await Promise.allSettled(
            targets.map(async (d) => {
              const loaded = await loadResultContextWithFallback(d.resultId);
              const rendered = renderCuttingPreviewPng({
                result: loaded.result,
                input: loaded.input,
                source: loaded.source,
                taskSummary: loaded.taskSummary,
                widthPx: previewWidthPx,
                heightPx: previewHeightPx
              });
              return { draftId: d.draftId, buffer: rendered.buffer };
            })
          );
          settled.forEach((outcome, idx) => {
            const target = targets[idx];
            if (outcome.status === 'fulfilled') {
              previewedDraftIds.push(outcome.value.draftId);
              extraContent.push({
                type: 'image',
                mimeType: 'image/png',
                data: outcome.value.buffer.toString('base64')
              });
            } else {
              partialErrors.push(toPartialError(`preview:${target.draftId}`, outcome.reason));
            }
          });
        }

        const data = {
          batchGroupId: String(resp.batchGroupId),
          inventoryMutated: false,
          requiresHumanConfirmation: true,
          draftCount: drafts.length,
          drafts,
          planSummary: {
            materialModel: planResult.materialModel ?? args?.materialModel ?? null,
            totalRequestedPieces: Number(planResult.totalRequestedPieces ?? 0),
            placedByRemnants: Number(planResult.placedByRemnants ?? 0),
            placedByRoll: Number(planResult.placedByRoll ?? 0),
            unplacedPieces: Number(planResult.unplacedPieces ?? 0),
            totalSavedAreaM2: Number(planResult.totalSavedAreaM2 ?? 0),
            warnings: Array.isArray(resp.warnings) ? resp.warnings : Array.isArray(planResult.warnings) ? planResult.warnings : []
          },
          previewIncluded: extraContent.length > 0,
          previewedDraftIds,
          partialErrors
        };
        return extraContent.length > 0 ? withExtraContent(data, extraContent) : data;
      },
      false,
      false,
      false
    );
  }

  if (config.allowDraftScheme) {
    tool(
      'discard_draft_scheme',
      '原子作废指定的待确认工作台草案并记录作废原因（POST /api/v2/workbench/drafts/{draftId}/discard）。仅关闭试排建议，绝不修改或恢复任何实物库存；已确认或已过期草案返回 409 冲突。',
      object(
        {
          draftId: id,
          reason: { type: 'string', minLength: 1, maxLength: 500 }
        },
        ['draftId']
      ),
      openObject(
        {
          id: { type: 'string' },
          draftId: { type: 'string' },
          status: { type: 'string', enum: DRAFT_STATUS_ENUM },
          inventoryMutated: { type: 'boolean', const: false },
          requiresHumanConfirmation: { type: 'boolean', const: true },
          discardedAt: { type: ['string', 'null'] },
          discardedBy: { type: ['string', 'null'] },
          discardReason: { type: ['string', 'null'] }
        },
        ['id', 'draftId', 'status', 'inventoryMutated', 'requiresHumanConfirmation']
      ),
      async ({ draftId, reason }) => {
        const body = reason !== undefined ? { reason } : {};
        const draft = await api('/api/v2/workbench/drafts/' + encodeURIComponent(draftId) + '/discard', body);
        if (draft?.inventoryMutated !== false) {
          throw new ToolFailure('INVALID_RESPONSE', '后端草案作废响应违反“不写库存”安全契约。');
        }
        return {
          ...draft,
          id: String(draft.id || draft.draftId || draftId),
          draftId: String(draft.draftId || draft.id || draftId)
        };
      },
      false,
      false,
      true
    );
  }
}
