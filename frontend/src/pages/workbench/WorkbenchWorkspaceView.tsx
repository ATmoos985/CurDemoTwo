import React from 'react';
import { toast } from '../../lib/core/util.js';
import type { WorkbenchDraftPayload } from '../../store/workbenchDraft';
import { WorkbenchTopBar } from './WorkbenchTopBar';
import { WorkbenchDemandSidebar } from './WorkbenchDemandSidebar';
import { WorkbenchCenterPanel } from './WorkbenchCenterPanel';
import { WorkbenchRightPanel } from './WorkbenchRightPanel';
import { DemandOverviewModal } from './DemandOverviewModal';
import { ExternalPlanBanner } from './ExternalPlanBanner';
import { DraftInboxDrawer } from './DraftInboxDrawer';
import { DraftDiscardDialog } from './DraftDiscardDialog';
import {
  BatchGuardBanner,
  LocalDraftRecoveryBanner,
  TaskExecutionSyncBar
} from './WorkbenchStatusBanners';
import {
  WorkbenchSwitchConfirmModal,
  type PendingConfirmAction
} from './WorkbenchSwitchConfirmModal';
import type {
  BatchGuardWarning,
  SchemeExecutionSummary,
  TaskExecutionProjection
} from './workbenchProjectionUtils';
import type { ExternalPlanBannerMeta } from './workbenchDeeplinkUtils';
import type { WorkbenchDraftDto } from './draftInboxApi';

export interface WorkbenchWorkspaceViewProps {
  splitCls: string;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  is2D: boolean;
  activeScheme2D: any;
  activeScheme1D: any;
  setCanvasSpec: (spec: Record<string, any>) => void;
  setSlitSpec: (spec: Record<string, any>) => void;
  externalPlanLoading: boolean;
  externalPlanError: string | null;
  setExternalPlanError: (err: string | null) => void;
  externalPlanBanner: ExternalPlanBannerMeta | null;
  externalPlanDismissed: boolean;
  setExternalPlanDismissed: (v: boolean) => void;
  siblingDrafts: WorkbenchDraftDto[];
  draftInbox: any;
  batchGuardWarning: BatchGuardWarning | null;
  taskExecutionProjection: TaskExecutionProjection | null;
  activeSchemeExecution: SchemeExecutionSummary | null;
  recoverableDraft: WorkbenchDraftPayload | null;
  onRestoreLocalDraft: () => void;
  onIgnoreLocalDraft: () => void;
  pendingConfirm: PendingConfirmAction | null;
  onClearPendingConfirm: () => void;
  topBarProps: React.ComponentProps<typeof WorkbenchTopBar>;
  sidebarProps: React.ComponentProps<typeof WorkbenchDemandSidebar>;
  centerProps: React.ComponentProps<typeof WorkbenchCenterPanel>;
  rightProps: React.ComponentProps<typeof WorkbenchRightPanel>;
  overviewModalProps: React.ComponentProps<typeof DemandOverviewModal>;
}

export const WorkbenchWorkspaceView: React.FC<WorkbenchWorkspaceViewProps> = ({
  splitCls,
  leftCollapsed,
  rightCollapsed,
  is2D,
  activeScheme2D,
  activeScheme1D,
  setCanvasSpec,
  setSlitSpec,
  externalPlanLoading,
  externalPlanError,
  setExternalPlanError,
  externalPlanBanner,
  externalPlanDismissed,
  setExternalPlanDismissed,
  siblingDrafts,
  draftInbox,
  batchGuardWarning,
  taskExecutionProjection,
  activeSchemeExecution,
  recoverableDraft,
  onRestoreLocalDraft,
  onIgnoreLocalDraft,
  pendingConfirm,
  onClearPendingConfirm,
  topBarProps,
  sidebarProps,
  centerProps,
  rightProps,
  overviewModalProps
}) => {
  return (
    <div className="react-page studio-2d-page wb-v2">
      <WorkbenchTopBar {...topBarProps} />

      {!externalPlanDismissed && (externalPlanLoading || externalPlanError || externalPlanBanner) && (
        <ExternalPlanBanner
          loading={externalPlanLoading}
          error={externalPlanError}
          banner={externalPlanBanner}
          confirmedSchemeId={
            externalPlanBanner
              ? is2D
                ? activeScheme2D?.id === `EXT-2D-${externalPlanBanner.resultId}`
                  ? activeScheme2D.confirmedSchemeId || null
                  : null
                : activeScheme1D?.id === `EXT-1D-${externalPlanBanner.resultId}`
                ? activeScheme1D.confirmedSchemeId || null
                : null
              : null
          }
          siblingDrafts={siblingDrafts}
          onSelectDraft={draftInbox.previewDraft}
          onDiscardDraft={(targetDraftId) => {
            const matched =
              siblingDrafts.find((d) => (d.draftId || d.id) === targetDraftId) ||
              draftInbox.drafts.find((d: any) => (d.draftId || d.id) === targetDraftId);
            if (matched) {
              draftInbox.openDiscardDialog(matched);
            } else if (externalPlanBanner) {
              draftInbox.openDiscardDialog({
                id: targetDraftId,
                draftId: targetDraftId,
                status: externalPlanBanner.status,
                issuedAt: '',
                expiresAt: externalPlanBanner.expiresAt || '',
                stale: externalPlanBanner.stale,
                staleReasons: externalPlanBanner.staleReasons,
                target: {
                  resultId: externalPlanBanner.resultId,
                  taskId: externalPlanBanner.taskId
                },
                riskChecks: externalPlanBanner.riskChecks
              });
            }
          }}
          onDismiss={() => {
            setExternalPlanDismissed(true);
            setExternalPlanError(null);
          }}
        />
      )}

      {batchGuardWarning && (
        <BatchGuardBanner
          warning={batchGuardWarning}
          onSelectSuggestedRoll={(sr) => {
            if (is2D) {
              setCanvasSpec({
                canvasMode: 'STOCK_ROLL',
                selectedRollId: sr.rollId,
                canvasWidthMm: sr.width,
                materialModel2D: sr.rollModel,
                windowStartY2D: null
              });
            } else {
              setSlitSpec({
                slitMaterialMode: 'STOCK_ROLL',
                selectedRollId: sr.rollId,
                slitMotherWidthMm: sr.width,
                slitMaterialModel: sr.rollModel
              });
            }
            toast(`已切换至同缸匹配母卷 ${sr.rollId}（缸号 ${sr.batchNo}）`);
          }}
        />
      )}

      {taskExecutionProjection &&
        (taskExecutionProjection.reportCount > 0 ||
          taskExecutionProjection.reinspectionDisposedTotal > 0) && (
          <TaskExecutionSyncBar
            projection={taskExecutionProjection}
            is2D={is2D}
            hasConfirmedActive2D={Boolean(activeScheme2D?.confirmedSchemeId)}
            activeSchemeExecution={activeSchemeExecution}
          />
        )}

      {recoverableDraft && (
        <LocalDraftRecoveryBanner
          draft={recoverableDraft}
          onRestore={() => {
            onRestoreLocalDraft();
            toast('已恢复本机工作台草稿');
          }}
          onIgnore={onIgnoreLocalDraft}
        />
      )}

      <div className={splitCls}>
        {!leftCollapsed && <WorkbenchDemandSidebar {...sidebarProps} />}
        <WorkbenchCenterPanel {...centerProps} />
        {!rightCollapsed && <WorkbenchRightPanel {...rightProps} />}
      </div>

      <WorkbenchSwitchConfirmModal
        pendingConfirm={pendingConfirm}
        onCancel={onClearPendingConfirm}
        onConfirm={() => {
          const fn = pendingConfirm?.action;
          onClearPendingConfirm();
          fn?.();
        }}
      />

      <DemandOverviewModal {...overviewModalProps} />

      <DraftInboxDrawer
        open={draftInbox.drawerOpen}
        drafts={draftInbox.drafts}
        total={draftInbox.total}
        pendingCount={draftInbox.pendingCount}
        statusFilter={draftInbox.statusFilter}
        batchGroupFilter={draftInbox.batchGroupFilter}
        activeDraftId={draftInbox.activeDraftId}
        loading={draftInbox.loading}
        loadingMore={draftInbox.loadingMore}
        error={draftInbox.error}
        onClose={draftInbox.closeDrawer}
        onRefresh={() => draftInbox.refreshDraftInbox()}
        onLoadMore={draftInbox.loadMoreDrafts}
        onChangeStatusFilter={draftInbox.changeStatusFilter}
        onClearBatchGroupFilter={draftInbox.clearBatchGroupFilter}
        onPreviewDraft={draftInbox.previewDraft}
        onDiscardDraft={draftInbox.openDiscardDialog}
      />

      <DraftDiscardDialog
        draft={draftInbox.discardTarget}
        submitting={draftInbox.discardSubmitting}
        onClose={draftInbox.closeDiscardDialog}
        onConfirmDiscard={draftInbox.submitDiscard}
      />
    </div>
  );
};
