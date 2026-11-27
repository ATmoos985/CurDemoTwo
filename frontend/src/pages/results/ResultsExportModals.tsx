import React, { useState } from 'react';
import { toast } from '../../lib/core/util.js';
import { ModalDialog } from '../../components/ModalDialog';
import { OperationFeedbackCard } from '../../components/OperationFeedbackCard';
import { AuthSession } from '../../utils/authClient';
import {
  BatchZipFormat,
  CamExportOptionsDto,
  DEFAULT_CAM_EXPORT_OPTIONS,
  ExportCamFormat,
  ExportSummaryFormat,
  canUseBatchZipExport,
  downloadBatchExportZip,
  downloadProductionSummary,
  downloadSchemeCamExport,
  formatExportError
} from '../../utils/exportApiClient';
import {
  BATCH_ZIP_FORMAT_OPTIONS,
  CAM_FORMAT_OPTIONS,
  validateBatchZipSelection
} from './resultsSceneUtils';

export interface ResultsExportModalsProps {
  auth?: AuthSession | null;
  activeScheme: any;
  camModalOpen: boolean;
  onCloseCamModal: () => void;
  batchZipModalOpen: boolean;
  onCloseBatchZipModal: () => void;
  checkedSchemeIds: string[];
  summaryModalOpen: boolean;
  onCloseSummaryModal: () => void;
  defaultTaskId?: string;
}

export const ResultsExportModals: React.FC<ResultsExportModalsProps> = ({
  auth,
  activeScheme,
  camModalOpen,
  onCloseCamModal,
  batchZipModalOpen,
  onCloseBatchZipModal,
  checkedSchemeIds,
  summaryModalOpen,
  onCloseSummaryModal,
  defaultTaskId = ''
}) => {
  const [camFormat, setCamFormat] = useState<ExportCamFormat>('dxf_lwpolyline');
  const [camOpts, setCamOpts] = useState<CamExportOptionsDto>(DEFAULT_CAM_EXPORT_OPTIONS);
  const [camBusy, setCamBusy] = useState(false);
  const [camError, setCamError] = useState<{ title: string; message: string; traceId?: string; status?: number } | null>(null);

  const [zipFormats, setZipFormats] = useState<BatchZipFormat[]>([
    'dxf_lwpolyline',
    'nc',
    'ticket_pdf'
  ]);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState<{ title: string; message: string; traceId?: string; status?: number } | null>(null);
  const allowBatchZip = canUseBatchZipExport(auth);

  const [summaryFormat, setSummaryFormat] = useState<ExportSummaryFormat>('xlsx');
  const [summaryTaskId, setSummaryTaskId] = useState(defaultTaskId);
  const [summaryState, setSummaryState] = useState('');
  const [summaryFrom, setSummaryFrom] = useState('');
  const [summaryTo, setSummaryTo] = useState('');
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<{ title: string; message: string; traceId?: string; status?: number } | null>(null);

  const handleCamSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeScheme || camBusy) return;
    setCamBusy(true);
    setCamError(null);
    try {
      const res = await downloadSchemeCamExport(activeScheme.id, camFormat, camOpts);
      toast(`已导出 CAM 文件：${res.fileName}`);
      onCloseCamModal();
    } catch (err) {
      setCamError(formatExportError(err));
    } finally {
      setCamBusy(false);
    }
  };

  const handleBatchZipSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!allowBatchZip || zipBusy) return;
    const check = validateBatchZipSelection(checkedSchemeIds, zipFormats);
    if (!check.valid) {
      setZipError({ title: '参数校验失败', message: check.reason || '请检查勾选项' });
      return;
    }
    setZipBusy(true);
    setZipError(null);
    try {
      const res = await downloadBatchExportZip({
        schemeIds: checkedSchemeIds,
        formats: zipFormats,
        camOptions: camOpts
      });
      toast(`已导出批量压缩包：${res.fileName}（${checkedSchemeIds.length} 个方案）`);
      onCloseBatchZipModal();
    } catch (err) {
      setZipError(formatExportError(err));
    } finally {
      setZipBusy(false);
    }
  };

  const handleSummarySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (summaryBusy) return;
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      const res = await downloadProductionSummary(summaryFormat, {
        taskId: summaryTaskId,
        state: summaryState,
        from: summaryFrom,
        to: summaryTo
      });
      toast(`已下载生产汇总报表：${res.fileName}`);
      onCloseSummaryModal();
    } catch (err) {
      setSummaryError(formatExportError(err));
    } finally {
      setSummaryBusy(false);
    }
  };

  const toggleZipFormat = (fmt: BatchZipFormat, checked: boolean) => {
    setZipFormats((prev) =>
      checked ? [...new Set([...prev, fmt])] : prev.filter((x) => x !== fmt)
    );
  };

  return (
    <>
      <ModalDialog
        open={camModalOpen}
        title={`CAM / 工艺导出设置 · ${activeScheme?.id || ''}`}
        onClose={() => {
          if (!camBusy) onCloseCamModal();
        }}
        maxWidth={600}
      >
        <form onSubmit={handleCamSubmit} data-testid="res-cam-export-modal">
          <div className="form" style={{ gridTemplateColumns: '140px 1fr', padding: '4px 0 12px' }}>
            <label htmlFor="res-cam-format">目标工业格式</label>
            <select
              id="res-cam-format"
              className="field"
              data-testid="res-cam-format-select"
              value={camFormat}
              onChange={(e) => setCamFormat(e.target.value as ExportCamFormat)}
            >
              {CAM_FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <label htmlFor="res-cam-overcut">过切补偿 (mm)</label>
            <input
              id="res-cam-overcut"
              type="number"
              step={0.1}
              min={0}
              max={20}
              className="field num"
              data-testid="res-cam-overcut-input"
              value={camOpts.overcutMm}
              onChange={(e) => setCamOpts({ ...camOpts, overcutMm: Number(e.target.value) || 0 })}
            />

            <label htmlFor="res-cam-leadin">引入线长度 (mm)</label>
            <input
              id="res-cam-leadin"
              type="number"
              step={0.1}
              min={0}
              max={100}
              className="field num"
              data-testid="res-cam-leadin-input"
              value={camOpts.leadInMm}
              onChange={(e) => setCamOpts({ ...camOpts, leadInMm: Number(e.target.value) || 0 })}
            />

            <label htmlFor="res-cam-microjoint">微连桥宽度 (mm)</label>
            <input
              id="res-cam-microjoint"
              type="number"
              step={0.1}
              min={0}
              max={50}
              className="field num"
              data-testid="res-cam-microjoint-input"
              value={camOpts.microJointWidthMm}
              onChange={(e) =>
                setCamOpts({ ...camOpts, microJointWidthMm: Number(e.target.value) || 0 })
              }
            />

            <label>共边去重</label>
            <label className="mp-modal-switch-row">
              <input
                type="checkbox"
                className="ux-switch"
                data-testid="res-cam-dedup-checkbox"
                checked={camOpts.deduplicateCommonEdges}
                onChange={(e) =>
                  setCamOpts({ ...camOpts, deduplicateCommonEdges: e.target.checked })
                }
              />
              <span>自动去除共边重复走刀轨迹</span>
            </label>

            <label htmlFor="res-cam-cut-tool">切割刀头代码</label>
            <input
              id="res-cam-cut-tool"
              className="field num"
              pattern="T[0-9]{1,4}"
              data-testid="res-cam-cut-tool-input"
              value={camOpts.cutTool}
              onChange={(e) => setCamOpts({ ...camOpts, cutTool: e.target.value })}
            />

            <label htmlFor="res-cam-punch-tool">冲孔/定位刀头</label>
            <input
              id="res-cam-punch-tool"
              className="field num"
              pattern="T[0-9]{1,4}"
              data-testid="res-cam-punch-tool-input"
              value={camOpts.punchTool}
              onChange={(e) => setCamOpts({ ...camOpts, punchTool: e.target.value })}
            />

            <label htmlFor="res-cam-crease-tool">压痕/画线刀头</label>
            <input
              id="res-cam-crease-tool"
              className="field num"
              pattern="T[0-9]{1,4}"
              data-testid="res-cam-crease-tool-input"
              value={camOpts.creaseTool}
              onChange={(e) => setCamOpts({ ...camOpts, creaseTool: e.target.value })}
            />
          </div>

          {camError && (
            <div style={{ marginBottom: 10 }}>
              <OperationFeedbackCard
                tone="err"
                title={camError.title}
                message={camError.message}
                traceId={camError.traceId}
              />
            </div>
          )}

          <div className="mp-modal-foot">
            <button type="button" className="btn" disabled={camBusy} onClick={onCloseCamModal}>
              取消
            </button>
            <button
              type="submit"
              className="btn pri"
              data-testid="res-cam-export-submit-btn"
              disabled={camBusy || !activeScheme}
            >
              {camBusy ? '导出生成中…' : '下载服务端 CAM 文件'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={batchZipModalOpen}
        title={`批量打包导出 ZIP（已选 ${checkedSchemeIds.length} 个方案）`}
        onClose={() => {
          if (!zipBusy) onCloseBatchZipModal();
        }}
        maxWidth={640}
      >
        <form onSubmit={handleBatchZipSubmit} data-testid="res-batch-zip-modal">
          {!allowBatchZip && (
            <div style={{ marginBottom: 10 }}>
              <OperationFeedbackCard
                tone="warn"
                testId="res-batch-zip-permission-alert"
                title="AI Agent 或未登录身份禁止批量导出 ZIP（403）"
                message="根据企业权限矩阵，POST /api/v2/exports/batch-zip 仅限登录工厂角色（ADMIN / PLANNER / OPERATOR / INSPECTOR / WAREHOUSE）执行。"
              />
            </div>
          )}

          <p style={{ margin: '0 0 10px', fontSize: 12.5 }}>
            单次最多打包 <b>50</b> 个方案（当前已选 <b className="num">{checkedSchemeIds.length}</b> 个），输出包内自动附带{' '}
            <code>manifest.json</code>，2D 方案与 1D 分切格式不匹配项将记录为 <code>SKIPPED</code> 而不中断打包。
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 8,
              padding: '8px 0 12px'
            }}
          >
            {BATCH_ZIP_FORMAT_OPTIONS.map((opt) => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                <input
                  type="checkbox"
                  checked={zipFormats.includes(opt.value)}
                  onChange={(e) => toggleZipFormat(opt.value, e.target.checked)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>

          {zipError && (
            <div style={{ marginBottom: 10 }}>
              <OperationFeedbackCard
                tone="err"
                title={zipError.title}
                message={zipError.message}
                traceId={zipError.traceId}
              />
            </div>
          )}

          <div className="mp-modal-foot">
            <button type="button" className="btn" disabled={zipBusy} onClick={onCloseBatchZipModal}>
              取消
            </button>
            <button
              type="submit"
              className="btn pri"
              data-testid="res-batch-zip-submit-btn"
              disabled={zipBusy || !allowBatchZip || checkedSchemeIds.length === 0 || zipFormats.length === 0}
            >
              {zipBusy ? '流式打包中…' : '确认下载批量 ZIP'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ModalDialog
        open={summaryModalOpen}
        title="导出多维生产汇总报表 (PDF / Excel)"
        onClose={() => {
          if (!summaryBusy) onCloseSummaryModal();
        }}
        maxWidth={540}
      >
        <form onSubmit={handleSummarySubmit} data-testid="res-summary-export-modal">
          <div className="form" style={{ gridTemplateColumns: '110px 1fr', padding: '4px 0 12px' }}>
            <label htmlFor="res-summary-format">报表格式</label>
            <select
              id="res-summary-format"
              className="field"
              data-testid="res-summary-format-select"
              value={summaryFormat}
              onChange={(e) => setSummaryFormat(e.target.value as ExportSummaryFormat)}
            >
              <option value="xlsx">多工作表 Excel (.xlsx)</option>
              <option value="pdf">A4 多维汇总报告 (.pdf)</option>
            </select>

            <label htmlFor="res-summary-task">需求任务 ID</label>
            <input
              id="res-summary-task"
              className="field num"
              placeholder="选填：筛选指定 taskId"
              value={summaryTaskId}
              onChange={(e) => setSummaryTaskId(e.target.value)}
            />

            <label htmlFor="res-summary-state">方案状态</label>
            <select
              id="res-summary-state"
              className="field"
              value={summaryState}
              onChange={(e) => setSummaryState(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="AWAITING_ROLL">待绑实卷</option>
              <option value="READY_TO_CUT">已锁实卷待切</option>
              <option value="DISPATCHED_MES">已下发 MES</option>
              <option value="COMPLETED">已完工记账</option>
              <option value="REVERSED">已冲销释放</option>
            </select>

            <label htmlFor="res-summary-from">起始日期</label>
            <input
              id="res-summary-from"
              type="date"
              className="field num"
              value={summaryFrom}
              onChange={(e) => setSummaryFrom(e.target.value)}
            />

            <label htmlFor="res-summary-to">截止日期</label>
            <input
              id="res-summary-to"
              type="date"
              className="field num"
              value={summaryTo}
              onChange={(e) => setSummaryTo(e.target.value)}
            />
          </div>

          {summaryError && (
            <div style={{ marginBottom: 10 }}>
              <OperationFeedbackCard
                tone="err"
                title={summaryError.title}
                message={summaryError.message}
                traceId={summaryError.traceId}
              />
            </div>
          )}

          <div className="mp-modal-foot">
            <button type="button" className="btn" disabled={summaryBusy} onClick={onCloseSummaryModal}>
              取消
            </button>
            <button
              type="submit"
              className="btn pri"
              data-testid="res-summary-export-submit-btn"
              disabled={summaryBusy}
            >
              {summaryBusy ? '生成报表中…' : `下载生产汇总 ${summaryFormat.toUpperCase()}`}
            </button>
          </div>
        </form>
      </ModalDialog>
    </>
  );
};
