import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { CodeBadge } from '../../components/ui/MagpiePrimitives';
import { NumberInput } from '../../components/ui/NumberInput';
import {
  DirectionMode,
  DraftLine,
  ParsedFileContext,
  PieceSilhouetteSvg,
  applyDirectionMode,
  getDirectionMode
} from './demandCreateTypes';

export interface DemandSpecResultPanelProps {
  draftStats: { validCount: number; totalQty: number; areaM2: number; oversizeCount: number };
  unitLabel: string;
  effectiveTargetWidthMm: number;
  is1D: boolean;
  fixedLen1D: number;
  parsedFile: ParsedFileContext | null;
  onSelectGroup: (fileName: string, groups: any[], idx: number) => void;
  draftLines: DraftLine[];
  onSetDraftLines: React.Dispatch<React.SetStateAction<DraftLine[]>>;
  onMarkDirty: () => void;
  isLineOversize: (ln: DraftLine) => boolean;
  onReset: () => void;
  submitting: boolean;
  mergeTargetId: string;
  onSaveOnly: () => void;
}

export const DemandSpecResultPanel: React.FC<DemandSpecResultPanelProps> = ({
  draftStats,
  unitLabel,
  effectiveTargetWidthMm,
  is1D,
  fixedLen1D,
  parsedFile,
  onSelectGroup,
  draftLines,
  onSetDraftLines,
  onMarkDirty,
  isLineOversize,
  onReset,
  submitting,
  mergeTargetId,
  onSaveOnly
}) => {
  return (
    <section className="dc-pane" aria-label="本次需求识别结果与核对">
      <div className="dc-result-head">
        <div className="dc-result-title">
          <strong>本次需求结果</strong>
          <span className="dc-stat-pill num">
            {draftStats.validCount} 项 · 共 {draftStats.totalQty} {unitLabel}
          </span>
          <span className="dc-stat-pill num">净面积 {draftStats.areaM2.toFixed(2)} m²</span>
          <span className="dc-stat-pill num">目标幅宽 {effectiveTargetWidthMm} mm</span>
          {draftStats.oversizeCount > 0 && (
            <span className="dc-stat-pill warn">{draftStats.oversizeCount} 项超当前幅宽</span>
          )}
        </div>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            onMarkDirty();
            onSetDraftLines((prev) => [
              ...prev,
              {
                name: `规格 #${prev.length + 1}`,
                width: is1D ? 400 : 500,
                length: is1D ? fixedLen1D : 800,
                quantity: 5,
                allowRotation: false,
                allowHalfTurn: false
              }
            ]);
          }}
        >
          ＋ 添加规格行
        </button>
      </div>

      {parsedFile && parsedFile.groups.length > 1 && (
        <div className="dc-group-bar">
          <span>
            文件 <CodeBadge>{parsedFile.fileName}</CodeBadge> 识别出 {parsedFile.groups.length} 个分组：
          </span>
          {parsedFile.groups.map((g, idx) => (
            <button
              key={idx}
              type="button"
              className={`dc-chip-btn ${parsedFile.groupIndex === idx ? 'on' : ''}`}
              onClick={() => onSelectGroup(parsedFile.fileName, parsedFile.groups, idx)}
            >
              组 {idx + 1} · {g.materialModel || '默认'} [{g.dimension === 'SLITTING_1D' ? '1D' : '2D'}] ({g.demands.length}项)
            </button>
          ))}
        </div>
      )}

      <div className="dc-result-scroll">
        {draftLines.length > 0 && (
          <div className="dc-gallery-box">
            <div className="dc-gallery-head">
              <span>裁片 / 分条几何预览（按长宽比例呈现）</span>
              <span className="num">{draftLines.length} 种规格</span>
            </div>
            <div className="dc-gallery-grid">
              {draftLines.map((ln, idx) => {
                const over = isLineOversize(ln);
                return (
                  <div
                    key={idx}
                    className={`dc-piece-card ${over ? 'is-oversize' : ''}`}
                    title={over ? `宽度超过当前目标幅宽 ${effectiveTargetWidthMm} mm` : ln.name}
                  >
                    <div className="dc-piece-svg-wrap">
                      <PieceSilhouetteSvg line={ln} is1D={is1D} oversize={over} />
                    </div>
                    <div className="dc-piece-meta">
                      <span className="dc-piece-name">{ln.name || `规格 #${idx + 1}`}</span>
                      <span className="dc-piece-qty num">×{ln.quantity}</span>
                    </div>
                    <div className="dc-piece-dim num">
                      <span>
                        {fmtN(ln.width, 0)}×{fmtN(is1D ? fixedLen1D : ln.length, 0)}
                      </span>
                      {over && <span className="over-flag">超宽</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="dc-table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th style={{ width: 42 }}>#</th>
                <th style={{ minWidth: 160 }}>规格 / 裁片名称</th>
                <th style={{ width: 92 }}>形态</th>
                <th style={{ width: 96 }} className="r">宽 (mm)</th>
                {!is1D && <th style={{ width: 96 }} className="r">长 (mm)</th>}
                <th style={{ width: 80 }} className="r">数量 ({unitLabel})</th>
                {!is1D && <th style={{ width: 116 }}>方向规则</th>}
                <th style={{ width: 42 }} />
              </tr>
            </thead>
            <tbody>
              {draftLines.length === 0 ? (
                <tr>
                  <td colSpan={is1D ? 6 : 8} className="empty" style={{ padding: 28 }}>
                    暂无规格行，请拖入文件识别、从模板展开或点击右上角「＋ 添加规格行」
                  </td>
                </tr>
              ) : (
                draftLines.map((ln, idx) => {
                  const isPoly = ln.shape?.type === 'POLYGON';
                  const over = isLineOversize(ln);
                  return (
                    <tr key={idx}>
                      <td className="num" style={{ color: 'var(--cp-ink-3)' }}>
                        {idx + 1}
                      </td>
                      <td>
                        <input
                          className="dc-cell-in"
                          value={ln.name}
                          placeholder={`规格 #${idx + 1}`}
                          onChange={(e) => {
                            onMarkDirty();
                            const v = e.target.value;
                            onSetDraftLines((p) => p.map((x, i) => (i === idx ? { ...x, name: v } : x)));
                          }}
                        />
                      </td>
                      <td>
                        <span className={`tag ${isPoly ? 'run' : is1D ? 'kind' : 'ok'}`}>
                          {is1D
                            ? '一维条'
                            : isPoly
                            ? `异形(${ln.shape.vertices?.length || 0}点${ln.shape.holes?.length ? `·${ln.shape.holes.length}孔` : ''})`
                            : '矩形'}
                        </span>
                      </td>
                      <td>
                        <NumberInput
                          min={1}
                          className="dc-cell-in num-in"
                          style={over ? { borderColor: '#e11d48', color: '#be123c' } : undefined}
                          value={ln.width}
                          onValueChange={(v) => {
                            onMarkDirty();
                            onSetDraftLines((p) => p.map((x, i) => (i === idx ? { ...x, width: v } : x)));
                          }}
                        />
                      </td>
                      {!is1D && (
                        <td>
                          <NumberInput
                            min={1}
                            className="dc-cell-in num-in"
                            value={ln.length}
                            onValueChange={(v) => {
                              onMarkDirty();
                              onSetDraftLines((p) => p.map((x, i) => (i === idx ? { ...x, length: v } : x)));
                            }}
                          />
                        </td>
                      )}
                      <td>
                        <NumberInput
                          min={1}
                          integer
                          className="dc-cell-in num-in"
                          value={ln.quantity}
                          onValueChange={(v) => {
                            onMarkDirty();
                            onSetDraftLines((p) => p.map((x, i) => (i === idx ? { ...x, quantity: v } : x)));
                          }}
                        />
                      </td>
                      {!is1D && (
                        <td>
                          <select
                            className="dc-cell-in"
                            aria-label={`规格 ${idx + 1} 方向规则`}
                            value={getDirectionMode(ln)}
                            onChange={(e) => {
                              onMarkDirty();
                              const mode = e.target.value as DirectionMode;
                              onSetDraftLines((p) =>
                                p.map((x, i) => (i === idx ? applyDirectionMode(x, mode) : x))
                              );
                            }}
                          >
                            <option value="FIXED">0° 经向</option>
                            <option value="ROTATE_90">允许 90°</option>
                            <option value="HALF_180">允许 180°</option>
                          </select>
                        </td>
                      )}
                      <td style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          className="dc-del-btn"
                          title="删除此规格行"
                          aria-label={`删除规格 ${idx + 1}`}
                          onClick={() => {
                            onMarkDirty();
                            onSetDraftLines((p) => p.filter((_, i) => i !== idx));
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dc-result-foot">
        <div className="dc-foot-left">
          <button type="button" className="mp-ghost-btn" onClick={onReset}>
            重置
          </button>
          <span className="num">
            共 {draftStats.validCount} 项 · {draftStats.totalQty} {unitLabel} · {draftStats.areaM2.toFixed(2)} m²
          </span>
        </div>
        <div className="dc-foot-right">
          <button
            type="button"
            className="btn"
            disabled={submitting || draftStats.validCount === 0}
            onClick={onSaveOnly}
          >
            仅保存至需求库
          </button>
          <button type="submit" className="btn pri" disabled={submitting || draftStats.validCount === 0}>
            {submitting
              ? '正在建档进入工作台…'
              : mergeTargetId
              ? '追加并去搭切排程 →'
              : '保存并去搭切排程 →'}
          </button>
        </div>
      </div>
    </section>
  );
};
