// 应用外壳：导航、路由、状态栏。页面模块各自负责数据读取与渲染。
import {esc, requestJSON} from './util.js';

const NAV = [
    ['生产', [['tasks', '任务'], ['workbench', '排料工作台'], ['execution', '执行与报工']]],
    ['材料', [['inventory', '库存'], ['inspection', '跑布验疵'], ['documents', '库存单据']]],
    ['质量与分析', [['quality', '复检处置'], ['analysis', '生产分析']]],
    ['系统', [['showcase', '能力展示'], ['settings', '设置']]]
];
const PAGES = {
    tasks: () => import('./pages/tasks.js'),
    task: () => import('./pages/task-edit.js'),
    workbench: () => import('./pages/workbench.js'),
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
    const [page = 'tasks', ...rest] = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    return {page: PAGES[page] ? page : 'tasks', params: rest.map(decodeURIComponent)};
}

export function setStatus(html) { document.getElementById('statusbar').innerHTML = html; }

function renderNav(active) {
    if (active === 'task') active = 'tasks';
    document.getElementById('nav').innerHTML = NAV.map(([h, items]) => `<h6>${esc(h)}</h6>` +
        items.map(([k, t]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${esc(t)}</a>`).join('')).join('');
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
    cleanup = await mod.mount(main, params) || null;
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
