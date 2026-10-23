import {inWorkspace,workspaceReady} from './workspace/page-bridge.js';
import {navGroups} from './product-entries.js';

if(document.body.matches('.management-page,.inventory-page')) {
    try {document.documentElement.dataset.theme=localStorage.getItem('cam_theme')==='dark'?'dark':'light';} catch { /* Display remains usable without storage. */ }
}

const embedded = window.self !== window.top && new URLSearchParams(location.search).get('embed') === '1';
document.documentElement.classList.toggle('demo-embedded', embedded);
for (const host of document.querySelectorAll('[data-product-nav]')) {
    const original = host.dataset.productNav;
    const active = ({workbench:'tasks',linear:'tasks',inspection:'inventory',transfers:'inventory'})[original] || original;
    const hub = ['intro', 'demos', 'tasks', 'analysis', 'settings'].includes(original);
    host.innerHTML = `<nav class="product-nav" aria-label="功能区域">${navGroups(active).flatMap(g => g.items).map(item =>
        `<a href="${item.href}" ${item.id === active ? 'aria-current="'+(original===active?'page':'location')+'"' : ''} ${hub || original===item.id ? '' : 'target="_blank" rel="noopener" title="新页面打开，保留当前内容"'}>${item.name}</a>`).join('')}</nav><a class="product-help" href="/intro.html" ${hub?'':'target="_blank" rel="noopener"'}>演示与帮助</a>`;
    if (original === active) host.querySelector('[aria-current]')?.addEventListener('click', event => event.preventDefault());
}
if (location.hash === '#protocol-details') {
    const section = document.getElementById('protocol-details');
    if (section) { section.open = true; section.scrollIntoView({block:'nearest'}); }
}

// Input-heavy applications announce readiness after their own initialization.
if(inWorkspace && !['/index.html','/inspection.html','/linear.html'].includes(location.pathname))workspaceReady();
if(!inWorkspace && window.self===window.top){
    const host=document.querySelector('[data-product-nav]');
    if(host){const link=document.createElement('a');link.className='product-help';link.textContent='多页签工作台';
        link.href='/workspace.html#'+encodeURIComponent(location.pathname+location.search+location.hash);
        link.target='_blank';link.rel='noopener';link.title='进入左侧导航与右侧页签工作区';host.append(link);}
}
