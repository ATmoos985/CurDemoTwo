import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast, createUuid } from '../lib/core/util.js';
import { fourPieceReference } from '../lib/nesting/dxf-reference.js';
import { fourPieceOptimized } from '../lib/nesting/four-piece-seed.js';
import { OptimizationSession } from '../lib/domain/job-client.js';
import {
  candidateWidths,
  effectiveUtilization,
  fabricConsumption,
  markerRequest,
  selectMarkerTrial,
  solveMarkerDirection
} from '../lib/model/garment.js';
import { showcaseScene } from '../lib/model/showcase.js';
import { useWorkbench2DActions } from '../store/selectors';
import {
  CodeBadge,
  SegmentedControl,
  SegmentedOption
} from '../components/ui/MagpiePrimitives';
import { GarmentCutPlanPanel } from './garment/GarmentCutPlanPanel';
import {
  CutPlanFormState,
  CutPlanResponse,
  createDefaultCutPlanForm
} from './garment/cutPlanUtils';
import {
  EXAMPLES,
  GarmentExample,
  GarmentPageTab,
  SelectedSource,
  buildPreviewRow,
  buildSizeCounts,
  buildStudio2DDemandsFromMarker,
  getOrderedSizes,
  resolveGarmentMaterialMeta,
  resolveInitialExample
} from './garment/garmentWidthUtils';
import { GarmentWidthFormSidebar } from './garment/GarmentWidthFormSidebar';
import { GarmentWidthResultsPanel } from './garment/GarmentWidthResultsPanel';

export type {
  GarmentExample,
  SelectedSource,
  GarmentPageTab
} from './garment/garmentWidthUtils';
export {
  EXAMPLES,
  QUICK_PILL_STYLES,
  resolveInitialExample,
  buildPreviewRow,
  getOrderedSizes,
  buildSizeCounts,
  resolveGarmentMaterialMeta,
  buildStudio2DDemandsFromMarker,
  computeGarmentRowMetricsSummary,
  buildTrialDetailNotes
} from './garment/garmentWidthUtils';

export const GarmentWidthPage: React.FC<{ exampleId?: string; embedded?: boolean }> = ({
  exampleId: routeExampleId,
  embedded = false
}) => {
  const initialEx = resolveInitialExample(routeExampleId);
  const initialIsDxf = Boolean(initialEx.source);

  const [currentExampleId, setCurrentExampleId] = useState<string>(initialEx.id);
  const [styleId, setStyleId] = useState<string>(initialEx.style);
  const [halfTurn, setHalfTurn] = useState<boolean>(
    initialIsDxf ? Boolean(initialEx.halfTurn) : false
  );
  const [gapFill, setGapFill] = useState<boolean>(
    initialIsDxf ? Boolean(initialEx.gapFill) : true
  );
  const [sizeCounts, setSizeCounts] = useState<Record<string, number>>(() =>
    buildSizeCounts(initialEx.style, initialEx)
  );
  const [widthsText, setWidthsText] = useState<string>(initialEx.widths.join(', '));
  const [edgeMm, setEdgeMm] = useState<number>(initialEx.edge);
  const [gsmText, setGsmText] = useState<string>(
    initialEx.gsm != null ? String(initialEx.gsm) : ''
  );

  const [rows, setRows] = useState<any[]>([]);
  const [selectedSource, setSelectedSource] = useState<SelectedSource>(
    initialEx.benchmark ? { kind: 'optimized' } : null
  );
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('待试算');

  const [activeTab, setActiveTab] = useState<GarmentPageTab>('width');
  const [cutPlanForm, setCutPlanForm] = useState<CutPlanFormState>(() =>
    createDefaultCutPlanForm()
  );
  const [cutPlanResult, setCutPlanResult] = useState<CutPlanResponse | null>(null);
  const [cutPlanError, setCutPlanError] = useState<string | null>(null);

  const helpRef = useRef<HTMLDetailsElement | null>(null);
  const sizeInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const inputWidthsRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const revisionRef = useRef<number>(0);
  const manualViewRef = useRef<boolean>(false);
  const previousOptionsRef = useRef<{ halfTurn: boolean; gapFill: boolean } | null>(
    initialIsDxf ? { halfTurn: false, gapFill: true } : null
  );

  const { setCanvasSpec, setActiveDemands2D } = useWorkbench2DActions();

  const activeExample = useMemo(
    () => EXAMPLES.find((e) => e.id === currentExampleId) || null,
    [currentExampleId]
  );
  const benchmark = activeExample?.benchmark || null;
  const isDxfStyleActive = useMemo(
    () => Boolean(EXAMPLES.find((e) => e.style === styleId && e.source)),
    [styleId]
  );
  const orderedSizes = useMemo(() => getOrderedSizes(styleId), [styleId]);

  const referencePreview = useMemo(
    () => (benchmark ? buildPreviewRow(fourPieceReference(), '按图复排') : null),
    [benchmark]
  );
  const optimizedPreview = useMemo(
    () => (benchmark ? buildPreviewRow(fourPieceOptimized(), '优化排料') : null),
    [benchmark]
  );

  useEffect(() => {
    sessionRef.current = new OptimizationSession();
    return () => {
      revisionRef.current++;
      sessionRef.current?.cancel();
    };
  }, []);

  const clearValidity = () => {
    Object.values(sizeInputRefs.current).forEach((el) => el?.setCustomValidity(''));
    inputWidthsRef.current?.setCustomValidity('');
  };

  const resetResults = (hasBenchmark: boolean) => {
    clearValidity();
    setRows([]);
    manualViewRef.current = false;
    setStatusText('待试算');
    if (hasBenchmark) {
      setSelectedSource({ kind: 'optimized' });
    } else {
      setSelectedSource(null);
    }
  };

  const applyExample = (ex: GarmentExample) => {
    if (!ex) return;
    setCurrentExampleId(ex.id);
    setStyleId(ex.style);
    setSizeCounts(buildSizeCounts(ex.style, ex));
    setEdgeMm(ex.edge);
    setGsmText(ex.gsm != null ? String(ex.gsm) : '');
    setWidthsText(ex.widths.join(', '));
    const dxf = EXAMPLES.find((e) => e.style === ex.style && e.source);
    if (dxf) {
      if (!previousOptionsRef.current) {
        previousOptionsRef.current = { halfTurn, gapFill };
      }
      setHalfTurn(Boolean(dxf.halfTurn));
      setGapFill(Boolean(dxf.gapFill));
    } else if (previousOptionsRef.current) {
      setHalfTurn(previousOptionsRef.current.halfTurn);
      setGapFill(previousOptionsRef.current.gapFill);
      previousOptionsRef.current = null;
    }
    resetResults(Boolean(ex.benchmark));
  };

  useEffect(() => {
    if (routeExampleId) {
      setActiveTab('width');
      const target = EXAMPLES.find((e) => e.id === routeExampleId);
      if (target && target.id !== currentExampleId) {
        applyExample(target);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeExampleId]);

  const handleStyleChange = (nextStyle: string) => {
    const dxf = EXAMPLES.find((e) => e.style === nextStyle && e.source);
    setStyleId(nextStyle);
    setCurrentExampleId('');
    setSizeCounts((prev) => buildSizeCounts(nextStyle, { ...dxf, ...prev }));
    if (dxf) {
      if (!previousOptionsRef.current) {
        previousOptionsRef.current = { halfTurn, gapFill };
      }
      setHalfTurn(Boolean(dxf.halfTurn));
      setGapFill(Boolean(dxf.gapFill));
    } else if (previousOptionsRef.current) {
      setHalfTurn(previousOptionsRef.current.halfTurn);
      setGapFill(previousOptionsRef.current.gapFill);
      previousOptionsRef.current = null;
    }
    resetResults(false);
  };

  const handlePillClick = (pillStyleId: string) => {
    const dxfEx = EXAMPLES.find((e) => e.style === pillStyleId && e.source);
    if (dxfEx) {
      applyExample(dxfEx);
      return;
    }
    handleStyleChange(pillStyleId);
  };

  const displayedRow = useMemo(() => {
    if (!selectedSource) return null;
    if (selectedSource.kind === 'row') return rows[selectedSource.index] || null;
    if (selectedSource.kind === 'optimized') return optimizedPreview;
    if (selectedSource.kind === 'reference') return referencePreview;
    return null;
  }, [selectedSource, rows, optimizedPreview, referencePreview]);

  const displayedScene = useMemo(() => {
    if (!displayedRow?.result?.layout) return null;
    return (showcaseScene as any)(displayedRow.layoutRequest, displayedRow.result, 0, {
      occupiedLengthMm: displayedRow.use?.length,
      gapFillPlacements: displayedRow.result?.marker?.gapFillPlacements
    });
  }, [displayedRow]);

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
    if (!displayedRow?.result) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            request: displayedRow.layoutRequest,
            result: displayedRow.result,
            consumption: displayedRow.use
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
    a.download = `marker-${displayedRow.width}mm.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleToStudio2D = () => {
    if (!displayedRow?.layoutRequest?.problem) return;
    const prob = displayedRow.layoutRequest.problem;
    const { materialModel } = resolveGarmentMaterialMeta(styleId, displayedRow);
    const demands = buildStudio2DDemandsFromMarker(prob.parts || []);
    setCanvasSpec({
      canvasMode: 'FREE_CANVAS',
      canvasWidthMm: displayedRow.width,
      canvasLengthMm: Math.ceil(
        displayedRow.use?.length || prob.material?.shape?.height || 2000
      ),
      materialModel2D: materialModel
    });
    setActiveDemands2D(demands);
    toast(`已将 ${displayedRow.width}mm 门幅与裁片带入二维自由画布`);
    location.hash = '#/workbench';
  };

  const totalGarmentCount = useMemo(
    () => orderedSizes.reduce((sum, sz) => sum + (Number(sizeCounts[sz]) || 0), 0),
    [orderedSizes, sizeCounts]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    clearValidity();

    const sizes: Record<string, number> = Object.fromEntries(
      orderedSizes.map((sz) => [sz, Math.trunc(Number(sizeCounts[sz]) || 0)])
    );
    const totalCount = Object.values(sizes).reduce((sum, q) => sum + q, 0);
    if (totalCount < 1 || totalCount > 12) {
      const activeEl = document.activeElement as HTMLInputElement | null;
      const targetInput =
        orderedSizes
          .map((sz) => sizeInputRefs.current[sz])
          .find((el) => el && el === activeEl) ||
        sizeInputRefs.current[orderedSizes[orderedSizes.length - 1]];
      targetInput?.setCustomValidity('每版合计须在 1–12 件之间');
      targetInput?.reportValidity();
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

    const parsedGsm = gsmText.trim() === '' ? NaN : Number(gsmText);
    const parsedEdge = Number(edgeMm) || 0;
    const compare = halfTurn;
    const filling = gapFill;

    const mine = ++revisionRef.current;
    resetResults(Boolean(benchmark));

    const initialRows: any[] = widths.flatMap((width) =>
      (compare ? [false, true] : [false]).map((ht) => ({
        width,
        halfTurn: ht,
        direction: ht ? '允许掉头' : '固定方向',
        state: '待计算',
        request: markerRequest(styleId, width, sizes, createUuid(), ht, filling)
      }))
    );

    setRows([...initialRows]);
    setIsBusy(true);
    let bestRowIdx: number | null = null;

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
              fabricConsumption(result, row.width, parsedEdge, parsedGsm, totalCount)
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
              setStatusText(`正在试排 ${row.width} mm · 允许掉头 · 原起长复试`);
            }
          );
          if (mine !== revisionRef.current) return;
          row.trial = outcome.trial;
          row.retryNote = outcome.retryNote;
          const job = row.trial.job;
          const chosen = selectMarkerTrial(job.state, row.trial, baseline?.trial, filling);
          row.usedFixed = chosen !== row.trial;
          row.layoutRequest = chosen.request;
          row.result = chosen.result;
          row.use = chosen.use;
          row.state = row.use ? '齐套' : '未取得齐套结果';
          if (chosen.job.state === 'TIMED_OUT') {
            row.state += '（试排限时结束）';
          }
          if (job.state === 'FAILED' || job.state === 'CANCELLED') {
            row.state = `${job.state === 'FAILED' ? '试算失败' : '已停止'} · ${row.state}`;
          }
          const preferTrial =
            bestRowIdx == null ||
            effectiveUtilization(row.use) >
              effectiveUtilization(initialRows[bestRowIdx].use);
          if (!manualViewRef.current && row.result?.layout && preferTrial) {
            if (bestRowIdx == null && !row.use && benchmark) {
              // Keep verified preview until at least one live row is complete
            } else {
              bestRowIdx = i;
              setSelectedSource({ kind: 'row', index: i });
            }
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
          compare ? '方案' : '幅宽'
        }齐套`
      );
    } finally {
      if (mine === revisionRef.current) {
        setIsBusy(false);
      }
    }
  };

  const garmentTabOptions: SegmentedOption<GarmentPageTab>[] = useMemo(
    () => [
      {
        value: 'width',
        label: '多门幅唛架对比',
        count: rows.length > 0 ? rows.length : undefined,
        accent: 'indigo'
      },
      {
        value: 'cutplan',
        label: '订单自动分床',
        count: cutPlanResult ? cutPlanResult.layCount : undefined,
        accent: 'emerald'
      }
    ],
    [rows.length, cutPlanResult]
  );

  const showWidthTab = embedded || activeTab === 'width';

  return (
    <div className={`react-page mp-garment-page ${embedded ? 'mp-garment-embedded' : ''}`.trim()}>
      {!embedded && (
        <div className="mp-sc-topbar">
          <h1>唛架幅宽试算</h1>
          <span className="mp-sc-sub">
            {showWidthTab
              ? '服装工艺测算 · 多门幅单耗与齐套排料对比'
              : '服装大货工艺 · 多床自动分床与尺码守恒核对'}
          </span>
          {showWidthTab && activeExample && <CodeBadge>{activeExample.id}</CodeBadge>}
          {!showWidthTab && cutPlanResult && (
            <CodeBadge>{`${cutPlanResult.layCount} 床 · ${cutPlanResult.totalPlies} 层`}</CodeBadge>
          )}
          <span className="sp" />
          <SegmentedControl<GarmentPageTab>
            size="sm"
            ariaLabel="服装唛架功能切换"
            value={activeTab}
            onChange={setActiveTab}
            options={garmentTabOptions}
          />
        </div>
      )}

      {showWidthTab ? (
        <>
          <div className="split garment-split mp-garment-split">
            <GarmentWidthFormSidebar
              helpRef={helpRef}
              sizeInputRefs={sizeInputRefs}
              inputWidthsRef={inputWidthsRef}
              styleId={styleId}
              currentExampleId={currentExampleId}
              isBusy={isBusy}
              halfTurn={halfTurn}
              gapFill={gapFill}
              orderedSizes={orderedSizes}
              sizeCounts={sizeCounts}
              widthsText={widthsText}
              edgeMm={edgeMm}
              gsmText={gsmText}
              isDxfStyleActive={isDxfStyleActive}
              onPillClick={handlePillClick}
              onToggleHalfTurn={(checked) => {
                setHalfTurn(checked);
                resetResults(Boolean(benchmark));
              }}
              onToggleGapFill={(checked) => {
                setGapFill(checked);
                resetResults(Boolean(benchmark));
              }}
              onSelectExample={applyExample}
              onChangeStyle={handleStyleChange}
              onChangeSizeCount={(size, v) => {
                setSizeCounts((prev) => ({ ...prev, [size]: v }));
                setCurrentExampleId('');
                resetResults(false);
              }}
              onChangeWidthsText={(val) => {
                setWidthsText(val);
                setCurrentExampleId('');
                resetResults(false);
              }}
              onChangeEdgeMm={(val) => {
                setEdgeMm(val);
                setCurrentExampleId('');
                resetResults(false);
              }}
              onChangeGsmText={(val) => {
                setGsmText(val);
                setCurrentExampleId('');
                resetResults(false);
              }}
              onSubmit={handleSubmit}
            />

            <GarmentWidthResultsPanel
              rows={rows}
              halfTurn={halfTurn}
              gapFill={gapFill}
              totalGarmentCount={totalGarmentCount}
              benchmark={benchmark}
              referencePreview={referencePreview}
              optimizedPreview={optimizedPreview}
              selectedSource={selectedSource}
              displayedRow={displayedRow}
              displayedScene={displayedScene}
              canvasRef={canvasRef}
              onSelectSource={(src) => {
                manualViewRef.current = true;
                setSelectedSource(src);
              }}
              onExportJson={handleExportJson}
              onToStudio2D={handleToStudio2D}
            />
          </div>

          <div className="foot mp-action-foot">
            <span role="status" className="mp-status-text">
              {statusText}
            </span>
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
        </>
      ) : (
        <GarmentCutPlanPanel
          form={cutPlanForm}
          onFormChange={setCutPlanForm}
          result={cutPlanResult}
          onResultChange={setCutPlanResult}
          error={cutPlanError}
          onErrorChange={setCutPlanError}
        />
      )}
    </div>
  );
};
