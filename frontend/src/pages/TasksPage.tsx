import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, shortId, toast } from '@static/app/js/util.js';
import { taskLabels, filterTasks } from '@static/js/business/cutting/task-list-model.js';
import { useStudioStore } from '../store/useStudioStore';

const STATUS_TAG_MAP: Record<string, string> = {
  PLAN_PENDING: 'idle',
  EXECUTION_PENDING: 'run',
  REPORT_PENDING: 'warn',
  ATTENTION: 'err',
  COMPLETED: 'ok'
};

const ACTION_LABEL_MAP: Record<string, string> = {
  PLAN_PENDING: '进入排料',
  EXECUTION_PENDING: '进入工作台',
  REPORT_PENDING: '查看方案',
  ATTENTION: '复核方案',
  COMPLETED: '查看产出'
};

export const TasksPage: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');

  const setSlitSpec = useStudioStore((s) => s.setSlitSpec);

  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestJSON('/api/cutting/task-summaries');
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message || '读取任务列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  const filteredList = useMemo(
    () => filterTasks(rows, search, statusFilter),
    [rows, search, statusFilter]
  );

  const countByStatus = (key: string) =>
    key === 'all' ? rows.length : rows.filter((r) => r.status === key).length;

  const handleOpenSlittingTask = (task: any) => {
    const sp = task.slitting || {};
    const orders = (task.demands || []).map((d: any, idx: number) => ({
      id: String(d.id || idx + 1),
      name: d.name || `规格 #${idx + 1}`,
      widthMm: Number(d.width) || 500,
      lengthMm: Number(d.length) || Number(task.process?.bedLength) || 2000,
      quantity: Number(d.quantity) || 1
    }));
    const maxW = Number(sp.maxWidth) || 4400;
    const leftTrim = Number(sp.leftTrim) ?? 10;
    const rightTrim = Number(sp.rightTrim) ?? 10;
    setSlitSpec({
      slitMotherWidthMm: maxW + leftTrim + rightTrim,
      slitLeftTrimMm: leftTrim,
      slitRightTrimMm: rightTrim,
      slitMinWidthMm: Number(sp.minWidth) || Math.floor(maxW * 0.9),
      slitMaxWidthMm: maxW,
      slitWidthStepMm: Number(sp.widthStep) || 10,
      slitOverCap: Number(sp.totalOverCap) ?? 20,
      slitFixedLengthMm: orders[0]?.lengthMm || Number(task.process?.bedLength) || 2000,
      slitOrders: orders
    });
    toast(`已将一维任务「${task.name}」载入一维定长分切台`);
    location.hash = '#/slitting';
  };

  const handleRowDoubleClick = (task: any) => {
    if (task.problemType === 'SLITTING_1D') {
      handleOpenSlittingTask(task);
    } else {
      location.hash = `#/workbench/${encodeURIComponent(task.id)}`;
    }
  };

  const statusCards: { key: string; label: string; hint: string; color?: string }[] = [
    { key: 'all', label: '全部生产单', hint: '总览全部在制与完工任务' },
    { key: 'PLAN_PENDING', label: '待排料计算', hint: '尚未生成候选排布方案' },
    {
      key: 'EXECUTION_PENDING',
      label: '候选已就绪',
      hint: '可锁料下达车间执行',
      color: 'var(--accent)'
    },
    {
      key: 'REPORT_PENDING',
      label: '待实切报工',
      hint: '机台已领料，待回填产出',
      color: 'var(--warn)'
    },
    {
      key: 'ATTENTION',
      label: '异常需处理',
      hint: '复检缺口或预约变更',
      color: countByStatus('ATTENTION') > 0 ? 'var(--err)' : undefined
    },
    {
      key: 'COMPLETED',
      label: '已齐套完工',
      hint: '良品履约已全部达成',
      color: 'var(--ok)'
    }
  ];

  return (
    <div className="react-page">
      <div className="ph">
        <h1>任务</h1>
        <span className="crumb">订单需求跟踪与车间进度总览</span>
        <span className="sp" />
        <input
          className="field"
          id="task-search"
          aria-label="搜索任务"
          placeholder="搜索任务号 / 款式 / 材料型号 / 外部单号…"
          style={{ width: 250 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="btn sm" onClick={loadTasks}>
          刷新
        </button>
        <a className="btn pri" href="#/task/new">
          ＋ 新建任务
        </a>
      </div>

      {/* Single unified KPI + Status Filter Strip (eliminates redundant duplicate filter bar) */}
      <div className="kpi-strip kpi-strip-6" role="group" aria-label="按任务状态筛选">
        {statusCards.map((c) => {
          const active = statusFilter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              data-status={c.key}
              aria-pressed={active}
              className={`kpi-card ${active ? 'on' : ''}`}
              onClick={() =>
                setStatusFilter(active && c.key !== 'all' ? 'all' : c.key)
              }
            >
              <small>{c.label}</small>
              <b className="num" style={c.color ? { color: c.color } : undefined}>
                {countByStatus(c.key)}
              </b>
              <span>{c.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="body">
        {error ? (
          <div className="error-box" role="alert">
            <b>操作未完成</b>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="loading">正在读取生产任务队列…</div>
        ) : filteredList.length > 0 ? (
          <>
            <table className="t task-table">
              <thead>
                <tr>
                  <th>任务 / 来源单号</th>
                  <th>工艺类型</th>
                  <th>材料型号</th>
                  <th className="r">规格数</th>
                  <th>良品履约达成率</th>
                  <th>当前状态</th>
                  <th className="r">候选</th>
                  <th className="r">报工</th>
                  <th>推进操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredList.map((r: any) => {
                  const t = r.task;
                  const pct = r.total ? (r.completed / r.total) * 100 : 0;
                  const directIntent =
                    r.status === 'REPORT_PENDING'
                      ? 'report'
                      : r.status === 'ATTENTION'
                      ? 'quality'
                      : '';
                  const isSlitting = t.problemType === 'SLITTING_1D';

                  return (
                    <tr
                      key={t.id}
                      className="click"
                      onDoubleClick={() => handleRowDoubleClick(t)}
                    >
                      <td className="task-identity">
                        <a
                          href={
                            isSlitting
                              ? '#/slitting'
                              : `#/workbench/${encodeURIComponent(t.id)}`
                          }
                          onClick={(e) => {
                            if (isSlitting) {
                              e.preventDefault();
                              handleOpenSlittingTask(t);
                            }
                          }}
                        >
                          {t.name}
                        </a>
                        <small>
                          <span className="num">{shortId(t.id)}</span> ·{' '}
                          {t.externalRef || '内部创建'}
                        </small>
                      </td>
                      <td>
                        <span className="tag kind">
                          {isSlitting ? '一维分切' : '二维排料'}
                        </span>
                      </td>
                      <td>
                        <span className="num">{t.materialModel}</span>
                      </td>
                      <td className="r num">{(t.demands || []).length}</td>
                      <td>
                        <div className="task-progress">
                          <span className="num">
                            {r.completed}
                            <span className="muted">
                              {' '}
                              / {r.total} {isSlitting ? '卷' : '件'} ({Math.round(pct)}%)
                            </span>
                          </span>
                          <span className="bar" aria-hidden="true">
                            <i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`tag ${STATUS_TAG_MAP[r.status] || ''}`}>
                          {(taskLabels as Record<string, string>)[r.status] || r.status}
                        </span>
                      </td>
                      <td className="r num">{r.pendingCount || 0}</td>
                      <td className="r num">{r.reportCount || 0}</td>
                      <td>
                        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                          {isSlitting ? (
                            <button
                              type="button"
                              className="btn sm pri"
                              onClick={() => handleOpenSlittingTask(t)}
                            >
                              一维分切台
                            </button>
                          ) : (
                            <a
                              className={`btn sm ${
                                !directIntent &&
                                (r.status === 'PLAN_PENDING' ||
                                  r.status === 'EXECUTION_PENDING')
                                  ? 'pri'
                                  : ''
                              }`}
                              href={`#/workbench/${encodeURIComponent(t.id)}`}
                            >
                              {ACTION_LABEL_MAP[r.status] || '打开'}
                            </a>
                          )}
                          {directIntent && (
                            <a
                              className="btn sm pri"
                              href={
                                directIntent === 'report'
                                  ? `#/execution/${encodeURIComponent(t.id)}`
                                  : `#/quality`
                              }
                            >
                              {directIntent === 'report' ? '去报工' : '处理异常'}
                            </a>
                          )}
                          <a className="btn sm" href={`#/task/${encodeURIComponent(t.id)}`}>
                            编辑
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="pager">
              <span className="num">
                显示 {filteredList.length} / 共 {rows.length} 条任务
              </span>
              <span>双击任意任务行可直达对应排料或分切工作台</span>
            </div>
          </>
        ) : (
          <div className="empty">没有符合条件的任务</div>
        )}
      </div>
    </div>
  );
};
