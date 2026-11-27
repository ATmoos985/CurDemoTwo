import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { effectiveUtilization } from '../../lib/model/garment.js';
import { CadCanvasView } from '../../components/CadCanvasView';
import {
  GarmentExample,
  SelectedSource,
  buildTrialDetailNotes,
  computeGarmentRowMetricsSummary
} from './garmentWidthUtils';

interface GarmentWidthResultsPanelProps {
  rows: any[];
  halfTurn: boolean;
  gapFill: boolean;
  totalGarmentCount: number;
  benchmark: GarmentExample['benchmark'] | null;
  referencePreview: any | null;
  optimizedPreview: any | null;
  selectedSource: SelectedSource;
  displayedRow: any | null;
  displayedScene: any | null;
  canvasRef: React.MutableRefObject<any>;
  onSelectSource: (src: SelectedSource) => void;
  onExportJson: () => void;
  onToStudio2D: () => void;
}

export const GarmentWidthResultsPanel: React.FC<GarmentWidthResultsPanelProps> = ({
  rows,
  halfTurn,
  gapFill,
  totalGarmentCount,
  benchmark,
  referencePreview,
  optimizedPreview,
  selectedSource,
  displayedRow,
  displayedScene,
  canvasRef,
  onSelectSource,
  onExportJson,
  onToStudio2D
}) => {
  const {
    validRows,
    lowestGrams,
    highestUtil,
    lowestRow,
    highestRow,
    recommendedRow
  } = computeGarmentRowMetricsSummary(rows);

  return (
    <div className="mp-garment-right">
      <section className="mp-float-card mp-garment-results-card">
        <div className="garment-kpis mp-garment-kpis" id="garment-kpis">
          <div className="metric garment-metric">
            <div>
              <small>最低单件克重</small>
              <b>
                {lowestRow ? fmtN(lowestRow.use.gramsPerGarment, 2) : '—'}
                <em>g/件</em>
              </b>
            </div>
            <div>
              <small>推荐最优门幅</small>
              <b>
                {recommendedRow
                  ? fmtN(recommendedRow.width, 1)
                  : optimizedPreview
                  ? fmtN(optimizedPreview.width, 1)
                  : '—'}
                <em>mm</em>
              </b>
            </div>
            <div>
              <small>最高利用率</small>
              <b>
                {highestRow
                  ? fmtN(effectiveUtilization(highestRow.use), 2)
                  : optimizedPreview
                  ? fmtN(optimizedPreview.use.utilization, 2)
                  : '—'}
                <em>%</em>
              </b>
            </div>
            <div>
              <small>本版配码 / 已齐套</small>
              <b>
                {totalGarmentCount}
                <em>
                  件 · {validRows.length}/{rows.length || 0}
                </em>
              </b>
            </div>
          </div>
        </div>

        <div className="pane-h">
          候选幅宽比较<span className="sub">按实算齐套结果对比单耗与利用率</span>
        </div>

        {benchmark && referencePreview && optimizedPreview && (
          <div id="garment-reference" className="mp-garment-ref">
            <span id="garment-benchmark">
              {`原报告 ${benchmark.utilization.toFixed(
                2
              )}% · DXF 同版长换算 ${benchmark.dxfUtilization.toFixed(2)}%（${
                benchmark.width
              } × ${benchmark.length} mm，${Object.entries(benchmark.counts)
                .map(([size, qty]) => `${size} 码 ${qty} 件`)
                .join('、')}）`}
            </span>
            <span className="mp-seg mp-seg-sm" role="group" aria-label="排料方案">
              <button
                className={`mp-seg-btn ${
                  selectedSource?.kind === 'optimized' ? 'on' : ''
                }`}
                id="garment-optimum"
                type="button"
                aria-pressed={selectedSource?.kind === 'optimized'}
                onClick={() => onSelectSource({ kind: 'optimized' })}
              >
                {`优化排料 · ${optimizedPreview.verified.occupiedLengthMm.toFixed(
                  2
                )} mm · ${optimizedPreview.verified.utilizationPercent.toFixed(2)}%`}
              </button>
              <button
                className={`mp-seg-btn ${
                  selectedSource?.kind === 'reference' ? 'on' : ''
                }`}
                id="garment-replay"
                type="button"
                aria-pressed={selectedSource?.kind === 'reference'}
                onClick={() => onSelectSource({ kind: 'reference' })}
              >
                {`按图复排 · ${referencePreview.verified.occupiedLengthMm.toFixed(
                  2
                )} mm · ${referencePreview.verified.utilizationPercent.toFixed(2)}%`}
              </button>
            </span>
          </div>
        )}

        <div className="garment-results mp-garment-results-scroll">
          <table className="t">
            <thead>
              <tr>
                <th>有效幅宽 mm</th>
                <th>试算状态</th>
                <th>唛架长 mm</th>
                <th>齐套利用率 %</th>
                <th>mm/件</th>
                <th>g/件</th>
                {gapFill && <th id="garment-fill-column">含补片利用率 %</th>}
                <th>排料图</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const isRowActive =
                  selectedSource?.kind === 'row' && selectedSource.index === i;
                const notes = buildTrialDetailNotes(r, {
                  halfTurn,
                  gapFill,
                  rows,
                  referencePreview
                });
                return (
                  <tr
                    key={`${r.width}-${r.direction}-${i}`}
                    className={isRowActive ? 'sel' : ''}
                  >
                    <td className="num">{fmtN(r.width, 1)}</td>
                    <td className="wrap">
                      {r.state}
                      {r.use && effectiveUtilization(r.use) === highestUtil
                        ? r.use.fillCount != null
                          ? ' · 最高含补片利用率'
                          : ' · 最高齐套利用率'
                        : ''}
                      {Number.isFinite(r.use?.gramsPerGarment) &&
                      r.use.gramsPerGarment === lowestGrams
                        ? ' · 当前最低单耗'
                        : ''}
                      {notes.length > 0 && (
                        <>
                          <br />
                          <small>{notes.join(' · ')}</small>
                        </>
                      )}
                    </td>
                    <td className="num">
                      {Number.isFinite(r.use?.length) ? fmtN(r.use.length, 2) : '—'}
                    </td>
                    <td className="num">
                      {Number.isFinite(r.use?.utilization)
                        ? fmtN(r.use.utilization, 2)
                        : '—'}
                    </td>
                    <td className="num">
                      {Number.isFinite(r.use?.lengthPerGarment)
                        ? fmtN(r.use.lengthPerGarment, 2)
                        : '—'}
                    </td>
                    <td className="num">
                      {Number.isFinite(r.use?.gramsPerGarment)
                        ? fmtN(r.use.gramsPerGarment, 2)
                        : '—'}
                    </td>
                    {gapFill && (
                      <td className="num">
                        {r.use?.fillCount != null ? (
                          <>
                            {fmtN(r.use.utilizationWithFill, 2)}
                            <br />
                            <small>实补 {r.use.fillCount} 片</small>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td>
                      {r.result?.layout ? (
                        <button
                          className={`btn sm ${isRowActive ? 'soft-accent' : ''}`}
                          type="button"
                          aria-label={`查看 ${r.width} mm ${r.direction}排料图`}
                          aria-pressed={isRowActive}
                          onClick={() => onSelectSource({ kind: 'row', index: i })}
                        >
                          查看
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mp-cad-card mp-garment-canvas-card">
        <div className="mp-cad-head">
          <span id="garment-view" className="mp-cad-title">
            {displayedRow
              ? `排料图 · ${fmtN(displayedRow.width, 1)} mm · ${
                  displayedRow.usedFixed
                    ? '沿用固定方向'
                    : displayedRow.direction
                } · ${displayedRow.state}`
              : '排料图'}
          </span>
          <span className="sp" />
          <button
            type="button"
            className="mp-cad-btn"
            disabled={!displayedScene}
            onClick={() => canvasRef.current?.fit()}
          >
            居中适配
          </button>
          <button
            type="button"
            className="mp-cad-btn"
            id="garment-export"
            disabled={!displayedRow?.result?.layout}
            onClick={onExportJson}
          >
            导出唛架 JSON
          </button>
          <button
            type="button"
            className="mp-cad-btn accent"
            disabled={!displayedRow?.result?.layout}
            onClick={onToStudio2D}
          >
            送入二维自由画布
          </button>
        </div>
        <div id="garment-canvas" className="demo-canvas" aria-label="当前候选唛架">
          <CadCanvasView
            scene={displayedScene}
            showDimensions={true}
            showPath={false}
            minHeight={360}
            ariaLabel="当前候选唛架"
            canvasRefOut={canvasRef}
          />
        </div>
      </section>
    </div>
  );
};
