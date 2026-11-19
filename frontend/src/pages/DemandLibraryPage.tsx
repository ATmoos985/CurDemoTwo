import React, { useEffect, useMemo, useState } from 'react';
import { useStudioStore, DemandFamilySummary } from '../store/useStudioStore';
import { CodeBadge } from '../components/ui/MagpiePrimitives';
import { requestJSON, toast, fmtN, shortId } from '@static/app/js/util.js';
import '../styles/theme-demand-library.css';

const DIM_LABELS: Record<string, { text: string; cls: string; unit: string }> = {
  CONTOUR_2D: { text: '二维异形', cls: 'run', unit: '片' },
  RECT_2D: { text: '二维矩形', cls: 'ok', unit: '件' },
  SLITTING_1D: { text: '一维分条', cls: 'kind', unit: '卷' }
};

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  OPEN: { text: '待排程', cls: 'idle' },
  PARTIAL_PLANNED: { text: '部分已排', cls: 'run' },
  FULLY_PLANNED: { text: '已排待切', cls: 'warn' },
  COMPLETED: { text: '已齐套完结', cls: 'ok' }
};

export const DemandLibraryPage: React.FC = () => {
  const { loadDemandFamilyIntoWorkbench, loadDemandFamiliesMergedIntoWorkbench } = useStudioStore();

  const [families, setFamilies] = useState<DemandFamilySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dimFilter, setDimFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadPool = async () => {
    setLoading(true);
    setError(null);
    try {
      const poolData = await requestJSON('/api/v2/demand-pool');
      const list = Array.isArray(poolData) ? poolData : [];
      setFamilies(list);
      if (!expandedId && list.length > 0) {
        setExpandedId(list[0].id);
      }
    } catch (err: any) {
      setError(err.message || '读取需求库失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPool();
  }, []);

  const openFamilyCount = useMemo(
    () => families.filter((f) => f.openTotal > 0).length,
    [families]
  );

  const filteredFamilies = useMemo(() => {
    const q = search.trim().toLowerCase();
    return families.filter((f) => {
      if (dimFilter !== 'ALL' && f.dimension !== dimFilter) return false;
      if (statusFilter === 'OPEN_ONLY' && f.openTotal <= 0) return false;
      if (
        ['OPEN', 'PARTIAL_PLANNED', 'FULLY_PLANNED', 'COMPLETED'].includes(statusFilter) &&
        f.status !== statusFilter
      ) {
        return false;
      }
      if (!q) return true;
      return `${f.name} ${f.materialModel} ${f.externalRef || ''} ${f.id}`
        .toLowerCase()
        .includes(q);
    });
  }, [families, dimFilter, statusFilter, search]);

  const checkedFamilies = useMemo(
    () => families.filter((f) => selectedIds.includes(f.id)),
    [families, selectedIds]
  );

  const toggleSelectFamily = (fam: DemandFamilySummary) => {
    setSelectedIds((prev) => {
      if (prev.includes(fam.id)) return prev.filter((id) => id !== fam.id);
      if (prev.length > 0) {
        const first = families.find((x) => x.id === prev[0]);
        if (first) {
          const is1DFirst = first.dimension === 'SLITTING_1D';
          const is1DCur = fam.dimension === 'SLITTING_1D';
          if (is1DFirst !== is1DCur) {
            toast('一维定长分条与二维排料需求维度不同，不能勾选混排', true);
            return prev;
          }
        }
      }
      return [...prev, fam.id];
    });
  };

  return (
    <div className="react-page">
      <div className="dl-page">
        <div className="dl-head">
          <div className="dl-title-block">
            <h1>需求库</h1>
            <span className="dl-summary num">
              {families.length} 个需求族 · {openFamilyCount} 项待排
            </span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <a className="mp-ghost-btn" href="#/clusters">
              需求模板库
            </a>
            <button type="button" className="mp-ghost-btn" onClick={loadPool}>
              刷新列表
            </button>
            <a className="btn pri" href="#/demands">
              ＋ 新建需求
            </a>
          </div>
        </div>

        <div className="dl-card">
          <div className="dl-toolbar">
            <div className="mp-search-wrap">
              <span className="mp-search-ico" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="14" height="14">
                  <circle
                    cx="7.2"
                    cy="7.2"
                    r="4.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="m10.8 10.8 2.8 2.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <input
                type="search"
                className="mp-search-input"
                aria-label="搜索需求族"
                placeholder="筛选需求族、物料品号或工单号"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <select
              className="dl-select"
              aria-label="按维度筛选"
              value={dimFilter}
              onChange={(e) => setDimFilter(e.target.value)}
            >
              <option value="ALL">全部维度</option>
              <option value="RECT_2D">二维矩形</option>
              <option value="CONTOUR_2D">二维异形</option>
              <option value="SLITTING_1D">一维分条</option>
            </select>

            <select
              className="dl-select"
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="ALL">全部状态</option>
              <option value="OPEN_ONLY">有待排余量</option>
              <option value="OPEN">待排程</option>
              <option value="PARTIAL_PLANNED">部分已排</option>
              <option value="FULLY_PLANNED">已排待切</option>
              <option value="COMPLETED">已齐套完结</option>
            </select>

            <div className="dl-toolbar-right">
              <span className="mp-toolbar-count num">
                显示 {filteredFamilies.length} / {families.length}
              </span>
              {checkedFamilies.length > 0 && (
                <button
                  type="button"
                  className="btn sm soft-accent"
                  onClick={() => {
                    loadDemandFamiliesMergedIntoWorkbench(checkedFamilies);
                    location.hash = '#/workbench';
                  }}
                >
                  合并去搭切排程 ({checkedFamilies.length}) →
                </button>
              )}
            </div>
          </div>

          <div className="dl-table-scroll">
            {error ? (
              <div className="error-box" role="alert">
                <b>读取失败</b>
                <p>{error}</p>
              </div>
            ) : loading ? (
              <div className="loading">正在读取历史需求库…</div>
            ) : filteredFamilies.length === 0 ? (
              <div className="empty" style={{ padding: 48 }}>
                <div style={{ fontWeight: 600, color: 'var(--cp-ink)', marginBottom: 6 }}>
                  暂无匹配的需求记录
                </div>
                <p className="muted" style={{ margin: '0 auto 14px', maxWidth: 420 }}>
                  可调整上方维度/状态筛选条件，或点击右上角「＋ 新建需求」拖入文件快速创建。
                </p>
                <a className="btn pri" href="#/demands">
                  ＋ 前往新建需求
                </a>
              </div>
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th style={{ width: 34 }} />
                    <th>需求族 / 工单标识</th>
                    <th>维度</th>
                    <th>物料品号</th>
                    <th className="r">项</th>
                    <th>数量账本</th>
                    <th>状态</th>
                    <th className="r">方案</th>
                    <th style={{ textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFamilies.map((fam) => {
                    const dimMeta = DIM_LABELS[fam.dimension] || DIM_LABELS.RECT_2D;
                    const stMeta = STATUS_LABELS[fam.status] || STATUS_LABELS.OPEN;
                    const isExpanded = expandedId === fam.id;
                    const isChecked = selectedIds.includes(fam.id);
                    const donePct = fam.orderedTotal
                      ? (fam.completedTotal / fam.orderedTotal) * 100
                      : 0;
                    const planPct = fam.orderedTotal
                      ? (fam.plannedTotal / fam.orderedTotal) * 100
                      : 0;

                    return (
                      <React.Fragment key={fam.id}>
                        <tr
                          className={`click ${isExpanded ? 'sel' : ''}`}
                          onClick={() => setExpandedId(isExpanded ? null : fam.id)}
                        >
                          <td onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`勾选需求族 ${fam.name}`}
                              checked={isChecked}
                              onChange={() => toggleSelectFamily(fam)}
                            />
                          </td>
                          <td className="dl-col-name">
                            <div className="mp-fam-title-row">
                              <strong>{fam.name}</strong>
                              <CodeBadge>{shortId(fam.id)}</CodeBadge>
                            </div>
                            <div className="mp-fam-sub num">
                              {fam.externalRef || '内部自建'}
                            </div>
                          </td>
                          <td>
                            <span className={`tag ${dimMeta.cls}`}>{dimMeta.text}</span>
                          </td>
                          <td className="num" style={{ color: 'var(--cp-ink-2)' }}>
                            {fam.materialModel}
                          </td>
                          <td className="r num">{fam.lines.length}</td>
                          <td>
                            <div className="demand-ledger-cell num">
                              <div className="demand-ledger-nums">
                                <span>
                                  总 <b>{fam.orderedTotal}</b>
                                </span>
                                <span style={{ color: 'var(--cp-accent-ink)' }}>
                                  已排 <b>{fam.plannedTotal}</b>
                                </span>
                                <span style={{ color: '#059669' }}>
                                  实完 <b>{fam.completedTotal}</b>
                                </span>
                                <span
                                  style={{
                                    color: fam.openTotal > 0 ? '#b45309' : 'var(--cp-ink-3)',
                                    fontWeight: 600
                                  }}
                                >
                                  待排 {fam.openTotal} {dimMeta.unit}
                                </span>
                              </div>
                              <div className="demand-dual-bar" aria-hidden="true">
                                <i
                                  className="seg-done"
                                  style={{ width: `${Math.min(100, donePct)}%` }}
                                />
                                <i
                                  className="seg-plan"
                                  style={{ width: `${Math.min(100 - donePct, planPct)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className={`tag ${stMeta.cls}`}>{stMeta.text}</span>
                          </td>
                          <td className="r num">{fam.schemeCount}</td>
                          <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button
                                type="button"
                                className={`btn sm ${fam.openTotal > 0 ? 'soft-accent' : ''}`}
                                onClick={() => {
                                  loadDemandFamilyIntoWorkbench(fam);
                                  location.hash = '#/workbench';
                                }}
                              >
                                {fam.openTotal > 0 ? '去搭切排程 →' : '重新试算'}
                              </button>
                              {fam.schemeCount > 0 && (
                                <a
                                  className="btn sm"
                                  href={`#/results?taskId=${encodeURIComponent(fam.id)}`}
                                >
                                  查看方案
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={9} className="dl-expand-cell">
                              <div className="dl-expand-inner">
                                <div className="dl-expand-head">
                                  <strong style={{ fontSize: 12 }}>
                                    需求族规格明细（共 {fam.lines.length} 项）
                                  </strong>
                                  <a
                                    className="btn sm"
                                    href={`#/demands?append=${encodeURIComponent(fam.id)}`}
                                  >
                                    ＋ 向此需求族追加规格
                                  </a>
                                </div>
                                <table className="t">
                                  <thead>
                                    <tr>
                                      <th>行号</th>
                                      <th>规格 / 裁片名称</th>
                                      <th>几何形态</th>
                                      <th className="r">宽 × 长 mm</th>
                                      <th>方向规则</th>
                                      <th className="r">总需求</th>
                                      <th className="r">已排预占</th>
                                      <th className="r">实切合格</th>
                                      <th className="r">剩余待排</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {fam.lines.map((ln) => (
                                      <tr key={ln.id}>
                                        <td className="num">#{ln.id}</td>
                                        <td style={{ fontWeight: 600 }}>
                                          {ln.name}
                                          {ln.sizeLabel && (
                                            <span className="tag" style={{ marginLeft: 6 }}>
                                              {ln.sizeLabel}
                                            </span>
                                          )}
                                        </td>
                                        <td>
                                          {fam.dimension === 'SLITTING_1D'
                                            ? '一维定长卷条'
                                            : ln.shape?.type === 'POLYGON'
                                            ? `异形轮廓 (${ln.shape.vertices?.length || 0}顶点)`
                                            : '标准矩形'}
                                        </td>
                                        <td className="r num">
                                          {fmtN(ln.width, 1)} × {fmtN(ln.length, 1)}
                                        </td>
                                        <td>
                                          {fam.dimension === 'SLITTING_1D'
                                            ? '纵向开条'
                                            : ln.allowRotation
                                            ? '允许 90°'
                                            : ln.allowHalfTurn
                                            ? '允许 180° 倒顺'
                                            : '严格 0° 经向'}
                                        </td>
                                        <td className="r num">{ln.orderedQty}</td>
                                        <td
                                          className="r num"
                                          style={{ color: 'var(--cp-accent-ink)' }}
                                        >
                                          {ln.plannedQty}
                                        </td>
                                        <td className="r num" style={{ color: '#059669' }}>
                                          {ln.completedQty}
                                        </td>
                                        <td
                                          className="r num"
                                          style={{
                                            fontWeight: 600,
                                            color: ln.openQty > 0 ? '#b45309' : 'var(--cp-ink-3)'
                                          }}
                                        >
                                          {ln.openQty}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
