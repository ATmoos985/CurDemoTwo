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

const PRIORITY_META: Record<string, { text: string; cls: string; weight: number }> = {
  URGENT: { text: '加急', cls: 'err', weight: 3 },
  HIGH: { text: '高优', cls: 'warn', weight: 2 },
  NORMAL: { text: '普通', cls: '', weight: 1 }
};

type ExtendedDemandFamily = DemandFamilySummary & {
  dueDate?: string;
  priority?: 'NORMAL' | 'HIGH' | 'URGENT' | string;
  customerName?: string;
  kittingGroup?: string;
  requiredBatchNo?: string;
  requiredColor?: string;
  strictBatchMatch?: boolean;
  machineId?: string;
  shiftTeam?: string;
};

type SortMode = 'DEFAULT' | 'PRIORITY_DESC' | 'DUE_ASC';

function priorityWeight(priority?: string): number {
  return PRIORITY_META[String(priority || 'NORMAL').toUpperCase()]?.weight ?? 1;
}

function dueDateUrgency(dueDate?: string): { label: string; tone: 'err' | 'warn' | 'normal' } | null {
  if (!dueDate) return null;
  const parsed = Date.parse(dueDate.length === 10 ? `${dueDate}T23:59:59` : dueDate);
  if (Number.isNaN(parsed)) return { label: dueDate, tone: 'normal' };
  const diffDays = Math.ceil((parsed - Date.now()) / 86400000);
  if (diffDays < 0) return { label: `交期 ${dueDate} (已超期)`, tone: 'err' };
  if (diffDays <= 3) return { label: `交期 ${dueDate} (${diffDays === 0 ? '今日' : `${diffDays}天内`})`, tone: 'warn' };
  return { label: `交期 ${dueDate}`, tone: 'normal' };
}

export const DemandLibraryPage: React.FC = () => {
  const { loadDemandFamilyIntoWorkbench, loadDemandFamiliesMergedIntoWorkbench } = useStudioStore();

  const [families, setFamilies] = useState<ExtendedDemandFamily[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dimFilter, setDimFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<string>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('DEFAULT');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadPool = async () => {
    setLoading(true);
    setError(null);
    try {
      const poolData = await requestJSON('/api/v2/demand-pool');
      const list: ExtendedDemandFamily[] = Array.isArray(poolData) ? poolData : [];
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

  const urgentFamilyCount = useMemo(
    () =>
      families.filter(
        (f) =>
          f.openTotal > 0 &&
          (String(f.priority || '').toUpperCase() === 'URGENT' ||
            String(f.priority || '').toUpperCase() === 'HIGH')
      ).length,
    [families]
  );

  const filteredFamilies = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = families.filter((f) => {
      if (dimFilter !== 'ALL' && f.dimension !== dimFilter) return false;
      if (statusFilter === 'OPEN_ONLY' && f.openTotal <= 0) return false;
      if (
        ['OPEN', 'PARTIAL_PLANNED', 'FULLY_PLANNED', 'COMPLETED'].includes(statusFilter) &&
        f.status !== statusFilter
      ) {
        return false;
      }
      if (priorityFilter !== 'ALL') {
        const p = String(f.priority || 'NORMAL').toUpperCase();
        if (p !== priorityFilter) return false;
      }
      if (!q) return true;
      return `${f.name} ${f.materialModel} ${f.externalRef || ''} ${f.id} ${f.customerName || ''} ${f.kittingGroup || ''} ${f.requiredBatchNo || ''} ${f.requiredColor || ''} ${f.machineId || ''} ${f.shiftTeam || ''} ${f.dueDate || ''}`
        .toLowerCase()
        .includes(q);
    });

    if (sortMode === 'PRIORITY_DESC') {
      return [...list].sort((a, b) => {
        const diff = priorityWeight(b.priority) - priorityWeight(a.priority);
        if (diff !== 0) return diff;
        const da = a.dueDate || '9999-12-31';
        const db = b.dueDate || '9999-12-31';
        return da.localeCompare(db);
      });
    }
    if (sortMode === 'DUE_ASC') {
      return [...list].sort((a, b) => {
        const da = a.dueDate || '9999-12-31';
        const db = b.dueDate || '9999-12-31';
        const cmp = da.localeCompare(db);
        if (cmp !== 0) return cmp;
        return priorityWeight(b.priority) - priorityWeight(a.priority);
      });
    }
    return list;
  }, [families, dimFilter, statusFilter, priorityFilter, sortMode, search]);

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
              {urgentFamilyCount > 0 ? ` · ${urgentFamilyCount} 项加急/高优` : ''}
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
                placeholder="筛选需求族、品号、客户、缸号或工单号"
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

            <select
              className="dl-select"
              aria-label="按优先级筛选"
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
            >
              <option value="ALL">全部优先级</option>
              <option value="URGENT">加急 (URGENT)</option>
              <option value="HIGH">高优 (HIGH)</option>
              <option value="NORMAL">普通 (NORMAL)</option>
            </select>

            <select
              className="dl-select"
              aria-label="排序方式"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="DEFAULT">默认排序</option>
              <option value="PRIORITY_DESC">优先级高 → 低</option>
              <option value="DUE_ASC">交期最近优先</option>
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
                    const priKey = String(fam.priority || 'NORMAL').toUpperCase();
                    const priMeta = PRIORITY_META[priKey] || PRIORITY_META.NORMAL;
                    const dueMeta = dueDateUrgency(fam.dueDate);
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
                          style={
                            priKey === 'URGENT'
                              ? { boxShadow: 'inset 3px 0 0 #dc2626' }
                              : priKey === 'HIGH'
                              ? { boxShadow: 'inset 3px 0 0 #d97706' }
                              : undefined
                          }
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
                            <div className="mp-fam-title-row" style={{ flexWrap: 'wrap', gap: 4 }}>
                              {priKey !== 'NORMAL' && (
                                <span className={`tag ${priMeta.cls}`}>{priMeta.text}</span>
                              )}
                              <strong>{fam.name}</strong>
                              <CodeBadge>{shortId(fam.id)}</CodeBadge>
                              {dueMeta && (
                                <span
                                  className={`tag num ${
                                    dueMeta.tone === 'err'
                                      ? 'err'
                                      : dueMeta.tone === 'warn'
                                      ? 'warn'
                                      : ''
                                  }`}
                                >
                                  {dueMeta.label}
                                </span>
                              )}
                            </div>
                            <div
                              className="mp-fam-sub num"
                              style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
                            >
                              <span>{fam.externalRef || '内部自建'}</span>
                              {fam.customerName && <span>· 客户:{fam.customerName}</span>}
                              {fam.kittingGroup && <span>· 齐套:{fam.kittingGroup}</span>}
                              {(fam.machineId || fam.shiftTeam) && (
                                <span>
                                  · {[fam.machineId, fam.shiftTeam].filter(Boolean).join('/')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className={`tag ${dimMeta.cls}`}>{dimMeta.text}</span>
                          </td>
                          <td className="num" style={{ color: 'var(--cp-ink-2)' }}>
                            <div>{fam.materialModel}</div>
                            {(fam.requiredBatchNo || fam.requiredColor || fam.strictBatchMatch) && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                                {fam.requiredBatchNo && (
                                  <CodeBadge title="指定缸号">缸:{fam.requiredBatchNo}</CodeBadge>
                                )}
                                {fam.requiredColor && (
                                  <span className="tag" style={{ fontSize: 10.5 }}>
                                    {fam.requiredColor}
                                  </span>
                                )}
                                {fam.strictBatchMatch && (
                                  <span className="tag warn" style={{ fontSize: 10.5 }}>
                                    同缸强约束
                                  </span>
                                )}
                              </div>
                            )}
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
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                    {(fam.dueDate ||
                                      fam.customerName ||
                                      fam.kittingGroup ||
                                      fam.requiredBatchNo ||
                                      fam.strictBatchMatch) && (
                                      <span className="muted num" style={{ fontSize: 11.5 }}>
                                        {[
                                          fam.priority && `优先级:${priMeta.text}`,
                                          fam.dueDate && `交期:${fam.dueDate}`,
                                          fam.customerName && `客户:${fam.customerName}`,
                                          fam.kittingGroup && `齐套组:${fam.kittingGroup}`,
                                          fam.requiredBatchNo && `指定缸号:${fam.requiredBatchNo}`,
                                          fam.requiredColor && `指定色号:${fam.requiredColor}`,
                                          fam.strictBatchMatch && '同单同缸强约束',
                                          (fam.machineId || fam.shiftTeam) &&
                                            `机台/班组:${[fam.machineId, fam.shiftTeam].filter(Boolean).join('/')}`
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      </span>
                                    )}
                                    <a
                                      className="btn sm"
                                      href={`#/demands?append=${encodeURIComponent(fam.id)}`}
                                    >
                                      ＋ 向此需求族追加规格
                                    </a>
                                  </div>
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
