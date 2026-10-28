// 排料工作台：读取任务、方案、报工与母卷档案，交给画布与导航条渲染。
// 本页选料、计算、执行、报工与复检；画布只展示场景并发出操作意图。
import {requestJSON, esc, fmtM, fmtN, shortId, errorBox, toast, loadPrefs, savePrefs, dismissOnOutside, solverSettings, loadSheetLib} from '../util.js';
import {setStatus} from '../main.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {createRollNavigator} from '../canvas/roll-navigator.js';
import {parseRatio, formatRatio} from '../canvas/camera.js';
import {buildRollScene, rollsOfPlans, sceneMetrics, demandColors, demandIndex, STATUS_TEXT, NEW_STATION, remnantAsRoll, OUTPUT_STYLES} from '../model/roll-scene.js';
import {buildSolveRequest, windowProblem, usablePlan, remainingDemands} from '../model/solve-request.js';
import {taskLabels, taskLink} from '../../../js/business/cutting/task-list-model.js';
import {validateDefect, round} from '../../../js/inspection/inspection-model.js';
import {findForwardPlan} from '../../../js/business/cutting/forward-search.js';
import {OUTCOMES, defaultReport, applyBulk, recoveryCandidates, reportSummary, reportProblems, buildCutReport} from '../model/report.js';
import {reviewablePieces, effectivePieceResults, DISPOSITIONS, emptyQualityForm, qualityProblems, buildQualityCommand, receiptSummary} from '../model/quality.js';
import {executionWriter, executionForPlan, executionLabels} from '../../../js/business/cutting/execution-client.js';
import {camData, localHome, worldHome, initialPositions, movePiece, rotatePiece, rotationAllowed, placementProblem, changedPieces, adjustPayload, applyPositions, sizeOf} from '../model/plan-tools.js';
import {gcodeText, dxfText} from '../../../js/plugins/export/cam-format.js';
import {createPlanHistory} from '../../../js/business/cutting/plan-editing.js';
import {ticketModel, ticketHTML} from '../../../js/plugins/export/cut-ticket-model.js';
import {OptimizationSession} from '../../../js/business/optimization/job-client.js';
import {isSlitting, openDemands, slittingJob, assignCar, usefulCars, carStart, carRequest, patternRows, compositionText, spareWidth} from '../model/slitting.js';

const EXEC_TAG = {DRAFT: '', RELEASED: 'run', RUNNING: 'run', EXPIRED: 'warn', CANCELLED: '', REPORTED: 'ok', REVERSED: 'err'};

const REPORT_KEY = id => 'cutplan.app.report.' + id;
const SLIT_KEY = id => 'cutplan.app.slit.' + id;
const OUTCOME_COLOR = {REJECTED: '#c0392b', UNCUT: '#59616a'};

const STAGES = ['需求', '材料', '排料', '执行', '报工'];
const STAGE_OF = {PLAN_PENDING: 2, EXECUTION_PENDING: 3, REPORT_PENDING: 4, ATTENTION: 4, COMPLETED: 5};
const TAG = {PLAN_PENDING: 'idle', EXECUTION_PENDING: 'run', REPORT_PENDING: 'warn', ATTENTION: 'err', COMPLETED: 'ok'};
const SEG_TAG = {cut: 'ok', pending: 'warn', stale: '', other: ''};

export async function mount(el, [taskId, focusPlan]) {
    if (!taskId) return pickTask(el);
    let detail, plans, summary, views = [], allRolls, roll = null, checks = {};
    const writer = executionWriter();
    async function loadTask() {
        [detail, plans, summary, views] = await Promise.all([
            requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId)),
            requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId) + '/plans'),
            requestJSON('/api/cutting/task-summaries').then(rows => rows.find(r => r.task.id === taskId) || null),
            requestJSON('/api/v2/execution-orders?taskId=' + encodeURIComponent(taskId)),
            requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId) + '/plan-checks').then(r => { checks = r || {}; }).catch(() => { checks = {}; })
        ]);
    }
    let allRemnants = [];
    let occupied = new Map(); // 材料编号 → 其他任务正在预约/执行的执行单
    const loadStocks = () => Promise.all([requestJSON('/api/rolls').then(r => { allRolls = r; }), requestJSON('/api/remnants').then(r => { allRemnants = r; }),
        requestJSON('/api/v2/execution-orders').then(r => { occupied = new Map((r.items || r).filter(v => v.reservationActive && v.execution.taskId !== taskId).map(v => [v.execution.materialId, v])); }).catch(() => {})]);
    const occupiedText = id => { const v = occupied.get(id); return v ? `被其他任务的执行单 ${shortId(v.execution.id)}（${executionLabels[v.effectiveState] || v.effectiveState}）占用` : ''; };
    try { await Promise.all([loadTask(), loadStocks()]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    let task = detail.task, names = demandIndex(task.demands, plans);
    const prefs = loadPrefs();
    const focus = focusPlan && plans.find(p => p.id === focusPlan);
    const focusRemnant = focus?.request?.sourceRemnantId || null;
    // st.source：'roll' 母卷连续投料 / 'remnant' 料头整块投料；st.rollId 存对应编号
    const st = {source: focusRemnant ? 'remnant' : 'roll', rollId: focusRemnant || focus?.request?.rollId || rollsOfPlans(plans)[0] || null,
        selectedId: focus ? focus.id : null, window: null, fresh: [], tool: 'pan', view: focus ? 'station' : prefs.view,
        pop: null, cursor: null, saving: false, busy: '', failure: null, quality: null, station: '1', reserveMin: 30, recommend: null};
    let canvas = null, nav = null, undismiss = null;

    /** 可选母卷：任务方案用过的母卷 + 同型号且有余量的母卷。 */
    const rollChoices = () => {
        const used = rollsOfPlans(plans);
        const same = allRolls.filter(r => r.rollModel === task.materialModel && (r.currentRemainingLength ?? r.totalLength - r.usedLength) > 0).map(r => r.rollId);
        return [...new Set([...used, ...same])];
    };
    async function loadRoll() {
        roll = null;
        if (!st.rollId) return;
        try {
            if (st.source === 'remnant') {
                allRemnants = await requestJSON('/api/remnants');
                const stock = allRemnants.find(r => r.id === st.rollId);
                roll = stock ? remnantAsRoll(stock) : null;
                if (!stock) toast('料头已不在库存中', true);
            } else roll = await requestJSON('/api/rolls/' + encodeURIComponent(st.rollId));
        } catch (e) { toast('材料档案读取失败：' + e.message, true); }
    }
    /** 同型号可投料料头：在库可用、批次型号一致。 */
    const remnantChoices = () => allRemnants.filter(r => r.status === 'AVAILABLE' && r.materialBatch === task.materialModel);
    async function reload() {
        await Promise.all([loadTask(), loadRoll(), loadStocks()]);
        task = detail.task; names = demandIndex(task.demands, plans);
    }
    await loadRoll();

    const scene = () => {
        const sc = buildRollScene({roll, plans, reports: detail.reports, rollId: st.rollId, demands: task.demands,
            process: task.process, freshDefects: st.fresh, selectedId: st.selectedId, window: st.window});
        sc.window.readOnly = !!(st.adjust || st.busy);
        // 刀路图层原点；手动调整中用草稿位置替换当前段的件
        for (const s of sc.segments) { const p = planOf(s.id); if (p) s.home = worldHome(p, s.start); if (s.status === 'pending' && checks[s.id]) s.invalid = checks[s.id]; }
        if (st.adjust) {
            const i = sc.segments.findIndex(s => s.id === st.adjust.planId);
            if (i >= 0) {
                sc.segments[i] = applyPositions(sc.segments[i], planOf(st.adjust.planId), st.adjust.positions);
                sc.window = {...sc.window, start: sc.segments[i].start, len: sc.segments[i].len};
            }
            sc.selectedPiece = st.adjust.selected;
            const problem = st.adjust.problem;
            if (i >= 0 && problem?.subject) sc.diagnostics = [{message: problem.message,
                shapes: [problem.subject, ...problem.related].map(p => ({u: sc.segments[i].start + p.y, v: p.x, du: p.l, dv: p.w, shape: p.shape}))}];
        }
        // 报工中：画布按逐件结果着色（异常红、未切灰）
        const seg = st.report && sc.segments.find(s => s.id === st.report.planId);
        if (seg) seg.pieces = seg.pieces.map(p => {
            const o = st.report.rows[p.id]?.outcome;
            return {...p, color: OUTCOME_COLOR[o] || p.color, label: `草稿${OUTCOMES[o] || ''} · ${p.label}`};
        });
        return sc;
    };
    const remaining = () => remainingDemands(task, detail.completed, detail.reserved);
    const planOf = id => plans.find(p => p.id === id);

    /** keepCamera：重绘外壳但保留画布视角（拖动工位结束、切换右栏等）。 */
    function shell(keepCamera = false) {
        const savedCam = keepCamera ? canvas?.getCamera() : null;
        const sc = st.rollId && roll ? scene() : null, met = sc ? sceneMetrics(sc) : null;
        const seg = sc?.segments.find(s => s.id === sc.currentId) || null;
        if (st.report && (seg?.id !== st.report.planId || seg?.status !== 'pending')) st.report = null; // 选中别的段时关闭报工
        if (st.quality && seg?.id !== st.quality.report.planId && !st.quality.uncertain) st.quality = null;
        if (st.adjust && seg?.id !== st.adjust.planId) { st.adjust = null; st.tool = 'pan'; }
        if (st.toolpath && seg?.id !== st.toolpath.planId) st.toolpath = null;
        const order = sc ? [...sc.segments.map(s => s.id), NEW_STATION] : [], idx = sc ? (seg ? order.indexOf(seg.id) : order.length - 1) : -1;
        const total = summary?.total ?? task.demands.reduce((a, d) => a + d.quantity, 0), done = summary?.completed ?? 0;
        const stage = STAGE_OF[summary?.status] ?? (st.rollId ? 2 : 1);
        const colors = demandColors(task.demands, plans);
        el.innerHTML = `
        <div class="wb-head"><h1>${esc(task.name)}</h1><span class="num muted">${shortId(task.id)}</span>
          <span class="tag kind">${isSlitting(task) ? '一维分切' : '二维'} · ${esc(task.materialModel || '—')}</span>
          ${summary ? `<span class="tag ${TAG[summary.status] || ''}">${esc(taskLabels[summary.status] || summary.status)}</span>` : ''}
          <span class="sp"></span><div class="sum" id="sum">${sumHtml(sc, colors)}</div>
          <span class="vsep"></span><a class="btn" href="#/tasks">返回任务</a>${summary && !isSlitting(task) ? `<a class="btn" href="${esc(taskLink(summary))}">经典工作台 ↗</a>` : ''}</div>
        <div class="stages">${STAGES.map((s, i) => `<div class="stage ${i < stage ? 'done' : i === stage ? 'on' : ''}"><span class="n">${i < stage ? '✓' : i + 1}</span>${s}</div>`).join('')}</div>
        ${!sc ? pickRollHtml() : `
        <div class="split" style="grid-template-columns:1fr ${st.report ? '420px' : st.quality || st.adjust ? '340px' : prefs.sideCollapsed ? '28px' : '300px'}">
          <section class="pane" style="background:var(--canvas)">
            <div class="ctool">
              <div class="vseg"><button data-view="station" class="${st.view === 'station' ? 'on' : ''}" title="对准当前工位">工位</button><button data-view="full" class="${st.view === 'full' ? 'on' : ''}" title="显示整卷">全卷</button></div>
              ${st.view === 'full' ? `<div class="vseg" title="全卷显示方式"><button data-full="strip" class="${prefs.fullMode === 'strip' ? 'on' : ''}">整条</button><button data-full="tile" class="${prefs.fullMode === 'tile' ? 'on' : ''}">平铺</button></div>` : ''}
              <div class="div"></div><button id="z-fit" title="适应视图">适应</button><button id="z-out" title="缩小">−</button>
              <input id="z-ratio" class="cin num" list="ratios" title="精确比例：输入 1:N 回车"><datalist id="ratios">${[5, 10, 20, 50, 100, 200, 500].map(n => `<option>1:${n}</option>`).join('')}</datalist>
              <button id="z-in" title="放大">+</button><span id="z-pct" class="num" style="min-width:40px"></span>
              <div class="div"></div><button id="seg-prev" title="上一段" ${idx <= 0 ? 'disabled' : ''}>◀</button><span class="num" style="color:#fff">${seg ? `${idx + 1} / ${sc.segments.length}` : '新工位'}</span><button id="seg-next" title="下一段 / 新工位" ${idx >= order.length - 1 ? 'disabled' : ''}>▶</button>
              <div class="div"></div><div class="vseg">${[['pan', '平移'], ...(st.adjust ? [['move', '移动件']] : []), ['measure', '测量'], ...(sc.fixed || st.adjust ? [] : [['defect', '标疵点']])].map(([k, t]) => `<button data-tool="${k}" class="${st.tool === k ? 'on' : ''}">${t}</button>`).join('')}</div>
              <button id="path-toggle" class="${st.showPath ? 'on' : ''}" aria-pressed="${!!st.showPath}" title="显示当前段刀序与空走线">刀路</button>
              <button id="dimensions-toggle" class="${prefs.showDimensions !== false ? 'on' : ''}" aria-pressed="${prefs.showDimensions !== false}" title="显示或隐藏工位尺寸">尺寸</button>
              <button id="clear-measure" title="清除测量">✕ 测量</button>
              <button id="orient" title="画布方向（不影响坐标与算法）">${prefs.vertical ? '竖向 ⇅' : '横向 ⇆'}</button>
              <span class="sp"></span><span>拉布</span><input id="bed-len" class="cin num" value="${Math.round(sc.window.len)}" title="${sc.fixed ? '料头整块投料，长度固定' : sc.window.readOnly ? '调整或提交期间保持工位范围' : '本次拉布长度（mm）'}" ${sc.fixed || sc.window.readOnly ? 'disabled' : ''}><span>mm</span>
            </div>
            <div class="canvas-wrap"><div id="rc"></div>
              <div class="legend">${sc.segments.some(s => s.pieces.some(p => p.outcome)) ? Object.values(OUTPUT_STYLES).map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('') : ''}${st.view === 'full' || seg?.status !== 'cut' ? task.demands.slice(0, 6).map(d => `<span><i style="background:${colors.get(d.id)}"></i>计划 · ${esc(String(d.name).slice(0, 18))}</span>`).join('') : ''}<span><i style="border:1.5px solid #ff6b5b"></i>疵点</span></div>
            </div>
            <div class="navroll"><div class="nr-head"><span>${roll.remnant ? '料头' : '母卷'} <b class="num">${esc(st.rollId)}</b>${roll.remnant ? ` <span class="muted">来源 ${esc(roll.remnant.sourceRollId || '—')}</span>` : ''}</span><span>幅宽 <b class="num">${fmtN(sc.roll.width)}</b> mm</span><span>总长 <b class="num">${fmtM(sc.roll.total)}</b> m</span><span>已用 <b class="num">${fmtM(sc.roll.used)}</b> m</span>
              <span>本任务 已切 <b class="num">${met.cut}</b> · 候选 <b class="num">${met.pending}</b>${met.stale ? ` · 已失效 <b class="num">${met.stale}</b>` : ''}</span></div><div id="rn"></div></div>
          </section>
          ${st.report && seg ? reportPanel(seg, idx, sc) : st.quality && seg ? qualityPanel(seg) : st.adjust && seg ? adjustPanel(seg) : prefs.sideCollapsed ? `<section class="pane side-min"><button id="side-toggle" title="展开右栏">«</button><span>方案指标</span></section>` : `<section class="pane">
            <div class="pane-h">方案指标<span class="sub">本卷</span><span class="sp"></span><button class="btn sm" id="side-toggle" title="收起右栏">»</button></div>
            <div class="pane-b">
              <div class="metric"><div><small>利用率</small><b>${met.utilization.toFixed(1)}<em>%</em></b></div><div><small>用布长度</small><b>${fmtM(met.length, 2)}<em>m</em></b></div>
                <div><small>拉布次数</small><b>${met.spreads}</b></div><div><small>任务完成</small><b>${total ? Math.round(done / total * 100) : 0}<em>%</em></b></div></div>
              ${sidePanel(sc, seg, idx)}
              <div class="sec">拉布段</div>
              <table class="t" style="border:0"><tbody>${sc.segments.map((s, i) => `<tr class="click ${s.id === sc.currentId ? 'sel' : ''}" data-seg="${esc(s.id)}"><td class="num">${i + 1}</td><td class="num">${fmtM(s.start, 2)} m</td><td class="r num">${fmtN(s.len)} mm</td><td>${s.invalid ? `<span class="tag warn" title="${esc(s.invalid)}">需重算</span>` : `<span class="tag ${SEG_TAG[s.status]}">${STATUS_TEXT[s.status]}</span>`}</td></tr>`).join('')}
                <tr class="click ${seg ? '' : 'sel'}" data-seg="${NEW_STATION}"><td class="num">＋</td><td class="muted" colspan="3">新工位</td></tr></tbody></table>
            </div>
          </section>`}
        </div>`}
        <div class="foot" id="foot">${footHtml(sc)}</div>`;
        bind(sc, savedCam);
    }

    /** 右栏：当前段信息 + 本工位操作（计算 / 重新计算 / 放弃候选）。 */
    function sidePanel(sc, seg, idx) {
        const w = sc.window, rem = remaining(), need = rem.reduce((a, d) => a + d.demand, 0), problem = windowProblem(roll, w);
        const failure = st.failure ? `<div class="notice"><b>${esc(st.failure.title || '本次未得到可用方案')}</b><br>${esc(st.failure.message || '')}
            ${st.failure.canForward ? '<div style="margin-top:6px"><button class="btn sm" id="forward">向后查找可裁位置</button></div>' : ''}</div>` : '';
        const busy = (st.busy ? `<div class="notice" style="border-color:#c9d8e8;background:#f2f6fb;color:var(--accent-ink)">${esc(st.busy)}</div>` : '')
            + (occupied.has(roll.remnant ? roll.remnant.id : st.rollId) ? `<div class="notice">该材料${esc(occupiedText(roll.remnant ? roll.remnant.id : st.rollId))}，可以先排料，但须等对方报工或取消后才能报工。</div>` : '');
        if (!seg && isSlitting(task)) return slitBlock(sc) + busy + failure;
        if (!seg) {
            return `<div class="sec">新工位</div>
              <div class="kv"><div>位置</div><div class="num">Y ${fmtM(w.start, 2)} → ${fmtM(w.start + w.len, 2)} m</div><div>拉布长</div><div class="num">${fmtN(w.len, 1)} mm</div>
                <div>待排需求</div><div class="num">${rem.length} 项 · ${need} 件</div></div>
              ${problem ? `<div class="notice">${esc(problem)}</div>` : ''}${busy}${failure}
              <div style="display:flex;gap:8px;padding:8px 12px"><button class="btn pri" id="solve" ${st.busy || problem || !need ? 'disabled' : ''}>计算本工位</button></div>`;
        }
        const unplaced = seg.fulfillment.filter(f => f.unplaced > 0);
        return `<div class="sec">当前拉布 · ${idx + 1} / ${sc.segments.length}</div>
          <div class="kv"><div>状态</div><div><span class="tag ${SEG_TAG[seg.status]}">${STATUS_TEXT[seg.status]}</span>${w.adjusted ? ' <span class="tag warn">工位已调整</span>' : ''}</div>
            <div>方案</div><div class="num">${shortId(seg.id)} · v${seg.version ?? 1}</div>
            <div>位置</div><div class="num">Y ${fmtM(seg.start, 2)} → ${fmtM(seg.start + seg.len, 2)} m</div>
            <div>拉布长</div><div class="num">${fmtN(seg.len, 1)} mm</div>
            <div>件数</div><div class="num">${seg.pieces.length}</div>
            <div>利用率</div><div class="num">${seg.totalArea ? (seg.pieceArea / seg.totalArea * 100).toFixed(1) : '—'}%</div></div>
          ${seg.status === 'stale' ? '<div class="notice">该方案的报工已在母卷重置时清除，方案既未切也不能再报工，仅作历史参考。</div>' : ''}
          ${seg.status === 'pending' ? (() => {
              const view = executionForPlan(views, seg.id), locked = !!view?.reservationActive;
              const reportAllowed = !seg.invalid && (!view || view.allowedActions?.report?.allowed);
              const reportWhy = seg.invalid || (w.adjusted ? '工位已调整，请先重新计算或还原工位' : !reportAllowed ? (view.allowedActions?.report?.reason || '执行单当前状态不能报工') : '按实际裁切结果报工');
              return `${seg.invalid ? `<div class="notice"><b>需重算</b>：${esc(seg.invalid)}。此候选不能报工、下达或调整，请${isSlitting(task) ? '放弃后按剩余需求重新出车' : '重新计算或放弃'}。</div>` : ''}${w.adjusted ? `<div class="notice">工位已调整为 Y ${fmtM(w.start, 2)} m · ${fmtN(w.len)} mm，重新计算后替换当前候选。</div>` : ''}${problem ? `<div class="notice">${esc(problem)}</div>` : ''}${busy}${failure}
            <div style="display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap"><button class="btn pri" id="report-open" ${st.busy || w.adjusted || !reportAllowed ? 'disabled' : ''} title="${esc(reportWhy)}">报工</button>
              ${isSlitting(task) ? '' : `<button class="btn" id="solve" ${st.busy || problem || !need || locked ? 'disabled' : ''} title="${locked ? '已下达或执行中，先取消执行单' : ''}">重新计算</button>`}<button class="btn" id="discard" ${st.busy || locked ? 'disabled' : ''}>放弃候选</button></div>
            ${executionBlock(seg, view)}`; })() : ''}
          ${seg.status === 'cut' ? recordsBlock(seg) : ''}
          ${toolsBlock(seg)}
          <div class="sec">本次未排入</div>
          ${unplaced.length ? `<table class="t" style="border:0"><tbody>${unplaced.map(f => `<tr><td class="wrap">${esc(names.get(f.demandId)?.name || `需求 ${f.demandId}`)}</td><td class="r num" style="color:var(--warn)">缺 ${f.unplaced}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">本段需求全部排入</div>'}`;
    }

    /** 执行单：创建 → 下达（预约）→ 开工 → 报工；按钮可用性与原因全部来自后端 allowedActions。 */
    function executionBlock(seg, view) {
        const pend = writer.pending(task.id).filter(([slot]) => slot.endsWith(seg.id) || (view && slot.endsWith(view.execution.id)));
        const unsure = pend.length ? `<div class="notice">上次执行单操作结果未确认（${esc(pend.map(([, v]) => v.action).join('、'))}），请重试原操作，避免重复登记。<div style="margin-top:6px">${pend.map(([slot]) => `<button class="btn sm" data-retry="${esc(slot)}">重试</button>`).join(' ')}</div></div>` : '';
        if (!view || ['CANCELLED', 'EXPIRED'].includes(view.effectiveState) && !view.reservationActive) {
            return `<div class="sec">执行单</div>${unsure}
              ${view ? `<div class="kv"><div>上一张</div><div><span class="tag ${EXEC_TAG[view.effectiveState]}">${esc(executionLabels[view.effectiveState] || view.effectiveState)}</span> <span class="num">${shortId(view.execution.id)}</span></div></div>` : ''}
              <div style="display:flex;gap:6px;padding:8px 12px;align-items:center"><span class="muted">工位</span><input class="field" id="exec-station" value="${esc(st.station)}" style="width:70px">
                <button class="btn" id="exec-create" ${st.busy || pend.length || seg.invalid ? 'disabled' : ''} title="${esc(seg.invalid || '')}">创建执行单</button></div>
              <div class="muted" style="padding:0 12px 8px;font-size:11.5px">不建执行单也可直接报工；建单后可预约材料、按工位开工报工。</div>`;
        }
        const e = view.execution, a = view.allowedActions || {}, blocked = k => seg.invalid && ['release', 'start'].includes(k);
        const btn = (k, t, extra = '') => `<button class="btn sm" data-exec="${k}" ${a[k]?.allowed && !blocked(k) && !st.busy && !pend.length ? '' : 'disabled'} title="${esc(blocked(k) ? seg.invalid : a[k]?.reason || '')}" ${extra}>${t}</button>`;
        return `<div class="sec">执行单</div>${unsure}
          <div class="kv"><div>状态</div><div><span class="tag ${EXEC_TAG[view.effectiveState] || ''}">${esc(executionLabels[view.effectiveState] || view.effectiveState)}</span> <span class="num muted">${shortId(e.id)} · v${e.version}</span></div>
            <div>工位</div><div>${esc(e.station)}</div><div>材料</div><div class="num">${esc(e.materialId)}</div>
            ${e.expiresAt ? `<div>预约至</div><div class="num">${new Date(e.expiresAt).toLocaleString('zh-CN', {hour12: false})}</div>` : ''}</div>
          <div style="display:flex;gap:6px;padding:8px 12px;align-items:center;flex-wrap:wrap">
            ${a.release?.allowed ? `<span class="muted">预约</span><input class="field num" id="exec-reserve" value="${st.reserveMin}" style="width:56px;text-align:right"><span class="muted">分钟</span>` : ''}
            ${btn('release', '下达')}${btn('start', '开工')}${btn('cancel', '取消')}</div>
          ${st.cancelling ? `<div style="display:flex;gap:6px;padding:0 12px 10px"><input class="field" id="exec-cancel-reason" placeholder="取消原因（必填）" style="flex:1"><button class="btn sm pri" id="exec-cancel-submit">确认取消</button></div>` : ''}`;
    }

    /** 方案工具：刀路优化、手动调整（仅候选且未下达）、导出与工单（任何状态）。 */
    function toolsBlock(seg) {
        if (!['pending', 'cut', 'stale'].includes(seg.status)) return '';
        const plan = planOf(seg.id), locked = !!executionForPlan(views, seg.id)?.reservationActive, editable = seg.status === 'pending' && !locked && !seg.invalid;
        const tp = st.toolpath?.planId === seg.id ? st.toolpath : null;
        return `<div class="sec">方案工具</div>
          ${editable ? `<div style="display:flex;gap:6px;padding:8px 12px 0;flex-wrap:wrap"><button class="btn sm" id="tp-optimize" ${st.busy || !plan?.result?.cuts?.length ? 'disabled' : ''}>优化空走刀</button><button class="btn sm" id="adjust-open" ${st.busy ? 'disabled' : ''}>手动调整</button></div>` : ''}
          ${tp?.result ? `<div class="kv" style="margin-top:6px"><div>空走</div><div class="num">${fmtN(tp.result.originalAirDistance)} → ${fmtN(tp.result.optimizedAirDistance)} mm</div><div>节省</div><div class="num">${fmtN(tp.result.savedAirDistance)} mm · ${fmtN((tp.result.savingRatio || 0) * (tp.result.savingRatio <= 1 ? 100 : 1), 1)}%</div></div>
            <div style="display:flex;gap:6px;padding:6px 12px"><button class="btn sm pri" id="tp-save" ${st.busy || !(tp.result.savedAirDistance > 0) ? 'disabled' : ''}>保存刀序为新版本</button><button class="btn sm" id="tp-drop">放弃</button></div>` : ''}
          ${tp?.error ? `<div class="notice">${esc(tp.error)}</div>` : ''}
          <div style="display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap"><button class="btn sm" data-export="nc">G-Code</button><button class="btn sm" data-export="dxf">DXF</button><button class="btn sm" id="ticket-print">打印工单</button></div>`;
    }

    /** 手动调整：拖动件（“移动件”工具）、旋转、撤销 / 重做，后端校验后另存为新版本。 */
    function adjustPanel(seg) {
        const a = st.adjust, plan = planOf(a.planId), changed = changedPieces(a.positions, plan);
        const p = plan.result.pieces.find(x => x.id === a.selected), q = p && a.positions[p.id], size = p && sizeOf(p, q.rotated);
        return `<section class="pane" id="adjust"><div class="pane-h">手动调整<span class="sub num">${shortId(seg.id)} · v${seg.version}</span><span class="sp"></span><button class="btn sm" id="adjust-close" ${st.busy ? 'disabled' : ''}>放弃调整</button></div>
          <div class="pane-b"><div class="muted" style="padding:10px 12px;font-size:12px">方向键微调 5 mm，Shift 为 20 mm，R 旋转，F 定位，Ctrl/⌘+Z 撤销。位置按当前工位计算；前端预检后，仍须由后端校验刀路并保存新版本。</div>
            <div class="kv"><div>已改动</div><div class="num">${changed} 件</div>
              ${p ? `<div>选中</div><div>#${p.id} · ${esc(String(p.name || '').slice(0, 16))}</div><div>位置</div><div class="num">X ${fmtN(q.x, 1)} · Y ${fmtN(q.y, 1)} mm</div><div>尺寸</div><div class="num">${fmtN(size.w)} × ${fmtN(size.l)}${q.rotationDegrees != null ? ` · ${q.rotationDegrees}°` : q.rotated !== !!p.rotated ? ' · 已旋转' : ''}</div>` : '<div>选中</div><div class="muted">点选画布中的裁片</div>'}</div>
            ${p ? `<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:6px;align-items:end;padding:8px 12px"><label>X mm<input style="width:100%" class="field num" id="adj-x" type="number" step="0.1" value="${q.x}" ${st.busy ? 'disabled' : ''}></label><label>Y mm<input style="width:100%" class="field num" id="adj-y" type="number" step="0.1" value="${q.y}" ${st.busy ? 'disabled' : ''}></label><button class="btn sm" id="adj-position" ${st.busy ? 'disabled' : ''}>应用位置</button></div>` : ''}
            <div style="display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap"><button class="btn sm" id="adj-undo" ${a.history.canUndo ? '' : 'disabled'}>撤销</button><button class="btn sm" id="adj-redo" ${a.history.canRedo ? '' : 'disabled'}>重做</button>
              <button class="btn sm" id="adj-rotate" ${p && rotationAllowed(plan, p) && !st.busy ? '' : 'disabled'}>旋转 90°</button><button class="btn sm" id="adj-fit" ${p ? '' : 'disabled'}>定位选中件</button><button class="btn sm" id="adj-reset" ${changed ? '' : 'disabled'}>恢复原位</button></div>
            ${a.problem ? `<div class="notice" id="adj-problem" role="status">${esc(a.problem.message)}${a.problem.subject ? `<br>尝试位置 X ${fmtN(a.problem.subject.x, 1)} · Y ${fmtN(a.problem.subject.y, 1)} mm<br><button class="btn sm" id="adj-problem-fit">定位冲突区域</button>` : ''}</div>` : ''}
            ${a.error ? `<div class="notice">${esc(a.error)}</div>` : ''}
            <div style="display:flex;gap:8px;padding:8px 12px"><button class="btn pri" id="adj-save" ${changed && !st.busy ? '' : 'disabled'}>校验并保存为新版本</button></div></div></section>`;
    }

    /** 只重绘调整面板并重新绑定其按钮；画布实例保持不变。 */
    function patchAdjust() {
        const box = el.querySelector('#adjust'), sc = scene(), seg = sc.segments.find(s => s.id === sc.currentId);
        if (!box || !seg) return;
        box.outerHTML = adjustPanel(seg);
        bindAdjust();
    }

    const mayAdjust = () => st.adjust && !st.busy && !checks[st.adjust.planId] && !executionForPlan(views, st.adjust.planId)?.reservationActive;
    function proposePiece(id, next, {done = true, base = st.adjust?.positions} = {}) {
        if (!mayAdjust()) return;
        const a = st.adjust, previousMessage = a.problem?.message;
        a.problem = placementProblem(next, planOf(a.planId), id); a.error = null;
        a.positions = done && a.problem ? base : next;
        if (done) a.history.record(a.positions);
        canvas.setScene(scene());
        if (done || previousMessage !== a.problem?.message) patchAdjust();
    }

    function download(name, text, type) {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type}));
        a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function bindTools(sc) {
        const seg = sc.segments.find(s => s.id === sc.currentId); if (!seg) return;
        const plan = planOf(seg.id);
        el.querySelector('#path-toggle')?.addEventListener('click', e => { st.showPath = !st.showPath; e.currentTarget.classList.toggle('on', st.showPath); e.currentTarget.setAttribute('aria-pressed', String(st.showPath)); canvas.setOptions({showPath: st.showPath}); });
        el.querySelectorAll('[data-export]').forEach(b => b.onclick = () => {
            const {data, home} = camData(plan), tag = `${shortId(plan.id)}-v${plan.version || 1}`;
            b.dataset.export === 'nc' ? download(`cut-${tag}.nc`, gcodeText(data, {home}), 'text/plain;charset=utf-8')
                : download(`cut-${tag}.dxf`, dxfText(data, {home}), 'application/dxf');
        });
        el.querySelector('#ticket-print')?.addEventListener('click', async () => {
            try {
                const saved = await requestJSON('/api/cutting/plans/' + encodeURIComponent(seg.id));
                const html = ticketHTML(ticketModel(saved, saved.status !== 'PENDING'));
                const frame = document.createElement('iframe'); frame.style.cssText = 'position:fixed;width:0;height:0;border:0'; document.body.append(frame);
                frame.onload = () => { frame.contentWindow.addEventListener('afterprint', () => frame.remove(), {once: true}); frame.contentWindow.focus(); frame.contentWindow.print(); };
                const d = frame.contentDocument; d.open();
                d.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>裁切工单</title><link rel="stylesheet" href="${location.origin}/css/cut-ticket.css"></head><body><article class="cut-ticket">${html}</article></body></html>`); d.close();
            } catch (e) { toast('工单生成失败：' + e.message, true); }
        });
        el.querySelector('#tp-optimize')?.addEventListener('click', async () => {
            const home = localHome(plan); st.busy = '正在优化刀路…'; shell(true);
            try { st.toolpath = {planId: seg.id, result: await requestJSON('/api/toolpath/optimize', {cuts: plan.result.cuts, homeX: home.x, homeY: home.y, respectPrecedence: true}), opId: crypto.randomUUID()}; }
            catch (e) { st.toolpath = {planId: seg.id, error: '刀路优化未完成：' + e.message}; }
            st.busy = ''; shell(true);
        });
        el.querySelector('#tp-drop')?.addEventListener('click', () => { st.toolpath = null; shell(true); });
        el.querySelector('#tp-save')?.addEventListener('click', () => saveAdjustment({adjustmentId: st.toolpath.opId, cuts: st.toolpath.result.optimizedCuts}, '刀序已保存为新版本'));
        el.querySelector('#adjust-open')?.addEventListener('click', () => {
            const positions = initialPositions(plan);
            st.adjust = {planId: seg.id, positions, history: createPlanHistory(positions), selected: null, error: null};
            st.tool = 'move'; st.view = 'station'; full(); // 进入调整时对准当前工位
        });
        bindAdjust();
    }

    function bindAdjust() {
        const box = el.querySelector('#adjust'); if (!box || !st.adjust) return;
        const a = st.adjust, plan = planOf(a.planId);
        const redraw = () => { canvas.setScene(scene()); patchAdjust(); };
        box.querySelector('#adjust-close').onclick = () => { st.adjust = null; st.tool = 'pan'; shell(true); };
        box.querySelector('#adj-undo').onclick = () => { if (!mayAdjust()) return; const p = a.history.undo(); if (p) { a.positions = p; a.error = null; a.problem = null; redraw(); } };
        box.querySelector('#adj-redo').onclick = () => { if (!mayAdjust()) return; const p = a.history.redo(); if (p) { a.positions = p; a.error = null; a.problem = null; redraw(); } };
        box.querySelector('#adj-rotate').onclick = () => proposePiece(a.selected, rotatePiece(a.positions, plan, a.selected));
        box.querySelector('#adj-position')?.addEventListener('click', () => proposePiece(a.selected, {...a.positions, [a.selected]: {...a.positions[a.selected],
            x: box.querySelector('#adj-x').valueAsNumber, y: box.querySelector('#adj-y').valueAsNumber}}));
        box.querySelector('#adj-fit').onclick = () => canvas.fitSelection();
        box.querySelector('#adj-problem-fit')?.addEventListener('click', () => {
            const shapes = scene().diagnostics?.[0]?.shapes; if (!shapes?.length) return;
            canvas.fitBounds({u0: Math.min(...shapes.map(p => p.u)), u1: Math.max(...shapes.map(p => p.u + p.du)),
                v0: Math.min(...shapes.map(p => p.v)), v1: Math.max(...shapes.map(p => p.v + p.dv))});
        });
        box.querySelector('#adj-reset').onclick = () => { if (!mayAdjust()) return; a.positions = initialPositions(plan); a.history.record(a.positions); a.error = null; a.problem = null; redraw(); };
        box.querySelector('#adj-save').onclick = () => {
            if (!mayAdjust()) return;
            const body = adjustPayload(a.positions, a.opId && a.opBody === JSON.stringify(a.positions) ? a.opId : (a.opId = crypto.randomUUID()));
            a.opBody = JSON.stringify(a.positions);
            saveAdjustment(body, '调整版已校验并保存为新版本');
        };
    }

    /** 保存调整版（件位置或刀序）：后端校验通过后原候选作废、新版本成为候选。同一内容重试使用同一操作编号。 */
    async function saveAdjustment(body, okText) {
        const id = st.adjust?.planId || st.toolpath?.planId;
        st.busy = '正在校验并保存…'; shell(true);
        try {
            const saved = await requestJSON('/api/cutting/plans/' + encodeURIComponent(id) + '/adjust', body);
            st.adjust = null; st.toolpath = null; st.tool = 'pan';
            await reload(); st.selectedId = saved.id; st.window = null; toast(okText + `（v${saved.version}）`);
            st.busy = ''; full(); return;
        } catch (e) {
            if (st.adjust) st.adjust.error = '校验或保存未完成：' + e.message; else if (st.toolpath) st.toolpath.error = '保存未完成：' + e.message;
        }
        st.busy = ''; shell(true);
    }

    /** 报工记录：回执摘要、复检处置、冲销。 */
    function recordsBlock(seg) {
        const report = (detail.reports || []).find(r => r.planId === seg.id && r.status !== 'REVERSED');
        if (!report) return '';
        const s = receiptSummary(report, effectivePieceResults), reviewable = reviewablePieces(report).length;
        return `<div class="sec">报工回执</div><div class="notice">${esc(seg.outputNote || '')}</div>
          <div class="kv"><div>状态</div><div><span class="tag ${report.status === 'REVERSED' ? 'err' : 'ok'}">${report.status === 'REVERSED' ? '已冲销' : '已记账'}</span></div>
            <div>实切</div><div class="num">${fmtN(report.actualCutLen, 1)} mm · 利用率 ${fmtN(report.netUtilization ?? report.utilization, 1)}%</div>
            <div>结果</div><div class="num">合格 ${s.qualified} · 异常 ${s.rejected} · 未切 ${s.uncut}</div>
            <div>料头</div><div class="num">${(report.derivedRemnants || []).length} 块${(report.derivedRemnants || []).length ? ' · ' + (report.derivedRemnants || []).map(r => esc(r.id || '')).join('、') : ''}</div>
            <div>复检</div><div class="num">${s.dispositions} 次</div>
            <div>时间</div><div class="num">${esc(String(report.confirmedAt || '').replace('T', ' ').slice(0, 16))}</div></div>
          ${report.status !== 'REVERSED' ? `<div style="display:flex;gap:8px;padding:8px 12px"><button class="btn" id="quality-open" ${reviewable ? '' : 'disabled title="没有可复检的已切裁片"'}>复检处置</button>
            <button class="btn" id="reverse-open">冲销报工</button></div>
            ${st.reversing ? `<div style="display:flex;gap:6px;padding:0 12px 10px"><input class="field" id="reverse-reason" placeholder="冲销原因（必填）" style="flex:1"><button class="btn sm pri" id="reverse-submit" ${st.busy ? 'disabled' : ''}>确认冲销</button></div>
              <div class="muted" style="padding:0 12px 8px;font-size:11.5px">冲销恢复母卷用量、撤回本次产出料头与完成量；已有复检或料头已被使用时后端会拒绝。</div>` : ''}` : ''}`;
    }

    /** 复检处置面板：一次处置一件；结果不确定时原样重发同一命令。 */
    function qualityPanel(seg) {
        const q = st.quality, report = q.report, pieces = reviewablePieces(report), piece = pieces.find(p => p.pieceId === Number(q.pieceId));
        const problems = qualityProblems(q, piece);
        return `<section class="pane" id="quality"><div class="pane-h">复检处置<span class="sub num">${shortId(seg.id)}</span><span class="sp"></span><button class="btn sm" id="quality-close" ${q.uncertain ? 'disabled' : ''}>关闭</button></div>
          <div class="pane-b"><div class="muted" style="padding:10px 12px;font-size:12px">原报工与母卷耗用保留；良品处置后扣回完成量，形成补产需求。</div>
            <div class="form" style="grid-template-columns:90px 1fr">
              <label>裁片</label><select class="field" data-q="pieceId" ${q.command ? 'disabled' : ''}>${pieces.map(p => `<option value="${p.pieceId}" ${p.pieceId === Number(q.pieceId) ? 'selected' : ''}>#${p.pieceId} · ${esc(String(p.name).slice(0, 18))} · ${p.w}×${p.l} · 原${p.outcome === 'QUALIFIED' ? '良品' : '异常'}</option>`).join('')}</select>
              <label>处置方式</label><select class="field" data-q="disposition" ${q.command ? 'disabled' : ''}>${Object.entries(DISPOSITIONS).map(([k, t]) => `<option value="${k}" ${q.disposition === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
              <label>检验人</label><input class="field" data-q="inspector" value="${esc(q.inspector)}" ${q.command ? 'disabled' : ''}>
              <label>复检原因</label><input class="field" data-q="reason" value="${esc(q.reason)}" ${q.command ? 'disabled' : ''}>
              ${q.disposition === 'REMNANT' ? `<label>回收矩形</label><div class="muted" style="font-size:11.5px">相对裁片左上角 · mm</div>
                ${[['x', '起点 X'], ['y', '起点 Y'], ['width', '宽度'], ['length', '长度']].map(([k, t]) => `<label>${t}</label><input class="field num" data-q="${k}" value="${esc(q[k])}" ${q.command ? 'disabled' : ''}>`).join('')}
                <label>库位</label><input class="field" data-q="location" value="${esc(q.location)}" ${q.command ? 'disabled' : ''}>
                <label>质量</label><select class="field" data-q="quality" ${q.command ? 'disabled' : ''}><option value="QUARANTINED" ${q.quality === 'QUARANTINED' ? 'selected' : ''}>待检隔离（不能选料）</option><option value="RECOVERABLE" ${q.quality === 'RECOVERABLE' ? 'selected' : ''}>已验收可用</option></select>` : ''}
            </div>
            ${problems.length && !q.command ? `<div class="notice">${problems.map(esc).join('<br>')}</div>` : ''}
            ${q.error ? `<div class="notice">${esc(q.error)}</div>` : ''}
            <div style="display:flex;gap:8px;padding:8px 12px"><button class="btn pri" id="quality-submit" ${(problems.length && !q.command) || st.busy ? 'disabled' : ''}>${q.uncertain ? '重试同一处置' : '确认处置'}</button></div>
          </div></section>`;
    }

    async function execAction(action, view, seg) {
        try {
            const values = action === 'create' ? {station: (el.querySelector('#exec-station')?.value || '').trim() || '1'}
                : action === 'release' ? {reservationSeconds: Math.round((Number(el.querySelector('#exec-reserve')?.value) || 30) * 60)}
                : action === 'cancel' ? {reason: (el.querySelector('#exec-cancel-reason')?.value || '').trim()} : {};
            if (action === 'cancel' && !values.reason) return toast('请填写取消原因', true);
            st.cancelling = false;
            if (action === 'create') st.station = values.station;
            if (action === 'release') st.reserveMin = values.reservationSeconds / 60;
            st.busy = {create: '正在创建执行单…', release: '正在下达…', start: '正在开工…', cancel: '正在取消…'}[action]; shell(true);
            await writer.command(action, {taskId: task.id, planId: seg.id, id: view?.execution.id, version: view?.execution.version}, values);
            await reload(); toast({create: '执行单已创建', release: '已下达并预约材料', start: '已开工，可报工', cancel: '执行单已取消'}[action]);
        } catch (e) { toast((e.httpStatus ? '' : '结果未确认，可重试：') + e.message, true); try { await reload(); } catch { /* 刷新失败保留当前视图 */ } }
        st.busy = ''; shell(true);
    }

    /** 报工面板：逐件结果、实切长度、料头回收、库位；提交前就地校验。 */
    function reportPanel(seg, idx, sc) {
        const r = st.report, s = reportSummary(seg, r), problems = reportProblems(seg, r), cands = recoveryCandidates(seg, r);
        const rec = cands.filter(c => r.rem[c.id]?.use);
        return `<section class="pane" id="report"><div class="pane-h">报工 · 第 ${idx + 1} 次拉布<span class="sub num">${shortId(seg.id)}</span><span class="sp"></span><button class="btn sm" id="report-close">取消</button></div>
          <div class="pane-b">
            <div class="form" style="grid-template-columns:90px 1fr;padding:10px 12px 6px">
              ${r.remnant ? '<label>投料</label><div class="muted">料头整块投料：不扣母卷长度，剩余部分不再回收</div>'
                : `<label>实切长度</label><div style="display:flex;gap:6px;align-items:center"><input class="field num" data-r="len" value="${r.len}" style="width:110px;text-align:right"><span class="muted">mm · 方案 ${fmtN(seg.len, 1)}</span></div>`}
              <label>料头库位</label><input class="field" data-r="location" value="${esc(r.location)}">
            </div>
            <div class="sec">逐件结果 · 合格 ${s.qualified} · 异常 ${s.rejected} · 未切 ${s.uncut}</div>
            <div style="display:flex;gap:6px;padding:6px 12px"><button class="btn sm" data-bulk="all-qualified">全设合格</button><button class="btn sm" data-bulk="all-uncut">全设未切</button><button class="btn sm" data-bulk="beyond-uncut" title="末端超出实切长度的裁片标为未切">长度外标为未切</button></div>
            <table class="t" style="border:0"><thead><tr><th>#</th><th>裁片</th><th class="r">宽×长</th><th>结果</th></tr></thead><tbody>
            ${seg.pieces.map(p => { const row = r.rows[p.id]; return `<tr><td class="num">${p.id}</td><td class="wrap" style="max-width:150px">${esc((names.get(p.demandId)?.name || '').slice(0, 20))}</td><td class="r num">${fmtN(p.dv)}×${fmtN(p.du)}</td>
              <td><select class="field" data-o="${p.id}" style="height:22px">${Object.entries(OUTCOMES).map(([k, t]) => `<option value="${k}" ${row.outcome === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
              ${row.outcome === 'REJECTED' ? `<input class="field" data-why="${p.id}" value="${esc(row.reason)}" placeholder="异常原因" style="height:22px;width:100%;margin-top:3px">` : ''}</td></tr>`; }).join('')}</tbody></table>
            <div class="sec">料头回收 · ${rec.length} 块</div>
            ${cands.length ? `<table class="t" style="border:0"><thead><tr><th></th><th>料头</th><th class="r">实测宽</th><th class="r">实测长</th></tr></thead><tbody>
            ${cands.map(c => { const m = r.rem[c.id] || {use: false, w: c.w, l: c.l}; return `<tr><td><input type="checkbox" data-use="${esc(c.id)}" ${m.use ? 'checked' : ''}></td>
              <td>${esc(c.source)}${c.hasDefect ? ' <span class="tag warn">带疵</span>' : ''}<div class="muted num" style="font-size:11px">≤ ${fmtN(c.w)}×${fmtN(c.l)}</div></td>
              <td class="r"><input class="field num" data-rw="${esc(c.id)}" value="${m.w}" style="width:72px;height:22px;text-align:right" ${m.use ? '' : 'disabled'}></td>
              <td class="r"><input class="field num" data-rl="${esc(c.id)}" value="${m.l}" style="width:72px;height:22px;text-align:right" ${m.use ? '' : 'disabled'}></td></tr>`; }).join('')}</tbody></table>`
              : '<div class="empty" style="padding:10px">本方案没有可回收料头</div>'}
            ${problems.length ? `<div class="notice">${problems.map(esc).join('<br>')}</div>` : ''}
            <div class="muted" style="padding:8px 12px;font-size:11.5px">确认后记账：${r.remnant ? '料头整块消耗' : (() => { const d = rollDeduction(seg.start, Number(r.len));
                return `母卷扣减 ${fmtN(d.total, 1)} mm${d.skipped > .05 ? `（含工位前避让疵点跳过的 ${fmtN(d.skipped, 1)} mm）` : ''}`; })()}，合格件计入任务完成；如需更正请冲销后重报，不能直接修改。</div>
            <div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn pri" id="report-submit" ${problems.length || st.busy ? 'disabled' : ''}>确认报工</button><button class="btn" id="report-reset">恢复默认</button></div>
          </div></section>`;
    }

    /** 与后端一致的位置消耗：已用长度推进到工位末端，工位前跳过的区段一并扣减。 */
    function rollDeduction(start, len) {
        const used = roll?.usedLength || 0, total = Math.max(0, start + len - used);
        return {total, skipped: Math.max(0, Math.min(start - used, total))};
    }
    function openReport(seg) {
        const saved = JSON.parse(localStorage.getItem(REPORT_KEY(seg.id)) || 'null');
        st.report = saved?.planId === seg.id ? saved : defaultReport(seg, {remnant: !!roll?.remnant});
        st.pop = null; shell(true);
    }
    function editReport(change) { st.report = change(st.report); localStorage.setItem(REPORT_KEY(st.report.planId), JSON.stringify(st.report)); shell(true); }
    function closeReport() { st.report = null; shell(true); }
    async function submitReport() {
        const sc = scene(), seg = sc.segments.find(s => s.id === st.report?.planId);
        if (!seg) return;
        const problems = reportProblems(seg, st.report);
        if (problems.length) return toast(problems[0], true);
        const payload = buildCutReport(seg, st.report), s = reportSummary(seg, st.report), deduction = rollDeduction(seg.start, payload.actualCutLen);
        localStorage.setItem(REPORT_KEY(seg.id), JSON.stringify(st.report)); // 提交前落盘：结果未知或失败时刷新也能找回
        st.busy = '正在提交报工…'; shell(true);
        try {
            // 有执行中的执行单时按执行单报工，否则直接报工（后端两条路径同一校验）
            const view = executionForPlan(views, seg.id);
            const receipt = view && view.effectiveState === 'RUNNING'
                ? await requestJSON('/api/v2/execution-orders/' + encodeURIComponent(view.execution.id) + '/reports', payload)
                : await requestJSON('/api/cutting/report-confirm', payload);
            localStorage.removeItem(REPORT_KEY(seg.id));
            st.report = null; await reload();
            st.selectedId = NEW_STATION; st.window = null; st.busy = '';
            toast(roll?.remnant ? `报工完成：合格 ${s.qualified} 件，料头 ${roll.remnant.id} 已整块消耗`
                : `报工完成：合格 ${s.qualified} 件，回收料头 ${(receipt.derivedRemnants || []).length} 块，母卷扣减 ${fmtM(deduction.total, 2)} m${deduction.skipped > .05 ? `（含跳过 ${fmtM(deduction.skipped, 2)} m）` : ''}`);
            full();
        } catch (e) {
            st.busy = ''; shell(true);
            toast('报工未完成，草稿已保留：' + e.message, true);
        }
    }
    function bindReport() {
        const box = el.querySelector('#report'); if (!box) return;
        const sc = scene(), seg = sc.segments.find(s => s.id === st.report.planId);
        box.querySelector('#report-close').onclick = closeReport;
        box.querySelector('#report-reset').onclick = () => { localStorage.removeItem(REPORT_KEY(seg.id)); st.report = defaultReport(seg, {remnant: !!roll?.remnant}); shell(true); };
        box.querySelector('#report-submit').onclick = submitReport;
        box.querySelector('[data-r="len"]')?.addEventListener('change', e => editReport(r => ({...r, len: Number(e.target.value) || 0})));
        box.querySelector('[data-r="location"]').onchange = e => editReport(r => ({...r, location: e.target.value}));
        box.querySelectorAll('[data-bulk]').forEach(b => b.onclick = () => editReport(r => applyBulk(r, b.dataset.bulk, seg)));
        box.querySelectorAll('[data-o]').forEach(s => s.onchange = () => editReport(r => ({...r, rows: {...r.rows, [s.dataset.o]: {outcome: s.value, reason: r.rows[s.dataset.o]?.reason || ''}}})));
        box.querySelectorAll('[data-why]').forEach(i => i.onchange = () => editReport(r => ({...r, rows: {...r.rows, [i.dataset.why]: {...r.rows[i.dataset.why], reason: i.value}}})));
        const cand = id => recoveryCandidates(seg, st.report).find(c => c.id === id);
        box.querySelectorAll('[data-use]').forEach(c => c.onchange = () => editReport(r => { const k = c.dataset.use, cur = r.rem[k] || {w: cand(k).w, l: cand(k).l}; return {...r, rem: {...r.rem, [k]: {...cur, use: c.checked}}}; }));
        box.querySelectorAll('[data-rw]').forEach(i => i.onchange = () => editReport(r => ({...r, rem: {...r.rem, [i.dataset.rw]: {...r.rem[i.dataset.rw], w: Number(i.value)}}})));
        box.querySelectorAll('[data-rl]').forEach(i => i.onchange = () => editReport(r => ({...r, rem: {...r.rem, [i.dataset.rl]: {...r.rem[i.dataset.rl], l: Number(i.value)}}})));
    }

    function bindExecution(sc) {
        const seg = sc.segments.find(s => s.id === sc.currentId); if (!seg) return;
        const view = executionForPlan(views, seg.id);
        el.querySelector('#exec-create')?.addEventListener('click', () => execAction('create', null, seg));
        el.querySelectorAll('[data-exec]').forEach(b => b.onclick = () => b.dataset.exec === 'cancel' ? (st.cancelling = true, shell(true)) : execAction(b.dataset.exec, view, seg));
        el.querySelector('#exec-cancel-submit')?.addEventListener('click', () => execAction('cancel', view, seg));
        el.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => {
            st.busy = '正在重试…'; shell(true);
            try { await writer.retry(b.dataset.retry); await reload(); toast('原操作已确认完成'); }
            catch (e) { toast(e.message, true); try { await reload(); } catch { /* 保留当前视图 */ } }
            st.busy = ''; shell(true);
        });
        // 报工记录：冲销与复检
        el.querySelector('#reverse-open')?.addEventListener('click', () => { st.reversing = !st.reversing; shell(true); });
        el.querySelector('#reverse-submit')?.addEventListener('click', async () => {
            const reason = el.querySelector('#reverse-reason').value.trim();
            if (!reason) return toast('请填写冲销原因', true);
            st.busy = '正在冲销…'; shell(true);
            try { await requestJSON('/api/cutting/reports/' + encodeURIComponent(seg.id) + '/reverse', {reason}); st.reversing = false; await reload(); st.selectedId = null; toast('报工已冲销，母卷用量与完成量已恢复'); }
            catch (e) { toast('冲销未完成：' + e.message, true); }
            st.busy = ''; full();
        });
        el.querySelector('#quality-open')?.addEventListener('click', () => {
            const report = (detail.reports || []).find(r => r.planId === seg.id);
            st.quality = emptyQualityForm(report, reviewablePieces(report)[0]?.pieceId); shell(true);
        });
        const qbox = el.querySelector('#quality'); if (!qbox) return;
        qbox.querySelector('#quality-close').onclick = () => { st.quality = null; shell(true); };
        qbox.querySelectorAll('[data-q]').forEach(i => i.onchange = () => { st.quality = {...st.quality, [i.dataset.q]: i.value}; shell(true); });
        qbox.querySelector('#quality-submit').onclick = async () => {
            const q = st.quality, piece = reviewablePieces(q.report).find(p => p.pieceId === Number(q.pieceId));
            if (!q.command) { const p = qualityProblems(q, piece); if (p.length) return toast(p[0], true); q.command = buildQualityCommand(q, crypto.randomUUID()); }
            st.busy = '正在提交复检…'; shell(true);
            try {
                await requestJSON('/api/cutting/reports/' + encodeURIComponent(q.report.planId) + '/quality-dispositions', q.command);
                st.quality = null; await reload(); toast(`复检已登记：${DISPOSITIONS[q.command.disposition]}，完成量已按结果调整`);
            } catch (e) {
                if (e.httpStatus === 400) st.quality = {...q, command: null, uncertain: false, error: e.message};
                else if (e.httpStatus === 409) st.quality = {...q, uncertain: false, error: e.message + '。请关闭后刷新报工记录再处理。'};
                else st.quality = {...q, uncertain: true, error: e.message + ' 结果尚未确认，输入已保留，请重试同一处置。'};
            }
            st.busy = ''; shell(true);
        };
    }

    function pickRollHtml() {
        const choices = rollChoices(), rems = remnantChoices(), rec = st.recommend;
        const recBy = new Map((rec?.result?.recommendations || []).map(x => [x.stock.id, x]));
        const remRows = [...rems].sort((a, b) => (recBy.get(b.id)?.pieceCount || 0) - (recBy.get(a.id)?.pieceCount || 0) || b.area - a.area);
        return `<div class="body"><div class="box" style="max-width:920px;margin:24px auto 12px">
          <div class="pane-h">选择母卷<span class="sub">型号 ${esc(task.materialModel)} · 待排 ${remaining().reduce((a, d) => a + d.demand, 0)} 件</span></div>
          ${choices.length ? `<table class="t" style="border:0"><thead><tr><th>卷号</th><th>材料</th><th class="r">幅宽</th><th class="r">剩余 / 总长</th><th class="r">疵点</th><th>库位</th><th></th></tr></thead><tbody>
          ${choices.map(id => { const r = allRolls.find(x => x.rollId === id) || {rollId: id}; const rem = r.currentRemainingLength ?? (r.totalLength - r.usedLength);
              return `<tr><td class="num">${esc(id)}</td><td>${esc(r.materialName || r.rollModel || '—')}</td><td class="r num">${fmtN(r.width)}</td><td class="r num">${fmtM(rem)} / ${fmtM(r.totalLength)} m</td><td class="r num">${r.defectsCount ?? (r.defects || []).length}</td><td>${esc(r.storageLocation || '—')}${occupied.has(id) ? ` <span class="tag warn" title="${esc(occupiedText(id))}">占用中</span>` : ''}</td><td><button class="btn sm ${occupied.has(id) ? '' : 'pri'}" data-roll="${esc(id)}">选用</button></td></tr>`; }).join('')}</tbody></table>`
            : `<div class="empty">没有型号为 ${esc(task.materialModel)} 且有余量的母卷。</div>`}</div>
          <div class="box" style="max-width:920px;margin:0 auto 24px">
          <div class="pane-h">在库料头<span class="sub">同型号可用 ${rems.length} 块 · 整块投料、优先消化余料</span><span class="sp"></span>
            <button class="btn sm" id="recommend" ${rems.length && !st.busy ? '' : 'disabled'}>${rec?.loading ? '试排中…' : '试排推荐'}</button></div>
          ${rec?.error ? `<div class="notice">${esc(rec.error)}</div>` : ''}
          ${rec?.result ? `<div class="muted" style="padding:6px 12px;font-size:12px">已评估 ${rec.result.evaluatedCount} / ${rec.result.candidateCount} 块${rec.result.deferredCount ? `，${rec.result.deferredCount} 块未评估` : ''}；推荐不扣库存、不保存方案，选用后重新计算。</div>` : ''}
          ${remRows.length ? `<table class="t" style="border:0"><thead><tr><th>料头</th><th class="r">宽 × 长</th><th class="r">面积</th><th>疵点</th><th>库位</th><th>来源</th><th class="r">试排</th><th></th></tr></thead><tbody>
          ${remRows.map(r => { const x = recBy.get(r.id); return `<tr><td class="num">${esc(r.id)}</td><td class="r num">${fmtN(r.width)} × ${fmtN(r.length)}</td><td class="r num">${fmtN(r.area, 2)} m²</td>
            <td>${r.hasDefect ? '<span class="tag warn">带疵</span>' : '无'}</td><td>${esc(r.location || '—')}</td><td class="num">${esc(r.sourceRollId || '—')}</td>
            <td class="r num">${x ? `${x.pieceCount} 件 · ${fmtN(x.utilization * (x.utilization <= 1 ? 100 : 1), 1)}%` : rec?.result ? '—' : ''}</td>
            <td><button class="btn sm ${x ? 'pri' : ''}" data-remnant="${esc(r.id)}">选用</button></td></tr>`; }).join('')}</tbody></table>`
            : '<div class="empty">没有同型号可用料头。报工时回收的料头会出现在这里。</div>'}</div></div>`;
    }

    /** 料头试排推荐：与计算同一请求（以首个同型号母卷作上下文），后端逐块试排并排序；不扣库存、不保存方案。 */
    async function recommend() {
        const ctxRoll = allRolls.find(r => rollChoices().includes(r.rollId)) || null;
        const rem = remnantChoices()[0];
        const base = ctxRoll ? {rollId: ctxRoll.rollId, rollModel: ctxRoll.rollModel, width: ctxRoll.width, totalLength: ctxRoll.totalLength, usedLength: ctxRoll.usedLength, defects: []}
            : remnantAsRoll(rem);
        const win = ctxRoll ? {start: ctxRoll.usedLength || 0, len: Math.min(task.process?.bedLength || 5000, ctxRoll.totalLength - (ctxRoll.usedLength || 0))} : {start: 0, len: rem.length};
        st.recommend = {loading: true}; shell(true);
        try {
            const input = buildSolveRequest({task, roll: base, win, completed: detail.completed, reserved: detail.reserved, settings: solverSettings()});
            if (!input.demands.length) throw new Error('需求已全部完成或已预约，没有待排件');
            st.recommend = {result: await requestJSON('/api/cutting/remnant-recommendations', {input, completedBaseline: detail.completed || {}, sourceRollId: null})};
        } catch (e) { st.recommend = {error: '推荐未完成：' + e.message}; }
        shell(true);
    }

    function sumHtml(sc, colors) {
        const total = summary?.total ?? task.demands.reduce((a, d) => a + d.quantity, 0), done = summary?.completed ?? 0;
        const fresh = st.fresh.length, defects = sc ? sc.defects.length : 0;
        return `<button class="sumb ${st.pop === 'demand' ? 'on' : ''}" data-pop="demand"><small>需求</small>${task.demands.length} 项 · 良品 ${done}/${total} ▾</button>
            <button class="sumb ${st.pop === 'material' ? 'on' : ''}" data-pop="material"><small>材料</small><span class="num">${esc(st.rollId || '未选')}</span>${roll ? ` · 余 ${fmtM(roll.currentRemainingLength ?? (roll.totalLength - roll.usedLength))} m` : ''} ▾</button>
            <button class="sumb ${fresh ? 'warn' : ''} ${st.pop === 'defect' ? 'on' : ''}" data-pop="defect"><small>疵点</small>${defects} 处${fresh ? ` · 新增 ${fresh}` : ''} ▾</button>
            <button class="sumb ${st.pop === 'process' ? 'on' : ''}" data-pop="process"><small>工艺</small>${isSlitting(task) ? `分切 ${task.slitting?.minWidth}–${task.slitting?.maxWidth} mm` : `拉布 ${fmtM(task.process?.bedLength || 0)} m`} · 基准 ${esc(originText(task.process?.cutOrigin))} ▾</button>
            ${st.pop ? `<div class="popover" id="popover">${popover(st.pop, sc, colors)}</div>` : ''}`;
    }
    function footHtml(sc) {
        const fresh = st.fresh.length, seg = sc?.segments.find(s => s.id === sc.currentId);
        const canSolve = sc && (!seg || seg.status === 'pending') && !isSlitting(task);
        return `${fresh ? `<span class="tag warn">画布新增疵点 ${fresh} 处未保存</span><button class="btn" id="save-defects" ${st.saving ? 'disabled' : ''}>保存疵点到母卷</button><button class="btn" id="drop-defects">放弃</button>` : ''}
          <span class="sp"></span>${st.busy ? `<span class="muted" style="font-size:12px">${esc(st.busy)}</span>` : '<span class="muted" style="font-size:12px">候选方案不扣减库存；确认报工后记账</span>'}
          ${canSolve && prefs.sideCollapsed ? `<button class="btn pri" id="solve-foot" ${st.busy ? 'disabled' : ''}>${seg ? '重新计算' : '计算本工位'}</button>` : ''}
          ${summary && !isSlitting(task) ? `<a class="btn" href="${esc(taskLink(summary))}">经典工作台继续 ↗</a>` : ''}`;
    }
    /** 只刷新摘要条、页脚和画布数据，保留相机。 */
    function chrome() {
        const sc = st.rollId && roll ? scene() : null, colors = demandColors(task.demands, plans);
        el.querySelector('#sum').innerHTML = sumHtml(sc, colors);
        el.querySelector('#foot').innerHTML = footHtml(sc);
        if (sc) { canvas?.setScene(sc); nav?.setScene(sc); }
        bindChrome(sc);
    }

    function popover(kind, sc, colors) {
        if (kind === 'demand') {
            const done = detail.completed || {}, reserved = detail.reserved || {};
            return `<div class="pane-h">需求<span class="sub">${task.demands.length} 项 · ${esc(task.externalRef || '')}</span><span class="sp"></span><a class="btn sm" href="#/task/${encodeURIComponent(task.id)}">编辑需求</a></div>
              <table class="t" style="border:0"><thead><tr><th>需求</th><th class="r">宽 × 长 mm</th><th class="r">数量</th><th class="r">良品</th><th class="r">预约</th></tr></thead><tbody>
              ${task.demands.map(d => `<tr><td class="wrap"><i style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${colors.get(d.id)}"></i>${esc(d.name)}</td><td class="r num">${fmtN(d.width, 1)} × ${fmtN(d.length, 1)}</td><td class="r num">${d.quantity}</td><td class="r num">${done[d.id] || 0}</td><td class="r num">${reserved[d.id] || 0}</td></tr>`).join('')}</tbody></table>`;
        }
        if (kind === 'material') {
            const choices = rollChoices();
            return `<div class="pane-h">材料<span class="sp"></span>${!roll?.remnant && choices.length > 1 ? `<select class="field" id="roll-pick">${choices.map(r => `<option ${r === st.rollId ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}<button class="btn sm" id="change-material">更换材料 / 用料头</button></div>
              ${roll?.remnant ? `<div class="kv"><div>料头</div><div class="num">${esc(roll.remnant.id)}</div><div>批次</div><div>${esc(roll.remnant.materialBatch || '—')}</div>
                <div>尺寸</div><div class="num">${fmtN(roll.width)} × ${fmtN(roll.totalLength)} mm</div><div>来源母卷</div><div class="num">${esc(roll.remnant.sourceRollId || '—')}</div>
                <div>库位</div><div>${esc(roll.remnant.location || '—')}</div><div>状态</div><div>${esc(roll.remnant.status)}</div><div>代数</div><div class="num">${roll.remnant.generation ?? 1}</div></div>`
              : roll ? `<div class="kv"><div>母卷</div><div class="num">${esc(roll.rollId)}</div><div>型号</div><div>${esc(roll.rollModel || '—')}</div><div>材料</div><div>${esc(roll.materialName || '—')}</div>
                <div>幅宽</div><div class="num">${fmtN(roll.width)} mm</div><div>总长 / 已用</div><div class="num">${fmtM(roll.totalLength)} m / ${fmtM(roll.usedLength)} m</div>
                <div>库位</div><div>${esc(roll.storageLocation || '—')}</div><div>批次</div><div>${esc(roll.batchNo || '—')}</div><div>验布</div><div>${esc(roll.inspectionStatus || '—')}</div></div>`
                : '<div class="empty">未选择母卷</div>'}`;
        }
        if (kind === 'defect') {
            return `<div class="pane-h">疵点<span class="sub">${sc ? sc.defects.length : 0} 处</span><span class="sp"></span><a class="btn sm" href="#/inspection/${encodeURIComponent(st.rollId || '')}">去跑布验疵</a></div>
              ${sc && sc.defects.length ? `<table class="t" style="border:0"><thead><tr><th>Y m</th><th class="r">X mm</th><th class="r">长 × 宽</th><th>说明</th><th></th></tr></thead><tbody>
              ${sc.defects.map(d => `<tr class="click" data-goto="${d.u}"><td class="num">${(d.u / 1000).toFixed(2)}</td><td class="r num">${fmtN(d.v, 1)}</td><td class="r num">${fmtN(d.du, 1)} × ${fmtN(d.dv, 1)}</td><td>${esc(d.label.split(' · ')[0])}</td><td>${d.fresh ? '<span class="tag warn">画布新增</span>' : '<span class="tag">已入档</span>'}</td></tr>`).join('')}</tbody></table>`
                : '<div class="empty">本卷没有疵点记录</div>'}
              ${st.fresh.length ? '<div class="notice">新增疵点保存后，后续工位排料会避让；已有方案需重新核对。</div>' : ''}`;
        }
        const p = task.process || {}, sp = task.slitting;
        if (isSlitting(task) && sp) return `<div class="pane-h">分切工艺<span class="sp"></span><a class="btn sm" href="#/task/${encodeURIComponent(task.id)}">修改参数</a></div>
          <div class="kv"><div>左 / 右切边</div><div class="num">${sp.leftTrim} / ${sp.rightTrim} mm</div><div>组合宽度</div><div class="num">${sp.minWidth}–${sp.maxWidth} mm · 步长 ${sp.widthStep}</div>
          <div>超产上限</div><div class="num">${sp.totalOverCap} 卷</div><div>切头</div><div class="num">${fmtN(p.trimStart)} mm</div><div>切割基准</div><div>${esc(originText(p.cutOrigin))}</div></div>`;
        return `<div class="pane-h">工艺<span class="sp"></span><a class="btn sm" href="#/task/${encodeURIComponent(task.id)}">修改工艺</a></div>
          <div class="kv"><div>拉布长度</div><div class="num">${fmtN(p.bedLength)} mm</div><div>切头</div><div class="num">${fmtN(p.trimStart)} mm</div>
          <div>切割基准</div><div>${esc(originText(p.cutOrigin))}</div><div>第一刀方向</div><div>${p.firstStageOrientation === 'vertical' ? '纵向' : '横向'}</div>
          <div>允许旋转</div><div>${p.allowRotation ? '是' : '否'}</div><div>允许纵切</div><div>${p.allowLongitudinal ? '是' : '否'}</div><div>件间距</div><div class="num">${fmtN(p.pieceGap, 1)} mm</div></div>`;
    }

    async function chooseRoll(id, source = 'roll') {
        st.source = source; st.rollId = id; st.selectedId = null; st.window = null; st.fresh = []; st.failure = null; st.recommend = null;
        await loadRoll(); full();
    }

    function bindChrome(sc) {
        el.querySelectorAll('[data-pop]').forEach(b => b.onclick = e => { e.stopPropagation(); st.pop = st.pop === b.dataset.pop ? null : b.dataset.pop; refresh(); });
        const pop = el.querySelector('#popover');
        undismiss?.(); undismiss = null;
        if (pop) undismiss = dismissOnOutside(el.querySelector('#sum'), () => { st.pop = null; refresh(); });
        el.querySelector('#roll-pick')?.addEventListener('change', e => { st.pop = null; chooseRoll(e.target.value); });
        el.querySelector('#change-material')?.addEventListener('click', () => { st.pop = null; st.rollId = null; roll = null; st.selectedId = null; st.window = null; full(); });
        el.querySelectorAll('[data-goto]').forEach(tr => tr.onclick = () => {
            const u = Number(tr.dataset.goto), s = sc.segments.find(x => u >= x.start && u < x.start + x.len);
            st.pop = null; if (s) { st.selectedId = s.id; st.window = null; } st.view = 'station'; full();
        });
        el.querySelector('#save-defects')?.addEventListener('click', saveDefects);
        el.querySelector('#drop-defects')?.addEventListener('click', () => { st.fresh = []; refresh(); });
        el.querySelector('#solve-foot')?.addEventListener('click', solve);
    }
    function bind(sc, savedCam = null) {
        bindChrome(sc);
        el.querySelectorAll('[data-roll]').forEach(b => b.onclick = () => chooseRoll(b.dataset.roll));
        el.querySelectorAll('[data-remnant]').forEach(b => b.onclick = () => chooseRoll(b.dataset.remnant, 'remnant'));
        el.querySelector('#recommend')?.addEventListener('click', recommend);
        if (!sc) return;
        el.querySelector('#side-toggle')?.addEventListener('click', () => { prefs.sideCollapsed = !prefs.sideCollapsed; savePrefs(prefs); shell(true); });
        el.querySelector('#report-open')?.addEventListener('click', () => { const seg = sc.segments.find(s => s.id === sc.currentId); if (seg) openReport(seg); });
        bindReport();
        bindExecution(sc);
        bindTools(sc);
        el.querySelector('#solve')?.addEventListener('click', solve);
        el.querySelector('#discard')?.addEventListener('click', discard);
        el.querySelector('#forward')?.addEventListener('click', forward);
        el.querySelector('#slit-solve')?.addEventListener('click', slitSolve);
        el.querySelector('#slit-export')?.addEventListener('click', slitExport);
        el.querySelectorAll('[data-car]').forEach(b => b.onclick = () => slitCar(b.dataset.car));
        const host = el.querySelector('#rc');
        canvas?.destroy(); nav?.destroy();
        canvas = createRollCanvas(host, {
            onCursor: c => { st.cursor = c; status(sc); },
            onCamera: ({ratio, percent}) => { const i = el.querySelector('#z-ratio'); if (i && document.activeElement !== i) i.value = formatRatio(ratio); const p = el.querySelector('#z-pct'); if (p) p.textContent = Math.round(percent) + '%'; },
            onDefectDraw: d => addFresh(d, sc),
            // 选中 / 拖动只更新画布场景与调整面板，不重建画布（重建会中断正在进行的拖动）
            onPieceSelect: id => { if (!st.adjust) return; st.adjust.selected = id; st.adjust.problem = null; canvas.setScene(scene()); patchAdjust(); },
            onPieceMove: (id, du, dv, done) => {
                const a = st.adjust; if (!mayAdjust()) return;
                a.dragBase ||= a.positions;
                proposePiece(id, movePiece(a.dragBase, planOf(a.planId), id, du, dv, a.dragBase), {done, base: a.dragBase});
                if (done) a.dragBase = null;
            },
            onEditCommand: command => {
                const a = st.adjust; if (!a || st.busy || checks[a.planId] || executionForPlan(views, a.planId)?.reservationActive) return;
                if (command.type === 'nudge') {
                    proposePiece(command.pieceId, movePiece(a.positions, planOf(a.planId), command.pieceId, command.du, command.dv, a.positions));
                } else if (['undo', 'redo', 'rotate'].includes(command.type)) el.querySelector('#adj-' + command.type)?.click();
            }
        });
        canvas.setOptions({vertical: prefs.vertical, view: st.view, fullMode: prefs.fullMode, tool: st.tool, mmPerPx: prefs.mmPerPx,
            showPath: !!st.showPath, showDimensions: prefs.showDimensions !== false, editable: !st.busy});
        canvas.setScene(sc, {refit: !savedCam});
        if (savedCam) canvas.setCamera(savedCam);
        nav = createRollNavigator(el.querySelector('#rn'), {
            onPick: id => { st.selectedId = id; st.window = null; st.failure = null; full(); },
            // 拖动时画布跟随：工位框停在屏幕原处，母卷随之移动
            onWindow: w => { st.window = w; const next = scene(); canvas.setScene(next, {follow: true}); nav.setScene(next); const i = el.querySelector('#bed-len'); if (i) i.value = Math.round(w.len); status(next); },
            onWindowEnd: () => { st.failure = null; shell(true); }
        });
        nav.setScene(sc);
        el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { st.view = b.dataset.view; prefs.view = st.view; savePrefs(prefs); full(); });
        el.querySelectorAll('[data-full]').forEach(b => b.onclick = () => { prefs.fullMode = b.dataset.full; savePrefs(prefs); full(); });
        el.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { st.tool = b.dataset.tool; el.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b)); canvas.setOptions({tool: st.tool}); });
        el.querySelector('#clear-measure').onclick = () => canvas.clearMeasure();
        el.querySelector('#dimensions-toggle').onclick = e => {
            prefs.showDimensions = prefs.showDimensions === false; savePrefs(prefs);
            e.currentTarget.classList.toggle('on', prefs.showDimensions); e.currentTarget.setAttribute('aria-pressed', String(prefs.showDimensions));
            canvas.setOptions({showDimensions: prefs.showDimensions});
        };
        el.querySelector('#orient').onclick = () => { prefs.vertical = !prefs.vertical; savePrefs(prefs); full(); };
        el.querySelector('#z-fit').onclick = () => canvas.fit();
        el.querySelector('#z-in').onclick = () => canvas.zoom(1.25);
        el.querySelector('#z-out').onclick = () => canvas.zoom(1 / 1.25);
        el.querySelector('#z-ratio').onchange = e => { const n = parseRatio(e.target.value); n ? canvas.setRatio(n) : toast('比例格式示例：1:20', true); };
        const order = [...sc.segments.map(s => s.id), NEW_STATION];
        const step = d => { const i = (sc.currentId ? order.indexOf(sc.currentId) : order.length - 1) + d; if (order[i]) { st.selectedId = order[i]; st.window = null; st.failure = null; full(); } };
        el.querySelector('#seg-prev').onclick = () => step(-1);
        el.querySelector('#seg-next').onclick = () => step(1);
        el.querySelector('#bed-len').onchange = e => {
            const v = Number(e.target.value);
            if (!sc.bed || sc.window.readOnly) return;
            if (!(v >= sc.bed.min && v <= sc.bed.max)) { toast(`拉布长度须在 ${sc.bed.min}–${sc.bed.max} mm`, true); e.target.value = Math.round(sc.window.len); return; }
            st.window = {start: sc.window.start, len: v}; st.failure = null; shell(true);
        };
        el.querySelectorAll('tr[data-seg]').forEach(tr => tr.onclick = () => { st.selectedId = tr.dataset.seg; st.window = null; st.failure = null; full(); });
        status(sc);
    }

    // ---- 计算 / 放弃 / 向后查找 ----
    function currentRequest() {
        const sc = scene(), w = sc.window;
        const problem = windowProblem(roll, w);
        if (problem) throw new Error(problem);
        if (st.fresh.length) throw new Error('画布有未保存的疵点，请先保存到母卷或放弃，再计算');
        const req = buildSolveRequest({task, roll, win: w, completed: detail.completed, reserved: detail.reserved, settings: solverSettings()});
        if (!req.demands.length) throw new Error('需求已全部完成或已预约，没有待排件');
        const seg = sc.segments.find(s => s.id === sc.currentId);
        return {req, replace: seg?.status === 'pending' ? seg.id : null};
    }
    async function accept(result, replace) {
        if (replace && replace !== result.planId) {
            try { await requestJSON('/api/cutting/plans/' + encodeURIComponent(replace) + '/cancel', {}); }
            catch (e) { toast('新方案已生成，但旧候选未能放弃：' + e.message, true); }
        }
        await reload();
        st.selectedId = result.planId; st.window = null; st.failure = null; st.busy = '';
        toast(`已生成候选方案 · ${result.pieces.length} 件 · 利用率 ${result.totalArea ? (result.pieceArea / result.totalArea * 100).toFixed(1) : '—'}%`);
        full();
    }
    async function solve() {
        let job;
        try { job = currentRequest(); } catch (e) { toast(e.message, true); return; }
        st.busy = '正在计算本工位…'; st.failure = null; shell(true);
        try {
            const result = await requestJSON('/api/solve', job.req);
            if (usablePlan(result)) return accept(result, job.replace);
            st.failure = {title: result.status === 'NO_SOLUTION_FOUND' ? '本工位未找到方案' : '本次未得到可用方案',
                message: result.message || '请检查需求、工艺或调整工位后重试。',
                canForward: result.status === 'NO_SOLUTION_FOUND' && (roll.defects || []).length > 0, job};
        } catch (e) { st.failure = {title: '计算未完成', message: e.message}; }
        st.busy = ''; shell(true);
    }
    async function forward() {
        const job = st.failure?.job; if (!job) return;
        st.busy = '正在向后查找可裁位置…'; shell(true);
        try {
            const found = await findForwardPlan(job.req, roll.defects || [], r => requestJSON('/api/solve', r), {
                onAttempt: (r, i, n) => { st.busy = `向后查找 ${i} / ${n} · Y ${(r.windowStartY / 1000).toFixed(2)} m`; const f = el.querySelector('#foot'); if (f) f.innerHTML = footHtml(scene()); }
            });
            if (found?.search.found) return accept(found.result, job.replace);
            st.failure = {title: '后续位置也未找到方案', message: found?.result?.message || '已检查后续可用位置。'};
        } catch (e) { st.failure = {title: '查找未完成', message: e.message}; }
        st.busy = ''; shell(true);
    }
    async function discard() {
        const sc = scene(), seg = sc.segments.find(s => s.id === sc.currentId);
        if (!seg || seg.status !== 'pending') return;
        st.busy = '正在放弃候选…'; shell(true);
        try { await requestJSON('/api/cutting/plans/' + encodeURIComponent(seg.id) + '/cancel', {}); await reload(); st.selectedId = null; st.window = null; toast('已放弃候选方案'); }
        catch (e) { toast('放弃失败：' + e.message, true); }
        st.busy = ''; full();
    }

    // ---- 一维分切：计算分切组合（v2 计算作业）→ 按组合逐车出车（校验后成为候选）→ 报工同二维 ----
    const session = new OptimizationSession();
    function slitBlock(sc) {
        const open = openDemands(remaining(), plans), need = open.reduce((a, d) => a + d.demand, 0), s = st.slit, r = s?.result;
        const head = `<div class="sec">一维分切 · 出车</div>
          <div class="kv"><div>待出</div><div class="num">${open.length} 项 · ${need} 卷</div><div>母卷幅宽</div><div class="num">${fmtN(roll.width)} mm</div>
            <div>下一车起点</div><div class="num">Y ${fmtM(sc.window.start, 2)} m</div></div>`;
        if (roll.remnant) return head + '<div class="notice">一维分切按母卷定长出车，请在“材料”中改选母卷。</div>';
        const solveBtn = `<button class="btn ${r ? '' : 'pri'}" id="slit-solve" ${st.busy || !need ? 'disabled' : ''}>${r ? '按剩余需求重新计算' : '计算分切组合'}</button>`;
        if (!r) return head + `<div style="display:flex;gap:8px;padding:8px 12px">${solveBtn}</div>
          <div class="muted" style="padding:0 12px 8px;font-size:11.5px">按所选母卷幅宽与任务分切参数计算组合；之后逐车出车，每车是母卷上一段“切头 + 卷长”的工位，报工后扣减母卷。</div>`;
        const missing = (r.fulfillment || []).reduce((a, f) => a + f.missing, 0), over = r.totalOverproduced || 0;
        const rows = (r.patterns || []).map(p => ({p, cars: usefulCars(p, open)}));
        return head + `${s.width !== Math.floor(roll.width) ? `<div class="notice">组合按幅宽 ${fmtN(s.width)} mm 计算，与当前母卷不一致，请重新计算。</div>` : ''}
          <div class="muted" style="padding:6px 12px;font-size:11.5px">${r.patterns.length} 个组合 · 计划 ${r.patterns.reduce((a, p) => a + p.repetitions, 0)} 车${missing ? ` · <span style="color:var(--warn)">缺 ${missing} 卷</span>` : ''}${over ? ` · 超产 ${over} 卷` : ''}</div>
          <table class="t" style="border:0"><thead><tr><th>组合（宽×条）</th><th class="r">卷长</th><th class="r">车</th><th></th></tr></thead><tbody>
          ${rows.map(({p, cars}) => `<tr><td class="wrap num">${esc(compositionText(p))}<div class="muted" style="font-size:11px">条宽 ${fmtN(p.patternWidthMm)} · 余宽 ${fmtN(spareWidth(p, s.width, task.slitting))} mm</div></td><td class="r num">${fmtM(p.lengthMm)} m</td>
            <td class="r num" title="可出 / 计划">${cars} / ${p.repetitions}</td><td><button class="btn sm ${cars ? 'pri' : ''}" data-car="${esc(p.id)}" ${cars && !st.busy && s.width === Math.floor(roll.width) ? '' : 'disabled'}>出一车</button></td></tr>`).join('')}</tbody></table>
          <div style="display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap">${solveBtn}<button class="btn" id="slit-export">导出方案</button></div>`;
    }
    async function slitSolve() {
        const open = openDemands(remaining(), plans);
        if (!open.length) return toast('没有待出的需求（候选已占用的条不重复计算）', true);
        st.busy = '正在计算分切组合…'; st.failure = null; shell(true);
        try {
            const width = Math.floor(roll.width);
            const {job, result} = await session.solve(slittingJob(task, width, open), {onProgress: j => { st.busy = `正在计算分切组合 · ${j.phase || j.state}`; }});
            if (!result.slitting?.patterns?.length) throw new Error(result.slitting?.status === 'NO_SOLUTION_FOUND' ? '在当前组合宽度范围内找不到可行组合，请调整分切参数' : (job.message || '未得到可用组合'));
            st.slit = {jobId: job.id, width, revision: task.revision, result: result.slitting};
            localStorage.setItem(SLIT_KEY(task.id), JSON.stringify({jobId: job.id, width, revision: task.revision}));
        } catch (e) { if (e.name !== 'AbortError') st.failure = {title: '分切计算未完成', message: e.message}; }
        st.busy = ''; shell(true);
    }
    async function slitCar(patternId) {
        const pattern = st.slit?.result?.patterns.find(p => p.id === patternId); if (!pattern) return;
        const {strips} = assignCar(pattern, openDemands(remaining(), plans), task.slitting?.leftTrim || 0);
        if (!strips.length) return toast('该组合已无剩余需求可出', true);
        const from = scene().window.start, len = (task.process?.trimStart || 0) + pattern.lengthMm;
        const start = carStart(roll, from, len, strips);
        if (start == null) return toast(from + len > roll.totalLength + .001 ? `母卷剩余长度不足一车（需 ${fmtM(len, 2)} m），请换卷`
            : `Y ${fmtM(from, 2)} m 之后没有连续 ${fmtM(len, 2)} m 且条区无疵点的区段，请换卷或调整卷长`, true);
        st.busy = '正在校验并出车…'; st.failure = null; shell(true);
        try {
            const result = await requestJSON('/api/cutting/slitting-cars', carRequest({task, roll, start, pattern, strips, settings: solverSettings()}));
            await reload(); st.selectedId = result.planId; st.window = null; st.busy = '';
            toast(`已出车 · ${strips.length} 条 · Y ${fmtM(start, 2)} m${start > from + .001 ? '（已避让疵点）' : ''}`);
            return full();
        } catch (e) { st.failure = {title: '出车未通过校验', message: e.message}; }
        st.busy = ''; shell(true);
    }
    async function slitExport() {
        try {
            const XLSX = await loadSheetLib(), r = st.slit.result, rows = patternRows(r, names, st.slit.width, task.slitting);
            const book = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['序号', '卷长(mm)', '组合(宽×条)', '条宽合计(mm)', '组合宽(mm)', '母卷幅宽(mm)', '余宽(mm)', '计划车数', '订单分配(卷)'],
                ...rows.map(x => [x.no, x.length, x.composition, x.patternWidth, x.comboWidth, x.motherWidth, x.spare, x.repetitions, x.allocations])]), '分切组合');
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['需求', '分切宽(mm)', '卷长(mm)', '需求卷数', '计划产出', '缺', '超产'],
                ...(r.fulfillment || []).map(f => { const d = task.demands.find(x => String(x.id) === String(f.orderId)) || {}; return [d.name || f.orderId, d.width, d.length, f.requested, f.produced, f.missing, f.overproduced]; })]), '履约');
            const cars = plans.filter(p => p.request?.taskId === task.id && p.status !== 'CANCELLED').map(p => [shortId(p.id), p.status === 'CONFIRMED' ? '已报工' : '候选', p.request.rollId, p.request.windowStartY / 1000, p.request.rollL,
                (p.result.pieces || []).map(x => `${x.w}`).join(' + ')]);
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['方案', '状态', '母卷', '起点(m)', '车长(mm)', '条宽(mm)'], ...cars]), '已出车');
            XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['任务', task.name], ['材料型号', task.materialModel], ['计算母卷幅宽(mm)', st.slit.width],
                ['方案性质', '计划分切组合；按车出车并报工后才扣减母卷与计入完成'], ['计算作业', st.slit.jobId]]), '说明');
            XLSX.writeFile(book, `分切方案-${shortId(task.id)}.xlsx`);
        } catch (e) { toast('导出失败：' + e.message, true); }
    }
    /** 恢复上次分切计算（同一任务版本）；结果在服务端保存，只记作业号。 */
    async function restoreSlit() {
        const saved = JSON.parse(localStorage.getItem(SLIT_KEY(task.id)) || 'null');
        if (!saved || saved.revision !== task.revision) return;
        try {
            const result = await requestJSON('/api/v2/optimization-results/' + encodeURIComponent(saved.jobId));
            if (result.slitting?.patterns?.length) { st.slit = {...saved, result: result.slitting}; if (!st.busy) shell(true); }
        } catch { localStorage.removeItem(SLIT_KEY(task.id)); }
    }

    function status(sc) {
        const c = st.cursor, w = sc.window;
        setStatus(`<span>光标 <span class="num">${c ? `X ${fmtN(c.v, 1)} mm · Y ${(c.u / 1000).toFixed(3)} m` : '—'}</span></span>
          <span>工位 <span class="num">${fmtM(w.start, 2)}–${fmtM(w.start + w.len, 2)} m</span></span><span class="sp"></span>
          <span>母卷 ${esc(st.rollId)}</span><span>CutPlan v2</span>`);
    }

    function addFresh(d, sc) {
        try {
            const def = validateDefect({x: round(d.v), y: round(d.u), w: round(d.dv), h: round(d.du), margin: 20},
                {width: sc.roll.width, totalLength: sc.roll.total});
            st.fresh.push({u: def.y, v: def.x, du: def.h, dv: def.w, margin: def.margin, label: `画布标记 · Y ${(def.y / 1000).toFixed(2)} m`});
            refresh();
        } catch (e) { toast(e.message, true); }
    }

    async function saveDefects() {
        if (!roll || !st.fresh.length) return;
        st.saving = true; refresh();
        try {
            roll = await requestJSON('/api/rolls/' + encodeURIComponent(roll.rollId) + '/inspection-defects', {
                width: roll.width, totalLength: roll.totalLength,
                defects: st.fresh.map(d => ({x: d.v, y: d.u, w: d.dv, h: d.du, margin: d.margin, defectType: 'MANUAL_MARK', typeName: '画布标记',
                    detectionSource: 'MANUAL_INSPECT', avoidanceStrategy: 'MUST_AVOID', description: '排料工作台画布标记', captureId: crypto.randomUUID()}))
            });
            st.fresh = []; toast('疵点已保存到母卷');
        } catch (e) { toast('保存失败，标记仍保留在页面：' + e.message, true); }
        st.saving = false; shell(true);
    }

    // refresh：只刷新摘要条、页脚与画布数据（保留相机）；full：整页重绘并重新取景
    function refresh() { chrome(); }
    function full() { shell(); }
    full();
    if (isSlitting(task)) restoreSlit();
    return () => { canvas?.destroy(); nav?.destroy(); undismiss?.(); session.cancel(); };
}

function originText(o) { return {'right-bottom': '右下', 'left-bottom': '左下', 'right-top': '右上', 'left-top': '左上'}[o] || o || '—'; }

async function pickTask(el) {
    let rows;
    try { rows = await requestJSON('/api/cutting/task-summaries'); } catch (e) { el.innerHTML = errorBox(e); return; }
    const open = rows.filter(r => r.status !== 'COMPLETED').reverse();
    el.innerHTML = `<div class="ph"><h1>排料工作台</h1><span class="crumb">选择一个任务打开</span></div>
      <div class="body">${open.length ? `<table class="t"><thead><tr><th>任务号</th><th>名称</th><th>材料型号</th><th>状态</th><th class="r">良品 / 需求</th><th></th></tr></thead><tbody>
      ${open.map(r => `<tr class="click" onclick="location.hash='#/workbench/${encodeURIComponent(r.task.id)}'"><td class="num">${shortId(r.task.id)}</td><td>${esc(r.task.name)}</td><td>${esc(r.task.materialModel)}</td>
        <td><span class="tag ${TAG[r.status] || ''}">${esc(taskLabels[r.status] || r.status)}</span></td><td class="r num">${r.completed} / ${r.total}</td><td><a class="btn sm" href="#/workbench/${encodeURIComponent(r.task.id)}">打开</a></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">没有进行中的任务</div>'}</div>`;
}
