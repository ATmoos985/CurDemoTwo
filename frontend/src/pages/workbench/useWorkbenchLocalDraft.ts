import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CanvasMode2D,
  DemandItem,
  SavedScheme2D,
  Scenario1DType,
  Scenario2DType,
  SlittingOrderLine
} from '../../store/studioTypes';
import type { SlittingProfile, SlittingWidthMode } from '../../store/studioSettings';
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WorkbenchDraftPayload
} from '../../store/workbenchDraft';

export interface UseWorkbenchLocalDraftParams {
  activeDraftTaskKey: string;
  activeDimension: '2D' | '1D';
  scenario2D: Scenario2DType;
  multiWidthsText2D: string;
  canvasMode: CanvasMode2D;
  canvasWidthMm: number;
  canvasLengthMm: number;
  windowStartY2D: number | null;
  pieceGapMm: number;
  trimStartMm: number;
  selectedRollId: string | null;
  selectedRemnantId: string | null;
  materialModel2D: string;
  activeDemands2D: DemandItem[];
  schemes2D: SavedScheme2D[];
  activeSchemeId2D: string | null;
  scenario1D: Scenario1DType;
  slitMaterialMode: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitWidthMode: SlittingWidthMode;
  slitProfile: SlittingProfile;
  slitMotherWidthMm: number;
  slitLeftTrimMm: number;
  slitRightTrimMm: number;
  slitMinWidthMm: number;
  slitMaxWidthMm: number;
  slitWidthStepMm: number;
  slitOverCap: number;
  slitFixedLengthMm: number;
  slitAvoidDefects: boolean;
  slitRollId: string | null;
  slitMaterialModel: string;
  slitOrders: SlittingOrderLine[];
  restoreWorkbenchDraft: (draft: WorkbenchDraftPayload) => void;
}

export function useWorkbenchLocalDraft(params: UseWorkbenchLocalDraftParams) {
  const {
    activeDraftTaskKey,
    activeDimension,
    scenario2D,
    multiWidthsText2D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    selectedRemnantId,
    materialModel2D,
    activeDemands2D,
    schemes2D,
    activeSchemeId2D,
    scenario1D,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitMaterialModel,
    slitOrders,
    restoreWorkbenchDraft
  } = params;

  const [recoverableDraft, setRecoverableDraft] = useState<WorkbenchDraftPayload | null>(null);
  const draftHydratedKeyRef = useRef<string>('');
  const allowAutoSaveRef = useRef<boolean>(false);

  const markDraftHydratedClean = useCallback((draftKey: string) => {
    draftHydratedKeyRef.current = draftKey;
    setRecoverableDraft(null);
    allowAutoSaveRef.current = true;
  }, []);

  // 进入工作台或切换 taskId 时检测该 taskId 隔离的本机草稿
  useEffect(() => {
    if (draftHydratedKeyRef.current === activeDraftTaskKey) return;
    draftHydratedKeyRef.current = activeDraftTaskKey;
    allowAutoSaveRef.current = false;
    const found = loadWorkbenchDraft(activeDraftTaskKey);
    if (
      found &&
      ((found.unconfirmedSchemes2D && found.unconfirmedSchemes2D.length > 0) ||
        (found.activeDemands2D && found.activeDemands2D.length > 0) ||
        (found.slitOrders && found.slitOrders.length > 0))
    ) {
      setRecoverableDraft(found);
    } else {
      setRecoverableDraft(null);
      allowAutoSaveRef.current = true;
    }
  }, [activeDraftTaskKey]);

  // 防抖自动保存当前未落库状态至按 taskId 隔离的 localStorage 草稿
  useEffect(() => {
    if (!allowAutoSaveRef.current) return;
    const timer = window.setTimeout(() => {
      saveWorkbenchDraft(activeDraftTaskKey, {
        activeDimension,
        scenario2D,
        multiWidthsText2D,
        canvasMode: canvasMode === 'MULTI_MATERIAL' ? 'FREE_CANVAS' : canvasMode,
        canvasWidthMm,
        canvasLengthMm,
        windowStartY2D,
        pieceGapMm,
        trimStartMm,
        selectedRollId,
        selectedRemnantId,
        materialModel2D,
        activeDemands2D,
        unconfirmedSchemes2D: schemes2D.filter((s) => !s.confirmedSchemeId),
        activeSchemeId2D,
        scenario1D,
        slitMaterialMode,
        slitWidthMode,
        slitProfile,
        slitMotherWidthMm,
        slitLeftTrimMm,
        slitRightTrimMm,
        slitMinWidthMm,
        slitMaxWidthMm,
        slitWidthStepMm,
        slitOverCap,
        slitFixedLengthMm,
        slitAvoidDefects,
        slitRollId,
        slitMaterialModel,
        slitOrders
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    activeDraftTaskKey,
    activeDimension,
    scenario2D,
    multiWidthsText2D,
    canvasMode,
    canvasWidthMm,
    canvasLengthMm,
    windowStartY2D,
    pieceGapMm,
    trimStartMm,
    selectedRollId,
    selectedRemnantId,
    materialModel2D,
    activeDemands2D,
    schemes2D,
    activeSchemeId2D,
    scenario1D,
    slitMaterialMode,
    slitWidthMode,
    slitProfile,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitMaterialModel,
    slitOrders
  ]);

  const clearLocalDraftForTask = useCallback(() => {
    clearWorkbenchDraft(activeDraftTaskKey);
    setRecoverableDraft(null);
  }, [activeDraftTaskKey]);

  const handleRestoreLocalDraft = useCallback(() => {
    if (!recoverableDraft) return;
    restoreWorkbenchDraft(recoverableDraft);
    setRecoverableDraft(null);
    allowAutoSaveRef.current = true;
  }, [recoverableDraft, restoreWorkbenchDraft]);

  const handleIgnoreLocalDraft = useCallback(() => {
    clearWorkbenchDraft(activeDraftTaskKey);
    setRecoverableDraft(null);
    allowAutoSaveRef.current = true;
  }, [activeDraftTaskKey]);

  return {
    recoverableDraft,
    markDraftHydratedClean,
    clearLocalDraftForTask,
    handleRestoreLocalDraft,
    handleIgnoreLocalDraft
  };
}
