import React from 'react';
import { SegmentedControl } from '../../components/ui/MagpiePrimitives';
import { NumberInput } from '../../components/ui/NumberInput';
import type { DemandCluster, DemandFamilySummary } from '../../store/studioTypes';
import {
  CREATE_DIM_OPTIONS,
  DimensionKey,
  ParsedFileContext,
  downloadDemandTemplate
} from './demandCreateTypes';

export interface DemandBasicInfoSectionProps {
  mergeTargetId: string;
  mergeTargetFamily: DemandFamilySummary | null;
  onCancelMerge: () => void;
  isDragOver: boolean;
  onSetIsDragOver: (v: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent) => void;
  parsedFile: ParsedFileContext | null;
  onOpenImportWizard: () => void;
  onOpenDxfWizard: () => void;
  createDim: DimensionKey;
  onSetCreateDim: (d: DimensionKey) => void;
  familyName: string;
  setFamilyName: (v: string) => void;
  materialModel: string;
  setMaterialModel: (v: string) => void;
  materialOptions: string[];
  externalRef: string;
  setExternalRef: (v: string) => void;
  priority: 'NORMAL' | 'HIGH' | 'URGENT';
  setPriority: (v: 'NORMAL' | 'HIGH' | 'URGENT') => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  customerName: string;
  setCustomerName: (v: string) => void;
  kittingGroup: string;
  setKittingGroup: (v: string) => void;
  requiredBatchNo: string;
  setRequiredBatchNo: (v: string) => void;
  batchNoOptions: string[];
  requiredColor: string;
  setRequiredColor: (v: string) => void;
  colorOptions: string[];
  machineId: string;
  setMachineId: (v: string) => void;
  shiftTeam: string;
  setShiftTeam: (v: string) => void;
  strictBatchMatch: boolean;
  setStrictBatchMatch: (v: boolean) => void;
  clusters: DemandCluster[];
  templateQuickId: string;
  setTemplateQuickId: (v: string) => void;
  templateQuickSets: number;
  setTemplateQuickSets: (v: number) => void;
  onAppendFromTemplate: () => void;
}

export const DemandBasicInfoSection: React.FC<DemandBasicInfoSectionProps> = ({
  mergeTargetId,
  mergeTargetFamily,
  onCancelMerge,
  isDragOver,
  onSetIsDragOver,
  fileInputRef,
  onFileInputChange,
  onDrop,
  parsedFile,
  onOpenImportWizard,
  onOpenDxfWizard,
  createDim,
  onSetCreateDim,
  familyName,
  setFamilyName,
  materialModel,
  setMaterialModel,
  materialOptions,
  externalRef,
  setExternalRef,
  priority,
  setPriority,
  dueDate,
  setDueDate,
  customerName,
  setCustomerName,
  kittingGroup,
  setKittingGroup,
  requiredBatchNo,
  setRequiredBatchNo,
  batchNoOptions,
  requiredColor,
  setRequiredColor,
  colorOptions,
  machineId,
  setMachineId,
  shiftTeam,
  setShiftTeam,
  strictBatchMatch,
  setStrictBatchMatch,
  clusters,
  templateQuickId,
  setTemplateQuickId,
  templateQuickSets,
  setTemplateQuickSets,
  onAppendFromTemplate
}) => {
  return (
    <>
      {mergeTargetId && (
        <div className="dc-append-banner">
          <span>
            追加模式：<b>{mergeTargetFamily?.name || mergeTargetId}</b>
          </span>
          <button type="button" className="btn sm" onClick={onCancelMerge}>
            切回新建
          </button>
        </div>
      )}

      <div
        className={`dc-dropzone ${isDragOver ? 'is-dragover' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="拖拽或点击上传 DXF、Excel、CSV 或 JSON 文件自动识别需求"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          onSetIsDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          onSetIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            onSetIsDragOver(false);
          }
        }}
        onDrop={onDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".dxf,.xlsx,.xls,.csv,.tsv,.json"
          hidden
          onChange={onFileInputChange}
        />
        <span className="dc-drop-ico" aria-hidden="true">
          <svg viewBox="0 0 18 18" width="18" height="18">
            <path
              d="M9 12V3.5m0 0L5.8 6.7M9 3.5l3.2 3.2M3.2 12.2v1.6a1.4 1.4 0 0 0 1.4 1.4h8.8a1.4 1.4 0 0 0 1.4-1.4v-1.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <div className="dc-drop-title">
          {isDragOver ? '松开鼠标立即识别文件' : '拖拽文件到此自动识别，或点击上传'}
        </div>
        <div className="dc-drop-hint">
          支持 CAD DXF 纸样（含内孔/单位覆写）、Excel 多 Sheet / BOM 展开、CSV (UTF-8/GB18030)、JSON
        </div>
        {parsedFile && (
          <div className="dc-file-pill" title={parsedFile.fileName}>
            已识别：{parsedFile.fileName}
          </div>
        )}
        <div
          className="dc-drop-foot"
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="btn sm soft-accent"
            data-testid="demand-import-wizard-btn"
            onClick={onOpenImportWizard}
          >
            表格 / BOM 导入向导
          </button>
          <button
            type="button"
            className="btn sm"
            data-testid="demand-dxf-wizard-btn"
            onClick={onOpenDxfWizard}
          >
            DXF 几何向导
          </button>
          <button
            type="button"
            className="mp-ghost-btn"
            style={{ height: 24, fontSize: 11.5, padding: '0 8px' }}
            data-testid="demand-template-csv-btn"
            onClick={() => downloadDemandTemplate('csv')}
          >
            CSV模板
          </button>
          <button
            type="button"
            className="mp-ghost-btn"
            style={{ height: 24, fontSize: 11.5, padding: '0 8px' }}
            data-testid="demand-template-xlsx-btn"
            onClick={() => downloadDemandTemplate('xlsx')}
          >
            Excel模板
          </button>
          <button
            type="button"
            className="mp-ghost-btn"
            style={{ height: 24, fontSize: 11.5, padding: '0 8px' }}
            data-testid="demand-template-bom-xlsx-btn"
            onClick={() => downloadDemandTemplate('bom_xlsx')}
          >
            BOM模板
          </button>
        </div>
      </div>

      <div className="dc-sec">
        <div className="dc-sec-head">
          <span className="dc-sec-title">需求信息</span>
        </div>

        <SegmentedControl
          options={CREATE_DIM_OPTIONS}
          value={createDim}
          onChange={(next) => {
            if (!mergeTargetId) onSetCreateDim(next);
          }}
          ariaLabel="选择裁切维度"
          size="sm"
          fullWidth
        />

        {!mergeTargetId && (
          <>
            <div className="dc-field">
              <label htmlFor="dp-name">需求名称</label>
              <input
                id="dp-name"
                className="field"
                placeholder="如：11月卫衣排单 / MES-光学膜分条"
                value={familyName}
                onChange={(e) => setFamilyName(e.target.value)}
              />
            </div>
            <div className="dc-grid-2">
              <div className="dc-field">
                <label htmlFor="dp-mat">物料品号</label>
                <input
                  id="dp-mat"
                  list="dc-mat-list"
                  className="field num"
                  value={materialModel}
                  onChange={(e) => setMaterialModel(e.target.value)}
                />
                <datalist id="dc-mat-list">
                  {materialOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="dc-field">
                <label htmlFor="dp-ext">
                  外部工单号 <small>选填</small>
                </label>
                <input
                  id="dp-ext"
                  className="field num"
                  placeholder="MES / ERP 单号"
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                />
              </div>
            </div>

            <div className="dc-grid-2">
              <div className="dc-field">
                <label htmlFor="dp-priority">生产优先级</label>
                <select
                  id="dp-priority"
                  className="field"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as 'NORMAL' | 'HIGH' | 'URGENT')}
                >
                  <option value="NORMAL">普通 (NORMAL)</option>
                  <option value="HIGH">高优 (HIGH)</option>
                  <option value="URGENT">加急 (URGENT)</option>
                </select>
              </div>
              <div className="dc-field">
                <label htmlFor="dp-duedate">
                  承诺交期 <small>选填</small>
                </label>
                <input
                  id="dp-duedate"
                  type="date"
                  className="field num"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>

            <div className="dc-grid-2">
              <div className="dc-field">
                <label htmlFor="dp-customer">
                  客户名称 <small>选填</small>
                </label>
                <input
                  id="dp-customer"
                  className="field"
                  placeholder="如：优衣库华东仓"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
              <div className="dc-field">
                <label htmlFor="dp-kit">
                  齐套组 <small>选填</small>
                </label>
                <input
                  id="dp-kit"
                  className="field num"
                  placeholder="如：KIT-2026-W48"
                  value={kittingGroup}
                  onChange={(e) => setKittingGroup(e.target.value)}
                />
              </div>
            </div>

            <div className="dc-grid-2">
              <div className="dc-field">
                <label htmlFor="dp-batch">
                  指定缸号 <small>防色差</small>
                </label>
                <input
                  id="dp-batch"
                  list="dc-batch-list"
                  className="field num"
                  placeholder="如：BAT-202609-A1"
                  value={requiredBatchNo}
                  onChange={(e) => setRequiredBatchNo(e.target.value)}
                />
                <datalist id="dc-batch-list">
                  {batchNoOptions.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </div>
              <div className="dc-field">
                <label htmlFor="dp-color">
                  指定色号 <small>选填</small>
                </label>
                <input
                  id="dp-color"
                  list="dc-color-list"
                  className="field"
                  placeholder="如：藏青"
                  value={requiredColor}
                  onChange={(e) => setRequiredColor(e.target.value)}
                />
                <datalist id="dc-color-list">
                  {colorOptions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="dc-grid-2">
              <div className="dc-field">
                <label htmlFor="dp-machine">
                  指定机台 <small>选填</small>
                </label>
                <input
                  id="dp-machine"
                  className="field num"
                  placeholder="如：裁床-01"
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                />
              </div>
              <div className="dc-field">
                <label htmlFor="dp-shift">
                  指定班组 <small>选填</small>
                </label>
                <input
                  id="dp-shift"
                  className="field"
                  placeholder="如：甲班"
                  value={shiftTeam}
                  onChange={(e) => setShiftTeam(e.target.value)}
                />
              </div>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                background: strictBatchMatch
                  ? 'rgba(245, 158, 11, 0.12)'
                  : 'var(--panel-2, rgba(15,23,42,0.03))',
                border: strictBatchMatch
                  ? '1px solid rgba(217, 119, 6, 0.45)'
                  : '1px solid var(--line-2, #e2e8f0)',
                fontSize: 12,
                cursor: 'pointer',
                marginTop: 2
              }}
            >
              <input
                id="dp-strict-batch"
                type="checkbox"
                className="ux-switch"
                checked={strictBatchMatch}
                onChange={(e) => setStrictBatchMatch(e.target.checked)}
              />
              <span>
                <strong>同单同缸强约束</strong>
                <span className="muted" style={{ marginLeft: 4, fontSize: 11 }}>
                  绑卷/选料强校验缸号色号防色差
                </span>
              </span>
            </label>
          </>
        )}

        <div className="dc-field">
          <label>从需求模板库快捷展开</label>
          <div className="dc-tpl-row">
            <select
              className="field"
              value={templateQuickId}
              onChange={(e) => setTemplateQuickId(e.target.value)}
            >
              <option value="">选择模板快速填入…</option>
              {clusters.map((c) => (
                <option key={c.id} value={c.id}>
                  [{c.dimension}] {c.name}
                </option>
              ))}
            </select>
            <NumberInput
              min={1}
              max={999}
              fallback={1}
              integer
              className="field num dc-tpl-sets"
              aria-label="套数"
              value={templateQuickSets}
              onValueChange={setTemplateQuickSets}
            />
            <button
              type="button"
              className="btn sm"
              style={{ flex: 'none' }}
              disabled={!templateQuickId}
              onClick={onAppendFromTemplate}
            >
              展开填入
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
