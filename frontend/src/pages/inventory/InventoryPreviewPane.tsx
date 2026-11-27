import React from 'react';
import { fmtM, fmtN } from '../../lib/core/util.js';
import { CadCanvasView } from '../../components/CadCanvasView';
import { InventoryActionKind, ProductGroup, RollPreviewLayout } from './inventoryTypes';

export interface InventoryPreviewPaneProps {
  previewWidth: number;
  draggingRight: boolean;
  dragOriginRef: React.MutableRefObject<{ startX: number; startW: number }>;
  onSetDraggingRight: (v: boolean) => void;
  onCommitPreviewWidth: (next: number) => void;
  onAnnounceResize: (msg: string) => void;
  onClosePreview: () => void;
  previewRoll: any | null;
  previewRemnant: any | null;
  previewScene: any | null;
  rollSpatialMap: any | null;
  rolls: any[];
  activeProduct: ProductGroup | null;
  rollLayout: RollPreviewLayout;
  onSetRollLayout: (l: RollPreviewLayout) => void;
  vertical: boolean;
  onToggleVertical: () => void;
  tool: 'pan' | 'measure';
  onToggleTool: () => void;
  cursor: { u: number; v: number } | null;
  onCursorMove: (c: { u: number; v: number } | null) => void;
  previewCanvasRef: React.MutableRefObject<any>;
  onInspectRoll: (r: any) => void;
  onOpenAction: (kind: InventoryActionKind, extra?: any) => void;
  onZoomToSpan: (startY: number, endY: number, widthMm: number) => void;
  onZoomToDefect: (d: any, materialWidth: number) => void;
  onSendRollToWorkbench: (roll: any) => void;
  onSendRemnantToWorkbench: (rem: any) => void;
}

export const InventoryPreviewPane: React.FC<InventoryPreviewPaneProps> = ({
  previewWidth,
  draggingRight,
  dragOriginRef,
  onSetDraggingRight,
  onCommitPreviewWidth,
  onAnnounceResize,
  onClosePreview,
  previewRoll,
  previewRemnant,
  previewScene,
  rollSpatialMap,
  rolls,
  rollLayout,
  onSetRollLayout,
  vertical,
  onToggleVertical,
  tool,
  onToggleTool,
  cursor,
  onCursorMove,
  previewCanvasRef,
  onInspectRoll,
  onOpenAction,
  onZoomToSpan,
  onZoomToDefect,
  onSendRollToWorkbench,
  onSendRemnantToWorkbench
}) => {
  return (
    <>
      <button
        type="button"
        className={`inv-split-handle mp-inv-splitter ${draggingRight ? 'dragging' : ''}`}
        aria-label="左右拖动或按左右方向键调节右侧实物预览区宽度"
        title="左右拖动调节预览区宽度（双击切换标准/宽屏，或按方向键）"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragOriginRef.current = { startX: e.clientX, startW: previewWidth };
          e.currentTarget.setPointerCapture(e.pointerId);
          onSetDraggingRight(true);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          onCommitPreviewWidth(dragOriginRef.current.startW + (dragOriginRef.current.startX - e.clientX));
        }}
        onLostPointerCapture={() => onSetDraggingRight(false)}
        onDoubleClick={() => {
          const next = previewWidth < 480 ? 560 : 384;
          onCommitPreviewWidth(next);
          onAnnounceResize(next > 480 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度');
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 20;
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            onCommitPreviewWidth(previewWidth + step);
            onAnnounceResize('已加宽右侧实物预览区');
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            onCommitPreviewWidth(previewWidth - step);
            onAnnounceResize('已收窄右侧实物预览区');
          } else if (e.key === 'Home') {
            e.preventDefault();
            onCommitPreviewWidth(640);
            onAnnounceResize('预览区已设为最大宽度');
          } else if (e.key === 'End') {
            e.preventDefault();
            onCommitPreviewWidth(384);
            onAnnounceResize('预览区已恢复标准宽度');
          }
        }}
      />

      <aside className="inv-preview-pane mp-inv-preview-card" aria-label="实物几何与疵点预览">
        <div className="mp-inv-preview-head">
          {previewRoll ? (
            <>
              <span className="mp-dark-pill-tag roll">母卷预览</span>
              <strong className="num inv-preview-id">{previewRoll.rollId}</strong>
            </>
          ) : previewRemnant ? (
            <>
              <span className="mp-dark-pill-tag remnant">料头预览</span>
              <strong className="num inv-preview-id">{previewRemnant.id}</strong>
            </>
          ) : (
            <span>实物几何预览</span>
          )}
          <span className="sp" />
          {previewRoll && (
            <button
              type="button"
              className="mp-dark-btn"
              title="维护母卷缸号、色号、缩水率与库位"
              onClick={() => onOpenAction('editRoll', { roll: previewRoll })}
            >
              档案
            </button>
          )}
          {previewRoll && previewRoll.inspectionStatus === 'PASSED' && (
            <button
              type="button"
              className="mp-dark-btn accent"
              onClick={() => onSendRollToWorkbench(previewRoll)}
            >
              去排料 →
            </button>
          )}
          {previewRemnant && previewRemnant.status === 'QUARANTINED' && (
            <button
              type="button"
              className="mp-dark-btn accent"
              onClick={() =>
                onOpenAction('release', {
                  releaseRemnantId: previewRemnant.id,
                  decision: 'RELEASE_AVAILABLE'
                })
              }
            >
              复验放行
            </button>
          )}
          {previewRemnant && previewRemnant.status === 'AVAILABLE' && (
            <button
              type="button"
              className="mp-dark-btn accent"
              onClick={() => onSendRemnantToWorkbench(previewRemnant)}
            >
              去排料 →
            </button>
          )}
          <button
            type="button"
            className="mp-dark-btn"
            title="在标准宽度与加宽预览之间切换"
            onClick={() => {
              const next = previewWidth < 480 ? 560 : 384;
              onCommitPreviewWidth(next);
              onAnnounceResize(next > 480 ? '预览区已切换为加宽视图' : '预览区已恢复标准宽度');
            }}
          >
            {previewWidth < 480 ? '加宽' : '标准'}
          </button>
          <button
            type="button"
            className="mp-dark-btn"
            aria-label="收起右侧预览窗格"
            title="收起预览"
            onClick={() => {
              onClosePreview();
              onAnnounceResize('右侧实物预览窗格已收起');
            }}
          >
            收起
          </button>
        </div>

        {previewScene && (previewRoll || previewRemnant) ? (
          <div className="inv-preview-body">
            <div className="ctool inv-preview-toolbar" role="toolbar" aria-label="库存实物预览控制工具栏">
              {previewRoll ? (
                <>
                  <div className="ctool-group" role="group" aria-label="母卷展开方式">
                    <button type="button" aria-pressed={rollLayout === 'tile'} onClick={() => onSetRollLayout('tile')}>
                      折叠全卷
                    </button>
                    <button type="button" aria-pressed={rollLayout === 'strip'} onClick={() => onSetRollLayout('strip')}>
                      单条全卷
                    </button>
                    <button type="button" aria-pressed={rollLayout === 'station'} onClick={() => onSetRollLayout('station')}>
                      待切端头
                    </button>
                  </div>
                  <span className="div" role="separator" aria-orientation="vertical" />
                </>
              ) : previewRemnant?.sourceRollId ? (
                <>
                  <button
                    type="button"
                    title="切换查看该料头的来源母卷整卷预览"
                    onClick={() => {
                      const parent = rolls.find((r) => r.rollId === previewRemnant.sourceRollId);
                      if (parent) onInspectRoll(parent);
                    }}
                  >
                    ↑ 看母卷
                  </button>
                  <span className="div" role="separator" aria-orientation="vertical" />
                </>
              ) : null}

              <div className="ctool-group" role="group" aria-label="画布缩放与测距">
                <button type="button" onClick={() => previewCanvasRef.current?.fit()}>
                  居中
                </button>
                <button type="button" aria-label="缩小预览" onClick={() => previewCanvasRef.current?.zoom(1 / 1.25)}>
                  −
                </button>
                <button type="button" aria-label="放大预览" onClick={() => previewCanvasRef.current?.zoom(1.25)}>
                  ＋
                </button>
                <button type="button" aria-pressed={!vertical} onClick={onToggleVertical}>
                  {vertical ? '竖排' : '横排'}
                </button>
                <button type="button" aria-pressed={tool === 'measure'} onClick={onToggleTool}>
                  测距
                </button>
              </div>

              {(previewRoll?.defects || previewRemnant?.defects || []).length > 0 && (
                <>
                  <span className="sp" />
                  <select
                    className="inv-toolbar-select num"
                    aria-label="选择疵点放大定位"
                    value=""
                    onChange={(e) => {
                      const list = previewRoll?.defects || previewRemnant?.defects || [];
                      const d = list[Number(e.target.value)];
                      const w = previewRoll?.width || previewRemnant?.width || 2000;
                      if (d) onZoomToDefect(d, w);
                    }}
                  >
                    <option value="" disabled>
                      定位疵点 ({(previewRoll?.defects || previewRemnant?.defects || []).length})…
                    </option>
                    {(previewRoll?.defects || previewRemnant?.defects || []).map((d: any, idx: number) => (
                      <option key={d.id || idx} value={idx}>
                        #{idx + 1} {d.typeName || d.defectType} · Y{' '}
                        {previewRoll ? `${(d.y / 1000).toFixed(2)}m` : `${fmtN(d.y)}mm`}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {previewRoll && rollSpatialMap && (
              <div className="roll-spatial-panel">
                <div className="roll-spatial-legend num">
                  <span className="spatial-dot cut" />
                  <span>
                    已切割{' '}
                    <b>
                      {fmtM(
                        (rollSpatialMap.cutZones || []).reduce((s: number, z: any) => s + (z.lengthMm || 0), 0) ||
                          previewRoll.usedLength ||
                          0
                      )}
                      m
                    </b>
                  </span>
                  <span className="spatial-dot planned" />
                  <span>
                    排程预占 <b>{fmtM(rollSpatialMap.summary?.plannedLengthMm || 0)}m</b>
                  </span>
                  <span className="spatial-dot clean" />
                  <span>
                    净可排余量 <b>{fmtM(rollSpatialMap.summary?.netAvailableToPlanMm || 0)}m</b>
                  </span>
                  <span className="spatial-dot defect" />
                  <span>疵点 {(previewRoll.defects || []).length} 处</span>
                </div>

                <div className="roll-spatial-bar" role="group" aria-label="母卷全长切割与预占空间分布条">
                  {(rollSpatialMap.cutZones || []).map((cz: any, idx: number) => {
                    const total = Math.max(1, previewRoll.totalLength);
                    const leftPct = (cz.startY / total) * 100;
                    const widthPct = Math.max(1.2, (cz.lengthMm / total) * 100);
                    return (
                      <button
                        key={`cz-${idx}`}
                        type="button"
                        className="spatial-seg cut"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        title={`已切割区域：${cz.title} (${fmtM(cz.startY)}m ~ ${fmtM(cz.endY)}m)`}
                        onClick={() => onZoomToSpan(cz.startY, cz.endY, previewRoll.width)}
                      >
                        {widthPct >= 14 ? '已切' : ''}
                      </button>
                    );
                  })}
                  {(rollSpatialMap.plannedZones || []).map((pz: any, idx: number) => {
                    const total = Math.max(1, previewRoll.totalLength);
                    const leftPct = (pz.startY / total) * 100;
                    const widthPct = Math.max(1.2, (pz.lengthMm / total) * 100);
                    return (
                      <button
                        key={`pz-${idx}`}
                        type="button"
                        className="spatial-seg planned"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        title={`排程预占：${pz.title} (${fmtM(pz.startY)}m ~ ${fmtM(pz.endY)}m)`}
                        onClick={() => onZoomToSpan(pz.startY, pz.endY, previewRoll.width)}
                      >
                        {widthPct >= 14 ? '预占' : ''}
                      </button>
                    );
                  })}
                  {(previewRoll.defects || []).map((d: any, idx: number) => {
                    const total = Math.max(1, previewRoll.totalLength);
                    const leftPct = Math.min(99, (d.y / total) * 100);
                    return (
                      <i
                        key={`df-${idx}`}
                        className="spatial-defect-tick"
                        style={{ left: `${leftPct}%` }}
                        title={`疵点 #${idx + 1}: ${d.typeName || d.defectType} (Y=${fmtM(d.y)}m)`}
                        onClick={() => onZoomToDefect(d, previewRoll.width)}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <div className="inv-canvas-box">
              <CadCanvasView
                scene={previewScene}
                vertical={vertical}
                showDimensions={true}
                showPath={false}
                viewMode={previewRoll ? (rollLayout === 'station' ? 'station' : 'full') : 'station'}
                fullMode={previewRoll && rollLayout === 'tile' ? 'tile' : 'strip'}
                minHeight={360}
                ariaLabel={previewRoll ? `母卷 ${previewRoll.rollId} 实物预览画布` : `料头 ${previewRemnant?.id} 实物预览画布`}
                tool={tool}
                onCursorMove={onCursorMove}
                canvasRefOut={previewCanvasRef}
              />
            </div>

            <div className="studio-canvas-hint num">
              {previewRoll
                ? `幅宽 ${fmtN(previewRoll.width)} mm × 总长 ${fmtM(previewRoll.totalLength)} m（剩余 ${fmtM(
                    previewRoll.currentRemainingLength ?? previewRoll.totalLength - (previewRoll.usedLength || 0)
                  )} m · 疵点 ${(previewRoll.defects || []).length} 处）${
                    previewRoll.batchNo ? ` · 缸号 ${previewRoll.batchNo}` : ''
                  }${previewRoll.color ? ` · 色号 ${previewRoll.color}` : ''}${
                    previewRoll.shrinkageRate != null ? ` · 缩水率 ${fmtN(previewRoll.shrinkageRate, 1)}%` : ''
                  }`
                : `料头尺寸 ${fmtN(previewRemnant?.width)} × ${fmtN(previewRemnant?.length)} mm（${fmtN(
                    previewRemnant?.area,
                    2
                  )} m²）`}
              {cursor ? ` · X=${fmtN(cursor.v, 0)} / Y=${fmtN(cursor.u, 0)} mm` : ''}
            </div>
          </div>
        ) : (
          <div className="mp-inv-preview-empty">
            点击左侧任意母卷或料头行，即可在此预览实物几何尺寸与疵点坐标
          </div>
        )}
      </aside>
    </>
  );
};
