import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DemandFamilySummary,
  DemandItem,
  SavedScheme2D,
  SlittingSchemeRun
} from '../../store/studioTypes';
import { requestJSON, toast } from '../../lib/core/util.js';
import {
  evaluateActiveDraftBlockedReason,
  fetchWorkbenchDraft,
  fetchWorkbenchDrafts,
  type WorkbenchDraftDto
} from './draftInboxApi';
import { useDraftInbox } from './useDraftInbox';
import {
  mapResultContextToWorkbenchPlan,
  type ExternalPlanBannerMeta,
  type WorkbenchResultContextDto,
  type WorkbenchSchemeDraftDto
} from './workbenchDeeplinkUtils';

export interface UseWorkbenchDataAndDeeplinkParams {
  taskId?: string;
  resultId?: string;
  draftId?: string;
  activeDimension: '2D' | '1D';
  loadedTaskId: string | null;
  slitLoadedTaskId: string | null;
  activeScheme2D: SavedScheme2D | null;
  activeScheme1D: SlittingSchemeRun | null;
  syncTemplatesFromServer: () => void;
  syncDemandFamilyProgress: (fam: DemandFamilySummary) => void;
  loadDemandFamilyIntoWorkbench: (fam: DemandFamilySummary) => void;
  setActiveDimension: (dim: '2D' | '1D') => void;
  setCanvasSpec: (patch: Record<string, any>) => void;
  setActiveDemands2D: (demands: DemandItem[]) => void;
  setSchemes2D: (schemes: SavedScheme2D[], activeId?: string | null) => void;
  setSlitSpec: (patch: Record<string, any>) => void;
  setSlitSchemes: (schemes: SlittingSchemeRun[]) => void;
  setActiveSlitScheme: (id: string | null) => void;
  getSchemes2D: () => SavedScheme2D[];
  getSlitSchemes: () => SlittingSchemeRun[];
  onDeeplinkHydratedDraft: (draftKey: string) => void;
  onDemandPoolLoaded: () => void;
}

export function useWorkbenchDataAndDeeplink(params: UseWorkbenchDataAndDeeplinkParams) {
  const {
    taskId,
    resultId,
    draftId,
    activeDimension,
    loadedTaskId,
    slitLoadedTaskId,
    activeScheme2D,
    activeScheme1D,
    syncTemplatesFromServer,
    syncDemandFamilyProgress,
    loadDemandFamilyIntoWorkbench,
    setActiveDimension,
    setCanvasSpec,
    setActiveDemands2D,
    setSchemes2D,
    setSlitSpec,
    setSlitSchemes,
    setActiveSlitScheme,
    getSchemes2D,
    getSlitSchemes,
    onDeeplinkHydratedDraft,
    onDemandPoolLoaded
  } = params;

  const [rolls, setRolls] = useState<any[]>([]);
  const [remnants, setRemnants] = useState<any[]>([]);
  const [poolFamilies, setPoolFamilies] = useState<DemandFamilySummary[]>([]);
  const [taskSchemes, setTaskSchemes] = useState<any[]>([]);
  const [taskReports, setTaskReports] = useState<any[]>([]);

  const [externalPlanLoading, setExternalPlanLoading] = useState<boolean>(false);
  const [externalPlanError, setExternalPlanError] = useState<string | null>(null);
  const [externalPlanBanner, setExternalPlanBanner] = useState<ExternalPlanBannerMeta | null>(null);
  const [externalPlanDismissed, setExternalPlanDismissed] = useState<boolean>(false);
  const [deeplinkNonce, setDeeplinkNonce] = useState<number>(0);
  const [siblingDrafts, setSiblingDrafts] = useState<WorkbenchDraftDto[]>([]);
  const [draftClockTick, setDraftClockTick] = useState<number>(0);
  const deeplinkLoadedKeyRef = useRef<string>('');

  const syncExternalPlanBannerWithDraft = useCallback((updated: WorkbenchDraftDto) => {
    const updatedId = updated.draftId || updated.id;
    const upperStatus = String(updated.status || '').toUpperCase();
    const expMs = updated.expiresAt ? Date.parse(updated.expiresAt) : NaN;
    const isExpiredNow =
      upperStatus === 'EXPIRED' ||
      (upperStatus === 'PENDING_CONFIRMATION' && Number.isFinite(expMs) && expMs < Date.now());
    const nextStatus = isExpiredNow && upperStatus === 'PENDING_CONFIRMATION' ? 'EXPIRED' : updated.status;
    setExternalPlanBanner((prev) => {
      if (!prev || prev.draftId !== updatedId) return prev;
      if (
        prev.status === nextStatus &&
        prev.expired === isExpiredNow &&
        prev.stale === Boolean(updated.stale) &&
        (prev.confirmedSchemeId || null) === (updated.confirmedSchemeId || null) &&
        (prev.discardReason || null) === (updated.discardReason || null) &&
        (prev.expiresAt || null) === (updated.expiresAt || null)
      ) {
        return prev;
      }
      return {
        ...prev,
        status: nextStatus,
        expired: isExpiredNow,
        stale: Boolean(updated.stale),
        staleReasons: Array.isArray(updated.staleReasons) ? updated.staleReasons : prev.staleReasons,
        confirmedSchemeId: updated.confirmedSchemeId ?? prev.confirmedSchemeId,
        discardReason: updated.discardReason ?? prev.discardReason,
        expiresAt: updated.expiresAt ?? prev.expiresAt
      };
    });
  }, []);

  const draftInbox = useDraftInbox({
    activeDraftId: externalPlanBanner?.draftId || draftId || null,
    onForceReloadDeeplink: () => setDeeplinkNonce((n) => n + 1),
    onDraftStateChanged: (updated) => {
      const updatedId = updated.draftId || updated.id;
      syncExternalPlanBannerWithDraft(updated);
      if (externalPlanBanner?.draftId === updatedId) {
        setDeeplinkNonce((n) => n + 1);
      }
    },
    onActiveDraftSynced: syncExternalPlanBannerWithDraft
  });

  // 实时监测当前活动草案的 expiresAt 到期时间，到期瞬间自动切换横幅与确认按钮阻断状态
  useEffect(() => {
    if (!externalPlanBanner || externalPlanBanner.status !== 'PENDING_CONFIRMATION' || externalPlanBanner.expired) {
      return;
    }
    if (!externalPlanBanner.expiresAt) return;
    const expMs = Date.parse(externalPlanBanner.expiresAt);
    if (!Number.isFinite(expMs)) return;
    const delayMs = expMs - Date.now() + 100;
    if (delayMs <= 0) {
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === externalPlanBanner.draftId && prev.status === 'PENDING_CONFIRMATION'
          ? { ...prev, status: 'EXPIRED', expired: true }
          : prev
      );
      setDraftClockTick(Date.now());
      return;
    }
    if (delayMs > 86_400_000) return;
    const timer = window.setTimeout(() => {
      setExternalPlanBanner((prev) =>
        prev && prev.draftId === externalPlanBanner.draftId && prev.status === 'PENDING_CONFIRMATION'
          ? { ...prev, status: 'EXPIRED', expired: true }
          : prev
      );
      setDraftClockTick(Date.now());
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [externalPlanBanner]);

  useEffect(() => {
    const groupId = externalPlanBanner?.batchGroupId;
    if (!groupId) {
      setSiblingDrafts([]);
      return;
    }
    let cancelled = false;
    fetchWorkbenchDrafts({ status: 'ALL', batchGroupId: groupId, page: 0, size: 50 })
      .then((res) => {
        if (!cancelled) {
          setSiblingDrafts(res.items || []);
        }
      })
      .catch(() => {
        if (!cancelled) setSiblingDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [externalPlanBanner?.batchGroupId, externalPlanBanner?.status, deeplinkNonce]);

  const reloadReferenceData = async (explicitTaskId?: string | null) => {
    const curTaskId =
      explicitTaskId !== undefined
        ? explicitTaskId
        : activeDimension === '2D'
        ? loadedTaskId
        : slitLoadedTaskId;
    const [rList, remList, famList, schList, repPage] = await Promise.all([
      requestJSON('/api/v2/rolls').catch(() => []),
      requestJSON('/api/v2/remnants').catch(() => []),
      requestJSON('/api/v2/demand-pool').catch(() => []),
      curTaskId
        ? requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => [])
        : Promise.resolve([]),
      curTaskId
        ? requestJSON(
            `/api/v2/reconciliation/reports?limit=200&offset=0&taskId=${encodeURIComponent(
              curTaskId
            )}`
          ).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] })
    ]);
    setRolls(Array.isArray(rList) ? rList : []);
    setRemnants(Array.isArray(remList) ? remList : []);
    const fams: DemandFamilySummary[] = Array.isArray(famList) ? famList : [];
    setPoolFamilies(fams);
    setTaskSchemes(Array.isArray(schList) ? schList : []);
    const repItems = Array.isArray(repPage?.items)
      ? repPage.items
      : Array.isArray(repPage)
      ? repPage
      : [];
    setTaskReports(repItems);
    if (curTaskId) {
      const matched = fams.find((f) => f.id === curTaskId);
      if (matched) {
        syncDemandFamilyProgress(matched);
      }
      onDemandPoolLoaded();
    }
    return fams;
  };

  useEffect(() => {
    syncTemplatesFromServer();
    reloadReferenceData();
  }, []);

  // URL 深链统一载入：支持 #/workbench/:taskId、#/workbench?taskId=...&resultId=... 与 #/workbench?taskId=...&draftId=...
  useEffect(() => {
    const cleanTaskId = (taskId || '').trim();
    const cleanResultId = (resultId || '').trim();
    const cleanDraftId = (draftId || '').trim();
    const deeplinkKey = `${cleanTaskId}|${cleanResultId}|${cleanDraftId}|${deeplinkNonce}`;

    if (!cleanTaskId && !cleanResultId && !cleanDraftId) {
      deeplinkLoadedKeyRef.current = '';
      return;
    }
    if (deeplinkLoadedKeyRef.current === deeplinkKey) {
      return;
    }
    deeplinkLoadedKeyRef.current = deeplinkKey;

    const hasExternalPlan = Boolean(cleanResultId || cleanDraftId);
    let cancelled = false;
    let finished = false;

    const hydrateFromDeeplink = async () => {
      let draft: WorkbenchSchemeDraftDto | null = null;
      let loadedFamily: DemandFamilySummary | null = null;

      if (hasExternalPlan) {
        setExternalPlanLoading(true);
        setExternalPlanError(null);
        setExternalPlanBanner(null);
        setExternalPlanDismissed(false);
      }

      try {
        if (cleanDraftId) {
          draft = await requestJSON(
            '/api/v2/workbench/drafts/' + encodeURIComponent(cleanDraftId)
          );
          if (cancelled) return;
        }

        const effectiveTaskId = cleanTaskId || String(draft?.target?.taskId || '').trim();
        const effectiveResultId = cleanResultId || String(draft?.target?.resultId || '').trim();

        if (effectiveTaskId) {
          try {
            const fam: DemandFamilySummary = await requestJSON(
              '/api/v2/demand-pool/' + encodeURIComponent(effectiveTaskId)
            );
            if (cancelled) return;
            if (fam?.id) {
              loadedFamily = fam;
              loadDemandFamilyIntoWorkbench(fam);
              onDemandPoolLoaded();
            }
          } catch (famErr: any) {
            if (cancelled) return;
            if (!effectiveResultId && !cleanDraftId) {
              toast('加载需求族失败：' + (famErr?.message || '请求异常'), true);
              return;
            }
          }
        }

        if (!hasExternalPlan) {
          return;
        }

        if (!effectiveResultId) {
          const fallbackPlan = mapResultContextToWorkbenchPlan(null, draft, loadedFamily);
          const msg = '草案缺少关联的试排结果编号（resultId），无法渲染排料画布。';
          setExternalPlanBanner(fallbackPlan.banner);
          setExternalPlanError(msg);
          toast(msg, true);
          return;
        }

        const context: WorkbenchResultContextDto = await requestJSON(
          '/api/v2/workbench/results/' + encodeURIComponent(effectiveResultId) + '/context'
        );
        if (cancelled) return;

        const inferredTaskId =
          effectiveTaskId ||
          String(
            context?.source?.taskId ||
              context?.taskSummary?.id ||
              context?.taskSummary?.taskId ||
              ''
          ).trim();
        if (!loadedFamily && inferredTaskId) {
          try {
            const fam: DemandFamilySummary = await requestJSON(
              '/api/v2/demand-pool/' + encodeURIComponent(inferredTaskId)
            );
            if (cancelled) return;
            if (fam?.id) {
              loadedFamily = fam;
              loadDemandFamilyIntoWorkbench(fam);
              onDemandPoolLoaded();
            }
          } catch {
            // 需求族拉取失败时仍继续渲染试排画布
          }
        }

        const mapped = mapResultContextToWorkbenchPlan(context, draft, loadedFamily);
        if (cancelled) return;

        if (mapped.error) {
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(mapped.error);
          toast(mapped.error, true);
          return;
        }

        if (mapped.dimension === '2D' && mapped.scheme2D) {
          setActiveDimension('2D');
          if (mapped.canvasPatch2D) {
            setCanvasSpec(mapped.canvasPatch2D);
          }
          if (!loadedFamily && mapped.demands2D.length > 0) {
            setActiveDemands2D(mapped.demands2D);
          }
          const prevSchemes = getSchemes2D();
          const nextSchemes = [
            mapped.scheme2D,
            ...prevSchemes.filter((s) => s.id !== mapped.scheme2D!.id)
          ];
          setSchemes2D(nextSchemes, mapped.scheme2D.id);
          onDeeplinkHydratedDraft(mapped.taskId || inferredTaskId || 'scratch');
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(null);
        } else if (mapped.dimension === '1D' && mapped.scheme1D) {
          setActiveDimension('1D');
          if (mapped.slitPatch1D) {
            setSlitSpec({
              ...mapped.slitPatch1D,
              ...(!loadedFamily && mapped.slitOrders1D.length > 0
                ? { slitOrders: mapped.slitOrders1D }
                : {})
            });
          }
          const prevSlit = getSlitSchemes();
          const nextSlit = [
            mapped.scheme1D,
            ...prevSlit.filter((s) => s.id !== mapped.scheme1D!.id)
          ];
          setSlitSchemes(nextSlit);
          setActiveSlitScheme(mapped.scheme1D.id);
          onDeeplinkHydratedDraft(mapped.taskId || inferredTaskId || 'scratch');
          setExternalPlanBanner(mapped.banner);
          setExternalPlanError(null);
        }

        reloadReferenceData(mapped.taskId || inferredTaskId || null).catch(() => {});
      } catch (err: any) {
        if (cancelled) return;
        const msg = '加载外部试排方案失败：' + (err?.message || '请确认链接有效或服务已就绪');
        if (draft) {
          setExternalPlanBanner(mapResultContextToWorkbenchPlan(null, draft, loadedFamily).banner);
        }
        setExternalPlanError(msg);
        toast(msg, true);
      } finally {
        finished = true;
        if (!cancelled && hasExternalPlan) {
          setExternalPlanLoading(false);
        }
      }
    };

    hydrateFromDeeplink();

    return () => {
      cancelled = true;
      if (!finished && deeplinkLoadedKeyRef.current === deeplinkKey) {
        deeplinkLoadedKeyRef.current = '';
      }
    };
  }, [taskId, resultId, draftId, deeplinkNonce]);

  useEffect(() => {
    const curTaskId = activeDimension === '2D' ? loadedTaskId : slitLoadedTaskId;
    if (!curTaskId) {
      setTaskSchemes([]);
      setTaskReports([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      requestJSON(`/api/v2/schemes?taskId=${encodeURIComponent(curTaskId)}`).catch(() => []),
      requestJSON(
        `/api/v2/reconciliation/reports?limit=200&offset=0&taskId=${encodeURIComponent(curTaskId)}`
      ).catch(() => ({ items: [] }))
    ]).then(([schList, repPage]) => {
      if (cancelled) return;
      setTaskSchemes(Array.isArray(schList) ? schList : []);
      const repItems = Array.isArray(repPage?.items)
        ? repPage.items
        : Array.isArray(repPage)
        ? repPage
        : [];
      setTaskReports(repItems);
    });
    return () => {
      cancelled = true;
    };
  }, [activeDimension, loadedTaskId, slitLoadedTaskId]);

  const is2D = activeDimension === '2D';
  const activeSchemeDraftId = is2D ? activeScheme2D?.draftId : activeScheme1D?.draftId;
  const activeSchemeConfirmedId = is2D
    ? activeScheme2D?.confirmedSchemeId
    : activeScheme1D?.confirmedSchemeId;

  useEffect(() => {
    if (!activeSchemeDraftId || activeSchemeConfirmedId || externalPlanLoading) return;
    if (externalPlanBanner && externalPlanBanner.draftId === activeSchemeDraftId) return;
    let cancelled = false;
    fetchWorkbenchDraft(activeSchemeDraftId)
      .then((latest) => {
        if (cancelled) return;
        const mapped = mapResultContextToWorkbenchPlan(null, latest as WorkbenchSchemeDraftDto, null);
        setExternalPlanBanner(mapped.banner);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSchemeDraftId, activeSchemeConfirmedId, externalPlanLoading, externalPlanBanner?.draftId]);

  const activeDraftBlockedReason = useMemo(() => {
    return evaluateActiveDraftBlockedReason({
      draftId: activeSchemeDraftId,
      confirmedSchemeId: activeSchemeConfirmedId,
      banner: externalPlanBanner,
      nowMs: Date.now()
    });
  }, [activeSchemeDraftId, activeSchemeConfirmedId, externalPlanBanner, draftClockTick]);

  return {
    rolls,
    remnants,
    poolFamilies,
    taskSchemes,
    taskReports,
    reloadReferenceData,
    externalPlanLoading,
    externalPlanError,
    setExternalPlanError,
    externalPlanBanner,
    setExternalPlanBanner,
    externalPlanDismissed,
    setExternalPlanDismissed,
    siblingDrafts,
    draftInbox,
    activeDraftBlockedReason,
    syncExternalPlanBannerWithDraft
  };
}
