import { useEffect, useRef, useState } from 'react';
import { ModalDialog } from '../../components/ModalDialog';
import { requestJSON } from '../../lib/core/api-request.js';
import { ArchivedComparisonDrawing } from './ArchivedComparisonDrawing';
import { ComparisonQuestions } from './ComparisonQuestions';
import {
  CandidateComparisonReport, ComparisonChoice, ComparisonMetric, ComparisonSide, differenceText, lengthText, lengthVerdict,
  metricBasis, metricLabels, numberText, selectionIssue
} from './comparisonView';
import './candidateComparison.css';

function DemandBalance({ side }: { side: ComparisonSide }) {
  const missing = side.demands.filter(d => d.unplaced > 0);
  return <>
    <strong className={side.fulfillmentStatus === 'COMPLETE' ? 'comparison-ok' : 'comparison-warn'}>
      {side.fulfillmentStatus === 'COMPLETE' ? '已齐套' : side.fulfillmentStatus === 'NONE' ? '尚未排入' : '未齐套'}
    </strong>
    <div>应排 {side.requested} 件 · 已排 {side.placed} 件 · 缺 {side.unplaced} 件</div>
    {missing.length > 0 && <ul className="comparison-shortages">{missing.map(d =>
      <li key={d.demandId}>{d.name || '需求 ' + d.demandId} <b>缺 {d.unplaced} 件</b></li>
    )}</ul>}
    {side.demands.length > 0 && <details className="comparison-formula"><summary>逐规格核对</summary>
      <ul className="comparison-shortages">{side.demands.map(d =>
        <li key={d.demandId}>{d.name || '需求 ' + d.demandId} · 应排 {d.requested} · 已排 {d.placed} · 缺 {d.unplaced} 件</li>
      )}</ul>
    </details>}
  </>;
}

function MaterialWindow({ side }: { side: ComparisonSide }) {
  const w = side.materialWindow;
  if (!w) return <>未记录用料窗口</>;
  const typeLabel = ({ ROLL: '母卷', STOCK_ROLL: '母卷', REMNANT: '料头', FREE_CANVAS: '自由画布', VIRTUAL: '虚拟材料' })[w.type] || '材料';
  return <>{typeLabel}{w.id ? ' · ' + w.id : ''}<small>门幅 {lengthText(w.widthMm)} · 起点 {lengthText(w.windowStartMm)} · 窗长 {lengthText(w.windowLengthMm)}</small></>;
}

function MetricCell({ metric }: { metric: ComparisonMetric | null }) {
  if (!metric) return <>无此指标</>;
  const areaMetric = Object.hasOwn(metricLabels, metric.name);
  return <><b className="num">{numberText(metric.value)} {metric.unit}</b>
    <details className="comparison-formula"><summary>计算口径</summary>
      <span>{metricBasis(metric.basis)}</span>
      <span>分子 {numberText(metric.numerator)}{areaMetric ? ' mm²' : ''} · 分母 {numberText(metric.denominator)}{areaMetric ? ' mm²' : ''} · 版本 {metric.version}</span>
    </details></>;
}

function ComparisonTable({ report, leftLabel, rightLabel, onDrawing }: {
  report: CandidateComparisonReport; leftLabel: string; rightLabel: string; onDrawing: (s: 'left' | 'right') => void;
}) {
  const { left, right, constraintDifferences, lengthComparison } = report;
  return <div className="comparison-content">
    <section className={'comparison-verdict ' + (lengthComparison.status === 'COMPARABLE' ? 'is-comparable' : '')}
      aria-label="用料比较结论">
      <h3>{lengthVerdict(report)}</h3>
      {constraintDifferences.length > 0 && <p>差异项：{constraintDifferences.map(differenceText).join('、')}</p>}
      <p>{lengthComparison.reason}</p>
    </section>
    <div className="comparison-scroll"><table className="comparison-table">
      <caption className="sr-only">候选排料方案逐项对比</caption>
      <thead><tr><th scope="col">比较项</th><th scope="col">A · {leftLabel}</th><th scope="col">B · {rightLabel}</th></tr></thead>
      <tbody>
        <tr><th scope="row">需求履约</th><td><DemandBalance side={left} /></td><td><DemandBalance side={right} /></td></tr>
        <tr><th scope="row">预计占用版长</th><td>{lengthText(left.occupiedLengthMm)}
          <details className="comparison-formula"><summary>长度口径</summary>{left.lengthBasis || lengthComparison.basis}</details></td>
          <td>{lengthText(right.occupiedLengthMm)}
            <details className="comparison-formula"><summary>长度口径</summary>{right.lengthBasis || lengthComparison.basis}</details></td></tr>
        <tr><th scope="row">投入材料 / 工位</th><td><MaterialWindow side={left} /></td><td><MaterialWindow side={right} /></td></tr>
        {report.metricDeltas.map(row => <tr key={row.name}>
          <th scope="row">{metricLabels[row.name] || row.name}
            <small>{row.status !== 'COMPARABLE' ? '两侧指标不能直接相减' :
              (Number.isFinite(row.delta) ? `B − A：${row.delta > 0 ? '+' : ''}${numberText(row.delta)} ${row.left?.unit === '%' ? '个百分点' : (row.left?.unit || '')}` : '')}</small>
          </th>
          <td><MetricCell metric={row.left} /></td><td><MetricCell metric={row.right} /></td>
        </tr>)}
        <tr><th scope="row">归档排料图</th>
          <td><button type="button" className="btn sm" onClick={() => onDrawing('left')}>查看 A 原图</button><small className="comparison-ref">{left.resultId}</small></td>
          <td><button type="button" className="btn sm" onClick={() => onDrawing('right')}>查看 B 原图</button><small className="comparison-ref">{right.resultId}</small></td>
        </tr>
      </tbody>
    </table></div>
  </div>;
}

type Pair = { taskId: string; leftId: string; rightId: string };

function ComparisonResults({ pair, leftLabel, rightLabel }: { pair: Pair; leftLabel: string; rightLabel: string }) {
  const [report, setReport] = useState<CandidateComparisonReport | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [drawing, setDrawing] = useState<'left' | 'right' | null>(null);
  const lastDrawingButton = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let live = true;
    setError('');
    setReport(null);
    const params = new URLSearchParams({ leftId: pair.leftId, rightId: pair.rightId });
    requestJSON('/api/v2/workbench/tasks/' + encodeURIComponent(pair.taskId) + '/result-comparison?' + params)
      .then((data: CandidateComparisonReport) => {
        if (!live) return;
        if (data.taskId !== pair.taskId || data.left?.resultId !== pair.leftId || data.right?.resultId !== pair.rightId) {
          throw new Error('归档结果与当前选择不一致，请重新比较。');
        }
        setReport(data);
      }).catch(err => {
        if (live) setError(err.httpStatus === 404 ? '找不到可访问的归档结果。请检查工单是否正确，或重新生成候选。' :
          err.message || '对比数据暂时无法读取。');
      });
    return () => { live = false; };
  }, [pair, attempt]);
  if (error) return <div className="comparison-feedback" role="alert">{error}
    <button type="button" className="btn sm" onClick={() => setAttempt(a => a + 1)}>重新读取</button></div>;
  if (!report) return <p role="status">正在核对两份归档结果…</p>;
  return <>
    <div hidden={!!drawing}>
      <ComparisonTable report={report} leftLabel={leftLabel} rightLabel={rightLabel} onDrawing={side => {
        lastDrawingButton.current = document.activeElement as HTMLElement;
        setDrawing(side);
      }} />
      <ComparisonQuestions key={pair.leftId + '|' + pair.rightId} taskId={pair.taskId} leftId={pair.leftId} rightId={pair.rightId} />
    </div>
    {drawing && <ArchivedComparisonDrawing taskId={pair.taskId} side={report[drawing]}
      label={drawing === 'left' ? '方案 A · ' + leftLabel : '方案 B · ' + rightLabel}
      onBack={() => { setDrawing(null); requestAnimationFrame(() => lastDrawingButton.current?.focus()); }} />}
  </>;
}

function ComparisonChooser({ schemes, activeId, taskId }: { schemes: ComparisonChoice[]; activeId?: string; taskId?: string }) {
  const eligible = schemes.filter(s => !selectionIssue(s, taskId));
  const first = eligible.find(s => s.id === activeId) || eligible[0];
  const second = eligible.find(s => s.comparisonSource?.taskId === first?.comparisonSource?.taskId &&
    s.comparisonSource?.resultId !== first?.comparisonSource?.resultId);
  const [left, setLeft] = useState(first?.id || '');
  const [right, setRight] = useState(second?.id || '');
  const [submitted, setSubmitted] = useState<Pair | null>(null);
  const leftScheme = eligible.find(s => s.id === left);
  const rightScheme = eligible.find(s => s.id === right);
  const a = leftScheme?.comparisonSource, b = rightScheme?.comparisonSource;
  const canCompare = !!a && !!b && a.taskId === b.taskId && a.resultId !== b.resultId;
  const current = canCompare && submitted?.taskId === a.taskId && submitted.leftId === a.resultId && submitted.rightId === b.resultId;
  function selector(label: string, value: string, onChange: (v: string) => void, other?: string) {
    return <label className="comparison-select">{label}
      <select aria-label={label} value={value} onChange={e => { onChange(e.target.value); setSubmitted(null); }}>
        <option value="">请选择候选方案</option>
        {schemes.map(s => {
          const issue = selectionIssue(s, taskId);
          return <option key={s.id} value={s.id} disabled={!!issue || s.id === other}>
            {s.strategyName}{s.widthMm ? ' · ' + lengthText(s.widthMm) + ' 门幅' : ''}{s.createdAt ? ' · ' + s.createdAt : ''}{s.empty ? ' · 未排入裁片' : ''}{s.comparisonSource?.taskId.startsWith('scratch:') ? ' · 草稿试算' : ''}{issue ? ' · ' + issue : ''}
          </option>;
        })}
      </select>
    </label>;
  }
  return <div className="candidate-comparison">
    <div className="comparison-selectors">
      {selector('方案 A', left, setLeft, right)}
      {selector('方案 B', right, setRight, left)}
      <button type="button" className="btn pri" disabled={!canCompare || current} onClick={() =>
        setSubmitted({ taskId: a.taskId, leftId: a.resultId, rightId: b.resultId })}>比较这两套</button>
    </div>
    {!canCompare && <div role="status" className="comparison-feedback">
      {a && b && a.taskId !== b.taskId ? '请选择来自同一工单或同一草稿的两套候选。' :
        a && b && a.resultId === b.resultId ? '两个候选引用同一张归档图，请选择另一套。' :
        '请选择两套有原始归档的二维候选。可在同一工单或草稿中启用两种策略并求解。'}
    </div>}
    {schemes.some(s => selectionIssue(s, taskId)) && <details className="comparison-excluded">
      <summary>为什么有候选无法选择？</summary>
      <ul>{schemes.filter(s => selectionIssue(s, taskId)).map(s =>
        <li key={s.id}>{s.strategyName} · {selectionIssue(s, taskId)}</li>)}</ul>
    </details>}
    {current && <ComparisonResults key={JSON.stringify(submitted)} pair={submitted} leftLabel={leftScheme.strategyName} rightLabel={rightScheme.strategyName} />}
  </div>;
}

export function CandidateComparison({ schemes, activeId, taskId }: { schemes: ComparisonChoice[]; activeId?: string; taskId?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="btn sm comparison-entry" aria-haspopup="dialog" onClick={() => setOpen(true)}>比较方案</button>
    <ModalDialog open={open} title="比较候选方案" maxWidth={940} onClose={() => setOpen(false)}>
      {open && <ComparisonChooser key={taskId} schemes={schemes} activeId={activeId} taskId={taskId} />}
    </ModalDialog>
  </>;
}
