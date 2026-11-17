import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fmtN } from '@static/app/js/util.js';
import { createRollCanvas } from '@static/app/js/canvas/roll-canvas.js';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import {
  SHOWCASE_CASES,
  WORKFLOW_GUIDES,
  WORKFLOW_TEMPLATES,
  showcaseRequest,
  showcaseScene
} from '@static/app/js/model/showcase.js';
import { fulfillmentReason } from '@static/js/business/cutting/demand-progress-model.js';
import {
  independentBaseline,
  planSummary
} from '@static/js/linear/linear-model.js';

const METRIC_LABELS: Record<string, [string, string]> = {
  processingAreaUtilization: ['加工区占用率', '裁片净面积 / 本次加工区面积'],
  markerAreaUtilization: [
    '预计唛架利用率',
    '齐套衣片面积 / 实际唛架面积，排除未用尾料'
  ],
  motherAreaUtilization: [
    '预计产出面积占比',
    '含超产面积 / 母卷面积，含固定切边'
  ],
  usableAreaUtilization: [
    '可切区占用率',
    '含超产面积 / 扣除切边后的可用面积'
  ]
};

export const ShowcasePage: React.FC<{ params?: string[] }> = ({
  params = []
}) => {
  const [caseId] = params;
  const selected = useMemo(
    () => SHOWCASE_CASES.find((c: any) => c.id === caseId) || null,
    [caseId]
  );

  // Catalogue state
  const [activeGroup, setActiveGroup] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Detail case state
  const [request, setRequest] = useState<any>(() =>
    selected ? showcaseRequest(selected.id) : null
  );
  const [result, setResult] = useState<any>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [cancelledHint, setCancelledHint] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [stateText, setStateText] = useState<string>('待计算');
  const [patternIndex, setPatternIndex] = useState<number>(0);
  const [vertical, setVertical] = useState<boolean>(true);
  const [showPath, setShowPath] = useState<boolean>(false);
  const [selectionText, setSelectionText] = useState<string>(
    '滚轮缩放，拖动平移；右键查看裁片尺寸。'
  );
  const [slitRuns, setSlitRuns] = useState<Record<string, any>>({});

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const tokenRef = useRef<number>(0);
  const stateRef = useRef({ request, result, patternIndex });
  stateRef.current = { request, result, patternIndex };

  useEffect(() => {
    if (!selected) {
      tokenRef.current++;
      sessionRef.current?.cancel();
      canvasRef.current?.destroy();
      canvasRef.current = null;
      return;
    }
    const initReq = showcaseRequest(selected.id);
    setRequest(initReq);
    setResult(null);
    setErrorText(null);
    setCancelledHint(false);
    setBusy(false);
    setStateText('待计算');
    setPatternIndex(0);
    setVertical(true);
    setShowPath(false);
    setSlitRuns({});
    setSelectionText('滚轮缩放，拖动平移；右键查看裁片尺寸。');

    let disposed = false;
    sessionRef.current = new (OptimizationSession as any)(
      undefined,
      150,
      (err?: any) => {
        if (!disposed) setStateText('未确认停止：' + (err?.message || ''));
      }
    );

    if (canvasHostRef.current) {
      canvasRef.current?.destroy();
      canvasRef.current = createRollCanvas(canvasHostRef.current, {
        onContextMenu: (hit: any) => {
          const st = stateRef.current;
          if (!st.request) return;
          const sc = showcaseScene(st.request, st.result, st.patternIndex);
          const piece = sc.segments[0]?.pieces?.find(
            (p: any) => p.id === hit?.entityId
          );
          setSelectionText(
            piece
              ? `${piece.label} · X ${fmtN(piece.v, 1)} / Y ${fmtN(
                  piece.u,
                  1
                )} mm · ${fmtN(piece.dv, 1)} × ${fmtN(piece.du, 1)} mm`
              : '右键查看裁片尺寸。'
          );
        }
      });
      canvasRef.current.setScene(showcaseScene(initReq, null, 0), {
        refit: true
      });
    }

    return () => {
      disposed = true;
      tokenRef.current++;
      sessionRef.current?.cancel();
      canvasRef.current?.destroy();
      canvasRef.current = null;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected || !request || !canvasRef.current) return;
    canvasRef.current.setScene(showcaseScene(request, result, patternIndex), {
      refit: true
    });
  }, [selected, request, result, patternIndex]);

  const handleRun = async (profile = 'FAST') => {
    if (!selected || busy) return;
    const mine = ++tokenRef.current;
    const nextReq = showcaseRequest(selected.id, profile);
    setRequest(nextReq);
    setResult(null);
    setErrorText(null);
    setCancelledHint(false);
    setPatternIndex(0);
    setBusy(true);
    setStateText('正在提交计算…');
    try {
      const response = await sessionRef.current.solve(nextReq, {
        onProgress: (j: any) => {
          if (mine === tokenRef.current) {
            setStateText(j.message || j.phase || j.state);
          }
        }
      });
      if (mine !== tokenRef.current) return;
      const res = response.result;
      setResult(res);
      if (selected.kind === 'slitting') {
        setSlitRuns((prev) => ({ ...prev, [profile]: res }));
      }
      setStateText(
        `${
          res.fulfillmentStatus === 'COMPLETE'
            ? '计算完成 · 齐套'
            : '计算结束 · 未齐套'
        }${response.job.state !== 'SUCCEEDED' ? ' · 搜索提前结束' : ''}`
      );
    } catch (e: any) {
      if (mine !== tokenRef.current) return;
      if (e.name === 'AbortError') {
        setStateText('已停止计算');
      } else {
        setStateText('计算未完成，可重试');
        setErrorText(e.message);
      }
    } finally {
      if (mine === tokenRef.current) {
        setBusy(false);
      }
    }
  };

  const handleCancel = () => {
    tokenRef.current++;
    sessionRef.current?.cancel();
    setBusy(false);
    setStateText('已请求停止计算');
    setResult(null);
    setErrorText(null);
    setCancelledHint(true);
  };

  const handleDownloadJson = (suffix: string, value: any) => {
    if (!selected || !value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.id}-${suffix}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!selected) {
    const groups = [...new Set(SHOWCASE_CASES.map((c: any) => c.group))];
    const qLower = searchQuery.trim().toLowerCase();
    const onlyWorkflow = activeGroup === '__workflow__';

    return (
      <div className="react-page page-host">
        <div className="ph">
          <h1>能力展示</h1>
          <span className="crumb">
            算法基准与业务演练沙盒 · {SHOWCASE_CASES.length} 个计算用例 · 6
            条业务演示路线
          </span>
        </div>
        <div className="toolbar">
          <div className="seg" id="case-tabs" role="group" aria-label="沙盒分类">
            <button
              type="button"
              className={activeGroup === 'all' ? 'on' : ''}
              data-group-filter="all"
              onClick={() => setActiveGroup('all')}
            >
              全部 ({SHOWCASE_CASES.length})
            </button>
            {groups.map((g: any) => (
              <button
                key={g}
                type="button"
                className={activeGroup === g ? 'on' : ''}
                data-group-filter={g}
                onClick={() => setActiveGroup(g)}
              >
                {g}
              </button>
            ))}
            <button
              type="button"
              className={activeGroup === '__workflow__' ? 'on' : ''}
              data-group-filter="__workflow__"
              onClick={() => setActiveGroup('__workflow__')}
            >
              业务流程演练 (6)
            </button>
          </div>
          <span className="sp" />
          <label>
            查找用例{' '}
            <input
              className="field"
              id="case-search"
              type="search"
              placeholder="行业、规则或异常"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
          <span className="muted">
            计算演示不扣库存；业务流程使用实际任务。
          </span>
        </div>

        <div className="body">
          <div id="case-catalogue" hidden={onlyWorkflow}>
            {groups.map((group: any) => {
              const groupCases = SHOWCASE_CASES.filter(
                (c: any) => c.group === group
              );
              const anyVisible = groupCases.some((c: any) => {
                const groupMatch = activeGroup === 'all' || c.group === activeGroup;
                const kindText =
                  c.kind === 'marker'
                    ? '齐套与用布优化'
                    : c.kind === 'slitting'
                    ? '独立分切 / 快速 / 精细'
                    : '二维计算';
                const textMatch =
                  !qLower ||
                  `${kindText}${c.name}${c.note}打开用例 →${c.group}`
                    .toLowerCase()
                    .includes(qLower);
                return groupMatch && textMatch;
              });
              return (
                <section
                  key={group}
                  data-case-group={group}
                  hidden={!anyVisible}
                >
                  <h3>{group}</h3>
                  <div className="cards">
                    {groupCases.map((c: any) => {
                      const kindText =
                        c.kind === 'marker'
                          ? '齐套与用布优化'
                          : c.kind === 'slitting'
                          ? '独立分切 / 快速 / 精细'
                          : '二维计算';
                      const groupMatch =
                        activeGroup === 'all' || c.group === activeGroup;
                      const textMatch =
                        !qLower ||
                        `${kindText}${c.name}${c.note}打开用例 →${c.group}`
                          .toLowerCase()
                          .includes(qLower);
                      const isHidden = !(groupMatch && textMatch);
                      return (
                        <a
                          key={c.id}
                          className="card demo-card"
                          data-case={c.id}
                          href={`#/showcase/${encodeURIComponent(c.id)}`}
                          hidden={isHidden}
                        >
                          <small>{kindText}</small>
                          <b>{c.name}</b>
                          <p>{c.note}</p>
                          <span>打开用例 →</span>
                        </a>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <div
            id="workflow-sandbox"
            hidden={activeGroup !== 'all' && !onlyWorkflow}
          >
            <section>
              <h3>
                业务演示数据 <span className="tag warn">写入演练库</span>
              </h3>
              <p className="muted">
                先登记演示母卷并完成检验，再创建匹配任务。按钮只预填表单；点击保存才写入数据。
              </p>
              <div className="cards">
                {WORKFLOW_TEMPLATES.map((t: any) => (
                  <article key={t.id} className="card demo-card">
                    <b>{t.name}</b>
                    <p>
                      母卷 {t.width} mm × {t.totalLength / 1000} m · 拉布{' '}
                      {t.bedLength} mm ·{' '}
                      {t.demands.reduce((n: number, d: any) => n + d[3], 0)} 件 / 卷
                    </p>
                    <a className="btn sm" href={`#/inventory/receive/${t.id}`}>
                      ① 登记演示母卷
                    </a>{' '}
                    <a className="btn sm" href={`#/task/new/${t.id}`}>
                      ② 创建演示任务
                    </a>
                  </article>
                ))}
              </div>
            </section>
            <section>
              <h3>完整业务流程</h3>
              <p className="muted">
                以下步骤使用新版实际业务页面，报工会记账。建议使用单独登记的演示材料和任务。
              </p>
              <div className="cards">
                {WORKFLOW_GUIDES.map(
                  ([title, steps, acceptance, route]: [
                    string,
                    string,
                    string,
                    string
                  ]) => (
                    <article key={title} className="card demo-card">
                      <b>{title}</b>
                      <p>{steps}</p>
                      <p>
                        <strong>验收：</strong>
                        {acceptance}
                      </p>
                      <a className="btn sm" href={`#/${route}`}>
                        进入{title}
                      </a>
                    </article>
                  )
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  const slit = selected.kind === 'slitting';
  const p = request?.problem || {};
  const inputRows = slit
    ? (p.orders || []).map((o: any) => [
        o.id,
        o.widthMm,
        o.lengthMm,
        o.quantity
      ])
    : (p.parts || []).map((o: any) => [
        o.name,
        o.shape.width,
        o.shape.height,
        o.quantity
      ]);
  const currentSc = request ? showcaseScene(request, result, patternIndex) : null;

  return (
    <div className="react-page page-host">
      <div className="ph">
        <a className="btn" href="#/showcase">
          ← 用例库
        </a>
        <h1>{selected.name}</h1>
        <span className="sp" />
        <span className="tag">计算预览 · 不扣库存</span>
      </div>
      <div className="toolbar">
        <span>{selected.note}</span>
      </div>

      <div className="split demo-split">
        <section className="pane">
          <div className="pane-h">输入与演示步骤</div>
          <div className="pane-b" id="demo-input">
            <div className="kv">
              <div>材料幅宽</div>
              <div className="num">
                {fmtN(slit ? p.motherWidthMm : p.material?.shape?.width)} mm
              </div>
              <div>{slit ? '切边 左 / 右' : '加工长度'}</div>
              <div className="num">
                {slit
                  ? `${p.leftTrimMm} / ${p.rightTrimMm}`
                  : fmtN(p.material?.shape?.height)}{' '}
                mm
              </div>
            </div>
            {slit && currentSc && (
              <div className="demo-note">
                图示段长 {fmtN(currentSc.roll.total)} mm；订单卷长见下表，图示不展开整卷。
              </div>
            )}
            <table className="t">
              <thead>
                <tr>
                  <th>需求</th>
                  <th>宽×长 mm</th>
                  <th>数量</th>
                </tr>
              </thead>
              <tbody>
                {inputRows.map((r: any, idx: number) => (
                  <tr key={idx}>
                    <td className="wrap">{r[0]}</td>
                    <td className="num">
                      {fmtN(r[1])}×{fmtN(r[2])}
                    </td>
                    <td className="num">{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sec">操作与验收</div>
            <ol className="demo-steps">
              <li>核对材料、需求和工艺；点击计算。</li>
              <li>
                {slit
                  ? '查看组合、重复车数、缺口与超产；切换组合查看条宽。'
                  : '查看裁片、禁入区与未排原因；矩形方案可打开刀序。'}
              </li>
              <li>
                {selected.kind === 'marker'
                  ? '核对每种衣片是否齐套及各轮试排记录；搜索结果不保证全局最优。'
                  : selected.id === '6'
                  ? '这里只计算一个工位；多工位报工接续请使用用例库中的业务演示路线。'
                  : slit
                  ? '运行精细优化与快速结果对比；基线逐规格开卷，不受组合下限约束。'
                  : '预览不扣库存。未排入并不等同于证明无解。'}
              </li>
            </ol>
            {(selected.kind === 'marker' || selected.id.startsWith('GARMENT')) && (
              <p className="demo-note">
                服装曲边为折线近似，未包含对条对格、缝份及任意角度旋转。
              </p>
            )}
            <details className="demo-note">
              <summary>查看输入 JSON</summary>
              <pre>{JSON.stringify(request, null, 2)}</pre>
            </details>
          </div>
        </section>

        <section className="pane">
          <div className="pane-h">
            {slit ? '定长横切示意' : '排料图'}
            <span className="sp" />
            <button
              type="button"
              className="btn sm"
              id="demo-fit"
              onClick={() => canvasRef.current?.fit()}
            >
              适合窗口
            </button>
            <button
              type="button"
              className="btn sm"
              id="demo-rotate"
              onClick={() => {
                const next = !vertical;
                setVertical(next);
                canvasRef.current?.setOptions({ vertical: next });
              }}
            >
              横 / 竖
            </button>
            <button
              type="button"
              className="btn sm"
              id="demo-path"
              aria-pressed={showPath}
              disabled={slit || p.process?.mode === 'CONTOUR'}
              title={
                slit || p.process?.mode === 'CONTOUR'
                  ? '此演示没有可执行刀序'
                  : undefined
              }
              onClick={() => {
                const next = !showPath;
                setShowPath(next);
                canvasRef.current?.setOptions({ showPath: next });
              }}
            >
              刀序
            </button>
          </div>
          <div
            ref={canvasHostRef}
            id="demo-canvas"
            className="demo-canvas"
            tabIndex={0}
            aria-label="演示排料画布"
          />
          <div className="foot" id="demo-selection">
            {selectionText}
          </div>
        </section>

        <section className="pane">
          <div className="pane-h">计算结果</div>
          <div className="pane-b" id="demo-result">
            {busy ? (
              <div className="empty">计算中…</div>
            ) : errorText ? (
              <div className="error-box" role="alert">
                {errorText}
              </div>
            ) : cancelledHint ? (
              <div className="empty">本次计算已停止，可重新计算。</div>
            ) : !result ? (
              <div className="empty">尚未计算</div>
            ) : (
              (() => {
                const layout = result.layout;
                const s = result.slitting;
                const fulfilled = s?.fulfillment || layout?.fulfillment || [];
                const count = s
                  ? s.patterns.reduce(
                      (n: number, pat: any) => n + pat.repetitions,
                      0
                    )
                  : layout.placements.length;
                let compareRows: any[] = [];
                if (s) {
                  const oldInput = {
                    motherWidth: p.motherWidthMm,
                    leftTrim: p.leftTrimMm,
                    rightTrim: p.rightTrimMm,
                    orderItems: p.orders.map((o: any) => ({
                      width: o.widthMm,
                      length: o.lengthMm,
                      quantity: o.quantity,
                      surfaceTreatment: o.surfaceTreatment
                    }))
                  };
                  const baseline = planSummary(
                    independentBaseline(oldInput),
                    oldInput
                  );
                  compareRows = [
                    ['逐规格独立分切', baseline.rolls, 0, 0],
                    ...Object.entries(slitRuns).map(([prof, r]: [string, any]) => [
                      prof === 'FAST' ? '快速搭切' : '精细优化',
                      r.slitting.patterns.reduce(
                        (n: number, pat: any) => n + pat.repetitions,
                        0
                      ),
                      r.slitting.fulfillment.reduce(
                        (n: number, f: any) => n + f.missing,
                        0
                      ),
                      r.slitting.totalOverproduced
                    ])
                  ];
                }

                return (
                  <>
                    <div className="metric">
                      <div>
                        <small>{slit ? '计划车数' : '已排裁片'}</small>
                        <b>
                          {count}
                          <em>{slit ? '车' : '件'}</em>
                        </b>
                      </div>
                      <div>
                        <small>需求完成状态</small>
                        <strong>
                          {result.fulfillmentStatus === 'COMPLETE'
                            ? '齐套'
                            : '未齐套'}
                        </strong>
                      </div>
                    </div>
                    <div className="demo-note">
                      {layout?.message || ''}
                      {result.fulfillmentStatus !== 'COMPLETE'
                        ? ' 请核对缺口；不能作为齐套完成。'
                        : ''}
                    </div>
                    <table className="t">
                      <thead>
                        <tr>
                          <th>需求</th>
                          <th>已排 / 需求</th>
                          <th>缺口</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fulfilled.map((f: any, idx: number) => (
                          <React.Fragment key={idx}>
                            <tr>
                              <td className="wrap">
                                {p.parts?.find(
                                  (pt: any) => pt.id === f.demandId
                                )?.name ||
                                  f.orderId ||
                                  f.demandId}
                              </td>
                              <td className="num">
                                {f.placed ?? f.produced ?? 0} / {f.requested}
                              </td>
                              <td className="num">
                                {f.missing ?? f.unplaced ?? 0}
                              </td>
                            </tr>
                            {f.reason &&
                              Boolean(f.unplaced || f.missing) && (
                                <tr>
                                  <td colSpan={3} className="wrap muted">
                                    <small>{fulfillmentReason(f.reason)}</small>
                                  </td>
                                </tr>
                              )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>

                    {s && (
                      <>
                        <div className="sec">分切组合（单车示意）</div>
                        {s.patterns.map((pat: any, i: number) => (
                          <button
                            key={pat.id || i}
                            type="button"
                            className="btn demo-pattern"
                            data-pattern={i}
                            onClick={() => setPatternIndex(i)}
                          >
                            {i + 1}.{' '}
                            {pat.stations
                              .map(
                                (v: any) =>
                                  `${v.widthMm}×${v.countPerRepetition}`
                              )
                              .join(' + ')}{' '}
                            · {pat.repetitions} 车
                          </button>
                        ))}
                        <div id="demo-compare">
                          <div className="sec">同一输入对比</div>
                          <table className="t">
                            <thead>
                              <tr>
                                <th>方法</th>
                                <th>车数</th>
                                <th>缺口</th>
                                <th>超产</th>
                              </tr>
                            </thead>
                            <tbody>
                              {compareRows.map((row, rIdx) => (
                                <tr key={rIdx}>
                                  {row.map((v: any, cIdx: number) => (
                                    <td key={cIdx}>{v}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}

                    {result.marker && (
                      <>
                        <div className="sec">齐套缩短记录</div>
                        <ol className="demo-steps">
                          {result.marker.trials.map((t: any, idx: number) => (
                            <li key={idx}>
                              {fmtN(t.lengthMm)} mm：
                              {t.complete
                                ? `齐套，占用 ${fmtN(t.occupiedLengthMm)} mm`
                                : `未齐套，排入 ${t.placed} 件`}
                            </li>
                          ))}
                        </ol>
                        <p className="demo-note">
                          {result.marker.occupiedLengthMm != null
                            ? `实际唛架 ${fmtN(
                                result.marker.occupiedLengthMm
                              )} mm；未使用尾料不计入用布。`
                            : '本次搜索未形成齐套唛架。'}
                        </p>
                      </>
                    )}

                    <div className="sec">指标与口径</div>
                    {(result.metrics || []).map((m: any) => (
                      <div key={m.name} className="demo-note">
                        {METRIC_LABELS[m.name]?.[0] || m.name}：
                        <b className="num">
                          {fmtN(m.value, 3)} {m.unit}
                        </b>
                        <br />
                        <small>{METRIC_LABELS[m.name]?.[1] || m.basis}</small>
                      </div>
                    ))}
                  </>
                );
              })()
            )}
          </div>
        </section>
      </div>

      <div className="foot">
        <span id="demo-state" role="status">
          {stateText}
        </span>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          id="demo-input-export"
          onClick={() => handleDownloadJson('input', request)}
        >
          导出输入
        </button>
        <button
          type="button"
          className="btn"
          id="demo-result-export"
          disabled={!result}
          onClick={() => handleDownloadJson('result', result)}
        >
          导出结果
        </button>
        <button
          type="button"
          className="btn"
          id="demo-cancel"
          hidden={!busy}
          onClick={handleCancel}
        >
          停止计算
        </button>
        <button
          type="button"
          className="btn pri"
          id="demo-run"
          disabled={busy}
          onClick={() => handleRun('FAST')}
        >
          {slit ? '快速搭切' : '开始计算'}
        </button>
        {slit && (
          <button
            type="button"
            className="btn"
            id="demo-quality"
            disabled={busy}
            onClick={() => handleRun('QUALITY')}
          >
            精细优化
          </button>
        )}
      </div>
    </div>
  );
};
