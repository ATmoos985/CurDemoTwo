// 宿主层公共工具：API 请求、UUID、数值/时间格式化、轻提示、幂等写入队列与 SheetJS 按需加载。
export {requestJSON, ApiError} from './api-request.js';
import {createUuid} from './uuid.js';
export {createUuid};

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

/**
 * 幂等写入：先落盘（含 Idempotency-Key）再发送；成功或确定被拒（400/401/403/409/422）后清除，
 * 网络中断等结果未知时保留，页面可用 pendingWrite + retryWrite 原样重发，避免重复记账。
 */
export async function idempotentPost(slot, url, body) {
    const key = 'cutplan.app.pending.' + slot;
    const old = JSON.parse(localStorage.getItem(key) || 'null');
    if (old && JSON.stringify(old.body) !== JSON.stringify(body)) throw new Error('上次提交结果尚未确认，请先重试原操作或放弃后再提交新内容');
    const intent = old || {url, body, idempotencyKey: createUuid()};
    localStorage.setItem(key, JSON.stringify(intent));
    return sendIntent(key, intent);
}
export const pendingWrite = slot => JSON.parse(localStorage.getItem('cutplan.app.pending.' + slot) || 'null');
export function retryWrite(slot) { const key = 'cutplan.app.pending.' + slot, intent = JSON.parse(localStorage.getItem(key) || 'null'); return intent ? sendIntent(key, intent) : Promise.resolve(null); }
export function dropWrite(slot) { localStorage.removeItem('cutplan.app.pending.' + slot); }
async function sendIntent(key, intent) {
    const {requestJSON: send} = await import('./api-request.js');
    try {
        const result = await send(intent.url, intent.body, {'Idempotency-Key': intent.idempotencyKey});
        localStorage.removeItem(key); return result;
    } catch (e) {
        if ([400, 401, 403, 409, 422].includes(e.httpStatus)) localStorage.removeItem(key);
        throw e;
    }
}

/** 按需加载本地 SheetJS（Excel 读写），失败可重试。 */
let sheetLib;
export function loadSheetLib() {
    sheetLib ||= import('../../vendor/sheetjs/xlsx.mini.min.js')
        .then(mod => {
            const lib = [mod, mod?.default, globalThis.XLSX].find(x => x && typeof x.read === 'function' && x.utils && typeof x.writeFile === 'function');
            if (!lib) throw new Error('表格组件加载失败，请重试');
            try {
                if (typeof globalThis !== 'undefined') globalThis.XLSX = lib;
            } catch { /* ignore readonly global */ }
            return lib;
        })
        .catch(() => {
            sheetLib = null;
            throw new Error('表格组件加载失败，请重试');
        });
    return sheetLib;
}
