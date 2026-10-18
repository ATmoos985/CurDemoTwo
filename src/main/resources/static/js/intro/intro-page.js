import {STATUS, PRESET_FIELDS, INDUSTRIES, CAPABILITIES, presets, describePreset} from '../industry/industry-profiles.js';
import {escapeHtml as esc} from '../linear/linear-model.js';
import './cutting-showcase.js';

const $ = id => document.getElementById(id);
const HINTS = {ready: '生产流程可用', demo: '可预览或属近似实现，不直接用于生产', none: '当前版本没有'};
const chip = status => `<span class="status-chip status-${status}">${STATUS[status]}</span>`;
const labHref = key => `/nesting.html?scenario=${encodeURIComponent(key)}`;
const compareHref = key => `/linear-demo.html?scenario=${encodeURIComponent(key)}`;
const sceneHref = (item, key) => item.dimension === '一维' ? compareHref(key) : labHref(key);
const count = dimension => INDUSTRIES.filter(i => i.dimension === dimension).reduce((n, i) => n + i.scenarios.length, 0);

$('intro-stats').textContent = `${INDUSTRIES.length} 个行业场景 · ${count('二维')} 个二维示例 · ${count('一维')} 个一维算例`;
$('status-legend').innerHTML = Object.keys(STATUS).map(key => `<span>${chip(key)}<small>${HINTS[key]}</small></span>`).join('');

const capabilityCard = c => `<article class="capability-card"><header><h4>${esc(c.name)}</h4>${chip(c.status)}</header><p>${esc(c.text)}</p>
    <footer>${c.engines.length ? `<span class="engine-tags" data-engines="${c.engines.join(' ')}"></span>` : '<span></span>'}<a href="${c.demo ? labHref(c.demo) : c.link}">${c.demo ? '在场景演示中试一试' : '打开页面'} →</a></footer></article>`;
$('capability-columns').innerHTML = [['二维', '二维切割'], ['一维', '一维分切']].map(([dimension, title]) =>
    `<div class="capability-column"><h3>${title}</h3>${CAPABILITIES.filter(c => c.dimension === dimension).map(capabilityCard).join('')}</div>`).join('');

fetch('/api/v1/nesting/engines', {cache: 'no-store'}).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(list => {
    const byId = new Map(list.map(engine => [engine.id, engine]));
    $('engine-line').textContent = `服务器引擎：${list.map(e => `${e.id} ${e.available ? '可用' : '未就绪'}`).join(' · ')}`;
    for (const node of document.querySelectorAll('.engine-tags')) node.innerHTML = node.dataset.engines.split(' ').map(id => {
        const engine = byId.get(id), ok = engine?.available;
        return `<span class="engine-tag ${ok ? 'ok' : 'off'}">${esc(id)} ${engine ? (ok ? '可用' : '未就绪') : '未登记'}</span>`;
    }).join('');
}).catch(() => { $('engine-line').textContent = '暂时无法读取引擎状态，刷新页面可重试。'; });

// 行业页签：键盘左右 / Home / End 切换，地址栏 #industry-<id> 可直达某个行业。
let current = (INDUSTRIES.find(i => location.hash === `#industry-${i.id}`) ?? INDUSTRIES[0]).id;
const presetBlock = item => item.dimension === '一维'
    ? '<p class="note">一维使用独立的分切工作台，母卷、订单与组合宽度在页面内填写。</p>'
    : item.presets.map(preset => `<div class="preset-card"><strong>${esc(preset.name)}</strong><dl>${describePreset(preset.values).map(d => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.text)}</dd></div>`).join('')}</dl></div>`).join('');
function renderIndustries() {
    $('industry-tabs').innerHTML = INDUSTRIES.map(i => `<button type="button" role="tab" id="tab-${i.id}" aria-controls="industry-panel" aria-selected="${i.id === current}" tabindex="${i.id === current ? 0 : -1}" data-industry="${i.id}">${esc(i.name)}<small>${i.dimension}</small></button>`).join('');
    const item = INDUSTRIES.find(i => i.id === current);
    $('industry-panel').setAttribute('aria-labelledby', `tab-${item.id}`);
    $('industry-panel').innerHTML = `<p class="panel-lead">${esc(item.lead)}</p><ul class="chip-list">${item.cuts.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
        <div class="industry-grid"><div class="table-wrap"><table class="rule-table"><thead><tr><th>规则</th><th>取值 / 说明</th><th>状态</th><th>在哪里配置</th></tr></thead><tbody>
        ${item.rules.map(r => `<tr><th>${esc(r.name)}</th><td>${esc(r.value) || '—'}</td><td>${chip(r.status)}</td><td>${esc(r.where) || '—'}</td></tr>`).join('')}</tbody></table></div>
        <aside class="industry-side"><h4>可运行的示例</h4><ul class="demo-list">${item.scenarios.map(s => `<li><a href="${sceneHref(item, s.key)}">${esc(s.name)}</a><span>${esc(s.note)}</span></li>`).join('')}</ul>
        <h4>通用操作台预设</h4>${presetBlock(item)}</aside></div>`;
}
function selectIndustry(id, focus) {
    current = id; renderIndustries(); history.replaceState(null, '', `#industry-${id}`);
    if (focus) $(`tab-${id}`).focus();
}
$('industry-tabs').addEventListener('click', event => { const tab = event.target.closest('[data-industry]'); if (tab) selectIndustry(tab.dataset.industry, false); });
$('industry-tabs').addEventListener('keydown', event => {
    const ids = INDUSTRIES.map(i => i.id), at = ids.indexOf(current);
    const next = {ArrowRight: (at + 1) % ids.length, ArrowLeft: (at + ids.length - 1) % ids.length, Home: 0, End: ids.length - 1}[event.key];
    if (next !== undefined) { event.preventDefault(); selectIndustry(ids[next], true); }
});
renderIndustries();
function revealSection() {
    const section = location.hash.startsWith('#industry-') ? $('industries') : document.getElementById(location.hash.slice(1));
    if (section?.matches('details.intro-section')) { section.open = true; section.scrollIntoView(); }
}
revealSection();
window.addEventListener('hashchange', revealSection);

$('preset-table').innerHTML = `<thead><tr><th>预设</th>${PRESET_FIELDS.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead><tbody>
    ${presets().map(p => `<tr><th>${esc(p.name)}</th>${describePreset(p.values).map(d => `<td>${esc(d.text)}</td>`).join('')}</tr>`).join('')}</tbody>`;

$('demo-groups').innerHTML = INDUSTRIES.map(item => `<div class="demo-group"><h3>${esc(item.name)}<small>${item.dimension}</small></h3><div class="demo-cards">
    ${item.scenarios.map(s => `<a class="demo-card" href="${sceneHref(item, s.key)}"><strong>${esc(s.name)}</strong><span>${esc(s.note)}</span></a>`).join('')}</div></div>`).join('')
    + '<div class="demo-group"><h3>自定义<small>二维</small></h3><div class="demo-cards"><a class="demo-card" href="/nesting.html#protocol-details"><strong>标准输入 / 输出</strong><span>在场景演示中编辑完整输入 JSON，并导出输入与结果</span></a></div></div>';
