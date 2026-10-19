import {navGroups} from './product-entries.js';

const embedded = window.self !== window.top && new URLSearchParams(location.search).get('embed') === '1';
document.documentElement.classList.toggle('demo-embedded', embedded);
for (const host of document.querySelectorAll('[data-product-nav]')) {
    const original = host.dataset.productNav;
    const active = ['lab', 'compare', 'marker'].includes(original) ? 'demos' : original;
    const hub = ['intro', 'demos'].includes(original);
    host.innerHTML = `<nav class="product-nav" aria-label="功能区域">${navGroups(active).flatMap(g => g.items).map(item =>
        `<a href="${item.href}" ${item.id === active ? 'aria-current="page"' : hub ? '' : 'target="_blank" rel="noopener" title="新页面打开，保留当前内容"'}>${item.name}</a>`).join('')}</nav>`;
    if (original === active || original === 'workbench') host.querySelector('[aria-current]')?.addEventListener('click', event => event.preventDefault());
}
if (location.hash === '#protocol-details') {
    const section = document.getElementById('protocol-details');
    if (section) { section.open = true; section.scrollIntoView({block:'nearest'}); }
}
