import React, { useEffect, useMemo, useState } from 'react';
import { requestJSON, shortId, fmtTime, fmtN, toast } from '@static/app/js/util.js';
import {
  defaultReport,
  applyBulk,
  recoveryCandidates,
  reportSummary,
  reportProblems,
  buildCutReport,
  OUTCOMES
} from '@static/app/js/model/report.js';
import {
  reviewablePieces,
  effectivePieceResults,
  emptyQualityForm,
  qualityProblems,
  buildQualityCommand,
  receiptSummary,
  DISPOSITIONS
} from '@static/app/js/model/quality.js';
import {
  executionWriter,
  executionLabels,
  executionForPlan
} from '@static/js/business/cutting/execution-client.js';
import {
  assignCar,
  carStart,
  carRequest
} from '@static/app/js/model/slitting.js';

export const ExecutionCenterPage: React.FC<{
  taskId?: string;
  planId?: string;
  intent?: string;
}> = ({ taskId, planId, intent }) => {
  const writer = useMemo(() => executionWriter(), []);
  const [summaries, setSummaries] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [rolls, setRolls] = useState<any[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>(taskId || '');
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [selectedRollForDispatch, setSelectedRollForDispatch] = useState<string>('');
  const [reserveMin, setReserveMin] = useState<number>(30);
  const [cancellingPlanId, setCancellingPlanId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState<string>('');

  // Report state
  const [reportDraft, setReportDraft] = useState<{ seg: any; draft: any } | null>(null);
  // Quality disposition state
  const [qualityDraft, setQualityDraft] = useState<any>(null);
  // Reverse report state
  const [reversingPlanId, setReversingPlanId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState<string>('');

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (taskId) {
      setSelectedTaskId(taskId);
    }
  }, [taskId]);

  const loadAll = async () => {
    const [sums, execs, allRolls] = await Promise.all([
      requestJSON('/api/cutting/task-summaries'),
      requestJSON('/api/v2/execution-orders'),
      requestJSON('/api/rolls').catch(() => [])
    ]);
    setSummaries(sums || []);
    setOrders(execs || []);
    setRolls(allRolls || []);
    if (!taskId && !selectedTaskId && sums?.length) {
      const reversed = sums.slice().reverse();
      const firstOpen =
        reversed.find((s: any) => s.status !== 'COMPLETED') || reversed[0];
      setSelectedTaskId(firstOpen.task.id);
    }
  };

  useEffect(() => {
    loadAll().catch((e) => toast('读取报工列表失败：' + e.message, true));
  }, []);

  const loadSelectedTaskDetail = async (id: string) => {
    const [d, p] = await Promise.all([
      requestJSON('/api/cutting/tasks/' + encodeURIComponent(id)),
      requestJSON('/api/cutting/tasks/' + encodeURIComponent(id) + '/plans')
    ]);
    setTaskDetail(d);
    setPlans(p || []);
    return { detail: d, plans: p || [] };
  };

  useEffect(() => {
    if (!selectedTaskId) return;
    setReportDraft(null);
    setQualityDraft(null);
    setReversingPlanId(null);
    loadSelectedTaskDetail(selectedTaskId)
      .then(({ detail }) => {
        if (planId && intent === 'quality' && detail?.reports) {
          const rep = detail.reports.find(
            (r: any) => r.planId === planId && r.status !== 'REVERSED'
          );
          if (rep) {
            const revPieces = reviewablePieces(rep);
            setQualityDraft(emptyQualityForm(rep, revPieces[0]?.pieceId));
          }
        }
      })
      .catch((e) => toast(e.message, true));
  }, [selectedTaskId, planId, intent]);

  const reloadCurrentTask = async () => {
    await loadAll();
    if (selectedTaskId) {
      await loadSelectedTaskDetail(selectedTaskId);
    }
  };

  const passedRolls = useMemo(
    () => rolls.filter((r) => r.inspectionStatus === 'PASSED'),
    [rolls]
  );

  useEffect(() => {
    if (!selectedRollForDispatch && passedRolls.length > 0) {
      const tModel = taskDetail?.task?.materialModel;
      const match =
        passedRolls.find((r) => r.rollModel === tModel) || passedRolls[0];
      if (match) setSelectedRollForDispatch(match.rollId);
    }
  }, [passedRolls, taskDetail, selectedRollForDispatch]);

  const savedSlitScheme = useMemo(() => {
    if (!selectedTaskId) return null;
    try {
      const raw = localStorage.getItem('cutplan.app.slit.scheme.' + selectedTaskId);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, [selectedTaskId, plans.length]);

  const pendingSlots = useMemo(() => {
    if (!selectedTaskId) return [];
    return writer.pending(selectedTaskId);
  }, [writer, selectedTaskId, orders, busy]);

  const handleRetryPending = async (slot: string) => {
    setBusy(true);
    try {
      await writer.retry(slot);
      toast('原执行单操作已确认完成');
      await reloadCurrentTask();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenReport = (plan: any) => {
    const seg = {
      id: plan.id,
      len: plan.result?.deductLen || plan.request?.rollL || 1000,
      start: plan.request?.windowStartY || 0,
      pieces: (plan.result?.pieces || []).map((p: any) => ({
        id: p.id,
        demandId: p.demandId,
        name: p.name,
        u: (plan.request?.windowStartY || 0) + p.y,
        v: p.x,
        du: p.shape?.height || p.l,
        dv: p.shape?.width || p.w
      })),
      remnants: plan.result?.remnants || []
    };
    const isRemnant = plan.request?.feedPortType === 'remnant';
    setQualityDraft(null);
    setReportDraft({
      seg,
      draft: defaultReport(seg, { remnant: isRemnant })
    });
  };

  const handleConfirmReport = async () => {
    if (!reportDraft || busy) return;
    const problems = reportProblems(reportDraft.seg, reportDraft.draft);
    if (problems.length > 0) {
      toast(problems[0], true);
      return;
    }
    setBusy(true);
    try {
      const payload = buildCutReport(reportDraft.seg, reportDraft.draft);
      const view = executionForPlan(orders, reportDraft.seg.id);
      if (view && view.effectiveState === 'RUNNING') {
        await requestJSON(
          '/api/v2/execution-orders/' + encodeURIComponent(view.execution.id) + '/reports',
          payload
        );
      } else {
        await requestJSON('/api/cutting/report-confirm', payload);
      }
      toast('报工已记账！库存消耗与良品完成量已更新');
      setReportDraft(null);
      await reloadCurrentTask();
    } catch (e: any) {
      toast('报工未完成：' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleExecCommand = async (
    action: 'release' | 'start' | 'cancel',
    plan: any,
    orderView?: any
  ) => {
    if (action === 'cancel' && !cancelReason.trim()) {
      toast('请填写取消原因', true);
      return;
    }
    setBusy(true);
    try {
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
        action === 'release'
          ? { reservationSeconds: Math.max(60, Math.round((reserveMin || 30) * 60)) }
          : action === 'cancel'
          ? { reason: cancelReason.trim() }
          : {}
      );
      toast(
        {
          release: '已下达锁料并预约库存',
          start: '已开工生产，可填写实切报工',
          cancel: '已取消执行单并释放预约'
        }[action]
      );
      setCancellingPlanId(null);
      setCancelReason('');
      await reloadCurrentTask();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchSlitCar = async (pat: any) => {
    const task = taskDetail?.task;
    const roll = rolls.find((r) => r.rollId === selectedRollForDispatch);
    if (!task || !roll) {
      toast('请先选择一卷在库合格母卷', true);
      return;
    }
    setBusy(true);
    try {
      const done = taskDetail?.completed || {};
      const open = (task.demands || [])
        .map((d: any) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          length: d.length,
          demand: Math.max(0, d.quantity - (done[d.id] || 0))
        }))
        .filter((d: any) => d.demand > 0);
      if (!open.length) {
        toast('该一维任务的所有订单需求均已完成', true);
        return;
      }
      const { strips } = assignCar(pat, open, task.slitting?.leftTrim || 0);
      if (!strips.length) {
        toast('该刀组组合对应规格的需求已排完', true);
        return;
      }
      const len = (task.process?.trimStart || 0) + pat.lengthMm;
      const start = carStart(roll, roll.usedLength || 0, len, strips, plans);
      if (start == null) {
        toast('当前所选母卷剩余长度不足一车或存在无法避让的疵点，请更换母卷', true);
        return;
      }
      await requestJSON(
        '/api/cutting/slitting-cars',
        carRequest({ task, roll, start, pattern: pat, strips, settings: {} })
      );
      toast(`已成功出车（${strips.length} 条 · 起点 Y ${(start / 1000).toFixed(2)}m）`);
      await reloadCurrentTask();
    } catch (e: any) {
      toast('出车失败：' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleSolve2DWithSelectedRoll = async () => {
    const task = taskDetail?.task;
    const roll = rolls.find((r) => r.rollId === selectedRollForDispatch);
    if (!task || !roll) {
      toast('请先选择一卷在库合格母卷', true);
      return;
    }
    setBusy(true);
    try {
      const startY = roll.usedLength || 0;
      const bedL = task.process?.bedLength || 2000;
      await requestJSON('/api/solve', {
        minRemnantWidth: 200,
        minRemnantLength: 300,
        timeLimitSeconds: 6,
        taskId: task.id,
        taskRevision: task.revision,
        rollId: roll.rollId,
        rollModel: roll.rollModel,
        rollW: roll.width,
        rollL: bedL,
        totalRollL: roll.totalLength,
        windowStartY: startY,
        trimStart: task.process?.trimStart || 0,
        pieceGap: task.process?.pieceGap || 0,
        cutOrigin: task.process?.cutOrigin || 'left-top',
        firstStageOrientation: task.process?.firstStageOrientation || 'horizontal',
        allowRotation: Boolean(task.process?.allowRotation),
        allowLongitudinal: true,
        feedPortType: 'roll',
        sourceRemnantId: null,
        solver: 'packingsolver',
        defects: (roll.defects || []).filter(
          (d: any) => d.y < startY + bedL && d.y + d.h > startY
        ),
        demands: (task.demands || []).map((d: any) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          length: d.length,
          shape: d.shape ?? null,
          allowRotation: Boolean(d.allowRotation),
          demand: d.quantity
        }))
      });
      toast(`已关联实卷 ${roll.rollId} 生成待执行方案`);
      await reloadCurrentTask();
    } catch (e: any) {
      toast('生成方案失败：' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleReverseReport = async (pId: string) => {
    if (!reverseReason.trim()) {
      toast('请填写冲销原因', true);
      return;
    }
    setBusy(true);
    try {
      await requestJSON(
        '/api/cutting/reports/' + encodeURIComponent(pId) + '/reverse',
        { reason: reverseReason.trim() }
      );
      toast('报工已冲销，母卷用量与完成量已恢复');
      setReversingPlanId(null);
      setReverseReason('');
      await reloadCurrentTask();
    } catch (e: any) {
      toast('冲销未完成：' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitQuality = async () => {
    if (!qualityDraft || busy) return;
    const revPieces = reviewablePieces(qualityDraft.report);
    const piece = revPieces.find(
      (p: any) => p.pieceId === Number(qualityDraft.pieceId)
    );
    let cmd = qualityDraft.command;
    if (!cmd) {
      const probs = qualityProblems(qualityDraft, piece);
      if (probs.length > 0) {
        toast(probs[0], true);
        return;
      }
      cmd = buildQualityCommand(qualityDraft, crypto.randomUUID());
    }
    setBusy(true);
    try {
      await requestJSON(
        '/api/cutting/reports/' +
          encodeURIComponent(qualityDraft.report.planId) +
          '/quality-dispositions',
        cmd
      );
      toast(
        `复检处置已登记：${
          (DISPOSITIONS as Record<string, string>)[cmd.disposition]
        }，良品完成量已相应调整`
      );
      setQualityDraft(null);
      await reloadCurrentTask();
    } catch (e: any) {
      if (e.httpStatus === 400) {
        setQualityDraft({
          ...qualityDraft,
          command: null,
          uncertain: false,
          error: e.message
        });
      } else if (e.httpStatus === 409) {
        setQualityDraft({
          ...qualityDraft,
          uncertain: false,
          error: e.message + '。请关闭后刷新报工记录再处理。'
        });
      } else {
        setQualityDraft({
          ...qualityDraft,
          command: cmd,
          uncertain: true,
          error: e.message + ' 结果尚未确认，输入已保留，请重试同一处置。'
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const taskOrders = orders.filter((o) => o.execution?.taskId === selectedTaskId);
  const taskReports: any[] = taskDetail?.reports || [];
  const isSlittingTask = taskDetail?.task?.problemType === 'SLITTING_1D';

  const currentReportProblems = useMemo(
    () => (reportDraft ? reportProblems(reportDraft.seg, reportDraft.draft) : []),
    [reportDraft]
  );
  const currentRecoveryCands = useMemo(
    () => (reportDraft ? recoveryCandidates(reportDraft.seg, reportDraft.draft) : []),
    [reportDraft]
  );
  const currentReportSummary = useMemo(
    () => (reportDraft ? reportSummary(reportDraft.seg, reportDraft.draft) : null),
    [reportDraft]
  );

  return (
    <div className="react-page">
      <div className="ph">
        <h1>执行与报工</h1>
        <span className="crumb">
          锁料预约 · 开工确认 · 实切报工 · 余料入库
        </span>
        <div className="hub-tabs" role="navigation" aria-label="生产作业视图">
          <a href="#/tasks">任务队列</a>
          <a className="on" href="#/execution">
            工位执行单
          </a>
          <a href="#/quality">异常复检</a>
        </div>
        <span className="sp" />
        <button type="button" className="btn sm" onClick={reloadCurrentTask}>
          刷新状态
        </button>
        <a className="btn" href="#/workbench">
          选择任务方案
        </a>
      </div>

      {pendingSlots.length > 0 && (
        <div className="notice" style={{ margin: '8px 16px 0' }}>
          有 {pendingSlots.length} 个执行单操作结果未确认：
          {pendingSlots.map(([slot, v]: [string, any]) => (
            <button
              key={slot}
              type="button"
              className="btn sm pri"
              style={{ marginLeft: 8 }}
              disabled={busy}
              onClick={() => handleRetryPending(slot)}
            >
              重试 {v.action}
            </button>
          ))}
        </div>
      )}

      <div className="studio-split" style={{ gridTemplateColumns: '340px minmax(0, 1fr)' }}>
        <section className="pane">
          <div className="pane-h">生产任务单列表 ({summaries.length})</div>
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
                          {shortId(r.task.id)} ·{' '}
                          {r.task.problemType === 'SLITTING_1D' ? '1D分切' : '2D裁切'} ·{' '}
                          {r.task.materialModel}
                        </small>
                      </td>
                      <td className="r num">
                        {r.completed}/{r.total}
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            r.status === 'COMPLETED'
                              ? 'ok'
                              : r.pendingCount > 0
                              ? 'run'
                              : ''
                          }`}
                        >
                          {r.status === 'COMPLETED'
                            ? '已完工'
                            : r.pendingCount > 0
                            ? `${r.pendingCount}待报`
                            : '待出车'}
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
                    <span className="tag kind" style={{ marginLeft: 8 }}>
                      {isSlittingTask ? '一维定长分切' : '二维排料'}
                    </span>
                    <span className="sp" />
                    <label
                      className="muted"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        fontWeight: 400
                      }}
                    >
                      执行预约时长(分)
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 56, height: 24 }}
                        min={5}
                        max={480}
                        value={reserveMin}
                        onChange={(e) => setReserveMin(Number(e.target.value) || 30)}
                      />
                    </label>
                    <a
                      className="btn sm"
                      href={
                        isSlittingTask
                          ? '#/slitting'
                          : `#/workbench/${encodeURIComponent(taskDetail.task.id)}`
                      }
                    >
                      回工作台查看 ↗
                    </a>
                  </div>
                  <div className="kv">
                    <div>材料型号</div>
                    <div className="num">{taskDetail.task.materialModel}</div>
                    <div>说明来源</div>
                    <div>{taskDetail.task.externalRef || '—'}</div>
                  </div>
                </div>

                {/* 1D Slitting Dispatched Patterns & Car Dispatch Box */}
                {isSlittingTask && (
                  <div className="box">
                    <div className="pane-h">
                      一维分切刀组排布与实卷按车下达
                      <span className="sp" />
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <small className="muted">选用在库合格母卷：</small>
                        <select
                          className="field"
                          style={{ height: 26, fontSize: 12 }}
                          value={selectedRollForDispatch}
                          onChange={(e) => setSelectedRollForDispatch(e.target.value)}
                        >
                          {passedRolls.map((r) => (
                            <option key={r.rollId} value={r.rollId}>
                              {r.rollId} · {r.width}mm · 余{' '}
                              {(
                                (r.currentRemainingLength ?? r.totalLength) / 1000
                              ).toFixed(1)}
                              m
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                    {savedSlitScheme?.patterns?.length > 0 ? (
                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th>刀组编号</th>
                            <th>条宽组合 (mm×条)</th>
                            <th className="r">单车长 mm</th>
                            <th className="r">已用/余宽 mm</th>
                            <th className="r">计划车数</th>
                            <th>按车生成执行方案</th>
                          </tr>
                        </thead>
                        <tbody>
                          {savedSlitScheme.patterns.map((pat: any, idx: number) => (
                            <tr key={pat.id || idx}>
                              <td className="num">组 #{idx + 1}</td>
                              <td className="num">
                                {pat.stations
                                  .map((s: any) => `${s.widthMm}×${s.countPerRepetition}`)
                                  .join(' + ')}
                              </td>
                              <td className="r num">{fmtN(pat.lengthMm)}</td>
                              <td className="r num">
                                {pat.usedWidthMm} / 余 {pat.spareWidthMm}
                              </td>
                              <td className="r num">{pat.repetitions} 车</td>
                              <td>
                                <button
                                  type="button"
                                  className="btn sm pri"
                                  disabled={busy || !passedRolls.length}
                                  onClick={() => handleDispatchSlitCar(pat)}
                                >
                                  ＋ 出一车待报方案
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                        可在<a href="#/slitting">一维定长分切台</a>计算多订单组合后移交至此按车出车并报工。
                      </div>
                    )}
                  </div>
                )}

                <div className="box">
                  <div className="pane-h">
                    待报工与已归档方案 ({plans.length})
                    {!isSlittingTask && plans.length === 0 && passedRolls.length > 0 && (
                      <>
                        <span className="sp" />
                        <select
                          className="field"
                          style={{ height: 26, fontSize: 12 }}
                          value={selectedRollForDispatch}
                          onChange={(e) => setSelectedRollForDispatch(e.target.value)}
                        >
                          {passedRolls.map((r) => (
                            <option key={r.rollId} value={r.rollId}>
                              {r.rollId} ({r.width}mm · {r.rollModel})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn sm pri"
                          disabled={busy}
                          onClick={handleSolve2DWithSelectedRoll}
                        >
                          关联实卷生成待执行方案
                        </button>
                      </>
                    )}
                  </div>
                  {plans.length === 0 ? (
                    <div className="empty">
                      该任务暂无待执行排料方案 — 可在上方选择在库实卷一键生成，或前往工作台选定方案移交
                    </div>
                  ) : (
                    <table className="t" style={{ border: 0 }}>
                      <thead>
                        <tr>
                          <th>方案编号</th>
                          <th>使用材料</th>
                          <th className="r">实占长 mm</th>
                          <th className="r">排入件数</th>
                          <th>状态 / 执行单</th>
                          <th>执行与报工操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plans.map((p) => {
                          const ov = executionForPlan(taskOrders, p.id);
                          const report = taskReports.find(
                            (r) => r.planId === p.id && r.status !== 'REVERSED'
                          );
                          const revCount = report ? reviewablePieces(report).length : 0;

                          return (
                            <React.Fragment key={p.id}>
                              <tr>
                                <td className="num">
                                  {shortId(p.id)} · v{p.version || 1}
                                </td>
                                <td className="num">
                                  {p.request?.rollId || p.request?.sourceRemnantId || '—'}
                                </td>
                                <td className="r num">
                                  {fmtN(p.result?.deductLen || p.request?.rollL, 1)}
                                </td>
                                <td className="r num">{p.result?.pieces?.length || 0}</td>
                                <td>
                                  <span
                                    className={`tag ${
                                      p.status === 'CONFIRMED'
                                        ? 'ok'
                                        : p.status === 'PENDING'
                                        ? 'run'
                                        : ''
                                    }`}
                                  >
                                    {p.status === 'CONFIRMED'
                                      ? '已报工记账'
                                      : p.status === 'PENDING'
                                      ? '待实切'
                                      : p.status}
                                  </span>
                                  {ov && (
                                    <small className="muted" style={{ marginLeft: 6 }}>
                                      执行单：
                                      {(executionLabels as Record<string, string>)[
                                        ov.effectiveState
                                      ] || ov.effectiveState}
                                    </small>
                                  )}
                                </td>
                                <td>
                                  {p.status === 'PENDING' ? (
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: 6,
                                        flexWrap: 'wrap'
                                      }}
                                    >
                                      {(!ov ||
                                        ov.effectiveState === 'DRAFT' ||
                                        ov.effectiveState === 'EXPIRED' ||
                                        ov.effectiveState === 'CANCELLED') && (
                                        <button
                                          type="button"
                                          className="btn sm"
                                          disabled={busy}
                                          onClick={() =>
                                            handleExecCommand(
                                              'release',
                                              p,
                                              ov?.effectiveState === 'DRAFT' ? ov : undefined
                                            )
                                          }
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
                                      {ov &&
                                        ['DRAFT', 'RELEASED', 'RUNNING'].includes(
                                          ov.effectiveState
                                        ) && (
                                          <button
                                            type="button"
                                            className="btn sm"
                                            disabled={busy}
                                            onClick={() => {
                                              setCancellingPlanId(
                                                cancellingPlanId === p.id ? null : p.id
                                              );
                                              setCancelReason('');
                                            }}
                                          >
                                            取消执行
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
                                  ) : p.status === 'CONFIRMED' && report ? (
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: 6,
                                        flexWrap: 'wrap',
                                        alignItems: 'center'
                                      }}
                                    >
                                      <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busy || revCount === 0}
                                        title={
                                          revCount === 0
                                            ? '没有可复检的已切裁片'
                                            : '对已报工裁片执行报废或转料头重分类'
                                        }
                                        onClick={() => {
                                          setReportDraft(null);
                                          setQualityDraft(
                                            emptyQualityForm(
                                              report,
                                              reviewablePieces(report)[0]?.pieceId
                                            )
                                          );
                                        }}
                                      >
                                        复检处置 ({revCount})
                                      </button>
                                      <button
                                        type="button"
                                        className="btn sm"
                                        disabled={busy}
                                        onClick={() => {
                                          setReversingPlanId(
                                            reversingPlanId === p.id ? null : p.id
                                          );
                                          setReverseReason('');
                                        }}
                                      >
                                        冲销报工
                                      </button>
                                      <span className="muted" style={{ fontSize: 11.5 }}>
                                        {fmtTime(p.createdAt)}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="muted">{fmtTime(p.createdAt)}</span>
                                  )}
                                </td>
                              </tr>
                              {cancellingPlanId === p.id && ov && (
                                <tr>
                                  <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: 8,
                                        alignItems: 'center',
                                        padding: '4px 8px'
                                      }}
                                    >
                                      <span>取消执行单原因：</span>
                                      <input
                                        className="field"
                                        style={{ flex: 1 }}
                                        placeholder="必填，如：换卷生产 / 现场临时改单"
                                        value={cancelReason}
                                        onChange={(e) => setCancelReason(e.target.value)}
                                      />
                                      <button
                                        type="button"
                                        className="btn sm pri"
                                        disabled={busy}
                                        onClick={() => handleExecCommand('cancel', p, ov)}
                                      >
                                        确认取消执行单
                                      </button>
                                      <button
                                        type="button"
                                        className="btn sm"
                                        onClick={() => setCancellingPlanId(null)}
                                      >
                                        关闭
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              {reversingPlanId === p.id && (
                                <tr>
                                  <td colSpan={6} style={{ background: 'var(--panel-2)' }}>
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: 8,
                                        alignItems: 'center',
                                        padding: '4px 8px'
                                      }}
                                    >
                                      <span>冲销报工原因：</span>
                                      <input
                                        className="field"
                                        style={{ flex: 1 }}
                                        placeholder="必填，冲销将恢复母卷用量并撤回产出料头与完成量"
                                        value={reverseReason}
                                        onChange={(e) => setReverseReason(e.target.value)}
                                      />
                                      <button
                                        type="button"
                                        className="btn sm pri"
                                        disabled={busy}
                                        onClick={() => handleReverseReport(p.id)}
                                      >
                                        确认冲销
                                      </button>
                                      <button
                                        type="button"
                                        className="btn sm"
                                        onClick={() => setReversingPlanId(null)}
                                      >
                                        关闭
                                      </button>
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

                {/* Quality Disposition Panel */}
                {qualityDraft && (
                  <div className="box" id="quality-disposition-box">
                    <div className="pane-h">
                      复检处置 · 报工单 {shortId(qualityDraft.report.planId)}
                      <span className="sp" />
                      <button
                        type="button"
                        className="btn sm"
                        disabled={Boolean(qualityDraft.uncertain)}
                        onClick={() => setQualityDraft(null)}
                      >
                        关闭
                      </button>
                    </div>
                    <div className="pane-b">
                      <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>
                        原报工与母卷耗用保留；已报良品处置为报废或转料头后，将自动扣回良品完成量以形成补产需求。
                      </div>
                      <div className="form" style={{ gridTemplateColumns: '110px 1fr' }}>
                        <label>待处置裁片</label>
                        <select
                          className="field"
                          disabled={Boolean(qualityDraft.command)}
                          value={qualityDraft.pieceId}
                          onChange={(e) =>
                            setQualityDraft({
                              ...qualityDraft,
                              pieceId: Number(e.target.value)
                            })
                          }
                        >
                          {reviewablePieces(qualityDraft.report).map((p: any) => (
                            <option key={p.pieceId} value={p.pieceId}>
                              #{p.pieceId} · {String(p.name || '').slice(0, 22)} · {p.w}×{p.l} mm · 原
                              {p.outcome === 'QUALIFIED' ? '良品' : '异常'}
                            </option>
                          ))}
                        </select>
                        <label>处置方式</label>
                        <select
                          className="field"
                          disabled={Boolean(qualityDraft.command)}
                          value={qualityDraft.disposition}
                          onChange={(e) =>
                            setQualityDraft({
                              ...qualityDraft,
                              disposition: e.target.value
                            })
                          }
                        >
                          {Object.entries(DISPOSITIONS).map(([k, label]) => (
                            <option key={k} value={k}>
                              {label as string}
                            </option>
                          ))}
                        </select>
                        <label>检验人</label>
                        <input
                          className="field"
                          disabled={Boolean(qualityDraft.command)}
                          value={qualityDraft.inspector}
                          placeholder="填写质检员姓名"
                          onChange={(e) =>
                            setQualityDraft({ ...qualityDraft, inspector: e.target.value })
                          }
                        />
                        <label>复检原因</label>
                        <input
                          className="field"
                          disabled={Boolean(qualityDraft.command)}
                          value={qualityDraft.reason}
                          placeholder="如：复验发现局部抽纱/色差"
                          onChange={(e) =>
                            setQualityDraft({ ...qualityDraft, reason: e.target.value })
                          }
                        />
                        {qualityDraft.disposition === 'REMNANT' && (
                          <>
                            <label>回收起点 X/Y</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <input
                                type="number"
                                className="field num"
                                style={{ width: '50%' }}
                                disabled={Boolean(qualityDraft.command)}
                                value={qualityDraft.x}
                                placeholder="起点 X mm"
                                onChange={(e) =>
                                  setQualityDraft({ ...qualityDraft, x: e.target.value })
                                }
                              />
                              <input
                                type="number"
                                className="field num"
                                style={{ width: '50%' }}
                                disabled={Boolean(qualityDraft.command)}
                                value={qualityDraft.y}
                                placeholder="起点 Y mm"
                                onChange={(e) =>
                                  setQualityDraft({ ...qualityDraft, y: e.target.value })
                                }
                              />
                            </div>
                            <label>回收宽×长 mm</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <input
                                type="number"
                                className="field num"
                                style={{ width: '50%' }}
                                disabled={Boolean(qualityDraft.command)}
                                value={qualityDraft.width}
                                placeholder="回收宽 mm"
                                onChange={(e) =>
                                  setQualityDraft({ ...qualityDraft, width: e.target.value })
                                }
                              />
                              <input
                                type="number"
                                className="field num"
                                style={{ width: '50%' }}
                                disabled={Boolean(qualityDraft.command)}
                                value={qualityDraft.length}
                                placeholder="回收长 mm"
                                onChange={(e) =>
                                  setQualityDraft({ ...qualityDraft, length: e.target.value })
                                }
                              />
                            </div>
                            <label>回收库位</label>
                            <input
                              className="field"
                              disabled={Boolean(qualityDraft.command)}
                              value={qualityDraft.location}
                              placeholder="如：复检料头架 B-02"
                              onChange={(e) =>
                                setQualityDraft({
                                  ...qualityDraft,
                                  location: e.target.value
                                })
                              }
                            />
                            <label>料头质量状态</label>
                            <select
                              className="field"
                              disabled={Boolean(qualityDraft.command)}
                              value={qualityDraft.quality}
                              onChange={(e) =>
                                setQualityDraft({
                                  ...qualityDraft,
                                  quality: e.target.value
                                })
                              }
                            >
                              <option value="QUARANTINED">待检隔离（不能直接选料）</option>
                              <option value="RECOVERABLE">已验收可用</option>
                            </select>
                          </>
                        )}
                      </div>
                      {qualityDraft.error && (
                        <div className="notice">{qualityDraft.error}</div>
                      )}
                      <div className="foot">
                        <span className="sp" />
                        <button
                          type="button"
                          className="btn pri"
                          disabled={busy}
                          onClick={handleSubmitQuality}
                        >
                          {qualityDraft.uncertain ? '重试同一复检处置' : '确认复检处置'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Cut Report Confirmation Panel */}
                {reportDraft && (
                  <div className="box">
                    <div className="pane-h">
                      实切报工核对单 · 方案 {shortId(reportDraft.seg.id)}
                      <span className="sp" />
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setReportDraft(null)}
                      >
                        取消
                      </button>
                    </div>
                    <div className="form" style={{ gridTemplateColumns: '120px 1fr' }}>
                      {reportDraft.draft.remnant ? (
                        <>
                          <label>投料方式</label>
                          <div className="muted">
                            料头整块投料：不扣减母卷长度，剩余部分不再二次回收
                          </div>
                        </>
                      ) : (
                        <>
                          <label>实切总长度 mm</label>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                              type="number"
                              className="field num"
                              style={{ width: 140 }}
                              value={reportDraft.draft.len}
                              onChange={(e) =>
                                setReportDraft((r) =>
                                  r
                                    ? {
                                        ...r,
                                        draft: {
                                          ...r.draft,
                                          len: Number(e.target.value)
                                        }
                                      }
                                    : null
                                )
                              }
                            />
                            <span className="muted">
                              方案排料长度 {fmtN(reportDraft.seg.len, 1)} mm
                            </span>
                          </div>
                        </>
                      )}
                      <label>料头回库位置</label>
                      <input
                        className="field"
                        value={reportDraft.draft.location}
                        onChange={(e) =>
                          setReportDraft((r) =>
                            r
                              ? {
                                  ...r,
                                  draft: { ...r.draft, location: e.target.value }
                                }
                              : null
                          )
                        }
                      />
                    </div>

                    <div
                      className="sec"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <span>
                        逐件结果核对 · 合格 {currentReportSummary?.qualified ?? 0} · 异常{' '}
                        {currentReportSummary?.rejected ?? 0} · 未切{' '}
                        {currentReportSummary?.uncut ?? 0}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setReportDraft((r) =>
                              r
                                ? {
                                    ...r,
                                    draft: applyBulk(
                                      r.draft,
                                      'all-qualified',
                                      r.seg
                                    )
                                  }
                                : null
                            )
                          }
                        >
                          全设合格
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setReportDraft((r) =>
                              r
                                ? {
                                    ...r,
                                    draft: applyBulk(r.draft, 'all-uncut', r.seg)
                                  }
                                : null
                            )
                          }
                        >
                          全设未切
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setReportDraft((r) =>
                              r
                                ? {
                                    ...r,
                                    draft: applyBulk(
                                      r.draft,
                                      'beyond-uncut',
                                      r.seg
                                    )
                                  }
                                : null
                            )
                          }
                        >
                          长度外标为未切
                        </button>
                      </div>
                    </div>

                    <table className="t" style={{ border: 0 }}>
                      <thead>
                        <tr>
                          <th>裁片编号</th>
                          <th>名称</th>
                          <th className="r">尺寸 mm</th>
                          <th>实切判定</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportDraft.seg.pieces.map((pc: any) => {
                          const row = reportDraft.draft.rows[pc.id] || {
                            outcome: 'QUALIFIED',
                            reason: ''
                          };
                          return (
                            <tr key={pc.id}>
                              <td className="num">#{pc.id}</td>
                              <td>{pc.name}</td>
                              <td className="r num">
                                {fmtN(pc.dv)}×{fmtN(pc.du)}
                              </td>
                              <td>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <select
                                    className="field"
                                    style={{ height: 24, width: 96 }}
                                    value={row.outcome}
                                    onChange={(e) =>
                                      setReportDraft((r) =>
                                        r
                                          ? {
                                              ...r,
                                              draft: {
                                                ...r.draft,
                                                rows: {
                                                  ...r.draft.rows,
                                                  [pc.id]: {
                                                    outcome: e.target.value,
                                                    reason: row.reason || ''
                                                  }
                                                }
                                              }
                                            }
                                          : null
                                      )
                                    }
                                  >
                                    {Object.entries(OUTCOMES).map(([k, v]) => (
                                      <option key={k} value={k}>
                                        {v as string}
                                      </option>
                                    ))}
                                  </select>
                                  {row.outcome === 'REJECTED' && (
                                    <input
                                      className="field"
                                      style={{ height: 24, flex: 1 }}
                                      placeholder="必填：填写异常原因"
                                      value={row.reason || ''}
                                      onChange={(e) =>
                                        setReportDraft((r) =>
                                          r
                                            ? {
                                                ...r,
                                                draft: {
                                                  ...r.draft,
                                                  rows: {
                                                    ...r.draft.rows,
                                                    [pc.id]: {
                                                      ...row,
                                                      reason: e.target.value
                                                    }
                                                  }
                                                }
                                              }
                                            : null
                                        )
                                      }
                                    />
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {currentRecoveryCands.length > 0 && (
                      <>
                        <div className="sec">可回收料头核对 ({currentRecoveryCands.length})</div>
                        <table className="t" style={{ border: 0 }}>
                          <thead>
                            <tr>
                              <th>回收</th>
                              <th>来源</th>
                              <th>上限尺寸 mm</th>
                              <th className="r">实测宽 mm</th>
                              <th className="r">实测长 mm</th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentRecoveryCands.map((c: any) => {
                              const m = reportDraft.draft.rem[c.id] || {
                                use: false,
                                w: c.w,
                                l: c.l
                              };
                              return (
                                <tr key={c.id}>
                                  <td>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(m.use)}
                                      onChange={(e) =>
                                        setReportDraft((r) =>
                                          r
                                            ? {
                                                ...r,
                                                draft: {
                                                  ...r.draft,
                                                  rem: {
                                                    ...r.draft.rem,
                                                    [c.id]: {
                                                      ...m,
                                                      use: e.target.checked
                                                    }
                                                  }
                                                }
                                              }
                                            : null
                                        )
                                      }
                                    />
                                  </td>
                                  <td>
                                    {c.source}{' '}
                                    {c.hasDefect && <span className="tag warn">带疵</span>}
                                  </td>
                                  <td className="num">
                                    ≤ {fmtN(c.w)}×{fmtN(c.l)}
                                  </td>
                                  <td className="r">
                                    <input
                                      type="number"
                                      className="field num"
                                      style={{ width: 80, height: 22, textAlign: 'right' }}
                                      disabled={!m.use}
                                      value={m.w}
                                      onChange={(e) =>
                                        setReportDraft((r) =>
                                          r
                                            ? {
                                                ...r,
                                                draft: {
                                                  ...r.draft,
                                                  rem: {
                                                    ...r.draft.rem,
                                                    [c.id]: {
                                                      ...m,
                                                      w: Number(e.target.value)
                                                    }
                                                  }
                                                }
                                              }
                                            : null
                                        )
                                      }
                                    />
                                  </td>
                                  <td className="r">
                                    <input
                                      type="number"
                                      className="field num"
                                      style={{ width: 80, height: 22, textAlign: 'right' }}
                                      disabled={!m.use}
                                      value={m.l}
                                      onChange={(e) =>
                                        setReportDraft((r) =>
                                          r
                                            ? {
                                                ...r,
                                                draft: {
                                                  ...r.draft,
                                                  rem: {
                                                    ...r.draft.rem,
                                                    [c.id]: {
                                                      ...m,
                                                      l: Number(e.target.value)
                                                    }
                                                  }
                                                }
                                              }
                                            : null
                                        )
                                      }
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </>
                    )}

                    {currentReportProblems.length > 0 && (
                      <div className="notice">
                        {currentReportProblems.map((msg: string, i: number) => (
                          <div key={i}>{msg}</div>
                        ))}
                      </div>
                    )}

                    <div className="foot">
                      <span className="muted">
                        提交后将正式扣减对应材料可用量并登记良品产出与回收料头
                      </span>
                      <span className="sp" />
                      <button
                        type="button"
                        className="btn pri"
                        disabled={busy || currentReportProblems.length > 0}
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
