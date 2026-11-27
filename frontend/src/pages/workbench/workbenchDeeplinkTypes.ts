import type {
  CanvasSpecPatch,
  DemandItem,
  SavedScheme2D,
  SlittingOrderLine,
  SlittingSchemeRun
} from '../../store/studioTypes';
import type { SlittingProfile } from '../../store/studioSettings';

export interface WorkbenchJobSourceDto {
  taskId?: string | null;
  taskName?: string | null;
  actor?: string | null;
  dimension?: string | null;
  materialType?: string | null;
  materialId?: string | null;
  materialModel?: string | null;
  materialLabel?: string | null;
  materialRevision?: number | null;
  physicalWidthMm?: number | null;
  widthMm?: number | null;
  windowStartMm?: number | null;
  windowStartY?: number | null;
  windowLengthMm?: number | null;
  canvasLengthMm?: number | null;
  pieceGapMm?: number | null;
  rectGapPaddingMm?: number | null;
  trimStartMm?: number | null;
  processMode?: string | null;
  objective?: string | null;
  allowGapFill?: boolean | null;
  avoidDefects?: boolean | null;
  rollRevision?: number | null;
  taskRevision?: number | null;
  inventoryRevision?: number | null;
  strategyName?: string | null;
  strategyId?: string | null;
  scenarioId?: string | null;
  batchNo?: string | null;
  color?: string | null;
  [key: string]: unknown;
}

export interface WorkbenchTaskSummaryDto {
  id?: string | null;
  taskId?: string | null;
  name?: string | null;
  dimension?: string | null;
  materialModel?: string | null;
  externalRef?: string | null;
  orderedTotal?: number | null;
  plannedTotal?: number | null;
  completedTotal?: number | null;
  openTotal?: number | null;
  revision?: number | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface WorkbenchResultContextDto {
  resultId?: string | null;
  job?: {
    id?: string | null;
    state?: string | null;
    status?: string | null;
    phase?: string | null;
    createdAt?: string | null;
    finishedAt?: string | null;
    completedAt?: string | null;
    elapsedMs?: number | null;
    code?: string | null;
    message?: string | null;
    [key: string]: unknown;
  } | null;
  input?: {
    schemaVersion?: string | null;
    problemType?: string | null;
    clientRequestId?: string | null;
    problem?: any;
    strategy?: any;
    [key: string]: unknown;
  } | null;
  result?: any;
  source?: WorkbenchJobSourceDto | null;
  taskSummary?: WorkbenchTaskSummaryDto | null;
  workbenchUrl?: string | null;
}

export interface WorkbenchRiskCheckDto {
  code?: string | null;
  passed?: boolean | null;
  message?: string | null;
}

export interface WorkbenchSchemeDraftDto {
  id?: string | null;
  draftId?: string | null;
  status?: string | null;
  approvalToken?: string | null;
  contentHash?: string | null;
  issuedAt?: string | null;
  expiresAt?: string | null;
  ttlSeconds?: number | null;
  requiresHumanConfirmation?: boolean | null;
  inventoryMutated?: boolean | null;
  stale?: boolean | null;
  staleReasons?: string[] | null;
  note?: string | null;
  target?: {
    resultId?: string | null;
    taskId?: string | null;
    materialId?: string | null;
    materialType?: string | null;
  } | null;
  riskChecks?: WorkbenchRiskCheckDto[] | null;
  workbenchUrl?: string | null;
  nextStep?: string | null;
  batchGroupId?: string | null;
  batchIndex?: number | null;
  batchTotal?: number | null;
  confirmedSchemeId?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  discardedBy?: string | null;
  discardedAt?: string | null;
  discardReason?: string | null;
}

export interface ExternalPlanRiskCheck {
  code: string;
  passed: boolean;
  message: string;
}

export interface ExternalPlanBannerMeta {
  dimension: '2D' | '1D';
  resultId: string;
  draftId: string | null;
  taskId: string | null;
  taskName: string | null;
  status: string;
  expired: boolean;
  stale: boolean;
  staleReasons: string[];
  riskChecks: ExternalPlanRiskCheck[];
  failedRiskChecks: ExternalPlanRiskCheck[];
  note: string | null;
  materialLabel: string;
  fulfillmentStatus: string;
  fulfillmentLabel: string;
  expiresAt: string | null;
  nextStep: string | null;
  batchGroupId: string | null;
  batchIndex: number | null;
  batchTotal: number | null;
  confirmedSchemeId: string | null;
  confirmedAt: string | null;
  discardedAt: string | null;
  discardReason: string | null;
}

export interface WorkbenchSlitSpecPatch {
  slitMaterialMode?: 'VIRTUAL_ROLL' | 'STOCK_ROLL';
  slitRollId?: string;
  slitMotherWidthMm?: number;
  slitLeftTrimMm?: number;
  slitRightTrimMm?: number;
  slitMinWidthMm?: number;
  slitMaxWidthMm?: number;
  slitWidthStepMm?: number;
  slitWidthMode?: 'FIXED' | 'FLEXIBLE';
  slitOverCap?: number;
  slitFixedLengthMm?: number;
  slitProfile?: SlittingProfile;
  slitMaterialModel?: string;
  slitAvoidDefects?: boolean;
  slitMaxKnives?: number;
  slitMinBladeSpacingMm?: number;
  slitKerfMm?: number;
  slitForbiddenNarrowEdgeMinMm?: number;
  slitForbiddenNarrowEdgeMaxMm?: number;
  slitOrders?: SlittingOrderLine[];
}

export interface MappedWorkbenchDeeplinkPlan {
  dimension: '2D' | '1D';
  taskId: string | null;
  resultId: string;
  draftId: string | null;
  rectGapPaddingMm: number;
  scheme2D: SavedScheme2D | null;
  canvasPatch2D: CanvasSpecPatch | null;
  demands2D: DemandItem[];
  scheme1D: SlittingSchemeRun | null;
  slitPatch1D: WorkbenchSlitSpecPatch | null;
  slitOrders1D: SlittingOrderLine[];
  banner: ExternalPlanBannerMeta;
  error: string | null;
}

export interface MapDeeplinkPlanOptions {
  nowMs?: number;
  createdAtLabel?: string;
}
