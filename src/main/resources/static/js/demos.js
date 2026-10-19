const params = new URLSearchParams(location.search);
const pages = {sheet:'/nesting.html', marker:'/marker-demo.html', linear:'/linear-demo.html'};
const names = {sheet:'二维裁切场景演示', marker:'服装唛架演示', linear:'一维搭切对比'};
function activate(key, focus = false) {
    if (!Object.hasOwn(pages, key)) key = 'sheet';
    for (const button of document.querySelectorAll('[data-demo]')) {
        const selected = button.dataset.demo === key;
        button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
        document.getElementById(`panel-${button.dataset.demo}`).hidden = !selected;
        if (selected && focus) button.focus();
    }
    const panel = document.getElementById(`panel-${key}`);
    const url = new URL(pages[key], location.origin);
    if (params.get('scenario')) url.searchParams.set('scenario', params.get('scenario'));
    document.getElementById('demo-standalone').href = url.href;
    if (!panel.firstChild) {
        const frame = document.createElement('iframe'); frame.title = names[key];
        if (key !== 'sheet') frame.addEventListener('load', () => {
            const body = frame.contentDocument?.body;
            if (!body) return;
            const resize = () => { if (!panel.hidden) frame.style.height = `${Math.ceil(body.getBoundingClientRect().height) + 2}px`; };
            const observer = new ResizeObserver(resize); observer.observe(body); resize();
            frame.contentWindow.addEventListener('pagehide', () => observer.disconnect(), {once:true});
        });
        url.searchParams.set('embed', '1'); frame.src = url.href; panel.append(frame);
    }
    // Keep mounted frames: pending solves, input and results belong to each demo.
    history.replaceState(null, '', `${location.pathname}${location.search}#${key}`);
}
document.querySelector('.demo-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-demo]'); if (button) activate(button.dataset.demo);
});
document.querySelector('.demo-tabs').addEventListener('keydown', event => {
    const keys = Object.keys(pages), index = keys.indexOf(event.target.dataset.demo);
    const next = {ArrowRight:(index + 1) % keys.length, ArrowLeft:(index + keys.length - 1) % keys.length, Home:0, End:keys.length - 1}[event.key];
    if (next !== undefined) { event.preventDefault(); activate(keys[next], true); }
});
window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
activate(location.hash.slice(1));
