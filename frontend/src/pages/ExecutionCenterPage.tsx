import React, { useEffect, useState } from 'react';
import { requestJSON, shortId, fmtTime, fmtN, toast } from '@static/app/js/util.js';
import { defaultReport, buildCutReport, OUTCOMES } from '@static/app/js/model/report.js';
import { executionWriter, executionLabels } from '@static/js/business/cutting/execution-client.js';

export const ExecutionCenterPage: React.FC<{ taskId?: string }> = ({ taskId }) => {
  const [summaries, setSummaries] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>(taskId || '');
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [reportDraft, setReportDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (taskId) {
      setSelectedTaskId(taskId);
    }
  }, [taskId]);

  const loadAll = async () => {
    const [sums, execs] = await Promise.all([
      requestJSON('/api/cutting/task-summaries'),
      requestJSON('/api/v2/execution-orders')
    ]);
    setSummaries(sums || []);
    setOrders(execs || []);
    if (!taskId && !selectedTaskId && sums?.length) {
      const reversed = sums.slice().reverse();
      const firstOpen = reversed.find((s: any) => s.status !== 'COMPLETED') || reversed[0];
      setSelectedTaskId(firstOpen.task.id);
    }
  };

  useEffect(() => {
    loadAll().catch((e) => toast('读取报工列表失败：' + e.message, true));
  }, []);

  useEffect(() => {
    if (!selectedTaskId) return;
    Promise.all([
      requestJSON('/api/cutting/tasks/' + encodeURIComponent(selectedTaskId)),
      requestJSON('/api/cutting/tasks/' + encodeURIComponent(selectedTaskId) + '/plans')
    ])
      .then(([d, p]) => {
        setTaskDetail(d);
        setPlans(p || []);
        setReportDraft(null);
      })
      .catch((e) => toast(e.message, true));
  }, [selectedTaskId]);

  const reloadCurrentTask = async () => {
    await loadAll();
    if (selectedTaskId) {
      const [d, p] = await Promise.all([
        requestJSON('/api/cutting/tasks/' + encodeURIComponent(selectedTaskId)),
        requestJSON('/api/cutting/tasks/' + encodeURIComponent(selectedTaskId) + '/plans')
      ]);
      setTaskDetail(d);
      setPlans(p || []);
    }
  };

  const handleOpenReport = (plan: any) => {
    const seg = {
      id: plan.id,
      len: plan.result?.deductLen || plan.request?.rollL || 1000,
      start: plan.request?.windowStartY || 0,
      pieces: (plan.result?.pieces || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        u: (plan.request?.windowStartY || 0) + p.y,
        v: p.x,
        du: p.shape?.height || p.l,
        dv: p.shape?.width || p.w
      })),
      remnants: plan.result?.remnants || []
    };
    setReportDraft({ seg, draft: defaultReport(seg, { remnant: plan.request?.feedPortType === 'remnant' }) });
  };

  const handleConfirmReport = async () => {
    if (!reportDraft || busy) return;
    setBusy(true);
    try {
      const payload = buildCutReport(reportDraft.seg, reportDraft.draft);
      await requestJSON('/api/cutting/report-confirm', payload);
      toast('报工已记账！库存消耗与良品完成量已更新');
      setReportDraft(null);
      await reloadCurrentTask();
    } catch (e: any) {
      toast('报工未完成：' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleExecCommand = async (action: 'release' | 'start' | 'cancel', plan: any, orderView?: any) => {
    setBusy(true);
    try {
      const writer = executionWriter();
      let target = orderView?.execution;
      if (!target && action === 'release') {
        const created = await writer.command(
          'create',
          { taskId: selectedTaskId, planId: plan.id, id: '', version: 0 },
          { station: '1' }
        );
        target = created.execution;
      }
      if (!target) throw new Error('尚未创建执行单');
      await writer.command(
        action,
        {
          taskId: target.taskId,
          planId: target.planId,
          id: target.id,
          version: target.version
        },
        action === 'release' ? { reservationSeconds: 1800 } : action === 'cancel' ? { reason: '生产报工中心取消' } : {}
      );
      toast({ release: '已下达锁料', start: '已开工生产', cancel: '已取消执行单' }[action]);
      await reloadCurrentTask();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const taskOrders = orders.filter((o) => o.execution?.taskId === selectedTaskId);

  return (
    <div className="react-page">
      <div className="ph">
        <h1>生产移交与报工中心</h1>
        <span className="crumb">与排料画布彻底解耦 · 仅承接从工作台选定移交的方案，集中办理下达、开工、实切报工与余料回库</span>
        <span className="sp" />
        <a className="btn" href="#/workbench">
          ← 返回二维搭切台挑选方案
        </a>
      </div>

      <div className="studio-split" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <section className="pane">
          <div className="pane-h">已移交的生产任务单 ({summaries.length})</div>
          <div className="pane-b">
            <table className="t" style={{ border: 0 }}>
              <thead>
                <tr>
                  <th>任务 / 方案来源</th>
                  <th className="r">进度</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {summaries
                  .slice()
                  .reverse()
                  .map((r) => (
                    <tr
                      key={r.task.id}
                      className={`click ${selectedTaskId === r.task.id ? 'sel' : ''}`}
                      onClick={() => setSelectedTaskId(r.task.id)}
                    >
                      <td className="wrap">
                        <div style={{ fontWeight: 600 }}>{r.task.name}</div>
                        <small className="muted num">
                          {shortId(r.task.id)} · {r.task.materialModel}
                        </small>
                      </td>
                      <td className="r num">
                        {r.completed}/{r.total}
                      </td>
                      <td>
                        <span className={`tag ${r.status === 'COMPLETED' ? 'ok' : r.pendingCount > 0 ? 'run' : ''}`}>
                          {r.status === 'COMPLETED' ? '已完工' : r.pendingCount > 0 ? `${r.pendingCount}待报` : '待排'}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="pane" style={{ background: 'var(--bg)' }}>
          <div className="body">
            {taskDetail?.task ? (
              <>
                <div className="box">
                  <div className="pane-h">
                    {taskDetail.task.name}
                    <span className="sp" />
                    <a className="btn sm" href={`#/workbench/${encodeURIComponent(taskDetail.task.id)}`}>
                      回工作台查看排料图 ↗
                    </a>
                  </div>
                  <div className="kv">
                    <div>材料型号</div>
                    <div className="num">{taskDetail.task.materialModel}</div>
                    <div>说明来源</div>
                    <div>{taskDetail.task.externalRef || '—'}</div>
                  </div>
                </div>

                <div className="box">
                  <div className="pane-h">待报工与已归档方案 ({plans.length})</div>
                  {plans.length === 0 ? (
                    <div className="empty">该任务尚未从排料台移交具体排料方案</div>
                  ) : (
                    <table className="t" style={{ border: 0 }}>
                      <thead>
                        <tr>
                          <th>方案编号</th>
                          <th>使用材料</th>
                          <th className="r">实占长 mm</th>
                          <th className="r">排入件数</th>
                          <th>状态 / 执行单</th>
                          <th>报工操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plans.map((p) => {
                          const ov = taskOrders.find((o) => o.execution.planId === p.id && o.effectiveState !== 'CANCELLED');
                          return (
                            <tr key={p.id}>
                              <td className="num">{shortId(p.id)} · v{p.version || 1}</td>
                              <td className="num">{p.request?.rollId || p.request?.sourceRemnantId || '—'}</td>
                              <td className="r num">{fmtN(p.result?.deductLen || p.request?.rollL, 1)}</td>
                              <td className="r num">{p.result?.pieces?.length || 0}</td>
                              <td>
                                <span className={`tag ${p.status === 'CONFIRMED' ? 'ok' : p.status === 'PENDING' ? 'run' : ''}`}>
                                  {p.status === 'CONFIRMED' ? '已报工记账' : p.status === 'PENDING' ? '待实切' : p.status}
                                </span>
                                {ov && (
                                  <small className="muted" style={{ marginLeft: 6 }}>
                                    执行单：{executionLabels[ov.effectiveState] || ov.effectiveState}
                                  </small>
                                )}
                              </td>
                              <td>
                                {p.status === 'PENDING' ? (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    {!ov && (
                                      <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busy}
                                        onClick={() => handleExecCommand('release', p)}
                                      >
                                        下达锁料
                                      </button>
                                    )}
                                    {ov && ov.effectiveState === 'RELEASED' && (
                                      <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busy}
                                        onClick={() => handleExecCommand('start', p, ov)}
                                      >
                                        开工
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="btn sm pri"
                                      disabled={busy}
                                      onClick={() => handleOpenReport(p)}
                                    >
                                      填写实切报工
                                    </button>
                                  </div>
                                ) : (
                                  <span className="muted">{fmtTime(p.createdAt)}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {reportDraft && (
                  <div className="box">
                    <div className="pane-h">
                      实切报工核对单 · 方案 {shortId(reportDraft.seg.id)}
                      <span className="sp" />
                      <button type="button" className="btn sm" onClick={() => setReportDraft(null)}>
                        取消
                      </button>
                    </div>
                    <div className="form" style={{ gridTemplateColumns: '120px 1fr' }}>
                      <label>实切总长度 mm</label>
                      <input
                        type="number"
                        className="field num"
                        value={reportDraft.draft.len}
                        onChange={(e) =>
                          setReportDraft((r: any) => ({
                            ...r,
                            draft: { ...r.draft, len: Number(e.target.value) }
                          }))
                        }
                      />
                      <label>料头回库位置</label>
                      <input
                        className="field"
                        value={reportDraft.draft.location}
                        onChange={(e) =>
                          setReportDraft((r: any) => ({
                            ...r,
                            draft: { ...r.draft, location: e.target.value }
                          }))
                        }
                      />
                    </div>
                    <table className="t" style={{ border: 0 }}>
                      <thead>
                        <tr>
                          <th>裁片编号</th>
                          <th>名称</th>
                          <th>实切判定</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportDraft.seg.pieces.map((pc: any) => (
                          <tr key={pc.id}>
                            <td className="num">#{pc.id}</td>
                            <td>{pc.name}</td>
                            <td>
                              <select
                                className="field"
                                style={{ height: 24 }}
                                value={reportDraft.draft.rows[pc.id]?.outcome || 'QUALIFIED'}
                                onChange={(e) =>
                                  setReportDraft((r: any) => ({
                                    ...r,
                                    draft: {
                                      ...r.draft,
                                      rows: {
                                        ...r.draft.rows,
                                        [pc.id]: { outcome: e.target.value, reason: '' }
                                      }
                                    }
                                  }))
                                }
                              >
                                {Object.entries(OUTCOMES).map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="foot">
                      <span className="muted">提交后将正式扣减对应母卷可用长度并登记良品产出</span>
                      <span className="sp" />
                      <button
                        type="button"
                        className="btn pri"
                        disabled={busy}
                        onClick={handleConfirmReport}
                      >
                        确认过账报工
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="empty">请从左侧选择一张待报工或历史任务单</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
