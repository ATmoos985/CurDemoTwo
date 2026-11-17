export function setStatus(html) {
    const el = document.getElementById('statusbar');
    if (el) el.innerHTML = html;
}

export function parseRoute(hash) {
    const [rawPath = '', query = ''] = String(hash || '').replace(/^#\/?/, '').split('?');
    const [page = 'workbench', ...rest] = rawPath.split('/').filter(Boolean);
    const params = rest.map(decodeURIComponent);
    const intent = new URLSearchParams(query).get('intent');
    if (intent && params.length < 3) {
        while (params.length < 2) params.push('');
        params.push(intent);
    }
    return {page, params};
}

import '../dist/react-app.js';
