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
  REPORT_PENDING: '工作台',
  ATTENTION: '工作台',
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

  const planPending = countByStatus('PLAN_PENDING');
  const execPending = countByStatus('EXECUTION_PENDING');
  const reportPending = countByStatus('REPORT_PENDING');
  const attention = countByStatus('ATTENTION');
  const completed = countByStatus('COMPLETED');

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

  return (
    <div className="react-page">
      <div className="ph">
        <h1>任务</h1>
        <span className="crumb">生产作业调度中心</span>
        <div className="hub-tabs" role="navigation" aria-label="生产作业视图">
          <a className="on" href="#/tasks">
            任务队列 ({rows.length})
          </a>
          <a href="#/execution">工位执行单</a>
          <a href="#/quality">异常复检</a>
        </div>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={loadTasks}>
          刷新队列
        </button>
        <a className="btn pri" href="#/task/new">
          ＋ 新建生产任务
        </a>
      </div>

      <div className="kpi-strip">
        <button
          type="button"
          className={`kpi-card ${statusFilter === 'PLAN_PENDING' ? 'on' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'PLAN_PENDING' ? 'all' : 'PLAN_PENDING')}
        >
          <small>待排料任务</small>
          <b className="num">{planPending}</b>
          <span>点击筛选待计算需求</span>
        </button>
        <button
          type="button"
          className={`kpi-card ${statusFilter === 'EXECUTION_PENDING' ? 'on' : ''}`}
          onClick={() =>
            setStatusFilter(statusFilter === 'EXECUTION_PENDING' ? 'all' : 'EXECUTION_PENDING')
          }
        >
          <small>待执行 / 候选就绪</small>
          <b className="num" style={{ color: 'var(--accent)' }}>
            {execPending}
          </b>
          <span>已有候选方案可下达或报工</span>
        </button>
        <button
          type="button"
          className={`kpi-card ${statusFilter === 'REPORT_PENDING' ? 'on' : ''}`}
          onClick={() =>
            setStatusFilter(statusFilter === 'REPORT_PENDING' ? 'all' : 'REPORT_PENDING')
          }
        >
          <small>待实切报工</small>
          <b className="num" style={{ color: 'var(--warn)' }}>
            {reportPending}
          </b>
          <span>机台已锁定，直达报工记账</span>
        </button>
        <button
          type="button"
          className={`kpi-card ${statusFilter === 'ATTENTION' ? 'on' : ''}`}
          onClick={() => setStatusFilter(statusFilter === 'ATTENTION' ? 'all' : 'ATTENTION')}
        >
          <small>异常需处理 / 已完成</small>
          <b
            className="num"
            style={{ color: attention ? 'var(--err)' : 'var(--ok)' }}
          >
            {attention}{' '}
            <em style={{ fontSize: 13, color: 'var(--text-3)', fontStyle: 'normal' }}>
              / {completed} 完
            </em>
          </b>
          <span>复检补产或方案失效重算</span>
        </button>
      </div>

      <div className="toolbar">
        <div className="seg task-filters" role="group" aria-label="任务状态">
          {['all', ...Object.keys(taskLabels)].map((k) => (
            <button
              key={k}
              type="button"
              className={statusFilter === k ? 'on' : ''}
              aria-pressed={statusFilter === k}
              onClick={() => setStatusFilter(k)}
            >
              {k === 'all' ? '全部' : (taskLabels as Record<string, string>)[k]}{' '}
              <span className="filter-count num">{countByStatus(k)}</span>
            </button>
          ))}
        </div>
        <span className="sp" />
        <input
          className="field"
          id="task-search"
          aria-label="搜索任务"
          placeholder="搜索任务号 / 名称 / 材料型号 / 外部单号…"
          style={{ width: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
                  <th>任务 / 来源</th>
                  <th>类型</th>
                  <th>材料型号</th>
                  <th className="r">需求项</th>
                  <th>良品履约进度</th>
                  <th>当前环节</th>
                  <th className="r">候选方案</th>
                  <th className="r">已报工</th>
                  <th>主操作</th>
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
                          {t.externalRef || '无来源编号'}
                        </small>
                      </td>
                      <td>
                        <span className="tag kind">
                          {isSlitting ? '一维分切' : '二维裁切'}
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
                            <i
                              style={{
                                width: `${Math.min(100, Math.max(0, pct))}%`
                              }}
                            />
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
                                (r.status === 'PLAN_PENDING' || r.status === 'EXECUTION_PENDING')
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
                              {directIntent === 'report' ? '直达报工' : '处理异常'}
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
              <span>
                显示 {filteredList.length} / 共 {rows.length} 条任务
              </span>
              <span>双击任意行直接打开对应排料/分切工作台</span>
            </div>
          </>
        ) : (
          <div className="empty">没有符合条件的任务</div>
        )}
      </div>
    </div>
  );
};
