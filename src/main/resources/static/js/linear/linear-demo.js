import {independentBaseline, planSummary, layout, escapeHtml as esc} from './linear-model.js';
import {LINEAR_SCENARIOS} from './linear-scenarios.js';
import {industry} from '../industry/industry-profiles.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const draftKey = 'cutdemo.linear.draft.v1', taskKey = 'cutdemo.linear.task.v1';
const SCENARIOS = industry('roll').scenarios.map(item => ({...item, ...LINEAR_SCENARIOS[item.key]}));
const METHODS = [
    {id: 'baseline', name: '逐单独立分切', hint: '每种规格单独开卷，不搭配'},
    {id: 'FAST', name: '搭切 · 快速', hint: '搭切求解器，快速计算', idle: '等待计算…'},
    {id: 'QUALITY', name: '搭切 · 精细', hint: '搭切求解器，精细优化', idle: '按需运行：耗时更长，母卷用量通常与快速一致。'}
];
const state = {scenario: SCENARIOS[0], epoch: 0, runs: {}, view: 'FAST'};

const pct = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const seconds = ms => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const running = () => Object.values(state.runs).some(run => run.status === 'running');

async function api(path, options = {}) {
    const response = await fetch('/api/linear' + path, {...options, headers: {'Content-Type': 'application/json', ...options.headers}, cache: 'no-store'});
    if (response.status === 204) { await response.text(); return null; }
    const data = await response.json().catch(() => ({message: `请求失败（${response.status}）`}));
    if (!response.ok) throw Object.assign(Error(data.message || '请求失败，请重试。'), {status: response.status});
    return data;
}

/** 读完结果后释放服务端任务；任务仍在计算（409）时隔几秒再试。释放失败只会让任务多留到自动过期，不影响页面。 */
async function release(taskId) {
    for (let attempt = 0; attempt < 150; attempt++) {
        try { await api(`/tasks/${taskId}`, {method: 'DELETE'}); return; }
        catch (error) { if (error.status !== 409) return; }
        await sleep(2000);
    }
}

async function solve(profile) {
    const {epoch, scenario} = state, run = state.runs[profile] = {status: 'running', startedAt: performance.now()};
    let taskId = null;
    render();
    try {
        ({taskId} = await api('/tasks', {method: 'POST', body: JSON.stringify({...scenario.input, profile})}));
        for (;;) {
            await sleep(profile === 'FAST' ? 500 : 1000);
            if (epoch !== state.epoch) return;
            const snapshot = await api(`/tasks/${taskId}`);
            if (snapshot.status === 'RUNNING') continue;
            if (snapshot.status === 'FAILED' || !snapshot.preview?.preview) throw Error(snapshot.message || '求解失败，请重试。');
            const plan = snapshot.preview.preview.map(({comboExpanded, usageCount, length, surfaceTreatment}) => ({comboExpanded, usageCount, length, surfaceTreatment}));
            Object.assign(run, {status: 'done', plan, summary: planSummary(plan, scenario.input), solverMs: snapshot.result.executionTimeMs});
            return;
        }
    } catch (error) {
        if (epoch === state.epoch) Object.assign(run, {status: 'failed', message: error.message});
    } finally {
        if (taskId) release(taskId);
        if (epoch === state.epoch) render();
    }
}

function select(key) {
    const scenario = SCENARIOS.find(item => item.key === key) ?? SCENARIOS[0], plan = independentBaseline(scenario.input);
    Object.assign(state, {scenario, view: 'FAST', epoch: state.epoch + 1});
    state.runs = {baseline: {status: 'done', plan, summary: planSummary(plan, scenario.input)}, FAST: {status: 'idle'}, QUALITY: {status: 'idle'}};
    history.replaceState(null, '', `?scenario=${scenario.key}`);
    solve('FAST');
}

function saving(saved, total) {
    if (saved > 0) return `<span class="gain">少 ${saved} 卷 · −${pct(saved / total * 100)}%</span>`;
    return saved === 0 ? '相同' : `<span class="loss">多 ${-saved} 卷</span>`;
}

function balance({surplus, shortage}) {
    const parts = [shortage ? `<span class="loss">缺 ${shortage} 卷</span>` : '', surplus ? `+${surplus} 卷` : ''].filter(Boolean);
    return parts.join(' / ') || '0';
}

function renderScenarios() {
    $('scenario-tabs').innerHTML = SCENARIOS.map(item => `<button type="button" data-scenario="${item.key}" aria-pressed="${item === state.scenario}"><strong>${esc(item.name)}</strong><span>${esc(item.note)}</span></button>`).join('');
    const {input, lengthUnit} = state.scenario;
    $('input-summary').innerHTML = [['母卷幅宽', `${input.motherWidth} mm`], ['左右切边', `${input.leftTrim} / ${input.rightTrim} mm`],
        ['可切区', `${input.motherWidth - input.leftTrim - input.rightTrim} mm`], ['组合宽度', `${input.minWidth}–${input.maxWidth} mm`],
        ['步长', `${input.step} mm`], ['超产上限', `${input.totalOverCap} 卷`]].map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('');
    $('length-head').textContent = `卷长 ${lengthUnit}`;
    $('order-rows').innerHTML = input.orderItems.map(order => `<tr><td>${esc(order.messageText)}</td><td class="num">${order.width}</td><td class="num">${order.quantity}</td><td class="num">${order.length}</td><td>${esc(order.surfaceTreatment)}</td></tr>`).join('');
}

function renderTable() {
    const base = state.runs.baseline.summary;
    $('compare-rows').innerHTML = METHODS.map(method => {
        const run = state.runs[method.id], name = `<th scope="row">${method.name}<small>${method.hint}</small></th>`;
        const note = (text, last) => `<tr>${name}<td colspan="5" class="cell-note ${run.status}">${text}</td><td>${last}</td></tr>`;
        if (run.status === 'running') return note('计算中…', `已用 ${seconds(performance.now() - run.startedAt)}`);
        if (run.status === 'failed') return note(esc(run.message), `<button type="button" class="tool-btn" data-run="${method.id}">重试</button>`);
        if (run.status === 'idle') return note(method.idle, `<button type="button" class="tool-btn" data-run="${method.id}">运行</button>`);
        const {summary} = run, solver = method.id !== 'baseline';
        return `<tr class="${solver ? 'solver-row' : ''}">${name}<td class="num">${summary.rolls}<small> 卷</small></td><td>${solver ? saving(base.rolls - summary.rolls, base.rolls) : '—'}</td>`
            + `<td class="num">${pct(summary.rate)}<small>%</small></td><td class="num">${balance(summary)}</td><td class="num">${summary.groups}</td><td class="num">${solver ? seconds(run.solverMs) : '即时'}</td></tr>`;
    }).join('');
}

function renderStatus() {
    const base = state.runs.baseline.summary.rolls, parts = [];
    for (const method of METHODS.slice(1)) {
        const run = state.runs[method.id], saved = run.summary ? base - run.summary.rolls : 0;
        if (run.status === 'running') parts.push(`${method.name}：计算中，已用 ${seconds(performance.now() - run.startedAt)}${method.id === 'QUALITY' ? '（窄条难例可能超过 1 分钟）' : ''}…`);
        else if (run.status === 'failed') parts.push(`${method.name}：失败，${run.message}`);
        else if (run.status === 'done') parts.push(`${method.name}：${saved > 0 ? `比逐单独立分切少用 ${saved} 卷母卷` : saved === 0 ? '与逐单独立分切用卷相同' : `比逐单独立分切多用 ${-saved} 卷母卷`}`);
    }
    $('compare-status').textContent = parts.join('；') || '正在计算…';
}

function renderPatterns() {
    $('view-switch').innerHTML = METHODS.map(method => `<button type="button" class="tool-btn" data-view="${method.id}" aria-pressed="${state.view === method.id}"${state.runs[method.id].status === 'done' ? '' : ' disabled'}>${method.name}</button>`).join('');
    const run = state.runs[state.view], {input, lengthUnit} = state.scenario;
    if (run.status !== 'done') { $('pattern-list').innerHTML = '<p class="note">计算完成后显示分切组合。</p>'; return; }
    const segment = (width, kind, text) => width > 0 ? `<span class="${kind}" style="width:${width / input.motherWidth * 100}%" title="${esc(text)}">${width / input.motherWidth > .055 ? width : ''}</span>` : '';
    $('pattern-list').innerHTML = run.plan.map((row, index) => {
        const l = layout(row, input);
        return `<article class="pattern-card"><header><strong>组合 ${index + 1}</strong><span>${row.length} ${lengthUnit} · ${esc(row.surfaceTreatment)} · 重复 ${row.usageCount} 卷</span></header>`
            + `<div class="strip" role="img" aria-label="左切边 ${input.leftTrim} mm，成品 ${l.widths.join('、')} mm，余边 ${l.remaining} mm，右切边 ${input.rightTrim} mm">`
            + `${segment(input.leftTrim, 'trim', `左固定切边 ${input.leftTrim} mm`)}${l.widths.map((w, i) => segment(w, i % 2 ? 'product alt' : 'product', `成品 ${w} mm`)).join('')}`
            + `${segment(l.remaining, 'remaining', `可切区余边 ${l.remaining} mm`)}${segment(input.rightTrim, 'trim', `右固定切边 ${input.rightTrim} mm`)}</div>`
            + `<p>成品 <b>${l.product}</b> / 可切区 <b>${l.available}</b> mm · 余边 <b>${l.remaining}</b> mm</p></article>`;
    }).join('');
}

function renderHandoff() {
    const movable = state.scenario.lengthUnit === 'm';
    $('handoff').disabled = !movable;
    $('handoff-note').textContent = movable ? '把这批订单和工艺参数带进分切工作台：可以修改后重新计算、勾选组合重切并导出 Excel。'
        : '该示例的卷长按 mm 记（整板 2440 mm），而分切工作台的卷长单位是 m，所以这里不提供一键带入。';
}

function render() {
    renderScenarios(); renderTable(); renderStatus(); renderPatterns(); renderHandoff();
}

document.addEventListener('click', event => {
    const target = event.target.closest('[data-scenario], [data-run], [data-view]');
    if (!target) return;
    if (target.dataset.scenario) select(target.dataset.scenario);
    else if (target.dataset.run) solve(target.dataset.run);
    else { state.view = target.dataset.view; renderPatterns(); }
});

$('handoff').onclick = () => {
    try {
        const existing = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        if (existing?.orderItems?.length && !confirm('分切工作台在本标签页保留了一份需求，打开示例会替换它。继续吗？')) return;
        sessionStorage.setItem(draftKey, JSON.stringify({...state.scenario.input, profile: 'FAST', draftDirty: false}));
        sessionStorage.removeItem(taskKey);
        location.href = '/linear.html';
    } catch {
        $('compare-status').textContent = '浏览器不允许保存草稿，无法带入分切工作台。';
    }
};

setInterval(() => { if (running()) { renderTable(); renderStatus(); } }, 500);
select(new URLSearchParams(location.search).get('scenario'));
