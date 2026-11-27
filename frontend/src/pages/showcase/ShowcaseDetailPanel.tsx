import React from 'react';
import { fmtN } from '../../lib/core/util.js';
import { CadCanvasView } from '../../components/CadCanvasView';
import { SHOWCASE_CASES, showcaseScene } from '../../lib/model/showcase.js';
import { fulfillmentReason } from '../../lib/domain/demand-progress-model.js';
import {
  CodeBadge,
  SegmentedControl,
  SegmentedOption
} from '../../components/ui/MagpiePrimitives';
import { DetailSideTab, getCaseMeta } from './showcaseCaseMeta';
import {
  CaseInputSummary,
  METRIC_LABELS,
  VerificationRecord,
  buildSlittingCompareRows
} from './showcaseEvaluation';
import type { ShowcaseSlitDraft } from './showcaseSlitDraft';
import { ShowcaseSlitConfigCard } from './ShowcaseSlitConfigCard';

interface ShowcaseDetailPanelProps {
  selected: any;
  request: any;
  result: any;
  errorText: string | null;
  cancelledHint: boolean;
  busy: boolean;
  stateText: string;
  patternIndex: number;
  onChangePatternIndex: (idx: number) => void;
  vertical: boolean;
  onToggleVertical: () => void;
  showPath: boolean;
  onToggleShowPath: () => void;
  selectionText: string;
  detailTab: DetailSideTab;
  onChangeDetailTab: (next: DetailSideTab) => void;
  activeScene: any;
  canvasRef: React.MutableRefObject<any>;
  onContextInspect: (hit: any) => void;
  slitRuns: Record<string, any>;
  slitDraft: ShowcaseSlitDraft | null;
  onPatchSlitDraft: (patch: Partial<ShowcaseSlitDraft>) => void;
  onResetSlitDraft: () => void;
  caseInputSummaries: Record<string, CaseInputSummary>;
  verifications: Record<string, VerificationRecord>;
  onDownloadJson: (suffix: string, value: any) => void;
  onCancel: () => void;
  onRun: (profile: string) => void;
}

export const ShowcaseDetailPanel: React.FC<ShowcaseDetailPanelProps> = ({
  selected,
  request,
  result,
  errorText,
  cancelledHint,
  busy,
  stateText,
  patternIndex,
  onChangePatternIndex,
  vertical,
  onToggleVertical,
  showPath,
  onToggleShowPath,
  selectionText,
  detailTab,
  onChangeDetailTab,
  activeScene,
  canvasRef,
  onContextInspect,
  slitRuns,
  slitDraft,
  onPatchSlitDraft,
  onResetSlitDraft,
  caseInputSummaries,
  verifications,
  onDownloadJson,
  onCancel,
  onRun
}) => {
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
  const activeMeta = getCaseMeta(selected);
  const activeSummary = caseInputSummaries[selected.id];
  const activeVerification = verifications[selected.id];

  const currentIdx = SHOWCASE_CASES.findIndex((c: any) => c.id === selected.id);
  const prevCase =
    SHOWCASE_CASES[(currentIdx - 1 + SHOWCASE_CASES.length) % SHOWCASE_CASES.length];
  const nextCase = SHOWCASE_CASES[(currentIdx + 1) % SHOWCASE_CASES.length];

  const groups = [...new Set(SHOWCASE_CASES.map((c: any) => c.group))] as string[];

  const detailTabOptions: SegmentedOption<DetailSideTab>[] = [
    { value: 'data', label: '数据与结果' },
    { value: 'about', label: '示例说明' }
  ];

  const renderResultContent = () => {
    const layout = result.layout;
    const s = result.slitting;
    const fulfilled = s?.fulfillment || layout?.fulfillment || [];
    const count = s
      ? s.patterns.reduce((n: number, pat: any) => n + pat.repetitions, 0)
      : layout.placements.length;
    const compareRows = s ? buildSlittingCompareRows(p, slitRuns) : [];

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
              {activeMeta.expectUnplaced && count === 0
                ? '符合预期阻断'
                : result.fulfillmentStatus === 'COMPLETE'
                ? '齐套'
                : '未齐套'}
            </strong>
          </div>
        </div>
        {(layout?.message || result.fulfillmentStatus !== 'COMPLETE') && (
          <div className="demo-note">
            {layout?.message || ''}
            {result.fulfillmentStatus !== 'COMPLETE'
              ? activeMeta.expectUnplaced
                ? ' 尺寸超限且禁止旋转，引擎按预期阻断排入。'
                : ' 请核对缺口；不能作为齐套完成。'
              : ''}
          </div>
        )}
        <div className="mp-table-scroll">
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
                      {p.parts?.find((pt: any) => pt.id === f.demandId)?.name ||
                        f.orderId ||
                        f.demandId}
                    </td>
                    <td className="num">
                      {f.placed ?? f.produced ?? 0} / {f.requested}
                    </td>
                    <td className="num">{f.missing ?? f.unplaced ?? 0}</td>
                  </tr>
                  {f.reason && Boolean(f.unplaced || f.missing) && (
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
        </div>

        {s && (
          <>
            <div className="sec">分切组合（单车示意）</div>
            {s.patterns.map((pat: any, i: number) => (
              <button
                key={pat.id || i}
                type="button"
                className={`btn demo-pattern ${patternIndex === i ? 'on' : ''}`}
                data-pattern={i}
                onClick={() => onChangePatternIndex(i)}
              >
                {i + 1}.{' '}
                {pat.stations
                  .map((v: any) => `${v.widthMm}×${v.countPerRepetition}`)
                  .join(' + ')}{' '}
                · {pat.repetitions} 车
              </button>
            ))}
            <div id="demo-compare">
              <div className="sec">同一输入对比</div>
              <div className="mp-table-scroll">
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
  };

  return (
    <div className="react-page page-host mp-showcase-detail-page mp-detail-v3">
      {/* Minimalist Top Bar with Back Button + Case Dropdown Switcher + Spec Chips */}
      <div className="mp-sc-topbar mp-detail-topbar">
        <a className="mp-ghost-btn" href="#/showcase" title="返回算例与场景总览">
          ← 返回总览
        </a>

        <div className="mp-case-switcher">
          <select
            id="demo-case-select"
            className="field mp-case-select"
            aria-label="切换算例"
            value={selected.id}
            onChange={(e) => {
              location.hash = '#/showcase/' + encodeURIComponent(e.target.value);
            }}
          >
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {SHOWCASE_CASES.filter((c: any) => c.group === g).map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.id})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <a
            className="mp-step-btn"
            href={`#/showcase/${encodeURIComponent(prevCase.id)}`}
            title={`上一算例：${prevCase.name}`}
            aria-label="上一算例"
          >
            ‹
          </a>
          <a
            className="mp-step-btn"
            href={`#/showcase/${encodeURIComponent(nextCase.id)}`}
            title={`下一算例：${nextCase.name}`}
            aria-label="下一算例"
          >
            ›
          </a>
        </div>

        <h1 className="mp-detail-h1">{selected.name}</h1>
        <CodeBadge>{selected.id}</CodeBadge>
        <span className="tag kind">{activeSummary?.engineBadge}</span>
        <span className="mp-cc3-feature">{activeMeta.featureTag}</span>
        <span className="mp-sc-sub num">
          {selected.group} · {activeSummary?.specText} · {activeSummary?.pieceSummary}
        </span>

        <span className="sp" />

        {activeVerification ? (
          <span
            className={`tag ${activeVerification.pass ? 'ok' : 'warn'} num`}
            title={activeVerification.detailText}
          >
            {activeVerification.badgeText} · {activeVerification.elapsedMs} ms
          </span>
        ) : (
          <span className="tag">计算预览 · 不扣库存</span>
        )}
      </div>

      {/* Main 2-Pane Split: Left 74% Full-Height Dark CAD Canvas + Right 26% Tabbed Inspector */}
      <div className="mp-detail-split">
        <section className="pane mp-cad-card mp-demo-canvas-card">
          <div className="mp-cad-head">
            <span className="mp-cad-title">
              {slit ? '定长横切示意' : '排料图'}
            </span>
            <span className="mp-cad-sub">{selected.note}</span>
            <span className="sp" />
            <button
              type="button"
              className="mp-cad-btn"
              id="demo-fit"
              onClick={() => canvasRef.current?.fit()}
            >
              适合窗口
            </button>
            <button
              type="button"
              className="mp-cad-btn"
              id="demo-rotate"
              onClick={onToggleVertical}
            >
              横 / 竖
            </button>
            <button
              type="button"
              className="mp-cad-btn"
              id="demo-path"
              aria-pressed={showPath}
              disabled={slit || p.process?.mode === 'CONTOUR'}
              title={
                slit || p.process?.mode === 'CONTOUR'
                  ? '此演示没有可执行刀序'
                  : undefined
              }
              onClick={onToggleShowPath}
            >
              刀序
            </button>
          </div>
          <div id="demo-canvas" className="demo-canvas" aria-label="演示排料画布">
            <CadCanvasView
              scene={activeScene}
              vertical={vertical}
              showPath={showPath}
              showDimensions={true}
              minHeight={360}
              ariaLabel="演示排料画布"
              onContextInspect={onContextInspect}
              canvasRefOut={canvasRef}
            />
          </div>
          <div className="mp-cad-foot" id="demo-selection">
            {selectionText}
          </div>
        </section>

        <aside className="pane mp-float-card mp-detail-side">
          <div className="mp-detail-side-head">
            <SegmentedControl
              options={detailTabOptions}
              value={detailTab}
              onChange={onChangeDetailTab}
              ariaLabel="切换数据结果与示例说明"
              size="sm"
              fullWidth
            />
          </div>

          <div className="mp-detail-side-body" hidden={detailTab !== 'data'}>
            <div className="mp-side-section" id="demo-result">
              <div className="sec">计算结果</div>
              {busy ? (
                <div className="empty">计算中…</div>
              ) : errorText ? (
                <div className="error-box" role="alert">
                  {errorText}
                </div>
              ) : cancelledHint ? (
                <div className="empty">本次计算已停止，可重新计算。</div>
              ) : !result ? (
                <div className="mp-unrun-compact">
                  尚未计算 · 点击右下角「{slit ? '快速搭切' : '开始计算'}」生成排料图
                </div>
              ) : (
                renderResultContent()
              )}
            </div>

            {slit && slitDraft && (
              <ShowcaseSlitConfigCard
                slitDraft={slitDraft}
                onPatch={onPatchSlitDraft}
                onReset={onResetSlitDraft}
              />
            )}

            <div className="mp-side-section" id="demo-input">
              <div className="sec">输入规格与需求 ({inputRows.length})</div>
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
              <div className="mp-table-scroll">
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
              </div>
            </div>
          </div>

          <div
            className="mp-detail-side-body mp-about-tab-body"
            hidden={detailTab !== 'about'}
          >
            <div className="mp-about-block">
              <span className="mp-about-label">适用场景</span>
              <p>{activeMeta.scenario}</p>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">算法与约束模型</span>
              <strong>{activeMeta.algorithm}</strong>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">为什么做这个算例（设计目的）</span>
              <p>{activeMeta.why}</p>
            </div>
            <div className="mp-about-block">
              <span className="mp-about-label">快速检验标准</span>
              <p>{activeMeta.verifyRule}</p>
              {activeVerification && (
                <div
                  className={`mp-about-verdict num ${
                    activeVerification.pass ? 'ok' : 'warn'
                  }`}
                >
                  {activeVerification.detailText}
                </div>
              )}
            </div>
            {(selected.kind === 'marker' || selected.id.startsWith('GARMENT')) && (
              <div className="mp-about-block">
                <span className="mp-about-label">工艺边界说明</span>
                <p>服装曲边为折线近似，未包含对条对格、缝份及任意角度旋转。</p>
              </div>
            )}
            <details className="mp-about-json">
              <summary>查看输入请求 JSON</summary>
              <pre>{JSON.stringify(request, null, 2)}</pre>
            </details>
          </div>
        </aside>
      </div>

      <div className="foot mp-action-foot">
        <span id="demo-state" role="status" className="mp-status-text">
          {stateText}
        </span>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          id="demo-input-export"
          onClick={() => onDownloadJson('input', request)}
        >
          导出输入
        </button>
        <button
          type="button"
          className="btn"
          id="demo-result-export"
          disabled={!result}
          onClick={() => onDownloadJson('result', result)}
        >
          导出结果
        </button>
        <button
          type="button"
          className="btn"
          id="demo-cancel"
          hidden={!busy}
          onClick={onCancel}
        >
          停止计算
        </button>
        <button
          type="button"
          className="btn pri"
          id="demo-run"
          disabled={busy}
          onClick={() => onRun('FAST')}
        >
          {slit ? '快速搭切' : '开始计算'}
        </button>
        {slit && (
          <button
            type="button"
            className="btn"
            id="demo-quality"
            disabled={busy}
            onClick={() => onRun('QUALITY')}
          >
            精细优化
          </button>
        )}
      </div>
    </div>
  );
};
