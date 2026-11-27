import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { CadCanvasView } from '../../components/CadCanvasView';
import { SlittingStripBar } from '../CuttingWorkbenchPage';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { OperationFeedbackCard } from '../../components/OperationFeedbackCard';
import type { ExportSlittingFormat } from '../../utils/exportApiClient';
import { STATE_BADGE, sanitizeSchemeTitle } from './resultsSceneUtils';

export interface ResultsDetailPanelProps {
  activeEntry: any;
  activeScheme: any;
  busy: boolean;
  canGenerateReplenish: boolean;
  schemeReversal: { showAction: boolean; eligible: boolean; reason?: string };
  taskOpenMap: Record<string, number>;
  createdReplenishTask: { id: string; name?: string } | null;
  matchingPassedRolls: any[];
  matchingPendingRolls: any[];
  rolls: any[];
  bindRollId: string;
  onSetBindRollId: (id: string) => void;
  newRollCode: string;
  onSetNewRollCode: (v: string) => void;
  pendingCreatedRollId: string;
  onOpenQuickComplete: () => void;
  onOpenCompleteModal: () => void;
  onDispatchMes: () => void;
  onOpenReplenishModal: () => void;
  onOpenReverseModal: () => void;
  onOpenCancelConfirm: () => void;
  onBindStockRoll: (autoCreate: boolean) => void;
  onExport2DCamLocal: (kind: 'dxf' | 'nc') => void;
  onExportSlitLocalCsv: () => void;
  onExportExcelLocal: () => void;
  onOpenCamExportModal: () => void;
  slitExportFormat: ExportSlittingFormat;
  onSetSlitExportFormat: (fmt: ExportSlittingFormat) => void;
  onDownloadSlittingServer: () => void;
  onDownloadTicketPdfServer: () => void;
  onOpenTicketModal: () => void;
  exportError: { title: string; message: string; status?: number; traceId?: string } | null;
  onDismissExportError: () => void;
  replayScene2D: any;
  vertical: boolean;
  onToggleVertical: () => void;
  showPath: boolean;
  onToggleShowPath: () => void;
  canvasRef: React.MutableRefObject<any>;
}

export const ResultsDetailPanel: React.FC<ResultsDetailPanelProps> = ({
  activeEntry,
  activeScheme,
  busy,
  canGenerateReplenish,
  schemeReversal,
  createdReplenishTask,
  matchingPassedRolls,
  matchingPendingRolls,
  rolls,
  bindRollId,
  onSetBindRollId,
  newRollCode,
  onSetNewRollCode,
  pendingCreatedRollId,
  onOpenQuickComplete,
  onOpenCompleteModal,
  onDispatchMes,
  onOpenReplenishModal,
  onOpenReverseModal,
  onOpenCancelConfirm,
  onBindStockRoll,
  onExport2DCamLocal,
  onExportSlitLocalCsv,
  onExportExcelLocal,
  onOpenCamExportModal,
  slitExportFormat,
  onSetSlitExportFormat,
  onDownloadSlittingServer,
  onDownloadTicketPdfServer,
  onOpenTicketModal,
  exportError,
  onDismissExportError,
  replayScene2D,
  vertical,
  onToggleVertical,
  showPath,
  onToggleShowPath,
  canvasRef
}) => {
  if (!activeScheme) return null;

  return (
    <>
      <div className="mp-res-detail-card">
        <div className="mp-res-detail-head">
          <div className="mp-res-detail-identity">
            <div className="mp-res-detail-title-row">
              <h2 className="mp-res-detail-title">{sanitizeSchemeTitle(activeScheme.title)}</h2>
              <CodeBadge>{activeScheme.id}</CodeBadge>
              <span className={`tag ${STATE_BADGE[activeScheme.state]?.cls || ''}`}>
                {STATE_BADGE[activeScheme.state]?.label || activeScheme.state}
              </span>
              <span className="tag kind">
                {activeScheme.dimension === 'SLITTING_1D'
                  ? '一维定长分切'
                  : activeScheme.dimension === 'CONTOUR_2D'
                  ? '二维异形排料'
                  : '二维矩形开料'}
              </span>
            </div>
            <div className="mp-res-detail-subtitle num">
              关联需求族「{activeScheme.taskName}」 · 创建于 {activeScheme.createdAt}
            </div>
          </div>

          <div className="mp-res-detail-actions">
            {activeEntry.canComplete && (
              <>
                <button type="button" className="btn pri" disabled={busy} onClick={onOpenQuickComplete}>
                  一键完工记账
                </button>
                <button type="button" className="btn" disabled={busy} onClick={onOpenCompleteModal}>
                  明细核销 (登记异常/余料)
                </button>
              </>
            )}
            {(activeScheme.state === 'READY_TO_CUT' || activeScheme.state === 'DISPATCHED_MES') && (
              <button type="button" className="btn" disabled={busy} onClick={onDispatchMes}>
                {activeScheme.state === 'DISPATCHED_MES' ? '重新导出 MES 派工包' : '下发 MES 派工单'}
              </button>
            )}
            {canGenerateReplenish && (
              <button
                type="button"
                className="btn soft-accent"
                disabled={busy}
                onClick={onOpenReplenishModal}
                title="按源方案母卷缸号/色号一键创建高优同缸加急补片任务"
              >
                一键生成同缸加急补片单
              </button>
            )}
            {schemeReversal.showAction && (
              <button
                type="button"
                className="mp-ghost-btn mp-btn-danger-ghost"
                disabled={busy || !schemeReversal.eligible}
                onClick={onOpenReverseModal}
                title={
                  schemeReversal.eligible
                    ? '冲销已完工报工，恢复母卷/料头消耗并回滚订单完成量'
                    : schemeReversal.reason
                }
              >
                冲销报工
              </button>
            )}
            {activeEntry.canCancel && (
              <button
                type="button"
                className="mp-ghost-btn mp-btn-danger-ghost"
                disabled={busy}
                onClick={onOpenCancelConfirm}
              >
                作废并退回需求
              </button>
            )}
          </div>
        </div>

        <div className="mp-res-spec-grid num">
          <div className="mp-res-spec-cell">
            <small>物料品号</small>
            <b title={activeScheme.materialModel}>{activeScheme.materialModel}</b>
          </div>
          <div className="mp-res-spec-cell">
            <small>门幅 × 实占总长</small>
            <b>
              {activeScheme.widthMm} × {fmtN(activeScheme.occupiedLengthMm, 1)} mm
            </b>
          </div>
          <div className="mp-res-spec-cell">
            <small>净材料利用率</small>
            <b className="is-ok">{activeScheme.utilizationPct}%</b>
          </div>
          <div className="mp-res-spec-cell">
            <small>排入产出</small>
            <b>
              {activeScheme.placedCount} / {activeScheme.requestedCount}
            </b>
          </div>
          <div className="mp-res-spec-cell">
            <small>母卷绑定状态</small>
            {activeScheme.rollId ? (
              <b
                className="is-accent"
                title={`实卷 ${activeScheme.rollId} (Y=${fmtN(activeScheme.windowStartY)}~${fmtN(
                  activeScheme.windowStartY + activeScheme.occupiedLengthMm
                )} mm)`}
              >
                {activeScheme.rollId} · Y{fmtN(activeScheme.windowStartY, 0)}~
                {fmtN(activeScheme.windowStartY + activeScheme.occupiedLengthMm, 0)}
              </b>
            ) : (
              <b>待绑实卷</b>
            )}
          </div>
        </div>

        <div className="mp-res-export-bar">
          <span className="mp-res-export-label">结果交付与导出</span>
          {activeScheme.dimension !== 'SLITTING_1D' ? (
            <>
              <button type="button" className="btn sm" onClick={() => onExport2DCamLocal('dxf')}>
                导出 CAD DXF
              </button>
              <button type="button" className="btn sm" onClick={() => onExport2DCamLocal('nc')}>
                导出 CNC G-Code (.nc)
              </button>
              <button
                type="button"
                className="btn sm soft-accent"
                data-testid="res-open-cam-export-modal-btn"
                onClick={onOpenCamExportModal}
              >
                CAM / 工艺导出设置
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn sm" onClick={onExportSlitLocalCsv}>
                导出分切机排刀配方 (.csv)
              </button>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <select
                  className="field"
                  style={{ height: 28, fontSize: 12 }}
                  aria-label="服务端分切导出格式"
                  data-testid="res-slitting-export-format-select"
                  value={slitExportFormat}
                  onChange={(e) => onSetSlitExportFormat(e.target.value as ExportSlittingFormat)}
                >
                  <option value="xlsx">XLSX</option>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                </select>
                <button
                  type="button"
                  className="btn sm soft-accent"
                  data-testid="res-slitting-export-btn"
                  disabled={busy}
                  onClick={onDownloadSlittingServer}
                >
                  服务端分切导出
                </button>
              </div>
            </>
          )}
          <button type="button" className="btn sm" onClick={onExportExcelLocal}>
            导出 Excel 用料与排程表
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid="res-ticket-pdf-download-btn"
            disabled={busy}
            onClick={onDownloadTicketPdfServer}
          >
            下载随工单 PDF
          </button>
          <button type="button" className="btn sm soft-accent" onClick={onOpenTicketModal}>
            打印 A4 车间派工裁切单
          </button>
          {activeScheme.rollId && (
            <a
              className="mp-ghost-btn mp-ghost-sm"
              href={`#/inventory?roll=${encodeURIComponent(activeScheme.rollId)}`}
            >
              在库存查看母卷切割区
            </a>
          )}
        </div>

        {exportError && (
          <div style={{ marginTop: 8 }}>
            <OperationFeedbackCard
              tone="err"
              testId="export-error-banner"
              title={exportError.title}
              message={exportError.message}
              traceId={exportError.traceId}
              actions={[
                ...(exportError.status === 401
                  ? [{ label: '前往登录', primary: true, onClick: () => { location.hash = '#/login'; } }]
                  : []),
                { label: '关闭提示', onClick: onDismissExportError }
              ]}
            />
          </div>
        )}

        {createdReplenishTask && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(5, 150, 105, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              fontSize: 12
            }}
          >
            <span>
              <span className="tag ok" style={{ marginRight: 6 }}>
                补片单已生成
              </span>
              同缸加急补片任务 <b className="num">{createdReplenishTask.name || createdReplenishTask.id}</b>{' '}
              已加入需求池（URGENT · 同缸强约束）。
            </span>
            <a className="btn sm soft-accent" href="#/demand-library">
              前往需求库排补片 →
            </a>
          </div>
        )}
      </div>

      {activeEntry.canBindRoll && (
        <div className="mp-res-bind-card">
          <div className="mp-res-bind-head">
            <span className="tag warn">待备料绑卷</span>
            <span>
              <strong>虚拟新母卷方案</strong> · 建议备料品号 <b className="num">{activeScheme.materialModel}</b>、净门幅{' '}
              <b className="num">{activeScheme.widthMm} mm</b>、最小可用长度{' '}
              <b className="num">
                {fmtN(activeScheme.suggestedRoll?.minLengthMm || activeScheme.occupiedLengthMm)} mm
              </b>
              。绑定真实母卷后即可一键完工核销或校验实卷疵点。
            </span>
          </div>
          <div className="mp-res-bind-controls">
            {matchingPassedRolls.length > 0 ? (
              <>
                <select
                  className="field mp-res-bind-select"
                  aria-label="选择在库合格母卷"
                  value={bindRollId}
                  onChange={(e) => onSetBindRollId(e.target.value)}
                >
                  {matchingPassedRolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      在库合格卷：{r.rollId} · {r.rollModel} (余{fmtM(r.currentRemainingLength)}m · 疵{(r.defects || []).length}处)
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn sm pri"
                  disabled={busy || !bindRollId}
                  onClick={() => onBindStockRoll(false)}
                >
                  绑定所选在库母卷并校验疵点
                </button>
                <span className="mp-toolbar-count">或</span>
              </>
            ) : (
              <span className="mp-toolbar-count">
                当前暂无同幅宽 ({activeScheme.widthMm}mm) 合格母卷，可直接按建议规格建档入库：
              </span>
            )}
            <input
              className="field num mp-res-bind-input"
              style={{ height: 28 }}
              placeholder="新母卷条码 (可留空自动生成)"
              value={newRollCode}
              onChange={(e) => onSetNewRollCode(e.target.value)}
            />
            <button
              type="button"
              className={`btn sm ${matchingPassedRolls.length > 0 ? 'soft-accent' : 'pri'}`}
              disabled={busy}
              onClick={() => onBindStockRoll(true)}
            >
              ＋ 按方案规格新建待检母卷
            </button>
          </div>
          {(pendingCreatedRollId || matchingPendingRolls.length > 0) &&
            (() => {
              const focusPendingId =
                pendingCreatedRollId &&
                rolls.some((r) => r.rollId === pendingCreatedRollId && r.inspectionStatus === 'PENDING')
                  ? pendingCreatedRollId
                  : matchingPendingRolls[0]?.rollId || pendingCreatedRollId;
              if (!focusPendingId) return null;
              return (
                <div
                  className="mp-res-pending-roll-hint"
                  data-pending-roll-id={focusPendingId}
                  style={{
                    marginTop: 8,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap',
                    fontSize: 12
                  }}
                >
                  <span>
                    <span className="tag warn" style={{ marginRight: 6 }}>
                      待质检放行
                    </span>
                    母卷 <b className="num">{focusPendingId}</b> 已按方案规格入库（状态 PENDING），须完成跑布验疵并质检放行后，再刷新并选择该合格卷执行锁卷绑定。
                  </span>
                  <a className="mp-ghost-btn mp-ghost-sm" href={`#/inspection/${encodeURIComponent(focusPendingId)}`}>
                    前往跑布验疵放行 →
                  </a>
                </div>
              );
            })()}
        </div>
      )}

      {activeScheme.dimension !== 'SLITTING_1D' && replayScene2D ? (
        <div className="mp-res-cad-card">
          <div className="ctool">
            <span style={{ fontSize: 12, fontWeight: 600 }}>1:1 排料图纸与走刀复盘</span>
            <span className="div" />
            <button type="button" onClick={() => canvasRef.current?.fit()}>
              居中适配
            </button>
            <button type="button" aria-pressed={!vertical} onClick={onToggleVertical}>
              {vertical ? '竖排' : '横排'}
            </button>
            <button type="button" aria-pressed={showPath} onClick={onToggleShowPath}>
              切割刀路
            </button>
            <span className="sp" />
            <span className="num ctool-readout">
              排入 {activeScheme.placedCount} 件 · 净面积 {activeScheme.pieceAreaM2} m²
            </span>
          </div>
          <div className="mp-res-cad-viewport">
            <CadCanvasView
              scene={replayScene2D}
              vertical={vertical}
              showPath={showPath}
              showDimensions={true}
              canvasRefOut={canvasRef}
            />
          </div>
        </div>
      ) : activeScheme.slitting1D ? (
        <div className="mp-res-slit-card">
          <div className="mp-res-pane-head">
            <span>一维分切刀组与订单履约明细</span>
            <span className="mp-toolbar-count num">共 {activeScheme.slitting1D.totalCars} 车</span>
          </div>
          <div className="slit-patterns-list">
            {(() => {
              const allWidths: number[] = [];
              for (const pat of activeScheme.slitting1D.patterns || []) {
                for (const st of pat.stations || []) {
                  if (st.widthMm > 0) allWidths.push(st.widthMm);
                }
              }
              const minW = allWidths.length ? Math.min(...allWidths) : 0;
              const maxW = allWidths.length ? Math.max(...allWidths) : 0;
              return activeScheme.slitting1D.patterns.map((p: any, idx: number) => (
                <div key={p.id || idx} className="slit-pattern-row">
                  <div className="slit-pattern-meta">
                    <span className="tag kind">组 {idx + 1}</span>
                    <b className="num">{p.repetitions} 车</b>
                    <span className="num">
                      {p.stations.map((s: any) => `${s.widthMm}×${s.countPerRepetition}`).join(' + ')}
                    </span>
                    <span className="sp" />
                    <span className="num muted">
                      已切 {p.usedWidthMm} mm · 余 {p.spareWidthMm} mm
                    </span>
                  </div>
                  <SlittingStripBar
                    motherWidthMm={activeScheme.widthMm}
                    leftTrimMm={activeScheme.slitting1D.leftTrimMm}
                    rightTrimMm={activeScheme.slitting1D.rightTrimMm}
                    stations={p.stations}
                    minWidthMm={minW}
                    maxWidthMm={maxW}
                  />
                </div>
              ));
            })()}
          </div>
        </div>
      ) : null}
    </>
  );
};
