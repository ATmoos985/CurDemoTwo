// 旧收藏地址继续可用；默认进入新版演示。classic=1 仅供历史页面兼容验收。
export function showcaseTarget(href) {
    const url = new URL(href);
    if (url.searchParams.get('classic') === '1') return null;
    const scenario = url.searchParams.get('scenario');
    let id = scenario || '';
    if (url.pathname === '/marker-demo.html' || url.pathname === '/demos.html' && url.hash === '#marker')
        id = 'marker-' + (url.searchParams.get('style') || 'GARMENT_SHIRT');
    else if (url.pathname === '/linear-demo.html' || url.pathname === '/demos.html' && url.hash === '#linear') id = scenario || 'film';
    else if (url.pathname === '/cloth_cad_nesting.html') id = scenario || 'GUILLOTINE';
    else if (url.pathname !== '/nesting.html' && url.pathname !== '/demos.html') return null;
    return '/app/#/showcase' + (id ? '/' + encodeURIComponent(id) : '');
}
if (typeof window !== 'undefined') {
    const target = showcaseTarget(window.location.href);
    if (target) window.location.replace(target);
}
