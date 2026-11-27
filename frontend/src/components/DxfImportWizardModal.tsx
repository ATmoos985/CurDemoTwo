import React, { useEffect, useMemo, useState } from 'react';
import { ModalDialog } from './ModalDialog';
import { OperationFeedbackCard } from './OperationFeedbackCard';
import { parseDxfText } from '../lib/nesting/dxf-parser.js';

export type DxfUnitOverride = 'AUTO' | 'mm' | 'cm' | 'm' | 'inch' | 'ft';
export type DxfRotationMode = 'FIXED' | 'HALF_TURN_180' | 'ROTATE_90';

export interface DxfParseOptionsState {
  unitOverride: DxfUnitOverride;
  chordToleranceMm: number;
  endpointToleranceMm: number;
  rotationMode: DxfRotationMode;
}

export interface ParsedDxfResult {
  format: string;
  unit: string;
  scaleToMm: number;
  encoding?: string;
  warnings: string[];
  groups: Array<{
    materialModel: string;
    fabricCode?: string;
    index: number;
    demands: Array<{
      id: number;
      name: string;
      width: number;
      length: number;
      quantity: number;
      allowRotation: boolean;
      allowHalfTurn?: boolean;
      note?: string;
      shape?: {
        type: 'RECTANGLE' | 'POLYGON';
        width: number;
        height: number;
        vertices?: { x: number; y: number }[];
        holes?: { x: number; y: number }[][];
      };
    }>;
  }>;
}

export interface DxfImportWizardModalProps {
  open: boolean;
  title?: string;
  initialFileName?: string;
  initialBuffer?: ArrayBuffer | string | null;
  confirmLabel?: string;
  fileInputTestId?: string;
  onClose: () => void;
  onConfirm: (parsed: ParsedDxfResult, fileName: string, options: DxfParseOptionsState) => void;
}

function ringToSvgPath(ring: { x: number; y: number }[]): string {
  if (!ring.length) return '';
  return (
    ring
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${Number(pt.x).toFixed(1)},${Number(pt.y).toFixed(1)}`)
      .join(' ') + ' Z'
  );
}

function buildDxfPiecePath(shape: {
  width: number;
  height: number;
  vertices?: { x: number; y: number }[];
  holes?: { x: number; y: number }[][];
}): string {
  const outer =
    shape.vertices && shape.vertices.length >= 3
      ? shape.vertices
      : [
          { x: 0, y: 0 },
          { x: shape.width, y: 0 },
          { x: shape.width, y: shape.height },
          { x: 0, y: shape.height }
        ];
  const parts = [ringToSvgPath(outer)];
  if (Array.isArray(shape.holes)) {
    for (const hole of shape.holes) {
      if (hole.length >= 3) parts.push(ringToSvgPath(hole));
    }
  }
  return parts.join(' ');
}

export const DxfImportWizardModal: React.FC<DxfImportWizardModalProps> = ({
  open,
  title = 'CAD / AAMA DXF 几何导入向导',
  initialFileName = '',
  initialBuffer = null,
  confirmLabel = '确认导入解析结果',
  fileInputTestId = 'dxf-import-file-input',
  onClose,
  onConfirm
}) => {
  const [fileName, setFileName] = useState(initialFileName);
  const [rawInput, setRawInput] = useState<ArrayBuffer | string | null>(initialBuffer);
  const [unitOverride, setUnitOverride] = useState<DxfUnitOverride>('AUTO');
  const [chordToleranceMm, setChordToleranceMm] = useState<number>(0.5);
  const [endpointToleranceMm, setEndpointToleranceMm] = useState<number>(0.5);
  const [rotationMode, setRotationMode] = useState<DxfRotationMode>('FIXED');

  useEffect(() => {
    if (open) {
      if (initialFileName) setFileName(initialFileName);
      if (initialBuffer !== undefined) setRawInput(initialBuffer);
    }
  }, [open, initialFileName, initialBuffer]);

  const { parsed, parseError } = useMemo(() => {
    if (!rawInput) return { parsed: null as ParsedDxfResult | null, parseError: '' };
    try {
      const res = parseDxfText(rawInput, {
        fileName: fileName || 'pattern.dxf',
        ...(unitOverride !== 'AUTO' ? { unitOverride } : {}),
        chordToleranceMm: Number(chordToleranceMm) || 0.5,
        endpointToleranceMm: Number(endpointToleranceMm) || 0.5,
        rotationMode
      }) as ParsedDxfResult;
      return { parsed: res, parseError: '' };
    } catch (err: any) {
      return {
        parsed: null as ParsedDxfResult | null,
        parseError: err?.message || 'DXF 几何解析失败'
      };
    }
  }, [rawInput, fileName, unitOverride, chordToleranceMm, endpointToleranceMm, rotationMode]);

  const allDemands = useMemo(() => {
    if (!parsed) return [];
    return parsed.groups.flatMap((g) =>
      g.demands.map((d) => ({
        groupName: g.fabricCode || g.materialModel,
        ...d
      }))
    );
  }, [parsed]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      setFileName(file.name);
      setRawInput(buf);
    } finally {
      e.target.value = '';
    }
  };

  return (
    <ModalDialog open={open} title={title} onClose={onClose} maxWidth={820}>
      <div className="mp-modal-stack" data-testid="dxf-import-modal">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 10
          }}
        >
          <div className="field-group">
            <label>选择 DXF 文件</label>
            <input
              type="file"
              accept=".dxf"
              className="field"
              data-testid={fileInputTestId}
              onChange={handleFileChange}
            />
          </div>
          <div className="field-group">
            <label>单位覆盖（$INSUNITS）</label>
            <select
              className="field"
              data-testid="dxf-unit-override-select"
              value={unitOverride}
              onChange={(e) => setUnitOverride(e.target.value as DxfUnitOverride)}
            >
              <option value="AUTO">自动识别 ($INSUNITS)</option>
              <option value="mm">毫米 (mm)</option>
              <option value="cm">厘米 (cm)</option>
              <option value="m">米 (m)</option>
              <option value="inch">英寸 (inch)</option>
              <option value="ft">英尺 (ft)</option>
            </select>
          </div>
          <div className="field-group">
            <label>弦高逼近容差 (mm)</label>
            <input
              type="number"
              className="field num"
              step={0.1}
              min={0.05}
              max={10}
              data-testid="dxf-chord-tol-input"
              value={chordToleranceMm}
              onChange={(e) => setChordToleranceMm(Math.max(0.05, Number(e.target.value) || 0.5))}
            />
          </div>
          <div className="field-group">
            <label>端点拼接容差 (mm)</label>
            <input
              type="number"
              className="field num"
              step={0.1}
              min={0.05}
              max={20}
              data-testid="dxf-endpoint-tol-input"
              value={endpointToleranceMm}
              onChange={(e) => setEndpointToleranceMm(Math.max(0.05, Number(e.target.value) || 0.5))}
            />
          </div>
          <div className="field-group">
            <label>经纬纹旋转模式</label>
            <select
              className="field"
              data-testid="dxf-rotation-mode-select"
              value={rotationMode}
              onChange={(e) => setRotationMode(e.target.value as DxfRotationMode)}
            >
              <option value="FIXED">严格经纬向 (0° 锁定)</option>
              <option value="HALF_TURN_180">允许 180° 对倒</option>
              <option value="ROTATE_90">允许 90° 自由旋转</option>
            </select>
          </div>
        </div>

        {parseError && (
          <OperationFeedbackCard
            tone="err"
            title="DXF 解析失败"
            message={parseError}
          />
        )}

        {parsed && (
          <>
            <div className="mp-kv-strip" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
              <span>
                识别格式：<b>{parsed.format}</b>
              </span>
              <span className="num">
                解析单位：<b>{parsed.unit}</b>（×{parsed.scaleToMm} mm）
              </span>
              <span className="num">
                材料/尺码组：<b>{parsed.groups.length}</b>
              </span>
              <span className="num">
                有效裁片：<b>{allDemands.length}</b> 个
              </span>
            </div>

            {parsed.warnings.length > 0 && (
              <div className="sec-feedback is-warn" data-testid="dxf-warnings-list">
                <strong>解析告警（{parsed.warnings.length} 条）</strong>
                <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                  {parsed.warnings.slice(0, 8).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            <div
              data-testid="dxf-pieces-preview"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(175px, 1fr))',
                gap: 10,
                maxHeight: 310,
                overflowY: 'auto'
              }}
            >
              {allDemands.map((d, idx) => {
                const w = Math.max(10, d.shape?.width || d.width);
                const h = Math.max(10, d.shape?.height || d.length);
                const holeCount = d.shape?.holes?.length || 0;
                const pathD = d.shape
                  ? buildDxfPiecePath(d.shape)
                  : `M0,0 L${w},0 L${w},${h} L0,${h} Z`;
                return (
                  <div
                    key={`${d.groupName}-${d.id}-${idx}`}
                    style={{
                      border: '1px solid var(--line-2)',
                      borderRadius: 6,
                      padding: 8,
                      background: 'var(--panel)'
                    }}
                  >
                    <svg
                      viewBox={`-12 -12 ${w + 24} ${h + 24}`}
                      width="100%"
                      height="82"
                      aria-label={d.name}
                    >
                      <path
                        d={pathD}
                        fill="rgba(2, 132, 199, 0.16)"
                        fillRule="evenodd"
                        stroke="#0284c7"
                        strokeWidth={Math.max(w, h) * 0.025}
                      />
                    </svg>
                    <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>{d.name}</div>
                    <div className="num" style={{ fontSize: 11, color: 'var(--cp-ink-3)' }}>
                      {d.width.toFixed(1)}×{d.length.toFixed(1)} mm · ×{d.quantity}
                      {holeCount > 0 ? ` · ${holeCount} 内孔` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="mp-modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn pri"
            data-testid="dxf-import-confirm-btn"
            disabled={!parsed}
            onClick={() => {
              if (!parsed) return;
              onConfirm(parsed, fileName || 'pattern.dxf', {
                unitOverride,
                chordToleranceMm,
                endpointToleranceMm,
                rotationMode
              });
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
};
