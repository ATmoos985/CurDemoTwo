import React, { useEffect, useMemo, useState } from 'react';
import { useStudioStore, SlittingSchemeRun } from '../store/useStudioStore';
import { OptimizationSession } from '@static/js/business/optimization/job-client.js';
import { independentBaseline, planSummary } from '@static/js/linear/linear-model.js';
import { carStart, assignCar, patternStrips } from '@static/app/js/model/slitting.js';
import { requestJSON, toast, fmtN, loadSheetLib } from '@static/app/js/util.js';

const STRIP_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4f46e5'];

function SlittingStripBar({
  motherWidthMm,
  leftTrimMm,
  rightTrimMm,
  stations
}: {
  motherWidthMm: number;
  leftTrimMm: number;
  rightTrimMm: number;
  stations: { widthMm: number; countPerRepetition: number }[];
}) {
  const strips = stations.flatMap((s) => Array(s.countPerRepetition).fill(s.widthMm));
  const usedWidth = strips.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, motherWidthMm - leftTrimMm - rightTrimMm - usedWidth);

  return (
    <div className="slit-bar-wrap" title={`总幅宽 ${motherWidthMm}mm · 已用 ${usedWidth}mm · 余宽 ${spare}mm`}>
      {leftTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(leftTrimMm / motherWidthMm) * 100}%` }}
        >
          {leftTrimMm >= 60 ? `${leftTrimMm}` : ''}
        </div>
      )}
      {strips.map((w, idx) => (
        <div
          key={idx}
          className="slit-seg"
          style={{
            width: `${(w / motherWidthMm) * 100}%`,
            backgroundColor: STRIP_COLORS[w % STRIP_COLORS.length]
          }}
        >
          <span>{w}</span>
        </div>
      ))}
      {spare > 0 && (
        <div
          className="slit-seg slit-spare"
          style={{ width: `${(spare / motherWidthMm) * 100}%` }}
        >
          {spare >= 80 ? `余 ${spare}` : ''}
        </div>
      )}
      {rightTrimMm > 0 && (
        <div
          className="slit-seg slit-trim"
          style={{ width: `${(rightTrimMm / motherWidthMm) * 100}%` }}
        >
          {rightTrimMm >= 60 ? `${rightTrimMm}` : ''}
        </div>
      )}
    </div>
  );
}

export const SlittingStudio1DPage: React.FC = () => {
  const {
    clusters,
    loadClusterInto1D,
    slitMotherWidthMm,
    slitLeftTrimMm,
    slitRightTrimMm,
    slitMinWidthMm,
    slitMaxWidthMm,
    slitWidthStepMm,
    slitOverCap,
    slitFixedLengthMm,
    slitAvoidDefects,
    slitRollId,
    slitOrders,
    slitSchemes,
    activeSlitSchemeId,
    setSlitSpec,
    updateSlitOrder,
    addSlitOrder,
    removeSlitOrder,
    setSlitSchemes,
    setActiveSlitScheme,
    markSlitSchemeDispatched
  } = useStudioStore();

  const [rolls, setRolls] = useState<any[]>([]);
  const [solving, setSolving] = useState(false);
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    requestJSON('/api/rolls').then((r) => setRolls(r || [])).catch(() => {});
  }, []);

  const clusters1D = clusters.filter((c) => c.dimension === '1D');
  const activeScheme = useMemo(
    () => slitSchemes.find((s) => s.id === activeSlitSchemeId) || slitSchemes[0] || null,
    [slitSchemes, activeSlitSchemeId]
  );

  const selectedDefectRoll = useMemo(
    () => (slitAvoidDefects ? rolls.find((r) => r.rollId === slitRollId) || rolls[0] || null : null),
    [slitAvoidDefects, rolls, slitRollId]
  );

  // Optional longitudinal defect intervals only computed when user explicitly toggles slitAvoidDefects
  const defectSchedules = useMemo(() => {
    if (!slitAvoidDefects || !selectedDefectRoll || !activeScheme?.patterns?.length) return [];
    const open = slitOrders.map((o) => ({
      id: o.id,
      name: o.name,
      width: o.widthMm,
      length: slitFixedLengthMm,
      demand: o.quantity
    }));
    const list: { carNo: number; startY: number; endY: number; comp: string; avoidedDefects: number }[] = [];
    let cursor = selectedDefectRoll.usedLength || 0;
    let carNo = 1;
    for (const pat of activeScheme.patterns) {
      for (let r = 0; r < pat.repetitions && carNo <= 30; r++) {
        const assigned = assignCar(
          { ...pat, lengthMm: slitFixedLengthMm },
          open,
          slitLeftTrimMm
        );
        const y0 = carStart(selectedDefectRoll, cursor, slitFixedLengthMm, assigned.strips, []);
        if (y0 == null) break;
        const skippedLen = y0 > cursor ? 1 : 0;
        list.push({
          carNo: carNo++,
          startY: y0,
          endY: y0 + slitFixedLengthMm,
          comp: pat.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
          avoidedDefects: skippedLen
        });
        for (const st of assigned.strips) {
          const d = open.find((x) => x.id === st.demandId);
          if (d && d.demand > 0) d.demand--;
        }
        cursor = y0 + slitFixedLengthMm;
        void patternStrips;
      }
    }
    return list;
  }, [slitAvoidDefects, selectedDefectRoll, activeScheme, slitOrders, slitFixedLengthMm, slitLeftTrimMm]);

  const handleSolveParallel1D = async () => {
    if (solving) return;
    if (!slitOrders.length) {
      toast('请先添加至少一项分切规格', true);
      return;
    }
    setSolving(true);
    try {
      // 1. Instant local Independent Baseline (1 order width repeated without multi-order nesting)
      const baselineInput = {
        motherWidth: slitMotherWidthMm,
        leftTrim: slitLeftTrimMm,
        rightTrim: slitRightTrimMm,
        orderItems: slitOrders.map((o) => ({
          width: o.widthMm,
          length: slitFixedLengthMm,
          quantity: o.quantity,
          surfaceTreatment: '默认'
        }))
      };
      const baseGroups = independentBaseline(baselineInput);
      const baseSummary = planSummary(baseGroups, baselineInput);
      const baselineRun: SlittingSchemeRun = {
        id: 'SLIT-BASELINE',
        strategyId: 'BASELINE',
        strategyName: '逐规格独立分切（传统人工对照）',
        state: 'SUCCEEDED',
        motherWidthMm: slitMotherWidthMm,
        leftTrimMm: slitLeftTrimMm,
        rightTrimMm: slitRightTrimMm,
        totalCars: baseSummary.rolls,
        missingRolls: baseSummary.shortage || 0,
        overproducedRolls: baseSummary.surplus || 0,
        avgUtilizationPct: Number((baseSummary.rate || 0).toFixed(2)),
        elapsedMs: 1,
        patterns: baseGroups.map((g: any, i: number) => {
          const widthCounts = new Map<number, number>();
          for (const w of g.comboExpanded || []) {
            const nw = Number(w);
            widthCounts.set(nw, (widthCounts.get(nw) || 0) + 1);
          }
          const stations = Array.from(widthCounts.entries()).map(([widthMm, countPerRepetition]) => ({
            widthMm,
            countPerRepetition
          }));
          const usedW = stations.reduce((s, it) => s + it.widthMm * it.countPerRepetition, 0);
          return {
            id: `BASE-${i + 1}`,
            lengthMm: g.length || slitFixedLengthMm,
            repetitions: g.usageCount || 1,
            stations,
            usedWidthMm: usedW,
            spareWidthMm: Math.max(0, slitMotherWidthMm - slitLeftTrimMm - slitRightTrimMm - usedW)
          };
        }),
        fulfillment: slitOrders.map((o) => ({
          orderId: o.id,
          name: o.name,
          widthMm: o.widthMm,
          requested: o.quantity,
          produced: o.quantity,
          missing: 0,
          overproduced: 0
        }))
      };

      // Show baseline immediately while FAST & QUALITY run in parallel on backend thread pool
      const pendingFast: SlittingSchemeRun = {
        id: 'SLIT-FAST',
        strategyId: 'FAST',
        strategyName: 'OR-Tools 多订单搭切 · 快速方案 (FAST)',
        state: 'RUNNING',
        motherWidthMm: slitMotherWidthMm,
        leftTrimMm: slitLeftTrimMm,
        rightTrimMm: slitRightTrimMm,
        totalCars: 0,
        missingRolls: 0,
        overproducedRolls: 0,
        avgUtilizationPct: 0,
        patterns: [],
        fulfillment: []
      };
      const pendingQuality: SlittingSchemeRun = {
        ...pendingFast,
        id: 'SLIT-QUALITY',
        strategyId: 'QUALITY',
        strategyName: 'OR-Tools 多订单搭切 · 精细优化 (QUALITY)'
      };
      setSlitSchemes([pendingFast, pendingQuality, baselineRun]);

      const runProfile = async (profile: 'FAST' | 'QUALITY'): Promise<SlittingSchemeRun> => {
        const session = new OptimizationSession();
        const t0 = performance.now();
        const req = {
          schemaVersion: '2.0',
          clientRequestId: `slit-${profile}-${Date.now()}`,
          problemType: 'SLITTING_1D',
          allowFallback: false,
          requireComplete: false,
          problem: {
            schemaVersion: '1',
            unit: 'mm',
            motherWidthMm: Math.floor(slitMotherWidthMm),
            leftTrimMm: Math.floor(slitLeftTrimMm),
            rightTrimMm: Math.floor(slitRightTrimMm),
            minWidthMm: Math.floor(slitMinWidthMm),
            maxWidthMm: Math.floor(slitMaxWidthMm),
            widthStepMm: Math.floor(slitWidthStepMm),
            totalOverCap: Math.floor(slitOverCap),
            profile,
            timeLimitSeconds: profile === 'QUALITY' ? 12 : 5,
            orders: slitOrders.map((o) => ({
              id: o.id,
              widthMm: Math.floor(o.widthMm),
              lengthMm: Math.floor(slitFixedLengthMm),
              quantity: Math.floor(o.quantity),
              surfaceTreatment: '默认'
            }))
          }
        };
        try {
          const { result } = await session.solve(req);
          const s = result.slitting;
          const utilMetric = result.metrics?.find((m: any) => m.name === 'motherAreaUtilization')?.value || 0;
          const totalCars = s.patterns.reduce((n: number, p: any) => n + p.repetitions, 0);
          const missingRolls = s.fulfillment.reduce((n: number, f: any) => n + f.missing, 0);
          const overproducedRolls = s.fulfillment.reduce((n: number, f: any) => n + f.overproduced, 0);

          return {
            id: `SLIT-${profile}`,
            strategyId: profile,
            strategyName:
              profile === 'FAST'
                ? 'OR-Tools 多订单搭切 · 快速方案 (FAST)'
                : 'OR-Tools 多订单搭切 · 精细优化 (QUALITY)',
            state: 'SUCCEEDED',
            motherWidthMm: slitMotherWidthMm,
            leftTrimMm: slitLeftTrimMm,
            rightTrimMm: slitRightTrimMm,
            totalCars,
            missingRolls,
            overproducedRolls,
            avgUtilizationPct: Number(utilMetric.toFixed(2)),
            elapsedMs: Math.round(performance.now() - t0),
            patterns: s.patterns.map((p: any) => ({
              id: p.id,
              lengthMm: p.lengthMm,
              repetitions: p.repetitions,
              stations: p.stations,
              usedWidthMm: p.patternWidthMm,
              spareWidthMm: Math.max(0, slitMotherWidthMm - slitLeftTrimMm - slitRightTrimMm - p.patternWidthMm),
              allocations: p.allocations
            })),
            fulfillment: s.fulfillment.map((f: any) => {
              const ord = slitOrders.find((o) => o.id === String(f.orderId));
              return {
                orderId: String(f.orderId),
                name: ord?.name || f.orderId,
                widthMm: ord?.widthMm || 0,
                requested: f.requested,
                produced: f.produced,
                missing: f.missing,
                overproduced: f.overproduced
              };
            }),
            rawResult: result
          };
        } catch (e: any) {
          return {
            ...pendingFast,
            id: `SLIT-${profile}`,
            strategyId: profile,
            strategyName: `OR-Tools (${profile}) - ${e.message}`,
            state: 'FAILED'
          };
        }
      };

      const [fastRes, qualityRes] = await Promise.all([runProfile('FAST'), runProfile('QUALITY')]);
      setSlitSchemes([qualityRes, fastRes, baselineRun]);
      toast(
        `一维并发优化完成：精细方案 ${qualityRes.totalCars} 车（较独立分切节省 ${Math.max(
          0,
          baselineRun.totalCars - qualityRes.totalCars
        )} 车）`
      );
    } catch (e: any) {
      toast('一维分切求解失败：' + e.message, true);
    } finally {
      setSolving(false);
    }
  };

  const handleExportExcel = async () => {
    if (!activeScheme?.patterns.length) return;
    try {
      const XLSX = await loadSheetLib();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['组合编号', '卷长 mm', '分切组合', '已用宽 mm', '余宽 mm', '计划车数'],
          ...activeScheme.patterns.map((p, i) => [
            i + 1,
            p.lengthMm,
            p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + '),
            p.usedWidthMm,
            p.spareWidthMm,
            p.repetitions
          ])
        ]),
        '分切组合方案'
      );
      XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([
          ['规格名称', '条宽 mm', '需求卷数', '计划产出', '缺口', '超产'],
          ...activeScheme.fulfillment.map((f) => [
            f.name,
            f.widthMm,
            f.requested,
            f.produced,
            f.missing,
            f.overproduced
          ])
        ]),
        '订单履约对比'
      );
      XLSX.writeFile(book, `一维分切方案-${activeScheme.strategyId}-${slitMotherWidthMm}mm.xlsx`);
    } catch (e: any) {
      toast('导出 Excel 失败：' + e.message, true);
    }
  };

  const handleDispatch1D = async () => {
    if (!activeScheme || dispatching) return;
    if (activeScheme.dispatchedTaskId) {
      location.hash = `#/execution/${encodeURIComponent(activeScheme.dispatchedTaskId)}`;
      return;
    }
    setDispatching(true);
    try {
      const task = await requestJSON('/api/cutting/tasks', {
        revision: 0,
        name: `一维分切移交 · ${activeScheme.strategyName.split('·')[1] || activeScheme.strategyId} (${slitMotherWidthMm}mm)`,
        problemType: 'SLITTING_1D',
        materialModel: `SLIT-${slitMotherWidthMm}`,
        externalRef: `定长 ${slitFixedLengthMm}mm · ${activeScheme.totalCars}车 · 利用率 ${activeScheme.avgUtilizationPct}%`,
        process: {
          bedLength: slitFixedLengthMm,
          trimStart: 0,
          pieceGap: 0,
          cutOrigin: 'left-top',
          firstStageOrientation: 'vertical',
          allowRotation: false,
          allowLongitudinal: true
        },
        slitting: {
          leftTrim: slitLeftTrimMm,
          rightTrim: slitRightTrimMm,
          minWidth: slitMinWidthMm,
          maxWidth: slitMaxWidthMm,
          widthStep: slitWidthStepMm,
          totalOverCap: slitOverCap
        },
        demands: slitOrders.map((o, idx) => ({
          id: idx + 1,
          name: o.name,
          width: o.widthMm,
          length: slitFixedLengthMm,
          quantity: o.quantity,
          allowRotation: false
        }))
      });
      markSlitSchemeDispatched(activeScheme.id, task.id);
      toast(`一维分切方案已建立生产单并移交！`);
      location.hash = `#/execution/${encodeURIComponent(task.id)}`;
    } catch (e: any) {
      toast('移交失败：' + e.message, true);
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="react-page">
      <div className="ph">
        <h1>一维定长分切台</h1>
        <span className="crumb">聚焦条宽组合、车数、余宽与超产对比 · 无需浏览整卷画布，仅在需要避让疵点时可选关联实卷</span>
        <span className="sp" />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={slitAvoidDefects}
            onChange={(e) => setSlitSpec({ slitAvoidDefects: e.target.checked })}
          />
          规避实卷纵向疵点
        </label>
        <button
          type="button"
          className="btn pri"
          disabled={solving}
          onClick={handleSolveParallel1D}
        >
          {solving ? '⚡ 三策略并行计算中…' : '⚡ 并行计算分切方案（独立 vs 快速 vs 精细）'}
        </button>
      </div>

      <div className="studio-split" style={{ gridTemplateColumns: '320px minmax(0, 1fr)' }}>
        {/* Left: 1D Parameters & Cluster / Order Specs */}
        <section className="pane">
          <div className="pane-h">
            母卷规格与分条订单
            <span className="sp" />
            <select
              className="field"
              style={{ height: 24, fontSize: 11.5, maxWidth: 160 }}
              onChange={(e) => e.target.value && loadClusterInto1D(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>
                从分条簇载入…
              </option>
              {clusters1D.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="pane-b">
            <div className="form" style={{ gridTemplateColumns: '100px 1fr', gap: '6px 10px' }}>
              <label>母卷幅宽 mm</label>
              <input
                type="number"
                className="field num"
                value={slitMotherWidthMm}
                onChange={(e) => setSlitSpec({ slitMotherWidthMm: Number(e.target.value) })}
              />
              <label>固定卷长 mm</label>
              <input
                type="number"
                className="field num"
                value={slitFixedLengthMm}
                onChange={(e) => setSlitSpec({ slitFixedLengthMm: Number(e.target.value) })}
              />
              <label>左右切边 mm</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="number"
                  className="field num"
                  style={{ width: '50%' }}
                  value={slitLeftTrimMm}
                  onChange={(e) => setSlitSpec({ slitLeftTrimMm: Number(e.target.value) })}
                />
                <input
                  type="number"
                  className="field num"
                  style={{ width: '50%' }}
                  value={slitRightTrimMm}
                  onChange={(e) => setSlitSpec({ slitRightTrimMm: Number(e.target.value) })}
                />
              </div>
              <label>组合宽范围</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="number"
                  className="field num"
                  style={{ width: '46%' }}
                  value={slitMinWidthMm}
                  onChange={(e) => setSlitSpec({ slitMinWidthMm: Number(e.target.value) })}
                />
                <span>–</span>
                <input
                  type="number"
                  className="field num"
                  style={{ width: '46%' }}
                  value={slitMaxWidthMm}
                  onChange={(e) => setSlitSpec({ slitMaxWidthMm: Number(e.target.value) })}
                />
              </div>
              <label>超产上限 (卷)</label>
              <input
                type="number"
                className="field num"
                value={slitOverCap}
                onChange={(e) => setSlitSpec({ slitOverCap: Number(e.target.value) })}
              />
            </div>

            {slitAvoidDefects && (
              <div className="notice" style={{ margin: '4px 12px 8px' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>纵向疵点避让参考卷（仅在开启避疵时显示）</div>
                <select
                  className="field"
                  style={{ width: '100%' }}
                  value={slitRollId || rolls[0]?.rollId || ''}
                  onChange={(e) => setSlitSpec({ slitRollId: e.target.value })}
                >
                  {rolls.map((r) => (
                    <option key={r.rollId} value={r.rollId}>
                      {r.rollId} ({r.width}mm · 疵点{(r.defects || []).length}处)
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="sec" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>订单条宽明细 ({slitOrders.length})</span>
              <button type="button" className="btn sm" onClick={addSlitOrder}>
                ＋ 新增条宽
              </button>
            </div>
            <table className="t dock-table" style={{ border: 0 }}>
              <thead>
                <tr>
                  <th>名称</th>
                  <th className="r">条宽 mm</th>
                  <th className="r">卷数</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {slitOrders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <input
                        className="field"
                        style={{ width: '100%', height: 22 }}
                        value={o.name}
                        onChange={(e) => updateSlitOrder(o.id, { name: e.target.value })}
                      />
                    </td>
                    <td className="r">
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 62, height: 22, textAlign: 'right' }}
                        value={o.widthMm}
                        onChange={(e) => updateSlitOrder(o.id, { widthMm: Number(e.target.value) })}
                      />
                    </td>
                    <td className="r">
                      <input
                        type="number"
                        className="field num"
                        style={{ width: 52, height: 22, textAlign: 'right' }}
                        value={o.quantity}
                        onChange={(e) => updateSlitOrder(o.id, { quantity: Number(e.target.value) })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn sm"
                        style={{ height: 20, padding: '0 5px' }}
                        onClick={() => removeSlitOrder(o.id)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Right: Multi-Strategy 1D Comparison + Visual Strip Composition Bars */}
        <section className="pane" style={{ background: 'var(--bg)' }}>
          <div className="body">
            {slitSchemes.length === 0 ? (
              <div className="box" style={{ padding: 36, textAlign: 'center' }}>
                <strong style={{ fontSize: 16 }}>一维分切组合方案工作区</strong>
                <p className="muted" style={{ maxWidth: 520, margin: '10px auto 18px' }}>
                  一维场景默认固定卷长（当前 <b className="num">{slitFixedLengthMm} mm</b>），重点直接给出不同求解策略的多条宽搭切组合、余宽与超产对比。无需先选库存母卷或展示二维全卷画布。
                </p>
                <button type="button" className="btn pri" onClick={handleSolveParallel1D}>
                  ⚡ 立即并行计算一维搭切方案
                </button>
              </div>
            ) : (
              <>
                {/* 3-Strategy Comparison Cards */}
                <div className="cards" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                  {slitSchemes.map((s) => (
                    <div
                      key={s.id}
                      className={`card slit-scheme-card ${activeScheme?.id === s.id ? 'on' : ''}`}
                      onClick={() => setActiveSlitScheme(s.id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <small style={{ flex: 1, fontWeight: 600, color: 'var(--text)' }}>
                          {s.strategyName}
                        </small>
                        <span className={`tag ${s.state === 'SUCCEEDED' ? 'ok' : s.state === 'RUNNING' ? 'run' : 'err'}`}>
                          {s.state === 'SUCCEEDED' ? `${s.elapsedMs}ms` : s.state}
                        </span>
                      </div>
                      <b className="num">
                        {s.state === 'RUNNING' ? '…' : `${s.totalCars} 车`}
                      </b>
                      <div className="d num">
                        利用率 {s.avgUtilizationPct}% · 缺口 {s.missingRolls} · 超产 {s.overproducedRolls}
                      </div>
                    </div>
                  ))}
                </div>

                {activeScheme && activeScheme.state === 'SUCCEEDED' && (
                  <div className="split" style={{ gridTemplateColumns: '1.6fr 1fr', gap: 12, flex: 'none' }}>
                    <div className="box" style={{ margin: 0 }}>
                      <div className="pane-h">
                        刀组排布示意图（共 {activeScheme.patterns.length} 组 · 合计 {activeScheme.totalCars} 车）
                        <span className="sp" />
                        <button type="button" className="btn sm" onClick={handleExportExcel}>
                          导出分切方案 Excel
                        </button>
                        <button
                          type="button"
                          className="btn sm pri"
                          disabled={dispatching}
                          onClick={handleDispatch1D}
                        >
                          {activeScheme.dispatchedTaskId ? '✓ 已移交（去执行单）' : '选此方案 → 拿出去报工 ↗'}
                        </button>
                      </div>
                      <div className="slit-patterns-list">
                        {activeScheme.patterns.map((p, idx) => (
                          <div key={p.id} className="slit-pattern-row">
                            <div className="slit-pattern-meta">
                              <span className="tag kind">组 {idx + 1}</span>
                              <b className="num">{p.repetitions} 车</b>
                              <span className="num">
                                组合：{p.stations.map((s) => `${s.widthMm}×${s.countPerRepetition}`).join(' + ')}
                              </span>
                              <span className="sp" />
                              <span className="num muted">
                                已切 {p.usedWidthMm} mm · 余宽 {p.spareWidthMm} mm
                              </span>
                            </div>
                            <SlittingStripBar
                              motherWidthMm={activeScheme.motherWidthMm}
                              leftTrimMm={activeScheme.leftTrimMm}
                              rightTrimMm={activeScheme.rightTrimMm}
                              stations={p.stations}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="box" style={{ margin: 0 }}>
                      <div className="pane-h">各订单履约与超产核对</div>
                      <table className="t" style={{ border: 0 }}>
                        <thead>
                          <tr>
                            <th>规格</th>
                            <th className="r">宽</th>
                            <th className="r">需</th>
                            <th className="r">产</th>
                            <th className="r">超/缺</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeScheme.fulfillment.map((f) => (
                            <tr key={f.orderId}>
                              <td>{f.name}</td>
                              <td className="r num">{fmtN(f.widthMm)}</td>
                              <td className="r num">{f.requested}</td>
                              <td className="r num">{f.produced}</td>
                              <td className="r num">
                                {f.missing > 0 ? (
                                  <span className="tag err">缺 {f.missing}</span>
                                ) : f.overproduced > 0 ? (
                                  <span className="tag warn">+{f.overproduced}</span>
                                ) : (
                                  <span className="tag ok">齐</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {slitAvoidDefects && defectSchedules.length > 0 && (
                        <>
                          <div className="sec">
                            关联实卷 {selectedDefectRoll?.rollId} 纵向避疵排车预览
                          </div>
                          <table className="t" style={{ border: 0 }}>
                            <thead>
                              <tr>
                                <th>车次</th>
                                <th className="r">Y 区间 (m)</th>
                                <th>组合</th>
                              </tr>
                            </thead>
                            <tbody>
                              {defectSchedules.slice(0, 12).map((c) => (
                                <tr key={c.carNo}>
                                  <td className="num">#{c.carNo}</td>
                                  <td className="r num">
                                    {(c.startY / 1000).toFixed(2)}–{(c.endY / 1000).toFixed(2)}m
                                  </td>
                                  <td className="num">{c.comp}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
