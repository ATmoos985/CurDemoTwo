// 应用外壳：导航、路由、状态栏。页面模块各自负责数据读取与渲染。
import {esc, requestJSON} from './util.js';

const NAV_MAIN = [
    ['生产闭环', [
        ['tasks', '任务'],
        ['workbench', '排料工作台'],
        ['execution', '执行与报工', 'sub'],
        ['quality', '复检处置', 'sub']
    ]],
    ['工艺试算', [
        ['garment', '唛架幅宽试算']
    ]],
    ['材料与台账', [
        ['inventory', '库存'],
        ['inspection', '跑布验疵'],
        ['documents', '库存单据', 'sub'],
        ['analysis', '生产分析', 'sub']
    ]]
];
const NAV_FOOT = [
    ['沙盒与配置', [
        ['showcase', '能力展示', 'sandbox'],
        ['settings', '设置']
    ]]
];
const PAGES = {
    tasks: () => import('./pages/tasks.js'),
    task: () => import('./pages/task-edit.js'),
    workbench: () => import('./pages/workbench.js'),
    garment: () => import('./pages/garment.js'),
    execution: () => import('./pages/execution.js'),
    inventory: () => import('./pages/inventory.js'),
    inspection: () => import('./pages/inspection.js'),
    documents: () => import('./pages/documents.js'),
    quality: () => import('./pages/quality.js'),
    analysis: () => import('./pages/analysis.js'),
    showcase: () => import('./pages/showcase.js'),
    settings: () => import('./pages/settings.js')
};

let cleanup = null, token = 0;

export function parseRoute(hash) {
    const [rawPath = '', query = ''] = String(hash || '').replace(/^#\/?/, '').split('?');
    const [page = 'tasks', ...rest] = rawPath.split('/').filter(Boolean);
    const params = rest.map(decodeURIComponent);
    const intent = new URLSearchParams(query).get('intent');
    if (intent && params.length < 3) {
        while (params.length < 2) params.push('');
        params.push(intent);
    }
    return {page: PAGES[page] ? page : 'tasks', params};
}

export function setStatus(html) { document.getElementById('statusbar').innerHTML = html; }

function renderGroup([h, items], active) {
    return `<h6>${esc(h)}</h6>` + items.map(([k, t, kind]) =>
        `<a href="#/${k}" class="${k === active ? 'on' : ''}${kind === 'sub' ? ' nav-sub' : ''}" ${k === active ? 'aria-current="page"' : ''}><span>${esc(t)}</span>${kind === 'sandbox' ? '<span class="cnt">沙盒</span>' : ''}</a>`
    ).join('');
}

function renderNav(active) {
    if (active === 'task') active = 'tasks';
    document.getElementById('nav').innerHTML =
        `<div class="nav-main">${NAV_MAIN.map(g => renderGroup(g, active)).join('')}</div>` +
        `<div class="nav-foot">${NAV_FOOT.map(g => renderGroup(g, active)).join('')}</div>`;
}

async function route() {
    const {page, params} = parseRoute(location.hash), my = ++token;
    renderNav(page);
    if (cleanup) { try { cleanup(); } catch { /* 页面清理失败不影响切换 */ } cleanup = null; }
    const main = document.getElementById('main');
    main.innerHTML = '<div class="loading">加载中…</div>';
    setStatus('<span class="sp"></span><span>CutPlan v2 · 第一版</span>');
    const mod = await PAGES[page]();
    if (my !== token) return;
    // 每次路由拥有自己的宿主。迟到的 mount 只能写入已脱离页面的节点，不能覆盖当前页面。
    const host = document.createElement('div'); host.className = 'main page-host';
    main.replaceChildren(host);
    const dispose = await mod.mount(host, params) || null;
    if (my !== token) { dispose?.(); return; }
    cleanup = dispose;
}

// 只显示服务是否可用，不对外暴露求解引擎与计算能力细节。
async function engineStatus() {
    const el = document.getElementById('engine-status');
    try {
        const ok = (await requestJSON('/api/health')).status === 'UP';
        el.innerHTML = `<span class="dot ${ok ? 'ok' : 'warn'}"></span>服务 <b>${ok ? '正常' : '异常'}</b>`;
    } catch {
        el.innerHTML = '<span class="dot warn"></span>服务 <b>未连接</b>';
    }
}

window.addEventListener('hashchange', route);
if (!location.hash) location.hash = '#/tasks'; else route();
engineStatus();
