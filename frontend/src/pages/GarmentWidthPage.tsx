import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NumberInput } from '../components/ui/NumberInput';
import { fmtN, toast, createUuid } from '@static/app/js/util.js';
import {
  DXF_TRIAL_STYLES,
  GARMENT_TRIAL_STYLES,
  MARKER_STYLES,
  markerSizeLabels
} from '@static/js/nesting/marker-demo.js';
import { fourPieceReference } from '@static/js/nesting/dxf-reference.js';
import { fourPieceOptimized } from '@static/js/nesting/four-piece-seed.js';
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
import { CadCanvasView } from '../components/CadCanvasView';
import { showcaseScene } from '@static/app/js/model/showcase.js';
import { useStudioStore } from '../store/useStudioStore';
import { CodeBadge } from '../components/ui/MagpiePrimitives';

interface GarmentExample {
  id: string;
  name: string;
  style: string;
  widths: number[];
  edge: number;
  gsm?: number | null;
  source?: string;
  fabric?: string;
  halfTurn?: boolean;
  gapFill?: boolean;
  benchmark?: {
    width: number;
    length: number;
    counts: Record<string, number>;
    utilization: number;
    dxfUtilization: number;
  };
  [size: string]: any;
}

const EXAMPLES = GARMENT_EXAMPLES as GarmentExample[];

type SelectedSource =
  | { kind: 'row'; index: number }
  | { kind: 'optimized' }
  | { kind: 'reference' }
  | null;

function buildPreviewRow(layout: any, direction: string) {
  const { request, result, verified } = layout;
  return {
    width: verified.widthMm,
    layoutRequest: request,
    result,
    direction,
    state: `${verified.pieceCount} 片 · 掉头 ${verified.rotatedCount} 片`,
    use: {
      length: verified.occupiedLengthMm,
      utilization: verified.utilizationPercent,
      gramsPerGarment: null
    },
    verified
  };
}

function getOrderedSizes(style: string): string[] {
  const dxf = EXAMPLES.find((e) => e.style === style && e.source);
  const sizes: string[] = markerSizeLabels(style);
  return dxf
    ? [...sizes.filter((s) => dxf[s] > 0), ...sizes.filter((s) => !dxf[s])]
    : sizes;
}

function buildSizeCounts(style: string, source?: Record<string, any>): Record<string, number> {
  const dxf = EXAMPLES.find((e) => e.style === style && e.source);
  const sizes: string[] = markerSizeLabels(style);
  const out: Record<string, number> = {};
  for (const s of sizes) {
    const raw = source?.[s] ?? dxf?.[s] ?? 1;
    out[s] = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  }
  return out;
}

const QUICK_PILL_STYLES = [
  ...DXF_TRIAL_STYLES.filter((s: any) => s.fabric === '面布'),
  ...MARKER_STYLES
];

export const GarmentWidthPage: React.FC<{ exampleId?: string; embedded?: boolean }> = ({
  exampleId: routeExampleId,
  embedded = false
}) => {
  const resolveInitialExample = (id?: string): GarmentExample =>
    EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];

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

  const setCanvasSpec = useStudioStore((s) => s.setCanvasSpec);
  const setActiveDemands2D = useStudioStore((s) => s.setActiveDemands2D);

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

  const resolveMaterialMeta = () => {
    const dxfTrial = DXF_TRIAL_STYLES.find((s: any) => s.id === styleId);
    const dxfLegacy = (DXF_GARMENT_STYLES as any)[styleId];
    const styleName =
      GARMENT_TRIAL_STYLES.find((s: any) => s.id === styleId)?.name || '服装唛架';
    const materialModel =
      dxfTrial?.fabric ||
      dxfLegacy?.materialModel ||
      (displayedRow ? `GARMENT-${Math.round(displayedRow.width)}` : 'TC涤棉-B2026');
    const externalRef = dxfTrial
      ? `${dxfTrial.source}.dxf · ${fmtN(displayedRow?.width ?? 1780, 1)}mm`
      : dxfLegacy
      ? `CAD纸样 ${dxfLegacy.file} · ${fmtN(displayedRow?.width ?? 1650, 1)}mm`
      : `唛架试算 ${fmtN(displayedRow?.width ?? 1500, 1)}mm (${
          displayedRow?.direction || ''
        })`;
    return { styleName, materialModel, externalRef };
  };

  const handleToTask = () => {
    if (!displayedRow?.layoutRequest?.problem) return;
    const prob = displayedRow.layoutRequest.problem;
    const { styleName, materialModel, externalRef } = resolveMaterialMeta();
    const draft = {
      name: `${styleName} · ${fmtN(displayedRow.width, 0)}mm 幅宽试算转排产`,
      problemType: 'NESTING_2D',
      materialModel,
      externalRef,
      process: {
        bedLength: Math.ceil(
          displayedRow.use?.length || prob.material?.shape?.height || 5000
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
    if (!displayedRow?.layoutRequest?.problem) return;
    const prob = displayedRow.layoutRequest.problem;
    const { materialModel } = resolveMaterialMeta();
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
    () =>
      orderedSizes.reduce((sum, sz) => sum + (Number(sizeCounts[sz]) || 0), 0),
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
        request: markerRequest(
          styleId,
          width,
          sizes,
          createUuid(),
          ht,
          filling
        )
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
              fabricConsumption(
                result,
                row.width,
                parsedEdge,
                parsedGsm,
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
            filling
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
          const preferTrial =
            bestRowIdx == null ||
            effectiveUtilization(row.use) >
              effectiveUtilization(initialRows[bestRowIdx].use);
          if (!manualViewRef.current && row.result?.layout && preferTrial) {
            if (bestRowIdx == null && !row.use && benchmark) {
              // Keep verified preview until at least one live row is complete, unless no preview exists
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

  const validRows = rows.filter((r) => r.use);
  const finiteGramRows = validRows.filter((r) =>
    Number.isFinite(r.use?.gramsPerGarment)
  );
  const lowestGrams = finiteGramRows.length
    ? Math.min(...finiteGramRows.map((r) => r.use.gramsPerGarment))
    : Infinity;
  const highestUtil = validRows.length
    ? Math.max(...validRows.map((r) => effectiveUtilization(r.use)))
    : -Infinity;
  const lowestRow =
    finiteGramRows.find((r) => r.use.gramsPerGarment === lowestGrams) || null;
  const highestRow =
    validRows.find((r) => effectiveUtilization(r.use) === highestUtil) || null;
  const recommendedRow = lowestRow || highestRow;

  const buildTrialDetailNodes = (row: any) => {
    const info: string[] = halfTurn ? [row.direction] : [];
    if (referencePreview && row.use) {
      const delta = row.use.utilization - referencePreview.use.utilization;
      info.push(`较按图复排 ${delta > 0 ? '+' : ''}${fmtN(delta, 2)} 个百分点`);
    }
    const seed = row.result?.marker?.trials?.find((t: any) => t.phase === 'SEED');
    if (seed && row.use) {
      const improvement = seed.occupiedLengthMm - row.use.length;
      info.push(
        improvement > 0.005
          ? `较初排缩短 ${fmtN(improvement, 2)} mm`
          : '沿用已验初排'
      );
    }
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
    if (saved > 0 && !seed) {
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
    <div className={`react-page mp-garment-page ${embedded ? 'mp-garment-embedded' : ''}`.trim()}>
      {!embedded && (
        <div className="mp-sc-topbar">
          <h1>唛架幅宽试算</h1>
          <span className="mp-sc-sub">服装工艺测算 · 多门幅单耗与齐套排料对比</span>
          {activeExample && <CodeBadge>{activeExample.id}</CodeBadge>}
        </div>
      )}

      <div className="split garment-split mp-garment-split">
        <section className="pane mp-float-card mp-garment-left">
          <div className="pane-b">
            <details
              id="garment-help"
              ref={helpRef}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && helpRef.current?.open) {
                  e.preventDefault();
                  helpRef.current.open = false;
                  helpRef.current.querySelector('summary')?.focus();
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
                  每版合计 1–12 件。有效幅宽可填 1–8 个值，范围 1200–2000
                  mm，用逗号或空格分隔。
                </p>
                <p id="weight-help">
                  每件用布重量按含布边的幅宽、实际唛架长度和克重估算，未计布头、布尾及备损。
                </p>
              </div>
            </details>

            <div
              className="style-pills mp-style-pills"
              id="garment-style-pills"
              aria-label="快捷样板选择"
            >
              {QUICK_PILL_STYLES.map((s: any) => (
                <button
                  key={s.id}
                  type="button"
                  className={`style-pill ${styleId === s.id ? 'on' : ''}`}
                  data-style-pill={s.id}
                  disabled={isBusy}
                  onClick={() => handlePillClick(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>

            <form
              id="garment-form"
              className="form mp-garment-form"
              onSubmit={handleSubmit}
            >
              <label htmlFor="garment-half-turn">允许 180° 旋转</label>
              <input
                id="garment-half-turn"
                name="halfTurn"
                type="checkbox"
                className="ux-switch"
                aria-describedby="angle-help"
                disabled={isBusy}
                checked={halfTurn}
                onChange={(e) => {
                  setHalfTurn(e.target.checked);
                  resetResults(Boolean(benchmark));
                }}
              />
              <label htmlFor="garment-gap-fill">同款裁片补空</label>
              <input
                id="garment-gap-fill"
                name="gapFill"
                type="checkbox"
                className="ux-switch"
                aria-describedby="fill-help"
                disabled={isBusy}
                checked={gapFill}
                onChange={(e) => {
                  setGapFill(e.target.checked);
                  resetResults(Boolean(benchmark));
                }}
              />
              <label htmlFor="garment-example">试算示例</label>
              <select
                className="field"
                id="garment-example"
                name="example"
                disabled={isBusy}
                value={currentExampleId}
                onChange={(e) => {
                  const ex = EXAMPLES.find(
                    (item) => item.id === e.target.value
                  );
                  if (ex) applyExample(ex);
                }}
              >
                <option value="" disabled>
                  自定义参数
                </option>
                {EXAMPLES.map((e) => (
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
                onChange={(e) => handleStyleChange(e.target.value)}
              >
                {GARMENT_TRIAL_STYLES.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>

              <div id="garment-sizes">
                {orderedSizes.map((size) => {
                  const inputId = `garment-${size.toLowerCase()}`;
                  return (
                    <React.Fragment key={size}>
                      <label htmlFor={inputId}>{size} 码（件/版）</label>
                      <NumberInput
                        ref={(el) => {
                          sizeInputRefs.current[size] = el;
                        }}
                        className="field"
                        id={inputId}
                        name={size}
                        min={0}
                        max={12}
                        fallback={0}
                        integer
                        required
                        disabled={isBusy}
                        value={sizeCounts[size] ?? 0}
                        onValueChange={(v) => {
                          setSizeCounts((prev) => ({
                            ...prev,
                            [size]: v
                          }));
                          setCurrentExampleId('');
                          resetResults(false);
                        }}
                      />
                    </React.Fragment>
                  );
                })}
              </div>

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
                  setCurrentExampleId('');
                  resetResults(false);
                }}
              />
              <label htmlFor="garment-edge">两侧布边合计（mm）</label>
              <NumberInput
                className="field"
                id="garment-edge"
                name="edge"
                min={0}
                step="0.1"
                fallback={0}
                required
                disabled={isBusy}
                value={edgeMm}
                onValueChange={(v) => {
                  setEdgeMm(v);
                  setCurrentExampleId('');
                  resetResults(false);
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
                required={!isDxfStyleActive}
                placeholder={isDxfStyleActive ? '选填（留空不计克重）' : undefined}
                disabled={isBusy}
                value={gsmText}
                onChange={(e) => {
                  setGsmText(e.target.value);
                  setCurrentExampleId('');
                  resetResults(false);
                }}
              />
            </form>
          </div>
        </section>

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
                <span
                  className="mp-seg mp-seg-sm"
                  role="group"
                  aria-label="排料方案"
                >
                  <button
                    className={`mp-seg-btn ${
                      selectedSource?.kind === 'optimized' ? 'on' : ''
                    }`}
                    id="garment-optimum"
                    type="button"
                    aria-pressed={selectedSource?.kind === 'optimized'}
                    onClick={() => {
                      manualViewRef.current = true;
                      setSelectedSource({ kind: 'optimized' });
                    }}
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
                    onClick={() => {
                      manualViewRef.current = true;
                      setSelectedSource({ kind: 'reference' });
                    }}
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
                          {buildTrialDetailNodes(r)}
                        </td>
                        <td className="num">
                          {Number.isFinite(r.use?.length)
                            ? fmtN(r.use.length, 2)
                            : '—'}
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
                              onClick={() => {
                                manualViewRef.current = true;
                                setSelectedSource({ kind: 'row', index: i });
                              }}
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
                onClick={handleExportJson}
              >
                导出唛架 JSON
              </button>
              <button
                type="button"
                className="mp-cad-btn"
                disabled={!displayedRow?.result?.layout}
                onClick={handleToStudio2D}
              >
                送入二维自由画布
              </button>
              <button
                type="button"
                className="mp-cad-btn accent"
                id="garment-to-task"
                disabled={!displayedRow?.result?.layout}
                title="将当前选中的门幅与样板裁片带入新建二维生产任务"
                onClick={handleToTask}
              >
                转入生产任务
              </button>
            </div>
            <div
              id="garment-canvas"
              className="demo-canvas"
              aria-label="当前候选唛架"
            >
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
    </div>
  );
};
