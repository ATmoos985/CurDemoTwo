import { useEffect, useState } from 'react';
import type { ShapeGeometry } from '../../store/useStudioStore';
import { requestJSON } from '../../lib/core/api-request.js';
import { shapeVertices } from '../../lib/canvas/nesting-scene.js';
import { archivedDrawing, archivedExclusions, ArchivedDrawing, ComparisonSide, lengthText } from './comparisonView';

function shapePath(shape: ShapeGeometry) {
  return [shapeVertices(shape), ...(shape.holes || [])]
    .filter(points => points?.length >= 3)
    .map(points => 'M' + points.map(p => `${p.x} ${p.y}`).join('L') + 'Z')
    .join(' ');
}

export function ArchivedComparisonDrawing({ taskId, side, label, onBack }: {
  taskId: string; side: ComparisonSide; label: string; onBack: () => void;
}) {
  const [drawing, setDrawing] = useState<(ArchivedDrawing & { exclusions: ReturnType<typeof archivedExclusions> }) | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [wholeRegion, setWholeRegion] = useState(false);
  const [showCuts, setShowCuts] = useState(true);
  useEffect(() => {
    let live = true;
    setError('');
    setDrawing(null);
    const base = '/api/v2/workbench/tasks/' + encodeURIComponent(taskId) + '/results/';
    const id = encodeURIComponent(side.resultId);
    Promise.all([requestJSON(base + id), requestJSON('/api/v2/optimization-jobs/' + id + '/input')])
      .then(([archive, input]) => ({ ...archivedDrawing(archive, side), exclusions: archivedExclusions(input) }))
      .then(model => { if (live) setDrawing(model); })
      .catch(err => {
        if (!live) return;
        setError(err.httpStatus === 404
          ? '归档已过期或当前账号无权查看这份原图。'
          : err.message || '未取得这份原图，请重试。');
      });
    return () => { live = false; };
  }, [taskId, side, attempt]);

  const shape = drawing?.region;
  const occupied = drawing?.pieces.reduce((n, p) => Math.max(n, p.y + p.shape.height), 0);
  const height = shape && !wholeRegion && occupied > 0 ? Math.min(shape.height, occupied) : shape?.height;
  return <section className="comparison-drawing" aria-label={label + '归档原图'}>
    <div className="comparison-drawing-head">
      <button type="button" className="btn sm" autoFocus onClick={onBack}>← 返回对比表</button>
      <h3>{label} · 归档原图</h3>
    </div>
    <p className="comparison-ref">归档结果 <code>{side.resultId}</code></p>
    {error ? <div role="alert" className="comparison-feedback">
      <span>{error}</span><button type="button" className="btn sm" onClick={() => setAttempt(a => a + 1)}>重试原图</button>
    </div> : !drawing ? <p role="status">正在读取归档原图…</p> : <>
      <div className="comparison-drawing-tools">
        <span>幅宽 <b>{lengthText(shape.width)}</b> · 显示长度 <b>{lengthText(height)}</b></span>
        <label><input type="checkbox" checked={wholeRegion} onChange={e => setWholeRegion(e.target.checked)} />完整加工区</label>
        {drawing.cuts.length > 0 && <label><input type="checkbox" checked={showCuts} onChange={e => setShowCuts(e.target.checked)} />刀线</label>}
      </div>
      <svg className="comparison-plan" role="img" aria-label={label + '原始裁片排布'} viewBox={`0 0 ${shape.width} ${height}`}>
        <title>{label}归档排布，{drawing.pieces.length} 片</title>
        <path className="comparison-material" d={shapePath(shape)} fillRule="evenodd" />
        {drawing.exclusions.map(zone => <path key={zone.id} className="comparison-exclusion"
          fillRule="evenodd" d={shapePath(zone.shape)} transform={`translate(${zone.x} ${zone.y})`}>
          <title>归档避让区 {zone.id}</title>
        </path>)}
        {drawing.pieces.map((p, index) =>
          <path key={index} className={'comparison-piece' + (p.spare ? ' is-spare' : '')}
            fillRule="evenodd" d={shapePath(p.shape)} transform={`translate(${p.x} ${p.y})`}>
            <title>{p.name} · 需求 {p.demandId} · X {lengthText(p.x)} / Y {lengthText(p.y)}{p.spare ? ' · 补空片' : ''}</title>
          </path>
        )}
        {showCuts && drawing.cuts.map((cut, i) => <line key={i} className="comparison-cut"
          x1={cut.startX} y1={cut.startY} x2={cut.endX} y2={cut.endY}><title>第 {cut.sequence} 刀</title></line>)}
      </svg>
      <div className="comparison-legend"><span>需求裁片</span>
        {drawing.exclusions.length > 0 && <span className="is-exclusion">疵点 / 工艺避让区</span>}
        {drawing.pieces.some(p => p.spare) && <span className="is-spare">补空备用片</span>}
        {drawing.cuts.length > 0 && showCuts && <span className="is-cut">刀线</span>}
      </div>
      {!drawing.pieces.length && <p>这份归档没有排入裁片，图中显示空的加工区。</p>}
    </>}
  </section>;
}
