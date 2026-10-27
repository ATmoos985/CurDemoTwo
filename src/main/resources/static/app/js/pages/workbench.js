// 排料工作台：读取任务、方案、报工与母卷档案，交给画布与导航条渲染。
// 本页可选料、按工位计算（/api/solve）、重新计算与放弃候选；报工仍在经典工作台完成。画布标记的疵点可保存到母卷。
import {requestJSON, esc, fmtM, fmtN, shortId, errorBox, toast, loadPrefs, savePrefs, dismissOnOutside, solverSettings} from '../util.js';
import {setStatus} from '../main.js';
import {createRollCanvas} from '../canvas/roll-canvas.js';
import {createRollNavigator} from '../canvas/roll-navigator.js';
import {parseRatio, formatRatio} from '../canvas/camera.js';
import {buildRollScene, rollsOfPlans, sceneMetrics, demandColors, demandIndex, STATUS_TEXT, NEW_STATION} from '../model/roll-scene.js';
import {buildSolveRequest, windowProblem, usablePlan, remainingDemands} from '../model/solve-request.js';
import {taskLabels, taskLink} from '../../../js/business/cutting/task-list-model.js';
import {validateDefect, round} from '../../../js/inspection/inspection-model.js';
import {findForwardPlan} from '../../../js/business/cutting/forward-search.js';

const STAGES = ['需求', '材料', '排料', '执行', '报工'];
const STAGE_OF = {PLAN_PENDING: 2, EXECUTION_PENDING: 3, REPORT_PENDING: 4, ATTENTION: 4, COMPLETED: 5};
const TAG = {PLAN_PENDING: 'idle', EXECUTION_PENDING: 'run', REPORT_PENDING: 'warn', ATTENTION: 'err', COMPLETED: 'ok'};
const SEG_TAG = {cut: 'ok', pending: 'warn', stale: '', other: ''};

export async function mount(el, [taskId]) {
    if (!taskId) return pickTask(el);
    let detail, plans, summary, allRolls, roll = null;
    async function loadTask() {
        [detail, plans, summary] = await Promise.all([
            requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId)),
            requestJSON('/api/cutting/tasks/' + encodeURIComponent(taskId) + '/plans'),
            requestJSON('/api/cutting/task-summaries').then(rows => rows.find(r => r.task.id === taskId) || null)
        ]);
    }
    try { await Promise.all([loadTask(), requestJSON('/api/rolls').then(r => { allRolls = r; })]); }
    catch (e) { el.innerHTML = errorBox(e); return; }
    let task = detail.task, names = demandIndex(task.demands, plans);
    const prefs = loadPrefs();
    const st = {rollId: rollsOfPlans(plans)[0] || null, selectedId: null, window: null, fresh: [], tool: 'pan', view: prefs.view,
        pop: null, cursor: null, saving: false, busy: '', failure: null};
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
        try { roll = await requestJSON('/api/rolls/' + encodeURIComponent(st.rollId)); }
        catch (e) { toast('母卷档案读取失败：' + e.message, true); }
    }
    async function reload() {
        await Promise.all([loadTask(), loadRoll()]);
        task = detail.task; names = demandIndex(task.demands, plans);
    }
    await loadRoll();

    const scene = () => buildRollScene({roll, plans, reports: detail.reports, rollId: st.rollId, demands: task.demands,
        process: task.process, freshDefects: st.fresh, selectedId: st.selectedId, window: st.window});
    const remaining = () => remainingDemands(task, detail.completed, detail.reserved);

    /** keepCamera：重绘外壳但保留画布视角（拖动工位结束、切换右栏等）。 */
    function shell(keepCamera = false) {
        const savedCam = keepCamera ? canvas?.getCamera() : null;
        const sc = st.rollId && roll ? scene() : null, met = sc ? sceneMetrics(sc) : null;
        const seg = sc?.segments.find(s => s.id === sc.currentId) || null;
        const order = sc ? [...sc.segments.map(s => s.id), NEW_STATION] : [], idx = sc ? (seg ? order.indexOf(seg.id) : order.length - 1) : -1;
        const total = summary?.total ?? task.demands.reduce((a, d) => a + d.quantity, 0), done = summary?.completed ?? 0;
        const stage = STAGE_OF[summary?.status] ?? (st.rollId ? 2 : 1);
        const colors = demandColors(task.demands, plans);
        el.innerHTML = `
        <div class="wb-head"><h1>${esc(task.name)}</h1><span class="num muted">${shortId(task.id)}</span>
          <span class="tag kind">二维 · ${esc(task.materialModel || '—')}</span>
          ${summary ? `<span class="tag ${TAG[summary.status] || ''}">${esc(taskLabels[summary.status] || summary.status)}</span>` : ''}
          <span class="sp"></span><div class="sum" id="sum">${sumHtml(sc, colors)}</div>
          <span class="vsep"></span><a class="btn" href="#/tasks">返回任务</a>${summary ? `<a class="btn" href="${esc(taskLink(summary))}">经典工作台 ↗</a>` : ''}</div>
        <div class="stages">${STAGES.map((s, i) => `<div class="stage ${i < stage ? 'done' : i === stage ? 'on' : ''}"><span class="n">${i < stage ? '✓' : i + 1}</span>${s}</div>`).join('')}</div>
        ${!sc ? pickRollHtml() : `
        <div class="split" style="grid-template-columns:1fr ${prefs.sideCollapsed ? '28px' : '300px'}">
          <section class="pane" style="background:var(--canvas)">
            <div class="ctool">
              <div class="vseg"><button data-view="station" class="${st.view === 'station' ? 'on' : ''}" title="对准当前工位">工位</button><button data-view="full" class="${st.view === 'full' ? 'on' : ''}" title="显示整卷">全卷</button></div>
              ${st.view === 'full' ? `<div class="vseg" title="全卷显示方式"><button data-full="strip" class="${prefs.fullMode === 'strip' ? 'on' : ''}">整条</button><button data-full="tile" class="${prefs.fullMode === 'tile' ? 'on' : ''}">平铺</button></div>` : ''}
              <div class="div"></div><button id="z-fit" title="适应视图">适应</button><button id="z-out" title="缩小">−</button>
              <input id="z-ratio" class="cin num" list="ratios" title="精确比例：输入 1:N 回车"><datalist id="ratios">${[5, 10, 20, 50, 100, 200, 500].map(n => `<option>1:${n}</option>`).join('')}</datalist>
              <button id="z-in" title="放大">+</button><span id="z-pct" class="num" style="min-width:40px"></span>
              <div class="div"></div><button id="seg-prev" title="上一段" ${idx <= 0 ? 'disabled' : ''}>◀</button><span class="num" style="color:#fff">${seg ? `${idx + 1} / ${sc.segments.length}` : '新工位'}</span><button id="seg-next" title="下一段 / 新工位" ${idx >= order.length - 1 ? 'disabled' : ''}>▶</button>
              <div class="div"></div><div class="vseg">${[['pan', '平移'], ['measure', '测量'], ['defect', '标疵点']].map(([k, t]) => `<button data-tool="${k}" class="${st.tool === k ? 'on' : ''}">${t}</button>`).join('')}</div>
              <button id="clear-measure" title="清除测量">✕ 测量</button>
              <button id="orient" title="画布方向（不影响坐标与算法）">${prefs.vertical ? '竖向 ⇅' : '横向 ⇆'}</button>
              <span class="sp"></span><span>拉布</span><input id="bed-len" class="cin num" value="${Math.round(sc.window.len)}" title="本次拉布长度（mm）"><span>mm</span>
            </div>
            <div class="canvas-wrap"><div id="rc"></div>
              <div class="legend">${task.demands.slice(0, 6).map(d => `<span><i style="background:${colors.get(d.id)}"></i>${esc(String(d.name).slice(0, 18))}</span>`).join('')}${task.demands.length > 6 ? `<span>… 共 ${task.demands.length} 项</span>` : ''}<span><i style="border:1.5px solid #ff6b5b"></i>疵点</span></div>
            </div>
            <div class="navroll"><div class="nr-head"><span>母卷 <b class="num">${esc(st.rollId)}</b></span><span>幅宽 <b class="num">${fmtN(sc.roll.width)}</b> mm</span><span>总长 <b class="num">${fmtM(sc.roll.total)}</b> m</span><span>已用 <b class="num">${fmtM(sc.roll.used)}</b> m</span>
              <span>本任务 已切 <b class="num">${met.cut}</b> · 候选 <b class="num">${met.pending}</b>${met.stale ? ` · 已失效 <b class="num">${met.stale}</b>` : ''}</span></div><div id="rn"></div></div>
          </section>
          ${prefs.sideCollapsed ? `<section class="pane side-min"><button id="side-toggle" title="展开右栏">«</button><span>方案指标</span></section>` : `<section class="pane">
            <div class="pane-h">方案指标<span class="sub">本卷</span><span class="sp"></span><button class="btn sm" id="side-toggle" title="收起右栏">»</button></div>
            <div class="pane-b">
              <div class="metric"><div><small>利用率</small><b>${met.utilization.toFixed(1)}<em>%</em></b></div><div><small>用布长度</small><b>${fmtM(met.length, 2)}<em>m</em></b></div>
                <div><small>拉布次数</small><b>${met.spreads}</b></div><div><small>任务完成</small><b>${total ? Math.round(done / total * 100) : 0}<em>%</em></b></div></div>
              ${sidePanel(sc, seg, idx)}
              <div class="sec">拉布段</div>
              <table class="t" style="border:0"><tbody>${sc.segments.map((s, i) => `<tr class="click ${s.id === sc.currentId ? 'sel' : ''}" data-seg="${esc(s.id)}"><td class="num">${i + 1}</td><td class="num">${fmtM(s.start, 2)} m</td><td class="r num">${fmtN(s.len)} mm</td><td><span class="tag ${SEG_TAG[s.status]}">${STATUS_TEXT[s.status]}</span></td></tr>`).join('')}
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
        const busy = st.busy ? `<div class="notice" style="border-color:#c9d8e8;background:#f2f6fb;color:var(--accent-ink)">${esc(st.busy)}</div>` : '';
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
          ${seg.status === 'pending' ? `${w.adjusted ? `<div class="notice">工位已调整为 Y ${fmtM(w.start, 2)} m · ${fmtN(w.len)} mm，重新计算后替换当前候选。</div>` : ''}${problem ? `<div class="notice">${esc(problem)}</div>` : ''}${busy}${failure}
            <div style="display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap"><button class="btn pri" id="solve" ${st.busy || problem || !need ? 'disabled' : ''}>重新计算</button><button class="btn" id="discard" ${st.busy ? 'disabled' : ''}>放弃候选</button>
              ${summary ? `<a class="btn" href="${esc(taskLink(summary))}">报工 ↗</a>` : ''}</div>` : ''}
          <div class="sec">本次未排入</div>
          ${unplaced.length ? `<table class="t" style="border:0"><tbody>${unplaced.map(f => `<tr><td class="wrap">${esc(names.get(f.demandId)?.name || `需求 ${f.demandId}`)}</td><td class="r num" style="color:var(--warn)">缺 ${f.unplaced}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">本段需求全部排入</div>'}`;
    }

    function pickRollHtml() {
        const choices = rollChoices();
        return `<div class="body"><div class="box" style="max-width:860px;margin:24px auto">
          <div class="pane-h">选择母卷<span class="sub">型号 ${esc(task.materialModel)} · 待排 ${remaining().reduce((a, d) => a + d.demand, 0)} 件</span></div>
          ${choices.length ? `<table class="t" style="border:0"><thead><tr><th>卷号</th><th>材料</th><th class="r">幅宽</th><th class="r">剩余 / 总长</th><th class="r">疵点</th><th>库位</th><th></th></tr></thead><tbody>
          ${choices.map(id => { const r = allRolls.find(x => x.rollId === id) || {rollId: id}; const rem = r.currentRemainingLength ?? (r.totalLength - r.usedLength);
              return `<tr><td class="num">${esc(id)}</td><td>${esc(r.materialName || r.rollModel || '—')}</td><td class="r num">${fmtN(r.width)}</td><td class="r num">${fmtM(rem)} / ${fmtM(r.totalLength)} m</td><td class="r num">${r.defectsCount ?? (r.defects || []).length}</td><td>${esc(r.storageLocation || '—')}</td><td><button class="btn sm pri" data-roll="${esc(id)}">选用</button></td></tr>`; }).join('')}</tbody></table>`
            : `<div class="empty">没有型号为 ${esc(task.materialModel)} 且有余量的母卷。</div>`}
          <div class="foot" style="background:#fff"><span class="muted" style="font-size:12px">料头投料仍在经典工作台进行</span></div></div></div>`;
    }

    function sumHtml(sc, colors) {
        const total = summary?.total ?? task.demands.reduce((a, d) => a + d.quantity, 0), done = summary?.completed ?? 0;
        const fresh = st.fresh.length, defects = sc ? sc.defects.length : 0;
        return `<button class="sumb ${st.pop === 'demand' ? 'on' : ''}" data-pop="demand"><small>需求</small>${task.demands.length} 项 · 良品 ${done}/${total} ▾</button>
            <button class="sumb ${st.pop === 'material' ? 'on' : ''}" data-pop="material"><small>材料</small><span class="num">${esc(st.rollId || '未选')}</span>${roll ? ` · 余 ${fmtM(roll.currentRemainingLength ?? (roll.totalLength - roll.usedLength))} m` : ''} ▾</button>
            <button class="sumb ${fresh ? 'warn' : ''} ${st.pop === 'defect' ? 'on' : ''}" data-pop="defect"><small>疵点</small>${defects} 处${fresh ? ` · 新增 ${fresh}` : ''} ▾</button>
            <button class="sumb ${st.pop === 'process' ? 'on' : ''}" data-pop="process"><small>工艺</small>拉布 ${fmtM(task.process?.bedLength || 0)} m · 基准 ${esc(originText(task.process?.cutOrigin))} ▾</button>
            ${st.pop ? `<div class="popover" id="popover">${popover(st.pop, sc, colors)}</div>` : ''}`;
    }
    function footHtml(sc) {
        const fresh = st.fresh.length, seg = sc?.segments.find(s => s.id === sc.currentId);
        const canSolve = sc && (!seg || seg.status === 'pending');
        return `${fresh ? `<span class="tag warn">画布新增疵点 ${fresh} 处未保存</span><button class="btn" id="save-defects" ${st.saving ? 'disabled' : ''}>保存疵点到母卷</button><button class="btn" id="drop-defects">放弃</button>` : ''}
          <span class="sp"></span>${st.busy ? `<span class="muted" style="font-size:12px">${esc(st.busy)}</span>` : '<span class="muted" style="font-size:12px">候选方案不占用库存；报工在经典工作台完成</span>'}
          ${canSolve && prefs.sideCollapsed ? `<button class="btn pri" id="solve-foot" ${st.busy ? 'disabled' : ''}>${seg ? '重新计算' : '计算本工位'}</button>` : ''}
          ${summary ? `<a class="btn" href="${esc(taskLink(summary))}">经典工作台继续 ↗</a>` : ''}`;
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
            return `<div class="pane-h">需求<span class="sub">${task.demands.length} 项</span><span class="sp"></span><span class="sub">${esc(task.externalRef || '')}</span></div>
              <table class="t" style="border:0"><thead><tr><th>需求</th><th class="r">宽 × 长 mm</th><th class="r">数量</th><th class="r">良品</th><th class="r">预约</th></tr></thead><tbody>
              ${task.demands.map(d => `<tr><td class="wrap"><i style="display:inline-block;width:8px;height:8px;margin-right:6px;background:${colors.get(d.id)}"></i>${esc(d.name)}</td><td class="r num">${fmtN(d.width, 1)} × ${fmtN(d.length, 1)}</td><td class="r num">${d.quantity}</td><td class="r num">${done[d.id] || 0}</td><td class="r num">${reserved[d.id] || 0}</td></tr>`).join('')}</tbody></table>`;
        }
        if (kind === 'material') {
            const choices = rollChoices();
            return `<div class="pane-h">材料<span class="sp"></span>${choices.length > 1 ? `<select class="field" id="roll-pick">${choices.map(r => `<option ${r === st.rollId ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}</div>
              ${roll ? `<div class="kv"><div>母卷</div><div class="num">${esc(roll.rollId)}</div><div>型号</div><div>${esc(roll.rollModel || '—')}</div><div>材料</div><div>${esc(roll.materialName || '—')}</div>
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
        const p = task.process || {};
        return `<div class="pane-h">工艺<span class="sp"></span><span class="sub">在经典工作台修改</span></div>
          <div class="kv"><div>拉布长度</div><div class="num">${fmtN(p.bedLength)} mm</div><div>切头</div><div class="num">${fmtN(p.trimStart)} mm</div>
          <div>切割基准</div><div>${esc(originText(p.cutOrigin))}</div><div>第一刀方向</div><div>${p.firstStageOrientation === 'vertical' ? '纵向' : '横向'}</div>
          <div>允许旋转</div><div>${p.allowRotation ? '是' : '否'}</div><div>允许纵切</div><div>${p.allowLongitudinal ? '是' : '否'}</div><div>件间距</div><div class="num">${fmtN(p.pieceGap, 1)} mm</div></div>`;
    }

    async function chooseRoll(id) {
        st.rollId = id; st.selectedId = null; st.window = null; st.fresh = []; st.failure = null;
        await loadRoll(); full();
    }

    function bindChrome(sc) {
        el.querySelectorAll('[data-pop]').forEach(b => b.onclick = e => { e.stopPropagation(); st.pop = st.pop === b.dataset.pop ? null : b.dataset.pop; refresh(); });
        const pop = el.querySelector('#popover');
        undismiss?.(); undismiss = null;
        if (pop) undismiss = dismissOnOutside(el.querySelector('#sum'), () => { st.pop = null; refresh(); });
        el.querySelector('#roll-pick')?.addEventListener('change', e => { st.pop = null; chooseRoll(e.target.value); });
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
        if (!sc) return;
        el.querySelector('#side-toggle').onclick = () => { prefs.sideCollapsed = !prefs.sideCollapsed; savePrefs(prefs); shell(true); };
        el.querySelector('#solve')?.addEventListener('click', solve);
        el.querySelector('#discard')?.addEventListener('click', discard);
        el.querySelector('#forward')?.addEventListener('click', forward);
        const host = el.querySelector('#rc');
        canvas?.destroy(); nav?.destroy();
        canvas = createRollCanvas(host, {
            onCursor: c => { st.cursor = c; status(sc); },
            onCamera: ({ratio, percent}) => { const i = el.querySelector('#z-ratio'); if (i && document.activeElement !== i) i.value = formatRatio(ratio); const p = el.querySelector('#z-pct'); if (p) p.textContent = Math.round(percent) + '%'; },
            onDefectDraw: d => addFresh(d, sc)
        });
        canvas.setOptions({vertical: prefs.vertical, view: st.view, fullMode: prefs.fullMode, tool: st.tool, mmPerPx: prefs.mmPerPx});
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
    return () => { canvas?.destroy(); nav?.destroy(); undismiss?.(); };
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
