import React, { useEffect, useRef, useState } from 'react';
import { fmtN, toast } from '@static/app/js/util.js';
import { MARKER_STYLES } from '@static/js/nesting/marker-demo.js';
import { DXF_GARMENT_STYLES } from '@static/js/nesting/dxf-garment-samples.js';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  GARMENT_EXAMPLES,
  candidateWidths,
  compactionSavingMm,
  effectiveUtilization,
  fabricConsumption,
  markerRequest,
  selectMarkerTrial,
  solveMarkerDirection
} from '@static/app/js/model/garment.js';
import { createRollCanvas } from '@static/app/js/canvas/roll-canvas.js';
import { showcaseScene } from '@static/app/js/model/showcase.js';
import { useStudioStore } from '../store/useStudioStore';

export const GarmentWidthPage: React.FC = () => {
  const initialEx = GARMENT_EXAMPLES[0];
  const [halfTurn, setHalfTurn] = useState<boolean>(false);
  const [gapFill, setGapFill] = useState<boolean>(true);
  const [exampleId, setExampleId] = useState<string>(initialEx.id);
  const [styleId, setStyleId] = useState<string>(initialEx.style);
  const [countM, setCountM] = useState<number>(initialEx.M);
  const [countL, setCountL] = useState<number>(initialEx.L);
  const [widthsText, setWidthsText] = useState<string>(initialEx.widths.join(', '));
  const [edgeMm, setEdgeMm] = useState<number>(initialEx.edge);
  const [gsm, setGsm] = useState<number>(initialEx.gsm);

  const [rows, setRows] = useState<any[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('待试算');

  const helpRef = useRef<HTMLDetailsElement | null>(null);
  const inputLRef = useRef<HTMLInputElement | null>(null);
  const inputWidthsRef = useRef<HTMLInputElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const revisionRef = useRef<number>(0);
  const manualViewRef = useRef<boolean>(false);

  const setCanvasSpec = useStudioStore((s) => s.setCanvasSpec);
  const setActiveDemands2D = useStudioStore((s) => s.setActiveDemands2D);

  useEffect(() => {
    sessionRef.current = new OptimizationSession();
    return () => {
      revisionRef.current++;
      sessionRef.current?.cancel();
      canvasRef.current?.destroy();
      canvasRef.current = null;
    };
  }, []);

  const clearValidity = () => {
    inputLRef.current?.setCustomValidity('');
    inputWidthsRef.current?.setCustomValidity('');
  };

  const resetResults = () => {
    clearValidity();
    setRows([]);
    setSelectedIdx(null);
    manualViewRef.current = false;
    canvasRef.current?.destroy();
    canvasRef.current = null;
    setStatusText('待试算');
  };

  const handleLoadExample = (id: string) => {
    const ex = GARMENT_EXAMPLES.find((e: any) => e.id === id);
    if (!ex) return;
    setExampleId(ex.id);
    setStyleId(ex.style);
    setCountM(ex.M);
    setCountL(ex.L);
    setEdgeMm(ex.edge);
    setGsm(ex.gsm);
    setWidthsText(ex.widths.join(', '));
    resetResults();
  };

  const selectedRow = selectedIdx != null ? rows[selectedIdx] || null : null;

  useEffect(() => {
    if (!selectedRow?.result?.layout || !canvasHostRef.current) return;
    if (!canvasRef.current) {
      canvasRef.current = createRollCanvas(canvasHostRef.current);
    }
    canvasRef.current.setScene(
      (showcaseScene as any)(
        selectedRow.layoutRequest,
        selectedRow.result,
        0,
        {
          occupiedLengthMm: selectedRow.use?.length,
          gapFillPlacements: selectedRow.result?.marker?.gapFillPlacements
        }
      ),
      { refit: true }
    );
  }, [selectedRow]);

  const handleStop = () => {
    revisionRef.current++;
    sessionRef.current?.cancel();
    setRows((prev) =>
      prev.map((r) => (r.finished ? r : { ...r, state: '已停止' }))
    );
    setIsBusy(false);
    setStatusText('已停止，保留已返回的幅宽结果');
  };

  const handleExportJson = () => {
    if (!selectedRow?.result) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            request: selectedRow.layoutRequest,
            result: selectedRow.result,
            consumption: selectedRow.use
          },
          null,
          2
        )
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `marker-${selectedRow.width}mm.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleToTask = () => {
    if (!selectedRow?.layoutRequest?.problem) return;
    const prob = selectedRow.layoutRequest.problem;
    const styleName =
      MARKER_STYLES.find((s: any) => s.id === styleId)?.name || '服装唛架';
    const dxfMeta = (DXF_GARMENT_STYLES as any)[styleId];
    const draft = {
      name: `${styleName} · ${fmtN(selectedRow.width, 0)}mm 幅宽试算转排产`,
      problemType: 'NESTING_2D',
      materialModel:
        dxfMeta?.materialModel || `GARMENT-${Math.round(selectedRow.width)}`,
      externalRef: dxfMeta
        ? `CAD纸样 ${dxfMeta.file} · ${fmtN(selectedRow.width, 1)}mm`
        : `唛架试算 ${fmtN(selectedRow.width, 1)}mm (${selectedRow.direction})`,
      process: {
        bedLength: Math.ceil(
          selectedRow.use?.length || prob.material?.shape?.height || 5000
        ),
        trimStart: 0,
        pieceGap: prob.process?.pieceGap ?? 0,
        cutOrigin: 'left-top',
        firstStageOrientation: 'horizontal',
        allowRotation: false,
        allowLongitudinal: true
      },
      demands: (prob.parts || []).map((p: any, i: number) => ({
        id: i + 1,
        name: p.name || p.id,
        width: p.shape?.width || 0,
        length: p.shape?.height || 0,
        quantity: p.quantity || 1,
        allowRotation: Boolean(p.allowRotation || p.allowHalfTurn),
        shape: p.shape
      }))
    };
    localStorage.setItem('cutplan.app.taskdraft.new', JSON.stringify(draft));
    location.hash = '#/task/new';
  };

  const handleToStudio2D = () => {
    if (!selectedRow?.layoutRequest?.problem) return;
    const prob = selectedRow.layoutRequest.problem;
    const dxfMeta = (DXF_GARMENT_STYLES as any)[styleId];
    const demands = (prob.parts || []).map((p: any, i: number) => ({
      id: i + 1,
      name: p.name || String(p.id),
      width: p.shape?.width || 0,
      length: p.shape?.height || 0,
      quantity: p.quantity || 1,
      allowRotation: Boolean(p.allowRotation),
      allowHalfTurn: Boolean(p.allowHalfTurn),
      shape: p.shape
    }));
    setCanvasSpec({
      canvasMode: 'FREE_CANVAS',
      canvasWidthMm: selectedRow.width,
      canvasLengthMm: Math.ceil(
        selectedRow.use?.length || prob.material?.shape?.height || 2000
      ),
      materialModel2D:
        dxfMeta?.materialModel || `GARMENT-${Math.round(selectedRow.width)}`
    });
    setActiveDemands2D(demands);
    toast(`已将 ${selectedRow.width}mm 门幅与裁片带入二维自由画布`);
    location.hash = '#/workbench';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    clearValidity();

    const totalCount = (Number(countM) || 0) + (Number(countL) || 0);
    if (totalCount < 1 || totalCount > 12) {
      inputLRef.current?.setCustomValidity('每版合计须在 1–12 件之间');
      inputLRef.current?.reportValidity();
      return;
    }

    let widths: number[];
    try {
      widths = candidateWidths(widthsText);
    } catch (err: any) {
      inputWidthsRef.current?.setCustomValidity(err.message);
      inputWidthsRef.current?.reportValidity();
      return;
    }

    const mine = ++revisionRef.current;
    resetResults();
    const sizes = { M: Number(countM) || 0, L: Number(countL) || 0 };
    const initialRows: any[] = widths.flatMap((width) =>
      (halfTurn ? [false, true] : [false]).map((ht) => ({
        width,
        halfTurn: ht,
        direction: ht ? '允许掉头' : '固定方向',
        state: '待计算',
        request: markerRequest(
          styleId,
          width,
          sizes,
          crypto.randomUUID(),
          ht,
          gapFill
        )
      }))
    );

    setRows([...initialRows]);
    setIsBusy(true);
    let currentSelectedIdx: number | null = null;

    try {
      for (let i = 0; i < initialRows.length; i++) {
        const row = initialRows[i];
        const baseline = row.halfTurn
          ? initialRows.find((r) => r.width === row.width && !r.halfTurn)
          : null;
        row.state = '计算中';
        setRows([...initialRows]);
        setStatusText(`正在试排 ${row.width} mm · ${row.direction}`);

        const solveFn = async (request: any) => {
          let lastJob: any;
          const { job, result } = await sessionRef.current
            .solve(request, {
              onProgress: (j: any) => {
                lastJob = j;
              }
            })
            .catch((error: any) => {
              if (lastJob?.state === 'TIMED_OUT' && !lastJob.resultRef) {
                return { job: lastJob, result: null };
              }
              throw error;
            });
          return {
            job,
            request,
            result,
            use:
              result &&
              fabricConsumption(
                result,
                row.width,
                Number(edgeMm) || 0,
                Number(gsm) || 200,
                totalCount
              )
          };
        };

        try {
          const outcome = await solveMarkerDirection(
            row.request,
            baseline?.trial,
            solveFn,
            () => mine === revisionRef.current,
            () => {
              row.state = '原起长复试中';
              setRows([...initialRows]);
              setStatusText(
                `正在试排 ${row.width} mm · 允许掉头 · 原起长复试`
              );
            }
          );
          if (mine !== revisionRef.current) return;
          row.trial = outcome.trial;
          row.retryNote = outcome.retryNote;
          const job = row.trial.job;
          const chosen = selectMarkerTrial(
            job.state,
            row.trial,
            baseline?.trial,
            gapFill
          );
          row.usedFixed = chosen !== row.trial;
          row.layoutRequest = chosen.request;
          row.result = chosen.result;
          row.use = chosen.use;
          row.state = row.use ? '齐套' : '未取得齐套结果';
          if (chosen.job.state === 'TIMED_OUT') {
            row.state += '（试排限时结束）';
          }
          if (job.state === 'FAILED' || job.state === 'CANCELLED') {
            row.state = `${
              job.state === 'FAILED' ? '试算失败' : '已停止'
            } · ${row.state}`;
          }
          if (
            !manualViewRef.current &&
            row.result?.layout &&
            (currentSelectedIdx == null ||
              effectiveUtilization(row.use) >
                effectiveUtilization(initialRows[currentSelectedIdx].use))
          ) {
            currentSelectedIdx = i;
            setSelectedIdx(i);
          }
        } catch (err: any) {
          if (mine !== revisionRef.current) return;
          row.state = '试算失败 · ' + err.message;
        }
        row.finished = true;
        setRows([...initialRows]);
      }
      const completeCount = initialRows.filter((r) => r.use).length;
      setStatusText(
        `试算结束 · ${completeCount} / ${initialRows.length} 个${
          halfTurn ? '方案' : '幅宽'
        }齐套`
      );
    } finally {
      if (mine === revisionRef.current) {
        setIsBusy(false);
      }
    }
  };

  const validRows = rows.filter((r) => r.use);
  const lowestGrams = validRows.length
    ? Math.min(...validRows.map((r) => r.use.gramsPerGarment))
    : Infinity;
  const highestUtil = validRows.length
    ? Math.max(...validRows.map((r) => effectiveUtilization(r.use)))
    : -Infinity;
  const lowestRow =
    validRows.find((r) => r.use.gramsPerGarment === lowestGrams) || null;
  const highestRow =
    validRows.find((r) => effectiveUtilization(r.use) === highestUtil) || null;

  const buildTrialDetailNodes = (row: any) => {
    const info: string[] = halfTurn ? [row.direction] : [];
    if (row.retryNote) info.push(row.retryNote);
    if (row.halfTurn && row.result?.layout) {
      if (row.usedFixed) info.push('沿用固定方向');
      const turned = row.result.layout.placements.filter(
        (p: any) => p.rotationDegrees === 180
      ).length;
      const turnedSpares =
        row.result.marker?.gapFillPlacements?.filter(
          (p: any) => p.rotationDegrees === 180
        ).length ?? 0;
      info.push(
        `掉头 ${turned + turnedSpares} 片${
          turnedSpares ? `（含备片 ${turnedSpares} 片）` : ''
        }`
      );
      if (row.usedFixed) {
        const raw = row.trial.use;
        info.push(
          raw
            ? `掉头原试排 ${fmtN(raw.length, 2)} mm / 齐套 ${fmtN(
                raw.utilization,
                2
              )}%${
                raw.fillCount != null
                  ? ` / 含补片 ${fmtN(raw.utilizationWithFill, 2)}%`
                  : ''
              }`
            : '掉头试排未齐套'
        );
        if (row.trial.job.state === 'TIMED_OUT') info.push('掉头试排限时结束');
      }
      const base = rows.find((r) => r.width === row.width && !r.halfTurn);
      if (row.use && base?.use) {
        const withFill =
          gapFill && row.use.fillCount != null && base.use.fillCount != null;
        const key = withFill ? 'utilizationWithFill' : 'utilization';
        const delta = row.use[key] - base.use[key];
        info.push(
          `${withFill ? '含补片' : '齐套'}较固定 ${
            delta > 0 ? '+' : ''
          }${fmtN(delta, 2)} 个百分点`
        );
      }
    }
    const saved = row.use && compactionSavingMm(row.result.marker.trials);
    if (saved > 0) {
      info.push(
        `${row.usedFixed ? '固定方案' : ''}压紧节省 ${
          saved < 0.01 ? '不足 0.01' : fmtN(saved, 2)
        } mm`
      );
    }
    return info.length ? (
      <>
        <br />
        <small>{info.join(' · ')}</small>
      </>
    ) : null;
  };

  return (
    <div className="react-page">
      <div className="ph">
        <h1>唛架幅宽试算</h1>
        <span className="crumb">服装工艺测算 · 多门幅单耗与齐套排料对比</span>
      </div>

      <div className="split garment-split">
        <section className="pane">
          <div className="pane-b">
            <details
              id="garment-help"
              ref={helpRef}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && helpRef.current?.open) {
                  helpRef.current.open = false;
                }
              }}
            >
              <summary
                className="pane-h"
                role="button"
                aria-label="试算条件帮助"
              >
                试算条件
                <span className="help-mark" aria-hidden="true">
                  ?
                </span>
              </summary>
              <div className="garment-help-text">
                <p id="angle-help">
                  面料允许倒顺排时，可勾选旋转，比较同幅宽下两种方向的利用率。
                </p>
                <p id="fill-help">
                  同款裁片补空在齐套唛架内加排备片，每个已选尺码最多备两件成衣所需的裁片。含补片利用率计入实补面积，每件单耗仍按原配码计算。
                </p>
                <p>
                  <a
                    href="./examples/garment-shirt-gap-fill.png"
                    target="_blank"
                    rel="noopener"
                  >
                    查看 1950 mm 上衣补片前后对照图
                  </a>
                </p>
                <p id="width-help">
                  M、L 码每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000
                  mm，用逗号或空格分隔。
                </p>
                <p id="weight-help">
                  每件用布重量按含布边的幅宽、实际唛架长度和克重估算，未计布头、布尾及备损。
                </p>
              </div>
            </details>

            <div
              className="style-pills"
              id="garment-style-pills"
              aria-label="快捷样板选择"
            >
              {MARKER_STYLES.map((s: any) => (
                <button
                  key={s.id}
                  type="button"
                  className={`style-pill ${styleId === s.id ? 'on' : ''}`}
                  data-style-pill={s.id}
                  disabled={isBusy}
                  onClick={() => {
                    setStyleId(s.id);
                    setExampleId('');
                    resetResults();
                  }}
                >
                  {s.name}
                </button>
              ))}
            </div>

            <form id="garment-form" className="form" onSubmit={handleSubmit}>
              <label htmlFor="garment-half-turn">允许 180° 旋转</label>
              <input
                id="garment-half-turn"
                name="halfTurn"
                type="checkbox"
                aria-describedby="angle-help"
                disabled={isBusy}
                checked={halfTurn}
                onChange={(e) => {
                  setHalfTurn(e.target.checked);
                  resetResults();
                }}
              />
              <label htmlFor="garment-gap-fill">同款裁片补空</label>
              <input
                id="garment-gap-fill"
                name="gapFill"
                type="checkbox"
                aria-describedby="fill-help"
                disabled={isBusy}
                checked={gapFill}
                onChange={(e) => {
                  setGapFill(e.target.checked);
                  resetResults();
                }}
              />
              <label htmlFor="garment-example">试算示例</label>
              <select
                className="field"
                id="garment-example"
                name="example"
                disabled={isBusy}
                value={exampleId}
                onChange={(e) => handleLoadExample(e.target.value)}
              >
                <option value="" disabled>
                  自定义参数
                </option>
                {GARMENT_EXAMPLES.map((e: any) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <label htmlFor="garment-style">内置样板</label>
              <select
                className="field"
                id="garment-style"
                name="style"
                disabled={isBusy}
                value={styleId}
                onChange={(e) => {
                  setStyleId(e.target.value);
                  setExampleId('');
                  resetResults();
                }}
              >
                {MARKER_STYLES.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <label htmlFor="garment-m">M 码（件/版）</label>
              <input
                className="field"
                id="garment-m"
                name="M"
                type="number"
                min={0}
                max={12}
                required
                disabled={isBusy}
                value={countM}
                onChange={(e) => {
                  setCountM(Number(e.target.value));
                  setExampleId('');
                  resetResults();
                }}
              />
              <label htmlFor="garment-l">L 码（件/版）</label>
              <input
                ref={inputLRef}
                className="field"
                id="garment-l"
                name="L"
                type="number"
                min={0}
                max={12}
                required
                disabled={isBusy}
                value={countL}
                onChange={(e) => {
                  setCountL(Number(e.target.value));
                  setExampleId('');
                  resetResults();
                }}
              />
              <label htmlFor="garment-widths">有效幅宽（mm）</label>
              <input
                ref={inputWidthsRef}
                className="field"
                id="garment-widths"
                name="widths"
                aria-describedby="width-help"
                required
                disabled={isBusy}
                value={widthsText}
                onChange={(e) => {
                  setWidthsText(e.target.value);
                  setExampleId('');
                  resetResults();
                }}
              />
              <label htmlFor="garment-edge">两侧布边合计（mm）</label>
              <input
                className="field"
                id="garment-edge"
                name="edge"
                type="number"
                min={0}
                step="0.1"
                required
                disabled={isBusy}
                value={edgeMm}
                onChange={(e) => {
                  setEdgeMm(Number(e.target.value));
                  setExampleId('');
                  resetResults();
                }}
              />
              <label htmlFor="garment-gsm">克重（g/m²）</label>
              <input
                className="field"
                id="garment-gsm"
                name="gsm"
                type="number"
                min="0.1"
                step="0.1"
                aria-describedby="weight-help"
                required
                disabled={isBusy}
                value={gsm}
                onChange={(e) => {
                  setGsm(Number(e.target.value));
                  setExampleId('');
                  resetResults();
                }}
              />
            </form>
          </div>
        </section>

        <section className="pane">
          <div className="garment-kpis" id="garment-kpis">
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
                  {lowestRow ? fmtN(lowestRow.width, 1) : '—'}
                  <em>mm</em>
                </b>
              </div>
              <div>
                <small>最高利用率</small>
                <b>
                  {highestRow
                    ? fmtN(effectiveUtilization(highestRow.use), 2)
                    : '—'}
                  <em>%</em>
                </b>
              </div>
              <div>
                <small>本版配码 / 已齐套</small>
                <b>
                  {(Number(countM) || 0) + (Number(countL) || 0)}
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
          <div className="garment-results">
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
                {rows.map((r, i) => (
                  <tr key={`${r.width}-${r.direction}-${i}`}>
                    <td className="num">{fmtN(r.width, 1)}</td>
                    <td className="wrap">
                      {r.state}
                      {r.use && effectiveUtilization(r.use) === highestUtil
                        ? r.use.fillCount != null
                          ? ' · 最高含补片利用率'
                          : ' · 最高齐套利用率'
                        : ''}
                      {r.use?.gramsPerGarment === lowestGrams
                        ? ' · 当前最低单耗'
                        : ''}
                      {buildTrialDetailNodes(r)}
                    </td>
                    <td className="num">
                      {r.use ? fmtN(r.use.length, 2) : '—'}
                    </td>
                    <td className="num">
                      {r.use ? fmtN(r.use.utilization, 2) : '—'}
                    </td>
                    <td className="num">
                      {r.use ? fmtN(r.use.lengthPerGarment, 2) : '—'}
                    </td>
                    <td className="num">
                      {r.use ? fmtN(r.use.gramsPerGarment, 2) : '—'}
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
                          className="btn sm"
                          type="button"
                          aria-label={`查看 ${r.width} mm ${r.direction}排料图`}
                          aria-pressed={selectedIdx === i}
                          onClick={() => {
                            manualViewRef.current = true;
                            setSelectedIdx(i);
                          }}
                        >
                          查看
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pane-h">
            <span id="garment-view">
              {selectedRow
                ? `排料图 · ${fmtN(selectedRow.width, 1)} mm · ${
                    selectedRow.usedFixed
                      ? '沿用固定方向'
                      : selectedRow.direction
                  } · ${selectedRow.state}`
                : '排料图'}
            </span>
            <span className="sp" />
            <button
              type="button"
              className="btn sm"
              id="garment-export"
              disabled={!selectedRow?.result?.layout}
              onClick={handleExportJson}
            >
              导出唛架 JSON
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!selectedRow?.result?.layout}
              onClick={handleToStudio2D}
            >
              送入二维自由画布 ↗
            </button>
            <button
              type="button"
              className="btn sm pri"
              id="garment-to-task"
              disabled={!selectedRow?.result?.layout}
              title="将当前选中的门幅与样板裁片带入新建二维生产任务"
              onClick={handleToTask}
            >
              转入生产任务 ↗
            </button>
          </div>
          <div
            ref={canvasHostRef}
            id="garment-canvas"
            className="demo-canvas"
            aria-label="当前候选唛架"
          />
        </section>
      </div>

      <div className="foot">
        <span role="status">{statusText}</span>
        <span className="sp" />
        {isBusy && (
          <button
            type="button"
            className="btn"
            id="garment-stop"
            onClick={handleStop}
          >
            停止
          </button>
        )}
        <button
          className="btn pri"
          type="submit"
          form="garment-form"
          disabled={isBusy}
        >
          试算幅宽
        </button>
      </div>
    </div>
  );
};
