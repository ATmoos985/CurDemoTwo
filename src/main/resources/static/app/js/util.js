// 宿主层公共工具：请求、转义、格式化、提示、偏好。
export {requestJSON, ApiError} from '../../js/core/api-request.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const fmtM = (mm, d = 1) => (Number(mm) / 1000).toLocaleString('zh-CN', {maximumFractionDigits: d});
/** 千分位 + 小数位；舍入后为 0 的负数显示为 0，不出现 “-0”。 */
export const fmtN = (n, d = 0) => {
    const v = Number(Number(n ?? 0).toFixed(d));
    return (v === 0 ? 0 : v).toLocaleString('zh-CN', {maximumFractionDigits: d});
};
export const fmtTime = t => {
    if (!t) return '—';
    const d = new Date(typeof t === 'number' ? t : String(t).replace(' ', 'T'));
    return isNaN(d) ? String(t) : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const shortId = id => String(id ?? '').slice(0, 8);

let toastTimer = 0;
export function toast(message, error = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message; el.className = 'toast' + (error ? ' err' : ''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3000);
}

export function errorBox(error) {
    return `<div class="error-box">读取失败：${esc(error?.message || error)}。数据未改动，可刷新重试。</div>`;
}

/** 求解参数：与经典工作台共用同一组本机设置（回收最小宽 / 长、求解时限）。 */
export function solverSettings() {
    return {minRemnantWidth: Number(localStorage.getItem('cam_min_rem_w') ?? 200),
        minRemnantLength: Number(localStorage.getItem('cam_min_rem_l') ?? 300),
        timeLimitSeconds: Number(localStorage.getItem('cam_timeout') ?? 3)};
}

const PREF_KEY = 'cutplan.app.prefs';
export const DEFAULT_PREFS = {vertical: true, fullMode: 'strip', view: 'station', mmPerPx: 25.4 / 96};
export function loadPrefs() {
    try { return {...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}')}; } catch { return {...DEFAULT_PREFS}; }
}
export function savePrefs(p) { localStorage.setItem(PREF_KEY, JSON.stringify(p)); }

/** 点击外部或 Esc 关闭弹窗；返回解除函数。 */
export function dismissOnOutside(el, close) {
    const click = e => { if (!el.contains(e.target)) close(); };
    const key = e => { if (e.key === 'Escape') close(); };
    setTimeout(() => document.addEventListener('mousedown', click));
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
}
